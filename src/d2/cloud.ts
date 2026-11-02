// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — syncs downloaded nights with the signed-in account's cloud copy (Supabase table d2_nights),
// so nights downloaded on one device (e.g. a phone) can be seen on the others.
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

import { emptySummary, type D2Summary } from './sleepfile';
import * as store from './store';
import type { D2Night } from './store';

const TABLE = 'd2_nights';

// the parts of the Supabase client used here (OpenBeat ECG passes its signed-in client)
export interface CloudResult { data: unknown; error: { message: string; code?: string } | null }
interface Query extends PromiseLike<CloudResult> { in(column: string, values: readonly string[]): PromiseLike<CloudResult> }
export interface CloudClient {
  from(table: string): {
    select(columns: string): Query;
    upsert(row: Record<string, unknown>): PromiseLike<CloudResult>;
    delete(): { eq(column: string, value: string): PromiseLike<CloudResult> };
  };
}

export interface D2SyncResult { uploaded: number; downloaded: number; deleted: number }

export class CloudSetupError extends Error {}

function fail(e: { message: string; code?: string }): never {
  if (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|could not find the table/i.test(e.message)) {
    throw new CloudSetupError('The cloud has no table for D2 nights yet. Run supabase/setup.sql once in Supabase (SQL Editor) to add it.');
  }
  if (e.code === '42501' || /permission denied/i.test(e.message)) {
    throw new CloudSetupError('The cloud refused access to D2 nights. Run supabase/setup.sql again in Supabase (SQL Editor).');
  }
  throw new Error(e.message);
}

/** What goes into the cloud row's `night` column. */
const payload = (n: D2Night): Record<string, unknown> => ({ v: 1, start: n.start, stages: n.stages, summary: n.summary, watch: n.watch, downloadedAt: n.downloadedAt });

/** Checks a night that came from the network; null if it can't be used. */
export function parseCloudNight(row: unknown): D2Night | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;
  const night = r['night'];
  if (typeof r['id'] !== 'string' || typeof night !== 'object' || night === null) return null;
  const v = night as Record<string, unknown>;
  const stages = v['stages'], summary = v['summary'];
  if (v['v'] !== 1 || typeof v['start'] !== 'number' || !Array.isArray(stages) || typeof summary !== 'object' || summary === null) return null;
  const s = emptySummary();
  for (const k of Object.keys(s) as (keyof D2Summary)[]) {
    const x = (summary as Record<string, unknown>)[k];
    s[k] = typeof x === 'number' && Number.isFinite(x) ? x : null;
  }
  const user = typeof r['user_no'] === 'number' && r['user_no'] >= 1 && r['user_no'] <= 9 ? r['user_no'] : 1;
  return {
    id: r['id'], user, start: v['start'],
    stages: stages.filter((x): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < 16),
    summary: s, source: 'd2', watch: typeof v['watch'] === 'string' ? v['watch'] : 'Huawei Watch D2',
    downloadedAt: typeof v['downloadedAt'] === 'number' ? v['downloadedAt'] : 0, synced: true,
  };
}

/**
 * One sync: removes nights deleted here from the cloud, uploads new nights, downloads nights from other devices,
 * and removes nights that were deleted on another device. Demo nights stay on this device.
 */
export async function syncNights(client: CloudClient): Promise<D2SyncResult> {
  const result: D2SyncResult = { uploaded: 0, downloaded: 0, deleted: 0 };
  const stillPending: string[] = [];
  for (const id of store.pendingCloudDeletes()) {
    const { error } = await client.from(TABLE).delete().eq('id', id);
    if (error) stillPending.push(id);
  }
  store.setPendingCloudDeletes(stillPending);

  const list = await client.from(TABLE).select('id');
  if (list.error) fail(list.error);
  const inCloud = new Set((Array.isArray(list.data) ? list.data : []).flatMap((r: unknown) => {
    const id = typeof r === 'object' && r !== null ? (r as Record<string, unknown>)['id'] : null;
    return typeof id === 'string' ? [id] : [];
  }));
  const local = await store.listAllNights();
  const localIds = new Set(local.map((n) => n.id));

  for (const n of local) {
    if (n.source === 'demo') continue;
    if (inCloud.has(n.id)) {
      if (!n.synced) await store.saveNights([{ ...n, synced: true }]);
      continue;
    }
    if (n.synced) { // was in the cloud and is gone: deleted on another device
      await store.deleteNight(n.id, { fromCloud: false });
      result.deleted++;
      continue;
    }
    const up = await client.from(TABLE).upsert({ id: n.id, user_no: n.user, started_at: n.start, night: payload(n) });
    if (up.error) fail(up.error);
    await store.saveNights([{ ...n, synced: true }]);
    result.uploaded++;
  }

  const missing = [...inCloud].filter((id) => !localIds.has(id) && !stillPending.includes(id));
  for (let i = 0; i < missing.length; i += 20) {
    const res = await client.from(TABLE).select('id, user_no, night').in('id', missing.slice(i, i + 20));
    if (res.error) fail(res.error);
    const nights = (Array.isArray(res.data) ? res.data : []).map(parseCloudNight).filter((n): n is D2Night => n !== null);
    await store.saveNights(nights);
    result.downloaded += nights.length;
  }
  return result;
}
