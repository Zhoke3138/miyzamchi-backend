// ═══════════════════════════════════════════════════════════════════════
//  lib/hierarchicalContext.js
//  Hierarchical Contextual RAG — Composer (Macro + Mezzo + Micro).
//  Selective Reasoning v2.0  ·  2026-05-30
// ═══════════════════════════════════════════════════════════════════════
//
//  Главный entrypoint для агента-верификатора. Объединяет:
//   • Macro (documentPassport.js)      — AI-паспорт всего документа
//   • Mezzo (topology.js)              — топология этого конкретного чанка
//   • Micro (text)                     — сам chunk
//
//  Два потока:
//   1. buildHCREmbeddingQuery(text, passport, topology) → string
//      Сжимает тройной контекст в одну строку для Pinecone.
//      Формат: [Документ: ...] [п.N/M · раздел "..."] <micro text>
//
//   2. buildHCRSystemPrompt(basePrompt, passport, topology) → string
//      Расширяет system prompt: passport block + topology block + docType hint
//      + базовый промпт. Один промпт обслуживает любой документ.
//
//  Lossless: если passport / topology отсутствуют — соответствующие блоки
//  опускаются. Базовый промпт и оригинальный текст всегда сохранены.
// ═══════════════════════════════════════════════════════════════════════

const {
    buildMacroEmbeddingPrefix,
    buildMacroSystemBlock,
    deriveDocTypeHint
} = require('./documentPassport');

const {
    buildMesoEmbeddingPrefix,
    buildMesoSystemBlock
} = require('./topology');

/**
 * buildHCREmbeddingQuery — компактная строка для Pinecone.
 *
 *   "[Документ: ...] [п.7/23 · раздел "..."] статья 137 и 191"
 *
 * Для договоров без явных "статья N" — semanticHints в macro-префиксе
 * вытащит Pinecone в правильную отрасль (например, "кабальные условия,
 * неустойка" приведёт к ГК КР даже без слова "статья").
 *
 * Для жалоб с явными ссылками — expectedNpas даст точечный hit по номерам.
 */
function buildHCREmbeddingQuery(text, passport, topology) {
    return buildMacroEmbeddingPrefix(passport)
         + buildMesoEmbeddingPrefix(topology)
         + String(text || '');
}

/**
 * buildHCRSystemPrompt — расширенный системный промпт для агента.
 *
 *   📋 ПАСПОРТ ДОКУМЕНТА:
 *      • Тип: complaint · Жалоба в ООН против пыток
 *      • Суть: ...
 *      • Отрасли права КР: ...
 *      • Ожидаемые НПА: УК КР, Конвенция против пыток, МПГПП
 *      • Статьи из ДРУГИХ НПА — false positive: status="warning".
 *      ...
 *
 *   📍 ТОПОЛОГИЯ ПУНКТА:
 *      • Позиция: пункт 7 из 23 (30% документа)
 *      • Раздел документа: «Нарушения УК КР»
 *      • Предыдущий пункт начинался: «Часть 2 статьи 9 УК...»
 *      • Следующий пункт начинается: «Также проигнорированы статьи 137...»
 *
 *   🎯 ФОКУС: жалоба. Ищи нарушения прав человека/процедуры, ...
 *
 *   {basePrompt}
 *
 * Если passport ИЛИ topology отсутствуют — соответствующие блоки опущены,
 * но базовый промпт сохранён as-is.
 */
function buildHCRSystemPrompt(basePrompt, passport, topology) {
    const blocks = [];
    const macro = buildMacroSystemBlock(passport);
    if (macro) blocks.push(macro);
    const meso = buildMesoSystemBlock(topology);
    if (meso)  blocks.push(meso);
    if (passport) {
        const hint = deriveDocTypeHint(passport);
        if (hint) blocks.push(hint);
    }
    blocks.push(String(basePrompt || ''));
    return blocks.join('\n\n');
}

/**
 * buildHCRUserPromptLine — короткая sticky-строка в userPrompt,
 * подстраховка для модели если она проигнорирует system prompt.
 *
 *   "ЛОКАЛЬНАЯ ТОПОЛОГИЯ: пункт 7/23, раздел «Нарушения УК КР»."
 *
 * Если topology нет — возвращает '' (caller вставляет как есть).
 */
function buildHCRUserPromptLine(topology) {
    if (!topology) return '';
    const parts = [];
    parts.push(`пункт ${topology.chunkIndex}/${topology.totalChunks}`);
    if (topology.section) parts.push(`раздел «${topology.section}»`);
    return `ЛОКАЛЬНАЯ ТОПОЛОГИЯ: ${parts.join(', ')}.\n`;
}

module.exports = {
    buildHCREmbeddingQuery,
    buildHCRSystemPrompt,
    buildHCRUserPromptLine
};
