const fs = require('fs');
const content = fs.readFileSync('index.html', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
    if (line.includes('WebSocket') || line.includes('ws://') || line.includes('wss://') || line.includes('/api/voice')) {
        console.log(`${idx+1}: ${line.trim()}`);
    }
});
