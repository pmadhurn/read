// Tap-target audit at 360px: every interactive element must be at least 24x24 CSS px.
import { createRequire } from 'node:module';
const require = createRequire('/home/ubuntu/spends-ledger/');
const { chromium } = require('playwright');
const [BASE, PASSCODE, PIN] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/home/ubuntu/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome', args: ['--no-sandbox'] });
const page = await (await b.newContext({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true })).newPage();
await page.goto(BASE + '/'); await page.fill('#passcode', PASSCODE); await page.click('#go'); await page.waitForSelector('.picker');
await page.getByText('Add profile').click(); await page.fill('.modal input[type=text]', 'Tap' + Date.now().toString(36).slice(-5)); await page.click('.modal button[type=submit]'); await page.waitForSelector('.ring');
const r = await page.evaluate(async () => (await fetch('/api/books/paste', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Profile-Id': localStorage.getItem('read.profile') }, body: JSON.stringify({ title: 'Tap book', text: 'Chapter 1\n\n' + 'hello there world. '.repeat(400) }) })).json());
let bad = 0;
for (const hash of ['#/', '#/library', `#/book/${r.book_id}`, `#/read/${r.book_id}`, '#/upload', '#/ranks', '#/stats', '#/badges', '#/settings', '#/profiles']) {
  await page.goto(BASE + '/' + hash); await page.waitForTimeout(1200);
  const small = await page.evaluate(() => [...document.querySelectorAll('a, button, input, select, textarea, [tabindex="0"]')].filter((e) => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return r.width > 0 && st.visibility !== 'hidden' && !e.classList.contains('sr') && !e.closest('.chart') && (r.width < 24 || r.height < 24) && !(e.tagName === 'A' && e.closest('.rank')); }).map((e) => `${e.tagName}.${e.className} "${(e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 24)}" ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`));
  bad += small.length; console.log(hash, small.length ? small : 'ok');
}
await page.evaluate(async ([bid, PIN]) => { const hd = { 'Content-Type': 'application/json', 'X-Profile-Id': localStorage.getItem('read.profile') }; await fetch('/api/access/admin', { method: 'POST', headers: hd, body: JSON.stringify({ pin: PIN }) }); await fetch('/api/books/' + bid, { method: 'DELETE', headers: hd }); await fetch('/api/admin/profiles/' + hd['X-Profile-Id'], { method: 'DELETE', headers: hd }); }, [r.book_id, PIN]);
await b.close(); process.exit(bad ? 1 : 0);
