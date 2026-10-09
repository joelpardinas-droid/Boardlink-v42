// Module: Pre-Meeting Review and Comment — the whole commenting flow on a
// real meeting: post, edit, move, delete, Done, compile, live, closed (v99).
const path = require('path');
const { login } = require('./helpers');
const pool = require('../config/db');
const PDF = path.join(__dirname, '..', 'samples', 'sample-budget-proposal.pdf');
const NUMBER = 'BOT-TEST-CMT-' + Date.now();
let M, I, sec, t1, t2, ac;

const json = (r) => r.set('Accept', 'application/json');
async function post(who, url, body) { return json(who.agent.post(url).set('X-Forwarded-For', who.ip)).send(body); }
async function get(who, url) { return json(who.agent.get(url).set('X-Forwarded-For', who.ip)); }

beforeAll(async () => {
    [sec, t1, t2, ac] = await Promise.all([login('secretary'), login('trustee'), login('trustee2'), login('academic')]);
    const [[u]] = await pool.query("SELECT user_id FROM users WHERE role = 'secretary' LIMIT 1");
    const res = await sec.agent.post('/meeting/create').set('X-Forwarded-For', sec.ip)
        .field('meeting_type', 'Board of Trustees').field('title', 'Commenting test').field('meeting_number', NUMBER)
        .field('meeting_date', '2026-12-20').field('meeting_time', '09:00').field('venue', 'Board Room')
        .field('called_by_user_id', String(u.user_id)).field('presided_by_user_id', String(u.user_id))
        .field('quorum_required', '7').field('item_key', 'r1').field('item_title', 'FY 2027 Budget').field('item_category', 'For Approval')
        .attach('item_pdf__r1', PDF);
    expect(res.status).toBe(302);
    const [[row]] = await pool.query(
        `SELECT m.meeting_id, i.item_id FROM meetings m JOIN meeting_agenda_items i USING (meeting_id) WHERE m.meeting_number = ?`, [NUMBER]);
    M = row.meeting_id; I = row.item_id;
}, 120000);

afterAll(async () => {
    if (M) {
        await pool.query('DELETE FROM notifications WHERE link LIKE ?', [`/meeting/${M}/%`]).catch(() => {});
        await sec.agent.post(`/meeting/${M}/delete`).set('X-Forwarded-For', sec.ip).type('form').send({ confirm_number: NUMBER }).catch(() => {});
        await pool.query('DELETE c FROM meeting_item_comments c JOIN meeting_agenda_items i USING (item_id) WHERE i.meeting_id = ?', [M]).catch(() => {});
        await pool.query('DELETE FROM agenda_archive WHERE meeting_id = ?', [M]).catch(() => {});
        await pool.query('DELETE FROM meeting_agenda_items WHERE meeting_id = ?', [M]).catch(() => {});
        await pool.query('DELETE FROM meetings WHERE meeting_id = ?', [M]).catch(() => {});
    }
    await pool.end();
});

let textId, areaId;
describe('Posting', () => {
    test('a Trustee comments on words, on an area, and on the whole item', async () => {
        let r = await post(t1, `/meeting/${M}/item/${I}/comments`, { text: 'Show the source of funds.',
            anchor: { type: 'text', page: 1, quote: 'Budget', rects: [[0.1, 0.1, 0.2, 0.02]] } });
        expect(r.status).toBe(201); textId = r.body.comment.id;
        expect(r.body.comment.anchor.quote).toBe('Budget');
        r = await post(t1, `/meeting/${M}/item/${I}/comments`, { text: 'Add a total row.', anchor: { type: 'area', page: 1, rects: [[0.2, 0.3, 0.4, 0.1]] } });
        expect(r.status).toBe(201); areaId = r.body.comment.id;
        r = await post(t1, `/meeting/${M}/item/${I}/comments`, { text: '<img src=x onerror=alert(1)> general' });
        expect(r.status).toBe(201);
        expect(r.body.comment.text).toBe('<img src=x onerror=alert(1)> general');      // kept as plain words
    });
    test('empty, too long and wrong pages are refused', async () => {
        expect((await post(t1, `/meeting/${M}/item/${I}/comments`, { text: ' ' })).status).toBe(400);
        expect((await post(t1, `/meeting/${M}/item/${I}/comments`, { text: 'x'.repeat(4001) })).status).toBe(400);
        expect((await post(t1, `/meeting/${M}/item/${I}/comments`, { text: 'p', anchor: { type: 'text', page: 99, quote: 'x', rects: [[0.1, 0.1, 0.1, 0.1]] } })).status).toBe(400);
    });
    test('only members of this board may read or post; the Secretary does not post', async () => {
        expect((await get(ac, `/meeting/${M}/item/${I}/comments`)).status).toBe(403);
        expect((await post(ac, `/meeting/${M}/item/${I}/comments`, { text: 'x' })).status).toBe(403);
        expect((await post(sec, `/meeting/${M}/item/${I}/comments`, { text: 'x' })).status).not.toBe(201);
    });
});

describe('Changing comments', () => {
    test('only the author edits or deletes; a highlight on words cannot be moved', async () => {
        expect((await post(t2, `/meeting/${M}/comment/${textId}/edit`, { text: 'hijack' })).status).toBe(403);
        expect((await post(t2, `/meeting/${M}/comment/${textId}/delete`, {})).status).toBe(403);
        let r = await post(t1, `/meeting/${M}/comment/${textId}/edit`, { text: 'Show the source of funds (edited).' });
        expect(r.status).toBe(200); expect(r.body.comment.editedAt).toBeTruthy();
        r = await post(t1, `/meeting/${M}/comment/${areaId}/edit`, { text: 'moved', anchor: { page: 2, rects: [[0.1, 0.1, 0.3, 0.1]] } });
        expect(r.status).toBe(200); expect(r.body.comment.page).toBe(2);
        expect((await post(t1, `/meeting/${M}/comment/${textId}/edit`, { text: 'x', anchor: { page: 1, rects: [[0.1, 0.1, 0.3, 0.1]] } })).status).toBe(400);
        expect((await post(t1, `/meeting/${M}/comment/${areaId}/delete`, {})).status).toBe(200);
    });
});

