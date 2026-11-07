// Cloud copy in Supabase (create it with supabase/setup.sql):
//   • ECG history: table ecg_sessions holds each recording's details and SUMMARY (results, heart-rate trend,
//     average beat, first 30 s, up to 50 event strips). The whole ECG is never uploaded.
//   • Sleep history: table sleep_nights holds each night's report outputs (numbers and graph data).
//   • Everything else: table user_data, one row per (kind, id) with the data as JSON, so new kinds need no new SQL.
//     Kind 'settings': each user's biodata and settings, id = user number; the most recently saved copy wins.
//     Kind 'tracking': each synchronised tracking with its beats and report versions, id = its id; the same rule.
//     Kind 'sleep-reports': each synchronised sleep's four reports with every version, id = its id; the same rule.
// Other devices get summary copies; the full ECG and raw sleep data stay on the device that recorded them.

import type { SupabaseClient } from '@supabase/supabase-js';
import * as store from './store';
import type { Session, Settings, SleepSession, UserEvent, UserNumber } from './store';
import { buildEcgSummary, buildSleepReport, parseEcgSummary, parseSleepReport, SUMMARY_LEVEL } from './summary';
import { SLEEP_METHOD } from './sleep';
import { mergeVersions, parseTrackingRow, planCloudCopies } from './synccompare';
import { forCloud, mergeSleepReports, parseSleepReportsRow } from './syncsleep';
import { errorMessage } from './util';

const ECG_TABLE = 'ecg_sessions';
const SLEEP_TABLE = 'sleep_nights';
const DATA_TABLE = 'user_data';

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

/** One user's settings on this device: `stored` is null when none were ever saved here; `at` 0 = saved before cloud sync. */
export interface LocalSettings { stored: Settings | null; at: number }
export interface CloudSettings { data: unknown; at: number }
export interface SettingsPlan { keep?: { settings: Settings; at: number }; upload?: { settings: Settings; at: number } }

/** Decides which copy of one user's settings wins: the most recently saved. Settings saved before sync existed
 *  count as oldest, but their entries fill in anything the cloud copy left at the default (e.g. height on one device). */
export function planSettings(local: LocalSettings, cloud: CloudSettings | null, now: number): SettingsPlan {
  if (!cloud) return local.stored ? { upload: { settings: local.stored, at: local.at || 1 } } : {};
  const fromCloud = store.parseSettings(cloud.data);
  if (cloud.at > local.at) {
    if (local.at === 0 && local.stored) {
      const merged = { ...fromCloud } as Record<keyof Settings, unknown>;
      for (const k of Object.keys(store.DEFAULT_SETTINGS) as (keyof Settings)[]) {
        if (fromCloud[k] === store.DEFAULT_SETTINGS[k] && local.stored[k] !== store.DEFAULT_SETTINGS[k]) merged[k] = local.stored[k];
      }
      const m = merged as unknown as Settings;
      if (JSON.stringify(m) !== JSON.stringify(fromCloud)) return { keep: { settings: m, at: now }, upload: { settings: m, at: now } };
    }
    return { keep: { settings: fromCloud, at: cloud.at } };
  }
  if (local.stored && local.at > cloud.at) return { upload: { settings: local.stored, at: local.at } };
  return {};
}

export interface SyncResult { ok: boolean; uploaded: number; downloaded: number; deleted: number; reason?: string }

