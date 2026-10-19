const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined,
    args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'pistol-range-'));
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
    page.on('pageerror', error => console.error(error.message));
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    await page.goto(process.env.GAME_URL || 'http://127.0.0.1:8766/');
    await page.locator('#game[data-ready="true"]').waitFor({ state: 'attached', timeout: 10000 });
    await page.clock.runFor(32);
    await page.screenshot({ path: path.join(folder, 'idle.png') });
    await page.locator('#start').click({ force: true });
    await page.waitForFunction(() => document.querySelector('#overlay').hidden);
    await page.clock.runFor(32);
    await page.mouse.click(720, 450);
    await page.clock.runFor(16);
    assert.equal(await page.locator('#hits').innerText(), '1');
    assert.equal(await page.locator('#accuracy').innerText(), '100%');
    await page.clock.runFor(200);
    await page.mouse.click(720, 450);
    assert.equal(await page.locator('#hits').innerText(), '1');
    assert.equal(await page.locator('#accuracy').innerText(), '50%');
    await page.screenshot({ path: path.join(folder, 'playing.png') });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#overlay').hidden);
    assert.equal(await page.locator('#start').innerText(), '再開');
    const before = await page.locator('#time').innerText();
    await page.clock.fastForward(10000);
    await page.clock.runFor(32);
    assert.equal(await page.locator('#time').innerText(), before);
    await page.locator('#start').click({ force: true });
    await page.waitForFunction(() => document.querySelector('#overlay').hidden);
    assert.equal(await page.locator('#hits').innerText(), '1');
    await page.clock.fastForward(60000);
    await page.clock.runFor(32);
    assert.equal(await page.locator('#time').innerText(), '0');
    assert.equal(await page.locator('#start').innerText(), 'もう一度');
    await page.locator('#start').click({ force: true });
    await page.waitForFunction(() => document.querySelector('#overlay').hidden);
    assert.equal(await page.locator('#hits').innerText(), '0');
    assert.equal(await page.locator('#accuracy').innerText(), '—');
    // Embedded-browser fallback works even if pointer lock is unavailable.
    await page.keyboard.press('Escape');
    await page.evaluate(() => { document.querySelector('#game').requestPointerLock = () => Promise.reject(new Error('Not supported')); });
    await page.locator('#start').click({ force: true });
    await page.waitForFunction(() => document.querySelector('#overlay').hidden);
    await page.mouse.move(800, 480);
    await page.clock.runFor(32);
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.clock.runFor(32);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(folder, 'mobile.png') });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, screenshots: folder,
      checks: ['WebGL', 'hit and respawn', 'miss', 'accuracy', 'pause/resume', '60-second finish', 'restart', 'pointer-lock fallback', 'resize'] }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
