// ============================================================
// services/googleDrive.js — talking to Google Drive
// ============================================================
//
// Two jobs, both for the Digital Archive:
//
//   download()  copies ONE file the Board Secretary picked in Google's
//               file picker into BOARDLINK (uploads/). Google Docs are
//               exported as PDF. BOARDLINK only ever sees the file she
//               picked (the "drive.file" permission).
//   upload()    puts a copy of an archived document into the backup
//               folder in the office's Google Drive.
//
// The archive itself always stays on the CSPC server; Drive is only a
// source to import from and a place to keep a backup copy.
//
// Addresses can be changed for testing:
//   GOOGLE_API_BASE   (default https://www.googleapis.com)
//   GOOGLE_TOKEN_URL  (default https://oauth2.googleapis.com/token)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API = () => (process.env.GOOGLE_API_BASE || 'https://www.googleapis.com').replace(/\/+$/, '');
const TOKEN_URL = () => process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const UPLOAD_DIR = require('../config/paths').UPLOAD_DIR;
const MAX_BYTES = Number(process.env.MAX_UPLOAD_MB || 100) * 1024 * 1024;

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const GDOC_MIME = 'application/vnd.google-apps.document';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
// What can be imported into the archive.
const IMPORTABLE = ['application/pdf', 'image/jpeg', 'image/png', GDOC_MIME, DOCX_MIME];

class DriveError extends Error {
    constructor(message, { status = 0, auth = false } = {}) { super(message); this.status = status; this.auth = auth; }
}

async function call(url, token, opts = {}) {
    let r;
    try {
        r = await fetch(url, {
            ...opts,
            signal: AbortSignal.timeout(opts.timeout || 60000),
            headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
        });
    } catch (err) {
        throw new DriveError('BOARDLINK could not reach Google Drive. Check the internet connection.');
    }
    if (r.status === 401 || r.status === 403) {
        let why = '';
        try { why = (await r.json()).error.message || ''; } catch (_) { /* not JSON */ }
        throw new DriveError(why || 'Google Drive did not allow this.', { status: r.status, auth: r.status === 401 });
    }
    if (r.status === 404) throw new DriveError('That file is no longer in Google Drive.', { status: 404 });
    if (!r.ok) throw new DriveError(`Google Drive answered with an error (HTTP ${r.status}).`, { status: r.status });
    return r;
}

/** Name, type and size of one Drive file. */
async function fileInfo(fileId, token) {
    const r = await call(`${API()}/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size&supportsAllDrives=true`, token);
    return r.json();
}

/**
 * Copies a picked Drive file into uploads/ under a random name (like a
 * normal upload). Returns { path, filename, originalname, mimeType }.
 */
async function download(fileId, token) {
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(String(fileId))) throw new DriveError('That is not a Google Drive file.');
    const info = await fileInfo(fileId, token);
    if (!IMPORTABLE.includes(info.mimeType)) {
        throw new DriveError('Only PDF files, scanned images (JPG/PNG), Word files and Google Docs can be added to the archive.');
    }
    if (info.size && Number(info.size) > MAX_BYTES) {
        throw new DriveError(`That file is larger than the ${MAX_BYTES / 1024 / 1024} MB limit.`);
    }
    const isGdoc = info.mimeType === GDOC_MIME;
    const url = isGdoc
        ? `${API()}/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=application/pdf`
        : `${API()}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
    const r = await call(url, token, { timeout: 180000 });
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new DriveError('That file is larger than the upload limit.');

    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const filename = crypto.randomBytes(16).toString('hex');
    const dest = path.join(UPLOAD_DIR, filename);
    fs.writeFileSync(dest, buf);
    const base = String(info.name || 'document').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').slice(0, 180);
    return {
        path: dest, filename,
        originalname: isGdoc ? `${base}.pdf` : base,
        mimeType: isGdoc ? 'application/pdf' : info.mimeType,
        wasWord: info.mimeType === DOCX_MIME,
    };
}

/** Finds or makes a folder by name (inside `parent`, if given). Returns its id. */
async function ensureFolder(name, token, parent = null) {
    const q = [`name = '${name.replace(/'/g, "\\'")}'`, `mimeType = '${FOLDER_MIME}'`, 'trashed = false']
        .concat(parent ? [`'${parent}' in parents`] : []).join(' and ');
    const found = await (await call(`${API()}/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`, token)).json();
    if (found.files && found.files.length) return found.files[0].id;
    const made = await (await call(`${API()}/drive/v3/files?fields=id`, token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parent ? { parents: [parent] } : {}) }),
    })).json();
    return made.id;
}

/**
 * Moves a file BOARDLINK made into another folder (v87: Board Resolutions
 * go into year folders). Does nothing when it is already there.
 */
