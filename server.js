require('dotenv').config();

// ═══════════════════════════════════════════════════════════════════
//  PR 2: GLOBAL HTTP KEEP-ALIVE (Connection Pooling)
// ═══════════════════════════════════════════════════════════════════
// Каждый запрос к DeepSeek/Gemini/Pinecone без keep-alive тратит
// 200-500мс на TLS handshake. На 25 пунктах × 2-3 запроса = 10-15с
// потерь только на рукопожатиях.
//
// Подход: 2 слоя:
//   1) https.globalAgent.keepAlive — для библиотек, использующих
//      node:https напрямую (на всякий случай).
//   2) undici setGlobalDispatcher — для нативного fetch() (Node 18+),
//      который используют ВСЕ наши клиенты:
//      • OpenAI SDK (DeepSeek)  → внутри fetch
//      • Google Gemini SDK      → внутри fetch
//      • Pinecone (наш код)     → native fetch
//      • Embedding (наш код)    → native fetch
//
// Преимущество undici-подхода: НЕ нужно по отдельности патчить каждый
// клиент (тащить httpAgent в new OpenAI(...), переопределять fetch в
// GoogleGenerativeAI и т.д.). Один глобальный диспатчер — и все
// последующие fetch-вызовы переиспользуют TCP+TLS соединения.
//
// undici встроен в Node 18+ — не требует npm install.
// На случай если узел старее — оборачиваем в try/catch (graceful no-op).
try {
    const https = require('node:https');
    https.globalAgent.keepAlive = true;
    https.globalAgent.keepAliveMsecs = 30000;   // 30с TCP keep-alive ping
    https.globalAgent.maxSockets = 50;          // макс. одновременных сокетов на хост
    https.globalAgent.maxFreeSockets = 10;      // держим до 10 idle-сокетов в пуле
    console.log('[KeepAlive] https.globalAgent enabled (legacy node:https libs)');
} catch (e) {
    console.warn('[KeepAlive] https.globalAgent setup failed:', e.message);
}
try {
    const { setGlobalDispatcher, Agent } = require('undici');
    setGlobalDispatcher(new Agent({
        keepAliveTimeout: 30000,            // 30с idle keep-alive
        keepAliveMaxTimeout: 60000,         // макс 60с до принудительного закрытия
        connections: 50,                    // макс. одновременных соединений к одному хосту
        pipelining: 1                       // 1 = no HTTP pipelining (DeepSeek/Gemini не гарантируют поддержку)
    }));
    console.log('[KeepAlive] undici global dispatcher enabled (covers all fetch-based clients)');
} catch (e) {
    console.warn('[KeepAlive] undici setup failed (Node < 18?):', e.message);
}
// ═══════════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');
const { AsyncLocalStorage } = require('async_hooks');
const path = require('path');
const bot = require('./telegram/bot');
const { searchSupabase } = require('./services/supabaseService');

const app = express();
app.set('trust proxy', 1); // Доверие к прокси Render

// --- HELMET (безопасность HTTP-заголовков) ---
// CSP: разрешаем CDN, которые реально использует index.html + IDE-фронт
// (React, Babel, Quill, TipTap, marked, mammoth, html2pdf, lucide, fonts, DOMPurify).
// 'unsafe-inline' + 'unsafe-eval' нужны для Babel-standalone и встроенных
// <script type="text/babel"> в IDE — без них фронт не запустится.
// Даже с этими послаблениями CSP блокирует загрузку чужих скриптов,
// формы на чужие домены и XHR в неизвестные места — это основная ценность.
app.use(helmet({
    contentSecurityPolicy: {
        useDefaults: true,
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
                "'self'",
                "'unsafe-inline'",
                "'unsafe-eval'",
                'https://unpkg.com',
                'https://cdn.jsdelivr.net',
                'https://cdnjs.cloudflare.com',
                'https://cdn.quilljs.com',
                'https://esm.sh'
            ],
            styleSrc: [
                "'self'",
                "'unsafe-inline'",
                'https://fonts.googleapis.com',
                'https://cdn.jsdelivr.net',
                'https://cdnjs.cloudflare.com',
                'https://cdn.quilljs.com',
                'https://unpkg.com'
            ],
            fontSrc: [
                "'self'",
                'data:',
                'https://fonts.gstatic.com',
                'https://cdnjs.cloudflare.com'
            ],
            imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
            connectSrc: [
                "'self'",
                'https://miyzamchi-backend.onrender.com',
                'https://cbd.minjust.gov.kg',
                'https://esm.sh'
            ],
            objectSrc: ["'none'"],
            frameAncestors: ["'self'"],
            baseUri: ["'self'"],
            formAction: ["'self'"]
        }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// --- CORS (whitelist через env, fallback на разумные дефолты) ---
// ALLOWED_ORIGINS в Render: comma-separated. Если не задан — дефолт
// (Netlify production + старый MVP + Render-домен + localhost для dev).
const DEFAULT_ALLOWED_ORIGINS = [
    'https://miyzamchy-ceo.com.kg',            // новый prod-домен (CEO)
    'http://miyzamchy-ceo.com.kg',             // тот же домен без TLS — на случай http-захода
    'https://www.miyzamchy-ceo.com.kg',        // www-вариант prod-домена
    'http://www.miyzamchy-ceo.com.kg',         // www без TLS
    'https://miyzamchi-web.onrender.com',      // Render Static — рабочий фронтенд (MPA: ChatMZ + workspace)
    'https://miyzamchy-test.netlify.app',      // текущий prod-домен (Y, не I)
    'https://miyzamchy-test-mvp.netlify.app',  // старый MVP-домен — оставлен для обратной совместимости
    'https://miyzamchi-backend.onrender.com',
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    'http://localhost:8080'   // ONLYOFFICE Document Server (plugin autostart)
];
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_ALLOWED_ORIGINS;

app.use(cors({
    origin: (origin, callback) => {
        // origin === undefined → server-to-server / curl / health-check — пропускаем
        // origin === 'null' (строка) → браузер открыл страницу через file:// или
        // sandboxed iframe (юрист открыл IDE двойным кликом по HTML с диска).
        // Это сам пользователь, а не атакующий сайт — пропускаем.
        if (!origin || origin === 'null') return callback(null, true);
        if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        console.warn(`[CORS] Blocked origin: ${origin}`);
        return callback(new Error('Origin not allowed by CORS'), false);
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Token']
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ limit: '2mb', extended: true }));

// ============================================================
// STATIC + UI ROUTES (Chat UI + Legal IDE)
// ============================================================
// БЛОКЛИСТ: режем доступ к серверному коду / манифестам / внутренним файлам
// проекта ДО того как express.static начнёт раздавать корень. Иначе любой
// мог бы скачать /server.js (агент-промпты, MODEL_PRICING, архитектура).
const STATIC_BLOCKLIST = /^\/(server\.js|package\.json|package-lock\.json|CLAUDE\.md|npa_files\.json|copy_script\.js|test-opendata\.js|README(\.md)?|scripts(\/|$)|telegram(\/|$)|node_modules(\/|$)|logic(\/|$)|Skill(\/|$)|\.git|\.cursor|\.env|\.gitignore|\.vscode)/i;
app.use((req, res, next) => {
    if (STATIC_BLOCKLIST.test(req.path)) {
        return res.status(404).send('Not found');
    }
    next();
});

// Премиум-лендинг (index.html → /src/landing-main.jsx) и Workspace
// (workspace.html → /src/main.jsx) существуют ТОЛЬКО в Vite-сборке на
// статик-фронте. В репозитории это сырые исходники со ссылкой на .jsx —
// если отдать их с домена бэкенда (он раздаёт сырой репозиторий), браузер
// заблокирует module-script с MIME text/jsx (белый экран). Поэтому:
//   • /workspace.html → 302 на собранный статик-фронт;
//   • / и /index.html → рабочий базовый чат chat.html (чистый HTML+script.js,
//     открывается без сборки; даёт 2xx, безопасно для health-check Render).
// Эти роуты СТОЯТ ДО express.static, иначе статика отдала бы сырой index.html.
const STATIC_FRONTEND_URL = (process.env.STATIC_FRONTEND_URL || 'https://miyzamchi-web.onrender.com').replace(/\/+$/, '');
app.get('/workspace.html', (req, res) => res.redirect(302, STATIC_FRONTEND_URL + '/workspace.html'));
app.get(['/', '/index.html'], (req, res) => {
    const fs = require('fs');
    let html = fs.readFileSync(path.join(__dirname, 'chat.html'), 'utf8');
    // Inject CLIENT_TOKEN for script.js so the chat can authenticate against the API
    html = html.replace('</head>', `<script>window.__CLIENT_TOKEN=${JSON.stringify(CLIENT_TOKEN||'')};</script>\n</head>`);
    res.type('html').send(html);
});

// dotfiles: 'deny' — express вернёт 403 на .env, .git и любые dotfiles,
// даже если кто-то обойдёт regex выше через ../ или хитрые URL.
app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'deny' }));
app.use(express.static(__dirname, { dotfiles: 'deny' }));

// (Удалён легаси-роут /ide — старый одностраничный TipTap-IDE снесён вместе с
//  папкой ide/. Активный фронт деплоится отдельно на Netlify из src/.)

// --- RATE LIMITING ---
// Лимиты рассчитаны на 3-5 юристов, работающих одновременно (возможно из одного офиса/IP).
const rateLimit = require('express-rate-limit');
const apiLimiter = rateLimit({
    windowMs: 60_000,
    max: 60, // 60/мин: комфортно для 3 юристов из одного IP (~20 каждому)
    standardHeaders: true,
    legacyHeaders: false,
    message: { reply: 'Слишком много запросов. Пожалуйста, подождите одну минуту.' }
});
app.use('/api/chat', apiLimiter);
app.use('/api/analyze-document', apiLimiter);
app.use('/api/upload-document', apiLimiter);
app.use('/api/edit', apiLimiter);
// Deep Analysis (PRO) — жёсткий лимит: дорогой multi-agent pipeline
const deepAnalyzeLimiter = rateLimit({
    windowMs: 60_000,
    max: 6,
    standardHeaders: true,
    legacyHeaders: false,
    message: { reply: 'Лимит глубокого анализа: не более 6 в минуту. Используйте обычный анализ или подождите.' }
});
app.use('/api/deep-analyze-document', deepAnalyzeLimiter);
// v2 (генерация документов) — умеренный лимит: SSE-стриминг, дороже обычного чата
const v2Limiter = rateLimit({
    windowMs: 60_000,
    max: 15, // 15/мин: 3 юристам по 5 генераций в минуту
    standardHeaders: true,
    legacyHeaders: false,
    message: { reply: 'Лимит генерации документов: не более 15 в минуту. Подождите немного.' }
});
app.use('/api/v2', v2Limiter);

// --- MINJUST API PROXY (CORS Bypass & Caching) ---
const apiCache = new Map();
const CACHE_TTL = 1000 * 60 * 60; // 1 час
const MAX_CACHE_SIZE = 200;        // LRU-лимит: не более 200 записей

app.all('/api/minjust/*', async (req, res) => {
  try {
    const endpoint = req.originalUrl.replace('/api/minjust', '');
    const targetUrl = `https://cbd.minjust.gov.kg/api/v1${endpoint}`;
    
    // Генерируем ключ кэша.
    // GET:  ключ = метод + endpoint (включая query-строку из originalUrl)
    // POST: ключ = метод + endpoint + стабильный JSON всего тела (ключи сортированы,
    //       чтобы разный порядок свойств давал одинаковый ключ).
    let cacheKey = `minjust_${req.method}_${endpoint}`;
    if (req.method === 'POST' && req.body && Object.keys(req.body).length > 0) {
      const sortedBody = Object.keys(req.body).sort().reduce((acc, k) => {
        acc[k] = req.body[k];
        return acc;
      }, {});
      cacheKey += `_${JSON.stringify(sortedBody)}`;
    }

    // Проверяем кэш
    if (apiCache.has(cacheKey)) {
      const cached = apiCache.get(cacheKey);
      if (Date.now() - cached.timestamp < CACHE_TTL) {
        // LRU: обновляем позицию — удаляем и переставляем в конец Map,
        // чтобы самая свежая запись не была кандидатом на вытеснение.
        apiCache.delete(cacheKey);
        apiCache.set(cacheKey, cached);
        console.log(`[PROXY CACHE HIT] Отдаем из кэша: ${cacheKey}`);
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).send(cached.data);
      } else {
        apiCache.delete(cacheKey); // Кэш устарел
      }
    }

    console.log(`[PROXY] Отправляем запрос на Минюст: ${targetUrl}`);

    const fetchOptions = {
      method: req.method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://cbd.minjust.gov.kg/',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'Content-Type': 'application/json'
      }
    };

    if (req.method !== 'GET' && req.method !== 'HEAD' && Object.keys(req.body || {}).length > 0) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const response = await fetch(targetUrl, fetchOptions);
    const text = await response.text();

    if (!response.ok) {
      console.error(`[PROXY ERROR] Минюст ответил статусом ${response.status}:`, text);
      return res.status(response.status).send(text);
    }

    // Сохраняем успешный ответ в кэш (LRU-вытеснение при переполнении)
    if (apiCache.size >= MAX_CACHE_SIZE) {
      // Удаляем самую старую запись (первый ключ в Map — наименее недавно использованный)
      apiCache.delete(apiCache.keys().next().value);
      console.log(`[PROXY CACHE EVICT] Вытеснена старейшая запись. Размер: ${apiCache.size}`);
    }
    apiCache.set(cacheKey, { data: text, timestamp: Date.now() });

    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(text);

  } catch (error) {
    console.error('[PROXY CRITICAL ERROR]:', error.message);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
});

const PORT = process.env.PORT || 3000;

// --- НАСТРОЙКИ ИЗ RENDER (Environment Variables) ---
const { GEMINI_API_KEY, GEMINI_API_KEYS } = process.env;
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const rawKeys = GEMINI_API_KEY || GEMINI_API_KEYS;
const KEYS = rawKeys ? rawKeys.split(',').map(k => k.trim()) : [];
let currentKeyIndex = 0;

if (KEYS.length === 0) {
    console.error("ОШИБКА: Проверь переменную GEMINI_API_KEY на Render!");
    process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error("ОШИБКА: SUPABASE_URL и SUPABASE_ANON_KEY обязательны — база НПА перенесена в Supabase!");
    process.exit(1);
}

// --- ТЕЛЕМЕТРИЯ ---
// ADMIN_SECRET ОБЯЗАТЕЛЬНО ставится через env (Render Environment Variables).
// Без него admin endpoints автоматически отключаются — никаких хардкод-fallback.
const ADMIN_SECRET = process.env.ADMIN_SECRET || null;
if (!ADMIN_SECRET) {
    console.warn('[SECURITY] ADMIN_SECRET не задан в env → /api/stats отключён');
}

// CLIENT_TOKEN — опциональный barrier против скрейпинга /api/chat и др.
// Если задан в env, фронт должен слать заголовок X-Client-Token с этим значением.
// Если пустой — middleware пропускает всё (backward compat).
const CLIENT_TOKEN = process.env.CLIENT_TOKEN || null;
if (!CLIENT_TOKEN) {
    console.warn('[SECURITY] CLIENT_TOKEN не задан → API endpoints публичные. Поставьте в Render для защиты от скрейпинга.');
}

function requireClientToken(req, res, next) {
    if (!CLIENT_TOKEN) return next(); // отключено
    const provided = req.headers['x-client-token'] || req.query.client_token;
    if (provided !== CLIENT_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized: missing or invalid X-Client-Token' });
    }
    next();
}

const serverStats = { totalRequests: 0, cacheHits: 0, apiErrors: 0, startTime: Date.now() };

// --- STRUCTURED LOGGER (Sentry-ready scaffold) ---
// Заменяет хаотичные console.error с PII. Когда подключите Sentry —
// добавьте Sentry.init(...) и раскомментируйте Sentry.captureException ниже.
const logger = {
    info:  (msg, meta) => console.log(`[INFO] ${msg}`,  meta ? JSON.stringify(meta) : ''),
    warn:  (msg, meta) => console.warn(`[WARN] ${msg}`, meta ? JSON.stringify(meta) : ''),
    error: (msg, err, meta) => {
        const safeMeta = meta ? JSON.stringify(meta) : '';
        const errMsg = err && err.message ? err.message : String(err || '');
        console.error(`[ERROR] ${msg} | ${errMsg}`, safeMeta);
        // Когда подключите Sentry:
        // if (global.Sentry && err) Sentry.captureException(err, { extra: meta });
    }
};

// --- МАРШРУТ ДЛЯ ПИНГА ---
app.get('/ping', (req, res) => {
    console.log('Пинг получен. Мыйзамчи бодрствует!');
    res.status(200).send('Бодрствую! ');
});

// --- HEALTH CHECK ---
app.get('/health', async (req, res) => {
    let supabaseStatus = 'Error';
    try {
        const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/`, {
            headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` }
        });
        if (sbRes.ok || sbRes.status === 200) supabaseStatus = 'Connected';
    } catch (e) {
        console.error('Health check Supabase error:', e.message);
    }
    res.json({ status: 'OK', keys_total: KEYS.length, supabase: supabaseStatus });
});

// --- СЕКРЕТНАЯ АДМИНКА (ТЕЛЕМЕТРИЯ) ---
app.get('/api/stats', (req, res) => {
    // Если ADMIN_SECRET не задан в env — endpoint полностью отключён,
    // не используется хардкод-fallback, как было раньше.
    if (!ADMIN_SECRET) {
        return res.status(503).json({ error: 'Admin endpoint disabled (ADMIN_SECRET not configured)' });
    }
    if (req.query.key !== ADMIN_SECRET) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    const uptimeMs = Date.now() - serverStats.startTime;
    const hours = Math.floor(uptimeMs / 3_600_000);
    const minutes = Math.floor((uptimeMs % 3_600_000) / 60_000);
    res.json({
        uptime: `${hours}ч ${minutes}м`,
        totalRequests: serverStats.totalRequests,
        cacheHits: serverStats.cacheHits,
        apiErrors: serverStats.apiErrors,
        cacheSize: embeddingCache.size,
        blockedKeysCount: blockedKeys.size
    });
});

// --- УМНАЯ РОТАЦИЯ КЛЮЧЕЙ ---
const blockedKeys = new Map();

// 503 (high demand) — это временный shedding на стороне Google. Блокировка ключа
// на полную минуту слишком агрессивна: при пике все 5 ключей выпадают разом и
// пользователь ждёт минуты. Делаем короткое окно (15с) — этого хватает чтобы
// дать ключу остыть, но не вырубаем всю ротацию надолго.
function blockKey(key, durationMs = 15_000) {
    blockedKeys.set(key, Date.now() + durationMs);
    console.log(`🔒 Ключ заблокирован на ${Math.round(durationMs/1000)}с (всего заблок: ${blockedKeys.size})`);
}

function isKeyBlocked(key) {
    const until = blockedKeys.get(key);
    if (!until) return false;
    if (Date.now() >= until) {
        blockedKeys.delete(key);
        return false;
    }
    return true;
}

function getActiveKey() {
    for (let i = 0; i < KEYS.length; i++) {
        const key = KEYS[currentKeyIndex % KEYS.length];
        if (!isKeyBlocked(key)) return key;
        currentKeyIndex = (currentKeyIndex + 1) % KEYS.length;
    }
    return KEYS[currentKeyIndex % KEYS.length];
}

function getNextKey() {
    for (let i = 0; i < KEYS.length; i++) {
        const key = KEYS[currentKeyIndex % KEYS.length];
        currentKeyIndex = (currentKeyIndex + 1) % KEYS.length;
        if (!isKeyBlocked(key)) return key;
    }
    return KEYS[currentKeyIndex % KEYS.length];
}

// --- ОПРЕДЕЛЕНИЕ ПРИВЕТСТВИЙ (БРОНЕЖИЛЕТ) ---
const GREETING_PATTERNS = [
    /^(салам|саламатсызбы|сал|привет|хай|здравствуй|здравствуйте|добрый день|добрый вечер|доброе утро|hi|hello|hey|ку)[.,!?\s]*(мыйзамчи|бот)?\s*$/i,
    /^(как дела|как ты|как жизнь|что делаешь|кандайсың|кандайсыз|жакшымысың|жакшымысыз)[.,!?\s]*$/i,
    /^(спасибо|рахмат|чоң рахмат|благодарю|thanks|thank you)[.,!?\s]*$/i,
    /^(пока|до свидания|кош бол|сау бол|bye|goodbye)[.,!?\s]*$/i,
    /^(кто ты|что ты|что такое мыйзамчи|ты кто|расскажи о себе|кто тебя создал|кто твой создатель|кто разработчик|чей это проект)[.,!?\s]*$/i,
];

function isCasualMessage(message) {
    const cleaned = message.trim().toLowerCase();
    
    if (/^(продолжай|дальше|пиши дальше|еще|ещё|улан|улантуу|continue|go on)/.test(cleaned)) {
        return true; 
    }

    if (cleaned.length > 60) {
        return false;
    }

    if (/\d/.test(cleaned) || /(статья|берене|закон|мыйзам|кодекс|ук|гк|тк|ск|кр|суд|сот)/.test(cleaned)) {
        return false;
    }

    return GREETING_PATTERNS.some(pattern => pattern.test(cleaned));
}

// --- ОПРЕДЕЛЕНИЕ АКАДЕМИЧЕСКИХ ЗАПРОСОВ ---
function isAcademicRequest(message) {
    return /(курсов[уа]ю|курсовая|реферат|эссе|диплом|дипломн|срс|\bсрс\b|научн[уа]ю?\s*стать)/i.test(message);
}

// --- ДЕТЕКТОР ЗАПРОСОВ НА ГЕНЕРАЦИЮ СУДЕБНЫХ ДОКУМЕНТОВ (L4) ---
function detectL4Request(message) {
    const generationVerbs = /(составь|напиши|сделай|сформируй|создай|набросай|подготовь|оформи)/i;
    const legalDocs = /(иск[^а-яё]|исков[ао]е|апелляц|кассационн|административн[уыо]?[еую]?\s*иск)/i;
    return generationVerbs.test(message) && legalDocs.test(message);
}

// --- КЭШИРОВАНИЕ ЭМБЕДДИНГОВ ---
const embeddingCache = new Map();
const EMBEDDING_MODEL = "models/gemini-embedding-001";

// --- УНИВЕРСАЛЬНЫЙ FETCH ДЛЯ ВЕКТОРОВ ---
// forceKey (optional) — принудительно использовать конкретный ключ
// (нужно для verification-агентов, чтобы распределять нагрузку по ключам параллельно).
async function getEmbedding(text, retryCount = 0, forceKey = null) {
    const cacheKey = text.substring(0, 8000);
    if (embeddingCache.has(cacheKey)) {
        console.log('📦 Эмбеддинг из кэша');
        serverStats.cacheHits++;
        return embeddingCache.get(cacheKey);
    }

    const activeKey = forceKey || getActiveKey();

    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/${EMBEDDING_MODEL}:embedContent?key=${activeKey}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: EMBEDDING_MODEL,
                content: { parts: [{ text: text.substring(0, 8000) }] },
                outputDimensionality: 768
            })
        });

        const data = await response.json();

        if (response.status === 429 && retryCount < KEYS.length) {
            console.log('Ключ ' + (currentKeyIndex + 1) + ' исчерпан. Ротируем...');
            serverStats.apiErrors++;
            blockKey(activeKey);
            currentKeyIndex = (currentKeyIndex + 1) % KEYS.length;
            return getEmbedding(text, retryCount + 1);
        }

        if (!response.ok) {
            throw new Error(data.error?.message || JSON.stringify(data));
        }

        const embedding = data.embedding.values.slice(0, 768);

        if (embeddingCache.size >= 200) {
            embeddingCache.delete(embeddingCache.keys().next().value);
        }

        embeddingCache.set(cacheKey, embedding);
        return embedding;

    } catch (error) {
        console.error("Ошибка вектора:", error.message);
        throw error;
    }
}

// --- EMBEDDING 1536d (gemini-embedding-2.0-flash, те же Gemini-ключи) — для Supabase ---
const EMBEDDING_MODEL_V2 = 'models/gemini-embedding-2';
const embeddingCacheSupabase = new Map();
async function getEmbeddingForSupabase(text, retryCount = 0, forceKey = null) {
    const cacheKey = 'sb_' + text.substring(0, 8000);
    if (embeddingCacheSupabase.has(cacheKey)) {
        serverStats.cacheHits++;
        return embeddingCacheSupabase.get(cacheKey);
    }
    const activeKey = forceKey || getActiveKey();
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/${EMBEDDING_MODEL_V2}:embedContent?key=${activeKey}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: EMBEDDING_MODEL_V2,
                content: { parts: [{ text: text.substring(0, 8000) }] },
                outputDimensionality: 1536,
                taskType: 'RETRIEVAL_QUERY'
            })
        });
        const data = await response.json();
        if (response.status === 429 && retryCount < KEYS.length) {
            blockKey(activeKey);
            currentKeyIndex = (currentKeyIndex + 1) % KEYS.length;
            return getEmbeddingForSupabase(text, retryCount + 1);
        }
        if (!response.ok) throw new Error(data.error?.message || JSON.stringify(data));
        const embedding = data.embedding.values;
        if (embeddingCacheSupabase.size >= 200) {
            embeddingCacheSupabase.delete(embeddingCacheSupabase.keys().next().value);
        }
        embeddingCacheSupabase.set(cacheKey, embedding);
        return embedding;
    } catch (error) {
        console.error('Ошибка gemini-embedding-2:', error.message);
        throw error;
    }
}

// --- ПОИСК (обёртка над Supabase, сохраняет имя для dep-injection в routes/analyze.js) ---
// Сигнатура: (vector, queryText, topK) — queryText нужен для full-text части hybrid search
async function searchPinecone(vector, queryText = '', topK = 15) {
    return searchSupabase(vector, queryText, topK);
}

// Все запросы идут в Supabase (единая база НПА + FAQ)
function classifyQuerySource() { return 'supabase'; }

// Категории FAQ/инструкций в поле category (npa_title) Supabase
const FAQ_CATEGORY_KEYS = new Set(['instructions', 'instruction', 'faq', 'guide', 'guides']);
function isMatchFaq(match) {
    return FAQ_CATEGORY_KEYS.has((match.metadata?.npa_title || '').toLowerCase().trim());
}

// Классификатор типа запроса — определяет квоту НПА vs Инструкции
// 'npa'    — явный вопрос по статьям законов
// 'faq'    — явный вопрос о процедуре/адресе/стоимости
// 'hybrid' — всё остальное (по умолчанию: нужны оба источника)
function classifyQueryType(query) {
    const q = (query || '').toLowerCase();
    const NPA_EXACT = [
        'что говорит статья', 'какая статья', 'по статье', 'процитируй закон',
        'текст закона', 'норма закона', 'по какому закону', 'нарушение права',
        'предусмотрено законом', 'согласно закону', 'по закону', 'по кодексу'
    ];
    const FAQ_EXACT = [
        'куда обратиться', 'куда идти', 'куда позвонить', 'адрес цон', 'адрес органа',
        'режим работы', 'телефон', 'как записаться', 'номер очереди', 'через тундук',
        'через gosreestr', 'время работы'
    ];
    if (NPA_EXACT.some(k => q.includes(k))) return 'npa';
    if (FAQ_EXACT.some(k => q.includes(k))) return 'faq';
    return 'hybrid'; // дефолт — тянем оба типа
}

function sendStatus(res, text, icon) {
    if (!res || res.writableEnded) return;
    res.write(`data: ${JSON.stringify({ protocolStatus: text, icon })}\n\n`);
}

// Fine-grained stepper event для IDE-чата (Thinking Box).
// step = { id, status: 'loading'|'success'|'warning'|'error', text, reason?, score? }
function sendStep(res, step) {
    if (!res || res.writableEnded || !step || !step.id) return;
    try { res.write(`data: ${JSON.stringify({ step })}\n\n`); } catch (e) {}
}

// --- АДАПТИВНЫЙ RETRIEVAL 2.0 (с реальным стримингом этапов) ---
// Возвращает: { core: [...], context: [...], all: [...] }
//   core    — статьи с высоким score (> CORE_THRESHOLD) — Gemini опирается на них
//   context — статьи среднего score — используются как справка
//   all     — объединение для логирования и источников
// Если res передан — шлёт SSE-статусы после каждого реального этапа pipeline
function expandCyrillicAbbreviation(text, abbrPattern, replacement) {
    const regex = new RegExp(`(^|[^a-zа-яё0-9])(${abbrPattern})([^a-zа-яё0-9]|$)`, 'gi');
    return text.replace(regex, (match, p1, p2, p3) => {
        return p1 + replacement + p3;
    });
}

function expandQueryAbbreviations(query) {
    let expandedQuery = query;
    const replacements = [
        { pattern: 'гк\\s*кр|гк', replacement: 'Гражданский кодекс Кыргызской Республики' },
        { pattern: 'ук\\s*кр|ук', replacement: 'Уголовный кодекс Кыргызской Республики' },
        { pattern: 'тк\\s*кр|тк', replacement: 'Трудовой кодекс Кыргызской Республики' },
        { pattern: 'упк\\s*кр|упк', replacement: 'Уголовно-процессуальный кодекс Кыргызской Республики' },
        { pattern: 'гпк\\s*кр|гпк', replacement: 'Гражданский процессуальный кодекс Кыргызской Республики' },
        { pattern: 'коап\\s*кр|коап|коао\\s*кр|коао', replacement: 'Кодекс об административной ответственности Кыргызской Республики' },
        { pattern: 'нк\\s*кр|нк', replacement: 'Налоговый кодекс Кыргызской Республики' },
        { pattern: 'ск\\s*кр|ск', replacement: 'Семейный кодекс Кыргызской Республики' },
        { pattern: 'зк\\s*кр|зк', replacement: 'Земельный кодекс Кыргызской Республики' },
        { pattern: 'жк\\s*кр|жк', replacement: 'Жилищный кодекс Кыргызской Республики' },
        { pattern: 'бк\\s*кр|бк', replacement: 'Бюджетный кодекс Кыргызской Республики' }
    ];

    for (const r of replacements) {
        expandedQuery = expandCyrillicAbbreviation(expandedQuery, r.pattern, r.replacement);
    }
    return expandedQuery;
}

