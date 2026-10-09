// ============================================================
// services/compileService.js — the Secretary's compiled comments
// ============================================================
//
// Gathers every comment posted on a meeting's agenda items into one
// document, ordered the way a reader works through the papers:
//
//   Agenda item  →  page  →  highlighted words / marked area
//                →  each member's comment on that spot
//
// followed, per item, by comments that do not point at a spot.
//
// Two formats are produced from the same grouping:
//   • Word (.docx) — the office keeps editing it in Word or Docs
//   • PDF          — a fixed copy for filing or printing

const path = require('path');
const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow,
    TableCell, WidthType, BorderStyle, ShadingType, AlignmentType, Footer,
    Header, PageNumber, TabStopType,
} = require('docx');
const PDFDocument = require('pdfkit');
const { roleLabel } = require('../config/roles');

// ── Grouping ─────────────────────────────────────────────────

function parseRects(raw) {
    if (!raw) return null;
    try {
        const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(v) && v.length ? v : null;
    } catch (_) { return null; }
}

function normQuote(q) {
    return String(q || '').replace(/\s+/g, ' ').trim();
}

/**
 * Builds the structure both writers use:
 * [{ item, spots: [{ page, kind, quote, top, left, comments }], general: [comments], total }]
 */
function groupComments(items, comments) {
    const byItem = new Map(items.map(it => [String(it.item_id), []]));
    for (const c of comments) {
        const list = byItem.get(String(c.item_id));
        if (list) list.push(c);
    }

    return items.map(item => {
        const list = byItem.get(String(item.item_id)) || [];
        const spots = new Map();
        const general = [];

        for (const c of list) {
            const rects = parseRects(c.anchor_rects);
            if (c.anchor_type && c.page_number && rects) {
                const quote = c.anchor_type === 'text' ? normQuote(c.anchor_quote) : '';
                // Comments on the same words of the same page are shown
                // together; each marked area stands on its own unless
                // two members marked exactly the same box.
                const key = c.anchor_type === 'text'
                    ? `t|${c.page_number}|${quote.toLowerCase()}`
                    : `a|${c.page_number}|${JSON.stringify(rects)}`;
                if (!spots.has(key)) {
                    spots.set(key, {
                        page: c.page_number,
                        kind: c.anchor_type,
                        quote,
                        top:  Math.min(...rects.map(r => r[1])),
                        left: Math.min(...rects.map(r => r[0])),
                        comments: [],
                    });
                }
                spots.get(key).comments.push(c);
            } else {
                general.push(c);
            }
        }

        const byTime = (a, b) => new Date(a.commented_at) - new Date(b.commented_at);
        const ordered = [...spots.values()]
            .sort((a, b) => a.page - b.page || a.top - b.top || a.left - b.left);
        ordered.forEach(s => s.comments.sort(byTime));
        general.sort((a, b) =>
            // Comments on a video item, in the order of the video.
            (a.video_time == null ? 1e9 : Number(a.video_time)) - (b.video_time == null ? 1e9 : Number(b.video_time)) ||
            (a.page_number || 0) - (b.page_number || 0) ||
            (a.line_number || 0) - (b.line_number || 0) || byTime(a, b));

        return { item, spots: ordered, general, total: list.length };
    });
}

// ── Shared text helpers ──────────────────────────────────────

const TIME_ZONE = process.env.APP_TIMEZONE || 'Asia/Manila';

function fmtDate(d, withTime = false) {
    if (!d) return '';
    const dt = new Date(d);
    if (isNaN(dt)) return String(d);
    // Shown in Philippine time regardless of the server's own zone.
    const opts = { year: 'numeric', month: 'long', day: 'numeric', timeZone: TIME_ZONE };
    if (withTime) Object.assign(opts, { hour: 'numeric', minute: '2-digit' });
    return dt.toLocaleString('en-US', opts);
}

function spotHeading(s) {
    return s.kind === 'text' ? `Page ${s.page}` : `Page ${s.page}, marked area`;
}

