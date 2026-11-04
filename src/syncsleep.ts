// Synchronised sleep tracking: one sleep measured by the Polar H10 and by the Watch D2. Matches the two recordings,
// lines them up minute by minute, combines them and works out where they differ. Numbers only; the pages are in syncsleepui.ts.

import { isNap, sleepScore, type Stage } from './sleep';
import type { SleepSession } from './store';
import type { SleepReport } from './summary';

/** A night or nap from the watch, as D2 Link hands it over. Times are ms since 1970; the stages run from falling asleep to waking up. */
export interface WatchSleep {
  id: string; start: number; stages: number[]; nap: boolean; demo: boolean; watch: string; bedMs: number; wokeMs: number;
  sleepMin: number; deepMin: number; lightMin: number; remMin: number; awakeMin: number; wakeups: number | null;
  score: number | null; avgHR: number | null; avgHrv: number | null; avgSpo2: number | null; avgBreath: number | null;
}

export interface SleepPair { id: string; polar: SleepSession; watch: WatchSleep; start: number; nap: boolean }

/** One minute of sleep. 'asleep' is the watch's nap code: sleep with no stage. */
export type Minute = 'deep' | 'light' | 'rem' | 'awake' | 'asleep' | null;
export type Known = 'deep' | 'light' | 'rem' | 'awake';
const KNOWN: readonly Known[] = ['deep', 'light', 'rem', 'awake'];

/** Two recordings are one sleep when they overlap for at least half of the shorter one. */
const MIN_OVERLAP = 0.5;

export function overlapMs(aFrom: number, aTo: number, bFrom: number, bTo: number): number {
  return Math.max(0, Math.min(aTo, bTo) - Math.max(aFrom, bFrom));
}

/** Matches recordings of one user, newest first. Each is used once, with the recording it overlaps most. */
export function pairUp(polar: readonly SleepSession[], watch: readonly WatchSleep[]): SleepPair[] {
  const options: { p: SleepSession; w: WatchSleep; ms: number }[] = [];
  for (const p of polar) {
    const pEnd = p.start + p.durationS * 1000;
    for (const w of watch) {
      const ms = overlapMs(p.start, pEnd, w.bedMs, w.wokeMs);
      const shorter = Math.min(pEnd - p.start, w.wokeMs - w.bedMs);
      if (shorter > 0 && ms >= MIN_OVERLAP * shorter) options.push({ p, w, ms });
    }
  }
  const usedP = new Set<string>(), usedW = new Set<string>();
  const pairs: SleepPair[] = [];
  for (const { p, w } of options.sort((a, b) => b.ms - a.ms)) {
    if (usedP.has(p.id) || usedW.has(w.id)) continue;
    usedP.add(p.id); usedW.add(w.id);
    pairs.push({ id: `${p.id}+${w.id}`, polar: p, watch: w, start: Math.min(p.start, w.bedMs), nap: w.nap || isNap(p.start, p.durationS) });
  }
  return pairs.sort((a, b) => b.start - a.start);
}

// ---------- minute by minute ----------

const slot = (ms: number): number => Math.floor(ms / 60000);

export function watchMinute(code: number | undefined): Minute {
  return code === 3 ? 'deep' : code === 1 ? 'light' : code === 2 ? 'rem' : code === 4 ? 'awake' : code === 5 ? 'asleep' : null;
}

/** The strap's 30-second stages as one stage per clock minute (the most common; a tie takes the first). */
function strapMinutes(stages: readonly Stage[], startMs: number, epochS: number): Map<number, Minute> {
  const counts = new Map<number, Map<Known, number>>();
  stages.forEach((s, e) => {
    if (s === 'nodata') return;
    const k = slot(startMs + e * epochS * 1000);
    const c = counts.get(k) ?? new Map<Known, number>();
    c.set(s, (c.get(s) ?? 0) + 1);
    counts.set(k, c);
  });
  const out = new Map<number, Minute>();
  for (const [k, c] of counts) {
    let best: Known | null = null, n = 0;
    for (const [s, v] of c) if (v > n) { best = s; n = v; }
    out.set(k, best);
  }
  return out;
}

export interface Timeline { startMs: number; polar: Minute[]; watch: Minute[] }

