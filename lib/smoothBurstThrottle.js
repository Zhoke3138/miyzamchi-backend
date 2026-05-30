// ═══════════════════════════════════════════════════════════════════════
//  lib/smoothBurstThrottle.js
//  Smooth Burst Throttle — 20 RPS с равномерным 50ms интервалом.
//  Selective Reasoning v2.0  ·  2026-05-30
// ═══════════════════════════════════════════════════════════════════════
//
//  Концепция (см. AGENT_DISPATCHER_REDESIGN.md разд. 2.1):
//   - Один tick каждые intervalMs = 1000 / rps (по умолчанию 50ms).
//   - На каждом tick'е стартует ОДНА задача из очереди.
//   - Streaming: submit() возвращает Promise сразу, fastest-first.
//   - Drift correction: relative setTimeout вместо setInterval,
//     чтобы не накапливать задержку при загруженном event loop.
//   - maxConcurrent: жёсткий cap живых задач — защита если Gemini
//     завис и задачи накапливаются.
//
//  Использование:
//   const throttle = createSmoothBurstThrottle({ rps: 20 });
//   const promise = throttle.submit(async () => doWork());
//   // promise resolved когда задача завершилась
//   await throttle.drain();   // ждём пока всё закончится
//
//  Контракты:
//   - submit(taskFn) → Promise. Не throws сам по себе.
//   - taskFn throw → returned promise reject. Slot освобождается.
//   - submit после stop() → reject 'Throttle stopped'.
//   - drain() никогда не throws, ждёт queued + active = 0.
// ═══════════════════════════════════════════════════════════════════════

const { performance } = require('perf_hooks');

const DEFAULT_RPS = 20;
const DEFAULT_MAX_CONCURRENT = 100;
const MIN_INTERVAL_MS = 1;       // floor, иначе бесполезный setTimeout(0)

function createSmoothBurstThrottle(opts = {}) {
    const {
        rps           = DEFAULT_RPS,
        maxConcurrent = DEFAULT_MAX_CONCURRENT,
        logger        = console,
        // Hooks для тестов — позволяют замокать таймеры:
        setTimeoutFn = setTimeout,
        clearTimeoutFn = clearTimeout,
        nowFn         = () => performance.now()
    } = opts;

    if (rps <= 0) throw new Error('[SmoothBurst] rps must be > 0');
    if (maxConcurrent <= 0) throw new Error('[SmoothBurst] maxConcurrent must be > 0');

    const intervalMs = Math.max(MIN_INTERVAL_MS, 1000 / rps);

    const queue = [];           // [{ taskFn, resolve, reject, enqueuedAt }]
    let activeCount = 0;
    let timerHandle = null;
    let nextTickAt = null;
    let stopped = false;
    let pendingWakeup = false;  // гарантия что только ОДНА micro-task будит tick

    // Метрики
    const stats = {
        totalEnqueued: 0,
        totalLaunched: 0,
        totalCompleted: 0,
        totalErrors: 0,
        queuedPeak: 0,
        activePeak: 0,
        firstLaunchAt: null,
        lastLaunchAt: null
    };

    function recordPeaks() {
        if (queue.length > stats.queuedPeak) stats.queuedPeak = queue.length;
        if (activeCount > stats.activePeak)  stats.activePeak  = activeCount;
    }

    function scheduleNext() {
        if (stopped) return;
        // Tick'и нужны только пока есть очередь. Active задачи завершаются
        // сами через свои promise resolve — им не нужны tick'и.
        if (queue.length === 0) {
            timerHandle = null;
            nextTickAt = null;
            return;
        }
        const now = nowFn();
        if (nextTickAt === null) {
            // Первый tick после простоя — стартуем сразу.
            nextTickAt = now;
        }
        nextTickAt += intervalMs;
        const delay = Math.max(0, nextTickAt - now);
        timerHandle = setTimeoutFn(() => {
            timerHandle = null;
            tick();
            scheduleNext();
        }, delay);
    }

    function tick() {
        if (stopped) return;
        // Запускаем ОДНУ задачу если есть место.
        if (queue.length === 0) return;
        if (activeCount >= maxConcurrent) return;

        const job = queue.shift();
        activeCount++;
        stats.totalLaunched++;
        const launchedAt = nowFn();
        if (stats.firstLaunchAt === null) stats.firstLaunchAt = launchedAt;
        stats.lastLaunchAt = launchedAt;
        recordPeaks();

        // Через Promise.resolve().then(...) гарантируем что синхронные
        // ошибки в taskFn() попадают в catch, а не валят throttle.
        Promise.resolve()
            .then(() => job.taskFn())
            .then(
                result => {
                    activeCount--;
                    stats.totalCompleted++;
                    job.resolve(result);
                },
                err => {
                    activeCount--;
                    stats.totalErrors++;
                    job.reject(err);
                }
            );
    }

    function submit(taskFn) {
        if (stopped) {
            return Promise.reject(new Error('[SmoothBurst] Throttle stopped'));
        }
        if (typeof taskFn !== 'function') {
            return Promise.reject(new Error('[SmoothBurst] taskFn must be a function'));
        }
        return new Promise((resolve, reject) => {
            queue.push({ taskFn, resolve, reject, enqueuedAt: nowFn() });
            stats.totalEnqueued++;
            recordPeaks();
            // Если таймер спит — пробуждаем РОВНО ОДНУ микро-таску.
            // Без pendingWakeup флага 100 submit'ов в одну sync-петлю запустят
            // 100 micro-tasks → каждая вызовет tick() → весь throttle сломан.
            if (timerHandle === null && !pendingWakeup && !stopped) {
                pendingWakeup = true;
                Promise.resolve().then(() => {
                    pendingWakeup = false;
                    if (stopped) return;
                    tick();
                    scheduleNext();
                });
            }
        });
    }

    function drain() {
        return new Promise(resolve => {
            const check = () => {
                if (queue.length === 0 && activeCount === 0) {
                    resolve();
                } else {
                    setTimeout(check, Math.max(intervalMs, 20));
                }
            };
            check();
        });
    }

    function stop(opts = {}) {
        const { rejectPending = true } = opts;
        stopped = true;
        if (timerHandle !== null) {
            clearTimeoutFn(timerHandle);
            timerHandle = null;
        }
        // Сбрасываем queue. Active задачи остаются — они уже запущены.
        if (rejectPending) {
            while (queue.length > 0) {
                const job = queue.shift();
                job.reject(new Error('[SmoothBurst] Throttle stopped'));
            }
        }
    }

    function snapshot() {
        const durationS = stats.firstLaunchAt && stats.lastLaunchAt
            ? Math.max(0.001, (stats.lastLaunchAt - stats.firstLaunchAt) / 1000)
            : 0;
        return {
            ...stats,
            queued: queue.length,
            active: activeCount,
            stopped,
            actualRps: durationS > 0 ? Number((stats.totalLaunched / durationS).toFixed(2)) : 0,
            config: { rps, maxConcurrent, intervalMs }
        };
    }

    return {
        submit,
        drain,
        stop,
        stats: snapshot,
        get queueSize() { return queue.length; },
        get activeCount() { return activeCount; },
        get isStopped() { return stopped; }
    };
}

module.exports = {
    createSmoothBurstThrottle,
    DEFAULT_RPS,
    DEFAULT_MAX_CONCURRENT
};
