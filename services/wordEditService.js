// ============================================================
// services/wordEditService.js — editing an agenda document in Word
// ============================================================
//
// The Board Secretary's fast way to correct the wording of an agenda
// item's document:
//
//   1. BOARDLINK turns the item's PDF into a Word file (pdf2docx);
//   2. the Secretary edits it in Microsoft Word, as usual;
//   3. she sends it back, and BOARDLINK turns it into a PDF again
//      (LibreOffice) and puts it on the item as a new version.
//
// Members' comments are then moved onto their words in the new
// document — see services/reanchorService.js. The previous PDF is
// kept as an earlier version, so what the Board first read can still
// be produced.
//
// Only the Board Secretary may do this; that is enforced by the route
// and by the controller.
//
// Two programs must be installed on the server:
//   sudo apt install libreoffice-writer python3-pip
//   pip3 install pdf2docx
// `readiness()` reports plainly when they are missing, so nobody is
// offered a button that cannot work.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');

const SCRIPT  = path.join(__dirname, '..', 'scripts', 'pdf_to_word.py');
const BLOCKS  = path.join(__dirname, '..', 'scripts', 'docx_blocks.py');
const TIMEOUT_MS = Number(process.env.WORD_CONVERT_TIMEOUT_MS || 180000);

// Where the Word copy of an item's document is kept between opening the
// editor and saving it, so the words are not converted twice and the
// block ids the browser sends back still mean the same paragraphs.
const CACHE_DIR = path.join(os.tmpdir(), 'boardlink-word-cache');
const CACHE_HOURS = Number(process.env.WORD_CACHE_HOURS || 12);

const MAX_EDITS = 5000;
const MAX_EDIT_CHARS = 20000;

// Where each program is looked for, in order. If PDF2WORD_PYTHON or
// SOFFICE_BIN is set in .env, that is used and nothing else is tried.
//
// The usual install places are included so BOARDLINK works on a
// Windows laptop (the demo machine) and on the Ubuntu server without
// anyone having to edit .env. On Windows, Python is `python`, not
// `python3`, and LibreOffice is not on the PATH at all.
const WINDOWS = process.platform === 'win32';

const PYTHON_CANDIDATES = process.env.PDF2WORD_PYTHON
    ? [process.env.PDF2WORD_PYTHON]
    : WINDOWS
        ? ['python', 'py', 'python3']
        : ['python3', 'python'];

const SOFFICE_CANDIDATES = process.env.SOFFICE_BIN
    ? [process.env.SOFFICE_BIN]
    : WINDOWS
        ? ['soffice',
           'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
           'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe']
        : process.platform === 'darwin'
            ? ['soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice']
            : ['soffice', 'libreoffice', '/usr/bin/soffice'];

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** execFile as a promise; never throws, so callers can read the code. */
function run(cmd, args, opts = {}) {
    return new Promise(resolve => {
        execFile(cmd, args, { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, ...opts },
            (err, stdout, stderr) => resolve({
                code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
                killed: !!(err && (err.killed || err.signal)),
                missing: !!(err && err.code === 'ENOENT'),
                stdout: String(stdout || ''),
                stderr: String(stderr || ''),
            }));
    });
}

// ── Is the server set up for this? ───────────────────────────
// Checked once and remembered: both checks start a program, which is
// too slow to repeat on every page view.

let _ready = null;

/** The first candidate that answers the given check, or null. */
async function firstWorking(candidates, args) {
    for (const cmd of candidates) {
        const res = await run(cmd, args, { timeout: 30000 });
        if (!res.missing && res.code === 0) return cmd;
    }
    return null;
}

