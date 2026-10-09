// ============================================================
// controllers/reviewController.js — reading and commenting on
// an agenda item's PDF, and the Secretary's compiled comments
// ============================================================
//
// Every handler here resolves the meeting AND the agenda item from
// the URL and checks that the item really belongs to that meeting
// before doing anything, then applies the same council scoping as
// the meeting page. A member of one council can therefore never
// read, comment on, or download another body's papers by editing
// an id in the address bar.

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const Meeting = require('../models/Meeting');
const itemPdf = require('../services/itemPdfService');
const itemVideo = require('../services/itemVideoService');
const agendaArchive = require('../services/agendaArchive');
const compile = require('../services/compileService');
const briefingService = require('../services/briefingService');
const { roleLabel } = require('../config/roles');
const { canSeeMeeting, isCommenter, isSecretarial, commentsOpen } = require('../services/access');
const pdfEdit = require('../services/pdfEditService');
const wordEdit = require('../services/wordEditService');
const reanchor = require('../services/reanchorService');
const notify = require('../services/notifyService');
const itemText = require('../services/itemTextService');
const keySentences = require('../services/keySentences');
const llm = require('../services/llmService');

// Quick overviews, remembered per document file (the file name changes
// whenever the document does, so an old overview is never shown).
const overviewCache = new Map();
async function quickOverview(item, mock) {
    if (overviewCache.has(item.item_pdf)) return overviewCache.get(item.item_pdf);
    const text = await itemText.getItemText(item, { mock });
    if (text.pendingPages && text.pendingPages.length) return null;   // scans still being read
    const o = text.chars >= 200 ? keySentences.overview(text.pages) : null;
    const value = o && o.sentences.length ? o : null;
    overviewCache.set(item.item_pdf, value);
    if (overviewCache.size > 100) overviewCache.delete(overviewCache.keys().next().value);
    return value;
}
const meetingController = require('./meetingController');

const MAX_COMMENT_CHARS = 4000;
const MAX_QUOTE_CHARS   = 1000;
const MAX_RECTS         = 60;

const wantsJson = req => req.is('application/json') || /json/.test(req.get('accept') || '');

