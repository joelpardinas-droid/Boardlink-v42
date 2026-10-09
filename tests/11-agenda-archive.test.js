// Module: Digital Archive — after the meeting, its agendas are saved to the
// archive ("Meeting Agendas"), closed to members; a member asks the Office
// of the Board Secretary for permission to view a particular item.
const path = require('path');
const { login } = require('./helpers');
const pool = require('../config/db');
const Meeting = require('../models/Meeting');

let meetingId, itemId, requestId;
const number = `TEST-ARC-${Date.now()}`;
const review = () => `/meeting/${meetingId}/item/${itemId}/review`;

beforeAll(async () => {
    const { agent, ip } = await login('secretary');
    const [[sec]] = await pool.query(`SELECT user_id FROM users WHERE email = 'boardlink.secretary.demo@gmail.com'`);
    const res = await agent.post('/meeting/create').set('X-Forwarded-For', ip)
        .field('title', 'CSPC Regular Board of Trustees Meeting').field('meeting_type', 'Board of Trustees')
        .field('meeting_number', number).field('meeting_date', '2026-06-20').field('meeting_time', '09:00')
        .field('venue', 'Board Room').field('mode', 'In-Person')
        .field('called_by_user_id', String(sec.user_id)).field('presided_by_user_id', String(sec.user_id))
        .field('quorum_required', '7')
        .field('item_title', 'FY 2027 Budget of the BSIT Program').field('item_category', 'For Approval').field('item_key', 'r1')
        .attach('item_pdf__r1', path.join(__dirname, '..', 'samples', 'sample-budget-proposal.pdf'), 'budget.pdf');
    meetingId = Number((/\/meeting\/(\d+)/.exec(res.headers.location) || [])[1]);
    const [[it]] = await pool.query(`SELECT item_id FROM meeting_agenda_items WHERE meeting_id = ?`, [meetingId]);
    itemId = it.item_id;
});

afterAll(async () => {
    if (meetingId) await Meeting.deleteMeeting(meetingId).catch(() => {});
    await pool.end().catch(() => {});
});

describe('Before the meeting ends', () => {
    test('a Trustee can open the agenda item as usual', async () => {
        const { agent, ip } = await login('trustee');
        const res = await agent.get(review()).set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(200);
    });
});

describe('End Meeting saves the agendas to the Digital Archive', () => {
    test('the Secretary ends the meeting and its items are archived', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.post(`/meeting/${meetingId}/end`).set('X-Forwarded-For', ip);
        expect(res.headers.location).toContain('archived=1');
        const [[a]] = await pool.query(`SELECT * FROM agenda_archive WHERE item_id = ?`, [itemId]);
        expect(a.meeting_title).toBe('CSPC Regular Board of Trustees Meeting');
        expect(a.meeting_number).toBe(number);
        expect(a.file_kind).toBe('pdf');
    });

    test('Meeting Agendas is its own section, labelled by meeting', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get('/archive/agendas').set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain('href="/archive/documents"');
        expect(res.text).toContain('Meeting Agendas');
        expect(res.text).toContain('CSPC Regular Board of Trustees Meeting');
        expect(res.text).toContain(`No. ${number}`);
        expect(res.text).toContain('FY 2027 Budget of the BSIT Program');
    });

    test('each meeting is a dropdown, closed until opened', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get('/archive/agendas').set('X-Forwarded-For', ip);
        expect(res.text).toMatch(new RegExp(`class="ag-toggle" aria-expanded="false" aria-controls="agItems${meetingId}"`));
        expect(res.text).toMatch(new RegExp(`id="agItems${meetingId}"\\s+hidden`));
        expect(res.text).toContain('Show all agendas');
        // Coming to one of its items opens that meeting.
        const focus = await agent.get(`/archive/agendas?item=${itemId}`).set('X-Forwarded-For', ip);
        expect(focus.text).toMatch(new RegExp(`aria-expanded="true" aria-controls="agItems${meetingId}"`));
    });

    test('the Secretary can always open an archived item', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get(review()).set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(200);
    });

    test('a completed meeting cannot be deleted (its agendas are archived)', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.post(`/meeting/${meetingId}/delete`).set('X-Forwarded-For', ip)
            .type('form').send({ confirm_number: number });
        expect(res.statusCode).toBe(409);
        const [[m]] = await pool.query(`SELECT meeting_id FROM meetings WHERE meeting_id = ?`, [meetingId]);
        expect(m).toBeTruthy();
    });
});

