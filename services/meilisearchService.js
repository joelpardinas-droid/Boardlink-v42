// ============================================================
// services/meilisearchService.js — Meilisearch Document Search
// BOARDLINK | Chapter 3 Sec. 3.6 — Module 4: AI-powered Document Search
// ============================================================
//
// Thin wrapper around the Meilisearch client that handles index
// creation, document upsert after OCR completion, and ranked
// search queries used by Module 4.
//
// Meilisearch is a self-hosted, open-source search engine — it
// was already local in the original design and required no
// change during the local-AI migration. All search queries are
// answered on the CSPC server, and no document content is ever
// transmitted to an external service.

const { documentsIndex } = require('../config/meilisearch');

async function indexDocument({ id, title, type, year, category, ocrText }) {
    await documentsIndex.addDocuments([
        {
            id,
            title,
            type,
            year,
            category,
            snippet: (ocrText || '').slice(0, 300),
            fullText: ocrText || '',
        },
    ]);
}

/**
 * Search the archive.
 *
 * `matchingStrategy: 'all'` is the important setting. Meilisearch
 * defaults to 'last', which progressively DROPS query words until
 * it finds something — so a specific three-word search would
 * quietly fall back to matching just one word and return a long
 * list of loosely related resolutions. With 'all', every word must
 * be present, so adding words narrows the search towards the one
 * resolution the user is after.
 */
async function search(query, limit = 20) {
    if (!query) return [];
    const result = await documentsIndex.search(query, {
        limit,
        matchingStrategy: 'all',
        attributesToHighlight: ['fullText', 'title'],
        attributesToCrop:      ['fullText'],   // the field is fullText (v85 fix: was 'content')
        cropLength:            40,
        highlightPreTag:  '',
        highlightPostTag: '',
    });
    return result.hits;
}

module.exports = { indexDocument, search };
