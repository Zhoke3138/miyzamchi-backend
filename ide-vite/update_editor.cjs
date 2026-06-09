const fs = require('fs');
let code = fs.readFileSync('src/App.jsx', 'utf8');

const oldEditor = `<SuperDocEditor 
                key={\`\${activeTab}_\${currentTab?.buffer?.byteLength || 0}\`}
                document={docFile} 
                documentMode="editing" 
                onReady={(e) => { window.docEngine = e.superdoc; }} 
              />`;

const newEditor = `<div className="myz-doc-ruler" title="Линейка"></div>
              <SuperDocEditor 
                key={\`\${activeTab}_\${currentTab?.buffer?.byteLength || 0}\`}
                document={docFile} 
                documentMode="editing" 
                fonts={[{ label: 'Times New Roman', key: 'Times New Roman, serif' }]}
                toolbar={{ groups: ['history', 'text', 'paragraph', 'insert', 'list', 'indent', 'font-controls', 'table', 'tools'] }}
                onReady={(e) => { window.docEngine = e.superdoc; }} 
              />`;

code = code.replace(oldEditor, newEditor);

fs.writeFileSync('src/App.jsx', code);
console.log('App.jsx updated with fonts, toolbar, and ruler!');
