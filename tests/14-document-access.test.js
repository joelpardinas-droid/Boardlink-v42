// Module: Digital Archiving — permission to open a Board Resolution (v85)
// Trustees and council members see only the titles. They ask the Board
// Secretary, who opens one document to them for one day (24 hours).
const { login } = require('./helpers');
const pool = require('../config/db');

let docId, requestId;
const started = new Date();
afterAll(async () => {
    await pool.query('DELETE FROM document_access_requests WHERE created_at >= ?', [new Date(started - 1000)]).catch(() => {});
    await pool.query(`DELETE FROM notifications WHERE kind LIKE 'doc_access%' AND created_at >= ?`, [new Date(started - 1000)]).catch(() => {});
    await pool.end();
});

beforeAll(async () => {
    const [[d]] = await pool.query("SELECT document_id FROM documents WHERE category = '2026-21' LIMIT 1");
    docId = d.document_id;
    const [[t]] = await pool.query("SELECT user_id FROM users WHERE email = 'boardlink.trustee1.demo@gmail.com'");
    const [[a]] = await pool.query("SELECT user_id FROM users WHERE email = 'boardlink.academic1.demo@gmail.com'");
    await pool.query('DELETE FROM document_access_requests WHERE user_id IN (?, ?)', [t.user_id, a.user_id]);
});

describe('A Trustee sees only the title', () => {
    test('the list shows the title and Request access, not a View button', async () => {
        const { agent, ip } = await login('trustee');
        const res = await agent.get('/archive?year=2026').set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain('Approving the FY 2027 Administrative Budget');
        expect(res.text).toContain(`action="/archive/${docId}/request"`);
        expect(res.text).not.toContain(`href="/archive/${docId}"`);
    });
    test('opening the document sends the Trustee back to the list', async () => {
        const { agent, ip } = await login('trustee');
        const res = await agent.get(`/archive/${docId}`).set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toContain(`/archive?doc=${docId}&request=locked`);
    });
    test('the file cannot be viewed or downloaded', async () => {
        const { agent, ip } = await login('trustee');
        expect((await agent.get(`/archive/${docId}/file`).set('X-Forwarded-For', ip)).statusCode).toBe(403);
        expect((await agent.get(`/archive/${docId}/file?download=1`).set('X-Forwarded-For', ip)).statusCode).toBe(403);
    });
    test('the Board Secretary still opens it without asking', async () => {
        const { agent, ip } = await login('secretary');
        expect((await agent.get(`/archive/${docId}`).set('X-Forwarded-For', ip)).statusCode).toBe(200);
        expect((await agent.get(`/archive/${docId}/file`).set('X-Forwarded-For', ip)).statusCode).toBe(200);
    });
});

describe('Asking the Board Secretary', () => {
    test('a request needs a reason', async () => {
        const { agent, ip } = await login('trustee');
        const res = await agent.post(`/archive/${docId}/request`).set('X-Forwarded-For', ip).type('form').send({ reason: '' });
        expect(decodeURIComponent(res.headers.location)).toContain('Write why');
    });
    test('the request is saved and the Board Secretary is notified', async () => {
        const { agent, ip } = await login('trustee');
        const res = await agent.post(`/archive/${docId}/request`).set('X-Forwarded-For', ip)
            .type('form').send({ reason: 'To compare with the FY 2028 budget proposal.' });
        expect(res.headers.location).toContain('request=sent');
        const [[q]] = await pool.query('SELECT * FROM document_access_requests WHERE document_id = ? ORDER BY request_id DESC LIMIT 1', [docId]);
        expect(q.status).toBe('pending');
        requestId = q.request_id;
        const [[n]] = await pool.query(
            `SELECT n.link FROM notifications n JOIN users u ON u.user_id = n.user_id
              WHERE n.kind = 'doc_access_request' AND u.role = 'secretary' ORDER BY n.notification_id DESC LIMIT 1`);
        expect(n.link).toBe(`/archive/requests#doc-request-${requestId}`);
        const again = await agent.post(`/archive/${docId}/request`).set('X-Forwarded-For', ip)
            .type('form').send({ reason: 'Asking a second time.' });
        expect(again.headers.location).toContain('request=pending');
        const page = await agent.get('/archive?year=2026').set('X-Forwarded-For', ip);
        expect(page.text).toContain('Waiting');
    });
    test('the request appears in Access Requests with Approve (1 day)', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get('/archive/requests').set('X-Forwarded-For', ip);
        expect(res.text).toContain(`id="doc-request-${requestId}"`);
        expect(res.text).toContain('Approve (1 day)');
    });
    test('a Trustee cannot approve a request', async () => {
        const { agent, ip } = await login('trustee');
        await agent.post(`/archive/doc-requests/${requestId}/approve`).set('X-Forwarded-For', ip).type('form').send({});
        const [[q]] = await pool.query('SELECT status FROM document_access_requests WHERE request_id = ?', [requestId]);
        expect(q.status).toBe('pending');
    });
});

