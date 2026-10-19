(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AimReplay = factory();
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const GAP_MS = 200, TRAIL_MS = 1000, CLICK_MS = 300;
  // First sample strictly after time; never show a future sample when seeking.
  function upperBound(samples, time) {
    let lo = 0, hi = samples.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (samples[mid].time <= time) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function segments(samples, from, to, raw = false) {
    const end = upperBound(samples, to), start = upperBound(samples, from - 0.000001);
    const result = []; let segment = [], previous = null;
    for (let i = start; i < end; i++) {
      const p = samples[i], x = raw ? p.raw_x : p.x, y = raw ? p.raw_y : p.y;
      if (!p.valid || !Number.isFinite(x) || !Number.isFinite(y)) {
        if (segment.length) result.push(segment); segment = []; previous = null; continue;
      }
      if (previous && p.time - previous.time > GAP_MS) { if (segment.length) result.push(segment); segment = []; }
      segment.push({ x, y, time: p.time }); previous = p;
    }
    if (segment.length) result.push(segment);
    return result;
  }
  class Replay {
    constructor(bundle) {
      if (!bundle || bundle.schema !== "gaze-aim-1.0.0" || !Number.isFinite(bundle.metadata?.start_ms) ||
          !Number.isFinite(bundle.metadata.end_ms) || bundle.metadata.end_ms < bundle.metadata.start_ms) throw new Error("再生できる課題記録ではありません。");
      this.start = bundle.metadata.start_ms; this.end = bundle.metadata.end_ms;
      this.width = bundle.metadata.viewport_width; this.height = bundle.metadata.viewport_height;
      this.hasCursor = Array.isArray(bundle.cursor);
      this.trials = bundle.trials;
      this.gaze = bundle.gaze.map(f => ({ time: f.processing_end_ms, x: f.x, y: f.y, raw_x: f.raw_x, raw_y: f.raw_y, valid: f.valid }))
        .filter(p => Number.isFinite(p.time)).sort((a, b) => a.time - b.time);
      this.cursor = (bundle.cursor || []).map(p => ({ time: p.time_ms, x: p.x, y: p.y, valid: true })).sort((a, b) => a.time - b.time);
      this.clicks = bundle.clicks.map(c => ({ ...c, time: c.time_ms })).sort((a, b) => a.time - b.time);
    }
    range(trialId = null) {
      const t = trialId === null ? null : this.trials.find(t => t.trial_id === trialId);
      return t ? { start: t.onset_ms, end: t.end_ms } : { start: this.start, end: this.end };
    }
    at(time, { raw = false, rangeStart = this.start } = {}) {
      const now = Math.max(this.start, Math.min(this.end, time));
      const latest = a => a[upperBound(a, now) - 1] || null;
      const gaze = latest(this.gaze), cursor = latest(this.cursor);
      const gx = raw ? gaze?.raw_x : gaze?.x, gy = raw ? gaze?.raw_y : gaze?.y;
      const gazeVisible = gaze?.valid && now - gaze.time <= GAP_MS && Number.isFinite(gx) && Number.isFinite(gy);
      const target = this.trials.find(t => now >= t.onset_ms && now < t.end_ms) || null;
      const from = Math.max(rangeStart, now - TRAIL_MS);
      return { time: now, elapsed_ms: now - this.start, target,
        phase: now >= this.end ? "終了" : target ? `試行 ${target.trial_id}` :
          (!this.trials.length || now < this.trials[0].onset_ms) ? "的の提示前" : "的の間の空白",
        gaze: gazeVisible ? { x: gx, y: gy, age_ms: now - gaze.time } : null,
        gaze_status: !gaze ? "未取得" : !gaze.valid ? "未検出" : now - gaze.time > GAP_MS ? "200ms超の取得空白" : "表示中",
        cursor: cursor ? { x: cursor.x, y: cursor.y, age_ms: now - cursor.time } : null,
        gaze_trail: segments(this.gaze, from, now, raw), cursor_trail: segments(this.cursor, from, now),
        clicks: this.clicks.slice(upperBound(this.clicks, Math.max(rangeStart, now - CLICK_MS) - 0.000001), upperBound(this.clicks, now)) };
    }
  }
  return { Replay, upperBound, segments, GAP_MS, TRAIL_MS, CLICK_MS };
}));
