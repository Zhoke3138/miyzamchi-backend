const fs = require('fs');
const content = fs.readFileSync('index.html', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
    if (line.includes('voice-modal') || line.includes('voice-container') || line.includes('lucide-phone-off')) {
        console.log(`${idx+1}: ${line.trim()}`);
    }
});
