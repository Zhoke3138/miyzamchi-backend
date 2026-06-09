const fs = require('fs');
const lines = fs.readFileSync('src/App.jsx', 'utf8').split('\n');
const start = lines.findIndex(l => l.includes('import React'));

// Inject exactly one set of imports before import React
const correctImports = [
  "import { SuperDocEditor } from '@superdoc-dev/react';",
  "import '@superdoc-dev/react/style.css';",
  "import 'superdoc/dist/style.css';"
];

fs.writeFileSync('src/App.jsx', [...correctImports, ...lines.slice(start)].join('\n'));
console.log("Fixed imports");
