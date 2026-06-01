const fs = require('fs');

function search(fileName) {
    if (!fs.existsSync(fileName)) return;
    const content = fs.readFileSync(fileName, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
        if (line.includes('mediaChunks') || line.includes('media_chunks')) {
            console.log(`${fileName}:${idx+1}: ${line.trim()}`);
        }
    });
}

search('server.js');
search('index.html');
