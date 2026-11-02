// ECG signal processing: filtering, QRS detection (Pan–Tompkins), beat delineation and session metrics.
// All amplitudes are µV, all intervals ms unless named otherwise.

// ---------- Filters ----------

export class Biquad {
  constructor(type, f0, fs, q = Math.SQRT1_2) {
    const w = (2 * Math.PI * f0) / fs;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    let b0, b1, b2;
    if (type === 'highpass') { b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2; }
    else if (type === 'lowpass') { b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2; }
    else { b0 = 1; b1 = -2 * cos; b2 = 1; } // notch
    const a0 = 1 + alpha;
    this.b = [b0 / a0, b1 / a0, b2 / a0];
    this.a = [(-2 * cos) / a0, (1 - alpha) / a0];
    this.reset();
  }
  reset() { this.x1 = this.x2 = this.y1 = this.y2 = 0; }
  process(x) {
    const y = this.b[0] * x + this.b[1] * this.x1 + this.b[2] * this.x2 - this.a[0] * this.y1 - this.a[1] * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

function filterChain(fs, notchHz) {
  const chain = [new Biquad('highpass', 0.5, fs), new Biquad('lowpass', 40, fs)];
  if (notchHz && notchHz < fs / 2) chain.push(new Biquad('notch', notchHz, fs, 8));
  return chain;
}

/** Causal filter for the live trace. */
export class EcgFilter {
  constructor(fs, notchHz = 50) { this.chain = filterChain(fs, notchHz); this.offset = null; }
  process(x) {
    if (this.offset == null) this.offset = x; // subtract the first value so the high-pass doesn't ring from a DC step
    let y = x - this.offset;
    for (const f of this.chain) y = f.process(y);
    return y;
  }
}

/** Zero-phase (forward–backward) filtering for analysis. */
export function filtfilt(raw, fs, notchHz = 50) {
  const n = raw.length;
  const y = new Float64Array(n);
  if (!n) return y;
  const mean = raw[0];
  let chain = filterChain(fs, notchHz);
  for (let i = 0; i < n; i++) { let v = raw[i] - mean; for (const f of chain) v = f.process(v); y[i] = v; }
  chain = filterChain(fs, notchHz);
  for (let i = n - 1; i >= 0; i--) { let v = y[i]; for (const f of chain) v = f.process(v); y[i] = v; }
  return y;
}

// ---------- Small helpers ----------

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
export function median(a) {
  if (!a.length) return NaN;
  const s = Float64Array.from(a).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const std = (a) => {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};
function segMean(x, a, b) {
  a = Math.max(0, a); b = Math.min(x.length - 1, b);
  let s = 0; for (let i = a; i <= b; i++) s += x[i];
  return b >= a ? s / (b - a + 1) : 0;
}

// ---------- QRS detection ----------

/** Returns { peaks: R positions in fractional samples, polarity }. */
export function detectQRS(x, fs) {
  const n = x.length;
  const N = Math.round(0.15 * fs);
  const mwi = new Float64Array(n);
  let acc = 0;
  const sq = new Float64Array(n);
  for (let i = 4; i < n; i++) {
    const d = (2 * x[i] + x[i - 1] - x[i - 3] - 2 * x[i - 4]) / 8;
    sq[i] = d * d;
  }
  for (let i = 0; i < n; i++) {
    acc += sq[i];
    if (i >= N) acc -= sq[i - N];
    mwi[i] = acc / N;
  }

  // local maxima of the integrated signal, at least 200 ms apart
  const half = Math.round(0.2 * fs);
  const cands = [];
  for (let i = 1; i < n - 1; i++) {
    if (mwi[i] <= mwi[i - 1] || mwi[i] < mwi[i + 1]) continue;
    let isMax = true;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
      if (mwi[j] > mwi[i]) { isMax = false; break; }
    }
    if (isMax) cands.push(i);
  }
  if (!cands.length) return { peaks: [], polarity: 1 };

  const learn = Math.min(n, 2 * fs);
  let spki = 0.25 * Math.max(...mwi.subarray(0, learn));
  let npki = 0.5 * mean(Array.from(mwi.subarray(0, learn)));
  const refractory = 0.2 * fs;
  const qrs = [];
  let rrAvg = fs; // ~60 bpm start
  let lastIdx = -Infinity;
  let skipped = [];
  for (const p of cands) {
    const thr1 = npki + 0.25 * (spki - npki);
    if (mwi[p] > thr1 && p - lastIdx > refractory) {
      qrs.push(p);
      spki = 0.125 * mwi[p] + 0.875 * spki;
      if (qrs.length > 1) rrAvg = 0.875 * rrAvg + 0.125 * (p - lastIdx);
      lastIdx = p;
      skipped = [];
    } else {
      npki = 0.125 * mwi[p] + 0.875 * npki;
      skipped.push(p);
      // search back for a missed beat with half the threshold
      if (p - lastIdx > 1.66 * rrAvg && skipped.length) {
        const best = skipped.reduce((a, b) => (mwi[b] > mwi[a] ? b : a));
        if (mwi[best] > 0.5 * thr1 && best - lastIdx > refractory) {
          qrs.push(best);
          spki = 0.25 * mwi[best] + 0.75 * spki;
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
    for (let i = Math.max(0, p - N - 3); i <= Math.min(n - 1, p + 2); i++) { mx = Math.max(mx, x[i]); mn = Math.min(mn, x[i]); }
    if (Math.abs(mx) >= Math.abs(mn)) up++;
  }
  const polarity = up >= qrs.length / 2 ? 1 : -1;
  const peaks = [];
  for (const p of qrs) {
    let best = -1, bv = -Infinity;
    for (let i = Math.max(1, p - N - 3); i <= Math.min(n - 2, p + 2); i++) {
      if (polarity * x[i] > bv) { bv = polarity * x[i]; best = i; }
    }
    if (best < 1 || best > n - 2) continue;
    const y0 = x[best - 1], y1 = x[best], y2 = x[best + 1];
    const den = y0 - 2 * y1 + y2;
    const frac = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0;
    const pos = best + frac;
    if (peaks.length && pos - peaks[peaks.length - 1] < refractory) {
      if (polarity * x[best] > polarity * x[Math.round(peaks[peaks.length - 1])]) peaks[peaks.length - 1] = pos;
      continue;
    }
    peaks.push(pos);
  }
  return { peaks, polarity };
}

// ---------- Beat delineation ----------

/** Measures one beat around R (integer sample r). Returns intervals in ms, amplitudes in µV. */
export function delineate(x, r, fs, rrPrevS, rrNextS, polarity = 1) {
  const s = (t) => Math.round(t * fs);
  const n = x.length;
  if (r - s(0.25) < 1 || r + s(0.3) >= n) return null;
  const iso = segMean(x, r - s(0.1), r - s(0.065));
  const d = (i) => x[i] - x[i - 1];
  let maxSlope = 0;
  for (let i = r - s(0.06); i <= r + s(0.08); i++) maxSlope = Math.max(maxSlope, Math.abs(d(i)));
  const thr = 0.12 * maxSlope;

  // QRS onset: step past a Q wave, then back until the slope flattens
  let q = r, qv = Infinity;
  for (let i = r - s(0.05); i < r; i++) if (polarity * x[i] < qv) { qv = polarity * x[i]; q = i; }
  let on = (qv < polarity * iso ? q : r) - 1;
  const onLimit = r - s(0.12);
  while (on > onLimit && (Math.abs(d(on)) >= thr || Math.abs(d(on - 1)) >= thr)) on--;

  // QRS offset (J point): step past S, then forward until flat
  let sIdx = r, sv = Infinity;
  for (let i = r + 1; i <= r + s(0.06); i++) if (polarity * x[i] < sv) { sv = polarity * x[i]; sIdx = i; }
  let off = sIdx + 1;
  const offLimit = r + s(0.14);
  while (off < offLimit && (Math.abs(d(off)) >= thr || Math.abs(d(off + 1)) >= thr)) off++;

  const qrsMs = ((off - on) / fs) * 1000;
  const jAmp = x[off] - iso;
  const st60 = x[Math.min(n - 1, off + s(0.06))] - iso;
  const rAmp = x[r] - iso;

  // T wave: largest deflection between J+60 ms and the next beat
  const tEndLimit = r + s(Math.min(0.55, 0.7 * (rrNextS || rrPrevS || 1)));
  let tp = -1, tv = 0;
  for (let i = off + s(0.06); i <= Math.min(n - 2, tEndLimit); i++) {
    if (Math.abs(x[i] - iso) > Math.abs(tv)) { tv = x[i] - iso; tp = i; }
  }
  let qtMs = null, tEnd = null;
  if (tp > 0 && Math.abs(tv) >= 40) {
    // tangent at the steepest point of the descending limb, intersected with the isoelectric line
    const sign = Math.sign(tv);
    let steep = -1, sm = 0;
    for (let i = tp + 1; i <= Math.min(n - 1, tp + s(0.18)); i++) {
      const sl = -sign * d(i);
      if (sl > sm) { sm = sl; steep = i; }
    }
    if (steep > 0 && sm > 0) {
      const xm = (x[steep] + x[steep - 1]) / 2;
      tEnd = steep - 0.5 + (iso - xm) / d(steep);
      tEnd = Math.max(tp, Math.min(tp + s(0.25), tEnd));
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
    iso,
  };
}

// ---------- Full analysis ----------

const TEMPLATE_PRE = 0.25;
const TEMPLATE_POST = 0.5;

function beatWindow(x, r, fs) {
  const a = r - Math.round(TEMPLATE_PRE * fs);
  const b = r + Math.round(TEMPLATE_POST * fs);
  if (a < 0 || b >= x.length) return null;
  return x.subarray(a, b + 1);
}

function corr(a, b) {
  const ma = mean(a), mb = mean(b);
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i++) {
    const u = a[i] - ma, v = b[i] - mb;
    sab += u * v; saa += u * u; sbb += v * v;
  }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}

export const EVENT_LABELS = {
  premature: 'Premature beat',
  pause: 'Pause',
  shape: 'Irregular shape',
  user: 'Marked',
};

/**
 * Analyse a recording.
 * @param raw  Int16Array/Int32Array/Float array of µV samples
 * @param opts { fs, notch, qtcFormula: 'bazett'|'fridericia' }
 * @returns { beats, events, template, polarity, x }
 */
export function analyze(raw, opts = {}) {
  const fs = opts.fs || 130;
  const x = filtfilt(raw, fs, opts.notch ?? 50);
  const { peaks, polarity } = detectQRS(x, fs);
  const beats = peaks.map((p, k) => ({
    t: p / fs,
    r: Math.round(p),
    rr: k > 0 ? ((p - peaks[k - 1]) / fs) * 1000 : null,
    flags: [],
  }));

  // RR-based classification against a local median
  for (let k = 1; k < beats.length; k++) {
    const ctx = [];
    for (let j = Math.max(1, k - 6); j <= Math.min(beats.length - 1, k + 6); j++) if (j !== k && j !== k + 1) ctx.push(beats[j].rr);
    const med = median(ctx);
    beats[k].localMedian = med;
    const rr = beats[k].rr;
    if (rr < 0.8 * med) beats[k].flags.push('premature');
    else if (rr > 1.6 * med || rr > 2000) beats[k].flags.push('pause');
  }

  // median beat template from RR-normal beats, then morphology check
  const normal = beats.filter((b) => b.rr && !b.flags.length);
  const pick = normal.filter((_, i) => i % Math.max(1, Math.floor(normal.length / 300)) === 0);
  const wins = pick.map((b) => beatWindow(x, b.r, fs)).filter(Boolean);
  let template = null;
  if (wins.length >= 3) {
    template = new Float64Array(wins[0].length);
    for (let i = 0; i < template.length; i++) template[i] = median(wins.map((w) => w[i]));
    const qrsHalf = Math.round(0.08 * fs);
    const c = Math.round(TEMPLATE_PRE * fs);
    const tq = template.subarray(c - qrsHalf, c + qrsHalf + 1);
    for (const b of beats) {
      const w = beatWindow(x, b.r, fs);
      if (!w) continue;
      b.corr = corr(w.subarray(c - qrsHalf, c + qrsHalf + 1), tq);
      if (b.corr < 0.7 && !b.flags.includes('shape')) b.flags.push('shape');
    }
  }

  // per-beat measurements
  const qtc = opts.qtcFormula === 'fridericia' ? (qt, rr) => qt / Math.cbrt(rr) : (qt, rr) => qt / Math.sqrt(rr);
  for (let k = 0; k < beats.length; k++) {
    const b = beats[k];
    const rrPrevS = b.rr ? b.rr / 1000 : null;
    const rrNextS = beats[k + 1]?.rr ? beats[k + 1].rr / 1000 : null;
    b.m = delineate(x, b.r, fs, rrPrevS, rrNextS, polarity);
    if (b.m?.qt && rrPrevS && !b.flags.length) b.m.qtc = qtc(b.m.qt, rrPrevS);
  }

  const events = [];
  for (const b of beats) for (const f of b.flags) events.push({ t: b.t, type: f });
  // a premature beat usually also fails the shape test; report it once
  const dedup = events.filter((e, i) => !(e.type === 'shape' && events[i - 1]?.t === e.t));

  let templateMeasure = null;
  if (template) {
    const c = Math.round(TEMPLATE_PRE * fs);
    const rr = median(normal.map((b) => b.rr)) / 1000;
    const padded = new Float64Array(template.length + 2 * fs);
    padded.set(template, fs);
    templateMeasure = delineate(padded, c + fs, fs, rr, rr, polarity);
    if (templateMeasure) {
      for (const key of ['onset', 'offset', 'tPeak', 'tEnd']) if (templateMeasure[key] != null) templateMeasure[key] -= fs;
      if (templateMeasure.qt) templateMeasure.qtc = qtc(templateMeasure.qt, rr);
    }
  }

  return { fs, x, beats, events: dedup, template, templateMeasure, polarity, templatePre: TEMPLATE_PRE };
}

// ---------- Metrics ----------

function nnIntervals(beats) {
  const nn = [];
  for (let k = 1; k < beats.length; k++) {
    const b = beats[k], p = beats[k - 1];
    if (b.flags.length || p.flags.length || !b.rr) continue;
    if (b.rr < 300 || b.rr > 2000) continue;
    if (b.localMedian && Math.abs(b.rr - b.localMedian) > 0.2 * b.localMedian) continue;
    nn.push({ t: b.t, rr: b.rr, prev: k });
  }
  return nn;
}

export function hrvStats(beats) {
  const nn = nnIntervals(beats);
  const rr = nn.map((v) => v.rr);
  const diffs = [];
  for (let i = 1; i < nn.length; i++) if (nn[i].prev === nn[i - 1].prev + 1) diffs.push(nn[i].rr - nn[i - 1].rr);
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
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const ar = re[i + k + len / 2], ai = im[i + k + len / 2];
        const tr = ar * wr - ai * wi, ti = ar * wi + ai * wr;
        re[i + k + len / 2] = re[i + k] - tr; im[i + k + len / 2] = im[i + k] - ti;
        re[i + k] += tr; im[i + k] += ti;
      }
    }
  }
}

/** Share (%) of 0.5–40 Hz signal energy that falls in 2–8 Hz. */
export function bandEnergyShare(x, fs, lo = 2, hi = 8) {
  const N = 512;
  if (x.length < N) return NaN;
  const step = Math.max(N / 2, Math.floor((x.length - N) / 200));
  const hann = Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  let band = 0, total = 0;
  for (let s = 0; s + N <= x.length; s += step) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[s + i] * hann[i];
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      const f = (k * fs) / N;
      const p = re[k] * re[k] + im[k] * im[k];
      if (f >= 0.5 && f <= 40) total += p;
      if (f >= lo && f <= hi) band += p;
    }
  }
  return total ? (100 * band) / total : NaN;
}

