const fs = require('fs');

// Re-run the deterministic build to get a clean slate from LegacyApp.jsx
const lines = fs.readFileSync('src/LegacyApp.jsx', 'utf8').split(/\r?\n/);
let out = [];

let skip = false;

for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!skip) {
        if (line.startsWith('const editorAdapter = {')) {
            skip = true;
        } else if (line.startsWith('const insertIntoQuill=')) {
            skip = true;
        } else if (line.startsWith('const getDocSnapshot=')) {
            skip = true;
            out.push('const getDocSnapshot=()=>({text:"",selection:"",hasSelection:false});');
        } else if (line.startsWith('const AIEditorTipTap =')) {
            skip = true;
        } else if (line.startsWith('const AIEditor =')) {
            skip = true;
        } else if (line.startsWith('const EditorComp=')) {
            skip = true;
        } else if (line.startsWith('const MagicWandTooltip =')) {
            skip = true;
        } else if (line.startsWith('const USE_TIPTAP =')) {
            continue; // skip
        } else if (line.includes('<MagicWandTooltip')) {
            continue; // skip
        } else if (line.includes('<EditorComp')) {
            out.push(line.replace(/<EditorComp[^>]*\/>/g, '<SuperDocEditor file={tabs.find(t=>t.id===activeTab)?.buffer ? new Blob([tabs.find(t=>t.id===activeTab)?.buffer]) : null} documentMode="editing" onReady={(e)=>window.docEngine=e.superdoc} />'));
        } else {
            let l = line;
            
            // Neutering inline prompt
            l = l.replace(/const\s*\[inlinePrompt,\s*setInlinePrompt\]\s*=\s*useState\([^)]*\);\n?/g, '');
            l = l.replace(/\{inlinePrompt\.visible && inlinePrompt\.rect && \([\s\S]*?\n\s*\)\}/, '{/* inlinePrompt */}');
            // Safely remove setInlinePrompt calls
            l = l.replace(/setInlinePrompt\([^;]*\);?/g, '/* setInlinePrompt */');

            // Neutering editorAdapter usages
            l = l.replace(/editorAdapter\.isReady\(\)/g, '(!!window.docEngine)');
            l = l.replace(/editorAdapter\.getHTML\(\)/g, '""');
            l = l.replace(/editorAdapter\.getText\(\)/g, '""');
            l = l.replace(/editorAdapter\.getSelectionInfo\(\)/g, "({text:'',selection:'',hasSelection:false})");
            l = l.replace(/editorAdapter\.setHTML\([^)]*\)/g, 'null');
            l = l.replace(/editorAdapter\.insertAtEnd\([^)]*\)/g, 'null');
            l = l.replace(/editorAdapter\.insertSmart\([^)]*\)/g, 'true');
            l = l.replace(/editorAdapter\.replaceSelection\([^)]*\)/g, 'true');
            l = l.replace(/editorAdapter\.replaceAll\([^)]*\)/g, 'null');
            l = l.replace(/editorAdapter\.insertAtCursor\([^)]*\)/g, 'null');
            
            // Fix oxc
            l = l.replace(/className=\{'btn'\+\(listening\?' mic-listening':''\)\}/g, "className={`btn ${listening ? 'mic-listening' : ''}`}");
            
            // Handle USE_TIPTAP
            if (l.includes('USE_TIPTAP')) {
                l = l.replace(/USE_TIPTAP\s*\?\s*([^:]+)\s*:\s*([^;,\)}]+)/g, '$1');
                l = l.replace(/\bUSE_TIPTAP\b/g, 'true');
            }

            // Hoisting states
            if (l.startsWith('  const[npaCollapsed,setNpaCollapsed]=useState(false);const[chatCollapsed,setChatCollapsed]=useState(false);')) {
                out.push(l);
                out.push(`  const[leftOpen,setLeftOpen]=useState(true);const[rightOpen,setRightOpen]=useState(true);const[splitActive,setSplitActive]=useState(false);`);
                out.push(`  const[actPanel,setActPanel]=useState('law');const[hilite,setHilite]=useState(null);`);
                continue;
            }
            if (l.startsWith('  const[leftOpen,setLeftOpen]=useState(true);const[rightOpen,setRightOpen]=useState(true);const[splitActive,setSplitActive]=useState(false);')) {
                continue;
            }
            if (l.startsWith("  const[actPanel,setActPanel]=useState('law');const[hilite,setHilite]=useState(null);")) {
                continue;
            }
            if (l.startsWith("import './tiptap-setup.js';")) {
                continue;
            }

            // Neuter StatusBar
            if (l.includes('const StatusBar=({dark,tabCount,unsaved,activeName})=>{')) {
                skip = true;
                out.push(`const StatusBar=({dark,tabCount,unsaved,activeName})=>{
  return (
    <div style={{height:24,flexShrink:0,background:dark?'var(--bg-panel)':'var(--primary)',borderTop:dark?'1px solid var(--border-color)':'none',display:'flex',alignItems:'center',justifyContent:'space-between',padding:'0 var(--s-3)',fontSize:'var(--text-xs)',userSelect:'none',color:dark?'var(--text-muted)':'#ffffff',transition:'background-color .3s, color .3s, border-color .3s',fontFamily:'var(--font-sans)'}}>
      <div style={{display:'flex',alignItems:'center',gap:'var(--s-3h)'}}>
        <span style={{display:'flex',alignItems:'center',gap:'var(--s-1h)'}}><StatusDot/><span className={dark?'gt':undefined} style={{fontWeight:500}}>Подключено</span></span>
        <span style={{opacity:.65}}>Вкладок: {tabCount||0}{unsaved>0 && <span style={{color:dark?'var(--orange)':'#fff',fontWeight:600}}> · {unsaved} •</span>}</span>
        {activeName && <span style={{opacity:.6,fontFamily:'var(--font-mono)',maxWidth:280,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{activeName}</span>}
      </div>
      <div style={{display:'flex',alignItems:'center',gap:'var(--s-3h)'}}>
        <span style={{display:'flex',alignItems:'center',gap:'var(--s-1)'}}><Ico k="zap" sz={12} col={dark?'var(--accent)':'rgba(255,255,255,.7)'} grad={dark} glow={dark}/>Gemini Flash</span>
      </div>
    </div>
  );
};`);
            } else {
                out.push(l);
            }
        }
    } else {
        if (line === '};' || (line.startsWith('};') && !line.includes('} else {'))) {
            // we should be careful with StatusBar ending. StatusBar ends at '};'
            skip = false;
        }
    }
}

let finalCode = out.join('\n');
finalCode = `import { SuperDocEditor } from '@superdoc-dev/react';\nimport '@superdoc-dev/react/style.css';\n` + finalCode;

// Remove the keyboard 'k' shortcut that uses window.docEngine.state
finalCode = finalCode.replace(/if\(window\.docEngine&&window\.docEngine\.isFocused\)\{[\s\S]*?\}/g, '/* removed k shortcut */');

// Remove inlinePrompt rendering block from finalCode
finalCode = finalCode.replace(/\{inlinePrompt\.visible && inlinePrompt\.rect && \([\s\S]*?<\/div>\s*\)\}/g, '{/* inlinePrompt */}');

// Since inlinePrompt state is removed, inlinePrompt object is undefined.
// Any if (inlinePrompt...) will throw.
// Let's replace `inlinePrompt.` with `({}).` globally to avoid crash.
finalCode = finalCode.replace(/inlinePrompt\./g, '({}).');

fs.writeFileSync('src/App.jsx', finalCode);
console.log('Successfully rebuilt App.jsx!');
