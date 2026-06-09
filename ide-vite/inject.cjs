const fs = require('fs');
let code = fs.readFileSync('src/App.jsx', 'utf8');

// Replace the editor render line:
code = code.replace(
  `<div style={{flex:1,display:'flex',overflow:'hidden'}}>{USE_TIPTAP ? <AIEditorTipTap onToast={onToast} onCtx={onCtx} /> : <AIEditor onToast={onToast} onCtx={onCtx} />}</div>`,
  `
      <div style={{flex:1,display:'flex',overflow:'hidden'}}>
        <SuperDocEditor 
          file={tabs.find(t=>t.id===active)?.buffer ? new Blob([tabs.find(t=>t.id===active)?.buffer]) : null}
          documentMode="editing"
          onReady={(event) => { window.docEngine = event.superdoc; }}
        />
      </div>
  `
);

// Inject import at the top
code = `import { SuperDocEditor } from '@superdoc-dev/react';
import '@superdoc-dev/react/style.css';
import 'superdoc/dist/style.css';
` + code;

// Hoist state inside App
code = code.replace(
  `  const[leftW,setLeftW]=useState(238);const[rightW,setRightW]=useState(560);const[rightSplit,setRightSplit]=useState(35);\n  const[npaCollapsed,setNpaCollapsed]=useState(false);const[chatCollapsed,setChatCollapsed]=useState(false);`,
  `  const[leftW,setLeftW]=useState(238);const[rightW,setRightW]=useState(560);const[rightSplit,setRightSplit]=useState(35);\n  const[npaCollapsed,setNpaCollapsed]=useState(false);const[chatCollapsed,setChatCollapsed]=useState(false);\n  const[leftOpen,setLeftOpen]=useState(true);const[rightOpen,setRightOpen]=useState(true);const[splitActive,setSplitActive]=useState(false);\n  const[actPanel,setActPanel]=useState('law');const[hilite,setHilite]=useState(null);`
);

code = code.replace(
  `  const[leftOpen,setLeftOpen]=useState(true);const[rightOpen,setRightOpen]=useState(true);const[splitActive,setSplitActive]=useState(false);\n  const[actPanel,setActPanel]=useState('law');const[hilite,setHilite]=useState(null);`,
  `  // moved up`
);

// Disable tiptap setup
code = code.replace(`import './tiptap-setup.js';`, `// import './tiptap-setup.js';`);

fs.writeFileSync('src/App.jsx', code);
console.log('Injected SuperDocEditor correctly.');
