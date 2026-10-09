// ============================================================
// scripts/check_setup.js — Pre-flight verification
// ============================================================
//
// Run this BEFORE the title defense (and before each rehearsal)
// to confirm every service BOARDLINK depends on is responding.
//
// Usage:    node scripts/check_setup.js
//
// Exit code 0 = everything green. Exit code 1 = at least one
// service is not ready and needs attention before the demo.

require('dotenv').config();
const fs        = require('fs');
const { spawn } = require('child_process');
const mysql     = require('mysql2/promise');

let failures = 0;

const ok   = (msg) => console.log('\x1b[32m[\u2713]\x1b[0m ' + msg);
const fail = (msg) => { console.log('\x1b[31m[\u2717]\x1b[0m ' + msg); failures++; };
const info = (msg) => console.log('    ' + msg);

console.log('\nBOARDLINK pre-defense verification');
console.log('═══════════════════════════════════════════════\n');

// ── MySQL ─────────────────────────────────────────────────────
async function checkMySQL() {
    let conn;
    try {
        conn = await mysql.createConnection({
            host:     process.env.DB_HOST     || 'localhost',
            port:     process.env.DB_PORT     || 3306,
            user:     process.env.DB_USER     || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME     || 'boardlink',
        });
        ok('MySQL is reachable');
        const [rows] = await conn.query('SELECT COUNT(*) AS n FROM users');
        if (rows[0].n >= 5) {
            ok(`Database 'boardlink' has ${rows[0].n} users seeded`);
        } else {
            fail(`Database 'boardlink' has only ${rows[0].n} users (expected 5)`);
            info("Run:  mysql -u root -p < sql\\seed_data.sql");
        }
        const [docs] = await conn.query('SELECT COUNT(*) AS n FROM documents');
        if (docs[0].n >= 8) {
            ok(`Database has ${docs[0].n} seeded documents`);
        } else {
            fail(`Database has only ${docs[0].n} documents (expected 8)`);
        }
    } catch (err) {
        fail(`MySQL not reachable: ${err.code || err.message}`);
        info('Start MySQL via XAMPP Control Panel or Windows Services');
        info('Confirm DB_PASSWORD in .env matches your MySQL root password');
    } finally {
        if (conn) await conn.end();
    }
}

// ── Meilisearch ──────────────────────────────────────────────
async function checkMeilisearch() {
    const host = process.env.MEILI_HOST || 'http://localhost:7700';
    try {
        const health = await fetch(`${host}/health`);
        if (!health.ok) throw new Error(`HTTP ${health.status}`);
        ok(`Meilisearch is running on ${host}`);

        const stats = await fetch(`${host}/indexes/documents/stats`);
        if (stats.ok) {
            const data = await stats.json();
            if (data.numberOfDocuments >= 4) {
                ok(`Meilisearch 'documents' index has ${data.numberOfDocuments} documents`);
            } else {
                fail(`Meilisearch 'documents' index has only ${data.numberOfDocuments} documents`);
                info("Run:  node scripts\\index_documents.js");
            }
        } else if (stats.status === 404) {
            fail("Meilisearch 'documents' index does not exist");
            info("Run:  node scripts\\index_documents.js");
        }
    } catch (err) {
        fail(`Meilisearch not reachable at ${host}: ${err.message}`);
        info('Start Meilisearch by double-clicking meilisearch.exe');
    }
}

// ── Ollama ────────────────────────────────────────────────────
async function checkOllama() {
    const host  = process.env.OLLAMA_HOST  || 'http://127.0.0.1:11434';
    const model = process.env.OLLAMA_MODEL || 'llama3.1:8b';
    try {
        const tags = await fetch(`${host}/api/tags`);
        if (!tags.ok) throw new Error(`HTTP ${tags.status}`);
        ok(`Ollama is running on ${host}`);

        const data = await tags.json();
        const names = (data.models || []).map(m => m.name);
        if (names.some(n => n === model || n.startsWith(model.split(':')[0]))) {
            ok(`Ollama model '${model}' is available`);
        } else {
            fail(`Ollama model '${model}' is NOT installed`);
            info(`Run:  ollama pull ${model}`);
            info(`Currently installed: ${names.join(', ') || '(none)'}`);
        }
    } catch (err) {
        fail(`Ollama not reachable at ${host}: ${err.message}`);
        info('Confirm Ollama is installed (https://ollama.com/download)');
        info('Open Task Manager → Services and look for "Ollama"');
    }
}

// ── whisper.cpp ──────────────────────────────────────────────
async function checkWhisper() {
    const bin   = process.env.WHISPER_BIN   || 'whisper';
    const model = process.env.WHISPER_MODEL || 'models/ggml-base.en.bin';

    // Check the model file exists
    try {
        if (model.includes('/') || model.includes('\\')) {
            fs.accessSync(model);
            const stat = fs.statSync(model);
            ok(`whisper.cpp model file found: ${model} (${(stat.size / 1024 / 1024).toFixed(0)} MB)`);
        }
    } catch (err) {
        fail(`whisper.cpp model file NOT found at: ${model}`);
        info('Download a model from https://huggingface.co/ggerganov/whisper.cpp');
        info('Recommended: ggml-base.en.bin (~150 MB)');
        return;
    }

    // Check the binary is launchable
    return new Promise((resolve) => {
        const child = spawn(bin, ['--help']);
        let started = false;
        child.on('error', (err) => {
            fail(`whisper.cpp binary cannot be launched: ${err.code || err.message}`);
            info(`WHISPER_BIN is set to: ${bin}`);
            info('Confirm Microsoft Visual C++ Redistributable is installed');
            resolve();
        });
        child.on('spawn', () => { started = true; });
        child.on('close', () => {
            if (started) ok(`whisper.cpp binary found and runnable: ${bin}`);
            resolve();
        });
        // If it doesn't start within 3 seconds, kill it
        setTimeout(() => { if (!started) child.kill(); }, 3000);
    });
}

// ── Run all checks ───────────────────────────────────────────
(async () => {
    await checkMySQL();
    console.log('');
    await checkMeilisearch();
    console.log('');
    await checkOllama();
    console.log('');
    await checkWhisper();

    console.log('\n═══════════════════════════════════════════════');
    if (failures === 0) {
        console.log('\x1b[32mAll systems ready for defense.\x1b[0m\n');
        process.exit(0);
    } else {
        console.log(`\x1b[31m${failures} check(s) failed.\x1b[0m`);
        console.log('Fix the issues above before defense day.\n');
        process.exit(1);
    }
})();
