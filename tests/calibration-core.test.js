const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../calibration-core.js');
const frame = (id, start, extra = {}) => ({ frame_id: id, processing_start_ms: start,
  processing_end_ms: start + 5, valid: true, features: [1, id / 100, .5], ...extra });

test('one point keeps five samples from forty fresh, non-overlapping frames after settling', () => {
  const capture = new C.PointCapture(1000), samples = [];
  for (let i = 0; i < 20; i++) assert.equal(capture.push(frame(i, 1000 + i * 30)), null);
  for (let i = 20; i < 60; i++) {
    const sample = capture.push(frame(i, 1000 + i * 30)); if (sample) samples.push(sample);
  }
  assert.equal(samples.length, 5);
  const ids = samples.flatMap(s => s.source_frame_ids);
  assert.equal(ids.length, 40); assert.equal(new Set(ids).size, 40);
  assert(samples.every(s => s.rows.length === 8 && s.capture_start_ms >= 1600));
  assert.equal(capture.push(frame(60, 2800)), null);
});
test('duplicates, missing faces, invalid features and long gaps cannot fill a sample', () => {
  const capture = new C.PointCapture(0);
  for (let i = 1; i <= 7; i++) assert.equal(capture.push(frame(i, 600 + i * 30)), null);
  assert.equal(capture.push(frame(7, 840)), null);
  assert.equal(capture.push(frame(8, 850, { valid: false })), null);
  for (let i = 9; i <= 15; i++) assert.equal(capture.push(frame(i, 600 + i * 30)), null);
  assert.equal(capture.push(frame(16, 1090, { features: [1, NaN] })), null);
  for (let i = 17; i <= 23; i++) assert.equal(capture.push(frame(i, 600 + i * 30)), null);
  assert.equal(capture.push(frame(24, 2000)), null);
  for (let i = 25; i < 31; i++) assert.equal(capture.push(frame(i, 2000 + (i - 24) * 30)), null);
  assert.equal(capture.samples, 0);
  assert.equal(capture.push(frame(31, 2210)).rows.length, 8);
});
test('pausing discards an unfinished window and samples do not share mutable feature arrays', () => {
  const capture = new C.PointCapture(0), source = frame(1, 600);
  capture.push(source); source.features[0] = 9;
  assert.equal(capture.rows[0].features[0], 1);
  capture.resetWindow(); assert.equal(capture.rows.length, 0);
  for (let i = 2; i < 9; i++) assert.equal(capture.push(frame(i, 600 + i * 30)), null);
  assert.equal(capture.samples, 0);
});