describe('Members need the Office\'s approval', () => {
    test('a Trustee is turned away from the closed item, and its file', async () => {
        const { agent, ip } = await login('trustee');
        const res = await agent.get(review()).set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toContain(`/archive/agendas?item=${itemId}`);
        const file = await agent.get(`/meeting/${meetingId}/item/${itemId}/file`).set('X-Forwarded-For', ip);
        expect(file.statusCode).not.toBe(200);
    });

    test('the meeting page shows the item as closed, with no briefing', async () => {
        const { agent, ip } = await login('trustee');
        const res = await agent.get(`/meeting/${meetingId}`).set('X-Forwarded-For', ip);
        expect(res.text).toContain('Closed · Request access');
        expect(res.text).not.toContain('id="briefing"');
    });

    test('a Trustee cannot summarise a completed meeting', async () => {
        const { agent, ip } = await login('trustee');
        const res = await agent.post(`/meeting/${meetingId}/briefing`).set('X-Forwarded-For', ip)
            .set('Accept', 'application/json').send({ mode: 'all' });
        expect(res.statusCode).toBe(403);
    });

    test('a member searching does not see words from inside closed papers', async () => {
        const { agent, ip } = await login('trustee');
        const res = await agent.get('/archive/agendas').query({ q: 'BSIT' }).set('X-Forwarded-For', ip);
        expect(res.text).toContain('FY 2027 Budget of the BSIT Program');      // the title matches
        expect(res.text).not.toContain('class="ag-snippet"');
    });

    test('a request needs a reason', async () => {
        const { agent, ip } = await login('trustee');
        const res = await agent.post(`/archive/agendas/${itemId}/request`).set('X-Forwarded-For', ip)
            .type('form').send({ reason: '' });
        expect(decodeURIComponent(res.headers.location)).toContain('Write why');
    });

    test('a Trustee asks for access; the Office is notified', async () => {
        const { agent, ip } = await login('trustee');
        const res = await agent.post(`/archive/agendas/${itemId}/request`).set('X-Forwarded-For', ip)
            .type('form').send({ reason: 'To compare with the FY 2028 budget proposal.' });
        expect(res.headers.location).toContain('request=sent');
        const [[q]] = await pool.query(`SELECT * FROM agenda_access_requests WHERE item_id = ? ORDER BY request_id DESC LIMIT 1`, [itemId]);
        requestId = q.request_id;
        expect(q.status).toBe('pending');
        const [[n]] = await pool.query(
            `SELECT n.message FROM notifications n JOIN users u ON u.user_id = n.user_id
              WHERE u.role = 'secretary' AND n.kind = 'access_request' AND n.item_id = ? ORDER BY n.notification_id DESC LIMIT 1`, [itemId]);
        expect(n.message).toContain('FY 2027 Budget of the BSIT Program');
        // Asking again while waiting does not make a second request.
        const again = await agent.post(`/archive/agendas/${itemId}/request`).set('X-Forwarded-For', ip)
            .type('form').send({ reason: 'Again please.' });
        expect(again.headers.location).toContain('request=pending');
        const page = await agent.get('/archive/agendas').set('X-Forwarded-For', ip);
        expect(page.text).toContain('Waiting for the Office of the Board Secretary');
    });

    test('a Trustee cannot open the requests page or approve their own request', async () => {
        const { agent, ip } = await login('trustee');
        const page = await agent.get('/archive/requests').set('X-Forwarded-For', ip);
        expect(page.statusCode).toBe(302);
        await agent.post(`/archive/requests/${requestId}/approve`).set('X-Forwarded-For', ip).type('form').send({});
        const [[q]] = await pool.query(`SELECT status FROM agenda_access_requests WHERE request_id = ?`, [requestId]);
        expect(q.status).toBe('pending');
    });

    test('the Secretary approves; the Trustee is notified and can now view it', async () => {
        const s = await login('secretary');
        const list = await s.agent.get('/archive/requests').set('X-Forwarded-For', s.ip);
        expect(list.text).toContain('To compare with the FY 2028 budget proposal.');
        const res = await s.agent.post(`/archive/requests/${requestId}/approve`).set('X-Forwarded-For', s.ip)
            .type('form').send({ note: 'For reference only.' });
        expect(res.headers.location).toContain('done=approved');
        const [[q]] = await pool.query(`SELECT status, expires_at FROM agenda_access_requests WHERE request_id = ?`, [requestId]);
        expect(q.status).toBe('approved');
        expect(new Date(q.expires_at) > new Date()).toBe(true);

        const t = await login('trustee');
        const [[n]] = await pool.query(
            `SELECT message, link FROM notifications WHERE kind = 'access_approved' AND item_id = ? ORDER BY notification_id DESC LIMIT 1`, [itemId]);
        expect(n.link).toBe(review());
        const page = await t.agent.get(review()).set('X-Forwarded-For', t.ip);
        expect(page.statusCode).toBe(200);
        expect(page.text).toContain('Approved until');
        expect(page.text).toContain('Back to Digital Archive');
    });

    test('when the approval ends, the item is closed again', async () => {
        await pool.query(`UPDATE agenda_access_requests SET expires_at = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE request_id = ?`, [requestId]);
        const t = await login('trustee');
        const res = await t.agent.get(review()).set('X-Forwarded-For', t.ip);
        expect(res.statusCode).toBe(302);
    });

    test('a council member does not see Board of Trustees agendas at all, and cannot ask for them', async () => {
        const a = await login('academic');
        const page = await a.agent.get('/archive/agendas').set('X-Forwarded-For', a.ip);
        expect(page.text).not.toContain('class="ag-title">FY 2027 Budget of the BSIT Program');
        expect(page.statusCode).toBe(200);
        const r = await a.agent.post(`/archive/agendas/${itemId}/request`).set('X-Forwarded-For', a.ip)
            .type('form').send({ reason: 'The Academic Council needs it for the BSIT curriculum review.' });
        expect(r.headers.location).not.toContain('request=sent');
        const [[n]] = await pool.query(
            `SELECT COUNT(*) AS n FROM agenda_access_requests q JOIN users u ON u.user_id = q.user_id
              WHERE q.item_id = ? AND u.council_type = 'ACADEMIC'`, [itemId]);
        expect(Number(n.n)).toBe(0);
    });

    test('a declined request stays closed, with the reason shown', async () => {
        const t = await login('trustee');
        const r = await t.agent.post(`/archive/agendas/${itemId}/request`).set('X-Forwarded-For', t.ip)
            .type('form').send({ reason: 'I need to check the figures again.' });
        expect(r.headers.location).toContain('request=sent');
        const [[q]] = await pool.query(`SELECT request_id FROM agenda_access_requests WHERE item_id = ? AND status = 'pending' ORDER BY request_id DESC LIMIT 1`, [itemId]);
        const s = await login('secretary');
        await s.agent.post(`/archive/requests/${q.request_id}/decline`).set('X-Forwarded-For', s.ip)
            .type('form').send({ note: 'Please coordinate with the Board Secretary.' });
        const res = await t.agent.get(review()).set('X-Forwarded-For', t.ip);
        expect(res.statusCode).toBe(302);
        const page = await t.agent.get('/archive/agendas').set('X-Forwarded-For', t.ip);
        expect(page.text).toContain('Your request was declined: Please coordinate with the Board Secretary.');
    });

    test('the Secretary can sort archived agendas: Board of Trustees, Board of Councils, each council', async () => {
        const s = await login('secretary');
        const all = await s.agent.get('/archive/agendas').set('X-Forwarded-For', s.ip);
        for (const label of ['All meetings', 'Board of Trustees']) {
            expect(all.text).toContain(`>${label} <span class="n">`);
        }
        // The councils are chosen from a dropdown on "Board of Councils" (no separate buttons).
        expect(all.text).toContain('<details class="bc-drop">');
        expect(all.text).toMatch(/<summary class="body-tab[^"]*">\s*Board of Councils\s*<span class="n">/);
        for (const label of ['All councils', 'Academic Council', 'Administrative Council', 'RIC Council']) {
            expect(all.text).toContain(`>${label} <span class="n">`);
        }
        expect(all.text).not.toMatch(/class="body-tab[^"]*"[^>]*>Academic <span/);
        const acad = await s.agent.get('/archive/agendas?body=academic').set('X-Forwarded-For', s.ip);
        expect(acad.text).toMatch(/Board of Councils: Academic\s*<span class="n">/);
        expect(acad.text).not.toContain('class="ag-title">FY 2027 Budget of the BSIT Program');
        const bot = await s.agent.get('/archive/agendas?body=bot').set('X-Forwarded-For', s.ip);
        expect(bot.text).toContain('class="ag-title">FY 2027 Budget of the BSIT Program');
        const councils = await s.agent.get('/archive/agendas?body=councils').set('X-Forwarded-For', s.ip);
        expect(councils.text).not.toContain('class="ag-title">FY 2027 Budget of the BSIT Program');
    });
});

