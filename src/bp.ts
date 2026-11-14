// Blood pressure with the ECG: the watch's blood pressure readings, each matched with the ECGs taken around it, for the
// "BP and ECG" page and the BP graph above an ECG.

import type { Session, SyncBp, SyncTrackingEntry } from './store';
import type { CombinedResult } from './synccompare';
import { syncBps } from './store';

/** A reading belongs with an ECG taken from an hour before it to an hour after (as for a tracking's readings). */
export const BP_NEAR_MS = 3600000;

/** Every reading once: D2 Link's downloaded readings and those kept with the trackings (the same within a minute). */
export function mergeReadings(stored: readonly SyncBp[], entries: readonly SyncTrackingEntry[]): SyncBp[] {
  const all = [...stored, ...entries.flatMap((e) => syncBps(e))].sort((a, b) => a.at - b.at);
  const out: SyncBp[] = [];
  for (const r of all) {
    const last = out[out.length - 1];
    if (last && r.at - last.at < 60000 && r.systolic === last.systolic && r.diastolic === last.diastolic) continue;
    out.push(r);
  }
  return out;
}

/** The readings from `from` to `to` (ms). */
export const readingsBetween = (all: readonly SyncBp[], from: number, to: number): SyncBp[] => all.filter((r) => r.at >= from && r.at <= to);

/** The ECGs of one reading: the synchronised tracking it belongs to, or else the strap ECG and watch strips nearest it. */
export interface BpMatch {
  bp: SyncBp;
  tracking: SyncTrackingEntry | null;
  polar: Session | null;
  watch: Session[];
  /** The tracking's saved Combined ECG results, when there are any (they are used in place of each recording's own). */
  combined?: CombinedResult | null;
}

const endOf = (s: { start: number; durationS: number }): number => s.start + s.durationS * 1000;
/** How far a reading is from a recording: 0 when taken during it. */
const gap = (at: number, s: { start: number; durationS: number }): number => (at < s.start ? s.start - at : at > endOf(s) ? at - endOf(s) : 0);

export function matchReading(bp: SyncBp, sessions: readonly Session[], entries: readonly SyncTrackingEntry[]): BpMatch {
  const near = <T extends { start: number; durationS: number }>(xs: readonly T[]): T[] =>
    xs.filter((x) => gap(bp.at, x) <= BP_NEAR_MS).sort((a, b) => gap(bp.at, a) - gap(bp.at, b));
  const tracking = near(entries)[0] ?? null;
  const strips = (from: number, to: number): Session[] => sessions.filter((s) => s.source === 'watch' && s.start < to && endOf(s) > from);
  if (tracking) {
    return {
      bp, tracking,
      polar: sessions.find((s) => s.id === tracking.ecgId) ?? null,
      watch: strips(tracking.start, endOf(tracking)),
    };
  }
  // no tracking: the strap ECG nearest the reading (not one recorded with a sleep), and the watch strips within the hour
  const polar = near(sessions.filter((s) => s.source !== 'watch' && s.source !== 'demo' && !s.sleepId))[0] ?? null;
  return { bp, tracking: null, polar, watch: strips(bp.at - BP_NEAR_MS, bp.at + BP_NEAR_MS) };
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * One device's figure for a reading, from the figures kept with each recording: the strap ECG's own, or the median of the
 * watch strips' (their events added up). null where there is none.
 */
export function figure(m: BpMatch, device: 'polar' | 'watch', key: string): number | null {
  // a tracking's Combined ECG results: both devices from the same heartbeats, events only where both saw one
  const c = m.tracking ? m.combined : null;
  if (c?.polar && c.watch && c.events) {
    if (key === 'eventCount') return c.events[device];
    if (key === 'eventPct') return device === 'polar' ? c.events.polarPct : c.events.watchPct;
    return c[device]?.[key] ?? null;
  }
  if (device === 'polar') return m.polar?.summary?.trend?.[key] ?? null;
  const vals = m.watch.flatMap((s) => { const v = s.summary?.trend?.[key]; return v == null ? [] : [v]; });
  if (!vals.length) return null;
  return key === 'eventCount' ? vals.reduce((a, b) => a + b, 0) : median(vals);
}
