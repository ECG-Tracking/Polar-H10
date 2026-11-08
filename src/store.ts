// Local persistence: sessions in IndexedDB, settings in localStorage. Cloud copies are made by cloud.ts.

import type { SavedSleepReports } from './syncsleep';
import type { RecordingPart } from './sleep';
import type { SyncTrace } from './synccompare';

// ---------- Accounts ----------
// Each signed-in account keeps its own database and settings on the device. The first account to sign in
// on a device takes over what was stored before accounts existed (the un-prefixed names); later accounts
// get names of their own, so one account never sees another's recordings.

const ACCOUNTS_KEY = 'ecg-analysis-accounts';
let dbName = 'ecg-analysis';
let keyPrefix = '';

/** Switches storage to this account's database and settings. Call before reading anything. */
export function useAccount(accountId: string): void {
  let map: Record<string, string> = {};
  try { map = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) ?? '{}') as Record<string, string>; } catch { /* unreadable: start fresh */ }
  let ns = map[accountId];
  if (ns === undefined) {
    ns = Object.keys(map).length === 0 ? '' : accountId;
    map[accountId] = ns;
    try { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(map)); } catch { /* private mode */ }
  }
  dbName = ns ? `ecg-analysis-${ns}` : 'ecg-analysis';
  keyPrefix = ns ? `${ns}:` : '';
  dbPromise = null;
}

export interface UserEvent { t: number; label: string }

export interface SessionSummary {
  meanHR: number; hrvScore: number; eventCount: number;
  trend?: Record<string, number>; // the report's figures, for the trend graphs
}

// ---------- Users ----------

/** Up to nine people can share the app; each has their own history and settings. */
export const USERS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export type UserNumber = (typeof USERS)[number];

export function isUserNumber(v: unknown): v is UserNumber {
  return typeof v === 'number' && (USERS as readonly number[]).includes(v);
}

/** Recordings made before users existed belong to User 1. */
export function sessionUser(s: Pick<Session, 'user'>): UserNumber {
  return isUserNumber(s.user) ? s.user : 1;
}

const currentUserKey = (): string => `${keyPrefix}ecg-analysis-user`;

export function loadCurrentUser(): UserNumber {
  try {
    const v = Number(localStorage.getItem(currentUserKey()));
    return isUserNumber(v) ? v : 1;
  } catch {
    return 1;
  }
}

export function saveCurrentUser(user: UserNumber): void {
  try { localStorage.setItem(currentUserKey(), String(user)); } catch { /* private mode */ }
}

export interface Session {
  id: string;
  user?: UserNumber; // missing on recordings made before users existed (= User 1)
  start: number; // epoch ms
  durationS: number;
  fs: number;
  alias: string;
  source: 'polar' | 'demo' | 'import' | 'watch'; // 'watch': a 30-second ECG from the Watch D2
  userEvents: UserEvent[];
  summary: SessionSummary | null;
  synced?: boolean; // its summary is in the account's cloud copy
  cloudOnly?: boolean; // a summary copy from another device: no signal on this device
  sleepId?: string; // recorded together with this sleep night
  syncTracking?: boolean; // recorded during a synchronised tracking (Polar H10 with the Watch D2)
  /** Saved with "Save ignoring irregular shape": always analysed with Irregular Shape ignored. */
  ignoreShape?: boolean;
  /** The recording it was saved from (with ignoreShape). */
  derivedFrom?: string;
  /** The summary in the cloud (or this copy of it) has the version ignoring Irregular Shape when this is 2 (see SUMMARY_LEVEL). */
  summaryLevel?: number;
}

interface SignalRecord { id: string; samples: Int16Array } // µV

let dbPromise: Promise<IDBDatabase> | null = null;
const STORE_NAMES: readonly StoreName[] = ['sessions', 'signals', 'sleeps', 'sleepSignals', 'ecgSummaries', 'bin', 'binSignals', 'sleepReports', 'syncTraces', 'recordingParts'];

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    // version 2 adds sleep recordings, version 3 summary copies of ECG recordings, version 4 the Recovery centre,
    // version 5 the synchronised sleep reports, version 6 the beats of each synchronised tracking, version 7 sleep recordings
    // as they run; existing data is kept
    const req = indexedDB.open(dbName, 7);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORE_NAMES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export type StoreName = 'sessions' | 'signals' | 'sleeps' | 'sleepSignals' | 'ecgSummaries' | 'bin' | 'binSignals' | 'sleepReports' | 'syncTraces' | 'recordingParts';

