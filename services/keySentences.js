// ============================================================
// services/keySentences.js — the important sentences of a document
// ============================================================
//
// Picks out the sentences of an agenda item's document that carry the
// most information, WORD FOR WORD, without any AI. It is used twice:
//
//   condense()  — shortens a long document before the local AI reads
//                 it, so the AI is asked once instead of five or six
//                 times. Every page keeps a share, so no part of the
//                 document is skipped entirely.
//   overview()  — a quick overview shown at once on the review page,
//                 before (or without) an AI summary. Because the
//                 sentences are copied from the document, nothing in it
//                 can be made up.
//
// A sentence scores higher when it holds figures, dates or amounts,
// words that signal a request or decision, or opens a paragraph.

const KEYWORDS = new RegExp('\\b(' + [
    'approv\\w*', 'request\\w*', 'propos\\w*', 'recommend\\w*', 'endors\\w*', 'resolv\\w*',
    'budget', 'amount', 'total', 'cost', 'fund\\w*', 'allocat\\w*', 'fee\\w*', 'salar\\w*',
    'shall', 'must', 'required?', 'deadline', 'effective', 'until', 'responsib\\w*',
    'purpose', 'objective\\w*', 'aims?', 'goal\\w*', 'result\\w*', 'finding\\w*', 'conclu\\w*',
    'respondents?', 'sample', 'population', 'method\\w*', 'design',
    'presents?', 'discuss\\w*', 'outlines?', 'covers?', 'describes?',
    'contract', 'agreement', 'policy', 'polic(y|ies)', 'guideline\\w*', 'curricul\\w*',
    'appoint\\w*', 'hir\\w*', 'renew\\w*', 'revis\\w*', 'amend\\w*',
].join('|') + ')\\b', 'i');

// Abbreviations that end in a full stop but do not end a sentence.
const ABBREV = /\b(?:Dr|Mr|Mrs|Ms|Engr|Atty|Hon|Prof|Sr|Jr|St|vs|al|No|Nos|Sec|Secs|Fig|Figs|Vol|Art|Rep|Gov|Inc|Corp|Co|Ltd|e\.g|i\.e|etc|approx)\.$/i;

const isPageNumber = l => /^(page\s*)?\d{1,4}$/i.test(l) || /^-\s*\d{1,4}\s*-$/.test(l);

function isHeading(line) {
    if (line.length > 120) return false;
    if (/^chapter\s+[\divxlc]+\b/i.test(line)) return true;
    if (/^(table|figure|annex|appendix)\s+[\dA-Z]+[:.\s]/i.test(line)) return true;
    // "3.1 Research Design", "3.1.2. Sources of Data", "IV. OTHER MATTERS"
    if (/^(\d{1,2}\.)+\d{0,2}\s+[A-Za-z]/.test(line) && !/[.;,]$/.test(line) && line.length < 100
        && !/https?:|www\./i.test(line)) return true;
    if (/^[IVX]+\.\s+\S/.test(line) && line.length < 90) return true;
    // A short title in Title Case with no full stop: "Why Teamwork Matters"
    const words = line.split(' ');
    if (words.length >= 2 && words.length <= 9 && line.length < 70 && !/\d/.test(line)
        && !/[.,;:!?]$/.test(line)
        && words.filter(w => /^[A-Z]/.test(w)).length >= Math.ceil(words.filter(w => w.length > 3).length * 0.8)
        && words.filter(w => w.length > 3).length >= 2) return true;
    // A short line in capitals: "TECHNICAL BACKGROUND" (not a table's
    // column names or its TOTAL row, which carry figures).
    const letters = line.replace(/[^A-Za-z]/g, '');
    return letters.length >= 4 && line.length < 80 && !/\d/.test(line)
        && letters === letters.toUpperCase() && !/[.,;]$/.test(line);
}

/** Share of the words that are numbers — high for rows of a table. */
function numberShare(text) {
    const words = text.split(/\s+/).filter(Boolean);
    if (!words.length) return 0;
    return words.filter(w => /^[\d.,%₱$()\-–—:/]+$/.test(w)).length / words.length;
}

/**
 * Lines that repeat across many pages (running headers and footers)
 * carry nothing, and would otherwise be picked on every page.
 */
function repeatedLines(pages) {
    if (pages.length < 4) return new Set();
    const seen = new Map();
    for (const p of pages) {
        for (const l of new Set(String(p.text).split('\n').map(s => s.trim()).filter(Boolean))) {
            seen.set(l, (seen.get(l) || 0) + 1);
        }
    }
    const min = Math.max(3, Math.ceil(pages.length * 0.3));
    return new Set([...seen].filter(([l, n]) => n >= min && l.length < 120).map(([l]) => l));
}

