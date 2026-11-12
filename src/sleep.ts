// Overnight sleep analysis from the Polar H10's beat-to-beat (RR) intervals and chest accelerometer.
// Works in 30 s epochs, the unit used in sleep scoring. Sleep/wake comes from movement and heart rate;
// sleep stages are ESTIMATED from cardiorespiratory patterns (heart rate, HRV, breathing regularity)
// and are not a substitute for a sleep study (polysomnography).

import { Biquad, median } from './dsp';

export const EPOCH_S = 30;
/** Raised when the stages are worked out differently, so reports made before can be generated again. */
export const SLEEP_METHOD = 5;
/**
 * 5 (v1.44.5): heart rate, its spread and the breathing are averaged over 3.5 minutes either side before they are
 * compared (a stage lasts minutes, not 30 s); faster breathing counts towards REM; a stage other than light needs
 * stronger evidence (1.4 rather than 1.2); and beats the strap's own intervals miss come from the night's ECG (sleepecg.ts).
 * Checked against the Watch D2 on 8 nights: it agreed with the watch on every night at least as well as method 4.
 */
const SMOOTH_EPOCHS = 7;
const STAGE_EVIDENCE = 1.4;
const LOCAL_REACH = 90; // epochs either side: 45 min
const MIN_BOUT_EPOCHS = 10; // 5 min
const NIGHT_PULL = 0.5; // how far the time of night moves the deep and REM scores, at its strongest
const MIN_PATTERN_S = 3 * 3600;
const RR_JOIN_S = 5;
const MIN_LOCAL_EPOCHS = 20; // 10 min of sleep around an epoch, to compare it with
const EARLY_REM_MIN = 50, EARLY_REM_PULL = 1; // REM is unusual soon after falling asleep, but strong evidence can overrule that
const QUIET_WAKE_Z = 2, QUIET_WAKE_EPOCHS = 4; // heart rate well above its surroundings for 2 min, without moving
/** Accelerometer value marking a missing sample (strap disconnected). */
export const ACC_MISSING = -32768;

export type Stage = 'awake' | 'rem' | 'light' | 'deep' | 'uncertain' | 'nodata'; // uncertain: asleep, but too little signal to name the stage

export interface SleepData {
  durationS: number;
  rrT: Float64Array; // time of each beat, seconds from the start of the recording
  rr: Float32Array; // interval ending at that beat, ms
  acc: Int16Array; // x, y, z interleaved at accFs, mG; ACC_MISSING where the strap was disconnected
  accFs: number;
}

export interface SleepMetrics {
  timeInBedMin: number;
  sleepMin: number; // deep + light + REM + uncertain
  deepMin: number;
  lightMin: number;
  remMin: number;
  awakeMin: number; // awake after falling asleep (WASO)
  latencyMin: number; // minutes to fall asleep
  efficiency: number; // % of time in bed asleep
  deepPct: number; // % of sleep
  lightPct: number;
  remPct: number;
  awakenings: number; // awake spells of at least 2 min after falling asleep
  avgHR: number; // bpm while asleep
  minHR: number;
  avgHrv: number; // RMSSD while asleep, ms
  breathingRate: number; // breaths/min while asleep
  breathingRegularity: number; // points 0–100
  deepContinuity: number; // points 0–100
  score: number; // points 0–100
  onsetS: number; // seconds from start, NaN if no sleep found
  wakeS: number;
  coverage: number; // % of the night with both usable heart and movement data
  // % of the night with each signal; missing from reports made before v1.33.0
  rrPct?: number; hrvPct?: number; movementPct?: number; breathingPct?: number;
  uncertainMin?: number; // asleep, but too little signal to name the stage
  quietWakes?: number; // spells of raised heart rate without moving: possibly awake. A note only: stages and score ignore it
}

export interface SleepAnalysis {
  stages: Stage[]; // one per epoch
  hr: (number | null)[]; // bpm per epoch
  breathing: (number | null)[]; // breaths/min per epoch
  activity: (number | null)[]; // mG per epoch
  metrics: SleepMetrics;
}

const at = (a: ArrayLike<number>, i: number): number => a[i] ?? 0;
const mean = (a: readonly number[]): number => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const std = (a: readonly number[]): number => {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};
const finite = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

function percentile(a: readonly number[], p: number): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return at(s, Math.min(s.length - 1, Math.floor(p * s.length)));
}

