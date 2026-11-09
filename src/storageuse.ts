// The Storage part of the About page: how much space the app takes on this device, what takes it, and what each kind of recording needs.

import { current } from './account';
import { ECG_FS } from './polar';
import * as store from './store';
import type { StoreName, StoreUse } from './store';
import { make } from './ui';
import type { D2Api } from './d2/index'; // type only: D2 Link's code stays in d2link.js
import type { D2Storage, D2Use } from './d2/backup';

export interface Measured {
  stores: Record<StoreName, StoreUse>;
  d2: D2Storage | null; // null if D2 Link couldn't be loaded
  settings: D2Use;
  app: D2Use;
}
export interface UseRow { name: string; count: number | null; bytes: number }
export interface NeedRow { name: string; bytes: number | null; basis: string }

const SLEEP_S = 8 * 3600;
/** The ECG is kept as 2 bytes per sample. */
const ECG_BYTES_PER_S = ECG_FS * 2;

/** Roughly what a stored value takes before the browser compresses it. */
export function sizeOf(v: unknown): number {
  if (typeof v === 'string') return v.length + 1;
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) < 2 ** 30 ? 3 : 9;
  if (typeof v !== 'object' || v === null) return 1;
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return v.byteLength;
  if (Array.isArray(v)) return v.reduce<number>((s, x) => s + sizeOf(x), 2);
  return Object.entries(v).reduce((s, [k, x]) => s + k.length + 1 + sizeOf(x), 2);
}

/** Like the Mac's Finder: 1 MB = 1,000,000 bytes. */
export function formatBytes(n: number): string {
  if (n < 1000) return `${Math.round(n)} B`;
  if (n < 1e6) return `${Math.round(n / 1000)} KB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e9).toFixed(1)} GB`;
}

/** What takes the space, largest first. */
export function usageRows(m: Measured): UseRow[] {
  const s = m.stores, none: D2Use = { count: 0, bytes: 0 };
  const d2 = m.d2;
  const rows: UseRow[] = [
    { name: 'ECG recordings', count: s.sessions.count, bytes: s.sessions.bytes + s.signals.bytes + s.ecgSummaries.bytes },
    { name: 'Sleep', count: s.sleeps.count, bytes: s.sleeps.bytes + s.sleepSignals.bytes },
    { name: 'Synchronised sleep reports', count: s.sleepReports.count, bytes: s.sleepReports.bytes },
    { name: 'Synchronised ECG tracking beats', count: s.syncTraces.count, bytes: s.syncTraces.bytes },
    { name: 'Recovery centre', count: s.bin.count + (d2?.bin ?? none).count, bytes: s.bin.bytes + s.binSignals.bytes + (d2?.bin ?? none).bytes },
    { name: 'App settings', count: null, bytes: m.settings.bytes },
    { name: 'The app itself (offline copy)', count: m.app.count, bytes: m.app.bytes },
  ];
  if (d2) rows.push(
    { name: 'Watch D2 sleep', count: d2.nights.count, bytes: d2.nights.bytes },
    { name: 'Watch D2 activity', count: d2.activity.count, bytes: d2.activity.bytes },
    { name: 'Watch D2 measurements', count: d2.measurements.count, bytes: d2.measurements.bytes },
    { name: 'Watch D2 stress', count: d2.stress.count, bytes: d2.stress.bytes },
    { name: 'Watch D2 workouts', count: d2.workouts.count, bytes: d2.workouts.bytes },
  );
  return rows.sort((a, b) => b.bytes - a.bytes);
}

/** What each kind of recording needs: the ECG from its fixed rate, the others from what is stored. */
export function needRows(m: Measured): NeedRow[] {
  const s = m.stores;
  const ecgHour = ECG_BYTES_PER_S * 3600, ecgNight = ECG_BYTES_PER_S * SLEEP_S;
  const sleep = s.sleeps.seconds > 0 ? (s.sleeps.bytes + s.sleepSignals.bytes) / s.sleeps.seconds * SLEEP_S : null;
  const average = (u: D2Use | undefined): number | null => (u?.count ? u.bytes / u.count : null);
  const yours = 'Average of your recordings';
  return [
    { name: '1 minute of ECG', bytes: ECG_BYTES_PER_S * 60, basis: `${ECG_FS} samples a second` },
    { name: '1 hour of ECG', bytes: ecgHour, basis: `${ECG_FS} samples a second` },
    { name: '8 hours of sleep, without ECG', bytes: sleep, basis: yours },
    { name: '8 hours of sleep, with ECG', bytes: sleep == null ? null : sleep + ecgNight, basis: yours },
    { name: 'One Watch D2 sleep', bytes: average(m.d2?.nights), basis: yours },
    { name: 'Four sleep reports and past versions, per sleep', bytes: average(s.sleepReports), basis: yours },
  ];
}

/** Hours of ECG that fit in the space left. */
export const ecgHoursIn = (bytes: number): number => Math.floor(bytes / (ECG_BYTES_PER_S * 3600));

function measureSettings(): D2Use {
  const out: D2Use = { count: 0, bytes: 0 };
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k != null) { out.count++; out.bytes += k.length + (localStorage.getItem(k)?.length ?? 0); }
    }
  } catch { /* storage unavailable */ }
  return out;
}

