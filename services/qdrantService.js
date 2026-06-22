'use strict';

// ════════════════════════════════════════════════════════════════════
// Qdrant FAQ Retriever — tunduk_guides_collection
// Принимает pre-computed embedding (768d, тот же getEmbedding из server.js),
// возвращает результаты в Pinecone-совместимом формате: { score, metadata }
// ════════════════════════════════════════════════════════════════════

const COLLECTION = 'tunduk_guides_collection';

/**
 * Поиск в Qdrant. Возвращает массив в формате, совместимом с Pinecone matches:
 * [{ score, metadata: { full_text, npa_title, article_title }, _source: 'qdrant' }]
 *
 * @param {number[]} vector   - Embedding 768d (от getEmbedding)
 * @param {object}   opts
 * @param {string}   opts.url    - QDRANT_URL из env
 * @param {string}   opts.apiKey - QDRANT_API_KEY из env
 * @param {number}   [opts.topK=10]
 * @param {number}   [opts.scoreThreshold=0.45]
 */
async function searchQdrant(vector, { url, apiKey, topK = 10, scoreThreshold = 0.45 } = {}) {
    if (!url || !apiKey) {
        console.warn('[Qdrant] QDRANT_URL / QDRANT_API_KEY не заданы — пропускаем');
        return [];
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
        const cleanUrl = url.replace(/^["'\s]|["'\s]$/g, '').replace(/\/$/, '');
        const cleanKey = apiKey.replace(/^["'\s]|["'\s]$/g, '');
        const response = await fetch(
            `${cleanUrl}/collections/${COLLECTION}/points/search`,
            {
                method: 'POST',
                headers: {
                    'api-key': cleanKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    vector,
                    top: topK,
                    with_payload: true,
                    score_threshold: scoreThreshold
                }),
                signal: controller.signal
            }
        );

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            console.error(`[Qdrant] HTTP ${response.status}: ${text.slice(0, 200)}`);
            return [];
        }

        const data = await response.json();
        const results = data.result || [];

        return results.map(r => {
            const p = r.payload || {};
            // Поддерживаем разные схемы payload FAQ-документов
            const fullText =
                p.text || p.content || p.full_text || p.answer || p.body || '';
            const title =
                p.title || p.article_title || p.question || p.name || '';
            const source =
                p.source || p.npa_title || p.document || p.category || 'Справочник Tunduk/ЦОН';

            return {
                score: r.score,
                metadata: {
                    full_text: fullText,
                    npa_title: source,
                    article_title: title,
                    _raw: p          // сохраняем оригинал для отладки
                },
                _source: 'qdrant'
            };
        });

    } catch (error) {
        if (error.name === 'AbortError') {
            console.warn('[Qdrant] Timeout (5s)');
            return [];
        }
        console.error('[Qdrant] Ошибка:', error.message);
        return [];
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = { searchQdrant };
