// Module: Digital Archiving
const { login } = require('./helpers');
const Document = require('../models/Document');
const pool = require('../config/db');
afterAll(() => pool.end());

describe('Document model', () => {
    test('findAll returns the archived resolutions', async () => {
        // The seed holds two resolutions: 2026-21 and 2026-22.
        const rows = await Document.findAll();
        expect(rows.length).toBeGreaterThanOrEqual(2);
        expect(rows.map(r => r.category)).toEqual(expect.arrayContaining(['2026-21', '2026-22']));
    });
    test('findById returns one resolution with its metadata', async () => {
        const doc = await Document.findById(2);
        expect(doc.title).toContain('Academic Calendar');
        expect(doc.category).toBe('2026-22');
        expect(Number(doc.doc_year)).toBe(2026);
    });
    test('findById returns nothing for an id that does not exist', async () => {
        const doc = await Document.findById(999999);
        expect(doc == null).toBe(true);
    });
});

describe('Archive routes', () => {
    test('the Board Secretary can list the archive', async () => {
        const { agent, ip } = await login('secretary');
        // v87: the archive opens on year folders; 2026 holds both.
        const res = await agent.get('/archive?year=2026').set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain('2026-21');
        expect(res.text).toContain('2026-22');
    });
    test('the Board Secretary can open the upload page', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get('/archive/upload').set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(200);
    });
    test('a Trustee cannot open the upload page', async () => {
        const { agent, ip } = await login('trustee');
        const res = await agent.get('/archive/upload').set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(302);
    });
    test('a single archived document opens by id', async () => {
        const { agent, ip } = await login('secretary');
        // The archive now holds two real-format resolutions (seed_data.sql /
        // scripts/reset-archive.js) instead of the ten old samples.
        const [[doc]] = await pool.query("SELECT document_id FROM documents WHERE category = '2026-21' LIMIT 1");
        const res = await agent.get(`/archive/${doc.document_id}`).set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain('Administrative Budget');
    });
});

describe('Upload Resolution form', () => {
    test('Save to Archive stores the record sent by the upload form (multipart)', async () => {
        const path = require('path');
        const { agent, ip } = await login('secretary');
        const pdf = path.join(__dirname, '..', 'samples', 'sample-previous-minutes.pdf');
        const a = await agent.post('/archive/analyze').set('X-Forwarded-For', ip).attach('file', pdf);
        expect(a.statusCode).toBe(200);
        const stored = a.body.uploadedFile;
        const [[{ c: before }]] = await pool.query('SELECT COUNT(*) c FROM documents');
        const title = `Unit Test Upload ${Date.now()}`;
        const res = await agent.post('/archive/upload').set('X-Forwarded-For', ip)
            .field('docTitle', title).field('docType', 'Resolution').field('docYear', '2026')
            .field('docCategory', 'UT-2026-01').field('uploadedFile', stored);
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain('was archived');
        expect(res.text).not.toContain('Please fill in all required fields');
        const [[{ c: after }]] = await pool.query('SELECT COUNT(*) c FROM documents');
        expect(after).toBe(before + 1);
        const [[row]] = await pool.query('SELECT document_id, file_path FROM documents WHERE title = ?', [title]);
        expect(row.file_path).toBe(stored);
        const dl = await agent.get(`/archive/${row.document_id}/file`).set('X-Forwarded-For', ip);
        expect(dl.statusCode).toBe(200);
        await pool.query('DELETE FROM document_ocr_text WHERE document_id = ?', [row.document_id]).catch(() => {});
    }, 120000);
    test('an unknown document id shows the not-found page', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get('/archive/999999').set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(404);
    });
});

