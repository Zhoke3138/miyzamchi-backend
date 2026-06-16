// ═══════════════════════════════════════════════════════════════════════
//  lib/superDocBlocks.js
//  Super Doc — Шаги 2 и 3 (2026-06-16)
//    Шаг 2: AI Block-Type Classifier (Flash-Lite, batch)
//    Шаг 3: атомарные таблицы + семантический lead-in overlap
// ═══════════════════════════════════════════════════════════════════════
//
//  Вход: rawChunks (string[], lossless от hybridSegmenter) + chunkContexts
//        (LocalContext[] — sticky раздел + НПА).
//  Выход: SuperDocBlock[] = {
//    text,            // ДОСЛОВНЫЙ текст блока (для таблиц — с продублированным
//                     //   header'ом при дроблении; для остальных — без изменений)
//    type,            // article | clause | list_group | table | requisites |
//                     //   signature | preamble | paragraph
//    continues_prev,  // блок — смысловое продолжение предыдущего
//    context,         // { section, npa } — наследуется от родителя
//    leadIn,          // последнее предложение предыдущего блока (контекст для
//                     //   агента; в text НЕ вписывается — display остаётся чистым)
//    tablePart        // "2/3" если блок — часть раздробленной таблицы (иначе null)
//  }
//
//  🔒 LOSSLESS-GUARD (Шаг 2): классификатор НИКОГДА не получает право
//  переписывать text. Модель возвращает ТОЛЬКО метки по индексам
//  ({i, type, continues_prev}), сам текст мы храним у себя. Поэтому
//  инвариант «сумма символов text на входе == на выходе» для не-табличных
//  блоков соблюдается железобетонно by design. Сбой парсинга/индексов →
//  откат батча к эвристической разметке Layer A (текст всё равно цел).
//
//  Дублирование header'а при дроблении таблицы — намеренное (Шаг 3),
//  это не нарушение lossless классификатора, а добавление контекста.
// ═══════════════════════════════════════════════════════════════════════

const { _internal: segInternal } = require('./segmentRegex');
const sentenceSplit = segInternal.sentenceSplit;

const CLASSIFY_BATCH   = 15;     // блоков на один LLM-вызов
const PREVIEW_CHARS     = 300;   // сколько символов блока показываем классификатору
const MAX_TABLE_CHARS   = 2500;  // таблица крупнее → дробим по группам строк
const LEAD_IN_MAX_CHARS = 300;   // длина lead-in предложения

const ALLOWED_TYPES = new Set([
    'article', 'clause', 'list_group', 'table',
    'requisites', 'signature', 'preamble', 'paragraph'
]);

function normalizeType(t) {
    const s = String(t || '').toLowerCase().trim();
    return ALLOWED_TYPES.has(s) ? s : null;
}

function oneLine(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
}

// ── Детекция таблицы (детерминированная, авторитетная для дробления) ─────
function looksLikeTable(text) {
    const lines = String(text || '').split('\n').filter(l => l.trim());
    if (lines.length < 2) return false;
    // Markdown-таблица: ≥2 строк с двумя+ '|'
    const pipeLines = lines.filter(l => (l.match(/\|/g) || []).length >= 2).length;
    if (pipeLines >= 2) return true;
    // Markdown-разделитель заголовка |---|---|
    if (/^\s*\|?\s*:?-{3,}.*\|/m.test(text)) return true;
    // TSV: ≥2 строк с двумя+ табами
    const tabLines = lines.filter(l => (l.match(/\t/g) || []).length >= 2).length;
    if (tabLines >= 2) return true;
    return false;
}

// ── Эвристический тип блока (0 токенов, baseline до/без LLM) ─────────────
function heuristicType(text) {
    const t = String(text || '').trim();
    if (!t) return 'paragraph';
    if (looksLikeTable(t)) return 'table';
    if (/^(Стать[яи]|§)\s*\d/u.test(t)) return 'article';
    if (/(ИНН|БИК|р\/с|р\/сч|расчет?ный счет|ОсОО|реквизит)/iu.test(t) && t.length < 600) return 'requisites';
    if (/^(\d+\.\d+|\d+[.)])/.test(t)) return 'clause';
    const firstLine = t.split('\n')[0];
    if (/^[-–—•]/mu.test(t) || /:\s*$/.test(firstLine)) return 'list_group';
    if (/(подпис|печать|_{3,})/iu.test(t) && t.length < 200) return 'signature';
    return 'paragraph';
}

