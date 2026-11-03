// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — its part of OpenBeat ECG's account backup and restore, and a sync on request (Sync & backups).
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

import { syncNights, syncRecords, type CloudClient } from './cloud';
import * as store from './store';
import type { D2Night, D2Record, DownloadLogEntry } from './store';

/** What a backup holds from D2 Link. The watch pairing is left out (pair again after restoring on another device). */
export interface D2Backup { v: 1; nights: D2Night[]; records: D2Record[]; downloads: DownloadLogEntry[]; watchAccount: string }

export async function exportD2(account: string): Promise<D2Backup> {
  store.useAccount(account);
  return { v: 1, nights: await store.listAllNights(), records: await store.listAllRecords(), downloads: store.loadDownloadLog(), watchAccount: store.loadWatchAccount() };
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

export async function syncD2(account: string, client: CloudClient): Promise<void> {
  store.useAccount(account);
  await syncNights(client);
  await syncRecords(client);
}