/** Runs `fn` in a transaction and resolves when it completes (with the request's result, if one is returned). */
function tx<T>(stores: StoreName[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  return open().then((db) => new Promise<T | undefined>((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const req = fn(t);
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('storage error')); // e.g. the device's storage is full
  }));
}

/** `seconds` is the length of the recordings whose raw data is on this device. */
export interface StoreUse { count: number; bytes: number; seconds: number }

/** How much each store holds, as `size` counts it. One record at a time, so long recordings don't all load at once. */
export async function measureStores(size: (v: unknown) => number): Promise<Record<StoreName, StoreUse>> {
  const out = {} as Record<StoreName, StoreUse>;
  for (const name of STORE_NAMES) {
    const use: StoreUse = { count: 0, bytes: 0, seconds: 0 };
    out[name] = use;
    await tx([name], 'readonly', (t) => {
      const req = t.objectStore(name).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        const v = c.value as Partial<Session>;
        use.count++;
        use.bytes += size(v);
        if (typeof v.durationS === 'number' && !v.cloudOnly) use.seconds += v.durationS;
        c.continue();
      };
    });
  }
  return out;
}

export async function saveSession(session: Session, samples: Int16Array): Promise<void> {
  await tx(['sessions', 'signals'], 'readwrite', (t) => {
    t.objectStore('sessions').put(session);
    t.objectStore('signals').put({ id: session.id, samples } satisfies SignalRecord);
  });
}

export async function updateSession(session: Session): Promise<void> {
  await tx(['sessions'], 'readwrite', (t) => { t.objectStore('sessions').put(session); });
}

/** Saves a summary copy that arrived from another device (no signal). */
export async function saveSummaryCopy(session: Session, summary: unknown): Promise<void> {
  await tx(['sessions', 'ecgSummaries'], 'readwrite', (t) => {
    t.objectStore('sessions').put(session);
    t.objectStore('ecgSummaries').put({ id: session.id, summary });
  });
}

export async function loadSummaryCopy(id: string): Promise<unknown> {
  return (await tx<{ id: string; summary: unknown } | undefined>(['ecgSummaries'], 'readonly', (t) => t.objectStore('ecgSummaries').get(id)))?.summary;
}

/** Every user's recordings (for cloud sync). */
export async function listAllSessions(): Promise<Session[]> {
  return (await tx<Session[]>(['sessions'], 'readonly', (t) => t.objectStore('sessions').getAll())) ?? [];
}

export async function loadSignal(id: string): Promise<Int16Array | undefined> {
  return (await tx<SignalRecord | undefined>(['signals'], 'readonly', (t) => t.objectStore('signals').get(id)))?.samples;
}

// Recordings deleted here that the cloud still has; removed there on the next sync.
const tombstoneKey = (kind: 'ecg' | 'sleep' | 'tracking' | 'sleep-reports' = 'ecg'): string => `${keyPrefix}ecg-analysis-${kind === 'ecg' ? 'deleted' : `deleted-${kind}`}`;

export function pendingCloudDeletes(kind: 'ecg' | 'sleep' | 'tracking' | 'sleep-reports' = 'ecg'): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(tombstoneKey(kind)) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function setPendingCloudDeletes(ids: readonly string[], kind: 'ecg' | 'sleep' | 'tracking' | 'sleep-reports' = 'ecg'): void {
  try { localStorage.setItem(tombstoneKey(kind), JSON.stringify(ids)); } catch { /* private mode */ }
}

/** One user's recordings, newest first. */
export async function listSessions(user: UserNumber): Promise<Session[]> {
  const all = await tx<Session[]>(['sessions'], 'readonly', (t) => t.objectStore('sessions').getAll());
  return (all ?? []).filter((s) => sessionUser(s) === user).sort((a, b) => b.start - a.start);
}

export async function loadSession(id: string): Promise<{ session: Session | undefined; samples: Int16Array | undefined }> {
  const [session, signal] = await Promise.all([
    tx<Session | undefined>(['sessions'], 'readonly', (t) => t.objectStore('sessions').get(id)),
    tx<SignalRecord | undefined>(['signals'], 'readonly', (t) => t.objectStore('signals').get(id)),
  ]);
  return { session, samples: signal?.samples };
}

