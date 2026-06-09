const fs = require('fs');
let code = fs.readFileSync('src/App.jsx', 'utf8');

// Fix the `null);` syntax error
code = code.replace(/null\);\s*\}/g, 'null; }');

// Also, the keyboard shortcuts for 'k' have:
// if(window.docEngine&&window.docEngine.isFocused){const{from}=window.docEngine.state.selection;const coords=window.docEngine.view.coordsAtPos(from);...
// SuperDoc has no `.state.selection` or `.view.coordsAtPos`! Let's neuter the 'k' shortcut too.
code = code.replace(/if\(window\.docEngine&&window\.docEngine\.isFocused\)\{[\s\S]*?null;?\}/g, '/* shortcut removed */');

fs.writeFileSync('src/App.jsx', code);
console.log('Fixed syntax error and key handlers');
