// Smoke-test для Phase 3 (npaAliases + phase3 pure helpers + integration with mocks).
// Запуск: node lib/_smokeTestPhase3.js
const { normalizeNpaName, CANONICAL_NPAS } = require('./npaAliases');
const {
    createPhase3Pipeline,
    SPLITTER_BATCH_SIZE,
    HEAVY_THRESHOLD_CITATIONS,
    HEAVY_SELECT_TOP_N,
    _internal
} = require('./phase3');

const { buildBatches, classifyComplexity, buildSearchQuery, citationKey, validateCitations } = _internal;

let pass = 0, fail = 0;
function assert(cond, name, extra = '') {
    if (cond) { pass++; console.log('  PASS', name); }
    else      { fail++; console.log('  FAIL', name, extra); }
}

// ── npaAliases ──────────────────────────────────────────────────────────
console.log('=== TEST GROUP 1: normalizeNpaName ===');
assert(normalizeNpaName('УК КР') === 'УК КР', 'УК КР → УК КР (канонический)');
assert(normalizeNpaName('ук кр') === 'УК КР', 'lowercase: ук кр → УК КР');
assert(normalizeNpaName('Уголовный кодекс') === 'УК КР', 'полное → УК КР');
assert(normalizeNpaName('Уголовный кодекс КР') === 'УК КР', 'полное+КР → УК КР');
assert(normalizeNpaName('Уголовный кодекс Кыргызской Республики') === 'УК КР', 'полнейшее → УК КР');
assert(normalizeNpaName('ГК КР') === 'ГК КР', 'ГК КР → ГК КР');
assert(normalizeNpaName('Гражданский кодекс') === 'ГК КР', 'ГК полное → ГК КР');
assert(normalizeNpaName('Семейный кодекс КР') === 'СК КР', 'СК полное → СК КР');
assert(normalizeNpaName('КоАО') === 'КоАО КР', 'КоАО → КоАО КР');
assert(normalizeNpaName('КоАП') === 'КоАО КР', 'КоАП (синоним) → КоАО КР');
assert(normalizeNpaName('УК КР.') === 'УК КР', 'трейлинг точка обрезается');
assert(normalizeNpaName('  ук   кр ') === 'УК КР', 'лишние пробелы схлопываются');
assert(normalizeNpaName('') === '', 'пустая строка → ""');
assert(normalizeNpaName(null) === '', 'null → ""');
assert(normalizeNpaName(undefined) === '', 'undefined → ""');
assert(normalizeNpaName('Закон КР О банках') === 'Закон КР О банках', 'неизвестный НПА → возврат как есть');
assert(CANONICAL_NPAS.length >= 15, `словарь покрывает >= 15 НПА (got ${CANONICAL_NPAS.length})`);

// ── buildBatches ────────────────────────────────────────────────────────
console.log('\n=== TEST GROUP 2: buildBatches ===');
{
    const chunks = Array.from({ length: 60 }, (_, i) => `chunk-${i}-text`);
    const b = buildBatches(chunks, 25, 100000);
    assert(b.length === 3, `60 чанков / 25 = 3 батча (got ${b.length})`);
    assert(b[0].length === 25, 'батч 0: 25');
    assert(b[1].length === 25, 'батч 1: 25');
    assert(b[2].length === 10, 'батч 2: 10');
    assert(b[0][0].chunk_index === 0, 'индекс первого = 0');
    assert(b[2][9].chunk_index === 59, 'индекс последнего = 59');
}
{
    // char-guard: один гигантский чанк
    const chunks = ['x'.repeat(50000), 'y'.repeat(100), 'z'.repeat(100)];
    const b = buildBatches(chunks, 25, 45000);
    assert(b.length >= 2, `char-guard работает: гигант отделяется (got ${b.length})`);
}
{
    assert(buildBatches([]).length === 0, 'пустой → []');
    assert(buildBatches(null).length === 0, 'null → []');
}

