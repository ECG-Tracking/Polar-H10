// ECG signal processing: filtering, QRS detection (Pan–Tompkins), beat delineation and session metrics.
// All amplitudes are µV, all intervals ms unless named otherwise.

/** Any indexable run of samples (typed arrays, plain arrays). */
export type Samples = ArrayLike<number>;

/** Sample i, or 0 outside the array. Callers keep indices in range; this only satisfies the type checker. */
const at = (a: Samples, i: number): number => a[i] ?? 0;

// ---------- Filters ----------

type BiquadType = 'highpass' | 'lowpass' | 'notch';

export class Biquad {
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(type: BiquadType, f0: number, fs: number, q = Math.SQRT1_2) {
    const w = (2 * Math.PI * f0) / fs;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    let b0: number, b1: number, b2: number;
    if (type === 'highpass') { b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2; }
    else if (type === 'lowpass') { b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2; }
    else { b0 = 1; b1 = -2 * cos; b2 = 1; }
    const a0 = 1 + alpha;
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = (-2 * cos) / a0; this.a2 = (1 - alpha) / a0;
  }

  reset(): void { this.x1 = this.x2 = this.y1 = this.y2 = 0; }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

function filterChain(fs: number, notchHz: number): Biquad[] {
  const chain = [new Biquad('highpass', 0.5, fs), new Biquad('lowpass', 40, fs)];
  if (notchHz && notchHz < fs / 2) chain.push(new Biquad('notch', notchHz, fs, 8));
  return chain;
}

/** Causal filter for the live trace. */
export class EcgFilter {
  private readonly chain: Biquad[];
  private offset: number | null = null;

  constructor(fs: number, notchHz = 50) { this.chain = filterChain(fs, notchHz); }

  process(x: number): number {
    this.offset ??= x; // subtract the first value so the high-pass doesn't ring from a DC step
    let y = x - this.offset;
    for (const f of this.chain) y = f.process(y);
    return y;
  }
}

/** Zero-phase (forward–backward) filtering for analysis. */
export function filtfilt(raw: Samples, fs: number, notchHz = 50): Float64Array {
  const n = raw.length;
  const y = new Float64Array(n);
  if (!n) return y;
  const mean0 = at(raw, 0);
  let chain = filterChain(fs, notchHz);
  for (let i = 0; i < n; i++) { let v = at(raw, i) - mean0; for (const f of chain) v = f.process(v); y[i] = v; }
  chain = filterChain(fs, notchHz);
  for (let i = n - 1; i >= 0; i--) { let v = at(y, i); for (const f of chain) v = f.process(v); y[i] = v; }
  return y;
}

// ---------- Small helpers ----------

const mean = (a: readonly number[]): number => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

export function median(a: readonly number[]): number {
  if (!a.length) return NaN;
  const s = Float64Array.from(a).sort();
  const m = s.length >> 1;
  return s.length % 2 ? at(s, m) : (at(s, m - 1) + at(s, m)) / 2;
}

const std = (a: readonly number[]): number => {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};

function segMean(x: Samples, from: number, to: number): number {
  const a = Math.max(0, from), b = Math.min(x.length - 1, to);
  let s = 0;
  for (let i = a; i <= b; i++) s += at(x, i);
  return b >= a ? s / (b - a + 1) : 0;
}

const finite = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

// ---------- QRS detection ----------

export type Polarity = 1 | -1;

export interface QrsDetection {
  peaks: number[]; // R positions in fractional samples
  polarity: Polarity; // 1 = QRS points up
}

export function detectQRS(x: Float64Array, fs: number): QrsDetection {
  const n = x.length;
  const N = Math.round(0.15 * fs);
  const mwi = new Float64Array(n);
  const sq = new Float64Array(n);
  for (let i = 4; i < n; i++) {
    const d = (2 * at(x, i) + at(x, i - 1) - at(x, i - 3) - 2 * at(x, i - 4)) / 8;
    sq[i] = d * d;
  }
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += at(sq, i);
    if (i >= N) acc -= at(sq, i - N);
    mwi[i] = acc / N;
  }

