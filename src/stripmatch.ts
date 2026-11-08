// The Watch D2's 30-second ECG strips against the Polar H10's ECG of the same time: each strip is lined up with the strap
// beat for beat (the watch's clock only gives whole seconds and may be a second or so off), the matching stretch of the
// strap's ECG is cut out, and both sets of pieces are joined with the same flat gaps, so they can be compared, combined
// and viewed side by side.

import { analyze, type Analysis, type BeatFlag } from './dsp';

/** Flat "no signal" between joined strips: long enough that the beats on either side are never taken as a pause or an event. */
export const JOIN_GAP_S = 2;
/** Two beats this close (ms) are the same heartbeat. */
export const SAME_BEAT_MS = 50;
const SEARCH_MS = 3000, STEP_MS = 10;

export interface StripIn { id: string; start: number; samples: Int16Array; fs: number }

export interface MatchedStrip {
  id: string;
  /** When the strip really started (ms), by the strap's clock: the watch's start plus `offsetMs`. */
  start: number;
  offsetMs: number;
  durationS: number;
  watchBeats: number;
  /** Watch beats that are also strap beats. */
  matched: number;
  /** Where this strip sits in the joined ECGs (s). */
  at: number;
}

export interface BeatPair { t: number; watchRr: number | null; polarRr: number | null }

export interface StripSet {
  strips: MatchedStrip[];
  fs: number;
  /** The watch's strips joined, and the strap's ECG of the same moments joined the same way (µV). */
  watch: Int16Array;
  polar: Int16Array;
  watchA: Analysis;
  polarA: Analysis;
  /** Heartbeats both devices recorded, by time in the joined ECGs (s), with each one's interval since the beat before. */
  pairs: BeatPair[];
}

/** The shift (ms) that lines the most watch beats up with strap beats, and how many it lines up. Times in ms. */
export function bestOffset(watch: readonly number[], polar: readonly number[]): { offsetMs: number; matched: number } {
  const sorted = [...polar].sort((a, b) => a - b);
  const near = (t: number): boolean => {
    let lo = 0, hi = sorted.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if ((sorted[mid] ?? 0) < t) lo = mid + 1; else hi = mid; }
    return [sorted[lo - 1], sorted[lo]].some((u) => u != null && Math.abs(u - t) <= SAME_BEAT_MS);
  };
  let best = { offsetMs: 0, matched: -1 };
  for (let off = -SEARCH_MS; off <= SEARCH_MS; off += STEP_MS) {
    let hit = 0;
    for (const t of watch) if (near(t + off)) hit++;
    if (hit > best.matched || (hit === best.matched && Math.abs(off) < Math.abs(best.offsetMs))) best = { offsetMs: off, matched: hit };
  }
  // then centred on the beats it lines up: the average remaining difference
  const res: number[] = [];
  for (const t of watch) {
    const u = sorted.reduce((a, b) => (Math.abs(b - t - best.offsetMs) < Math.abs(a - t - best.offsetMs) ? b : a), Infinity);
    if (Math.abs(u - t - best.offsetMs) <= SAME_BEAT_MS) res.push(u - t - best.offsetMs);
  }
  const shift = res.length ? Math.round(res.reduce((a, b) => a + b, 0) / res.length) : 0;
  return { offsetMs: best.offsetMs + shift, matched: Math.max(0, best.matched) };
}

/** Lines each strip up with the strap's ECG (`polar`, starting at `polarStart` ms) and joins both. Null if no strip overlaps it. */
export function matchStrips(strips: readonly StripIn[], polarStart: number, polar: Int16Array, fs: number, opts: { notch?: number; qtcFormula?: 'bazett' | 'fridericia' } = {}): StripSet | null {
  const polarA = analyze(polar, { fs, ...opts });
  const polarBeats = polarA.beats.map((b) => polarStart + b.t * 1000);
  const polarEnd = polarStart + (polar.length / fs) * 1000;
  const pieces: { strip: MatchedStrip; w: Int16Array; p: Int16Array }[] = [];
  for (const s of [...strips].sort((a, b) => a.start - b.start)) {
    if (s.fs !== fs) continue;
    const a = analyze(s.samples, { fs, ...opts });
    const { offsetMs, matched } = bestOffset(a.beats.map((b) => s.start + b.t * 1000), polarBeats);
    const start = s.start + offsetMs;
    // only the part the strap recorded too
    const from = Math.max(0, Math.round(((polarStart - start) / 1000) * fs));
    const to = Math.min(s.samples.length, Math.round(((polarEnd - start) / 1000) * fs));
    if (to - from < fs * 5) continue;
    const p0 = Math.round(((start - polarStart) / 1000) * fs) + from;
    pieces.push({
      strip: { id: s.id, start: start + (from / fs) * 1000, offsetMs, durationS: (to - from) / fs, watchBeats: a.beats.length, matched, at: 0 },
      w: s.samples.slice(from, to), p: polar.slice(p0, p0 + (to - from)),
    });
  }
  if (!pieces.length) return null;
  const gap = Math.round(JOIN_GAP_S * fs);
  const total = pieces.reduce((n, x) => n + x.w.length, 0) + gap * (pieces.length - 1);
  const watch = new Int16Array(total), polarJoined = new Int16Array(total);
  let o = 0;
  for (const x of pieces) {
    x.strip.at = o / fs;
    watch.set(x.w, o);
    polarJoined.set(x.p, o);
    o += x.w.length + gap;
  }
  const watchA = analyze(watch, { fs, ...opts }), pA = analyze(polarJoined, { fs, ...opts });
  return { strips: pieces.map((x) => x.strip), fs, watch, polar: polarJoined, watchA, polarA: pA, pairs: pairBeats(watchA, pA) };
}

