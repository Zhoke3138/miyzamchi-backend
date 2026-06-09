const fs = require('fs');

let css = fs.readFileSync('src/ide-styles.css', 'utf8');

// 1. Remove myz-doc-ruler
const rulerPattern = /\\/\\* Декоративная линейка \\*\\/[\\s\\S]*?\\.myz-doc-ruler[\\s\\S]*?\\}/g;
css = css.replace(rulerPattern, '');

// 2. Add toolbar flex-wrap
const toolbarCss = `
/* Делаем тулбар адаптивным */
.superdoc-workspace-wrapper [class*="toolbar"],
.superdoc-workspace-wrapper [class*="menubar"] {
    flex-wrap: wrap !important;
    justify-content: flex-start !important;
    height: auto !important;
    min-height: 40px;
    padding-bottom: 5px;
}
`;

fs.writeFileSync('src/ide-styles.css', css + '\\n' + toolbarCss);
console.log('Ruler removed and toolbar flex-wrap added.');
