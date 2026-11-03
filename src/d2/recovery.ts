// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — its deleted items, as the app's Recovery centre page shows them.
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

import { clock, dayLabel } from './dom';
import { READING_CLASSES } from './extra';
import * as store from './store';
import type { D2BinItem, D2Record } from './store';

export interface RecoveryRow { id: string; category: 'Watch D2 nights' | 'Watch D2 data' | 'D2 Link download history'; user: number; deletedAt: number; what: string; detail: string; size: number; elsewhere: boolean }

const RECORD_NAMES: Readonly<Record<string, string>> = { activity: 'Activity', totals: 'Day totals', stress: 'Stress', workout: 'Workout' };

function recordName(r: D2Record): string {
  if (r.kind !== 'reading') return RECORD_NAMES[r.kind] ?? r.kind;
  return READING_CLASSES[Number(r.data['cls'])]?.name ?? 'Measurement';
}

const when = (ms: number): string => `${dayLabel(ms)} ${clock(ms)}`;

export function describe(item: D2BinItem): RecoveryRow {
  const base = { id: item.id, user: item.user, deletedAt: item.deletedAt, size: JSON.stringify(item).length, elsewhere: item.elsewhere === true };
  if (item.night) return { ...base, category: 'Watch D2 nights', what: 'Watch D2 night', detail: when(item.night.start) };
  if (item.record) return { ...base, category: 'Watch D2 data', what: recordName(item.record), detail: item.record.kind === 'activity' ? dayLabel(item.record.start) : when(item.record.start) };
  return { ...base, category: 'D2 Link download history', what: 'Download', detail: item.download ? `${when(item.download.at)} · ${item.download.result}` : '' };
}

export async function listRecovery(account: string): Promise<RecoveryRow[]> {
  store.useAccount(account);
  return (await store.listBin()).map(describe);
}

export async function restoreRecovery(account: string, id: string): Promise<void> {
  store.useAccount(account);
  await store.restoreBin(id);
}

export async function purgeRecovery(account: string, id: string): Promise<void> {
  store.useAccount(account);
  await store.purgeBin(id);
}
