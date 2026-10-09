// ============================================================
// controllers/authController.js — Login, Logout, Session
// BOARDLINK | Chapter 3 Sec. 3.2.3 — bcrypt password hashing
// ============================================================

const bcrypt = require('bcryptjs');
const User   = require('../models/User');
const { DEMO_ACCOUNTS, demoEnabled, findDemoAccount } = require('../config/demoAccounts');

// Where to send a user after a successful login. The System
// Administrator is purely a user-management role and does not
// participate in the board workflow, so they go straight to the
// User Management screen. Everyone else lands on the Dashboard.
function homeFor(role) {
    return role === 'admin' ? '/users' : '/dashboard';
}

// ── Sign-in by Gmail address ─────────────────────────────────
// Users sign in with the Gmail address recorded on their account
// and their BOARDLINK password. Until the client's real addresses
// are known, the placeholder accounts in config/demoAccounts.js are
// used (they are also in sql/seed_data.sql). When MySQL is
// unreachable, those same addresses still sign in so every role can
// be demonstrated — outside production only.
const GENERIC_FAIL = 'Invalid Gmail address or password.';
const accountLog = require('../services/accountLog');

function renderLogin(res, error, email, status = 200, notice = null) {
    return res.status(status).render('login', {
        active: '',
        error,
        notice,
        email: email || '',
        demoAccounts: demoEnabled() ? DEMO_ACCOUNTS : [],
        googleEnabled: require('../services/googleAuth').enabled(),
    });
}

const NOTICES = {
    reset:   'Your password was changed. Sign in with your new password.',
    removed: 'You were signed out because this account was removed from BOARDLINK.',
};

exports.showLogin = (req, res) => {
    // Already signed in: go straight in.
    if (req.session && req.session.user) {
        return res.redirect(req.session.user.role === 'admin' ? '/users' : '/dashboard');
    }
    renderLogin(res, null, '', 200, NOTICES[req.query.notice] || null);
};

exports.processLogin = async (req, res) => {
    // The role is always looked up from the account record, never
    // taken from user input.
    const email    = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!email || !password) {
        return renderLogin(res, 'Gmail address and password are required.', email);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return renderLogin(res, 'Enter your full Gmail address, e.g. juan.delacruz@gmail.com.', email);
    }

    let user;
    try {
        user = await User.findByEmail(email);
    } catch (err) {
        // The database is genuinely unreachable. Use the demo
        // accounts so the views still render during development.
        console.error('Login DB error — falling back to demo accounts:', err.message);
        const demo = findDemoAccount(email);
        if (demo) return startDemoSession(req, res, demo);
        return renderLogin(res, GENERIC_FAIL, email);
    }

    if (user) {
        const ok = await bcrypt.compare(password, user.password_hash);
        if (!ok) {
            await accountLog.add('sign_in_failed', { user, req, details: 'Wrong password' });
            return renderLogin(res, GENERIC_FAIL, email);
        }
        // Waiting for approval, or removed (e.g. retired from a council).
        // Only told after the right password, so the page does not reveal
        // the state of other people's accounts.
        const blocked = require('./accountController').blockedMessage(user);
        if (blocked) {
            await accountLog.add('sign_in_failed', { user, req,
                details: user.account_status === 'pending' ? 'Account still waiting for approval' : 'Account was removed from BOARDLINK' });
            return renderLogin(res, blocked, email);
        }
        await accountLog.add('signed_in', { user, req, details: 'With Gmail address and password' });
        // A new session id on every sign-in (v86), so an id known before
        // signing in cannot be used afterwards.
        return req.session.regenerate(err => {
            if (err) console.warn('[session] regenerate failed:', err.message);
            req.session.user = {
                id:           user.user_id,
                username:     user.username,
                email:        user.email,
                fullName:     user.full_name,
                role:         user.role,
                council_type: user.council_type || null,
            };
            res.redirect(homeFor(user.role));
        });
    }

    // No such address in the database. While the database is up,
    // only its own accounts can sign in (the mock-up addresses are
    // seeded there with real password hashes).
    await accountLog.add('sign_in_failed', { email, req, details: 'No account with this Gmail address' });
    return renderLogin(res, GENERIC_FAIL, email);
};

function startDemoSession(req, res, demo) {
    req.session.user = {
        id:           demo.id,
        username:     demo.email.split('@')[0],
        email:        demo.email,
        fullName:     demo.fullName,
        role:         demo.role,
        council_type: demo.council_type,
    };
    return res.redirect(homeFor(demo.role));
}

exports.showDashboard = async (req, res) => {
    // Admin doesn't participate in board workflow — bounce to /users
    if (req.session.user && req.session.user.role === 'admin') {
        return res.redirect('/users');
    }
    // Real numbers and the latest archived documents. When the database
    // cannot be reached the tiles show a dash rather than made-up figures.
    const Document = require('../models/Document');
    let counts = null, recent = [];
    try {
        [counts, recent] = await Promise.all([Document.dashboardCounts(), Document.findRecent(5)]);
    } catch (err) {
        console.warn('[dashboard] database not reachable:', err.code || err.message);
    }
    res.render('dashboard', { active: 'dashboard', counts, recent });
};

exports.logout = async (req, res) => {
    const u = req.session && req.session.user;
    if (u) await accountLog.add('signed_out', { user: u, req });
    req.session.destroy(() => res.redirect('/'));
};
