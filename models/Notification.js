// ============================================================
// models/Notification.js — messages shown under the bell icon
// ============================================================
//
// Right now one thing sends a notice: the Board Secretary marking a
// member's comment "Done". The member who wrote the comment is told,
// with a link straight back to that comment.
//
// The table is created the first time it is needed, so an existing
// database keeps working without re-importing sql/schema.sql.
// Every function here is best-effort: if the database is down, the
// bell is simply empty and nothing else on the page breaks.

const pool = require('../config/db');

let tableReady = null;
function ensureTable() {
    if (!tableReady) {
        tableReady = pool.query(`
            CREATE TABLE IF NOT EXISTS notifications (
                notification_id INT AUTO_INCREMENT PRIMARY KEY,
                user_id         INT NOT NULL,
                kind            VARCHAR(40) NOT NULL DEFAULT 'comment_done',
                message         VARCHAR(500) NOT NULL,
                link            VARCHAR(300),
                meeting_id      INT,
                item_id         INT,
                comment_id      INT,
                created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
                read_at         DATETIME NULL,
                INDEX idx_notif_user (user_id, read_at, created_at),
                FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
            )`).catch(err => { tableReady = null; throw err; });
    }
    return tableReady;
}

async function create({ userId, kind = 'comment_done', message, link = null,
                        meetingId = null, itemId = null, commentId = null }) {
    await ensureTable();
    await pool.query(
        `INSERT INTO notifications (user_id, kind, message, link, meeting_id, item_id, comment_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [userId, kind, String(message).slice(0, 500), link ? String(link).slice(0, 300) : null,
         meetingId, itemId, commentId]
    );
}

async function listForUser(userId, limit = 50) {
    await ensureTable();
    const [rows] = await pool.query(
        `SELECT notification_id, kind, message, link, created_at, read_at
           FROM notifications WHERE user_id = ?
          ORDER BY created_at DESC, notification_id DESC LIMIT ?`,
        [userId, Number(limit) || 50]
    );
    return rows;
}

async function countUnread(userId) {
    await ensureTable();
    const [[row]] = await pool.query(
        `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL`, [userId]);
    return Number(row.n) || 0;
}

/** Marks one notice read. Returns its link, or null if it is not this user's. */
async function markRead(notificationId, userId) {
    await ensureTable();
    const [[row]] = await pool.query(
        `SELECT link FROM notifications WHERE notification_id = ? AND user_id = ?`,
        [notificationId, userId]);
    if (!row) return null;
    await pool.query(
        `UPDATE notifications SET read_at = COALESCE(read_at, NOW())
          WHERE notification_id = ? AND user_id = ?`, [notificationId, userId]);
    return row.link || '/dashboard';
}

async function markAllRead(userId) {
    await ensureTable();
    await pool.query(
        `UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL`, [userId]);
}

module.exports = { ensureTable, create, listForUser, countUnread, markRead, markAllRead };
