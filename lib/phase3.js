// ═══════════════════════════════════════════════════════════════════════
//  lib/phase3.js
//  Phase 3: Batched Issue Splitter + Adaptive RAG
//  Selective Reasoning v2.0 — сердце рефакторинга
// ═══════════════════════════════════════════════════════════════════════
//
//  Конвейер:
//   1. buildBatches(chunks) — синхронно режем chunks на батчи по
//      SPLITTER_BATCH_SIZE с дополнительным char-guard'ом.
//   2. runSplitter(batches) — для каждого батча: lightLLMCascade → JSON →
//      validateAndNormalize. Граф деградации: cascade.allFailed → пустой
//      citations[] для всего батча, всё продолжается.
//   3. classifyComplexity(ca) — citations.length > HEAVY_THRESHOLD = heavy.
//   4. runAdaptiveRetrieval:
//      - Simple (citations <= 10): runWithConcurrency(8) поверх ВСЕХ
//        citations всех simple-chunks. TOP_K=1 на каждую.
//      - Heavy (citations > 10):
//        pass1: TOP_K=15 на каждую citation (для построения списка кандидатов).
//        selector: lightLLMCascade выбирает HEAVY_SELECT_TOP_N статей.
//        pass2: ИСПОЛЬЗУЕМ УЖЕ ПОЛУЧЕННЫЕ ТЕКСТЫ ИЗ PASS1 (см. NB).
//   5. mergeContextIntoChunks — relevant_articles[] прикрепляем к ca.
//
//  NB (отклонение от ТЗ): ТЗ говорит "pass1 = только метаданные,
//  pass2 = полные тексты выбранных 5". Наш searchPinecone всегда
//  возвращает FULL metadata (includeMetadata: true), отдельной "title-only"
//  опции у нашего Pinecone-индекса нет. Поэтому полный текст уже есть в
//  pass1 → второй вызов в Pinecone бессмыслен (та же сетевая стоимость, тот
//  же ответ). Экономия: -N запросов в Pinecone на heavy-chunk.
//  Это явное упрощение, безопасное, идентичное по конечному результату.
//
//  Принцип graceful degradation на каждом шаге:
//   • cascade allFailed на splitter-батче → batch.citations = [] (degraded флаг)
//   • cascade allFailed на selector → fallback: top-N кандидатов по score
//   • searchPinecone один промах → skip конкретную citation, остальное идёт
//   • searchPinecone полностью лёг → relevant_articles: [] для всех (degraded)
//   • Битый JSON от splitter → safeJsonParseStrict даёт пустой ответ
//
//  SSE-warning юзеру (через sendStep):
//    если ЛЮБОЙ шаг ушёл в degraded → один раз шлём:
//      { id: 'phase3_degraded', status: 'warning',
//        text: 'Переход в режим базового анализа (внешний сервис временно недоступен).' }
// ═══════════════════════════════════════════════════════════════════════

const { performance } = require('perf_hooks');

// ── Конфигурируемые константы (тюнинг без ковыряния в коде) ─────────────
const SPLITTER_BATCH_SIZE         = 25;      // chunks/batch (между 20-30 из ТЗ)
const SPLITTER_BATCH_CHAR_LIMIT   = 45000;   // guard от перегрузки контекста Flash Lite
const HEAVY_THRESHOLD_CITATIONS   = 10;      // > 10 → heavy path
const HEAVY_SELECT_TOP_N          = 5;       // Adaptive Selector выбирает 5 статей
const HEAVY_PASS1_TOP_K           = 15;      // первый pass: 15 кандидатов на citation
const SIMPLE_PINECONE_CONCURRENCY = 8;       // p-limit для Pinecone simple-path
const SELECTOR_CHUNK_PREVIEW_CHARS = 2000;   // сколько символов чанка отдаём селектору

