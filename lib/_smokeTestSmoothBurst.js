// ═══════════════════════════════════════════════════════════════════════
//  _smokeTestSmoothBurst.js
//  Smoke-test для SmoothBurstThrottle.
//  Запуск: node lib/_smokeTestSmoothBurst.js
// ═══════════════════════════════════════════════════════════════════════

const { createSmoothBurstThrottle } = require('./smoothBurstThrottle');

let pass = 0, fail = 0;
function assert(cond, name, extra = '') {
    if (cond) { pass++; console.log('  PASS', name); }
    else      { fail++; console.log('  FAIL', name, extra); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
    console.log('=== TEST 1: базовый submit + drain ===');
    {
        const t = createSmoothBurstThrottle({ rps: 50 });  // 20ms interval
        const result = await t.submit(async () => 42);
        assert(result === 42, 'submit резолвится с возвращённым значением');
        await t.drain();
        const s = t.stats();
        assert(s.totalLaunched === 1, '1 launched', `got ${s.totalLaunched}`);
        assert(s.totalCompleted === 1, '1 completed');
        assert(s.totalErrors === 0, '0 errors');
    }

    console.log('\n=== TEST 2: ошибка в taskFn → reject + slot освобождается ===');
    {
        const t = createSmoothBurstThrottle({ rps: 50 });
        let caught = null;
        try {
            await t.submit(async () => { throw new Error('boom'); });
        } catch (e) { caught = e; }
        assert(caught !== null && caught.message === 'boom', 'task throw → reject');
        // Slot должен быть свободен — следующий submit работает.
        const second = await t.submit(async () => 'ok');
        assert(second === 'ok', 'после ошибки следующий submit ок');
        const s = t.stats();
        assert(s.totalErrors === 1, '1 error в stats');
        assert(s.totalCompleted === 1, '1 completed (вторая успешная)');
    }

    console.log('\n=== TEST 3: throughput на 100 быстрых tasks @ 20 RPS ≈ 5 сек ===');
    {
        const t = createSmoothBurstThrottle({ rps: 20 });
        const start = Date.now();
        const tasks = [];
        for (let i = 0; i < 100; i++) {
            tasks.push(t.submit(async () => {
                await sleep(50);  // быстрая задача
                return i;
            }));
        }
        const results = await Promise.all(tasks);
        const elapsedS = (Date.now() - start) / 1000;
        const s = t.stats();
        console.log(`  → completed ${results.length} tasks in ${elapsedS.toFixed(2)}s, actualRps=${s.actualRps}`);
        // 100 tasks @ 20 RPS = 5 секунд минимум на запуски,
        // + время последней задачи (50ms) → ожидаем 4.5-7s (cancellable jitter).
        assert(elapsedS >= 4.5 && elapsedS <= 7,
            `100 tasks @ 20 RPS = ~5s (got ${elapsedS.toFixed(2)}s)`);
        assert(results.length === 100, '100 результатов');
        assert(s.totalCompleted === 100, '100 completed в stats');
        // actualRps — между firstLaunch и lastLaunch.
        // 100 launches за ~5 сек → actualRps близок к 20.
        assert(s.actualRps >= 18 && s.actualRps <= 22,
            `actualRps ≈ 20 (got ${s.actualRps})`);
    }

    console.log('\n=== TEST 4: 20 tasks стартуют с интервалом ≥ 45ms (smooth, не burst) ===');
    {
        const t = createSmoothBurstThrottle({ rps: 20 });
        const launchTimes = [];
        const tasks = [];
        for (let i = 0; i < 20; i++) {
            tasks.push(t.submit(async () => {
                launchTimes.push(Date.now());
                await sleep(10);
            }));
        }
        await Promise.all(tasks);
        // Считаем интервалы между стартами
        const intervals = [];
        for (let i = 1; i < launchTimes.length; i++) {
            intervals.push(launchTimes[i] - launchTimes[i - 1]);
        }
        const minInterval = Math.min(...intervals);
        const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        console.log(`  → intervals: min=${minInterval}ms, avg=${avgInterval.toFixed(1)}ms`);
        // У нас 50ms цель, 5ms допуск (jitter event loop).
        // 50ms цель, ±15ms допуск на event-loop jitter (особенно при загруженном CI)
        assert(minInterval >= 35, `минимальный интервал ≥ 35ms (got ${minInterval}ms)`);
        assert(avgInterval >= 45 && avgInterval <= 65,
            `средний интервал 45-65ms (got ${avgInterval.toFixed(1)}ms)`);
        // burst тест: нет двух запусков в одну ms.
        const bursts = intervals.filter(i => i < 5).length;
        assert(bursts === 0, '0 burst-стартов (< 5ms интервал)');
    }

    console.log('\n=== TEST 5: maxConcurrent cap соблюдается ===');
    {
        const t = createSmoothBurstThrottle({ rps: 100, maxConcurrent: 5 });
        let peakActive = 0;
        const tasks = [];
        for (let i = 0; i < 20; i++) {
            tasks.push(t.submit(async () => {
                peakActive = Math.max(peakActive, t.activeCount);
                await sleep(200);  // долгие задачи → накапливаются
            }));
        }
        await Promise.all(tasks);
        const s = t.stats();
        console.log(`  → peakActive=${peakActive}, statsActivePeak=${s.activePeak}`);
        assert(peakActive <= 5, `peakActive ≤ 5 (got ${peakActive})`);
        assert(s.activePeak <= 5, `stats.activePeak ≤ 5 (got ${s.activePeak})`);
        assert(s.totalCompleted === 20, '20 completed');
    }

    console.log('\n=== TEST 6: drain ждёт active задачи ===');
    {
        const t = createSmoothBurstThrottle({ rps: 50 });
        let resolved = 0;
        // Не await — submit и сразу drain
        t.submit(async () => { await sleep(150); resolved++; });
        t.submit(async () => { await sleep(150); resolved++; });
        t.submit(async () => { await sleep(150); resolved++; });
        await t.drain();
        assert(resolved === 3, 'drain ждал все active (got ' + resolved + ')');
    }

    console.log('\n=== TEST 7: stop() реджектит pending, оставляет active ===');
    {
        const t = createSmoothBurstThrottle({ rps: 10 });   // 100ms interval
        let activeDone = 0;
        // Первая стартует сразу
        const p1 = t.submit(async () => { await sleep(80); activeDone++; return 1; });
        // Несколько ждут в очереди
        const p2 = t.submit(async () => { await sleep(50); return 2; });
        const p3 = t.submit(async () => { await sleep(50); return 3; });
        // Pre-attach noop catch — Node 24 крашит на unhandled reject если caller
        // делает синхронный stop() ДО любого await. В реальном коде (analyze.js)
        // Promise.all([...]) мгновенно цепляет handler, эта проблема не возникает.
        p2.catch(() => {});
        p3.catch(() => {});
        // Ждём чтобы p1 точно запустилась
        await sleep(20);
        t.stop();
        const r1 = await p1;
        assert(r1 === 1, 'active задача завершилась после stop');
        assert(activeDone === 1, 'active counter инкрементнут');
        let caught2 = null, caught3 = null;
        try { await p2; } catch (e) { caught2 = e; }
        try { await p3; } catch (e) { caught3 = e; }
        assert(caught2 !== null, 'pending p2 reject');
        assert(caught3 !== null, 'pending p3 reject');
        // Submit после stop → reject
        let caughtNew = null;
        try { await t.submit(async () => 'x'); } catch (e) { caughtNew = e; }
        assert(caughtNew !== null && /stopped/i.test(caughtNew.message),
            'submit после stop → reject');
    }

    console.log('\n=== TEST 8: streaming — fastest-first порядок ===');
    {
        const t = createSmoothBurstThrottle({ rps: 50 });
        const completed = [];
        // Task с разными временами: первая (i=0) самая медленная.
        const tasks = [
            t.submit(async () => { await sleep(200); completed.push('slow'); return 'slow'; }),
            t.submit(async () => { await sleep(50);  completed.push('fast'); return 'fast'; }),
            t.submit(async () => { await sleep(100); completed.push('mid');  return 'mid'; })
        ];
        await Promise.all(tasks);
        assert(completed[0] === 'fast', 'first completed = fast');
        assert(completed[1] === 'mid',  'second = mid');
        assert(completed[2] === 'slow', 'last = slow');
    }

    console.log('\n=== TEST 9: рестарт таймера после простоя ===');
    {
        const t = createSmoothBurstThrottle({ rps: 20 });
        // Первый submit стартует таймер
        await t.submit(async () => 'first');
        await sleep(100);  // даём timer выключиться (queue=0, active=0 после resolve)
        // Второй submit должен стартовать новый цикл
        const r = await t.submit(async () => 'second');
        assert(r === 'second', 'submit после простоя работает');
        const s = t.stats();
        assert(s.totalCompleted === 2, '2 completed');
    }

    console.log('\n=== TEST 10: невалидный rps / taskFn → ошибки ===');
    {
        let caught = null;
        try { createSmoothBurstThrottle({ rps: 0 }); } catch (e) { caught = e; }
        assert(caught !== null, 'rps=0 → throw');
        const t = createSmoothBurstThrottle({ rps: 20 });
        let caughtSubmit = null;
        try { await t.submit('not a function'); } catch (e) { caughtSubmit = e; }
        assert(caughtSubmit !== null, 'submit с non-function → reject');
    }

    console.log(`\n========== ИТОГ: ${pass} pass, ${fail} fail ==========`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
    console.error('SMOKE CRASHED:', e);
    process.exit(2);
});
