// Local persistence: sessions in IndexedDB, settings in localStorage. Nothing leaves the device.

const DB_NAME = 'ecg-analysis';
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('sessions', { keyPath: 'id' });
        db.createObjectStore('signals', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(stores, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const result = fn(t);
    t.oncomplete = () => resolve(result?.result ?? result);
    t.onerror = () => reject(t.error);
  }));
}

/** session: { id, start, durationS, fs, alias, source, userEvents, summary } */
export function saveSession(session, samples) {
  return tx(['sessions', 'signals'], 'readwrite', (t) => {
    t.objectStore('sessions').put(session);
    t.objectStore('signals').put({ id: session.id, samples });
  });
}

export function updateSession(session) {
  return tx(['sessions'], 'readwrite', (t) => { t.objectStore('sessions').put(session); });
}

export function listSessions() {
  return tx(['sessions'], 'readonly', (t) => t.objectStore('sessions').getAll())
    .then((all) => all.sort((a, b) => b.start - a.start));
}

export async function loadSession(id) {
  const [session, signal] = await Promise.all([
    tx(['sessions'], 'readonly', (t) => t.objectStore('sessions').get(id)),
    tx(['signals'], 'readonly', (t) => t.objectStore('signals').get(id)),
  ]);
  return { session, samples: signal?.samples };
}

export function deleteSession(id) {
  return tx(['sessions', 'signals'], 'readwrite', (t) => {
    t.objectStore('sessions').delete(id);
    t.objectStore('signals').delete(id);
  });
}

const SETTINGS_KEY = 'ecg-analysis-settings';
export const DEFAULT_SETTINGS = {
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

export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* private mode */ }
}
