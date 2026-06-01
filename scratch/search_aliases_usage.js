const fs = require('fs');
const content = fs.readFileSync('server.js', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
    if (line.includes('npaAliases') || line.includes('normalizeNpaName')) {
        console.log(`${idx+1}: ${line.trim()}`);
    }
});
