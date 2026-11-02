// Reference ranges for report metrics. Values come from published adult norms where they exist;
// a chest strap is a single, non-standard lead, so ranges marked "approximate" are guides only.

import type { Settings } from './store';

/** At least one bound is set. `rest` = only meaningful for resting recordings. */
export type Range =
  ({ lo: number; hi?: number } | { lo?: number; hi: number }) & {
    rest?: boolean;
    note?: string;
    /** Values exactly on a limit are flagged too (warnings given as "≤ lo" / "≥ hi"). */
    edgesFlagged?: boolean;
    /** Flag text instead of "Below range" / "Above range". */
    lowLabel?: string;
    highLabel?: string;
  };

export type RangeStatus = 'low' | 'high';

// Short-term resting RMSSD (ms) by age, approximating published age trends (Umetani et al. 1998)
// around the adult normative range of Nunan et al. 2010. Rows: [age below, low, high].
const RMSSD_BY_AGE: readonly (readonly [number, number, number])[] = [
  [30, 25, 80],
  [40, 20, 65],
  [50, 17, 55],
  [60, 14, 45],
  [Infinity, 12, 40],
];

export const SOURCES: readonly (readonly [string, string])[] = [
  ['Resting heart rate', 'American Heart Association: 60–100 bpm adults; 40–60 common in trained people.'],
  ['RMSSD, SDNN', 'Nunan D. et al. A quantitative systematic review of normal values for short-term heart rate variability. PACE 2010 (RMSSD 19–75 ms, SDNN 32–93 ms). Age adjustment follows Umetani K. et al., JACC 1998.'],
  ['QRS, QTc', 'AHA/ACCF/HRS recommendations for ECG interpretation (Surawicz 2009; Rautaharju 2009): QRS ≥ 120 ms is wide; QTc ≥ 450 ms (men) / ≥ 460 ms (women) is prolonged.'],
  ['J point, ST', 'Fourth Universal Definition of Myocardial Infarction (2018) uses ≥ 100 µV elevation / ≥ 50 µV depression in standard leads; applied loosely here.'],
  ['T wave', 'Standard ECG teaching: T waves up to about 1.0 mV (1000 µV) in the chest leads; under about 0.1 mV (100 µV) is flat; the T-wave amplitude range applies to upright T waves, so a T wave pointing down is below it; and at least about 1/8–1/10 of the R wave in the same lead. A T/R ratio between about 0.1 and 0.75 is usual; ≤ 0.1 suggests a flattened T wave and ≥ 0.75 a possibly peaked one (shape is not assessed). A chest strap is not a standard lead, so these are guides only.'],
  ['HR recovery', 'Cole C.R. et al., NEJM 1999: a drop of 12 bpm or less in the first minute after exercise is abnormal.'],
  ['Ectopic beats', 'Healthy adults usually have under 1 % ectopic beats on long recordings; flagged beats here also include noise.'],
];

export interface ReferenceRanges {
  meanHR: Range; hrvScore: Range; rmssd: Range; sdnn: Range; pnn50: Range; pnn200: Range;
  eventPct: Range; qrs: Range; qtc: Range; tPositive: Range; tAmp: Range; trRatio: Range; jPoint: Range; st60: Range; hrr60: Range;
}

export function referenceRanges(settings: Pick<Settings, 'age' | 'sex'>): ReferenceRanges {
  const age = Number(settings.age) || 40;
  const [, rLo, rHi] = RMSSD_BY_AGE.find(([maxAge]) => age < maxAge) ?? [Infinity, 12, 40];
  const female = settings.sex === 'female';
  return {
    meanHR: { lo: 40, hi: 100, rest: true },
    hrvScore: { lo: Math.round(15 * Math.log(rLo)), hi: Math.round(15 * Math.log(rHi)), rest: true, note: `age ${age}` },
    rmssd: { lo: rLo, hi: rHi, rest: true, note: `age ${age}` },
    sdnn: { lo: 32, hi: 93, rest: true },
    pnn50: { hi: 50, note: 'approximate' },
    pnn200: { hi: 10, note: 'approximate' },
    eventPct: { hi: 1 },
    qrs: { lo: 60, hi: 120 },
    qtc: { lo: 350, hi: female ? 460 : 450, note: female ? 'women' : 'men' },
    tPositive: { lo: 90, note: 'approximate' },
    tAmp: { lo: 100, hi: 1000, note: 'upright T · approximate' },
    trRatio: {
      lo: 0.1, hi: 0.75, edgesFlagged: true, note: '≤ 0.1 flattened, ≥ 0.75 peaked · approximate',
      lowLabel: 'Possibly flattened', highLabel: 'Possibly peaked',
    },
    jPoint: { lo: -50, hi: 200, note: 'approximate' },
    st60: { lo: -50, hi: 200, note: 'approximate' },
    hrr60: { lo: 13 },
  };
}

