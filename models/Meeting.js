// ============================================================
// models/Meeting.js — Meeting Model (full workflow)
//
// The Meeting record is the spine of Modules 5-8. Council meetings
// (Administrative, Academic, RIC) and Board of Trustees meetings
// each own their own agenda. Drafting minutes and consolidating
// comments happen outside BOARDLINK.
// ============================================================

const pool = require('../config/db');

async function findAll() {
    const [rows] = await pool.query(
        `SELECT m.meeting_id, m.title, m.meeting_type, m.meeting_number,
                m.meeting_date, m.meeting_time, m.venue, m.mode, m.status,
                m.quorum_required,
                u.full_name AS called_by_name
           FROM meetings m
      LEFT JOIN users u ON u.user_id = m.called_by_user_id
          ORDER BY m.meeting_date DESC, m.meeting_time DESC`
    );
    return rows;
}

async function findById(id) {
    const [rows] = await pool.query(
        `SELECT m.*,
                cu.full_name AS called_by_name,
                pu.full_name AS presided_by_name
           FROM meetings m
      LEFT JOIN users cu              ON cu.user_id = m.called_by_user_id
      LEFT JOIN users pu              ON pu.user_id = m.presided_by_user_id
          WHERE m.meeting_id = ?
          LIMIT 1`,
        [id]
    );
    return rows[0] || null;
}

async function create(data) {
    const [r] = await pool.query(
        `INSERT INTO meetings
            (title, meeting_type, meeting_number, meeting_date, meeting_time,
             venue, mode, called_by_user_id, presided_by_user_id, quorum_required,
             notes_for_members, comment_deadline,
             status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Distributed', ?, NOW())`,
        [
            data.title, data.meeting_type, data.meeting_number,
            data.meeting_date, data.meeting_time, data.venue,
            data.mode || 'In-Person',
            data.called_by_user_id || null,
            data.presided_by_user_id || null,
            data.quorum_required || 13,
            data.notes_for_members || null,
            data.comment_deadline || null,
            data.created_by || null,
        ]
    );
    return r.insertId;
}

// ── Editing and deleting a meeting (Board Secretary) ─────────

/** Counts shown before a meeting is changed or deleted. */
/** Stored file names of these items, current and earlier versions. */
/**
 * Adds the item_docx columns to an existing database (BOARDLINK v52).
 * item_docx holds the stored Word file an item's PDF was made from, when
 * the Secretary attached a Word file; the words are edited in it.
 */
async function ensureWordColumns() {
    for (const table of ['meeting_agenda_items', 'agenda_item_file_versions']) {
        const [rows] = await pool.query(
            `SELECT 1 FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'item_docx'`, [table]);
        if (!rows.length) {
            await pool.query(`ALTER TABLE ${table} ADD COLUMN item_docx VARCHAR(64) NULL`);
            console.log(`  ✅  Database updated: ${table}.item_docx added (Word files for agenda items)`);
        }
    }
}

async function getItemFileNames(itemIds) {
    if (!itemIds || !itemIds.length) return [];
    const [rows] = await pool.query(
        `SELECT item_pdf AS f FROM meeting_agenda_items WHERE item_id IN (?) AND item_pdf IS NOT NULL
         UNION
         SELECT item_docx AS f FROM meeting_agenda_items WHERE item_id IN (?) AND item_docx IS NOT NULL
         UNION
         SELECT item_pdf AS f FROM agenda_item_file_versions WHERE item_id IN (?)
         UNION
         SELECT item_docx AS f FROM agenda_item_file_versions WHERE item_id IN (?) AND item_docx IS NOT NULL`,
        [itemIds, itemIds, itemIds, itemIds]);
    return rows.map(r => r.f).filter(Boolean);
}

