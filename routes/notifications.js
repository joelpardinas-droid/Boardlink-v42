// ============================================================
// routes/notifications.js — the bell icon's notices
// ============================================================
const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth');
const Notification = require('../models/Notification');

// Only links inside BOARDLINK are followed, never an outside address.
const safeLink = l => (typeof l === 'string' && /^\/(?!\/)/.test(l)) ? l : '/dashboard';

router.get('/', requireAuth, async (req, res) => {
    let notices = [];
    try { notices = await Notification.listForUser(req.session.user.id, 100); }
    catch (err) { console.warn('[notifications] list failed:', err.message); }
    res.render('notifications', { active: '', notices });
});

// For the bell to update itself without reloading the page.
router.get('/count', requireAuth, async (req, res) => {
    try {
        res.json({ unread: await Notification.countUnread(req.session.user.id) });
    } catch (_) { res.json({ unread: 0 }); }
});

// Opening a notice marks it read and goes to what it is about.
router.get('/:id/open', requireAuth, async (req, res) => {
    let link = null;
    try { link = await Notification.markRead(Number(req.params.id), req.session.user.id); }
    catch (err) { console.warn('[notifications] open failed:', err.message); }
    res.redirect(safeLink(link || '/notifications'));
});

router.post('/read-all', requireAuth, async (req, res) => {
    try { await Notification.markAllRead(req.session.user.id); }
    catch (err) { console.warn('[notifications] read-all failed:', err.message); }
    const back = req.get('Referer');
    res.redirect(back && /^https?:\/\/[^/]+\//.test(back) ? new URL(back).pathname + new URL(back).search : '/notifications');
});

module.exports = router;
