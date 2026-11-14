// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — nights and other data downloaded from the watch, and the pairing, kept on this device (per signed-in account).
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

import type { Pairing } from './link';
import type { D2NightData, D2Summary } from './sleepfile';

export interface D2Night {
  id: string;
  user: number;
  /** Start of the stage list, ms since 1970. */
  start: number;
  stages: number[]; // watch stage code per minute
  summary: D2Summary;
  source: 'd2' | 'demo';
  watch: string;
  downloadedAt: number;
  /** In the account's cloud copy (D2 Link syncs nights between devices). */
  synced?: boolean;
}

export function nightFromData(d: D2NightData, user: number, watch: string): D2Night {
  return { id: `d2-${d.start}`, user, start: d.start * 1000, stages: d.stages, summary: d.summary, source: 'd2', watch, downloadedAt: Date.now() };
}

/** Kinds of data besides sleep (see extra.ts). */
export type D2Kind = 'activity' | 'totals' | 'reading' | 'stress' | 'workout';
export const D2_KINDS: readonly D2Kind[] = ['activity', 'totals', 'reading', 'stress', 'workout'];
/** Kinds no longer downloaded; stored ones are deleted (ECG recordings, from v1.4.1). */
export const DROPPED_KINDS: readonly string[] = ['ecg'];

/**
 * One record of other watch data. `data` holds its numbers; `local` holds the text the watch sent. Both sync to the cloud.
 */
export interface D2Record {
  key: string; // `${kind}:${user}:${id}`
  kind: D2Kind;
  id: string; // e.g. the day (activity), or the start time
  user: number;
  start: number; // ms since 1970
  data: Record<string, unknown>;
  local?: Record<string, unknown>;
  textSynced?: boolean; // its text is in the cloud too (kept back before v1.25.0)
  source: 'd2' | 'demo';
  watch: string;
  downloadedAt: number;
  synced?: boolean;
}

export const recordKey = (kind: D2Kind, user: number, id: string): string => `${kind}:${user}:${id}`;

let account = 'local';
let dbPromise: Promise<IDBDatabase> | null = null;

export function useAccount(id: string): void {
  if (id === account) return;
  account = id;
  dbPromise = null;
}

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(`d2link-${account}`, 3);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('nights')) req.result.createObjectStore('nights', { keyPath: 'id' });
      if (!req.result.objectStoreNames.contains('records')) req.result.createObjectStore('records', { keyPath: 'key' });
      if (!req.result.objectStoreNames.contains('bin')) req.result.createObjectStore('bin', { keyPath: 'id' }); // the Recovery centre
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('could not open storage'));
  });
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void, name: 'nights' | 'records' | 'bin' = 'nights'): Promise<T | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(name, mode);
    const r = fn(t.objectStore(name));
    t.oncomplete = () => resolve(r ? r.result : undefined);
    t.onerror = () => reject(t.error ?? new Error('storage error'));
    t.onabort = () => reject(t.error ?? new Error('storage error'));
  });
}

/** A copy of something deleted, kept for the Recovery centre until it is deleted permanently. */
export interface D2BinItem {
  id: string;
  user: number;
  deletedAt: number;
  elsewhere?: boolean; // deleted on another device
  night?: D2Night;
  record?: D2Record;
  download?: DownloadLogEntry;
}

/** Keeps a copy; if the device's storage is full the item is still deleted, so space can be freed. */
async function keepInBin(item: D2BinItem): Promise<void> {
  try { await tx('readwrite', (s) => { s.put(item); }, 'bin'); } catch { /* not kept */ }
}

export async function listBin(): Promise<D2BinItem[]> {
  return (await tx<D2BinItem[]>('readonly', (s) => s.getAll() as IDBRequest<D2BinItem[]>, 'bin')) ?? [];
}

export async function importBin(items: readonly D2BinItem[]): Promise<void> {
  if (items.length) await tx('readwrite', (s) => { for (const i of items) s.put(i); }, 'bin');
}

export async function purgeBin(id: string): Promise<void> {
  await tx('readwrite', (s) => { s.delete(id); }, 'bin');
}

/** Puts an item back; never marked as synced, so the next sync uploads it. Then removes it from the Recovery centre. */
export async function restoreBin(id: string): Promise<void> {
  const item = await tx<D2BinItem | undefined>('readonly', (s) => s.get(id) as IDBRequest<D2BinItem | undefined>, 'bin');
  if (!item) return;
  if (item.night) {
    setPendingCloudDeletes(pendingCloudDeletes().filter((x) => x !== item.night?.id));
    await saveNights([{ ...item.night, synced: false }]);
  }
  if (item.record) {
    setPendingRecordDeletes(pendingRecordDeletes().filter((x) => x !== item.record?.key));
    await saveRecords([{ ...item.record, synced: false }]);
  }
  if (item.download) {
    const { synced: _s, ...back } = item.download; // not synced, so the next sync uploads it again
    setPendingLogDeletes(pendingLogDeletes().filter((x) => x !== logId(back)));
    replaceDownloadLog([...loadDownloadLog().filter((e) => e.at !== back.at), back].sort((a, b) => b.at - a.at));
  }
  await purgeBin(id);
}

