(function (root) {
  'use strict';
  class PupilTracker {
    constructor() {
      this.canvas = document.createElement('canvas');
      this.context = this.canvas.getContext('2d', { willReadFrequently: true });
    }
    detect(video, roi, threshold) {
      const sourceWidth = video.videoWidth, sourceHeight = video.videoHeight;
      const scale = Math.min(1, 320 / (roi.width * sourceWidth), 320 / (roi.height * sourceHeight));
      const width = Math.max(20, Math.round(roi.width * sourceWidth * scale));
      const height = Math.max(20, Math.round(roi.height * sourceHeight * scale));
      if (this.canvas.width !== width) this.canvas.width = width;
      if (this.canvas.height !== height) this.canvas.height = height;
      this.context.drawImage(video, roi.x * sourceWidth, roi.y * sourceHeight, roi.width * sourceWidth, roi.height * sourceHeight, 0, 0, width, height);
      const rgba = this.context.getImageData(0, 0, width, height).data, gray = new Uint8Array(width * height);
      for (let i = 0; i < gray.length; i++) gray[i] = Math.round(.299 * rgba[4 * i] + .587 * rgba[4 * i + 1] + .114 * rgba[4 * i + 2]);
      const result = root.EyePupil.detect(gray, width, height, { threshold });
      return { ...result, image_width: width, image_height: height };
    }
  }
  root.PupilTracker = PupilTracker;
})(window);
