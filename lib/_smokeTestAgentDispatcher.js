// ═══════════════════════════════════════════════════════════════════════
//  _smokeTestAgentDispatcher.js
//  Smoke-test для globalContext + agentDispatcher.
//  Запуск: node lib/_smokeTestAgentDispatcher.js
// ═══════════════════════════════════════════════════════════════════════

const {
    injectGlobalContext,
    buildContextualSystemPrompt,
    normalizeContext,
    isValidContext,
    MAX_SUMMARY_CHARS
} = require('./globalContext');
const { createAgentDispatcher } = require('./agentDispatcher');
const { createSmoothBurstThrottle } = require('./smoothBurstThrottle');

let pass = 0, fail = 0;
function assert(cond, name, extra = '') {
    if (cond) { pass++; console.log('  PASS', name); }
    else      { fail++; console.log('  FAIL', name, extra); }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
    // ═══════════════════════════════════════════════════════════════════
    //  globalContext.js
    // ═══════════════════════════════════════════════════════════════════
    console.log('=== TEST 1: normalizeContext — все формы ===');
    {
        assert(normalizeContext(null) === null, 'null → null');
        assert(normalizeContext(undefined) === null, 'undefined → null');
        assert(normalizeContext('') === null, 'empty string → null');
        assert(normalizeContext({}) === null, 'empty object → null');
        assert(normalizeContext({ summary: '' }) === null, 'empty summary → null');

        const fromString = normalizeContext('Жалоба в Комитет ООН');
        assert(fromString && fromString.summary === 'Жалоба в Комитет ООН',
            'string input → { summary }');

        const fromObject = normalizeContext({
            summary: 'Жалоба в ООН',
            docType: 'complaint',
            branchHint: 'criminal / human rights',
            npaHints: ['Конвенция против пыток', 'МПГПП']
        });
        assert(fromObject.summary === 'Жалоба в ООН', 'summary preserved');
        assert(fromObject.docType === 'complaint', 'docType preserved');
        assert(fromObject.branchHint === 'criminal / human rights', 'branchHint preserved');
        assert(fromObject.npaHints?.length === 2, 'npaHints preserved');
    }

    console.log('\n=== TEST 2: sanitization — длинные / мусорные данные ===');
    {
        const longSummary = 'А'.repeat(MAX_SUMMARY_CHARS + 100);
        const ctx = normalizeContext({ summary: longSummary });
        assert(ctx.summary.length === MAX_SUMMARY_CHARS, 'summary обрезан');

        const tooManyHints = Array.from({ length: 20 }, (_, i) => `НПА ${i}`);
        const ctx2 = normalizeContext({ summary: 'x', npaHints: tooManyHints });
        assert(ctx2.npaHints.length === 8, 'npaHints обрезан до 8');

        const mixedHints = normalizeContext({ summary: 'x', npaHints: ['valid', '', null, 42, 'also valid'] });
        assert(mixedHints.npaHints.length === 2, 'мусорные элементы npaHints отфильтрованы');
    }

    console.log('\n=== TEST 3: injectGlobalContext ===');
    {
        const text = 'Статья 7 запрет пыток';
        assert(injectGlobalContext(text, null) === text, 'null ctx → текст без изменений');
        const ctx = { summary: 'Жалоба в Комитет ООН против пыток' };
        const out = injectGlobalContext(text, ctx);
        assert(out.startsWith('[Контекст документа: Жалоба в Комитет ООН против пыток]'),
            'префикс с summary добавлен');
        assert(out.endsWith(text), 'оригинальный текст сохранён');

        // Lossless: оригинальный текст полностью содержится
        assert(out.includes(text), 'lossless: оригинал внутри результата');
    }

    console.log('\n=== TEST 4: buildContextualSystemPrompt ===');
    {
        const basePrompt = 'Ты — юрист.';
        assert(buildContextualSystemPrompt(basePrompt, null) === basePrompt,
            'null ctx → basePrompt as-is');

        const ctx = {
            summary: 'Жалоба в ООН против пыток',
            branchHint: 'criminal / human rights',
            npaHints: ['Конвенция против пыток', 'МПГПП']
        };
        const out = buildContextualSystemPrompt(basePrompt, ctx);
        assert(out.includes('ТИП ДОКУМЕНТА'), 'есть ТИП ДОКУМЕНТА');
        assert(out.includes('ОТРАСЛЬ ПРАВА'), 'есть ОТРАСЛЬ ПРАВА');
        assert(out.includes('ОЖИДАЕМЫЕ НПА'), 'есть ОЖИДАЕМЫЕ НПА');
        assert(out.includes('false positive'), 'есть инструкция про false positive');
        assert(out.endsWith(basePrompt), 'basePrompt в конце');

        // Без branchHint / npaHints
        const minimalCtx = { summary: 'Договор аренды' };
        const out2 = buildContextualSystemPrompt(basePrompt, minimalCtx);
        assert(out2.includes('Договор аренды'), 'summary включён');
        assert(!out2.includes('ОТРАСЛЬ ПРАВА'), 'без branchHint — нет ОТРАСЛЬ ПРАВА');
        assert(!out2.includes('ОЖИДАЕМЫЕ НПА'), 'без npaHints — нет ОЖИДАЕМЫЕ НПА');
    }

    console.log('\n=== TEST 5: isValidContext ===');
    {
        assert(isValidContext(null) === false, 'null → invalid');
        assert(isValidContext({}) === false, 'empty → invalid');
        assert(isValidContext({ summary: '' }) === false, 'empty summary → invalid');
        assert(isValidContext({ summary: '   ' }) === false, 'whitespace → invalid');
        assert(isValidContext({ summary: 'ok' }) === true, 'min valid → ok');
    }

    // ═══════════════════════════════════════════════════════════════════
    //  agentDispatcher.js
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n=== TEST 6: dispatcher — базовый сценарий ===');
    {
        const throttle = createSmoothBurstThrottle({ rps: 100 });  // быстро для теста
        const calls = [];
        const dispatcher = createAgentDispatcher({
            throttle,
            runVerifierAgent: async (task, docContext, segmentRef) => {
                calls.push({ task, docContext, segmentRef });
                return { status: 'ok', text: task.text };
            }
        });
        const tasks = [
            { text: 'item 0', segmentRef: 's0' },
            { text: 'item 1', segmentRef: 's1' },
            { text: 'item 2', segmentRef: 's2' }
        ];
        const docContext = { summary: 'Жалоба в ООН', branchHint: 'criminal' };
        const results = await dispatcher.dispatch(tasks, { docContext });
        assert(results.length === 3, '3 результата');
        assert(results[0].result.text === 'item 0', 'результат 0 правильный');
        assert(results[1].result.text === 'item 1', 'результат 1 правильный');
        assert(results[2].result.text === 'item 2', 'результат 2 правильный');
        assert(calls.length === 3, '3 вызова runner');
        // docContext передан в runner как ОБЪЕКТ, не строка
        assert(calls[0].docContext && calls[0].docContext.summary === 'Жалоба в ООН',
            'docContext передан как объект');
        assert(calls[0].docContext.branchHint === 'criminal', 'branchHint передан');
    }

    console.log('\n=== TEST 7: dispatcher — onResult callback streaming ===');
    {
        const throttle = createSmoothBurstThrottle({ rps: 100 });
        const streamed = [];
        const dispatcher = createAgentDispatcher({
            throttle,
            runVerifierAgent: async (task) => {
                // Разные времена ответа — fastest first
                await sleep(task.delay);
                return { value: task.text };
            }
        });
        const tasks = [
            { text: 'A', delay: 200, segmentRef: 'A' },
            { text: 'B', delay: 50,  segmentRef: 'B' },
            { text: 'C', delay: 100, segmentRef: 'C' }
        ];
        const results = await dispatcher.dispatch(tasks, {
            onResult: ({ index, result }) => {
                streamed.push({ index, value: result.value });
            }
        });
        assert(streamed.length === 3, 'все 3 застримились');
        // Streaming order = completion order, не submit order
        assert(streamed[0].value === 'B', 'first streamed = B (50ms)');
        assert(streamed[1].value === 'C', 'second streamed = C (100ms)');
        assert(streamed[2].value === 'A', 'last streamed = A (200ms)');
        // Final results = submit order (index-based)
        assert(results[0].result.value === 'A', 'results[0] = A');
        assert(results[1].result.value === 'B', 'results[1] = B');
        assert(results[2].result.value === 'C', 'results[2] = C');
    }

    console.log('\n=== TEST 8: dispatcher — ошибка в task ===');
    {
        const throttle = createSmoothBurstThrottle({ rps: 100 });
        const dispatcher = createAgentDispatcher({
            throttle,
            runVerifierAgent: async (task) => {
                if (task.fail) throw new Error('boom: ' + task.text);
                return { ok: task.text };
            }
        });
        const tasks = [
            { text: 'good1', segmentRef: 'g1' },
            { text: 'bad',   segmentRef: 'b', fail: true },
            { text: 'good2', segmentRef: 'g2' }
        ];
        const results = await dispatcher.dispatch(tasks, {});
        assert(results.length === 3, '3 результата (один с error)');
        assert(results[0].result.ok === 'good1', 'good1 ok');
        assert(results[1].error && /boom: bad/.test(results[1].error),
            'bad → error поле, не throw наружу');
        assert(results[2].result.ok === 'good2', 'good2 ok после ошибки соседа');
    }

    console.log('\n=== TEST 9: dispatcher — aborted флаг ===');
    {
        const throttle = createSmoothBurstThrottle({ rps: 20 });
        const calls = [];
        const dispatcher = createAgentDispatcher({
            throttle,
            runVerifierAgent: async (task) => {
                calls.push(task.text);
                await sleep(100);
                return { ok: task.text };
            }
        });
        const aborted = { value: false };
        const tasks = Array.from({ length: 20 }, (_, i) => ({ text: `t${i}`, segmentRef: `s${i}` }));

        // Запускаем dispatch, через 100ms abort'им
        const dispatchPromise = dispatcher.dispatch(tasks, { aborted });
        sleep(100).then(() => { aborted.value = true; });

        const results = await dispatchPromise;
        assert(results.length === 20, '20 results (aborted задачи тоже учтены)');
        const abortedCount = results.filter(r => r.aborted).length;
        const completedCount = results.filter(r => r.result).length;
        console.log(`  → completed=${completedCount}, aborted=${abortedCount}`);
        assert(abortedCount > 0, 'часть задач отменена');
        assert(completedCount + abortedCount === 20, 'сумма = 20');
        assert(calls.length < 20, 'runner не вызывался для всех (часть aborted до старта)');
    }

    console.log('\n=== TEST 10: dispatcher — docContext lossy fallback ===');
    {
        const throttle = createSmoothBurstThrottle({ rps: 100 });
        let receivedCtx = null;
        const dispatcher = createAgentDispatcher({
            throttle,
            runVerifierAgent: async (task, docContext) => {
                receivedCtx = docContext;
                return { ok: true };
            }
        });
        // Передаём undefined docContext
        await dispatcher.dispatch([{ text: 'x', segmentRef: 's' }], { docContext: undefined });
        assert(receivedCtx === null, 'undefined docContext → null в runner');

        // Передаём пустую строку
        await dispatcher.dispatch([{ text: 'x', segmentRef: 's' }], { docContext: '' });
        assert(receivedCtx === null, 'empty string docContext → null');

        // Передаём строку (backwards-compat)
        await dispatcher.dispatch([{ text: 'x', segmentRef: 's' }], { docContext: 'Жалоба в ООН' });
        assert(receivedCtx && receivedCtx.summary === 'Жалоба в ООН',
            'string docContext → нормализуется в объект');
    }

    console.log('\n=== TEST 11: dispatcher — пустой массив tasks ===');
    {
        const throttle = createSmoothBurstThrottle({ rps: 100 });
        const dispatcher = createAgentDispatcher({
            throttle,
            runVerifierAgent: async () => { throw new Error('should not be called'); }
        });
        const r = await dispatcher.dispatch([], {});
        assert(Array.isArray(r) && r.length === 0, '[] → [] без ошибок');
    }

    console.log('\n=== TEST 12: dispatcher + throttle — реальный rps на 20 задачах ===');
    {
        const throttle = createSmoothBurstThrottle({ rps: 20 });
        const startTimes = [];
        const dispatcher = createAgentDispatcher({
            throttle,
            runVerifierAgent: async (task) => {
                startTimes.push(Date.now());
                await sleep(30);  // быстрая работа агента
                return { ok: task.text };
            }
        });
        const tasks = Array.from({ length: 20 }, (_, i) => ({ text: `t${i}`, segmentRef: `s${i}` }));
        const t0 = Date.now();
        await dispatcher.dispatch(tasks, {});
        const elapsedMs = Date.now() - t0;
        console.log(`  → 20 tasks @ 20rps в ${elapsedMs}ms`);
        // 20 tasks @ 20 rps = 1000ms на запуски + 30ms последняя = ~1030ms
        // Но первый стартует сразу (без ждать 50ms), так что 19*50 + 30 = 980ms
        assert(elapsedMs >= 850 && elapsedMs <= 1400,
            `20 tasks @ 20rps ≈ 1000ms (got ${elapsedMs}ms)`);
        // Все startTimes должны быть с интервалом ~50ms
        const minGap = Math.min(...startTimes.slice(1).map((t, i) => t - startTimes[i]));
        assert(minGap >= 30, `минимальный gap ≥ 30ms (got ${minGap}ms)`);
    }

    console.log('\n=== TEST 13: invalid DI → throw ===');
    {
        let caught1 = null, caught2 = null;
        try {
            createAgentDispatcher({});
        } catch (e) { caught1 = e; }
        assert(caught1 !== null, 'без throttle → throw');

        try {
            createAgentDispatcher({ throttle: createSmoothBurstThrottle() });
        } catch (e) { caught2 = e; }
        assert(caught2 !== null, 'без runVerifierAgent → throw');
    }

    console.log(`\n========== ИТОГ: ${pass} pass, ${fail} fail ==========`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
    console.error('SMOKE CRASHED:', e);
    process.exit(2);
});
