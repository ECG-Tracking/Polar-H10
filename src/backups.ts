// Sync & backups (as in Portfolio Optimizer): download a backup of the account and restore one; export this device's copy
// and the cloud copy side by side; make the cloud copy match this device; or put back an earlier cloud copy.

import { during } from './diagnostics';
import type { SupabaseClient } from '@supabase/supabase-js';
import { current, historyChanged, supabase } from './account';
import * as store from './store';
import type { Session, SleepSession, SleepSignals, UserNumber } from './store';
import { download, make } from './ui';
import { errorMessage } from './util';
import { versionText } from './version';
import { withReadings } from './synctrack';
import type { SyncTrace } from './synccompare';
import type { SavedSleepReports } from './syncsleep';
import type { D2Api } from './d2/index'; // type only: D2 Link's code stays in d2link.js

const TABLES = ['ecg_sessions', 'sleep_nights', 'd2_nights', 'user_data'] as const;
type Table = (typeof TABLES)[number];
const PAGE = 1000;

// ---------- typed arrays as text ----------

function toB64(v: ArrayBufferView): string {
  const b = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(s: string): ArrayBuffer {
  const bin = atob(s);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b.buffer;
}
export const b64 = { toB64, fromB64 };

// ---------- the backup file ----------

interface EcgItem { session: Session; samples?: string; summary?: unknown }
type SignalsText = { rrT: string; rr: string; acc: string; accFs: number };
interface SleepItem { session: SleepSession; signals?: SignalsText }
/** A Recovery centre item with its raw signal as text. */
interface BinEntry { item: store.BinItem; samples?: string; signals?: SignalsText }

const signalsToText = (s: SleepSignals): SignalsText => ({ rrT: toB64(s.rrT), rr: toB64(s.rr), acc: toB64(s.acc), accFs: s.accFs });
const signalsFromText = (s: SignalsText): SleepSignals => ({ rrT: new Float64Array(fromB64(s.rrT)), rr: new Float32Array(fromB64(s.rr)), acc: new Int16Array(fromB64(s.acc)), accFs: s.accFs });

export function binToText({ item, data }: { item: store.BinItem; data?: store.BinSignalRecord }): BinEntry {
  return { item, ...(data?.samples ? { samples: toB64(data.samples) } : {}), ...(data?.signals ? { signals: signalsToText(data.signals) } : {}) };
}

export function binFromText(e: BinEntry): { item: store.BinItem; data?: store.BinSignalRecord } {
  if (!e.samples && !e.signals) return { item: e.item };
  return { item: e.item, data: { id: e.item.id, ...(e.samples ? { samples: new Int16Array(fromB64(e.samples)) } : {}), ...(e.signals ? { signals: signalsFromText(e.signals) } : {}) } };
}

export interface AccountBackup {
  app: 'OpenBeat ECG'; kind: 'openbeat-account-backup'; v: 1;
  exportedAt: string; appVersion: string;
  account: { id: string; email: string };
  ecg: EcgItem[]; sleep: SleepItem[];
  settings: Record<string, { settings: unknown; savedAt: number }>;
  syncTracking: store.SyncTrackingEntry[];
  syncTraces?: SyncTrace[];
  sleepReports?: SavedSleepReports[];
  d2: unknown;
  /** The Recovery centre; missing from backups made before v1.15 and from comparison files. */
  bin?: BinEntry[];
}

async function collect(withSignals: boolean, d2: D2Api | null): Promise<Omit<AccountBackup, 'app' | 'kind' | 'v'>> {
  const a = current.account;
  if (!a) throw new Error('not signed in');
  const ecg: EcgItem[] = [];
  for (const s of await store.listAllSessions()) {
    const item: EcgItem = { session: s };
    if (withSignals) {
      if (s.cloudOnly) item.summary = await store.loadSummaryCopy(s.id);
      else { const samples = await store.loadSignal(s.id); if (samples) item.samples = toB64(samples); }
    }
    ecg.push(item);
  }
  const sleep: SleepItem[] = [];
  for (const n of await store.listAllSleeps()) {
    const item: SleepItem = { session: n };
    if (withSignals && !n.cloudOnly) {
      const { signals } = await store.loadSleep(n.id);
      if (signals) item.signals = signalsToText(signals);
    }
    sleep.push(item);
  }
  const settings: AccountBackup['settings'] = {};
  for (const u of store.USERS) if (store.hasSavedSettings(u)) settings[String(u)] = { settings: store.loadSettings(u), savedAt: store.settingsSavedAt(u) };
  return {
    exportedAt: new Date().toISOString(), appVersion: versionText(), account: { id: a.id, email: a.email },
    ecg, sleep, settings, syncTracking: store.loadSyncHistory(), syncTraces: await store.listSyncTraces(), sleepReports: await store.listAllSleepReports(), d2: d2 ? await d2.backup.exportD2(a.id, withSignals) : null,
    ...(withSignals ? { bin: (await store.exportBin()).map(binToText) } : {}),
  };
}

/** Gives every tracking in the history the blood pressure readings already on this device (as opening its page does). */
async function fillTrackingBp(d2: D2Api | null): Promise<void> {
  const a = current.account;
  if (!d2 || !a) return;
  try {
    for (const e of withReadings(store.loadSyncHistory(), await d2.backup.storedBloodPressure(a.id))) store.saveSyncEntry(e);
  } catch { /* the backup still goes ahead with the history as it is */ }
}

export async function makeBackup(d2: D2Api | null): Promise<AccountBackup> {
  return during('making a backup', () => makeBackupNow(d2));
}

async function makeBackupNow(d2: D2Api | null): Promise<AccountBackup> {
  await fillTrackingBp(d2); // so the backup's tracking history is up to date
  return { app: 'OpenBeat ECG', kind: 'openbeat-account-backup', v: 1, ...(await collect(true, d2)) };
}

export function isBackup(v: unknown): v is AccountBackup {
  const b = v as Partial<AccountBackup> | null;
  return typeof b === 'object' && b !== null && b.kind === 'openbeat-account-backup' && b.v === 1 && Array.isArray(b.ecg) && Array.isArray(b.sleep);
}

/** Puts a backup back on this device; items with the same id are replaced and upload at the next sync. Returns a summary. */
export async function restoreBackup(b: AccountBackup, d2: D2Api | null): Promise<string> {
  let ecg = 0, sleep = 0;
  for (const it of b.ecg) {
    if (typeof it?.session?.id !== 'string') continue;
    const { synced: _s, ...session } = it.session;
    if (it.samples) { await store.saveSession(session, new Int16Array(fromB64(it.samples))); ecg++; }
    else if (it.summary != null) { await store.saveSummaryCopy({ ...session, cloudOnly: true }, it.summary); ecg++; }
  }
  for (const it of b.sleep) {
    if (typeof it?.session?.id !== 'string') continue;
    const { synced: _s, ...session } = it.session;
    if (it.signals) {
      await store.saveSleep(session, signalsFromText(it.signals));
      sleep++;
    } else if (session.cloudOnly) { await store.saveSleepCopy(session); sleep++; }
  }
  let users = 0;
  for (const [k, v] of Object.entries(b.settings ?? {})) {
    const u = Number(k);
    if (!store.isUserNumber(u)) continue;
    store.saveSettings(u as UserNumber, store.parseSettings(v.settings), Date.now()); // the restored settings are the newest
    users++;
  }
  for (const e of Array.isArray(b.syncTracking) ? b.syncTracking : []) if (typeof e?.id === 'string') store.saveSyncEntry(e);
  for (const x of Array.isArray(b.syncTraces) ? b.syncTraces : []) if (typeof x?.id === 'string') await store.saveSyncTrace(x);
  for (const x of Array.isArray(b.sleepReports) ? b.sleepReports : []) if (typeof x?.id === 'string') await store.saveSleepReports(x);
  const d2n = d2 && b.d2 ? await d2.backup.importD2(current.account?.id ?? 'local', b.d2) : 0;
  const bin = Array.isArray(b.bin) ? b.bin.filter((e) => typeof e?.item?.id === 'string') : [];
  for (const e of bin) { const { item, data } = binFromText(e); await store.importBin(item, data); }
  const d2Bin = d2 && b.d2 ? await d2.backup.importD2Bin(current.account?.id ?? 'local', b.d2) : 0;
  const deleted = bin.length + d2Bin;
  historyChanged();
  return `${ecg} ECG recording${ecg === 1 ? '' : 's'}, ${sleep} sleep recording${sleep === 1 ? '' : 's'}, biodata of ${users} user${users === 1 ? '' : 's'}, ${b.syncTracking?.length ?? 0} tracking${(b.syncTracking?.length ?? 0) === 1 ? '' : 's'}, ${d2n} D2 Link item${d2n === 1 ? '' : 's'} and ${deleted} Recovery centre item${deleted === 1 ? '' : 's'}`;
}

// ---------- the cloud copy ----------

async function cloudRows(db: SupabaseClient, table: Table): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from(table).select('*').range(from, from + PAGE - 1);
    if (error) { if (/does not exist|could not find the table/i.test(error.message)) return out; throw new Error(error.message); }
    const got = (data ?? []) as Record<string, unknown>[];
    out.push(...got);
    if (got.length < PAGE) return out;
  }
}

