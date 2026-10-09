// ============================================================
// services/itemTextService.js — the full text of an item's PDF
// ============================================================
//
// Used by the pre-meeting briefing, which must summarise what each
// agenda item's document actually says.
//
//   • Pages that contain text (PDFs saved from Word) are read with
//     PDF.js and their words re-assembled into lines, top to bottom.
//   • Scanned pages use the words BOARDLINK already read with OCR
//     when the file was uploaded (agenda_item_pages.words).
//
// Every page is included, in order, each marked "[Page N]" so the
// summary can be traced back to the document.

const fs = require('fs');
const Meeting = require('../models/Meeting');
const itemPdf = require('./itemPdfService');

let _pdfjs = null;
async function pdfjs() {
    if (!_pdfjs) _pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    return _pdfjs;
}

const clean = s => String(s || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();

/** Rebuilds reading-order lines from PDF.js text items. */
function linesFromTextContent(items) {
    const rows = [];
    for (const it of items) {
        const str = String(it.str || '');
        if (!str.trim()) continue;
        const x = it.transform[4];
        const y = it.transform[5];
        const h = Math.abs(it.height || it.transform[3] || 10);
        let row = rows.find(r => Math.abs(r.y - y) <= Math.max(2, h * 0.4));
        if (!row) { row = { y, h, parts: [] }; rows.push(row); }
        row.parts.push({ x, w: it.width || 0, str });
    }
    rows.sort((a, b) => b.y - a.y);       // PDF y grows upwards
    return rows.map(r => {
        r.parts.sort((a, b) => a.x - b.x);
        let line = '';
        let end = null;
        for (const p of r.parts) {
            if (end !== null && p.x - end > r.h * 0.15 && !line.endsWith(' ') && !p.str.startsWith(' ')) line += ' ';
            line += p.str;
            end = p.x + p.w;
        }
        return clean(line);
    }).filter(Boolean);
}

/** Lines from stored OCR words: [x, y, w, h, text, line]. */
function linesFromOcrWords(words) {
    const byLine = new Map();
    for (const w of words || []) {
        const key = w[5] >= 0 ? `L${w[5]}` : `Y${Math.round(w[1] * 200)}`;
        if (!byLine.has(key)) byLine.set(key, { y: w[1], x: w[0], words: [] });
        const line = byLine.get(key);
        line.y = Math.min(line.y, w[1]);
        line.words.push(w);
    }
    return [...byLine.values()]
        .sort((a, b) => a.y - b.y)
        .map(l => clean(l.words.sort((a, b) => a[0] - b[0]).map(w => w[4]).join(' ')))
        .filter(Boolean);
}

/**
 * Returns { pages: [{ page, text, source }], chars, pageCount,
 *           unreadablePages: [n...], pendingPages: [n...] }
 * `source` is 'text' or 'ocr'.
 */
async function getItemText(item, { mock = false } = {}) {
    if (item.item_video) return videoText(item);
    const file = itemPdf.resolveItemFile(item.item_pdf);
    if (!file) return { pages: [], chars: 0, pageCount: 0, unreadablePages: [], pendingPages: [], missing: true };

    const lib = await pdfjs();
    const task = lib.getDocument({
        data: new Uint8Array(fs.readFileSync(file)),
        isEvalSupported: false,
        verbosity: 0,
    });
    const doc = await task.promise;
    const pages = [];
    const unreadablePages = [];
    const pendingPages = [];
    try {
        for (let n = 1; n <= doc.numPages; n++) {
            const page = await doc.getPage(n);
            const tc = await page.getTextContent();
            page.cleanup();
            let lines = linesFromTextContent(tc.items);
            let source = 'text';
            const visible = lines.join('').replace(/\s+/g, '').length;
            if (visible < 20 && !mock) {
                // A scan: use the OCR words saved at upload.
                const row = await Meeting.getPage(item.item_id, n).catch(() => null);
                if (row && row.ocr_status === 'done' && row.words && row.words.length) {
                    lines = linesFromOcrWords(row.words);
                    source = 'ocr';
                } else if (row && row.ocr_status === 'pending') {
                    pendingPages.push(n);
                } else if (!visible) {
                    unreadablePages.push(n);
                }
            }
            if (lines.length) pages.push({ page: n, text: lines.join('\n'), source });
        }
        const chars = pages.reduce((sum, p) => sum + p.text.length, 0);
        return { pages, chars, pageCount: doc.numPages, unreadablePages, pendingPages };
    } finally {
        await task.destroy();
    }
}

/**
 * A video item's words, in parts of about two minutes, each marked with
 * the time it starts ("page" n is the n-th part).
 */
function videoText(item) {
    const pendingPages = item.item_video_status === 'processing' ? [1] : [];
    let segs = [];
    try { segs = item.item_video_segments ? JSON.parse(item.item_video_segments) : []; } catch (_) { segs = []; }
    const pages = [];
    let cur = null;
    const clock = t => { t = Math.floor(t || 0); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
    for (const sgm of segs) {
        if (!cur || sgm.start - cur.from >= 120) {
            cur = { page: pages.length + 1, from: sgm.start, lines: [] };
            pages.push(cur);
        }
        cur.lines.push(`(${clock(sgm.start)}) ${clean(sgm.text)}`);
    }
    const out = pages.map(p => ({ page: p.page, text: p.lines.join('\n'), source: 'video' }));
    if (!out.length && item.item_video_text) out.push({ page: 1, text: clean(item.item_video_text), source: 'video' });
    const chars = out.reduce((sum, p) => sum + p.text.length, 0);
    return { pages: out, chars, pageCount: out.length || 1, unreadablePages: [], pendingPages };
}

module.exports = { getItemText, linesFromTextContent, linesFromOcrWords };
