require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.set('trust proxy', 1); // Доверие к прокси Render

// --- HELMET (безопасность HTTP-заголовков) ---
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false
}));

// --- CORS (Открыт временно, пока нет финального домена) ---
app.use(cors());

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ limit: '2mb', extended: true }));

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

function blockKey(key) {
    blockedKeys.set(key, Date.now() + 60_000);
    console.log(`🔒 Ключ заблокирован на 60с (всего заблок: ${blockedKeys.size})`);
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
async function getEmbedding(text, retryCount = 0) {
    const cacheKey = text.substring(0, 8000);
    if (embeddingCache.has(cacheKey)) {
        console.log('📦 Эмбеддинг из кэша');
        serverStats.cacheHits++;
        return embeddingCache.get(cacheKey);
    }

    const activeKey = getActiveKey();

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

// --- АДАПТИВНЫЙ RETRIEVAL ---
async function adaptiveRetrieval(query, mode) {
    const maxK = mode === 'thinking' ? 25 : 10;
    const scoreMultiplier = mode === 'thinking' ? 0.65 : 0.70;
    const minK = 3;
    
    const embedding = await getEmbedding(query);
    const matches = await searchPinecone(embedding, maxK);
    
    if (matches.length === 0) return [];
    
    const topScore = matches[0].score || 0;
    const threshold = Math.max(0.5, topScore * scoreMultiplier);
    
    let filtered = matches.filter(m => (m.score || 0) >= threshold);
    if (filtered.length < minK) {
        filtered = matches.slice(0, minK);
    }
    
    console.log(
        `[Retrieval] ${mode} | query: ${query.length} chars | ` +
        `topScore: ${topScore.toFixed(3)} | threshold: ${threshold.toFixed(3)} | ` +
        `returned: ${filtered.length}/${matches.length}`
    );
    
    return filtered;
}

function sendStatus(res, text, icon) {
    res.write(`data: ${JSON.stringify({ protocolStatus: text, icon })}\n\n`);
}

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
    "2. **Приоритет 2 — Твои знания:** Используй ТОЛЬКО для структуры документов, объяснения терминов простым языком и общей юридической логики. НИКОГДА не подменяй ими нормы закона и не дополняй контекст выдуманными статьями.",
    "3. **Если в контексте нет ответа:** Ты ОБЯЗАН прямо сказать: «К сожалению, в моей текущей базе НПА нет информации по этому вопросу. Рекомендую обратиться к юристу или на сайт cbd.minjust.gov.kg.» Не пытайся ответить из общих знаний.",
    "4. **КАТЕГОРИЧЕСКИЙ ЗАПРЕТ НА ГАЛЛЮЦИНАЦИИ:** Тебе ЗАПРЕЩЕНО выдумывать номера статей, сроки, суммы или нормы, которых нет в предоставленном контексте. Не используй общие знания о праве, если они не подтверждены контекстом.",
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
Тебе передают массив статей НПА КР из семантического поиска (от 3 до 25 статей).
ТВОЯ ОБЯЗАННОСТЬ:
1. Прочитай ВСЕ переданные статьи внимательно
2. Определи, какие из них прямо отвечают на вопрос, какие — регулируют смежные отношения, какие — не по теме
3. Используй ТОЛЬКО релевантные статьи в ответе
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
Конкретные статьи НПА КР. Формат: «Согласно ст. X [Акт КР]...»
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
1. Опирайся ИСКЛЮЧИТЕЛЬНО на НПА из предоставленного контекста. Не выдумывай статьи, сроки, суммы.
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

// ============================================================
// РЕЖИМ FAST
// ============================================================
async function handleFast(message, history, contextText, res, retryCount = 0) {
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

        await new Promise(r => setTimeout(r, 1500));
        console.log(`[FAST MODE] Делаю повторную попытку...`);
        return handleFast(message, history, contextText, res, retryCount + 1);
    }
}

// ============================================================
// РЕЖИМ THINKING (ОДИН АГЕНТ + АДАПТИВНЫЙ TOPK)
// ============================================================
async function handleThinking(message, history, matches, res) {
    const cleanHistory = sanitizeHistory(history);
    
    // Контекст НПА передаём Consultant напрямую — без Researcher-фильтрации
    const rawContext = matches.map((match) => {
        const md = match.metadata || {};
        return `[НПА: ${md.doc_title} | ${md.article_title}]\n${md.text}`;
    }).join('\n\n---\n\n');

    sendStatus(res, `Анализирую ${matches.length} статей НПА...`, '🔍');
    sendStatus(res, 'Систематизирую нормы и проверяю коллизии...', '⚖️');
    sendStatus(res, 'Формулирую юридический вердикт...', '✍️');

    console.log(`[THINKING] Consultant получил ${matches.length} статей (адаптивный topK) | ключ ротации #${currentKeyIndex}`);

    try {
        const consultantKey = getNextKey();
        const consultantPrompt =
            `Вопрос пользователя: "${message}"\n\n` +
            `Контекст — ${matches.length} релевантных статей НПА КР из семантического поиска:\n\n${rawContext}`;

        const isL4 = detectL4Request(message);
        if (isL4) console.log('[THINKING] 🛡️ L4-запрос (судебный документ) — активирован режим отказа от генерации');

        let systemPrompt = BASE_CONSULTANT_PROMPT;
        if (isAcademicRequest(message)) systemPrompt += '\n\n' + ACADEMIC_PROMPT_ADDON;
        if (isL4) systemPrompt += '\n\n' + L4_WARNING_ADDON;

        await streamGeminiResponse(
            consultantKey,
            systemPrompt,
            consultantPrompt,
            cleanHistory,
            res
        );

        const sources = matches.slice(0, 5).map(m =>
            `${m.metadata.doc_title} — ${m.metadata.article_title}`
        );
        res.write(`data: ${JSON.stringify({ sources })}\n\n`);

    } catch (err) {
        console.error('Consultant упал:', err.message);
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
// ГЛАВНЫЙ МАРШРУТ
// ============================================================
app.post('/api/chat', async (req, res) => {
    serverStats.totalRequests++;
    try {
        const { message, history, mode = 'fast' } = req.body;
        if (!message) return res.status(400).json({ reply: "Пусто" });

        console.log(`\nЗапрос: "${message}" | Режим: ${mode}`);

        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        if (mode === 'fast') {
            const casual = isCasualMessage(message);
            let contextText = '';

            if (casual) {
                console.log("Режим: приветствие — Pinecone пропущен");
            } else {
                const matches = await adaptiveRetrieval(message, 'fast');
                if (matches.length > 0) {
                    contextText = matches.map((match, i) => {
                        const md = match.metadata || {};
                        return `[Источник ${i + 1}: ${md.doc_title} | ${md.article_title}]\nТекст статьи:\n${md.text}`;
                    }).join('\n\n');
                }
            }
            await handleFast(message, history, contextText, res);
        }
        else if (mode === 'thinking') {
            const casual = isCasualMessage(message);
            if (casual) {
                console.log("Режим: приветствие — Pinecone пропущен (Thinking)");
                await handleFast(message, history, '', res);
            } else {
                const matches = await adaptiveRetrieval(message, 'thinking');
                await handleThinking(message, history, matches, res);
            }
        }

        res.write('data: [DONE]\n\n');
        res.end();

    } catch (error) {
        console.error("Глобальная ошибка сервера:", error.message);
        res.write(`data: ${JSON.stringify({ text: '\n\n⚠️ Произошла системная ошибка (серверы нейросети недоступны). Пожалуйста, повторите запрос.' })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
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
});

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
