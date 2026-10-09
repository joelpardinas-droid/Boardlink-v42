// Module: Digital Archiving — year folders and approved documents (v87)
//   • Board Resolutions are kept in a folder for each year.
//   • The approved document (e.g. a manual) is attached to its resolution
//     and shown on both pages and in search.
//   • A member whose request for the resolution was approved may open
//     the attached document for the same day.
const path = require('path');
const { login } = require('./helpers');
const pool = require('../config/db');

const stamp = Date.now();
const WORD = `Zqictu${stamp}`;                         // a word only in this test's titles
const PDF = path.join(__dirname, '..', 'samples', 'sample-previous-minutes.pdf');
let resId, manualId, policyId, newResId;
const made = [];

beforeAll(async () => {
    const [[r]] = await pool.query("SELECT document_id FROM documents WHERE category = '2026-21' LIMIT 1");
    resId = r.document_id;
    const [p] = await pool.query(
        `INSERT INTO documents (title, doc_type, doc_year, category, uploaded_at) VALUES (?, 'Policy', 2026, NULL, NOW())`,
        [`${WORD} Data Privacy Policy`]);
    policyId = p.insertId; made.push(policyId);
});

afterAll(async () => {
    const [[r22]] = await pool.query("SELECT document_id FROM documents WHERE category = '2026-22' LIMIT 1");
    await pool.query('DELETE FROM document_access_requests WHERE document_id IN (?)', [[resId, r22.document_id, ...made]]).catch(() => {});
    await pool.query('DELETE FROM document_attachments WHERE resolution_id = ?', [r22.document_id]).catch(() => {});
    await pool.query(`DELETE FROM notifications WHERE kind LIKE 'doc_access%' AND message LIKE ?`, [`%${WORD}%`]).catch(() => {});
    await pool.query('DELETE FROM document_attachments WHERE resolution_id IN (?) OR document_id IN (?)', [[resId, ...made], [resId, ...made]]).catch(() => {});
    await pool.query('DELETE FROM document_ocr_text WHERE document_id IN (?)', [made]).catch(() => {});
    await pool.query('DELETE FROM documents WHERE document_id IN (?)', [made]).catch(() => {});
    await pool.end();
});

describe('Year folders', () => {
    test('the archive opens on a folder for each year of Board Resolutions', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get('/archive').set('X-Forwarded-For', ip);
        expect(res.text).toMatch(/class="gd-folder" href="\/archive\?year=2026"/);
        // v93: a folder for every year from 1985, even an empty one.
        expect(res.text).toMatch(/class="gd-folder is-empty" href="\/archive\?year=1985"/);
        const [[n]] = await pool.query("SELECT COUNT(*) AS n FROM documents WHERE doc_type = 'Resolution' AND doc_year = 2026");
        expect(res.text).toContain(`${n.n} resolution${n.n === 1 ? '' : 's'}`);
        // v91: only the year folders; manuals and policies are found by search
        // or under the resolution that approved them.
        expect(res.text).not.toContain('Manuals, Policies &amp; Memoranda');
        const byType = await agent.get('/archive/documents?type=Policy').set('X-Forwarded-For', ip);
        expect(byType.text).toContain(`${WORD} Data Privacy Policy`);
    });
    test('a year folder holds only that year\'s resolutions, by number', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get('/archive?year=2026').set('X-Forwarded-For', ip);
        expect(res.text).toContain('2026-21');
        expect(res.text).toContain('2026-22');
        expect(res.text.indexOf('>2026-21<')).toBeLessThan(res.text.indexOf('>2026-22<'));
        expect(res.text).not.toContain(`${WORD} Data Privacy Policy`);
        expect(res.text).not.toContain('1999-07');
    });
    test('the Board of Councils button leaves out the Board of Trustees resolutions', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get('/archive?year=2026&body=councils').set('X-Forwarded-For', ip);
        expect(res.text).not.toContain('>2026-21<');
    });
    test('Trustees and council members see the folders too (titles only)', async () => {
        const { agent, ip } = await login('trustee');
        const res = await agent.get('/archive?year=2026').set('X-Forwarded-For', ip);
        expect(res.text).toContain('2026-21');
        expect(res.text).toContain(`action="/archive/${resId}/request"`);
    });
});

