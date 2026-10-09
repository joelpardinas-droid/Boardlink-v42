// ============================================================
// services/textDocService.js — a clean Word or PDF file made from
// words read with OCR (and corrected by the Board Secretary)
// ============================================================
//
// The OCR page reads an old scanned paper, the Secretary fixes and
// formats the words in a small editor (bold, italic, underline, capital
// letters, centred lines…), and BOARDLINK turns them into a new, typed
// document: a Word file to keep editing, or a PDF for the Digital Archive.
//
// The editor sends the document as paragraphs:
//   [{ align: 'left'|'center'|'right'|'justify', pb: true|false,
//      runs: [{ text, b, i, u }] }]          ("\n" in text = line break,
//                                             pb = starts on a new page)
// Plain text (blank line = new paragraph) is accepted too.
//
// v97: the pages are laid out like Microsoft Word's default page: the
// chosen paper (Letter, A4 or Long 8.5" x 13"), 1-inch margins, Times New
// Roman 12 pt. The editor on the OCR page shows the same pages. The PDF is
// made from the Word file with LibreOffice when it is installed, so the
// PDF's pages are the Word file's pages; otherwise it is drawn directly.

const path = require('path');
const { Document, Packer, Paragraph, TextRun, AlignmentType, LineRuleType } = require('docx');
const PDFDocument = require('pdfkit');

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');

const layout = require('./layoutService');

const FONT_DIR = path.join(__dirname, '..', 'fonts');

// Paper sizes: Word units (twips, 1/1440 inch) and PDF points (1/72 inch).
const PAPERS = {
    letter: { label: 'Letter (8.5" × 11")', twips: [12240, 15840], pt: [612, 792] },
    a4:     { label: 'A4 (8.27" × 11.69")', twips: [11906, 16838], pt: [595.28, 841.89] },
    long:   { label: 'Long (8.5" × 13")',   twips: [12240, 18720], pt: [612, 936] },
};
const paperOf = k => PAPERS[k] ? k : 'letter';
// Spacing shared with the editor on the OCR page: 12 pt Times New Roman,
// each line exactly 15 pt high, 10 pt after each paragraph. "Exactly"
// makes Word, LibreOffice and the browser put the same lines on a page.
const LINE = 300, AFTER = 200;          // twips (1/20 pt)
const ALIGNS = ['left', 'center', 'right', 'justify'];
const FONTS = ['Times New Roman', 'Arial', 'Courier New'];
const LIMITS = { paragraphs: 5000, runs: 400, chars: 900000 };

const cleanText = s => String(s == null ? '' : s)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** Paragraphs (arrays of lines) from plain text. */
function paragraphs(text) {
    return cleanText(text)
        .split(/\n[ \t]*\n+/)
        .map(p => p.split('\n').map(l => l.replace(/[ \t]+$/g, '')))
        .filter(lines => lines.some(l => l.trim()));
}

// Short lines written in capitals (REPUBLIC OF THE PHILIPPINES,
// RESOLUTION NO. 2026-22, …) are headings in Board papers: centred, bold.
function isHeading(lines) {
    const t = lines.join(' ').trim();
    return lines.length <= 3 && t.length <= 90 && /[A-Z]/.test(t) && t === t.toUpperCase();
}

/** Plain text → formatted paragraphs (headings centred and bold). */
function fromText(text) {
    return paragraphs(text).map(lines => {
        const head = isHeading(lines);
        // Lines kept as they were read are not stretched to both sides
        // (Word and LibreOffice stretch a justified line that ends in a
        // line break); a real paragraph of wrapped text is justified.
        return { align: head ? 'center' : (lines.length > 1 ? 'left' : 'justify'), runs: [{ text: lines.join('\n'), b: head, i: false, u: false }] };
    });
}

/**
 * Checks what the browser sent. Returns clean paragraphs, or null when
 * it is not a usable document (then the plain text is used).
 */
