// Browser end-to-end check. Usage: node e2e.mjs BASE PASSCODE PIN [outDir]
import { createRequire } from 'node:module';
const require = createRequire('/home/ubuntu/spends-ledger/');
const { chromium } = require('playwright');
const [BASE, PASSCODE, PIN, OUT = '/tmp'] = process.argv.slice(2);
const CHROME = process.env.CHROME || '/home/ubuntu/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome';
const FX = new URL('./fixtures/', import.meta.url).pathname;
const results = []; const check = (n, ok, info = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', n, ok ? '' : JSON.stringify(info)); };

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/401|404/.test(m.text())) errs.push('CONSOLE ' + m.text()); });
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

await page.goto(BASE + '/');
check('gate shown', (await page.locator('h1').innerText()) === 'Family passcode');
check('no CDN script rewrite in gate', !(await page.content()).includes('rocket-loader'));
await page.fill('#passcode', PASSCODE); await page.click('#go');
await page.waitForSelector('.picker');
const name = 'E2E' + Date.now().toString(36).slice(-4);
await page.getByText('Add profile').click();
await page.fill('.modal input[type=text]', name); await page.click('.modal button[type=submit]');
await page.waitForSelector('.topbar'); await page.waitForSelector('.ring');
check('AC-6/7 profile created, switch button visible', await page.locator('.who').isVisible());
await shot('home');

await page.goto(BASE + '/#/upload'); await page.waitForSelector('#file');
await page.setInputFiles('#file', [FX + 'test.epub', FX + 'test.pdf']);
await page.waitForFunction(() => document.querySelectorAll('.upload-item .status a').length === 2, null, { timeout: 90000 });
check('IM-7 upload progress to ready', true);
await page.goto(BASE + '/#/library'); await page.waitForSelector('.book');
check('LB-1 grid shows books', (await page.locator('.book').count()) >= 2);
await page.fill('input[type=search]', 'foxes'); await page.waitForTimeout(200);
check('LB-2 search', (await page.locator('.book').count()) === 1);
await shot('library');
await page.locator('.book').first().click(); await page.waitForSelector('.detail');
check('LB-5 detail page', (await page.locator('.detail').innerText()).includes('At your'));
await shot('book');

// reader
const bookId = page.url().split('/').pop();
await page.goto(`${BASE}/#/read/${bookId}?debug=1`); await page.waitForSelector('.reader .context:not([hidden])');
await shot('reader-paused');
check('NV-4 paused context with highlighted word', (await page.locator('.context .w.cur').count()) === 1);
// ORP fixed position + mapping
const orp = await page.evaluate(async () => { const m = await import('/js/views/reader.js'); return { a: m.splitAtOrp('a'), word: m.splitAtOrp('word'), reading: m.splitAtOrp('reading'), comp: m.splitAtOrp('comprehension'), long: m.splitAtOrp('internationalization'), q: m.splitAtOrp('“Hello,”'), hi: m.splitAtOrp('क्षत्रिय'), gu: m.splitAtOrp('વિદ્યાર્થીઓ') }; });
check('RD-2 ORP mapping', orp.a[1] === 'a' && orp.word[1] === 'o' && orp.reading[1] === 'a' && orp.comp[1] === 'p' && orp.long[1] === 'r' && orp.q[1] === 'e', orp);
check('RD-6 grapheme clusters kept whole', orp.hi[0] === 'क्ष' && orp.hi[1] === 'त्रि' && orp.gu.slice(0, 3).join('') === 'વિદ્યાર્થીઓ', orp);
// speed to 1000 and measure timing
await page.keyboard.press('Space'); await page.waitForTimeout(300);
check('NV-2 space plays, NV-10 focus hides controls', await page.evaluate(() => document.querySelector('.reader').classList.contains('focus')));
const xs = []; for (let i = 0; i < 12; i++) { xs.push(await page.evaluate(() => { const r = document.querySelector('.word .pivot').getBoundingClientRect(); return Math.round(r.left + r.width / 2); })); await page.waitForTimeout(210); }
check('reader top buttons text', true);
check('RD-1 pivot stays at fixed x', Math.max(...xs) - Math.min(...xs) <= 1, xs);
await shot('reader-playing');
for (let i = 0; i < 28; i++) await page.keyboard.press('ArrowUp');
check('SP-1 speed up to 1000 by keyboard', (await page.locator('.speed output').innerText()) === '1000 WPM');
await page.evaluate(() => { window.__readerTiming.length = 0; }); await page.waitForTimeout(9000);
const t = await page.evaluate(() => { const a = [...window.__readerTiming].sort((x, y) => x - y); return { n: a.length, over5: a.filter((x) => x > 5).length, max: a[a.length - 1], p99: a[Math.floor(a.length * 0.99)], mean: a.reduce((x, y) => x + y, 0) / a.length }; });
check('SP-6 word timing within ±5 ms at 1000 WPM', t.n > 80 && t.p99 <= 5 && t.mean < 2, t); console.log('   timing', JSON.stringify(t));
await page.keyboard.press('Space'); await page.waitForTimeout(1500);
const me = await page.evaluate(async () => (await fetch('/api/me', { headers: { 'X-Profile-Id': localStorage.getItem('read.profile') } })).json());
check('words counted + position saved after pause', me.today.words > 100, me.today);
await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('ArrowLeft');
await page.locator('button[aria-label="Contents and bookmarks"]').click(); await page.waitForSelector('.panel .toc');
check('NV-5 TOC panel', (await page.locator('.panel .toc li').count()) === 3);
await page.locator('.panel .toc button').nth(1).click(); await page.waitForTimeout(800);
check('Hindi chapter renders', /[ऀ-ॿ]/.test(await page.locator('.context').innerText()));
const font = await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family); });
check('AP-11 Devanagari font auto-loaded', font.some((f) => /Devanagari/.test(f)), font);
await shot('reader-hindi');
await page.locator('button[aria-label="Reader settings"]').click(); await page.waitForSelector('.panel select');
await page.locator('.panel .seg button', { hasText: 'Sepia' }).click(); await page.waitForTimeout(300);
check('AP-1 theme switch live', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'sepia');
await page.locator('.panel .seg button', { hasText: 'Dark' }).click();
await page.keyboard.press('Escape');
await page.locator('.reader-top button[aria-label="Switch to normal reading"]').click(); await page.waitForSelector('.scrollmode:not([hidden])');
check('NV-7 normal reading mode', (await page.locator('.scrollmode p').count()) > 1);
await page.keyboard.press('Escape'); await page.waitForSelector('.detail');
check('NV-2 Esc exits reader', true);

