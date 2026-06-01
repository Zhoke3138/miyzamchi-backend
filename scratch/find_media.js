const fs = require('fs');
const path = require('path');

function findWebp(dir) {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);
    files.forEach(file => {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            findWebp(fullPath);
        } else if (file.endsWith('.webp') || file.endsWith('.png')) {
            console.log(`${fullPath} (${stat.size} bytes)`);
        }
    });
}

findWebp('C:\\Users\\Professional\\.gemini\\antigravity');
