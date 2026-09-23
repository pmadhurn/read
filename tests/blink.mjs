// Blink aids: trail line, blink break at a sentence end, replay-sentence while playing. Own profile and book only.
import { createRequire } from 'node:module';
const require = createRequire((process.env.PLAYWRIGHT_DIR || '/home/ubuntu/spends-ledger') + '/');
const { chromium } = require('playwright');
const [BASE, PASSCODE, PIN, OUT = '/tmp'] = process.argv.slice(2);
const results = []; const check = (n, ok, info = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', n, ok ? '' : JSON.stringify(info)); };
const b = await chromium.launch({ executablePath: process.env.CHROME || '/home/ubuntu/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome', args: ['--no-sandbox'] });
const page = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
const F = (path, opt = {}) => page.evaluate(async ([path, opt]) => { const r = await fetch(path, { ...opt, headers: { 'Content-Type': 'application/json', 'X-Profile-Id': localStorage.getItem('read.profile') || '', ...(opt.headers || {}) } }); return { status: r.status, body: await r.json().catch(() => null) }; }, [path, opt]);
await page.goto(BASE + '/'); await page.fill('#passcode', PASSCODE); await page.click('#go'); await page.waitForSelector('.picker');
await page.getByText('Add profile').click(); await page.fill('.modal input[type=text]', 'Blink' + Date.now().toString(36).slice(-5)); await page.click('.modal button[type=submit]'); await page.waitForSelector('.ring');
const pid = await page.evaluate(() => localStorage.getItem('read.profile'));
try {
  await F('/api/me', { method: 'PATCH', body: JSON.stringify({ settings: { wpm: 400, ramp: false, focus: false, blink_break: 5, blink_len: 1200 } }) });
  const sentence = 'One two three four five six seven eight. ';
  const book = (await F('/api/books/paste', { method: 'POST', body: JSON.stringify({ title: 'Blink ' + Date.now().toString(36).slice(-4), text: 'Chapter 1\n\n' + sentence.repeat(300) }) })).body;
  await page.goto(`${BASE}/#/read/${book.book_id}`); await page.waitForSelector('.context .w.cur');
  await page.keyboard.press('Space'); await page.waitForTimeout(2000);
  const trail = await page.locator('.rsvp .trail').innerText(); check('trail shows the last words', trail.split(' ').length >= 3 && !(await page.locator('.rsvp .trail').isHidden()), trail);
  await page.screenshot({ path: `${OUT}/blink-trail.png` });
  // breath: poll for the class within the next 8 s
  let saw = false; const t0 = Date.now(); while (Date.now() - t0 < 8000) { if (await page.evaluate(() => document.querySelector('.rsvp').classList.contains('breath'))) { saw = true; break; } await page.waitForTimeout(15); }
  check('blink break dims the word at a sentence end', saw);
  if (saw) { await page.waitForTimeout(500); await page.screenshot({ path: `${OUT}/blink-breath.png` }); }
  check('countdown line visible during the break', saw && await page.evaluate(() => getComputedStyle(document.querySelector('.breath-bar')).opacity === '1'));
  const held = await page.evaluate(async () => { const t0 = performance.now(); while (document.querySelector('.rsvp').classList.contains('breath') && performance.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 10)); return performance.now() - t0; });
  check('break lasts about the set length', held > 500 && held < 1300, held);
  await page.evaluate(() => { window.__readerTiming.length = 0; });   // screenshots above stall the renderer
  await page.keyboard.press(']'); await page.keyboard.press('+'); await page.waitForTimeout(100);
  check('] and + speed up', (await page.locator('.speed output').innerText()) === '450 WPM');
  await page.keyboard.press('['); await page.keyboard.press('-'); await page.waitForTimeout(100);
  check('[ and - slow down', (await page.locator('.speed output').innerText()) === '400 WPM');
  // replay while playing
  const before = await page.evaluate(() => Number(document.querySelector('.reader') && window.__readerTiming.length));
  const idxBefore = await page.evaluate(() => document.querySelector('.rsvp .word').textContent);
  await page.waitForTimeout(700);
  await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(50);
  const afterWord = await page.evaluate(() => document.querySelector('.rsvp .word').textContent.trim());
  check('Left while playing replays from the sentence start', afterWord === 'One' || afterWord === 'One', afterWord);
  check('still playing after replay', await page.evaluate(() => document.querySelector('.play').getAttribute('aria-label') === 'Pause'));
  await page.waitForTimeout(3000); await page.keyboard.press('Space'); await page.waitForTimeout(1500);
  const t = await page.evaluate(() => { const a = [...window.__readerTiming].sort((x, y) => x - y); return { n: a.length, mean: a.reduce((x, y) => x + y, 0) / a.length, p99: a[Math.floor(a.length * .99)] }; });
  check('timing still tight with breaks', t.mean < 2 && t.p99 < 20, t);
  const me = (await F('/api/me')).body; check('words counted (replay not double-counted)', me.today.words > 20 && me.today.words <= 90, me.today.words);
  await page.keyboard.press('?'); await page.waitForSelector('.panel .keys'); check('settings panel lists the shortcuts', (await page.locator('.panel .keys kbd').count()) > 10);
  check('no page errors', errs.length === 0, errs);
} finally {
  await F('/api/access/admin', { method: 'POST', body: JSON.stringify({ pin: PIN }) });
  const l = (await F('/api/books')).body; for (const x of l.books) if (x.uploaded_by === Number(pid)) { await F('/api/books/' + x.id, { method: 'DELETE' }); await F(`/api/admin/books/${x.id}/purge`, { method: 'DELETE' }); }
  await F('/api/admin/profiles/' + pid, { method: 'DELETE' });
}
await b.close(); console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
