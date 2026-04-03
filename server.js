require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(cors());
app.use(express.json());

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

// --- МАРШРУТ ДЛЯ ПИНГА ---
app.get('/ping', (req, res) => {
    console.log('Пинг получен. Мыйзамчи бодрствует!');
    res.status(200).send('Бодрствую! ');
});

// --- ФУНКЦИЯ ПОЛУЧЕНИЯ ТЕКУЩЕГО КЛЮЧА ---
function getActiveKey() {
    return KEYS[currentKeyIndex];
}

// --- ОПРЕДЕЛЕНИЕ ТИПА СООБЩЕНИЯ ---
const GREETING_PATTERNS = [
    /^(салам|саламатсызбы|сал|привет|хай|здравствуй|здравствуйте|добрый день|добрый вечер|доброе утро|hi|hello|hey|ку)\b/i,
    /^(как дела|как ты|как жизнь|что делаешь|кандайсың|кандайсыз|жакшымысың|жакшымысыз)\b/i,
    /^(спасибо|рахмат|благодарю|thanks|thank you)\b/i,
    /^(пока|до свидания|кош бол|сау бол|bye|goodbye)\b/i,
    /^(кто ты|что ты|что такое мыйзамчи|ты кто|расскажи о себе)\b/i,
];

function isCasualMessage(message) {
    const trimmed = message.trim();
    if (trimmed.length <= 30) {
        return GREETING_PATTERNS.some(pattern => pattern.test(trimmed));
    }
    return false;
}

// --- ФУНКЦИЯ ВЕКТОРА С РОТАЦИЕЙ КЛЮЧЕЙ ---
async function getEmbedding(text, retryCount = 0) {
    const activeKey = getActiveKey();
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=' + activeKey;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: { parts: [{ text: text.substring(0, 8000) }] } })
        });

        const data = await response.json();

        if (response.status === 429 && retryCount < KEYS.length) {
            console.log('Ключ ' + (currentKeyIndex + 1) + ' исчерпан. Ротируем...');
            currentKeyIndex = (currentKeyIndex + 1) % KEYS.length;
            return getEmbedding(text, retryCount + 1);
        }

        if (!response.ok) throw new Error(data.error?.message || "Ошибка Embedding API");
        return data.embedding.values.slice(0, 768);
    } catch (error) {
        console.error("Ошибка вектора:", error.message);
        throw error;
    }
}

// --- ПОИСК В PINECONE ---
async function searchPinecone(vector) {
    try {
        const response = await fetch(cleanPineconeHost + '/query', {
            method: 'POST',
            headers: { 'Api-Key': PINECONE_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ vector, topK: 15, includeMetadata: true })
        });
        const data = await response.json();
        return data.matches || [];
    } catch (error) {
        console.error("Ошибка Pinecone:", error.message);
        throw error;
    }
}

