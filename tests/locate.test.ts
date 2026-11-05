import test from 'node:test';
import assert from 'node:assert/strict';
import { averageSignal, estimate, gpsPoint, stepCounter, stepForward, type Reading } from '../src/locate';

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

test('steps are counted from the rise and fall of each stride', () => {
  const count = (values: number[], gap = 100): number => { const s = stepCounter(); return values.filter((v, i) => s(v, i * gap)).length; };
  assert.equal(count([9.8, 12, 13, 8, 9.8, 12, 8, 9.8, 12.5, 8.5]), 3);
  assert.equal(count([9.8, 10, 9.6, 9.9]), 0, 'holding still is no step');
  assert.equal(count([9.8, 10.9, 9.1, 9.8, 10.8, 9.0]), 2, 'a gentle walk with the phone held flat');
  assert.equal(count([12, 8, 12, 8], 40), 1, 'too quick to be two steps');
});

test('a step moves along the plan, relative to the top of the plan', () => {
  const close = (p: { x: number; y: number }, x: number, y: number): void => { assert.ok(Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6, JSON.stringify(p)); };
  close(stepForward({ x: 5, y: 5 }, 90, 90, 12, 9, 1), 5, 4); // towards the top
  close(stepForward({ x: 5, y: 5 }, 180, 90, 12, 9, 1), 6, 5); // to the right
  close(stepForward({ x: 11.9, y: 5 }, 180, 90, 12, 9, 1), 12, 5); // stays on the plan
});

test('GPS moves are turned to match the plan', () => {
  const from = { lat: 1.3, lon: 103.8 };
  const north = gpsPoint({ x: 6, y: 4 }, from, { lat: 1.3 + 2 / 111320, lon: 103.8 }, 0, 12, 9);
  assert.ok(Math.abs(north.x - 6) < 0.01 && Math.abs(north.y - 2) < 0.01, JSON.stringify(north));
  const turned = gpsPoint({ x: 6, y: 4 }, from, { lat: 1.3 + 2 / 111320, lon: 103.8 }, 90, 12, 9); // top of the plan faces east
  assert.ok(Math.abs(turned.x - 4) < 0.01 && Math.abs(turned.y - 4) < 0.01, JSON.stringify(turned));
});
