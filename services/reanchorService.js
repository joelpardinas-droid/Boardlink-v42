// ============================================================
// services/reanchorService.js — moving comments after a re-word
// ============================================================
//
// When the Board Secretary corrects the wording of an agenda item's
// document, the words move: a paragraph re-flows, a line lands lower,
// a page may gain or lose a line. A comment's highlight remembers a
// place on the page, so on its own it would end up pointing at the
// wrong sentence.
//
// BOARDLINK also saves the words each comment was made on
// (meeting_item_comments.anchor_quote). That is what makes the move
// possible: the new document is read, the quoted words are looked for
// again, and the highlight is put wherever they are now.
//
//   • found            → the comment moves to its new page and place
//   • found in part    → it moves, and is marked so the member can check
//   • not found at all → the words are gone, so the comment is kept
//                        against the item and marked (anchor_lost)
//
// A marked area has no words to look for. It keeps its page and its
// box and is marked for checking; its owner can drag it back into
// place. If its page no longer exists, it is marked as lost.
//
// No comment is ever deleted here.

const fs = require('fs');

let _pdfjs = null;
async function pdfjs() {
    if (!_pdfjs) _pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    return _pdfjs;
}

const r4 = v => Math.round(v * 10000) / 10000;

/** One space between words, so wrapping differences do not matter. */
const norm = s => String(s || '').replace(/\s+/g, ' ').trim();

// A quote must keep at least this much of itself to count as found.
const MIN_MATCH_WORDS = 3;
const MIN_MATCH_CHARS = 12;

/**
 * Reads a PDF into, for each page, the text as one searchable string
 * plus where every character sits on the page.
 *
 * Positions are fractions of the page with y measured from the top,
 * which is how the browser records a highlight.
 */
async function readPages(filePath) {
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
            const vp = page.getViewport({ scale: 1 });
            const tc = await page.getTextContent();
            page.cleanup();
            pages.push({ page: n, ...indexPage(tc.items, vp.width, vp.height) });
        }
        return { pages, pageCount: doc.numPages };
    } finally {
        await task.destroy();
    }
}

/**
 * Lays out one page's text chunks in reading order and builds:
 *   text — the page as a single string, words separated by one space
 *   map  — for each character of `text`, which chunk it came from and
 *          where in that chunk, so a match can be turned back into a
 *          box on the page
 */
function indexPage(items, W, H) {
    const chunks = [];
    for (const it of items) {
        const str = String(it.str || '');
        if (!str) continue;
        const t = it.transform || [];
        const h = Math.abs(it.height || t[3] || 10);
        const x = t[4] || 0;
        const base = t[5] || 0;              // baseline, from the page bottom
        const w = it.width || 0;
        chunks.push({
            str,
            px: x, py: base, ph: h, pw: w,   // page units, for ordering
            x: x / W, y: (H - (base + h)) / H, w: w / W, h: h / H,
        });
    }

    // Group into rows, top to bottom, then left to right — the same
    // reading order the briefing uses.
    const rows = [];
    for (const c of chunks) {
        let row = rows.find(r => Math.abs(r.py - c.py) <= Math.max(2, c.ph * 0.4));
        if (!row) { row = { py: c.py, items: [] }; rows.push(row); }
        row.items.push(c);
    }
    rows.sort((a, b) => b.py - a.py);
    rows.forEach(r => r.items.sort((a, b) => a.px - b.px));

    let text = '';
    const map = [];
    let openSpace = true;                    // no leading space
    const put = (ch, chunk, off) => { text += ch; map.push(chunk ? { chunk, off } : null); };
    const space = () => { if (!openSpace) { put(' ', null, 0); openSpace = true; } };

    rows.forEach((row, ri) => {
        if (ri > 0) space();                 // a line break reads as a space
        row.items.forEach((c, ci) => {
            for (let k = 0; k < c.str.length; k++) {
                const ch = c.str[k];
                if (/\s/.test(ch)) space();
                else { put(ch, c, k); openSpace = false; }
            }
            // A visible gap to the next chunk is a word break too.
            const next = row.items[ci + 1];
            if (next && next.px - (c.px + c.pw) > c.ph * 0.15) space();
        });
    });

    return { text: text.trim(), map: map.slice(0, text.trim().length || map.length) };
}

