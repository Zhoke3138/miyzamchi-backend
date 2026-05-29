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
// Расширенный набор (после баг-репорта 2026-05-27 по жалобе в ООН).
// Тестируем на ПЕРВОЙ строке параграфа (флаг u для unicode).
//
// Покрытие:
//   1. / 1)        — нумерованные пункты и подпункты (включая 1.1.1, 2.3.4)
//   Статья N       — кодексы (склонения: Статья/Статьи/Статье)
//   Глава N        — крупные блоки кодекса
//   Часть N        — части документа (склонения: Часть/Части/Частью)
//   Раздел N       — разделы
//   § N            — параграфы (немецкий стиль)
//   а) / б) / в)   — буквенные списки (кириллица одной буквой)
//   - / — / •      — тире и буллит-маркеры (Word-стиль)
//   статья N / пункт N — НИЖНИМ регистром в списках жалоб/исков
//                        (типичный паттерн "статья 1 — запрет пыток")
const MARKER_RE = /^\s*(?:\d+[.)]|\d+\.\d+|§\s*\d+|Стать[яеи]\s+\d+|стать[яеи]\s+\d+|пункт[ауеом]*\s+\d+|Глав[аыу]\s+\d+|Част[ьии]\s+\d+|Раздел[ауы]?\s+\d+|[а-яё]\)|[-—–]\s+\S|•\s+\S)/u;

function startsWithMarker(paragraph) {
    if (!paragraph) return false;
    const firstLine = paragraph.split('\n', 1)[0];
    return MARKER_RE.test(firstLine);
}

// Проверка для ОТДЕЛЬНОЙ строки (не первой строки параграфа).
// Используется в split-by-markers внутри длинных параграфов.
function isMarkerLine(line) {
    if (!line) return false;
    return MARKER_RE.test(line);
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

// ── Line-level split: режем по маркер-строкам внутри одного "параграфа" ──
// Используется когда документ сохранён без двойных переносов (типичный
// случай Word → TXT) и весь текст слипся в один блок. Каждая строка-маркер
// (Статья / 1./ - / • / "статья N") открывает новый чанк, не-маркер строки
// склеиваются к ближайшему маркеру выше через \n.
//
// Lossless: контракт — сумма длин выходных чанков (без \n-сепараторов)
// равна длине входа. Тестируется в smoke-тесте.
function splitParagraphByMarkers(paragraph) {
    const lines = paragraph.split('\n');
    if (lines.length === 0) return [];

    const chunks = [];
    let current = [];

    for (const line of lines) {
        const trimmedLine = line.trim();
        const isMarker = isMarkerLine(line);

        if (current.length === 0) {
            // Первая строка — открывает первый чанк (даже если не маркер: преамбула)
            current.push(line);
        } else if (isMarker) {
            // Маркер → закрываем текущий, открываем новый
            chunks.push(current.join('\n'));
            current = [line];
        } else {
            // Не маркер → продолжаем текущий
            current.push(line);
        }
    }
    if (current.length > 0) chunks.push(current.join('\n'));

    return chunks
        .map(c => c.trim())
        .filter(c => c.length > 0);
}

// ── Главная функция: два уровня сегментации + safe fallback ──────────────
//
// Уровень 1: split по \n{2,} (двойные переносы = граница абзаца).
//   Это работает для документов с нормальной разметкой (договоры).
//
// Уровень 2: внутри каждого блока — split по маркер-строкам.
//   Это нужно для документов из Word → TXT, где между абзацами стоит
//   одиночный \n, и весь документ внешне выглядит как один блок.
//
// Уровень 3 (fallback): если чанк всё ещё >MAX_CHUNK_LEN, режем по
// предложениям с защитой от сокращений.
//
// Lossless invariant: ни один значимый символ не должен потеряться.
function segmentDocumentRegex(text, opts = {}) {
    const {
        maxChunkLen = MAX_CHUNK_LEN_CHARS,
        telemetry = null
    } = opts;

    if (!text || typeof text !== 'string') return [];
    const trimmed = text.trim();
    if (!trimmed) return [];

    // Уровень 1: split по двойным переносам.
    const paragraphs = trimmed.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    if (paragraphs.length === 0) return [];

    // Уровень 2: внутри каждого "параграфа" режем по маркер-строкам.
    // Это вытаскивает структуру из слипшихся документов Word → TXT.
    const subBlocks = [];
    for (const p of paragraphs) {
        const subs = splitParagraphByMarkers(p);
        subBlocks.push(...subs);
    }

    // Уровень 3 (safe fallback): любой чанк длиннее maxChunkLen режем по
    // предложениям с защитой от сокращений. Это редкий путь — большинство
    // чанков уже разумного размера после уровней 1-2.
    const chunks = [];
    for (const c of subBlocks) {
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
        isMarkerLine,
        splitParagraphByMarkers,
        sentenceSplit,
        safeSplitLongChunk,
        hardSplit,
        MARKER_RE,
        ABBREVS,
        MAX_CHUNK_LEN_CHARS
    }
};