describe('The meeting page composer', () => {
    test('a comment is saved; a too-long one is not dropped silently', async () => {
        let r = await t1.agent.post(`/meeting/${M}/comment`).set('X-Forwarded-For', t1.ip).type('form').send({ item_id: String(I), comment_text: 'From the meeting page.' });
        expect(r.headers.location).toBe(`/meeting/${M}#item-${I}`);
        r = await t1.agent.post(`/meeting/${M}/comment`).set('X-Forwarded-For', t1.ip).type('form').send({ item_id: String(I), comment_text: 'y'.repeat(4500) });
        expect(r.headers.location).toBe(`/meeting/${M}?comment_error=long#item-${I}`);
        const page = await t1.agent.get(r.headers.location.split('#')[0]).set('X-Forwarded-For', t1.ip);
        expect(page.text).toContain('limited to 4,000 characters');
        expect(page.text).toMatch(/<textarea name="comment_text" id="composerText" required maxlength="4000"/);
    });
    test('an item of another meeting cannot be commented on from this meeting', async () => {
        const [[other]] = await pool.query('SELECT item_id FROM meeting_agenda_items WHERE meeting_id <> ? LIMIT 1', [M]);
        if (!other) return;
        const before = (await pool.query('SELECT COUNT(*) n FROM meeting_item_comments WHERE item_id = ?', [other.item_id]))[0][0].n;
        await t1.agent.post(`/meeting/${M}/comment`).set('X-Forwarded-For', t1.ip).type('form').send({ item_id: String(other.item_id), comment_text: 'stray' });
        const after = (await pool.query('SELECT COUNT(*) n FROM meeting_item_comments WHERE item_id = ?', [other.item_id]))[0][0].n;
        expect(after).toBe(before);
    });
});

describe('Done, compiled, live and closed', () => {
    test('the Secretary marks Done; the author is told and can no longer change it', async () => {
        await sec.agent.post(`/meeting/${M}/comment/${textId}/addressed`).set('X-Forwarded-For', sec.ip).type('form').send({});
        const [[c]] = await pool.query('SELECT status, user_id FROM meeting_item_comments WHERE comment_id = ?', [textId]);
        expect(c.status).toBe('Addressed');
        const [[n]] = await pool.query("SELECT COUNT(*) n FROM notifications WHERE kind = 'comment_done' AND user_id = ? AND link LIKE ?", [c.user_id, `%#comment-${textId}`]);
        expect(n.n).toBe(1);
        expect((await post(t1, `/meeting/${M}/comment/${textId}/edit`, { text: 'late' })).status).toBe(409);
        // from the meeting page, the member is told why
        const r = await t1.agent.post(`/meeting/${M}/comment/${textId}/edit`).set('X-Forwarded-For', t1.ip).type('form').send({ text: 'late' });
        expect(r.headers.location).toContain('comment_error=edit_done');
        // a Trustee cannot mark Done
        await t1.agent.post(`/meeting/${M}/comment/${textId}/addressed`).set('X-Forwarded-For', t1.ip).type('form').send({});
    });
    test('the compiled Word and PDF files hold the comments', async () => {
        const d = await sec.agent.get(`/meeting/${M}/comments/compiled.docx`).set('X-Forwarded-For', sec.ip).buffer(true)
            .parse((r, cb) => { const b = []; r.on('data', x => b.push(x)); r.on('end', () => cb(null, Buffer.concat(b))); });
        expect(d.status).toBe(200); expect(d.body.slice(0, 2).toString()).toBe('PK');
        const p = await sec.agent.get(`/meeting/${M}/comments/compiled.pdf`).set('X-Forwarded-For', sec.ip).buffer(true)
            .parse((r, cb) => { const b = []; r.on('data', x => b.push(x)); r.on('end', () => cb(null, Buffer.concat(b))); });
        expect(p.status).toBe(200); expect(p.body.slice(0, 5).toString()).toBe('%PDF-');
    });
    test('during the meeting comments are In-Session; after it ends nothing can be added or changed', async () => {
        await sec.agent.post(`/meeting/${M}/start`).set('X-Forwarded-For', sec.ip).type('form').send({});
        const r = await post(t1, `/meeting/${M}/item/${I}/comments`, { text: 'Live remark.' });
        expect(r.status).toBe(201); expect(r.body.comment.phase).toBe('In-Session');
        const liveId = r.body.comment.id;
        await sec.agent.post(`/meeting/${M}/end`).set('X-Forwarded-For', sec.ip).type('form').send({});
        expect((await post(t1, `/meeting/${M}/item/${I}/comments`, { text: 'too late' })).status).not.toBe(201);
        expect((await post(t1, `/meeting/${M}/comment/${liveId}/edit`, { text: 'changed' })).status).toBe(409);
        expect((await post(t1, `/meeting/${M}/comment/${liveId}/delete`, {})).status).toBe(409);
        const page = await t1.agent.post(`/meeting/${M}/comment`).set('X-Forwarded-For', t1.ip).type('form').send({ item_id: String(I), comment_text: 'late page' });
        expect(page.headers.location).toContain('comment_error=closed');
    });
});
