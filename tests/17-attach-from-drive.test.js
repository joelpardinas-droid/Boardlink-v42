// Module: Digital Archiving — approved documents added from Google Drive (v89)
//
// Google Drive itself cannot be reached from a test, so a small pretend
// Drive answers instead. Run with TEST_FAKE_DRIVE_PORT set to the port the
// server's GOOGLE_API_BASE points to (e.g. GOOGLE_API_BASE=http://127.0.0.1:18999
// and TEST_FAKE_DRIVE_PORT=18999; Node refuses to fetch port 9), and GOOGLE_API_KEY set so the button shows.
// Without it, these tests are skipped.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { login } = require('./helpers');
const pool = require('../config/db');

const PORT = Number(process.env.TEST_FAKE_DRIVE_PORT || 0);
const run = PORT ? describe : describe.skip;
const PDF = fs.readFileSync(path.join(__dirname, '..', 'samples', 'sample-previous-minutes.pdf'));
const stamp = Date.now();
const FILES = {
    'driveFileAAAAAAAAAA1': { name: `Drive Policy ${stamp}.pdf`, mimeType: 'application/pdf' },
    'driveFileBBBBBBBBBB2': { name: `Drive Annex ${stamp}.pdf`, mimeType: 'application/pdf' },
};
let srv, resId;
const made = [];

beforeAll(async () => {
    const [[r]] = await pool.query("SELECT document_id FROM documents WHERE category = '2026-22' LIMIT 1");
    resId = r.document_id;
    if (!PORT) return;
    srv = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        const id = decodeURIComponent(u.pathname.split('/').pop());
        const f = FILES[id];
        if (req.headers.authorization !== 'Bearer good-token') { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"Invalid Credentials"}}'); }
        if (!f) { res.writeHead(404); return res.end('{}'); }
        if (u.searchParams.get('alt') === 'media') { res.writeHead(200, { 'Content-Type': 'application/pdf' }); return res.end(PDF); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, name: f.name, mimeType: f.mimeType, size: String(PDF.length) }));
    });
    await new Promise(ok => srv.listen(PORT, '127.0.0.1', ok));
});

afterAll(async () => {
    if (srv) srv.close();
    await pool.query('DELETE FROM document_attachments WHERE resolution_id = ?', [resId]).catch(() => {});
    if (made.length) {
        await pool.query('DELETE FROM document_ocr_text WHERE document_id IN (?)', [made]).catch(() => {});
        await pool.query('DELETE FROM documents WHERE document_id IN (?)', [made]).catch(() => {});
    }
    await pool.end();
});

