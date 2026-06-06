// ═══════════════════════════════════════════════════════════════════════
//  lib/llmCascade.js
//  Lightweight LLM Cascade — Фаза 0 рефакторинга Selective Reasoning v2.0
// ═══════════════════════════════════════════════════════════════════════
//
//  Каскад из трёх моделей для лёгких задач (Issue Splitter + Adaptive
//  Selector в Фазе 3). Принцип: per-attempt timeout, агрессивное
//  переключение между tier'ами, ни одной задержки между fallback'ами,
//  graceful degradation вместо throw наружу.
//
//  Tier 1: Gemini 3.1 Flash Lite  (Primary,  timeout 10s)
//  Tier 2: Gemini 2.5 Flash       (Fallback, timeout 15s)
//  Tier 3: DeepSeek V4 Flash      (Fallback, timeout 20s)
//
//  Дефолтные timeout'ы из ТЗ: 10/15/20 секунд. Перебиваются через opts.
//
//  Использование:
//    const { createLightLLMCascade } = require('../lib/llmCascade');
//    const cascade = createLightLLMCascade({ getNextKey, deepseekJsonCall,
//                                            deepseekEnabled, logger });
//    const { text, model, tier } = await cascade.call({
//        systemPrompt, userPrompt, jsonMode: true,
//        telemetry, stageLabel: 'splitter_batch_0'
//    });
// ═══════════════════════════════════════════════════════════════════════

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { performance } = require('perf_hooks');

// ── Конфигурация каскада ────────────────────────────────────────────────
const TIERS = [
    { tier: 1, kind: 'gemini',   model: 'gemini-3.1-flash-lite', defaultTimeoutMs: 10000 },
    { tier: 2, kind: 'gemini',   model: 'gemini-2.5-flash',      defaultTimeoutMs: 15000 },
    { tier: 3, kind: 'deepseek', model: 'deepseek-v4-flash',     defaultTimeoutMs: 20000 }
];

// ── Классификация ошибок ────────────────────────────────────────────────
// Возвращает 'timeout' | '429' | '5xx' | '4xx' | '404' | 'network' | 'other'
function classifyCascadeError(err) {
    if (!err) return 'other';
    if (err.name === 'AbortError' || err.message === 'CASCADE_TIMEOUT') return 'timeout';
    const status = err.status || err.response?.status || 0;
    const msg = String(err.message || '').toLowerCase();
    if (status === 404 || msg.includes('not found') || msg.includes('does not exist')) return '404';
    if (status === 429 || msg.includes('rate limit') || msg.includes('quota') || msg.includes('exceeded')) return '429';
    if (status >= 500 && status < 600) return '5xx';
    if (msg.includes('5xx') || msg.includes('503') || msg.includes('502') || msg.includes('504')) return '5xx';
    if (status >= 400 && status < 500) return '4xx';
    if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('network') || msg.includes('fetch failed')) return 'network';
    return 'other';
}

// ── Promise.race с таймером (для SDK без полноценной поддержки AbortSignal) ─
function withTimeout(promise, timeoutMs, label = 'cascade') {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const err = new Error('CASCADE_TIMEOUT');
            err.name = 'AbortError';
            err.timeout = true;
            err.label = label;
            reject(err);
        }, timeoutMs);
    });
    return Promise.race([promise, timeoutPromise])
        .finally(() => clearTimeout(timer));
}

