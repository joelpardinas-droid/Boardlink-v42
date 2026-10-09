// ============================================================
// models/Document.js — Document Model
// Covers Modules 2 (Digital Archiving), 3 (OCR Processing),
// and 4 (AI-powered Document Search) at the data layer.
// ============================================================
//
// Corresponds to the `documents` and `document_ocr_text` entities
// in the BOARDLINK ERD. OCR text is stored in a sibling table so
// that the primary `documents` rows remain lightweight.

const pool = require('../config/db');

/**
 * Catalogue / search for the Digital Archive.
 *
 * Two things were wrong with the previous version:
 *
 *   1. It matched only `d.title`, so searching for wording that
 *      appears INSIDE a resolution found nothing at all — even
 *      though the full OCR text is stored in document_ocr_text.
 *   2. It treated the whole query as one string, so a multi-word
 *      search behaved as a single literal phrase.
 *
 * Now each word in the query must appear somewhere in the record
 * (title, resolution number/category, year, or OCR body). Terms
 * are ANDed, so adding words NARROWS the result set towards the
 * one resolution the user is looking for, rather than widening it.
 *
 * Results are ordered so that a match in the title or resolution
 * number outranks a match buried in the body text.
 */
async function findAll({ q, type, titleOnly = false, year = null, bodies = null, notType = null } = {}) {
    // v87: year (a year folder of Board Resolutions), bodies (Board of
    // Trustees / councils; a record without one counts as Board of
    // Trustees) and notType (e.g. every document except resolutions).
    // titleOnly (v85): for Trustees and council members, who see only the
    // titles of documents — the words inside a document are not searched,
    // so a search cannot reveal what a closed document says.
    const params = [];
    const where  = [];

    // Split on whitespace; ignore stray punctuation and single
    // characters, which match almost everything and only add noise.
    const terms = String(q || '')
        .split(/\s+/)
        .map(t => t.replace(/[%_]/g, '').trim())
        .filter(t => t.length >= 2)
        .slice(0, 8);                    // guard against absurd queries

    let sql =
        `SELECT d.document_id, d.title, d.doc_type, d.doc_year, d.category,
                d.uploaded_by, d.uploaded_at, d.governing_body,
                o.ocr_text
           FROM documents d
           LEFT JOIN document_ocr_text o ON o.document_id = d.document_id`;

    for (const term of terms) {
        // Every term must appear in at least one searchable field.
        where.push(`(
            d.title    LIKE ? OR
            d.category LIKE ? OR
            d.doc_type LIKE ? OR
            CAST(d.doc_year AS CHAR) LIKE ?${titleOnly ? '' : ' OR\n            o.ocr_text LIKE ?'}
        )`);
        const like = `%${term}%`;
        params.push(like, like, like, like);
        if (!titleOnly) params.push(like);
    }

    if (type) { where.push('d.doc_type = ?'); params.push(type); }
    if (notType) { where.push('d.doc_type <> ?'); params.push(notType); }
    if (year) { where.push('d.doc_year = ?'); params.push(Number(year)); }
    if (bodies && bodies.length) { where.push("COALESCE(d.governing_body, 'Board of Trustees') IN (?)"); params.push(bodies); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');

    // Relevance: title and resolution-number matches first, then the
    // rest, newest first within each band.
    if (terms.length) {
        const first = `%${terms[0]}%`;
        sql += ` ORDER BY
                    (CASE WHEN d.title    LIKE ? THEN 0
                          WHEN d.category LIKE ? THEN 1
                          ELSE 2 END),
                    d.uploaded_at DESC`;
        params.push(first, first);
    } else if (year) {
        // In a year folder: by resolution number (2026-01, 2026-02, … 2026-10).
        sql += ` ORDER BY CAST(SUBSTRING_INDEX(d.category, '-', -1) AS UNSIGNED), d.category, d.title`;
    } else {
        sql += ' ORDER BY d.uploaded_at DESC';
    }

    const [rows] = await pool.query(sql, params);

    // Attach a short excerpt showing where the match occurred, so the
    // user can tell at a glance why a document came back.
    return rows.map(r => {
        const row = { ...r };
        if (terms.length && r.ocr_text && !titleOnly) {
            row.snippet = buildSnippet(r.ocr_text, terms[0]);
        }
        delete row.ocr_text;             // never ship the whole body to the view
        return row;
    });
}

/** A ~200-character window of OCR text around the first match. */
function buildSnippet(text, term, width = 200) {
    const body = String(text).replace(/\s+/g, ' ').trim();
    const at   = body.toLowerCase().indexOf(String(term).toLowerCase());
    if (at === -1) return '';
    const start = Math.max(0, at - Math.floor(width / 3));
    const end   = Math.min(body.length, start + width);
    return (start > 0 ? '…' : '') + body.slice(start, end).trim() + (end < body.length ? '…' : '');
}

/**
 * The year folders of Board Resolutions (v87): every year that has at
 * least one resolution, newest first, with how many it holds.
 */
async function resolutionYears({ bodies = null } = {}) {
    const params = [];
    let where = `WHERE doc_type = 'Resolution'`;
    if (bodies && bodies.length) { where += " AND COALESCE(governing_body, 'Board of Trustees') IN (?)"; params.push(bodies); }
    const [rows] = await pool.query(
        `SELECT doc_year AS year, COUNT(*) AS n, MAX(uploaded_at) AS last_added
           FROM documents ${where} GROUP BY doc_year ORDER BY doc_year DESC`, params);
    return rows.map(r => ({ year: Number(r.year), n: Number(r.n), lastAdded: r.last_added }));
}

async function findById(id) {
    const [rows] = await pool.query(
        `SELECT d.*, o.ocr_text, o.ocr_confidence
           FROM documents d
      LEFT JOIN document_ocr_text o ON o.document_id = d.document_id
          WHERE d.document_id = ?
          LIMIT 1`,
        [id]
    );
    return rows[0] || null;
}

const GOVERNING_BODIES = ['Board of Trustees', 'Academic Council', 'Administrative Council', 'RIC Council'];

async function create({ title, docType, docYear, category, filename, uploadedBy, governingBody }) {
    const [result] = await pool.query(
        `INSERT INTO documents (title, doc_type, doc_year, category, file_path, uploaded_by, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())`,
        [title, docType, docYear, category, filename, uploadedBy]
    );
    // Which board or council the document belongs to (its Google Drive folder).
    if (governingBody && GOVERNING_BODIES.includes(governingBody)) {
        await pool.query('UPDATE documents SET governing_body = ? WHERE document_id = ?', [governingBody, result.insertId])
            .catch(() => {});
    }
    return result.insertId;
}

async function saveOcrText(documentId, text, confidence) {
    await pool.query(
        `INSERT INTO document_ocr_text (document_id, ocr_text, ocr_confidence, processed_at)
         VALUES (?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE ocr_text = VALUES(ocr_text),
                                 ocr_confidence = VALUES(ocr_confidence),
                                 processed_at = VALUES(processed_at)`,
        [documentId, text, confidence]
    );
}

/**
 * Documents that have never been OCR'd.
 *
 * Used by scripts/backfill-ocr.js to bring existing uploads into
 * full-text search. Documents uploaded before OCR-on-upload existed
 * have a row in `documents` but none in `document_ocr_text`, so they
 * are findable by title only.
 */
async function findWithoutOcr(limit = 500) {
    const [rows] = await pool.query(
        `SELECT d.document_id, d.title, d.doc_type, d.doc_year,
                d.category, d.file_path
           FROM documents d
           LEFT JOIN document_ocr_text o ON o.document_id = d.document_id
          WHERE o.document_id IS NULL
             OR o.ocr_text IS NULL
             OR o.ocr_text = ''
          ORDER BY d.uploaded_at ASC
          LIMIT ?`,
        [limit]
    );
    return rows;
}

async function countOcrCoverage() {
    const [rows] = await pool.query(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN o.ocr_text IS NOT NULL AND o.ocr_text <> '' THEN 1 ELSE 0 END) AS indexed
           FROM documents d
           LEFT JOIN document_ocr_text o ON o.document_id = d.document_id`
    );
    return rows[0] || { total: 0, indexed: 0 };
}

/** The latest archived documents, for the dashboard. */
async function findRecent(limit = 5) {
    const [rows] = await pool.query(
        `SELECT document_id, title, doc_type, doc_year, category, uploaded_at
           FROM documents ORDER BY uploaded_at DESC, document_id DESC LIMIT ?`, [Number(limit) || 5]);
    return rows;
}

/** Numbers for the dashboard tiles, straight from the database. */
async function dashboardCounts() {
    const [[r]] = await pool.query(`
        SELECT (SELECT COUNT(*) FROM documents) AS documents,
               (SELECT COUNT(*) FROM meetings WHERE status IN ('Scheduled','Distributed')) AS pendingAgendas,
               (SELECT COUNT(*) FROM meetings WHERE meeting_date >= CURDATE()
                                              AND status NOT IN ('Completed','Cancelled')) AS upcomingMeetings,
               (SELECT COUNT(*) FROM users WHERE is_active = 1) AS activeUsers`);
    return r;
}

module.exports = { GOVERNING_BODIES, resolutionYears, findAll, findById, findRecent, dashboardCounts, create, saveOcrText, findWithoutOcr, countOcrCoverage };
