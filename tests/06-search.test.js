// Module: AI-powered Document Search (Meilisearch)
const { login } = require('./helpers');
const search = require('../services/meilisearchService');

describe('meilisearchService.search', () => {
    test('finds a resolution by a word in its title', async () => {
        const hits = await search.search('calendar');
        expect(hits.length).toBeGreaterThanOrEqual(1);
        expect(JSON.stringify(hits[0])).toContain('Calendar');
    });
    test('tolerates a spelling mistake', async () => {
        const hits = await search.search('calender');
        expect(hits.length).toBeGreaterThanOrEqual(1);
    });
    test('every word must match, so extra words narrow the result', async () => {
        const one = await search.search('approving');
        const two = await search.search('approving calendar');
        expect(two.length).toBeLessThan(one.length);
        expect(two.length).toBeGreaterThanOrEqual(1);
    });
    test('a word that is nowhere in the archive returns nothing', async () => {
        const hits = await search.search('zzqxwvunmatched');
        expect(hits).toHaveLength(0);
    });
});

describe('Archive search page', () => {
    test('shows the matching resolution', async () => {
        const { agent, ip } = await login('secretary');
        // Words from inside Resolution No. 2026-22 (the academic calendar).
        const res = await agent.get('/archive?q=eighteen+weeks').set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain('2026-22');
        expect(res.text).not.toContain('2026-21');
    });
});

describe('The database matches the ERD (leftovers removed)', () => {
    const pool = require('../config/db');
    const OLD = ['resolutions', 'meeting_transcripts', 'meeting_summaries', 'meeting_minutes',
                 'meeting_attendance', 'minutes_reviews', 'access_logs'];
    afterAll(() => pool.end().catch(() => {}));
    test('only the 19 tables of the ERD are left', async () => {
        const [rows] = await pool.query('SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
        const names = rows.map(r => r.t).sort();
        expect(names).toEqual(['agenda_access_requests', 'agenda_archive', 'agenda_item_file_versions', 'agenda_item_pages',
            'agenda_item_summaries', 'app_settings', 'auth_codes', 'document_access_requests', 'document_attachments', 'document_ocr_text', 'documents', 'meeting_agenda_items',
            'meeting_briefings', 'meeting_item_comments', 'meetings', 'notifications', 'user_account_logs', 'user_sessions', 'users']);
        for (const t of OLD) expect(names).not.toContain(t);
    });
    test('the leftover columns are gone', async () => {
        const [rows] = await pool.query(
            `SELECT CONCAT(TABLE_NAME, '.', COLUMN_NAME) AS c FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME IN
              ('agenda_pdf_filename','previous_minutes_meeting_id','previous_minutes_pdf','minutes_general_notes',
               'minutes_drafted_by','minutes_drafted_at','item_description','sponsor_user_id','source_item_id',
               'approved_by_council','minutes_action','minutes_note','outcome')`);
        expect(rows.map(r => r.c)).toEqual([]);
        const [[d]] = await pool.query(`SELECT COUNT(*) AS n FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meeting_agenda_items' AND COLUMN_NAME = 'document_id'`);
        expect(Number(d.n)).toBe(0);
    });
    test('there are exactly 26 links (foreign keys), as in the ERD', async () => {
        const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM information_schema.KEY_COLUMN_USAGE
             WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`);
        expect(Number(rows[0].n)).toBe(26);
    });
    test('the old Draft Resolution page is gone', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get('/meeting/1/resolution').set('X-Forwarded-For', ip);
        expect(res.statusCode).not.toBe(200);
    });
});
