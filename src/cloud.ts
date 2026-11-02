// Cloud copy in Supabase (create it with supabase/setup.sql):
//   • ECG history: table ecg_sessions holds each recording's details and SUMMARY (results, heart-rate trend,
//     average beat, first 30 s, up to 50 event strips). The whole ECG is never uploaded.
//   • Sleep history: table sleep_nights holds each night's report outputs (numbers and graph data).
// Other devices get summary copies; the full ECG and raw sleep data stay on the device that recorded them.

import type { SupabaseClient } from '@supabase/supabase-js';
import * as store from './store';
import type { Session, SleepSession, UserEvent } from './store';
import { buildEcgSummary, buildSleepReport, parseEcgSummary, parseSleepReport } from './summary';
import { errorMessage } from './util';

const ECG_TABLE = 'ecg_sessions';
const SLEEP_TABLE = 'sleep_nights';

interface EcgRow {
  id: string;
  user_no: number;
  started_at: number;
  duration_s: number;
  fs: number;
  alias: string;
  source: Session['source'];
  user_events: UserEvent[];
}

interface SleepRow { id: string; user_no: number; started_at: number; duration_s: number; source: SleepSession['source'] }

type Obj = Record<string, unknown>;
const finiteNum = (r: Obj, k: string): number | null => (typeof r[k] === 'number' && Number.isFinite(r[k]) ? (r[k] as number) : null);

/** Checks an ECG row from the server before trusting it. */
export function parseRow(v: unknown): EcgRow | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Obj;
  const id = r['id'], alias = r['alias'], source = r['source'], events = r['user_events'];
  const userNo = finiteNum(r, 'user_no'), started = finiteNum(r, 'started_at'), dur = finiteNum(r, 'duration_s'), fs = finiteNum(r, 'fs');
  if (typeof id !== 'string' || userNo === null || started === null || dur === null || fs === null) return null;
  if (source !== 'polar' && source !== 'demo' && source !== 'import') return null;
  const userEvents = Array.isArray(events)
    ? events.flatMap((e): UserEvent[] => {
      const o = e as Obj;
      return typeof o['t'] === 'number' && typeof o['label'] === 'string' ? [{ t: o['t'], label: o['label'] }] : [];
    })
    : [];
  return { id, user_no: userNo, started_at: started, duration_s: dur, fs, alias: typeof alias === 'string' ? alias : '', source, user_events: userEvents };
}

export function parseSleepRow(v: unknown): SleepRow | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Obj;
  const id = r['id'], source = r['source'];
  const userNo = finiteNum(r, 'user_no'), started = finiteNum(r, 'started_at'), dur = finiteNum(r, 'duration_s');
  if (typeof id !== 'string' || userNo === null || started === null || dur === null) return null;
  if (source !== 'polar' && source !== 'demo') return null;
  return { id, user_no: userNo, started_at: started, duration_s: dur, source };
}

export interface SyncResult { ok: boolean; uploaded: number; downloaded: number; deleted: number; reason?: string }

/** Plain-language reason for a failed sync. */
function describe(err: unknown): string {
  const msg = errorMessage(err);
  if (/ecg_sessions|sleep_nights|could not find the table|schema cache|column .* does not exist/i.test(msg)) {
    return 'cloud storage isn’t set up yet (or is from an older version): run supabase/setup.sql in your Supabase project';
  }
  if (/failed to fetch|network|load failed/i.test(msg)) return 'no internet connection';
  return msg;
}

const userOf = (n: number): store.UserNumber => (store.isUserNumber(n) ? n : 1);

export class CloudSync extends EventTarget {
  private running: Promise<SyncResult> | null = null;
  private soon: ReturnType<typeof setTimeout> | null = null;
  lastResult: SyncResult | null = null;
  lastSyncAt: number | null = null;

  /** The client is signed in; Supabase's access rules limit every query to that account's own rows. */
  constructor(private readonly client: SupabaseClient) { super(); }

  /** Syncs a couple of seconds from now (batches several saves or deletes). */
  syncSoon(): void {
    if (this.soon) clearTimeout(this.soon);
    this.soon = setTimeout(() => { this.soon = null; void this.sync(); }, 2000);
  }

  /** One full sync; concurrent calls share the same run. Fires 'synced' when done and 'changed' if local data changed. */
  sync(): Promise<SyncResult> {
    this.running ??= this.run().finally(() => { this.running = null; });
    return this.running;
  }

  private async run(): Promise<SyncResult> {
    const result: SyncResult = { ok: true, uploaded: 0, downloaded: 0, deleted: 0 };
    try {
      await this.syncEcg(result);
      await this.syncSleep(result);
    } catch (err) {
      result.ok = false;
      result.reason = describe(err);
    }
    this.lastResult = result;
    if (result.ok) this.lastSyncAt = Date.now();
    this.dispatchEvent(new Event('synced'));
    if (result.downloaded || result.deleted) this.dispatchEvent(new Event('changed'));
    return result;
  }

  // ---------- ECG ----------