describe('Attaching the approved document to its resolution', () => {
    test('the Board Secretary uploads the approved manual on the resolution page', async () => {
        const { agent, ip } = await login('secretary');
        const page = await agent.get(`/archive/${resId}`).set('X-Forwarded-For', ip);
        expect(page.text).toContain('id="rsvFab"');
        expect(page.text).toContain('id="rsvDlg"');
        const res = await agent.post(`/archive/${resId}/attach-upload`).set('X-Forwarded-For', ip)
            .field('title', `${WORD} ICTU Operations Manual`).field('docType', 'Manual').field('docYear', '2026')
            .attach('file', PDF);
        expect(res.headers.location).toContain('attach=uploaded');
        const [[m]] = await pool.query('SELECT document_id, doc_type, governing_body FROM documents WHERE title = ?', [`${WORD} ICTU Operations Manual`]);
        manualId = m.document_id; made.push(manualId);
        expect(m.doc_type).toBe('Manual');
        expect(m.governing_body).toBe('Board of Trustees');
    }, 60000);
    test('the resolution page shows the approved document with View and Download', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get(`/archive/${resId}`).set('X-Forwarded-For', ip);
        expect(res.text).toContain(`${WORD} ICTU Operations Manual`);
        expect(res.text).toContain(`"download":"/archive/${manualId}/file?download=1"`);
    });
    test('the manual page shows the resolution that approved it', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get(`/archive/${manualId}`).set('X-Forwarded-For', ip);
        expect(res.text).toContain('Approved by');
        expect(res.text).toContain('Resolution No. 2026-21');
        expect((await agent.get(`/archive/${manualId}/file`).set('X-Forwarded-For', ip)).statusCode).toBe(200);
    });
    test('a document already in the archive can be attached, and unlinked', async () => {
        const { agent, ip } = await login('secretary');
        const a = await agent.post(`/archive/${resId}/attach`).set('X-Forwarded-For', ip).type('form').send({ documentId: policyId });
        expect(a.headers.location).toContain('attach=attached');
        expect((await agent.get(`/archive/${policyId}`).set('X-Forwarded-For', ip)).text).toContain('Resolution No. 2026-21');
        const d = await agent.post(`/archive/${policyId}/detach/${resId}`).set('X-Forwarded-For', ip).type('form').send({});
        expect(d.headers.location).toContain('attach=removed');
        const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM document_attachments WHERE resolution_id = ? AND document_id = ?', [resId, policyId]);
        expect(Number(n.n)).toBe(0);
    });
    test('a resolution cannot be attached to another resolution', async () => {
        const { agent, ip } = await login('secretary');
        const [[other]] = await pool.query("SELECT document_id FROM documents WHERE category = '2026-22' LIMIT 1");
        const a = await agent.post(`/archive/${resId}/attach`).set('X-Forwarded-For', ip).type('form').send({ documentId: other.document_id });
        expect(decodeURIComponent(a.headers.location.replace(/\+/g, ' '))).toContain('not another resolution');
    });
    test('a Trustee cannot attach anything', async () => {
        const { agent, ip } = await login('trustee');
        await agent.post(`/archive/${resId}/attach`).set('X-Forwarded-For', ip).type('form').send({ documentId: policyId });
        const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM document_attachments WHERE document_id = ?', [policyId]);
        expect(Number(n.n)).toBe(0);
    });
    test('the upload form links a new resolution to its approved document', async () => {
        const { agent, ip } = await login('secretary');
        // v93: the attach window is on the resolution's page.
        const form = await agent.get(`/archive/${resId}`).set('X-Forwarded-For', ip);
        expect(form.text).toContain('name="approvedDocId"');
        expect(form.text).toContain(`${WORD} Data Privacy Policy`);
        const a = await agent.post('/archive/analyze').set('X-Forwarded-For', ip).attach('file', PDF);
        const save = await agent.post('/archive/upload').set('X-Forwarded-For', ip)
            .field('docTitle', `${WORD} Approving the Data Privacy Policy`).field('docType', 'Resolution').field('docYear', '2026')
            .field('docCategory', `2026-9${String(stamp).slice(-2)}`).field('governingBody', 'Board of Trustees')
            .field('uploadedFile', a.body.uploadedFile).field('approvedDocId', String(policyId));
        expect(save.text).toContain('1 approved document was attached to it.');
        const [[r]] = await pool.query('SELECT document_id FROM documents WHERE title = ?', [`${WORD} Approving the Data Privacy Policy`]);
        newResId = r.document_id; made.push(newResId);
        const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM document_attachments WHERE resolution_id = ? AND document_id = ?', [newResId, policyId]);
        expect(Number(n.n)).toBe(1);
    }, 120000);
});

