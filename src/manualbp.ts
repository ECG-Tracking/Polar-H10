// Manual BP: blood pressure readings typed in on the BP and ECG page (from any monitor), kept apart from the Watch D2's
// ("D2 BP"). Kept on this device per user, and synced to the account (table user_data, kind 'manual-bp', one row per
// reading). A deleted reading is kept as a deletion, so the deletion reaches the other devices too.

import type { SyncBp } from './store';

export interface ManualBp {
  id: string;
  user: number;
  /** When the reading was taken (ms). */
  at: number;
  systolic: number; diastolic: number;
  /** When it was last added or deleted (ms): of two copies, the later one wins. */
  savedAt: number;
  deleted?: boolean;
}

const KEY = 'openbeat-manual-bp';
export const DEFAULT_SYS = 120, DEFAULT_DIA = 80;

/** Checks one reading from storage or the cloud before trusting it. */
export function parseManual(v: unknown): ManualBp | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const num = (k: string): number | null => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : null);
  const id = o['id'], user = num('user'), at = num('at'), sys = num('systolic'), dia = num('diastolic'), savedAt = num('savedAt');
  if (typeof id !== 'string' || !id || user == null || at == null || sys == null || dia == null || savedAt == null) return null;
  return { id, user, at, systolic: sys, diastolic: dia, savedAt, ...(o['deleted'] === true ? { deleted: true } : {}) };
}

/** Every manual reading on this device (all users, deletions included). */
export function loadManual(): ManualBp[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.flatMap((x) => { const m = parseManual(x); return m ? [m] : []; }) : [];
  } catch { return []; }
}

export function saveManual(list: readonly ManualBp[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage full or blocked */ }
}

/** Why the values can't be saved, or null when they can. */
export function checkManual(systolic: number, diastolic: number, at: number, now = Date.now()): string | null {
  if (!Number.isFinite(at)) return 'Choose the date and time of the reading.';
  if (at > now + 5 * 60000) return 'The date and time is in the future.';
  if (!Number.isInteger(systolic) || systolic < 50 || systolic > 300) return 'SBP should be a whole number from 50 to 300 mmHg.';
  if (!Number.isInteger(diastolic) || diastolic < 20 || diastolic > 200) return 'DBP should be a whole number from 20 to 200 mmHg.';
  if (diastolic >= systolic) return 'DBP should be lower than SBP.';
  return null;
}

/** Adds a reading; returns the list with it. */
export function addManual(list: readonly ManualBp[], user: number, at: number, systolic: number, diastolic: number, now = Date.now()): ManualBp[] {
  const id = `m${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return [...list, { id, user, at, systolic, diastolic, savedAt: now }];
}

/** Marks a reading deleted (kept as a deletion so it syncs). */
export function deleteManual(list: readonly ManualBp[], id: string, now = Date.now()): ManualBp[] {
  return list.map((m) => (m.id === id ? { ...m, deleted: true, savedAt: Math.max(now, m.savedAt + 1) } : m));
}

/** One user's readings for the graphs and the table: marked Manual BP. */
export function manualReadings(list: readonly ManualBp[], user: number): SyncBp[] {
  return list.filter((m) => m.user === user && !m.deleted).sort((a, b) => a.at - b.at)
    .map((m) => ({ at: m.at, systolic: m.systolic, diastolic: m.diastolic, pulse: null, source: 'manual' as const, id: m.id }));
}

/** Two copies (this device's and the cloud's): each reading once, the later saved copy of it. */
export function mergeManual(here: readonly ManualBp[], there: readonly ManualBp[]): ManualBp[] {
  const by = new Map<string, ManualBp>();
  for (const m of [...here, ...there]) { const had = by.get(m.id); if (!had || m.savedAt > had.savedAt) by.set(m.id, m); }
  return [...by.values()].sort((a, b) => a.at - b.at);
}

/** "D2 BP" or "Manual BP": where a reading came from. */
export const bpSource = (b: { source?: 'manual' | undefined }): string => (b.source === 'manual' ? 'Manual BP' : 'D2 BP');
