// Module: Pre-meeting review — when the Board Secretary rewrites the words a
// Trustee commented on, the comment is NOT marked Done and the Trustee is
// NOT told it is done. Only the Secretary's Done button does that.
const { Document, Packer, Paragraph, TextRun } = require('docx');
const { login } = require('./helpers');
const pool = require('../config/db');
const Meeting = require('../models/Meeting');

let meetingId, itemId, commentId;
const number = `TEST-WORDS-${Date.now()}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

beforeAll(async () => {
    const doc = new Document({ sections: [{ children: [
        new Paragraph({ children: [new TextRun('BOARD PAPER ON THE LIBRARY')] }),
        new Paragraph({ children: [new TextRun('The library will open from eight in the morning until five in the afternoon on weekdays.')] }),
        new Paragraph({ children: [new TextRun('Students must present their identification card at the entrance.')] }),
    ] }] });
    const docx = await Packer.toBuffer(doc);

    const { agent, ip } = await login('secretary');
    const [[sec]] = await pool.query(`SELECT user_id FROM users WHERE email = 'boardlink.secretary.demo@gmail.com'`);
    const res = await agent.post('/meeting/create').set('X-Forwarded-For', ip)
        .field('title', 'Word edit test meeting').field('meeting_type', 'Board of Trustees')
        .field('meeting_number', number).field('meeting_date', '2030-03-01').field('meeting_time', '09:00')
        .field('venue', 'Board Room').field('mode', 'In-Person')
        .field('called_by_user_id', String(sec.user_id)).field('presided_by_user_id', String(sec.user_id))
        .field('quorum_required', '7')
        .field('item_title', 'Library hours').field('item_category', 'For Approval').field('item_key', 'r1')
        .attach('item_pdf__r1', docx, 'library.docx');
    meetingId = Number((/\/meeting\/(\d+)/.exec(res.headers.location) || [])[1]);
    const [[it]] = await pool.query(`SELECT item_id FROM meeting_agenda_items WHERE meeting_id = ?`, [meetingId]);
    itemId = it.item_id;
    for (let k = 0; k < 60; k++) {
        const [[row]] = await pool.query(`SELECT item_pdf_status FROM meeting_agenda_items WHERE item_id = ?`, [itemId]);
        if (row.item_pdf_status === 'ready') break;
        await sleep(500);
    }
}, 120000);

afterAll(async () => {
    if (meetingId) await Meeting.deleteMeeting(meetingId).catch(() => {});
    await pool.end().catch(() => {});
});

test('a Trustee comments on some words', async () => {
    const { agent, ip } = await login('trustee');
    const res = await agent.post(`/meeting/${meetingId}/item/${itemId}/comments`).set('X-Forwarded-For', ip)
        .send({ text: 'Please extend the hours to seven in the evening.',
                anchor: { type: 'text', page: 1, quote: 'until five in the afternoon', rects: [[0.3, 0.2, 0.3, 0.02]] } });
    expect(res.statusCode).toBe(201);
    commentId = res.body.comment.id;
});

test('the Secretary rewrites exactly those words', async () => {
    const { agent, ip } = await login('secretary');
    const blocks = await agent.get(`/meeting/${meetingId}/item/${itemId}/document/words/blocks`).set('X-Forwarded-For', ip);
    expect(blocks.statusCode).toBe(200);
    const b = blocks.body.blocks.find(x => /until five in the afternoon/.test(x.text));
    expect(b).toBeTruthy();
    const res = await agent.post(`/meeting/${meetingId}/item/${itemId}/document/words`).set('X-Forwarded-For', ip)
        .send({ version: blocks.body.version,
                edits: [{ id: b.id, text: b.text.replace('until five in the afternoon', 'until seven in the evening') }] });
    expect(res.statusCode).toBe(200);
    expect(res.body.to).toContain('document=reworded');
}, 120000);

test('the comment stays open, and the Trustee is not told it is done', async () => {
    const [[c]] = await pool.query(`SELECT status, addressed_at FROM meeting_item_comments WHERE comment_id = ?`, [commentId]);
    expect(c.status).toBe('Open');
    expect(c.addressed_at).toBeNull();
    const [notes] = await pool.query(`SELECT * FROM notifications WHERE comment_id = ? AND kind = 'comment_done'`, [commentId]);
    expect(notes.length).toBe(0);
});

test('only the Done button marks it done and tells the Trustee', async () => {
    const { agent, ip } = await login('secretary');
    await agent.post(`/meeting/${meetingId}/comment/${commentId}/addressed`).set('X-Forwarded-For', ip).type('form').send({});
    const [[c]] = await pool.query(`SELECT status FROM meeting_item_comments WHERE comment_id = ?`, [commentId]);
    expect(c.status).toBe('Addressed');
    const [notes] = await pool.query(`SELECT message FROM notifications WHERE comment_id = ? AND kind = 'comment_done'`, [commentId]);
    expect(notes.length).toBe(1);
    expect(notes[0].message).toContain('marked your comment');
});
