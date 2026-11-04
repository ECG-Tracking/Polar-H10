// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — its deleted items, as the app's Recovery centre page shows them.
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

import { READING_CLASSES } from './extra';
import { isNap } from './night';
import * as store from './store';
import type { D2BinItem, D2Night, D2Record } from './store';

export interface RecoveryRow { id: string; category: 'Watch D2 sleep' | 'Watch D2 data' | 'D2 Link download history'; user: number; recorded: number; deletedAt: number; what: string; length: number | null; detail: string; size: number; elsewhere: boolean }

const RECORD_NAMES: Readonly<Record<string, string>> = { activity: 'Activity', totals: 'Day totals', stress: 'Stress', workout: 'Workout' };

function recordName(r: D2Record): string {
  if (r.kind !== 'reading') return RECORD_NAMES[r.kind] ?? r.kind;
  return READING_CLASSES[Number(r.data['cls'])]?.name ?? 'Measurement';
}

export function describe(item: D2BinItem): RecoveryRow {
  const base = { id: item.id, user: item.user, deletedAt: item.deletedAt, size: JSON.stringify(item).length, elsewhere: item.elsewhere === true };
  if (item.night) return { ...base, category: 'Watch D2 sleep', what: isNap(item.night) ? 'Watch D2 nap' : 'Watch D2 night', recorded: item.night.start, length: item.night.stages.length * 60, detail: '' };
  if (item.record) return { ...base, category: 'Watch D2 data', what: recordName(item.record), recorded: item.record.start, length: null, detail: recordName(item.record) };
  return { ...base, category: 'D2 Link download history', what: 'Download', recorded: item.download?.at ?? item.deletedAt, length: null, detail: item.download?.result ?? '' };
}

export async function listRecovery(account: string): Promise<RecoveryRow[]> {
  store.useAccount(account);
  return (await store.listBin()).map(describe);
}

/** A night or nap as it is now, kept with a version of the synchronised sleep reports. */
export async function nightCopy(account: string, id: string): Promise<D2Night | undefined> {
  store.useAccount(account);
  return (await store.listAllNights()).find((n) => n.id === id);
}

/** The nights and naps waiting in the Recovery centre, by their own ids. */
export async function deletedNightIds(account: string): Promise<string[]> {
  store.useAccount(account);
  return (await store.listBin()).flatMap((i) => (i.night ? [i.night.id] : []));
}

export async function restoreRecovery(account: string, id: string): Promise<void> {
  store.useAccount(account);
  await store.restoreBin(id);
}

export async function purgeRecovery(account: string, id: string): Promise<void> {
  store.useAccount(account);
  await store.purgeBin(id);
}
