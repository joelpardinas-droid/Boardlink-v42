// ============================================================
// services/pdfEditService.js — the Board Secretary's page editor
// ============================================================
//
// The Secretary can reorder, rotate and delete the pages of an agenda
// item's PDF, and add pages from another PDF. The words inside a page
// are not changed: a PDF is a fixed record, and a page a Trustee
// commented on must still read the same.
//
// Everything that points into the document is carried across:
//
//   • comments keep their page and their highlight — a rotated page
//     turns its boxes with it, and a moved page takes them along;
//   • a comment whose page was deleted is kept, marked, and shown
//     against the item instead of being lost;
//   • the text of unchanged pages (including OCR of scanned pages) is
//     reused, so an edited document does not have to be read again.
//
// The previous file stays on disk as an earlier version.

const { PDFDocument, degrees } = require('pdf-lib');

const TURNS = [0, 90, 180, 270];

/**
 * Turns a box [x, y, w, h] (fractions of the page) with its page.
 * Clockwise, matching how the page itself is rotated.
 */
function rotateRect([x, y, w, h], turn) {
    switch (((turn % 360) + 360) % 360) {
        case 90:  return [1 - (y + h), x, h, w];
        case 180: return [1 - (x + w), 1 - (y + h), w, h];
        case 270: return [y, 1 - (x + w), h, w];
        default:  return [x, y, w, h];
    }
}

const r4 = v => Math.round(v * 10000) / 10000;
const rotateRects = (rects, turn) => (rects || []).map(r => rotateRect(r, turn).map(r4));

/** OCR words are [x, y, w, h, text, line]; only the box turns. */
function rotateWords(words, turn) {
    if (!words || !turn) return words;
    return words.map(w => {
        const [x, y, ww, hh] = rotateRect([w[0], w[1], w[2], w[3]], turn).map(r4);
        return [x, y, ww, hh, w[4], w[5]];
    });
}

/**
 * Checks the page plan sent by the browser.
 * Each entry: { src: 'current' | 'u0', page: <1-based>, rotate: 0|90|180|270 }
 * Returns { plan } or { error }.
 */
function cleanPlan(raw, { currentPages, uploadPages }) {
    let list = raw;
    if (typeof list === 'string') {
        try { list = JSON.parse(list); } catch (_) { return { error: 'The page list could not be read.' }; }
    }
    if (!Array.isArray(list) || !list.length) {
        return { error: 'A document must keep at least one page.' };
    }
    if (list.length > 500) return { error: 'That is more pages than BOARDLINK can put in one document.' };

    const plan = [];
    for (const entry of list) {
        if (!entry || typeof entry !== 'object') return { error: 'The page list could not be read.' };
        const src = String(entry.src || '');
        const page = parseInt(entry.page, 10);
        const rotate = TURNS.includes(Number(entry.rotate)) ? Number(entry.rotate) : 0;
        const total = src === 'current' ? currentPages : uploadPages[src];
        if (total === undefined) return { error: 'The page list refers to a file that was not sent.' };
        if (!Number.isFinite(page) || page < 1 || page > total) {
            return { error: 'The page list refers to a page that does not exist.' };
        }
        plan.push({ src, page, rotate });
    }
    return { plan };
}

/**
 * Builds the edited PDF.
 *   currentBytes — the item's file now
 *   uploads      — { u0: Buffer, ... } for pages added from other PDFs
 * Returns { bytes, plan, pageCount, fromCurrent } where fromCurrent
 * maps an old page number to its new one (first appearance wins).
 */