export interface Comparison {
  app: 'OpenBeat ECG'; kind: 'openbeat-comparison'; v: 1; exportedAt: string;
  account: { id: string; email: string };
  /** This device: everything but the raw signals. */
  local: Omit<AccountBackup, 'app' | 'kind' | 'v'>;
  cloud: Record<Table, Record<string, unknown>[]>;
}

export async function makeComparison(d2: D2Api | null): Promise<Comparison> {
  const local = await collect(false, d2);
  const db = supabase();
  const cloud = {} as Record<Table, Record<string, unknown>[]>;
  for (const t of TABLES) cloud[t] = await cloudRows(db, t);
  return { app: 'OpenBeat ECG', kind: 'openbeat-comparison', v: 1, exportedAt: new Date().toISOString(), account: local.account, local, cloud };
}

export function isComparison(v: unknown): v is Comparison {
  const c = v as Partial<Comparison> | null;
  return typeof c === 'object' && c !== null && c.kind === 'openbeat-comparison' && c.v === 1 && typeof c.cloud === 'object' && c.cloud !== null;
}

/** Signs in again with the password: overwriting and restoring the cloud copy need it, as in Portfolio Optimizer. */
async function checkPassword(password: string): Promise<void> {
  const a = current.account;
  if (!a) throw new Error('not signed in');
  if (a.offline) throw new Error('you are offline');
  const { error } = await supabase().auth.signInWithPassword({ email: a.email, password });
  if (error) throw new Error(/invalid/i.test(error.message) ? 'the password is not correct' : error.message);
}

