// ============================================================
// services/tesseractService.js — OCR + Metadata Autofill
//
// BOARDLINK | Chapter 3 Sec. 3.6
//   Module 3: OCR Processing
//   Module 2.4: OCR-based Document Processing and Metadata Autofill
// ============================================================
//
// Wraps the Tesseract.js library so that the OCR controller
// doesn't need to know about the underlying engine. Exposes two
// operations:
//
//   extractText(filePath)       → returns raw OCR text + confidence
//   extractMetadata(ocrText)    → parses the OCR text for
//                                  document_number, year, type,
//                                  date, and flags any field that
//                                  could not be confidently located
//
// Metadata autofill is applied in the upload flow so that the
// The Board Secretary only needs to manually correct fields that the
// system could not read, per the panelist's suggestion.

const Tesseract = require('tesseract.js');
const path      = require('path');
const fs        = require('fs');
const os        = require('os');

// ── Performance configuration ────────────────────────────────
//
// Three things dominate OCR time on the documented i5 / 8 GB server:
//
//   1. How many pages are scanned. Metadata autofill only needs the
//      resolution number, title and year, which sit on the first
//      page — reading an 11-page excerpt in full was doing an order
//      of magnitude more work than the task required.
//   2. Worker start-up. Tesseract.recognize() creates a worker,
//      loads the language model, then discards both on every call.
//      A single long-lived worker removes that fixed cost.
//   3. Where the language model comes from. By default tesseract.js
//      downloads it from a CDN on first use, which is slow and also
//      breaks the on-premise requirement that no processing depend
//      on an internet connection.
//
// All three are addressed below.

// Local language data, bundled with the application. Uses the
// "fast" (integer) model, which is several times quicker than the
// standard model at a small accuracy cost that is acceptable for
// printed board documents.
const LANG_PATH = process.env.TESSDATA_PATH || path.join(__dirname, '..', 'tessdata');

// Pages to read when only the document's metadata is needed.
const AUTOFILL_PAGES = Number(process.env.OCR_AUTOFILL_PAGES || 1);

// Render scale for PDF pages. 2.0 approximates 300 DPI on a
// letter-size page, which is Tesseract's sweet spot; going higher
// costs time without improving accuracy on printed text.
const RENDER_SCALE = Number(process.env.OCR_RENDER_SCALE || 2.0);

// ── Persistent worker ────────────────────────────────────────
let _workerPromise = null;

async function getWorker(language = 'eng') {
    if (_workerPromise) return _workerPromise;

    const hasLocalData = fs.existsSync(path.join(LANG_PATH, `${language}.traineddata`));
    const options = hasLocalData
        // Local, uncompressed traineddata: no network access at all.
        ? { langPath: LANG_PATH, gzip: false, cachePath: os.tmpdir() }
        // No bundled model — fall back to the default CDN so the
        // system still works, and say so, because this path will
        // fail on a server with no internet route.
        : {};

    if (!hasLocalData) {
        console.warn(
            `[OCR] No local language data at ${LANG_PATH}. Falling back to the ` +
            `tesseract.js CDN, which requires internet access. Place ` +
            `${language}.traineddata there for offline operation.`
        );
    }

    _workerPromise = Tesseract.createWorker(language, 1, options)
        .catch(err => { _workerPromise = null; throw err; });
    return _workerPromise;
}

/** Releases the shared worker (used on shutdown and in tests). */
async function terminate() {
    if (!_workerPromise) return;
    try { const w = await _workerPromise; await w.terminate(); } catch (_) {}
    _workerPromise = null;
}

// ── OCR (Module 3) ───────────────────────────────────────────

/** True when the file begins with the %PDF- signature. */
function isPdfFile(filePath) {
    try {
        const fd  = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(5);
        fs.readSync(fd, buf, 0, 5, 0);
        fs.closeSync(fd);
        return buf.toString('latin1') === '%PDF-';
    } catch (_) {
        return /\.pdf$/i.test(filePath);
    }
}

/**
 * Renders selected pages of a PDF to PNG buffers.
 *
 * tesseract.js reads images, not PDFs, so scanned PDFs previously
 * could not be OCR'd at all. Rasterising here both enables them and
 * lets us read only the pages we need.
 */
/**
 * The words already inside a PDF, page by page, in reading order.
 * A page with almost no words (a scan) gets text ''.
 */
