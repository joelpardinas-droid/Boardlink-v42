// ============================================================
// controllers/userController.js — Module 1: User & Access Management
// BOARDLINK | Chapter 1 Sec. 1.3 — SO2 Module 1
// BOARDLINK | Chapter 3 Sec. 3.2.3 — bcrypt password hashing
// ============================================================

const bcrypt = require('bcryptjs');
const User   = require('../models/User');
const { fromAccountType, roleLabel, ACCOUNT_TYPES } = require('../config/roles');

const BCRYPT_ROUNDS = 12;
const accountLog = require('../services/accountLog');

exports.list = async (req, res) => {
    let users = [];
    let dbDown = false;
    try {
        users = await User.findAll();
    } catch (_err) { dbDown = true; }
    const status = u => u.account_status || (u.is_active ? 'active' : 'retired');
    res.render('users', {
        active: 'users', dbDown, types: ACCOUNT_TYPES,
        pending: users.filter(u => status(u) === 'pending'),
        current: users.filter(u => status(u) === 'active'),
        removed: users.filter(u => status(u) === 'retired'),
        done: DONE[req.query.done] || null,
    });
};

exports.showAdd = (req, res) => {
    res.render('user-add', { active: 'users', success: null, error: null });
};

exports.processAdd = async (req, res) => {
    const { fullName, username, password } = req.body;
    const email = String(req.body.email || '').trim().toLowerCase();
    // One of the six account types (config/roles.js). Anything else —
    // including the removed Office Staff and College President types —
    // is refused.
    const type  = fromAccountType(req.body.accountType);
    const fail  = error => res.render('user-add', { active: 'users', error, success: null });

    if (!fullName || !username || !email || !req.body.accountType) {
        return fail('All fields are required.');
    }
    if (!type) {
        return fail('Choose one of the listed account types.');
    }
    try {
        const passwordHash = await bcrypt.hash(
            password || 'boardlink-default',
            BCRYPT_ROUNDS
        );
        const newId = await User.create({
            username, passwordHash, role: type.role, fullName, email,
            councilType: type.council_type,
        });
        await accountLog.add('added', {
            user: { user_id: newId, email, full_name: fullName }, actor: req.session.user, req,
            details: `Added as ${roleLabel({ role: type.role, council_type: type.council_type })}`,
        });
    } catch (err) {
        // The Gmail address is the sign-in identity, so a second
        // account with the same address must be refused, not
        // reported as added.
        if (err && err.code === 'ER_DUP_ENTRY') {
            const which = /email/i.test(err.message) ? `Gmail address ${email}` : `username "${username}"`;
            return fail(`Another account already uses the ${which}.`);
        }
        /* otherwise ignored in mockup mode (no database) */
    }

    res.render('user-add', {
        active:  'users',
        success: `User "${fullName}" added as ${roleLabel({ role: type.role, council_type: type.council_type })}.`,
        error:   null,
    });
};

exports.view = async (req, res) => {
    let user = null;
    try {
        user = await User.findById(req.params.id);
    } catch (_err) { /* no database */ }
    if (!user) return res.status(404).render('404', { active: 'users' });
    // Only the System Administrator sees other people's accounts.
    const me = req.session.user;
    if (me.role !== 'admin' && Number(me.id) !== Number(user.user_id)) {
        return res.redirect(me.role === 'admin' ? '/users' : '/dashboard');
    }
    let history = [];
    if (me.role === 'admin') {
        try { history = (await accountLog.list({ userId: user.user_id, perPage: 15 })).rows; }
        catch (err) { console.warn('[users] account history:', err.message); }
    }
    res.render('user-view', {
        active: 'users',
        history, logActions: accountLog.ACTIONS,
        id:     user.user_id,
        user,
        types:  ACCOUNT_TYPES,
        isSelf: Number(me.id) === Number(user.user_id),
        done:   DONE[req.query.done] || null,
        error:  req.query.error ? String(req.query.error).slice(0, 300) : null,
    });
};

// ── Approving, retiring and removing accounts (System Administrator) ──

const DONE = {
    approved:    'The account was approved. The person can sign in now.',
    rejected:    'The sign-up was turned down and removed.',
    retired:     'The person was removed from BOARDLINK. They can no longer sign in, and their name stays on their past comments and records.',
    reactivated: 'The account is active again.',
    type:        'The account type was changed.',
    deleted:     'The account was made by mistake, so it was deleted completely.',
    keptMistake: 'The account was made by mistake, but it already has records in BOARDLINK (comments, uploads or meetings), so it was removed instead of deleted. Its name stays on those records.',
};

// "Account made by mistake" deletes the account completely (v86). An
// account that already has records is removed instead, so the records
// keep their name.
const MISTAKE = 'Account made by mistake';
const REASONS = ['Term ended', 'Retired', 'Resigned', 'No longer with CSPC', 'Moved to another body', MISTAKE, 'Other'];
exports.MISTAKE = MISTAKE;
exports.REASONS = REASONS;

const typeFrom = key => {
    const t = ACCOUNT_TYPES.find(x => x.key === key);
    return t ? { key: t.key, role: t.role, council_type: t.council_type, label: t.label } : null;
};
const back = (res, id, q) => res.redirect(`/users/${id}?${new URLSearchParams(q)}`);

/** Loads the account the action is about; refuses actions on yourself where unsafe. */
async function target(req, res, { notSelf = false } = {}) {
    const id = parseInt(req.params.id, 10);
    let user = null;
    try { user = id > 0 ? await User.findById(id) : null; } catch (_) { /* no database */ }
    if (!user) { res.status(404).render('404', { active: 'users' }); return null; }
    if (notSelf && Number(req.session.user.id) === user.user_id) {
        back(res, id, { error: 'You cannot do this to your own account.' });
        return null;
    }
    return user;
}

