'use strict';

// ═══════════════════════════════════════════════════════════════════
// routes/onlyoffice.js — ONLYOFFICE Document Server integration
// Этап 1 миграции: см. ONLYOFFICE_MIGRATION.md
//
// Маршруты:
//   POST /api/files/upload              — загрузка DOCX от клиента
//   GET  /api/files/:fileId/download    — отдача DOCX в DocServer
//   GET  /api/files/:fileId/config      — JWT-конфиг для инициализации редактора
//   POST /api/onlyoffice/callback/:fileId — callbackUrl от DocServer
// ═══════════════════════════════════════════════════════════════════

const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const fsP     = require('fs/promises');
const path    = require('path');
const crypto  = require('crypto');
const multer  = require('multer');
const { buildAnnotatedSummary } = require('../lib/docxGenerator');

// mammoth: извлечение plain-text из DOCX (не бросаем если не установлен)
let mammoth;
try { mammoth = require('mammoth'); } catch(_) { console.warn('[OnlyOffice] mammoth не найден — текстовый кеш отключён'); }

// ── Конфиг ──────────────────────────────────────────────────────────
const STORAGE_DIR  = path.join(__dirname, '..', 'storage', 'documents');
const PLUGIN_DIR   = path.join(__dirname, '..', 'onlyoffice-plugin', 'miyzamchi-ai');
const OO_JWT_SECRET = process.env.ONLYOFFICE_JWT_SECRET || '';
const OO_URL        = process.env.ONLYOFFICE_URL        || 'http://localhost:8080';
const BACKEND_URL   = process.env.BACKEND_URL           || 'https://miyzamchi-backend.onrender.com';
// URL, доступный из браузера (не из Docker). В локальной разработке
// BACKEND_URL = host.docker.internal:3000 (для DocServer), а браузер видит localhost:3000.
const BROWSER_URL   = BACKEND_URL.includes('host.docker.internal')
    ? 'http://localhost:3000'
    : BACKEND_URL;
// GUID плагина (должен совпадать с config.json)
const PLUGIN_GUID   = 'asc.{f3a4b2c1-8e7d-4f6a-9b3c-2d1e5f8a7b4c}';

// В памяти: fileId → { documentKey, filename, uploadedAt }
const fileRegistry = new Map();

// Кеш extracted-текста: fileId → plainText (для ИИ-анализа)
const fileTextCache = new Map();

// Кеш выделенного текста плагина: fileId → { text, ts }
const _selectionStore = new Map();

// Гарантируем существование директории хранилища
fsP.mkdir(STORAGE_DIR, { recursive: true }).catch(() => {});

