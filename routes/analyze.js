// ═══════════════════════════════════════════════════════════════════════
//  routes/analyze.js
//  /api/upload-document  +  /api/analyze-document
//  SHADOW PIPELINE + CONTROLLED STREAMING MAP-REDUCE + TRIAGE
// ═══════════════════════════════════════════════════════════════════════
//
//  АРХИТЕКТУРА (после PR3 — Shadow Pipeline):
//  ─────────────────────────────────────────────────────────────────────
//   ⚡ ФАЗА 0 (фоновая, /api/upload-document):
//      Юрист только загрузил файл — фронт сразу шлёт текст на /upload.
//      Бэкенд параллельно: extractDocumentContext + segmentDocument → triage.
//      Возвращает sessionId. Юрист может ещё ничего не делать — а у нас
//      уже есть docContext + segments + triage + meta_context в session-store.
//
//   ⚡ ФАЗА 1 (по нажатию "Проверить", /api/analyze-document):
//      Если фронт прислал sessionId И в store есть валидная запись с
//      совпадающим MD5 текста → ПРОПУСКАЕМ context+segment+triage,
//      идём сразу к emit safe_triage + verify + judge.
//      Экономия: 5-15 секунд видимого времени (мгновенный старт таблицы).
//
//   Без sessionId или при cache miss — работаем как раньше (PR1+PR2).
//   Все остальные шаги (cache пунктов, agent с meta_context, abort,
//   DCR judge, fallback) — без изменений.
//
//  ЦЕЛЕВОЕ ВРЕМЯ (после PR3, при холодном клике + горячей session):
//   • Без рисков: 5-10с (только verify нескольких + skip-stream + judge skip)
//   • Средняя сложность: 15-25с
//   • Сложный с critical: 30-45с
//   • Повторный анализ того же документа (clause cache hit): 5-8с
// ═══════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { createLightLLMCascade } = require('../lib/llmCascade');
const { segmentDocumentRegex, wrapAsAnalyzeSegments } = require('../lib/segmentRegex');
const { createPhase3Pipeline } = require('../lib/phase3');
const { normalizeNpaName } = require('../lib/npaAliases');
const { shouldRunPhase3 } = require('../lib/smartSkipPhase3');
// ── 2026-05-30: Hybrid Segmenter + Smooth Burst Throttle + Agent Dispatcher
const { createHybridSegmenter } = require('../lib/hybridSegmenter');
const { createSmoothBurstThrottle } = require('../lib/smoothBurstThrottle');
const { createAgentDispatcher } = require('../lib/agentDispatcher');
const { normalizeContext } = require('../lib/globalContext');
// ── 2026-05-30: Hierarchical Contextual RAG (Macro + Mezzo + Micro) ──────
// Заменяет старые plain global/local-context injection. Универсальная
// система: одна архитектура работает от расписки на салфетке до иска в ООН.
const { generateDocumentPassport } = require('../lib/documentPassport');
const { buildChunkTopology } = require('../lib/topology');
const { buildHCREmbeddingQuery, buildHCRSystemPrompt, buildHCRUserPromptLine } = require('../lib/hierarchicalContext');
// ── 2026-05-30: Agentic RAG — модель сама вызывает search_legislation_kg ──
// Заменяет pre-fetch + склейку 3-10 статей в userPrompt. Tier1/2 (Gemini)
// — multi-turn tool calling. Tier3 (DeepSeek) — legacy single-shot fallback.
// MAX_TOOL_TURNS=3, watchdog=45s. SSE-событие agent_search показывает
// юристу что именно ищет агент.
const { createAgenticVerifier, TOOL_PROTOCOL_BLOCK } = require('../lib/agenticVerifier');
// ── 2026-06-01: Full Debug Trace — каждый чих пайплайна в .md файл ──
// Создаётся один trace на /api/analyze-document. Содержит: input doc head,
// passport, triage, для КАЖДОГО сегмента — system+user prompt, все tool_call'ы,
// все Pinecone-выдачи (полный текст 800 chars), финальный вердикт. И Final
// Judge: system, user (включая оригинал документа), полный ответ. Юрист
// скачивает через кнопку "📥 Скачать debug-отчёт" в IDE.
const { createTraceLogger, readTraceFile, listTraces, TRACE_FILENAME_RE } = require('../lib/traceLogger');

class TelemetryCollector {
    constructor() {
        this.metrics = {
            times: {},
            agents: { pineconeSearch: [], agentLlm: [] },
            tokens: { prompt: 0, completion: 0 },
            // ── Расширение Фазы 0 (Selective Reasoning v2.0) ────────────
            // cascade — для лёгкого каскада в Phase 3 (Splitter + Adaptive Selector).
            cascade: {
                counters: {
                    tier1_hits: 0,   // Gemini 3.1 Flash Lite (Primary)
                    tier2_hits: 0,   // Gemini 2.5 Flash (Fallback 1)
                    tier3_hits: 0,   // DeepSeek V4 Flash (Fallback 2)
                    all_failed: 0    // все три провалились → degraded
                },
                attempts: []         // полный лог попыток для отладки
            },
            // counters — произвольные счётчики для Phase 3 (simple/heavy path и пр.)
            counters: {}
        };
        this.startTime = performance.now();
        this.timers = {};
    }

    startTimer(name) {
        this.timers[name] = performance.now();
    }

    endTimer(name) {
        if (this.timers[name]) {
            this.metrics.times[name] = (performance.now() - this.timers[name]) / 1000;
        }
    }

    recordAgentTime(type, durationMs) {
        if (this.metrics.agents[type]) {
            this.metrics.agents[type].push(durationMs / 1000);
        }
    }

    addTokens(prompt, completion) {
        this.metrics.tokens.prompt += prompt;
        this.metrics.tokens.completion += completion;
    }

    estimateTokens(text) {
        return Math.ceil(String(text || '').length / 3.5);
    }

    // ── Cascade telemetry (Phase 0) ─────────────────────────────────────
    recordCascadeAttempt({ stageLabel, tier, model, durationMs, status, errorKind }) {
        try {
            this.metrics.cascade.attempts.push({
                stageLabel, tier, model,
                durationMs: Math.round(durationMs),
                status,
                errorKind: errorKind || null,
                at: Math.round(performance.now() - this.startTime)
            });
        } catch (e) {}
    }

    incrementCascadeCounter(key) {
        try {
            if (this.metrics.cascade.counters[key] === undefined) {
                this.metrics.cascade.counters[key] = 0;
            }
            this.metrics.cascade.counters[key]++;
        } catch (e) {}
    }

    // ── Универсальные счётчики (для simple_path_chunks / heavy_path_chunks и т.п.) ─
    incrementCounter(key, delta = 1) {
        try {
            if (this.metrics.counters[key] === undefined) {
                this.metrics.counters[key] = 0;
            }
            this.metrics.counters[key] += delta;
        } catch (e) {}
    }

    generateReport() {
        try {
            const totalTime = ((performance.now() - this.startTime) / 1000).toFixed(2);
            
            const formatArr = (arr) => {
                if (!arr || arr.length === 0) return 'Min 0.00s, Max 0.00s, Avg 0.00s';
                const min = Math.min(...arr).toFixed(2);
                const max = Math.max(...arr).toFixed(2);
                const avg = (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2);
                return `Min ${min}s, Max ${max}s, Avg ${avg}s`;
            };

            let report = `\n========== TELEMETRY REPORT ==========\n`;
            report += `[ОБЩИЕ МЕТРИКИ]\n`;
            report += `Total Execution Time: ${totalTime}s\n`;
            if (this.metrics.times['Router_Classification_Time']) report += `Router Time: ${this.metrics.times['Router_Classification_Time'].toFixed(2)}s\n`;
            if (this.metrics.times['Segmentation_Time']) report += `Segmentation Time: ${this.metrics.times['Segmentation_Time'].toFixed(2)}s\n`;
            if (this.metrics.times['Triage_Time']) report += `Triage Time: ${this.metrics.times['Triage_Time'].toFixed(2)}s\n`;
            if (this.metrics.times['Final_Judge_Time']) report += `Final Judge Time: ${this.metrics.times['Final_Judge_Time'].toFixed(2)}s\n`;
            
            report += `\n[АГЕНТЫ (Параллельная работа)]\n`;
            report += `Всего обработано пунктов: ${this.metrics.agents.agentLlm.length}\n`;
            report += `Pinecone Search: ${formatArr(this.metrics.agents.pineconeSearch)}\n`;
            report += `Agent LLM Audit: ${formatArr(this.metrics.agents.agentLlm)}\n`;

            report += `\n[ТОКЕНОМЕТРИКА]\n`;
            report += `Total Prompt Tokens (est.): ${this.metrics.tokens.prompt}\n`;
            report += `Total Completion Tokens (est.): ${this.metrics.tokens.completion}\n`;

            // ── Cascade-секция (Phase 0+) ───────────────────────────────
            const cc = this.metrics.cascade?.counters || {};
            const cascadeTotal = (cc.tier1_hits || 0) + (cc.tier2_hits || 0) + (cc.tier3_hits || 0) + (cc.all_failed || 0);
            if (cascadeTotal > 0) {
                const pct = (n) => cascadeTotal ? ((n / cascadeTotal) * 100).toFixed(1) : '0.0';
                report += `\n[LLM CASCADE (Phase 3 light models)]\n`;
                report += `Total cascade calls: ${cascadeTotal}\n`;
                report += `  Tier 1 (Gemini 3.1 Flash Lite): ${cc.tier1_hits || 0} (${pct(cc.tier1_hits || 0)}%)\n`;
                report += `  Tier 2 (Gemini 2.5 Flash):      ${cc.tier2_hits || 0} (${pct(cc.tier2_hits || 0)}%)\n`;
                report += `  Tier 3 (DeepSeek V4 Flash):     ${cc.tier3_hits || 0} (${pct(cc.tier3_hits || 0)}%)\n`;
                report += `  All failed (degraded):          ${cc.all_failed || 0} (${pct(cc.all_failed || 0)}%)\n`;
                const attempts = this.metrics.cascade.attempts || [];
                const failedAttempts = attempts.filter(a => a.status !== 'ok');
                if (failedAttempts.length) {
                    const byKind = {};
                    failedAttempts.forEach(a => {
                        const k = `t${a.tier}:${a.errorKind || 'unknown'}`;
                        byKind[k] = (byKind[k] || 0) + 1;
                    });
                    report += `Failed attempts breakdown: ${Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join(', ')}\n`;
                }
            }

            // ── Универсальные счётчики (Phase 3 paths) ───────────────────
            const counters = this.metrics.counters || {};
            const counterKeys = Object.keys(counters);
            if (counterKeys.length > 0) {
                report += `\n[COUNTERS]\n`;
                for (const k of counterKeys) {
                    report += `  ${k}: ${counters[k]}\n`;
                }
            }

            report += `======================================\n`;

            return report;
        } catch (e) {
            console.error('[Telemetry] Error generating report:', e);
            return '========== TELEMETRY REPORT ERROR ==========\n';
        }
    }
}

// ── Лимиты параллельности ────────────────────────────────────────────
// Этап А (2026-05-27): bumped 12 → 16 после перевода Ищеек на Flash Lite.
// Flash Lite держит rate-limit лучше DeepSeek, плюс быстрее ~2-3×. На 52
// audit-чанках это ~3.3 волны вместо ~4.3 → экономия ~6-8с.
// Не повышаем выше 18 — может задеть DeepSeek 429 в Tier 3 fallback.
const SEGMENTS_CONCURRENCY        = 16;
const HOUNDS_PER_SEG_CONCURRENCY  = 3;

// ── 2026-05-30: Smooth Burst Throttle для агентов-верификаторов ──────
// 20 RPS = 1 запрос каждые 50ms. Tier 1 (Gemini 3.1 Flash Lite) держит
// 4000 RPM = 66 RPS, мы берём ~30% headroom для каскадных fallback'ов
// на Tier 2/3 (если Tier 1 ляжет). maxConcurrent=100 — защита от
// зависших Gemini-ответов (если упало 100 — больше не накапливаем).
const VERIFIER_THROTTLE_RPS       = 20;
const VERIFIER_MAX_CONCURRENT     = 100;

// User_id для KVCache-изоляции
const KVCACHE_TRIAGE_ID     = 'miyzamchi-triage-v1';
const KVCACHE_AGENT_ID      = 'miyzamchi-audit-agent-v1';
const KVCACHE_JUDGE_FAST_ID = 'miyzamchi-judge-fast-v1';
const KVCACHE_JUDGE_DEEP_ID = 'miyzamchi-judge-deep-v1';

// Модели
const DEEPSEEK_TRIAGE_MODEL     = 'deepseek-v4-flash';
const DEEPSEEK_AGENT_MODEL      = 'deepseek-v4-flash';
const DEEPSEEK_JUDGE_FAST_MODEL = 'deepseek-v4-flash'; // Стандартный Судья (дефолт)
const DEEPSEEK_JUDGE_DEEP_MODEL = 'deepseek-v4-pro';   // Верховный Судья (только эскалация)

