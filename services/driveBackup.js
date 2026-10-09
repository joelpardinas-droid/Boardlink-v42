// ============================================================
// services/driveBackup.js — backup copies of the Digital Archive
// in Google Drive
// ============================================================
//
// The archive lives on the CSPC server. This keeps an extra copy of
// every archived document AND every archived meeting agenda in the
// office's Google Drive, in case the server is lost, sorted like this:
//
//   BOARDLINK Backup/
//     Board Resolutions & Documents/
//       Board of Trustees/   Academic Council/   Administrative Council/   RIC Council/
//     Meeting Agendas/
//       Board of Trustees/   Academic Council/   Administrative Council/   RIC Council/
//         <meeting no. - title (date)>/   1. <agenda item>.pdf   2. <video>.mp4 …
//
// The Board Secretary connects a Google account ONCE (Settings >
// Google Drive backup). BOARDLINK then may create files only in the
// folder it made itself ("drive.file" permission) — it cannot see
// anything else in that Drive. The permission is kept encrypted in the
// database (app_settings), using SESSION_SECRET as the key.
//
// Backups run in the background after each document is archived, and
// "Back up now" copies anything that was missed (e.g. while offline).

const crypto = require('crypto');
const pool = require('../config/db');
const drive = require('./googleDrive');

const AUTH_URL = () => process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const ROOT_FOLDER = 'BOARDLINK Backup';
const DOCS_FOLDER = 'Board Resolutions & Documents';
const AGENDAS_FOLDER = 'Meeting Agendas';
const BODIES = ['Board of Trustees', 'Academic Council', 'Administrative Council', 'RIC Council'];
const LAYOUT = '3';          // folder layout version (1 = everything in one "Digital Archive" folder;
                             // 2 = by board/council; 3 = Board Resolutions also in year folders, v87)

const enabled = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

// ── storage ──────────────────────────────────────────────────

let ready = null;
function ensureTables() {
    if (!ready) {
        ready = (async () => {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS app_settings (
                    setting_key   VARCHAR(64) PRIMARY KEY,
                    setting_value TEXT,
                    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                )`);
            const [have] = await pool.query(
                `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'documents'`);
            const names = new Set(have.map(r => r.c));
            if (!names.has('drive_backup_id')) {
                await pool.query('ALTER TABLE documents ADD COLUMN drive_backup_id VARCHAR(128) NULL');
                console.log('  ✅  Database updated: documents.drive_backup_id added (Google Drive backup)');
            }
            if (!names.has('drive_backup_at')) {
                await pool.query('ALTER TABLE documents ADD COLUMN drive_backup_at DATETIME NULL');
            }
            // The governing body a document belongs to (its backup folder).
            if (!names.has('governing_body')) {
                await pool.query(`ALTER TABLE documents ADD COLUMN governing_body VARCHAR(60) NULL`);
                await pool.query(`UPDATE documents SET governing_body = 'Board of Trustees' WHERE governing_body IS NULL`);
                console.log('  ✅  Database updated: documents.governing_body added');
            }
            // Archived meeting agendas are backed up too.
            await require('./agendaArchive').ensureTables();
            const [ag] = await pool.query(
                `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agenda_archive'`);
            const agNames = new Set(ag.map(r => r.c));
            if (!agNames.has('drive_backup_id')) {
                await pool.query('ALTER TABLE agenda_archive ADD COLUMN drive_backup_id VARCHAR(128) NULL');
                await pool.query('ALTER TABLE agenda_archive ADD COLUMN drive_backup_at DATETIME NULL');
                console.log('  ✅  Database updated: agenda_archive.drive_backup_id added (Google Drive backup)');
            }
        })().catch(err => { ready = null; throw err; });
    }
    return ready;
}

