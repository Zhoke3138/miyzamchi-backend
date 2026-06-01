const fs = require('fs');
const content = fs.readFileSync('script.js', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
    if (line.includes('/api/')) {
        console.log(`${idx+1}: ${line.trim()}`);
    }
});
