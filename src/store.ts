// Local persistence: sessions in IndexedDB, settings in localStorage. Nothing leaves the device.

const DB_NAME = 'ecg-analysis';

export interface UserEvent { t: number; label: string }

export interface SessionSummary { meanHR: number; hrvScore: number; eventCount: number }

export interface Session {
  id: string;
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
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('sessions', { keyPath: 'id' });
      db.createObjectStore('signals', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

type StoreName = 'sessions' | 'signals';

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

export async function listSessions(): Promise<Session[]> {
  const all = await tx<Session[]>(['sessions'], 'readonly', (t) => t.objectStore('sessions').getAll());
  return (all ?? []).sort((a, b) => b.start - a.start);
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

// ---------- Settings ----------

export interface Settings {
  alias: string;
  age: number;
  sex: 'male' | 'female';
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

const SETTINGS_KEY = 'ecg-analysis-settings';
export const DEFAULT_SETTINGS: Readonly<Settings> = {
  alias: '',
  age: 40,
  sex: 'male',
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

export function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...sanitize(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* private mode */ }
}
