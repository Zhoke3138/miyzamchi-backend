// ═══════════════════════════════════════════════════════════════════════
//  _smokeTestLLMCascade.js
//  Smoke-test для lib/llmCascade.js — фокус на регрессе бага 2026-06-02:
//  callGeminiSingle с multi-turn contents должен оборачивать в
//  { contents: [...] } а не передавать массив as-is (иначе SDK
//  интерпретирует как Part[] → Google API: 400 "Unknown name 'role'").
//
//  Запуск: node lib/_smokeTestLLMCascade.js
// ═══════════════════════════════════════════════════════════════════════

const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
function assert(cond, name, extra = '') {
    if (cond) { pass++; console.log('  PASS', name); }
    else      { fail++; console.log('  FAIL', name, extra); }
}

// ── Перехватываем require('@google/generative-ai') ДО загрузки llmCascade ─
let capturedPayloads = [];
let capturedModelOpts = [];

const FAKE_GENAI = {
    GoogleGenerativeAI: class {
        constructor(apiKey) { this.apiKey = apiKey; }
        getGenerativeModel(opts) {
            capturedModelOpts.push(opts);
            return {
                generateContent: (payload) => {
                    capturedPayloads.push(payload);
                    return Promise.resolve({
                        response: {
                            text: () => '{"status":"ok"}',
                            candidates: [{ content: { parts: [{ text: '{"status":"ok"}' }] } }],
                            usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20 }
                        }
                    });
                }
            };
        }
    }
};

const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;
Module._load = function(request, parent, ...rest) {
    if (request === '@google/generative-ai') return FAKE_GENAI;
    return originalLoad.call(this, request, parent, ...rest);
};

// Чистим require-кеш на случай если уже грузили
delete require.cache[require.resolve('./llmCascade')];
const { callGeminiSingle } = require('./llmCascade');

(async () => {

// ═══════════════════════════════════════════════════════════════════════
console.log('=== TEST 1: contents (Content[]) → wrap в { contents } ===');
{
    capturedPayloads = [];
    const myContents = [
        { role: 'user', parts: [{ text: 'привет' }] },
        { role: 'model', parts: [{ functionCall: { name: 'search', args: { q: 'x' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'search', response: { found: 0 } } }] }
    ];
    await callGeminiSingle({
        apiKey: 'fake', modelName: 'gemini-3.1-flash-lite',
        systemPrompt: 'sys', userPrompt: '', contents: myContents,
        timeoutMs: 5000, returnRaw: true
    });
    assert(capturedPayloads.length === 1, 'один вызов generateContent');
    const p = capturedPayloads[0];
    assert(p && typeof p === 'object' && !Array.isArray(p),
        'payload — это объект, не голый массив',
        'got typeof=' + typeof p + ', isArray=' + Array.isArray(p));
    assert(Array.isArray(p.contents),
        'payload.contents — массив (GenerateContentRequest форма)',
        'payload keys: ' + Object.keys(p || {}).join(','));
    assert(p.contents.length === 3, 'все 3 Content передались');
    assert(p.contents[0].role === 'user' && Array.isArray(p.contents[0].parts),
        'Content[0] имеет role на верхнем уровне и parts массивом');
    assert(p.contents[0].parts[0].text === 'привет',
        'parts[0].text не имеет лишних role/parts вложений');
    assert(p.contents[1].parts[0].functionCall?.name === 'search',
        'functionCall сохранён в parts[0]');
    assert(p.contents[2].parts[0].functionResponse?.name === 'search',
        'functionResponse сохранён в parts[0]');

    // Регресс самого бага: parts[0] НЕ должен содержать role
    assert(!('role' in p.contents[0].parts[0]),
        '🛑 REGRESS: parts[0] НЕ содержит role (иначе 400 от Google API)');
}

// ═══════════════════════════════════════════════════════════════════════
console.log('=== TEST 2: userPrompt (string) — старое поведение ===');
{
    capturedPayloads = [];
    await callGeminiSingle({
        apiKey: 'fake', modelName: 'gemini-2.5-flash',
        systemPrompt: 'sys', userPrompt: 'просто строка',
        timeoutMs: 5000
    });
    assert(capturedPayloads.length === 1, 'один вызов generateContent');
    assert(capturedPayloads[0] === 'просто строка',
        'без contents → передаётся userPrompt как строка (SDK сам обернёт)');
}

// ═══════════════════════════════════════════════════════════════════════
console.log('=== TEST 3: tools прокидываются в getGenerativeModel ===');
{
    capturedModelOpts = [];
    capturedPayloads = [];
    const tools = [{
        functionDeclarations: [{
            name: 'search_legislation_kg',
            description: 'test',
            parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' } }, required: ['query'] }
        }]
    }];
    await callGeminiSingle({
        apiKey: 'fake', modelName: 'gemini-3.1-flash-lite',
        systemPrompt: 'sys',
        contents: [{ role: 'user', parts: [{ text: 'q' }] }],
        tools, timeoutMs: 5000, returnRaw: true
    });
    assert(capturedModelOpts.length === 1, 'getGenerativeModel вызван');
    const mo = capturedModelOpts[0];
    assert(Array.isArray(mo.tools) && mo.tools[0].functionDeclarations,
        'tools переданы в model options');
    assert(mo.systemInstruction === 'sys', 'systemInstruction передан');
    // jsonMode НЕ должен включаться при tools
    assert(!mo.generationConfig?.responseMimeType,
        'responseMimeType НЕ выставлен (jsonMode + tools несовместимы)');
}

// ═══════════════════════════════════════════════════════════════════════
console.log('═══════════════════════════════════════════════════════════════════');
console.log(`ИТОГ: ${pass} pass, ${fail} fail`);
console.log('═══════════════════════════════════════════════════════════════════');

Module._load = originalLoad;
Module._resolveFilename = originalResolve;

process.exit(fail > 0 ? 1 : 0);

})().catch(e => { console.error('UNCAUGHT', e); process.exit(1); });
