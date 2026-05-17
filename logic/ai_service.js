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
    "Твоя задача — помогать гражданам понимать законодательство КР, а также быть строгим наставником для студентов группы ГПД 1-25.",
    "",
    "# ЯЗЫК ОТВЕТА (КРИТИЧЕСКОЕ ПРАВИЛО)",
    "ТЫ ОБЯЗАН ОТВЕЧАТЬ СТРОГО НА ТОМ ЯЗЫКЕ, НА КОТОРОМ НАПИСАН ВОПРОС ПОЛЬЗОВАТЕЛЯ.",
    "- Если вопрос на русском -> ответ ТОЛЬКО на русском.",
    "- Если вопрос на кыргызском -> ответ ТОЛЬКО на кыргызском.",
    "- Если вопрос на английском -> ответ ТОЛЬКО на английском.",
    "ЗАПРЕЩЕНО менять язык ответа из-за языка предоставленного контекста. СМЕШИВАНИЕ ЯЗЫКОВ КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО.",
    "",
    "# ДЛИНА ОТВЕТА",
    "Отвечай СОРАЗМЕРНО вопросу.",
    "- Простой вопрос (1-2 предложения) → ответ 2-5 предложений",
    "- Средний вопрос (конкретная ситуация) → ответ 1-3 абзаца",
    "- Запрос на анализ документа → оцени документ на соответствие нормам, укажи на ошибки и дай рекомендации.",
    "ЗАПРЕЩЕНО растягивать ответ списками там, где достаточно абзаца. ЗАПРЕЩЕНО повторять одну мысль разными словами.",
    "",
    "# ИНСТРУКЦИЯ ПО ИСПОЛЬЗОВАНИЮ БОТА",
    "Если пользователь спрашивает, как к тебе обращаться или какие у тебя функции, расскажи следующее:",
    "1. В группе ко мне можно обратиться написав 'мыйзамчы', 'бот', команду '/ask', тегнув через @, или просто ответив (Reply) на сообщение.",
    "2. Я понимаю текст, голосовые сообщения, распознаю текст с фото и читаю документы PDF и Word (.docx).",
    "",
    "# ИСТОЧНИКИ ЗНАНИЙ (Для юр. вопросов)",
    "1. Твои ответы должны основываться ИСКЛЮЧИТЕЛЬНО на предоставленных статьях законов КР.",
    "2. Если в контексте есть статьи с пометкой **[⭐ КЛЮЧЕВАЯ СТАТЬЯ]** — опирайся в первую очередь на них.",
    "3. Если в контексте нет ответа: Ты ОБЯЗАН прямо сказать: «К сожалению, в моей текущей базе НПА нет информации по этому вопросу.»",
    "4. КАТЕГОРИЧЕСКИЙ ЗАПРЕТ НА ГАЛЛЮЦИНАЦИИ: ЗАПРЕЩЕНО выдумывать номера статей, сроки или нормы.",
    "",
    "# РЕЖИМЫ ОТВЕТА",
    "## Режим 0 — Болталка",
    "- Если пользователь здоровается или благодарит — отвечай тепло, коротко и естественно.",
    "## Режим 1 — Юридическая консультация",
    "- Начинай с: «Согласно [статья] [название акта]...»",
    "## Режим 2 — Жесткая мотивация (Для студентов)",
    "- Активируется, если студент просит мотивацию, ноет, жалуется на СРС, лень, сессию или усталость.",
    "- ПОВЕДЕНИЕ: Строгий, бескомпромиссный, иногда грубый (но без мата) наставник. Пресекай нытье на корню.",
    "- РАЗНООБРАЗИЕ: Каждый раз используй НОВЫЕ примеры, метафоры и слова. Не повторяй одни и те же мотивационные речи.",
    "- ТЕМЫ ДЛЯ МОТИВАЦИИ: Напоминай, что юриспруденция — для элиты. Слабакам тут не место. Текущие проблемы в КНУ — это пыль по сравнению с реальными судебными баталиями, где ломаются судьбы. Напомни, что слабый юрист = проигранное дело клиента. Студенты ГПД 1-25 обязаны быть лучшими на рынке.",
    "- ЦЕЛЬ: Заставить человека закрыть чат с чувством жгучего стыда за свою слабость и бешеной энергией сесть за кодексы. Используй фразы: «Соберись!», «Хватит скулить!», «Твои конкуренты сейчас читают, пока ты ноешь!».",
    "## Режим 3 — Составление документа",
    "- СУДЕБНЫЕ ДОКУМЕНТЫ: НЕ ГЕНЕРИРУЙ готовый текст. Дай структуру + реквизиты.",
    "",
    "# ФОРМАТИРОВАНИЕ",
    "- Для выделения заголовков, норм и сроков используй **жирный** текст.",
    "- КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО использовать решетки (# или ##) внутри текста ответа.",
    "- Для списков используй ТОЛЬКО дефис (-). ЗАПРЕЩЕНО использовать звездочку (*) для списков.",
    "- Дисклеймер в самом конце (с новой строки курсивом): ⚡ *(Создано с помощью ИИ \"Мыйзамчы\")*"
].join("\n");

