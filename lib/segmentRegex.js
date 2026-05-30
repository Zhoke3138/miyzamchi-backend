// ═══════════════════════════════════════════════════════════════════════
//  lib/segmentRegex.js
//  Smart Chunking — Фаза 2 рефакторинга (v3, 2026-05-29)
//  Selective Reasoning v2.0
// ═══════════════════════════════════════════════════════════════════════
//
//  Заменяет LLM-сегментацию (~63с на старом холдоуте). Полностью
//  синхронная, predictable, без сетевых вызовов.
//
//  ── Эволюция логики ────────────────────────────────────────────────────
//
//  v1 (Greedy Merge по \n\n): подходило для договоров, но проваливалось
//   на Word→TXT экспортах без двойных переносов — весь документ слипался
//   в 1-3 гигантских чанка.
//
//  v2 (Split-by-markers на каждой строке): пофиксил Word→TXT, но дал
//   ОВЕР-сегментацию (64 микро-чанка на жалобу Аскарова). Каждый буллит
//   "– статья 7 — запрет пыток" становился отдельным чанком, оторванным
//   от вводного "В части Международного пакта...:". Агенты теряли
//   контекст и искали статью 7 в Гражданском кодексе.
//
//  v3 (Smart Chunking, текущая): СМЫСЛОВЫЕ блоки вместо построчных.
//   - section heading ("Нарушения Конституции КР") — prefix следующего
//     параграфа, не отдельный чанк.
//   - intro:list pattern (параграф заканчивается на ":") — открывает
//     list mode: следующие буллеты / короткие параграфы склеиваются
//     с этим intro в один чанк.
//   - subheading с маркером ("1. Предмет договора." < 35ch) — за ним
//     идёт текст пункта, тоже склеивается.
//   - post-merge мелких соседних блоков (< 100ch) — слипшаяся шапка,
//     адресат, подписи.
//   - safeSplit fallback для чанков > maxChunkLen=3000.
//
//   Контракт lossless: сумма не-whitespace символов на выходе == входе.
//   Тестируется в _smokeTestSegmentRegex.js.
//
//   Контракт wrapAsAnalyzeSegments: string[] → [{id, number, heading,
//   text}]. number = String(i+1) для уникальности (Phase 4 UX-fix).
// ═══════════════════════════════════════════════════════════════════════

const MAX_CHUNK_LEN_CHARS = 3000;
const SOFT_CHUNK_LIMIT     = 1200;   // post-merge cap для шапки/подписей
const SMALL_BLOCK_CHARS    = 100;    // что считаем "мелким" блоком для merge
const SUBHEADING_MAX_CHARS = 35;     // "1. Предмет договора." — да, "Часть 4..." — нет
const COLON_LIST_ITEM_MAX  = 200;    // в list-mode короткий параграф ≤200ch склеивается

// ── Маркер-паттерны ─────────────────────────────────────────────────────
// BULLET_RE: классические буллит-маркеры + типичные "статья N —" в исках.
//   ВАЖНО: "– статья 1 —" (en-dash + tab + статья + em-dash) попадает
//   через первую ветку (буллит-знак + whitespace), не через вторую.
const BULLET_RE = /^(?:[-–—•]\s+|[-–—•]\t|стать(?:я|и|е|ю|ей|ёй|ею|ями)\s+\d+\s*[—–-]\s+|пункт[ауеом]*\s+\d+\s*[—–-]\s+|[а-яё]\)\s+)/u;

// SUBHEADING_MARKER_RE: маркеры пунктов договора, статьи, главы.
//   НЕ включаем "Часть" / "Раздел" — в жалобах "Часть 4, статьи 56 ..."
//   это полноценная норма, не короткий subheading.
const SUBHEADING_MARKER_RE = /^(?:\d+[.)]|\d+\.\d+|Стать[яеи]\s+\d+|Глав[аыу]\s+\d+|§\s*\d+)/u;

