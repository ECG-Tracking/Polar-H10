import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinSegments, realAt, stripAt } from '../src/periodecg';

test('BP and ECG: the period’s ECGs join in time order, and a place on the strips is a real date and time', () => {
  const fs = 130, day = 86400000, t0 = 1_800_000_000_000;
  const flat = (s: number): Int16Array => new Int16Array(Math.round(s * fs));
  // a strap ECG on day 3, a tracking piece with both devices on day 1, a watch strip on day 2 (given out of order)
  const e = joinSegments([
    { start: t0 + 3 * day, durS: 60, watch: null, polar: flat(60) },
    { start: t0 + day, durS: 30, watch: flat(30), polar: flat(30) },
    { start: t0 + 2 * day, durS: 30, watch: flat(30), polar: null },
  ], fs)!;
  assert.deepEqual(e.segments.map((s) => s.start), [t0 + day, t0 + 2 * day, t0 + 3 * day]);
  assert.equal(e.watchA.x.length, e.polarA.x.length, 'both strips the same length (flat where a device didn’t record)');
  assert.equal(realAt(e, 10), t0 + day + 10000);
  assert.equal(realAt(e, (e.at[1] ?? 0) + 5), t0 + 2 * day + 5000);
  assert.ok(Math.abs(stripAt(e, t0 + 3 * day + 20000) - ((e.at[2] ?? 0) + 20)) < 1e-6);
  assert.equal(stripAt(e, t0 + 2.5 * day), (e.at[1] ?? 0) + 30, 'a moment between pieces: the nearest piece');
  assert.ok(Math.abs(e.durationS - ((e.at[2] ?? 0) + 60)) < 1e-6);
  assert.equal(joinSegments([], fs), null);
});