function normalize(doc) {
    let list = doc;
    if (typeof list === 'string') {
        try { list = JSON.parse(list); } catch (_) { return null; }
    }
    if (!Array.isArray(list) || !list.length || list.length > LIMITS.paragraphs) return null;
    let total = 0;
    const out = [];
    for (const p of list) {
        if (!p || !Array.isArray(p.runs) || p.runs.length > LIMITS.runs) return null;
        const runs = [];
        for (const r of p.runs) {
            if (!r || typeof r.text !== 'string') return null;
            const text = cleanText(r.text);
            if (!text) continue;
            total += text.length;
            if (total > LIMITS.chars) return null;
            const prev = runs[runs.length - 1];
            const fmt = { b: !!r.b, i: !!r.i, u: !!r.u };
            if (FONTS.includes(r.font) && r.font !== 'Times New Roman') fmt.font = r.font;      // v97
            if (prev && prev.b === fmt.b && prev.i === fmt.i && prev.u === fmt.u && prev.font === fmt.font) prev.text += text;
            else runs.push({ text, ...fmt });
        }
        const para = { align: ALIGNS.includes(p.align) ? p.align : 'left', pb: !!p.pb, runs };
        // v97: the layout copied from the scan (points), when there is one.
        const num = (v, lo, hi) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x * 2) / 2)) : null; };
        if (p.size != null) {
            para.size = num(p.size, 6, 36) || 12;
            para.line = num(p.line, 6, 80) || para.size * 1.2;
            para.before = num(p.before, 0, 600) || 0;
            para.indent = num(p.indent, 0, 500) || 0;
            para.first = num(p.first, -500, 400) || 0;
        }
        out.push(para);
    }
    // Drop empty paragraphs at the start and end.
    while (out.length && !out[0].runs.some(r => r.text.trim())) out.shift();
    while (out.length && !out[out.length - 1].runs.some(r => r.text.trim())) out.pop();
    return out.length ? out : null;
}

/** The words only, for searching (paragraphs separated by a blank line). */
function plainText(paras) {
    return paras.map(p => p.runs.map(r => r.text).join('')).join('\n\n');
}

/** { title, doc?, text? } → formatted paragraphs. */
function contentOf({ doc, text }) {
    return normalize(doc) || fromText(text);
}

const DOCX_ALIGN = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED };

async function buildDocx(input) {
    const paras = contentOf(input);
    const children = paras.map(p => {
        const runs = [];
        for (const r of p.runs) {
            r.text.split('\n').forEach((piece, k) => {
                runs.push(new TextRun({
                    text: piece, bold: r.b, italics: r.i, underline: r.u ? {} : undefined,
                    break: k ? 1 : 0, font: r.font || 'Times New Roman', size: p.size != null ? Math.round(p.size * 2) : 24,
                }));
            });
        }
        const copied = p.size != null;               // v97: the layout of the scan
        return new Paragraph({ children: runs.length ? runs : [new TextRun('')], alignment: DOCX_ALIGN[p.align],
                               // Like the editor: a paragraph is not split over two
                               // pages unless it is longer than a page.
                               keepLines: true,
                               pageBreakBefore: !!p.pb,
                               spacing: copied
                                   ? { before: Math.round(p.before * 20), after: 0, line: Math.round(p.line * 20), lineRule: LineRuleType.EXACT }
                                   : { after: AFTER, line: LINE, lineRule: LineRuleType.EXACT },
                               indent: copied && (p.indent || p.first)
                                   ? { left: Math.round(p.indent * 20), ...(p.first >= 0 ? { firstLine: Math.round(p.first * 20) } : { hanging: Math.round(-p.first * 20) }) }
                                   : undefined });
    });
    const mg = layout.cleanMargins(input.margins) || { top: 72, right: 72, bottom: 72, left: 72 };
    const paper = PAPERS[paperOf(input.paper)];
    const doc = new Document({
        creator: 'BOARDLINK', title: String(input.title || 'Document').slice(0, 200),
        sections: [{
            properties: { page: { size: { width: paper.twips[0], height: paper.twips[1] },
                                  margin: { top: Math.round(mg.top * 20), bottom: Math.round(mg.bottom * 20),
                                            left: Math.round(mg.left * 20), right: Math.round(mg.right * 20) } } },
            children: children.length ? children : [new Paragraph({ children: [new TextRun('')] })],
        }],
    });
    return Packer.toBuffer(doc);
}

/** The PDF: the Word file turned into a PDF by LibreOffice, or drawn directly. */
async function buildPdf(input) {
    if (process.env.OCR_PDF_ENGINE !== 'direct') {
        try {
            const pdf = await wordFileToPdf(await buildDocx(input));
            if (pdf) return pdf;
        } catch (err) {
            console.warn('[ocr] LibreOffice could not make the PDF, drawing it directly:', err.message);
        }
    }
    return drawPdf(input);
}