  // local maxima of the integrated signal, at least 200 ms apart
  const half = Math.round(0.2 * fs);
  const cands: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    const v = at(mwi, i);
    if (v <= at(mwi, i - 1) || v < at(mwi, i + 1)) continue;
    let isMax = true;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
      if (at(mwi, j) > v) { isMax = false; break; }
    }
    if (isMax) cands.push(i);
  }
  if (!cands.length) return { peaks: [], polarity: 1 };

  const learnWin = mwi.subarray(0, Math.min(n, 2 * fs));
  // a spike at the start (a finger meeting the watch's button, the strap settling) mustn't set the threshold: it is
  // capped at a few times a typical tall peak of the first 10 s
  const early = cands.filter((i) => i < 10 * fs).map((i) => at(mwi, i)).sort((a, b) => a - b);
  const typical = early[Math.floor(early.length * 0.7)] ?? Infinity;
  const cap = 4 * typical;
  let spki = 0.25 * Math.min(cap, learnWin.reduce((m, v) => Math.max(m, v), 0));
  let npki = 0.5 * mean(Array.from(learnWin, (v) => Math.min(v, cap)));
  const refractory = 0.2 * fs;
  const qrs: number[] = [];
  let rrAvg = fs; // ~60 bpm start
  let lastIdx = -Infinity;
  let skipped: number[] = [];
  for (const p of cands) {
    // no beat for 3 s: the threshold was set too high by a spike (at the start, or the strap knocked later on), so it
    // comes down until beats are found again; otherwise one spike would hide every beat after it
    if (p - Math.max(lastIdx, 0) > 3 * fs) { spki *= 0.5; npki *= 0.5; }
    const thr1 = npki + 0.25 * (spki - npki);
    const v = at(mwi, p);
    if (v > thr1 && p - lastIdx > refractory) {
      qrs.push(p);
      spki = 0.125 * v + 0.875 * spki;
      if (qrs.length > 1) rrAvg = 0.875 * rrAvg + 0.125 * (p - lastIdx);
      lastIdx = p;
      skipped = [];
    } else {
      npki = 0.125 * v + 0.875 * npki;
      skipped.push(p);
      // search back for a missed beat with half the threshold
      if (p - lastIdx > 1.66 * rrAvg) {
        const best = skipped.reduce((a, b) => (at(mwi, b) > at(mwi, a) ? b : a));
        if (at(mwi, best) > 0.5 * thr1 && best - lastIdx > refractory) {
          qrs.push(best);
          spki = 0.25 * at(mwi, best) + 0.75 * spki;
          lastIdx = best;
          skipped = skipped.filter((s) => s > best);
        }
      }
    }
  }

  // locate R in the filtered ECG; the integrator lags the QRS by up to its window length
  let up = 0;
  for (const p of qrs) {
    let mx = -Infinity, mn = Infinity;
    for (let i = Math.max(0, p - N - 3); i <= Math.min(n - 1, p + 2); i++) { mx = Math.max(mx, at(x, i)); mn = Math.min(mn, at(x, i)); }
    if (Math.abs(mx) >= Math.abs(mn)) up++;
  }
  const polarity: Polarity = up >= qrs.length / 2 ? 1 : -1;
  const peaks: number[] = [];
  for (const p of qrs) {
    let best = -1, bv = -Infinity;
    for (let i = Math.max(1, p - N - 3); i <= Math.min(n - 2, p + 2); i++) {
      if (polarity * at(x, i) > bv) { bv = polarity * at(x, i); best = i; }
    }
    if (best < 1 || best > n - 2) continue;
    const y0 = at(x, best - 1), y1 = at(x, best), y2 = at(x, best + 1);
    const den = y0 - 2 * y1 + y2;
    const frac = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0;
    const pos = best + frac;
    const last = peaks[peaks.length - 1];
    if (last !== undefined && pos - last < refractory) {
      if (polarity * at(x, best) > polarity * at(x, Math.round(last))) peaks[peaks.length - 1] = pos;
      continue;
    }
    peaks.push(pos);
  }
  return { peaks, polarity };
}

