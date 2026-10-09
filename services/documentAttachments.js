// ============================================================
// services/documentAttachments.js — the approved document of a
// Board Resolution (v87)
// ============================================================
//
// A Board Resolution often only says "Approving the ICTU Manual". The
// manual itself (its PDF or scanned copy) is archived as its own
// document and ATTACHED to the resolution that approved it, so:
//   • the resolution's page shows "Approved document: ICTU Manual [View]";
//   • the manual's page shows "Approved by Resolution No. 2026-35";
//   • search results show the attached file under the resolution.
// One resolution may have several attached documents (a manual and its
// annex); a document may be approved by more than one resolution (an
// amendment).
//
// A Trustee or council member who may open a resolution (approved
// request, one day) may also open the documents attached to it.

const pool = require('../config/db');

let ready = null;
function ensureTable() {
    if (!ready) {
        ready = (async () => { await pool.query(`
            CREATE TABLE IF NOT EXISTS document_attachments (
                attachment_id   INT AUTO_INCREMENT PRIMARY KEY,
                resolution_id   INT NOT NULL,
                document_id     INT NOT NULL,
                attached_by     INT NULL,
                attached_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_da_pair (resolution_id, document_id),
                INDEX idx_da_document (document_id),
                FOREIGN KEY (resolution_id) REFERENCES documents(document_id) ON DELETE CASCADE,
                FOREIGN KEY (document_id)   REFERENCES documents(document_id) ON DELETE CASCADE,
                FOREIGN KEY (attached_by)   REFERENCES users(user_id) ON DELETE SET NULL
            )`);
            await upgrade();
        })().catch(err => { ready = null; throw err; });
    }
    return ready;
}

/**
 * v92: an approved document can also be PAGES inside the resolution's own
 * PDF (copied into their own document; page_from / page_to remember where
 * they came from) or an AGENDA ITEM from a past meeting (agenda_item_id;
 * no document of its own). Adds the columns to an older database.
 */
async function upgrade() {
    const [cols] = await pool.query(
        `SELECT COLUMN_NAME AS c, IS_NULLABLE AS n FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'document_attachments'`);
    const has = new Map(cols.map(r => [r.c, r.n]));
    if (has.get('document_id') === 'NO') await pool.query('ALTER TABLE document_attachments MODIFY document_id INT NULL');
    if (!has.has('source')) await pool.query(`ALTER TABLE document_attachments ADD COLUMN source VARCHAR(10) NOT NULL DEFAULT 'file' AFTER document_id`);
    if (!has.has('page_from')) await pool.query('ALTER TABLE document_attachments ADD COLUMN page_from INT NULL AFTER source, ADD COLUMN page_to INT NULL AFTER page_from');
    // v93: the place in the resolution the document is attached to (words
    // the Secretary selected, or an area she marked): page + text + boxes.
    if (!has.has('anchor_page')) {
        await pool.query(`ALTER TABLE document_attachments ADD COLUMN anchor_page INT NULL AFTER source,
                            ADD COLUMN anchor_text VARCHAR(500) NULL AFTER anchor_page,
                            ADD COLUMN anchor_rects TEXT NULL AFTER anchor_text`);
    }
    if (!has.has('agenda_item_id')) {
        await require('./agendaArchive').ensureTables();
        await pool.query(`ALTER TABLE document_attachments ADD COLUMN agenda_item_id INT NULL AFTER page_to,
                            ADD UNIQUE KEY uq_da_agenda (resolution_id, agenda_item_id),
                            ADD CONSTRAINT document_attachments_ibfk_4 FOREIGN KEY (agenda_item_id)
                                REFERENCES agenda_archive(item_id) ON DELETE CASCADE`);
    }
}

/** A safe anchor from the browser: { page, text, rects:[[x,y,w,h] 0–1] } or null. */
function cleanAnchor(a) {
    if (!a) return null;
    let rects = a.rects;
    if (typeof rects === 'string') { try { rects = JSON.parse(rects); } catch (_) { rects = null; } }
    const page = parseInt(a.page, 10);
    if (!(page >= 1 && page <= 5000) || !Array.isArray(rects) || !rects.length) return null;
    const ok = rects.slice(0, 60).map(r => (Array.isArray(r) ? r : []).slice(0, 4).map(Number))
        .filter(r => r.length === 4 && r.every(v => Number.isFinite(v) && v >= -0.01 && v <= 1.01))
        .map(r => r.map(v => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000));
    if (!ok.length) return null;
    return { page, text: String(a.text || '').replace(/\s+/g, ' ').trim().slice(0, 500) || null, rects: JSON.stringify(ok) };
}