// ── CORS для ONLYOFFICE-плагина (iframe origin: localhost:8080) ─────
// server.js разрешает :5173/:5174/:5175, но не :8080 (плагин).
// Добавляем здесь на уровне роутера, не трогая глобальный CORS.
router.use(function ooPluginCors(req, res, next) {
    const origin = req.headers.origin || '';
    if (/localhost:8080|127\.0\.0\.1:8080/.test(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// ── Раздача файлов плагина (для autostart через pluginsData) ────────
// config.json и index.html — динамические (абсолютные URL + инжект SDK).
// plugin.js, icon.png, icon@2x.png — статические.

// config.json: абсолютный url нужен для ONLYOFFICE 9.x (относительный не резолвится)
router.get('/onlyoffice/plugin/config.json', (req, res) => {
    const pluginBase = `${BROWSER_URL}/api/onlyoffice/plugin`;
    res.json({
        name: 'Мыйзамчы AI',
        nameLocale: { ru: 'Мыйзамчы AI', en: 'Miyzamchy AI' },
        guid: PLUGIN_GUID,
        version: '1.0.0',
        variations: [{
            description: 'Юридический AI-ассистент для КР',
            descriptionLocale: { ru: 'Юридический AI-ассистент для КР', en: 'Legal AI assistant for Kyrgyz Republic' },
            url: `${pluginBase}/index.html`,
            icons: [`${pluginBase}/icon.png`, `${pluginBase}/icon@2x.png`],
            icons2: [{ '100%': { normal: `${pluginBase}/icon.png` }, '200%': { normal: `${pluginBase}/icon@2x.png` } }],
            isViewer: false,
            EditorsSupport: ['word'],
            isVisual: true,
            isModal: false,
            isInsideMode: true,
            initDataType: 'text',
            initData: '',
            isUpdateOleOnResize: false,
            buttons: [],
            events: ['onExternalMouseUp'],
            initOnSelectionChanged: true
        }]
    });
});

// index.html: инжектируем ONLYOFFICE Plugin SDK до plugin.js.
// SDK размещён на публичном CDN GitHub Pages — не зависит от DocServer.
// Официальный источник: github.com/ONLYOFFICE/sdkjs-plugins (v1/plugins.js + plugins-ui.js).
// ВАЖНО: переопределяем CSP от Helmet:
//   - frame-ancestors * → ONLYOFFICE (localhost:8080) может встраивать наш iframe
//   - script-src * → iframe может грузить SDK с CDN
router.get('/onlyoffice/plugin/index.html', (req, res) => {
    const htmlPath = path.join(PLUGIN_DIR, 'index.html');
    try {
        let html = fs.readFileSync(htmlPath, 'utf8');
        const sdkTag    = `<script src="https://onlyoffice.github.io/sdkjs-plugins/v1/plugins.js"></script>`;
        const sdkUiTag  = `<script src="https://onlyoffice.github.io/sdkjs-plugins/v1/plugins-ui.js"></script>`;
        const pluginTag = `<script src="${BROWSER_URL}/api/onlyoffice/plugin/plugin.js"></script>`;
        html = html.replace('<script src="plugin.js"></script>', sdkTag + '\n' + sdkUiTag + '\n' + pluginTag);
        // Перезаписываем CSP Helmet'а (вызывается ПОСЛЕ helmet middleware)
        // frame-ancestors * → ONLYOFFICE (localhost:8080) может встраивать этот iframe
        // X-Frame-Options удаляем — он имеет приоритет над frame-ancestors в старых браузерах
        res.setHeader('Content-Security-Policy', "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; frame-ancestors *;");
        res.removeHeader('X-Frame-Options');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    } catch (err) {
        res.status(500).send('Plugin index.html error: ' + err.message);
    }
});

// Статические файлы плагина
const PLUGIN_STATIC = new Set(['plugin.js', 'icon.png', 'icon@2x.png']);
router.get('/onlyoffice/plugin/:file', (req, res) => {
    const file = req.params.file;
    if (!PLUGIN_STATIC.has(file)) return res.status(404).send('Not found');
    const filePath = path.join(PLUGIN_DIR, file);
    if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
    res.sendFile(filePath);
});

// ── Multer: только DOCX, до 50 МБ ──────────────────────────────────
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, STORAGE_DIR),
        filename: (req, file, cb) => {
            const fileId = crypto.randomBytes(12).toString('hex');
            req._generatedFileId = fileId;
            cb(null, `${fileId}.docx`);
        }
    }),
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ok = file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            || file.originalname.endsWith('.docx');
        cb(ok ? null : new Error('Только .docx файлы'), ok);
    }
});