async function readiness({ recheck = false } = {}) {
    if (_ready && !recheck) return _ready;

    // Three separate questions, because the answer decides what to do:
    // no Python at all is a different problem from Python without the
    // pdf2docx add-on, and saying "pdf2docx is missing" for both sends
    // people to reinstall the wrong thing.
    const [anyPython, python, soffice] = await Promise.all([
        firstWorking(PYTHON_CANDIDATES, ['-c', 'print(1)']),
        // python-docx is what edits the words inside the Word file.
        // (pdf2docx is no longer needed: PDFs are not turned into Word.)
        firstWorking(PYTHON_CANDIDATES, ['-c', 'import docx']),
        firstWorking(SOFFICE_CANDIDATES, ['--version']),
    ]);

    const missing = [];
    const steps = [];
    if (!python) missing.push('python-docx');
    if (!soffice) missing.push('LibreOffice');

    if (!anyPython) {
        steps.push(WINDOWS
            ? 'Python is not installed, or it was installed without ticking '
              + '“Add python.exe to PATH”. Install it from python.org with that box ticked.'
            : 'Python is not installed. On Ubuntu: sudo apt install python3-pip');
    } else if (!python) {
        steps.push(WINDOWS
            ? `Python is installed (BOARDLINK found “${anyPython}”), but the python-docx add-on is not. `
              + 'In Command Prompt, run:  pip install python-docx'
            : `Python is installed (BOARDLINK found “${anyPython}”), but python-docx is not. Run:  `
              + 'sudo pip3 install python-docx --break-system-packages');
    }
    if (!soffice) {
        steps.push(WINDOWS
            ? 'LibreOffice is not installed, or it is in an unusual folder. Install it from '
              + 'libreoffice.org, keeping the folder the installer offers.'
            : 'LibreOffice is not installed. On Ubuntu: sudo apt install libreoffice-writer');
    }

    _ready = {
        ok: missing.length === 0,
        missing,
        python,
        soffice,
        anyPython,
        steps,
        reason: missing.length
            ? `Editing the words is not set up on this computer yet. ${steps.join(' ')}`
            : null,
    };
    return _ready;
}

/** Forgets the remembered check — used by the tests. */
function _resetReadiness() { _ready = null; }

// ── Temporary working folder ─────────────────────────────────

