// ═══════════════════════════════════════════════════════════════════════
//  lib/segmentRegex.js
//  Deterministic JS-сегментация документа — Фаза 2 рефакторинга
//  Selective Reasoning v2.0
// ═══════════════════════════════════════════════════════════════════════
//
//  Заменяет LLM-сегментацию (которая ела ~63с по holdout-тестам).
//  Полностью синхронная, predictable, без сетевых вызовов.
//
//  Алгоритм:
//   1. Greedy Merge: split по \n\n → если параграф НЕ начинается с
//      юридического маркера (Статья, Глава, 1., 1.1 и т.д.) → клеим
//      его к предыдущему чанку через \n\n.
//   2. Safe Fallback: чанки > MAX_CHUNK_LEN_CHARS режем по концам
//      предложений, игнорируя сокращения (ст., п., ч., КР, г., т.д., ...).
//   3. Hard Fallback: если и после safe-split чанк ещё длинный — режем
//      по переносам строк, а в крайнем случае по символам (warn в
//      telemetry — это сигнал что документ — кривой скан).
//
//  Контракт: input → одна строка (предполагается уже после normalizeText).
//             output → string[] (массив чанков, индекс = chunk_index).
// ═══════════════════════════════════════════════════════════════════════

const MAX_CHUNK_LEN_CHARS = 3000;

// ── Маркеры начала нового чанка ─────────────────────────────────────────
// Один комбинированный regex с флагом m (multiline). Тестируем только
// на ПЕРВОЙ строке параграфа, поэтому ^...
//
// Покрытие:
//   1.        — нумерованные пункты (включая 1.1, 2.3.4 — \d+\. матчит начало)
//   Статья N  — кодексы
//   Глава N   — крупные блоки кодекса
//   Часть N / Части N — части документа/договора
//   Раздел N  — на будущее
//   § N       — параграфы (немецкий стиль, иногда в КР встречается)
//   N) или N) — буквенные/цифровые списки (например "1)" в кодексах)
const MARKER_RE = /^\s*(?:\d+[.)]|§\s*\d+|Стать[яеи]\s+\d+|Глава\s+\d+|Част[ьи]\s+\d+|Раздел\s+\d+)/u;

function startsWithMarker(paragraph) {
    if (!paragraph) return false;
    const firstLine = paragraph.split('\n', 1)[0];
    return MARKER_RE.test(firstLine);
}

// ── Список юридических сокращений (lowercase, без точки) ────────────────
// Используется в sentenceSplit чтобы не резать на "ст. 123" / "п. 4" / "КР."
// Это не исчерпывающий список — добавляем по мере обнаружения проблем.
const ABBREVS = new Set([
    'ст', 'стт',       // статья(и)
    'п', 'пп',         // пункт(ы)
    'ч', 'чч',         // часть(и)
    'абз',             // абзац
    'г', 'гг',         // год / города
    'т',               // том
    'тыс', 'млн', 'млрд',
    'руб', 'сом',
    'см',              // смотри
    'напр',            // например
    'проч',            // прочее
    'др',              // другое
    'рис', 'табл',
    'кр',              // Кыргызская Республика
    'рф', 'рк',        // соседи (на случай ссылок)
    'и', 'или',        // редко, но "т. и т.п." сюда не попадёт
    'мр', 'мс',        // господин / госпожа
    'мин', 'макс',
    'ул', 'пр', 'пер'  // улица / проспект / переулок
]);

// ── Разбиение чанка по концам предложений с учётом сокращений ───────────
// Возвращает массив "предложений" (строк с трейлинг-пробелом сепаратора).
function sentenceSplit(text) {
    const sentences = [];
    let start = 0;
    // Ищем "[.!?]+ <whitespace> <Большая буква>" — кандидаты на конец предложения.
    const re = /[.!?]+\s+(?=[А-ЯЁA-Z])/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        // Слово непосредственно перед знаком пунктуации
        const before = text.slice(0, m.index);
        const lastWordMatch = before.match(/([А-Яа-яЁёA-Za-z]+)\s*$/);
        const lastWord = (lastWordMatch ? lastWordMatch[1] : '').toLowerCase();
        if (ABBREVS.has(lastWord)) {
            continue; // "ст. " — не конец предложения, идём дальше
        }
        const cutAt = m.index + m[0].length;
        sentences.push(text.slice(start, cutAt));
        start = cutAt;
    }
    if (start < text.length) {
        sentences.push(text.slice(start));
    }
    return sentences;
}