const KEY = () => crypto.createHash('sha256').update(`drive|${process.env.SESSION_SECRET || 'boardlink'}`).digest();
function seal(text) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', KEY(), iv);
    const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function unseal(blob) {
    try {
        const [iv, tag, enc] = String(blob).split('.').map(x => Buffer.from(x, 'base64'));
        const d = crypto.createDecipheriv('aes-256-gcm', KEY(), iv);
        d.setAuthTag(tag);
        return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
    } catch (_) { return null; }   // SESSION_SECRET changed: connect again
}

async function getSettings() {
    await ensureTables();
    const [rows] = await pool.query(`SELECT setting_key, setting_value FROM app_settings WHERE setting_key LIKE 'drive_%'`);
    return Object.fromEntries(rows.map(r => [r.setting_key, r.setting_value]));
}
async function setSetting(key, value) {
    await ensureTables();
    if (value === null || value === undefined) {
        await pool.query('DELETE FROM app_settings WHERE setting_key = ?', [key]);
    } else {
        await pool.query(
            `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`, [key, String(value)]);
    }
}

// ── connecting ───────────────────────────────────────────────

function redirectUrl(req) {
    if (process.env.DRIVE_REDIRECT_URL) return process.env.DRIVE_REDIRECT_URL;
    return `${req.protocol}://${req.get('host')}/settings/drive/callback`;
}

function connectUrl(req) {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.driveState = state;
    const q = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        redirect_uri: redirectUrl(req),
        response_type: 'code',
        scope: 'openid email https://www.googleapis.com/auth/drive.file',
        access_type: 'offline',          // a lasting permission, so backups run unattended
        prompt: 'consent',
        include_granted_scopes: 'true',
        state,
    });
    return `${AUTH_URL()}?${q}`;
}

/** After Google's consent page. Returns { ok } or { ok: false, message }. */
async function finishConnect(req) {
    const { code, state, error } = req.query;
    const expected = req.session.driveState;
    delete req.session.driveState;
    if (error) return { ok: false, message: 'Connecting Google Drive was cancelled.' };
    if (!code || !state || state !== expected) return { ok: false, message: 'The connection expired. Please try again.' };
    try {
        const t = await drive.exchangeCode(String(code), redirectUrl(req));
        if (!t.refreshToken) {
            return { ok: false, message: 'Google did not give a lasting permission. Remove BOARDLINK at myaccount.google.com/permissions, then connect again.' };
        }
        // The backup folders, made by BOARDLINK itself.
        folderCache.clear();
        const root = await drive.ensureFolder(ROOT_FOLDER, t.accessToken);
        await setSetting('drive_refresh', seal(t.refreshToken));
        await setSetting('drive_email', t.email || '');
        await setSetting('drive_root', root);
        await setSetting('drive_folder', root);
        await setSetting('drive_layout', LAYOUT);
        await setSetting('drive_connected_at', new Date().toISOString());
        await setSetting('drive_last_error', null);
        tokenCache = { token: t.accessToken, until: Date.now() + (t.expiresIn - 60) * 1000 };
        // Earlier backups were in another account's Drive: start again here.
        await pool.query('UPDATE documents SET drive_backup_id = NULL, drive_backup_at = NULL');
        await pool.query('UPDATE agenda_archive SET drive_backup_id = NULL, drive_backup_at = NULL');
        console.log(`[drive backup] connected to ${t.email || 'a Google account'}`);
        backupPendingInBackground();
        return { ok: true };
    } catch (err) {
        console.error('[drive backup] connect failed:', err.message);
        return { ok: false, message: err.message };
    }
}

async function disconnect() {
    const s = await getSettings();
    const refresh = s.drive_refresh ? unseal(s.drive_refresh) : null;
    if (refresh) {
        fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, { method: 'POST', signal: AbortSignal.timeout(10000) })
            .catch(() => {});
    }
    for (const k of ['drive_refresh', 'drive_email', 'drive_root', 'drive_folder', 'drive_connected_at', 'drive_last_error', 'drive_last_backup', 'drive_layout']) {
        await setSetting(k, null);
    }
    tokenCache = null;
    folderCache.clear();
}