// ---------- Beat delineation ----------

export interface BeatMeasure {
  onset: number; // sample index of QRS onset
  offset: number; // sample index of the J point
  tPeak: number; // -1 when no T wave was found
  tEnd: number | null;
  qrs: number | null; // ms
  qt: number | null; // ms
  qtc?: number; // ms
  tAmp: number | null; // µV
  jAmp: number;
  st60: number;
  rAmp: number; // the tallest upward wave of the QRS, 0 if there is none
  sAmp: number; // how far the deepest downward wave of the QRS goes below the baseline, as a positive size; 0 if there is none
  iso: number;
}

/** Measures one beat around R (integer sample r). Returns intervals in ms, amplitudes in µV. */
export function delineate(x: Samples, r: number, fs: number, rrPrevS: number | null, rrNextS: number | null, polarity: Polarity = 1): BeatMeasure | null {
  const s = (t: number): number => Math.round(t * fs);
  const n = x.length;
  if (r - s(0.25) < 1 || r + s(0.3) >= n) return null;
  const iso = segMean(x, r - s(0.1), r - s(0.065));
  const d = (i: number): number => at(x, i) - at(x, i - 1);
  let maxSlope = 0;
  for (let i = r - s(0.06); i <= r + s(0.08); i++) maxSlope = Math.max(maxSlope, Math.abs(d(i)));
  const thr = 0.12 * maxSlope;

  // QRS onset: step past a Q wave, then back until the slope flattens
  let q = r, qv = Infinity;
  for (let i = r - s(0.05); i < r; i++) if (polarity * at(x, i) < qv) { qv = polarity * at(x, i); q = i; }
  let on = (qv < polarity * iso ? q : r) - 1;
  const onLimit = r - s(0.12);
  while (on > onLimit && (Math.abs(d(on)) >= thr || Math.abs(d(on - 1)) >= thr)) on--;

  // QRS offset (J point): step past a real S wave, then forward until flat. Past the main wave the trace may simply
  // run on into the ST segment, which is no wave to step over, so S must turn back and reach 10 % of the main wave.
  const height = (i: number): number => polarity * (at(x, i) - iso);
  let sIdx = r;
  for (let i = r + 1; i <= r + s(0.06); i++) {
    if (height(i) < -0.1 * height(r) && height(i) <= height(i - 1) && height(i) < height(i + 1)) { sIdx = i; break; }
  }
  let off = sIdx + 1;
  const offLimit = r + s(0.14);
  while (off < offLimit && (Math.abs(d(off)) >= thr || Math.abs(d(off + 1)) >= thr)) off++;

  const qrsMs = ((off - on) / fs) * 1000;
  const jAmp = at(x, off) - iso;
  const st60 = at(x, Math.min(n - 1, off + s(0.06))) - iso;
  let rAmp = 0, sAmp = 0;
  for (let i = on; i <= off; i++) { rAmp = Math.max(rAmp, at(x, i) - iso); sAmp = Math.max(sAmp, iso - at(x, i)); }

  // T wave: largest deflection between J+60 ms and the next beat
  const tEndLimit = r + s(Math.min(0.55, 0.7 * (rrNextS || rrPrevS || 1)));
  let tp = -1, tv = 0;
  for (let i = off + s(0.06); i <= Math.min(n - 2, tEndLimit); i++) {
    if (Math.abs(at(x, i) - iso) > Math.abs(tv)) { tv = at(x, i) - iso; tp = i; }
  }
  let qtMs: number | null = null, tEnd: number | null = null;
  if (tp > 0 && Math.abs(tv) >= 40) {
    // tangent at the steepest point of the descending limb, intersected with the isoelectric line
    const sign = Math.sign(tv);
    let steep = -1, sm = 0;
    for (let i = tp + 1; i <= Math.min(n - 1, tp + s(0.18)); i++) {
      const sl = -sign * d(i);
      if (sl > sm) { sm = sl; steep = i; }
    }
    if (steep > 0 && sm > 0) {
      const xm = (at(x, steep) + at(x, steep - 1)) / 2;
      const crossing = steep - 0.5 + (iso - xm) / d(steep);
      tEnd = Math.max(tp, Math.min(tp + s(0.25), crossing));
      qtMs = ((tEnd - on) / fs) * 1000;
    }
  }

  const valid = qrsMs >= 40 && qrsMs <= 200;
  return {
    onset: on,
    offset: off,
    tPeak: tp,
    tEnd,
    qrs: valid ? qrsMs : null,
    qt: qtMs && qtMs >= 220 && qtMs <= 650 ? qtMs : null,
    tAmp: tp > 0 ? tv : null,
    jAmp,
    st60,
    rAmp,
    sAmp,
    iso,
  };
}

