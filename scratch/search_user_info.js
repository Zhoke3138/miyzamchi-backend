const fs = require('fs');
const content = fs.readFileSync('server.js', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
    if (line.includes('обо мне') || line.includes('разработчик') || line.includes('автор') || line.includes('про меня')) {
        console.log(`${idx+1}: ${line.trim()}`);
    }
});