let tokenCache = null;
async function accessToken() {
    if (tokenCache && tokenCache.until > Date.now()) return tokenCache.token;
    const s = await getSettings();
    if (!s.drive_refresh) throw new drive.DriveError('Google Drive is not connected.', { auth: true });
    const refresh = unseal(s.drive_refresh);
    if (!refresh) throw new drive.DriveError('The saved Google Drive connection can no longer be read (the server key changed). Connect it again.', { auth: true });
    const t = await drive.refreshAccessToken(refresh);
    tokenCache = { token: t.token, until: Date.now() + (t.expiresIn - 60) * 1000 };
    return t.token;
}

// ── backing up ───────────────────────────────────────────────

const safeName = s => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim();

// ── folders ──────────────────────────────────────────────────

const folderCache = new Map();            // "a/b/c" → Drive folder id

/** The id of BOARDLINK Backup/<parts…>, making folders that are missing. */
async function folderFor(parts, token) {
    let parent = null, key = '';
    for (const name of [ROOT_FOLDER, ...parts]) {
        key = key ? `${key}/${name}` : name;
        let id = folderCache.get(key);
        if (!id) {
            id = await drive.ensureFolder(safeName(name).slice(0, 200) || 'Untitled', token, parent);
            folderCache.set(key, id);
        }
        parent = id;
    }
    return parent;
}

/**
 * Before a run: the old single-folder layout is replaced by the sorted
 * one (everything is copied again into the new folders), and a backup
 * folder deleted in Drive is made again.
 */
async function checkFolders(token) {
    const s = await getSettings();
    let root = s.drive_root;
    const gone = !root || !(await drive.folderExists(root, token));
    // v87: from layout 2 the copies are only MOVED into year folders, not copied again.
    if (!gone && s.drive_layout === '2' && LAYOUT === '3') {
        await moveResolutionsIntoYears(token);
        await setSetting('drive_layout', LAYOUT);
        return false;
    }
    if (gone || s.drive_layout !== LAYOUT) {
        folderCache.clear();
        root = await drive.ensureFolder(ROOT_FOLDER, token);
        await setSetting('drive_root', root);
        await setSetting('drive_folder', root);
        await setSetting('drive_layout', LAYOUT);
        await pool.query('UPDATE documents SET drive_backup_id = NULL');
        await pool.query('UPDATE agenda_archive SET drive_backup_id = NULL');
        console.log(`[drive backup] ${gone ? 'backup folder was missing' : 'new folder layout'}: copying everything again`);
        return true;
    }
    return false;
}

/** The Drive folder of an archived document (v87: resolutions by year). */
function docParts(doc) {
    const body = BODIES.includes(doc.governing_body) ? doc.governing_body : 'Board of Trustees';
    return (doc.doc_type || 'Resolution') === 'Resolution'
        ? [DOCS_FOLDER, body, String(doc.doc_year || 'No year')]
        : [DOCS_FOLDER, body];
}

/** Layout 2 → 3: moves the resolutions already in Drive into their year folders. */
async function moveResolutionsIntoYears(token) {
    const [rows] = await pool.query(
        `SELECT document_id, doc_type, doc_year, governing_body, drive_backup_id FROM documents
          WHERE drive_backup_id IS NOT NULL AND doc_type = 'Resolution'`);
    let moved = 0;
    for (const d of rows) {
        try {
            if (await drive.moveInto(d.drive_backup_id, await folderFor(docParts(d), token), token)) moved++;
        } catch (err) {
            // The copy was deleted in Drive: copy it again on the next run.
            if (err.status === 404) await pool.query('UPDATE documents SET drive_backup_id = NULL WHERE document_id = ?', [d.document_id]);
            else throw err;
        }
    }
    console.log(`[drive backup] ${moved} resolution(s) moved into year folders`);
}

const isPdfFile = file => { try { return require('fs').readFileSync(file).subarray(0, 5).toString('latin1') === '%PDF-'; } catch (_) { return false; } };