async function pdfTextLayer(filePath, maxPages = 0) {
    const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = lib.getDocument({ data: new Uint8Array(fs.readFileSync(filePath)), isEvalSupported: false, verbosity: 0 });
    const doc = await task.promise;
    try {
        const last = maxPages > 0 ? Math.min(maxPages, doc.numPages) : doc.numPages;
        const pages = [];
        for (let n = 1; n <= last; n++) {
            const page = await doc.getPage(n);
            const tc = await page.getTextContent();
            const vp = page.getViewport({ scale: 1 });
            // v97: the fonts (e.g. "Helvetica-Bold"), for copying bold,
            // italic and the font family.
            const fonts = {};
            try {
                await page.getOperatorList();
                for (const it of tc.items) {
                    if (!it.fontName || fonts[it.fontName]) continue;
                    let name = '';
                    try { const f = page.commonObjs.get(it.fontName); name = (f && (f.name || f.loadedName)) || ''; } catch (_) { /* not loaded */ }
                    fonts[it.fontName] = fontStyle(name, (tc.styles[it.fontName] || {}).fontFamily);
                }
            } catch (_) { /* fonts unknown: plain */ }
            page.cleanup();
            // Rebuild lines: items on the same baseline, left to right.
            const rows = [];
            for (const it of tc.items) {
                const str = String(it.str || '');
                if (!str.trim()) continue;
                const y = it.transform[5], x = it.transform[4], h = Math.abs(it.height || it.transform[3] || 10);
                let row = rows.find(r => Math.abs(r.y - y) <= Math.max(2, h * 0.4));
                if (!row) { row = { y, h, parts: [] }; rows.push(row); }
                row.parts.push({ x, w: it.width || 0, str, st: fonts[it.fontName] || null });
            }
            rows.sort((a, b) => b.y - a.y);
            const W = vp.width, H = vp.height;
            const boxes = [];           // v97: where each line is, for copying the layout
            const lines = rows.map(r => {
                r.parts.sort((a, b) => a.x - b.x);
                let line = '', end = null;
                const runs = [];
                for (const p of r.parts) {
                    let piece = p.str;
                    if (end !== null && p.x - end > r.h * 0.15 && !line.endsWith(' ') && !p.str.startsWith(' ')) piece = ' ' + piece;
                    line += piece; end = p.x + p.w;
                    const st = p.st || { b: false, i: false, font: null };
                    const last = runs[runs.length - 1];
                    if (last && last.b === st.b && last.i === st.i && last.font === st.font) last.text += piece;
                    else runs.push({ text: piece, b: st.b, i: st.i, u: false, font: st.font });
                }
                line = line.replace(/[ \t]+/g, ' ').trim();
                if (line) {
                    const x0 = r.parts[0].x, x1 = Math.max(...r.parts.map(p => p.x + p.w));
                    runs.forEach(x => { x.text = x.text.replace(/[ \t]+/g, ' '); });
                    if (runs.length) { runs[0].text = runs[0].text.replace(/^\s+/, ''); runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\s+$/, ''); }
                    boxes.push({ text: line, x0: x0 / W, x1: x1 / W, y0: (H - r.y - r.h * 0.78) / H, y1: (H - r.y + r.h * 0.22) / H, size: r.h,
                                 runs: runs.filter(x => x.text) });
                }
                return line;
            }).filter(Boolean);
            const text = lines.join('\n');
            const scanned = text.replace(/\s+/g, '').length < 20;
            pages.push({ page: n, text: scanned ? '' : text, layout: scanned ? null : { w: W, h: H, lines: boxes } });
        }
        return { pages, totalPages: doc.numPages };
    } finally {
        await task.destroy();
    }
}

async function renderPdfPages(filePath, firstPage, lastPage) {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: fs.readFileSync(filePath) });
    try {
        // When no last page is given the intent is "read everything",
        // so resolve the real page count first. Passing an undefined
        // `last` makes the renderer return only the first page, which
        // would silently truncate a full-text index to page one.
        let last = lastPage;
        if (!last || last < 1) {
            const info = await parser.getInfo();
            last = (info && (info.total || info.numPages)) || 1;
        }
        const shot = await parser.getScreenshot({
            first: firstPage,
            last,
            scale: RENDER_SCALE,
        });
        const pages = (shot && shot.pages) ? shot.pages : [];
        return {
            images: pages.map(p => p.data).filter(Boolean),
            sizes:  pages.filter(p => p.data).map(p => [p.width, p.height]),
            totalPages: shot ? shot.total : pages.length,
        };
    } finally {
        try { await parser.destroy(); } catch (_) {}
    }
}

/** Width and height of a PNG or JPEG picture, or null. */
function imageSize(buf) {
    try {
        if (buf.readUInt32BE(0) === 0x89504E47) return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
        if (buf[0] === 0xFF && buf[1] === 0xD8) {
            for (let i = 2; i < buf.length - 9;) {
                if (buf[i] !== 0xFF) { i++; continue; }
                const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
                if (m >= 0xC0 && m <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(m)) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
                i += 2 + len;
            }
        }
    } catch (_) { /* not a picture we know */ }
    return null;
}

