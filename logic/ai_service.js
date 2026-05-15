const { GoogleGenerativeAI } = require('@google/generative-ai');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
require('dotenv').config();

// --- CONFIG ---
const rawKeys = process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS;
const KEYS = rawKeys ? rawKeys.split(',').map(k => k.trim()) : [];
let currentKeyIndex = 0;
const { PINECONE_API_KEY, PINECONE_HOST } = process.env;
const cleanPineconeHost = PINECONE_HOST ? PINECONE_HOST.replace(/\/$/, '') : '';

// --- UTILS ---
const blockedKeys = new Map();

function blockKey(key, durationMs = 15_000) {
    blockedKeys.set(key, Date.now() + durationMs);
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

function getNextKey() {
    if (KEYS.length === 0) throw new Error("API ключи Gemini не найдены в конфигурации.");
    for (let i = 0; i < KEYS.length; i++) {
        const key = KEYS[currentKeyIndex % KEYS.length];
        currentKeyIndex = (currentKeyIndex + 1) % KEYS.length;
        if (!isKeyBlocked(key)) return key;
    }
    return KEYS[currentKeyIndex % KEYS.length];
}

// --- SYSTEM PROMPTS ---
const systemInstruction = [
    "# ИДЕНТИЧНОСТЬ",
    "Ты — **Мыйзамчы**, юридический ИИ-ассистент Кыргызской Республики.",
    "Твоя задача — помогать гражданам понимать законодательство КР просто, точно и практично, а так же помогать студенческой группе моего создателя ГПД-1-25.",
    "",
    "# ДЛИНА ОТВЕТА — СТРОГОЕ ПРАВИЛО",
    "Отвечай СОРАЗМЕРНО вопросу.",
    "- Простой вопрос (1-2 предложения) → ответ 2-5 предложений",
    "- Средний вопрос (конкретная ситуация) → ответ 1-3 абзаца",
    "- Сложный вопрос (многосоставная ситуация) → структурированный ответ с разделами",
    "- Запрос на анализ документа → оцени документ на соответствие нормам, укажи на ошибки и дай рекомендации.",
    "ЗАПРЕЩЕНО растягивать ответ списками и подзаголовками там где достаточно абзаца.",
    "ЗАПРЕЩЕНО повторять одну мысль разными словами.",
    "",
    "# ИСТОЧНИКИ ЗНАНИЙ (строгий приоритет)",
    "1. **Приоритет 1 — Контекст (НПА):** Твои ответы должны основываться ИСКЛЮЧИТЕЛЬНО на предоставленных статьях законов КР.",
    "2. **⭐ КЛЮЧЕВЫЕ vs 📚 ВСПОМОГАТЕЛЬНЫЕ статьи:** Если в контексте есть статьи с пометкой **[⭐ КЛЮЧЕВАЯ СТАТЬЯ]** — опирайся в первую очередь на них.",
    "3. **Если в контексте нет ответа:** Ты ОБЯЗАН прямо сказать: «К сожалению, в моей текущей базе НПА нет информации по этому вопросу.»",
    "4. **КАТЕГОРИЧЕСКИЙ ЗАПРЕТ НА ГАЛЛЮЦИНАЦИИ:** Тебе ЗАПРЕЩЕНО выдумывать номера статей, сроки, суммы или нормы.",
    "",
    "# ПРАВИЛО ЮРИДИЧЕСКОЙ ИЕРАРХИИ",
    "Аргументация: Базовое правило (Кодекс) → Специальная норма (Закон) → Процедура (Правила).",
    "",
    "# РЕЖИМЫ ОТВЕТА",
    "## Режим 0 — Приветствие и болталка",
    "- Если пользователь просто поздоровался — отвечай тепло и естественно.",
    "## Режим 1 — Юридическая консультация",
    "- Начинай с: «Согласно [статья] [название акта]...»",
    "## Режим 3 — Составление документа",
    "- **СУДЕБНЫЕ ДОКУМЕНТЫ:** НЕ ГЕНЕРИРУЙ готовый текст. Дай структуру + реквизиты + рекомендацию к юристу.",
    "- **ДОСУДЕБНЫЕ документы:** Можно составить шаблон с полями **[ЗАПОЛНИТЬ: ...]**.",
    "",
    "# ЯЗЫК",
    "- Отвечай на языке вопроса (кыргызский / русский).",
    "",
    "# ФОРМАТИРОВАНИЕ",
    "- Используй Markdown: заголовки (##), **жирный** для норм и сроков.",
    "- Дисклеймер в самом конце (с новой строки курсивом): ⚡ *(Создано с помощью ИИ \"Мыйзамчы\")*"
].join("\n");

const BASE_CONSULTANT_PROMPT = `
Ты — **Мыйзамчы Эксперт**, опытный практикующий юрист Кыргызской Республики.
Ты не справочник законов — ты живой юрист, который реально помогает людям решить их проблему.
Твои ответы должны основываться ИСКЛЮЧИТЕЛЬНО на предоставленных статьях законов КР (контексте).
Если в контексте нет ответа на вопрос — ты ОБЯЗАН прямо сказать: «К сожалению, в моей текущей базе НПА нет информации по этому вопросу.»
`.trim();

// --- МУЛЬТИМЕДИА И ПАРСИНГ ---
async function extractTextFromMedia(mimeType, base64Data) {
    const activeKey = getNextKey();
    const genAI = new GoogleGenerativeAI(activeKey);
    const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
    const prompt = "Извлеки текст из этого медиафайла. Если это голос, сделай точную транскрипцию. Если фото, распознай весь читаемый текст. Выведи ТОЛЬКО текст, без вступительных слов.";
    const result = await model.generateContent([ prompt, { inlineData: { data: base64Data, mimeType } } ]);
    return result.response.text();
}

async function extractTextFromDocument(buffer, mimeType, fileName) {
    try {
        if (mimeType === 'application/pdf' || fileName.endsWith('.pdf')) {
            const data = await pdfParse(buffer);
            return data.text;
        } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || fileName.endsWith('.docx')) {
            const result = await mammoth.extractRawText({ buffer: buffer });
            return result.value;
        } else {
            return "[Ошибка: Формат не поддерживается. Нужен PDF или Word]";
        }
    } catch (e) {
        console.error("Ошибка парсинга:", e);
        return "[Ошибка чтения документа]";
    }
}