/** Both recordings on one clock, one entry per minute; null where a device has nothing. */
export function lineUp(stages: readonly Stage[], polarStart: number, epochS: number, watch: { start: number; stages: readonly number[] }): Timeline {
  const strap = strapMinutes(stages, polarStart, epochS);
  const first = slot(watch.start);
  const keys = [...strap.keys()];
  const from = Math.min(first, ...keys), to = Math.max(first + watch.stages.length - 1, ...keys);
  const polar: Minute[] = [], wrist: Minute[] = [];
  for (let k = from; k <= to; k++) {
    polar.push(strap.get(k) ?? null);
    wrist.push(watchMinute(watch.stages[k - first]));
  }
  return { startMs: from * 60000, polar, watch: wrist };
}

// ---------- combining ----------

/** Shorter awake/asleep disagreements are read as sleep: a brief stir on one device isn't time awake. */
export const WAKE_RUN_MIN = 5;

/**
 * The combined sleep. Where the devices agree, that stage. Where one is awake and the other asleep: awake if it lasts
 * WAKE_RUN_MIN minutes or more. Where both are asleep: deep or REM wins over light, as light is what both fall back on;
 * deep against REM follows the strap, which has every heartbeat and the breathing.
 */
export function combine(polar: readonly Minute[], watch: readonly Minute[]): (Known | null)[] {
  const n = polar.length;
  const split = (i: number): boolean => {
    const p = polar[i] ?? null, w = watch[i] ?? null;
    return p != null && w != null && (p === 'awake') !== (w === 'awake');
  };
  const out: (Known | null)[] = [];
  for (let i = 0; i < n; i++) {
    const p = polar[i] ?? null, w = watch[i] ?? null;
    if (split(i)) {
      let from = i, to = i;
      while (from > 0 && split(from - 1)) from--;
      while (to < n - 1 && split(to + 1)) to++;
      if (to - from + 1 >= WAKE_RUN_MIN) { out.push('awake'); continue; }
      const stage = p === 'awake' ? w : p;
      out.push(stage === 'asleep' || stage == null ? 'light' : stage === 'awake' ? 'light' : stage);
      continue;
    }
    const a = p ?? w;
    const b = w ?? p;
    if (a == null || b == null) { out.push(null); continue; }
    if (a === b) { out.push(a === 'asleep' ? 'light' : a); continue; }
    if (a === 'asleep') { out.push(b === 'asleep' ? 'light' : b); continue; }
    if (b === 'asleep') { out.push(a); continue; }
    if (a === 'light') { out.push(b); continue; }
    out.push(a); // b is light, or deep against REM, where a is the strap
  }
  return out;
}

export interface CombinedFigures {
  deepMin: number; lightMin: number; remMin: number; awakeMin: number; sleepMin: number; timeInBedMin: number;
  deepPct: number; lightPct: number; remPct: number; efficiency: number; awakenings: number;
  onsetMs: number | null; wakeMs: number | null; score: number | null;
}

/** Awake spells of 2 minutes or more between sleep count as waking up, as in the strap's own analysis. */
export function figuresOf(stages: readonly (Known | null)[], startMs: number, nap: boolean): CombinedFigures {
  const count = (s: Known): number => stages.filter((x) => x === s).length;
  const asleep = (x: Known | null | undefined): boolean => x === 'deep' || x === 'light' || x === 'rem';
  const first = stages.findIndex(asleep);
  let last = -1;
  for (let i = stages.length - 1; i >= 0; i--) if (asleep(stages[i])) { last = i; break; }
  let awakenings = 0, run = 0;
  for (let i = first + 1; first >= 0 && i <= last; i++) {
    if (stages[i] === 'awake') { run++; if (run === 2) awakenings++; } else run = 0;
  }
  const deepMin = count('deep'), lightMin = count('light'), remMin = count('rem'), awakeMin = count('awake');
  const sleepMin = deepMin + lightMin + remMin;
  const timeInBedMin = stages.filter((x) => x != null).length;
  const pct = (v: number): number => (sleepMin ? (100 * v) / sleepMin : 0);
  const efficiency = timeInBedMin ? (100 * sleepMin) / timeInBedMin : 0;
  const parts = { sleepMin, efficiency, deepPct: pct(deepMin), remPct: pct(remMin), awakenings };
  return {
    ...parts, deepMin, lightMin, remMin, awakeMin, timeInBedMin, lightPct: pct(lightMin),
    onsetMs: first >= 0 ? startMs + first * 60000 : null, wakeMs: last >= 0 ? startMs + (last + 1) * 60000 : null,
    score: nap || !sleepMin ? null : sleepScore(parts),
  };
}