// ═══════════════════════════════════════════════════════════════════════
//  Шаг 2 — AI Block-Type Classifier
// ═══════════════════════════════════════════════════════════════════════
const CLASSIFY_SYS = `Ты — структурный классификатор блоков юридического документа (Кыргызстан).
Тебе дают пронумерованные блоки (превью, обрезанные). Для КАЖДОГО блока определи:
1) type — один из: article | clause | list_group | table | requisites | signature | preamble | paragraph
   • article — статья НПА ("Статья N", "§ N")
   • clause — пункт договора ("1.", "2.3")
   • list_group — вводная фраза с двоеточием + список / перечень буллетов
   • table — табличные данные (колонки, "|", разделители)
   • requisites — реквизиты стороны (ИНН, р/с, БИК, адрес, ОсОО)
   • signature — подпись / печать / дата подписания
   • preamble — шапка, преамбула, адресат
   • paragraph — обычный смысловой абзац
2) continues_prev — true, если блок является СМЫСЛОВЫМ ПРОДОЛЖЕНИЕМ предыдущего
   (предыдущий оборвался на полумысли, или это подпункт без своего заголовка).

🔴 КРИТИЧНО: НЕ возвращай текст блоков. Только метки по индексам.
Ответ СТРОГО JSON без обёрток:
{"labels":[{"i":0,"type":"clause","continues_prev":false}, ...]}`;

/**
 * classifyBlocks — батч-классификация Flash-Lite каскадом.
 * Возвращает массив { type, continues_prev, _src } параллельный chunks[].
 * Lossless by design: модель не видит и не возвращает text, только индексы.
 */
async function classifyBlocks(chunks, deps = {}) {
    const { cascade, telemetry = null, logger = console } = deps;
    const n = chunks.length;
    const labels = new Array(n);

    // Эвристический baseline (всегда) — он же fallback на упавший батч.
    for (let i = 0; i < n; i++) {
        labels[i] = { type: heuristicType(chunks[i]), continues_prev: false, _src: 'heuristic' };
    }
    if (!cascade || typeof cascade.call !== 'function' || n === 0) return labels;

    for (let start = 0; start < n; start += CLASSIFY_BATCH) {
        const end = Math.min(start + CLASSIFY_BATCH, n);
        const batchLines = [];
        for (let i = start; i < end; i++) {
            batchLines.push(`#${i}: ${oneLine(chunks[i]).slice(0, PREVIEW_CHARS)}`);
        }
        try {
            const { text } = await cascade.call({
                systemPrompt: CLASSIFY_SYS,
                userPrompt: `Блоки:\n${batchLines.join('\n')}\n\nВерни JSON {"labels":[{"i":<int>,"type":"...","continues_prev":<bool>}]}`,
                jsonMode: true,
                telemetry,
                stageLabel: `block_classify_${start}`,
                temperature: 0.0,
                maxOutputTokens: 1024
            });
            const parsed = JSON.parse(text);
            const arr = Array.isArray(parsed) ? parsed : (parsed.labels || parsed.blocks || []);
            let applied = 0;
            for (const item of (arr || [])) {
                const i = Number(item && item.i);
                if (!Number.isInteger(i) || i < start || i >= end) continue;
                const t = normalizeType(item.type);
                // Эвристическая таблица АВТОРИТЕТНА (от неё зависит дробление) —
                // LLM не может «снять» тип table, но может уточнить остальные.
                if (labels[i].type !== 'table' && t) labels[i].type = t;
                labels[i].continues_prev = !!item.continues_prev;
                labels[i]._src = 'llm';
                applied++;
            }
            if (applied === 0) {
                logger.warn?.(`[BlockClassifier] batch ${start}-${end}: 0 меток применено → heuristic`);
            }
        } catch (e) {
            // Откат ЭТОГО батча к Layer A (текст не тронут в любом случае).
            logger.warn?.(`[BlockClassifier] batch ${start}-${end} fail (${String(e.message).slice(0, 80)}) → heuristic fallback`);
        }
    }
    return labels;
}

