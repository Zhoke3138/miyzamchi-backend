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
                pageSize: 100, // Берем максимум фрагментов
                contentSearchSpec: { 
                    snippetSpec: { returnSnippet: true },
                    summarySpec: { summaryResultCount: 5 } 
                } 
            })
        });

        const searchData = await searchRes.json();
        
        // Собираем контекст из найденных фрагментов
        let contextText = "";
        if (searchData.results && searchData.results.length > 0) {
            const snippets = searchData.results.map(r => {
                let text = r.document?.derivedStructData?.snippets?.[0]?.snippet || "";
                return text.replace(/<[^>]*>?/gm, ''); // Очистка HTML
            }).filter(t => t.length > 0);
            
            if (snippets.length > 0) {
                contextText = snippets.join("\n\n---\n\n");
            }
        }
        
        if (!contextText.trim()) {
            contextText = "Локальная база не выдала релевантных документов.";
        }

        console.log(`🔍 Найдено фрагментов: ${searchData.results?.length || 0}`);

        // ==========================================
        // ШАГ 2: УМНАЯ ИНСТРУКЦИЯ (Гибридный режим NotebookLM)
        // ==========================================
        const systemInstruction = `Ты — Мыйзамчи, продвинутый образовательный ИИ-помощник для студентов и юристов по праву Кыргызской Республики.
Твоя задача — давать глубокие, точные и структурированные юридические консультации, объединяя данные из локальной базы с твоими собственными знаниями законодательства КР.

АЛГОРИТМ ТВОЕЙ РАБОТЫ (СТРОГО):
1. ИЗУЧИ КОНТЕКСТ: Сначала ищи ответ в блоке "Контекст из базы законов". Если там есть нужная статья из правильного кодекса — цитируй и анализируй её.
2. ИСПОЛЬЗУЙ ВНУТРЕННЮЮ ПАМЯТЬ (ГЛАВНОЕ ПРАВИЛО): Если в "Контексте" выдалась нерелевантная информация (например, просят ГК КР, а в контексте статьи из УК КР) ИЛИ контекст пуст, НО ты точно знаешь эту статью из своих базовых знаний законодательства Кыргызской Республики — ТЫ ОБЯЗАН ОТВЕТИТЬ! Не смей писать "в источнике информация отсутствует". Достань статью из своей памяти и полностью ее распиши.
3. ПРОЗРАЧНОСТЬ ДЛЯ СТУДЕНТОВ: Если ты взял текст статьи из своей памяти (потому что локальный поиск не справился), ОБЯЗАТЕЛЬНО начни ответ с фразы курсивом: *(Примечание: локальный поиск не нашел нужный документ, ответ сгенерирован на основе встроенных знаний ИИ о праве КР. Рекомендуется сверить с актуальной редакцией).*
4. СТИЛЬ ОТВЕТА: Делай полный юридический разбор. Объясняй смысл нормы, выделяй главные пункты списком, пиши профессионально.
5. АНТИ-ГАЛЛЮЦИНАЦИЯ: Используй внутреннюю память только для реальных, существующих законов КР. Если пользователь просит выдуманный закон — честно скажи, что такого закона не существует.
6. ДОКУМЕНТЫ: Если просят составить иск или письмо, пиши полный текст, используя свои знания юриспруденции.`;

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
                    temperature: 0.3 // Низкая температура для точности в терминах, но достаточная для генерации хорошего разбора из памяти
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

app.listen(PORT, () => console.log(`✅ Образовательный ИИ-помощник Miyzamchi (Smart Mode) запущен на порту ${PORT}`));