/** Uploads into a folder; makes a new copy when the old one was deleted in Drive. */
async function put(file, { name, mimeType, parts, existingId }, token) {
    const folderId = await folderFor(parts, token);
    try {
        return await drive.upload(file, { name, mimeType, folderId, existingId }, token);
    } catch (err) {
        if (err.status !== 404) throw err;
        // The copy or its folder was deleted in Drive: make them again.
        folderCache.clear();
        return drive.upload(file, { name, mimeType, folderId: await folderFor(parts, token) }, token);
    }
}

async function noteError(err, what) {
    if (err.auth) tokenCache = null;
    await setSetting('drive_last_error', `${new Date().toISOString()}|${err.message}`).catch(() => {});
    console.warn(`[drive backup] ${what} not backed up:`, err.message);
    return { ok: false, message: err.message };
}

/** Copies one archived document to Drive. Returns { ok, skipped?, message? }. */
async function backupDocument(documentId) {
    const s = await getSettings();
    if (!s.drive_refresh) return { ok: false, skipped: true, message: 'not connected' };
    const [[doc]] = await pool.query(
        'SELECT document_id, title, doc_type, category, doc_year, file_path, drive_backup_id, governing_body FROM documents WHERE document_id = ?', [documentId]);
    if (!doc) return { ok: false, skipped: true, message: 'no such document' };
    const file = doc.file_path ? require('./documentIndexer').resolveFile(doc.file_path) : null;
    if (!file) return { ok: false, skipped: true, message: 'no file' };
    const pdf = isPdfFile(file);
    const label = doc.category ? (doc.doc_type === 'Resolution' || !doc.doc_type ? `Resolution No. ${doc.category} - ` : `${doc.category} - `) : '';
    const name = safeName(`${label}${doc.title}`).slice(0, 200) + (pdf ? '.pdf' : '');
    try {
        const token = await accessToken();
        const parts = docParts(doc);
        const id = await put(file, { name, mimeType: pdf ? 'application/pdf' : 'application/octet-stream',
                                     parts, existingId: doc.drive_backup_id }, token);
        // A copy made before (or whose year was corrected) goes into the right folder.
        if (doc.drive_backup_id) await drive.moveInto(id, await folderFor(parts, token), token).catch(() => {});
        await pool.query('UPDATE documents SET drive_backup_id = ?, drive_backup_at = NOW() WHERE document_id = ?', [id, doc.document_id]);
        await setSetting('drive_last_backup', new Date().toISOString());
        await setSetting('drive_last_error', null);
        return { ok: true };
    } catch (err) {
        return noteError(err, `document ${documentId}`);
    }
}

/** The folder name of a meeting: "BOT-2026-001 - 1st Regular Meeting … (2026-06-20)". */
function meetingFolder(a) {
    const d = a.meeting_date ? new Date(a.meeting_date) : null;
    const ymd = d && !isNaN(d) ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '';
    return safeName(`${a.meeting_number ? a.meeting_number + ' - ' : ''}${a.meeting_title || 'Meeting'}${ymd ? ` (${ymd})` : ''}`).slice(0, 180);
}

