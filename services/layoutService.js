// ============================================================
// services/layoutService.js — copy the layout of a scanned paper
// (v97): its margins, the space between lines, indents, centred or
// right-aligned lines and bigger headings
// ============================================================
//
// OCR tells where each line of a page is (fractions of the page, 0–1).
// From that, every page becomes paragraphs for the OCR page's editor
// and for the Word / PDF file:
//
//   { align, pb, runs,
//     before,   space above the paragraph (points)
//     indent,   left indent (points, from the left margin)
//     first,    extra indent of the first line (points, may be negative)
//     size,     font size (points)
//     line }    height of each line (points)
//
// and the page margins { top, right, bottom, left } in points.
//
// Lines that are wrapped text in the scan (same left edge, reaching the
// right edge, evenly spaced) are joined into one paragraph, so the words
// still flow when they are corrected. The paper size comes from the scan.

const PT = { letter: [612, 792], a4: [595.28, 841.89], long: [612, 936] };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const half = v => Math.round(v * 2) / 2;

/** Font size (pt) of an OCR'd line from its height on the page. */
function sizeOf(l, H) {
    if (l.size) return clamp(half(l.size), 6, 36);                       // typed PDF: exact
    return clamp(half((l.rowH || (l.y1 - l.y0)) * H * 1.1), 6, 36);      // scan: row height x 1.1
}

/**
 * pages: [{ lines: [{ text, x0, x1, y0, y1, rowH?, size? }] } | null]
 * paper: 'letter' | 'a4' | 'long'
 * Returns { paras, margins } or null when there is nothing to copy.
 */
function fromLayout(pages, paper) {
    const [W, H] = PT[paper] || PT.letter;
    const all = (pages || []).filter(p => p && Array.isArray(p.lines) && p.lines.length);
    if (!all.length) return null;

    // Margins: where the words are on the pages (within sensible limits).
    const lines = all.flatMap(p => p.lines);
    const left   = clamp(Math.min(...lines.map(l => l.x0)) * W, 18, 144);
    const right  = clamp((1 - Math.max(...lines.map(l => l.x1))) * W, 18, 144);
    const top    = clamp(Math.min(...all.map(p => Math.min(...p.lines.map(l => l.y0)))) * H - 4, 18, 144);
    // (Some room is left at the bottom so a footer on the last line stays on its page.)
    const bottom = clamp((1 - Math.max(...all.map(p => Math.max(...p.lines.map(l => l.y1))))) * H - 18, 9, 72);
    const margins = { top: half(top), right: half(right), bottom: half(bottom), left: half(left) };
    // Sizes close to each other are one size: the most used size takes in
    // every size within 1.25 pt, then the next most used, and so on.
    const count = {};
    lines.forEach(l => { const z = sizeOf(l, H); count[z] = (count[z] || 0) + l.text.length; });
    const snapTo = {};
    Object.keys(count).map(Number).sort((a, b) => count[b] - count[a]).forEach(z => {
        if (snapTo[z]) return;
        Object.keys(count).map(Number).forEach(o => { if (!snapTo[o] && Math.abs(o - z) <= 1.25) snapTo[o] = z; });
    });
    const snap = z => snapTo[z] || z;
    const areaW = W - margins.left - margins.right;
    const areaC = margins.left + areaW / 2;

    const paras = [];
    (pages || []).forEach((page, n) => {
        const ls = page && page.lines ? page.lines.slice().sort((a, b) => a.y0 - b.y0) : [];
        if (!ls.length) {                                   // a blank page stays a page
            paras.push({ align: 'left', pb: n > 0, before: 0, indent: 0, first: 0, size: 12, line: 14.5, runs: [] });
            return;
        }
        // 1. Each line as it sits on the page (points).
        const rows = ls.map(l => {
            const size = snap(sizeOf(l, H));
            const x0 = l.x0 * W, x1 = l.x1 * W, y0 = l.y0 * H;
            const mid = (x0 + x1) / 2, w = x1 - x0;
            let align = 'left';
            const off = x0 - margins.left, rest = margins.left + areaW - x1;
            if (Math.abs(mid - areaC) < areaW * 0.04 && off > areaW * 0.06 && w < areaW * 0.9) align = 'center';
            else if (rest < areaW * 0.03 && off > areaW * 0.35) align = 'right';
            // The words with their bold / italic / font: from a typed PDF as
            // they are; from a scan, the whole line bold or not.
            const runs = Array.isArray(l.runs) && l.runs.length
                ? l.runs.map(r => ({ text: r.text, b: !!r.b, i: !!r.i, u: false, ...(r.font ? { font: r.font } : {}) }))
                : [{ text: l.text, b: !!l.bold, i: false, u: false }];
            return { text: l.text, runs, size, x0, x1, y0, align, full: rest < areaW * 0.07 };
        });
        // 2. Wrapped lines → one paragraph.
        const groups = [];
        for (const r of rows) {
            const g = groups[groups.length - 1];
            const prev = g && g.rows[g.rows.length - 1];
            const pitch = prev ? r.y0 - prev.y0 : 0;
            const evenly = prev && pitch > prev.size * 0.9 && pitch < prev.size * 1.9
                && (g.rows.length < 2 || Math.abs(pitch - g.pitch) < prev.size * 0.35);
            const sameEdge = prev && Math.abs(r.x0 - (g.rows.length > 1 ? g.body : prev.x0)) < areaW * 0.025;
            const firstIndented = prev && g.rows.length === 1 && r.x0 < prev.x0 - 2 && prev.x0 - r.x0 < areaW * 0.12;
            if (g && prev.align === 'left' && r.align !== 'center' && prev.full && evenly
                && Math.abs(r.size - prev.size) <= 1 && (sameEdge || firstIndented)) {
                if (g.rows.length === 1) g.body = r.x0;
                g.pitch = g.rows.length === 1 ? pitch : (g.pitch * (g.rows.length - 1) + pitch) / g.rows.length;
                g.rows.push(r);
            } else {
                groups.push({ rows: [r], pitch: 0, body: r.x0 });
            }
        }
        // 3. Paragraphs with the same spaces as the scan.
        let bottomPrev = margins.top;                       // where the previous paragraph ends
        const start = paras.length;
        groups.forEach((g, k) => {
            const r0 = g.rows[0];
            const size = half(g.rows.reduce((s, r) => s + r.size, 0) / g.rows.length);
            const line = half(g.rows.length > 1 ? clamp(g.pitch, size * 1.0, size * 2.2) : size * 1.2);
            const topOfLine = r0.y0 - (line - size) / 2 - size * 0.12;     // the line box starts a little above the letters
            const many = g.rows.length > 1;
            const align = many ? (g.rows.slice(0, -1).every(r => r.full) ? 'justify' : 'left') : r0.align;
            const bodyX = many ? g.body : r0.x0;
            const indent = align === 'left' || align === 'justify' ? clamp(half(bodyX - margins.left), 0, areaW * 0.8) : 0;
            const first = many ? clamp(half(r0.x0 - bodyX), -indent, areaW * 0.5) : 0;
            // A line that is one line on the scan stays one line: its size is
            // made smaller when the words would not fit across the page.
            let fit = size;
            if (!many) {
                const avail = (W - margins.left - margins.right - indent) * 0.97;
                const w = textWidth({ size, runs: r0.runs });
                if (w > avail) fit = Math.max(6, Math.floor(size * avail / w * 2) / 2);
            }
            paras.push({
                align, pb: n > 0 && k === 0,
                before: clamp(half(topOfLine - bottomPrev), 0, H * 0.6),
                indent, first, size: fit, line,
                runs: joinRuns(g.rows),
            });
            bottomPrev = Math.max(bottomPrev, topOfLine) + line * g.rows.length;
        });
        // The page must still fit on one page: if the words need more room
        // than the scan had (another font wraps differently), the spaces
        // between paragraphs are made a little smaller.
        const room = H - margins.top - margins.bottom - 6;
        const mine = paras.slice(start);
        const used = mine.reduce((t, p) => t + p.before + p.line * Math.max(1, Math.ceil(textWidth(p) / (W - margins.left - margins.right - p.indent))), 0);
        const gaps = mine.reduce((t, p) => t + p.before, 0);
        if (used > room && gaps > 0) {
            const k = Math.max(0, (gaps - (used - room)) / gaps);
            mine.forEach(p => { p.before = half(p.before * k); });
        }
    });
    return paras.length ? { paras, margins } : null;
}

