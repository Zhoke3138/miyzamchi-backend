const fs = require('fs');
let code = fs.readFileSync('src/App.jsx', 'utf8');

// 1. Remove editorAdapter definition
code = code.replace(/const editorAdapter = \{[\s\S]*?\n\};\n\n/m, '');

// 2. Remove insertIntoQuill definition
code = code.replace(/const insertIntoQuill=\([\s\S]*?\n\};\n\n/m, '');

// 3. Remove getDocSnapshot definition
code = code.replace(/const getDocSnapshot=\(\)=>\{[\s\S]*?\n\};\n\n/m, 'const getDocSnapshot=()=>({text:"",selection:"",hasSelection:false});\n\n');

// 4. Remove MagicWandTooltip definition
code = code.replace(/const MagicWandTooltip = \(\{[\s\S]*?\n\};\n\n/m, '');

// 5. Remove MagicWandTooltip usage
code = code.replace(/<MagicWandTooltip[^>]*\/>/g, '');

// 6. Replace editorAdapter usages
code = code.replace(/editorAdapter\.isReady\(\)/g, '(!!window.docEngine)');
code = code.replace(/editorAdapter\.getHTML\(\)/g, '""');
code = code.replace(/editorAdapter\.getText\(\)/g, '""');
code = code.replace(/editorAdapter\.getSelectionInfo\(\)/g, "({text:'',selection:'',hasSelection:false})");
code = code.replace(/editorAdapter\.setHTML\([^)]*\)/g, '/* setHTML removed */');
code = code.replace(/editorAdapter\.insertAtEnd\([^)]*\)/g, '/* insertAtEnd removed */');
code = code.replace(/editorAdapter\.insertSmart\([^)]*\)/g, 'true /* insertSmart removed */');
code = code.replace(/editorAdapter\.replaceSelection\([^)]*\)/g, 'true /* replaceSelection removed */');
code = code.replace(/editorAdapter\.replaceAll\([^)]*\)/g, '/* replaceAll removed */');
code = code.replace(/editorAdapter\.insertAtCursor\([^)]*\)/g, '/* insertAtCursor removed */');

// 7. Replace EditorComp usage
const editorCompRegex = /<EditorComp tabs=\{tabs\}[^>]*\/>/g;
const superDocCall = `<SuperDocEditor file={tabs.find(t=>t.id===activeTab)?.buffer ? new Blob([tabs.find(t=>t.id===activeTab)?.buffer]) : null} documentMode="editing" onReady={(e)=>window.docEngine=e.superdoc} />`;
code = code.replace(editorCompRegex, superDocCall);

// 8. Replace AIEditor and AIEditorTipTap if they exist anywhere else
code = code.replace(/<AIEditorTipTap[^>]*\/>/g, '');
code = code.replace(/<AIEditor[^>]*\/>/g, '');

// 9. Remove USE_TIPTAP
code = code.replace(/const USE_TIPTAP = true;\n?/g, '');
code = code.replace(/if\s*\(USE_TIPTAP\)\s*\{[\s\S]*?\}\s*else\s*\{[\s\S]*?\}/g, '/* USE_TIPTAP block removed */');
code = code.replace(/USE_TIPTAP\s*\?\s*[^:]+\s*:\s*([^;]+);/g, '$1;');

fs.writeFileSync('src/App.jsx', code);
console.log('App.jsx cleaned up!');
