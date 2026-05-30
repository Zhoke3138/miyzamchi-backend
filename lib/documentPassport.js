// ═══════════════════════════════════════════════════════════════════════
//  lib/documentPassport.js
//  Hierarchical Contextual RAG — Macro Layer (AI-паспорт документа).
//  Selective Reasoning v2.0  ·  2026-05-30
// ═══════════════════════════════════════════════════════════════════════
//
//  Один компактный LLM-вызов через lightLLMCascade (Tier 1 = Gemini 3.1
//  Flash Lite, ~1 сек, ~600/200 токенов, ~$0.0001 на документ). Запускается
//  параллельно с Router+Triage в preparePipelineState — на cold-start не
//  даёт латентности (max-параллельный). На warm-start (Shadow Pipeline)
//  достаётся из session-кэша.
//
//  Универсальность: один паспорт обслуживает все типы документов —
//  от расписки на салфетке до иска в ООН. docType + branches + expectedNpas
//  + semanticHints дают Pinecone точечный фокус И семантический поиск для
//  документов без явных ссылок на статьи (договоры, расписки, претензии).
//
//  Контракт shape:
//   DocumentPassport = {
//       title:         string  // "Жалоба в Комитет ООН против пыток"
//       docType:       enum    // см. VALID_DOC_TYPES
//       summary:       string  // 3-4 предложения
//       branches:      string[]// 1-3 отрасли права КР
//       expectedNpas:  string[]// 3-5 ключевых НПА (точно применимых)
//       semanticHints: string[]// 3-7 юридических концептов
//       parties:       string[]// опционально
//       totalChunks:   number
//   }
//
//  API:
//   generateDocumentPassport({ text, segmentsCount, cascade, telemetry, logger }) → Promise<DocumentPassport|null>
//   buildMacroEmbeddingPrefix(passport) → string
//   buildMacroSystemBlock(passport)     → string
//   deriveDocTypeHint(passport)         → string
// ═══════════════════════════════════════════════════════════════════════

const VALID_DOC_TYPES = [
    'complaint',  // жалоба
    'contract',   // договор
    'lawsuit',    // иск
    'claim',      // претензия
    'receipt',    // расписка / договор займа
    'agreement',  // соглашение / доп.соглашение
    'statement',  // заявление
    'letter',     // служебное письмо
    'other'       // не классифицировано
];

const MAX_TITLE_CHARS    = 120;
const MAX_SUMMARY_CHARS  = 600;
const MAX_TEXT_HEAD      = 4000;   // лимит на текст в промпте паспорта
const MAX_BRANCHES       = 3;
const MAX_NPAS           = 5;
const MAX_HINTS          = 7;
const MAX_PARTIES        = 4;
const MAX_ITEM_CHARS     = 80;

function _sanitizeArray(input, maxLen) {
    if (!Array.isArray(input)) return [];
    const out = [];
    const seen = new Set();
    for (const item of input) {
        if (typeof item !== 'string') continue;
        const clean = item.trim().slice(0, MAX_ITEM_CHARS);
        if (!clean) continue;
        const key = clean.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(clean);
        if (out.length >= maxLen) break;
    }
    return out;
}

