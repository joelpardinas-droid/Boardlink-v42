// ============================================================
// services/briefingService.js — the pre-meeting briefing
// ============================================================
//
// The briefing summarises EVERY agenda item from the full text of its
// PDF (see itemTextService and llmService.summarizeItem). On the
// college's hardware a local model needs about a minute or more per
// item, so the work runs in the background: the page shows progress
// and fills in when done.
//
//   • One briefing job runs at a time (the model uses the CPU fully);
//     other meetings wait in a queue.
//   • Anyone who can see the meeting — the Secretary, Trustees and
//     council members — can summarise all items or pick the ones they
//     want. "Summarise all" skips items that are unchanged since their
//     last summary; items picked by hand are always written afresh.
//   • Items requested while a briefing is already running are added
//     to that briefing instead of being turned away.
//   • An item whose scanned pages are still being read waits for that
//     reading to finish, so no page is left out.

const crypto = require('crypto');
const Meeting = require('../models/Meeting');
const llm = require('./llmService');
const itemText = require('./itemTextService');
const itemPdf = require('./itemPdfService');

const WAIT_FOR_OCR_MS = Number(process.env.BRIEFING_WAIT_OCR_MS || 20 * 60 * 1000);
const MIN_CHARS = 40;

const jobs = new Map();          // meetingId → job
const mockStore = new Map();     // meetingId → Map(itemId → summary) when no database
let chain = Promise.resolve();
let queued = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// An item's paper is its PDF, or a VIDEO (summarised from its words).
const docKey = item => (item && (item.item_pdf || item.item_video)) || null;

function snapshot(job) {
    if (!job) return null;
    return {
        state: job.state,
        startedBy: job.userId || null,
        total: job.items.length,
        done: job.done,
        current: job.current,
        // Items still to be done in this run, for "Queued" labels.
        pendingIds: job.items.slice(job.done).map(i => i.item_id),
        error: job.error,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        reused: job.reused,
        summarised: job.summarised,
        failedItems: job.failedItems,
    };
}

function status(meetingId) {
    return snapshot(jobs.get(String(meetingId)));
}

function isActive(meetingId) {
    const j = jobs.get(String(meetingId));
    return !!j && (j.state === 'queued' || j.state === 'running');
}

async function waitUntilReadable(item, job) {
    const started = Date.now();
    for (;;) {
        if (job.cancelled) return null;
        const fresh = await Meeting.getItem(item.item_id);
        if (!fresh || docKey(fresh) !== docKey(item)) return fresh;         // replaced meanwhile
        if (fresh.item_video) {
            // A video: wait until its words have been written down.
            if (fresh.item_video_status !== 'processing') return fresh;
            if (Date.now() - started > WAIT_FOR_OCR_MS) return fresh;
            job.current = { ...job.current, step: 'Waiting for the video\'s words to be written down' };
            await sleep(3000);
            continue;
        }
        const pages = await Meeting.getPageSummary(item.item_id);
        if (fresh.item_pdf_status !== 'processing' && !pages.pending) return fresh;
        if (Date.now() - started > WAIT_FOR_OCR_MS) return fresh;
        itemPdf.processInBackground(item.item_id, item.item_pdf);           // make sure it is queued
        job.current = { ...job.current, step: 'Waiting for scanned pages to be read' };
        await sleep(3000);
    }
}

function sourceHash(item, text) {
    return crypto.createHash('sha256').update(JSON.stringify({
        v: llm.ITEM_PROMPT_VERSION, model: llm.OLLAMA_MODEL,
        title: item.item_title, category: item.item_category,
        pages: text.pages.map(p => [p.page, p.text]),
    })).digest('hex');
}

async function saveSummary(job, item, s) {
    if (job.mock) {
        if (!mockStore.has(job.meetingId)) mockStore.set(job.meetingId, new Map());
        mockStore.get(job.meetingId).set(item.item_id, {
            item_id: item.item_id, item_pdf: s.itemPdf, item_title: s.itemTitle, item_category: s.itemCategory,
            source_hash: s.sourceHash, status: s.status,
            summary_text: s.summary || null, unverified: s.unverified || [], pages_read: s.pagesRead,
            ocr_pages: s.ocrPages, chars_read: s.charsRead, model: s.model, error_text: s.error || null,
            generated_at: new Date(),
        });
        return;
    }
    await Meeting.saveItemSummary(item.item_id, s);
}

async function existingSummaries(job) {
    if (job.mock) return [...(mockStore.get(job.meetingId) || new Map()).values()];
    return Meeting.getItemSummaries(job.meetingId);
}

