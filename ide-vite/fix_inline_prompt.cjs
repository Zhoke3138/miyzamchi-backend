const fs = require('fs');
let code = fs.readFileSync('src/App.jsx', 'utf8');

// Remove inlinePrompt state
code = code.replace(/const\s*\[inlinePrompt,\s*setInlinePrompt\]\s*=\s*useState\([^)]*\);\n?/g, '');

// Remove inlinePrompt rendering block completely
// It looks like: {inlinePrompt.visible && inlinePrompt.rect && ( <div ... > ... </div> )}
// Let's just neuter it by replacing `{inlinePrompt.visible` with `{false && inlinePrompt.visible`
// But wait, inlinePrompt is undefined now! So evaluating inlinePrompt.visible will crash.
// We must replace `{inlinePrompt.visible &&` with `{false &&` safely.
// Or just regex replace the whole block if possible.
// Actually, it's easier to just initialize inlinePrompt to a dummy state so it doesn't crash, but never renders.
// Let's add the state back as a dummy:
// const [inlinePrompt, setInlinePrompt] = useState({visible: false});

code = code.replace(/\{inlinePrompt\.visible && inlinePrompt\.rect && \([\s\S]*?\n\s*\)\}/, '{/* inlinePrompt removed */}');

// Also there might be references to setInlinePrompt in other places, like editor keydown handlers!
// We should replace setInlinePrompt with a dummy function.
code = code.replace(/setInlinePrompt\([^)]*\)/g, 'null');

fs.writeFileSync('src/App.jsx', code);
console.log('Fixed inlinePrompt');