export async function deleteSession(id: string, { fromCloud = true }: { fromCloud?: boolean } = {}): Promise<void> {
  const existing = await tx<Session | undefined>(['sessions'], 'readonly', (t) => t.objectStore('sessions').get(id));
  if (fromCloud && existing?.synced) setPendingCloudDeletes([...new Set([...pendingCloudDeletes(), id])]);
  if (existing) await binSession(existing, !fromCloud);
  await tx(['sessions', 'signals', 'ecgSummaries'], 'readwrite', (t) => {
    t.objectStore('sessions').delete(id);
    t.objectStore('signals').delete(id);
    t.objectStore('ecgSummaries').delete(id);
  });
}

// ---------- Sleep recordings ----------

export interface SleepSummary {
  sleepMin: number;
  score: number;
  awakenings: number;
  avgHR: number;
  avgHrv: number;
  breathingRate: number;
}

export interface SleepSession {
  id: string;
  user: UserNumber;
  start: number; // epoch ms (bed time)
  durationS: number;
  source: 'polar' | 'demo';
  summary: SleepSummary | null;
  synced?: boolean; // its report is in the account's cloud copy
  cloudOnly?: boolean; // a report copy from another device: no raw data on this device
  report?: unknown; // the synced report (SleepReport) for copies from another device
  ecgId?: string; // the ECG recorded during this night
  context?: 'night' | 'nap'; // chosen by the person; otherwise the clock decides
  onsetUnknown?: boolean; // the recording started after falling asleep
  labelAt?: number; // when those two were last set, ms: the newest wins in the cloud
  sentMethod?: number; sentLabelAt?: number; // the stage rules and labels of the report in the cloud
}

interface SleepSignalRecord {
  id: string;
  rrT: Float64Array;
  rr: Float32Array;
  acc: Int16Array;
  accFs: number;
}

export interface SleepSignals { rrT: Float64Array; rr: Float32Array; acc: Int16Array; accFs: number }

let recordingSleep = false;
export const sleepRecording = (): boolean => recordingSleep;
export function setSleepRecording(on: boolean): void {
  recordingSleep = on;
  if (!on) window.dispatchEvent(new Event('openbeat-sleep-stopped'));
}

/** Part of a sleep recording that is still running, kept until it is saved as a whole. */
export async function saveRecordingPart(part: RecordingPart): Promise<void> {
  await tx(['recordingParts'], 'readwrite', (t) => { t.objectStore('recordingParts').put(part); });
}

export async function listRecordingParts(): Promise<RecordingPart[]> {
  return (await tx<RecordingPart[]>(['recordingParts'], 'readonly', (t) => t.objectStore('recordingParts').getAll() as IDBRequest<RecordingPart[]>)) ?? [];
}

export async function deleteRecordingParts(rec: number): Promise<void> {
  const ids = (await listRecordingParts()).filter((p) => p.rec === rec).map((p) => p.id);
  await tx(['recordingParts'], 'readwrite', (t) => { for (const id of ids) t.objectStore('recordingParts').delete(id); });
}

export async function saveSleep(session: SleepSession, signals: SleepSignals): Promise<void> {
  await tx(['sleeps', 'sleepSignals'], 'readwrite', (t) => {
    t.objectStore('sleeps').put(session);
    t.objectStore('sleepSignals').put({ id: session.id, ...signals } satisfies SleepSignalRecord);
  });
}

export async function updateSleep(session: SleepSession): Promise<void> {
  await tx(['sleeps'], 'readwrite', (t) => { t.objectStore('sleeps').put(session); });
}

/** The reports of one sleep, with every version. `fromCloud`: they came from the cloud, so they keep their time and need no upload. */
export async function saveSleepReports(r: SavedSleepReports, { fromCloud = false }: { fromCloud?: boolean } = {}): Promise<void> {
  const saved = fromCloud ? { ...r, synced: true } : { ...r, savedAt: Date.now(), synced: false };
  await tx(['sleepReports'], 'readwrite', (t) => { t.objectStore('sleepReports').put(saved); });
}

