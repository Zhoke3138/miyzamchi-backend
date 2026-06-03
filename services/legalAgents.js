'use strict';
/**
 * Miyzamchi 2.0 — Боевые агенты (5 [INTEGRATE]-точек для analyzeV2)
 * ================================================================
 * extractGlossary  — LLM-экстрактор словаря терминов + кросс-ссылок + шапки (Фаза 1.3)
 * expandQuery      — Query Expansion: 3-4 синонима для поиска (Фаза 3.3)
 * pineconeSearch   — векторизация запросов + поиск в Pinecone (Фаза 3.3)
 * validate         — Строгий Валидатор -> { verdict, reason, cited_articles } (Фаза 3.4)
 * judge            — Финальный Судья (DeepSeek reasoner, Pure Synthesizer) (Фаза 4)
 *
 * Все модели и ключи берутся из .env через services/llmClients.
 */

const clients = require('./llmClients');

// ── Безопасный парс JSON (Gemini иногда оборачивает в ```json ... ```) ─────
function safeJson(text, fallback) {
  if (!text) return fallback;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.search(/[[{]/);
  if (start > 0) s = s.slice(start);
  try { return JSON.parse(s); } catch (_) { return fallback; }
}

// ═══════════════════════════════════════════════════════════════════════
// ФАЗА 1.3 — LLM-Экстрактор словаря
// ═══════════════════════════════════════════════════════════════════════
const GLOSSARY_SYS = `Ты — извлекатель структуры юридического документа (Кыргызстан).
Верни СТРОГО JSON по схеме:
{
  "header": "<краткая шапка/предмет документа, 1-2 предложения>",
  "terms": { "<термин>": "<определение из текста>" },
  "crossRefs": { "<ссылка вида 'п.5.1' или 'ст.10'>": "<краткий смысл пункта>" }
}
ПРАВИЛА:
- Только то, что РЕАЛЬНО есть в тексте. Ничего не выдумывай.
- terms: 5-30 ключевых определений/сторон/предметов.
- crossRefs: внутренние ссылки документа (пункты/статьи самого документа), не НПА.
- Без markdown, без комментариев — только JSON.`;

async function extractGlossary(markdown, _chunks) {
  // Один проход по документу (усечение для бюджета токенов).
  const userPrompt = `ДОКУМЕНТ:\n${(markdown || '').slice(0, 14000)}`;
  try {
    const raw = await clients.geminiJson({
      systemPrompt: GLOSSARY_SYS, userPrompt,
      model: 'gemini-3.1-flash-lite', maxOutputTokens: 2048,
    });
    const parsed = safeJson(raw, {});
    return {
      header: typeof parsed.header === 'string' ? parsed.header : '',
      terms: parsed.terms && typeof parsed.terms === 'object' ? parsed.terms : {},
      crossRefs: parsed.crossRefs && typeof parsed.crossRefs === 'object' ? parsed.crossRefs : {},
    };
  } catch (_) {
    // Graceful degradation: пустой словарь — пайплайн продолжит работу.
    return { header: '', terms: {}, crossRefs: {} };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ФАЗА 3.3 — Query Expansion
// ═══════════════════════════════════════════════════════════════════════
const EXPAND_SYS = `Ты формируешь поисковые запросы для базы законов Кыргызской Республики.
По фрагменту документа верни СТРОГО JSON:
{ "queries": ["<запрос 1>", "<запрос 2>", "<запрос 3>"] }
ПРАВИЛА:
- 3-4 запроса, каждый — юридическая формулировка сути фрагмента (предмет регулирования).
- Используй официальные термины КР, раскрывай аббревиатуры (ГК КР -> Гражданский кодекс КР).
- Без markdown — только JSON.`;

async function expandQuery(chunkText) {
  try {
    const raw = await clients.geminiJson({
      systemPrompt: EXPAND_SYS,
      userPrompt: `ФРАГМЕНТ:\n${(chunkText || '').slice(0, 3000)}`,
      model: 'gemini-3.1-flash-lite', maxOutputTokens: 512, timeoutMs: 10000,
    });
    const parsed = safeJson(raw, {});
    const queries = Array.isArray(parsed.queries) ? parsed.queries.filter(Boolean).slice(0, 4) : [];
    // Всегда добавляем исходный фрагмент как базовый запрос.
    return queries.length ? queries : [chunkText.slice(0, 1500)];
  } catch (_) {
    return [chunkText.slice(0, 1500)];
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ФАЗА 3.3 — Pinecone search (multi-query merge)
// ═══════════════════════════════════════════════════════════════════════
async function pineconeSearch(queries, topKPerQuery = 6) {
  const byId = new Map(); // dedupe по id, держим максимальный score
  for (const q of queries) {
    let matches = [];
    try {
      const vector = await clients.getEmbedding(q);
      matches = await clients.queryPinecone(vector, topKPerQuery);
    } catch (_) {
      matches = []; // graceful: один промах не валит весь поиск
    }
    for (const m of matches) {
      const prev = byId.get(m.id);
      if (!prev || m.score > prev.score) byId.set(m.id, m);
    }
  }
  // Возвращаем «сырые» hits; двухступенчатый фильтр применит роут (twoStagePineconeFilter).
  return Array.from(byId.values()).sort((a, b) => b.score - a.score);
}

// ═══════════════════════════════════════════════════════════════════════
// ФАЗА 3.4 — Строгий Валидатор
// ═══════════════════════════════════════════════════════════════════════
const VALIDATOR_SYS = `Ты — строгий юридический валидатор (право Кыргызской Республики).
Проверяешь ОДИН фрагмент документа на противоречие законам КР.

Тебе даны ТОЛЬКО релевантные статьи НПА из базы (RAG). Верни СТРОГО JSON:
{ "verdict": "clean" | "warning" | "critical", "reason": "<кратко по сути>", "cited_articles": ["<НПА, ст.N>"] }

ЖЕЛЕЗНЫЕ ПРАВИЛА:
1. Цитируй ТОЛЬКО статьи из предоставленного списка. Запрещено придумывать номера статей по памяти.
2. Если видишь риск, но в списке НЕТ релевантной статьи — верни cited_articles: [] (это «Слепая зона», её разберёт Судья).
3. clean — нет противоречий; warning — спорно/риск; critical — явное нарушение императивной нормы.
4. reason — по существу, без воды и без стилистических советов.
5. Без markdown — только JSON.`;

function renderArticles(articles) {
  if (!articles || !articles.length) return '(релевантных статей из базы не найдено)';
  return articles.map((a, i) => {
    const md = a.metadata || {};
    const title = [md.npa_title, md.article_title].filter(Boolean).join(' — ');
    return `[${i + 1}] ${title}\n${(md.full_text || '').slice(0, 1500)}`;
  }).join('\n\n');
}

async function validate({ chunkText, ctx, articles }) {
  const ctxBlock = [
    ctx?.header ? `ШАПКА: ${ctx.header}` : '',
    ctx?.relevantTerms?.length ? `ТЕРМИНЫ: ${ctx.relevantTerms.map((t) => `${t.term}=${t.def || ''}`).join('; ')}` : '',
    ctx?.crossRefs?.length ? `ССЫЛКИ: ${ctx.crossRefs.join('; ')}` : '',
  ].filter(Boolean).join('\n');

  const userPrompt = `${ctxBlock ? ctxBlock + '\n\n' : ''}ФРАГМЕНТ ДОКУМЕНТА:\n${chunkText}\n\nРЕЛЕВАНТНЫЕ СТАТЬИ НПА КР:\n${renderArticles(articles)}`;

  try {
    const raw = await clients.geminiJson({
      systemPrompt: VALIDATOR_SYS, userPrompt,
      model: 'gemini-3.1-flash-lite', maxOutputTokens: 1024, timeoutMs: 15000,
    });
    const parsed = safeJson(raw, null);
    if (!parsed || !parsed.verdict) return { verdict: 'clean', reason: '', cited_articles: [] };
    return {
      verdict: ['clean', 'warning', 'critical'].includes(parsed.verdict) ? parsed.verdict : 'clean',
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      cited_articles: Array.isArray(parsed.cited_articles) ? parsed.cited_articles : [],
    };
  } catch (_) {
    return { verdict: 'clean', reason: '', cited_articles: [] };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ФАЗА 4 — Финальный Судья (DeepSeek reasoner, Pure Synthesizer)
// ═══════════════════════════════════════════════════════════════════════
const JUDGE_SYS = `Ты — Финальный Судья (Pure Synthesizer) юридического аудита по праву Кыргызской Республики.
Тебе дан Граф Нарушений — массив вердиктов агентов-валидаторов. Твоя задача — СВЕСТИ их в отчёт для юриста.

ЛОГИЧЕСКИЙ АУДИТ (обязательно):
- Если вердикт "critical"/"warning", но cited_articles ПУСТ — переквалифицируй риск в статус
  «⚠️ Требует внимания юриста (Слепая зона)»: статья не подтверждена базой, нужна ручная проверка.
- Не выдумывай новые риски и номера статей. Опирайся ТОЛЬКО на Граф.

ФОРМАТ ОТВЕТА — строго 2 секции, без преамбул:
## Краткий вывод
<2-4 предложения: общая оценка документа и главный вывод>

## Ключевые риски
<нумерованный список: каждый риск — суть + статья (или пометка «Слепая зона») + почему важно>

ЗАПРЕТЫ: вода, стилистические советы, «общие рекомендации», упоминание чанков/индексов/технических деталей.`;

async function judge({ graph, effort }) {
  // Передаём только рискованные вердикты — clean Судье не нужны.
  const risks = (graph || []).filter((g) => g.verdict === 'critical' || g.verdict === 'warning');
  const payload = risks.map((r, i) => ({
    n: i + 1,
    verdict: r.verdict,
    reason: r.reason,
    cited_articles: r.cited_articles,
    blind_spot: r.blind_spot,
  }));

  const userPrompt = `ГРАФ НАРУШЕНИЙ (JSON):\n${JSON.stringify(payload, null, 2)}\n\nВсего рисков: ${risks.length}. Сформируй отчёт по формату.`;

  try {
    const { text, model } = await clients.deepseekReason({
      systemPrompt: JUDGE_SYS, userPrompt, reasoning_effort: effort,
    });
    return { summary: text, model, risks: payload };
  } catch (err) {
    return { summary: `Не удалось сформировать итог: ${err.message}`, model: 'error', risks: payload };
  }
}

function createDefaultDeps() {
  return { extractGlossary, expandQuery, pineconeSearch, validate, judge };
}

module.exports = {
  createDefaultDeps,
  extractGlossary, expandQuery, pineconeSearch, validate, judge,
  _internals: { safeJson, renderArticles },
};
