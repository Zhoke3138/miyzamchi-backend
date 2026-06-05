'use strict';
/**
 * Miyzamchi 2.0 — Боевые агенты Map-Reduce RAG (для analyzeV2)
 * ================================================================
 * extractGlossary  — LLM-экстрактор словаря терминов + кросс-ссылок + шапки
 * expandQuery      — Agent 1 (Extractor&Searcher): извлекает {npa, article, queries} за 1 вызов
 * pineconeSearch   — поиск с ЖЁСТКОЙ привязкой к НПА (фильтр + soft-fallback)
 * validate         — Agent 2 (Checker): нормоконтроль -> { status, marker, detail, cited_articles }
 * judge            — Agent 3 (Final Judge): синтез, ГРУППИРОВКА ПО НПА, дедуп
 *
 * Все модели и ключи берутся из .env через services/llmClients.
 */

const clients = require('./llmClients');
const { normalizeNpaName, getDbExactName } = require('../lib/npaAliases');

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
// AGENT 1 — Extractor & Searcher (извлечение НПА/статьи + синонимы за 1 вызов)
// ═══════════════════════════════════════════════════════════════════════
const EXPAND_SYS = `Ты — экстрактор и поисковик для базы законов Кыргызской Республики.
Из ОДНОГО фрагмента документа извлеки нормативную привязку и собери поисковые запросы.
Верни СТРОГО JSON:
{ "npa": "<полное название НПА или null>",
  "article": "<номер статьи из текста или null>",
  "queries": ["<запрос 1>", "<запрос 2>", "<запрос 3>"] }

ПРАВИЛА:
- npa: если в тексте упомянут/применим нормативный акт (Конституция КР, УК КР, ГК КР, Трудовой кодекс и т.п.) —
  верни его ПОЛНОЕ официальное название, раскрывая аббревиатуры (ГК КР → Гражданский кодекс Кыргызской Республики).
  Если конкретный акт не упомянут и не очевиден — null.
- article: номер статьи, если он назван в тексте (например "57"), иначе null.
- queries: 2-4 запроса — юридические формулировки сути фрагмента. Если npa определён,
  ОБЯЗАТЕЛЬНО включай его название в КАЖДЫЙ запрос (маршрутизирует поиск в нужный акт).
- Без markdown — только JSON.`;