// --- ГЛАВНЫЙ ОБРАБОТЧИК ЧАТА ---
app.post('/api/chat', async (req, res) => {
    try {
        const { message, history } = req.body;
        if (!message) return res.status(400).json({ reply: "Пусто" });

        console.log('\nЗапрос: "' + message + '"');

        // Определяем тип сообщения
        const casual = isCasualMessage(message);
        let contextText = "";

        if (casual) {
            console.log("Режим: приветствие — Pinecone пропущен");
        } else {
            const queryEmbedding = await getEmbedding(message);
            const matches = await searchPinecone(queryEmbedding);
            if (matches.length > 0) {
                contextText = matches.map(function(match, i) {
                    const md = match.metadata || {};
                    return '[Источник ' + (i+1) + ': ' + md.doc_title + ' | ' + md.article_title + ']\nТекст статьи:\n' + md.text;
                }).join("\n\n");
            }
        }

        // --- Системная инструкция ---
        const systemInstruction = [
            "# ИДЕНТИЧНОСТЬ",
            "Ты — **Мыйзамчи**, юридический ИИ-ассистент Кыргызской Республики. Твоя задача — помогать гражданам понимать законодательство КР просто, точно и практично.",
            "",
            "---",
            "",
            "# ИСТОЧНИКИ ЗНАНИЙ (строгий приоритет)",
            "1. **Приоритет 1 — Контекст (НПА):** Всегда опирайся на предоставленный контекст (нормы закона). Это основа ответа.",
            "2. **Приоритет 2 — Твои знания:** Используй только для структуры документов, объяснения терминов и общей юридической логики — но никогда не подменяй ими нормы закона.",
            "3. **Если нет контекста:** Честно ответь: \"В моей базе знаний нет точной нормы по этому вопросу. Рекомендую обратиться к юристу или на сайт cbd.minjust.gov.kg.\"",
            "",
            "---",
            "",
            "# РЕЖИМЫ ОТВЕТА",
            "",
            "## Режим 0 — Приветствие и болталка",
            "- Если пользователь просто поздоровался, поблагодарил, попрощался или написал что-то неюридическое — отвечай тепло и естественно.",
            "- Не начинай с юридики. Просто поздоровайся и предложи помощь.",
            "- Пример: на \"Салам!\" → \"Салам! Кандай жардам бере алам? 😊\" или \"Привет! Чем могу помочь?\"",
            "- На \"кто ты?\" → кратко представься и объясни чем помогаешь.",
            "- Учитывай историю разговора: если ранее был юридический вопрос, можешь ссылаться на него.",
            "",
            "## Режим 1 — Юридическая консультация",
            "- Начинай с: \"Согласно [статья] [название акта]...\"",
            "- Кратко цитируй или пересказывай норму",
            "- Объясняй практический смысл простыми словами",
            "- Указывай сроки **жирным** (например: **30 дней**, **3 года**)",
            "- Если норм несколько — перечисляй по порядку применения",
            "- **Учитывай историю разговора:** если пользователь говорит \"а какое наказание?\" или \"расскажи подробнее\" — понимай контекст из предыдущих сообщений.",
            "",
            "## Режим 2 — Объяснение термина / статьи",
            "- Объясняй как будто человек слышит это впервые",
            "- Приводи 1 конкретный бытовой пример",
            "- Избегай юридического жаргона без расшифровки",
            "",
            "## Режим 3 — Составление документа",
            "- Используй нормы из контекста для правового обоснования",
            "- Используй свои знания для структуры документа",
            "- Поля для заполнения: **[ВАШЕ ФИО]**, **[ДАТА]**, **[АДРЕС]** и т.д.",
            "- Структура: Шапка → Суть требования → Правовое основание → Просительная часть → Подпись",
            "",
            "## Режим 4 — Вопрос вне компетенции",
            "- Если вопрос не касается законодательства КР и не является простым общением: \"Этот вопрос выходит за рамки моей специализации. Я работаю только с законодательством Кыргызской Республики.\"",
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
            "# ФОРМАТИРОВАНИЕ",
            "- Используй Markdown: заголовки (##), списки (- или 1.), **жирный** для ключевых норм и сроков",
            "- Длина ответа — пропорциональна сложности вопроса: простой вопрос = краткий ответ",
            "- Не повторяй вопрос пользователя в начале ответа",
            "",
            "---",
            "",
            "# ДИСКЛЕЙМЕР",
            "Добавляй в конце юридических консультаций (не шаблонов и не болталки):",
            "> ⚠️ *Мыйзамчи — ИИ-ассистент информационного характера. Ответ основан на нормах законодательства КР, но не заменяет очную консультацию квалифицированного юриста. В сложных делах обращайтесь к специалисту.*",
            "",
            "---",
            "",
            "# ЗАПРЕЩЕНО",
            "- Давать советы по законодательству других стран как применимые в КР",
            "- Выдумывать номера статей или нормы, которых нет в контексте",
            "- Давать категоричные прогнозы исхода судебных дел",
            "- Игнорировать вопрос — всегда отвечай на суть, даже если нет точной нормы",
            "- Реагировать на приветствие как на юридический запрос"
        ].join("\n");

        // Формируем текущий промпт
        const promptText = casual
            ? 'Сообщение пользователя: ' + message
            : 'Релевантный контекст законов:\n' + (contextText || "Данные не найдены.") + '\n\nВопрос пользователя: ' + message;

        // Очищаем историю — Gemini требует строго чередующиеся роли user/model без пустых parts
        const cleanHistory = Array.isArray(history)
            ? history
                .filter(function(msg) {
                    return msg && msg.role && msg.parts && msg.parts[0] && msg.parts[0].text && msg.parts[0].text.trim();
                })
                .map(function(msg) {
                    return { role: msg.role, parts: [{ text: msg.parts[0].text }] };
                })
            : [];

        console.log('История: ' + cleanHistory.length + ' сообщений');

        const genAI = new GoogleGenerativeAI(getActiveKey());
        const chatModel = genAI.getGenerativeModel({
            model: "gemini-3-flash",
            systemInstruction: systemInstruction
        });

        // Запускаем чат с историей
        const chat = chatModel.startChat({ history: cleanHistory });

        // Streaming
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const result = await chat.sendMessageStream(promptText);

        for await (const chunk of result.stream) {
            const chunkText = chunk.text();
            res.write('data: ' + JSON.stringify({ text: chunkText }) + '\n\n');
        }

        res.write('data: [DONE]\n\n');
        res.end();

    } catch (error) {
        console.error("Глобальная ошибка сервера:", error);
        res.status(500).end();
    }
});

// --- ЗАПУСК СЕРВЕРА ---
app.listen(PORT, () => {
    console.log('\n==========================================');
    console.log('Мыйзамчи запущен на порту ' + PORT);
    console.log('Загружено ключей Gemini: ' + KEYS.length);
    console.log('Адрес базы: ' + cleanPineconeHost);
    console.log('==========================================\n');
});

// --- САМО-ПИНАТЕЛЬ (Чтобы Render не засыпал) ---
const APP_URL = "https://miyzamchi.onrender.com/ping";

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