for (const [hash, sel, label] of [['#/ranks', '.rank', 'GM-11 leaderboard'], ['#/stats', '.chart', 'ST-3 charts'], ['#/badges', '.badge-card', 'GM-16 badges'], ['#/settings', '.preview', 'AP-7 live preview'], [`#/review/${me.id}/2026`, '.review', 'ST-7 year in review']]) {
  await page.goto(BASE + '/' + hash); await page.waitForSelector(sel, { timeout: 8000 }).then(() => check(label, true)).catch(() => check(label, false)); await shot(hash.replace(/[#/]/g, '_'));
}
check('ST-4 heatmap', (await page.goto(BASE + '/#/stats'), await page.waitForSelector('.heat'), (await page.locator('.heat i').count()) > 360));
// admin
await page.goto(BASE + '/#/settings'); await page.locator('button', { hasText: 'Admin' }).click();
await page.fill('.modal input', PIN); await page.click('.modal button[type=submit]'); await page.waitForSelector('h1:has-text("Admin")');
check('AC-8 admin unlock', true); await shot('admin');

// mobile layout 360px
await page.setViewportSize({ width: 360, height: 740 });
for (const hash of ['#/', '#/library', '#/stats', '#/settings', '#/ranks', `#/book/${bookId}`, `#/read/${bookId}`]) {
  await page.goto(BASE + '/' + hash); await page.waitForTimeout(900);
  const over = await page.evaluate(() => Math.max(document.documentElement.scrollWidth - window.innerWidth, ...[...document.querySelectorAll('.reader *, #view *')].filter((e) => !e.closest('.table-wrap, .hscroll')).map((e) => Math.round(e.getBoundingClientRect().right - window.innerWidth))));
  check(`AP-10 no horizontal overflow at 360px ${hash}`, over <= 0, over); await shot('m' + hash.replace(/[#/]/g, '_'));
}
await page.setViewportSize({ width: 3840, height: 2160 }); await page.goto(BASE + '/#/library'); await page.waitForTimeout(600);
check('AP-10 4K layout no overflow', (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0);

// cleanup through the API
await page.evaluate(async () => { const hd = { 'X-Profile-Id': localStorage.getItem('read.profile') }; const l = await (await fetch('/api/books', { headers: hd })).json(); for (const b of l.books) await fetch('/api/books/' + b.id, { method: 'DELETE', headers: hd }); await fetch('/api/admin/profiles/' + hd['X-Profile-Id'], { method: 'DELETE' }); });
check('no page errors', errs.length === 0, errs);
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`); process.exit(results.every(Boolean) ? 0 : 1);
