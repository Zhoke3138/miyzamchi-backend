const WebSocket = require('ws');
require('dotenv').config();

const KEYS = (process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS || '').split(',').map(k => k.trim());
const activeKey = KEYS[0];

const modelsToTest = [
    'models/gemini-2.0-flash-exp',
    'models/gemini-2.0-flash',
    'models/gemini-2.0-flash-live',
    'models/gemini-2.0-flash-thinking-exp',
    'models/gemini-2.5-flash',
    'models/gemini-2.5-flash-live-preview',
    'models/gemini-3.1-flash-live-preview'
];

async function testModel(modelName) {
    return new Promise((resolve) => {
        const geminiUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${activeKey}`;
        console.log(`[TEST] Trying model: ${modelName}...`);
        const ws = new WebSocket(geminiUrl);

        let resolved = false;

        ws.on('open', () => {
            const setupMessage = {
                setup: {
                    model: modelName,
                    generationConfig: {
                        responseModalities: ['AUDIO'],
                        speechConfig: {
                            voiceConfig: {
                                prebuiltVoiceConfig: {
                                    voiceName: 'Aoede'
                                }
                            }
                        }
                    }
                }
            };
            ws.send(JSON.stringify(setupMessage));
        });

        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.setupComplete) {
                console.log(`✅ SUCCESS: ${modelName} is SUPPORTED!`);
                ws.close();
                resolved = true;
                resolve(true);
            } else {
                console.log(`[MSG] ${modelName}:`, data.toString());
            }
        });

        ws.on('close', (code, reason) => {
            if (!resolved) {
                console.log(`❌ FAILED: ${modelName}. Code: ${code}, Reason: ${reason.toString().slice(0, 100)}`);
                resolve(false);
            }
        });

        ws.on('error', (err) => {
            if (!resolved) {
                console.log(`❌ ERROR: ${modelName}. Message: ${err.message}`);
                resolve(false);
            }
        });

        // Timeout after 4 seconds
        setTimeout(() => {
            if (!resolved) {
                console.log(`⏰ TIMEOUT: ${modelName}`);
                ws.close();
                resolve(false);
            }
        }, 4000);
    });
}

async function runAll() {
    for (const model of modelsToTest) {
        await testModel(model);
        console.log('---');
    }
}

runAll();
