// Synthetic camera; save requests and recovery checks never write research recordings.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path'), fs = require('node:fs'), os = require('node:os');

(async () => {
  const server = spawn('python', ['-u', '-c', 'from http.server import ThreadingHTTPServer; from server import EyeTrackingHandler; s=ThreadingHTTPServer(("127.0.0.1",0),EyeTrackingHandler); print(s.server_port,flush=True); s.serve_forever()'],
    { cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let browser;
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'shooting-study-'));
  try {
    const port = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(Error('Server startup timeout')), 10000);
      server.on('error', reject); server.stdout.once('data', data => { clearTimeout(deadline); resolve(Number(String(data).trim())); });
    });
    browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const page = await browser.newPage({ viewport: { width: 1000, height: 760 }, screen: { width: 1000, height: 760 }, acceptDownloads: true });
    const errors = [], payloads = []; let failSave = true;
    page.on('pageerror', error => { errors.push(error.message); console.error('PAGE', error.message); });
    await page.route('**/save-shooting', async route => {
      const payload = route.request().postDataJSON(); payloads.push(payload);
      await route.fulfill({ status: failSave ? 500 : 200, contentType: 'application/json', body: JSON.stringify(failSave ? { ok: false, error: 'Synthetic save failure' } : { ok: true, path: `recordings/shooting/${payload.run_id}` }) });
    });
    await page.route('**/mediapipe/face_mesh/face_mesh.js', route => route.fulfill({ contentType: 'text/javascript', body: `
      window.FaceMesh=class {
        setOptions(){} async initialize(){} onResults(fn){this.callback=fn;}
        async send(){
          window.__fakeFrames=(window.__fakeFrames||0)+1;
          if(window.__fakeFrames%13===0){this.callback({multiFaceLandmarks:[]});return;}
          let gaze=window.__gaze||{x:.5,y:.5};
          const q=document.getElementById('shootingQuality'), d=document.getElementById('shootingQualityDot');
          if(q && !q.hidden)gaze={x:parseFloat(d.style.left)/innerWidth,y:parseFloat(d.style.top)/innerHeight};
          const l=Array.from({length:478},()=>({x:.5,y:.5,z:0}));
          const p=(i,x,y)=>{l[i]={x,y,z:0};};
          p(10,.5,.2);p(152,.5,.8);p(1,.5,.5);
          p(33,.25,.4);p(133,.45,.4);p(159,.35,.36);p(145,.35,.44);
          p(362,.55,.4);p(263,.75,.4);p(386,.65,.36);p(374,.65,.44);
          for(let i=468;i<=472;i++)p(i,.35+(gaze.x-.5)*.16,.4+(gaze.y-.5)*.06);
          for(let i=473;i<=477;i++)p(i,.65+(gaze.x-.5)*.16,.4+(gaze.y-.5)*.06);
          this.callback({multiFaceLandmarks:[l]});
        }
      };` }));
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => new MediaStream();
      HTMLVideoElement.prototype.play = async () => {};
      for (const [name, get] of Object.entries({ readyState: () => 4, videoWidth: () => 1280, videoHeight: () => 720, currentTime: () => Math.floor(performance.now() / 33) / 30 }))
        Object.defineProperty(HTMLVideoElement.prototype, name, { get, configurable: true });
      HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
        return requestAnimationFrame(now => callback(now, { mediaTime: Math.floor(performance.now() / 33) / 30, presentedFrames: Math.floor(performance.now() / 33) }));
      };
      HTMLVideoElement.prototype.cancelVideoFrameCallback = id => cancelAnimationFrame(id);
    });
    await page.clock.install(); await page.clock.pauseAt(new Date(Date.now() + 1000));
    await page.goto(`http://localhost:${port}/index.html?study=shooting`);
    async function prepare() {
      await page.locator('#shootingSetupBtn').click(); await page.locator('#sConfirmed').check();
      await page.locator('#shootingPrepareBtn').click(); await page.clock.runFor(100);
      await page.waitForFunction(() => !document.getElementById('shootingSetup').open, null, { polling: 20 });
      for (const id of [1, 2, 3, 4, 6, 7, 8, 9, 5]) {
        await page.evaluate(id => { const p = document.getElementById('Pt' + id); window.__gaze = { x: parseFloat(p.style.left) / 100, y: parseFloat(p.style.top) / 100 }; }, id);
        await page.clock.runFor(350);
        for (let i = 0; i < 5; i++) await page.locator('#Pt' + id).click();
      }
      await page.clock.runFor(5500);
      await page.clock.runFor(9500);
      await page.waitForFunction(() => !document.getElementById('shootingPrecisionAccepted').disabled, null, { polling: 20 });
      assert((await page.locator('#shootingStatus').innerText()).includes('正確度確認'));
      await page.locator('#shootingPrecisionAccepted').check();
      assert.equal(await page.locator('#shootingRunBtn').isEnabled(), true);
    }
    await prepare(); console.log('calibration_and_quality_pass');
    await page.locator('#shootingRunBtn').click();
    await page.waitForFunction(() => !document.getElementById('shootingStage').hidden, null, { polling: 20 });
    await page.evaluate(() => {
      window.__backgroundActivations = 0;
      const button = document.createElement('button'); button.id = 'backgroundProbe';
      button.textContent = 'Background control'; document.body.append(button);
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'contextmenu'])
        button.addEventListener(type, () => window.__backgroundActivations++);
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
        const EventType = type.startsWith('pointer') ? PointerEvent : MouseEvent;
        button.dispatchEvent(new EventType(type, { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
      }
    });
    assert.equal(await page.evaluate(() => window.__backgroundActivations), 0, 'countdown must consume the entire mouse sequence before background controls');
    assert.equal(await page.locator('#shootingRunBtn').evaluate(e => e.closest('[inert]') !== null), true);
    await page.clock.runFor(3200);
    assert.equal(await page.locator('#resetBtn').isDisabled(), true);
    assert.equal(await page.locator('.camera-preview').evaluate(e => getComputedStyle(e).visibility), 'hidden');
    await page.mouse.down(); await page.mouse.up(); await page.clock.runFor(200);
    assert.equal(await page.locator('#shootingHits').innerText(), '1');
    await page.locator('#backgroundProbe').dispatchEvent('click');
    assert.equal(await page.evaluate(() => window.__backgroundActivations), 0, 'a shooting click must never activate a background button');
    assert.equal(await page.locator('#shootingStage').isVisible(), true, 'the first shot must leave the game running');
    await page.mouse.down(); await page.mouse.up(); await page.clock.runFor(200);
    assert.equal(await page.locator('#shootingAccuracy').innerText(), '50%');
    await page.screenshot({ path: path.join(artifacts, 'game.png') });
    await page.clock.runFor(61000);
    await page.waitForFunction(() => document.getElementById('shootingResults').open, null, { polling: 20 });
    await page.waitForFunction(() => document.getElementById('shootingSaveStatus').textContent.includes('自動保存できません'), null, { polling: 20 });
    const first = payloads[0], complete = JSON.parse(first.files['session.json']);
    fs.writeFileSync(path.join(artifacts, 'synthetic-session.json'), first.files['session.json']);
    assert.equal(complete.metadata.status, 'completed'); assert.equal(complete.summary.game_duration_ms, 60000);
    assert.equal(complete.summary.hits, 1); assert.equal(complete.summary.shots, 2);
    assert.equal(Object.keys(first.files).length, 6);
    assert(complete.frames.length > 1000); assert(complete.gaze.some(g => !g.valid));
    assert(complete.targets.some(t => t.status === 'unfinished'));
    assert(complete.metadata.quality.complete); assert(complete.metadata.source_sha256['shooting.mjs']);
    assert(complete.gaze.some(g => g.target_id && g.rendered_frame_id));
    assert(complete.frames.filter(f => f.target_visible).every(f => f.in_view));
    failSave = false; await page.locator('#shootingSaveBtn').click();
    assert.equal(await page.locator('#shootingRunBtn').evaluate(e => e.closest('[inert]') !== null), false, 'background controls must be restored after finishing');
    await page.waitForFunction(() => document.getElementById('shootingSaveStatus').textContent.startsWith('保存済み'), null, { polling: 20 });
    assert.deepEqual(payloads[1], first);
    console.log('complete_run_and_save_retry_pass');
    const analysis = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    analysis.on('pageerror', error => errors.push(error.message));
    await analysis.goto(`http://localhost:${port}/shooting-analysis.html`);
    await analysis.locator('#recordFile').setInputFiles({ name: 'synthetic-session.json', mimeType: 'application/json', buffer: Buffer.from(first.files['session.json']) });
    await analysis.waitForFunction(() => document.getElementById('loadStatus').textContent.includes('読み込みました'));
    assert.equal(await analysis.locator('#targetRows tr').count(), complete.targets.length);
    const sizes = await analysis.evaluate(() => ({ canvas: document.getElementById('replayCanvas').getBoundingClientRect().width,
      overlay: document.getElementById('replayOverlay').getBoundingClientRect().width }));
    assert(Math.abs(sizes.canvas - sizes.overlay) < 1, 'replay and gaze overlay must use the same displayed coordinate scale');
    await analysis.locator('#timeline').evaluate((e, time) => { e.value = time; e.dispatchEvent(new Event('input')); }, complete.targets[0].onset_ms + 100);
    await analysis.screenshot({ path: path.join(artifacts, 'analysis.png') });
    await analysis.close();
    await page.bringToFront(); await page.locator('#shootingResultsClose').click();
    await prepare(); await page.locator('#shootingRunBtn').click(); await page.clock.runFor(3300);
    await page.evaluate(() => {
      window.__lateBackgroundClicks = 0;
      document.getElementById('shootingResultsClose').addEventListener('click', () => window.__lateBackgroundClicks++);
    });
    failSave = true; await page.mouse.down(); await page.keyboard.press('Escape'); await page.clock.runFor(100);
    await page.waitForFunction(() => document.getElementById('shootingResults').open, null, { polling: 20 });
    await page.locator('#shootingResultsClose').dispatchEvent('pointerup', { pointerType: 'mouse', button: 0 });
    await page.locator('#shootingResultsClose').dispatchEvent('mouseup', { button: 0 });
    await page.locator('#shootingResultsClose').dispatchEvent('click');
    await page.mouse.up();
    assert.equal(await page.evaluate(() => window.__lateBackgroundClicks), 0, 'release/click after ending must not activate the result controls');
    assert.equal(await page.locator('#shootingResults').evaluate(e => e.open), true);
    const aborted = JSON.parse(payloads.at(-1).files['session.json']);
    assert.equal(aborted.metadata.status, 'aborted'); assert(aborted.targets.every(t => t.status !== 'visible'));
    const abortedPayload = payloads.at(-1);
    await page.reload(); await page.clock.runFor(100);
    await page.locator('#shootingRecoveryBtn').waitFor();
    failSave = false; await page.locator('#shootingRecoveryBtn').click();
    await page.waitForFunction(() => document.getElementById('shootingSaveStatus').textContent.startsWith('保存済み'), null, { polling: 20 });
    assert.deepEqual(payloads.at(-1), abortedPayload);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, artifacts, checks: ['automatic camera start', '9-point calibration', '5-position accuracy check', 'WebGL hit/miss', '60-second completion', 'shared render/gaze clocks', 'failure retention', 'immutable retry', '3D replay', 'Escape abort', 'IndexedDB recovery'] }));
  } finally { if (browser) await browser.close(); server.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
