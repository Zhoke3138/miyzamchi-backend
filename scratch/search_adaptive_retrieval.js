const fs = require('fs');
const content = fs.readFileSync('server.js', 'utf8');
const lines = content.split('\n');
let insideFunc = false;
let printedLines = 0;
lines.forEach((line, idx) => {
    if (line.includes('async function adaptiveRetrieval')) {
        insideFunc = true;
    }
    if (insideFunc) {
        console.log(`${idx+1}: ${line}`);
        printedLines++;
        if (printedLines > 100) {
            insideFunc = false;
        }
    }
});
