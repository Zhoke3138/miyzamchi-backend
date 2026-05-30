// ═══════════════════════════════════════════════════════════════════════
//  lib/agentDispatcher.js
//  Agent Dispatcher — композитор throttle + globalContext + runner.
//  Selective Reasoning v2.0  ·  2026-05-30
// ═══════════════════════════════════════════════════════════════════════
//
//  Что делает (см. AGENT_DISPATCHER_REDESIGN.md разд. 2.3):
//   - Принимает массив task'ов и docContext (паспорт документа).
//   - Через injectGlobalContext подмешивает контекст в каждый task.
//   - Через throttle.submit() запускает task'и со скоростью 20 RPS,
//     с минимум 50ms между стартами.
//   - Через onResult callback стримит результаты по мере готовности
//     (fastest-first, не порядок task'ов).
//   - Возвращает массив результатов в ИСХОДНОМ порядке tasks[i].
//
//  DI factory:
//   createAgentDispatcher({
//       throttle,           // от createSmoothBurstThrottle
//       runVerifierAgent,   // существующая функция из routes/analyze.js
//       logger
//   })
//
//  Контракт runVerifierAgent (для DI):
//   async runVerifierAgent(task, docContext, segmentRef, metaContext, aborted, telemetry) → result
//
//   Здесь docContext — это полный объект DocumentContext (а НЕ строка).
//   Внутри agentDispatcher вызывает его как есть. Адаптация под старый
//   `docContextStr` остаётся ответственностью caller'а (через
//   injectGlobalContext / buildContextualSystemPrompt в самом runner'е).
// ═══════════════════════════════════════════════════════════════════════

const { performance } = require('perf_hooks');
const {
    injectGlobalContext,
    buildContextualSystemPrompt,
    normalizeContext
} = require('./globalContext');

function createAgentDispatcher(deps = {}) {
    const {
        throttle,
        runVerifierAgent,
        logger = console
    } = deps;

    if (!throttle || typeof throttle.submit !== 'function') {
        throw new Error('[AgentDispatcher] throttle с методом submit() обязателен');
    }
    if (typeof runVerifierAgent !== 'function') {
        throw new Error('[AgentDispatcher] runVerifierAgent() обязателен');
    }

    /**
     * dispatch(tasks, opts) — главный entry point.
     *
     * @param {Array} tasks — массив задач для верификации (форма зависит от runner)
     * @param {Object} opts
     * @param {Object} opts.docContext — паспорт документа (объект или строка)
     * @param {Object} opts.aborted    — { value: bool } флаг отмены
     * @param {Object} opts.telemetry  — телеметрия
     * @param {Function} opts.onResult — callback для каждого завершённого task:
     *                                   ({ index, task, result?, error?, durationMs }) => void
     * @returns {Promise<Array>} results — порядок соответствует tasks[i]:
     *                                      { result?, error?, durationMs, aborted? }
     */
    async function dispatch(tasks, opts = {}) {
        const {
            docContext,
            aborted   = { value: false },
            telemetry = null,
            onResult  = null,
            stageLabel = 'verifier'
        } = opts;

        if (!Array.isArray(tasks) || tasks.length === 0) return [];

        const ctx = normalizeContext(docContext);
        const results = new Array(tasks.length);
        const startedAt = performance.now();
        const summary = {
            total: tasks.length,
            completed: 0,
            errored: 0,
            aborted: 0,
            stageLabel
        };

        // Каждый task — через throttle.submit().
        // Возвращаем массив promises и await Promise.all(promises) в конце.
        // Это даёт streaming (onResult по мере готовности) И ordered results.
        const promises = tasks.map((task, index) => {
            // Если уже отменили до submit — не отправляем в throttle.
            if (aborted.value) {
                results[index] = { aborted: true };
                summary.aborted++;
                return Promise.resolve();
            }
            return throttle.submit(async () => {
                if (aborted.value) {
                    results[index] = { aborted: true };
                    summary.aborted++;
                    return;
                }
                const t0 = performance.now();
                try {
                    const result = await runVerifierAgent(task, ctx, task.segmentRef, task.metaContext, aborted, telemetry);
                    const durationMs = performance.now() - t0;
                    results[index] = { result, durationMs };
                    summary.completed++;
                    if (typeof onResult === 'function') {
                        try {
                            onResult({ index, task, result, durationMs });
                        } catch (e) {
                            logger.warn?.(`[AgentDispatcher] onResult callback threw: ${e.message}`);
                        }
                    }
                } catch (error) {
                    const durationMs = performance.now() - t0;
                    const errMsg = error?.message || String(error);
                    results[index] = { error: errMsg, durationMs };
                    summary.errored++;
                    if (typeof onResult === 'function') {
                        try {
                            onResult({ index, task, error: errMsg, durationMs });
                        } catch (e) {
                            logger.warn?.(`[AgentDispatcher] onResult callback threw: ${e.message}`);
                        }
                    }
                }
            }).catch(throttleErr => {
                // throttle.submit может reject если stopped или taskFn throw
                // на синхронной фазе. Записываем как error.
                const errMsg = throttleErr?.message || String(throttleErr);
                if (results[index] === undefined) {
                    results[index] = { error: errMsg, durationMs: 0 };
                    summary.errored++;
                }
            });
        });

        await Promise.all(promises);
        const totalMs = performance.now() - startedAt;

        if (telemetry?.recordDispatcher) {
            try {
                telemetry.recordDispatcher({
                    stageLabel, totalMs,
                    summary,
                    throttleStats: throttle.stats?.() || null
                });
            } catch (_) { /* swallow telemetry errors */ }
        }

        return results;
    }

    return {
        dispatch,
        // Экспорт helpers для тестов / для caller'а который сам строит prompts
        helpers: {
            injectGlobalContext,
            buildContextualSystemPrompt,
            normalizeContext
        }
    };
}

module.exports = {
    createAgentDispatcher
};
