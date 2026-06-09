const fs = require('fs');
let code = fs.readFileSync('src/App.jsx', 'utf8');

code = code.replace(/const StatusBar=\(\{dark,tabCount,unsaved,activeName\}\)=>\{[\s\S]*?return \(\s*<div[\s\S]*?<\/div>\s*\);\s*\};/m, 
`const StatusBar=({dark,tabCount,unsaved,activeName})=>{
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

fs.writeFileSync('src/App.jsx', code);
console.log('Fixed StatusBar');