// ---------- Movement and breathing from the accelerometer ----------

interface AccFeatures {
  activity: (number | null)[]; // mean |magnitude change| per epoch, mG
  posture: ([number, number, number] | null)[]; // mean gravity direction per epoch (unit vector)
  breathing: (number | null)[]; // breaths/min
  breathCv: (number | null)[]; // breath-to-breath variation (0 = perfectly regular)
}

/** Zero-phase 0.1–0.7 Hz band-pass, the breathing band. */
export function breathingBand(x: Float64Array, fs: number): Float64Array {
  const y = new Float64Array(x.length);
  const run = (from: Float64Array, to: Float64Array, reverse: boolean): void => {
    const hp = new Biquad('highpass', 0.1, fs), lp = new Biquad('lowpass', 0.7, fs);
    for (let k = 0; k < from.length; k++) {
      const i = reverse ? from.length - 1 - k : k;
      to[i] = lp.process(hp.process(at(from, i)));
    }
  };
  run(x, y, false);
  run(y, y, true);
  return y;
}

/** Variation between breaths in one stretch of a breathing-band signal: 0 = perfectly regular. Also gives the rate. */
function breathsIn(band: Float64Array, a: number, b: number, fs: number): { rate: number; cv: number } | null {
  let s2 = 0;
  for (let i = a; i < b; i++) s2 += at(band, i) ** 2;
  const sd = Math.sqrt(s2 / (b - a));
  // upward crossings with hysteresis, so noise around zero isn't counted as breaths
  const hi = 0.3 * sd, lo = -0.3 * sd;
  const crossings: number[] = [];
  let armed = false;
  for (let i = a; i < b; i++) {
    const v = at(band, i);
    if (v < lo) armed = true;
    else if (armed && v > hi) { crossings.push(i / fs); armed = false; }
  }
  const intervals: number[] = [];
  for (let k = 1; k < crossings.length; k++) intervals.push(at(crossings, k) - at(crossings, k - 1));
  const m = mean(intervals);
  const rate = 60 / m;
  if (intervals.length < 4 || !(rate >= 5 && rate <= 35)) return null;
  return { rate, cv: std(intervals) / m };
}

function accFeatures(data: SleepData, nE: number): AccFeatures {
  const fs = data.accFs;
  const n = Math.floor(data.acc.length / 3);
  const per = EPOCH_S * fs;
  const axes = [new Float64Array(n), new Float64Array(n), new Float64Array(n)] as const;
  const valid = new Uint8Array(n);
  const mag = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = at(data.acc, 3 * i), y = at(data.acc, 3 * i + 1), z = at(data.acc, 3 * i + 2);
    if (x === ACC_MISSING || y === ACC_MISSING || z === ACC_MISSING) continue;
    valid[i] = 1;
    axes[0][i] = x; axes[1][i] = y; axes[2][i] = z;
    mag[i] = Math.hypot(x, y, z);
  }

  // movement: deviation of the magnitude from its 1 s moving average
  const win = Math.max(1, Math.round(fs));
  const activity: (number | null)[] = [];
  const posture: ([number, number, number] | null)[] = [];
  for (let e = 0; e < nE; e++) {
    const a = e * per, b = Math.min(n, a + per);
    let sum = 0, cnt = 0, gx = 0, gy = 0, gz = 0;
    for (let i = a; i < b; i++) {
      if (!valid[i]) continue;
      let m = 0, c = 0;
      for (let j = Math.max(a, i - win); j <= Math.min(b - 1, i + win); j++) if (valid[j]) { m += at(mag, j); c++; }
      sum += Math.abs(at(mag, i) - m / c);
      cnt++;
      gx += at(axes[0], i); gy += at(axes[1], i); gz += at(axes[2], i);
    }
    if (cnt < per / 2) { activity.push(null); posture.push(null); continue; }
    activity.push(sum / cnt);
    const len = Math.hypot(gx, gy, gz) || 1;
    posture.push([gx / len, gy / len, gz / len]);
  }

  // breathing: the chest rises and falls; take the axis with most breathing-band movement in each minute
  const bands = axes.map((ax) => breathingBand(ax, fs));
  const breathing: (number | null)[] = [];
  const breathCv: (number | null)[] = [];
  for (let e = 0; e < nE; e++) {
    const mid = (e + 0.5) * per;
    const a = Math.max(0, Math.round(mid - 30 * fs)), b = Math.min(n, Math.round(mid + 30 * fs));
    let okSamples = 0;
    for (let i = a; i < b; i++) okSamples += at(valid, i);
    if (b - a < 40 * fs || okSamples < 0.9 * (b - a)) { breathing.push(null); breathCv.push(null); continue; }
    let best: Float64Array = bands[0] ?? new Float64Array(n), bestVar = -1;
    for (const band of bands) {
      let s2 = 0;
      for (let i = a; i < b; i++) s2 += at(band, i) ** 2;
      if (s2 > bestVar) { bestVar = s2; best = band; }
    }
    const b1 = breathsIn(best, a, b, fs);
    breathing.push(b1?.rate ?? null);
    breathCv.push(b1?.cv ?? null);
  }
  return { activity, posture, breathing, breathCv };
}

