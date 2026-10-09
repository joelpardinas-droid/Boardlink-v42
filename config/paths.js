// ============================================================
// config/paths.js — where BOARDLINK keeps uploaded files
// ============================================================
//
// By default uploaded files (agenda PDFs and Word files, videos, archived
// documents) are kept in the "uploads" folder inside the BOARDLINK folder.
//
// The database lives outside the BOARDLINK folder, but that folder does
// not: when a NEW version of BOARDLINK is unzipped into a new folder, the
// database still lists the files, yet the new "uploads" folder is empty.
// To keep files when changing versions, set in .env a folder outside
// BOARDLINK, for example:
//     UPLOAD_DIR=C:/BOARDLINK-files
// Every version then reads and writes the same files.

const path = require('path');
const fs = require('fs');

const BUNDLED = path.join(__dirname, '..', 'uploads');
const UPLOAD_DIR = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : BUNDLED;

try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (_) { /* reported when used */ }

/**
 * The sample archive files that come inside the zip are copied into an
 * outside UPLOAD_DIR once, so the sample resolutions still open.
 */
function copyBundledSamples() {
    if (UPLOAD_DIR === BUNDLED) return 0;
    let n = 0;
    try {
        for (const name of fs.readdirSync(BUNDLED)) {
            if (!/^[a-f0-9]{32}$/.test(name)) continue;
            const to = path.join(UPLOAD_DIR, name);
            if (!fs.existsSync(to)) { fs.copyFileSync(path.join(BUNDLED, name), to); n++; }
        }
    } catch (_) { /* nothing bundled */ }
    return n;
}

module.exports = { UPLOAD_DIR, BUNDLED, copyBundledSamples };
