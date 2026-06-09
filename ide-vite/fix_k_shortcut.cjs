const fs = require('fs');
let code = fs.readFileSync('src/App.jsx', 'utf8');

code = code.replace(/if\(m&&e\.key\.toLowerCase\(\)==='k'\)\{[\s\S]*?if\(e\.key==='Escape'\)/, "/* k shortcut removed */ if(e.key==='Escape')");

fs.writeFileSync('src/App.jsx', code);
console.log('Fixed k shortcut');
