// Module: Digital Archiving — approved documents that are PAGES inside the
// resolution's own PDF, or AGENDA ITEMS of past meetings (v92).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { login } = require('./helpers');
const pool = require('../config/db');

const stamp = Date.now();
let pdfPath, resId, agendaItem, meetingId;
const made = [];

/** A 5-page resolution: the resolution (1–2), ANNEX A (3), a manual (4–5). */
function makeResolutionPdf(file) {
    const PDFKit = require('pdfkit');
    return new Promise(ok => {
        const doc = new PDFKit({ size: 'A4' });
        const out = fs.createWriteStream(file);
        doc.pipe(out);
        doc.fontSize(14).text(`Resolution No. 2026-6${String(stamp).slice(-2)}`).moveDown()
            .fontSize(11).text('RESOLVED, to approve the ICTU Operations Manual and its annex.');
        doc.addPage().text('Certified true and correct.');
        doc.addPage().fontSize(14).text('ANNEX A').fontSize(11).text('Schedule of fees for the computer laboratories.');
        doc.addPage().fontSize(14).text('ICTU OPERATIONS MANUAL').fontSize(11).text('Chapter 1. Help desk.');
        doc.addPage().text('Chapter 2. Network accounts.');
        doc.end();
        out.on('finish', ok);
    });
}

beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'res-'));
    pdfPath = path.join(dir, 'resolution.pdf');
    await makeResolutionPdf(pdfPath);
    // A finished Board of Trustees meeting whose agenda item is in the archive.
    const { agent, ip } = await login('secretary');
    const [[sec]] = await pool.query(`SELECT user_id FROM users WHERE email = 'boardlink.secretary.demo@gmail.com'`);
    const res = await agent.post('/meeting/create').set('X-Forwarded-For', ip)
        .field('title', 'CSPC Regular Board of Trustees Meeting').field('meeting_type', 'Board of Trustees')
        .field('meeting_number', `TEST-PG-${stamp}`).field('meeting_date', '2026-06-20').field('meeting_time', '09:00')
        .field('venue', 'Board Room').field('mode', 'In-Person')
        .field('called_by_user_id', String(sec.user_id)).field('presided_by_user_id', String(sec.user_id))
        .field('quorum_required', '7')
        .field('item_title', `ICTU Operations Manual (for approval) ${stamp}`).field('item_category', 'For Approval').field('item_key', 'r1')
        .attach('item_pdf__r1', path.join(__dirname, '..', 'samples', 'sample-budget-proposal.pdf'), 'manual.pdf');
    meetingId = Number((/\/meeting\/(\d+)/.exec(res.headers.location) || [])[1]);
    await pool.query(`UPDATE meetings SET status = 'Completed' WHERE meeting_id = ?`, [meetingId]);
    await require('../services/agendaArchive').archiveMeeting(meetingId);
    const [[a]] = await pool.query(`SELECT item_id, meeting_id, item_title FROM agenda_archive WHERE meeting_id = ?`, [meetingId]);
    agendaItem = a;
}, 60000);

afterAll(async () => {
    if (resId) await pool.query('DELETE FROM document_access_requests WHERE document_id = ?', [resId]).catch(() => {});
    await pool.query(`DELETE FROM notifications WHERE kind LIKE 'doc_access%' AND message LIKE ?`, [`%${stamp}%`]).catch(() => {});
    if (made.length) {
        await pool.query('DELETE FROM document_attachments WHERE resolution_id IN (?) OR document_id IN (?)', [made, made]).catch(() => {});
        await pool.query('DELETE FROM document_ocr_text WHERE document_id IN (?)', [made]).catch(() => {});
        await pool.query('DELETE FROM documents WHERE document_id IN (?)', [made]).catch(() => {});
    }
    if (meetingId) await require('../models/Meeting').deleteMeeting(meetingId).catch(() => {});
    await pool.end();
});

