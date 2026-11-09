// Synchronised sleep tracking: one sleep measured by the Polar H10 and by the Watch D2. Matches the two recordings,
// lines them up minute by minute, combines them and works out where they differ. Numbers only; the pages are in syncsleepui.ts.

import { SLEEP_METHOD, isNap, sleepScore, type Stage } from './sleep';
import { mergeRetirement, shown } from './versions';
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
/** A minute of the combined sleep; 'asleep' when neither device names a stage. */
export type Combined = Known | 'asleep' | null;
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
    pairs.push({ id: `${p.id}+${w.id}`, polar: p, watch: w, start: Math.min(p.start, w.bedMs), nap: p.context ? p.context === 'nap' : w.nap || isNap(p.start, p.durationS) });
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
  const counts = new Map<number, Map<Exclude<Minute, null>, number>>();
  stages.forEach((s, e) => {
    if (s === 'nodata') return;
    const k = slot(startMs + e * epochS * 1000);
    const c = counts.get(k) ?? new Map<Exclude<Minute, null>, number>();
    const stage = s === 'uncertain' ? 'asleep' : s; // known to be asleep, with no stage
    c.set(stage, (c.get(stage) ?? 0) + 1);
    counts.set(k, c);
  });
  const out = new Map<number, Minute>();
  for (const [k, c] of counts) {
    let best: Minute = null, n = 0;
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
/**
 * 3 (v1.42.0): short breaks inside a block are joined to it (tidyBlocks) and times woke up are counted from the combined
 * stages; 2 (v1.36.0): the strap's stage stands and the watch fills its gaps; 1: the deeper of the two stages.
 */
export const COMBINE_RULE = 3;

/** The longest break (minutes) that is joined to the block around it. */
export const SHORT_BREAK_MIN = 2;

/**
 * A 1–2 minute block (missing minutes included) between two parts of one block, each at least 2 minutes long, is part of
 * that block: a brief flicker isn't a stage change, and a minute or two without data isn't a gap in the night.
 */
export function tidyBlocks(stages: readonly Combined[]): Combined[] {
  const out = [...stages];
  for (let pass = 0; pass < 10; pass++) {
    const r = runs(out);
    let changed = false;
    for (let k = 1; k + 1 < r.length; k++) {
      const before = r[k - 1]!, mid = r[k]!, after = r[k + 1]!;
      if (mid.to - mid.from > SHORT_BREAK_MIN || before.value == null || before.value !== after.value) continue;
      if (before.to - before.from < SHORT_BREAK_MIN || after.to - after.from < SHORT_BREAK_MIN) continue;
      for (let i = mid.from; i < mid.to; i++) out[i] = before.value;
      changed = true;
      k++; // the next block has changed length: look again on the next pass
    }
    if (!changed) break;
  }
  return out;
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

export function combine(polar: readonly Minute[], watch: readonly Minute[]): Combined[] {
  const n = polar.length;
  const split = (i: number): boolean => {
    const p = polar[i] ?? null, w = watch[i] ?? null;
    return p != null && w != null && (p === 'awake') !== (w === 'awake');
  };
  const out: Combined[] = [];
  for (let i = 0; i < n; i++) {
    const p = polar[i] ?? null, w = watch[i] ?? null;
    if (split(i)) {
      let from = i, to = i;
      while (from > 0 && split(from - 1)) from--;
      while (to < n - 1 && split(to + 1)) to++;
      if (to - from + 1 >= WAKE_RUN_MIN) { out.push('awake'); continue; }
      const stage = p === 'awake' ? w : p;
      out.push(stage == null || stage === 'awake' ? 'light' : stage);
      continue;
    }
    // the strap decides the stage; the watch only fills the minutes the strap has no reading or no stage for
    const a = p ?? w;
    const b = w ?? p;
    if (a == null || b == null) { out.push(null); continue; }
    out.push(a === 'asleep' ? b : a); // asleep with no stage stays that way when neither device supplied one
  }
  return out;
}

export interface CombinedFigures {
  deepMin: number; lightMin: number; remMin: number; awakeMin: number; sleepMin: number; timeInBedMin: number;
  deepPct: number; lightPct: number; remPct: number; efficiency: number; awakenings: number;
  onsetMs: number | null; wakeMs: number | null; score: number | null;
}

/**
 * Awake spells of 2 minutes or more between falling asleep and the last sleep count as waking up, as in the strap's own
 * analysis: being awake before falling asleep isn't waking up.
 */
export function figuresOf(stages: readonly Combined[], startMs: number, nap: boolean, wakes?: number): CombinedFigures {
  const count = (s: Exclude<Combined, null>): number => stages.filter((x) => x === s).length;
  const asleep = (x: Combined | undefined): boolean => x === 'deep' || x === 'light' || x === 'rem' || x === 'asleep';
  const first = stages.findIndex(asleep);
  let last = -1;
  for (let i = stages.length - 1; i >= 0; i--) if (asleep(stages[i])) { last = i; break; }
  let awakenings = 0, run = 0;
  for (let i = first + 1; first >= 0 && i <= last; i++) {
    if (stages[i] === 'awake') { run++; if (run === 2) awakenings++; } else run = 0;
  }
  const deepMin = count('deep'), lightMin = count('light'), remMin = count('rem'), awakeMin = count('awake');
  const sleepMin = deepMin + lightMin + remMin + count('asleep');
  const timeInBedMin = stages.filter((x) => x != null).length;
  const pct = (v: number): number => (sleepMin ? (100 * v) / sleepMin : 0);
  const efficiency = timeInBedMin ? (100 * sleepMin) / timeInBedMin : 0;
  const parts = { sleepMin, efficiency, deepPct: pct(deepMin), remPct: pct(remMin), awakenings: wakes ?? awakenings };
  return {
    ...parts, deepMin, lightMin, remMin, awakeMin, timeInBedMin, lightPct: pct(lightMin),
    onsetMs: first >= 0 ? startMs + first * 60000 : null, wakeMs: last >= 0 ? startMs + (last + 1) * 60000 : null,
    score: nap || !sleepMin ? null : sleepScore(parts),
  };
}

/**
 * Times woke up halfway between the two devices: used before combine rule 3, which counts the combined stages instead
 * (the watch's own count includes being awake before falling asleep).
 */
export const midWakes = (polar: number, watch: number | null): number => (watch == null ? polar : Math.round((polar + watch) / 2));

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
  /** % of 5-minute blocks in which both have the same main stage: less strict than minute by minute. */
  fiveMinPct?: number | null;
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
    fiveMinPct: blockAgreement(polar, watch),
  };
}

