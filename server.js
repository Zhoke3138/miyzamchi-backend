require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleAuth } = require('google-auth-library');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Инициализация авторизации Google Cloud
const auth = new GoogleAuth({
    credentials: {
        client_email: process.env.CLIENT_EMAIL,
        private_key: process.env.PRIVATE_KEY.replace(/\\n/g, '\n')
    },
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
});

app.post('/api/chat', async (req, res) => {
    try {
        const { message, history } = req.body;
        if (!message) return res.status(400).json({ reply: "Пустое сообщение" });

        const client = await auth.getClient();
        const accessToken = (await client.getAccessToken()).token;

        // ==========================================
        // ШАГ 1: МАКСИМАЛЬНЫЙ ПОИСК В БАЗЕ (Google Discovery Engine)
        // ==========================================
        const searchUrl = `https://discoveryengine.googleapis.com/v1alpha/projects/${process.env.PROJECT_ID}/locations/${process.env.LOCATION_ID}/collections/default_collection/dataStores/${process.env.DATA_STORE_ID}/servingConfigs/default_config:search`;

        const searchRes = await fetch(searchUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
            body: JSON.stringify({ 
                query: message, 
                pageSize: 100, // МАКСИМАЛЬНО ДОПУСТИМЫЙ ЛИМИТ API. Вытягиваем огромный кусок текста!
                contentSearchSpec: { 
                    snippetSpec: { returnSnippet: true },
                    summarySpec: { summaryResultCount: 5 } // Немного увеличим количество саммари для контекста
                } 
            })
        });

        const searchData = await searchRes.json();
        
        // Собираем весь найденный массив текста
        let contextText = "";
        if (searchData.results && searchData.results.length > 0) {
            const snippets = searchData.results.map(r => {
                let text = r.document?.derivedStructData?.snippets?.[0]?.snippet || "";
                return text.replace(/<[^>]*>?/gm, ''); // Чистим от HTML
            }).filter(t => t.length > 0);
            
            if (snippets.length > 0) {
                contextText = snippets.join("\n\n---\n\n");
            }
        }
        
        if (!contextText.trim()) {
            contextText = "В загруженном источнике нет информации по этому запросу.";
        }

        console.log(`🔍 Найдено фрагментов: ${searchData.results?.length || 0}. Передаем в ИИ...`);

        // ==========================================
        // ШАГ 2: СТРОГАЯ ИНСТРУКЦИЯ (Режим NotebookLM)
        // ==========================================
        const systemInstruction = `Ты — Мыйзамчи, образовательный ИИ-помощник для студентов и юристов по праву Кыргызской Республики.
Твоя задача — работать как продвинутый анализатор документов. Ты должен глубоко анализировать переданный тебе текст и выдавать структурированные, исчерпывающие ответы.

ПРАВИЛА РАБОТЫ (СТРОГО):
1. ОПИРАЙСЯ ТОЛЬКО НА КОНТЕКСТ: Вся твоя база знаний для ответа находится ИСКЛЮЧИТЕЛЬНО в блоке "Контекст из базы законов". 
2. ПОЛНЫЙ РАЗБОР: Если пользователь просит расписать статью (например, ст. 222), найди её в контексте, выведи её полный текст и сделай юридический разбор (объясни смысл, выдели главные пункты списком, объясни юридическое значение).
3. АНТИ-ГАЛЛЮЦИНАЦИЯ: КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО выдумывать номера статей, законы или содержание, которых нет в предоставленном контексте. 
4. ОТСУТСТВИЕ ДАННЫХ: Если после анализа огромного контекста ты видишь, что нужной статьи там действительно нет, честно ответь: "В загруженном источнике эта информация отсутствует" и не пытайся ее выдумать.
5. СОСТАВЛЕНИЕ ДОКУМЕНТОВ: Если просят составить иск, письмо или претензию — используй стиль официального документа. Если нужных статей для ссылки в контексте нет, пиши качественный шаблон, оставляя места для статей так: [укажите статью ГК КР].`;

        const contents = [];
        
        if (history && history.length > 0) {
            history.forEach(msg => {
                contents.push({
                    role: msg.role === 'user' ? 'user' : 'model',
                    parts: [{ text: msg.text }]
                });
            });
        }

        contents.push({
            role: 'user',
            parts: [{ text: `Контекст из базы законов:\n${contextText}\n\nВопрос пользователя: ${message}` }]
        });

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;

        const geminiRes = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: systemInstruction }] },
                contents: contents,
                generationConfig: { 
                    temperature: 0.2 // Низкая температура для строгого следования тексту, но достаточная для красивого форматирования
                }
            })
        });

        const geminiData = await geminiRes.json();
        if (!geminiRes.ok) throw new Error(JSON.stringify(geminiData));

        const finalReply = geminiData.candidates[0].content.parts[0].text;
        res.json({ reply: finalReply });

    } catch (error) {
        console.error("❌ Ошибка:", error);
        res.status(500).json({ reply: "Произошла ошибка при обработке запроса. Сервер временно недоступен." });
    }
});

app.listen(PORT, () => console.log(`✅ Образовательный ИИ-помощник Miyzamchi запущен на порту ${PORT}`));