// ---------- Full analysis ----------

const TEMPLATE_PRE = 0.25;
const TEMPLATE_POST = 0.5;

function beatWindow(x: Float64Array, r: number, fs: number): Float64Array | null {
  const a = r - Math.round(TEMPLATE_PRE * fs);
  const b = r + Math.round(TEMPLATE_POST * fs);
  if (a < 0 || b >= x.length) return null;
  return x.subarray(a, b + 1);
}

function corr(a: Float64Array, b: Float64Array): number {
  const ma = mean(Array.from(a)), mb = mean(Array.from(b));
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i++) {
    const u = at(a, i) - ma, v = at(b, i) - mb;
    sab += u * v; saa += u * u; sbb += v * v;
  }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}

/** 'artifact': most likely a connection error (lost signal, a flat line, clipping or a spike), so never an event. */
export type BeatFlag = 'premature' | 'pause' | 'shape' | 'artifact';
export type EventType = BeatFlag | 'user';

export const EVENT_LABELS: Readonly<Record<EventType, string>> = {
  premature: 'Premature beat',
  pause: 'Pause',
  shape: 'Irregular shape',
  artifact: 'Connection error',
  user: 'Marked',
};

export interface Beat {
  t: number; // s
  r: number; // sample index of the R peak
  rr: number | null; // ms since the previous beat
  flags: BeatFlag[];
  localMedian?: number;
  corr?: number;
  m: BeatMeasure | null;
}

export interface DetectedEvent { t: number; type: BeatFlag }

export interface Analysis {
  fs: number;
  x: Float64Array; // filtered signal
  beats: Beat[];
  events: DetectedEvent[];
  /** Beats that would have been events but were most likely connection errors (not in `events`). */
  artifacts: number;
  template: Float64Array | null; // median beat, TEMPLATE_PRE s before R to TEMPLATE_POST s after
  templateMeasure: BeatMeasure | null; // sample indices relative to the template
  polarity: Polarity;
  templatePre: number;
}

export interface AnalyzeOptions {
  fs?: number;
  notch?: number;
  qtcFormula?: 'bazett' | 'fridericia';
  /** Don't flag beats for their shape alone: they count as ordinary beats in every figure and aren't events. */
  ignoreShape?: boolean;
}

/**
 * Whether raw samples `from`–`to` show a connection problem rather than the heart: a flat line (no signal; lost packets
 * are kept as zeros), clipping at the limits of a saved recording, or a spike far larger than any heartbeat.
 */