function tempDir() {
    const dir = path.join(os.tmpdir(), `boardlink-word-${crypto.randomBytes(8).toString('hex')}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
}

function removeDir(dir) {
    if (dir) fs.rm(dir, { recursive: true, force: true }, () => {});
}

// ── PDF → Word ───────────────────────────────────────────────

/**
 * Turns a PDF into a Word file.
 * Returns { ok: true, path, dir } — the caller removes `dir` when done —
 * or { ok: false, message, scanned }.
 */
async function pdfToWord(pdfPath) {
    const ready = await readiness();
    if (!ready.ok) return { ok: false, message: ready.reason };

    const dir = tempDir();
    const out = path.join(dir, 'document.docx');
    const res = await run(ready.python, [SCRIPT, pdfPath, out]);

    if (res.code === 0 && fs.existsSync(out)) return { ok: true, path: out, dir };

    removeDir(dir);
    if (res.killed) {
        return { ok: false, message: 'This document took too long to turn into a Word file. It may be very long.' };
    }
    if (res.code === 3) { _resetReadiness(); }
    const said = res.stderr.trim().split('\n').filter(Boolean).pop();
    return {
        ok: false,
        scanned: res.code === 4,
        message: said || 'This document could not be turned into a Word file.',
    };
}

// ── Word → PDF ───────────────────────────────────────────────

/** True when the file really is a .docx (a ZIP holding a Word document). */
function isDocx(filePath) {
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
        const head = Buffer.alloc(4);
        if (fs.readSync(fd, head, 0, 4, 0) < 4) return false;
        // Every .docx is a ZIP: "PK\x03\x04".
        if (!(head[0] === 0x50 && head[1] === 0x4B && head[2] === 0x03 && head[3] === 0x04)) return false;
        // And every Word document inside it is named word/document.xml.
        const buf = fs.readFileSync(filePath);
        return buf.includes(Buffer.from('word/document.xml'));
    } catch (_) {
        return false;
    } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
    }
}

/**
 * Turns a Word file back into a PDF.
 * Returns { ok: true, path, dir } or { ok: false, message }.
 */
async function wordToPdf(docxPath) {
    const ready = await readiness();
    if (!ready.ok) return { ok: false, message: ready.reason };

    const dir = tempDir();
    // LibreOffice refuses to run twice from one settings folder, so each
    // conversion is given its own. It wants that folder as a file:// URL,
    // which must be built properly: on Windows a plain "file://" + path
    // gives "file://C:\Users\…", which LibreOffice cannot read.
    const profile = pathToFileURL(path.join(dir, 'lo-profile')).href;
    const res = await run(ready.soffice, [
        '--headless', '--norestore', '--invisible',
        `-env:UserInstallation=${profile}`,
        '--convert-to', 'pdf:writer_pdf_Export',
        '--outdir', dir, docxPath,
    ]);

    const out = path.join(dir, path.basename(docxPath).replace(/\.docx?$/i, '') + '.pdf');
    if (fs.existsSync(out) && fs.statSync(out).size > 0) return { ok: true, path: out, dir };

    removeDir(dir);
    if (res.killed) {
        return { ok: false, message: 'This Word file took too long to turn back into a PDF.' };
    }
    console.error('[word edit] soffice failed:', res.code, res.stderr.slice(0, 400));
    return { ok: false, message: 'This Word file could not be turned back into a PDF. Please check it opens in Word.' };
}

// ── Editing the words inside BOARDLINK ───────────────────────
//
// The Secretary does not have to download anything: the document's
// paragraphs are shown on the page, she corrects them, and the words
// are written back into the same Word file before it becomes a PDF.
// Keeping that Word file as the thing that changes is what preserves
// the layout — only the paragraphs she actually edited are rewritten.

function cachePrefix(itemId, version) {
    return `item${Number(itemId)}-v${Number(version) || 1}-`;
}

/**
 * The cached Word copy is named after the item, the version AND the
 * PDF itself (its stored name, size and time). Item ids and version
 * numbers start again at 1 after the database is reset or a meeting is
 * made again, so on their own they could hand back the Word copy of a
 * completely different, older document.
 */
function cacheFileFor(itemId, version, pdfPath) {
    let tag = 'x';
    try {
        const st = fs.statSync(pdfPath);
        tag = crypto.createHash('sha1')
            .update(`${path.basename(String(pdfPath))}|${st.size}|${st.mtimeMs}`)
            .digest('hex').slice(0, 16);
    } catch (_) { /* no file: the name just won't match anything cached */ }
    return path.join(CACHE_DIR, `${cachePrefix(itemId, version)}${tag}.docx`);
}

/** Throws nothing; old cached files are simply left if they cannot go. */
function sweepCache() {
    const cutoff = Date.now() - CACHE_HOURS * 3600 * 1000;
    let names = [];
    try { names = fs.readdirSync(CACHE_DIR); } catch (_) { return; }
    for (const name of names) {
        const file = path.join(CACHE_DIR, name);
        try { if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file); } catch (_) {}
    }
}

/**
 * The Word copy of an item's document, converting it the first time.
 * Returns { ok: true, path } or { ok: false, message, scanned }.
 */
async function editableDocx(itemId, version, pdfPath) {
    fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    sweepCache();
    const dest = cacheFileFor(itemId, version, pdfPath);
    try {
        if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
            fs.utimesSync(dest, new Date(), new Date());   // keep it from being swept
            return { ok: true, path: dest, cached: true };
        }
    } catch (_) { /* fall through and convert again */ }

    const made = await pdfToWord(pdfPath);
    if (!made.ok) return made;
    try {
        fs.copyFileSync(made.path, dest);
    } catch (err) {
        removeDir(made.dir);
        console.error('[word edit] could not keep the Word copy:', err.message);
        return { ok: false, message: 'The document could not be prepared for editing.' };
    }
    removeDir(made.dir);
    return { ok: true, path: dest, cached: false };
}

/** Forgets the Word copy, so the next open converts the document again. */
function forgetDocx(itemId, version) {
    const prefix = cachePrefix(itemId, version);
    let names = [];
    try { names = fs.readdirSync(CACHE_DIR); } catch (_) { return; }
    for (const name of names) {
        if (name.startsWith(prefix) && name.endsWith('.docx')) {
            try { fs.unlinkSync(path.join(CACHE_DIR, name)); } catch (_) {}
        }
    }
    // Word copies left over from before the name included the PDF.
    try { fs.unlinkSync(path.join(CACHE_DIR, `item${Number(itemId)}-v${Number(version) || 1}.docx`)); } catch (_) {}
}

/**
 * The document's paragraphs, each with an id the browser sends back.
 * Returns { ok: true, blocks } or { ok: false, message }.
 */
async function readBlocks(docxPath) {
    const ready = await readiness();
    if (!ready.ok) return { ok: false, message: ready.reason };

    // The paragraphs come back in a file, not on the screen: a board
    // paper holding "≤", "₱", an em dash or a curly quote cannot be
    // printed on a Windows screen, and a document's words are far too
    // big to pass through a screen buffer anyway.
    const dir = tempDir();
    const out = path.join(dir, 'blocks.json');
    try {
        const res = await run(ready.python, [BLOCKS, 'read', docxPath, out]);
        if (res.code !== 0) {
            const said = res.stderr.trim().split('\n').filter(Boolean).pop();
            return { ok: false, message: said || 'The words of this document could not be read.' };
        }
        const parsed = JSON.parse(jsonFrom(fs.readFileSync(out, 'utf8')));
        if (!parsed || !Array.isArray(parsed.blocks)) throw new Error('shape');
        return { ok: true, blocks: parsed.blocks };
    } catch (err) {
        return { ok: false, message: 'The words of this document could not be read.' };
    } finally {
        removeDir(dir);
    }
}

/**
 * The JSON object out of a program's output.
 *
 * Python installations print things nobody asked for on stdout — a
 * deprecation warning from pdf2docx's PDF library does exactly that
 * ("warning: The `fitz` API is deprecated…"). One such line in front of
 * the JSON would otherwise stop the editor from opening at all, with a
 * message that says nothing about the real cause.
 */
function jsonFrom(out) {
    const text = String(out || '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

/** Checks the edits the browser sent. Returns { edits } or { error }. */
function cleanEdits(raw) {
    if (!Array.isArray(raw)) return { error: 'The changes could not be read.' };
    if (!raw.length) return { error: 'Nothing was changed, so there is nothing to save.' };
    if (raw.length > MAX_EDITS) return { error: 'That is more changes than BOARDLINK can save at once.' };
    const edits = [];
    const seen = new Set();
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') return { error: 'The changes could not be read.' };
        const id = String(entry.id || '');
        // Ids are made by scripts/docx_blocks.py: p3, t0r1c2.p0 …
        if (!/^(t\d{1,4}r\d{1,4}c\d{1,4}\.)*p\d{1,5}$/.test(id)) {
            return { error: 'The changes could not be read.' };
        }
        if (seen.has(id)) continue;
        seen.add(id);
        if (typeof entry.text !== 'string') return { error: 'The changes could not be read.' };
        if (entry.text.length > MAX_EDIT_CHARS) {
            return { error: 'One of the paragraphs is longer than BOARDLINK can save.' };
        }
        // Keep line breaks and tabs; drop other control characters.
        const text = entry.text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
        edits.push({ id, text });
    }
    if (!edits.length) return { error: 'Nothing was changed, so there is nothing to save.' };
    return { edits };
}

/**
 * Writes the edited paragraphs into a copy of the Word file.
 * Returns { ok: true, path, dir } — the caller removes `dir` — or
 * { ok: false, message, stale }.
 */
async function writeBlocks(docxPath, edits) {
    const ready = await readiness();
    if (!ready.ok) return { ok: false, message: ready.reason };

    const dir = tempDir();
    const editsFile = path.join(dir, 'edits.json');
    const out = path.join(dir, 'edited.docx');
    try {
        fs.writeFileSync(editsFile, JSON.stringify(edits), 'utf8');
    } catch (err) {
        removeDir(dir);
        return { ok: false, message: 'The changes could not be prepared.' };
    }

    const res = await run(ready.python, [BLOCKS, 'write', docxPath, editsFile, out]);
    if (res.code === 0 && fs.existsSync(out)) return { ok: true, path: out, dir };

    removeDir(dir);
    const said = res.stderr.trim().split('\n').filter(Boolean).pop();
    return {
        ok: false,
        // The document was re-converted underneath the editor, so the
        // paragraph ids no longer line up.
        stale: res.code === 2,
        message: said || 'The changes could not be saved.',
    };
}

/** The stored Word file of an item, or null when it was attached as a PDF. */
function itemDocxPath(item) {
    if (!item || !item.item_docx || !/^[a-f0-9]{32}$/.test(item.item_docx)) return null;
    const full = path.join(require('../config/paths').UPLOAD_DIR, item.item_docx);
    return fs.existsSync(full) ? full : null;
}

const NEEDS_WORD = 'This document was attached as a PDF, so its words cannot be edited exactly: '
    + 'turning a PDF back into Word changes the layout (pages move and blank pages appear). '
    + 'Attach the Word (.docx) version of this document below, then edit its words here.';

/** A download name for the Word file, from the PDF's name. */
function wordNameFor(pdfName) {
    const base = String(pdfName || 'document.pdf').replace(/\.pdf$/i, '').slice(0, 150);
    return `${base || 'document'}.docx`;
}

module.exports = {
    readiness, _resetReadiness, itemDocxPath, NEEDS_WORD,
    pdfToWord, wordToPdf, isDocx, wordNameFor, removeDir, tempDir,
    editableDocx, forgetDocx, readBlocks, writeBlocks, cleanEdits, jsonFrom,
    DOCX_TYPE, PYTHON_CANDIDATES, SOFFICE_CANDIDATES,
    MAX_EDITS, MAX_EDIT_CHARS, CACHE_DIR,
};