async function buildEdited(currentBytes, uploads, plan) {
    const out = await PDFDocument.create();
    const sources = { current: await PDFDocument.load(currentBytes, { ignoreEncryption: true }) };
    for (const [key, bytes] of Object.entries(uploads || {})) {
        sources[key] = await PDFDocument.load(bytes, { ignoreEncryption: true });
    }

    // Copy in one go per source, as pdf-lib prefers.
    const wanted = new Map();          // src → [pageIndex...]
    for (const step of plan) {
        if (!wanted.has(step.src)) wanted.set(step.src, []);
        wanted.get(step.src).push(step.page - 1);
    }
    const copied = new Map();          // src → [PDFPage...]
    for (const [src, indices] of wanted) {
        copied.set(src, await out.copyPages(sources[src], indices));
    }
    const taken = new Map([...wanted.keys()].map(src => [src, 0]));

    const fromCurrent = new Map();
    plan.forEach((step, i) => {
        const at = taken.get(step.src);
        taken.set(step.src, at + 1);
        const page = copied.get(step.src)[at];
        out.addPage(page);
        if (step.rotate) {
            page.setRotation(degrees((page.getRotation().angle + step.rotate) % 360));
        }
        if (step.src === 'current' && !fromCurrent.has(step.page)) {
            fromCurrent.set(step.page, { newPage: i + 1, rotate: step.rotate });
        }
    });

    const bytes = Buffer.from(await out.save());
    return { bytes, plan, pageCount: plan.length, fromCurrent };
}

/**
 * Where each comment goes after the edit.
 * Returns [{ commentId, page, rects, lost }] for comments that change.
 */
function remapComments(comments, fromCurrent) {
    const out = [];
    for (const c of comments) {
        if (!c.page_number) continue;                       // not tied to a page
        const moved = fromCurrent.get(c.page_number);
        if (!moved) {
            if (!c.anchor_lost) out.push({ commentId: c.comment_id, lost: true });
            continue;
        }
        let rects = null;
        if (c.anchor_rects) {
            try {
                const parsed = typeof c.anchor_rects === 'string' ? JSON.parse(c.anchor_rects) : c.anchor_rects;
                rects = rotateRects(parsed, moved.rotate);
            } catch (_) { rects = null; }
        }
        const samePage = moved.newPage === c.page_number;
        if (samePage && !moved.rotate && !c.anchor_lost) continue;       // nothing to change
        out.push({ commentId: c.comment_id, page: moved.newPage, rects, lost: false });
    }
    return out;
}

/**
 * The page rows to keep for the new file: text and OCR words of pages
 * that came from the current document, turned if the page was turned.
 * Pages added from another PDF are not listed and are read afresh.
 */
function remapPages(oldRows, plan) {
    const byPage = new Map((oldRows || []).map(r => [r.page_no, r]));
    const kept = new Map();
    plan.forEach((step, i) => {
        if (step.src !== 'current') return;
        const row = byPage.get(step.page);
        if (!row) return;
        kept.set(i + 1, {
            hasText: !!row.has_text,
            ocrStatus: row.ocr_status,
            words: row.ocr_status === 'done' ? rotateWords(row.words, step.rotate) : null,
        });
    });
    return kept;
}

/** A short description of what the edit did, for the version list. */
function describePlan(plan, currentPages) {
    const kept = new Set(plan.filter(s => s.src === 'current').map(s => s.page));
    const removed = [];
    for (let p = 1; p <= currentPages; p++) if (!kept.has(p)) removed.push(p);
    const added = plan.filter(s => s.src !== 'current').length;
    const turned = plan.filter(s => s.rotate).length;
    const order = plan.filter(s => s.src === 'current').map(s => s.page);
    const reordered = order.some((p, i) => i > 0 && p < order[i - 1]);
    const parts = [];
    if (removed.length) parts.push(`removed page${removed.length === 1 ? '' : 's'} ${removed.join(', ')}`);
    if (added) parts.push(`added ${added} page${added === 1 ? '' : 's'}`);
    if (turned) parts.push(`turned ${turned} page${turned === 1 ? '' : 's'}`);
    if (reordered) parts.push('reordered pages');
    return parts.length ? parts.join('; ') : 'saved without changes';
}

module.exports = {
    cleanPlan, buildEdited, remapComments, remapPages, describePlan,
    rotateRect, rotateRects, rotateWords, TURNS,
};
