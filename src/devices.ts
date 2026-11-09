// The Polar H10 connection, shared by every page: pair it on ECG live, Sleep monitor or Synchronised ECG Tracking and the
// others use the same connection instead of pairing again. Each page says what to do with the strap through onStrap.

import { PolarH10 } from './polar';

type Log = (line: string) => void;
type StrapListener = (p: PolarH10) => void;

let current: PolarH10 | null = null;
const listeners = new Set<StrapListener>();
/** While this says so (a night being recorded), a lost connection isn't the end: the page gets the strap back itself. */
let keepOnDrop: () => boolean = () => false;

export const currentStrap = (): PolarH10 | null => current;
export function keepStrapWhen(fn: () => boolean): void { keepOnDrop = fn; }

/** `fn` runs for the connected strap now and for each later connection (it may see the same strap again after a reconnect). */
export function onStrap(fn: StrapListener): void {
  listeners.add(fn);
  if (current) fn(current);
}

/** Tells the pages the strap is connected (also after a page reconnected it). */
export function strapReady(p: PolarH10): void {
  current = p;
  for (const fn of listeners) fn(p);
}

/** Pairs the strap with both streams, so any page can use it; already connected = nothing to do. */
export async function connectStrap(log: Log): Promise<PolarH10> {
  if (current?.connected) return current;
  const p = new PolarH10();
  // the first listener: the strap is gone before the pages hear of it
  p.addEventListener('disconnect', () => { if (current === p && !keepOnDrop()) current = null; });
  try {
    await p.connect(log, { ecg: true, acc: true });
  } catch (err) {
    void p.disconnect();
    throw err;
  }
  strapReady(p);
  return p;
}

export async function disconnectStrap(): Promise<void> {
  const p = current;
  current = null;
  await p?.disconnect();
}
