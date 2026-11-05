import test from 'node:test';
import assert from 'node:assert/strict';
import { averageSignal, estimate, type Reading } from '../src/locate';

const noise = [3, -4, 2, -5, 4, -2, 3];
const spots = [[1.5, 1.5], [6, 1.5], [10.5, 2], [2, 7], [6.5, 7], [10, 7.5], [8, 4.5]] as const;

/** Readings as they would fall off from a device at (x, y), with some noise. */
const around = (x: number, y: number): Reading[] => spots.map(([a, b], i) => ({
  x: a, y: b, rssi: Math.round(-58 - 30 * Math.log10(Math.max(0.5, Math.hypot(a - x, b - y))) + (noise[i] ?? 0)),
}));

test('the likely spot comes out near the device', () => {
  const e = estimate(around(9.5, 6), 12, 9);
  assert.ok(Math.hypot(e.best.x - 9.5, e.best.y - 6) < 1.5, `best ${JSON.stringify(e.best)}`);
  assert.ok(e.share < 0.25, `area ${e.share}`);
  const other = estimate(around(2.5, 2.5), 12, 9);
  assert.ok(Math.hypot(other.best.x - 2.5, other.best.y - 2.5) < 3, `best ${JSON.stringify(other.best)}`);
});

test('a place where the device wasn’t found pushes the likely area away', () => {
  const e = estimate([{ x: 1, y: 1, rssi: null }], 12, 9);
  assert.ok(Math.hypot(e.best.x - 1, e.best.y - 1) > 4, `best ${JSON.stringify(e.best)}`);
});

test('more readings narrow the area, and a next spot is suggested until they do', () => {
  const few = estimate(around(9.5, 6).slice(0, 2), 12, 9), many = estimate(around(9.5, 6), 12, 9);
  assert.ok(many.share < few.share);
  assert.ok(few.next);
});

test('the signal is averaged over what was heard', () => {
  assert.equal(averageSignal([-70, -72, -74]), -72);
  assert.equal(averageSignal([-70, NaN, -72]), -71);
  assert.equal(averageSignal([]), null);
  assert.equal(averageSignal([0, 127]), null);
});
