// ============================================================
// services/documentIndexer.js — OCR + full-text indexing
// BOARDLINK | Module 2.4 (OCR) + Module 2.5 (AI Search)
// ============================================================
//
// One place that takes an archived document, reads its text, and
// makes that text searchable. Used by two callers:
//
//   * the upload flow, so a newly archived resolution becomes
//     searchable by its contents shortly after it is saved; and
//   * scripts/backfill-ocr.js, which does the same for documents
//     that were uploaded before this existed.
//
// Before this module the upload page told the Board Secretary a
// document was "queued for OCR processing", but nothing ever
// processed it — document_ocr_text was never written to, so
// searching the body of a resolution could never return anything.

const path = require('path');
const fs   = require('fs');

const tesseractService   = require('./tesseractService');
const meilisearchService = require('./meilisearchService');
const Document           = require('../models/Document');

const UPLOAD_DIR = require('../config/paths').UPLOAD_DIR;

/** Resolve a stored file_path to something on disk. */
function resolveFile(filePath) {
    if (!filePath) return null;
    const candidates = [
        filePath,
        path.join(UPLOAD_DIR, filePath),
        path.join(UPLOAD_DIR, path.basename(filePath)),
    ];
    return candidates.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } }) || null;
}

/**
 * OCR a single document and store the result.
 *
 * Reads EVERY page (maxPages: 0), unlike the upload form's autofill
 * which only reads page one. Autofill needs the resolution number
 * and title, both on the first page; search needs the whole body,
 * otherwise a phrase on page four would be unfindable.
 *
 * @returns {Promise<{ok:boolean, documentId:number, chars?:number,
 *                     confidence?:number, pages?:number, reason?:string}>}
 */
async function indexDocument(doc) {
    const documentId = doc.document_id || doc.id;
    const file = resolveFile(doc.file_path);

    if (!file) {
        return { ok: false, documentId, reason: 'file not found on disk' };
    }

    let ocr;
    try {
        ocr = await tesseractService.extractText(file, 'eng', { maxPages: 0 });
    } catch (err) {
        return { ok: false, documentId, reason: 'OCR failed: ' + err.message };
    }

    const text = (ocr.text || '').trim();
    if (!text) {
        return { ok: false, documentId, reason: 'no text recognised' };
    }

    // 1) MySQL — powers the database search path and the snippets.
    await Document.saveOcrText(
        documentId, text,
        typeof ocr.confidence === 'number' ? Number(ocr.confidence.toFixed(2)) : null
    );

    // 2) Meilisearch — powers ranked relevance search. Optional: if
    //    the engine is down the document is still searchable through
    //    MySQL, so this must not fail the whole operation.
    try {
        await meilisearchService.indexDocument({
            id:       documentId,
            title:    doc.title,
            type:     doc.doc_type,
            year:     doc.doc_year,
            category: doc.category,
            ocrText:  text,
        });
    } catch (err) {
        console.warn(`[indexer] document ${documentId} saved to MySQL but not to Meilisearch:`,
                     err.message);
    }

    return {
        ok: true, documentId,
        chars: text.length,
        confidence: ocr.confidence,
        pages: ocr.pagesRead,
    };
}

/**
 * Fire-and-forget indexing for the upload flow.
 *
 * OCR of a long scanned resolution takes tens of seconds. Making the
 * Board Secretary wait for it before the upload form returns would
 * be a poor trade, so the work is started and the response is sent
 * immediately; the document becomes searchable a short time later.
 */
function indexInBackground(doc) {
    setImmediate(async () => {
        const id = doc.document_id || doc.id;
        try {
            const result = await indexDocument(doc);
            if (result.ok) {
                console.log(`[indexer] document ${id} indexed — ${result.chars} chars from ${result.pages} page(s)`);
            } else {
                console.warn(`[indexer] document ${id} not indexed — ${result.reason}`);
            }
        } catch (err) {
            console.error(`[indexer] document ${id} failed:`, err.message);
        }
    });
}

module.exports = { indexDocument, indexInBackground, resolveFile };