/** Heart rate sampled once per second (5 s trailing mean of RR), null where no beats. */
export function hrSeries(beats, durationS) {
  const out = [];
  let k = 0;
  const win = [];
  for (let t = 1; t <= Math.floor(durationS); t++) {
    while (k < beats.length && beats[k].t <= t) {
      if (beats[k].rr && beats[k].rr > 250 && beats[k].rr < 2500 && !beats[k].flags.includes('shape')) win.push(beats[k]);
      k++;
    }
    while (win.length && win[0].t < t - 5) win.shift();
    out.push(win.length ? 60000 / mean(win.map((b) => b.rr)) : null);
  }
  return out;
}

export function trainingStats(hr, profile) {
  const { hrRest, hrMax, sex } = profile;
  const k = sex === 'female' ? 1.67 : 1.92;
  let trimp = 0;
  const zones = [0, 0, 0, 0, 0, 0]; // below Z1, Z1..Z5 seconds
  for (const v of hr) {
    if (v == null) continue;
    const frac = Math.max(0, Math.min(1, (v - hrRest) / (hrMax - hrRest)));
    trimp += (1 / 60) * frac * 0.64 * Math.exp(k * frac);
    const pct = v / hrMax;
    zones[pct < 0.5 ? 0 : Math.min(5, Math.floor((pct - 0.5) / 0.1) + 1)]++;
  }

  // recovery: ≥60 s at ≥90 % HRmax, then the drop over the following 60 s
  let best = null;
  let runStart = -1;
  const thr = 0.9 * hrMax;
  for (let i = 0; i <= hr.length; i++) {
    const above = i < hr.length && hr[i] != null && hr[i] >= thr;
    if (above && runStart < 0) runStart = i;
    if (!above && runStart >= 0) {
      const end = i - 1;
      if (end - runStart + 1 >= 60 && end + 60 < hr.length && hr[end + 60] != null) {
        const peak = Math.max(...hr.slice(runStart, end + 1).filter((v) => v != null));
        const drop = peak - hr[end + 60];
        if (!best || drop > best.hrr60) best = { hrr60: drop, peak, after60: hr[end + 60], t: end };
      }
      runStart = -1;
    }
  }
  return { trimp, zones, recovery: best };
}

/** Everything the report needs. */
export function sessionMetrics(analysis, durationS, profile) {
  const { beats, fs, x } = analysis;
  const clean = beats.filter((b) => !b.flags.length && b.m);
  const pick = (f) => clean.map(f).filter((v) => v != null && Number.isFinite(v));
  const tVals = pick((b) => b.m.tAmp);
  const hr = hrSeries(beats, durationS);
  return {
    durationS,
    beatCount: beats.length,
    ...hrvStats(beats),
    qrs: median(pick((b) => b.m.qrs)),
    qtc: median(pick((b) => b.m.qtc)),
    qt: median(pick((b) => b.m.qt)),
    tPositive: tVals.length ? (100 * tVals.filter((v) => v > 0).length) / tVals.length : NaN,
    jPoint: median(pick((b) => b.m.jAmp)),
    st60: median(pick((b) => b.m.st60)),
    rAmp: median(pick((b) => b.m.rAmp)),
    hf: bandEnergyShare(x, fs),
    eventCount: analysis.events.length,
    eventPct: beats.length ? (100 * beats.filter((b) => b.flags.length).length) / beats.length : 0,
    hr,
    ...trainingStats(hr, profile),
  };
}
