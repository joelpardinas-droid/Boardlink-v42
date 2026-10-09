// Module: Digital Archiving — approved documents attached INSIDE the
// resolution (to words the Board Secretary selected, or an area she
// marked), shown in a floating list (v93); year folders from 1985.
const path = require('path');
const { login } = require('./helpers');
const pool = require('../config/db');

const stamp = Date.now();
const PDF = path.join(__dirname, '..', 'samples', 'sample-previous-minutes.pdf');
let resId;
const made = [];
const data = html => JSON.parse(html.split('<script type="application/json" id="rsvData">')[1].split('</script>')[0]);

beforeAll(async () => {
    const [[r]] = await pool.query("SELECT document_id FROM documents WHERE category = '2026-22' LIMIT 1");
    resId = r.document_id;
});
afterAll(async () => {
    await pool.query('DELETE FROM document_attachments WHERE resolution_id = ?', [resId]).catch(() => {});
    if (made.length) {
        await pool.query('DELETE FROM document_ocr_text WHERE document_id IN (?)', [made]).catch(() => {});
        await pool.query('DELETE FROM documents WHERE document_id IN (?)', [made]).catch(() => {});
    }
    await pool.end();
});

describe('Attaching to words in the resolution', () => {
    test('the resolution page shows the resolution, the floating button and the attach window', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get(`/archive/${resId}`).set('X-Forwarded-For', ip);
        expect(res.text).toContain('id="rsv"');
        expect(res.text).toContain('data-can-attach="1"');
        expect(res.text).toContain('id="rsvFab"');
        expect(res.text).toContain('name="anchorRects"');
        expect(res.text).toContain('/js/resolution-view.js');
        // v95: only by selecting words — no Add, Pages, Agenda item or Mark an area buttons
        expect(res.text).toContain('id="apdFiles"');
        for (const gone of ['id="rsvAddAll"', 'id="apdPagesBtn"', 'id="apdAgendaBtn"', 'id="rsvArea"']) expect(res.text).not.toContain(gone);
    });
    test('a document attached to selected words keeps that place', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.post(`/archive/${resId}/attach-upload`).set('X-Forwarded-For', ip)
            .field('anchorPage', '1').field('anchorText', 'approval of the academic calendar')
            .field('anchorRects', JSON.stringify([[0.12, 0.3, 0.4, 0.02], [0.1, 0.33, 0.2, 0.02]]))
            .field('attTitle', `Academic Calendar AY 2026-2027 ${stamp}`).field('attType', 'Other')
            .attach('attFiles', PDF, 'Calendar.pdf');
        expect(res.headers.location).toContain('attach=uploaded');
        const [[a]] = await pool.query(
            `SELECT a.anchor_page, a.anchor_text, a.anchor_rects, d.document_id FROM document_attachments a
               JOIN documents d ON d.document_id = a.document_id WHERE a.resolution_id = ? AND d.title = ?`,
            [resId, `Academic Calendar AY 2026-2027 ${stamp}`]);
        made.push(a.document_id);
        expect(a.anchor_page).toBe(1);
        expect(a.anchor_text).toBe('approval of the academic calendar');
        expect(JSON.parse(a.anchor_rects)).toEqual([[0.12, 0.3, 0.4, 0.02], [0.1, 0.33, 0.2, 0.02]]);
        const page = await agent.get(`/archive/${resId}`).set('X-Forwarded-For', ip);
        const it = data(page.text).find(d => d.title === `Academic Calendar AY 2026-2027 ${stamp}`);
        expect(it.anchor).toEqual({ page: 1, text: 'approval of the academic calendar', rects: [[0.12, 0.3, 0.4, 0.02], [0.1, 0.33, 0.2, 0.02]] });
    }, 60000);
    test('a marked area (no words) is kept too; bad positions are ignored', async () => {
        const { agent, ip } = await login('secretary');
        await agent.post(`/archive/${resId}/attach-upload`).set('X-Forwarded-For', ip)
            .field('anchorPage', '1').field('anchorText', '').field('anchorRects', JSON.stringify([[0.1, 0.6, 0.5, 0.2]]))
            .field('attTitle', `Signed annex ${stamp}`).attach('attFiles', PDF, 'Annex.pdf');
        await agent.post(`/archive/${resId}/attach-upload`).set('X-Forwarded-For', ip)
            .field('anchorPage', '1').field('anchorRects', 'not json')
            .field('attTitle', `No place ${stamp}`).attach('attFiles', PDF, 'NoPlace.pdf');
        const [rows] = await pool.query(
            `SELECT d.document_id, d.title, a.anchor_page, a.anchor_text, a.anchor_rects FROM document_attachments a
               JOIN documents d ON d.document_id = a.document_id WHERE a.resolution_id = ? AND d.title IN (?, ?) ORDER BY d.document_id`,
            [resId, `Signed annex ${stamp}`, `No place ${stamp}`]);
        made.push(...rows.map(r => r.document_id));
        expect(rows[0].anchor_page).toBe(1);
        expect(rows[0].anchor_text).toBeNull();
        expect(rows[1].anchor_page).toBeNull();                 // attached to the whole resolution
    }, 60000);
    test('a Trustee sees the list but cannot attach', async () => {
        const t = await login('trustee');
        await t.agent.post(`/archive/${resId}/request`).set('X-Forwarded-For', t.ip).type('form').send({ reason: `Calendar ${stamp}` });
        const [[q]] = await pool.query(`SELECT request_id FROM document_access_requests WHERE document_id = ? AND status = 'pending' ORDER BY request_id DESC LIMIT 1`, [resId]);
        const s = await login('secretary');
        await s.agent.post(`/archive/doc-requests/${q.request_id}/approve`).set('X-Forwarded-For', s.ip).type('form').send({});
        const page = await t.agent.get(`/archive/${resId}`).set('X-Forwarded-For', t.ip);
        expect(page.text).toContain('data-can-attach="0"');
        expect(page.text).toContain('id="rsvFab"');
        expect(page.text).not.toContain('id="rsvDlg"');
        expect(data(page.text).every(d => d.unlink === null && d.open === true)).toBe(true);
        await pool.query('DELETE FROM document_access_requests WHERE request_id = ?', [q.request_id]);
    });
});

describe('Year folders', () => {
    test('there is a folder for every year from 1985 to this year, newest first', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get('/archive').set('X-Forwarded-For', ip);
        const years = [...res.text.matchAll(/class="gd-folder[^"]*" href="\/archive\?year=(\d{4})"/g)].map(m => Number(m[1]));
        const now = new Date().getFullYear();
        for (let y = 1985; y <= now; y++) expect(years).toContain(y);
        expect(years[0]).toBe(now);
        const empty = await agent.get('/archive?year=1986').set('X-Forwarded-For', ip);
        expect(empty.text).toContain('This folder is empty.');
    });
});