// ── Промпты (вынесены константами для KVCache + читаемости) ─────────────
const SPLITTER_SYSTEM_PROMPT = `Ты — юридический анализатор кыргызстанских документов. Твоя задача — извлечь упоминания НПА (нормативно-правовых актов), статей и частей из переданных пунктов документа.

ЖЁСТКИЕ ПРАВИЛА:
1. Верни ответ СТРОГО в формате JSON. Никаких markdown-блоков, пояснений, преамбул вне JSON.
2. Для КАЖДОЙ отдельной статьи создавай отдельный объект в массиве citations. НИКОГДА не группируй номера статей в одну строку (не "10-12", а три объекта: "10", "11", "12").
3. Если пункт не содержит упоминаний НПА — верни пустой массив citations.
4. Если упомянута статья без указания НПА — оставь npa: "" (пустая строка).
5. parts — массив СТРОК-номеров частей (например ["1", "2"]) или [] если части не указаны.
6. Для каждого пункта верни объект с тем же chunk_index, что был во входных данных.
7. Если входной пункт явно содержит несколько citations — все они должны попасть в citations этого chunk_index'а.

Схема ответа:
{
  "chunks_analysis": [
    {
      "chunk_index": <number>,
      "citations": [
        { "npa": "<строка>", "article": "<строка>", "parts": [<строки>] }
      ]
    }
  ]
}

Пример:
Вход: [{"chunk_index": 0, "text": "В соответствии со ст. 14, 15 УК КР и п. 2 ст. 7 ГК КР..."}]
Выход:
{
  "chunks_analysis": [
    {
      "chunk_index": 0,
      "citations": [
        { "npa": "УК КР", "article": "14", "parts": [] },
        { "npa": "УК КР", "article": "15", "parts": [] },
        { "npa": "ГК КР", "article": "7", "parts": ["2"] }
      ]
    }
  ]
}`;

const SELECTOR_SYSTEM_PROMPT = `Ты — юридический эксперт по кыргызстанскому праву. Тебе передан текст пункта документа и список статей-кандидатов из базы НПА. Твоя задача — выбрать ровно ${HEAVY_SELECT_TOP_N} САМЫХ КРИТИЧНЫХ статей для глубокого анализа этого пункта.

ЖЁСТКИЕ ПРАВИЛА:
1. Верни ответ СТРОГО в формате JSON. Никаких пояснений вне JSON.
2. selected — массив из РОВНО ${HEAVY_SELECT_TOP_N} объектов с полями npa и article.
3. Значения npa и article должны ТОЧНО совпадать с одним из объектов в списке кандидатов (не выдумывай новые).
4. Сортируй по убыванию критичности: первая запись — самая важная.

Схема ответа:
{
  "selected": [
    { "npa": "<строка>", "article": "<строка>" }
  ]
}`;

// ═══════════════════════════════════════════════════════════════════════
//  Pure helpers (без side effects, легко тестируются)
// ═══════════════════════════════════════════════════════════════════════

function buildBatches(chunks, maxItems = SPLITTER_BATCH_SIZE, maxChars = SPLITTER_BATCH_CHAR_LIMIT) {
    if (!Array.isArray(chunks) || chunks.length === 0) return [];
    const batches = [];
    let cur = [];
    let curChars = 0;
    for (let i = 0; i < chunks.length; i++) {
        const text = String(chunks[i] || '');
        const len = text.length;
        const wouldOverflow = cur.length >= maxItems || (curChars + len > maxChars && cur.length > 0);
        if (wouldOverflow) {
            batches.push(cur);
            cur = [];
            curChars = 0;
        }
        cur.push({ chunk_index: i, text });
        curChars += len;
    }
    if (cur.length > 0) batches.push(cur);
    return batches;
}

function classifyComplexity(chunkAnalysis) {
    const n = Array.isArray(chunkAnalysis?.citations) ? chunkAnalysis.citations.length : 0;
    return n > HEAVY_THRESHOLD_CITATIONS ? 'heavy' : 'simple';
}

function buildSearchQuery(citation) {
    const parts = [];
    if (citation.npa) parts.push(citation.npa);
    if (citation.article) parts.push(`статья ${citation.article}`);
    if (Array.isArray(citation.parts) && citation.parts.length > 0) {
        parts.push(`часть ${citation.parts.join(' ')}`);
    }
    return parts.join(' ').trim();
}

