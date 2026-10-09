// ============================================================
// server.js — BOARDLINK Main Entry Point
// BSIT 4 | ITEC 321 Web Systems and Technologies 3
// Camarines Sur Polytechnic Colleges | Capstone 2026
// ============================================================
//
// Three-tier architecture entry point as described in Chapter 3
// Section 3.3. This file is deliberately thin: its only job is
// to wire the middleware layer and the route modules together.
// All business logic lives in controllers/, all database logic
// lives in models/, and all external service calls live in
// services/. This separation follows the MVC pattern documented
// in Chapter 3 Section 3.2.2.

const express = require('express');
const path    = require('path');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });  // works from any folder

const sessionMiddleware = require('./config/session');
const requestLogger     = require('./middleware/logger');
const { securityHeaders, generalLimiter } = require('./middleware/security');

// ── Route modules ────────────────────────────────────────────
const authRoutes    = require('./routes/auth');
const archiveRoutes = require('./routes/archive');
const agendaRoutes  = require('./routes/agenda');
const meetingRoutes = require('./routes/meeting');
const ocrRoutes     = require('./routes/ocr');
const userRoutes    = require('./routes/users');
const notificationRoutes = require('./routes/notifications');

const app = express();

// ── Reverse proxy awareness ──────────────────────────────────
// In the deployment described in Chapter 3 Section 3.3, HTTPS is
// terminated by a reverse proxy (Caddy or nginx) which forwards
// plain HTTP to this process. Without `trust proxy`, Express sees
// those requests as insecure and refuses to set the `secure`
// session cookie — the practical symptom being that nobody can
// sign in. It also makes req.ip the real client address rather
// than the proxy's, which the rate limiters depend on.
//
// The value 1 means "trust exactly one proxy hop". Using `true`
// here would let a client spoof X-Forwarded-For and defeat the
// rate limiting.
if (process.env.TRUST_PROXY !== 'false') {
    app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));
}

// ── Crash Protection ─────────────────────────────────────────
// Tesseract.js and other AI workers run in separate threads and
// can throw asynchronously when their dependencies are missing
// (e.g., language model file not yet downloaded). Without this
// guard, an uncaught error in a worker could crash the entire
// server. We log the error so it's still visible during dev,
// but keep the process alive so the user sees a graceful error
// page rather than a dropped connection.
process.on('uncaughtException', (err) => {
    console.error('\n[uncaughtException — server kept alive]:', err.message);
});
process.on('unhandledRejection', (err) => {
    console.error('\n[unhandledRejection — server kept alive]:', err && err.message ? err.message : err);
});

// ── View Engine ──────────────────────────────────────────────
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// ── Middleware ───────────────────────────────────────────────
// Make the configured upload ceilings available to every template,
// so the size shown to the user always matches what the server will
// actually accept. Hardcoding the number in the views is how the
// "max 25 MB" labels came to outlive the 25 MB limit.
app.locals.maxUploadMb = Number(process.env.MAX_UPLOAD_MB || 100);
// One source for account-type labels in every view (config/roles.js).
const roles = require('./config/roles');
app.locals.roleLabel    = roles.roleLabel;
// "Add from Google Drive" on the archive upload page (v57): shown when a
// Google Client ID and a Google API key are set. GOOGLE_PROJECT_NUMBER is
// optional (the "App ID" Google's picker asks for).
app.locals.drivePicker = (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_API_KEY)
    ? { clientId: process.env.GOOGLE_CLIENT_ID, apiKey: process.env.GOOGLE_API_KEY,
        appId: process.env.GOOGLE_PROJECT_NUMBER || null }
    : null;
app.locals.accountTypes = roles.ACCOUNT_TYPES;
app.locals.parseItemSummary = require('./services/summaryFormat').parseItemSummary;
app.locals.maxAudioMb  = Number(process.env.MAX_AUDIO_UPLOAD_MB || 200);

