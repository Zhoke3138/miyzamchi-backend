const fs = require('fs');
let code = fs.readFileSync('src/App.jsx', 'utf8');

// 1. Update ResizeObserver with debounce
const oldObserver = `useEffect(() => {
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
  }, []);`;

const newObserver = `useEffect(() => {
    const el = document.getElementById('superdoc-wrapper');
    if (!el) return;
    let timeoutId = null;
    const observer = new ResizeObserver(() => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
        if (window.docEngine && typeof window.docEngine.layout === 'function') {
          window.docEngine.layout();
        }
      }, 80); // 80ms debounce for smoother resizing
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, []);`;

code = code.replace(oldObserver, newObserver);


// 2. Remove transition from superdoc-wrapper
const oldWrapperStart = `<div id="superdoc-wrapper" className="superdoc-workspace-wrapper" style={{ flex: 1, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflowY: 'auto', transition: 'all 0.3s ease-in-out' }}>`;
const newWrapperStart = `<div id="superdoc-wrapper" className="superdoc-workspace-wrapper" style={{ flex: 1, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>`;

code = code.replace(oldWrapperStart, newWrapperStart);


// 3. Wrap SuperDocEditor in useMemo
const oldEditor = `<SuperDocEditor 
            key={\`\${activeTab}_\${tabs.find(t=>t.id===activeTab)?.buffer?.byteLength || 0}\`}
            document={(() => {
              const currentTab = tabs.find(t => t.id === activeTab);
              const isValidDocx = currentTab?.buffer && currentTab.buffer instanceof ArrayBuffer;
              return isValidDocx ? new Blob([currentTab.buffer]) : null;
            })()} 
            documentMode="editing" 
            onReady={(e)=>window.docEngine=e.superdoc} 
          />`;

const newEditor = `{useMemo(() => {
            const currentTab = tabs.find(t => t.id === activeTab);
            const isValidDocx = currentTab?.buffer && currentTab.buffer instanceof ArrayBuffer;
            const docFile = isValidDocx ? new Blob([currentTab.buffer]) : null;
            return (
              <SuperDocEditor 
                key={\`\${activeTab}_\${currentTab?.buffer?.byteLength || 0}\`}
                document={docFile} 
                documentMode="editing" 
                onReady={(e) => { window.docEngine = e.superdoc; }} 
              />
            );
          }, [activeTab, tabs.find(t => t.id === activeTab)?.buffer])}`;

code = code.replace(oldEditor, newEditor);

fs.writeFileSync('src/App.jsx', code);
console.log('Performance optimizations applied!');