/** One page's text as headings, table blocks and prose paragraphs. */
function blocksOf(pageText, skip) {
    const lines = String(pageText || '').split('\n').map(s => s.replace(/\s+/g, ' ').trim())
        .filter(l => l && !isPageNumber(l) && !skip.has(l));
    const longest = lines.reduce((m, l) => Math.max(m, l.length), 0) || 1;
    const blocks = [];
    let buf = [];
    let inTable = false;          // between a "Table N:" caption and the prose after it
    const flush = () => {
        if (!buf.length) return;
        const text = buf.join(' ').replace(/(\w)- (\w)/g, '$1-$2').trim();
        blocks.push({ kind: numberShare(text) >= 0.2 ? 'table' : 'prose', text });
        buf = [];
    };
    for (const l of lines) {
        const words = l.split(' ').length;
        if (inTable && words >= 9 && numberShare(l) < 0.12 && /^[A-Z"“]/.test(l)) {
            // Prose again: the table has ended.
            if (buf.length) { blocks.push({ kind: 'table', text: buf.join(' ') }); buf = []; }
            inTable = false;
        }
        if (/^table\s+\d+[:.\s]/i.test(l)) {
            flush(); blocks.push({ kind: 'heading', text: l }); inTable = true; continue;
        }
        if (inTable) { buf.push(l); continue; }
        if (isHeading(l)) { flush(); blocks.push({ kind: 'heading', text: l }); continue; }
        buf.push(l);
        // A paragraph ends on a line that finishes a sentence and stops
        // short of the right margin.
        if (/[.!?:]["”’)]?$/.test(l) && l.length < longest * 0.85) flush();
    }
    if (inTable && buf.length) { blocks.push({ kind: 'table', text: buf.join(' ') }); buf = []; }
    flush();
    return blocks;
}

function sentencesOf(paragraph) {
    const parts = paragraph.split(/(?<=[.!?]["”’)]?)\s+(?=["“(]?[A-Z0-9])/);
    const out = [];
    for (const s of parts) {
        if (out.length && ABBREV.test(out[out.length - 1])) out[out.length - 1] += ' ' + s;
        else out.push(s);
    }
    return out.map(s => s.trim()).filter(Boolean);
}

function score(sentence, first) {
    let s = 1;
    const figures = (sentence.match(/[₱$]?\d[\d,]*(?:\.\d+)?%?/g) || []).filter(n => n.replace(/\D/g, '').length >= 2);
    s += Math.min(2, figures.length * 0.5);
    if (/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/.test(sentence)) s += 0.5;
    if (KEYWORDS.test(sentence)) s += 1.5;
    if (first) s += 1;
    if (/\[\d+(?:[,–-]\s*\d+)*\]/.test(sentence)) s -= 0.5;          // leans on a citation
    if (sentence.length < 50) s -= 1.5;
    if (sentence.length > 350) s -= 1;
    // Table cells run together ("…Transcription The generated…"): a
    // capital "The" in the middle of a sentence.
    if (/[a-z,] (The|This|These|Each|All) [a-z]/.test(sentence)) s -= 3;
    // Program code or a formula, not a sentence.
    if (/=>|[{}]|\);|\bconst\b|\bfunction\b|==|\w\(\)/.test(sentence)) s -= 6;
    return s;
}

/** Every candidate unit of the document, in reading order. */
function analyse(pages) {
    const skip = repeatedLines(pages);
    const units = [];
    let seq = 0;
    for (const p of pages) {
        for (const b of blocksOf(p.text, skip)) {
            if (b.kind === 'heading') {
                units.push({ seq: seq++, page: p.page, kind: 'heading', text: b.text, score: 99 });
            } else if (b.kind === 'table') {
                units.push({ seq: seq++, page: p.page, kind: 'table', text: b.text, score: 2.5 });
            } else {
                sentencesOf(b.text).forEach((t, i) => {
                    if (t.length < 25) return;                     // a stray fragment
                    units.push({ seq: seq++, page: p.page, kind: 'sentence', text: t, first: i === 0, score: score(t, i === 0) });
                });
            }
        }
    }
    return units;
}

/**
 * The document cut down to about `budget` characters for the AI.
 * Returns { text, condensed, keptChars, totalChars }.
 */
function condense(pages, budget = 9000) {
    const full = pages.map(p => `[Page ${p.page}]\n${p.text}`).join('\n');
    if (full.length <= budget) return { text: full, condensed: false, keptChars: full.length, totalChars: full.length };

    const units = analyse(pages);
    const chosen = new Set();
    let used = 0;
    const take = u => { chosen.add(u.seq); used += u.text.length + 1; };

    // Headings first: short, and they tell the AI how the document is laid out.
    for (const u of units) if (u.kind === 'heading' && used < budget * 0.12) take(u);

    // Each page's share of what is left, by how much text it has.
    const perPage = new Map();
    for (const u of units) if (u.kind !== 'heading') perPage.set(u.page, (perPage.get(u.page) || 0) + u.text.length);
    const total = [...perPage.values()].reduce((a, b) => a + b, 0) || 1;
    const room = budget - used;
    for (const [page, chars] of perPage) {
        const quota = Math.max(220, Math.floor(room * chars / total));
        let got = 0;
        const cands = units.filter(u => u.page === page && u.kind !== 'heading' && !chosen.has(u.seq))
            .filter(u => u.kind !== 'table' || u.text.length <= 900)
            .sort((a, b) => b.score - a.score || a.seq - b.seq);
        for (const u of cands) {
            if (got + u.text.length > quota && got > 0) continue;
            if (used + u.text.length > budget) break;
            take(u); got += u.text.length;
        }
    }
    // Anything left over goes to the best sentences anywhere.
    for (const u of units.filter(x => !chosen.has(x.seq) && x.kind === 'sentence').sort((a, b) => b.score - a.score)) {
        if (used + u.text.length > budget) continue;
        take(u);
    }

    // Back into reading order, marking where passages were left out.
    const lines = [];
    let lastPage = null, lastSeq = -1;
    for (const u of units) {
        if (!chosen.has(u.seq)) continue;
        if (u.page !== lastPage) { lines.push(`[Page ${u.page}]`); lastPage = u.page; }
        else if (u.seq !== lastSeq + 1) lines.push('…');
        lines.push(u.kind === 'table' ? `(table) ${u.text}` : u.text);
        lastSeq = u.seq;
    }
    const text = lines.join('\n');
    return { text, condensed: true, keptChars: text.length, totalChars: full.length };
}

/**
 * A quick overview for people: the document's main sections and its
 * most informative sentences, copied exactly, each with its page.
 */
function overview(pages, { sentences = 5, sections = 8 } = {}) {
    const units = analyse(pages);
    let outline = [];
    for (const u of units) {
        if (u.kind !== 'heading' || /^(chapter|table|figure|annex|appendix)\b/i.test(u.text)) continue;
        if (!outline.some(o => o.text === u.text)) outline.push({ text: u.text, page: u.page });
    }
    // With numbered sections, a line in capitals after the first one is
    // almost always a table's column names, not a section title.
    const numbered = outline.filter(o => /^(\d+\.)+\d*\s|^[IVX]+\.\s/.test(o.text));
    if (numbered.length >= 3) {
        const firstAt = outline.indexOf(numbered[0]);
        outline = outline.filter((o, i) => i < firstAt || numbered.includes(o));
    }
    // Too many to list: keep the main ones ("3.1", "IV.") so the list
    // still covers the whole document rather than only its beginning.
    if (outline.length > sections) {
        const depth = t => { const m = /^(\d+(?:\.\d+)*)/.exec(t); return m ? m[1].split('.').length : 1; };
        const main = outline.filter(o => depth(o.text) <= 2);
        outline = main.length >= 3 ? main : outline;
    }
    outline = outline.slice(0, sections + 2);
    // Whole sentences only: starting with a capital, not a table row
    // or code, and not too short or long to read comfortably.
    const prose = units.filter(u => u.kind === 'sentence' && u.text.length >= 80 && u.text.length <= 320
        && !/\b(my|I|me)\b/.test(u.text)                    // a questionnaire statement, not the document speaking
        && /^["“(]?[A-Z]/.test(u.text) && /[.!?]["”’)]?$/.test(u.text)
        && numberShare(u.text) < 0.1 && u.score > -2);
    const picked = [];
    // The document's opening sentence usually says what it is.
    if (prose.length) picked.push(prose[0]);
    // The rest: the best sentence from each stretch of the document, so
    // the overview covers its end as well as its beginning.
    if (prose.length > 1) {
        const firstPage = prose[0].page, lastPage = prose[prose.length - 1].page;
        const bands = Math.max(1, sentences - 1);
        const span = (lastPage - firstPage + 1) / bands;
        for (let b = 0; b < bands; b++) {
            const lo = firstPage + b * span, hi = firstPage + (b + 1) * span;
            const best = prose.filter(u => !picked.includes(u) && u.page >= lo && u.page < hi)
                .sort((x, y) => y.score - x.score || x.seq - y.seq)[0];
            if (best) picked.push(best);
        }
        // A stretch with no good sentence: fill from the best overall.
        for (const u of [...prose].sort((x, y) => y.score - x.score || x.seq - y.seq)) {
            if (picked.length >= sentences) break;
            if (!picked.includes(u)) picked.push(u);
        }
    }
    picked.sort((a, b) => a.seq - b.seq);
    return {
        sections: outline,
        sentences: picked.map(u => ({ text: u.text, page: u.page })),
    };
}

module.exports = { condense, overview, analyse };