async function deleteIds(db: SupabaseClient, table: Table, ids: readonly string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 200) {
    const { error } = await db.from(table).delete().in('id', ids.slice(i, i + 200));
    if (error) throw new Error(error.message);
  }
}

/** Syncs everything now: the app's history and settings, then D2 Link's data. */
async function syncAll(d2: D2Api | null): Promise<void> {
  await current.cloud?.sync();
  const a = current.account;
  if (d2 && a && !a.offline) await d2.backup.syncD2(a.id, supabase() as unknown as Parameters<D2Api['backup']['syncD2']>[1]);
}

/** Makes the cloud copy match this device: removes what this device doesn't have, then uploads what it has. */
export async function overwriteCloud(password: string, d2: D2Api | null): Promise<string> {
  await checkPassword(password);
  const a = current.account!;
  const db = supabase();
  const ecgIds = new Set((await store.listAllSessions()).map((s) => s.id));
  const sleepIds = new Set((await store.listAllSleeps()).map((s) => s.id));
  const d2Ids = d2 ? await d2.backup.localD2Ids(a.id) : { nights: [], records: [], downloads: [] };
  const d2Nights = new Set(d2Ids.nights), d2Records = new Set(d2Ids.records), d2Downloads = new Set(d2Ids.downloads);
  let removed = 0;
  const gone = async (table: Table, keep: (r: Record<string, unknown>) => boolean): Promise<void> => {
    const ids = (await cloudRows(db, table)).filter((r) => !keep(r)).map((r) => String(r['id']));
    await deleteIds(db, table, ids);
    removed += ids.length;
  };
  await gone('ecg_sessions', (r) => ecgIds.has(String(r['id'])));
  await gone('sleep_nights', (r) => sleepIds.has(String(r['id'])));
  const trackings = new Set(store.loadSyncHistory().map((e) => e.id));
  const sleepReports = new Set((await store.listAllSleepReports()).map((r) => r.id));
  await gone('user_data', (r) => (r['kind'] === 'tracking' ? trackings.has(String(r['id'])) : r['kind'] !== 'sleep-reports' || sleepReports.has(String(r['id']))));
  if (d2) {
    await gone('d2_nights', (r) => d2Nights.has(String(r['id'])));
    await gone('user_data', (r) => r['kind'] === 'settings' || !String(r['kind']).startsWith('d2-') || d2Records.has(String(r['id'])));
    await gone('user_data', (r) => r['kind'] !== 'download-log' || d2Downloads.has(String(r['id'])));
  }
  // biodata and settings: this device's copy becomes the newest, so it replaces the cloud's
  for (const u of store.USERS) if (store.hasSavedSettings(u)) store.saveSettings(u, store.loadSettings(u), Date.now());
  await syncAll(d2);
  return `The cloud copy now matches this device (${removed} item${removed === 1 ? '' : 's'} removed from the cloud; this device’s items uploaded).`;
}

