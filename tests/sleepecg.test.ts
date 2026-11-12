import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withEcgBeats } from '../src/sleepecg';

test('sleep: where the strap’s own intervals are noise, the ECG’s beats take their place; elsewhere the strap’s stay', () => {
  // 90 s: the strap is fine in the first and last 30 s and sends noise in the middle; the ECG's beats are fine throughout
  const strapT: number[] = [], strapRr: number[] = [];
  for (let t = 1; t < 90; t += 1) {
    const noisy = t >= 30 && t < 60;
    strapT.push(t); strapRr.push(noisy ? (t % 2 ? 400 : 2200) : 1000);
  }
  const ecgT: number[] = [], ecgRr: number[] = [];
  for (let t = 1.02; t < 90; t += 1) { ecgT.push(t); ecgRr.push(1000); }
  const data = { durationS: 90, rrT: Float64Array.from(strapT), rr: Float32Array.from(strapRr), acc: new Int16Array(0), accFs: 25 };
  const out = withEcgBeats(data, { t: Float64Array.from(ecgT), rr: Float32Array.from(ecgRr) });
  const inMiddle = Array.from(out.rrT).filter((t) => t >= 30 && t < 60);
  assert.ok(inMiddle.length >= 29 && inMiddle.every((t) => Math.abs((t % 1) - 0.02) < 1e-6), 'the middle comes from the ECG');
  assert.ok(Array.from(out.rr).filter((_, i) => (out.rrT[i] ?? 0) >= 30 && (out.rrT[i] ?? 0) < 60).every((v) => v === 1000));
  const outside = Array.from(out.rrT).filter((t) => t < 30 || t >= 60);
  assert.ok(outside.every((t) => Number.isInteger(t)), 'the rest is still the strap’s');
  for (let i = 1; i < out.rrT.length; i++) assert.ok(out.rrT[i]! > out.rrT[i - 1]!, 'in time order');
  // nothing to fill: the same data back
  const good = { ...data, rr: Float32Array.from(strapRr.map(() => 1000)) };
  assert.equal(withEcgBeats(good, { t: Float64Array.from(ecgT), rr: Float32Array.from(ecgRr) }), good);
});
