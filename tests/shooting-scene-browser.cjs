// Exercise the real scene and camera limits; no camera access or research records.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const server = spawn(process.env.PYTHON || 'python', ['-u', '-c',
    'from http.server import ThreadingHTTPServer; from server import EyeTrackingHandler; s=ThreadingHTTPServer(("127.0.0.1",0),EyeTrackingHandler); print(s.server_port,flush=True); s.serve_forever()'],
  { cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let browser;
  try {
    const port = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(Error('Server startup timeout')), 10000);
      server.on('error', reject);
      server.once('exit', code => reject(Error(`Server exited: ${code}`)));
      server.stdout.once('data', data => { clearTimeout(deadline); resolve(Number(String(data).trim())); });
    });
    browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/index.html?study=shooting`);
    const result = await page.evaluate(async () => {
      const { createShootingScene } = await import('/shooting-scene.mjs');
      const THREE = await import('/sites/pistol-range/dist/vendor/three.module.js');
      const { nextTarget } = await import('/sites/pistol-range/dist/session.js');
      const canvas = document.createElement('canvas');
      const scene = createShootingScene(canvas, 1000, 800);
      scene.warmup();
      if (scene.hit()) throw Error('Warmup must not leave an active target in the scene');
      const aimingCamera = new THREE.PerspectiveCamera(); aimingCamera.rotation.order = 'YXZ';
      const sensitivity = .0018;
      const sizes = [[1000, 800], [1920, 1080], [2560, 1080], [390, 844], [320, 2000], [3200, 800]];
      const poses = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];
      const check = (condition, message) => { if (!condition) throw Error(message); };
      let targets = 0, seed = 42;
      const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
      function aimAt(point, context) {
        const before = scene.pose();
        aimingCamera.position.set(before.camera_x, before.camera_y, before.camera_z);
        aimingCamera.lookAt(point.x, point.y, point.z);
        const yaw = aimingCamera.rotation.y, pitch = aimingCamera.rotation.x;
        scene.look((before.yaw - yaw) / sensitivity, (before.pitch - pitch) / sensitivity, sensitivity);
        const after = scene.pose();
        check(Math.abs(after.yaw - yaw) < 1e-9 && Math.abs(after.pitch - pitch) < 1e-9,
          `Target center is outside camera limits: ${context}; ${JSON.stringify({ point, yaw, pitch, actualYaw: after.yaw, actualPitch: after.pitch })}`);
      }
      try {
        for (const [width, height] of sizes) {
          scene.resize(width, height);
          for (const [horizontal, vertical] of poses) {
            for (const constant of [null, 0, .5, .999999]) {
              for (let i = 0; i < (constant === null ? 40 : 1); i++) {
                scene.reset(); scene.look(horizontal * 1e6, vertical * 1e6, sensitivity);
                const context = `${width}x${height}, look=${horizontal},${vertical}, random=${constant}`;
                const point = scene.newTarget(constant === null ? random : () => constant);
                check(scene.pose().in_view, `Target must be visible when spawned: ${context}`);
                check(point.y >= .55 && point.y <= 6.6 && Math.abs(point.x) <= 11.8 && point.z >= -16.3 && point.z <= -.8,
                  `Target must stay in the room: ${context}`);
                aimAt(point, context);
                check(scene.hit(), `Target must be hittable after aiming: ${context}`);
                targets++;
              }
            }
          }
        }
        scene.resize(1920, 1080); scene.reset();
        const first = scene.newTarget(random, true);
        check(Math.abs(first.x) < 1e-9 && Math.abs(first.y - 1.65) < 1e-9 && Math.abs(first.z + 10.5) < 1e-9, 'First target must stay centered');
        for (let i = 0; i < 250; i++) {
          const point = scene.newTarget(random); aimAt(point, `consecutive target ${i}`);
          check(scene.hit(), `Consecutive target ${i} must be hittable`); targets++;
        }
        let previous = first;
        for (let i = 0; i < 250; i++) { previous = nextTarget(previous, random); aimAt(previous, `play-only target ${i}`); }
        return { ok: true, targets, viewportSizes: sizes.length, cameraPositions: poses.length, playOnlyTargets: 250 };
      } finally { scene.dispose(); }
    });
    assert.equal(result.ok, true); console.log(JSON.stringify(result));
  } finally { if (browser) await browser.close(); server.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
