// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — syncs downloaded nights with the signed-in account's cloud copy (Supabase table d2_nights),
// so nights downloaded on one device (e.g. a phone) can be seen on the others; and the other numerical data from the
// watch (activity, measurements, stress, workouts) through the general table user_data, kinds 'd2-…'.
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

import { emptySummary, type D2Summary } from './sleepfile';
import { DROPPED_CLASSES } from './extra';
import { mergeMinutes, minutesOf } from './records';
import * as store from './store';
import type { D2Kind, D2Night, D2Record } from './store';

const TABLE = 'd2_nights';
const DATA_TABLE = 'user_data';
const PAGE = 1000;

// the parts of the Supabase client used here (OpenBeat ECG passes its signed-in client)
export interface CloudResult { data: unknown; error: { message: string; code?: string } | null }
interface Query extends PromiseLike<CloudResult> {
  in(column: string, values: readonly string[]): PromiseLike<CloudResult>;
  range(from: number, to: number): PromiseLike<CloudResult>;
}
export interface CloudClient {
  from(table: string): {
    select(columns: string): Query;
    upsert(row: Record<string, unknown> | Record<string, unknown>[]): PromiseLike<CloudResult>;
    delete(): { eq(column: string, value: string): PromiseLike<CloudResult>; like(column: string, pattern: string): PromiseLike<CloudResult> };
  };
}

export interface D2SyncResult { uploaded: number; downloaded: number; deleted: number }

export class CloudSetupError extends Error {}

