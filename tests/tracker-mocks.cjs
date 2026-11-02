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
  if (process.env.TEST_TRACKER_ENGINE !== 'gazefollower2') return;
  await exports.mockNeural(page);
  await page.locator('#trackerEngine').selectOption('gazefollower2');
};
