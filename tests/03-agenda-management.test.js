// Module: Agenda Management
const { login } = require('./helpers');
const gov = require('../config/governance');
const { _commentDeadlineFor } = require('../controllers/meetingController');

describe('config/governance.js', () => {
    test('Board of Trustees: 11 members, quorum 7', () => {
        expect(gov.membershipFor('Board of Trustees')).toBe(11);
        expect(gov.quorumFor('Board of Trustees')).toBe(7);
    });
    test('Academic Council quorum is 37 of 72', () => {
        expect(gov.quorumFor('Academic Council')).toBe(37);
        expect(gov.membershipFor('Academic Council')).toBe(72);
    });
    test('an unknown body has no quorum', () => {
        expect(gov.quorumFor('Student Council')).toBeNull();
    });
});

describe('commentDeadlineFor', () => {
    test('defaults to five days before the meeting', () => {
        expect(_commentDeadlineFor('2030-03-20')).toBe('2030-03-15');
    });
    test('keeps a date the Secretary chose', () => {
        expect(_commentDeadlineFor('2030-03-20', '2030-03-18')).toBe('2030-03-18');
    });
    test('never lets the deadline fall after the meeting', () => {
        expect(_commentDeadlineFor('2030-03-20', '2030-03-25')).toBe('2030-03-20');
    });
});

describe('Meeting routes', () => {
    test('the Board Secretary can open Create Meeting', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get('/meeting/create').set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(200);
    });
    test('a Trustee cannot open Create Meeting', async () => {
        const { agent, ip } = await login('trustee');
        const res = await agent.get('/meeting/create').set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(302);
    });
});

describe('Meeting Records: sort by governing body', () => {
    const pool = require('../config/db');
    afterAll(() => pool.end().catch(() => {}));
    const rows = html => (html.match(/<td data-label="Type"><span class="[^"]*">([^<]+)<\/span><\/td>/g) || [])
        .map(t => t.replace(/<[^>]+>/g, ''));

    test('the Secretary sees buttons for the Board of Trustees, the Board of Councils and each council', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get('/meeting').set('X-Forwarded-For', ip);
        for (const label of ['All meetings', 'Board of Trustees']) {
            expect(res.text).toContain(`>${label} <span class="n">`);
        }
        // The councils are picked from a dropdown on "Board of Councils".
        expect(res.text).toMatch(/<summary class="body-tab[^"]*">\s*Board of Councils\s*<span class="n">/);
        for (const label of ['All councils', 'Academic Council', 'Administrative Council', 'RIC Council']) {
            expect(res.text).toContain(`>${label} <span class="n">`);
        }
        expect(res.text).not.toMatch(/class="body-tab[^"]*"[^>]*>Academic <span/);
        const admin = await agent.get('/meeting?body=admin').set('X-Forwarded-For', ip);
        expect(admin.text).toMatch(/Board of Councils: Administrative\s*<span class="n">/);
    });

    test('each button shows only its meetings', async () => {
        const { agent, ip } = await login('secretary');
        const bot = rows((await agent.get('/meeting?body=bot').set('X-Forwarded-For', ip)).text);
        expect(bot.every(t => t === 'Board of Trustees')).toBe(true);
        const councils = rows((await agent.get('/meeting?body=councils').set('X-Forwarded-For', ip)).text);
        expect(councils.every(t => ['Academic Council', 'Administrative Council', 'RIC Council'].includes(t))).toBe(true);
        const all = rows((await agent.get('/meeting').set('X-Forwarded-For', ip)).text);
        expect(all.length).toBe(bot.length + councils.length);
    });

    test('a Trustee sees only Board of Trustees meetings, without the buttons', async () => {
        const { agent, ip } = await login('trustee');
        const res = await agent.get('/meeting?body=councils').set('X-Forwarded-For', ip);
        expect(res.text).not.toContain('class="body-tabs"');
    });

    test('the login page and the sidebar no longer carry the office line', async () => {
        const { request, BASE } = require('./helpers');
        const res = await request(BASE).get('/');
        expect(res.text).not.toContain('Office of the Board Secretary — Camarines Sur Polytechnic Colleges');
        const { agent, ip } = await login('secretary');
        const page = await agent.get('/meeting').set('X-Forwarded-For', ip);
        expect(page.text).not.toContain('CSPC Board Secretary');
    });
});
