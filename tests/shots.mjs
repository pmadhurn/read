// Screenshots of every page at phone / tablet / desktop sizes with real device emulation.
import { createRequire } from 'node:module';
const require = createRequire('/home/ubuntu/spends-ledger/');
const { chromium, devices } = require('playwright');
const [BASE, PASSCODE, PIN, OUT] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/home/ubuntu/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome', args: ['--no-sandbox'] });
const profiles = { iphone: devices['iPhone 13'], small: { ...devices['iPhone SE'], viewport: { width: 360, height: 640 } }, land: { ...devices['iPhone 13 landscape'] }, ipad: devices['iPad (gen 7)'], desk: { viewport: { width: 1366, height: 768 } } };
const ctx0 = await b.newContext(profiles.iphone); const p0 = await ctx0.newPage();
await p0.goto(BASE + '/'); await p0.screenshot({ path: `${OUT}/iphone-gate.png` });
await p0.fill('#passcode', PASSCODE); await p0.click('#go'); await p0.waitForSelector('.picker');
await p0.screenshot({ path: `${OUT}/iphone-picker.png` });
const name = 'Shot' + Date.now().toString(36).slice(-5);
await p0.getByText('Add profile').click(); await p0.waitForSelector('.modal'); await p0.screenshot({ path: `${OUT}/iphone-newprofile.png` });
await p0.fill('.modal input[type=text]', name); await p0.click('.modal button[type=submit]'); await p0.waitForSelector('.ring');
const cookies = await ctx0.cookies(); const pid = await p0.evaluate(() => localStorage.getItem('read.profile'));
const book = await p0.evaluate(async () => (await (await fetch('/api/books/paste', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Profile-Id': localStorage.getItem('read.profile') }, body: JSON.stringify({ title: 'Screenshot Book', author: 'Nobody', text: 'Chapter 1\n\n' + 'the quick brown fox jumps over the lazy dog. '.repeat(150) + '\n\nChapter 2\n\n' + 'more text here. '.repeat(200) }) })).json()));
await ctx0.close();
const cleanup = async () => { const c = await b.newContext(profiles.desk); await c.addCookies(cookies); const p = await c.newPage(); await p.goto(BASE + '/'); await p.evaluate(async ([pid, bid, PIN]) => { const hd = { 'Content-Type': 'application/json', 'X-Profile-Id': pid }; await fetch('/api/access/admin', { method: 'POST', headers: hd, body: JSON.stringify({ pin: PIN }) }); await fetch('/api/books/' + bid, { method: 'DELETE', headers: hd }); await fetch('/api/admin/profiles/' + pid, { method: 'DELETE', headers: hd }); }, [pid, book.book_id, PIN]); await c.close(); };
process.on('uncaughtException', async (e) => { console.log('ERR', e.message.split('\n')[0]); await cleanup(); await b.close(); process.exit(1); });
const pages = { home: '#/', library: '#/library', book: `#/book/${book.book_id}`, reader: `#/read/${book.book_id}`, upload: '#/upload', discover: '#/discover', ranks: '#/ranks', stats: '#/stats', badges: '#/badges', settings: '#/settings' };
for (const [dev, opts] of Object.entries(profiles)) {
  const ctx = await b.newContext(opts); await ctx.addCookies(cookies); const page = await ctx.newPage();
  await page.goto(BASE + '/'); await page.evaluate((id) => localStorage.setItem('read.profile', id), pid); await page.reload(); await page.waitForSelector('.topbar');
  for (const [n, hash] of Object.entries(pages)) {
    await page.goto(BASE + '/' + hash); await page.waitForTimeout(1500);
    if (n === 'reader') { await page.keyboard.press('Space'); await page.waitForTimeout(700); await page.screenshot({ path: `${OUT}/${dev}-reader-playing.png` }); await page.keyboard.press('Space'); await page.waitForTimeout(400); }
    await page.screenshot({ path: `${OUT}/${dev}-${n}.png`, fullPage: n !== 'reader' });
  }
  if (dev === 'iphone') { await page.goto(BASE + '/#/settings'); await page.waitForSelector('h1:has-text("Settings")'); await page.locator('button:has-text("Admin")').click(); await page.waitForSelector('.modal'); await page.screenshot({ path: `${OUT}/iphone-pin.png` }); await page.fill('.modal input', PIN); await page.click('.modal button[type=submit]'); await page.waitForSelector('h1:has-text("Admin")'); await page.screenshot({ path: `${OUT}/iphone-admin.png`, fullPage: true }); }
  await ctx.close();
}
await cleanup();
await b.close(); console.log('done');
