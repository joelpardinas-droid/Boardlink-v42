// Module: OCR-based Document Processing and Metadata Autofill
const path = require('path');
const ocr = require('../services/tesseractService');
afterAll(() => ocr.terminate && ocr.terminate());

const EXCERPT = [
    'Excerpt from the Minutes of the 85th Regular Board of Trustees Meeting of the Camarines Sur',
    'Polytechnic Colleges held on June 22, 2018 at CHED Central Office, Quezon City',
    'Resolution No. 18-35',
    'Approving the Staffing Modifications of the College for CY 2018, subject to the availability of funds.',
    'Resolution No. 18-36',
    'Approving the Revised Faculty Manual of the College.',
].join('\n');

describe('extractMetadata', () => {
    test('reads the resolution number, year and date', () => {
        const m = ocr.extractMetadata(EXCERPT);
        expect(m.documentNumber).toBe('18-35');
        expect(m.year).toBe(2018);
        expect(m.date).toBe('2018-06-22');
    });
    test('flags fields it could not find for manual review', () => {
        const m = ocr.extractMetadata('an unreadable page');
        expect(m.documentNumber).toBeNull();
        expect(m.review).toContain('documentNumber');
    });
});

describe('extractResolutions / extractMeetingHeader', () => {
    test('finds every resolution in one excerpt', () => {
        const r = ocr.extractResolutions(EXCERPT);
        expect(r.map(x => x.number)).toEqual(['18-35', '18-36']);
        expect(r[0].title).toBe('Staffing Modifications of the College for CY 2018');
    });
    test('reads the meeting header', () => {
        const h = ocr.extractMeetingHeader(EXCERPT);
        expect(h.meetingOrdinal).toBe(85);
        expect(h.meetingKind).toBe('Regular');
        expect(h.venue).toContain('CHED Central Office');
    });
});

describe('extractText (Tesseract.js, offline language data)', () => {
    test('reads the text of a PDF document', async () => {
        const out = await ocr.extractText(path.join(__dirname, '..', 'samples', 'sample-previous-minutes.pdf'));
        expect(out.text.length).toBeGreaterThan(200);
    }, 120000);
});