async function adaptiveRetrieval(query, mode, res = null, opts = {}) {
    // --- Квоты НПА + FAQ по режиму (hybrid = оба источника) ---
    const quotaDefaults = {
        thinking: { npa: 6, faq: 4 },
        agent:    { npa: 8, faq: 4 },
        fast:     { npa: 5, faq: 3 }
    };
    const qd = quotaDefaults[mode] || quotaDefaults.fast;

    const absoluteMinScore = opts.absoluteMinScore ?? 0.40;
    const coreScoreThreshold = opts.coreScoreThreshold ?? 0.70;
    const source = opts.source ?? 'supabase';

    const streamStatuses = res && mode === 'thinking';

    // --- Этап 1: Расширение аббревиатур ---
    const expandedQuery = expandQueryAbbreviations(query);
    if (expandedQuery !== query) {
        console.log(`[Retrieval] Аббревиатуры: "${query}" -> "${expandedQuery}"`);
    }

    // --- Тип запроса: npa / faq / hybrid (opts.queryType переопределяет авто-классификацию) ---
    const queryType = opts.queryType || classifyQueryType(expandedQuery);
    const npaQuota = opts.npaQuota ?? (queryType === 'faq' ? 0 : qd.npa);
    const faqQuota = opts.faqQuota ?? (queryType === 'npa' ? 0 : qd.faq);
    const totalTarget = npaQuota + faqQuota;

    if (streamStatuses) sendStatus(res, 'Преобразую ваш вопрос в вектор...', '🧬');

    // --- Этап 2: Широкий поиск (тянем с запасом, чтобы набрать оба типа) ---
    const rawK = Math.max(totalTarget * 3, 20);
    if (streamStatuses) sendStatus(res, `Ищу в базе НПА и инструкции (тип: ${queryType})...`, '🔎');
    const embedding = await getEmbeddingForSupabase(expandedQuery);
    const rawMatches = await searchPinecone(embedding, expandedQuery, rawK);

    if (rawMatches.length === 0) {
        if (streamStatuses) sendStatus(res, 'База не вернула результатов', '⚠️');
        console.log(`[Retrieval] ${mode} | ${queryType} | ⚠️ пусто`);
        return { core: [], context: [], all: [], queryType };
    }

    // --- Этап 3: Разделяем на НПА и Инструкции, отбираем по квоте ---
    // Supabase hybrid score имеет другой диапазон чем Pinecone — не фильтруем по порогу,
    // просто берём топ-N из каждой категории (Supabase уже сортирует по релевантности).
    const npaRaw = rawMatches.filter(m => !isMatchFaq(m));
    const faqRaw = rawMatches.filter(m =>  isMatchFaq(m));

    const selectedNpa = npaRaw.slice(0, npaQuota);
    const selectedFaq = faqRaw.slice(0, faqQuota);

    // Если одна из категорий пуста — добираем из оставшихся rawMatches
    const usedIds = new Set([...selectedNpa, ...selectedFaq].map(m => m.id));
    const extras = rawMatches
        .filter(m => !usedIds.has(m.id))
        .slice(0, Math.max(0, totalTarget - selectedNpa.length - selectedFaq.length));

    // Объединяем и сортируем по score
    const candidates = [...selectedNpa, ...selectedFaq, ...extras]
        .sort((a, b) => (b.score || 0) - (a.score || 0));

    const core    = candidates.filter(m => (m.score || 0) >= coreScoreThreshold);
    const context = candidates.filter(m => (m.score || 0) <  coreScoreThreshold);

    const topScore = rawMatches[0] ? (rawMatches[0].score || 0).toFixed(3) : 'n/a';
    console.log(
        `[Retrieval] ${mode} | ${queryType} | topScore:${topScore} | ` +
        `НПА:${selectedNpa.length}/${npaRaw.length} | FAQ:${selectedFaq.length}/${faqRaw.length} | ` +
        `⭐core:${core.length} 📚ctx:${context.length} | total:${candidates.length}`
    );

    if (streamStatuses) sendStatus(res, `Нашёл ${selectedNpa.length} статей НПА и ${selectedFaq.length} инструкций`, '✅');

    return { core, context, all: candidates, queryType };
}

// ════════════════════════════════════════════════════════════════════
// DOCUMENT-GROUNDED ANALYSIS — config + helpers
// ════════════════════════════════════════════════════════════════════
// Архитектура:
//   1) Extractor (Key[0])      — извлекает все статьи из документа
//   2) Verifiers (Key[1..N])   — параллельно сверяют группы по 3 статьи с Pinecone
//   3) Synthesizer (Key[last]) — финальный анализ ТОЛЬКО на основе verified-данных
//
// Метаданные Pinecone: { npa_title, article_title, full_text, text_preview }
// Поля article_number нет — номер достаём regex'ом из full_text.
// ════════════════════════════════════════════════════════════════════
const DOC_ANALYSIS_CONFIG = {
    maxArticles: 30,                // жёсткий лимит — защита ключей от rate limit
    pineconeTopK: 5,                // 5 кандидатов на статью → regex match по всем
    minDocumentLength: 50,          // < 50 → перенаправляем в обычный чат
    extractorChunkSize: 7000,
    extractorChunkOverlap: 500,
    confidenceThresholds: { high: 0.75, medium: 0.70, low: 0.60 }
};

// Извлекаем номер статьи из full_text Pinecone-метаданных.
// Примеры: "Статья 1¹. Предмет регулирования" → "1¹"
//          "Статья 137 Пытки"                  → "137"
function extractArticleNumber(fullText) {
    if (!fullText) return null;
    const m = String(fullText).match(/Статья\s+([\d¹²³⁴⁵⁶⁷⁸⁹⁰\-\.]+)/);
    if (!m) return null;
    return m[1].trim().replace(/\.$/, '');
}

function escapeRegex(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Найти лучшее совпадение из топ-N кандидатов Pinecone:
//   - сначала ищем тот где номер статьи в full_text БУКВАЛЬНО совпадает с искомым,
//   - если не нашли — возвращаем top-1 по score с numberMatches:false.
function findBestArticleMatch(candidates, article) {
    if (!candidates || candidates.length === 0) return null;
    const needle = escapeRegex(article.article || '');
    if (!needle) return candidates[0] ? { ...candidates[0], numberMatches: false } : null;
    // Regex: "Статья 137" / "Статья 137." / "Статья 137¹" / "Статья 137-1"
    const re = new RegExp(`Статья\\s+${needle}[¹²³⁴⁵⁶⁷⁸⁹⁰\\.\\s\\-]`, 'i');
    for (const c of candidates) {
        const fullText = (c && c.metadata && c.metadata.full_text) || '';
        if (re.test(fullText)) {
            return { ...c, numberMatches: true };
        }
    }
    return { ...candidates[0], numberMatches: false };
}

function sendConfidence(res, payload) {
    if (!res || res.writableEnded) return;
    res.write(`data: ${JSON.stringify({ confidence: payload })}\n\n`);
}

// ============================================================
// AI РЕДАКТОР (API для IDE)
// ============================================================
// ═══════════════════════════════════════════════════════════════════
// /api/edit — правка ВЫДЕЛЕННОГО фрагмента. Возвращает {reasoning, commands}.
// ─────────────────────────────────────────────────────────────────
// РАНЬШЕ здесь был Split Execution через @superdoc-dev/sdk (chooseTools/
// getToolCatalog → Gemini functionDeclarations). Это давало HTTP 500:
//   • chooseTools({provider:'gemini'}) бросает (валидны openai/anthropic/...)
//   • схемы SuperDoc-инструментов несовместимы с Gemini function-calling
// SDK — headless (server-side + Yjs), к браузерному редактору не подключён.
// Теперь /api/edit использует ТОТ ЖЕ контракт, что и handleAgent: Gemini +
// AGENT_SYSTEM_PROMPT → JSON {reasoning, commands[]}. Фронт применяет команды
// нативным Document API (applyAgentCommand). НИКОГДА не отдаёт 500 — на ошибке
// возвращает 200 с пустым commands и текстом в reasoning (фронт не падает).
// ═══════════════════════════════════════════════════════════════════
app.post('/api/edit', requireClientToken, async (req, res) => {
    serverStats.totalRequests++;
    try {
        const { text, instruction, documentContext = '' } = req.body;
        if (!instruction) {
            return res.json({ reasoning: 'Пустая инструкция.', commands: [] });
        }

        const selBlock = text
            ? `\n\nВЫДЕЛЕННЫЙ ФРАГМЕНТ (основная цель правки — используй как old_text для replace):\n"""\n${String(text).slice(0, 8000)}\n"""`
            : '';
        const ctxBlock = documentContext
            ? `\n\nТЕКУЩИЙ ТЕКСТ ДОКУМЕНТА:\n"""\n${String(documentContext).slice(0, 15000)}\n"""`
            : '';
        const userPrompt = `ЗАПРОС ЮРИСТА: ${instruction}${selBlock}${ctxBlock}`;

        const apiKey = getNextKey();
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
            model: PRIMARY_MODEL,
            systemInstruction: AGENT_SYSTEM_PROMPT,
            generationConfig: { temperature: 0.4, topP: 0.9, maxOutputTokens: 4096 }
        });

        const result = await model.generateContent(userPrompt);
        const raw = ((result && result.response && result.response.text && result.response.text()) || '').trim();

        // Извлекаем JSON-блок {reasoning, commands}
        let reasoning = '', commands = [];
        try {
            const m = raw.match(/```json\s*([\s\S]*?)\s*```/i) || raw.match(/\{[\s\S]*\}/);
            const jsonStr = m ? (m[1] || m[0]) : raw;
            const parsed = JSON.parse(jsonStr);
            reasoning = parsed.reasoning || '';
            commands = Array.isArray(parsed.commands) ? parsed.commands : [];
            // обратная совместимость: insertion_text/anchor_text → одна команда
            if (commands.length === 0 && parsed.insertion_text) {
                commands = [{ op: 'insert_after', anchor: parsed.anchor_text === 'EMPTY' ? '' : (parsed.anchor_text || ''), text: parsed.insertion_text }];
            }
        } catch (parseErr) {
            console.warn('[/api/edit] JSON parse failed:', parseErr.message);
            reasoning = raw || 'Не удалось разобрать ответ модели.';
        }
        console.log(`[/api/edit] commands=${commands.length} reasoningLen=${reasoning.length}`);
        return res.json({ reasoning, commands });
    } catch (error) {
        console.error("Ошибка в /api/edit:", error.message);
        serverStats.apiErrors++;
        // НЕ роняем 500 — фронт ждёт JSON и иначе крашится.
        return res.json({ reasoning: '⚠️ Не удалось обработать правку: ' + error.message, commands: [] });
    }
});

// ============================================================
// ════════════════════════════════════════════════════════════════════
// ПРИНЦИПЫ ПРАВА КР — единый блок, инжектируется во ВСЕ промпты
// Обновлять здесь → автоматически применяется везде
// ════════════════════════════════════════════════════════════════════
const KG_LEGAL_PRINCIPLES_BLOCK = `
═══ ПРИНЦИПЫ ПРАВА КР — ПРИМЕНЯЙ ПО ОТРАСЛИ ═══

АЛГОРИТМ: (1) Определи отрасль права по вопросу → (2) Найди применимые принципы из нужного блока ниже → (3) Назови их явно в ответе и примени к конкретной ситуации. Не перечисляй все подряд — только те, которые реально работают в данном вопросе.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ОБЩЕПРАВОВЫЕ ПРИНЦИПЫ (применяются во всех отраслях)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

▸ ВЕРХОВЕНСТВО КОНСТИТУЦИИ — Конституция КР имеет высшую юридическую силу. Любая норма, ей противоречащая, не применяется.

▸ ПРИОРИТЕТ МЕЖДУНАРОДНЫХ ДОГОВОРОВ — ратифицированные КР международные договоры имеют приоритет над национальным законодательством (кроме Конституции). При коллизии — применяется договор.

▸ ЗАКОННОСТЬ — органы власти действуют только в рамках закона. Что не разрешено органу — запрещено. Гражданину разрешено всё, что прямо не запрещено.

▸ РАВЕНСТВО ПЕРЕД ЗАКОНОМ И СУДОМ — все равны независимо от происхождения, пола, расы, языка, религии, политических убеждений, имущественного положения.

▸ ИЕРАРХИЯ ИСТОЧНИКОВ — Конституция > Конституционные законы > Кодексы > Законы > Указы Президента > Постановления Кабмина > Ведомственные приказы. Нижестоящий акт не может противоречить вышестоящему — применяется вышестоящий.

▸ LEX SPECIALIS DEROGAT GENERALI — специальная норма имеет приоритет над общей. Если есть специальный закон по теме — он применяется вместо или наряду с общим кодексом.

▸ LEX POSTERIOR DEROGAT PRIORI — более поздний закон равной юридической силы отменяет более ранний.

▸ ОБРАТНАЯ СИЛА ЗАКОНА:
  Улучшающий закон (смягчает ответственность, отменяет запрет, расширяет права) → имеет обратную силу.
  Ухудшающий закон (новая ответственность, более строгое наказание, новые ограничения) → обратной силы НЕ ИМЕЕТ — применяется закон, действовавший на момент возникновения правоотношений.
  Гражданские правоотношения: закон применяется к отношениям, возникшим ПОСЛЕ его вступления в силу. К ранее возникшим — только если прямо указано в самом законе.

▸ НЕДОПУСТИМОСТЬ ЗЛОУПОТРЕБЛЕНИЯ ПРАВОМ — осуществление права с единственной целью причинить вред другому лицу или иное злоупотребление правом не допускается и не защищается судом.

▸ СУДЕБНАЯ ЗАЩИТА ПРАВ — каждый вправе обратиться в суд за защитой нарушенного права. Отказ от права на судебную защиту недействителен.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ГРАЖДАНСКОЕ ПРАВО
Триггер: договоры, собственность, обязательства, возмещение вреда, наследство, интеллектуальная собственность
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

▸ РАВЕНСТВО УЧАСТНИКОВ — стороны гражданских правоотношений равны, никто не имеет привилегий над другим в силу статуса.

▸ НЕПРИКОСНОВЕННОСТЬ СОБСТВЕННОСТИ — никто не может быть лишён имущества иначе как по решению суда или в прямо предусмотренных законом случаях с возмещением.

▸ СВОБОДА ДОГОВОРА — стороны вправе заключить любой договор, не запрещённый законом, в том числе не предусмотренный ГК КР. Принуждение к заключению договора запрещено.

▸ ДОБРОСОВЕСТНОСТЬ И РАЗУМНОСТЬ — все участники обязаны действовать добросовестно. При оценке поведения применяется стандарт «разумного лица в тех же обстоятельствах».

▸ ДИСПОЗИТИВНОСТЬ — стороны вправе самостоятельно определять права и обязанности в договоре, если закон прямо не устанавливает иное. Императивные нормы — не могут быть изменены договором.

▸ PACTA SUNT SERVANDA — договоры должны соблюдаться. Обязательство исполняется надлежащим образом в установленный срок, в установленном месте и в полном объёме.

▸ РЕАЛЬНОЕ ИСПОЛНЕНИЕ — кредитор вправе требовать исполнения обязательства в натуре, а не только денежного возмещения. Уплата неустойки не освобождает от исполнения.

▸ ПОЛНОЕ ВОЗМЕЩЕНИЕ УБЫТКОВ — реальный ущерб (расходы и утрата имущества) + упущенная выгода (неполученные доходы). Кредитор вправе требовать оба.

▸ СОРАЗМЕРНОСТЬ НЕУСТОЙКИ — явно несоразмерная неустойка может быть уменьшена судом по заявлению должника.

▸ REBUS SIC STANTIBUS — существенное изменение обстоятельств, которые стороны не могли предвидеть при заключении договора, является основанием изменения или расторжения договора судом.

▸ ДОБРОСОВЕСТНЫЙ ПРИОБРЕТАТЕЛЬ — лицо, которое приобрело имущество возмездно и не знало о пороке правоотношения, защищается. Виндикация от добросовестного приобретателя ограничена.

▸ СРОК ИСКОВОЙ ДАВНОСТИ — истечение срока не погашает само право, но лишает его судебной защиты. Суд применяет ИД только по заявлению стороны — сам по себе суд не вправе отказать в иске по ИД. Общий срок — 3 года.

▸ ПРИНЦИП ЕДИНСТВА СУДЬБЫ — земельный участок и расположенное на нём строение следуют единой юридической судьбе при отчуждении.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
СЕМЕЙНОЕ ПРАВО
Триггер: брак, развод, раздел имущества, алименты, место жительства детей, усыновление, опека
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

▸ ДОБРОВОЛЬНОСТЬ ВСТУПЛЕНИЯ В БРАК — брак заключается только на основе добровольного взаимного согласия. Принуждение к браку влечёт его недействительность.

▸ ЕДИНОБРАЧИЕ (МОНОГАМИЯ) — одновременное нахождение в нескольких зарегистрированных браках не допускается.

▸ РАВЕНСТВО СУПРУГОВ — в браке, при разводе и разделе имущества супруги имеют равные права независимо от вклада в семейный бюджет.

▸ СОВМЕСТНАЯ СОБСТВЕННОСТЬ — имущество, нажитое в браке, является совместной собственностью обоих супругов (если иное не установлено брачным договором). Доли — равные.

▸ ПРИОРИТЕТ ИНТЕРЕСОВ ДЕТЕЙ — во всех спорах (место проживания, общение с ребёнком, раздел имущества, алименты) интересы несовершеннолетних детей являются приоритетными.

▸ ПРАВО РЕБЁНКА ЗНАТЬ СВОИХ РОДИТЕЛЕЙ — ребёнок имеет право жить и воспитываться в семье, знать своих родителей, общаться с ними и другими родственниками.

▸ РАВНЫЕ ПРАВА РОДИТЕЛЕЙ — отец и мать имеют равные права и несут равные обязанности в отношении своих детей.

▸ НЕОТЧУЖДАЕМОСТЬ РОДИТЕЛЬСКИХ ПРАВ — родительские права не могут быть переданы другому лицу; лишение родительских прав — только судом при наличии оснований.

▸ АЛИМЕНТНЫЕ ОБЯЗАТЕЛЬСТВА — алименты устанавливаются в долях от дохода (на 1 ребёнка — 1/4, на 2 — 1/3, на 3 и более — 1/2) или в твёрдой денежной сумме. Право на алименты — с момента обращения в суд, а при задолженности — за 3 года до обращения.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ТРУДОВОЕ ПРАВО
Триггер: трудовой договор, увольнение, зарплата, дисциплинарные взыскания, отпуска, охрана труда, трудовые споры
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

▸ СВОБОДА ТРУДА — каждый вправе свободно выбирать профессию и вид деятельности. Запрет принуждения к труду.

▸ ЗАПРЕТ ПРИНУДИТЕЛЬНОГО ТРУДА — принудительный труд в любой форме запрещён, в том числе как средство дисциплинарного воздействия работодателя.

▸ ЗАПРЕТ ДИСКРИМИНАЦИИ — запрещена дискриминация в сфере труда (приём, оплата, условия, расторжение) по полу, возрасту, национальности, религии, политическим взглядам, инвалидности и иным основаниям, не связанным с деловыми качествами работника.

▸ IN FAVOREM (В ПОЛЬЗУ РАБОТНИКА) — при неясности или пробеле в условиях трудового договора, при конкуренции нескольких толкований — применяется то, которое улучшает положение работника.

▸ МИНИМАЛЬНЫЕ ГАРАНТИИ — условия трудового договора не могут ухудшать положение работника ниже уровня, установленного законом и коллективным договором. Соглашение о меньших гарантиях — ничтожно.

▸ СВОЕВРЕМЕННОСТЬ ОПЛАТЫ ТРУДА — задержка выплаты заработной платы нарушает трудовые права и влечёт ответственность работодателя вне зависимости от финансового положения организации.

▸ СРОЧНЫЙ ТРУДОВОЙ ДОГОВОР КАК ИСКЛЮЧЕНИЕ — срочный договор допускается только в прямо предусмотренных законом случаях. Сомнения в правомерности срочного договора — в пользу бессрочного.

▸ ОГРАНИЧЕННОЕ ОСНОВАНИЕ ДЛЯ УВОЛЬНЕНИЯ — работодатель вправе расторгнуть договор только по основаниям, прямо указанным в законе. Перечень оснований исчерпывающий.

▸ МАТЕРИАЛЬНАЯ ОТВЕТСТВЕННОСТЬ РАБОТНИКА ОГРАНИЧЕНА — общее правило: не более среднемесячного заработка, если иное прямо не предусмотрено законом (полная мат. ответственность — только в перечисленных случаях).

▸ СОЦИАЛЬНОЕ ПАРТНЁРСТВО — работники и работодатели вправе заключать коллективные соглашения, улучшающие (но не ухудшающие) условия труда по сравнению с законом.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
УГОЛОВНОЕ ПРАВО
Триггер: преступление, наказание, уголовная ответственность, квалификация деяния, соучастие, рецидив
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

▸ ЗАКОННОСТЬ — только УК КР определяет, что является преступлением и какое наказание следует. Аналогия в уголовном праве ЗАПРЕЩЕНА.

▸ NULLUM CRIMEN SINE LEGE — нет преступления без закона. Деяние является преступлением только если оно прямо предусмотрено УК КР на момент его совершения.

▸ NULLA POENA SINE CULPA — нет наказания без вины. Объективное вменение — привлечение без вины — недопустимо. Умысел или неосторожность — обязательное условие ответственности.

▸ ОБРАТНАЯ СИЛА УГОЛОВНОГО ЗАКОНА — закон, устраняющий преступность деяния, смягчающий наказание или иным образом улучшающий положение лица, имеет обратную силу и распространяется на лиц, отбывающих наказание. Закон, устанавливающий или усиливающий ответственность — обратной силы НЕ ИМЕЕТ.

▸ РАВЕНСТВО ПЕРЕД УГОЛОВНЫМ ЗАКОНОМ — уголовная ответственность наступает независимо от должности, статуса, связей.

▸ ВИНОВНОСТЬ — лицо подлежит ответственности только за те деяния, в отношении которых установлена его вина (умысел прямой или косвенный, самонадеянность, небрежность).

▸ СПРАВЕДЛИВОСТЬ НАКАЗАНИЯ — наказание соответствует тяжести деяния, обстоятельствам его совершения и личности виновного. Нельзя наказывать дважды за одно и то же деяние (NON BIS IN IDEM).

▸ СОРАЗМЕРНОСТЬ — суд при назначении наказания обязан учитывать смягчающие обстоятельства (явка с повинной, раскаяние, возмещение ущерба, малолетние дети и др.).

▸ ГУМАНИЗМ — наказание не имеет целью причинение физических страданий или унижение достоинства. Цель — исправление и предупреждение.

▸ НЕОТВРАТИМОСТЬ ОТВЕТСТВЕННОСТИ — каждое преступление должно получить правовую оценку. Освобождение от ответственности — только по основаниям, прямо указанным в законе.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
УГОЛОВНЫЙ ПРОЦЕСС
Триггер: задержание, арест, допрос, доказательства, право на защиту, обвинение, приговор, обжалование
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

▸ ПРЕЗУМПЦИЯ НЕВИНОВНОСТИ — каждый обвиняемый считается невиновным до вступления обвинительного приговора в законную силу. Бремя доказывания лежит на обвинении, а не на защите.

▸ IN DUBIO PRO REO — все неустранимые сомнения в виновности, в доказанности обстоятельств, в квалификации деяния трактуются исключительно в пользу обвиняемого.

▸ СОСТЯЗАТЕЛЬНОСТЬ — стороны обвинения и защиты равноправны. Суд не является органом уголовного преследования и обеспечивает равенство сторон.

▸ ПРАВО НА ЗАЩИТУ — подозреваемый и обвиняемый вправе иметь защитника с момента первого допроса или задержания. Отказ от защитника — только добровольный.

▸ НЕДОПУСТИМОСТЬ ДОКАЗАТЕЛЬСТВ — доказательства, полученные с нарушением закона (без санкции, под принуждением, с нарушением права на защиту), не имеют юридической силы и исключаются.

▸ ПРАВО ХРАНИТЬ МОЛЧАНИЕ — никто не обязан свидетельствовать против себя самого, своего супруга и близких родственников.

▸ НЕПРИКОСНОВЕННОСТЬ ЛИЧНОСТИ — задержание допускается только по основаниям, предусмотренным законом, и на строго ограниченный срок. Незаконное задержание подлежит немедленному прекращению.

▸ НЕПРИКОСНОВЕННОСТЬ ЖИЛИЩА — обыск и осмотр жилища — только с санкции суда или прокурора. Нарушение — основание для признания доказательств недопустимыми.

▸ ТАЙНА ПЕРЕПИСКИ И ПЕРЕГОВОРОВ — прослушивание переговоров и контроль переписки — только с санкции суда.

▸ NON BIS IN IDEM — никто не может быть осуждён повторно за одно и то же деяние. Оправдательный приговор или прекращение дела по реабилитирующим основаниям — окончательны.

▸ ПРАВО НА ПЕРЕВОДЧИКА — если лицо не владеет языком судопроизводства, ему гарантируется бесплатный переводчик на всех стадиях процесса.

▸ РАЗУМНЫЙ СРОК — уголовное дело должно быть рассмотрено в разумные сроки. Затягивание судопроизводства нарушает права участников.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ГРАЖДАНСКИЙ ПРОЦЕСС
Триггер: иск, судебное разбирательство, доказательства, решение суда, апелляция, исполнительное производство
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

▸ ДИСПОЗИТИВНОСТЬ — стороны сами определяют предмет и объём иска, могут изменить требования, отказаться от иска или заключить мировое соглашение. Суд связан заявленными требованиями.

▸ СОСТЯЗАТЕЛЬНОСТЬ — каждая сторона доказывает те обстоятельства, на которые ссылается. Суд оценивает доказательства, представленные сторонами, а не собирает их самостоятельно.

▸ РАВНОПРАВИЕ СТОРОН — истец и ответчик имеют равные процессуальные права и обязанности.

▸ БРЕМЯ ДОКАЗЫВАНИЯ — каждая сторона доказывает то, что утверждает. Истец доказывает наличие права и нарушение. Ответчик — основания освобождения от ответственности.

▸ ДОПУСТИМОСТЬ ДОКАЗАТЕЛЬСТВ — определённые факты могут быть доказаны только установленными видами доказательств. Нарушение — основание для исключения.

▸ ПРЕЮДИЦИЯ — факты, установленные вступившим в силу судебным решением по другому делу с теми же лицами, не доказываются повторно.

▸ ОБЯЗАТЕЛЬНОСТЬ СУДЕБНЫХ РЕШЕНИЙ — вступившее в силу решение суда обязательно для всех лиц и органов на территории КР. Его неисполнение влечёт ответственность.

▸ ИНСТАНЦИОННОСТЬ — апелляция → кассация → надзор. Каждая последующая инстанция проверяет решение предыдущей в установленных пределах.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
АДМИНИСТРАТИВНОЕ ПРАВО И ПРОЦЕСС
Триггер: административная ответственность, штрафы, лицензии, разрешения, действия органов власти, обжалование решений госорганов
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

▸ ЗАКОННОСТЬ ДЕЙСТВИЙ ОРГАНОВ — орган власти вправе делать только то, что прямо предусмотрено законом. Превышение полномочий — незаконно.

▸ ОБРАТНАЯ СИЛА В АДМИНИСТРАТИВНОМ ПРАВЕ — закон, смягчающий или отменяющий административную ответственность, имеет обратную силу. Закон, устанавливающий или усиливающий — не имеет.

▸ ПРЕЗУМПЦИЯ НЕВИНОВНОСТИ — лицо считается невиновным в административном правонарушении до вступления в силу постановления. Бремя доказывания — на органе.

▸ СОРАЗМЕРНОСТЬ (ПРОПОРЦИОНАЛЬНОСТЬ) — административное наказание должно соответствовать тяжести правонарушения, личности нарушителя, его имущественному положению. Орган не вправе назначить наказание, явно не соответствующее содеянному.

▸ NON BIS IN IDEM — за одно административное правонарушение нельзя привлечь к ответственности дважды.

▸ СРОК ДАВНОСТИ ПРИВЛЕЧЕНИЯ — по истечении установленного срока давности лицо не может быть привлечено к административной ответственности, даже если факт нарушения доказан.

▸ ПРАВО НА ОБЖАЛОВАНИЕ — любое постановление по делу об административном правонарушении может быть обжаловано в вышестоящий орган или в суд.

▸ ПРИНЦИП ОДНОКРАТНОСТИ — одно административное правонарушение = одно взыскание. Наложение нескольких санкций за одно нарушение по разным основаниям не допускается.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
НАЛОГОВОЕ ПРАВО
Триггер: налоги, сборы, НДС, налоговые проверки, недоимка, налоговые льготы, обжалование решений налогового органа
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

▸ ЗАКОННОСТЬ НАЛОГА — налог устанавливается только законом. Ни один орган не вправе ввести налог подзаконным актом.

▸ ВСЕОБЩНОСТЬ И РАВЕНСТВО НАЛОГООБЛОЖЕНИЯ — каждый обязан платить законно установленные налоги. Налоговые льготы — только на основании закона, не произвольно.

▸ ОПРЕДЕЛЁННОСТЬ — налог считается установленным, только если определены: налогоплательщик, объект, база, ставка, порядок и срок уплаты. Неясный налог не может быть взыскан.

▸ IN DUBIO PRO CONTRIBUENTE — все неустранимые сомнения, противоречия и неясности в налоговом законодательстве трактуются в пользу налогоплательщика.

▸ НЕДОПУСТИМОСТЬ ОБРАТНОЙ СИЛЫ — закон, ухудшающий положение налогоплательщика, устанавливающий новые налоги или увеличивающий ставки, не имеет обратной силы. Улучшающий — имеет.

▸ СОРАЗМЕРНОСТЬ НАЛОГОВОГО БРЕМЕНИ — налог не может быть конфискационным или делающим экономическую деятельность нецелесообразной.

▸ ПРЕЗУМПЦИЯ ДОБРОСОВЕСТНОСТИ НАЛОГОПЛАТЕЛЬЩИКА — налоговый орган обязан доказать недобросовестность. Без доказательств — налогоплательщик считается добросовестным.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
КАК ПРИМЕНЯТЬ В ОТВЕТЕ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Назови принцип явно: «К данной ситуации применяется принцип [название]»
2. Объясни суть принципа одним-двумя предложениями применительно к ситуации
3. Сформулируй практический вывод: что это конкретно означает для пользователя
Не указывай статьи из памяти — только то, что есть в переданном контексте.
`.trim();

