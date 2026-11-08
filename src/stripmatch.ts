// The Watch D2's 30-second ECG strips against the Polar H10's ECG of the same time: each strip is lined up with the strap
// beat for beat (the watch's clock only gives whole seconds and may be a second or so off), the matching stretch of the
// strap's ECG is cut out, and both sets of pieces are joined with the same flat gaps, so they can be compared, combined
// and viewed side by side.

import { analyze, type Analysis, type Beat, type BeatFlag } from './dsp';

/** Flat "no signal" between joined strips: long enough that the beats on either side are never taken as a pause or an event. */
export const JOIN_GAP_S = 2;
/** Two beats this close (ms) are the same heartbeat: the R wave peaks a little apart on the wrist and the chest. */
export const SAME_BEAT_MS = 80;
/** Lining strips up uses a tighter window (ms). */
const FIT_MS = 50;
const SEARCH_MS = 5000, STEP_MS = 10;
/** An event with no other within this many ms either side is clear enough to line the two devices up on. */
export const LONE_EVENT_MS = 5000;
const ANCHOR_BONUS = 10;

export interface TimedEvent { t: number; type: BeatFlag } // t in ms

/** Events with no other event within LONE_EVENT_MS before or after. */
export function loneEvents(events: readonly TimedEvent[]): TimedEvent[] {
  return events.filter((e) => !events.some((o) => o !== e && Math.abs(o.t - e.t) < LONE_EVENT_MS));
}

export interface StripIn { id: string; start: number; samples: Int16Array; fs: number }

export interface MatchedStrip {
  id: string;
  /** When the strip really started (ms), by the strap's clock: the watch's start plus `offsetMs`. */
  start: number;
  offsetMs: number;
  /** Lone events lined up with the strap's (the same kind, no other event within 5 s). */
  anchored?: number;
  /** How much the strip was stretched (or shrunk) in time to match the strap: 1 = not at all. */
  stretch: number;
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
  /** Strips left out: no clear heartbeats, or they don't line up with the strap. */
  skipped: string[];
  fs: number;
  /** The watch's strips joined, and the strap's ECG of the same moments joined the same way (µV). */
  watch: Int16Array;
  polar: Int16Array;
  watchA: Analysis;
  polarA: Analysis;
  /** Heartbeats both devices recorded, by time in the joined ECGs (s), with each one's interval since the beat before. */
  pairs: BeatPair[];
}

/** The index of the nearest of the sorted times to `t`. */
function nearest(sorted: readonly number[], t: number): number {
  let lo = 0, hi = sorted.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if ((sorted[mid] ?? 0) < t) lo = mid + 1; else hi = mid; }
  return lo > 0 && Math.abs((sorted[lo - 1] ?? Infinity) - t) < Math.abs((sorted[lo] ?? Infinity) - t) ? lo - 1 : lo;
}
/** How far (ms) from `t` the nearest of the sorted times is. */
function gapTo(sorted: readonly number[], t: number): number {
  return Math.abs((sorted[nearest(sorted, t)] ?? Infinity) - t);
}

/**
 * The stretch and shift that line the watch's beats (ms from the strip's start) up with the strap's (ms), scored by how
 * closely each beat lands, not just how many land: with a steady rhythm a shift of one whole beat also lines most beats
 * up, but less closely, and a premature beat rules it out. `stretch` is how much longer the strip really is.
 */
