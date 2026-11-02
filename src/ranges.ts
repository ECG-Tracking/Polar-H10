// Reference ranges for report metrics. Values come from published adult norms where they exist;
// a chest strap is a single, non-standard lead, so ranges marked "approximate" are guides only.

import type { Settings } from './store';

/** At least one bound is set. `rest` = only meaningful for resting recordings. */
export type Range =
  ({ lo: number; hi?: number } | { lo?: number; hi: number }) & { rest?: boolean; note?: string };

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
  ['T wave', 'Standard ECG teaching: T waves up to about 1.0 mV (1000 µV) in the chest leads; under about 0.1 mV (100 µV) is flat; and at least about 1/8–1/10 of the R wave in the same lead. A chest strap is not a standard lead, so these are guides only.'],
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
    tAmp: { lo: 100, hi: 1000, note: 'size, either direction · approximate' },
    trRatio: { lo: 0.1, note: 'T at least 1/10 of R · approximate' },
    jPoint: { lo: -50, hi: 200, note: 'approximate' },
    st60: { lo: -50, hi: 200, note: 'approximate' },
    hrr60: { lo: 13 },
  };
}

export function checkRange(ref: Range | undefined, v: number | null | undefined): RangeStatus | null {
  if (!ref || v == null || !Number.isFinite(v)) return null;
  if (ref.lo != null && v < ref.lo) return 'low';
  if (ref.hi != null && v > ref.hi) return 'high';
  return null;
}

export function fmtRange(ref: Range): string {
  if (ref.lo != null && ref.hi != null) return `${ref.lo}–${ref.hi}`;
  if (ref.lo != null) return `≥ ${ref.lo}`;
  return `≤ ${ref.hi}`;
}