async function measureApp(): Promise<D2Use> {
  const out: D2Use = { count: 0, bytes: 0 };
  try {
    for (const name of (await caches.keys()).filter((k) => k.startsWith('openbeat'))) {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) {
        const res = await cache.match(req);
        if (res) { out.count++; out.bytes += (await res.blob()).size; }
      }
    }
  } catch { /* no offline copy here */ }
  return out;
}

function tile(label: string, value: string, sub: string): HTMLElement {
  const t = make('div', 'tile');
  t.append(make('div', 'label', label), make('div', 'value', value), make('div', 'sub', sub));
  return t;
}

function table(head: string[], rows: string[][]): HTMLElement {
  const wrap = make('div', 'd2-table-wrap'), t = make('table', 'd2-table');
  const top = make('tr');
  for (const h of head) top.appendChild(make('th', '', h));
  t.appendChild(make('thead')).appendChild(top);
  const body = make('tbody');
  for (const r of rows) {
    const tr = make('tr');
    for (const c of r) tr.appendChild(make('td', '', c));
    body.appendChild(tr);
  }
  t.appendChild(body);
  wrap.appendChild(t);
  return wrap;
}

let drawing = 0;
/** Measured again at least once a day while the app stays open. */
export const REFRESH_MS = 24 * 3600 * 1000;
let daily: ReturnType<typeof setInterval> | null = null;

/** Measures on every visit, every day while the app is open, and on Refresh, so the page never shows old figures. */
export async function renderStorage(root: HTMLElement, deps: { loadD2: () => Promise<D2Api> }): Promise<void> {
  const mine = ++drawing;
  if (daily) clearInterval(daily);
  daily = setInterval(() => { if (root.isConnected) void renderStorage(root, deps); }, REFRESH_MS);
  root.replaceChildren(make('p', 'muted', 'Measuring…'));
  const [stores, d2, app, estimate] = await Promise.all([
    store.measureStores(sizeOf),
    deps.loadD2().then((api) => (current.account ? api.backup.d2Storage(current.account.id, sizeOf) : null)).catch(() => null),
    measureApp(),
    navigator.storage?.estimate?.().catch(() => null) ?? Promise.resolve(null),
  ]);
  if (mine !== drawing) return;
  const m: Measured = { stores, d2, settings: measureSettings(), app };
  const rows = usageRows(m);
  const total = rows.reduce((s, r) => s + r.bytes, 0);
  const left = estimate?.quota != null && estimate.usage != null ? estimate.quota - estimate.usage : null;

  const tiles = make('div', 'tiles storage-tiles');
  tiles.appendChild(tile('This app’s data', formatBytes(total), 'Everything listed below'));
  if (estimate?.usage != null) tiles.appendChild(tile('Used on this device', formatBytes(estimate.usage), 'As the browser reports it'));
  if (left != null) tiles.appendChild(tile('Space this browser allows the app', formatBytes(left), `Room for about ${ecgHoursIn(left).toLocaleString()} hours of ECG`));

  const what = make('section', 'card');
  what.append(make('h3', '', 'What takes the space'), table(['Data', 'Items', 'Size', 'Share'], rows.map((r) => [
    r.name, r.count == null ? '--' : r.count.toLocaleString(), formatBytes(r.bytes), total ? `${Math.round((100 * r.bytes) / total)} %` : '--',
  ])));
  what.appendChild(make('p', 'note', 'This account on this device, for all its users. ECG recordings include ECGs taken during sleep and synchronised ECG tracking. Sizes are approximate: the browser compresses data and adds its own overhead, and “Used on this device” also includes any other account signed in here.'));
  if (!d2) what.appendChild(make('p', 'note', 'Watch D2 data isn’t included: D2 Link could not be loaded.'));

  const needs = make('section', 'card');
  needs.append(make('h3', '', 'Storage needed per recording'), table(['Recording', 'Size', 'Based on'], needRows(m).map((r) => [
    r.name, r.bytes == null ? '--' : formatBytes(r.bytes), r.bytes == null ? 'No recording yet' : r.basis,
  ])));

  const keep = make('section', 'card');
  const box = make('input'), label = make('label', 'trend-all');
  box.type = 'checkbox';
  box.checked = store.keepAll();
  box.addEventListener('change', () => store.setKeepAll(box.checked));
  label.append(box, ' Keep everything on this device');
  keep.append(make('h3', '', 'What this device keeps'), label, make('p', 'note', 'On: every tracking and the whole D2 Link download history stay here, as well as all recordings. Off: the latest 500 trackings and 300 downloads stay here, and the older ones stay in the cloud. Computers start on, phones and tablets off. The full ECG and raw sleep data stay on the device that recorded them.'));

  const bar = make('div', 'row wrap storage-bar');
  const refresh = make('button', 'small', 'Refresh') as HTMLButtonElement;
  refresh.addEventListener('click', () => void renderStorage(root, deps));
  bar.append(make('span', 'muted', `Measured ${new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · measured again every day`), refresh);

  const allowance = left != null ? make('p', 'note', 'Space this browser allows the app is the browser’s allowance for this website, not the computer’s free space: a web page can’t see how full the disk is. The browser sets it from the free space it sees and its own rules, so it can change from day to day, and it gives more when needed as long as the disk has room.') : null;

  root.replaceChildren(bar, tiles, ...(allowance ? [allowance] : []), what, needs, keep);
}
