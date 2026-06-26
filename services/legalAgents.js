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
const { normalizeNpaName, getDbExactName, CANONICAL_NPAS } = require('../lib/npaAliases');
const { searchSupabase } = require('./supabaseService');

// ═══════════════════════════════════════════════════════════════════════
// Авто-обнаружение точных DB-названий НПА из результатов Pinecone
// ═══════════════════════════════════════════════════════════════════════
// Проблема: DB_EXACT_NAMES содержит лишь 4 захардкоженных НПА. Для остальных
// (ГК КР, ТК КР, СК КР и т.д.) Pinecone-фильтр не применялся → полный скан
// индекса → случайные нерелевантные статьи в результатах.
//
// Решение: после каждого полного (без фильтра) поиска смотрим в hits.
// Если npa_title верхнего результата соответствует каноническому НПА —
// кешируем его и в следующий раз используем как $eq-фильтр.
// Кеш живёт в процессе (in-memory, между запросами одного сервера).

const _runtimeNpaCache = new Map();  // canonical → exact DB title

// Уникальные ключевые слова каждого канонического НПА в Pinecone.
// Слова выбраны так, чтобы не пересекаться с похожими законами.
const _NPA_KEYWORDS = (() => {
  const map = new Map();
  for (const { canonical, aliases } of CANONICAL_NPAS) {
    // Ищем самый длинный алиас (наиболее полное название)
    const full = [...aliases].sort((a, b) => b.length - a.length)[0] || canonical;
    // Убираем служебные слова — остаются уникальные содержательные
    const STOP = new Set(['кр', 'кыргызской', 'республики', 'кыргызстана', 'кодекс',
      'закон', 'закона', 'законом', 'республика', 'введен', 'действие', 'года', 'и', 'о', 'об']);
    const words = full.toLowerCase().split(/[\s\-()]+/).filter(w => w.length >= 4 && !STOP.has(w));
    if (words.length) map.set(canonical, words);
  }
  return map;
})();

// Уточняющие негативные слова для disambiguation (ГК vs ГПК, УК vs УПК)
const _NPA_EXCLUDE = new Map([
  ['ГК КР', ['процессуальный']],
  ['УК КР', ['процессуальный', 'исполнительный']],
]);

function _matchDbTitle(canonical, dbTitle) {
  const db = dbTitle.toLowerCase();
  const words = _NPA_KEYWORDS.get(canonical);
  if (!words || !words.length) return false;
  if (!words.every(w => db.includes(w))) return false;
  const excludes = _NPA_EXCLUDE.get(canonical) || [];
  return !excludes.some(w => db.includes(w));
}

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
// FRAGMENTER — семантическая нарезка КОРОТКОГО документа (лёгкий путь, без Docling)
// ═══════════════════════════════════════════════════════════════════════
const FRAGMENT_SYS = `Ты — сегментатор юридических документов Кыргызстана. Тебе дан КОРОТКИЙ документ (≤3 страниц).
СНАЧАЛА в поле "reasoning" коротко проанализируй структуру документа: где преамбула/реквизиты,
где содержательная часть (права, обязанности, нормы), где просительная/резолютивная часть.
ЗАТЕМ нарежь документ на СМЫСЛОВЫЕ самостоятельные фрагменты: один фрагмент = один тезис/пункт/норма,
пригодный для отдельной проверки. Не дроби предложения и не склеивай разные нормы.
Верни СТРОГО JSON: { "reasoning": "<анализ структуры, 1-3 предложения>", "fragments": ["...", "..."] }`;

