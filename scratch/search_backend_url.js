const fs = require('fs');
const content = fs.readFileSync('index.html', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
    if (line.includes('onrender.com') || line.includes('API_URL') || line.includes('BACKEND_URL')) {
        console.log(`${idx+1}: ${line.trim()}`);
    }
});