export function bestFit(watch: readonly number[], polar: readonly number[], start: number, events?: { watch: readonly TimedEvent[]; polar: readonly TimedEvent[] }): { offsetMs: number; stretch: number; matched: number; anchored: number } {
  const sorted = [...polar].sort((a, b) => a - b);
  // a lone event on each, of the same kind, is very likely the same heartbeat: lining them up counts for a lot
  const wLone = events ? loneEvents(events.watch) : [], pLone = events ? loneEvents(events.polar) : [];
  const anchors = (off: number, k: number): number => wLone.filter((e) => pLone.some((p) => p.type === e.type && Math.abs(p.t - (start + off + e.t * k)) <= FIT_MS)).length;
  // pattern recognition: besides landing on the same moments, the rhythm must match: each beat's interval since the one
  // before (its own little pattern of longer and shorter beats) against the strap's at that heartbeat
  const score = (off: number, k: number): number => {
    let s = 0;
    for (let i = 0; i < watch.length; i++) {
      const t = watch[i] ?? 0, j = nearest(sorted, start + off + t * k), d = Math.abs((sorted[j] ?? Infinity) - (start + off + t * k));
      if (d >= 25) continue;
      s += 1 - d / 25;
      const prev = watch[i - 1], pPrev = sorted[j - 1];
      if (prev != null && pPrev != null) {
        const dr = Math.abs((t - prev) * k - ((sorted[j] ?? 0) - pPrev));
        if (dr < 30) s += 1 - dr / 30;
      }
    }
    return s + (wLone.length ? ANCHOR_BONUS * anchors(off, k) : 0);
  };
  let best = { off: 0, k: 1, s: -1 };
  for (let k = 0.96; k <= 1.04 + 1e-9; k += 0.004) {
    for (let off = -SEARCH_MS; off <= SEARCH_MS; off += STEP_MS) {
      const s = score(off, k);
      if (s > best.s) best = { off, k, s };
    }
  }
  // finer, around the best
  const coarse = best;
  for (let k = coarse.k - 0.004; k <= coarse.k + 0.004 + 1e-9; k += 0.0005) {
    for (let off = coarse.off - 15; off <= coarse.off + 15; off += 1) {
      const s = score(off, k);
      if (s > best.s) best = { off, k, s };
    }
  }
  const matched = watch.filter((t) => gapTo(sorted, start + best.off + t * best.k) <= FIT_MS).length;
  return { offsetMs: best.off, stretch: best.k, matched, anchored: anchors(best.off, best.k) };
}

/** Kept for simple use: the shift alone (no stretch). */
export function bestOffset(watch: readonly number[], polar: readonly number[]): { offsetMs: number; matched: number } {
  const f = bestFit(watch.map((t) => t - (watch[0] ?? 0)), polar, watch[0] ?? 0);
  return { offsetMs: f.offsetMs, matched: f.matched };
}

/** Samples stretched to `k` times as long (linear interpolation). */
function stretchSamples(x: Int16Array, k: number): Int16Array {
  if (Math.abs(k - 1) < 1e-4) return x;
  const out = new Int16Array(Math.round(x.length * k));
  for (let i = 0; i < out.length; i++) {
    const p = i / k, a = Math.floor(p), f = p - a;
    out[i] = Math.round((x[a] ?? 0) * (1 - f) + (x[Math.min(x.length - 1, a + 1)] ?? 0) * f);
  }
  return out;
}

/** Lines each strip up with the strap's ECG (`polar`, starting at `polarStart` ms) and joins both. Null if no strip overlaps it. */
export function matchStrips(strips: readonly StripIn[], polarStart: number, polar: Int16Array, fs: number, opts: { notch?: number; qtcFormula?: 'bazett' | 'fridericia' } = {}): StripSet | null {
  const polarA = analyze(polar, { fs, ...opts });
  const polarBeats = polarA.beats.map((b) => polarStart + b.t * 1000);
  const polarEnd = polarStart + (polar.length / fs) * 1000;
  const pieces: { strip: MatchedStrip; w: Int16Array; p: Int16Array }[] = [];
  const skipped: string[] = [];
  for (const s of [...strips].sort((a, b) => a.start - b.start)) {
    if (s.fs !== fs) continue;
    const a = analyze(s.samples, { fs, ...opts });
    const fit = bestFit(a.beats.map((b) => b.t * 1000), polarBeats, s.start, {
      watch: a.events.map((e) => ({ t: e.t * 1000, type: e.type })), polar: polarA.events.map((e) => ({ t: polarStart + e.t * 1000, type: e.type })),
    });
    const { offsetMs, matched } = fit;
    // a strip without clear heartbeats (noise, or the finger lifted) would throw out the beat detection of the rest
    const expected = (s.samples.length / fs) / 1.5;
    if (a.beats.length < Math.max(5, expected / 2) || matched < a.beats.length * 0.6) { skipped.push(s.id); continue; }
    const samples = stretchSamples(s.samples, fit.stretch); // the watch's own timing put right
    const start = s.start + offsetMs;
    // only the part the strap recorded too
    const from = Math.max(0, Math.round(((polarStart - start) / 1000) * fs));
    const to = Math.min(samples.length, Math.round(((polarEnd - start) / 1000) * fs));
    if (to - from < fs * 5) continue;
    const p0 = Math.round(((start - polarStart) / 1000) * fs) + from;
    pieces.push({
      strip: { id: s.id, start: start + (from / fs) * 1000, offsetMs, stretch: fit.stretch, anchored: fit.anchored, durationS: (to - from) / fs, watchBeats: a.beats.length, matched, at: 0 },
      w: samples.slice(from, to), p: polar.slice(p0, p0 + (to - from)),
    });
  }
  if (!pieces.length) return null;
  const w = analysePieces(pieces.map((x) => x.w), fs, opts), pj = analysePieces(pieces.map((x) => x.p), fs, opts);
  pieces.forEach((x, i) => { x.strip.at = w.at[i] ?? 0; });
  const watch = w.joined, polarJoined = pj.joined, watchA = w.a, pA = pj.a;
  return { strips: pieces.map((x) => x.strip), skipped, fs, watch, polar: polarJoined, watchA, polarA: pA, pairs: pairBeats(watchA, pA) };
}

