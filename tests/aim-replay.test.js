const test = require('node:test'), assert = require('node:assert/strict');
const { Replay, segments } = require('../aim-replay-core.js');
const F = require('./study-fixtures.cjs');

test('gaze appears at processing completion, never at a future timestamp', () => {
  const r = new Replay(F.aim());
  assert.equal(r.at(1059).gaze, null);
  assert.deepEqual(r.at(1060).gaze, { x: 100, y: 200, age_ms: 0 });
  assert.deepEqual(r.at(1060, { raw: true }).gaze, { x: 98, y: 203, age_ms: 0 });
  assert(r.at(1260).gaze);
  assert.equal(r.at(1261).gaze, null);
  assert.equal(r.at(1261).gaze_status, '200ms超の取得空白');
});
test('failed detection immediately hides the last gaze; gaps split trails', () => {
  const b = F.aim();
  b.gaze.push({ processing_end_ms: 1080, valid: false, x: null, y: null });
  const r = new Replay(b);
  assert.equal(r.at(1080).gaze, null);
  assert.equal(r.at(1080).gaze_status, '未検出');
  const points = [0, 20, 40, 60, 280, 300].map(time => ({ time, x: time, y: 10, valid: time !== 40 }));
  assert.deepEqual(segments(points, 0, 290).map(s => s.map(p => p.time)), [[0, 20], [60], [280]]);
  assert.deepEqual(segments(points, 20, 30).map(s => s.map(p => p.time)), [[20]]);
});
test('cursor holds the last observed position but never invents an initial position', () => {
  const b = F.aim(); b.cursor = [{ time_ms: 900, x: 10, y: 20 }, { time_ms: 1000, x: 30, y: 40 }];
  const r = new Replay(b);
  assert.equal(r.hasCursor, true); assert.equal(r.at(899).cursor, null);
  assert.deepEqual(r.at(5000).cursor, { x: 30, y: 40, age_ms: 4000 });
  assert.deepEqual(r.at(1100, { rangeStart: 1000 }).cursor_trail[0].map(p => p.time), [1000]);
  assert.equal(new Replay(F.aim()).hasCursor, false);
  assert.equal(new Replay(F.aim()).at(1100).cursor, null);
});
test('targets and click markers respect onset, exact hit time, gaps and run end', () => {
  const r = new Replay(F.aim());
  assert.equal(r.at(999).phase, '的の提示前');
  assert.equal(r.at(1000).target.trial_id, 1);
  assert.equal(r.at(1099).clicks.length, 0);
  assert.equal(r.at(1100).target, null);
  assert.equal(r.at(1100).clicks[0].outcome, 'hit');
  assert.equal(r.at(1100).phase, '的の間の空白');
  assert.equal(r.at(1401).clicks.length, 0);
  assert.equal(r.at(12000).phase, '終了');
  assert.deepEqual(r.range(1), { start: 1000, end: 1100 });
  assert.deepEqual(r.range(), { start: 0, end: 12000 });
  assert.equal(r.at(-100).time, 0); assert.equal(r.at(13000).time, 12000);
  assert.equal(r.at(1100, { rangeStart: 1101 }).clicks.length, 0);
});
