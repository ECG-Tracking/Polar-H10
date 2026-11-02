// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — nights downloaded from the watch and the pairing, kept on this device only (per signed-in account).
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
}

export function nightFromData(d: D2NightData, user: number, watch: string): D2Night {
  return { id: `d2-${d.start}`, user, start: d.start * 1000, stages: d.stages, summary: d.summary, source: 'd2', watch, downloadedAt: Date.now() };
}

let account = 'local';
let dbPromise: Promise<IDBDatabase> | null = null;

export function useAccount(id: string): void {
  if (id === account) return;
  account = id;
  dbPromise = null;
}

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(`d2link-${account}`, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('nights')) req.result.createObjectStore('nights', { keyPath: 'id' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('could not open storage'));
  });
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction('nights', mode);
    const r = fn(t.objectStore('nights'));
    t.oncomplete = () => resolve(r ? r.result : undefined);
    t.onerror = () => reject(t.error ?? new Error('storage error'));
  });
}

export async function saveNights(nights: D2Night[]): Promise<void> {
  await tx('readwrite', (s) => { for (const n of nights) s.put(n); });
}

export async function listNights(user: number): Promise<D2Night[]> {
  const all = ((await tx<D2Night[]>('readonly', (s) => s.getAll() as IDBRequest<D2Night[]>)) ?? []);
  return all.filter((n) => n.user === user).sort((a, b) => b.start - a.start);
}

export async function deleteNight(id: string): Promise<void> {
  await tx('readwrite', (s) => { s.delete(id); });
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
