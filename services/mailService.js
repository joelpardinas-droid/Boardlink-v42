// ============================================================
// services/mailService.js — sending e-mail from BOARDLINK
// ============================================================
//
// BOARDLINK sends two kinds of e-mail: the six-digit code that proves
// a person owns the Gmail address they signed up with, and the code
// for "Forgot password?".
//
// It sends through a Gmail account with an App Password:
//   SMTP_USER=boardlink.cspc@gmail.com        (the sending account)
//   SMTP_PASS=abcd efgh ijkl mnop             (its 16-letter App Password)
//   SMTP_HOST / SMTP_PORT                     (default smtp.gmail.com / 465)
//   MAIL_FROM="BOARDLINK <boardlink.cspc@gmail.com>"   (optional)
//
// While SMTP is not set up and NODE_ENV is not "production", the
// e-mail is printed in the BOARDLINK terminal instead, so sign-up and
// password reset can still be tried during development. In production
// nothing is printed and the person is told e-mail is unavailable.

const nodemailer = require('nodemailer');

const configured = () => !!(process.env.SMTP_USER && process.env.SMTP_PASS);
const canPrint = () => !configured() && process.env.NODE_ENV !== 'production';

let transport = null;
function getTransport() {
    if (!transport) {
        const port = Number(process.env.SMTP_PORT || 465);
        transport = nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'smtp.gmail.com',
            port,
            secure: port === 465,
            auth: { user: process.env.SMTP_USER, pass: String(process.env.SMTP_PASS).replace(/\s+/g, '') },
        });
    }
    return transport;
}

/**
 * Sends one e-mail. Returns { ok: true, printed } or { ok: false, message }.
 * `printed` is true when it was only written to the terminal (development).
 */
async function send({ to, subject, text, html }) {
    if (configured()) {
        try {
            await getTransport().sendMail({
                from: process.env.MAIL_FROM || `BOARDLINK <${process.env.SMTP_USER}>`,
                to, subject, text, html,
            });
            return { ok: true, printed: false };
        } catch (err) {
            console.error('[mail] could not send:', err.message);
            return { ok: false, message: 'The e-mail could not be sent. Please try again in a few minutes.' };
        }
    }
    if (canPrint()) {
        console.log('\n  ✉️   E-mail (not sent — SMTP_USER/SMTP_PASS are not set in .env):');
        console.log(`      To:      ${to}\n      Subject: ${subject}\n      ${String(text).split('\n').join('\n      ')}\n`);
        return { ok: true, printed: true };
    }
    console.error('[mail] SMTP_USER/SMTP_PASS are not set, so no e-mail can be sent.');
    return { ok: false, message: 'BOARDLINK cannot send e-mail yet. Please contact the System Administrator.' };
}

/** The six-digit code e-mail, for sign-up or password reset. */
function sendCode(to, code, purpose, minutes) {
    const what = purpose === 'reset' ? 'reset your BOARDLINK password' : 'finish signing up for BOARDLINK';
    const text = [
        `Your BOARDLINK code is: ${code}`,
        '',
        `Enter it to ${what}. It works once, for ${minutes} minutes.`,
        'If you did not ask for this, you can ignore this e-mail.',
        '',
        'Office of the Board Secretary — Camarines Sur Polytechnic Colleges',
    ].join('\n');
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:480px;color:#0d1f45">
        <h2 style="margin:0 0 8px">BOARDLINK</h2>
        <p>Your code to ${what}:</p>
        <p style="font-size:30px;font-weight:bold;letter-spacing:6px;margin:12px 0">${code}</p>
        <p>It works once, for ${minutes} minutes.</p>
        <p style="color:#7c88a6;font-size:12px">If you did not ask for this, you can ignore this e-mail.<br>
        Office of the Board Secretary — Camarines Sur Polytechnic Colleges</p>
      </div>`;
    return send({ to, subject: `BOARDLINK code: ${code}`, text, html });
}

module.exports = { send, sendCode, configured, canPrint };
