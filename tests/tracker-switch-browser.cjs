// Synthetic camera and neural features; all writes blocked. Real model is covered separately.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const F = require('./study-fixtures.cjs');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [], writes = [], artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-switch-'));
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.route('**/save-*', route => { writes.push(route.request().url()); return route.abort(); });
    await page.route('**/mediapipe/face_mesh/face_mesh.js', route => route.fulfill({ contentType: 'text/javascript', body: `
      window.FaceMesh = class {
        setOptions(){} async initialize(){} onResults(f){this.f=f;}
        async send(){
          const g=window.__gaze||{x:.5,y:.5}, l=Array.from({length:478},()=>({x:.5,y:.5,z:0}));
          const p=(i,x,y)=>l[i]={x,y,z:0};
          p(10,.5,.2);p(152,.5,.8);p(1,.5,.5);
          p(33,.25,.4);p(133,.45,.4);p(159,.35,.36);p(145,.35,.44);
          p(362,.55,.4);p(263,.75,.4);p(386,.65,.36);p(374,.65,.44);
          for(let i=468;i<=472;i++)p(i,.35+(g.x-.5)*.16,.4+(g.y-.5)*.06);
          for(let i=473;i<=477;i++)p(i,.65+(g.x-.5)*.16,.4+(g.y-.5)*.06);
          this.f({multiFaceLandmarks:window.__missing?[]:[l]});
        }
      };` }));
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => new MediaStream();
      HTMLVideoElement.prototype.play = async () => {};
      for (const [name, get] of Object.entries({ readyState: () => 4, videoWidth: () => 640, videoHeight: () => 480,
        currentTime: () => Math.floor(performance.now() / 33) / 30 })) Object.defineProperty(HTMLVideoElement.prototype, name, { get, configurable: true });
      HTMLVideoElement.prototype.requestVideoFrameCallback = function (fn) {
        return requestAnimationFrame(now => fn(now, { mediaTime: Math.floor(performance.now() / 33) / 30, presentedFrames: Math.floor(performance.now() / 33) }));
      };
      HTMLVideoElement.prototype.cancelVideoFrameCallback = id => cancelAnimationFrame(id);
    });
    await page.clock.install(); await page.clock.pauseAt(new Date(Date.now() + 1000));
    await page.goto(process.env.VALIDATION_URL || 'http://localhost:8000/');
    await require('./tracker-mocks.cjs').mockNeural(page);
    await page.locator('#startBtn').click(); await page.clock.runFor(300);
    async function calibrate() {
      await page.evaluate(() => trackerBridge.prepare());
      assert.equal(await page.locator('#trackerEngine').isDisabled(), true);
      // A scripted event must not bypass the disabled control.
      const engine = await page.locator('#trackerEngine').inputValue();
      await page.evaluate(() => { const e = document.getElementById('trackerEngine'); e.value = e.value === 'gazefollower2' ? 'mediapipe-ridge' : 'gazefollower2'; e.dispatchEvent(new Event('change')); });
      assert.equal(await page.locator('#trackerEngine').inputValue(), engine);
      for (const id of [1, 2, 3, 4, 6, 7, 8, 9, 5]) {
        await page.evaluate(id => { const p = document.getElementById('Pt' + id); window.__gaze = { x: parseFloat(p.style.left) / 100, y: parseFloat(p.style.top) / 100 }; }, id);
        await page.clock.runFor(350); await page.locator('#Pt' + id).click();
        for (let n = 0; n < 60 && !await page.locator('#Pt' + id).evaluate(e => e.classList.contains('is-complete')); n++) await page.clock.runFor(100);
        assert.equal(await page.locator('#Pt' + id).evaluate(e => e.classList.contains('is-complete')), true);
      }
      await page.clock.runFor(5300);
      assert.equal(await page.evaluate(() => trackerBridge.status().ready), true);
      return page.evaluate(() => { const s = trackerBridge.acquire(); trackerBridge.release(); return s; });
    }
    const current = await calibrate(); assert.equal(current.engine.id, 'mediapipe-ridge');
    await page.evaluate(() => trackerBridge.acquire());
    assert.equal(await page.locator('#trackerEngine').isDisabled(), true);
    await page.evaluate(() => trackerBridge.release());
    assert.equal(await page.locator('#trackerEngine').isEnabled(), true);
    await page.locator('#trackerEngine').selectOption('gazefollower2'); await page.clock.runFor(100);
    assert.equal(await page.evaluate(() => trackerBridge.status().ready), false);
    assert.equal(await page.evaluate(() => { try { trackerBridge.acquire(); return false; } catch { return true; } }), true);
    const neural = await calibrate();
    assert.equal(neural.engine.id, 'gazefollower2'); assert.equal(neural.regression.x.length, 259);
    assert.equal(neural.calibration_samples.length, 45);
    assert.equal(new Set(neural.calibration_samples.flatMap(s => s.source_frame_ids)).size, 360);
    await page.evaluate(() => { window.__frames = []; addEventListener('gaze-frame', e => __frames.push(e.detail)); });
    await page.clock.runFor(300);
    assert((await page.evaluate(() => __frames)).every(f => f.tracker_engine === 'gazefollower2'));
    // Runtime failure does not silently use the old engine or preserve its calibration.
    await page.locator('#trackerEngine').selectOption('mediapipe-ridge'); await page.clock.runFor(100);
    await page.evaluate(() => { GazeBackends.NeuralFeatures.prototype.init = async () => { throw Error('Synthetic model unavailable'); }; });
    await page.locator('#trackerEngine').selectOption('gazefollower2'); await page.clock.runFor(100);
    assert.equal(await page.evaluate(() => trackerBridge.status().ready), false);
    assert.equal(await page.evaluate(() => trackerBridge.status().engine), 'gazefollower2');
    assert.equal(await page.locator('#statusText').innerText(), '方式の準備に失敗');
    await page.locator('#trackerEngine').selectOption('mediapipe-ridge'); await page.clock.runFor(100);
    assert.equal(await page.evaluate(() => trackerBridge.status().paused), false);
    assert.equal(await page.locator('#calibrateBtn').isEnabled(), true);
    await page.screenshot({ path: path.join(artifacts, 'selector-desktop.png') });
    // Same participant/session may be shown for both engines, but never pooled together.
    const a = F.validation(), b = F.validation({ id: 'other-engine', offset: 40 });
    a.metadata.tracker.engine = current.engine; b.metadata.tracker.engine = neural.engine;
    await page.locator('#validationResultsBtn').click();
    await page.locator('#validationCompareInput').setInputFiles([a, b].map((v, i) => ({ name: `${i}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(v)) })));
    await page.waitForFunction(() => document.querySelectorAll('#validationCompareRows tr').length === 2);
    const text = await page.locator('#validationCompareStatus').innerText();
    assert(text.includes('現行方式')); assert(text.includes('GazeFollower2')); assert(!text.includes('同じ回の複数実行'));
    assert.equal(await page.locator('#validationCompareRows tr').nth(0).locator('td').nth(1).innerText(), '現行方式');
    assert.equal(await page.locator('#validationCompareRows tr').nth(1).locator('td').nth(1).innerText(), 'GazeFollower2');
    await page.screenshot({ path: path.join(artifacts, 'comparison.png') });
    await page.keyboard.press('Escape'); await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#trackerEngine').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifacts, 'selector-mobile.png') });
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    console.log(JSON.stringify({ ok: true, checks: ['switch invalidates calibration', 'locked during calibration/acquire', '259-D shared calibration', 'failure recovery', 'per-engine comparison'], artifacts }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