// ── Tier 1/2: Gemini single-shot ────────────────────────────────────────
// БЕЗ внутренних retries — это работа каскада. Один промах = переход на след. tier.
//
// 2026-05-30: добавлены опциональные параметры для Agentic RAG:
//   tools          — массив { functionDeclarations: [...] } для function calling
//   contents       — кастомный contents-массив (multi-turn chat history)
//                    Если передан, userPrompt игнорируется.
//   returnRaw      — вернуть полный response объект (для tool-loop)
async function callGeminiSingle({
    apiKey, modelName, systemPrompt, userPrompt, jsonMode, timeoutMs,
    temperature, maxOutputTokens, tools = null, contents = null, returnRaw = false,
    thinkingConfig = null
}) {
    const genAI = new GoogleGenerativeAI(apiKey);
    const generationConfig = {
        temperature: typeof temperature === 'number' ? temperature : 0.2,
        topP: 0.9,
        maxOutputTokens: typeof maxOutputTokens === 'number' ? maxOutputTokens : 4096
    };
    // jsonMode и tools несовместимы (Gemini требует text/функциональный ответ).
    // Если переданы tools — игнорируем jsonMode на уровне responseMimeType.
    if (jsonMode && !tools) {
        generationConfig.responseMimeType = 'application/json';
    }
    // Опциональный нативный CoT (thinking) для моделей 2.5/3.x. Если модель/SDK его
    // не поддержит — вызов вернёт ошибку, вызывающий код делает graceful-фолбэк.
    if (thinkingConfig) {
        generationConfig.thinkingConfig = thinkingConfig;
    }
    const modelOpts = {
        model: modelName,
        systemInstruction: systemPrompt,
        generationConfig
    };
    if (Array.isArray(tools) && tools.length > 0) {
        modelOpts.tools = tools;
    }
    const model = genAI.getGenerativeModel(modelOpts);
    // 2026-06-02 FIX (critical): SDK.generateContent() принимает три формы:
    //   1) string                         → одно user-сообщение
    //   2) Array<Part>                    → Part[] для ОДНОГО user-сообщения
    //   3) GenerateContentRequest         → { contents: Content[], ... } multi-turn
    //
    // Раньше: payload = contents (массив Content'ов с role+parts) →
    //   SDK видел Array → формат 2 → пихал каждый Content внутрь parts[0] →
    //   Google API: 400 "Unknown name 'role' at contents[0].parts[0]".
    //
    // Сейчас: оборачиваем в request-объект (форма 3) — SDK пропускает as-is.
    // Структура самих Content'ов в agenticVerifier остаётся правильной:
    //   { role: 'user'|'model'|'user', parts: [{ text | functionCall | functionResponse }] }
    const payload = contents != null ? { contents } : userPrompt;
    const callPromise = model.generateContent(payload).then(result => {
        const response = result?.response;
        const text = (() => {
            try { return response?.text() || ''; } catch (_) { return ''; }
        })();
        const usage = response?.usageMetadata || {};
        const base = {
            text,
            usage: {
                promptTokens: usage.promptTokenCount || 0,
                completionTokens: usage.candidatesTokenCount || 0
            }
        };
        if (returnRaw) {
            base.rawResponse = response;
            base.candidates = response?.candidates || [];
        }
        return base;
    });
    return withTimeout(callPromise, timeoutMs, `gemini:${modelName}`);
}

// ── Tier 3: DeepSeek V4 Flash через инжектированный deepseekJsonCall ────
// Внутренние ретраи DeepSeek слишком медленные (8с backoff) → отключаем
// maxRetries=0, опираемся на per-attempt timeout каскада.
async function callDeepSeekSingle({ deepseekJsonCall, modelName, systemPrompt, userPrompt, timeoutMs, stageLabel, temperature, maxOutputTokens }) {
    const callPromise = deepseekJsonCall({
        systemPrompt,
        userPrompt,
        model: modelName,
        temperature: typeof temperature === 'number' ? temperature : 0.2,
        maxTokens: typeof maxOutputTokens === 'number' ? maxOutputTokens : 4096,
        maxRetries: 0,
        label: `cascade:${stageLabel}`,
        userId: `miyzamchi-cascade-${stageLabel}`
    }).then(rawText => ({
        text: rawText,
        usage: { promptTokens: 0, completionTokens: 0 } // deepseekJsonCall эмитит telemetry сам
    }));
    return withTimeout(callPromise, timeoutMs, `deepseek:${modelName}`);
}

