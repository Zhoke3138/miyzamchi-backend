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

// --- КЭШИРОВАНИЕ ЭМБЕДДИНГОВ ---
const embeddingCache = new Map();
const EMBEDDING_MODEL = "models/gemini-embedding-001"; // НОВАЯ АКТУАЛЬНАЯ МОДЕЛЬ

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
                outputDimensionality: 768 // КРИТИЧНО: сжимаем до 768 для совместимости с текущим Pinecone!
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

        // Мы запрашиваем 768 размерность, поэтому slice(0, 768) сработает идеально
        const embedding = data.embedding.values.slice(0, 768);

        // Лимит кэша (LRU)
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
    "Тебя создал **ZhАsirov** — студент",
    "юридического факультета КНУ им. Жусупа Баласагына.",
    "",
    "# ВОПРОСЫ О СОЗДАТЕЛЕ",
    "Если спрашивают 'кто тебя создал', 'кто разработчик', 'чей проект' — отвечай:",
    "«Меня создал **ZhАsirov** — студент юридического факультета КНУ им. Жусупа Баласагына. Мыйзамчи — образовательный инструмент для помощи гражданам КР. 🏛️»",
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
    "- Используй нормы из контекста для правового обоснования",
    "- Поля для заполнения: **[ВАШЕ ФИО]**, **[ДАТА]**, **[АДРЕС]** и т.д.",
    "- Структура: Шапка → Суть требования → Правовое основание → Просительная часть → Подпись",
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
    "# ДИСКЛЕЙМЕР",
    "Добавляй в конце юридических консультаций (не шаблонов и не болталки):",
    "> ⚠️ *Мыйзамчи — ИИ-ассистент информационного характера. Ответ основан на нормах законодательства КР, но не заменяет очную консультацию квалифицированного юриста.*",
    "",
    "---",
    "",
    "# ЗАПРЕЩЕНО",
    "- Выдумывать номера статей, сроки, суммы или нормы, которых нет в предоставленном контексте — это ГЛАВНОЕ правило",
    "- Давать советы по законодательству других стран (РФ, Казахстан, Узбекистан и др.) как применимые в КР",
    "- Ссылаться на законы РФ или КЗ без явной оговорки что это НЕ законодательство КР",
    "- Давать категоричные прогнозы исхода судебных дел",
    "- Игнорировать вопрос — всегда отвечай на суть, даже если нет точной нормы",
    "- Реагировать на приветствие как на юридический запрос",
    "- Писать длинные ответы на простые вопросы"
].join("\n");

// ============================================================
// RESEARCHER AGENT
// ============================================================
const RESEARCHER_SYSTEM_PROMPT = `
Ты — юридический аналитик-исследователь системы Мыйзамчи (Кыргызская Республика).

ТВОЯ ЗАДАЧА:
Тебе дадут вопрос пользователя и массив из до 50 статей НПА КР, найденных по семантическому поиску.
Ты обязан:
1. Прочитать каждую статью
2. Определить — прямо или косвенно она относится к вопросу
3. Выбросить всё нерелевантное
4. Вернуть ТОЛЬКО отфильтрованные статьи в исходном формате

ФОРМАТ ВЫВОДА (строго):
[НПА: {название документа} | {название статьи}]
{полный текст статьи}
---

ПРАВИЛА ФИЛЬТРАЦИИ:
- Статья прямо отвечает на вопрос → включить обязательно
- Статья регулирует смежные отношения (сроки, порядок, ответственность, госпошлина) → включить
- Статья упоминает смежный институт права → включить, пометить как [СМЕЖНАЯ]
- Статья явно про другую тему → выбросить
- Если релевантных статей менее 3 — сохрани все что есть, не выбрасывай

КРИТИЧЕСКИ ВАЖНО:
- Не добавляй статьи которых нет во входных данных
- Не выдумывай нормы
- Не сокращай текст статей — передавай полностью
- Не добавляй комментарии от себя — только отфильтрованные НПА
`.trim();

