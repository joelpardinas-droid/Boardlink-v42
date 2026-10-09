// ============================================================
// controllers/accountController.js — sign-up, forgot password,
// and "Sign in with Google"
// ============================================================
//
// Signing up never gives access by itself. A new account waits
// ("pending") until the System Administrator approves it and confirms
// which body the person belongs to — otherwise anyone with a Gmail
// address could read the Board's documents.
//
//   Sign-up form:  name, Gmail, body, password → 6-digit code e-mailed
//                  → code entered → account created as pending
//                  → the System Administrator is notified
//   Google:        Google confirms the address → body chosen
//                  → account created as pending (or, for an approved
//                    account, the person is simply signed in)
//   Forgot:        Gmail → 6-digit code e-mailed → code + new password

const bcrypt = require('bcryptjs');
const User = require('../models/User');
const AuthCode = require('../models/AuthCode');
const Notification = require('../models/Notification');
const mail = require('../services/mailService');
const google = require('../services/googleAuth');
const { ACCOUNT_TYPES, roleLabel } = require('../config/roles');

const BCRYPT_ROUNDS = 12;
const RESEND_SECONDS = 60;

// Who may sign up: these addresses only (default Gmail). A list such
// as "gmail.com,cspc.edu.ph" allows both.
const allowedDomains = () => String(process.env.SIGNUP_EMAIL_DOMAINS || 'gmail.com')
    .split(',').map(d => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
const domainOk = email => allowedDomains().includes(String(email).split('@')[1] || '');
const domainHint = () => allowedDomains().map(d => `@${d}`).join(' or ');

// Account types a person may ask for. The System Administrator is
// never self-chosen.
const SIGNUP_TYPES = ACCOUNT_TYPES.filter(t => t.key !== 'admin');
const typeByKey = key => SIGNUP_TYPES.find(t => t.key === key) || null;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normEmail = v => String(v || '').trim().toLowerCase();

function passwordProblem(pw, confirm) {
    if (pw.length < 8) return 'Use at least 8 characters for your password.';
    if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Use both letters and numbers in your password.';
    if (pw.length > 128) return 'That password is too long.';
    if (confirm !== undefined && pw !== confirm) return 'The two passwords are not the same.';
    return null;
}

function render(res, step, opts = {}, status = 200) {
    return res.status(status).render('account', {
        active: '', step,
        error: null, info: null,
        email: '', fullName: '', requested: '',
        types: SIGNUP_TYPES,
        domainHint: domainHint(),
        googleEnabled: google.enabled(),
        minutes: AuthCode.TTL_MIN,
        ...opts,
    });
}

const codeProblem = reason => ({
    none:    'There is no code for this address. Ask for a new one.',
    expired: 'This code has expired. Ask for a new one.',
    locked:  'Too many wrong codes. Ask for a new one.',
    wrong:   'That code is not right. Check the e-mail and try again.',
}[reason] || 'That code is not right.');

// The note shown when e-mail is not set up yet (development only).
const printedNote = printed => (printed
    ? 'E-mail sending is not set up yet, so the code was printed in the BOARDLINK terminal (development only).'
    : null);

/** Tells every active System Administrator about a new sign-up. */
async function notifyAdmins(name, email, typeLabel) {
    try {
        const admins = await User.findByRoles(['admin']);
        for (const a of admins) {
            await Notification.create({
                userId: a.user_id, kind: 'signup',
                message: `New sign-up waiting for approval: ${name} (${email}) asked to join as ${typeLabel}.`,
                link: '/users#pending',
            });
        }
    } catch (err) {
        console.warn('[signup] could not notify the administrator:', err.message);
    }
}

function signIn(req, res, user) {
    require('../services/accountLog').add('signed_in', { user, req, details: 'With Google' }).catch(() => {});
    req.session.regenerate(err => {
        if (err) console.warn('[session] regenerate failed:', err.message);
        req.session.user = {
            id: user.user_id, username: user.username, email: user.email,
            fullName: user.full_name, role: user.role, council_type: user.council_type || null,
        };
        res.redirect(user.role === 'admin' ? '/users' : '/dashboard');
    });
}

/** Why a known account cannot sign in right now, or null. */
function blockedMessage(user) {
    if (user.account_status === 'pending') {
        return 'Your account is waiting for the System Administrator to approve it. You will be able to sign in once it is approved.';
    }
    if (!user.is_active) {
        const when = user.retired_at ? new Date(user.retired_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : null;
        const from = user.retired_from ? ` as ${user.retired_from}` : '';
        return `This account was removed from BOARDLINK${from}${when ? ` on ${when}` : ''}. ` +
            'If this is a mistake, please contact the Office of the Board Secretary.';
    }
    return null;
}

// ── Sign-up with the form ────────────────────────────────────

exports.showSignup = (req, res) => render(res, 'signup');

exports.processSignup = async (req, res) => {
    const fullName = String(req.body.fullName || '').trim().replace(/\s+/g, ' ').slice(0, 100);
    const email = normEmail(req.body.email);
    const requested = String(req.body.requested || '');
    const password = String(req.body.password || '');
    const back = (error) => render(res, 'signup', { error, email, fullName, requested }, 400);

    if (!fullName || !email || !requested || !password) return back('Please fill in every field.');
    if (!EMAIL_RE.test(email)) return back('Enter your full Gmail address, e.g. juan.delacruz@gmail.com.');
    if (!domainOk(email)) return back(`Sign up with your Gmail address (${domainHint()}).`);
    const type = typeByKey(requested);
    if (!type) return back('Choose which body you belong to.');
    const pwProblem = passwordProblem(password, String(req.body.confirm || ''));
    if (pwProblem) return back(pwProblem);

    try {
        const existing = await User.findByEmail(email);
        if (existing) {
            if (existing.account_status === 'pending') return back('This Gmail address has already signed up and is waiting for approval.');
            return back('This Gmail address already has a BOARDLINK account. Sign in, or use "Forgot password?".');
        }
        const since = await AuthCode.secondsSinceLast(email, 'signup');
        if (since !== null && since < RESEND_SECONDS) {
            return render(res, 'signup-verify', { email, info: `A code was just sent. Please wait ${RESEND_SECONDS - since} seconds before asking for another.` });
        }
        const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const code = await AuthCode.issue(email, 'signup', { fullName, passwordHash, requested: type.key });
        const sent = await mail.sendCode(email, code, 'signup', AuthCode.TTL_MIN);
        if (!sent.ok) return back(sent.message);
        return render(res, 'signup-verify', { email, info: printedNote(sent.printed) });
    } catch (err) {
        console.error('[signup] failed:', err.message);
        return back('Signing up is not available right now. Please try again later.');
    }
};

exports.processSignupVerify = async (req, res) => {
    const email = normEmail(req.body.email);
    const code = String(req.body.code || '');
    try {
        const check = await AuthCode.verify(email, 'signup', code);
        if (!check.ok) return render(res, 'signup-verify', { email, error: codeProblem(check.reason) }, 400);
        const p = check.payload || {};
        const type = typeByKey(p.requested);
        if (!type || !p.passwordHash) return render(res, 'signup', { error: 'Please sign up again.' }, 400);
        if (await User.findByEmail(email)) {
            return render(res, 'pending', { email, info: 'This Gmail address already has an account.' });
        }
        const newId = await User.createPending({ fullName: p.fullName, email, passwordHash: p.passwordHash, requested: type });
        await require('../services/accountLog').add('signed_up', { user: { user_id: newId, email, full_name: p.fullName }, req,
            details: `Asked to join as ${type.label} (Gmail address and password)` });
        await notifyAdmins(p.fullName, email, type.label);
        console.log(`[signup] ${email} signed up as ${type.label}; waiting for approval`);
        return render(res, 'pending', { email, fullName: p.fullName, requested: type.label });
    } catch (err) {
        console.error('[signup verify] failed:', err.message);
        return render(res, 'signup-verify', { email, error: 'Something went wrong. Please try again.' }, 500);
    }
};

// ── Forgot password ──────────────────────────────────────────

exports.showForgot = (req, res) => render(res, 'forgot', { email: normEmail(req.query.email) });

exports.processForgot = async (req, res) => {
    const email = normEmail(req.body.email);
    if (!EMAIL_RE.test(email)) return render(res, 'forgot', { email, error: 'Enter the Gmail address you sign in with.' }, 400);
    // The same answer whether or not the address has an account, so the
    // page cannot be used to find out who uses BOARDLINK.
    const same = info => render(res, 'reset', {
        email,
        info: info || `If ${email} has a BOARDLINK account, a 6-digit code was sent to it. It works for ${AuthCode.TTL_MIN} minutes.`,
    });
    try {
        const user = await User.findByEmail(email);
        if (!user || !user.is_active) {
            if (user) console.log(`[forgot] code not sent to ${email}: account is ${user.account_status}`);
            return same();
        }
        const since = await AuthCode.secondsSinceLast(email, 'reset');
        if (since !== null && since < RESEND_SECONDS) {
            return same(`A code was just sent. Please wait ${RESEND_SECONDS - since} seconds before asking for another.`);
        }
        const code = await AuthCode.issue(email, 'reset');
        const sent = await mail.sendCode(email, code, 'reset', AuthCode.TTL_MIN);
        if (!sent.ok) return render(res, 'forgot', { email, error: sent.message }, 503);
        return same(sent.printed ? printedNote(true) : null);
    } catch (err) {
        console.error('[forgot] failed:', err.message);
        return render(res, 'forgot', { email, error: 'This is not available right now. Please try again later.' }, 500);
    }
};

exports.processReset = async (req, res) => {
    const email = normEmail(req.body.email);
    const password = String(req.body.password || '');
    const problem = passwordProblem(password, String(req.body.confirm || ''));
    if (problem) return render(res, 'reset', { email, error: problem }, 400);
    try {
        const check = await AuthCode.verify(email, 'reset', req.body.code);
        if (!check.ok) return render(res, 'reset', { email, error: codeProblem(check.reason) }, 400);
        const user = await User.findByEmail(email);
        if (!user || !user.is_active) return render(res, 'forgot', { email, error: 'This account cannot sign in.' }, 400);
        await User.setPassword(user.user_id, await bcrypt.hash(password, BCRYPT_ROUNDS));
        await require('../services/accountLog').add('password_reset', { user, req, details: 'With the code sent to the Gmail address' });
        console.log(`[forgot] password changed for ${email}`);
        return res.redirect('/?notice=reset');
    } catch (err) {
        console.error('[reset] failed:', err.message);
        return render(res, 'reset', { email, error: 'Something went wrong. Please try again.' }, 500);
    }
};

// ── Sign in / sign up with Google ────────────────────────────

exports.startGoogle = (req, res) => {
    if (!google.enabled()) return res.redirect('/');
    res.redirect(google.startUrl(req));
};

exports.googleCallback = async (req, res) => {
    if (!google.enabled()) return res.redirect('/');
    const g = await google.finish(req);
    if (!g.ok) return render(res, 'signup', { error: g.message }, 400);
    try {
        const user = (await User.findByGoogleSub(g.sub)) || (await User.findByEmail(g.email));
        if (user) {
            const blocked = blockedMessage(user);
            if (blocked) return render(res, 'pending', { email: user.email, error: user.account_status === 'pending' ? null : blocked, blockedOnly: user.account_status !== 'pending' });
            if (!user.google_sub) await User.linkGoogle(user.user_id, g.sub);
            return signIn(req, res, user);
        }
        if (!domainOk(g.email)) {
            return render(res, 'signup', { error: `Sign up with your Gmail address (${domainHint()}). ${g.email} cannot be used.` }, 400);
        }
        // A new person: ask which body they belong to.
        req.session.googleSignup = { sub: g.sub, email: g.email, name: g.name, at: Date.now() };
        return res.redirect('/signup/google');
    } catch (err) {
        console.error('[google] callback failed:', err.message);
        return render(res, 'signup', { error: 'Google sign-in is not available right now.' }, 500);
    }
};

exports.showGoogleFinish = (req, res) => {
    const g = req.session.googleSignup;
    if (!g || Date.now() - g.at > 15 * 60 * 1000) return res.redirect('/signup');
    render(res, 'google-finish', { email: g.email, fullName: g.name });
};

exports.processGoogleFinish = async (req, res) => {
    const g = req.session.googleSignup;
    if (!g || Date.now() - g.at > 15 * 60 * 1000) return res.redirect('/signup');
    const fullName = String(req.body.fullName || g.name || '').trim().replace(/\s+/g, ' ').slice(0, 100);
    const type = typeByKey(String(req.body.requested || ''));
    if (!fullName || !type) {
        return render(res, 'google-finish', { email: g.email, fullName, error: 'Please give your name and choose your body.' }, 400);
    }
    try {
        if (await User.findByEmail(g.email)) return res.redirect('/');
        // Google accounts sign in with Google; this password is never shown
        // or used, and "Forgot password?" can set a real one later.
        const passwordHash = await bcrypt.hash(require('crypto').randomBytes(24).toString('hex'), BCRYPT_ROUNDS);
        const newId = await User.createPending({ fullName, email: g.email, passwordHash, requested: type, googleSub: g.sub });
        await require('../services/accountLog').add('signed_up', { user: { user_id: newId, email: g.email, full_name: fullName }, req,
            details: `Asked to join as ${type.label} (Google)` });
        delete req.session.googleSignup;
        await notifyAdmins(fullName, g.email, type.label);
        console.log(`[signup] ${g.email} signed up with Google as ${type.label}; waiting for approval`);
        return render(res, 'pending', { email: g.email, fullName, requested: type.label });
    } catch (err) {
        console.error('[google signup] failed:', err.message);
        return render(res, 'google-finish', { email: g.email, fullName, error: 'Something went wrong. Please try again.' }, 500);
    }
};

module.exports.blockedMessage = blockedMessage;
module.exports.passwordProblem = passwordProblem;
module.exports.SIGNUP_TYPES = SIGNUP_TYPES;
module.exports.roleLabel = roleLabel;