/** Plain-language reason for a failed sync. */
function describe(err: unknown): string {
  const msg = errorMessage(err);
  // only a missing table or column means setup.sql hasn't been run; any other error is shown as it is
  if (/could not find the table|relation .* does not exist|column .* does not exist/i.test(msg)) {
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
      await this.syncSettings();
      await this.syncTracking(result);
      await this.syncSleepReports(result);
      await this.syncSleepLabels(result);
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

  // ---------- settings (table user_data, kind 'settings') ----------

  /** Fires 'settings' when a newer copy from another device replaced this device's. */
  private async syncSettings(): Promise<void> {
    const { data, error } = await this.client.from(DATA_TABLE).select('id, data, saved_at').eq('kind', 'settings');
    if (error) throw new Error(error.message);
    const inCloud = new Map<string, CloudSettings>();
    for (const row of (data as unknown[] | null) ?? []) {
      const r = row as Obj, at = finiteNum(r, 'saved_at');
      if (typeof r['id'] === 'string' && at !== null) inCloud.set(r['id'], { data: r['data'], at });
    }
    const uploads: { kind: string; id: string; data: Settings; saved_at: number }[] = [];
    let replaced = false;
    for (const u of store.USERS as readonly UserNumber[]) {
      const local = { stored: store.hasSavedSettings(u) ? store.loadSettings(u) : null, at: store.settingsSavedAt(u) };
      const plan = planSettings(local, inCloud.get(String(u)) ?? null, Date.now());
      if (plan.upload) uploads.push({ kind: 'settings', id: String(u), data: plan.upload.settings, saved_at: plan.upload.at });
      if (plan.keep) { store.saveSettings(u, plan.keep.settings, plan.keep.at); replaced = true; }
      else if (plan.upload && plan.upload.at !== local.at) store.saveSettings(u, plan.upload.settings, plan.upload.at);
    }
    if (uploads.length) {
      const ins = await this.client.from(DATA_TABLE).upsert(uploads);
      if (ins.error) throw new Error(ins.error.message);
    }
    if (replaced) this.dispatchEvent(new Event('settings'));
  }

  // ---------- synchronised tracking (table user_data, kind 'tracking') ----------

  private async syncTracking(result: SyncResult): Promise<void> {
    const stillPending: string[] = [];
    for (const id of store.pendingCloudDeletes('tracking')) {
      const { error } = await this.client.from(DATA_TABLE).delete().eq('kind', 'tracking').eq('id', id);
      if (error) stillPending.push(id);
    }
    store.setPendingCloudDeletes(stillPending, 'tracking');

    const { data, error } = await this.client.from(DATA_TABLE).select('id, saved_at').eq('kind', 'tracking');
    if (error) throw new Error(error.message);
    const inCloud = new Map<string, number>();
    for (const row of (data as unknown[] | null) ?? []) {
      const r = row as Obj, at = finiteNum(r, 'saved_at');
      if (typeof r['id'] === 'string' && at !== null) inCloud.set(r['id'], at);
    }
    const local = new Map(store.loadSyncHistory().map((e) => [e.id, e]));
    // a device with a limit that has reached it leaves the older trackings in the cloud
    const oldest = local.size >= store.trackingLimit() ? Math.min(...[...local.values()].map((e) => e.start)) : 0;
    const plan = planCloudCopies([...local.values()], inCloud, new Set(stillPending), (id) => Number(id.slice(1)) < oldest);

    for (const id of plan.removeHere) { await store.removeSyncEntry(id, { fromCloud: false }); result.deleted++; }
    for (const id of plan.markSynced) { const e = local.get(id); if (e) store.saveSyncEntry(e, { fromCloud: true }); }

    const cloudCopy = async (id: string): Promise<ReturnType<typeof parseTrackingRow>> => {
      const row = await this.client.from(DATA_TABLE).select('data').eq('kind', 'tracking').eq('id', id).maybeSingle();
      if (row.error) throw new Error(row.error.message);
      return parseTrackingRow((row.data as Obj | null)?.['data']);
    };
    for (const id of plan.download) {
      const copy = await cloudCopy(id);
      if (!copy) continue;
      const here = await store.loadSyncTrace(id);
      if (copy.trace) await store.saveSyncTrace({ ...copy.trace, reports: mergeVersions(here?.reports, copy.trace.reports) });
      store.saveSyncEntry({ ...copy.entry, savedAt: inCloud.get(id) ?? Date.now() }, { fromCloud: true });
      result.downloaded++;
    }
    for (const id of plan.upload) {
      const entry = local.get(id);
      if (!entry) continue;
      let trace = (await store.loadSyncTrace(id)) ?? null;
      if (inCloud.has(id)) { // another device may have added versions
        const reports = mergeVersions(trace?.reports, (await cloudCopy(id))?.trace?.reports);
        if (trace && reports.length) { trace = { ...trace, reports }; await store.saveSyncTrace(trace); }
      }
      const savedAt = entry.savedAt ?? Date.now();
      const { synced: _s, ...sent } = entry;
      const ins = await this.client.from(DATA_TABLE).upsert({ kind: 'tracking', id, data: { entry: { ...sent, savedAt }, trace }, saved_at: savedAt });
      if (ins.error) throw new Error(ins.error.message);
      store.saveSyncEntry({ ...entry, savedAt }, { fromCloud: true });
      result.uploaded++;
    }
  }

  // ---------- night or nap, and late starts (table user_data, kind 'sleep-label') ----------

  private async syncSleepLabels(result: SyncResult): Promise<void> {
    const kind = 'sleep-label';
    const { data, error } = await this.client.from(DATA_TABLE).select('id, data, saved_at').eq('kind', kind);
    if (error) throw new Error(error.message);
    const sleeps = new Map((await store.listAllSleeps()).map((s) => [s.id, s]));
    for (const row of (data as unknown[] | null) ?? []) {
      const r = row as Obj, at = finiteNum(r, 'saved_at'), s = sleeps.get(String(r['id']));
      if (at === null || !s || (s.labelAt ?? 0) >= at) continue;
      const { context: _c, onsetUnknown: _o, ...rest } = s;
      const v = (r['data'] ?? {}) as { context?: unknown; onsetUnknown?: unknown };
      const context = v.context === 'night' ? 'night' as const : v.context === 'nap' ? 'nap' as const : null;
      const updated: store.SleepSession = { ...rest, labelAt: at, ...(context ? { context } : {}), ...(v.onsetUnknown === true ? { onsetUnknown: true } : {}) };
      await store.updateSleep(updated);
      sleeps.set(s.id, updated);
      result.downloaded++;
    }
    const inCloud = new Map(((data as unknown[] | null) ?? []).map((row) => [String((row as Obj)['id']), finiteNum(row as Obj, 'saved_at') ?? 0]));
    for (const s of sleeps.values()) {
      if (s.labelAt == null || (inCloud.get(s.id) ?? 0) >= s.labelAt) continue;
      const ins = await this.client.from(DATA_TABLE).upsert({ kind, id: s.id, data: { context: s.context ?? null, onsetUnknown: s.onsetUnknown === true }, saved_at: s.labelAt });
      if (ins.error) throw new Error(ins.error.message);
      result.uploaded++;
    }
  }

  // ---------- synchronised sleep reports (table user_data, kind 'sleep-reports') ----------

  private async syncSleepReports(result: SyncResult): Promise<void> {
    const kind = 'sleep-reports';
    const stillPending: string[] = [];
    for (const id of store.pendingCloudDeletes(kind)) {
      const { error } = await this.client.from(DATA_TABLE).delete().eq('kind', kind).eq('id', id);
      if (error) stillPending.push(id);
    }
    store.setPendingCloudDeletes(stillPending, kind);

    const { data, error } = await this.client.from(DATA_TABLE).select('id, saved_at').eq('kind', kind);
    if (error) throw new Error(error.message);
    const inCloud = new Map<string, number>();
    for (const row of (data as unknown[] | null) ?? []) {
      const r = row as Obj, at = finiteNum(r, 'saved_at');
      if (typeof r['id'] === 'string' && at !== null) inCloud.set(r['id'], at);
    }
    const local = new Map((await store.listAllSleepReports()).map((r) => [r.id, r]));
    const plan = planCloudCopies([...local.values()], inCloud, new Set(stillPending));

    for (const id of plan.removeHere) { await store.deleteSleepReports(id, { fromCloud: false }); result.deleted++; }
    for (const id of plan.markSynced) { const r = local.get(id); if (r) await store.saveSleepReports(r, { fromCloud: true }); }

    const cloudCopy = async (id: string): Promise<ReturnType<typeof parseSleepReportsRow>> => {
      const row = await this.client.from(DATA_TABLE).select('data').eq('kind', kind).eq('id', id).maybeSingle();
      if (row.error) throw new Error(row.error.message);
      return parseSleepReportsRow((row.data as Obj | null)?.['data']);
    };
    for (const id of plan.download) {
      const copy = await cloudCopy(id);
      if (!copy) continue;
      const here = local.get(id);
      await store.saveSleepReports({ ...(here ? mergeSleepReports(copy, here) : copy), savedAt: inCloud.get(id) ?? Date.now() }, { fromCloud: true });
      result.downloaded++;
    }
    for (const id of plan.upload) {
      const here = local.get(id);
      if (!here) continue;
      const there = inCloud.has(id) ? await cloudCopy(id) : null; // another device may have added versions
      const savedAt = here.savedAt ?? Date.now();
      const merged = { ...(there ? mergeSleepReports(there, here) : here), savedAt };
      const ins = await this.client.from(DATA_TABLE).upsert({ kind, id, data: forCloud(merged), saved_at: savedAt });
      if (ins.error) throw new Error(ins.error.message);
      await store.saveSleepReports(merged, { fromCloud: true });
      result.uploaded++;
    }
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
    let upgraded = 0;
    for (const s of local) {
      if (inCloud.has(s.id)) {
        if (!s.synced) await store.updateSession({ ...s, synced: true });
        // a summary from before v1.38.0 gets its version ignoring Irregular Shape, from the device with the ECG; a few at a time
        if (!s.cloudOnly && (s.summaryLevel ?? 1) < SUMMARY_LEVEL && upgraded < 5) {
          const samples = await store.loadSignal(s.id);
          if (!samples) continue;
          upgraded++;
          await new Promise((r) => setTimeout(r, 0)); // keep the page responsive
          const summary = buildEcgSummary(s, samples, store.loadSettings(store.sessionUser(s)));
          const up = await this.client.from(ECG_TABLE).update({ summary }).eq('id', s.id);
          if (up.error) throw new Error(up.error.message);
          await store.updateSession({ ...s, synced: true, summaryLevel: SUMMARY_LEVEL });
        }
        continue;
      }
      if (s.synced) {
        // it was in the cloud before and is gone now: deleted on another device
        await store.deleteSession(s.id, { fromCloud: false });
        result.deleted++;
        continue;
      }
      // a summary copy not yet in the cloud came back from a backup or the Recovery centre: its summary goes up as it is
      const samples = await store.loadSignal(s.id);
      const summary = samples ? buildEcgSummary(s, samples, store.loadSettings(store.sessionUser(s))) : await store.loadSummaryCopy(s.id);
      if (summary == null) continue;
      const ins = await this.client.from(ECG_TABLE).upsert({
        id: s.id, user_no: store.sessionUser(s), started_at: s.start, duration_s: s.durationS, fs: s.fs, alias: s.alias,
        source: s.source, user_events: s.userEvents, summary,
      });
      if (ins.error) throw new Error(ins.error.message);
      await store.updateSession({ ...s, synced: true, ...(samples ? { summaryLevel: SUMMARY_LEVEL } : {}) });
      result.uploaded++;
    }

    // 3b. copies from before v1.38.0: fetched again once the device with the ECG has added the version ignoring Irregular Shape
    const old = local.filter((s) => s.cloudOnly && !s.ignoreShape && (s.summaryLevel ?? 1) < SUMMARY_LEVEL && inCloud.has(s.id));
    for (let i = 0; i < old.length; i += 20) {
      const batch = old.slice(i, i + 20);
      const has = await this.client.from(ECG_TABLE).select('id, zones:summary->noShape->metrics->zones').in('id', batch.map((b) => b.id));
      if (has.error) throw new Error(has.error.message);
      const ready = ((has.data as unknown[] | null) ?? []).flatMap((x) => (Array.isArray((x as Obj)['zones']) ? [String((x as Obj)['id'])] : []));
      if (!ready.length) continue;
      const res = await this.client.from(ECG_TABLE).select('id, summary').in('id', ready);
      if (res.error) throw new Error(res.error.message);
      for (const x of (res.data as unknown[] | null) ?? []) {
        const summary = parseEcgSummary((x as Obj)['summary']);
        const s = batch.find((b) => b.id === (x as Obj)['id']);
        if (!summary?.noShape || !s) continue;
        await store.saveSummaryCopy({ ...s, summaryLevel: SUMMARY_LEVEL }, summary);
      }
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
          synced: true, cloudOnly: true, ...(summary.noShape || summary.ignoreShape ? { summaryLevel: SUMMARY_LEVEL } : {}), ...(summary.sleepId ? { sleepId: summary.sleepId } : {}), ...(summary.syncTracking ? { syncTracking: true } : {}), ...(summary.ignoreShape ? { ignoreShape: true } : {}), ...(summary.derivedFrom ? { derivedFrom: summary.derivedFrom } : {}),
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

    const { data, error } = await this.client.from(SLEEP_TABLE).select('id, user_no, started_at, duration_s, source, reportAt:report->reportAt');
    if (error) throw new Error(error.message);
    const rows = ((data as unknown[] | null) ?? []).map(parseSleepRow).filter((r): r is SleepRow => r !== null);
    const inCloud = new Set(rows.map((r) => r.id));
    const local = await store.listAllSleeps();
    const localIds = new Set(local.map((s) => s.id));
    const deleting = new Set(stillPending);

    for (const n of local) {
      const outdated = !n.cloudOnly && ((n.sentMethod ?? 1) < SLEEP_METHOD || (n.labelAt ?? 0) > (n.sentLabelAt ?? 0));
      if (inCloud.has(n.id) && !outdated) {
        if (!n.synced) await store.updateSleep({ ...n, synced: true });
        continue;
      }
      if (n.synced && !inCloud.has(n.id)) {
        await store.deleteSleep(n.id, { fromCloud: false });
        result.deleted++;
        continue;
      }
      const { signals } = await store.loadSleep(n.id);
      const report = signals ? buildSleepReport({ durationS: n.durationS, ...signals }, n.ecgId, n.onsetUnknown === true) : n.report;
      if (report == null) continue;
      const ins = await this.client.from(SLEEP_TABLE).upsert({ id: n.id, user_no: n.user, started_at: n.start, duration_s: n.durationS, source: n.source, report });
      if (ins.error) throw new Error(ins.error.message);
      await store.updateSleep({ ...n, synced: true, sentMethod: SLEEP_METHOD, ...(n.labelAt == null ? {} : { sentLabelAt: n.labelAt }) });
      result.uploaded++;
    }

    // a newer report from the device with the raw recording replaces this device's copy
    const reportAt = new Map(((data as unknown[] | null) ?? []).map((x) => [(x as Obj)['id'], Number((x as Obj)['reportAt'] ?? 0)]));
    for (const n of local.filter((s) => s.cloudOnly && Number(reportAt.get(s.id) ?? 0) > ((s.report as { reportAt?: number } | undefined)?.reportAt ?? 0))) {
      const res = await this.client.from(SLEEP_TABLE).select('report').eq('id', n.id).maybeSingle();
      if (res.error) throw new Error(res.error.message);
      const report = parseSleepReport((res.data as Obj | null)?.['report']);
      if (!report) continue;
      const m = report.metrics;
      await store.updateSleep({ ...n, report, summary: { sleepMin: m.sleepMin, score: m.score, awakenings: m.awakenings, avgHR: m.avgHR, avgHrv: m.avgHrv, breathingRate: m.breathingRate } });
      result.downloaded++;
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
          synced: true, cloudOnly: true, report, ...(report.ecgId ? { ecgId: report.ecgId } : {}),
        });
        result.downloaded++;
      }
    }
  }
}