/** The most common stage in a block; null if too little of it is known. */
function mainStage(block: readonly Minute[]): Known | null {
  const counts = new Map<Known, number>();
  for (const x of block) if (x && x !== 'asleep') counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: Known | null = null, most = 0, known = 0;
  for (const [k, c] of counts) { known += c; if (c > most) { best = k; most = c; } }
  return known >= 3 ? best : null;
}

const BLOCK_MIN = 5;

function blockAgreement(polar: readonly Minute[], watch: readonly Minute[]): number | null {
  let same = 0, blocks = 0;
  for (let i = 0; i + BLOCK_MIN <= polar.length; i += BLOCK_MIN) {
    const p = mainStage(polar.slice(i, i + BLOCK_MIN)), w = mainStage(watch.slice(i, i + BLOCK_MIN));
    if (!p || !w) continue;
    blocks++;
    if (p === w) same++;
  }
  return blocks ? (100 * same) / blocks : null;
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
  firstAt: number; generatedAt: number; changed: 'new' | 'polar' | 'watch' | 'both' | 'method' | 'labels' | 'combine';
  /** The strap's stages it was made from (see stagesStamp): another device's new report can change them and nothing else. */
  stagesStamp?: string;
  /** What the person said about this sleep when it was made (see labelsOf); missing = nothing said. */
  labels?: string;
  /** How the strap's stages were worked out (see SLEEP_METHOD); missing = before v1.29.0. */
  method?: number;
  /** How the two devices' stages were combined (see COMBINE_RULE); missing = 1, before v1.36.0. */
  combineRule?: number;
  start: number; end: number; nap: boolean; demo: boolean; ecgId: string | null;
  timelineStart: number; polarMinutes: Minute[]; watchMinutes: Minute[]; combined: Combined[];
  figures: CombinedFigures; agreement: Agreement; tips: string[]; polar: PolarFigures; watch: Omit<WatchSleep, 'stages'>;
  /** The Polar H10 and D2 reports as they were at this version, so that each version has all four reports. */
  polarCopy?: SleepCopy; watchCopy?: unknown;
  /** Every earlier version, oldest first. */
  past?: PastSleepReports[];
  /** Versions (by generatedAt) moved to the Recovery centre, and ones restored from it: see versions.ts. */
  retired?: number[]; kept?: number[];
  savedAt?: number; // last change, ms: the newest copy wins in the cloud
  synced?: boolean; // in the account's cloud copy
}

export type PastSleepReports = Omit<SavedSleepReports, 'past' | 'retired' | 'kept'>;
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

/** One letter per 30 s, the same whether worked out here or read from a cloud copy. */
export const stagesStamp = (stages: readonly Stage[]): string => hash(stages.map((s) => s[0]).join(''));

/** The stages in a cloud copy; null if it has none, as a recording with its raw data here doesn't. */
const copyStamp = (s: SleepSession): string | null => {
  const stages = (s.report as { stages?: unknown } | undefined)?.stages;
  return typeof stages === 'string' ? hash(stages) : null;
};

/** Night or nap, and a late start: changing either changes the reports. */
export const labelsOf = (s: Pick<SleepSession, 'context' | 'onsetUnknown'>): string => `${s.context ?? ''}|${s.onsetUnknown ? 1 : 0}`;

