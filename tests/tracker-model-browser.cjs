// Real local ONNX model, synthetic image and landmarks. No webcam or record saving.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
  const server = spawn('python', ['-u', '-c', 'from http.server import ThreadingHTTPServer; from server import EyeTrackingHandler; s=ThreadingHTTPServer(("127.0.0.1",0),EyeTrackingHandler); print(s.server_port,flush=True); s.serve_forever()'],
    { cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let browser;
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('server timeout')), 10000);
      server.on('error', reject); server.stdout.once('data', d => { clearTimeout(timer); resolve(Number(String(d).trim())); });
    });
    browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
    const page = await browser.newPage(), external = [], writes = [], errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => {
      const request = route.request();
      if (!request.url().startsWith(`http://127.0.0.1:${port}/`)) { external.push(request.url()); return route.abort(); }
      if (request.method() !== 'GET') { writes.push(request.url()); return route.abort(); }
      return route.continue();
    });
    await page.goto(`http://127.0.0.1:${port}/`);
    const result = await page.evaluate(async () => {
      const engine = new GazeBackends.NeuralFeatures();
      try {
        const started = performance.now(), metadata = await engine.init();
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#bca48a'; ctx.fillRect(0, 0, 640, 480);
        ctx.fillStyle = '#ddd'; ctx.fillRect(165, 170, 105, 35); ctx.fillRect(370, 170, 105, 35);
        const points = Array.from({ length: 478 }, (_, i) => ({ x: .5 + .23 * Math.cos(i / 478 * 2 * Math.PI), y: .5 + .35 * Math.sin(i / 478 * 2 * Math.PI), z: 0 }));
        points[33] = { x: .26, y: .39, z: 0 }; points[133] = { x: .42, y: .39, z: 0 };
        points[362] = { x: .58, y: .39, z: 0 }; points[263] = { x: .74, y: .39, z: 0 };
        const a = await engine.features(canvas, points), tick = performance.now();
        const b = await engine.features(canvas, points);
        let rejected = false;
        try { await engine.features(canvas, []); } catch { rejected = true; }
        return { metadata, count: a.length, finite: a.every(Number.isFinite), bias: a[0],
          repeatError: Math.max(...a.map((v, i) => Math.abs(v - b[i]))), rejected,
          startupAndFirstMs: tick - started, secondMs: performance.now() - tick };
      } finally { engine.close(); }
    });
    assert.equal(result.metadata.id, 'gazefollower2'); assert.match(result.metadata.model_sha256, /^[0-9a-f]{64}$/);
    assert.equal(result.count, 259); assert.equal(result.finite, true); assert.equal(result.bias, 1);
    assert.equal(result.repeatError, 0); assert.equal(result.rejected, true);
    assert.deepEqual(external, []); assert.deepEqual(writes, []); assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, syntheticInferenceOnly: true, ...result }));
  } finally { await browser?.close(); server.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
