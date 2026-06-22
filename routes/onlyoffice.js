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

// ── Конфиг ──────────────────────────────────────────────────────────
const STORAGE_DIR  = path.join(__dirname, '..', 'storage', 'documents');
const OO_JWT_SECRET = process.env.ONLYOFFICE_JWT_SECRET || '';
const OO_URL        = process.env.ONLYOFFICE_URL        || 'http://localhost:8080';
const BACKEND_URL   = process.env.BACKEND_URL           || 'https://miyzamchi-backend.onrender.com';

// В памяти: fileId → { documentKey, filename, uploadedAt }
const fileRegistry = new Map();

// Гарантируем существование директории хранилища
fsP.mkdir(STORAGE_DIR, { recursive: true }).catch(() => {});

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
            }
        },
        type: 'desktop'
    };

    // Подписываем JWT если секрет задан
    const token = OO_JWT_SECRET ? signOoJWT(payload) : undefined;
    return { ...payload, token, _ooUrl: OO_URL };
}

module.exports = router;