app.use(securityHeaders);
app.use(generalLimiter);
// Bound the size of submitted forms; the default is 100kb but being
// explicit documents the intent. File uploads are handled separately
// by multer, which has its own limits.
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// PDF.js, served from the installed package so the document viewer
// works with no internet access. The legacy build supports older
// phone and tablet browsers. Fonts, character maps and the image
// decoders are needed to draw many real-world (especially scanned)
// PDFs correctly.
const PDFJS_DIR = path.join(__dirname, 'node_modules', 'pdfjs-dist');
const vendorOpts = { maxAge: '7d', immutable: false, index: false };
app.use('/vendor/pdfjs/build',          express.static(path.join(PDFJS_DIR, 'legacy', 'build'), vendorOpts));
app.use('/vendor/pdfjs/cmaps',          express.static(path.join(PDFJS_DIR, 'cmaps'), vendorOpts));
app.use('/vendor/pdfjs/standard_fonts', express.static(path.join(PDFJS_DIR, 'standard_fonts'), vendorOpts));
app.use('/vendor/pdfjs/wasm',           express.static(path.join(PDFJS_DIR, 'wasm'), vendorOpts));
app.use('/vendor/pdfjs/iccs',           express.static(path.join(PDFJS_DIR, 'iccs'), vendorOpts));
app.use(sessionMiddleware);
// Signs out anyone the System Administrator has removed (see middleware/auth.js).
app.use(require('./middleware/auth').refreshSessionUser);
app.use(requestLogger);

// Make the current user available to every view as `currentUser`
// so EJS partials can display the signed-in name and role.
app.use((req, res, next) => {
    res.locals.currentUser = req.session ? req.session.user : null;
    next();
});

// The bell in the top bar: how many notices are unread, and the
// latest few. Only for pages (not downloads or background calls),
// and never allowed to break a page if the database is down.
const Notification = require('./models/Notification');
app.use(async (req, res, next) => {
    res.locals.notifUnread = 0;
    res.locals.notifRecent = [];
    const user = req.session && req.session.user;
    if (!user || req.method !== 'GET' || !req.accepts('html') || req.xhr) return next();
    try {
        const [unread, recent] = await Promise.all([
            Notification.countUnread(user.id),
            Notification.listForUser(user.id, 6),
        ]);
        res.locals.notifUnread = unread;
        res.locals.notifRecent = recent;
    } catch (_) { /* no database: the bell is just empty */ }
    next();
});

// ── Mount Routes ─────────────────────────────────────────────
app.use('/',        authRoutes);
// The System Administrator only manages accounts (see middleware/auth.js).
const { blockAdmin } = require('./middleware/auth');
app.use('/archive', blockAdmin, archiveRoutes);
app.use('/agenda',  blockAdmin, agendaRoutes);
app.use('/meeting', blockAdmin, meetingRoutes);
app.use('/ocr',     blockAdmin, ocrRoutes);
app.use('/users',   userRoutes);
app.use('/notifications', notificationRoutes);
app.use('/settings', require('./routes/settings'));

// ── 404 Handler ──────────────────────────────────────────────
// ── Upload / error handling ──────────────────────────────────
//
// multer rejects an oversized file by throwing LIMIT_FILE_SIZE.
// Without this handler Express returns a raw stack trace, which
// tells the Board Secretary nothing about what went wrong or what
// to do next. JSON endpoints get JSON; page routes get the normal
// error banner.
app.use(async (err, req, res, next) => {
    // Agenda item PDFs (document uploads on the meeting routes) get a
    // clear message too.
    const isMeetingDoc = req.path === '/meeting/create' || /^\/meeting\/\d+\/edit$/.test(req.path)
        || /^\/meeting\/\d+\/item\/\d+\/file$/.test(req.path);
    if (err && isMeetingDoc && ['LIMIT_FILE_SIZE', 'LIMIT_FILE_COUNT'].includes(err.code)) {
        const vidMb = Number(process.env.MAX_VIDEO_UPLOAD_MB || 1024);
        const message = err.code === 'LIMIT_FILE_SIZE'
            ? `One of the attached files is larger than the ${vidMb >= 1024 ? vidMb / 1024 + ' GB' : vidMb + ' MB'} limit.`
            : 'Too many files were attached to this meeting at once.';
        console.warn(`[upload] rejected ${req.path}: ${err.code}`);
        if (req.path === '/meeting/create') {
            const User = require('./models/User');
            return res.status(413).render('meeting-create', {
                governingBodies: require('./config/governance').asList(),
                active: 'meeting',
                users: await User.findAll().catch(() => []),
                error: 'Could not create the meeting: ' + message,
            });
        }
        const editMatch = req.path.match(/^\/meeting\/(\d+)\/edit$/);
        if (editMatch) {
            return res.redirect(`/meeting/${editMatch[1]}/edit?file_error=${err.code === 'LIMIT_FILE_SIZE' ? 'size' : 'count'}`);
        }
        const [, id, itemId] = req.path.match(/^\/meeting\/(\d+)\/item\/(\d+)/);
        return res.redirect(`/meeting/${id}?file_error=size#item-${itemId}`);
    }
    if (err && err.code === 'LIMIT_FILE_SIZE') {
        const isDocument = req.path.startsWith('/archive') || req.path.startsWith('/ocr');
        const limitMb = isDocument
            ? Number(process.env.MAX_UPLOAD_MB || 100)
            : Number(process.env.MAX_AUDIO_UPLOAD_MB || 200);
        const message =
            `That file is larger than the ${limitMb} MB limit. ` +
            (isDocument
                ? 'Try scanning at 300 DPI in grayscale rather than colour, ' +
                  'or split the document and upload it in parts.'
                : 'Try a compressed audio format such as MP3 or M4A rather than WAV.');

        console.warn(`[upload] rejected oversized file on ${req.path} (limit ${limitMb} MB)`);

        // Endpoints the browser calls with fetch() expect JSON.
        if (req.path.endsWith('/analyze')) {
            return res.status(413).json({ ok: false, error: message });
        }
        if (req.path.startsWith('/archive')) {
            return res.status(413).render('upload', {
                active: 'archive', error: message, success: null,
            });
        }
        return res.status(413).render('404', { active: '' });
    }
    return next(err);
});

