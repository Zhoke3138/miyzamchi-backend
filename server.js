require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const { GEMINI_API_KEY, PINECONE_API_KEY, PINECONE_HOST } = process.env;

if (!GEMINI_API_KEY || !PINECONE_API_KEY || !PINECONE_HOST) {
    console.error("❌ ОШИБКА: Проверь переменные окружения на Render!");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const cleanPineconeHost = PINECONE_HOST.replace(/\/$/, '');

// 🛡️ ФУНКЦИЯ ПОЛУЧЕНИЯ ВЕКТОРА (прямой fetch, как в твоем seed.js)
async function getEmbedding(text) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: { parts: [{ text: text.substring(0, 8000) }] } })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || "Embedding error");
        return data.embedding.values.slice(0, 768);
    } catch (error) {
        console.error("❌ Ошибка вектора:", error.message);
        throw error;
    }
}

// 🔍 ФУНКЦИЯ ПОИСКА В PINECONE
async function searchPinecone(vector) {
    try {
        const response = await fetch(`${cleanPineconeHost}/query`, {
            method: 'POST',
            headers: { 'Api-Key': PINECONE_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ vector, topK: 15, includeMetadata: true }) // Берем 15 статей для точности
        });
        const data = await response.json();
        return data.matches || [];
    } catch (error) {
        console.error("❌ Ошибка Pinecone:", error.message);
        throw error;
    }
}

// 💬 ГЛАВНЫЙ ОБРАБОТЧИК ЧАТА
app.post('/api/chat', async (req, res) => {
    try {
        const { message, history } = req.body;
        if (!message) return res.status(400).json({ reply: "Пусто" });

        console.log(`\n💬 Запрос: "${message}"`);

        // 1. Вектор
        const queryEmbedding = await getEmbedding(message);

        // 2. Поиск в базе
        const matches = await searchPinecone(queryEmbedding);

        // 3. Формируем контекст (используем новые поля metadata)
        let contextText = "";
        if (matches.length > 0) {
            contextText = matches.map((match, i) => {
                const md = match.metadata || {};
                return `[Источник ${i+1}: ${md.doc_title} | ${md.article_title}]\nТекст:\n${md.text}`;
            }).join("\n\n");
        }

        // 4. Инструкция для ИИ
        const systemInstruction = `Ты — "Мыйзамчи", юридический ИИ-ассистент Кыргызской Республики.
ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА:
1. Твой ответ должен СТРОГО основываться на предоставленном контексте.
2. Всегда начинай ответ с фразы: "Согласно [Название статьи] [Название кодекса]...".
3. Если точного ответа в контексте нет, скажи: "В моей базе нет точной информации по этому вопросу".
4. Пиши грамотно и структурировано.`;

        const chatModel = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash", 
            systemInstruction: systemInstruction 
        });

        const promptText = `Контекст:\n${contextText || "Нет данных."}\n\nВопрос: ${message}`;

        // Настройка потокового ответа (SSE)
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
        console.error("❌ Глобальная ошибка:", error);
        res.status(500).end();
    }
});

app.listen(PORT, () => console.log(`🚀 Miyzamchi LIVE на порту ${PORT}`));