/** Copies one archived agenda item (its PDF or video) to Drive. */
async function backupAgendaItem(itemId) {
    const s = await getSettings();
    if (!s.drive_refresh) return { ok: false, skipped: true, message: 'not connected' };
    const [[a]] = await pool.query(
        `SELECT a.item_id, a.meeting_type, a.meeting_number, a.meeting_title, a.meeting_date, a.item_order, a.item_title,
                a.drive_backup_id, i.item_pdf, i.item_pdf_name, i.item_video, i.item_video_name
           FROM agenda_archive a JOIN meeting_agenda_items i ON i.item_id = a.item_id
          WHERE a.item_id = ?`, [itemId]);
    if (!a) return { ok: false, skipped: true, message: 'not archived' };
    let file = null, ext = '', mime = 'application/pdf';
    if (a.item_video) {
        file = require('./itemVideoService').filePath(a.item_video);
        ext = require('path').extname(a.item_video) || '.mp4';
        mime = /\.(mp3|m4a|wav|ogg)$/i.test(ext) ? 'audio/mpeg' : 'video/mp4';
    } else if (a.item_pdf) {
        file = require('./itemPdfService').resolveItemFile(a.item_pdf);
        ext = '.pdf';
    }
    if (!file) return { ok: false, skipped: true, message: 'no paper attached' };
    const name = safeName(`${a.item_order}. ${a.item_title}`).slice(0, 190) + ext;
    const body = BODIES.includes(a.meeting_type) ? a.meeting_type : 'Board of Trustees';
    try {
        const token = await accessToken();
        const id = await put(file, { name, mimeType: mime, parts: [AGENDAS_FOLDER, body, meetingFolder(a)],
                                     existingId: a.drive_backup_id }, token);
        await pool.query('UPDATE agenda_archive SET drive_backup_id = ?, drive_backup_at = NOW() WHERE item_id = ?', [id, a.item_id]);
        await setSetting('drive_last_backup', new Date().toISOString());
        await setSetting('drive_last_error', null);
        return { ok: true };
    } catch (err) {
        return noteError(err, `agenda item ${itemId}`);
    }
}

/** Backs up every archived document and agenda item that has no copy yet. */
async function backupPending() {
    await ensureTables();
    let done = 0, failed = 0, skipped = 0;
    const settings = await getSettings();
    if (!settings.drive_refresh) return { done, failed, skipped, total: 0 };
    try { await checkFolders(await accessToken()); }
    catch (err) { await noteError(err, 'the backup folder'); return { done, failed: 1, skipped, total: 0 }; }

    const [docs] = await pool.query(
        `SELECT document_id FROM documents WHERE drive_backup_id IS NULL AND file_path IS NOT NULL ORDER BY document_id`);
    const [items] = await pool.query(
        `SELECT a.item_id FROM agenda_archive a JOIN meeting_agenda_items i ON i.item_id = a.item_id
          WHERE a.drive_backup_id IS NULL AND (i.item_pdf IS NOT NULL OR i.item_video IS NOT NULL)
          ORDER BY a.meeting_id, a.item_order`);
    const total = docs.length + items.length;
    const jobs = [...docs.map(r => () => backupDocument(r.document_id)), ...items.map(r => () => backupAgendaItem(r.item_id))];
    for (const job of jobs) {
        const out = await job();
        if (out.ok) done++;
        else if (out.skipped) skipped++;
        else {
            failed++;
            if (/not connected|Connect it again|disconnected/i.test(out.message || '')) break;
        }
    }
    return { done, failed, skipped, total };
}

let chain = Promise.resolve();
let running = false;
function backupInBackground(documentId) {
    if (!enabled()) return;
    chain = chain.then(async () => {
        await checkFolders(await accessToken()).catch(() => {});
        return backupDocument(documentId);
    }).catch(() => {});
}
/** After End Meeting: the meeting's archived agendas are backed up. */
function backupMeetingInBackground(meetingId) {
    if (!enabled()) return chain;
    chain = chain.then(async () => {
        const s = await getSettings();
        if (!s.drive_refresh) return;
        await ensureTables();
        await checkFolders(await accessToken()).catch(() => {});
        const [rows] = await pool.query(`SELECT item_id FROM agenda_archive WHERE meeting_id = ? ORDER BY item_order`, [meetingId]);
        for (const r of rows) await backupAgendaItem(r.item_id);
    }).catch(() => {});
    return chain;
}
function backupPendingInBackground() {
    if (!enabled() || running) return chain;
    running = true;
    chain = chain.then(() => backupPending()).catch(() => {}).finally(() => { running = false; });
    return chain;
}

