// Every ECG of a period on two strips, for the BP and ECG page: the Watch D2's above, the Polar H10's below, the pieces in
// time order with a short flat gap between them (the hours between recordings are left out, so one slider can reach
// every ECG). Where only one device recorded, the other strip is flat. Each piece keeps its real start, so a moment on
// the strips is a date and time (for the blood pressure graph and the time shown).

import { analysePieces } from './stripmatch';
import type { Analysis } from './dsp';

/** One stretch of ECG: when it started (ms), how long (s), and each device's samples (null: that device didn't record). */
export interface Segment { start: number; durS: number; watch: Int16Array | null; polar: Int16Array | null }

export interface PeriodEcg {
  segments: Segment[];
  /** Where each segment begins on the joined strips (s). */
  at: number[];
  watchA: Analysis;
  polarA: Analysis;
  /** Seconds of strip in all. */
  durationS: number;
}

/** The segments joined in time order; each device's strip is flat where it didn't record. */
export function joinSegments(segments: readonly Segment[], fs: number, opts: { notch?: number; qtcFormula?: 'bazett' | 'fridericia' } = {}): PeriodEcg | null {
  const segs = [...segments].filter((s) => s.durS > 0 && (s.watch || s.polar)).sort((a, b) => a.start - b.start);
  if (!segs.length) return null;
  const piece = (s: Segment, x: Int16Array | null): Int16Array => {
    const n = Math.round(s.durS * fs);
    if (x && x.length >= n) return x.subarray(0, n);
    const out = new Int16Array(n); // flat: this device didn't record (or recorded less)
    if (x) out.set(x);
    return out;
  };
  const w = analysePieces(segs.map((s) => piece(s, s.watch)), fs, opts), p = analysePieces(segs.map((s) => piece(s, s.polar)), fs, opts);
  const last = segs[segs.length - 1]!;
  return { segments: segs, at: w.at, watchA: w.a, polarA: p.a, durationS: (w.at[w.at.length - 1] ?? 0) + last.durS };
}

/** The real moment (ms) of a time on the strips: in a gap between pieces, the end of the piece before. */
export function realAt(e: Pick<PeriodEcg, 'segments' | 'at'>, t: number): number | null {
  let i = -1;
  for (let k = 0; k < e.at.length; k++) if ((e.at[k] ?? Infinity) <= t + 1e-6) i = k;
  const s = e.segments[Math.max(0, i)];
  if (!s) return null;
  const into = Math.min(s.durS, Math.max(0, t - (e.at[Math.max(0, i)] ?? 0)));
  return s.start + into * 1000;
}

/** The piece shown at a time on the strips (s): the last one starting at or before it. */
export function segmentAt(e: Pick<PeriodEcg, 'segments' | 'at'>, t: number): Segment | null {
  let i = 0;
  for (let k = 0; k < e.at.length; k++) if ((e.at[k] ?? Infinity) <= t + 1e-6) i = k;
  return e.segments[i] ?? null;
}

/** The time on the strips (s) nearest a real moment (ms): inside its piece, or the start of the nearest piece. */
export function stripAt(e: Pick<PeriodEcg, 'segments' | 'at'>, ms: number): number {
  let best = 0, bd = Infinity;
  e.segments.forEach((s, k) => {
    const end = s.start + s.durS * 1000;
    const d = ms < s.start ? s.start - ms : ms > end ? ms - end : 0;
    if (d < bd) { bd = d; best = (e.at[k] ?? 0) + Math.min(s.durS, Math.max(0, (ms - s.start) / 1000)); }
  });
  return best;
}

