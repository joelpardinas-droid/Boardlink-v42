// ============================================================
// services/agendaArchive.js — agendas kept in the Digital Archive
// after the meeting, and permission to view them
// ============================================================
//
// When the Board Secretary clicks End Meeting, every agenda item of that
// meeting (its PDF or video) is saved to the Digital Archive, under
// "Meeting Agendas", labelled with the meeting it belongs to — e.g.
// "CSPC Regular Board of Trustees Meeting No. BOT-2026-001".
//
// From then on the items are CLOSED:
//   • the Office of the Board Secretary (Secretary, Administrator)
//     can open every one;
//   • Trustees and council members see the list, but must ask the
//     Office for permission to view a particular item. The Secretary
//     approves or declines; an approval lasts AGENDA_ACCESS_DAYS days
//     (default 7). Both steps send a notification.

const pool = require('../config/db');
const Notification = require('../models/Notification');

const ACCESS_DAYS = () => Math.max(1, Number(process.env.AGENDA_ACCESS_DAYS || 7));
const isOffice = user => !!user && ['admin', 'secretary'].includes(user.role);

// ── tables ───────────────────────────────────────────────────

let ready = null;
function ensureTables() {
    if (!ready) {
        ready = (async () => {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS agenda_archive (
                    archive_id      INT AUTO_INCREMENT PRIMARY KEY,
                    item_id         INT NOT NULL UNIQUE,
                    meeting_id      INT NOT NULL,
                    meeting_type    VARCHAR(60),
                    meeting_number  VARCHAR(60),
                    meeting_title   VARCHAR(255),
                    meeting_date    DATE NULL,
                    item_order      INT,
                    item_title      VARCHAR(500),
                    item_category   VARCHAR(40),
                    file_kind       VARCHAR(10) NULL,
                    file_name       VARCHAR(255) NULL,
                    content_text    LONGTEXT NULL,
                    archived_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_aa_meeting (meeting_id),
                    FOREIGN KEY (item_id) REFERENCES meeting_agenda_items(item_id) ON DELETE CASCADE
                )`);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS agenda_access_requests (
                    request_id      INT AUTO_INCREMENT PRIMARY KEY,
                    item_id         INT NOT NULL,
                    user_id         INT NOT NULL,
                    reason          VARCHAR(500) NOT NULL,
                    status          VARCHAR(10) NOT NULL DEFAULT 'pending',
                    decided_by      INT NULL,
                    decided_at      DATETIME NULL,
                    decision_note   VARCHAR(300) NULL,
                    expires_at      DATETIME NULL,
                    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_aar_item_user (item_id, user_id),
                    INDEX idx_aar_status (status, created_at),
                    FOREIGN KEY (item_id) REFERENCES meeting_agenda_items(item_id) ON DELETE CASCADE,
                    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
                )`);
        })().catch(err => { ready = null; throw err; });
    }
    return ready;
}

// ── saving a meeting's agendas ───────────────────────────────

/** "CSPC Regular Board of Trustees Meeting" style label for a meeting. */
function meetingLabel(m) {
    return m.meeting_title || m.title || `${m.meeting_type} Meeting`;
}

/**
 * Saves every agenda item of a meeting to the archive (again, if it is
 * already there: the details are refreshed). Returns how many items.
 */
async function archiveMeeting(meetingId) {
    await ensureTables();
    const [[m]] = await pool.query(`SELECT * FROM meetings WHERE meeting_id = ?`, [meetingId]);
    if (!m) return 0;
    const [items] = await pool.query(
        `SELECT * FROM meeting_agenda_items WHERE meeting_id = ? ORDER BY item_order`, [meetingId]);
    for (const it of items) {
        const kind = it.item_video ? 'video' : (it.item_pdf ? 'pdf' : null);
        const name = it.item_video ? it.item_video_name : (it.item_pdf_name || null);
        await pool.query(
            `INSERT INTO agenda_archive
                (item_id, meeting_id, meeting_type, meeting_number, meeting_title, meeting_date,
                 item_order, item_title, item_category, file_kind, file_name, content_text, archived_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE meeting_type = VALUES(meeting_type), meeting_number = VALUES(meeting_number),
                 meeting_title = VALUES(meeting_title), meeting_date = VALUES(meeting_date),
                 item_order = VALUES(item_order), item_title = VALUES(item_title),
                 item_category = VALUES(item_category),
                 content_text = IF(file_name <=> VALUES(file_name), content_text, NULL),
                 file_kind = VALUES(file_kind), file_name = VALUES(file_name)`,
            [it.item_id, m.meeting_id, m.meeting_type, m.meeting_number, m.title, m.meeting_date,
             it.item_order, it.item_title, it.item_category, kind, name,
             it.item_video ? (it.item_video_text || null) : null]);
    }
    console.log(`[agenda archive] meeting ${meetingId}: ${items.length} agenda item(s) saved to the Digital Archive`);
    fillTextInBackground(meetingId);
    // A copy also goes to the Board Secretary's Google Drive (if connected).
    try { require('./driveBackup').backupMeetingInBackground(meetingId); } catch (_) { /* Drive is optional */ }
    return items.length;
}

