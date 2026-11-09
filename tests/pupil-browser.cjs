// Synthetic eye images, real detector/calibration. No physical camera or recording writes.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [], writes = [], bundles = [], csvRecords = [], artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'pupil-ui-'));
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.route('**/save-*', route => { writes.push(route.request().url()); return route.abort(); });
    await page.route('**/save-validation', route => {
      const payload = route.request().postDataJSON(); bundles.push(JSON.parse(payload.files['session.json']));
      assert(payload.files['samples.csv'].includes('pupil_u'));
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, path: 'synthetic-test-only' }) });
    });
    await page.route('**/save-csv', route => {
      csvRecords.push(route.request().postDataJSON().csv);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, path: 'synthetic-test-only' }) });
    });
    await page.route('**/mediapipe/face_mesh/face_mesh.js', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        const stream = new MediaStream(), track = new EventTarget();
        track.getSettings = () => ({ width: 640, height: 480 }); track.stop = () => {};
        stream.getTracks = stream.getVideoTracks = () => [track]; window.__track = track; return stream;
      };
      navigator.mediaDevices.enumerateDevices = async () => [];
      HTMLVideoElement.prototype.play = async () => {};
      for (const [name, get] of Object.entries({ readyState: () => 4, videoWidth: () => window.__videoWidth || 640,
        videoHeight: () => 480, currentTime: () => Math.floor(performance.now() / 33) / 30 }))
        Object.defineProperty(HTMLVideoElement.prototype, name, { get, configurable: true });
      HTMLVideoElement.prototype.requestVideoFrameCallback = function (fn) {
        return requestAnimationFrame(now => fn(now, { mediaTime: Math.floor(now / 33) / 30, presentedFrames: Math.floor(now / 33) }));
      };
      HTMLVideoElement.prototype.cancelVideoFrameCallback = id => cancelAnimationFrame(id);
    });
    await page.clock.install(); await page.clock.pauseAt(new Date(Date.now() + 1000));
    await page.goto(process.env.VALIDATION_URL || 'http://127.0.0.1:8780/');
    await require('./tracker-mocks.cjs').configurePupil(page);
    assert.equal(await page.locator('#calibrateBtn').isEnabled(), true);
    assert.equal(await page.evaluate(() => { try { trackerBridge.checkHeadCondition('free'); return false; } catch { return true; } }), true);
    await page.evaluate(() => { window.__frames = []; addEventListener('gaze-frame', e => __frames.push(e.detail)); });
    await page.locator('#validationSetupBtn').click();
    await page.locator('#vHeadCondition').selectOption('free'); await page.locator('#vPositionConfirmed').check();
    await page.locator('#validationPrepareBtn').click();
    for (let n = 0; n < 30 && !await page.locator('#validationSetupError').innerText(); n++) await page.clock.runFor(100);
    assert((await page.locator('#validationSetupError').innerText()).includes('頭部固定'));
    await page.locator('#vHeadCondition').selectOption('fixed'); await page.locator('#vPositionConfirmed').check();
    await page.locator('#validationPrepareBtn').click();
    for (let n = 0; n < 30 && await page.locator('#validationSetup').evaluate(e => e.open); n++) await page.clock.runFor(100);
    assert.equal(await page.locator('#validationSetup').evaluate(e => e.open), false, await page.locator('#validationSetupError').innerText());
    assert.equal(await page.locator('#eyeRoiBtn').isDisabled(), true);
    for (const id of [1, 2, 3, 4, 6, 7, 8, 9, 5]) {
      await page.evaluate(id => { const p = document.getElementById('Pt' + id); window.__gaze = { x: parseFloat(p.style.left) / 100, y: parseFloat(p.style.top) / 100 }; }, id);
      await page.clock.runFor(350); await page.locator('#Pt' + id).click();
      for (let n = 0; n < 60 && !await page.locator('#Pt' + id).evaluate(e => e.classList.contains('is-complete')); n++) await page.clock.runFor(100);
      assert.equal(await page.locator('#Pt' + id).evaluate(e => e.classList.contains('is-complete')), true);
    }
    await page.clock.runFor(5300);
    const snapshot = await page.evaluate(() => trackerBridge.acquire());
    assert.equal(snapshot.engine.id, 'pupil-roi'); assert.equal(snapshot.engine.landmark_pipeline, 'none');
    assert.equal(snapshot.engine.head_fixed_confirmed, true); assert.equal(snapshot.engine.roi.source_width, 640);
    assert.equal(snapshot.regression.x.length, 6); assert.equal(snapshot.calibration_samples.length, 45);
    assert.equal(new Set(snapshot.calibration_samples.flatMap(s => s.source_frame_ids)).size, 360);
    assert.equal(await page.locator('#eyeRoiBtn').isDisabled(), true);
    await page.evaluate(() => { window.__gaze = { x: .7, y: .3 }; __frames = []; }); await page.clock.runFor(1500);
    const valid = (await page.evaluate(() => __frames)).filter(f => f.valid);
    assert(valid.length > 20); assert(valid.every(f => !f.face_detected && f.pupil_detected && f.tracker_engine === 'pupil-roi'));
    assert(Math.abs(valid.at(-1).raw_x - 770) < 35); assert(Math.abs(valid.at(-1).raw_y - 270) < 35);
    await page.evaluate(() => { window.__missing = true; __frames = []; }); await page.clock.runFor(300);
    const lost = await page.evaluate(() => __frames);
    assert(lost.length > 3); assert(lost.every(f => !f.valid && f.failure_reason === 'pupil_not_found'));
    await page.evaluate(() => { trackerBridge.release(); window.__missing = false; }); await page.clock.runFor(100);
    await page.locator('#validationRunBtn').click();
    for (let n = 0; n < 9; n++) await page.clock.runFor(10000);
    await page.waitForFunction(() => document.getElementById('validationSaveStatus').textContent.includes('保存済み'));
    assert.equal(bundles.length, 1); assert.equal(bundles[0].summary.status, 'completed');
    assert.equal(bundles[0].summary.trials.length, 27); assert.equal(bundles[0].metadata.tracker.engine.id, 'pupil-roi');
    assert(bundles[0].metadata.source_sha256['pupil-core.js']);
    assert(bundles[0].frames.some(f => f.valid && f.pupil_detected && !f.face_detected));
    await page.locator('#validationResultsClose').click();
    await page.locator('#downloadBtn').click(); await page.clock.runFor(300); await page.locator('#downloadBtn').click();
    await page.waitForFunction(() => document.getElementById('statusText').textContent === 'CSV保存完了');
    const [columns, ...csvRows] = csvRecords[0].split('\n').map(row => row.split(','));
    assert(csvRows.length > 2);
    assert(csvRows.every(row => row[columns.indexOf('face_detected')] === '0' && row[columns.indexOf('pupil_detected')] === '1'));
    await page.locator('#eyeRoiBtn').click();
    assert.equal(await page.locator('#eyeRoiApply').isDisabled(), true, 'head-fixed confirmation must be renewed');
    assert.equal(await page.evaluate(() => { try { trackerBridge.prepare(); return false; } catch { return true; } }), true);
    await page.screenshot({ path: path.join(artifacts, 'eye-settings.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.locator('#eyeRoiCanvas').evaluate(e => e.getBoundingClientRect().width <= innerWidth));
    await page.screenshot({ path: path.join(artifacts, 'eye-settings-mobile.png') });
    await page.locator('#eyeHeadFixed').check(); await page.locator('#eyeRoiApply').click();
    assert.equal(await page.evaluate(() => trackerBridge.status().ready), false, 'ROI change invalidates calibration');
    await page.evaluate(() => { window.__videoWidth = 800; }); await page.clock.runFor(150);
    assert.equal(await page.locator('#calibrateBtn').isDisabled(), true, 'resolution change invalidates ROI');
    await page.locator('#eyeRoiBtn').click();
    await page.evaluate(() => __track.dispatchEvent(new Event('ended'))); await page.clock.runFor(100);
    assert.equal(await page.locator('#eyeRoiDialog').evaluate(e => e.open), false);
    assert.equal(await page.evaluate(() => trackerBridge.status().running), false);
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    console.log(JSON.stringify({ ok: true, synthetic_eye_only: true, artifacts }));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
