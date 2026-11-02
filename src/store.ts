// Local persistence: sessions in IndexedDB, settings in localStorage. Nothing leaves the device.

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

export interface SessionSummary { meanHR: number; hrvScore: number; eventCount: number }

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
  source: 'polar' | 'demo' | 'import';
  userEvents: UserEvent[];
  summary: SessionSummary | null;
  synced?: boolean; // its summary is in the account's cloud copy
  cloudOnly?: boolean; // a summary copy from another device: no signal on this device
  sleepId?: string; // recorded together with this sleep night ("Start sleep & ECG recording")
}

interface SignalRecord { id: string; samples: Int16Array } // µV

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    // version 2 adds sleep recordings, version 3 summary copies of ECG recordings; existing data is kept
    const req = indexedDB.open(dbName, 3);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ['sessions', 'signals', 'sleeps', 'sleepSignals', 'ecgSummaries']) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

type StoreName = 'sessions' | 'signals' | 'sleeps' | 'sleepSignals' | 'ecgSummaries';

/** Runs `fn` in a transaction and resolves when it completes (with the request's result, if one is returned). */
function tx<T>(stores: StoreName[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  return open().then((db) => new Promise<T | undefined>((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const req = fn(t);
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
  }));
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
const tombstoneKey = (kind: 'ecg' | 'sleep' = 'ecg'): string => `${keyPrefix}ecg-analysis-${kind === 'ecg' ? 'deleted' : 'deleted-sleep'}`;

export function pendingCloudDeletes(kind: 'ecg' | 'sleep' = 'ecg'): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(tombstoneKey(kind)) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function setPendingCloudDeletes(ids: readonly string[], kind: 'ecg' | 'sleep' = 'ecg'): void {
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
  ecgId?: string; // the ECG recorded during this night ("Start sleep & ECG recording")
}

interface SleepSignalRecord {
  id: string;
  rrT: Float64Array;
  rr: Float32Array;
  acc: Int16Array;
  accFs: number;
}

export interface SleepSignals { rrT: Float64Array; rr: Float32Array; acc: Int16Array; accFs: number }

export async function saveSleep(session: SleepSession, signals: SleepSignals): Promise<void> {
  await tx(['sleeps', 'sleepSignals'], 'readwrite', (t) => {
    t.objectStore('sleeps').put(session);
    t.objectStore('sleepSignals').put({ id: session.id, ...signals } satisfies SleepSignalRecord);
  });
}

export async function updateSleep(session: SleepSession): Promise<void> {
  await tx(['sleeps'], 'readwrite', (t) => { t.objectStore('sleeps').put(session); });
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
  await tx(['sleeps', 'sleepSignals'], 'readwrite', (t) => {
    t.objectStore('sleeps').delete(id);
    t.objectStore('sleepSignals').delete(id);
  });
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

export function loadSettings(user: UserNumber): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...sanitize(JSON.parse(localStorage.getItem(settingsKey(user)) ?? '{}')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(user: UserNumber, s: Settings): void {
  try { localStorage.setItem(settingsKey(user), JSON.stringify(s)); } catch { /* private mode */ }
}