async function expandQuery(chunkText) {
  const fallback = { npa: null, article: null, queries: [String(chunkText || '').slice(0, 1500)] };
  try {
    const raw = await clients.geminiJson({
      systemPrompt: EXPAND_SYS,
      userPrompt: `ФРАГМЕНТ:\n${(chunkText || '').slice(0, 3000)}`,
      model: 'gemini-3.1-flash-lite', maxOutputTokens: 512, timeoutMs: 10000,
    });
    const parsed = safeJson(raw, {});
    const queries = Array.isArray(parsed.queries) ? parsed.queries.filter(Boolean).slice(0, 4) : [];
    return {
      npa: parsed.npa && String(parsed.npa).trim() ? String(parsed.npa).trim() : null,
      article: parsed.article && String(parsed.article).trim() ? String(parsed.article).trim() : null,
      queries: queries.length ? queries : fallback.queries,
    };
  } catch (_) {
    return fallback;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Pinecone search — ЖЁСТКАЯ привязка к НПА (фильтр) + soft-fallback
// ═══════════════════════════════════════════════════════════════════════
// topKPerQuery=10: берём «шире» эталон (соседние абзацы), чтобы продолжение нормы
// (напр. лимит «не более 25%») не терялось на стыке чанков → меньше False Positives.
async function pineconeSearch(queries, npa = null, topKPerQuery = 10) {
  // ТОЧНАЯ строка npa_title из базы (а не короткая каноническая) — иначе $eq не сматчит.
  // Если точная строка неизвестна → exact=null → фильтр не ставим (чистый вектор).
  const exact = npa ? getDbExactName(npa) : null;
  const filter = exact ? { npa_title: { $eq: exact } } : null;

  // Один прогон по всем запросам (с фильтром или без), merge по id с max score.
  async function run(useFilter) {
    const byId = new Map();
    for (const q of queries) {
      let matches = [];
      try {
        const vector = await clients.getEmbedding(q);
        matches = await clients.queryPinecone(vector, topKPerQuery, useFilter ? filter : null);
      } catch (_) {
        matches = []; // graceful: один промах не валит весь поиск
      }
      for (const m of matches) {
        const prev = byId.get(m.id);
        if (!prev || m.score > prev.score) byId.set(m.id, m);
      }
    }
    return Array.from(byId.values()).sort((a, b) => b.score - a.score);
  }

  let hits = await run(!!filter);

  // Soft-fallback: фильтр дал 0 (точная строка всё ещё не совпала) → чистый вектор.
  if (filter && hits.length === 0) {
    console.warn(`[Pinecone] фильтр npa_title="${exact}" → 0 результатов, fallback на чистый семантический поиск`);
    hits = await run(false);
  }

  // DEBUG (временно): сверяем формат npa_title в базе с тем, что мы ищем.
  if (hits.length) {
    console.log('[Pinecone DEBUG] npa_title[0] в базе =', JSON.stringify(hits[0].metadata && hits[0].metadata.npa_title),
      '| искали (exact) =', JSON.stringify(exact), '| npa(raw) =', JSON.stringify(npa));
  }

  // «Сырые» hits; двухступенчатый score-фильтр применит роут (twoStagePineconeFilter).
  return hits;
}

// ═══════════════════════════════════════════════════════════════════════
// AGENT 2 — Checker (нормоконтроль: точность цитирования) -> ✅/🔴
// ═══════════════════════════════════════════════════════════════════════
const VALIDATOR_SYS = `Ты — инспектор нормоконтроля по праву Кыргызской Республики.
Тебе дан ФРАГМЕНТ документа пользователя и ЭТАЛОННЫЙ текст закона из базы (RAG).
Сравни текст пользователя с эталоном. Твоя задача — проверить ТОЧНОСТЬ ЦИТИРОВАНИЯ:
номера статей, номера частей/пунктов и сами формулировки нормы.

Верни СТРОГО JSON:
{ "status": "correct" | "error" | "out_of_base",
  "marker": "✅ Верно" | "🔴 ОШИБКА" | "⚠️ Вне базы",
  "detail": "<если error: что не так и как исправить; если out_of_base: название акта; если correct: пусто>",
  "cited_articles": ["<НПА, ст.N из эталона>"] }

ПРЕЗУМПЦИЯ НЕВИНОВНОСТИ ТЕКСТА (защита от ложных срабатываний — ВАЖНО):
- Ты получаешь лишь ВЫДЕРЖКИ (чанки) из векторной базы. Текст эталона может быть ОБОРВАН.
- Если в тексте пользователя есть детали (лимиты пени, сроки, доп. условия), которых ПРОСТО НЕТ
  в предоставленном тебе куске эталона, НО они прямо ему НЕ противоречат — это НЕ ошибка.
  В таких случаях возвращай status:"correct".
- status:"error" применяй ТОЛЬКО при ПРЯМОМ противоречии (в законе 5%, а у пользователя 10%;
  или ссылка на ст.56 вместо ст.57). Отсутствие детали в твоём коротком эталоне ошибкой НЕ является.

ЖЕЛЕЗНЫЕ ПРАВИЛА:
1. Опирайся ТОЛЬКО на эталонный текст из базы. Запрещено придумывать номера/тексты статей по памяти.
2. Если пользователь перепутал номер статьи (например, указал ст.56 вместо ст.57), перепутал
   часть/пункт или исказил формулировку — это status:"error", marker:"🔴 ОШИБКА".
3. detail при ошибке — чётко: «указано X, верно Y» + как исправить.
4. Если цитирование точное — status:"correct", marker:"✅ Верно", detail пустой.
5. cited_articles — только статьи из предоставленного эталона.
6. МЕЖДУНАРОДНЫЕ АКТЫ: если в тексте ссылка на международный акт (например «Конвенция ООН»,
   «Международный пакт», «Всеобщая декларация»), которого НЕТ в эталонном тексте из базы —
   это НЕ ошибка. Верни status:"out_of_base", marker:"⚠️ Вне базы",
   detail:"Международный акт (<название>). Требуется ручная проверка юриста".
   НИКОГДА не помечай отсутствие международного акта в базе как 🔴 ОШИБКА.
7. Без markdown — только JSON.`;

function renderArticles(articles) {
  if (!articles || !articles.length) return '(релевантных статей из базы не найдено)';
  return articles.map((a, i) => {
    const md = a.metadata || {};
    const title = [md.npa_title, md.article_title].filter(Boolean).join(' — ');
    return `[${i + 1}] ${title}\n${(md.full_text || '').slice(0, 1500)}`;
  }).join('\n\n');
}

async function validate({ chunkText, ctx, articles, npa, article }) {
  const ctxBlock = [
    ctx?.header ? `ШАПКА: ${ctx.header}` : '',
    ctx?.relevantTerms?.length ? `ТЕРМИНЫ: ${ctx.relevantTerms.map((t) => `${t.term}=${t.def || ''}`).join('; ')}` : '',
    ctx?.crossRefs?.length ? `ССЫЛКИ: ${ctx.crossRefs.join('; ')}` : '',
  ].filter(Boolean).join('\n');

  // Заявленная пользователем ссылка — чтобы Checker точечно сверил номер/часть.
  const claim = (npa || article)
    ? `ЗАЯВЛЕННАЯ ССЫЛКА В ТЕКСТЕ: ${[npa, article ? `ст.${article}` : ''].filter(Boolean).join(', ')}\n`
    : '';

  const userPrompt = `${ctxBlock ? ctxBlock + '\n\n' : ''}${claim}ФРАГМЕНТ ДОКУМЕНТА:\n${chunkText}\n\nЭТАЛОННЫЙ ТЕКСТ ЗАКОНА (из базы НПА КР):\n${renderArticles(articles)}`;

  const ok = { status: 'correct', marker: '✅ Верно', detail: '', cited_articles: [] };
  try {
    const raw = await clients.geminiJson({
      systemPrompt: VALIDATOR_SYS, userPrompt,
      model: 'gemini-3.1-flash-lite', maxOutputTokens: 1024, timeoutMs: 15000,
    });
    const parsed = safeJson(raw, null);
    if (!parsed || !parsed.status) return ok;
    const status = parsed.status === 'error' ? 'error'
      : parsed.status === 'out_of_base' ? 'out_of_base'
        : 'correct';
    const marker = status === 'error' ? '🔴 ОШИБКА'
      : status === 'out_of_base' ? '⚠️ Вне базы'
        : '✅ Верно';
    return {
      status,
      marker,
      detail: typeof parsed.detail === 'string' ? parsed.detail : '',
      cited_articles: Array.isArray(parsed.cited_articles) ? parsed.cited_articles : [],
    };
  } catch (_) {
    return ok; // graceful: при сбое не плодим ложных ошибок
  }
}

// ═══════════════════════════════════════════════════════════════════════
// AGENT 3 — Final Judge (синтез, ГРУППИРОВКА ПО НПА, дедуп)
// ═══════════════════════════════════════════════════════════════════════
const JUDGE_SYS = `Ты — Старший партнёр юридической фирмы (право Кыргызской Республики).
Тебе дан структурированный отчёт младших юристов — результаты нормоконтроля, СГРУППИРОВАННЫЕ ПО НПА.
Составь финальный отчёт для клиента.

ПРАВИЛА:
- Иди по группам НПА. Заголовок секции: "## Анализ: <название НПА>"
  (например "## Анализ нарушений Конституции КР", "## Анализ УК КР").
- Внутри секции — список пунктов. КАЖДЫЙ пункт начинается с маркера 🔴 ОШИБКА.
- Для каждого пункта сделай КОРОТКИЙ осмысленный заголовок (до 5-7 слов) жирным, затем суть и как исправить.
- Убери ДУБЛИРУЮЩИЕСЯ ошибки (одна и та же ошибка из разных фрагментов — один пункт).
- Не выдумывай новых ошибок и номеров статей — опирайся ТОЛЬКО на отчёт.
- Блок blind_spots (маркеры ⚠️ Слепая зона / ⚠️ Вне базы, в т.ч. международные акты — Конвенция ООН,
  Международный пакт, Всеобщая декларация) — это НЕ ошибки. Вынеси их ОТДЕЛЬНОЙ секцией в конце
  "## ⚠️ Требуется ручная проверка": перечисли акт и пометь, что его нет в базе и нужна проверка юристом.
  НИКОГДА не помечай эти пункты как 🔴 ОШИБКА.
- ОБЯЗАТЕЛЬНАЯ финальная секция "## ✅ Подтвержденные нормы и утверждения" (данные из confirmed) —
  показывает юристу проделанную работу. Выводи СПИСКОМ, каждый пункт с новой строки "- ":
  • если есть npa И article → компактно: "- <npa>, ст. <article> — процитировано верно."
    (пример: "- УК КР, ст. 191 — процитировано верно.")
  • если article/npa отсутствуют → сделай КРАТКУЮ выжимку тезиса (до 5-7 слов) из поля thesis:
    "- <выжимка> — верно по смыслу." (пример: "- Утверждение о сроках задержания — верно по смыслу.")
  Не дублируй пункты. Если confirmed пуст — секцию опусти.
- Если ошибок и ручной проверки нет (только confirmed) — начни с "✅ Существенных ошибок цитирования не выявлено.",
  затем выведи секцию подтверждённых норм.

ЗАПРЕТЫ: вода, общие рекомендации, упоминание фрагментов/индексов/технических деталей.`;

// Предгруппировка в Node: группируем проверенные чанки по НПА перед подачей Судье.
function groupByNpa(graph) {
  const byNpa = new Map();
  const blind = [];
  const confirmed = [];
  for (const g of (graph || [])) {
    // Слепые зоны и международные акты «вне базы» → блок ручной проверки, НЕ ошибки.
    if (g.blind_spot || g.status === 'unverified' || g.status === 'out_of_base') { blind.push(g); continue; }
    if (g.status === 'error') {
      const key = g.npa ? normalizeNpaName(g.npa) : 'Прочие нормы';
      if (!byNpa.has(key)) byNpa.set(key, []);
      byNpa.get(key).push(g);
    } else if (g.status === 'correct' && (g.npa || g.article || (g.cited_articles && g.cited_articles.length))) {
      // ✅ Верно: показываем юристу проделанную работу. Пустые boilerplate-чанки
      // (без НПА/статьи/подтверждённых статей) НЕ включаем — чтобы не зашумлять отчёт.
      confirmed.push({
        npa: g.npa || null,
        article: g.article || null,
        cited_articles: g.cited_articles || [],
        thesis: g.thesis || '',
      });
    }
  }
  const groups = Array.from(byNpa.entries()).map(([npaName, items]) => ({
    npa: npaName,
    errors: items.map((it) => ({
      article: it.article || null,
      detail: it.detail || '',
      cited_articles: it.cited_articles || [],
    })),
  }));
  const blind_spots = blind.map((b) => ({
    npa: b.npa || null, article: b.article || null,
    marker: b.marker || (b.status === 'out_of_base' ? '⚠️ Вне базы' : '⚠️ Слепая зона'),
    hint: b.detail || 'ссылка не подтверждена базой НПА — нужна ручная проверка',
  }));
  return { groups, blind_spots, confirmed };
}

async function judge({ graph, effort }) {
  const { groups, blind_spots, confirmed } = groupByNpa(graph);

  // Совсем пустой граф — без вызова LLM (экономия).
  if (groups.length === 0 && blind_spots.length === 0 && confirmed.length === 0) {
    return {
      summary: '✅ Документ прошёл нормоконтроль. Существенных ошибок цитирования не выявлено.',
      model: 'skip', groups, blind_spots, confirmed,
    };
  }

  const userPrompt = `СТРУКТУРИРОВАННЫЙ ОТЧЁТ (errors сгруппированы по НПА, плюс blind_spots и confirmed):\n${JSON.stringify({ groups, blind_spots, confirmed }, null, 2)}\n\nСформируй финальный отчёт по формату: ошибки по НПА, ручная проверка, и секция подтверждённых норм.`;

  try {
    const { text, model } = await clients.deepseekReason({
      systemPrompt: JUDGE_SYS, userPrompt, reasoning_effort: effort,
    });
    return { summary: text, model, groups, blind_spots, confirmed };
  } catch (err) {
    return { summary: `Не удалось сформировать итог: ${err.message}`, model: 'error', groups, blind_spots, confirmed };
  }
}

function createDefaultDeps() {
  return { extractGlossary, expandQuery, pineconeSearch, validate, judge };
}

module.exports = {
  createDefaultDeps,
  extractGlossary, expandQuery, pineconeSearch, validate, judge,
  _internals: { safeJson, renderArticles, groupByNpa },
};
