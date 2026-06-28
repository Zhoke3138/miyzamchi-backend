'use strict';
// Supabase hybrid search: cosine vector similarity + GIN full-text search
// RPC: hybrid_search_documents(query_embedding, query_text, match_count)
// Columns returned: id, category, content, original_id, similarity
//
// Категории в базе:
//   "npa"            — НПА КР (кодексы, законы) → используем для анализа документов
//   "instructions"   — Инструкции ЦОН/ГНС (FAQ)  → только для чат-режима
//   "judicial_acts"  — Судебные акты              → по запросу
//
// Парсинг metadata (npa_title / article_title):
//   1. original_id = "kg_art-17_1782313373555_963" → номер статьи из "art-N" части
//   2. content начинается с "Документ: [НАЗВАНИЕ ЗАКОНА]\n..." → npa_title
//   3. Первая строка content = "Статья N. Заголовок" → article_title (fallback)

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Startup check — visible in Render logs immediately on deploy
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('[Supabase] ⚠️ STARTUP: SUPABASE_URL или SUPABASE_ANON_KEY не заданы — RAG отключён! Задайте в Render → Environment.');
} else {
    console.log(`[Supabase] ✅ STARTUP: подключено → ${SUPABASE_URL.slice(0, 50)}...`);
}

// Парсим номер статьи из original_id формата "kg_art-17_1782313373555_963"
// Берём только цифровую часть после "art-", до первого "_"
function parseArticleFromId(originalId) {
    const m = String(originalId || '').match(/art-(\d+)/i);
    return m ? `Статья ${m[1]}` : '';
}

// Парсим npa_title и article_title из текста контента
function parseMetaFromContent(content) {
    // NPA content: "Документ: ГРАЖДАНСКИЙ КОДЕКС КР (от ...)\n..."
    const docMatch = content.match(/^Документ:\s*([^\n]+)/);
    const npaTitle = docMatch ? docMatch[1].trim() : '';

    // Первая значимая строка: "Статья 17. Состав суда" → "Статья 17. Состав суда"
    const artLineMatch = content.match(/(?:Статья|Ст\.)\s+(\d+[\w.-]*)[.\s]([^\n]*)/);
    const articleTitle = artLineMatch
        ? `Статья ${artLineMatch[1]}${artLineMatch[2] ? '. ' + artLineMatch[2].trim() : ''}`
        : '';

    return { npaTitle, articleTitle };
}

/**
 * Поиск в Supabase.
 *
 * @param {number[]} vector        — эмбеддинг запроса (1536d)
 * @param {string}   queryText     — текст запроса для GIN full-text search
 * @param {number}   topK          — сколько результатов вернуть
 * @param {string[]} categories    — фильтр по category. По умолчанию ['npa'] (только законы).
 *                                   Передай [] или null чтобы не фильтровать.
 */
async function searchSupabase(vector, queryText = '', topK = 10, categories = ['npa']) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return [];

    // Запрашиваем больше чтобы после фильтрации по категории осталось достаточно
    const fetchCount = (categories && categories.length > 0) ? topK * 4 : topK;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
        const response = await fetch(
            `${SUPABASE_URL}/rest/v1/rpc/hybrid_search_documents`,
            {
                method: 'POST',
                headers: {
                    'apikey':        SUPABASE_ANON_KEY,
                    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                    'Content-Type':  'application/json',
                    'Prefer':        'return=representation'
                },
                body: JSON.stringify({
                    query_embedding: vector,
                    query_text:      queryText || '',
                    match_count:     fetchCount
                }),
                signal: controller.signal
            }
        );

        if (!response.ok) {
            const errText = await response.text();
            console.error(`[Supabase] RPC error ${response.status}: ${errText.slice(0, 400)}`);
            return [];
        }

        const rows = await response.json();
        if (!Array.isArray(rows) || rows.length === 0) {
            console.warn(`[Supabase] 0 результатов | query="${String(queryText||'').slice(0,80)}"`);
            return [];
        }

        const results = [];
        for (const row of rows) {
            // Фильтр по категории (например: только "npa" для анализа документов)
            if (categories && categories.length > 0 && !categories.includes(row.category)) continue;

            const content = String(row.content || '');
            if (content.length < 100) continue; // отсеиваем почти пустые записи

            // Приоритет: original_id ("kg_art-17_...") → article number
            const articleFromId = parseArticleFromId(row.original_id);
            const { npaTitle, articleTitle: articleFromContent } = parseMetaFromContent(content);

            const articleTitle = articleFromId || articleFromContent;
            const npaFinal    = npaTitle || row.category || '';

            results.push({
                id:    String(row.id || ''),
                score: typeof row.similarity === 'number' ? row.similarity : (row.score ?? 0),
                metadata: {
                    npa_title:     npaFinal,
                    article_title: articleTitle,
                    full_text:     content
                }
            });

            if (results.length >= topK) break; // достаточно результатов
        }

        const catLabel = categories && categories.length ? categories.join('+') : 'all';
        console.log(`[Supabase] fetched=${rows.length} cat=${catLabel} → kept=${results.length} | query="${String(queryText||'').slice(0,45)}" | top1: "${results[0]?.metadata?.npa_title?.slice(0,35)}" ${results[0]?.metadata?.article_title?.slice(0,20)}`);
        return results;

    } catch (err) {
        if (err.name === 'AbortError') {
            console.warn('[Supabase] timeout (8s)');
            return [];
        }
        console.error('[Supabase] searchSupabase error:', err.message);
        return [];
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = { searchSupabase };
