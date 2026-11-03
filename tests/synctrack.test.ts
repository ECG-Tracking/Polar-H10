import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hrFrom, mmss, rmssd, sdnn, usable } from '../src/synctrack';

test('synchronised tracking: heart rate and HRV from beat intervals', () => {
  assert.deepEqual(usable([250, 800, 2500, 900]), [800, 900], 'impossible intervals are left out');
  assert.deepEqual(usable([800, 810, 400, 1200, 790]), [800, 810, 790], 'an extra or missed beat (over 20% off) is left out');
  assert.equal(hrFrom([1000, 1000, 1000]), 60);
  assert.equal(hrFrom([]), null);
  assert.equal(rmssd([800, 810, 790, 800]), Math.sqrt((100 + 400 + 100) / 3));
  assert.equal(rmssd([800, 810]), null, 'needs at least 3 beats');
  assert.ok(Math.abs((sdnn([800, 820, 780, 800]) ?? 0) - Math.sqrt(800 / 3)) < 1e-9);
});

test('synchronised tracking: times shown as m:ss', () => {
  assert.equal(mmss(0), '0:00');
  assert.equal(mmss(59.9), '0:59');
  assert.equal(mmss(300), '5:00');
  assert.equal(mmss(3725), '62:05');
});

import { withReadings } from '../src/synctrack';

test('synchronised tracking: every reading within one hour before or after a start is added to that tracking', () => {
  const at = (h: number, m: number): number => new Date(2026, 10, 3, h, m).getTime();
  const bp = (h: number, m: number, s: number) => ({ at: at(h, m), systolic: s, diastolic: 80, pulse: 70 });
  const readings = [bp(15, 11, 125), bp(16, 11, 130), bp(16, 30, 135), bp(16, 33, 111), bp(16, 50, 118), bp(17, 50, 120)];
  const entry = (h: number, m: number, first: ReturnType<typeof bp> | null) => ({ id: `t${at(h, m)}`, user: 1 as const, start: at(h, m), durationS: 300, polar: null, watch: null, bp: first, ecgId: null });
  const changed = withReadings([entry(16, 27, bp(16, 30, 135)), entry(18, 0, null)], readings);
  assert.deepEqual(changed.map((e) => e.bps?.map((b) => b.systolic)), [[130, 135, 111, 118], [120]], '15:11 and 17:50 are over an hour from 16:27; 17:50 is the hour before 18:00');
  assert.deepEqual(withReadings(changed, readings), [], 'nothing changes the second time');
});