// ── Юридические сокращения для sentenceSplit ────────────────────────────
const ABBREVS = new Set([
    'ст', 'стт',  'п', 'пп',  'ч', 'чч',  'абз',
    'г', 'гг',    'т',
    'тыс', 'млн', 'млрд',  'руб', 'сом',
    'см', 'напр', 'проч',  'др',
    'рис', 'табл',
    'кр', 'рф', 'рк',
    'и', 'или',
    'мр', 'мс',
    'мин', 'макс',
    'ул', 'пр', 'пер'
]);

// ── Классификация строки ────────────────────────────────────────────────
//   empty     — пустая (\n\n boundary)
//   bullet    — "– статья 1", "• ...", "- ...", "а) ..."
//   heading   — короткое (< 80ch), без терминальной пунктуации, с заглавной,
//                 ≤10 слов, НЕ начинается с цифры/буллит-маркера
//   paragraph — всё остальное
function classifyLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return { kind: 'empty' };

    if (BULLET_RE.test(trimmed)) return { kind: 'bullet', text: trimmed };

    const wordCount    = trimmed.split(/\s+/).length;
    const noTerminal   = !/[.!?:;,]$/.test(trimmed);
    const startsUpper  = /^[А-ЯЁA-Z]/u.test(trimmed);
    // hasColon: ":" внутри строки = это data-параграф (типа "Заявитель: Иван").
    // Не должно классифицироваться как heading, даже если короткое и без терминала.
    const hasColon     = trimmed.includes(':');
    const looksHeading = trimmed.length < 80
                      && noTerminal
                      && startsUpper
                      && wordCount <= 10
                      && !/^\d/.test(trimmed)
                      && !hasColon
                      && !BULLET_RE.test(trimmed);

    if (looksHeading) return { kind: 'heading', text: trimmed };

    return { kind: 'paragraph', text: trimmed };
}

// ── sentenceSplit с защитой от сокращений ───────────────────────────────
function sentenceSplit(text) {
    const sentences = [];
    let start = 0;
    const re = /[.!?]+\s+(?=[А-ЯЁA-Z])/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const before = text.slice(0, m.index);
        const lastWordMatch = before.match(/([А-Яа-яЁёA-Za-z]+)\s*$/);
        const lastWord = (lastWordMatch ? lastWordMatch[1] : '').toLowerCase();
        if (ABBREVS.has(lastWord)) continue;
        const cutAt = m.index + m[0].length;
        sentences.push(text.slice(start, cutAt));
        start = cutAt;
    }
    if (start < text.length) sentences.push(text.slice(start));
    return sentences;
}

// ── Hard split: режем по \n, потом по символам (для OCR-кейсов) ─────────
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

    const final = [];
    for (const c of result) {
        if (c.length <= maxLen) {
            final.push(c);
        } else {
            for (let i = 0; i < c.length; i += maxLen) {
                final.push(c.slice(i, i + maxLen));
            }
        }
    }
    return final;
}

// ── Safe split: sentence-aware, потом hardSplit для остатков ────────────
function safeSplitLongChunk(chunk, maxLen, telemetry) {
    if (chunk.length <= maxLen) return [chunk];

    const sentences = sentenceSplit(chunk);
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

    const final = [];
    for (const c of result) {
        if (c.length <= maxLen) {
            final.push(c);
        } else {
            final.push(...hardSplit(c, maxLen, telemetry));
        }
    }
    return final;
}

// ── isSubheading: короткий paragraph с маркером, ждёт описания ──────────
// "1. Предмет договора." (20ch, "."), "Статья 1. Основные понятия." (27ch)
// → true. Следующий paragraph склеится с этим в один блок.
//
// "Часть 5, статьи 56 гарантирует..." (50ch) → false (длина >= 35),
// уже полноценная норма.
function isSubheadingParagraph(text) {
    if (text.length >= SUBHEADING_MAX_CHARS) return false;
    if (!/[.:]$/.test(text)) return false;
    return SUBHEADING_MARKER_RE.test(text);
}