async function getMeetingFootprint(meetingId) {
    const [[row]] = await pool.query(
        `SELECT
            (SELECT COUNT(*) FROM meeting_agenda_items WHERE meeting_id = ?) AS items,
            (SELECT COUNT(*) FROM meeting_item_comments c
               JOIN meeting_agenda_items i ON i.item_id = c.item_id
              WHERE i.meeting_id = ?) AS comments,
            (SELECT COUNT(*) FROM meeting_agenda_items WHERE meeting_id = ? AND item_pdf IS NOT NULL) AS files`,
        [meetingId, meetingId, meetingId]
    );
    return { items: Number(row.items), comments: Number(row.comments), files: Number(row.files) };
}

/** Comment counts per agenda item of a meeting: Map(item_id → n). */
async function countCommentsByItem(meetingId) {
    const [rows] = await pool.query(
        `SELECT i.item_id, COUNT(c.comment_id) AS n
           FROM meeting_agenda_items i
      LEFT JOIN meeting_item_comments c ON c.item_id = i.item_id
          WHERE i.meeting_id = ?
          GROUP BY i.item_id`,
        [meetingId]
    );
    return new Map(rows.map(r => [r.item_id, Number(r.n)]));
}

/**
 * Applies an edit in one transaction.
 *   fields   — meeting columns to update
 *   updates  — [{ itemId, order, title, category }]
 *   inserts  — [{ order, title, category, pdf }]   → returns their new ids
 *   deletes  — [itemId]  (comments, pages and summaries go with them)
 */
async function applyEdit(meetingId, { fields, updates = [], inserts = [], deletes = [] }) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query(
            `UPDATE meetings
                SET title = ?, meeting_type = ?, meeting_number = ?, meeting_date = ?,
                    meeting_time = ?, venue = ?, mode = ?, called_by_user_id = ?,
                    presided_by_user_id = ?, quorum_required = ?, notes_for_members = ?,
                    comment_deadline = ?
              WHERE meeting_id = ?`,
            [fields.title, fields.meeting_type, fields.meeting_number, fields.meeting_date,
             fields.meeting_time, fields.venue, fields.mode || 'In-Person',
             fields.called_by_user_id || null, fields.presided_by_user_id || null,
             fields.quorum_required, fields.notes_for_members || null,
             fields.comment_deadline || null, meetingId]
        );
        if (deletes.length) {
            await conn.query(
                `DELETE FROM meeting_agenda_items WHERE meeting_id = ? AND item_id IN (?)`,
                [meetingId, deletes]
            );
        }
        for (const u of updates) {
            await conn.query(
                `UPDATE meeting_agenda_items SET item_order = ?, item_title = ?, item_category = ?
                  WHERE item_id = ? AND meeting_id = ?`,
                [u.order, u.title, u.category, u.itemId, meetingId]
            );
        }
        const newIds = [];
        for (const it of inserts) {
            const [r] = await conn.query(
                `INSERT INTO meeting_agenda_items
                    (meeting_id, item_order, item_title, item_category,
                     item_pdf, item_pdf_name, item_pdf_status, item_docx)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [meetingId, it.order, it.title, it.category,
                 it.pdf ? it.pdf.stored : null, it.pdf ? it.pdf.name : null, it.pdf ? 'processing' : null,
                 it.pdf ? it.pdf.docx || null : null]
            );
            newIds.push(r.insertId);
        }
        await conn.commit();
        return newIds;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/**
 * Deletes a meeting and everything that belongs to it. Returns the
 * stored file names that should be removed from disk.
 */
async function deleteMeeting(meetingId) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [[m]] = await conn.query(
            `SELECT meeting_id FROM meetings WHERE meeting_id = ? FOR UPDATE`, [meetingId]);
        if (!m) { await conn.rollback(); return null; }
        const [files] = await conn.query(
            `SELECT item_pdf FROM meeting_agenda_items WHERE meeting_id = ? AND item_pdf IS NOT NULL
             UNION
             SELECT item_docx FROM meeting_agenda_items WHERE meeting_id = ? AND item_docx IS NOT NULL
             UNION
             SELECT v.item_pdf FROM agenda_item_file_versions v
               JOIN meeting_agenda_items i ON i.item_id = v.item_id
              WHERE i.meeting_id = ?
             UNION
             SELECT v.item_docx FROM agenda_item_file_versions v
               JOIN meeting_agenda_items i ON i.item_id = v.item_id
              WHERE i.meeting_id = ? AND v.item_docx IS NOT NULL`, [meetingId, meetingId, meetingId, meetingId]);
        // Agenda items (with their comments, pages, summaries, file
        // versions, archive records and access requests) and the
        // briefing are removed together with the meeting.
        await conn.query(`DELETE FROM meetings WHERE meeting_id = ?`, [meetingId]);
        await conn.commit();
        return {
            itemFiles: files.map(f => f.item_pdf),
        };
    } catch (err) {
        try { await conn.rollback(); } catch (_) {}
        throw err;
    } finally {
        conn.release();
    }
}

async function updateStatus(meetingId, status) {
    await pool.query(`UPDATE meetings SET status = ? WHERE meeting_id = ?`, [status, meetingId]);
}

/**
 * `pdf` is { stored, name } for an uploaded item PDF, or null.
 * An item with a PDF starts as 'processing' until the page scan
 * (services/itemPdfService.js) has run.
 */
async function addAgendaItem(meetingId, order, title, category, pdf) {
    const [r] = await pool.query(
        `INSERT INTO meeting_agenda_items
            (meeting_id, item_order, item_title, item_category,
             item_pdf, item_pdf_name, item_pdf_status, item_docx)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [meetingId, order, title, category,
         pdf ? pdf.stored : null, pdf ? pdf.name : null, pdf ? 'processing' : null,
         pdf ? pdf.docx || null : null]
    );
    return r.insertId;
}