// ── 2026-06-12: Пороги эскалации Final Judge на Верховного Судью (v4-pro) ──
// Эскалируем ТОЛЬКО если документ очень длинный ИЛИ агенты нашли сложные
// коллизии. Всё остальное — Стандартный Судья (v4-flash): дешевле и быстрее.
const JUDGE_LONG_DOC_CHARS    = 30000; // ~15+ страниц сплошного текста
const JUDGE_LONG_DOC_SEGMENTS = 40;    // столько проверенных пунктов = большой документ
const JUDGE_HARD_CRITICALS    = 2;     // ≥2 critical = сложные разногласия/коллизии
const JUDGE_HARD_TOTAL_RISKS  = 6;     // ≥6 рисков суммарно = тяжёлый кейс

// ── Семафор контролируемой параллельности ───────────────────────────
async function runWithConcurrency(items, concurrency, taskFn, opts = {}) {
    if (!items || items.length === 0) return [];
    const aborted = opts.aborted || { value: false };
    const results = new Array(items.length);
    let cursor = 0;
    async function worker() {
        while (true) {
            if (aborted.value) return;
            const i = cursor++;
            if (i >= items.length) return;
            try { results[i] = await taskFn(items[i], i); }
            catch (e) { results[i] = undefined; }
        }
    }
    const pool = Array.from(
        { length: Math.min(concurrency, items.length) },
        () => worker()
    );
    await Promise.all(pool);
    return results;
}

// ── БРОНЕБОЙНЫЙ JSON PARSER ──────────────────────────────────────────
function safeJsonParseStrict(rawText, fallback = null) {
    if (!rawText || typeof rawText !== 'string') {
        return fallback || { status: 'error', confidence: null, rationale: 'Пустой ответ модели', law_refs: [] };
    }
    let cleaned = rawText.trim();
    const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) cleaned = fenceMatch[1].trim();
    if (!cleaned.startsWith('{')) {
        const objMatch = cleaned.match(/\{[\s\S]*\}/);
        if (objMatch) cleaned = objMatch[0];
    }
    try {
        return JSON.parse(cleaned);
    } catch (e) {
        console.error('[safeJsonParseStrict] failed:', e.message?.slice(0, 100), '| sample:', cleaned.slice(0, 200));
        return fallback || {
            status: 'error',
            confidence: null,
            rationale: 'Ошибка парсинга ответа LLM: ' + e.message?.slice(0, 80),
            law_refs: []
        };
    }
}

// ── IN-MEMORY CLAUSE CACHE (per-clause MD5 result cache, 1ч TTL) ────
function normalizeClauseText(text) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .replace(/[“”«»]/g, '"')
        .replace(/[‘’]/g, "'")
        .trim()
        .toLowerCase();
}
function clauseCacheKey(text) {
    return crypto.createHash('md5').update(normalizeClauseText(text)).digest('hex');
}
const clauseCache = new Map();
const CLAUSE_CACHE_TTL_MS  = 60 * 60 * 1000;
const CLAUSE_CACHE_MAX_SIZE = 1000;

function cacheGetClause(text) {
    try {
        const key = clauseCacheKey(text);
        const entry = clauseCache.get(key);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) {
            clauseCache.delete(key);
            return null;
        }
        return entry.result;
    } catch (e) {
        console.warn('[ClauseCache get]', e.message);
        return null;
    }
}
function cacheSetClause(text, result) {
    try {
        if (clauseCache.size >= CLAUSE_CACHE_MAX_SIZE) {
            const dropCount = Math.floor(CLAUSE_CACHE_MAX_SIZE * 0.1);
            const keysToDrop = [];
            let i = 0;
            for (const k of clauseCache.keys()) {
                if (i++ >= dropCount) break;
                keysToDrop.push(k);
            }
            for (const k of keysToDrop) clauseCache.delete(k);
        }
        const key = clauseCacheKey(text);
        clauseCache.set(key, { result, expiresAt: Date.now() + CLAUSE_CACHE_TTL_MS });
    } catch (e) {
        console.warn('[ClauseCache set]', e.message);
    }
}

// ── SESSION STORE для Shadow Pipeline (PR3) ─────────────────────────
// Хранит подготовленное состояние пайплайна между /upload-document
// и /analyze-document. TTL=15 минут (юрист может смотреть документ
// какое-то время перед нажатием "Проверить").
//
// Map<sessionId, { docContext, segments, triage, meta_context,
//                  documentTextHash, expiresAt }>
//
// Защита от рассинхрона: documentTextHash (MD5 от полного текста).
// Если на /analyze пришёл изменённый текст с тем же sessionId — миссим
// session и запускаем полный пайплайн (юрист правил доку после загрузки).
const SESSION_TTL_MS  = 15 * 60 * 1000;
const SESSION_MAX_SIZE = 200;
const sessionStore = new Map();

function sessionCreate() {
    return crypto.randomUUID();
}
function sessionHashDoc(text) {
    return crypto.createHash('md5').update(String(text || '')).digest('hex');
}

// ── ⚡ Нормализация исходного текста (Phase 1, Selective Reasoning v2.0) ─
// Чистим мусорные пробелы и \r\n, но СОХРАНЯЕМ структуру абзацев (\n\n) —
// на ней основана Regex-сегментация в Phase 2. Применяется ДО sessionHashDoc
// в роутах /api/upload-document и /api/analyze-document, чтобы Shadow
// Pipeline и /analyze давали одинаковый хэш на одном и том же документе
// (фикс cache-miss из-за CRLF/BOM/трейлинг-пробелов в зависимости от ОС
// и буфера фронта).
//
// NB: для clause cache используется отдельный normalizeClauseText (более
// агрессивный, с lowercase). Разные слои — разные нормализации.
function normalizeText(text) {
    return String(text || '')
        .replace(/\r\n/g, '\n')      // CRLF (Windows) → LF
        .replace(/\r/g, '\n')         // одиночные CR (старый Mac, редко) → LF
        .replace(/[ \t]+/g, ' ')      // схлопываем пробелы и табы
        .replace(/\n{3,}/g, '\n\n')   // 3+ переносов → ровно 2 (граница абзаца)
        .trim();
}
function sessionGet(sessionId) {
    if (!sessionId) return null;
    try {
        const entry = sessionStore.get(sessionId);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) {
            sessionStore.delete(sessionId);
            return null;
        }
        return entry;
    } catch (e) {
        console.warn('[Session get]', e.message);
        return null;
    }
}
function sessionSet(sessionId, state) {
    try {
        if (sessionStore.size >= SESSION_MAX_SIZE) {
            const dropCount = Math.floor(SESSION_MAX_SIZE * 0.1);
            const keysToDrop = [];
            let i = 0;
            for (const k of sessionStore.keys()) {
                if (i++ >= dropCount) break;
                keysToDrop.push(k);
            }
            for (const k of keysToDrop) sessionStore.delete(k);
        }
        sessionStore.set(sessionId, { ...state, expiresAt: Date.now() + SESSION_TTL_MS });
    } catch (e) {
        console.warn('[Session set]', e.message);
    }
}