// LibreOffice ("soffice"), found once.
const SOFFICE = process.env.SOFFICE_BIN ? [process.env.SOFFICE_BIN]
    : process.platform === 'win32' ? ['soffice', 'C:\\Program Files\\LibreOffice\\program\\soffice.exe', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe']
    : process.platform === 'darwin' ? ['soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice']
    : ['soffice', 'libreoffice', '/usr/bin/soffice'];
let sofficeBin;          // undefined = not looked for yet, null = not installed
function run(cmd, args, timeout) {
    return new Promise(resolve => execFile(cmd, args, { timeout, windowsHide: true },
        (err, stdout, stderr) => resolve({ ok: !err, missing: !!(err && err.code === 'ENOENT'), stderr: String(stderr || '') })));
}
async function findSoffice() {
    if (sofficeBin !== undefined) return sofficeBin;
    sofficeBin = null;
    for (const c of SOFFICE) { const r = await run(c, ['--version'], 30000); if (r.ok) { sofficeBin = c; break; } }
    return sofficeBin;
}
async function wordFileToPdf(docxBuf) {
    const bin = await findSoffice();
    if (!bin) return null;
    const dir = path.join(os.tmpdir(), `boardlink-ocr-${crypto.randomBytes(8).toString('hex')}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
        const src = path.join(dir, 'document.docx');
        fs.writeFileSync(src, docxBuf);
        const profile = pathToFileURL(path.join(dir, 'lo-profile')).href;
        const r = await run(bin, ['--headless', '--norestore', '--invisible', `-env:UserInstallation=${profile}`,
            '--convert-to', 'pdf:writer_pdf_Export', '--outdir', dir, src], 120000);
        const out = path.join(dir, 'document.pdf');
        if (fs.existsSync(out) && fs.statSync(out).size > 0) return fs.readFileSync(out);
        throw new Error(r.stderr.slice(0, 200) || 'no PDF was made');
    } finally {
        fs.rm(dir, { recursive: true, force: true }, () => {});
    }
}

function drawPdf(input) {
    const paras = contentOf(input);
    const paper = PAPERS[paperOf(input.paper)];
    return new Promise((resolve, reject) => {
        const mg = layout.cleanMargins(input.margins) || { top: 72, right: 72, bottom: 72, left: 72 };
        const doc = new PDFDocument({ size: paper.pt, margins: mg,
            info: { Title: String(input.title || 'Document').slice(0, 200), Creator: 'BOARDLINK' } });
        const parts = [];
        doc.on('data', d => parts.push(d));
        doc.on('end', () => resolve(Buffer.concat(parts)));
        doc.on('error', reject);
        // Times-like fonts with bold, italic and both (built-in ones if missing).
        const fonts = {
            R: ['LiberationSerif-Regular.ttf', 'Times-Roman'], B: ['LiberationSerif-Bold.ttf', 'Times-Bold'],
            I: ['LiberationSerif-Italic.ttf', 'Times-Italic'], BI: ['LiberationSerif-BoldItalic.ttf', 'Times-BoldItalic'],
            SR: ['LiberationSans-Regular.ttf', 'Helvetica'], SB: ['LiberationSans-Bold.ttf', 'Helvetica-Bold'],
            SI: ['LiberationSans-Italic.ttf', 'Helvetica-Oblique'], SBI: ['LiberationSans-BoldItalic.ttf', 'Helvetica-BoldOblique'],
        };
        const use = {};
        for (const [k, [file, builtIn]] of Object.entries(fonts)) {
            try { doc.registerFont(k, path.join(FONT_DIR, file)); doc.font(k); use[k] = k; }
            catch (_) { use[k] = builtIn; }
        }
        const fontFor = r => use[(r.font === 'Arial' ? 'S' : '') + (r.b && r.i ? 'BI' : r.b ? 'B' : r.i ? 'I' : 'R')]
            || (r.font === 'Courier New' ? 'Courier' : use.R);
        const width = doc.page.width - mg.left - mg.right;
        try {
            paras.forEach((p, n) => {
                if (p.pb && n > 0) doc.addPage();
                const copied = p.size != null, size = copied ? p.size : 12, lineH = copied ? p.line : 15;
                if (copied) doc.y += p.before;
                const runs = p.runs.length ? p.runs : [{ text: ' ', b: false, i: false, u: false }];
                runs.forEach((r, k) => {
                    doc.font(fontFor(r)).fontSize(size);
                    doc.text(r.text, mg.left + (copied ? p.indent : 0), undefined, {
                        width: width - (copied ? p.indent : 0), align: p.align, lineGap: lineH - doc.currentLineHeight(), underline: r.u,
                        indent: copied ? p.first : 0, continued: k < runs.length - 1,
                    });
                });
                if (!copied) doc.y += 10;    // 10 pt after each paragraph
            });
        } catch (err) { return reject(err); }
        doc.end();
    });
}

/** A safe file name from the title. */
function fileName(title, ext) {
    const base = String(title || 'document').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'document';
    return `${base}.${ext}`;
}

module.exports = { buildDocx, buildPdf, drawPdf, fileName, paragraphs, normalize, plainText, fromText, contentOf, PAPERS, paperOf };