describe('Pages inside the resolution', () => {
    let stored;
    test('BOARDLINK counts the pages and guesses where ANNEX A and the manual are', async () => {
        const { agent, ip } = await login('secretary');
        const a = await agent.post('/archive/analyze').set('X-Forwarded-For', ip).attach('file', pdfPath);
        stored = a.body.uploadedFile;
        const r = await agent.get('/archive/pages-info').query({ file: stored }).set('X-Forwarded-For', ip);
        expect(r.body.ok).toBe(true);
        expect(r.body.totalPages).toBe(5);
        expect(r.body.guesses).toEqual([
            { from: 3, to: 3, title: 'Annex A' },
            { from: 4, to: 5, title: 'ICTU Operations Manual' },
        ]);
    }, 60000);
    test('the resolution and the pages are saved together; the pages become their own PDFs', async () => {
        const { agent, ip } = await login('secretary');
        const save = await agent.post('/archive/upload').set('X-Forwarded-For', ip)
            .field('docTitle', `Approving the ICTU Operations Manual ${stamp}`).field('docType', 'Resolution').field('docYear', '2026')
            .field('docCategory', `2026-6${String(stamp).slice(-2)}`).field('governingBody', 'Board of Trustees')
            .field('uploadedFile', stored)
            .field('pageFrom', '3').field('pageTo', '3').field('pageTitle', `Annex A ${stamp}`).field('pageType', 'Other')
            .field('pageFrom', '4').field('pageTo', '5').field('pageTitle', `ICTU Operations Manual ${stamp}`).field('pageType', 'Manual')
            .field('agendaItemId', String(agendaItem.item_id));
        expect(save.text).toContain('3 approved documents were attached to it.');
        const [[r]] = await pool.query('SELECT document_id FROM documents WHERE title = ?', [`Approving the ICTU Operations Manual ${stamp}`]);
        resId = r.document_id; made.push(resId);
        const [rows] = await pool.query(
            `SELECT a.source, a.page_from, a.page_to, a.agenda_item_id, d.document_id, d.title, d.doc_type, d.file_path
               FROM document_attachments a LEFT JOIN documents d ON d.document_id = a.document_id
              WHERE a.resolution_id = ? ORDER BY a.attachment_id`, [resId]);
        made.push(...rows.filter(x => x.document_id).map(x => x.document_id));
        expect(rows.map(x => [x.source, x.page_from, x.page_to, x.title, x.doc_type])).toEqual([
            ['pages', 3, 3, `Annex A ${stamp}`, 'Other'],
            ['pages', 4, 5, `ICTU Operations Manual ${stamp}`, 'Manual'],
            ['agenda', null, null, null, null],
        ]);
        expect(rows[2].agenda_item_id).toBe(agendaItem.item_id);
        // The copied pages are a real 2-page PDF.
        const { PDFDocument } = require('pdf-lib');
        const file = require('../services/documentIndexer').resolveFile(rows[1].file_path);
        expect((await PDFDocument.load(fs.readFileSync(file))).getPageCount()).toBe(2);
    }, 60000);
    test('pages outside the PDF are refused', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.post(`/archive/${resId}/attach-upload`).set('X-Forwarded-For', ip).type('form')
            .send({ pageFrom: '4', pageTo: '9', pageTitle: 'Too far' });
        expect(decodeURIComponent(res.headers.location.replace(/\+/g, ' '))).toContain('Choose pages between 1 and 5');
    });
});

