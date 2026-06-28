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

  // Agent 1: triage + НПА + статья + синонимы
  const ex = (await deps.expandQuery?.(agentText)) || { skip: false, npa: null, article: null, queries: [chunkText] };

  // Пропуск нейтральных фрагментов: реквизиты, имена, должности, даты, подписи.
  // Юридическая оценка не нужна — сразу возвращаем correct без вызова Supabase/валидатора.
  if (ex.skip) {
    return {
      index, npa: null, article: null,
      status: 'correct', marker: '✅ Верно', detail: '', cited_articles: [],
      blind_spot: false, triageType: 'SKIP', thesis: '',
    };
  }

  const queries = (Array.isArray(ex.queries) && ex.queries.length) ? ex.queries : [chunkText];

  // Привязка к НПА для поиска: если Агент-1 не распознал НПА в «голом» блоке
  // (Orphan Chunk — кодекс остался в предыдущем блоке), берём sticky-НПА из
  // контекста раздела. Только для retrieval-фильтра Pinecone — в отображаемый
  // вердикт sticky-НПА НЕ тащим (показываем лишь то, что блок реально цитирует).
  const searchNpa = ex.npa || (meta && meta.npa) || null;

  let v;
  if (!ex.npa && !ex.article) {
    // Нет явной ссылки на НПА/статью в тексте фрагмента — проверять нечего.
    // Запрос в Supabase не делаем: нет цитаты → нет нормоконтроля.
    v = { status: 'correct', marker: '✅ Верно', detail: '', cited_articles: [] };
  } else {
    // Есть явная ссылка → ищем в базе и проверяем.
    const hits = (await deps.pineconeSearch?.(queries, searchNpa)) || [];
    const articles = twoStagePineconeFilter(hits);

    if (articles.length === 0) {
      // Ссылка заявлена, но эталона в базе нет → Слепая зона (ручная проверка).
      v = { status: 'unverified', marker: '⚠️ Слепая зона', detail: 'Ссылка не подтверждена базой НПА — нужна ручная проверка', cited_articles: [] };
    } else {
      // Agent 2: нормоконтроль по эталону (получает agentText с lead-in).
      v = (await deps.validate?.({ chunkText: agentText, ctx, articles, npa: ex.npa, article: ex.article })) ||
          { status: 'correct', marker: '✅ Верно', detail: '', cited_articles: [] };
    }
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

// Двухступенчатый фильтр. Пороги были для Pinecone (cosine 0.7-0.95).
// Supabase hybrid search возвращает scores в диапазоне 0.0-0.5 → absThreshold
// снижен до 0.01 (практически отключён). Относительный хвост 0.25 оставлен:
// берём всё в пределах 0.25 от лучшего результата.
function twoStagePineconeFilter(hits, absThreshold = 0.01, tail = 0.25) {
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
По собранному диалогу подготовь ПЛАН составления документа «${tpl.label}».

Применимые кодексы/НПА (ориентир): ${(tpl.codesHint || []).join('; ')}.

Верни СТРОГО JSON без markdown:
{
  "facts": {
    ${(tpl.requiredFields || []).concat(tpl.optionalFields || []).map((f) => `"${f.key}": "<${f.title}: что известно из диалога, дословно факты; '' если не сказано>"`).join(',\n    ')}
  },
  "subject_line": "<краткая формулировка предмета для подзаголовка, напр. 'о признании договора недействительным'>",
  "legal_questions": ["<1-3 ключевых правовых вопроса дела>"]
}

ПРАВИЛА: факты бери ТОЛЬКО из диалога, не выдумывай имена/суммы/даты/адреса (нет → '').`;

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
            rec = { npa_title: md.npa_title || '', article_title: md.article_title || '', full_text: String(md.full_text || ''), score: h.score || 0, cats: new Set() };
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

      // ── 5) .DOCX — генерируем до отправки done:true ──
      let docxFileId = null;
      try {
        const title = String((plan.facts && (plan.facts.docName || plan.facts.title)) || docType || '').trim();
        const result = await buildDocx(safeBlocks, { docType, title });
        docxFileId = result.fileId;
      } catch (e) {
        console.warn('[draft-document] docx generation failed (non-fatal):', e.message);
      }

      // ── 6) DONE:TRUE — юрист получает документ немедленно ──
      // review придёт отдельным SSE-событием после самопроверки (async ниже).
      sse({
        done: true,
        blocks: safeBlocks,
        streamedCount,
        articlesUsed,
        review: null,
        route: { planner: 'gemini-3.1-flash-lite', retrieval: 'rag-4groups', drafter: usedModel, reviewer: 'gemini-3.1-flash-lite' },
        ...(docxFileId ? { docxFileId } : {}),
      });

      // ── 7) САМОПРОВЕРКА — асинхронно, не блокирует юриста ──
      // done:true уже отправлен → кнопки «Скачать» разблокированы.
      // Самопроверка идёт в фоне и завершается событием { review }.
      stage('🔎 Проверяю готовый документ…');
      (async () => {
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
        if (!res.writableEnded) { sse({ review }); done(); }
      })();
      return; // done() вызовет async IIFE после самопроверки
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

  // ═══════════════════════════════════════════════════════════════════════
  //  ГЛУБОКИЙ АНАЛИЗ — /api/v2/analyze-deep
  //  Параллельный аудит загруженного документа: Структура + Логика + Стратегия.
  //  Каждый агент ОБЯЗАН цитировать текст документа (анти-галлюцинация Layer 1).
  //  Adversarial verifier опровергает ложные срабатывания (Layer 2).
  //  DeepSeek v4-flash (fast) стримит Executive Summary.
  // ═══════════════════════════════════════════════════════════════════════
  router.post('/analyze-deep', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const sse  = (obj) => { if (!res.writableEnded) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); if (typeof res.flush === 'function') res.flush(); } };
    const done = () => { if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); } };
    const stage = (text) => sse({ stage: text });
    const hb = setInterval(() => { if (!res.writableEnded) res.write(':hb\n\n'); }, 20000);
    const finish = () => { clearInterval(hb); done(); };

    try {
      const docText = String((req.body && req.body.documentText) || '').slice(0, 30000).trim();
      if (docText.length < 80) { sse({ error: 'Документ слишком короткий для глубокого анализа' }); return finish(); }

      const adTimeout = (p, ms, fb) => Promise.race([
        Promise.resolve(p).catch(() => fb),
        new Promise(r => setTimeout(() => r(fb), ms)),
      ]);
      const adParseArr = (raw) => {
        const c = String(raw || '').replace(/```json\s*/gi, '').replace(/```/g, '').trim();
        try { const o = JSON.parse(c); return Array.isArray(o) ? o : (Array.isArray(o.findings) ? o.findings : []); } catch (_) {}
        const a = c.indexOf('['), b = c.lastIndexOf(']');
        if (a !== -1 && b > a) { try { return JSON.parse(c.slice(a, b + 1)); } catch (_) {} }
        const oa = c.indexOf('{'), oc = c.lastIndexOf('}');
        if (oa !== -1 && oc > oa) { try { const o = JSON.parse(c.slice(oa, oc + 1)); return Array.isArray(o.findings) ? o.findings : []; } catch (_) {} }
        return [];
      };
      const adParseObj = (raw) => {
        const c = String(raw || '').replace(/```json\s*/gi, '').replace(/```/g, '').trim();
        try { return JSON.parse(c); } catch (_) {}
        const a = c.indexOf('{'), b = c.lastIndexOf('}');
        if (a !== -1 && b > a) { try { return JSON.parse(c.slice(a, b + 1)); } catch (_) {} }
        return null;
      };
      const adStrip = (s) => String(s || '').replace(/[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/g, '');
      const normFinding = (f, defaultCat) => ({
        severity: ['high', 'medium', 'low'].includes(f.severity) ? f.severity : 'medium',
        category: adStrip(String(f.category || defaultCat)).slice(0, 60),
        claim:    adStrip(String(f.claim    || '')).slice(0, 300),
        quote:    adStrip(String(f.quote    || '')).slice(0, 500),
        location: adStrip(String(f.location || '')).slice(0, 120),
      });

      // ── 3 ПАРАЛЛЕЛЬНЫХ АГЕНТА ─────────────────────────────────────────
      // Каждый получает ПОЛНЫЙ текст документа. Цитата из документа —
      // обязательное поле; без неё замечание отброшено на Layer 1.
      stage('🔬 Запускаю параллельный аудит: структура · логика · стратегия…');

      const DEEP_AGENTS = [
        {
          key: 'structural', label: 'Структурный аудитор', defaultCat: 'Структура',
          system: `Ты — опытный юрист (право Кыргызской Республики). Проверяешь структуру и полноту документа.

ЗАДАЧА: Оцени — соответствует ли структура документа его типу и назначению.
Проверь: все ли обязательные разделы присутствуют, нет ли явных структурных пропусков.

ПРАВИЛА — ЧИТАЙ ВНИМАТЕЛЬНО:
1. Твоя цель — ЧЕСТНАЯ оценка, а НЕ поиск проблем. Если структура корректна → findings = []
2. Каждое замечание ОБЯЗАНО содержать "quote":
   • Если элемент НЕПОЛНЫЙ → скопируй дословно неполный фрагмент из документа
   • Если раздел полностью ОТСУТСТВУЕТ → quote = "Раздел не найден в тексте"
   • ЗАПРЕЩЕНО перефразировать или сочинять цитату
3. НЕ ссылайся на НПА (другой агент занимается этим)
4. НЕ придумывай проблемы которых нет в тексте

Верни СТРОГО JSON без markdown:
{ "findings": [ { "severity": "high|medium|low", "category": "Структура", "claim": "суть одним предложением", "quote": "дословная цитата из документа", "location": "раздел/пункт" } ] }`,
        },
        {
          key: 'logical', label: 'Логический аналитик', defaultCat: 'Логика',
          system: `Ты — опытный юрист (право Кыргызской Республики). Проверяешь логическую последовательность документа.

ЗАДАЧА: Оцени — есть ли в документе явные внутренние противоречия или двусмысленности.

ПРАВИЛА — ЧИТАЙ ВНИМАТЕЛЬНО:
1. Твоя цель — ЧЕСТНАЯ оценка, а НЕ поиск проблем. Если документ логически последователен → findings = []
2. Замечание засчитывается ТОЛЬКО если проблема буквально следует из текста:
   • Противоречие: оба противоречащих фрагмента должны присутствовать в тексте
   • quote для противоречия = обе фразы через " ↔ " (дословно из документа)
   • quote для двусмысленности = дословная неоднозначная фраза
3. ЗАПРЕЩЕНО: придумывать противоречия которых нет, перефразировать цитаты
4. Если проблем нет → findings = []

Верни СТРОГО JSON без markdown:
{ "findings": [ { "severity": "high|medium|low", "category": "Логика", "claim": "суть одним предложением", "quote": "дословная цитата из документа", "location": "пункт/раздел" } ] }`,
        },
        {
          key: 'strategic', label: 'Стратегический аналитик', defaultCat: 'Стратегия',
          system: `Ты — опытный адвокат (право Кыргызской Республики). Оцениваешь уязвимость документа.

ЗАДАЧА: Оцени — есть ли в документе формулировки, которые противная сторона реально может использовать против автора.

ПРАВИЛА — ЧИТАЙ ВНИМАТЕЛЬНО:
1. Твоя цель — ЧЕСТНАЯ оценка. Если документ хорошо защищён → findings = [] и это профессиональный результат
2. Quote = ДОСЛОВНАЯ цитата уязвимой формулировки из документа (скопируй точно)
   • Без дословной цитаты — замечание автоматически отклоняется
   • ЗАПРЕЩЕНО перефразировать или домысливать
3. В claim объясни конкретную тактику атаки с учётом текста
4. Только реально слабые места, подтверждённые текстом, не гипотетические

Верни СТРОГО JSON без markdown:
{ "findings": [ { "severity": "high|medium|low", "category": "Стратегия", "claim": "конкретная тактика атаки", "quote": "дословная цитата уязвимой формулировки", "location": "пункт/раздел" } ] }`,
        },
      ];

      const agentResults = await Promise.all(DEEP_AGENTS.map(async (ag) => {
        const raw = await adTimeout((async () => clients.geminiJson({
          systemPrompt: ag.system,
          userPrompt: `ДОКУМЕНТ:\n${docText}\n\nПроведи анализ по своей специализации. Верни JSON.`,
          model: 'gemini-3.1-flash-lite', maxOutputTokens: 2048, timeoutMs: 25000,
          onTokens: (m, i, o) => emitTele(res, { model: m, inputTokens: i, outputTokens: o, label: `analyze-deep:${ag.key}` }),
        }))(), 28000, null);
        const findings = adParseArr(raw).map(f => normFinding(f, ag.defaultCat));
        sse({ stage: `   ✓ ${ag.label}: замечаний ${findings.length}`, agent: ag.key });
        return { key: ag.key, findings };
      }));

      // ── LAYER 1: Фильтр по обязательному полю quote ────────────────
      const ABSENT_MARKER = 'раздел не найден';
      const rawFindings = agentResults.flatMap(r => r.findings)
        .filter(f => f.claim && f.quote && f.quote.trim() !== '' && f.quote !== 'null');

      if (!rawFindings.length) {
        sse({ text: '## ⚖️ Итог\n\nЗамечаний не выявлено. Документ структурно корректен, логически последователен и стратегически защищён.' });
        sse({ deepAnalysis: { findings: [], score: 95, agentBreakdown: { structural: 0, logical: 0, strategic: 0 } } });
        return finish();
      }

      // ── LAYER 1.5: Проверка цитаты в тексте документа (без LLM) ───
      // Если агент сочинил цитату — она не найдётся в docText → отклоняем.
      const docLower = docText.toLowerCase();
      const quoteVerified = rawFindings.filter(f => {
        const q = f.quote.toLowerCase().trim();
        if (q.includes(ABSENT_MARKER)) return true; // "Раздел не найден" — легитимно
        // Ищем хотя бы первые 25 символов цитаты (устойчиво к обрезке)
        const probe = q.replace(/[«»"']/g, '').trim().slice(0, 25);
        return probe.length < 8 || docLower.includes(probe);
      });
      if (quoteVerified.length < rawFindings.length) {
        sse({ stage: `   ⚠️ Отфильтровано ${rawFindings.length - quoteVerified.length} замечаний с несуществующими цитатами` });
      }

      // ── LAYER 2: ADVERSARIAL VERIFIER ─────────────────────────────
      stage(`⚖️ Верифицирую ${quoteVerified.length} замечани${quoteVerified.length === 1 ? 'е' : quoteVerified.length < 5 ? 'я' : 'й'} независимым аудитором…`);
      const VERIFIER_SYS_DEEP = `Ты — независимый юрист-скептик. Проверяешь замечание к документу.
ЗАДАЧА: Есть ли в тексте документа что-то, что ОПРОВЕРГАЕТ это замечание?
confirmed: false = нашёл опровержение (процитируй его).
confirmed: true  = замечание обоснованно, опровержения нет.
Верни СТРОГО JSON: { "confirmed": <bool>, "reason": "<1-2 предложения>" }`;

      const verified = await Promise.all(quoteVerified.slice(0, 18).map(async (f) => {
        const raw = await adTimeout((async () => clients.geminiJson({
          systemPrompt: VERIFIER_SYS_DEEP,
          userPrompt: `ЗАМЕЧАНИЕ: ${f.claim}\nЦИТАТА ИЗ ДОКУМЕНТА: ${f.quote}\nМЕСТО: ${f.location}\n\nТЕКСТ ДОКУМЕНТА:\n${docText.slice(0, 8000)}\n\nВерни JSON.`,
          model: 'gemini-3.1-flash-lite', maxOutputTokens: 300, timeoutMs: 15000,
          onTokens: (m, i, o) => emitTele(res, { model: m, inputTokens: i, outputTokens: o, label: 'analyze-deep:verifier' }),
        }))(), 18000, null);
        const v = adParseObj(raw);
        if (!v || typeof v.confirmed !== 'boolean') return { ...f, confirmed: true };
        return { ...f, confirmed: v.confirmed, verifierReason: adStrip(String(v.reason || '')).slice(0, 200) };
      }));
      const confirmedFindings = verified.filter(f => f.confirmed);

      const agentBreakdown = {};
      for (const ag of DEEP_AGENTS) {
        agentBreakdown[ag.key] = confirmedFindings.filter(f => f.category === ag.defaultCat).length;
      }

      // ── SCORE ───────────────────────────────────────────────────────
      let score = 100;
      for (const f of confirmedFindings) {
        if (f.severity === 'high') score -= 15;
        else if (f.severity === 'medium') score -= 8;
        else score -= 2;
      }
      score = Math.max(10, Math.min(100, score));

      // ── JUDGE: DeepSeek v4-flash, потоковый ────────────────────────
      stage('🔎 Ищу применимые нормы НПА КР…');
      const nH = confirmedFindings.filter(f => f.severity === 'high').length;
      const nM = confirmedFindings.filter(f => f.severity === 'medium').length;
      const nL = confirmedFindings.filter(f => f.severity === 'low').length;
      const findingsBlock = confirmedFindings.map((f, i) =>
        `${i + 1}. [${f.severity.toUpperCase()}] ${f.category} · ${f.location}\n   Замечание: ${f.claim}\n   Цитата: «${f.quote}»`
      ).join('\n\n');

      // ── QUICK RAG: берём применимые НПА нормы из Supabase для судьи ─
      // Без этого судья "придумывал" статьи — теперь ссылается только на реальные нормы.
      let deepNpaBlock = '';
      try {
        const deepRagQueries = [
          docText.slice(0, 200) + ' правовые требования ответственность обязательство',
          'требования к форме содержанию документа Кыргызская Республика закон',
        ];
        const deepNorms = (await resolvedDeps.pineconeSearch?.(deepRagQueries, null, 5)) || [];
        if (deepNorms.length) {
          deepNpaBlock = '\n\nПРИМЕНИМЫЕ НОРМЫ НПА КР (из базы законов, используй их для рекомендаций):\n' +
            deepNorms.slice(0, 5).map((n, i) => {
              const md = (n && n.metadata) || {};
              return `[${i + 1}] ${[md.npa_title, md.article_title].filter(Boolean).join(' — ')}\n${String(md.full_text || '').slice(0, 400)}`;
            }).join('\n\n');
          sse({ stage: `   ✓ Найдено ${deepNorms.length} применимых норм НПА` });
        } else {
          sse({ stage: '   ℹ️ База НПА не вернула применимых норм для этого документа' });
        }
      } catch (e) {
        console.warn('[analyze-deep] RAG failed:', e.message);
      }

      stage('🧠 Формирую Executive Summary…');

      const JUDGE_SYS_DEEP = `Ты — практикующий юрист (право Кыргызской Республики), лично изучивший документ.
Тебе переданы верифицированные замечания к этому документу${deepNpaBlock ? ' и применимые нормы НПА КР из базы законов' : ''}.
Составь профессиональное юридическое заключение для клиента.

ПРАВИЛА (КРИТИЧЕСКИ ВАЖНЫ):
- Пиши от первого лица как юрист («При изучении документа выявлено...»)
- НЕ упоминай «аудиторов», «протоколы», «источники», «агентов» — ты лично изучил документ
- Ссылайся ТОЛЬКО на факты из переданных замечаний — не добавляй новых
- Ссылайся на НПА ТОЛЬКО из раздела «ПРИМЕНИМЫЕ НОРМЫ НПА КР» (если он передан). Не называй статей которых нет в переданных данных.
- По каждому замечанию — конкретная рекомендация: что именно и как исправить
- Если замечаний мало или документ в целом хорош — скажи это прямо

ФОРМАТ (markdown):
## 🔴 Критические замечания
## 🟡 Существенные замечания
## 🟢 Рекомендации
## ⚖️ Заключение`;

      const judgeUser = `Оценка документа: ${score}/100 | Замечаний: ${confirmedFindings.length} (🔴 ${nH} · 🟡 ${nM} · 🟢 ${nL})\n\nВЫЯВЛЕННЫЕ ЗАМЕЧАНИЯ:\n\n${findingsBlock}${deepNpaBlock}`;

      let judgeText = '';
      try {
        const judgeResult = await clients.deepseekReason({
          systemPrompt: JUDGE_SYS_DEEP, userPrompt: judgeUser,
          model: 'deepseek-v4-flash', reasoning_effort: 'low', thinking: 'disabled',
          onDelta: (d) => { if (d.text) { judgeText += d.text; sse({ text: d.text }); } },
        });
        if (judgeResult && judgeResult.usage && (judgeResult.usage.inputTokens || judgeResult.usage.outputTokens)) {
          emitTele(res, { model: judgeResult.model || 'deepseek-v4-flash', inputTokens: judgeResult.usage.inputTokens, outputTokens: judgeResult.usage.outputTokens, label: 'analyze-deep:judge' });
        }
      } catch (e) { console.warn('[analyze-deep] judge error:', e.message); }
      if (!judgeText) {
        // Gemini fallback
        try {
          const fb = await clients.geminiJson({ systemPrompt: JUDGE_SYS_DEEP, userPrompt: judgeUser, model: 'gemini-2.5-flash', maxOutputTokens: 3000, timeoutMs: 40000,
            onTokens: (m, i, o) => emitTele(res, { model: m, inputTokens: i, outputTokens: o, label: 'analyze-deep:judge-fallback' }), });
          sse({ text: String(fb || '') });
        } catch (_) {
          sse({ text: `## ⚖️ Итоговая оценка\n\nВыявлено ${confirmedFindings.length} замечаний. Оценка: ${score}/100.` });
        }
      }

      sse({ deepAnalysis: { findings: confirmedFindings, score, agentBreakdown } });
      return finish();
    } catch (err) {
      console.error('[analyze-deep] error:', err.message);
      sse({ error: 'Сбой глубокого анализа: ' + err.message });
      return finish();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  ГЛУБОКИЙ АНАЛИЗ PRO — /api/v2/analyze-pro
  //  6 параллельных агентов: Структура + Логика + Стратегия + Риски +
  //  Процессуал + RAG-верификатор (НПА КР из Supabase).
  //  Adversarial verifier проверяет ВСЕ замечания.
  //  DeepSeek v4-pro с reasoning синтезирует финальный отчёт.
  // ═══════════════════════════════════════════════════════════════════════
  router.post('/analyze-pro', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const sse  = (obj) => { if (!res.writableEnded) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); if (typeof res.flush === 'function') res.flush(); } };
    const done = () => { if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); } };
    const stage = (text) => sse({ stage: text });
    const hb = setInterval(() => { if (!res.writableEnded) res.write(':hb\n\n'); }, 20000);
    const finish = () => { clearInterval(hb); done(); };

    try {
      const docText = String((req.body && req.body.documentText) || '').slice(0, 35000).trim();
      if (docText.length < 80) { sse({ error: 'Документ слишком короткий для PRO-анализа' }); return finish(); }

      const proTimeout = (p, ms, fb) => Promise.race([
        Promise.resolve(p).catch(() => fb),
        new Promise(r => setTimeout(() => r(fb), ms)),
      ]);
      const proParseArr = (raw) => {
        const c = String(raw || '').replace(/```json\s*/gi, '').replace(/```/g, '').trim();
        try { const o = JSON.parse(c); return Array.isArray(o) ? o : (Array.isArray(o.findings) ? o.findings : []); } catch (_) {}
        const a = c.indexOf('['), b = c.lastIndexOf(']');
        if (a !== -1 && b > a) { try { return JSON.parse(c.slice(a, b + 1)); } catch (_) {} }
        const oa = c.indexOf('{'), oc = c.lastIndexOf('}');
        if (oa !== -1 && oc > oa) { try { const o = JSON.parse(c.slice(oa, oc + 1)); return Array.isArray(o.findings) ? o.findings : []; } catch (_) {} }
        return [];
      };
      const proParseObj = (raw) => {
        const c = String(raw || '').replace(/```json\s*/gi, '').replace(/```/g, '').trim();
        try { return JSON.parse(c); } catch (_) {}
        const a = c.indexOf('{'), b = c.lastIndexOf('}');
        if (a !== -1 && b > a) { try { return JSON.parse(c.slice(a, b + 1)); } catch (_) {} }
        return null;
      };
      const proStrip = (s) => String(s || '').replace(/[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/g, '');
      const proNorm = (f, dc) => ({
        severity: ['high', 'medium', 'low'].includes(f.severity) ? f.severity : 'medium',
        category: proStrip(String(f.category || dc)).slice(0, 60),
        claim:    proStrip(String(f.claim    || '')).slice(0, 300),
        quote:    proStrip(String(f.quote    || '')).slice(0, 500),
        location: proStrip(String(f.location || '')).slice(0, 120),
      });

      // ── 6 ПАРАЛЛЕЛЬНЫХ АГЕНТОВ ─────────────────────────────────────
      // Агенты 1-5: анализ текста документа (gemini-3.1-flash-lite)
      // Агент 6: RAG-верификатор — ищет нормы НПА КР в Supabase через resolvedDeps.pineconeSearch
      stage('🔬 Запускаю 6 параллельных агентов PRO (структура · логика · стратегия · риски · процессуал · НПА)…');

      const PRO_AGENTS = [
        {
          key: 'structural', label: 'Структурный аудитор', defaultCat: 'Структура', model: 'gemini-3.1-flash-lite',
          system: `Ты — опытный юрист (право Кыргызской Республики). Проверяешь структуру документа.

ЗАДАЧА: Оцени — соответствует ли структура документа его типу. Проверь наличие всех необходимых разделов.

ПРАВИЛА:
1. Твоя цель — ЧЕСТНАЯ оценка, не поиск проблем. Если структура правильная → findings = []
2. quote = ДОСЛОВНАЯ цитата из документа (скопируй точно). Нельзя перефразировать.
   Если раздел отсутствует → quote = "Раздел не найден в тексте"
3. НЕ придумывай отсутствие разделов если они есть в другой форме
4. НЕ ссылайся на НПА (другой агент)
Верни JSON: { "findings": [ { "severity", "category": "Структура", "claim", "quote", "location" } ] }`,
        },
        {
          key: 'logical', label: 'Логический аналитик', defaultCat: 'Логика', model: 'gemini-3.1-flash-lite',
          system: `Ты — опытный юрист (право Кыргызской Республики). Проверяешь логику документа.

ЗАДАЧА: Оцени — есть ли явные внутренние противоречия или неустранимые двусмысленности.

ПРАВИЛА:
1. Твоя цель — ЧЕСТНАЯ оценка. Если документ логически последователен → findings = []
2. quote для противоречия = ОБА фрагмента дословно через " ↔ " (оба должны быть в тексте)
3. quote для двусмысленности = дословная неоднозначная фраза из документа
4. ЗАПРЕЩЕНО: домысливать противоречия, перефразировать цитаты
Верни JSON: { "findings": [ { "severity", "category": "Логика", "claim", "quote", "location" } ] }`,
        },
        {
          key: 'strategic', label: 'Стратегический аналитик', defaultCat: 'Стратегия', model: 'gemini-3.1-flash-lite',
          system: `Ты — опытный адвокат (право Кыргызской Республики). Оцениваешь стратегические риски документа.

ЗАДАЧА: Оцени — есть ли формулировки которые противная сторона реально может использовать против автора.

ПРАВИЛА:
1. Твоя цель — ЧЕСТНАЯ оценка. Если документ хорошо защищён → findings = [] (это профессиональный результат)
2. quote = ДОСЛОВНАЯ цитата уязвимой формулировки (скопируй точно из текста)
3. В claim — конкретная тактика атаки, основанная на тексте
4. ЗАПРЕЩЕНО: придумывать уязвимости, перефразировать цитаты
Верни JSON: { "findings": [ { "severity", "category": "Стратегия", "claim", "quote", "location" } ] }`,
        },
        {
          key: 'risk', label: 'Риск-менеджер', defaultCat: 'Риски', model: 'gemini-3.1-flash-lite',
          system: `Ты — юрист по управлению рисками (право Кыргызской Республики). Оцениваешь правовые риски.

ЗАДАЧА: Оцени — есть ли в документе условия создающие реальные правовые или финансовые риски.

ПРАВИЛА:
1. Твоя цель — ЧЕСТНАЯ оценка. Если рисков нет → findings = []
2. quote = ДОСЛОВНАЯ цитата рискованного условия из документа
3. В claim — конкретный механизм риска (не гипотетический)
4. ЗАПРЕЩЕНО: придумывать риски которых нет в тексте
Верни JSON: { "findings": [ { "severity", "category": "Риски", "claim", "quote", "location" } ] }`,
        },
        {
          key: 'procedural', label: 'Процессуальный аналитик', defaultCat: 'Процессуал', model: 'gemini-3.1-flash-lite',
          system: `Ты — юрист (право Кыргызской Республики). Проверяешь процессуальные аспекты документа.

ЗАДАЧА: Оцени — есть ли реальные процессуальные проблемы: неопределённые сроки, нарушение порядка уведомлений, отсутствие обязательной формы.

ПРАВИЛА:
1. Твоя цель — ЧЕСТНАЯ оценка. Если процессуальных проблем нет → findings = []
2. quote = ДОСЛОВНАЯ цитата проблемного условия из документа
   Если условие отсутствует полностью → quote = "Условие не найдено в тексте"
3. ЗАПРЕЩЕНО: придумывать проблемы которых нет
Верни JSON: { "findings": [ { "severity", "category": "Процессуал", "claim", "quote", "location" } ] }`,
        },
      ];

      // Агент 6: RAG-верификатор (Supabase НПА КР)
      // Ищет применимые нормы через resolvedDeps.pineconeSearch,
      // затем проверяет документ на соответствие найденным нормам.
      const ragAgentPromise = proTimeout((async () => {
        const subject = docText.slice(0, 300); // первые 300 символов как краткое описание
        const ragQueries = [
          `${subject} нарушение обязательства ответственность`,
          `${subject} права стороны расторжение договора`,
          `требования к форме содержанию документа Кыргызская Республика`,
        ];
        let ragNorms = [];
        try {
          ragNorms = (await resolvedDeps.pineconeSearch?.(ragQueries, null, 8)) || [];
        } catch (e) { console.warn('[analyze-pro] RAG search failed:', e.message); }
        if (!ragNorms.length) return { key: 'npa_check', findings: [] };

        const normsList = ragNorms.slice(0, 8).map((n, i) => {
          const md = (n && n.metadata) || {};
          return `[${i+1}] ${[md.npa_title, md.article_title].filter(Boolean).join(' — ')}\n${String(md.full_text || '').slice(0, 600)}`;
        }).join('\n\n');

        const RAG_SYS = `Ты — эксперт-нормоконтролёр (право Кыргызской Республики).
Тебе переданы нормы НПА КР из базы законов и текст проверяемого документа.
ЗАДАЧА: Проверь, соответствует ли документ переданным нормам. Найди нарушения или несоответствия.

АНТИГАЛЛЮЦИНАЦИОННЫЕ ПРАВИЛА (КРИТИЧЕСКИ ВАЖНЫ):
1. Ссылайся ТОЛЬКО на нормы из переданного списка (НЕ придумывай статьи)
2. Quote = точная цитата из документа, которая нарушает норму (ОБЯЗАТЕЛЬНА)
3. В claim укажи: какую именно норму нарушает и как
4. findings = [] если нарушений нет

Верни СТРОГО JSON без markdown:
{ "findings": [ { "severity": "high|medium|low", "category": "НПА КР", "claim": "какую норму нарушает", "quote": "цитата из документа", "location": "пункт/раздел", "norm": "[N] название нормы" } ] }`;

        const raw = await clients.geminiJson({
          systemPrompt: RAG_SYS,
          userPrompt: `НОРМЫ НПА КР ИЗ БАЗЫ:\n${normsList}\n\nДОКУМЕНТ:\n${docText.slice(0, 12000)}\n\nПроверь соответствие. Верни JSON.`,
          model: 'gemini-3.1-flash-lite', maxOutputTokens: 2500, timeoutMs: 28000,
          onTokens: (m, i, o) => emitTele(res, { model: m, inputTokens: i, outputTokens: o, label: 'analyze-pro:npa_check' }),
        });
        const findings = proParseArr(raw).map(f => ({
          ...proNorm(f, 'НПА КР'),
          norm: proStrip(String(f.norm || '')).slice(0, 200),
        }));
        sse({ stage: `   ✓ RAG-верификатор НПА: найдено норм ${ragNorms.length}, замечаний ${findings.length}`, agent: 'npa_check' });
        return { key: 'npa_check', findings };
      })(), 35000, { key: 'npa_check', findings: [] });

      // Все 6 агентов параллельно
      const [agentResults, ragResult] = await Promise.all([
        Promise.all(PRO_AGENTS.map(async (ag) => {
          const raw = await proTimeout((async () => clients.geminiJson({
            systemPrompt: ag.system,
            userPrompt: `ДОКУМЕНТ:\n${docText}\n\nПроведи анализ. Верни JSON.`,
            model: ag.model, maxOutputTokens: 2500, timeoutMs: 35000,
            onTokens: (m, i, o) => emitTele(res, { model: m, inputTokens: i, outputTokens: o, label: `analyze-pro:${ag.key}` }),
          }))(), 38000, null);
          const findings = proParseArr(raw).map(f => proNorm(f, ag.defaultCat));
          sse({ stage: `   ✓ ${ag.label}: замечаний ${findings.length}`, agent: ag.key });
          return { key: ag.key, findings };
        })),
        ragAgentPromise,
      ]);

      // ── LAYER 1: Фильтр по обязательному полю quote ────────────────
      const allResults = [...agentResults, ragResult];
      const proRawAll = allResults.flatMap(r => (r.findings || []))
        .filter(f => f.claim && f.quote && f.quote.trim() !== '' && f.quote !== 'null');

      if (!proRawAll.length) {
        sse({ text: '## ⚖️ PRO-Итог\n\nЗамечаний не выявлено. Документ юридически состоятелен по всем направлениям проверки.' });
        sse({ deepAnalysis: { findings: [], score: 97, agentBreakdown: { structural: 0, logical: 0, strategic: 0, risk: 0, procedural: 0, npa_check: 0 } } });
        return finish();
      }

      // ── LAYER 1.5: Проверка цитаты в тексте (без LLM) ─────────────
      const proDocLower = docText.toLowerCase();
      const PRO_ABSENT = 'не найден';
      const rawFindings = proRawAll.filter(f => {
        const q = f.quote.toLowerCase().trim();
        if (q.includes(PRO_ABSENT) || q.includes('отсутствует')) return true;
        const probe = q.replace(/[«»"']/g, '').trim().slice(0, 25);
        return probe.length < 8 || proDocLower.includes(probe);
      });
      if (rawFindings.length < proRawAll.length) {
        sse({ stage: `   ⚠️ Отфильтровано ${proRawAll.length - rawFindings.length} замечаний с несуществующими цитатами` });
      }
      if (!rawFindings.length) {
        sse({ text: '## ⚖️ PRO-Итог\n\nЗамечаний не выявлено после проверки цитат. Документ составлен корректно.' });
        sse({ deepAnalysis: { findings: [], score: 95, agentBreakdown: { structural: 0, logical: 0, strategic: 0, risk: 0, procedural: 0, npa_check: 0 } } });
        return finish();
      }

      // ── LAYER 2: ADVERSARIAL VERIFIER (проверяем ВСЕ) ─────────────
      stage(`⚖️ PRO-верификация: проверяю ${rawFindings.length} замечани${rawFindings.length === 1 ? 'е' : rawFindings.length < 5 ? 'я' : 'й'} независимым аудитором…`);
      const VERIFIER_SYS_PRO = `Ты — независимый юрист-скептик. Проверяешь замечание к документу.
ЗАДАЧА: Есть ли в тексте документа что-то, что ОПРОВЕРГАЕТ это замечание?
confirmed: false = нашёл опровержение (процитируй его точно).
confirmed: true  = замечание обоснованно, опровержения нет.
Верни СТРОГО JSON: { "confirmed": <bool>, "reason": "<1-2 предложения>" }`;

      const verifiedAll = await Promise.all(rawFindings.slice(0, 25).map(async (f) => {
        const raw = await proTimeout((async () => clients.geminiJson({
          systemPrompt: VERIFIER_SYS_PRO,
          userPrompt: `ЗАМЕЧАНИЕ: ${f.claim}\nЦИТАТА ИЗ ДОКУМЕНТА: ${f.quote}\nМЕСТО: ${f.location}\n\nТЕКСТ ДОКУМЕНТА:\n${docText.slice(0, 8000)}\n\nВерни JSON.`,
          model: 'gemini-3.1-flash-lite', maxOutputTokens: 300, timeoutMs: 15000,
          onTokens: (m, i, o) => emitTele(res, { model: m, inputTokens: i, outputTokens: o, label: 'analyze-pro:verifier' }),
        }))(), 18000, null);
        const v = proParseObj(raw);
        if (!v || typeof v.confirmed !== 'boolean') return { ...f, confirmed: true };
        return { ...f, confirmed: v.confirmed, verifierReason: proStrip(String(v.reason || '')).slice(0, 200) };
      }));
      const confirmedFindings = verifiedAll.filter(f => f.confirmed)
        .sort((a, b) => { const ord = { high: 0, medium: 1, low: 2 }; return (ord[a.severity] || 1) - (ord[b.severity] || 1); });

      const agentBreakdown = {};
      for (const ag of [...PRO_AGENTS, { key: 'npa_check', defaultCat: 'НПА КР' }]) {
        agentBreakdown[ag.key] = confirmedFindings.filter(f => f.category === ag.defaultCat).length;
      }

      // ── SCORE (строже чем в deep: -20 за НПА, -15 за структур./логику high) ──
      let score = 100;
      for (const f of confirmedFindings) {
        const isNpa = f.category === 'НПА КР';
        if (f.severity === 'high') score -= isNpa ? 20 : 15;
        else if (f.severity === 'medium') score -= isNpa ? 12 : 8;
        else score -= 2;
      }
      score = Math.max(5, Math.min(100, score));

      // ── JUDGE PRO: DeepSeek v4-pro с reasoning ─────────────────────
      stage('🧠 DeepSeek PRO (reasoning) синтезирует финальный отчёт…');
      const nH = confirmedFindings.filter(f => f.severity === 'high').length;
      const nM = confirmedFindings.filter(f => f.severity === 'medium').length;
      const nL = confirmedFindings.filter(f => f.severity === 'low').length;

      const groupedBlock = ['НПА КР', 'Структура', 'Логика', 'Стратегия', 'Риски', 'Процессуал'].map(cat => {
        const catFindings = confirmedFindings.filter(f => f.category === cat);
        if (!catFindings.length) return '';
        const items = catFindings.map((f, i) =>
          `  ${i+1}. [${f.severity.toUpperCase()}] ${f.claim}\n     Цитата: «${f.quote}»\n     Место: ${f.location}${f.norm ? `\n     Норма: ${f.norm}` : ''}`
        ).join('\n');
        return `[${cat}]\n${items}`;
      }).filter(Boolean).join('\n\n');

      const JUDGE_SYS_PRO = `Ты — старший практикующий юрист (право Кыргызской Республики), лично изучивший документ.
Тебе переданы: оригинальный текст документа и верифицированные замечания к нему.

ЗАДАЧА: Составь профессиональное юридическое заключение PRO-уровня.
Ты видишь и оригинал документа, и замечания — можешь оценить документ комплексно: смысл, цели, стиль, соответствие праву.

ПРАВИЛА (КРИТИЧЕСКИ ВАЖНЫ):
- Пиши от первого лица как юрист («При анализе документа установлено...»)
- НЕ упоминай «аудиторов», «протоколы», «источники» — ты лично изучил документ
- Ссылайся ТОЛЬКО на переданные замечания — не добавляй новых от себя
- Для нарушений НПА — назови конкретную статью (ГК КР, ГПК КР и т.д.) и дай готовую формулировку-возражение
- По каждому замечанию дай конкретную редакцию исправления или формулировку
- Если документ в целом грамотный и замечания незначительны — скажи это прямо

ФОРМАТ (markdown):
## 🔴 Критические замечания
## 🟡 Существенные замечания
## 🟢 Рекомендации
## 💡 Что исправить до подписания
## ⚖️ PRO-вердикт`;

      const judgeUserPro = `ОЦЕНКА: ${score}/100 | Замечаний: ${confirmedFindings.length} (🔴 ${nH} · 🟡 ${nM} · 🟢 ${nL})\n\nОРИГИНАЛ ДОКУМЕНТА:\n${docText.slice(0, 10000)}\n\nВЕРИФИЦИРОВАННЫЕ ЗАМЕЧАНИЯ:\n\n${groupedBlock}`;

      let proJudgeText = '';
      try {
        const proJudgeResult = await clients.deepseekReason({
          systemPrompt: JUDGE_SYS_PRO, userPrompt: judgeUserPro,
          model: 'deepseek-v4-pro', reasoning_effort: 'high', thinking: 'enabled',
          onDelta: (d) => { if (d.text) { proJudgeText += d.text; sse({ text: d.text }); } },
        });
        if (proJudgeResult && proJudgeResult.usage && (proJudgeResult.usage.inputTokens || proJudgeResult.usage.outputTokens)) {
          emitTele(res, { model: proJudgeResult.model || 'deepseek-v4-pro', inputTokens: proJudgeResult.usage.inputTokens, outputTokens: proJudgeResult.usage.outputTokens, label: 'analyze-pro:judge' });
        }
      } catch (e) { console.warn('[analyze-pro] judge error:', e.message); }
      if (!proJudgeText) {
        try {
          const fb = await clients.geminiJson({ systemPrompt: JUDGE_SYS_PRO, userPrompt: judgeUserPro, model: 'gemini-2.5-flash', maxOutputTokens: 4000, timeoutMs: 50000,
            onTokens: (m, i, o) => emitTele(res, { model: m, inputTokens: i, outputTokens: o, label: 'analyze-pro:judge-fallback' }), });
          sse({ text: String(fb || '') });
        } catch (_) {
          sse({ text: `## ⚖️ PRO-вердикт\n\nВыявлено ${confirmedFindings.length} замечаний. Оценка: ${score}/100.` });
        }
      }

      sse({ deepAnalysis: { findings: confirmedFindings, score, agentBreakdown } });
      return finish();
    } catch (err) {
      console.error('[analyze-pro] error:', err.message);
      sse({ error: 'Сбой PRO-анализа: ' + err.message });
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