describe('After approval: one day to view and download', () => {
    test('the Secretary approves for 24 hours and the Trustee is notified', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.post(`/archive/doc-requests/${requestId}/approve`).set('X-Forwarded-For', ip).type('form').send({ note: 'For the budget review only.' });
        expect(res.headers.location).toContain('done=approved');
        const [[q]] = await pool.query(
            'SELECT status, TIMESTAMPDIFF(MINUTE, decided_at, expires_at) AS mins FROM document_access_requests WHERE request_id = ?', [requestId]);
        expect(q.status).toBe('approved');
        expect(Number(q.mins)).toBe(24 * 60);
        const [[n]] = await pool.query(`SELECT message, link FROM notifications WHERE kind = 'doc_access_approved' ORDER BY notification_id DESC LIMIT 1`);
        expect(n.link).toBe(`/archive/${docId}`);
        expect(n.message).toContain('view and download it for 1 day');
    });
    test('the Trustee can now view and download it', async () => {
        const { agent, ip } = await login('trustee');
        const page = await agent.get(`/archive/${docId}`).set('X-Forwarded-For', ip);
        expect(page.statusCode).toBe(200);
        expect(page.text).toContain('Open until');
        expect((await agent.get(`/archive/${docId}/file?download=1`).set('X-Forwarded-For', ip)).statusCode).toBe(200);
        const list = await agent.get('/archive?year=2026').set('X-Forwarded-For', ip);
        expect(list.text).toContain(`href="/archive/${docId}"`);
    });
    test('another member is still closed out', async () => {
        const { agent, ip } = await login('academic');
        expect((await agent.get(`/archive/${docId}/file`).set('X-Forwarded-For', ip)).statusCode).toBe(403);
    });
    test('after the day ends, the document is closed again', async () => {
        await pool.query('UPDATE document_access_requests SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE request_id = ?', [requestId]);
        const { agent, ip } = await login('trustee');
        expect((await agent.get(`/archive/${docId}`).set('X-Forwarded-For', ip)).statusCode).toBe(302);
        expect((await agent.get(`/archive/${docId}/file`).set('X-Forwarded-For', ip)).statusCode).toBe(403);
        const list = await agent.get('/archive?year=2026').set('X-Forwarded-For', ip);
        expect(list.text).toContain('Ask again');
    });
});

describe('Declining', () => {
    test('a declined request keeps the document closed and tells the member', async () => {
        const a = await login('academic');
        await a.agent.post(`/archive/${docId}/request`).set('X-Forwarded-For', a.ip).type('form').send({ reason: 'For the council report.' });
        const [[q]] = await pool.query(`SELECT request_id FROM document_access_requests WHERE document_id = ? AND status = 'pending' ORDER BY request_id DESC LIMIT 1`, [docId]);
        const s = await login('secretary');
        const res = await s.agent.post(`/archive/doc-requests/${q.request_id}/decline`).set('X-Forwarded-For', s.ip).type('form').send({ note: 'Not yet released.' });
        expect(res.headers.location).toContain('done=declined');
        const [[n]] = await pool.query(`SELECT message FROM notifications WHERE kind = 'doc_access_declined' ORDER BY notification_id DESC LIMIT 1`);
        expect(n.message).toContain('Not yet released.');
        expect((await a.agent.get(`/archive/${docId}/file`).set('X-Forwarded-For', a.ip)).statusCode).toBe(403);
        // A request already answered cannot be answered again.
        const twice = await s.agent.post(`/archive/doc-requests/${q.request_id}/approve`).set('X-Forwarded-For', s.ip).type('form').send({});
        expect(twice.headers.location).toContain('done=gone');
    });
});
