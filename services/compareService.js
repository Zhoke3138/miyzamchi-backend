'use strict';
/**
 * Miyzamchi 2.0 — Гибридное сравнение редакций: DIFF + Юридический аудит
 * =====================================================================
 * Чистые, тестируемые куски пайплайна сравнения (оркестрация — в routes/compare.js):
 *
 *   classifyChange(old, new)  — пословный diff → { ratio, html(redline), isCosmetic, numericFlag }
 *   legalAudit(text, deps)    — переиспользует Agent 2 из legalAgents.js (expandQuery →
 *                                pineconeSearch → validate), чтобы узнать, не нарушает ли
 *                                новая редакция пункта законы КР.
 *
 * Почему отдельный модуль: diff/ratio/escape — это чистые функции без сети, их можно
 * прогнать смоук-тестом на fake-данных; legalAudit принимает deps (инъекция) → мокается.
 */

const Diff = require('diff');
const legalAgents = require('./legalAgents');

// ── ПАРАМЕТРЫ ───────────────────────────────────────────────────────
// Порог «косметики»: доля изменённых символов. Ниже него (и без числовых
// триггеров) — пара считается косметической и LLM по ней НЕ дёргается.
const COSMETIC_RATIO = 0.12;

// КИЛЛЕР-ФИЧА: «Числовой страж». Замена «0,1%»→«10%» или удаление «не более 25%»
// даёт КРОШЕЧНЫЙ ratio, но это критичное юридическое изменение. Если изменённые
// токены содержат цифры / валюту / % / сроки / ключевые юр-слова — пара НЕ косметическая,
// какой бы маленький ни был ratio. Защита от ложноотрицательных (false negatives).
const NUMERIC_TRIGGER_RE = /[0-9]|%|сом|руб|долл|евро|процент|пени|пеня|неустойк|штраф|срок|дн(?:ей|я|и)|недел|месяц|год|кварт|подсуд|подведомств|растор|односторон|ответствен|пролонг|неустой|задаток|залог|аванс|предоплат/iu;

// Фильтр Pinecone-хитов для validate: относительный + абсолютный порог, чтобы в
// эталон не попадал нерелевантный мусор (он провоцирует ложные «ошибки»).
const HIT_REL_FACTOR = 0.6;     // ≥ 60% от лучшего score
const HIT_ABS_FLOOR  = 0.35;    // и не ниже абсолютного дна
const HIT_MAX        = 6;       // не более 6 эталонных статей в промпт

// ── HTML-экранирование (XSS: текст документа недоверенный, IDE рендерит HTML) ──
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Пословный diff → redline-HTML + ratio + числовой флаг ────────────
// Возвращает:
//   ratio       — доля изменённых символов [0..1] (1 = полностью добавлено/удалено)
//   html        — redline: <del> удалённое, <ins> добавленное, общий текст as-is (экранирован)
//   numericFlag — true, если в изменённых сегментах есть цифры/деньги/сроки/юр-триггеры
//   isCosmetic  — true ТОЛЬКО если ratio < порога И numericFlag=false
function classifyChange(oldText, newText) {
  const oldS = String(oldText || '');
  const newS = String(newText || '');

  // Полное добавление / удаление — diff не нужен, это всегда существенно.
  if (!oldS && newS) {
    return { ratio: 1, html: `<ins class="ml-ins">${escapeHtml(newS)}</ins>`, numericFlag: true, isCosmetic: false };
  }
  if (oldS && !newS) {
    return { ratio: 1, html: `<del class="ml-del">${escapeHtml(oldS)}</del>`, numericFlag: true, isCosmetic: false };
  }
  if (!oldS && !newS) {
    return { ratio: 0, html: '', numericFlag: false, isCosmetic: true };
  }

  const parts = Diff.diffWordsWithSpace(oldS, newS);
  let changed = 0;
  let total = 0;
  let numericFlag = false;
  let html = '';

  for (const part of parts) {
    const len = part.value.length;
    total += len;
    const esc = escapeHtml(part.value);
    if (part.added) {
      changed += len;
      if (NUMERIC_TRIGGER_RE.test(part.value)) numericFlag = true;
      html += `<ins class="ml-ins">${esc}</ins>`;
    } else if (part.removed) {
      changed += len;
      if (NUMERIC_TRIGGER_RE.test(part.value)) numericFlag = true;
      html += `<del class="ml-del">${esc}</del>`;
    } else {
      html += esc;
    }
  }

  const ratio = total > 0 ? changed / total : 0;
  const isCosmetic = ratio < COSMETIC_RATIO && !numericFlag;
  return { ratio: Number(ratio.toFixed(3)), html, numericFlag, isCosmetic };
}

// ── Фильтр Pinecone-хитов перед подачей в validate ──────────────────
function filterHits(hits) {
  const arr = (hits || []).filter((h) => h && typeof h.score === 'number');
  if (!arr.length) return [];
  arr.sort((a, b) => b.score - a.score);
  const top = arr[0].score;
  const floor = Math.max(HIT_ABS_FLOOR, top * HIT_REL_FACTOR);
  let kept = arr.filter((h) => h.score >= floor).slice(0, HIT_MAX);
  if (!kept.length) kept = arr.slice(0, 3); // подстраховка: хоть что-то эталонное
  return kept;
}

// ── ЮРИДИЧЕСКИЙ АУДИТ пункта (переиспользует Agent 2 из legalAgents.js) ──
// Берём НОВУЮ редакцию пункта (от контрагента) и проверяем, не противоречит ли
// она НПА КР. Возвращает компактный вердикт для финального судьи.
//   status: 'error'      — пункт ПРОТИВОРЕЧИТ норме (🔴, ничтожное/оспоримое условие)
//           'correct'    — соответствует / нет противоречий с эталоном
//           'out_of_base'— ссылка на акт вне базы (международный и т.п.) — ручная проверка
//           'no_base'    — релевантных норм в базе не нашлось (нечего проверять)
//           'skipped'    — аудит не запускался (короткий/служебный пункт)
async function legalAudit(clauseText, deps = legalAgents) {
  const text = String(clauseText || '').trim();
  // Совсем короткие пункты (реквизиты, «г. Бишкек», даты) не аудируем.
  if (text.length < 40) {
    return { status: 'skipped', marker: '', detail: '', cited_articles: [], npa: null, article: null };
  }

  try {
    const { npa, article, queries } = await deps.expandQuery(text);
    const rawHits = await deps.pineconeSearch(queries, npa);
    const articles = filterHits(rawHits);

    if (!articles.length) {
      return { status: 'no_base', marker: '', detail: '', cited_articles: [], npa: npa || null, article: article || null };
    }

    const v = await deps.validate({ chunkText: text, ctx: null, articles, npa, article });
    return {
      status: v.status || 'correct',
      marker: v.marker || '',
      detail: v.detail || '',
      cited_articles: Array.isArray(v.cited_articles) ? v.cited_articles : [],
      npa: npa || null,
      article: article || null,
    };
  } catch (e) {
    // Graceful: сбой аудита не должен валить всё сравнение.
    return { status: 'skipped', marker: '', detail: '', cited_articles: [], npa: null, article: null, error: e.message };
  }
}

module.exports = {
  classifyChange,
  legalAudit,
  escapeHtml,
  filterHits,
  COSMETIC_RATIO,
  _internals: { NUMERIC_TRIGGER_RE, HIT_REL_FACTOR, HIT_ABS_FLOOR, HIT_MAX },
};