export async function saveNights(nights: D2Night[]): Promise<void> {
  await tx('readwrite', (s) => { for (const n of nights) s.put(n); });
}

export async function listAllNights(): Promise<D2Night[]> {
  return (await tx<D2Night[]>('readonly', (s) => s.getAll() as IDBRequest<D2Night[]>)) ?? [];
}

export async function listNights(user: number): Promise<D2Night[]> {
  return (await listAllNights()).filter((n) => n.user === user).sort((a, b) => b.start - a.start);
}

/** Deletes a night here; `fromCloud` also removes it from the cloud at the next sync (and so from other devices). */
export async function deleteNight(id: string, { fromCloud = true }: { fromCloud?: boolean } = {}): Promise<void> {
  const existing = (await listAllNights()).find((n) => n.id === id);
  if (fromCloud && existing?.synced) setPendingCloudDeletes([...new Set([...pendingCloudDeletes(), id])]);
  if (existing) await keepInBin({ id: `night:${id}`, user: existing.user, deletedAt: Date.now(), night: existing, ...(fromCloud ? {} : { elsewhere: true }) });
  await tx('readwrite', (s) => { s.delete(id); });
}

export async function saveRecords(records: D2Record[]): Promise<void> {
  await tx('readwrite', (s) => { for (const r of records) s.put(r); }, 'records');
}

export async function deleteRecords(keys: readonly string[]): Promise<void> {
  if (keys.length) await tx('readwrite', (s) => { for (const k of keys) s.delete(k); }, 'records');
}

const recordTombstoneKey = (): string => `d2link-deleted-records-${account}`;

/** Records deleted here that the next sync removes from the cloud (and so from the other devices). */
export function pendingRecordDeletes(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(recordTombstoneKey()) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

export function setPendingRecordDeletes(keys: readonly string[]): void {
  try { localStorage.setItem(recordTombstoneKey(), JSON.stringify(keys)); } catch { /* storage unavailable */ }
}

/** Deletes a record here, and at the next sync from the cloud if it was there. */
export async function deleteRecord(r: D2Record): Promise<void> {
  if (r.synced) setPendingRecordDeletes([...new Set([...pendingRecordDeletes(), r.key])]);
  await keepInBin({ id: `record:${r.key}`, user: r.user, deletedAt: Date.now(), record: r });
  await deleteRecords([r.key]);
}

/** A record that was deleted on another device goes from here too, with a copy kept. */
export async function deleteRecordFromElsewhere(r: D2Record): Promise<void> {
  await keepInBin({ id: `record:${r.key}`, user: r.user, deletedAt: Date.now(), record: r, elsewhere: true });
  await deleteRecords([r.key]);
}

export async function listAllRecords(): Promise<D2Record[]> {
  return (await tx<D2Record[]>('readonly', (s) => s.getAll() as IDBRequest<D2Record[]>, 'records')) ?? [];
}

export async function listRecords(user: number, kind?: D2Kind): Promise<D2Record[]> {
  return (await listAllRecords()).filter((r) => r.user === user && (!kind || r.kind === kind)).sort((a, b) => b.start - a.start);
}

const tombstoneKey = (): string => `d2link-deleted-${account}`;

export function pendingCloudDeletes(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(tombstoneKey()) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

export function setPendingCloudDeletes(ids: readonly string[]): void {
  try { localStorage.setItem(tombstoneKey(), JSON.stringify(ids)); } catch { /* storage unavailable */ }
}

const droppedKey = (): string => `d2link-dropped-kinds-2-${account}`;
/** Whether this device already removed the dropped measurement kinds from the cloud. */
export function droppedKindsCleared(): boolean {
  try { return localStorage.getItem(droppedKey()) === '1'; } catch { return false; }
}
export function setDroppedKindsCleared(): void {
  try { localStorage.setItem(droppedKey(), '1'); } catch { /* storage unavailable */ }
}

const watchAccountKey = (): string => `d2link-watch-account-${account}`;

/** The ID of the account the watch belongs to in its phone app (digits only), if the user entered it; this device only. */
export function loadWatchAccount(): string {
  try { return localStorage.getItem(watchAccountKey()) ?? ''; } catch { return ''; }
}

export function saveWatchAccount(id: string): void {
  try {
    if (id) localStorage.setItem(watchAccountKey(), id);
    else localStorage.removeItem(watchAccountKey());
  } catch { /* storage unavailable */ }
}

// ---------- download history ----------

/** One kind of data in a download: how many were saved, or null with a note when it wasn't downloaded. */
export interface DownloadLogItem { what: string; count: number | null; note?: string; nil?: number } // nil: how many were identical to what is stored
export interface DownloadLogEntry {
  at: number; // when the download started, ms since 1970
  user: number;
  button: 'sleep' | 'all' | 'ecg' | 'bp';
  via: string; // how the watch was reached
  from: number; to: number; // the period asked for, ms since 1970
  watch: string;
  items: DownloadLogItem[];
  ok: boolean;
  result: string; // "Done", or why it stopped
  synced?: boolean; // in the account's cloud copy
}

const logKey = (): string => `d2link-downloads-${account}`;
const MAX_LOG = 300;

/** A computer keeps the whole history, a phone or tablet the latest 300; the app's Storage section can change it (see store.ts there). */
export function downloadLimit(): number {
  try {
    const v = localStorage.getItem('openbeat-keep-all');
    const all = v != null ? v === '1' : !/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) && navigator.maxTouchPoints < 2;
    return all ? Infinity : MAX_LOG;
  } catch { return MAX_LOG; }
}

/** Saves the history. If the browser's space is full, the oldest entries already in the cloud make room. */
function saveLog(list: readonly DownloadLogEntry[]): void {
  const left = [...list];
  for (;;) {
    try { localStorage.setItem(logKey(), JSON.stringify(left)); return; } catch { /* full, or storage unavailable */ }
    const i = left.map((e) => e.synced).lastIndexOf(true);
    if (i < 0) return;
    left.splice(i, 1);
  }
}

export function loadDownloadLog(): DownloadLogEntry[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(logKey()) ?? '[]');
    return Array.isArray(v) ? v.filter((e): e is DownloadLogEntry => typeof e === 'object' && e !== null && typeof (e as DownloadLogEntry).at === 'number' && Array.isArray((e as DownloadLogEntry).items)) : [];
  } catch { return []; }
}

