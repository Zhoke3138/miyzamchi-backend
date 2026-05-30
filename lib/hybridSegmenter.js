// ═══════════════════════════════════════════════════════════════════════
//  lib/hybridSegmenter.js
//  Hybrid Document Segmentation — Layer A (regex) + Layer B (AI corrector)
//  Selective Reasoning v2.0  ·  2026-05-29
// ═══════════════════════════════════════════════════════════════════════
//
//  Архитектура (см. SEGMENTATION_STRATEGY.md):
//
//   Input text
//      │
//      ▼
//   ┌──────────────┐
//   │ Layer A      │  segmentDocumentRegex (sync, 200ms, lossless)
//   └──────┬───────┘
//          ▼
//   ┌──────────────┐
//   │ assessQuality│  детерминированные триггеры:
//   │              │   LOSSY / GIANT_CHUNK / TOO_MANY_SMALL /
//   │              │   DOMINANT_CHUNK / TOO_FEW
//   └──────┬───────┘
//          │
//     ┌────┴────┐
//   pass    escalate
//     │         │
//     │         ▼
//     │  ┌──────────────┐
//     │  │ Layer B (AI) │  lightLLMCascade, точечный rebuild
//     │  │              │  problem zones. Lossless-guard 5%.
//     │  └──────┬───────┘
//     │     ┌───┴───┐
//     │   success  fail
//     │     │       └→ fallback Layer A
//     └─────┴────────→ merged chunks
//
//  Контракт DI:
//   createHybridSegmenter({ cascade, logger?, layerBEnabled?,
//                            qualityThresholds?, layerBTimeouts? })
//   → { segment, assessQuality, _internal }
//
//  Layer C — extension point (см. README раздел 2.4).
// ═══════════════════════════════════════════════════════════════════════

const { performance } = require('perf_hooks');
const { segmentDocumentRegex } = require('./segmentRegex');
const { buildChunkContexts } = require('./localContext');

// ── Дефолтные пороги (можно override через qualityThresholds) ───────────
const DEFAULT_THRESHOLDS = {
    giantChunkChars:   2500,   // chunk > этого → GIANT_CHUNK
    tooManySmallCount: 50,     // > 50 чанков
    tooManySmallAvg:   200,    // И средний размер < 200 → TOO_MANY_SMALL
    dominantRatio:     0.5,    // chunk занимает > 50% контента → DOMINANT
    tooFewCount:       5,      // < 5 чанков
    tooFewMinBytes:    2000,   // и документ > 2kB → TOO_FEW (есть что чанковать)
    lossyTolerance:    0       // Layer A должен быть lossless строго
};

// ── Layer B size constraints (для batched rebuild) ──────────────────────
const LAYER_B_MAX_FRAGMENT_CHARS = 6000;  // не отправляем больше за раз
const LAYER_B_MIN_FRAGMENT_CHARS = 100;   // не отправляем меньше (бесполезно)
const LAYER_B_LOSSLESS_TOLERANCE = 0.05;  // > 5% diff → reject

// ═══════════════════════════════════════════════════════════════════════
//  Quality Assessor
// ═══════════════════════════════════════════════════════════════════════

function nonWsLength(s) {
    return String(s || '').replace(/\s/g, '').length;
}

function computeMetrics(chunks, text) {
    if (!Array.isArray(chunks) || chunks.length === 0) {
        return {
            totalChunks: 0, totalBytes: text?.length || 0,
            avgChunkLen: 0, maxChunkLen: 0, minChunkLen: 0,
            top3Ratio: 0, lossNonWs: nonWsLength(text), density: 0
        };
    }
    const lens = chunks.map(c => c.length);
    const total = lens.reduce((a, b) => a + b, 0);
    const sorted = [...lens].sort((a, b) => b - a);
    const top3 = sorted.slice(0, 3).reduce((a, b) => a + b, 0);
    const rawNW = nonWsLength(text);
    const chunksNW = chunks.reduce((acc, c) => acc + nonWsLength(c), 0);
    return {
        totalChunks: chunks.length,
        totalBytes:  text?.length || 0,
        avgChunkLen: Math.round(total / chunks.length),
        maxChunkLen: sorted[0] || 0,
        minChunkLen: sorted[sorted.length - 1] || 0,
        top3Ratio:   total > 0 ? Number((top3 / total).toFixed(3)) : 0,
        lossNonWs:   rawNW - chunksNW,
        density:     text?.length ? Number((chunks.length / text.length * 1000).toFixed(2)) : 0
    };
}

