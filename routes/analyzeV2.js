'use strict';
/**
 * Miyzamchi 2.0 — /api/analyze-document (Stateful Multi-Agent RAG)
 * ===============================================================
 * ОРКЕСТРАТОР-КАРКАС. Связывает 3 фазы ТЗ. Места, помеченные [INTEGRATE],
 * подключаются к существующим lib/-модулям (Pinecone, Gemini-экстрактор, DeepSeek).
 * SSE-контракт совместим с фронтом: step / tableRow / metadata / [DONE].
 *
 * Поток:
 *   upload (multer -> /tmp)
 *     Фаза 1: extractMarkdown (Cloud Run/локально) -> chunking -> GlobalState
 *     Фаза 2: runInWaves(validateChunk) — Smart State Injection + Pinecone + Валидатор
 *     Фаза 3: deepseek-reasoner (динамический reasoning_effort) -> метрики -> отчёт
 */

const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { runInWaves } = require('../lib/waveThrottle');
const { normalizeNpaName } = require('../lib/npaAliases');

// ── Super Doc (Шаг 1): семантическая нарезка вместо «доклайна» ──────────────
const { createHybridSegmenter } = require('../lib/hybridSegmenter');
const { createLightLLMCascade } = require('../lib/llmCascade');
const { buildChunkContexts, buildLocalContextBlock } = require('../lib/localContext');
const { buildSuperDocBlocks } = require('../lib/superDocBlocks');
const { buildDocx } = require('../lib/docxGenerator');
const clients = require('../services/llmClients');
const { getTemplate, buildChecklist } = require('../lib/docTemplates');

// ── Токенометрия (SSE-телеметрия) ─────────────────────────────────────────────
// Цены совпадают с MODEL_PRICING в server.js. Актуально на 2026-06-25.
const MODEL_PRICING_V2 = {
  'gemini-3.1-flash-lite': { input: 0.25,  output: 1.50 },
  'gemini-2.5-flash':      { input: 0.30,  output: 2.50 },
  'deepseek-v4-flash':     { input: 0.14,  output: 0.28 },
  'deepseek-v4-pro':       { input: 0.435, output: 0.87 },
};
function calcCostV2(model, inp, out) {
  const r = MODEL_PRICING_V2[String(model).replace(/^models\//, '')] || { input: 0, output: 0 };
  return Number(((inp / 1e6) * r.input + (out / 1e6) * r.output).toFixed(6));
}
function emitTele(res, { model, inputTokens, outputTokens, label }) {
  if (!res || res.writableEnded || !(inputTokens || outputTokens)) return;
  try {
    res.write(`data: ${JSON.stringify({ telemetry: {
      model, label,
      inputTokens, outputTokens,
      totalTokens: inputTokens + outputTokens,
      cost: calcCostV2(model, inputTokens, outputTokens),
    } })}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  } catch (_) {}
}

// Загрузка во ВРЕМЕННЫЙ файл с уникальным именем (ZDR-friendly: parserService удалит).
// multer/express подключаются ЛЕНИВО внутри фабрики — чтобы импорт чистых функций
// (_internals) в smoke-тестах не тянул web-зависимости.
function makeUpload(multer) {
  return multer({
    storage: multer.diskStorage({
      destination: os.tmpdir(),
      filename: (_req, file, cb) =>
        cb(null, `${crypto.randomUUID()}${path.extname(file.originalname) || '.bin'}`),
    }),
    limits: { fileSize: 25 * 1024 * 1024 }, // 25MB — синхронно с лимитом микросервиса
  });
}

// ---------------------------------------------------------------------------
// ФАЗА 1: Super Doc — семантическая ИИ-нарезка (Шаг 1, 2026-06-16)
// ---------------------------------------------------------------------------
// Убит «доклайн» (старые chunkFlat по 1200 симв. + chunkByHeadings по '##'):
// он рвал статьи/пункты посередине. Теперь нарезает lib/hybridSegmenter:
//   • Layer A — детерминированная structure-aware нарезка (lossless, ~200мс):
//     section-heading как префикс, «intro: + список» в одном блоке, склейка
//     subheading-пар, post-merge мелкой шапки/подписей.
//   • Layer B — точечный ИИ-корректор на Flash-Lite каскаде, поднимается
//     quality-gate'ом ТОЛЬКО на проблемных зонах (GIANT/TOO_MANY_SMALL/...).
// На выходе — string[] (raw текст, lossless) + параллельный chunkContexts[]
// (sticky «раздел + активный НПА» на каждый блок) против Orphan Chunks в RAG.
// Общий Flash-Lite каскад: один на нарезку (Layer B) И на block-classifier
// (Шаг 2). Ленивый синглтон, чтобы не пересобирать на каждый запрос.
let _cascade = null;
let _cascadeBuilt = false;
function getCascade() {
  if (_cascadeBuilt) return _cascade;
  _cascadeBuilt = true;
  try {
    const deepseekKey = process.env.DEEPSEEK_API_KEY;
    // Tier 3 (DeepSeek) — крайний фолбэк каскада; конструктор требует функцию
    // даже если DeepSeek выключен. Почти всегда хватает Tier 1 (Flash-Lite).
    // Node 18+ имеет глобальный fetch (как в llmClients.js).
    const deepseekJsonCall = deepseekKey
      ? async ({ systemPrompt, userPrompt, model }) => {
          const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${deepseekKey}` },
            body: JSON.stringify({
              model: model || 'deepseek-v4-flash',
              messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
              response_format: { type: 'json_object' },
              temperature: 0.0, max_tokens: 8000,
            }),
          });
          if (!res.ok) throw new Error(`DeepSeek ${res.status}`);
          const data = await res.json();
          return data?.choices?.[0]?.message?.content || '';
        }
      : async () => { throw new Error('DEEPSEEK_API_KEY not set'); };
    _cascade = createLightLLMCascade({
      getNextKey: clients.getNextKey,
      deepseekJsonCall,
      deepseekEnabled: !!deepseekKey,
      logger: console,
    });
  } catch (e) {
    // Каскад не собрался → Layer A и эвристический классификатор работают без него.
    console.warn('[SuperDoc] cascade init failed, degraded mode:', e.message);
    _cascade = null;
  }
  return _cascade;
}

let _hybridSegmenter = null;
function getHybridSegmenter() {
  if (_hybridSegmenter) return _hybridSegmenter;
  _hybridSegmenter = createHybridSegmenter({ cascade: getCascade(), logger: console, layerBEnabled: true });
  return _hybridSegmenter;
}

/**
 * Сборка GlobalState. [INTEGRATE] LLM-экстрактор (gemini-3.1-flash-lite)
 * для словаря терминов и кросс-ссылок. Здесь — каркас структуры.
 */
async function buildGlobalState(markdown, chunks, structureConfidence, deps) {
  // [INTEGRATE]: const { terms, crossRefs, header } = await deps.extractGlossary(markdown);
  const { terms = {}, crossRefs = {}, header = '' } = (await deps.extractGlossary?.(markdown, chunks)) || {};
  return {
    header,                              // шапка документа
    terms,                               // { термин: определение }
    termKeys: new Set(Object.keys(terms).map((t) => t.toLowerCase())), // для O(1) пересечений
    crossRefs,                           // { 'п.5.1': 'текст пункта' }
    chunks,
    N: chunks.length,
    structureConfidence,
  };
}

// ---------------------------------------------------------------------------
// ФАЗА 2: Validation Pipeline
// ---------------------------------------------------------------------------
/**
 * Smart State Injection: подмешиваем к чанку шапку + кросс-ссылки + ТОЛЬКО
 * релевантные термины. Инженерное требование ТЗ — быстрый поиск пересечений
 * через Set (однословные термины), для фраз — substring.
 */