// СИСТЕМНАЯ ИНСТРУКЦИЯ (Быстрый режим)
// ============================================================
const systemInstruction = [
    "# ИДЕНТИЧНОСТЬ",
    "Ты — **Мыйзамчи**, профессиональный юридический ИИ-ассистент Кыргызской Республики для юристов и специалистов.",
    "Твоя задача — помогать практикующим юристам КР в профессиональной работе: консультации по нормам, анализ правовых ситуаций, подготовка правовых позиций, составление документов.",
    "",
    "---",
    "",
    "# ДЛИНА ОТВЕТА — СТРОГОЕ ПРАВИЛО",
    "Отвечай СОРАЗМЕРНО вопросу. Это критически важно:",
    "- Простой вопрос (1-2 предложения от пользователя) → ответ 2-5 предложений",
    "- Средний вопрос (конкретная ситуация) → ответ 1-3 абзаца",
    "- Сложный вопрос (многосоставная ситуация) → структурированный ответ с разделами",
    "- Запрос на документ → только документ + краткие инструкции",
    "ЗАПРЕЩЕНО растягивать ответ списками и подзаголовками там где достаточно абзаца.",
    "ЗАПРЕЩЕНО повторять одну мысль разными словами.",
    "",
    "---",
    "",
    "# ИСТОЧНИКИ ЗНАНИЙ (строгий приоритет)",
    "Контекст может содержать два типа источников:",
    "- **[⭐ КЛЮЧЕВАЯ / 📚 ВСПОМОГАТЕЛЬНАЯ] НОРМАТИВНЫЕ ПРАВОВЫЕ АКТЫ КР** — статьи законов, кодексов, постановлений. Это правовая основа.",
    "- **[📋 ИНСТРУКЦИЯ]** — официальные инструкции и FAQ Тундук/ЦОН о практических процедурах, документах, стоимости.",
    "",
    "1. **НПА — правовая основа:** Опирайся на НПА для ответа ЧТО говорит закон, какое ПРАВО есть у человека, какова ОТВЕТСТВЕННОСТЬ.",
    "2. **Инструкции — практика:** Используй инструкции для ответа КАК подать документы, КУДА обратиться, СКОЛЬКО стоит, КАКОЙ порядок действий.",
    "3. **Оба типа вместе:** Если есть и НПА и инструкции — строй ответ по схеме: правовое основание (НПА) → практические шаги (инструкция).",
    "4. **⭐ КЛЮЧЕВЫЕ vs 📚 ВСПОМОГАТЕЛЬНЫЕ:** КЛЮЧЕВЫЕ — главный ответ. ВСПОМОГАТЕЛЬНЫЕ — смежный контекст, не цитируй их как основу.",
    "5. **Если в контексте нет ответа:** Прямо скажи «К сожалению, в моей текущей базе нет информации по этому вопросу. Рекомендую обратиться к юристу или на сайт cbd.minjust.gov.kg.» Не отвечай из общих знаний.",
    "6. **ЗАПРЕТ НА ГАЛЛЮЦИНАЦИИ:** Нельзя выдумывать номера статей, сроки, суммы или нормы, которых нет в контексте.",
    "",
    "---",
    "",
    "# ИЕРАРХИЯ ИСТОЧНИКОВ И АРГУМЕНТАЦИИ",
    "Строй аргументацию сверху вниз: Кодекс КР (отрасль) → Специальный закон → Подзаконный акт.",
    "Отрасли: договоры/собственность → ГК КР; труд → ТК КР; семья → СК КР; налоги → НК КР; уголовное → УК+УПК КР; административное → КоАО КР.",
    "При коллизии норм: lex specialis (специальная норма) и lex posterior (более поздняя) имеют приоритет. Подробнее — в блоке принципов ниже.",
    "Пример цепочки: «Согласно [норма Кодекса]... В развитие этого [специальный закон]... Порядок определён [подзаконный акт]...»",
    "",
    "---",
    "",
    "# РЕЖИМЫ ОТВЕТА",
    "",
    "## Режим 0 — Приветствие и болталка",
    "- Если пользователь просто поздоровался, поблагодарил, попрощался или написал что-то неюридическое — отвечай тепло и естественно.",
    "- Не начинай с юридики. Просто поздоровайся и предложи помощь.",
    "- Пример: на «Салам!» → «Салам! Кандай жардам бере алам? 😊» или «Привет! Чем могу помочь?»",
    "- На «кто ты?» → кратко представься и объясни чем помогаешь.",
    "- Учитывай историю разговора.",
    "",
    "## Режим 1 — Юридическая консультация",
    "- Начинай с правового основания: «Согласно [название акта], [суть нормы]...»",
    "- Опирайся на нормы из переданного контекста НПА",
    "- Указывай сроки **жирным** (например: **30 дней**, **3 года**)",
    "- Если применим принцип права — назови его явно (обратная сила, lex specialis и т.д.)",
    "- Если норм несколько — расставляй приоритет по иерархии (общая → специальная → подзаконная)",
    "- Учитывай историю разговора.",
    "",
    "## Режим 2 — Объяснение нормы или термина",
    "- Давай точное юридическое определение из контекста, потом прикладной смысл",
    "- Показывай как норма применяется на практике — пример из типовой ситуации",
    "- Указывай связанные нормы и принципы из того же блока права",
    "",
    "## Режим 3 — Составление документа",
    "- **ДОСУДЕБНЫЕ документы** (претензия, заявление в орган, жалоба в прокуратуру) — составляй готовый шаблон с данными из вопроса. Поля: **[ЗАПОЛНИТЬ: подсказка]**.",
    "- Структура досудебных: Шапка → Суть нарушения → Правовое основание (из контекста НПА) → Требования → Срок ответа → Подпись",
    "- **СУДЕБНЫЕ документы** (иск, апелляция, кассация, административный иск) — составляй полную структуру со всеми обязательными реквизитами по ГПК КР. Пользователь — профессиональный юрист, ему нужна рабочая основа, а не общие советы.",
    "  Обязательные элементы иска (ГПК КР): наименование суда → данные истца и ответчика → предмет иска и требования → обстоятельства и их правовое обоснование (нормы из контекста) → цена иска (если имущественный) → перечень приложений → дата и подпись",
    "  В конце добавь: ℹ️ *Сверьте номера статей с актуальной редакцией на cbd.minjust.gov.kg перед подачей.*",
    "",
    "## Режим 4 — Вопрос вне компетенции",
    "- Если вопрос не касается законодательства КР и не является простым общением: «Этот вопрос выходит за рамки моей специализации. Я работаю только с законодательством Кыргызской Республики.»",
    "",
    "---",
    "",
    "# ЯЗЫК",
    "- Отвечай на том языке, на котором задан вопрос (кыргызский / русский)",
    "- Если вопрос смешанный — выбери основной язык вопроса",
    "- Юридические термины на кыргызском можно дублировать на русском в скобках",
    "",
    "---",
    "",
    "═══ ПРАВИЛО БОЛЬШИХ ДОКУМЕНТОВ (СРС, КУРСОВЫЕ, ЭССЕ) ═══",
    "Если пользователь просит написать объемный документ (СРС, реферат, курсовую, текст более 2 страниц), ты КАТЕГОРИЧЕСКИ НЕ ДОЛЖЕН писать весь текст сразу. Это вызовет сбой системы.",
    "Твой алгоритм действий:",
    "1. ШАГ 1 (ПЛАН): Напиши подробный структурированный план работы (Введение, Главы, Заключение).",
    "2. ОСТАНОВКА: После плана ОБЯЗАТЕЛЬНО остановись и спроси: \"План готов. Написать Введение и первую главу?\". Больше ничего не пиши.",
    "3. ШАГ 2 (ПОШАГОВАЯ ГЕНЕРАЦИЯ): Когда пользователь скажет \"да\" или \"продолжай\", посмотри в историю чата, найди свой план, определи, на чем ты остановился, и напиши ТОЛЬКО следующий логический блок (1-2 раздела).",
    "4. ПРОВЕРКА СВЯЗИ: Заканчивай каждый сгенерированный блок вопросом: \"Продолжаем со следующей главы [Название Главы]?\".",
    "Этот цикл повторяется, пока документ не будет закончен.",
    "",
    "---",
    "",
    "# ФОРМАТИРОВАНИЕ",
    "- Используй Markdown: заголовки (##), списки (- или 1.), **жирный** для ключевых норм и сроков",
    "- Длина ответа — строго пропорциональна сложности вопроса",
    "- Не повторяй вопрос пользователя в начале ответа",
    "- **Ссылки на источники:** ВСЕГДА используй реальное название документа и статьи. НИКОГДА не пиши 'Источник 6', 'Источник 7'.",
    "",
    "---",
    "",
    "# ПОВЕДЕНИЕ — СТРОГИЕ ПРАВИЛА",
    "- **ПРИВЕТСТВИЯ:** КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО здороваться (\"Салам\", \"Привет\" и т.п.) в каждом сообщении. Здоровайся ТОЛЬКО если пользователь сам поздоровался в текущем запросе. Иначе — сразу отвечай по сути.",
    "- **ОБ АВТОРЕ:** Информацию о создателе (Zhanybek Asirov, студент юридического факультета КНУ им. Жусупа Баласагына) выдавай ТОЛЬКО если пользователь ПРЯМО спросит \"кто тебя создал?\", \"кто твой автор?\", \"чей ты бот?\". В любых других ответах (консультации, документы, СРС, курсовые) упоминать автора СТРОГО ЗАПРЕЩЕНО.",
    "- **ДИСКЛЕЙМЕР (для юриста-профессионала):** В конце ответа на реальный юридический вопрос — ОДИН раз короткий рабочий disclaimer о необходимости сверки норм с актуальной редакцией. Не пиши «не заменяет консультацию юриста» (пользователь сам юрист). Не дублируй; не добавляй в болталке, шаблонах документов и академических работах. Формат: «Перед использованием в производстве сверьте номера и редакции статей с cbd.minjust.gov.kg.»",
    "",
    "---",
    "",
    "# ЗАПРЕЩЕНО",
    "- Выдумывать номера статей, сроки, суммы или нормы, которых нет в предоставленном контексте — это ГЛАВНОЕ правило",
    "- Цитировать 📚 ВСПОМОГАТЕЛЬНЫЕ статьи как главный ответ на вопрос — они только справка",
    "- Генерировать готовый текст искового заявления / апелляционной жалобы / кассационной жалобы — только структура + рекомендация к юристу",
    "- Давать советы по законодательству других стран (РФ, Казахстан, Узбекистан и др.) как применимые в КР",
    "- Ссылаться на законы РФ или КЗ без явной оговорки что это НЕ законодательство КР",
    "- Давать категоричные прогнозы исхода судебных дел",
    "- Игнорировать вопрос — всегда отвечай на суть, даже если нет точной нормы",
    "- Реагировать на приветствие как на юридический запрос",
    "- Писать длинные ответы на простые вопросы"
].join("\n") + "\n\n" + KG_LEGAL_PRINCIPLES_BLOCK;

// ============================================================
// CONSULTANT AGENT (единственный агент Думающего режима)
// ============================================================
const BASE_CONSULTANT_PROMPT = `
Ты — **Мыйзамчи Эксперт**, опытный практикующий юрист Кыргызской Республики.
Ты не справочник законов — ты живой юрист, который реально помогает людям решить их проблему.

═══ АБСОЛЮТНОЕ ПРАВИЛО: ЗАПРЕТ ГАЛЛЮЦИНАЦИЙ ═══
Твои ответы должны основываться ИСКЛЮЧИТЕЛЬНО на предоставленных статьях законов КР (контексте).
Если в контексте нет ответа на вопрос — ты ОБЯЗАН прямо сказать: «К сожалению, в моей текущей базе НПА нет информации по этому вопросу.»
Тебе КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО:
- Выдумывать номера статей, сроки, суммы или нормы, которых нет в контексте
- Давать советы по праву других стран (РФ, Казахстан и др.) как применимые в КР
- Дополнять контекст общими знаниями без явной оговорки «по общей практике»
Если сомневаешься — лучше честно сказать «не знаю», чем выдумать.

═══ ИЕРАРХИЯ СТАТЕЙ В КОНТЕКСТЕ (ВАЖНО!) ═══
Контекст, который ты получаешь, может быть разделён на две группы:

**⭐ КЛЮЧЕВЫЕ СТАТЬИ** (помечены тегом [⭐ КЛЮЧЕВАЯ СТАТЬЯ — ...])
Это статьи с высоким уровнем семантического соответствия вопросу пользователя.
→ Именно на них ты ДОЛЖЕН опираться при формулировании основного ответа
→ Эти статьи прямо отвечают на вопрос
→ Цитируй их как главное правовое основание

**📚 ВСПОМОГАТЕЛЬНЫЕ СТАТЬИ** (помечены тегом [📚 ВСПОМОГАТЕЛЬНАЯ — ...])
Это статьи со средним уровнем соответствия — смежные нормы, процедурные детали, связанные институты права.
→ Используй ТОЛЬКО как справочный контекст или для полноты картины
→ НЕ цитируй их как главный ответ на вопрос пользователя
→ Упоминай только если они реально уточняют или дополняют ключевые статьи
→ Если они уводят в сторону от темы — проигнорируй

**Если группы не разделены** (все статьи без тегов ⭐/📚) — анализируй их все как обычно, расставляй приоритеты сам по смыслу.

**Если ⭐ КЛЮЧЕВЫЕ статьи отсутствуют** и есть только 📚 ВСПОМОГАТЕЛЬНЫЕ — это сигнал что в базе нет прямого ответа. Будь честен: можешь дать общее направление по вспомогательным, но обязательно укажи что прямого ответа в базе нет и порекомендуй обратиться к юристу.

═══ ИЕРАРХИЯ ИСТОЧНИКОВ И АРГУМЕНТАЦИИ ═══
Строй аргументацию сверху вниз:
  Кодекс КР (фундамент отрасли) → Специальный закон (профильная норма) → Подзаконный акт (детали и процедура)

Отрасль по теме: договоры/собственность → ГК КР; трудовые споры → ТК КР; семья → СК КР; налоги → НК КР; уголовное → УК+УПК КР; административное → КоАО КР.
При коллизии норм — применяй принципы lex specialis и lex posterior (см. блок принципов ниже).
Пример цепочки: «Согласно [норма Кодекса]... В развитие этого [специальный закон]... Порядок определён [подзаконный акт]...»

═══ ДЛИНА ОТВЕТА — КРИТИЧЕСКИ ВАЖНО ═══
Отвечай СОРАЗМЕРНО запросу:
- Простой вопрос → 2-4 предложения, без лишних заголовков
- Средний вопрос → 1-3 абзаца с минимальной структурой
- Сложная ситуация → полная структура с разделами
- Запрос документа → только документ + 2-3 строки инструкции
ЗАПРЕЩЕНО раздувать ответ подзаголовками и повторами там где достаточно абзаца.

═══ ГЛАВНЫЙ ПРИНЦИП ═══
Человек пришёл не за цитатами — он пришёл за решением проблемы.
Понять ситуацию → дать конкретный план → при необходимости составить документ.

═══ ПРАВИЛО АНАЛИЗА КОНТЕКСТА ═══
Тебе передают массив статей НПА КР из семантического поиска (от 3 до 25 статей, разделённых на ⭐ ключевые и 📚 вспомогательные).
ТВОЯ ОБЯЗАННОСТЬ:
1. Прочитай ВСЕ переданные статьи внимательно, начиная с ⭐ КЛЮЧЕВЫХ
2. Основной ответ стройся на ⭐ КЛЮЧЕВЫХ статьях
3. 📚 ВСПОМОГАТЕЛЬНЫЕ статьи — используй как контекст, не как главный ответ
4. Если между статьями есть противоречие — укажи его и объясни какая норма приоритетна
5. Если вопрос сложный — подумай пошагово: что нарушено → какая норма применима → какие сроки → какой порядок действий
Не торопись с ответом. Сначала разбери контекст, потом пиши.

═══ КРИТИЧЕСКОЕ ПРАВИЛО: АНТИ-ГАЛЛЮЦИНАЦИЯ (НОМЕРА СТАТЕЙ) ═══
1. ПРОВЕРКА ЦИФР: Перед написанием любого номера статьи в итоговом ответе, ты ОБЯЗАН сверить его с текстом из предоставленного контекста.
2. ЖЕСТКИЙ ЗАПРЕТ: Если номера статьи нет в предоставленном контексте, ты НЕ ИМЕЕШЬ ПРАВА брать его из своей внутренней памяти.
3. ПРИОРИТЕТ КОНТЕКСТА: Если твоя память подсказывает одну статью, а в контексте указана другая — используй данные из контекста.
4. ТОЧНОСТЬ: Юридическая ошибка в цифрах недопустима. Ты работаешь только с теми фактами и номерами, которые лежат в контексте.

═══ КАК ОПРЕДЕЛИТЬ ЧТО НУЖНО ЧЕЛОВЕКУ ═══

Конфликт / нарушение прав / угрозы →
  → Скажи что нарушено и насколько серьёзно
  → Пошаговый план защиты
  → Предложи нужный документ

«Что мне грозит» / «меня обвиняют» →
  → Оцени реальность угрозы по закону
  → Объясни алиби, свидетели, доказательства
  → Как защититься процессуально

Запрос ДОСУДЕБНОГО документа (претензия, заявление в орган, жалоба в прокуратуру) →
  → Составь готовый шаблон с данными из вопроса
  → Поля для заполнения: [ЗАПОЛНИТЬ: подсказка]
  → Куда подать, в какой срок, что взять

Запрос СУДЕБНОГО документа (иск, исковое заявление, апелляционная/кассационная жалоба, админ. иск) →
  → ⚠️ НЕ ГЕНЕРИРУЙ готовый текст иска с реквизитами сторон — это высокий юридический риск
  → Вместо этого дай:
     1. Структуру обязательных реквизитов искового заявления (согласно ГПК КР из контекста)
     2. Перечень доказательств, которые нужно приложить
     3. Суд, в который подавать, и размер госпошлины
     4. Срок исковой давности
  → Завершай НАСТОЯТЕЛЬНОЙ рекомендацией обратиться к адвокату или юристу — ошибка в иске может привести к отказу судом и потере дела

Сроки / госпошлина / порядок →
  → Конкретные цифры, без уклонений
  → Если зависит от обстоятельств — формула расчёта

═══ СТРУКТУРА ОТВЕТА ДЛЯ СЛОЖНЫХ ВОПРОСОВ ═══

### 🔍 Оценка ситуации
Прямо: что произошло по закону, насколько серьёзно, кто виноват.

### ⚖️ Правовое основание
Конкретные статьи НПА КР (в первую очередь из ⭐ КЛЮЧЕВЫХ). Формат: «Согласно ст. X [Акт КР]...»
Коллизии норм — разбери, укажи приоритет.

### 🗓️ Сроки — ВСЕГДА
- Срок исковой давности: **X лет**
- Срок рассмотрения: **X дней/месяцев**
- Срок апелляции: **X дней**
- Срок ответа на претензию: **X дней**
Сроки — **жирным**. Если истекает — предупреди явно.

### 💰 Расходы (если применимо)
Госпошлина, нотариус, льготы.

### 📋 План действий — ПОШАГОВО
1. Сегодня: [конкретное действие]
2. В течение X дней: [что сделать]
3. Куда идти: [орган / суд]
4. Что взять: [документы]
5. Что будет дальше

### 📄 ДОКУМЕНТ (если нужен)

**Для ДОСУДЕБНЫХ документов составляй готовый шаблон:**

**Претензия:**
\`\`\`
                        [Кому: должность, организация или ФИО]
            От: [ЗАПОЛНИТЬ: ФИО]
            Адрес: [ЗАПОЛНИТЬ]
            Тел.: [ЗАПОЛНИТЬ]

                        ПРЕТЕНЗИЯ

Я, [ЗАПОЛНИТЬ: ФИО], [ситуация из слов пользователя].
Данные действия нарушают [статья и закон из НПА].

Требую:
1. [конкретное требование]

В случае отказа в течение [срок] дней обращусь в суд / прокуратуру.

[ЗАПОЛНИТЬ: дата]        [ЗАПОЛНИТЬ: подпись / ФИО]
\`\`\`

**Жалоба в орган:**
\`\`\`
[Руководителю органа / Прокурору района]
От: [ЗАПОЛНИТЬ: ФИО, адрес, тел.]

ЖАЛОБА

[Описание нарушения из слов пользователя]
Указанные действия нарушают [статьи из НПА].

Прошу:
1. Провести проверку
2. Принять меры реагирования
3. Уведомить о результатах

[ЗАПОЛНИТЬ: дата]        [ЗАПОЛНИТЬ: подпись / ФИО]
\`\`\`

**Для СУДЕБНЫХ документов (иск, апелляция, кассация) — пользователь профессиональный юрист, дай ему полную рабочую основу:**

Обязательная структура искового заявления по ГПК КР:
1. Наименование суда (с указанием подсудности)
2. Данные истца (ФИО/наименование, адрес, телефон, e-mail, банковские реквизиты при наличии)
3. Данные ответчика (ФИО/наименование, адрес)
4. Предмет иска и конкретные требования
5. Фактические обстоятельства + правовое обоснование (нормы из контекста НПА)
6. Цена иска и расчёт (если имущественный)
7. Сведения о досудебном урегулировании (если обязательно)
8. Перечень прилагаемых доказательств
9. Дата и подпись

> ℹ️ *Сверьте номера статей с актуальной редакцией на cbd.minjust.gov.kg перед подачей.*

### 🧩 Итог
Один конкретный шаг — что сделать сегодня.

═══ ПРАВИЛО БОЛЬШИХ ДОКУМЕНТОВ (СРС, КУРСОВЫЕ, ЭССЕ) ═══
Если пользователь просит написать объемный документ (СРС, реферат, курсовую, текст более 2 страниц), ты КАТЕГОРИЧЕСКИ НЕ ДОЛЖЕН писать весь текст сразу. Это вызовет сбой системы.
Твой алгоритм действий:
1. ШАГ 1 (ПЛАН): Напиши подробный структурированный план работы (Введение, Главы, Заключение).
2. ОСТАНОВКА: После плана ОБЯЗАТЕЛЬНО остановись и спроси: "План готов. Написать Введение и первую главу?". Больше ничего не пиши.
3. ШАГ 2 (ПОШАГОВАЯ ГЕНЕРАЦИЯ): Когда пользователь скажет "да" или "продолжай", посмотри в историю чата, найди свой план, определи, на чем ты остановился, и напиши ТОЛЬКО следующий логический блок (1-2 раздела).
4. ПРОВЕРКА СВЯЗИ: Заканчивай каждый сгенерированный блок вопросом: "Продолжаем со следующей главы [Название Главы]?".
Этот цикл повторяется, пока документ не будет закончен.

═══ РАБОЧИЕ ПРАВИЛА ═══
1. Норм нет в контексте → честно скажи: «В моей базе НПА нет информации по этому вопросу.» Не выдумывай.
2. Право других стран (РФ, Казахстан и др.) — НЕ применимо в КР. Не цитировать без явной оговорки.
3. Язык ответа = язык вопроса (русский / кыргызский). Сроки, суммы, статьи — **жирным**.
4. Не повторяй вопрос в начале ответа. Не хватает данных — спроси конкретно.
5. **ПРИВЕТСТВИЯ:** Здоровайся ТОЛЬКО если пользователь поздоровался в текущем сообщении. Иначе — сразу по сути.
6. **ОБ АВТОРЕ:** Упоминай создателя (Zhanybek Asirov, КНУ им. Жусупа Баласагына) ТОЛЬКО если пользователь прямо спросил «кто тебя создал / твой автор / чей бот». Иначе — ЗАПРЕЩЕНО.
7. **ДИСКЛЕЙМЕР:** Пользователь — практикующий юрист. Не пиши «обратитесь к юристу» — это абсурд. В конце ответа на юридический вопрос — одна строка: *ℹ️ Сверьте номера и редакции статей с cbd.minjust.gov.kg.* Не добавляй в болталке, академических работах и шаблонах документов.

═══ ОБЩЕПРОЦЕДУРНАЯ СПРАВКА (БЕЗ НОМЕРОВ СТАТЕЙ) ═══
Эти факты можно использовать как общие процедурные ориентиры. ВАЖНО: конкретные номера статей бери ИСКЛЮЧИТЕЛЬНО из контекста — никогда не подставляй номера из памяти.

ГРАЖДАНСКИЙ ПРОЦЕСС: подсудность районного суда — до 1 млн сомов; срок рассмотрения — 2 месяца (общий), 1 месяц (упрощённое производство); срок апелляции — 15 дней; срок кассации — 3 месяца.

ТРУДОВЫЕ СПОРЫ: обращение в суд — 3 месяца (общий срок), 1 месяц (оспаривание увольнения); комиссия по трудовым спорам — досудебный этап.

АДМИНИСТРАТИВНЫЕ ДЕЛА: обжалование действий органов — 3 месяца.

ГОСПОШЛИНА: имущественные иски — 1% от суммы, не менее 100 сомов; неимущественные физлиц — 500 сомов; апелляция — 50% от первой инстанции; работники по трудовым спорам освобождены.

ПРЕТЕНЗИОННЫЙ ПОРЯДОК: по потребительским спорам претензия обязательна до суда; типовой срок ответа — 10-14 дней.

${KG_LEGAL_PRINCIPLES_BLOCK}
`.trim();

const ACADEMIC_PROMPT_ADDON = `
═══ АКАДЕМИЧЕСКИЙ РЕЖИМ (СРС, КУРСОВЫЕ, ДИПЛОМЫ) ═══
Пользователь запросил выполнение академической работы. Твоя цель — глубокий научный стиль, строгая юридическая терминология, ссылки на доктрину и анализ судебной практики.

КРИТИЧЕСКОЕ ТЕХНИЧЕСКОЕ ОГРАНИЧЕНИЕ:
Тебе КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО писать всю работу целиком из-за лимита токенов. Ты ОБЯЗАН использовать "ПРАВИЛО БОЛЬШИХ ДОКУМЕНТОВ":
1. Сначала сгенерируй детальный научный план (Введение, 3-4 главы с параграфами, Заключение).
2. Заверши сообщение вопросом: "План готов. Начать писать Введение и первую главу?".
3. Пиши СТРОГО по одному-два параграфа за один ответ. Каждый генерируемый параграф должен быть глубоким и объемным.
4. В конце каждой части спрашивай разрешения на продолжение.
`.trim();

const L4_WARNING_ADDON = `

═══ РЕЖИМ СУДЕБНОГО ДОКУМЕНТА ═══
Пользователь просит составить исковое заявление, апелляционную/кассационную жалобу или иной судебный процессуальный документ.
Пользователь — практикующий юрист. Дай ему рабочую основу, не общие советы.

СТРУКТУРА ОТВЕТА:
1. Полный перечень обязательных реквизитов по ГПК КР (из переданного контекста)
2. Правовое обоснование требований — конкретные нормы из контекста НПА
3. Перечень доказательств и приложений
4. Суд подачи, срок, размер госпошлины
5. Финальная строка: ℹ️ *Сверьте номера статей с актуальной редакцией на cbd.minjust.gov.kg перед подачей.*
`.trim();

// ============================================================
// AGENT MODE PROMPT — IDE редактирование документа (Cursor-style)
// ============================================================
// Этот промпт используется когда фронтенд шлёт agentMode:true.
// Не консультация, не chat — а строго редактирование текущего
// документа с возвратом structured JSON для применения в TipTap.
// ============================================================
const AGENT_SYSTEM_PROMPT = `
Ты — **Мыйзамчи Агент**, профессиональный юрист-драфтер и редактор документов Кыргызской Республики.
Работаешь в IDE-режиме — у пользователя открыт активный документ, и твоя задача — редактировать его правильными юридическими формулировками.

═══ КЛЮЧЕВЫЕ ПРИНЦИПЫ ═══
1. Ты ВИДИШЬ текущий документ пользователя в блоке "ТЕКУЩИЙ ТЕКСТ ДОКУМЕНТА ПОЛЬЗОВАТЕЛЯ" — обязательно прочитай его и используй контекст.
2. Ты редактируешь именно ЭТОТ документ, а не пишешь новый ответ в чат.
3. Если в задаче пользователя упоминается «документ», «текст», «вставь», «добавь», «исправь» — это команда работы С ДОКУМЕНТОМ.
4. Если контекст НПА КР предоставлен — используй точные нормы и цитаты из них.

═══ ФОРМАТ ОТВЕТА — СТРОГО JSON В \`\`\`json БЛОКЕ ═══
ЗАПРЕЩЕНО писать ЛЮБОЙ текст до или после json-блока. Никаких приветствий, никаких рассуждений в свободной форме.
Структура ответа ровно одна:

\`\`\`json
{
  "reasoning": "Кратко (1-2 предложения) что и почему меняешь. Это поле увидит пользователь. При АНАЛИЗЕ — полный ответ здесь.",
  "commands": [
    {"op": "replace", "old_text": "ТОЧНАЯ существующая фраза из документа (посимвольно, со знаками)", "new_text": "новый текст"},
    {"op": "insert_after", "anchor": "ТОЧНАЯ фраза-якорь из документа", "text": "новый абзац"},
    {"op": "insert_end", "text": "текст для добавления в конец"},
    {"op": "comment", "anchor": "ТОЧНАЯ фраза из документа", "text": "Риск: противоречит ст. X ГК КР — ..."},
    {"op": "format", "anchor": "ТОЧНАЯ фраза из документа", "marks": {"bold": true}}
  ]
}
\`\`\`

═══ ГЛАВНОЕ ПРАВИЛО — REPLACE vs COMMENT ═══
- Просят ИЗМЕНИТЬ/ИСПРАВИТЬ/ЗАМЕНИТЬ (сумма, дата, формулировка) → "op":"replace". Меняем текст документа.
- Просят ПРОАНАЛИЗИРОВАТЬ / НАЙТИ РИСКИ или ОШИБКИ / ПРОВЕРИТЬ НА СООТВЕТСТВИЕ норме (режим RAG_AGENT) → НЕ переписывай документ! Вешай "op":"comment" на проблемные фрагменты: text = «Риск: противоречит ст. X ГК КР — пояснение». Текст остаётся нетронутым, юрист видит замечания на полях.
- Нужно ВЫДЕЛИТЬ фрагмент (новую сумму жирным, рискованный пункт) → "op":"format" с marks (bold/italic/underline/highlight/color).

═══ ПРАВИЛА ВЫБОРА КОМАНД (commands) ═══
- replace: old_text — ТОЧНАЯ существующая фраза из документа (скопируй буквально, посимвольно, с теми же знаками/регистром), new_text — на что заменить. НЕ дублируй текст — именно замена.
- insert_after (anchor, ПОСЛЕ которой вставить) / insert_end (в конец) — для НОВЫХ пунктов/абзацев.
- comment: anchor — ТОЧНАЯ фраза из документа, на которую вешается замечание; text — само замечание. Это основной инструмент аудита рисков.
- format: anchor — ТОЧНАЯ фраза; marks — объект стиля, напр. {"bold":true} или {"highlight":"yellow"}.
- old_text и anchor КОПИРУЙ ДОСЛОВНО из ТЕКУЩЕГО документа — иначе фрагмент не найдётся поиском по тексту.
- Можно вернуть НЕСКОЛЬКО команд (например, comment на 3 рискованных пункта сразу).
- При чистом АНАЛИЗЕ без привязки к фрагментам → "commands": [] (пустой массив), весь ответ в reasoning.
- Если документ пуст → используй только "insert_end".

═══ ПРАВИЛА ТЕКСТА (new_text / text) ═══
- Только сам текст, готовый к вставке. Без кавычек, без «Вот предложение:».
- Соблюдай существующую нумерацию пунктов/статей (если в документе есть «1.», «2.» — продолжай правильный номер).
- Юридический стиль: точные формулировки, ссылки на нормы КР, без воды.
- Если ссылаешься на статью НПА — формулируй: «согласно ст. X Закона КР "..."» или «в соответствии с ч. Y ст. X ГК КР».

═══ ИСПОЛЬЗОВАНИЕ КОНТЕКСТА НПА ═══
- Если в промпте есть блок «Контекст — N релевантных статей НПА КР» — это ЕДИНСТВЕННЫЙ источник правовой истины. Используй ТОЛЬКО эти статьи.
- ⭐ КЛЮЧЕВЫЕ статьи — основной источник; 📚 ВСПОМОГАТЕЛЬНЫЕ — как смежные/процедурные нормы.
- Цитируй точно: «согласно ст. X Закона КР "..."» — номер статьи и название НПА бери ИЗ КОНТЕКСТА, не из памяти.
- Если контекста нет — НЕ упоминай конкретных номеров статей. Пиши «согласно действующему законодательству КР» или «в соответствии с соответствующими нормами УК/ГК/ТК КР».

═══ ПРИНЦИПЫ ПРАВА — ПРИМЕНЯЙ ПРИ АНАЛИЗЕ ═══
При выявлении рисков в документе проверяй нарушение принципов:
- Обратная сила закона (улучшающий/ухудшающий) — если документ ссылается на норму, которая изменилась
- Lex specialis — если применяется общая норма, когда есть специальная
- Добросовестность и запрет злоупотребления правом — в договорных условиях
- Соразмерность неустойки — при явно завышенных санкциях
- Соразмерность наказания и презумпция невиновности — в уголовно-правовом контексте
- Non bis in idem — если документ накладывает двойную ответственность за одно деяние
Нарушение принципа → оформляй как "op":"comment" с указанием принципа.

═══ КРИТИЧЕСКОЕ ПРАВИЛО — БЕЗ ГАЛЛЮЦИНАЦИЙ ═══
1. ЗАПРЕЩЕНО выдумывать номера статей, сроки, суммы, даты принятия НПА.
2. ЗАПРЕЩЕНО утверждать о смене редакций кодексов («в 1997 это была ст. X, в 2021 стала ст. Y») если этого нет В КОНТЕКСТЕ выше. Реформа УК КР 2021 г. перенумеровала статьи, но БЕЗ КОНТЕКСТА ты точных соответствий не знаешь.
3. Если автор документа УЖЕ указал номера статей — НЕ оспаривай их без явного подтверждения из контекста. Просто работай с тем что есть.
4. Если в АНАЛИЗЕ упоминаешь конкретные номера — обязательно добавь в reasoning disclaimer:
   "⚠️ Рекомендую сверить номера статей с актуальной редакцией на cbd.minjust.gov.kg."

═══ ПОНИМАНИЕ «КОРЯВЫХ» ИНСТРУКЦИЙ — УМНАЯ ВСТАВКА ═══
Юрист часто формулирует правку небрежно, разговорно, с опечатками или неполно.
Твоя задача — извлечь НАМЕРЕНИЕ, а не понимать команду буквально:
- «поменяй сумму» / «сумма не та» / «тут другая сумма» → "op":"replace": old_text = существующая фраза с этой суммой ДОСЛОВНО, new_text = с новой суммой.
- «дату поправь» / «срок не тот» → "op":"replace": old_text = существующая дата/фраза с ней, new_text = новая.
- «допиши про ответственность» / «нужен пункт о неустойке» → "op":"insert_after" с anchor после релевантного раздела, ПРАВИЛЬНАЯ продолжающаяся нумерация.
- «исправь» без указания что именно → опирайся на ВЫДЕЛЕННЫЙ ФРАГМЕНТ (если он есть в промпте) как на old_text для replace.
- Если значение указано нечётко («поставь нормальную дату», «адекватную сумму») и точное значение НЕ вытекает из документа/контекста — НЕ выдумывай. В reasoning спроси, что подставить, и верни "commands": [].

═══ ЗАПРЕТЫ ═══
1. НИКАКИХ свободных текстов вне json-блока.
2. НИКАКИХ объяснений внутри new_text/text типа «Это статья X, потому что...» — только сам текст для документа.
3. НЕ генерируй полный исковой документ с реквизитами — это L4-запрос, скажи в reasoning что нужно к юристу, верни "commands": [].
4. НЕ повторяй то что уже есть в документе (для изменений используй replace, не insert).
`.trim();

