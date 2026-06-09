const fs = require('fs');
let code = fs.readFileSync('src/App.jsx', 'utf8');

const regex = /className=\{['"]btn['"]\s*\+\s*\(\s*listening\s*\?\s*['"]\s*mic-listening['"]\s*:\s*['"]['"]\s*\)\}/g;
const replacement = "className={`btn ${listening ? ' mic-listening' : ''}`}";

let match;
let found = false;
while ((match = regex.exec(code)) !== null) {
    console.log(`Found match at index ${match.index}: ${match[0]}`);
    found = true;
}

if (found) {
    code = code.replace(regex, replacement);
    fs.writeFileSync('src/App.jsx', code);
    console.log('Fixed className concatenation.');
} else {
    console.log('Target regex not found.');
}