/** Bold / italic / family from a PDF font name such as "ABCDEF+Arial-BoldItalicMT". */
function fontStyle(name, family) {
    const n = String(name || '').replace(/^[A-Z]{6}\+/, '');
    const all = (n + ' ' + (family || '')).toLowerCase();
    const font = /courier|mono|consol/.test(all) ? 'Courier New'
        : /helvetica|arial|sans|calibri|verdana|tahoma|segoe|liberation ?sans|century gothic|franklin/.test(all) ? 'Arial'
        : 'Times New Roman';
    return { b: /bold|black|heavy|semibold|demi/i.test(n), i: /italic|oblique/i.test(n), font };
}

/**
 * v97: which lines of a scanned page are bold. Bold letters have thicker
 * strokes: for each line, the usual length of a run of dark pixels across
 * the letters is compared with the line's height, and lines clearly
 * thicker than the rest of the page are bold. Returns a Set of indexes.
 */
async function boldLines(img, boxes) {
    const bold = new Set();
    if (!img || boxes.length < 3) return bold;
    let ctx, W, H;
    try {
        const { loadImage, createCanvas } = require('@napi-rs/canvas');
        const pic = await loadImage(Buffer.isBuffer(img) ? img : Buffer.from(img));
        W = pic.width; H = pic.height;
        const cv = createCanvas(W, H); ctx = cv.getContext('2d'); ctx.drawImage(pic, 0, 0);
    } catch (_) { return bold; }
    const ratios = boxes.map(b => {
        const x0 = Math.max(0, Math.floor(b.x0)), y0 = Math.max(0, Math.floor(b.y0));
        const w = Math.min(W - x0, Math.ceil(b.x1 - b.x0)), h = Math.min(H - y0, Math.ceil(b.y1 - b.y0));
        if (w < 8 || h < 6) return null;
        const px = ctx.getImageData(x0, y0, w, h).data;
        const runs = [];
        for (let y = 0; y < h; y++) {
            let run = 0;
            for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4, dark = (px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11) < 140;
                if (dark) run++; else if (run) { if (run < h * 0.6) runs.push(run); run = 0; }
            }
        }
        if (runs.length < 20) return null;
        runs.sort((a, b) => a - b);
        return runs[Math.floor(runs.length / 2)] / h;          // stroke width / line height
    });
    const known = ratios.filter(r => r != null).sort((a, b) => a - b);
    if (known.length < 3) return bold;
    const usual = known[Math.floor(known.length / 2)];
    ratios.forEach((r, i) => { if (r != null && r > usual * 1.3) bold.add(i); });
    return bold;
}

/**
 * v97: where each line of a scanned page is (fractions of the page, 0–1),
 * and how tall it is, so the OCR page can copy the layout: the spaces
 * between lines, indents, centred lines and bigger headings.
 */
async function ocrLines(data, W, H, img) {
    if (!W || !H) return null;
    const lines = [], boxes = [];
    for (const l of (data.lines || [])) {
        const text = String(l.text || '').replace(/\s+/g, ' ').trim();
        if (!text || !l.bbox) continue;
        if (typeof l.confidence === 'number' && l.confidence < 20 && text.length < 3) continue;   // specks
        const { x0, y0, x1, y1 } = l.bbox;
        const rowH = l.rowAttributes && l.rowAttributes.row_height ? l.rowAttributes.row_height : (y1 - y0);
        lines.push({ text, x0: x0 / W, x1: x1 / W, y0: y0 / H, y1: y1 / H, rowH: rowH / H });
        boxes.push(l.bbox);
    }
    try { (await boldLines(img, boxes)).forEach(i => { lines[i].bold = true; }); } catch (_) { /* plain */ }
    return { lines };
}

/**
 * Runs OCR over a document.
 *
 * @param {string} filePath
 * @param {string} language
 * @param {object} opts
 *   opts.maxPages  how many pages to read for a PDF. Defaults to
 *                  AUTOFILL_PAGES (1) — enough for the resolution
 *                  number, title and year. Pass 0 for every page
 *                  when building the full-text search index.
 */
