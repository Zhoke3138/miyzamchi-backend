require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const { GEMINI_API_KEY, PINECONE_API_KEY, PINECONE_HOST } = process.env;

// Проверка наличия ключей
if (!GEMINI_API_KEY || !PINECONE_API_KEY || !PINECONE_HOST) {
    console.error("❌ ОШИБКА: Не заданы ключи GEMINI_API_KEY, PINECONE_API_KEY или PINECONE_HOST.");
    process.exit(1);
}

// Убираем случайный слэш в конце ссылки Pinecone, если он есть
const cleanPineconeHost = PINECONE_HOST.replace(/\/$/, '');

// Инициализируем Gemini твоим рабочим ключом
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// 🛡️ ЖЕСТКАЯ НАСТРОЙКА ВЕКТОРОВ (Ровно 768 измерений под твою базу)
async function getEmbedding(text) {
    try {
        const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        const result = await embeddingModel.embedContent(text);
        return result.embedding.values;
    } catch (error) {
        console.error(`❌ Ошибка получения вектора:`, error.message);
        throw error;
    }
}

// 🔍 ФУНКЦИЯ ПОИСКА В PINECONE
async function searchPinecone(vector) {
    try {
        const response = await fetch(`${cleanPineconeHost}/query`, {
            method: 'POST',
            headers: {
                'Api-Key': PINECONE_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                vector: vector,
                topK: 3,
                includeMetadata: true
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Pinecone API error: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        return data.matches || [];
    } catch (error) {
        console.error("❌ Ошибка при запросе к Pinecone:", error.message);
        throw error;
    }
}

// 💬 ГЛАВНЫЙ РОУТ ЧАТА
app.post('/api/chat', async (req, res) => {
    try {
        const { message, history } = req.body;

        if (!message) {
            return res.status(400).json({ reply: "Пустое сообщение" });
        }

        console.log(`\n💬 Новый запрос: "${message}"`);

        let standaloneQuestion = message;
        // Используем твою любимую мощную модель для чата
        const chatModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        // Перефразирование вопроса с учетом истории (чтобы бот помнил контекст)
        if (history && history.length > 0) {
            const historyText = history.map(h => `${h.role === 'user' ? 'Пользователь' : 'Miyzamchi'}: ${h.text}`).join('\n');
            const standalonePrompt = `История диалога:\n${historyText}\n\nПоследний вопрос пользователя: "${message}"\nТвоя задача: превратить последний вопрос в полный юридический запрос, понятный без истории. Верни ТОЛЬКО перефразированный запрос.`;

            try {
                const rewriteResult = await chatModel.generateContent(standalonePrompt);
                const rewritten = rewriteResult.response.text().trim();
                if (rewritten && rewritten.length < 500) {
                    standaloneQuestion = rewritten;
                    console.log(`🤖 Перефразированный запрос: "${standaloneQuestion}"`);
                }
            } catch (err) {
                console.error("⚠️ Ошибка перефразирования, использую оригинальный вопрос.");
            }
        }

        // 1. Превращаем текст в вектор (768)
        const queryEmbedding = await getEmbedding(standaloneQuestion);

        // 2. Ищем статьи в Pinecone
        const matches = await searchPinecone(queryEmbedding);

        // 3. Формируем контекст для ИИ
        let contextText = "";
        if (matches && matches.length > 0) {
            const snippets = matches.map((match, index) => {
                const md = match.metadata || {};
                const codexName = md.doc_title || md.codex || md.Code || md.Title || "Неизвестный кодекс";
                const articleNum = md.article || md.Article || md.article_number || md.статья || "Без номера";
                const text = md.text || md.content || "[Текст отсутствует]";

                return `--- Источник ${index + 1} ---\nКодекс/Закон: ${codexName}\nСтатья: ${articleNum}\nТекст статьи:\n${text}`;
            });
            contextText = snippets.join("\n\n");
            console.log(`🔍 Найдено ${matches.length} статей в базе. Начинаю печать ответа (Streaming)...`);
        } else {
            console.log(`🔍 В Pinecone пусто. Отвечаю без базы...`);
        }

        // 4. Инструкция для ИИ-юриста
        const systemInstruction = `Ты — юридический ассистент "Мыйзамчи", эксперт по законодательству Кыргызской Республики.
ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА:
1. Если контекст предоставлен, отвечай СТРОГО опираясь на него.
2. В ответе ОБЯЗАТЕЛЬНО ссылайся на название кодекса и номер статьи из контекста.
3. Если контекста нет или он не подходит, честно скажи: "К сожалению, в моей базе знаний нет точного ответа на этот вопрос", и не выдумывай законы.
4. Отвечай вежливо и структурированно.`;

        const finalModel = genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
            systemInstruction: systemInstruction,
            generationConfig: { temperature: 0.3 }
        });

        const promptText = `Релевантный контекст из базы:\n${contextText || "Ничего не найдено."}\n\nВопрос пользователя: ${message}`;

        // Открываем потоковую передачу данных (Streaming)
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const result = await finalModel.generateContentStream(promptText);

        for await (const chunk of result.stream) {
            res.write(`data: ${JSON.stringify({ text: chunk.text() })}\n\n`);
        }

        // Закрываем соединение
        res.write(`data: [DONE]\n\n`);
        res.end();

    } catch (error) {
        console.error("❌ Глобальная ошибка обработки /api/chat:", error);
        if (!res.headersSent) {
            res.status(500).json({ reply: "Произошла ошибка сервера. Пожалуйста, попробуйте позже." });
        } else {
            res.write(`data: ${JSON.stringify({ text: "\n\n[Ошибка связи с сервером]" })}\n\n`);
            res.write(`data: [DONE]\n\n`);
            res.end();
        }
    }
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`✅ Сервер Miyzamchi запущен на порту ${PORT}`);
    console.log(`🤖 Чат-Модель: gemini-2.5-flash | Векторы: text-embedding-004 (768 измерений)`);
});