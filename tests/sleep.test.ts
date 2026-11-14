import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSleep, isNap, joinParts, localZ, minBouts, quietWakeSpells, sleepScore, SleepRecorder, weighted, ACC_MISSING, EPOCH_S, type RecordingPart, type SleepData, type Stage } from '../src/sleep';
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
  assert.equal(checkRange(sleepRanges().sleepHours, 5.5), 'low');
  assert.equal(checkRange(sleepRanges().sleepHours, 6.5), null);
  assert.equal(checkRange(sleepRanges().lightPct, 55), 'high'); // as D2 Link: under 55 % is normal
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

test('a slow drift in heart rate doesn’t decide the stage: each value is judged against its surroundings', () => {
  const drift = Array.from({ length: 600 }, (_, i) => 60 - i * 0.02 + (i % 2 ? 1 : -1));
  const mask = drift.map(() => true);
  const z = localZ(drift, mask);
  const side = (a: readonly (number | null)[]) => (a[100] ?? 0) - (a[500] ?? 0);
  assert.ok(Math.abs(side(z)) < 1, `difference ${side(z)}`);
  assert.equal(localZ([null, 1, 2], [true, true, true])[0], null);
});

test('stages last at least 5 minutes', () => {
  const rep = (s: Stage, n: number): Stage[] => Array.from({ length: n }, () => s);
  assert.deepEqual(minBouts([...rep('light', 20), ...rep('rem', 4), ...rep('light', 20)]), rep('light', 44), 'a short REM run becomes light');
  assert.deepEqual(minBouts([...rep('rem', 12), ...rep('light', 4), ...rep('rem', 12)]), rep('rem', 28), 'a short gap joins two runs');
  const kept = [...rep('light', 20), ...rep('awake', 2), ...rep('light', 20)];
  assert.deepEqual(minBouts(kept), kept, 'awake isn’t touched');
  const long = [...rep('deep', 10), ...rep('light', 10)];
  assert.deepEqual(minBouts(long), long, 'runs of 5 minutes stay');
});

test('less evidence can’t make a stage look more certain', () => {
  assert.equal(weighted([[2, 1], [null, 1]]), 2);
  assert.equal(weighted([[2, 1], [2, 1]]), 4);
  assert.equal(weighted([[null, 1]]), 0);
});

test('possible quiet wake needs a lasting rise in heart rate during sleep', () => {
  const z = [0, 3, 3, 3, 3, 0, 3, 3, 0, 3, 3, 3, 3], asleep = z.map((_, i) => i < 9);
  assert.equal(quietWakeSpells(z, asleep), 1, 'the short spell and the spell after waking aren’t counted');
});

test('the local comparison ignores a few artefacts and needs enough data', () => {
  const steady = Array.from({ length: 300 }, (_, i) => 55 + (i % 3) * 0.5);
  const spiked = steady.map((v, i) => (i === 150 ? 120 : v));
  const mask = steady.map(() => true);
  assert.ok(Math.abs(localZ(spiked, mask)[100] ?? 9) < 5, 'one spike doesn’t distort its neighbours');
  assert.equal(localZ([50, 51, 52], [true, true, true])[1], null, 'too little around it');
});

test('a person’s choice of night or nap wins over the clock', () => {
  const noon = new Date(2026, 10, 5, 12).getTime();
  assert.equal(isNap(noon, 3600), true);
  assert.equal(isNap(noon, 3600, 'night'), false);
  assert.equal(isNap(noon - 12 * 3600000, 3600, 'nap'), true);
});

test('a night with lost heart data is marked uncertain, not given a stage', () => {
  const kept: SleepData = simulateNight(5).data;
  const t = Array.from(kept.rrT), r = Array.from(kept.rr);
  const from = 3 * 3600, to = 3.5 * 3600;
  const a = analyzeSleep({ ...kept, rrT: Float64Array.from(t.filter((x) => x < from || x > to)), rr: Float32Array.from(r.filter((_, i) => (t[i] ?? 0) < from || (t[i] ?? 0) > to)) });
  assert.ok(a.metrics.coverage < 96, `coverage ${a.metrics.coverage}`);
  assert.ok((a.metrics.rrPct ?? 100) < 96);
});

test('a recording saved in parts comes back whole', () => {
  const r = new SleepRecorder(25);
  const part = (seq: number): RecordingPart => ({ ...r.takeNew(), id: `1:${seq}`, rec: 1, user: 2, seq, at: seq, ecg: Int16Array.of(seq, seq) });
  r.addRR([800, 810]);
  r.addAcc(Int16Array.of(1, 2, 3, 4, 5, 6));
  const first = part(0);
  r.addRR([820]);
  r.addAcc(Int16Array.of(7, 8, 9));
  const second = part(1);
  const empty = part(2);
  assert.equal(second.rr.length, 1, 'only what is new');
  assert.equal(empty.rr.length, 0);
  const { data, ecg } = joinParts([empty, second, first]);
  assert.deepEqual([...data.rr], [800, 810, 820], 'in order, whatever order they are read in');
  assert.deepEqual([...data.acc.subarray(0, 9)], [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual([...ecg], [0, 0, 1, 1, 2, 2]);
  assert.equal(data.accFs, 25);
});

test('a night is dated by the evening it began: sleep after midnight belongs to the night before', async () => {
  const { nightOf } = await import('../src/sleep');
  assert.equal(nightOf(new Date(2026, 10, 11, 23, 6).getTime()), '2026-11-11');
  assert.equal(nightOf(new Date(2026, 10, 12, 1, 26).getTime()), '2026-11-11');
  assert.equal(nightOf(new Date(2026, 10, 12, 11, 59).getTime()), '2026-11-11');
  assert.equal(nightOf(new Date(2026, 10, 12, 12, 1).getTime()), '2026-11-12');
});