async function extractText(filePath, language = 'eng', opts = {}) {
    const maxPages = opts.maxPages === undefined ? AUTOFILL_PAGES : opts.maxPages;
    const worker   = await getWorker(language);
    // Detect PDFs by their magic bytes rather than by filename.
    // Uploads are stored by multer under a random name with no
    // extension, so an extension check would misclassify every
    // uploaded PDF as an image.
    const isPdf    = isPdfFile(filePath);

    // --- plain image: one recognise call -------------------------------
    if (!isPdf) {
        const { data } = await worker.recognize(filePath);
        const picture = fs.readFileSync(filePath);
        const dims = imageSize(picture) || [];
        return {
            text:       data.text,
            pages:      [data.text || ''],         // the words of each page (v97)
            layout:     [await ocrLines(data, dims[0], dims[1], picture)],
            confidence: data.confidence,
            words:      data.words ? data.words.length : 0,
            pagesRead:  1,
            totalPages: 1,
        };
    }

    // --- PDF made on a computer (e.g. a resolution or manual saved from
    // Word): its words are already inside the file. Reading them directly
    // is instant and exact — no OCR mistakes such as "Academic Y ear" —
    // and only pages that are pictures (scans) are read with OCR.
    const wanted = maxPages && maxPages > 0 ? maxPages : 0;
    try {
        const layer = await pdfTextLayer(filePath, wanted);
        if (layer && layer.pages.some(p => p.text)) {
            const texts = [], layouts = [];
            let confSum = 0, wordSum = 0;
            for (const pg of layer.pages) {
                if (pg.text) {
                    texts.push(pg.text);
                    layouts.push(pg.layout);
                    confSum += 100;
                    wordSum += pg.text.split(/\s+/).filter(Boolean).length;
                    continue;
                }
                // A scanned page inside a typed PDF.
                const { images, sizes } = await renderPdfPages(filePath, pg.page, pg.page);
                if (!images.length) continue;
                const { data } = await worker.recognize(images[0]);
                texts.push(data.text || '');
                const dims = sizes[0] || imageSize(Buffer.from(images[0])) || [];
                layouts.push(await ocrLines(data, dims[0], dims[1], images[0]));
                confSum += (data.confidence || 0);
                wordSum += data.words ? data.words.length : 0;
            }
            return {
                text:       texts.join('\n\n'),
                pages:      texts,
                layout:     layouts,
                confidence: layer.pages.length ? confSum / layer.pages.length : 0,
                words:      wordSum,
                pagesRead:  layer.pages.length,
                totalPages: layer.totalPages,
                textLayer:  true,
            };
        }
    } catch (err) {
        console.warn('[ocr] could not read the PDF text directly, using OCR:', err.message);
    }

    // --- Scanned PDF: rasterise the required pages, then OCR each ------
    // maxPages 0 (or negative) means "every page", used when building
    // the full-text search index rather than filling the upload form.
    const { images, sizes, totalPages } = await renderPdfPages(filePath, 1, wanted);
    if (!images.length) {
        throw new Error('The PDF could not be rendered for OCR.');
    }

    const texts = [], layouts = [];
    let confSum = 0, wordSum = 0;
    for (const [i, img] of images.entries()) {
        const { data } = await worker.recognize(img);
        texts.push(data.text || '');
        const dims = (sizes && sizes[i]) || imageSize(Buffer.from(img)) || [];
        layouts.push(await ocrLines(data, dims[0], dims[1], img));
        confSum += (data.confidence || 0);
        wordSum += data.words ? data.words.length : 0;
    }

    return {
        text:       texts.join('\n\n'),
        pages:      texts,
        layout:     layouts,
        confidence: images.length ? confSum / images.length : 0,
        words:      wordSum,
        pagesRead:  images.length,
        totalPages: totalPages || images.length,
    };
}

/**
 * OCRs ONE page of a PDF and returns every recognised word with its
 * position, for making a scanned page selectable in the document
 * review page.
 *
 * Positions are returned as fractions of the page (0–1) so they line
 * up with the page at any zoom level. Each word is
 *   [x, y, w, h, text, line]
 * where `line` numbers the text lines on the page, so the viewer can
 * put line breaks between them and a selection reads naturally.
 */
async function ocrPdfPageWords(filePath, pageNo, language = 'eng') {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: fs.readFileSync(filePath) });
    let shot;
    try {
        shot = await parser.getScreenshot({ first: pageNo, last: pageNo, scale: RENDER_SCALE });
    } finally {
        try { await parser.destroy(); } catch (_) {}
    }
    const page = shot && shot.pages && shot.pages[0];
    if (!page || !page.data || !page.width || !page.height) {
        throw new Error(`Page ${pageNo} could not be rendered for OCR.`);
    }
    const worker = await getWorker(language);
    const { data } = await worker.recognize(page.data);
    // Words refer to their line by a separate object, so lines are
    // matched by their bounding box rather than by identity.
    const boxKey = b => (b ? `${b.x0},${b.y0},${b.x1},${b.y1}` : '');
    const lineIndex = new Map((data.lines || []).map((l, i) => [boxKey(l.bbox), i]));
    const W = page.width, H = page.height;
    const r4 = v => Math.round(v * 10000) / 10000;
    const words = [];
    for (const w of (data.words || [])) {
        const text = String(w.text || '').trim();
        if (!text || !w.bbox) continue;
        // Very low-confidence "words" are usually specks or lines in
        // the scan; leaving them out keeps selections clean.
        if (typeof w.confidence === 'number' && w.confidence < 30) continue;
        const { x0, y0, x1, y1 } = w.bbox;
        words.push([r4(x0 / W), r4(y0 / H), r4((x1 - x0) / W), r4((y1 - y0) / H),
                    text, (w.line && lineIndex.has(boxKey(w.line.bbox))) ? lineIndex.get(boxKey(w.line.bbox)) : -1]);
    }
    return { words, confidence: data.confidence || 0 };
}

