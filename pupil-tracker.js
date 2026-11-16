(function (root) {
  'use strict';
  class PupilTracker {
    constructor() {
      this.canvas = document.createElement('canvas');
      this.context = this.canvas.getContext('2d', { willReadFrequently: true });
      this.reset();
    }
    reset() { this.previous = null; this.previousAt = -Infinity; this.key = null; }
    detect(video, roi, threshold, rotation = 0, { auto = true, track = true } = {}) {
      const key = JSON.stringify([roi, threshold, rotation, auto, video.videoWidth, video.videoHeight]);
      if (key !== this.key) { this.reset(); this.key = key; }
      const sourceWidth = video.videoWidth, sourceHeight = video.videoHeight;
      const scale = Math.min(1, 320 / (roi.width * sourceWidth), 320 / (roi.height * sourceHeight));
      const width = Math.max(20, Math.round(roi.width * sourceWidth * scale));
      const height = Math.max(20, Math.round(roi.height * sourceHeight * scale));
      if (this.canvas.width !== width) this.canvas.width = width;
      if (this.canvas.height !== height) this.canvas.height = height;
      // ROI coordinates always refer to the upright, corrected image.
      const upsideDown = rotation === 180;
      const x = upsideDown ? 1 - roi.x - roi.width : roi.x;
      const y = upsideDown ? 1 - roi.y - roi.height : roi.y;
      this.context.save();
      if (upsideDown) this.context.setTransform(-1, 0, 0, -1, width, height);
      this.context.drawImage(video, x * sourceWidth, y * sourceHeight, roi.width * sourceWidth, roi.height * sourceHeight, 0, 0, width, height);
      this.context.restore();
      const rgba = this.context.getImageData(0, 0, width, height).data, gray = new Uint8Array(width * height);
      for (let i = 0; i < gray.length; i++) gray[i] = Math.round(.299 * rgba[4 * i] + .587 * rgba[4 * i + 1] + .114 * rgba[4 * i + 2]);
      const now = performance.now();
      if (now - this.previousAt > 250) this.previous = null;
      const result = auto ? root.EyePupil.detectAdaptive(gray, width, height, { previous: track ? this.previous : null })
        : root.EyePupil.detect(gray, width, height, { threshold });
      if (track && result.valid) { this.previous = { cx: result.cx, cy: result.cy, major: result.major }; this.previousAt = now; }
      return { ...result, image_width: width, image_height: height };
    }
  }
  root.PupilTracker = PupilTracker;
})(window);
