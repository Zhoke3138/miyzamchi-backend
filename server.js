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
const DOCUMENT_ANALYSIS_CONFIG = {
    extractorKeyIndex: 0,           // Key[0] для Extractor
    synthesizerKeyIndex: 12,        // Key[12] для Synthesizer (последний из 13)
    verificationKeys: Array.from({ length: 11 }, (_, i) => i + 1), // Key[1..11]
    maxArticles: 30,
    defaultArticlesPerAgent: 3,
    extractorChunkSize: 7000,
    extractorChunkOverlap: 500,
    confidenceThresholds: { high: 0.75, medium: 0.70, low: 0.60 }
};

function getArticlesPerAgent(totalArticles, availableKeys) {
    if (availableKeys <= 0) return totalArticles;
    const baseN = Math.ceil(totalArticles / availableKeys);
    return Math.max(baseN, DOCUMENT_ANALYSIS_CONFIG.defaultArticlesPerAgent);
}

// Нормализация номера статьи для сравнения "1¹" vs "1-1" и т.п.
function normalizeArticleNumber(num) {
    if (num === null || num === undefined) return '';
    return String(num)
        .toLowerCase()
        .replace(/\s+/g, '')
        .replace(/\./g, '')
        .replace(/¹/g, '-1').replace(/²/g, '-2').replace(/³/g, '-3').replace(/⁴/g, '-4')
        .replace(/⁵/g, '-5').replace(/⁶/g, '-6').replace(/⁷/g, '-7').replace(/⁸/g, '-8')
        .replace(/⁹/g, '-9').replace(/⁰/g, '-0');
}

// Парсим номер статьи из full_text Pinecone-метаданных.
// Примеры: "Статья 1¹. Предмет регулирования" → "1¹"
//          "Статья 137 Пытки"                  → "137"
function extractArticleNumberFromMetadata(metadata) {
    const fullText = (metadata && metadata.full_text) || '';
    const m = fullText.match(/Статья\s+([\d¹²³⁴⁵⁶⁷⁸⁹⁰\-\.]+)/);
    if (!m) return null;
    return m[1].trim().replace(/\.$/, '');
}

