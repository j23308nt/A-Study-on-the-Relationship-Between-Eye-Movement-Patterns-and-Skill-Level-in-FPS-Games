const test = require('node:test'), assert = require('node:assert/strict');
const P = require('../pupil-core.js');
function image(width = 120, height = 80, ellipses = [{ x: 60, y: 40, a: 12, b: 9 }]) {
  const gray = new Uint8Array(width * height).fill(175);
  for (const e of ellipses) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (((x - e.x) / e.a) ** 2 + ((y - e.y) / e.b) ** 2 <= 1) gray[y * width + x] = 18;
  }
  return gray;
}
test('eye ellipse yields its observed center and a quadratic mapping vector', () => {
  const r = P.detect(image(), 120, 80);
  assert(r.valid); assert(Math.abs(r.cx - 60) < .1); assert(Math.abs(r.cy - 40) < .1);
  assert(Math.abs(r.major - 24) < 2); assert(Math.abs(r.minor - 18) < 2);
  assert.deepEqual(r.features, [1, 0, 0, 0, 0, 0]);
  const moved = P.detect(image(120, 80, [{ x: 80, y: 28, a: 12, b: 9 }]), 120, 80);
  assert(moved.valid); assert(moved.u > r.u); assert(moved.v < r.v);
  assert.equal(moved.features[4], moved.features[1] * moved.features[2]);
});
test('blank images, eyelash-like lines, edge-clipped and oversized dark regions are missing, not gaze', () => {
  assert(!P.detect(new Uint8Array(120 * 80).fill(175), 120, 80).valid);
  assert(!P.detect(new Uint8Array(120 * 80).fill(18), 120, 80).valid);
  assert(!P.detect(image(120, 80, [{ x: 60, y: 40, a: 36, b: 1.5 }]), 120, 80).valid);
  assert(!P.detect(image(120, 80, [{ x: 3, y: 40, a: 12, b: 9 }]), 120, 80).valid);
});
test('similar separate pupils/candidates are rejected as ambiguous', () => {
  const r = P.detect(image(120, 80, [{ x: 30, y: 40, a: 10, b: 8 }, { x: 90, y: 40, a: 10, b: 8 }]), 120, 80);
  assert.equal(r.valid, false); assert.equal(r.reason, 'pupil_ambiguous');
});
test('small bright reflection and scattered dark noise do not drag the center to unrelated pixels', () => {
  const gray = image(); gray[40 * 120 + 60] = 255;
  for (let x = 7; x < 115; x += 13) gray[5 * 120 + x] = 0;
  const r = P.detect(gray, 120, 80);
  assert(r.valid); assert(Math.abs(r.cx - 60) < 1); assert(Math.abs(r.cy - 40) < 1);
});
test('contrast and dark threshold are enforced; malformed images are rejected', () => {
  const gray = image(); for (let i = 0; i < gray.length; i++) if (gray[i] === 175) gray[i] = 25;
  assert(!P.detect(gray, 120, 80, { threshold: 20 }).valid);
  assert(!P.detect(image(), 120, 80, { threshold: 5 }).valid);
  assert.throws(() => P.detect(new Uint8Array(2), 120, 80));
});
