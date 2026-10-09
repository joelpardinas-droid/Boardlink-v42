// ============================================================
// controllers/ocrController.js — OCR: read an old scanned paper,
// correct the words, and make a new Word or PDF file from them
// ============================================================
//
//   1. Upload the scanned paper — only the file is asked for.
//   2. Correct the words — BOARDLINK reads every page with OCR and shows
//      the words on pages like Microsoft Word's (paper size, 1-inch
//      margins, Times New Roman 12), where she fixes what OCR misread.
//   3. Make the file — the details BOARDLINK read from the paper (type,
//      number, year, title, board / council) are already filled in; she
//      checks them and
//        • downloads a Word file (to keep editing on her computer),
//        • downloads a PDF, or
//        • saves the PDF to the Digital Archive (Board Resolutions or
//          Documents, with the same details as the two upload forms),
//          where every word is searchable.
// v97: the details were asked twice before (on step 1 and on step 2);
// now they are read from the paper once and shown only on step 3.

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const tesseractService = require('../services/tesseractService');
const textDoc  = require('../services/textDocService');
const Document = require('../models/Document');
const documentIndexer = require('../services/documentIndexer');
const documentAttachments = require('../services/documentAttachments');
const layoutService = require('../services/layoutService');

const DOC_TYPES = ['Resolution', 'Manual', 'Policy', 'Memorandum', 'Other'];
const MAX_TEXT = 900000;          // characters (the form limit is 1 MB)
const OCR_MAX_PAGES = Number(process.env.OCR_PAGE_MAX_PAGES || 40);

async function render(res, extra = {}, status = 200) {
    // The resolutions a manual / policy / memorandum can be approved by.
    let resolutions = [];
    if (extra.result) {
        try { resolutions = (await documentAttachments.choices()).resolutions || []; } catch (_) { /* no database */ }
    }
    res.status(status).render('ocr', {
        active: 'ocr', result: null, error: null, docTypes: DOC_TYPES, papers: textDoc.PAPERS, resolutions, ...extra,
    });
}

/**
 * v97: the paper size of the uploaded scan (its first page), so the
 * pages on the OCR page are the same as the scan's: Letter, A4 or Long.
 */
async function paperOfScan(file) {
    let w = 0, h = 0;
    try {
        const buf = fs.readFileSync(file);
        if (buf.slice(0, 5).toString() === '%PDF-') {
            const { PDFDocument } = require('pdf-lib');
            const pdf = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
            const pg = pdf.getPage(0);
            ({ width: w, height: h } = pg.getSize());
            if (pg.getRotation().angle % 180) [w, h] = [h, w];
        } else if (buf.readUInt32BE(0) === 0x89504E47) {                   // PNG
            w = buf.readUInt32BE(16); h = buf.readUInt32BE(20);
        } else if (buf[0] === 0xFF && buf[1] === 0xD8) {                   // JPEG
            for (let i = 2; i < buf.length - 9;) {
                if (buf[i] !== 0xFF) { i++; continue; }
                const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
                if (m >= 0xC0 && m <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(m)) { h = buf.readUInt16BE(i + 5); w = buf.readUInt16BE(i + 7); break; }
                i += 2 + len;
            }
        }
    } catch (_) { /* unknown: Letter */ }
    if (!w || !h) return 'letter';
    const tall = Math.max(w, h) / Math.min(w, h);
    // Letter 1.294 · A4 1.414 · Long 1.529 — the closest shape wins.
    const shapes = { letter: 11 / 8.5, a4: 297 / 210, long: 13 / 8.5 };
    return Object.keys(shapes).sort((a, b) => Math.abs(shapes[a] - tall) - Math.abs(shapes[b] - tall))[0];
}

/**
 * The words on the pages: each page of the scan starts a page of its
 * own (a page break), so page 1 of the scan is page 1 here, and so on.
 */
function pagedParas(ocr, text) {
    const pages = Array.isArray(ocr.pages) && ocr.pages.length ? ocr.pages : [text];
    const out = [];
    pages.forEach((t, i) => {
        const ps = textDoc.fromText(String(t || '').replace(/\r\n?/g, '\n'));
        if (!ps.length) ps.push({ align: 'left', runs: [] });               // a blank page stays a page
        if (i > 0) ps[0].pb = true;
        out.push(...ps);
    });
    return out;
}

