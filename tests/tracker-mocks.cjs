// Deterministic neural features for UI workflows. This is not a real accuracy test.
exports.mockNeural = async page => {
  await page.evaluate(() => {
    GazeBackends.NeuralFeatures = class {
      async init() {
        return { id: 'gazefollower2', label: 'GazeFollower2', feature_count: 259, ridge_alpha: 2,
          model_sha256: 'synthetic-test-only', mapping: 'common-nine-point-ridge-v1', upstream_filter: false };
      }
      async features(_image, landmarks) {
        const x = (landmarks[468].x - .35) / .16 + .5;
        const y = (landmarks[468].y - .4) / .06 + .5;
        return [1, x, y, ...Array(256).fill(0)];
      }
      close() {}
    };
    const original = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (source, ...args) {
      if (source instanceof HTMLVideoElement) {
        this.fillStyle = '#777'; this.fillRect(0, 0, this.canvas.width, this.canvas.height); return;
      }
      return original.call(this, source, ...args);
    };
  });
};
exports.configureTracker = async page => {
  if (process.env.TEST_TRACKER_ENGINE === 'pupil-roi') return exports.configurePupil(page);
  if (process.env.TEST_TRACKER_ENGINE !== 'gazefollower2') return;
  await exports.mockNeural(page);
  await page.locator('#trackerEngine').selectOption('gazefollower2');
};

// Synthetic eye pixels pass through the real ROI crop, detector and regression.
exports.configurePupil = async page => {
  await page.evaluate(() => {
    window.FaceMesh = class { constructor() { throw Error('Eye-only mode called FaceMesh'); } };
    const original = CanvasRenderingContext2D.prototype.drawImage;
    const sourceCanvas = document.createElement('canvas'), ctx = sourceCanvas.getContext('2d');
    CanvasRenderingContext2D.prototype.drawImage = function (source, ...args) {
      if (source instanceof HTMLVideoElement) {
        sourceCanvas.width = source.videoWidth; sourceCanvas.height = source.videoHeight;
        const w = sourceCanvas.width, h = sourceCanvas.height;
        let g = window.__gaze || { x: .5, y: .5 };
        const quality = document.getElementById('shootingQuality'), dot = document.getElementById('shootingQualityDot');
        if (quality && !quality.hidden) g = { x: parseFloat(dot.style.left) / innerWidth, y: parseFloat(dot.style.top) / innerHeight };
        ctx.fillStyle = '#aaa'; ctx.fillRect(0, 0, w, h);
        if (!window.__missing && !(window.__pupilDropouts && Math.floor(performance.now() / 33) % 13 === 0)) {
          ctx.fillStyle = '#141414'; ctx.beginPath();
          ctx.ellipse(w * (.375 + .25 * g.x), h * (.375 + .25 * g.y), w * .02, h * .025, 0, 0, 2 * Math.PI); ctx.fill();
        }
        return original.call(this, sourceCanvas, ...args);
      }
      return original.call(this, source, ...args);
    };
  });
  await page.locator('#trackerEngine').selectOption('pupil-roi');
  await page.locator('#startBtn').click(); await page.clock.runFor(300);
  await page.locator('#eyeRoiBtn').click();
  const rect = await page.locator('#eyeRoiCanvas').boundingBox();
  await page.mouse.move(rect.x + rect.width * .25, rect.y + rect.height * .25); await page.mouse.down();
  await page.mouse.move(rect.x + rect.width * .75, rect.y + rect.height * .75, { steps: 5 }); await page.mouse.up();
  await page.locator('#eyeHeadFixed').check();
  await page.locator('#eyeRoiApply').click();
};