type Opts = { notch?: number; qtcFormula?: 'bazett' | 'fridericia' };

/**
 * Pieces joined with flat gaps and analysed piece by piece: analysed as one, the beat detection's sensitivity would be set
 * by the whole, and a strip much larger or smaller than the others could lose all its beats.
 */
export function analysePieces(parts: readonly Int16Array[], fs: number, opts: Opts = {}): { joined: Int16Array; a: Analysis; at: number[] } {
  const gap = Math.round(JOIN_GAP_S * fs);
  const joined = new Int16Array(parts.reduce((n, p) => n + p.length, 0) + gap * Math.max(0, parts.length - 1));
  const at: number[] = [];
  let o = 0;
  for (const p of parts) { at.push(o / fs); joined.set(p, o); o += p.length + gap; }
  const whole = analyze(joined, { fs, ...opts }); // the filtered signal to show
  const beats: Beat[] = [], events: Analysis['events'] = [];
  let artifacts = 0, best: Analysis | null = null, bestClean = -1;
  parts.forEach((p, i) => {
    const off = Math.round((at[i] ?? 0) * fs), a = analyze(p, { fs, ...opts });
    for (const b of a.beats) {
      const m = b.m && { ...b.m, onset: b.m.onset + off, offset: b.m.offset + off, tPeak: b.m.tPeak < 0 ? b.m.tPeak : b.m.tPeak + off, tEnd: b.m.tEnd == null ? null : b.m.tEnd + off };
      beats.push({ ...b, t: b.t + off / fs, r: b.r + off, m });
    }
    for (const e of a.events) events.push({ ...e, t: e.t + off / fs });
    artifacts += a.artifacts;
    const clean = a.beats.filter((b) => !b.flags.length).length;
    if (a.template && clean > bestClean) { best = a; bestClean = clean; }
  });
  const t: Analysis = best ?? whole;
  return { joined, at, a: { ...whole, beats, events, artifacts, template: t.template, templateMeasure: t.templateMeasure, polarity: t.polarity } };
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
export function joinStrips(strips: readonly StripIn[], fs: number, opts: Opts = {}): { watch: Int16Array; watchA: Analysis; strips: MatchedStrip[] } | null {
  const use = [...strips].filter((s) => s.fs === fs).sort((a, b) => a.start - b.start);
  if (!use.length) return null;
  const j = analysePieces(use.map((s) => s.samples), fs, opts);
  return {
    watch: j.joined, watchA: j.a,
    strips: use.map((s, i) => ({ id: s.id, start: s.start, offsetMs: 0, stretch: 1, durationS: s.samples.length / fs, watchBeats: 0, matched: 0, at: j.at[i] ?? 0 })),
  };
}
