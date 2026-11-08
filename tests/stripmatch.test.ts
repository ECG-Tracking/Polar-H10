import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EcgSimulator } from '../src/sim';
import { agreedEvents, beatAgreement, bestOffset, joinStrips, matchStrips, JOIN_GAP_S } from '../src/stripmatch';
import { unitScale } from '../src/watchecg';

const FS = 130;
const polar = Int16Array.from(new EcgSimulator({ scenario: 'rest', seed: 9 }).next(FS * 120));
const T0 = 1_700_000_000_000;

/** A "watch strip" of the same heartbeats from second `at`, with the watch's clock `clockErrMs` off. */
const strip = (id: string, at: number, clockErrMs: number) => ({ id, start: T0 + at * 1000 + clockErrMs, samples: polar.slice(at * FS, (at + 30) * FS), fs: FS });

test('each strip is shifted to line up with the strap, beat for beat', () => {
  assert.equal(bestOffset([1000, 2000, 3000], [2200, 3200, 4200]).offsetMs, 1200);
  const set = matchStrips([strip('a', 10, 1000), strip('b', 60, -800)], T0, polar, FS)!;
  assert.deepEqual(set.strips.map((s) => s.offsetMs), [-1000, 800]);
  assert.equal(set.watch.length, set.polar.length, 'both joined the same way');
  assert.equal(set.strips[1]!.at, 30 + JOIN_GAP_S);
  const a = beatAgreement(set);
  assert.ok(a.watchMatchedPct > 95 && a.polarFoundPct > 95, JSON.stringify(a));
  assert.ok(Math.abs(a.rrBias) < 2 && a.within10Pct > 95, JSON.stringify(a));
  const join = 30; // where strip a ends and the gap begins
  assert.ok(!set.watchA.events.some((e) => e.t > join - 1 && e.t < join + JOIN_GAP_S + 1), 'the joins are no events');
  const ev = agreedEvents(set);
  assert.ok(ev.length >= 1 && ev.every((e) => e.agreed), 'the simulated premature beat is seen by both');
});

test('a strip outside the strap’s ECG is left out; strips can be joined on their own', () => {
  assert.equal(matchStrips([strip('late', 0, 200_000)], T0, polar, FS), null);
  const j = joinStrips([strip('a', 0, 0), strip('b', 40, 0)], FS)!;
  assert.equal(j.watch.length, 60 * FS + JOIN_GAP_S * FS);
});

test('the watch’s unit is worked out from the size of the waves', () => {
  const wave = (k: number): number[] => Array.from({ length: 1000 }, (_, i) => Math.sin(i / 8) * k);
  assert.equal(unitScale(wave(1)), 1000, 'millivolts');
  assert.equal(unitScale(wave(1000)), 1, 'microvolts');
  assert.equal(unitScale(wave(1_000_000)), 0.001, 'nanovolts');
});

import { bestFit, loneEvents } from '../src/stripmatch';

test('a clock about one beat off is put right by the rhythm’s pattern, not taken as the neighbouring beat', () => {
  // beats with a slightly varying rhythm, as a real heart has
  const rr = Array.from({ length: 60 }, (_, i) => 850 + 25 * Math.sin(i / 2.3) + (i % 7 === 3 ? 15 : 0));
  const polar: number[] = []; let t = 0; for (const x of rr) { t += x; polar.push(T0 + t); }
  const watch = polar.slice(20, 50).map((p) => p - polar[20]!); // times from the strip's start
  const clockErr = 860; // about one beat
  const fit = bestFit(watch, polar, polar[20]! + clockErr);
  assert.equal(Math.round(fit.offsetMs / 10), Math.round(-clockErr / 10), JSON.stringify(fit));
  assert.ok(Math.abs(fit.stretch - 1) < 0.002);
});

test('the watch running 2.5 % fast is stretched to fit', () => {
  const rr = Array.from({ length: 60 }, (_, i) => 850 + 25 * Math.sin(i / 2.3));
  const polar: number[] = []; let t = 0; for (const x of rr) { t += x; polar.push(T0 + t); }
  const watch = polar.slice(10, 45).map((p) => (p - polar[10]!) / 1.024);
  const fit = bestFit(watch, polar, polar[10]! - 300);
  assert.ok(Math.abs(fit.stretch - 1.024) < 0.002 && Math.abs(fit.offsetMs - 300) <= 10, JSON.stringify(fit));
});

test('only events with no other within 5 s are clear enough to line up on', () => {
  const ev = loneEvents([{ t: 0, type: 'premature' }, { t: 3000, type: 'pause' }, { t: 20000, type: 'premature' }]);
  assert.deepEqual(ev.map((e) => e.t), [20000]);
});

test('the same ECG saved twice is used once, so its events aren’t counted twice', () => {
  const once = matchStrips([strip('a', 10, 0)], T0, polar, FS)!;
  const twice = matchStrips([strip('a', 10, 0), { ...strip('a2', 10, 0), start: T0 + 11_000 }], T0, polar, FS)!;
  assert.equal(twice.strips.length, 1);
  assert.deepEqual(twice.skipped, ['a2']);
  assert.equal(agreedEvents(twice).length, agreedEvents(once).length);
});
