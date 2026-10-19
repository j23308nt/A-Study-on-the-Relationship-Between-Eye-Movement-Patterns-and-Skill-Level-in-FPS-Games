const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const F = require('./study-fixtures.cjs');
const file = data => ({ name: `${data.metadata.run_id}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });
(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [], writes = [], artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-replay-ui-'));
  page.on('pageerror', e => errors.push(e.message)); page.on('request', r => { if (r.method() !== 'GET') writes.push(r.url()); });
  const seek = value => page.locator('#studyReplaySeek').evaluate((e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, String(value));
  try {
    await page.goto(new URL('study-analysis.html', process.env.VALIDATION_URL || 'http://localhost:8000/').href);
    const b = F.aim({ id: 'cursor-replay' }); b.metadata.cursor_recording = { version: 1 };
    b.cursor = [
      { time_ms: 900, x: 150, y: 250, trial_id: null },
      { time_ms: 1000, x: 200, y: 300, trial_id: 1 },
      { time_ms: 1020, x: 210, y: 310, trial_id: 1 },
      { time_ms: 1100, x: b.trials[0].target_x, y: b.trials[0].target_y, trial_id: 1 }
    ].map((p, i) => ({ ...p, sample_id: i + 1, elapsed_ms: p.time_ms, event_timestamp_ms: p.time_ms, buttons: i === 3 ? 1 : 0, sample_kind: i === 3 ? 'button_down' : 'move' }));
    await page.locator('#studyFiles').setInputFiles([b, F.aim({ id: 'legacy' }), F.validation()].map(file));
    await page.waitForFunction(() => document.querySelectorAll('#studyRunRows tr').length === 3);
    await page.locator('#studyDetailSelect').selectOption('cursor-replay');
    assert(await page.locator('#studyReplay').isVisible());
    await seek(1059); assert.equal(await page.locator('.replay-gaze').count(), 0);
    await seek(1060); assert.equal(await page.locator('.replay-gaze').getAttribute('cx'), '100');
    assert.equal(await page.locator('.replay-target').count(), 1);
    assert.equal(await page.locator('.replay-cursor').count(), 1);
    await page.locator('#studyReplayRaw').check(); assert.equal(await page.locator('.replay-gaze').getAttribute('cx'), '98');
    await page.locator('#studyReplayGaze').uncheck(); assert.equal(await page.locator('.replay-gaze').count(), 0);
    await page.locator('#studyReplayGaze').check(); await page.locator('#studyReplayRaw').uncheck();
    await page.locator('#studyReplayCursor').uncheck(); assert.equal(await page.locator('.replay-cursor').count(), 0);
    await page.locator('#studyReplayCursor').check();
    await seek(1100); assert.equal(await page.locator('.replay-click').count(), 1); assert.equal(await page.locator('.replay-target').count(), 0);
    await seek(1261); assert.equal(await page.locator('.replay-gaze').count(), 0);
    assert((await page.locator('#studyReplayReadout').innerText()).includes('取得空白'));
    await page.locator('#studyReplayScope').selectOption('2');
    assert.equal(await page.locator('#studyReplaySeek').getAttribute('max'), '300');
    assert((await page.locator('#studyReplayTime').innerText()).includes('5.000'));
    await page.locator('#studyReplayNext').click(); assert.equal(await page.locator('#studyReplaySeek').inputValue(), '100');
    await page.locator('#studyReplayBack').click(); assert.equal(await page.locator('#studyReplaySeek').inputValue(), '0');
    await page.locator('#studyReplaySpeed').selectOption('4'); await page.locator('#studyReplayPlay').click();
    await page.waitForFunction(() => document.getElementById('studyReplaySeek').value === '300');
    assert.equal(await page.locator('#studyReplayPlay').getAttribute('aria-pressed'), 'false');
    await page.locator('#studyReplayScope').selectOption('all'); await page.locator('#studyReplayPlay').click();
    await page.waitForFunction(() => Number(document.getElementById('studyReplaySeek').value) > 100);
    await page.locator('#studyReplayPlay').click(); assert.equal(await page.locator('#studyReplayPlay').getAttribute('aria-pressed'), 'false');
    const paused = await page.locator('#studyReplaySeek').inputValue();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#studyReplaySeek').inputValue(), paused);
    await page.locator('#studyReplayReset').click(); assert.equal(await page.locator('#studyReplaySeek').inputValue(), '0');
    await seek(1060); await page.locator('#studyReplay').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifacts, 'replay.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#studyReplay').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifacts, 'mobile.png') });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.locator('#studyDetailSelect').selectOption('legacy');
    assert(await page.locator('#studyReplayCursor').isDisabled());
    assert((await page.locator('#studyReplayLegacy').innerText()).includes('マウス移動がありません'));
    await seek(1100); assert.equal(await page.locator('.replay-cursor').count(), 0); assert.equal(await page.locator('.replay-click').count(), 1);
    await page.locator('#studyReplayPlay').click();
    await page.locator('#studyDetailSelect').selectOption('validation-1');
    assert.equal(await page.locator('#studyReplay').isVisible(), false);
    assert.equal(await page.locator('#studyReplayPlay').getAttribute('aria-pressed'), 'false');
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    console.log(JSON.stringify({ result: 'PASS', artifacts, checks: ['timestamp alignment', 'raw/visibility toggles', 'clicks', 'missing gaze', 'scope', 'play/pause/speed/end', 'seek/step/reset', 'legacy', 'switch stops playback', 'mobile', 'no uploads'] }));
  } catch (e) { await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {}); console.error('Artifacts:', artifacts); throw e; }
  finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
