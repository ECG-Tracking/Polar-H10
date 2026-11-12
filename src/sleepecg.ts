// The Polar H10 sends its own beat-to-beat intervals during a sleep, and the app records its ECG as well. When the skin
// contact is poor (a dry strap at night), the strap's intervals turn to noise long before its ECG does: its own beats
// can't be used in up to half of a night while the ECG's beats, found by this app, still can. So where the strap's
// intervals are unusable for a 30-second stretch, the beats found in the night's ECG take their place.

import { analyze } from './dsp';
import { EPOCH_S, type SleepData } from './sleep';
import * as store from './store';
import type { SleepSession, SleepSignals } from './store';

/** The ECG is analysed in pieces of this many seconds, so a noisy stretch can't set the beat detection for the rest. */
const PIECE_S = 300;
/** A stretch needs this many usable intervals to count (as for the strap's heart rate in the sleep analysis). */
const USABLE = 10;

/** Beats found in an ECG: each beat's time (seconds from the start of the sleep recording) and the interval before it. */
export interface EcgBeats { t: Float64Array; rr: Float32Array }

export function ecgBeats(x: Int16Array, fs: number, offsetS: number): EcgBeats {
  const t: number[] = [], rr: number[] = [];
  const piece = Math.round(PIECE_S * fs);
  for (let o = 0; o < x.length; o += piece) {
    const a = analyze(x.subarray(o, Math.min(x.length, o + piece)), { fs });
    let prev: number | null = null;
    for (const b of a.beats) {
      if (b.flags.includes('artifact')) { prev = null; continue; } // no interval across a beat that isn't there
      if (prev != null) { t.push(offsetS + o / fs + b.t); rr.push((b.t - prev) * 1000); }
      prev = b.t;
    }
  }
  return { t: Float64Array.from(t), rr: Float32Array.from(rr) };
}

/** Usable intervals in each epoch: plausible, and within 20 % of the median of the 10 around them. */
function usablePerEpoch(t: ArrayLike<number>, rr: ArrayLike<number>, nE: number): Uint16Array {
  const out = new Uint16Array(nE);
  const near: number[] = [];
  for (let i = 0; i < rr.length; i++) {
    const v = rr[i] ?? 0;
    if (v < 300 || v > 2000) continue;
    near.length = 0;
    for (let j = Math.max(0, i - 5); j <= Math.min(rr.length - 1, i + 5); j++) if (j !== i) near.push(rr[j] ?? 0);
    near.sort((a, b) => a - b);
    const med = near[near.length >> 1] ?? v;
    if (Math.abs(v - med) > 0.2 * med) continue;
    const e = Math.floor((t[i] ?? -1) / EPOCH_S);
    if (e >= 0 && e < nE) out[e]!++;
  }
  return out;
}

/**
 * The sleep data with the ECG's beats in place of the strap's in every epoch where the strap's are unusable and the
 * ECG's are not. Elsewhere the strap's intervals stay, as they are timed by the strap itself.
 */
export function withEcgBeats(data: SleepData, ecg: EcgBeats): SleepData {
  const nE = Math.max(1, Math.floor(data.durationS / EPOCH_S));
  const strap = usablePerEpoch(data.rrT, data.rr, nE), fromEcg = usablePerEpoch(ecg.t, ecg.rr, nE);
  const swap = new Uint8Array(nE);
  let any = false;
  for (let e = 0; e < nE; e++) if ((strap[e] ?? 0) < USABLE && (fromEcg[e] ?? 0) >= USABLE) { swap[e] = 1; any = true; }
  if (!any) return data;
  const epochOf = (s: number): number => Math.floor(s / EPOCH_S);
  const t: number[] = [], rr: number[] = [];
  let i = 0, k = 0;
  const take = (time: number, v: number): void => { t.push(time); rr.push(v); };
  while (i < data.rr.length || k < ecg.rr.length) {
    const ts = i < data.rr.length ? data.rrT[i] ?? Infinity : Infinity, te = k < ecg.rr.length ? ecg.t[k] ?? Infinity : Infinity;
    if (ts <= te) { if (!swap[epochOf(ts)]) take(ts, data.rr[i] ?? 0); i++; } else { if (swap[epochOf(te)]) take(te, ecg.rr[k] ?? 0); k++; }
  }
  return { ...data, rrT: Float64Array.from(t), rr: Float32Array.from(rr) };
}

/** A sleep's data for its analysis: the strap's intervals, filled in from the night's ECG when it is on this device. */
export async function sleepData(session: SleepSession, signals: SleepSignals): Promise<SleepData> {
  const data: SleepData = { durationS: session.durationS, ...signals };
  if (!session.ecgId) return data;
  const { session: ecg, samples } = await store.loadSession(session.ecgId).catch(() => ({ session: undefined, samples: undefined }));
  if (!ecg || !samples) return data;
  return withEcgBeats(data, ecgBeats(samples, ecg.fs, (ecg.start - session.start) / 1000));
}