// ============================================================
// DOCUMENT ANALYSIS SYNTHESIZER PROMPT
// Используется в финальном агенте analyze-document pipeline.
// Source-of-truth — ОТЧЁТ ПРОВЕРКИ (verified-by-RAG) который
// собирают параллельные verifier-агенты.
// ============================================================
const JUDGE_SYSTEM_PROMPT = `
Ты — **Мыйзамчы Агент-Судья**. Юридический аналитик системы Мыйзамчы.
Работаешь ИСКЛЮЧИТЕЛЬНО по законодательству **Кыргызской Республики**.

═══ АБСОЛЮТНЫЙ ЗАПРЕТ — ЗАКОНОДАТЕЛЬСТВО ДРУГИХ СТРАН ═══
ЗАПРЕЩЕНО ссылаться на нормы РФ, Казахстана, других стран как применимые в КР.
Только право Кыргызской Республики + ратифицированные КР международные договоры (но только если они в ОТЧЁТЕ).

═══ КАК ТЫ ОБЩАЕШЬСЯ С ПОЛЬЗОВАТЕЛЕМ — БЕЗ «ВНУТРЕННЕЙ КУХНИ» ═══
Для пользователя ты — живой старший юрист, который ЛИЧНО изучил документ и
провёл правовую экспертизу. Пользователь не знает и не должен знать, что
внутри работают алгоритмы, векторная база и несколько ИИ-агентов.

Слова «ОТЧЁТ», «ОТЧЁТ ВЕРИФИКАЦИИ» ниже — служебные. В ответе пользователю
употреблять их ЗАПРЕЩЕНО. Также ЗАПРЕЩЕНЫ в ответе:
  • «Pinecone», «база данных», «индекс», «RAG», «эмбеддинг», «вектор», «топ-K»
  • «отчёт», «согласно отчёту», «по отчёту», «в отчёте помечено»
  • «система», «у системы возникли сомнения», «система не нашла / пометила»
  • «verified / mismatch / not_found», теги-статусы в квадратных скобках ([risk] и т.п.)
  • любые упоминания, что текст проверял алгоритм, ИИ или автоматика

Пиши как юрист — о результате СВОЕЙ работы. Замены:
  ✗ «Согласно отчёту, в базе НПА статья закреплена в ст. 57»
  ✓ «При правовой экспертизе установлено: принцип закреплён в ст. 57 Конституции КР»
  ✗ «помечены в отчёте как "НОМЕР НЕ СОВПАЛ"»
  ✓ «в ходе изучения материалов выявлено расхождение в нумерации»
  ✗ «у системы возникли сомнения в совпадении номеров частей»
  ✓ «имеются расхождения в нумерации частей, требующие дополнительной сверки»
  ✗ «не были предметом проверки по базе национальных НПА»
  ✓ «оцениваются отдельно — как нормы ратифицированных КР международных договоров»
  ✗ «структура статей в базе Pinecone не соответствует заявленной»
  ✓ «структура указанных статей расходится с действующей редакцией»

═══ АБСОЛЮТНОЕ ПРАВИЛО — ЕДИНСТВЕННЫЙ ИСТОЧНИК ИСТИНЫ ═══
ВСЕ номера статей в твоём ответе ДОЛЖНЫ быть взяты из «ОТЧЁТА ВЕРИФИКАЦИИ» —
результата правовой сверки каждой статьи с официальной базой НПА КР.
Твоя собственная память о юр.кодексах НЕ ИСТОЧНИК. Память может содержать устаревшие или неверные данные.
ЕСЛИ номера НЕТ в ОТЧЁТЕ — ты его НЕ ЗНАЕШЬ и не можешь упоминать.

═══ ЛОГИКА ПО КАТЕГОРИЯМ ОТЧЁТА ═══

▸ Статья ✅ verified
   → Можешь свободно ссылаться на её номер из ОТЧЁТА.
   → Формат: «согласно ст. X [НПА из ОТЧЁТА]…»
   → Цитируй оригинал из ragText (приведённый в ОТЧЁТЕ).

▸ Статья ⚠️ mismatch (номер не совпал, ближайшее в базе — другой номер)
   → Упомяни ОБА номера в формате: «в документе указана ст. X, в базе ближайшее совпадение — ст. Y (suggestedArticle)».
   → Номер Y бери ДОСЛОВНО из ОТЧЁТА (поле suggestedArticle). НЕ изобретай.

▸ Статья ❌ not_found
   → Упомяни номер из документа пользователя.
   → НИКОГДА не предлагай «правильный» номер из памяти.
   → Формулировка: «не подтверждена базой НПА, рекомендую сверить с cbd.minjust.gov.kg».

═══ КОНКРЕТНЫЕ ПРИМЕРЫ ГАЛЛЮЦИНАЦИЙ (НЕ ДЕЛАТЬ) ═══

❌ ЗАПРЕЩЕНО: «В действующем УК КР пытки квалифицируются по ст. 422»
   (если ст. 422 не в ОТЧЁТЕ — выдумка из памяти).

❌ ЗАПРЕЩЕНО: «Данная норма закреплена в ст. 57 Конституции КР»
   (если ст. 57 не в ОТЧЁТЕ).

❌ ЗАПРЕЩЕНО: «Согласно ст. 76 действующего УК КР сроки давности…»
   (если ст. 76 не в ОТЧЁТЕ).

❌ ЗАПРЕЩЕНО: «Усильте позицию ссылкой на ст. 46 УПК КР»
   (если ст. 46 УПК не в ОТЧЁТЕ).

❌ ЗАПРЕЩЕНО: «В редакции 2021 года это статья X»
   (если X не помечен ⚠️ mismatch в ОТЧЁТЕ для этой статьи).

❌ ЗАПРЕЩЕНО: «Согласно ст. X УК РФ» — нормы РФ не применяются в КР.

✅ РАЗРЕШЕНО: «согласно соответствующим нормам УК КР о пытках»
✅ РАЗРЕШЕНО: «согласно действующему уголовному законодательству КР»
✅ РАЗРЕШЕНО: «Рекомендую сверить актуальные номера статей с cbd.minjust.gov.kg»

═══ ПРАВИЛО ОТКАЗА ОТ «УЛУЧШЕНИЙ» ═══
Если в ОТЧЁТЕ много ❌ — эти нормы не подтвердились при сверке с базой НПА КР.
Возможные причины: устаревшая редакция, международные источники (Конвенция ООН, МПГПП — их нет в базе НПА КР), или специфический раздел.
В ЛЮБОМ случае — НЕ предлагай свою память как замену. Просто отметь отсутствие подтверждения.

═══ САМОПРОВЕРКА ПЕРЕД ОТПРАВКОЙ ═══
Перед финальным ответом мысленно пройдись по каждому упомянутому номеру статьи:
  • Есть ли он буквально в ОТЧЁТЕ?
  • Если нет — УБЕРИ номер, замени общей формулировкой.

═══ ФОРМАТ ОТВЕТА (markdown) ═══
Точную структуру разделов задаёт сообщение пользователя. Общий каркас:

1. **Краткий вывод** — 2-3 предложения о документе в целом.

2. **Замечания по пунктам** — разбор спорных и нарушающих пунктов. Заголовок
   КАЖДОГО пункта начинай с цветного маркера-кружка (БЕЗ слов-статусов в скобках):
     🔴 — нарушение: норма прямо нарушена
     🟡 — риск: формулировка спорна, неточна или требует доработки
     🔵 — требует сверки: расхождение в нумерации либо неясность
   Пример заголовка: «🔴 Пункт 4.4 — Нарушение принципа презумпции невиновности».
   Под заголовком: цитата → суть проблемы → ст. КР (только из ОТЧЁТА) → рекомендация.
   ЗАПРЕЩЕНО писать статус словами в квадратных скобках: ни [risk], ни
   [violation], ни «[Требуют сверки]» — только цветной кружок в начале заголовка.

3. **Подтверждённые ссылки на статьи** — корректные ссылки (если есть).

4. **Общие рекомендации** — что доработать перед использованием документа.

═══ ДЛИНА ═══
Соразмерно объёму документа. Без воды, конкретно по делу.
`.trim();

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================================

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ── РЕЗИЛЬЕНТНАЯ ГЕНЕРАЦИЯ ─────────────────────────────────────────
// Универсальный helper с обработкой 503/429/404 и общего сетевого 5xx.
// Делает до 4 попыток с экспоненциальным backoff + jitter, ротирует ключи,
// и при последней попытке переключается на стабильную модель-фолбэк.
//
// История версионирования модели (важно для разборок при 404/деградации):
// • 2026-05-21: переключились на 'gemini-3.1-flash' по подсказке Gemini-чата —
//   ОКАЗАЛОСЬ что такой модели НЕ СУЩЕСТВУЕТ. Чат выдумал имя. 404 → ретраи.
// • 2026-05-21 (вечер): 'gemini-3-flash-preview' — реальная модель, но это
//   PREVIEW release: урезанный compute-пул, под параллельной нагрузкой
//   Deep Analysis (30+ запросов разом) массово отдавала 503 → анализ 2-5 мин.
// • 2026-05-22: перешли на 'gemini-2.5-flash' — STABLE prod-версия с полным
//   пулом реплик. 503 практически нет даже под параллельной нагрузкой.
//   Цена $0.30/$2.50 — даже дешевле preview ($0.50/$3.00).
//   Источник цен: https://ai.google.dev/gemini-api/docs/pricing
//
// Валидные Flash-модели на 2026-05 (проверено по официальной доке Google):
//   gemini-3.5-flash         (premium, $1.50/$9.00)  — newest stable, дорогой
//   gemini-3-flash-preview   (preview, $0.50/$3.00)  — нестабилен под нагрузкой
//   gemini-2.5-flash         (SENIOR,  $0.30/$2.50)  — наш PRIMARY (stable)
//   gemini-2.5-flash-lite    (FALLBACK,$0.10/$0.40)  — лёгкий стабильный fallback
//   gemini-3.1-flash-lite    (WORKER,  $0.25/$1.50)  — массовая обработка
//   gemini-2.0-flash         (legacy,  $0.10/$0.40)  — DEPRECATED с 2026-06-01
const PRIMARY_MODEL  = 'gemini-3.1-flash-lite';
const FALLBACK_MODEL = 'gemini-2.5-flash';

// ── DEEPSEEK V4 (JUDGE tier — reasoning синтез) ───────────────────────
// DeepSeek V4 Pro используется в роли "судьи" — финального синтеза, где
// нужно связать выводы нескольких worker-агентов и выдать reasoning-based
// вердикт. Reasoning_effort='high' (не 'max') чтобы не платить за избыточную
// цепочку мысли — оставляем юристу глубокий разбор, но без 30-сек ожидания.
//
// Если DEEPSEEK_API_KEY не задан в env — все judge-вызовы автоматически
// падают на Gemini 3-flash-preview (SENIOR tier) без прерывания работы.
const DEEPSEEK_ENABLED = !!process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_MODEL = 'deepseek-v4-pro';
// Note: при недоступности DeepSeek fallback идёт через generateContentResilient,
// которая использует PRIMARY_MODEL (текущий gemini-3.1-flash, SENIOR tier).

if (!DEEPSEEK_ENABLED) {
    console.warn('[SECURITY] DEEPSEEK_API_KEY не задан → Judge-вызовы упадут на Gemini SENIOR. Поставьте ключ в Render для активации DeepSeek-Judge.');
}

const deepseekClient = DEEPSEEK_ENABLED
    ? new OpenAI({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: 'https://api.deepseek.com'
    })
    : null;

// Извлекает usage из DeepSeek-ответа и эмитит token-telemetry SSE.
// DeepSeek (OpenAI-compatible) возвращает usage в формате:
//   { prompt_tokens, completion_tokens, prompt_cache_hit_tokens,
//     prompt_cache_miss_tokens, completion_tokens_details: { reasoning_tokens } }
function emitDeepseekTelemetry(usage, model, fallbackLabel) {
    if (!usage) return;
    const inputTokens  = usage.prompt_tokens     || 0;
    const outputTokens = usage.completion_tokens || 0;
    const cachedInput  = usage.prompt_cache_hit_tokens || 0;
    const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens || 0;
    if (!inputTokens && !outputTokens) return;
    const ctx = requestTelemetry.getStore();
    sendTelemetry({
        label: (ctx && ctx.label) || fallbackLabel || 'judge',
        model,
        inputTokens,
        outputTokens,
        cachedInput,
        reasoningTokens, // для отображения но не в total (уже в output)
        totalTokens: inputTokens + outputTokens,
        cost: calculateCost(model, inputTokens, outputTokens, cachedInput)
    });
}

// Non-streaming вызов DeepSeek с retry + fallback на Gemini-SENIOR.
// Если DEEPSEEK_API_KEY не задан — сразу идёт в Gemini-fallback.
async function deepseekCall({ systemInstruction, userPrompt, maxRetries = 2, temperature = 0.3 }) {
    if (!DEEPSEEK_ENABLED) {
        // Прозрачный fallback на Gemini SENIOR, если DeepSeek не настроен
        console.log('[Judge] DeepSeek disabled → fallback to Gemini SENIOR');
        return generateContentResilient({
            systemInstruction,
            userPrompt,
            generationConfig: { temperature, topP: 0.85, maxOutputTokens: 2048 },
            maxRetries: 3
        });
    }
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            // OpenAI Node SDK пропускает неизвестные поля в request body —
            // reasoning_effort / thinking реально доходят до DeepSeek API.
            const result = await deepseekClient.chat.completions.create({
                model: DEEPSEEK_MODEL,
                messages: [
                    { role: 'system', content: systemInstruction },
                    { role: 'user',   content: userPrompt }
                ],
                temperature,
                reasoning_effort: 'high',           // не 'max' — экономим на reasoning токенах
                thinking: { type: 'enabled' }       // V4 Pro: явно включаем reasoning
            });
            const text = result?.choices?.[0]?.message?.content || '';
            try { emitDeepseekTelemetry(result?.usage, DEEPSEEK_MODEL, 'judge'); } catch (e) {}
            if (attempt > 0) console.log(`[Judge] DeepSeek recovered on attempt ${attempt + 1}`);
            return text;
        } catch (err) {
            serverStats.apiErrors++;
            const kind = classifyError(err);
            console.warn(`[Judge] DeepSeek attempt ${attempt + 1}/${maxRetries + 1} → ${kind}: ${err.message?.slice(0, 100)}`);
            if (attempt < maxRetries) {
                const wait = Math.min(4000, 800 * Math.pow(2, attempt)) + Math.floor(Math.random() * 600);
                await delay(wait);
            }
        }
    }
    // Все попытки DeepSeek провалились → fallback на Gemini SENIOR
    console.warn('[Judge] DeepSeek exhausted, falling back to Gemini SENIOR');
    return generateContentResilient({
        systemInstruction,
        userPrompt,
        generationConfig: { temperature, topP: 0.85, maxOutputTokens: 2048 },
        maxRetries: 2
    });
}

// ── DeepSeek JSON-call для агентов (Шаг 2 ТЗ: Map-Reduce верификаторы) ──
// Non-streaming вызов DeepSeek V4 Flash, возвращает СЫРОЙ JSON-текст ответа.
// Реализует жёсткую границу retry/fallback:
//   • 429 → ждёт Retry-After (если есть) или exp-backoff с джиттером, ретрай
//   • 5xx → exp-backoff, ретрай
//   • 4xx (кроме 429) → не ретраит, пробрасывает
//   • После maxRetries попыток → пробрасывает последнюю ошибку
//     (вызывающий код в routes/analyze.js делает fallback на Gemini callOnce)
//
// response_format: { type: 'json_object' } — DeepSeek гарантирует валидный JSON.
// user_id — изоляция KVCache между потоками (98% скидка на input-токены при повторе
// одинакового системного промпта в разных запросах одной сессии агентов).
async function deepseekJsonCall({
    systemPrompt,
    userPrompt,
    userId = 'miyzamchi-agent-default',
    model = 'deepseek-v4-flash',
    temperature = 0.2,
    maxTokens = 1024,          // ВАЖНО: 512 было мало — упирался посреди rationale-строки
                               // → невалидный JSON → 20% агентов теряли ответ.
                               // 1024 хватает для status+confidence+finding+rationale+suggestion.
    reasoningEffort = null,    // 'high' | 'max' | null — для агентов null (быстрее)
    label = 'agent',
    maxRetries = 2             // итого 3 попытки (попытка 0 + 2 ретрая)
}) {
    if (!DEEPSEEK_ENABLED) {
        throw new Error('DEEPSEEK_DISABLED');
    }
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const requestBody = {
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user',   content: userPrompt }
                ],
                temperature,
                max_tokens: maxTokens,
                response_format: { type: 'json_object' },
                user: userId,
                user_id: userId,
                stream: false
            };
            if (reasoningEffort) {
                requestBody.reasoning_effort = reasoningEffort;
            }
            const result = await deepseekClient.chat.completions.create(requestBody);
            const content = result?.choices?.[0]?.message?.content || '';
            try { emitDeepseekTelemetry(result?.usage, model, label); } catch (e) {}
            if (attempt > 0) {
                console.log(`[DeepSeek ${label}] recovered on attempt ${attempt + 1} (model=${model})`);
            }
            return content;
        } catch (err) {
            lastErr = err;
            const status = err?.status || err?.response?.status || 0;
            const retryAfterHeader =
                err?.response?.headers?.['retry-after'] ||
                err?.headers?.['retry-after'] ||
                err?.response?.headers?.get?.('retry-after');

            // 4xx (кроме 429) — не ретраим, сразу пробрасываем
            if (status >= 400 && status < 500 && status !== 429) {
                console.error(`[DeepSeek ${label}] non-retriable ${status}: ${err.message?.slice(0, 120)}`);
                throw err;
            }
            if (attempt >= maxRetries) break;   // больше не ретраим

            let delayMs;
            if (status === 429 && retryAfterHeader) {
                delayMs = Math.min(parseInt(retryAfterHeader, 10) * 1000, 10000);
            } else {
                // exp-backoff с джиттером: 2^attempt сек + 0-1 сек случайного
                delayMs = Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 1000);
                delayMs = Math.min(delayMs, 8000);
            }
            console.warn(`[DeepSeek ${label}] ${status || 'net'} attempt ${attempt + 1}/${maxRetries + 1} → wait ${delayMs}ms`);
            await delay(delayMs);
        }
    }
    throw lastErr || new Error('DeepSeek exhausted retries');
}

