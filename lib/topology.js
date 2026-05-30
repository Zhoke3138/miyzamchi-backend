// ═══════════════════════════════════════════════════════════════════════
//  lib/topology.js
//  Hierarchical Contextual RAG — Mezzo Layer (топология чанка).
//  Selective Reasoning v2.0  ·  2026-05-30
// ═══════════════════════════════════════════════════════════════════════
//
//  Каждому чанку даём ответ "где я нахожусь?":
//   • chunkIndex / totalChunks (позиция в документе)
//   • position 0..1 (для прогресса)
//   • section — sticky heading (последний section heading до этого чанка)
//   • prevHeading — первая строка предыдущего чанка (компактно, 80 chars)
//   • nextHeading — первая строка следующего чанка
//
//  Sticky section вычисляется через одного из двух источников:
//   1. Если caller передал chunkContexts от hybridSegmenter — берём оттуда.
//   2. Иначе — извлекаем через extractSectionHeading из lib/localContext.js
//      (та же эвристика, что и в segmentRegex).
//
//  API:
//   buildChunkTopology({ chunks, chunkIndex, chunkContexts? }) → ChunkTopology
//   buildMesoEmbeddingPrefix(topology) → string  (для Pinecone query)
//   buildMesoSystemBlock(topology)     → string  (для system prompt)
// ═══════════════════════════════════════════════════════════════════════

const { extractSectionHeading } = require('./localContext');

const MAX_HEADING_SNIPPET = 80;
const MAX_SECTION_CHARS   = 100;

function _firstLineSnippet(chunkText) {
    if (!chunkText || typeof chunkText !== 'string') return null;
    const firstLine = chunkText.split('\n', 1)[0].trim();
    if (!firstLine) return null;
    return firstLine.slice(0, MAX_HEADING_SNIPPET);
}

/**
 * buildChunkTopology — собирает Mezzo-контекст для одного чанка.
 *
 * @param {Object} opts
 * @param {string[]} opts.chunks — все чанки документа (строки)
 * @param {number}   opts.chunkIndex — 0-based позиция в массиве chunks
 * @param {Array}    [opts.chunkContexts] — параллельный массив от hybridSegmenter,
 *                                          chunkContexts[i].section используется
 *                                          как sticky section если есть.
 * @returns {ChunkTopology|null}
 */
function buildChunkTopology(opts = {}) {
    const { chunks, chunkIndex, chunkContexts = null } = opts;
    if (!Array.isArray(chunks) || chunks.length === 0) return null;
    if (typeof chunkIndex !== 'number' || chunkIndex < 0 || chunkIndex >= chunks.length) return null;

    const total = chunks.length;
    const idx1Based = chunkIndex + 1;

    // Section: приоритет — chunkContexts от hybridSegmenter (sticky).
    // Fallback — извлечь из текущего chunk своими силами.
    let section = null;
    if (Array.isArray(chunkContexts) && chunkContexts[chunkIndex] && chunkContexts[chunkIndex].section) {
        section = String(chunkContexts[chunkIndex].section).slice(0, MAX_SECTION_CHARS);
    } else {
        section = extractSectionHeading(chunks[chunkIndex]);
    }

    const prevHeading = chunkIndex > 0          ? _firstLineSnippet(chunks[chunkIndex - 1]) : null;
    const nextHeading = chunkIndex < total - 1  ? _firstLineSnippet(chunks[chunkIndex + 1]) : null;

    return {
        chunkIndex: idx1Based,
        totalChunks: total,
        position: Number((idx1Based / total).toFixed(2)),
        section,
        prevHeading,
        nextHeading
    };
}

/**
 * buildMesoEmbeddingPrefix — компактная строка для Pinecone query.
 *   [п.7/23 · раздел "Нарушения УК КР"]
 *
 * prevHeading / nextHeading в embedding НЕ кладём — это для агента,
 * а в embedding каждый лишний токен размывает фокус.
 */
function buildMesoEmbeddingPrefix(topology) {
    if (!topology) return '';
    const parts = [];
    parts.push(`п.${topology.chunkIndex}/${topology.totalChunks}`);
    if (topology.section) parts.push(`раздел "${topology.section}"`);
    return `[${parts.join(' · ')}] `;
}

/**
 * buildMesoSystemBlock — multi-line блок для system prompt.
 * Здесь даём агенту полную картину: позиция, раздел, соседи.
 */
function buildMesoSystemBlock(topology) {
    if (!topology) return '';
    const lines = ['📍 ТОПОЛОГИЯ ПУНКТА:'];
    lines.push(`   • Позиция: пункт ${topology.chunkIndex} из ${topology.totalChunks}  (${Math.round(topology.position * 100)}% документа)`);
    if (topology.section)     lines.push(`   • Раздел документа: «${topology.section}»`);
    if (topology.prevHeading) lines.push(`   • Предыдущий пункт начинался: «${topology.prevHeading}»`);
    if (topology.nextHeading) lines.push(`   • Следующий пункт начинается: «${topology.nextHeading}»`);
    return lines.join('\n');
}

module.exports = {
    buildChunkTopology,
    buildMesoEmbeddingPrefix,
    buildMesoSystemBlock,
    MAX_HEADING_SNIPPET,
    MAX_SECTION_CHARS
};