function deny(req, res, status, message, redirectTo, code) {
    if (wantsJson(req)) return res.status(status).json({ ok: false, error: message });
    // v99: a plain form (the meeting page) is told why, instead of a silent return.
    let to = redirectTo || '/meeting';
    if (code && /^\/meeting\/\d+(#|$)/.test(to)) to = to.replace(/(#|$)/, `?comment_error=${code}$1`);
    return res.redirect(to);
}

/**
 * Loads { meeting, item, mock } for /meeting/:id/item/:itemId/...
 * Falls back to the demo data when the database is unreachable.
 */
async function loadItem(req) {
    const meetingId = parseInt(req.params.id, 10);
    const itemId    = parseInt(req.params.itemId, 10);
    if (!meetingId || !itemId) return null;

    try {
        // A file that is not on this computer is treated as no file.
        const item = require('../services/missingFiles').check(await Meeting.getItem(itemId));
        if (!item || item.meeting_id !== meetingId) return null;
        const meeting = await Meeting.findById(meetingId);
        return meeting ? { meeting, item, mock: false } : null;
    } catch (_err) {
        const { findMockMeeting, MOCK_AGENDA_ITEMS } = meetingController._mock;
        const meeting = findMockMeeting(meetingId);
        const item = (MOCK_AGENDA_ITEMS[meetingId] || []).find(i => i.item_id === itemId);
        return meeting && item ? { meeting, item: { ...item, meeting_id: meetingId }, mock: true } : null;
    }
}

async function loadVisibleItem(req, res) {
    const ctx = await loadItem(req);
    if (!ctx) {
        deny(req, res, 404, 'That agenda item was not found.');
        return null;
    }
    const user = req.session.user;
    // After the meeting its agenda items are in the Digital Archive and
    // CLOSED: only the Office of the Board Secretary opens them, and a
    // member needs the Office's approval for a particular item.
    const closed = ctx.meeting.status === 'Completed' && !isSecretarial(user) && !ctx.mock;
    if (closed || !canSeeMeeting(user, ctx.meeting)) {
        const approved = !ctx.mock && await agendaArchive.hasAccess(user, ctx.item.item_id).catch(() => false);
        if (!approved) {
            const id = ctx.item.item_id;
            deny(req, res, 403, closed
                ? 'This agenda item is closed. Ask the Office of the Board Secretary for permission in the Digital Archive.'
                : 'You do not have access to this meeting.',
                closed ? `/archive/agendas?item=${id}#item-${id}` : '/meeting');
            return null;
        }
        ctx.viaApproval = true;
    }
    return ctx;
}

// ── Comment shape sent to the browser ────────────────────────

function toClient(c, user, meeting) {
    let rects = null;
    if (c.anchor_rects) {
        try { rects = typeof c.anchor_rects === 'string' ? JSON.parse(c.anchor_rects) : c.anchor_rects; }
        catch (_) { rects = null; }
    }
    const mine = !!user && String(c.user_id) === String(user.id);
    const open = (c.status || 'Open') === 'Open';
    return {
        id:        c.comment_id,
        itemId:    c.item_id,
        author:    c.full_name || 'Member',
        roleLabel: roleLabel(c),
        mine,
        phase:     c.comment_phase || 'Pre-Meeting',
        createdAt: c.commented_at ? new Date(c.commented_at).toISOString() : null,
        editedAt:  c.edited_at ? new Date(c.edited_at).toISOString() : null,
        text:      c.comment_text,
        page:      c.page_number || null,
        line:      c.line_number || null,
        anchor:    c.anchor_type && rects ? { type: c.anchor_type, quote: c.anchor_quote || '', rects } : null,
        // The Secretary rewrote the document's words after this comment
        // was made; BOARDLINK put the highlight back, but it is worth a
        // look. Shown as a note on the comment.
        stale:     !!c.anchor_stale && !c.anchor_lost,
        lost:      !!c.anchor_lost,
        quote:     c.anchor_quote || null,
        videoTime: c.video_time != null ? Number(c.video_time) : null,
        status:    c.status || 'Open',
        canEdit:   mine && open && commentsOpen(meeting),
    };
}

async function commentsFor(ctx) {
    if (ctx.mock) {
        const { MOCK_COMMENTS } = meetingController._mock;
        return (MOCK_COMMENTS[ctx.meeting.meeting_id] || []).filter(c => c.item_id === ctx.item.item_id);
    }
    return Meeting.getCommentsForItem(ctx.item.item_id);
}

// ── Anchor validation ────────────────────────────────────────

function cleanAnchor(raw, pageCount) {
    if (!raw) return { anchor: null };
    const type = raw.type;
    if (!['text', 'area'].includes(type)) return { error: 'Unknown comment location.' };

    const page = parseInt(raw.page, 10);
    if (!Number.isFinite(page) || page < 1 || (pageCount && page > pageCount)) {
        return { error: 'That page is not in this document.' };
    }

    if (!Array.isArray(raw.rects) || !raw.rects.length || raw.rects.length > MAX_RECTS) {
        return { error: 'The highlighted area could not be read. Select the text again.' };
    }
    const r4 = v => Math.round(v * 10000) / 10000;
    const rects = [];
    for (const r of raw.rects) {
        if (!Array.isArray(r) || r.length !== 4 || !r.every(v => typeof v === 'number' && Number.isFinite(v))) {
            return { error: 'The highlighted area could not be read. Select the text again.' };
        }
        let [x, y, w, h] = r;
        if (w <= 0 || h <= 0) continue;
        x = Math.max(0, x); y = Math.max(0, y);
        w = Math.min(w, 1 - x); h = Math.min(h, 1 - y);
        if (w <= 0 || h <= 0) continue;
        rects.push([r4(x), r4(y), r4(w), r4(h)]);
    }
    if (!rects.length) return { error: 'The highlighted area is outside the page.' };

    if (type === 'area') {
        const [x, y, w, h] = rects[0];
        if (w < 0.01 || h < 0.005) return { error: 'The marked area is too small. Drag a larger box.' };
        return { anchor: { type, page, quote: null, rects: [[x, y, w, h]] } };
    }

    const quote = String(raw.quote || '').replace(/\s+/g, ' ').trim();
    if (!quote) return { error: 'Select some words on the page first.' };
    return {
        anchor: {
            type, page, rects,
            quote: quote.length > MAX_QUOTE_CHARS ? quote.slice(0, MAX_QUOTE_CHARS - 1) + '…' : quote,
        },
    };
}

// ── Pages ────────────────────────────────────────────────────

exports.showReview = async (req, res) => {
    const ctx = await loadVisibleItem(req, res);
    if (!ctx) return;
    const { meeting, item } = ctx;
    const user = req.session.user;

    let items = [];
    try { items = ctx.mock ? [] : require('../services/missingFiles').checkAll(await Meeting.getAgendaItems(meeting.meeting_id)); }
    catch (_) { items = []; }
    if (ctx.mock) items = meetingController._mock.MOCK_AGENDA_ITEMS[meeting.meeting_id] || [];
    // Someone viewing with the Office's approval sees only this item.
    if (ctx.viaApproval) items = [];
    const idx = items.findIndex(i => i.item_id === item.item_id);
    const withPdf = i => !!(i.item_pdf || i.item_video);
    const prev = items.slice(0, Math.max(idx, 0)).reverse().find(withPdf) || null;
    const next = idx >= 0 ? items.slice(idx + 1).find(withPdf) || null : null;

    // Pre-meeting comment deadline, shown beside the document.
    let deadlineText = null, deadlinePassed = false;
    if (meeting.comment_deadline) {
        const v = meeting.comment_deadline;
        const m = typeof v === 'string' && /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
        const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(v);
        if (!isNaN(d)) {
            const ymd = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
            const today = new Date().toLocaleDateString('en-CA', { timeZone: process.env.APP_TIMEZONE || 'Asia/Manila' });
            deadlineText = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            deadlinePassed = ymd < today;
        }
    }

    let summaryView = null;
    if (item.item_pdf || item.item_video) {
        try { summaryView = await briefingService.itemView(meeting.meeting_id, item, { mock: ctx.mock }); }
        catch (err) { console.warn('[review] summary unavailable:', err.message); }
    }
    // Until there is an AI summary (or when the AI is off), show the
    // document's own key sentences at once.
    let overview = null, aiState = null;
    const hasAiSummary = summaryView && summaryView.entry && summaryView.entry.summary
        && summaryView.entry.summary.status === 'done' && !summaryView.entry.stale;
    if (item.item_pdf && !hasAiSummary) {
        try { overview = await quickOverview(item, ctx.mock); }
        catch (err) { console.warn('[review] quick overview unavailable:', err.message); }
    }
    if ((item.item_pdf || item.item_video) && !hasAiSummary && !ctx.mock) {
        aiState = await llm.health().catch(() => null);
    }

    // A video item (e.g. the President's Report): watched here with its
    // subtitles; comments can point at a moment in it.
    let video = null;
    if (item.item_video) {
        let rows = [];
        try { rows = await commentsFor(ctx); } catch (_) { rows = []; }
        video = {
            kind: item.item_video_kind || 'video',
            hasWords: itemVideo.segmentsOf(item).length > 0,
            comments: rows.map(c => toClient(c, user, meeting)).sort((a, b) =>
                (a.videoTime == null ? 1e9 : a.videoTime) - (b.videoTime == null ? 1e9 : b.videoTime) ||
                String(a.createdAt).localeCompare(String(b.createdAt))),
            clock: itemVideo.clock,
            notice: req.query.video || null,
        };
    }

    // After the Secretary reworded the document, say what became of the
    // comments rather than leaving members to wonder.
    const num = v => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : 0; };
    const reworded = req.query.document === 'reworded'
        ? { moved: num(req.query.moved), check: num(req.query.check), lost: num(req.query.lost) }
        : null;

    res.render('item-review', {
        summaryView,
        overview,
        aiState,
        documentReworded: reworded,
        documentSaved: req.query.document === 'saved',
        deadlineText,
        deadlinePassed,
        active: 'meeting',
        meeting,
        item,
        prevItem: prev,
        nextItem: next,
        hasPdf: !!(item.item_pdf && itemPdf.resolveItemFile(item.item_pdf)),
        video,
        viaApproval: !!ctx.viaApproval,
        approvedUntil: ctx.viaApproval
            ? ((await agendaArchive.accessFor(user, item.item_id).catch(() => ({}))).until || null) : null,
        canComment: isCommenter(user) && commentsOpen(meeting),
        isSecretary: isSecretarial(user),
        frozen: !commentsOpen(meeting),
        userId: user.id,
    });
};

exports.serveFile = async (req, res) => {
    const ctx = await loadVisibleItem(req, res);
    if (!ctx) return;
    const file = itemPdf.resolveItemFile(ctx.item.item_pdf);
    if (!file) return res.status(404).send('This agenda item has no document.');

    const name = ctx.item.item_pdf_name || `item-${ctx.item.item_order || ctx.item.item_id}.pdf`;
    const disposition = req.query.download ? 'attachment' : 'inline';
    const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
    // The address of an item's document never changes, but the file
    // behind it does when the Secretary edits or replaces it. The tag
    // is the stored file, so the browser checks each time and never
    // shows the previous document.
    const etag = `"${ctx.item.item_pdf}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
        `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    fs.createReadStream(file).pipe(res);
};

exports.pageText = async (req, res) => {
    const ctx = await loadVisibleItem(req, res);
    if (!ctx) return;
    const pageNo = parseInt(req.params.page, 10);
    if (!pageNo || pageNo < 1) return res.status(400).json({ ok: false, error: 'Bad page number.' });
    if (ctx.mock) return res.json({ ok: true, page: pageNo, status: 'not_needed', words: null });
    try {
        const row = await Meeting.getPage(ctx.item.item_id, pageNo);
        if (!row) {
            const status = ctx.item.item_pdf_status === 'processing' ? 'pending' : 'failed';
            return res.json({ ok: true, page: pageNo, status, words: null });
        }
        res.json({ ok: true, page: pageNo, status: row.ocr_status, words: row.words || null });
    } catch (err) {
        res.status(500).json({ ok: false, error: 'Could not read the page text.' });
    }
};

// ── Comments (JSON) ──────────────────────────────────────────

exports.listComments = async (req, res) => {
    const ctx = await loadVisibleItem(req, res);
    if (!ctx) return;
    try {
        const rows = await commentsFor(ctx);
        res.json({
            ok: true,
            comments: rows.map(c => toClient(c, req.session.user, ctx.meeting)),
            canComment: isCommenter(req.session.user) && commentsOpen(ctx.meeting),
            // Every agenda item's document can be revised by the
            // Secretary, so any member's comment can be marked done.
            canMarkAddressed: isSecretarial(req.session.user),
            pages: ctx.item.item_pdf_pages || null,
            status: ctx.item.item_pdf_status || null,
        });
    } catch (err) {
        console.error('[review] list comments:', err.message);
        res.status(500).json({ ok: false, error: 'Comments could not be loaded.' });
    }
};

exports.createComment = async (req, res) => {
    if (!req.is('application/json')) {
        return res.status(415).json({ ok: false, error: 'Send the comment as JSON.' });
    }
    const ctx = await loadVisibleItem(req, res);
    if (!ctx) return;
    const user = req.session.user;
    if (!isCommenter(user)) {
        return res.status(403).json({ ok: false, error: 'Only Trustees and council members post comments.' });
    }
    if (!commentsOpen(ctx.meeting)) {
        return res.status(409).json({ ok: false, error: 'This meeting is completed. Comments are closed.' });
    }

    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.status(400).json({ ok: false, error: 'Write a comment first.' });
    if (text.length > MAX_COMMENT_CHARS) {
        return res.status(400).json({ ok: false, error: `Comments are limited to ${MAX_COMMENT_CHARS} characters.` });
    }
    const { anchor, error } = cleanAnchor(req.body.anchor, ctx.item.item_pdf_pages);
    if (error) return res.status(400).json({ ok: false, error });
    if (anchor && !ctx.item.item_pdf) {
        return res.status(400).json({ ok: false, error: 'This item has no document to point to.' });
    }

    if (ctx.mock) {
        return res.status(503).json({ ok: false, error: 'Comments cannot be saved in demo mode (no database).' });
    }

    try {
        const id = await Meeting.addItemComment(ctx.item.item_id, user.id, text, {
            pageNumber:  anchor ? anchor.page : null,
            phase:       ctx.meeting.status === 'In-Session' ? 'In-Session' : 'Pre-Meeting',
            anchorType:  anchor ? anchor.type : null,
            anchorQuote: anchor ? anchor.quote : null,
            anchorRects: anchor ? anchor.rects : null,
        });
        const saved = (await Meeting.getCommentsForItem(ctx.item.item_id)).find(c => c.comment_id === id);
        res.status(201).json({ ok: true, comment: toClient(saved, user, ctx.meeting) });
    } catch (err) {
        console.error('[review] create comment:', err.message);
        res.status(500).json({ ok: false, error: 'The comment could not be saved.' });
    }
};

/**
 * Loads a comment for edit/delete and checks, in order: it exists in
 * this meeting, the user may see the meeting, it is theirs, it is
 * still open, and the meeting still accepts changes.
 */
async function loadOwnComment(req, res) {
    const meetingId = parseInt(req.params.id, 10);
    const commentId = parseInt(req.params.commentId, 10);
    const back = `/meeting/${meetingId}`;
    let c;
    try { c = await Meeting.getComment(commentId); }
    catch (_) {
        deny(req, res, 503, 'Comments cannot be changed in demo mode (no database).', back);
        return null;
    }
    if (!c || c.meeting_id !== meetingId) {
        deny(req, res, 404, 'That comment was not found.', back);
        return null;
    }
    const user = req.session.user;
    const meeting = { meeting_type: c.meeting_type, status: c.meeting_status };
    if (!canSeeMeeting(user, meeting)) {
        deny(req, res, 403, 'You do not have access to this meeting.');
        return null;
    }
    if (String(c.user_id) !== String(user.id)) {
        deny(req, res, 403, 'You can only change your own comments.', back);
        return null;
    }
    if (c.status !== 'Open') {
        deny(req, res, 409, 'The Secretary has already marked this comment done, so it can no longer be changed.', back, 'edit_done');
        return null;
    }
    if (!commentsOpen(meeting)) {
        deny(req, res, 409, 'This meeting is completed. Comments can no longer be changed.', back, 'closed');
        return null;
    }
    let item = null;
    try { item = await Meeting.getItem(c.item_id); } catch (_) { /* mockup */ }
    // From an item's own page (e.g. a video), go back there.
    const own = `/meeting/${meetingId}/item/${c.item_id}/review`;
    if (req.body && req.body.back === own) return { c, meeting, item, back: `${own}#comments` };
    return { c, meeting, item, back: `${back}#item-${c.item_id}` };
}

exports.editComment = async (req, res) => {
    const found = await loadOwnComment(req, res);
    if (!found) return;
    const text = String((req.body && (req.body.text ?? req.body.comment_text)) || '').trim();
    if (!text || text.length > MAX_COMMENT_CHARS) {
        return deny(req, res, 400,
            text ? `Comments are limited to ${MAX_COMMENT_CHARS} characters.` : 'A comment cannot be empty. Use Delete to remove it.',
            found.back, text ? 'edit_long' : 'edit_empty');
    }
    // A comment on a marked area may also be moved or resized. Text
    // highlights keep their place: they belong to the words selected.
    let anchor = null;
    if (req.body && req.body.anchor) {
        if (found.c.anchor_type !== 'area') {
            return deny(req, res, 400, 'Only a marked area can be moved or resized.', found.back);
        }
        const cleaned = cleanAnchor({ ...req.body.anchor, type: 'area' }, found.item ? found.item.item_pdf_pages : null);
        if (cleaned.error) return deny(req, res, 400, cleaned.error, found.back);
        anchor = cleaned.anchor;
    }
    try {
        const ok = await Meeting.updateComment(found.c.comment_id, req.session.user.id, { text, anchor });
        if (!ok) return deny(req, res, 409, 'The comment could not be changed.', found.back, 'edit_failed');
        if (!wantsJson(req)) return res.redirect(found.back);
        const saved = (await Meeting.getCommentsForItem(found.c.item_id)).find(x => x.comment_id === found.c.comment_id);
        res.json({ ok: true, comment: toClient(saved, req.session.user, found.meeting) });
    } catch (err) {
        console.error('[review] edit comment:', err.message);
        deny(req, res, 500, 'The comment could not be changed.', found.back, 'edit_failed');
    }
};

exports.deleteComment = async (req, res) => {
    const found = await loadOwnComment(req, res);
    if (!found) return;
    try {
        const ok = await Meeting.deleteComment(found.c.comment_id, req.session.user.id);
        if (!ok) return deny(req, res, 409, 'The comment could not be deleted.', found.back, 'delete_failed');
        if (!wantsJson(req)) return res.redirect(found.back);
        res.json({ ok: true, id: found.c.comment_id });
    } catch (err) {
        console.error('[review] delete comment:', err.message);
        deny(req, res, 500, 'The comment could not be deleted.', found.back, 'delete_failed');
    }
};

// ── Secretary: attach or replace an item's PDF ───────────────

exports.uploadItemFile = async (req, res) => {
    const back = `/meeting/${req.params.id}#item-${req.params.itemId}`;
    const discard = () => { if (req.file) fs.unlink(req.file.path, () => {}); };
    const ctx = await loadVisibleItem(req, res);
    if (!ctx) return discard();
    if (ctx.mock) { discard(); return res.redirect(back); }
    if (!commentsOpen(ctx.meeting)) {
        discard();
        return res.redirect(`${back.split('#')[0]}?file_error=closed#item-${req.params.itemId}`);
    }
    if (!req.file) return res.redirect(`${back.split('#')[0]}?file_error=pdf#item-${req.params.itemId}`);
    // A PDF, or a Word file (kept for editing, with a PDF made from it).
    const up = await itemPdf.acceptUpload(req.file);
    if (!up.ok) {
        discard();
        const code = ['convert', 'size', 'ffmpeg'].includes(up.reason) ? up.reason : 'pdf';
        return res.redirect(`${back.split('#')[0]}?file_error=${code}#item-${req.params.itemId}`);
    }
    try {
        if (up.video) {
            // A video (e.g. the President's Report) becomes the item's paper.
            await itemVideo.attach(ctx.item.item_id, up);
        } else {
            // The file being replaced is kept as an earlier version, so it
            // is not deleted from disk here.
            await Meeting.setItemPdf(ctx.item.item_id, up.stored, up.name, req.session.user.id, up.docx);
            await itemVideo.clear(ctx.item.item_id);
            itemPdf.processInBackground(ctx.item.item_id, up.stored);
        }
    } catch (err) {
        console.error('[review] upload item file:', err.message);
        itemPdf.discardUpload(up);
    }
    res.redirect(back);
};

// ── Secretary: edit the document's pages ─────────────────────
// Pages can be reordered, turned, removed, and taken from another
// PDF. The words on a page are never rewritten: what the Board read
// must stay as it was. Comments move with their pages.

async function loadEditableDocument(req, res) {
    const ctx = await loadVisibleItem(req, res);
    if (!ctx) return null;
    if (!isSecretarial(req.session.user)) {
        deny(req, res, 403, 'Only the Board Secretary can change a document.', `/meeting/${req.params.id}`);
        return null;
    }
    if (ctx.mock) {
        deny(req, res, 503, 'Documents cannot be changed in demo mode (no database).', `/meeting/${req.params.id}`);
        return null;
    }
    if (!commentsOpen(ctx.meeting)) {
        deny(req, res, 409, 'This meeting is completed, so its documents can no longer be changed.', `/meeting/${req.params.id}`);
        return null;
    }
    if (!ctx.item.item_pdf || !itemPdf.resolveItemFile(ctx.item.item_pdf)) {
        deny(req, res, 404, 'This agenda item has no document to change.', `/meeting/${req.params.id}`);
        return null;
    }
    return ctx;
}

exports.showDocumentEdit = async (req, res) => {
    const ctx = await loadEditableDocument(req, res);
    if (!ctx) return;
    const [comments, versions] = await Promise.all([
        Meeting.getCommentsForItem(ctx.item.item_id),
        Meeting.getFileVersions(ctx.item.item_id).catch(() => []),
    ]);
    // How many comments sit on each page, so the Secretary can see what
    // a page carries before removing it.
    const perPage = {};
    for (const c of comments) {
        if (!c.page_number || c.anchor_lost) continue;
        perPage[c.page_number] = (perPage[c.page_number] || 0) + 1;
    }
    res.render('item-document-edit', {
        active: 'meeting',
        meeting: ctx.meeting,
        item: ctx.item,
        commentsPerPage: perPage,
        versions,
        error: {
            pdf: 'Only PDF or Word (.docx) files can be added.',
            convert: 'That Word file could not be turned into a PDF. Check that it opens in Word, or attach a PDF instead.',
            size: 'That file is larger than the upload limit.',
        }[req.query.file_error] || null,
    });
};

exports.processDocumentEdit = async (req, res) => {
    const files = Array.isArray(req.files) ? req.files : [];
    const discard = () => files.forEach(f => fs.unlink(f.path, () => {}));
    const ctx = await loadEditableDocument(req, res);
    if (!ctx) return discard();
    const { item } = ctx;
    const back = `/meeting/${req.params.id}/item/${item.item_id}/document/edit`;
    const fail = (message) => { discard(); return res.status(400).redirect(`${back}?edit_error=${encodeURIComponent(message)}`); };

    // Pages added from other PDFs arrive as insert_pdf__u0, u1, …
    const uploads = {};
    const uploadPages = {};
    for (const f of files) {
        const m = /^insert_pdf__([A-Za-z0-9]{1,8})$/.exec(f.fieldname);
        if (!m) continue;
        if (!itemPdf.isPdf(f.path)) return fail('One of the files you added is not a PDF.');
        uploads[m[1]] = fs.readFileSync(f.path);
    }

    const current = itemPdf.resolveItemFile(item.item_pdf);
    const currentBytes = fs.readFileSync(current);
    let currentPages = item.item_pdf_pages;
    try {
        const { PDFDocument } = require('pdf-lib');
        const doc = await PDFDocument.load(currentBytes, { ignoreEncryption: true });
        currentPages = doc.getPageCount();
        for (const [key, bytes] of Object.entries(uploads)) {
            uploadPages[key] = (await PDFDocument.load(bytes, { ignoreEncryption: true })).getPageCount();
        }
    } catch (err) {
        return fail('One of the PDFs could not be opened.');
    }

    const { plan, error } = pdfEdit.cleanPlan(req.body.pages, { currentPages, uploadPages });
    if (error) return fail(error);

    let built;
    try {
        built = await pdfEdit.buildEdited(currentBytes, uploads, plan);
    } catch (err) {
        console.error('[document edit] could not build the PDF:', err.message);
        return fail('The edited document could not be built.');
    }

    // Write the new file beside the others, using a multer-style name.
    const stored = crypto.randomBytes(16).toString('hex');
    const dest = path.join(require('../config/paths').UPLOAD_DIR, stored);
    try {
        fs.writeFileSync(dest, built.bytes);
    } catch (err) {
        console.error('[document edit] could not save the file:', err.message);
        return fail('The edited document could not be saved.');
    }

    try {
        const [comments, oldPages] = await Promise.all([
            Meeting.getCommentsForItem(item.item_id),
            Meeting.getPages(item.item_id).catch(() => []),
        ]);
        const moved = pdfEdit.remapComments(comments, built.fromCurrent);
        const keptPages = pdfEdit.remapPages(oldPages, plan);
        const note = pdfEdit.describePlan(plan, currentPages);
        await Meeting.saveEditedItemPdf(item.item_id, {
            stored,
            name: item.item_pdf_name || 'document.pdf',
            pages: built.pageCount,
            version: Number(item.item_pdf_version || 1) + 1,
            note,
            userId: req.session.user.id,
            previous: {
                stored: item.item_pdf, name: item.item_pdf_name,
                pages: item.item_pdf_pages, version: Number(item.item_pdf_version || 1),
                docx: item.item_docx || null,
            },
            // Pages were moved, removed or added, so the Word file no
            // longer matches this PDF: it is kept only with the old version.
            docx: null,
            pageRows: keptPages,
            comments: moved,
        });
        itemPdf.processInBackground(item.item_id, stored, keptPages);
        const lost = moved.filter(m => m.lost).length;
        console.log(`[document edit] item ${item.item_id}: ${note}; ` +
            `${built.pageCount} page(s), ${moved.length - lost} comment(s) moved, ${lost} left without a page`);
        discard();
        res.redirect(`/meeting/${req.params.id}/item/${item.item_id}/review?document=saved`);
    } catch (err) {
        console.error('[document edit] could not record the change:', err.message);
        fs.unlink(dest, () => {});
        return fail('The change could not be recorded.');
    }
};

// ── Secretary: edit the words ────────────────────────────────
// Reordering pages is not enough when a figure or a sentence is
// wrong, so the Secretary can correct the wording itself. Two ways,
// both ending in a new PDF version of the item's document:
//
//   • on the page — BOARDLINK turns the PDF into a Word file behind
//     the scenes, shows its paragraphs for editing with the members'
//     comments beside them, and writes the corrected words back into
//     that same Word file (which is what keeps the layout);
//   • in Microsoft Word — for a heavy rewrite: the Word file is
//     downloaded, edited in Word, and sent back.
//
// Members' comments are never deleted. Each one is put back on the
// words it was made about — see services/reanchorService.js — and
// anything that could not be placed exactly is flagged rather than
// quietly moved.

/** The comments that point into the document, for the side panel. */
function commentsForPanel(comments) {
    return comments
        .filter(c => !c.anchor_lost && (c.page_number || c.anchor_type))
        .map(c => ({
            id: c.comment_id,
            author: c.full_name || 'Member',
            roleLabel: roleLabel(c),
            page: c.page_number || null,
            kind: c.anchor_type || 'text',
            quote: c.anchor_quote || '',
            text: c.comment_text || '',
            stale: !!c.anchor_stale,
        }))
        .sort((a, b) => (a.page || 0) - (b.page || 0) || a.id - b.id);
}

exports.showWordEdit = async (req, res) => {
    const ctx = await loadEditableDocument(req, res);
    if (!ctx) return;
    const [comments, versions, ready] = await Promise.all([
        Meeting.getCommentsForItem(ctx.item.item_id).catch(() => []),
        Meeting.getFileVersions(ctx.item.item_id).catch(() => []),
        wordEdit.readiness(),
    ]);
    // A scan has no words to edit. The Secretary is told before she
    // tries, and pointed at the page editor instead.
    let scanned = false;
    try {
        const pages = await Meeting.getPages(ctx.item.item_id);
        scanned = pages.length > 0 && pages.every(p => !p.has_text);
    } catch (_) { /* no page rows yet */ }

    const panel = commentsForPanel(comments);
    res.render('item-word-edit', {
        active: 'meeting',
        meeting: ctx.meeting,
        item: ctx.item,
        versions,
        ready,
        scanned,
        // Attached as a Word file: its words can be edited exactly.
        hasWord: !!wordEdit.itemDocxPath(ctx.item),
        checked: req.query.checked === '1',
        comments: panel,
        commentCount: panel.length,
        areaCount: panel.filter(c => c.kind === 'area').length,
        error: req.query.word_error ? String(req.query.word_error).slice(0, 400) : null,
    });
};

/**
 * Looks for the two programs again, after somebody has just installed
 * them. Without this, BOARDLINK has to be restarted before it notices,
 * which is a poor thing to discover in the middle of setting up.
 */
exports.recheckWordTools = async (req, res) => {
    const ctx = await loadEditableDocument(req, res);
    if (!ctx) return;
    const ready = await wordEdit.readiness({ recheck: true });
    console.log(`[word edit] checked again: ${ready.ok ? 'ready' : ready.missing.join(' and ') + ' still missing'}`);
    const back = `/meeting/${req.params.id}/item/${ctx.item.item_id}/document/words`;
    res.redirect(ready.ok ? back : `${back}?checked=1`);
};

/**
 * The document's paragraphs, for the editor on the page. Converting
 * happens here rather than while the page loads, so the Secretary sees
 * the page at once and is told what is going on.
 */
exports.wordBlocks = async (req, res) => {
    const ctx = await loadEditableDocument(req, res);
    if (!ctx) return;
    const { item } = ctx;
    const file = itemPdf.resolveItemFile(item.item_pdf);
    if (!file) return res.status(404).json({ error: 'This agenda item has no document.' });

    const version = Number(item.item_pdf_version || 1);
    // Only a document attached as a Word file can be edited word for
    // word; turning a PDF back into Word does not keep its layout.
    const docxPath = wordEdit.itemDocxPath(item);
    if (!docxPath) return res.status(409).json({ error: wordEdit.NEEDS_WORD, needsWord: true });
    const read = await wordEdit.readBlocks(docxPath);
    if (!read.ok) return res.status(503).json({ error: read.message });

    // Say which paragraph each comment's words are in, so the Secretary
    // can see what she is about to change before she changes it.
    const comments = commentsForPanel(await Meeting.getCommentsForItem(item.item_id).catch(() => []));
    const normalised = read.blocks.map(b => ({ id: b.id, text: reanchor.norm(b.text).toLowerCase() }));
    for (const c of comments) {
        c.blockId = null;
        if (c.kind !== 'text' || !c.quote) continue;
        const needle = reanchor.norm(c.quote).toLowerCase();
        if (needle.length < 4) continue;
        const hit = normalised.find(b => b.text.includes(needle))
            // A quote running across two paragraphs: match on its start.
            || normalised.find(b => needle.length > 24 && b.text.includes(needle.slice(0, 24)));
        if (hit) c.blockId = hit.id;
    }

    res.json({ version, blocks: read.blocks, comments });
};

/** The item's document as a Word file, for editing (Secretary only). */
exports.downloadWord = async (req, res) => {
    const ctx = await loadEditableDocument(req, res);
    if (!ctx) return;
    const back = `/meeting/${req.params.id}/item/${ctx.item.item_id}/document/words`;
    const docxPath = wordEdit.itemDocxPath(ctx.item);
    if (!docxPath) return res.redirect(`${back}?word_error=${encodeURIComponent(wordEdit.NEEDS_WORD)}`);
    const name = wordEdit.wordNameFor(ctx.item.item_pdf_name).replace(/[^\x20-\x7E]/g, '_');
    res.setHeader('Content-Type', wordEdit.DOCX_TYPE);
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    fs.createReadStream(docxPath).on('error', () => res.destroy()).pipe(res);
};

/**
 * The corrected wording becomes the item's new PDF version.
 *
 * Two shapes arrive here:
 *   • { edits: [{ id, text }] } as JSON — the editor on the page. The
 *     words are written into the Word copy BOARDLINK already made, so
 *     only the edited paragraphs change and the layout stays put.
 *   • a `word_file` upload — a document edited in Microsoft Word.
 */
exports.processWordEdit = async (req, res) => {
    const files = Array.isArray(req.files) ? req.files
        : (req.file ? [req.file] : []);
    let keepUpload = null;                       // an attached Word file that becomes the new Word copy
    let newDocx = null;                          // stored name of the Word file behind the new PDF
    const discard = () => files.forEach(f => { if (f !== keepUpload) fs.unlink(f.path, () => {}); });
    const asJson = wantsJson(req) || Array.isArray(req.body && req.body.edits);
    const ctx = await loadEditableDocument(req, res);
    if (!ctx) return discard();
    const { item } = ctx;
    const back = `/meeting/${req.params.id}/item/${item.item_id}/document/words`;
    const fail = (message, extra = {}) => {
        // Nothing new is kept when the change is not saved.
        if (newDocx && !keepUpload) fs.unlink(path.join(require('../config/paths').UPLOAD_DIR, newDocx), () => {});
        keepUpload = null;
        discard();
        if (asJson) return res.status(400).json({ error: message, ...extra });
        return res.status(400).redirect(`${back}?word_error=${encodeURIComponent(message)}`);
    };

    // ── the editor on the page ───────────────────────────────
    let made;
    if (asJson) {
        const { edits, error } = wordEdit.cleanEdits(req.body && req.body.edits);
        if (error) return fail(error);

        const file = itemPdf.resolveItemFile(item.item_pdf);
        if (!file) return fail('This agenda item has no document.');
        const version = Number(item.item_pdf_version || 1);
        // The version the editor was opened on must still be the current
        // one, or the paragraphs it edited are not the ones on file.
        const sentVersion = Number(req.body && req.body.version);
        if (Number.isFinite(sentVersion) && sentVersion !== version) {
            return fail('This document was changed by someone else while you were editing. '
                + 'Open it again so you are working on the latest version.', { stale: true });
        }
        const sourceDocx = wordEdit.itemDocxPath(item);
        if (!sourceDocx) return fail(wordEdit.NEEDS_WORD, { needsWord: true });

        // The edited paragraphs are written into a copy of the Word file;
        // everything else in it stays exactly as it was.
        const written = await wordEdit.writeBlocks(sourceDocx, edits);
        if (!written.ok) return fail(written.message, written.stale ? { stale: true } : {});
        made = await wordEdit.wordToPdf(written.path);
        if (!made.ok) { wordEdit.removeDir(written.dir); return fail(made.message); }
        // Keep the edited Word file: the next edit starts from it.
        newDocx = crypto.randomBytes(16).toString('hex');
        try {
            fs.copyFileSync(written.path, path.join(require('../config/paths').UPLOAD_DIR, newDocx));
        } catch (err) {
            wordEdit.removeDir(written.dir); wordEdit.removeDir(made.dir);
            return fail('The edited Word file could not be saved.');
        }
        wordEdit.removeDir(written.dir);
    } else {
        // ── a document edited in Microsoft Word ─────────────
        const sent = files.find(f => f.fieldname === 'word_file');
        if (!sent) return fail('Choose the edited Word file first.');
        if (!wordEdit.isDocx(sent.path)) {
            return fail('That is not a Word file. Save it from Word as .docx and try again.');
        }
        // LibreOffice goes by the extension; multer stores none.
        const named = path.join(wordEdit.tempDir(), 'document.docx');
        fs.copyFileSync(sent.path, named);
        made = await wordEdit.wordToPdf(named);
        wordEdit.removeDir(path.dirname(named));
        if (!made.ok) return fail(made.message);
        // The attached Word file becomes this item's Word copy, so later
        // corrections can be made on the page.
        keepUpload = sent;
        newDocx = sent.filename;
    }

    let pageCount = 0;
    try {
        if (!itemPdf.isPdf(made.path)) throw new Error('not a pdf');
        pageCount = (await itemPdf.scanPages(made.path)).length;
        if (!pageCount) throw new Error('no pages');
    } catch (err) {
        wordEdit.removeDir(made.dir);
        return fail('The PDF made from that Word file could not be opened.');
    }

    // Keep the new PDF beside the others, under a multer-style name.
    const stored = crypto.randomBytes(16).toString('hex');
    const dest = path.join(require('../config/paths').UPLOAD_DIR, stored);
    try {
        fs.copyFileSync(made.path, dest);
    } catch (err) {
        wordEdit.removeDir(made.dir);
        console.error('[word edit] could not save the file:', err.message);
        return fail('The new document could not be saved.');
    }
    wordEdit.removeDir(made.dir);

    try {
        const comments = await Meeting.getCommentsForItem(item.item_id);
        // The old PDF is read too: comments on unchanged pages stay put,
        // and the words around each highlight help find it again.
        const remap = await reanchor.remapForNewText(comments, dest,
            { oldPdfPath: itemPdf.resolveItemFile(item.item_pdf) });
        const how = asJson ? 'reworded in BOARDLINK' : 'reworded in Word';
        const note = `${how} — ${reanchor.describeRemap(remap)}`;
        await Meeting.saveEditedItemPdf(item.item_id, {
            stored,
            name: item.item_pdf_name || 'document.pdf',
            pages: pageCount,
            version: Number(item.item_pdf_version || 1) + 1,
            note,
            userId: req.session.user.id,
            previous: {
                stored: item.item_pdf, name: item.item_pdf_name,
                pages: item.item_pdf_pages, version: Number(item.item_pdf_version || 1),
                docx: item.item_docx || null,
            },
            docx: newDocx,
            // Every page's words changed, so none of the old page text is
            // reused: the new document is read again from the start.
            pageRows: new Map(),
            comments: remap.changes,
        });
        itemPdf.processInBackground(item.item_id, stored);

        // Changing the words never marks a comment done or tells the
        // member anything: the Secretary presses Done herself when she is
        // ready (meetingController.processMarkAddressed).
        console.log(`[word edit] item ${item.item_id}: ${pageCount} page(s); ${note}`);
        discard();
        const q = new URLSearchParams({
            document: 'reworded',
            moved: String(remap.found),
            check: String(remap.partial + remap.marked),
            lost:  String(remap.lost),
        });
        const to = `/meeting/${req.params.id}/item/${item.item_id}/review?${q}`;
        if (asJson) return res.json({ ok: true, to });
        res.redirect(to);
    } catch (err) {
        console.error('[word edit] could not record the change:', err.message);
        fs.unlink(dest, () => {});
        return fail('The change could not be recorded.');
    }
};

/** An earlier version of the document (Secretary only). */
exports.downloadVersion = async (req, res) => {
    const ctx = await loadVisibleItem(req, res);
    if (!ctx) return;
    if (!isSecretarial(req.session.user)) return res.redirect(`/meeting/${req.params.id}`);
    let row = null;
    try { row = await Meeting.getFileVersion(ctx.item.item_id, parseInt(req.params.version, 10)); }
    catch (_) { /* no database */ }
    const file = row && itemPdf.resolveItemFile(row.item_pdf);
    if (!file) return res.status(404).send('That version is no longer available.');
    const name = `v${row.version} ${row.item_pdf_name || 'document.pdf'}`.replace(/[^\x20-\x7E]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'private, max-age=60');
    fs.createReadStream(file).pipe(res);
};

// ── Secretary: compiled comments ─────────────────────────────

async function compileData(req) {
    const meetingId = parseInt(req.params.id, 10);
    try {
        const meeting = await Meeting.findById(meetingId);
        if (!meeting) return null;
        const [items, comments] = await Promise.all([
            Meeting.getAgendaItems(meetingId),
            Meeting.getCommentsForMeeting(meetingId),
        ]);
        return { meeting, items, comments };
    } catch (_err) {
        const { findMockMeeting, MOCK_AGENDA_ITEMS, MOCK_COMMENTS } = meetingController._mock;
        const meeting = findMockMeeting(meetingId);
        if (!meeting) return null;
        return {
            meeting,
            items: MOCK_AGENDA_ITEMS[meetingId] || [],
            comments: (MOCK_COMMENTS[meetingId] || []).map(c => ({ comment_id: c.comment_id, ...c })),
        };
    }
}

function sendCompiled(format) {
    return async (req, res) => {
        const data = await compileData(req);
        if (!data) return res.status(404).send('Meeting not found');
        if (!canSeeMeeting(req.session.user, data.meeting)) return res.redirect('/meeting');
        const groups = compile.groupComments(data.items, data.comments);
        const args = { meeting: data.meeting, groups, compiledBy: req.session.user.fullName || 'Board Secretary' };
        try {
            const buf = format === 'docx' ? await compile.buildDocx(args) : await compile.buildPdf(args);
            const name = `${compile.safeName(data.meeting)}_Compiled_Comments.${format}`;
            res.setHeader('Content-Type', format === 'docx'
                ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                : 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
            res.setHeader('Cache-Control', 'no-store');
            res.send(buf);
        } catch (err) {
            console.error(`[compile ${format}]`, err);
            res.status(500).send('The compiled comments could not be generated.');
        }
    };
}

exports.compileDocx = sendCompiled('docx');
exports.compilePdf  = sendCompiled('pdf');
exports._cleanAnchor = cleanAnchor;

// ── Video agenda items ───────────────────────────────────────
// An item whose paper is a video (e.g. the CSPC President's Report).

async function loadVideoItem(req, res) {
    const ctx = await loadVisibleItem(req, res);
    if (!ctx) return null;
    const file = itemVideo.filePath(ctx.item.item_video);
    if (!file) { res.status(404).send('This agenda item has no video.'); return null; }
    return { ...ctx, file };
}

exports.serveVideo = async (req, res) => {
    const ctx = await loadVideoItem(req, res);
    if (!ctx) return;
    const name = ctx.item.item_video_name || `item-${ctx.item.item_order}.mp4`;
    if (req.query.download) {
        const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
        res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    }
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // sendFile answers the player's Range requests, so members can jump around.
    res.sendFile(ctx.file);
};

exports.videoCaptions = async (req, res) => {
    const ctx = await loadVisibleItem(req, res);
    if (!ctx) return;
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-cache');
    res.send(itemVideo.toVtt(itemVideo.segmentsOf(ctx.item)));
};

exports.videoTranscript = async (req, res) => {
    const ctx = await loadVisibleItem(req, res);
    if (!ctx) return;
    const lines = itemVideo.segmentsOf(ctx.item).map(s => `[${itemVideo.clock(s.start)}] ${s.text}`);
    const base = String(ctx.item.item_video_name || `item-${ctx.item.item_order}`).replace(/\.[a-z0-9]{2,5}$/i, '');
    const name = `${base} - words.txt`;
    const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.send(`${ctx.item.item_order}. ${ctx.item.item_title}\r\n${ctx.meeting.title}\r\n\r\n` +
             (lines.length ? lines.join('\r\n') : (ctx.item.item_video_text || '')) + '\r\n');
};

exports.videoStatus = async (req, res) => {
    const ctx = await loadVisibleItem(req, res);
    if (!ctx) return;
    res.json({ ok: true, status: ctx.item.item_video_status || null, step: ctx.item.item_video_step || null });
};

exports.videoRetry = async (req, res) => {
    const ctx = await loadVisibleItem(req, res);
    if (!ctx) return;
    await itemVideo.retry(ctx.item.item_id).catch(() => false);
    res.redirect(`/meeting/${ctx.meeting.meeting_id}/item/${ctx.item.item_id}/review`);
};

/** A comment on a video item, optionally at a moment in the video. */
exports.createVideoComment = async (req, res) => {
    const ctx = await loadVisibleItem(req, res);
    if (!ctx) return;
    const page = `/meeting/${ctx.meeting.meeting_id}/item/${ctx.item.item_id}/review`;
    const user = req.session.user;
    if (!isCommenter(user) || !commentsOpen(ctx.meeting) || ctx.mock) return res.redirect(page);
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.redirect(`${page}?video=empty#comments`);
    if (text.length > MAX_COMMENT_CHARS) return res.redirect(`${page}?video=long#comments`);
    let at = null;
    if (req.body.use_time) {
        const t = Number(req.body.video_time);
        const dur = Number(ctx.item.item_video_duration) || Infinity;
        if (Number.isFinite(t) && t >= 0) at = Math.round(Math.min(t, dur) * 100) / 100;
    }
    try {
        const id = await Meeting.addItemComment(ctx.item.item_id, user.id, text, {
            phase: ctx.meeting.status === 'In-Session' ? 'In-Session' : 'Pre-Meeting',
            videoTime: at,
        });
        res.redirect(`${page}#comment-${id}`);
    } catch (err) {
        console.error('[review] video comment:', err.message);
        res.redirect(`${page}?video=failed#comments`);
    }
};