// ---------- comparing ----------

export interface Agreement {
  /** Minutes both devices have data for. */
  sharedMin: number;
  /** % of those minutes with the same stage (minutes the watch gives no stage for are left out). */
  stagePct: number | null;
  /** The same, chance agreement taken out: 1 = complete, 0 = no better than chance. */
  kappa: number | null;
  /** % of shared minutes on which they agree whether you were asleep. */
  sleepWakePct: number | null;
  /** Minutes by [strap stage][watch stage]. */
  matrix: Record<Known, Record<Known, number>>;
}

export function compareMinutes(polar: readonly Minute[], watch: readonly Minute[]): Agreement {
  const blank = (): Record<Known, number> => ({ deep: 0, light: 0, rem: 0, awake: 0 });
  const matrix: Record<Known, Record<Known, number>> = { deep: blank(), light: blank(), rem: blank(), awake: blank() };
  let shared = 0, sameSide = 0, staged = 0, same = 0;
  polar.forEach((p, i) => {
    const w = watch[i] ?? null;
    if (p == null || w == null) return;
    shared++;
    if ((p === 'awake') === (w === 'awake')) sameSide++;
    if (p === 'asleep' || w === 'asleep') return;
    staged++;
    matrix[p][w]++;
    if (p === w) same++;
  });
  let chance = 0;
  for (const s of KNOWN) {
    const row = KNOWN.reduce((t, x) => t + matrix[s][x], 0), col = KNOWN.reduce((t, x) => t + matrix[x][s], 0);
    chance += staged ? (row / staged) * (col / staged) : 0;
  }
  const seen = staged ? same / staged : null;
  return {
    sharedMin: shared, matrix,
    stagePct: seen == null ? null : 100 * seen,
    kappa: seen == null || chance >= 1 ? null : (seen - chance) / (1 - chance),
    sleepWakePct: shared ? (100 * sameSide) / shared : null,
  };
}

export interface SuggestionFacts {
  agreement: Agreement;
  /** The minutes each device covers, and the % of the strap's recording with usable data. */
  polarMin: number; watchMin: number; coverage: number;
  sleepDiffMin: number; onsetDiffMin: number | null; wakeDiffMin: number | null;
  deepDiffPct: number; remDiffPct: number;
  hrDiff: number | null; hrvDiff: number | null;
  nap: boolean;
}