// ---------- Heart rate and HRV from RR intervals ----------

interface HeartFeatures {
  hr: (number | null)[];
  rmssd: (number | null)[]; // 5 min window centred on each epoch
  hrVar: (number | null)[]; // spread of epoch heart rates over 5 epochs
  rrBreathCv: (number | null)[]; // breathing regularity seen in the heartbeats (they speed up and slow down with each breath)
}

/**
 * Each breath moves the beat intervals: the intervals, evenly resampled, carry the breathing, independent of how the strap
 * lies. Only beats that passed the checks are used, joined across gaps of up to 5 s, as one bad beat shouldn't lose a minute.
 */
function heartBreathing(data: SleepData, nE: number, keep: Uint8Array): (number | null)[] {
  const fs = 4, n = Math.floor(nE * EPOCH_S * fs);
  const x = new Float64Array(n), have = new Uint8Array(n);
  const beats: number[] = [];
  for (let i = 0; i < keep.length; i++) if (keep[i]) beats.push(i);
  let j = 1;
  for (let i = 0; i < n && beats.length > 1; i++) {
    const t = i / fs;
    while (j < beats.length - 1 && at(data.rrT, at(beats, j)) < t) j++;
    const p = at(beats, j - 1), q = at(beats, j);
    const t0 = at(data.rrT, p), t1 = at(data.rrT, q);
    if (t < t0 || t > t1 || t1 - t0 > RR_JOIN_S) continue;
    x[i] = at(data.rr, p) + ((t - t0) / (t1 - t0)) * (at(data.rr, q) - at(data.rr, p));
    have[i] = 1;
  }
  const m = mean(Array.from(x).filter((_, i) => have[i]));
  for (let i = 0; i < n; i++) x[i] = have[i] ? at(x, i) - m : 0;
  const band = breathingBand(x, fs);
  const out: (number | null)[] = [];
  for (let e = 0; e < nE; e++) {
    const mid = (e + 0.5) * EPOCH_S * fs;
    const a = Math.max(0, Math.round(mid - 30 * fs)), b = Math.min(n, Math.round(mid + 30 * fs));
    let ok = 0;
    for (let i = a; i < b; i++) ok += at(have, i);
    out.push(b - a < 40 * fs || ok < 0.75 * (b - a) ? null : breathsIn(band, a, b, fs)?.cv ?? null);
  }
  return out;
}

function heartFeatures(data: SleepData, nE: number): HeartFeatures {
  // clean intervals: plausible, and within 20 % of their neighbours (drops ectopic beats and artefacts)
  const n = data.rr.length;
  const keep = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = at(data.rr, i);
    if (v < 300 || v > 2000) continue;
    const ctx: number[] = [];
    for (let j = Math.max(0, i - 5); j <= Math.min(n - 1, i + 5); j++) if (j !== i) ctx.push(at(data.rr, j));
    const med = median(ctx);
    if (!(Math.abs(v - med) <= 0.2 * med)) continue;
    keep[i] = 1;
  }
  const byEpoch: number[][] = Array.from({ length: nE }, () => []);
  // successive differences only between consecutive clean beats with no gap in between
  const diffsByEpoch: number[][] = Array.from({ length: nE }, () => []);
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    const t = at(data.rrT, i), e = Math.floor(t / EPOCH_S);
    if (e < 0 || e >= nE) continue;
    byEpoch[e]?.push(at(data.rr, i));
    if (i > 0 && keep[i - 1] && Math.abs(t - at(data.rrT, i - 1) - at(data.rr, i) / 1000) < 0.05) {
      diffsByEpoch[e]?.push(at(data.rr, i) - at(data.rr, i - 1));
    }
  }
  const hr = byEpoch.map((v) => (v.length >= 10 ? 60000 / mean(v) : null));
  const rmssd: (number | null)[] = [];
  const hrVar: (number | null)[] = [];
  for (let e = 0; e < nE; e++) {
    const d: number[] = [];
    for (let k = Math.max(0, e - 5); k <= Math.min(nE - 1, e + 4); k++) d.push(...(diffsByEpoch[k] ?? []));
    rmssd.push(d.length >= 60 ? Math.sqrt(mean(d.map((v) => v * v))) : null);
    const w: number[] = [];
    for (let k = Math.max(0, e - 2); k <= Math.min(nE - 1, e + 2); k++) { const v = hr[k]; if (finite(v)) w.push(v); }
    hrVar.push(w.length >= 3 ? std(w) : null);
  }
  return { hr, rmssd, hrVar, rrBreathCv: heartBreathing(data, nE, keep) };
}