/**
 * The Board Secretary's own choice: back up (or copy again) only these
 * documents and agenda items. Returns how many were queued.
 */
function backupSelectedInBackground({ docIds = [], itemIds = [] } = {}) {
    const docs  = [...new Set(docIds.map(Number).filter(n => Number.isInteger(n) && n > 0))];
    const items = [...new Set(itemIds.map(Number).filter(n => Number.isInteger(n) && n > 0))];
    if (!enabled() || (!docs.length && !items.length)) return 0;
    chain = chain.then(async () => {
        const s = await getSettings();
        if (!s.drive_refresh) return;
        await ensureTables();
        await checkFolders(await accessToken()).catch(() => {});
        for (const id of docs)  await backupDocument(id);
        for (const id of items) await backupAgendaItem(id);
    }).catch(() => {});
    return docs.length + items.length;
}

/** The lists the "Choose what to back up" page shows. */
async function choices() {
    await ensureTables();
    const [docs] = await pool.query(
        `SELECT document_id, title, doc_type, category, doc_year, governing_body,
                IF(drive_backup_id IS NULL, NULL, drive_backup_at) AS drive_backup_at
           FROM documents WHERE file_path IS NOT NULL
          ORDER BY doc_year DESC, document_id DESC`);
    const [items] = await pool.query(
        `SELECT a.item_id, a.meeting_id, a.meeting_type, a.meeting_number, a.meeting_title, a.meeting_date,
                a.item_order, a.item_title, IF(a.drive_backup_id IS NULL, NULL, a.drive_backup_at) AS drive_backup_at, (i.item_video IS NOT NULL) AS is_video
           FROM agenda_archive a JOIN meeting_agenda_items i ON i.item_id = a.item_id
          WHERE i.item_pdf IS NOT NULL OR i.item_video IS NOT NULL
          ORDER BY a.meeting_date DESC, a.meeting_id DESC, a.item_order`);
    for (const d of docs) if (!BODIES.includes(d.governing_body)) d.governing_body = 'Board of Trustees';
    for (const a of items) if (!BODIES.includes(a.meeting_type)) a.meeting_type = 'Board of Trustees';
    return { docs, items };
}

/** Everything the settings page shows. */
async function status() {
    const s = await getSettings();
    await ensureTables();
    const [[c]] = await pool.query(
        `SELECT COUNT(*) AS total,
                SUM(drive_backup_id IS NOT NULL) AS backed,
                SUM(file_path IS NULL) AS noFile
           FROM documents`);
    const [[g]] = await pool.query(
        `SELECT SUM(i.item_pdf IS NOT NULL OR i.item_video IS NOT NULL) AS total,
                SUM(a.drive_backup_id IS NOT NULL) AS backed
           FROM agenda_archive a JOIN meeting_agenda_items i ON i.item_id = a.item_id`);
    const err = s.drive_last_error ? s.drive_last_error.split('|') : null;
    return {
        enabled: enabled(),
        connected: !!s.drive_refresh,
        email: s.drive_email || null,
        folderUrl: s.drive_root ? `https://drive.google.com/drive/folders/${s.drive_root}` : null,
        connectedAt: s.drive_connected_at || null,
        lastBackup: s.drive_last_backup || null,
        lastError: err ? { at: err[0], message: err.slice(1).join('|') } : null,
        total: Number(c.total) || 0,
        backedUp: Number(c.backed) || 0,
        noFile: Number(c.noFile) || 0,
        agendaTotal: Number(g.total) || 0,
        agendaBackedUp: Number(g.backed) || 0,
        running,
    };
}

function drain() { return chain; }

module.exports = {
    enabled, ensureTables, connectUrl, finishConnect, disconnect, status,
    backupDocument, backupAgendaItem, backupPending, backupInBackground, backupMeetingInBackground,
    backupPendingInBackground, backupSelectedInBackground, choices, drain, redirectUrl, meetingFolder, BODIES,
    _seal: seal, _unseal: unseal,
};
