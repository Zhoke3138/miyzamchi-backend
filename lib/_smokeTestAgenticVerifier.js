// ═══════════════════════════════════════════════════════════════════════
//  _smokeTestAgenticVerifier.js
//  Smoke-test для lib/agenticVerifier.js.
//  Запуск: node lib/_smokeTestAgenticVerifier.js
// ═══════════════════════════════════════════════════════════════════════
//
//  Стратегия: подменяем callGeminiSingle / callDeepSeekSingle через
//  monkey-patch модуля llmCascade. Это позволяет проверить весь tool-loop
//  без сетевых вызовов. Все тесты — sequential (один общий async IIFE).
// ═══════════════════════════════════════════════════════════════════════

const llmCascade = require('./llmCascade');

let mockGeminiQueue = [];   // массив функций: (opts) => result | throws
let mockDeepSeekQueue = []; // массив функций: (opts) => { text, usage }

const originalCallGeminiSingle = llmCascade.callGeminiSingle;
const originalCallDeepSeekSingle = llmCascade.callDeepSeekSingle;

llmCascade.callGeminiSingle = async function (opts) {
    const fn = mockGeminiQueue.shift();
    if (!fn) throw new Error('[mockGemini] queue empty');
    return fn(opts);
};
llmCascade.callDeepSeekSingle = async function (opts) {
    const fn = mockDeepSeekQueue.shift();
    if (!fn) throw new Error('[mockDeepSeek] queue empty');
    return fn(opts);
};

const {
    createAgenticVerifier,
    SEARCH_TOOL,
    TOOL_PROTOCOL_BLOCK
} = require('./agenticVerifier');

let pass = 0, fail = 0;
function assert(cond, name, extra = '') {
    if (cond) { pass++; console.log('  PASS', name); }
    else      { fail++; console.log('  FAIL', name, extra); }
}

function resetMocks() {
    mockGeminiQueue = [];
    mockDeepSeekQueue = [];
}

function makeMockDeps(overrides = {}) {
    return {
        getNextKey: () => 'fake-key',
        searchPinecone: async () => [
            { score: 0.92, metadata: { npa_title: 'УК КР', article_title: 'Статья 137', full_text: 'Текст статьи 137 УК КР' } },
            { score: 0.88, metadata: { npa_title: 'УК КР', article_title: 'Статья 191', full_text: 'Текст статьи 191 УК КР' } },
            { score: 0.55, metadata: { npa_title: 'Закон о рекламе', article_title: 'Статья 5', full_text: 'Текст про рекламу' } }
        ],
        getEmbedding: async () => [0.1, 0.2, 0.3],
        deepseekJsonCall: async () => '{}',
        deepseekEnabled: true,
        buildHCREmbeddingQuery: (text, passport, topology) => {
            const macro = passport ? `[Документ: ${passport.title}] ` : '';
            const meso = topology ? `[п.${topology.chunkIndex}/${topology.totalChunks}] ` : '';
            return macro + meso + text;
        },
        throttle: null,
        logger: { warn: () => {}, info: () => {} },
        ...overrides
    };
}

function geminiTextResponse(text) {
    return {
        text,
        candidates: [{ content: { parts: [{ text }] } }],
        usage: { promptTokens: 100, completionTokens: 50 }
    };
}
function geminiFunctionCallResponse(name, args) {
    return {
        text: '',
        candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }],
        usage: { promptTokens: 100, completionTokens: 30 }
    };
}

function makeBaseRunOpts(overrides = {}) {
    return {
        baseSystemPrompt: 'Ты юрист КР. ' + TOOL_PROTOCOL_BLOCK,
        userPrompt: 'Проверь пункт: "обязуется уплатить 1% в день".',
        passport: { title: 'Договор оказания услуг', docType: 'contract', expectedNpas: ['ГК КР'] },
        topology: { chunkIndex: 7, totalChunks: 23, section: 'Ответственность' },
        targetType: 'general',
        textHead: 'обязуется уплатить 1% в день',
        telemetry: null,
        stageLabel: 'test',
        aborted: { value: false },
        ...overrides
    };
}