describe('Showing them', () => {
    test('the resolution page lists the pages and the agenda item, each with View', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get(`/archive/${resId}`).set('X-Forwarded-For', ip);
        // v93: the floating list is built from this data.
        const data = JSON.parse(res.text.split('<script type="application/json" id="rsvData">')[1].split('</script>')[0]);
        expect(data.map(d => d.tag)).toEqual(expect.arrayContaining(['Page 3', 'Pages 4–5', 'Agenda item']));
        expect(data.find(d => d.kind === 'agenda').view).toBe(`/meeting/${agendaItem.meeting_id}/item/${agendaItem.item_id}/review`);
    });
    test('the year folder and search show them under the resolution', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get('/archive').query({ year: 2026, q: `ICTU Operations Manual ${stamp}` }).set('X-Forwarded-For', ip);
        expect(res.text).toContain(`Approved document: <strong>ICTU Operations Manual ${stamp}</strong>`);
        expect(res.text).toContain(`Agenda item: <strong>${agendaItem.item_title}</strong>`);
    });
    test('agenda search puts the best match first', async () => {
        const { agent, ip } = await login('secretary');
        const r = await agent.get('/archive/agenda-search').query({ hint: agendaItem.item_title }).set('X-Forwarded-For', ip);
        expect(r.body.items[0].itemId).toBe(agendaItem.item_id);
        expect(r.body.items[0].match).toBe(true);
    });
    test('a linked agenda item can be unlinked', async () => {
        const { agent, ip } = await login('secretary');
        const d = await agent.post(`/archive/${resId}/detach-agenda/${agendaItem.item_id}`).set('X-Forwarded-For', ip).type('form').send({});
        expect(d.headers.location).toContain('attach=removed');
        await agent.post(`/archive/${resId}/attach-upload`).set('X-Forwarded-For', ip).type('form').send({ agendaItemId: String(agendaItem.item_id) });
        const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM document_attachments WHERE resolution_id = ? AND agenda_item_id = ?', [resId, agendaItem.item_id]);
        expect(Number(n.n)).toBe(1);
    });
    test('a Trustee cannot use these tools', async () => {
        const { agent, ip } = await login('trustee');
        expect((await agent.get('/archive/agenda-search').set('X-Forwarded-For', ip)).statusCode).toBe(302);
        expect((await agent.get('/archive/pages-info').query({ doc: resId }).set('X-Forwarded-For', ip)).statusCode).toBe(302);
    });
});

describe('Members: one approval opens the resolution, its pages and its agenda item', () => {
    test('closed before approval, open after, closed again when the day ends', async () => {
        const t = await login('trustee');
        const review = `/meeting/${agendaItem.meeting_id}/item/${agendaItem.item_id}/review`;
        const [[pg]] = await pool.query(`SELECT document_id FROM document_attachments WHERE resolution_id = ? AND source = 'pages' ORDER BY attachment_id DESC LIMIT 1`, [resId]);
        // The member may already have their own approval for that agenda item from another test; clear it.
        const [[u]] = await pool.query("SELECT user_id FROM users WHERE email = 'boardlink.trustee1.demo@gmail.com'");
        await pool.query('UPDATE agenda_access_requests SET expires_at = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE item_id = ? AND user_id = ? AND status = ?', [agendaItem.item_id, u.user_id, 'approved']);
        expect((await t.agent.get(`/archive/${pg.document_id}/file`).set('X-Forwarded-For', t.ip)).statusCode).toBe(403);
        expect((await t.agent.get(review).set('X-Forwarded-For', t.ip)).statusCode).not.toBe(200);

        await t.agent.post(`/archive/${resId}/request`).set('X-Forwarded-For', t.ip).type('form').send({ reason: `Manual and annex ${stamp}` });
        const [[q]] = await pool.query(`SELECT request_id FROM document_access_requests WHERE document_id = ? AND status = 'pending' ORDER BY request_id DESC LIMIT 1`, [resId]);
        // The year folder shows the request as waiting (a resolution with a linked
        // agenda item must not break the member's list).
        const folder = await t.agent.get('/archive?year=2026').set('X-Forwarded-For', t.ip);
        const row = folder.text.slice(folder.text.indexOf(`id="doc-${resId}"`), folder.text.indexOf('</tr>', folder.text.indexOf(`id="doc-${resId}"`)));
        expect(row).toContain('Waiting');
        const s = await login('secretary');
        await s.agent.post(`/archive/doc-requests/${q.request_id}/approve`).set('X-Forwarded-For', s.ip).type('form').send({});
        expect((await t.agent.get(`/archive/${pg.document_id}/file`).set('X-Forwarded-For', t.ip)).statusCode).toBe(200);
        expect((await t.agent.get(review).set('X-Forwarded-For', t.ip)).statusCode).toBe(200);

        await pool.query('UPDATE document_access_requests SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE request_id = ?', [q.request_id]);
        expect((await t.agent.get(`/archive/${pg.document_id}/file`).set('X-Forwarded-For', t.ip)).statusCode).toBe(403);
        expect((await t.agent.get(review).set('X-Forwarded-For', t.ip)).statusCode).not.toBe(200);
    }, 60000);
});
