require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const { GEMINI_API_KEY, PINECONE_API_KEY, PINECONE_HOST } = process.env;

// Превращаем строку с ключами из Render в массив
const KEYS = GEMINI_API_KEY ? GEMINI_API_KEY.split(',') : [];
let currentKeyIndex = 0;

if (KEYS.length === 0 || !PINECONE_API_KEY || !PINECONE_HOST) {
    console.error("❌ ОШИБКА: Проверь переменные окружения на Render!");
    process.exit(1);
}

const cleanPineconeHost = PINECONE_HOST.replace(/\/$/, '');

// 🛠️ Функция получения текущего активного ключа
function getActiveKey() {
    return KEYS[currentKeyIndex].trim();
}

// 🛡️ Функция вектора с умной ротацией ключей
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

        // Если лимит исчерпан (429) — пробуем следующий ключ
        if (response.status === 429 && retryCount < KEYS.length) {
            console.log(`🛑 Ключ №${currentKeyIndex + 1} исчерпан. Переключаюсь...`);
            currentKeyIndex = (currentKeyIndex + 1) % KEYS.length;
            return getEmbedding(text, retryCount + 1);
        }

        if (!response.ok) throw new Error(data.error?.message || "Ошибка API");
        return data.embedding.values.slice(0, 768);
    } catch (error) {
        console.error("❌ Ошибка вектора:", error.message);
        throw error;
    }
}

// 🔍 Поиск в Pinecone
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

app.post('/api/chat', async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) return res.status(400).json({ reply: "Пусто" });

        const queryEmbedding = await getEmbedding(message);
        const matches = await searchPinecone(queryEmbedding);

        let contextText = "";
        if (matches.length > 0) {
            contextText = matches.map((match, i) => {
                const md = match.metadata || {};
                return `[Источник: ${md.doc_title} | ${md.article_title}]\nТекст:\n${md.text}`;
            }).join("\n\n");
        }

        const systemInstruction = `Ты — "Мыйзамчи", юридический ИИ-ассистент Кыргызской Республики.
ПРАВИЛА:
1. Начинай ответ СТРОГО с фразы: "Согласно [Название статьи] [Название кодекса]...".
2. Используй только предоставленный контекст.
3. Если данных нет, скажи: "В моей базе нет точной информации по этому вопросу".`;

        const genAI = new GoogleGenerativeAI(getActiveKey());
        const chatModel = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash", 
            systemInstruction: systemInstruction 
        });

        const promptText = `Контекст:\n${contextText || "Нет данных."}\n\nВопрос: ${message}`;

        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const result = await chatModel.generateContentStream(promptText);

        for await (const chunk of result.stream) {
            res.write(`data: ${JSON.stringify({ text: chunk.text() })}\n\n`);
        }
        res.write(`data: [DONE]\n\n`);
        res.end();

    } catch (error) {
        console.error("❌ Ошибка чата:", error);
        res.status(500).end();
    }
});

app.listen(PORT, () => console.log(`🚀 Мыйзамчи в строю! Ротация ${KEYS.length} ключей активна.`));
