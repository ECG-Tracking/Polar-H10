import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EcgSimulator, type Scenario } from '../src/sim';
import { analyze, cleanInterval, delineate, disturbed, hrSeries, sessionMetrics } from '../src/dsp';
import { CAL_MARGIN, ECG_SCALE_NOTE, PX_PER_MV, PX_PER_S } from '../src/charts';

const FS = 130;
const PROFILE = { hrRest: 60, hrMax: 180, sex: 'male' as const };

/** Simulated recording with the true beat times and which of them are ectopic. */
function simulate(scenario: Scenario, seconds: number, seed: number): { raw: Int32Array; truth: { t: number; ectopic: boolean }[] } {
  const sim = new EcgSimulator({ scenario, seed });
  const raw = new Int32Array(FS * seconds);
  const truth: { t: number; ectopic: boolean }[] = [];
  for (let i = 0; i < raw.length; i += FS) {
    raw.set(sim.next(Math.min(FS, raw.length - i)), i);
    for (const b of sim.beats) if (!truth.some((t) => Math.abs(t.t - b.t) < 0.01)) truth.push({ t: b.t, ectopic: b.ectopic });
  }
  return { raw, truth: truth.filter((t) => t.t > 0.3 && t.t < seconds - 0.5) };
}

for (const [scenario, seed] of [['rest', 7], ['workout', 7], ['workout', 11]] as const) {
  test(`${scenario} (seed ${seed}): every beat found, ectopics flagged, no false beats`, () => {
    const { raw, truth } = simulate(scenario, 300, seed);
    const a = analyze(raw, { fs: FS });
    const missed = truth.filter((t) => !a.beats.some((b) => Math.abs(b.t - t.t) < 0.05));
    const extra = a.beats.filter((b) => !truth.some((t) => Math.abs(b.t - t.t) < 0.05));
    assert.equal(missed.length, 0, `missed beats at ${missed.map((m) => m.t.toFixed(1)).join(', ')}`);
    assert.equal(extra.length, 0, 'false beats');
    for (const e of truth.filter((t) => t.ectopic)) {
      assert.ok(a.events.some((ev) => Math.abs(ev.t - e.t) < 0.05), `ectopic at ${e.t.toFixed(1)} s not flagged`);
    }
    const falseEvents = a.events.filter((ev) => !truth.some((t) => t.ectopic && Math.abs(ev.t - t.t) < 0.05));
    assert.equal(falseEvents.length, 0, 'false events');
  });
}

test('a big spike partway through (the strap knocked) doesn’t hide the beats after it', () => {
  const { raw, truth } = simulate('rest', 300, 7);
  // 2 s of a ±15 mV swing at 60 s, as when the strap is knocked
  for (let i = 60 * FS; i < 62 * FS; i++) raw[i] = (i % 26 < 13 ? 15000 : -15000);
  const a = analyze(raw, { fs: FS });
  const after = truth.filter((t) => t.t > 70);
  const found = after.filter((t) => a.beats.some((b) => Math.abs(b.t - t.t) < 0.05));
  assert.ok(found.length >= after.length * 0.98, `found ${found.length} of ${after.length} beats after the spike`);
});

test('beats flagged inside interference (poor skin contact) are interference, not events', () => {
  const { raw } = simulate('rest', 120, 7);
  // 40–80 s: rough interference as large as the heartbeats, as from a dry or loose strap
  let seed = 3;
  const rand = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
  for (let i = 40 * FS; i < 80 * FS; i++) raw[i] = (raw[i] ?? 0) + Math.round(rand() * 1600);
  const a = analyze(raw, { fs: FS });
  const inNoise = a.events.filter((e) => e.t > 42 && e.t < 78);
  assert.equal(inNoise.length, 0, `${inNoise.length} events reported inside the interference`);
  assert.ok(a.artifacts > 0, 'the interference is marked as such');
});

test('figures other than the event count leave out event beats, and a beat beside one whose shape it changed', () => {
  const beats = [0, 1, 2, 3, 4, 5, 6].map((k) => ({ t: k, r: k * FS, rr: k ? 1000 : null, flags: [] as ('premature' | 'pause' | 'shape' | 'artifact')[], m: null, shapeMatch: 0.98 }));
  beats[3]!.flags = ['premature']; beats[3]!.rr = 600; beats[4]!.rr = 1400;
  // neighbours of normal shape stay in
  assert.deepEqual(Array.from(disturbed(beats)), [0, 0, 0, 1, 0, 0, 0]);
  // a neighbour whose shape the event changed is left out too
  beats[4]!.shapeMatch = 0.8;
  assert.deepEqual(Array.from(disturbed(beats)), [0, 0, 0, 1, 1, 0, 0]);
  // on a noisy recording, where ordinary beats match only about as well, it stays in
  for (const b of beats) b.shapeMatch = 0.75;
  beats[4]!.shapeMatch = 0.8;
  assert.deepEqual(Array.from(disturbed(beats)), [0, 0, 0, 1, 0, 0, 0]);
  assert.deepEqual(beats.map((_, k) => cleanInterval(beats, k)), [false, true, true, false, false, true, true]);
  // the heart rate over time doesn't jump with the premature beat and the pause after it
  const hr = hrSeries(beats, 7).filter((v): v is number => v != null);
  assert.ok(hr.every((v) => Math.abs(v - 60) < 0.5), hr.join(', '));
});