// ── Metadata Autofill (Module 2.4) ───────────────────────────

// CSPC board documents commonly begin with headers of the form:
//
//   "BOARD RESOLUTION NO. 2024-045"
//   "Board Resolution No. 2023-12"
//   "BOARD RESOLUTION No. 045, Series of 2024"
//
// And dates of the form:
//
//   "Done this 15th day of October 2024"
//   "October 15, 2024"
//   "15 October 2024"
//
// The regular expressions below aim to locate these patterns in
// the OCR output. Each pattern is conservative: if a pattern
// does not match with reasonable confidence, the corresponding
// metadata field is flagged as "needs manual review" so that
// the uploader can fill it in before the document is archived.

// Real CSPC excerpts head each resolution with "Resolution No. 18-35"
// (the word "Board" is NOT present). Two numbering eras are in use:
//
//   18-35, 19-50    two-digit year, used up to and including 2019
//   2020-15         four-digit year, used from 2020 onward
//
// The "Board Resolution No." form is still accepted because standalone
// resolution documents (as opposed to minutes excerpts) do use it.
const DOC_NUMBER_RE = /(?:Board\s+)?Resolution\s+No\.?\s*([0-9]{2,4}\s*[-–—]\s*[0-9]{1,4}|[A-Z0-9][A-Z0-9\-\/]{2,})/i;

// Every resolution in a document, with the operative paragraph that
// follows it. A single excerpt routinely carries five to seven.
const RESOLUTION_BLOCK_RE =
    /(?:Board\s+)?Resolution\s+No\.?\s*([0-9]{2,4}\s*[-–—]\s*[0-9]{1,4})\s*\n+([\s\S]*?)(?=(?:Board\s+)?Resolution\s+No\.?\s*[0-9]|\n\s*[•·]\s|\nx\s*-\s*-|Certified\s+correct|$)/gi;

// Header line of a minutes excerpt, e.g.
//   "Excerpt from the Minutes of the 85th Regular Board of Trustees
//    Meeting of the Camarines Sur Polytechnic Colleges held on
//    June 22, 2018 at CHED Central Office, Quezon City"
const EXCERPT_HEADER_RE =
    /Excerpt\s+from\s+the\s+Minutes\s+of\s+the\s+(\d+)\s*(?:st|nd|rd|th)\s+(Regular|Special)\s+Board\s+of\s+Trustees\s+Meeting[\s\S]{0,160}?held\s+on\s+([A-Z][a-z]+\s+\d{1,2},\s*\d{4})\s*(?:at|via)?\s*([^\n]{0,80})?/i;
const DOC_TYPE_RE   = /\b(Resolution|Minutes|Referenda?|Correspondence)\b/i;
const YEAR_RE       = /\b(19|20)\d{2}\b/;
const DATE_RE       = new RegExp(
    '(?:' +
        // "15 October 2024" / "15th day of October 2024"
        '(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:day\\s+of\\s+)?' +
        '(January|February|March|April|May|June|July|' +
         'August|September|October|November|December)\\s+' +
        '(\\d{4})' +
    '|' +
        // "October 15, 2024"
        '(January|February|March|April|May|June|July|' +
         'August|September|October|November|December)\\s+' +
        '(\\d{1,2}),?\\s+(\\d{4})' +
    ')',
    'i'
);

/**
 * Parses OCR output and attempts to autofill the document
 * metadata fields. Returns an object with four possible keys
 * (documentNumber, documentType, year, date) plus a `review`
 * array listing any fields that could not be confidently found.
 */
