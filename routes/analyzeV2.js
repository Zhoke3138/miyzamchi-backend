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
const clients = require('../services/llmClients');
const { getTemplate, buildChecklist } = require('../lib/docTemplates');

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
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

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
/**
 * Динамический reasoning_effort (ТЗ 4.1).
 * High — порядок проверки первым, т.к. перекрывает остальные.
 */
// deepseek-v4-pro принимает только 'high' | 'max'. Динамика сложности:
// >3 ошибок/слепых зон суммарно ИЛИ >2 разных НПА → 'max', иначе 'high'.
function pickReasoningEffort({ errorCount = 0, blindSpotCount = 0, distinctNpaCount = 0 }) {
  if ((errorCount + blindSpotCount) > 3 || distinctNpaCount > 2) return 'max';
  return 'high';
}

// ── 2026-06-16 Динамический роутер Судьи (по идее пользователя) ─────────────
// Лёгкий документ (мало замечаний, ≤1 НПА, небольшой объём) → СТАНДАРТНЫЙ
// судья DeepSeek v4-flash, минимальное рассуждение ('low'), thinking ВЫКЛ —
// быстро и без CoT-задержки. Тяжёлый → ВЕРХОВНЫЙ судья v4-pro, рассуждение
// от минимума ('high') к максимуму ('max'), thinking ВКЛ.
//   model: 'deepseek-v4-flash' | 'deepseek-v4-pro'
//   reasoning_effort: 'low' (flash) | 'high'|'max' (pro)
//   thinking: 'disabled' (flash) | 'enabled' (pro)
function pickJudgeRoute({ errorCount = 0, blindSpotCount = 0, distinctNpaCount = 0, totalBlocks = 0 }) {
  const issues = errorCount + blindSpotCount;
  const light = issues <= 2 && distinctNpaCount <= 1 && totalBlocks <= 25;
  if (light) {
    return { tier: 'standard', model: 'deepseek-v4-flash', reasoning_effort: 'low', thinking: 'disabled', name: 'DeepSeek v4 Flash' };
  }
  const severe = issues > 3 || distinctNpaCount > 2 || totalBlocks > 60;
  return { tier: 'supreme', model: 'deepseek-v4-pro', reasoning_effort: severe ? 'max' : 'high', thinking: 'enabled', name: 'DeepSeek v4 Pro' };
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

      const state = await buildGlobalState(markdown, chunks, structure_confidence, resolvedDeps);
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
        if (d.text) { sawContent = true; sse({ text: d.text }); }
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
      if (report.summary && !sawContent) sse({ text: report.summary });

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
  //    1) Планировщик-исследователь (flash-lite) — фактура + ЧЕТЫРЕ группы
  //       поисковых запросов: точные / связанные / общие / процессуальные.
  //    2) Ищейки/RAG (Pinecone, параллельно по группам) — широкий охват:
  //       тянут кандидатов из всех релевантных кодексов, дедуп по статье.
  //    3) Отборщик (flash-lite) — из кандидатов оставляет реально применимые,
  //       присваивает каждой норме роль (exact/related/general/procedural).
  //    4) Драфтер (DeepSeek v4-pro, reasoning) — насыщенный документ с полным
  //       правовым обоснованием, цитирует ТОЛЬКО реальные статьи из базы.
  //  SSE: { stage } прогресс → финальный { done:true, blocks[], articlesUsed[] }.
  // ═══════════════════════════════════════════════════════════════════════
  const CAT_LABEL = {
    exact:      'ТОЧНЫЕ НОРМЫ ПО ПРЕДМЕТУ',
    related:    'СВЯЗАННЫЕ НОРМЫ',
    general:    'ОБЩИЕ НОРМЫ',
    procedural: 'ПРОЦЕССУАЛЬНЫЕ НОРМЫ',
  };
  const PLANNER_SYS = (tpl) => `Ты — ведущий юрист-исследователь ИИ «Мыйзамчы» (Кыргызстан).
По собранному диалогу подготовь ПЛАН составления документа «${tpl.label}» и СТРАТЕГИЮ поиска норм права КР.

Применимые кодексы/НПА (ориентир): ${(tpl.codesHint || []).join('; ')}.

Сформулируй поисковые запросы в ЧЕТЫРЁХ группах, чтобы найти АБСОЛЮТНО ВСЕ применимые нормы:
• exact      — нормы ПРЯМО по предмету спора (основание требования);
• related    — связанные институты (последствия, смежные нормы, спец. законы по предмету);
• general    — общие положения кодекса (о сделках, обязательствах, праве собственности и т.п.);
• procedural — процессуальные нормы (подсудность, форма и содержание иска, госпошлина, исковая давность — ГПК КР).

Верни СТРОГО JSON без markdown:
{
  "facts": {
    ${(tpl.requiredFields || []).concat(tpl.optionalFields || []).map((f) => `"${f.key}": "<${f.title}: что известно из диалога, дословно факты; '' если не сказано>"`).join(',\n    ')}
  },
  "subject_line": "<краткая формулировка предмета для подзаголовка, напр. 'о признании договора недействительным'>",
  "legal_questions": ["<1-3 ключевых правовых вопроса дела>"],
  "queries": {
    "exact":      ["<2-4 точных запроса>"],
    "related":    ["<2-4 запроса>"],
    "general":    ["<1-3 запроса>"],
    "procedural": ["<1-3 запроса по ГПК КР>"]
  }
}

ПРАВИЛА: факты бери ТОЛЬКО из диалога, не выдумывай имена/суммы/даты/адреса (нет → ''). Запросы пиши развёрнуто, называя институты и кодекс КР, чтобы векторный поиск нашёл максимум норм.`;

  const SELECTOR_SYS = `Ты — юрист-аналитик (право Кыргызской Республики). Тебе дан СПИСОК КАНДИДАТ-СТАТЕЙ из базы НПА (найдены RAG) и суть дела. Отбери ТОЛЬКО реально применимые к делу нормы и присвой каждой роль.

Роли: "exact" (прямо обосновывает требование), "related" (связанная норма/последствия), "general" (общее положение), "procedural" (процессуальная норма ГПК).

Верни СТРОГО JSON без markdown:
{ "keep": [ { "i": <номер кандидата>, "role": "exact|related|general|procedural", "why": "<очень кратко зачем>" } ] }

ПРАВИЛА: оставляй только относящиеся к делу статьи (мусор и нерелевантное — выбрасывай). Не добавляй статьи, которых нет в списке. Сохрани все действительно полезные нормы — лучше полнее.`;

  const DRAFTER_SYS = (tpl) => `Ты — старший юрист Кыргызской Республики. Составь ПОЛНЫЙ, юридически грамотный документ «${tpl.label}» и верни его СТРОГО как JSON-массив блоков (DocBlock[]) — без markdown, без пояснений.

ФОРМАТ БЛОКА:
{ "kind": "<тип>", "align": "left|center|right|justify (необязательно)", "runs": [ { "t": "текст", "bold": true?, "italic": true?, "underline": true?, "cite": "<НПА ст.N, если это ссылка на норму>" } ] }

ТИПЫ БЛОКОВ (kind):
- court · party_header (стороны, по строке на блок) · spacer (runs:[]) · title (НАЗВАНИЕ, bold) · subtitle («о …»)
- paragraph (фабула / правовое обоснование) · demand_heading («Прошу:») · demand_item (нумерованное требование)
- attachment_heading («Приложение:») · attachment_item · signature

ПОРЯДОК СЕКЦИЙ:
${(tpl.structureHint || []).map((s, i) => `${i + 1}. ${s}`).join('\n')}

КАК ПИСАТЬ ПРАВОВОЕ ОБОСНОВАНИЕ (это ГЛАВНОЕ — документ должен быть содержательным, а не из двух абзацев):
• Сначала ФАБУЛА: подробно изложи обстоятельства из досье (стороны, даты, предмет, в чём нарушение).
• Затем НЕСКОЛЬКО абзацев правового обоснования — задействуй ВСЕ применимые нормы из эталона:
  – сперва ТОЧНЫЕ нормы (прямое основание требования) — процитируй и объясни, как норма применяется к фактам;
  – затем СВЯЗАННЫЕ и ОБЩИЕ нормы (последствия, смежные институты) — каждой норме отдельный смысловой абзац;
• Отдельный абзац ПРОЦЕССУАЛЬНОГО основания: «Руководствуясь ст. … ГПК КР, прошу:» со ссылками на процессуальные нормы.
• Каждое требование в «Прошу:» должно опираться на изложенное обоснование.

ЖЕЛЕЗНЫЕ ПРАВИЛА:
1. Цитируй ТОЛЬКО статьи из приведённого ЭТАЛОННОГО списка норм (RAG), группы помечены. Не придумывай номера статей по памяти. Используй КАК МОЖНО БОЛЬШЕ применимых норм из списка — не ограничивайся одной-двумя.
2. Каждую ссылку на норму — ОТДЕЛЬНЫМ run: italic:true и cite:"<НПА ст.N>". Окружающий текст — обычными run. Следи за пробелами между run.
3. НЕ выдумывай факты (имена, суммы, даты, адреса, ИНН). Только из досье. Нет обязательной детали — ставь «____________».
4. Раздели стороны и смысловые секции блоками spacer.
5. Верни ТОЛЬКО JSON-массив блоков. Первый символ ответа — «[», последний — «]».`;

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

      // ── 1) ПЛАНИРОВЩИК-ИССЛЕДОВАТЕЛЬ ──
      stage('🔍 Анализирую дело и планирую поиск норм…');
      let plan = { facts: {}, subject_line: '', legal_questions: [], queries: {} };
      try {
        const rawPlan = await clients.geminiJson({
          systemPrompt: PLANNER_SYS(tpl),
          userPrompt: `ДИАЛОГ:\n${convo}\n\nВерни JSON-план.`,
          model: 'gemini-3.1-flash-lite', maxOutputTokens: 2048, timeoutMs: 25000,
        });
        const p = parseObj(rawPlan);
        if (p) plan = { ...plan, ...p };
      } catch (e) { console.warn('[draft-document] planner failed, degraded:', e.message); }

      const cats = ['exact', 'related', 'general', 'procedural'];
      const q = (plan.queries && typeof plan.queries === 'object') ? plan.queries : {};
      // Фолбэк-запросы, если планировщик не дал группу.
      const subj = plan.subject_line || tpl.label;
      const catQueries = {
        exact:      (Array.isArray(q.exact) && q.exact.length)           ? q.exact.slice(0, 4)      : [subj],
        related:    (Array.isArray(q.related) && q.related.length)       ? q.related.slice(0, 4)    : [],
        general:    (Array.isArray(q.general) && q.general.length)       ? q.general.slice(0, 3)    : [],
        procedural: (Array.isArray(q.procedural) && q.procedural.length) ? q.procedural.slice(0, 3) : ['исковое заявление форма содержание подсудность государственная пошлина ГПК Кыргызской Республики'],
      };

      // ── 2) ИЩЕЙКИ/RAG — параллельно по группам, широкий охват ──
      stage('📚 Ищу применимые нормы (точные, связанные, общие, процессуальные)…');
      const pool = new Map(); // key npa|article → {npa_title, article_title, full_text, score, cats:Set}
      const addHits = (hits, cat) => {
        for (const h of (hits || [])) {
          const md = (h && h.metadata) || {};
          if (!md.full_text) continue;
          const key = `${md.npa_title}|${md.article_title}`;
          let rec = pool.get(key);
          if (!rec) {
            rec = { npa_title: md.npa_title || '', article_title: md.article_title || '', full_text: String(md.full_text || '').slice(0, 1700), score: h.score || 0, cats: new Set() };
            pool.set(key, rec);
          }
          rec.cats.add(cat);
          if ((h.score || 0) > rec.score) rec.score = h.score || 0;
        }
      };
      await Promise.all(cats.map(async (cat) => {
        const qs = catQueries[cat];
        if (!qs || !qs.length) return;
        try {
          const hits = (await resolvedDeps.pineconeSearch?.(qs, null, 6)) || [];
          addHits(hits, cat);
        } catch (e) { console.warn(`[draft-document] RAG cat=${cat} failed:`, e.message); }
      }));
      let candidates = Array.from(pool.values()).sort((a, b) => b.score - a.score).slice(0, 28);
      stage(`📚 Найдено кандидат-норм: ${candidates.length}. Отбираю применимые…`, { found: candidates.length });

      // ── 3) ОТБОРЩИК — оставляет применимые, присваивает роль ──
      let selected = []; // {rec, role}
      if (candidates.length) {
        try {
          const list = candidates.map((c, i) => `[${i}] ${[c.npa_title, c.article_title].filter(Boolean).join(' — ')} :: ${c.full_text.slice(0, 240)}`).join('\n');
          const rawSel = await clients.geminiJson({
            systemPrompt: SELECTOR_SYS,
            userPrompt: `СУТЬ ДЕЛА: ${subj}\nВОПРОСЫ: ${(plan.legal_questions || []).join('; ')}\nДОСЬЕ: ${JSON.stringify(plan.facts || {})}\n\nКАНДИДАТЫ:\n${list}\n\nВерни JSON {keep:[...]}.`,
            model: 'gemini-3.1-flash-lite', maxOutputTokens: 2048, timeoutMs: 25000,
          });
          const sel = parseObj(rawSel);
          if (sel && Array.isArray(sel.keep)) {
            for (const k of sel.keep) {
              const idx = Number(k && k.i);
              if (Number.isInteger(idx) && candidates[idx]) {
                const role = ['exact', 'related', 'general', 'procedural'].includes(k.role) ? k.role : 'related';
                selected.push({ rec: candidates[idx], role });
              }
            }
          }
        } catch (e) { console.warn('[draft-document] selector failed, fallback to top candidates:', e.message); }
      }
      // Фолбэк: отборщик пуст → берём топ кандидатов, роль по группе RAG.
      if (!selected.length) {
        selected = candidates.slice(0, 14).map((rec) => ({
          rec, role: rec.cats.has('exact') ? 'exact' : rec.cats.has('procedural') ? 'procedural' : rec.cats.has('general') ? 'general' : 'related',
        }));
      }

      // Группируем выбранные нормы по роли для эталонного блока драфтера.
      const byRole = { exact: [], related: [], general: [], procedural: [] };
      for (const s of selected) (byRole[s.role] || byRole.related).push(s.rec);
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
      console.log(`[draft-document] ${docType} | candidates=${candidates.length} → selected=${selected.length} | roles=${JSON.stringify(Object.fromEntries(cats.map((c) => [c, byRole[c].length])))}`);

      // ── 4) ДРАФТЕР (DeepSeek v4-pro) ──
      stage(`✍️ Составляю документ по ${articlesUsed.length} нормам…`, { articles: articlesUsed.length });
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

      // Нормализация одного блока (защита фронт-рендера от мусора).
      const normalizeBlock = (b) => ({
        kind: String((b && b.kind) || 'paragraph'),
        ...(b && b.align ? { align: String(b.align) } : {}),
        runs: Array.isArray(b && b.runs)
          ? b.runs.filter((r) => r && typeof r === 'object').map((r) => ({
              t: String(r.t == null ? '' : r.t),
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
                  if (o && (o.kind || o.runs)) { streamedCount += 1; sse({ block: normalizeBlock(o) }); }
                } catch (_) { /* объект ещё не дописан корректно — пропускаем */ }
              }
            }
          }
        }
      };
      const onDelta = (d) => {
        if (!d) return;
        // Фаза reasoning (до контента): heartbeat, чтобы прокси Render держал SSE.
        if (d.reasoning) { hbReason += d.reasoning.length; if (hbReason > 1500) { hbReason = 0; sse({ heartbeat: 1 }); } }
        if (d.text) { acc += d.text; feedStream(); }
      };
      const { text: draftText, model: usedModel } = await clients.deepseekReason({
        systemPrompt: DRAFTER_SYS(tpl),
        userPrompt: drafterUser,
        model: 'deepseek-v4-pro', reasoning_effort: 'high', thinking: 'enabled',
        onDelta,
      });

      // Финальный парс целиком ([...] или {blocks:[...]}) — канонический результат
      // и фолбэк, если стрим-парсер что-то не выдернул (или формат-обёртка).
      const cleaned = String(draftText || '').replace(/```json\s*/gi, '').replace(/```/g, '').trim();
      const tryParse = (s) => { try { return JSON.parse(s); } catch (_) { return null; } };
      let parsed = tryParse(cleaned);
      if (!parsed) { const la = cleaned.indexOf('['), lb = cleaned.lastIndexOf(']'); if (la !== -1 && lb > la) parsed = tryParse(cleaned.slice(la, lb + 1)); }
      if (!parsed) { const oa = cleaned.indexOf('{'), ob = cleaned.lastIndexOf('}'); if (oa !== -1 && ob > oa) parsed = tryParse(cleaned.slice(oa, ob + 1)); }
      let blocks = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.blocks) ? parsed.blocks : null);

      if (!Array.isArray(blocks) || !blocks.length) {
        console.warn(`[draft-document] unparseable drafter output (len=${String(draftText || '').length}): ${String(draftText || '').slice(0, 200)}`);
        sse({ error: 'Драфтер вернул некорректный формат. Попробуйте ещё раз.' });
        return done();
      }

      const safeBlocks = blocks.filter((b) => b && typeof b === 'object').map(normalizeBlock);

      console.log(`[draft-document] ${docType} → ${safeBlocks.length} блоков (streamed=${streamedCount}) | norms=${articlesUsed.length} | model=${usedModel}`);
      sse({
        done: true,
        blocks: safeBlocks,
        streamedCount,
        articlesUsed,
        route: { planner: 'gemini-3.1-flash-lite', selector: 'gemini-3.1-flash-lite', drafter: usedModel },
      });
      return done();
    } catch (err) {
      console.error('[draft-document] error:', err.message);
      sse({ error: 'Сбой генерации: ' + err.message });
      return done();
    }
  });

  return router;
}

module.exports = {
  createAnalyzeV2Router,
  // экспорт чистых функций для smoke-тестов
  _internals: {
    buildInjectedContext, twoStagePineconeFilter,
    pickReasoningEffort, pickJudgeRoute, computeMetrics,
    toStepStatus, verdictToRow,
  },
};
