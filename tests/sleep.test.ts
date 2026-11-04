import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSleep, isNap, napScore, sleepScore, SleepRecorder, ACC_MISSING, EPOCH_S } from '../src/sleep';
import { simulateNight } from '../src/sleepsim';
import { personalRange, checkRange, sleepRanges } from '../src/ranges';

for (const seed of [1, 7, 42]) {
  test(`simulated night (seed ${seed}): sleep found, stages mostly right, awakenings counted`, () => {
    const { data, truth } = simulateNight(seed);
    const a = analyzeSleep(data);
    const m = a.metrics;
    const agree = truth.filter((s, e) => a.stages[e] === s).length / truth.length;
    assert.ok(agree > 0.85, `stage agreement ${(100 * agree).toFixed(1)} %`);
    const trueSleepMin = (truth.filter((s) => s !== 'awake').length * EPOCH_S) / 60;
    assert.ok(Math.abs(m.sleepMin - trueSleepMin) < 20, `sleep ${m.sleepMin} min vs ${trueSleepMin}`);
    assert.equal(m.awakenings, 2); // the simulator wakes twice between cycles
    assert.ok(Math.abs(m.latencyMin - 14) <= 3, `fell asleep after ${m.latencyMin} min`);
    assert.ok(m.breathingRate > 12.5 && m.breathingRate < 16, `breathing ${m.breathingRate}`);
    assert.ok(m.avgHR > 48 && m.avgHR < 64, `HR ${m.avgHR}`);
    assert.ok(m.avgHrv > 20 && m.avgHrv < 70, `HRV ${m.avgHrv}`);
    assert.ok(m.deepPct > 10 && m.remPct > 10, `deep ${m.deepPct} %, REM ${m.remPct} %`);
    assert.ok(m.score >= 0 && m.score <= 100);
    assert.equal(Math.round(m.coverage), 100);
  });
}

test('a gap in the data is reported as no data, not as sleep', () => {
  const { data } = simulateNight(3);
  const from = Math.round(3 * 3600 * data.accFs), to = Math.round(3.5 * 3600 * data.accFs);
  data.acc.fill(ACC_MISSING, 3 * from, 3 * to);
  const keep = Array.from(data.rrT, (t) => t < 3 * 3600 || t >= 3.5 * 3600);
  const gapped = { ...data, rrT: data.rrT.filter((_, i) => keep[i]), rr: data.rr.filter((_, i) => keep[i]) };
  const a = analyzeSleep(gapped);
  const noData = a.stages.filter((s) => s === 'nodata').length;
  assert.ok(Math.abs(noData - 60) <= 2, `${noData} no-data epochs for a 30 min gap`);
  assert.ok(a.metrics.coverage < 95);
});

test('sleep score follows its documented rules', () => {
  const good = { sleepMin: 8 * 60, efficiency: 92, deepPct: 20, remPct: 22, awakenings: 1 };
  assert.equal(sleepScore(good), 100);
  assert.equal(sleepScore({ ...good, sleepMin: 6 * 60 }), 90); // 1 h short
  assert.equal(sleepScore({ ...good, awakenings: 4 }), 91); // 3 extra awakenings
  assert.equal(sleepScore({ ...good, efficiency: 75 }), 90); // 10 % below 85
  assert.equal(sleepScore({ sleepMin: 0, efficiency: 0, deepPct: 0, remPct: 0, awakenings: 20 }), 5); // every deduction at its maximum: 100 - 40 - 20 - 10 - 10 - 15
});

test('recorder keeps beat timing and leaves dropouts as missing motion samples', () => {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const rec = new SleepRecorder(25);
    for (let s = 1; s <= 60; s++) { now += 1000; rec.addRR([1000]); rec.addAcc(new Int16Array(75).fill(100)); }
    now += 30_000; // strap gone for 30 s
    for (let s = 1; s <= 30; s++) { now += 1000; rec.addRR([1000]); rec.addAcc(new Int16Array(75).fill(100)); }
    const d = rec.data();
    assert.equal(d.rr.length, 90);
    assert.ok(Math.abs(d.durationS - 120) < 0.01);
    const missing = Array.from(d.acc).filter((v) => v === ACC_MISSING).length / 3;
    assert.ok(Math.abs(missing - 30 * 25) <= 25, `${missing} missing samples`);
    assert.ok((d.rrT[60] ?? 0) - (d.rrT[59] ?? 0) > 25, 'beat times jump across the gap');
  } finally {
    Date.now = realNow;
  }
});

test('personal range needs 3 nights and is mean ± 1 SD', () => {
  assert.equal(personalRange([50, 52]), null);
  const r = personalRange([50, 52, 54]);
  assert.ok(r && r.lo === 50 && r.hi === 54);
  assert.equal(checkRange(sleepRanges().sleepHours, 6.5), 'low');
  assert.equal(checkRange(sleepRanges().awakenings, 3), 'high');
});

test('sleep in the day counts as a nap, sleep overnight as a night', () => {
  const at = (h: number, m = 0): number => new Date(2026, 10, 4, h, m).getTime();
  assert.equal(isNap(at(7, 40), 110 * 60), true); // 07:40–09:30
  assert.equal(isNap(at(14), 3600), true);
  assert.equal(isNap(at(23, 38), 7.5 * 3600), false); // 23:38–07:08
  assert.equal(isNap(at(2), 9 * 3600), false); // a late night: 02:00–11:00
  assert.equal(isNap(at(21), 3600), false);
});

test('a nap score depends on efficiency and awakenings, not on length', () => {
  assert.equal(napScore({ efficiency: 90, awakenings: 0 }), 100);
  assert.equal(napScore({ efficiency: 80, awakenings: 3 }), 89); // 5 for efficiency, 6 for awakenings
  assert.equal(napScore({ efficiency: 10, awakenings: 30 }), 65); // both capped
});
