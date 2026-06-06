'use strict';

// ════════════════════════════════════════════════════════════════════
// SEMANTIC LEGAL REDLINING — Map-Reduce pipeline сравнения редакций
// ════════════════════════════════════════════════════════════════════
// 1) ALIGN  — оба документа разбиваются на пункты, эмбеддинги, сопоставление
//             по косинусному сходству (порог 0.78 — снимает съехавшую нумерацию).
// 2) MAP    — параллельные воркеры (gemini-2.5-flash) анализируют пары
//             батчами по WORKER_BATCH_SIZE: hasChanges / category /
//             riskDetected / riskDescription.
// 3) REDUCE — компактная дельта только ВАЖНЫХ изменений → DeepSeek V4 Pro
//             (Старший партнёр) стримит Executive Summary через SSE.
//
// Файл — фабрика: server.js вызывает `require('./routes/compare')(deps)`,
// передавая все нужные хелперы (избегаем циркулярного require и повторной
// инициализации middleware/ключей).
// ════════════════════════════════════════════════════════════════════

const express = require('express');
// Гибридный аудит: пословный diff/redline + переиспользование Agent 2 (нормоконтроль).
// compareService самодостаточен (diff + legalAgents/llmClients/env), server.js не трогаем.
const { classifyChange, legalAudit } = require('../services/compareService');

// ── ПАРАМЕТРЫ ───────────────────────────────────────────────────────
const ALIGN_THRESHOLD     = 0.78;     // мин. cos-сходство для пары
const WORKER_BATCH_SIZE   = 1;        // 1 пара на агента (логически один агент = одна пара)
const MAX_PAIRS           = 100;      // потолок: длинные договоры дают 60+ пунктов с каждой стороны
const COMBINED_CONCURRENCY = 8;       // одновременных пар в MAP (Materiality+Legal = ~4 вызова/пара)
const LEGAL_AUDIT_CAP      = 40;      // потолок юр-аудитов за запрос (защита бюджета на гигантских диффах)
const COMPARE_SEG_LIMIT   = 60;       // лимит сегментов НА ДОКУМЕНТ (общий SEGMENT_LIMIT=25 — мало)
const MIN_DOC_LEN         = 50;       // мин. длина каждого документа
const EMBED_QUERY_MAX     = 1500;     // обрезка текста для эмбеддинга
const SEGMENT_TEXT_LIMIT  = 1200;     // обрезка текста пункта в промпте воркера
const DELTA_CHARS_LIMIT   = 12000;    // обрезка дельты для финального судьи

// ── ОГРАНИЧЕНИЯ ПАРАЛЛЕЛЬНОСТИ (защита от burst-лимитов Gemini) ─────
// Платный Gemini Tier 1 = ~1000 RPM, но есть BURST-лимит (~60 запросов/сек).
// При 60+ парах залп всех воркеров одновременно почти гарантированно ловит 429.
// Семафор ограничивает одновременные вызовы — даёт параллелизм без бёрста.
//
// WORKER_CONCURRENCY=12 → для 60 пар получаем 5 волн по 12 = ~15-20 сек,
// без 429. Если добавишь второй платный ключ в env (через запятую) —
// можно поднять до 20-25 (распределение через round-robin ротацию).
const WORKER_CONCURRENCY  = 12;        // одновременных LLM-воркеров
const EMBED_CONCURRENCY   = 20;        // одновременных эмбеддингов (дешевле, можем больше)

// ── ПРОМПТ ВОРКЕРА (Map) ─────────────────────────────────────────────
const WORKER_SYSTEM_PROMPT = `Ты — строгий эксперт-аудитор договоров КР.
Сравниваешь две редакции одного и того же пункта документа.

ПРАВИЛА:
- Игнорируй мелкую стилистику и исправление опечаток.
- Сосредоточься на ЮРИДИЧЕСКОМ смысле: меняются ли права, обязанности,
  сроки, суммы, ответственность, подсудность, условия выхода.
- Если old = null → пункт ДОБАВЛЕН (новая обязанность/право).
- Если new = null → пункт УДАЛЁН (изъята обязанность/право).
- riskDetected = true ТОЛЬКО если новая редакция реально хуже для нашей
  стороны (увеличена ответственность, сокращены права, расширены санкции,
  изменена подсудность не в нашу пользу и т.п.).
- riskDescription — конкретно, что именно ухудшилось и чем грозит (1-2 предложения).
  Если риска нет — null.
- category строго одно из: "стилистика" | "существенное изменение" | "добавление" | "удаление".

ФОРМАТ ОТВЕТА — СТРОГО JSON, БЕЗ markdown, БЕЗ пояснений:
{
  "results": [
    { "idx": 0, "hasChanges": true, "category": "существенное изменение",
      "riskDetected": true, "riskDescription": "..." },
    { "idx": 1, "hasChanges": false, "category": "стилистика",
      "riskDetected": false, "riskDescription": null }
  ]
}

Возвращаешь ровно столько объектов, сколько пар на входе, в порядке idx.`;

