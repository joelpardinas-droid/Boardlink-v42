#!/usr/bin/env node
/**
 * scripts/backfill-ocr.js — make existing resolutions searchable
 * BOARDLINK | Module 2.4 + 2.5
 *
 * Reads every archived document that has no stored text, OCRs it,
 * saves the text to MySQL and pushes it to Meilisearch. After this
 * runs, searching the Digital Archive matches the CONTENTS of a
 * resolution, not just its title.
 *
 * This is needed because documents uploaded before OCR-on-upload
 * existed have a row in `documents` but nothing in
 * `document_ocr_text`.
 *
 * Usage:
 *   node scripts/backfill-ocr.js              process everything pending
 *   node scripts/backfill-ocr.js --limit 20   process the first 20
 *   node scripts/backfill-ocr.js --dry-run    report only, change nothing
 *   node scripts/backfill-ocr.js --again      read EVERY document again (e.g. so
 *                                             typed PDFs use their exact words
 *                                             instead of older OCR text)
 *
 * Safe to re-run: documents that already have text are skipped, so
 * an interrupted run can simply be started again.
 */

require('dotenv').config();

const Document        = require('../models/Document');
const documentIndexer = require('../services/documentIndexer');
const tesseractService = require('../services/tesseractService');

function arg(name, fallback) {
    const i = process.argv.indexOf(name);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT   = Number(arg('--limit', 500));
const AGAIN   = process.argv.includes('--again');

async function main() {
    console.log('BOARDLINK — OCR backfill\n');

    let coverage;
    try {
        coverage = await Document.countOcrCoverage();
    } catch (err) {
        console.error('Cannot reach the database:', err.message);
        console.error('Check the DB_* settings in .env and that MySQL is running.');
        process.exit(1);
    }

    const total   = Number(coverage.total)   || 0;
    const indexed = Number(coverage.indexed) || 0;
    console.log(`Archived documents : ${total}`);
    console.log(`Already searchable : ${indexed}`);
    console.log(`Pending            : ${total - indexed}\n`);

    if (total === indexed && !AGAIN) {
        console.log('Nothing to do — every document is already searchable by its contents.');
        await tesseractService.terminate();
        process.exit(0);
    }

    const pending = AGAIN
        ? (await require('../config/db').query(
              `SELECT document_id, title, doc_type, doc_year, category, file_path FROM documents
                WHERE file_path IS NOT NULL ORDER BY document_id LIMIT ?`, [LIMIT]))[0]
        : await Document.findWithoutOcr(LIMIT);
    console.log(`Processing ${pending.length} document(s)${DRY_RUN ? ' (dry run)' : ''}...\n`);

    let ok = 0, failed = 0;
    const problems = [];

    for (let i = 0; i < pending.length; i++) {
        const doc   = pending[i];
        const label = `[${i + 1}/${pending.length}] #${doc.document_id} ${String(doc.title).slice(0, 52)}`;

        if (DRY_RUN) {
            const found = documentIndexer.resolveFile(doc.file_path);
            console.log(`${label} — ${found ? 'would process' : 'FILE MISSING'}`);
            if (!found) problems.push(`#${doc.document_id} ${doc.title}: file not found`);
            continue;
        }

        process.stdout.write(`${label} ... `);
        const started = Date.now();
        try {
            const result = await documentIndexer.indexDocument(doc);
            const secs   = ((Date.now() - started) / 1000).toFixed(1);
            if (result.ok) {
                ok++;
                console.log(`ok (${result.chars} chars, ${result.pages} page(s), ${secs}s)`);
            } else {
                failed++;
                console.log(`skipped — ${result.reason}`);
                problems.push(`#${doc.document_id} ${doc.title}: ${result.reason}`);
            }
        } catch (err) {
            failed++;
            console.log(`FAILED — ${err.message}`);
            problems.push(`#${doc.document_id} ${doc.title}: ${err.message}`);
        }
    }

    console.log('\n────────────────────────────────');
    if (DRY_RUN) {
        console.log('Dry run complete. Nothing was changed.');
    } else {
        console.log(`Indexed : ${ok}`);
        console.log(`Skipped : ${failed}`);
    }
    if (problems.length) {
        console.log('\nNeeds attention:');
        problems.forEach(p => console.log('  - ' + p));
        console.log('\nA missing file usually means the document row survived but the');
        console.log('scan itself was removed from uploads/. Those resolutions stay');
        console.log('searchable by title and number; re-upload the scan to index the body.');
    }

    await tesseractService.terminate();
    process.exit(0);
}

main().catch(err => {
    console.error('\nBackfill failed:', err.message);
    process.exit(1);
});
