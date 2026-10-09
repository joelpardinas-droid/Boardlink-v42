// ============================================================
// services/googleAuth.js — "Sign in with Google"
// ============================================================
//
// The standard Google sign-in (OAuth 2.0 / OpenID Connect), with no
// extra packages. Turned on by two settings in .env, taken from a
// Google Cloud "OAuth client ID" of type Web application:
//
//   GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com
//   GOOGLE_CLIENT_SECRET=GOCSPX-...
//   GOOGLE_REDIRECT_URL=http://127.0.0.1:3000/auth/google/callback   (optional)
//
// The redirect URL must be listed under "Authorised redirect URIs" in
// Google Cloud exactly as BOARDLINK uses it. When it is not set,
// BOARDLINK builds it from the address the page was opened on.

const crypto = require('crypto');

const enabled = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

function redirectUrl(req) {
    if (process.env.GOOGLE_REDIRECT_URL) return process.env.GOOGLE_REDIRECT_URL;
    return `${req.protocol}://${req.get('host')}/auth/google/callback`;
}

/** The Google page to send the person to, remembering a one-time state. */
function startUrl(req) {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.googleState = state;
    const q = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        redirect_uri: redirectUrl(req),
        response_type: 'code',
        scope: 'openid email profile',
        state,
        prompt: 'select_account',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

/**
 * After Google sends the person back: checks the state, trades the
 * code for the person's identity, and returns
 * { ok: true, sub, email, name } or { ok: false, message }.
 */
async function finish(req) {
    const { code, state, error } = req.query;
    const expected = req.session.googleState;
    delete req.session.googleState;
    if (error) return { ok: false, message: 'Google sign-in was cancelled.' };
    if (!code || !state || !expected || state !== expected) {
        return { ok: false, message: 'The Google sign-in expired. Please try again.' };
    }
    let data;
    try {
        const r = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            signal: AbortSignal.timeout(15000),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
                redirect_uri: redirectUrl(req), grant_type: 'authorization_code',
            }),
        });
        data = await r.json();
        if (!r.ok) throw new Error(data.error_description || data.error || `HTTP ${r.status}`);
    } catch (err) {
        console.error('[google] token exchange failed:', err.message);
        return { ok: false, message: 'BOARDLINK could not reach Google. Please try again.' };
    }
    // The ID token came straight from Google over HTTPS in answer to
    // our own request, so its contents can be read directly; its
    // audience, issuer and expiry are still checked.
    let claims;
    try {
        claims = JSON.parse(Buffer.from(String(data.id_token).split('.')[1], 'base64url').toString('utf8'));
    } catch (_) {
        return { ok: false, message: 'Google sent an answer BOARDLINK could not read.' };
    }
    const okIssuer = ['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss);
    if (claims.aud !== process.env.GOOGLE_CLIENT_ID || !okIssuer || !(claims.exp * 1000 > Date.now())) {
        return { ok: false, message: 'The Google sign-in could not be confirmed.' };
    }
    if (!claims.email || claims.email_verified !== true) {
        return { ok: false, message: 'Google has not confirmed this e-mail address.' };
    }
    return { ok: true, sub: String(claims.sub), email: String(claims.email).toLowerCase(), name: claims.name || '' };
}

module.exports = { enabled, startUrl, finish, redirectUrl };