/**
 * assessQuality — детерминированный gatekeeper.
 * Возвращает action='pass' (хорошо) или 'escalate' (зовём Layer B)
 * с массивом problemZones для точечного восстановления.
 */
function assessQuality(chunks, text, thresholds = DEFAULT_THRESHOLDS) {
    const metrics = computeMetrics(chunks, text);
    const issues = [];
    const problemZones = [];   // { kind, indices: [i], text? }

    // ── 🔴 LOSSY — критично, Layer A не сохранил весь текст ────────────
    if (metrics.lossNonWs > thresholds.lossyTolerance) {
        issues.push({ kind: 'LOSSY', severity: 'critical', loss: metrics.lossNonWs });
        // Восстановить точно нельзя — Layer B пересоберёт весь документ
        problemZones.push({ kind: 'LOSSY', scope: 'full', text });
    }

    // ── 🟠 GIANT_CHUNK — отдельный чанк превысил лимит ─────────────────
    for (let i = 0; i < chunks.length; i++) {
        if (chunks[i].length > thresholds.giantChunkChars) {
            issues.push({ kind: 'GIANT_CHUNK', severity: 'high', index: i, len: chunks[i].length });
            problemZones.push({ kind: 'GIANT_CHUNK', scope: 'chunk', indices: [i], text: chunks[i] });
        }
    }

    // ── 🟡 DOMINANT_CHUNK — один chunk съел > 50% контента ─────────────
    const totalChunkLen = chunks.reduce((acc, c) => acc + c.length, 0);
    if (totalChunkLen > 0) {
        for (let i = 0; i < chunks.length; i++) {
            if (chunks[i].length / totalChunkLen > thresholds.dominantRatio) {
                issues.push({ kind: 'DOMINANT_CHUNK', severity: 'medium', index: i });
                // Не дублируем zone если уже добавили как GIANT
                if (!problemZones.some(z => z.kind === 'GIANT_CHUNK' && z.indices?.[0] === i)) {
                    problemZones.push({ kind: 'DOMINANT_CHUNK', scope: 'chunk', indices: [i], text: chunks[i] });
                }
                break; // достаточно одного
            }
        }
    }

    // ── 🟡 TOO_MANY_SMALL — overshoot, нужно склеить мелкие соседи ─────
    // Стратегия: разбиваем массив на батчи BATCH_SIZE=15 подряд идущих
    // чанков и отдаём каждый батч в Layer B на rebuild. LLM сам решит
    // как групировать (например, 4.2.1 / 4.2.2 / 4.2.3 → раздел 4.2).
    if (metrics.totalChunks > thresholds.tooManySmallCount
        && metrics.avgChunkLen < thresholds.tooManySmallAvg) {
        issues.push({ kind: 'TOO_MANY_SMALL', severity: 'medium',
                      count: metrics.totalChunks, avg: metrics.avgChunkLen });

        const BATCH_SIZE = 15;
        const skipGiantIndices = new Set(
            problemZones.filter(z => z.kind === 'GIANT_CHUNK').flatMap(z => z.indices || [])
        );
        for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
            const batchIndices = [];
            const batchTexts = [];
            for (let j = i; j < Math.min(i + BATCH_SIZE, chunks.length); j++) {
                if (skipGiantIndices.has(j)) continue;
                batchIndices.push(j);
                batchTexts.push(chunks[j]);
            }
            if (batchIndices.length < 5) continue;  // батч слишком маленький — не стоит звать LLM
            problemZones.push({
                kind: 'TOO_MANY_SMALL',
                scope: 'cluster',
                indices: batchIndices,
                text: batchTexts.join('\n\n')
            });
        }
    }

    // ── 🟡 TOO_FEW — Layer A не нашёл структуру, документ выглядит "сырым"
    if (metrics.totalChunks < thresholds.tooFewCount
        && metrics.totalBytes > thresholds.tooFewMinBytes) {
        issues.push({ kind: 'TOO_FEW', severity: 'medium',
                      count: metrics.totalChunks, bytes: metrics.totalBytes });
        // Пересобираем весь документ — Layer A явно не разобрался
        if (!problemZones.some(z => z.scope === 'full')) {
            problemZones.push({ kind: 'TOO_FEW', scope: 'full', text });
        }
    }

    const action = issues.length > 0 ? 'escalate' : 'pass';
    return { metrics, issues, action, problemZones };
}

