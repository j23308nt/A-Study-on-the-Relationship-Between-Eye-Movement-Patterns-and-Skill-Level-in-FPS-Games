(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShootingStudy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SCHEMA = 'gaze-shooting-1.0.0';
  const DURATION = 60000, CADENCE = 160;
  const finite = Number.isFinite;
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  function percentile(a, p = .95) {
    if (!a.length) return null;
    const b = [...a].sort((x, y) => x - y), i = (b.length - 1) * p;
    return b[Math.floor(i)] + (b[Math.ceil(i)] - b[Math.floor(i)]) * (i % 1);
  }
  function random(seed) {
    let value = seed >>> 0;
    return () => { value += 0x6D2B79F5; let t = Math.imul(value ^ value >>> 15, value | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  function before(frames, time) {
    let lo = 0, hi = frames.length - 1, found = null;
    while (lo <= hi) { const mid = (lo + hi) >>> 1;
      if (frames[mid].render_end_ms <= time) { found = frames[mid]; lo = mid + 1; } else hi = mid - 1; }
    return found;
  }
  function insideSphere(f, x, y, width, height) {
    if (!f || !f.target_visible || ![x, y].every(finite)) return false;
    const t = Math.tan(f.fov_deg * Math.PI / 360);
    let vx = (2 * x / width - 1) * t * width / height, vy = (1 - 2 * y / height) * t, vz = -1;
    const n = Math.hypot(vx, vy, vz); vx /= n; vy /= n; vz /= n;
    const { qx, qy, qz, qw } = f;
    const ix = qw * vx + qy * vz - qz * vy, iy = qw * vy + qz * vx - qx * vz;
    const iz = qw * vz + qx * vy - qy * vx, iw = -qx * vx - qy * vy - qz * vz;
    const dx = ix * qw - iw * qx - iy * qz + iz * qy;
    const dy = iy * qw - iw * qy - iz * qx + ix * qz;
    const dz = iz * qw - iw * qz - ix * qy + iy * qx;
    const cx = f.target_x - f.camera_x, cy = f.target_y - f.camera_y, cz = f.target_z - f.camera_z;
    const b = cx * dx + cy * dy + cz * dz;
    return b >= 0 && b * b >= cx * cx + cy * cy + cz * cz - f.target_radius * f.target_radius;
  }
  class Session {
    constructor(metadata) {
      if (!metadata.run_id || ![metadata.start_ms, metadata.viewport_width, metadata.viewport_height].every(finite)) throw Error('記録条件が不正です。');
      this.metadata = JSON.parse(JSON.stringify(metadata));
      this.frames = []; this.gaze = []; this.targets = []; this.shots = []; this.events = [];
      this.seen = new Set(); this.lastAccepted = -Infinity; this.stopped = false;
      this.event('countdown_start', metadata.start_ms);
    }
    event(type, time_ms, extra = {}) { this.events.push({ type, time_ms, ...extra }); }
    startGame(now) {
      if (this.metadata.game_start_ms !== undefined || this.stopped) throw Error('開始済みです。');
      this.metadata.game_start_ms = now; this.metadata.deadline_ms = now + DURATION;
      this.event('game_start', now);
    }
    spawn(now, point, radius) {
      if (this.stopped || this.current()) throw Error('前の球が終了していません。');
      const t = { target_id: this.targets.length + 1, spawn_requested_ms: now, onset_ms: null, end_ms: null,
        status: 'pending', x: point.x, y: point.y, z: point.z, radius, first_shot_ms: null,
        hit_ms: null, miss_shots: 0 };
      this.targets.push(t); this.event('spawn_requested', now, { target_id: t.target_id }); return t;
    }
    current() { const t = this.targets.at(-1); return t && ['pending', 'visible'].includes(t.status) ? t : null; }
    render(start, end, pose, visible) {
      if (this.stopped) return;
      const t = this.current();
      if (t && visible && t.onset_ms === null) { t.onset_ms = end; t.status = 'visible'; this.event('target_first_render', end, { target_id: t.target_id }); }
      const frame = { frame_id: this.frames.length + 1, render_start_ms: start, render_end_ms: end,
        phase: this.metadata.game_start_ms === undefined ? 'countdown' : 'game',
        target_id: t && visible ? t.target_id : null, target_visible: Boolean(t && visible), ...pose };
      this.frames.push(frame); return frame;
    }
    gazeFrame(frame) {
      if (this.seen.has(frame.frame_id) || !finite(frame.processing_start_ms) || frame.processing_start_ms < this.metadata.start_ms ||
          (this.metadata.end_ms !== undefined && frame.processing_start_ms >= this.metadata.end_ms)) return;
      this.seen.add(frame.frame_id);
      const valid = Boolean(frame.valid && [frame.x, frame.y, frame.raw_x, frame.raw_y].every(finite));
      this.gaze.push({ ...frame, valid });
    }
    shoot(now, pose, hit, eventTimestamp = null) {
      const t = this.current();
      let reason = '';
      if (this.stopped || this.metadata.game_start_ms === undefined || now >= this.metadata.deadline_ms) reason = 'outside_window';
      else if (!t || t.onset_ms === null || now < t.onset_ms) reason = 'before_first_render';
      else if (now - this.lastAccepted < CADENCE) reason = 'cooldown';
      const accepted = !reason;
      const shot = { shot_id: this.shots.length + 1, time_ms: now, event_timestamp_ms: eventTimestamp,
        target_id: t?.target_id ?? null, rendered_frame_id: this.frames.at(-1)?.frame_id ?? null,
        accepted, outcome: accepted ? (hit ? 'hit' : 'miss') : reason, ...pose };
      this.shots.push(shot);
      if (accepted) {
        this.lastAccepted = now;
        if (t.first_shot_ms === null) t.first_shot_ms = now;
        if (hit) { t.status = 'hit'; t.end_ms = now; t.hit_ms = now; this.event('target_hit', now, { target_id: t.target_id }); }
        else t.miss_shots++;
      }
      return shot;
    }
    finish(now, reason = '') {
      if (this.stopped) return;
      const start = this.metadata.game_start_ms;
      const completed = !reason && start !== undefined && now >= this.metadata.deadline_ms;
      this.metadata.end_ms = completed ? this.metadata.deadline_ms : now;
      this.metadata.stop_reason = reason || (completed ? 'duration_complete' : 'early_end');
      this.metadata.status = completed ? 'completed' : 'aborted';
      const t = this.current();
      if (t) { t.end_ms = this.metadata.end_ms; t.status = completed ? 'unfinished' : 'aborted'; }
      this.stopped = true; this.event('game_end', this.metadata.end_ms, { reason: this.metadata.stop_reason });
    }
    export() {
      const m = this.metadata, targets = this.targets.map(t => ({ ...t }));
      const margin = m.quality?.p95_error_px ?? 0;
      const gaze = this.gaze.map(g => {
        const f = before(this.frames, g.processing_start_ms);
        const t = f && targets.find(t => t.target_id === f.target_id);
        const inTargetWindow = Boolean(t && t.onset_ms !== null && g.processing_start_ms >= t.onset_ms && g.processing_start_ms < t.end_ms);
        const usable = Boolean(g.valid && inTargetWindow && f.in_view && g.processing_end_ms <= t.end_ms &&
          g.processing_start_ms - f.render_end_ms <= 200);
        const distance = usable ? Math.hypot(g.x - f.screen_x, g.y - f.screen_y) : null;
        return { ...g, elapsed_ms: g.processing_start_ms - m.start_ms, rendered_frame_id: f?.frame_id ?? null,
          target_id: inTargetWindow ? t.target_id : null, analysis_valid: usable,
          crosses_target_end: Boolean(t && g.processing_end_ms > t.end_ms),
          target_distance_px: distance, crosshair_distance_px: g.valid ? Math.hypot(g.x - m.viewport_width / 2, g.y - m.viewport_height / 2) : null,
          inside_sphere: usable ? insideSphere(f, g.x, g.y, m.viewport_width, m.viewport_height) : null,
          inside_expanded_aoi: usable ? distance <= f.screen_radius_px + margin : null };
      });
      for (const t of targets) {
        const samples = gaze.filter(g => g.target_id === t.target_id && g.analysis_valid);
        const near = samples.find(g => g.inside_expanded_aoi);
        const hitShot = this.shots.find(s => s.target_id === t.target_id && s.outcome === 'hit');
        const closest = hitShot ? [...samples].reverse().find(g => g.processing_start_ms <= hitShot.time_ms && hitShot.time_ms - g.processing_start_ms <= 100) : null;
        Object.assign(t, { first_shot_response_ms: t.first_shot_ms === null || t.onset_ms === null ? null : t.first_shot_ms - t.onset_ms,
          hit_response_ms: t.hit_ms === null || t.onset_ms === null ? null : t.hit_ms - t.onset_ms,
          gaze_arrival_estimate_ms: near ? near.processing_start_ms - t.onset_ms : null,
          valid_gaze_samples: samples.length, gaze_distance_at_hit_px: closest?.target_distance_px ?? null });
      }
      const accepted = this.shots.filter(s => s.accepted), hits = accepted.filter(s => s.outcome === 'hit');
      const gaps = this.gaze.slice(1).map((g, i) => g.processing_start_ms - this.gaze[i].processing_start_ms);
      return { schema: SCHEMA, metadata: m, frames: this.frames, gaze, targets, shots: this.shots, events: this.events,
        summary: { status: m.status, hits: hits.length, shots: accepted.length, misses: accepted.length - hits.length,
          accuracy: accepted.length ? hits.length / accepted.length : null,
          mean_hit_response_ms: mean(targets.map(t => t.hit_response_ms).filter(finite)),
          processed_gaze_frames: gaze.length, valid_gaze_frames: gaze.filter(g => g.valid).length,
          analysis_gaze_frames: gaze.filter(g => g.analysis_valid).length, max_gaze_gap_ms: gaps.length ? gaps.reduce((a, b) => Math.max(a, b), 0) : null,
          game_duration_ms: m.game_start_ms === undefined ? 0 : Math.max(0, m.end_ms - m.game_start_ms),
          scope: 'processed frames include countdown; valid frames are not a measure of gaze accuracy' } };
    }
  }
  function csv(rows, columns) {
    const encode = v => { const s = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    return [columns.join(','), ...rows.map(row => columns.map(key => encode(row[key])).join(','))].join('\r\n') + '\r\n';
  }
  function files(bundle) {
    const out = { 'session.json': JSON.stringify(bundle) };
    const fallbacks = { frames: ['frame_id', 'render_start_ms', 'render_end_ms'], gaze: ['frame_id', 'valid', 'failure_reason'],
      targets: ['target_id', 'status', 'onset_ms'], shots: ['shot_id', 'time_ms', 'outcome'], events: ['type', 'time_ms'] };
    for (const [name, fallback] of Object.entries(fallbacks)) {
      const columns = [...new Set([...fallback, ...bundle[name].flatMap(row => Object.keys(row))])];
      out[`${name}.csv`] = csv(bundle[name].map(row => ({ run_id: bundle.metadata.run_id, ...row })), ['run_id', ...columns]);
    }
    return out;
  }
  function checkBundle(b) {
    if (!b || b.schema !== SCHEMA || !b.metadata || ![b.metadata.viewport_width, b.metadata.viewport_height].every(v => finite(v) && v > 0) ||
      !['frames', 'gaze', 'targets', 'shots', 'events'].every(k => Array.isArray(b[k])) || b.frames.length > 30000 || b.gaze.length > 100000 ||
      b.frames.some(f => ![f.render_start_ms, f.render_end_ms, f.camera_x, f.camera_y, f.camera_z, f.qx, f.qy, f.qz, f.qw].every(finite))) throw Error('3D射撃研究の記録形式が不正です。');
    return b;
  }
  return { SCHEMA, DURATION, CADENCE, Session, random, percentile, mean, before, insideSphere, csv, files, checkBundle };
});
