require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
const bot = require('./telegram/bot');

const app = express();
app.set('trust proxy', 1); // Доверие к прокси Render

// --- HELMET (безопасность HTTP-заголовков) ---
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false
}));

// --- CORS (Открыт временно, пока нет финального домена) ---
app.use(cors({
    origin: '*', // Для тестов ставим звездочку, потом ограничим
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ limit: '2mb', extended: true }));

// ============================================================
// STATIC + UI ROUTES (Chat UI + Legal IDE)
// ============================================================
// Serve static assets (optionally from /public, plus repo root for existing files)
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/ide', (req, res) => {
    res.sendFile(path.join(__dirname, 'ide', 'MIyzamchy Legal IDE.html'));
});
// Serve IDE static assets (CSS, JS) from /ide/ path
app.use('/ide', express.static(path.join(__dirname, 'ide')));

// --- RATE LIMITING ---
const rateLimit = require('express-rate-limit');
const apiLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { reply: 'Слишком много запросов. Пожалуйста, подождите одну минуту.' }
});
app.use('/api/chat', apiLimiter);
app.use('/api/analyze-document', apiLimiter);
// Deep Analysis (PRO) — отдельный лимит, дороже по агентам
const deepAnalyzeLimiter = rateLimit({
    windowMs: 60_000,
    max: 6,
    standardHeaders: true,
    legacyHeaders: false,
    message: { reply: 'Лимит глубокого анализа: не более 6 в минуту. Используйте обычный анализ или подождите.' }
});
app.use('/api/deep-analyze-document', deepAnalyzeLimiter);

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
const { GEMINI_API_KEY, PINECONE_API_KEY, PINECONE_HOST } = process.env;

const KEYS = GEMINI_API_KEY ? GEMINI_API_KEY.split(',').map(k => k.trim()) : [];
let currentKeyIndex = 0;

if (KEYS.length === 0 || !PINECONE_API_KEY || !PINECONE_HOST) {
    console.error("ОШИБКА: Проверь переменные GEMINI_API_KEY, PINECONE_API_KEY и PINECONE_HOST на Render!");
    process.exit(1);
}

const cleanPineconeHost = PINECONE_HOST.replace(/\/$/, '');

// --- ТЕЛЕМЕТРИЯ ---
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'miyzamchi_admin_2026';
const serverStats = { totalRequests: 0, cacheHits: 0, apiErrors: 0, startTime: Date.now() };

// --- МАРШРУТ ДЛЯ ПИНГА ---
app.get('/ping', (req, res) => {
    console.log('Пинг получен. Мыйзамчи бодрствует!');
    res.status(200).send('Бодрствую! ');
});

// --- HEALTH CHECK ---
app.get('/health', async (req, res) => {
    let pineconeStatus = 'Error';
    try {
        const zeroVector = new Array(768).fill(0);
        const pcRes = await fetch(cleanPineconeHost + '/query', {
            method: 'POST',
            headers: { 'Api-Key': PINECONE_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ vector: zeroVector, topK: 1, includeMetadata: false })
        });
        if (pcRes.ok) pineconeStatus = 'Connected';
    } catch (e) {
        console.error('Health check Pinecone error:', e.message);
    }
    res.json({ status: 'OK', keys_total: KEYS.length, pinecone: pineconeStatus });
});

