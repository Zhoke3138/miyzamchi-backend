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
    console.error("❌ ОШИБКА: Не заданы ключи GEMINI_API_KEY, PINECONE_API_KEY или PINECONE_HOST в файле .env");
    process.exit(1);
}

// Инициализация Gemini SDK
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Вспомогательная функция для генерации вектора
async function getEmbedding(text) {
    try {
        const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        const result = await embeddingModel.embedContent(text);
        const vector = result.embedding.values;
        return vector;
    } catch (error) {
        console.error("❌ Ошибка при получении вектора (embedding):", error.message);
        throw error;
    }
}

// Вспомогательная функция поиска в Pinecone
async function searchPinecone(vector) {
    try {
        const response = await fetch(`${PINECONE_HOST}/query`, {
            method: 'POST',
            headers: {
                'Api-Key': PINECONE_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                vector,
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

app.post('/api/chat', async (req, res) => {
    try {
        const { message, history } = req.body;
        
        if (!message) {
            return res.status(400).json({ reply: "Пустое сообщение" });
        }

        console.log(`\n💬 Новый запрос: "${message}"`);

        // 1. Формирование автономного запроса, если есть история диалога
        let standaloneQuestion = message;
        const chatModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        if (history && history.length > 0) {
            const historyText = history.map(h => `${h.role === 'user' ? 'Пользователь' : 'Miyzamchi'}: ${h.text}`).join('\n');
            const standalonePrompt = `История диалога:\n${historyText}\n\nПоследний вопрос пользователя: "${message}"\nТвоя задача: превратить последний вопрос пользователя в полный юридический запрос, чтобы он был понятен сам по себе без истории. Верни ТОЛЬКО перефразированный запрос без объяснений.`;
            
            try {
                const rewriteResult = await chatModel.generateContent(standalonePrompt);
                const rewritten = rewriteResult.response.text().trim();
                if (rewritten && rewritten.length < 500) {
                    standaloneQuestion = rewritten;
                    console.log(`🤖 Перефразированный запрос: "${standaloneQuestion}"`);
                }
            } catch (err) {
                console.error("⚠️ Ошибка перефразирования вопроса, использую оригинал:", err.message);
            }
        }

        // 2. Получение вектора для запроса
        const queryEmbedding = await getEmbedding(standaloneQuestion);

        // 3. Поиск 3 релевантных статей в Pinecone
        const matches = await searchPinecone(queryEmbedding);

        let contextText = "";
        if (matches && matches.length > 0) {
            const snippets = matches.map((match, index) => {
                const md = match.metadata || {};
                const codexName = md.doc_title || md.codex || md.Code || md.Title || "Неизвестный кодекс/закон";
                const articleNum = md.article || md.Article || md.article_number || md.статья || "Не указана";
                const text = md.text || md.content || "[Текст отсутствует]";
                
                return `--- Источник ${index + 1} ---\nКодекс/Закон: ${codexName}\nСтатья: ${articleNum}\nТекст статьи:\n${text}`;
            });
            contextText = snippets.join("\n\n");
            console.log(`🔍 Найдено ${matches.length} статей в Pinecone. Начинаю потоковую генерацию ответа...`);
        } else {
            console.log(`🔍 В Pinecone не найдено релевантных статей. Начинаю потоковую генерацию пустого ответа...`);
        }

        // 4. Генерация потокового финального ответа (Stream) с использованием gemini-1.5-flash
        const systemInstruction = `Ты — юридический ассистент "Мыйзамчи", эксперт по законодательству Кыргызской Республики.

ТВОЯ ГЛАВНАЯ ЗАДАЧА:
Отвечать на вопрос пользователя строго опираясь на предоставленный тебе "Релевантный контекст из базы данных (Pinecone)".

ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА:
1. Если контекст предоставлен, ты ДОЛЖЕН ответить на основе этого контекста.
2. В своем ответе ты ОБЯЗАН ссылаться на название кодекса/закона и номер статьи, которые указаны в контексте (например: "Согласно статье 15 Гражданского кодекса КР...").
3. Если текущего контекста недостаточно для ответа или база не вернула результатов, ты ДОЛЖЕН честно сказать: "К сожалению, в моей текущей базе знаний нет прямого ответа на этот вопрос", и не выдумывать законы.
4. Отвечай вежливо, четким, структурированным и понятным юридическим языком.
5. Не указывай "Источник 1", "Источник 2" напрямую, интегрируй ссылки на статьи в текст своего ответа естественно.`;

        const finalModel = genAI.getGenerativeModel({
            model: "gemini-1.5-flash",
            systemInstruction: systemInstruction,
            generationConfig: { temperature: 0.3 }
        });

        const promptText = `Релевантный контекст из базы данных (Pinecone):\n${contextText ? contextText : "В базе ничего не найдено."}\n\nВопрос пользователя: ${message}`;

        // Настройка заголовков для Server-Sent Events (SSE)
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // Генерируем ответ в потоковом формате
        const result = await finalModel.generateContentStream(promptText);

        for await (const chunk of result.stream) {
            const chunkText = chunk.text();
            res.write(`data: ${JSON.stringify({ text: chunkText })}\n\n`);
        }
        
        // Сигнал об окончании потока
        res.write(`data: [DONE]\n\n`);
        res.end();

    } catch (error) {
        console.error("❌ Глобальная ошибка обработки /api/chat:", error);
        if (!res.headersSent) {
            res.status(500).json({ reply: "Произошла ошибка при обработке вашего запроса. Пожалуйста, попробуйте позже." });
        } else {
            res.end();
        }
    }
});

app.listen(PORT, () => {
    console.log(`✅ Сервер Miyzamchi запущен на порту ${PORT}`);
    console.log(`🤖 Модели: text-embedding-004 (векторы), gemini-1.5-flash (ответы - Потоковый режим SSE)`);
});