/** What to try next, most useful first. Neither device is a reference, so these say what would make them more reliable, not which is right. */
export function suggestions(f: SuggestionFacts): string[] {
  const out: string[] = [];
  const a = f.agreement, m = a.matrix;
  const longest = Math.max(f.polarMin, f.watchMin);
  if (longest && a.sharedMin < 0.8 * longest) out.push(`The two recordings share only ${a.sharedMin} of ${longest} minutes. Start the Polar H10 recording before you lie down and stop it after you get up, so both cover the whole ${f.nap ? 'nap' : 'night'}.`);
  if (f.coverage < 95) out.push(`The strap had usable data for ${f.coverage.toFixed(0)} % of the recording. Moisten the electrodes, fit the strap snugly below the chest muscles, and keep the phone or computer within Bluetooth range.`);
  if (f.hrDiff != null && Math.abs(f.hrDiff) > 5) out.push(`Average heart rate differs by ${Math.abs(f.hrDiff).toFixed(0)} bpm. The strap reads every heartbeat electrically, so this usually points to the watch: wear it snugly, a finger’s width above the wrist bone, with the sensor on clean skin.`);
  if (f.hrvDiff != null && Math.abs(f.hrvDiff) > 15) out.push(`Average HRV differs by ${Math.abs(f.hrvDiff).toFixed(0)} ms. The watch may not calculate it the same way, or over the same periods, as the strap’s RMSSD, so compare each device with its own earlier nights rather than with the other.`);
  if (a.sleepWakePct != null && a.sleepWakePct < 85) out.push(`They disagree on whether you were asleep for ${(100 - a.sleepWakePct).toFixed(0)} % of the time. Lying still while awake often reads as sleep on a wrist. Noting when you remember being awake shows which device to trust for you.`);
  if (f.onsetDiffMin != null && Math.abs(f.onsetDiffMin) > 15) out.push(`Falling asleep differs by ${Math.abs(f.onsetDiffMin).toFixed(0)} minutes. Reading or using a phone in bed while lying still makes this harder to detect, so try to start the recording when you turn the light off.`);
  if (f.wakeDiffMin != null && Math.abs(f.wakeDiffMin) > 15) out.push(`Waking up differs by ${Math.abs(f.wakeDiffMin).toFixed(0)} minutes. Stop the strap recording soon after you wake, and don’t take the watch off until then.`);
  const remLight = m.rem.light + m.light.rem;
  if (a.sharedMin && remLight > 0.15 * a.sharedMin) out.push(`${remLight} minutes are REM on one device and light sleep on the other. This is the hardest pair to tell apart without measuring brain activity, so treat REM as a rough figure on both.`);
  if (Math.abs(f.deepDiffPct) > 10) out.push(`Deep sleep differs by ${Math.abs(f.deepDiffPct).toFixed(0)} percentage points. A single night says little: look at whether the same device reads higher night after night.`);
  if (a.kappa != null && a.kappa >= 0.6 && !out.length) out.push('The two devices agree well on this recording. Keep the same fit and routine.');
  out.push(f.nap ? 'Short naps give few minutes to compare, so a few nights say more than one nap.' : 'Repeat for at least 7 nights: a difference that keeps the same size is a device habit you can allow for, while one that changes is more likely fit or signal.');
  out.push('Both devices estimate sleep stages from the body’s signals. Only a sleep study measuring brain activity can show which is right.');
  return out;
}

// ---------- the saved combined and comparison reports ----------

export interface PolarFigures {
  sleepMin: number; deepMin: number; lightMin: number; remMin: number; awakeMin: number; deepPct: number; remPct: number; awakenings: number;
  avgHR: number; avgHrv: number; breathingRate: number; score: number; coverage: number; onsetMs: number | null; wakeMs: number | null;
}

/** What the combined and comparison reports show, worked out once and kept until one of the two recordings changes. */
export interface SavedSleepReports {
  id: string; user: number; polarId: string; watchId: string;
  polarStamp: string; watchStamp: string;
  /** When first made, when last made, and which recording changed then ('new' the first time). */
  firstAt: number; generatedAt: number; changed: 'new' | 'polar' | 'watch' | 'both';
  start: number; end: number; nap: boolean; demo: boolean; ecgId: string | null;
  timelineStart: number; polarMinutes: Minute[]; watchMinutes: Minute[]; combined: (Known | null)[];
  figures: CombinedFigures; agreement: Agreement; tips: string[]; polar: PolarFigures; watch: Omit<WatchSleep, 'stages'>;
  /** The Polar H10 and D2 reports as they were at this version, so that each version has all four reports. */
  polarCopy?: SleepCopy; watchCopy?: unknown;
  /** Every earlier version, oldest first. */
  past?: PastSleepReports[];
  savedAt?: number; // last change, ms: the newest copy wins in the cloud
  synced?: boolean; // in the account's cloud copy
}

export type PastSleepReports = Omit<SavedSleepReports, 'past'>;
export interface SleepCopy { session: SleepSession; report: SleepReport }

function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 33) + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Changes when the Polar H10 recording's results do. */
export function polarStamp(s: SleepSession): string {
  return hash(JSON.stringify([s.start, s.durationS, s.cloudOnly ?? false, s.summary]));
}

/** Changes when anything from the watch does, for example after a new download. */
export function watchStamp(w: WatchSleep): string {
  return hash(JSON.stringify(w));
}

/** Null when the saved reports are up to date, otherwise what has to be said about the new ones. */
export function whatChanged(saved: SavedSleepReports | undefined, p: SleepPair): SavedSleepReports['changed'] | null {
  if (!saved) return 'new';
  // the device with the raw recording decides whether it changed: another device's copy of it reads differently
  const polar = !p.polar.cloudOnly && saved.polarStamp !== polarStamp(p.polar) && saved.polarStamp !== polarStamp({ ...p.polar, cloudOnly: true });
  const watch = saved.watchStamp !== watchStamp(p.watch);
  return polar && watch ? 'both' : polar ? 'polar' : watch ? 'watch' : null;
}

