// ============================================================
// models/User.js — User Model (Module 1: User & Access Management)
// BOARDLINK | Chapter 3 Sec. 3.2.2 — Model layer of MVC, queries
// MySQL via the mysql2 pool using parameterized statements only.
// ============================================================
//
// Corresponds to the `users` entity in the BOARDLINK ERD. Password
// hashes are produced by bcrypt in the controller (Chapter 3 Sec.
// 3.2.3) before a row is inserted through `create()`.
//
// `council_type` distinguishes Trustees from Council Members at
// the database level so the UI can correctly render the user's
// affiliation (Board of Trustees vs Administrative / Academic /
// RIC Council). It is NULL for non-member roles.

const pool = require('../config/db');

async function findByUsername(username) {
    const [rows] = await pool.query(
        `SELECT user_id, username, password_hash, role, full_name, email,
                is_active, council_type
           FROM users WHERE username = ? LIMIT 1`,
        [username]
    );
    return rows[0] || null;
}

// Sign-in lookup. Addresses are stored in lower case, and the
// column's collation is case-insensitive as well.
async function findByEmail(email) {
    const [rows] = await pool.query(
        `SELECT user_id, username, password_hash, role, full_name, email,
                is_active, council_type, account_status, retired_at, retired_from, google_sub
           FROM users WHERE email = ? LIMIT 1`,
        [String(email || '').trim().toLowerCase()]
    );
    return rows[0] || null;
}

async function findById(id) {
    const [rows] = await pool.query(
        `SELECT user_id, username, role, full_name, email, is_active, council_type, account_status, requested_type, retired_at, retired_from, retired_note, google_sub, created_at
           FROM users WHERE user_id = ? LIMIT 1`,
        [id]
    );
    return rows[0] || null;
}

async function findAll() {
    const [rows] = await pool.query(
        `SELECT user_id, username, role, full_name, email, is_active, council_type, account_status, requested_type, retired_at, retired_from, retired_note, google_sub, created_at
           FROM users ORDER BY full_name ASC`
    );
    return rows;
}

// Returns all active users whose role is one of the given roles.
// Used when inviting attendees to a meeting (a body's members).
// Optionally filtered to a specific council_type for council-only
// meetings (Administrative / Academic / RIC).
async function findByRoles(roles, councilType = null) {
    if (!Array.isArray(roles) || roles.length === 0) return [];
    const placeholders = roles.map(() => '?').join(',');
    let sql = `SELECT user_id, username, role, full_name, email, council_type
                 FROM users
                WHERE role IN (${placeholders}) AND is_active = 1`;
    const params = [...roles];
    if (councilType) {
        sql += ' AND council_type = ?';
        params.push(councilType);
    }
    sql += ' ORDER BY role, full_name';
    const [rows] = await pool.query(sql, params);
    return rows;
}

async function create({ username, passwordHash, role, fullName, email, councilType }) {
    const [result] = await pool.query(
        `INSERT INTO users (username, password_hash, role, full_name, email,
                            council_type, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, NOW())`,
        [username, passwordHash, role, fullName,
         String(email || '').trim().toLowerCase(), councilType || null]
    );
    return result.insertId;
}

async function deactivate(id) {
    await pool.query('UPDATE users SET is_active = 0 WHERE user_id = ?', [id]);
}

// ── Accounts: sign-up, approval, retirement (BOARDLINK v56) ──
//
//   account_status  'active'   can sign in (is_active = 1)
//                   'pending'  signed up, waiting for the System
//                              Administrator to approve (is_active = 0)
//                   'retired'  removed by the System Administrator, for
//                              example a Trustee whose term ended. The
//                              account stays so their name remains on
//                              past comments and records (is_active = 0)
//   requested_type  the account type the person asked for at sign-up
//   retired_at / retired_from / retired_note   when, from which body
//                   (e.g. "Trustee") and why the account was retired
//   google_sub      the Google account linked by "Sign in with Google"

/** Adds the account columns to an existing database. */
async function ensureAccountColumns() {
    const want = [
        ['account_status', "VARCHAR(20) NOT NULL DEFAULT 'active'"],
        ['requested_type', 'VARCHAR(20) NULL'],
        ['retired_at',     'DATE NULL'],
        ['retired_from',   'VARCHAR(60) NULL'],
        ['retired_note',   'VARCHAR(255) NULL'],
        ['google_sub',     'VARCHAR(64) NULL'],
    ];
    const [have] = await pool.query(
        `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`);
    const names = new Set(have.map(r => r.c));
    for (const [col, def] of want) {
        if (names.has(col)) continue;
        await pool.query(`ALTER TABLE users ADD COLUMN ${col} ${def}`);
        console.log(`  ✅  Database updated: users.${col} added (account sign-up and retirement)`);
    }
    // Accounts switched off before this existed count as retired.
    if (!names.has('account_status')) {
        await pool.query(`UPDATE users SET account_status = 'retired' WHERE is_active = 0`);
    }
    const [idx] = await pool.query(
        `SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'uniq_users_google'`);
    if (!idx.length) await pool.query('ALTER TABLE users ADD UNIQUE INDEX uniq_users_google (google_sub)');
}