function extractMetadata(ocrText) {
    const result = {
        documentNumber: null,
        documentType:   null,
        year:           null,
        date:           null,
        review:         [],     // fields that need manual review
    };

    // --- document number -----------------------------------------------------
    const docMatch = ocrText.match(DOC_NUMBER_RE);
    if (docMatch) {
        result.documentNumber = docMatch[1].trim();
    } else {
        result.review.push('documentNumber');
    }

    // --- document type -------------------------------------------------------
    const typeMatch = ocrText.match(DOC_TYPE_RE);
    if (typeMatch) {
        result.documentType = typeMatch[1][0].toUpperCase() + typeMatch[1].slice(1).toLowerCase();
    } else {
        result.review.push('documentType');
    }

    // --- year ----------------------------------------------------------------
    // Prefer a year adjacent to the doc number (e.g. "2024-045"); otherwise
    // fall back to the first 4-digit year found in the text.
    let year = null;
    if (result.documentNumber) {
        // Four-digit era: "2020-15"
        const y4 = result.documentNumber.match(/^(19|20)\d{2}/);
        if (y4) {
            year = y4[0];
        } else {
            // Two-digit era: "18-35" -> 2018, "99-04" -> 1999.
            // CSPC board records begin in 1985, so anything from 85
            // upward is 19xx and anything below is 20xx.
            const y2 = result.documentNumber.match(/^(\d{2})\s*[-–—]/);
            if (y2) {
                const n = parseInt(y2[1], 10);
                year = String(n >= 85 ? 1900 + n : 2000 + n);
            }
        }
    }
    if (!year) {
        const yMatch = ocrText.match(YEAR_RE);
        if (yMatch) year = yMatch[0];
    }
    if (year) {
        result.year = parseInt(year, 10);
    } else {
        result.review.push('year');
    }

    // --- date ----------------------------------------------------------------
    const dateMatch = ocrText.match(DATE_RE);
    if (dateMatch) {
        // Normalize: pull whichever capture groups matched into YYYY-MM-DD
        const monthIndex = {
            january: '01', february: '02', march: '03', april: '04',
            may: '05', june: '06', july: '07', august: '08',
            september: '09', october: '10', november: '11', december: '12',
        };
        let day, month, yr;
        if (dateMatch[1]) {
            // "15 October 2024" pattern
            day   = dateMatch[1].padStart(2, '0');
            month = monthIndex[dateMatch[2].toLowerCase()];
            yr    = dateMatch[3];
        } else {
            // "October 15, 2024" pattern
            day   = dateMatch[5].padStart(2, '0');
            month = monthIndex[dateMatch[4].toLowerCase()];
            yr    = dateMatch[6];
        }
        result.date = `${yr}-${month}-${day}`;
    } else {
        result.review.push('date');
    }

    return result;
}

// ── Title extraction (Module 2.4) ────────────────────────────
//
// CSPC resolutions carry their subject in one of a few shapes:
//
//   "SUBJECT: Adoption of the FY 2027 Budget"
//   "RE: Approval of the Revised Promotion Policy"
//   "A RESOLUTION APPROVING THE REVISED PROMOTION POLICY"
//   "RESOLUTION ADOPTING THE STRATEGIC PLAN 2026-2030"
//
// or else the subject simply sits on its own line just below the
// resolution number, above the first WHEREAS clause.

// Header boilerplate that appears on every CSPC document and is
// therefore never the title.
// Header/footer boilerplate. These match by PREFIX rather than whole
// line, because address lines carry trailing text — "Nabua, Camarines
// Sur" must be rejected just as surely as a bare "Nabua".
const BOILERPLATE_RE = new RegExp(
    '^(?:' +
        'republic\\s+of\\s+the\\s+philippines|' +
        'camarines\\s+sur\\s+polytechnic|' +
        'office\\s+of\\s+the\\s+board|' +
        'board\\s+of\\s+trustees|' +
        'nabua\\b|' +
        'san\\s+miguel\\b|' +
        'camarines\\s+sur\\b|' +
        'philippines\\b|' +
        '\\(?series\\s+of\\b|' +
        'board\\s+resolution\\s+no|' +
        'resolution\\s+no\\b|' +
        'done\\s+in\\b|' +
        'excerpt\\s+from\\s+the\\s+minutes|' +
        '(?:i{1,3}|iv|v|vi{1,3})\\.\\s+(?:new|old|other)\\s+business|' +
        '[a-d]\\.\\s+matters\\s+for\\b|' +
        '\\d\\.\\s+(?:administrative|financial|academic|policy)\\s+matters?\\b|' +
        'new\\s+business\\s*$|' +
        'page\\s+\\d+|' +
        '[-–—_=*.\\s]+$' +
    ')',
    'i'
);

const SUBJECT_RE   = /^\s*(?:SUBJECT|RE|TITLE)\s*[:\-–]\s*(.+)$/im;
const RES_PHRASE_RE = /^\s*((?:A\s+)?RESOLUTION\s+(?:APPROVING|ADOPTING|AUTHORIZING|AUTHORISING|CONFIRMING|CREATING|ESTABLISHING|AMENDING|GRANTING|RATIFYING|ENDORSING|DECLARING|RENAMING|INCREASING)\b.{0,180})$/im;