export function looksLikeConnectionError(raw: Samples, x: ArrayLike<number>, from: number, to: number, fs: number, rAmp: number): boolean {
  const flatRun = Math.round(0.2 * fs); // real ECG never stays exactly level this long
  let same = 0, clipped = 0, peak = 0;
  for (let i = Math.max(1, from); i <= Math.min(raw.length - 1, to); i++) {
    const v = raw[i] ?? 0;
    same = v === raw[i - 1] ? same + 1 : 0;
    if (same >= flatRun) return true;
    clipped = v >= 32767 || v <= -32768 ? clipped + 1 : 0;
    if (clipped >= 3) return true;
    peak = Math.max(peak, Math.abs(x[i] ?? 0));
  }
  return rAmp > 0 && peak > 5 * rAmp;
}

/**
 * A burst at the very start or end (up to 3 s, over 8 times the size of the rest: a finger meeting the watch's button,
 * the strap settling) is replaced by a flat line, which counts as no signal: left as it is, it would set the beat
 * detection's sensitivity and hide every real heartbeat.
 */
export function quietSettling(raw: Samples, fs: number): Samples {
  const secs = Math.floor(raw.length / fs);
  if (secs < 6) return raw;
  const ranges: number[] = [];
  for (let s = 0; s < secs; s++) {
    let lo = Infinity, hi = -Infinity;
    for (let i = s * fs; i < (s + 1) * fs; i++) { const v = raw[i] ?? 0; if (v < lo) lo = v; if (v > hi) hi = v; }
    ranges.push(hi - lo);
  }
  const med = median(ranges);
  if (!(med > 0)) return raw;
  let a = 0, b = secs;
  while (a < 3 && (ranges[a] ?? 0) > 8 * med) a++;
  while (b > secs - 3 && (ranges[b - 1] ?? 0) > 8 * med) b--;
  if (a === 0 && b === secs) return raw;
  const out = Float64Array.from({ length: raw.length }, (_, i) => raw[i] ?? 0);
  const start = a * fs, end = b === secs ? raw.length : b * fs;
  out.fill(out[start] ?? 0, 0, start);
  out.fill(out[end - 1] ?? 0, end);
  return out;
}

