// ============================================================
// services/documentAccess.js — permission to open an archived
// Board Resolution or document (v85)
// ============================================================
//
// In the Digital Archive, Trustees and the members of the
// Administrative, Academic and RIC Councils see only the TITLE of each
// Board Resolution or document (its number, title, year and type), the
// same way archived agenda items appear under "Meeting Agendas".
//
// To open the file itself they ask the Board Secretary. The Secretary
// approves or declines. An approval lets that member view AND download
// that one document for DOCUMENT_ACCESS_HOURS hours (default 24, i.e.
// one day). Both steps send a notification.
//
// The Office of the Board Secretary (Secretary, Administrator) opens
// every document without asking.

const pool = require('../config/db');
const Notification = require('../models/Notification');

const ACCESS_HOURS = () => Math.max(1, Number(process.env.DOCUMENT_ACCESS_HOURS || 24));
const isOffice = user => !!user && ['admin', 'secretary'].includes(user.role);

let ready = null;
function ensureTables() {
    if (!ready) {
        ready = pool.query(`
            CREATE TABLE IF NOT EXISTS document_access_requests (
                request_id      INT AUTO_INCREMENT PRIMARY KEY,
                document_id     INT NOT NULL,
                user_id         INT NOT NULL,
                reason          VARCHAR(500) NOT NULL,
                status          VARCHAR(10) NOT NULL DEFAULT 'pending',
                decided_by      INT NULL,
                decided_at      DATETIME NULL,
                decision_note   VARCHAR(300) NULL,
                expires_at      DATETIME NULL,
                created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_dar_doc_user (document_id, user_id),
                INDEX idx_dar_status (status, created_at),
                FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
            )`).catch(err => { ready = null; throw err; });
    }
    return ready;
}

/** locked | pending | declined | open | expired */
function stateOf(r) {
    if (!r) return { state: 'locked' };
    if (r.status === 'approved') {
        if (r.expires_at && new Date(r.expires_at) < new Date()) return { state: 'expired', request: r };
        return { state: 'open', until: r.expires_at, request: r };
    }
    return { state: r.status, request: r };
}

async function accessFor(user, documentId) {
    if (isOffice(user)) return { state: 'open', office: true };
    if (!user) return { state: 'locked' };
    await ensureTables();
    const [[r]] = await pool.query(
        `SELECT * FROM document_access_requests WHERE document_id = ? AND user_id = ?
          ORDER BY request_id DESC LIMIT 1`, [documentId, user.id]);
    const own = stateOf(r);
    if (own.state === 'open') return own;
    // v87: open for the same day through the resolution it is attached to.
    const via = (await viaResolutions(user, [documentId])).get(Number(documentId));
    return via || own;
}

/**
 * v87: documents attached to a resolution this member may open now are
 * open too, until the same time. Map document_id → open state.
 */
async function viaResolutions(user, ids) {
    const out = new Map();
    if (!user || !ids.length) return out;
    await require('./documentAttachments').ensureTable();
    const [rows] = await pool.query(
        `SELECT a.document_id, a.resolution_id, MAX(q.expires_at) AS until
           FROM document_attachments a
           JOIN document_access_requests q ON q.document_id = a.resolution_id
          WHERE a.document_id IN (?) AND q.user_id = ? AND q.status = 'approved' AND q.expires_at > NOW()
          GROUP BY a.document_id, a.resolution_id`, [ids.map(Number), user.id]);
    for (const r of rows) {
        const prev = out.get(Number(r.document_id));
        if (!prev || new Date(r.until) > new Date(prev.until)) {
            out.set(Number(r.document_id), { state: 'open', until: r.until, viaResolution: r.resolution_id });
        }
    }
    return out;
}

async function hasAccess(user, documentId) {
    return (await accessFor(user, documentId)).state === 'open';
}

/** This member's state for many documents at once (for the list). */
async function statesFor(user, ids) {
    const out = new Map();
    ids = [...new Set((ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0))];   // (agenda links have no document id)
    if (isOffice(user)) { for (const id of ids) out.set(Number(id), { state: 'open', office: true }); return out; }
    for (const id of ids) out.set(Number(id), { state: 'locked' });
    if (!user || !ids.length) return out;
    await ensureTables();
    const [rows] = await pool.query(
        `SELECT * FROM document_access_requests WHERE user_id = ? AND document_id IN (?) ORDER BY request_id`,
        [user.id, ids.map(Number)]);
    for (const r of rows) out.set(Number(r.document_id), stateOf(r));     // the newest wins
    const via = await viaResolutions(user, ids);
    for (const [id, st] of via) if ((out.get(id) || {}).state !== 'open') out.set(id, st);
    return out;
}

function docLabel(d) {
    const no = d.doc_type === 'Resolution' && d.category ? `Resolution No. ${d.category}: ` : (d.category ? `${d.category}: ` : '');
    return `${no}${d.title}`;
}