// Streaming вызов DeepSeek с SSE-пайпом в res. Если до первого чанка
// произошёл сбой — прозрачный fallback на Gemini-стрим. Если ошибка после
// — лог + сообщение пользователю.
// reasoning_content стримим в server-лог (не в UI) — чтобы видеть глубину
// рассуждения но не грузить UX. UI получает только финальный content.
async function streamDeepSeekResponse(systemInstruction, userPrompt, res, opts = {}) {
    // reasoning_effort: 'high' по умолчанию — для глубоких анализов документа.
    // Compare-режим может передать 'medium' (быстрее на 30-50%, точности достаточно).
    // Поддержка model + user_id (для KVCache-изоляции по сессиям/типам Judge):
    //   • model    — позволяет переключить между deepseek-v4-pro и deepseek-v4-flash
    //                (Dynamic Compute Routing в analyze.js: лёгкий путь → Flash, тяжёлый → Pro).
    //   • user_id  — изолирует контекстный кэш DeepSeek между потоками
    //                (judge-fast vs judge-deep не должны перемешиваться → 98% cache hit).
    //   • label    — для телеметрии (judge-fast / judge-deep / etc).
    const {
        temperature = 0.2,
        reasoning_effort = 'high',
        model = DEEPSEEK_MODEL,
        user_id = null,
        label = 'judge-stream',
        // 2026-06-12: thinking настраиваемый. Дефолт прежний ('enabled') — чтобы
        // не менять поведение других вызовов (compare.js). Final Judge передаёт
        // {type:'disabled'}: без цепочки мыслей первый токен уходит мгновенно,
        // и SSE-стрим виден пользователю сразу (раньше DeepSeek молча генерил
        // reasoning_content, а текст «вываливался» в конце почти разом).
        thinking = { type: 'enabled' }
    } = opts;
    if (!DEEPSEEK_ENABLED) {
        console.log('[Judge:stream] DeepSeek disabled → Gemini fallback');
        await streamGeminiResponse(getNextKey(), systemInstruction, userPrompt, [], res, {
            temperature, topP: 0.85, maxOutputTokens: 4096
        });
        return;
    }
    let firstChunkSent = false;
    let reasoningBuf = '';
    try {
        const requestBody = {
            model,
            messages: [
                { role: 'system', content: systemInstruction },
                { role: 'user',   content: userPrompt }
            ],
            temperature,
            reasoning_effort,
            thinking,
            stream: true,
            stream_options: { include_usage: true }
        };
        // OpenAI SDK пропускает неизвестные поля в request body — оба варианта
        // имени поля (user/user_id) доходят до DeepSeek API. Дублируем для совместимости.
        if (user_id) {
            requestBody.user = user_id;
            requestBody.user_id = user_id;
        }
        const stream = await deepseekClient.chat.completions.create(requestBody);
        let lastUsage = null;
        for await (const chunk of stream) {
            const delta = chunk?.choices?.[0]?.delta || {};
            // reasoning_content — служебный канал, в UI не выводим, копим в лог
            if (delta.reasoning_content) {
                reasoningBuf += delta.reasoning_content;
            }
            if (delta.content) {
                firstChunkSent = true;
                if (!res.writableEnded) {
                    res.write(`data: ${JSON.stringify({ text: delta.content })}\n\n`);
                    // Анти-буферизация: res.flush() есть только под compression — guard
                    if (typeof res.flush === 'function') { try { res.flush(); } catch (_) {} }
                }
            }
            if (chunk?.usage) lastUsage = chunk.usage;
        }
        if (reasoningBuf) {
            console.log(`[Judge:reasoning] ${reasoningBuf.length}ch (model=${model})`);
        }
        try { emitDeepseekTelemetry(lastUsage, model, label); } catch (e) {}
    } catch (err) {
        serverStats.apiErrors++;
        if (firstChunkSent) {
            // Стрим уже начат — нельзя переключиться, просто пишем ошибку в поток
            console.error('[Judge:stream] mid-stream error:', err.message);
            if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify({ text: '\n\n⚠️ Ошибка в потоке генерации. Часть ответа выше.' })}\n\n`);
            }
        } else {
            // До первого чанка — прозрачный fallback на Gemini
            console.warn(`[Judge:stream] DeepSeek failed before first chunk → Gemini fallback: ${err.message?.slice(0, 100)}`);
            try {
                await streamGeminiResponse(getNextKey(), systemInstruction, userPrompt, [], res, {
                    temperature, topP: 0.85, maxOutputTokens: 4096
                });
            } catch (e2) {
                console.error('[Judge:stream] Gemini fallback also failed:', e2.message);
                if (!res.writableEnded) {
                    res.write(`data: ${JSON.stringify({ text: '\n\n⚠️ Серверы AI временно перегружены. Повторите запрос через минуту.' })}\n\n`);
                }
            }
        }
    }
}

// ── TOKEN TELEMETRY ─────────────────────────────────────────────────
// Прайс-лист за 1 миллион токенов (Input/Output, USD).
// Источники: prompt+input cache → input; candidates (output) → output.
// inputCache (опционально) — ставка при попадании в кэш промпта (DeepSeek);
// если undefined, считаем что cache hit = обычный input rate.
//
// Курс пересчёта ¥ → $ зафиксирован константой ниже (по состоянию на 2026-05-21):
//   ¥1 ≈ $0.14 USD. Если курс существенно сдвинется — пересчитать DeepSeek-цены.
const CNY_TO_USD = 0.14;

const MODEL_PRICING = {
    // ═══ GOOGLE GEMINI (USD per 1M tokens, проверено по официальной доке 2026-05-21) ═══
    // Источник: https://ai.google.dev/gemini-api/docs/pricing
    // Также добавлены cache rates (context caching) — DeepSeek-style cache hit.

    // PREMIUM tier — newest stable, дорогой, для критических задач
    'gemini-3.5-flash':       { input: 1.50,  output: 9.00, inputCache: 0.15,  tier: 'premium'  },

    // SENIOR tier — наш PRIMARY (Gemini 3 Flash Preview)
    'gemini-3-flash-preview': { input: 0.50,  output: 3.00, inputCache: 0.05,  tier: 'senior' },

    // FALLBACK tier — проверенный prod-stable
    'gemini-2.5-flash':       { input: 0.30,  output: 2.50, inputCache: 0.03,  tier: 'fallback' },
    'gemini-2.5-flash-lite':  { input: 0.10,  output: 0.40, inputCache: 0.025, tier: 'fallback' },

    // WORKER tier — массовая обработка / парсеры / JSON-extract
    'gemini-3.1-flash-lite':  { input: 0.25,  output: 1.50, inputCache: 0.025, tier: 'worker' },

    // LEGACY — deprecated с 2026-06-01, не использовать в новом коде
    'gemini-2.0-flash':       { input: 0.10,  output: 0.40, inputCache: 0.025, tier: 'legacy' },

    // Aliases — точная цена неизвестна, считаем как самый дорогой возможный вариант
    // чтобы виджет не недосчитывал. Google hot-swap'ит эти alias'ы.
    'gemini-flash-latest':    { input: 1.50,  output: 9.00, inputCache: 0.15,  tier: 'alias' },

    // ═══ DEEPSEEK V4 (CNY → USD, courses fixed via CNY_TO_USD const above) ═══
    // JUDGE tier — reasoning-модель для финального синтеза. reasoning_effort='high'
    // (не max) чтобы не платить за избыточную цепочку мысли.
    // V4 Pro: ¥3/¥6 miss + ¥0.025 cache hit (input)
    'deepseek-v4-pro':   {
        input:      Number((3.00  * CNY_TO_USD).toFixed(4)),  // ≈ $0.42
        output:     Number((6.00  * CNY_TO_USD).toFixed(4)),  // ≈ $0.84
        inputCache: Number((0.025 * CNY_TO_USD).toFixed(6)),  // ≈ $0.0035
        tier: 'judge'
    },
    // V4 Flash: ¥1/¥2 miss + ¥0.02 cache hit — альтернатива worker tier,
    // если кэширование выгоднее чем Gemini.
    'deepseek-v4-flash': {
        input:      Number((1.00  * CNY_TO_USD).toFixed(4)),  // ≈ $0.14
        output:     Number((2.00  * CNY_TO_USD).toFixed(4)),  // ≈ $0.28
        inputCache: Number((0.02  * CNY_TO_USD).toFixed(6)),  // ≈ $0.0028
        tier: 'worker'
    },

    // ═══ EMBEDDINGS ═══
    'gemini-embedding-001':   { input: 0.0001, output: 0, tier: 'embedding' }
};

// inputCacheTokens — для DeepSeek: количество токенов попавших в кэш промпта
// (prompt_cache_hit_tokens из OpenAI-style response). У Gemini эта концепция
// другая (implicit caching, не возвращается per-request) — оставляем 0.
function calculateCost(modelName, inputTokens = 0, outputTokens = 0, inputCacheTokens = 0) {
    const key = String(modelName || '').replace(/^models\//, '');
    const rates = MODEL_PRICING[key];
    if (!rates) return 0;
    const cacheHit  = Math.min(inputCacheTokens, inputTokens);
    const cacheMiss = Math.max(0, inputTokens - cacheHit);
    const cacheRate = (typeof rates.inputCache === 'number') ? rates.inputCache : rates.input;
    const inCost  = (cacheMiss / 1_000_000) * rates.input + (cacheHit / 1_000_000) * cacheRate;
    const outCost = (outputTokens / 1_000_000) * rates.output;
    return Number((inCost + outCost).toFixed(6));
}

// Per-request телеметрия через AsyncLocalStorage. Каждый route-handler
// оборачивает свою работу в requestTelemetry.run({ res, label }, ...), и
// дальше любой helper (generateContentResilient / streamGeminiResponse)
// может прочитать текущий res и эмитнуть SSE-чанк без явного проброса
// через все слои промежуточных функций.
const requestTelemetry = new AsyncLocalStorage();

function sendTelemetry(payload) {
    const ctx = requestTelemetry.getStore();
    const res = ctx && ctx.res;
    if (!res || res.writableEnded) return;
    try {
        res.write(`data: ${JSON.stringify({ telemetry: payload })}\n\n`);
    } catch (e) {}
}

// Удобный wrapper для тегирования телеметрии конкретным шагом ("audit:redFlags").
// Если контекст уже есть — оборачиваем заново только label, res остаётся.
function withTelemetryLabel(label, fn) {
    const ctx = requestTelemetry.getStore() || {};
    return requestTelemetry.run({ ...ctx, label }, fn);
}

function classifyError(err) {
    const msg = String(err?.message || err || '');
    const lower = msg.toLowerCase();
    // 404 — модель не найдена. Если retry'ить — будет вечный цикл, fallback бесполезен.
    // Логируем явно, чтобы было видно "PRIMARY_MODEL не существует в API".
    if (msg.includes('404') || lower.includes('not found') || lower.includes('is not supported')) return '404';
    if (msg.includes('503') || lower.includes('high demand') || lower.includes('overload') || lower.includes('unavailable')) return '503';
    if (msg.includes('429') || lower.includes('rate limit') || lower.includes('quota') || lower.includes('exceeded')) return '429';
    if (msg.includes('500') || msg.includes('502') || msg.includes('504')) return '5xx';
    return 'other';
}

async function generateContentResilient({ systemInstruction, userPrompt, generationConfig = null, maxRetries = 3 }) {
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const apiKey = getNextKey();
        // Последняя попытка — переключаемся на стабильную модель-фолбэк,
        // т.к. *-latest alias чаще получает 503 на пиках.
        const useModel = (attempt === maxRetries) ? FALLBACK_MODEL : PRIMARY_MODEL;
        try {
            const genAI = new GoogleGenerativeAI(apiKey);
            const modelOpts = { model: useModel, systemInstruction };
            if (generationConfig) modelOpts.generationConfig = generationConfig;
            const model = genAI.getGenerativeModel(modelOpts);
            const result = await model.generateContent(userPrompt);
            if (attempt > 0) console.log(`[resilient] recovered on attempt ${attempt + 1} (model=${useModel})`);

            // Token-telemetry: тянем usageMetadata и эмитим SSE-чанк
            // (только если route-handler обернул запрос в requestTelemetry.run).
            try {
                const usage = result.response?.usageMetadata || {};
                const inputTokens  = usage.promptTokenCount     || 0;
                const outputTokens = usage.candidatesTokenCount || 0;
                if (inputTokens || outputTokens) {
                    const ctx = requestTelemetry.getStore();
                    sendTelemetry({
                        label: (ctx && ctx.label) || 'llm-call',
                        model: useModel,
                        inputTokens,
                        outputTokens,
                        totalTokens: usage.totalTokenCount || (inputTokens + outputTokens),
                        cost: calculateCost(useModel, inputTokens, outputTokens)
                    });
                }
            } catch (e) {}

            return result.response.text();
        } catch (err) {
            lastErr = err;
            const kind = classifyError(err);
            // 429 — ключ исчерпан, блокируем его на короткое окно
            // 503 / 5xx — Google-side issue, ключ не виноват — НЕ блокируем
            if (kind === '429') blockKey(apiKey);
            // 404 — модель не существует в API. Ретраи бесполезны, идём СРАЗУ на
            // FALLBACK_MODEL (пропускаем все попытки с primary). Помогает быстро
            // диагностировать ситуации типа гипотетического gemini-3.1-flash.
            if (kind === '404') {
                console.error(`[resilient] 404: model ${useModel} not found in API. Jumping to FALLBACK_MODEL=${FALLBACK_MODEL}.`);
                attempt = maxRetries - 1; // следующая итерация попадёт в attempt===maxRetries → fallback
            }
            serverStats.apiErrors++;
            if (attempt < maxRetries) {
                // Exponential backoff: 800ms, 1.6s, 3.2s + jitter 0-800ms
                // Разные jitter'ы у параллельных вызовов разводят синхронную волну.
                const base = 800 * Math.pow(2, attempt);
                const jitter = Math.floor(Math.random() * 800);
                const wait = Math.min(8000, base) + jitter;
                console.warn(`[resilient] attempt ${attempt + 1}/${maxRetries + 1} → ${kind} | wait ${wait}ms | next model=${attempt + 1 === maxRetries ? FALLBACK_MODEL : PRIMARY_MODEL}`);
                await delay(wait);
            }
        }
    }
    throw lastErr;
}

// Совместимость: callOnce — теперь просто обёртка над resilient-хелпером.
// Старая сигнатура `(apiKey, systemPrompt, userPrompt, retryCount)` сохранена,
// но apiKey/retryCount игнорируются — helper сам ротирует ключи.
async function callOnce(_apiKey, systemPrompt, userPrompt, _retryCount = 0) {
    return generateContentResilient({
        systemInstruction: systemPrompt,
        userPrompt,
        maxRetries: 3
    });
}

async function streamGeminiResponse(apiKey, systemPrompt, userPrompt, history, res, generationConfig = null) {
    // PRIMARY_MODEL — не gemini-flash-latest, потому что alias — experimental и
    // Google может в любой момент перенаправить его на любую модель
    // (включая дорогой gemini-3.5-flash). Используем точную stable-версию.
    const useModel = PRIMARY_MODEL;
    const genAI = new GoogleGenerativeAI(apiKey);
    const modelOpts = {
        model: useModel,
        systemInstruction: systemPrompt
    };
    if (generationConfig) modelOpts.generationConfig = generationConfig;
    const model = genAI.getGenerativeModel(modelOpts);
    const chat = model.startChat({ history: history || [] });
    const t_start = performance.now();
    let t_first_token = null;
    let generatedChars = 0;

    const result = await chat.sendMessageStream(userPrompt);
    for await (const chunk of result.stream) {
        if (!t_first_token) t_first_token = performance.now();
        const chunkText = chunk.text();
        if (chunkText) {
            generatedChars += chunkText.length;
            res.write(`data: ${JSON.stringify({ text: chunkText })}\n\n`);
        }
    }
    
    const t_end = performance.now();
    if (!t_first_token) t_first_token = t_end;
    res._xray = {
        ttft: t_first_token - t_start,
        gen: t_end - t_first_token,
        chars: generatedChars
    };
    // После завершения стрима в result.response доступен агрегированный usageMetadata.
    try {
        const finalResponse = await result.response;
        const usage = finalResponse?.usageMetadata || {};
        const inputTokens  = usage.promptTokenCount     || 0;
        const outputTokens = usage.candidatesTokenCount || 0;
        if (inputTokens || outputTokens) {
            const ctx = requestTelemetry.getStore();
            sendTelemetry({
                label: (ctx && ctx.label) || 'stream-call',
                model: useModel,
                inputTokens,
                outputTokens,
                totalTokens: usage.totalTokenCount || (inputTokens + outputTokens),
                cost: calculateCost(useModel, inputTokens, outputTokens)
            });
        }
    } catch (e) {}
}

function sanitizeHistory(history) {
    if (!Array.isArray(history)) return [];

    let clean = history
        .filter(msg => msg?.role && msg?.parts?.[0]?.text?.trim())
        .map(msg => ({ role: msg.role, parts: [{ text: msg.parts[0].text }] }));

    clean = clean.slice(-10);

    while (clean.length > 0 && clean[0].role !== 'user') {
        clean.shift();
    }

    return clean;
}

// --- Форматирование контекста: НПА и Инструкции в отдельных секциях ---
function formatContextWithHierarchy(core, context) {
    const all = [...core, ...context];
    if (all.length === 0) return '';

    const npaItems = all.filter(m => !isMatchFaq(m));
    const faqItems = all.filter(m =>  isMatchFaq(m));

    const fmtNpa = (m, i) => {
        const md = m.metadata || {};
        const tier = (m.score || 0) >= 0.70 ? '⭐ КЛЮЧЕВАЯ' : '📚 ВСПОМОГАТЕЛЬНАЯ';
        return `[${tier} — ${md.npa_title} | ${md.article_title}]\nДокумент: ${md.npa_title}\nСтатья: ${md.article_title}\nТекст: ${md.full_text}`;
    };

    const fmtFaq = (m, i) => {
        const md = m.metadata || {};
        // Срезаем служебные строки "Документ\n" и "Категория: ...\n"
        const cleanText = (md.full_text || '')
            .replace(/^Документ\s*\n?/i, '')
            .replace(/^Категория:[^\n]*\n?/im, '')
            .trim();
        return `[📋 ИНСТРУКЦИЯ — ${md.article_title || 'Процедура'}]\nТекст: ${cleanText}`;
    };

    const parts = [];
    if (npaItems.length > 0) {
        parts.push('══ НОРМАТИВНЫЕ ПРАВОВЫЕ АКТЫ КР ══\n\n' + npaItems.map(fmtNpa).join('\n\n---\n\n'));
    }
    if (faqItems.length > 0) {
        parts.push('══ ОФИЦИАЛЬНЫЕ ИНСТРУКЦИИ И ПРОЦЕДУРЫ ══\n\n' + faqItems.map(fmtFaq).join('\n\n---\n\n'));
    }

    return parts.join('\n\n════════════════════\n\n');
}

// ============================================================
// РЕЖИМ FAST
// ============================================================
async function handleFast(message, history, retrievalResult, res, retryCount = 0) {
    const { core, context } = retrievalResult || { core: [], context: [] };
    const hasContext = core.length > 0 || context.length > 0;
    
    const contextText = hasContext ? formatContextWithHierarchy(core, context) : '';
    const promptText = contextText
        ? `Релевантный контекст законов:\n${contextText}\n\nВопрос пользователя: ${message}`
        : `Сообщение пользователя: ${message}`;

    const cleanHistory = sanitizeHistory(history);
    const currentKey = getNextKey();

    const isL4 = detectL4Request(message);
    const activeSystemInstruction = isL4
        ? systemInstruction + '\n\n' + L4_WARNING_ADDON
        : systemInstruction;

    if (isL4) console.log('[FAST MODE] 🛡️ L4-запрос (судебный документ) — активирован режим отказа от генерации');

    const t_start = performance.now();
    let t_first_token = null;
    let generatedChars = 0;
    
    try {
        const genAI = new GoogleGenerativeAI(currentKey);
        const chatModel = genAI.getGenerativeModel({
            model: PRIMARY_MODEL,
            systemInstruction: activeSystemInstruction
        });
        const chat = chatModel.startChat({ history: cleanHistory });
        const result = await chat.sendMessageStream(promptText);

        for await (const chunk of result.stream) {
            if (!t_first_token) t_first_token = performance.now();
            const chunkText = chunk.text();
            if (chunkText) {
                generatedChars += chunkText.length;
                res.write(`data: ${JSON.stringify({ text: chunkText })}\n\n`);
            }
        }
        
        const t_end = performance.now();
        if (!t_first_token) t_first_token = t_end;
        res._xray = { ttft: t_first_token - t_start, gen: t_end - t_first_token, chars: generatedChars };
    } catch (error) {
        const t_end = performance.now();
        if (!t_first_token) t_first_token = t_end;
        res._xray = { ttft: t_first_token - t_start, gen: t_end - t_first_token, chars: generatedChars };

        console.error(`[FAST MODE] Ошибка Google (попытка ${retryCount + 1}):`, error.message);
        serverStats.apiErrors++;
        if (classifyError(error) === '429') blockKey(currentKey);

        if (retryCount >= KEYS.length) {
            res.write(`data: ${JSON.stringify({ text: '\n\n⚠️ Извините, серверы нейросети сейчас перегружены из-за высокого спроса. Пожалуйста, повторите свой вопрос через минуту.' })}\n\n`);
            return;
        }

        await new Promise(r => setTimeout(r, 800));
        console.log(`[FAST MODE] Делаю повторную попытку...`);
        return handleFast(message, history, retrievalResult, res, retryCount + 1);
    }
}

// ============================================================
// РЕЖИМ THINKING — теперь полностью реализован через handleDeepThinking
// (5-этапная цепочка ниже). Старый одноразовый retrieval удалён 2026-05-18.
// ============================================================
// ============================================================
// РЕЖИМ AGENT (IDE Document Editor — Cursor-style)
// ============================================================
// Принимает уже-собранный фронтом промпт (содержит документ + задачу),
// прибавляет лёгкий retrieval НПА для возможных цитат, и отдаёт ответ
// с системным промптом AGENT_SYSTEM_PROMPT (строгий JSON).
// История чата сохраняется — агент видит предыдущие правки.
// ============================================================
// ════════════════════════════════════════════════════════════════════
// EDIT_COMMAND_REGEX — единый источник истины для распознавания ПРЯМЫХ
// команд редактирования. Используется и на верхнем уровне handleAgent
// (чтобы обойти doc-router → handleDeepThinking), и в classifyUserIntent.
// • Граница (?!\p{L}) + флаг u — \b в JS НЕ работает после кириллицы.
// • (?:^|\s) — глагол в начале ИЛИ после пробела (ловит «проверь и измени»).
// • Включены частые опечатки ввода: зиени, испарвь, заемни, помеяй, удоли…
// ════════════════════════════════════════════════════════════════════
const EDIT_COMMAND_REGEX = /(?:^|\s)(измени|измини|зиени|исправь|испарвь|замени|заемни|удали|удоли|поменяй|помеяй|установи|перепиши|сделай|подправь)(?!\p{L})/iu;

async function handleAgent(message, history, res, retryCount = 0, userQuery = null, documentContext = null) {
    // ─── KILL-SWITCH (ВЕРХНИЙ УРОВЕНЬ — до любого RAG-роутинга) ────────
    // Прямая команда редактирования ("Измени сумму…", даже с опечаткой
    // "ЗИени…") ОБЯЗАНА идти в редактор (JSON-тулзы), а НЕ в RAG/DeepThinking.
    // Проверяем ДО doc-router, иначе короткий запрос без распознанного
    // документа уходил в classifyQuery → 'complex' → handleDeepThinking (баг).
    // Берём userQuery (короткая инструкция); fallback — первые 200 символов
    // message, чтобы НЕ сканировать весь документ (ложные срабатывания).
    const killQuery = (userQuery && userQuery.trim()) || String(message || '').slice(0, 200);
    const forceEditor = EDIT_COMMAND_REGEX.test(killQuery);
    if (forceEditor) {
        console.log(`[AGENT] KILL-SWITCH → EDITOR forced (bypass doc-router & RAG) | q="${killQuery.slice(0, 60)}"`);
    }

    // ─────────────────────────────────────────────────────────────
    // РОУТЕР: если запрос юриста БЕЗ реального документа — переадресуем
    // в 5-этапную deep-thinking цепочку. Agent-режим (JSON для редактирования)
    // не подходит для обычной консультации.
    //
    // ВАЖНО: фронт IDE всегда подмешивает в message системный промпт со
    // словом "ТЕКУЩИЙ ТЕКСТ ДОКУМЕНТА:" и JSON-полем "insertion_text" —
    // даже когда документа нет. Поэтому ищем ТЕЛО блока между """...""",
    // а не сам маркер.
    // ─────────────────────────────────────────────────────────────
    if (retryCount === 0 && !forceEditor) {
        // 1) Источник текста документа:
        //    • НОВЫЙ путь — отдельное поле req.body.documentContext (без regex-костыля);
        //    • FALLBACK (старый клиент) — вырезаем блок ТЕКУЩИЙ ТЕКСТ ДОКУМЕНТА: """...""".
        const ctxDoc = (documentContext && String(documentContext).trim()) || '';
        const docBlockMatch = ctxDoc ? null : message.match(/ТЕКУЩИЙ ТЕКСТ ДОКУМЕНТА[^"]*"""([\s\S]*?)"""/i);
        const docBody = ctxDoc || (docBlockMatch ? docBlockMatch[1].trim() : '');
        const hasRealDoc = docBody.length >= 100;   // порог сохранён

        // 2) Fallback: явный analyze-document блок (когда вызывается из
        //    analyzeDocumentSmart как fallback с собранным промптом)
        const hasFallbackDoc = /═══ ДОКУМЕНТ ПОЛЬЗОВАТЕЛЯ ═══|═══ ДОКУМЕНТ:\n"""/i.test(message);

        const isDocumentRequest = hasRealDoc || hasFallbackDoc;
        if (!isDocumentRequest) {
            const hasUserQuery = userQuery && userQuery.trim().length > 0;
            const consultQuery = hasUserQuery ? userQuery : message;
            // Smart router: simple-запрос → быстрый путь, complex → DeepThinking
            sendStep(res, { id: 'classify', status: 'loading', text: 'Определяю тип запроса' });
            const queryType = await classifyQuery(consultQuery);
            if (queryType === 'simple') {
                console.log(`[ROUTER] handleAgent → handleSimpleConsultation (simple, query: "${consultQuery.slice(0, 60)}")`);
                return handleSimpleConsultation(message, history, res, consultQuery);
            }
            sendStep(res, { id: 'classify', status: 'success', text: 'Сложный запрос — запускаю глубокий анализ' });
            console.log(`[ROUTER] handleAgent → handleDeepThinking (complex, docBody=${docBody.length}ch, query: "${consultQuery.slice(0, 60)}")`);
            return handleDeepThinking(message, history, res, consultQuery);
        }
        console.log(`[ROUTER] handleAgent stays (docBody=${docBody.length}ch, fallback=${hasFallbackDoc})`);
    }

    const cleanHistory = sanitizeHistory(history);

    // ─────────────────────────────────────────────────────────────
    // INTENT ROUTING — определяем намерение ПЕРЕД тяжёлым RAG.
    // Классифицируем только по короткому userQuery (если фронт его прислал).
    // Без userQuery надёжно классифицировать инструкцию нельзя (в message
    // может быть весь документ) → безопасный дефолт RAG_AGENT (старое поведение).
    // ─────────────────────────────────────────────────────────────
    let intent = 'RAG_AGENT';
    if (forceEditor) {
        intent = 'EDITOR';   // kill-switch уже решил — RAG не нужен, LLM не зовём
    } else if (userQuery && userQuery.trim()) {
        try {
            intent = await classifyUserIntent(userQuery.trim());
        } catch (e) {
            console.warn('[AGENT] intent classify failed, fallback RAG_AGENT:', e.message);
        }
    }

    // CLARIFY — намерение размыто: не угадываем, а спрашиваем юриста и выходим.
    // ВАЖНО: фронт (parseAgentCommands) ждёт строгий JSON-блок. Поэтому вопрос
    // упаковываем в тот же контракт — reasoning=вопрос, insertion_text="" (ничего
    // не вставляем в документ). Иначе фронт покажет ошибку «не удалось получить ответ».
    if (intent === 'CLARIFY') {
        const clarifyJson = JSON.stringify({
            reasoning: '🤔 Уточните, пожалуйста: вы хотите просто **внести техническую правку** (изменить сумму/дату/формулировку как есть) — или **проверить этот фрагмент на соответствие нормам** (ГК/ТК/УК КР) и при необходимости переписать его юридически корректно?',
            anchor_text: '',
            insertion_text: ''
        }, null, 2);
        res.write(`data: ${JSON.stringify({ text: '```json\n' + clarifyJson + '\n```' })}\n\n`);
        console.log('[AGENT] intent=CLARIFY → запрошено уточнение, агент не запускался');
        return;
    }

    // Light retrieval — чтобы агент мог цитировать конкретные нормы НПА.
    // Не отправляем status-события клиенту (агент-режим тихий).
    // ▸ Запускаем ТОЛЬКО для правовых задач (intent=RAG_AGENT). На технической
    //   правке (intent=EDITOR) Pinecone+embedding пропускаем целиком.
    let contextBlock = '';
    let allMatches = [];
    try {
        // ▸ Для embedding используем КОРОТКИЙ userQuery если он передан фронтом
        //   (иначе вектор размывается всем текстом документа и retrieval теряет точность).
        // ▸ Fallback на полный message только если userQuery отсутствует.
        const queryForEmbedding = (userQuery && userQuery.trim()) || message;
        const isCasual = isCasualMessage(queryForEmbedding);
        if (!isCasual && intent === 'RAG_AGENT') {
            const qLen = queryForEmbedding.length;
            const adaptiveMaxK = qLen > 200 ? 22 : qLen > 60 ? 15 : 10;
            const adaptiveMinK = qLen > 200 ? 6  : qLen > 60 ? 4  : 3;
            console.log(`[AGENT] Supabase retrieval: query=${qLen}ch → maxK=${adaptiveMaxK} minK=${adaptiveMinK}`);
            const retrieval = await adaptiveRetrieval(queryForEmbedding, 'agent', null, {
                maxK: adaptiveMaxK, minK: adaptiveMinK
            });
            const { core = [], context = [], all = [] } = retrieval || {};
            allMatches = all;
            if (all.length > 0) {
                const formatted = formatContextWithHierarchy(core, context);
                contextBlock = `\n\n═══ КОНТЕКСТ — ${all.length} релевантных статей НПА КР (используй для цитирования) ═══\n\n${formatted}\n\n═══ КОНЕЦ КОНТЕКСТА ═══\n`;
            }
        }
    } catch (retErr) {
        console.warn('[AGENT] Retrieval skipped:', retErr.message);
    }

    // Если документ пришёл отдельным полем — подмешиваем его в prompt сами
    // (в message его больше нет). При fallback-пути документ уже внутри message,
    // поэтому повторно НЕ инжектим (иначе дубль).
    const docBlock = (documentContext && String(documentContext).trim())
        ? `\n\nТЕКУЩИЙ ТЕКСТ ДОКУМЕНТА:\n"""\n${String(documentContext).trim()}\n"""\n`
        : '';
    const userPrompt = message + docBlock + contextBlock;

    console.log(`[AGENT] Готовлю ответ | intent: ${intent} | НПА найдено: ${allMatches.length} | history: ${cleanHistory.length} | docCtx: ${docBlock ? 'field' : 'inline/none'}`);

    const apiKey = getNextKey();
    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
            model: PRIMARY_MODEL,
            systemInstruction: AGENT_SYSTEM_PROMPT,
            generationConfig: {
                // Мы хотим валидный JSON — temperature ниже, формат поддерживаем
                temperature: 0.4,
                topP: 0.9,
                maxOutputTokens: 4096
            }
        });
        const chat = model.startChat({ history: cleanHistory });
        const result = await chat.sendMessageStream(userPrompt);

        for await (const chunk of result.stream) {
            const chunkText = chunk.text();
            if (chunkText) res.write(`data: ${JSON.stringify({ text: chunkText })}\n\n`);
        }

        // Источники для цитирования в UI (chip-бейджи под ответом)
        if (allMatches.length > 0) {
            const sourcesArr = allMatches.slice(0, 5);
            const sources = sourcesArr.map(m =>
                `${m.metadata?.npa_title || 'НПА'} — ${m.metadata?.article_title || ''}`
            );
            const metadata = sourcesArr.map(m => ({
                npa_title: m.metadata?.npa_title || '',
                article_title: m.metadata?.article_title || '',
                full_text: m.metadata?.full_text || ''
            }));
            res.write(`data: ${JSON.stringify({ sources, metadata })}\n\n`);
        }
    } catch (err) {
        console.error(`[AGENT] Ошибка Gemini (попытка ${retryCount + 1}):`, err.message);
        serverStats.apiErrors++;
        // Блокируем ключ ТОЛЬКО при 429 (см. комментарий в handleFast).
        if (classifyError(err) === '429') blockKey(apiKey);

        if (retryCount >= Math.min(KEYS.length, 3)) {
            res.write(`data: ${JSON.stringify({ text: '\n\n⚠️ Серверы AI временно перегружены. Повторите запрос через минуту.' })}\n\n`);
            return;
        }

        await delay(1500);
        return handleAgent(message, history, res, retryCount + 1, userQuery, documentContext);
    }
}

// ════════════════════════════════════════════════════════════════════
// QUERY CLASSIFIER — smart router между simple/complex/casual
// ════════════════════════════════════════════════════════════════════
// Раньше любой запрос в thinking-режиме шёл в DeepThinking (5 параллельных
// Pinecone-запросов + LLM-реформулировка + финальный LLM ≈ 6-9с до ответа).
// Для тривиального «что такое ст. 122 УК КР» это перебор — нужен быстрый путь.
//
// quickClassify — regex-эвристика, покрывает ~90% случаев бесплатно.
// llmClassify   — короткий LLM-вызов, fallback для пограничных запросов.
// classifyQuery — объединяющая функция.
//
// Результаты:
// • casual   — приветствие/болтовня → handleFast без retrieval
// • simple   — справочный запрос → handleSimpleConsultation (1 retrieval ~3-5с)
// • complex  — реальная ситуация юриста → handleDeepThinking (5 слоёв ~6-9с)
// ════════════════════════════════════════════════════════════════════

function quickClassify(message) {
    if (!message) return 'casual';
    const trimmed = String(message).trim();
    const lower = trimmed.toLowerCase();

    // Casual — приветствие/болтовня (уже есть отдельная функция)
    if (isCasualMessage(trimmed)) return 'casual';

    // Triggers — индикаторы реальной ситуации юриста (complex)
    const complexTriggers = /(как\s+(мне|нам|быть)|что\s+делать|помог|вправ|можно\s+ли|правомер|оспорить|обжалов|подал\s+в\s+суд|подавать\s+иск|взыскать|выселить|расторгн|спор[еауы]|конфликт|истец|ответчик|претензи|составь|напиши|сформируй|подгот)/i;
    const hasComplexTriggers = complexTriggers.test(lower);

    // SIMPLE — короткие справочные запросы
    const hasStatueRef = /(ст(атья|\.)\s*[\d¹²³⁴⁵⁶⁷⁸⁹⁰]+|статья\s+\d+|ст\.?\s*\d+)/i.test(trimmed);
    const isTermLookup = /^(что\s+(такое|значит|есть|подразумевает)|объясни|расшифруй|определ[иь]|растолкуй)/i.test(trimmed);
    const isShortGeneric = trimmed.length < 60 && !hasComplexTriggers;

    if (!hasComplexTriggers && hasStatueRef && trimmed.length < 200) return 'simple';
    if (isTermLookup && trimmed.length < 150) return 'simple';
    if (isShortGeneric) return 'simple';

    // COMPLEX — длинная ситуация, multi-question, явные триггеры
    const isLongScenario = trimmed.length > 200;
    const multipleParts = (trimmed.match(/[?!]/g) || []).length >= 2;
    if (hasComplexTriggers || isLongScenario || multipleParts) return 'complex';

    return null; // неясно — пусть LLM решит
}

async function llmClassify(message) {
    const systemPrompt = `Ты — классификатор юридических запросов КР. По тексту вопроса юриста определи тип:
- "simple"  — справочный запрос: что значит термин, какая статья, краткое объяснение нормы, цифра-факт (срок, госпошлина, размер штрафа)
- "complex" — реальная ситуация юриста с действиями: что делать в конфликте, как защитить позицию, как взыскать, как обжаловать, составить документ, оценить риски

Отвечаешь СТРОГО JSON без markdown без пояснений.`;
    const userPrompt = `Вопрос: "${message}"

Формат: {"type": "simple"} или {"type": "complex"}`;
    try {
        const raw = await callOnce(getNextKey(), systemPrompt, userPrompt, 1);
        const cleaned = String(raw || '').replace(/```json|```/g, '').trim();
        const m = cleaned.match(/\{[\s\S]*\}/);
        if (!m) return 'complex';
        const parsed = JSON.parse(m[0]);
        return parsed.type === 'simple' ? 'simple' : 'complex';
    } catch (e) {
        console.error('[LLM-Classify] failed:', e.message);
        return 'complex'; // safe default — лучше глубокий поиск чем поверхностный
    }
}

async function classifyQuery(message) {
    const quick = quickClassify(message);
    if (quick) {
        console.log(`[Classify] quick → ${quick} (msg=${message.length}ch)`);
        return quick;
    }
    const llm = await llmClassify(message);
    console.log(`[Classify] llm → ${llm} (msg=${message.length}ch)`);
    return llm;
}

// ════════════════════════════════════════════════════════════════════
// INTENT CLASSIFICATION — "техническая правка" vs "правовой анализ"
// ════════════════════════════════════════════════════════════════════
// Перед тяжёлым RAG в handleAgent определяем НАМЕРЕНИЕ юриста по короткому
// userQuery. Цель — не гонять Pinecone+embedding на тривиальных правках
// (опечатка, сумма, дата, формат), где правовой контекст не нужен.
// Паттерн идентичен classifyQuery: quickIntent (regex, 0мс) → llmIntent
// (лёгкий LLM) → fail-safe default. Возвращает один из трёх режимов:
//   'EDITOR'    — механическая правка без правовых последствий → RAG пропускаем
//   'RAG_AGENT' — правовая задача (соответствие норме, выбор статьи) → RAG нужен
//   'CLARIFY'   — намерение размыто → агент задаёт уточняющий вопрос
// ════════════════════════════════════════════════════════════════════
function quickIntent(query) {
    if (!query) return null;
    const q = String(query).trim().toLowerCase();

    // --- RAG_AGENT: явные правовые маркеры (приоритет — проверяем ПЕРВЫМИ) ---
    // Соответствие норме, правовая оценка, ссылка на НПА, добавление условия.
    const legalMarkers = /(соответств|проверь.*(на|по)\s|правомер|законн|незаконн|противоречит|нарушает|оспор|обоснуй|сошлись|ссыл(ка|ку|ки|айся)\s+на\s+(ст|закон|кодекс|норм)|по\s+(гк|ук|тк|кодекс)|норм[аеуы]|неустойк|форс-?мажор|ответственност|штраф|пени|обязательств|санкци|оцени\s+риск|риск|правов)/i;
    if (legalMarkers.test(q)) return 'RAG_AGENT';

    // --- EDITOR: чистая техническая правка без правовых последствий ---
    const editTarget = '(сумм|цифр|число|дат|срок|фио|имя|фамил|название|наименование|реквизит|слов|букв|опечат|орфограф)';
    const editMarkers = new RegExp(
        `(опечат|орфограф|поправь|подправь|перепиши\\s+слов|` +
        `(исправь|замени|поменяй|измени|поставь|обнови)\\s+(${editTarget}|\\d)|` +
        `удали\\s+(пункт|абзац|предложен|строк|слов|запят|пробел)|` +
        `убери\\s+(пункт|абзац|предложен|строк|слов|запят|пробел|лишн)|` +
        `перенеси|выдели\\s+жирн|сделай\\s+(заголов|жирн|курсив)|пронумеруй|разбей\\s+на\\s+пункт|формат)`, 'i'
    );
    if (editMarkers.test(q)) return 'EDITOR';

    return null; // неясно — пусть решит LLM
}

async function llmIntent(query) {
    const systemPrompt = `Ты — классификатор намерений юриста, работающего в РЕДАКТОРЕ документов Кыргызской Республики. У юриста открыт документ. Определи, что он хочет сделать:
- "EDITOR"    — техническая правка БЕЗ правовых последствий: исправить опечатку, изменить сумму/цифру/дату/срок/ФИО/название, удалить или перенести текст, форматирование. Точное значение либо указано, либо очевидно из документа.
- "RAG_AGENT" — правовая задача: проверить на соответствие норме, выбрать или сослаться на статью, добавить юридическое условие (неустойка, ответственность, форс-мажор), оценить риски, обосновать позицию.
- "CLARIFY"   — намерение размыто: непонятно, нужна ли просто механическая правка ИЛИ правовая проверка (например "тут что-то не так с суммой", "посмотри этот пункт").

Отвечаешь СТРОГО JSON, без markdown, без пояснений.`;
    const userPrompt = `Запрос юриста: "${query}"

Формат: {"intent": "EDITOR"} | {"intent": "RAG_AGENT"} | {"intent": "CLARIFY"}`;
    try {
        const raw = await callOnce(getNextKey(), systemPrompt, userPrompt, 1);
        const cleaned = String(raw || '').replace(/```json|```/g, '').trim();
        const m = cleaned.match(/\{[\s\S]*\}/);
        if (!m) return 'RAG_AGENT';
        const intent = JSON.parse(m[0]).intent;
        return ['EDITOR', 'RAG_AGENT', 'CLARIFY'].includes(intent) ? intent : 'RAG_AGENT';
    } catch (e) {
        console.error('[LLM-Intent] failed:', e.message);
        return 'RAG_AGENT'; // fail-safe: лучше лишний RAG, чем пропущенная правовая проверка
    }
}

async function classifyUserIntent(query) {
    // ─── KILL SWITCH (второй уровень защиты) ────────────────────────
    // Прямые команды редактирования (+ частые опечатки) → EDITOR сразу,
    // в обход правовых маркеров (quickIntent) и LLM (llmIntent). Используем
    // общий EDIT_COMMAND_REGEX — тот же, что и на верхнем уровне handleAgent.
    if (query && EDIT_COMMAND_REGEX.test(query)) {
        console.log(`[Intent] kill-switch → EDITOR (q=${(query || '').length}ch)`);
        return 'EDITOR';
    }

    const quick = quickIntent(query);
    if (quick) {
        console.log(`[Intent] quick → ${quick} (q=${(query || '').length}ch)`);
        return quick;
    }
    const llm = await llmIntent(query);
    console.log(`[Intent] llm → ${llm} (q=${(query || '').length}ch)`);
    return llm;
}

// ════════════════════════════════════════════════════════════════════
// SIMPLE CONSULTATION — лёгкий пайплайн для справочных запросов
// ════════════════════════════════════════════════════════════════════
// Используется когда классификатор сказал "simple" — один adaptiveRetrieval
// (topK=15 с автоматическим elbow-фильтром) + сразу финальный LLM с
// консультант-промптом. Без реформулировки, без 5 слоёв. Время ответа ~3-5с
// против ~6-9с в DeepThinking.
// ════════════════════════════════════════════════════════════════════
async function handleSimpleConsultation(message, history, res, userQuery = null) {
    const userQ = (userQuery && userQuery.trim()) || message;
    const cleanHistory = sanitizeHistory(history);

    sendStep(res, { id: 'classify', status: 'success', text: 'Простой справочный запрос', reason: 'Использую быстрый путь поиска' });
    sendStep(res, { id: 'retrieve', status: 'loading', text: 'Ищу релевантные статьи НПА' });
    sendStatus(res, '🔎 Ищу релевантные статьи...');

    const retrieval = await adaptiveRetrieval(userQ, 'thinking', null, { queryType: 'npa', npaQuota: 10 });
    const { core = [], context = [], all = [] } = retrieval;

    sendStep(res, {
        id: 'retrieve',
        status: all.length ? 'success' : 'warning',
        text: all.length ? `Найдено: ${all.length}` : 'В базе нет данных по запросу'
    });

    if (all.length === 0) {
        sendStep(res, { id: 'answer', status: 'warning', text: 'Нет данных в базе' });
        res.write(`data: ${JSON.stringify({ text: 'К сожалению, в базе нет информации по этому вопросу. Для нормативных актов: cbd.minjust.gov.kg, для госуслуг: tunduk.gov.kg.' })}\n\n`);
        return;
    }

    sendStep(res, { id: 'answer', status: 'loading', text: 'Формулирую ответ' });
    sendStatus(res, '✍️ Формулирую ответ...');

    // Формируем контекст и промпт
    const contextText = formatContextWithHierarchy(core, context);
    const isL4 = detectL4Request(userQ);
    let systemPrompt = BASE_CONSULTANT_PROMPT;
    if (isAcademicRequest(userQ)) systemPrompt += '\n\n' + ACADEMIC_PROMPT_ADDON;
    if (isL4) systemPrompt += '\n\n' + L4_WARNING_ADDON;
    const prefix = `Контекст — ${all.length} релевантных статей НПА КР (⭐ ${core.length} ключевых + 📚 ${context.length} вспомогательных):`;
    const finalPrompt = `Вопрос пользователя: "${userQ}"\n\n${prefix}\n\n${contextText}`;

    try {
        await streamGeminiResponse(getNextKey(), systemPrompt, finalPrompt, cleanHistory, res);
        sendStep(res, { id: 'answer', status: 'success', text: 'Ответ готов' });

        const sourcesArr = [...core, ...context].slice(0, 5);
        const sources = sourcesArr.map(m => `${m.metadata?.npa_title || 'Источник'} — ${m.metadata?.article_title || ''}`);
        const metadata = sourcesArr.map(m => ({
            npa_title: m.metadata?.npa_title || '',
            article_title: m.metadata?.article_title || '',
            full_text: m.metadata?.full_text || ''
        }));
        if (sources.length > 0) res.write(`data: ${JSON.stringify({ sources, metadata })}\n\n`);
    } catch (err) {
        console.error('[SimpleConsult] failed:', err.message);
        sendStep(res, { id: 'answer', status: 'error', text: 'Ошибка генерации ответа' });
        try {
            await streamGeminiResponse(getNextKey(), systemPrompt, finalPrompt, cleanHistory, res);
        } catch (e2) {
            res.write(`data: ${JSON.stringify({ text: '\n\n⚠️ Серверы временно перегружены. Повторите запрос через минуту.' })}\n\n`);
        }
    }
}

// ════════════════════════════════════════════════════════════════════
// DEEP THINKING — 5-этапная цепочка для обычных запросов БЕЗ документа
// ════════════════════════════════════════════════════════════════════
// Шаг 1: Снайперский поиск — специальная норма (topK=5)
// Шаг 2: Общие положения — фундамент Кодекса (topK=10)
// Шаг 3: Процессуальные нормы — сроки/подсудность/госпошлина (topK=8)
// Шаг 4: Подзаконные акты — правила/инструкции (topK=5)
// Шаг 5: Синтез — Consultant с иерархическим контекстом из 4 слоёв
//
// Эмитит SSE-step события (id: reformulate, special, general, process,
// bylaws, synthesize) — UI ThinkingBox их рисует автоматически.
// ════════════════════════════════════════════════════════════════════

// LLM-реформулировка: один вопрос → topic + 5 поисковых запросов под разные слои.
// topic — короткая тема всего запроса, которая ИНЖЕКТИРУЕТСЯ как prefix во все
// 5 embedding-query. Без префикса короткий "срок исковой давности подсудность"
// мог уйти в embedding-пространство трудового права, хотя вопрос был о теплоэнергии.
async function reformulateQueries(userMessage) {
    const systemPrompt = `Ты — юридический поисковый эксперт КР.
По вопросу пользователя-юриста формируешь:
1) короткую тему запроса (для удержания контекста во всех поисках)
2) 8 коротких поисковых запросов для разных слоёв законодательства КР

