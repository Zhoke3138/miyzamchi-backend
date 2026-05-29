// ═══════════════════════════════════════════════════════════════════════
//  lib/smartSkipPhase3.js
//  Smart-skip эвристика для Phase 3 (Issue Splitter + Adaptive RAG).
//  Selective Reasoning v2.0 — оптимизация на основе данных test_corpus/.
// ═══════════════════════════════════════════════════════════════════════
//
//  Зачем: Phase 3 — это ~24с накладных расходов (Splitter + Pinecone).
//  На жалобах/исках/возражениях с явными ссылками на статьи Phase 3
//  даёт точный RAG и улучшает качество. На коммерческих договорах /
//  расписках / соглашениях без явных "ст. N" Splitter извлекает 0
//  citations и Phase 3 становится пустой работой — 24с потеряны зря.
//
//  Решение: до запуска Phase 3 проверяем документ на наличие явных
//  citation-маркеров. Если их совсем мало — skip Phase 3, Ищейки уходят
//  в legacy путь (адаптивный Pinecone-поиск внутри агентов).
//
//  Данные test_corpus/ (16 непустых документов, прогнаны 2026-05-27):
//   ✓ Phase 3 нужна:      жалобы, иски, возражения, претензии с НПА
//                          (avg 5-18 citations на документ)
//   ✗ Phase 3 бесполезна:  договоры, расписки, соглашения о расторжении,
//                          типовые претензии (0-1 citation на документ)
//   → 56% документов корпуса можно skip → экономия ~24с на каждом
//
//  Контракт graceful-degradation: если эвристика SKIPit Phase 3, это
//  идентично сценарию "Phase 3 вернул 0 citations". Ищейки готовы к
//  такому случаю — у них есть fallback на собственный Pinecone-поиск.
// ═══════════════════════════════════════════════════════════════════════

// Минимальное число "явных" citations для запуска Phase 3.
// Меньше — skip (документ генерический, Phase 3 даст 0 пользы).
// Подобрано по test_corpus/: документы с 2+ citations всегда выигрывают
// от Phase 3, с 0-1 — нет.
const MIN_CITATIONS_FOR_PHASE3 = 2;

// ── Citation-паттерны: что считаем "явной ссылкой на статью НПА" ────────
// Флаги: g (подсчёт всех совпадений) + i (регистр) + m (multiline для ^).
// БЕЗ \b — у JS regex `\b` работает по ASCII word chars и не ставится
// на границе кириллической буквы и пробела/знака → ложно отрицает.
// Используем явное (?:^|[пробельные/пунктуация]) для левой границы.
const CITATION_PATTERNS = [
    // "ст. 14" / "ст.14" / "ст 14" — короткая форма
    /(?:^|[\s,;.()«»"])ст\.?\s*\d+/gim,
    // "статья 14" / "статьи 14" / "статьей 14" / "статьёй 14" / "статьями 14" / "статьею 14"
    /стать(?:я|и|е|ю|ей|ёй|ею|ями)\s+\d+/gi,
    // "часть N статьи M" / "Часть N, статьи M" / "Части 1, 3, 5 и 6, статьи 59"
    /част[ьи]\s+\d+(?:\s*,\s*\d+)*(?:\s+и\s+\d+)?\s*,?\s*стать(?:я|и|е|ю|ей|ёй|ею|ями)\s+\d+/gi,
    // "пункт 1 статьи 7" / "пунктом 5 статьи 12"
    /пункт[ауеом]*\s+\d+\s+стать(?:я|и|е|ю|ей|ёй|ею|ями)\s+\d+/gi,
    // "статьями 7, 10, 11, 222, 296" — исковой перечень (≥3 номера через запятую)
    /стать(?:ями|ей|ёй)\s+\d+(?:\s*,\s*\d+){2,}/gi,
];

/**
 * countCitations — считает число "явных" citation-маркеров в тексте.
 * Используется для решения skip/keep Phase 3 и в smoke-тестах.
 *
 * @param {string} text — нормализованный текст документа
 * @returns {number} — приблизительное число явных ссылок на статьи
 */
function countCitations(text) {
    if (!text || typeof text !== 'string') return 0;
    let total = 0;
    for (const re of CITATION_PATTERNS) {
        const m = text.match(re);
        if (m) total += m.length;
    }
    return total;
}

/**
 * shouldRunPhase3 — главный решатель.
 *
 * @param {string} text — нормализованный текст документа
 * @param {object} [opts]
 * @param {number} [opts.minCitations=MIN_CITATIONS_FOR_PHASE3] — порог
 * @returns {{ run: boolean, citationCount: number, reason: string }}
 *   run: true → Phase 3 запускаем
 *   run: false → skip, Ищейки уйдут в legacy путь
 *   reason: человекочитаемая причина (для логов и SSE-step text)
 */
function shouldRunPhase3(text, opts = {}) {
    const minCitations = opts.minCitations ?? MIN_CITATIONS_FOR_PHASE3;
    const citationCount = countCitations(text);
    if (citationCount >= minCitations) {
        return {
            run: true,
            citationCount,
            reason: `найдено ≈${citationCount} явных ссылок на статьи → точный RAG через Phase 3`
        };
    }
    return {
        run: false,
        citationCount,
        reason: citationCount === 0
            ? 'документ не содержит явных ссылок на статьи НПА → анализ через базовый RAG'
            : `мало явных ссылок (≈${citationCount}) → базовый RAG быстрее без потери качества`
    };
}

module.exports = {
    shouldRunPhase3,
    countCitations,
    MIN_CITATIONS_FOR_PHASE3,
    _internal: { CITATION_PATTERNS }
};
