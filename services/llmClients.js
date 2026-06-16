'use strict';
/**
 * Miyzamchi 2.0 — Low-level LLM/RAG клиенты (self-contained, из .env)
 * ==================================================================
 * Повторяет боевые паттерны server.js, но БЕЗ импорта монолита (он при require
 * поднимает HTTP-сервер). Используется в Stateful Multi-Agent RAG (analyzeV2).
 *
 * ENV (те же имена, что в server.js):
 *   GEMINI_API_KEY / GEMINI_API_KEYS — ключи Gemini через запятую (ротация)
 *   PINECONE_API_KEY, PINECONE_HOST  — векторная БД законов КР (Read-Only)
 *   DEEPSEEK_API_KEY                 — Финальный Судья (опц., есть Gemini-fallback)
 */

const OpenAI = require('openai');
const { callGeminiSingle } = require('../lib/llmCascade');

// ── Gemini ключи + round-robin ротация ────────────────────────────────────
const rawKeys = process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS || '';
const KEYS = rawKeys.split(',').map((k) => k.trim()).filter(Boolean);
let _keyIdx = 0;

function getNextKey() {
  if (!KEYS.length) throw new Error('GEMINI_API_KEY не задан в .env');
  const key = KEYS[_keyIdx % KEYS.length];
  _keyIdx += 1;
  return key;
}

// ── Embeddings (gemini-embedding-001, срез до 768d — как в server.js) ──────
const EMBEDDING_MODEL = 'models/gemini-embedding-001';
const _embedCache = new Map();

