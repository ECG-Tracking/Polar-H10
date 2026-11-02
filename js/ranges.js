// Reference ranges for report metrics. Values come from published adult norms where they exist;
// a chest strap is a single, non-standard lead, so ranges marked "approximate" are guides only.

// Short-term resting RMSSD (ms) by age, approximating published age trends (Umetani et al. 1998)
// around the adult normative range of Nunan et al. 2010.
const RMSSD_BY_AGE = [
  [30, 25, 80],
  [40, 20, 65],
  [50, 17, 55],
  [60, 14, 45],
  [Infinity, 12, 40],
];

export const SOURCES = [
  ['Resting heart rate', 'American Heart Association: 60–100 bpm adults; 40–60 common in trained people.'],
  ['RMSSD, SDNN', 'Nunan D. et al. A quantitative systematic review of normal values for short-term heart rate variability. PACE 2010 (RMSSD 19–75 ms, SDNN 32–93 ms). Age adjustment follows Umetani K. et al., JACC 1998.'],
  ['QRS, QTc', 'AHA/ACCF/HRS recommendations for ECG interpretation (Surawicz 2009; Rautaharju 2009): QRS ≥ 120 ms is wide; QTc ≥ 450 ms (men) / ≥ 460 ms (women) is prolonged.'],
  ['J point, ST', 'Fourth Universal Definition of Myocardial Infarction (2018) uses ≥ 100 µV elevation / ≥ 50 µV depression in standard leads; applied loosely here.'],
  ['HR recovery', 'Cole C.R. et al., NEJM 1999: a drop of 12 bpm or less in the first minute after exercise is abnormal.'],
  ['Ectopic beats', 'Healthy adults usually have under 1 % ectopic beats on long recordings; flagged beats here also include noise.'],
];

/** Ranges keyed by metric name. `rest` = only meaningful for resting recordings. */
export function referenceRanges(settings) {
  const age = Number(settings.age) || 40;
  const [, rLo, rHi] = RMSSD_BY_AGE.find(([maxAge]) => age < maxAge);
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
    jPoint: { lo: -50, hi: 200, note: 'approximate' },
    st60: { lo: -50, hi: 200, note: 'approximate' },
    rAmp: { lo: 300, hi: 3000, note: 'signal check' },
    hrr60: { lo: 13 },
  };
}

/** 'low' | 'high' | null */
export function checkRange(ref, v) {
  if (!ref || v == null || !Number.isFinite(v)) return null;
  if (ref.lo != null && v < ref.lo) return 'low';
  if (ref.hi != null && v > ref.hi) return 'high';
  return null;
}

export function fmtRange(ref) {
  if (ref.lo != null && ref.hi != null) return `${ref.lo}–${ref.hi}`;
  if (ref.lo != null) return `≥ ${ref.lo}`;
  return `≤ ${ref.hi}`;
}
