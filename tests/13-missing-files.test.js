// When the database names a file that is not on this computer (e.g. a new
// BOARDLINK version unzipped into a new folder), the agenda item shows no
// document — not the title of a file that cannot be opened.
const fs = require('fs');
const path = require('path');
const { login } = require('./helpers');
const pool = require('../config/db');
const Meeting = require('../models/Meeting');
const { UPLOAD_DIR } = require('../config/paths');

let meetingId, itemId, stored;
const number = `TEST-MISSING-${Date.now()}`;

beforeAll(async () => {
    const { agent, ip } = await login('secretary');
    const [[sec]] = await pool.query(`SELECT user_id FROM users WHERE email = 'boardlink.secretary.demo@gmail.com'`);
    const res = await agent.post('/meeting/create').set('X-Forwarded-For', ip)
        .field('title', 'Missing file test').field('meeting_type', 'Board of Trustees')
        .field('meeting_number', number).field('meeting_date', '2030-04-01').field('meeting_time', '09:00')
        .field('venue', 'Board Room').field('mode', 'In-Person')
        .field('called_by_user_id', String(sec.user_id)).field('presided_by_user_id', String(sec.user_id))
        .field('quorum_required', '7')
        .field('item_title', 'Item with a lost file').field('item_category', 'For Approval').field('item_key', 'r1')
        .attach('item_pdf__r1', path.join(__dirname, '..', 'samples', 'sample-budget-proposal.pdf'), 'Lost Paper v72.pdf');
    meetingId = Number((/\/meeting\/(\d+)/.exec(res.headers.location) || [])[1]);
    const [[it]] = await pool.query(`SELECT item_id, item_pdf FROM meeting_agenda_items WHERE meeting_id = ?`, [meetingId]);
    itemId = it.item_id; stored = it.item_pdf;
    await new Promise(r => setTimeout(r, 1500));
    // The file disappears, as in a fresh BOARDLINK folder.
    fs.unlinkSync(path.join(UPLOAD_DIR, stored));
});

afterAll(async () => {
    if (meetingId) await Meeting.deleteMeeting(meetingId).catch(() => {});
    await pool.end().catch(() => {});
});

test('a Trustee sees no file title and no Open button for the item', async () => {
    const { agent, ip } = await login('trustee');
    const res = await agent.get(`/meeting/${meetingId}`).set('X-Forwarded-For', ip);
    expect(res.text).toContain('Item with a lost file');
    expect(res.text).not.toContain('Lost Paper v72.pdf');
    expect(res.text).not.toContain(`/item/${itemId}/review" class="btn btn-navy`);
});

test('the Secretary is told the file is missing and can attach it again', async () => {
    const { agent, ip } = await login('secretary');
    const res = await agent.get(`/meeting/${meetingId}`).set('X-Forwarded-For', ip);
    expect(res.text).toContain('Item with a lost file has been removed or deleted. Attach it again.');
    expect(res.text).toContain('Attach PDF, Word or video');
});

test('the item page says there is no document, without the old title', async () => {
    const { agent, ip } = await login('secretary');
    const res = await agent.get(`/meeting/${meetingId}/item/${itemId}/review`).set('X-Forwarded-For', ip);
    expect(res.text).toContain('No document attached to this item');
    expect(res.text).not.toContain('class="rv-file">Lost Paper v72.pdf');
});

test('nothing in the database was deleted (the file can be put back)', async () => {
    const [[it]] = await pool.query(`SELECT item_pdf FROM meeting_agenda_items WHERE item_id = ?`, [itemId]);
    expect(it.item_pdf).toBe(stored);
});
