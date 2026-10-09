#!/usr/bin/env node
// ============================================================
// scripts/reset-archive.js — empty the Digital Archive and add the
// two board resolutions in sample-archive/
// ============================================================
//
// Removes EVERY record from the Digital Archive (the documents table,
// their read text, their files in uploads/ and the search index), then
// archives the two resolutions kept in sample-archive/ and reads their
// text so they can be searched by their words.
//
// Nothing else is touched: meetings, agenda items, their documents,
// comments and users stay as they are. An agenda item or drafted
// resolution that pointed at a removed archive record simply stops
// pointing at it.
//
// Usage:
//   node scripts/reset-archive.js          shows what would be removed
//   node scripts/reset-archive.js --yes    does it

require('dotenv').config();

const fs     = require('fs');
const path   = require('path');
const pool   = require('../config/db');
const documentIndexer  = require('../services/documentIndexer');
const tesseractService = require('../services/tesseractService');

const ROOT    = path.join(__dirname, '..');
const UPLOADS = require('../config/paths').UPLOAD_DIR;
const SAMPLES = path.join(ROOT, 'sample-archive');

// The two resolutions, with fixed stored names so running this twice
// does not leave extra copies behind.
const RESOLUTIONS = [
    {
        file:     'Resolution_No_2026-21_FY2027_Administrative_Budget.pdf',
        stored:   'a1b2c3d4e5f60718293a4b5c6d7e2621',
        number:   '2026-21',
        title:    'Approving the FY 2027 Administrative Budget of the Camarines Sur Polytechnic Colleges',
        year:     2026,
        archived: '2026-05-18 10:00:00',
    },
    {
        file:     'Resolution_No_2026-22_Academic_Calendar_AY2026-2027.pdf',
        stored:   'a1b2c3d4e5f60718293a4b5c6d7e2622',
        number:   '2026-22',
        title:    'Approving the Academic Calendar of the Camarines Sur Polytechnic Colleges for Academic Year 2026-2027',
        year:     2026,
        archived: '2026-05-18 10:05:00',
    },
];

async function clearSearchIndex() {
    try {
        const { documentsIndex } = require('../config/meilisearch');
        const task = await documentsIndex.deleteAllDocuments();
        if (task && task.taskUid !== undefined && documentsIndex.waitForTask) {
            await documentsIndex.waitForTask(task.taskUid, { timeOutMs: 10000 }).catch(() => {});
        }
        return 'cleared';
    } catch (err) {
        return `not reachable (${err.code || err.message}); MySQL search still works`;
    }
}

async function main() {
    const doIt = process.argv.includes('--yes');

    const [docs] = await pool.query('SELECT document_id, category, title, file_path FROM documents ORDER BY document_id');
    console.log(`\nThe Digital Archive has ${docs.length} record(s):`);
    docs.forEach(d => console.log(`  #${d.document_id}  ${d.category || '—'}  ${String(d.title).slice(0, 70)}`));

    if (!doIt) {
        console.log('\nNothing was changed. To remove them all and add the two resolutions, run:');
        console.log('  node scripts/reset-archive.js --yes\n');
        return;
    }

    for (const r of RESOLUTIONS) {
        if (!fs.existsSync(path.join(SAMPLES, r.file))) throw new Error(`Missing sample-archive/${r.file}`);
    }

    // 1) Remove the old records. Files used by an agenda item are never
    //    deleted, even if an archive record happened to point at one.
    const [inUse] = await pool.query(
        `SELECT item_pdf AS f FROM meeting_agenda_items WHERE item_pdf IS NOT NULL
         UNION SELECT item_pdf FROM agenda_item_file_versions`);
    const keep = new Set(inUse.map(r => r.f));
    let filesRemoved = 0;
    for (const d of docs) {
        const name = d.file_path ? path.basename(d.file_path) : null;
        if (!name || keep.has(name)) continue;
        const full = path.join(UPLOADS, name);
        if (full.startsWith(UPLOADS + path.sep) && fs.existsSync(full)) { fs.unlinkSync(full); filesRemoved++; }
    }

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query('UPDATE meeting_agenda_items SET document_id = NULL WHERE document_id IS NOT NULL');
        await conn.query('DELETE FROM document_ocr_text');
        await conn.query('DELETE FROM documents');
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
    await pool.query('ALTER TABLE documents AUTO_INCREMENT = 1');
    console.log(`\nRemoved ${docs.length} record(s) and ${filesRemoved} file(s). Search index: ${await clearSearchIndex()}.`);

    // 2) Archive the two resolutions, uploaded by the Board Secretary.
    const [[sec]] = await pool.query(
        `SELECT user_id FROM users WHERE role = 'secretary' AND is_active = 1 ORDER BY user_id LIMIT 1`);
    fs.mkdirSync(UPLOADS, { recursive: true });
    for (const r of RESOLUTIONS) {
        fs.copyFileSync(path.join(SAMPLES, r.file), path.join(UPLOADS, r.stored));
        const [res] = await pool.query(
            `INSERT INTO documents (title, doc_type, doc_year, category, file_path, uploaded_by, uploaded_at)
             VALUES (?, 'Resolution', ?, ?, ?, ?, ?)`,
            [r.title, r.year, r.number, r.stored, sec ? sec.user_id : null, r.archived]);
        // 3) Read its text, exactly as an upload through the page does.
        const out = await documentIndexer.indexDocument({
            document_id: res.insertId, title: r.title, doc_type: 'Resolution',
            doc_year: r.year, category: r.number, file_path: r.stored,
        });
        console.log(`Added Resolution No. ${r.number} as #${res.insertId}: ` + (out.ok
            ? `${out.chars} characters read, ${Math.round(out.confidence)}% confidence`
            : `saved, but its text was not read (${out.reason}). Run: node scripts/backfill-ocr.js`));
    }
    // Copy them to the Google Drive backup folder, when it is connected.
    try {
        const backup = require('../services/driveBackup');
        if (backup.enabled() && (await backup.status()).connected) {
            const b = await backup.backupPending();
            console.log(`Google Drive backup: ${b.done} copied${b.failed ? `, ${b.failed} failed` : ''}.`);
        }
    } catch (_) { /* backup is optional */ }
    console.log('\nDone. Open the Digital Archive to see them.\n');
}

main()
    .catch(err => { console.error('\nStopped:', err.message, '\n'); process.exitCode = 1; })
    .finally(async () => {
        try { await tesseractService.terminate(); } catch (_) {}
        try { await pool.end(); } catch (_) {}
        process.exit();
    });
