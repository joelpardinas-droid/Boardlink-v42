// Module: AI-generated Meeting Summary (Ollama + Llama 3.1 8B)
const { login } = require('./helpers');
const { parseItemSummary } = require('../services/summaryFormat');
const keys = require('../services/keySentences');

describe('parseItemSummary', () => {
    test('splits the model reply into summary, key points and action', () => {
        const out = parseItemSummary([
            'SUMMARY: The Budget Office asks for a supplemental budget.',
            'KEY POINTS:',
            '- Amount: PHP 2,500,000',
            '- Source: income fund',
            'ACTION REQUESTED: approval of the supplemental budget',
        ].join('\n'));
        expect(out.summary).toBe('The Budget Office asks for a supplemental budget.');
        expect(out.points).toEqual(['Amount: PHP 2,500,000', 'Source: income fund']);
        expect(out.action).toBe('approval of the supplemental budget');
    });
    test('an empty reply gives empty parts instead of an error', () => {
        expect(parseItemSummary('')).toEqual({ summary: '', points: [], action: '' });
    });
});

describe('keySentences.condense', () => {
    test('a short document is passed to the model whole', () => {
        const r = keys.condense([{ page: 1, text: 'Approving the budget.' }], 9000);
        expect(r.condensed).toBe(false);
    });
    test('a long document is cut down to the character budget', () => {
        const long = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} states a fact about the budget of the college.`).join(' ');
        const r = keys.condense([{ page: 1, text: long }], 3000);
        expect(r.condensed).toBe(true);
        expect(r.keptChars).toBeLessThanOrEqual(3300);
    });
});

describe('Summary page', () => {
    test('the Board Secretary can open it', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get('/meeting/summary').set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(200);
    });
    test('a Trustee cannot', async () => {
        const { agent, ip } = await login('trustee');
        const res = await agent.get('/meeting/summary').set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(302);
    });
});