/** Puts back the cloud copy from a comparison file: the cloud is replaced by it, and this device then follows the cloud. */
export async function restoreCloud(c: Comparison, password: string, d2: D2Api | null): Promise<string> {
  await checkPassword(password);
  const a = current.account!;
  if (c.account?.id !== a.id) throw new Error(`this file is from another account (${c.account?.email ?? 'unknown'})`);
  const db = supabase();
  let put = 0;
  for (const t of TABLES) {
    const rows = Array.isArray(c.cloud[t]) ? c.cloud[t] : [];
    const { error } = await db.from(t).delete().not('id', 'is', null);
    if (error && !/does not exist|could not find the table/i.test(error.message)) throw new Error(error.message);
    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100).map(({ owner: _o, created_at: _c, ...r }) => r);
      const up = await db.from(t).upsert(batch);
      if (up.error) throw new Error(up.error.message);
    }
    put += rows.length;
  }
  // biodata and settings from that copy apply here as they were then
  for (const r of c.cloud.user_data ?? []) {
    const u = Number(r['id']);
    if (r['kind'] === 'settings' && store.isUserNumber(u) && typeof r['saved_at'] === 'number') store.saveSettings(u, store.parseSettings(r['data']), r['saved_at']);
  }
  await syncAll(d2);
  return `The earlier cloud copy is back (${put} item${put === 1 ? '' : 's'}); this device has followed it, and your other devices will at their next sync.`;
}

// ---------- the page ----------

/** A small dialog asking for the account password (never stored). */
function askPassword(why: string): Promise<string | null> {
  return new Promise((resolve) => {
    const shade = make('div', 'cmdk');
    const box = make('form', 'cmdk-box pw-box');
    const input = make('input', 'cmdk-input');
    Object.assign(input, { type: 'password', autocomplete: 'current-password', placeholder: 'Account password', required: true });
    const row = make('div', 'row pw-row');
    const ok = make('button', 'primary', 'Continue');
    const cancel = make('button', '', 'Cancel');
    cancel.type = 'button';
    row.append(cancel, ok);
    box.append(make('p', 'pw-why', why), input, row);
    shade.appendChild(box);
    document.body.appendChild(shade);
    const done = (v: string | null): void => { shade.remove(); resolve(v); };
    box.addEventListener('submit', (e) => { e.preventDefault(); done(input.value); });
    cancel.addEventListener('click', () => done(null));
    shade.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); });
    input.focus();
  });
}

function pickFile(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const input = make('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (!f) { resolve(null); return; }
      f.text().then((t) => resolve(JSON.parse(t) as unknown)).catch(() => reject(new Error('the file could not be read as a backup')));
    });
    input.click();
  });
}

const stamp = (): string => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

