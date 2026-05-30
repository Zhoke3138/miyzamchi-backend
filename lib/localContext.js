// ═══════════════════════════════════════════════════════════════════════
//  lib/localContext.js
//  Sticky Local Context — fix "Orphan Chunks" RAG-галлюцинаций.
//  Selective Reasoning v2.0  ·  2026-05-30
// ═══════════════════════════════════════════════════════════════════════
//
//  Проблема: смартчанкинг разбивает документ так, что упоминание кодекса
//  остаётся в предыдущем блоке, а текущий блок («в частности, статья 330
//  и 331») приходит к агенту голым. Pinecone тянет "Статья 330" из любого
//  НПА (Закон о рекламе, Воздушный кодекс) → агент пишет ерунду.
//
//  Решение: один проход по chunks с двумя sticky-памятями:
//    • currentSection — последний section heading
//    • currentNpa     — последнее ключевое упоминание НПА
//  Каждый chunk наследует значения из предыдущего, если не переопределил
//  своими данными. В runtime инжектится в embedding query И system prompt.
//
//  Контракт shape:
//   LocalContext = { section?: string, npa?: string }
//
//  API:
//   extractSectionHeading(text) → string|null
//   extractNpaMentions(text)    → string[]   (canonical names, по порядку)
//   buildChunkContexts(chunks)  → LocalContext[]   (parallel с chunks)
//   injectLocalContext(text, globalCtx, localCtx) → string  (embedding)
//   buildLocalContextBlock(localCtx) → string  (для system prompt)
// ═══════════════════════════════════════════════════════════════════════

const MAX_SECTION_LEN  = 100;
const MAX_NPA_NAME_LEN = 80;

// ── Heading-эвристика (та же что в segmentRegex.classifyLine) ──────────
// Section heading: короткое, без терминала, начинается с заглавной,
// ≤ 10 слов, не начинается с цифры/буллита, не содержит ":".
function extractSectionHeading(chunkText) {
    if (!chunkText || typeof chunkText !== 'string') return null;
    const firstLine = chunkText.split('\n', 1)[0].trim();
    if (!firstLine || firstLine.length >= 80) return null;
    if (/[.!?:;,]$/.test(firstLine)) return null;
    if (firstLine.includes(':'))     return null;
    if (!/^[А-ЯЁA-Z]/u.test(firstLine)) return null;
    if (/^\d/.test(firstLine))          return null;
    if (/^[-–—•]/u.test(firstLine))     return null;
    const wordCount = firstLine.split(/\s+/).length;
    if (wordCount > 10) return null;
    return firstLine.slice(0, MAX_SECTION_LEN);
}

