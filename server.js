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

// 🛡️ ЖЕСТКО ЗАДАЕМ МОДЕЛЬ НА 768 ИЗМЕРЕНИЙ
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

        let standaloneQuestion = message;
        // Используем твою любимую версию 2.5 для ответов
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

        // 1. Вектор (теперь ровно 768!)
        const queryEmbedding = await getEmbedding(standaloneQuestion);

        // 2. Поиск в Pinecone
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

        // 3. Ответ с SSE (Стриминг)
        const systemInstruction = `Ты — "Мыйзамчи", юридический ИИ-ассистент Кыргызской Республики.
ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА:
1. Отвечай СТРОГО опираясь на "Релевантный контекст" ниже.
2. Обязательно цитируй название кодекса и номер статьи из контекста.
3. Если контекста нет, честно ответь: "К сожалению, в моей текущей базе знаний нет ответа на этот вопрос". Не выдумывай законы.`;

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

app.listen(PORT, () => {
    console.log(`✅ Сервер Miyzamchi запущен на порту ${PORT}`);
    console.log(`🤖 Чат-Модель: gemini-2.5-flash | Векторы: text-embedding-004 (768)`);
});