// ── OCR page: correct the words, make a Word or PDF, save to the archive ──
describe('OCR page: from a scan to a new Word or PDF file', () => {
    const fs = require('fs'), os = require('os');
    const { spawnSync } = require('child_process');
    const { login } = require('./helpers');
    const pool = require('../config/db');
    let scan, savedId;
    const sample = path.join(__dirname, '..', 'samples', 'sample-previous-minutes.pdf');

    beforeAll(() => {
        // A real "scan": page 1 of the sample turned into a picture.
        const base = path.join(os.tmpdir(), `scan-${process.pid}`);
        spawnSync('pdftoppm', ['-png', '-r', '150', '-f', '1', '-l', '1', '-singlefile', sample, base]);
        scan = base + '.png';
    });
    afterAll(async () => {
        if (scan) fs.unlink(scan, () => {});
        if (savedId) {
            await pool.query('DELETE FROM document_ocr_text WHERE document_id = ?', [savedId]);
            await pool.query('DELETE FROM documents WHERE document_id = ?', [savedId]);
        }
        await pool.end().catch(() => {});
    });

    test('a picture of a page is read into a box of words that can be edited', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.post('/ocr/process').set('X-Forwarded-For', ip)
            .field('documentType', 'Resolution').attach('file', scan, 'old-scan.png');
        expect(res.statusCode).toBe(200);
        expect(res.text).toMatch(/<div id="ocrEditor" class="ocr-text[^"]*" contenteditable="true"[^>]*><p[\s\S]{100,}<\/div>/);
        expect(res.text).toContain('data-cmd="bold"');
        expect(res.text).toContain('data-case="upper"');
        expect(res.text).toContain('Download Word');
        expect(res.text).toContain('Save PDF to Digital Archive');
    }, 120000);

    test('v97: step 1 asks only for the file; step 3 has the details read from the paper', async () => {
        const { agent, ip } = await login('secretary');
        const page = await agent.get('/ocr').set('X-Forwarded-For', ip);
        expect(page.text).toContain('name="file"');
        for (const gone of ['name="documentType"', 'name="documentName"', 'name="documentYear"']) expect(page.text).not.toContain(gone);
        const res = await agent.post('/ocr/process').set('X-Forwarded-For', ip).attach('file', scan, 'old-scan.png');
        expect(res.text).toContain('Correct the words');
        expect(res.text).toContain('Make the file');
        expect(res.text).toMatch(/<select name="docType" id="docType">/);
        expect(res.text).toMatch(/<option value="Board of Trustees" selected>/);       // read from the paper
        expect(res.text).toContain('name="approvedById"');
        // pages like Word's: paper size, page break, page count
        expect(res.text).toContain('id="wdPages"');
        expect(res.text).toMatch(/<select name="paper" id="edPaper">/);
        expect(res.text).toContain('Long (8.5&#34; × 13&#34;)');
        expect(res.text).toContain('id="edPageBreak"');
        expect(res.text).toContain('Page 1 of 1');
    }, 120000);

    test('v97: the Word file has the chosen paper, 1-inch margins, exact 15 pt lines and the page breaks', async () => {
        const { agent, ip } = await login('secretary');
        const doc = JSON.stringify([{ align: 'center', runs: [{ text: 'RESOLUTION NO. 1999-07', b: true }] },
                                    { align: 'justify', pb: true, runs: [{ text: 'Page two words.' }] }]);
        const res = await agent.post('/ocr/download').set('X-Forwarded-For', ip).type('form')
            .send({ format: 'docx', doc, title: 'Paged', paper: 'long' })
            .buffer(true).parse((r, cb) => { const d = []; r.on('data', x => d.push(x)); r.on('end', () => cb(null, Buffer.concat(d))); });
        const f = path.join(os.tmpdir(), `ocrpg-${process.pid}.docx`);
        fs.writeFileSync(f, res.body);
        const xml = spawnSync('unzip', ['-p', f, 'word/document.xml'], { encoding: 'utf8' }).stdout;
        fs.unlink(f, () => {});
        expect(xml).toMatch(/<w:pgSz w:w="12240" w:h="18720"/);
        expect(xml).toMatch(/<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/);
        expect(xml).toMatch(/<w:spacing w:after="200" w:line="300" w:lineRule="exact"\/>/);
        expect(xml).toContain('<w:pageBreakBefore/>');
        expect(xml).toContain('<w:keepLines/>');
    });

    test('v97: the PDF has the same pages (paper size and page break)', async () => {
        const { agent, ip } = await login('secretary');
        const doc = JSON.stringify([{ align: 'left', runs: [{ text: 'Page one.' }] }, { align: 'left', pb: true, runs: [{ text: 'Page two.' }] }]);
        const res = await agent.post('/ocr/download').set('X-Forwarded-For', ip).type('form')
            .send({ format: 'pdf', doc, title: 'Paged', paper: 'a4' })
            .buffer(true).parse((r, cb) => { const d = []; r.on('data', x => d.push(x)); r.on('end', () => cb(null, Buffer.concat(d))); });
        const f = path.join(os.tmpdir(), `ocrpg-${process.pid}.pdf`);
        fs.writeFileSync(f, res.body);
        const info = spawnSync('pdfinfo', [f], { encoding: 'utf8' }).stdout;
        fs.unlink(f, () => {});
        expect(info).toMatch(/Pages:\s+2/);
        expect(info).toMatch(/Page size:\s+595(\.\d+)? x 841(\.\d+)? pts/);
    }, 120000);

    test('v97: a manual saved from the OCR page goes to Documents, linked to its resolution', async () => {
        const { agent, ip } = await login('secretary');
        const [[resn]] = await pool.query("SELECT document_id FROM documents WHERE doc_type = 'Resolution' ORDER BY document_id LIMIT 1");
        const title = 'Zq OCR manual ' + Date.now();
        const res = await agent.post('/ocr/save').set('X-Forwarded-For', ip).type('form')
            .send({ text: 'MANUAL\n\nSome words of the manual.', title, docType: 'Manual', number: 'OM-1', year: '2026',
                    governingBody: 'Academic Council', approvedById: String(resn.document_id) });
        expect(res.statusCode).toBe(302);
        const id = Number((/\/archive\/(\d+)/.exec(res.headers.location) || [])[1]);
        const [[d]] = await pool.query('SELECT doc_type, governing_body, category FROM documents WHERE document_id = ?', [id]);
        expect(d).toEqual({ doc_type: 'Manual', governing_body: 'Academic Council', category: 'OM-1' });
        const [[a]] = await pool.query('SELECT resolution_id FROM document_attachments WHERE document_id = ?', [id]);
        expect(a.resolution_id).toBe(resn.document_id);
        await pool.query('DELETE FROM document_attachments WHERE document_id = ?', [id]);
        await pool.query('DELETE FROM document_ocr_text WHERE document_id = ?', [id]);
        await pool.query('DELETE FROM documents WHERE document_id = ?', [id]);
    }, 120000);

    test('no file means no made-up words', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.post('/ocr/process').set('X-Forwarded-For', ip).field('documentType', 'Resolution');
        expect(res.statusCode).toBe(400);
        expect(res.text).not.toContain('WHEREAS, the Board of Trustees convened');
    });

    const corrected = 'REPUBLIC OF THE PHILIPPINES\nCAMARINES SUR POLYTECHNIC COLLEGES\n\n' +
        'RESOLUTION NO. 1999-07\n\nApproving the opening of the Bachelor of Science in Information Technology program.\n\n' +
        'RESOLVED, as it is hereby resolved, that the BSIT program be offered starting School Year 1999-2000.';

    test('the corrected words download as a Word file', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.post('/ocr/download').set('X-Forwarded-For', ip).type('form')
            .send({ format: 'docx', text: corrected, title: 'Opening of the BSIT Program' })
            .buffer(true).parse((r, cb) => { const d = []; r.on('data', x => d.push(x)); r.on('end', () => cb(null, Buffer.concat(d))); });
        expect(res.headers['content-type']).toContain('wordprocessingml');
        expect(res.headers['content-disposition']).toContain('Opening of the BSIT Program.docx');
        const f = path.join(os.tmpdir(), `ocr-${process.pid}.docx`);
        fs.writeFileSync(f, res.body);
        const xml = spawnSync('unzip', ['-p', f, 'word/document.xml'], { encoding: 'utf8' }).stdout;
        fs.unlink(f, () => {});
        expect(xml).toContain('Bachelor of Science in Information Technology');
    });

    test('bold, italic, underline and centring from the editor reach the Word file', async () => {
        const { agent, ip } = await login('secretary');
        const doc = JSON.stringify([
            { align: 'center', runs: [{ text: 'RESOLUTION NO. 1999-07', b: true }] },
            { align: 'justify', runs: [{ text: 'Approving the ' }, { text: 'BSIT', b: true, i: true }, { text: ' program, ' },
                                      { text: 'subject to funds', u: true }, { text: '.' }] },
        ]);
        const res = await agent.post('/ocr/download').set('X-Forwarded-For', ip).type('form')
            .send({ format: 'docx', doc, text: 'ignored', title: 'Formatted' })
            .buffer(true).parse((r, cb) => { const d = []; r.on('data', x => d.push(x)); r.on('end', () => cb(null, Buffer.concat(d))); });
        const f = path.join(os.tmpdir(), `ocrfmt-${process.pid}.docx`);
        fs.writeFileSync(f, res.body);
        const xml = spawnSync('unzip', ['-p', f, 'word/document.xml'], { encoding: 'utf8' }).stdout;
        fs.unlink(f, () => {});
        expect(xml).toMatch(/<w:jc w:val="center"\/>/);
        expect(xml).toMatch(/<w:b\/>[\s\S]*?<w:i\/>[\s\S]*?<w:t[^>]*>BSIT<\/w:t>/);
        expect(xml).toMatch(/<w:u w:val="single"\/>[\s\S]*?subject to funds/);
        expect(xml).not.toContain('ignored');
    });

    test('a formatted PDF is made (bold, italic, underline)', async () => {
        const { agent, ip } = await login('secretary');
        const doc = JSON.stringify([{ align: 'left', runs: [{ text: 'Plain ' }, { text: 'bold', b: true }, { text: ' italic', i: true },
                                                            { text: ' both', b: true, i: true }, { text: ' under', u: true }] }]);
        const res = await agent.post('/ocr/download').set('X-Forwarded-For', ip).type('form')
            .send({ format: 'pdf', doc, title: 'Formatted' })
            .buffer(true).parse((r, cb) => { const d = []; r.on('data', x => d.push(x)); r.on('end', () => cb(null, Buffer.concat(d))); });
        const body = res.body.toString('latin1');
        expect(body.slice(0, 5)).toBe('%PDF-');
        for (const font of ['LiberationSerif-Bold', 'LiberationSerif-Italic', 'LiberationSerif-BoldItalic']) expect(body).toContain(font);
    });

    test('the corrected words download as a PDF', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.post('/ocr/download').set('X-Forwarded-For', ip).type('form')
            .send({ format: 'pdf', text: corrected, title: 'Opening of the BSIT Program' })
            .buffer(true).parse((r, cb) => { const d = []; r.on('data', x => d.push(x)); r.on('end', () => cb(null, Buffer.concat(d))); });
        expect(res.headers['content-type']).toContain('application/pdf');
        expect(res.body.slice(0, 5).toString()).toBe('%PDF-');
    });

    test('a Board Resolution needs its number before it is saved', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.post('/ocr/save').set('X-Forwarded-For', ip).type('form')
            .send({ text: corrected, title: 'Opening of the BSIT Program', docType: 'Resolution', number: '', year: '1999' });
        expect(res.statusCode).toBe(400);
        expect(res.text).toContain('needs its number');
    });

    test('saving puts a PDF in the Digital Archive, searchable by its words', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.post('/ocr/save').set('X-Forwarded-For', ip).type('form')
            .send({ text: corrected, title: 'Opening of the BSIT Program', docType: 'Resolution', number: '1999-07', year: '1999' });
        expect(res.statusCode).toBe(302);
        savedId = Number((/\/archive\/(\d+)\?saved=ocr/.exec(res.headers.location) || [])[1]);
        expect(savedId).toBeGreaterThan(0);
        const file = await agent.get(`/archive/${savedId}/file`).set('X-Forwarded-For', ip);
        expect(file.headers['content-type']).toContain('pdf');
        const search = await agent.get('/archive').query({ q: 'Information Technology program' }).set('X-Forwarded-For', ip);
        expect(search.text).toContain('Opening of the BSIT Program');
    });

    test('a Trustee cannot use the OCR page', async () => {
        const { agent, ip } = await login('trustee');
        const res = await agent.post('/ocr/save').set('X-Forwarded-For', ip).type('form')
            .send({ text: corrected, title: 'x', docType: 'Other', year: '2026' });
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).not.toContain('/archive/');
    });
});