(async () => {

// ═══════════════════════════════════════════════════════════════════════
console.log('=== TEST 1: SEARCH_TOOL и DI guards ===');
{
    assert(SEARCH_TOOL.name === 'search_legislation_kg', 'SEARCH_TOOL.name корректен');
    assert(SEARCH_TOOL.parameters.required.includes('query'), 'query обязателен');
    assert(typeof TOOL_PROTOCOL_BLOCK === 'string' && TOOL_PROTOCOL_BLOCK.includes('search_legislation_kg'), 'TOOL_PROTOCOL_BLOCK содержит имя функции');
    assert(TOOL_PROTOCOL_BLOCK.includes('false positive'), 'TOOL_PROTOCOL_BLOCK инструктирует игнорировать false positives');
    // 2026-06-02: ЖЕЛЕЗНЫЕ ПРАВИЛА — изоляция юрисдикций, маршрутизация поиска, презумпция правоты
    assert(TOOL_PROTOCOL_BLOCK.includes('ИЗОЛЯЦИЯ ЮРИСДИКЦИЙ'),
        '🛑 Правило №1: изоляция юрисдикций (МПГПП ≠ УПК КР с тем же номером)');
    assert(TOOL_PROTOCOL_BLOCK.includes('МПГПП') || TOOL_PROTOCOL_BLOCK.includes('Международный пакт'),
        'Правило №1 упоминает МПГПП как пример международного договора');
    assert(TOOL_PROTOCOL_BLOCK.includes('ТОЧНАЯ МАРШРУТИЗАЦИЯ') || TOOL_PROTOCOL_BLOCK.includes('TOOL_CALL ROUTING'),
        '🛑 Правило №2: маршрутизация запросов с полным названием акта');
    assert(TOOL_PROTOCOL_BLOCK.includes('Международный пакт о гражданских и политических правах статья 14'),
        'Правило №2 содержит пример правильного запроса с полным названием акта');
    assert(TOOL_PROTOCOL_BLOCK.includes('ПРЕЗУМПЦИЯ ПРАВОТЫ') || TOOL_PROTOCOL_BLOCK.includes('ЗАПРЕТ НА ВЫДУМКИ'),
        '🛑 Правило №3: презумпция правоты автора + запрет на выдумывание');
    assert(TOOL_PROTOCOL_BLOCK.includes('верификация нумерации невозможна'),
        'Правило №3 содержит точную формулировку rationale для status=ok когда нет данных');

    let threw = false;
    try { createAgenticVerifier({}); } catch (_) { threw = true; }
    assert(threw, 'отсутствие getNextKey → throw');

    try { createAgenticVerifier({ getNextKey: () => 'k' }); }
    catch (e) { assert(e.message.includes('searchPinecone'), 'throw упоминает searchPinecone'); }

    const v = createAgenticVerifier(makeMockDeps());
    assert(typeof v.run === 'function', 'run() есть');
    assert(v.SEARCH_TOOL === SEARCH_TOOL, 'instance.SEARCH_TOOL пробрасывается');
}

// ═══════════════════════════════════════════════════════════════════════
console.log('=== TEST 2: 0 tool calls (модель сразу решила) ===');
{
    resetMocks();
    mockGeminiQueue = [
        () => geminiTextResponse('{"status":"ok","confidence":85,"finding":"всё хорошо","rationale":"...","suggestion":""}')
    ];
    const v = createAgenticVerifier(makeMockDeps());
    const out = await v.run(makeBaseRunOpts());
    assert(out.tier === 1, 'tier=1');
    assert(out.model === 'gemini-3.1-flash-lite', 'model = lite');
    assert(out.turns === 1, 'turns=1');
    assert(out.articles.length === 0, 'articles пустой');
    assert(out.toolCalls.length === 0, 'toolCalls пустой');
    assert(out.text.includes('"status":"ok"'), 'text содержит JSON');
}

// ═══════════════════════════════════════════════════════════════════════
console.log('=== TEST 3: 1 tool call → final JSON ===');
{
    resetMocks();
    mockGeminiQueue = [
        () => geminiFunctionCallResponse('search_legislation_kg', {
            query: 'кабальные условия неустойки', reason: 'договор оказания услуг'
        }),
        () => geminiTextResponse('{"status":"critical","confidence":90,"finding":"кабальная неустойка","rationale":"...","suggestion":"снизить"}')
    ];
    const searchCalls = [];
    const v = createAgenticVerifier(makeMockDeps({
        searchPinecone: async (vec, topK) => {
            searchCalls.push({ topK });
            return [
                { score: 0.9, metadata: { npa_title: 'ГК КР', article_title: 'Статья 333', full_text: 'Неустойка...' } }
            ];
        }
    }));

    const events = [];
    const out = await v.run(makeBaseRunOpts({
        onSearchEvent: (ev) => events.push(ev)
    }));

    assert(out.tier === 1, 'tier=1');
    assert(out.turns === 2, 'turns=2');
    assert(out.toolCalls.length === 1, 'toolCalls.length=1');
    assert(out.toolCalls[0].query.includes('кабальные'), 'query сохранён');
    assert(out.toolCalls[0].found === 1, 'found=1');
    assert(out.articles.length === 1, 'articles[1]=ГК КР');
    assert(out.articles[0].npa_title === 'ГК КР', 'npa_title=ГК КР');
    assert(searchCalls.length === 1, 'searchPinecone вызван 1 раз');
    assert(searchCalls[0].topK === 5, 'topK=5 (дефолт)');
    assert(events.length === 1, 'onSearchEvent отправлен 1 раз');
    assert(events[0].query.includes('кабальные'), 'event.query корректен');
    assert(events[0].turn === 0, 'event.turn=0');
    assert(events[0].model === 'gemini-3.1-flash-lite', 'event.model = lite');
}

// ═══════════════════════════════════════════════════════════════════════
console.log('=== TEST 4: 2 tool calls → final JSON ===');
{
    resetMocks();
    mockGeminiQueue = [
        () => geminiFunctionCallResponse('search_legislation_kg', { query: 'первый' }),
        () => geminiFunctionCallResponse('search_legislation_kg', { query: 'второй' }),
        () => geminiTextResponse('{"status":"warning","confidence":70,"finding":"x","rationale":"","suggestion":""}')
    ];
    let searchIdx = 0;
    const v = createAgenticVerifier(makeMockDeps({
        searchPinecone: async () => {
            searchIdx++;
            return [{
                score: 0.5 + searchIdx * 0.1,
                metadata: { npa_title: `НПА${searchIdx}`, article_title: `Статья ${searchIdx}`, full_text: `Текст ${searchIdx}` }
            }];
        }
    }));
    const out = await v.run(makeBaseRunOpts());
    assert(out.turns === 3, 'turns=3');
    assert(out.toolCalls.length === 2, 'toolCalls.length=2');
    assert(out.articles.length === 2, 'articles накопились');
    assert(out.articles[0].npa_title === 'НПА1', 'первая статья');
    assert(out.articles[1].npa_title === 'НПА2', 'вторая статья');
}

// ═══════════════════════════════════════════════════════════════════════
console.log('=== TEST 5: MAX_TOOL_TURNS защита ===');
{
    resetMocks();
    const fnCallResp = () => geminiFunctionCallResponse('search_legislation_kg', { query: 'q' });
    mockGeminiQueue = [
        fnCallResp(), fnCallResp(), fnCallResp(),   // tier 1 спам — 3 turns
        fnCallResp(), fnCallResp(), fnCallResp()    // tier 2 спам — 3 turns
    ];
    mockDeepSeekQueue = [
        () => ({ text: '{"status":"ok","confidence":50,"finding":"deepseek fallback","rationale":"","suggestion":""}', usage: {} })
    ];
    const v = createAgenticVerifier(makeMockDeps());
    const out = await v.run(makeBaseRunOpts({ maxToolTurns: 3, watchdogMs: 60000 }));
    assert(out.tier === 3, 'tier=3 (deepseek)');
    assert(out.toolCalls.length === 1, 'deepseek tier даёт legacy single-shot');
    assert(out.text.includes('deepseek fallback'), 'text от deepseek');
}

// ═══════════════════════════════════════════════════════════════════════
console.log('=== TEST 6: Tier 1 fail → Tier 2 success ===');
{
    resetMocks();
    mockGeminiQueue = [
        () => { const e = new Error('503 service unavailable'); e.status = 503; throw e; },
        () => geminiTextResponse('{"status":"ok","confidence":75,"finding":"tier2 спас","rationale":"","suggestion":""}')
    ];
    const v = createAgenticVerifier(makeMockDeps());
    const out = await v.run(makeBaseRunOpts());
    assert(out.tier === 2, 'tier=2');
    assert(out.model === 'gemini-2.5-flash', 'model = 2.5 flash');
    assert(out.text.includes('tier2 спас'), 'text от tier2');
}

// ═══════════════════════════════════════════════════════════════════════
console.log('=== TEST 7: Tier 1+2 fail → DeepSeek legacy ===');
{
    resetMocks();
    mockGeminiQueue = [
        () => { throw new Error('timeout'); },
        () => { throw new Error('429 rate limit'); }
    ];
    mockDeepSeekQueue = [
        () => ({ text: '{"status":"ok","confidence":60,"finding":"deepseek legacy","rationale":"","suggestion":""}', usage: { promptTokens: 200, completionTokens: 80 } })
    ];
    let pineconeCount = 0;
    const v = createAgenticVerifier(makeMockDeps({
        searchPinecone: async () => {
            pineconeCount++;
            return [{ score: 0.8, metadata: { npa_title: 'ГК', article_title: 'ст.1', full_text: 'x'.repeat(1500) } }];
        }
    }));
    const out = await v.run(makeBaseRunOpts({ targetType: 'general' }));
    assert(out.tier === 3, 'tier=3');
    assert(out.model === 'deepseek-v4-flash', 'model = deepseek');
    assert(pineconeCount === 1, '1 Pinecone-вызов');
    assert(out.articles.length === 1, 'статьи накопились');
    assert(out.articles[0].full_text.length === 800, 'full_text обрезан до 800');
    assert(out.toolCalls.length === 1 && out.toolCalls[0].query.includes('legacy'), 'toolCalls=legacy');
}

// ═══════════════════════════════════════════════════════════════════════
console.log('=== TEST 8: deepseekEnabled=false → allFailed ===');
{
    resetMocks();
    mockGeminiQueue = [
        () => { throw new Error('timeout'); },
        () => { throw new Error('timeout'); }
    ];
    const v = createAgenticVerifier(makeMockDeps({ deepseekEnabled: false }));
    let caught = null;
    try { await v.run(makeBaseRunOpts()); }
    catch (e) { caught = e; }
    assert(caught !== null, 'throw произошёл');
    assert(caught.allFailed === true, 'err.allFailed=true');
    assert(Array.isArray(caught.attempts), 'attempts массив');
    assert(caught.attempts.length === 2, 'attempts[2]');
}

// ═══════════════════════════════════════════════════════════════════════
console.log('=== TEST 9: aborted перед запуском ===');
{
    resetMocks();
    mockGeminiQueue = [
        () => { throw new Error('should not be called'); }
    ];
    const v = createAgenticVerifier(makeMockDeps());
    let caught = null;
    try {
        await v.run(makeBaseRunOpts({ aborted: { value: true } }));
    } catch (e) { caught = e; }
    assert(caught !== null && caught.aborted === true, 'throw err.aborted=true');
    assert(mockGeminiQueue.length === 1, 'queue не тронут (Gemini не вызывался)');
}

// ═══════════════════════════════════════════════════════════════════════
console.log('=== TEST 10: Unknown function call → retry ===');
{
    resetMocks();
    mockGeminiQueue = [
        () => geminiFunctionCallResponse('some_unknown_function', { foo: 'bar' }),
        () => geminiTextResponse('{"status":"warning","confidence":50,"finding":"восстановилась","rationale":"","suggestion":""}')
    ];
    const v = createAgenticVerifier(makeMockDeps());
    const out = await v.run(makeBaseRunOpts());
    assert(out.tier === 1, 'tier=1 (recovered)');
    assert(out.turns === 2, 'turns=2');
    assert(out.toolCalls.length === 0, 'toolCalls пустой');
}

// ═══════════════════════════════════════════════════════════════════════
console.log('=== TEST 11: Empty query → retry ===');
{
    resetMocks();
    mockGeminiQueue = [
        () => geminiFunctionCallResponse('search_legislation_kg', { query: '' }),
        () => geminiTextResponse('{"status":"warning","confidence":40,"finding":"без поиска","rationale":"","suggestion":""}')
    ];
    const v = createAgenticVerifier(makeMockDeps());
    const out = await v.run(makeBaseRunOpts());
    assert(out.tier === 1, 'tier=1');
    assert(out.turns === 2, 'turns=2');
    assert(out.toolCalls.length === 0, 'пустой query не записан');
    assert(out.articles.length === 0, 'статей нет');
}

// ═══════════════════════════════════════════════════════════════════════
console.log('=== TEST 12: Pinecone error → graceful tool response ===');
{
    resetMocks();
    mockGeminiQueue = [
        () => geminiFunctionCallResponse('search_legislation_kg', { query: 'x' }),
        () => geminiTextResponse('{"status":"warning","confidence":30,"finding":"без RAG","rationale":"","suggestion":""}')
    ];
    const v = createAgenticVerifier(makeMockDeps({
        searchPinecone: async () => { throw new Error('pinecone 503'); }
    }));
    const out = await v.run(makeBaseRunOpts());
    assert(out.tier === 1, 'tier=1');
    assert(out.turns === 2, 'turns=2');
    assert(out.toolCalls.length === 1, 'toolCall записан');
    assert(out.toolCalls[0].error?.includes('pinecone'), 'error сохранён');
    assert(out.toolCalls[0].found === 0, 'found=0');
}

// ═══════════════════════════════════════════════════════════════════════
console.log('=== TEST 13: Дедупликация статей ===');
{
    resetMocks();
    const dup = { score: 0.9, metadata: { npa_title: 'ГК', article_title: 'ст.333', full_text: 'неустойка' } };
    const unique = { score: 0.8, metadata: { npa_title: 'ГК', article_title: 'ст.334', full_text: 'другое' } };
    let callIdx = 0;
    mockGeminiQueue = [
        () => geminiFunctionCallResponse('search_legislation_kg', { query: 'a' }),
        () => geminiFunctionCallResponse('search_legislation_kg', { query: 'b' }),
        () => geminiTextResponse('{"status":"ok","confidence":50,"finding":"x","rationale":"","suggestion":""}')
    ];
    const v = createAgenticVerifier(makeMockDeps({
        searchPinecone: async () => {
            callIdx++;
            return callIdx === 1 ? [dup, unique] : [dup];
        }
    }));
    const out = await v.run(makeBaseRunOpts());
    assert(out.articles.length === 2, '2 уникальных статьи (дубль отсеян)');
    assert(out.articles[0].article_title === 'ст.333' && out.articles[1].article_title === 'ст.334', 'обе уникальные');
}

// ═══════════════════════════════════════════════════════════════════════
console.log('=== TEST 14: Telemetry hooks ===');
{
    resetMocks();
    const teleAttempts = [];
    const teleCounters = {};
    const telemetry = {
        recordCascadeAttempt: (a) => teleAttempts.push(a),
        incrementCascadeCounter: (k) => { teleCounters[k] = (teleCounters[k] || 0) + 1; },
        recordAgentTime: () => {}
    };
    mockGeminiQueue = [
        () => geminiFunctionCallResponse('search_legislation_kg', { query: 'x' }),
        () => geminiTextResponse('{"status":"ok","confidence":80,"finding":"","rationale":"","suggestion":""}')
    ];
    const v = createAgenticVerifier(makeMockDeps());
    const out = await v.run(makeBaseRunOpts({ telemetry }));
    assert(out.tier === 1, 'tier=1');
    assert(teleAttempts.length === 2, '2 cascade attempts (turn 0 + turn 1)');
    assert(teleAttempts.every(a => a.status === 'ok'), 'оба attempts status=ok');
    assert(teleCounters.tier1_hits === 1, 'tier1_hits=1');
    assert(out.usage.promptTokens > 0, 'usage аккумулирован');
}

// ═══════════════════════════════════════════════════════════════════════
console.log('=== TEST 15: Throttle submit на каждом turn ===');
{
    resetMocks();
    let throttleCalls = 0;
    const throttle = {
        submit: async (taskFn) => {
            throttleCalls++;
            return taskFn();
        }
    };
    mockGeminiQueue = [
        () => geminiFunctionCallResponse('search_legislation_kg', { query: 'x' }),
        () => geminiTextResponse('{"status":"ok","confidence":50,"finding":"","rationale":"","suggestion":""}')
    ];
    const v = createAgenticVerifier(makeMockDeps({ throttle }));
    const out = await v.run(makeBaseRunOpts());
    assert(out.tier === 1, 'tier=1');
    assert(throttleCalls === 2, 'throttle.submit вызван 2 раза');
}

// ═══════════════════════════════════════════════════════════════════════
console.log('=== TEST 16: Empty Gemini response → tier failover ===');
{
    resetMocks();
    mockGeminiQueue = [
        () => ({ text: '', candidates: [{ content: { parts: [] } }], usage: {} }),
        () => geminiTextResponse('{"status":"ok","confidence":50,"finding":"tier2","rationale":"","suggestion":""}')
    ];
    const v = createAgenticVerifier(makeMockDeps());
    const out = await v.run(makeBaseRunOpts());
    assert(out.tier === 2, 'tier=2 (tier1 был пустой)');
}

// ═══════════════════════════════════════════════════════════════════════
console.log('=== TEST 17: DeepSeek legacy targetType=article ===');
{
    resetMocks();
    mockGeminiQueue = [
        () => { throw new Error('t1 down'); },
        () => { throw new Error('t2 down'); }
    ];
    const deepseekCalls = [];
    mockDeepSeekQueue = [
        (opts) => { deepseekCalls.push(opts); return { text: '{"status":"ok","confidence":50,"finding":"ds","rationale":"","suggestion":""}', usage: {} }; }
    ];
    const v = createAgenticVerifier(makeMockDeps());
    const out = await v.run(makeBaseRunOpts({
        targetType: 'article',
        targetArticle: { number: '137', act: 'УК КР' }
    }));
    assert(out.tier === 3, 'tier=3');
    assert(deepseekCalls.length === 1, 'deepseek был вызван 1 раз');
    assert(deepseekCalls[0].userPrompt.includes('Релевантные статьи КР'), 'userPrompt содержит RAG');
}

// ═══════════════════════════════════════════════════════════════════════
console.log('=== TEST 18: modelContent push AS-IS (preserves thoughtSignature) ===');
{
    resetMocks();
    // Реалистичный response от Gemini 2.5+: thought-часть + functionCall с thoughtSignature
    const richContent = {
        role: 'model',
        parts: [
            { thought: true, text: 'Размышляю над запросом...' },
            { functionCall: { name: 'search_legislation_kg', args: { query: 'кабальные условия' } }, thoughtSignature: 'sig_abc123' }
        ]
    };
    const capturedTurns = [];
    mockGeminiQueue = [
        (opts) => { capturedTurns.push(JSON.parse(JSON.stringify(opts.contents || []))); return { text: '', candidates: [{ content: richContent }], usage: { promptTokens: 80, completionTokens: 40 } }; },
        (opts) => { capturedTurns.push(JSON.parse(JSON.stringify(opts.contents || []))); return geminiTextResponse('{"status":"warning","confidence":50,"finding":"x","rationale":"","suggestion":""}'); }
    ];
    const v = createAgenticVerifier(makeMockDeps({
        searchPinecone: async () => [{ score: 0.9, metadata: { npa_title: 'ГК КР', article_title: 'ст.333', full_text: 'неустойка' } }]
    }));
    await v.run(makeBaseRunOpts());

    assert(capturedTurns.length === 2, '2 turns');

    // Turn 0 received initial contents: [user_text]
    assert(capturedTurns[0].length === 1, 'turn 0: contents = [user_text]');
    assert(capturedTurns[0][0].role === 'user', 'turn 0[0].role = user');

    // Turn 1 received accumulated contents: [user_text, model_content_as_is, function_response]
    const turn1 = capturedTurns[1];
    assert(turn1.length === 3, 'turn 1: contents has 3 entries (user, model, functionResponse)');

    // 🛑 KEY: модельный content пушится КАК ЕСТЬ с thoughtSignature
    assert(turn1[1].role === 'model', 'turn 1[1].role = model (preserved)');
    assert(Array.isArray(turn1[1].parts) && turn1[1].parts.length === 2, 'turn 1[1] имеет ОБЕ части (thought + functionCall)');
    assert(turn1[1].parts[0].thought === true, '🛑 thought-часть сохранена');
    assert(turn1[1].parts[1].functionCall?.name === 'search_legislation_kg', 'functionCall на месте');
    assert(turn1[1].parts[1].thoughtSignature === 'sig_abc123',
        '🛑 REGRESS: thoughtSignature сохранён (иначе 400 "missing thought_signature")');
    // 🛑 2026-06-02 HOTFIX: SDK парсит camelCase, REST API требует snake_case.
    // Должны быть обе формы — camelCase для SDK echo, snake_case для wire.
    assert(turn1[1].parts[1].functionCall.thought_signature === 'sig_abc123' ||
           turn1[1].parts[1].thought_signature === 'sig_abc123',
        '🛑 REGRESS: snake_case thought_signature добавлен (workaround SDK bug)');

    // 🛑 KEY: parts модельного content НЕ содержат role
    assert(!('role' in turn1[1].parts[0]), '🛑 REGRESS: model.parts[0] без role');
    assert(!('role' in turn1[1].parts[1]), '🛑 REGRESS: model.parts[1] без role');

    // 🛑 KEY: functionResponse Content имеет role на верхнем уровне, НЕ в parts
    assert(turn1[2].role === 'user', 'functionResponse Content.role = user');
    assert(Array.isArray(turn1[2].parts) && turn1[2].parts.length === 1, 'functionResponse parts длиной 1');
    assert(turn1[2].parts[0].functionResponse?.name === 'search_legislation_kg', 'functionResponse в parts[0]');
    assert(!('role' in turn1[2].parts[0]),
        '🛑 REGRESS: functionResponse.parts[0] БЕЗ role (иначе 400 "Unknown name role")');
    assert(turn1[2].parts[0].functionResponse.response?.found === 1, 'response.found=1');
}

// ═══════════════════════════════════════════════════════════════════════
console.log('=== TEST 19: DeepSeek tool loop (Tier 3 с function calling) ===');
{
    resetMocks();
    // Tier 1 + Tier 2 валятся → Tier 3 запускает DeepSeek tool loop
    mockGeminiQueue = [
        () => { throw new Error('t1 down'); },
        () => { throw new Error('t2 down'); }
    ];

    // Mock deepseekToolCall — multi-turn: turn 0 запрашивает инструмент,
    // turn 1 возвращает финальный JSON.
    const capturedDsCalls = [];
    let dsTurn = 0;
    const deepseekToolCallMock = async (opts) => {
        capturedDsCalls.push(JSON.parse(JSON.stringify(opts)));
        dsTurn++;
        if (dsTurn === 1) {
            return {
                message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                        id: 'call_xyz123',
                        type: 'function',
                        function: {
                            name: 'search_legislation_kg',
                            arguments: JSON.stringify({ query: 'кабальные условия неустойки', reason: 'договор оказания услуг' })
                        }
                    }]
                },
                usage: { prompt_tokens: 250, completion_tokens: 35 }
            };
        }
        return {
            message: {
                role: 'assistant',
                content: '{"status":"critical","confidence":92,"finding":"кабальная неустойка 1% в день","rationale":"...","suggestion":"снизить до 0.1%"}'
            },
            usage: { prompt_tokens: 800, completion_tokens: 95 }
        };
    };

    let pineconeCount = 0;
    const v = createAgenticVerifier(makeMockDeps({
        deepseekToolCall: deepseekToolCallMock,
        searchPinecone: async () => {
            pineconeCount++;
            return [
                { score: 0.94, metadata: { npa_title: 'ГК КР', article_title: 'Статья 333', full_text: 'Неустойка — определённая законом или договором денежная сумма...' } },
                { score: 0.88, metadata: { npa_title: 'ГК КР', article_title: 'Статья 168', full_text: 'Кабальная сделка...' } }
            ];
        }
    }));

    const events = [];
    const out = await v.run(makeBaseRunOpts({
        onSearchEvent: (ev) => events.push(ev)
    }));

    // Базовые проверки результата
    assert(out.tier === 3, 'tier=3 (DeepSeek tool loop)');
    assert(out.model === 'deepseek-v4-flash', 'model = deepseek');
    assert(out.turns === 2, 'turns=2 (tool_call + final)');
    assert(out.text.includes('"status":"critical"'), 'финальный JSON есть');
    assert(out.toolCalls.length === 1, '1 tool_call записан');
    assert(out.toolCalls[0].query.includes('кабальные'), 'query сохранён');
    assert(out.toolCalls[0].found === 2, 'found=2');
    assert(out.articles.length === 2, 'статьи аккумулированы');
    assert(out.articles[0].npa_title === 'ГК КР', 'статья ГК КР');
    assert(events.length === 1, 'onSearchEvent был вызван 1 раз');
    assert(events[0].model === 'deepseek-v4-flash', 'event.model = deepseek');

    // 🛑 Структура messages для DeepSeek (OpenAI-формат)
    assert(capturedDsCalls.length === 2, '2 вызова DeepSeek API');
    assert(pineconeCount === 1, 'Pinecone вызван 1 раз (один tool_call)');

    // Turn 0: messages = [system, user]
    const t0msgs = capturedDsCalls[0].messages;
    assert(Array.isArray(t0msgs) && t0msgs.length === 2, 'turn 0: messages = [system, user]');
    assert(t0msgs[0].role === 'system', 'turn 0 messages[0].role = system');
    assert(t0msgs[1].role === 'user', 'turn 0 messages[1].role = user');

    // Turn 0: tools в OpenAI-формате
    const t0tools = capturedDsCalls[0].tools;
    assert(Array.isArray(t0tools) && t0tools.length === 1, 'tools массив из 1 элемента');
    assert(t0tools[0].type === 'function', 'tools[0].type = function (OpenAI)');
    assert(t0tools[0].function.name === 'search_legislation_kg', 'имя функции');
    assert(t0tools[0].function.parameters.type === 'object', '🛑 parameters.type = "object" (lowercase OpenAI)');
    assert(Array.isArray(t0tools[0].function.parameters.required), 'required массив');

    // Turn 1: messages = [system, user, assistant_with_tool_calls, tool_response]
    const t1msgs = capturedDsCalls[1].messages;
    assert(t1msgs.length === 4, 'turn 1: messages = [system, user, assistant, tool]');
    assert(t1msgs[2].role === 'assistant', 'turn 1 messages[2].role = assistant');
    assert(Array.isArray(t1msgs[2].tool_calls) && t1msgs[2].tool_calls.length === 1,
        'assistant message содержит tool_calls');
    assert(t1msgs[2].tool_calls[0].id === 'call_xyz123', 'tool_call id сохранён');
    assert(t1msgs[3].role === 'tool', '🛑 турн message[3].role = "tool" (OpenAI)');
    assert(t1msgs[3].tool_call_id === 'call_xyz123', '🛑 tool_call_id связан с assistant.tool_calls[0].id');
    assert(typeof t1msgs[3].content === 'string',
        '🛑 tool message.content — STRING (JSON.stringified, не объект)');
    const parsedToolContent = JSON.parse(t1msgs[3].content);
    assert(parsedToolContent.found === 2 && Array.isArray(parsedToolContent.articles),
        'tool content содержит found + articles');
}