// ═══════════════════════════════════════════════════════════════════════
//  Layer B — AI Corrector
// ═══════════════════════════════════════════════════════════════════════

const LAYER_B_SYSTEM_PROMPT = `Ты — Senior юрист Кыргызской Республики.
Тебе дан фрагмент документа. Разбей его на смысловые блоки по правилам юридической структуры:

1. ОДНА смысловая единица = ОДИН блок (норма НПА, пункт договора, тезис требования).
2. Если параграф заканчивается двоеточием и за ним идёт список (буллиты, "статья N —", "- ..."),
   intro И весь список — В ОДНОМ блоке.
3. Разные статьи разных НПА — В РАЗНЫХ блоках.
4. Реквизиты ОДНОЙ стороны договора (ЗАКАЗЧИК + ОсОО + ИНН + р/с + БИК + Адрес) — В ОДНОМ блоке.
5. Подписи / даты / печати / приложения — каждое отдельно.
6. Целевой размер каждого блока — 200-800 символов.

🔴 КРИТИЧЕСКОЕ ПРАВИЛО: НИ ОДНОГО символа из входа не теряй и не выдумывай.
Когда копируешь текст блока — копируй ДОСЛОВНО как во входе. Никаких суммаризаций, перефраз,
комментариев, исправлений опечаток.

Верни СТРОГО JSON без обёрток:
{"chunks": ["текст блока 1", "текст блока 2", ...]}

Без \`\`\`json и без пояснений.`;

function buildLayerBUserPrompt(fragment, hint) {
    const meta = hint ? `\nКонтекст: ${hint}\n` : '';
    return `Фрагмент документа:${meta}
---
${fragment}
---

Верни JSON: {"chunks": [...]}`;
}

/**
 * runLayerBOnFragment — один LLM-вызов на один фрагмент.
 * Возвращает { chunks, durationMs, model, tier, attempts } или throw.
 *
 * Lossless-guard: если LLM удалил/добавил > LAYER_B_LOSSLESS_TOLERANCE — throw LayerBLossyError.
 */