// ── classifyComplexity ──────────────────────────────────────────────────
console.log('\n=== TEST GROUP 3: classifyComplexity ===');
assert(classifyComplexity({ citations: [] }) === 'simple', '0 citations → simple');
assert(classifyComplexity({ citations: new Array(10).fill({}) }) === 'simple', '10 citations → simple (граница)');
assert(classifyComplexity({ citations: new Array(11).fill({}) }) === 'heavy', '11 citations → heavy');
assert(classifyComplexity({ citations: new Array(50).fill({}) }) === 'heavy', '50 citations → heavy');
assert(classifyComplexity({}) === 'simple', 'нет поля citations → simple');
assert(HEAVY_THRESHOLD_CITATIONS === 10, 'константа = 10');
assert(HEAVY_SELECT_TOP_N === 5, 'HEAVY_SELECT_TOP_N = 5');

// ── buildSearchQuery ────────────────────────────────────────────────────
console.log('\n=== TEST GROUP 4: buildSearchQuery ===');
assert(buildSearchQuery({ npa: 'УК КР', article: '14', parts: [] }) === 'УК КР статья 14', 'базовый запрос');
assert(buildSearchQuery({ npa: 'УК КР', article: '14', parts: ['2'] }) === 'УК КР статья 14 часть 2', 'с частью');
assert(buildSearchQuery({ npa: 'УК КР', article: '14', parts: ['1', '2'] }) === 'УК КР статья 14 часть 1 2', 'с двумя частями');
assert(buildSearchQuery({ npa: '', article: '14' }) === 'статья 14', 'без НПА');

// ── citationKey ─────────────────────────────────────────────────────────
console.log('\n=== TEST GROUP 5: citationKey ===');
assert(citationKey('УК КР', '14') === citationKey('ук кр', '14'), 'регистр НПА не влияет');
assert(citationKey('УК КР', '14') !== citationKey('УК КР', '15'), 'разные статьи разные');
assert(citationKey('УК КР', ' 14 ') === citationKey('УК КР', '14'), 'trim статьи');

// ── validateCitations ───────────────────────────────────────────────────
console.log('\n=== TEST GROUP 6: validateCitations ===');
{
    const raw = [
        { npa: 'ук кр', article: '14', parts: [] },
        { npa: 'гк', article: '7', parts: ['2'] },
        { npa: 'ук', article: '', parts: [] },           // без статьи → отбрасывается
        { npa: 'неизвестный', article: '5', parts: [] }, // неизвестный → как есть
        null,                                              // мусор → отбрасывается
        { article: '99' }                                  // без npa → npa: ''
    ];
    const out = validateCitations(raw, normalizeNpaName);
    assert(out.length === 4, `4 валидные citations (got ${out.length})`);
    assert(out[0].npa === 'УК КР', 'нормализован ук кр → УК КР');
    assert(out[1].npa === 'ГК КР', 'нормализован гк → ГК КР');
    assert(out[1].parts[0] === '2', 'parts сохранены');
    assert(out[2].npa === 'неизвестный', 'неизвестный возвращён как есть');
}
assert(validateCitations(null, normalizeNpaName).length === 0, 'null → []');
assert(validateCitations('not array', normalizeNpaName).length === 0, 'string → []');

// ── Integration with mocks ──────────────────────────────────────────────
console.log('\n=== TEST GROUP 7: integration с моками ===');