  private async syncEcg(result: SyncResult): Promise<void> {
    // 1. recordings deleted on this device: remove them from the cloud too
    const stillPending: string[] = [];
    for (const id of store.pendingCloudDeletes('ecg')) {
      const { error } = await this.client.from(ECG_TABLE).delete().eq('id', id);
      if (error) stillPending.push(id);
    }
    store.setPendingCloudDeletes(stillPending, 'ecg');

    // 2. what the cloud has (details only; summaries are fetched when needed)
    const { data, error } = await this.client.from(ECG_TABLE).select('id, user_no, started_at, duration_s, fs, alias, source, user_events');
    if (error) throw new Error(error.message);
    const rows = ((data as unknown[] | null) ?? []).map(parseRow).filter((r): r is EcgRow => r !== null);
    const inCloud = new Map(rows.map((r) => [r.id, r]));
    const local = await store.listAllSessions();
    const localIds = new Set(local.map((s) => s.id));
    const deleting = new Set(stillPending);

    // 3. this device's recordings
    for (const s of local) {
      if (inCloud.has(s.id)) {
        if (!s.synced) await store.updateSession({ ...s, synced: true });
        continue;
      }
      if (s.synced || s.cloudOnly) {
        // it was in the cloud before and is gone now: deleted on another device
        await store.deleteSession(s.id, { fromCloud: false });
        result.deleted++;
        continue;
      }
      const samples = await store.loadSignal(s.id);
      if (!samples) continue;
      const summary = buildEcgSummary(s, samples, store.loadSettings(store.sessionUser(s)));
      const ins = await this.client.from(ECG_TABLE).upsert({
        id: s.id, user_no: store.sessionUser(s), started_at: s.start, duration_s: s.durationS, fs: s.fs, alias: s.alias,
        source: s.source, user_events: s.userEvents, summary,
      });
      if (ins.error) throw new Error(ins.error.message);
      await store.updateSession({ ...s, synced: true });
      result.uploaded++;
    }

    // 4. recordings from other devices, as summary copies
    const missing = rows.filter((r) => !localIds.has(r.id) && !deleting.has(r.id));
    for (let i = 0; i < missing.length; i += 20) {
      const batch = missing.slice(i, i + 20);
      const res = await this.client.from(ECG_TABLE).select('id, summary').in('id', batch.map((b) => b.id));
      if (res.error) throw new Error(res.error.message);
      const byId = new Map(((res.data as unknown[] | null) ?? []).map((x) => [(x as Obj)['id'], (x as Obj)['summary']]));
      for (const r of batch) {
        const summary = parseEcgSummary(byId.get(r.id));
        if (!summary) continue; // damaged or from a newer app version: skip rather than show something wrong
        const m = summary.metrics;
        const session: Session = {
          id: r.id, user: userOf(r.user_no), start: r.started_at, durationS: r.duration_s, fs: r.fs, alias: r.alias,
          source: r.source, userEvents: r.user_events, summary: { meanHR: m.meanHR, hrvScore: m.hrvScore, eventCount: m.eventCount },
          synced: true, cloudOnly: true,
        };
        await store.saveSummaryCopy(session, summary);
        result.downloaded++;
      }
    }
  }

  // ---------- sleep ----------

  private async syncSleep(result: SyncResult): Promise<void> {
    const stillPending: string[] = [];
    for (const id of store.pendingCloudDeletes('sleep')) {
      const { error } = await this.client.from(SLEEP_TABLE).delete().eq('id', id);
      if (error) stillPending.push(id);
    }
    store.setPendingCloudDeletes(stillPending, 'sleep');

    const { data, error } = await this.client.from(SLEEP_TABLE).select('id, user_no, started_at, duration_s, source');
    if (error) throw new Error(error.message);
    const rows = ((data as unknown[] | null) ?? []).map(parseSleepRow).filter((r): r is SleepRow => r !== null);
    const inCloud = new Set(rows.map((r) => r.id));
    const local = await store.listAllSleeps();
    const localIds = new Set(local.map((s) => s.id));
    const deleting = new Set(stillPending);

    for (const n of local) {
      if (inCloud.has(n.id)) {
        if (!n.synced) await store.updateSleep({ ...n, synced: true });
        continue;
      }
      if (n.synced || n.cloudOnly) {
        await store.deleteSleep(n.id, { fromCloud: false });
        result.deleted++;
        continue;
      }
      const { signals } = await store.loadSleep(n.id);
      if (!signals) continue;
      const report = buildSleepReport({ durationS: n.durationS, ...signals });
      const ins = await this.client.from(SLEEP_TABLE).upsert({ id: n.id, user_no: n.user, started_at: n.start, duration_s: n.durationS, source: n.source, report });
      if (ins.error) throw new Error(ins.error.message);
      await store.updateSleep({ ...n, synced: true });
      result.uploaded++;
    }

    const missing = rows.filter((r) => !localIds.has(r.id) && !deleting.has(r.id));
    for (let i = 0; i < missing.length; i += 20) {
      const batch = missing.slice(i, i + 20);
      const res = await this.client.from(SLEEP_TABLE).select('id, report').in('id', batch.map((b) => b.id));
      if (res.error) throw new Error(res.error.message);
      const byId = new Map(((res.data as unknown[] | null) ?? []).map((x) => [(x as Obj)['id'], (x as Obj)['report']]));
      for (const r of batch) {
        const report = parseSleepReport(byId.get(r.id));
        if (!report) continue;
        const m = report.metrics;
        await store.saveSleepCopy({
          id: r.id, user: userOf(r.user_no), start: r.started_at, durationS: r.duration_s, source: r.source,
          summary: { sleepMin: m.sleepMin, score: m.score, awakenings: m.awakenings, avgHR: m.avgHR, avgHrv: m.avgHrv, breathingRate: m.breathingRate },
          synced: true, cloudOnly: true, report,
        });
        result.downloaded++;
      }
    }
  }
}