/** Replaces the whole download history (restoring a backup). */
export function replaceDownloadLog(entries: readonly DownloadLogEntry[]): void {
  saveLog(entries.slice(0, downloadLimit()));
}

const logDeletesKey = (): string => `d2link-download-deletes-${account}`;

/** Downloads deleted here that the cloud still has; removed there on the next sync. */
export function pendingLogDeletes(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(logDeletesKey()) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

export function setPendingLogDeletes(ids: readonly string[]): void {
  try { localStorage.setItem(logDeletesKey(), JSON.stringify(ids)); } catch { /* storage unavailable */ }
}

/** The cloud's name for a download in the history. */
export const logId = (e: Pick<DownloadLogEntry, 'user' | 'at'>): string => `log:${e.user}:${e.at}`;

/** The history as it should be: newest first. */
export function saveDownloadLog(entries: readonly DownloadLogEntry[]): void {
  replaceDownloadLog([...entries].sort((a, b) => b.at - a.at));
}

export async function removeDownloadLog(at: number, { fromCloud = true }: { fromCloud?: boolean } = {}): Promise<void> {
  const entry = loadDownloadLog().find((e) => e.at === at);
  if (fromCloud && entry?.synced) setPendingLogDeletes([...new Set([...pendingLogDeletes(), logId(entry)])]);
  if (entry) await keepInBin({ id: `download:${at}`, user: entry.user, deletedAt: Date.now(), download: entry });
  try { localStorage.setItem(logKey(), JSON.stringify(loadDownloadLog().filter((e) => e.at !== at))); } catch { /* storage unavailable */ }
}

/** A failed connection or a download that stopped before getting anything: not worth a line in the history. */
export const nothingCameBack = (e: Pick<DownloadLogEntry, 'ok' | 'items'>): boolean => !e.ok && !e.items.some((i) => (i.count ?? 0) > 0);

/** Lines recorded before such failures were left out go to the Recovery centre, here and on other devices. */
export async function dropFailedDownloads(): Promise<number> {
  const failed = loadDownloadLog().filter(nothingCameBack);
  for (const e of failed) await removeDownloadLog(e.at);
  return failed.length;
}

/** Adds a download, newest first. */
export function addDownloadLog(e: DownloadLogEntry): void {
  saveLog([e, ...loadDownloadLog()].slice(0, downloadLimit()));
}

const pairingKey = (): string => `d2link-pairing-${account}`;

export function loadPairing(): Pairing | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(pairingKey()) ?? 'null');
    if (typeof v === 'object' && v !== null && typeof (v as Pairing).authId === 'string' && typeof (v as Pairing).authToken === 'string') return v as Pairing;
  } catch { /* none */ }
  return null;
}

export function savePairing(p: Pairing | null): void {
  try {
    if (p) localStorage.setItem(pairingKey(), JSON.stringify(p));
    else localStorage.removeItem(pairingKey());
  } catch { /* storage unavailable */ }
}
