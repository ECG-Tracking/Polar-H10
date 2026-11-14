// The numbers of a synchronised ECG tracking: what each device's beats give, how the two agree, and the two put together.

import { mergeRetirement, shown } from './versions';
import type { SessionMetrics } from './dsp';
import type { TrackingWatchData } from './d2/backup';
import type { SyncBp, SyncTrackingEntry } from './store';

// ---------- beat intervals ----------

/**
 * Beat intervals that can be used: 30–200 bpm, and not more than 20% away from the previous one kept (extra or missed
 * beats would otherwise inflate RMSSD and SDNN – the usual artefact rule for HRV).
 */
export function usable(rr: readonly number[]): number[] {
  const out: number[] = [];
  for (const x of rr) {
    if (x < 300 || x > 2000) continue;
    const prev = out[out.length - 1];
    if (prev != null && Math.abs(x - prev) > 0.2 * prev) continue;
    out.push(x);
  }
  return out;
}

export function rmssd(rr: readonly number[]): number | null {
  const r = usable(rr);
  if (r.length < 3) return null;
  let s = 0;
  for (let i = 1; i < r.length; i++) s += (r[i]! - r[i - 1]!) ** 2;
  return Math.sqrt(s / (r.length - 1));
}

export function sdnn(rr: readonly number[]): number | null {
  const r = usable(rr);
  if (r.length < 3) return null;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
}

/** Heart rate from the last few intervals (bpm). */
export function hrFrom(rr: readonly number[], last = 5): number | null {
  const r = usable(rr).slice(-last);
  return r.length ? 60000 / (r.reduce((a, b) => a + b, 0) / r.length) : null;
}