test('T-wave direction is read where the T wave normally is, not from a bigger noise bump later in the beat', () => {
  const { raw, truth } = simulate('rest', 120, 7);
  // noise: a sharp bump 450–520 ms after each beat, bigger than the T wave, pointing up or down at random
  let seed = 11;
  const rand = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (const b of truth) {
    const i = Math.round((b.t + 0.45 + 0.07 * rand()) * FS), sign = rand() < 0.5 ? -1 : 1;
    for (let k = -2; k <= 2; k++) if (raw[i + k] != null) raw[i + k] = (raw[i + k] ?? 0) + sign * 450 * (1 - Math.abs(k) / 3);
  }
  const m = sessionMetrics(analyze(raw, { fs: FS }), 120, PROFILE);
  assert.ok(m.tPositive >= 90, `T wave positive ${m.tPositive.toFixed(0)} %`);
});

test('rest metrics are physiological', () => {
  const { raw } = simulate('rest', 300, 7);
  const m = sessionMetrics(analyze(raw, { fs: FS }), 300, PROFILE);
  assert.ok(Math.abs(m.meanHR - 66) < 2, `mean HR ${m.meanHR}`);
  assert.ok(m.qrs >= 70 && m.qrs <= 110, `QRS ${m.qrs}`);
  assert.ok(m.qtc >= 390 && m.qtc <= 430, `QTc ${m.qtc}`);
  assert.equal(m.tPositive, 100);
  assert.ok(m.tAmp >= 200 && m.tAmp <= 350, `T amplitude ${m.tAmp}`); // simulated T peak is 290 µV
  assert.ok(m.trRatio >= 0.15 && m.trRatio <= 0.4, `T/R ${m.trRatio}`); // 290 / ~1170
  assert.equal(m.recovery, null);
});

test('workout yields effort and a heart-rate recovery', () => {
  const { raw } = simulate('workout', 300, 7);
  const m = sessionMetrics(analyze(raw, { fs: FS }), 300, PROFILE);
  assert.ok(m.trimp > 5, `TRIMP ${m.trimp}`);
  assert.ok(m.recovery && m.recovery.hrr60 > 40, `recovery ${JSON.stringify(m.recovery)}`);
});

test('an upside-down signal swaps the R and S waves but keeps the timing', () => {
  const { raw } = simulate('rest', 120, 41);
  const up = sessionMetrics(analyze(raw, { fs: FS }), 120, PROFILE);
  const down = sessionMetrics(analyze(raw.map((v) => -v), { fs: FS }), 120, PROFILE);
  assert.ok(up.rAmp > 0 && down.rAmp >= 0 && down.sAmp > up.sAmp && up.sAmp > 0);
  assert.ok(up.tAmp > 0 && down.tAmp < 0);
  assert.ok(down.trRatio > up.trRatio); // always against the R wave, never the S wave
  assert.equal(down.qrs, up.qrs);
  assert.equal(down.qtc, up.qtc);
});

/** One beat at the given wave heights: [offset s, amplitude µV, width s]. */
function beat(waves: readonly (readonly [number, number, number])[]): { x: Float64Array; r: number } {
  const r = FS, x = new Float64Array(2 * FS);
  for (let i = 0; i < x.length; i++) for (const [at, a, w] of waves) x[i]! += a * Math.exp(-(((i - r) / FS - at) ** 2) / (2 * w * w));
  return { x, r };
}

test('a lead whose main wave points down: J where the trace meets the baseline, and R and S told apart', () => {
  // a small r, a deep S taken as the main wave, then the trace runs straight into a slowly rising ST and T
  const { x, r } = beat([[-0.14, 30, 0.02], [-0.03, 340, 0.01], [0, -560, 0.012], [0.18, 130, 0.06]]);
  const m = delineate(x, r, FS, 0.74, 0.74, -1);
  assert.ok(m);
  const jMs = ((m.offset - r) / FS) * 1000;
  assert.ok(jMs < 50, `J at ${jMs} ms`);
  assert.ok(m.qrs != null && m.qrs < 100, `QRS ${m.qrs}`);
  assert.ok(Math.abs(m.rAmp - 340) < 60, `R ${m.rAmp}`);
  assert.ok(Math.abs(m.sAmp - 560) < 60, `S ${m.sAmp}`);
});