// Векторный поиск с приоритизацией matches по lawNameHint.
// apiKey передаётся в getEmbedding для распределения нагрузки между ключами.
async function searchPineconeByText(searchText, lawNameHint = null, apiKey = null) {
    try {
        if (!searchText || !searchText.trim()) return null;
        const vector = await getEmbedding(searchText, 0, apiKey);
        const results = await searchPinecone(vector, 5);
        if (!results || results.length === 0) return null;

        if (lawNameHint) {
            const hint = lawNameHint.toLowerCase().slice(0, 12);
            const exact = results.find(r =>
                r.metadata && r.metadata.npa_title &&
                r.metadata.npa_title.toLowerCase().includes(hint)
            );
            if (exact) return exact;
        }
        return results[0];
    } catch (e) {
        console.error('[searchPineconeByText] err:', e.message);
        return null;
    }
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
    "- **ДИСКЛЕЙМЕР:** Короткое предупреждение \"Я — ИИ-ассистент, а не юрист\" добавляй ТОЛЬКО в конце ответа на реальный юридический вопрос, и СТРОГО ОДИН РАЗ за сообщение. Не дублируй; не добавляй в болталке, шаблонах документов и академических работах.",
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
10. **ДИСКЛЕЙМЕР:** Короткое предупреждение «Я — ИИ-ассистент, а не юрист» добавляй ТОЛЬКО в конце ответа на реальный юридический вопрос, и СТРОГО ОДИН РАЗ за сообщение. Не дублируй; не добавляй в болталке, шаблонах документов и академических работах. Пример формата:
    > ⚠️ *Мыйзамчи — ИИ-ассистент. Ответ основан на нормах КР, но не заменяет очную консультацию юриста.*

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
const DOCUMENT_ANALYSIS_PROMPT = `
Ты — **Мыйзамчи Аналитик документов**. Проводишь юридический анализ документа пользователя.

═══ ИСТОЧНИК ИСТИНЫ ═══
Тебе передан **ОТЧЁТ ПРОВЕРКИ СТАТЕЙ** — это результат автоматической сверки каждой ссылки на статью из документа с реальной базой НПА КР через Pinecone.
ОТЧЁТ — ЕДИНСТВЕННЫЙ источник правовой истины. Других у тебя нет.

═══ КРИТИЧЕСКИЕ ЗАПРЕТЫ (нарушение = галлюцинация) ═══

1. ЗАПРЕЩЕНО упоминать номер статьи (например "ст. 137", "статья 25"), если эта статья НЕ ПРОЦИТИРОВАНА в ОТЧЁТЕ ПРОВЕРКИ.

   Альтернатива — общая формулировка:
     ❌ «согласно ст. 422 УК КР»
     ✅ «согласно действующим нормам УК КР о пытках»
     ✅ «согласно соответствующей статье УК КР»

2. ЕСЛИ в документе пользователя уже указаны номера статей — ЗАПРЕЩЕНО предлагать "правильные" альтернативы или утверждать о смене редакций БЕЗ явного подтверждения из ОТЧЁТА (пометки ⚠️ НОМЕР НЕ СОВПАЛ).
   Если сомневаешься — пиши: "Рекомендую сверить с cbd.minjust.gov.kg".

3. ЗАПРЕЩЕНО выдумывать статьи которых нет в ОТЧЁТЕ.

4. ЕСЛИ в ОТЧЁТЕ статья помечена ❌ (НЕ найдена) — НЕ строй на её основе анализ. Просто отметь что она не найдена в базе.

═══ ФОРМАТ АНАЛИЗА ═══

## Сверка ссылок на статьи
Для каждой статьи из ОТЧЁТА:

✅ **[ref]** — Найдена в базе. Формулировка корректна / отличается: цитата из RAG.
⚠️ **[ref]** — Номер не совпал. В базе с похожим смыслом: [ref-from-RAG]. Возможно устаревшая редакция или ошибка.
⚠️ **[ref]** — Найдена с низкой уверенностью. Требует ручной проверки.
❌ **[ref]** — НЕ найдена в правовой базе. Возможно ошибочный номер, опечатка или статья отсутствует в индексе.

## Юридическая оценка
- Соответствие документа законодательству КР (на основе verified-данных)
- Замечания по структуре и формулировкам
- Без выдуманных номеров — только общими фразами если статьи нет в ОТЧЁТЕ

## Рекомендации
- Конкретные шаги: что исправить, что добавить
- Если статьи нет в ОТЧЁТЕ — рекомендация сверить с cbd.minjust.gov.kg

═══ ДЛИНА ═══
Соразмерно объёму документа. Не раздувай. Конкретно по делу.
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

async function streamGeminiResponse(apiKey, systemPrompt, userPrompt, history, res) {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
        model: "gemini-flash-latest",
        systemInstruction: systemPrompt
    });
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
// РЕЖИМ THINKING (ОДИН АГЕНТ + РЕАЛЬНЫЙ СТРИМИНГ ЭТАПОВ)
// ============================================================
async function handleThinking(message, history, retrievalResult, res) {
    const cleanHistory = sanitizeHistory(history);
    const { core, context, all } = retrievalResult;
    
    const rawContext = formatContextWithHierarchy(core, context);
    
    // Retrieval-статусы (эмбеддинг, поиск, ранжирование) уже ушли к клиенту из adaptiveRetrieval
    
    console.log(`[THINKING] Consultant получил ⭐${core.length} + 📚${context.length} = ${all.length} статей | ключ #${currentKeyIndex}`);

    try {
        const consultantKey = getNextKey();
        const consultantPrompt =
            `Вопрос пользователя: "${message}"\n\n` +
            `Контекст — ${all.length} релевантных статей НПА КР (⭐ ${core.length} ключевых + 📚 ${context.length} вспомогательных):\n\n${rawContext}`;

        const isL4 = detectL4Request(message);
        if (isL4) console.log('[THINKING] 🛡️ L4-запрос активирован');

        let systemPrompt = BASE_CONSULTANT_PROMPT;
        if (isAcademicRequest(message)) systemPrompt += '\n\n' + ACADEMIC_PROMPT_ADDON;
        if (isL4) systemPrompt += '\n\n' + L4_WARNING_ADDON;

        // --- Этап 5: подготовка к генерации ---
        sendStatus(res, `Анализирую ${all.length} статей и проверяю коллизии норм...`, '⚖️');

        // --- Этап 6: начало генерации ---
        sendStatus(res, 'Формулирую юридический вердикт...', '✍️');
        
        await streamGeminiResponse(
            consultantKey,
            systemPrompt,
            consultantPrompt,
            cleanHistory,
            res
        );

        const sourcesArr = [...core, ...context].slice(0, 5);
        const sources = sourcesArr.map(m =>
            `${m.metadata.npa_title} — ${m.metadata.article_title}`
        );
        const metadata = sourcesArr.map(m => ({
            npa_title: m.metadata?.npa_title || '',
            article_title: m.metadata?.article_title || '',
            full_text: m.metadata?.full_text || ''
        }));
        res.write(`data: ${JSON.stringify({ sources, metadata })}\n\n`);

    } catch (err) {
        console.error('Consultant упал:', err.message);
        sendStatus(res, 'Переключаюсь на резервный канал...', '🔄');
        await delay(2000);
        try {
            const fallbackKey = getNextKey();
            const fallbackPrompt = `Релевантный контекст законов:\n${rawContext}\n\nВопрос пользователя: ${message}`;
            await streamGeminiResponse(fallbackKey, systemInstruction, fallbackPrompt, cleanHistory, res);
        } catch (fallbackErr) {
            console.error('Fallback тоже упал:', fallbackErr.message);
            res.write(`data: ${JSON.stringify({ text: '\n\n⚠️ Извините, серверы нейросети сейчас перегружены. Пожалуйста, подождите минуту и попробуйте снова.' })}\n\n`);
        }
    }
}