describe('Google Drive backup folders', () => {
    const backup = require('../services/driveBackup');
    test('the four boards and councils each have a folder', () => {
        expect(backup.BODIES).toEqual(['Board of Trustees', 'Academic Council', 'Administrative Council', 'RIC Council']);
    });
    test('a meeting folder is named by number, title and date', () => {
        expect(backup.meetingFolder({ meeting_number: 'BOT-2026-001',
            meeting_title: '1st Regular Meeting of the Board of Trustees, AY 2026-2027',
            meeting_date: new Date(2026, 5, 20) }))
            .toBe('BOT-2026-001 - 1st Regular Meeting of the Board of Trustees, AY 2026-2027 (2026-06-20)');
    });
    test('a document keeps the board or council it belongs to', async () => {
        const Doc = require('../models/Document');
        await backup.ensureTables();
        const [[u]] = await pool.query(`SELECT user_id FROM users WHERE email = 'boardlink.secretary.demo@gmail.com'`);
        const id = await Doc.create({ title: 'TEST body doc', docType: 'Manual', docYear: '2026', category: null,
                                      filename: null, uploadedBy: u.user_id, governingBody: 'RIC Council' });
        const [[d]] = await pool.query('SELECT governing_body FROM documents WHERE document_id = ?', [id]);
        expect(d.governing_body).toBe('RIC Council');
        await pool.query('DELETE FROM documents WHERE document_id = ?', [id]);
    });
});
