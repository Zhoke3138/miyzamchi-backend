const fs = require('fs');
let code = fs.readFileSync('src/App.jsx', 'utf8');

// Replace switchTab
code = code.replace(/const switchTab=useCallback\(\(newId\)=>\{[\s\S]*?setActiveTab\(newId\);\n\s*setTabs\(p=>\{[\s\S]*?\},10\);\n\s*return next;\n\s*\}\);\n\s*\}\,\[activeTab\]\);/m, 
`const switchTab = useCallback((newId) => {
    if(activeTab === newId) return;
    // Removed old editorAdapter content reading/writing
    setActiveTab(newId);
  }, [activeTab]);`);

// Actually the regex above might be brittle. Let's just use string replacement on the exact `switchTab` block.
// Let's check `switchTab` block.
