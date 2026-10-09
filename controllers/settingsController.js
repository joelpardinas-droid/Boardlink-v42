// ============================================================
// controllers/settingsController.js — Google Drive backup settings
// (Board Secretary only)
// ============================================================
const backup = require('../services/driveBackup');

const DONE = {
    connected:    'Google Drive is connected. Every archived document is being copied to the "BOARDLINK Backup" folder now.',
    disconnected: 'Google Drive was disconnected. The copies already in Drive were not deleted.',
    started:      'Backing up now. Refresh this page in a minute to see the result.',
};

/** "Choose what to back up": the Secretary ticks documents and agendas. */
exports.choose = async (req, res) => {
    let status = null, lists = { docs: [], items: [] }, dbDown = false;
    try { status = await backup.status(); lists = await backup.choices(); }
    catch (err) { dbDown = true; console.warn('[drive settings]', err.message); }
    if (status && !status.connected) return res.redirect('/settings/drive');
    const n = Number(req.query.queued) || 0;
    res.render('settings-drive-choose', {
        active: 'drive', status, dbDown, ...lists,
        tab: req.query.tab === 'agendas' ? 'agendas' : 'docs',
        done: n ? `${n} file${n === 1 ? ' is' : 's are'} being copied to Google Drive. Refresh in a minute to see them marked "In Drive".` : null,
        error: req.query.error === 'none' ? 'Tick at least one document or agenda first.' : null,
    });
};

exports.backupSelected = (req, res) => {
    const list = v => (Array.isArray(v) ? v : (v ? [v] : []));
    const b = req.body || {};
    const n = backup.backupSelectedInBackground({ docIds: list(b.doc), itemIds: list(b.item) });
    const tab = b.tab === 'agendas' ? 'agendas' : 'docs';
    res.redirect(n ? `/settings/drive/choose?tab=${tab}&queued=${n}` : `/settings/drive/choose?tab=${tab}&error=none`);
};

exports.show = async (req, res) => {
    let status = null, dbDown = false;
    try { status = await backup.status(); } catch (err) { dbDown = true; console.warn('[drive settings]', err.message); }
    res.render('settings-drive', {
        active: 'drive', status, dbDown,
        redirectUrl: backup.redirectUrl(req),
        done: DONE[req.query.done] || null,
        error: req.query.error ? String(req.query.error).slice(0, 300) : null,
    });
};

exports.connect = (req, res) => {
    if (!backup.enabled()) return res.redirect('/settings/drive');
    res.redirect(backup.connectUrl(req));
};

exports.callback = async (req, res) => {
    const r = await backup.finishConnect(req);
    if (!r.ok) return res.redirect(`/settings/drive?error=${encodeURIComponent(r.message)}`);
    res.redirect('/settings/drive?done=connected');
};

exports.backupNow = (req, res) => {
    backup.backupPendingInBackground();
    res.redirect('/settings/drive?done=started');
};

exports.disconnect = async (req, res) => {
    await backup.disconnect().catch(err => console.warn('[drive settings] disconnect:', err.message));
    res.redirect('/settings/drive?done=disconnected');
};
