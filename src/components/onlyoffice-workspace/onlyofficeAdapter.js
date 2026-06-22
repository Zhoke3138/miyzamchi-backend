// ═══════════════════════════════════════════════════════════════════
// onlyofficeAdapter.js — Адаптер команд агента для ONLYOFFICE
// Этап 2 миграции: мосты от старых window.docEngine.* вызовов
// к ONLYOFFICE Plugin SDK (window.Asc.plugin.callCommand).
//
// Использование (из плагина или боковой панели):
//   import { adapter } from './onlyofficeAdapter.js';
//   const text = await adapter.getSelectedText();
//   await adapter.insertText('Новый текст');
//   await adapter.addComment('Риск: нарушение ст. 142 ГК КР', 'Мыйзамчы AI');
// ═══════════════════════════════════════════════════════════════════

'use strict';

// ── Вспомогательная: оборачивает callCommand в Promise ─────────────
// ONLYOFFICE Plugin SDK использует callback-стиль, мы конвертируем в async/await.
function pluginCommand(fn, keepCallback = false) {
    return new Promise((resolve, reject) => {
        if (!window.Asc?.plugin?.callCommand) {
            reject(new Error('[OO Adapter] window.Asc.plugin.callCommand недоступен. Адаптер работает только внутри ONLYOFFICE-плагина.'));
            return;
        }
        window.Asc.plugin.callCommand(fn, keepCallback, (result) => resolve(result));
    });
}

// ─── ЧТЕНИЕ ────────────────────────────────────────────────────────

/**
 * Получить выделенный юристом текст из документа.
 * Эквивалент: window.docEngine.doc.selection.current()
 *
 * @returns {Promise<string>} — выделенный текст или '' если нет выделения
 */
async function getSelectedText() {
    return pluginCommand(function () {
        var oDoc   = Api.GetDocument();
        var oRange = oDoc.GetRangeBySelect();
        return oRange ? oRange.GetText() : '';
    });
}

/**
 * Получить весь текст документа (для анализа).
 * Эквивалент: window.docEngine.doc.getText({})
 *
 * @returns {Promise<string>}
 */
async function getDocumentText() {
    return pluginCommand(function () {
        var oDoc = Api.GetDocument();
        var text = '';
        var count = oDoc.GetElementsCount();
        for (var i = 0; i < count; i++) {
            var el = oDoc.GetElement(i);
            if (el && el.GetText) text += el.GetText() + '\n';
        }
        return text.trim();
    });
}

// ─── ЗАПИСЬ ────────────────────────────────────────────────────────

/**
 * Заменить выделенный текст на сгенерированный ИИ ответ.
 * Эквивалент: applyAgentCommand({ type: 'replace', ... })
 *
 * @param {string} newText
 * @returns {Promise<void>}
 */
async function insertText(newText) {
    const captured = String(newText);
    return pluginCommand(function () {
        var oDoc   = Api.GetDocument();
        var oRange = oDoc.GetRangeBySelect();
        if (oRange) {
            oRange.SetText(captured);
        } else {
            // Курсор без выделения — вставляем в текущую позицию
            var oPara = Api.CreateParagraph();
            oPara.AddText(captured);
            oDoc.Push(oPara);
        }
    });
}

/**
 * Добавить комментарий к выделенному тексту (режим аудита).
 * Эквивалент: applyAgentCommand({ type: 'comment', ... })
 *
 * @param {string} commentText
 * @param {string} [author='Мыйзамчы AI']
 * @returns {Promise<void>}
 */
async function addComment(commentText, author) {
    const capturedText   = String(commentText);
    const capturedAuthor = String(author || 'Мыйзамчы AI');
    return pluginCommand(function () {
        var oDoc   = Api.GetDocument();
        var oRange = oDoc.GetRangeBySelect();
        if (oRange) {
            oRange.AddComment(capturedText, capturedAuthor);
        }
    });
}

/**
 * Добавить комментарий к тексту по точному совпадению строки.
 * Используется при разметке рисков из /api/analyze-document:
 *   risks.forEach(r => annotateByText(r.fragment, r.risk, 'Мыйзамчы AI'));
 *
 * @param {string} searchText  — текст который нужно найти в документе
 * @param {string} commentText — текст комментария
 * @param {string} [author]
 * @returns {Promise<boolean>} — true если нашли и разметили
 */
async function annotateByText(searchText, commentText, author) {
    const capturedSearch  = String(searchText).slice(0, 500);
    const capturedComment = String(commentText);
    const capturedAuthor  = String(author || 'Мыйзамчы AI');

    return pluginCommand(function () {
        var oDoc   = Api.GetDocument();
        var oSearch = oDoc.Search(capturedSearch);
        if (!oSearch || oSearch.length === 0) return false;
        oSearch[0].AddComment(capturedComment, capturedAuthor);
        return true;
    });
}

// ─── ИСТОРИЯ ───────────────────────────────────────────────────────

/** Эквивалент: window.docEngine.commands.undo() */
async function undo() {
    return pluginCommand(function () {
        Api.Undo();
    });
}

/** Эквивалент: window.docEngine.commands.redo() */
async function redo() {
    return pluginCommand(function () {
        Api.Redo();
    });
}

// ─── УТИЛИТЫ ──────────────────────────────────────────────────────

/**
 * Проверить доступность Plugin API (вызывать перед использованием адаптера).
 * @returns {boolean}
 */
function isAvailable() {
    return !!(window.Asc?.plugin?.callCommand);
}

/**
 * Получить информацию о документе (имя, тип).
 * @returns {Promise<{title: string, fileType: string}>}
 */
async function getDocumentInfo() {
    return pluginCommand(function () {
        return {
            title:    Api.GetDocument().GetName?.() || '',
            fileType: 'docx'
        };
    });
}

// ─── Экспорт ──────────────────────────────────────────────────────
export const adapter = {
    // Чтение
    getSelectedText,
    getDocumentText,
    getDocumentInfo,
    // Запись
    insertText,
    addComment,
    annotateByText,
    // История
    undo,
    redo,
    // Утилиты
    isAvailable,
};

export default adapter;
