const fs = require('fs');

const css = `
/* Делаем фон вокруг документа серым (как в Google Docs) */
.superdoc-workspace-wrapper {
    background-color: #f3f4f6 !important;
}

.dk .superdoc-workspace-wrapper {
    background-color: var(--bg-app, #1e1e1e) !important;
}

/* Принудительно центрируем сам белый лист внутри рабочей зоны */
.superdoc-workspace-wrapper .ProseMirror,
.superdoc-workspace-wrapper [contenteditable="true"],
.superdoc-workspace-wrapper .sd-page,
.superdoc-workspace-wrapper .superdoc-document {
    margin-left: auto !important;
    margin-right: auto !important;
    background-color: var(--bg-editor, #ffffff) !important;
    /* Добавляем легкую тень, чтобы он выглядел как реальный лист А4 */
    box-shadow: 0 2px 10px rgba(0,0,0,0.1) !important;
}

/* Если движок оборачивает лист в дополнительный скролл-контейнер */
.superdoc-workspace-wrapper > div > div {
    display: flex;
    flex-direction: column;
    align-items: center;
}
`;

fs.appendFileSync('src/ide-styles.css', '\n' + css);
console.log('Appended CSS to ide-styles.css');