function commentMeta(c) {
    const parts = [
        roleLabel(c),
        c.comment_phase || 'Pre-Meeting',
        fmtDate(c.commented_at, true),
    ];
    if (c.edited_at) parts.push('edited');
    if (c.status === 'Addressed') parts.push('done');
    // The document was reworded after this comment was made, so its
    // place in the document is not certain. Said plainly in the
    // compiled file too, not only on screen.
    if (c.anchor_stale) parts.push('position to check — the document was reworded');
    return parts.join(', ');
}

function generalLocation(c) {
    if (c.video_time != null) {
        const t = Math.floor(Number(c.video_time) || 0);
        const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, x = t % 60;
        return `At ${h ? h + ':' + String(m).padStart(2, '0') : m}:${String(x).padStart(2, '0')} in the video`;
    }
    if (c.page_number && c.line_number) return `Page ${c.page_number}, line ${c.line_number}`;
    if (c.page_number) return `Page ${c.page_number}`;
    // Its words were changed when the document was reworded. The words
    // it was made about are kept so the point can still be followed.
    if (c.anchor_lost) {
        const quote = normQuote(c.anchor_quote);
        return quote
            ? `Was on “${quote}”, which is no longer in the document`
            : 'The part this was about is no longer in the document';
    }
    return '';
}

function safeName(meeting) {
    return String((meeting && (meeting.meeting_number || meeting.meeting_id)) || 'meeting')
        .replace(/[^A-Za-z0-9_-]+/g, '_');
}

// ── Word (.docx) ─────────────────────────────────────────────

const FONT = 'Arial';
const INK = '1F2937';
const MUTED = '6B7280';
const NAVY = '1A3D80';
// US Letter with 1" margins: 12240 − 2×1440 = 9360 DXA of text width.
const TEXT_W = 9360;
const cellBorder = { style: BorderStyle.SINGLE, size: 4, color: 'D1D5DB' };
const cellBorders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder };

function cell(text, width, { bold = false, fill = null, align = AlignmentType.LEFT } = {}) {
    return new TableCell({
        borders: cellBorders,
        width: { size: width, type: WidthType.DXA },
        shading: fill ? { fill, type: ShadingType.CLEAR, color: 'auto' } : undefined,
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
        children: [new Paragraph({
            alignment: align,
            children: [new TextRun({ text: String(text), bold, font: FONT, size: 20 })],
        })],
    });
}

function detailsTable(rows) {
    const w1 = 2400, w2 = TEXT_W - w1;
    return new Table({
        width: { size: TEXT_W, type: WidthType.DXA },
        columnWidths: [w1, w2],
        rows: rows.map(([k, v]) => new TableRow({
            children: [cell(k, w1, { bold: true, fill: 'F3F4F6' }), cell(v || '—', w2)],
        })),
    });
}

function summaryTable(groups) {
    const w1 = 900, w3 = 1500, w2 = TEXT_W - w1 - w3;
    const head = new TableRow({
        tableHeader: true,
        children: [
            cell('Item', w1, { bold: true, fill: 'E5EAF3' }),
            cell('Agenda item', w2, { bold: true, fill: 'E5EAF3' }),
            cell('Comments', w3, { bold: true, fill: 'E5EAF3', align: AlignmentType.RIGHT }),
        ],
    });
    const body = groups.map(g => new TableRow({
        children: [
            cell(g.item.item_order, w1),
            cell(g.item.item_title, w2),
            cell(g.total, w3, { align: AlignmentType.RIGHT }),
        ],
    }));
    return new Table({
        width: { size: TEXT_W, type: WidthType.DXA },
        columnWidths: [w1, w2, w3],
        rows: [head, ...body],
    });
}