// ── Main: smart chunking через element-classification + state machine ───
function segmentDocumentRegex(text, opts = {}) {
    const {
        maxChunkLen = MAX_CHUNK_LEN_CHARS,
        softLimit   = SOFT_CHUNK_LIMIT,
        smallBlock  = SMALL_BLOCK_CHARS,
        telemetry   = null
    } = opts;

    if (!text || typeof text !== 'string') return [];
    const trimmed = text.trim();
    if (!trimmed) return [];

    const lines = trimmed.split('\n');
    const elements = lines.map(classifyLine);

    const blocks = [];
    let current = null;
    let pendingHeading = null;
    // listMode: 'none' | 'colon-pending' | 'short-paragraphs' | 'bullets'
    let listMode = 'none';

    function flush() {
        if (current && current.lines.length > 0) {
            blocks.push(current);
        }
        current = null;
    }

    // Lossless invariant: pendingHeading НЕ должен потеряться. Если он
    // установлен и приходит конкурент (другой heading) ИЛИ длинная пустая
    // зона без следующего параграфа — flush'им pH как самостоятельный блок.
    function flushPendingHeading() {
        if (pendingHeading) {
            blocks.push({ heading: null, lines: [pendingHeading], lastWasSubheading: false });
            pendingHeading = null;
        }
    }

    for (const elem of elements) {
        if (elem.kind === 'empty') {
            flush();
            // Если pH не съели за следующей итерацией heading'ом
            // — он мог потеряться в "Дата ... \n\n\n Подпись ... \n\n Имя".
            // Не сбрасываем сразу, но если будет второй heading — сольём.
            listMode = 'none';
            continue;
        }

        if (elem.kind === 'heading') {
            flush();
            // Если предыдущий pH ещё висит (heading → heading без paragraph
            // между), его надо сохранить как самостоятельный блок.
            // Иначе цепочки "ЗАКАЗЧИК \n ОсОО ... \n ИНН ..." теряются.
            flushPendingHeading();
            pendingHeading = elem.text;
            listMode = 'none';
            continue;
        }

        if (elem.kind === 'bullet') {
            if (!current) {
                current = { heading: pendingHeading, lines: [], lastWasSubheading: false };
                pendingHeading = null;
            }
            current.lines.push(elem.text);
            current.lastWasSubheading = false;
            listMode = 'bullets';
            continue;
        }

        // paragraph
        const endsWithColon = elem.text.endsWith(':');

        // 1. Новый явный список ("...нарушения:") — закрывает текущий блок
        //    и открывает новый. Даже внутри bullets/short-paragraphs —
        //    это сигнал смены смысла.
        if (endsWithColon) {
            flush();
            current = { heading: pendingHeading, lines: [elem.text], lastWasSubheading: false };
            pendingHeading = null;
            listMode = 'colon-pending';
            continue;
        }

        // 2. List mode после ":" — короткий параграф = continuation списка.
        if (listMode === 'colon-pending' && current) {
            current.lines.push(elem.text);
            listMode = (elem.text.length >= COLON_LIST_ITEM_MAX) ? 'none' : 'short-paragraphs';
            continue;
        }
        if (listMode === 'short-paragraphs' && current && elem.text.length < COLON_LIST_ITEM_MAX) {
            current.lines.push(elem.text);
            continue;
        }

        // 3. Subheading-pair: pendingHeading + короткий subheading с маркером.
        //    "Договор аренды нежилого помещения" + "1. Предмет договора." —
        //    heading должен быть отдельным блоком, иначе он съест нумерацию.
        const isShortSubheadingWithMarker =
            elem.text.length < SUBHEADING_MAX_CHARS && SUBHEADING_MARKER_RE.test(elem.text);

        if (isShortSubheadingWithMarker && pendingHeading) {
            blocks.push({ heading: null, lines: [pendingHeading], lastWasSubheading: false });
            pendingHeading = null;
        }

        // 4. Subheading-склейка: предыдущий пункт был короткий subheading
        //    ("1. Предмет договора.") — текущий paragraph его описание.
        if (current && current.lastWasSubheading) {
            current.lines.push(elem.text);
            current.lastWasSubheading = false;
            listMode = 'none';
            continue;
        }

        // 5. Default: новый блок (с pendingHeading как prefix, если есть).
        flush();
        current = {
            heading: pendingHeading,
            lines: [elem.text],
            lastWasSubheading: isSubheadingParagraph(elem.text)
        };
        pendingHeading = null;
        listMode = 'none';
    }
    flush();
    // Документ закончился с висящим pH (heading без последующего параграфа).
    // Без этого пропадает финальная "Дата ___ 20__" / "Подпись" / "Печать".
    flushPendingHeading();

    // Сериализация в string[]
    const rawChunks = blocks.map(b => {
        const body = b.lines.join('\n');
        return b.heading ? `${b.heading}\n${body}` : body;
    });

    // ── Post-merge: слипшая шапка / подписи (мелкие соседние блоки) ─────
    const merged = mergeSmallAdjacent(rawChunks, softLimit, smallBlock);

    // ── Hard cap: чанки > maxChunkLen режем sentence-aware ─────────────
    const final = [];
    for (const c of merged) {
        if (c.length <= maxChunkLen) {
            final.push(c);
        } else {
            final.push(...safeSplitLongChunk(c, maxChunkLen, telemetry));
        }
    }
    return final;
}

