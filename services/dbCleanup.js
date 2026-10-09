// ============================================================
// services/dbCleanup.js — removes leftover tables and columns
// ============================================================
//
// Earlier versions of BOARDLINK had RSVP/attendance, meeting minutes,
// drafted resolutions, a separate meeting recording and an access log.
// Those features were removed, but their tables and columns stayed in
// databases made by the older schema.sql. This step removes them once,
// at start-up, so the database matches the ERD exactly.
//
// Nothing that the system uses is touched: archived documents (which
// include uploaded resolutions) stay in `documents`.

const pool = require('../config/db');

const OLD_TABLES = ['minutes_reviews', 'meeting_minutes', 'meeting_summaries', 'meeting_transcripts',
                    'meeting_attendance', 'resolutions', 'access_logs'];
const OLD_COLUMNS = {
    meetings: ['agenda_pdf_filename', 'previous_minutes_meeting_id', 'previous_minutes_pdf',
               'minutes_general_notes', 'minutes_drafted_by', 'minutes_drafted_at'],
    meeting_agenda_items: ['item_description', 'sponsor_user_id', 'document_id', 'source_item_id',
                           'approved_by_council', 'minutes_action', 'minutes_note'],
    agenda_archive: ['outcome'],
};

async function run() {
    const conn = await pool.getConnection();
    const removed = [];
    try {
        const [tables] = await conn.query(
            `SELECT TABLE_NAME AS t FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)`, [OLD_TABLES]);
        if (tables.length) {
            await conn.query('SET FOREIGN_KEY_CHECKS = 0');
            try {
                for (const { t } of tables) {
                    await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
                    removed.push(t);
                }
            } finally {
                await conn.query('SET FOREIGN_KEY_CHECKS = 1');
            }
        }
        for (const [table, cols] of Object.entries(OLD_COLUMNS)) {
            const [have] = await conn.query(
                `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME IN (?)`, [table, cols]);
            if (!have.length) continue;
            const names = have.map(r => r.c);
            // A column that refers to another table must lose that link first.
            const [fks] = await conn.query(
                `SELECT DISTINCT CONSTRAINT_NAME AS n FROM information_schema.KEY_COLUMN_USAGE
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME IN (?)
                    AND REFERENCED_TABLE_NAME IS NOT NULL`, [table, names]);
            for (const { n } of fks) await conn.query(`ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${n}\``);
            await conn.query(`ALTER TABLE \`${table}\` ` + names.map(c => `DROP COLUMN \`${c}\``).join(', '));
            removed.push(...names.map(c => `${table}.${c}`));
        }
        if (removed.length) {
            console.log(`  🧹  Database cleaned: removed ${removed.length} leftover table(s)/column(s) from removed features (${removed.join(', ')})`);
        }
        return removed;
    } finally {
        conn.release();
    }
}

module.exports = { run, OLD_TABLES, OLD_COLUMNS };