async function getEmbedding(text, retryCount = 0) {
    const activeKey = getNextKey();
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${activeKey}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: "models/gemini-embedding-001",
                content: { parts: [{ text: text.substring(0, 8000) }] },
                outputDimensionality: 768
            })
        });
        const data = await response.json();
        if (response.status === 429 && retryCount < KEYS.length) {
            blockKey(activeKey);
            return getEmbedding(text, retryCount + 1);
        }
        if (!response.ok) throw new Error(data.error?.message || 'Embedding failed');
        return data.embedding.values.slice(0, 768);
    } catch (error) {
        console.error("Embedding error:", error.message);
        throw error;
    }
}

async function searchPinecone(vector, topK = 10) {
    try {
        const response = await fetch(cleanPineconeHost + '/query', {
            method: 'POST',
            headers: { 'Api-Key': PINECONE_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ vector, topK, includeMetadata: true })
        });
        const data = await response.json();
        return data.matches || [];
    } catch (error) {
        console.error("Pinecone error:", error.message);
        return [];
    }
}

function isCasualMessage(message) {
    const cleaned = message.trim().toLowerCase();
    const GREETING_PATTERNS = [/^(салам|привет|хай|здравствуй|здравствуйте|hi|hello|hey|ку)/i];
    return GREETING_PATTERNS.some(pattern => pattern.test(cleaned)) && cleaned.length < 50;
}

// ДОБАВЛЕН ПАРАМЕТР onProgress ДЛЯ РЕАЛЬНЫХ СТАТУСОВ
async function getAIAnswer(message, history = [], onProgress = null) {
    try {
        const isCasual = isCasualMessage(message);
        let contextText = '';

        if (!isCasual) {
            if (onProgress) await onProgress('🧮 Векторизую запрос (перевожу в цифры)...');
            const vector = await getEmbedding(message);
            
            if (onProgress) await onProgress('🔎 Ищу релевантные статьи в базе Pinecone...');
            const matches = await searchPinecone(vector, 10);
            
            const core = matches.filter(m => (m.score || 0) >= 0.75);
            const context = matches.filter(m => (m.score || 0) < 0.75 && (m.score || 0) >= 0.5);

            const coreText = core.map(m => `[⭐ КЛЮЧЕВАЯ СТАТЬЯ — ${m.metadata.npa_title}]\n${m.metadata.full_text}`).join('\n\n');
            const contextTextPart = context.map(m => `[📚 ВСПОМОГАТЕЛЬНАЯ — ${m.metadata.npa_title}]\n${m.metadata.full_text}`).join('\n\n');
            
            contextText = (coreText + '\n\n' + contextTextPart).trim();
        }

        const promptText = contextText 
            ? `Контекст законов КР:\n\n${contextText}\n\nВопрос пользователя: ${message}`
            : message;

        const activeKey = getNextKey();
        const genAI = new GoogleGenerativeAI(activeKey);
        const systemPrompt = contextText ? BASE_CONSULTANT_PROMPT + '\n\n' + systemInstruction : systemInstruction;

        if (onProgress) await onProgress('⚖️ База найдена. Генерирую юридический ответ...');
        
        const model = genAI.getGenerativeModel({
            model: "gemini-flash-latest",
            systemInstruction: systemPrompt
        });

        const chatHistory = history.map(msg => ({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.text }]
        })).slice(-10);

        const chat = model.startChat({ history: chatHistory });
        const result = await chat.sendMessage(promptText);
        return result.response.text();
    } catch (error) {
        console.error("AI Logic Error:", error.message);
        return "Извините, произошла ошибка при обработке вашего запроса.";
    }
}

module.exports = { getAIAnswer, extractTextFromMedia, extractTextFromDocument };