// ---------- Scoring ----------

function zScores(values: readonly (number | null)[], mask: readonly boolean[]): (number | null)[] {
  const pool = values.filter((v, i): v is number => finite(v) && (mask[i] ?? false));
  const m = mean(pool), s = std(pool) || 1;
  return values.map((v) => (finite(v) ? (v - m) / s : null));
}

/**
 * How far each value is from its surroundings: the sleep epochs within 45 min either side, so 90 min in all. Heart rate
 * drifts through the night, and a comparison with the whole night would only find its lowest hours.
 */
export function localZ(values: readonly (number | null)[], mask: readonly boolean[], reach = LOCAL_REACH): (number | null)[] {
  const n = values.length;
  const residual = values.map((v, i) => {
    if (!finite(v)) return null;
    const around: number[] = [];
    for (let k = Math.max(0, i - reach); k <= Math.min(n - 1, i + reach); k++) {
      const u = values[k];
      if (finite(u) && (mask[k] ?? false)) around.push(u);
    }
    // a mean, not a median: heart rate spikes upward, and a median would make every ordinary value look high
    return around.length >= MIN_LOCAL_EPOCHS ? v - mean(around) : null; // too little around it to judge
  });
  const pool = residual.filter((v, i): v is number => finite(v) && (mask[i] ?? false));
  // spread measured with outliers capped: a few artefacts can't widen it, and it stays on the scale the thresholds were set for
  const robust = 1.4826 * median(pool.map(Math.abs));
  const cap = Number.isFinite(robust) && robust > 0 ? 4 * robust : Infinity;
  const s = std(pool.map((v) => Math.max(-cap, Math.min(cap, v)))) || 1;
  return residual.map((v) => (finite(v) ? v / s : null));
}

/**
 * Stages last minutes, so shorter runs are put right: a short gap between two runs of one stage takes that stage, any
 * other short deep or REM run becomes light. Awake and missing epochs stay as they are.
 */
export function minBouts(stages: readonly Stage[], min = MIN_BOUT_EPOCHS): Stage[] {
  const out = [...stages];
  const fix = (shortRun: (s: Stage) => boolean): void => {
    for (const r of runs(out)) {
      if (r.to - r.from >= min || !shortRun(r.value)) continue;
      const before = out[r.from - 1], after = out[r.to];
      const next: Stage = before === after && (before === 'deep' || before === 'rem' || before === 'light') ? before : 'light';
      for (let e = r.from; e < r.to; e++) out[e] = next;
    }
  };
  fix((s) => s === 'light'); // joins two parts of a deep or REM run first
  fix((s) => s === 'deep' || s === 'rem');
  return out;
}

/** Replaces each value with the most common one in a window, removing single-epoch flicker. */
function modeFilter<T>(a: readonly T[], half: number): T[] {
  return a.map((v, i) => {
    const counts = new Map<T, number>();
    for (let k = Math.max(0, i - half); k <= Math.min(a.length - 1, i + half); k++) {
      const x = a[k] as T;
      counts.set(x, (counts.get(x) ?? 0) + 1);
    }
    let best = v, bc = counts.get(v) ?? 0;
    for (const [x, c] of counts) if (c > bc) { best = x; bc = c; }
    return best;
  });
}

