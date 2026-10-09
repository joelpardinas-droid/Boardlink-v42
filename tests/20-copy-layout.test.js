// Module: OCR — copy the layout of the uploaded paper (v97 / v98):
// margins, the space between lines, indents, centred lines, sizes, bold.
const path = require('path');
const fs = require('fs'), os = require('os');
const { spawnSync } = require('child_process');
const ocr = require('../services/tesseractService');
const layout = require('../services/layoutService');
const textDoc = require('../services/textDocService');
const SAMPLE = path.join(__dirname, '..', 'samples', 'sample-previous-minutes.pdf');
afterAll(() => ocr.terminate && ocr.terminate());

let typed, scanned;
beforeAll(async () => {
    typed = await ocr.extractText(SAMPLE, 'eng', { maxPages: 40 });
    // the same paper as a picture (a scan)
    const base = path.join(os.tmpdir(), `lay-${process.pid}`);
    spawnSync('pdftoppm', ['-png', '-r', '150', '-f', '1', '-l', '1', '-singlefile', SAMPLE, base]);
    scanned = await ocr.extractText(base + '.png', 'eng');
    fs.unlink(base + '.png', () => {});
}, 180000);

describe('Where the lines are', () => {
    test('a typed PDF gives each line with its place, size and fonts', () => {
        const l = typed.layout[0].lines[0];
        expect(l.text).toBe('CAMARINES SUR POLYTECHNIC COLLEGES');
        expect(l.x0).toBeGreaterThan(0.2); expect(l.x1).toBeLessThan(0.8);
        expect(l.runs[0]).toMatchObject({ b: true, font: 'Arial' });
    });
    test('a scan gives each line with its place, and finds the bold lines', () => {
        const lines = scanned.layout[0].lines;
        expect(lines.length).toBeGreaterThan(10);
        const bold = lines.filter(l => l.bold).map(l => l.text);
        expect(bold.some(t => /Call to Order/.test(t))).toBe(true);
        expect(bold.some(t => /Approval of the Agenda/.test(t))).toBe(true);
        expect(lines.find(l => /^1 The meeting|^The meeting/.test(l.text)).bold).toBeFalsy();
    });
});

describe('The layout copied', () => {
    test('centred headings, bigger title, spaces, margins and page breaks', () => {
        const c = layout.fromLayout(typed.layout, 'letter');
        expect(c.margins.left).toBeGreaterThan(30); expect(c.margins.left).toBeLessThan(80);
        const [school, town, title] = c.paras;
        expect(school.align).toBe('center'); expect(town.align).toBe('center');
        expect(title.size).toBeGreaterThan(town.size);
        const head = c.paras.find(p => /Call to Order/.test(p.runs.map(r => r.text).join('')));
        expect(head.runs[0].b).toBe(true);
        expect(head.before).toBeGreaterThan(5);                     // a space above the section
        expect(c.paras.filter(p => p.pb).length).toBe(1);           // page 2 starts a new page
    });
    test('the scan gives the same kind of layout', () => {
        const c = layout.fromLayout(scanned.layout, 'letter');
        expect(c.paras[0].align).toBe('center');
        expect(c.paras.filter(p => p.runs.some(r => r.b)).length).toBeGreaterThanOrEqual(5);
    });
    test('the Word file has the margins, spaces, indents, sizes and fonts', async () => {
        const c = layout.fromLayout(typed.layout, 'letter');
        const buf = await textDoc.buildDocx({ title: 'x', doc: JSON.stringify(c.paras), margins: c.margins, paper: 'letter' });
        const f = path.join(os.tmpdir(), `lay-${process.pid}.docx`); fs.writeFileSync(f, buf);
        const xml = spawnSync('unzip', ['-p', f, 'word/document.xml'], { encoding: 'utf8' }).stdout; fs.unlink(f, () => {});
        expect(xml).toMatch(new RegExp(`<w:pgMar w:top="${Math.round(c.margins.top * 20)}"`));
        expect(xml).toMatch(/<w:spacing w:after="0" w:before="\d+" w:line="\d+" w:lineRule="exact"\/>/);
        expect(xml).toMatch(/<w:ind w:left="\d+"/);
        expect(xml).toContain('w:ascii="Arial"');
        expect(xml).toContain('<w:sz w:val="26"/>');                // the 13 pt title
    });
    test('the PDF made from it has the same number of pages as the paper', async () => {
        const c = layout.fromLayout(typed.layout, 'letter');
        const pdf = await textDoc.buildPdf({ title: 'x', doc: JSON.stringify(c.paras), margins: c.margins, paper: 'letter' });
        const f = path.join(os.tmpdir(), `lay-${process.pid}.pdf`); fs.writeFileSync(f, pdf);
        const info = spawnSync('pdfinfo', [f], { encoding: 'utf8' }).stdout; fs.unlink(f, () => {});
        expect(info).toMatch(/Pages:\s+2/);
    }, 120000);
    test('the browser cannot send odd margins or sizes', () => {
        expect(layout.cleanMargins('{"top":-5,"right":9999,"bottom":"x","left":10}')).toBeNull();
        expect(layout.cleanMargins({ top: -5, right: 9999, bottom: 20, left: 10 })).toEqual({ top: 9, right: 216, bottom: 20, left: 10 });
        const p = textDoc.normalize(JSON.stringify([{ align: 'left', size: 500, line: -3, before: 1e9, indent: 'x', runs: [{ text: 'a', font: 'Comic Sans' }] }]))[0];
        expect(p).toMatchObject({ size: 36, line: 6, before: 600, indent: 0 });
        expect(p.runs[0].font).toBeUndefined();
    });
});

describe('The OCR page', () => {
    const { login } = require('./helpers');
    test('opens on "Same as the scan", with the copied spaces on each paragraph', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.post('/ocr/process').set('X-Forwarded-For', ip).attach('file', SAMPLE, 'minutes.pdf');
        expect(res.text).toMatch(/<select name="layout" id="edLayout"><option value="scan" selected>Same as the scan<\/option>/);
        expect(res.text).toMatch(/data-layout="scan" style="--smt:[\d.]+pt/);
        expect(res.text).toMatch(/<p style="text-align:center;--b:[\d.]+pt;--ind:0pt;--fi:0pt;--fs:11pt;--lh:[\d.]+pt" data-l="1">/);
        expect(res.text).toContain('name="margins"');
    }, 120000);
    test('"Simple" makes the plain 1-inch pages', async () => {
        const { agent, ip } = await login('secretary');
        const doc = JSON.stringify([{ align: 'left', runs: [{ text: 'Words.' }] }]);
        const res = await agent.post('/ocr/download').set('X-Forwarded-For', ip).type('form')
            .send({ format: 'docx', doc, title: 'Simple', layout: 'simple', margins: JSON.stringify({ top: 20, right: 20, bottom: 20, left: 20 }) })
            .buffer(true).parse((r, cb) => { const d = []; r.on('data', x => d.push(x)); r.on('end', () => cb(null, Buffer.concat(d))); });
        const f = path.join(os.tmpdir(), `lays-${process.pid}.docx`); fs.writeFileSync(f, res.body);
        const xml = spawnSync('unzip', ['-p', f, 'word/document.xml'], { encoding: 'utf8' }).stdout; fs.unlink(f, () => {});
        expect(xml).toMatch(/<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/);
    });
});
