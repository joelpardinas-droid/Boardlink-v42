// ============================================================
// middleware/auth.js — Authentication & Role-Based Access Control
// BOARDLINK | Chapter 3 Sec. 3.3 — Application Tier enforces
// RBAC on every incoming request.
// ============================================================
//
// Two middlewares are exported:
//
//   requireAuth             -> rejects requests without a session
//   requireRole(...allowed) -> silently redirects non-permitted
//                              users to the dashboard
//
// BOARDLINK has six account types (config/roles.js), stored as
// three roles:
//
//   'admin'      — System Administrator
//   'secretary'  — Board Secretary
//   'member'     — Trustees and members of the Administrative,
//                  Academic and RIC Councils (told apart by
//                  users.council_type)
//
// Note: Per the cleaner-mockup directive, when a user attempts
// to reach a route their role does not have permission for, we
// no longer show an Access Denied page. Instead, we redirect
// silently back to the Dashboard. The UI itself only ever
// presents links and buttons that the current role can use, so
// in practice this redirect should never trigger from normal
// navigation — it remains as a server-side safety net.

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    return res.redirect('/');
}

function requireRole(...allowedRoles) {
    return (req, res, next) => {
        if (!req.session || !req.session.user) {
            return res.redirect('/');
        }
        if (!allowedRoles.includes(req.session.user.role)) {
            // Silently redirect to the user's home — System Admin
            // goes to User Management, everyone else to Dashboard.
            const home = req.session.user.role === 'admin' ? '/users' : '/dashboard';
            return res.redirect(home);
        }
        return next();
    };
}

/**
 * The System Administrator manages user accounts only. The menu hides
 * the board pages from that account; this also blocks them when the
 * address is typed in directly.
 */
function blockAdmin(req, res, next) {
    if (req.session && req.session.user && req.session.user.role === 'admin') {
        const wantsJson = /json/.test(req.get('accept') || '') || req.xhr;
        if (wantsJson) return res.status(403).json({ ok: false, error: 'Not available to the System Administrator.' });
        return res.redirect('/users');
    }
    return next();
}

/**
 * Keeps a signed-in session in step with the account. At most every
 * 30 seconds the account is looked up again: if the System
 * Administrator removed it (retired, rejected, deleted) the person is
 * signed out at once, and if their account type changed (moved to
 * another council) the session follows. Demo sessions and a database
 * that cannot be reached are left alone.
 */
const RECHECK_MS = 30 * 1000;
async function refreshSessionUser(req, res, next) {
    const u = req.session && req.session.user;
    if (!u || !u.id || u.id >= 900) return next();               // not signed in, or a demo account
    const now = Date.now();
    if (req.session.checkedAt && now - req.session.checkedAt < RECHECK_MS) return next();
    let row;
    try {
        const pool = require('../config/db');
        const [rows] = await pool.query('SELECT is_active, role, council_type FROM users WHERE user_id = ? LIMIT 1', [u.id]);
        row = rows[0] || null;
    } catch (_) { return next(); }                                 // database down: do not lock everyone out
    if (!row || !row.is_active) {
        console.log(`[auth] signed out user ${u.id}: account no longer active`);
        return req.session.destroy(() => {
            const wantsJson = /json/.test(req.get('accept') || '') || req.xhr;
            if (wantsJson) return res.status(401).json({ ok: false, error: 'Your account was removed from BOARDLINK.' });
            res.redirect('/?notice=removed');
        });
    }
    u.role = row.role;
    u.council_type = row.council_type || null;
    req.session.checkedAt = now;
    return next();
}

module.exports = { requireAuth, requireRole, blockAdmin, refreshSessionUser };