// ── ПРОМПТ СУДЬИ (Reduce) ────────────────────────────────────────────
const JUDGE_SYSTEM_PROMPT_COMPARE = `Ты — **Старший партнёр** юридической фирмы КР.
Перед тобой компактная сводка существенных изменений между старой и новой редакцией
документа. По каждому изменению указаны: цитаты «Было/Стало», коммерческий риск (в чью
пользу) и ЮРИДИЧЕСКИЙ ВЕРДИКТ нормоконтроля (нарушает ли новая редакция НПА КР, со ссылкой
на конкретные статьи из нашей базы законов).

Сформируй Executive Summary для клиента строго по трём секциям (markdown):

## 🔴 1. Критические правовые риски (нарушения НПА)
Изменения, которые ПРОТИВОРЕЧАТ законам КР (помечены как НАРУШЕНИЕ).
Для каждого: суть нарушения · точная норма (НПА + статья ИЗ ПЕРЕДАННОЙ сводки) ·
**готовая формулировка-контраргумент**, которую юрист отправит контрагенту со ссылкой
на нарушенную норму («Условие п.X противоречит ст.Y ... и является ничтожным в силу...»).
Если прямых нарушений НПА в сводке нет — напиши одной строкой «Прямых нарушений НПА не выявлено.»

## 🟡 2. Коммерческие риски (изменения не в нашу пользу)
Изменения, ухудшающие положение нашей стороны (рост ответственности, сокращение прав,
смена подсудности, новые обязанности). 2–5 пунктов: что ухудшилось, чем грозит, кому выгодно.
Если таких нет — «Существенных коммерческих рисков не выявлено.»

## ⚪ 3. Прочие существенные правки
Кратко (списком) остальные значимые, но не рисковые изменения/добавления/удаления.

## ⚖️ Вердикт
Одной строкой: подписывать как есть · идти на переговоры · отказаться.

ПРАВИЛА:
- Пиши профессиональным юридическим языком, без воды.
- Не упоминай внутреннюю кухню (агентов, эмбеддинги, базу) — ты живой юрист, лично сверивший редакции.
- НЕ выдумывай нормы КР и номера статей: ссылайся ТОЛЬКО на статьи, явно указанные в сводке.
- Ссылайся на пункты документа по их авторской нумерации (п. 4.2 и т.п.).`;

// ── ВЕКТОРНЫЕ УТИЛИТЫ ───────────────────────────────────────────────
function cosineSim(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        const x = a[i], y = b[i];
        dot += x * y;
        na  += x * x;
        nb  += y * y;
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom > 0 ? dot / denom : 0;
}

