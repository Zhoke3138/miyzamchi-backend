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
const clients = require('./llmClients');
const { segmentDocumentRegex, wrapAsAnalyzeSegments } = require('../lib/segmentRegex');

// Переиспользуем готовые хелперы Agent 2 (рендер эталона + безопасный JSON).
const { renderArticles, safeJson } = legalAgents._internals;

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

// Потолок сегментов НА ДОКУМЕНТ (применяется симметрично к обеим редакциям).
const COMPARE_MAX_SEGMENTS = 90;

// ── ДЕТЕРМИНИРОВАННАЯ СЕГМЕНТАЦИЯ для режима сравнения (БЕЗ LLM) ──────
// КРИТИЧНО для ALIGN: LLM-сегментатор недетерминирован — режет два почти
// одинаковых документа по-разному (49 vs 53), и выравнивание «съезжает»,
// плодя ложные изменения. Здесь — чистая regex-сегментация (segmentDocumentRegex),
// та же боевая логика Phase 2 из analyze: одинаковая структура → одинаковое
// число сегментов → ALIGN опирается на жёсткую структуру.
function normalizeForCompare(text) {
  // CRLF/CR → LF, чтобы построчный split был идентичен для обеих редакций
  // (одна могла прийти из Word с \r\n, другая — из редактора с \n).
  return String(text || '').replace(/\r\n?/g, '\n');
}

function segmentForCompare(text, maxSegments = COMPARE_MAX_SEGMENTS) {
  const chunks = segmentDocumentRegex(normalizeForCompare(text));
  const wrapped = wrapAsAnalyzeSegments(chunks); // → [{id, number, heading, text}]
  return (maxSegments && wrapped.length > maxSegments)
    ? wrapped.slice(0, maxSegments)
    : wrapped;
}

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

// ── ДОКУМЕНТ-УРОВНЕВЫЙ РОУТИНГ: определяем применимое право один раз ──
// Анти-галлюцинация (Проблема 3): без темы Pinecone тащит законы из чужой отрасли
// (правила сотовой связи в договор ЖКХ). Определяем тему + применимые НПА ОДИН раз
// по эталонному (старому) тексту и подмешиваем их в КАЖДЫЙ поиск как якорь/фильтр.
const CONTRACT_CONTEXT_SYS = `Ты — определитель применимого права для документа Кыргызской Республики.
По тексту договора определи его отрасль и КАКИЕ нормативные акты КР его регулируют.
Верни СТРОГО JSON:
{ "subject": "<краткая тема договора: напр. 'теплоснабжение', 'аренда помещения', 'поставка товаров', 'оказание услуг'>",
  "governing_npas": ["<НПА 1>", "<НПА 2>"] }
ПРАВИЛА:
- governing_npas: 1-3 САМЫХ применимых акта. Гражданский кодекс КР применим почти всегда;
  добавь профильный акт по отрасли (Правила теплоснабжения, Трудовой кодекс КР, Жилищный кодекс КР и т.п.).
  Полные официальные названия, раскрывай аббревиатуры.
- subject — 1-3 слова, суть предмета договора.
- Только JSON, без markdown.`;

async function extractContractContext(docText) {
  const fallback = { subject: '', governing_npas: [] };
  const src = String(docText || '').trim();
  if (src.length < 80) return fallback;
  try {
    const raw = await clients.geminiJson({
      systemPrompt: CONTRACT_CONTEXT_SYS,
      userPrompt: `ДОГОВОР:\n${src.slice(0, 12000)}`,
      model: 'gemini-3.1-flash-lite', maxOutputTokens: 512, timeoutMs: 12000,
    });
    const p = safeJson(raw, {});
    const npas = Array.isArray(p.governing_npas)
      ? p.governing_npas.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 3)
      : [];
    const subject = p.subject && String(p.subject).trim() ? String(p.subject).trim() : '';
    console.log('[Compare DEBUG] governing_law:', JSON.stringify({ subject, governing_npas: npas }));
    return { subject, governing_npas: npas };
  } catch (_) {
    return fallback; // graceful: без контекста — деградируем к поиску без темы
  }
}

// ── ВАЛИДАТОР СРАВНЕНИЯ (Проблема 2): «старое vs новое vs закон» ──────
// Принимает ТРИ переменные: original_text, modified_text, governing_law (эталон по
// СТАРОМУ тексту). Вопрос: противоречит ли новая редакция императивной норме, на
// которой основан пункт? Это иначе, чем нормоконтроль цитирования в analyzeV2.
const COMPARE_VALIDATOR_SYS = `Ты — инспектор нормоконтроля договоров Кыргызской Республики.
Тебе даны:
• ORIGINAL_TEXT — старая (эталонная) редакция пункта договора;
• MODIFIED_TEXT — новая редакция (правка контрагента);
• GOVERNING_LAW — нормы закона КР, на которых основан пункт (найдены по старому тексту).

ВОПРОС: противоречит ли НОВАЯ редакция (MODIFIED_TEXT) ИМПЕРАТИВНОЙ норме из GOVERNING_LAW?

Верни СТРОГО JSON:
{ "status": "error" | "correct" | "out_of_base",
  "marker": "🔴 ОШИБКА" | "✅ Верно" | "⚠️ Вне базы",
  "detail": "<если error: какую норму и ЧЕМ именно нарушает новая редакция + как исправить>",
  "cited_articles": ["<НПА, ст.N из GOVERNING_LAW>"] }

ЖЕЛЕЗНЫЕ ПРАВИЛА:
1. status:"error" ТОЛЬКО при ПРЯМОМ противоречии новой редакции ИМПЕРАТИВНОЙ норме
   (закон запрещает X, а новая редакция вводит X; закон ставит предел, новая редакция его превышает).
2. ДИСПОЗИТИВНЫЕ нормы (которые стороны вправе менять соглашением) — изменение НЕ нарушение → "correct".
3. АНТИ-ГАЛЛЮЦИНАЦИЯ: если GOVERNING_LAW относится к ДРУГОЙ отрасли, не связанной с предметом
   договора (SUBJECT), это нерелевантный поиск — верни status:"out_of_base" и НЕ выдумывай нарушение.
4. Опирайся ТОЛЬКО на текст GOVERNING_LAW. Запрещено придумывать нормы/номера по памяти.
5. cited_articles — только статьи из GOVERNING_LAW.
6. Без markdown — только JSON.`;