const mean = (xs: readonly number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// ---------- one device's figures ----------

/** [seconds from the start, interval in ms] */
export type TimedBeat = readonly [number, number];
/** [seconds from the start, heart rate] */
export type HrPoint = readonly [number, number];

/** One tracking's beats, saved with it. Trackings from before v1.22.0 have none. */
export interface SyncTrace {
  id: string;
  polar: TimedBeat[];
  watch: TimedBeat[];
  polarHr: HrPoint[];
  watchHr: HrPoint[];
  watchPoor: number; // beats the watch marked as unusable
  /** Every version of the tracking's reports, oldest first. */
  reports?: TrackVersion[];
  /** Versions (by generatedAt) moved to the Recovery centre, and ones restored from it: see versions.ts. */
  retired?: number[]; kept?: number[];
  /** The Combined ECG's results, saved so other pages (BP and ECG) can use them without lining the ECGs up again. */
  combined?: CombinedResult;
}

/**
 * What a tracking's Combined ECG shows, worked out once: each device's figures from the same heartbeats (a beat either
 * flagged left out of both), and the events both saw at the same heartbeat with each device's % of beats. `stamp` says
 * which ECGs it came from and `method` how it was worked out; either changing means working it out again. polar and
 * watch are null when the strips and the strap's ECG couldn't be put together.
 */
export interface CombinedResult {
  method: number; stamp: string; at: number;
  polar: Record<string, number> | null; watch: Record<string, number> | null;
  events: { polar: number; watch: number; polarPct: number; watchPct: number } | null;
}

/** Two copies of a tracking's beats and reports: every version of both, less the ones either retired. */
export function mergeTrace(here: SyncTrace | undefined | null, there: SyncTrace): SyncTrace {
  const r = mergeRetirement(here ?? undefined, there);
  const { retired: _r, kept: _k, ...rest } = there;
  // the newer saved Combined ECG results, from either device
  const combined = [here?.combined, there.combined].filter((c): c is CombinedResult => c != null).sort((a, b) => b.at - a.at)[0];
  return { ...rest, ...r, reports: shown(mergeVersions(here?.reports, there.reports), r), ...(combined ? { combined } : {}) };
}

/** What the reports show, as it was when generated. A new version is added when blood pressure or the watch's data changes. */
export interface TrackVersion {
  generatedAt: number;
  changed: 'new' | 'bp' | 'watch' | 'both';
  bpStamp: string; watchStamp: string;
  bps: SyncBp[];
  stored: TrackingWatchData | null;
  ecg: Omit<SessionMetrics, 'hr'> | null;
  p: BeatFigures | null; w: BeatFigures | null; c: BeatFigures | null;
  fromWatch: number; // beats the watch added to the combined list
  combinedBeats: number;
  agreement: HrAgreement | null;
}

export interface BeatFigures {
  beats: number; // usable
  rawBeats: number;
  leftOutPct: number;
  meanRR: number; minRR: number; maxRR: number;
  meanHr: number; minHr: number; maxHr: number; hrRange: number;
  rmssd: number | null;
  hrvScore: number | null; // 15 × ln(RMSSD), as on the ECG report
  avgHrv: number | null; minHrv: number | null; maxHrv: number | null; // RMSSD of each minute
  sdnn: number | null;
  cvnn: number | null; // SDNN as % of the mean interval
  pnn50: number | null; pnn20: number | null;
  sd1: number | null; sd2: number | null; sd1sd2: number | null;
  lf: number | null; hf: number | null; lfHf: number | null;
}

const MIN_BANDS_S = 120;

/** Low and high frequency power of the interval series (ms²), from 2 minutes up, as fast as the recording allows. */
export function hrvBands(rr: readonly number[]): { lf: number; hf: number } | null {
  const r = usable(rr);
  const total = r.reduce((a, b) => a + b, 0) / 1000;
  if (total < MIN_BANDS_S) return null;
  const fs = 4, n = Math.floor(total * fs);
  const m = mean(r) ?? 0;
  const x = new Float64Array(n);
  let t = r[0]! / 1000, k = 1;
  for (let i = 0; i < n; i++) { // evenly spaced samples, joined up with straight lines
    const at = i / fs + r[0]! / 1000;
    while (k < r.length - 1 && t + r[k]! / 1000 < at) { t += r[k]! / 1000; k++; }
    const next = t + r[k]! / 1000;
    const f = Math.min(1, Math.max(0, (at - t) / (next - t)));
    x[i] = r[k - 1]! + f * (r[k]! - r[k - 1]!) - m;
  }
  let w2 = 0;
  for (let i = 0; i < n; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); x[i] = x[i]! * w; w2 += w * w; }
  const step = 0.005;
  let lf = 0, hf = 0;
  for (let f = 0.04; f < 0.4; f += step) {
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) { const a = (2 * Math.PI * f * i) / fs; re += x[i]! * Math.cos(a); im -= x[i]! * Math.sin(a); }
    const p = ((re * re + im * im) * 2) / (fs * w2) * step;
    if (f < 0.15) lf += p; else hf += p;
  }
  return { lf, hf };
}

function perMinute(beats: readonly TimedBeat[]): number[] {
  const groups = new Map<number, number[]>();
  for (const [t, rr] of beats) { const m = Math.floor(t / 60); groups.set(m, [...(groups.get(m) ?? []), rr]); }
  return [...groups.values()].flatMap((rr) => { const v = rr.length >= 10 ? rmssd(rr) : null; return v == null ? [] : [v]; });
}

export function beatFigures(beats: readonly TimedBeat[]): BeatFigures | null {
  const all = beats.map((b) => b[1]);
  const r = usable(all);
  if (r.length < 3) return null;
  const meanRR = mean(r)!;
  const hrs = r.map((x) => 60000 / x);
  const diffs = r.slice(1).map((x, i) => Math.abs(x - r[i]!));
  const rm = rmssd(r), sd = sdnn(r);
  const sd1 = rm == null ? null : rm / Math.SQRT2;
  const sd2 = sd == null || sd1 == null ? null : Math.sqrt(Math.max(0, 2 * sd * sd - sd1 * sd1));
  const minutes = perMinute(beats);
  const bands = hrvBands(r);
  return {
    beats: r.length, rawBeats: all.length, leftOutPct: (100 * (all.length - r.length)) / all.length,
    meanRR, minRR: Math.min(...r), maxRR: Math.max(...r),
    meanHr: 60000 / meanRR, minHr: Math.min(...hrs), maxHr: Math.max(...hrs), hrRange: Math.max(...hrs) - Math.min(...hrs),
    rmssd: rm, hrvScore: rm && rm > 0 ? 15 * Math.log(rm) : null,
    avgHrv: mean(minutes), minHrv: minutes.length ? Math.min(...minutes) : null, maxHrv: minutes.length ? Math.max(...minutes) : null,
    sdnn: sd, cvnn: sd == null ? null : (100 * sd) / meanRR,
    pnn50: (100 * diffs.filter((d) => d > 50).length) / diffs.length, pnn20: (100 * diffs.filter((d) => d > 20).length) / diffs.length,
    sd1, sd2, sd1sd2: sd1 != null && sd2 ? sd1 / sd2 : null,
    lf: bands?.lf ?? null, hf: bands?.hf ?? null, lfHf: bands && bands.hf > 0 ? bands.lf / bands.hf : null,
  };
}

