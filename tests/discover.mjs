// Browser check of the Find online page. Read-only: uses an existing profile, adds nothing.
import { createRequire } from 'node:module';
const require = createRequire('/home/ubuntu/spends-ledger/');
const { chromium } = require('playwright');
const [BASE, PASSCODE, OUT = '/tmp'] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/home/ubuntu/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome', args: ['--no-sandbox'] });
const page = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/404|401/.test(m.text())) errs.push(m.text()); });
await page.goto(BASE + '/'); await page.fill('#passcode', PASSCODE); await page.click('#go'); await page.waitForSelector('.picker');
await page.locator('.picker-card').first().click(); await page.waitForSelector('.topbar');
await page.goto(BASE + '/#/library'); await page.locator('a', { hasText: 'Find online' }).click(); await page.waitForSelector('h1:has-text("Find books online")');
await page.fill('input[type=search]', 'pride and prejudice'); await page.keyboard.press('Enter'); await page.waitForSelector('.find', { timeout: 60000 });
await page.waitForTimeout(20000);
const n = await page.locator('.find').count(), covers = await page.locator('.find img').evaluateAll((els) => els.filter((e) => e.naturalWidth > 0).length);
console.log('results', n, 'covers loaded', covers); await page.screenshot({ path: `${OUT}/discover.png` });
await page.setViewportSize({ width: 360, height: 740 }); await page.waitForTimeout(500);
const over = await page.evaluate(() => Math.max(...[...document.querySelectorAll('#view *')].map((e) => Math.round(e.getBoundingClientRect().right - window.innerWidth))));
console.log('overflow at 360px', over, 'errors', JSON.stringify(errs)); await page.screenshot({ path: `${OUT}/discover-m.png` });
await b.close();
