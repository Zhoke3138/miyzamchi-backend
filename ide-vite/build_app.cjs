const fs = require('fs');

const lines = fs.readFileSync('src/LegacyApp.jsx', 'utf8').split(/\r?\n/);
let out = [];

let skip = false;
let skipBlock = '';

for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!skip) {
        if (line.startsWith('const editorAdapter = {')) {
            skip = true; skipBlock = 'editorAdapter';
        } else if (line.startsWith('const insertIntoQuill=')) {
            skip = true; skipBlock = 'insertIntoQuill';
        } else if (line.startsWith('const getDocSnapshot=')) {
            skip = true; skipBlock = 'getDocSnapshot';
            out.push('const getDocSnapshot=()=>({text:"",selection:"",hasSelection:false});');
        } else if (line.startsWith('const AIEditorTipTap =')) {
            skip = true; skipBlock = 'AIEditorTipTap';
        } else if (line.startsWith('const AIEditor =')) {
            skip = true; skipBlock = 'AIEditor';
        } else if (line.startsWith('const EditorComp=')) {
            skip = true; skipBlock = 'EditorComp';
        } else if (line.startsWith('const MagicWandTooltip =')) {
            skip = true; skipBlock = 'MagicWandTooltip';
        } else if (line.startsWith('const USE_TIPTAP =')) {
            continue; // skip the line
        } else if (line.includes('<MagicWandTooltip')) {
            continue; // skip rendering
        } else if (line.includes('<EditorComp')) {
            out.push(line.replace(/<EditorComp[^>]*\/>/g, '<SuperDocEditor file={tabs.find(t=>t.id===activeTab)?.buffer ? new Blob([tabs.find(t=>t.id===activeTab)?.buffer]) : null} documentMode="editing" onReady={(e)=>window.docEngine=e.superdoc} />'));
        } else {
            // Replace editorAdapter usages
            let l = line;
            l = l.replace(/editorAdapter\.isReady\(\)/g, '(!!window.docEngine)');
            l = l.replace(/editorAdapter\.getHTML\(\)/g, '""');
            l = l.replace(/editorAdapter\.getText\(\)/g, '""');
            l = l.replace(/editorAdapter\.getSelectionInfo\(\)/g, "({text:'',selection:'',hasSelection:false})");
            l = l.replace(/editorAdapter\.setHTML\([^)]*\)/g, 'null /* setHTML removed */');
            l = l.replace(/editorAdapter\.insertAtEnd\([^)]*\)/g, 'null /* insertAtEnd removed */');
            l = l.replace(/editorAdapter\.insertSmart\([^)]*\)/g, 'true /* insertSmart removed */');
            l = l.replace(/editorAdapter\.replaceSelection\([^)]*\)/g, 'true /* replaceSelection removed */');
            l = l.replace(/editorAdapter\.replaceAll\([^)]*\)/g, 'null /* replaceAll removed */');
            l = l.replace(/editorAdapter\.insertAtCursor\([^)]*\)/g, 'null /* insertAtCursor removed */');
            
            // Fix the oxc parse error
            l = l.replace(/className=\{'btn'\+\(listening\?' mic-listening':''\)\}/g, "className={`btn ${listening ? 'mic-listening' : ''}`}");
            
            // Remove USE_TIPTAP inline expressions
            if (l.includes('USE_TIPTAP')) {
                // If it's a ternary `USE_TIPTAP ? A : B`, replace with just `A`
                l = l.replace(/USE_TIPTAP\s*\?\s*([^:]+)\s*:\s*([^;,\)}]+)/g, '$1');
                
                // If it's `if (USE_TIPTAP)` block... it's harder, but mostly used in handleAction.
                // We'll just replace the string USE_TIPTAP with true so JS evaluates it!
                l = l.replace(/\bUSE_TIPTAP\b/g, 'true');
            }

            // Hoist states to avoid TDZ (around line 8737 originally, now around 7891)
            if (l.startsWith('  const[npaCollapsed,setNpaCollapsed]=useState(false);const[chatCollapsed,setChatCollapsed]=useState(false);')) {
                out.push(l);
                out.push(`  const[leftOpen,setLeftOpen]=useState(true);const[rightOpen,setRightOpen]=useState(true);const[splitActive,setSplitActive]=useState(false);`);
                out.push(`  const[actPanel,setActPanel]=useState('law');const[hilite,setHilite]=useState(null);`);
                continue;
            }
            if (l.startsWith('  const[leftOpen,setLeftOpen]=useState(true);const[rightOpen,setRightOpen]=useState(true);const[splitActive,setSplitActive]=useState(false);')) {
                continue; // skip original
            }
            if (l.startsWith("  const[actPanel,setActPanel]=useState('law');const[hilite,setHilite]=useState(null);")) {
                continue; // skip original
            }
            if (l.startsWith("import './tiptap-setup.js';")) {
                continue; // skip tiptap setup
            }

            out.push(l);
        }
    } else {
        if (line === '};') {
            skip = false;
        }
    }
}

let finalCode = out.join('\n');
finalCode = `import { SuperDocEditor } from '@superdoc-dev/react';\nimport '@superdoc-dev/react/style.css';\n` + finalCode;

fs.writeFileSync('src/App.jsx', finalCode);
console.log('Successfully rebuilt App.jsx line by line!');