function cleanLine(line) {
    return line
        .replace(/\s+/g, ' ')
        .replace(/^[\s"'“”*_\-–—]+|[\s"'“”*_\-–—]+$/g, '')
        .trim();
}

// Converts an ALL-CAPS heading into Title Case, leaving mixed-case
// text alone. OCR of official documents is very often all-caps,
// which looks like shouting in the archive list.
function tidyCase(text) {
    if (!text) return text;
    const letters = text.replace(/[^A-Za-z]/g, '');
    if (!letters) return text;
    const upperRatio = (text.replace(/[^A-Z]/g, '').length) / letters.length;
    if (upperRatio < 0.8) return text;   // already mixed case — leave as-is

    const small = new Set(['a','an','and','as','at','but','by','for','in','of','on','or','the','to','via','with']);
    return text.toLowerCase().split(' ').map((w, i) => {
        const bare = w.replace(/[^a-z0-9]/g, '');
        if (i > 0 && small.has(bare)) return w;
        return w.replace(/([a-z])/, c => c.toUpperCase());
    }).join(' ');
}

/**
 * Attempts to locate the subject/title of the document within the
 * OCR text. Returns null when nothing convincing is found, so the
 * caller can flag the field for manual entry rather than guessing.
 */
function extractTitle(ocrText) {
    if (!ocrText) return null;

    // 0) If the document carries actual resolutions, their operative
    //    text is the most accurate source of a title. This is the
    //    normal case for CSPC minutes excerpts, whose page header
    //    ("Excerpt from the Minutes of the 85th ...") says nothing
    //    about the subject matter.
    const res = extractResolutions(ocrText);
    if (res.length && res[0].title) return res[0].title;

    // 1) An explicit SUBJECT: / RE: line is the most reliable signal.
    const subj = ocrText.match(SUBJECT_RE);
    if (subj) {
        const t = cleanLine(subj[1]);
        if (t.length >= 6) return tidyCase(t);
    }

    // 2) A "RESOLUTION APPROVING ..." style phrase.
    const phrase = ocrText.match(RES_PHRASE_RE);
    if (phrase) {
        const t = cleanLine(phrase[1]);
        if (t.length >= 10) return tidyCase(t);
    }

    // 3) Otherwise take the first substantial non-boilerplate line
    //    that appears before the first WHEREAS clause.
    const body   = ocrText.split(/WHEREAS/i)[0] || ocrText;
    const lines  = body.split('\n').map(cleanLine).filter(Boolean);
    for (const line of lines) {
        if (BOILERPLATE_RE.test(line)) continue;
        if (/^board\s+resolution/i.test(line)) continue;
        if (line.length < 12 || line.length > 200) continue;
        if (!/[a-zA-Z]{4}/.test(line)) continue;      // must contain real words
        return tidyCase(line);
    }

    return null;
}

/**
 * Parses the "Excerpt from the Minutes of the Nth Regular Board of
 * Trustees Meeting ... held on <date> at <venue>" header.
 * Returns null when the document is not a minutes excerpt.
 */
function extractMeetingHeader(ocrText) {
    if (!ocrText) return null;
    const flat = ocrText.replace(/\s*\n\s*/g, ' ');
    const m = flat.match(EXCERPT_HEADER_RE);
    if (!m) return null;
    // The header runs straight into the body once newlines are
    // flattened, so cut the venue at the first structural marker
    // (Roman-numeral section, "NEW BUSINESS", a rule line, etc).
    let venue = (m[4] || '')
        .split(/\s+(?:[IVX]+\.\s|NEW\s+BUSINESS|OLD\s+BUSINESS|[A-D]\.\s+Matters|Resolution\s+No|x\s*-{3,})/i)[0]
        .trim()
        .replace(/[.,;]+$/, '');
    // "held on May 28, 2020 via Zoom" -> venue "Zoom"
    if (/via\s+/i.test(flat.slice(m.index, m.index + m[0].length)) && !venue) venue = 'Zoom';
    return {
        meetingOrdinal: parseInt(m[1], 10),   // 85, 89, 91 ...
        meetingKind:    m[2][0].toUpperCase() + m[2].slice(1).toLowerCase(),
        meetingDate:    m[3],
        venue:          venue || null,
    };
}

/**
 * Enumerates EVERY resolution in the document.
 *
 * A single CSPC excerpt commonly carries five to seven resolutions
 * (the 85th Regular Meeting excerpt holds 18-35 through 18-41), so
 * treating a file as one resolution silently loses the rest. Each
 * entry carries its number, derived year, operative text, and a
 * title derived from that text.
 */
function extractResolutions(ocrText) {
    if (!ocrText) return [];
    const out = [];
    RESOLUTION_BLOCK_RE.lastIndex = 0;
    let m;
    while ((m = RESOLUTION_BLOCK_RE.exec(ocrText)) !== null) {
        const number = m[1].replace(/\s*[-–—]\s*/, '-').trim();

        // The captured block runs up to the NEXT resolution, so for
        // all but the last it also swallows the following agenda-item
        // heading and its motion paragraph. The operative text is only
        // the first paragraph, so cut at the first blank line.
        let raw = (m[2] || '').replace(/\r/g, '');
        raw = raw.split(/\n\s*\n/)[0];
        const text = cleanLine(raw);
        if (!text) continue;

        let year = null;
        const y4 = number.match(/^(19|20)\d{2}/);
        if (y4) {
            year = parseInt(y4[0], 10);
        } else {
            const y2 = number.match(/^(\d{2})-/);
            if (y2) {
                const n = parseInt(y2[1], 10);
                year = n >= 85 ? 1900 + n : 2000 + n;
            }
        }

        out.push({ number, year, text, title: titleFromResolutionText(text) });
    }
    return out;
}

/**
 * CSPC resolution text follows a fixed shape:
 *
 *   "Approving the Staffing Modifications of the College for CY 2018,
 *    subject to the approval of the Department of Budget and Management."
 *
 * The subject is everything between the leading gerund and the
 * trailing "subject to ..." condition, which makes a far better
 * archive title than the page header.
 */
function titleFromResolutionText(text) {
    if (!text) return null;
    let t = String(text).trim();
    t = t.split(/,?\s*subject\s+to\b/i)[0];               // drop the condition
    t = t.replace(/^(Approving|Adopting|Authoris|Authoriz|Confirming|Granting|Ratifying|Endorsing|Creating|Establishing|Amending|Declaring)\w*\s+/i, '');
    t = t.replace(/^the\s+/i, '');
    t = cleanLine(t).replace(/[.;]+$/, '');
    if (t.length < 4) return null;
    if (t.length > 160) t = t.slice(0, 160).replace(/\s+\S*$/, '') + '…';
    return t.charAt(0).toUpperCase() + t.slice(1);
}

// ── Description (Module 2.4) ─────────────────────────────────
//
// Produces a short plain-language summary of what the resolution
// does. This is the extractive fallback used when the local LLM
// is unavailable; llmService.describeDocument() is preferred when
// Ollama is running.

const RESOLVED_RE = /(?:NOW,?\s*THEREFORE,?\s*)?BE\s+IT\s+RESOLVED[,:]?\s*(?:that\s*)?([\s\S]{0,400})/i;

function buildDescription(ocrText, maxLen = 240) {
    if (!ocrText) return '';

    // Minutes excerpts have no "BE IT RESOLVED" wording at all; the
    // operative text simply follows the "Resolution No. X" heading.
    // Prefer that when present.
    const res = extractResolutions(ocrText);
    if (res.length && res[0].text) {
        let t = cleanLine(res[0].text);
        if (t.length > maxLen) {
            const cut = t.slice(0, maxLen);
            const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
            t = (stop > 60 ? cut.slice(0, stop) : cut.replace(/\s+\S*$/, '')) + '…';
        }
        if (!/[.…]$/.test(t)) t += '.';
        return t.charAt(0).toUpperCase() + t.slice(1);
    }

    // Otherwise fall back to the classic "BE IT RESOLVED" clause used
    // by standalone resolution documents.
    let source = null;
    const resolved = ocrText.match(RESOLVED_RE);
    if (resolved && resolved[1] && resolved[1].trim().length > 20) {
        source = resolved[1];
    } else {
        // Fall back to the first prose paragraph after the header.
        const body = ocrText.split('\n').map(cleanLine).filter(Boolean)
            .filter(l => !BOILERPLATE_RE.test(l) && l.length > 40);
        source = body[0] || '';
    }

    // Cut the closing formalities: "DONE in Nabua...", signature blocks,
    // and any trailing "APPROVED"/"ATTESTED" lines are not content.
    source = String(source).split(/\bDONE\s+in\b|\bAPPROVED\s*:|\bATTESTED\s*:|\bCERTIFIED\s+CORRECT\b/i)[0];

    let text = cleanLine(source).replace(/\s*;\s*$/, '');
    if (!text) return '';

    // Trim to whole sentences where possible.
    if (text.length > maxLen) {
        const cut = text.slice(0, maxLen);
        const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
        text = (lastStop > 60 ? cut.slice(0, lastStop) : cut.replace(/\s+\S*$/, '')) + '…';
    }
    if (!/[.…]$/.test(text)) text += '.';

    // Sentence-case the result if OCR returned all caps.
    if (text === text.toUpperCase()) {
        text = text.charAt(0) + text.slice(1).toLowerCase();
    }
    // The RESOLVED clause usually begins mid-sentence ("that the Board
    // hereby adopts..."), so capitalise the opening letter.
    text = text.charAt(0).toUpperCase() + text.slice(1);
    return text;
}

module.exports = {
    extractText, extractMetadata, extractTitle, buildDescription, tidyCase,
    extractResolutions, extractMeetingHeader, titleFromResolutionText,
    renderPdfPages, terminate, isPdfFile, ocrPdfPageWords, imageSize,
};