// ═══════════════════════════════════════════════════════════════════════
console.log('=== TEST 20: DeepSeek legacy fallback (deepseekToolCall не передан) ===');
{
    resetMocks();
    mockGeminiQueue = [
        () => { throw new Error('t1 down'); },
        () => { throw new Error('t2 down'); }
    ];
    mockDeepSeekQueue = [
        () => ({ text: '{"status":"ok","confidence":50,"finding":"legacy","rationale":"","suggestion":""}', usage: {} })
    ];
    // makeMockDeps НЕ передаёт deepseekToolCall → должен сработать legacy path
    const v = createAgenticVerifier(makeMockDeps());
    const out = await v.run(makeBaseRunOpts());
    assert(out.tier === 3, 'tier=3');
    assert(out.text.includes('legacy'), 'legacy single-shot отработал');
    assert(out.toolCalls.length === 1 && out.toolCalls[0].query.includes('legacy'),
        'toolCalls помечает как legacy single-shot');
}

// ═══════════════════════════════════════════════════════════════════════
console.log('═══════════════════════════════════════════════════════════════════');
console.log(`ИТОГ: ${pass} pass, ${fail} fail`);
console.log('═══════════════════════════════════════════════════════════════════');

llmCascade.callGeminiSingle = originalCallGeminiSingle;
llmCascade.callDeepSeekSingle = originalCallDeepSeekSingle;

process.exit(fail > 0 ? 1 : 0);

})().catch(e => {
    console.error('UNCAUGHT', e);
    process.exit(1);
});
