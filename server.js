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
        const { message, history } = req.body;
        if (!message) return res.status(400).json({ reply: "Пустое сообщение" });

        const client = await auth.getClient();
        const accessToken = (await client.getAccessToken()).token;

        // ШАГ 1: ЖЕСТКИЙ ПОИСК В БАЗЕ (вытягиваем сами куски законов)
        const searchUrl = `https://discoveryengine.googleapis.com/v1alpha/projects/${process.env.PROJECT_ID}/locations/${process.env.LOCATION_ID}/collections/default_collection/dataStores/${process.env.DATA_STORE_ID}/servingConfigs/default_config:search`;

        const searchRes = await fetch(searchUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
            body: JSON.stringify({ 
                query: message, 
                pageSize: 5, // Берем 5 кусков текста для надежности
                contentSearchSpec: { 
                    snippetSpec: { returnSnippet: true }, // Запрашиваем точные выдержки
                    summarySpec: { summaryResultCount: 3 } 
                } 
            })
        });

        const searchData = await searchRes.json();
        
        // Надежно собираем найденный текст из базы
        let contextText = "";
        if (searchData.results && searchData.results.length > 0) {
            const snippets = searchData.results.map(r => {
                let text = r.document?.derivedStructData?.snippets?.[0]?.snippet || "";
                return text.replace(/<[^>]*>?/gm, ''); // Убираем HTML-теги для чистоты
            }).filter(t => t.length > 0);
            
            if (snippets.length > 0) {
                contextText = snippets.join("\n\n---\n\n");
            }
        }
        
        // Если база ничего не нашла
        if (!contextText.trim()) {
            contextText = "В БАЗЕ НЕТ ИНФОРМАЦИИ.";
        }

        // Выводим в консоль Render, чтобы ты видел, нашел ли он закон
        console.log("🔍 Найденный контекст для вопроса:", contextText.substring(0, 200) + "...");

        // ШАГ 2: СТРОГАЯ ИНСТРУКЦИЯ (Режим NotebookLM)
        const systemInstruction = `Ты — Мыйзамчи, образовательный ИИ-помощник для студентов и юристов по праву Кыргызской Республики.
Твоя ГЛАВНАЯ задача — отвечать СТРОГО на основе текста, который передан тебе в блоке "Контекст из базы законов".

ЖЕСТКИЕ ПРАВИЛА:
1. ЗАПРЕЩЕНО выдумывать статьи законов, сроки, штрафы или процедуры.
2. Если в "Контексте из базы" НЕТ ответа на вопрос или написано "В БАЗЕ НЕТ ИНФОРМАЦИИ", ты ОБЯЗАН ответить: "К сожалению, в моей загруженной базе законов пока нет точной информации по этому вопросу."
3. Если информация в контексте есть, отвечай кратко (1-4 предложения), понятно и структурированно.
4. Будь дружелюбным, но помни, что юридическая точность важнее болтовни. Не добавляй от себя факты, которых нет в контексте.`;

        const contents = [];
        if (history && history.length > 0) {
            history.forEach(msg => {
                contents.push({
                    role: msg.role === 'user' ? 'user' : 'model',
                    parts: [{ text: msg.text }]
                });
            });
        }

        // Передаем контекст как железобетонный факт
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
                    temperature: 0.1 // Снизили фантазию почти до нуля!
                }
            })
        });

        const geminiData = await geminiRes.json();
        if (!geminiRes.ok) throw new Error(JSON.stringify(geminiData));

        const finalReply = geminiData.candidates[0].content.parts[0].text;
        res.json({ reply: finalReply });

    } catch (error) {
        console.error("❌ Ошибка:", error);
        res.status(500).json({ reply: "Произошла ошибка связи с базой законов." });
    }
});

app.listen(PORT, () => console.log(`✅ Miyzamchi RAG-режим включен на порту ${PORT}`));