function buildInjectedContext(chunkText, state) {
  const lower = chunkText.toLowerCase();
  const relevant = [];
  for (const termKey of state.termKeys) {
    // ВАЖНО: JS '\b' работает только для ASCII и НЕ матчит кириллицу.
    // Проект целиком на кириллице → используем Unicode-границу (\p{L}\p{N}, флаг 'u').
    // Подходит и для однословных терминов, и для фраз ("договор поставки").
    const boundary = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(termKey)}(?![\\p{L}\\p{N}])`, 'u');
    if (boundary.test(lower)) {
      relevant.push(termKey);
    }
  }
  const refs = Object.entries(state.crossRefs)
    .filter(([key]) => lower.includes(key.toLowerCase()))
    .map(([key, val]) => `${key}: ${val}`);

  return {
    header: state.header,
    relevantTerms: relevant.map((k) => ({ term: k, def: state.terms[k] ?? state.terms[capitalize(k)] })),
    crossRefs: refs,
  };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// Чистка CJK-артефактов (DeepSeek иногда вставляет иероглифы в русский текст).
function cleanCjk(s) { return String(s == null ? '' : s).replace(/[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/g, ''); }
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// Автоматическая вставка spacer-разделителей между смысловыми секциями.
// Вставляет пустой блок ПЕРЕД каждым section_heading, demand_heading,
// attachment_heading, signature и requisites_table, если предыдущий блок
// сам не является spacer. Работает на финальном массиве блоков.
const SPACER_BEFORE_KINDS = new Set([
  'section_heading', 'demand_heading', 'attachment_heading', 'signature', 'requisites_table',
]);
const SPACER_AFTER_KINDS = new Set([
  'section_heading', 'demand_heading', 'attachment_heading',
]);
function injectSpacers(blocks) {
  const result = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const prev = result[result.length - 1];
    if (SPACER_BEFORE_KINDS.has(b.kind) && prev && prev.kind !== 'spacer') {
      result.push({ kind: 'spacer', runs: [] });
    }
    result.push(b);
    if (SPACER_AFTER_KINDS.has(b.kind)) {
      const next = blocks[i + 1];
      if (next && next.kind !== 'spacer') {
        result.push({ kind: 'spacer', runs: [] });
      }
    }
  }
  return result;
}

/**
 * Map-шаг: проверка одного чанка.
 *   1) Agent 1 (expandQuery) -> { npa, article, queries } за 1 вызов
 *   2) Поиск с жёсткой привязкой к НПА (soft-fallback) + score-фильтр
 *   3) Agent 2 (validate, нормоконтроль) -> { status, marker, detail, cited_articles }
 *
 * Вердикт-словарь: 'correct' (✅) | 'error' (🔴) | 'unverified' (⚠️ Слепая зона).
 */
async function validateChunk(chunkText, index, state, deps, meta = null) {
  // ── ФАЗА 2.0 — TRIAGE (Backend Pivot Этап 3) ──
  // Технические фрагменты (шапка, дата, реквизиты, опечатки) НЕ дёргают
  // Pinecone/RAG — уходят к лёгкому spell-checker'у. Экономия векторных
  // запросов + токенов; статус 'grammar' виден в таблице, но не в отчёте Судьи.
  const triageType = (await deps.triageChunk?.(chunkText)) || 'LEGAL';
  if (triageType === 'TECHNICAL') {
    const sc = (await deps.spellCheck?.(chunkText)) ||
      { status: 'correct', marker: '✅ Верно', detail: '', cited_articles: [] };
    return {
      index, npa: null, article: null,
      status: sc.status, marker: sc.marker, detail: sc.detail || '',
      cited_articles: [], blind_spot: false, triageType: 'TECHNICAL',
      thesis: String(chunkText || '').slice(0, 200),
    };
  }

  const ctx = buildInjectedContext(chunkText, state);
  // Super Doc: sticky local context (текущий раздел + активный НПА) от
  // hybridSegmenter. Прокидываем блок в Агента-валидатора — он приоритезирует
  // статьи нужного кодекса и режет false-positive из соседних НПА.
  if (meta) ctx.localContextBlock = buildLocalContextBlock(meta);

  // Шаг 3 — семантический lead-in: если блок помечен continues_prev, агент
  // получает последнее предложение предыдущего блока как КОНТЕКСТ. Кладём в
  // agentText (для expandQuery + Агента-валидатора). raw chunkText для
  // triage/отображения/вердикта НЕ трогаем — lossless и чистый display.
  const leadIn = (meta && meta.leadIn) ? String(meta.leadIn) : '';
  const agentText = leadIn ? `[Контекст предыдущего блока: ${leadIn}]\n${chunkText}` : chunkText;

  // Agent 1: НПА + статья + синонимы (по обогащённому тексту — lead-in помогает
  // распознать кодекс в блоке-продолжении).
  const ex = (await deps.expandQuery?.(agentText)) || { npa: null, article: null, queries: [chunkText] };
  const queries = (Array.isArray(ex.queries) && ex.queries.length) ? ex.queries : [chunkText];

  // Привязка к НПА для поиска: если Агент-1 не распознал НПА в «голом» блоке
  // (Orphan Chunk — кодекс остался в предыдущем блоке), берём sticky-НПА из
  // контекста раздела. Только для retrieval-фильтра Pinecone — в отображаемый
  // вердикт sticky-НПА НЕ тащим (показываем лишь то, что блок реально цитирует).
  const searchNpa = ex.npa || (meta && meta.npa) || null;

  // Поиск с привязкой к НПА (фильтр внутри pineconeSearch) + двухступенчатый score-фильтр.
  const hits = (await deps.pineconeSearch?.(queries, searchNpa)) || [];
  const articles = twoStagePineconeFilter(hits);

  let v;
  if (articles.length === 0 && (ex.npa || ex.article)) {
    // Ссылка заявлена, но эталона в базе нет → Слепая зона (ручная проверка).
    v = { status: 'unverified', marker: '⚠️ Слепая зона', detail: 'Ссылка не подтверждена базой НПА — нужна ручная проверка', cited_articles: [] };
  } else if (articles.length === 0) {
    // Ни ссылки, ни эталона — проверять нечего.
    v = { status: 'correct', marker: '✅ Верно', detail: '', cited_articles: [] };
  } else {
    // Agent 2: нормоконтроль по эталону (получает agentText с lead-in).
    v = (await deps.validate?.({ chunkText: agentText, ctx, articles, npa: ex.npa, article: ex.article })) ||
        { status: 'correct', marker: '✅ Верно', detail: '', cited_articles: [] };
  }

  return {
    index,
    npa: ex.npa || null,
    article: ex.article || null,
    status: v.status,
    marker: v.marker,
    detail: v.detail || '',
    cited_articles: Array.isArray(v.cited_articles) ? v.cited_articles : [],
    // Слепая зона ИЛИ международный акт «вне базы» → в блок ручной проверки.
    blind_spot: v.status === 'unverified' || v.status === 'out_of_base',
    triageType: 'LEGAL',
    // Краткая формулировка сути фрагмента (для секции «✅ Подтверждённые», когда нет статьи).
    thesis: String((queries && queries[0]) || '').slice(0, 200),
  };
}

/** Двухступенчатый фильтр Pinecone. Пороги смягчены (защита от False Positives:
 *  ниже порог + шире хвост → в эталон попадают соседние абзацы/продолжение нормы). */
function twoStagePineconeFilter(hits, absThreshold = 0.65, tail = 0.25) {
  if (!hits.length) return [];
  const stage1 = hits.filter((h) => h.score >= absThreshold);
  if (!stage1.length) return [];
  const maxScore = Math.max(...stage1.map((h) => h.score));
  return stage1.filter((h) => h.score >= maxScore - tail);
}

// ---------------------------------------------------------------------------
// ФАЗА 3: Judgment (DeepSeek reasoner, динамический effort)
// ---------------------------------------------------------------------------
// ── 2026-06-19 Роутер Судьи — только по числу замечаний, thinking всегда ВЫКЛ ──
// thinking: 'enabled' убрано у обеих моделей — оно вызывало 30-60с паузу перед
// первым токеном. Судья — синтезатор готовых вердиктов, CoT ему не нужен.
//
// Шкала (issues = errorCount + blindSpotCount):
//   0-9  замечаний → deepseek-v4-flash, reasoning_effort: 'low'  (быстро)
//   10-40 замечаний → deepseek-v4-flash, reasoning_effort: 'medium'
//   >40  замечаний → deepseek-v4-pro,   reasoning_effort: 'high' (исключительный кейс)
//
// Длина документа и число НПА НЕ являются критерием выбора модели:
// длинный чистый договор на 60 страниц не нуждается в Pro.
function pickJudgeRoute({ errorCount = 0, blindSpotCount = 0, distinctNpaCount = 0, totalBlocks = 0 }) {
  const issues = errorCount + blindSpotCount;
  if (issues > 40) {
    return { tier: 'supreme', model: 'deepseek-v4-pro', reasoning_effort: 'high', thinking: 'disabled', name: 'DeepSeek v4 Pro' };
  }
  const effort = issues >= 10 ? 'medium' : 'low';
  return { tier: 'standard', model: 'deepseek-v4-flash', reasoning_effort: effort, thinking: 'disabled', name: 'DeepSeek v4 Flash' };
}

/** Метрики: confidenceScore = 1 - Слепые/N; purityIndex = 1 - Ошибки/N. */
function computeMetrics(graph, N) {
  const blind = graph.filter((g) => g.blind_spot).length;
  const errors = graph.filter((g) => g.status === 'error').length;
  const safeDiv = (x) => (N ? +(1 - x / N).toFixed(3) : 1);
  return { confidenceScore: safeDiv(blind), purityIndex: safeDiv(errors), blindSpots: blind, errors };
}

// ── Маппинг вердикта в формат фронта (SSE-контракт прода) ──────────────────
// Шаг thinking-box: correct→success, unverified→warning, error→error.
function toStepStatus(status) {
  if (status === 'error') return 'error';
  if (status === 'unverified' || status === 'out_of_base' || status === 'grammar') return 'warning';
  return 'success';
}

// Строка таблицы результатов. Статус UI: error→critical, unverified/out_of_base→warning, correct→ok.
function verdictToRow(v) {
  const uiStatus = v.status === 'error' ? 'critical'
    : (v.status === 'unverified' || v.status === 'out_of_base' || v.status === 'grammar') ? 'warning' : 'ok';
  const ref = [v.npa, v.article ? `ст.${v.article}` : ''].filter(Boolean).join(', ');
  return {
    item_number: ref ? `Фрагмент ${v.index + 1} (${ref})` : `Фрагмент ${v.index + 1}`,
    short_verdict: `${v.marker || ''}${v.detail ? ': ' + v.detail.slice(0, 140) : ''}`.trim(),
    status: uiStatus,
    confidence: null,
    legal_rationale: v.detail || '',
    applicable_articles: v.cited_articles || [],
    law_refs: v.cited_articles || [],
    // Пометка Слепой зоны (ссылка не подтверждена базой).
    triage: v.blind_spot ? 'blind_spot' : undefined,
  };
}

// ---------------------------------------------------------------------------
// ЧЕКЛИСТЫ ДЛЯ ГЛУБОКОЙ САМОПРОВЕРКИ — по каждому из 12 типов документов
// Используются в /deep-check-document (Level 2): модель знает ЧТО ИМЕННО искать.
// ---------------------------------------------------------------------------
const DEEP_TYPE_CHECKLISTS = {
  dogovor: `ГРАЖДАНСКО-ПРАВОВОЙ ДОГОВОР (ГК КР) — обязательные элементы:
□ Предмет — конкретная услуга/товар/работа (ст. 382 ГК КР)
□ Цена и порядок оплаты — сумма в сомах, сроки оплаты (ст. 393 ГК КР)
□ Срок действия договора — дата начала и окончания
□ Права и обязанности КАЖДОЙ стороны (симметрично)
□ Порядок сдачи-приёмки выполненных работ/услуг (если применимо)
□ Ответственность — неустойка/штраф за нарушение (ст. 360 ГК КР)
□ Форс-мажор (ст. 368 ГК КР) — перечень, уведомление через ТПП КР, последствия
□ Конфиденциальность — если предмет предполагает коммерческую тайну
□ Досудебный претензионный порядок — срок ответа на претензию
□ Подсудность — суды Кыргызской Республики
□ Реквизиты и подписи ОБЕИХ сторон (наименование, адрес, р/с, печать/подпись)`,

  isk: `ИСКОВОЕ ЗАЯВЛЕНИЕ (ГПК КР) — обязательные элементы:
□ Наименование суда с указанием инстанции (ст. 131 ГПК КР)
□ Истец: ФИО/наименование полностью, адрес, контакты
□ Ответчик: ФИО/наименование полностью, адрес
□ Цена иска — если имущественное требование (ст. 93 ГПК КР)
□ Государственная пошлина — сумма или ходатайство об освобождении
□ Фабула: хронологические обстоятельства с конкретными датами
□ Доказательная база — ссылки на документы
□ Правовое основание — конкретные статьи НПА Кыргызской Республики
□ Просительная часть — чёткие и исполнимые требования к суду
□ Расчёт суммы взыскания (если имущественный иск)
□ Перечень приложений (ст. 132 ГПК КР)
□ Дата и подпись истца или представителя`,

  pretenziya: `ПРЕТЕНЗИЯ — обязательные элементы:
□ Адресат — полное наименование и адрес получателя
□ Отправитель — ФИО/наименование и адрес
□ Ссылка на договор или основание правоотношений (номер, дата)
□ Фабула нарушения — что произошло, когда, какие последствия
□ Правовое основание — статьи ГК КР или профильного закона КР
□ Расчёт суммы требования (основной долг + неустойка + убытки)
□ Конкретное требование — что именно сделать (заплатить/устранить/вернуть)
□ Срок исполнения требования
□ Предупреждение об обращении в суд при неисполнении
□ Перечень приложений — документы, подтверждающие требование
□ Дата и подпись уполномоченного лица`,

  zayavlenie: `ЗАЯВЛЕНИЕ — обязательные элементы:
□ Адресат — орган/должностное лицо, куда подаётся
□ Заявитель — ФИО полностью, адрес, контакты
□ Предмет заявления — чёткая формулировка просьбы (одна фраза)
□ Фактическое основание — обстоятельства, дата возникновения
□ Правовое основание — НПА КР, дающий право на обращение
□ Конкретная просьба — что сделать / рассмотреть / выдать
□ Приложения — документы, подтверждающие право
□ Дата и подпись`,

  zhaloba: `ЖАЛОБА — обязательные элементы:
□ Адресат — орган/должностное лицо, уполномоченный на рассмотрение
□ Заявитель — ФИО, адрес, контакты
□ Предмет жалобы — какое решение/действие/бездействие обжалуется
□ Орган/лицо, чьи действия обжалуются (наименование, должность)
□ Дата совершения оспариваемого действия/решения
□ Доводы — почему действие незаконно/необоснованно (со ссылками на НПА КР)
□ Нарушенные права и законные интересы заявителя
□ Конкретное требование — отменить, обязать, признать, компенсировать
□ Перечень приложений
□ Дата и подпись`,

  vozrazhenie: `ВОЗРАЖЕНИЕ НА ИСК (ГПК КР) — обязательные элементы:
□ Реквизиты дела — суд, номер дела, стороны
□ Краткое изложение позиции истца (объективно, без оценок)
□ Позиция ответчика — полное или частичное несогласие
□ Доводы против каждого искового требования (по пунктам)
□ Правовое обоснование — конкретные статьи НПА КР
□ Процессуальные доводы (пропуск срока исковой давности, ненадлежащий истец и т.д.)
□ Доказательства, опровергающие иск (ссылки на приложения)
□ Просьба к суду — отказать в удовлетворении (полностью/частично)
□ Перечень приложений
□ Дата и подпись`,

  hodataistvo: `ХОДАТАЙСТВО (ГПК КР) — обязательные элементы:
□ Суд и реквизиты дела (номер, стороны)
□ Ходатай — сторона/представитель и процессуальное положение
□ Предмет — конкретная процессуальная просьба
□ Фактическое основание — почему необходимо (обстоятельства)
□ Правовое основание — статья ГПК КР, дающая право на ходатайство
□ Просьба к суду — конкретная и исполнимая
□ Дата и подпись`,

  apellyaciya: `АПЕЛЛЯЦИОННАЯ ЖАЛОБА (ГПК КР) — обязательные элементы:
□ Правильная апелляционная инстанция (вышестоящий суд)
□ Номер дела, стороны
□ Обжалуемое решение — суд, дата вынесения, краткая резолютивная часть
□ Основание 1: неправильное применение материального права (ст. 319 ГПК КР) — с доводами
□ Основание 2: несоответствие выводов суда фактическим обстоятельствам дела
□ Основание 3: нарушение/неправильное применение процессуального права (ст. 320 ГПК КР) — если есть
□ Ссылки на НПА КР по каждому доводу
□ Просьба — отменить/изменить решение и принять новое / направить на новое рассмотрение
□ Госпошлина (50% от первоначальной) или ходатайство об освобождении
□ Перечень приложений
□ Дата и подпись`,

  raspiska: `РАСПИСКА — обязательные элементы:
□ Место составления и дата
□ Передающий — ФИО полностью (паспортные данные — ручное заполнение)
□ Получающий — ФИО полностью (паспортные данные — ручное заполнение)
□ Предмет — что именно передаётся (деньги/вещи/документы), количество/размер
□ Сумма прописью (если деньги — ст. 350 ГК КР о форме)
□ Основание передачи — за что (заём, залог, аванс, оплата и т.д.)
□ Срок возврата (если заём — ст. 722 ГК КР)
□ Условие о процентах или прямое указание на безвозмездность (ст. 358 ГК КР)
□ Отметка о добровольности — отсутствие давления
□ Подписи обеих сторон`,

  doverennost: `ДОВЕРЕННОСТЬ (ГК КР) — обязательные элементы:
□ Место составления и дата выдачи — ОБЯЗАТЕЛЬНО (ст. 193 ГК КР, без даты — недействительна)
□ Доверитель — ФИО/наименование, реквизиты
□ Поверенный — ФИО полностью (паспортные данные — ручное заполнение)
□ Конкретный перечень полномочий (не «все действия» — слишком широко)
□ Срок действия — если не указан, то 1 год (ст. 196 ГК КР)
□ Право передоверия — есть или явно отсутствует (ст. 198 ГК КР)
□ Нотариальное удостоверение — требуется ли по типу полномочий (ст. 194 ГК КР)
□ Подпись доверителя`,

  pismo: `ОФИЦИАЛЬНОЕ ПИСЬМО — обязательные элементы:
□ Шапка отправителя — наименование, адрес, исходящий номер, дата
□ Адресат — должность, ФИО, организация
□ Вежливое обращение (Уважаемый/ая...)
□ Предмет — краткое «О чём» (одна фраза)
□ Основная часть — суть, факты, доводы (логично, без воды)
□ Ссылки на НПА / договоры / предыдущую переписку (если применимо)
□ Конкретный запрос/просьба/информация — чётко что от адресата ожидается
□ Подпись уполномоченного лица с должностью и расшифровкой
□ Приложения (если есть)`,

  custom: `ДОКУМЕНТ (произвольный тип) — общие требования:
□ Чёткое указание типа и назначения документа
□ Стороны / участники — полное наименование
□ Предмет / тема — конкретно и однозначно
□ Правовое основание (если применимо) — НПА КР
□ Обязательства / права / действия каждой стороны
□ Сроки исполнения
□ Ответственность за неисполнение
□ Подписи`,
};

// ---------------------------------------------------------------------------
// РОУТ
// ---------------------------------------------------------------------------
function createAnalyzeV2Router(deps = {}) {
  const express = require('express');
  const multer = require('multer');
  const { smartParse } = require('../services/parserService');
  const { createDefaultDeps } = require('../services/legalAgents');
  const router = express.Router();
  const upload = makeUpload(multer);

  // Боевые агенты по умолчанию (Gemini/Pinecone/DeepSeek из .env);
  // переданные снаружи deps переопределяют дефолт (удобно для тестов/моков).
  const resolvedDeps = { ...createDefaultDeps(), ...deps };

  router.post('/analyze-document', upload.single('file'), async (req, res) => {
    // SSE-заголовки. 2026-06-12 анти-буферизация:
    //   no-transform     — запрет прокси сжимать/перепаковывать поток;
    //   X-Accel-Buffering — отключает буферизацию Nginx (реверс-прокси Render);
    //   flushHeaders     — заголовки уходят клиенту сразу, до первого чанка.
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    // SSE-эмиттеры в ТОЧНОМ формате прод-контракта (routes/analyze.js / script.js):
    //   { step:{id,status,text,reason?} } | { tableRow:{...} } | { purityIndex:int }
    //   { text:"markdown" } | { executive_summary:{...} } | [DONE] (литерал, НЕ JSON)
    // res.flush() существует только под модулем compression — вызываем с guard'ом.
    const sse = (obj) => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
      if (typeof res.flush === 'function') { try { res.flush(); } catch (_) {} }
    };
    const step = (s) => sse({ step: s });
    const done = () => { if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); } };

    // Два режима входа:
    //   1) JSON { documentText } — фронт IDE уже извлёк текст в браузере (основной путь A/B);
    //   2) multipart file        — сырой PDF/DOCX → Cloud Run/Docling (на будущее, ZDR).
    const bodyText = req.body && req.body.documentText;
    if (!req.file && !(bodyText && String(bodyText).trim())) {
      step({ id: 'error', status: 'error', text: 'Документ не получен (ни файл, ни текст)' });
      return done();
    }

    try {
      // ── ФАЗА 1: получение текста (умный роутинг) + фрагментация + словарь ──
      step({ id: 'parse', status: 'loading', text: 'Готовлю документ' });
      let markdown; let source; let structure_confidence; let preFragments = null;
      if (req.file) {
        // smartParse: короткие документы минуют Docling, текст берётся локально (ZDR).
        const p = await smartParse(req.file.path, req.file.originalname); // удалит /tmp сам
        ({ markdown, source, structure_confidence } = p);
        // Короткий документ → семантическая нарезка Gemini (CoT) вместо regex-чанкинга.
        if (p.needsFragmentation) {
          step({ id: 'parse', status: 'loading', text: `Короткий документ (${source}) → умная фрагментация Gemini` });
          preFragments = await resolvedDeps.fragmentDocument?.(markdown);
        }
      } else {
        // Текст уже извлечён клиентом (pdfjs/mammoth) — Docling не нужен.
        markdown = String(bodyText);
        source = 'client_text';
        structure_confidence = /^\s{0,3}#{2,}\s/m.test(markdown) ? 'high' : 'low';
      }
      step({ id: 'parse', status: 'success', text: `Источник: ${source}, структура: ${structure_confidence}` });

      step({ id: 'segment', status: 'loading', text: 'Разбиваю документ на смысловые блоки (Super Doc)' });
      // Super Doc нарезка:
      //   • короткий документ → Gemini CoT фрагменты (preFragments) — уже семантичны;
      //   • иначе → hybridSegmenter (Layer A lossless + Layer B Flash-Lite на проблемных зонах).
      // Оба пути дают chunks=string[] (raw текст) + chunkContexts[] (sticky раздел+НПА).
      let chunks; let chunkContexts; let segInfo;
      if (preFragments && preFragments.length) {
        chunks = preFragments;
        chunkContexts = buildChunkContexts(chunks);
        segInfo = 'Gemini CoT';
      } else {
        const seg = await getHybridSegmenter().segment(markdown, { stageLabel: 'v2_segment', docType: structure_confidence });
        chunks = seg.chunks;
        chunkContexts = seg.chunkContexts || buildChunkContexts(chunks);
        segInfo = `Super Doc · ${(seg.layers || ['A']).join('+')}`;
        console.log(`[SuperDoc] segment: ${chunks.length} блоков | layers=${(seg.layers || ['A']).join('+')}` +
          (seg.layerB && seg.layerB.called ? ` | LayerB success=${seg.layerB.success} fallback=${seg.layerB.fallback}` : ''));
      }
      // ── Шаги 2+3: типизация блоков (Flash-Lite) + атомарные таблицы +
      //    семантический lead-in. Дробление таблиц может изменить число блоков,
      //    поэтому пересобираем chunks ПЕРЕД buildGlobalState. blockMeta[i]
      //    параллелен новому chunks[i]: { section, npa, type, continues_prev, leadIn }.
      //
      // ⚡ ОПТИМИЗАЦИЯ: extractGlossary использует только markdown (не зависит от
      // классифицированных блоков) → запускаем его СРАЗУ, пока buildSuperDocBlocks
      // работает. Экономия: max(glossary, classify) вместо sum(glossary + classify) ≈ 3-5с.
      const glossaryPromise = resolvedDeps.extractGlossary
        ? resolvedDeps.extractGlossary(markdown, chunks).catch(() => ({}))
        : Promise.resolve({});

      const sdBlocks = await buildSuperDocBlocks(chunks, chunkContexts, { cascade: getCascade(), logger: console });
      chunks = sdBlocks.map((b) => b.text);
      const blockMeta = sdBlocks.map((b) => ({
        section: b.context ? b.context.section : null,
        npa: b.context ? b.context.npa : null,
        type: b.type,
        continues_prev: b.continues_prev,
        leadIn: b.leadIn || null,
        tablePart: b.tablePart || null,
      }));
      const typeCounts = sdBlocks.reduce((acc, b) => { acc[b.type] = (acc[b.type] || 0) + 1; return acc; }, {});
      const leadInCount = blockMeta.filter((m) => m.leadIn).length;
      console.log(`[SuperDoc] blocks: ${sdBlocks.length} | types=${JSON.stringify(typeCounts)} | lead-in=${leadInCount}`);

      // Ждём глоссарий (вероятно уже готов, т.к. шёл параллельно с classify)
      const { terms = {}, crossRefs = {}, header = '' } = (await glossaryPromise) || {};
      const state = {
        header,
        terms,
        termKeys: new Set(Object.keys(terms).map((t) => t.toLowerCase())),
        crossRefs,
        chunks,
        N: chunks.length,
        structureConfidence: structure_confidence,
      };
      step({ id: 'segment', status: 'success', text: `Блоков: ${state.N} (${segInfo})` });

      // ── ФАЗА 2: волновая валидация (стримим tableRow по мере готовности) ─
      step({ id: 'validate', status: 'loading', text: '⚖️ Сверка с НПА КР (волновой троттлер)' });
      const settled = await runInWaves(
        chunks,
        async (chunkText, idx) => {
          // Super Doc: каждому блоку — sticky-контекст + тип + lead-in.
          const v = await validateChunk(chunkText, idx, state, resolvedDeps, blockMeta[idx] || null);
          // fastest-first: строка таблицы и шаг уходят сразу, не дожидаясь волны.
          step({
            id: `seg_${idx}`,
            status: toStepStatus(v.status),
            text: `Фрагмент ${idx + 1}`,
            reason: v.detail ? v.detail.slice(0, 80) : (v.marker || ''),
          });
          sse({ tableRow: verdictToRow(v) });
          return v;
        },
        // stepMs: 10мс вместо дефолтных 50мс — все блоки стартуют почти одновременно.
        // wavePauseMs: 200мс (дефолт 1000) — меньше пауза между волнами (защита от 429).
        { stepMs: 10, wavePauseMs: 200 },
      );
      const graph = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
      step({ id: 'validate', status: 'success', text: `Проверено фрагментов: ${graph.length}` });

      // ── ФАЗА 3: Reduce (Final Judge) ─────────────────────────────────
      const errorCount = graph.filter((g) => g.status === 'error').length;
      const blindSpotCount = graph.filter((g) => g.blind_spot).length;
      // Сколько РАЗНЫХ НПА затронуто ошибками (нормализуем имена, чтобы не задвоить).
      const distinctNpaCount = new Set(
        graph.filter((g) => g.status === 'error' && g.npa).map((g) => normalizeNpaName(g.npa)),
      ).size;
      // Динамическая развилка: лёгкий док → Flash/low, тяжёлый → Pro/high-max.
      const route = pickJudgeRoute({ errorCount, blindSpotCount, distinctNpaCount, totalBlocks: state.N });
      console.log(`[V2 Judge] route=${route.tier} | model=${route.model} | effort=${route.reasoning_effort} | thinking=${route.thinking} | issues=${errorCount + blindSpotCount} npa=${distinctNpaCount} blocks=${state.N}`);

      // purityIndex: доля пунктов без ошибок цитирования, 0-100.
      const purityIndex = state.N ? Math.round(((state.N - errorCount) / state.N) * 100) : 100;
      sse({ purityIndex });
      // Имя сработавшего судьи на фронт (машиночитаемое; неизвестный ключ фронт игнорит).
      sse({ judge: { name: route.name, model: route.model, effort: route.reasoning_effort, tier: route.tier } });

      step({ id: 'judge', status: 'loading', text: `🧠 Финальный судья: ${route.name} (effort=${route.reasoning_effort})` });

      // ── 2026-06-16 FIX: НЕ стримим reasoning_content в UI ──
      // Раньше цепочку мыслей слали в тегах <think>…</think> в расчёте на
      // Lobe Chat (аккордеон Chain of Thought). Но наш фронт (ChatMZ /
      // React-воркспейс) теги <think> не понимает и рендерит их содержимое как
      // обычный текст → весь внутренний монолог Судьи («We need to produce a
      // final report…») вываливался юристу вместо чистого отчёта.
      // Теперь стримим ТОЛЬКО итоговый content (живой токен-за-токеном),
      // reasoning игнорируем в UI (он пишется в server-лог внутри deepseekReason).
      // На время раздумий виден loading-шаг «🧠 Финальный судья…».
      let sawContent = false;  // пошёл основной текст (его дубль ниже не шлём)
      const onJudgeDelta = (d) => {
        if (!d) return;
        if (d.text) { sawContent = true; sse({ text: cleanCjk(d.text) }); }
        // d.reasoning НЕ выводим в UI — это служебная цепочка мыслей.
      };
      // ── Живой прогресс Судьи во время «раздумий» (reasoning) ──
      // До первого content-токена модель молча думает (v4-pro: десятки секунд).
      // Чтобы юрист видел, ЧТО происходит, крутим фазы + секундомер на том же
      // loading-шаге 'judge' (фронт сам рисует спиннер). Стоп — как пошёл текст.
      const judgeStart = Date.now();
      const judgePhases = [
        'Изучаю выявленные расхождения',
        'Сверяю формулировки с нормами НПА КР',
        'Оцениваю серьёзность и риски',
        'Готовлю исполнительное резюме',
      ];
      let jp = 0;
      const judgeTicker = setInterval(() => {
        if (sawContent || res.writableEnded) return;
        const el = Math.round((Date.now() - judgeStart) / 1000);
        step({ id: 'judge', status: 'loading', text: `🧠 ${route.name}: ${judgePhases[jp % judgePhases.length]}…`, reason: `идёт анализ · ${el} c` });
        jp += 1;
      }, 2500);
      let report;
      try {
        report = (await resolvedDeps.judge?.({ graph, effort: route.reasoning_effort, model: route.model, thinking: route.thinking, state, onDelta: onJudgeDelta })) || { summary: '', risks: graph };
      } finally {
        clearInterval(judgeTicker);
      }
      step({ id: 'judge', status: 'success', text: 'Итоговый отчёт готов' });

      // Текст судьи (markdown, 2 секции). Если content уже ушёл дельтами выше —
      // НЕ дублируем. Фоллбэк одним куском остаётся для skip-пути (пустой граф),
      // Gemini-fallback без стрима и ошибок до первого content-чанка.
      if (report.summary && !sawContent) sse({ text: cleanCjk(report.summary) });

      // Executive Summary card (ошибки + слепые зоны).
      const risks = graph.filter((g) => g.status === 'error' || g.blind_spot);
      const topRisks = risks.slice(0, 3).map((r) => ({
        id: [r.npa, r.article ? `ст.${r.article}` : ''].filter(Boolean).join(', ') || `Фрагмент ${r.index + 1}`,
        title: (r.detail || r.marker || '').slice(0, 120),
        confidence: 50,
      }));
      sse({
        executive_summary: {
          summary: report.summary ? 'Анализ завершён.' : 'Документ проверен.',
          top_risks: topRisks,
          model_used: report.model || 'deepseek-reasoner',
        },
      });

      done();
    } catch (err) {
      step({ id: 'error', status: 'error', text: `Ошибка анализа: ${err.message}` });
      sse({ text: `\n\n⚠️ Ошибка анализа: ${err.message}` });
      done();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  ФАЗА 2A — ИНТЕРВЬЮЕР (режим «Документы → Создать»)
  //  /api/v2/draft-intake — ведёт диалог-досье: читает разговор, понимает,
  //  каких обязательных сведений не хватает, и задаёт уточняющие вопросы.
  //  Возвращает JSON: { ready, questions[], filled{}, missing[], summary }.
  //  Лёгкая модель (Gemini Flash) — это не генерация, а сбор фактуры.
  // ═══════════════════════════════════════════════════════════════════════
  const INTAKE_SYS = (docLabel, checklist) => `Ты — Интервьюер юридического ИИ «Мыйзамчы» (Кыргызстан).
Пользователь хочет составить документ: «${docLabel}». Твоя задача — собрать ДОСЬЕ (фактуру) для будущего составления, ведя живой диалог.

${checklist}

ПРАВИЛА:
1) Проанализируй ВЕСЬ диалог и пойми, какие сведения уже даны, а каких не хватает.
2) Если не хватает ОБЯЗАТЕЛЬНЫХ сведений — задай 1–3 коротких, конкретных вопроса простым языком (юрист-человек, без канцелярита). Спрашивай о самом важном недостающем.
3) Можешь подсказывать примером, если пользователь не знает («например, Свердловский районный суд г. Бишкек»).
4) ready=true СТРОГО когда собраны все ОБЯЗАТЕЛЬНЫЕ сведения. Желательные (цена иска, приложения) НЕ блокируют ready.
5) НИКОГДА не выдумывай факты за пользователя (имена, суммы, даты, адреса). Чего нет — спрашивай.
6) Не пиши сам документ. Только собирай фактуру.
7) Поля, которые обычно содержат конфиденциальные данные и заполняются вручную — НЕ блокируют ready и НЕ требуют вопроса, если пользователь их не указал:
   — ПИН работника / ИНН физического лица
   — Паспортные данные (серия, номер, кем выдан)
   — Номер государственной регистрации учредительных документов работодателя
   — Банковские реквизиты (р/с, БИК, банк)
   Если пользователь НЕ указал эти данные — включи в досье краткую фразу: «[поле] — будет заполнено вручную (появится прочерком в документе)». Это нормально: юрист самостоятельно впишет эти сведения в готовый документ.