async function runJob(job) {
    if (job.cancelled) return;                 // cancelled while waiting its turn
    job.state = 'running';
    job.startedAt = new Date();
    const previous = new Map((await existingSummaries(job).catch(() => [])).map(r => [r.item_id, r]));
    let modelDown = null;
    // Ask the local AI whether it is ready BEFORE preparing any document,
    // so a stopped Ollama is reported in seconds, not after a long wait.
    if (!job.mock) {
        const h = await llm.health({ fresh: true });
        if (!h.ok) modelDown = h.message;
    }

    // job.items can grow while this runs (see start()), so walk it by index.
    for (let idx = 0; idx < job.items.length; idx++) {
        if (job.cancelled) break;
        let item = job.items[idx];
        const at = (step) => ({ index: idx + 1, order: item.item_order, title: item.item_title, step });
        job.current = at('Reading the document');
        const base = {
            itemPdf: docKey(item), model: llm.OLLAMA_MODEL,
            itemTitle: item.item_title, itemCategory: item.item_category,
        };
        try {
            if (modelDown && docKey(item)) {
                job.failedItems++;
                const prev = previous.get(item.item_id);
                // Keep a good earlier summary rather than replacing it with a failure.
                if (!(prev && prev.status === 'done')) {
                    await saveSummary(job, item, { ...base, status: 'failed', error: modelDown });
                }
                continue;
            }
            if (!docKey(item)) {
                await saveSummary(job, item, { ...base, status: 'no_file' });
                continue;
            }
            if (!job.mock) item = (await waitUntilReadable(item, job)) || item;
            if (job.cancelled) break;
            job.current = at('Reading the document');

            const text = await itemText.getItemText(item, { mock: job.mock });
            const counts = {
                pagesRead: text.pages.length,
                ocrPages: text.pages.filter(p => p.source === 'ocr').length,
                charsRead: text.chars,
            };
            if (text.chars < MIN_CHARS) {
                await saveSummary(job, item, {
                    ...base, ...counts, status: 'no_text',
                    error: item.item_video
                        ? (text.pendingPages.length ? 'The video\'s words were still being written down.' : 'No speech was found in this video.')
                        : text.pendingPages.length
                        ? 'Scanned pages were still being read.'
                        : 'No readable text was found in this PDF.',
                });
                continue;
            }

            const hash = sourceHash(item, text);
            const prev = previous.get(item.item_id);
            if (!job.forceIds.has(item.item_id) && prev && prev.status === 'done' && prev.source_hash === hash) {
                job.reused++;
                continue;
            }
            if (modelDown) {
                job.failedItems++;
                // Keep a good earlier summary rather than replacing it
                // with a failure.
                if (!(prev && prev.status === 'done')) {
                    await saveSummary(job, item, { ...base, ...counts, sourceHash: null, status: 'failed', error: modelDown });
                }
                continue;
            }

            job.current = at('Summarising');
            const itemStarted = Date.now();
            const result = await llm.summarizeItem({
                order: item.item_order, title: item.item_title, category: item.item_category,
                fileName: item.item_video ? `${item.item_video_name || 'video'} (what was said in the video)` : item.item_pdf_name,
                pageCount: text.pageCount,
            }, text.pages, {
                signal: job.abort.signal,
                onProgress: p => {
                    job.current = at(p.step === 'part' ? `Reading part ${p.part} of ${p.parts}` : 'Writing the summary');
                },
            });
            if (!result.summary || result.summary.length < 20) throw new Error('The model returned an empty summary.');
            await saveSummary(job, item, {
                ...base, ...counts, sourceHash: hash, status: 'done',
                summary: result.summary, unverified: result.unverified,
            });
            job.summarised++;
            console.log(`[briefing] meeting ${job.meetingId} item ${item.item_order}: ` +
                `${counts.pagesRead} page(s), ${result.mode} mode, ${result.calls} AI call(s), ` +
                `${Math.round((Date.now() - itemStarted) / 1000)}s` +
                (result.unverified.length ? `, unverified figures: ${result.unverified.join(', ')}` : ''));
        } catch (err) {
            // Cancelled: the item being summarised keeps its earlier summary.
            if (err.cancelled || job.cancelled) break;
            console.error(`[briefing] meeting ${job.meetingId} item ${item.item_order} failed:`, err.message);
            job.failedItems++;
            // When the model itself is unreachable, stop calling it for
            // the remaining items instead of waiting on each in turn.
            if (/not reachable|did not answer/i.test(err.message)) modelDown = err.message;
            const prev = previous.get(item.item_id);
            if (!(prev && prev.status === 'done')) {
                try {
                    await saveSummary(job, item, { ...base, status: 'failed', error: err.message });
                } catch (_) { /* nothing more to do */ }
            }
        } finally {
            if (!job.cancelled) job.done++;
        }
    }

    job.current = null;
    if (job.cancelled) {
        job.state = 'cancelled';
        job.finishedAt = new Date();
        console.log(`[briefing] meeting ${job.meetingId}: cancelled after ${job.summarised} item(s)`);
        return;
    }
    if (!job.mock) {
        try {
            await Meeting.saveBriefing(job.meetingId, `Per-item briefing (${job.items.length} item(s) this run)`,
                null, job.userId);
        } catch (err) {
            console.warn('[briefing] could not record the briefing:', err.message);
        }
    } else {
        mockStore.get(job.meetingId) || mockStore.set(job.meetingId, new Map());
    }
    // Failed when the model could not be used at all this time;
    // otherwise done, with any model problem still reported.
    job.state = modelDown && job.summarised === 0 ? 'failed' : 'done';
    job.error = modelDown;
    job.finishedAt = new Date();
}