/** Null when the saved reports are up to date, otherwise what has to be said about the new ones. */
export function whatChanged(saved: SavedSleepReports | undefined, p: SleepPair): SavedSleepReports['changed'] | null {
  if (!saved) return 'new';
  if (!p.polar.cloudOnly && (saved.method ?? 1) < SLEEP_METHOD) return 'method'; // only the device with the raw recording can redo it
  if ((saved.combineRule ?? 1) < COMBINE_RULE) return 'combine';
  if ((saved.labels ?? labelsOf({})) !== labelsOf(p.polar)) return 'labels';
  // the device with the raw recording decides whether it changed: another device's copy of it reads differently
  const copy = p.polar.cloudOnly ? copyStamp(p.polar) : null;
  const polar = p.polar.cloudOnly
    ? copy != null && copy !== saved.stagesStamp // that device sent new stages
    : saved.polarStamp !== polarStamp(p.polar) && saved.polarStamp !== polarStamp({ ...p.polar, cloudOnly: true });
  const watch = saved.watchStamp !== watchStamp(p.watch);
  return polar && watch ? 'both' : polar ? 'polar' : watch ? 'watch' : null;
}

/** Two devices can each add a version: both are kept, in time order, and the newest is the latest. */
export function mergeSleepReports(a: SavedSleepReports, b: SavedSleepReports): SavedSleepReports {
  const by = new Map<number, PastSleepReports>();
  for (const r of [a, b]) {
    const { past = [], retired: _r, kept: _k, ...last } = r;
    for (const v of [...past, last]) by.set(v.generatedAt, v);
  }
  const retirement = mergeRetirement(a, b);
  const all = shown([...by.values()].sort((x, y) => x.generatedAt - y.generatedAt), retirement);
  const latest = all[all.length - 1]!;
  return { ...latest, ...(all.length > 1 ? { past: all.slice(0, -1) } : {}), ...retirement };
}

/** A copy for the cloud, without this device's own note of being synced. */
export function forCloud(r: SavedSleepReports): SavedSleepReports {
  const { synced: _s, ...sent } = r;
  return sent;
}

export function parseSleepReportsRow(v: unknown): SavedSleepReports | null {
  const r = v as Partial<SavedSleepReports> | null;
  return typeof r === 'object' && r !== null && typeof r.id === 'string' && typeof r.generatedAt === 'number' && typeof r.user === 'number' ? (r as SavedSleepReports) : null;
}

export function buildReports(p: SleepPair, polar: PolarFigures, stages: readonly Stage[], epochS: number, now: number, before?: SavedSleepReports, copies?: { polar: SleepCopy; watch: unknown }): SavedSleepReports {
  const t = lineUp(stages, p.polar.start, epochS, p.watch);
  const combined = tidyBlocks(combine(t.polar, t.watch));
  const agreement = compareMinutes(t.polar, t.watch);
  const { stages: _stages, ...watch } = p.watch;
  const minutes = (x: number | null, y: number | null): number | null => (x == null || y == null ? null : (y - x) / 60000);
  const diff = (x: number, y: number | null): number | null => (y == null ? null : y - x);
  const watchPct = (v: number): number => (watch.sleepMin ? (100 * v) / watch.sleepMin : 0);
  const { past = [], retired, kept, ...last } = before ?? {};
  return {
    ...(before ? { past: [...past, last as PastSleepReports] } : {}),
    ...(retired ? { retired } : {}), ...(kept ? { kept } : {}),
    ...(copies ? { polarCopy: copies.polar, watchCopy: copies.watch } : {}),
    id: p.id, user: p.polar.user, polarId: p.polar.id, watchId: p.watch.id,
    polarStamp: polarStamp(p.polar), watchStamp: watchStamp(p.watch),
    firstAt: before?.firstAt ?? now, generatedAt: now, changed: whatChanged(before, p) ?? 'new',
    start: p.start, end: Math.max(p.polar.start + p.polar.durationS * 1000, p.watch.wokeMs), nap: p.nap, demo: p.polar.source === 'demo' || p.watch.demo, ecgId: p.polar.ecgId ?? null,
    timelineStart: t.startMs, polarMinutes: t.polar, watchMinutes: t.watch, combined,
    // a copy keeps the rules it was made with, so the device with the raw recording still redoes it
    method: p.polar.cloudOnly ? (p.polar.report as { method?: number } | undefined)?.method ?? 1 : SLEEP_METHOD,
    combineRule: COMBINE_RULE, stagesStamp: stagesStamp(stages), labels: labelsOf(p.polar), figures: figuresOf(combined, t.startMs, p.nap), agreement, polar, watch,
    tips: suggestions({
      agreement, polarMin: t.polar.filter((x) => x != null).length, watchMin: t.watch.filter((x) => x != null).length, coverage: polar.coverage,
      sleepDiffMin: watch.sleepMin - polar.sleepMin, onsetDiffMin: minutes(polar.onsetMs, watch.bedMs), wakeDiffMin: minutes(polar.wakeMs, watch.wokeMs),
      deepDiffPct: watchPct(watch.deepMin) - polar.deepPct, remDiffPct: watchPct(watch.remMin) - polar.remPct,
      hrDiff: diff(polar.avgHR, watch.avgHR), hrvDiff: diff(polar.avgHrv, watch.avgHrv), nap: p.nap,
    }),
  };
}
