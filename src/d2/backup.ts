// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — its part of OpenBeat ECG's account backup and restore, and a sync on request (Sync & backups).
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

import { syncNights, syncRecords, type CloudClient } from './cloud';
import type { ActivityMinute } from './extra';
import { figures, isNap } from './night';
import { minutesOf } from './records';
import * as store from './store';
import type { D2BinItem, D2Night, D2Record, DownloadLogEntry } from './store';

/**
 * What a backup holds from D2 Link. Left out: the watch pairing (pair again after restoring on another device) and the
 * watch account ID (enter it again in D2 Link); `watchAccount` is only read from backups made before it was left out.
 */
export interface D2Backup { v: 1; nights: D2Night[]; records: D2Record[]; downloads: DownloadLogEntry[]; watchAccount?: string; bin?: D2BinItem[] }

export interface PairingSleep {
  id: string; start: number; stages: number[]; nap: boolean; demo: boolean; watch: string; bedMs: number; wokeMs: number;
  sleepMin: number; deepMin: number; lightMin: number; remMin: number; awakeMin: number; wakeups: number | null;
  score: number | null; avgHR: number | null; avgHrv: number | null; avgSpo2: number | null; avgBreath: number | null;
}

/** `withBin` adds the deleted items kept for the Recovery centre (a backup has them, a comparison file doesn't). */
export async function exportD2(account: string, withBin = false): Promise<D2Backup> {
  store.useAccount(account);
  return { v: 1, nights: await store.listAllNights(), records: await store.listAllRecords(), downloads: store.loadDownloadLog(), ...(withBin ? { bin: await store.listBin() } : {}) };
}

export interface TrackingWatchData {
  minutes: ActivityMinute[];
  hrv: { at: number; rmssd: number | null }[];
  emotion: { at: number; status: number | null; valence: number | null; arousal: number | null }[];
  stress: { at: number; end: number; score: number | null; level: number | null }[];
  workouts: { at: number; end: number }[];
}

/** What the watch's downloads hold for each tracking: its minutes, what was measured within `nearMs`, and workouts overlapping it. */
export async function trackingData(account: string, trackings: readonly { user: number; from: number; to: number }[], nearMs: number): Promise<TrackingWatchData[]> {
  store.useAccount(account);
  const all = (await store.listAllRecords()).sort((a, b) => a.start - b.start);
  return trackings.map((t) => dataOf(all.filter((r) => r.user === t.user), t.from, t.to, nearMs));
}

function dataOf(records: readonly D2Record[], from: number, to: number, nearMs: number): TrackingWatchData {
  const near = (at: number): boolean => at >= from - nearMs && at <= to + nearMs;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const values = (r: D2Record): Record<string, number> => (r.data['values'] ?? {}) as Record<string, number>;
  const readings = (cls: number): D2Record[] => records.filter((r) => r.kind === 'reading' && r.data['cls'] === cls && near(r.start));
  return {
    minutes: records.filter((r) => r.kind === 'activity' && r.start <= to && r.start >= from - 2 * 86400000).flatMap(minutesOf).filter((m) => m.t * 1000 >= from - 60000 && m.t * 1000 <= to).sort((a, b) => a.t - b.t),
    hrv: readings(500044).map((r) => ({ at: r.start, rmssd: num(values(r)['500044831']) })),
    emotion: readings(500031).map((r) => ({ at: r.start, status: num(values(r)['500031195']), valence: num(values(r)['500031347']), arousal: num(values(r)['500031842']) })),
    stress: records.filter((r) => r.kind === 'stress' && near(r.start)).map((r) => ({ at: r.start, end: num(r.data['end']) ?? r.start, score: num(r.data['score']), level: num(r.data['level']) })),
    workouts: records.filter((r) => r.kind === 'workout' && r.start <= to && (num(r.data['end']) ?? r.start) >= from).map((r) => ({ at: r.start, end: num(r.data['end']) ?? r.start })),
  };
}

export interface D2Use { count: number; bytes: number }
export interface D2Storage { nights: D2Use; activity: D2Use; measurements: D2Use; stress: D2Use; workouts: D2Use; bin: D2Use }

/** How much D2 Link holds on this device; `size` is the app's own way of counting, so both pages' figures add up. */
export async function d2Storage(account: string, size: (v: unknown) => number): Promise<D2Storage> {
  store.useAccount(account);
  const add = (u: D2Use, v: unknown): void => { u.count++; u.bytes += size(v); };
  const zero = (): D2Use => ({ count: 0, bytes: 0 });
  const out: D2Storage = { nights: zero(), activity: zero(), measurements: zero(), stress: zero(), workouts: zero(), bin: zero() };
  for (const n of await store.listAllNights()) add(out.nights, n);
  for (const r of await store.listAllRecords()) {
    add(r.kind === 'reading' ? out.measurements : r.kind === 'stress' ? out.stress : r.kind === 'workout' ? out.workouts : out.activity, r);
  }
  for (const i of await store.listBin()) add(out.bin, i);
  return out;
}

