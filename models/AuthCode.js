// ============================================================
// models/AuthCode.js — six-digit codes sent by e-mail
// ============================================================
//
// Used to prove a person owns the Gmail address they typed:
//   'signup'  creating an account (the sign-up details wait in `payload`)
//   'reset'   choosing a new password ("Forgot password?")
//
// Only a hash of each code is stored. A code works once, for 15
// minutes, and is locked after 5 wrong tries. Asking for a new code
// replaces the old one.

const crypto = require('crypto');
const pool = require('../config/db');

const TTL_MIN = Number(process.env.AUTH_CODE_MINUTES || 15);
const MAX_TRIES = 5;

let ready = null;
function ensureTable() {
    if (!ready) {
        ready = pool.query(`
            CREATE TABLE IF NOT EXISTS auth_codes (
                code_id     INT AUTO_INCREMENT PRIMARY KEY,
                email       VARCHAR(100) NOT NULL,
                purpose     VARCHAR(10)  NOT NULL,
                code_hash   CHAR(64)     NOT NULL,
                payload     TEXT,
                attempts    INT          NOT NULL DEFAULT 0,
                expires_at  DATETIME     NOT NULL,
                created_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_auth_codes (email, purpose)
            )`).catch(err => { ready = null; throw err; });
    }
    return ready;
}

const hash = (email, purpose, code) =>
    crypto.createHash('sha256').update(`${email}|${purpose}|${code}|${process.env.SESSION_SECRET || ''}`).digest('hex');

/** Makes a new code (replacing any earlier one) and returns it. */
async function issue(email, purpose, payload = null) {
    await ensureTable();
    email = String(email).trim().toLowerCase();
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await pool.query('DELETE FROM auth_codes WHERE email = ? AND purpose = ?', [email, purpose]);
    await pool.query(
        `INSERT INTO auth_codes (email, purpose, code_hash, payload, expires_at)
         VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
        [email, purpose, hash(email, purpose, code), payload ? JSON.stringify(payload) : null, TTL_MIN]);
    return code;
}

/** Seconds since the last code for this address and purpose (null if none). */
async function secondsSinceLast(email, purpose) {
    await ensureTable();
    const [rows] = await pool.query(
        `SELECT TIMESTAMPDIFF(SECOND, created_at, NOW()) AS s FROM auth_codes
          WHERE email = ? AND purpose = ? ORDER BY code_id DESC LIMIT 1`,
        [String(email).trim().toLowerCase(), purpose]);
    return rows.length ? Number(rows[0].s) : null;
}

/**
 * Checks a code. Returns { ok: true, payload } once — the code is then
 * used up — or { ok: false, reason: 'none'|'expired'|'locked'|'wrong' }.
 */
async function verify(email, purpose, code) {
    await ensureTable();
    email = String(email).trim().toLowerCase();
    const [rows] = await pool.query(
        `SELECT code_id, code_hash, payload, attempts, expires_at < NOW() AS expired
           FROM auth_codes WHERE email = ? AND purpose = ? ORDER BY code_id DESC LIMIT 1`,
        [email, purpose]);
    const row = rows[0];
    if (!row) return { ok: false, reason: 'none' };
    if (row.expired) return { ok: false, reason: 'expired' };
    if (row.attempts >= MAX_TRIES) return { ok: false, reason: 'locked' };
    const given = hash(email, purpose, String(code || '').replace(/\D/g, ''));
    const same = crypto.timingSafeEqual(Buffer.from(given), Buffer.from(row.code_hash));
    if (!same) {
        await pool.query('UPDATE auth_codes SET attempts = attempts + 1 WHERE code_id = ?', [row.code_id]);
        return { ok: false, reason: row.attempts + 1 >= MAX_TRIES ? 'locked' : 'wrong' };
    }
    await pool.query('DELETE FROM auth_codes WHERE code_id = ?', [row.code_id]);
    return { ok: true, payload: row.payload ? JSON.parse(row.payload) : null };
}

module.exports = { ensureTable, issue, verify, secondsSinceLast, TTL_MIN, MAX_TRIES, _hash: hash };
