// Synthetic camera and CSV only; never write experiment records.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const server = spawn(process.env.PYTHON || 'python', ['-u', '-c',
    'from http.server import ThreadingHTTPServer; from server import EyeTrackingHandler; s=ThreadingHTTPServer(("127.0.0.1",0),EyeTrackingHandler); print(s.server_port,flush=True); s.serve_forever()'],
    { cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let browser;
  try {
    const port = await new Promise((resolve, reject) => {
      let output = '';
      const deadline = setTimeout(() => reject(new Error('Server startup timed out')), 10000);
      server.on('error', reject);
      server.on('exit', code => { clearTimeout(deadline); reject(new Error('Server exited: ' + code)); });
      server.stdout.on('data', data => {
        output += data;
        if (output.includes('\n')) { clearTimeout(deadline); resolve(Number(output.trim())); }
      });
    });
    // localhost is the existing camera origin allowed by app.js.
    const url = `http://localhost:${port}`;
    browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/save-*', route => route.abort());
    await page.route('**/mediapipe/face_mesh/face_mesh.js', route => route.fulfill({ contentType: 'text/javascript', body: `
      window.FaceMesh=class {
        setOptions(){} async initialize(){} onResults(callback){this.callback=callback;}
        async send(){this.callback({multiFaceLandmarks:[]});}
      };` }));
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        const stream = new MediaStream();
        stream.getTracks = () => [{ stop() { window.__stopped = (window.__stopped || 0) + 1; } }];
        return stream;
      };
      HTMLVideoElement.prototype.play = async () => {};
      for (const [name, get] of Object.entries({ readyState: () => 4, videoWidth: () => 1280, videoHeight: () => 720,
        currentTime: () => performance.now() / 1000 }))
        Object.defineProperty(HTMLVideoElement.prototype, name, { get, configurable: true });
    });
    await page.goto(url);
    assert.equal(await page.locator('a[href="aimlab.html"]').count(), 1);
    await page.locator('#startBtn').click();
    await page.waitForFunction(() => window.trackerBridge.status().running);
    await page.locator('#calibrateBtn').click();
    await page.locator('#modalCalibrateBtn').click();
    await page.locator('#aimlabReleaseCameraBtn').click();
    assert((await page.locator('#aimlabReleaseStatus').innerText()).includes('保存してから'));
    assert.equal(await page.evaluate(() => window.trackerBridge.status().running), true);
    await page.locator('#resetBtn').click();
    await page.locator('#aimlabReleaseCameraBtn').click();
    assert((await page.locator('#aimlabReleaseStatus').innerText()).includes('カメラを停止しました'));
    assert.equal(await page.evaluate(() => window.trackerBridge.status().running), false);
    assert.equal(await page.evaluate(() => window.__stopped), 1);
    assert.equal(await page.locator('#calibrateBtn').isDisabled(), true);
    // A stopped browser tracker can restart; no regression in the original flow.
    await page.locator('#startBtn').click();
    await page.waitForFunction(() => window.trackerBridge.status().running);
    await page.locator('#aimlabReleaseCameraBtn').click();
    await page.goto(url + '/analysis.html');
    await page.locator('#csvInput').setInputFiles({ name: 'synthetic-aimlab-gaze.csv', mimeType: 'text/csv', buffer: Buffer.from(
      'index,captured_at,elapsed_ms,phase,x,y,delta_time_ms,distance_px,speed_px_per_second,screen_width,screen_height,face_detected\n' +
      '1,2026-10-12T00:00:00Z,0,aimlab,100,200,0,0,0,1920,1080,1\n' +
      '2,2026-10-12T00:00:00Z,33,aimlab,110,200,33,10,303.03,1920,1080,1\n' +
      '3,2026-10-12T00:00:00Z,66,aimlab,120,200,33,10,303.03,1920,1080,1\n') });
    await page.waitForFunction(() => document.getElementById('analysisStatus').textContent.includes('読み込みました'));
    assert((await page.locator('#resultSamples').innerText()).startsWith('3 /'));
    await page.goto(url + '/aimlab.html');
    assert((await page.locator('h1').innerText()).includes('Aim Lab'));
    await page.setViewportSize({ width: 375, height: 812 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const artifact = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aimlab-guide-')), 'guide.png');
    await page.screenshot({ path: artifact, fullPage: true });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, screenshot: artifact }));
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
