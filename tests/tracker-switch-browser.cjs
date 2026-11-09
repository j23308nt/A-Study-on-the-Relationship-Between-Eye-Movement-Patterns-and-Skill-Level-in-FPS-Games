// Synthetic camera and neural features; all writes blocked. Real model is covered separately.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const F = require('./study-fixtures.cjs');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [], writes = [], savedCsv = [], artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-switch-'));
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.route('**/save-*', route => { writes.push(route.request().url()); return route.abort(); });
    await page.route('**/save-csv', route => {
      savedCsv.push(route.request().postDataJSON());
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, path: 'synthetic-test-only' }) });
    });
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
      window.__devices = [
        { kind: 'videoinput', deviceId: 'internal-test-id', label: 'Built-in Camera' },
        { kind: 'videoinput', deviceId: 'usb-test-private-id', label: 'USB Webcam' }
      ];
      navigator.mediaDevices.enumerateDevices = async () => window.__devices;
      navigator.mediaDevices.getUserMedia = async constraints => {
        window.__lastCameraConstraints = constraints;
        const id = constraints.video.deviceId?.exact || 'internal-test-id';
        const device = window.__devices.find(d => d.deviceId === id);
        if (!device) throw new DOMException('Synthetic missing camera', 'OverconstrainedError');
        const stream = new MediaStream(), track = new EventTarget();
        track.label = device.label; track.readyState = 'live';
        track.getSettings = () => ({ deviceId: id, groupId: 'private-group-test', width: 1280, height: 720, frameRate: 30 });
        track.stop = () => { track.readyState = 'ended'; };
        stream.getTracks = stream.getVideoTracks = () => [track];
        window.__cameraTrack = track; window.__cameraRequests = (window.__cameraRequests || 0) + 1;
        return stream;
      };
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
      assert.equal(await page.locator('#cameraSelect').isDisabled(), true);
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
    // Explicit USB selection stops the old camera and requires fresh calibration.
    await page.locator('#cameraSelect').selectOption('usb-test-private-id'); await page.clock.runFor(100);
    assert.equal(await page.evaluate(() => trackerBridge.status().running), false);
    assert.equal(await page.evaluate(() => trackerBridge.status().ready), false);
    await page.locator('#startBtn').click(); await page.clock.runFor(300);
    assert.equal(await page.evaluate(() => __lastCameraConstraints.video.deviceId.exact), 'usb-test-private-id');
    assert((await page.locator('#cameraStatus').innerText()).includes('USB Webcam'));
    const usb = await calibrate();
    assert.equal(usb.camera_label, 'USB Webcam');
    assert(!JSON.stringify(usb).includes('usb-test-private-id')); assert(!JSON.stringify(usb).includes('private-group-test'));
    await page.evaluate(() => trackerBridge.acquire());
    assert.equal(await page.locator('#cameraSelect').isDisabled(), true);
    await page.evaluate(() => { const s = document.getElementById('cameraSelect'); s.value = 'internal-test-id'; s.dispatchEvent(new Event('change')); });
    assert.equal(await page.locator('#cameraSelect').inputValue(), 'usb-test-private-id');
    await page.evaluate(() => trackerBridge.release());
    // Removing USB never silently starts the built-in camera.
    await page.locator('#downloadBtn').click(); await page.clock.runFor(300);
    assert.equal(await page.locator('#cameraSelect').isDisabled(), true);
    const requests = await page.evaluate(() => __cameraRequests);
    await page.evaluate(() => { window.__lostEvents = 0; addEventListener('tracker-camera-lost', () => __lostEvents++); window.__devices = __devices.slice(0, 1); __cameraTrack.dispatchEvent(new Event('ended')); });
    await page.clock.runFor(100);
    assert.equal(await page.evaluate(() => __lostEvents), 1);
    assert.equal(await page.evaluate(() => trackerBridge.status().running), false);
    assert.equal(await page.evaluate(() => trackerBridge.status().ready), false);
    assert.equal(await page.locator('#downloadBtn').isEnabled(), true);
    await page.locator('#downloadBtn').click(); await page.clock.runFor(100);
    assert.equal(savedCsv.length, 1); assert(savedCsv[0].csv.split('\n').length > 1);
    await page.locator('#cameraRefreshBtn').click();
    assert.equal(await page.locator('#cameraSelect').inputValue(), 'usb-test-private-id');
    await page.locator('#startBtn').click(); await page.clock.runFor(100);
    assert.equal(await page.evaluate(() => __cameraRequests), requests);
    assert((await page.locator('#hintText').innerText()).includes('選択したカメラが見つかりません'));
    await page.locator('#cameraSelect').selectOption('internal-test-id'); await page.clock.runFor(100);
    await page.locator('#startBtn').click(); await page.clock.runFor(300);
    assert.equal(await page.evaluate(() => trackerBridge.status().running), true);
    assert.equal(await page.evaluate(() => trackerBridge.status().ready), false);
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
    await page.locator('#cameraSelect').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifacts, 'selector-mobile.png') });
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    console.log(JSON.stringify({ ok: true, checks: ['switch invalidates calibration', 'locked during calibration/acquire', '259-D shared calibration', 'failure recovery', 'per-engine comparison', 'explicit USB selection', 'camera change invalidates calibration', 'camera identifiers excluded', 'USB disconnect without fallback'], artifacts }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
