// The other signals the Polar H10 records during a sleep, as strips to show under its ECG at the same moments: the
// breathing (the chest rising and falling, from the accelerometer), the movement (from the accelerometer) and the heart
// rate of each beat (from its RR intervals). Worked out from the raw sleep data, which stays on the device that recorded it.

import { ACC_MISSING, breathingBand, type SleepData } from './sleep';

export interface ChestSignals {
  /** Samples a second of `breathing` and `movement`. */
  fs: number;
  /** The chest's rise and fall in the breathing band (0.1–0.7 Hz), mG; NaN where the strap had no reading. */
  breathing: Float32Array;
  /** How much the body moved: the change in acceleration from its 1-second average, mG; NaN where there was no reading. */
  movement: Float32Array;
  /** Each beat's time (seconds from the start of the sleep recording) and heart rate (bpm). */
  beatT: Float64Array;
  hr: Float32Array;
}

/** The breathing axis is chosen afresh for each block of this many seconds (the strap turns with the body). */
const BLOCK_S = 60;

export function chestSignals(data: SleepData): ChestSignals {
  const fs = data.accFs;
  const n = Math.floor(data.acc.length / 3);
  const axes = [new Float64Array(n), new Float64Array(n), new Float64Array(n)] as const;
  const valid = new Uint8Array(n);
  const mag = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = data.acc[3 * i] ?? ACC_MISSING, y = data.acc[3 * i + 1] ?? ACC_MISSING, z = data.acc[3 * i + 2] ?? ACC_MISSING;
    if (x === ACC_MISSING || y === ACC_MISSING || z === ACC_MISSING) continue;
    valid[i] = 1;
    axes[0][i] = x; axes[1][i] = y; axes[2][i] = z;
    mag[i] = Math.hypot(x, y, z);
  }

  // breathing: in each block the axis that moves most in the breathing band, turned the same way as the block before,
  // so a breath goes up on the strip whichever axis carries it
  const bands = axes.map((ax) => breathingBand(ax, fs));
  const breathing = new Float32Array(n).fill(NaN);
  const per = Math.max(1, Math.round(BLOCK_S * fs));
  let prev = -1, prevSign = 1;
  for (let a = 0; a < n; a += per) {
    const b = Math.min(n, a + per);
    let best = 0, bestVar = -1;
    bands.forEach((band, k) => {
      let s2 = 0;
      for (let i = a; i < b; i++) if (valid[i]) s2 += (band[i] ?? 0) ** 2;
      if (s2 > bestVar) { bestVar = s2; best = k; }
    });
    let sign = 1;
    if (prev >= 0) {
      const p = bands[prev]!, c = bands[best]!;
      let dot = 0;
      for (let i = a; i < b; i++) if (valid[i]) dot += (p[i] ?? 0) * (c[i] ?? 0);
      sign = (dot < 0 ? -1 : 1) * prevSign;
    }
    const band = bands[best]!;
    for (let i = a; i < b; i++) if (valid[i]) breathing[i] = sign * (band[i] ?? 0);
    prev = best; prevSign = sign;
  }

  // movement: how far the acceleration is from its average over the second around it (as in the sleep analysis)
  const half = Math.max(1, Math.round(fs));
  const sum = new Float64Array(n + 1), count = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) { sum[i + 1] = sum[i]! + (valid[i] ? mag[i]! : 0); count[i + 1] = count[i]! + (valid[i] ?? 0); }
  const movement = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!valid[i]) continue;
    const a = Math.max(0, i - half), b = Math.min(n, i + half + 1);
    const c = count[b]! - count[a]!;
    if (c) movement[i] = Math.abs(mag[i]! - (sum[b]! - sum[a]!) / c);
  }

  // heart rate of each beat, leaving out a missed or extra beat: an interval over 25 % away from the median of the
  // 11 around it (as RR clean-up usually does)
  const keep: number[] = [];
  const rr = data.rr, near: number[] = [];
  for (let i = 0; i < rr.length; i++) {
    const v = rr[i] ?? 0;
    if (!(v >= 250 && v <= 2500)) continue;
    near.length = 0;
    for (let k = Math.max(0, i - 5); k <= Math.min(rr.length - 1, i + 5); k++) { const x = rr[k] ?? 0; if (x >= 250 && x <= 2500) near.push(x); }
    near.sort((x, y) => x - y);
    const med = near[near.length >> 1] ?? v;
    if (Math.abs(v - med) <= 0.25 * med) keep.push(i);
  }
  const beatT = Float64Array.from(keep, (i) => data.rrT[i] ?? 0);
  const hr = Float32Array.from(keep, (i) => 60000 / (data.rr[i] ?? 1000));
  return { fs, breathing, movement, beatT, hr };
}
