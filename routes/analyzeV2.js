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
// ФАЗА 1: Hybrid Chunking
// ---------------------------------------------------------------------------
const FLAT_CHUNK_SIZE = 1200;   // символов
const FLAT_OVERLAP = 150;       // overlap по ТЗ 2.2

/** Семантическая нарезка по '##'-заголовкам. */
function chunkByHeadings(markdown) {
  const parts = markdown.split(/\n(?=#{2,}\s)/g);
  return parts.map((t) => t.trim()).filter(Boolean);
}

/** Flat-нарезка по абзацам с overlap (фолбэк для сканов). */
function chunkFlat(markdown, size = FLAT_CHUNK_SIZE, overlap = FLAT_OVERLAP) {
  const text = markdown.replace(/\r\n/g, '\n');
  const chunks = [];
  for (let i = 0; i < text.length; i += size - overlap) {
    chunks.push(text.slice(i, i + size).trim());
  }
  return chunks.filter(Boolean);
}

function chunkDocument(markdown, structureConfidence) {
  if (structureConfidence === 'high') return chunkByHeadings(markdown);
  return chunkFlat(markdown);
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
 * Валидация одного чанка. [INTEGRATE]:
 *   1) Query Expansion (3-4 синонима) — deps.expandQuery
 *   2) Pinecone двухступенчатый фильтр (abs >=0.70, хвост >= maxScore-0.15) — deps.pineconeSearch
 *   3) Строгий Валидатор gemini-3.1-flash-lite -> { verdict, reason, cited_articles }
 *
 * Blind Spot: риск есть, но релевантных статей нет -> cited_articles = [].
 */
async function validateChunk(chunkText, index, state, deps) {
  const ctx = buildInjectedContext(chunkText, state);

  // [INTEGRATE] поиск законов
  const queries = (await deps.expandQuery?.(chunkText)) || [chunkText];
  const hits = (await deps.pineconeSearch?.(queries)) || [];
  const articles = twoStagePineconeFilter(hits);

  // [INTEGRATE] строгий валидатор -> строгий JSON
  const verdict = (await deps.validate?.({ chunkText, ctx, articles })) || {
    verdict: 'clean', reason: '', cited_articles: [],
  };

  // Контракт ТЗ 3.4: риск есть, статей нет -> пустой массив (Blind Spot)
  const citedArticles = Array.isArray(verdict.cited_articles) ? verdict.cited_articles : [];
  const isRisk = verdict.verdict === 'critical' || verdict.verdict === 'warning';
  return {
    index,
    verdict: verdict.verdict,
    reason: verdict.reason || '',
    cited_articles: citedArticles,
    blind_spot: isRisk && citedArticles.length === 0,
  };
}