function p(text, opts = {}) {
    return new Paragraph({
        spacing: { after: opts.after ?? 80, before: opts.before ?? 0 },
        indent: opts.indent ? { left: opts.indent } : undefined,
        keepNext: opts.keepNext,
        children: [new TextRun({
            text: String(text), font: FONT, size: opts.size || 22,
            bold: opts.bold, italics: opts.italics, color: opts.color || INK,
        })],
    });
}

function quoteBlock(text) {
    return new Paragraph({
        spacing: { after: 100 },
        indent: { left: 240 },
        keepNext: true,
        shading: { fill: 'FFF8E6', type: ShadingType.CLEAR, color: 'auto' },
        border: { left: { style: BorderStyle.SINGLE, size: 18, color: 'D97706', space: 8 } },
        children: [new TextRun({ text: `“${text}”`, font: FONT, size: 21, italics: true, color: INK })],
    });
}

function commentBlock(c, indent) {
    return [
        new Paragraph({
            spacing: { before: 60, after: 20 },
            indent: { left: indent },
            keepNext: true,
            children: [
                new TextRun({ text: c.full_name || 'Member', bold: true, font: FONT, size: 21, color: INK }),
                new TextRun({ text: `   ${commentMeta(c)}`, font: FONT, size: 18, color: MUTED }),
            ],
        }),
        ...String(c.comment_text || '').split(/\r?\n/).map(line =>
            p(line, { indent, after: 40 })),
    ];
}

async function buildDocx({ meeting, groups, compiledBy }) {
    const m = meeting || {};
    const total = groups.reduce((n, g) => n + g.total, 0);
    const children = [
        new Paragraph({
            heading: HeadingLevel.TITLE,
            spacing: { after: 60 },
            children: [new TextRun({ text: 'Compiled Comments', font: FONT, size: 40, bold: true, color: NAVY })],
        }),
        p(m.title || 'Meeting', { size: 26, after: 240, color: INK }),
        detailsTable([
            ['Governing body', m.meeting_type],
            ['Meeting number', m.meeting_number],
            ['Date', fmtDate(m.meeting_date)],
            ['Venue', m.venue],
            ['Compiled by', compiledBy],
            ['Compiled on', fmtDate(new Date(), true)],
            ['Total comments', String(total)],
        ]),
        p('', { after: 120 }),
        new Paragraph({
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 200, after: 120 },
            children: [new TextRun({ text: 'Summary', font: FONT, size: 28, bold: true, color: NAVY })],
        }),
        summaryTable(groups),
    ];

    for (const g of groups) {
        const it = g.item;
        children.push(new Paragraph({
            heading: HeadingLevel.HEADING_1,
            pageBreakBefore: true,
            spacing: { after: 80 },
            children: [new TextRun({ text: `Item ${it.item_order}. ${it.item_title}`, font: FONT, size: 28, bold: true, color: NAVY })],
        }));
        const facts = [`Category: ${it.item_category || '—'}`];
        if (it.item_video_name) facts.push(`Video: ${it.item_video_name}`);
        else if (it.item_pdf_name) facts.push(`Document: ${it.item_pdf_name}`);
        children.push(p(facts.join('      '), { size: 19, color: MUTED, after: 200 }));

        if (!g.total) {
            children.push(p('No comments were posted on this item.', { italics: true, color: MUTED }));
            continue;
        }

        for (const s of g.spots) {
            children.push(new Paragraph({
                heading: HeadingLevel.HEADING_2,
                spacing: { before: 200, after: 60 },
                keepNext: true,
                children: [new TextRun({ text: spotHeading(s), font: FONT, size: 23, bold: true, color: INK })],
            }));
            if (s.kind === 'text' && s.quote) children.push(quoteBlock(s.quote));
            for (const c of s.comments) children.push(...commentBlock(c, 240));
        }

        if (g.general.length) {
            children.push(new Paragraph({
                heading: HeadingLevel.HEADING_2,
                spacing: { before: 240, after: 60 },
                keepNext: true,
                children: [new TextRun({ text: 'Comments on the item as a whole', font: FONT, size: 23, bold: true, color: INK })],
            }));
            for (const c of g.general) {
                const loc = generalLocation(c);
                if (loc) children.push(p(loc, { size: 19, color: MUTED, indent: 240, after: 0, keepNext: true }));
                children.push(...commentBlock(c, 240));
            }
        }
    }

    const doc = new Document({
        creator: 'BOARDLINK',
        title: `Compiled comments — ${m.meeting_number || m.title || ''}`,
        styles: {
            default: { document: { run: { font: FONT, size: 22 } } },
            paragraphStyles: [
                { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
                  run: { size: 28, bold: true, font: FONT, color: NAVY },
                  paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 0 } },
                { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
                  run: { size: 23, bold: true, font: FONT },
                  paragraph: { spacing: { before: 180, after: 60 }, outlineLevel: 1 } },
            ],
        },
        sections: [{
            properties: {
                page: {
                    size: { width: 12240, height: 15840 },
                    margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
                },
            },
            headers: {
                default: new Header({ children: [new Paragraph({
                    tabStops: [{ type: TabStopType.RIGHT, position: TEXT_W }],
                    children: [
                        new TextRun({ text: 'CSPC Office of the Board Secretary', font: FONT, size: 16, color: MUTED }),
                        new TextRun({ text: `\t${m.meeting_number || ''}`, font: FONT, size: 16, color: MUTED }),
                    ],
                })] }),
            },
            footers: {
                default: new Footer({ children: [new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [
                        new TextRun({ text: 'Page ', font: FONT, size: 16, color: MUTED }),
                        new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 16, color: MUTED }),
                        new TextRun({ text: ' of ', font: FONT, size: 16, color: MUTED }),
                        new TextRun({ children: [PageNumber.TOTAL_PAGES], font: FONT, size: 16, color: MUTED }),
                    ],
                })] }),
            },
            children,
        }],
    });
    return Packer.toBuffer(doc);
}

