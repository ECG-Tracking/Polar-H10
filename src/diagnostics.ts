// A record of problems on this device, to find out why the app stopped responding: a visit that ended without the page
// closing (the browser had to be quit while the app was stuck), pauses of over 5 seconds, and errors. Each entry has
// the time, the page that was open and the app version, never any recordings or health data. Kept on this device only.

import { versionText } from './version';

const ALIVE = 'openbeat-alive', PROBLEMS = 'openbeat-problems', KEEP = 30;
const BEAT_MS = 2000, PAUSE_MS = 5000;

export interface Problem { at: number; kind: 'stopped' | 'pause' | 'error'; page: string; version: string; detail: string }

let page = 'start';
/** What the app is doing now (see `busy`), and everything it did since the last heartbeat. */
const active = new Map<number, string>();
let seen = new Set<string>();
let nextId = 1;
/** Time that isn't a hang: the page was hidden, or the print dialog or an alert/confirm box was open. */
let excused = false;

/**
 * Marks a piece of work that may take a while, so a pause can say what was going on; call the returned function when it
 * ends. Only a short name of the work is kept, never any data.
 */
export function busy(label: string): () => void {
  const id = nextId++;
  active.set(id, label);
  seen.add(label);
  return () => { active.delete(id); };
}

/** Runs `work` marked as `label` (see `busy`). */
export async function during<T>(label: string, work: () => Promise<T>): Promise<T> {
  const done = busy(label);
  try { return await work(); } finally { done(); }
}
/** The page now open (called whenever the page changes). */
export function notePage(p: string): void { page = p; }

const read = <T>(key: string, fallback: T): T => { try { return (JSON.parse(localStorage.getItem(key) ?? 'null') as T | null) ?? fallback; } catch { return fallback; } };
const write = (key: string, v: unknown): void => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* not kept */ } };

export const problems = (): Problem[] => read<Problem[]>(PROBLEMS, []);
export function clearProblems(): void { try { localStorage.removeItem(PROBLEMS); } catch { /* nothing to clear */ } }

function record(kind: Problem['kind'], detail: string, at = Date.now(), where = page, version = versionText()): void {
  write(PROBLEMS, [...problems(), { at, kind, page: where, version, detail: detail.slice(0, 300) }].slice(-KEEP));
}

/** Starts recording; call once when the app starts. */
export function startDiagnostics(): void {
  // the last visit still marked as running: it ended without the page closing
  const last = read<{ at: number; page: string; version?: string } | null>(ALIVE, null);
  if (last && Date.now() - last.at > 3 * BEAT_MS) record('stopped', 'The app stopped without closing normally (for example Chrome had to be quit while it wasn’t responding).', last.at, last.page, last.version ?? 'unknown');
  let tick = Date.now();
  // a hidden page's timers are slowed by the browser, and the print dialog and alert/confirm boxes stop the page on
  // purpose: none of these is a hang (before v1.43.9 they were recorded as one)
  addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') excused = true; });
  addEventListener('beforeprint', () => { excused = true; });
  addEventListener('afterprint', () => { excused = true; });
  for (const k of ['alert', 'confirm', 'prompt'] as const) {
    const original = window[k].bind(window) as (...a: unknown[]) => unknown;
    (window as unknown as Record<string, unknown>)[k] = (...a: unknown[]): unknown => { try { return original(...a); } finally { excused = true; } };
  }
  setInterval(() => {
    const now = Date.now();
    // the page was stuck if this ran much later than planned
    const gap = now - tick;
    if (gap > PAUSE_MS + BEAT_MS && gap < 10 * 60_000 && !excused && document.visibilityState === 'visible') {
      const doing = [...new Set([...seen, ...active.values()])];
      record('pause', `The page didn’t respond for ${Math.round((gap - BEAT_MS) / 1000)} s.${doing.length ? ` Working on: ${doing.join(', ')}.` : ''}`, tick);
    }
    excused = document.visibilityState !== 'visible';
    seen = new Set(active.values());
    tick = now;
    write(ALIVE, { at: now, page, version: versionText() });
  }, BEAT_MS);
  write(ALIVE, { at: Date.now(), page, version: versionText() });
  addEventListener('pagehide', () => { try { localStorage.removeItem(ALIVE); } catch { /* fine */ } });
  addEventListener('error', (e) => record('error', `${e.message}${e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : ''}`));
  addEventListener('unhandledrejection', (e) => record('error', `Unhandled: ${e.reason instanceof Error ? e.reason.message : String(e.reason)}`));
}