function runs<T>(a: readonly T[]): { value: T; from: number; to: number }[] {
  const out: { value: T; from: number; to: number }[] = [];
  a.forEach((v, i) => {
    const last = out[out.length - 1];
    if (last && last.value === v) last.to = i + 1;
    else out.push({ value: v, from: i, to: i + 1 });
  });
  return out;
}

/** Day-time sleep: the middle of the recording falls between 08:00 and 20:00 local time. */
export function isNap(start: number, durationS: number, context?: 'night' | 'nap'): boolean {
  if (context) return context === 'nap'; // what the person said wins over the clock

  const hour = new Date(start + durationS * 500).getHours();
  return hour >= 8 && hour < 20;
}

/** Overall score from documented components; see SCORE_EXPLANATION. */
export function sleepScore(m: Pick<SleepMetrics, 'sleepMin' | 'efficiency' | 'deepPct' | 'remPct' | 'awakenings'>): number {
  const hours = m.sleepMin / 60;
  let score = 100;
  if (hours < 7) score -= Math.min(40, (7 - hours) * 10);
  if (hours > 9) score -= Math.min(10, (hours - 9) * 5);
  if (m.efficiency < 85) score -= Math.min(20, 85 - m.efficiency);
  if (m.deepPct < 15) score -= Math.min(10, 15 - m.deepPct);
  if (m.remPct < 15) score -= Math.min(10, 15 - m.remPct);
  if (m.awakenings > 1) score -= Math.min(15, (m.awakenings - 1) * 3);
  return Math.round(clamp(score, 0, 100));
}

export const SCORE_EXPLANATION =
  'Starts at 100. Minus 10 per hour of sleep under 7 h (max 40) and 5 per hour over 9 h; minus 1 per % of sleep efficiency under 85 % (max 20); ' +
  'minus 1 per % of deep sleep under 15 % and of REM under 15 % (max 10 each); minus 3 per awakening after the first (max 15).';

/** A score from the measures that exist. It isn't scaled up for those missing, so less evidence can't make a stage look more certain. */
export function weighted(terms: readonly (readonly [number | null | undefined, number])[]): number {
  return terms.reduce((sum, [z, w]) => sum + (z == null ? 0 : z * w), 0);
}

/** Spells of at least `min` epochs while asleep with heart rate well above its surroundings. */
export function quietWakeSpells(zHr: readonly (number | null)[], asleep: readonly boolean[], min = QUIET_WAKE_EPOCHS): number {
  return runs(zHr.map((z, e) => (asleep[e] ?? false) && z != null && z >= QUIET_WAKE_Z)).filter((r) => r.value && r.to - r.from >= min).length;
}

/** Each value averaged with the SMOOTH_EPOCHS on each side that have one; null where none has. */
function smooth(a: readonly (number | null)[]): (number | null)[] {
  return a.map((_, e) => {
    let sum = 0, n = 0;
    for (let k = e - SMOOTH_EPOCHS; k <= e + SMOOTH_EPOCHS; k++) { const v = a[k]; if (finite(v)) { sum += v; n++; } }
    return n ? sum / n : null;
  });
}