async function compareValidate({ original_text, modified_text, articles, npa, subject }) {
  const userPrompt = `SUBJECT (предмет договора): ${subject || 'не определён'}
ПРИМЕНИМОЕ ПРАВО (эталон): ${npa || 'по семантике'}

ORIGINAL_TEXT (старая редакция):
${original_text || '(пункт отсутствовал — это добавление)'}

MODIFIED_TEXT (новая редакция):
${modified_text || '(пункт удалён)'}

GOVERNING_LAW (нормы из базы НПА КР, найденные по СТАРОМУ тексту):
${renderArticles(articles)}`;

  const ok = { status: 'correct', marker: '✅ Верно', detail: '', cited_articles: [] };
  try {
    const raw = await clients.geminiJson({
      systemPrompt: COMPARE_VALIDATOR_SYS, userPrompt,
      model: 'gemini-3.1-flash-lite', maxOutputTokens: 1024, timeoutMs: 15000,
    });
    const parsed = safeJson(raw, null);
    if (!parsed || !parsed.status) return ok;
    const status = parsed.status === 'error' ? 'error'
      : parsed.status === 'out_of_base' ? 'out_of_base' : 'correct';
    const marker = status === 'error' ? '🔴 ОШИБКА'
      : status === 'out_of_base' ? '⚠️ Вне базы' : '✅ Верно';
    return {
      status, marker,
      detail: typeof parsed.detail === 'string' ? parsed.detail : '',
      cited_articles: Array.isArray(parsed.cited_articles) ? parsed.cited_articles : [],
    };
  } catch (_) {
    return ok; // graceful: при сбое не плодим ложных нарушений
  }
}

// Дефолтные зависимости аудита: поиск из Agent 2 + наш валидатор сравнения.
function defaultAuditDeps() {
  return {
    expandQuery: legalAgents.expandQuery,
    pineconeSearch: legalAgents.pineconeSearch,
    validate: compareValidate,
  };
}

// ── ЮРИДИЧЕСКИЙ АУДИТ пары (ЯКОРНЫЙ поиск по СТАРОМУ тексту) ─────────
// Проблема 2: поиск НПА вёлся по newText (испорченный текст) → база не находила
// оригинальную норму. Теперь якорь поиска — oldText (эталон), он гарантированно
// приводит к правильному НПА; затем проверяем, не нарушает ли его новая редакция.
//   status: 'error'/'correct'/'out_of_base'/'no_base'/'skipped'
async function legalAudit({ oldText, newText, subject = '', governingNpas = [] } = {}, deps = defaultAuditDeps()) {
  const original = String(oldText || '').trim();
  const modified = String(newText || '').trim();
  // Якорь поиска — эталонный СТАРЫЙ текст; для чистых добавлений берём новый.
  const anchor = original || modified;
  if (anchor.length < 40) {
    return { status: 'skipped', marker: '', detail: '', cited_articles: [], npa: null, article: null };
  }

  try {
    const { npa, article, queries } = await deps.expandQuery(anchor);
    // Роутинг: НПА пункта, иначе документ-уровневый применимый акт.
    const effectiveNpa = npa || (governingNpas && governingNpas[0]) || null;
    // Тематический bias: гоним вектор в нужную отрасль/кодекс (анти-сотовая-связь).
    const prefix = [subject, effectiveNpa].filter(Boolean).join('. ');
    const biased = (queries || []).map((q) => (prefix ? `${prefix}. ${q}` : q));

    const rawHits = await deps.pineconeSearch(biased, effectiveNpa);
    const articles = filterHits(rawHits);
    if (!articles.length) {
      return { status: 'no_base', marker: '', detail: '', cited_articles: [], npa: effectiveNpa, article: article || null };
    }

    const v = await deps.validate({ original_text: original, modified_text: modified, articles, npa: effectiveNpa, subject });
    return {
      status: v.status || 'correct',
      marker: v.marker || '',
      detail: v.detail || '',
      cited_articles: Array.isArray(v.cited_articles) ? v.cited_articles : [],
      npa: effectiveNpa,
      article: article || null,
    };
  } catch (e) {
    return { status: 'skipped', marker: '', detail: '', cited_articles: [], npa: null, article: null, error: e.message };
  }
}

module.exports = {
  classifyChange,
  legalAudit,
  extractContractContext,
  compareValidate,
  segmentForCompare,
  escapeHtml,
  filterHits,
  COSMETIC_RATIO,
  _internals: { NUMERIC_TRIGGER_RE, HIT_REL_FACTOR, HIT_ABS_FLOOR, HIT_MAX, normalizeForCompare, COMPARE_MAX_SEGMENTS, defaultAuditDeps },
};