export async function loadSleepReports(id: string): Promise<SavedSleepReports | undefined> {
  return tx<SavedSleepReports | undefined>(['sleepReports'], 'readonly', (t) => t.objectStore('sleepReports').get(id));
}

export async function listSleepReports(user: number): Promise<SavedSleepReports[]> {
  return ((await tx<SavedSleepReports[]>(['sleepReports'], 'readonly', (t) => t.objectStore('sleepReports').getAll())) ?? []).filter((r) => r.user === user);
}

export async function listAllSleepReports(): Promise<SavedSleepReports[]> {
  return (await tx<SavedSleepReports[]>(['sleepReports'], 'readonly', (t) => t.objectStore('sleepReports').getAll())) ?? [];
}

export async function deleteSleepReports(id: string, { fromCloud = true }: { fromCloud?: boolean } = {}): Promise<void> {
  if (fromCloud && (await loadSleepReports(id))?.synced) setPendingCloudDeletes([...new Set([...pendingCloudDeletes('sleep-reports'), id])], 'sleep-reports');
  await tx(['sleepReports'], 'readwrite', (t) => { t.objectStore('sleepReports').delete(id); });
}

export async function listAllSleeps(): Promise<SleepSession[]> {
  return (await tx<SleepSession[]>(['sleeps'], 'readonly', (t) => t.objectStore('sleeps').getAll())) ?? [];
}

/** A report copy from another device (no raw data). */
export async function saveSleepCopy(session: SleepSession): Promise<void> {
  await tx(['sleeps'], 'readwrite', (t) => { t.objectStore('sleeps').put(session); });
}

/** One user's nights, newest first. */
export async function listSleeps(user: UserNumber): Promise<SleepSession[]> {
  const all = await tx<SleepSession[]>(['sleeps'], 'readonly', (t) => t.objectStore('sleeps').getAll());
  return (all ?? []).filter((s) => s.user === user).sort((a, b) => b.start - a.start);
}

export async function loadSleep(id: string): Promise<{ session: SleepSession | undefined; signals: SleepSignals | undefined }> {
  const [session, rec] = await Promise.all([
    tx<SleepSession | undefined>(['sleeps'], 'readonly', (t) => t.objectStore('sleeps').get(id)),
    tx<SleepSignalRecord | undefined>(['sleepSignals'], 'readonly', (t) => t.objectStore('sleepSignals').get(id)),
  ]);
  return { session, signals: rec ? { rrT: rec.rrT, rr: rec.rr, acc: rec.acc, accFs: rec.accFs } : undefined };
}

export async function deleteSleep(id: string, { fromCloud = true }: { fromCloud?: boolean } = {}): Promise<void> {
  const existing = await tx<SleepSession | undefined>(['sleeps'], 'readonly', (t) => t.objectStore('sleeps').get(id));
  if (fromCloud && existing?.synced) setPendingCloudDeletes([...new Set([...pendingCloudDeletes('sleep'), id])], 'sleep');
  if (existing) await binSleep(existing, !fromCloud);
  await tx(['sleeps', 'sleepSignals'], 'readwrite', (t) => {
    t.objectStore('sleeps').delete(id);
    t.objectStore('sleepSignals').delete(id);
  });
}

// ---------- Recovery centre ----------
// A copy of everything deleted, kept on this device until it is deleted permanently. The raw signals are in a store of
// their own, so listing the items stays quick.

interface BinBase { id: string; user: number; deletedAt: number; size: number; elsewhere?: boolean } // elsewhere: deleted on another device
export type BinItem =
  | BinBase & { kind: 'ecg'; session: Session; summary?: unknown }
  | BinBase & { kind: 'sleep'; session: SleepSession }
  | BinBase & { kind: 'tracking'; entry: SyncTrackingEntry };

export interface BinSignalRecord { id: string; samples?: Int16Array; signals?: SleepSignals }

const binSkippedKey = (): string => `${keyPrefix}ecg-analysis-bin-skipped`;

/** Items that couldn't be kept because the device's storage was full (they were deleted anyway, so space can be freed). */
export function binSkipped(): number {
  try { return Number(localStorage.getItem(binSkippedKey())) || 0; } catch { return 0; }
}