test('a real S wave is still stepped over', () => {
  const { x, r } = beat([[0, 1000, 0.01], [0.03, -300, 0.01], [0.25, 250, 0.05]]);
  const m = delineate(x, r, FS, 0.8, 0.8, 1);
  assert.ok(m);
  assert.ok(((m.offset - r) / FS) * 1000 >= 40, `J ${m.offset - r}`);
  assert.ok(Math.abs(m.sAmp - 300) < 80, `S ${m.sAmp}`);
});

test('QRS, QT and QTc are the median beat’s, so the report matches its chart', () => {
  const { raw } = simulate('rest', 120, 41);
  const a = analyze(raw, { fs: FS });
  const m = sessionMetrics(a, 120, PROFILE);
  assert.ok(a.templateMeasure?.qt);
  assert.equal(m.qrs, a.templateMeasure.qrs);
  assert.equal(m.qt, a.templateMeasure.qt);
  assert.equal(m.qtc, a.templateMeasure.qtc);
});

test('the live ECG scale is the clinical one: one small square is 0.04 s across and 0.1 mV high', () => {
  assert.equal(PX_PER_S * 0.04, PX_PER_MV * 0.1);
  assert.equal(PX_PER_S / PX_PER_MV, 2.5); // 25 mm/s against 10 mm/mV
  assert.ok(ECG_SCALE_NOTE.includes('25 mm/s') && ECG_SCALE_NOTE.includes('10 mm/mV'));
  assert.ok(ECG_SCALE_NOTE.includes('1 mV tall and 0.2 s wide'));
  assert.equal((CAL_MARGIN - 4) % (0.2 * PX_PER_S), 0); // the mark sits on the large squares
});

import { looksLikeConnectionError } from '../src/dsp';
import { lostSamples, MAX_GAP_S } from '../src/polar';

test('lost ECG packets are noticed from the strap’s clock, jitter is not', () => {
  assert.equal(lostSamples(73 / 130, 73, 130), 0);
  assert.equal(lostSamples(74 / 130, 73, 130), 0, 'a sample of jitter');
  assert.equal(lostSamples(146 / 130, 73, 130), 73, 'one lost packet');
  assert.equal(lostSamples(3600, 73, 130), MAX_GAP_S * 130, 'a long outage is shortened');
  assert.equal(lostSamples(-1, 73, 130), 0);
});

test('a flagged beat beside lost signal is a connection error, not an event', () => {
  const { raw } = simulate('rest', 60, 3);
  const clean = analyze(raw, { fs: FS });
  const cut = Int32Array.from(raw);
  cut.fill(0, 30 * FS, 32 * FS); // two seconds lost, kept as a flat line
  const a = analyze(cut, { fs: FS });
  assert.ok(a.artifacts >= 1, `artifacts ${a.artifacts}`);
  assert.ok(!a.events.some((e) => e.t > 29.5 && e.t < 33.5), 'no event at the gap');
  assert.ok(a.events.length <= clean.events.length + 1);
  const x = new Float64Array(200).map((_, i) => Math.sin(i / 5) * 1000);
  assert.equal(looksLikeConnectionError(Int32Array.from(x), x, 0, 199, FS, 1000), false, 'a living signal');
  const spike = Float64Array.from(x); spike[100] = 9000;
  assert.equal(looksLikeConnectionError(Int32Array.from(x), spike, 0, 199, FS, 1000), true, 'a spike far above any beat');
});

test('ignoring Irregular Shape keeps those beats as ordinary beats and not events', () => {
  const { raw } = simulate('rest', 120, 5);
  const odd = Int32Array.from(raw);
  const a0 = analyze(odd, { fs: FS });
  const r = a0.beats[40]!.r;
  for (let i = r - 3; i <= r + 3; i++) odd[i] = -(odd[i] ?? 0); // one beat turned upside down: a different shape, on time
  const a = analyze(odd, { fs: FS }), b = analyze(odd, { fs: FS, ignoreShape: true });
  assert.ok(a.events.some((e) => e.type === 'shape'), 'flagged normally');
  assert.ok(!b.events.some((e) => e.type === 'shape'), 'not an event when ignored');
  assert.ok(b.beats.filter((x) => !x.flags.length).length > a.beats.filter((x) => !x.flags.length).length, 'counted as ordinary beats');
});

test('a burst as the finger meets the watch doesn’t hide the heartbeats after it', () => {
  const { raw } = simulate('rest', 30, 4);
  const clean = analyze(raw, { fs: FS });
  const burst = Int32Array.from(raw);
  for (let i = 0; i < FS; i++) burst[i] = Math.round(12000 * Math.sin(i / 3));
  const a = analyze(burst, { fs: FS });
  assert.ok(a.beats.length >= clean.beats.length - 2, `${a.beats.length} of ${clean.beats.length} beats`);
  assert.ok(!a.events.some((e) => e.t < 1.5), 'the burst is no event');
});
