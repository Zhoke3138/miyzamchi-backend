const WebSocket = require('ws');
require('dotenv').config();

const KEYS = (process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS || '').split(',').map(k => k.trim());
const activeKey = KEYS[0];

const modelName = 'models/gemini-3.1-flash-live-preview';
const geminiUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${activeKey}`;

console.log(`Connecting to Gemini Live with model ${modelName}...`);
const ws = new WebSocket(geminiUrl);

ws.on('open', () => {
    console.log("WebSocket connection established. Sending setup...");
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
    console.log("Received message:", data.toString());
    const msg = JSON.parse(data.toString());
    if (msg.setupComplete) {
        console.log("Setup complete! Sending a tiny 1-second dummy PCM audio chunk...");
        const dummyAudioBase64 = Buffer.alloc(32000).toString('base64'); // 1 second of 16kHz PCM audio
        const realtimeInputMsg = {
            realtimeInput: {
                audio: {
                    mimeType: 'audio/pcm;rate=16000',
                    data: dummyAudioBase64
                }
            }
        };
        ws.send(JSON.stringify(realtimeInputMsg));
        console.log("Sent realtimeInput audio chunk using new format.");
    }
});

ws.on('close', (code, reason) => {
    console.log(`Connection closed: ${code} - ${reason.toString()}`);
});

ws.on('error', (err) => {
    console.error("WebSocket error:", err);
});