// --- СЕКРЕТНАЯ АДМИНКА (ТЕЛЕМЕТРИЯ) ---
app.get('/api/stats', (req, res) => {
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

// --- ПОИСК В PINECONE (с таймаутом 4с) ---
async function searchPinecone(vector, topK = 15) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
        const response = await fetch(cleanPineconeHost + '/query', {
            method: 'POST',
            headers: { 'Api-Key': PINECONE_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ vector, topK, includeMetadata: true }),
            signal: controller.signal
        });
        const data = await response.json();
        return data.matches || [];
    } catch (error) {
        if (error.name === 'AbortError') {
            console.warn('[WARN] Pinecone Timeout (4s)');
            return [];
        }
        console.error("Ошибка Pinecone:", error.message);
        return [];
    } finally {
        clearTimeout(timeout);
    }
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
async function adaptiveRetrieval(query, mode, res = null, opts = {}) {
    // --- Настройки (mode задаёт дефолты, opts может переопределить) ---
    const defaults = {
        thinking: { maxK: 25, minK: 5 },
        agent:    { maxK: 15, minK: 4 },   // средний — между fast и thinking
        fast:     { maxK: 10, minK: 3 }
    };
    const base = defaults[mode] || defaults.fast;
    const maxK = opts.maxK ?? base.maxK;
    const minK = opts.minK ?? base.minK;
    const absoluteMinScore = opts.absoluteMinScore ?? 0.45;
    const coreScoreThreshold = opts.coreScoreThreshold ?? 0.75;
    const elbowDropRatio = opts.elbowDropRatio ?? 0.15;
    
    const streamStatuses = res && mode === 'thinking';
    
    // --- Этап 1: Эмбеддинг запроса ---
    if (streamStatuses) sendStatus(res, 'Преобразую ваш вопрос в вектор...', '🧬');
    const embedding = await getEmbedding(query);
    
    // --- Этап 2: Семантический поиск ---
    if (streamStatuses) sendStatus(res, `Ищу в базе ${maxK} ближайших статей НПА...`, '🔎');
    const matches = await searchPinecone(embedding, maxK);
    
    if (matches.length === 0) {
        if (streamStatuses) sendStatus(res, 'База НПА не вернула результатов', '⚠️');
        console.log(`[Retrieval] ${mode} | query: ${query.length} chars | ⚠️ Pinecone пуст`);
        return { core: [], context: [], all: [] };
    }
    
    // --- Этап 3: Фильтрация и ранжирование ---
    if (streamStatuses) sendStatus(res, `Получил ${matches.length} статей, ранжирую по релевантности...`, '📊');
    
    let candidates = matches.filter(m => (m.score || 0) >= absoluteMinScore);
    
    if (candidates.length > minK) {
        const scores = candidates.map(m => m.score || 0);
        let elbowIndex = candidates.length;
        for (let i = minK - 1; i < scores.length - 1; i++) {
            const drop = scores[i] > 0 ? (scores[i] - scores[i + 1]) / scores[i] : 0;
            if (drop > elbowDropRatio) {
                elbowIndex = i + 1;
                break;
            }
        }
        candidates = candidates.slice(0, elbowIndex);
    }
    
    if (candidates.length < minK && matches.length >= minK) {
        candidates = matches.slice(0, minK);
    }
    
    const core = candidates.filter(m => (m.score || 0) >= coreScoreThreshold);
    const context = candidates.filter(m => (m.score || 0) < coreScoreThreshold);
    
    const topScore = (matches[0].score || 0).toFixed(3);
    console.log(
        `[Retrieval] ${mode} | query: ${query.length} chars | ` +
        `topScore: ${topScore} | ` +
        `⭐ core: ${core.length} | 📚 context: ${context.length} | ` +
        `total: ${candidates.length}/${matches.length}`
    );
    
    // --- Этап 4: Результат отбора ---
    if (streamStatuses) {
        sendStatus(res, `Отобрал ⭐ ${core.length} ключевых и 📚 ${context.length} смежных статей`, '✅');
    }
    
    return { core, context, all: candidates };
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
app.post('/api/edit', async (req, res) => {
    serverStats.totalRequests++;
    try {
        const { text, instruction } = req.body;
        if (!text || !instruction) {
            return res.status(400).json({ error: "Missing text or instruction" });
        }

        const activeKey = getActiveKey();
        const genAI = new GoogleGenerativeAI(activeKey);
        const model = genAI.getGenerativeModel({
            model: "gemini-flash-latest",
            systemInstruction: "Ты — профессиональный юрист-редактор КР. Твоя задача — переписать предоставленный текст согласно инструкции. Возвращай ТОЛЬКО исправленный текст, без приветствий, без кавычек, без Markdown-форматирования и без объяснений."
        });

        const prompt = `Инструкция: ${instruction}\n\nТекст для редактирования:\n${text}`;
        const result = await model.generateContent(prompt);
        const responseText = result.response.text().trim();

        res.json({ result: responseText });
    } catch (error) {
        console.error("Ошибка в /api/edit:", error.message);
        serverStats.apiErrors++;
        res.status(500).json({ error: "Ошибка при редактировании текста" });
    }
});

// ============================================================
// СИСТЕМНАЯ ИНСТРУКЦИЯ (Быстрый режим)
// ============================================================
const systemInstruction = [
    "# ИДЕНТИЧНОСТЬ",
    "Ты — **Мыйзамчи**, юридический ИИ-ассистент Кыргызской Республики.",
    "Твоя задача — помогать гражданам понимать законодательство КР просто, точно и практично.",
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
    "1. **Приоритет 1 — Контекст (НПА):** Твои ответы должны основываться ИСКЛЮЧИТЕЛЬНО на предоставленных статьях законов КР. Это единственный источник правовой истины.",
    "2. **⭐ КЛЮЧЕВЫЕ vs 📚 ВСПОМОГАТЕЛЬНЫЕ статьи:** Если в контексте есть статьи с пометкой **[⭐ КЛЮЧЕВАЯ СТАТЬЯ]** — опирайся в первую очередь на них. Статьи с пометкой **[📚 ВСПОМОГАТЕЛЬНАЯ]** используй как дополнительный контекст (смежные нормы, процедурные детали), но НЕ цитируй их как основной ответ на вопрос.",
    "3. **Приоритет 2 — Твои знания:** Используй ТОЛЬКО для структуры документов, объяснения терминов простым языком и общей юридической логики. НИКОГДА не подменяй ими нормы закона и не дополняй контекст выдуманными статьями.",
    "4. **Если в контексте нет ответа:** Ты ОБЯЗАН прямо сказать: «К сожалению, в моей текущей базе НПА нет информации по этому вопросу. Рекомендую обратиться к юристу или на сайт cbd.minjust.gov.kg.» Не пытайся ответить из общих знаний.",
    "5. **КАТЕГОРИЧЕСКИЙ ЗАПРЕТ НА ГАЛЛЮЦИНАЦИИ:** Тебе ЗАПРЕЩЕНО выдумывать номера статей, сроки, суммы или нормы, которых нет в предоставленном контексте. Не используй общие знания о праве, если они не подтверждены контекстом.",
    "",
    "---",
    "",
    "# ПРАВИЛО ЮРИДИЧЕСКОЙ ИЕРАРХИИ (СТРОГО ОБЯЗАТЕЛЬНО К ИСПОЛНЕНИЮ)",
    "При анализе любого правового запроса ты ОБЯЗАН строить аргументацию строго сверху вниз, от общих норм к частным. Никогда не отвечай, опираясь только на подзаконные акты или узкие правила, не заложив правовой фундамент из Кодексов КР.",
    "## АЛГОРИТМ АНАЛИЗА:",
    "1. **ФУНДАМЕНТ (Кодексы КР):** Сначала определи базовую отрасль права и найди фундаментальную норму.",
    "   - Гражданские права, договоры, обязательства, собственность → Гражданский кодекс КР (ГК КР).",
    "   - Трудовые споры → Трудовой кодекс КР.",
    "   - Семья и брак → Семейный кодекс КР.",
    "   - Налоги → Налоговый кодекс КР.",
    "2. **СПЕЦИАЛЬНЫЙ ЗАКОН (при наличии):** Подключи профильный закон (например, О защите прав потребителей, О государственных закупках).",
    "3. **ПРОЦЕДУРА И ДЕТАЛИ (Подзаконные акты):** В конце примени специфические правила, инструкции, положения или регламенты.",
    "## ФОРМАТ АРГУМЕНТАЦИИ:",
    "Твой ответ должен логически вытекать из связки: **Базовое правило (Кодекс)** → **Специальная норма (Закон)** → **Процедура (Правила)**.",
    "Пример логики: Согласно ст. [X] ГК КР... В развитие этой нормы ст. [Y] Закона... Таким образом, согласно п. [Z] Правил...",
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
    "- Начинай с: «Согласно [статья] [название акта]...»",
    "- Кратко цитируй или пересказывай норму",
    "- Объясняй практический смысл простыми словами",
    "- Указывай сроки **жирным** (например: **30 дней**, **3 года**)",
    "- Если норм несколько — перечисляй по порядку применения",
    "- Учитывай историю разговора.",
    "",
    "## Режим 2 — Объяснение термина / статьи",
    "- Объясняй как будто человек слышит это впервые",
    "- Приводи 1 конкретный бытовой пример",
    "- Избегай юридического жаргона без расшифровки",
    "",
    "## Режим 3 — Составление документа",
    "- **КРИТИЧЕСКОЕ ПРАВИЛО ПО СУДЕБНЫМ ДОКУМЕНТАМ:** Если пользователь просит составить **исковое заявление**, **апелляционную жалобу**, **кассационную жалобу**, **административный иск** или иной судебный процессуальный документ — ТЫ НЕ ГЕНЕРИРУЕШЬ готовый текст с реквизитами. Вместо этого:",
    "  1. Объясни структуру документа (какие блоки обязательны по ГПК КР)",
    "  2. Перечисли обязательные реквизиты",
    "  3. Перечисли какие доказательства нужно приложить",
    "  4. Укажи куда подавать и госпошлину",
    "  5. **НАСТОЯТЕЛЬНО рекомендуй обратиться к адвокату/юристу** — ошибка в иске может стоить человеку дела.",
    "- **ДОСУДЕБНЫЕ документы** (претензия, заявление в орган, жалоба в прокуратуру, заявление об отпуске) — можно составить шаблон с полями **[ЗАПОЛНИТЬ: ...]**.",
    "- Поля для заполнения: **[ВАШЕ ФИО]**, **[ДАТА]**, **[АДРЕС]** и т.д.",
    "- Структура досудебных: Шапка → Суть требования → Правовое основание → Просительная часть → Подпись",
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
].join("\n");

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

═══ ПРАВИЛО ЮРИДИЧЕСКОЙ ИЕРАРХИИ (СТРОГО ОБЯЗАТЕЛЬНО К ИСПОЛНЕНИЮ) ═══
При анализе любого правового запроса ты ОБЯЗАН строить аргументацию строго сверху вниз, от общих норм к частным. Никогда не отвечай, опираясь только на подзаконные акты или узкие правила, не заложив правовой фундамент из Кодексов КР.

АЛГОРИТМ АНАЛИЗА:
1. ФУНДАМЕНТ (Кодексы КР): Сначала определи базовую отрасль права и найди фундаментальную норму.
   - Гражданские права, договоры, обязательства, собственность → Гражданский кодекс КР (ГК КР).
   - Трудовые споры → Трудовой кодекс КР.
   - Семья и брак → Семейный кодекс КР.
   - Налоги → Налоговый кодекс КР.
2. СПЕЦИАЛЬНЫЙ ЗАКОН (при наличии): Подключи профильный закон (например, О защите прав потребителей, О государственных закупках).
3. ПРОЦЕДУРА И ДЕТАЛИ (Подзаконные акты): В конце примени специфические правила, инструкции, положения или регламенты.

ФОРМАТ АРГУМЕНТАЦИИ:
Твой ответ должен логически вытекать из связки: Базовое правило (Кодекс) → Специальная норма (Закон) → Процедура (Правила).
Пример логики: Согласно ст. [X] ГК КР... В развитие этой нормы ст. [Y] Закона... Таким образом, согласно п. [Z] Правил...

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

**Для СУДЕБНЫХ документов (иск, апелляция, кассация) — НЕ составляй готовый текст.**
Вместо этого дай структуру + реквизиты + перечень доказательств + рекомендацию к юристу:

> ⚖️ Составление искового заявления — это ответственная процедура. Ошибка в формулировках или отсутствие обязательного реквизита может привести к оставлению иска без движения или отказу в удовлетворении. **Настоятельно рекомендую обратиться к юристу или адвокату** — даже одна консультация поможет избежать ключевых ошибок.
>
> Если вы хотите действовать самостоятельно, вот обязательная структура искового заявления по ГПК КР:
> 1. Наименование суда
> 2. Данные истца (ФИО, адрес, телефон, email, банковские реквизиты)
> 3. Данные ответчика
> 4. Суть нарушения и ваши требования
> 5. Обстоятельства, на которых основываются требования + доказательства
> 6. Цена иска (если имущественный)
> 7. Перечень приложений
> 8. Дата и подпись

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

═══ ПРАВИЛА ═══
1. Опирайся ИСКЛЮЧИТЕЛЬНО на НПА из предоставленного контекста (в первую очередь ⭐ КЛЮЧЕВЫЕ). Не выдумывай статьи, сроки, суммы.
2. Если нормы нет в контексте — честно скажи: «К сожалению, в моей текущей базе НПА нет информации по этому вопросу.»
3. Никаких советов по праву РФ, Казахстана и других стран — они НЕ применимы в КР.
4. Язык = язык вопроса (русский / кыргызский).
5. Сроки, суммы, статьи — **жирным**.
6. Не повторяй вопрос в начале.
7. Не хватает данных для документа — спроси конкретно.
8. **ПРИВЕТСТВИЯ:** КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО здороваться («Салам», «Привет» и т.п.) в каждом сообщении. Здоровайся ТОЛЬКО если пользователь сам поздоровался в текущем запросе. Иначе — сразу отвечай по сути.
9. **ОБ АВТОРЕ:** Информацию о создателе (Zhanybek Asirov, студент юридического факультета КНУ им. Жусупа Баласагына) выдавай ТОЛЬКО если пользователь ПРЯМО спросит «кто тебя создал?», «кто твой автор?», «чей ты бот?». В любых других ответах (консультации, документы, СРС, курсовые) упоминать автора СТРОГО ЗАПРЕЩЕНО.
10. **ДИСКЛЕЙМЕР (рабочий, для юриста-профессионала):** Пользователь — практикующий юрист, не клиент. Не пиши «не заменяет консультацию юриста» — это абсурд. В конце ответа на реальный юридический вопрос — ОДИН раз короткое предупреждение о необходимости сверки норм с первоисточником. Не дублируй; не добавляй в болталке, шаблонах документов и академических работах. Формат:
    > ℹ️ *Перед использованием в производстве сверьте номера и редакции статей с актуальной базой cbd.minjust.gov.kg.*

═══ ОБЩЕПРОЦЕДУРНАЯ СПРАВКА (БЕЗ НОМЕРОВ СТАТЕЙ) ═══
Эти факты можно использовать как общие процедурные ориентиры. ВАЖНО: конкретные номера статей бери ИСКЛЮЧИТЕЛЬНО из контекста — никогда не подставляй номера из памяти.

ГРАЖДАНСКИЙ ПРОЦЕСС: подсудность районного суда — до 1 млн сомов; срок рассмотрения — 2 месяца (общий), 1 месяц (упрощённое производство); срок апелляции — 15 дней; срок кассации — 3 месяца.

ТРУДОВЫЕ СПОРЫ: обращение в суд — 3 месяца (общий срок), 1 месяц (оспаривание увольнения); комиссия по трудовым спорам — досудебный этап.

АДМИНИСТРАТИВНЫЕ ДЕЛА: обжалование действий органов — 3 месяца.

ГОСПОШЛИНА: имущественные иски — 1% от суммы, не менее 100 сомов; неимущественные физлиц — 500 сомов; апелляция — 50% от первой инстанции; работники по трудовым спорам освобождены.

ПРЕТЕНЗИОННЫЙ ПОРЯДОК: по потребительским спорам претензия обязательна до суда; типовой срок ответа — 10-14 дней.
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

═══ ⚠️ ВАЖНО: ПОЛЬЗОВАТЕЛЬ ПРОСИТ СУДЕБНЫЙ ДОКУМЕНТ ═══
Пользователь просит составить исковое заявление, жалобу в суд или иной судебный процессуальный документ.
ЗАПРЕЩЕНО генерировать готовый текст иска с проставленными реквизитами.
ОБЯЗАТЕЛЬНО:
1. Дать структуру обязательных реквизитов искового заявления (строго по ГПК КР из контекста)
2. Перечислить необходимые доказательства и приложения
3. Указать суд, срок и госпошлину
4. НАСТОЯТЕЛЬНО порекомендовать обратиться к юристу/адвокату перед подачей
Объясни пользователю, что ошибка в иске — это высокий риск потери дела.
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
  "reasoning": "Кратко (1-2 предложения) для себя — почему выбрана эта норма и это место. Это поле НЕ попадёт в документ, оно для логики.",
  "anchor_text": "Точная фраза 5-10 слов из ТЕКУЩЕГО документа, СРАЗУ ПОСЛЕ которой нужно вставить новый текст. Скопируй буквально, не пересказывай. Если документ пуст — пиши EMPTY.",
  "insertion_text": "Готовый юридический текст для вставки. Без кавычек, без 'Вот предложение:'. Только сам нормативный текст."
}
\`\`\`

═══ ПРАВИЛА ВЫБОРА anchor_text ═══
- Это якорь для умной вставки — после этой фразы будет вставлен новый текст.
- Скопируй ТОЧНО (с теми же знаками, регистром, окончаниями).
- Выбери логичное место по смыслу: после раздела, после релевантного пункта, после заголовка.
- Если документ полностью пуст → "anchor_text": "EMPTY".
- Если задача — заменить выделенный фрагмент → anchor_text = начало этого фрагмента.

═══ ПРАВИЛА ВЫБОРА insertion_text ═══
- Только сам текст, готовый к вставке в документ.
- Соблюдай существующую нумерацию пунктов/статей в документе (если в документе уже есть «1.», «2.» — продолжай с правильного номера).
- Юридический стиль: точные формулировки, ссылки на нормы КР, без воды.
- Если ссылаешься на статью НПА — формулируй: «согласно ст. X Закона КР "..."» или «в соответствии с ч. Y ст. X ГК КР».

═══ ИСПОЛЬЗОВАНИЕ КОНТЕКСТА НПА ═══
- Если в промпте есть блок «Контекст — N релевантных статей НПА КР» — это ЕДИНСТВЕННЫЙ источник правовой истины. Используй ТОЛЬКО эти статьи.
- ⭐ КЛЮЧЕВЫЕ статьи — основной источник; 📚 ВСПОМОГАТЕЛЬНЫЕ — как смежные/процедурные нормы.
- Цитируй точно: «согласно ст. X Закона КР "..."» — номер статьи и название НПА бери ИЗ КОНТЕКСТА, не из памяти.
- Если контекста нет — НЕ упоминай конкретных номеров статей. Пиши «согласно действующему законодательству КР» или «в соответствии с соответствующими нормами УК/ГК/ТК КР».

═══ КРИТИЧЕСКОЕ ПРАВИЛО — БЕЗ ГАЛЛЮЦИНАЦИЙ ═══
1. ЗАПРЕЩЕНО выдумывать номера статей, сроки, суммы, даты принятия НПА.
2. ЗАПРЕЩЕНО утверждать о смене редакций кодексов («в 1997 это была ст. X, в 2021 стала ст. Y») если этого нет В КОНТЕКСТЕ выше. Реформа УК КР 2021 г. перенумеровала статьи, но БЕЗ КОНТЕКСТА ты точных соответствий не знаешь.
3. Если автор документа УЖЕ указал номера статей — НЕ оспаривай их без явного подтверждения из контекста. Просто работай с тем что есть.
4. Если в АНАЛИЗЕ упоминаешь конкретные номера — обязательно добавь в reasoning disclaimer:
   "⚠️ Рекомендую сверить номера статей с актуальной редакцией на cbd.minjust.gov.kg."

═══ ЗАПРЕТЫ ═══
1. НИКАКИХ свободных текстов вне json-блока.
2. НИКАКИХ объяснений в insertion_text типа «Это статья X, потому что...» — только сам текст.
3. НЕ генерируй полный исковой документ с реквизитами — это L4-запрос, скажи в reasoning что нужно к юристу, а insertion_text оставь пустым.
4. НЕ повторяй то что уже есть в документе.
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

═══ АБСОЛЮТНОЕ ПРАВИЛО — ЕДИНСТВЕННЫЙ ИСТОЧНИК ИСТИНЫ ═══
ВСЕ номера статей в твоём ответе ДОЛЖНЫ быть процитированы из «ОТЧЁТА ВЕРИФИКАЦИИ» (per-article RAG-сверка через Pinecone).
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
Если в ОТЧЁТЕ много ❌ — это значит что Pinecone не нашёл этих норм.
Возможные причины: устаревшая редакция, международные источники (Конвенция ООН, МПГПП — их нет в базе НПА КР), или специфический раздел.
В ЛЮБОМ случае — НЕ предлагай свою память как замену. Просто отметь отсутствие подтверждения.

═══ САМОПРОВЕРКА ПЕРЕД ОТПРАВКОЙ ═══
Перед финальным ответом мысленно пройдись по каждому упомянутому номеру статьи:
  • Есть ли он буквально в ОТЧЁТЕ?
  • Если нет — УБЕРИ номер, замени общей формулировкой.

═══ ФОРМАТ ОТВЕТА ═══

## 🔍 Сверка ссылок на статьи
По каждой статье ИЗ ОТЧЁТА — строка со статусом:

✅ Ст.X [НПА]: Подтверждена. Оригинал из базы: "[цитата до 200 сим]"
   Использование в документе: корректно / неточно (почему)

⚠️ Ст.Y [НПА]: Номер не совпал. Ближайшее в базе — ст.Z (suggestedArticle).
   Проверьте актуальную редакцию.

❌ Ст.W [НПА]: НЕ найдена в базе. Рекомендую сверить с cbd.minjust.gov.kg.

## ⚖️ Юридическая оценка
Содержательная оценка документа. Номера — только из ОТЧЁТА. Иначе общими фразами.

## 📋 Рекомендации
Что исправить/добавить. Без номеров которых нет в ОТЧЁТЕ.
Пропущенные нормы (общими словами). Критические проблемы.

═══ ДЛИНА ═══
Соразмерно объёму документа. Без воды, конкретно по делу.
`.trim();

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================================

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function callOnce(apiKey, systemPrompt, userPrompt, retryCount = 0) {
    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
            model: "gemini-flash-latest",
            systemInstruction: systemPrompt
        });
        const result = await model.generateContent(userPrompt);
        return result.response.text();
    } catch (error) {
        if (retryCount < 2) {
            console.warn(`[callOnce] Ошибка. Ждем 2с и повторяем...`);
            await delay(2000);
            return callOnce(getNextKey(), systemPrompt, userPrompt, retryCount + 1);
        }
        throw error;
    }
}