function citationKey(npa, article) {
    return `${String(npa || '').toLowerCase().trim()}::${String(article || '').trim()}`;
}

// Валидация одного `chunks_analysis[i]` объекта от LLM. Возвращает массив citations.
// Невалидные citations выбрасываются по одному — chunk остаётся, но без них.
function validateCitations(rawCitations, normalizeNpaName) {
    if (!Array.isArray(rawCitations)) return [];
    const out = [];
    for (const c of rawCitations) {
        if (!c || typeof c !== 'object') continue;
        const article = String(c.article || '').trim();
        if (!article) continue; // citation без статьи бессмысленна
        const npa = normalizeNpaName(c.npa || '');
        const parts = Array.isArray(c.parts)
            ? c.parts.map(p => String(p).trim()).filter(Boolean)
            : [];
        out.push({ npa, article, parts });
    }
    return out;
}

// ═══════════════════════════════════════════════════════════════════════
//  Factory: createPhase3Pipeline(deps)
// ═══════════════════════════════════════════════════════════════════════

function createPhase3Pipeline(deps) {
    const {
        lightLLMCascade,
        getEmbedding,
        searchPinecone,
        runWithConcurrency,
        safeJsonParseStrict,
        sendStep,
        normalizeNpaName,
        logger = console
    } = deps || {};

    if (!lightLLMCascade?.call) throw new Error('[Phase3] lightLLMCascade обязателен');
    if (typeof getEmbedding !== 'function') throw new Error('[Phase3] getEmbedding обязателен');
    if (typeof searchPinecone !== 'function') throw new Error('[Phase3] searchPinecone обязателен');
    if (typeof runWithConcurrency !== 'function') throw new Error('[Phase3] runWithConcurrency обязателен');
    if (typeof safeJsonParseStrict !== 'function') throw new Error('[Phase3] safeJsonParseStrict обязателен');
    if (typeof normalizeNpaName !== 'function') throw new Error('[Phase3] normalizeNpaName обязателен');

    // ── Граница degraded-режима с одноразовым SSE-уведомлением юзера ────
    function emitDegradedWarningOnce(res, state) {
        if (state.warned || !res || !sendStep) return;
        state.warned = true;
        try {
            sendStep(res, {
                id: 'phase3_degraded',
                status: 'warning',
                text: 'Переход в режим базового анализа (внешний сервис временно недоступен).'
            });
        } catch (e) {
            logger.warn?.('[Phase3] не удалось отправить warning SSE: ' + e.message);
        }
    }

    // ── Splitter: батч-вызов каскада, парсинг, нормализация ─────────────
    async function runSplitter({ chunks, telemetry, res, aborted, degradedState }) {
        const batches = buildBatches(chunks);
        const chunkAnalyses = chunks.map((text, idx) => ({
            chunk_index: idx,
            chunk_text: text,
            citations: [],
            complexity: 'simple',
            degraded: false,
            relevant_articles: []
        }));

        if (telemetry) telemetry.startTimer('Phase3_Splitter_Total');

        for (let bi = 0; bi < batches.length; bi++) {
            if (aborted?.value) break;
            const batch = batches[bi];
            const stageLabel = `splitter_batch_${bi}`;
            const tBatchStart = performance.now();

            const userPrompt = JSON.stringify(
                batch.map(b => ({ chunk_index: b.chunk_index, text: b.text }))
            );

            let parsed = null;
            try {
                const result = await lightLLMCascade.call({
                    systemPrompt: SPLITTER_SYSTEM_PROMPT,
                    userPrompt,
                    jsonMode: true,
                    telemetry,
                    stageLabel
                });
                parsed = safeJsonParseStrict(result.text, { chunks_analysis: [] });
            } catch (err) {
                if (err && err.allFailed) {
                    // Каскад полностью лёг для этого батча → graceful degradation
                    logger.warn?.(`[Phase3 Splitter] batch ${bi} cascade.allFailed → empty citations`);
                    for (const item of batch) {
                        chunkAnalyses[item.chunk_index].degraded = true;
                    }
                    degradedState.any = true;
                    emitDegradedWarningOnce(res, degradedState);
                    parsed = { chunks_analysis: [] };
                } else {
                    // Неожиданная ошибка (не из каскада) — логируем но не падаем
                    logger.error?.(`[Phase3 Splitter] batch ${bi} unexpected error: ${err?.message?.slice(0, 200)}`);
                    parsed = { chunks_analysis: [] };
                }
            }

            // Merge результатов батча обратно в chunkAnalyses по chunk_index
            const analyses = Array.isArray(parsed?.chunks_analysis) ? parsed.chunks_analysis : [];
            for (const a of analyses) {
                if (typeof a?.chunk_index !== 'number') continue;
                const target = chunkAnalyses[a.chunk_index];
                if (!target) continue;
                target.citations = validateCitations(a.citations, normalizeNpaName);
            }

            const tBatchDur = performance.now() - tBatchStart;
            if (telemetry?.incrementCounter) telemetry.incrementCounter('phase3_splitter_batches');
            logger.info?.(`[Phase3 Splitter] batch ${bi}/${batches.length - 1} done in ${tBatchDur.toFixed(0)}ms (${batch.length} chunks)`);
        }

        if (telemetry) telemetry.endTimer('Phase3_Splitter_Total');
        return chunkAnalyses;
    }

    // ── Adaptive Retrieval: simple-path (TOP_K=1 параллельно) ───────────
    async function runSimplePath(chunkAnalyses, telemetry, aborted) {
        // Уплощаем все citations простых чанков в одну очередь с backref на ca
        const queue = [];
        for (const ca of chunkAnalyses) {
            if (ca.complexity !== 'simple') continue;
            if (!Array.isArray(ca.citations) || ca.citations.length === 0) continue;
            for (const citation of ca.citations) {
                queue.push({ ca, citation });
            }
        }
        if (queue.length === 0) return;

        if (telemetry) telemetry.startTimer('Phase3_Simple_Pinecone');
        const results = await runWithConcurrency(queue, SIMPLE_PINECONE_CONCURRENCY, async (item) => {
            if (aborted?.value) return null;
            try {
                const query = buildSearchQuery(item.citation);
                if (!query) return null;
                const vector = await getEmbedding(query);
                if (!vector) return null;
                const matches = await searchPinecone(vector, query, 1);
                if (telemetry?.incrementCounter) telemetry.incrementCounter('db_simple_queries');
                return { ca: item.ca, citation: item.citation, match: matches?.[0] || null };
            } catch (e) {
                logger.warn?.(`[Phase3 simple] citation query failed: ${e.message?.slice(0, 80)}`);
                return null;
            }
        }, { aborted });
        if (telemetry) telemetry.endTimer('Phase3_Simple_Pinecone');

        // Дедуп по (npa, article) внутри chunk — на случай если LLM продублировал
        for (const r of (results || [])) {
            if (!r || !r.match) continue;
            const meta = r.match.metadata || {};
            const article = {
                npa: normalizeNpaName(meta.npa_title || r.citation.npa || ''),
                article: String(meta.article || r.citation.article || '').trim(),
                articleTitle: String(meta.article_title || '').trim(),
                parts: r.citation.parts || [],
                fullText: meta.full_text || '',
                dbScore: r.match.score || 0,
                source: 'simple'
            };
            const key = citationKey(article.npa, article.article);
            const existing = r.ca.relevant_articles.find(a => citationKey(a.npa, a.article) === key);
            if (!existing) r.ca.relevant_articles.push(article);
        }
    }

    // ── Adaptive Retrieval: heavy-path для одного chunk ─────────────────
    async function runHeavyForChunk(ca, telemetry, res, aborted, degradedState) {
        // PASS 1: TOP_K=15 на каждую citation → собираем пул кандидатов
        if (telemetry) telemetry.startTimer(`Phase3_Heavy_Pass1_c${ca.chunk_index}`);
        const pass1 = await runWithConcurrency(ca.citations, SIMPLE_PINECONE_CONCURRENCY, async (citation) => {
            if (aborted?.value) return [];
            try {
                const query = buildSearchQuery(citation);
                if (!query) return [];
                const vector = await getEmbedding(query);
                if (!vector) return [];
                const matches = await searchPinecone(vector, query, HEAVY_PASS1_TOP_K);
                if (telemetry?.incrementCounter) telemetry.incrementCounter('db_heavy_pass1_queries');
                return matches || [];
            } catch (e) {
                logger.warn?.(`[Phase3 heavy pass1] failed: ${e.message?.slice(0, 80)}`);
                return [];
            }
        }, { aborted });
        if (telemetry) telemetry.endTimer(`Phase3_Heavy_Pass1_c${ca.chunk_index}`);

        // Дедуп кандидатов по (npa, article), сортируем по score
        const seen = new Map();
        for (const matches of (pass1 || [])) {
            for (const m of (matches || [])) {
                const meta = m.metadata || {};
                const npa = normalizeNpaName(meta.npa_title || '');
                const article = String(meta.article || '').trim();
                if (!article) continue;
                const key = citationKey(npa, article);
                const cur = seen.get(key);
                const cand = {
                    npa,
                    article,
                    title: String(meta.article_title || '').slice(0, 200),
                    fullText: meta.full_text || '',
                    score: m.score || 0
                };
                if (!cur || cand.score > cur.score) seen.set(key, cand);
            }
        }
        const candidates = Array.from(seen.values()).sort((a, b) => b.score - a.score);

        if (candidates.length === 0) {
            ca.relevant_articles = [];
            return;
        }

        // SELECTOR: каскад выбирает HEAVY_SELECT_TOP_N
        let selectedSet = null;
        if (candidates.length > HEAVY_SELECT_TOP_N) {
            if (telemetry) telemetry.startTimer(`Phase3_Selector_c${ca.chunk_index}`);
            try {
                const selectorUser =
                    `Текст пункта документа:\n"${ca.chunk_text.slice(0, SELECTOR_CHUNK_PREVIEW_CHARS)}"\n\n` +
                    `Кандидаты (${candidates.length}):\n` +
                    JSON.stringify(candidates.map(c => ({ npa: c.npa, article: c.article, title: c.title })));
                const result = await lightLLMCascade.call({
                    systemPrompt: SELECTOR_SYSTEM_PROMPT,
                    userPrompt: selectorUser,
                    jsonMode: true,
                    telemetry,
                    stageLabel: `adaptive_selector_c${ca.chunk_index}`
                });
                const parsed = safeJsonParseStrict(result.text, { selected: [] });
                const selected = Array.isArray(parsed?.selected) ? parsed.selected : [];
                selectedSet = new Set(
                    selected.map(s => citationKey(normalizeNpaName(s?.npa || ''), s?.article || ''))
                );
            } catch (err) {
                if (err?.allFailed) {
                    degradedState.any = true;
                    emitDegradedWarningOnce(res, degradedState);
                }
                logger.warn?.(`[Phase3 Selector] chunk ${ca.chunk_index} fallback by score: ${err?.message?.slice(0, 80)}`);
                selectedSet = null; // fallback по score ниже
            }
            if (telemetry) telemetry.endTimer(`Phase3_Selector_c${ca.chunk_index}`);
        }

        // Сборка финального списка: сначала те что выбрал LLM, потом добор по score
        let chosen = [];
        if (selectedSet && selectedSet.size > 0) {
            chosen = candidates.filter(c => selectedSet.has(citationKey(c.npa, c.article)));
        }
        // Добор до HEAVY_SELECT_TOP_N: top по score, исключая уже выбранные
        if (chosen.length < HEAVY_SELECT_TOP_N) {
            const have = new Set(chosen.map(c => citationKey(c.npa, c.article)));
            for (const c of candidates) {
                if (chosen.length >= HEAVY_SELECT_TOP_N) break;
                const k = citationKey(c.npa, c.article);
                if (!have.has(k)) {
                    chosen.push(c);
                    have.add(k);
                }
            }
        }
        // Обрезаем если LLM вернул больше N
        if (chosen.length > HEAVY_SELECT_TOP_N) chosen = chosen.slice(0, HEAVY_SELECT_TOP_N);

        // NB: pass2 в Pinecone не делаем — fullText уже есть из pass1.
        ca.relevant_articles = chosen.map(c => ({
            npa: c.npa,
            article: c.article,
            articleTitle: c.title || '',
            parts: [],
            fullText: c.fullText,
            pineconeScore: c.score,
            source: 'heavy_selected'
        }));
    }

    // ── Adaptive Retrieval: classify + simple + heavy ───────────────────
    async function runAdaptiveRetrieval({ chunkAnalyses, telemetry, res, aborted, degradedState }) {
        if (telemetry) telemetry.startTimer('Phase3_Adaptive_Total');

        // Classify
        let simpleCount = 0, heavyCount = 0;
        for (const ca of chunkAnalyses) {
            ca.complexity = classifyComplexity(ca);
            if (ca.complexity === 'simple') simpleCount++; else heavyCount++;
        }
        if (telemetry?.incrementCounter) {
            telemetry.incrementCounter('simple_path_chunks', simpleCount);
            telemetry.incrementCounter('heavy_path_chunks', heavyCount);
        }
        logger.info?.(`[Phase3 Retrieval] simple=${simpleCount} heavy=${heavyCount}`);

        // Simple path — параллельный pool на 8
        try {
            await runSimplePath(chunkAnalyses, telemetry, aborted);
        } catch (e) {
            // Не должно случиться (runWithConcurrency глотает per-item ошибки),
            // но если случилось — считаем это полным провалом Pinecone.
            logger.error?.(`[Phase3 Retrieval] simple-path crash: ${e?.message?.slice(0, 200)}`);
            degradedState.any = true;
            emitDegradedWarningOnce(res, degradedState);
        }

        // Heavy path — последовательно по чанкам (каждый = свой LLM Selector)
        for (const ca of chunkAnalyses) {
            if (aborted?.value) break;
            if (ca.complexity !== 'heavy') continue;
            try {
                await runHeavyForChunk(ca, telemetry, res, aborted, degradedState);
            } catch (e) {
                logger.warn?.(`[Phase3 Retrieval] heavy chunk ${ca.chunk_index} failed: ${e?.message?.slice(0, 200)}`);
                ca.degraded = true;
                ca.relevant_articles = [];
            }
        }

        if (telemetry) telemetry.endTimer('Phase3_Adaptive_Total');
    }

    // ── Главный entrypoint Phase 3 ──────────────────────────────────────
    async function run({ chunks, telemetry, res = null, aborted = null }) {
        if (!Array.isArray(chunks) || chunks.length === 0) {
            return { chunkAnalyses: [], degraded: false };
        }

        const degradedState = { any: false, warned: false };

        // STEP 1: Splitter
        const chunkAnalyses = await runSplitter({
            chunks, telemetry, res, aborted, degradedState
        });

        if (aborted?.value) {
            return { chunkAnalyses, degraded: degradedState.any };
        }

        // STEP 2: Adaptive Retrieval
        await runAdaptiveRetrieval({
            chunkAnalyses, telemetry, res, aborted, degradedState
        });

        return { chunkAnalyses, degraded: degradedState.any };
    }

    return {
        run,
        // Внутренности — для отладки / частичных вызовов в тестах:
        runSplitter,
        runAdaptiveRetrieval,
        runHeavyForChunk
    };
}

module.exports = {
    createPhase3Pipeline,
    // Константы — экспортируем для тестов и для возможного override через ENV
    SPLITTER_BATCH_SIZE,
    SPLITTER_BATCH_CHAR_LIMIT,
    HEAVY_THRESHOLD_CITATIONS,
    HEAVY_SELECT_TOP_N,
    HEAVY_PASS1_TOP_K,
    SIMPLE_PINECONE_CONCURRENCY,
    // Pure helpers — экспортируем для юнит-тестов
    _internal: {
        buildBatches,
        classifyComplexity,
        buildSearchQuery,
        citationKey,
        validateCitations,
        SPLITTER_SYSTEM_PROMPT,
        SELECTOR_SYSTEM_PROMPT
    }
};