/** About how wide words are in points (Times New Roman widths; Arial is wider). */
function widthOf(text, size, font) {
    let em = 0;
    for (const c of String(text)) {
        em += c === ' ' ? 0.25 : /[A-Z]/.test(c) ? (/[MW]/.test(c) ? 0.9 : 0.68) : /[0-9]/.test(c) ? 0.5
            : /[ilj.,:;'|!]/.test(c) ? 0.28 : /[mw]/.test(c) ? 0.75 : 0.46;
    }
    return em * size * (font === 'Arial' ? 1.08 : font === 'Courier New' ? 1.3 : 1);
}
function textWidth(p) {
    return p.runs.reduce((t, r) => t + widthOf(r.text, p.size, r.font) * (r.b ? 1.06 : 1), 0);
}

/** The words of wrapped lines as one paragraph; "pro-" + "gram" is joined again. */
function joinRuns(rows) {
    const out = [];
    const add = r => {
        const last = out[out.length - 1];
        if (last && last.b === r.b && last.i === r.i && last.u === r.u && last.font === r.font) last.text += r.text;
        else out.push({ ...r });
    };
    rows.forEach((row, k) => {
        row.runs.forEach((r, j) => {
            let t = r.text;
            if (k > 0 && j === 0) {
                const last = out[out.length - 1];
                if (last && /[a-z]-$/.test(last.text) && /^[a-z]/.test(t)) last.text = last.text.slice(0, -1);
                else t = ' ' + t;
            }
            add({ ...r, text: t });
        });
    });
    return out;
}

/** Checks margins sent by the browser; null when missing or odd. */
function cleanMargins(m) {
    if (typeof m === 'string') { try { m = JSON.parse(m); } catch (_) { return null; } }
    if (!m || typeof m !== 'object') return null;
    const out = {};
    for (const k of ['top', 'right', 'bottom', 'left']) {
        const v = Number(m[k]);
        if (!Number.isFinite(v)) return null;
        out[k] = clamp(half(v), 9, 216);
    }
    return out;
}

module.exports = { fromLayout, cleanMargins, PT };
