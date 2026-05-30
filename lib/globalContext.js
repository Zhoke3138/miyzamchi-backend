// ═══════════════════════════════════════════════════════════════════════
//  lib/globalContext.js
//  Global Context Injection — паспорт документа в embedding + system prompt.
//  Selective Reasoning v2.0  ·  2026-05-30
// ═══════════════════════════════════════════════════════════════════════
//
//  Зачем (см. AGENT_DISPATCHER_REDESIGN.md разд. 1.1 / 2.2):
//   Embedding модель + LLM-агент видят отдельный пункт жалобы и не знают,
//   что это жалоба по уголовному делу. Pinecone тащит "статью 7 Закона о
//   рекламе", агент пишет "нарушений нет" — это RAG-галлюцинация.
//
//   Фикс: к КАЖДОМУ поисковому запросу и системному промпту приклеиваем
//   structured "паспорт" документа: summary, отрасль, ожидаемые НПА.
//
//  Контракт shape:
//   type DocumentContext = {
//       summary:    string,           // обязательно
//       docType?:   string,           // 'complaint' | 'contract' | ...
//       branchHint?: string,          // 'criminal' | 'civil' | ...
//       npaHints?:  string[]          // ['Конвенция против пыток', ...]
//   }
//
//  API:
//   injectGlobalContext(text, docContext) → string
//      Префикс [Контекст документа: {summary}] для embedding/Pinecone.
//
//   buildContextualSystemPrompt(basePrompt, docContext) → string
//      Добавляет верхний блок с типом/отраслью/НПА в system prompt.
//
//   isValidContext(ctx) → boolean
//      Проверка shape. Используется для тестов и fallback-логики.
//
//   normalizeContext(input) → DocumentContext | null
//      Принимает строку (старый API) или объект. Возвращает объект
//      или null. Для backwards-compat с `docContextStr`.
// ═══════════════════════════════════════════════════════════════════════

const MAX_SUMMARY_CHARS = 300;
const MAX_NPA_HINT_CHARS = 80;
const MAX_NPA_HINTS = 8;

function isValidContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return false;
    if (typeof ctx.summary !== 'string' || ctx.summary.trim().length === 0) return false;
    return true;
}

function sanitizeSummary(s) {
    return String(s || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_SUMMARY_CHARS);
}

function sanitizeNpaHints(list) {
    if (!Array.isArray(list)) return [];
    return list
        .filter(s => typeof s === 'string' && s.trim().length > 0)
        .map(s => s.trim().slice(0, MAX_NPA_HINT_CHARS))
        .slice(0, MAX_NPA_HINTS);
}

/**
 * normalizeContext — принимает разные форматы паспорта и приводит к shape.
 * Полезно для совместимости с устаревшим `docContextStr: string`.
 */
function normalizeContext(input) {
    if (!input) return null;
    if (typeof input === 'string') {
        const s = sanitizeSummary(input);
        return s ? { summary: s } : null;
    }
    if (typeof input === 'object') {
        const summary = sanitizeSummary(input.summary);
        if (!summary) return null;
        const out = { summary };
        if (typeof input.docType === 'string' && input.docType.trim()) {
            out.docType = input.docType.trim().slice(0, 50);
        }
        if (typeof input.branchHint === 'string' && input.branchHint.trim()) {
            out.branchHint = input.branchHint.trim().slice(0, 100);
        }
        const npa = sanitizeNpaHints(input.npaHints);
        if (npa.length) out.npaHints = npa;
        return out;
    }
    return null;
}

/**
 * injectGlobalContext — префикс для текста перед embedding.
 *
 * Сдвигает embedding-вектор в сторону "правильной" отрасли в Pinecone.
 * Если ctx нет — возвращает оригинальный текст без изменений (lossless).
 */
function injectGlobalContext(text, docContext) {
    const ctx = normalizeContext(docContext);
    if (!ctx) return String(text || '');
    return `[Контекст документа: ${ctx.summary}] ${String(text || '')}`;
}

/**
 * buildContextualSystemPrompt — добавляет блок паспорта к system prompt.
 *
 * Не изменяет basePrompt — только добавляет префикс. Если ctx нет —
 * возвращает basePrompt без изменений.
 *
 * Формат блока:
 *   🔴 ТИП ДОКУМЕНТА: <summary>
 *   🔴 ОТРАСЛЬ ПРАВА: <branchHint>. Если в RAG попали НПА из ДРУГОЙ
 *      отрасли — это false positive: status="warning", ...
 *   🟢 ОЖИДАЕМЫЕ НПА: <hint1>, <hint2>, ...
 */
function buildContextualSystemPrompt(basePrompt, docContext) {
    const ctx = normalizeContext(docContext);
    if (!ctx) return String(basePrompt || '');
    const parts = [];
    parts.push(`🔴 ТИП ДОКУМЕНТА: ${ctx.summary}`);
    if (ctx.branchHint) {
        parts.push(`🔴 ОТРАСЛЬ ПРАВА: ${ctx.branchHint}. Если в RAG-результатах попали НПА из ДРУГОЙ отрасли — это false positive: status="warning", в rationale прямо укажи что отрасль не та.`);
    }
    if (ctx.npaHints && ctx.npaHints.length > 0) {
        parts.push(`🟢 ОЖИДАЕМЫЕ НПА: ${ctx.npaHints.join(', ')}.`);
    }
    return parts.join('\n') + '\n\n' + String(basePrompt || '');
}

module.exports = {
    injectGlobalContext,
    buildContextualSystemPrompt,
    isValidContext,
    normalizeContext,
    MAX_SUMMARY_CHARS,
    MAX_NPA_HINT_CHARS,
    MAX_NPA_HINTS
};
