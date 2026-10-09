// ============================================================
// middleware/security.js — Hardening for public deployment
// BOARDLINK | Chapter 3 Sec. 3.7 — OWASP security practices
// ============================================================
//
// Chapter 3 commits the system to OWASP practices covering SQL
// injection, cross-site scripting, unauthorised access attempts
// and session management. SQL injection is already handled by
// the parameterised queries in the Model layer, and output
// escaping by EJS's `<%= %>`. This module covers the remainder,
// which only becomes load-bearing once BOARDLINK is reachable
// from outside the campus network.

const rateLimit = require('express-rate-limit');
const helmet    = require('helmet');

// ── Security headers ─────────────────────────────────────────
//
// NOTE ON CONTENT-SECURITY-POLICY
// The views use inline <script> and <style> blocks throughout
// (the mobile drawer, the upload autofill, the agenda parser UI).
// A default CSP forbids inline code and would break all of them,
// so 'unsafe-inline' is permitted here. This is a deliberate
// trade-off, not an oversight: removing it would mean extracting
// every inline block to an external file first. The remaining
// directives still block the most valuable XSS payloads —
// loading scripts from an attacker's domain, framing the site
// for clickjacking, and leaking the session via a referrer.
// ── "Add from Google Drive" (v57) ────────────────────────────
// Google's file picker loads Google's own scripts and frames. They are
// allowed ONLY when the Drive import is switched on (GOOGLE_CLIENT_ID
// and GOOGLE_API_KEY in .env), and only from Google's addresses.
const DRIVE_PICKER = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_API_KEY);
function withDrivePicker(d) {
    if (!DRIVE_PICKER) return d;
    const add = (k, ...v) => { d[k] = [...(d[k] || []), ...v]; };
    add('scriptSrc', 'https://apis.google.com', 'https://accounts.google.com', 'https://www.gstatic.com');
    add('styleSrc', 'https://accounts.google.com', 'https://www.gstatic.com');
    add('frameSrc', 'https://docs.google.com', 'https://drive.google.com', 'https://accounts.google.com', 'https://content.googleapis.com');
    add('connectSrc', 'https://www.googleapis.com', 'https://content.googleapis.com', 'https://apis.google.com', 'https://accounts.google.com');
    add('imgSrc', 'https://*.googleusercontent.com', 'https://ssl.gstatic.com', 'https://www.gstatic.com', 'https://drive-thirdparty.googleusercontent.com');
    return d;
}

const securityHeaders = helmet({
    contentSecurityPolicy: {
        directives: withDrivePicker({
            defaultSrc:  ["'self'"],
            // 'wasm-unsafe-eval' lets PDF.js run its bundled WebAssembly
            // image decoders (JBIG2 / JPEG 2000), which many scanners
            // use. It does not permit JavaScript eval().
            scriptSrc:   ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'"],
            workerSrc:   ["'self'"],
            // helmet defaults script-src-attr to 'none', which blocks
            // every inline event handler — onclick, onchange and the
            // like. The views rely on 15 of them (adding and removing
            // agenda item rows, the meeting-type switcher, the minutes
            // form), and with the default in place those controls
            // silently do nothing at all: no error, just a dead button.
            // Permitting them is the same trade-off already accepted
            // for inline <script> above.
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc:    ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
            fontSrc:     ["'self'", 'https://fonts.gstatic.com', 'data:'],
            imgSrc:      ["'self'", 'data:', 'blob:'],
            connectSrc:  ["'self'"],
            // 'none' also blocks the PDF plug-in path some browsers use
            // to render a PDF inline, leaving a blank frame.
            objectSrc:   ["'self'"],
            frameSrc:    ["'self'"],          // PDF preview in an iframe
            frameAncestors: ["'self'"],       // clickjacking protection
            formAction:  ["'self'"],
            baseUri:     ["'self'"],
        }),
    },
    // Google's file picker signs in through a small pop-up window that
    // must be able to answer this page; 'same-origin' would cut it off.
    crossOriginOpenerPolicy: { policy: DRIVE_PICKER ? 'same-origin-allow-popups' : 'same-origin' },
    // Only send HSTS in production; on plain-HTTP LAN testing it
    // would pin browsers to HTTPS for a host that has no cert.
    hsts: process.env.NODE_ENV === 'production'
        ? { maxAge: 15552000, includeSubDomains: true }
        : false,
    crossOriginEmbedderPolicy: false,   // would block the PDF iframe
    referrerPolicy: { policy: 'same-origin' },
});

