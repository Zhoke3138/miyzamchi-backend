const fs = require('fs');
let css = fs.readFileSync('src/ide-styles.css', 'utf8');

const rules = `
/* SuperDoc / ProseMirror document centering */
#superdoc-wrapper .ProseMirror,
#superdoc-wrapper .superdoc-page,
#superdoc-wrapper .sd-page {
  margin: 0 auto !important;
}

#superdoc-wrapper {
  background-color: var(--bg-panel, #f3f4f6);
}
.dk #superdoc-wrapper {
  background-color: var(--bg-app, #1e1e1e);
}
`;

if (!css.includes('margin: 0 auto !important;')) {
  fs.appendFileSync('src/ide-styles.css', '\n' + rules);
  console.log('Appended CSS to ide-styles.css');
} else {
  console.log('CSS already has centering rules.');
}