// ── NPA-паттерны (канонические имена кыргызского законодательства) ─────
// Порядок важен: более специфичные (УПК) ДО более общих (УК), чтобы
// "Уголовно-процессуального кодекса" не матчился сначала на "Уголовного".
const NPA_PATTERNS = [
    // Процессуальные кодексы — должны проверяться ПЕРЕД материальными
    { canonical: 'УПК КР',                       re: /Уголовно-процессуальн(?:ого|ому|ом|ый|ая|ом)?\s+кодекс[ауеом]*|УПК\s+КР/giu },
    { canonical: 'ГПК КР',                       re: /Гражданск(?:ого|ому|ий|им)?\s+процессуальн(?:ого|ому|ом|ый)?\s+кодекс[ауеом]*|ГПК\s+КР/giu },
    { canonical: 'АПК КР',                       re: /Арбитражн(?:ого|ому|ый)?\s+процессуальн(?:ого|ому)?\s+кодекс[ауеом]*|АПК\s+КР/giu },

    // Материальные кодексы.
    // ВАЖНО: \b в JS regex работает только с ASCII word chars и НЕ ставится
    // на границе кириллической буквы и пробела. Поэтому "УК КР" + любой
    // следующий пробел не матчится через \b. Используем explicit negative
    // lookahead `(?![А-Яа-яЁё])` чтобы предотвратить ложный match внутри
    // "УК КРЫМа" (другое слово).
    { canonical: 'Уголовный кодекс КР',          re: /Уголовн(?:ого|ому|ом|ый|ая)?\s+кодекс[ауеом]*\s+(?:КР|Кыргызской)|УК\s+КР(?![А-Яа-яЁё])|УК\s+Кыргызстана/giu },
    { canonical: 'Гражданский кодекс КР',        re: /Гражданск(?:ого|ому|ом|ий|ая)?\s+кодекс[ауеом]*\s+(?:КР|Кыргызской)|ГК\s+КР(?![А-Яа-яЁё])|ГК\s+Кыргызстана/giu },
    { canonical: 'Трудовой кодекс КР',           re: /Трудов(?:ого|ому|ом|ой|ая)?\s+кодекс[ауеом]*|ТК\s+КР(?![А-Яа-яЁё])/giu },
    { canonical: 'Налоговый кодекс КР',          re: /Налогов(?:ого|ому|ом|ый|ая)?\s+кодекс[ауеом]*|НК\s+КР(?![А-Яа-яЁё])/giu },
    { canonical: 'Семейный кодекс КР',           re: /Семейн(?:ого|ому|ом|ый|ая)?\s+кодекс[ауеом]*|СК\s+КР(?![А-Яа-яЁё])/giu },
    { canonical: 'Земельный кодекс КР',          re: /Земельн(?:ого|ому|ом|ый|ая)?\s+кодекс[ауеом]*/giu },
    { canonical: 'Жилищный кодекс КР',           re: /Жилищн(?:ого|ому|ом|ый|ая)?\s+кодекс[ауеом]*/giu },
    { canonical: 'Кодекс о нарушениях КР',       re: /Кодекс[ауеом]*\s+(?:КР\s+)?о\s+(?:административных\s+)?(?:право)?нарушениях/giu },

    // Конституция
    { canonical: 'Конституция КР',               re: /Конституци[еийю]\s+(?:Кыргызской\s+Республики|КР|Кыргызстана)|Конституци[еийю]\b/giu },

    // Международные акты
    { canonical: 'Конвенция против пыток (ООН)', re: /Конвенци[еийю]\s+против\s+пыток|Конвенци[еийю]\s+ООН\s+против\s+пыток/giu },
    { canonical: 'МПГПП',                        re: /Международн(?:ого|ому|ом|ый)?\s+пакт[ауеом]*\s+о\s+гражданских\s+и\s+политических\s+правах|МПГПП/giu },
    { canonical: 'МПЭСКП',                       re: /Международн(?:ого|ому)?\s+пакт[ауеом]*\s+об\s+экономических|МПЭСКП/giu },
    { canonical: 'ЕКПЧ',                         re: /Европейск(?:ой|ою)?\s+конвенци[еийю][^.]{0,80}прав[ауеом]*\s+человека|ЕКПЧ(?![А-Яа-яЁё])/giu },

    // Ключевые отраслевые законы
    { canonical: 'Закон о защите прав потребителей КР',           re: /Закон[ауеом]*[^.]{0,40}о\s+защите\s+прав\s+потребителей/giu },
    { canonical: 'Закон о государственной службе КР',             re: /Закон[ауеом]*[^.]{0,40}о\s+государственн(?:ой|ою)?\s+(?:гражданск(?:ой|ою)?\s+)?службе/giu },
    { canonical: 'Закон о банках и банковской деятельности КР',   re: /Закон[ауеом]*[^.]{0,40}о\s+банках/giu },
];

function _stripVolatileRegexState(re) { try { re.lastIndex = 0; } catch (_) {} }

/**
 * extractNpaMentions — возвращает массив канонических имён НПА,
 * упомянутых в тексте. Порядок появления НЕ в тексте, а по приоритету
 * паттернов (специфичные → общие). Уникальные.
 */
function extractNpaMentions(text) {
    if (!text || typeof text !== 'string') return [];
    const found = [];
    const seen = new Set();
    for (const p of NPA_PATTERNS) {
        _stripVolatileRegexState(p.re);
        if (p.re.test(text)) {
            if (!seen.has(p.canonical)) {
                seen.add(p.canonical);
                found.push(p.canonical);
            }
        }
        _stripVolatileRegexState(p.re);
    }
    return found;
}

