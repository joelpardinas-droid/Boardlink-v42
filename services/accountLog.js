// ============================================================
// services/accountLog.js — User Account Logs (v86)
// ============================================================
//
// A history of everything that happens to a user account, for the
// System Administrator: sign-ups, approvals, accounts added, account
// type changes, removals, accounts deleted because they were made by
// mistake, accounts brought back, sign-ins, failed sign-ins, sign-outs
// and password resets.
//
// Each line keeps the person's name and Gmail address as they were, so
// the line still reads correctly after an account is deleted.
// Writing a log line never stops the action it describes: if the
// database refuses it, a warning is printed and the action goes on.

const pool = require('../config/db');

const ACTIONS = {
    signed_up:        'Signed up',
    approved:         'Sign-up approved',
    turned_down:      'Sign-up turned down',
    added:            'Account added',
    type_changed:     'Account type changed',
    removed:          'Removed from BOARDLINK',
    deleted_mistake:  'Deleted (made by mistake)',
    brought_back:     'Brought back',
    signed_in:        'Signed in',
    sign_in_failed:   'Failed sign-in',
    signed_out:       'Signed out',
    password_reset:   'Password changed (Forgot password)',
};

let ready = null;
function ensureTable() {
    if (!ready) {
        ready = pool.query(`
            CREATE TABLE IF NOT EXISTS user_account_logs (
                log_id        INT AUTO_INCREMENT PRIMARY KEY,
                user_id       INT NULL,
                user_email    VARCHAR(255) NULL,
                user_name     VARCHAR(150) NULL,
                actor_id      INT NULL,
                actor_name    VARCHAR(150) NULL,
                action        VARCHAR(30) NOT NULL,
                details       VARCHAR(500) NULL,
                ip_address    VARCHAR(45) NULL,
                created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_ual_user (user_id, created_at),
                INDEX idx_ual_action (action, created_at),
                INDEX idx_ual_time (created_at),
                FOREIGN KEY (user_id)  REFERENCES users(user_id) ON DELETE SET NULL,
                FOREIGN KEY (actor_id) REFERENCES users(user_id) ON DELETE SET NULL
            )`).catch(err => { ready = null; throw err; });
    }
    return ready;
}

const clip = (v, n) => (v == null ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, n) || null);

/**
 * Adds one line. `user` is the account it is about (a users row or a
 * session user); `actor` is who did it (null when the person did it
 * themselves, e.g. signing in).
 */
async function add(action, { user = null, email = null, actor = null, details = null, req = null } = {}) {
    if (!ACTIONS[action]) throw new Error(`unknown account log action: ${action}`);
    try {
        await ensureTable();
        const uid = user ? (user.user_id || user.id || null) : null;
        // A demo session (no database row) has no real id to link to.
        const realUid = uid && Number(uid) > 0 && Number(uid) < 1e9 ? uid : null;
        const aid = actor ? (actor.user_id || actor.id || null) : null;
        await pool.query(
            `INSERT INTO user_account_logs (user_id, user_email, user_name, actor_id, actor_name, action, details, ip_address)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [realUid, clip((user && user.email) || email, 255), clip(user && (user.full_name || user.fullName), 150),
             aid, clip(actor && (actor.full_name || actor.fullName || actor.email), 150),
             action, clip(details, 500), clip(req && req.ip, 45)]);
    } catch (err) {
        // A missing row (e.g. a demo account) or a database problem must
        // never block a sign-in or an administrator's action.
        if (err && err.code === 'ER_NO_REFERENCED_ROW_2') {
            return add(action, { user: user && { email: user.email, full_name: user.full_name || user.fullName },
                                 email, actor: null, details, req }).catch(() => {});
        }
        console.warn(`[account log] could not save "${action}":`, err.code || err.message);
    }
}

/** Lines for the logs page, newest first. */
async function list({ q = '', action = '', userId = null, from = '', to = '', page = 1, perPage = 50 } = {}) {
    await ensureTable();
    const where = [], params = [];
    if (ACTIONS[action]) { where.push('l.action = ?'); params.push(action); }
    if (userId) { where.push('l.user_id = ?'); params.push(userId); }
    const terms = String(q).split(/\s+/).map(t => t.replace(/[%_]/g, '').trim()).filter(t => t.length >= 2).slice(0, 6);
    for (const t of terms) {
        where.push('(l.user_name LIKE ? OR l.user_email LIKE ? OR l.actor_name LIKE ? OR l.details LIKE ?)');
        params.push(`%${t}%`, `%${t}%`, `%${t}%`, `%${t}%`);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) { where.push('l.created_at >= ?'); params.push(from + ' 00:00:00'); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(to))   { where.push('l.created_at <= ?'); params.push(to + ' 23:59:59'); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM user_account_logs l ${w}`, params);
    const size = Math.min(200, Math.max(10, Number(perPage) || 50));
    const pages = Math.max(1, Math.ceil(Number(n) / size));
    const p = Math.min(pages, Math.max(1, parseInt(page, 10) || 1));
    const [rows] = await pool.query(
        `SELECT l.* FROM user_account_logs l ${w} ORDER BY l.created_at DESC, l.log_id DESC LIMIT ? OFFSET ?`,
        [...params, size, (p - 1) * size]);
    return { rows, total: Number(n), page: p, pages, perPage: size };
}

module.exports = { ACTIONS, ensureTable, add, list };