export function analyzeSleep(data: SleepData, options: { onsetUnknown?: boolean } = {}): SleepAnalysis {
  const nE = Math.max(1, Math.floor(data.durationS / EPOCH_S));
  const acc = accFeatures(data, nE);
  const heart = heartFeatures(data, nE);

  // ---- awake or asleep, per epoch ----
  const acts = acc.activity.filter(finite);
  const actThr = Math.max(8, 2.5 * median(acts));
  const hrs = heart.hr.filter(finite);
  const hrBase = percentile(hrs, 0.2);
  const hasData = acc.activity.map((a, e) => a !== null || heart.hr[e] !== null);
  const rawWake = acc.activity.map((a, e) => {
    const h = heart.hr[e];
    const prev = acc.posture[e - 1], cur = acc.posture[e];
    const turned = prev && cur ? Math.acos(clamp(prev[0] * cur[0] + prev[1] * cur[1] + prev[2] * cur[2], -1, 1)) > (20 * Math.PI) / 180 : false;
    const moving = a !== null && a > actThr;
    const hrHigh = finite(h) && h > hrBase + 12 && a !== null && a > 0.5 * actThr;
    return moving || turned || hrHigh;
  });
  // a single moving epoch (turning over) is not waking up; it takes most of 3 epochs
  const wake = rawWake.map((_, e) => {
    let c = 0;
    for (let k = e - 1; k <= e + 1; k++) if (rawWake[k]) c++;
    return c >= 2;
  });

  // ---- sleep period: fell asleep at the first 10 min of continuous sleep, woke after the last 5 min ----
  const asleep = (e: number): boolean => (hasData[e] ?? false) && !(wake[e] ?? true);
  let onset = -1;
  for (let e = 0; e + 20 <= nE && onset < 0; e++) {
    let ok = true;
    for (let k = e; k < e + 20; k++) if (!asleep(k)) { ok = false; break; }
    if (ok) onset = e;
  }
  let wakeIdx = -1;
  if (onset >= 0) {
    for (let e = nE - 1; e >= onset + 10 && wakeIdx < 0; e--) {
      let ok = true;
      for (let k = e - 9; k <= e; k++) if (!asleep(k)) { ok = false; break; }
      if (ok) wakeIdx = e + 1;
    }
    if (wakeIdx < 0) wakeIdx = onset + 20;
  }
  const inPeriod = (e: number): boolean => onset >= 0 && e >= onset && e < wakeIdx;
  const sleepMask = Array.from({ length: nE }, (_, e) => inPeriod(e) && asleep(e));

  // ---- stages: estimated from heart rate, HRV and breathing, relative to the surrounding 90 minutes ----
  const zHR = localZ(smooth(heart.hr), sleepMask);
  const zVar = localZ(smooth(heart.hrVar), sleepMask);
  const zRate = localZ(smooth(acc.breathing), sleepMask); // breathing is faster in REM sleep
  const zRm = localZ(heart.rmssd, sleepMask);
  const zChest = zScores(smooth(acc.breathCv), sleepMask), zHeart = zScores(smooth(heart.rrBreathCv), sleepMask);
  const zCv = zChest.map((c, e) => { const h = zHeart[e] ?? null; return c != null && h != null ? (c + h) / 2 : c ?? h; });
  const periodE = Math.max(1, wakeIdx - onset);
  // over a whole night, deep sleep is likelier early and REM late; short sleep has no such pattern
  // a recording started after falling asleep can't say how far through the night it is
  const nightLong = periodE * EPOCH_S >= MIN_PATTERN_S && !options.onsetUnknown;
  let stages: Stage[] = Array.from({ length: nE }, (_, e): Stage => {
    if (!hasData[e]) return 'nodata';
    if (!inPeriod(e) || !asleep(e)) return 'awake';
    const through = nightLong ? clamp((e - onset) / periodE, 0, 1) : 0.5; // 0 = start of the night, 1 = end
    // heart rate, HRV and breathing are the evidence: with fewer than two of them, say so rather than guess
    const hr = zHR[e] ?? null, hrSpread = zVar[e] ?? null, hrv = zRm[e] ?? null, breath = zCv[e] ?? null;
    if ([hr, hrv, breath].filter((z) => z != null).length < 2) return 'uncertain';
    const minutesAsleep = ((e - onset) * EPOCH_S) / 60;
    const early = nightLong ? EARLY_REM_PULL * Math.max(0, 1 - minutesAsleep / EARLY_REM_MIN) : 0;
    const deep = weighted([[hr, -1], [breath, -1], [hrv, 0.5], [hrSpread, -0.5]]) + NIGHT_PULL * (1 - 2 * through);
    const rem = weighted([[hr, 1], [hrSpread, 1], [breath, 1], [hrv, -0.3], [zRate[e], 1]]) + NIGHT_PULL * (2 * through - 1) - early;
    if (deep > STAGE_EVIDENCE || rem > STAGE_EVIDENCE) return deep >= rem ? 'deep' : 'rem'; // the stronger evidence decides
    return 'light';
  });
  // smooth sleep stages without moving awake/no-data epochs
  const smoothed = modeFilter(stages, 3);
  const fixed = (s: Stage | undefined): boolean => s === 'awake' || s === 'nodata' || s === 'uncertain';
  stages = minBouts(stages.map((s, e) => (fixed(s) || fixed(smoothed[e]) ? s : smoothed[e] ?? s)));

  // ---- metrics ----
  const count = (s: Stage, inside = true): number => stages.filter((x, e) => x === s && (!inside || inPeriod(e))).length;
  const toMin = (epochs: number): number => (epochs * EPOCH_S) / 60;
  const deepE = count('deep'), lightE = count('light'), remE = count('rem');
  const uncertainE = count('uncertain');
  const sleepE = deepE + lightE + remE + uncertainE;
  const awakeE = count('awake');
  const awakeRuns = runs(stages.map((s, e) => (inPeriod(e) ? s : 'out'))).filter((r) => r.value === 'awake');
  const awakenings = awakeRuns.filter((r) => r.to - r.from >= 4).length; // at least 2 min
  const asleepHR = heart.hr.filter((h, e): h is number => finite(h) && (sleepMask[e] ?? false));
  const asleepRm = heart.rmssd.filter((h, e): h is number => finite(h) && (sleepMask[e] ?? false));
  const asleepBr = acc.breathing.filter((h, e): h is number => finite(h) && (sleepMask[e] ?? false));
  const asleepCv = acc.breathCv.filter((h, e): h is number => finite(h) && (sleepMask[e] ?? false));
  const deepRuns = runs(stages).filter((r) => r.value === 'deep');
  const deepInLongRuns = deepRuns.filter((r) => r.to - r.from >= 20).reduce((s, r) => s + r.to - r.from, 0);
  const timeInBedE = nE;
  const pct = (part: number): number => (sleepE ? (100 * part) / sleepE : 0);
  const share = (ok: (e: number) => boolean): number => (100 * Array.from({ length: nE }, (_, e) => ok(e)).filter(Boolean).length) / nE;
  const partial: Omit<SleepMetrics, 'score'> = {
    timeInBedMin: toMin(timeInBedE),
    sleepMin: toMin(sleepE),
    deepMin: toMin(deepE),
    lightMin: toMin(lightE),
    remMin: toMin(remE),
    awakeMin: toMin(awakeE),
    latencyMin: onset >= 0 ? toMin(onset) : NaN,
    efficiency: timeInBedE ? (100 * sleepE) / timeInBedE : 0,
    deepPct: pct(deepE),
    lightPct: pct(lightE),
    remPct: pct(remE),
    awakenings,
    avgHR: mean(asleepHR),
    minHR: asleepHR.length ? Math.min(...asleepHR) : NaN,
    avgHrv: mean(asleepRm),
    breathingRate: mean(asleepBr),
    breathingRegularity: asleepCv.length ? Math.round(clamp(100 * (1 - median(asleepCv) / 0.5), 0, 100)) : NaN,
    deepContinuity: deepE ? Math.round((100 * deepInLongRuns) / deepE) : NaN,
    onsetS: onset >= 0 ? onset * EPOCH_S : NaN,
    wakeS: wakeIdx >= 0 ? wakeIdx * EPOCH_S : NaN,
    coverage: share((e) => finite(heart.hr[e]) && finite(acc.activity[e])),
    rrPct: share((e) => finite(heart.hr[e])), hrvPct: share((e) => finite(heart.rmssd[e])),
    movementPct: share((e) => finite(acc.activity[e])), breathingPct: share((e) => finite(acc.breathCv[e]) || finite(heart.rrBreathCv[e])),
    uncertainMin: toMin(uncertainE), quietWakes: quietWakeSpells(localZ(heart.hr, sleepMask), sleepMask),
  };
  const metrics: SleepMetrics = { ...partial, score: sleepE ? sleepScore(partial) : 0 };
  return { stages, hr: heart.hr, breathing: acc.breathing, activity: acc.activity, metrics };
}

