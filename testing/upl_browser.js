// Uploads a scan through the real Upload Resolution page in Chromium,
// waits for autofill, clicks Save to Archive and reports what happened.
const { chromium } = require('playwright-core');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await (await b.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
  const B = 'http://127.0.0.1:3100';
  await p.goto(B + '/'); await p.fill('input[name=email]', 'boardlink.secretary.demo@gmail.com'); await p.fill('input[name=password]', 'Test@2026!');
  await Promise.all([p.waitForNavigation(), p.click('button[type=submit]')]);
  await p.goto(B + '/archive/upload');
  await p.setInputFiles('input[name=file]', __dirname + '/scan_1mb.pdf');
  await p.waitForFunction(() => document.getElementById('uploadedFile').value !== '', null, { timeout: 120000 });
  await p.waitForTimeout(500);
  const fields = await p.evaluate(() => ({ title: document.getElementById('f-title').value, number: document.getElementById('f-number').value, year: document.getElementById('f-year').value }));
  console.log('autofill:', JSON.stringify(fields));
  await Promise.all([p.waitForNavigation(), p.click('#uploadForm button[type=submit]')]);
  const msg = await p.evaluate(() => (document.querySelector('.alert, .flash, .success, .error, [class*=alert]') || document.body).innerText.slice(0, 200));
  console.log('after save:', msg.replace(/\s+/g, ' '));
  await p.screenshot({ path: '/tmp/after_save.png' });
  await b.close();
})();