async function keepInBin(item: BinItem, data?: BinSignalRecord): Promise<void> {
  try {
    await tx(['bin', 'binSignals'], 'readwrite', (t) => {
      t.objectStore('bin').put(item);
      if (data) t.objectStore('binSignals').put(data);
    });
  } catch {
    try { localStorage.setItem(binSkippedKey(), String(binSkipped() + 1)); } catch { /* storage unavailable */ }
  }
}

/** The copy already kept, if it has a raw signal: a summary copy must not replace it. */
async function keptWithSignal(id: string): Promise<boolean> {
  return (await tx(['binSignals'], 'readonly', (t) => t.objectStore('binSignals').getKey(id))) !== undefined;
}

async function binSession(session: Session, elsewhere: boolean): Promise<void> {
  const id = `ecg:${session.id}`;
  const samples = await loadSignal(session.id);
  if (!samples && await keptWithSignal(id)) return;
  const summary = await loadSummaryCopy(session.id);
  const size = JSON.stringify(session).length + (summary === undefined ? 0 : JSON.stringify(summary).length) + (samples?.byteLength ?? 0);
  await keepInBin(
    { id, kind: 'ecg', user: sessionUser(session), deletedAt: Date.now(), size, session, ...(summary === undefined ? {} : { summary }), ...(elsewhere ? { elsewhere } : {}) },
    samples ? { id, samples } : undefined,
  );
}

async function binSleep(session: SleepSession, elsewhere: boolean): Promise<void> {
  const id = `sleep:${session.id}`;
  const { signals } = await loadSleep(session.id);
  if (!signals && await keptWithSignal(id)) return;
  const size = JSON.stringify(session).length + (signals ? signals.rrT.byteLength + signals.rr.byteLength + signals.acc.byteLength : 0);
  await keepInBin(
    { id, kind: 'sleep', user: session.user, deletedAt: Date.now(), size, session, ...(elsewhere ? { elsewhere } : {}) },
    signals ? { id, signals } : undefined,
  );
}

export async function listBin(): Promise<BinItem[]> {
  return (await tx<BinItem[]>(['bin'], 'readonly', (t) => t.objectStore('bin').getAll() as IDBRequest<BinItem[]>)) ?? [];
}

/** Everything in the Recovery centre with its raw signals, for an account backup. */
export async function exportBin(): Promise<{ item: BinItem; data?: BinSignalRecord }[]> {
  const signals = (await tx<BinSignalRecord[]>(['binSignals'], 'readonly', (t) => t.objectStore('binSignals').getAll() as IDBRequest<BinSignalRecord[]>)) ?? [];
  const byId = new Map(signals.map((d) => [d.id, d]));
  return (await listBin()).map((item) => {
    const data = byId.get(item.id);
    return data ? { item, data } : { item };
  });
}

/** Puts an item from a backup into the Recovery centre; a copy here with its raw signal is not replaced by one without. */
export async function importBin(item: BinItem, data?: BinSignalRecord): Promise<void> {
  if (!data && await keptWithSignal(item.id)) return;
  await tx(['bin', 'binSignals'], 'readwrite', (t) => {
    t.objectStore('bin').put(item);
    if (data) t.objectStore('binSignals').put(data);
  });
}

/** Removes an item from the Recovery centre for good. */
async function dropFromBin(id: string): Promise<void> {
  await tx(['bin', 'binSignals'], 'readwrite', (t) => {
    t.objectStore('bin').delete(id);
    t.objectStore('binSignals').delete(id);
  });
}

export async function purgeBin(id: string): Promise<void> {
  await dropFromBin(id);
  if (id.startsWith('tracking:')) await tx(['syncTraces'], 'readwrite', (t) => { t.objectStore('syncTraces').delete(id.slice('tracking:'.length)); }); // its beats go with it
}

/**
 * What a kept item comes back as: never marked as synced, so the next sync uploads it (and any cloud delete still waiting
 * is dropped by the caller).
 */
export function restoredCopy<T extends { synced?: boolean }>(session: T, hasSignal: boolean): Omit<T, 'synced' | 'cloudOnly'> & { cloudOnly?: boolean } {
  const { synced: _s, cloudOnly: wasCopy, ...rest } = session as T & { cloudOnly?: boolean };
  return { ...rest, ...(wasCopy && !hasSignal ? { cloudOnly: true } : {}) } as Omit<T, 'synced' | 'cloudOnly'> & { cloudOnly?: boolean };
}