const usable = (flags: readonly BeatFlag[]): boolean => !flags.includes('artifact');

/** Beats in both joined ECGs that are the same heartbeat; each interval only where the beat before is also in both. */
export function pairBeats(w: Analysis, p: Analysis): BeatPair[] {
  const out: BeatPair[] = [];
  let j = 0, lastW: number | null = null, lastP: number | null = null;
  for (const b of w.beats) {
    if (!usable(b.flags)) { lastW = null; lastP = null; continue; }
    while (j < p.beats.length && (p.beats[j]?.t ?? 0) < b.t - SAME_BEAT_MS / 1000) j++;
    const q = p.beats[j];
    if (!q || Math.abs(q.t - b.t) > SAME_BEAT_MS / 1000 || !usable(q.flags)) { lastW = null; lastP = null; continue; }
    out.push({ t: b.t, watchRr: lastW == null ? null : (b.t - lastW) * 1000, polarRr: lastP == null ? null : (q.t - lastP) * 1000 });
    lastW = b.t; lastP = q.t;
  }
  return out;
}

export interface BeatAgreement {
  /** Watch beats that are strap beats (%), and strap beats the watch found (%). */
  watchMatchedPct: number; polarFoundPct: number;
  intervals: number;
  /** Interval differences, watch minus strap (ms). */
  rrBias: number; rrMae: number; within10Pct: number;
}

export function beatAgreement(set: StripSet): BeatAgreement {
  const count = (a: Analysis): number => a.beats.filter((b) => usable(b.flags)).length;
  const both = set.pairs.length;
  const d = set.pairs.flatMap((x) => (x.watchRr != null && x.polarRr != null ? [x.watchRr - x.polarRr] : []));
  const mean = (v: readonly number[]): number => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
  return {
    watchMatchedPct: count(set.watchA) ? (100 * both) / count(set.watchA) : NaN,
    polarFoundPct: count(set.polarA) ? (100 * both) / count(set.polarA) : NaN,
    intervals: d.length,
    rrBias: mean(d), rrMae: mean(d.map(Math.abs)), within10Pct: d.length ? (100 * d.filter((x) => Math.abs(x) <= 10).length) / d.length : NaN,
  };
}

export interface AgreedEvent { t: number; type: BeatFlag; agreed: boolean }

/** The strap's events in the joined ECG, each marked agreed when the watch also has an event at that heartbeat. */
export function agreedEvents(set: StripSet): AgreedEvent[] {
  const watchEvents = set.watchA.events.map((e) => e.t);
  return set.polarA.events.map((e) => ({ t: e.t, type: e.type, agreed: watchEvents.some((t) => Math.abs(t - e.t) <= SAME_BEAT_MS / 1000) }));
}

/** The watch's strips joined on their own (no strap ECG to line them up with), for the D2 report. */
export function joinStrips(strips: readonly StripIn[], fs: number, opts: { notch?: number; qtcFormula?: 'bazett' | 'fridericia' } = {}): { watch: Int16Array; watchA: Analysis; strips: MatchedStrip[] } | null {
  const use = [...strips].filter((s) => s.fs === fs).sort((a, b) => a.start - b.start);
  if (!use.length) return null;
  const gap = Math.round(JOIN_GAP_S * fs);
  const watch = new Int16Array(use.reduce((n, s) => n + s.samples.length, 0) + gap * (use.length - 1));
  const out: MatchedStrip[] = [];
  let o = 0;
  for (const s of use) {
    out.push({ id: s.id, start: s.start, offsetMs: 0, durationS: s.samples.length / fs, watchBeats: 0, matched: 0, at: o / fs });
    watch.set(s.samples, o);
    o += s.samples.length + gap;
  }
  const watchA = analyze(watch, { fs, ...opts });
  return { watch, watchA, strips: out };
}