/** The pages for the editor: the scan's layout copied, or simple pages. */
function pagesFor(ocr, text, paper) {
    const simple = pagedParas(ocr, text);
    let copied = null;
    try { copied = layoutService.fromLayout(ocr.layout, paper); } catch (err) { console.warn('[ocr] layout:', err.message); }
    if (!copied) return { paras: simple, margins: null, layoutMode: 'simple' };
    return { paras: copied.paras, margins: copied.margins, layoutMode: 'scan' };
}

/** What kind of paper it is, from its words. */
function typeFrom(text, meta) {
    // Only the heading part of the first page says what the paper is.
    const head = String(text).slice(0, 500).toUpperCase();
    if (/\bMINUTES\b/.test(head) && !/\bRESOLUTION\s+NO\b/.test(head)) return 'Other';
    if (/\bRESOLUTION\s+NO\b|\bBOARD\s+RESOLUTION\b/.test(head)) return 'Resolution';
    if (/\bMEMORANDUM\b/.test(head)) return 'Memorandum';
    if (/\bMANUAL\b|\bHANDBOOK\b|\bGUIDELINES\b/.test(head)) return 'Manual';
    if (/\bPOLICY\b|\bPOLICIES\b/.test(head)) return 'Policy';
    return meta.documentNumber ? 'Resolution' : 'Other';
}

/** Which board or council the paper is from, from its words. */
function bodyFrom(text) {
    const head = String(text).slice(0, 3000).toUpperCase();
    const found = [['ACADEMIC COUNCIL', 'Academic Council'], ['ADMINISTRATIVE COUNCIL', 'Administrative Council'],
                   ['RIC COUNCIL', 'RIC Council'], ['RESEARCH, INNOVATION', 'RIC Council'], ['BOARD OF TRUSTEES', 'Board of Trustees']]
        .map(([w, b]) => ({ b, at: head.indexOf(w) })).filter(x => x.at >= 0).sort((a, b) => a.at - b.at);
    return found.length ? found[0].b : 'Board of Trustees';
}

exports.showOcr = (req, res) => render(res);

