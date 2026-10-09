// ============================================================
// services/itemPdfService.js — agenda item PDFs
// ============================================================
//
// Each agenda item can carry a PDF that members read and comment on
// inside BOARDLINK. After upload this service:
//
//   1. counts the pages and checks which pages already contain text
//      (PDFs exported from Word do; scans do not);
//   2. marks the item ready, so members can open it straight away —
//      text pages are selectable at once, and any page can take an
//      "area" comment;
//   3. reads the scanned pages with OCR, one at a time, in the
//      background, and stores each word's position so those pages
//      become selectable too.
//
// Work is queued and done one item at a time: OCR takes a few
// seconds per page, and running several documents at once would
// slow the whole server for everyone.

const fs   = require('fs');
const path = require('path');
const Meeting = require('../models/Meeting');
const tesseract = require('./tesseractService');

const UPLOAD_DIR = require('../config/paths').UPLOAD_DIR;
const SAMPLE_DIR = path.join(__dirname, '..', 'samples');

// A page with fewer visible characters than this is treated as a scan.
const MIN_TEXT_CHARS = Number(process.env.ITEM_PDF_MIN_TEXT_CHARS || 20);
// Upper bound on OCR work for one document, to keep one very long
// scan from occupying the server for many minutes.
const MAX_OCR_PAGES = Number(process.env.ITEM_OCR_MAX_PAGES || 60);
// Largest PDF or Word file (videos have their own, larger limit).
const MAX_DOC_MB = Number(process.env.MAX_UPLOAD_MB || 100);

// Demo-mode items point at bundled sample files by this prefix.
const SAMPLE_FILES = {
    '__sample:budget':  'sample-budget-proposal.pdf',
    '__sample:minutes': 'sample-previous-minutes.pdf',
};

/** Stored names are multer's 32-hex random names; nothing else is served. */
function resolveItemFile(stored) {
    if (!stored) return null;
    if (SAMPLE_FILES[stored]) return path.join(SAMPLE_DIR, SAMPLE_FILES[stored]);
    if (!/^[a-f0-9]{32}$/.test(stored)) return null;
    const full = path.join(UPLOAD_DIR, stored);
    return fs.existsSync(full) ? full : null;
}

/**
 * Takes one uploaded agenda item file, PDF or Word (.docx).
 *   PDF  → kept as it is.
 *   Word → kept, AND turned into a PDF (with LibreOffice) for members to
 *          read and comment on. The Word file is what "Edit the words"
 *          changes later, so the words can be corrected without rebuilding
 *          the layout from a PDF (which is never exact).
 * Returns { ok: true, stored, name, docx } — stored is the PDF's stored
 * name, docx the Word file's stored name or null — or
 * { ok: false, reason: 'type' | 'convert', message }.
 */
async function acceptUpload(file) {
    const crypto = require('crypto');
    const wordEdit = require('./wordEditService');
    const original = cleanFileName(file.originalname);
    // Papers keep the document size limit; only videos may be larger.
    const docTooBig = () => file.size && file.size > MAX_DOC_MB * 1024 * 1024;
    if (isPdf(file.path)) {
        if (docTooBig()) return { ok: false, reason: 'size', message: `"${original}" is larger than the ${MAX_DOC_MB} MB limit for documents.` };
        return { ok: true, stored: file.filename, name: original, docx: null, file };
    }
    if (!wordEdit.isDocx(file.path)) {
        // Not a paper: it may be a video, such as the President's Report.
        const v = require('./itemVideoService').prepare(file);
        if (v.ok || v.reason !== 'type') return v;
        return { ok: false, reason: 'type', message: 'Only PDF, Word (.docx) or video files can be attached.' };
    }
    if (docTooBig()) return { ok: false, reason: 'size', message: `"${original}" is larger than the ${MAX_DOC_MB} MB limit for documents.` };
    // LibreOffice goes by the file's extension, and multer stores uploads
    // without one, so a named copy is converted.
    const dir = wordEdit.tempDir();
    try {
        const named = path.join(dir, 'document.docx');
        fs.copyFileSync(file.path, named);
        const made = await wordEdit.wordToPdf(named);
        if (!made.ok) {
            return { ok: false, reason: 'convert',
                message: `The Word file "${original}" could not be turned into a PDF. ${made.message}` };
        }
        const stored = crypto.randomBytes(16).toString('hex');
        fs.copyFileSync(made.path, path.join(UPLOAD_DIR, stored));
        wordEdit.removeDir(made.dir);
        const name = original.replace(/\.docx$/i, '') + '.pdf';
        return { ok: true, stored, name, docx: file.filename, file };
    } finally {
        wordEdit.removeDir(dir);
    }
}

/** Removes the files acceptUpload() kept, when they end up unused. */
function discardUpload(u) {
    if (!u) return;
    if (u.video) return require('./itemVideoService').discard(u);
    if (u.stored) removeStored(u.stored);
    if (u.docx) removeStored(u.docx);
}

/** True when the file starts with the PDF signature. */
function isPdf(filePath) {
    return tesseract.isPdfFile(filePath);
}

