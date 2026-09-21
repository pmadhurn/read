// Second browser pass: passcode rotation, dictionary, chunk mode, celebration, compare, offline.
import { createRequire } from 'node:module';
const require = createRequire('/home/ubuntu/spends-ledger/');
const { chromium } = require('playwright');
const [BASE, PASSCODE, PIN] = process.argv.slice(2);
const results = []; const check = (n, ok, info = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', n, ok ? '' : JSON.stringify(info)); };
const b = await chromium.launch({ executablePath: '/home/ubuntu/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome', args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } }); const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
const F = (path, opt = {}) => page.evaluate(async ([path, opt]) => { const r = await fetch(path, { ...opt, headers: { 'Content-Type': 'application/json', 'X-Profile-Id': localStorage.getItem('read.profile') || '', ...(opt.headers || {}) } }); return { status: r.status, body: await r.json().catch(() => null) }; }, [path, opt]);
await page.goto(BASE + '/'); await page.fill('#passcode', PASSCODE); await page.click('#go'); await page.waitForSelector('.picker');
for (const n of ['Asha', 'Rohan']) { await page.goto(BASE + '/#/profiles'); await page.waitForSelector('.picker'); await page.getByText('Add profile').click(); await page.fill('.modal input[type=text]', n); await page.click('.modal button[type=submit]'); await page.waitForSelector('.ring'); }
await F('/api/me', { method: 'PATCH', body: JSON.stringify({ goal_type: 'words', goal_value: 100, settings: { chunk: 3, wpm: 1000, ramp: false, focus: false } }) });
const book = (await F('/api/books/paste', { method: 'POST', body: JSON.stringify({ title: 'Chunky', text: 'Chapter 1\n\n' + 'The serendipity of reading quickly. '.repeat(200) }) })).body;
const d = await F('/api/dictionary/serendipity'); check('NV-9 dictionary definition', d.status === 200 && d.body.meanings.length > 0, d);
await page.goto(`${BASE}/#/read/${book.book_id}`); await page.waitForSelector('.context .w.cur'); await page.keyboard.press('Space'); await page.waitForTimeout(600);
const shownWords = await page.evaluate(() => document.querySelector('.word').textContent.trim().split(/\s+/).length);
check('RD-5 chunk mode shows up to 3 words', shownWords >= 2 && shownWords <= 3, shownWords);
await page.waitForSelector('.modal.celebrate, .reader', { timeout: 1000 }); await page.waitForTimeout(8000); await page.keyboard.press('Space');
await page.waitForSelector('.modal.celebrate', { timeout: 8000 }).then(() => check('GM-17 celebration pop-up after goal', true)).catch(() => check('GM-17 celebration pop-up after goal', false));
while (await page.locator('.modal.celebrate').count()) { await page.locator('.modal.celebrate button').click(); await page.waitForTimeout(250); }
await page.locator('.context .w').nth(5).click(); await page.waitForTimeout(300);
check('NV-4 tap a word jumps there', (await page.locator('.context .w.cur').getAttribute('data-i')) === (await page.locator('.context .w').nth(5).getAttribute('data-i')));
await page.keyboard.press('Escape'); await page.waitForSelector('.detail');
const ids = (await F('/api/profiles')).body.profiles.map((p) => p.id);
await page.goto(`${BASE}/#/compare/${ids[0]}/${ids[1]}`); await page.waitForSelector('table'); check('ST-6 compare page', (await page.locator('tbody tr').count()) >= 10);
await page.goto(BASE + '/#/'); await page.waitForSelector('.continue'); check('LB-4 continue reading row', true);
check('GM-14 feed on home', (await page.locator('.feed li').count()) >= 1);
// offline: shell + current book from the service worker cache
await page.goto(`${BASE}/#/read/${book.book_id}`); await page.waitForSelector('.context .w.cur'); await page.waitForTimeout(3500);
await page.evaluate(() => navigator.serviceWorker.ready); await page.reload(); await page.waitForSelector('.context .w.cur'); await page.waitForTimeout(1500);
await ctx.setOffline(true); await page.reload().catch(() => {});
await page.waitForSelector('.context .w.cur', { timeout: 10000 }).then(() => check('NF-9 current book opens offline', true)).catch(() => check('NF-9 current book opens offline', false));
await page.keyboard.press('Space'); await page.waitForTimeout(2500); await page.keyboard.press('Space');
const queued = await page.evaluate(() => JSON.parse(localStorage.getItem('read.beats') || '[]').length); check('NF-4 progress queued locally while offline', queued >= 1, queued);
await ctx.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); await page.waitForTimeout(2500);
check('NF-4 queue drained when back online', (await page.evaluate(() => JSON.parse(localStorage.getItem('read.beats') || '[]').length)) === 0);
// AC-9: rotate the passcode, the old cookie must stop working; then restore it
await F('/api/access/admin', { method: 'POST', body: JSON.stringify({ pin: PIN }) });
const rot = await F('/api/admin/secrets', { method: 'POST', body: JSON.stringify({ passcode: 'temporary-passcode-1' }) }); check('AD-4 passcode changed', rot.status === 200, rot);
check('AC-9 remembered device signed out', (await F('/api/books')).status === 401);
check('AC-9 old passcode rejected', (await F('/api/access/passcode', { method: 'POST', body: JSON.stringify({ passcode: PASSCODE }) })).status === 401);
await F('/api/access/passcode', { method: 'POST', body: JSON.stringify({ passcode: 'temporary-passcode-1' }) }); await F('/api/access/admin', { method: 'POST', body: JSON.stringify({ pin: PIN }) });
const back = await F('/api/admin/secrets', { method: 'POST', body: JSON.stringify({ passcode: PASSCODE }) }); check('passcode restored', back.status === 200);
await F('/api/access/passcode', { method: 'POST', body: JSON.stringify({ passcode: PASSCODE }) }); await F('/api/access/admin', { method: 'POST', body: JSON.stringify({ pin: PIN }) });
await F(`/api/books/${book.book_id}`, { method: 'DELETE' }); for (const id of ids) await F(`/api/admin/profiles/${id}`, { method: 'DELETE' });
check('no page errors', errs.length === 0, errs);
await b.close(); console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
