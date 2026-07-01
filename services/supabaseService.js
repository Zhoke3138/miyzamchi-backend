'use strict';
// Supabase hybrid search: cosine vector similarity + GIN full-text search
// RPC: hybrid_search_documents(query_embedding, query_text, match_count)
//
// Схема метаданных Sniper RAG 3.0 (JSONB колонка metadata):
//   npa_title, abbrev, domain, npa_type, npa_hierarchy_level (1=Конституция…10=иное),
//   hierarchy_path, article_title, parent_context, element_type, part_total
//   content column = full_text нормы
//
// ⚠️  ВАЖНО ДЛЯ SUPABASE: RPC hybrid_search_documents должна возвращать колонку metadata.
//   SQL для обновления RPC (запустить в Supabase SQL Editor):
//
//   CREATE OR REPLACE FUNCTION hybrid_search_documents(
//       query_embedding vector(1536), query_text text, match_count int
//   ) RETURNS TABLE (id text, category text, content text, similarity float, metadata jsonb)
//   LANGUAGE sql STABLE AS $$
//     SELECT id, category, content,
//            1 - (embedding <=> query_embedding) AS similarity,
//            metadata
//     FROM documents
//     ORDER BY embedding <=> query_embedding
//     LIMIT match_count;
//   $$;

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('[Supabase] ⚠️ STARTUP: SUPABASE_URL или SUPABASE_ANON_KEY не заданы — RAG отключён! Задайте в Render → Environment.');
} else {
    console.log(`[Supabase] ✅ STARTUP: подключено → ${SUPABASE_URL.slice(0, 50)}...`);
}

// --- Fallback-парсеры для старых записей без metadata JSONB ---

function _legacyNpaTitle(content) {
    const m = content.match(/^Документ:\s*([^\n]+)/);
    return m ? m[1].trim() : '';
}

function _legacyArticleTitle(content, id) {
    // Из id формата "kg_art-17_..." → "Статья 17"
    const idMatch = String(id || '').match(/art-(\d+)/i);
    if (idMatch) return `Статья ${idMatch[1]}`;
    // Из контента
    const m = content.match(/(?:Статья|Ст\.)\s+(\d+[\w.-]*)[.\s]([^\n]*)/);
    return m ? `Статья ${m[1]}${m[2] ? '. ' + m[2].trim() : ''}` : '';
}

// --- Lex Superior (принцип иерархии права) ---
// При разнице score < LEX_SCORE_BAND нормы считаются "близкими" и
// упорядочиваются по юридической силе: меньший npa_hierarchy_level = выше.
// 1=Конституция, 3=Кодекс, 4=Закон, 9=Правила, 10=иное
const LEX_SCORE_BAND = 0.05;

function applyLexSuperior(results) {
    results.sort((a, b) => {
        const diff = b.score - a.score;
        if (Math.abs(diff) > LEX_SCORE_BAND) return diff;
        const la = a.metadata.npa_hierarchy_level ?? 10;
        const lb = b.metadata.npa_hierarchy_level ?? 10;
        return la !== lb ? la - lb : diff;
    });
}

/**
 * Поиск в Supabase.
 * @param {number[]} vector        — эмбеддинг запроса (1536d)
 * @param {string}   queryText     — текст для GIN full-text search
 * @param {number}   topK          — сколько результатов вернуть
 * @param {string[]} categories    — фильтр по category. По умолчанию ['npa'].
 *                                   Передай [] или null чтобы не фильтровать.
 */
async function searchSupabase(vector, queryText = '', topK = 10, categories = ['npa']) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return [];

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
            if (categories && categories.length > 0 && !categories.includes(row.category)) continue;

            const content = String(row.content || '');
            if (content.length < 30) continue;

            // Новая схема: читаем из metadata JSONB напрямую
            const md = (row.metadata && typeof row.metadata === 'object') ? row.metadata : {};

            // Fallback для старых записей без metadata JSONB
            const npa_title     = md.npa_title     || _legacyNpaTitle(content);
            const article_title = md.article_title  || _legacyArticleTitle(content, row.id);

            // parent_context: полная цепочка иерархии до чанка.
            // Пример: "РАЗДЕЛ III > Глава 13\nСтатья 117. Налоги > Часть 2"
            // Fallback для старых записей: article_title
            const parent_context = md.parent_context || article_title;

            results.push({
                id:       String(row.id || ''),
                category: row.category || '',       // 'npa' / 'instructions' / 'court_acts'
                score:    typeof row.similarity === 'number' ? row.similarity : (row.score ?? 0),
                metadata: {
                    // Идентичность НПА
                    npa_title,
                    abbrev:              md.abbrev              || '',
                    domain:              md.domain              || 'other',   // tax/civil/labor/criminal/admin/other
                    npa_type:            md.npa_type            || '',        // кодекс/закон/указ_президента/…
                    npa_hierarchy_level: md.npa_hierarchy_level ?? 10,        // 1=Конституция…10=иное

                    // Структура нормы
                    hierarchy_path:  md.hierarchy_path  || '',
                    article_title,
                    parent_context,                                            // полный контекст для LLM
                    element_type:    md.element_type    || '',                // статья_целиком/часть/пункт/подпункт
                    part_total:      md.part_total      ?? null,

                    // Контент (из колонки content, а не metadata)
                    full_text: content
                }
            });

            if (results.length >= topK) break;
        }

        // Lex Superior: при близких score нормы высшей юридической силы поднимаются выше
        applyLexSuperior(results);

        const catLabel = categories && categories.length ? categories.join('+') : 'all';
        console.log(`[Supabase] fetched=${rows.length} cat=${catLabel} → kept=${results.length} | query="${String(queryText||'').slice(0,80)}" | top1: "${results[0]?.metadata?.npa_title?.slice(0,35)}" ${results[0]?.metadata?.article_title?.slice(0,20)}`);
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