function _sanitizeString(input, maxLen) {
    return String(input || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

const SYSTEM_PROMPT = `Ты — Senior юрист Кыргызской Республики. Тебе дан текст юридического документа.
Составь компактный паспорт — он будет использован для семантического поиска по базе НПА КР
и для системного промпта агентов-проверяющих.

Формат — СТРОГО валидный JSON без markdown, без пояснений, без \`\`\`json:

{
  "title":         "<до 100 символов: короткое название>",
  "docType":       "complaint" | "contract" | "lawsuit" | "claim" | "receipt" | "agreement" | "statement" | "letter" | "other",
  "summary":       "<3-4 предложения: суть документа, стороны, основной запрос/предмет>",
  "branches":      ["1-3 отрасли права КР, например: 'гражданское право', 'уголовное право'"],
  "expectedNpas":  ["3-5 НПА КР, которые ОЖИДАЮТСЯ в этом документе: 'Гражданский кодекс КР', 'УК КР', 'Закон о защите прав потребителей' и т.п."],
  "semanticHints": ["3-7 ключевых юридических концептов для семантического поиска: 'кабальные условия', 'неустойка', 'исковая давность', 'презумпция невиновности'"],
  "parties":       ["сторона 1", "сторона 2"]
}

Правила:
- title — короткий, как ярлык документа.
- docType — выбирай ОДИН из перечисленных. "receipt" — для расписок и договоров займа. "agreement" — для соглашений и доп.соглашений к договорам.
- summary — никаких "это документ о…". Прямо: тип, стороны, предмет, цель.
- branches — конкретные отрасли права КР, не общие слова.
- expectedNpas — те, которые юрист точно бы применил при разборе. Для расписки = ["Гражданский кодекс КР"]. Для жалобы в ООН на пытки = ["Конвенция против пыток", "МПГПП", "Конституция КР", "УК КР"].
- semanticHints — это якоря для Pinecone. Они должны звучать как заголовки статей и тезисы. Для договора оказания услуг: ["оказание услуг", "оплата исполнителю", "сроки сдачи", "конфиденциальность"].
- Если каких-то полей не извлечь — верни пустой массив [], но НЕ опускай ключ.

Без markdown. Без пояснений.`;

/**
 * generateDocumentPassport — один LLM-вызов через lightLLMCascade.
 * Возвращает DocumentPassport или null (graceful degradation на ошибках).
 */
async function generateDocumentPassport({ text, segmentsCount, cascade, telemetry, logger = console }) {
    if (!text || typeof text !== 'string' || text.trim().length < 50) return null;
    if (!cascade || typeof cascade.call !== 'function') {
        logger?.warn?.('[Passport] cascade not provided, skipping passport generation');
        return null;
    }
    const head = text.length > MAX_TEXT_HEAD
        ? text.slice(0, MAX_TEXT_HEAD) + '\n[...текст обрезан для скорости анализа]'
        : text;
    const userPrompt = `Текст документа:
"""
${head}
"""

Документ после сегментации разбит на ${segmentsCount || '?'} пунктов.

Верни JSON-паспорт по правилам выше.`;

    try {
        const result = await cascade.call({
            systemPrompt: SYSTEM_PROMPT,
            userPrompt,
            jsonMode: true,
            temperature: 0.0,
            maxOutputTokens: 1024,
            telemetry,
            stageLabel: 'doc_passport'
        });
        if (!result || !result.text) return null;

        let parsed;
        try { parsed = JSON.parse(result.text); }
        catch (e) {
            logger?.warn?.(`[Passport] JSON parse failed: ${e.message?.slice(0, 100)}`);
            return null;
        }
        if (!parsed || typeof parsed !== 'object') return null;

        const docType = VALID_DOC_TYPES.includes(parsed.docType) ? parsed.docType : 'other';
        const passport = {
            title:         _sanitizeString(parsed.title,   MAX_TITLE_CHARS),
            docType,
            summary:       _sanitizeString(parsed.summary, MAX_SUMMARY_CHARS),
            branches:      _sanitizeArray(parsed.branches,      MAX_BRANCHES),
            expectedNpas:  _sanitizeArray(parsed.expectedNpas,  MAX_NPAS),
            semanticHints: _sanitizeArray(parsed.semanticHints, MAX_HINTS),
            parties:       _sanitizeArray(parsed.parties,       MAX_PARTIES),
            totalChunks:   Number(segmentsCount) || 0,
            model:         result.model,
            tier:          result.tier
        };
        // Если title пуст и нет ничего полезного — это явно ложный результат.
        if (!passport.title && !passport.summary && passport.expectedNpas.length === 0) {
            return null;
        }
        return passport;
    } catch (err) {
        // err.allFailed → все 3 tier'а каскада упали. Graceful degradation:
        // вернём null, дальше pipeline будет использовать globalContext fallback.
        logger?.warn?.(`[Passport] cascade failed: ${err.message?.slice(0, 120)}`);
        return null;
    }
}

/**
 * buildMacroEmbeddingPrefix — одна строка-префикс для Pinecone query.
 *
 * Формат:
 *   [Документ: <title> · <branches[]> · <expectedNpas[]> · <semanticHints[]>]
 *
 * Если passport отсутствует — возвращает пустую строку (caller не теряет
 * запрос, просто без macro-boost).
 */
function buildMacroEmbeddingPrefix(passport) {
    if (!passport) return '';
    const parts = [];
    if (passport.title)             parts.push(passport.title);
    if (passport.branches?.length)  parts.push(passport.branches.join('; '));
    if (passport.expectedNpas?.length) parts.push(passport.expectedNpas.join(', '));
    if (passport.semanticHints?.length) parts.push(passport.semanticHints.join(', '));
    if (parts.length === 0) return '';
    return `[Документ: ${parts.join(' · ')}] `;
}

/**
 * buildMacroSystemBlock — multi-line блок для system prompt агента.
 * Все доступные поля паспорта.
 */
function buildMacroSystemBlock(passport) {
    if (!passport) return '';
    const lines = ['📋 ПАСПОРТ ДОКУМЕНТА:'];
    if (passport.title)    lines.push(`   • Тип: ${passport.docType}  ·  ${passport.title}`);
    else                   lines.push(`   • Тип: ${passport.docType}`);
    if (passport.summary)  lines.push(`   • Суть: ${passport.summary}`);
    if (passport.parties?.length) lines.push(`   • Стороны: ${passport.parties.join(' / ')}`);
    if (passport.branches?.length) lines.push(`   • Отрасли права КР: ${passport.branches.join(', ')}`);
    if (passport.expectedNpas?.length) {
        lines.push(`   • Ожидаемые НПА: ${passport.expectedNpas.join(', ')}`);
        lines.push(`   • Статьи из ДРУГИХ НПА — false positive: status="warning".`);
    }
    if (passport.semanticHints?.length) lines.push(`   • Ключевые концепты: ${passport.semanticHints.join(', ')}`);
    if (passport.totalChunks) lines.push(`   • Всего пунктов: ${passport.totalChunks}`);
    return lines.join('\n');
}

// docTypeHint: один промпт обслуживает все 9 типов документов через
// контекстный «фокус». Это и есть суть универсальной системы:
// от расписки до иска в ООН — без дублирования логики на стороне Node.
const DOC_TYPE_HINTS = {
    contract:   '🎯 ФОКУС: договор. Ищи кабальные условия, дисбаланс прав сторон, прижатые сроки исполнения, отсутствие существенных условий (предмет/цена/срок), односторонние права расторжения, скрытые штрафы.',
    complaint:  '🎯 ФОКУС: жалоба. Ищи нарушения прав человека/процедуры, бездействие государства, неисполнение международных обязательств КР, упущение срока обжалования.',
    lawsuit:    '🎯 ФОКУС: исковое заявление. Проверь подсудность (РСМС / горсуд / районный суд), исковую давность, корректность требований, соответствие предмета иска основаниям и доказательствам.',
    claim:      '🎯 ФОКУС: претензия (досудебная). Проверь срок ответа, форму уведомления, корректность правовых требований, наличие реквизитов и подписи.',
    receipt:    '🎯 ФОКУС: расписка / договор займа. Проверь существенные условия (сумма, валюта, срок возврата, проценты, стороны), юридическую чистоту реквизитов, риск ничтожности.',
    agreement:  '🎯 ФОКУС: соглашение / доп.соглашение. Проверь юр.последствия для каждой стороны, наличие существенных условий, дисбаланс прав, чистоту реквизитов.',
    statement:  '🎯 ФОКУС: заявление в государственный орган. Проверь корректность адресата, соответствие предмета заявления процедуре, наличие правовых оснований.',
    letter:     '🎯 ФОКУС: служебное письмо. Проверь корректность правовых ссылок, юр.тон, наличие шапки/реквизитов.',
    other:      '🎯 ФОКУС: тип документа не классифицирован. Применяй общий юридический анализ КР.'
};

function deriveDocTypeHint(passport) {
    if (!passport) return DOC_TYPE_HINTS.other;
    return DOC_TYPE_HINTS[passport.docType] || DOC_TYPE_HINTS.other;
}

module.exports = {
    generateDocumentPassport,
    buildMacroEmbeddingPrefix,
    buildMacroSystemBlock,
    deriveDocTypeHint,
    VALID_DOC_TYPES,
    DOC_TYPE_HINTS,
    MAX_TITLE_CHARS, MAX_SUMMARY_CHARS, MAX_TEXT_HEAD,
    MAX_BRANCHES, MAX_NPAS, MAX_HINTS
};