/** Two devices can each add a version: both are kept, in time order, and the newest is the latest. */
export function mergeSleepReports(a: SavedSleepReports, b: SavedSleepReports): SavedSleepReports {
  const by = new Map<number, PastSleepReports>();
  for (const r of [a, b]) {
    const { past = [], ...last } = r;
    for (const v of [...past, last]) by.set(v.generatedAt, v);
  }
  const all = [...by.values()].sort((x, y) => x.generatedAt - y.generatedAt);
  const latest = all[all.length - 1]!;
  return { ...latest, ...(all.length > 1 ? { past: all.slice(0, -1) } : {}) };
}

/** A copy for the cloud: numbers only, so the watch's name stays on this device. */
export function forCloud(r: SavedSleepReports): SavedSleepReports {
  const clean = <T extends PastSleepReports>(v: T): T => ({ ...v, watch: { ...v.watch, watch: '' }, watchCopy: typeof v.watchCopy === 'object' && v.watchCopy !== null ? { ...v.watchCopy, watch: '' } : v.watchCopy });
  const { synced: _s, past, ...last } = r;
  return { ...clean(last), ...(past ? { past: past.map(clean) } : {}) };
}

export function parseSleepReportsRow(v: unknown): SavedSleepReports | null {
  const r = v as Partial<SavedSleepReports> | null;
  return typeof r === 'object' && r !== null && typeof r.id === 'string' && typeof r.generatedAt === 'number' && typeof r.user === 'number' ? (r as SavedSleepReports) : null;
}

export function buildReports(p: SleepPair, polar: PolarFigures, stages: readonly Stage[], epochS: number, now: number, before?: SavedSleepReports, copies?: { polar: SleepCopy; watch: unknown }): SavedSleepReports {
  const t = lineUp(stages, p.polar.start, epochS, p.watch);
  const combined = combine(t.polar, t.watch);
  const agreement = compareMinutes(t.polar, t.watch);
  const { stages: _stages, ...watch } = p.watch;
  const minutes = (x: number | null, y: number | null): number | null => (x == null || y == null ? null : (y - x) / 60000);
  const diff = (x: number, y: number | null): number | null => (y == null ? null : y - x);
  const watchPct = (v: number): number => (watch.sleepMin ? (100 * v) / watch.sleepMin : 0);
  const { past = [], ...last } = before ?? {};
  return {
    ...(before ? { past: [...past, last as PastSleepReports] } : {}),
    ...(copies ? { polarCopy: copies.polar, watchCopy: copies.watch } : {}),
    id: p.id, user: p.polar.user, polarId: p.polar.id, watchId: p.watch.id,
    polarStamp: polarStamp(p.polar), watchStamp: watchStamp(p.watch),
    firstAt: before?.firstAt ?? now, generatedAt: now, changed: whatChanged(before, p) ?? 'new',
    start: p.start, end: Math.max(p.polar.start + p.polar.durationS * 1000, p.watch.wokeMs), nap: p.nap, demo: p.polar.source === 'demo' || p.watch.demo, ecgId: p.polar.ecgId ?? null,
    timelineStart: t.startMs, polarMinutes: t.polar, watchMinutes: t.watch, combined,
    figures: figuresOf(combined, t.startMs, p.nap), agreement, polar, watch,
    tips: suggestions({
      agreement, polarMin: t.polar.filter((x) => x != null).length, watchMin: t.watch.filter((x) => x != null).length, coverage: polar.coverage,
      sleepDiffMin: watch.sleepMin - polar.sleepMin, onsetDiffMin: minutes(polar.onsetMs, watch.bedMs), wakeDiffMin: minutes(polar.wakeMs, watch.wokeMs),
      deepDiffPct: watchPct(watch.deepMin) - polar.deepPct, remDiffPct: watchPct(watch.remMin) - polar.remPct,
      hrDiff: diff(polar.avgHR, watch.avgHR), hrvDiff: diff(polar.avgHrv, watch.avgHrv), nap: p.nap,
    }),
  };
}
