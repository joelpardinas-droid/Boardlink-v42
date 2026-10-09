// ============================================================
// scripts/index_documents.js — Push seeded documents to Meilisearch
// ============================================================
//
// Reads all documents (and their OCR text) from MySQL and indexes
// them into Meilisearch so that AI-powered Document Search
// (Module 4) returns ranked results during the defense demo.
//
// Run AFTER seed_data.sql has been loaded:
//     node scripts/index_documents.js
//
// You only need to run this once. Re-running is safe — it
// overwrites existing entries with the same id.

require('dotenv').config();
const mysql = require('mysql2/promise');
const { MeiliSearch } = require('meilisearch');

(async () => {
    console.log('\nIndexing seed documents into Meilisearch...\n');

    let conn;
    try {
        // Pull documents + OCR text from MySQL
        conn = await mysql.createConnection({
            host:     process.env.DB_HOST     || 'localhost',
            port:     process.env.DB_PORT     || 3306,
            user:     process.env.DB_USER     || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME     || 'boardlink',
        });

        const [rows] = await conn.query(`
            SELECT d.document_id, d.title, d.doc_type, d.doc_year,
                   d.category, o.ocr_text
              FROM documents d
         LEFT JOIN document_ocr_text o ON o.document_id = d.document_id
          ORDER BY d.document_id
        `);

        if (rows.length === 0) {
            console.log('  No documents found in MySQL.');
            console.log('  Did you run:  mysql -u root -p < sql/seed_data.sql ?');
            process.exit(1);
        }

        // Shape documents the way Meilisearch expects
        const records = rows.map(r => ({
            id:       r.document_id,
            title:    r.title,
            type:     r.doc_type,
            year:     r.doc_year,
            category: r.category,
            snippet:  (r.ocr_text || '').slice(0, 300),
            fullText: r.ocr_text || '',
        }));

        // Push to Meilisearch
        const client = new MeiliSearch({
            host:   process.env.MEILI_HOST    || 'http://localhost:7700',
            apiKey: process.env.MEILI_API_KEY || '',
        });
        const index = client.index('documents');

        const task = await index.addDocuments(records);
        console.log(`  Submitted ${records.length} documents to Meilisearch`);
        console.log(`  Task UID: ${task.taskUid}`);

        // Wait for the indexing task to complete
        await client.waitForTask(task.taskUid);
        const stats = await index.getStats();
        console.log(`  Index now contains ${stats.numberOfDocuments} documents`);
        console.log('\nDone.\n');
    } catch (err) {
        console.error('\nError:', err.message);
        if (err.code === 'ECONNREFUSED' && err.address && err.address.includes('7700')) {
            console.error('  → Meilisearch is not running. Start meilisearch.exe first.');
        } else if (err.code === 'ECONNREFUSED') {
            console.error('  → MySQL is not running. Start XAMPP / MySQL service.');
        }
        process.exit(1);
    } finally {
        if (conn) await conn.end();
    }
})();