app.use((req, res) => {
    res.status(404).render('404', { active: '' });
});

// ── Start Server ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
    console.log(`\n  ✅  BOARDLINK running at http://${HOST}:${PORT}\n`);
    // Where uploaded files are kept (UPLOAD_DIR in .env keeps them across versions).
    {
        const paths = require('./config/paths');
        const copied = paths.copyBundledSamples();
        console.log(`  📁  Uploaded files are kept in ${paths.UPLOAD_DIR}${copied ? ` (${copied} sample file(s) copied there)` : ''}`);
    }
    // Remove tables and columns left over from removed features
    // (RSVP, minutes, drafted resolutions, ...), so the database matches the ERD.
    require('./services/dbCleanup').run()
        .catch(err => console.warn('  ⚠️   Could not remove leftover tables:', err.code || err.message));
    // Add new database columns to an existing database, then finish
    // reading any agenda item PDFs interrupted by a restart.
    require('./services/driveBackup').ensureTables()
        .then(() => require('./services/driveBackup').backupPendingInBackground())
        .catch(err => console.warn('  ⚠️   Could not check the database for Drive backup columns:', err.code || err.message));
    require('./models/User').ensureAccountColumns()
        .then(() => require('./models/AuthCode').ensureTable())
        .catch(err => console.warn('  ⚠️   Could not check the database for account columns:', err.code || err.message));
    require('./models/Meeting').ensureWordColumns()
        .catch(err => console.warn('  ⚠️   Could not check the database for Word columns:', err.code || err.message));
    // Columns for videos as agenda items (e.g. the President's Report),
    // then finish any video interrupted by a restart.
    require('./services/itemVideoService').ensureColumns()
        .then(() => setTimeout(() => require('./services/itemVideoService').resumePending(), 4500))
        .catch(err => console.warn('  ⚠️   Could not check the database for video columns:', err.code || err.message));
    // Tables for archived agendas and access requests; meetings that
    // were already completed have their agendas put in the archive too.
    setTimeout(() => require('./services/agendaArchive').backfill(), 2000);
    // v85: members' requests to open an archived Board Resolution or document.
    // v87: approved documents attached to Board Resolutions.
    require('./services/documentAttachments').ensureTable()
        .catch(err => console.warn('  ⚠️   Could not check the database for attached documents:', err.code || err.message));
    // v86: User Account Logs.
    require('./services/accountLog').ensureTable()
        .catch(err => console.warn('  ⚠️   Could not check the database for user account logs:', err.code || err.message));
    require('./services/documentAccess').ensureTables()
        .catch(err => console.warn('  ⚠️   Could not check the database for document access requests:', err.code || err.message));
    setTimeout(() => require('./services/itemPdfService').resumePending(), 3000);
    // Load the local AI model now, so the first summary is not slowed
    // down by loading it (set AI_WARMUP=0 to skip).
    if (process.env.AI_WARMUP !== '0') setTimeout(() => require('./services/llmService').warmUp(), 1500);
});

// Release the shared OCR worker on shutdown so the process can exit
// cleanly instead of being held open by a live Tesseract worker.
['SIGINT', 'SIGTERM'].forEach(sig => {
    process.on(sig, async () => {
        try { await require('./services/tesseractService').terminate(); } catch (_) {}
        process.exit(0);
    });
});
