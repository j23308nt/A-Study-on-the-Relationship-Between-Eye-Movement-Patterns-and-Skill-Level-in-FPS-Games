// Actual canvas pixels and detector, synthetic camera only. No research-data writes.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [], writes = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.route('**/save-*', route => { writes.push(route.request().url()); return route.abort(); });
    await page.route('**/mediapipe/face_mesh/face_mesh.js', route => route.fulfill({ contentType: 'text/javascript', body: `
      window.FaceMesh = class {
        setOptions(){} async initialize(){} async close(){} onResults(fn){this.callback=fn;}
        async send({image}) {
          const c=document.createElement('canvas');c.width=200;c.height=120;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);
          window.__faceInput={canvas:image instanceof HTMLCanvasElement,pixel:[...ctx.getImageData(2,2,1,1).data]};
          this.callback({multiFaceLandmarks:[Array.from({length:478},()=>({x:.5,y:.5,z:0}))]});
        }
      };` }));
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => new MediaStream();
      navigator.mediaDevices.enumerateDevices = async () => [];
      HTMLVideoElement.prototype.play = async () => {};
      for (const [name, get] of Object.entries({ readyState: () => 4, videoWidth: () => 200, videoHeight: () => 120,
        currentTime: () => Math.floor(performance.now() / 33) / 30 }))
        Object.defineProperty(HTMLVideoElement.prototype, name, { get, configurable: true });
      HTMLVideoElement.prototype.requestVideoFrameCallback = function (fn) {
        return requestAnimationFrame(now => fn(now, { mediaTime: Math.floor(now / 33) / 30 }));
      };
      HTMLVideoElement.prototype.cancelVideoFrameCallback = id => cancelAnimationFrame(id);
      const draw = CanvasRenderingContext2D.prototype.drawImage;
      const c = document.createElement('canvas'); c.width = 200; c.height = 120;
      const ctx = c.getContext('2d');ctx.fillStyle='#aaa';ctx.fillRect(0,0,200,120);
      ctx.fillStyle='rgb(240,70,70)';ctx.fillRect(0,0,6,6);
      ctx.fillStyle='rgb(70,70,240)';ctx.fillRect(194,114,6,6);
      ctx.fillStyle='#141414';ctx.beginPath();ctx.ellipse(145,35,9,7,0,0,2*Math.PI);ctx.fill();
      CanvasRenderingContext2D.prototype.drawImage = function (source, ...args) {
        return draw.call(this, source instanceof HTMLVideoElement ? c : source, ...args);
      };
    });
    await page.clock.install(); await page.clock.pauseAt(new Date(Date.now() + 1000));
    const url = process.env.VALIDATION_URL || 'http://127.0.0.1:8780/';
    await page.goto(url);
    await page.locator('#cameraRotation').selectOption('180'); await page.clock.runFor(100);
    await page.locator('#startBtn').click(); await page.clock.runFor(300);
    assert.deepEqual(await page.evaluate(() => __faceInput), { canvas: true, pixel: [70, 70, 240, 255] });
    assert.equal(await page.locator('.camera-video').evaluate(e => e.style.transform), 'rotate(180deg)');
    await page.evaluate(() => {
      GazeBackends.NeuralFeatures = class {
        async init(){return {id:'gazefollower2',feature_count:3,ridge_alpha:2};}
        async features(image){window.__neuralPixel=[...image.getContext('2d').getImageData(2,2,1,1).data];return [1,.2,.3];}
        close(){}
      };
    });
    await page.locator('#trackerEngine').selectOption('gazefollower2'); await page.clock.runFor(300);
    assert.deepEqual(await page.evaluate(() => __neuralPixel), [70, 70, 240, 255]);
    await page.locator('#trackerEngine').selectOption('pupil-roi'); await page.clock.runFor(100);
    const pupils = await page.evaluate(() => {
      const p = new PupilTracker(), v = document.querySelector('.camera-video');
      return [0,180].map(rotation => p.detect(v,{x:0,y:0,width:1,height:1},50,rotation));
    });
    assert(pupils.every(p => p.valid));
    await page.evaluate(() => {
      const tracker = new PupilTracker(), video = document.querySelector('.camera-video'), roi = {x:0,y:0,width:1,height:1};
      const first = tracker.detect(video,roi,50,180);
      if (!first.valid) throw Error('Expected probe pupil');
      const original = EyePupil.detectAdaptive;
      window.__trackingProbe = {tracker,video,roi,original};
      EyePupil.detectAdaptive = (_g,_w,_h,options) => {
        window.__trackingHint = Boolean(options.previous);
        return {valid:false,reason:'pupil_not_found',diagnostic:'insufficient_edges'};
      };
      const lost = tracker.detect(video,roi,50,180);
      if(lost.valid || lost.features || !window.__trackingHint) throw Error('Missing image must remain invalid despite cached pupil');
    });
    await page.clock.runFor(300);
    assert.equal(await page.evaluate(() => {
      const p=__trackingProbe; p.tracker.detect(p.video,p.roi,50,180);
      EyePupil.detectAdaptive=p.original; delete window.__trackingProbe;
      return window.__trackingHint;
    }), false, 'tracking hints expire after 250ms');
    assert(Math.abs(pupils[1].cx - (199 - pupils[0].cx)) < .1);
    assert(Math.abs(pupils[1].cy - (119 - pupils[0].cy)) < .1);
    await page.locator('#eyeRoiBtn').click();
    assert.deepEqual(await page.locator('#eyeRoiCanvas').evaluate(e => [...e.getContext('2d').getImageData(2,2,1,1).data]), [70,70,240,255]);
    const box = await page.locator('#eyeRoiCanvas').boundingBox();
    await page.mouse.move(box.x + box.width * .15, box.y + box.height * .55); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .4, box.y + box.height * .85); await page.mouse.up();
    await page.locator('#eyeHeadFixed').check(); assert.equal(await page.locator('#eyeRoiApply').isEnabled(), true);
    await page.locator('#eyeRoiApply').click();
    const generation = await page.evaluate(() => trackerBridge.status().generation);
    await page.locator('#cameraRotation').selectOption('0'); await page.clock.runFor(100);
    assert.equal(await page.locator('#calibrateBtn').isDisabled(), true);
    assert.equal(await page.evaluate(() => trackerBridge.status().generation), generation + 1);
    await page.reload();
    assert.equal(await page.locator('#cameraRotation').inputValue(), '0');
    await page.locator('#cameraRotation').selectOption('180'); await page.clock.runFor(100); await page.reload();
    assert.equal(await page.locator('#cameraRotation').inputValue(), '180');
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    console.log(JSON.stringify({ ok: true, checks: ['rotated FaceMesh input','rotated neural input','ROI pixel coordinates','off-center pupil crop','ROI invalidation','preference persistence'] }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