// ── Вспомогательные JWT-функции (без внешних зависимостей) ──────────
function b64url(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signOoJWT(payload) {
    if (!OO_JWT_SECRET) throw new Error('ONLYOFFICE_JWT_SECRET не задан');
    const header  = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
    const body    = b64url(Buffer.from(JSON.stringify(payload)));
    const sig     = b64url(crypto.createHmac('sha256', OO_JWT_SECRET).update(`${header}.${body}`).digest());
    return `${header}.${body}.${sig}`;
}

function verifyOoJWT(token) {
    if (!OO_JWT_SECRET) return null;
    const parts = (token || '').replace(/^Bearer\s+/i, '').split('.');
    if (parts.length !== 3) throw new Error('Неверный формат JWT');
    const expected = b64url(
        crypto.createHmac('sha256', OO_JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest()
    );
    if (!crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(expected))) {
        throw new Error('Неверная подпись JWT');
    }
    return JSON.parse(Buffer.from(parts[1], 'base64').toString());
}

// ── POST /api/files/upload ──────────────────────────────────────────
// Клиент загружает .docx → сохраняем на диск → возвращаем {fileId, config}
router.post('/files/upload', upload.single('file'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Файл не получен' });

        const fileId      = req._generatedFileId || path.basename(req.file.filename, '.docx');
        const documentKey = `${fileId}_${Date.now()}`;
        const filename    = req.file.originalname || 'document.docx';

        fileRegistry.set(fileId, { documentKey, filename, uploadedAt: Date.now() });

        // Фоновое извлечение текста для ИИ-контекста
        if (mammoth && req.file.path) {
            mammoth.extractRawText({ path: req.file.path })
                .then(result => { fileTextCache.set(fileId, result.value || ''); })
                .catch(() => {});
        }

        const config = buildEditorConfig(fileId, documentKey, filename);
        console.log(`[OnlyOffice] upload: fileId=${fileId} | ${filename} | ${req.file.size} bytes`);
        res.json({ fileId, documentKey, filename, config });
    } catch (err) {
        console.error('[OnlyOffice] upload error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── GET /api/files/:fileId/download ────────────────────────────────
// DocServer звонит сюда чтобы скачать исходный файл при открытии
router.get('/files/:fileId/download', (req, res) => {
    const filePath = path.join(STORAGE_DIR, `${req.params.fileId}.docx`);
    if (!fs.existsSync(filePath)) {
        console.warn(`[OnlyOffice] download: not found fileId=${req.params.fileId}`);
        return res.status(404).json({ error: 'Файл не найден' });
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.fileId}.docx"`);
    fs.createReadStream(filePath).pipe(res);
});

// ── GET /api/files/:fileId/text ────────────────────────────────────
// Возвращает plain-text из DOCX для ИИ-анализа.
// App.jsx вызывает после upload → хранит в window.__ooDocText.
router.get('/files/:fileId/text', async (req, res) => {
    const { fileId } = req.params;
    const cached = fileTextCache.get(fileId);
    if (cached !== undefined) return res.json({ text: cached });

    const filePath = path.join(STORAGE_DIR, `${fileId}.docx`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Файл не найден', text: '' });
    if (!mammoth) return res.json({ text: '' });

    try {
        const result = await mammoth.extractRawText({ path: filePath });
        const text = result.value || '';
        fileTextCache.set(fileId, text);
        res.json({ text });
    } catch (err) {
        res.json({ text: '', error: err.message });
    }
});

// ── GET /api/files/:fileId/config ──────────────────────────────────
// Фронтенд запрашивает подписанный конфиг для инициализации DocsAPI.DocEditor
router.get('/files/:fileId/config', (req, res) => {
    const { fileId } = req.params;
    const entry = fileRegistry.get(fileId);

    const documentKey = entry?.documentKey || `${fileId}_${Date.now()}`;
    const filename    = entry?.filename    || 'document.docx';

    const config = buildEditorConfig(fileId, documentKey, filename);
    res.json(config);
});

// ── POST /api/onlyoffice/callback/:fileId ──────────────────────────
// DocServer шлёт сюда событие при сохранении документа.
// КРИТИЧНО: ответить { error: 0 } до истечения ~5 секунд.
router.post('/onlyoffice/callback/:fileId', async (req, res) => {
    const { fileId } = req.params;

    // 1. JWT-верификация (если JWT включён)
    if (OO_JWT_SECRET) {
        const token = req.headers['authorization'] || req.body?.token;
        if (!token) {
            console.warn(`[OnlyOffice] callback: нет JWT, fileId=${fileId}`);
            return res.status(401).json({ error: 1 });
        }
        try {
            verifyOoJWT(token);
        } catch (e) {
            console.error(`[OnlyOffice] callback: невалидный JWT — ${e.message}`);
            return res.status(403).json({ error: 1 });
        }
    }

    const { status, url, key } = req.body || {};
    console.log(`[OnlyOffice] callback: fileId=${fileId} | status=${status} | key=${key}`);

    // 2. Только status 2 (закрыт с изменениями) и 6 (forcesave) требуют сохранения
    if (status === 2 || status === 6) {
        // Отвечаем немедленно и сохраняем асинхронно (не нарушаем 5-сек таймаут)
        res.json({ error: 0 });

        try {
            const fileResponse = await fetch(url, { signal: AbortSignal.timeout(15000) });
            if (!fileResponse.ok) throw new Error(`DocServer вернул ${fileResponse.status}`);

            const buffer  = await fileResponse.arrayBuffer();
            const docxBuf = Buffer.from(buffer);
            const outPath = path.join(STORAGE_DIR, `${fileId}.docx`);

            await fsP.writeFile(outPath, docxBuf);

            // Обновляем documentKey — следующее открытие должно использовать новый ключ
            const newKey = `${fileId}_${Date.now()}`;
            const entry  = fileRegistry.get(fileId) || {};
            fileRegistry.set(fileId, { ...entry, documentKey: newKey });

            console.log(`[OnlyOffice] saved: fileId=${fileId} | ${docxBuf.length} bytes | newKey=${newKey}`);
        } catch (err) {
            console.error(`[OnlyOffice] save error (fileId=${fileId}):`, err.message);
        }
        return;
    }

    // Остальные статусы (1, 3, 4, 7) — просто подтверждаем
    res.json({ error: 0 });
});

// ── Bridge API: App.jsx → plugin.js (кросс-origin через backend) ──
// App.jsx (localhost:5173) и plugin.js (localhost:8080) — разные origin.
// localStorage не разделяется между ними. Решение: relay через backend.
//
// POST /api/onlyoffice/bridge/push  { type, text, oldText, anchor }
// GET  /api/onlyoffice/bridge/poll  ?since=<ts>  → { cmds:[], ts }
const _bridgeQueue = [];

router.post('/onlyoffice/bridge/push', express.json({ limit: '256kb' }), (req, res) => {
    const { type, text, oldText, anchor } = req.body || {};
    if (!type) return res.status(400).json({ error: 'type required' });
    const cmd = { type, text: text || '', oldText: oldText || '', anchor: anchor || '', ts: Date.now() };
    _bridgeQueue.push(cmd);
    if (_bridgeQueue.length > 50) _bridgeQueue.splice(0, _bridgeQueue.length - 50);
    res.json({ ok: true });
});

router.get('/onlyoffice/bridge/poll', (req, res) => {
    const since = parseInt(req.query.since) || 0;
    const cmds = _bridgeQueue.filter(c => c.ts > since);
    res.json({ cmds, ts: Date.now() });
});

// ── Bridge DocText: plugin.js → App.jsx ───────────────────────────
// Плагин каждые 8с пушит актуальный текст документа (после правок в ONLYOFFICE).
// App.jsx читает перед каждым ИИ-запросом → ИИ всегда видит свежий текст.
// POST /api/onlyoffice/bridge/doctext  { text }
// GET  /api/onlyoffice/bridge/doctext  → { text, ts }
let _doctextStore = { text: '', ts: 0 };

router.post('/onlyoffice/bridge/doctext', express.json({ limit: '512kb' }), (req, res) => {
    const { text } = req.body || {};
    if (typeof text === 'string') {
        _doctextStore = { text, ts: Date.now() };
        console.log(`[OnlyOffice] doctext updated: ${text.length} chars`);
    }
    res.json({ ok: true });
});

router.get('/onlyoffice/bridge/doctext', (req, res) => {
    res.json(_doctextStore);
});

// ── Bridge Selection: plugin.js → App.jsx ─────────────────────────
// POST /api/onlyoffice/bridge/selection  { fileId?, text }
// GET  /api/onlyoffice/bridge/selection?fileId=...
router.post('/onlyoffice/bridge/selection', express.json({ limit: '64kb' }), (req, res) => {
    const { fileId, text } = req.body || {};
    const key = fileId || '__default';
    _selectionStore.set(key, { text: text || '', ts: Date.now() });
    res.json({ ok: true });
});

router.get('/onlyoffice/bridge/selection', (req, res) => {
    const key = req.query.fileId || '__default';
    const entry = _selectionStore.get(key) || { text: '', ts: 0 };
    res.json(entry);
});

// ── POST /api/onlyoffice/audit-docx ────────────────────────────────
// Принимает массив рисков из /api/analyze-document → создаёт
// сводный .docx с аннотациями → возвращает {fileId} для ONLYOFFICE.
router.post('/onlyoffice/audit-docx', express.json({ limit: '1mb' }), async (req, res) => {
    try {
        const { risks, title } = req.body || {};
        if (!Array.isArray(risks) || !risks.length) {
            return res.status(400).json({ error: 'risks[] обязателен' });
        }
        const result = await buildAnnotatedSummary(null, risks, { title: title || 'Аудит документа' });
        const documentKey = `${result.fileId}_${Date.now()}`;
        fileRegistry.set(result.fileId, { documentKey, filename: 'Audit_Miyzamchy.docx', uploadedAt: Date.now() });
        console.log(`[OnlyOffice] audit-docx: ${risks.length} рисков → fileId=${result.fileId}`);
        res.json({ fileId: result.fileId, documentKey });
    } catch (err) {
        console.error('[OnlyOffice] audit-docx error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Вспомогательная: построить конфиг для DocsAPI.DocEditor ────────
function buildEditorConfig(fileId, documentKey, filename) {
    const payload = {
        document: {
            fileType: 'docx',
            key: documentKey,
            title: filename,
            url: `${BACKEND_URL}/api/files/${fileId}/download`,
            permissions: {
                edit: true,
                download: true,
                print: true,
                comment: true,
                review: false
            }
        },
        editorConfig: {
            mode: 'edit',
            lang: 'ru',
            callbackUrl: `${BACKEND_URL}/api/onlyoffice/callback/${fileId}`,
            user: { id: 'lawyer', name: 'Юрист' },
            customization: {
                autosave: true,
                forcesave: false,
                compactToolbar: false,
                logo: { visible: false },
                chat: { visible: false },
                comments: { visible: true }
            },
            // Автозапуск плагина при открытии документа.
            // pluginsData URL должен быть доступен ИЗ БРАУЗЕРА (не из Docker).
            plugins: {
                autostart: [PLUGIN_GUID],
                pluginsData: [`${BROWSER_URL}/api/onlyoffice/plugin/config.json`]
            }
        },
        type: 'desktop'
    };

    // Подписываем JWT если секрет задан
    const token = OO_JWT_SECRET ? signOoJWT(payload) : undefined;
    return { ...payload, token, _ooUrl: OO_URL };
}

module.exports = router;