ВАЖНО — принципо-ориентированный поиск (включай термины принципов в запросы):
• Уголовное / действие закона во времени → «обратная сила уголовного закона», «nullum crimen sine lege», «улучшающий закон»
• Уголовный процесс → «презумпция невиновности», «in dubio pro reo», «недопустимые доказательства», «право на защитника»
• Гражданское / договоры → «обратная сила гражданского закона», «свобода договора», «добросовестность», «существенное изменение обстоятельств», «срок исковой давности»
• Трудовое → «запрет дискриминации труд», «принудительный труд», «минимальные гарантии работника», «увольнение основания»
• Административное → «обратная сила административного закона», «соразмерность наказания», «срок давности административное»
• Налоговое → «неустранимые сомнения налогоплательщик», «определённость налога», «незаконный налог подзаконный»
• Семейное → «интересы детей приоритет», «совместная собственность супругов», «алиментные обязательства»
• Коллизия норм → «специальная норма приоритет», «lex specialis», «иерархия источников права КР»

Отвечаешь СТРОГО JSON без markdown без пояснений.`;
    const userPrompt = `Вопрос пользователя: "${userMessage}"

Сформируй компактный пакет поисковых стратегий.
Каждый запрос — короткая фраза (5-15 слов), оптимизированная под векторный поиск по НПА КР.

Формат (ровно такой JSON):
{
  "topic":       "тема вопроса в 5-10 словах с указанием отрасли (для prefix-инжекции)",
  "special":     "узкая специальная норма — точная проблема юриста",
  "general":     "общие положения и фундаментальные принципы (Кодексы)",
  "process":     "процессуальные нормы — сроки давности, подсудность, госпошлина",
  "liability":   "ответственность за нарушение — штрафы, неустойка, санкции, расторжение",
  "bylaws":      "подзаконные акты — правила, инструкции, постановления Кабмина",
  "rights":      "права и обязанности сторон правоотношения — что вправе требовать, что обязан",
  "definitions": "определения ключевых понятий — кто является субъектом, что считается нарушением",
  "evidence":    "доказательственная база — какие документы и факты нужно доказать в суде"
}

Примеры:
Вопрос: "Соседи затопили мою квартиру, как взыскать ущерб?"
{
  "topic":       "залив квартиры соседями возмещение ущерба",
  "special":     "возмещение вреда имуществу при заливе квартиры",
  "general":     "общие положения об обязательствах из причинения вреда ГК КР",
  "process":     "срок исковой давности подсудность иск о возмещении вреда",
  "liability":   "размер компенсации морального вреда неустойка ответственность виновника",
  "bylaws":      "правила содержания общего имущества жилых домов",
  "rights":      "право требовать возмещения убытков обязанность виновника устранить ущерб",
  "definitions": "понятие вред имущество убытки реальный ущерб упущенная выгода ГК КР",
  "evidence":    "доказательства залива акт осмотра независимая оценка ущерба документы"
}

Вопрос: "Работодатель не платит зарплату 3 месяца, что делать?"
{
  "topic":       "задержка выплаты заработной платы трудовые споры",
  "special":     "задержка выплаты заработной платы работодателем нарушение ТК",
  "general":     "общие положения трудового договора оплата труда ТК КР",
  "process":     "срок исковой давности трудовые споры подсудность государственная инспекция труда",
  "liability":   "ответственность работодателя за задержку зарплаты штраф компенсация",
  "bylaws":      "минимальный размер оплаты труда постановление Кабмина КР",
  "rights":      "право работника на своевременную выплату заработной платы ТК КР",
  "definitions": "заработная плата оклад надбавка премия понятие ТК КР",
  "evidence":    "доказательства задержки зарплаты расчётный лист трудовой договор выписка"
}`;
    try {
        const raw = await callOnce(getNextKey(), systemPrompt, userPrompt, 1);
        const cleaned = String(raw || '').replace(/```json|```/g, '').trim();
        const fi = cleaned.indexOf('{');
        const li = cleaned.lastIndexOf('}');
        const slice = (fi >= 0 && li > fi) ? cleaned.slice(fi, li + 1) : cleaned;
        const parsed = JSON.parse(slice);
        return {
            topic:       String(parsed.topic       || '').slice(0, 200),
            special:     String(parsed.special     || userMessage).slice(0, 280),
            general:     String(parsed.general     || userMessage).slice(0, 280),
            process:     String(parsed.process     || userMessage).slice(0, 280),
            liability:   String(parsed.liability   || userMessage).slice(0, 280),
            bylaws:      String(parsed.bylaws      || userMessage).slice(0, 280),
            rights:      String(parsed.rights      || userMessage).slice(0, 280),
            definitions: String(parsed.definitions || userMessage).slice(0, 280),
            evidence:    String(parsed.evidence    || userMessage).slice(0, 280)
        };
    } catch (e) {
        console.error('[Reformulate] failed:', e.message);
        return {
            topic: '', special: userMessage, general: userMessage,
            process: userMessage, liability: userMessage, bylaws: userMessage,
            rights: userMessage, definitions: userMessage, evidence: userMessage
        };
    }
}

// ════════════════════════════════════════════════════════════════════
// ADAPTIVE DEEP RETRIEVAL — 1-8 слоёв в зависимости от сложности
// Classifier (Gemini Flash Lite, ~1с) → level 1-4 → нужный набор слоёв
// Все retrieval идут параллельно — время ≈ max одного слоя
// ════════════════════════════════════════════════════════════════════

const LAYER_CONFIGS = [
    { id: 1, stepId: 'special',     key: 'specMatches',   queryKey: 'special',     quota: 4, mode: 'fast',     stepText: 'Ищу специальные нормы по проблеме',    resultText: n => `Специальных норм: ${n}` },
    { id: 2, stepId: 'general',     key: 'genMatches',    queryKey: 'general',     quota: 5, mode: 'thinking', stepText: 'Проверяю общие положения Кодекса',      resultText: n => `Общих положений: ${n}` },
    { id: 3, stepId: 'process',     key: 'procMatches',   queryKey: 'process',     quota: 4, mode: 'thinking', stepText: 'Анализирую процессуальные требования',  resultText: n => `Процессуальных норм: ${n}` },
    { id: 4, stepId: 'liability',   key: 'liabMatches',   queryKey: 'liability',   quota: 4, mode: 'fast',     stepText: 'Ищу нормы об ответственности',          resultText: n => `Норм об ответственности: ${n}` },
    { id: 5, stepId: 'bylaws',      key: 'bylawMatches',  queryKey: 'bylaws',      quota: 3, mode: 'fast',     stepText: 'Проверяю подзаконные акты',             resultText: n => `Подзаконных актов: ${n}` },
    { id: 6, stepId: 'rights',      key: 'rightsMatches', queryKey: 'rights',      quota: 3, mode: 'fast',     stepText: 'Определяю права и обязанности сторон',  resultText: n => `Прав и обязанностей: ${n}` },
    { id: 7, stepId: 'definitions', key: 'defMatches',    queryKey: 'definitions', quota: 3, mode: 'fast',     stepText: 'Нахожу определения ключевых понятий',   resultText: n => `Определений понятий: ${n}` },
    { id: 8, stepId: 'evidence',    key: 'evMatches',     queryKey: 'evidence',    quota: 3, mode: 'fast',     stepText: 'Анализирую доказательственную базу',    resultText: n => `Доказательственных норм: ${n}` },
];

// Наборы слоёв для каждого уровня сложности
const LEVEL_LAYER_IDS = {
    1: [1, 3],              // Простой факт: spec + process (срок, куда обращаться)
    2: [1, 3, 4],           // Практическая ситуация: + liability (алгоритм действий)
    3: [1, 2, 3, 4, 5],    // Правовой спор: 5 классических слоёв
    4: [1,2,3,4,5,6,7,8],  // Экспертный анализ: все 8
};

const LEVEL_META = {
    1: { label: 'Простой факт',           emoji: '📌' },
    2: { label: 'Практическая ситуация',  emoji: '📋' },
    3: { label: 'Правовой спор',          emoji: '⚖️' },
    4: { label: 'Экспертный анализ',      emoji: '🔬' },
};

// Classifier: Gemini Flash Lite → уровень 1-4
async function classifyComplexity(query) {
    const sys = `Ты — классификатор сложности юридических вопросов. Отвечаешь ТОЛЬКО JSON.`;
    const usr = `Вопрос юриста: "${query}"

Определи уровень (1-4):
1 — ПРОСТОЙ ФАКТ: срок, размер штрафа, определение термина → ответ из одной статьи
2 — ПРАКТИЧЕСКАЯ СИТУАЦИЯ: порядок действий, типовая процедура, что делать при конкретном случае
3 — ПРАВОВОЙ СПОР: иск, несколько норм и кодексов, ответственность сторон при нарушении
4 — ЭКСПЕРТНЫЙ АНАЛИЗ: стратегия, доказательства, несколько сторон, нужна полная правовая картина

JSON строго: {"level": 2}`;
    try {
        const raw = await callOnce(getNextKey(), sys, usr, 1);
        const m = String(raw || '').match(/"level"\s*:\s*([1-4])/);
        const lvl = m ? parseInt(m[1]) : 3;
        return Math.min(4, Math.max(1, lvl));
    } catch (e) {
        console.warn('[Complexity] fallback L3:', e.message);
        return 3;
    }
}

// Схема ответа для каждого уровня сложности
function buildThinkingSchema(level) {
    const schemas = {
        1: `Ответь кратко и конкретно — это простой фактический вопрос:
• Назови конкретную статью (только из полученного контекста)
• Дай прямой ответ в 1-2 предложениях
• Укажи исключения если они есть в контексте
Не пиши длинных введений — юрист спрашивает конкретный факт.`,
        2: `Ответь по практической схеме:
• Специальная норма (что применяется к ситуации)
→ Порядок действий и сроки (куда обращаться, в какие сроки)
→ Ответственность и последствия нарушения
Дай готовый алгоритм действий — юристу нужно понять что делать прямо сейчас.`,
        3: `Ответь по схеме правового спора:
• Специальная норма (что нарушено / применяется)
→ Общие положения (фундамент Кодекса)
→ Процессуальные шаги (срок ИД, в какой суд, госпошлина)
→ Ответственность и санкции (размер взыскания, неустойка)
→ Подзаконные детали (если есть в контексте)`,
        4: `Ответь полной экспертной схемой:
• Специальная норма (что нарушено / применяется)
→ Определение понятий (если термин нуждается в расшифровке)
→ Права и обязанности сторон (кто что должен / вправе требовать)
→ Общие положения (фундамент Кодекса)
→ Процессуальные шаги (срок ИД, суд, госпошлина)
→ Доказательная база (что нужно доказать, какими документами)
→ Ответственность и санкции (размер взыскания, неустойка, штраф)
→ Подзаконные детали (если есть)
Это даёт юристу полную картину: кто прав, что доказать, куда идти, в какие сроки, размер санкций.`
    };
    return schemas[level] || schemas[3];
}

// Адаптивный N-слойный retrieval с SSE-шагами.
// activeLayerIds: массив ID слоёв для этого запроса (из LEVEL_LAYER_IDS).
async function deepRetrievalChain(userMessage, res, activeLayerIds = [1,2,3,4,5,6,7,8]) {
    const activeCfgs = LAYER_CONFIGS.filter(c => activeLayerIds.includes(c.id));

    // Шаг 0: реформулировка (1 LLM-вызов) — всегда 8 стратегий, используем нужные
    sendStep(res, { id: 'reformulate', status: 'loading', text: `Разлагаю вопрос на ${activeCfgs.length} поисковых стратегий` });
    sendStatus(res, '🧠 Формирую поисковые стратегии...');
    const queries = await reformulateQueries(userMessage);
    sendStep(res, { id: 'reformulate', status: 'success', text: 'Стратегии готовы', reason: queries.topic ? `Тема: ${queries.topic}` : null });
    console.log(`[DeepThink] Topic="${queries.topic||'?'}" layers=[${activeLayerIds.join(',')}]`);

    // PREFIX-контекст: удерживает все embedding-векторы в одной отрасли права
    const ctxPrefix = queries.topic ? `[Контекст: ${queries.topic.slice(0, 160)}] ` : '';
    const wrap = (q) => ctxPrefix + q;

    // Emit loading-шаги только для активных слоёв
    for (const cfg of activeCfgs) {
        sendStep(res, { id: cfg.stepId, status: 'loading', text: cfg.stepText });
    }

    // Параллельный retrieval только для активных слоёв (НПА-only)
    const NPA_ONLY = { queryType: 'npa' };
    const results = await Promise.allSettled(
        activeCfgs.map(cfg => adaptiveRetrieval(wrap(queries[cfg.queryKey]), cfg.mode, null, { ...NPA_ONLY, npaQuota: cfg.quota }))
    );

    // Собираем результаты; неактивные слои получают []
    const out = {};
    for (const cfg of LAYER_CONFIGS) out[cfg.key] = [];
    activeCfgs.forEach((cfg, i) => {
        const r = results[i];
        out[cfg.key] = r.status === 'fulfilled' ? (r.value?.all || []) : [];
        sendStep(res, { id: cfg.stepId, status: out[cfg.key].length ? 'success' : 'warning', text: cfg.resultText(out[cfg.key].length) });
    });

    return { ...out, queries };
}

// Иерархический контекст для финального LLM — 8 пронумерованных слоёв с дедупликацией
function formatLayeredContext({ specMatches, genMatches, procMatches, liabMatches, bylawMatches, rightsMatches, defMatches, evMatches }) {
    const seen = new Set();
    const dedup = (m) => {
        const key = `${m.metadata?.npa_title || ''}|${m.metadata?.article_title || ''}`;
        if (!key || key === '|') return null;
        if (seen.has(key)) return null;
        seen.add(key);
        return m;
    };

    const groups = [
        { label: '⭐ СПЕЦИАЛЬНАЯ НОРМА (главный источник ответа)',         tag: 'СПЕЦИАЛЬНАЯ',    matches: (specMatches   || []).map(dedup).filter(Boolean) },
        { label: '🏛 ОБЩИЕ ПОЛОЖЕНИЯ (фундамент Кодекса)',                 tag: 'ОБЩАЯ',          matches: (genMatches    || []).map(dedup).filter(Boolean) },
        { label: '⚖️ ПРОЦЕССУАЛЬНЫЕ НОРМЫ (сроки, подсудность, пошлина)',  tag: 'ПРОЦЕСС',        matches: (procMatches   || []).map(dedup).filter(Boolean) },
        { label: '⚡ ОТВЕТСТВЕННОСТЬ И САНКЦИИ (штрафы, неустойка)',        tag: 'ОТВЕТСТВЕННОСТЬ',matches: (liabMatches   || []).map(dedup).filter(Boolean) },
        { label: '📋 ПОДЗАКОННЫЕ АКТЫ (постановления, правила)',            tag: 'ПОДЗАКОН',       matches: (bylawMatches  || []).map(dedup).filter(Boolean) },
        { label: '⚖️ ПРАВА И ОБЯЗАННОСТИ СТОРОН (что вправе требовать)',   tag: 'ПРАВА',          matches: (rightsMatches || []).map(dedup).filter(Boolean) },
        { label: '📖 ОПРЕДЕЛЕНИЯ И ПОНЯТИЯ (как закон трактует термины)',   tag: 'ОПРЕДЕЛЕНИЕ',    matches: (defMatches    || []).map(dedup).filter(Boolean) },
        { label: '🔍 ДОКАЗАТЕЛЬСТВЕННАЯ БАЗА (что нужно доказать в суде)', tag: 'ДОКАЗАТЕЛЬСТВО', matches: (evMatches     || []).map(dedup).filter(Boolean) }
    ];

    return groups
        .filter(g => g.matches.length > 0)
        .map(g => {
            const articles = g.matches.map(m => {
                const md = m.metadata || {};
                return `[${g.tag} — ${md.npa_title} | ${md.article_title}]
Документ: ${md.npa_title}
Статья: ${md.article_title}
Текст: ${md.full_text}`;
            }).join('\n\n---\n\n');
            return `══════ ${g.label} ══════\n\n${articles}`;
        })
        .join('\n\n══════════════════════════════════\n\n');
}

// Оркестратор: адаптивный 1-8 слойный retrieval + финальный синтез по консультант-промпту.
// Сначала Gemini Flash Lite классифицирует сложность (1-4) → выбирается набор слоёв.
// Подходит для любого юридического вопроса без приложенного документа.
async function handleDeepThinking(message, history, res, userQuery = null) {
    const userQ = (userQuery && userQuery.trim()) || message;
    const cleanHistory = sanitizeHistory(history);

    // Шаг 0: классификация сложности (Gemini Flash Lite, ~1-2с)
    sendStep(res, { id: 'classify', status: 'loading', text: 'Оцениваю сложность вопроса...' });
    const level = await classifyComplexity(userQ);
    const lm = LEVEL_META[level];
    const layerIds = LEVEL_LAYER_IDS[level];
    sendStep(res, { id: 'classify', status: 'success', text: `${lm.emoji} ${lm.label} — ${layerIds.length} слоёв`, reason: `Уровень ${level}/4` });

    // Retrieval: только нужные слои в параллели
    const { specMatches, genMatches, procMatches, liabMatches, bylawMatches, rightsMatches, defMatches, evMatches } =
        await deepRetrievalChain(userQ, res, layerIds);

    const allMatches = [...specMatches, ...genMatches, ...procMatches, ...liabMatches, ...bylawMatches, ...rightsMatches, ...defMatches, ...evMatches];

    if (allMatches.length === 0) {
        sendStep(res, { id: 'synthesize', status: 'warning', text: 'В базе НПА нет данных по запросу' });
        res.write(`data: ${JSON.stringify({ text: 'К сожалению, в моей текущей базе НПА нет информации по этому вопросу. Рекомендую обратиться к юристу или сверить с cbd.minjust.gov.kg.' })}\n\n`);
        return;
    }

    // Этап 9: финальный синтез с layered context
    sendStep(res, { id: 'synthesize', status: 'loading', text: 'Формирую итоговую консультацию' });
    sendStatus(res, '✍️ Формирую итоговую консультацию...');

    const layeredContext = formatLayeredContext({ specMatches, genMatches, procMatches, liabMatches, bylawMatches, rightsMatches, defMatches, evMatches });

    const isL4 = detectL4Request(userQ);
    const schema = buildThinkingSchema(level);
    let systemPrompt = BASE_CONSULTANT_PROMPT + `

═══ ИЕРАРХИЧЕСКИЙ КОНТЕКСТ (${layerIds.length} СЛОЁВ) ═══
Контекст ниже разделён на слои — используй ВСЕ доступные слои для ответа.
Все номера статей бери ТОЛЬКО из переданного контекста — никогда из памяти.

${schema}`;
    if (isAcademicRequest(userQ)) systemPrompt += '\n\n' + ACADEMIC_PROMPT_ADDON;
    if (isL4) systemPrompt += '\n\n' + L4_WARNING_ADDON;

    const finalPrompt = `Вопрос пользователя: "${userQ}"\n\n${layeredContext}`;

    try {
        await streamGeminiResponse(getNextKey(), systemPrompt, finalPrompt, cleanHistory, res);
        sendStep(res, { id: 'synthesize', status: 'success', text: 'Консультация готова' });

        // Источники: top из каждого слоя (8 слоёв, до 12 уникальных источников)
        const seenSrc = new Set();
        const pickN = (arr, n) => {
            const out = [];
            for (const m of arr) {
                const key = `${m.metadata?.npa_title || ''}|${m.metadata?.article_title || ''}`;
                if (seenSrc.has(key)) continue;
                seenSrc.add(key);
                out.push(m);
                if (out.length >= n) break;
            }
            return out;
        };
        const sourcesArr = [
            ...pickN(specMatches,   2),
            ...pickN(genMatches,    2),
            ...pickN(procMatches,   1),
            ...pickN(liabMatches,   1),
            ...pickN(bylawMatches,  1),
            ...pickN(rightsMatches, 1),
            ...pickN(defMatches,    1),
            ...pickN(evMatches,     1)
        ].slice(0, 12);
        const sources = sourcesArr.map(m => `${m.metadata?.npa_title || 'НПА'} — ${m.metadata?.article_title || ''}`);
        const metadata = sourcesArr.map(m => ({
            npa_title: m.metadata?.npa_title || '',
            article_title: m.metadata?.article_title || '',
            full_text: m.metadata?.full_text || ''
        }));
        if (sources.length > 0) {
            res.write(`data: ${JSON.stringify({ sources, metadata })}\n\n`);
        }
    } catch (err) {
        console.error('[DeepThinking] synthesis failed:', err.message);
        sendStep(res, { id: 'synthesize', status: 'error', text: 'Ошибка финального синтеза' });
        try {
            await streamGeminiResponse(getNextKey(), systemInstruction, finalPrompt, cleanHistory, res);
        } catch (e2) {
            res.write(`data: ${JSON.stringify({ text: '\n\n⚠️ Серверы временно перегружены. Повторите запрос через минуту.' })}\n\n`);
        }
    }
}

// ════════════════════════════════════════════════════════════════════
// DOCUMENT-GROUNDED ANALYSIS — PER-ARTICLE VERIFICATION PIPELINE
// ════════════════════════════════════════════════════════════════════
//   1) Extractor   — JSON-парсер документа → [{act, article, topic, context}]
//   2) Verifiers   — 1 статья = 1 embedding = 1 Pinecone (topK=5) + regex
//                    ВСЕ статьи через Promise.allSettled (round-robin keys)
//   3) Judge       — финальный стриминг ответа на основе verification-отчёта
// ════════════════════════════════════════════════════════════════════

// ── 1. EXTRACTOR ──────────────────────────────────────────────────────
async function extractFromChunk(chunkText, apiKey) {
    const systemPrompt = `Ты — юридический парсер для законодательства Кыргызской Республики.
Извлекаешь ВСЕ ссылки на статьи НПА из текста.
ЗАПРЕЩЕНО упоминать законодательство РФ, Казахстана и других стран — только КР.
Отвечаешь СТРОГО JSON без markdown без пояснений.`;
    const userPrompt = `Найди все ссылки на статьи НПА КР в документе.

Формат ответа (ровно такой JSON):
{
  "articles": [
    {
      "act": "Уголовный кодекс КР",
      "article": "137",
      "topic": "Пытки",
      "context": "точная цитата из документа где упоминается (до 150 символов)"
    }
  ]
}

Если статей нет — верни: {"articles": []}

Документ:
${chunkText}`;
    try {
        const result = await callOnce(apiKey, systemPrompt, userPrompt, 2);
        const cleaned = String(result || '').replace(/```json|```/g, '').trim();
        const fi = cleaned.indexOf('{');
        const li = cleaned.lastIndexOf('}');
        const slice = (fi >= 0 && li > fi) ? cleaned.slice(fi, li + 1) : cleaned;
        const parsed = JSON.parse(slice);
        return Array.isArray(parsed.articles) ? parsed.articles : [];
    } catch (e) {
        console.error('[Extractor] chunk failed:', e.message);
        return [];
    }
}

// Извлекает статьи из документа. Если >8K — chunked параллельно.
async function extractArticles(documentText) {
    const cfg = DOC_ANALYSIS_CONFIG;
    if (documentText.length <= 8000) {
        const articles = await extractFromChunk(documentText, getNextKey());
        return articles.slice(0, cfg.maxArticles);
    }
    // Chunked extraction — параллельно через round-robin keys
    const CHUNK = cfg.extractorChunkSize;
    const OVL = cfg.extractorChunkOverlap;
    const chunks = [];
    for (let i = 0; i < documentText.length; i += (CHUNK - OVL)) {
        chunks.push(documentText.slice(i, i + CHUNK));
        if (i + CHUNK >= documentText.length) break;
    }
    const results = await Promise.allSettled(
        chunks.map(chunk => extractFromChunk(chunk, getNextKey()))
    );
    const all = results
        .filter(r => r.status === 'fulfilled' && Array.isArray(r.value))
        .flatMap(r => r.value);
    // Дедупликация по нормализованному "act|article"
    const seen = new Set();
    const unique = [];
    for (const a of all) {
        const key = `${(a.act || '').toLowerCase().trim()}|${(a.article || '').toLowerCase().trim()}`;
        if (!key || key === '|') continue;
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(a);
        }
    }
    console.log(`[Extractor] chunks=${chunks.length} | raw=${all.length} | unique=${unique.length}`);
    return unique.slice(0, cfg.maxArticles);
}

// ── 1A. ПАСПОРТ ДОКУМЕНТА ───────────────────────────────────────────
// Перед сегментацией извлекаем "паспорт": тип документа, предметная область,
// краткое summary. Этот контекст ВПРЫСКИВАЕТСЯ во все последующие LLM-вызовы
// и в embedding-запросы — иначе при чанкинге пункт типа "Стоимость 1 Гкал"
// уходит в embedding-пространство электроэнергии вместо теплоснабжения.
const DOC_CONTEXT_HEAD_CHARS = 4500;

async function extractDocumentContext(documentText) {
    if (!documentText || documentText.length < 100) return null;
    const head = documentText.slice(0, DOC_CONTEXT_HEAD_CHARS);
    const systemPrompt = `Ты — юридический парсер. Определяешь общий контекст документа по его шапке/началу.
Не пиши законодательство РФ или других стран — только КР.
Отвечаешь СТРОГО JSON без markdown без пояснений.`;
    const userPrompt = `Определи общий контекст юридического документа КР по его началу.

Формат ответа (ровно такой JSON):
{
  "document_type": "Например: Договор теплоснабжения / Договор поставки / Исковое заявление / Претензия / Трудовой договор",
  "subject_area": "Узкая предметная область: теплоснабжение и ЖКХ / поставка товаров / трудовое право / потребительские права",
  "parties": ["Сторона 1 (роль)", "Сторона 2 (роль)"],
  "summary": "1 предложение о сути документа"
}

Если документ нестандартный или начало неинформативно — заполни поля общими формулировками, не пиши null.

Начало документа:
${head}`;
    try {
        const raw = await callOnce(getNextKey(), systemPrompt, userPrompt, 1);
        const cleaned = String(raw || '').replace(/```json|```/g, '').trim();
        const fi = cleaned.indexOf('{');
        const li = cleaned.lastIndexOf('}');
        const slice = (fi >= 0 && li > fi) ? cleaned.slice(fi, li + 1) : cleaned;
        const parsed = JSON.parse(slice);
        const ctx = {
            document_type: String(parsed.document_type || '').trim().slice(0, 120),
            subject_area:  String(parsed.subject_area  || '').trim().slice(0, 120),
            parties:       Array.isArray(parsed.parties)
                ? parsed.parties.map(p => String(p).trim().slice(0, 80)).filter(Boolean).slice(0, 4)
                : [],
            summary:       String(parsed.summary       || '').trim().slice(0, 280)
        };
        if (!ctx.document_type && !ctx.summary) return null;
        return ctx;
    } catch (e) {
        console.error('[DocContext] failed:', e.message);
        return null;
    }
}

// Компактный текст контекста для prefix-инжекции в промпты и embedding-query.
// Один-двумя строками, не больше 280 символов суммарно — длиннее «съест» query.
function formatDocContext(ctx) {
    if (!ctx) return '';
    const parts = [];
    if (ctx.document_type) parts.push(ctx.document_type);
    if (ctx.subject_area)  parts.push(`Сфера: ${ctx.subject_area}`);
    if (ctx.parties && ctx.parties.length) parts.push(`Стороны: ${ctx.parties.join(', ')}`);
    if (ctx.summary)       parts.push(ctx.summary);
    return parts.join('. ').slice(0, 320);
}

// ── 1B. SEGMENTER ────────────────────────────────────────────────────
// Разбивает документ на смысловые разделы/пункты. LLM сам нумерует, если
// исходный документ без структуры. Возвращает [{id, number, heading, text}].
// Параллельный chunked-режим при documentText > 8K.
const SEGMENT_LIMIT = 25;          // максимум пунктов на документ
const SEGMENT_MIN_CHARS = 60;      // короче — это просто заголовок, не пункт
const SEGMENT_CHUNK_SIZE = 7500;
const SEGMENT_CHUNK_OVERLAP = 400;

async function segmentFromChunk(chunkText, apiKey, chunkIndex = 0, docContextStr = '') {
    const contextHeader = docContextStr
        ? `═══ ОБЩИЙ КОНТЕКСТ ДОКУМЕНТА (применяй ко всем пунктам этого чанка) ═══
${docContextStr}
═══════════════════════════════════════════════════════════════════
`
        : '';
    const systemPrompt = `Ты — юридический парсер документов.
Разбиваешь юридический документ (договор, иск, заявление, претензия и т.п.)
на ПУНКТЫ — атомарные смысловые единицы. Каждый пункт должен иметь:
- свой номер (используй авторский номер если есть: "1.", "1.1", "§ 2";
  если нумерации нет — создай иерархическую "1", "1.1", "2", "2.1")