// Нативный thinking (если SDK/модель поддержат) + prompt-level CoT (поле reasoning).
// Если thinkingConfig вызовет ошибку — авто-повтор без него (prompt-CoT всё равно работает).
async function fragmentDocument(text) {
  const src = String(text || '').trim();
  if (!src) return [];

  // thinkingBudget убран — prompt-level CoT через поле "reasoning" в JSON достаточно.
  // Нативный thinkingBudget добавлял 4-6с задержки без заметного выигрыша в качестве нарезки.
  try {
    const raw = await clients.geminiJson({
      systemPrompt: FRAGMENT_SYS,
      userPrompt: `ДОКУМЕНТ:\n${src.slice(0, 16000)}`,
      model: 'gemini-3.1-flash-lite',
      maxOutputTokens: 4096,
      timeoutMs: 25000,
    });
    const parsed = safeJson(raw, {});
    if (parsed.reasoning) {
      console.log('[Gemini DEBUG] fragment reasoning:', String(parsed.reasoning).slice(0, 400));
    }
    return Array.isArray(parsed.fragments)
      ? parsed.fragments.map((f) => String(f || '').trim()).filter(Boolean)
      : [];
  } catch (_e) {
    return [];
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
// Supabase search — замена Pinecone, тот же интерфейс (queries[], npa, topK)
// ═══════════════════════════════════════════════════════════════════════
// ВАЖНО: Supabase индексирован через gemini-embedding-2 (1536d).
// getEmbeddingForSupabase использует ту же модель — без неё совпадений ноль.
async function pineconeSearch(queries, npa = null, topKPerQuery = 10) {
  const allMatches = await Promise.all(queries.map(async (q) => {
    try {
      const vector = await clients.getEmbeddingForSupabase(q);
      return await searchSupabase(vector, q, topKPerQuery);
    } catch (_) {
      return []; // graceful: один промах не валит весь поиск
    }
  }));
  const byId = new Map();
  for (const matches of allMatches) {
    for (const m of matches) {
      const prev = byId.get(m.id);
      if (!prev || m.score > prev.score) byId.set(m.id, m);
    }
  }
  return Array.from(byId.values()).sort((a, b) => b.score - a.score);
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
7. СТАТЬИ-ПРИНЦИПЫ (ключевая защита от ложных срабатываний):
   Ряд статей закрепляет ОБЩИЕ ПРИНЦИПЫ права: гуманизм, законность, справедливость,
   равенство, презумпция невиновности, достоинство личности, запрет жестокого обращения.
   Пользователь ВПРАВЕ ссылаться на такую статью в более широком контексте, чем её буквальный
   текст, если ссылка обоснована тематически.
   ПРИМЕРЫ корректного применения принципов — НЕ ошибка:
   • ст. 9 УК КР «Гуманизм» → обоснование запрета пыток / жестокого обращения;
   • ст. 4 УК КР «Законность» → обоснование незаконности задержания;
   • ст. 3 Конституции КР «Народный суверенитет» → обоснование нарушения прав граждан.
   НЕ помечай как ошибку цитирование статьи-принципа, если смысл применения СМЕЖЕН
   содержанию статьи (связан с тем же правовым полем). status:"error" — ТОЛЬКО при ПРЯМОМ
   противоречии: неверный номер, неверный НПА, или утверждение прямо ПРОТИВОПОЛОЖНОГО смысла.
8. Без markdown — только JSON.`;

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
    // Super Doc sticky local context (раздел + активный НПА блока) — первым,
    // чтобы Checker приоритезировал нужный кодекс и отсекал false-positive из
    // соседних НПА (Orphan Chunks). Пусто, если контекст не прокинут.
    ctx?.localContextBlock ? ctx.localContextBlock : '',
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
- ОБЯЗАТЕЛЬНАЯ финальная секция "## ✅ Применимые нормы (проверено)" (данные из confirmed) —
  показывает юристу какие нормы система проверила и подтвердила как соответствующие содержанию документа.
  ВАЖНО: эти статьи нашла СИСТЕМА через поиск по законодательству — автор документа мог их НЕ ЦИТИРОВАТЬ сам.
  Выводи СПИСКОМ, каждый пункт с новой строки "- ":
  • если есть npa И article → компактно: "- <npa>, ст. <article> — <краткая тема> — соответствует закону."
    (пример: "- УК КР, ст. 191 — самоуправство — соответствует закону.")
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

// model + thinking приходят от роутера analyzeV2 (pickJudgeRoute):
//   лёгкий док → deepseek-v4-flash / 'low' / thinking 'disabled';
//   тяжёлый    → deepseek-v4-pro  / 'high'|'max' / thinking 'enabled'.
async function judge({ graph, effort, model = 'deepseek-v4-pro', thinking = 'enabled', onDelta = null }) {
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
    const { text, model: usedModel } = await clients.deepseekReason({
      systemPrompt: JUDGE_SYS, userPrompt, reasoning_effort: effort, model, thinking, onDelta,
    });
    return { summary: text, model: usedModel, groups, blind_spots, confirmed };
  } catch (err) {
    return { summary: `Не удалось сформировать итог: ${err.message}`, model: 'error', groups, blind_spots, confirmed };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ФАЗА 2.0 — TRIAGE: правовой фрагмент vs технический (Backend Pivot Этап 3)
// ═══════════════════════════════════════════════════════════════════════
// LEGAL     → полный путь expandQuery → pineconeSearch → validate (RAG/Pinecone).
// TECHNICAL → лёгкий spellCheck без поиска по базе (экономим векторные запросы
//             и токены, технический шум не засоряет RAG-отчёт).

// Быстрая regex-эвристика (0 токенов). 'LEGAL' | 'TECHNICAL' | null (→ LLM).
const LEGAL_MARKERS = /(ст\.?\s*\d|стать[яеи]|закон|кодекс|конституц|постановлени|указ|договор|обязан|вправе|ответственн|неустойк|штраф|пеня|санкци|части?\s+\d|пункт\s+\d|в\s+соответствии|согласно|настоящ|сторон[аы]|истец|ответчик|потерпевш|обвиня|\bУК\b|\bГК\b|\bТК\b|\bУПК\b|\bГПК\b|\bНК\b|КоАП)/i;
function quickTriage(text) {
  const t = String(text || '').trim();
  if (!t) return 'TECHNICAL';
  if (LEGAL_MARKERS.test(t)) return 'LEGAL';
  if (t.length < 60) return 'TECHNICAL';   // короткий структурный фрагмент без правовых маркеров
  return null;                              // неясно → решит LLM
}

const TRIAGE_SYS = `Ты — сортировщик фрагментов юридического документа (Кыргызстан).
Определи тип фрагмента:
- "LEGAL" — содержит правовую норму, ссылку на закон/статью, обязательство, условие договора или правовую квалификацию (то, что нужно сверять с законодательством).
- "TECHNICAL" — служебное/не-правовое: шапка, адресат, дата, номер, реквизиты, подпись, заголовок, форматирование, бытовой текст без правового смысла.
Ответ СТРОГО JSON: {"type":"LEGAL"} или {"type":"TECHNICAL"}.`;

async function triageChunk(chunkText) {
  // LLM-вызов убран: regex quickTriage ловит 95%+ случаев.
  // Нечёткие блоки (≥60 симв., без маркеров) → LEGAL по умолчанию.
  // Fail-safe «лучше лишний RAG» применяется сразу, без 2-4с задержки.
  return quickTriage(chunkText) || 'LEGAL';
}

// ═══════════════════════════════════════════════════════════════════════
// SPELL-CHECKER — лёгкая проверка технических фрагментов БЕЗ Pinecone
// ═══════════════════════════════════════════════════════════════════════
const SPELLCHECK_SYS = `Ты — корректор юридических документов (русский язык, Кыргызстан).
Проверь фрагмент ТОЛЬКО на: орфографию, грамматику, пунктуацию, опечатки, явные
ошибки в числах/датах/реквизитах и форматировании. НЕ оценивай правовое содержание.
Ответ СТРОГО JSON:
{"status":"correct"} — если ошибок нет;
{"status":"error","detail":"<что исправить, кратко>"} — если есть опечатки/ошибки.`;

async function spellCheck(chunkText) {
  const ok = { status: 'correct', marker: '✅ Верно', detail: '', cited_articles: [] };
  try {
    const raw = await clients.geminiJson({
      systemPrompt: SPELLCHECK_SYS,
      userPrompt: `ФРАГМЕНТ:\n${String(chunkText).slice(0, 2000)}`,
      model: 'gemini-3.1-flash-lite', maxOutputTokens: 256, timeoutMs: 12000,
    });
    const parsed = safeJson(raw, null);
    if (!parsed || parsed.status !== 'error' || !parsed.detail) return ok;
    // status 'grammar' — отдельная категория: видна в таблице, НЕ идёт в отчёт Судьи.
    return { status: 'grammar', marker: '✏️ Опечатка/оформление', detail: String(parsed.detail).slice(0, 200), cited_articles: [] };
  } catch (_) {
    return ok;   // graceful: при сбое не плодим ложных ошибок
  }
}

function createDefaultDeps() {
  return { extractGlossary, fragmentDocument, expandQuery, pineconeSearch, validate, judge, triageChunk, spellCheck };
}

module.exports = {
  createDefaultDeps,
  extractGlossary, fragmentDocument, expandQuery, pineconeSearch, validate, judge, triageChunk, spellCheck,
  _internals: { safeJson, renderArticles, groupByNpa, quickTriage },
};
