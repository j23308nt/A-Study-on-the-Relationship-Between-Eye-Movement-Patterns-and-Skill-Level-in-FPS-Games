(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AimTaskCore = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const VERSION = "gaze-aim-1.0.0";
  const CURSOR_INTERVAL_MS = 1000 / 60;
  const average = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
  function checkConfig(c) {
    for (const [key, min, max] of [["trial_count", 1, 100], ["target_diameter_px", 16, 160],
      ["timeout_ms", 500, 10000], ["viewport_width", 320, 20000], ["viewport_height", 320, 20000]]) {
      if (!Number.isInteger(c[key]) || c[key] < min || c[key] > max) throw new Error(`課題設定が不正です: ${key}`);
    }
    if (!Number.isInteger(c.seed) || c.seed < 0 || c.seed > 0xffffffff) throw new Error("乱数シードが不正です。");
    return c;
  }
  function createOrder(config) {
    const c = checkConfig(config);
    let seed = c.seed >>> 0;
    const random = () => {
      seed += 0x6D2B79F5;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
    const mx = c.target_diameter_px / 2 + 20;
    const my = c.target_diameter_px / 2 + 20;
    return Array.from({ length: c.trial_count }, (_, i) => ({ trial_id: i + 1,
      target_x: mx + random() * (c.viewport_width - 2 * mx),
      target_y: my + random() * (c.viewport_height - 2 * my),
      target_radius_px: c.target_diameter_px / 2, gap_after_ms: 500 + Math.floor(random() * 501) }));
  }
  class Session {
    constructor(metadata) {
      checkConfig(metadata);
      this.metadata = JSON.parse(JSON.stringify(metadata));
      this.order = createOrder(metadata);
      this.trials = []; this.clicks = []; this.frames = []; this.events = [];
      this.cursor = []; this.lastCursorMoveMs = -Infinity;
      this.seen = new Set(); this.status = "running";
    }
    current() { return this.trials.find(t => t.status === "active") || null; }
    present(now) {
      if (this.status !== "running" || this.current() || this.trials.length >= this.order.length) throw new Error("的を提示できません。");
      const t = { ...this.order[this.trials.length], onset_ms: now, deadline_ms: now + this.metadata.timeout_ms,
        end_ms: null, status: "active", first_click_ms: null, hit_response_ms: null, miss_clicks: 0 };
      this.trials.push(t);
      this.events.push({ type: "target_presented", time_ms: now, trial_id: t.trial_id });
      return t;
    }
    close(now, status) {
      const t = this.current();
      if (!t) return;
      t.status = status; t.end_ms = now;
      this.events.push({ type: "target_ended", time_ms: now, trial_id: t.trial_id, status });
    }
    expire(now) {
      if (this.current() && now >= this.current().deadline_ms) { this.close(now, "timeout"); return true; }
      return false;
    }
    click(now, x, y, eventTimestamp = null) {
      if (this.status !== "running" || ![now, x, y].every(Number.isFinite)) return null;
      const t = this.current();
      let outcome = "between_targets";
      const response = t ? now - t.onset_ms : null;
      if (t && now >= t.deadline_ms) { this.close(now, "timeout"); outcome = "late"; }
      else if (t) {
        if (t.first_click_ms === null) t.first_click_ms = response;
        outcome = Math.hypot(x - t.target_x, y - t.target_y) <= t.target_radius_px ? "hit" : "miss";
        if (outcome === "hit") { t.hit_response_ms = response; this.close(now, "hit"); }
        else t.miss_clicks++;
      }
      const click = { click_id: this.clicks.length + 1, time_ms: now, event_timestamp_ms: eventTimestamp,
        trial_id: t?.trial_id ?? null, x, y, response_ms: response, outcome,
        target_x: t?.target_x ?? null, target_y: t?.target_y ?? null };
      this.clicks.push(click);
      return click;
    }
    recordCursor(point) {
      if (this.status !== "running" || !point || ![point.time_ms, point.x, point.y].every(Number.isFinite) ||
          point.time_ms < this.metadata.start_ms || !["move", "button_down"].includes(point.sample_kind)) return false;
      if (this.cursor.length && point.time_ms < this.cursor[this.cursor.length - 1].time_ms) return false;
      if (point.sample_kind === "move") {
        if (point.time_ms - this.lastCursorMoveMs < CURSOR_INTERVAL_MS) return false;
        this.lastCursorMoveMs = point.time_ms;
      }
      const t = this.current();
      this.cursor.push({ sample_id: this.cursor.length + 1, time_ms: point.time_ms,
        event_timestamp_ms: Number.isFinite(point.event_timestamp_ms) ? point.event_timestamp_ms : null,
        elapsed_ms: point.time_ms - this.metadata.start_ms, x: point.x, y: point.y,
        buttons: Number.isInteger(point.buttons) ? point.buttons : 0, sample_kind: point.sample_kind,
        trial_id: t?.trial_id ?? null, target_x: t?.target_x ?? null, target_y: t?.target_y ?? null,
        target_onset_ms: t?.onset_ms ?? null, time_from_target_ms: t ? point.time_ms - t.onset_ms : null });
      return true;
    }
    recordFrame(f) {
      if (this.seen.has(f.frame_id) || !Number.isFinite(f.processing_start_ms) ||
          f.processing_start_ms < this.metadata.start_ms ||
          (this.metadata.end_ms !== undefined && f.processing_start_ms >= this.metadata.end_ms)) return false;
      this.seen.add(f.frame_id);
      const valid = Boolean(f.valid && [f.x, f.y, f.raw_x, f.raw_y].every(Number.isFinite));
      this.frames.push({ ...f, valid, failure_reason: valid ? "" : (f.failure_reason || "nonfinite_prediction") });
      return true;
    }
    finish(now, reason = "") {
      if (this.status !== "running") return;
      this.close(now, "aborted");
      this.status = !reason && this.trials.length === this.order.length && this.trials.every(t => ["hit", "timeout"].includes(t.status))
        ? "completed" : "aborted";
      this.metadata.end_ms = now; this.metadata.stop_reason = reason;
      this.events.push({ type: this.status, time_ms: now, reason });
    }
    export() {
      const gaze = this.frames.map(f => {
        const t = this.trials.find(t => f.processing_start_ms >= t.onset_ms && f.processing_start_ms < t.end_ms);
        return { ...f, elapsed_ms: f.processing_start_ms - this.metadata.start_ms, trial_id: t?.trial_id ?? null,
          target_x: t?.target_x ?? null, target_y: t?.target_y ?? null,
          target_onset_ms: t?.onset_ms ?? null, time_from_target_ms: t ? f.processing_start_ms - t.onset_ms : null,
          crosses_target_end: Boolean(t && f.processing_end_ms > t.end_ms) };
      });
      const trials = this.trials.map(t => {
        const frames = gaze.filter(f => f.trial_id === t.trial_id);
        return { ...t, processed_frames: frames.length, valid_gaze_samples: frames.filter(f => f.valid && !f.crosses_target_end).length };
      });
      const times = trials.filter(t => t.status === "hit").map(t => t.hit_response_ms).sort((a, b) => a - b);
      const hits = times.length, misses = this.clicks.filter(c => c.outcome === "miss").length;
      const summary = { status: this.status, planned_trials: this.order.length, presented_trials: trials.length,
        hits, timeouts: trials.filter(t => t.status === "timeout").length,
        aborted_trials: trials.filter(t => t.status === "aborted").length,
        miss_clicks: misses, outside_window_clicks: this.clicks.filter(c => ["between_targets", "late"].includes(c.outcome)).length,
        mean_hit_response_ms: average(times), median_hit_response_ms: times.length ? (times[Math.floor((times.length - 1) / 2)] + times[Math.ceil((times.length - 1) / 2)]) / 2 : null,
        click_hit_fraction: hits + misses ? hits / (hits + misses) : null,
        processed_gaze_frames: gaze.length, valid_gaze_frames: gaze.filter(f => f.valid).length,
        cursor_samples: this.metadata.cursor_recording || this.cursor.length ? this.cursor.length : null };
      return JSON.parse(JSON.stringify({ schema: VERSION, metadata: this.metadata, order: this.order,
        trials, clicks: this.clicks, gaze, ...(this.metadata.cursor_recording || this.cursor.length ? { cursor: this.cursor } : {}), events: this.events, summary }));
    }
  }
  function exportFiles(bundle, csv) {
    const id = { run_id: bundle.metadata.run_id, participant_id: bundle.metadata.participant_id,
      session_number: bundle.metadata.session_number, head_condition: bundle.metadata.head_condition,
      five_point_correction_applied: bundle.metadata.tracker?.five_point_correction_applied };
    const table = (rows, defaults) => csv(rows.map(r => ({ ...id, ...r })), [...Object.keys(id), ...new Set([...defaults, ...rows.flatMap(Object.keys)])]);
    return { "session.json": JSON.stringify(bundle, null, 2),
      ...(Array.isArray(bundle.cursor) ? { "cursor.csv": table(bundle.cursor, ["sample_id", "time_ms", "event_timestamp_ms", "elapsed_ms", "trial_id", "x", "y", "buttons", "sample_kind", "target_x", "target_y", "target_onset_ms", "time_from_target_ms"]) } : {}),
      "trials.csv": table(bundle.trials, ["trial_id", "status", "onset_ms", "end_ms", "hit_response_ms"]),
      "clicks.csv": table(bundle.clicks, ["click_id", "trial_id", "time_ms", "x", "y", "outcome", "response_ms"]),
      "gaze.csv": table(bundle.gaze, ["frame_id", "trial_id", "processing_start_ms", "processing_end_ms", "x", "y", "raw_x", "raw_y", "valid", "failure_reason"]) };
  }
  function checkCursor(cursor, metadata, trials) {
    if (cursor === undefined) {
      if (metadata.cursor_recording) throw new Error("カーソルの記録配列がありません。");
      return;
    }
    if (!Array.isArray(cursor) || cursor.length > 300000) throw new Error("カーソルの記録配列が不正です。");
    let previous = -Infinity;
    cursor.forEach((p, i) => {
      if (!p || p.sample_id !== i + 1 || ![p.time_ms, p.x, p.y].every(Number.isFinite) ||
          p.time_ms < metadata.start_ms || p.time_ms > metadata.end_ms || p.time_ms < previous ||
          !["move", "button_down"].includes(p.sample_kind)) throw new Error("カーソルの座標・時刻が不正です。");
      previous = p.time_ms;
      if (p.trial_id !== null) {
        const t = trials[p.trial_id - 1];
        if (!t || t.trial_id !== p.trial_id || p.time_ms < t.onset_ms || p.time_ms > t.end_ms) throw new Error("カーソルと試行の対応が不正です。");
      }
    });
  }
  return { VERSION, CURSOR_INTERVAL_MS, Session, createOrder, checkConfig, checkCursor, exportFiles };
}));