async function moveInto(fileId, folderId, token) {
    const r = await call(`${API()}/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,parents`, token);
    const parents = (await r.json()).parents || [];
    if (parents.includes(folderId)) return false;
    const q = new URLSearchParams({ addParents: folderId, fields: 'id' });
    if (parents.length) q.set('removeParents', parents.join(','));
    await call(`${API()}/drive/v3/files/${encodeURIComponent(fileId)}?${q}`, token, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    return true;
}

/** Whether a folder still exists and is not in the trash. */
async function folderExists(folderId, token) {
    try {
        const r = await call(`${API()}/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,trashed`, token);
        const j = await r.json();
        return !!j.id && !j.trashed;
    } catch (err) {
        if (err.status === 404) return false;
        throw err;
    }
}

/**
 * Uploads a file into a folder (replacing `existingId` if given, so a
 * re-backup does not make duplicates). Returns the Drive file id.
 */
async function upload(localPath, { name, mimeType = 'application/pdf', folderId, existingId = null }, token) {
    const size = fs.statSync(localPath).size;
    // Google accepts at most 5 MB in one simple request; bigger files (long
    // PDFs, agenda videos) are sent with a "resumable" upload.
    if (size > 4 * 1024 * 1024) return uploadLarge(localPath, size, { name, mimeType, folderId, existingId }, token);
    const data = fs.readFileSync(localPath);
    const boundary = `boardlink${crypto.randomBytes(8).toString('hex')}`;
    const meta = existingId ? { name } : { name, parents: [folderId] };
    const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
        data,
        Buffer.from(`\r\n--${boundary}--`),
    ]);
    const url = existingId
        ? `${API()}/upload/drive/v3/files/${encodeURIComponent(existingId)}?uploadType=multipart&fields=id`
        : `${API()}/upload/drive/v3/files?uploadType=multipart&fields=id`;
    const r = await call(url, token, {
        method: existingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body, timeout: 180000,
    });
    return (await r.json()).id;
}

/** A big file: ask Google for an upload address, then send the file in one stream. */
async function uploadLarge(localPath, size, { name, mimeType, folderId, existingId }, token) {
    const meta = existingId ? { name } : { name, parents: [folderId] };
    const start = existingId
        ? `${API()}/upload/drive/v3/files/${encodeURIComponent(existingId)}?uploadType=resumable&fields=id`
        : `${API()}/upload/drive/v3/files?uploadType=resumable&fields=id`;
    const r = await call(start, token, {
        method: existingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8',
                   'X-Upload-Content-Type': mimeType, 'X-Upload-Content-Length': String(size) },
        body: JSON.stringify(meta),
    });
    const where = r.headers.get('location');
    if (!where) throw new DriveError('Google Drive did not give an upload address.');
    const { Readable } = require('stream');
    const put = await call(where, token, {
        method: 'PUT',
        headers: { 'Content-Type': mimeType, 'Content-Length': String(size) },
        body: Readable.toWeb(fs.createReadStream(localPath)),
        duplex: 'half',
        timeout: 2 * 60 * 60 * 1000,            // a large video on a slow line
    });
    return (await put.json()).id;
}

/** Trades a refresh token for an access token. */
async function refreshAccessToken(refreshToken) {
    let r;
    try {
        r = await fetch(TOKEN_URL(), {
            method: 'POST',
            signal: AbortSignal.timeout(20000),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
                refresh_token: refreshToken, grant_type: 'refresh_token',
            }),
        });
    } catch (_) {
        throw new DriveError('BOARDLINK could not reach Google. Check the internet connection.');
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
        const revoked = j.error === 'invalid_grant';
        throw new DriveError(revoked
            ? 'Google Drive was disconnected (the permission was removed or expired). Connect it again.'
            : `Google refused the sign-in (${j.error || r.status}).`, { auth: revoked });
    }
    return { token: j.access_token, expiresIn: Number(j.expires_in || 3600) };
}

/** Trades the code from Google's consent page for tokens. */
async function exchangeCode(code, redirectUri) {
    const r = await fetch(TOKEN_URL(), {
        method: 'POST',
        signal: AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            code, redirect_uri: redirectUri, grant_type: 'authorization_code',
            client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
        }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new DriveError(`Google refused the connection (${j.error_description || j.error || r.status}).`);
    let email = null;
    try { email = JSON.parse(Buffer.from(String(j.id_token).split('.')[1], 'base64url').toString('utf8')).email || null; }
    catch (_) { /* no id token */ }
    return { accessToken: j.access_token, refreshToken: j.refresh_token || null, expiresIn: Number(j.expires_in || 3600), email };
}

module.exports = {
    moveInto,
    download, upload, ensureFolder, folderExists, fileInfo, refreshAccessToken, exchangeCode,
    DriveError, IMPORTABLE, GDOC_MIME, DOCX_MIME,
};
