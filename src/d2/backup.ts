// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — its part of OpenBeat ECG's account backup and restore, and a sync on request (Sync & backups).
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

import { syncNights, syncRecords, type CloudClient } from './cloud';
import * as store from './store';
import type { D2BinItem, D2Night, D2Record, DownloadLogEntry } from './store';

/**
 * What a backup holds from D2 Link. Left out: the watch pairing (pair again after restoring on another device) and the
 * watch account ID (enter it again in D2 Link); `watchAccount` is only read from backups made before it was left out.
 */
export interface D2Backup { v: 1; nights: D2Night[]; records: D2Record[]; downloads: DownloadLogEntry[]; watchAccount?: string; bin?: D2BinItem[] }

/** `withBin` adds the deleted items kept for the Recovery centre (a backup has them, a comparison file doesn't). */
export async function exportD2(account: string, withBin = false): Promise<D2Backup> {
  store.useAccount(account);
  return { v: 1, nights: await store.listAllNights(), records: await store.listAllRecords(), downloads: store.loadDownloadLog(), ...(withBin ? { bin: await store.listBin() } : {}) };
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

/** Ids this device has, per cloud table (to make the cloud match this device). */
export async function localD2Ids(account: string): Promise<{ nights: string[]; records: string[] }> {
  store.useAccount(account);
  return {
    nights: (await store.listAllNights()).filter((n) => n.source !== 'demo').map((n) => n.id),
    records: (await store.listAllRecords()).filter((r) => r.source !== 'demo').map((r) => r.key),
  };
}

/** Marks everything as not yet in the cloud, so the next sync uploads it (after the cloud copy was replaced). */
export async function markD2Unsynced(account: string): Promise<void> {
  store.useAccount(account);
  await store.saveNights((await store.listAllNights()).map((n) => ({ ...n, synced: false })));
  await store.saveRecords((await store.listAllRecords()).map((r) => ({ ...r, synced: false })));
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