const withoutId = (ids: readonly string[], id: string): string[] => ids.filter((x) => x !== id);

/** Puts an item back where it was deleted from, then removes it from the Recovery centre. */
export async function restoreBin(id: string): Promise<void> {
  const item = await tx<BinItem | undefined>(['bin'], 'readonly', (t) => t.objectStore('bin').get(id));
  if (!item) return;
  const data = await tx<BinSignalRecord | undefined>(['binSignals'], 'readonly', (t) => t.objectStore('binSignals').get(id));
  if (item.kind === 'ecg') {
    setPendingCloudDeletes(withoutId(pendingCloudDeletes(), item.session.id));
    const { session: now } = await loadSession(item.session.id);
    // already back here with its signal (from another device's restore): a summary copy adds nothing
    if (data?.samples) await saveSession(restoredCopy(item.session, true), data.samples);
    else if (!now || now.cloudOnly) await saveSummaryCopy(restoredCopy(item.session, false), item.summary);
  } else if (item.kind === 'sleep') {
    setPendingCloudDeletes(withoutId(pendingCloudDeletes('sleep'), item.session.id), 'sleep');
    const { session: now } = await loadSleep(item.session.id);
    if (data?.signals) await saveSleep(restoredCopy(item.session, true), data.signals);
    else if (!now || now.cloudOnly) await saveSleepCopy(restoredCopy(item.session, false));
    // deleting the night took the link off the ECG that was kept
    const ecgId = item.session.ecgId;
    const { session: ecg } = ecgId ? await loadSession(ecgId) : { session: undefined };
    if (ecg && !ecg.sleepId) await updateSession({ ...ecg, sleepId: item.session.id });
  } else {
    setPendingCloudDeletes(withoutId(pendingCloudDeletes('tracking'), item.entry.id), 'tracking');
    saveSyncEntry(item.entry);
  }
  await dropFromBin(id);
}

// ---------- Settings ----------

export interface Settings {
  alias: string;
  age: number;
  sex: 'male' | 'female';
  heightCm: number; // 0 = not given
  weightKg: number; // 0 = not given
  waistCm: number; // 0 = not given
  hrRest: number;
  hrMax: number;
  zoneMin: number;
  zoneMax: number;
  notch: number; // Hz, 0 = off
  qtcFormula: 'bazett' | 'fridericia';
  alertZone: boolean;
  alertPnn50: boolean;
  alertEvents: boolean;
  vibrate: boolean;
}

// User 1 keeps the original key, so settings saved before users existed stay with User 1.
export function settingsKey(user: UserNumber): string {
  return keyPrefix + (user === 1 ? 'ecg-analysis-settings' : `ecg-analysis-settings-u${user}`);
}
export const DEFAULT_SETTINGS: Readonly<Settings> = {
  alias: '',
  age: 40,
  sex: 'male',
  heightCm: 0,
  weightKg: 0,
  waistCm: 0,
  hrRest: 60,
  hrMax: 180,
  zoneMin: 110,
  zoneMax: 160,
  notch: 50,
  qtcFormula: 'bazett',
  alertZone: false,
  alertPnn50: false,
  alertEvents: false,
  vibrate: true,
};

const CHOICES: { readonly [K in keyof Settings]?: readonly string[] } = {
  sex: ['male', 'female'],
  qtcFormula: ['bazett', 'fridericia'],
};

/** Keeps only saved values whose type matches the default, so a damaged or old entry can't break the app. */
function sanitize(saved: unknown): Partial<Settings> {
  if (typeof saved !== 'object' || saved === null) return {};
  const out: Record<string, unknown> = {};
  const raw = saved as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const v = raw[key];
    if (typeof v !== typeof DEFAULT_SETTINGS[key]) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    const allowed = CHOICES[key];
    if (allowed && !allowed.includes(String(v))) continue;
    out[key] = v;
  }
  return out as Partial<Settings>;
}

/** Body-mass index from height and weight, or null when either is missing. */
export function bmi(s: Pick<Settings, 'heightCm' | 'weightKg'>): number | null {
  return s.heightCm > 0 && s.weightKg > 0 ? s.weightKg / (s.heightCm / 100) ** 2 : null;
}