/** Reads the words of archived PDFs (for the Secretary's search). */
function fillTextInBackground(meetingId) {
    setImmediate(async () => {
        try {
            const [rows] = await pool.query(
                `SELECT a.item_id FROM agenda_archive a
                   JOIN meeting_agenda_items i ON i.item_id = a.item_id
                  WHERE a.meeting_id = ? AND a.content_text IS NULL AND i.item_pdf IS NOT NULL`, [meetingId]);
            const itemText = require('./itemTextService');
            for (const r of rows) {
                const [[item]] = await pool.query(`SELECT * FROM meeting_agenda_items WHERE item_id = ?`, [r.item_id]);
                if (!item) continue;
                const t = await itemText.getItemText(item).catch(() => null);
                if (!t || !t.pages.length) continue;
                await pool.query(`UPDATE agenda_archive SET content_text = ? WHERE item_id = ?`,
                    [t.pages.map(p => p.text).join('\n\n'), r.item_id]);
            }
        } catch (err) {
            console.warn(`[agenda archive] reading the words of meeting ${meetingId}:`, err.message);
        }
    });
}

/** Meetings already completed before this feature: put them in too. */
async function backfill() {
    try {
        await ensureTables();
        const [rows] = await pool.query(
            `SELECT m.meeting_id FROM meetings m
              WHERE m.status = 'Completed'
                AND EXISTS (SELECT 1 FROM meeting_agenda_items i
                             WHERE i.meeting_id = m.meeting_id
                               AND NOT EXISTS (SELECT 1 FROM agenda_archive a WHERE a.item_id = i.item_id))`);
        for (const r of rows) await archiveMeeting(r.meeting_id);
    } catch (err) {
        console.warn('  ⚠️   Could not check the database for archived agendas:', err.code || err.message);
    }
}

async function isArchived(itemId) {
    await ensureTables();
    const [[r]] = await pool.query(`SELECT 1 AS x FROM agenda_archive WHERE item_id = ?`, [itemId]);
    return !!r;
}

// ── permission to view ───────────────────────────────────────

/** The member's latest request for an item, with its state now. */
async function accessFor(user, itemId) {
    if (isOffice(user)) return { state: 'open', office: true };
    await ensureTables();
    const [[r]] = await pool.query(
        `SELECT * FROM agenda_access_requests WHERE item_id = ? AND user_id = ?
          ORDER BY request_id DESC LIMIT 1`, [itemId, user.id]);
    const own = stateOf(r);
    if (own.state === 'open') return own;
    // v92: an agenda item linked to a Board Resolution opens, for the same
    // time, to a member the Board Secretary opened that resolution to.
    try {
        await require('./documentAttachments').ensureTable();
        const [[v]] = await pool.query(
            `SELECT a.resolution_id, MAX(q.expires_at) AS until
               FROM document_attachments a
               JOIN document_access_requests q ON q.document_id = a.resolution_id
              WHERE a.agenda_item_id = ? AND q.user_id = ? AND q.status = 'approved' AND q.expires_at > NOW()
              GROUP BY a.resolution_id ORDER BY until DESC LIMIT 1`, [itemId, user.id]);
        if (v) return { state: 'open', until: v.until, viaResolution: v.resolution_id };
    } catch (_) { /* attachments are optional */ }
    return own;
}

function stateOf(r) {
    if (!r) return { state: 'locked' };
    if (r.status === 'approved') {
        if (r.expires_at && new Date(r.expires_at) < new Date()) return { state: 'expired', request: r };
        return { state: 'open', until: r.expires_at, request: r };
    }
    return { state: r.status, request: r };          // pending | declined
}

