const fs = require('fs');
const code = fs.readFileSync('server.js', 'utf8');
const lines = code.split('\n');
lines.forEach((line, idx) => {
    if (line.includes('getActiveKey')) {
        console.log(`${idx + 1}: ${line}`);
    }
});
