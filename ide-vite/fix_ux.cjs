const fs = require('fs');
let code = fs.readFileSync('src/App.jsx', 'utf8');

// 1. Add smooth transitions to the panels
code = code.replace(/transition:'width \.2s ease-in-out'/g, "transition:'width .3s ease-in-out'");

// 2. Add id and transition to SuperDocEditor wrapper
code = code.replace(/<div style=\{\{ flex: 1, width: '100%', height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column' \}\}>/g, 
  `<div id="superdoc-wrapper" style={{ flex: 1, width: '100%', height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column', transition: 'all 0.3s ease-in-out' }}>`);

// 3. Make key ultra-reactive
code = code.replace(/key=\{activeTab\}/g, "key={`${activeTab}_${tabs.find(t=>t.id===activeTab)?.buffer?.byteLength || 0}`}");

// 4. Inject ResizeObserver
const resizeEffect = `
  useEffect(() => {
    const el = document.getElementById('superdoc-wrapper');
    if (!el) return;
    const observer = new ResizeObserver(() => {
      window.dispatchEvent(new Event('resize'));
      if (window.docEngine && typeof window.docEngine.layout === 'function') {
        window.docEngine.layout();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
`;

// Inject right before `return(` (we know the code has `const unsavedCount=tabs.filter(t=>t.mod).length;` right before it)
code = code.replace(/const unsavedCount=tabs\.filter\(t=>t\.mod\)\.length;\s*return\(/m, 
  `const unsavedCount=tabs.filter(t=>t.mod).length;\n${resizeEffect}\n  return(`);

fs.writeFileSync('src/App.jsx', code);
console.log('Fixed UX issues!');