/** Waist ÷ height, or null when either is missing. Under 0.5 is the usual guide (NICE 2022). */
export function waistToHeight(s: Pick<Settings, 'heightCm' | 'waistCm'>): number | null {
  return s.heightCm > 0 && s.waistCm > 0 ? s.waistCm / s.heightCm : null;
}

/** One-line biodata summary, e.g. "55 y · male · 175 cm · 70 kg"; only the details given. */
export function biodataLine(s: Settings): string {
  return [
    `${s.age} y`,
    s.sex,
    s.heightCm > 0 ? `${s.heightCm} cm` : '',
    s.weightKg > 0 ? `${s.weightKg} kg` : '',
    s.waistCm > 0 ? `waist ${s.waistCm} cm` : '',
  ].filter(Boolean).join(' · ');
}

/** Settings from any saved or downloaded value, with defaults for whatever is missing or damaged. */
export function parseSettings(raw: unknown): Settings {
  return { ...DEFAULT_SETTINGS, ...sanitize(raw) };
}

export function loadSettings(user: UserNumber): Settings {
  try {
    return parseSettings(JSON.parse(localStorage.getItem(settingsKey(user)) ?? '{}'));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Whether this device has saved settings for this user at all. */
export function hasSavedSettings(user: UserNumber): boolean {
  try { return localStorage.getItem(settingsKey(user)) !== null; } catch { return false; }
}

/** When this user's settings were last saved here (ms since 1970); 0 = never, or saved before cloud sync existed. */
export function settingsSavedAt(user: UserNumber): number {
  try { const v = Number(localStorage.getItem(`${settingsKey(user)}-saved`)); return Number.isFinite(v) && v > 0 ? v : 0; } catch { return 0; }
}

/** `savedAt` is now for a change made here; cloud sync passes the time of the copy it stored. */
export function saveSettings(user: UserNumber, s: Settings, savedAt = Date.now()): void {
  try {
    localStorage.setItem(settingsKey(user), JSON.stringify(s));
    localStorage.setItem(`${settingsKey(user)}-saved`, String(savedAt));
  } catch { /* private mode */ }
}

// ---------- Synchronised tracking history (this device) ----------

/** One synchronised tracking: when, how long, both devices' results, the blood pressure taken and the saved ECG. */
export interface SyncBp { at: number; systolic: number | null; diastolic: number | null; pulse: number | null }

/** Blood pressure readings of an entry (older entries kept only the first). */
export const syncBps = (e: SyncTrackingEntry): SyncBp[] => e.bps ?? (e.bp ? [e.bp] : []);

export interface SyncTrackingEntry {
  id: string; // `t${start}`
  user: UserNumber;
  start: number; // epoch ms
  durationS: number;
  polar: { hr: number | null; rmssd: number | null; sdnn: number | null; beats: number } | null; // null = not connected
  watch: { hr: number | null; rmssd: number | null; sdnn: number | null; beats: number } | null;
  /** The first blood pressure reading (kept for entries saved before `bps`). */
  bp: SyncBp | null;
  /** Every blood pressure reading taken on the watch within one hour of the start. */
  bps?: SyncBp[];
  ecgId: string | null; // the recording saved to ECG history
  savedAt?: number; // last change, ms: the newest copy wins in the cloud
  synced?: boolean; // in the account's cloud copy
}

const syncKey = (): string => `${keyPrefix}ecg-analysis-sync-tracking`;
const MAX_SYNC = 500;

// ---------- keeping everything on this device ----------
// A computer keeps every tracking and every line of D2 Link's download history; a phone or tablet keeps the latest ones,
// and the rest stay in the cloud. The Storage section can change this for the device. d2/store.ts reads the same setting.
const KEEP_ALL_KEY = 'openbeat-keep-all';

export function keepAllByDefault(ua: string, touchPoints: number): boolean {
  return !/Android|iPhone|iPad|Mobile/i.test(ua) && touchPoints < 2;
}

export function keepAll(): boolean {
  try {
    const v = localStorage.getItem(KEEP_ALL_KEY);
    if (v != null) return v === '1';
    return keepAllByDefault(navigator.userAgent, navigator.maxTouchPoints);
  } catch { return false; }
}

export function setKeepAll(on: boolean): void {
  try { localStorage.setItem(KEEP_ALL_KEY, on ? '1' : '0'); } catch { /* not kept */ }
}

/** How many trackings this device keeps. */
export const trackingLimit = (): number => (keepAll() ? Infinity : MAX_SYNC);

/**
 * Saves a list, newest first. If the browser's space for such lists is full, the oldest entries already in the cloud
 * make room, so a new entry is never lost.
 */
function saveNewestFirst(key: string, list: readonly { synced?: boolean }[]): void {
  const left = [...list];
  for (;;) {
    try { localStorage.setItem(key, JSON.stringify(left)); return; } catch { /* full, or storage unavailable */ }
    const i = left.map((e) => e.synced).lastIndexOf(true);
    if (i < 0) return;
    left.splice(i, 1);
  }
}

export function loadSyncHistory(): SyncTrackingEntry[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(syncKey()) ?? '[]');
    return Array.isArray(v) ? v.filter((e): e is SyncTrackingEntry => typeof e === 'object' && e !== null && typeof (e as SyncTrackingEntry).start === 'number' && typeof (e as SyncTrackingEntry).id === 'string') : [];
  } catch { return []; }
}