- короткий заголовок (3-7 слов, отражает суть)
- полный текст пункта (не сокращай, дословная цитата без markdown)

ВАЖНО: при разбивке учитывай общий контекст документа (тип, предметная
область) — он указан в начале запроса. Заголовки пунктов должны
отражать суть в контексте всего документа, а не только локального чанка.
Не создавай пункты для метаданных (дата, ФИО, реквизиты в шапке/футере).
Не пиши законодательство РФ или других стран — только КР.
Отвечаешь СТРОГО JSON без markdown без пояснений.`;
    const userPrompt = `${contextHeader}Разбей юридический документ на пункты.

Формат ответа (ровно такой JSON):
{
  "segments": [
    {
      "number": "1",
      "heading": "Предмет договора",
      "text": "Полный текст пункта 1. Дословно из документа..."
    }
  ]
}

Если документ короткий или нечего разбивать — верни {"segments": []}.

Документ${chunkIndex > 0 ? ` (часть ${chunkIndex + 1})` : ''}:
${chunkText}`;
    try {
        const result = await callOnce(apiKey, systemPrompt, userPrompt, 2);
        const cleaned = String(result || '').replace(/```json|```/g, '').trim();
        const fi = cleaned.indexOf('{');
        const li = cleaned.lastIndexOf('}');
        const slice = (fi >= 0 && li > fi) ? cleaned.slice(fi, li + 1) : cleaned;
        const parsed = JSON.parse(slice);
        return Array.isArray(parsed.segments) ? parsed.segments : [];
    } catch (e) {
        console.error('[Segmenter] chunk failed:', e.message);
        return [];
    }
}

async function segmentDocument(documentText, docContextStr = '', opts = {}) {
    if (!documentText || documentText.length < SEGMENT_MIN_CHARS) return [];
    // opts.maxSegments — позволяет режимам переопределить общий лимит SEGMENT_LIMIT.
    // Например, для compare-режима нужен лимит ~60, чтобы охватить все мелкие
    // подпункты длинного договора (стандартный 25 их обрезает на половине).
    const limit = opts.maxSegments || SEGMENT_LIMIT;
    let raw;
    if (documentText.length <= 8000) {
        raw = await segmentFromChunk(documentText, getNextKey(), 0, docContextStr);
    } else {
        const CHUNK = SEGMENT_CHUNK_SIZE;
        const OVL = SEGMENT_CHUNK_OVERLAP;
        const chunks = [];
        for (let i = 0; i < documentText.length; i += (CHUNK - OVL)) {
            chunks.push(documentText.slice(i, i + CHUNK));
            if (i + CHUNK >= documentText.length) break;
        }
        const results = await Promise.allSettled(
            chunks.map((chunk, idx) => segmentFromChunk(chunk, getNextKey(), idx, docContextStr))
        );
        raw = results
            .filter(r => r.status === 'fulfilled' && Array.isArray(r.value))
            .flatMap(r => r.value);
    }
    // Нормализация: фильтр пустых, дедуп по heading+первые 60 символов text,
    // присваиваем стабильные id вида seg_N.
    const seen = new Set();
    const segments = [];
    for (const s of raw) {
        if (!s || typeof s !== 'object') continue;
        const text = String(s.text || '').trim();
        const heading = String(s.heading || '').trim();
        if (text.length < SEGMENT_MIN_CHARS) continue;
        const dedupKey = `${heading.toLowerCase()}|${text.slice(0, 60).toLowerCase()}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        segments.push({
            id: `seg_${segments.length}`,
            number: String(s.number || segments.length + 1),
            heading: heading || 'Пункт',
            text
        });
        if (segments.length >= limit) break;
    }
    console.log(`[Segmenter] raw=${raw.length} → final=${segments.length} (limit=${limit})`);
    return segments;
}



// ════════════════════════════════════════════════════════════════════
// DEEP ANALYSIS (PRO) — мульти-агентная архитектура «Senior + Workers»
// ════════════════════════════════════════════════════════════════════
// Router-Worker pattern для премиум-разбора документа:
//   • Workers (Gemini Flash, параллельно):
//       - Auditor: redFlags + collisions + procKiller + factCheck
//       - Strategist: heatmap + counterargs (Pinecone-перекрытия per-threat)
//   • Senior Partner: финальный синтез verdict + factSummary
// MVP = Аудитор + Стратег. Драфтер/Ментор подключим следующим раундом.
// ════════════════════════════════════════════════════════════════════

// Парсит JSON из ответа LLM с защитой от markdown-обёрток и обрывов.
function safeJsonParse(rawText, fallback = null) {
    if (!rawText) return fallback;
    const cleaned = String(rawText).replace(/```json|```/g, '').trim();
    const fi = cleaned.indexOf('{');
    const li = cleaned.lastIndexOf('}');
    if (fi < 0 || li <= fi) return fallback;
    try { return JSON.parse(cleaned.slice(fi, li + 1)); }
    catch (e) { return fallback; }
}

// ── БЛОК А: АУДИТОР ─────────────────────────────────────────────────

// Red flags — юридические ловушки и подозрительные условия в документе.
// Возвращает массив [{title, severity, quote, suggestion}].
async function auditRedFlags(documentText, docContextStr, perspective) {
    const ctxLine = docContextStr ? `Контекст документа: ${docContextStr}\n\n` : '';
    const perspLine = perspective === 'opponent'
        ? 'Документ ПРОТИВ нашего клиента — ищи невыгодные ему условия особенно тщательно.'
        : perspective === 'ours'
            ? 'Документ ОТ нашего клиента — оцени риски, которые могут выстрелить против нас.'
            : 'Нейтральный аудит — выявляй риски обеих сторон.';
    const systemPrompt = `Ты — корпоративный юрист КР, эксперт по обнаружению ловушек в документах.
Ищешь red flags: завышенные неустойки/штрафы, невыгодная подсудность (особенно в РФ/Казахстане),
односторонний выход без компенсации, навязанные арбитражи, отказ от прав, неясные формулировки,
скрытые автопролонгации, кабальные условия, дискриминационные пункты.
Не пиши о законодательстве других стран как применимом. Отвечаешь СТРОГО JSON без markdown.`;
    const userPrompt = `${ctxLine}${perspLine}

Найди в документе юридические ловушки и подозрительные условия (red flags).
Для каждой укажи:
- title    — короткое название (3-7 слов)
- severity — "high" | "medium" | "low"
- quote    — дословная цитата из документа (до 200 символов)
- suggestion — короткая рекомендация что делать (1 предложение)

Формат:
{
  "red_flags": [
    { "title": "...", "severity": "high|medium|low", "quote": "...", "suggestion": "..." }
  ]
}

Если ловушек нет — верни {"red_flags": []}. До 8 штук максимум.

Документ:
"""
${(documentText || '').slice(0, 14000)}
"""`;
    try {
        const raw = await callOnce(getNextKey(), systemPrompt, userPrompt, 1);
        const parsed = safeJsonParse(raw, { red_flags: [] });
        const arr = Array.isArray(parsed.red_flags) ? parsed.red_flags : [];
        return arr.slice(0, 8).map(rf => ({
            title:      String(rf.title || '').slice(0, 120).trim(),
            severity:   ['high','medium','low'].includes(rf.severity) ? rf.severity : 'medium',
            quote:      String(rf.quote || '').slice(0, 220).trim(),
            suggestion: String(rf.suggestion || '').slice(0, 240).trim()
        })).filter(rf => rf.title);
    } catch (e) {
        console.error('[Audit:redFlags] failed:', e.message);
        return [];
    }
}

// Collisions — внутренние противоречия между пунктами документа.
// Возвращает [{refA, refB, description, severity}].
async function auditCollisions(segments) {
    if (!segments || segments.length < 2) return [];
    // Готовим компактный список пунктов: номер + заголовок + первые 240 символов
    const compactList = segments.slice(0, 25).map(s =>
        `[п.${s.number}] ${s.heading}: ${String(s.text || '').slice(0, 240)}`
    ).join('\n');
    const systemPrompt = `Ты — юридический аудитор. Находишь внутренние противоречия между пунктами одного документа.
Ищешь: пункты которые отрицают друг друга, разные сроки на одно и то же, противоречивые
обязательства, несовместимые условия выхода, конфликтующие штрафы.
Отвечаешь СТРОГО JSON без markdown.`;
    const userPrompt = `Найди внутренние коллизии (противоречия) между пунктами документа.
Если коллизий нет — верни {"collisions": []}.

Формат:
{
  "collisions": [
    { "refA": "п. 5.2", "refB": "п. 8.1", "description": "Один говорит X, другой Y", "severity": "high|medium|low" }
  ]
}

Список пунктов:
${compactList}`;
    try {
        const raw = await callOnce(getNextKey(), systemPrompt, userPrompt, 1);
        const parsed = safeJsonParse(raw, { collisions: [] });
        const arr = Array.isArray(parsed.collisions) ? parsed.collisions : [];
        return arr.slice(0, 6).map(c => ({
            refA:        String(c.refA || '').slice(0, 60).trim(),
            refB:        String(c.refB || '').slice(0, 60).trim(),
            description: String(c.description || '').slice(0, 320).trim(),
            severity:    ['high','medium','low'].includes(c.severity) ? c.severity : 'medium'
        })).filter(c => c.description);
    } catch (e) {
        console.error('[Audit:collisions] failed:', e.message);
        return [];
    }
}

// Proc Killer — формальные процессуальные ошибки и пропущенные сроки.
async function auditProcKiller(documentText, docContextStr, perspective) {
    const ctxLine = docContextStr ? `Контекст документа: ${docContextStr}\n\n` : '';
    const perspLine = perspective === 'opponent'
        ? 'Документ ПРОТИВ нас. Ищи формальные дефекты в позиции оппонента — это рычаги для отвода.'
        : perspective === 'ours'
            ? 'Документ НАШ. Ищи слабые места которые суд может назвать дефектными.'
            : 'Нейтральная проверка формальной корректности.';
    const systemPrompt = `Ты — процессуалист КР. Проверяешь документ на ФОРМАЛЬНЫЕ дефекты:
- неверные/отсутствующие реквизиты сторон, дат, подписей
- пропущенные процессуальные сроки (давность, отзыв, апелляция)
- отсутствие обязательных приложений
- неверная подсудность, форма документа
- отсутствие полномочий подписанта
- нарушение претензионного порядка
Отвечаешь СТРОГО JSON без markdown.`;
    const userPrompt = `${ctxLine}${perspLine}

Найди процессуальные дефекты в документе. Для каждого:
- type        — категория (пропущенный срок / отсутствующий реквизит / неверная подсудность / нарушение порядка / др.)
- title       — короткое описание (4-8 слов)
- description — что именно неправильно (1-2 предложения)
- deadline    — конкретный срок если применимо ("истёк 10.05.2026" / "осталось 5 дней"), иначе null

Формат:
{
  "proc_issues": [
    { "type": "...", "title": "...", "description": "...", "deadline": null }
  ]
}

Если дефектов нет — верни {"proc_issues": []}.

Документ:
"""
${(documentText || '').slice(0, 14000)}
"""`;
    try {
        const raw = await callOnce(getNextKey(), systemPrompt, userPrompt, 1);
        const parsed = safeJsonParse(raw, { proc_issues: [] });
        const arr = Array.isArray(parsed.proc_issues) ? parsed.proc_issues : [];
        return arr.slice(0, 6).map(p => ({
            type:        String(p.type || '').slice(0, 60).trim(),
            title:       String(p.title || '').slice(0, 140).trim(),
            description: String(p.description || '').slice(0, 320).trim(),
            deadline:    p.deadline ? String(p.deadline).slice(0, 80).trim() : null
        })).filter(p => p.title);
    } catch (e) {
        console.error('[Audit:procKiller] failed:', e.message);
        return [];
    }
}

// ── БЛОК Б: СТРАТЕГ ─────────────────────────────────────────────────

// Тепловая карта — для каждого пункта оценка: strong/neutral/risk/threat/bluff.
async function strategyHeatmap(segments, perspective, docContextStr) {
    if (!segments || segments.length === 0) return [];
    const ctxLine = docContextStr ? `Контекст документа: ${docContextStr}\n` : '';
    const perspLine = perspective === 'opponent'
        ? 'Документ ПРОТИВ нашего клиента — оценивай каждый пункт с позиции защиты: что атакует нас, где блефует оппонент.'
        : perspective === 'ours'
            ? 'Документ НАШЕГО клиента — оценивай каждый пункт как наш аргумент: что сильно, где риск проигрыша.'
            : 'Нейтрально: оценивай каждый пункт по его юридической силе и рискам.';
    const compactList = segments.slice(0, 25).map(s =>
        `[п.${s.number}] ${s.heading}: ${String(s.text || '').slice(0, 200)}`
    ).join('\n');
    const systemPrompt = `Ты — стратег судебных процессов КР. Делаешь тепловую карту документа: для каждого
пункта присваиваешь tone и короткий комментарий с точки зрения юридической силы.

Tones:
- strong  — пункт сильно работает в нашу пользу
- neutral — нейтральный/процедурный пункт без критической нагрузки
- risk    — есть юридический риск, требует внимания
- threat  — серьёзная угроза, нужно контраргумент или защита
- bluff   — оппонент ссылается на нерелевантные нормы / запугивает

Отвечаешь СТРОГО JSON без markdown.`;
    const userPrompt = `${ctxLine}${perspLine}

Оцени каждый пункт по тону и дай короткий комментарий (1 предложение).

Формат:
{
  "heatmap": [
    { "number": "1", "heading": "Предмет договора", "tone": "neutral", "comment": "Стандартная норма, рисков нет." },
    { "number": "5.2", "heading": "Неустойка", "tone": "threat", "comment": "Размер неустойки 50% — кабальный, можно оспорить." }
  ]
}

Пункты документа:
${compactList}`;
    try {
        const raw = await callOnce(getNextKey(), systemPrompt, userPrompt, 1);
        const parsed = safeJsonParse(raw, { heatmap: [] });
        const arr = Array.isArray(parsed.heatmap) ? parsed.heatmap : [];
        const VALID = ['strong','neutral','risk','threat','bluff'];
        return arr.slice(0, 25).map(h => ({
            number:  String(h.number || '').slice(0, 30).trim(),
            heading: String(h.heading || 'Пункт').slice(0, 80).trim(),
            tone:    VALID.includes(h.tone) ? h.tone : 'neutral',
            comment: String(h.comment || '').slice(0, 240).trim()
        })).filter(h => h.number || h.heading);
    } catch (e) {
        console.error('[Strategy:heatmap] failed:', e.message);
        return [];
    }
}

// Counterargs — для каждой угрозы 1 Pinecone + 1 LLM-выжимка нормы-перекрытия.
// Параллельно через Promise.allSettled.
//
// ВАЖНО про perspective polarity (баг был — ловили норму ПРОТИВ нашей стороны):
// heatmap часто пишет comment как «пункт кабальный, суд снизит» — это уже наша
// позиция. Если просто скормить comment как «угрозу» — LLM думает что наша же
// позиция и есть атака на нас, и выдаёт норму защищающую *оппонента*.
// Поэтому здесь:
//   1) embedding-запрос делается ТОЛЬКО по нейтральному heading пункта
//      (без полит. комментария который сместит вектор)
//   2) В user-prompt пункт документа подаётся как «ПУНКТ» (нейтрально),
//      а heatmap-комментарий — как «оценка аналитика», не как «threat to counter»
//   3) System-prompt жёстко фиксирует нашу сторону + запрет на аргументы
//      от лица противоположной стороны
async function strategyCounterargs(threats, perspective, docContextStr) {
    if (!threats || threats.length === 0) return [];
    const ctxPrefix = docContextStr ? `[Контекст: ${docContextStr.slice(0, 160)}] ` : '';

    const sideDef = perspective === 'opponent'
        ? {
            who:    'НАША СТОРОНА — клиент ПРОТИВ которого направлен документ. Документ нам ВРЕДИТ, мы защищаемся от его условий.',
            need:   'ОСПОРИТЬ / ОГРАНИЧИТЬ / СНИЗИТЬ действие этого пункта',
            forbid: 'ЗАПРЕЩЕНО формулировать аргумент в пользу пункта или в защиту автора документа.',
            qDir:   'оспорить ограничить признать ничтожным'
        }
        : perspective === 'ours'
            ? {
                who:    'НАША СТОРОНА — автор документа. Документ ОТРАЖАЕТ нашу позицию, мы защищаем её законность.',
                need:   'ПОДКРЕПИТЬ / ОБОСНОВАТЬ законность этого пункта',
                forbid: 'ЗАПРЕЩЕНО формулировать аргумент против пункта или в пользу контрагента.',
                qDir:   'обосновать подтвердить законность правомерность'
            }
            : {
                who:    'НЕЙТРАЛЬНАЯ ОЦЕНКА — мы ищем юридические рамки которые регулируют этот пункт.',
                need:   'указать норму которая РЕГУЛИРУЕТ или ОГРАНИЧИВАЕТ этот пункт',
                forbid: 'Не занимай сторону — описывай только применимую норму.',
                qDir:   'регулирует ограничивает рамки'
            };

    const promises = threats.slice(0, 6).map(async (t, i) => {
        const clauseHeading = t.heading || 'пункт документа';
        // Нейтральный embedding-запрос — БЕЗ комментария аналитика (он смещает вектор
        // к статьям подкрепляющим нашу же позицию вместо защиты от пункта).
        const query = (ctxPrefix + `Норма КР ${sideDef.qDir} условие договора: ${clauseHeading}`).slice(0, 350);
        try {
            const vec = await getEmbedding(query);
            const candidates = await searchPinecone(vec, 5);
            const top = (candidates || []).filter(c => c.metadata?.full_text).slice(0, 3);
            if (top.length === 0) return null;

            const articlesText = top.map((c, k) => `[${k+1}] ${c.metadata?.npa_title || ''} — ${c.metadata?.article_title || ''}\n${(c.metadata?.full_text || '').slice(0, 800)}`).join('\n\n');

            const sysP = `Ты — юрист-стратег КР, играешь на стороне конкретного клиента.

${sideDef.who}

ЗАДАЧА: по конкретному пункту документа выбираешь ОДНУ норму из списка которая работает В НАШУ ПОЛЬЗУ
(${sideDef.need}) и формулируешь короткий юр.аргумент (1-2 предложения) С НАШЕЙ СТОРОНЫ.

${sideDef.forbid}
Если ни одна из предложенных норм нашу сторону не поддерживает — всё равно выбирай ту что ближе по теме,
но в аргументе честно отмечай "норма частично применима" или "оспаривается через статью X".

Отвечаешь СТРОГО JSON без markdown.`;

            const userP = `${sideDef.who}

ПУНКТ ДОКУМЕНТА который мы анализируем:
  Название: «${clauseHeading}»${t.number ? ` (п.${t.number})` : ''}
${t.comment ? `  Юр.оценка аналитика (не аргумент, а наблюдение): ${t.comment}` : ''}

ЦЕЛЬ: ${sideDef.need}.

Кандидаты статей КР (выбери одну, индекс 1-${top.length}):
${articlesText}

Формат:
{
  "best_index": 1,
  "argument": "1-2 предложения юр.аргумента ИМЕННО С НАШЕЙ СТОРОНЫ (см. кто мы выше)"
}`;
            const raw = await callOnce(getNextKey(), sysP, userP, 1);
            const parsed = safeJsonParse(raw, {});
            const idx = Number(parsed.best_index) - 1;
            const pick = (Number.isInteger(idx) && top[idx]) ? top[idx] : top[0];
            return {
                threat:   String(t.comment || t.heading || '').slice(0, 200),
                citation: `${pick.metadata?.npa_title || 'НПА'} — ${pick.metadata?.article_title || ''}`,
                norm:     String(pick.metadata?.full_text || '').slice(0, 240),
                argument: String(parsed.argument || '').slice(0, 320).trim()
            };
        } catch (e) {
            console.error(`[Strategy:counterarg ${i}] failed:`, e.message);
            return null;
        }
    });
    const results = await Promise.allSettled(promises);
    return results
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value);
}

// ── БЛОК В: ДРАФТЕР ─────────────────────────────────────────────────

// Генерирует процессуальный документ-ответ на основе всех выводов Аудитора и Стратега.
// В зависимости от perspective:
//   opponent → отзыв на иск / возражение / контр-претензия
//   ours     → шаблон позиции в защиту нашего документа
//   audit    → краткое заключение-меморандум
// Возвращает { docType, title, body (markdown), notes[] }
async function drafterGenerate(docContext, userQuery, perspective, auditResults, strategyResults) {
    const targetDoc = perspective === 'opponent'
        ? 'Отзыв/возражение на этот документ (если иск — отзыв; если претензия — контр-претензия; если требование — мотивированный отказ)'
        : perspective === 'ours'
            ? 'Меморандум-позиция в защиту нашего документа (как отбиваться, если контрагент атакует пункты)'
            : 'Юридический меморандум для внутреннего использования с выводами и рекомендациями';

    const inputBlocks = [];
    if (docContext) {
        inputBlocks.push(`ПАСПОРТ ИСХОДНОГО ДОКУМЕНТА: ${formatDocContext(docContext)}`);
    }
    if (userQuery) {
        inputBlocks.push(`ЗАПРОС ЮРИСТА: «${userQuery}»`);
    }
    if (auditResults) {
        const a = [];
        if (auditResults.redFlags?.length) {
            a.push('Red flags (для атаки):\n' + auditResults.redFlags.slice(0, 6).map((rf, i) =>
                `${i + 1}. [${rf.severity}] ${rf.title} — ${rf.suggestion || ''} (цитата: «${(rf.quote || '').slice(0, 120)}»)`
            ).join('\n'));
        }
        if (auditResults.collisions?.length) {
            a.push('Внутренние коллизии:\n' + auditResults.collisions.map((c, i) =>
                `${i + 1}. ${c.refA} ↔ ${c.refB}: ${c.description}`
            ).join('\n'));
        }
        if (auditResults.procIssues?.length) {
            a.push('Процессуальные дефекты:\n' + auditResults.procIssues.map((p, i) =>
                `${i + 1}. [${p.type}] ${p.title}${p.deadline ? ` (${p.deadline})` : ''} — ${p.description || ''}`
            ).join('\n'));
        }
        if (auditResults.factResults?.length) {
            const verifiable = auditResults.factResults.filter(f => f.status === 'verified').slice(0, 6);
            if (verifiable.length) {
                a.push('Подтверждённые статьи (можно цитировать):\n' + verifiable.map((f, i) =>
                    `${i + 1}. ${f.npa || ''} ст. ${f.number || ''} — ${(f.title || '').slice(0, 80)}`
                ).join('\n'));
            }
        }
        if (a.length) inputBlocks.push(`═══ ВЫВОДЫ АУДИТОРА ═══\n${a.join('\n\n')}`);
    }
    if (strategyResults) {
        const s = [];
        if (strategyResults.counterArgs?.length) {
            s.push('Контраргументы со статьями:\n' + strategyResults.counterArgs.map((c, i) =>
                `${i + 1}. Угроза: «${c.threat}»\n   Норма: ${c.citation}\n   Аргумент: ${c.argument}`
            ).join('\n\n'));
        }
        if (strategyResults.heatmap?.length) {
            const threats = strategyResults.heatmap.filter(h => h.tone === 'threat').slice(0, 4);
            if (threats.length) {
                s.push('Главные угрозы (нужно опровергнуть):\n' + threats.map((t, i) =>
                    `${i + 1}. п.${t.number} ${t.heading}: ${t.comment}`
                ).join('\n'));
            }
        }
        if (s.length) inputBlocks.push(`═══ ВЫВОДЫ СТРАТЕГА ═══\n${s.join('\n\n')}`);
    }

    const systemPrompt = `Ты — практикующий судебный юрист КР, готовишь процессуальные документы.
Пишешь готовый к использованию документ на основе выводов команды (Аудитор+Стратег).

═══ ПРАВИЛА ═══
- Цитируешь ТОЛЬКО те статьи, что указаны во "ВЫВОДАХ" — не выдумываешь нормы.
- Структурируй документ профессионально: преамбула → фактические обстоятельства →
  правовое обоснование (со ссылками на нормы) → требования/просьба.
- Используешь markdown для структуры (## заголовки, **жирный**, нумерованные списки).
- Пишешь на русском, языком процессуальных документов КР.
- Если данных мало — честно отмечаешь "[требует уточнения от юриста]".

═══ ФОРМАТ ОТВЕТА — СТРОГО JSON ═══
{
  "title": "Название документа (1 строка, например: «Отзыв на исковое заявление о взыскании задолженности»)",
  "body":  "Полный текст документа в markdown (15-50 строк, можно длиннее если задача требует)",
  "notes": ["1-3 коротких заметки для юриста: что подставить, что уточнить, на что обратить внимание"]
}`;

    const userPrompt = `Перспектива: ${perspective}.
Целевой документ: ${targetDoc}.

${inputBlocks.join('\n\n')}

Сформируй документ.`;
    try {
        const raw = await generateContentResilient({
            systemInstruction: systemPrompt,
            userPrompt,
            generationConfig: { temperature: 0.35, topP: 0.9, maxOutputTokens: 3500 },
            maxRetries: 3
        });
        const parsed = safeJsonParse(raw, {});
        const notes = Array.isArray(parsed.notes) ? parsed.notes.slice(0, 5).map(n => String(n).slice(0, 240).trim()).filter(Boolean) : [];
        return {
            docType: perspective === 'opponent' ? 'response' : perspective === 'ours' ? 'memo' : 'memorandum',
            title:   String(parsed.title || 'Документ').slice(0, 200).trim(),
            body:    String(parsed.body  || '').trim(),
            notes
        };
    } catch (e) {
        console.error('[Drafter] failed:', e.message);
        return null;
    }
}

// ── БЛОК Г: МЕНТОР ──────────────────────────────────────────────────

// Симулирует атаки оппонента — какие аргументы он выдвинет против нас.
// Возвращает [{ attack, weakSpot, ourResponse }]
async function mentorOpponentSim(documentText, docContextStr, perspective, strategyResults) {
    const ctxLine = docContextStr ? `Контекст документа: ${docContextStr}\n` : '';
    const perspLine = perspective === 'opponent'
        ? 'Документ ПРОТИВ нашего клиента. Симулируй как ИСТЕЦ будет атаковать нашу будущую защиту.'
        : perspective === 'ours'
            ? 'Документ НАШЕГО клиента. Симулируй как ОППОНЕНТ будет атаковать наш документ в суде.'
            : 'Симулируй стандартные атаки оппонента на этот документ в спорной ситуации.';

    const ourStrengths = strategyResults?.counterArgs?.length
        ? `\nНаши контраргументы (на них оппонент будет давить):\n` + strategyResults.counterArgs.slice(0, 4).map((c, i) =>
            `${i + 1}. ${c.citation}: ${c.argument}`
        ).join('\n')
        : '';

    const systemPrompt = `Ты — опытный судебный юрист, играешь роль «адвоката дьявола».
Твоя задача — встать на сторону оппонента и придумать самые острые атаки на нашу позицию.
Это спарринг-сессия: чем жёстче атаки, тем лучше юрист подготовится.

Отвечаешь СТРОГО JSON без markdown.`;

    const userPrompt = `${ctxLine}${perspLine}

Сгенерируй 3-5 атак оппонента. Для каждой:
- attack       — конкретный аргумент оппонента (1-2 предложения, цитируй нормы если уместно)
- weakSpot     — какое наше слабое место он эксплуатирует (1 предложение)
- ourResponse  — как мы должны отвечать на эту атаку (1-2 предложения)

Формат:
{
  "attacks": [
    { "attack": "...", "weakSpot": "...", "ourResponse": "..." }
  ]
}
${ourStrengths}

Документ:
"""
${(documentText || '').slice(0, 10000)}
"""`;
    try {
        const raw = await callOnce(getNextKey(), systemPrompt, userPrompt, 1);
        const parsed = safeJsonParse(raw, { attacks: [] });
        const arr = Array.isArray(parsed.attacks) ? parsed.attacks : [];
        return arr.slice(0, 5).map(a => ({
            attack:      String(a.attack || '').slice(0, 400).trim(),
            weakSpot:    String(a.weakSpot || '').slice(0, 240).trim(),
            ourResponse: String(a.ourResponse || '').slice(0, 400).trim()
        })).filter(a => a.attack);
    } catch (e) {
        console.error('[Mentor:opponentSim] failed:', e.message);
        return [];
    }
}

// Симулирует вопросы судьи — что суд может спросить на заседании.
// Возвращает [{ question, whyAsked, suggestedAnswer }]
async function mentorJudgeSim(documentText, docContextStr, perspective, auditResults) {
    const ctxLine = docContextStr ? `Контекст документа: ${docContextStr}\n` : '';

    const weakPoints = [];
    if (auditResults?.redFlags?.length) {
        auditResults.redFlags.slice(0, 3).forEach(rf => weakPoints.push(`Red flag: ${rf.title}`));
    }
    if (auditResults?.procIssues?.length) {
        auditResults.procIssues.slice(0, 2).forEach(p => weakPoints.push(`Проц.дефект: ${p.title}`));
    }
    const weakBlock = weakPoints.length
        ? `\nИзвестные слабые места (вокруг них суд будет копать):\n- ${weakPoints.join('\n- ')}`
        : '';

    const systemPrompt = `Ты — опытный судья КР. По документу формулируешь вопросы которые задал бы
сторонам на заседании. Вопросы должны быть конкретными, по существу, отражать слабые места.
Отвечаешь СТРОГО JSON без markdown.`;

    const userPrompt = `${ctxLine}
Перспектива стороны: ${perspective === 'ours' ? 'наш клиент' : perspective === 'opponent' ? 'противная сторона' : 'нейтральная оценка'}

Сгенерируй 3-5 вопросов суда. Для каждого:
- question         — вопрос судьи (1-2 предложения)
- whyAsked         — почему суд именно это спросит (1 предложение)
- suggestedAnswer  — рекомендуемый ответ нашей стороны (1-2 предложения)

Формат:
{
  "questions": [
    { "question": "...", "whyAsked": "...", "suggestedAnswer": "..." }
  ]
}
${weakBlock}

Документ:
"""
${(documentText || '').slice(0, 10000)}
"""`;
    try {
        const raw = await callOnce(getNextKey(), systemPrompt, userPrompt, 1);
        const parsed = safeJsonParse(raw, { questions: [] });
        const arr = Array.isArray(parsed.questions) ? parsed.questions : [];
        return arr.slice(0, 5).map(q => ({
            question:        String(q.question || '').slice(0, 320).trim(),
            whyAsked:        String(q.whyAsked || '').slice(0, 240).trim(),
            suggestedAnswer: String(q.suggestedAnswer || '').slice(0, 400).trim()
        })).filter(q => q.question);
    } catch (e) {
        console.error('[Mentor:judgeSim] failed:', e.message);
        return [];
    }
}

// ── SENIOR PARTNER: синтез verdict + factSummary из всех выводов ─────
const SENIOR_PARTNER_PROMPT = `Ты — **Старший партнёр** юридической фирмы КР. Опытный стратег, готовишь итоговое заключение
для младшего юриста (пользователя) по результатам работы команды младших агентов (Аудитор, Стратег).

═══ ИСТОЧНИК ИСТИНЫ ═══
Ты НЕ ищешь нормы сам — все факты и статьи приходят от младших агентов в "ОТЧЁТЕ КОМАНДЫ".
Если номера/нормы нет в отчёте — ты не знаешь её и не упоминаешь.

═══ ПОЛЬЗОВАТЕЛЬ — ЮРИСТ ═══
Не пиши "обратитесь к юристу" — пользователь сам юрист. Дай стратегическое заключение.
Дисклеймер опционально, формат: "Перед использованием в производстве сверьте номера с cbd.minjust.gov.kg".

═══ ФОРМАТ ОТВЕТА — СТРОГО JSON ═══
{
  "verdict": "markdown 3-6 предложений: общая оценка позиции, главные риски и сильные стороны",
  "factSummary": "markdown 1-3 предложения: краткий итог фактчека статей"
}

═══ ТОН ═══
Профессиональный, конкретный, без воды. Если perspective='opponent' — пиши с позиции защиты.
Если 'ours' — с позиции нашего клиента. Если 'audit' — нейтрально.
Не упоминай внутреннюю кухню (ИИ-агентов, «отчёт команды», базы данных,
Pinecone, RAG) — пиши как живой старший партнёр о результате своей работы.`;