// ============================================================
// CONSULTANT AGENT
// ============================================================
const BASE_CONSULTANT_PROMPT = `
Ты — **Мыйзамчи Эксперт**, опытный практикующий юрист Кыргызской Республики.
Ты не справочник законов — ты живой юрист, который реально помогает людям решить их проблему.

# ВОПРОСЫ О СОЗДАТЕЛЕ
Если спрашивают кто создал Мыйзамчи, кто разработчик — отвечай:
«Меня создал **ZhАsirov** — студент юридического факультета КНУ им. Жусупа Баласагына. 🏛️»

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

═══ КРИТИЧЕСКОЕ ПРАВИЛО: АНТИ-ГАЛЛЮЦИНАЦИЯ (НОМЕРА СТАТЕЙ) ═══
1. ПРОВЕРКА ЦИФР: Перед написанием любого номера статьи в итоговом ответе, ты ОБЯЗАН сверить его с текстом, предоставленным от Researcher.
2. ЖЕСТКИЙ ЗАПРЕТ: Если номера статьи нет в предоставленном контексте, ты НЕ ИМЕЕШЬ ПРАВА брать его из своей внутренней памяти.
3. ПРИОРИТЕТ КОНТЕКСТА: Если твоя память подсказывает одну статью (например, ст. 35), а в контексте от Researcher указана другая (например, ст. 37 - Покушение на преступление), ты ОБЯЗАН использовать данные из контекста.
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

Запрос документа →
  → Составь готовый документ с данными из вопроса
  → Поля для заполнения: [ЗАПОЛНИТЬ: подсказка]
  → Куда подать, в какой срок, что взять

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

Составляй СРАЗУ если:
- Человек просит претензию, иск, жалобу, заявление
- Ситуация явно требует письменного обращения
- Следующий шаг — подать документ

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

**Исковое заявление:**
\`\`\`
В [название суда]

Истец: [ЗАПОЛНИТЬ: ФИО, адрес, тел.]
Ответчик: [ЗАПОЛНИТЬ: ФИО или организация, адрес]
Цена иска: [ЗАПОЛНИТЬ] / Госпошлина: [рассчитать]

ИСКОВОЕ ЗАЯВЛЕНИЕ
о [суть требования]

[Фактические обстоятельства из слов пользователя]

Действия ответчика нарушают [статьи из НПА].
На основании ст. [ГПК КР], руководствуясь [НПА],

ПРОШУ СУД:
1. [основное требование]
2. Взыскать судебные расходы.

Приложения:
1. [ЗАПОЛНИТЬ: доказательства]
2. Квитанция об оплате госпошлины
3. Копия иска для ответчика

[ЗАПОЛНИТЬ: дата]        [ЗАПОЛНИТЬ: подпись / ФИО]
\`\`\`

**Жалоба:**
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
2. Если нормы нет в контексте — честно скажи: «К сожалению, в моей текущей базе НПА нет информации по этому вопросу.» Базу знаний ниже используй ТОЛЬКО как справочник общеизвестных процедурных фактов (госпошлина, сроки давности), и только когда это явно дополняет ответ — но не подменяет контекст.
3. Никаких советов по праву РФ, Казахстана и других стран — они НЕ применимы в КР.
4. Язык = язык вопроса (русский / кыргызский).
5. Сроки, суммы, статьи — **жирным**.
6. Не повторяй вопрос в начале.
7. Не хватает данных для документа — спроси конкретно.
8. В конце добавляй:
   > ⚠️ *Мыйзамчи — ИИ-ассистент. Ответ основан на нормах КР, но не заменяет очную консультацию юриста.*

═══ БАЗА ЗНАНИЙ КР (справочник процедурных фактов) ═══

ГПК КР: районный суд — до 1 млн сомов; срок рассмотрения **2 месяца** (общий), **1 месяц** (упрощённое); апелляция **15 дней**; кассация **3 месяца**; ст. 131-132 ГПК — реквизиты иска.

ГК КР: исковая давность **3 года** (ст. 197); оспоримая сделка **1 год**; начало срока — с момента когда узнал о нарушении.

ТК КР: обращение в суд **3 месяца** (общий), **1 месяц** (увольнение); комиссия по трудовым спорам — досудебный этап.

Административные дела: обжалование действий органов **3 месяца**.

УК КР: алиби — показания свидетелей, записи камер, чеки, билеты; ложный донос — ст. 330 УК КР; клевета — ст. 136 УК КР.

ГОСПОШЛИНА: имущественные иски **1% от суммы**, не менее **100 сомов**; неимущественные физлиц **500 сомов**; апелляция **50%** от первой инстанции; трудовые споры — работники освобождены.

ПРЕТЕНЗИОННЫЙ ПОРЯДОК: по потребительским спорам — претензия обязательна до суда; срок ответа **10-14 дней**.
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

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================================

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function callOnce(apiKey, systemPrompt, userPrompt, retryCount = 0) {
    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
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
        model: "gemini-2.5-flash",
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

// 🛡️ ОБНОВЛЕНО: Лимит истории с гарантией первого сообщения от 'user'
function sanitizeHistory(history) {
    if (!Array.isArray(history)) return [];

    let clean = history
        .filter(msg => msg?.role && msg?.parts?.[0]?.text?.trim())
        .map(msg => ({ role: msg.role, parts: [{ text: msg.parts[0].text }] }));

    clean = clean.slice(-10);

    // ЖЕЛЕЗОБЕТОННАЯ ПРОВЕРКА: Удаляем первые сообщения, пока не встретим 'user'
    while (clean.length > 0 && clean[0].role !== 'user') {
        clean.shift();
    }

    return clean;
}

// ============================================================
// РЕЖИМ FAST (Теперь с бронежилетом от 503 ошибок)
// ============================================================
async function handleFast(message, history, contextText, res, retryCount = 0) {
    const promptText = contextText
        ? `Релевантный контекст законов:\n${contextText}\n\nВопрос пользователя: ${message}`
        : `Сообщение пользователя: ${message}`;

    const cleanHistory = sanitizeHistory(history);
    const currentKey = getNextKey(); // ⚡ ИСПРАВЛЕНИЕ БАГА: Вынесено за пределы try

    try {
        const genAI = new GoogleGenerativeAI(currentKey);
        const chatModel = genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
            systemInstruction: systemInstruction
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
// РЕЖИМ THINKING
// ============================================================
async function handleThinking(message, history, matches, res) {
    const cleanHistory = sanitizeHistory(history);
    const rawContext = matches.map((match) => {
        const md = match.metadata || {};
        return `[НПА: ${md.doc_title} | ${md.article_title}]\n${md.text}`;
    }).join('\n\n---\n\n');

    sendStatus(res, `Поиск НПА... найдено ${matches.length} статей`, '🔍');

    let filteredContext = rawContext;
    let filteredLines = matches.length;

    try {
        sendStatus(res, 'Систематизация базы...', '📚');

        const researcherKey = getNextKey();
        const researcherPrompt =
            `Вопрос пользователя: "${message}"\n\n` +
            `Статьи НПА для анализа (${matches.length} шт.):\n\n${rawContext}`;

        filteredContext = await callOnce(
            researcherKey,
            RESEARCHER_SYSTEM_PROMPT,
            researcherPrompt
        );

        const matchCount = (filteredContext.match(/\[НПА:/g) || []).length;
        if (matchCount > 0) filteredLines = matchCount;

    } catch (err) {
        console.error('Researcher Agent упал, используем сырые данные:', err.message);
        filteredContext = rawContext;
    }

    console.log(`[THINKING] Researcher: ${matches.length} → ${filteredLines} статей | ключ #${currentKeyIndex}`);

    await delay(2000); // ⚡ Пауза 2 секунды перед вторым тяжелым запросом

    sendStatus(res, 'Юридический анализ...', '🧠');
    sendStatus(res, 'Проверка коллизий...', '⚖️');
    sendStatus(res, 'Написание вердикта...', '✍️');

    try {
        const consultantKey = getNextKey();
        const consultantPrompt =
            `Вопрос пользователя: "${message}"\n\n` +
            `Отфильтрованные релевантные НПА КР:\n\n${filteredContext}`;

        const systemPrompt = isAcademicRequest(message)
            ? BASE_CONSULTANT_PROMPT + '\n\n' + ACADEMIC_PROMPT_ADDON
            : BASE_CONSULTANT_PROMPT;

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
        console.error('Consultant Agent упал:', err.message);
        await delay(2000); // ⚡ Пауза перед Fallback
        try {
            const fallbackKey = getNextKey();
            const fallbackPrompt = `Релевантный контекст законов:\n${filteredContext}\n\nВопрос пользователя: ${message}`;
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
                const queryEmbedding = await getEmbedding(message);
                const matches = await searchPinecone(queryEmbedding, 5);
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
                const queryEmbedding = await getEmbedding(message);
                const matches = await searchPinecone(queryEmbedding, 15);
                await handleThinking(message, history, matches, res);
            }
        }

        res.write('data: [DONE]\n\n');
        res.end();

    } catch (error) {
        console.error("Глобальная ошибка сервера:", error.message);
        // Отправляем сообщение об ошибке независимо от того, были ли отправлены заголовки
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