export function initBackups(root: HTMLElement, deps: { loadD2: () => Promise<D2Api>; openLocate: () => void }): void {
  const d2 = async (): Promise<D2Api | null> => { try { return await deps.loadD2(); } catch { return null; } };
  const status = make('p', 'note backup-status');
  const busy = (b: boolean, ...buttons: HTMLButtonElement[]): void => { for (const x of buttons) x.disabled = b; };
  const run = async (buttons: HTMLButtonElement[], what: string, fn: () => Promise<string>): Promise<void> => {
    busy(true, ...buttons);
    status.textContent = `${what}…`;
    try { status.textContent = await fn(); } catch (e) { status.textContent = `${what} didn’t finish: ${errorMessage(e)}.`; }
    busy(false, ...buttons);
  };

  const card = make('div', 'card backup-card');
  const backupBtn = make('button', 'primary', 'Backup Account');
  const restoreBtn = make('button', 'primary', 'Restore Account');
  const r1 = make('div', 'row wrap backup-actions');
  r1.append(backupBtn, restoreBtn);
  const compareBtn = make('button', '', 'Export local and cloud copies for comparison');
  const overwriteBtn = make('button', '', 'Overwrite cloud with local');
  const restoreCloudBtn = make('button', '', 'Restore previous cloud copy from comparison file');
  const r2 = make('div', 'row wrap');
  r2.append(compareBtn, overwriteBtn, restoreCloudBtn);
  const all = [backupBtn, restoreBtn, compareBtn, overwriteBtn, restoreCloudBtn];
  card.append(
    make('h3', 'backup-h', 'Account backup and restore'),
    make('p', '', 'A backup holds everything this account has saved on this device: every ECG recording with its full signal, every sleep recording with its raw data, the summary copies from your other devices, the Watch D2 nights and data, each user’s biodata and settings, the Synchronised ECG Tracking history, D2 Link’s download history and everything in the Recovery centre. Your password, sign-in, the watch pairing and the watch account ID are not included (after restoring on a new device, enter the watch account ID in D2 Link again). Keep the backup file somewhere outside this browser. Restoring puts its items back on this device and uploads them at the next sync.'),
    r1,
    make('hr', 'backup-sep'),
    make('h3', 'backup-h', 'This device and the cloud copy'),
    make('p', '', 'Export both copies side by side to compare them (the raw signals and the watch account ID are left out), make the cloud copy match this device, or put back an earlier cloud copy from such a comparison file. Overwriting and restoring ask for your account password, and your other devices follow the cloud at their next sync.'),
    r2,
    status,
  );
  root.replaceChildren(make('p', 'muted backup-intro', 'Download a backup of your account, restore one, and compare or repair the copies on this device and in the cloud.'), card);

  const locateCard = make('div', 'card backup-card');
  const locateBtn = make('button', '', 'Locate connected devices');
  locateBtn.addEventListener('click', deps.openLocate);
  locateCard.append(make('h3', 'backup-h', 'Find a lost device'), make('p', '', 'Map the Bluetooth signal around your home to narrow down where a Polar H10 or Watch D2 is.'), locateBtn);
  root.appendChild(locateCard);

  const offline = (): boolean => !current.account || current.account.offline;
  if (offline()) { busy(true, compareBtn, overwriteBtn, restoreCloudBtn); status.textContent = 'Offline: backup and restore on this device work; the cloud copy can’t be reached.'; }

  backupBtn.addEventListener('click', () => void run(all, 'Making the backup', async () => {
    const b = await makeBackup(await d2());
    const blob = new Blob([JSON.stringify(b)], { type: 'application/json' });
    download(blob, `openbeat-backup-${stamp()}.json`);
    return `Backup saved (${(blob.size / 1048576).toFixed(1)} MB): ${b.ecg.length} ECG recordings, ${b.sleep.length} sleep recordings, ${Object.keys(b.settings).length} users’ biodata. Keep the file somewhere safe.`;
  }));

  restoreBtn.addEventListener('click', () => void run(all, 'Restoring', async () => {
    const f = await pickFile();
    if (f == null) return 'No file chosen.';
    if (!isBackup(f)) throw new Error('this is not an OpenBeat ECG account backup');
    const other = current.account && f.account?.id !== current.account.id;
    if (!window.confirm(`${other ? `This backup is from another account (${f.account?.email}). ` : ''}Restore the backup of ${new Date(f.exportedAt).toLocaleString()} onto this device? Items with the same date are replaced; others are kept. They upload to the cloud at the next sync.`)) return 'Not restored.';
    return `Restored ${await restoreBackup(f, await d2())}. Open the pages to see them.`;
  }));

  compareBtn.addEventListener('click', () => void run(all, 'Exporting both copies', async () => {
    const c = await makeComparison(await d2());
    download(new Blob([JSON.stringify(c, null, 1)], { type: 'application/json' }), `openbeat-local-and-cloud-${stamp()}.json`);
    const n = (t: Table): number => c.cloud[t].length;
    return `Exported. Cloud: ${n('ecg_sessions')} ECG recordings, ${n('sleep_nights')} sleep recordings, ${n('d2_nights')} D2 sleep recordings, ${n('user_data')} other items. This device: ${c.local.ecg.length} ECG recordings, ${c.local.sleep.length} nights.`;
  }));

  overwriteBtn.addEventListener('click', () => void (async () => {
    if (!window.confirm('Make the cloud copy match this device? Anything in the cloud that this device doesn’t have is deleted there – and then on your other devices at their next sync. Tip: export a comparison first, so you can put the cloud copy back.')) return;
    const pw = await askPassword('Enter your account password to overwrite the cloud copy.');
    if (!pw) return;
    await run(all, 'Overwriting the cloud copy', async () => overwriteCloud(pw, await d2()));
  })());

  restoreCloudBtn.addEventListener('click', () => void (async () => {
    let f: unknown;
    try { f = await pickFile(); } catch (e) { status.textContent = errorMessage(e); return; }
    if (f == null) return;
    if (!isComparison(f)) { status.textContent = 'This is not a comparison file from “Export local and cloud copies for comparison”.'; return; }
    if (!window.confirm(`Put back the cloud copy from ${new Date(f.exportedAt).toLocaleString()}? The cloud copy is replaced by it, this device follows it now (items not in it are removed here), and your other devices follow at their next sync.`)) return;
    const pw = await askPassword('Enter your account password to restore the cloud copy.');
    if (!pw) return;
    await run(all, 'Restoring the cloud copy', async () => restoreCloud(f as Comparison, pw, await d2()));
  })());
}