// ---------- the two together ----------

export interface HrAgreement {
  bins: number; // 5-second stretches where both devices had a reading
  bias: number; // watch minus Polar
  low: number; high: number; // limits of agreement: 95 % of the differences are expected between these
  mae: number; // average size of the difference
  within5Pct: number;
  r: number | null; // correlation
}

const BIN_S = 5;

function bins(series: readonly HrPoint[]): Map<number, number> {
  const g = new Map<number, number[]>();
  for (const [t, hr] of series) { const b = Math.floor(t / BIN_S); g.set(b, [...(g.get(b) ?? []), hr]); }
  return new Map([...g].map(([b, v]) => [b, mean(v)!]));
}

export function hrAgreement(polar: readonly HrPoint[], watch: readonly HrPoint[]): HrAgreement | null {
  const a = bins(polar), b = bins(watch);
  const pairs = [...a].flatMap(([k, v]): [number, number][] => { const w = b.get(k); return w == null ? [] : [[v, w]]; });
  if (pairs.length < 2) return null;
  const d = pairs.map(([p, w]) => w - p);
  const bias = mean(d)!;
  const sd = Math.sqrt(d.reduce((s, x) => s + (x - bias) ** 2, 0) / (d.length - 1));
  const mp = mean(pairs.map((x) => x[0]))!, mw = mean(pairs.map((x) => x[1]))!;
  const sxy = pairs.reduce((s, [p, w]) => s + (p - mp) * (w - mw), 0);
  const sxx = pairs.reduce((s, [p]) => s + (p - mp) ** 2, 0), syy = pairs.reduce((s, [, w]) => s + (w - mw) ** 2, 0);
  return {
    bins: pairs.length, bias, low: bias - 1.96 * sd, high: bias + 1.96 * sd,
    mae: mean(d.map(Math.abs))!, within5Pct: (100 * d.filter((x) => Math.abs(x) <= 5).length) / d.length,
    r: sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null,
  };
}

const GAP_S = 2.5;

/**
 * The best beat list from both: the chest strap's beats stand, because it measures the heart's electrical signal; where
 * it has a gap of over 2.5 s, the watch's beats from that gap fill in.
 */
export function combineBeats(polar: readonly TimedBeat[], watch: readonly TimedBeat[]): { beats: TimedBeat[]; fromWatch: number } {
  if (!polar.length) return { beats: [...watch], fromWatch: watch.length };
  const edges = [0, ...polar.map((b) => b[0]), Math.max(polar[polar.length - 1]![0], watch[watch.length - 1]?.[0] ?? 0)];
  const fill = watch.filter(([t]) => {
    for (let i = 1; i < edges.length; i++) if (t >= edges[i - 1]! && t < edges[i]!) return edges[i]! - edges[i - 1]! > GAP_S;
    return t >= edges[edges.length - 1]!;
  });
  return { beats: [...polar, ...fill].sort((a, b) => a[0] - b[0]), fromWatch: fill.length };
}

/** Each second, the average of what the two devices read, or the one that read anything. */
export function combineHr(polar: readonly HrPoint[], watch: readonly HrPoint[]): HrPoint[] {
  const at = new Map<number, number[]>();
  for (const [t, hr] of [...polar, ...watch]) { const s = Math.round(t); at.set(s, [...(at.get(s) ?? []), hr]); }
  return [...at].sort((a, b) => a[0] - b[0]).map(([s, v]) => [s, mean(v)!]);
}

