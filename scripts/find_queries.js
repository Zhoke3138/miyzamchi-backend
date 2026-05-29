const fs = require('fs');
const content = fs.readFileSync('c:/Users/Professional/Desktop/ИИ/script.js', 'utf8');
const lines = content.split('\n');
const results = [];
lines.forEach((l, i) => {
    if (l.includes('querySelector(') && l.includes('\'i\'') || l.includes('"i"')) {
        results.push(`${i+1}: ${l}`);
    }
});
fs.writeFileSync('c:/Users/Professional/Desktop/ИИ/scripts/output.txt', results.join('\n'));