// ═══════════════════════════════════════════════════════════════════════
//  Шаг 3a — Атомарные таблицы
// ═══════════════════════════════════════════════════════════════════════
/**
 * Таблица не режется по строкам. Если блок type==='table' превышает лимит —
 * дробим на ЛОГИЧЕСКИЕ группы строк, дублируя header в каждую часть.
 * Возвращает 1+ блоков на каждый входной.
 */
function splitAtomicTables(blocks, opts = {}) {
    const maxTableChars = opts.maxTableChars || MAX_TABLE_CHARS;
    const out = [];
    for (const b of blocks) {
        if (b.type !== 'table' || b.text.length <= maxTableChars) {
            out.push({ ...b, tablePart: b.tablePart || null });
            continue;
        }
        const rows = b.text.split('\n');
        // Header = первая непустая строка (+ markdown-разделитель, если он второй).
        let headerCount = 1;
        if (rows[1] && /^\s*\|?\s*:?-{3,}/.test(rows[1])) headerCount = 2;
        const header = rows.slice(0, headerCount);
        const headerStr = header.join('\n');
        const body = rows.slice(headerCount);

        const groups = [];
        let cur = [];
        let curLen = headerStr.length;
        for (const r of body) {
            if (cur.length && curLen + r.length + 1 > maxTableChars) {
                groups.push(cur);
                cur = [];
                curLen = headerStr.length;
            }
            cur.push(r);
            curLen += r.length + 1;
        }
        if (cur.length) groups.push(cur);
        if (groups.length === 0) { out.push({ ...b, tablePart: null }); continue; }

        groups.forEach((g, gi) => {
            out.push({
                ...b,
                text: [...header, ...g].join('\n'),          // header продублирован
                continues_prev: gi === 0 ? b.continues_prev : true,
                tablePart: `${gi + 1}/${groups.length}`
            });
        });
    }
    return out;
}

// ═══════════════════════════════════════════════════════════════════════
//  Шаг 3b — Семантический lead-in overlap
// ═══════════════════════════════════════════════════════════════════════
/**
 * Вместо слепого символьного overlap: если блок continues_prev===true,
 * берём ПОСЛЕДНЕЕ предложение предыдущего блока как lead-in. Кладём в
 * block.leadIn (НЕ в text — display остаётся чистым; агент получит контекст
 * отдельно). Таблицы пропускаем — их контекст несёт продублированный header.
 */
function applySemanticLeadIn(blocks) {
    for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        b.leadIn = null;
        if (i === 0 || !b.continues_prev || b.type === 'table') continue;
        const prevText = blocks[i - 1].text || '';
        const sents = sentenceSplit(prevText);
        const last = (sents.length ? sents[sents.length - 1] : prevText).trim();
        if (last) b.leadIn = last.slice(0, LEAD_IN_MAX_CHARS);
    }
    return blocks;
}

// ═══════════════════════════════════════════════════════════════════════
//  Оркестратор
// ═══════════════════════════════════════════════════════════════════════
/**
 * buildSuperDocBlocks — Шаг 2 + Шаг 3 одним проходом.
 *   rawChunks (string[])  + chunkContexts (LocalContext[])  → SuperDocBlock[]
 *
 * Порядок: classify → split tables (меняет длину массива) → lead-in (после
 * дробления, чтобы индексы были финальными).
 */
async function buildSuperDocBlocks(rawChunks, chunkContexts = [], deps = {}) {
    if (!Array.isArray(rawChunks) || rawChunks.length === 0) return [];
    const labels = await classifyBlocks(rawChunks, deps);

    let blocks = rawChunks.map((text, i) => ({
        text: String(text || ''),
        type: labels[i] ? labels[i].type : heuristicType(text),
        continues_prev: labels[i] ? !!labels[i].continues_prev : false,
        context: chunkContexts[i] || null,
        leadIn: null,
        tablePart: null,
        _typeSrc: labels[i] ? labels[i]._src : 'heuristic'
    }));

    blocks = splitAtomicTables(blocks, deps);
    blocks = applySemanticLeadIn(blocks);
    return blocks;
}

module.exports = {
    buildSuperDocBlocks,
    classifyBlocks,
    splitAtomicTables,
    applySemanticLeadIn,
    looksLikeTable,
    heuristicType,
    _internal: {
        normalizeType, oneLine, CLASSIFY_SYS,
        CLASSIFY_BATCH, MAX_TABLE_CHARS, LEAD_IN_MAX_CHARS, ALLOWED_TYPES
    }
};
