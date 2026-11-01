(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CalibrationSampling = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SAMPLES_PER_POINT = 5, FRAMES_PER_SAMPLE = 8, SETTLE_MS = 600, MAX_FRAME_GAP_MS = 250;
  class PointCapture {
    constructor(startMs) {
      this.readyAt = startMs + SETTLE_MS;
      this.rows = []; this.samples = 0; this.lastFrameId = -1; this.lastEnd = null;
    }
    push(frame) {
      if (this.samples >= SAMPLES_PER_POINT || !frame || !Number.isInteger(frame.frame_id) || frame.frame_id <= this.lastFrameId) return null;
      this.lastFrameId = frame.frame_id;
      const start = frame.processing_start_ms, end = frame.processing_end_ms;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || start < this.readyAt ||
          !frame.valid || !Array.isArray(frame.features) || !frame.features.length || !frame.features.every(Number.isFinite)) {
        this.rows = []; this.lastEnd = null; return null;
      }
      if (this.lastEnd !== null && (start < this.lastEnd || start - this.lastEnd > MAX_FRAME_GAP_MS)) this.rows = [];
      this.lastEnd = end;
      this.rows.push({ features: frame.features.slice(), frame_id: frame.frame_id, start, end });
      if (this.rows.length < FRAMES_PER_SAMPLE) return null;
      const rows = this.rows; this.rows = []; this.samples++;
      return { rows, source_frame_ids: rows.map(r => r.frame_id), capture_start_ms: rows[0].start,
        capture_end_ms: rows.at(-1).end };
    }
    resetWindow() { this.rows = []; this.lastEnd = null; }
  }
  return { PointCapture, SAMPLES_PER_POINT, FRAMES_PER_SAMPLE, SETTLE_MS, MAX_FRAME_GAP_MS };
}));
