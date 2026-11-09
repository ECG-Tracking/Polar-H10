// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — the watch connection, shared: once the watch is connected on D2 Link or Synchronised ECG Tracking, it stays
// connected and the other page uses it, instead of pairing and logging in again.
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

import { D2Link, type Log } from './link';
import { openMacBridge, openWatch } from './serial';
import { setUpWatch, type Profile } from './setup';
import * as store from './store';

export type Via = 'bluetooth' | 'mac' | 'system';
export interface OpenWatch { link: D2Link; name: string; battery: number | null }

let open: OpenWatch | null = null;
let opening: Promise<OpenWatch> | null = null;
let isSetUp = false;
const logs = new Set<Log>();
const listeners = new Set<(w: OpenWatch | null) => void>();
const broadcast: Log = (line) => { for (const l of logs) l(line); };
const tell = (): void => { for (const fn of listeners) fn(open); };

/** The watch's name as shown here, without the maker's brand (e.g. "WATCH D2-8F4"). */
export const watchName = (raw: string): string => raw.replace(/^.*?(?=\bwatch\b)/i, '').replace(/\s+/g, ' ').trim() || 'Watch D2';

/** Adds a page's connection log. */
export function logTo(log: Log): void { logs.add(log); }

/** `fn` runs now and whenever the watch connects (with it) or disconnects (with null). */
export function onWatch(fn: (w: OpenWatch | null) => void): void {
  listeners.add(fn);
  fn(open);
}

export const openedWatch = (): OpenWatch | null => open;

/** The connected watch; connects and logs in (pairing first if needed) when it isn't connected yet. */
export function connectWatch(account: string, via: Via, status: (text: string) => void = () => {}): Promise<OpenWatch> {
  if (open) return Promise.resolve(open);
  opening ??= (async () => {
    store.useAccount(account);
    const t = via === 'mac' ? await openMacBridge(broadcast) : await openWatch(via, broadcast);
    broadcast(via === 'bluetooth' ? 'Connected to the watch’s Bluetooth serial service.' : via === 'mac' ? 'Connected through D2 Bridge.' : 'Serial port opened.');
    status('Connected – logging in…');
    const link = new D2Link(t, broadcast);
    const lost = t.onClose;
    t.onClose = () => { lost?.(); if (open?.link === link) { open = null; isSetUp = false; tell(); } };
    try {
      const kept = await link.connect(store.loadPairing(), (p) => store.savePairing(p));
      store.savePairing(kept);
    } catch (e) {
      await link.close();
      throw e;
    }
    open = { link, name: watchName(link.info?.name || link.info?.model || ''), battery: link.info?.battery ?? null };
    tell();
    return open;
  })().finally(() => { opening = null; });
  return opening;
}

/** The set-up the watch needs before sharing its health data: once per connection. */
export async function ensureSetUp(w: OpenWatch, profile: Profile | null): Promise<void> {
  if (isSetUp) return;
  broadcast('Sending the set-up messages (supported features, time, agreements, account, profile)…');
  await setUpWatch(w.link, { watchName: w.name, profile, accountId: store.loadWatchAccount(), log: broadcast });
  isSetUp = true;
}

export async function disconnectWatch(): Promise<void> {
  const w = open;
  open = null;
  isSetUp = false;
  await w?.link.close();
  tell();
}
