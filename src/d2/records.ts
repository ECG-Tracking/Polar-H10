// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — turns the other data downloaded from the watch into stored records: numbers in `data` (synced to the
// cloud), text the watch sent in `local` (synced too).
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

import type { ActivityMinute, ActivityTotals, Reading, StressRecord, Workout } from './extra';
import { recordKey, type D2Kind, type D2Night, type D2Record } from './store';
import { keyOf } from './trends';

const hasKeys = (o: Record<string, unknown>): boolean => Object.keys(o).length > 0;

function record(kind: D2Kind, user: number, id: string, start: number, data: Record<string, unknown>, watch: string, local?: Record<string, unknown>): D2Record {
  const r: D2Record = { key: recordKey(kind, user, id), kind, id, user, start, data, source: 'd2', watch, downloadedAt: Date.now() };
  if (local && hasKeys(local)) r.local = local;
  return r;
}

export const minutesOf = (r: D2Record): ActivityMinute[] => (Array.isArray(r.data['minutes']) ? (r.data['minutes'] as ActivityMinute[]) : []);

/** Two lists of minutes as one, by time; `b` wins where both have the same minute. */
export function mergeMinutes(a: readonly ActivityMinute[], b: readonly ActivityMinute[]): ActivityMinute[] {
  const by = new Map<number, ActivityMinute>();
  for (const m of a) by.set(m.t, m);
  for (const m of b) by.set(m.t, m);
  return [...by.values()].sort((x, y) => x.t - y.t);
}

/** Activity minutes as one record per day (local time), merged with the days already stored. */
export function activityRecords(minutes: readonly ActivityMinute[], user: number, watch: string, existing: readonly D2Record[]): D2Record[] {
  const days = new Map<string, ActivityMinute[]>();
  for (const m of minutes) {
    const day = keyOf(new Date(m.t * 1000));
    days.set(day, [...(days.get(day) ?? []), m]);
  }
  return [...days].map(([day, ms]) => {
    const had = existing.find((r) => r.kind === 'activity' && r.user === user && r.id === day);
    const all = mergeMinutes(had ? minutesOf(had) : [], ms);
    return record('activity', user, day, (all[0]?.t ?? 0) * 1000, { minutes: all }, watch);
  });
}

export const totalsRecord = (t: ActivityTotals, user: number, watch: string, now = new Date()): D2Record =>
  record('totals', user, keyOf(now), now.getTime(), { steps: t.steps, kcal: t.kcal, distance: t.distance }, watch);

export const readingRecords = (rs: readonly Reading[], user: number, watch: string): D2Record[] => rs.map((r) =>
  record('reading', user, `${r.cls}-${r.start}`, r.start, { cls: r.cls, start: r.start, end: r.end, modified: r.modified, values: r.values }, watch, hasKeys(r.texts) ? { texts: r.texts } : undefined));

export const stressRecords = (rs: readonly StressRecord[], user: number, watch: string): D2Record[] => rs.map((r) =>
  record('stress', user, String(r.start), r.start, { ...r }, watch));

export const workoutRecords = (ws: readonly Workout[], user: number, watch: string): D2Record[] => ws.map(({ texts, ...w }) =>
  record('workout', user, String(w.start), w.start, { ...w }, watch, hasKeys(texts) ? { texts } : undefined));

/** What a download changes: anything identical to what is stored is left alone, so it isn't replaced or synced again. */
export function onlyChanged<T>(incoming: readonly T[], stored: readonly T[], keyOf: (x: T) => string, contentOf: (x: T) => unknown): { changed: T[]; same: T[] } {
  const have = new Map(stored.map((x) => [keyOf(x), JSON.stringify(contentOf(x))]));
  const changed: T[] = [], same: T[] = [];
  for (const x of incoming) (have.get(keyOf(x)) === JSON.stringify(contentOf(x)) ? same : changed).push(x);
  return { changed, same };
}

/** Added to a count: how many of them were identical to what is stored. */
/** How many of `count` downloaded were new or changed (`nil` were the same as stored): " (1 change)", or " (no change)". */
export const nilText = (count: number, nil: number): string => {
  const changed = Math.max(0, count - nil);
  return !count ? '' : !changed ? ' (no change)' : ` (${changed} change${changed === 1 ? '' : 's'})`;
};

export const nightContent = (n: D2Night): unknown => [n.user, n.start, n.stages, n.summary];
export const recordContent = (r: D2Record): unknown => [r.user, r.start, r.data, r.local ?? null];
