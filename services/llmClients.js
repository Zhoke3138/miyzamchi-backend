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
  });
  return text;
}

// ── DeepSeek reasoner (Финальный Судья) ────────────────────────────────────
const DEEPSEEK_ENABLED = !!process.env.DEEPSEEK_API_KEY;
const _deepseek = DEEPSEEK_ENABLED
  ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' })
  : null;

// effort -> бюджет вывода (реальный рычаг; reasoning_effort пробрасываем как hint,
// OpenAI SDK форвардит неизвестные поля — DeepSeek учтёт либо проигнорирует).
const EFFORT_MAX_TOKENS = { low: 1500, medium: 3000, high: 6000 };

async function deepseekReason({ systemPrompt, userPrompt, reasoning_effort = 'medium' }) {
  const maxTokens = EFFORT_MAX_TOKENS[reasoning_effort] || EFFORT_MAX_TOKENS.medium;

  if (!_deepseek) {
    // Прозрачный fallback на Gemini 2.5 Flash, если DeepSeek не настроен.
    const text = await geminiJson({
      systemPrompt, userPrompt, model: 'gemini-2.5-flash',
      maxOutputTokens: maxTokens, timeoutMs: 30000,
    });
    return { text, model: 'gemini-2.5-flash(fallback)' };
  }

  const completion = await _deepseek.chat.completions.create({
    model: 'deepseek-reasoner',
    reasoning_effort,            // пробрасывается как есть (см. коммент выше)
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });
  return {
    text: completion.choices?.[0]?.message?.content || '',
    model: 'deepseek-reasoner',
  };
}

module.exports = {
  getNextKey,
  getEmbedding,
  queryPinecone,
  geminiJson,
  deepseekReason,
  DEEPSEEK_ENABLED,
};