// Хелперы моков
function makeMockCascade(splitterResp, selectorResp) {
    const calls = [];
    return {
        cascade: {
            async call(opts) {
                calls.push({ stage: opts.stageLabel, prompt: opts.userPrompt.slice(0, 50) });
                const isSelector = opts.stageLabel?.startsWith('adaptive_selector');
                return {
                    text: JSON.stringify(isSelector ? selectorResp : splitterResp),
                    model: 'mock', tier: 1, durationMs: 5, usage: {}
                };
            }
        },
        calls
    };
}
function makeFailingCascade() {
    return {
        async call() {
            const err = new Error('all tiers failed');
            err.allFailed = true;
            err.cascade = { errors: [{ tier: 1, errorKind: 'timeout' }] };
            throw err;
        }
    };
}
const mockGetEmbedding = async (q) => new Array(8).fill(0.1);
const mockSearchPinecone = async (vector, topK) => {
    // Каждый запрос возвращает topK моков
    return Array.from({ length: topK }, (_, i) => ({
        score: 0.9 - i * 0.05,
        metadata: {
            npa_title: 'УК КР',
            article: String(10 + i),
            full_text: `Полный текст статьи ${10 + i}`,
            article_title: `Заголовок статьи ${10 + i}`
        }
    }));
};
const mockSearchPineconeEmpty = async () => [];
const safeJsonParseStrict = (raw, fallback) => {
    try { return JSON.parse(raw); } catch (e) { return fallback; }
};
const runWithConcurrency = async (items, conc, taskFn, opts = {}) => {
    const results = new Array(items.length);
    let cursor = 0;
    async function worker() {
        while (true) {
            if (opts.aborted?.value) return;
            const i = cursor++;
            if (i >= items.length) return;
            try { results[i] = await taskFn(items[i], i); }
            catch (e) { results[i] = undefined; }
        }
    }
    const pool = Array.from({ length: Math.min(conc, items.length) }, () => worker());
    await Promise.all(pool);
    return results;
};
const sentSteps = [];
const mockSendStep = (res, step) => { if (res) sentSteps.push(step); };
const mockRes = {};

// TELEMETRY mock
function makeTelemetry() {
    const counters = {};
    const cascadeAttempts = [];
    const cascadeCounters = {};
    const times = {};
    const timers = {};
    return {
        startTimer(n) { timers[n] = Date.now(); },
        endTimer(n) { if (timers[n]) times[n] = (Date.now() - timers[n]) / 1000; },
        incrementCounter(k, d = 1) { counters[k] = (counters[k] || 0) + d; },
        incrementCascadeCounter(k) { cascadeCounters[k] = (cascadeCounters[k] || 0) + 1; },
        recordCascadeAttempt(a) { cascadeAttempts.push(a); },
        counters, cascadeAttempts, cascadeCounters, times
    };
}

// --- Сценарий А: чистый happy path с simple chunks ---
{
    sentSteps.length = 0;
    const { cascade, calls } = makeMockCascade({
        chunks_analysis: [
            { chunk_index: 0, citations: [{ npa: 'УК КР', article: '14', parts: [] }] },
            { chunk_index: 1, citations: [] }
        ]
    }, null);
    const pipeline = createPhase3Pipeline({
        lightLLMCascade: cascade,
        getEmbedding: mockGetEmbedding,
        searchPinecone: mockSearchPinecone,
        runWithConcurrency,
        safeJsonParseStrict,
        sendStep: mockSendStep,
        normalizeNpaName,
        logger: { info: () => {}, warn: () => {}, error: () => {} }
    });
    const telemetry = makeTelemetry();
    const { chunkAnalyses, degraded } = (async () => await pipeline.run({
        chunks: ['Текст пункта 1', 'Текст пункта 2'], telemetry, res: mockRes
    }))();
    // run возвращает Promise — await вручную
}