const COLS = 'd.document_id, d.title, d.doc_type, d.doc_year, d.category, d.governing_body, (d.file_path IS NOT NULL) AS has_file';

/**
 * Attaches `documentId` to the resolution `resolutionId`.
 * Returns { ok, message? }.
 */
async function attach(resolutionId, documentId, userId, { source = 'file', pageFrom = null, pageTo = null, anchor = null } = {}) {
    await ensureTable();
    resolutionId = Number(resolutionId); documentId = Number(documentId);
    if (!resolutionId || !documentId) return { ok: false, message: 'Choose the document to attach.' };
    if (resolutionId === documentId) return { ok: false, message: 'A resolution cannot be attached to itself.' };
    const [rows] = await pool.query('SELECT document_id, doc_type FROM documents WHERE document_id IN (?, ?)', [resolutionId, documentId]);
    const res = rows.find(r => r.document_id === resolutionId);
    const doc = rows.find(r => r.document_id === documentId);
    if (!res || !doc) return { ok: false, message: 'That document is not in the Digital Archive.' };
    if (res.doc_type !== 'Resolution') return { ok: false, message: 'Approved documents can only be attached to a Board Resolution.' };
    if (doc.doc_type === 'Resolution') return { ok: false, message: 'Attach the approved manual, policy or memorandum, not another resolution.' };
    const an = cleanAnchor(anchor);
    await pool.query(
        `INSERT INTO document_attachments (resolution_id, document_id, source, page_from, page_to, anchor_page, anchor_text, anchor_rects, attached_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE anchor_page = IFNULL(VALUES(anchor_page), anchor_page),
                                 anchor_text = IF(VALUES(anchor_page) IS NULL, anchor_text, VALUES(anchor_text)),
                                 anchor_rects = IFNULL(VALUES(anchor_rects), anchor_rects)`,
        [resolutionId, documentId, source === 'pages' ? 'pages' : 'file', pageFrom, pageTo,
         an ? an.page : null, an ? an.text : null, an ? an.rects : null, userId || null]);
    return { ok: true };
}

/** v92: links an archived agenda item (from a past meeting) to a resolution. */
async function attachAgenda(resolutionId, itemId, userId, { anchor = null } = {}) {
    await ensureTable();
    resolutionId = Number(resolutionId); itemId = Number(itemId);
    const [[res]] = await pool.query('SELECT doc_type FROM documents WHERE document_id = ?', [resolutionId]);
    if (!res || res.doc_type !== 'Resolution') return { ok: false, message: 'Agenda items can only be linked to a Board Resolution.' };
    const [[a]] = await pool.query('SELECT item_id FROM agenda_archive WHERE item_id = ?', [itemId]);
    if (!a) return { ok: false, message: 'That agenda item is not in the Digital Archive.' };
    const an = cleanAnchor(anchor);
    await pool.query(
        `INSERT INTO document_attachments (resolution_id, document_id, source, agenda_item_id, anchor_page, anchor_text, anchor_rects, attached_by)
         VALUES (?, NULL, 'agenda', ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE anchor_page = IFNULL(VALUES(anchor_page), anchor_page),
                                 anchor_text = IF(VALUES(anchor_page) IS NULL, anchor_text, VALUES(anchor_text)),
                                 anchor_rects = IFNULL(VALUES(anchor_rects), anchor_rects)`,
        [resolutionId, itemId, an ? an.page : null, an ? an.text : null, an ? an.rects : null, userId || null]);
    return { ok: true };
}

async function detachAgenda(resolutionId, itemId) {
    await ensureTable();
    const [r] = await pool.query('DELETE FROM document_attachments WHERE resolution_id = ? AND agenda_item_id = ?',
        [Number(resolutionId), Number(itemId)]);
    return r.affectedRows > 0;
}

/**
 * v92: copies pages from..to of a resolution's PDF into a new PDF file in
 * the archive's storage. Returns { filename } or throws with a message.
 */