async function officeUsers() {
    const [rows] = await pool.query(
        `SELECT user_id FROM users WHERE role = 'secretary' AND is_active = 1
           AND (account_status IS NULL OR account_status = 'active')`).catch(async () =>
        pool.query(`SELECT user_id FROM users WHERE role = 'secretary' AND is_active = 1`));
    if (rows.length) return rows.map(r => r.user_id);
    const [admins] = await pool.query(`SELECT user_id FROM users WHERE role = 'admin' AND is_active = 1`);
    return admins.map(r => r.user_id);
}

/** A member asks to open a document. Returns { ok, already?, message? }. */
async function requestAccess(user, documentId, reason) {
    await ensureTables();
    const [[d]] = await pool.query(
        `SELECT document_id, title, doc_type, category FROM documents WHERE document_id = ?`, [documentId]);
    if (!d) return { ok: false, message: 'That document is not in the Digital Archive.' };
    const now = await accessFor(user, documentId);
    if (now.state === 'open') return { ok: true, already: 'open' };
    if (now.state === 'pending') return { ok: true, already: 'pending' };
    const why = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (why.length < 5) return { ok: false, message: 'Write why you need to open this document.' };
    const [r] = await pool.query(
        `INSERT INTO document_access_requests (document_id, user_id, reason) VALUES (?, ?, ?)`,
        [documentId, user.id, why]);
    const who = user.fullName || user.full_name || user.email || 'A member';
    for (const uid of await officeUsers()) {
        await Notification.create({
            userId: uid, kind: 'doc_access_request',
            message: `${who} asks to open "${docLabel(d)}". Reason: ${why}`,
            link: `/archive/requests#doc-request-${r.insertId}`,
        }).catch(err => console.warn('[document access] notify office:', err.message));
    }
    console.log(`[document access] user ${user.id} asked to open document ${documentId}`);
    return { ok: true, requestId: r.insertId };
}

/** The Secretary approves (for ACCESS_HOURS hours) or declines a request. */
async function decide(requestId, office, approve, note) {
    await ensureTables();
    const [[r]] = await pool.query(
        `SELECT q.*, d.title, d.doc_type, d.category
           FROM document_access_requests q JOIN documents d ON d.document_id = q.document_id
          WHERE q.request_id = ?`, [requestId]);
    if (!r || r.status !== 'pending') return false;
    const hours = ACCESS_HOURS();
    const cleanNote = String(note || '').replace(/\s+/g, ' ').trim().slice(0, 300) || null;
    const [u] = await pool.query(
        `UPDATE document_access_requests
            SET status = ?, decided_by = ?, decided_at = NOW(), decision_note = ?,
                expires_at = ${approve ? 'DATE_ADD(NOW(), INTERVAL ? HOUR)' : 'NULL'}
          WHERE request_id = ? AND status = 'pending'`,
        approve ? ['approved', office.id, cleanNote, hours, requestId] : ['declined', office.id, cleanNote, requestId]);
    if (!u.affectedRows) return false;
    let extra = '';
    if (approve) {
        try {
            const att = (await require('./documentAttachments').attachedTo([r.document_id])).get(Number(r.document_id)) || [];
            if (att.length) extra = ` Its approved document${att.length > 1 ? 's' : ''} (${att.map(a => a.title).join('; ')}) open${att.length > 1 ? '' : 's'} for the same time.`;
        } catch (_) { /* attachments are optional */ }
    }
    const span = hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? '' : 's'}` : `${hours} hour${hours === 1 ? '' : 's'}`;
    await Notification.create({
        userId: r.user_id, kind: approve ? 'doc_access_approved' : 'doc_access_declined',
        message: approve
            ? `The Board Secretary approved your request to open "${docLabel(r)}". You can view and download it for ${span}.${extra}${cleanNote ? ' Note: ' + cleanNote : ''}`
            : `The Board Secretary declined your request to open "${docLabel(r)}".${cleanNote ? ' Reason: ' + cleanNote : ''}`,
        link: approve ? `/archive/${r.document_id}` : `/archive?doc=${r.document_id}#doc-${r.document_id}`,
    }).catch(err => console.warn('[document access] notify member:', err.message));
    return true;
}

async function listRequests() {
    await ensureTables();
    const [rows] = await pool.query(
        `SELECT q.*, u.full_name, u.role, u.council_type, x.full_name AS decided_by_name,
                d.title, d.doc_type, d.category, d.doc_year
           FROM document_access_requests q
           JOIN users u ON u.user_id = q.user_id
           JOIN documents d ON d.document_id = q.document_id
      LEFT JOIN users x ON x.user_id = q.decided_by
          ORDER BY (q.status = 'pending') DESC, q.created_at DESC
          LIMIT 200`);
    return rows;
}

async function pendingCount() {
    await ensureTables();
    const [[r]] = await pool.query(`SELECT COUNT(*) AS n FROM document_access_requests WHERE status = 'pending'`);
    return Number(r.n) || 0;
}

module.exports = {
    ensureTables, ACCESS_HOURS, viaResolutions, isOffice, stateOf, accessFor, hasAccess, statesFor,
    requestAccess, decide, listRequests, pendingCount, docLabel,
};