/** True when this change would leave BOARDLINK with no active System Administrator. */
async function wouldRemoveLastAdmin(user) {
    return user.role === 'admin' && user.is_active && (await User.countActiveAdmins()) <= 1;
}

exports.approve = async (req, res) => {
    const user = await target(req, res); if (!user) return;
    const type = typeFrom(req.body.accountType || user.requested_type);
    if (!type) return back(res, user.user_id, { error: 'Choose the account type to approve.' });
    await User.approve(user.user_id, type);
    await accountLog.add('approved', { user, actor: req.session.user, req, details: `Approved as ${type.label}` });
    console.log(`[users] ${req.session.user.email} approved ${user.email} as ${type.label}`);
    const to = req.body.from === 'list' ? '/users?done=approved#pending' : `/users/${user.user_id}?done=approved`;
    res.redirect(to);
};

exports.reject = async (req, res) => {
    const user = await target(req, res); if (!user) return;
    await accountLog.add('turned_down', { user, actor: req.session.user, req });
    await User.rejectPending(user.user_id);
    console.log(`[users] ${req.session.user.email} turned down the sign-up of ${user.email}`);
    res.redirect('/users?done=rejected#pending');
};

exports.retire = async (req, res) => {
    const user = await target(req, res, { notSelf: true }); if (!user) return;
    if (await wouldRemoveLastAdmin(user)) return back(res, user.user_id, { error: 'This is the only active System Administrator, so it cannot be removed.' });
    const reason = REASONS.includes(req.body.reason) ? req.body.reason : 'Other';
    const extra = String(req.body.note || '').trim().slice(0, 200);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '') ? req.body.date : new Date().toISOString().slice(0, 10);
    if (reason === MISTAKE) {
        const r = await User.deletePermanently(user.user_id);
        if (r.ok) {
            // The row is gone, so the line keeps only the name and Gmail.
            await accountLog.add('deleted_mistake', { user: { email: user.email, full_name: user.full_name },
                actor: req.session.user, req, details: `${roleLabel(user)}${extra ? ' — ' + extra : ''}` });
            console.log(`[users] ${req.session.user.email} deleted the account of ${user.email} (made by mistake)`);
            return res.redirect('/users?done=deleted');
        }
        if (!r.inUse) return back(res, user.user_id, { error: 'The account could not be deleted. Please try again.' });
        // It has records: fall through and remove it instead.
        await accountLog.add('removed', { user, actor: req.session.user, req,
            details: `${MISTAKE} — kept because it has records in BOARDLINK${extra ? ' — ' + extra : ''}` });
        await User.retire(user.user_id, { from: roleLabel(user), date, note: extra ? `${reason}: ${extra}` : reason });
        return back(res, user.user_id, { done: 'keptMistake' });
    }
    await accountLog.add('removed', { user, actor: req.session.user, req,
        details: `${roleLabel(user)} — ${reason}${extra ? ': ' + extra : ''} (effective ${date})` });
    await User.retire(user.user_id, {
        from: roleLabel(user), date, note: extra ? `${reason}: ${extra}` : reason,
    });
    console.log(`[users] ${req.session.user.email} removed ${user.email} (${roleLabel(user)}, ${reason})`);
    back(res, user.user_id, { done: 'retired' });
};

exports.reactivate = async (req, res) => {
    const user = await target(req, res); if (!user) return;
    const type = typeFrom(req.body.accountType);
    if (!type) return back(res, user.user_id, { error: 'Choose the account type.' });
    await User.reactivate(user.user_id, type);
    await accountLog.add('brought_back', { user, actor: req.session.user, req, details: `Active again as ${type.label}` });
    console.log(`[users] ${req.session.user.email} reactivated ${user.email} as ${type.label}`);
    back(res, user.user_id, { done: 'reactivated' });
};

exports.changeType = async (req, res) => {
    const user = await target(req, res, { notSelf: true }); if (!user) return;
    const type = typeFrom(req.body.accountType);
    if (!type) return back(res, user.user_id, { error: 'Choose the account type.' });
    if (type.role !== 'admin' && await wouldRemoveLastAdmin(user)) {
        return back(res, user.user_id, { error: 'This is the only active System Administrator, so its type cannot be changed.' });
    }
    await User.changeType(user.user_id, type);
    await accountLog.add('type_changed', { user, actor: req.session.user, req, details: `${roleLabel(user)} → ${type.label}` });
    console.log(`[users] ${req.session.user.email} changed ${user.email} to ${type.label}`);
    back(res, user.user_id, { done: 'type' });
};

// The separate "Delete the account completely" form was removed in v86:
// choose the reason "Account made by mistake" under Remove from BOARDLINK.

exports.logs = async (req, res) => {
    const f = {
        q: String(req.query.q || '').trim().slice(0, 100),
        action: accountLog.ACTIONS[req.query.action] ? req.query.action : '',
        from: String(req.query.from || ''), to: String(req.query.to || ''),
        page: req.query.page,
    };
    let result = { rows: [], total: 0, page: 1, pages: 1 }, failed = false;
    try { result = await accountLog.list(f); }
    catch (err) { console.error('[users] account logs:', err.message); failed = true; }
    res.render('user-logs', { active: 'user-logs', f, ...result, failed, actions: accountLog.ACTIONS });
};

exports.DONE = DONE;
