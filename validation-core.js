(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.GazeValidation = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const VERSION = "gaze-validation-1.0.0";
  const SETTLE_MS = 1000;
  const TRIAL_MS = 3000;
  const POINTS = [0.12, 0.5, 0.88].flatMap((y, row) =>
    [0.12, 0.5, 0.88].map((x, column) => ({ id: `V${row * 3 + column + 1}`, x, y })));
  const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  function percentile(values, fraction) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const index = (sorted.length - 1) * fraction;
    return sorted[Math.floor(index)] + (sorted[Math.ceil(index)] - sorted[Math.floor(index)]) * (index % 1);
  }
  function checkGeometry(g) {
    for (const key of ["width_cm", "height_cm", "distance_cm", "viewport_width", "viewport_height"]) {
      if (!Number.isFinite(g[key]) || g[key] <= 0) throw new Error(`表示条件が不正です: ${key}`);
    }
    return g;
  }
  function angularError(target, gaze, geometry) {
    checkGeometry(geometry);
    if (![target.x, target.y, gaze.x, gaze.y].every(Number.isFinite)) return null;
    const vector = p => [(p.x / geometry.viewport_width - 0.5) * geometry.width_cm,
      (0.5 - p.y / geometry.viewport_height) * geometry.height_cm, geometry.distance_cm];
    const a = vector(target), b = vector(gaze);
    const cross = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    return Math.atan2(Math.hypot(...cross), a.reduce((sum, v, i) => sum + v * b[i], 0)) * 180 / Math.PI;
  }
  function createOrder(seed) {
    let s = seed >>> 0;
    const random = () => {
      s += 0x6D2B79F5;
      let t = Math.imul(s ^ s >>> 15, 1 | s);
      t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
    const order = [];
    for (let block = 1; block <= 3; block++) {
      const points = POINTS.map(p => ({ ...p }));
      for (let i = points.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [points[i], points[j]] = [points[j], points[i]];
      }
      if (order.length && points[0].id === order[order.length - 1].point_id) {
        [points[0], points[1]] = [points[1], points[0]];
      }
      for (const point of points) order.push({ trial_id: order.length + 1, block,
        point_id: point.id, target_x_ratio: point.x, target_y_ratio: point.y });
    }
    return order;
  }
  class Session {
    constructor(metadata) {
      checkGeometry(metadata.geometry);
      this.metadata = JSON.parse(JSON.stringify({ ...metadata, version: VERSION,
        settle_ms: SETTLE_MS, trial_ms: TRIAL_MS, planned_trials: 27 }));
      this.order = createOrder(metadata.seed);
      this.trials = [];
      this.frames = [];
      this.events = [];
      this.seenFrames = new Set();
      this.status = "running";
    }
    startTrial(onset) {
      if (this.status !== "running" || this.trials.some(t => t.status === "running") || this.trials.length >= 27) {
        throw new Error("検証試行を開始できません。");
      }
      const item = this.order[this.trials.length];
      const g = this.metadata.geometry;
      const trial = { ...item, target_x: item.target_x_ratio * g.viewport_width,
        target_y: item.target_y_ratio * g.viewport_height, onset_ms: onset,
        analysis_start_ms: onset + SETTLE_MS, analysis_end_ms: onset + TRIAL_MS,
        end_ms: null, status: "running", reason: "" };
      this.trials.push(trial);
      return trial;
    }
    endTrial(end, status = "completed", reason = "") {
      const trial = this.trials[this.trials.length - 1];
      if (!trial || trial.status !== "running") return;
      trial.end_ms = end;
      trial.status = status;
      trial.reason = reason;
    }
    finish(time, reason = "") {
      this.endTrial(time, "aborted", reason || "early_end");
      this.status = !reason && this.trials.length === 27 && this.trials.every(t => t.status === "completed")
        ? "completed" : "aborted";
      this.metadata.end_ms = time;
      this.metadata.stop_reason = reason;
      this.events.push({ time_ms: time, type: this.status, reason });
    }
    recordFrame(frame) {
      if (this.seenFrames.has(frame.frame_id)) return false;
      this.seenFrames.add(frame.frame_id);
      const trial = this.trials.find(t => frame.processing_start_ms >= t.onset_ms &&
        frame.processing_start_ms < (t.end_ms === null ? t.analysis_end_ms : t.end_ms));
      if (!trial) return false;
      const valid = frame.valid && [frame.raw_x, frame.raw_y, frame.x, frame.y].every(Number.isFinite);
      const g = this.metadata.geometry;
      this.frames.push({ ...frame, valid: Boolean(valid), failure_reason: valid ? "" : (frame.failure_reason || "nonfinite_prediction"),
        trial_id: trial.trial_id, block: trial.block, point_id: trial.point_id,
        target_x: trial.target_x, target_y: trial.target_y, target_onset_ms: trial.onset_ms,
        raw_error_deg: valid ? angularError({ x: trial.target_x, y: trial.target_y }, { x: frame.raw_x, y: frame.raw_y }, g) : null,
        error_deg: valid ? angularError({ x: trial.target_x, y: trial.target_y }, { x: frame.x, y: frame.y }, g) : null });
      return true;
    }
    decoratedFrames() {
      return this.frames.map(f => {
        const t = this.trials[f.trial_id - 1];
        const inWindow = f.processing_start_ms >= t.analysis_start_ms && f.processing_start_ms < t.analysis_end_ms;
        const boundary = f.processing_end_ms > Math.min(t.analysis_end_ms, t.end_ms ?? t.analysis_end_ms);
        return { ...f, trial_status: t.status, in_analysis_window: inWindow,
          crosses_trial_end: boundary, included_in_analysis: t.status === "completed" && inWindow && !boundary && f.valid };
      });
    }
    summarize() {
      const frames = this.decoratedFrames();
      const trialRows = this.trials.map(t => {
        const windowFrames = frames.filter(f => f.trial_id === t.trial_id && f.in_analysis_window);
        const usable = windowFrames.filter(f => f.included_in_analysis);
        const times = [t.analysis_start_ms, ...usable.map(f => f.processing_start_ms).sort((a, b) => a - b), t.analysis_end_ms];
        return { ...t, processed_frames: windowFrames.length, valid_samples: usable.length,
          invalid_frames: windowFrames.filter(f => !f.valid).length,
          boundary_frames: windowFrames.filter(f => f.crosses_trial_end).length,
          invalid_fraction: windowFrames.length ? windowFrames.filter(f => !f.valid).length / windowFrames.length : null,
          mean_error_deg: mean(usable.map(f => f.error_deg)), p95_error_deg: percentile(usable.map(f => f.error_deg), 0.95),
          raw_mean_error_deg: mean(usable.map(f => f.raw_error_deg)), raw_p95_error_deg: percentile(usable.map(f => f.raw_error_deg), 0.95),
          valid_samples_per_second: t.status === "completed" ? usable.length / 2 : null,
          max_valid_gap_ms: t.status === "completed" ? Math.max(...times.slice(1).map((time, i) => time - times[i])) : null };
      });
      const positions = POINTS.map(p => {
        const trials = trialRows.filter(t => t.point_id === p.id);
        const usable = frames.filter(f => f.point_id === p.id && f.included_in_analysis);
        const processed = trials.filter(t => t.status === "completed").reduce((sum, t) => sum + t.processed_frames, 0);
        const invalid = trials.filter(t => t.status === "completed").reduce((sum, t) => sum + t.invalid_frames, 0);
        return { point_id: p.id, target_x_ratio: p.x, target_y_ratio: p.y,
          completed_trials: trials.filter(t => t.status === "completed").length,
          trials_with_data: trials.filter(t => t.mean_error_deg !== null).length,
          mean_error_deg: mean(trials.map(t => t.mean_error_deg).filter(v => v !== null)),
          p95_error_deg: percentile(usable.map(f => f.error_deg), 0.95),
          raw_mean_error_deg: mean(trials.map(t => t.raw_mean_error_deg).filter(v => v !== null)),
          raw_p95_error_deg: percentile(usable.map(f => f.raw_error_deg), 0.95),
          valid_samples: usable.length, processed_frames: processed,
          invalid_fraction: processed ? invalid / processed : null };
      });
      const dataComplete = this.status === "completed" && positions.every(p => p.trials_with_data === 3);
      return { status: this.status, data_complete: dataComplete, participant_id: this.metadata.participant_id,
        session_number: this.metadata.session_number, run_id: this.metadata.run_id,
        mean_error_deg: dataComplete ? mean(positions.map(p => p.mean_error_deg)) : null,
        raw_mean_error_deg: dataComplete ? mean(positions.map(p => p.raw_mean_error_deg)) : null,
        trials: trialRows, positions };
    }
    export() {
      return { schema: VERSION, metadata: this.metadata, order: this.order, events: this.events,
        summary: this.summarize(), frames: this.decoratedFrames() };
    }
  }
  function csv(rows, columns) {
    const escape = value => {
      if (value === null || value === undefined) return "";
      let text = typeof value === "object" ? JSON.stringify(value) : String(value);
      if (typeof value === "string" && /^[=+\-@]/.test(text)) text = "'" + text;
      return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    };
    return [columns.join(","), ...rows.map(row => columns.map(key => escape(row[key])).join(","))].join("\r\n");
  }
  function exportFiles(bundle) {
    const identity = { run_id: bundle.metadata.run_id, participant_id: bundle.metadata.participant_id,
      session_number: bundle.metadata.session_number, vision: bundle.metadata.vision,
      head_condition: bundle.metadata.head_condition ?? null,
      angular_error_reference: bundle.metadata.angular_error_reference ?? null,
      five_point_correction_applied: bundle.metadata.tracker?.five_point_correction_applied ?? null };
    const withId = rows => rows.map(row => ({ ...identity, ...row }));
    const sampleColumns = ["frame_id", "video_time_s", "video_frame_number", "video_expected_display_ms", "frame_source", "processing_start_ms", "processing_end_ms", "trial_id", "block", "point_id",
      "target_x", "target_y", "target_onset_ms", "raw_x", "raw_y", "x", "y", "valid", "failure_reason", "face_detected", "features_detected",
      "error_deg", "raw_error_deg", "trial_status", "in_analysis_window", "crosses_trial_end", "included_in_analysis"];
    return { "session.json": JSON.stringify(bundle, null, 2),
      "samples.csv": csv(withId(bundle.frames), [...Object.keys(identity), ...sampleColumns]),
      "trials.csv": csv(withId(bundle.summary.trials), [...Object.keys(identity), ...Object.keys(bundle.summary.trials[0] || { trial_id: "", status: "" })]),
      "positions.csv": csv(withId(bundle.summary.positions), [...Object.keys(identity), ...Object.keys(bundle.summary.positions[0])]) };
  }
  return { VERSION, POINTS, SETTLE_MS, TRIAL_MS, angularError, createOrder, Session, csv, exportFiles };
}));