/** Keeps a readable, safe version of the uploader's file name. */
function cleanFileName(name) {
    const base = path.basename(String(name || 'document.pdf'))
        .replace(/[\u0000-\u001f\u007f"<>\\|?*]/g, '')
        .trim();
    return (base || 'document.pdf').slice(0, 200);
}

let _pdfjs = null;
async function pdfjs() {
    if (!_pdfjs) _pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    return _pdfjs;
}

/** Page count and, for each page, whether it already holds text. */
async function scanPages(filePath) {
    const lib = await pdfjs();
    const task = lib.getDocument({
        data: new Uint8Array(fs.readFileSync(filePath)),
        isEvalSupported: false,
        verbosity: 0,
    });
    const doc = await task.promise;
    try {
        const pages = [];
        for (let n = 1; n <= doc.numPages; n++) {
            const page = await doc.getPage(n);
            const tc = await page.getTextContent();
            const chars = tc.items.reduce((sum, it) => sum + String(it.str || '').replace(/\s+/g, '').length, 0);
            pages.push({ page: n, hasText: chars >= MIN_TEXT_CHARS });
            page.cleanup();
        }
        return pages;
    } finally {
        await task.destroy();
    }
}

/**
 * `carryOver` is Map(pageNo → { hasText, ocrStatus, words }) for pages
 * taken from the item's previous document (see pdfEditService): their
 * text is already known, so those pages are not read again.
 */
async function processItem(itemId, stored, carryOver = null) {
    const file = resolveItemFile(stored);
    if (!file) {
        await Meeting.setItemPdfResult(itemId, null, 'failed');
        return { ok: false, reason: 'file missing' };
    }

    let pages;
    try {
        pages = await scanPages(file);
    } catch (err) {
        console.error(`[item pdf] item ${itemId}: could not read the PDF —`, err.message);
        await Meeting.setItemPdfResult(itemId, null, 'failed');
        return { ok: false, reason: err.message };
    }

    const known = carryOver || new Map();
    const scanned = pages.filter(p => !p.hasText && !(known.get(p.page) || {}).words).map(p => p.page);
    for (const p of pages) {
        const kept = known.get(p.page);
        if (kept && (p.hasText ? kept.hasText : kept.ocrStatus === 'done')) {
            // Same page as before: its text is reused.
            await Meeting.savePage(itemId, p.page, {
                hasText: p.hasText,
                ocrStatus: p.hasText ? 'not_needed' : 'done',
                words: kept.words || null,
            });
            continue;
        }
        const pending = !p.hasText && scanned.indexOf(p.page) < MAX_OCR_PAGES;
        await Meeting.savePage(itemId, p.page, {
            hasText: p.hasText,
            ocrStatus: p.hasText ? 'not_needed' : (pending ? 'pending' : 'failed'),
            words: null,
        });
    }
    // Ready now: members can open and comment while OCR continues.
    await Meeting.setItemPdfResult(itemId, pages.length, 'ready');
    console.log(`[item pdf] item ${itemId}: ${pages.length} page(s), ${scanned.length} scanned`);

    const stillPending = [];
    for (const n of scanned.slice(0, MAX_OCR_PAGES)) {
        const row = await Meeting.getPage(itemId, n);
        if (row && row.ocr_status === 'pending') stillPending.push(n);
    }
    await ocrPendingPages(itemId, file, stillPending);
    // The document can now be read in full: write its summary now, so it
    // is ready before members open it. (Required here, not at the top,
    // because briefingService itself uses this file.)
    require('./briefingService').autoSummarize(itemId);
    return { ok: true, pages: pages.length, scanned: stillPending.length };
}

async function ocrPendingPages(itemId, file, pageNos) {
    for (const n of pageNos) {
        try {
            const t0 = Date.now();
            const { words, confidence } = await tesseract.ocrPdfPageWords(file, n);
            // Stop if the item's file was replaced while we worked.
            const now = await Meeting.getPage(itemId, n);
            if (!now || now.ocr_status !== 'pending') return;
            await Meeting.setPageOcr(itemId, n, 'done', words);
            console.log(`[item pdf] item ${itemId} page ${n}: ${words.length} words, ` +
                        `${Math.round(confidence)}% confidence, ${Date.now() - t0} ms`);
        } catch (err) {
            console.warn(`[item pdf] item ${itemId} page ${n}: OCR failed —`, err.message);
            try { await Meeting.setPageOcr(itemId, n, 'failed', null); } catch (_) {}
        }
    }
}

// ── Background queue ─────────────────────────────────────────
let _chain = Promise.resolve();
const _queued = new Set();

/** Queue an item for processing; returns immediately. */
function processInBackground(itemId, stored, carryOver = null) {
    const key = `${itemId}:${stored}`;
    if (_queued.has(key)) return _chain;
    _queued.add(key);
    _chain = _chain
        .then(() => processItem(itemId, stored, carryOver))
        .catch(err => console.error(`[item pdf] item ${itemId} failed:`, err.message))
        .finally(() => _queued.delete(key));
    return _chain;
}

/** Waits for everything queued so far (used by tests and scripts). */
function drain() { return _chain; }

/**
 * Picks up items left unfinished by a restart. Called once at start;
 * does nothing when the database is not reachable.
 */
async function resumePending() {
    try {
        const rows = await Meeting.findItemsNeedingProcessing();
        for (const r of rows) processInBackground(r.item_id, r.item_pdf);
        if (rows.length) console.log(`[item pdf] resuming ${rows.length} unfinished item(s)`);
    } catch (_) { /* no database yet */ }
}

/** Removes an uploaded file that is no longer referenced. */
function removeStored(stored) {
    const file = resolveItemFile(stored);
    if (file && file.startsWith(UPLOAD_DIR)) {
        fs.unlink(file, () => {});
    }
}

module.exports = {
    acceptUpload, discardUpload,
    resolveItemFile, isPdf, cleanFileName, scanPages,
    processItem, processInBackground, drain, resumePending, removeStored,
    SAMPLE_FILES,
};