Верни СТРОГО JSON без обёрток и markdown:
{
  "ready": <bool>,
  "questions": ["<вопрос1>", ...],   // пусто если ready=true
  "filled": { "<ключ_поля>": "<кратко что известно>" },
  "missing": ["<title недостающего обязательного поля>", ...],
  "summary": "<если ready: 2-3 фразы краткого досье; иначе ''>"
}`;

  router.post('/draft-intake', async (req, res) => {
    try {
      const docType = String((req.body && req.body.docType) || 'isk');
      const messages = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
      const tpl = getTemplate(docType);
      if (!tpl) return res.status(400).json({ error: `Неизвестный тип документа: ${docType}` });
      if (!messages.length) return res.status(400).json({ error: 'Пустой диалог' });

      // Диалог → текст для модели (роли помечаем явно).
      const convo = messages.map((m) => {
        const role = m && m.role === 'assistant' ? 'ИНТЕРВЬЮЕР' : 'ПОЛЬЗОВАТЕЛЬ';
        return `${role}: ${String((m && m.text) || '').slice(0, 4000)}`;
      }).join('\n\n');

      const raw = await clients.geminiJson({
        systemPrompt: INTAKE_SYS(tpl.label, buildChecklist(docType)),
        userPrompt: `ДИАЛОГ:\n${convo}\n\nВерни JSON-досье по правилам.`,
        // gemini-3.1-flash-lite — worker-модель: быстрее и не-thinking, поэтому
        // бюджет токенов не уходит в CoT и JSON не обрезается (без thinkingConfig).
        model: 'gemini-3.1-flash-lite',
        maxOutputTokens: 2048,
        timeoutMs: 25000,
      });

      // Упрочнённый парс: срезаем ```json-обёртки и берём {...} от первой { до последней }.
      const cleaned = String(raw || '').replace(/```json\s*/gi, '').replace(/```/g, '').trim();
      let parsed = null;
      try { parsed = JSON.parse(cleaned); } catch (_) {
        const a = cleaned.indexOf('{'), b = cleaned.lastIndexOf('}');
        if (a !== -1 && b > a) { try { parsed = JSON.parse(cleaned.slice(a, b + 1)); } catch (__) {} }
      }
      if (!parsed || typeof parsed !== 'object') {
        console.warn(`[draft-intake] unparseable output (len=${String(raw || '').length}): ${String(raw || '').slice(0, 200)}`);
        return res.json({ ready: false, questions: ['Повторите, пожалуйста, последнюю мысль другими словами — я не до конца понял.'], filled: {}, missing: [], summary: '', _parseFail: true });
      }
      return res.json({
        ready: !!parsed.ready,
        questions: Array.isArray(parsed.questions) ? parsed.questions.slice(0, 4) : [],
        filled: (parsed.filled && typeof parsed.filled === 'object') ? parsed.filled : {},
        missing: Array.isArray(parsed.missing) ? parsed.missing : [],
        summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      });
    } catch (err) {
      console.error('[draft-intake] error:', err.message);
      return res.status(500).json({ error: 'Сбой интервьюера: ' + err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  ФАЗА 2B — ГЕНЕРАЦИЯ ДОКУМЕНТА (режим «Документы → Создать»)
  //  /api/v2/draft-document — мультиагентная research-коллегия (SSE-стрим):
  //    1) КОЛЛЕГИЯ ПАРАЛЛЕЛЬНЫХ АГЕНТОВ (Promise.all, бюджет ~20с на агента):
  //       • агент фактуры (flash-lite) — facts/subject/legal_questions;
  //       • 4 агента-исследователя (точные / связанные+спец.законы / общие /
  //         процессуальные) — КАЖДЫЙ сам формулирует запросы по своей
  //         специализации и сам ищет в Pinecone. Процессуальный всегда добавляет
  //         дефолты (пошлина/сроки/подсудность/форма). Дедуп по статье, роль =
  //         специализация агента по приоритету (exact>related>procedural>general).
  //       Отдельного агента-отборщика НЕТ — нерелевантное отсекает драфтер.
  //    2) Драфтер (DeepSeek v4-pro, reasoning) — насыщенный документ с полным
  //       правовым обоснованием, цитирует ТОЛЬКО реальные статьи из базы.
  //  SSE: { stage } прогресс → финальный { done:true, blocks[], articlesUsed[] }.
  // ═══════════════════════════════════════════════════════════════════════
  const CAT_LABEL = {
    exact:       'ТОЧНЫЕ НОРМЫ ПО ПРЕДМЕТУ',
    related:     'СВЯЗАННЫЕ НОРМЫ',
    general:     'ОБЩИЕ НОРМЫ',
    procedural:  'ПРОЦЕССУАЛЬНЫЕ НОРМЫ',
    enforcement: 'АДМИНИСТРАТИВНОЕ И УГОЛОВНОЕ ДАВЛЕНИЕ',
  };
  const PLANNER_SYS = (tpl) => `Ты — ведущий юрист-исследователь ИИ «Мыйзамчы» (Кыргызстан).
По собранному диалогу подготовь ПЛАН составления документа «${tpl.label}» и СТРАТЕГИЮ поиска норм права КР.

Применимые кодексы/НПА (ориентир): ${(tpl.codesHint || []).join('; ')}.

Сформулируй РАЗВЁРНУТЫЙ набор поисковых запросов в ЧЕТЫРЁХ группах, чтобы найти АБСОЛЮТНО ВСЕ применимые нормы (не скупись — лучше больше запросов):
• exact      — нормы ПРЯМО по предмету спора (основание требования);
• related    — связанные институты + СПЕЦИАЛЬНЫЕ ЗАКОНЫ/КОДЕКСЫ по предмету (напр. для земли — Земельный кодекс КР; для потребителя — Закон «О защите прав потребителей»; для аренды/займа/подряда — соответствующие главы), последствия (реституция, убытки, неустойка);
• general    — общие положения Гражданского кодекса (о сделках, недействительности, обязательствах, праве собственности, представительстве);
• procedural — процессуальные нормы ГПК КР: подсудность; форма и содержание искового заявления; государственная пошлина (размер, расчёт); исковая давность и сроки; обеспечительные меры; последствия несоблюдения досудебного порядка.

Верни СТРОГО JSON без markdown:
{
  "facts": {
    ${(tpl.requiredFields || []).concat(tpl.optionalFields || []).map((f) => `"${f.key}": "<${f.title}: что известно из диалога, дословно факты; '' если не сказано>"`).join(',\n    ')}
  },
  "subject_line": "<краткая формулировка предмета для подзаголовка, напр. 'о признании договора недействительным'>",
  "legal_questions": ["<1-3 ключевых правовых вопроса дела>"],
  "queries": {
    "exact":      ["<3-5 точных запросов>"],
    "related":    ["<3-5 запросов: спец. законы по предмету + последствия>"],
    "general":    ["<2-4 запроса по общим положениям ГК КР>"],
    "procedural": ["<3-5 запросов по ГПК КР: пошлина, сроки/давность, подсудность, форма иска>"]
  }
}

ПРАВИЛА: факты бери ТОЛЬКО из диалога, не выдумывай имена/суммы/даты/адреса (нет → ''). Запросы пиши развёрнуто, называя конкретные институты, кодексы и законы КР, чтобы векторный поиск нашёл максимум норм. Обязательно укажи СПЕЦИАЛЬНЫЙ закон/кодекс, профильный для предмета спора.`;

  // Всегда-включённые процессуальные запросы (госпошлина / сроки / подсудность /
  // форма иска) — чтобы эти нормы подтягивались независимо от планировщика.
  const PROC_DEFAULTS = [
    'размер и расчёт государственной пошлины по исковому заявлению Кыргызская Республика',
    'срок исковой давности гражданские дела',
    'подсудность гражданских дел районный суд',
    'форма и содержание искового заявления требования ГПК',
  ];

  const DRAFTER_SYS = (tpl, titleWord) => {
    // ── ДВУСТОРОННИЙ ДОКУМЕНТ (договор) — преамбула, разделы, пункты, реквизиты ──
    if (tpl.bilateral) {
      return `Ты — старший юрист Кыргызской Республики. Составь ПОЛНЫЙ, юридически грамотный ДОГОВОР и верни его СТРОГО как JSON-массив блоков (DocBlock[]) — без markdown, без пояснений.

ФОРМАТ БЛОКА:
{ "kind": "<тип>", "align": "left|center|right|justify (необязательно)", "runs": [ { "t": "текст", "bold": true?, "italic": true?, "underline": true?, "cite": "<НПА ст.N>" } ] }

ТИПЫ БЛОКОВ (kind):
- title (центр, bold): «ДОГОВОР <ВИД> № __» — ВИД определи из досье: оказания услуг / аренды / купли-продажи / подряда / займа / поставки и т.п.
- paragraph (по ширине): дата+место; ПРЕАМБУЛА (стороны, именование, основание полномочий, «договорились о нижеследующем:»)
- section_heading (bold, слева): нумерованный раздел «N. НАЗВАНИЕ»
- clause (по ширине): нумерованный пункт «N.N. …»
- requisites_table: ДВЕ КОЛОНКИ. { "kind":"requisites_table", "left":"СТОРОНА 1\\nнаименование\\nадрес\\nИНН\\nрасчётный счёт\\n_____________ /ФИО/", "right":"СТОРОНА 2\\n…" }. Строки разделять \\n; первая строка — название стороны (будет жирной).
- spacer: { "kind":"spacer", "runs":[] } — ОБЯЗАТЕЛЕН перед каждым section_heading (кроме первого) и перед requisites_table.

СТРУКТУРА — ОБЯЗАТЕЛЬНЫЕ РАЗДЕЛЫ (адаптируй пункты под ВИД договора):
${(tpl.structureHint || []).map((s, i) => `${i + 1}. ${s}`).join('\n')}

КАК СОСТАВЛЯТЬ:
• Преамбула: укажи обе стороны из досье точно (наименование / ФИО, ИНН, в лице кого и на основании чего, как именуются).
• Раскрой КАЖДЫЙ раздел нумерованными пунктами (1.1, 1.2 …; 2.1 …). Не пропускай разделы из структуры выше.
• ФОРС-МАЖОР (раздел 6 структуры) — ОБЯЗАТЕЛЬНЫЙ раздел для любого договора. Содержание:
  – перечень обстоятельств непреодолимой силы (стихийные бедствия, пожары, военные действия, забастовки, эпидемии, действия государственных органов и т.п.);
  – срок уведомления другой Стороны — 5 рабочих дней с момента начала форс-мажора, с подтверждающим документом (справка ТПП КР);
  – продление срока исполнения на период форс-мажора;
  – при форс-мажоре свыше 30 дней — право любой Стороны расторгнуть договор без штрафных санкций.
  Ссылка на ст. 368 ГК КР.
• РАЗРЕШЕНИЕ СПОРОВ — досудебный претензионный порядок (срок ответа 15 рабочих дней) + суд КР.
• КОНФИДЕНЦИАЛЬНОСТЬ — включи раздел если предмет договора предполагает работу с коммерческой тайной/данными.
• Привязывай условия к нормам — отдельный run с italic:true и cite:"<НПА ст.N>". Цитируй ТОЛЬКО нормы из ЭТАЛОННОГО списка (RAG).
• В конце: section_heading «РЕКВИЗИТЫ И ПОДПИСИ СТОРОН» + spacer + ОДИН блок requisites_table с реквизитами обеих сторон и строками подписи «_____________ /ФИО/».

ЮРИСДИКЦИЯ — КЫРГЫЗСКАЯ РЕСПУБЛИКА (соблюдать СТРОГО):
• ВАЛЮТА: всегда «сом» (сом КР / KGS). Слова «тенге», «рубль», «гривна», «лари» и любая иная иностранная валюта — ЗАПРЕЩЕНЫ, если пользователь явно не указал их в досье.
• ЗАКОНОДАТЕЛЬСТВО: только НПА Кыргызской Республики (ГК КР, ГПК КР и т.д.). Никаких «ГК РФ», «ГК РК» или иных иностранных кодексов.
• СУДЫ: суды Кыргызской Республики. Никаких «арбитражный суд РФ» или «МКАС» без явного указания в досье.
• ОРГАНЫ: УГНС КР, Министерство юстиции КР, ТПП КР, Нацбанк КР и т.п. — только кыргызские.
• РЕКВИЗИТЫ: формат расчётного счёта, БИК, ИНН — кыргызский формат.

ЖЕЛЕЗНЫЕ ПРАВИЛА:
1. КАЖДОМУ section_heading предшествует spacer (кроме первого). Структура: paragraph → spacer → section_heading → clause … → spacer → section_heading → …
2. НЕ выдумывай факты (наименования, ФИО, суммы, даты, реквизиты). Только из досье. Нет детали — ставь «____________».
3. Цитируй статьи ТОЛЬКО из эталонного списка норм (RAG), отдельным run с italic:true и cite. Следи за пробелами между run.
4. Раздел ФОРС-МАЖОР — пропускать НЕЛЬЗЯ. Он защищает обе стороны.
5. Верни ТОЛЬКО JSON-массив блоков. Первый символ ответа — «[», последний — «]».`;
    }

    const dw = tpl.demandWord || '';
    const ttl = titleWord || tpl.titleWord || tpl.label;
    const demandLine = dw
      ? `- demand_heading («${dw}:») · demand_item (нумерованное требование/просьба)\n`
      : '';
    return `Ты — старший юрист Кыргызской Республики. Составь ПОЛНЫЙ, юридически грамотный документ «${tpl.label}» и верни его СТРОГО как JSON-массив блоков (DocBlock[]) — без markdown, без пояснений.

ФОРМАТ БЛОКА:
{ "kind": "<тип>", "align": "left|center|right|justify (необязательно)", "runs": [ { "t": "текст", "bold": true?, "italic": true?, "underline": true?, "cite": "<НПА ст.N, если ссылка на норму>" } ] }

ТИПЫ БЛОКОВ (kind):
- court (только для судебных документов: наименование суда) · party_header (стороны/адресат/заявитель — по одному блоку на строку, справа) · spacer (runs:[]) · title (НАЗВАНИЕ заглавными, bold, центр${ttl ? `: «${ttl}»` : ''}) · subtitle («о …», центр)
- section_heading (заголовок раздела, bold, ЦЕНТР): «ПРАВОВОЕ ОБОСНОВАНИЕ», «РАСЧЁТ СУММЫ ТРЕБОВАНИЯ», «НАРУШЕННЫЕ ПРАВА», «НАША ПОЗИЦИЯ» и т.п. — СТРОГО отдельный блок, только текст заголовка, runs:[{"t":"ЗАГОЛОВОК","bold":true}]
- paragraph (фабула / тело раздела / расчёты — по ширине)
${demandLine}- attachment_heading («Приложение:», центр) · attachment_item · signature (справа, с местом для даты)

ПОРЯДОК СЕКЦИЙ:
${(tpl.structureHint || []).map((s, i) => `${i + 1}. ${s}`).join('\n')}

КАК ПИСАТЬ ПРАВОВОЕ ОБОСНОВАНИЕ (документ должен быть содержательным, а не из двух абзацев):
• ФАБУЛА: подробно изложи обстоятельства из досье (стороны, даты, предмет, суть нарушения/обращения).
• НЕСКОЛЬКО абзацев правового обоснования — задействуй ВСЕ применимые нормы из эталона:
  – точные нормы (прямое основание) — процитируй и объясни применение к фактам;
  – специальные нормы профильного закона/кодекса и связанные нормы (последствия, смежные институты) — каждой нормы свой смысловой абзац;
${tpl.courtDoc
  ? `• Процессуальные моменты со ссылками на ГПК КР: подсудность, срок исковой давности, размер и расчёт государственной пошлины.
• Отдельный абзац: «Руководствуясь ст. … ГПК КР, прошу:» со ссылками на процессуальные нормы.
• Для имущественного иска добавь требование о взыскании госпошлины.`
  : `• Порядок и сроки из группы «Порядок и сроки», если применимо.
• НЕ добавляй блок court, госпошлину, подсудность и ГПК — это НЕ судебный документ. Адресат/заявитель — блоками party_header (справа).${dw ? `\n• Каждое требование в «${dw}:» формулируй чётко (что и в какой срок).` : ''}
• ЕСЛИ в эталонном списке есть нормы из группы «АДМИНИСТРАТИВНОЕ И УГОЛОВНОЕ ДАВЛЕНИЕ» — обязательно включи их в правовое обоснование отдельным убедительным абзацем: административные штрафы для компании по Кодексу КР о правонарушениях, уголовная ответственность директора/должностного лица по УК КР, полномочия надзорных органов инициировать проверку. Это создаёт максимальное давление для досудебного урегулирования.`}

ЮРИСДИКЦИЯ — КЫРГЫЗСКАЯ РЕСПУБЛИКА (соблюдать СТРОГО):
• ВАЛЮТА: всегда «сом» (сом КР / KGS). Слова «тенге», «рубль», «гривна» и любая иная иностранная валюта — ЗАПРЕЩЕНЫ, если пользователь явно не указал их в досье.
• ЗАКОНОДАТЕЛЬСТВО: только НПА Кыргызской Республики (ГК КР, ГПК КР и т.д.). Никаких «ГК РФ», «ГК РК» или иных иностранных кодексов.
• СУДЫ: суды Кыргызской Республики. Никаких иностранных судов без явного указания в досье.
• ОРГАНЫ: УГНС КР, Министерство юстиции КР, ТПП КР, Нацбанк КР — только кыргызские.

ЖЕЛЕЗНЫЕ ПРАВИЛА:
1. Цитируй ТОЛЬКО статьи из ЭТАЛОННОГО списка норм (RAG). Не придумывай номера. Используй КАК МОЖНО БОЛЬШЕ применимых норм — не ограничивайся одной-двумя.
2. Каждую ссылку на норму — отдельным run: italic:true и cite:"<НПА ст.N>". Окружающий текст — обычными run. Следи за пробелами между run.
3. НЕ выдумывай факты (имена, суммы, даты, адреса, ИНН). Только из досье. Нет детали — ставь «____________».
4. Вставляй spacer (runs:[]) ПЕРЕД И ПОСЛЕ каждого section_heading, demand_heading, attachment_heading, signature — и между смысловыми секциями (после шапки перед заголовком, после заголовка перед фабулой).
5. Верни ТОЛЬКО JSON-массив блоков. Первый символ ответа — «[», последний — «]».`;
  };

  router.post('/draft-document', async (req, res) => {
    // Базовая валидация ДО SSE-заголовков (чтобы отдать чистый 400).
    const docType = String((req.body && req.body.docType) || 'isk');
    const messages = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
    const tpl = getTemplate(docType);
    if (!tpl) return res.status(400).json({ error: `Неизвестный тип документа: ${docType}` });
    if (!messages.length) return res.status(400).json({ error: 'Пустой диалог' });

    // SSE (как в /analyze-document — анти-буферизация Render).
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    const sse = (obj) => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
      if (typeof res.flush === 'function') { try { res.flush(); } catch (_) {} }
    };
    const done = () => { if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); } };
    const stage = (text, extra = {}) => sse({ stage: text, ...extra });

    try {
      const convo = messages.map((m) => {
        const role = m && m.role === 'assistant' ? 'ИНТЕРВЬЮЕР' : 'ПОЛЬЗОВАТЕЛЬ';
        return `${role}: ${String((m && m.text) || '').slice(0, 4000)}`;
      }).join('\n\n');
      const parseObj = (raw) => {
        const c = String(raw || '').replace(/```json\s*/gi, '').replace(/```/g, '').trim();
        try { return JSON.parse(c); } catch (_) {}
        const a = c.indexOf('{'), b = c.lastIndexOf('}');
        if (a !== -1 && b > a) { try { return JSON.parse(c.slice(a, b + 1)); } catch (__) {} }
        return null;
      };

      // ── 1-2) КОЛЛЕГИЯ АГЕНТОВ: фактура + 4 специализированных исследователя ──
      //   Каждый исследователь САМ формулирует запросы по своей специализации и
      //   САМ ищет в Pinecone. Все агенты работают ПАРАЛЛЕЛЬНО (Promise.all);
      //   у каждого бюджет ~20с (withTimeout) — медленный агент не тормозит остальных.
      // pressureDoc (претензия, жалоба) — включает 5-го агента по административному
      // и уголовному давлению (КоАП КР, УК КР, надзорные органы).
      const isPressureDoc = !!tpl.pressureDoc;
      const cats = isPressureDoc
        ? ['exact', 'related', 'general', 'procedural', 'enforcement']
        : ['exact', 'related', 'general', 'procedural'];
      const uniq = (arr) => Array.from(new Set(arr.filter(Boolean)));
      const withTimeout = (p, ms, fb) => Promise.race([
        Promise.resolve(p).catch(() => fb),
        new Promise((r) => setTimeout(() => r(fb), ms)),
      ]);
      const RESEARCH_AGENTS = {
        exact:      { label: 'Точные нормы',           focus: 'нормы материального права, ПРЯМО обосновывающие требование (основание требования по предмету спора): конкретные статьи ГК КР, профильного закона, регулирующие именно это правоотношение' },
        related:    { label: 'Спец. и связанные нормы', focus: 'профильный СПЕЦИАЛЬНЫЙ закон/кодекс по предмету (земля→Земельный кодекс КР; потребитель→Закон «О защите прав потребителей»; строительство→Закон «О градостроительстве»; аренда/заём/подряд→соответствующие главы ГК) + последствия нарушения (реституция, убытки, неустойка, проценты, понуждение к исполнению в натуре)' },
        general:    { label: 'Общие нормы ГК',         focus: 'общие положения Гражданского кодекса КР: возникновение и исполнение обязательств; ответственность за неисполнение; сделки и их недействительность; право собственности; публичная оферта; заверения и гарантии застройщика/продавца; представительство и доверенность' },
        // Специализация 4-го агента зависит от типа документа.
        procedural: { label: 'Порядок и сроки',        focus: tpl.procFocus || 'процессуальные нормы и сроки по предмету обращения' },
        // 5-й агент (только для pressureDoc): административное и уголовное давление.
        enforcement:{ label: 'Администр. и уголовное давление', focus: 'административная ответственность юридических лиц и должностных лиц (Кодекс КР о правонарушениях): составы нарушений по предмету спора, размеры штрафов; уголовная ответственность руководителя/директора организации (УК КР): мошенничество, обман потребителей/покупателей, злоупотребление полномочиями, халатность; полномочия надзорных органов КР (Государственный строительный надзор, Государственная инспекция, ГКНА, прокуратура): право проводить внеплановые проверки и привлекать к ответственности; нарушения строительного законодательства и градостроительных норм' },
      };
      const procDefaults = Array.isArray(tpl.procDefaults) ? tpl.procDefaults : PROC_DEFAULTS;
      const researcherSys = (agent) => `Ты — юрист-исследователь права Кыргызской Республики, узкая специализация: «${agent.label}». Тебе дан диалог о деле для документа «${tpl.label}». Сформулируй 4-8 ТОЧНЫХ поисковых запросов к векторной базе НПА КР, чтобы найти ВСЕ нормы строго по своей специализации: ${agent.focus}. Верни СТРОГО JSON без markdown: { "queries": ["...", ...] }. Запросы развёрнутые — называй конкретные институты, кодексы, законы и статьи КР.`;

      stage('🧑‍⚖️ Коллегия исследователей ищет нормы параллельно (точные · связанные · общие · процессуальные)…');
      const t0 = Date.now();

      // Агент фактуры (facts/subject/legal_questions для драфтера) — параллельно с исследователями.
      const factsAgent = withTimeout((async () => {
        const raw = await clients.geminiJson({
          systemPrompt: PLANNER_SYS(tpl), userPrompt: `ДИАЛОГ:\n${convo}\n\nВерни JSON-план.`,
          model: 'gemini-3.1-flash-lite', maxOutputTokens: 2048, timeoutMs: 18000,
          onTokens: (m, i, o) => emitTele(res, { model: m, inputTokens: i, outputTokens: o, label: 'draft:planner' }),
        });
        return parseObj(raw) || {};
      })(), 20000, {});

      // 4 агента-исследователя: каждый сам → queries (LLM) → retrieval (Pinecone).
      const researchAgents = cats.map((cat) => withTimeout((async () => {
        const agent = RESEARCH_AGENTS[cat];
        let queries = [];
        try {
          const raw = await clients.geminiJson({
            systemPrompt: researcherSys(agent), userPrompt: `ДИАЛОГ:\n${convo}\n\nВерни JSON с queries.`,
            model: 'gemini-3.1-flash-lite', maxOutputTokens: 1536, timeoutMs: 18000,
            onTokens: (m, i, o) => emitTele(res, { model: m, inputTokens: i, outputTokens: o, label: `draft:researcher:${cat}` }),
          });
          const o = parseObj(raw);
          if (o && Array.isArray(o.queries)) queries = o.queries.slice(0, 8);
        } catch (e) { console.warn(`[draft-document] agent ${cat} query failed:`, e.message); }
        // Дефолтные запросы по типу агента (независимо от LLM-генерации).
        if (cat === 'procedural') queries = uniq([...queries, ...procDefaults]).slice(0, 10);
        if (cat === 'enforcement') {
          const enfDefs = Array.isArray(tpl.enforcementDefaults) ? tpl.enforcementDefaults : [];
          queries = uniq([...queries, ...enfDefs]).slice(0, 10);
        }
        if (!queries.length && cat === 'exact') queries = [String(tpl.label)];
        if (!queries.length) return { cat, hits: [] };
        let hits = [];
        try { hits = (await resolvedDeps.pineconeSearch?.(queries, null, 10)) || []; }
        catch (e) { console.warn(`[draft-document] agent ${cat} RAG failed:`, e.message); }
        // Прогресс конкретного агента в UI (по мере готовности).
        sse({ stage: `   ✓ ${agent.label}: запросов ${queries.length}, найдено статей ${hits.length}`, agent: cat, found: hits.length });
        return { cat, hits };
      })(), 22000, { cat, hits: [] }));

      const [factsRes, ...agentResults] = await Promise.all([factsAgent, ...researchAgents]);
      const plan = { facts: {}, subject_line: '', legal_questions: [], ...(factsRes || {}) };

      // Сводим находки всех агентов в общий пул (дедуп по статье; роль = специализация агента).
      const pool = new Map(); // key npa|article → {npa_title, article_title, full_text, score, cats:Set}
      const addHits = (hits, cat) => {
        for (const h of (hits || [])) {
          const md = (h && h.metadata) || {};
          if (!md.full_text) continue;
          const key = `${md.npa_title}|${md.article_title}`;
          let rec = pool.get(key);
          if (!rec) {
            rec = { npa_title: md.npa_title || '', article_title: md.article_title || '', full_text: String(md.full_text || '').slice(0, 1300), score: h.score || 0, cats: new Set() };
            pool.set(key, rec);
          }
          rec.cats.add(cat);
          if ((h.score || 0) > rec.score) rec.score = h.score || 0;
        }
      };
      for (const r of (agentResults || [])) addHits(r && r.hits, r && r.cat);
      console.log(`[draft-document] research board: ${pool.size} норм за ${Math.round((Date.now() - t0) / 1000)}с (агенты параллельно)`);

      // ── 3) Роль нормы = группа RAG по приоритету (без отдельного агента-отборщика).
      //     Берём ТОП по score внутри каждой роли — широкий охват всех видов норм.
      const roleOf = (rec) => rec.cats.has('exact') ? 'exact' : rec.cats.has('related') ? 'related' : rec.cats.has('enforcement') ? 'enforcement' : rec.cats.has('procedural') ? 'procedural' : 'general';
      const allNorms = Array.from(pool.values()).sort((a, b) => b.score - a.score);
      const caps = { exact: 10, related: 8, general: 6, procedural: 8, enforcement: 7 };
      const byRole = { exact: [], related: [], general: [], procedural: [], enforcement: [] };
      for (const rec of allNorms) {
        const role = roleOf(rec);
        if ((byRole[role] || []).length < (caps[role] || 5)) byRole[role].push(rec);
      }
      let refIdx = 0;
      const articlesUsed = [];
      const refParts = [];
      for (const cat of cats) {
        const arr = byRole[cat];
        if (!arr || !arr.length) continue;
        const lines = arr.map((a) => {
          refIdx += 1;
          articlesUsed.push([a.npa_title, a.article_title].filter(Boolean).join(' — '));
          return `[${refIdx}] ${[a.npa_title, a.article_title].filter(Boolean).join(' — ')}\n${a.full_text}`;
        });
        refParts.push(`=== ${CAT_LABEL[cat]} ===\n${lines.join('\n\n')}`);
      }
      const refBlock = refParts.length ? refParts.join('\n\n') : '(эталонных норм в базе не найдено — составляй фабулу без точных ссылок на статьи)';
      // Точный разброс по категориям — не просто "27 норм" (потолок cap), а реальные числа.
      const normBreakdown = [
        `точных: ${byRole.exact.length}`,
        `связанных: ${byRole.related.length}`,
        `процессуальных: ${byRole.procedural.length}`,
        `общих: ${byRole.general.length}`,
        byRole.enforcement.length ? `давление: ${byRole.enforcement.length}` : '',
      ].filter(Boolean).join(' · ');
      stage(`📚 Нашёл ${allNorms.length} норм, беру в работу ${refIdx} (${normBreakdown})`, { found: allNorms.length, used: refIdx });
      console.log(`[draft-document] ${docType} | pool=${allNorms.length} → used=${refIdx} | roles=${JSON.stringify(Object.fromEntries(cats.map((c) => [c, byRole[c].length])))}`);

      // ── 4) ДРАФТЕР (DeepSeek v4-pro) — статусы обновляются в onDelta ──
      const drafterUser = [
        `ТИП ДОКУМЕНТА: ${tpl.label}`,
        `ПРЕДМЕТ: ${plan.subject_line || ''}`,
        `ПРАВОВЫЕ ВОПРОСЫ: ${(plan.legal_questions || []).join('; ')}`,
        '',
        'ДОСЬЕ (факты от пользователя — используй ТОЛЬКО их, ничего не выдумывай):',
        JSON.stringify(plan.facts || {}, null, 2),
        '',
        'ИСХОДНЫЙ ДИАЛОГ (для нюансов):',
        convo,
        '',
        'ЭТАЛОННЫЕ НОРМЫ ИЗ БАЗЫ НПА КР (сгруппированы по роли — задействуй ВСЕ применимые, цитируй точно):',
        refBlock,
        '',
        'Составь ПОЛНЫЙ документ с развёрнутым правовым обоснованием и верни JSON-массив блоков (DocBlock[]).',
      ].join('\n');

      // Чистка CJK-артефактов: DeepSeek иногда вставляет иероглифы/полноширинную
      // пунктуацию в русский текст (баг модели). Кириллицу/латиницу не трогаем.
      const stripCjk = (s) => String(s).replace(/[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/g, '');
      // Авто-коррекция ошибок юрисдикции в тексте (не в cite-ссылках).
      // Ловит случаи, когда модель «вспоминает» казахстанский/российский контекст.
      const KR_FIXES = [
        [/\bтенге\b/gi, 'сом'],
        [/\bтеңге\b/gi, 'сом'],
        [/\bГК\s+РФ\b/g,  'ГК КР'],
        [/\bГПК\s+РФ\b/g, 'ГПК КР'],
        [/\bТК\s+РФ\b/g,  'ТК КР'],
        [/\bГК\s+РК\b/g,  'ГК КР'],
        [/\bГПК\s+РК\b/g, 'ГПК КР'],
        [/\bТК\s+РК\b/g,  'ТК КР'],
      ];
      const fixKr = (s) => {
        let out = String(s == null ? '' : s);
        for (const [re, repl] of KR_FIXES) out = out.replace(re, repl);
        return out;
      };

      // Нормализация одного блока (защита фронт-рендера от мусора + КР-фиксы).
      const normalizeBlock = (b) => ({
        kind: String((b && b.kind) || 'paragraph'),
        ...(b && b.align ? { align: String(b.align) } : {}),
        ...((b && b.kind) === 'requisites_table' ? {
          left:  fixKr(stripCjk(String((b && b.left)  || ''))),
          right: fixKr(stripCjk(String((b && b.right) || ''))),
        } : {}),
        runs: Array.isArray(b && b.runs)
          ? b.runs.filter((r) => r && typeof r === 'object').map((r) => ({
              t: fixKr(stripCjk(String(r.t == null ? '' : r.t))),
              ...(r.bold ? { bold: true } : {}),
              ...(r.italic ? { italic: true } : {}),
              ...(r.underline ? { underline: true } : {}),
              ...(r.cite ? { cite: String(r.cite) } : {}),
            }))
          : [],
      });

      // Инкрементальный парсер JSON-массива: по мере того как v4-pro пишет
      // массив блоков, выдёргиваем КАЖДЫЙ закрытый top-level объект и сразу
      // шлём его событием { block } → во фронте документ появляется по частям.
      // Состояние держим между дельтами (acc только растёт, scan не сбрасываем).
      let acc = '';
      let scan = 0, depth = 0, inStr = false, esc = false, objStart = -1;
      let streamedCount = 0;
      let hbReason = 0;
      // Прогресс reasoning-фазы (до появления первого text-токена)
      let reasoningChars = 0, reasoningPhase = 0;
      // Последний kind/block-count для авто-статусов во время генерации
      let lastStreamedKind = null, lastStatusCount = 0;
      const emitStreamBlock = (normalized) => {
        // Spacer ДО заголовка
        if (SPACER_BEFORE_KINDS.has(normalized.kind) && lastStreamedKind && lastStreamedKind !== 'spacer') {
          streamedCount += 1;
          sse({ block: { kind: 'spacer', runs: [] } });
        }
        streamedCount += 1;
        sse({ block: normalized });
        lastStreamedKind = normalized.kind;
        // Spacer ПОСЛЕ заголовка (section_heading, demand_heading, attachment_heading)
        if (SPACER_AFTER_KINDS.has(normalized.kind)) {
          streamedCount += 1;
          sse({ block: { kind: 'spacer', runs: [] } });
          lastStreamedKind = 'spacer';
        }
      };
      const feedStream = () => {
        for (; scan < acc.length; scan++) {
          const ch = acc[scan];
          if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
          }
          if (ch === '"') { inStr = true; continue; }
          if (ch === '{') { if (depth === 0) objStart = scan; depth += 1; }
          else if (ch === '}') {
            if (depth > 0) {
              depth -= 1;
              if (depth === 0 && objStart !== -1) {
                const objStr = acc.slice(objStart, scan + 1);
                objStart = -1;
                try {
                  const o = JSON.parse(objStr);
                  if (o && (o.kind || o.runs)) { emitStreamBlock(normalizeBlock(o)); }
                } catch (_) { /* объект ещё не дописан корректно — пропускаем */ }
              }
            }
          }
        }
      };
      const onDelta = (d) => {
        if (!d) return;
        // ── Reasoning-фаза (DeepSeek думает, text ещё не идёт) ──
        // heartbeat + прогрессивные статусы чтобы юрист видел что система работает.
        if (d.reasoning) {
          hbReason += d.reasoning.length;
          reasoningChars += d.reasoning.length;
          if (hbReason > 1500) { hbReason = 0; sse({ heartbeat: 1 }); }
          if (reasoningPhase === 0) {
            reasoningPhase = 1;
            stage(`🧠 Анализирую правовые основания (${refIdx} норм)…`);
          } else if (reasoningChars > 3000 && reasoningPhase === 1) {
            reasoningPhase = 2;
            stage('🧠 Формирую структуру документа и аргументацию…');
          } else if (reasoningChars > 7000 && reasoningPhase === 2) {
            reasoningPhase = 3;
            stage('✍️ Готовлю текст документа…');
          }
        }
        // ── Text-фаза (JSON-блоки льются) ──
        if (d.text) {
          acc += d.text;
          feedStream();
          // Обновляем статус на каждый новый блок (но не чаще 1 раза на 3 блока).
          if (streamedCount > lastStatusCount) {
            lastStatusCount = streamedCount;
            if (streamedCount === 1) {
              stage(`✍️ Пишу документ… (блок 1 из ~${refIdx} норм)`);
            } else if (streamedCount % 3 === 0) {
              stage(`✍️ Написано блоков: ${streamedCount}…`);
            }
          }
        }
      };
      // Заголовок: для типов с фиксированным titleWord — он; для «Прочее»/письма —
      // выводим из досье (docName), иначе из subject_line.
      const effTitle = tpl.titleWord
        || String((plan.facts && (plan.facts.docName || plan.facts.title)) || '').trim().toUpperCase()
        || '';
      const { text: draftText, model: usedModel, usage: drafterUsage } = await clients.deepseekReason({
        systemPrompt: DRAFTER_SYS(tpl, effTitle),
        userPrompt: drafterUser,
        model: 'deepseek-v4-pro', reasoning_effort: 'high', thinking: 'enabled',
        onDelta,
      });
      if (drafterUsage && (drafterUsage.inputTokens || drafterUsage.outputTokens)) {
        emitTele(res, { model: usedModel, inputTokens: drafterUsage.inputTokens, outputTokens: drafterUsage.outputTokens, label: 'draft:drafter' });
      }

      // Финальный парс целиком ([...] или {blocks:[...]}) — канонический результат
      // и фолбэк, если стрим-парсер что-то не выдернул (или формат-обёртка).
      const cleaned = String(draftText || '').replace(/```json\s*/gi, '').replace(/```/g, '').trim();
      const tryParse = (s) => { try { return JSON.parse(s); } catch (_) { return null; } };
      let parsed = tryParse(cleaned);
      if (!parsed) { const la = cleaned.indexOf('['), lb = cleaned.lastIndexOf(']'); if (la !== -1 && lb > la) parsed = tryParse(cleaned.slice(la, lb + 1)); }
      if (!parsed) { const oa = cleaned.indexOf('{'), ob = cleaned.lastIndexOf('}'); if (oa !== -1 && ob > oa) parsed = tryParse(cleaned.slice(oa, ob + 1)); }
      let blocks = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.blocks) ? parsed.blocks : null);

      if (!Array.isArray(blocks) || !blocks.length) {
        if (streamedCount > 0) {
          // Стрим уже доставил блоки клиенту — финальный JSON-парс упал (обрыв/обёртка),
          // но документ на фронте уже есть. Отдаём done с пустым blocks — фронт
          // использует накопленный streamed[] как finalBlocks.
          console.warn(`[draft-document] final JSON parse failed, but ${streamedCount} blocks already streamed — graceful recovery`);
          sse({ done: true, blocks: [], articlesUsed: [], review: null });
          return done();
        }
        console.warn(`[draft-document] unparseable drafter output (len=${String(draftText || '').length}): ${String(draftText || '').slice(0, 200)}`);
        sse({ error: 'Драфтер вернул некорректный формат. Попробуйте ещё раз.' });
        return done();
      }

      // injectSpacers: гарантирует отступы между разделами независимо от того,
      // вставил ли драфтер spacer'ы самостоятельно. Применяется к финальному массиву
      // (используется фронтом в fallback-режиме renderLegalDocument).
      const safeBlocks = injectSpacers(
        blocks.filter((b) => b && typeof b === 'object').map(normalizeBlock),
      );

      console.log(`[draft-document] ${docType} → ${safeBlocks.length} блоков (streamed=${streamedCount}) | norms=${articlesUsed.length} | model=${usedModel}`);

      // ── 5) САМОПРОВЕРКА — контролёр сверяет готовый документ с эталоном RAG ──
      // Замыкает цикл «создал → проверил»: ловит выдуманные/перепутанные ссылки
      // и незаполненные обязательные места. Лёгкая модель, бюджет ~18с, graceful.
      stage('🔎 Проверяю готовый документ…');
      let review = null;
      try {
        const docText = safeBlocks
          .map((b) => (b.runs || []).map((r) => r.t).join(''))
          .filter((s) => s.trim())
          .join('\n');
        const SELFCHECK_SYS = `Ты — контролёр качества юридического документа (право Кыргызской Республики). Тебе дан ГОТОВЫЙ документ и ЭТАЛОННЫЕ нормы из базы (RAG).

ПРОВЕРЬ ПО ПЯТИ КРИТЕРИЯМ:

1. ССЫЛКИ НА НПА — все статьи соответствуют эталону (нет выдуманных или перепутанных номеров); все законы являются законами Кыргызской Республики (не РФ, не РК и т.д.); нет «ГК РФ», «ГПК РФ», «ГК РК» и подобных.

2. ВАЛЮТА И ЮРИСДИКЦИЯ — в документе используется «сом» (сом КР / KGS), а не «тенге», «рубль», «гривна» или иная иностранная валюта (если только пользователь явно её не указывал). Суды — только Кыргызской Республики.

3. ПУСТЫЕ ОБЯЗАТЕЛЬНЫЕ ПОЛЯ — нет ли мест «____», которые должны были заполниться из досье (ФИО сторон, суммы, даты), но остались пустыми.
   ВАЖНО: некоторые поля традиционно заполняются ВРУЧНУЮ самим юристом и их отсутствие — НЕ ошибка, а информация:
   — ПИН работника / ИНН физического лица
   — Паспортные данные (серия, номер, кем выдан)
   — Номер и дата государственной регистрации работодателя / учредительных документов
   — Банковские реквизиты сторон (р/с, БИК, банк)
   — Подписи и печати сторон
   Такие поля помечай severity:"low" с текстом «Требует ручного заполнения: [название поля]».

4. СТРУКТУРА И ЛОГИКА — нет ли критических пробелов: отсутствие требования/просьбы, нет правового обоснования, нет подписи, незавершённые пункты.

5. СООТВЕТСТВИЕ ДОСЬЕ — сведения в документе не противоречат тому, что пользователь сообщил в диалоге (суммы, стороны, предмет).

Верни СТРОГО JSON без markdown:
{ "ok": <bool>, "issues": [ { "severity": "high|medium|low", "text": "<кратко: что не так и как исправить>" } ] }
Если всё в порядке — ok:true, issues:[].
НЕ придирайся к шаблонным прочеркам «____» там, где данных не было в досье.
НЕ считай ошибкой упоминание иностранной валюты, если пользователь сам её назвал в диалоге.`;
        const rawRev = await withTimeout((async () => clients.geminiJson({
          systemPrompt: SELFCHECK_SYS,
          userPrompt: `ЭТАЛОННЫЕ НОРМЫ:\n${refBlock}\n\nГОТОВЫЙ ДОКУМЕНТ:\n${docText.slice(0, 20000)}\n\nВерни JSON-вывод проверки.`,
          model: 'gemini-3.1-flash-lite', maxOutputTokens: 2500, timeoutMs: 22000,
          onTokens: (m, i, o) => emitTele(res, { model: m, inputTokens: i, outputTokens: o, label: 'draft:selfcheck' }),
        }))(), 25000, null);
        const rev = parseObj(rawRev);
        if (rev && typeof rev === 'object') {
          const issues = Array.isArray(rev.issues) ? rev.issues
            .filter((i) => i && i.text)
            .slice(0, 10)
            .map((i) => ({ severity: ['high', 'medium', 'low'].includes(i.severity) ? i.severity : 'medium', text: stripCjk(String(i.text)).slice(0, 280) }))
            : [];
          review = { ok: !!rev.ok && issues.length === 0, issues };
        }
      } catch (e) { console.warn('[draft-document] self-check failed:', e.message); }

      // Этап 4: параллельно с отправкой done — генерируем .docx для ONLYOFFICE
      let docxFileId = null;
      try {
        const title = String((plan.facts && (plan.facts.docName || plan.facts.title)) || docType || '').trim();
        const result = await buildDocx(safeBlocks, { docType, title });
        docxFileId = result.fileId;
      } catch (e) {
        console.warn('[draft-document] docx generation failed (non-fatal):', e.message);
      }

      sse({
        done: true,
        blocks: safeBlocks,
        streamedCount,
        articlesUsed,
        review,
        route: { planner: 'gemini-3.1-flash-lite', retrieval: 'rag-4groups', drafter: usedModel, reviewer: 'gemini-3.1-flash-lite' },
        ...(docxFileId ? { docxFileId } : {}),
      });
      return done();
    } catch (err) {
      console.error('[draft-document] error:', err.message);
      sse({ error: 'Сбой генерации: ' + err.message });
      return done();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  ГЛУБОКАЯ ПРОВЕРКА — двухэтапный анализ по типовому чеклисту
  //  /api/v2/deep-check-document — вызывается вручную кнопкой «Глубокий анализ»
  //  Этап 1: Gemini 2.5 Flash ищет ВСЕ потенциальные нарушения по чеклисту
  //  Этап 2: Параллельная верификация каждого нарушения (adversarial: опровергни!)
  //  Подтверждённые нарушения → результат с оценкой качества (score 0-100)
  // ═══════════════════════════════════════════════════════════════════════
  router.post('/deep-check-document', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const sse  = (obj) => { if (!res.writableEnded) res.write('data: ' + JSON.stringify(obj) + '\n\n'); };
    const done = () => { if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); } };
    const stage = (text) => sse({ stage: text });
    const hb = setInterval(() => { if (!res.writableEnded) res.write(':hb\n\n'); }, 20000);
    const finish = () => { clearInterval(hb); done(); };

    try {
      const docType  = String((req.body && req.body.docType)  || 'custom');
      const blocks   = Array.isArray(req.body && req.body.blocks)   ? req.body.blocks   : [];
      const messages = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];

      if (!blocks.length) { sse({ error: 'Нет блоков документа' }); return finish(); }

      // Локальные утилиты
      const dcParseObj = (raw) => {
        const c = String(raw || '').replace(/```json\s*/gi, '').replace(/```/g, '').trim();
        try { return JSON.parse(c); } catch (_) {}
        const a = c.indexOf('{'), b = c.lastIndexOf('}');
        if (a !== -1 && b > a) { try { return JSON.parse(c.slice(a, b + 1)); } catch (__) {} }
        return null;
      };
      const dcArrParseObj = (raw) => {
        const c = String(raw || '').replace(/```json\s*/gi, '').replace(/```/g, '').trim();
        try { return JSON.parse(c); } catch (_) {}
        const a = c.indexOf('['), b = c.lastIndexOf(']');
        if (a !== -1 && b > a) { try { return JSON.parse(c.slice(a, b + 1)); } catch (__) {} }
        return null;
      };
      const dcTimeout = (p, ms, fb) => Promise.race([
        Promise.resolve(p).catch(() => fb),
        new Promise((r) => setTimeout(() => r(fb), ms)),
      ]);

      // Текст документа (до 20 000 символов — полный охват большинства документов)
      const docText = blocks
        .map((b) => {
          if (!b || b.kind === 'spacer') return '';
          if (b.kind === 'requisites_table') return `${b.left || ''} | ${b.right || ''}`;
          return (b.runs || []).map((r) => r && r.t ? r.t : '').join('');
        })
        .filter((s) => s.trim())
        .join('\n');

      const tpl = (typeof getTemplate === 'function') ? getTemplate(docType) : null;
      const checklist = DEEP_TYPE_CHECKLISTS[docType] || DEEP_TYPE_CHECKLISTS['custom'];
      const docLabel  = (tpl && tpl.label) || docType;

      stage('📋 Читаю документ по чеклисту…');

      // ─── ЭТАП 1: ПОИСК НАРУШЕНИЙ (Gemini 2.5 Flash, широкий взгляд) ───
      const FINDER_SYS = `Ты — старший юрист-аудитор (право Кыргызской Республики).
Проверяешь готовый документ «${docLabel}» по обязательному чеклисту и общим юридическим требованиям.

ЧЕКЛИСТ ОБЯЗАТЕЛЬНЫХ ЭЛЕМЕНТОВ:
${checklist}

ЗАДАЧА: Найди ВСЕ нарушения, упущения и слабые места. Будь строгим и придирчивым.
Для каждого нарушения укажи:
- category: "НПА" | "Структура" | "Реквизиты" | "Юрисдикция" | "Логика"
- severity: "high" (нарушение закона) | "medium" (существенное упущение) | "low" (рекомендация)
- claim: одна фраза — суть нарушения
- location: где именно в документе (раздел/пункт/блок)
- article_hint: конкретная статья НПА КР (или "")

Поля ПИН, паспорт, банковские реквизиты, регистрационные номера — отмечай как low ("ручное заполнение").

Верни СТРОГО JSON-массив без markdown:
[ { "category": "...", "severity": "...", "claim": "...", "location": "...", "article_hint": "..." } ]
Если нарушений нет — верни [].`;

      const rawFindings = await dcTimeout((async () => clients.geminiJson({
        systemPrompt: FINDER_SYS,
        userPrompt: `ДОКУМЕНТ:\n${docText.slice(0, 20000)}\n\nНайди все нарушения и верни JSON-массив.`,
        model: 'gemini-3.1-flash-lite', maxOutputTokens: 3000, timeoutMs: 28000,
        onTokens: (m, i, o) => emitTele(res, { model: m, inputTokens: i, outputTokens: o, label: 'deepcheck:finder' }),
      }))(), 32000, null);

      let candidates = dcArrParseObj(rawFindings);
      if (!Array.isArray(candidates)) candidates = [];
      candidates = candidates.filter((f) => f && f.claim).slice(0, 12);

      if (!candidates.length) {
        sse({ done: true, findings: [], score: 100, summary: 'Нарушений не обнаружено. Документ соответствует чеклисту.' });
        return finish();
      }

      stage(`🔍 Найдено ${candidates.length} потенциальных замечаний. Верифицирую параллельно…`);

      // ─── ЭТАП 2: ПАРАЛЛЕЛЬНАЯ ВЕРИФИКАЦИЯ (adversarial — попробуй опровергнуть) ───
      const VERIFIER_SYS = `Ты — независимый юрист-скептик. Тебе предъявлено замечание к документу.
ЗАДАЧА: Попытайся ОПРОВЕРГНУТЬ замечание. Найди в тексте документа фразу, которая его опровергает.
Если замечание всё же подтверждается — подтверди с кратким объяснением.

Верни СТРОГО JSON без markdown:
{ "confirmed": <bool>, "reason": "<1-2 предложения: почему подтверждено или опровергнуто>" }`;

      const verifyOne = async (finding, idx) => {
        const raw = await dcTimeout((async () => clients.geminiJson({
          systemPrompt: VERIFIER_SYS,
          userPrompt: `ЗАМЕЧАНИЕ: ${finding.claim}\nМЕСТО: ${finding.location}\n\nФРАГМЕНТ ДОКУМЕНТА:\n${docText.slice(0, 8000)}\n\nПодтверди или опровергни. Верни JSON.`,
          model: 'gemini-3.1-flash-lite', maxOutputTokens: 400, timeoutMs: 18000,
          onTokens: (m, i, o) => emitTele(res, { model: m, inputTokens: i, outputTokens: o, label: 'deepcheck:verifier' }),
        }))(), 20000, null);
        const v = dcParseObj(raw);
        if (!v || typeof v.confirmed !== 'boolean') return { ...finding, confirmed: true, reason: '' };
        return { ...finding, confirmed: v.confirmed, reason: String(v.reason || '').slice(0, 300) };
      };

      const verified = await Promise.all(candidates.map((f, i) => verifyOne(f, i)));
      const findings = verified.filter((f) => f.confirmed);

      // Оценка качества (score 0–100)
      let score = 100;
      for (const f of findings) {
        if (f.severity === 'high')   score -= 15;
        else if (f.severity === 'medium') score -= 8;
        else score -= 2;
      }
      score = Math.max(10, Math.min(100, score));

      const highCount = findings.filter((f) => f.severity === 'high').length;
      const medCount  = findings.filter((f) => f.severity === 'medium').length;
      const summary = findings.length === 0
        ? 'Документ прошёл глубокую проверку — нарушений не выявлено.'
        : `Подтверждено ${findings.length} замечани${findings.length === 1 ? 'е' : findings.length < 5 ? 'я' : 'й'}: ${highCount ? `критических — ${highCount}, ` : ''}${medCount ? `существенных — ${medCount}` : ''}. Оценка: ${score}/100.`;

      console.log(`[deep-check] ${docType} | candidates=${candidates.length} confirmed=${findings.length} score=${score}`);
      sse({ done: true, findings, score, summary });
      return finish();
    } catch (err) {
      console.error('[deep-check] error:', err.message);
      sse({ error: 'Сбой глубокой проверки: ' + err.message });
      return finish();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  ПАТЧ-ДОКУМЕНТА — точечное исправление замечаний самопроверки
  //  /api/v2/patch-document — принимает текущие блоки + issues[], точечно
  //  правит только проблемные места, возвращает патченные блоки + новый review.
  // ═══════════════════════════════════════════════════════════════════════
  router.post('/patch-document', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const sse = (obj) => { if (!res.writableEnded) res.write('data: ' + JSON.stringify(obj) + '\n\n'); };
    const done = () => { if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); } };
    const stage = (text) => sse({ stage: text });
    // heartbeat — держит соединение живым
    const hb = setInterval(() => { if (!res.writableEnded) res.write(':hb\n\n'); }, 20000);
    const finish = () => { clearInterval(hb); done(); };

    try {
      const docType  = String((req.body && req.body.docType)  || 'isk');
      const messages = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
      const blocks   = Array.isArray(req.body && req.body.blocks)   ? req.body.blocks   : [];
      const issues   = Array.isArray(req.body && req.body.issues)   ? req.body.issues   : [];

      if (!blocks.length) { sse({ error: 'Нет блоков документа' }); return finish(); }
      if (!issues.length) { sse({ error: 'Нет замечаний для исправления' }); return finish(); }

      // Локальные утилиты (аналоги из draft-document, scope здесь отдельный)
      const pParseObj = (raw) => {
        const c = String(raw || '').replace(/```json\s*/gi, '').replace(/```/g, '').trim();
        try { return JSON.parse(c); } catch (_) {}
        const a = c.indexOf('{'), b = c.lastIndexOf('}');
        if (a !== -1 && b > a) { try { return JSON.parse(c.slice(a, b + 1)); } catch (__) {} }
        return null;
      };
      const pWithTimeout = (p, ms, fb) => Promise.race([
        Promise.resolve(p).catch(() => fb),
        new Promise((r) => setTimeout(() => r(fb), ms)),
      ]);
      const pStripCjk = (s) => String(s).replace(/[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/g, '');
      const KR_FIXES_P = [
        [/\bтенге\b/gi, 'сом'], [/\bтеңге\b/gi, 'сом'],
        [/\bГК\s+РФ\b/g, 'ГК КР'],  [/\bГПК\s+РФ\b/g, 'ГПК КР'], [/\bТК\s+РФ\b/g, 'ТК КР'],
        [/\bГК\s+РК\b/g, 'ГК КР'],  [/\bГПК\s+РК\b/g, 'ГПК КР'], [/\bТК\s+РК\b/g, 'ТК КР'],
      ];
      const pFixKr = (s) => { let o = String(s == null ? '' : s); for (const [re, r] of KR_FIXES_P) o = o.replace(re, r); return o; };

      stage('🔎 Анализирую замечания…');

      // Сериализуем блоки с индексами (только содержательные, не spacer)
      const blockSummary = blocks.map((b, idx) => {
        if (!b || b.kind === 'spacer') return null;
        const text = b.kind === 'requisites_table'
          ? `[ЛЕВАЯ:${(b.left||'').slice(0,120)}][ПРАВАЯ:${(b.right||'').slice(0,120)}]`
          : (b.runs || []).map(r => r && r.t ? r.t : '').join('').slice(0, 300);
        if (!text.trim()) return null;
        return `[${idx}] ${b.kind}: ${text}`;
      }).filter(Boolean).join('\n');

      const issuesList = issues
        .filter(i => i && i.text && i.severity !== 'low')
        .map((it, n) => `${n + 1}. [${it.severity}] ${it.text}`)
        .join('\n');

      if (!issuesList.trim()) {
        // Только low-замечания — нечего патчить автоматически
        sse({ done: true, blocks, streamedCount: 0, articlesUsed: [], review: null, patched: false });
        return finish();
      }

      const PATCH_SYS = `Ты — юридический редактор (право Кыргызской Республики).
Тебе дан документ (список блоков с индексами) и замечания самопроверки.

ЗАДАЧА: Исправь ТОЛЬКО те блоки, которые соответствуют конкретным замечаниям.
Не трогай блоки без замечаний. Если замечание требует добавить поле — вставь прочерк «____».

ЮРИСДИКЦИЯ: валюта «сом» (KGS), НПА только КР (ГК КР, ТК КР, ГПК КР), органы КР.

Верни СТРОГО JSON без markdown:
{
  "patches": [
    { "idx": <индекс блока из списка>, "newText": "<полный новый текст блока>" }
  ],
  "explanation": "<кратко что исправлено>"
}
Если замечание нельзя исправить заменой текста конкретного блока — пропусти его.`;

      stage('✏️ Составляю исправления…');
      const rawPatch = await pWithTimeout((async () => clients.geminiJson({
        systemPrompt: PATCH_SYS,
        userPrompt: `ДОКУМЕНТ (блоки):\n${blockSummary}\n\nЗАМЕЧАНИЯ:\n${issuesList}\n\nВерни JSON исправлений.`,
        model: 'gemini-3.1-flash-lite', maxOutputTokens: 2500, timeoutMs: 22000,
        onTokens: (m, i, o) => emitTele(res, { model: m, inputTokens: i, outputTokens: o, label: 'patch:editor' }),
      }))(), 25000, null);

      const patchResult = pParseObj(rawPatch);
      const patches = (patchResult && Array.isArray(patchResult.patches)) ? patchResult.patches : [];

      if (!patches.length) {
        console.warn('[patch-document] no patches produced');
        sse({ done: true, blocks, streamedCount: 0, articlesUsed: [], review: null, patched: false });
        return finish();
      }

      stage('📝 Применяю исправления…');
      // Применяем патчи к блокам
      const patchedBlocks = blocks.map((b, idx) => {
        const patch = patches.find(p => p && Number(p.idx) === idx);
        if (!patch || !patch.newText) return b;
        if (!b || b.kind === 'spacer' || b.kind === 'requisites_table') return b;
        // Заменяем runs одним run с исправленным текстом, сохраняя форматирование первого run
        const firstRun = Array.isArray(b.runs) && b.runs[0] ? b.runs[0] : {};
        return {
          ...b,
          runs: [{
            t: pFixKr(pStripCjk(String(patch.newText))),
            b: firstRun.b || false,
            i: firstRun.i || false,
            u: firstRun.u || false,
            size: firstRun.size || null,
            color: firstRun.color || null,
          }],
        };
      });

      // Повторная самопроверка на патченных блоках
      stage('🔎 Повторная самопроверка…');
      let review = null;
      try {
        const docText = patchedBlocks
          .map((b) => (b && b.runs || []).map((r) => r.t).join(''))
          .filter((s) => s && s.trim())
          .join('\n');

        const SELFCHECK_PATCH = `Ты — контролёр качества юридического документа (Кыргызстан).
Проверь ТОЛЬКО критические ошибки (high/medium): неверные НПА, неправильная валюта, пустые ключевые поля.
Поля ПИН, паспорт, реквизиты, регистрационные номера — помечай severity:"low" («ручное заполнение»), не высоким.
Верни СТРОГО JSON: { "ok": <bool>, "issues": [ { "severity": "high|medium|low", "text": "..." } ] }`;

        const rawRev = await pWithTimeout((async () => clients.geminiJson({
          systemPrompt: SELFCHECK_PATCH,
          userPrompt: `ДОКУМЕНТ:\n${docText.slice(0, 12000)}\n\nВерни JSON-вывод проверки.`,
          model: 'gemini-3.1-flash-lite', maxOutputTokens: 1200, timeoutMs: 15000,
          onTokens: (m, i, o) => emitTele(res, { model: m, inputTokens: i, outputTokens: o, label: 'patch:selfcheck' }),
        }))(), 18000, null);

        const rev = pParseObj(rawRev);
        if (rev && typeof rev === 'object') {
          const iss = Array.isArray(rev.issues)
            ? rev.issues.filter(i => i && i.text).slice(0, 6)
              .map(i => ({ severity: ['high','medium','low'].includes(i.severity) ? i.severity : 'medium', text: pStripCjk(String(i.text)).slice(0, 280) }))
            : [];
          review = { ok: !!rev.ok && iss.length === 0, issues: iss };
        }
      } catch (e) { console.warn('[patch-document] self-check failed:', e.message); }

      console.log(`[patch-document] ${docType} → ${patches.length} patches applied`);
      sse({ done: true, blocks: patchedBlocks, streamedCount: 0, articlesUsed: [], review, patched: true });
      return finish();
    } catch (err) {
      console.error('[patch-document] error:', err.message);
      sse({ error: 'Сбой исправления: ' + err.message });
      return finish();
    }
  });

  return router;
}

module.exports = {
  createAnalyzeV2Router,
  // экспорт чистых функций для smoke-тестов
  _internals: {
    buildInjectedContext, twoStagePineconeFilter,
    pickJudgeRoute, computeMetrics,
    toStepStatus, verdictToRow,
  },
};
