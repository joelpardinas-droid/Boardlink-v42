// Module: Pre-Meeting Review and Comment
const { login } = require('./helpers');
const access = require('../services/access');
const compile = require('../services/compileService');

const bot = { meeting_type: 'Board of Trustees', status: 'Distributed' };
describe('services/access.js', () => {
    test('a Trustee can see a Board of Trustees meeting', () => {
        expect(access.canSeeMeeting({ role: 'member', council_type: 'BOT' }, bot)).toBe(true);
    });
    test('an Academic Council member cannot see a Board of Trustees meeting', () => {
        expect(access.canSeeMeeting({ role: 'member', council_type: 'ACADEMIC' }, bot)).toBe(false);
    });
    test('only members may comment', () => {
        expect(access.isCommenter({ role: 'member' })).toBe(true);
        expect(access.isCommenter({ role: 'secretary' })).toBe(false);
    });
    test('comments close when the meeting is completed', () => {
        expect(access.commentsOpen({ status: 'Distributed' })).toBe(true);
        expect(access.commentsOpen({ status: 'Completed' })).toBe(false);
    });
});

describe('services/compileService.js', () => {
    test('groups each comment under its own agenda item', () => {
        const items = [{ item_id: 1 }, { item_id: 2 }];
        const comments = [
            { item_id: 1, comment_text: 'a' }, { item_id: 2, comment_text: 'b' }, { item_id: 2, comment_text: 'c' },
        ];
        const out = compile.groupComments(items, comments);
        const count = g => JSON.stringify(g).split('comment_text').length - 1;
        expect(out).toHaveLength(2);
        expect(count(out[0])).toBe(1);
        expect(count(out[1])).toBe(2);
    });
    test('reads a marked-area rectangle and ignores broken data', () => {
        expect(compile.parseRects('[[0.1,0.2,0.3,0.1]]')).toEqual([[0.1, 0.2, 0.3, 0.1]]);
        expect(compile.parseRects('not json')).toBeNull();
    });
    test('makes a safe file name for the compiled document', () => {
        expect(compile.safeName({ meeting_number: 'BOT 2026/114' })).toBe('BOT_2026_114');
    });
});

describe('Meeting page access', () => {
    test('a Trustee can open the Board of Trustees meeting', async () => {
        const { agent, ip } = await login('trustee');
        const res = await agent.get('/meeting/1').set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(200);
    });
    test('an Academic Council member is kept out of it', async () => {
        const { agent, ip } = await login('academic');
        const res = await agent.get('/meeting/1').set('X-Forwarded-For', ip);
        expect(res.statusCode).not.toBe(200);
    });
});