describe('Several approved documents at once (v88)', () => {
    let resA, ids = [];
    test('several files are uploaded and attached in one go, each with its own title', async () => {
        const { agent, ip } = await login('secretary');
        const [[r]] = await pool.query("SELECT document_id FROM documents WHERE category = '2026-22' LIMIT 1");
        resA = r.document_id;
        const res = await agent.post(`/archive/${resA}/attach-upload`).set('X-Forwarded-For', ip)
            .field('title', `${WORD} Academic Calendar Annex A`).field('docType', 'Other')
            .field('title', `${WORD} Enrollment Policy`).field('docType', 'Policy')
            .field('title', '').field('docType', 'Memorandum')
            .field('docYear', '2026')
            .attach('files', PDF, 'Annex_A.pdf').attach('files', PDF, 'Enrollment_Policy.pdf').attach('files', PDF, 'Memo_No_12_Class_Schedule.pdf');
        expect(res.headers.location).toContain('attach=uploaded');
        expect(res.headers.location).toContain('n=3');
        const [rows] = await pool.query(
            `SELECT d.document_id, d.title, d.doc_type FROM document_attachments a JOIN documents d ON d.document_id = a.document_id
              WHERE a.resolution_id = ? ORDER BY d.document_id`, [resA]);
        ids = rows.map(x => x.document_id); made.push(...ids);
        expect(rows.map(x => x.title)).toEqual([`${WORD} Academic Calendar Annex A`, `${WORD} Enrollment Policy`, 'Memo No 12 Class Schedule']);
        expect(rows.map(x => x.doc_type)).toEqual(['Other', 'Policy', 'Memorandum']);
        const page = await agent.get(`/archive/${resA}?attach=uploaded&n=3`).set('X-Forwarded-For', ip);
        expect(page.text).toContain('3 documents were uploaded and attached.');
        for (const id of ids) expect(page.text).toContain(`"download":"/archive/${id}/file?download=1"`);
    }, 60000);
    test('several documents already in the archive are attached by ticking them', async () => {
        const { agent, ip } = await login('secretary');
        await pool.query('DELETE FROM document_attachments WHERE resolution_id = ?', [resA]);
        // v91: the tick list is on the Upload Document page, opened from the resolution.
        const page = await agent.get(`/archive/${resA}`).set('X-Forwarded-For', ip);
        expect(page.text).toContain('type="checkbox" name="approvedDocId"');
        expect(page.text).toContain('action="/archive/' + resA + '/attach-upload"');
        const res = await agent.post(`/archive/${resA}/attach`).set('X-Forwarded-For', ip).type('form')
            .send(`documentId=${ids[0]}&documentId=${ids[1]}&documentId=${ids[2]}`);
        expect(res.headers.location).toContain('n=3');
        const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM document_attachments WHERE resolution_id = ?', [resA]);
        expect(Number(n.n)).toBe(3);
    });
    test('the year folder lists every approved document under the resolution', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get('/archive?year=2026').set('X-Forwarded-For', ip);
        expect(res.text).toContain(`Approved document: <strong>${WORD} Enrollment Policy</strong>`);
        expect(res.text).toContain(`Approved document: <strong>${WORD} Academic Calendar Annex A</strong>`);
    });
    test('the upload form can tick several approved documents for a new resolution', async () => {
        const { agent, ip } = await login('secretary');
        const a = await agent.post('/archive/analyze').set('X-Forwarded-For', ip).attach('file', PDF);
        const save = await agent.post('/archive/upload').set('X-Forwarded-For', ip)
            .field('docTitle', `${WORD} Approving three documents`).field('docType', 'Resolution').field('docYear', '2026')
            .field('docCategory', `2026-8${String(stamp).slice(-2)}`).field('governingBody', 'Board of Trustees')
            .field('uploadedFile', a.body.uploadedFile)
            .field('approvedDocId', String(ids[0])).field('approvedDocId', String(ids[1])).field('approvedDocId', String(ids[2]));
        expect(save.text).toContain('3 approved documents were attached to it.');
        const [[r]] = await pool.query('SELECT document_id FROM documents WHERE title = ?', [`${WORD} Approving three documents`]);
        made.push(r.document_id);
        const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM document_attachments WHERE resolution_id = ?', [r.document_id]);
        expect(Number(n.n)).toBe(3);
    }, 120000);
    test('a member approved for the resolution may open all its approved documents', async () => {
        const t = await login('trustee');
        await t.agent.post(`/archive/${resA}/request`).set('X-Forwarded-For', t.ip).type('form').send({ reason: `Annexes ${WORD}` });
        const [[q]] = await pool.query(`SELECT request_id FROM document_access_requests WHERE document_id = ? AND status = 'pending' ORDER BY request_id DESC LIMIT 1`, [resA]);
        const s = await login('secretary');
        await s.agent.post(`/archive/doc-requests/${q.request_id}/approve`).set('X-Forwarded-For', s.ip).type('form').send({});
        const [[msg]] = await pool.query(`SELECT message FROM notifications WHERE kind = 'doc_access_approved' ORDER BY notification_id DESC LIMIT 1`);
        expect(msg.message).toContain('approved documents');
        for (const id of ids) expect((await t.agent.get(`/archive/${id}/file`).set('X-Forwarded-For', t.ip)).statusCode).toBe(200);
        await pool.query('DELETE FROM document_access_requests WHERE request_id = ?', [q.request_id]);
    });
});

