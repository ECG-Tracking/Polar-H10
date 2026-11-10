import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chestSignals } from '../src/chestsignals';
import { ACC_MISSING } from '../src/sleep';

test('chest strips: breathing follows the chest, movement shows a turn, a false beat is left out, a gap stays empty', () => {
  const fs = 25, seconds = 300, n = fs * seconds;
  const acc = new Int16Array(3 * n);
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    acc[3 * i] = 0;
    acc[3 * i + 1] = 0;
    acc[3 * i + 2] = Math.round(1000 + 20 * Math.sin(2 * Math.PI * 0.25 * t) + (t >= 200 && t < 202 ? 300 * Math.sin(2 * Math.PI * 3 * t) : 0));
  }
  for (let i = 250 * fs; i < 260 * fs; i++) acc.fill(ACC_MISSING, 3 * i, 3 * i + 3);
  const rrT: number[] = [], rr: number[] = [];
  for (let t = 1; t < seconds; t += 1) { rrT.push(t); rr.push(t === 100 ? 2000 : 1000); }
  const c = chestSignals({ durationS: seconds, rrT: Float64Array.from(rrT), rr: Float32Array.from(rr), acc, accFs: fs });

  // breathing: 15 breaths a minute, about ±20 mG, between 60 and 180 s
  let up = 0, peak = 0;
  for (let i = 60 * fs; i < 180 * fs; i++) {
    const v = c.breathing[i]!, p = c.breathing[i - 1]!;
    if (v > 0 && p <= 0) up++;
    peak = Math.max(peak, Math.abs(v));
  }
  assert.ok(Math.abs(up - 30) <= 1, `breaths ${up}`);
  assert.ok(peak > 15 && peak < 25, `peak ${peak}`);
  // movement: large during the turn at 200 s, small while still
  const avg = (a: number, b: number): number => { let s = 0; for (let i = a * fs; i < b * fs; i++) s += c.movement[i]!; return s / ((b - a) * fs); };
  assert.ok(avg(200, 202) > 50 && avg(100, 150) < 5);
  // no reading: no strip
  assert.ok(Number.isNaN(c.breathing[255 * fs]!) && Number.isNaN(c.movement[255 * fs]!));
  // heart rate 60 bpm, the 2-second interval left out
  assert.equal(c.hr.length, rr.length - 1);
  assert.ok(Array.from(c.hr).every((v) => Math.abs(v - 60) < 0.01));
});