/** Puts a backup's deleted items back into the Recovery centre. Returns how many. */
export async function importD2Bin(account: string, b: unknown): Promise<number> {
  const items = typeof b === 'object' && b !== null && Array.isArray((b as D2Backup).bin) ? (b as D2Backup).bin ?? [] : [];
  store.useAccount(account);
  const good = items.filter((i) => typeof i?.id === 'string');
  await store.importBin(good);
  return good.length;
}

/** Puts a backup's data back on this device (same items are replaced); they upload at the next sync. Returns how many. */
export async function importD2(account: string, b: unknown): Promise<number> {
  if (typeof b !== 'object' || b === null || (b as D2Backup).v !== 1) return 0;
  const d = b as D2Backup;
  store.useAccount(account);
  const nights = Array.isArray(d.nights) ? d.nights.filter((n) => typeof n?.id === 'string').map((n) => ({ ...n, synced: false })) : [];
  const records = Array.isArray(d.records) ? d.records.filter((r) => typeof r?.key === 'string').map((r) => ({ ...r, synced: false })) : [];
  await store.saveNights(nights);
  await store.saveRecords(records);
  if (Array.isArray(d.downloads)) store.replaceDownloadLog(d.downloads);
  if (typeof d.watchAccount === 'string' && d.watchAccount) store.saveWatchAccount(d.watchAccount);
  return nights.length + records.length;
}

/** This user's nights and naps with their figures, for Synchronised Sleep Tracking. The stages run from falling asleep to waking up. */
export async function pairingSleep(account: string, user: number): Promise<PairingSleep[]> {
  store.useAccount(account);
  return (await store.listNights(user)).map((n) => {
    const f = figures(n), s = n.summary;
    return {
      id: n.id, start: f.shown.start, stages: f.shown.stages, nap: isNap(n), demo: n.source === 'demo', watch: n.watch, bedMs: f.bedMs, wokeMs: f.wokeMs,
      sleepMin: f.sleepMin, deepMin: f.deepMin, lightMin: f.lightMin, remMin: f.remMin, awakeMin: f.awakeMin, wakeups: f.wakeups,
      score: s.sleepScore, avgHR: s.avgHeartRate, avgHrv: s.avgHrv, avgSpo2: s.avgOxygenSaturation, avgBreath: s.avgBreathRate,
    };
  });
}

/** Deletes one of this user's watch nights or naps (to the Recovery centre, and from the other devices), as D2 Link History's ×. */
export async function deleteWatchNight(account: string, id: string): Promise<void> {
  store.useAccount(account);
  await store.deleteNight(id);
}

/** Ids this device has, per cloud table (to make the cloud match this device). */
export async function localD2Ids(account: string): Promise<{ nights: string[]; records: string[]; downloads: string[] }> {
  store.useAccount(account);
  return {
    nights: (await store.listAllNights()).filter((n) => n.source !== 'demo').map((n) => n.id),
    records: (await store.listAllRecords()).filter((r) => r.source !== 'demo').map((r) => r.key),
    downloads: store.loadDownloadLog().map(store.logId),
  };
}

/** Marks everything as not yet in the cloud, so the next sync uploads it (after the cloud copy was replaced). */
export async function markD2Unsynced(account: string): Promise<void> {
  store.useAccount(account);
  await store.saveNights((await store.listAllNights()).map((n) => ({ ...n, synced: false })));
  await store.saveRecords((await store.listAllRecords()).map((r) => ({ ...r, synced: false })));
  store.replaceDownloadLog(store.loadDownloadLog().map((e) => ({ ...e, synced: false })));
}

/** Blood pressure readings already downloaded to this device (e.g. by D2 Link), oldest first. */
export async function storedBloodPressure(account: string): Promise<{ at: number; systolic: number | null; diastolic: number | null; pulse: number | null }[]> {
  store.useAccount(account);
  return (await store.listAllRecords())
    .filter((r) => r.kind === 'reading' && r.data['cls'] === 10002)
    .map((r) => {
      const v = (r.data['values'] ?? {}) as Record<string, number>;
      return { at: r.start, systolic: v['2006'] ?? null, diastolic: v['2007'] ?? null, pulse: v['10002537'] ?? null };
    })
    .sort((a, b) => a.at - b.at);
}

export async function syncD2(account: string, client: CloudClient): Promise<void> {
  store.useAccount(account);
  await syncNights(client);
  await syncRecords(client);
}