exports.processOcr = async (req, res) => {
    if (!req.file) return render(res, { error: 'Choose the scanned file (PDF or photo) first.' }, 400);
    const scan = req.file.path;
    try {
        const t0 = Date.now();
        const ocr = await tesseractService.extractText(scan, 'eng', { maxPages: OCR_MAX_PAGES });
        const text = String(ocr.text || '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        if (!text) return render(res, { error: 'No words could be read from this file. Try a clearer scan (300 DPI).' }, 422);
        const meta = tesseractService.extractMetadata(text);
        const docType = typeFrom(text, meta);
        const paper = await paperOfScan(scan);
        await render(res, {
            result: {
                text,
                // Shown on the pages, each scanned page on a page of its
                // own, with the scan's layout copied (spaces, indents,
                // centred lines, sizes, margins) when its lines were found.
                ...pagesFor(ocr, text, paper),
                paper,
                confidence: typeof ocr.confidence === 'number' ? ocr.confidence.toFixed(1) + '%' : '—',
                words: ocr.words || text.split(/\s+/).length,
                pagesRead: ocr.pagesRead || 1,
                totalPages: ocr.totalPages || 1,
                seconds: Math.round((Date.now() - t0) / 1000),
                fileName: req.file.originalname || 'scan',
                // Step 3's details, read from the paper.
                title: tesseractService.extractTitle(text) || '',
                docType,
                number: docType === 'Resolution' ? (meta.documentNumber || '') : '',
                year: meta.year || '',
                governingBody: bodyFrom(text),
            },
        });
    } catch (err) {
        console.error('[ocr] failed:', err.message);
        render(res, { error: 'The file could not be read: ' + err.message }, 500);
    } finally {
        // The scan is not kept: what is saved is the corrected document.
        fs.unlink(scan, () => {});
    }
};

function readForm(req) {
    const b = req.body || {};
    // The editor sends the formatted document; its words are used for search.
    const paras = textDoc.normalize(String(b.doc || '').slice(0, 4 * MAX_TEXT));
    return {
        paras,
        doc: paras,
        text: paras ? textDoc.plainText(paras) : String(b.text || '').slice(0, MAX_TEXT),
        title: String(b.title || '').trim().slice(0, 250),
        docType: DOC_TYPES.includes(b.docType) ? b.docType : 'Resolution',
        number: String(b.number || '').trim().slice(0, 100),
        year: String(b.year || '').trim(),
        governingBody: Document.GOVERNING_BODIES.includes(b.governingBody) ? b.governingBody : 'Board of Trustees',
        paper: textDoc.paperOf(b.paper),
        // v97: the margins copied from the scan ("Same as the scan" layout)
        margins: b.layout === 'simple' ? null : layoutService.cleanMargins(b.margins),
        layoutMode: b.layout === 'simple' ? 'simple' : (b.margins ? 'scan' : 'simple'),
        approvedById: /^\d+$/.test(String(b.approvedById || '')) ? Number(b.approvedById) : null,
    };
}

/** Download the corrected words as a Word (.docx) or PDF file. */
exports.download = async (req, res) => {
    const f = readForm(req);
    if (!f.text.trim()) return render(res, { error: 'There are no words to put in the file.' }, 400);
    const format = req.body.format === 'pdf' ? 'pdf' : 'docx';
    try {
        const buf = format === 'pdf' ? await textDoc.buildPdf(f) : await textDoc.buildDocx(f);
        const name = textDoc.fileName(f.title, format);
        const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
        res.setHeader('Content-Type', format === 'pdf' ? 'application/pdf'
            : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
        res.send(buf);
    } catch (err) {
        console.error('[ocr] download failed:', err.message);
        render(res, { error: 'The file could not be made: ' + err.message, result: { ...f, paras: textDoc.contentOf(f), confidence: '—', words: 0 } }, 500);
    }
};

/** Save a PDF made from the corrected words to the Digital Archive. */
exports.saveToArchive = async (req, res) => {
    const f = readForm(req);
    const back = (error) => render(res, { error, result: { ...f, paras: textDoc.contentOf(f), confidence: '—', words: f.text.split(/\s+/).filter(Boolean).length } }, 400);
    if (!f.text.trim()) return back('There are no words to save.');
    if (!f.title) return back('Write the title of the document.');
    if (!/^\d{4}$/.test(f.year) || +f.year < 1900 || +f.year > 2100) return back('Write the year (for example 2026).');
    if (f.docType === 'Resolution' && !f.number) return back('A Board Resolution needs its number (for example 2026-22).');
    if (f.docType === 'Resolution') f.approvedById = null;
    try {
        const pdf = await textDoc.buildPdf(f);
        const stored = crypto.randomBytes(16).toString('hex');
        fs.writeFileSync(path.join(require('../config/paths').UPLOAD_DIR, stored), pdf);
        const id = await Document.create({
            title: f.title, docType: f.docType, docYear: f.year, category: f.number || null,
            filename: stored, uploadedBy: req.session.user.id, governingBody: f.governingBody,
        });
        // The words are the corrected ones, so they are stored as they are.
        await Document.saveOcrText(id, f.text, 100);
        documentIndexer.indexInBackground({
            document_id: id, title: f.title, doc_type: f.docType, doc_year: f.year,
            category: f.number || null, file_path: stored,
        });
        // A manual / policy / memorandum: the resolution that approved it.
        if (f.approvedById) {
            await documentAttachments.attach(f.approvedById, id, req.session.user.id)
                .catch(err => console.warn('[ocr] approved-by link:', err.message));
        }
        require('../services/driveBackup').backupInBackground(id);
        console.log(`[ocr] "${f.title}" saved to the Digital Archive as document ${id}`);
        res.redirect(`/archive/${id}?saved=ocr`);
    } catch (err) {
        console.error('[ocr] save failed:', err.message);
        back('The document could not be saved to the Digital Archive. Please try again.');
    }
};
