'use strict';
// Supabase hybrid search: cosine vector similarity + GIN full-text search
// RPC signature expected: hybrid_search_documents(query_embedding, query_text, match_count)
// Return columns: id, category, content, original_id, similarity
//
// Mapping to Pinecone-compatible format used throughout the codebase:
//   category    → metadata.npa_title    (название НПА/кодекса)
//   original_id → metadata.article_title (номер и заголовок статьи)
//   content     → metadata.full_text    (полный текст статьи)
//   similarity  → score                 (float [0,1])

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

        // Диагностика: видно в Render logs — сколько строк вернул Supabase и что за контент
        if (!Array.isArray(rows) || rows.length === 0) {
            console.warn(`[Supabase] searchSupabase → 0 результатов | query="${String(queryText||'').slice(0,80)}" topK=${topK}`);
        } else {
            console.log(`[Supabase] searchSupabase → ${rows.length} результатов | query="${String(queryText||'').slice(0,60)}" | top1: category="${rows[0]?.category}" original_id="${rows[0]?.original_id}" sim=${rows[0]?.similarity}`);
        }

        return (rows || []).map(row => ({
            id:    String(row.id || ''),
            score: typeof row.similarity === 'number' ? row.similarity : (row.score ?? 0),
            metadata: {
                npa_title:     row.category    || '',
                article_title: row.original_id || '',
                full_text:     row.content     || ''
            }
        }));
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
