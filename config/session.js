// ============================================================
// config/session.js — Session Configuration (express-session)
// BOARDLINK | Chapter 3 Sec. 3.6 — Session management for
// authenticated users across the five system roles.
// ============================================================
//
// Sessions are persisted in MySQL rather than in the process's
// own memory. express-session's built-in MemoryStore is fine on
// a developer laptop but is explicitly not meant for production:
//
//   * every restart or crash signs out every user, which for the
//     Board Secretary can mean losing a half-finished agenda; and
//   * it never releases expired sessions, so memory grows for as
//     long as the server stays up.
//
// Storing sessions in the same MySQL 8.0 instance already used
// for board records (Chapter 3 Sec. 3.4) fixes both, and keeps
// session data on-premise alongside everything else.

const session      = require('express-session');
const MySQLStore   = require('express-mysql-session')(session);
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });  // works from any folder

const isProduction = process.env.NODE_ENV === 'production';

// Fail loudly in production rather than silently running on the
// well-known development secret, which would let anyone forge a
// session cookie on a public deployment.
const secret = process.env.SESSION_SECRET || 'boardlink-dev-secret-change-me';
if (isProduction && secret === 'boardlink-dev-secret-change-me') {
    throw new Error(
        'SESSION_SECRET is still the default value. Set a long random ' +
        'SESSION_SECRET in .env before running with NODE_ENV=production.'
    );
}

let store;   // undefined => express-session falls back to MemoryStore
try {
    store = new MySQLStore({
        host:     process.env.DB_HOST     || 'localhost',
        port:     Number(process.env.DB_PORT) || 3306,
        user:     process.env.DB_USER     || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME     || 'boardlink',
        // Create the sessions table automatically on first run so
        // deployment does not need a separate migration step.
        createDatabaseTable: true,
        // Sweep expired rows every 15 minutes.
        clearExpired:        true,
        checkExpirationInterval: 15 * 60 * 1000,
        expiration:              8 * 60 * 60 * 1000,   // matches cookie maxAge
        schema: {
            tableName: 'user_sessions',
            columnNames: { session_id: 'session_id', expires: 'expires', data: 'data' },
        },
    });

    store.on('error', (err) => {
        // A database blip should not take the whole site down.
        console.error('[session store]', err.code || err.message);
    });

    // Resilience wrapper.
    //
    // express-session propagates any store error straight to the
    // request, so an unreachable database turns every page into a
    // 500 — including the login page, leaving no way back in. That
    // is unacceptable both during development (MySQL not configured
    // yet) and in production (a brief database restart should not
    // black out the whole site).
    //
    // Each store method therefore falls back to an in-process
    // MemoryStore when MySQL is unavailable. Sessions served from
    // the fallback do not survive a restart, which is exactly the
    // MemoryStore limitation this file exists to avoid — so the
    // condition is logged loudly rather than passing silently.
    const memoryFallback = new session.MemoryStore();
    let degraded = false;

    const wrap = (name) => {
        const original = store[name] && store[name].bind(store);
        if (!original) return;
        store[name] = function (...args) {
            const done = args[args.length - 1];
            if (typeof done !== 'function') return original(...args);
            const rest = args.slice(0, -1);
            original(...rest, (err, result) => {
                if (!err) {
                    if (degraded) {
                        degraded = false;
                        console.warn('  ✅  Session store reconnected to MySQL.');
                    }
                    return done(null, result);
                }
                if (!degraded) {
                    degraded = true;
                    console.warn('  ⚠️   Session store unreachable (' + (err.code || err.message) + ').');
                    console.warn('       Using in-memory sessions until MySQL returns —');
                    console.warn('       users will be signed out if the server restarts.');
                }
                memoryFallback[name](...rest, done);
            });
        };
    };
    ['get', 'set', 'destroy', 'touch'].forEach(wrap);
} catch (err) {
    // The database is unreachable (common during early development,
    // before MySQL is configured). Keep the server bootable, but be
    // explicit that sessions will not survive a restart.
    console.warn('  ⚠️   Session store unavailable:', err.message);
    console.warn('       Falling back to in-memory sessions — users will be');
    console.warn('       signed out whenever the server restarts.');
    store = undefined;
}

module.exports = session({
    secret,
    store,
    name:              'boardlink.sid',
    resave:            false,
    saveUninitialized: false,
    // Roll the expiry forward while someone is actively working, so a
    // long meeting does not sign the Board Secretary out mid-session.
    rolling:           true,
    cookie: {
        // `secure: true` is enabled in production, where the system is
        // served over HTTPS as described in the Presentation Tier of
        // Chapter 3 Section 3.3. This requires `app.set('trust proxy')`
        // when running behind a reverse proxy such as Caddy or nginx.
        secure:   isProduction,
        httpOnly: true,
        sameSite: 'lax',        // allows normal link navigation, blocks cross-site POSTs
        maxAge:   1000 * 60 * 60 * 8,   // 8-hour working session
    },
});