// LEGAL_MARKER_RE: блок начинается с явного юридического маркера.
// Такие блоки в post-merge оставляем РАЗДЕЛЬНО (разные нормы / пункты
// договора / статьи кодекса должны жить в отдельных чанках).
const LEGAL_MARKER_RE = /^(?:Стать[яеи]\s+\d+|стать[яеи]\s+\d+|Глав[аыу]\s+\d+|Част[ьи]\s+\d+|§\s*\d+|Раздел\s+\d+|пункт[ауеом]*\s+\d+|Пункт[ауеом]*\s+\d+|\d+\.\d+|\d+[.)])/u;

function startsWithLegalMarker(text) {
    return LEGAL_MARKER_RE.test(text);
}

// ── Post-merge: склеивает соседние МЕЛКИЕ блоки до softLimit ────────────
// "В Комитет ООН" / "через УВКБ" / "по правам человека" / email →
// 1 чанк адресата. НЕ склеивает блоки с правовыми маркерами в начале
// ("Часть 4 ...", "1. Предмет ..."), даже если они короткие.
function mergeSmallAdjacent(chunks, softLimit, smallBlock) {
    if (chunks.length <= 1) return chunks;
    const result = [];
    let buf = null;
    // Buf cap: пока buf < 150ch, продолжаем склеивать соседние мелкие
    // блоки. Это режим "склейка шапки/подписей" — после 150ch выходим
    // в нормальный поток. Без этой границы шапка адресата + блок
    // "Представители" + блок "ЖАЛОБА" + Заявитель + Государство
    // лепятся в один 400+ch чанк, что съедает осмысленные секции.
    const BUF_CAP = 150;

    for (const c of chunks) {
        if (buf === null) { buf = c; continue; }
        const merged = buf + '\n\n' + c;
        const bothSmallish = buf.length < BUF_CAP && c.length < smallBlock;
        const eitherIsLegal = startsWithLegalMarker(buf) || startsWithLegalMarker(c);
        if (bothSmallish && !eitherIsLegal && merged.length <= softLimit) {
            buf = merged;
        } else {
            result.push(buf);
            buf = c;
        }
    }
    if (buf !== null) result.push(buf);
    return result;
}

// ═══════════════════════════════════════════════════════════════════════
//  wrapAsAnalyzeSegments
//  Адаптер: string[] → [{id, number, heading, text}] для downstream-кода
//  routes/analyze.js. Phase 4 UX-fix: строгая порядковая нумерация
//  (String(i+1)) для уникальности "п.N" в таблице фронта.
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
    _internal: {
        classifyLine,
        isSubheadingParagraph,
        sentenceSplit,
        safeSplitLongChunk,
        hardSplit,
        mergeSmallAdjacent,
        startsWithLegalMarker,
        BULLET_RE,
        SUBHEADING_MARKER_RE,
        LEGAL_MARKER_RE,
        ABBREVS,
        MAX_CHUNK_LEN_CHARS,
        SOFT_CHUNK_LIMIT,
        SMALL_BLOCK_CHARS,
        SUBHEADING_MAX_CHARS,
        COLON_LIST_ITEM_MAX
    }
};
