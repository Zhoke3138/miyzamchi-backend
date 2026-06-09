const fs = require('fs');

const cssToAppend = `
/* Типографика (TNR 12pt по умолчанию) */
.superdoc-workspace-wrapper .ProseMirror,
.superdoc-workspace-wrapper [contenteditable="true"],
.superdoc-workspace-wrapper .sd-page {
    font-family: 'Times New Roman', serif !important; 
    font-size: 12pt !important; 
    line-height: 1.5 !important;
}

/* Декоративная линейка */
.myz-doc-ruler {
    width: 100%;
    height: 14px;
    background-color: var(--bg-panel, #f3f4f6);
    background-image: repeating-linear-gradient(90deg, transparent, transparent 49px, var(--border) 49px, var(--border) 50px),
                      repeating-linear-gradient(90deg, transparent, transparent 9px, rgba(128,128,128,0.2) 9px, rgba(128,128,128,0.2) 10px);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
}
`;

fs.appendFileSync('src/ide-styles.css', '\n' + cssToAppend);
console.log('Appended CSS to ide-styles.css');