async function runLayerBOnFragment(fragment, deps) {
    const { cascade, telemetry, logger, stageLabel, hint } = deps;
    const tStart = performance.now();

    const { text: rawText, model, tier } = await cascade.call({
        systemPrompt: LAYER_B_SYSTEM_PROMPT,
        userPrompt:   buildLayerBUserPrompt(fragment, hint),
        jsonMode:     true,
        telemetry,
        stageLabel:   `${stageLabel}:layerB`,
        temperature:  0.0,
        maxOutputTokens: 8000
    });

    let parsed;
    try {
        parsed = JSON.parse(rawText);
    } catch (e) {
        const err = new Error('[LayerB] JSON parse failed: ' + e.message);
        err.kind = 'parse_error';
        err.raw = rawText?.slice(0, 200);
        throw err;
    }
    if (!parsed || !Array.isArray(parsed.chunks)) {
        const err = new Error('[LayerB] response.chunks is not an array');
        err.kind = 'schema_error';
        err.raw = rawText?.slice(0, 200);
        throw err;
    }
    const outputChunks = parsed.chunks
        .filter(c => c != null)
        .map(c => String(c).trim())
        .filter(c => c.length > 0);

    if (outputChunks.length === 0) {
        const err = new Error('[LayerB] empty chunks array');
        err.kind = 'empty_response';
        throw err;
    }

    // Lossless-guard
    const inputNW = nonWsLength(fragment);
    const outputNW = outputChunks.reduce((a, c) => a + nonWsLength(c), 0);
    const lossRatio = inputNW > 0 ? Math.abs(inputNW - outputNW) / inputNW : 0;
    if (lossRatio > LAYER_B_LOSSLESS_TOLERANCE) {
        const err = new Error(`[LayerB] lossy response: ${(lossRatio * 100).toFixed(1)}% diff (input ${inputNW}nw, output ${outputNW}nw)`);
        err.kind = 'lossy_response';
        err.lossRatio = lossRatio;
        throw err;
    }

    const durationMs = performance.now() - tStart;
    logger?.info?.(`[LayerB] ok ${stageLabel} tier${tier} ${model} ${(durationMs/1000).toFixed(2)}s → ${outputChunks.length} chunks (loss ${(lossRatio*100).toFixed(2)}%)`);

    return { chunks: outputChunks, durationMs, model, tier, lossRatio };
}

/**
 * applyLayerB — взять problemZones и пересобрать соответствующие участки.
 * Если zone.scope === 'full' — переписываем весь массив.
 * Если zone.scope === 'chunk' — заменяем chunks[i] на LayerB-результат.
 * Если zone.scope === 'cluster' — заменяем chunks[i..j] на LayerB-результат.
 *
 * Каждая зона обрабатывается независимо. Если одна упала, остальные продолжаем.
 */