/** The boxes covering characters [from, to) of a page's text. */
function rectsFor(map, from, to) {
    const spans = new Map();                 // chunk → [minOff, maxOff]
    for (let i = from; i < to && i < map.length; i++) {
        const m = map[i];
        if (!m) continue;
        const span = spans.get(m.chunk);
        if (!span) spans.set(m.chunk, [m.off, m.off]);
        else { span[0] = Math.min(span[0], m.off); span[1] = Math.max(span[1], m.off); }
    }

    // One box per chunk, narrowed to the characters that matched.
    const boxes = [];
    for (const [c, [o1, o2]] of spans) {
        const n = c.str.length || 1;
        const x = c.x + c.w * (o1 / n);
        const w = c.w * ((o2 + 1 - o1) / n);
        if (w <= 0 || c.h <= 0) continue;
        boxes.push({ x, y: c.y, w, h: c.h });
    }

    // Boxes on the same line become one, as a highlight looks.
    const lines = new Map();
    for (const b of boxes) {
        const key = Math.round(b.y * 400);
        const line = lines.get(key);
        if (!line) lines.set(key, { x1: b.x, x2: b.x + b.w, y1: b.y, y2: b.y + b.h });
        else {
            line.x1 = Math.min(line.x1, b.x); line.x2 = Math.max(line.x2, b.x + b.w);
            line.y1 = Math.min(line.y1, b.y); line.y2 = Math.max(line.y2, b.y + b.h);
        }
    }

    return [...lines.values()]
        .sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1)
        .map(l => [
            r4(Math.max(0, l.x1)), r4(Math.max(0, l.y1)),
            r4(Math.min(1, l.x2) - Math.max(0, l.x1)), r4(Math.min(1, l.y2) - Math.max(0, l.y1)),
        ])
        .filter(r => r[2] > 0 && r[3] > 0)
        .slice(0, 60);
}

/** Looks for `needle` in a page, exactly first, then ignoring case. */
function positionIn(page, needle) {
    if (!needle) return -1;
    let at = page.text.indexOf(needle);
    if (at >= 0) return at;
    at = page.text.toLowerCase().indexOf(needle.toLowerCase());
    return at;
}

/**
 * Finds the words of a comment in the new document.
 * Returns { page, rects, partial } or null.
 *
 * `startPage` is where the comment used to be: that page is looked at
 * first, so a phrase appearing on several pages stays where it was.
 */
function findQuote(pages, quote, startPage, { context = null, uniqueOnly = false } = {}) {
    const full = norm(quote);
    if (!full) return null;

    const order = [...pages].sort((a, b) => {
        const near = p => Math.abs(p.page - (startPage || 1));
        return near(a) - near(b) || a.page - b.page;
    });
    const locate = needle => {
        for (const page of order) {
            const at = positionIn(page, needle);
            if (at >= 0) return { page, at };
        }
        return null;
    };
    const boxes = (page, at, len) => rectsFor(page.map, at, at + len);

    // 1. The quote together with the words around it (from the old
    //    page): longest first, so the right occurrence is found even for
    //    a few letters such as "umples" inside "kumplesyon".
    if (context) {
        const tries = [];
        for (const n of [40, 20, 8]) {
            const b = context.before.slice(-n), a = context.after.slice(0, n);
            tries.push([b, a], [b, ''], ['', a]);
        }
        for (const [b, a] of tries) {
            if (!b && !a) continue;
            const hit = locate(b + full + a);
            if (!hit) continue;
            const rects = boxes(hit.page, hit.at + b.length, full.length);
            if (rects.length) return { page: hit.page.page, rects, partial: false };
        }
    }

    // 2. A short quote on its own is only trusted where it is not
    //    ambiguous: once in the whole document.
    if (full.length < MIN_MATCH_CHARS || uniqueOnly) {
        if (full.length < 3) return null;
        const lower = full.toLowerCase();
        let count = 0, hit = null;
        for (const page of pages) {
            const t = page.text.toLowerCase();
            for (let at = t.indexOf(lower); at >= 0; at = t.indexOf(lower, at + 1)) { count++; hit = { page, at }; }
        }
        if (count !== 1) return null;
        const rects = boxes(hit.page, hit.at, full.length);
        return rects.length ? { page: hit.page.page, rects, partial: false } : null;
    }

    // 3. The whole quote, then the same quote with trailing words dropped:
    //    a word changed at the end should not lose the comment.
    const words = full.split(' ');
    const tries = [full];
    for (let n = words.length - 1; n >= MIN_MATCH_WORDS; n--) {
        const shorter = words.slice(0, n).join(' ');
        if (shorter.length < MIN_MATCH_CHARS) break;
        tries.push(shorter);
    }
    for (const needle of tries) {
        const hit = locate(needle);
        if (!hit) continue;
        const rects = boxes(hit.page, hit.at, needle.length);
        if (!rects.length) continue;
        return { page: hit.page.page, rects, partial: needle !== full };
    }
    return null;
}

/**
 * Works out where every comment goes in the re-worded document.
 *
 * Returns { changes, found, partial, marked, lost } where `changes` is
 * the list saveEditedItemPdf expects:
 *   { commentId, page, rects, lost, stale }
 */