// ── Brute-force protection on sign-in ────────────────────────
//
// Without this, a public deployment lets an attacker try
// passwords against the Board Secretary's account indefinitely.
// Counting only failed attempts means somebody logging in and
// out legitimately is never locked out.
// Keyed by the submitted GMAIL ADDRESS, not by IP.
//
// Two reasons. First, a failed sign-in re-renders the login page
// with HTTP 200, so `skipSuccessfulRequests` would treat every
// failure as a success and never count anything. Second, and more
// importantly, the whole CSPC campus is likely to sit behind a
// single public address: an IP-keyed limiter would let one person
// mistyping their password lock out the entire Office of the Board
// Secretary. Keying on the submitted address throttles guessing
// against a specific account while leaving everyone else working.
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit:    10,
    standardHeaders: 'draft-7',
    legacyHeaders:   false,
    // Only FAILED sign-ins count. A successful sign-in redirects
    // (302); a failed one re-renders the login page with 200, which
    // is why the default "status < 400" test cannot be used here.
    // Without this, anyone who signed in eleven times in fifteen
    // minutes (a second device, an expired session) was locked out.
    skipSuccessfulRequests: true,
    requestWasSuccessful: (req, res) => res.statusCode === 302,
    keyGenerator: (req) =>
        'login:' + String((req.body && req.body.email) || '').toLowerCase().trim(),
    handler: (req, res) => {
        const who = String((req.body && req.body.email) || '(none)').toLowerCase();
        console.warn(`[rate-limit] repeated failed sign-ins for "${who}" (last from ${req.ip})`);
        res.status(429).render('login', {
            active: '',
            error:  'Too many sign-in attempts for this account. Please wait 15 minutes and try again.',
        });
    },
});

// A second, IP-keyed ceiling that is high enough never to affect a
// shared campus connection, but stops someone spraying one password
// across hundreds of different addresses from a single host.
const loginIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit:    100,
    standardHeaders: 'draft-7',
    legacyHeaders:   false,
    handler: (req, res) => {
        console.warn(`[rate-limit] excessive sign-in volume from ${req.ip}`);
        res.status(429).render('login', {
            active: '',
            error:  'Too many sign-in attempts from this network. Please try again later.',
        });
    },
});

// ── General request ceiling ──────────────────────────────────
// Generous enough that normal use never notices, low enough to
// blunt scripted scraping of the archive.
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit:    600,
    standardHeaders: 'draft-7',
    legacyHeaders:   false,
});

// ── Upload / AI endpoint ceiling ─────────────────────────────
// OCR, transcription and summarisation are the most expensive
// operations on the server. Capping them stops one user (or one
// stuck browser tab retrying) from saturating the CPU.
const heavyLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit:    40,
    standardHeaders: 'draft-7',
    legacyHeaders:   false,
    message: { ok: false, error: 'Too many processing requests. Please wait a few minutes.' },
});

// ── Sign-up and "Forgot password?" codes ─────────────────────
// Each request e-mails a code, so it is capped per address (stops
// someone flooding a person's inbox) and per network.
const codeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit:    6,
    standardHeaders: 'draft-7',
    legacyHeaders:   false,
    keyGenerator: (req) => 'code:' + String((req.body && req.body.email) || '').toLowerCase().trim(),
    handler: (req, res) => res.status(429).render('account', {
        active: '', step: 'forgot', error: 'Too many codes were asked for this address. Please wait 15 minutes.',
        info: null, email: '', fullName: '', requested: '', types: [], domainHint: '', googleEnabled: false, minutes: 15,
    }),
});

module.exports = { securityHeaders, loginLimiter, loginIpLimiter, generalLimiter, heavyLimiter, codeLimiter };