// ── Finished PDFs typed on a computer: manuals and resolutions ──
describe('Uploading a finished PDF (e.g. a MICT manual) and searching inside it', () => {
    const os = require('os'), fs = require('fs'), path = require('path');
    const { spawnSync } = require('child_process');
    const pool = require('../config/db');
    let pdf, docId;
    const word = 'Zorblax' + Date.now().toString(36);   // a word found nowhere else

    beforeAll(async () => {
        // A 2-page typed PDF, made with LibreOffice from plain text.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-'));
        const txt = path.join(dir, 'manual.txt');
        fs.writeFileSync(txt, 'MICT OPERATIONS MANUAL 2026\n\nManagement Information and Communications Technology Office\n\n' +
            'This manual covers the computer laboratories used by the BSIT program.\n'.repeat(3) +
            '\f\nChapter 2. Network accounts\n\nStudents request accounts through the ' + word + ' help desk.\n');
        const r = spawnSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', dir, txt], { timeout: 120000 });
        pdf = path.join(dir, 'manual.pdf');
        if (r.status !== 0 || !fs.existsSync(pdf)) throw new Error('LibreOffice is needed for this test');
    }, 150000);

    afterAll(async () => {
        if (docId) {
            await pool.query('DELETE FROM document_ocr_text WHERE document_id = ?', [docId]);
            await pool.query('DELETE FROM documents WHERE document_id = ?', [docId]);
        }
    });

    test('the Upload Documents form offers Manual as a type of document', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get('/archive/documents/upload').set('X-Forwarded-For', ip);
        expect(res.text).toMatch(/<option value="Manual">Manual<\/option>/);
    });

    test('a manual is saved without a resolution number, and its words become searchable', async () => {
        const { agent, ip } = await login('secretary');
        const a = await agent.post('/archive/analyze').set('X-Forwarded-For', ip).attach('file', pdf, 'MICT Manual.pdf');
        expect(a.body.ok).toBe(true);
        const save = await agent.post('/archive/upload').set('X-Forwarded-For', ip)
            .field('docType', 'Manual').field('docTitle', 'MICT Operations Manual').field('docYear', '2026')
            .field('docCategory', '').field('uploadedFile', a.body.uploadedFile);
        expect(save.text).toContain('was archived');
        const [[d]] = await pool.query(`SELECT document_id, doc_type, category FROM documents WHERE title = 'MICT Operations Manual' ORDER BY document_id DESC LIMIT 1`);
        docId = d.document_id;
        expect(d.doc_type).toBe('Manual');
        // Wait for the words to be read (typed PDF: read directly, no OCR).
        let text = '';
        for (let k = 0; k < 60 && !text; k++) {
            const [[o]] = await pool.query('SELECT ocr_text FROM document_ocr_text WHERE document_id = ?', [docId]);
            text = o ? o.ocr_text : '';
            if (!text) await new Promise(r => setTimeout(r, 1000));
        }
        expect(text).toContain('BSIT program');
        expect(text).toContain(word);                     // page 2 too
        expect(text).toContain('Information and Communications Technology');
    }, 90000);

    test('a Trustee sees only titles: a word from inside the manual finds nothing, and no words are shown', async () => {
        const { agent, ip } = await login('trustee');
        const res = await agent.get('/archive/documents').query({ q: word }).set('X-Forwarded-For', ip);
        expect(res.text).not.toContain('MICT Operations Manual');
        expect(res.text).not.toContain('help desk');
        const byTitle = await agent.get('/archive/documents').query({ q: 'MICT Operations' }).set('X-Forwarded-For', ip);
        expect(byTitle.text).toContain('MICT Operations Manual');
        expect(byTitle.text).toContain(`/archive/${docId}/request`);
        expect(byTitle.text).not.toContain(`href="/archive/${docId}"`);
    });

    test('searching a word from page 2 finds the manual, with the words around it', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get('/archive/documents').query({ q: word }).set('X-Forwarded-For', ip);
        expect(res.text).toContain('MICT Operations Manual');
        expect(res.text).toContain('help desk');
        expect(res.text).toContain(`/archive/${docId}"`);
    });

    test('the Manuals filter keeps only manuals', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get('/archive').query({ q: 'BSIT' }).set('X-Forwarded-For', ip);
        expect(res.text).not.toContain('MICT Operations Manual');            // Board Resolutions only
        const res2 = await agent.get('/archive/documents').query({ q: 'BSIT', type: 'Manual' }).set('X-Forwarded-For', ip);
        expect(res2.text).toContain('MICT Operations Manual');
        const res3 = await agent.get('/archive/documents').query({ q: 'BSIT', type: 'Policy' }).set('X-Forwarded-For', ip);
        expect(res3.text).not.toContain('MICT Operations Manual');
    });

    test('v96: Board Resolutions and Documents are separate; the board/council buttons are in Documents', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get('/archive').set('X-Forwarded-For', ip);
        expect(res.text).toContain('href="/archive/documents"');
        expect(res.text).toContain('class="gd-grid"');
        expect(res.text).not.toContain('class="body-tabs"');
        expect(res.text).not.toContain('MICT Operations Manual');
        expect(res.text).toContain('Upload Resolution');
        const docs = await agent.get('/archive/documents').set('X-Forwarded-For', ip);
        expect(docs.text).toContain('class="body-tabs"');
        expect(docs.text).toContain('Administrative Council');
        expect(docs.text).toContain('MICT Operations Manual');
        expect(docs.text).not.toContain('class="gd-grid"');
        expect(docs.text).not.toMatch(/<td[^>]*>\s*Resolution No\./);
        const old = await agent.get('/archive?type=Manual').set('X-Forwarded-For', ip);
        expect(old.headers.location).toBe('/archive/documents?type=Manual');
        const one = await agent.get(`/archive?doc=${docId}`).set('X-Forwarded-For', ip);
        expect(one.headers.location).toBe(`/archive/documents?doc=${docId}`);
    });

    test('v96: two upload forms, each asking only for what it needs', async () => {
        const { agent, ip } = await login('secretary');
        const r = await agent.get('/archive/upload').set('X-Forwarded-For', ip);
        expect(r.text).toContain('<title>Upload Resolution | BOARDLINK</title>');
        expect(r.text).toContain('name="kind" value="resolution"');
        expect(r.text).toContain('Resolution No. *');
        expect(r.text).toContain('name="docType" value="Resolution"');
        expect(r.text).not.toContain('id="f-type"');
        expect(r.text).not.toContain('name="approvedById"');
        expect(r.text).not.toContain('name="docDesc"');
        const d = await agent.get('/archive/documents/upload').set('X-Forwarded-For', ip);
        expect(d.text).toContain('<title>Upload Documents | BOARDLINK</title>');
        expect(d.text).toContain('name="kind" value="document"');
        expect(d.text).toMatch(/<select id="f-type" name="docType" required>/);
        expect(d.text).not.toContain('<option value="Resolution"');
        expect(d.text).toContain('Reference No.');
        expect(d.text).toContain('name="approvedById"');
        expect(d.text).not.toContain('Resolution No. *');
        expect(d.text).not.toContain('name="docDesc"');
        const docs = await agent.get('/archive/documents').set('X-Forwarded-For', ip);
        expect(docs.text).toContain('href="/archive/documents/upload" class="btn btn-gold"');
        const t = await login('trustee');
        expect((await t.agent.get('/archive/documents/upload').set('X-Forwarded-For', t.ip)).statusCode).not.toBe(200);
    });

    test('v96: the Documents form cannot save a Board Resolution', async () => {
        const { agent, ip } = await login('secretary');
        const title = 'Zq v96 form check ' + Date.now();
        await agent.post('/archive/upload').set('X-Forwarded-For', ip).type('form')
            .send({ kind: 'document', docType: 'Resolution', docTitle: title, docYear: '2026', governingBody: 'Academic Council' });
        const [[row]] = await pool.query('SELECT document_id, doc_type FROM documents WHERE title = ?', [title]);
        expect(row.doc_type).toBe('Manual');
        await pool.query('DELETE FROM documents WHERE document_id = ?', [row.document_id]);
    });
});