export async function removeSyncEntry(id: string, { fromCloud = true }: { fromCloud?: boolean } = {}): Promise<void> {
  const entry = loadSyncHistory().find((x) => x.id === id);
  if (fromCloud && entry?.synced) setPendingCloudDeletes([...new Set([...pendingCloudDeletes('tracking'), id])], 'tracking');
  if (entry) await keepInBin({ id: `tracking:${id}`, kind: 'tracking', user: entry.user, deletedAt: Date.now(), size: JSON.stringify(entry).length, entry });
  try { localStorage.setItem(syncKey(), JSON.stringify(loadSyncHistory().filter((x) => x.id !== id))); } catch { /* storage unavailable */ }
}

/**
 * Adds an entry, or replaces the one with the same id (e.g. when its blood pressure arrives later). Newest first.
 * `fromCloud`: it came from the cloud, so it keeps its time and needs no upload.
 */
export function saveSyncEntry(e: SyncTrackingEntry, { fromCloud = false }: { fromCloud?: boolean } = {}): void {
  const rest = loadSyncHistory().filter((x) => x.id !== e.id);
  const saved = fromCloud ? { ...e, synced: true } : { ...e, savedAt: Date.now(), synced: false };
  saveNewestFirst(syncKey(), [saved, ...rest].sort((a, b) => b.start - a.start).slice(0, trackingLimit()));
}

/** The beats and report versions of one tracking. They stay when it is deleted, so restoring it brings its reports back. */
export async function saveSyncTrace(trace: SyncTrace): Promise<void> {
  await tx(['syncTraces'], 'readwrite', (t) => { t.objectStore('syncTraces').put(trace); });
}

export async function loadSyncTrace(id: string): Promise<SyncTrace | undefined> {
  return tx<SyncTrace | undefined>(['syncTraces'], 'readonly', (t) => t.objectStore('syncTraces').get(id));
}

export async function listSyncTraces(): Promise<SyncTrace[]> {
  return (await tx<SyncTrace[]>(['syncTraces'], 'readonly', (t) => t.objectStore('syncTraces').getAll() as IDBRequest<SyncTrace[]>)) ?? [];
}

// ---------- reset (Account menu → "Reset my account data") ----------

/**
 * Deletes everything this account keeps on this device: its recordings, nights and D2 Link data, settings, histories
 * and pairing. Other accounts' data on this device, and the sign-in itself, are kept. `accountId` names D2 Link's storage.
 */
export async function wipeAccountData(accountId: string): Promise<void> {
  if (dbPromise) { try { (await dbPromise).close(); } catch { /* not open */ } dbPromise = null; }
  const drop = (name: string): Promise<void> => new Promise((resolve) => {
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  });
  await drop(dbName);
  await drop(`d2link-${accountId}`);
  try {
    // the account list and the last signed-in account (used to sign in offline) stay
    const mine = (k: string): boolean => k !== ACCOUNTS_KEY && k !== 'ecg-analysis-last-account'
      && ((keyPrefix ? k.startsWith(keyPrefix) : k.startsWith('ecg-analysis-')) || (k.startsWith('d2link-') && k.endsWith(`-${accountId}`)));
    for (const k of Object.keys(localStorage)) if (mine(k)) localStorage.removeItem(k);
  } catch { /* storage unavailable */ }
}
