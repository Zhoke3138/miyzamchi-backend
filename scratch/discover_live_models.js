const fetch = require('node-fetch');
require('dotenv').config();

const KEYS = (process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS || '').split(',').map(k => k.trim());
const activeKey = KEYS[0];

if (!activeKey) {
    console.error("No API key found!");
    process.exit(1);
}

async function discover() {
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${activeKey}`;
        const res = await fetch(url);
        if (!res.ok) {
            console.error(`API returned status ${res.status}: ${await res.text()}`);
            return;
        }
        const data = await res.json();
        console.log("Models supporting bidiGenerateContent:");
        data.models.forEach(m => {
            if (m.supportedGenerationMethods.includes('bidiGenerateContent')) {
                console.log(`- ${m.name} (${m.displayName})`);
            }
        });
    } catch (e) {
        console.error("Error discovering models:", e);
    }
}

discover();