/** Analyse a recording of µV samples. */
export function analyze(input: Samples, opts: AnalyzeOptions = {}): Analysis {
  const fs = opts.fs || 130;
  const raw = quietSettling(input, fs);
  const x = filtfilt(raw, fs, opts.notch ?? 50);
  const { peaks, polarity } = detectQRS(x, fs);
  const beats: Beat[] = peaks.map((p, k) => {
    const prev = peaks[k - 1];
    return { t: p / fs, r: Math.round(p), rr: prev !== undefined ? ((p - prev) / fs) * 1000 : null, flags: [], m: null };
  });

  // RR-based classification against a local median
  for (let k = 1; k < beats.length; k++) {
    const beat = beats[k];
    if (!beat || beat.rr == null) continue;
    const ctx: number[] = [];
    for (let j = Math.max(1, k - 6); j <= Math.min(beats.length - 1, k + 6); j++) {
      const rr = beats[j]?.rr;
      if (j !== k && j !== k + 1 && rr != null) ctx.push(rr);
    }
    const med = median(ctx);
    beat.localMedian = med;
    if (beat.rr < 0.8 * med) beat.flags.push('premature');
    else if (beat.rr > 1.6 * med || beat.rr > 2000) beat.flags.push('pause');
  }

  // median beat template from RR-normal beats, then morphology check
  const normal = beats.filter((b) => b.rr && !b.flags.length);
  const stride = Math.max(1, Math.floor(normal.length / 300));
  const wins = normal
    .filter((_, i) => i % stride === 0)
    .map((b) => beatWindow(x, b.r, fs))
    .filter((w): w is Float64Array => w !== null);
  let template: Float64Array | null = null;
  const first = wins[0];
  if (first && wins.length >= 3) {
    const tpl = new Float64Array(first.length);
    for (let i = 0; i < tpl.length; i++) tpl[i] = median(wins.map((w) => at(w, i)));
    template = tpl;
    const qrsHalf = Math.round(0.08 * fs);
    const c = Math.round(TEMPLATE_PRE * fs);
    const tq = tpl.subarray(c - qrsHalf, c + qrsHalf + 1);
    for (const b of beats) {
      const w = beatWindow(x, b.r, fs);
      if (!w) continue;
      b.corr = corr(w.subarray(c - qrsHalf, c + qrsHalf + 1), tq);
      if (b.corr < 0.7 && !opts.ignoreShape && !b.flags.includes('shape')) b.flags.push('shape');
    }
  }

  // a flagged beat next to lost signal, a flat line, clipping or a spike is most likely a connection error, not an event
  const rAmp = median(beats.filter((b) => !b.flags.length).map((b) => Math.abs(at(x, b.r))).filter(finite));
  let artifacts = 0;
  beats.forEach((b, k) => {
    if (!b.flags.length) return;
    const from = beats[k - 1]?.r ?? Math.max(0, b.r - Math.round(1.5 * fs));
    const to = beats[k + 1]?.r ?? Math.min(raw.length - 1, b.r + Math.round(1.5 * fs));
    if (looksLikeConnectionError(raw, x, from, to, fs, rAmp)) { b.flags = ['artifact']; artifacts++; }
  });

  // per-beat measurements
  const qtc = opts.qtcFormula === 'fridericia'
    ? (qt: number, rr: number): number => qt / Math.cbrt(rr)
    : (qt: number, rr: number): number => qt / Math.sqrt(rr);
  beats.forEach((b, k) => {
    const rrPrevS = b.rr ? b.rr / 1000 : null;
    const nextRR = beats[k + 1]?.rr;
    const rrNextS = nextRR ? nextRR / 1000 : null;
    const m = delineate(x, b.r, fs, rrPrevS, rrNextS, polarity);
    if (m?.qt && rrPrevS && !b.flags.length) m.qtc = qtc(m.qt, rrPrevS);
    b.m = m;
  });

  const events: DetectedEvent[] = [];
  for (const b of beats) for (const f of b.flags) if (f !== 'artifact') events.push({ t: b.t, type: f });
  // a premature beat usually also fails the shape test; report it once
  const dedup = events.filter((e, i) => !(e.type === 'shape' && events[i - 1]?.t === e.t));

  let templateMeasure: BeatMeasure | null = null;
  if (template) {
    const c = Math.round(TEMPLATE_PRE * fs);
    const rr = median(normal.map((b) => b.rr).filter(finite)) / 1000;
    const padded = new Float64Array(template.length + 2 * fs);
    padded.set(template, fs);
    const tm = delineate(padded, c + fs, fs, rr, rr, polarity);
    if (tm) {
      tm.onset -= fs;
      tm.offset -= fs;
      tm.tPeak -= fs;
      if (tm.tEnd != null) tm.tEnd -= fs;
      if (tm.qt) tm.qtc = qtc(tm.qt, rr);
    }
    templateMeasure = tm;
  }

  return { fs, x, beats, events: dedup, artifacts, template, templateMeasure, polarity, templatePre: TEMPLATE_PRE };
}

// ---------- Metrics ----------

interface NN { t: number; rr: number; prev: number }

function nnIntervals(beats: readonly Beat[]): NN[] {
  const nn: NN[] = [];
  for (let k = 1; k < beats.length; k++) {
    const b = beats[k], p = beats[k - 1];
    if (!b || !p || b.flags.length || p.flags.length || b.rr == null) continue;
    if (b.rr < 300 || b.rr > 2000) continue;
    if (b.localMedian && Math.abs(b.rr - b.localMedian) > 0.2 * b.localMedian) continue;
    nn.push({ t: b.t, rr: b.rr, prev: k });
  }
  return nn;
}

export interface HrvStats {
  nnCount: number;
  meanRR: number;
  meanHR: number;
  rmssd: number;
  hrvScore: number;
  sdnn: number;
  sd1: number;
  sd2: number;
  pnn50: number;
  pnn200: number;
}