async function getEmbedding(text) {
  const slice = (text || '').slice(0, 8000);
  if (_embedCache.has(slice)) return _embedCache.get(slice);

  const key = getNextKey();
  const url = `https://generativelanguage.googleapis.com/v1beta/${EMBEDDING_MODEL}:embedContent?key=${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      content: { parts: [{ text: slice }] },
      outputDimensionality: 768,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'embedding failed');

  const vector = data.embedding.values.slice(0, 768);
  if (_embedCache.size >= 200) _embedCache.delete(_embedCache.keys().next().value);
  _embedCache.set(slice, vector);
  return vector;
}

// ── Pinecone query (native fetch + Api-Key, таймаут 4с — как в server.js) ──
const PINECONE_HOST = (process.env.PINECONE_HOST || '').replace(/\/+$/, '');
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;

async function queryPinecone(vector, topK = 15, filter = null) {
  if (!PINECONE_HOST || !PINECONE_API_KEY) throw new Error('PINECONE_HOST/PINECONE_API_KEY не заданы');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const body = { vector, topK, includeMetadata: true };
    // Жёсткая привязка к НПА: метаданный фильтр Pinecone (напр. { npa_title: { $eq } }).
    if (filter) body.filter = filter;
    const res = await fetch(`${PINECONE_HOST}/query`, {
      method: 'POST',
      headers: { 'Api-Key': PINECONE_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json();
    return data.matches || [];
  } catch (err) {
    if (err.name === 'AbortError') return []; // graceful: пустой результат вместо падения
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Gemini генерация JSON (gemini-3.1-flash-lite по умолчанию) ─────────────
// Переиспользуем single-shot helper из llmCascade (тот же SDK, тот же payload-fix).
async function geminiJson({
  systemPrompt, userPrompt,
  model = 'gemini-3.1-flash-lite',
  temperature = 0.2, maxOutputTokens = 2048, timeoutMs = 15000,
  thinkingConfig = null,
}) {
  const { text } = await callGeminiSingle({
    apiKey: getNextKey(),
    modelName: model,
    systemPrompt,
    userPrompt,
    jsonMode: true,
    timeoutMs,
    temperature,
    maxOutputTokens,
    thinkingConfig,
  });
  return text;
}

// ── DeepSeek reasoner (Финальный Судья) ────────────────────────────────────
const DEEPSEEK_ENABLED = !!process.env.DEEPSEEK_API_KEY;
const _deepseek = DEEPSEEK_ENABLED
  ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' })
  : null;

// Финальный Судья = deepseek-v4-pro с Chain-of-Thought (reasoning).
// Правила API (deepseek-v4-pro):
//   • temperature/top_p/presence_penalty/frequency_penalty — НЕ поддерживаются (не передаём);
//   • reasoning_effort — только 'high' | 'max';
//   • включение рассуждений: { thinking: { type: 'enabled' } };
//   • max_tokens большой (32000).
// Примечание (Node openai SDK): в Python это extra_body={...}. В Node SDK неизвестные
// поля кладутся ПРЯМО в тело запроса (проверено в server.js), поэтому thinking и
// reasoning_effort передаём верхним уровнем — они доходят до DeepSeek as-is.
// 2026-06-12 STREAMING FIX: раньше вызов шёл БЕЗ stream:true — DeepSeek сначала
// целиком думал (thinking enabled, effort=high, до 32k токенов), и только потом
// возвращал полный ответ → фронт получал текст одним куском в самом конце.
// Теперь stream:true + onDelta-колбэк: по официальной доке DeepSeek
// (api-docs.deepseek.com/guides/thinking_mode) при стриминге сначала идут
// дельты delta.reasoning_content (цепочка мыслей), затем delta.content (ответ).
// Вызывающий код (analyzeV2) стримит reasoning в UI в тегах <think>…</think>.
//   onDelta({ reasoning }) — чанк цепочки рассуждений;
//   onDelta({ text })      — чанк основного ответа.
// Без onDelta поведение прежнее: ждём всё и возвращаем { text, model }.
// 2026-06-16 ДИНАМИЧЕСКИЙ СУДЬЯ: model + thinking теперь параметры (роутер
// в analyzeV2 выбирает их по тяжести документа):
//   • лёгкий документ → deepseek-v4-flash, effort 'low', thinking 'disabled'
//     (быстро, мгновенный стрим, без CoT);
//   • тяжёлый → deepseek-v4-pro, effort 'high'→'max', thinking 'enabled'.
// Ограничения API: v4-pro принимает только high|max; v4-flash — low|medium|high.
async function deepseekReason({
  systemPrompt, userPrompt,
  reasoning_effort = 'high',
  model = 'deepseek-v4-pro',
  thinking = 'enabled',
  onDelta = null,
}) {
  const isPro = /pro/i.test(model);
  // effort клампится под возможности модели.
  const effort = isPro
    ? (reasoning_effort === 'max' ? 'max' : 'high')
    : (['low', 'medium', 'high'].includes(reasoning_effort) ? reasoning_effort : 'low');
  const thinkingType = thinking === 'disabled' ? 'disabled' : 'enabled';
  const emit = (d) => { if (onDelta) { try { onDelta(d); } catch (_) {} } };

  if (!_deepseek) {
    // Прозрачный fallback на Gemini 2.5 Flash, если DEEPSEEK_API_KEY не задан.
    const text = await geminiJson({
      systemPrompt, userPrompt, model: 'gemini-2.5-flash',
      maxOutputTokens: 8192, timeoutMs: 45000,
    });
    emit({ text });   // консистентность: стрим-потребитель получит текст тем же каналом
    return { text, model: 'gemini-2.5-flash(fallback)' };
  }

  const stream = await _deepseek.chat.completions.create({
    model,
    reasoning_effort: effort,
    max_tokens: 32000,
    thinking: { type: thinkingType },   // Node-эквивалент Python extra_body
    stream: true,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });

  let text = '';
  let reasoning = '';
  for await (const chunk of stream) {
    const delta = (chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta) || {};
    if (delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      emit({ reasoning: delta.reasoning_content });
    }
    if (delta.content) {
      text += delta.content;
      emit({ text: delta.content });
    }
  }
  if (reasoning) {
    console.log(`[DeepSeek DEBUG] ${model} reasoning_content: ${reasoning.length}ch (streamed)`);
  }
  return { text, model, reasoning };
}

module.exports = {
  getNextKey,
  getEmbedding,
  queryPinecone,
  geminiJson,
  deepseekReason,
  DEEPSEEK_ENABLED,
};