/**
 * buildChunkContexts — главный sticky-проход по массиву чанков.
 * Возвращает массив LocalContext[] параллельный chunks[].
 *
 * Sticky-правила:
 *   • currentSection — обновляется когда первая строка чанка выглядит
 *     как heading (extractSectionHeading возвращает не-null).
 *   • currentNpa — обновляется когда в тексте чанка найдено ЯВНОЕ
 *     упоминание любого НПА. Берём ПЕРВОЕ из NPA_PATTERNS (приоритет).
 *   • Если ни первое, ни второе не обновлены — наследуем оба.
 *   • Если currentNpa установлен, а в текущем чанке другой кодекс
 *     явно упомянут — переопределяем (контекст сменился).
 */
function buildChunkContexts(chunks) {
    if (!Array.isArray(chunks) || chunks.length === 0) return [];
    let currentSection = null;
    let currentNpa     = null;
    const out = new Array(chunks.length);
    for (let i = 0; i < chunks.length; i++) {
        const chunkText = String(chunks[i] || '');
        const section   = extractSectionHeading(chunkText);
        if (section) currentSection = section;
        const npas = extractNpaMentions(chunkText);
        if (npas.length > 0) {
            // Берём ПЕРВЫЙ matched (по приоритету паттернов).
            currentNpa = npas[0];
        }
        out[i] = {
            section: currentSection || null,
            npa:     currentNpa     || null
        };
    }
    return out;
}

/**
 * injectLocalContext — префикс для текста перед embedding.
 * Формат:
 *   [Контекст документа: <global.summary>] [Раздел: <section>] [Кодекс: <npa>] <text>
 *
 * Если globalCtx / localCtx нет — соответствующие блоки пропускаются.
 * Lossless: оригинальный text всегда в хвосте без изменений.
 */
function injectLocalContext(text, globalCtx, localCtx) {
    const parts = [];
    if (globalCtx && globalCtx.summary) {
        parts.push(`[Контекст документа: ${String(globalCtx.summary).slice(0, 200)}]`);
    }
    if (localCtx && localCtx.section) {
        parts.push(`[Раздел: ${String(localCtx.section).slice(0, MAX_SECTION_LEN)}]`);
    }
    if (localCtx && localCtx.npa) {
        parts.push(`[Кодекс: ${String(localCtx.npa).slice(0, MAX_NPA_NAME_LEN)}]`);
    }
    const prefix = parts.length ? parts.join(' ') + ' ' : '';
    return prefix + String(text || '');
}

/**
 * buildLocalContextBlock — блок для system prompt агента.
 *
 *   🟡 ТЕКУЩИЙ РАЗДЕЛ: <section>
 *   🟡 КОДЕКС РАЗДЕЛА: <npa> — приоритезируй его в RAG.
 *
 * Если localCtx пуст — возвращает пустую строку (caller сам решит куда
 * вставить и нужен ли разделитель).
 */
function buildLocalContextBlock(localCtx) {
    if (!localCtx) return '';
    const lines = [];
    if (localCtx.section) {
        lines.push(`🟡 ТЕКУЩИЙ РАЗДЕЛ: ${String(localCtx.section).slice(0, MAX_SECTION_LEN)}`);
    }
    if (localCtx.npa) {
        lines.push(`🟡 КОДЕКС РАЗДЕЛА: ${String(localCtx.npa).slice(0, MAX_NPA_NAME_LEN)}. Приоритезируй статьи именно этого НПА при выборе из RAG-результатов. Статьи с тем же номером из других кодексов — false positive: status="warning".`);
    }
    return lines.join('\n');
}

module.exports = {
    extractSectionHeading,
    extractNpaMentions,
    buildChunkContexts,
    injectLocalContext,
    buildLocalContextBlock,
    NPA_PATTERNS,
    MAX_SECTION_LEN,
    MAX_NPA_NAME_LEN
};