run('Add approved documents from Google Drive', () => {
    test('the attach window on the resolution page has the "Google Drive" button', async () => {
        const { agent, ip } = await login('secretary');
        // v93: approved documents are attached inside the resolution itself.
        const page = await agent.get(`/archive/${resId}`).set('X-Forwarded-For', ip);
        expect(page.text).toContain('id="apdDriveBtn"');
        expect(page.text).toContain('MULTISELECT_ENABLED');
        const old = await agent.get(`/archive/upload?for=${resId}`).set('X-Forwarded-For', ip);
        expect(old.headers.location).toBe(`/archive/${resId}#attachments`);
    });
    test('a new resolution and its approved documents (computer + Google Drive) are saved together', async () => {
        const { agent, ip } = await login('secretary');
        const a = await agent.post('/archive/analyze').set('X-Forwarded-For', ip)
            .attach('file', path.join(__dirname, '..', 'samples', 'sample-previous-minutes.pdf'));
        const save = await agent.post('/archive/upload').set('X-Forwarded-For', ip)
            .field('docTitle', `Drive test resolution ${stamp}`).field('docType', 'Resolution').field('docYear', '2026')
            .field('docCategory', `2026-7${String(stamp).slice(-2)}`).field('governingBody', 'Board of Trustees')
            .field('uploadedFile', a.body.uploadedFile)
            .field('attTitle', `Upload Manual ${stamp}`).field('attType', 'Manual').field('attRef', 'M-1')
            .field('attTitle', `Upload Drive Policy ${stamp}`).field('attType', 'Policy').field('attRef', '')
            .field('accessToken', 'good-token').field('driveId', 'driveFileAAAAAAAAAA1')
            .attach('attFiles', path.join(__dirname, '..', 'samples', 'sample-previous-minutes.pdf'), 'Manual.pdf');
        expect(save.text).toContain('2 approved documents were attached to it.');
        const [[r]] = await pool.query('SELECT document_id FROM documents WHERE title = ?', [`Drive test resolution ${stamp}`]);
        made.push(r.document_id);
        const [rows] = await pool.query(
            `SELECT d.document_id, d.title, d.doc_type, d.category FROM document_attachments x JOIN documents d ON d.document_id = x.document_id
              WHERE x.resolution_id = ? ORDER BY d.document_id`, [r.document_id]);
        made.push(...rows.map(x => x.document_id));
        expect(rows.map(x => [x.title, x.doc_type, x.category])).toEqual([
            [`Upload Manual ${stamp}`, 'Manual', 'M-1'], [`Upload Drive Policy ${stamp}`, 'Policy', null]]);
        await pool.query('DELETE FROM document_attachments WHERE resolution_id = ?', [r.document_id]);
    }, 120000);
    test('files from this computer and from Google Drive are attached together', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.post(`/archive/${resId}/attach-upload`).set('X-Forwarded-For', ip)
            .field('title', `Computer Memo ${stamp}`).field('docType', 'Memorandum')
            .field('title', `Drive Policy ${stamp}`).field('docType', 'Policy')
            .field('title', `Drive Annex ${stamp}`).field('docType', 'Other')
            .field('docYear', '2026').field('accessToken', 'good-token')
            .field('driveId', 'driveFileAAAAAAAAAA1').field('driveId', 'driveFileBBBBBBBBBB2')
            .attach('files', path.join(__dirname, '..', 'samples', 'sample-previous-minutes.pdf'), 'Memo.pdf');
        expect(res.headers.location).toContain('attach=uploaded');
        expect(res.headers.location).toContain('n=3');
        const [rows] = await pool.query(
            `SELECT d.document_id, d.title, d.doc_type, d.file_path FROM document_attachments a JOIN documents d ON d.document_id = a.document_id
              WHERE a.resolution_id = ? ORDER BY d.document_id`, [resId]);
        made.push(...rows.map(r => r.document_id));
        expect(rows.map(r => r.title)).toEqual([`Computer Memo ${stamp}`, `Drive Policy ${stamp}`, `Drive Annex ${stamp}`]);
        expect(rows.map(r => r.doc_type)).toEqual(['Memorandum', 'Policy', 'Other']);
        // The Drive files were really copied into BOARDLINK.
        const dl = await agent.get(`/archive/${rows[1].document_id}/file`).set('X-Forwarded-For', ip);
        expect(dl.statusCode).toBe(200);
        expect(dl.body.slice(0, 5).toString()).toBe('%PDF-');
    }, 60000);
    test('Drive files alone are enough (no computer file needed)', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.post(`/archive/${resId}/attach-upload`).set('X-Forwarded-For', ip).type('form')
            .send({ title: '', docType: 'Policy', docYear: '2026', accessToken: 'good-token', driveId: 'driveFileAAAAAAAAAA1' });
        expect(res.headers.location).toContain('attach=uploaded');
        const [[d]] = await pool.query(
            `SELECT d.document_id, d.title FROM document_attachments a JOIN documents d ON d.document_id = a.document_id
              WHERE a.resolution_id = ? ORDER BY d.document_id DESC LIMIT 1`, [resId]);
        made.push(d.document_id);
        expect(d.title).toBe(`Drive Policy ${stamp}`);                       // from the Drive file name
    }, 60000);
    test('an expired Google sign-in is explained, and nothing is attached', async () => {
        const { agent, ip } = await login('secretary');
        const [[before]] = await pool.query('SELECT COUNT(*) AS n FROM document_attachments WHERE resolution_id = ?', [resId]);
        const res = await agent.post(`/archive/${resId}/attach-upload`).set('X-Forwarded-For', ip).type('form')
            .send({ title: 'x', docYear: '2026', accessToken: 'old-token', driveId: 'driveFileAAAAAAAAAA1' });
        expect(decodeURIComponent(res.headers.location.replace(/\+/g, ' '))).toContain('Google sign-in has expired');
        const [[after]] = await pool.query('SELECT COUNT(*) AS n FROM document_attachments WHERE resolution_id = ?', [resId]);
        expect(after.n).toBe(before.n);
    });
    test('a Trustee cannot add files from Google Drive', async () => {
        const { agent, ip } = await login('trustee');
        const res = await agent.post(`/archive/${resId}/attach-upload`).set('X-Forwarded-For', ip).type('form')
            .send({ title: 'x', accessToken: 'good-token', driveId: 'driveFileAAAAAAAAAA1' });
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).not.toContain('attach=uploaded');
    });
});
