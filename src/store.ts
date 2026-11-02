// Local persistence: sessions in IndexedDB, settings in localStorage. Nothing leaves the device.

const DB_NAME = 'ecg-analysis';

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

const CURRENT_USER_KEY = 'ecg-analysis-user';

export function loadCurrentUser(): UserNumber {
  try {
    const v = Number(localStorage.getItem(CURRENT_USER_KEY));
    return isUserNumber(v) ? v : 1;
  } catch {
    return 1;
  }
}

export function saveCurrentUser(user: UserNumber): void {
  try { localStorage.setItem(CURRENT_USER_KEY, String(user)); } catch { /* private mode */ }
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
}

interface SignalRecord { id: string; samples: Int16Array } // µV

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    // version 2 adds sleep recordings; existing ECG recordings are kept as they are
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ['sessions', 'signals', 'sleeps', 'sleepSignals']) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

type StoreName = 'sessions' | 'signals' | 'sleeps' | 'sleepSignals';

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

export async function deleteSession(id: string): Promise<void> {
  await tx(['sessions', 'signals'], 'readwrite', (t) => {
    t.objectStore('sessions').delete(id);
    t.objectStore('signals').delete(id);
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

export async function deleteSleep(id: string): Promise<void> {
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
  return user === 1 ? 'ecg-analysis-settings' : `ecg-analysis-settings-u${user}`;
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
