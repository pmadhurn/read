// Delete safety net: bin + restore, restore from a device's cache, purge. Touches only its own profile and books.
import { createRequire } from 'node:module';
const require = createRequire((process.env.PLAYWRIGHT_DIR || '/home/ubuntu/spends-ledger') + '/');
const { chromium } = require('playwright');
const [BASE, PASSCODE, PIN] = process.argv.slice(2);
const results = []; const check = (n, ok, info = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', n, ok ? '' : JSON.stringify(info)); };
const b = await chromium.launch({ executablePath: process.env.CHROME || '/home/ubuntu/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome', args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } }); const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
const F = (path, opt = {}) => page.evaluate(async ([path, opt]) => { const r = await fetch(path, { ...opt, headers: { 'Content-Type': 'application/json', 'X-Profile-Id': localStorage.getItem('read.profile') || '', ...(opt.headers || {}) } }); return { status: r.status, body: await r.json().catch(() => null) }; }, [path, opt]);
const name = 'Rec' + Date.now().toString(36).slice(-5), title = 'Recovery Book ' + Date.now().toString(36).slice(-4);
await page.goto(BASE + '/'); await page.fill('#passcode', PASSCODE); await page.click('#go'); await page.waitForSelector('.picker');
await page.getByText('Add profile').click(); await page.fill('.modal input[type=text]', name); await page.click('.modal button[type=submit]'); await page.waitForSelector('.ring');
const pid = await page.evaluate(() => localStorage.getItem('read.profile'));
await F('/api/access/admin', { method: 'POST', body: JSON.stringify({ pin: PIN }) });
const cleanup = async () => { const l = (await F('/api/books')).body; for (const x of l.books) if (x.uploaded_by === Number(pid)) await F('/api/books/' + x.id, { method: 'DELETE' }); const t = (await F('/api/admin/trash')).body; for (const x of t.books) if (x.title.startsWith('Recovery Book')) await F(`/api/admin/books/${x.id}/purge`, { method: 'DELETE' }); await F('/api/admin/profiles/' + pid, { method: 'DELETE' }); };
try {
  const book = (await F('/api/books/paste', { method: 'POST', body: JSON.stringify({ title, author: 'Tester', text: ['Chapter 1', 'Chapter 2', 'Chapter 3'].map((c, i) => c + '\n\n' + `chapter ${i + 1} words for recovery. `.repeat(80)).join('\n\n') }) })).body;
  // device keeps it
  await page.goto(`${BASE}/#/book/${book.book_id}`); await page.waitForSelector('button:has-text("Keep offline")'); await page.click('button:has-text("Keep offline")'); await page.waitForSelector('button:has-text("Saved offline")');
  await page.goto(`${BASE}/#/read/${book.book_id}?c=1&w=7`); await page.waitForSelector('.context .w.cur'); await page.waitForTimeout(1200);
  // 1. soft delete keeps text, admin bin restores
  check('delete', (await F(`/api/books/${book.book_id}`, { method: 'DELETE' })).status === 200);
  check('gone from library', !(await F('/api/books')).body.books.some((x) => x.id === book.book_id));
  const bin = (await F('/api/admin/trash')).body.books.find((x) => x.id === book.book_id); check('in the bin, restorable', bin && bin.restorable, bin);
  check('restore from bin', (await F(`/api/admin/books/${book.book_id}/restore`, { method: 'POST' })).status === 200);
  const back = (await F(`/api/books/${book.book_id}`)).body; check('restored with chapters and progress', back.status === 'ready' && back.chapters.length === 3 && back.chapter_ord === 1 && back.word_index === 7, back);
  await page.goto(BASE + '/#/admin'); await page.waitForSelector('h1:has-text("Admin")'); check('admin shows Recently deleted section', (await page.locator('h2:has-text("Recently deleted")').count()) === 1);
  // 2. purge for good, then the device offers to restore it
  await F(`/api/books/${book.book_id}`, { method: 'DELETE' }); await F(`/api/admin/books/${book.book_id}/purge`, { method: 'DELETE' });
  check('purged: not restorable', (await F(`/api/admin/books/${book.book_id}/restore`, { method: 'POST' })).status === 410);
  await page.goto(BASE + '/#/library'); await page.waitForSelector('.notice.warn', { timeout: 10000 }).then(() => check('library offers device restore', true)).catch(() => check('library offers device restore', false));
  check('banner lists the book with chapter count', (await page.locator('.notice.warn').innerText()).includes('3 of 3 chapters'));
  await page.locator('.notice.warn button.primary').click(); await page.waitForTimeout(3000);
  const lib = (await F('/api/books')).body.books.find((x) => x.title === title); check('recovered book back in library', !!lib, lib);
  const det = lib && (await F(`/api/books/${lib.id}`)).body;
  check('recovered chapters intact', det && det.chapters.length === 3 && det.word_count > 600 && det.chapter_ord === 1 && det.word_index === 7, det && { n: det.chapters.length, wc: det.word_count, pos: [det.chapter_ord, det.word_index] });
  const ch = det && (await F(`/api/books/${lib.id}/chapters/2`)).body; check('chapter text preserved', ch && ch.text.includes('chapter 3 words for recovery'));
  check('no page errors', errs.length === 0, errs);
} finally { await cleanup(); }
await b.close(); console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