/** Двухступенчатый фильтр Pinecone (ТЗ 3.3). */
function twoStagePineconeFilter(hits, absThreshold = 0.70, tail = 0.15) {
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
function pickReasoningEffort({ N, criticalCount, warningCount, blindSpotCount }) {
  const blindRatio = N ? blindSpotCount / N : 0;
  if (N > 100 || blindRatio > 0.3) return 'high';
  if (N < 15 && criticalCount === 0 && blindSpotCount === 0) return 'low';
  if (warningCount > 0 || criticalCount > 0) return 'medium';
  return 'low';
}

/** Метрики (ТЗ 4.3): confidenceScore = 1 - Слепые/N; purityIndex = 1 - Риски/N. */
function computeMetrics(graph, N) {
  const blind = graph.filter((g) => g.blind_spot).length;
  const risks = graph.filter((g) => g.verdict === 'critical' || g.verdict === 'warning').length;
  const safeDiv = (x) => (N ? +(1 - x / N).toFixed(3) : 1);
  return { confidenceScore: safeDiv(blind), purityIndex: safeDiv(risks), blindSpots: blind, risks };
}

// ── Маппинг вердикта в формат фронта (SSE-контракт прода) ──────────────────
// Статус шага thinking-box: clean→success, warning→warning, critical→error.
function toStepStatus(verdict) {
  return verdict === 'critical' ? 'error' : verdict === 'warning' ? 'warning' : 'success';
}

// Строка таблицы результатов. Статус: clean→ok, иначе сам verdict.
function verdictToRow(v) {
  const isClean = v.verdict === 'clean';
  return {
    item_number: `Фрагмент ${v.index + 1}`,
    short_verdict: isClean ? '✅ Без рисков' : (v.reason ? v.reason.slice(0, 140) : 'Выявлен риск'),
    status: isClean ? 'ok' : v.verdict,
    confidence: null,
    legal_rationale: v.reason || '',
    applicable_articles: v.cited_articles || [],
    law_refs: v.cited_articles || [],
    // V2-расширение: пометка Слепой зоны (риск без подтверждённой статьи).
    triage: v.blind_spot ? 'blind_spot' : undefined,
  };
}

// ---------------------------------------------------------------------------
// РОУТ
// ---------------------------------------------------------------------------
function createAnalyzeV2Router(deps = {}) {
  const express = require('express');
  const multer = require('multer');
  const { extractMarkdown } = require('../services/parserService');
  const { createDefaultDeps } = require('../services/legalAgents');
  const router = express.Router();
  const upload = makeUpload(multer);

  // Боевые агенты по умолчанию (Gemini/Pinecone/DeepSeek из .env);
  // переданные снаружи deps переопределяют дефолт (удобно для тестов/моков).
  const resolvedDeps = { ...createDefaultDeps(), ...deps };

  router.post('/analyze-document', upload.single('file'), async (req, res) => {
    // SSE-заголовки
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // SSE-эмиттеры в ТОЧНОМ формате прод-контракта (routes/analyze.js / script.js):
    //   { step:{id,status,text,reason?} } | { tableRow:{...} } | { purityIndex:int }
    //   { text:"markdown" } | { executive_summary:{...} } | [DONE] (литерал, НЕ JSON)
    const sse = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
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
      // ── ФАЗА 1: получение Markdown + чанкинг + словарь ────────────────
      step({ id: 'parse', status: 'loading', text: 'Готовлю документ' });
      let markdown; let source; let structure_confidence;
      if (req.file) {
        ({ markdown, source, structure_confidence } =
          await extractMarkdown(req.file.path, req.file.originalname)); // удалит /tmp сам (ZDR)
      } else {
        // Текст уже извлечён клиентом (pdfjs/mammoth) — Docling не нужен.
        markdown = String(bodyText);
        source = 'client_text';
        structure_confidence = /^\s{0,3}#{2,}\s/m.test(markdown) ? 'high' : 'low';
      }
      step({ id: 'parse', status: 'success', text: `Источник: ${source}, структура: ${structure_confidence}` });

      step({ id: 'segment', status: 'loading', text: 'Разбиваю документ на фрагменты' });
      const chunks = chunkDocument(markdown, structure_confidence);
      const state = await buildGlobalState(markdown, chunks, structure_confidence, resolvedDeps);
      step({ id: 'segment', status: 'success', text: `Фрагментов: ${state.N}` });

      // ── ФАЗА 2: волновая валидация (стримим tableRow по мере готовности) ─
      step({ id: 'validate', status: 'loading', text: '⚖️ Сверка с НПА КР (волновой троттлер)' });
      const settled = await runInWaves(
        chunks,
        async (chunkText, idx) => {
          const v = await validateChunk(chunkText, idx, state, resolvedDeps);
          // fastest-first: строка таблицы и шаг уходят сразу, не дожидаясь волны.
          step({
            id: `seg_${idx}`,
            status: toStepStatus(v.verdict),
            text: `Фрагмент ${idx + 1}`,
            reason: v.reason ? v.reason.slice(0, 80) : (v.verdict === 'clean' ? '✅ Без рисков' : ''),
          });
          sse({ tableRow: verdictToRow(v) });
          return v;
        },
      );
      const graph = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
      step({ id: 'validate', status: 'success', text: `Проверено фрагментов: ${graph.length}` });

      // ── ФАЗА 3: Judgment ─────────────────────────────────────────────
      const criticalCount = graph.filter((g) => g.verdict === 'critical').length;
      const warningCount = graph.filter((g) => g.verdict === 'warning').length;
      const blindSpotCount = graph.filter((g) => g.blind_spot).length;
      const effort = pickReasoningEffort({ N: state.N, criticalCount, warningCount, blindSpotCount });

      // purityIndex в формате прода: доля непроблемных пунктов, 0-100.
      const purityIndex = state.N ? Math.round(((state.N - criticalCount) / state.N) * 100) : 100;
      sse({ purityIndex });

      step({ id: 'judge', status: 'loading', text: `🧠 Финальный судья (effort=${effort})` });
      const report = (await resolvedDeps.judge?.({ graph, effort, state })) || { summary: '', risks: graph };
      step({ id: 'judge', status: 'success', text: 'Итоговый отчёт готов' });

      // Текст судьи (markdown, 2 секции) — фронт рендерит как основной отчёт.
      if (report.summary) sse({ text: report.summary });

      // Executive Summary card.
      const risks = graph.filter((g) => g.verdict === 'critical' || g.verdict === 'warning');
      const topRisks = risks.slice(0, 3).map((r) => ({
        id: `Фрагмент ${r.index + 1}`,
        title: (r.reason || '').slice(0, 120),
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

  return router;
}

module.exports = {
  createAnalyzeV2Router,
  // экспорт чистых функций для smoke-тестов
  _internals: {
    chunkByHeadings, chunkFlat, chunkDocument,
    buildInjectedContext, twoStagePineconeFilter,
    pickReasoningEffort, computeMetrics,
    toStepStatus, verdictToRow,
  },
};