async function remapForNewText(comments, newPdfPath, { oldPdfPath = null } = {}) {
    const { pages, pageCount } = await readPages(newPdfPath);
    // The document as it was before this change, when known: used to
    // leave comments on unchanged pages exactly where they are, and to
    // remember the words around each highlight.
    let old = null;
    if (oldPdfPath) {
        try { old = await readPages(oldPdfPath); } catch (_) { old = null; }
    }
    const oldPage = n => (old ? old.pages.find(p => p.page === n) : null);
    const newPage = n => pages.find(p => p.page === n);

    const changes = [];
    let found = 0, partial = 0, marked = 0, lost = 0;

    for (const c of comments) {
        if (!c.page_number && !c.anchor_lost) continue;       // a general comment
        const type = c.anchor_type || (c.anchor_quote ? 'text' : null);
        const rects = parseRects(c.anchor_rects);

        // A comment whose words were not found last time: look once more,
        // in case they were missed (BOARDLINK used to skip short quotes).
        if (c.anchor_lost) {
            if (!c.anchor_quote) continue;
            const hit = findQuote(pages, c.anchor_quote, null, { uniqueOnly: true });
            if (hit) {
                changes.push({ commentId: c.comment_id, page: hit.page, rects: hit.rects,
                               lost: false, stale: true, recovered: true });
                partial++;
            }
            continue;
        }

        // 1. The comment's page did not change at all: nothing moves.
        const before = oldPage(c.page_number);
        const after = newPage(c.page_number);
        if (before && after && before.text === after.text) {
            changes.push({ commentId: c.comment_id, page: c.page_number, rects, lost: false });   // stale left as it was
            if (type !== 'area') found++;
            continue;
        }

        if (type === 'text' && c.anchor_quote) {
            // 2. Look for the words, with the words around them from the
            //    old page, so even a few letters are found in the right place.
            const context = before ? contextOf(before, c.anchor_quote, rects) : null;
            const hit = findQuote(pages, c.anchor_quote, c.page_number, { context });
            if (hit) {
                changes.push({ commentId: c.comment_id, page: hit.page, rects: hit.rects, lost: false, stale: hit.partial });
                if (hit.partial) partial++; else found++;
                continue;
            }
            // The very words the member commented on were rewritten.
            changes.push({ commentId: c.comment_id, lost: true, reworded: true });
            lost++;
            continue;
        }

        // A marked area on a page that changed: it keeps its place and is
        // flagged. Its owner can move it (areas can be re-drawn).
        if (c.page_number > pageCount) {
            changes.push({ commentId: c.comment_id, lost: true });
            lost++;
        } else {
            changes.push({ commentId: c.comment_id, page: c.page_number, rects, lost: false, stale: true });
            marked++;
        }
    }

    return { changes, found, partial, marked, lost, pageCount };
}

/**
 * The words just before and after a comment's quote on the OLD page,
 * choosing the occurrence under the comment's highlight when the quote
 * appears more than once there.
 */
function contextOf(page, quote, rects) {
    const q = norm(quote);
    if (!q) return null;
    const hay = page.text.toLowerCase(), needle = q.toLowerCase();
    const spots = [];
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) spots.push(at);
    if (!spots.length) return null;
    let at = spots[0];
    if (spots.length > 1 && rects && rects.length) {
        // The occurrence whose box is closest to where the highlight was.
        const [hx, hy] = rects[0];
        let best = Infinity;
        for (const s of spots) {
            const r = rectsFor(page.map, s, s + q.length)[0];
            if (!r) continue;
            const d = Math.abs(r[1] - hy) * 4 + Math.abs(r[0] - hx);
            if (d < best) { best = d; at = s; }
        }
    }
    return {
        before: page.text.slice(Math.max(0, at - 40), at),
        after: page.text.slice(at + q.length, at + q.length + 40),
    };
}

function parseRects(raw) {
    if (!raw) return null;
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch (_) { return null; }
}

/** Plain words for the Secretary, after the document was saved. */
function describeRemap({ found, partial, marked, lost }) {
    const parts = [];
    if (found)   parts.push(`${found} comment${found === 1 ? '' : 's'} followed their words`);
    if (partial) parts.push(`${partial} moved but should be checked`);
    if (marked)  parts.push(`${marked} marked area${marked === 1 ? '' : 's'} to check`);
    if (lost)    parts.push(`${lost} whose words are no longer in the document`);
    return parts.length ? parts.join('; ') : 'no comments needed moving';
}

module.exports = {
    readPages, indexPage, rectsFor, findQuote, contextOf, remapForNewText, describeRemap,
    norm, MIN_MATCH_WORDS, MIN_MATCH_CHARS,
};
