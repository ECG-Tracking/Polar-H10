import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EcgSimulator, type Scenario } from '../src/sim';
import { analyze, sessionMetrics } from '../src/dsp';

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

test('rest metrics are physiological', () => {
  const { raw } = simulate('rest', 300, 7);
  const m = sessionMetrics(analyze(raw, { fs: FS }), 300, PROFILE);
  assert.ok(Math.abs(m.meanHR - 66) < 2, `mean HR ${m.meanHR}`);
  assert.ok(m.qrs >= 70 && m.qrs <= 110, `QRS ${m.qrs}`);
  assert.ok(m.qtc >= 390 && m.qtc <= 430, `QTc ${m.qtc}`);
  assert.equal(m.tPositive, 100);
  assert.equal(m.recovery, null);
});

test('workout yields effort and a heart-rate recovery', () => {
  const { raw } = simulate('workout', 300, 7);
  const m = sessionMetrics(analyze(raw, { fs: FS }), 300, PROFILE);
  assert.ok(m.trimp > 5, `TRIMP ${m.trimp}`);
  assert.ok(m.recovery && m.recovery.hrr60 > 40, `recovery ${JSON.stringify(m.recovery)}`);
});

test('an upside-down signal gives a negative R amplitude but the same timing', () => {
  const { raw } = simulate('rest', 120, 41);
  const up = sessionMetrics(analyze(raw, { fs: FS }), 120, PROFILE);
  const down = sessionMetrics(analyze(raw.map((v) => -v), { fs: FS }), 120, PROFILE);
  assert.ok(up.rAmp > 0 && down.rAmp < 0);
  assert.equal(down.qrs, up.qrs);
  assert.equal(down.qtc, up.qtc);
});