function fail(e: { message: string; code?: string }): never {
  if (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|could not find the table/i.test(e.message)) {
    throw new CloudSetupError('The cloud has no table for D2 data yet. Run supabase/setup.sql once in Supabase (SQL Editor) to add it.');
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
    summary: s, source: 'd2', watch: typeof v['watch'] === 'string' ? v['watch'] : 'Watch D2',
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

// ---------- other watch data (table user_data) ----------

const cloudKind = (k: D2Kind): string => `d2-${k}`;

/** What goes into the cloud row: the record without its non-numerical part (`local`), which stays on this device. */
const recordPayload = (r: D2Record): Record<string, unknown> => ({ v: 1, kind: r.kind, id: r.id, user: r.user, start: r.start, data: r.data, watch: r.watch, downloadedAt: r.downloadedAt });

/** Checks a record that came from the network; null if it can't be used. */
export function parseCloudRecord(row: unknown): D2Record | null {
  if (typeof row !== 'object' || row === null) return null;
  const d = (row as Record<string, unknown>)['data'];
  if (typeof d !== 'object' || d === null) return null;
  const v = d as Record<string, unknown>;
  const kind = v['kind'], id = v['id'], user = v['user'], start = v['start'], data = v['data'];
  if (v['v'] !== 1 || !store.D2_KINDS.includes(kind as D2Kind) || typeof id !== 'string' || typeof start !== 'number' || typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const u = typeof user === 'number' && user >= 1 && user <= 9 ? user : 1;
  return {
    key: store.recordKey(kind as D2Kind, u, id), kind: kind as D2Kind, id, user: u, start, data: data as Record<string, unknown>, source: 'd2',
    watch: typeof v['watch'] === 'string' ? v['watch'] : 'Watch D2', downloadedAt: typeof v['downloadedAt'] === 'number' ? v['downloadedAt'] : 0, synced: true,
  };
}

/** Kinds no longer kept (ECG recordings, some measurements): removed here, and once per device from the cloud (all users of this account). */
async function dropOldKinds(client: CloudClient): Promise<number> {
  const old = (await store.listAllRecords()).filter((r) => store.DROPPED_KINDS.includes(r.kind) || (r.kind === 'reading' && DROPPED_CLASSES.includes(Number(r.data['cls']))));
  await store.deleteRecords(old.map((r) => r.key));
  if (!store.droppedKindsCleared()) {
    for (const cls of DROPPED_CLASSES) {
      const { error } = await client.from(DATA_TABLE).delete().like('id', `reading:%:${cls}-%`);
      if (error) fail(error);
    }
    for (const kind of store.DROPPED_KINDS) {
      const { error } = await client.from(DATA_TABLE).delete().eq('kind', cloudKind(kind as D2Kind));
      if (error) fail(error);
    }
    store.setDroppedKindsCleared();
  }
  return old.length;
}

/** One sync of the other watch data: the most recently downloaded copy of each record wins; activity days are merged. */
export async function syncRecords(client: CloudClient): Promise<D2SyncResult> {
  const result: D2SyncResult = { uploaded: 0, downloaded: 0, deleted: 0 };
  result.deleted += await dropOldKinds(client);
  // records deleted here: from the cloud too
  const stillPending: string[] = [];
  for (const key of store.pendingRecordDeletes()) {
    const { error } = await client.from(DATA_TABLE).delete().eq('id', key);
    if (error) stillPending.push(key);
  }
  store.setPendingRecordDeletes(stillPending);
  // the cloud answers at most 1000 rows at a time: read the list in pages
  const rows: unknown[] = [];
  for (let from = 0; ; from += PAGE) {
    const page = await client.from(DATA_TABLE).select('kind, id, saved_at').range(from, from + PAGE - 1);
    if (page.error) fail(page.error);
    const got = Array.isArray(page.data) ? page.data : [];
    rows.push(...got);
    if (got.length < PAGE) break;
  }
  const inCloud = new Map<string, number>();
  for (const r of rows) {
    const o = r as Record<string, unknown>;
    if (typeof o['kind'] === 'string' && o['kind'].startsWith('d2-') && typeof o['id'] === 'string' && typeof o['saved_at'] === 'number') inCloud.set(o['id'], o['saved_at']);
  }
  const local = (await store.listAllRecords()).filter((r) => r.source !== 'demo');
  const byKey = new Map(local.map((r) => [r.key, r]));

  const uploads: D2Record[] = [], fetch: string[] = [];
  for (const r of local) {
    const at = inCloud.get(r.key);
    if (at == null && r.synced) { await store.deleteRecordFromElsewhere(r); result.deleted++; continue; } // deleted on another device
    if (at == null || r.downloadedAt > at) uploads.push(r);
    else if (at > r.downloadedAt) fetch.push(r.key);
    else if (!r.synced) await store.saveRecords([{ ...r, synced: true }]);
  }
  for (const key of inCloud.keys()) if (!byKey.has(key) && !stillPending.includes(key)) fetch.push(key);

  for (let i = 0; i < uploads.length; i += 20) {
    const batch = uploads.slice(i, i + 20);
    const up = await client.from(DATA_TABLE).upsert(batch.map((r) => ({ kind: cloudKind(r.kind), id: r.key, data: recordPayload(r), saved_at: r.downloadedAt })));
    if (up.error) fail(up.error);
    await store.saveRecords(batch.map((r) => ({ ...r, synced: true })));
    result.uploaded += batch.length;
  }

  for (let i = 0; i < fetch.length; i += 20) {
    const res = await client.from(DATA_TABLE).select('id, data').in('id', fetch.slice(i, i + 20));
    if (res.error) fail(res.error);
    const got: D2Record[] = [];
    for (const c of (Array.isArray(res.data) ? res.data : []).map(parseCloudRecord)) {
      if (!c) continue;
      const mine = byKey.get(c.key);
      if (mine?.local) c.local = mine.local; // text from the watch stays with this device's copy
      if (c.kind === 'activity' && mine) { // keep minutes only this device has; upload the merged day next time
        const merged = mergeMinutes(minutesOf(mine), minutesOf(c));
        if (merged.length > minutesOf(c).length) Object.assign(c, { data: { ...c.data, minutes: merged }, downloadedAt: Date.now(), synced: false });
      }
      got.push(c);
    }
    await store.saveRecords(got);
    result.downloaded += got.length;
  }
  return result;
}