// ---------- Recording helpers (used live) ----------

/** What a sleep recording added since the last save, so a closed page or a crash loses only the last minutes. */
export interface RecordingPart {
  id: string; // `${rec}:${seq}`
  rec: number; // when the recording started, ms: its id
  user: number;
  seq: number;
  at: number; // when this part was saved, ms
  durationS: number; // of the whole recording so far
  accFs: number;
  rrT: Float64Array; rr: Float32Array; acc: Int16Array; ecg: Int16Array;
}

/** The parts of one recording put back together. */
export function joinParts(parts: readonly RecordingPart[]): { data: SleepData; ecg: Int16Array } {
  const sorted = [...parts].sort((a, b) => a.seq - b.seq);
  const last = sorted[sorted.length - 1];
  const size = (f: (p: RecordingPart) => { length: number }): number => sorted.reduce((s, p) => s + f(p).length, 0);
  const durationS = last?.durationS ?? 0, accFs = last?.accFs ?? 25;
  const rrT = new Float64Array(size((p) => p.rrT)), rr = new Float32Array(size((p) => p.rr)), ecg = new Int16Array(size((p) => p.ecg));
  const acc = new Int16Array(Math.max(size((p) => p.acc), 3 * Math.round(durationS * accFs))).fill(ACC_MISSING);
  let b = 0, a = 0, e = 0;
  for (const p of sorted) {
    rrT.set(p.rrT, b); rr.set(p.rr, b); b += p.rr.length;
    acc.set(p.acc, a); a += p.acc.length;
    ecg.set(p.ecg, e); e += p.ecg.length;
  }
  return { data: { durationS, rrT, rr, acc, accFs }, ecg };
}

