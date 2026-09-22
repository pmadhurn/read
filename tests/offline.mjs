// Offline on a device: install the app once, keep a book, cut the network, reload cold, read, come back.
import { createRequire } from 'node:module';
const require = createRequire('/home/ubuntu/spends-ledger/');
const { chromium } = require('playwright');
const [BASE, PASSCODE, PIN] = process.argv.slice(2);
const results = []; const check = (n, ok, info = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', n, ok ? '' : JSON.stringify(info)); };
const b = await chromium.launch({ executablePath: '/home/ubuntu/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome', args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 390, height: 800 } }); const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
const F = (path, opt = {}) => page.evaluate(async ([path, opt]) => { const r = await fetch(path, { ...opt, headers: { 'Content-Type': 'application/json', 'X-Profile-Id': localStorage.getItem('read.profile') || '', ...(opt.headers || {}) } }); return { status: r.status, body: await r.json().catch(() => null) }; }, [path, opt]);
await page.goto(BASE + '/'); await page.fill('#passcode', PASSCODE); await page.click('#go'); await page.waitForSelector('.picker');
await page.getByText('Add profile').click(); await page.fill('.modal input[type=text]', 'Off' + Date.now().toString(36).slice(-5)); await page.click('.modal button[type=submit]'); await page.waitForSelector('.ring');
const pid = await page.evaluate(() => localStorage.getItem('read.profile'));
const book = (await F('/api/books/paste', { method: 'POST', body: JSON.stringify({ title: 'Offline Book ' + Date.now().toString(36).slice(-4), text: ['Chapter 1', 'Chapter 2', 'Chapter 3'].map((c) => c + '\n\n' + 'words for reading offline on a phone. '.repeat(120)).join('\n\n') }) })).body;
await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 });
await page.waitForTimeout(3000);   // let the install precache finish
const shell = await page.evaluate(async () => (await (await caches.open('read-shell-v3')).keys()).length);
check('app shell precached on install', shell >= 30, shell);
await page.goto(`${BASE}/#/book/${book.book_id}`); await page.waitForSelector('button[aria-pressed]:has-text("Keep offline")');
await page.click('button:has-text("Keep offline")'); await page.waitForSelector('button:has-text("Saved offline")', { timeout: 20000 });
check('Keep offline saves the book', true);

await ctx.setOffline(true);
// A cold start while offline: new tab, deep link straight to the library.
const p2 = await ctx.newPage(); p2.on('pageerror', (e) => errs.push(e.message));
await p2.goto(`${BASE}/#/library`).catch((e) => console.log('nav:', e.message)); 
await p2.waitForSelector('.book', { timeout: 15000 }).then(() => check('cold start offline: library renders from cache', true)).catch(() => check('cold start offline: library renders from cache', false));
check('offline chip shown', await p2.locator('.offline-chip').isVisible());
await p2.locator('select[aria-label=Filter]').selectOption('offline'); await p2.waitForTimeout(200);
check('"Saved on this device" filter', (await p2.locator('.book').count()) === 1);
await p2.goto(`${BASE}/#/read/${book.book_id}`); 
await p2.waitForSelector('.context .w.cur', { timeout: 15000 }).then(() => check('reader opens offline', true)).catch(() => check('reader opens offline', false));
await p2.keyboard.press('Space'); await p2.waitForTimeout(6500); await p2.keyboard.press('Space');
await p2.locator('button[aria-label="Contents and bookmarks"]').click(); await p2.waitForSelector('.panel .toc');
await p2.locator('.panel .toc button').nth(2).click(); await p2.waitForTimeout(800);
check('other chapter opens offline', (await p2.locator('.reader-title span').innerText()).includes('Chapter 3'));
const queued = await p2.evaluate(() => JSON.parse(localStorage.getItem('read.beats') || '[]').length);
check('reading queued while offline', queued >= 1, queued);
await p2.goto(`${BASE}/#/settings`); await p2.waitForSelector('h1:has-text("Settings")', { timeout: 10000 }).then(() => check('settings page offline', true)).catch(() => check('settings page offline', false));
await ctx.setOffline(false); await p2.evaluate(() => window.dispatchEvent(new Event('online'))); await p2.waitForTimeout(3000);
const me = (await p2.evaluate(async () => (await fetch('/api/me', { headers: { 'X-Profile-Id': localStorage.getItem('read.profile') } })).json()));
check('offline reading synced and counted', me.today.words > 20, me.today);
check('queue drained', (await p2.evaluate(() => JSON.parse(localStorage.getItem('read.beats') || '[]').length)) === 0);
await p2.goto(`${BASE}/#/book/${book.book_id}`); await p2.waitForSelector('button:has-text("Saved offline")'); await p2.click('button:has-text("Saved offline")'); await p2.waitForSelector('button:has-text("Keep offline")');
check('removing the saved copy', (await p2.evaluate(async () => (await (await caches.open('read-data-v1')).keys()).filter((r) => r.url.includes('/chapters/')).length)) === 0);
await F('/api/access/admin', { method: 'POST', body: JSON.stringify({ pin: PIN }) });
await F(`/api/books/${book.book_id}`, { method: 'DELETE' }); await F(`/api/admin/profiles/${pid}`, { method: 'DELETE' });
check('no page errors', errs.length === 0, errs);
await b.close(); console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