// ── PDF ──────────────────────────────────────────────────────

const FONT_DIR = path.join(__dirname, '..', 'fonts');

function buildPdf({ meeting, groups, compiledBy }) {
    return new Promise((resolve, reject) => {
        const m = meeting || {};
        const doc = new PDFDocument({
            size: 'LETTER',
            margins: { top: 72, bottom: 72, left: 72, right: 72 },
            bufferPages: true,
            info: { Title: `Compiled comments — ${m.meeting_number || ''}`, Creator: 'BOARDLINK' },
        });
        doc.registerFont('R', path.join(FONT_DIR, 'LiberationSans-Regular.ttf'));
        doc.registerFont('B', path.join(FONT_DIR, 'LiberationSans-Bold.ttf'));
        doc.registerFont('I', path.join(FONT_DIR, 'LiberationSans-Italic.ttf'));

        const chunks = [];
        doc.on('data', d => chunks.push(d));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const W = doc.page.width - 144;
        const ensure = h => { if (doc.y + h > doc.page.height - 72) doc.addPage(); };
        const total = groups.reduce((n, g) => n + g.total, 0);

        doc.font('B').fontSize(22).fillColor('#1A3D80').text('Compiled Comments');
        doc.moveDown(0.2);
        doc.font('R').fontSize(13).fillColor('#1F2937').text(m.title || 'Meeting');
        doc.moveDown(0.8);
        const facts = [
            ['Governing body', m.meeting_type], ['Meeting number', m.meeting_number],
            ['Date', fmtDate(m.meeting_date)], ['Venue', m.venue],
            ['Compiled by', compiledBy], ['Compiled on', fmtDate(new Date(), true)],
            ['Total comments', String(total)],
        ];
        for (const [k, v] of facts) {
            const y = doc.y;
            doc.font('B').fontSize(10).fillColor('#374151').text(k, 72, y, { width: 130 });
            doc.font('R').fillColor('#1F2937').text(v || '—', 210, y, { width: W - 138 });
            doc.moveDown(0.25);
        }
        doc.moveDown(0.8);
        doc.font('B').fontSize(14).fillColor('#1A3D80').text('Summary', 72);
        doc.moveDown(0.3);
        for (const g of groups) {
            ensure(16);
            const y = doc.y;
            doc.font('R').fontSize(10).fillColor('#1F2937')
               .text(`${g.item.item_order}.`, 72, y, { width: 30 })
               .text(g.item.item_title, 104, y, { width: W - 110 });
            const after = doc.y;
            doc.text(String(g.total), 72, y, { width: W, align: 'right' });
            doc.y = Math.max(after, doc.y);
            doc.moveDown(0.15);
        }

        for (const g of groups) {
            const it = g.item;
            doc.addPage();
            doc.font('B').fontSize(15).fillColor('#1A3D80').text(`Item ${it.item_order}. ${it.item_title}`, 72);
            const meta = [`Category: ${it.item_category || '—'}`];
            if (it.item_video_name) meta.push(`Video: ${it.item_video_name}`);
            else if (it.item_pdf_name) meta.push(`Document: ${it.item_pdf_name}`);
            doc.font('R').fontSize(9.5).fillColor('#6B7280').text(meta.join('      '));
            doc.moveDown(0.8);

            if (!g.total) {
                doc.font('I').fontSize(10.5).fillColor('#6B7280').text('No comments were posted on this item.');
                continue;
            }

            const writeComment = c => {
                ensure(40);
                doc.font('B').fontSize(10.5).fillColor('#1F2937').text(c.full_name || 'Member', 88, doc.y, { continued: true });
                doc.font('R').fontSize(9).fillColor('#6B7280').text(`   ${commentMeta(c)}`);
                doc.moveDown(0.1);
                doc.font('R').fontSize(10.5).fillColor('#1F2937').text(String(c.comment_text || ''), 88, doc.y, { width: W - 16 });
                doc.moveDown(0.5);
            };

            for (const s of g.spots) {
                ensure(60);
                doc.font('B').fontSize(11.5).fillColor('#1F2937').text(spotHeading(s), 72);
                doc.moveDown(0.2);
                if (s.kind === 'text' && s.quote) {
                    const top = doc.y;
                    doc.font('I').fontSize(10.5).fillColor('#1F2937')
                       .text(`“${s.quote}”`, 92, top + 4, { width: W - 28 });
                    const bottom = doc.y + 4;
                    doc.save().rect(80, top, 3, bottom - top).fill('#D97706').restore();
                    doc.y = bottom;
                    doc.moveDown(0.4);
                }
                s.comments.forEach(writeComment);
                doc.moveDown(0.3);
            }
            if (g.general.length) {
                ensure(40);
                doc.font('B').fontSize(11.5).fillColor('#1F2937').text('Comments on the item as a whole', 72);
                doc.moveDown(0.3);
                for (const c of g.general) {
                    const loc = generalLocation(c);
                    if (loc) doc.font('R').fontSize(9).fillColor('#6B7280').text(loc, 88);
                    writeComment(c);
                }
            }
        }

        // Header and page numbers on every page.
        const range = doc.bufferedPageRange();
        for (let i = 0; i < range.count; i++) {
            doc.switchToPage(range.start + i);
            const bottom = doc.page.margins.bottom;
            doc.page.margins.bottom = 0;
            doc.font('R').fontSize(8).fillColor('#6B7280')
               .text('CSPC Office of the Board Secretary', 72, 40, { width: W, lineBreak: false })
               .text(m.meeting_number || '', 72, 40, { width: W, align: 'right', lineBreak: false })
               .text(`Page ${i + 1} of ${range.count}`, 72, doc.page.height - 45, { width: W, align: 'center', lineBreak: false });
            doc.page.margins.bottom = bottom;
        }
        doc.end();
    });
}

module.exports = { groupComments, buildDocx, buildPdf, safeName, parseRects };