/** A free username made from the e-mail address ("juan.delacruz", "juan.delacruz2", …). */
async function uniqueUsername(email) {
    const base = String(email).split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40) || 'user';
    for (let n = 1; n < 500; n++) {
        const name = n === 1 ? base : `${base}${n}`;
        const [rows] = await pool.query('SELECT 1 FROM users WHERE username = ? LIMIT 1', [name]);
        if (!rows.length) return name;
    }
    return `${base}${Date.now()}`;
}

async function findByGoogleSub(sub) {
    const [rows] = await pool.query(
        `SELECT user_id, username, role, full_name, email, is_active, council_type, account_status, requested_type, retired_at, retired_from, retired_note, google_sub FROM users WHERE google_sub = ? LIMIT 1`, [sub]);
    return rows[0] || null;
}

/** A person who signed up and waits for approval. Returns the new id. */
async function createPending({ fullName, email, passwordHash, requested, googleSub = null }) {
    const username = await uniqueUsername(email);
    const [r] = await pool.query(
        `INSERT INTO users (username, password_hash, role, full_name, email, council_type,
                            is_active, account_status, requested_type, google_sub, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?, NOW())`,
        [username, passwordHash, requested.role, fullName, String(email).trim().toLowerCase(),
         requested.council_type || null, requested.key, googleSub]);
    return r.insertId;
}

/** Approve a sign-up as the given account type. */
async function approve(id, type) {
    const [r] = await pool.query(
        `UPDATE users SET is_active = 1, account_status = 'active', role = ?, council_type = ?,
                          retired_at = NULL, retired_from = NULL, retired_note = NULL
          WHERE user_id = ? AND account_status = 'pending'`,
        [type.role, type.council_type || null, id]);
    return r.affectedRows > 0;
}

/** Turn down a sign-up: the account is removed (it has no records yet). */
async function rejectPending(id) {
    const [r] = await pool.query(`DELETE FROM users WHERE user_id = ? AND account_status = 'pending'`, [id]);
    return r.affectedRows > 0;
}

/**
 * Removes a person from BOARDLINK while keeping their past records:
 * they can no longer sign in, are no longer invited or counted for
 * quorum, and their name stays on the comments and records they made.
 * Their places in meetings that have not happened yet are removed.
 */
async function retire(id, { from, date, note }) {
    const [r] = await pool.query(
        `UPDATE users SET is_active = 0, account_status = 'retired',
                          retired_at = ?, retired_from = ?, retired_note = ?
          WHERE user_id = ? AND account_status <> 'pending'`,
        [date || new Date(), from || null, note || null, id]);
    return r.affectedRows > 0;
}

/** Brings a retired person back, as the given account type. */
async function reactivate(id, type) {
    const [r] = await pool.query(
        `UPDATE users SET is_active = 1, account_status = 'active', role = ?, council_type = ?,
                          retired_at = NULL, retired_from = NULL, retired_note = NULL
          WHERE user_id = ? AND account_status = 'retired'`,
        [type.role, type.council_type || null, id]);
    return r.affectedRows > 0;
}

/** Moves an active person to another account type (e.g. to another council). */
async function changeType(id, type) {
    const [r] = await pool.query(
        `UPDATE users SET role = ?, council_type = ? WHERE user_id = ? AND account_status = 'active'`,
        [type.role, type.council_type || null, id]);
    return r.affectedRows > 0;
}

/**
 * Deletes an account for good. Refused (returns { ok: false, inUse: true })
 * when the person has records in BOARDLINK — comments, attendance,
 * uploads, meetings — because deleting them would break the Board's
 * records. Such accounts are retired instead.
 */
async function deletePermanently(id) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query('DELETE FROM notifications WHERE user_id = ?', [id]).catch(() => {});
        await conn.query('DELETE FROM auth_codes WHERE email = (SELECT email FROM users WHERE user_id = ?)', [id]).catch(() => {});
        const [r] = await conn.query('DELETE FROM users WHERE user_id = ?', [id]);
        await conn.commit();
        return { ok: r.affectedRows > 0 };
    } catch (err) {
        await conn.rollback();
        if (err && (err.code === 'ER_ROW_IS_REFERENCED_2' || err.code === 'ER_ROW_IS_REFERENCED')) {
            return { ok: false, inUse: true };
        }
        throw err;
    } finally {
        conn.release();
    }
}

async function setPassword(id, passwordHash) {
    await pool.query('UPDATE users SET password_hash = ? WHERE user_id = ?', [passwordHash, id]);
}

async function linkGoogle(id, sub) {
    await pool.query('UPDATE users SET google_sub = ? WHERE user_id = ? AND google_sub IS NULL', [sub, id]);
}

async function countActiveAdmins() {
    const [[r]] = await pool.query(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1`);
    return Number(r.n) || 0;
}

/** Whether this account is still allowed to use BOARDLINK (signed-in check). */
async function isStillActive(id) {
    const [rows] = await pool.query('SELECT is_active FROM users WHERE user_id = ? LIMIT 1', [id]);
    return !!(rows[0] && rows[0].is_active);
}

module.exports = {
    findByUsername, findByEmail, findById, findAll, findByRoles, create, deactivate,
    ensureAccountColumns, uniqueUsername, findByGoogleSub, createPending, approve, rejectPending,
    retire, reactivate, changeType, deletePermanently, setPassword, linkGoogle, countActiveAdmins,
    isStillActive,
};