export function hrvStats(beats: readonly Beat[]): HrvStats {
  const nn = nnIntervals(beats);
  const rr = nn.map((v) => v.rr);
  const diffs: number[] = [];
  for (let i = 1; i < nn.length; i++) {
    const a = nn[i - 1], b = nn[i];
    if (a && b && b.prev === a.prev + 1) diffs.push(b.rr - a.rr);
  }
  const rmssd = diffs.length ? Math.sqrt(mean(diffs.map((d) => d * d))) : NaN;
  const sdnn = std(rr);
  const sd1 = diffs.length > 1 ? Math.sqrt(0.5) * std(diffs) : NaN;
  const sd2 = Math.sqrt(Math.max(0, 2 * sdnn * sdnn - sd1 * sd1));
  return {
    nnCount: rr.length,
    meanRR: mean(rr),
    meanHR: rr.length ? 60000 / mean(rr) : NaN,
    rmssd,
    hrvScore: rmssd > 0 ? 15 * Math.log(rmssd) : NaN,
    sdnn,
    sd1,
    sd2,
    pnn50: diffs.length ? (100 * diffs.filter((d) => Math.abs(d) > 50).length) / diffs.length : NaN,
    pnn200: diffs.length ? (100 * diffs.filter((d) => Math.abs(d) > 200).length) / diffs.length : NaN,
  };
}

// radix-2 in-place FFT
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = at(re, i); re[i] = at(re, j); re[j] = tr;
      const ti = at(im, i); im[i] = at(im, j); im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const h = len / 2;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < h; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const ar = at(re, i + k + h), ai = at(im, i + k + h);
        const tr = ar * wr - ai * wi, ti = ar * wi + ai * wr;
        re[i + k + h] = at(re, i + k) - tr; im[i + k + h] = at(im, i + k) - ti;
        re[i + k] = at(re, i + k) + tr; im[i + k] = at(im, i + k) + ti;
      }
    }
  }
}

/** Share (%) of 0.5–40 Hz signal energy that falls in 2–8 Hz. */
export function bandEnergyShare(x: Samples, fs: number, lo = 2, hi = 8): number {
  const N = 512;
  if (x.length < N) return NaN;
  const step = Math.max(N / 2, Math.floor((x.length - N) / 200));
  const hann = Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  let band = 0, total = 0;
  for (let s = 0; s + N <= x.length; s += step) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = at(x, s + i) * at(hann, i);
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      const f = (k * fs) / N;
      const p = at(re, k) ** 2 + at(im, k) ** 2;
      if (f >= 0.5 && f <= 40) total += p;
      if (f >= lo && f <= hi) band += p;
    }
  }
  return total ? (100 * band) / total : NaN;
}

/** Heart rate sampled once per second (5 s trailing mean of RR), null where no beats. */
export function hrSeries(beats: readonly Beat[], durationS: number): (number | null)[] {
  const out: (number | null)[] = [];
  let k = 0;
  const win: { t: number; rr: number }[] = [];
  for (let t = 1; t <= Math.floor(durationS); t++) {
    for (let b = beats[k]; b && b.t <= t; b = beats[++k]) {
      if (b.rr && b.rr > 250 && b.rr < 2500 && !b.flags.includes('shape')) win.push({ t: b.t, rr: b.rr });
    }
    while ((win[0]?.t ?? Infinity) < t - 5) win.shift();
    out.push(win.length ? 60000 / mean(win.map((b) => b.rr)) : null);
  }
  return out;
}

export interface TrainingProfile { hrRest: number; hrMax: number; sex: 'male' | 'female' }

export interface Recovery { hrr60: number; peak: number; after60: number; t: number }

export interface TrainingStats {
  trimp: number;
  zones: [number, number, number, number, number, number]; // seconds below Z1, Z1..Z5
  recovery: Recovery | null;
}