// Делаем нормальный async
(async () => {
    // --- Сценарий А продолжение ---
    {
        sentSteps.length = 0;
        const { cascade } = makeMockCascade({
            chunks_analysis: [
                { chunk_index: 0, citations: [{ npa: 'УК КР', article: '14', parts: [] }] },
                { chunk_index: 1, citations: [] }
            ]
        }, null);
        const pipeline = createPhase3Pipeline({
            lightLLMCascade: cascade,
            getEmbedding: mockGetEmbedding,
            searchPinecone: mockSearchPinecone,
            runWithConcurrency,
            safeJsonParseStrict,
            sendStep: mockSendStep,
            normalizeNpaName,
            logger: { info: () => {}, warn: () => {}, error: () => {} }
        });
        const telemetry = makeTelemetry();
        const { chunkAnalyses, degraded } = await pipeline.run({
            chunks: ['Текст пункта 1', 'Текст пункта 2'], telemetry, res: mockRes
        });
        assert(degraded === false, '7A: happy path не degraded');
        assert(chunkAnalyses.length === 2, '7A: 2 chunk analyses');
        assert(chunkAnalyses[0].citations.length === 1, '7A: chunk 0 имеет 1 citation');
        assert(chunkAnalyses[0].complexity === 'simple', '7A: chunk 0 simple');
        assert(chunkAnalyses[0].relevant_articles.length === 1, '7A: chunk 0 получил 1 article из Pinecone');
        assert(chunkAnalyses[0].relevant_articles[0].source === 'simple', '7A: source = simple');
        assert(sentSteps.length === 0, '7A: SSE warning НЕ отправлен (нет degraded)');
        assert(telemetry.counters.simple_path_chunks === 2, '7A: telemetry simple_path_chunks=2');
        assert(telemetry.counters.heavy_path_chunks === undefined || telemetry.counters.heavy_path_chunks === 0, '7A: 0 heavy');
    }

    // --- Сценарий B: каскад полностью лёг → degraded + SSE warning ---
    {
        sentSteps.length = 0;
        const pipeline = createPhase3Pipeline({
            lightLLMCascade: makeFailingCascade(),
            getEmbedding: mockGetEmbedding,
            searchPinecone: mockSearchPinecone,
            runWithConcurrency,
            safeJsonParseStrict,
            sendStep: mockSendStep,
            normalizeNpaName,
            logger: { info: () => {}, warn: () => {}, error: () => {} }
        });
        const telemetry = makeTelemetry();
        const { chunkAnalyses, degraded } = await pipeline.run({
            chunks: ['пункт раз', 'пункт два'], telemetry, res: mockRes
        });
        assert(degraded === true, '7B: degraded=true когда каскад all_failed');
        assert(sentSteps.length === 1, '7B: ровно 1 SSE warning');
        assert(sentSteps[0].status === 'warning', '7B: status=warning');
        assert(sentSteps[0].id === 'phase3_degraded', '7B: id=phase3_degraded');
        assert(/режим базового анализа/.test(sentSteps[0].text), '7B: текст содержит "режим базового анализа"');
        assert(chunkAnalyses.every(ca => ca.citations.length === 0), '7B: все citations пустые');
        assert(chunkAnalyses.every(ca => ca.degraded === true), '7B: все chunks помечены degraded');
    }

    // --- Сценарий C: heavy path (12 citations → selector → 5) ---
    {
        sentSteps.length = 0;
        // 12 citations в chunk_index 0 → heavy
        const splitterResp = {
            chunks_analysis: [{
                chunk_index: 0,
                citations: Array.from({ length: 12 }, (_, i) => ({
                    npa: 'УК КР', article: String(100 + i), parts: []
                }))
            }]
        };
        // Selector возвращает первые 5 из кандидатов
        // (мок Pinecone даёт 15 кандидатов на каждую из 12 citations — дедуп по article)
        const selectorResp = {
            selected: Array.from({ length: 5 }, (_, i) => ({
                npa: 'УК КР', article: String(10 + i)
            }))
        };
        const { cascade, calls } = makeMockCascade(splitterResp, selectorResp);
        const pipeline = createPhase3Pipeline({
            lightLLMCascade: cascade,
            getEmbedding: mockGetEmbedding,
            searchPinecone: mockSearchPinecone,
            runWithConcurrency,
            safeJsonParseStrict,
            sendStep: mockSendStep,
            normalizeNpaName,
            logger: { info: () => {}, warn: () => {}, error: () => {} }
        });
        const telemetry = makeTelemetry();
        const { chunkAnalyses, degraded } = await pipeline.run({
            chunks: ['тяжёлый пункт с 12 ссылками на статьи'], telemetry, res: mockRes
        });
        assert(degraded === false, '7C: heavy happy → не degraded');
        assert(chunkAnalyses[0].complexity === 'heavy', '7C: complexity=heavy');
        assert(chunkAnalyses[0].relevant_articles.length === HEAVY_SELECT_TOP_N,
            `7C: relevant_articles=${HEAVY_SELECT_TOP_N} (got ${chunkAnalyses[0].relevant_articles.length})`);
        assert(chunkAnalyses[0].relevant_articles.every(a => a.source === 'heavy_selected'), '7C: source=heavy_selected');
        const selectorCalls = calls.filter(c => c.stage.startsWith('adaptive_selector'));
        assert(selectorCalls.length === 1, `7C: 1 вызов selector'а (got ${selectorCalls.length})`);
        assert(telemetry.counters.heavy_path_chunks === 1, '7C: heavy_path_chunks=1');
        assert(telemetry.counters.pinecone_heavy_pass1_queries === 12, '7C: 12 pass1 queries (по 1 на каждую из 12 citations)');
    }

    // --- Сценарий D: Pinecone полностью пустой → relevant_articles=[] но не падает ---
    {
        sentSteps.length = 0;
        const { cascade } = makeMockCascade({
            chunks_analysis: [{ chunk_index: 0, citations: [{ npa: 'УК КР', article: '14', parts: [] }] }]
        }, null);
        const pipeline = createPhase3Pipeline({
            lightLLMCascade: cascade,
            getEmbedding: mockGetEmbedding,
            searchPinecone: mockSearchPineconeEmpty,
            runWithConcurrency,
            safeJsonParseStrict,
            sendStep: mockSendStep,
            normalizeNpaName,
            logger: { info: () => {}, warn: () => {}, error: () => {} }
        });
        const { chunkAnalyses, degraded } = await pipeline.run({
            chunks: ['пункт'], telemetry: makeTelemetry(), res: mockRes
        });
        assert(degraded === false, '7D: пустой Pinecone не считается degraded (это валидный сценарий "статья не найдена")');
        assert(chunkAnalyses[0].citations.length === 1, '7D: citations всё ещё извлечены');
        assert(chunkAnalyses[0].relevant_articles.length === 0, '7D: relevant_articles=[]');
    }

    // --- Сценарий E: битый JSON от LLM splitter → empty citations, без падения ---
    {
        sentSteps.length = 0;
        const cascade = {
            async call() { return { text: 'это не JSON 😈 broken{{{', model: 'mock', tier: 1, durationMs: 1, usage: {} }; }
        };
        const pipeline = createPhase3Pipeline({
            lightLLMCascade: cascade,
            getEmbedding: mockGetEmbedding,
            searchPinecone: mockSearchPinecone,
            runWithConcurrency,
            safeJsonParseStrict,
            sendStep: mockSendStep,
            normalizeNpaName,
            logger: { info: () => {}, warn: () => {}, error: () => {} }
        });
        const { chunkAnalyses, degraded } = await pipeline.run({
            chunks: ['пункт'], telemetry: makeTelemetry(), res: mockRes
        });
        assert(degraded === false, '7E: битый JSON не считается полным degraded (только пустой результат батча)');
        assert(chunkAnalyses[0].citations.length === 0, '7E: citations пустые при битом JSON');
        assert(chunkAnalyses.length === 1, '7E: chunk не потерян');
    }

    // --- Сценарий F: дубликаты SSE warning (один upload, две деградации) — только 1 warning ---
    {
        sentSteps.length = 0;
        const pipeline = createPhase3Pipeline({
            lightLLMCascade: makeFailingCascade(),
            getEmbedding: mockGetEmbedding,
            searchPinecone: mockSearchPinecone,
            runWithConcurrency,
            safeJsonParseStrict,
            sendStep: mockSendStep,
            normalizeNpaName,
            logger: { info: () => {}, warn: () => {}, error: () => {} }
        });
        // 30 чанков = 2 батча → каскад провалится на обоих → 2 degraded'а, но warning только 1
        const chunks = Array.from({ length: 30 }, (_, i) => `пункт ${i}`);
        const { degraded } = await pipeline.run({ chunks, telemetry: makeTelemetry(), res: mockRes });
        assert(degraded === true, '7F: degraded на 30 чанках');
        assert(sentSteps.length === 1, `7F: warning отправлен ровно 1 раз (got ${sentSteps.length})`);
    }

    console.log(`\n========== ИТОГ: ${pass} pass, ${fail} fail ==========`);
    process.exit(fail === 0 ? 0 : 1);
})();
