require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleAuth } = require('google-auth-library');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const auth = new GoogleAuth({
    credentials: {
        client_email: process.env.CLIENT_EMAIL,
        private_key: process.env.PRIVATE_KEY.replace(/\\n/g, '\n')
    },
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
});

app.post('/api/chat', async (req, res) => {
    try {
        const { message, history } = req.body; // Получаем сообщение и историю
        if (!message) return res.status(400).json({ reply: "Пустое сообщение" });

        const client = await auth.getClient();
        const accessToken = (await client.getAccessToken()).token;

        // ШАГ 1: ПОИСК В БАЗЕ (на основе последнего вопроса)
        const searchUrl = `https://discoveryengine.googleapis.com/v1alpha/projects/${process.env.PROJECT_ID}/locations/${process.env.LOCATION_ID}/collections/default_collection/dataStores/${process.env.DATA_STORE_ID}/servingConfigs/default_config:search`;

        const searchRes = await fetch(searchUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
            body: JSON.stringify({ query: message, pageSize: 3, contentSearchSpec: { summarySpec: { summaryResultCount: 3 } } })
        });

        const searchData = await searchRes.json();
        let contextText = searchData.summary?.summaryText || "В базе НПА информации не найдено.";

        // ШАГ 2: ФОРМИРУЕМ ИСТОРИЮ ДЛЯ GEMINI
        // Мы берем системную инструкцию и добавляем туда историю диалога
        const systemInstruction = `Ты — Мыйзамчи (Miyzamchi), AI-помощник по праву КР. (Тут твоя большая инструкция про юмор, стиль и ссылки на законы...)`;
        // (Для краткости я сократил текст инструкции выше, вставь туда свой полный текст из раздела 08!)

        // Превращаем историю из нашего формата в формат Gemini
        const contents = [];
        if (history && history.length > 0) {
            history.forEach(msg => {
                contents.push({
                    role: msg.role === 'user' ? 'user' : 'model',
                    parts: [{ text: msg.text }]
                });
            });
        }

        // Добавляем текущий вопрос с контекстом из базы
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
                contents: contents, // Отправляем всю цепочку сообщений
                generationConfig: { temperature: 0.3 }
            })
        });

        const geminiData = await geminiRes.json();
        if (!geminiRes.ok) throw new Error(JSON.stringify(geminiData));

        const finalReply = geminiData.candidates[0].content.parts[0].text;
        res.json({ reply: finalReply });

    } catch (error) {
        console.error("Ошибка:", error);
        res.status(500).json({ reply: "Произошла ошибка памяти сервера." });
    }
});

app.listen(PORT, () => console.log(`✅ Miyzamchi теперь с памятью на порту ${PORT}`));