export const DURATION_MS = 60000;
export const SHOT_INTERVAL_MS = 160;

export class Session {
  constructor() { this.reset(); }
  reset() {
    this.mode = 'idle'; this.hits = 0; this.shots = 0; this.elapsed = 0;
    this.resumedAt = null; this.lastShotAt = -Infinity;
  }
  start(now) { this.reset(); this.mode = 'running'; this.resumedAt = now; }
  elapsedAt(now) { return this.elapsed + (this.mode === 'running' ? Math.max(0, now - this.resumedAt) : 0); }
  remaining(now) { return Math.max(0, DURATION_MS - this.elapsedAt(now)); }
  pause(now) {
    if (this.mode !== 'running') return;
    this.elapsed = Math.min(DURATION_MS, this.elapsedAt(now));
    this.resumedAt = null; this.mode = this.elapsed >= DURATION_MS ? 'finished' : 'paused';
  }
  resume(now) { if (this.mode === 'paused') { this.resumedAt = now; this.mode = 'running'; } }
  tick(now) {
    if (this.mode === 'running' && this.remaining(now) <= 0) {
      this.elapsed = DURATION_MS; this.resumedAt = null; this.mode = 'finished';
      return true;
    }
    return false;
  }
  shoot(now, hit) {
    if (this.mode !== 'running' || this.tick(now) || now - this.lastShotAt < SHOT_INTERVAL_MS) return false;
    this.lastShotAt = now; this.shots++;
    if (hit) this.hits++;
    return true;
  }
  get accuracy() { return this.shots ? Math.round(this.hits / this.shots * 100) : null; }
}

export function nextTarget(previous, random = Math.random) {
  let point;
  for (let i = 0; i < 30; i++) {
    point = { x: (random() - .5) * 8.6, y: .8 + random() * 3.5, z: -9 - random() * 3.8 };
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) > 1.7) return point;
  }
  return { x: previous.x > 0 ? -3.5 : 3.5, y: 2.4, z: -10.5 };
}