// Жадное выравнивание O(N×M) — для N,M ≤ 25 это 625 пар, моментально.
// Для каждого старого пункта ищем НАИБОЛЕЕ похожий новый из ещё не занятых.
// Не-сматчившиеся: старые → "удалено", новые → "добавлено".
function alignSegments(oldSegs, newSegs) {
    const usedNew = new Set();
    const pairs = [];

    for (const oldSeg of oldSegs) {
        let bestIdx = -1;
        let bestScore = ALIGN_THRESHOLD;   // ниже порога — пары нет
        for (let j = 0; j < newSegs.length; j++) {
            if (usedNew.has(j)) continue;
            const score = cosineSim(oldSeg._vec, newSegs[j]._vec);
            if (score > bestScore) {
                bestScore = score;
                bestIdx   = j;
            }
        }
        if (bestIdx >= 0) {
            usedNew.add(bestIdx);
            const ns = newSegs[bestIdx];
            pairs.push({
                oldId: oldSeg.id, oldNumber: oldSeg.number, oldHeading: oldSeg.heading, oldText: oldSeg.text,
                newId: ns.id,     newNumber: ns.number,     newHeading: ns.heading,     newText: ns.text,
                alignScore: Number(bestScore.toFixed(3))
            });
        } else {
            pairs.push({
                oldId: oldSeg.id, oldNumber: oldSeg.number, oldHeading: oldSeg.heading, oldText: oldSeg.text,
                newId: null,      newNumber: null,          newHeading: null,           newText: null,
                alignScore: 0
            });
        }
    }
    // Новые, не сматчившиеся ни с одним старым → добавления
    for (let j = 0; j < newSegs.length; j++) {
        if (usedNew.has(j)) continue;
        const ns = newSegs[j];
        pairs.push({
            oldId: null, oldNumber: null, oldHeading: null, oldText: null,
            newId: ns.id, newNumber: ns.number, newHeading: ns.heading, newText: ns.text,
            alignScore: 0
        });
    }
    return pairs;
}

