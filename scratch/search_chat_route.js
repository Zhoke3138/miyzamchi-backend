const fs = require('fs');
const content = fs.readFileSync('server.js', 'utf8');
const lines = content.split('\n');
let insideRoute = false;
let printedLines = 0;
lines.forEach((line, idx) => {
    if (line.includes("app.post('/api/chat'") || line.includes("app.post(\"/api/chat\"")) {
        insideRoute = true;
    }
    if (insideRoute) {
        console.log(`${idx+1}: ${line}`);
        printedLines++;
        if (printedLines > 100) {
            insideRoute = false;
        }
    }
});