// Senior Partner НЕ получает сырой текст документа — только отчёты агентов.
// Это сознательное архитектурное решение: исключает дублирование контекста
// и риск того, что Senior будет искать факты в исходнике в обход worker'ов.
async function seniorPartnerSynthesis(docContext, perspective, userQuery, auditResults, strategyResults) {
    const blocks = [];
    if (docContext) {
        blocks.push(`ПАСПОРТ ДОКУМЕНТА: ${formatDocContext(docContext)}`);
    }
    if (auditResults) {
        const a = [];
        if (auditResults.factSummary) a.push(`Фактчек: ${auditResults.factSummary}`);
        if (auditResults.redFlags?.length) {
            a.push(`Red flags (${auditResults.redFlags.length}):\n` + auditResults.redFlags.slice(0, 6).map((rf, i) =>
                `${i + 1}. [${rf.severity}] ${rf.title} — ${rf.suggestion || rf.quote?.slice(0, 80) || ''}`
            ).join('\n'));
        }
        if (auditResults.collisions?.length) {
            a.push(`Коллизии (${auditResults.collisions.length}):\n` + auditResults.collisions.map((c, i) =>
                `${i + 1}. ${c.refA} ↔ ${c.refB}: ${c.description}`
            ).join('\n'));
        }
        if (auditResults.procIssues?.length) {
            a.push(`Процессуальные дефекты (${auditResults.procIssues.length}):\n` + auditResults.procIssues.map((p, i) =>
                `${i + 1}. [${p.type}] ${p.title}${p.deadline ? ` (${p.deadline})` : ''}`
            ).join('\n'));
        }
        if (a.length) blocks.push(`═══ ОТЧЁТ АУДИТОРА ═══\n${a.join('\n\n')}`);
    }
    if (strategyResults) {
        const s = [];
        if (strategyResults.heatmap?.length) {
            const counts = strategyResults.heatmap.reduce((acc, h) => { acc[h.tone] = (acc[h.tone] || 0) + 1; return acc; }, {});
            s.push(`Тепловая карта (${strategyResults.heatmap.length} пунктов): ` +
                Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · '));
            const threats = strategyResults.heatmap.filter(h => h.tone === 'threat' || h.tone === 'risk').slice(0, 5);
            if (threats.length) {
                s.push('Ключевые угрозы:\n' + threats.map((t, i) =>
                    `${i + 1}. [п.${t.number}] ${t.heading}: ${t.comment}`
                ).join('\n'));
            }
        }
        if (strategyResults.counterArgs?.length) {
            s.push(`Контраргументы (${strategyResults.counterArgs.length}):\n` + strategyResults.counterArgs.map((c, i) =>
                `${i + 1}. ${c.citation} → ${c.argument}`
            ).join('\n'));
        }
        if (s.length) blocks.push(`═══ ОТЧЁТ СТРАТЕГА ═══\n${s.join('\n\n')}`);
    }

    const perspLine = {
        ours:     'Перспектива: защищаем нашего клиента.',
        opponent: 'Перспектива: документ ПРОТИВ нашего клиента — стратегия защиты.',
        audit:    'Перспектива: нейтральный аудит документа.'
    }[perspective] || '';

    const userPrompt = `${perspLine}
${userQuery ? `Запрос пользователя-юриста: «${userQuery}»\n` : ''}
${blocks.join('\n\n')}

Сформируй итоговое заключение Старшего партнёра в формате JSON.`;
    try {
        // JUDGE tier — DeepSeek V4 Pro с reasoning. Внутри есть fallback на
        // Gemini SENIOR (3.1-flash) если DeepSeek не настроен или упал.
        const raw = await deepseekCall({
            systemInstruction: SENIOR_PARTNER_PROMPT,
            userPrompt,
            temperature: 0.25,
            maxRetries: 2
        });
        const parsed = safeJsonParse(raw, {});
        return {
            verdict:     String(parsed.verdict || '').trim(),
            factSummary: String(parsed.factSummary || '').trim()
        };
    } catch (e) {
        console.error('[SeniorPartner] failed:', e.message);
        return { verdict: '', factSummary: '' };
    }
}

// ── ОРКЕСТРАТОР ──────────────────────────────────────────────────────
async function runDeepAnalysis(documentText, userQuery, perspective, modules, res) {
    const startTime = Date.now();
    try {
        // Этап 0: паспорт документа + сегментация (переиспользуем из обычного pipeline)
        sendStep(res, { id: 'context', status: 'loading', text: 'Определяю тип и предметную область' });
        sendStatus(res, '🧭 Определяю контекст документа...');
        const docContext = await extractDocumentContext(documentText);
        const docContextStr = formatDocContext(docContext);
        sendStep(res, {
            id: 'context',
            status: docContext ? 'success' : 'warning',
            text: docContext?.document_type || 'Контекст не определён',
            reason: docContext?.subject_area || null
        });

        sendStep(res, { id: 'segment', status: 'loading', text: 'Разбиваю документ на пункты' });
        const segments = await segmentDocument(documentText, docContextStr);
        sendStep(res, {
            id: 'segment',
            status: segments.length ? 'success' : 'warning',
            text: segments.length ? `Пунктов: ${segments.length}` : 'Не удалось разбить'
        });

        const runAudit    = modules.includes('audit');
        const runStrategy = modules.includes('strategy');
        const runDrafter  = modules.includes('drafter');
        const runMentor   = modules.includes('mentor');
        let auditResults = null, strategyResults = null;
        let drafterResult = null, mentorResult = null;

        const tasks = [];

        if (runAudit) {
            tasks.push((async () => {
                sendStep(res, { id: 'audit', status: 'loading', text: 'Аудитор: red flags + коллизии + проц.ошибки + фактчек' });
                const [rfR, colR, prR, factR] = await Promise.allSettled([
                    auditRedFlags(documentText, docContextStr, perspective),
                    auditCollisions(segments),
                    auditProcKiller(documentText, docContextStr, perspective),
                    (async () => {
                        const articles = await extractArticles(documentText);
                        if (articles.length === 0) return { summary: '', results: [] };
                        const results = await verifyAllArticles(articles, null);
                        const conf = calculateConfidence(results);
                        return {
                            summary: `Проверено статей: **${conf.total}** · ✅ ${conf.verified} · ⚠️ ${conf.mismatched} · ❌ ${conf.notFound}.`,
                            results: results.map(buildArticleDetail)
                        };
                    })()
                ]);
                const redFlags   = rfR.status   === 'fulfilled' ? rfR.value   : [];
                const collisions = colR.status  === 'fulfilled' ? colR.value  : [];
                const procIssues = prR.status   === 'fulfilled' ? prR.value   : [];
                const factCheck  = factR.status === 'fulfilled' ? factR.value : { summary: '', results: [] };
                auditResults = { factSummary: factCheck.summary, factResults: factCheck.results, redFlags, collisions, procIssues };
                sendStep(res, {
                    id: 'audit',
                    status: 'success',
                    text: `Аудит готов: ${redFlags.length} red-flags · ${collisions.length} коллизий · ${procIssues.length} проц.дефектов`
                });
            })());
        }

        if (runStrategy) {
            tasks.push((async () => {
                sendStep(res, { id: 'strategy', status: 'loading', text: 'Стратег: тепловая карта + контраргументы' });
                const heatmap = await strategyHeatmap(segments, perspective, docContextStr);
                const threats = heatmap.filter(h => h.tone === 'threat' || h.tone === 'risk').slice(0, 6);
                const counterArgs = threats.length > 0
                    ? await strategyCounterargs(threats, perspective, docContextStr)
                    : [];
                strategyResults = { heatmap, counterArgs };
                sendStep(res, {
                    id: 'strategy',
                    status: 'success',
                    text: `Стратегия готова: ${heatmap.length} пунктов · ${counterArgs.length} контраргументов`
                });
            })());
        }

        // Этап 1: Аудитор + Стратег запускаются параллельно (Аудитор+Стратег независимы)
        await Promise.allSettled(tasks);

        // Этап 2: Драфтер и Ментор зависят от Аудитора/Стратега, но между собой параллельны
        const dependentTasks = [];

        if (runDrafter) {
            dependentTasks.push((async () => {
                sendStep(res, { id: 'drafter', status: 'loading', text: 'Драфтер: готовит документ-ответ' });
                drafterResult = await drafterGenerate(docContext, userQuery, perspective, auditResults, strategyResults);
                sendStep(res, {
                    id: 'drafter',
                    status: drafterResult ? 'success' : 'warning',
                    text: drafterResult ? `Документ готов: «${drafterResult.title.slice(0, 80)}»` : 'Документ не сформирован'
                });
            })());
        }

        if (runMentor) {
            dependentTasks.push((async () => {
                sendStep(res, { id: 'mentor', status: 'loading', text: 'Ментор: симуляция оппонента и судьи' });
                const [opR, jR] = await Promise.allSettled([
                    mentorOpponentSim(documentText, docContextStr, perspective, strategyResults),
                    mentorJudgeSim(documentText, docContextStr, perspective, auditResults)
                ]);
                const attacks  = opR.status === 'fulfilled' ? opR.value : [];
                const judgeQs  = jR.status === 'fulfilled' ? jR.value : [];
                mentorResult = { attacks, judgeQuestions: judgeQs };
                sendStep(res, {
                    id: 'mentor',
                    status: 'success',
                    text: `Спарринг готов: ${attacks.length} атак · ${judgeQs.length} вопросов суда`
                });
            })());
        }

        if (dependentTasks.length) await Promise.allSettled(dependentTasks);

        // Senior Partner — синтез
        sendStep(res, { id: 'senior', status: 'loading', text: 'Старший партнёр формирует стратегию' });
        sendStatus(res, '⚖️ Старший партнёр формирует стратегию...');
        const synthesis = await seniorPartnerSynthesis(docContext, perspective, userQuery, auditResults, strategyResults);
        sendStep(res, { id: 'senior', status: 'success', text: 'Стратегия готова' });

        const deepReport = {
            perspective,
            docType: docContext?.document_type || null,
            audit: auditResults ? {
                factSummary: synthesis.factSummary || auditResults.factSummary || null,
                redFlags:    auditResults.redFlags,
                collisions:  auditResults.collisions,
                procIssues:  auditResults.procIssues
            } : null,
            strategy: strategyResults ? {
                verdict:     synthesis.verdict || null,
                heatmap:     strategyResults.heatmap,
                counterArgs: strategyResults.counterArgs
            } : null,
            drafter: drafterResult,
            mentor:  mentorResult
        };
        res.write(`data: ${JSON.stringify({ deepReport })}\n\n`);
        console.log(`[DeepAnalysis] Done in ${Date.now() - startTime}ms (perspective=${perspective}, modules=${modules.join(',')})`);
    } catch (err) {
        console.error('[runDeepAnalysis] fatal:', err);
        sendStep(res, { id: 'senior', status: 'error', text: 'Ошибка глубокого анализа' });
        res.write(`data: ${JSON.stringify({ text: '\n\n⚠️ Ошибка глубокого анализа: ' + (err && err.message || 'unknown') })}\n\n`);
    }
}

// ════════════════════════════════════════════════════════════════════
// POST /api/deep-analyze-document — Premium pipeline endpoint
// ════════════════════════════════════════════════════════════════════
app.post('/api/deep-analyze-document', requireClientToken, async (req, res) => {
    // requestTelemetry.run пробрасывает res по AsyncLocalStorage во все
    // вложенные LLM-вызовы — каждый эмитит свою token-телеметрию автоматически.
    return requestTelemetry.run({ res, label: 'deep-analyze' }, async () => {
    serverStats.totalRequests++;
    try {
        const {
            documentText = '',
            userQuery = '',
            perspective = 'audit',
            modules = ['audit', 'strategy']
        } = req.body || {};

        const trimmedLen = String(documentText || '').trim().length;
        if (trimmedLen < DOC_ANALYSIS_CONFIG.minDocumentLength) {
            return res.status(400).json({
                error: `Документ слишком короткий (${trimmedLen}/${DOC_ANALYSIS_CONFIG.minDocumentLength} символов).`
            });
        }
        const VALID_PERSP = ['ours', 'opponent', 'audit'];
        const persp = VALID_PERSP.includes(perspective) ? perspective : 'audit';
        const VALID_MODULES = ['audit', 'strategy', 'drafter', 'mentor'];
        const mods = Array.isArray(modules)
            ? modules.filter(m => VALID_MODULES.includes(m))
            : ['audit', 'strategy'];
        if (mods.length === 0) mods.push('audit', 'strategy');

        // PRIVACY: не логируем userQuery — может содержать ФИО / детали дела
        logger.info('deep-analyze-request', { docLen: documentText.length, perspective: persp, modules: mods, hasUserQuery: !!userQuery });

        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();

        await runDeepAnalysis(documentText, userQuery, persp, mods, res);

        res.write('data: [DONE]\n\n');
        res.end();
    } catch (error) {
        console.error('[/api/deep-analyze-document] global error:', error.message);
        try {
            res.write(`data: ${JSON.stringify({ text: '\n\nСистемная ошибка глубокого анализа. Повторите запрос.' })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        } catch {}
    }
    });
});

// ============================================================
// ГЛАВНЫЙ МАРШРУТ
// ============================================================
app.post('/api/chat', requireClientToken, async (req, res) => {
    return requestTelemetry.run({ res, label: 'chat' }, async () => {
    serverStats.totalRequests++;
    const tRouteStart = performance.now();
    let tRetrieval = 0;
    try {
        const { message, history, mode = 'fast', agentMode = false, userQuery = null, skipRetrieval = false, documentContext = null } = req.body;
        if (!message) return res.status(400).json({ reply: "Пусто" });

        logger.info('chat-request', { len: message.length, mode, agentMode, skipRetrieval, hasUserQuery: !!userQuery, docCtxLen: documentContext ? String(documentContext).length : 0 });

        // SSE headers с антибуферизацией Render
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        if (typeof res.flushHeaders === 'function') {
            res.flushHeaders();
        }

        // ════════════════════════════════════════════════════════════════
        // AGENT MODE
        // ════════════════════════════════════════════════════════════════
        if (agentMode) {
            await handleAgent(message, history, res, 0, userQuery, documentContext);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
        }

        if (mode === 'fast') {
            const casual = isCasualMessage(message);
            let retrievalResult = { core: [], context: [], all: [] };

            if (casual) {
                console.log("Режим: приветствие — retrieval пропущен");
            } else if (skipRetrieval) {
                console.log("Режим: skipRetrieval=true — retrieval пропущен (chunk-summarization)");
            } else {
                const tR0 = performance.now();
                const queryForFast = (userQuery && userQuery.trim()) || message;
                const fastSource = classifyQuerySource(queryForFast);
                console.log(`[fast] Multi-RAG source: ${fastSource}`);
                retrievalResult = await adaptiveRetrieval(queryForFast, 'fast', null, { source: fastSource });
                tRetrieval = performance.now() - tR0;
            }
            await handleFast(message, history, retrievalResult, res);

            // Telemetry log
            const tTotal = ((performance.now() - tRouteStart) / 1000).toFixed(2);
            const tRet = (tRetrieval / 1000).toFixed(2);
            const ttft = res._xray ? (res._xray.ttft / 1000).toFixed(2) : "0.00";
            const gen = res._xray ? (res._xray.gen / 1000).toFixed(2) : "0.00";
            const cps = res._xray && res._xray.gen > 0 ? Math.round(res._xray.chars / (res._xray.gen / 1000)) : 0;
            console.log(`[⏱️ X-RAY Web] Mode: fast | Total: ${tTotal}s | Retrieval: ${tRet}s | TTFT: ${ttft}s | Gen: ${gen}s (${cps} cps)`);

            if (retrievalResult.all && retrievalResult.all.length > 0) {
                const sourcesArr = [...(retrievalResult.core || []), ...(retrievalResult.context || [])].slice(0, 5);
                const sources = sourcesArr.map(m =>
                    `${m.metadata?.npa_title || 'НПА'} — ${m.metadata?.article_title || ''}`
                );
                const metadata = sourcesArr.map(m => ({
                    npa_title: m.metadata?.npa_title || '',
                    article_title: m.metadata?.article_title || '',
                    full_text: m.metadata?.full_text || ''
                }));
                res.write(`data: ${JSON.stringify({ sources, metadata })}\n\n`);
            }
        }
        else if (mode === 'thinking') {
            const casual = isCasualMessage(message);
            if (casual || skipRetrieval) {
                console.log(`Режим: ${skipRetrieval ? 'skipRetrieval' : 'приветствие'} — Pinecone пропущен (Thinking)`);
                await handleFast(message, history, { core: [], context: [], all: [] }, res);
            } else {
                sendStep(res, { id: 'classify', status: 'loading', text: 'Определяю тип запроса' });
                const queryForClassify = (userQuery && userQuery.trim()) || message;
                const queryType = await classifyQuery(queryForClassify);
                if (queryType === 'simple') {
                    await handleSimpleConsultation(message, history, res, userQuery);
                } else {
                    sendStep(res, { id: 'classify', status: 'success', text: 'Сложный запрос — запускаю глубокий анализ' });
                    await handleDeepThinking(message, history, res, userQuery);
                }
            }
            // Telemetry log for thinking mode
            const tTotal = ((performance.now() - tRouteStart) / 1000).toFixed(2);
            const ttft = res._xray ? (res._xray.ttft / 1000).toFixed(2) : "0.00";
            const gen = res._xray ? (res._xray.gen / 1000).toFixed(2) : "0.00";
            const cps = res._xray && res._xray.gen > 0 ? Math.round(res._xray.chars / (res._xray.gen / 1000)) : 0;
            console.log(`[⏱️ X-RAY Web] Mode: thinking | Total: ${tTotal}s | Retrieval: n/a | TTFT: ${ttft}s | Gen: ${gen}s (${cps} cps)`);
        }

        res.write('data: [DONE]\n\n');
        res.end();

    } catch (error) {
        logger.error('chat-global', error);
        const tTotal = ((performance.now() - tRouteStart) / 1000).toFixed(2);
        console.log(`[⏱️ X-RAY Web] ERROR | Total: ${tTotal}s`);
        try {
            res.write(`data: ${JSON.stringify({ text: '\n\n⚠️ Произошла системная ошибка (серверы нейросети недоступны). Пожалуйста, повторите запрос.' })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        } catch (writeErr) {
            logger.error('chat-stream-write', writeErr);
        }
    }
    });
});



// ============================================================
// SEMANTIC LEGAL REDLINING — модуль сравнения редакций документов
// ============================================================
// routes/compare.js — отдельный файл с Map-Reduce-пайплайном (Align → Map → Reduce).
// Получает уже готовые helpers (избегаем циркулярного require и повторной
// инициализации rate-limiters / middleware). См. routes/compare.js для деталей.
require('./routes/compare')({
    app,
    getEmbedding,
    generateContentResilient,
    streamDeepSeekResponse,
    segmentDocument,
    extractDocumentContext,    // паспорт документа: тип/отрасль/стороны — общий контекст воркеров
    formatDocContext,          // компактная строка для prefix-инжекции в промпты
    sendStep,
    sendStatus,
    requireClientToken,
    safeJsonParse,
    requestTelemetry,
    rateLimit,
    logger
});

// ============================================================
// DOCUMENT-GROUNDED ANALYSIS — модульный конвейер проверки документа
// ============================================================
require('./routes/analyze')({
    app,
    getEmbedding: getEmbeddingForSupabase,
    callOnce,
    searchPinecone,
    getNextKey,
    streamDeepSeekResponse,
    // Шаг 2 ТЗ: новые хелперы для Map-Reduce архитектуры с DeepSeek V4 Flash агентами
    deepseekJsonCall,           // primary для агентов-верификаторов (с user_id KVCache)
    generateContentResilient,   // fallback для агентов (Gemini после исчерпания DeepSeek)
    DEEPSEEK_ENABLED,           // флаг доступности DeepSeek (для skip-fallback логики)
    segmentDocument,
    extractDocumentContext,
    formatDocContext,
    sendStep,
    sendStatus,
    requireClientToken,
    safeJsonParse,
    requestTelemetry,
    rateLimit,
    logger
});

// ── Miyzamchi 2.0 (Stateful Multi-Agent RAG) — параллельный путь /api/v2 ──
// Изолирован от прод-роута выше. Self-contained: клиенты Gemini/Pinecone/DeepSeek
// берутся из .env внутри services/llmClients.js. Парсинг PDF — через Cloud Run.
// Эндпоинт: POST /api/v2/analyze-document. См. ARCHITECTURE.md / DEPLOY_CLOUD_RUN.md.
app.use('/api/v2', require('./routes/analyzeV2').createAnalyzeV2Router());

// ONLYOFFICE Document Server integration (Этап 1 — см. ONLYOFFICE_MIGRATION.md)
app.use('/api', require('./routes/onlyoffice'));

// ============================================================
// ЗАПУСК
// ============================================================
const server = app.listen(PORT, () => {
    console.log('\n==========================================');
    console.log('Мыйзамчи запущен на порту ' + PORT);
    console.log('Загружено ключей Gemini: ' + KEYS.length);
    console.log('Supabase URL: ' + SUPABASE_URL);
    console.log('==========================================\n');

    // Запуск Telegram бота
    bot.launch()
        .then(() => console.log('Telegram бот успешно запущен'))
        .catch(err => console.error('Ошибка запуска Telegram бота:', err));
});

// ============================================================
// GEMINI MULTIMODAL LIVE API PROXY (WEBSOCKETS)
// ============================================================
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ noServer: true });

// Attach ws to the main HTTP server
server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    if (pathname === '/api/voice') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});

function getGeminiSetupMessage(modelName) {
    return {
        setup: {
            model: modelName,
            generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: {
                            voiceName: 'Algieba'
                        }
                    }
                }
            },
            systemInstruction: {
                parts: [
                    {
                        text: "Ты — Мыйзамчи, профессиональный юридический ИИ-ассистент по законодательству Кыргызской Республики. Отвечай кратко, ёмко, вежливо и строго по законам КР. Если информации нет в базе НПА, вежливо скажи об этом и посоветуй обратиться к юристу. \n\n" +
                              "ОБ АВТОРЕ И ПОЛЬЗОВАТЕЛЕ:\n" +
                              "Твоим создателем и автором является Zhanybek Asirov (Жаныбек Асиров), студент юридического факультета КНУ им. Жусупа Баласагына. Если пользователь спрашивает 'кто тебя создал?', 'кто твой автор?', 'чей ты бот?', 'информация обо мне', 'кто я?', или 'расскажи про меня', вежливо и с гордостью ответь, что его создателем является Zhanybek Asirov, студент юридического факультета КНУ им. Жусупа Баласагына."
                    }
                ]
            },
            tools: [
                {
                    functionDeclarations: [
                        {
                            name: 'search_kyrgyz_laws',
                            description: 'Поиск законов, кодексов и НПА Кыргызской Республики по ключевым словам или юридической ситуации для получения точных статей.',
                            parameters: {
                                type: 'OBJECT',
                                properties: {
                                    query: {
                                        type: 'STRING',
                                        description: 'Поисковый запрос (например: штраф за скорость, трудовой договор КР, права потребителя).'
                                    }
                                },
                                required: ['query']
                            }
                        }
                    ]
                }
            ]
        }
    };
}

wss.on('connection', (ws, req) => {
    console.log('[VoiceWS] Новое голосовое подключение клиента');

    let currentGeminiWs = null;
    let isSetupComplete = false;

    function startGeminiSession(modelName, isFallbackAttempt = false) {
        console.log(`[VoiceWS] Попытка подключения к модели: ${modelName}...`);

        const activeKey = getActiveKey();
        const geminiUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${activeKey}`;

        const geminiWs = new (require('ws'))(geminiUrl);
        currentGeminiWs = geminiWs;

        let hasFailed = false;

        geminiWs.on('open', () => {
            if (hasFailed) return;
            console.log(`[VoiceWS] Соединение с Gemini Live установлено (${modelName}). Отправка Setup...`);
            const setupMessage = getGeminiSetupMessage(modelName);
            geminiWs.send(JSON.stringify(setupMessage));
        });

        geminiWs.on('message', async (data) => {
            if (hasFailed) return;
            try {
                const message = JSON.parse(data.toString());

                // 1. Подтверждение настройки
                if (message.setupComplete) {
                    console.log(`[VoiceWS] [ОК] Успешный коннект к Gemini Live API. Активная модель: ${modelName}`);
                    isSetupComplete = true;
                    ws.send(JSON.stringify({ type: 'status', text: 'Мыйзамчы готов к общению' }));
                    return;
                }

                // 2. Обработка контента от Gemini (Аудио / Текст)
                if (message.serverContent) {
                    const modelTurn = message.serverContent.modelTurn;
                    if (modelTurn && modelTurn.parts) {
                        for (const part of modelTurn.parts) {
                            // Gemini Live возвращает аудио внутри inlineData
                            const audioData = part.inlineData || part;
                            const mime = audioData.mimeType || part.mime_type || '';
                            const rawData = audioData.data || part.data;

                            if (mime.startsWith('audio/pcm') && rawData) {
                                const audioBuffer = Buffer.from(rawData, 'base64');
                                if (ws.readyState === ws.OPEN) {
                                    ws.send(audioBuffer); // Бинарный фрейм аудио
                                }
                            }
                            // Если пришел текст (транскрипт ответа)
                            if (part.text) {
                                if (ws.readyState === ws.OPEN) {
                                    ws.send(JSON.stringify({ type: 'transcript', text: part.text }));
                                }
                            }
                        }
                    }

                    // Перебивание ИИ (barge-in)
                    if (message.serverContent.interrupted) {
                        console.log('[VoiceWS] Gemini прерван голосом пользователя!');
                        if (ws.readyState === ws.OPEN) {
                            ws.send(JSON.stringify({ type: 'interrupted' }));
                        }
                    }
                }

                // 3. Обработка Tool Calling (RAG)
                if (message.toolCall) {
                    const calls = message.toolCall.functionCalls;
                    if (calls && calls.length > 0) {
                        for (const call of calls) {
                            if (call.name === 'search_kyrgyz_laws') {
                                const query = call.args.query;
                                const callId = call.id;

                                console.log(`[VoiceWS] Tool Call [search_kyrgyz_laws] query: "${query}"`);
                                if (ws.readyState === ws.OPEN) {
                                    ws.send(JSON.stringify({ type: 'status', text: 'Поиск по базе законов КР...' }));
                                }

                                try {
                                    // 1. Получаем эмбеддинг
                                    const queryVector = await getEmbedding(query);
                                    // 2. Ищем в Pinecone (строго topK: 3 для голосовой скорости)
                                    const matches = await searchPinecone(queryVector, 3);
                                    
                                    console.log(`[VoiceWS] Найдено статей в Pinecone: ${matches.length}`);

                                    // 3. Форматируем результаты для Gemini
                                    const articles = matches.map(m => ({
                                        npa_title: m.metadata.npa_title || 'НПА КР',
                                        article_title: m.metadata.article_title || 'Статья',
                                        full_text: m.metadata.full_text || m.metadata.text_preview || ''
                                    }));

                                    // 4. Отправляем ответ обратно в Gemini
                                    const responseMessage = {
                                        toolResponse: {
                                            functionResponses: [
                                                {
                                                    name: 'search_kyrgyz_laws',
                                                    id: callId,
                                                    response: {
                                                        output: {
                                                            articles: articles
                                                        }
                                                    }
                                                }
                                            ]
                                        }
                                    };
                                    geminiWs.send(JSON.stringify(responseMessage));
                                    console.log('[VoiceWS] Отправили toolResponse в Gemini');

                                } catch (err) {
                                    console.error('[VoiceWS] Ошибка выполнения Tool Call RAG:', err.message);
                                    // Возвращаем пустую или статусную ошибку в Gemini, чтобы не вешать диалог
                                    const responseMessage = {
                                        toolResponse: {
                                            functionResponses: [
                                                {
                                                    name: 'search_kyrgyz_laws',
                                                    id: callId,
                                                    response: { output: { error: 'Поиск временно недоступен', articles: [] } }
                                                }
                                            ]
                                        }
                                    };
                                    geminiWs.send(JSON.stringify(responseMessage));
                                }
                            }
                        }
                    }
                }

            } catch (err) {
                console.error('[VoiceWS] Ошибка обработки сообщения от Gemini:', err.message);
            }
        });

        const handleFailure = (err) => {
            if (hasFailed) return;
            hasFailed = true;

            const errMessage = err ? err.message : 'Session error';

            if (!isSetupComplete && !isFallbackAttempt) {
                console.log(`[VoiceWS] Ошибка Primary модели, переключаемся на Fallback (models/gemini-2.5-flash-live-preview)...`);
                try {
                    geminiWs.close();
                } catch (e) {}
                startGeminiSession('models/gemini-2.5-flash-live-preview', true);
            } else {
                console.log(`[VoiceWS] Gemini соединение закрыто/ошибка: ${errMessage}`);
                try {
                    geminiWs.close();
                } catch (e) {}
                if (ws.readyState === ws.OPEN) {
                    // Send error code 4000 with description to the client browser
                    ws.close(4000, errMessage.slice(0, 100));
                }
            }
        };

        geminiWs.on('close', (code, reason) => {
            handleFailure(new Error(`closed: ${code} - ${reason}`));
        });

        geminiWs.on('error', (err) => {
            handleFailure(err);
        });
    }

    // Start with the Primary model
    startGeminiSession('models/gemini-3.1-flash-live-preview', false);

    // Обработка входящих сообщений от клиента
    ws.on('message', (message, isBinary) => {
        // Если клиент прислал бинарное аудио (16kHz PCM)
        if (isBinary) {
            if (currentGeminiWs && currentGeminiWs.readyState === currentGeminiWs.OPEN && isSetupComplete) {
                const base64Audio = message.toString('base64');
                const realtimeInputMsg = {
                    realtimeInput: {
                        audio: {
                            mimeType: 'audio/pcm;rate=16000',
                            data: base64Audio
                        }
                    }
                };
                currentGeminiWs.send(JSON.stringify(realtimeInputMsg));
            }
        } else {
            // Если пришел текст (например, команда на прерывание или текстовый ввод)
            try {
                const textMsg = JSON.parse(message.toString());
                console.log('[VoiceWS] Получено текстовое сообщение от клиента:', textMsg);
            } catch (err) {
                console.error('[VoiceWS] Ошибка парсинга сообщения от клиента:', err.message);
            }
        }
    });

    ws.on('close', () => {
        console.log('[VoiceWS] Голосовое подключение клиента закрыто');
        if (currentGeminiWs) {
            currentGeminiWs.close();
        }
    });

    ws.on('error', (err) => {
        console.error('[VoiceWS] Ошибка в клиентском WS:', err.message);
        if (currentGeminiWs) {
            currentGeminiWs.close();
        }
    });
});

// Грейсфул шатдаун для бота
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// --- САМО-ПИНАТЕЛЬ ---
const APP_URL = "https://miyzamchi-backend.onrender.com/ping";

setInterval(async () => {
    try {
        const response = await fetch(APP_URL);
        if (response.ok) {
            console.log('Само-пинг: Сервер бодрствует.');
        }
    } catch (e) {
        console.error('Ошибка само-пинга:', e.message);
    }
}, 14 * 60 * 1000);

// --- ГЛОБАЛЬНАЯ ЗАЩИТА ПРОЦЕССА ---
// Stack trace в логах не пишем (палит абсолютные пути сервера).
// Когда подключите Sentry — там полный stack будет, а в консоли только error.message.
process.on('uncaughtException', (err) => {
    logger.error('uncaught-exception', err);
});

process.on('unhandledRejection', (reason) => {
    logger.error('unhandled-rejection', reason instanceof Error ? reason : new Error(String(reason)));
});