describe('Search shows the attached file', () => {
    test('searching the manual shows the resolution that approved it', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get('/archive/documents').query({ q: `${WORD} ICTU` }).set('X-Forwarded-For', ip);
        expect(res.text).toContain(`${WORD} ICTU Operations Manual`);
        expect(res.text).toMatch(/Approved by <strong>Resolution No\. 2026-21<\/strong>/);
    });
    test('the resolution\'s row shows its approved document with a View link', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get('/archive?year=2026').set('X-Forwarded-For', ip);
        expect(res.text).toContain(`Approved document: <strong>${WORD} ICTU Operations Manual</strong>`);
        expect(res.text).toContain(`href="/archive/${manualId}" class="att-link"`);
    });
});

describe('Members: one approval opens the resolution and its approved document', () => {
    test('before approval the manual is closed', async () => {
        const { agent, ip } = await login('trustee');
        expect((await agent.get(`/archive/${manualId}/file`).set('X-Forwarded-For', ip)).statusCode).toBe(403);
    });
    test('after the Secretary approves the resolution, the manual opens for the same day', async () => {
        const t = await login('trustee');
        await t.agent.post(`/archive/${resId}/request`).set('X-Forwarded-For', t.ip).type('form').send({ reason: `Checking the ICTU manual ${WORD}` });
        const [[q]] = await pool.query(`SELECT request_id FROM document_access_requests WHERE document_id = ? AND status = 'pending' ORDER BY request_id DESC LIMIT 1`, [resId]);
        const s = await login('secretary');
        await s.agent.post(`/archive/doc-requests/${q.request_id}/approve`).set('X-Forwarded-For', s.ip).type('form').send({});
        const [[n]] = await pool.query(`SELECT message FROM notifications WHERE kind = 'doc_access_approved' ORDER BY notification_id DESC LIMIT 1`);
        expect(n.message).toContain(`${WORD} ICTU Operations Manual`);
        expect((await t.agent.get(`/archive/${manualId}/file?download=1`).set('X-Forwarded-For', t.ip)).statusCode).toBe(200);
        const page = await t.agent.get(`/archive/${resId}`).set('X-Forwarded-For', t.ip);
        expect(page.text).toContain(`"view":"/archive/${manualId}"`);
        // Another member is still closed out.
        const a = await login('academic');
        expect((await a.agent.get(`/archive/${manualId}/file`).set('X-Forwarded-For', a.ip)).statusCode).toBe(403);
        // When the day ends, the manual closes with the resolution.
        await pool.query('UPDATE document_access_requests SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE request_id = ?', [q.request_id]);
        expect((await t.agent.get(`/archive/${manualId}/file`).set('X-Forwarded-For', t.ip)).statusCode).toBe(403);
    });
});
