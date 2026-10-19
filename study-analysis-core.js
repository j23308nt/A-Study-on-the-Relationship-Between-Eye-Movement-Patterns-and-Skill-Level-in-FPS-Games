(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./validation-core.js"), require("./aim-core.js"));
  else root.StudyAnalysis = factory(root.GazeValidation, root.AimTaskCore);
}(typeof globalThis !== "undefined" ? globalThis : this, function (V, A) {
  "use strict";
  const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
  const sum = a => a.reduce((s, v) => s + v, 0);
  function stats(values) {
    const a = values.filter(Number.isFinite).sort((a, b) => a - b), n = a.length, avg = mean(a);
    const q = p => { const i = (n - 1) * p; return n ? a[Math.floor(i)] + (a[Math.ceil(i)] - a[Math.floor(i)]) * (i % 1) : null; };
    return { n, mean: avg, median: q(0.5), p95: q(0.95), min: n ? a[0] : null, max: n ? a[n - 1] : null,
      sd: n > 1 ? Math.sqrt(sum(a.map(v => (v - avg) ** 2)) / (n - 1)) : null };
  }
  function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
    return JSON.stringify(value ?? null);
  }
  function requireThat(ok, message) { if (!ok) throw new Error(message); }
  const finite = (...a) => a.every(Number.isFinite);
  function framesValid(frames, metadata) {
    requireThat(Array.isArray(frames) && frames.length <= 300000, "視線フレーム配列が不正、または30万件を超えています。");
    const seen = new Set();
    for (const f of frames) {
      requireThat(f && Number.isInteger(f.frame_id) && !seen.has(f.frame_id), "視線フレームIDが不正または重複しています。"); seen.add(f.frame_id);
      requireThat(finite(f.processing_start_ms, f.processing_end_ms) && f.processing_end_ms >= f.processing_start_ms, "視線の処理時刻が不正です。");
      requireThat(typeof f.valid === "boolean" && (!f.valid || finite(f.x, f.y, f.raw_x, f.raw_y)), "有効フレームの座標が不正です。");
      if (Number.isFinite(metadata.start_ms)) requireThat(f.processing_start_ms >= metadata.start_ms, "課題開始前のフレームが含まれています。");
    }
  }
  function normalize(data) {
    requireThat(data && [V.VERSION, A.VERSION].includes(data.schema), "正確度検証または的クリック課題の session.json を選択してください。");
    const m = data.metadata;
    requireThat(m && typeof m.run_id === "string" && m.run_id.length > 0 && m.run_id.length <= 128 &&
      typeof m.participant_id === "string" && m.participant_id.length > 0 && m.participant_id.length <= 128 &&
      Number.isInteger(m.session_number) && m.session_number > 0, "参加者・セッション・実行IDが不正です。");
    requireThat(data.summary && ["completed", "aborted"].includes(data.summary.status), "終了状態が不正です。");
    let result, kind;
    if (data.schema === V.VERSION) {
      kind = "validation";
      const s = new V.Session(m), trials = data.summary.trials;
      requireThat(Array.isArray(trials) && trials.length <= 27, "正確度検証の試行配列が不正です。");
      trials.forEach((t, i) => {
        requireThat(t && t.trial_id === i + 1 && V.POINTS.some(p => p.id === t.point_id) && ["completed", "aborted"].includes(t.status), "検証試行ID・位置・状態が不正です。");
        requireThat(finite(t.onset_ms, t.analysis_start_ms, t.analysis_end_ms, t.end_ms, t.target_x, t.target_y) &&
          t.end_ms >= t.onset_ms && Math.abs(t.analysis_start_ms - t.onset_ms - 1000) < 0.001 &&
          Math.abs(t.analysis_end_ms - t.onset_ms - 3000) < 0.001 && (t.status !== "completed" || t.end_ms >= t.analysis_end_ms), "検証試行の時刻・座標が不正です。");
      });
      framesValid(data.frames, m);
      s.trials = trials.map(t => ({ ...t }));
      s.frames = data.frames.map(f => {
        const t = trials[f.trial_id - 1];
        requireThat(t && f.trial_id === t.trial_id && f.point_id === t.point_id && f.processing_start_ms >= t.onset_ms && f.processing_start_ms < t.end_ms, "視線と検証試行の対応が不正です。");
        return { ...f, target_x: t.target_x, target_y: t.target_y,
          error_deg: f.valid ? V.angularError({ x: t.target_x, y: t.target_y }, { x: f.x, y: f.y }, m.geometry) : null,
          raw_error_deg: f.valid ? V.angularError({ x: t.target_x, y: t.target_y }, { x: f.raw_x, y: f.raw_y }, m.geometry) : null };
      });
      s.status = data.summary.status; result = s.export();
      requireThat(s.status !== "completed" || (trials.length === 27 && trials.every(t => t.status === "completed")), "完了状態と試行数が一致しません。");
    } else {
      kind = "aim";
      const s = new A.Session(m);
      requireThat(finite(m.start_ms, m.end_ms) && m.end_ms >= m.start_ms, "課題の開始・終了時刻が不正です。");
      requireThat(Array.isArray(data.trials) && data.trials.length <= m.trial_count && Array.isArray(data.clicks) && data.clicks.length <= 100000, "的クリック課題の配列が不正です。");
      data.trials.forEach((t, i) => {
        requireThat(t && t.trial_id === i + 1 && ["hit", "timeout", "aborted"].includes(t.status) &&
          finite(t.onset_ms, t.deadline_ms, t.end_ms, t.target_x, t.target_y, t.target_radius_px) && t.target_radius_px > 0 &&
          t.onset_ms >= m.start_ms && t.end_ms >= t.onset_ms && t.end_ms <= m.end_ms &&
          Math.abs(t.deadline_ms - t.onset_ms - m.timeout_ms) < 0.001, "的クリック試行の時刻・座標・状態が不正です。");
      });
      const ids = new Set();
      const clicks = data.clicks.map(c => {
        requireThat(c && Number.isInteger(c.click_id) && !ids.has(c.click_id) && finite(c.time_ms, c.x, c.y) &&
          c.time_ms >= m.start_ms && c.time_ms <= m.end_ms && ["hit", "miss", "late", "between_targets"].includes(c.outcome), "クリックID・時刻・結果が不正です。"); ids.add(c.click_id);
        const t = data.trials[c.trial_id - 1];
        if (c.outcome === "between_targets") requireThat(c.trial_id === null, "提示時間外クリックの試行IDが不正です。");
        else {
          requireThat(t && c.trial_id === t.trial_id && c.time_ms >= t.onset_ms && c.time_ms <= t.end_ms, "クリックと試行の対応が不正です。");
          if (c.outcome === "late") requireThat(c.time_ms >= t.deadline_ms, "受付時間外クリックの時刻が不正です。");
          else requireThat(c.time_ms < t.deadline_ms && (Math.hypot(c.x - t.target_x, c.y - t.target_y) <= t.target_radius_px) === (c.outcome === "hit"), "命中判定とクリック座標・時刻が一致しません。");
        }
        return { ...c, response_ms: t ? c.time_ms - t.onset_ms : null };
      });
      s.trials = data.trials.map(t => {
        const cs = clicks.filter(c => c.trial_id === t.trial_id && ["hit", "miss"].includes(c.outcome)).sort((a, b) => a.time_ms - b.time_ms);
        const hits = cs.filter(c => c.outcome === "hit");
        requireThat(hits.length === (t.status === "hit" ? 1 : 0), "試行結果と命中クリック数が一致しません。");
        return { ...t, first_click_ms: cs[0]?.response_ms ?? null, hit_response_ms: hits[0]?.response_ms ?? null, miss_clicks: cs.filter(c => c.outcome === "miss").length };
      });
      framesValid(data.gaze, m);
      requireThat(data.gaze.every(f => f.processing_start_ms < m.end_ms), "課題終了後の視線が含まれています。");
      A.checkCursor(data.cursor, m, s.trials);
      s.frames = data.gaze; s.clicks = clicks; s.cursor = data.cursor || []; s.status = data.summary.status;
      requireThat(s.status !== "completed" || (s.trials.length === m.trial_count && s.trials.every(t => t.status !== "aborted")), "完了状態と試行数が一致しません。");
      result = s.export();
    }
    const summary = result.summary, validTrials = kind === "validation" ? summary.trials.filter(t => t.status === "completed") : result.trials;
    const processed = kind === "validation" ? sum(validTrials.map(t => t.processed_frames)) : summary.processed_gaze_frames;
    const invalid = kind === "validation" ? sum(validTrials.map(t => t.invalid_frames)) : processed - summary.valid_gaze_frames;
    const complete = kind === "validation" ? summary.data_complete : summary.status === "completed";
    const run = { id: m.run_id, participant: m.participant_id, session: m.session_number, head: ["fixed", "free"].includes(m.head_condition) ? m.head_condition : "unknown",
      kind, complete, status: summary.status, data: result, metadata: result.metadata,
      primary: kind === "validation" ? summary.mean_error_deg : summary.mean_hit_response_ms,
      invalid_fraction: processed ? invalid / processed : null,
      valid_samples: kind === "validation" ? sum(summary.positions.map(p => p.valid_samples)) : summary.valid_gaze_frames,
      processed_frames: processed };
    run.conditions = conditions(run);
    run.conditionKnown = run.head !== "unknown" && typeof m.tracker?.five_point_correction_applied === "boolean" &&
      !!m.source_sha256 && Object.keys(m.source_sha256).length > 0;
    run.signature = stable(run.conditions);
    return run;
  }
  function conditions(run) {
    const m = run.metadata;
    return { kind: run.kind, head_condition: run.head, vision: m.vision ?? null,
      geometry: m.geometry ?? { width_cm: m.width_cm, height_cm: m.height_cm, distance_cm: m.distance_cm,
        viewport_width: m.viewport_width, viewport_height: m.viewport_height },
      device_pixel_ratio: m.device_pixel_ratio, screen_css: m.browser_screen_css, screen_pixels: m.declared_screen_pixels,
      os_scale: m.os_scale_note, zoom: m.browser_zoom_note, environment: m.environment_notes, user_agent: m.user_agent,
      camera: m.tracker?.camera_label, camera_settings: m.tracker?.camera_settings, smoothing: m.tracker?.smoothing,
      five_point_correction_applied: m.tracker?.five_point_correction_applied, source_sha256: m.source_sha256,
      angular_error_reference: m.angular_error_reference, render_gap_abort_ms: m.render_gap_abort_ms,
      task: run.kind === "aim" ? { trial_count: m.trial_count, diameter_px: m.target_diameter_px, timeout_ms: m.timeout_ms,
        seed: m.seed, inter_target_gap_ms: m.inter_target_gap_ms, response_clock: m.response_clock, cursor_recording: m.cursor_recording } :
        { trial_ms: m.trial_ms, settle_ms: m.settle_ms, planned_trials: m.planned_trials, target_size: m.target_size, target_clock: m.target_clock } };
  }
  function groups(runs) {
    const map = new Map();
    for (const r of runs) {
      const key = stable([r.participant, r.signature, r.conditionKnown ? null : r.id]);
      if (!map.has(key)) map.set(key, { participant: r.participant, head: r.head, kind: r.kind, runs: [] });
      map.get(key).runs.push(r);
    }
    return [...map.values()].map(g => {
      const ids = g.runs.map(r => r.session), duplicate = new Set(ids).size !== ids.length;
      const eligible = g.runs.filter(r => r.complete);
      const blocked = duplicate || !g.runs[0].conditionKnown;
      const primary = stats(blocked ? [] : eligible.map(r => r.primary));
      return { ...g, duplicate, blocked, eligible: eligible.length, primary,
        note: duplicate ? "同じ回の複数実行：集計しません" : !g.runs[0].conditionKnown ? "条件情報不足：個別表示のみ" :
          eligible.length < g.runs.length ? "中断・欠測を集計から除外" : "完了セッションのみ・等重み" };
    });
  }
  function histogram(values, count = 10) {
    const a = values.filter(Number.isFinite);
    if (!a.length) return [];
    const lo = a.reduce((m, v) => Math.min(m, v), Infinity), hi = a.reduce((m, v) => Math.max(m, v), -Infinity);
    const width = hi === lo ? Math.max(1, Math.abs(lo) * 0.02) : (hi - lo) / count;
    const n = hi === lo ? 1 : count;
    const bins = Array.from({ length: n }, (_, i) => ({ low: lo + width * i, high: lo + width * (i + 1), count: 0 }));
    for (const v of a) bins[Math.min(n - 1, Math.floor((v - lo) / width))].count++;
    return bins;
  }
  function exportRows(runs) {
    return runs.map(r => ({ run_id: r.id, task_type: r.kind, participant_id: r.participant, session_number: r.session,
      head_condition: r.head, status: r.status, complete: r.complete,
      five_point_correction_applied: r.metadata.tracker?.five_point_correction_applied ?? null,
      mean_error_deg: r.kind === "validation" ? r.primary : null,
      raw_mean_error_deg: r.kind === "validation" ? r.data.summary.raw_mean_error_deg : null,
      mean_hit_response_ms: r.kind === "aim" ? r.primary : null,
      median_hit_response_ms: r.kind === "aim" ? r.data.summary.median_hit_response_ms : null,
      hits: r.kind === "aim" ? r.data.summary.hits : null, timeouts: r.kind === "aim" ? r.data.summary.timeouts : null,
      miss_clicks: r.kind === "aim" ? r.data.summary.miss_clicks : null,
      click_hit_fraction: r.kind === "aim" ? r.data.summary.click_hit_fraction : null,
      invalid_fraction: r.invalid_fraction, valid_samples: r.valid_samples, processed_frames: r.processed_frames,
      condition_signature: r.signature }));
  }
  return { normalize, stats, stable, conditions, groups, histogram, exportRows };
}));