// ── Главный entrypoint каскада ──────────────────────────────────────────
function createLightLLMCascade(deps) {
    const {
        getNextKey,
        deepseekJsonCall,
        deepseekEnabled = true,
        logger = console
    } = deps || {};

    if (typeof getNextKey !== 'function') {
        throw new Error('[LightLLMCascade] getNextKey() обязателен');
    }
    if (typeof deepseekJsonCall !== 'function') {
        throw new Error('[LightLLMCascade] deepseekJsonCall() обязателен');
    }

    async function call(opts = {}) {
        const {
            systemPrompt,
            userPrompt,
            jsonMode = true,
            telemetry = null,
            stageLabel = 'unknown',
            timeouts = null,           // [10000, 15000, 20000] override
            skipTiers = [],            // например [1] чтобы пропустить Primary
            temperature,               // null → дефолт 0.2 для всех tier'ов
            maxOutputTokens            // null → дефолт 4096 для всех tier'ов
        } = opts;

        if (!systemPrompt || !userPrompt) {
            throw new Error('[LightLLMCascade] systemPrompt и userPrompt обязательны');
        }

        const errors = [];
        let lastErr = null;

        for (let i = 0; i < TIERS.length; i++) {
            const tier = TIERS[i];
            if (skipTiers.includes(tier.tier)) continue;
            if (tier.kind === 'deepseek' && !deepseekEnabled) {
                logger.warn?.(`[Cascade ${stageLabel}] tier${tier.tier} (DeepSeek) disabled, skip`);
                continue;
            }

            const timeoutMs = (timeouts && timeouts[i]) || tier.defaultTimeoutMs;
            const tStart = performance.now();
            let status = 'ok';
            let errorKind = null;

            try {
                let result;
                if (tier.kind === 'gemini') {
                    const apiKey = getNextKey();
                    result = await callGeminiSingle({
                        apiKey,
                        modelName: tier.model,
                        systemPrompt,
                        userPrompt,
                        jsonMode,
                        timeoutMs,
                        temperature,
                        maxOutputTokens
                    });
                } else {
                    result = await callDeepSeekSingle({
                        deepseekJsonCall,
                        modelName: tier.model,
                        systemPrompt,
                        userPrompt,
                        timeoutMs,
                        stageLabel,
                        temperature,
                        maxOutputTokens
                    });
                }

                const durationMs = performance.now() - tStart;
                if (telemetry?.recordCascadeAttempt) {
                    telemetry.recordCascadeAttempt({
                        stageLabel, tier: tier.tier, model: tier.model,
                        durationMs, status: 'ok', errorKind: null
                    });
                }
                if (telemetry?.incrementCascadeCounter) {
                    telemetry.incrementCascadeCounter(`tier${tier.tier}_hits`);
                }
                return {
                    text: result.text,
                    model: tier.model,
                    tier: tier.tier,
                    durationMs,
                    usage: result.usage
                };
            } catch (err) {
                status = 'fail';
                errorKind = classifyCascadeError(err);
                lastErr = err;
                const durationMs = performance.now() - tStart;
                errors.push({ tier: tier.tier, model: tier.model, errorKind, message: err.message?.slice(0, 200) });

                if (telemetry?.recordCascadeAttempt) {
                    telemetry.recordCascadeAttempt({
                        stageLabel, tier: tier.tier, model: tier.model,
                        durationMs, status, errorKind
                    });
                }
                logger.warn?.(`[Cascade ${stageLabel}] tier${tier.tier} ${tier.model} ${errorKind} (${durationMs.toFixed(0)}ms) → next tier`);
                // Никакой задержки между tier'ами — каскад должен переключаться мгновенно.
                continue;
            }
        }

        if (telemetry?.incrementCascadeCounter) {
            telemetry.incrementCascadeCounter('all_failed');
        }
        const err = new Error(`[Cascade ${stageLabel}] все 3 tier'а провалились: ${errors.map(e => `t${e.tier}=${e.errorKind}`).join(', ')}`);
        err.cascade = { stageLabel, errors, lastError: lastErr };
        err.allFailed = true;
        throw err;
    }

    return { call, TIERS, classifyCascadeError };
}

module.exports = {
    createLightLLMCascade,
    classifyCascadeError,
    TIERS,
    // 2026-05-30: экспорт helpers для Agentic RAG (lib/agenticVerifier.js).
    // Multi-turn tool-loop требует прямого доступа к Gemini SDK, а каскад —
    // single-shot. agenticVerifier строит свой tier-loop поверх этих helpers.
    callGeminiSingle,
    callDeepSeekSingle,
    withTimeout
};