async function streamGeminiResponse(apiKey, systemPrompt, userPrompt, history, res, generationConfig = null) {
    const genAI = new GoogleGenerativeAI(apiKey);
    const modelOpts = {
        model: "gemini-flash-latest",
        systemInstruction: systemPrompt
    };
    if (generationConfig) modelOpts.generationConfig = generationConfig;
    const model = genAI.getGenerativeModel(modelOpts);
    const chat = model.startChat({ history: history || [] });
    const result = await chat.sendMessageStream(userPrompt);
    for await (const chunk of result.stream) {
        const chunkText = chunk.text();
        if (chunkText) {
            res.write(`data: ${JSON.stringify({ text: chunkText })}\n\n`);
        }
    }
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

// --- Форматирование контекста с иерархией ⭐/📚 ---
function formatContextWithHierarchy(core, context) {
    const parts = [];
    
    if (core.length > 0) {
        const coreText = core.map((match) => {
            const md = match.metadata || {};
            return `[⭐ КЛЮЧЕВАЯ СТАТЬЯ — ${md.npa_title} | ${md.article_title}]\nДокумент: ${md.npa_title}\nСтатья: ${md.article_title}\nТекст: ${md.full_text}`;
        }).join('\n\n---\n\n');
        parts.push(coreText);
    }
    
    if (context.length > 0) {
        const contextText = context.map((match) => {
            const md = match.metadata || {};
            return `[📚 ВСПОМОГАТЕЛЬНАЯ — ${md.npa_title} | ${md.article_title}]\nДокумент: ${md.npa_title}\nСтатья: ${md.article_title}\nТекст: ${md.full_text}`;
        }).join('\n\n---\n\n');
        parts.push(contextText);
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

    try {
        const genAI = new GoogleGenerativeAI(currentKey);
        const chatModel = genAI.getGenerativeModel({
            model: "gemini-flash-latest",
            systemInstruction: activeSystemInstruction
        });
        const chat = chatModel.startChat({ history: cleanHistory });
        const result = await chat.sendMessageStream(promptText);

        for await (const chunk of result.stream) {
            const chunkText = chunk.text();
            if (chunkText) res.write(`data: ${JSON.stringify({ text: chunkText })}\n\n`);
        }
    } catch (error) {
        console.error(`[FAST MODE] Ошибка Google (попытка ${retryCount + 1}):`, error.message);
        serverStats.apiErrors++;
        blockKey(currentKey);

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
async function handleAgent(message, history, res, retryCount = 0, userQuery = null) {
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
    if (retryCount === 0) {
        // 1) Тянем содержимое блока  ТЕКУЩИЙ ТЕКСТ ДОКУМЕНТА: """...""""
        const docBlockMatch = message.match(/ТЕКУЩИЙ ТЕКСТ ДОКУМЕНТА[^"]*"""([\s\S]*?)"""/i);
        const docBody = docBlockMatch ? docBlockMatch[1].trim() : '';
        const hasRealDoc = docBody.length >= 100;

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

    // Light retrieval — чтобы агент мог цитировать конкретные нормы НПА.
    // Не отправляем status-события клиенту (агент-режим тихий).
    let contextBlock = '';
    let allMatches = [];
    try {
        // ▸ Для embedding используем КОРОТКИЙ userQuery если он передан фронтом
        //   (иначе вектор размывается всем текстом документа и retrieval теряет точность).
        // ▸ Fallback на полный message только если userQuery отсутствует.
        const queryForEmbedding = (userQuery && userQuery.trim()) || message;
        const isCasual = isCasualMessage(queryForEmbedding);
        if (!isCasual) {
            // ▸ Адаптивный TopK для агента:
            //   - короткий запрос (<60 символов, явная узкая просьба) → 8-10 матчей
            //   - средний запрос (60-200) → 12-15 матчей
            //   - длинный/комплексный (>200) → 18-22 матча
            const qLen = queryForEmbedding.length;
            const adaptiveMaxK = qLen > 200 ? 22 : qLen > 60 ? 15 : 10;
            const adaptiveMinK = qLen > 200 ? 6  : qLen > 60 ? 4  : 3;
            console.log(`[AGENT] Adaptive retrieval: query=${qLen}ch → maxK=${adaptiveMaxK} minK=${adaptiveMinK}`);
            const retrieval = await adaptiveRetrieval(queryForEmbedding, 'agent', null, {
                maxK: adaptiveMaxK,
                minK: adaptiveMinK
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

    const userPrompt = message + contextBlock;

    console.log(`[AGENT] Готовлю ответ | НПА найдено: ${allMatches.length} | history: ${cleanHistory.length}`);

    const apiKey = getNextKey();
    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
            model: "gemini-flash-latest",
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
        blockKey(apiKey);

        if (retryCount >= Math.min(KEYS.length, 3)) {
            res.write(`data: ${JSON.stringify({ text: '\n\n⚠️ Серверы AI временно перегружены. Повторите запрос через минуту.' })}\n\n`);
            return;
        }

        await delay(1500);
        return handleAgent(message, history, res, retryCount + 1, userQuery);
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

    const retrieval = await adaptiveRetrieval(userQ, 'thinking', null, { maxK: 15, minK: 4 });
    const { core = [], context = [], all = [] } = retrieval;

    sendStep(res, {
        id: 'retrieve',
        status: all.length ? 'success' : 'warning',
        text: all.length ? `Найдено статей: ${all.length}` : 'В базе нет данных по запросу'
    });

    if (all.length === 0) {
        sendStep(res, { id: 'answer', status: 'warning', text: 'Нет данных в базе НПА' });
        res.write(`data: ${JSON.stringify({ text: 'К сожалению, в моей текущей базе НПА нет информации по этому вопросу. Сверьте с cbd.minjust.gov.kg.' })}\n\n`);
        return;
    }

    sendStep(res, { id: 'answer', status: 'loading', text: 'Формулирую ответ' });
    sendStatus(res, '✍️ Формулирую ответ...');

    const contextText = formatContextWithHierarchy(core, context);
    const isL4 = detectL4Request(userQ);
    let systemPrompt = BASE_CONSULTANT_PROMPT;
    if (isAcademicRequest(userQ)) systemPrompt += '\n\n' + ACADEMIC_PROMPT_ADDON;
    if (isL4) systemPrompt += '\n\n' + L4_WARNING_ADDON;

    const finalPrompt =
        `Вопрос пользователя: "${userQ}"\n\n` +
        `Контекст — ${all.length} релевантных статей НПА КР (⭐ ${core.length} ключевых + 📚 ${context.length} вспомогательных):\n\n${contextText}`;

    try {
        await streamGeminiResponse(getNextKey(), systemPrompt, finalPrompt, cleanHistory, res);
        sendStep(res, { id: 'answer', status: 'success', text: 'Ответ готов' });

        // Источники для chip-badges
        const sourcesArr = [...core, ...context].slice(0, 5);
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
        console.error('[SimpleConsult] failed:', err.message);
        sendStep(res, { id: 'answer', status: 'error', text: 'Ошибка генерации ответа' });
        try {
            await streamGeminiResponse(getNextKey(), systemInstruction, finalPrompt, cleanHistory, res);
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
2) 5 коротких поисковых запросов для разных слоёв законодательства КР

Отвечаешь СТРОГО JSON без markdown без пояснений.`;
    const userPrompt = `Вопрос пользователя: "${userMessage}"

Сформируй компактный пакет поисковых стратегий.
Каждый запрос — короткая фраза (5-15 слов), оптимизированная под векторный поиск.

Формат (ровно такой JSON):
{
  "topic":     "тема вопроса в 5-10 словах с указанием отрасли (для prefix-инжекции)",
  "special":   "узкая специальная норма — точная проблема юриста",
  "general":   "общие положения и фундаментальные принципы (Кодексы)",
  "process":   "процессуальные нормы — сроки давности, подсудность, госпошлина",
  "liability": "ответственность за нарушение — штрафы, неустойка, санкции, расторжение",
  "bylaws":    "подзаконные акты — правила, инструкции, постановления Кабмина"
}

Примеры:
Вопрос: "Соседи затопили мою квартиру, как взыскать ущерб?"
{
  "topic":     "залив квартиры соседями возмещение ущерба",
  "special":   "возмещение вреда имуществу при заливе квартиры",
  "general":   "общие положения об обязательствах из причинения вреда ГК КР",
  "process":   "срок исковой давности подсудность иск о возмещении вреда",
  "liability": "размер компенсации морального вреда неустойка ответственность виновника",
  "bylaws":    "правила содержания общего имущества жилых домов"
}

Вопрос: "Как взыскать долг абонента за тепловую энергию за 3 месяца?"
{
  "topic":     "взыскание задолженности абонента за теплоэнергию ЖКХ",
  "special":   "взыскание задолженности за тепловую энергию с абонента договор теплоснабжения",
  "general":   "общие положения об обязательствах исполнение оплата по договору ГК КР",
  "process":   "приказное производство срок исковой давности взыскание задолженности подсудность",
  "liability": "неустойка пеня за просрочку оплаты коммунальных услуг расторжение договора",
  "bylaws":    "правила теплоснабжения постановление Кабмина тарифы"
}`;
    try {
        const raw = await callOnce(getNextKey(), systemPrompt, userPrompt, 1);
        const cleaned = String(raw || '').replace(/```json|```/g, '').trim();
        const fi = cleaned.indexOf('{');
        const li = cleaned.lastIndexOf('}');
        const slice = (fi >= 0 && li > fi) ? cleaned.slice(fi, li + 1) : cleaned;
        const parsed = JSON.parse(slice);
        return {
            topic:     String(parsed.topic     || '').slice(0, 200),
            special:   String(parsed.special   || userMessage).slice(0, 280),
            general:   String(parsed.general   || userMessage).slice(0, 280),
            process:   String(parsed.process   || userMessage).slice(0, 280),
            liability: String(parsed.liability || userMessage).slice(0, 280),
            bylaws:    String(parsed.bylaws    || userMessage).slice(0, 280)
        };
    } catch (e) {
        console.error('[Reformulate] failed:', e.message);
        // Fallback — все запросы = исходный вопрос, topic пустой
        return {
            topic: '',
            special: userMessage,
            general: userMessage,
            process: userMessage,
            liability: userMessage,
            bylaws: userMessage
        };
    }
}

// 5-слойный retrieval со streaming step-событиями + prefix-контекст topic
// во всех 5 embedding-запросах (удерживает поиск в правильной отрасли права).
// Все 5 поисков идут параллельно — общее время ≈ max времени одного слоя.
async function deepRetrievalChain(userMessage, res) {
    // Шаг 0: реформулировка (1 LLM-вызов) → topic + 5 запросов
    sendStep(res, { id: 'reformulate', status: 'loading', text: 'Разлагаю вопрос на 5 поисковых стратегий' });
    sendStatus(res, '🧠 Формирую поисковые стратегии...');
    const queries = await reformulateQueries(userMessage);
    const topicLabel = queries.topic ? queries.topic : 'без явной темы';
    sendStep(res, {
        id: 'reformulate',
        status: 'success',
        text: 'Стратегии готовы',
        reason: queries.topic ? `Тема: ${queries.topic}` : null
    });
    console.log(`[DeepThink] Topic="${topicLabel}" special="${queries.special.slice(0,60)}"`);

    // PREFIX-контекст: удерживает все 5 embedding-векторов в одной отрасли.
    // Без него `срок исковой давности подсудность` мог уйти в трудовое право,
    // хотя юрист спрашивал про теплоэнергию.
    const ctxPrefix = queries.topic ? `[Контекст: ${queries.topic.slice(0, 160)}] ` : '';
    const wrap = (q) => ctxPrefix + q;

    // 5 loading-шагов СРАЗУ — пользователь видит весь roadmap
    sendStep(res, { id: 'special',   status: 'loading', text: 'Ищу специальные нормы по проблеме' });
    sendStep(res, { id: 'general',   status: 'loading', text: 'Проверяю общие положения Кодекса' });
    sendStep(res, { id: 'process',   status: 'loading', text: 'Анализирую процессуальные требования' });
    sendStep(res, { id: 'liability', status: 'loading', text: 'Ищу ответственность и санкции' });
    sendStep(res, { id: 'bylaws',    status: 'loading', text: 'Проверяю подзаконные акты' });

    // 5 параллельных retrieval — каждый с prefix-контекстом
    const [specRes, genRes, procRes, liabRes, bylawRes] = await Promise.allSettled([
        adaptiveRetrieval(wrap(queries.special),   'fast',     null, { maxK: 5,  minK: 3 }),
        adaptiveRetrieval(wrap(queries.general),   'thinking', null, { maxK: 10, minK: 4 }),
        adaptiveRetrieval(wrap(queries.process),   'thinking', null, { maxK: 8,  minK: 3 }),
        adaptiveRetrieval(wrap(queries.liability), 'fast',     null, { maxK: 6,  minK: 2 }),
        adaptiveRetrieval(wrap(queries.bylaws),    'fast',     null, { maxK: 5,  minK: 2 })
    ]);

    const specMatches  = specRes.status  === 'fulfilled' ? (specRes.value.all  || []) : [];
    const genMatches   = genRes.status   === 'fulfilled' ? (genRes.value.all   || []) : [];
    const procMatches  = procRes.status  === 'fulfilled' ? (procRes.value.all  || []) : [];
    const liabMatches  = liabRes.status  === 'fulfilled' ? (liabRes.value.all  || []) : [];
    const bylawMatches = bylawRes.status === 'fulfilled' ? (bylawRes.value.all || []) : [];

    sendStep(res, { id: 'special',   status: specMatches.length  ? 'success' : 'warning', text: `Специальных норм найдено: ${specMatches.length}` });
    sendStep(res, { id: 'general',   status: genMatches.length   ? 'success' : 'warning', text: `Общих положений найдено: ${genMatches.length}` });
    sendStep(res, { id: 'process',   status: procMatches.length  ? 'success' : 'warning', text: `Процессуальных норм найдено: ${procMatches.length}` });
    sendStep(res, { id: 'liability', status: liabMatches.length  ? 'success' : 'warning', text: `Норм об ответственности: ${liabMatches.length}` });
    sendStep(res, { id: 'bylaws',    status: bylawMatches.length ? 'success' : 'warning', text: `Подзаконных актов найдено: ${bylawMatches.length}` });

    return { specMatches, genMatches, procMatches, liabMatches, bylawMatches, queries };
}

// Иерархический контекст для финального LLM — 5 пронумерованных слоёв с дедупликацией
function formatLayeredContext({ specMatches, genMatches, procMatches, liabMatches, bylawMatches }) {
    const seen = new Set();
    const dedup = (m) => {
        const key = `${m.metadata?.npa_title || ''}|${m.metadata?.article_title || ''}`;
        if (!key || key === '|') return null;
        if (seen.has(key)) return null;
        seen.add(key);
        return m;
    };

    const groups = [
        { label: '⭐ СПЕЦИАЛЬНАЯ НОРМА (главный источник ответа)',  tag: 'СПЕЦИАЛЬНАЯ',  matches: specMatches.map(dedup).filter(Boolean) },
        { label: '🏛 ОБЩИЕ ПОЛОЖЕНИЯ (фундамент Кодекса)',          tag: 'ОБЩАЯ',        matches: genMatches.map(dedup).filter(Boolean) },
        { label: '⚖️ ПРОЦЕССУАЛЬНЫЕ НОРМЫ (как действовать)',        tag: 'ПРОЦЕСС',      matches: procMatches.map(dedup).filter(Boolean) },
        { label: '⚡ ОТВЕТСТВЕННОСТЬ И САНКЦИИ (что грозит)',        tag: 'ОТВЕТСТВЕННОСТЬ', matches: (liabMatches || []).map(dedup).filter(Boolean) },
        { label: '📋 ПОДЗАКОННЫЕ АКТЫ (детализация)',               tag: 'ПОДЗАКОН',     matches: bylawMatches.map(dedup).filter(Boolean) }
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

// Оркестратор: 4-слойный retrieval + финальный синтез по консультант-промпту.
// Подходит для любого юридического вопроса без приложенного документа.
async function handleDeepThinking(message, history, res, userQuery = null) {
    const userQ = (userQuery && userQuery.trim()) || message;
    const cleanHistory = sanitizeHistory(history);

    // Этапы 1-5: 5-слойный retrieval с SSE-шагами
    const { specMatches, genMatches, procMatches, liabMatches, bylawMatches } = await deepRetrievalChain(userQ, res);

    const allMatches = [...specMatches, ...genMatches, ...procMatches, ...liabMatches, ...bylawMatches];

    if (allMatches.length === 0) {
        sendStep(res, { id: 'synthesize', status: 'warning', text: 'В базе НПА нет данных по запросу' });
        res.write(`data: ${JSON.stringify({ text: 'К сожалению, в моей текущей базе НПА нет информации по этому вопросу. Рекомендую обратиться к юристу или сверить с cbd.minjust.gov.kg.' })}\n\n`);
        return;
    }

    // Этап 6: финальный синтез с layered context
    sendStep(res, { id: 'synthesize', status: 'loading', text: 'Формирую итоговую консультацию' });
    sendStatus(res, '✍️ Формирую итоговую консультацию...');

    const layeredContext = formatLayeredContext({ specMatches, genMatches, procMatches, liabMatches, bylawMatches });

    const isL4 = detectL4Request(userQ);
    let systemPrompt = BASE_CONSULTANT_PROMPT + `

═══ ИЕРАРХИЧЕСКИЙ КОНТЕКСТ (5 СЛОЁВ) ═══
Получаемый ниже контекст разделён на 5 слоёв — используй ВСЕ доступные слои для полного ответа:

1. ⭐ СПЕЦИАЛЬНАЯ НОРМА — конкретная статья по проблеме (главный источник ответа)
2. 🏛 ОБЩИЕ ПОЛОЖЕНИЯ — базовые принципы Кодекса (фундамент аргументации)
3. ⚖️ ПРОЦЕССУАЛЬНЫЕ НОРМЫ — сроки давности, подсудность, госпошлина (как действовать)
4. ⚡ ОТВЕТСТВЕННОСТЬ И САНКЦИИ — неустойка, штрафы, ответственность сторон (что грозит)
5. 📋 ПОДЗАКОННЫЕ АКТЫ — правила/инструкции/постановления (детализация)

Твой ответ ДОЛЖЕН строиться по схеме:
• специальная норма (что нарушено)
→ опора на общую (фундамент по Кодексу)
→ процессуальные шаги (срок исковой давности, в какой суд, госпошлина)
→ ответственность и санкции (размер взыскания, неустойка, штраф)
→ подзаконные детали (если есть)

Это даёт юристу полную картину: кто прав, в какой суд идти, в какие сроки, сколько госпошлины, какой размер санкций.
Все номера статей бери ТОЛЬКО из переданного контекста — никогда из памяти.`;
    if (isAcademicRequest(userQ)) systemPrompt += '\n\n' + ACADEMIC_PROMPT_ADDON;
    if (isL4) systemPrompt += '\n\n' + L4_WARNING_ADDON;

    const finalPrompt = `Вопрос пользователя: "${userQ}"\n\n${layeredContext}`;

    try {
        await streamGeminiResponse(getNextKey(), systemPrompt, finalPrompt, cleanHistory, res);
        sendStep(res, { id: 'synthesize', status: 'success', text: 'Консультация готова' });

        // Источники: top по 2 из каждого слоя
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
            ...pickN(specMatches, 2),
            ...pickN(genMatches, 2),
            ...pickN(procMatches, 1),
            ...pickN(liabMatches, 2),
            ...pickN(bylawMatches, 1)
        ].slice(0, 8);
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

async function segmentDocument(documentText, docContextStr = '') {
    if (!documentText || documentText.length < SEGMENT_MIN_CHARS) return [];
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
        if (segments.length >= SEGMENT_LIMIT) break;
    }
    console.log(`[Segmenter] raw=${raw.length} → final=${segments.length}`);
    return segments;
}

// ── 2A. VERIFIER (PER-SEGMENT) ───────────────────────────────────────
// Гибрид: 1 сегмент → embedding (heading + первые ~400 символов text)
// → Pinecone topK=5 → LLM-вердикт: соответствует/риск/нарушение/неясно.
const SEGMENT_VERIFIER_TOPK = 5;
const SEGMENT_VERIFIER_QUERY_MAXCHARS = 450;
async function verifySegment(segment, docContextStr = '') {
    const refLabel = `п.${segment.number} ${segment.heading}`.trim();
    try {
        // Сфокусированный embedding с PREFIX-контекстом — критично для семантического
        // поиска в Pinecone. Без префикса короткий пункт "Стоимость 1 Гкал" уходил
        // в embedding-пространство электроэнергии вместо теплоснабжения.
        // Контекст обрезаем до 180 символов чтобы оставить место для собственно текста пункта.
        const ctxPrefix = docContextStr ? `[Контекст документа: ${docContextStr.slice(0, 180)}] ` : '';
        const queryText = (ctxPrefix + `${segment.heading}. ${segment.text}`).slice(0, SEGMENT_VERIFIER_QUERY_MAXCHARS);
        const vector = await getEmbedding(queryText);
        const candidates = await searchPinecone(vector, SEGMENT_VERIFIER_TOPK);

        // Готовим релевантные статьи для LLM-судьи
        const applicableArticles = (candidates || []).map(c => ({
            article_title: c.metadata?.article_title || '',
            npa_title:     c.metadata?.npa_title || '',
            full_text:    (c.metadata?.full_text || '').slice(0, 1200),
            score: Number(c.score || 0)
        })).filter(a => a.full_text);

        if (applicableArticles.length === 0) {
            return {
                ...segment,
                ref: refLabel,
                status: 'unclear',
                findings: 'Не удалось найти релевантные статьи КР для этого пункта.',
                suggestion: null,
                applicable_articles: [],
                message: `⚠️ ${refLabel}: статьи КР не найдены`
            };
        }

        // LLM-судья: дан текст пункта + найденные релевантные статьи КР
        const ctxBlock = docContextStr
            ? `\n═══ КОНТЕКСТ ВСЕГО ДОКУМЕНТА (учитывай при оценке) ═══\n${docContextStr}\n═══════════════════════════════════════════════════════════\n`
            : '';
        const systemPrompt = `Ты — юрист-консультант Кыргызской Республики.
Анализируешь ОДИН пункт юридического документа и говоришь, соответствует ли
он действующему законодательству КР.

КРИТИЧЕСКИ ВАЖНО: ниже передан КОНТЕКСТ всего документа (тип, предметная
область). Применяй ТОЛЬКО нормы из соответствующей сферы — например, если
документ о теплоснабжении, не применяй к нему нормы про электроэнергию,
газоснабжение или водоснабжение, даже если найденные RAG-статьи о них говорят.
Если найденные статьи относятся к ДРУГОЙ предметной области (не той что в
контексте) — ставь статус "unclear" и в findings явно укажи это несоответствие.

Не упоминай законодательство РФ, Казахстана и других стран.
Отвечаешь СТРОГО JSON без markdown без пояснений.`;
        const userPrompt = `${ctxBlock}Пункт документа (${refLabel}):
"""
${segment.text}
"""

Релевантные статьи законодательства КР (из векторной базы):
${applicableArticles.map((a, i) => `[${i + 1}] ${a.npa_title} — ${a.article_title}
${a.full_text}
`).join('\n')}

Оцени пункт договора/документа В КОНТЕКСТЕ всего документа (см. блок выше).
Верни JSON:
{
  "status": "ok" | "risk" | "violation" | "unclear",
  "applicable_refs": ["1", "3"],  // индексы статей из списка выше, которые ДЕЙСТВИТЕЛЬНО относятся к теме (не путать со смежными отраслями)
  "findings": "1-2 предложения: что выявил (соответствие/риск/проблема/несоответствие отрасли)",
  "suggestion": "если статус risk/violation — короткое предложение как исправить (или null)"
}

Расшифровка status:
- ok        — пункт соответствует найденным нормам ИЗ ТОЙ ЖЕ отрасли
- risk      — пункт юридически валиден, но содержит потенциальный риск
- violation — пункт противоречит закону КР или содержит запрещённое условие
- unclear   — недостаточно информации ИЛИ найденные статьи из СМЕЖНОЙ отрасли (не подходят)`;

        const raw = await callOnce(getNextKey(), systemPrompt, userPrompt, 1);
        const cleaned = String(raw || '').replace(/```json|```/g, '').trim();
        const fi = cleaned.indexOf('{');
        const li = cleaned.lastIndexOf('}');
        const slice = (fi >= 0 && li > fi) ? cleaned.slice(fi, li + 1) : cleaned;
        let parsed = {};
        try { parsed = JSON.parse(slice); } catch (e) { parsed = {}; }

        const status = ['ok', 'risk', 'violation', 'unclear'].includes(parsed.status)
            ? parsed.status : 'unclear';
        const findings = String(parsed.findings || '').trim() || 'Анализ не дал явного результата.';
        const suggestion = parsed.suggestion ? String(parsed.suggestion).trim() : null;

        // Карта индексов → массив применимых статей (только реально использованных судьёй)
        const idxs = Array.isArray(parsed.applicable_refs) ? parsed.applicable_refs : [];
        const used = idxs
            .map(i => applicableArticles[Number(i) - 1])
            .filter(Boolean);
        const finalApplicable = used.length > 0 ? used : applicableArticles.slice(0, 2);

        const statusIcon = { ok: '✅', risk: '⚠️', violation: '❌', unclear: 'ℹ️' }[status];
        return {
            ...segment,
            ref: refLabel,
            status,
            findings,
            suggestion,
            applicable_articles: finalApplicable,
            message: `${statusIcon} ${refLabel}: ${findings.slice(0, 70)}${findings.length > 70 ? '…' : ''}`
        };
    } catch (e) {
        console.error('[Seg-Verifier] err for', refLabel, ':', e.message);
        return {
            ...segment,
            ref: refLabel,
            status: 'error',
            findings: 'Ошибка проверки пункта.',
            suggestion: null,
            applicable_articles: [],
            error: e.message,
            message: `⚠️ ${refLabel}: ошибка проверки`
        };
    }
}

// Параллельно через Promise.allSettled. SSE-шаги в реальном времени.
async function verifyAllSegments(segments, res, docContextStr = '') {
    const STATUS_MAP = {
        ok: 'success',
        risk: 'warning',
        violation: 'error',
        unclear: 'info',
        error: 'error'
    };
    const promises = segments.map((seg, i) => {
        const stepId = `segverify_${i}`;
        const refLabel = `п.${seg.number} ${seg.heading}`.trim();
        sendStep(res, { id: stepId, status: 'loading', text: refLabel });
        return verifySegment(seg, docContextStr).then(result => {
            const uiStatus = STATUS_MAP[result.status] || 'info';
            sendStep(res, {
                id: stepId,
                status: uiStatus,
                text: result.ref || refLabel,
                reason: result.findings || null
            });
            sendStatus(res, result.message);
            console.log(`[SegVerify ${i + 1}/${segments.length}] ${result.message}`);
            return result;
        });
    });
    const settled = await Promise.allSettled(promises);
    return settled.filter(r => r.status === 'fulfilled').map(r => r.value);
}

// Сводный payload для UI: SegmentReport — список пунктов с вердиктами + статистика
function buildSegmentReport(results) {
    if (!results || results.length === 0) return null;
    const counts = { ok: 0, risk: 0, violation: 0, unclear: 0, error: 0 };
    for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
    return {
        total: results.length,
        ok: counts.ok || 0,
        risk: counts.risk || 0,
        violation: counts.violation || 0,
        unclear: counts.unclear || 0,
        error: counts.error || 0,
        segments: results.map(r => ({
            id: r.id,
            number: r.number,
            heading: r.heading,
            status: r.status,
            findings: r.findings,
            suggestion: r.suggestion,
            text: r.text,
            applicable_articles: r.applicable_articles || []
        }))
    };
}

// ── 2. VERIFIER (PER-ARTICLE) ────────────────────────────────────────
// КЛЮЧЕВАЯ ФУНКЦИЯ. 1 статья = 1 embedding = 1 Pinecone query (topK=5).
async function verifySingleArticle(article) {
    const cfg = DOC_ANALYSIS_CONFIG;
    const act = article.act || '';
    const num = article.article || '';
    // Fallback: если topic пустой — берём context документа (он несёт смысл нормы)
    const topic = (article.topic && article.topic.trim()) || (article.context || '').trim();
    const refLabel = `Ст.${num} ${act}`.trim();

    try {
        // Сфокусированный embedding для ОДНОЙ статьи
        const searchQuery = `${act} Статья ${num} ${topic}`.trim();
        const vector = await getEmbedding(searchQuery);
        const candidates = await searchPinecone(vector, cfg.pineconeTopK);

        if (!candidates || candidates.length === 0) {
            return {
                ...article,
                ref: refLabel,
                status: 'not_found',
                confidence: 'low',
                score: 0,
                ragText: null, ragTitle: null, ragNpaTitle: null,
                suggestedArticle: null,
                message: `❌ ${refLabel}: не найдена в базе`
            };
        }

        // Regex match по всем 5 кандидатам
        const bestMatch = findBestArticleMatch(candidates, article);
        const score = Number((bestMatch && bestMatch.score) || 0);
        const confidence = score >= cfg.confidenceThresholds.high ? 'high'
                         : score >= cfg.confidenceThresholds.medium ? 'medium'
                         : 'low';

        if (bestMatch && bestMatch.numberMatches) {
            return {
                ...article,
                ref: refLabel,
                status: 'verified',
                confidence,
                score,
                ragText: bestMatch.metadata?.full_text || null,
                ragTitle: bestMatch.metadata?.article_title || null,
                ragNpaTitle: bestMatch.metadata?.npa_title || null,
                suggestedArticle: null,
                message: `✅ ${refLabel}: подтверждена (score ${score.toFixed(3)})`
            };
        }
        if (bestMatch && score >= cfg.confidenceThresholds.medium) {
            // Нашли похожую но под другим номером
            const foundNumber = extractArticleNumber(bestMatch.metadata?.full_text);
            return {
                ...article,
                ref: refLabel,
                status: 'mismatch',
                confidence: 'medium',
                score,
                ragText: bestMatch.metadata?.full_text || null,
                ragTitle: bestMatch.metadata?.article_title || null,
                ragNpaTitle: bestMatch.metadata?.npa_title || null,
                suggestedArticle: foundNumber,
                message: `⚠️ ${refLabel}: ближайшее — ст.${foundNumber || '?'} (score ${score.toFixed(3)})`
            };
        }
        return {
            ...article,
            ref: refLabel,
            status: 'not_found',
            confidence: 'low',
            score,
            ragText: null, ragTitle: null, ragNpaTitle: null,
            suggestedArticle: null,
            message: `❌ ${refLabel}: не найдена в базе (best score ${score.toFixed(3)})`
        };
    } catch (e) {
        console.error('[Verifier] err for', refLabel, ':', e.message);
        return {
            ...article,
            ref: refLabel,
            status: 'error',
            confidence: 'low',
            score: 0,
            ragText: null, ragTitle: null, ragNpaTitle: null,
            suggestedArticle: null,
            error: e.message,
            message: `⚠️ ${refLabel}: ошибка проверки`
        };
    }
}

// ВСЕ статьи параллельно через Promise.allSettled. SSE-статусы в реальном времени.
// Эмитим per-article шаги:
//   1) loading — сразу при старте (со стабильным id verify_N)
//   2) success/warning/error — после завершения (тот же id для перезаписи)
async function verifyAllArticles(articles, res) {
    const STATUS_MAP = {
        verified: 'success',
        mismatch: 'warning',
        not_found: 'error',
        error: 'error'
    };
    const promises = articles.map((article, i) => {
        const stepId = `verify_${i}`;
        const refLabel = `Ст. ${article.article || '?'} ${article.act || ''}`.trim();
        // Loading-событие СРАЗУ — фронт нарисует спиннер
        sendStep(res, { id: stepId, status: 'loading', text: refLabel });
        return verifySingleArticle(article).then(result => {
            const uiStatus = STATUS_MAP[result.status] || 'success';
            let reason = null;
            if (result.status === 'not_found') {
                reason = 'Норма отсутствует в базе';
            } else if (result.status === 'mismatch') {
                reason = result.suggestedArticle
                    ? `Найдено совпадение со ст. ${result.suggestedArticle}`
                    : 'Найдена близкая, но не совпадающая статья';
            } else if (result.status === 'error') {
                reason = 'Ошибка проверки';
            }
            sendStep(res, {
                id: stepId,
                status: uiStatus,
                text: result.ref || refLabel,
                reason,
                score: result.score || 0
            });
            sendStatus(res, result.message); // back-compat для регулярного чата
            console.log(`[Verify ${i + 1}/${articles.length}] ${result.message}`);
            return result;
        });
    });
    const settled = await Promise.allSettled(promises);
    return settled
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value);
}

// ── 3. CONFIDENCE ────────────────────────────────────────────────────
function calculateConfidence(results) {
    if (!results || results.length === 0) {
        return { level: 'unknown', total: 0, verified: 0, notFound: 0, mismatched: 0, avgScore: 0 };
    }
    const verified = results.filter(r => r.status === 'verified');
    const notFound = results.filter(r => r.status === 'not_found' || r.status === 'error');
    const mismatched = results.filter(r => r.status === 'mismatch');
    const avgScore = verified.length > 0
        ? verified.reduce((s, v) => s + (v.score || 0), 0) / verified.length
        : 0;

    let level;
    if (notFound.length > results.length * 0.5) level = 'low';
    else if (notFound.length > 0 || mismatched.length > 0) level = 'medium';
    else level = 'high';

    return {
        level,
        total: results.length,
        verified: verified.length,
        notFound: notFound.length,
        mismatched: mismatched.length,
        avgScore: Number(avgScore.toFixed(3))
    };
}

// Структура для UI: подробный список статей с reason для confidence badge раскрытия.
function buildArticleDetail(v) {
    let status, reason;
    if (v.status === 'verified') {
        status = 'ok';
        reason = v.ragNpaTitle
            ? `Найдено: ${v.ragNpaTitle}${v.ragTitle ? ' — ' + v.ragTitle : ''}`
            : 'Подтверждено в базе НПА';
    } else if (v.status === 'mismatch') {
        status = 'mismatch';
        reason = `В документе: ст.${v.article || '?'}. В базе ближайшее совпадение — ст.${v.suggestedArticle || '?'} (${v.ragNpaTitle || ''}).`;
    } else if (v.status === 'error') {
        status = 'not_found';
        reason = `Ошибка проверки: ${v.error || ''}. Сверьте с cbd.minjust.gov.kg.`;
    } else {
        status = 'not_found';
        reason = 'В правовой базе нет статьи с достаточным совпадением. Возможно: устаревшая редакция, опечатка или отсутствие в индексе.';
    }
    return {
        ref: v.ref || `Ст.${v.article || '?'} ${v.act || ''}`,
        status, reason,
        score: Number((v.score || 0).toFixed(3)),
        articleNumber: v.article || '',
        lawName: v.act || '',
        ragNpaTitle: v.ragNpaTitle || '',
        ragArticleNumber: v.suggestedArticle || '',
        context: v.context ? v.context.slice(0, 140) : '',
        ragText: v.ragText ? v.ragText.slice(0, 280) + (v.ragText.length > 280 ? '…' : '') : ''
    };
}

// ── 4. JUDGE ─────────────────────────────────────────────────────────
// Два источника правды: (1) per-article verification (если в документе были
// ссылки на статьи); (2) per-segment verification (всегда). Judge сводит оба
// в единый markdown-вердикт. Если articles нет — пропускает первый раздел.
// docContextStr — паспорт документа (тип, предметная область) для anti-cross-domain.
async function runJudge(documentText, articleResults, res, segmentResults = [], docContextStr = '') {
    const articleReport = (articleResults && articleResults.length > 0)
        ? articleResults.map(v => {
            if (v.status === 'verified') {
                return `✅ Ст.${v.article} ${v.act} (score ${v.score.toFixed(3)})\n` +
                       `   В документе: "${v.context || ''}"\n` +
                       `   Оригинал из базы: "${(v.ragText || '').slice(0, 350)}"`;
            }
            if (v.status === 'mismatch') {
                return `⚠️ Ст.${v.article} ${v.act} — НОМЕР НЕ СОВПАЛ\n` +
                       `   В базе ближайшее: ст.${v.suggestedArticle || '?'} (${v.ragNpaTitle || ''})\n` +
                       `   Текст найденного: "${(v.ragText || '').slice(0, 250)}"`;
            }
            if (v.status === 'error') {
                return `⚠️ Ст.${v.article} ${v.act} — ошибка проверки: ${v.error || 'unknown'}`;
            }
            return `❌ Ст.${v.article} ${v.act} — не найдена в базе НПА КР`;
        }).join('\n\n---\n\n')
        : null;

    const segReport = (segmentResults && segmentResults.length > 0)
        ? segmentResults.map(s => {
            const icon = { ok: '✅', risk: '⚠️', violation: '❌', unclear: 'ℹ️', error: '⚠️' }[s.status] || 'ℹ️';
            const applicable = (s.applicable_articles || []).slice(0, 2)
                .map(a => `${a.npa_title} — ${a.article_title}`).join('; ');
            return `${icon} п.${s.number} «${s.heading}» [${s.status}]\n` +
                   `   Цитата: "${(s.text || '').slice(0, 220)}${(s.text||'').length>220?'…':''}"\n` +
                   `   Вывод: ${s.findings || ''}\n` +
                   (applicable ? `   Применимы: ${applicable}\n` : '') +
                   (s.suggestion ? `   Рекомендация: ${s.suggestion}` : '');
        }).join('\n\n---\n\n')
        : null;

    const sections = [];
    if (docContextStr) sections.push(`═══ ПАСПОРТ ДОКУМЕНТА (учитывай отрасль при оценке) ═══\n\n${docContextStr}`);
    if (articleReport) sections.push(`═══ ПРОВЕРКА УПОМЯНУТЫХ СТАТЕЙ (источник истины #1) ═══\n\n${articleReport}`);
    if (segReport)     sections.push(`═══ ПРОВЕРКА ПУНКТОВ ДОКУМЕНТА (источник истины #2) ═══\n\n${segReport}`);

    const userPrompt = `${sections.join('\n\n')}

═══ ДОКУМЕНТ ПОЛЬЗОВАТЕЛЯ ═══
${(documentText || '').slice(0, 15000)}

Сформируй итоговое заключение СТРОГО на основе отчётов выше.
${docContextStr ? `КОНТЕКСТ: документ относится к указанной выше отрасли — не применяй к нему нормы из смежных, но не относящихся к делу областей (например, не путай теплоснабжение с электроэнергией, поставку с подрядом).\n` : ''}
Структура ответа (markdown):
1. **Краткий вывод** — 2-3 предложения о документе в целом${docContextStr ? ' (укажи тип и предметную область)' : ''}.
2. **Замечания по пунктам** — пройдись по проблемным пунктам (risk/violation), для каждого: цитата → проблема → ст. КР → рекомендация.
3. **Подтверждённые ссылки на статьи** — если есть.
4. **Общие рекомендации** — что доработать.

ЗАПРЕЩЕНО: упоминать номера статей которых нет в отчётах; ссылаться на
законодательство РФ/Казахстана; придумывать факты не из документа;
применять нормы из смежных, но не относящихся к делу отраслей права.`;

    // Низкая temperature — критична для anti-hallucination
    const judgeConfig = { temperature: 0.2, topP: 0.85, maxOutputTokens: 4096 };
    try {
        await streamGeminiResponse(getNextKey(), JUDGE_SYSTEM_PROMPT, userPrompt, [], res, judgeConfig);
    } catch (err) {
        console.error('[Judge] failed:', err.message);
        try {
            await streamGeminiResponse(getNextKey(), JUDGE_SYSTEM_PROMPT, userPrompt, [], res, judgeConfig);
        } catch (e2) {
            console.error('[Judge] fallback failed:', e2.message);
            res.write(`data: ${JSON.stringify({ text: '\n\n⚠️ Ошибка генерации финального анализа. Попробуйте повторить.' })}\n\n`);
        }
    }
}

// ── 5. ORCHESTRATOR ──────────────────────────────────────────────────
// Гибридный pipeline:
//   • Параллельно — extractor (ссылки на статьи) и segmenter (нумерация пунктов).
//   • Параллельно — verifyAllArticles + verifyAllSegments.
//   • Judge получает оба отчёта и формирует единый markdown-вердикт.
// Документ без явных ссылок на статьи: extractor вернёт [], segmenter всё равно
// разобьёт документ — анализ выдаётся на основе segment-отчёта.
async function analyzeDocumentSmart(documentText, userQuery, res) {
    const startTime = Date.now();
    try {
        // Этап 0: ПАСПОРТ ДОКУМЕНТА — извлекаем общий контекст ПЕРЕД сегментацией.
        // Иначе при чанкинге каждый кусок теряет глобальный смысл (договор о
        // теплоснабжении — а пункт "Стоимость 1 Гкал" уезжает в электроэнергию).
        sendStep(res, { id: 'context', status: 'loading', text: 'Определяю тип и предметную область документа' });
        sendStatus(res, '🧭 Определяю контекст документа...');
        const docContext = await extractDocumentContext(documentText);
        const docContextStr = formatDocContext(docContext);
        if (docContext && docContext.document_type) {
            sendStep(res, {
                id: 'context',
                status: 'success',
                text: docContext.document_type,
                reason: docContext.subject_area || null
            });
            console.log(`[DocContext] ${docContext.document_type} | ${docContext.subject_area}`);
        } else {
            sendStep(res, { id: 'context', status: 'warning', text: 'Контекст не определён — анализ по общим правилам' });
        }

        // Этап 1: параллельно — Extractor и Segmenter (оба видят контекст)
        sendStep(res, { id: 'extract',  status: 'loading', text: 'Извлекаю ссылки на статьи НПА' });
        sendStep(res, { id: 'segment',  status: 'loading', text: 'Разбиваю документ на пункты' });
        sendStatus(res, '📄 Извлекаю ссылки на НПА и пункты документа...');

        const [articlesResult, segmentsResult] = await Promise.allSettled([
            extractArticles(documentText),
            segmentDocument(documentText, docContextStr)
        ]);
        const articles = articlesResult.status === 'fulfilled' ? articlesResult.value : [];
        const segments = segmentsResult.status === 'fulfilled' ? segmentsResult.value : [];

        if (articles.length > 0) {
            sendStep(res, { id: 'extract', status: 'success', text: `Найдено ссылок на НПА: ${articles.length}` });
        } else {
            sendStep(res, { id: 'extract', status: 'info', text: 'Ссылки на статьи не обнаружены', reason: 'Перехожу к проверке пунктов' });
        }

        if (segments.length > 0) {
            sendStep(res, { id: 'segment', status: 'success', text: `Документ разбит на пунктов: ${segments.length}` });
        } else {
            sendStep(res, { id: 'segment', status: 'warning', text: 'Не удалось разбить документ на пункты' });
        }

        // Если совсем нечего проверять — fallback на общий анализ
        if (articles.length === 0 && segments.length === 0) {
            sendStatus(res, 'ℹ️ Документ короткий или нестандартный. Переключаюсь на общий анализ...');
            const fb = `Запрос: ${userQuery || 'Проанализируй документ'}\n\nДокумент:\n"""\n${(documentText || '').slice(0, 15000)}\n"""`;
            await handleAgent(fb, [], res, 0, userQuery);
            return;
        }

        sendStatus(res, `🔬 Проверяю: ${articles.length} статей · ${segments.length} пунктов (параллельно)`);

        // Этап 2: параллельная проверка статей и пунктов (с контекстом документа)
        const [articleSettled, segmentSettled] = await Promise.allSettled([
            articles.length > 0 ? verifyAllArticles(articles, res) : Promise.resolve([]),
            segments.length > 0 ? verifyAllSegments(segments, res, docContextStr) : Promise.resolve([])
        ]);
        const articleResults = articleSettled.status === 'fulfilled' ? articleSettled.value : [];
        const segmentResults = segmentSettled.status === 'fulfilled' ? segmentSettled.value : [];

        // Этап 3a: Confidence (по статьям) — только если статьи были
        if (articleResults.length > 0) {
            const confidencePayload = calculateConfidence(articleResults);
            confidencePayload.articles = articleResults.map(buildArticleDetail);
            sendConfidence(res, confidencePayload);
        }

        // Этап 3b: SegmentReport — всегда когда были пункты
        if (segmentResults.length > 0) {
            const segReport = buildSegmentReport(segmentResults);
            if (segReport) {
                res.write(`data: ${JSON.stringify({ segmentReport: segReport })}\n\n`);
            }
            const issues = segmentResults.filter(s => s.status === 'risk' || s.status === 'violation').length;
            sendStatus(res, `📊 Пунктов: ${segmentResults.length} · Проблемных: ${issues}`);
        }

        // Источники для chip-badges: verified статьи + applicable из сегментов
        const seenSources = new Set();
        const sources = [], metadata = [];
        for (const v of articleResults.filter(r => r.status === 'verified' && r.ragNpaTitle)) {
            const key = `${v.ragNpaTitle}|${v.article}`;
            if (seenSources.has(key)) continue;
            seenSources.add(key);
            sources.push(`${v.ragNpaTitle} — Ст.${v.article}`);
            metadata.push({
                npa_title: v.ragNpaTitle,
                article_title: v.ragTitle || `Статья ${v.article}`,
                full_text: v.ragText || ''
            });
            if (sources.length >= 8) break;
        }
        for (const s of segmentResults) {
            for (const a of (s.applicable_articles || []).slice(0, 1)) {
                if (sources.length >= 8) break;
                const key = `${a.npa_title}|${a.article_title}`;
                if (seenSources.has(key)) continue;
                seenSources.add(key);
                sources.push(`${a.npa_title} — ${a.article_title}`);
                metadata.push({
                    npa_title: a.npa_title,
                    article_title: a.article_title,
                    full_text: a.full_text || ''
                });
            }
        }
        if (sources.length > 0) {
            res.write(`data: ${JSON.stringify({ sources, metadata })}\n\n`);
        }

        // Этап 4: Judge — гибридный, с паспортом документа
        sendStep(res, { id: 'judge', status: 'loading', text: 'Формирую юридическое заключение' });
        sendStatus(res, '⚖️ Формирую юридическое заключение...');
        await runJudge(documentText, articleResults, res, segmentResults, docContextStr);
        sendStep(res, { id: 'judge', status: 'success', text: 'Заключение готово' });
        console.log(`[DocAnalysis] Done: articles=${articleResults.length}, segments=${segmentResults.length}, ${Date.now() - startTime}ms`);
    } catch (err) {
        console.error('[analyzeDocumentSmart] fatal:', err);
        sendStatus(res, '❌ Ошибка анализа. Переключаюсь на обычный путь...');
        try {
            const fb = `Запрос: ${userQuery || 'Проанализируй документ'}\n\nДокумент:\n"""\n${(documentText || '').slice(0, 15000)}\n"""`;
            await handleAgent(fb, [], res, 0, userQuery);
        } catch (e2) {
            res.write(`data: ${JSON.stringify({ text: '\n\n⚠️ Критическая ошибка: ' + (err && err.message || 'unknown') })}\n\n`);
        }
    }
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
async function strategyCounterargs(threats, perspective, docContextStr) {
    if (!threats || threats.length === 0) return [];
    const ctxPrefix = docContextStr ? `[Контекст: ${docContextStr.slice(0, 160)}] ` : '';
    const perspGoal = perspective === 'opponent'
        ? 'Найди норму КР которая ПЕРЕКРЫВАЕТ эту угрозу — поможет нашей защите.'
        : perspective === 'ours'
            ? 'Найди норму КР которая ПОДКРЕПЛЯЕТ наш аргумент по этому пункту или закрывает риск.'
            : 'Найди норму КР по этому риску.';
    const promises = threats.slice(0, 6).map(async (t, i) => {
        const query = ctxPrefix + `Норма КР перекрывающая угрозу: ${t.heading || ''}. ${t.comment || ''}`.slice(0, 350);
        try {
            const vec = await getEmbedding(query);
            const candidates = await searchPinecone(vec, 5);
            const top = (candidates || []).filter(c => c.metadata?.full_text).slice(0, 3);
            if (top.length === 0) return null;
            // LLM-выжимка: какая из найденных норм лучше всего перекрывает + 1 предложение аргумента
            const articlesText = top.map((c, k) => `[${k+1}] ${c.metadata?.npa_title || ''} — ${c.metadata?.article_title || ''}\n${(c.metadata?.full_text || '').slice(0, 800)}`).join('\n\n');
            const sysP = `Ты — юрист-стратег КР. По угрозе и списку статей выбираешь ОДНУ норму
которая лучше всего её перекрывает, и формулируешь короткий аргумент (1-2 предложения).
Отвечаешь СТРОГО JSON без markdown.`;
            const userP = `${perspGoal}

Угроза/риск: «${t.comment || t.heading}»
${t.number ? `Из пункта документа: п.${t.number}` : ''}

Статьи КР (выбери одну, индекс 1-${top.length}):
${articlesText}

Формат:
{
  "best_index": 1,
  "argument": "1-2 предложения юридического аргумента на основе выбранной статьи"
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
Если 'ours' — с позиции нашего клиента. Если 'audit' — нейтрально.`;

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
        const judgeCfg = { temperature: 0.25, topP: 0.85, maxOutputTokens: 1500 };
        // Не стримим — нам нужен JSON целиком
        const genAI = new GoogleGenerativeAI(getNextKey());
        const model = genAI.getGenerativeModel({
            model: 'gemini-flash-latest',
            systemInstruction: SENIOR_PARTNER_PROMPT,
            generationConfig: judgeCfg
        });
        const result = await model.generateContent(userPrompt);
        const raw = result.response.text();
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
        let auditResults = null, strategyResults = null;

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

        await Promise.allSettled(tasks);

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
            drafter: null,
            mentor:  null
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
app.post('/api/deep-analyze-document', async (req, res) => {
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

        console.log(`\n[DeepAnalysis] doc=${documentText.length}ch | persp=${persp} | modules=${mods.join(',')} | query="${(userQuery || '').slice(0, 60)}"`);

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

// ============================================================
// ГЛАВНЫЙ МАРШРУТ
// ============================================================
app.post('/api/chat', async (req, res) => {
    serverStats.totalRequests++;
    try {
        const { message, history, mode = 'fast', agentMode = false, userQuery = null, skipRetrieval = false } = req.body;
        if (!message) return res.status(400).json({ reply: "Пусто" });

        console.log(`\nЗапрос: "${message.slice(0,80)}${message.length>80?'…':''}" | Режим: ${mode}${agentMode?' [AGENT]':''}${skipRetrieval?' [skipRAG]':''}${userQuery?` | userQuery: ${userQuery.slice(0,60)}`:''}`);

        // SSE headers с антибуферизацией Render
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');   // отключить буферизацию прокси
        if (typeof res.flushHeaders === 'function') {
            res.flushHeaders();                      // сразу отправить headers клиенту
        }

        // ════════════════════════════════════════════════════════════════
        // AGENT MODE (IDE document editing — Cursor-style)
        // Перехватываем ДО fast/thinking — нам нужен другой system-prompt
        // и облегчённый retrieval для цитирования НПА в insertion_text.
        // ════════════════════════════════════════════════════════════════
        if (agentMode) {
            await handleAgent(message, history, res, 0, userQuery);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
        }

        if (mode === 'fast') {
            const casual = isCasualMessage(message);
            let retrievalResult = { core: [], context: [], all: [] };

            if (casual) {
                console.log("Режим: приветствие — Pinecone пропущен");
            } else if (skipRetrieval) {
                console.log("Режим: skipRetrieval=true — Pinecone пропущен (chunk-summarization)");
            } else {
                retrievalResult = await adaptiveRetrieval(message, 'fast');
            }
            await handleFast(message, history, retrievalResult, res);

            // Send sources + metadata for fast mode too (if retrieval found anything)
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
                // SMART ROUTER: классификатор определяет глубину поиска.
                // • simple  → handleSimpleConsultation (1 retrieval, ~3-5с)
                // • complex → handleDeepThinking (5 слоёв, ~6-9с)
                // Юристу не нужно выбирать режим вручную — система сама понимает.
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
        }

        res.write('data: [DONE]\n\n');
        res.end();

    } catch (error) {
        console.error("Глобальная ошибка сервера:", error.message);
        try {
            res.write(`data: ${JSON.stringify({ text: '\n\n⚠️ Произошла системная ошибка (серверы нейросети недоступны). Пожалуйста, повторите запрос.' })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        } catch (writeErr) {
            console.error("Не удалось записать ошибку в поток:", writeErr.message);
        }
    }
});

// ════════════════════════════════════════════════════════════════════
// /api/analyze-document — Document-Grounded Analysis pipeline
// ════════════════════════════════════════════════════════════════════
// Body: { documentText: string, userQuery?: string }
// Stream SSE events:
//   { protocolStatus, icon }        — этапы pipeline
//   { confidence: {level, ...} }    — общая уверенность
//   { sources, metadata }           — найденные в RAG источники
//   { text }                        — стрим финального анализа
//   [DONE]                          — конец
// ════════════════════════════════════════════════════════════════════
app.post('/api/analyze-document', async (req, res) => {
    serverStats.totalRequests++;
    try {
        const { documentText = '', userQuery = '' } = req.body || {};
        const trimmedLen = (documentText || '').trim().length;
        if (trimmedLen < DOC_ANALYSIS_CONFIG.minDocumentLength) {
            return res.status(400).json({
                error: `Документ слишком короткий (${trimmedLen}/${DOC_ANALYSIS_CONFIG.minDocumentLength} символов). Используйте обычный чат для коротких запросов.`
            });
        }

        console.log(`\n[AnalyzeDoc] doc=${documentText.length}ch | query: "${(userQuery || '').slice(0, 80)}"`);

        // SSE headers с антибуферизацией Render
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();

        await analyzeDocumentSmart(documentText, userQuery, res);

        res.write('data: [DONE]\n\n');
        res.end();
    } catch (error) {
        console.error('[/api/analyze-document] global error:', error.message);
        try {
            res.write(`data: ${JSON.stringify({ text: '\n\nСистемная ошибка. Повторите запрос.' })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        } catch (writeErr) {
            console.error('Не удалось записать ошибку в поток:', writeErr.message);
        }
    }
});

// ============================================================
// ЗАПУСК
// ============================================================
app.listen(PORT, () => {
    console.log('\n==========================================');
    console.log('Мыйзамчи запущен на порту ' + PORT);
    console.log('Загружено ключей Gemini: ' + KEYS.length);
    console.log('Адрес базы: ' + cleanPineconeHost);
    console.log('==========================================\n');

    // Запуск Telegram бота
    bot.launch()
        .then(() => console.log('Telegram бот успешно запущен'))
        .catch(err => console.error('Ошибка запуска Telegram бота:', err));
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
process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught Exception:', err.message);
    console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] Unhandled Rejection:', reason);
});