// ── Agenda item PDFs ─────────────────────────────────────────

/** One agenda item, with the meeting it belongs to. */
async function getItem(itemId) {
    const [rows] = await pool.query(
        `SELECT i.*, m.meeting_type, m.status AS meeting_status
           FROM meeting_agenda_items i
           JOIN meetings m ON m.meeting_id = i.meeting_id
          WHERE i.item_id = ? LIMIT 1`,
        [itemId]
    );
    return rows[0] || null;
}

/**
 * Attach or replace an item's PDF; its page data is rebuilt. A file
 * being replaced is kept as an earlier version so the pages members
 * commented on can still be produced.
 */
async function setItemPdf(itemId, stored, name, userId = null, docx = null) {
    const [[old]] = await pool.query(
        `SELECT item_pdf, item_pdf_name, item_pdf_pages, item_pdf_version, item_docx
           FROM meeting_agenda_items WHERE item_id = ?`, [itemId]);
    const version = old && old.item_pdf ? Number(old.item_pdf_version || 1) + 1 : 1;
    if (old && old.item_pdf) {
        await pool.query(
            `INSERT IGNORE INTO agenda_item_file_versions
                (item_id, version, item_pdf, item_pdf_name, pages, note, created_by, item_docx)
             VALUES (?, ?, ?, ?, ?, 'replaced with another file', ?, ?)`,
            [itemId, old.item_pdf_version || 1, old.item_pdf, old.item_pdf_name, old.item_pdf_pages, userId,
             old.item_docx || null]
        );
    }
    await pool.query(`DELETE FROM agenda_item_pages WHERE item_id = ?`, [itemId]);
    await pool.query(
        `UPDATE meeting_agenda_items
            SET item_pdf = ?, item_pdf_name = ?, item_pdf_pages = NULL,
                item_pdf_status = 'processing', item_pdf_version = ?, item_docx = ?
          WHERE item_id = ?`,
        [stored, name, version, docx || null, itemId]
    );
}

/** Page rows of an item, in order (with their OCR words). */
async function getPages(itemId) {
    const [rows] = await pool.query(
        `SELECT page_no, has_text, ocr_status, words FROM agenda_item_pages
          WHERE item_id = ? ORDER BY page_no`, [itemId]);
    return rows.map(r => ({ ...r, words: r.words ? JSON.parse(r.words) : null }));
}

