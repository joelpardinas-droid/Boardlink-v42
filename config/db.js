// ============================================================
// config/db.js — MySQL Connection Pool (mysql2)
// BOARDLINK | Chapter 3 Sec. 3.4 & 3.6 — MySQL 8.0 + mysql2 3.x
// ============================================================
//
// Establishes the database connection pool used by every Model.
// The pool is created once at application startup and reused for
// the lifetime of the process, which matches the non-blocking
// I/O model described in Chapter 3 Section 3.4.

const mysql = require('mysql2/promise');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });  // works from any folder

const pool = mysql.createPool({
    host:            process.env.DB_HOST     || 'localhost',
    port:            process.env.DB_PORT     || 3306,
    user:            process.env.DB_USER     || 'root',
    password:        process.env.DB_PASSWORD || '',
    database:        process.env.DB_NAME     || 'boardlink',
    waitForConnections: true,
    connectionLimit:    10,
    queueLimit:         0,
    // Use parameterized queries only — SQL injection protection
    // is enforced by the driver when `?` placeholders are used.
});

// One-shot connectivity check at startup. This is intentionally
// non-fatal: during early development the database may not exist
// yet, and we still want the server to boot so that views render.
(async () => {
    try {
        const conn = await pool.getConnection();
        console.log('  ✅  MySQL connection pool ready');
        conn.release();
    } catch (err) {
        console.warn('  ⚠️   MySQL not reachable yet:', err.code || err.message);
        console.warn('       Models will throw until the database is available.');
    }
})();

module.exports = pool;