/**
 * Starts the briefing for a meeting, or adds to the one running.
 *   items    — the agenda items to summarise, in agenda order
 *   forceIds — ids of items to write afresh even if unchanged
 * Returns the job status.
 */
function start({ meetingId, items, userId, forceIds = [], mock = false }) {
    const key = String(meetingId);
    const sorted = [...items].sort((a, b) => a.item_order - b.item_order);
    const running = jobs.get(key);
    if (running && !running.cancelled && (running.state === 'queued' || running.state === 'running')) {
        // Add what is not already waiting in this run.
        const waiting = new Set(running.items.slice(running.done).map(i => i.item_id));
        for (const it of sorted) {
            if (waiting.has(it.item_id)) {
                if (forceIds.includes(it.item_id)) running.forceIds.add(it.item_id);
                continue;
            }
            running.items.push(it);
            if (forceIds.includes(it.item_id)) running.forceIds.add(it.item_id);
        }
        return { ...status(key), joined: true };
    }
    const job = {
        meetingId: key, items: sorted, userId, mock,
        abort: new AbortController(), cancelled: false,
        forceIds: new Set(forceIds),
        state: 'queued', done: 0, reused: 0, failedItems: 0, summarised: 0,
        current: null, error: null, startedAt: null, finishedAt: null,
    };
    jobs.set(key, job);
    queued++;
    chain = chain
        .then(() => runJob(job))
        .catch(err => {
            console.error(`[briefing] meeting ${key} stopped:`, err);
            job.state = 'failed';
            job.error = err.message;
            job.finishedAt = new Date();
        })
        .finally(() => { queued--; });
    return status(key);
}

/**
 * Stops the briefing of a meeting: items not reached are left as they
 * were, and the item being summarised keeps its earlier summary.
 * Returns false when nothing was running.
 */
function cancel(meetingId) {
    const job = jobs.get(String(meetingId));
    if (!job || !['queued', 'running'].includes(job.state)) return false;
    job.cancelled = true;
    job.abort.abort();
    if (job.state === 'queued') { job.state = 'cancelled'; job.finishedAt = new Date(); }
    return true;
}

/** Who started the running briefing (null when it started by itself). */
function startedBy(meetingId) {
    const job = jobs.get(String(meetingId));
    return job ? job.userId || null : null;
}

/** Everything the meeting page needs to show the briefing. */
async function viewData(meetingId, items, { mock = false } = {}) {
    const key = String(meetingId);
    let rows = [];
    if (mock) {
        const store = mockStore.get(key);
        rows = store ? [...store.values()] : [];
    } else {
        rows = await Meeting.getItemSummaries(key);
    }
    const byItem = new Map(rows.map(r => [r.item_id, r]));
    const job = status(key);
    const pending = new Set(job && ['queued', 'running'].includes(job.state) ? job.pendingIds : []);
    const entries = [...items].sort((a, b) => a.item_order - b.item_order).map(item => {
        const s = byItem.get(item.item_id) || null;
        // Out of date: written from another file, or before the item
        // was renamed or re-categorised.
        const stale = !!s && s.status !== 'no_file' && (
            (s.item_pdf || null) !== docKey(item) ||
            (s.item_title != null && (s.item_title !== item.item_title || s.item_category !== item.item_category))
        );
        return { item, summary: s, stale, queued: pending.has(item.item_id) };
    });
    const dates = rows.filter(r => r.status === 'done').map(r => new Date(r.generated_at)).filter(d => !isNaN(d));
    return {
        entries,
        hasAny: entries.some(e => e.summary && e.summary.status === 'done'),
        meta: dates.length ? {
            generatedAt: new Date(Math.max(...dates)),
            stale: entries.some(e => e.stale),
        } : null,
        job,
    };
}

/** The summary of one item, for the document review page. */
async function itemView(meetingId, item, { mock = false } = {}) {
    const data = await viewData(meetingId, [item], { mock });
    return { entry: data.entries[0], job: data.job };
}

/**
 * Called when an agenda item's document has finished being read after
 * an upload: writes its summary straight away, so it is ready when
 * members open the item. Does nothing when the local AI is not running
 * (the Secretary can still ask for it later), or when AUTO_SUMMARY=0.
 */
async function autoSummarize(itemId) {
    if (String(process.env.AUTO_SUMMARY || '1') === '0') return;
    try {
        const h = await llm.health();
        if (!h.ok) return;
        const item = await Meeting.getItem(itemId);
        if (!item || !docKey(item)) return;
        start({ meetingId: item.meeting_id, items: [item], userId: null });
        console.log(`[briefing] item ${itemId}: summarising in the background after upload`);
    } catch (err) {
        console.warn(`[briefing] could not start the summary of item ${itemId}:`, err.message);
    }
}

function drain() { return chain; }

module.exports = { start, cancel, startedBy, status, isActive, viewData, itemView, drain, autoSummarize, docKey };