/** True when this user may open this agenda item now. */
async function hasAccess(user, itemId) {
    return (await accessFor(user, itemId)).state === 'open';
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

/**
 * A member asks to view an archived agenda item. Returns
 * { ok, already } — a second request while one is waiting is not made.
 */
async function requestAccess(user, itemId, reason) {
    await ensureTables();
    const [[a]] = await pool.query(`SELECT * FROM agenda_archive WHERE item_id = ?`, [itemId]);
    if (!a || a.meeting_type !== memberBody(user)) return { ok: false, message: 'That agenda item is not in the Digital Archive.' };
    const now = await accessFor(user, itemId);
    if (now.state === 'open') return { ok: true, already: 'open' };
    if (now.state === 'pending') return { ok: true, already: 'pending' };
    const why = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (why.length < 5) return { ok: false, message: 'Write why you need to view this agenda item.' };
    const [r] = await pool.query(
        `INSERT INTO agenda_access_requests (item_id, user_id, reason) VALUES (?, ?, ?)`, [itemId, user.id, why]);
    const who = user.fullName || user.full_name || user.email || 'A member';
    for (const uid of await officeUsers()) {
        await Notification.create({
            userId: uid, kind: 'access_request',
            message: `${who} asks to view "${a.item_title}" (${meetingLabel(a)}${a.meeting_number ? ' ' + a.meeting_number : ''}). Reason: ${why}`,
            link: `/archive/requests#request-${r.insertId}`,
            meetingId: a.meeting_id, itemId,
        }).catch(err => console.warn('[agenda archive] notify office:', err.message));
    }
    console.log(`[agenda archive] user ${user.id} asked to view item ${itemId}`);
    return { ok: true, requestId: r.insertId };
}

/** The Secretary approves or declines a request. */
async function decide(requestId, office, approve, note) {
    await ensureTables();
    const [[r]] = await pool.query(
        `SELECT q.*, a.item_title, a.meeting_id, a.meeting_title, a.meeting_type, a.meeting_number
           FROM agenda_access_requests q JOIN agenda_archive a ON a.item_id = q.item_id
          WHERE q.request_id = ?`, [requestId]);
    if (!r || r.status !== 'pending') return false;
    const days = ACCESS_DAYS();
    const cleanNote = String(note || '').replace(/\s+/g, ' ').trim().slice(0, 300) || null;
    await pool.query(
        `UPDATE agenda_access_requests
            SET status = ?, decided_by = ?, decided_at = NOW(), decision_note = ?,
                expires_at = ${approve ? 'DATE_ADD(NOW(), INTERVAL ? DAY)' : 'NULL'}
          WHERE request_id = ? AND status = 'pending'`,
        approve ? ['approved', office.id, cleanNote, days, requestId] : ['declined', office.id, cleanNote, requestId]);
    const label = `"${r.item_title}" (${meetingLabel(r)}${r.meeting_number ? ' ' + r.meeting_number : ''})`;
    await Notification.create({
        userId: r.user_id, kind: approve ? 'access_approved' : 'access_declined',
        message: approve
            ? `The Office of the Board Secretary approved your request to view ${label}. You can view it for ${days} day${days === 1 ? '' : 's'}.${cleanNote ? ' Note: ' + cleanNote : ''}`
            : `The Office of the Board Secretary declined your request to view ${label}.${cleanNote ? ' Reason: ' + cleanNote : ''}`,
        link: approve ? `/meeting/${r.meeting_id}/item/${r.item_id}/review` : `/archive/agendas#item-${r.item_id}`,
        meetingId: r.meeting_id, itemId: r.item_id,
    }).catch(err => console.warn('[agenda archive] notify member:', err.message));
    return true;
}

/** Requests for the Secretary: waiting ones first, then recent decisions. */
async function listRequests() {
    await ensureTables();
    const [rows] = await pool.query(
        `SELECT q.*, u.full_name, u.role, u.council_type, d.full_name AS decided_by_name,
                a.item_title, a.item_order, a.meeting_id, a.meeting_title, a.meeting_type, a.meeting_number, a.meeting_date
           FROM agenda_access_requests q
           JOIN users u ON u.user_id = q.user_id
           JOIN agenda_archive a ON a.item_id = q.item_id
      LEFT JOIN users d ON d.user_id = q.decided_by
          ORDER BY (q.status = 'pending') DESC, q.created_at DESC
          LIMIT 200`);
    return rows;
}

async function pendingCount() {
    await ensureTables();
    const [[r]] = await pool.query(`SELECT COUNT(*) AS n FROM agenda_access_requests WHERE status = 'pending'`);
    return Number(r.n) || 0;
}

/** How many archived meetings each sort button has (for the Office). */
async function groupCounts() {
    await ensureTables();
    const [rows] = await pool.query(`SELECT meeting_type, COUNT(DISTINCT meeting_id) AS n FROM agenda_archive GROUP BY meeting_type`);
    const by = new Map(rows.map(r => [r.meeting_type, Number(r.n)]));
    const out = { all: rows.reduce((s, r) => s + Number(r.n), 0) };
    for (const [k, types] of Object.entries(GROUPS)) out[k] = types.reduce((s, t) => s + (by.get(t) || 0), 0);
    return out;
}

// ── the list ─────────────────────────────────────────────────

const BODIES = ['Board of Trustees', 'Administrative Council', 'Academic Council', 'RIC Council'];

// Sort buttons for the Office: the Board of Trustees, the Board of
// Councils (the three councils together), or one council.
const GROUPS = {
    bot:      ['Board of Trustees'],
    councils: ['Academic Council', 'Administrative Council', 'RIC Council'],
    academic: ['Academic Council'],
    admin:    ['Administrative Council'],
    ric:      ['RIC Council'],
};

/** The governing body a member belongs to (members see only its meetings). */
function memberBody(user) {
    return { BOT: 'Board of Trustees', ADMIN: 'Administrative Council',
             ACADEMIC: 'Academic Council', RIC: 'RIC Council' }[user && user.council_type] || null;
}

/**
 * Archived agendas grouped by meeting, newest meeting first, each item
 * with what this user may do with it. The words inside the papers are
 * searched only for the Office (a member's search would otherwise show
 * words from papers they may not read).
 */
async function list(user, { q = '', body = '' } = {}) {
    await ensureTables();
    const office = isOffice(user);
    const where = [], params = [];
    const terms = String(q).split(/\s+/).map(t => t.replace(/[%_]/g, '').trim()).filter(t => t.length >= 2).slice(0, 8);
    for (const t of terms) {
        const like = `%${t}%`;
        where.push(`(a.item_title LIKE ? OR a.meeting_title LIKE ? OR a.meeting_number LIKE ? OR a.meeting_type LIKE ?
                     OR a.file_name LIKE ?${office ? ' OR a.content_text LIKE ?' : ''})`);
        params.push(like, like, like, like, like);
        if (office) params.push(like);
    }
    // A Trustee or council member sees ONLY their own body's past meetings.
    if (!office) { where.push('a.meeting_type = ?'); params.push(memberBody(user) || '-'); }
    else if (GROUPS[body]) { where.push('a.meeting_type IN (?)'); params.push(GROUPS[body]); }
    const [rows] = await pool.query(
        `SELECT a.archive_id, a.item_id, a.meeting_id, a.meeting_type, a.meeting_number, a.meeting_title,
                a.meeting_date, a.item_order, a.item_title, a.item_category, a.file_kind, a.file_name,
                a.archived_at${office && terms.length ? ', a.content_text' : ''}
           FROM agenda_archive a
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY a.meeting_date DESC, a.meeting_id DESC, a.item_order`, params);

    // This member's requests, newest per item.
    const mine = new Map();
    if (!office && rows.length) {
        const [reqs] = await pool.query(
            `SELECT * FROM agenda_access_requests WHERE user_id = ? AND item_id IN (?) ORDER BY request_id`,
            [user.id, rows.map(r => r.item_id)]);
        for (const r of reqs) mine.set(r.item_id, r);
    }

    const groups = new Map();
    for (const r of rows) {
        if (!groups.has(r.meeting_id)) {
            groups.set(r.meeting_id, {
                meetingId: r.meeting_id, title: r.meeting_title, type: r.meeting_type,
                number: r.meeting_number, date: r.meeting_date, items: [],
            });
        }
        const access = office ? { state: 'open', office: true } : stateOf(mine.get(r.item_id));
        let snippet = '';
        if (r.content_text && terms.length) {
            const body = String(r.content_text).replace(/\s+/g, ' ');
            const at = body.toLowerCase().indexOf(terms[0].toLowerCase());
            if (at >= 0) {
                const s = Math.max(0, at - 60);
                snippet = (s ? '…' : '') + body.slice(s, s + 200).trim() + '…';
            }
        }
        groups.get(r.meeting_id).items.push({ ...r, content_text: undefined, access, snippet });
    }
    return [...groups.values()];
}

module.exports = {
    ensureTables, archiveMeeting, backfill, isArchived,
    accessFor, hasAccess, requestAccess, decide, listRequests, pendingCount, list,
    meetingLabel, isOffice, ACCESS_DAYS, BODIES, GROUPS, memberBody, groupCounts,
};