/** Collects RR intervals and accelerometer samples as they arrive, keeping timing across dropouts. */
export class SleepRecorder {
  readonly start = Date.now();
  private rrT: number[] = [];
  private rr: number[] = [];
  private accChunks: Int16Array[] = [];
  private accCursor = 0; // samples written so far (per axis)
  private beatClock = 0; // seconds of the last beat
  private sentBeats = 0; private sentChunks = 0; // what takeNew has already handed over

  constructor(readonly accFs: number) {}

  /** Everything since the last call, for saving part of the recording. */
  takeNew(): Pick<SleepData, 'durationS' | 'rrT' | 'rr' | 'acc' | 'accFs'> {
    const chunks = this.accChunks.slice(this.sentChunks);
    const acc = new Int16Array(chunks.reduce((s, c) => s + c.length, 0));
    let o = 0;
    for (const c of chunks) { acc.set(c, o); o += c.length; }
    const part = { durationS: this.now(), rrT: Float64Array.from(this.rrT.slice(this.sentBeats)), rr: Float32Array.from(this.rr.slice(this.sentBeats)), acc, accFs: this.accFs };
    this.sentBeats = this.rr.length;
    this.sentChunks = this.accChunks.length;
    return part;
  }

  private now(): number { return (Date.now() - this.start) / 1000; }

  addRR(intervals: readonly number[]): void {
    const t = this.now();
    const total = intervals.reduce((s, v) => s + v, 0) / 1000;
    // after a gap (or at the start) re-anchor beat times on the arrival time
    if (t - this.beatClock > 5 || this.rr.length === 0) this.beatClock = t - total;
    for (const v of intervals) {
      this.beatClock += v / 1000;
      this.rrT.push(this.beatClock);
      this.rr.push(v);
    }
  }

  addAcc(samples: Int16Array): void {
    const n = samples.length / 3;
    const arrived = Math.round(this.now() * this.accFs) - n;
    // more than 2 s behind the clock means the strap dropped out: leave the gap as missing samples
    if (arrived - this.accCursor > 2 * this.accFs) {
      const gap = new Int16Array(3 * (arrived - this.accCursor)).fill(ACC_MISSING);
      this.accChunks.push(gap);
      this.accCursor = arrived;
    }
    this.accChunks.push(samples);
    this.accCursor += n;
  }

  get elapsedS(): number { return this.now(); }
  get beats(): number { return this.rr.length; }

  /** Everything recorded so far, as stored and analysed. */
  data(): SleepData {
    const durationS = this.now();
    const total = Math.max(this.accCursor, Math.round(durationS * this.accFs));
    const acc = new Int16Array(3 * total).fill(ACC_MISSING);
    let o = 0;
    for (const c of this.accChunks) { acc.set(c.subarray(0, Math.min(c.length, acc.length - o)), o); o += c.length; }
    return { durationS, rrT: Float64Array.from(this.rrT), rr: Float32Array.from(this.rr), acc, accFs: this.accFs };
  }

  /** Recent values for the live screen. */
  recent(seconds: number): { hr: number | null; moving: boolean | null } {
    const since = this.now() - seconds;
    const rr: number[] = [];
    for (let i = this.rrT.length - 1; i >= 0 && (this.rrT[i] ?? 0) >= since; i--) rr.push(this.rr[i] ?? 0);
    const last = this.accChunks[this.accChunks.length - 1];
    let moving: boolean | null = null;
    if (last && last.length >= 30) {
      const mags: number[] = [];
      for (let i = 0; i + 2 < last.length; i += 3) mags.push(Math.hypot(last[i] ?? 0, last[i + 1] ?? 0, last[i + 2] ?? 0));
      moving = std(mags) > 15;
    }
    return { hr: rr.length >= 3 ? 60000 / mean(rr) : null, moving };
  }
}
