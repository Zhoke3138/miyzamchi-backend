require('dotenv').config();
const KEYS = (process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS || '').split(',').map(k => k.trim());
console.log("Parsed KEYS:");
KEYS.forEach((key, idx) => {
    console.log(`[${idx}]: "${key}" (length: ${key.length})`);
});