// ============================================================
// РЕЖИМ AGENT (IDE Document Editor — Cursor-style)
// ============================================================
// Принимает уже-собранный фронтом промпт (содержит документ + задачу),
// прибавляет лёгкий retrieval НПА для возможных цитат, и отдаёт ответ
// с системным промптом AGENT_SYSTEM_PROMPT (строгий JSON).
// История чата сохраняется — агент видит предыдущие правки.
// ============================================================
async function handleAgent(message, history, res, retryCount = 0, userQuery = null) {
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
// DOCUMENT-GROUNDED ANALYSIS — AGENTS PIPELINE
// ════════════════════════════════════════════════════════════════════

// ── 1. EXTRACTOR — извлекает все статьи из одного чанка документа ──
async function extractFromChunk(chunkText, apiKey) {
    const systemPrompt = 'Ты — юридический парсер. Извлекаешь ВСЕ ссылки на статьи законов из текста. Отвечаешь СТРОГО JSON без markdown без пояснений.';
    const userPrompt = `Найди все ссылки на статьи законов в документе.

Формат ответа (ровно такой JSON):
{
  "articles": [
    {
      "ref": "ст.137 УК КР",
      "lawName": "Уголовный кодекс КР",
      "articleNumber": "137",
      "context": "точная цитата из документа (до 150 символов)"
    }
  ]
}

Если статей нет — верни: {"articles": []}

Документ:
${chunkText}`;
    try {
        const result = await callOnce(apiKey, systemPrompt, userPrompt, 2);
        const cleaned = String(result || '').replace(/```json|```/g, '').trim();
        // Find first { ... last } — отрезаем потенциальный мусор вокруг
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

// Извлекает статьи из всего документа. Если документ >8K — chunked extraction
// параллельно через несколько ключей, затем дедуплицирует по ref.
async function extractArticlesFromDocument(documentText) {
    const ks = KEYS.length;
    const cfg = DOCUMENT_ANALYSIS_CONFIG;
    const extractorKey = KEYS[Math.min(cfg.extractorKeyIndex, ks - 1)];

    if (documentText.length <= 8000) {
        const articles = await extractFromChunk(documentText, extractorKey);
        return articles.slice(0, cfg.maxArticles);
    }

    // Chunked extraction
    const CHUNK = cfg.extractorChunkSize;
    const OVL = cfg.extractorChunkOverlap;
    const chunks = [];
    for (let i = 0; i < documentText.length; i += (CHUNK - OVL)) {
        chunks.push(documentText.slice(i, i + CHUNK));
        if (i + CHUNK >= documentText.length) break;
    }
    // Используем extractor + verification keys как пул
    const keysPool = [cfg.extractorKeyIndex, ...cfg.verificationKeys]
        .filter(idx => idx < ks)
        .map(idx => KEYS[idx]);
    if (keysPool.length === 0) keysPool.push(KEYS[0]);

    const results = await Promise.allSettled(
        chunks.map((chunk, i) => extractFromChunk(chunk, keysPool[i % keysPool.length]))
    );
    const all = results
        .filter(r => r.status === 'fulfilled' && Array.isArray(r.value))
        .flatMap(r => r.value);

    // Дедупликация по нормализованному ref
    const seen = new Set();
    const unique = [];
    for (const a of all) {
        const key = String(a.ref || '').toLowerCase().replace(/\s+/g, ' ').trim();
        if (!key) continue;
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(a);
        }
    }
    console.log(`[Extractor] chunks=${chunks.length} | raw=${all.length} | unique=${unique.length}`);
    return unique.slice(0, cfg.maxArticles);
}

// ── 2. VERIFIER — для группы статей делает RAG + сверку номера ──
async function verifyArticleGroup(articleGroup, apiKey) {
    const cfg = DOCUMENT_ANALYSIS_CONFIG;
    const out = [];
    for (const article of articleGroup) {
        try {
            // Embedding-запрос строим из lawName + context документа — это даёт
            // богатый вектор. Просто "ст.137 УК КР" даст слабый.
            const searchText = `${article.lawName || ''} ${article.context || article.ref || ''}`.trim();
            const ragResult = await searchPineconeByText(searchText, article.lawName, apiKey);

            const score = Number((ragResult && ragResult.score) || 0);
            const md = (ragResult && ragResult.metadata) || {};
            const ragText = md.full_text || null;
            const ragNpaTitle = md.npa_title || '';
            const ragArticleNum = extractArticleNumberFromMetadata(md);

            const numNorm = normalizeArticleNumber(article.articleNumber);
            const ragNumNorm = normalizeArticleNumber(ragArticleNum);
            const numberMatches = !!(numNorm && ragNumNorm && numNorm === ragNumNorm);

            // found: true если совпал номер при разумном score ИЛИ score очень высокий
            const found = ragResult !== null && (
                (numberMatches && score >= cfg.confidenceThresholds.low) ||
                score >= 0.85
            );
            const confidence = score >= cfg.confidenceThresholds.high ? 'high'
                             : score >= cfg.confidenceThresholds.medium ? 'medium'
                             : 'low';
            // mismatch — нашли похожую статью но с другим номером
            const mismatch = !!(ragArticleNum && !numberMatches && score >= cfg.confidenceThresholds.medium);

            out.push({
                ref: article.ref,
                lawName: article.lawName || '',
                articleNumber: article.articleNumber || '',
                context: article.context || '',
                ragText, ragNpaTitle,
                ragArticleNumber: ragArticleNum,
                score, found, numberMatches, mismatch, confidence
            });
        } catch (e) {
            console.error('[Verifier] err for', article.ref, ':', e.message);
            out.push({
                ref: article.ref,
                lawName: article.lawName || '',
                articleNumber: article.articleNumber || '',
                context: article.context || '',
                ragText: null, ragNpaTitle: '', ragArticleNumber: null,
                score: 0, found: false, numberMatches: false, mismatch: false, confidence: 'low',
                error: e.message
            });
        }
    }
    return out;
}

// Координатор — раскидывает статьи по верификационным ключам через Promise.allSettled
async function runParallelVerification(articles) {
    const ks = KEYS.length;
    const cfg = DOCUMENT_ANALYSIS_CONFIG;

    // Доступные ключи для verification: из конфига, но не выходящие за пределы KEYS
    let verifKeyIndexes = cfg.verificationKeys.filter(i => i < ks);
    if (verifKeyIndexes.length === 0) {
        // fallback: используем все доступные кроме extractor и synthesizer
        verifKeyIndexes = [];
        for (let i = 0; i < ks; i++) {
            if (i !== cfg.extractorKeyIndex && i !== Math.min(cfg.synthesizerKeyIndex, ks - 1)) {
                verifKeyIndexes.push(i);
            }
        }
        if (verifKeyIndexes.length === 0) verifKeyIndexes = [0]; // совсем мало ключей
    }

    const articlesPerAgent = getArticlesPerAgent(articles.length, verifKeyIndexes.length);
    const groups = [];
    for (let i = 0; i < articles.length; i += articlesPerAgent) {
        groups.push(articles.slice(i, i + articlesPerAgent));
    }

    console.log(`[DocAnalysis] ${articles.length} статей → ${groups.length} групп по ${articlesPerAgent} (verifKeys=${verifKeyIndexes.length}/${ks})`);

    const promises = groups.map((group, i) =>
        verifyArticleGroup(group, KEYS[verifKeyIndexes[i % verifKeyIndexes.length]])
    );
    const results = await Promise.allSettled(promises);
    return results
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => r.value);
}

// ── 3. CONFIDENCE — общая уверенность по всем verified статьям ──
function calculateOverallConfidence(verified) {
    if (!verified || verified.length === 0) {
        return { level: 'unknown', totalArticles: 0, foundArticles: 0, notFoundArticles: 0, lowConfArticles: 0, mismatchArticles: 0, avgScore: 0 };
    }
    const found = verified.filter(v => v.found);
    const notFound = verified.filter(v => !v.found);
    const lowConf = verified.filter(v => v.found && v.confidence === 'low');
    const mismatch = verified.filter(v => v.mismatch);
    const avgScore = found.length > 0
        ? found.reduce((s, v) => s + v.score, 0) / found.length
        : 0;

    let level;
    if (notFound.length > verified.length / 2) level = 'low';
    else if (mismatch.length > 0 || avgScore < 0.75 || lowConf.length > 0) level = 'medium';
    else if (avgScore >= 0.75) level = 'high';
    else level = 'medium';

    return {
        level,
        totalArticles: verified.length,
        foundArticles: found.length,
        notFoundArticles: notFound.length,
        lowConfArticles: lowConf.length,
        mismatchArticles: mismatch.length,
        avgScore: Number(avgScore.toFixed(3))
    };
}

// ── 4. SYNTHESIZER — финальный стриминговый анализ ──
async function synthesizeAnalysis(documentText, verifiedArticles, userQuery, res) {
    const ks = KEYS.length;
    const synthKey = KEYS[Math.min(DOCUMENT_ANALYSIS_CONFIG.synthesizerKeyIndex, ks - 1)];

    const reportLines = verifiedArticles.map(v => {
        if (v.found && !v.mismatch && v.confidence !== 'low') {
            return `✅ ${v.ref}\n` +
                   `   Score: ${v.score.toFixed(3)} (${v.confidence})\n` +
                   `   В документе: "${v.context}"\n` +
                   `   Найдено: ${v.ragNpaTitle}${v.ragArticleNumber ? ' — ст. ' + v.ragArticleNumber : ''}\n` +
                   `   Оригинал: "${(v.ragText || '').slice(0, 400)}..."`;
        }
        if (v.mismatch) {
            return `⚠️ ${v.ref} — НОМЕР НЕ СОВПАЛ\n` +
                   `   В документе указано: ст. ${v.articleNumber}\n` +
                   `   В базе с похожим смыслом: ${v.ragNpaTitle} — ст. ${v.ragArticleNumber}\n` +
                   `   Score: ${v.score.toFixed(3)}\n` +
                   `   Текст найденного: "${(v.ragText || '').slice(0, 300)}..."`;
        }
        if (v.found && v.confidence === 'low') {
            return `⚠️ ${v.ref} — низкая уверенность\n` +
                   `   Score: ${v.score.toFixed(3)}\n` +
                   `   Найдено: ${v.ragNpaTitle}${v.ragArticleNumber ? ' — ст. ' + v.ragArticleNumber : ''}\n` +
                   `   Требует ручной проверки`;
        }
        return `❌ ${v.ref} — НЕ найдена в правовой базе\n` +
               `   В документе: "${v.context}"`;
    }).join('\n\n---\n\n');

    const userPrompt = `═══ ОТЧЁТ ПРОВЕРКИ СТАТЕЙ (единственный источник истины) ═══

${reportLines}

═══ ЗАПРОС ПОЛЬЗОВАТЕЛЯ ═══
${userQuery || 'Проанализируй документ'}

═══ ДОКУМЕНТ ПОЛЬЗОВАТЕЛЯ ═══
${(documentText || '').slice(0, 15000)}

Проанализируй документ строго на основе ОТЧЁТА. Не упоминай номеров статей которых нет в ОТЧЁТЕ.`;

    try {
        await streamGeminiResponse(synthKey, DOCUMENT_ANALYSIS_PROMPT, userPrompt, [], res);
    } catch (err) {
        console.error('[Synthesizer] failed:', err.message);
        // Fallback: попробуем через round-robin ключ
        try {
            await streamGeminiResponse(getNextKey(), DOCUMENT_ANALYSIS_PROMPT, userPrompt, [], res);
        } catch (e2) {
            console.error('[Synthesizer] fallback failed:', e2.message);
            res.write(`data: ${JSON.stringify({ text: '\n\n⚠️ Ошибка генерации финального анализа. Попробуйте повторить.' })}\n\n`);
        }
    }
}

// ── 5. ORCHESTRATOR — собирает pipeline воедино ──
async function analyzeDocumentSmart(documentText, userQuery, res) {
    try {
        // Этап 1: Extractor
        sendStatus(res, '📄 Извлекаю статьи из документа...', '📄');
        const articles = await extractArticlesFromDocument(documentText);

        if (articles.length === 0) {
            // Деградируем в обычный agent flow
            sendStatus(res, 'ℹ️ Ссылок на статьи не найдено. Делаю обычный анализ...', 'ℹ️');
            const fallbackMsg = `Запрос пользователя: ${userQuery}\n\nДокумент:\n"""\n${(documentText || '').slice(0, 15000)}\n"""`;
            await handleAgent(fallbackMsg, [], res, 0, userQuery);
            return;
        }

        // Этап 2: Parallel verification
        sendStatus(res, `🔎 Найдено ${articles.length} статей. Сверяю с базой НПА параллельно...`, '🔎');
        const verifiedArticles = await runParallelVerification(articles);

        // Этап 3: Confidence + детали по каждой статье для UI
        const confidencePayload = calculateOverallConfidence(verifiedArticles);
        confidencePayload.articles = verifiedArticles.map(v => {
            let status, reason;
            if (v.found && !v.mismatch && v.confidence !== 'low') {
                status = 'ok';
                reason = v.ragNpaTitle
                    ? `Найдено: ${v.ragNpaTitle}${v.ragArticleNumber ? ' — ст. ' + v.ragArticleNumber : ''}`
                    : 'Подтверждено в базе НПА';
            } else if (v.mismatch) {
                status = 'mismatch';
                reason = `В документе: ст. ${v.articleNumber}. В базе с похожим смыслом: ${v.ragNpaTitle}${v.ragArticleNumber ? ' — ст. ' + v.ragArticleNumber : ''}`;
            } else if (v.found && v.confidence === 'low') {
                status = 'low';
                reason = `Найдено с низкой уверенностью (score ${v.score.toFixed(2)}). Требует ручной проверки.`;
            } else {
                status = 'not_found';
                reason = 'В правовой базе нет статьи с достаточным совпадением. Возможно: устаревшая редакция, опечатка, или статья отсутствует в индексе.';
            }
            return {
                ref: v.ref,
                status,
                reason,
                score: Number(v.score.toFixed(3)),
                articleNumber: v.articleNumber || '',
                lawName: v.lawName || '',
                ragNpaTitle: v.ragNpaTitle || '',
                ragArticleNumber: v.ragArticleNumber || '',
                context: v.context ? v.context.slice(0, 140) : '',
                ragText: v.ragText ? v.ragText.slice(0, 280) + (v.ragText.length > 280 ? '…' : '') : ''
            };
        });
        sendConfidence(res, confidencePayload);

        sendStatus(
            res,
            `✅ Проверено: ${confidencePayload.foundArticles}/${confidencePayload.totalArticles}. Формирую анализ...`,
            '✅'
        );

        // Источники для UI chip badges (берём те что нашлись)
        const sourcesArr = verifiedArticles.filter(v => v.found && v.ragNpaTitle).slice(0, 5);
        if (sourcesArr.length > 0) {
            const sources = sourcesArr.map(v =>
                `${v.ragNpaTitle}${v.ragArticleNumber ? ' — ст. ' + v.ragArticleNumber : ''}`
            );
            const metadata = sourcesArr.map(v => ({
                npa_title: v.ragNpaTitle,
                article_title: v.ragArticleNumber ? `Статья ${v.ragArticleNumber}` : '',
                full_text: v.ragText || ''
            }));
            res.write(`data: ${JSON.stringify({ sources, metadata })}\n\n`);
        }

        // Этап 4: Synthesizer
        await synthesizeAnalysis(documentText, verifiedArticles, userQuery, res);
    } catch (err) {
        console.error('[analyzeDocumentSmart] fatal:', err);
        res.write(`data: ${JSON.stringify({ text: '\n\n⚠️ Ошибка анализа документа: ' + (err && err.message || 'unknown') })}\n\n`);
    }
}

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
                // res передаётся в adaptiveRetrieval — чтобы шли статусы этапов
                const retrievalResult = await adaptiveRetrieval(message, 'thinking', res);
                await handleThinking(message, history, retrievalResult, res);
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
        if (!documentText || !documentText.trim()) {
            return res.status(400).json({ error: 'Empty documentText' });
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