async function copyPages(resolutionFile, from, to) {
    const fs = require('fs'), path = require('path'), crypto = require('crypto');
    const { PDFDocument } = require('pdf-lib');
    const { UPLOAD_DIR } = require('../config/paths');
    let src;
    try { src = await PDFDocument.load(fs.readFileSync(resolutionFile), { ignoreEncryption: true }); }
    catch (_) { throw new Error('Pages can only be taken from a PDF resolution.'); }
    const total = src.getPageCount();
    from = Number(from); to = Number(to);
    if (!(from >= 1 && to >= from && to <= total)) throw new Error(`Choose pages between 1 and ${total}.`);
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i));
    pages.forEach(p => out.addPage(p));
    const filename = crypto.randomBytes(16).toString('hex');
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), await out.save());
    return { filename, pages: to - from + 1 };
}

async function detach(resolutionId, documentId) {
    await ensureTable();
    const [r] = await pool.query('DELETE FROM document_attachments WHERE resolution_id = ? AND document_id = ?',
        [Number(resolutionId), Number(documentId)]);
    return r.affectedRows > 0;
}

/** Map resolution_id → [attached documents]. */
async function attachedTo(resolutionIds) {
    const out = new Map();
    const ids = [...new Set((resolutionIds || []).map(Number).filter(Boolean))];
    if (!ids.length) return out;
    await ensureTable();
    const [rows] = await pool.query(
        `SELECT a.resolution_id, a.source, a.page_from, a.page_to, a.anchor_page, a.anchor_text, a.anchor_rects, ${COLS} FROM document_attachments a
           JOIN documents d ON d.document_id = a.document_id
          WHERE a.resolution_id IN (?) ORDER BY d.title`, [ids]);
    // v92: agenda items of past meetings linked to the resolution.
    const [agenda] = await pool.query(
        `SELECT a.resolution_id, 'agenda' AS source, a.anchor_page, a.anchor_text, a.anchor_rects, g.item_id, g.meeting_id, g.item_title AS title, g.item_order,
                g.meeting_title, g.meeting_type, g.meeting_number, g.meeting_date, g.file_kind,
                (g.file_kind IS NOT NULL) AS has_file
           FROM document_attachments a JOIN agenda_archive g ON g.item_id = a.agenda_item_id
          WHERE a.resolution_id IN (?) ORDER BY g.meeting_date, g.item_order`, [ids]);
    for (const r of rows.concat(agenda)) {
        r.kind = r.source === 'agenda' ? 'agenda' : (r.source === 'pages' ? 'pages' : 'file');
        if (!out.has(r.resolution_id)) out.set(r.resolution_id, []);
        out.get(r.resolution_id).push(r);
    }
    return out;
}

/** Map document_id → [resolutions that approved it]. */
async function approvedBy(documentIds) {
    const out = new Map();
    const ids = [...new Set((documentIds || []).map(Number).filter(Boolean))];
    if (!ids.length) return out;
    await ensureTable();
    const [rows] = await pool.query(
        `SELECT a.document_id AS attached_id, ${COLS} FROM document_attachments a
           JOIN documents d ON d.document_id = a.resolution_id
          WHERE a.document_id IN (?) ORDER BY d.doc_year DESC, d.category`, [ids]);
    for (const r of rows) {
        if (!out.has(r.attached_id)) out.set(r.attached_id, []);
        out.get(r.attached_id).push(r);
    }
    return out;
}

/** Fills d.attached (for resolutions) and d.approvedBy (for other documents) on a list of rows. */
async function decorate(documents) {
    const id = d => Number(d.document_id || d.id);
    const res = documents.filter(d => (d.doc_type || 'Resolution') === 'Resolution').map(id);
    const other = documents.filter(d => d.doc_type && d.doc_type !== 'Resolution').map(id);
    const [a, b] = await Promise.all([attachedTo(res), approvedBy(other)]);
    for (const d of documents) {
        d.attached = a.get(id(d)) || [];
        d.approvedBy = b.get(id(d)) || [];
    }
    return documents;
}

/** Choices for the "attach" and "approved by" pickers. */
async function choices() {
    const [rows] = await pool.query(
        `SELECT document_id, title, doc_type, doc_year, category FROM documents
          ORDER BY doc_year DESC, (doc_type = 'Resolution') DESC, category, title LIMIT 3000`);
    return {
        resolutions: rows.filter(r => r.doc_type === 'Resolution'),
        others: rows.filter(r => r.doc_type !== 'Resolution'),
    };
}

module.exports = { cleanAnchor, ensureTable, attach, attachAgenda, detachAgenda, copyPages, detach, attachedTo, approvedBy, decorate, choices };
