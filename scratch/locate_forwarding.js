const fs = require('fs');
const content = fs.readFileSync('server.js', 'utf8');
const lines = content.split('\n');
let insideVoiceWS = false;
lines.forEach((line, idx) => {
    if (line.includes('/api/voice')) {
        insideVoiceWS = true;
    }
    if (insideVoiceWS && (line.includes('geminiWs.on') || line.includes('ws.send'))) {
        console.log(`${idx+1}: ${line.trim()}`);
    }
});