async function applyLayerB(layerAChunks, problemZones, deps) {
    const { logger, stageLabel } = deps;
    const layerBReport = {
        called: true,
        zones: [],
        totalDurationMs: 0,
        success: 0,
        fallback: 0,
        skipped: 0
    };

    // ── Full-doc rebuild (LOSSY / TOO_FEW) ─────────────────────────────
    const fullZone = problemZones.find(z => z.scope === 'full');
    if (fullZone) {
        if (fullZone.text.length > LAYER_B_MAX_FRAGMENT_CHARS) {
            // слишком большой — не отправляем (Layer B ему не поможет точно)
            logger?.warn?.(`[LayerB] full-doc zone too large (${fullZone.text.length}ch > ${LAYER_B_MAX_FRAGMENT_CHARS}), skip`);
            layerBReport.skipped++;
            layerBReport.zones.push({ kind: fullZone.kind, scope: 'full', status: 'skipped', reason: 'too_large' });
            return { chunks: layerAChunks, report: layerBReport };
        }
        try {
            const t0 = performance.now();
            const result = await runLayerBOnFragment(fullZone.text, {
                ...deps,
                hint: `Полный документ. Issue: ${fullZone.kind}.`
            });
            layerBReport.totalDurationMs += result.durationMs;
            layerBReport.success++;
            layerBReport.zones.push({ kind: fullZone.kind, scope: 'full', status: 'ok',
                                       durationMs: result.durationMs, model: result.model,
                                       tier: result.tier, lossRatio: result.lossRatio,
                                       output: result.chunks.length });
            return { chunks: result.chunks, report: layerBReport };
        } catch (e) {
            const dur = performance.now() - 0;
            logger?.warn?.(`[LayerB] full-doc rebuild failed: ${e.message}`);
            layerBReport.fallback++;
            layerBReport.zones.push({ kind: fullZone.kind, scope: 'full', status: 'failed',
                                       reason: e.kind || 'cascade_failed', message: e.message });
            return { chunks: layerAChunks, report: layerBReport };
        }
    }

    // ── Partial rebuild (GIANT / DOMINANT / TOO_MANY_SMALL) ────────────
    // Сортируем зоны по первому индексу (по убыванию), чтобы заменять
    // справа налево — позиции не сдвигаются.
    const sortedZones = [...problemZones]
        .filter(z => z.scope !== 'full' && Array.isArray(z.indices))
        .sort((a, b) => b.indices[0] - a.indices[0]);

    let workingChunks = [...layerAChunks];

    for (const zone of sortedZones) {
        if (!zone.text || zone.text.length < LAYER_B_MIN_FRAGMENT_CHARS) {
            layerBReport.skipped++;
            layerBReport.zones.push({ kind: zone.kind, scope: zone.scope,
                                       indices: zone.indices, status: 'skipped',
                                       reason: 'too_small' });
            continue;
        }
        if (zone.text.length > LAYER_B_MAX_FRAGMENT_CHARS) {
            layerBReport.skipped++;
            layerBReport.zones.push({ kind: zone.kind, scope: zone.scope,
                                       indices: zone.indices, status: 'skipped',
                                       reason: 'too_large' });
            continue;
        }
        try {
            const result = await runLayerBOnFragment(zone.text, {
                ...deps,
                hint: `Issue: ${zone.kind}. Этот фрагмент Layer A не разобрал хорошо.`
            });
            layerBReport.totalDurationMs += result.durationMs;
            layerBReport.success++;
            layerBReport.zones.push({ kind: zone.kind, scope: zone.scope,
                                       indices: zone.indices, status: 'ok',
                                       durationMs: result.durationMs, model: result.model,
                                       tier: result.tier, lossRatio: result.lossRatio,
                                       output: result.chunks.length });
            // Заменяем chunks[firstIdx..lastIdx] на result.chunks
            const firstIdx = zone.indices[0];
            const lastIdx  = zone.indices[zone.indices.length - 1];
            workingChunks.splice(firstIdx, lastIdx - firstIdx + 1, ...result.chunks);
        } catch (e) {
            logger?.warn?.(`[LayerB] zone ${zone.kind}@${zone.indices?.[0]} failed: ${e.message}`);
            layerBReport.fallback++;
            layerBReport.zones.push({ kind: zone.kind, scope: zone.scope,
                                       indices: zone.indices, status: 'failed',
                                       reason: e.kind || 'cascade_failed', message: e.message });
            // Не заменяем — Layer A chunks остаются на месте
        }
    }

    return { chunks: workingChunks, report: layerBReport };
}

// ═══════════════════════════════════════════════════════════════════════
//  Main API — createHybridSegmenter
// ═══════════════════════════════════════════════════════════════════════

