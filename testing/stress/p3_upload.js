// 20 users upload a ~1 MB scanned resolution at the same moment,
// through the real two-step flow: analyze (multipart upload + OCR
// autofill), then save the archive record.
const fs = require('fs');
const { BASE, ip, login } = require('./common');
const mysql = require('../../node_modules/mysql2/promise');
const FILE = fs.readFileSync(__dirname + '/scan_1mb.pdf');
(async () => {
  const db = await mysql.createConnection({ host: '127.0.0.1', user: 'root', password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || 'boardlink' });
  const [[{ c: before }]] = await db.query('SELECT COUNT(*) c FROM documents');
  const cookie = await login();
  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: Number(process.env.N||20) }, async (_, i) => { try {
    const addr = ip(); const s = Date.now();
    const fd = new FormData(); fd.append('file', new Blob([FILE], { type: 'application/pdf' }), `load-${i}.pdf`);
    const a = await fetch(BASE + '/archive/analyze', { method: 'POST', body: fd, headers: { cookie, 'x-forwarded-for': addr } });
    const aj = await a.json().catch(() => ({}));
    const tA = Date.now() - s;
    const u = await fetch(BASE + '/archive/upload', { method: 'POST', redirect: 'manual',
      headers: { cookie, 'x-forwarded-for': addr, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ docTitle: process.env.TITLE || `Stress Upload ${i + 1}`, docType: 'Resolution', docYear: '2018',
        docCategory: process.env.CAT || 'Load Test', uploadedFile: aj.uploadedFile || '' }) });
    const body = await u.text();
    return { i, analyzeStatus: a.status, detectedNumber: aj.fields && aj.fields.number, uploadStatus: u.status,
      saved: body.includes('was archived'), analyzeMs: tA, totalMs: Date.now() - s };
  } catch (e) { return { i, error: String(e.cause && e.cause.code || e.message), totalMs: null }; } }));
  const wall = Date.now() - t0;
  const [[{ c: after }]] = await db.query('SELECT COUNT(*) c FROM documents');
  const [[{ f }]] = await db.query("SELECT COUNT(*) f FROM documents WHERE category='Load Test' AND file_path IS NOT NULL AND file_path<>''");
  const ms = results.filter(r => r.totalMs != null).map(r => r.totalMs).sort((a, b) => a - b);
  console.log(JSON.stringify({ name: 'Concurrent Upload Load', uploads: 20, fileBytes: FILE.length,
    analyzeOk: results.filter(r => r.analyzeStatus === 200).length, uploadOk: results.filter(r => r.uploadStatus === 200 && r.saved).length,
    ocrReadNumber: results.filter(r => r.detectedNumber === '18-35').length,
    rowsBefore: before, rowsAfter: after, rowsAdded: after - before, rowsWithFile: f,
    failed: results.filter(r => r.error).map(r => r.error), avgMs: Math.round(ms.reduce((a, b) => a + b, 0) / ms.length), minMs: ms[0], maxMs: ms[ms.length - 1], wallMs: wall }, null, 1));
  await db.end();
})();