export function checkRange(ref: Range | undefined, v: number | null | undefined): RangeStatus | null {
  if (!ref || v == null || !Number.isFinite(v)) return null;
  const edge = ref.edgesFlagged === true;
  if (ref.lo != null && (edge ? v <= ref.lo : v < ref.lo)) return 'low';
  if (ref.hi != null && (edge ? v >= ref.hi : v > ref.hi)) return 'high';
  return null;
}

export function fmtRange(ref: Range): string {
  if (ref.lo != null && ref.hi != null) return `${ref.lo}–${ref.hi}`;
  if (ref.lo != null) return `≥ ${ref.lo}`;
  return `≤ ${ref.hi}`;
}

// ---------- Sleep ----------

export const SLEEP_SOURCES: readonly (readonly [string, string])[] = [
  ['Sleep duration', 'American Academy of Sleep Medicine & Sleep Research Society consensus (Watson et al. 2015): adults should sleep 7 h or more; National Sleep Foundation (Hirshkowitz et al. 2015): 7–9 h recommended for adults.'],
  ['Sleep stages', 'Ohayon M.M. et al., Sleep 2004 (meta-analysis of normal sleep in healthy adults): deep sleep (N3) roughly 15–25 %, REM roughly 20–25 %, light sleep (N1+N2) about 50–60 %; deep sleep declines with age.'],
  ['Efficiency, time to fall asleep, awake time', 'Commonly used clinical thresholds (e.g. insomnia research criteria): sleep efficiency of 85 % or more, falling asleep within 30 min, and 30 min or less awake after falling asleep.'],
  ['Breathing rate', 'Typical resting adult breathing rate is about 12–20 breaths/min; during sleep it is often slightly lower.'],
  ['Personal ranges', 'Heart rate and HRV during sleep vary a lot between people, so they are compared with your own previous nights (average ± 1 standard deviation, from 3 nights on).'],
];

export interface SleepRanges {
  sleepHours: Range; deepPct: Range; lightPct: Range; remPct: Range; awakenings: Range;
  efficiency: Range; latency: Range; waso: Range; breathing: Range; regularity: Range; continuity: Range;
}

export function sleepRanges(): SleepRanges {
  return {
    sleepHours: { lo: 7, hi: 9 },
    deepPct: { lo: 15, hi: 30, note: 'approximate' },
    lightPct: { hi: 60, note: 'approximate' },
    remPct: { lo: 15, hi: 30, note: 'approximate' },
    awakenings: { hi: 2, note: 'awake ≥ 2 min' },
    efficiency: { lo: 85 },
    latency: { hi: 30 },
    waso: { hi: 30 },
    breathing: { lo: 10, hi: 20, note: 'approximate' },
    regularity: { lo: 70, note: 'approximate' },
    continuity: { lo: 70, note: 'approximate' },
  };
}

/** Your usual range from earlier nights (mean ± 1 SD), or null with fewer than 3 nights. */
export function personalRange(previous: readonly number[]): Range | null {
  const v = previous.filter((x) => Number.isFinite(x));
  if (v.length < 3) return null;
  const m = v.reduce((s, x) => s + x, 0) / v.length;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
  const half = Math.max(1, sd);
  return { lo: Math.round(m - half), hi: Math.round(m + half), note: `your last ${v.length} nights` };
}
