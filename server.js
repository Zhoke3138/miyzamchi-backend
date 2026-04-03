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

// Превращаем строку с ключами в массив
const KEYS = GEMINI_API_KEY ? GEMINI_API_KEY.split(',').map(k => k.trim()) : [];
let currentKeyIndex = 0;

if (KEYS.length === 0 || !PINECONE_API_KEY || !PINECONE_HOST) {
    console.error("❌ ОШИБКА: Проверь переменные GEMINI_API_KEY, PINECONE_API_KEY и PINECONE_HOST на Render!");
    process.exit(1);
}

const cleanPineconeHost = PINECONE_HOST.replace(/\/$/, '');

// --- 🎯 МАРШРУТ ДЛЯ ПИНГА (Для cron-job.org и само-проверки) ---
app.get('/ping', (req, res) => {
    console.log('📡 Пинг получен. Мыйзамчи бодрствует!');
    res.status(200).send('Бодрствую! ⚖️');
});

// --- 🛡️ ФУНКЦИЯ ПОЛУЧЕНИЯ ТЕКУЩЕГО КЛЮЧА ---
function getActiveKey() {
    return KEYS[currentKeyIndex];
}

// --- 🧠 ФУНКЦИЯ ВЕКТОРА С РОТАЦИЕЙ КЛЮЧЕЙ ---
async function getEmbedding(text, retryCount = 0) {
    const activeKey = getActiveKey();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${activeKey}`;
    
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: { parts: [{ text: text.substring(0, 8000) }] } })
        });
        
        const data = await response.json();

        // Если лимит исчерпан (429) — переключаем ключ
        if (response.status === 429 && retryCount < KEYS.length) {
            console.log(`🛑 Ключ №${currentKeyIndex + 1} исчерпан. Ротируем...`);
            currentKeyIndex = (currentKeyIndex + 1) % KEYS.length;
            return getEmbedding(text, retryCount + 1);
        }

        if (!response.ok) throw new Error(data.error?.message || "Ошибка Embedding API");
        return data.embedding.values.slice(0, 768);
    } catch (error) {
        console.error("❌ Ошибка вектора:", error.message);
        throw error;
    }
}

// --- 🔍 ПОИСК В PINECONE ---
async function searchPinecone(vector) {
    try {
        const response = await fetch(`${cleanPineconeHost}/query`, {
            method: 'POST',
            headers: { 'Api-Key': PINECONE_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ vector, topK: 15, includeMetadata: true })
        });
        const data = await response.json();
        return data.matches || [];
    } catch (error) {
        console.error("❌ Ошибка Pinecone:", error.message);
        throw error;
    }
}

// --- 💬 ГЛАВНЫЙ ОБРАБОТЧИК ЧАТА ---
app.post('/api/chat', async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) return res.status(400).json({ reply: "Пусто" });

        console.log(`\n💬 Запрос от пользователя: "${message}"`);

        // 1. Получаем вектор
        const queryEmbedding = await getEmbedding(message);

        // 2. Ищем в базе
        const matches = await searchPinecone(queryEmbedding);

        // 3. Собираем контекст из найденных статей
        let contextText = "";
        if (matches.length > 0) {
            contextText = matches.map((match, i) => {
                const md = match.metadata || {};
                return `[Источник ${i+1}: ${md.doc_title} | ${md.article_title}]\nТекст статьи:\n${md.text}`;
            }).join("\n\n");
        }

        // 4. Настраиваем системную инструкцию "Мыйзамчи"
        const systemInstruction = `Ты — "Мыйзамчи", юридический ИИ-ассистент Кыргызской Республики.
ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА:
1. Твой ответ должен СТРОГО основываться на предоставленном контексте (законах).
2. Всегда начинай ответ с фразы: "Согласно [Название статьи] [Название кодекса/закона]...".
3. Если в контексте нет нужной информации, честно ответь: "В моей базе знаний нет точной информации по этому вопросу".
4. Постарайся сам понять суть вопроса и ответить исходя из этого кратко или длинно, в конечном итоге вежливо ответь на сам вопрос или же на суть вопроса.
5. в вопросах где просят объяснить какую либо тему, термин статью и т.д. объясни это прорстыми словами что человек понял суть.
6. когда просят составить шаблон какого либо документа (заявление, претензия, иск и т.д.) использую предоставленный контекст (законах) для обоснования дела, и использую свои знания для построения структуры документа.
7. Отвечай вежливо, структурировано и профессионально.`;

        const genAI = new GoogleGenerativeAI(getActiveKey());
        const chatModel = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash", 
            systemInstruction: systemInstruction 
        });

        const promptText = `Релевантный контекст законов:\n${contextText || "Данные не найдены."}\n\nВопрос пользователя: ${message}`;

        // Настройка потоковой передачи (Streaming)
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const result = await chatModel.generateContentStream(promptText);

        for await (const chunk of result.stream) {
            const chunkText = chunk.text();
            res.write(`data: ${JSON.stringify({ text: chunkText })}\n\n`);
        }

        res.write(`data: [DONE]\n\n`);
        res.end();

    } catch (error) {
        console.error("❌ Глобальная ошибка сервера:", error);
        res.status(500).end();
    }
});

// --- 🚀 ЗАПУСК СЕРВЕРА ---
app.listen(PORT, () => {
    console.log(`\n==========================================`);
    console.log(`🚀 Мыйзамчи запущен на порту ${PORT}`);
    console.log(`🔑 Загружено ключей Gemini: ${KEYS.length}`);
    console.log(`📡 Адрес базы: ${cleanPineconeHost}`);
    console.log(`==========================================\n`);
});

// --- ⏰ САМО-ПИНАТЕЛЬ (Чтобы Render не засыпал) ---
// ВАЖНО: Замени ссылку ниже на РЕАЛЬНУЮ ссылку твоего приложения на Render!
const APP_URL = "https://miyzamchi.onrender.com/ping"; 

setInterval(async () => {
    try {
        const response = await fetch(APP_URL);
        if (response.ok) {
            console.log('⏰ Само-пинг: Сервер бодрствует.');
        }
    } catch (e) {
        console.error('⏰ Ошибка само-пинга:', e.message);
    }
}, 14 * 60 * 1000); // Каждые 14 минут
