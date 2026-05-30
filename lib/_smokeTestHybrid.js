// ═══════════════════════════════════════════════════════════════════════
//  _smokeTestHybrid.js
//  Smoke-test для hybridSegmenter с автоматическим сбором ошибок.
//
//  Запуск:
//    node lib/_smokeTestHybrid.js          # без Layer B (без сети)
//    node lib/_smokeTestHybrid.js --live   # с реальным cascade (нужны GEMINI_API_KEY / DEEPSEEK_API_KEY)
//
//  Артефакт:
//    segmentation_errors.json — массив проблемных кейсов, по каждому:
//      { file, bytes, chunks, issues, metrics, layers, durations }
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const {
    createHybridSegmenter,
    assessQuality,
    computeMetrics,
    DEFAULT_THRESHOLDS
} = require('./hybridSegmenter');
const { segmentDocumentRegex } = require('./segmentRegex');

const LIVE_MODE = process.argv.includes('--live');
const CORPUS_DIR = path.resolve(__dirname, '..', 'test_corpus');
const ERR_OUT = path.resolve(__dirname, '..', 'segmentation_errors.json');

let pass = 0, fail = 0;
function assert(cond, name, extra = '') {
    if (cond) { pass++; console.log('  PASS', name); }
    else      { fail++; console.log('  FAIL', name, extra); }
}

// ═══════════════════════════════════════════════════════════════════════
//  Mock cascade — для unit-теста Layer B без сети
// ═══════════════════════════════════════════════════════════════════════
function makeMockCascade(behavior = 'split-in-3') {
    return {
        call: async ({ userPrompt }) => {
            // Извлекаем фрагмент текста между --- маркерами
            const m = userPrompt.match(/---\n([\s\S]+?)\n---/);
            const fragment = m ? m[1] : userPrompt;
            let chunks;
            switch (behavior) {
                case 'split-in-3': {
                    const third = Math.ceil(fragment.length / 3);
                    chunks = [
                        fragment.slice(0, third),
                        fragment.slice(third, 2 * third),
                        fragment.slice(2 * third)
                    ].filter(c => c.trim().length > 0);
                    break;
                }
                case 'identity':
                    chunks = [fragment];
                    break;
                case 'lossy':
                    chunks = [fragment.slice(0, Math.floor(fragment.length * 0.5))];
                    break;
                case 'add-extra':
                    chunks = [fragment, 'ВЫДУМАННЫЙ ДОПОЛНИТЕЛЬНЫЙ БЛОК'];
                    break;
                case 'invalid-shape':
                    return { text: JSON.stringify({ wrong: 'shape' }), model: 'mock', tier: 1 };
                case 'invalid-json':
                    return { text: 'not json {{{', model: 'mock', tier: 1 };
                case 'all-failed': {
                    const err = new Error('mock cascade all failed');
                    err.allFailed = true;
                    throw err;
                }
                default:
                    chunks = [fragment];
            }
            return { text: JSON.stringify({ chunks }), model: 'mock', tier: 1 };
        }
    };
}

// ═══════════════════════════════════════════════════════════════════════
//  Live cascade — для прод-теста (нужны API keys)
// ═══════════════════════════════════════════════════════════════════════
function maybeBuildLiveCascade() {
    if (!LIVE_MODE) return null;
    try {
        require('dotenv').config();
    } catch (_) { /* dotenv не установлен — ок, если ключи через env */ }

    const { createLightLLMCascade } = require('./llmCascade');
    const geminiKeys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
        .split(',').map(s => s.trim()).filter(Boolean);
    if (geminiKeys.length === 0) {
        console.error('LIVE mode: GEMINI_API_KEY(S) не задан, выход');
        process.exit(1);
    }
    let keyIdx = 0;
    const getNextKey = () => geminiKeys[keyIdx++ % geminiKeys.length];

    // Минимальный DeepSeek shim (если DEEPSEEK_API_KEY есть, иначе off)
    const deepseekKey = process.env.DEEPSEEK_API_KEY;
    const deepseekJsonCall = deepseekKey
        ? async ({ systemPrompt, userPrompt, model }) => {
            const fetch = require('node-fetch');
            const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json',
                           'Authorization': `Bearer ${deepseekKey}` },
                body: JSON.stringify({
                    model: model || 'deepseek-chat',
                    messages: [{ role: 'system', content: systemPrompt },
                               { role: 'user',   content: userPrompt }],
                    response_format: { type: 'json_object' },
                    temperature: 0.0,
                    max_tokens: 8000
                })
            });
            if (!res.ok) throw new Error(`DeepSeek ${res.status}`);
            const data = await res.json();
            return data?.choices?.[0]?.message?.content || '';
          }
        : async () => { throw new Error('DEEPSEEK_API_KEY not set'); };

    return createLightLLMCascade({
        getNextKey, deepseekJsonCall,
        deepseekEnabled: !!deepseekKey,
        logger: console
    });
}

