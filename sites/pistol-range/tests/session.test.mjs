import test from 'node:test';
import assert from 'node:assert/strict';
import { Session, nextTarget, DURATION_MS } from '../dist/session.js';

test('pistol cadence, accuracy, and exact end boundary', () => {
  const game = new Session();
  assert.equal(game.shoot(0, true), false);
  game.start(1000);
  assert.equal(game.shoot(1000, true), true);
  assert.equal(game.shoot(1010, true), false);
  assert.equal(game.shoot(1200, false), true);
  assert.equal(game.shots, 2); assert.equal(game.hits, 1); assert.equal(game.accuracy, 50);
  assert.equal(game.shoot(1000 + DURATION_MS, true), false);
  assert.equal(game.mode, 'finished'); assert.equal(game.shots, 2);
  game.start(90000);
  assert.equal(game.hits, 0); assert.equal(game.accuracy, null);
});

test('losing focus pauses time; resuming retains the score', () => {
  const game = new Session(); game.start(1000); game.shoot(2000, true);
  game.pause(6000); assert.equal(game.remaining(90000), 55000);
  assert.equal(game.shoot(90000, true), false);
  game.resume(90000); assert.equal(game.hits, 1);
  assert.equal(game.remaining(91000), 54000);
  assert.equal(game.tick(145000), true); assert.equal(game.remaining(145000), 0);
});

test('successive spheres remain in the room and require a new aim direction', () => {
  let previous = { x: 0, y: 1.65, z: -10.5 };
  for (let i = 0; i < 1000; i++) {
    const point = nextTarget(previous);
    assert(point.x >= -4.3 && point.x <= 4.3);
    assert(point.y >= .8 && point.y <= 4.3);
    assert(point.z >= -12.8 && point.z <= -9);
    assert(Math.hypot(point.x - previous.x, point.y - previous.y) > 1.7);
    previous = point;
  }
  const fallback = nextTarget({ x: 0, y: 2.55, z: -10.9 }, () => .5);
  assert.equal(fallback.x, 3.5);
});
