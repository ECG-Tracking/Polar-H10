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
