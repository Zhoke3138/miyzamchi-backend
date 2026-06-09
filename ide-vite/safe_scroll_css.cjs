const fs = require('fs');

let css = fs.readFileSync('src/ide-styles.css', 'utf8');

// 1. Remove myz-doc-ruler and old toolbar wrap
const toxicPattern = /\\/\\* Делаем тулбар адаптивным \\*\\/[\\s\\S]*?\\.superdoc-workspace-wrapper \\[class\\*="menubar"\\] \\{[\\s\\S]*?\\}/g;
css = css.replace(toxicPattern, '');

// 2. Add new safe scrolling CSS
const safeScrollCss = `
/* Возвращаем тулбару нативное отображение и добавляем скрытый скролл */
.superdoc-workspace-wrapper .ProseMirror-menubar,
.superdoc-workspace-wrapper .sd-toolbar,
.superdoc-workspace-wrapper .superdoc-toolbar {
    overflow-x: auto !important;
    overflow-y: hidden !important;
    flex-wrap: nowrap !important;
    white-space: nowrap;
    
    /* Скрываем скроллбар для Firefox и IE/Edge */
    scrollbar-width: none !important;
    -ms-overflow-style: none !important;
}

/* Скрываем скроллбар для Chrome, Safari и Opera */
.superdoc-workspace-wrapper .ProseMirror-menubar::-webkit-scrollbar,
.superdoc-workspace-wrapper .sd-toolbar::-webkit-scrollbar,
.superdoc-workspace-wrapper .superdoc-toolbar::-webkit-scrollbar {
    display: none !important;
}
`;

fs.writeFileSync('src/ide-styles.css', css + '\\n' + safeScrollCss);
console.log('Safe scroll CSS applied and toxic CSS removed.');