// ── Жёсткий fallback: режем по \n, потом по символам ────────────────────
function hardSplit(chunk, maxLen, telemetry) {
    if (telemetry?.incrementCounter) {
        telemetry.incrementCounter('segment_hard_split_warnings');
    }
    const lines = chunk.split('\n');
    const result = [];
    let buf = '';
    for (const ln of lines) {
        const candidate = buf ? buf + '\n' + ln : ln;
        if (candidate.length > maxLen && buf) {
            result.push(buf);
            buf = ln;
        } else {
            buf = candidate;
        }
    }
    if (buf) result.push(buf);
    // Если ОДНА строка всё ещё больше maxLen — режем по символам
    const finalResult = [];
    for (const c of result) {
        if (c.length <= maxLen) {
            finalResult.push(c);
        } else {
            for (let i = 0; i < c.length; i += maxLen) {
                finalResult.push(c.slice(i, i + maxLen));
            }
        }
    }
    return finalResult;
}

// ── Safe Fallback: режем длинный чанк через sentenceSplit, потом hard если надо
function safeSplitLongChunk(chunk, maxLen, telemetry) {
    if (chunk.length <= maxLen) return [chunk];

    const sentences = sentenceSplit(chunk);
    // Greedy merge sentences до maxLen
    const result = [];
    let buf = '';
    for (const s of sentences) {
        const candidate = buf + s;
        if (candidate.length > maxLen && buf) {
            result.push(buf);
            buf = s;
        } else {
            buf = candidate;
        }
    }
    if (buf) result.push(buf);

    // Если sentenceSplit не справился (одно гигантское "предложение" без точек —
    // частый кейс OCR со сканов) — каждая такая часть идёт в hardSplit.
    const finalResult = [];
    for (const c of result) {
        if (c.length <= maxLen) {
            finalResult.push(c);
        } else {
            finalResult.push(...hardSplit(c, maxLen, telemetry));
        }
    }
    return finalResult;
}

// ── Главная функция — Greedy Merge + Safe Fallback ──────────────────────
function segmentDocumentRegex(text, opts = {}) {
    const {
        maxChunkLen = MAX_CHUNK_LEN_CHARS,
        telemetry = null
    } = opts;

    if (!text || typeof text !== 'string') return [];
    const trimmed = text.trim();
    if (!trimmed) return [];

    // Полагается на normalizeText: \n\n — единственная граница абзаца.
    // Но на всякий случай поддерживаем 1+ перенос (defensive).
    const paragraphs = trimmed.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    if (paragraphs.length === 0) return [];

    // Greedy Merge
    const merged = [];
    let current = null;
    for (const p of paragraphs) {
        if (current === null) {
            current = p;
            continue;
        }
        if (startsWithMarker(p)) {
            merged.push(current);
            current = p;
        } else {
            current = current + '\n\n' + p;
        }
    }
    if (current !== null) merged.push(current);

    // Safe Fallback для длинных чанков
    const chunks = [];
    for (const c of merged) {
        if (c.length <= maxChunkLen) {
            chunks.push(c);
        } else {
            chunks.push(...safeSplitLongChunk(c, maxChunkLen, telemetry));
        }
    }

    return chunks;
}

// ═══════════════════════════════════════════════════════════════════════
//  wrapAsAnalyzeSegments
//  Адаптер: string[] → [{id, number, heading, text}] для downstream-кода
//  routes/analyze.js (runTriage, verifySegmentsSmart, emitSafeTriageRows).
//
//  ⚡ Phase 4 UX-fix (2026-05-26):
//   Раньше пытались выдрать `number` из маркера ("Часть 5" → "5"). На
//   документах БЕЗ нумерованного списка (жалобы, постановления) это давало
//   дубликаты — два разных чанка получали один и тот же `number="1"` и в
//   таблице фронта появлялось "п.1" несколько раз.
//
//   Решение: всегда строгая порядковая нумерация (`String(i + 1)`).
//   Семантика чанка несётся в `heading` и `text`, а `number` — это просто
//   идентификатор для UX (юрист видит "седьмой пункт документа").
// ═══════════════════════════════════════════════════════════════════════
function wrapAsAnalyzeSegments(rawChunks) {
    if (!Array.isArray(rawChunks)) return [];
    return rawChunks.map((text, i) => {
        const firstLine = String(text || '').split('\n', 1)[0].trim();
        return {
            id: `seg_${i}`,
            number: String(i + 1),
            heading: firstLine.slice(0, 120),
            text: String(text || '')
        };
    });
}

module.exports = {
    segmentDocumentRegex,
    wrapAsAnalyzeSegments,
    // Экспортируем helpers для возможных юнит-тестов / отладки
    _internal: {
        startsWithMarker,
        sentenceSplit,
        safeSplitLongChunk,
        hardSplit,
        MARKER_RE,
        ABBREVS,
        MAX_CHUNK_LEN_CHARS
    }
};
