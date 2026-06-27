'use strict';
// Supabase hybrid search: cosine vector similarity + GIN full-text search
// RPC signature expected: hybrid_search_documents(query_embedding, query_text, match_count)
// Return columns: id, category, content, original_id, similarity
//
// ВАЖНО: category — это ТИП записи ("npa"/"instructions"), НЕ название закона.
// original_id — внутренний ID вроде "faq_tax_1781...", НЕ номер статьи.
// Реальные npa_title и article_title парсятся из поля content:
//   content начинается с "Документ: ГРАЖДАНСКИЙ КОДЕКС КР...\nСтатья 45..."
// Mapping to Pinecone-compatible format used throughout the codebase:
//   parsed from content  → metadata.npa_title    (название НПА/кодекса)
//   parsed from content  → metadata.article_title (номер статьи)
//   content              → metadata.full_text    (полный текст статьи)
//   similarity           → score                 (float [0,1])

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Startup check — visible in Render logs immediately on deploy
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('[Supabase] ⚠️ STARTUP: SUPABASE_URL или SUPABASE_ANON_KEY не заданы — RAG отключён для ВСЕХ режимов анализа! Задайте в Render → Environment.');
} else {
    console.log(`[Supabase] ✅ STARTUP: подключено → ${SUPABASE_URL.slice(0, 50)}...`);
}

async function searchSupabase(vector, queryText = '', topK = 10) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        return [];
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

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
                    match_count:     topK
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
            console.warn(`[Supabase] 0 результатов | query="${String(queryText||'').slice(0,80)}" topK=${topK}`);
            return [];
        }

        // Парсим npa_title и article_title из поля content.
        // Supabase возвращает category="npa"|"instructions" и original_id=внутренний_ID —
        // реальные название закона и статьи встроены в начало content.
        const MIN_CONTENT_LEN = 150; // фильтруем "инструкции" с почти пустым содержимым
        const results = [];
        for (const row of rows) {
            const content = String(row.content || '');
            if (content.length < MIN_CONTENT_LEN) continue; // пропускаем мусорные записи

            // "Документ: ГРАЖДАНСКИЙ КОДЕКС КЫРГЫЗСКОЙ РЕСПУБЛИКИ (от ...)\n..."
            const docLineMatch = content.match(/^Документ:\s*([^\n]+)/);
            const npaTitle = docLineMatch ? docLineMatch[1].trim() : (row.category || '');

            // "Статья 222. Бремя содержания..." или "Ст. 222"
            const artMatch = content.match(/(?:Статья|Ст\.)\s+(\d+[\w.-]*)[.\s]/);
            const articleTitle = artMatch ? `Статья ${artMatch[1]}` : '';

            results.push({
                id:    String(row.id || ''),
                score: typeof row.similarity === 'number' ? row.similarity : (row.score ?? 0),
                metadata: {
                    npa_title:     npaTitle,
                    article_title: articleTitle,
                    full_text:     content
                }
            });
        }

        console.log(`[Supabase] ${rows.length} строк → ${results.length} полезных | query="${String(queryText||'').slice(0,50)}" | top1: "${results[0]?.metadata?.npa_title?.slice(0,40)}" ${results[0]?.metadata?.article_title}`);
        return results;
    } catch (err) {
        if (err.name === 'AbortError') {
            console.warn('[Supabase] searchSupabase timeout (6s)');
            return [];
        }
        console.error('[Supabase] searchSupabase error:', err.message);
        return [];
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = { searchSupabase };
