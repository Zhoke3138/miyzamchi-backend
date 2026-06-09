const fs = require('fs');
let code = fs.readFileSync('src/App.jsx', 'utf8');

// 1. Add style and new button
const oldButtonArea = `<style>{\`.btn-new-document { background-color: var(--primary); color: #ffffff; border: none; border-radius: var(--radius-sm); padding: var(--s-2h) var(--s-4); width: calc(100% - var(--s-8)); margin: 0 var(--s-4) var(--s-6) var(--s-4); font-weight: 600; display: flex; align-items: center; justify-content: center; gap: var(--s-2); cursor: pointer; font-size: var(--text-sm); font-family: var(--font-sans); transition: background-color 0.2s ease; } .btn-new-document:hover { background-color: var(--primary-hover); }\`}</style>

      <div style={{padding: 'var(--s-6) var(--s-4) var(--s-3) var(--s-4)', display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
        <div style={{fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.06em'}}>МОИ ФАЙЛЫ</div>
        <button onClick={onClose} style={{background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex'}}><Ico k="x" sz={14}/></button>
      </div>

      <button className="btn-new-document" onClick={()=>onAction('newDoc')}>`;

const newButtonArea = `<style>{\`.btn-new-document { background-color: var(--primary); color: #ffffff; border: none; border-radius: var(--radius-sm); padding: var(--s-2h) var(--s-4); width: calc(100% - var(--s-8)); margin: var(--s-2) var(--s-4) var(--s-6) var(--s-4); font-weight: 600; display: flex; align-items: center; justify-content: center; gap: var(--s-2); cursor: pointer; font-size: var(--text-sm); font-family: var(--font-sans); transition: background-color 0.2s ease; } .btn-new-document:hover { background-color: var(--primary-hover); } .btn-open-document { background-color: transparent; color: var(--text); border: 1px dashed var(--border); border-radius: var(--radius-sm); padding: var(--s-2h) var(--s-4); width: calc(100% - var(--s-8)); margin: 0 var(--s-4) 0 var(--s-4); font-weight: 500; display: flex; align-items: center; justify-content: center; gap: var(--s-2); cursor: pointer; font-size: var(--text-sm); font-family: var(--font-sans); transition: all 0.2s ease; } .btn-open-document:hover { background-color: var(--hover); border-color: var(--text-muted); }\`}</style>

      <div style={{padding: 'var(--s-6) var(--s-4) var(--s-3) var(--s-4)', display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
        <div style={{fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.06em'}}>МОИ ФАЙЛЫ</div>
        <button onClick={onClose} style={{background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex'}}><Ico k="x" sz={14}/></button>
      </div>

      <button className="btn-open-document" onClick={()=>onAction('openFromDisk')}>
        <span style={{fontSize: 14}}>📁</span>
        <span>Открыть документ</span>
      </button>

      <button className="btn-new-document" onClick={()=>onAction('newDoc')}>`;

code = code.replace(oldButtonArea, newButtonArea);

// 2. Remove the small plus button
const oldSmallPlus = `<div style={{padding: '0 var(--s-4)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--s-2)'}}>
        <div style={{fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.06em'}}>ФАЙЛЫ</div>
        <button onClick={() => onAction('openFromDisk')} title="Открыть файл" style={{background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--s-1)'}} onMouseEnter={e=>e.currentTarget.style.color='var(--primary)'} onMouseLeave={e=>e.currentTarget.style.color='var(--muted)'}>
          <Ico k="plus" sz={14} col="currentColor"/>
        </button>
      </div>`;

const newSmallPlus = `<div style={{padding: '0 var(--s-4)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--s-2)'}}>
        <div style={{fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.06em'}}>ФАЙЛЫ</div>
      </div>`;

code = code.replace(oldSmallPlus, newSmallPlus);

fs.writeFileSync('src/App.jsx', code);
console.log('Buttons refactored!');
