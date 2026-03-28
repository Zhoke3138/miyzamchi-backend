require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleAuth } = require('google-auth-library');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Инициализация авторизации Google Cloud для доступа к Discovery Engine
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
        // ШАГ 1: ПОИСК В БАЗЕ (Google Discovery Engine)
        // ==========================================
        const searchUrl = `https://discoveryengine.googleapis.com/v1alpha/projects/${process.env.PROJECT_ID}/locations/${process.env.LOCATION_ID}/collections/default_collection/dataStores/${process.env.DATA_STORE_ID}/servingConfigs/default_config:search`;

        const searchRes = await fetch(searchUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
            body: JSON.stringify({ 
                query: message, 
                pageSize: 5,
                contentSearchSpec: { 
                    snippetSpec: { returnSnippet: true },
                    summarySpec: { summaryResultCount: 3 } 
                } 
            })
        });

        const searchData = await searchRes.json();
        
        // Собираем контекст из найденных фрагментов
        let contextText = "";
        if (searchData.results && searchData.results.length > 0) {
            const snippets = searchData.results.map(r => {
                let text = r.document?.derivedStructData?.snippets?.[0]?.snippet || "";
                return text.replace(/<[^>]*>?/gm, ''); // Очистка HTML для чистой передачи в Gemini
            }).filter(t => t.length > 0);
            
            if (snippets.length > 0) {
                contextText = snippets.join("\n\n---\n\n");
            }
        }
        
        // Если база пуста, даем сигнал ИИ не блокироваться, а работать как генератор шаблонов
        if (!contextText.trim()) {
            contextText = "Специфических документов в локальной базе не найдено. Можно генерировать текст документа, но номера статей нужно оставлять пустыми [в скобках].";
        }

        console.log("🔍 Найденный контекст:", contextText.substring(0, 150) + "...");

        // ==========================================
        // ШАГ 2: НАСТРОЙКА ИИ (Режим NotebookLM с защитой от галлюцинаций)
        // ==========================================
        const systemInstruction = `Ты — Мыйзамчи, образовательный ИИ-помощник для студентов и юристов по праву Кыргызской Республики.
Твоя задача — помогать составлять юридические документы, иски, официальные письма и консультировать, опираясь на логику права.

ЖЕСТКОЕ ПРАВИЛО ФАКТОВ (АНТИ-ГАЛЛЮЦИНАЦИЯ):
1. Тебе КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО выдумывать номера статей, точные сроки, суммы штрафов или названия нормативных актов, если их нет в блоке "Контекст из базы законов".
2. Если в "Контексте" есть нужная статья — цитируй её уверенно.
3. Если пользователь просит составить документ (например, иск или ответ абоненту), а нужных статей в базе нет, ты ОБЯЗАН написать полный, качественный текст документа, но вместо выдуманных статей использовать заглушки в квадратных скобках. Например: "в соответствии со статьей [укажите нужную статью] Гражданского кодекса КР" или ссылаться на право в общих чертах ("согласно законодательству КР").
4. Не отказывайся писать документ из-за отсутствия статей в базе. Пиши структуру, аргументацию и фабулу, оставляя места для точных ссылок на закон пустыми.`;

        const contents = [];
        
        // Подгружаем историю переписки
        if (history && history.length > 0) {
            history.forEach(msg => {
                contents.push({
                    role: msg.role === 'user' ? 'user' : 'model',
                    parts: [{ text: msg.text }]
                });
            });
        }

        // Передаем контекст и текущий вопрос
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
                    temperature: 0.25 // Баланс: достаточно для красивого письма, но не дает выдумывать статьи
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