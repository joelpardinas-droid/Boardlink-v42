// ============================================================
// services/llmService.js — Local LLM via Ollama
//
// BOARDLINK | Chapter 3 Sec. 3.6
//   Module 8: AI-generated Meeting Summary
//   Module 2.3: AI-generated Pre-Meeting Briefing
// ============================================================
//
// Replaces the earlier OpenAI GPT API integration with a local
// Ollama server running Llama 3.1 8B Instruct. Prompts and
// responses never leave the CSPC network.
//
// Ollama exposes an HTTP API on localhost:11434 by default.
// We call it with plain fetch (built into Node 18+), avoiding
// any additional SDK dependency.
//
// Performance note (Chapter 3 defense):
//   Local Llama 3.1 8B on the documented i5 / 8 GB RAM hardware
//   takes roughly 30–90 seconds to produce a meeting summary,
//   compared with 5–10 seconds via a cloud API. This is
//   acceptable because summaries and briefings are generated
//   asynchronously, not during live meetings.

require('dotenv').config();

// "localhost" is changed to 127.0.0.1: on Windows, Node may try the
// IPv6 address (::1) first, where Ollama is not listening, and report
// Ollama as "not reachable" even though it is running.
const OLLAMA_HOST  = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434')
    .replace(/\/\/localhost(?=[:/]|$)/i, '//127.0.0.1').replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';
// Context window requested from Ollama. Ollama's own default is only
// 2,048–4,096 tokens and it silently drops whatever does not fit, so
// long documents were being cut without any error. 8,192 tokens fits a
// ~12,000-character part of a document plus instructions and answer.
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX || 8192);
// Longest model call allowed before it is abandoned.
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 15 * 60 * 1000);

/**
 * Is the local AI ready? Asks Ollama for its list of models, which
 * answers in milliseconds, instead of finding out only after a
 * document has been prepared and a long request has been sent.
 * Returns { ok, reason: 'ready'|'down'|'no_model', message }.
 * The answer is remembered for 15 seconds.
 */