/** Every stored version of an item's document, newest first. */
async function getFileVersions(itemId) {
    const [rows] = await pool.query(
        `SELECT v.*, u.full_name AS created_by_name
           FROM agenda_item_file_versions v
      LEFT JOIN users u ON u.user_id = v.created_by
          WHERE v.item_id = ? ORDER BY v.version DESC`, [itemId]);
    return rows;
}

async function getFileVersion(itemId, version) {
    const [rows] = await pool.query(
        `SELECT * FROM agenda_item_file_versions WHERE item_id = ? AND version = ? LIMIT 1`,
        [itemId, version]);
    return rows[0] || null;
}

/**
 * Saves an edited (or replaced) document in one transaction: the new
 * file becomes the item's document, the previous one is kept as an
 * earlier version, comments are moved to their new pages, and the
 * text of unchanged pages is carried over.
 *   previous  — { stored, name, pages, version } being retired, or null
 *   pageRows  — Map(newPage → { hasText, ocrStatus, words })
 *   comments  — [{ commentId, page, rects, lost }]
 */
async function saveEditedItemPdf(itemId, { stored, name, pages, version, note, userId, previous, pageRows, comments, docx = null }) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        if (previous && previous.stored) {
            await conn.query(
                `INSERT IGNORE INTO agenda_item_file_versions
                    (item_id, version, item_pdf, item_pdf_name, pages, note, created_by, item_docx)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [itemId, previous.version, previous.stored, previous.name, previous.pages, note || null, userId || null,
                 previous.docx || null]
            );
        }
        await conn.query(
            `UPDATE meeting_agenda_items
                SET item_pdf = ?, item_pdf_name = ?, item_pdf_pages = ?,
                    item_pdf_status = 'processing', item_pdf_version = ?, item_docx = ?
              WHERE item_id = ?`,
            [stored, name, pages, version, docx || null, itemId]
        );
        await conn.query(`DELETE FROM agenda_item_pages WHERE item_id = ?`, [itemId]);
        for (const [pageNo, row] of (pageRows || new Map())) {
            await conn.query(
                `INSERT INTO agenda_item_pages (item_id, page_no, has_text, ocr_status, words)
                 VALUES (?, ?, ?, ?, ?)`,
                [itemId, pageNo, row.hasText ? 1 : 0, row.ocrStatus,
                 row.words == null ? null : JSON.stringify(row.words)]
            );
        }
        for (const c of (comments || [])) {
            if (c.lost) {
                await conn.query(
                    `UPDATE meeting_item_comments
                        SET anchor_lost = 1, anchor_stale = 0, anchor_rects = NULL,
                            anchor_type = NULL, page_number = NULL, line_number = NULL
                      WHERE comment_id = ?`, [c.commentId]);
                // Rewriting the words does NOT mark the comment done: only
                // the Secretary's Done button does (and tells the member).
            } else if (c.recovered) {
                // Found again after being marked as lost: it points at
                // its words once more.
                await conn.query(
                    `UPDATE meeting_item_comments
                        SET page_number = ?, anchor_rects = ?, anchor_type = 'text',
                            anchor_lost = 0, anchor_stale = 1
                      WHERE comment_id = ?`,
                    [c.page, c.rects ? JSON.stringify(c.rects) : null, c.commentId]);
            } else if (c.stale === undefined) {
                // Moving pages does not change the words, so whether a
                // comment was already flagged is left as it was.
                await conn.query(
                    `UPDATE meeting_item_comments
                        SET page_number = ?, anchor_rects = ?, anchor_lost = 0
                      WHERE comment_id = ?`,
                    [c.page, c.rects ? JSON.stringify(c.rects) : null, c.commentId]);
            } else {
                await conn.query(
                    `UPDATE meeting_item_comments
                        SET page_number = ?, anchor_rects = ?, anchor_lost = 0, anchor_stale = ?
                      WHERE comment_id = ?`,
                    [c.page, c.rects ? JSON.stringify(c.rects) : null, c.stale ? 1 : 0, c.commentId]);
            }
        }
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

async function setItemPdfResult(itemId, pages, status) {
    await pool.query(
        `UPDATE meeting_agenda_items SET item_pdf_pages = ?, item_pdf_status = ? WHERE item_id = ?`,
        [pages, status, itemId]
    );
}

async function savePage(itemId, pageNo, { hasText, ocrStatus, words }) {
    await pool.query(
        `INSERT INTO agenda_item_pages (item_id, page_no, has_text, ocr_status, words)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE has_text = VALUES(has_text),
                                 ocr_status = VALUES(ocr_status),
                                 words = VALUES(words)`,
        [itemId, pageNo, hasText ? 1 : 0, ocrStatus, words == null ? null : JSON.stringify(words)]
    );
}

async function setPageOcr(itemId, pageNo, ocrStatus, words) {
    await pool.query(
        `UPDATE agenda_item_pages SET ocr_status = ?, words = ? WHERE item_id = ? AND page_no = ?`,
        [ocrStatus, words == null ? null : JSON.stringify(words), itemId, pageNo]
    );
}

async function getPage(itemId, pageNo) {
    const [rows] = await pool.query(
        `SELECT page_no, has_text, ocr_status, words
           FROM agenda_item_pages WHERE item_id = ? AND page_no = ?`,
        [itemId, pageNo]
    );
    const r = rows[0];
    if (!r) return null;
    return { ...r, words: r.words ? JSON.parse(r.words) : null };
}

/** Summary of OCR progress for one item: counts by status. */
async function getPageSummary(itemId) {
    const [rows] = await pool.query(
        `SELECT ocr_status, COUNT(*) AS n FROM agenda_item_pages
          WHERE item_id = ? GROUP BY ocr_status`,
        [itemId]
    );
    const out = { not_needed: 0, pending: 0, done: 0, failed: 0 };
    for (const r of rows) out[r.ocr_status] = Number(r.n);
    return out;
}

/** Items whose PDF was still being processed (e.g. after a restart). */
async function findItemsNeedingProcessing() {
    const [rows] = await pool.query(
        `SELECT DISTINCT i.item_id, i.item_pdf
           FROM meeting_agenda_items i
      LEFT JOIN agenda_item_pages p ON p.item_id = i.item_id AND p.ocr_status = 'pending'
          WHERE i.item_pdf IS NOT NULL
            AND (i.item_pdf_status = 'processing' OR p.item_id IS NOT NULL)`
    );
    return rows;
}

// ── Module 6: pre-meeting briefing storage ───────────────────

/** Fingerprint of the agenda a briefing was generated from. */
function agendaFingerprint(items) {
    const crypto = require('crypto');
    // The document of each item is part of the fingerprint: replacing
    // or attaching a PDF makes the briefing out of date too.
    const basis = (items || [])
        .map(i => `${i.item_order}|${i.item_title}|${i.item_category}|${i.item_pdf || ''}`)
        .join('\n');
    return crypto.createHash('sha256').update(basis).digest('hex');
}

async function getBriefing(meetingId) {
    const [rows] = await pool.query(
        `SELECT briefing_text, agenda_hash, generated_at, generated_by
           FROM meeting_briefings WHERE meeting_id = ?`,
        [meetingId]
    );
    return rows[0] || null;
}

async function saveBriefing(meetingId, text, agendaHash, userId) {
    await pool.query(
        `INSERT INTO meeting_briefings
             (meeting_id, briefing_text, agenda_hash, generated_at, generated_by)
         VALUES (?, ?, ?, NOW(), ?)
         ON DUPLICATE KEY UPDATE
             briefing_text = VALUES(briefing_text),
             agenda_hash   = VALUES(agenda_hash),
             generated_at  = VALUES(generated_at),
             generated_by  = VALUES(generated_by)`,
        [meetingId, text, agendaHash, userId || null]
    );
}

// ── Pre-meeting briefing: per-item summaries ─────────────────
async function getItemSummaries(meetingId) {
    const [rows] = await pool.query(
        `SELECT s.*
           FROM agenda_item_summaries s
           JOIN meeting_agenda_items i ON i.item_id = s.item_id
          WHERE i.meeting_id = ?`,
        [meetingId]
    );
    return rows.map(r => ({ ...r, unverified: r.unverified ? JSON.parse(r.unverified) : [] }));
}

async function saveItemSummary(itemId, s) {
    await pool.query(
        `INSERT INTO agenda_item_summaries
            (item_id, item_pdf, item_title, item_category, source_hash, status, summary_text, unverified,
             pages_read, ocr_pages, chars_read, model, error_text, generated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
            item_pdf = VALUES(item_pdf), item_title = VALUES(item_title),
            item_category = VALUES(item_category), source_hash = VALUES(source_hash),
            status = VALUES(status), summary_text = VALUES(summary_text),
            unverified = VALUES(unverified), pages_read = VALUES(pages_read),
            ocr_pages = VALUES(ocr_pages), chars_read = VALUES(chars_read),
            model = VALUES(model), error_text = VALUES(error_text),
            generated_at = VALUES(generated_at)`,
        [itemId, s.itemPdf || null, s.itemTitle || null, s.itemCategory || null,
         s.sourceHash || null, s.status, s.summary || null,
         s.unverified && s.unverified.length ? JSON.stringify(s.unverified) : null,
         s.pagesRead ?? null, s.ocrPages ?? null, s.charsRead ?? null,
         s.model || null, s.error ? String(s.error).slice(0, 500) : null]
    );
}

async function getAgendaItems(meetingId) {
    const [rows] = await pool.query(
        `SELECT i.* FROM meeting_agenda_items i
          WHERE i.meeting_id = ?
          ORDER BY i.item_order`,
        [meetingId]
    );
    return rows;
}

/**
 * Adds a comment and returns its id.
 * opts: { pageNumber, lineNumber, phase, anchorType, anchorQuote, anchorRects }
 */
async function addItemComment(itemId, userId, text, opts = {}) {
    const {
        pageNumber = null, lineNumber = null, phase = 'Pre-Meeting',
        anchorType = null, anchorQuote = null, anchorRects = null, videoTime = null,
    } = opts;
    const [r] = videoTime != null
        // A moment in a video item ("at 2:15").
        ? await pool.query(
            `INSERT INTO meeting_item_comments
                (item_id, user_id, comment_text, status, comment_phase, video_time, commented_at)
             VALUES (?, ?, ?, 'Open', ?, ?, NOW())`,
            [itemId, userId, text, phase, videoTime])
        : await pool.query(
        `INSERT INTO meeting_item_comments
            (item_id, user_id, comment_text, page_number, line_number, status,
             comment_phase, anchor_type, anchor_quote, anchor_rects, commented_at)
         VALUES (?, ?, ?, ?, ?, 'Open', ?, ?, ?, ?, NOW())`,
        [itemId, userId, text, pageNumber, lineNumber, phase,
         anchorType, anchorQuote, anchorRects ? JSON.stringify(anchorRects) : null]
    );
    return r.insertId;
}

/** One comment with the meeting it belongs to. */
async function getComment(commentId) {
    const [rows] = await pool.query(
        `SELECT c.*, i.meeting_id, i.item_category, m.status AS meeting_status,
                m.meeting_type
           FROM meeting_item_comments c
           JOIN meeting_agenda_items i ON i.item_id = c.item_id
           JOIN meetings m             ON m.meeting_id = i.meeting_id
          WHERE c.comment_id = ? LIMIT 1`,
        [commentId]
    );
    return rows[0] || null;
}

/**
 * Author-only edit of a comment's text and, for a comment on a marked
 * area, of the area itself. Returns true when a row was changed.
 */
async function updateComment(commentId, userId, { text, anchor = null }) {
    const sets = ['comment_text = ?', 'edited_at = NOW()'];
    const params = [text];
    if (anchor) {
        // The author has just placed the box themselves, so any "check
        // this still marks the right place" flag is answered.
        sets.push('page_number = ?', 'anchor_rects = ?', 'anchor_stale = 0');
        params.push(anchor.page, JSON.stringify(anchor.rects));
    }
    params.push(commentId, userId);
    const [r] = await pool.query(
        `UPDATE meeting_item_comments SET ${sets.join(', ')}
          WHERE comment_id = ? AND user_id = ? AND status = 'Open'`,
        params
    );
    return r.affectedRows > 0;
}

/** Author-only delete. Returns true when a row was removed. */
async function deleteComment(commentId, userId) {
    const [r] = await pool.query(
        `DELETE FROM meeting_item_comments
          WHERE comment_id = ? AND user_id = ? AND status = 'Open'`,
        [commentId, userId]
    );
    return r.affectedRows > 0;
}

async function getCommentsForItem(itemId) {
    const [rows] = await pool.query(
        `SELECT c.*, u.full_name, u.role, u.council_type
           FROM meeting_item_comments c
           JOIN users u ON u.user_id = c.user_id
          WHERE c.item_id = ?
          ORDER BY c.commented_at, c.comment_id`,
        [itemId]
    );
    return rows;
}

async function setStatus(meetingId, newStatus) {
    await pool.query(
        `UPDATE meetings SET status = ? WHERE meeting_id = ?`,
        [newStatus, meetingId]
    );
}

async function markCommentAddressed(commentId, userId, meetingId) {
    // The join keeps the Secretary's action inside the meeting named
    // in the URL, so a stray comment id cannot touch another meeting.
    // Only a comment that is still Open changes, so marking it done a
    // second time (a double click, two tabs) does not notify twice.
    const [result] = await pool.query(
        `UPDATE meeting_item_comments c
           JOIN meeting_agenda_items i ON i.item_id = c.item_id
            SET c.status = 'Addressed', c.addressed_at = NOW(), c.addressed_by = ?
          WHERE c.comment_id = ? AND i.meeting_id = ? AND c.status <> 'Addressed'`,
        [userId, commentId, meetingId]
    );
    if (!result.affectedRows) return null;
    // Who wrote it and what it was on, so they can be told.
    const [[row]] = await pool.query(
        `SELECT c.comment_id, c.user_id AS author_id, c.comment_text, c.item_id,
                i.item_title, i.item_order
           FROM meeting_item_comments c
           JOIN meeting_agenda_items i ON i.item_id = c.item_id
          WHERE c.comment_id = ?`,
        [commentId]
    );
    return row || null;
}

async function getCommentsForMeeting(meetingId) {
    const [rows] = await pool.query(
        `SELECT c.*, u.full_name, u.role, u.council_type,
                i.item_title, i.item_order, i.item_category
           FROM meeting_item_comments c
           JOIN meeting_agenda_items i ON i.item_id = c.item_id
           JOIN users u                ON u.user_id = c.user_id
          WHERE i.meeting_id = ?
          ORDER BY i.item_order, c.commented_at`,
        [meetingId]
    );
    return rows;
}

module.exports = {
    ensureWordColumns,
    getBriefing, saveBriefing, agendaFingerprint, getItemSummaries, saveItemSummary,
    findAll, findById, create, updateStatus,
    getMeetingFootprint, countCommentsByItem, applyEdit, deleteMeeting, getItemFileNames,
    addAgendaItem, getAgendaItems,
    getItem, setItemPdf, setItemPdfResult, savePage, setPageOcr, getPage, getPages,
    getFileVersions, getFileVersion, saveEditedItemPdf,
    getPageSummary, findItemsNeedingProcessing,
    getComment, updateComment, deleteComment, getCommentsForItem,
    addItemComment, markCommentAddressed, getCommentsForMeeting,
    setStatus,
};