// ═══════════════════════════════════════════════════════════════════════
//  Walk corpus
// ═══════════════════════════════════════════════════════════════════════
function walkCorpus(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...walkCorpus(p));
        else if (e.name.endsWith('.txt')) out.push(p);
    }
    return out;
}

// ═══════════════════════════════════════════════════════════════════════
//  TESTS
// ═══════════════════════════════════════════════════════════════════════

console.log('=== TEST 1: computeMetrics на пустых данных ===');
{
    const m0 = computeMetrics([], '');
    assert(m0.totalChunks === 0, 'пустой массив → 0 чанков');
    assert(m0.maxChunkLen === 0, 'maxChunkLen = 0');
    const m1 = computeMetrics(['hello world'], 'hello world');
    assert(m1.totalChunks === 1, '1 чанк');
    assert(m1.maxChunkLen === 11, 'maxChunkLen = 11');
    assert(m1.lossNonWs === 0, 'lossless ok');
}

console.log('\n=== TEST 2: assessQuality — pass для нормального документа ===');
{
    const chunks = ['абвгде', 'жзиклм', 'нопрст', 'уфхцчш'];
    const text = chunks.join('\n\n');
    const q = assessQuality(chunks, text);
    assert(q.action === 'pass', 'action = pass', `got ${q.action} issues=${JSON.stringify(q.issues)}`);
    assert(q.issues.length === 0, 'нет issues');
    assert(q.problemZones.length === 0, 'нет problem zones');
}

console.log('\n=== TEST 3: assessQuality — GIANT_CHUNK ===');
{
    const giant = 'А'.repeat(3000);
    const chunks = ['маленький', giant, 'ещё мелкий'];
    const q = assessQuality(chunks, chunks.join('\n'));
    assert(q.action === 'escalate', 'escalate');
    assert(q.issues.some(i => i.kind === 'GIANT_CHUNK'), 'есть GIANT_CHUNK issue');
    assert(q.problemZones.some(z => z.kind === 'GIANT_CHUNK' && z.indices[0] === 1),
        'problem zone = index 1');
}

console.log('\n=== TEST 4: assessQuality — TOO_MANY_SMALL ===');
{
    const chunks = Array.from({ length: 60 }, (_, i) => `ч${i}`);
    const text = chunks.join('\n');
    const q = assessQuality(chunks, text);
    assert(q.action === 'escalate', 'escalate');
    assert(q.issues.some(i => i.kind === 'TOO_MANY_SMALL'), 'есть TOO_MANY_SMALL');
    assert(q.problemZones.some(z => z.kind === 'TOO_MANY_SMALL'), 'есть problem zone');
}

console.log('\n=== TEST 5: assessQuality — DOMINANT_CHUNK ===');
{
    const big = 'А'.repeat(800);
    const chunks = [big, 'мал', 'мал'];
    const q = assessQuality(chunks, chunks.join('\n'));
    assert(q.issues.some(i => i.kind === 'DOMINANT_CHUNK'), 'есть DOMINANT_CHUNK');
}

console.log('\n=== TEST 6: assessQuality — TOO_FEW ===');
{
    const text = 'А'.repeat(3000);
    const chunks = [text.slice(0, 1500), text.slice(1500)];
    const q = assessQuality(chunks, text);
    assert(q.issues.some(i => i.kind === 'TOO_FEW'), 'есть TOO_FEW');
    assert(q.problemZones.some(z => z.scope === 'full'), 'full-doc rebuild zone');
}