function createHybridSegmenter(deps = {}) {
    const {
        cascade,
        logger             = console,
        layerBEnabled      = true,
        qualityThresholds  = DEFAULT_THRESHOLDS,
        layerBTimeouts     = null   // override [t1, t2, t3] для cascade.call
    } = deps;

    const thresholds = { ...DEFAULT_THRESHOLDS, ...qualityThresholds };

    async function segment(text, opts = {}) {
        const {
            stageLabel = 'hybrid_segment',
            telemetry  = null,
            docType    = null,        // hint для Layer B
            forceLayerB = false       // отладочный режим
        } = opts;

        const tStart = performance.now();

        // ── Layer A (всегда) ────────────────────────────────────────
        const tA = performance.now();
        const layerAChunks = segmentDocumentRegex(text);
        const layerAMs = performance.now() - tA;

        // ── Quality Assessment ──────────────────────────────────────
        const quality = assessQuality(layerAChunks, text, thresholds);

        if (telemetry?.recordHybrid) {
            telemetry.recordHybrid({
                stage: 'layerA', durationMs: layerAMs,
                chunksOut: layerAChunks.length, metrics: quality.metrics
            });
        }

        // ── Decide: escalate to Layer B? ────────────────────────────
        const shouldEscalate = forceLayerB || quality.action === 'escalate';
        if (!shouldEscalate) {
            return {
                chunks: layerAChunks,
                // 2026-05-30: sticky local context (section + npa) для каждого
                // чанка — fix Orphan Chunks RAG-галлюцинаций. Параллельно
                // с chunks[]: chunkContexts[i] относится к chunks[i].
                chunkContexts: buildChunkContexts(layerAChunks),
                layers: ['A'],
                quality,
                durations: { layerAMs, layerBMs: 0, totalMs: performance.now() - tStart },
                layerB: { called: false, reason: 'quality_pass' }
            };
        }

        if (!layerBEnabled) {
            logger.warn?.('[Hybrid] Layer B disabled, returning Layer A despite issues');
            return {
                chunks: layerAChunks,
                chunkContexts: buildChunkContexts(layerAChunks),
                layers: ['A'],
                quality,
                durations: { layerAMs, layerBMs: 0, totalMs: performance.now() - tStart },
                layerB: { called: false, reason: 'layer_b_disabled' }
            };
        }
        if (!cascade || typeof cascade.call !== 'function') {
            logger.warn?.('[Hybrid] AI cascade not configured, returning Layer A');
            return {
                chunks: layerAChunks,
                chunkContexts: buildChunkContexts(layerAChunks),
                layers: ['A'],
                quality,
                durations: { layerAMs, layerBMs: 0, totalMs: performance.now() - tStart },
                layerB: { called: false, reason: 'no_cascade' }
            };
        }

        // ── Layer B (AI corrector) ──────────────────────────────────
        const tB = performance.now();
        const cascadeWithTimeouts = layerBTimeouts
            ? { call: (callOpts) => cascade.call({ ...callOpts, timeouts: layerBTimeouts }) }
            : cascade;

        const { chunks: layerBChunks, report } = await applyLayerB(
            layerAChunks,
            quality.problemZones,
            { cascade: cascadeWithTimeouts, telemetry, logger,
              stageLabel: docType ? `${stageLabel}_${docType}` : stageLabel }
        );
        const layerBMs = performance.now() - tB;

        // ── Final lossless check (defense in depth) ─────────────────
        const finalLoss = nonWsLength(text) - layerBChunks.reduce((a, c) => a + nonWsLength(c), 0);
        if (finalLoss > 5) {
            // Что-то пошло не так — Layer B потерял символы несмотря на guard.
            // Возвращаем Layer A, помечаем как fallback.
            logger.warn?.(`[Hybrid] post-LayerB lossless check failed (${finalLoss} chars lost), fallback to Layer A`);
            return {
                chunks: layerAChunks,
                chunkContexts: buildChunkContexts(layerAChunks),
                layers: ['A', 'B', 'fallback'],
                quality,
                durations: { layerAMs, layerBMs, totalMs: performance.now() - tStart },
                layerB: { ...report, finalLoss, fallbackReason: 'post_check_lossy' }
            };
        }

        return {
            chunks: layerBChunks,
            chunkContexts: buildChunkContexts(layerBChunks),
            layers: ['A', 'B'],
            quality,
            durations: { layerAMs, layerBMs, totalMs: performance.now() - tStart },
            layerB: { ...report, finalLoss }
        };
    }

    return {
        segment,
        assessQuality: (chunks, text) => assessQuality(chunks, text, thresholds),
        _internal: {
            computeMetrics, runLayerBOnFragment, applyLayerB,
            LAYER_B_SYSTEM_PROMPT, DEFAULT_THRESHOLDS,
            LAYER_B_MAX_FRAGMENT_CHARS, LAYER_B_MIN_FRAGMENT_CHARS,
            LAYER_B_LOSSLESS_TOLERANCE
        }
    };
}

module.exports = {
    createHybridSegmenter,
    assessQuality,
    computeMetrics,
    DEFAULT_THRESHOLDS,
    LAYER_B_SYSTEM_PROMPT,
    LAYER_B_MAX_FRAGMENT_CHARS,
    LAYER_B_LOSSLESS_TOLERANCE
};
