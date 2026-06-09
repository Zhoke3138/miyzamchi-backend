const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'src', 'App.jsx');
const lines = fs.readFileSync(file, 'utf8').split('\n');

let newLines = [];
let skip = false;

// We will skip AIEditorTipTap and AIEditor
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  if (line.startsWith('const AIEditorTipTap =')) {
    skip = true;
  }
  if (line.startsWith('const AIEditor =')) {
    skip = true;
  }

  if (skip && line === '};') {
    skip = false;
    continue; // skip the closing bracket too
  }

  if (!skip) {
    newLines.push(line);
  }
}

fs.writeFileSync(file, newLines.join('\n'));
console.log('Done stripping AIEditorTipTap and AIEditor');