export function trainingStats(hr: readonly (number | null)[], profile: TrainingProfile): TrainingStats {
  const { hrRest, hrMax, sex } = profile;
  const k = sex === 'female' ? 1.67 : 1.92;
  let trimp = 0;
  const zones: TrainingStats['zones'] = [0, 0, 0, 0, 0, 0];
  for (const v of hr) {
    if (v == null) continue;
    const frac = Math.max(0, Math.min(1, (v - hrRest) / (hrMax - hrRest)));
    trimp += (1 / 60) * frac * 0.64 * Math.exp(k * frac);
    const pct = v / hrMax;
    const zone = pct < 0.5 ? 0 : Math.min(5, Math.floor((pct - 0.5) / 0.1) + 1);
    zones[zone as 0 | 1 | 2 | 3 | 4 | 5]++;
  }

  // recovery: ≥60 s at ≥90 % HRmax, then the drop over the following 60 s
  let best: Recovery | null = null;
  let runStart = -1;
  const thr = 0.9 * hrMax;
  for (let i = 0; i <= hr.length; i++) {
    const v = hr[i];
    const above = v != null && v >= thr;
    if (above && runStart < 0) runStart = i;
    if (!above && runStart >= 0) {
      const end = i - 1;
      const after60 = hr[end + 60];
      if (end - runStart + 1 >= 60 && after60 != null) {
        const peak = Math.max(...hr.slice(runStart, end + 1).filter(finite));
        const drop = peak - after60;
        if (!best || drop > best.hrr60) best = { hrr60: drop, peak, after60, t: end };
      }
      runStart = -1;
    }
  }
  return { trimp, zones, recovery: best };
}

export interface SessionMetrics extends HrvStats, TrainingStats {
  durationS: number;
  beatCount: number;
  qrs: number;
  qtc: number;
  qt: number;
  tPositive: number;
  tAmp: number; // µV, median T-wave peak vs the PR baseline (negative = T points down)
  trRatio: number; // median of |T| / R wave per beat
  jPoint: number;
  st60: number;
  rAmp: number; // µV, the tallest upward wave of the QRS
  sAmp: number; // µV, positive size of the deepest downward wave of the QRS
  hf: number;
  eventCount: number;
  eventPct: number;
  hr: (number | null)[];
}

/** Everything the report needs. */
export function sessionMetrics(analysis: Analysis, durationS: number, profile: TrainingProfile): SessionMetrics {
  const { beats, fs, x } = analysis;
  const clean = beats.flatMap((b) => (!b.flags.length && b.m ? [b.m] : []));
  const pick = (f: (m: BeatMeasure) => number | null | undefined): number[] => clean.map(f).filter(finite);
  const tVals = pick((m) => m.tAmp);
  const hr = hrSeries(beats, durationS);
  // timing comes from the median beat when it can be measured: noise moves each beat's markers, not the median beat's
  const tm = analysis.templateMeasure;
  return {
    durationS,
    beatCount: beats.length,
    ...hrvStats(beats),
    qrs: tm?.qrs ?? median(pick((m) => m.qrs)),
    qtc: tm?.qtc ?? median(pick((m) => m.qtc)),
    qt: tm?.qt ?? median(pick((m) => m.qt)),
    tPositive: tVals.length ? (100 * tVals.filter((v) => v > 0).length) / tVals.length : NaN,
    tAmp: median(tVals),
    trRatio: median(clean.flatMap((m) => (m.tAmp != null && m.rAmp > 0 ? [Math.abs(m.tAmp) / m.rAmp] : []))),
    jPoint: median(pick((m) => m.jAmp)),
    st60: median(pick((m) => m.st60)),
    rAmp: median(pick((m) => m.rAmp)),
    sAmp: median(pick((m) => m.sAmp)),
    hf: bandEnergyShare(x, fs),
    eventCount: analysis.events.length,
    eventPct: beats.length ? (100 * beats.filter((b) => b.flags.some((f) => f !== 'artifact')).length) / beats.length : 0, // a likely connection error isn't an event
    hr,
    ...trainingStats(hr, profile),
  };
}
