const fs = require('fs');
let code = fs.readFileSync('src/App.jsx', 'utf8');

// Left Panel replacement
const oldLeft = `<div style={isMobile
          ? {position:'fixed',top:0,left:48,bottom:0,width:'min(360px, calc(100vw - 60px))',background:'var(--bg-panel)',borderRight:'1px solid var(--border)',transform:leftOpen?'translateX(0)':'translateX(-110%)',transition:'transform .25s ease',zIndex:1100,boxShadow:leftOpen?'4px 0 24px rgba(0,0,0,.25)':'none',overflow:'hidden'}
          : {width:leftOpen?leftW:0,flexShrink:0,overflow:'hidden',borderRight:leftOpen?'1px solid var(--border)':'none',transition:'width .3s ease-in-out'}}>
          {leftOpen && <LeftPanel mode={sideMode} actPanel={actPanel} onClose={()=>{setLeftOpen(false);setActPanel(null)}} onCtx={(x,y,items)=>setCtxMenu({x,y,items})} onToast={addToast} onOpenFile={name=>handleAction('openFile',name)} fsHandle={fsHandle} fsFiles={fsFiles} onOpenFolder={openFolder} onPickFile={()=>handleAction('openFromDisk')} onAction={handleAction} tabs={tabs} activeTab={activeTab} onSwitchTab={switchTab} onCloseTab={closeTab} recentFiles={recentFiles}/>}
        </div>
        {leftOpen && !isMobile && <Handle onMD={startDrag('l')}/>}`;

const newLeft = `<div style={isMobile
          ? {position:'fixed',top:0,left:48,bottom:0,width:'min(360px, calc(100vw - 60px))',background:'var(--bg-panel)',borderRight:'1px solid var(--border)',transform:leftOpen?'translateX(0)':'translateX(-110%)',transition:'transform .25s ease',zIndex:1100,boxShadow:leftOpen?'4px 0 24px rgba(0,0,0,.25)':'none',overflow:'hidden'}
          : {position:'absolute',top:0,bottom:0,left:48,zIndex:50,width:leftW,background:'var(--bg-panel)',borderRight:'1px solid var(--border)',transform:leftOpen?'translateX(0)':'translateX(-100%)',transition:'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',boxShadow:leftOpen?'4px 0 24px rgba(0,0,0,0.1)':'none',overflow:'hidden'}}>
          <LeftPanel mode={sideMode} actPanel={actPanel} onClose={()=>{setLeftOpen(false);setActPanel(null)}} onCtx={(x,y,items)=>setCtxMenu({x,y,items})} onToast={addToast} onOpenFile={name=>handleAction('openFile',name)} fsHandle={fsHandle} fsFiles={fsFiles} onOpenFolder={openFolder} onPickFile={()=>handleAction('openFromDisk')} onAction={handleAction} tabs={tabs} activeTab={activeTab} onSwitchTab={switchTab} onCloseTab={closeTab} recentFiles={recentFiles}/>
          {!isMobile && <div style={{position:'absolute',right:0,top:0,bottom:0,width:4,cursor:'col-resize',zIndex:51}} onMouseDown={startDrag('l')} />}
        </div>`;

code = code.replace(oldLeft, newLeft);

// Right Panel replacement
const oldRight = `{rightOpen && !isMobile && <Handle onMD={startDrag('r')}/>}
        {/* RIGHT PANEL — desktop: inline-flex; mobile: fixed overlay */}
        <div style={isMobile
          ? {position:'fixed',top:0,right:0,bottom:0,width:'min(420px, 100vw)',background:'var(--bg-app)',borderLeft:'1px solid var(--border)',transform:rightOpen?'translateX(0)':'translateX(110%)',transition:'transform .25s ease',zIndex:1100,boxShadow:rightOpen?'-4px 0 24px rgba(0,0,0,.25)':'none',overflow:'hidden'}
          : {width:rightOpen?rightW:0,flexShrink:0,overflow:'hidden',background:'var(--bg-app)',borderLeft:rightOpen?'1px solid var(--border)':'none',transition:'width .3s ease-in-out'}}>`;

const newRight = ` {/* RIGHT PANEL — desktop: inline-flex; mobile: fixed overlay */}
        <div style={isMobile
          ? {position:'fixed',top:0,right:0,bottom:0,width:'min(420px, 100vw)',background:'var(--bg-app)',borderLeft:'1px solid var(--border)',transform:rightOpen?'translateX(0)':'translateX(110%)',transition:'transform .25s ease',zIndex:1100,boxShadow:rightOpen?'-4px 0 24px rgba(0,0,0,.25)':'none',overflow:'hidden'}
          : {position:'absolute',top:0,bottom:0,right:0,zIndex:50,width:rightW,background:'var(--bg-app)',borderLeft:'1px solid var(--border)',transform:rightOpen?'translateX(0)':'translateX(100%)',transition:'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',boxShadow:rightOpen?'-4px 0 24px rgba(0,0,0,0.1)':'none',overflow:'hidden'}}>
          {!isMobile && <div style={{position:'absolute',left:0,top:0,bottom:0,width:4,cursor:'col-resize',zIndex:51}} onMouseDown={startDrag('r')} />}`;

code = code.replace(oldRight, newRight);

// Notice: In the old right panel, `{rightOpen && !isMobile && <Handle onMD={startDrag('r')}/>}` was outside.
// I placed the resize drag area inside the right wrapper.

fs.writeFileSync('src/App.jsx', code);
console.log('Layout Thrashing fixed with absolute positioning!');
