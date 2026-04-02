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
    console.error("❌ ОШИБКА: Не заданы ключи GEMINI_API_KEY, PINECONE_API_KEY или PINECONE_HOST.");
    process.exit(1);
}

const cleanPineconeHost = PINECONE_HOST.replace(/\/$/, '');
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Переменная для авто-найденной модели эмбеддингов
let AUTO_EMBEDDING_MODEL = "text-embedding-004"; 

// 🛡️ АВТО-ОПРЕДЕЛЕНИЕ МОДЕЛЕЙ (Сам найдет то, что работает)
async function discoverModels() {
    console.log("🔍 Подключаюсь к Google для поиска доступных моделей...");
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`);
        const data = await response.json();
        
        if (data.models) {
            // Ищем модели, которые поддерживают векторы (embedContent)
            const embedModels = data.models.filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('embedContent'));
            if (embedModels.length > 0) {
                // Берем самую новую доступную модель
                AUTO_EMBEDDING_MODEL = embedModels[embedModels.length - 1].name.replace('models/', '');
                console.log(`✅ Автоматически выбрана модель эмбеддингов: ${AUTO_EMBEDDING_MODEL}`);
            } else {
                console.warn("⚠️ Google не вернул модели эмбеддингов для этого ключа.");
            }
        } else if (data.error) {
            console.error("❌ Ошибка API Google при поиске моделей:", data.error.message);
        }
    } catch (error) {
        console.error("⚠️ Не удалось выполнить авто-поиск моделей:", error.message);
    }
}

async function getEmbedding(text) {
    try {
        const embeddingModel = genAI.getGenerativeModel({ model: AUTO_EMBEDDING_MODEL });
        const result = await embeddingModel.embedContent(text);
        return result.embedding.values;
    } catch (error) {
        console.error(`❌ Ошибка получения вектора (модель ${AUTO_EMBEDDING_MODEL}):`, error.message);
        throw error;
    }
}

async function searchPinecone(vector) {
    try {
        const response = await fetch(`${cleanPineconeHost}/query`, {
            method: 'POST',
            headers: {
                'Api-Key': PINECONE_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ vector, topK: 3, includeMetadata: true })
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
        if (!message) return res.status(400).json({ reply: "Пустое сообщение" });

        console.log(`\n💬 Новый запрос: "${message}"`);

        // 1. Формирование автономного запроса
        let standaloneQuestion = message;
        // 🔄 ОБНОВЛЕНО: Используем gemini-2.5-flash
        const chatModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        if (history && history.length > 0) {
            const historyText = history.map(h => `${h.role === 'user' ? 'Пользователь' : 'Miyzamchi'}: ${h.text}`).join('\n');
            const standalonePrompt = `История диалога:\n${historyText}\n\nПоследний вопрос: "${message}"\nСформируй полный юридический запрос из последнего вопроса без объяснений.`;
            try {
                const rewriteResult = await chatModel.generateContent(standalonePrompt);
                const rewritten = rewriteResult.response.text().trim();
                if (rewritten && rewritten.length < 500) {
                    standaloneQuestion = rewritten;
                    console.log(`🤖 Перефразированный запрос: "${standaloneQuestion}"`);
                }
            } catch (err) {
                console.error("⚠️ Ошибка перефразирования, использую оригинал.");
            }
        }

        // 2. Получение вектора
        const queryEmbedding = await getEmbedding(standaloneQuestion);

        // 3. Поиск в Pinecone
        const matches = await searchPinecone(queryEmbedding);

        let contextText = "";
        if (matches && matches.length > 0) {
            const snippets = matches.map((match, index) => {
                const md = match.metadata || {};
                const codexName = md.doc_title || md.codex || md.Code || md.Title || "Неизвестный источник";
                const articleNum = md.article || md.Article || md.article_number || md.статья || "";
                return `--- Источник ${index + 1} ---\nКодекс/Закон: ${codexName}\nСтатья: ${articleNum}\nТекст:\n${md.text || md.content || ""}`;
            });
            contextText = snippets.join("\n\n");
            console.log(`🔍 Найдено ${matches.length} статей. Начинаю Streaming...`);
        } else {
            console.log(`🔍 В базе ничего не найдено.`);
        }

        // 4. Генерация финального ответа
        const systemInstruction = `Ты — "Мыйзамчи", юридический ИИ-ассистент Кыргызской Республики.
ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА:
1. Отвечай СТРОГО опираясь на "Релевантный контекст" ниже.
2. Обязательно цитируй название кодекса и номер статьи из контекста.
3. Если контекста нет, честно ответь: "К сожалению, в моей текущей базе знаний нет ответа на этот вопрос". Не выдумывай законы.`;

        // 🔄 ОБНОВЛЕНО: Используем gemini-2.5-flash
        const finalModel = genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
            systemInstruction: systemInstruction,
            generationConfig: { temperature: 0.3 }
        });

        const promptText = `Релевантный контекст:\n${contextText || "В базе пусто."}\n\nВопрос: ${message}`;

        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const result = await finalModel.generateContentStream(promptText);

        for await (const chunk of result.stream) {
            res.write(`data: ${JSON.stringify({ text: chunk.text() })}\n\n`);
        }
        res.write(`data: [DONE]\n\n`);
        res.end();

    } catch (error) {
        console.error("❌ Глобальная ошибка обработки:", error);
        if (!res.headersSent) {
            res.status(500).json({ reply: "Произошла ошибка при обработке запроса." });
        } else {
            res.write(`data: ${JSON.stringify({ text: "\n\n[Ошибка связи]" })}\n\n`);
            res.write(`data: [DONE]\n\n`);
            res.end();
        }
    }
});

// Запускаем авто-поиск перед стартом сервера
discoverModels().then(() => {
    app.listen(PORT, () => {
        console.log(`✅ Сервер Miyzamchi запущен на порту ${PORT}`);
        console.log(`🤖 Чат-Модель: gemini-2.5-flash | Векторы: Автовыбор`);
    });
});