// ---------- versions ----------

const stampOf = (v: unknown): string => {
  const s = JSON.stringify(v) ?? '';
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `${s.length}-${h.toString(36)}`;
};

/** What has changed since `prev`, or null if nothing has. */
export function whatChanged(prev: TrackVersion | undefined, bps: readonly SyncBp[], stored: TrackingWatchData | null): TrackVersion['changed'] | null {
  if (!prev) return 'new';
  const bp = prev.bpStamp !== stampOf(bps), watch = prev.watchStamp !== stampOf(stored);
  return bp && watch ? 'both' : bp ? 'bp' : watch ? 'watch' : null;
}

export function makeVersion(t: SyncTrace, bps: readonly SyncBp[], stored: TrackingWatchData | null, ecg: TrackVersion['ecg'], changed: TrackVersion['changed'], now: number): TrackVersion {
  const { beats, fromWatch } = combineBeats(t.polar, t.watch);
  return {
    generatedAt: now, changed, bpStamp: stampOf(bps), watchStamp: stampOf(stored), bps: [...bps], stored, ecg,
    p: beatFigures(t.polar), w: beatFigures(t.watch), c: beatFigures(beats), fromWatch, combinedBeats: beats.length,
    agreement: hrAgreement(t.polarHr, t.watchHr),
  };
}

// ---------- the cloud copy ----------

export interface CloudPlan { upload: string[]; download: string[]; removeHere: string[]; markSynced: string[] }

/** One cloud row per item: the most recently saved copy wins; one that left the cloud was deleted on another device. */
export function planCloudCopies(local: readonly { id: string; savedAt?: number; synced?: boolean }[], cloud: ReadonlyMap<string, number>, deleting: ReadonlySet<string>, tooOld: (id: string) => boolean = () => false): CloudPlan {
  const plan: CloudPlan = { upload: [], download: [], removeHere: [], markSynced: [] };
  const here = new Set(local.map((e) => e.id));
  for (const e of local) {
    const at = cloud.get(e.id);
    if (at == null) (e.synced ? plan.removeHere : plan.upload).push(e.id);
    else if ((e.savedAt ?? 0) > at) plan.upload.push(e.id);
    else if ((e.savedAt ?? 0) < at) plan.download.push(e.id);
    else if (!e.synced) plan.markSynced.push(e.id);
  }
  for (const id of cloud.keys()) if (!here.has(id) && !deleting.has(id) && !tooOld(id)) plan.download.push(id);
  return plan;
}

/** Two devices can each add a version: both are kept, in time order. */
export function mergeVersions(a: readonly TrackVersion[] = [], b: readonly TrackVersion[] = []): TrackVersion[] {
  const by = new Map<number, TrackVersion>();
  for (const v of [...a, ...b]) by.set(v.generatedAt, v);
  return [...by.values()].sort((x, y) => x.generatedAt - y.generatedAt);
}

/** A cloud row back in the app's terms; anything else is ignored. */
export function parseTrackingRow(v: unknown): { entry: SyncTrackingEntry; trace: SyncTrace | null } | null {
  if (typeof v !== 'object' || v === null) return null;
  const { entry, trace } = v as { entry?: SyncTrackingEntry; trace?: SyncTrace | null };
  if (typeof entry?.id !== 'string' || typeof entry.start !== 'number') return null;
  const okTrace = trace != null && trace.id === entry.id && Array.isArray(trace.polar) && Array.isArray(trace.watch);
  return { entry, trace: okTrace ? trace : null };
}

// ---------- the comparison table ----------

export type Summary = { hr: number | null; rmssd: number | null; sdnn: number | null; beats: number };
export interface CompareRow { name: string; polar: number | null; watch: number | null; digits: number }