(async () => {
    console.log('\n=== TEST 7: pass-through (нормальный документ → только Layer A) ===');
    {
        const seg = createHybridSegmenter({ cascade: makeMockCascade(), layerBEnabled: true });
        const doc = `Договор аренды нежилого помещения

1. Предмет договора.
Арендодатель передаёт помещение.

2. Срок аренды.
12 месяцев.

3. Арендная плата.
50000 сом в месяц.`;
        const res = await seg.segment(doc);
        assert(res.layers.length === 1 && res.layers[0] === 'A', 'только Layer A', `got ${JSON.stringify(res.layers)}`);
        assert(res.layerB.called === false, 'Layer B не вызывался');
        assert(res.chunks.length >= 3 && res.chunks.length <= 6, 'разумное число чанков',
            `got ${res.chunks.length}`);
        assert(res.quality.action === 'pass', 'quality.action = pass');
    }

    console.log('\n=== TEST 8: Layer B вызывается на GIANT_CHUNK (mock split-in-3) ===');
    {
        const seg = createHybridSegmenter({ cascade: makeMockCascade('split-in-3'), layerBEnabled: true });
        // Создаём документ ≥ 5 чанков, один из них GIANT.
        // Длинные параграфы (>100ch), чтобы mergeSmallAdjacent не сливал их.
        const p = (n) => `Это длинный параграф номер ${n} с описанием действий стороны, требований и обязательств в текущем юридическом контексте.`;
        const giantText = 'А'.repeat(2700);
        const doc = `${p(1)}

${p(2)}

${p(3)}

${p(4)}

${giantText}

${p(5)}`;
        const res = await seg.segment(doc);
        assert(res.layers.includes('B'), 'Layer B был вызван', `got ${JSON.stringify(res.layers)}`);
        assert(res.layerB.called === true, 'layerB.called = true');
        assert(res.layerB.success > 0, 'хотя бы одна zone успешна');
        // Layer A даёт ~6 chunks (5 preamble + 1 giant + 1 finale = 7, после merge ~6).
        // После rebuild GIANT_CHUNK разрезался на 3 части → больше чанков.
        assert(res.chunks.length >= 7, `после rebuild чанков ≥7 (got ${res.chunks.length})`);
        // Lossless preserved
        const rawNW = doc.replace(/\s/g, '').length;
        const outNW = res.chunks.join('').replace(/\s/g, '').length;
        assert(rawNW === outNW, 'lossless после GIANT rebuild');
    }

    console.log('\n=== TEST 9: Layer B lossy-guard ===');
    {
        const seg = createHybridSegmenter({ cascade: makeMockCascade('lossy'), layerBEnabled: true });
        const giant = 'Каждая буква нужна. '.repeat(150);
        const doc = `Преамбула.\n\n${giant}\n\nКонец.`;
        const res = await seg.segment(doc);
        // Lossy cascade → Layer B reject → fallback на Layer A
        assert(res.layerB.zones.some(z => z.status === 'failed' && z.reason === 'lossy_response'),
            'lossy zone reject', `zones: ${JSON.stringify(res.layerB.zones)}`);
        // Главное: общий объём текста сохранён (Layer A chunks остались)
        const rawNW = doc.replace(/\s/g, '').length;
        const outNW = res.chunks.join('').replace(/\s/g, '').length;
        assert(rawNW === outNW, 'lossless preserved', `${rawNW} vs ${outNW}`);
    }

    console.log('\n=== TEST 10: Layer B invalid JSON → graceful fallback ===');
    {
        const seg = createHybridSegmenter({ cascade: makeMockCascade('invalid-json'), layerBEnabled: true });
        const doc = `Преамбула.\n\n${'А'.repeat(2700)}\n\nКонец.`;
        const res = await seg.segment(doc);
        assert(res.layerB.zones.some(z => z.status === 'failed'), 'zone failed');
        // Fallback chunks = Layer A chunks
        const rawNW = doc.replace(/\s/g, '').length;
        const outNW = res.chunks.join('').replace(/\s/g, '').length;
        assert(rawNW === outNW, 'lossless после fallback');
    }

    console.log('\n=== TEST 11: cascade.allFailed → graceful fallback ===');
    {
        const seg = createHybridSegmenter({ cascade: makeMockCascade('all-failed'), layerBEnabled: true });
        const doc = `Преамбула.\n\n${'А'.repeat(2700)}\n\nКонец.`;
        const res = await seg.segment(doc);
        assert(res.layerB.fallback > 0, 'есть fallback');
        // Lossless через Layer A
        const rawNW = doc.replace(/\s/g, '').length;
        const outNW = res.chunks.join('').replace(/\s/g, '').length;
        assert(rawNW === outNW, 'lossless после all-failed');
    }

    console.log('\n=== TEST 12: layerBEnabled=false → только Layer A даже на патологии ===');
    {
        const seg = createHybridSegmenter({ cascade: makeMockCascade(), layerBEnabled: false });
        const doc = `Преамбула.\n\n${'А'.repeat(2700)}\n\nКонец.`;
        const res = await seg.segment(doc);
        assert(res.layerB.called === false, 'Layer B disabled');
        assert(res.layerB.reason === 'layer_b_disabled', 'reason = layer_b_disabled');
        assert(res.layers.length === 1, 'только Layer A');
    }

    console.log('\n=== TEST 13: nocascade → graceful skip ===');
    {
        const seg = createHybridSegmenter({ cascade: null, layerBEnabled: true });
        const doc = `Преамбула.\n\n${'А'.repeat(2700)}\n\nКонец.`;
        const res = await seg.segment(doc);
        assert(res.layerB.called === false, 'Layer B не вызывался');
        assert(res.layerB.reason === 'no_cascade', 'reason = no_cascade');
    }

    console.log('\n=== TEST 14: реальный корпус test_corpus/ — собираем segmentation_errors.json ===');
    {
        // В mock-режиме используем split-in-3 mock — Layer B будет вызываться
        // на всех escalated документах. Покажет что pipeline работает end-to-end,
        // даже если mock не делает осмысленный rebuild.
        const cascade = LIVE_MODE ? maybeBuildLiveCascade() : makeMockCascade('split-in-3');
        const seg = createHybridSegmenter({ cascade, layerBEnabled: true });

        const files = walkCorpus(CORPUS_DIR);
        console.log(`  Found ${files.length} files in test_corpus/`);

        const errors = [];
        const summary = { total: 0, pass: 0, escalated: 0, layerBCalls: 0, lossy: 0 };

        for (const f of files) {
            const text = fs.readFileSync(f, 'utf8');
            if (!text.trim()) continue;
            summary.total++;

            let res;
            try {
                res = await seg.segment(text, { stageLabel: 'corpus_test' });
            } catch (e) {
                errors.push({
                    file: path.relative(CORPUS_DIR, f),
                    error: 'segment_threw',
                    message: e.message
                });
                continue;
            }

            // Lossless check на финальном результате
            const rawNW = text.replace(/\s/g, '').length;
            const outNW = res.chunks.join('').replace(/\s/g, '').length;
            const lossy = rawNW !== outNW;
            if (lossy) summary.lossy++;
            if (res.layerB.called) summary.layerBCalls++;
            if (res.quality.action === 'pass') summary.pass++;
            else summary.escalated++;

            // Условия для записи в errors:
            //   🔴 lossless нарушен
            //   🟠 quality.action='escalate' но Layer B не починил (есть failed zones)
            //   🟡 hard out-of-range: < 5 или > 80 чанков
            //      (внутри 5-80 — приемлемо, quality сам решает что эскалировать)
            const layerBFailures = res.layerB.zones?.filter(z => z.status === 'failed') || [];
            const hardOutOfRange = res.chunks.length < 5 || res.chunks.length > 80;
            const escalationFailed = res.quality.action === 'escalate' && layerBFailures.length > 0;
            if (lossy || hardOutOfRange || escalationFailed) {
                errors.push({
                    file: path.relative(CORPUS_DIR, f),
                    bytes: text.length,
                    chunks: res.chunks.length,
                    layers: res.layers,
                    issues: res.quality.issues.map(i => i.kind),
                    metrics: res.quality.metrics,
                    layerB: res.layerB,
                    durations: res.durations,
                    lossy,
                    hardOutOfRange,
                    escalationFailed,
                    layerBFailures: layerBFailures.length
                });
            }
        }

        fs.writeFileSync(ERR_OUT, JSON.stringify({
            generatedAt: new Date().toISOString(),
            mode: LIVE_MODE ? 'live' : 'mock',
            summary,
            thresholds: DEFAULT_THRESHOLDS,
            errors
        }, null, 2));
        console.log(`  → wrote ${errors.length} errors to ${ERR_OUT}`);
        console.log(`  summary:`, JSON.stringify(summary));

        // Acceptance: lossless должен быть 100%
        assert(summary.lossy === 0, `0 lossy документов (got ${summary.lossy})`);
        assert(errors.filter(e => e.hardOutOfRange).length === 0,
            `0 документов с hard out-of-range (got ${errors.filter(e => e.hardOutOfRange).length})`);
        assert(errors.filter(e => e.escalationFailed).length === 0,
            `0 документов с провалом эскалации (got ${errors.filter(e => e.escalationFailed).length})`);
    }

    console.log(`\n========== ИТОГ: ${pass} pass, ${fail} fail ==========`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
    console.error('SMOKE TEST CRASHED:', e);
    process.exit(2);
});
