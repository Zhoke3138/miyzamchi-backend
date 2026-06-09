const fs = require('fs');
let code = fs.readFileSync('src/App.jsx', 'utf8');

if (code.includes("import 'superdoc/dist/style.css';")) {
    code = code.replace("import 'superdoc/dist/style.css';\n", "");
    code = code.replace("import 'superdoc/dist/style.css';", "");
    fs.writeFileSync('src/App.jsx', code);
    console.log('Removed bad superdoc style import.');
} else {
    console.log('Import not found.');
}