function chunkArray(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

// Семафор: запускает items.length задач, но одновременно работает не более
// `concurrency` штук. Когда один воркер освобождается — сразу берёт следующий.
// Возвращает результаты в исходном порядке. Падение задачи → результат undefined
// (НЕ throw), вызывающий код фильтрует через .filter(Boolean).
//
// Зачем: без этого Promise.all(60+ запросов) ловит burst-лимит Gemini (429).
// С concurrency=12 получаем 5 волн по 12 — параллелизм есть, бёрста нет.
async function runWithConcurrency(items, concurrency, taskFn) {
    if (!items || items.length === 0) return [];
    const results = new Array(items.length);
    let cursor = 0;
    async function worker() {
        while (true) {
            const i = cursor++;
            if (i >= items.length) return;
            try {
                results[i] = await taskFn(items[i], i);
            } catch (e) {
                results[i] = undefined;
            }
        }
    }
    const pool = Array.from(
        { length: Math.min(concurrency, items.length) },
        () => worker()
    );
    await Promise.all(pool);
    return results;
}

// ════════════════════════════════════════════════════════════════════
// ФАБРИКА: server.js передаёт зависимости, мы регистрируем роут.
// ════════════════════════════════════════════════════════════════════
module.exports = function registerCompareRoute(deps) {
    const {
        app,
        getEmbedding,
        generateContentResilient,  // воркеры — через него, чтобы передать temperature 0.2 / maxTokens 2048
        streamDeepSeekResponse,
        segmentDocument,
        extractDocumentContext,    // паспорт документа (тип/отрасль/стороны) — один LLM-вызов
        formatDocContext,          // компактная строка из паспорта
        sendStep,
        sendStatus,
        requireClientToken,
        safeJsonParse,
        requestTelemetry,
        rateLimit,
        logger
    } = deps;

    // Жёсткая проверка — если что-то не передано, падаем сразу на старте,
    // не в момент первого запроса.
    const required = { app, getEmbedding, generateContentResilient, streamDeepSeekResponse,
        segmentDocument, extractDocumentContext, formatDocContext,
        sendStep, sendStatus, requireClientToken,
        safeJsonParse, requestTelemetry, rateLimit };
    for (const [k, v] of Object.entries(required)) {
        if (!v) throw new Error(`[compare] missing dependency: ${k}`);
    }
    const log = logger || { info() {}, warn() {}, error() {} };

    const router = express.Router();

    // Отдельный лимитер — этот режим дорогой по агентам (как deep-analyze).
    const compareLimiter = rateLimit({
        windowMs: 60_000,
        max: 8,
        standardHeaders: true,
        legacyHeaders: false,
        message: { reply: 'Лимит сравнения: не более 8 запросов в минуту.' }
    });

    // ── ВОРКЕР (Map): один батч → один LLM-вызов ────────────────────
    // generateContentResilient → 4 попытки, последняя на FALLBACK_MODEL.
    // Ротация ключей и blockKey-на-429 встроены в существующий слой.
    // docContextStr — общий паспорт документа (тип, отрасль, стороны);
    // инжектируется в каждый LLM-вызов, чтобы воркер понимал, какой это
    // документ и не считал нормальную переформулировку «существенным изменением».
    async function runWorkerBatch(pairs, batchIndex, docContextStr = '') {
        const input = pairs.map((p, i) => ({
            idx: i,
            old: p.oldText
                ? `[${p.oldNumber || '?'}] ${p.oldHeading || ''}\n${p.oldText.slice(0, SEGMENT_TEXT_LIMIT)}`
                : null,
            new: p.newText
                ? `[${p.newNumber || '?'}] ${p.newHeading || ''}\n${p.newText.slice(0, SEGMENT_TEXT_LIMIT)}`
                : null
        }));

        const ctxBlock = docContextStr
            ? `═══ КОНТЕКСТ ВСЕГО ДОКУМЕНТА (учитывай при сравнении) ═══
${docContextStr}
═══════════════════════════════════════════════════════════
`
            : '';

        const userPrompt = `${ctxBlock}Сравни ${pairs.length} пар(ы) пунктов договора КР.
На входе массив объектов { idx, old, new }.
Если old == null → пункт ДОБАВЛЕН.
Если new == null → пункт УДАЛЁН.

КРИТИЧЕСКИ ВАЖНО:
- Сравнивай ТОЛЬКО фактический текст КОНКРЕТНОЙ пары на входе.
- Если две версии по СМЫСЛУ идентичны (даже при разной нумерации/форматировании) →
  category="стилистика", hasChanges=false, riskDetected=false.
- НЕ помечай как «существенное изменение» то, что просто переехало в другой пункт.

Входные пары:
${JSON.stringify(input, null, 2)}

Верни ровно ${pairs.length} результат(ов) в порядке idx по формату из системной инструкции.`;

        try {
            // generateContentResilient напрямую — чтобы передать строгие
            // generationConfig (низкая temperature для валидного JSON + лимит токенов).
            // Внутри есть retry на 4 попытки + смена модели на FALLBACK_MODEL
            // на последней попытке.
            const raw = await generateContentResilient({
                systemInstruction: WORKER_SYSTEM_PROMPT,
                userPrompt,
                generationConfig: { temperature: 0.2, topP: 0.9, maxOutputTokens: 2048 },
                maxRetries: 2
            });
            const parsed = safeJsonParse(raw, { results: [] });
            const results = Array.isArray(parsed.results) ? parsed.results : [];

            // Сшиваем результаты с парами по idx (не полагаемся на порядок).
            return pairs.map((pair, i) => {
                const r = results.find(x => Number(x.idx) === i) || results[i] || {};
                const VALID_CAT = ['стилистика', 'существенное изменение', 'добавление', 'удаление'];
                const fallbackCat = pair.oldText == null ? 'добавление'
                                  : pair.newText == null ? 'удаление'
                                  : 'стилистика';
                const cat = VALID_CAT.includes(r.category) ? r.category : fallbackCat;
                const riskDesc = (r.riskDescription && r.riskDescription !== 'null' && r.riskDescription !== null)
                    ? String(r.riskDescription).slice(0, 600).trim()
                    : null;
                return {
                    ...pair,
                    hasChanges: !!r.hasChanges || (pair.oldText == null) || (pair.newText == null),
                    category: cat,
                    riskDetected: !!r.riskDetected,
                    riskDescription: riskDesc
                };
            });
        } catch (e) {
            log.warn(`[compare:worker batch=${batchIndex}] failed: ${e.message}`);
            // Soft-degradation: не валим весь анализ, помечаем батч и идём дальше.
            return pairs.map(p => ({
                ...p,
                hasChanges: !!(p.oldText && p.newText) === false ? true : false,
                category: p.oldText == null ? 'добавление' : p.newText == null ? 'удаление' : 'стилистика',
                riskDetected: false,
                riskDescription: null,
                workerError: e.message
            }));
        }
    }

    // ── РОУТ ────────────────────────────────────────────────────────
    router.post('/api/compare-documents', compareLimiter, requireClientToken, async (req, res) => {
        return requestTelemetry.run({ res, label: 'compare-documents' }, async () => {
            try {
                const { oldDocumentText = '', newDocumentText = '' } = req.body || {};
                const oldLen = String(oldDocumentText).trim().length;
                const newLen = String(newDocumentText).trim().length;

                if (oldLen < MIN_DOC_LEN || newLen < MIN_DOC_LEN) {
                    return res.status(400).json({
                        error: `Оба документа должны быть длиной не менее ${MIN_DOC_LEN} символов (старый: ${oldLen}, новый: ${newLen}).`
                    });
                }

                // PRIVACY: не логируем тексты документов — могут содержать ФИО.
                log.info('compare-request', { oldLen, newLen });

                // SSE-заголовки с антибуферизацией прокси Render.
                res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
                res.setHeader('Cache-Control', 'no-cache, no-transform');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                if (typeof res.flushHeaders === 'function') res.flushHeaders();

                const startTime = Date.now();

                // ═══ ЭТАП 0: КОНТЕКСТ ДОКУМЕНТА ═══════════════════════════
                // Один LLM-вызов на НОВОЙ редакции (она каноничная — то, что подписывают).
                // Контекст инжектируется и в сегментаторы (лучшие заголовки), и
                // в каждый воркер (правильная отраслевая интерпретация).
                sendStep(res, { id: 'context', status: 'loading', text: 'Определяю тип и отрасль документа' });
                sendStatus(res, '🧭 Определяю контекст документа...');
                let docContext = null;
                try { docContext = await extractDocumentContext(newDocumentText); } catch (e) {
                    log.warn(`[compare:context] failed: ${e.message}`);
                }
                const docContextStr = formatDocContext(docContext);
                sendStep(res, {
                    id: 'context',
                    status: docContext ? 'success' : 'warning',
                    text: docContext?.document_type || 'Контекст не определён',
                    reason: docContext?.subject_area || null
                });

                // ═══ ЭТАП 1: ALIGN ═══════════════════════════════════════
                sendStep(res, { id: 'segment', status: 'loading', text: 'Разбиваю обе редакции на пункты' });
                sendStatus(res, '✂️ Разбиваю документы на пункты...');
                // Лимит COMPARE_SEG_LIMIT (60) вместо общего SEGMENT_LIMIT (25) —
                // юр.договоры реально содержат 50+ подпунктов, без этого половина
                // выпадает и выравнивание ломается (мнимые "удаления"/"добавления").
                const [oldSegsRaw, newSegsRaw] = await Promise.all([
                    segmentDocument(oldDocumentText, docContextStr, { maxSegments: COMPARE_SEG_LIMIT }),
                    segmentDocument(newDocumentText, docContextStr, { maxSegments: COMPARE_SEG_LIMIT })
                ]);

                if (!oldSegsRaw.length || !newSegsRaw.length) {
                    sendStep(res, { id: 'segment', status: 'warning', text: 'Не удалось разбить один из документов' });
                    res.write(`data: ${JSON.stringify({
                        text: 'Не удалось разбить документы на пункты. Проверьте, что обе редакции — это юридические документы со структурой (договор, соглашение, иск).'
                    })}\n\n`);
                    res.write('data: [DONE]\n\n');
                    return res.end();
                }
                sendStep(res, {
                    id: 'segment', status: 'success',
                    text: `Старая: ${oldSegsRaw.length} · Новая: ${newSegsRaw.length}`
                });

                // Эмбеддинги — параллельно с лимитом EMBED_CONCURRENCY (защита от burst).
                // getEmbedding внутри кэширует + ротирует ключи + ретраит 429.
                sendStep(res, { id: 'embed', status: 'loading', text: 'Векторизую пункты для выравнивания' });
                sendStatus(res, '🧬 Считаю векторы...');
                const allSegsForEmbed = [...oldSegsRaw, ...newSegsRaw];
                const allEmbeds = await runWithConcurrency(
                    allSegsForEmbed,
                    EMBED_CONCURRENCY,
                    (s) => getEmbedding(`${s.heading}. ${s.text}`.slice(0, EMBED_QUERY_MAX))
                );
                const oldSegs = oldSegsRaw.map((s, i) => ({ ...s, _vec: allEmbeds[i] }));
                const newSegs = newSegsRaw.map((s, i) => ({ ...s, _vec: allEmbeds[oldSegsRaw.length + i] }));
                sendStep(res, { id: 'embed', status: 'success', text: `Векторов: ${allEmbeds.length}` });

                // Выравнивание пар.
                sendStep(res, { id: 'align', status: 'loading', text: 'Сопоставляю пункты по смыслу (cosine ≥ 0.78)' });
                let pairs = alignSegments(oldSegs, newSegs);
                if (pairs.length > MAX_PAIRS) {
                    log.warn(`[compare] pairs=${pairs.length} > MAX=${MAX_PAIRS}, обрезаю`);
                    pairs = pairs.slice(0, MAX_PAIRS);
                }
                const matched = pairs.filter(p => p.oldText && p.newText).length;
                const added   = pairs.filter(p => !p.oldText && p.newText).length;
                const removed = pairs.filter(p => p.oldText && !p.newText).length;
                sendStep(res, {
                    id: 'align', status: 'success',
                    text: `Пар: ${pairs.length} (∥ ${matched} · + ${added} · − ${removed})`
                });

                // ═══ ЭТАП 2: DIFF-ГЕЙТ (пословный redline + отсев косметики) ══
                // Пословный diff по каждой паре — CPU, мгновенно. Косметику отсеиваем
                // ДО LLM (экономия вызовов). «Числовой страж» внутри classifyChange не
                // даёт выбросить смену цифр/сроков/% как косметику (анти-false-negative).
                sendStep(res, { id: 'diff', status: 'loading', text: 'Считаю пословный diff (redline)' });
                for (const p of pairs) {
                    const c = classifyChange(p.oldText, p.newText);
                    p.diffRatio   = c.ratio;
                    p.redlineHtml = c.html;
                    p.numericFlag = c.numericFlag;
                    p._cosmetic   = c.isCosmetic;
                }
                const materialPairs = pairs.filter(p => !p._cosmetic);
                const cosmeticPairs = pairs.filter(p => p._cosmetic);
                log.info('compare-diff-gate', {
                    total: pairs.length, material: materialPairs.length, cosmetic: cosmeticPairs.length
                });
                sendStep(res, {
                    id: 'diff', status: 'success',
                    text: `Существенных: ${materialPairs.length} · косметика отсеяна: ${cosmeticPairs.length}`
                });

                // Косметика — без LLM: проставляем дефолтные поля.
                for (const p of cosmeticPairs) {
                    p.hasChanges = false;
                    p.category = 'стилистика';
                    p.riskDetected = false;
                    p.riskDescription = null;
                    p.legalStatus = 'skipped';
                    p.legalMarker = '';
                    p.legalDetail = '';
                    p.citedArticles = [];
                    p.legalNpa = null;
                }

                // ═══ ЭТАП 3: MAP (Materiality ∥ Legal на существенных парах) ══
                // По каждой существенной паре ПАРАЛЛЕЛЬНО:
                //   • Materiality Judge (Gemini) — в чью пользу / категория / комм. риск;
                //   • Legal Validator (Agent 2 + Pinecone) — нарушает ли НОВАЯ редакция НПА КР.
                sendStep(res, { id: 'map', status: 'loading', text: `Аудит ${materialPairs.length} существенных пар(ы)` });
                sendStatus(res, '🔬 Сверяю смысл и законность изменений...');
                let legalAuditsRun = 0;
                await runWithConcurrency(
                    materialPairs,
                    COMBINED_CONCURRENCY,
                    async (pair, i) => {
                        // Materiality — существующий воркер (одна пара = один батч).
                        const matPromise = runWorkerBatch([pair], i, docContextStr)
                            .then(arr => (arr && arr[0]) || {});
                        // Legal — только если есть НОВЫЙ текст (удалённое проверять нечего)
                        // и не превышен потолок аудитов.
                        const doLegal = !!pair.newText && legalAuditsRun < LEGAL_AUDIT_CAP;
                        if (doLegal) legalAuditsRun++;
                        const legalPromise = doLegal
                            ? legalAudit(pair.newText)
                            : Promise.resolve({ status: 'skipped', marker: '', detail: '', cited_articles: [], npa: null });

                        const [mat, legal] = await Promise.all([matPromise, legalPromise]);
                        // Мутируем сам объект пары (ссылка та же, что в pairs) — порядок сохраняется.
                        pair.hasChanges      = mat.hasChanges != null ? mat.hasChanges : true;
                        pair.category        = mat.category || (pair.oldText == null ? 'добавление' : pair.newText == null ? 'удаление' : 'существенное изменение');
                        pair.riskDetected    = !!mat.riskDetected;
                        pair.riskDescription = mat.riskDescription || null;
                        pair.legalStatus     = legal.status;
                        pair.legalMarker     = legal.marker || '';
                        pair.legalDetail     = legal.detail || '';
                        pair.citedArticles   = legal.cited_articles || [];
                        pair.legalNpa        = legal.npa || null;
                        return pair;
                    }
                );

                const enrichedPairs    = pairs;  // все пары (важные мутированы, косметика — дефолты)
                const risksCount       = enrichedPairs.filter(p => p.riskDetected).length;
                const legalRisksCount  = enrichedPairs.filter(p => p.legalStatus === 'error').length;
                const substantialCount = enrichedPairs.filter(p => p.category === 'существенное изменение').length;
                sendStep(res, {
                    id: 'map', status: 'success',
                    text: `🔴 ${legalRisksCount} правовых · 🟡 ${risksCount} комм. рисков · 📌 ${substantialCount} сущ.`
                });

                // Отправляем фронту полный отчёт ДО синтеза — фронт уже может
                // рисовать side-by-side с redline, пока судья пишет резюме.
                res.write(`data: ${JSON.stringify({
                    compareReport: {
                        total: enrichedPairs.length,
                        matched, added, removed,
                        risksCount, legalRisksCount, substantialCount,
                        pairs: enrichedPairs.map(p => ({
                            oldId: p.oldId, oldNumber: p.oldNumber, oldHeading: p.oldHeading, oldText: p.oldText,
                            newId: p.newId, newNumber: p.newNumber, newHeading: p.newHeading, newText: p.newText,
                            hasChanges: p.hasChanges,
                            category: p.category,
                            riskDetected: p.riskDetected,
                            riskDescription: p.riskDescription,
                            alignScore: p.alignScore,
                            diffRatio: p.diffRatio,
                            redlineHtml: p.redlineHtml,
                            numericFlag: p.numericFlag,
                            legalStatus: p.legalStatus,
                            legalMarker: p.legalMarker,
                            legalDetail: p.legalDetail,
                            citedArticles: p.citedArticles,
                            legalNpa: p.legalNpa
                        }))
                    }
                })}\n\n`);

                // ═══ ЭТАП 4: REDUCE (Executive Summary через DeepSeek) ══
                // Три корзины для Судьи: правовые нарушения / коммерческие риски / прочее.
                const legalViolations = enrichedPairs.filter(p => p.legalStatus === 'error');
                const commercialRisks = enrichedPairs.filter(p => p.riskDetected && p.legalStatus !== 'error');
                const otherChanges    = enrichedPairs.filter(p =>
                    !p._cosmetic && !p.riskDetected && p.legalStatus !== 'error' &&
                    (p.category === 'существенное изменение' || p.category === 'добавление' || p.category === 'удаление')
                );

                if (materialPairs.length === 0) {
                    sendStep(res, { id: 'judge', status: 'success', text: 'Существенных изменений не найдено' });
                    res.write(`data: ${JSON.stringify({
                        text: '## ⚖️ Вердикт\n\nСущественных юридических изменений между редакциями не обнаружено. Различия носят стилистический характер (опечатки, форматирование) и не меняют объёма прав и обязанностей сторон.\n\nДокумент можно подписывать в новой редакции — изменения безопасны для нашей стороны.'
                    })}\n\n`);
                    res.write('data: [DONE]\n\n');
                    log.info('compare-done-trivial', { ms: Date.now() - startTime, pairs: enrichedPairs.length });
                    return res.end();
                }

                sendStep(res, { id: 'judge', status: 'loading', text: 'Формирую Executive Summary' });
                sendStatus(res, '⚖️ Старший партнёр готовит итоговое резюме...');

                // КОМПАКТНЫЕ ДЕЛЬТЫ по корзинам — НЕ полные тексты (бюджет окна судьи).
                const cite = (p) => {
                    const num  = p.newNumber || p.oldNumber || '?';
                    const head = p.newHeading || p.oldHeading || 'пункт';
                    const oldS = p.oldText ? p.oldText.replace(/\s+/g, ' ').slice(0, 240) : '—';
                    const newS = p.newText ? p.newText.replace(/\s+/g, ' ').slice(0, 240) : '—';
                    return { num, head, oldS, newS };
                };
                const legalBlock = legalViolations.length ? legalViolations.map((p, i) => {
                    const f = cite(p);
                    const arts = (p.citedArticles && p.citedArticles.length) ? p.citedArticles.join('; ') : (p.legalNpa || 'норма из базы НПА');
                    return `${i + 1}. п.${f.num} «${f.head}»\n   Было: ${f.oldS}\n   Стало: ${f.newS}\n   🔴 НАРУШЕНИЕ: ${(p.legalDetail || 'противоречие норме').slice(0, 360)}\n   Норма: ${arts}`;
                }).join('\n\n') : '— нарушений НПА не выявлено —';
                const commBlock = commercialRisks.length ? commercialRisks.map((p, i) => {
                    const f = cite(p);
                    const risk = p.riskDescription ? `\n   Риск: ${p.riskDescription.slice(0, 320)}` : '';
                    return `${i + 1}. п.${f.num} «${f.head}»\n   Было: ${f.oldS}\n   Стало: ${f.newS}${risk}`;
                }).join('\n\n') : '— существенных коммерческих рисков не выявлено —';
                const otherBlock = otherChanges.length ? otherChanges.map((p) => {
                    const f = cite(p);
                    const tag = p.category === 'добавление' ? '🟢 ДОБАВЛЕНО' : p.category === 'удаление' ? '⚫ УДАЛЕНО' : '🟡 ИЗМЕНЕНО';
                    return `- ${tag} · п.${f.num} «${f.head}»`;
                }).join('\n') : '—';

                const judgeUser = `Сводка по сравнению редакций документа:

Всего сопоставлено пунктов: ${enrichedPairs.length}
Существенных изменений:     ${materialPairs.length}
🔴 Нарушений НПА:            ${legalRisksCount}
🟡 Коммерческих рисков:      ${risksCount}
Добавлено новых:            ${added}   Удалено: ${removed}

═══ 🔴 НАРУШЕНИЯ НПА (юридический вердикт нормоконтроля) ═══
${legalBlock.slice(0, DELTA_CHARS_LIMIT)}

═══ 🟡 КОММЕРЧЕСКИЕ РИСКИ (изменения не в нашу пользу) ═══
${commBlock.slice(0, DELTA_CHARS_LIMIT)}

═══ ⚪ ПРОЧИЕ СУЩЕСТВЕННЫЕ ПРАВКИ ═══
${otherBlock.slice(0, 3000)}

Сформируй Executive Summary строго по трём секциям из системной инструкции. Для каждого
нарушения НПА дай готовую формулировку-контраргумент со ссылкой на указанную норму.`;

                try {
                    // streamDeepSeekResponse внутри сама умеет fallback на Gemini,
                    // если DeepSeek упал до первого чанка.
                    // reasoning_effort динамический: если есть нарушения НПА — 'high'
                    // (нужны точные формулировки-контраргументы со ссылкой на норму),
                    // иначе 'medium' (быстрее на 30-50%, вход уже отфильтрован).
                    await streamDeepSeekResponse(JUDGE_SYSTEM_PROMPT_COMPARE, judgeUser, res, {
                        temperature: 0.25,
                        reasoning_effort: legalRisksCount > 0 ? 'high' : 'medium'
                    });
                    sendStep(res, { id: 'judge', status: 'success', text: 'Резюме готово' });
                } catch (e) {
                    log.error('compare-judge-failed', e);
                    sendStep(res, { id: 'judge', status: 'error', text: 'Ошибка формирования резюме' });
                    if (!res.writableEnded) {
                        res.write(`data: ${JSON.stringify({ text: '\n\n⚠️ Не удалось сформировать итоговое резюме. Side-by-side отчёт выше остаётся валидным.' })}\n\n`);
                    }
                }

                log.info('compare-done', {
                    ms: Date.now() - startTime,
                    pairs: enrichedPairs.length,
                    material: materialPairs.length,
                    legalRisks: legalRisksCount,
                    risks: risksCount,
                    substantial: substantialCount,
                    added, removed
                });

                res.write('data: [DONE]\n\n');
                res.end();
            } catch (err) {
                log.error('compare-fatal', err);
                try {
                    res.write(`data: ${JSON.stringify({ text: '\n\n⚠️ Системная ошибка сравнения документов. Повторите запрос.' })}\n\n`);
                    res.write('data: [DONE]\n\n');
                    res.end();
                } catch {}
            }
        });
    });

    app.use(router);
    log.info('compare-route-registered', { endpoint: '/api/compare-documents', rateLimitPerMin: 8 });
};