/** Every figure both can give. An old tracking has only its saved summary, so most rows are empty for it. */
export function compareRows(p: BeatFigures | null, w: BeatFigures | null, ps: Summary | null, ws: Summary | null): CompareRow[] {
  const row = (name: string, f: (x: BeatFigures) => number | null, digits = 0, old?: (s: Summary) => number | null): CompareRow => ({
    name, digits,
    polar: p ? f(p) : ps && old ? old(ps) : null,
    watch: w ? f(w) : ws && old ? old(ws) : null,
  });
  return [
    row('Average heart rate (bpm)', (x) => x.meanHr, 1, (s) => s.hr),
    row('Lowest heart rate (bpm)', (x) => x.minHr),
    row('Highest heart rate (bpm)', (x) => x.maxHr),
    row('Heart rate range (bpm)', (x) => x.hrRange),
    row('Average beat interval (ms)', (x) => x.meanRR),
    row('Shortest beat interval (ms)', (x) => x.minRR),
    row('Longest beat interval (ms)', (x) => x.maxRR),
    row('RMSSD, whole tracking (ms)', (x) => x.rmssd, 1, (s) => s.rmssd),
    row('Average HRV, RMSSD per minute (ms)', (x) => x.avgHrv, 1),
    row('Lowest HRV in a minute (ms)', (x) => x.minHrv, 1),
    row('Highest HRV in a minute (ms)', (x) => x.maxHrv, 1),
    row('HRV score', (x) => x.hrvScore),
    row('SDNN (ms)', (x) => x.sdnn, 1, (s) => s.sdnn),
    row('CVNN (%)', (x) => x.cvnn, 1),
    row('pNN50 (%)', (x) => x.pnn50, 1),
    row('pNN20 (%)', (x) => x.pnn20, 1),
    row('Poincaré SD1 (ms)', (x) => x.sd1, 1),
    row('Poincaré SD2 (ms)', (x) => x.sd2, 1),
    row('SD1 / SD2', (x) => x.sd1sd2, 2),
    row('LF power (ms²)', (x) => x.lf),
    row('HF power (ms²)', (x) => x.hf),
    row('LF / HF', (x) => x.lfHf, 2),
    row('Beats used', (x) => x.beats, 0, (s) => s.beats),
    row('Beats received', (x) => x.rawBeats),
    row('Beats left out (%)', (x) => x.leftOutPct, 1),
  ];
}

/** Rule-based: says what differs and what might help, never which device is right about the person. */
export function trackingSuggestions(p: BeatFigures | null, w: BeatFigures | null, a: HrAgreement | null, durationS: number, watchPoor: number, hasBp: boolean): string[] {
  const out: string[] = [];
  if (!p || !w) out.push('Both devices need beats from the same tracking for a full comparison. Connect both before you start.');
  if (a && Math.abs(a.bias) >= 3) out.push(`The watch read ${Math.abs(a.bias).toFixed(1)} bpm ${a.bias > 0 ? 'higher' : 'lower'} on average. Wear it snugly, a finger’s width above the wrist bone.`);
  if (a && a.high - a.low > 10) out.push('The two heart rates moved apart at times. Keep the arm still and resting at heart level, because the watch reads light through the skin and movement disturbs it.');
  if (p?.rmssd && w?.rmssd && Math.abs(w.rmssd - p.rmssd) / p.rmssd > 0.2) out.push('The HRV figures differ by over 20 %. A wrist sensor reads the pulse slightly after the heartbeat, and its timing varies more than an ECG’s, so treat the strap’s HRV as the reference.');
  if (p && w && w.rawBeats < 0.8 * p.rawBeats) out.push('The watch caught far fewer beats than the strap. Its heartbeat test restarts about every minute, and poor contact also loses beats.');
  if (w && watchPoor > 0.1 * (w.rawBeats + watchPoor)) out.push('The watch marked many beats as unusable. Clean the sensor and tighten the strap.');
  if (p && p.leftOutPct > 5) out.push('Many strap beats were left out as irregular. These can be real extra beats, or poor contact: moisten the strap’s electrodes and check the ECG.');
  if (durationS < 300) out.push('HRV is usually measured over 5 minutes. Shorter trackings give less reliable HRV, and LF and HF need at least 2 minutes.');
  if (!hasBp) out.push('No blood pressure reading was found near this tracking. Take one on the watch within the hour.');
  if (!out.length) out.push('The two devices agree well in this tracking.');
  return out;
}