let _health = null;
async function health({ fresh = false } = {}) {
    if (!fresh && _health && Date.now() - _health.at < 15000) return _health.value;
    let value;
    try {
        const r = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(3000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        const names = (data.models || []).map(m => String(m.name || m.model || ''));
        const want = OLLAMA_MODEL.includes(':') ? OLLAMA_MODEL : `${OLLAMA_MODEL}:latest`;
        if (names.some(n => n === OLLAMA_MODEL || n === want)) {
            value = { ok: true, reason: 'ready', message: 'ready' };
        } else {
            value = {
                ok: false, reason: 'no_model',
                message: `The AI is running, but its model "${OLLAMA_MODEL}" is not installed yet. ` +
                    `On the server, open a terminal and run: ollama pull ${OLLAMA_MODEL}`,
            };
        }
    } catch (_) {
        value = {
            ok: false, reason: 'down',
            message: `The local AI (Ollama) is not running, so nothing could be summarised. ` +
                `Open the Ollama app on the server (or run: ollama serve), then click "Summarise this document" again.`,
        };
    }
    _health = { at: Date.now(), value };
    return value;
}

/**
 * Loads the model into memory ahead of time, so the first summary does
 * not also have to wait for about 5 GB to be read from disk. Called
 * when BOARDLINK starts; does nothing if Ollama is not running.
 */
async function warmUp() {
    const h = await health({ fresh: true });
    if (!h.ok) {
        console.warn(`  ⚠️   Local AI not ready: ${h.message}`);
        return false;
    }
    const t0 = Date.now();
    try {
        // An empty prompt only loads the model; nothing is generated.
        const r = await fetch(`${OLLAMA_HOST}/api/generate`, {
            method: 'POST',
            signal: AbortSignal.timeout(10 * 60 * 1000),
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: OLLAMA_MODEL, prompt: '', keep_alive: process.env.OLLAMA_KEEP_ALIVE || '60m' }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        console.log(`  ✅  Local AI ready: ${OLLAMA_MODEL} loaded in ${Math.round((Date.now() - t0) / 1000)}s`);
        return true;
    } catch (err) {
        console.warn('  ⚠️   Local AI could not load its model:', err.message);
        return false;
    }
}

/**
 * Low-level call to the Ollama HTTP API.
 * Returns the generated text string.
 */
async function generate(systemPrompt, userPrompt, options = {}, cancel = null) {
    let response;
    // `cancel` is an AbortSignal: the Cancel button stops the AI at once.
    const timeout = AbortSignal.timeout(OLLAMA_TIMEOUT_MS);
    try {
        if (cancel && cancel.aborted) throw Object.assign(new Error('Cancelled.'), { cancelled: true });
        response = await fetch(`${OLLAMA_HOST}/api/generate`, {
            method:  'POST',
            signal:  cancel ? AbortSignal.any([timeout, cancel]) : timeout,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model:  OLLAMA_MODEL,
                system: systemPrompt,
                prompt: userPrompt,
                stream: false,
                // Keeping the model resident between requests avoids
                // re-loading roughly 6 GB of weights from disk on every
                // call, which on the documented hardware is the single
                // largest source of latency.
                keep_alive: process.env.OLLAMA_KEEP_ALIVE || '60m',
                options: {
                    // Low temperature: this is a factual summary of an
                    // agenda, not creative writing. Higher values are
                    // what make a model embellish.
                    temperature: 0.15,
                    top_p:       0.85,
                    // Cap the response length. Generation time scales
                    // almost linearly with tokens produced, so this is
                    // the most effective single speed control.
                    num_predict: 400,
                    num_ctx:     OLLAMA_NUM_CTX,
                    ...options,
                },
            }),
        });
    } catch (err) {
        if (err && (err.cancelled || (cancel && cancel.aborted))) {
            throw Object.assign(new Error('Cancelled.'), { cancelled: true });
        }
        if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
            throw new Error(`The local AI model did not answer within ${Math.round(OLLAMA_TIMEOUT_MS / 60000)} minutes.`);
        }
        throw new Error(
            `Ollama is not reachable at ${OLLAMA_HOST}. ` +
            `Start the Ollama service and ensure the '${OLLAMA_MODEL}' model is pulled ` +
            `(ollama pull ${OLLAMA_MODEL}).`
        );
    }

    if (!response.ok) {
        throw new Error(`Ollama returned HTTP ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    return (data.response || '').trim();
}

/**
 * Module 8: Post-meeting summary.
 * Produces Key Decisions, Action Items, and Next Meeting from
 * a raw transcript.
 */
async function summarize(transcriptText) {
    const system =
        'You are a Board Secretary assistant for a Philippine state university. ' +
        'Produce a concise, factual summary of the following board meeting transcript. ' +
        'Use three sections with these exact headings: KEY DECISIONS, ACTION ITEMS, NEXT MEETING. ' +
        'Use bullet points. Do not invent information that is not in the transcript.';
    return generate(system, transcriptText);
}

/**
 * Module 2.3: Pre-meeting AI briefing.
 * Given the uploaded agenda items, produces a bullet-point
 * briefing of the key items to deliberate. Distributed to
 * board members five (5) days before each scheduled meeting
 * together with the agenda itself.
 */
/**
 * Pre-meeting briefing (Module 6).
 *
 * The prompt is deliberately restrictive. An earlier version asked
 * the model for "supporting context and any prior decisions that
 * are relevant" while supplying nothing but the agenda titles —
 * an open invitation to invent budget figures, dates and past
 * resolutions that do not exist. For a document that trustees read
 * before voting, a plausible fabrication is worse than a thin
 * summary, so the model is now told to work only from the lines it
 * is given and to say so when something is not stated.
 */
async function brief(agendaText) {
    const system = [
        'You prepare pre-meeting briefings for the Board of Trustees of a',
        'Philippine state college.',
        '',
        'STRICT RULES:',
        '1. Use ONLY the agenda information provided below. It is the complete',
        '   set of facts available to you.',
        '2. Never invent figures, dates, names, amounts, policy numbers, or',
        '   past decisions. If the agenda does not state something, do not',
        '   mention it.',
        '3. Do not speculate about what an item "likely" contains or what the',
        '   Board "may" decide.',
        '4. Every item you name must appear verbatim in the agenda provided.',
        '',
        'FORMAT:',
        '- Open with one sentence stating the meeting type, date and the number',
        '  of agenda items.',
        '- Then group the items by their stated category (For Approval, For',
        '  Information, and so on) as short bullet points, keeping each item\'s',
        '  wording close to the original.',
        '- Close with one short line noting which categories require a formal',
        '  motion, if any such items are present.',
        '',
        'Keep the whole briefing under 250 words. Plain text only, no markdown',
        'headers, no preamble such as "Here is the briefing".',
    ].join('\n');

    return generate(system, agendaText, { num_predict: 380 });
}

/**
 * Module 7 (panelist-suggested addition): Basic post-transcription summary.
 *
 * Generated immediately after AI transcription completes, on the same
 * page as the transcript itself. Provides a quick at-a-glance overview
 * of the meeting in detailed bullet points, distinct from the formal
 * structured Module 8 summary which uses the KEY DECISIONS / ACTION
 * ITEMS / NEXT MEETING headings for archival purposes.
 *
 * The two summary types coexist:
 *   - quickSummary()  → simple bullets, attached to the transcript view
 *   - summarize()     → formal sectioned record, generated on demand
 */
async function quickSummary(transcriptText) {
    const system =
        'You are a Board Secretary assistant for a Philippine state university. ' +
        'Produce a clear, detailed bullet-point summary of the following board meeting ' +
        'transcript. Use 5 to 8 bullet points that capture the main topics discussed, ' +
        'the important points raised by participants, and any decisions or next steps. ' +
        'Each bullet should be a complete sentence and informative on its own — not just ' +
        'a one-or-two-word topic label. Do not use section headings; just bullet points. ' +
        'Do not invent information that is not in the transcript.';
    return generate(system, transcriptText);
}

/**
 * Module 2.4 — one-sentence description of an archived resolution.
 *
 * Used by the Digital Archive upload flow to pre-fill the
 * Description field after OCR. Deliberately constrained to a
 * single short sentence: this text appears in archive listings
 * and search results, not as a full summary.
 *
 * The caller is expected to catch and fall back to the extractive
 * summary in tesseractService when Ollama is not running, so this
 * throwing is not a failure path for the upload itself.
 */
async function describeDocument(ocrText) {
    const excerpt = String(ocrText || '').slice(0, 4000);
    if (!excerpt.trim()) return '';
    return generate(
        'You summarise official board resolutions of a Philippine state college. ' +
        'Reply with ONE plain sentence of at most 30 words describing what the ' +
        'resolution does. No preamble, no quotes, no bullet points.',
        `Resolution text:\n\n${excerpt}\n\nOne-sentence description:`
    );
}

// ── Pre-meeting briefing: one agenda item's document ─────────
//
// Each agenda item is summarised from the full text of its PDF.
// A document that fits in one request is summarised directly. A
// longer one is read in parts: the model first lists the facts in
// each part, then writes the summary from those notes, so no page is
// dropped for lack of room.
//
// Accuracy safeguards:
//   • temperature 0.1 and instructions to use only the given text;
//   • names, dates and figures must be copied exactly;
//   • every number in the result is checked against the document
//     (see checkFigures); if any is not found the model is asked once
//     more, and anything still unmatched is reported to the reader.

const ITEM_PROMPT_VERSION = 'item-v1';
const CHUNK_CHARS = Number(process.env.BRIEFING_CHUNK_CHARS || 12000);
// How a long document is read:
//   fast      (default) the document's key passages are picked out word
//             for word (services/keySentences.js) and the AI reads them
//             in ONE request. About five times fewer AI requests for a
//             35-page document.
//   thorough  the AI reads every part of the document in turn and then
//             writes the summary from its notes: slower, reads everything.
const BRIEFING_MODE = (process.env.BRIEFING_MODE || 'fast').toLowerCase();
const FAST_CHARS = Number(process.env.BRIEFING_FAST_CHARS || 9000);
const keySentences = require('./keySentences');

const ITEM_RULES = [
    'You summarise the supporting document of ONE agenda item for the members of a',
    'governing board of a Philippine state college (CSPC) before their meeting.',
    '',
    'STRICT RULES:',
    '1. Use ONLY the document text given. Do not add background, opinions or advice.',
    '2. Copy names, dates, amounts, percentages and reference numbers exactly as they',
    '   are written in the document. Do not round, convert or recompute them.',
    '3. If the document does not state something, leave it out. Never guess.',
    '4. Scanned pages may contain reading errors; use only what is clearly readable.',
    '5. Plain text only: no markdown, no bold, no headings other than those below,',
    '   and no preamble such as "Here is the summary".',
    '6. The agenda item title is written by the Secretary, not taken from the document.',
    '   Never say the document asks for what the title says unless the document text itself says so.',
].join('\n');

const ITEM_FORMAT = [
    'Write the answer in exactly this format:',
    'SUMMARY: two sentences saying what the document is and, only if the document says so, what it asks for.',
    'KEY POINTS:',
    '- up to five short bullets with the most important facts (figures, dates, offices, conditions)',
    'ACTION REQUESTED: one line with the action the document asks for, in its own words,',
    'or "Not stated in the document."',
].join('\n');

function itemHeader(meta) {
    return [
        `Agenda item ${meta.order} (title written by the Secretary, not part of the document): ${meta.title}`,
        `Category on the agenda: ${meta.category}`,
        `Document: ${meta.fileName || 'attached PDF'} (${meta.pageCount} page${meta.pageCount === 1 ? '' : 's'})`,
    ].join('\n');
}

/** Groups page texts into parts of at most CHUNK_CHARS characters. */
function chunkPages(pages, limit = CHUNK_CHARS) {
    const parts = [];
    let cur = null;
    const push = () => { if (cur && cur.text) parts.push(cur); cur = null; };
    for (const p of pages) {
        const block = `[Page ${p.page}]\n${p.text}\n`;
        if (block.length > limit) {
            // One very long page: split it on line boundaries.
            push();
            let buf = `[Page ${p.page}]\n`;
            for (const line of p.text.split('\n')) {
                if (buf.length + line.length + 1 > limit) {
                    parts.push({ from: p.page, to: p.page, text: buf });
                    buf = `[Page ${p.page}, continued]\n`;
                }
                buf += line + '\n';
            }
            parts.push({ from: p.page, to: p.page, text: buf });
            continue;
        }
        if (cur && cur.text.length + block.length > limit) push();
        if (!cur) cur = { from: p.page, to: p.page, text: '' };
        cur.text += block;
        cur.to = p.page;
    }
    push();
    return parts;
}

/** Numbers in a text, normalised for comparison ("1,200,000" → "1200000"). */
function numbersIn(text) {
    const out = new Set();
    const re = /\d[\d,]*(?:\.\d+)?/g;
    let m;
    while ((m = re.exec(String(text || '')))) {
        const n = m[0].replace(/,/g, '').replace(/\.$/, '');
        // Single digits are too common (list numbers, "one") to check.
        if (n.replace(/\D/g, '').length >= 2) out.add(n);
    }
    return out;
}

/**
 * Figures in the summary that do not appear in the document.
 * Item and page numbers the prompt itself supplied are allowed.
 */
function checkFigures(summary, sourceText, allowed = []) {
    const src = numbersIn(sourceText);
    const ok = new Set(allowed.map(String));
    // Thousands separators removed ("45,000,000" → "45000000"); a number
    // must then appear on its own, not inside a longer one ("250" is not
    // found in "2500"). A comma before a year stays a separator, so
    // "April 17,2026" (as OCR often reads it) still contains "2026".
    const plain = String(sourceText || '').replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
    const standsAlone = n => new RegExp(`(?<![\\d.])${n.replace('.', '\\.')}(?![\\d]|\\.\\d)`).test(plain);
    return [...numbersIn(summary)].filter(n => !src.has(n) && !ok.has(n) && !standsAlone(n));
}

const STOP = new Set(['the', 'of', 'and', 'for', 'a', 'an', 'to', 'in', 'on', 'at', 'by', 'with', 'from', 'new']);
const wordsOf = t => String(t || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w));
const pairsOf = t => { const w = wordsOf(t); return w.slice(1).map((x, i) => `${w[i]} ${x}`); };

/**
 * Removes from the AI's answer what the document does not support:
 *  - a line (or summary sentence) holding a figure not in the document;
 *  - a sentence that repeats the agenda title as the document's request
 *    when the document itself never says it.
 * Returns { summary, unverified, removed }.
 */
function verifyAgainstDocument(text, fullText, meta, allowed = []) {
    const docPairs = new Set(pairsOf(fullText));
    const titlePairs = pairsOf(meta.title);
    const titleInDoc = !titlePairs.length
        || titlePairs.filter(p => docPairs.has(p)).length / titlePairs.length >= 0.5;
    const echoesTitle = sentence => {
        if (titleInDoc || !titlePairs.length) return false;
        const mine = new Set(pairsOf(sentence));
        return titlePairs.filter(p => mine.has(p)).length / titlePairs.length >= 0.6;
    };
    const badFigures = t => checkFigures(t, fullText, allowed);

    let removed = 0;
    const leftover = new Set();
    const out = [];
    for (const line of String(text).split('\n')) {
        const t = line.trim();
        if (/^SUMMARY:/.test(t)) {
            const body = t.replace(/^SUMMARY:\s*/, '');
            const kept = body.split(/(?<=[.!?])\s+/).filter(sn => {
                if (badFigures(sn).length || echoesTitle(sn)) { removed++; return false; }
                return true;
            });
            out.push(`SUMMARY: ${kept.join(' ')}`.trim());
        } else if (/^ACTION REQUESTED:/.test(t)) {
            const body = t.replace(/^ACTION REQUESTED:\s*/, '');
            if (badFigures(body).length || echoesTitle(body)) {
                removed++;
                out.push('ACTION REQUESTED: Not stated in the document.');
            } else out.push(t);
        } else if (/^- /.test(t)) {
            if (badFigures(t).length || echoesTitle(t)) { removed++; continue; }
            out.push(t);
        } else {
            badFigures(t).forEach(n => leftover.add(n));
            out.push(line);
        }
    }
    return { summary: out.join('\n').trim(), unverified: [...leftover], removed };
}

/** Keeps only the expected sections, in order, and tidies bullets. */
function tidyItemSummary(raw) {
    let t = String(raw || '').replace(/\r/g, '').replace(/\*\*/g, '').replace(/^#+\s*/gm, '').trim();
    t = t.replace(/^(here is|here's)[^\n]*\n+/i, '');
    t = t.replace(/^\s*[•*]\s+/gm, '- ');
    t = t.replace(/^\s*(summary|key points|action requested)\s*:/gim, (m, h) => `${h.toUpperCase()}:`);
    return t.trim();
}

async function summarizeItem(meta, pages, { onProgress, signal = null } = {}) {
    const fullText = pages.map(p => `[Page ${p.page}]\n${p.text}`).join('\n');
    const parts = chunkPages(pages);
    const allowed = [meta.order, meta.pageCount, ...pages.map(p => p.page)];
    let material;
    let calls = 0;

    let mode = 'full';
    if (parts.length <= 1) {
        material = `--- DOCUMENT TEXT ---\n${fullText}\n--- END OF DOCUMENT ---`;
    } else if (BRIEFING_MODE !== 'thorough') {
        // One request: the key passages of the whole document, copied
        // exactly, with every page represented.
        const c = keySentences.condense(pages, FAST_CHARS);
        mode = 'fast';
        material = [
            `--- KEY PASSAGES OF THE DOCUMENT (copied word for word; "…" marks passages left out; ` +
                `${c.keptChars} of ${c.totalChars} characters) ---`,
            c.text,
            '--- END OF PASSAGES ---',
        ].join('\n');
    } else {
        mode = 'thorough';
        // Read each part and keep its facts.
        const notes = [];
        for (let i = 0; i < parts.length; i++) {
            if (onProgress) onProgress({ step: 'part', part: i + 1, parts: parts.length });
            const sys = [
                ITEM_RULES,
                '',
                `You are reading part ${i + 1} of ${parts.length} (pages ${parts[i].from}–${parts[i].to}) of the document.`,
                'List the important facts stated in THIS part as short bullets starting with "- ".',
                'Include figures, dates, names, offices, requests and conditions, copied exactly.',
                'Write at most 8 bullets. If the part has nothing important, write "- (no key facts)".',
            ].join('\n');
            const out = await generate(sys, `${itemHeader(meta)}\n\n--- PART ${i + 1} ---\n${parts[i].text}\n--- END OF PART ---`,
                { temperature: 0.1, num_predict: 300 }, signal);
            calls++;
            notes.push(`Pages ${parts[i].from}–${parts[i].to}:\n${tidyItemSummary(out)}`);
        }
        material = `--- NOTES FROM THE WHOLE DOCUMENT, IN PAGE ORDER ---\n${notes.join('\n\n')}\n--- END OF NOTES ---`;
    }

    if (onProgress) onProgress({ step: 'final' });
    const system = `${ITEM_RULES}\n\n${ITEM_FORMAT}`;
    const prompt = `${itemHeader(meta)}\n\n${material}`;
    // A shorter answer is the biggest time saver on a computer without
    // a graphics card: the AI writes only a few words per second there.
    const raw = tidyItemSummary(await generate(system, prompt, { temperature: 0.1, num_predict: 350 }, signal));
    calls++;

    // Check the answer against the document WITHOUT asking the AI again
    // (a second request doubled the waiting time): any line holding a
    // figure that is not in the document, or repeating the agenda title
    // as if the document had asked for it, is removed.
    const cleaned = verifyAgainstDocument(raw, fullText, meta, allowed);
    let summary = cleaned.summary;
    const unverified = cleaned.unverified;
    if (cleaned.removed) {
        console.log(`[briefing] item ${meta.order}: removed ${cleaned.removed} unsupported line(s) from the summary`);
    }
    return { summary, unverified, parts: parts.length, calls, mode };
}

module.exports = {
    summarize, brief, quickSummary, describeDocument,
    summarizeItem, checkFigures, chunkPages, tidyItemSummary, verifyAgainstDocument, health, warmUp, OLLAMA_HOST,
    ITEM_PROMPT_VERSION, OLLAMA_MODEL,
};