module.exports = function registerAnalyzeRoute(deps) {
    const {
        app,
        getEmbedding,
        callOnce,
        searchPinecone,
        getNextKey,
        streamDeepSeekResponse,
        deepseekJsonCall,
        DEEPSEEK_ENABLED,
        // segmentDocument: устаревший LLM-сегментатор. Заменён на segmentDocumentRegex
        // в Phase 2 рефакторинга (Selective Reasoning v2.0). Сама функция в server.js
        // НЕ удалена и продолжает передаваться через deps — это путь отката.
        // Чтобы откатить Phase 2: восстановить эту строку и вернуть segmentsPromise
        // в preparePipelineState.
        // segmentDocument,  // <-- раскомментировать при откате
        extractDocumentContext,
        formatDocContext,
        sendStep,
        sendStatus,
        requireClientToken,
        requestTelemetry,
        logger
    } = deps;

    // ── Phase 0: Light LLM Cascade (Selective Reasoning v2.0) ──────────
    // Каскад из 3 tier'ов с per-attempt timeout, без задержек между fallback'ами.
    // Используется в Фазе 3 для Issue Splitter и Adaptive Selector.
    // Tier1: gemini-3.1-flash-lite (10s) → Tier2: gemini-2.5-flash (15s) → Tier3: deepseek-v4-flash (20s)
    const lightLLMCascade = createLightLLMCascade({
        getNextKey,
        deepseekJsonCall,
        deepseekEnabled: DEEPSEEK_ENABLED !== false,
        logger
    });

    // ── Phase 3: Batched Issue Splitter + Adaptive RAG ─────────────────
    // Инстанс готов. Интеграция в /api/analyze-document — в Фазе 4
    // (когда переведём Ищеек на structured JSON и подадим relevant_articles).
    // Граничный SSE-warning при degraded mode идёт через sendStep (deps).
    const phase3Pipeline = createPhase3Pipeline({
        lightLLMCascade,
        getEmbedding,
        searchPinecone,
        runWithConcurrency,
        safeJsonParseStrict,
        sendStep,
        normalizeNpaName,
        logger
    });

    // ── 2026-05-30: Hybrid Segmenter (Layer A regex + Layer B AI corrector) ─
    // Замена прямого segmentDocumentRegex. Layer A покрывает 14/16 кейсов из
    // test_corpus/ за 200ms. Layer B (через lightLLMCascade) точечно чинит
    // патологии (GIANT_CHUNK / TOO_MANY_SMALL / DOMINANT / TOO_FEW) на
    // оставшихся 2/16. Lossless-guard 5%, graceful fallback на A при любом
    // failure. См. SEGMENTATION_STRATEGY.md.
    const hybridSegmenter = createHybridSegmenter({
        cascade: lightLLMCascade,
        layerBEnabled: process.env.HYBRID_LAYER_B !== 'off',
        logger
    });

    // ── 2026-05-30: SmoothBurstThrottle для агентов-верификаторов ──────
    // Один процесс — один throttle, переиспользуется между запросами.
    // Drift-corrected setTimeout, ровно 50ms между стартами, без burst'ов
    // которые могут попасть под Google Gemini rate-limiter.
    const verifierThrottle = createSmoothBurstThrottle({
        rps: VERIFIER_THROTTLE_RPS,
        maxConcurrent: VERIFIER_MAX_CONCURRENT,
        logger
    });

    // ── 2026-05-30: Agentic Verifier (Agentic RAG с function calling) ──
    // Принимает Паспорт+Топологию+текст, отдаёт LLM с инструментом
    // search_legislation_kg. Модель сама ищет, оценивает 5 статей,
    // отбрасывает false positives, пишет вердикт.
    //
    // throttle прокинут — каждый turn внутри одного task'а проходит через
    // verifierThrottle.submit() повторно. Это держит 20 RPS совокупно по
    // ВСЕМ LLM-вызовам, а не только по запускам task'ов. Очередь не
    // блокируется — пока turn 2 task'а A ждёт слот, task B стартует.
    const agenticVerifier = createAgenticVerifier({
        getNextKey,
        searchPinecone,
        getEmbedding,
        deepseekJsonCall,
        deepseekEnabled: DEEPSEEK_ENABLED !== false,
        buildHCREmbeddingQuery,
        throttle: verifierThrottle,
        logger
    });

    function extractArticleMentions(text) {
        const regex = /(?:ст\.|стать[ьяиеюямях])\s*(\d+(?:-\d+)*)(?:\s+([А-Яа-яЁёA-Za-z\s]{2,20}))?/gi;
        const matches = [];
        let match;
        while ((match = regex.exec(text)) !== null) {
            matches.push({ number: match[1], act: match[2] ? match[2].trim() : '' });
        }
        const unique = [];
        const seen = new Set();
        for (const m of matches) {
            if (!seen.has(m.number)) { seen.add(m.number); unique.push(m); }
        }
        return unique;
    }

    function chunkLongSegment(text, maxLen = 800) {
        if (text.length <= maxLen) return [text];
        const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
        const chunks = [];
        let currentChunk = '';
        for (const s of sentences) {
            if ((currentChunk.length + s.length) > maxLen && currentChunk.length > 0) {
                chunks.push(currentChunk.trim());
                currentChunk = '';
            }
            currentChunk += s + ' ';
        }
        if (currentChunk.trim().length > 0) chunks.push(currentChunk.trim());
        return chunks;
    }

    // ── TRIAGE LAYER ────────────────────────────────────────────────
    async function runTriage(segments, aborted, telemetry) {
        if (telemetry) telemetry.startTimer('Triage_Time');
        if (!segments || segments.length === 0) {
            return { triage: [], meta_context: '', mode: 'empty' };
        }
        if (aborted.value) return { triage: [], meta_context: '', mode: 'aborted' };

        const compactSegments = segments.map((s, idx) =>
            `Пункт #${idx} (№${s.number}) ${s.heading}:\n"""${String(s.text || '').slice(0, 600)}"""`
        ).join('\n\n');

        const systemPrompt = `Ты — юридический триаж-классификатор для договоров Кыргызской Республики.

Твоя задача — БЫСТРО за один проход разделить пункты документа на 2 категории:

▸ "skip" — ТИПОВЫЕ/реквизитные пункты БЕЗ юридических рисков:
  • реквизиты сторон, контактные данные, банковские реквизиты
  • общее описание предмета договора (без сумм/условий)
  • стандартный форс-мажор (типовая формулировка)
  • заключительные положения (количество экземпляров, нумерация, юр.адрес)
  • дата/место заключения, подписи

▸ "rag_audit" — пункты с финансовыми/юридическими/операционными обязательствами:
  • неустойка, штрафы, пени, ответственность
  • сроки исполнения, исковой давности
  • конкретные права/обязанности сторон
  • условия расторжения, выхода, односторонний отказ
  • конфиденциальность, NDA
  • гарантии, обеспечение, поручительство
  • подсудность, юрисдикция, применимое право
  • цена, порядок расчётов, индексация, валюта
  • интеллектуальная собственность
  • ЛЮБОЕ упоминание конкретных статей НПА (ст. X ГК/УК/...)

При сомнениях — ВСЕГДА выбирай "rag_audit" (лучше проверить лишний раз).

Дополнительно сформируй meta_context — 3-строчная выжимка о договоре в формате:
"Договор: <тип>. Стороны: <сторона1> и <сторона2>. Сумма: <если есть>. Юрисдикция: КР."

Отвечаешь СТРОГО валидным JSON без markdown без пояснений.`;

        const userPrompt = `Документ содержит ${segments.length} пунктов.

${compactSegments}

Верни СТРОГО JSON с двумя полями:
{
  "meta_context": "Договор: ... Стороны: ... Сумма: ... Юрисдикция: КР.",
  "triage": [
    {"idx": 0, "action": "skip" | "rag_audit"},
    {"idx": 1, "action": "skip" | "rag_audit"},
    ...
  ]
}

КРИТИЧНО:
- В массиве triage должно быть РОВНО ${segments.length} записей (по одной на каждый пункт #0..#${segments.length - 1})
- idx должен соответствовать номеру #X из списка выше
- При сомнениях — "rag_audit"`;

        const fallbackTriage = () => ({
            triage: segments.map((_, idx) => ({ idx, action: 'rag_audit' })),
            meta_context: '',
            mode: 'fallback'
        });

        // maxOutputTokens рассчитываем динамически — каждая запись triage ~30 токенов
        // + meta_context ~150 токенов + JSON overhead. Запас x2 на длинные heading.
        // Для 25 пунктов = 25*30 + 150 + 200 = ~1100; берём x3 запас = 3500.
        // Для 71 пункта = 71*90 + 500 = ~6890; даём 8192 как верхний лимит.
        const dynamicMaxTokens = Math.min(8192, Math.max(2048, segments.length * 90 + 500));

        // ── Этап А (Selective Reasoning v2.0): Triage через lightLLMCascade ──
        // Tier 1: gemini-3.1-flash-lite (быстро + дёшево, идеально для классификации)
        // Tier 2: gemini-2.5-flash (fallback)
        // Tier 3: deepseek-v4-flash (последний рубеж)
        // Каскад сам пишет провалившиеся попытки в telemetry.metrics.cascade.attempts.
        let raw, provider;
        try {
            const result = await lightLLMCascade.call({
                systemPrompt,
                userPrompt,
                jsonMode: true,
                temperature: 0.1,
                maxOutputTokens: dynamicMaxTokens,
                telemetry,
                stageLabel: 'triage'
            });
            raw = result.text;
            provider = `cascade-tier${result.tier}-${result.model}`;
        } catch (cascadeErr) {
            // err.allFailed → все 3 tier'а провалились. Safe degrade в all-rag_audit.
            console.error(`[Triage] cascade fully failed → safe degrade to all-rag_audit | ${cascadeErr.message?.slice(0, 120)}`);
            if (telemetry) telemetry.endTimer('Triage_Time');
            return fallbackTriage();
        }

        let parsed = safeJsonParseStrict(raw, null);

        if (!parsed || !Array.isArray(parsed.triage) || parsed.triage.length === 0) {
            console.warn(`[Triage] Invalid JSON from ${provider} → safe degrade to all-rag_audit`);
            if (telemetry) telemetry.endTimer('Triage_Time');
            return fallbackTriage();
        }

        const triageByIdx = new Map();
        for (const t of parsed.triage) {
            const idx = Number(t.idx);
            if (Number.isInteger(idx) && idx >= 0 && idx < segments.length) {
                triageByIdx.set(idx, t.action === 'skip' ? 'skip' : 'rag_audit');
            }
        }
        const triage = segments.map((_, idx) => ({
            idx,
            action: triageByIdx.get(idx) || 'rag_audit'
        }));

        const skipCount = triage.filter(t => t.action === 'skip').length;
        const auditCount = triage.length - skipCount;
        console.log(`[Triage] mode=${provider} | total=${segments.length} | skip=${skipCount} | rag_audit=${auditCount}`);

        if (telemetry) {
            telemetry.endTimer('Triage_Time');
            telemetry.addTokens(telemetry.estimateTokens(systemPrompt + userPrompt), telemetry.estimateTokens(raw));
        }
        return {
            triage,
            meta_context: String(parsed.meta_context || '').slice(0, 280).trim(),
            mode: provider
        };
    }

    // ── EMIT SAFE_TRIAGE ROWS ────────────────────────────────────────
    // UX-блок Этапа А (2026-05-27): все skip-пункты доходят до фронта с
    // понятным "Без рисков" вердиктом + развёрнутым rationale. Юрист видит
    // ВСЕ N пунктов документа в таблице, а не только проблемные.
    // SSE-контракт tableRow не меняем (фронт от него зависит) — обновляем
    // только тексты внутри.
    const SAFE_TRIAGE_RATIONALE = 'Стандартный пункт документа: реквизиты, преамбула или типовое условие без юридических рисков. Не требует глубокой сверки с НПА КР.';
    const SAFE_TRIAGE_VERDICT   = '✅ Без рисков';

    function emitSafeTriageRows(skipSegmentsWithIdx, res) {
        for (const { seg, idx } of skipSegmentsWithIdx) {
            const refLabel = `п.${seg.number} ${seg.heading}`.trim();
            res.write(`data: ${JSON.stringify({
                safe_triage_segment: {
                    id: seg.id,
                    number: seg.number,
                    status: 'safe_triage',
                    confidence: null,
                    rationale: SAFE_TRIAGE_RATIONALE
                }
            })}\n\n`);
            res.write(`data: ${JSON.stringify({
                tableRow: {
                    item_number: refLabel,
                    short_verdict: SAFE_TRIAGE_VERDICT,
                    status: 'ok',
                    confidence: null,
                    legal_rationale: SAFE_TRIAGE_RATIONALE,
                    applicable_articles: [],
                    law_refs: [],
                    triage: 'safe'
                }
            })}\n\n`);
            sendStep(res, {
                id: `seg_${idx}`,
                status: 'success',
                text: refLabel,
                reason: SAFE_TRIAGE_VERDICT
            });
        }
    }

    // ── AGENT calls ─────────────────────────────────────────────────
    // Этап А (Selective Reasoning v2.0, 2026-05-27): Ищейки переведены на
    // lightLLMCascade с Tier 1 = gemini-3.1-flash-lite. Тесты на test_corpus/
    // показали что Flash Lite быстрее DeepSeek в 2-3× и качество вывода
    // достаточно для атомарной задачи "проверь фрагмент против N статей".
    // Final Judge остаётся на DeepSeek V4 Pro — тяжёлая артиллерия для
    // executive summary.
    //
    // Каскад автоматически переключится на Tier 2 (2.5 Flash) / Tier 3
    // (DeepSeek V4 Flash) если Tier 1 ляжет.
    //
    // Старые callDeepSeekAgent / callGeminiAgentFallback / callWithFallback
    // удалены вместе с этим переключением. Откат: восстановить из git
    // commit `<id>` и вернуть тело runVerifierAgent.
    async function callAgentCascade(systemPrompt, userPrompt, telemetry, stageLabel = 'agent') {
        try {
            const result = await lightLLMCascade.call({
                systemPrompt,
                userPrompt,
                jsonMode: true,
                temperature: 0.2,
                maxOutputTokens: 1500,
                telemetry,
                stageLabel
            });
            return { provider: `cascade-tier${result.tier}-${result.model}`, raw: result.text };
        } catch (cascadeErr) {
            // err.allFailed → все 3 tier'а провалились. Пробрасываем — runVerifierAgent
            // обработает в catch'е и вернёт degraded-результат для этого пункта.
            console.error(`[callAgentCascade] cascade fully failed | ${cascadeErr.message?.slice(0, 120)}`);
            throw cascadeErr;
        }
    }

    // ── VERIFIER AGENT (Agentic RAG · 2026-05-30) ───────────────────────
    // 2026-05-30: убран pre-fetch Pinecone + склейка RAG в userPrompt.
    // Модель сама вызывает search_legislation_kg(query, reason) через
    // agenticVerifier.run(...). MAX_TOOL_TURNS=3, watchdog=45s.
    // SSE-событие agent_search показывает юристу в UI что ищет агент.
    //
    // HCR-контекст (Macro/Mezzo/Micro) сохранён: buildHCRSystemPrompt
    // обогащает baseSystemPrompt Паспортом+Топологией+focusHint.
    //
    // task поля:
    //   • textToAnalyze, targetType, targetArticle, articleGroup
    //   • passport, topology (HCR)
    //   • preFetchedArticles — если Phase 3 уже нашёл точные статьи,
    //     ПРОПУСКАЕМ tool-loop, идём через legacy (передаём как готовый
    //     RAG-контекст; модель не делает поиск). Это экономит время на
    //     явных кейсах "ст.137 УК КР".
    async function runVerifierAgent(task, docContextOrPassport, segmentRef, metaContext, aborted, telemetry) {
        if (aborted.value) return null;
        const { textToAnalyze, targetType, targetArticle, articleGroup, preFetchedArticles } = task;
        const passport = task.passport
            || (docContextOrPassport && typeof docContextOrPassport === 'object' && docContextOrPassport.title
                ? docContextOrPassport : null);
        const topology = task.topology || null;
        // 2026-06-01: full debug trace (или noop если выключен)
        const trace = task._trace || null;
        const verifierStartedAt = performance.now();
        if (trace && !trace.isNoop) {
            try {
                await trace.logVerifierStart({
                    segmentRef,
                    originalIdx: task.originalIdx,
                    targetType,
                    targetArticle,
                    articleGroup,
                    topology,
                    textHead: textToAnalyze
                });
            } catch (_) {}
        }

        // Кэшируем только когда НЕ преднабор: pre-fetched может варьироваться.
        const isCacheable = !preFetchedArticles && (targetType === 'general' || targetType === 'article');
        if (isCacheable) {
            const cached = cacheGetClause(textToAnalyze);
            if (cached) {
                console.log(`[Verifier] CACHE HIT for ${segmentRef}`);
                return {
                    ...cached,
                    rationale: (cached.rationale || '') + ' [Проверено ранее]',
                    provider: 'cache'
                };
            }
        }

        if (aborted.value) return null;

        const textHead = textToAnalyze.slice(0, 450);
        const stageLabel = `agent_seg_${segmentRef.replace(/\W+/g, '_').slice(0, 30)}`;

        const focusInstruction = targetType === 'multi-article'
            ? `соответствие пункта КАЖДОЙ из упомянутых в нём статей: ${articleGroup.map(a => `ст.${a.number} ${a.act}`).join(', ')}`
            : targetType === 'article'
                ? `соответствие конкретной статье ${targetArticle.number} ${targetArticle.act}`
                : `общее соответствие законодательству КР по теме фрагмента`;

        const metaLine = metaContext ? `КОНТЕКСТ СДЕЛКИ: ${metaContext}\n` : '';
        const localLine = buildHCRUserPromptLine(topology);

        // Базовый промпт: убран старый блок "Применяй ТОЛЬКО нормы из
        // переданных RAG-материалов" — теперь модель сама делает RAG.
        // TOOL_PROTOCOL_BLOCK инструктирует как пользоваться функцией и
        // как фильтровать false positives через ожидаемые НПА из Паспорта.
        const baseSystemPrompt = `Ты — юрист-аудитор Кыргызской Республики. Проверяешь ОДИН фрагмент юридического документа.
${metaLine}Не упоминай в ответе слова "RAG", "база данных", "Pinecone", "функция", "инструмент".
Отвечаешь СТРОГО валидным JSON без markdown без пояснений.

${TOOL_PROTOCOL_BLOCK}`;

        const systemPrompt = buildHCRSystemPrompt(baseSystemPrompt, passport, topology);

        const schemaBlock = `Верни строго JSON со следующей схемой (СТРОГО соблюдай лимиты длины):
{
  "status": "ok" | "warning" | "critical",
  "confidence": <число от 0 до 100>,
  "finding": "<до 180 символов> одно ёмкое предложение — суть оценки",
  "rationale": "<до 400 символов> 1-2 предложения с конкретной ссылкой на найденную норму",
  "suggestion": "<до 180 символов> что исправить (или пустая строка)"
}

КРИТИЧНО: соблюдай лимиты — превышение приводит к обрезке ответа.

Расшифровка status:
- ok       — фрагмент соответствует нормам, нарушений нет
- warning  — формально валидно, но есть юридический риск / неточная формулировка
- critical — прямое противоречие нормам КР или ущемление прав нашей стороны`;

        // ── Ветка 1: pre-fetched (Phase 3 уже нашёл точные статьи) ──
        // Не запускаем agentic loop, делаем один LLM-вызов с готовым RAG.
        // Экономит ~3-5с на явных кейсах "ст.N УК".
        if (Array.isArray(preFetchedArticles) && preFetchedArticles.length > 0) {
            const applicableArticles = [];
            const seenArt = new Set();
            for (const a of preFetchedArticles) {
                const npa = a.npa || '';
                const articleTitle = a.articleTitle || (a.article ? `Статья ${a.article}` : '');
                const full = (a.fullText || '').slice(0, 1000);
                if (!full) continue;
                const key = `${npa}|${articleTitle}`;
                if (seenArt.has(key)) continue;
                seenArt.add(key);
                applicableArticles.push({ npa_title: npa, article_title: articleTitle, full_text: full });
            }
            const ragContext = applicableArticles.length
                ? applicableArticles.map((a, i) => `[${i + 1}] ${a.npa_title} — ${a.article_title}\n${a.full_text}`).join('\n\n')
                : 'Релевантные статьи в базе НПА не найдены.';

            const prefetchUserPrompt = `КОНТЕКСТ ВСЕГО ДОКУМЕНТА: ${passport?.summary || passport?.title || 'Не указан'}
${localLine}ФОКУС ТВОЕЙ ПРОВЕРКИ: ${focusInstruction}

Фрагмент (${segmentRef}):
"""
${textToAnalyze}
"""

Релевантные статьи КР (предзагружены, поиск не требуется):
${ragContext}

${schemaBlock}`;

            // 2026-06-02: симметризация трейса с Веткой 2.
            // Раньше Ветка 1 (preFetched) писала только logVerifierStart —
            // ни промптов, ни статей, ни ответа, ни вердикта. Чанки с
            // targetType:'phase3' становились "чёрной дырой" в trace.md.
            // 2026-06-02: убрали logVerifierSystemPrompt/UserPrompt из Verifier-веток —
            // они раздували trace.md (~80% объёма) повторами статичного блока правил
            // и passport/topology. Оставлены только данные, меняющиеся per-chunk:
            // start (meta), tool_response (prefetched articles), final_text (ответ LLM),
            // verdict (распарсенный JSON).
            if (trace && !trace.isNoop) {
                try {
                    await trace.logVerifierTurn({
                        turn: 0,
                        tier: 'prefetched',
                        model: 'phase3-pinecone',
                        kind: 'tool_response',
                        payload: {
                            articles: applicableArticles.map(a => ({
                                npa_title: a.npa_title,
                                article_title: a.article_title,
                                full_text: a.full_text
                            })),
                            error: null,
                            note: `prefetched by Phase 3 Adaptive RAG (${applicableArticles.length} articles, no agentic search)`
                        }
                    });
                } catch (_) {}
            }

            const agentStart = performance.now();
            let raw = '', provider = 'cascade-pending';
            try {
                const cascadeResult = await callAgentCascade(systemPrompt, prefetchUserPrompt, telemetry, stageLabel);
                provider = cascadeResult.provider;
                raw = cascadeResult.raw;
            } catch (cascadeErr) {
                if (telemetry) telemetry.recordAgentTime('agentLlm', performance.now() - agentStart);
                if (trace && !trace.isNoop) {
                    try {
                        await trace.logVerifierTurn({
                            turn: 1, tier: 'prefetched', model: provider,
                            kind: 'tier_error',
                            payload: { errorKind: 'cascade-failed', message: cascadeErr.message }
                        });
                    } catch (_) {}
                }
                const failedVerdict = {
                    status: 'warning', confidence: 0,
                    finding: 'Анализ временно недоступен',
                    rationale: 'Все три модели каскада не ответили. Пункт требует ручной проверки юристом.',
                    suggestion: '', articles: applicableArticles, provider: 'cascade-failed'
                };
                if (trace && !trace.isNoop) {
                    try {
                        await trace.logVerifierVerdict({
                            verdict: failedVerdict,
                            durationMs: performance.now() - verifierStartedAt,
                            toolCalls: 0,
                            articlesCount: applicableArticles.length
                        });
                    } catch (_) {}
                }
                return failedVerdict;
            }
            if (telemetry) {
                telemetry.recordAgentTime('agentLlm', performance.now() - agentStart);
                telemetry.addTokens(telemetry.estimateTokens(systemPrompt + prefetchUserPrompt), telemetry.estimateTokens(raw));
            }
            if (trace && !trace.isNoop) {
                try {
                    await trace.logVerifierTurn({
                        turn: 1, tier: 'prefetched', model: provider,
                        kind: 'final_text',
                        payload: { text: raw }
                    });
                } catch (_) {}
            }
            const verdict = finalizeVerifierResult(raw, applicableArticles, provider, isCacheable, textToAnalyze);
            if (trace && !trace.isNoop) {
                try {
                    await trace.logVerifierVerdict({
                        verdict,
                        durationMs: performance.now() - verifierStartedAt,
                        toolCalls: 0,
                        articlesCount: applicableArticles.length
                    });
                } catch (_) {}
            }
            return verdict;
        }

        // ── Ветка 2: Agentic RAG (основной путь) ──
        const userPrompt = `КОНТЕКСТ ВСЕГО ДОКУМЕНТА: ${passport?.summary || passport?.title || 'Не указан'}
${localLine}ФОКУС ТВОЕЙ ПРОВЕРКИ: ${focusInstruction}

Фрагмент (${segmentRef}):
"""
${textToAnalyze}
"""

Используй search_legislation_kg, чтобы найти релевантные статьи КР, КРИТИЧНО оцени их и верни вердикт.

${schemaBlock}`;

        const agentStart = performance.now();

        // onSearchEvent → SSE-событие agent_search во фронт.
        // res здесь не виден напрямую → caller (verifySegmentsSmart)
        // должен пробросить sendStep через task.onSearchEvent если хочет
        // показывать "🔎 Агент ищет..." в UI. По умолчанию — log only.
        const onSearchEvent = task._onSearchEvent || ((ev) => {
            console.log(`[Verifier ${segmentRef}] 🔎 turn ${ev.turn}: "${ev.query?.slice(0, 80)}"`);
        });

        try {
            const out = await agenticVerifier.run({
                baseSystemPrompt: systemPrompt,
                userPrompt,
                passport,
                topology,
                targetType,
                targetArticle,
                articleGroup,
                textHead,
                telemetry,
                stageLabel,
                maxToolTurns: 3,
                topK: 5,
                watchdogMs: 45000,
                aborted,
                onSearchEvent,
                trace             // 2026-06-01: пишем prompts/tool_calls/RAG в trace
            });

            if (telemetry) {
                telemetry.recordAgentTime('agentLlm', performance.now() - agentStart);
                telemetry.addTokens(
                    out.usage?.promptTokens || telemetry.estimateTokens(systemPrompt + userPrompt),
                    out.usage?.completionTokens || telemetry.estimateTokens(out.text || '')
                );
            }

            const provider = `agentic-tier${out.tier}-${out.model}`;
            const verdict = finalizeVerifierResult(out.text, out.articles || [], provider, isCacheable, textToAnalyze, out.toolCalls);
            if (trace && !trace.isNoop) {
                try {
                    await trace.logVerifierVerdict({
                        verdict,
                        durationMs: performance.now() - verifierStartedAt,
                        toolCalls: (out.toolCalls || []).length,
                        articlesCount: (out.articles || []).length
                    });
                } catch (_) {}
            }
            return verdict;
        } catch (err) {
            if (telemetry) telemetry.recordAgentTime('agentLlm', performance.now() - agentStart);
            if (err?.aborted) return null;
            if (err?.allFailed) {
                return {
                    status: 'warning', confidence: 0,
                    finding: 'Анализ временно недоступен',
                    rationale: 'Все три модели (Gemini Lite, 2.5 Flash, DeepSeek-fallback) не ответили. Пункт требует ручной проверки.',
                    suggestion: '', articles: [], provider: 'agentic-failed'
                };
            }
            console.error('[Verifier fatal]', err.message);
            return {
                status: 'error', confidence: null,
                finding: 'Не удалось проанализировать пункт',
                rationale: err.message || 'Неизвестная ошибка',
                suggestion: '', articles: [], provider: 'none'
            };
        }
    }

    // ── Helper: парсинг ответа модели + кэширование ─────────────────────
    function finalizeVerifierResult(raw, applicableArticles, provider, isCacheable, textToAnalyze, toolCalls = null) {
        const parsed = safeJsonParseStrict(raw, null);
        if (!parsed || parsed.status === 'error') {
            return {
                status: 'warning', confidence: 0,
                finding: 'Ответ модели не распарсился',
                rationale: parsed?.rationale || 'JSON parse error',
                suggestion: '', articles: applicableArticles, provider, toolCalls: toolCalls || undefined
            };
        }
        const result = {
            status:    ['ok', 'warning', 'critical'].includes(parsed.status) ? parsed.status : 'warning',
            confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(100, parsed.confidence)) : 50,
            finding:    String(parsed.finding    || '').slice(0, 320).trim() || 'Анализ не дал явного результата.',
            rationale:  String(parsed.rationale  || '').slice(0, 800).trim(),
            suggestion: String(parsed.suggestion || '').slice(0, 320).trim(),
            articles:   applicableArticles,
            provider
        };
        if (toolCalls) result.toolCalls = toolCalls;
        if (isCacheable && result.status !== 'error') {
            cacheSetClause(textToAnalyze, {
                status: result.status, confidence: result.confidence,
                finding: result.finding, rationale: result.rationale,
                suggestion: result.suggestion, articles: result.articles
            });
        }
        return result;
    }

    // ── Aggregation ─────────────────────────────────────────────────
    function aggregateAgentResults(agentResults, seg) {
        const refLabel = `п.${seg.number} ${seg.heading}`.trim();
        const valid = agentResults.filter(Boolean);
        if (valid.length === 0) {
            return {
                item_number: refLabel,
                short_verdict: 'Не удалось проверить пункт (все агенты упали)',
                status: 'error',
                confidence: null,
                legal_rationale: '',
                applicable_articles: [],
                law_refs: []
            };
        }
        const priority = { critical: 4, error: 3, warning: 2, ok: 1 };
        const worst = valid.reduce((acc, r) =>
            (priority[r.status] || 0) > (priority[acc.status] || 0) ? r : acc
        );
        const confidences = valid.map(r => r.confidence).filter(c => typeof c === 'number');
        const avgConfidence = confidences.length
            ? Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length)
            : null;
        const shortVerdict = valid.length === 1
            ? worst.finding
            : valid.map(r => {
                const icon = r.status === 'critical' ? '🔴' : r.status === 'warning' ? '🟡' : r.status === 'error' ? '⚪' : '🟢';
                return `${icon} ${r.finding}`;
              }).join(' · ').slice(0, 400);
        const rationale = valid.map(r => {
            const parts = [r.rationale];
            if (r.suggestion) parts.push(`Рекомендация: ${r.suggestion}`);
            return parts.filter(Boolean).join(' ');
        }).filter(Boolean).join('\n\n');
        const seenArt = new Set();
        const uniqueArt = [];
        for (const r of valid) {
            for (const a of (r.articles || [])) {
                const key = `${a.npa_title}|${a.article_title}`;
                if (!seenArt.has(key)) { seenArt.add(key); uniqueArt.push(a); }
            }
        }
        const lawRefs = uniqueArt.slice(0, 5).map(a => ({
            code: a.article_title || a.npa_title,
            excerpt: (a.full_text || '').slice(0, 200)
        }));
        return {
            item_number: refLabel,
            short_verdict: shortVerdict,
            status: worst.status === 'error' ? 'warning' : worst.status,
            confidence: avgConfidence,
            legal_rationale: rationale,
            applicable_articles: uniqueArt,
            law_refs: lawRefs
        };
    }

    // ── 2026-05-30: Agent Dispatcher (Smooth Burst Throttle 20 RPS) ────
    // runVerifierAgent выше — function declaration, hoisted в scope. Dispatcher
    // композирует throttle + global-context-injection + runner. dispatch()
    // плоско проталкивает все agent-tasks (segments * hounds) через throttle
    // и через onResult callback стримит вердикты по мере готовности.
    const agentDispatcher = createAgentDispatcher({
        throttle: verifierThrottle,
        runVerifierAgent,
        logger
    });

    // ── Helper: построение списка hound-задач на один сегмент ──────────
    // Логика взята из старого processSegment в verifySegmentsSmart, чтобы
    // dispatcher умел собрать flat-список tasks из всех сегментов.
    function buildSegmentTasks(seg, auditIdx, phase3ByAuditIdx) {
        const phase3Articles = phase3ByAuditIdx && phase3ByAuditIdx[auditIdx]
            ? phase3ByAuditIdx[auditIdx].relevant_articles
            : null;
        const tasks = [];
        if (Array.isArray(phase3Articles) && phase3Articles.length > 0) {
            tasks.push({
                textToAnalyze: seg.text,
                targetType: 'phase3',
                preFetchedArticles: phase3Articles,
                topK: phase3Articles.length
            });
        } else {
            const mentions = extractArticleMentions(seg.text);
            const isVeryLong = seg.text.length > 3000;
            const ARTICLES_PER_AGENT = 5;
            if (mentions.length > 0) {
                for (let g = 0; g < mentions.length; g += ARTICLES_PER_AGENT) {
                    const group = mentions.slice(g, g + ARTICLES_PER_AGENT);
                    tasks.push({ textToAnalyze: seg.text, targetType: 'multi-article', articleGroup: group, topK: 3 });
                }
            } else if (isVeryLong) {
                const chunks = chunkLongSegment(seg.text, 1000);
                for (const chunk of chunks) {
                    tasks.push({ textToAnalyze: chunk, targetType: 'general', targetArticle: null, topK: 5 });
                }
            } else {
                tasks.push({ textToAnalyze: seg.text, targetType: 'general', targetArticle: null, topK: 5 });
            }
        }
        return tasks;
    }

    // ── MAP-фаза ────────────────────────────────────────────────────
    // 2026-06-01: добавлен trace — full debug trace logger (noop если выключен)
    async function verifySegmentsSmart(segmentsWithIdx, res, passport, metaContext, aborted, telemetry, phase3ByAuditIdx = null, chunkContexts = null, allSegments = null, trace = null) {
        if (!segmentsWithIdx || segmentsWithIdx.length === 0) return [];

        // ── 2026-05-30: Flat tasks через Smooth Burst Throttle (20 RPS) ────
        // Был: runWithConcurrency(segments, 16) внешний × runWithConcurrency(hounds, 3) внутренний
        //   → факт. throughput ~5 RPS, искусственно тормозили Tier 1 Gemini Lite.
        // Стал: ВСЕ (segment × hound) пары плоско через verifierThrottle с
        //   ровным 50ms интервалом, ровно 20 RPS. Каждый агент стартует
        //   независимо от готовности соседей.
        // Streaming: при готовности последнего hound для сегмента — мгновенно
        //   агрегируем и отправляем tableRow (fastest-first порядок на фронте).

        const segmentMeta = [];   // per-segment агрегатор
        const allTasks = [];      // плоский массив для dispatcher

        for (let segmentIdx = 0; segmentIdx < segmentsWithIdx.length; segmentIdx++) {
            const { seg, originalIdx } = segmentsWithIdx[segmentIdx];
            const refLabel = `п.${seg.number} ${seg.heading}`.trim();

            sendStep(res, {
                id: `seg_${originalIdx}`,
                status: 'loading',
                text: `Пункт ${seg.number}: маршрутизация`
            });

            const houndTasks = buildSegmentTasks(seg, segmentIdx, phase3ByAuditIdx);

            // Регистрируем мета-инфу сегмента ДО добавления tasks (чтобы onResult
            // мог найти её по segmentIdx даже если первая task завершится мгновенно).
            segmentMeta.push({
                seg, originalIdx, refLabel,
                houndsCount: houndTasks.length,
                pending: houndTasks.length,
                results: new Array(houndTasks.length),
                emitted: false
            });

            // Добавляем мета-поля к каждой task — нужны agentDispatcher
            // (он зовёт runVerifierAgent(task, docContext, task.segmentRef, task.metaContext, ...))
            // и onResult callback'у (segmentIdx / houndIdx для аккумуляции).
            //
            // 2026-05-30 HCR: топология — Mezzo-уровень. Strict: посчитать
            // на ВСЁМ списке segments (allSegments), а не только на audit-подмножестве,
            // чтобы chunkIndex/totalChunks отражали реальный документ.
            const topologySource = Array.isArray(allSegments)
                ? allSegments.map(s => String(s?.text || ''))
                : segmentsWithIdx.map(s => String(s?.seg?.text || ''));
            const topology = buildChunkTopology({
                chunks: topologySource,
                chunkIndex: originalIdx,
                chunkContexts
            });

            for (let houndIdx = 0; houndIdx < houndTasks.length; houndIdx++) {
                allTasks.push({
                    ...houndTasks[houndIdx],
                    segmentIdx,
                    houndIdx,
                    originalIdx,
                    segmentRef: refLabel,
                    metaContext,
                    // HCR triple context: Macro (passport) + Mezzo (topology) +
                    // Micro (task.textToAnalyze). runVerifierAgent композирует.
                    passport,
                    topology,
                    // 2026-06-01: full debug trace — пишем по каждому сегменту
                    // system+user prompt, tool_calls, RAG-выдачу, вердикт.
                    _trace: trace,
                    // 2026-05-30 Agentic RAG: SSE-событие agent_search.
                    // Когда модель внутри agenticVerifier вызывает
                    // search_legislation_kg(query, reason), мы стримим это
                    // во фронт — юрист видит "🔎 Агент ищет: ..." в IDE.
                    _onSearchEvent: (ev) => {
                        try {
                            if (aborted.value) return;
                            res.write(`data: ${JSON.stringify({
                                agent_search: {
                                    segmentRef: refLabel,
                                    originalIdx,
                                    query: String(ev.query || '').slice(0, 200),
                                    reason: String(ev.reason || '').slice(0, 120),
                                    turn: ev.turn,
                                    model: ev.model
                                }
                            })}\n\n`);
                        } catch (_) { /* swallow SSE errors */ }
                    }
                });
            }

            sendStep(res, {
                id: `seg_${originalIdx}`,
                status: 'loading',
                text: `Пункт ${seg.number}: ${houndTasks.length} агент(ов) работают`
            });
        }

        const finalVerdicts = new Array(segmentsWithIdx.length);

        await agentDispatcher.dispatch(allTasks, {
            // 2026-05-30 HCR: passport заменяет docContext. agentDispatcher
            // прокидывает его дальше как первый позиционный параметр в
            // runVerifierAgent (там читается из task.passport, но передаём
            // и через dispatcher для совместимости с прежним контрактом).
            docContext: passport,
            aborted,
            telemetry,
            stageLabel: 'verify_segments',
            onResult: ({ task, result, error }) => {
                const meta = segmentMeta[task.segmentIdx];
                if (!meta || meta.emitted) return;
                meta.results[task.houndIdx] = result || null;
                meta.pending--;
                if (meta.pending !== 0) return;
                if (aborted.value) return;

                meta.emitted = true;
                const verdict = aggregateAgentResults(meta.results, meta.seg);
                finalVerdicts[task.segmentIdx] = verdict;

                const uiStatus = verdict.status === 'critical' ? 'error'
                              : verdict.status === 'warning'  ? 'warning'
                              : 'success';
                sendStep(res, {
                    id: `seg_${meta.originalIdx}`,
                    status: uiStatus,
                    text: verdict.item_number,
                    reason: verdict.short_verdict
                });
                res.write(`data: ${JSON.stringify({ tableRow: verdict })}\n\n`);
            }
        });

        return finalVerdicts.filter(Boolean);
    }

    // ── FINAL JUDGE (DCR) ───────────────────────────────────────────
    // 2026-05-31 UX fix: добавлен documentText — оригинальный сплошной
    // текст пользователя. Раньше Судья видел только отчёт агентов с
    // техническими "п.1, п.13" → писал "в п.13 ошибка", пользователь не
    // понимал о чём речь (в его документе нет нумерации). Теперь Судья
    // видит оригинал И отчёт, ссылается на смысловые блоки оригинала,
    // не на технические чанки. reasoning_effort повышен до high/medium.
    async function runFinalJudge(finalResults, res, docContextStr, aborted, telemetry, documentText = '', trace = null) {
        if (telemetry) telemetry.startTimer('Final_Judge_Time');
        if (finalResults.length === 0) { if (telemetry) telemetry.endTimer('Final_Judge_Time'); return; }
        if (aborted.value) { if (telemetry) telemetry.endTimer('Final_Judge_Time'); return; }

        const total = finalResults.length;
        const critical = finalResults.filter(r => r.status === 'critical');
        const warning  = finalResults.filter(r => r.status === 'warning');
        const ok       = finalResults.filter(r => r.status === 'ok' || !r.status);
        const purityIndex = Math.round(((total - critical.length) / total) * 100);

        res.write(`data: ${JSON.stringify({ purityIndex })}\n\n`);

        const risks = [...critical, ...warning];

        if (risks.length === 0) {
            // 2026-06-02: формат clean-summary унифицирован с модельным —
            // ровно ДВЕ секции, без "Общих рекомендаций". Cbd-ссылка
            // встроена inline в Ключевые риски (не отдельным разделом).
            const cleanSummary = `## Краткий вывод
Документ юридически чист. По всем ${total} проверенным пунктам нарушений или существенных рисков не выявлено. Положения соответствуют действующему законодательству Кыргызской Республики.

## Ключевые риски
Существенных юридических рисков не обнаружено. Документ можно использовать в его текущей редакции. При необходимости актуальность норм проверяется по [cbd.minjust.gov.kg](https://cbd.minjust.gov.kg).`;
            res.write(`data: ${JSON.stringify({ text: cleanSummary })}\n\n`);
            res.write(`data: ${JSON.stringify({
                executive_summary: { summary: 'Документ проверен. Существенных юридических рисков не обнаружено.', top_risks: [] }
            })}\n\n`);
            console.log('[Judge] SKIPPED — purity 100%, no risks');
            if (telemetry) telemetry.endTimer('Final_Judge_Time');
            return;
        }

        const sortedRisks = risks.slice().sort((a, b) => (b.confidence || 50) - (a.confidence || 50));
        const topRisks = sortedRisks.slice(0, 3).map(r => ({
            id: r.item_number,
            title: r.short_verdict.slice(0, 120),
            confidence: r.confidence || 50
        }));

        // ── 2026-06-12 Динамическая развилка Судьи: Standard vs Верховный ──
        // СТАНДАРТНЫЙ Судья (deepseek-v4-flash) — дефолт для лёгких/средних
        // документов: дешёвый и быстрый синтез. Reasoning по прежней шкале:
        //   0 critical, 0-2 warning  → 'low'    (быстрый синтез одной-двух фраз)
        //   0 critical, 3-5 warning  → 'medium' (сбалансированный)
        //   1 critical (до порога)   → 'high'
        //
        // ВЕРХОВНЫЙ Судья (deepseek-v4-pro) — вызывается ТОЛЬКО при эскалации:
        //   • очень длинный документ (>JUDGE_LONG_DOC_CHARS символов или
        //     >JUDGE_LONG_DOC_SEGMENTS проверенных пунктов), ИЛИ
        //   • сложные коллизии (≥JUDGE_HARD_CRITICALS critical или
        //     ≥JUDGE_HARD_TOTAL_RISKS рисков суммарно от базовых агентов).
        //
        // ⚡ ANTI-LATENCY (критическое требование): у v4-pro reasoning_effort
        // ПРИНУДИТЕЛЬНО снижен до 'medium' — 'high' на Pro даёт многоминутные
        // раздумья, а Судья лишь синтезирует готовые вердикты агентов, ему
        // не нужно "думать заново". Базовые агенты (Gemini) не тронуты.
        //
        // KVCache-ID раздельные (fast/deep) — у каждой модели свой кеш-контур.
        const totalRisks = critical.length + warning.length;
        const docChars = String(documentText || '').length;
        const isLongDoc  = docChars > JUDGE_LONG_DOC_CHARS || total > JUDGE_LONG_DOC_SEGMENTS;
        const isHardCase = critical.length >= JUDGE_HARD_CRITICALS || totalRisks >= JUDGE_HARD_TOTAL_RISKS;
        const useSupreme = isLongDoc || isHardCase;

        let judgeModel, judgeReasoning, judgeUserId, pathLabel;
        if (useSupreme) {
            judgeModel     = DEEPSEEK_JUDGE_DEEP_MODEL;   // Верховный: deepseek-v4-pro
            judgeReasoning = 'medium';                    // принудительно снижено (latency)
            judgeUserId    = KVCACHE_JUDGE_DEEP_ID;
            pathLabel      = `supreme/${isLongDoc ? 'long-doc' : 'collisions'}`;
        } else {
            judgeModel     = DEEPSEEK_JUDGE_FAST_MODEL;   // Стандартный: deepseek-v4-flash
            if (critical.length > 0) judgeReasoning = 'high';
            else if (totalRisks >= 3) judgeReasoning = 'medium';
            else judgeReasoning = 'low';
            judgeUserId    = KVCACHE_JUDGE_FAST_ID;
            pathLabel      = `standard/${judgeReasoning}`;
        }

        const riskReports = sortedRisks.map(r =>
            `[${(r.status || '').toUpperCase()} ${r.confidence || '?'}%] ${r.item_number}: ${r.short_verdict}\nДетали: ${r.legal_rationale}`
        ).join('\n\n---\n\n');

        const systemPrompt = `Ты — Синтезатор Финальных Заключений платформы "Мыйзамчы".

🎯 ТВОЯ РОЛЬ
Ты — НЕ юрист-аудитор. Ты НЕ проводишь самостоятельную проверку документа. Ты НЕ ищешь новые риски. Ты НЕ оцениваешь стилистику.

Ты — СИНТЕЗАТОР: берёшь готовые вердикты из секции [ОТЧЁТ АГЕНТОВ ПО ФРАГМЕНТАМ] (status, finding, rationale, applicable_articles) и собираешь их в связный человекочитаемый текст для юриста.

Агенты уже прошли через векторную базу, проверили каждый пункт против норм КР, отфильтровали false positives. Их вердикт — ИСТИНА ПОСЛЕДНЕЙ ИНСТАНЦИИ для тебя. Не сомневайся в нём, не дополняй, не уточняй.

🛑 ШЕСТЬ ЖЕЛЕЗНЫХ ЗАПРЕТОВ:

1) ЗАПРЕТ НА ИЗОБРЕТЕНИЕ НОВЫХ РИСКОВ.
Если риск НЕ упомянут в отчёте агентов — ты НЕ имеешь права его поднимать.
⛔ ЗАПРЕЩЕНО:
   • "Также рекомендую обратить внимание на..."
   • "Стоит дополнительно проверить..."
   • "Не указано, есть ли..."
   • "Рекомендуется добавить..."
   • "В документе отсутствует упоминание..."
   • "Целесообразно было бы предусмотреть..."
Агенты уже всё нашли. Если в отчёте нет — значит чисто. Точка.

2) ЗАПРЕТ НА HEDGING (ПЕРЕСТРАХОВКУ).
⛔ ЗАПРЕЩЕНО:
   • "Номера статей могли измениться"
   • "Возможно, в новой редакции..."
   • "Рекомендуется уточнить актуальность"
   • "В случае изменения законодательства..."
   • "Не исключено, что..."
   • "Следует иметь в виду риск..."
   • "Целесообразно дополнительно сверить..."
Перестраховочные фразы создают у юриста ложное чувство риска и подрывают доверие к платформе. Если агенты не нашли проблему — её нет. Точка.

3) ЗАПРЕТ НА СТИЛИСТИКУ И БЮРОКРАТИЮ.
⛔ ЗАПРЕЩЕНО:
   • "Добавьте конкретные даты"
   • "Укажите полное название акта при каждом упоминании"
   • "Уточните формулировку"
   • "Приведите ссылки на источники"
   • "Оформите согласно требованиям делопроизводства"
   • "Структурируйте текст более чётко"
Это вкусовщина, не юридический риск. Юрист сам решит, как оформлять документ.

4) ЗАПРЕТ НА УГАДЫВАНИЕ НОМЕРОВ СТАТЕЙ.
Законы КР регулярно меняются (Конституция 2010 → 2021, новые редакции кодексов). В твоих весах — СТАРЫЕ номера. Любой номер из памяти = галлюцинация.
✅ Цитируй номер ТОЛЬКО если он явно присутствует в applicable_articles вердикта одного из агентов.
✅ Если корректного номера в applicable_articles нет — формулируй мягко, БЕЗ называния цифры: "Указанная норма требует уточнения по официальному источнику (cbd.minjust.gov.kg)."

5) ЗАПРЕТ НА УПОМИНАНИЕ ТЕХНИЧЕСКИХ ЧАНКОВ.
Отчёт агентов разбит на "п.1, п.5, п.13" — это нарезка скрипта. В оригинальном документе пользователя этих номеров может НЕ БЫТЬ.
⛔ ЗАПРЕЩЕНО: "в п.10 ошибка", "пункт 7 содержит общие фразы", "фрагмент 25 содержит", "недостаточно информации в пункте N".
✅ Привязка к СМЫСЛОВЫМ блокам оригинала: "в разделе о ...", "в части про ...", "при описании обстоятельств ...", "во вводной части ...".
Реальные авторские номера ("пункт 3.1 Договора", "раздел II.3", "статья 5 Договора") разрешены ТОЛЬКО если они физически есть в [ОРИГИНАЛЬНЫЙ ТЕКСТ ДОКУМЕНТА] — сверяйся.

6) ЗАПРЕТ НА FALSE POSITIVE RAG.
В applicable_articles иногда попадают акты не из отрасли документа (мусор от векторного поиска).
⛔ ЗАПРЕЩЕНО упоминать: "Закон о рекламе" в уголовном деле, "ГПК" в договоре поставки, "Кодекс этики" в гражданском иске, "Семейный кодекс" в коммерческом договоре.
⛔ ЗАПРЕЩЕНО писать "автор/заявитель сослался на закон X" — пользователь НЕ ССЫЛАЛСЯ, это робот ошибся.
✅ Игнорируй такие записи МОЛЧА. Опирайся только на НПА, соответствующие отрасли права из Паспорта.

📐 ФОРМАТ ОТВЕТА (СТРОГО ДВЕ СЕКЦИИ, никакого третьего раздела):

## Краткий вывод
2-3 предложения. Что за документ. Чистый он юридически или содержит риски. Без воды, без перестраховки, без "однако следует учитывать".

## Ключевые риски
Только то, что в отчёте агентов помечено как critical/warning. Для каждого риска:
• смысловая привязка к разделу оригинала (НЕ номер чанка)
• конкретная норма из applicable_articles (если есть)
• краткое описание проблемы (1-2 предложения)

Если в отчёте агентов рисков НЕТ — секция содержит РОВНО ОДНУ фразу:
"Существенных юридических рисков не обнаружено."
И НИ СЛОВА БОЛЬШЕ. Никаких "однако стоит обратить внимание...", "рекомендуется дополнительно...", "не указано, есть ли...". Этот случай = чистый документ, ты НЕ имеешь права изобретать риски.

🚫 НЕ ДОБАВЛЯЙ ТРЕТЬЮ СЕКЦИЮ "Общие рекомендации". Этой секции нет в формате. Любой текст после "Ключевые риски" — это нарушение протокола.

🗣 ТОН: спокойный, профессиональный, как живой опытный юрист.
ЗАПРЕЩЕНО использовать: JSON, markdown блоки кода (\`\`\`), слова "Pinecone", "система", "отчёт агентов", "справочник", "функция", "инструмент", "вердикт", "база данных", "RAG", "пайплайн", "алгоритм".`;

        // 2026-05-31: ОРИГИНАЛЬНЫЙ ТЕКСТ ДОКУМЕНТА — ПЕРВЫМ.
        // Судья должен сначала увидеть сплошной текст пользователя, и только
        // потом отчёт агентов с техническими "п.1, п.13". Это позволяет
        // Судье ссылаться на смысловые блоки оригинала, а не на чанки.
        //
        // Капим до 15000 символов (~4000 токенов). Длиннее редко нужно
        // для Executive Summary; цена reasoning_effort=high и без того высокая.
        const DOC_HEAD_LIMIT = 15000;
        const docHead = String(documentText || '').slice(0, DOC_HEAD_LIMIT);
        const docTail = (documentText && documentText.length > DOC_HEAD_LIMIT)
            ? `\n\n[…документ обрезан до первых ${DOC_HEAD_LIMIT} символов из ${documentText.length}; в reasoning учитывай весь объём через отчёт агентов]`
            : '';
        const originalDocBlock = documentText
            ? `[ОРИГИНАЛЬНЫЙ ТЕКСТ ДОКУМЕНТА (Сплошной — как написал пользователь)]
"""
${docHead}${docTail}
"""

`
            : '';

        const userPrompt = `ПАСПОРТ ДОКУМЕНТА: ${docContextStr || 'Не определен'}

${originalDocBlock}[ОТЧЁТ АГЕНТОВ ПО ФРАГМЕНТАМ (Техническая нарезка — НЕ ССЫЛАТЬСЯ НА НОМЕРА ПУНКТОВ)]
Мы провели проверку документа по пунктам.
Всего пунктов: ${total}. Из них без замечаний: ${ok.length}, с предупреждениями: ${warning.length}, критических: ${critical.length}.
Индекс правовой чистоты документа: ${purityIndex}%.

ПУНКТЫ С РИСКАМИ (только их разбираем — остальные ${ok.length} пунктов в норме):
${riskReports}

[ТВОЯ ЗАДАЧА]
Синтезируй итоговое Executive Summary из отчёта агентов выше. Ты — не аудитор, ты собираешь готовые вердикты в связный текст. НЕ ИЗОБРЕТАЙ новые риски, НЕ ДОБАВЛЯЙ перестраховочные фразы, НЕ КРИТИКУЙ стилистику документа.

Структура ответа — СТРОГО ДВЕ СЕКЦИИ markdown (никаких "Общих рекомендаций"):
1. **Краткий вывод** — 2-3 предложения о документе в целом.
2. **Ключевые риски** — для каждого риска из отчёта агентов: смысловая привязка к оригиналу ("в части про X", "в разделе о Y"), конкретная норма из applicable_articles, краткое описание проблемы. Если рисков нет — ровно одна фраза "Существенных юридических рисков не обнаружено." и больше ничего.`;

        console.log(`[Judge] DCR=${pathLabel} | model=${judgeModel} | reasoning=${judgeReasoning} | ${total} пунктов → ${risks.length} рисков`);

        // 2026-06-02: убрали logJudgeSystemPrompt — он всегда один и тот же
        // (статичный блок "Синтезатор Финальных Заключений" с 6 запретами).
        // Оставлены: logJudgeStart (метаданные маршрутизации) + logJudgeUserPrompt
        // (отчёт агентов — единственный variable input) + logJudgeResponse (выход).
        if (trace && !trace.isNoop) {
            try {
                await trace.logJudgeStart({
                    path: pathLabel, model: judgeModel, reasoning: judgeReasoning,
                    total, critical: critical.length, warning: warning.length, ok: ok.length,
                    purityIndex
                });
                await trace.logJudgeUserPrompt(userPrompt);
            } catch (_) {}
        }

        const judgeStartedAt = performance.now();
        try {
            if (telemetry) telemetry.addTokens(telemetry.estimateTokens(systemPrompt + userPrompt), 0);
            // outputText капчим ВСЕГДА если trace включён — даже если telemetry off.
            const captureForTrace = trace && !trace.isNoop;
            const captureForTele = !!telemetry;
            let outputText = '';
            const originalWrite = res.write;
            if (captureForTrace || captureForTele) {
                res.write = function(chunk, encoding, callback) {
                    // Парсим только SSE-data text-куски: { "text": "..." }
                    try {
                        const str = String(chunk);
                        const m = str.match(/^data: (.+)\n\n$/);
                        if (m) {
                            const obj = JSON.parse(m[1]);
                            if (obj && typeof obj.text === 'string') outputText += obj.text;
                            else outputText += str;
                        } else {
                            outputText += str;
                        }
                    } catch (_) { outputText += String(chunk); }
                    return originalWrite.call(res, chunk, encoding, callback);
                };
            }
            await streamDeepSeekResponse(systemPrompt, userPrompt, res, {
                temperature: 0.2,
                reasoning_effort: judgeReasoning,
                model: judgeModel,
                user_id: judgeUserId,
                label: `judge-${pathLabel}`
            });
            if (captureForTrace || captureForTele) res.write = originalWrite;
            if (captureForTele) {
                telemetry.addTokens(0, telemetry.estimateTokens(outputText));
                telemetry.endTimer('Final_Judge_Time');
            }
            if (captureForTrace) {
                try { await trace.logJudgeResponse(outputText, performance.now() - judgeStartedAt); } catch (_) {}
            }
        } catch (err) {
            console.error('[Final Judge Error] обе модели легли:', err.message);
            res.write(`data: ${JSON.stringify({ text: '\n\n⚠️ Ошибка генерации финального резюме.' })}\n\n`);
            if (trace && !trace.isNoop) {
                try { await trace.logJudgeResponse(`[ERROR] ${err.message}`, performance.now() - judgeStartedAt); } catch (_) {}
            }
        }

        res.write(`data: ${JSON.stringify({
            executive_summary: {
                summary: 'См. стрим выше',
                top_risks: topRisks,
                dcr_path: pathLabel,
                model_used: judgeModel
            }
        })}\n\n`);
    }

    // ════════════════════════════════════════════════════════════════
    //  PREPARE PIPELINE STATE
    //  Готовит {docContext, segments, triage, meta_context} либо из
    //  cached session, либо запуская context+segment+triage с нуля.
    // ════════════════════════════════════════════════════════════════
    async function preparePipelineState(documentText, providedSessionId, res, aborted, telemetry) {
        // ── ⚡ FAST PATH: session hit ──
        if (providedSessionId) {
            const cached = sessionGet(providedSessionId);
            if (cached) {
                const currentHash = sessionHashDoc(documentText);
                if (currentHash === cached.documentTextHash) {
                    // HIT — пропускаем context+segment+triage, отдаём кеш
                    const skipCount = cached.triage.filter(t => t.action === 'skip').length;
                    const auditCount = cached.triage.length - skipCount;
                    sendStep(res, {
                        id: 'context',
                        status: 'success',
                        text: cached.docContext?.document_type || 'Контекст загружен',
                        reason: '⚡ Из теневого кэша'
                    });
                    sendStep(res, {
                        id: 'segment',
                        status: 'success',
                        text: `Документ разбит на пунктов: ${cached.segments.length}`,
                        reason: '⚡ Из теневого кэша'
                    });
                    if (cached.passport) {
                        sendStep(res, {
                            id: 'passport',
                            status: 'success',
                            text: `📋 ${cached.passport.title || 'Паспорт документа'}`,
                            reason: '⚡ Из теневого кэша'
                        });
                    }
                    sendStep(res, {
                        id: 'triage',
                        status: 'success',
                        text: `🚦 Светофор: ${skipCount} типовых · ${auditCount} на проверку`,
                        reason: '⚡ Из теневого кэша · ' + (cached.meta_context || '').slice(0, 120)
                    });
                    console.log(`[Session] ⚡ HIT ${providedSessionId.slice(0, 8)} | skipped context+segment+triage`);
                    return { state: cached, fromCache: true, sessionId: providedSessionId };
                } else {
                    console.warn(`[Session] HIT ${providedSessionId.slice(0, 8)} but text hash mismatch → re-processing`);
                }
            } else {
                console.log(`[Session] MISS ${providedSessionId.slice(0, 8)} (expired or unknown) → full pipeline`);
            }
        }

        // ── SLOW PATH: full pipeline ──
        sendStatus(res, '🧭 Определяю контекст + сегментирую документ параллельно...');
        sendStep(res, { id: 'context', status: 'loading', text: 'Формирую паспорт документа' });
        sendStep(res, { id: 'segment', status: 'loading', text: 'Разбиваю документ на пункты' });

        // ── Этап А (2026-05-27): параллельный Router + Triage ──────────
        // Сегментация синхронная (10мс) → Triage может стартовать сразу после
        // неё, не дожидаясь Router'а. Router (extractDocumentContext) и Triage
        // независимы (Router работает на исходном тексте, Triage на segments).
        // Запускаем оба как Promise и дожидаемся Promise.all внизу.
        // Экономия ~5с на cold-start (Router исторически идёт 5с).

        // Router как Promise — эмитит свой SSE-step внутри .then
        if (telemetry) telemetry.startTimer('Router_Classification_Time');
        const docContextPromise = extractDocumentContext(documentText)
            .catch(() => null)
            .then(r => {
                if (telemetry) telemetry.endTimer('Router_Classification_Time');
                if (r && r.document_type) {
                    sendStep(res, { id: 'context', status: 'success', text: r.document_type, reason: r.subject_area || null });
                } else {
                    sendStep(res, { id: 'context', status: 'warning', text: 'Контекст не определён' });
                }
                return r;
            });

        // ── 2026-05-30: Hybrid Segmenter (Layer A regex + Layer B AI corrector) ─
        // Замена прямого segmentDocumentRegex. Layer A покрывает 14/16 кейсов
        // корпуса за ~200ms; Layer B точечно чинит патологии через
        // lightLLMCascade. Lossless-guard. См. SEGMENTATION_STRATEGY.md.
        if (telemetry) telemetry.startTimer('Segmentation_Time');
        let segments = [];
        // chunkContexts параллельный массив: chunkContexts[i] относится к segments[i].
        // Заполняется hybridSegmenter (sticky section + npa). Используется агентом
        // через injectLocalContext / buildLocalContextBlock для борьбы с Orphan Chunks.
        let chunkContexts = [];
        try {
            const hybridResult = await hybridSegmenter.segment(documentText, {
                stageLabel: 'analyze_doc_segments',
                telemetry
            });
            segments = wrapAsAnalyzeSegments(hybridResult.chunks);
            chunkContexts = Array.isArray(hybridResult.chunkContexts) ? hybridResult.chunkContexts : [];
            // Засекаем какие слои использовались — полезно в telemetry
            if (telemetry?.incrementCounter) {
                telemetry.incrementCounter('hybrid_segments_total', hybridResult.chunks.length);
                if (hybridResult.layers?.includes('B')) {
                    telemetry.incrementCounter('hybrid_layer_b_calls');
                }
                if (hybridResult.layers?.includes('fallback')) {
                    telemetry.incrementCounter('hybrid_fallback_to_a');
                }
                const npaHits = chunkContexts.filter(c => c && c.npa).length;
                if (npaHits > 0) telemetry.incrementCounter('local_ctx_npa_hits', npaHits);
            }
            logger.info?.(`[Hybrid] layers=${(hybridResult.layers || []).join('+')} chunks=${segments.length} npa-hits=${chunkContexts.filter(c => c && c.npa).length} quality=${hybridResult.quality?.action || 'n/a'}`);
        } catch (segErr) {
            // Защитный catch — hybridSegmenter graceful degrade, но если совсем
            // упал — откатываемся на чистый Layer A (regex). Lossless гарантирован.
            logger.warn?.(`[Hybrid] unexpected throw, falling back to Layer A only: ${segErr.message}`);
            const rawChunks = segmentDocumentRegex(documentText, { telemetry });
            segments = wrapAsAnalyzeSegments(rawChunks);
            // На fallback-пути берём sticky-контекст из чистого Layer A.
            try {
                const { buildChunkContexts } = require('../lib/localContext');
                chunkContexts = buildChunkContexts(rawChunks);
            } catch (_) { chunkContexts = []; }
        }
        if (telemetry) telemetry.endTimer('Segmentation_Time');

        // Ранний выход если сегментация пуста — Router тоже отменяем дёшево.
        if (segments.length === 0) {
            sendStep(res, { id: 'segment', status: 'error', text: 'Не удалось разбить документ на пункты' });
            await docContextPromise.catch(() => null); // дожидаемся чтобы Router не висел
            return { state: null, fromCache: false, sessionId: null };
        }
        sendStep(res, { id: 'segment', status: 'success', text: `Документ разбит на пунктов: ${segments.length}` });

        if (aborted.value) {
            await docContextPromise.catch(() => null);
            return { state: null, fromCache: false, sessionId: null };
        }

        // Triage стартует ПАРАЛЛЕЛЬНО с ещё работающим Router'ом.
        sendStep(res, { id: 'triage', status: 'loading', text: '🚦 Светофор: классифицирую пункты' });
        sendStatus(res, '🚦 Светофор: разделяю типовые и требующие проверки...');
        const triagePromise = runTriage(segments, aborted, telemetry);

        // ── 2026-05-30: Hierarchical Contextual RAG — Macro layer ──────
        // AI-паспорт документа (1 LLM-вызов через lightLLMCascade Tier 1 ≈ 1с,
        // ~600/200 токенов, ~$0.0001). Запускается параллельно с Router+Triage —
        // на cold-start добавляет 0 латентности (max-параллельный). На warm-start
        // (Shadow Pipeline) достаётся из session-кэша. Возвращает null на ошибке
        // (graceful degradation: дальше pipeline работает без passport).
        sendStep(res, { id: 'passport', status: 'loading', text: '📋 Формирую паспорт документа' });
        const passportPromise = generateDocumentPassport({
            text: documentText,
            segmentsCount: segments.length,
            cascade: lightLLMCascade,
            telemetry,
            logger
        }).then(p => {
            if (p) {
                sendStep(res, { id: 'passport', status: 'success',
                                text: `📋 ${p.title || 'Паспорт документа готов'}`,
                                reason: p.expectedNpas?.length ? `Ожидаемые НПА: ${p.expectedNpas.slice(0, 3).join(', ')}` : null });
            } else {
                sendStep(res, { id: 'passport', status: 'warning', text: 'Паспорт документа не сформирован' });
            }
            return p;
        }).catch(e => {
            logger.warn?.('[Passport] unexpected throw:', e.message);
            sendStep(res, { id: 'passport', status: 'warning', text: 'Паспорт документа не сформирован' });
            return null;
        });

        // Ждём все три → max(Router, Triage, Passport) ≈ Triage (он обычно самый длинный)
        const [docContext, triageResult, passport] = await Promise.all([docContextPromise, triagePromise, passportPromise]);
        const { triage, meta_context, mode: triageMode } = triageResult;

        const skipCount = triage.filter(t => t.action === 'skip').length;
        const auditCount = triage.length - skipCount;
        sendStep(res, {
            id: 'triage',
            status: 'success',
            text: `🚦 Светофор готов: ${skipCount} типовых · ${auditCount} на глубокую проверку`,
            reason: meta_context || (triageMode === 'fallback' ? 'Триаж недоступен — все пункты идут на проверку' : null)
        });

        const state = {
            docContext,
            segments,
            // chunkContexts параллельно с segments — нужен для topology builder
            // (sticky section). Не используется напрямую в HCR-промптах.
            chunkContexts,
            // 2026-05-30: AI-паспорт документа — Macro-уровень HCR.
            passport,
            triage,
            meta_context,
            documentTextHash: sessionHashDoc(documentText)
        };

        // Сохраняем session — даже если providedSessionId не было.
        // На /analyze без preceding /upload это даст возможность переиспользования
        // (например юрист нажал "Перезапустить" с тем же текстом).
        const newSessionId = providedSessionId || sessionCreate();
        sessionSet(newSessionId, state);

        return { state, fromCache: false, sessionId: newSessionId };
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ROUTE 1: /api/upload-document  —  Shadow Pipeline (фоновый прогрев)
    // ═══════════════════════════════════════════════════════════════════
    // Фронт вызывает этот endpoint СРАЗУ как только юрист загрузил файл
    // (не дожидаясь клика "Проверить"). Бэкенд за фоновое время делает
    // самую медленную часть пайплайна (context + segment + triage) и
    // сохраняет состояние в session-store. Возвращает sessionId.
    //
    // SSE-события:
    //   • { step }, { protocolStatus } — прогресс этапов (для UI-индикатора)
    //   • { shadow_ready: { sessionId, segmentCount, skipCount, auditCount, metaContext } }
    //     — финальный event с готовой sessionId
    //   • [DONE]
    app.post('/api/upload-document', requireClientToken, async (req, res) => {
        return requestTelemetry.run({ res, label: 'upload-document' }, async () => {
            const t0 = Date.now();
            const aborted = { value: false };
            req.on('close', () => {
                if (!res.writableEnded) {
                    aborted.value = true;
                    console.warn('[upload-document] Client closed connection → aborting shadow pipeline');
                }
            });

            try {
                const { documentText: rawDocumentText = '' } = req.body || {};
                // Phase 1: нормализация ДО hash — синхронизация Shadow Pipeline и /analyze
                const documentText = normalizeText(rawDocumentText);
                if (!documentText || documentText.length < 50) {
                    return res.status(400).json({ error: 'Document too short (min 50 chars)' });
                }

                const docHashPrefix = sessionHashDoc(documentText).slice(0, 12);
                logger.info('upload-doc-shadow-start', {
                    rawLen: rawDocumentText.length,
                    normLen: documentText.length,
                    hashPrefix: docHashPrefix
                });

                res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
                res.setHeader('Cache-Control', 'no-cache, no-transform');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                if (typeof res.flushHeaders === 'function') res.flushHeaders();

                const { state, sessionId } = await preparePipelineState(documentText, null, res, aborted);

                if (aborted.value) {
                    if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
                    return;
                }

                if (!state) {
                    // segmentation failed
                    res.write(`data: ${JSON.stringify({
                        shadow_ready: { sessionId: null, error: 'segmentation_failed' }
                    })}\n\n`);
                    res.write('data: [DONE]\n\n');
                    return res.end();
                }

                const skipCount  = state.triage.filter(t => t.action === 'skip').length;
                const auditCount = state.triage.length - skipCount;
                const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

                res.write(`data: ${JSON.stringify({
                    shadow_ready: {
                        sessionId,
                        segmentCount: state.segments.length,
                        skipCount,
                        auditCount,
                        metaContext: state.meta_context,
                        elapsedSec: Number(elapsed)
                    }
                })}\n\n`);

                console.log(`[upload-document] Shadow DONE in ${elapsed}s | session=${sessionId.slice(0, 8)} | segments=${state.segments.length} | skip=${skipCount} | audit=${auditCount}`);

                try { if (typeof telemetry !== 'undefined') console.log(telemetry.generateReport()); } catch(e) {}
                res.write('data: [DONE]\n\n');
                res.end();
            } catch (error) {
                const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
                console.error(`[/api/upload-document] error after ${elapsed}s:`, error.message);
                if (!res.writableEnded) {
                    try {
                        res.write(`data: ${JSON.stringify({ shadow_ready: { sessionId: null, error: error.message } })}\n\n`);
                        res.write('data: [DONE]\n\n');
                        res.end();
                    } catch {}
                }
            }
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    //  ROUTE 2: /api/analyze-document  —  Полный анализ (с использованием session)
    // ═══════════════════════════════════════════════════════════════════
    app.post('/api/analyze-document', requireClientToken, async (req, res) => {
        return requestTelemetry.run({ res, label: 'analyze-document' }, async () => {
            const t0 = Date.now();
            const telemetry = new TelemetryCollector();

            const aborted = { value: false };
            req.on('close', () => {
                if (!res.writableEnded) {
                    aborted.value = true;
                    console.warn('[analyze-document] Client closed connection → aborting in-flight agents');
                }
            });

            try {
                const { documentText: rawDocumentText = '', sessionId = null } = req.body || {};
                // Phase 1: нормализация ДО hash — теперь /analyze и /upload видят
                // одинаковый текст и считают одинаковый MD5 → корректный session hit.
                const documentText = normalizeText(rawDocumentText);
                const docHashPrefix = sessionHashDoc(documentText).slice(0, 12);
                logger.info('analyze-doc-pipeline', {
                    rawLen: rawDocumentText.length,
                    normLen: documentText.length,
                    hashPrefix: docHashPrefix,
                    hasSession: !!sessionId
                });

                res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
                res.setHeader('Cache-Control', 'no-cache, no-transform');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                if (typeof res.flushHeaders === 'function') res.flushHeaders();

                // ── 2026-06-01: Full Debug Trace ──
                // Один файл на сеанс анализа. Включён по умолчанию (TRACE_ENABLED).
                // Содержит: input → passport → triage → каждый сегмент (system/
                // user prompt, tool_calls, Pinecone-выдачи, вердикт) → Final Judge.
                // Фронт получает SSE { trace_ready } и рендерит кнопку скачивания.
                const trace = createTraceLogger({
                    docHashPrefix,
                    requestId: `trace_${new Date().toISOString().replace(/[:.]/g, '-')}_${docHashPrefix}`,
                    logger
                });
                if (!trace.isNoop) {
                    trace.logHeader({
                        pipeline: '/api/analyze-document',
                        docLength: documentText.length,
                        docHashPrefix,
                        sessionId: sessionId || null,
                        docHead: documentText
                    }).catch(() => {});
                }

                // PR3: пытаемся взять состояние из теневого кэша
                const { state, fromCache } = await preparePipelineState(documentText, sessionId, res, aborted, telemetry);

                if (aborted.value) {
                    try { console.log('\n\n' + telemetry.generateReport() + '\n\n'); } catch (telemetryErr) { console.error('[Telemetry] Failed to print report:', telemetryErr); }
                    if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
                    return;
                }

                if (!state) {
                    try { console.log('\n\n' + telemetry.generateReport() + '\n\n'); } catch (telemetryErr) { console.error('[Telemetry] Failed to print report:', telemetryErr); }
                    res.write('data: [DONE]\n\n');
                    return res.end();
                }

                const { docContext, segments, triage, meta_context, chunkContexts: stateChunkContexts, passport: statePassport } = state;
                const docContextStr = formatDocContext(docContext);

                // ── 2026-05-30: HCR-passport. Если генератор вернул null (cascade
                // failed) — пробрасываем null, агенты работают без macro-блока
                // (graceful degradation). Если есть — он будет в task.passport.
                const passport = statePassport || null;

                // 2026-06-01: trace — паспорт + triage + список сегментов.
                if (!trace.isNoop) {
                    trace.logPassport(passport).catch(() => {});
                    trace.logTriage(triage).catch(() => {});
                    trace.logSegments(segments).catch(() => {});
                }

                // Разводим пункты по двум корзинам по triage
                const skipSegmentsWithIdx = [];
                const auditSegmentsWithIdx = [];
                for (let i = 0; i < segments.length; i++) {
                    const action = triage[i] ? triage[i].action : 'rag_audit';
                    if (action === 'skip') {
                        skipSegmentsWithIdx.push({ seg: segments[i], idx: i });
                    } else {
                        auditSegmentsWithIdx.push({ seg: segments[i], originalIdx: i });
                    }
                }

                // ⚡ Моментально стримим safe_triage для skip-пунктов
                if (skipSegmentsWithIdx.length > 0) {
                    emitSafeTriageRows(skipSegmentsWithIdx, res);
                }

                let finalResults = [];
                if (auditSegmentsWithIdx.length > 0) {
                    // ── Phase 3 Smart-Skip (тюнинг от 2026-05-27 по test_corpus/) ─
                    // Эвристика: если документ не содержит явных ссылок на статьи
                    // (например типовой договор / расписка / соглашение), Phase 3
                    // Splitter извлечёт 0 citations и потратит ~24с впустую.
                    // Решаем по regex-эвристике на ЦЕЛОМ тексте audit-пунктов.
                    const auditCombinedText = auditSegmentsWithIdx.map(s => s.seg.text).join('\n\n');
                    const phase3Decision = shouldRunPhase3(auditCombinedText);
                    let phase3ChunkAnalyses = null;

                    if (!phase3Decision.run) {
                        // ✗ Skip Phase 3 → Ищейки уйдут в legacy adaptive Pinecone-путь
                        if (telemetry?.incrementCounter) telemetry.incrementCounter('phase3_smart_skipped');
                        logger.info?.(`[Phase3 smart-skip] ${phase3Decision.reason}`);
                        sendStep(res, {
                            id: 'phase3',
                            status: 'success',
                            text: '🚦 Базовый RAG-режим',
                            reason: phase3Decision.reason
                        });
                    } else {
                        // ── Phase 3: Batched Issue Splitter + Adaptive RAG ─────
                        sendStep(res, {
                            id: 'phase3',
                            status: 'loading',
                            text: `🎯 Извлекаю точные ссылки на НПА из ${auditSegmentsWithIdx.length} пунктов`,
                            reason: phase3Decision.reason
                        });
                        try {
                            const phase3Result = await phase3Pipeline.run({
                                chunks: auditSegmentsWithIdx.map(s => s.seg.text),
                                telemetry,
                                res,
                                aborted
                            });
                            phase3ChunkAnalyses = phase3Result.chunkAnalyses;
                            const totalArticles = phase3ChunkAnalyses.reduce(
                                (s, ca) => s + (ca.relevant_articles?.length || 0), 0
                            );
                            const phase3Status = phase3Result.degraded ? 'warning' : 'success';
                            const phase3Reason = phase3Result.degraded
                                ? 'часть пунктов будет проанализирована в режиме базового RAG'
                                : `${totalArticles} статей привязано к пунктам`;
                            sendStep(res, {
                                id: 'phase3',
                                status: phase3Status,
                                text: `🎯 Карта НПА готова`,
                                reason: phase3Reason
                            });
                        } catch (phase3Err) {
                            // Защитный catch: phase3.run сам не должен throw'ить
                            // (graceful degradation внутри), но если случилось —
                            // Ищейки уходят в legacy путь без потери ответа.
                            logger.error?.('[Phase3] unexpected throw', phase3Err);
                            sendStep(res, {
                                id: 'phase3',
                                status: 'warning',
                                text: '🎯 Карта НПА недоступна',
                                reason: 'Пункты будут проанализированы в режиме базового RAG'
                            });
                        }
                    }

                    if (aborted.value) {
                        try { console.log('\n\n' + telemetry.generateReport() + '\n\n'); } catch (telemetryErr) { console.error('[Telemetry] Failed to print report:', telemetryErr); }
                        if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
                        return;
                    }

                    if (!trace.isNoop) {
                        trace.logPipelineState({
                            auditCount: auditSegmentsWithIdx.length,
                            skipCount: skipSegmentsWithIdx.length,
                            metaContext: meta_context,
                            fromCache
                        }).catch(() => {});
                    }

                    sendStatus(res, `🔬 Глубокий аудит ${auditSegmentsWithIdx.length} пунктов...`);
                    finalResults = await verifySegmentsSmart(
                        auditSegmentsWithIdx, res, passport, meta_context, aborted, telemetry,
                        phase3ChunkAnalyses, stateChunkContexts, segments, trace
                    );
                } else {
                    console.log('[analyze-document] All segments triaged as skip — no deep audit needed');
                }

                if (aborted.value) {
                    try { console.log('\n\n' + telemetry.generateReport() + '\n\n'); } catch (telemetryErr) { console.error('[Telemetry] Failed to print report:', telemetryErr); }
                    if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
                    return;
                }

                // Виртуальные skip-результаты для подсчёта purityIndex (юрист должен
                // видеть честный процент чистоты с учётом ВСЕХ пунктов)
                const virtualSkipResults = skipSegmentsWithIdx.map(({ seg }) => ({
                    item_number: `п.${seg.number} ${seg.heading}`.trim(),
                    short_verdict: SAFE_TRIAGE_VERDICT,
                    status: 'ok',
                    confidence: null,
                    legal_rationale: SAFE_TRIAGE_RATIONALE,
                    applicable_articles: [],
                    law_refs: []
                }));
                const allResultsForJudge = [...virtualSkipResults, ...finalResults];

                const seenSources = new Set();
                const sources = [], metadata = [];
                for (const r of finalResults) {
                    for (const a of (r.applicable_articles || [])) {
                        const key = `${a.npa_title}|${a.article_title}`;
                        if (!seenSources.has(key)) {
                            seenSources.add(key);
                            sources.push(`${a.npa_title} — ${a.article_title}`);
                            metadata.push(a);
                        }
                    }
                }
                if (sources.length > 0) {
                    res.write(`data: ${JSON.stringify({ sources: sources.slice(0, 10), metadata: metadata.slice(0, 10) })}\n\n`);
                }

                if (aborted.value) {
                    try { console.log('\n\n' + telemetry.generateReport() + '\n\n'); } catch (telemetryErr) { console.error('[Telemetry] Failed to print report:', telemetryErr); }
                    if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
                    return;
                }

                sendStep(res, { id: 'judge', status: 'loading', text: 'Финальный Судья формирует заключение' });
                sendStatus(res, '⚖️ Финальный Судья формирует заключение...');
                await runFinalJudge(allResultsForJudge, res, docContextStr, aborted, telemetry, documentText, trace);
                sendStep(res, { id: 'judge', status: 'success', text: 'Заключение готово' });

                const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
                const realRisks = finalResults.filter(r => r.status !== 'ok').length;
                console.log(`[analyze-document] DONE in ${elapsed}s | shadow=${fromCache ? 'HIT' : 'MISS'} | total=${segments.length} | skip=${skipSegmentsWithIdx.length} | audit=${auditSegmentsWithIdx.length} | risks=${realRisks} | aborted=${aborted.value}`);

                try { console.log('\n\n' + telemetry.generateReport() + '\n\n'); } catch (telemetryErr) { console.error('[Telemetry] Failed to print report:', telemetryErr); }

                // 2026-06-01: закрываем trace + шлём фронту ссылку на скачивание
                if (!trace.isNoop) {
                    try {
                        await trace.logFooter({});
                        await trace.flush();
                        res.write(`data: ${JSON.stringify({
                            trace_ready: {
                                id: trace.id,
                                fileName: trace.fileName,
                                url: trace.downloadUrl
                            }
                        })}\n\n`);
                    } catch (traceErr) {
                        console.warn('[trace] flush/emit failed:', traceErr.message);
                    }
                }

                res.write('data: [DONE]\n\n');
                res.end();
            } catch (error) {
                const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
                console.error(`[/api/analyze-document] pipeline error after ${elapsed}s:`, error);
                try { console.log('\n\n' + telemetry.generateReport() + '\n\n'); } catch (telemetryErr) { console.error('[Telemetry] Failed to print report:', telemetryErr); }
                if (!res.writableEnded) {
                    res.write(`data: ${JSON.stringify({ text: '\n\n⚠️ Системная ошибка. Повторите запрос.' })}\n\n`);
                    res.write('data: [DONE]\n\n');
                    res.end();
                }
            }
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    //  ROUTE 3: /api/traces — листинг всех debug-trace .md файлов
    // ═══════════════════════════════════════════════════════════════════
    // Возвращает JSON-массив { fileName, modifiedAt, modifiedAtIso, sizeKB,
    // sizeBytes, url }, отсортированный по mtime DESC (новые сверху).
    // Используется модалкой "🗃️ Debug-архив" во фронте.
    app.get('/api/traces', async (_req, res) => {
        try {
            const items = await listTraces();
            res.setHeader('Cache-Control', 'no-store');
            res.json({ count: items.length, items });
        } catch (err) {
            console.error('[/api/traces]', err);
            res.status(500).json({ error: 'list failed', message: err.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════════
    //  ROUTE 4: /api/trace/:filename — скачивание debug-trace .md файла
    // ═══════════════════════════════════════════════════════════════════
    // Файл создаётся в /api/analyze-document; имя пробрасывается фронту
    // через SSE { trace_ready: { fileName, url } }. Юрист жмёт кнопку
    // "📥 Скачать debug-отчёт" в IDE — браузер уходит на этот URL.
    //
    // Безопасность: filename строго валидируется regex'ом /^trace_[A-Za-z0-9_-]+\.md$/.
    // Path traversal заблокирован проверкой resolved-пути в lib/traceLogger.js.
    //
    // ВНИМАНИЕ: trace содержит полный текст документа пользователя. В
    // продакшене (если будет публичный URL) — закрыть basic-auth токеном
    // или отключить через env TRACE_ENABLED=false.
    app.get('/api/trace/:filename', async (req, res) => {
        const { filename } = req.params || {};
        if (!filename || !TRACE_FILENAME_RE.test(filename)) {
            res.status(400).type('text/plain').send('Invalid trace filename');
            return;
        }
        try {
            const content = await readTraceFile(filename);
            res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.setHeader('Cache-Control', 'no-store');
            res.send(content);
        } catch (err) {
            if (err.code === 'ENOENT') {
                res.status(404).type('text/plain').send('Trace not found (may have expired — TTL 7 days)');
            } else if (err.code === 'INVALID_FILENAME' || err.code === 'PATH_TRAVERSAL') {
                res.status(400).type('text/plain').send('Invalid filename');
            } else {
                console.error('[/api/trace]', err);
                res.status(500).type('text/plain').send('Trace read error');
            }
        }
    });
};