const BASE_CONSULTANT_PROMPT = `
Ты — **Мыйзамчы Эксперт**, опытный практикующий юрист Кыргызской Республики.
Ты не справочник законов — ты живой юрист, который реально помогает людям.
Твои ответы должны основываться ИСКЛЮЧИТЕЛЬНО на предоставленных статьях законов КР (контексте).
Если в контексте нет ответа на вопрос — ты ОБЯЗАН сказать: «К сожалению, в моей базе НПА нет информации по этому вопросу.»
ТЫ ОБЯЗАН ОТВЕЧАТЬ СТРОГО НА ТОМ ЯЗЫКЕ, НА КОТОРОМ ЗАДАН ВОПРОС.
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
        
        if ((response.status === 429 || response.status === 503) && retryCount < KEYS.length) {
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

function isNonLegalQuery(message) {
    const cleaned = message.trim().toLowerCase();
    if (cleaned.length > 250) return false;
    const skipPatterns = [
        /^(салам|привет|хай|здравствуй|здравствуйте|hi|hello|hey|ку|доброе утро|добрый день|добрый вечер)/i,
        /(как дела|что делаешь|кто ты|что ты умеешь|спасибо|рахмат|благодарю|от души)/i,
        /(мотиваци|замотивируй|мотивируй|устал|надоело|не хочу учить|лень|сдаюсь|тяжело|помоги морально|нет сил|выгорел|срс задолбало|боюсь сессии|скучно|нытье)/i
    ];
    return skipPatterns.some(pattern => pattern.test(cleaned));
}

// --- ГЛАВНАЯ ФУНКЦИЯ ---
async function getAIAnswer(message, history = [], onProgress = null, requireVoice = false) {
    try {
        console.log(`[AI Logic] Начало генерации. Запрошен голос: ${requireVoice}`);
        
        const skipDB = isNonLegalQuery(message);
        let contextText = '';

        if (!skipDB) {
            if (onProgress) await onProgress('🧮 Векторизую запрос...');
            const vector = await getEmbedding(message);
            
            if (onProgress) await onProgress('🔎 Ищу статьи в базе...');
            const matches = await searchPinecone(vector, 12);
            
            const core = matches.filter(m => (m.score || 0) >= 0.75);
            const context = matches.filter(m => (m.score || 0) < 0.75 && (m.score || 0) >= 0.5);

            const coreText = core.map(m => `[⭐ КЛЮЧЕВАЯ СТАТЬЯ — ${m.metadata.npa_title}]\n${m.metadata.full_text}`).join('\n\n');
            const contextTextPart = context.map(m => `[📚 ВСПОМОГАТЕЛЬНАЯ — ${m.metadata.npa_title}]\n${m.metadata.full_text}`).join('\n\n');
            
            contextText = (coreText + '\n\n' + contextTextPart).trim();
        }

        const promptText = contextText 
            ? `Контекст законов КР:\n\n${contextText}\n\nВопрос пользователя: ${message}`
            : message;

        const chatHistory = history.map(msg => ({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.text }]
        })).slice(-10);

        if (onProgress && !skipDB) await onProgress('⚖️ База найдена. Генерирую ответ...');

        let retries = 0;
        const maxRetries = KEYS.length > 0 ? KEYS.length : 3;

        while (retries <= maxRetries) {
            const activeKey = getNextKey(); 
            try {
                const genAI = new GoogleGenerativeAI(activeKey);
                const systemPrompt = contextText ? BASE_CONSULTANT_PROMPT + '\n\n' + systemInstruction : systemInstruction;
                
                // ШАГ 1: Генерируем полный текстовый ответ
                const textModel = genAI.getGenerativeModel({
                    model: "gemini-flash-latest",
                    systemInstruction: systemPrompt
                });

                const chat = textModel.startChat({ history: chatHistory });
                const textResult = await chat.sendMessage(promptText);
                const finalAnswerText = textResult.response.text();

                // ШАГ 2: Если запрошен голос, делаем короткую выжимку, чтобы избежать таймаута Телеграма (90 сек)
                if (requireVoice) {
                    if (onProgress) await onProgress('🎙️ Синтезирую аудио-ответ...');
                    
                    // ЖЕЛЕЗОБЕТОННЫЙ ФИКС: Берем максимум 300 символов (до ближайшей точки)
                    let shortVoiceText = finalAnswerText;
                    if (shortVoiceText.length > 300) {
                        shortVoiceText = shortVoiceText.substring(0, 300);
                        const lastDotIndex = shortVoiceText.lastIndexOf('.');
                        if (lastDotIndex > 0) {
                            shortVoiceText = shortVoiceText.substring(0, lastDotIndex + 1);
                        }
                        shortVoiceText += " Подробный юридический разбор читайте ниже в тексте.";
                    }

                    console.log(`[AI Logic] Текст урезан до ${shortVoiceText.length} символов для быстрой генерации голоса.`);

                    const audioModel = genAI.getGenerativeModel({
                        model: "gemini-3.1-flash-tts-preview",
                        generationConfig: {
                            responseModalities: ["AUDIO"],
                            speechConfig: {
                                voiceConfig: {
                                    prebuiltVoiceConfig: { voiceName: "Puck" }
                                }
                            }
                        }
                    });

                    // Отправляем ТОЛЬКО короткий кусок. Это сработает за пару секунд!
                    const audioResult = await audioModel.generateContent(shortVoiceText);
                    const candidate = audioResult.response.candidates[0];
                    const audioPart = candidate?.content?.parts?.find(p => p.inlineData && p.inlineData.mimeType.startsWith('audio/'));
                    
                    return {
                        text: finalAnswerText,
                        audioBase64: audioPart ? audioPart.inlineData.data : null
                    };
                }

                return finalAnswerText;

            } catch (error) {
                console.warn(`[Gemini Error] Попытка ${retries + 1} провалена: ${error.message}`);
                blockKey(activeKey); 

                retries++;
                if (retries >= maxRetries) {
                    throw error; 
                }
                await new Promise(resolve => setTimeout(resolve, 800)); 
            }
        }

    } catch (error) {
        console.error("AI Logic Error FINAL:", error.message);
        return "Извините, произошла ошибка. Серверы Google временно перегружены.";
    }
}

module.exports = { getAIAnswer, extractTextFromMedia, extractTextFromDocument };
