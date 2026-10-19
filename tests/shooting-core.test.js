const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../shooting-core.js');
const meta = () => ({ run_id: '8a756db1-8596-4da3-82bc-4458f79d6e95', start_ms: 0, viewport_width: 1000, viewport_height: 800, quality: { p95_error_px: 20 } });
const pose = () => ({ camera_x: 0, camera_y: 1.65, camera_z: 1.8, qx: 0, qy: 0, qz: 0, qw: 1, fov_deg: 65,
  target_x: 0, target_y: 1.65, target_z: -10.5, target_radius: .42, screen_x: 500, screen_y: 400, screen_radius_px: 22, in_view: true });
const gaze = (id, start, end, valid = true) => ({ frame_id: id, processing_start_ms: start, processing_end_ms: end,
  valid, x: valid ? 500 : null, y: valid ? 400 : null, raw_x: valid ? 500 : null, raw_y: valid ? 400 : null, failure_reason: valid ? '' : 'face_not_detected' });
function started() { const s = new C.Session(meta()); s.startGame(3000); s.spawn(3000, { x: 0, y: 1.65, z: -10.5 }, .42); return s; }
test('unrendered targets and rapid repeated clicks cannot score; failures are kept', () => {
  const s = started();
  assert.equal(s.shoot(3001, pose(), true).outcome, 'before_first_render');
  s.render(3010, 3012, pose(), true);
  s.gazeFrame(gaze(1, 3020, 3030)); s.gazeFrame(gaze(1, 3020, 3030));
  s.gazeFrame(gaze(2, 3040, 3050, false)); s.gazeFrame(gaze(3, 3090, 3110));
  assert.equal(s.shoot(3050, pose(), false).outcome, 'miss');
  assert.equal(s.shoot(3100, pose(), true).outcome, 'cooldown');
  assert.equal(s.shoot(3250, pose(), true).outcome, 'hit');
  s.gazeFrame(gaze(4, 3240, 3260));
  s.spawn(3250, { x: 1, y: 2, z: -10 }, .42);
  s.render(3260, 3262, { ...pose(), target_x: 1 }, true);
  s.finish(3300, 'user_escape');
  const b = s.export();
  assert.equal(b.gaze.length, 4); assert.equal(b.summary.hits, 1); assert.equal(b.summary.shots, 2);
  assert.equal(b.targets[0].hit_response_ms, 238); assert.equal(b.targets[1].status, 'aborted');
  assert.equal(b.gaze[3].crosses_target_end, true); assert.equal(b.gaze[3].analysis_valid, false);
  assert.equal(b.gaze[0].inside_sphere, true); assert.equal(b.gaze[0].inside_expanded_aoi, true);
  assert.equal(b.targets[0].gaze_distance_at_hit_px, null); // No recent usable sample at the hit.
  assert.equal(b.metadata.status, 'aborted');
});
test('stale renders, late processing, pre-run gaze and end-boundary input are excluded', () => {
  const s = started(); s.render(3000, 3001, pose(), true);
  s.gazeFrame(gaze(1, -1, 1)); s.gazeFrame(gaze(2, 3500, 3510));
  assert.equal(s.shoot(63000, pose(), true).accepted, false);
  s.finish(63005); s.gazeFrame(gaze(3, 63000, 63001));
  const b = s.export(); assert.equal(b.metadata.end_ms, 63000); assert.equal(b.metadata.status, 'completed');
  assert.equal(b.gaze.length, 1); assert.equal(b.gaze[0].analysis_valid, false);
  assert.equal(b.targets[0].status, 'unfinished'); assert.equal(b.summary.mean_hit_response_ms, null);
  assert.equal(b.summary.accuracy, null);
});
test('sphere AOI uses the camera ray rather than a stationary screen target', () => {
  assert.equal(C.insideSphere({ ...pose(), target_visible: true }, 500, 400, 1000, 800), true);
  assert.equal(C.insideSphere({ ...pose(), target_visible: true }, 900, 400, 1000, 800), false);
  const angle = .2;
  const f = { ...pose(), qy: Math.sin(angle / 2), qw: Math.cos(angle / 2), target_visible: true };
  assert.equal(C.insideSphere(f, 500, 400, 1000, 800), false);
});
test('all six files preserve identity, headers on empty sessions, nulls and CSV escaping', () => {
  const s = new C.Session({ ...meta(), participant_id: 'P01' }); s.finish(10, 'user_escape');
  s.event('quoted,"event', 11);
  const files = C.files(s.export()); assert.equal(Object.keys(files).length, 6);
  for (const name of ['gaze.csv', 'targets.csv', 'frames.csv', 'shots.csv', 'events.csv']) assert(files[name].startsWith('run_id,'));
  assert(files['events.csv'].includes('"quoted,""event"'));
  assert.equal(JSON.parse(files['session.json']).metadata.run_id, meta().run_id);
});
test('seeded target random is independent from sound/effects randomness', () => {
  const a = C.random(42), b = C.random(42);
  for (let i = 0; i < 200; i++) { Math.random(); assert.equal(a(), b()); }
});
