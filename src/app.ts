import { ECG_FS, bluetoothAvailable, type PolarH10, type EcgDetail, type HrDetail, type BatteryDetail } from './polar';
import { connectStrap, currentStrap, disconnectStrap, onStrap } from './devices';
import { EcgSimulator, type Scenario } from './sim';
import { EcgFilter, analyze, hrvStats, sessionMetrics, EVENT_LABELS, type Analysis, type SessionMetrics } from './dsp';
import { Plot, LiveTrace, EcgViewer, ECG_SCALE_NOTE, drawEventStrip, fmtTime, type Point, type ReportEvent, printInLightColours } from './charts';
import { writeEdf, readEdf } from './edf';
import * as store from './store';
import type { Session, Settings, UserEvent, UserNumber } from './store';
import { referenceRanges, SOURCES, type ReferenceRanges } from './ranges';
import { connectionLog, forgetStrapButton } from './devicekit';
import { watchEcgCard } from './watchecg';
import type { LiveWatch } from './d2/live';
import { byId, $, $button, $input, $canvas, make, deleteButton, durationSeconds, fmt, metricTile, renderOutliers as renderOutlierBox, download, type MetricRef, type Outlier } from './ui';
import { errorMessage, errorName } from './util';
import { initSleep } from './sleepui';
import { renderRecovery } from './recovery';
import { parseEcgSummary, withoutShape, base64ToInt16, type EcgSummary } from './summary';
import { current as account, historyChanged, supabase } from './account';
import type { CloudClient } from './d2/cloud'; // type only: D2 Link's code stays in d2link.js
import type { D2Api } from './d2/index';
import { initSyncTracking } from './synctrack';
import { trackingLine } from './syncreports';
import { updateTrackingReports } from './syncreports';
import { initTrends, trendValues } from './ecgtrend';
import { initSyncSleep } from './syncsleepui';
import { overlapMs } from './syncsleep';
import { initBackups } from './backups';
import { initLocate } from './locate';
import { renderStorage } from './storageuse';

const FS = ECG_FS;

let outliers: Outlier[] = [];

const RING_S = 60;
const SPLIT_S = 4 * 3600; // start a new file every 4 h

let currentUser: UserNumber = store.loadCurrentUser();
let settings: Settings = store.loadSettings(currentUser);

// ---------- Navigation ----------

type View = 'live' | 'history' | 'report' | 'sleep' | 'sleepHistory' | 'sleepReport' | 'd2' | 'd2History' | 'sync' | 'syncHistory' | 'syncSleep' | 'syncSleepHistory' | 'syncSleepReport' | 'syncReport' | 'settings' | 'backups' | 'locate' | 'recovery' | 'about';
const VIEWS: readonly View[] = ['live', 'history', 'report', 'sleep', 'sleepHistory', 'sleepReport', 'd2', 'd2History', 'sync', 'syncHistory', 'syncSleep', 'syncSleepHistory', 'syncSleepReport', 'syncReport', 'settings', 'backups', 'locate', 'recovery', 'about'];
const isView = (v: string | undefined): v is View => (VIEWS as readonly (string | undefined)[]).includes(v);
let sleepUI: ReturnType<typeof initSleep> | null = null;
printInLightColours();

function show(view: View): void {
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.id === `view-${view}`);
  const tab = view === 'report' ? 'history' : view === 'sleepReport' ? 'sleepHistory' : view === 'syncSleepReport' ? 'syncSleepHistory' : view === 'syncReport' ? 'syncHistory' : view === 'locate' ? 'backups' : view;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button')) b.setAttribute('aria-selected', String(b.dataset['view'] === tab));
  // the page's name in the top bar (a report is named for what it reports on)
  const tabLabel = document.querySelector<HTMLButtonElement>(`.tabs button[data-view="${tab}"]`)?.textContent?.trim() ?? '';
  $('screenTitle').textContent = view === 'report' ? 'ECG report' : view === 'sleepReport' || view === 'syncSleepReport' ? 'Sleep report' : view === 'syncReport' ? 'Tracking report' : view === 'locate' ? 'Locate connected devices' : tabLabel;
  if (view === 'history') void renderHistory();
  if (view === 'sleepHistory') void sleepUI?.renderHistory();
  if (view === 'sleep') sleepUI?.refreshUser();
  if (view === 'd2' || view === 'd2History') void openD2();
  if (view === 'sync' || view === 'syncHistory') openSync();
  if (view === 'syncHistory') syncUI?.refreshHistory();
  if (view === 'syncSleep') openSyncSleep().refresh();
  if (view === 'syncSleepHistory') void openSyncSleep().refreshHistory();
  if (view === 'backups' && !backupsReady) { backupsReady = true; initBackups($('backupsRoot'), { loadD2, openLocate: () => show('locate') }); }
  if (view === 'locate') { locateUI ??= initLocate($('locateRoot'), () => show('backups')); locateUI.refresh(); }
  if (view === 'recovery') void renderRecovery($('recoveryRoot'), { loadD2, user: () => currentUser });
  if (view === 'about') void renderStorage($('storageRoot'), { loadD2 });
  // D2 Link is open source (built on Gadgetbridge); the rest of the app is not
  // every page: "Copyright © 2026 ECG-Tracking. All rights reserved."; D2 Link (open source) has its licence lines instead
  // the licence lines only on the D2 Link page; D2 Link History has the plain copyright line, like the other pages
  const d2Page = view === 'd2';
  $('copyRights').textContent = d2Page ? '' : 'All rights reserved.';
  $('d2Licence').hidden = !d2Page;
  window.scrollTo(0, 0);
}

// ---------- D2 Link (a separate, open-source script, loaded on first use) ----------

declare const __D2_VERSION__: string; // set by scripts/build.mjs
let d2: { refresh: () => void; openNight: (id: string, back: () => void, copy?: unknown) => Promise<void> } | null = null;
let d2Loading: Promise<void> | null = null;
/** D2 Link switched to its history page itself (e.g. to show a night): keep what it shows. */
let d2KeepPage = false;

/** Loads d2link.js once (D2 Link's page and the watch for synchronised tracking). */
async function loadD2(): Promise<D2Api> {
  d2Loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `d2link.js?v=${__D2_VERSION__}`; // a new version is never taken from a cache
    s.onload = () => resolve();
    s.onerror = () => { d2Loading = null; reject(new Error('could not load d2link.js')); };
    document.head.appendChild(s);
  });
  await d2Loading;
  const api = window.OpenBeatD2;
  if (!api) throw new Error('d2link.js did not start');
  return api;
}

const biodataProfile = (): { heightCm: number; weightKg: number; age: number; sex: 'male' | 'female' } | null =>
  (settings.heightCm > 0 && settings.weightKg > 0 ? { heightCm: settings.heightCm, weightKg: settings.weightKg, age: settings.age, sex: settings.sex } : null);

// ---------- Synchronised tracking (Polar H10 and Watch D2 together) ----------

let syncUI: ReturnType<typeof initSyncTracking> | null = null;
let backupsReady = false;
let locateUI: ReturnType<typeof initLocate> | null = null;
function openSync(): void {
  syncUI ??= initSyncTracking($('syncRoot'), $('syncHistoryRoot'), $('syncReportRoot'), {
    loadD2, account: () => account.account?.id ?? 'local', user: () => currentUser, notch: () => settings.notch, profile: biodataProfile, settings: () => settings,
    openEcg: (id) => void openReport(id),
    summarise,
    show,
    updateReports,
  });
}

// ---------- ECG live: 30-second ECG strips from the Watch D2 ----------

let liveWatch: LiveWatch | null = null;
{
  const wLog = connectionLog('Watch D2 connection log');
  const wCard = make('div', 'card connect');
  const wStatus = make('div', 'status');
  const wDot = make('span', 'dot'), wText = make('span', '', 'Watch D2: not connected');
  wStatus.append(wDot, wText);
  const via = make('select') as HTMLSelectElement;
  for (const [v, label] of [['bluetooth', 'Chrome Bluetooth'], ['mac', 'D2 Bridge app (Mac)']] as const) { const o = make('option', '', label) as HTMLOptionElement; o.value = v; via.appendChild(o); }
  try { const v = localStorage.getItem('d2link-via'); via.value = v === 'mac' || (v == null && /Mac/i.test(navigator.platform)) ? 'mac' : 'bluetooth'; } catch { /* default */ }
  const viaLabel = make('label', 'd2-days', 'Connect via ');
  viaLabel.appendChild(via);
  const btnW = make('button', '', 'Connect Watch D2') as HTMLButtonElement;
  const btnWOff = make('button', '', 'Disconnect watch') as HTMLButtonElement;
  btnWOff.hidden = true;
  const wRow = make('div', 'row wrap');
  wRow.append(btnW, viaLabel, btnWOff);
  const acctSlot = make('div');
  wCard.append(make('h3', 'sync-h', 'Watch D2 (optional)'), wStatus, wRow,
    make('p', 'note', 'For 30-second ECG strips taken on the watch. Switch off Bluetooth on the phone the watch is connected to; on a Mac, open the D2 Bridge app first.'),
    wLog.el, acctSlot);
  const watchEcg = watchEcgCard({ watch: () => liveWatch, user: () => currentUser, settings: () => settings, log: wLog.log, openReport: (id) => void openReport(id) });
  $('view-live').append(wCard, watchEcg.el);
  void loadD2().then((api) => acctSlot.appendChild(api.accountBox(account.account?.id ?? 'local'))).catch(() => undefined);
  btnW.addEventListener('click', () => void (async () => {
    wDot.className = 'dot busy'; wText.textContent = 'Watch D2: connecting… (confirm on the watch if it asks)';
    btnW.disabled = true;
    try {
      const api = await loadD2();
      const w = await api.connectLive({ account: account.account?.id ?? 'local', user: currentUser, via: via.value === 'mac' ? 'mac' : 'bluetooth', profile: biodataProfile(), log: wLog.log });
      w.onClose = () => { liveWatch = null; wDot.className = 'dot'; wText.textContent = 'Watch D2: disconnected'; btnW.hidden = false; btnWOff.hidden = true; watchEcg.update(); };
      liveWatch = w;
      wDot.className = 'dot on'; wText.textContent = `${w.name}: connected${w.battery != null ? ` · battery ${w.battery}%` : ''}`;
      btnW.hidden = true; btnWOff.hidden = false;
    } catch (err) {
      wDot.className = 'dot'; wText.textContent = `Watch D2: ${errorMessage(err)}`;
      wLog.log(`Error: ${errorMessage(err)}`);
    }
    btnW.disabled = false;
    watchEcg.update();
  })());
  btnWOff.addEventListener('click', () => { watchEcg.stop(); void liveWatch?.close(); });
}

let reportsRunning: Promise<boolean> | null = null, reportsTimer: ReturnType<typeof setTimeout> | null = null;

/** New versions of the tracking reports, if a tracking's blood pressure or the watch's data changed. */
function updateReports(): Promise<boolean> {
  reportsRunning ??= updateTrackingReports({ loadD2, account: () => account.account?.id ?? 'local' }).catch(() => false).finally(() => { reportsRunning = null; });
  return reportsRunning;
}

/** Something changed: the watch's data arrived, or another device synced. */
function scheduleReports(): void {
  if (reportsTimer) clearTimeout(reportsTimer);
  reportsTimer = setTimeout(() => {
    void updateReports().then((changed) => { if (changed && $('view-syncHistory').classList.contains('active')) syncUI?.refreshHistory(); });
  }, 2000);
}

/** The ECG recording that overlaps this time the most, if there is one. */
async function ecgDuring(from: number, to: number): Promise<{ id: string; label: string } | null> {
  let best: Session | null = null, most = 0;
  for (const s of await store.listSessions(currentUser)) {
    const ms = overlapMs(from, to, s.start, s.start + s.durationS * 1000);
    if (ms > most) { best = s; most = ms; }
  }
  return best && { id: best.id, label: new Date(best.start).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) };
}

let syncSleepUI: ReturnType<typeof initSyncSleep> | null = null;
function openSyncSleep(): ReturnType<typeof initSyncSleep> {
  syncSleepUI ??= initSyncSleep($('syncSleepRoot'), $('syncSleepHistoryRoot'), $('syncSleepReportRoot'), {
    loadD2, account: () => account.account?.id ?? 'local', user: () => currentUser, userLabel: () => userLabel(currentUser), notch: () => settings.notch,
    sleep: {
      canStart: () => sleepUI?.recording.canStart() ?? false,
      start: async (lengthS) => { await sleepUI?.recording.start(lengthS); },
      stop: async () => (await sleepUI?.recording.stop()) ?? null,
      isRecording: () => sleepUI?.isRecording() ?? false,
      elapsed: () => sleepUI?.recording.elapsed() ?? '',
    },
    openPolar: (id, back) => void sleepUI?.openReport(id, back),
    openWatch: (id, back, copy) => void openD2Night(id, back, copy),
    openPolarCopy: (copy, back) => void sleepUI?.openCopy(copy.session, copy.report, back),
    openEcg: (id) => void openReport(id),
    ecgDuring,
    show,
  });
  return syncSleepUI;
}

async function openD2Night(id: string, back: () => void, copy?: unknown): Promise<void> {
  if (!d2) { d2KeepPage = false; await openD2(); }
  d2KeepPage = true;
  await d2?.openNight(id, back, copy);
}

async function openD2(): Promise<void> {
  if (d2) { if (d2KeepPage) d2KeepPage = false; else d2.refresh(); return; }
  try {
    const api = await loadD2();
    const online = account.account && !account.account.offline;
    d2 = api.mount($('d2Root'), {
      account: account.account?.id ?? 'local', user: () => currentUser, userLabel: () => userLabel(currentUser),
      // D2 Link syncs its nights through the signed-in account (table d2_nights)
      cloud: online ? (supabase() as unknown as CloudClient) : null,
      // Settings → Biodata, sent to the watch as its profile with "Download all data" (only when height and weight are given)
      profile: biodataProfile,
      historyRoot: $('d2HistoryRoot'),
      ecgDuring,
      sleepChanged: () => { syncSleepUI?.schedule(); scheduleReports(); },
      openEcg: (id) => void openReport(id),
      showHistory: () => { if (!$('view-d2History').classList.contains('active')) { d2KeepPage = true; show('d2History'); } },
    });
  } catch (err) {
    $('d2Root').replaceChildren(make('p', 'muted', `D2 Link could not be loaded (${errorMessage(err)}). Check the internet connection and reopen the tab.`));
  }
}
for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button')) {
  b.addEventListener('click', () => { const v = b.dataset['view']; if (isView(v)) show(v); });
}

// ---------- Live acquisition ----------

interface Source { kind: 'polar' | 'demo'; stop: () => void | Promise<void> }

interface Recording {
  user: UserNumber;
  start: number; // epoch ms
  startSample: number; // value of `total` when recording started
  chunks: Int16Array[];
  n: number; // samples recorded
  userEvents: UserEvent[];
  detected: number[]; // seconds from start of detected events, for live counting
  limitS: number | null; // stops and saves at this length; null = until stopped
}

const trace = new LiveTrace($canvas('liveCanvas'), FS);
let filter = new EcgFilter(FS, settings.notch);
let source: Source | null = null;
const ring = new Float32Array(FS * RING_S);
let ringCount = 0;
let total = 0; // samples received since connect
let deviceHR: number | null = null;
let rec: Recording | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let drawing = false;

function setStatus(text: string, state: '' | 'on' | 'busy'): void {
  $('statusText').textContent = text;
  $('statusDot').className = `dot ${state}`;
}

const clip16 = (v: number): number => Math.max(-32768, Math.min(32767, Math.round(v)));

function onSamples(samples: Int32Array): void {
  const filtered = new Float32Array(samples.length);
  samples.forEach((s, i) => {
    filtered[i] = filter.process(s);
    ring[(total + i) % ring.length] = s;
  });
  total += samples.length;
  ringCount = Math.min(ring.length, ringCount + samples.length);
  trace.push(filtered);
  if (rec) {
    const c = Int16Array.from(samples, clip16);
    rec.chunks.push(c);
    rec.n += c.length;
  }
}

function setConnectButtonsHidden(hidden: boolean): void {
  for (const id of ['btnConnect', 'btnDemoRest', 'btnDemoWorkout']) $button(id).hidden = hidden;
  // pairing instructions only make sense while the Connect button can be used
  $('pairHint').hidden = hidden || $button('btnConnect').disabled;
  $button('btnDisconnect').hidden = !hidden;
}

function startSource(kind: Source['kind'], stop: Source['stop'], label: string): void {
  source = { kind, stop };
  filter = new EcgFilter(FS, settings.notch);
  ringCount = 0;
  total = 0;
  deviceHR = null;
  trace.clear();
  setStatus(label, 'on');
  $button('btnRecord').disabled = false;
  setConnectButtonsHidden(true);
  tickTimer = setInterval(tick, 1000);
  if (!drawing) {
    drawing = true;
    const loop = (): void => { if (!source) { drawing = false; return; } trace.draw(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
}

async function stopSource(reason = 'Not connected'): Promise<void> {
  if (rec) await stopRecording();
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  const s = source;
  source = null;
  if (s) await s.stop();
  setStatus(reason, '');
  $('battery').textContent = '';
  $button('btnRecord').disabled = true;
  $button('btnEvent').disabled = true;
  setConnectButtonsHidden(false);
  for (const id of ['liveHR', 'liveHRV', 'livePNN', 'liveZone']) $(id).textContent = '--';
  const strap = currentStrap(); // a demo stopped while the strap is connected: back to the strap
  if (strap) useStrap(strap);
}

function btLog(line: string): void {
  const el = $('btLog');
  const t = new Date().toLocaleTimeString([], { hour12: false });
  el.textContent += `${t}  ${line}\n`;
  el.scrollTop = el.scrollHeight;
}

$button('btnConnect').addEventListener('click', () => void connectPolar());
$('forgetLiveSlot').replaceWith(forgetStrapButton(btLog).el);

/** What ECG live does with the shared strap: shows its ECG (unless a demo is running; then when the demo stops). */
let liveStrap: PolarH10 | null = null;
function useStrap(p: PolarH10): void {
  if (liveStrap !== p) {
    liveStrap = p;
    p.addEventListener('ecg', (e) => { if (source?.kind === 'polar') onSamples((e as CustomEvent<EcgDetail>).detail.samples); });
    p.addEventListener('hr', (e) => { deviceHR = (e as CustomEvent<HrDetail>).detail.hr; });
    p.addEventListener('battery', (e) => {
      const lvl = (e as CustomEvent<BatteryDetail>).detail.level;
      if (source?.kind === 'polar') $('battery').textContent = `Battery ${lvl}%${lvl < 50 ? ' – signal quality drops below 50 %' : ''}`;
    });
    p.addEventListener('disconnect', () => {
      if (source?.kind !== 'polar' || currentStrap() === p) return; // a night's recording is getting it back
      btLog('Sensor disconnected');
      void stopSource('Sensor disconnected');
    });
  }
  if (source) return;
  if (p.ecgOk) startSource('polar', () => disconnectStrap(), `${p.name} – streaming ECG`);
  else {
    startSource('polar', () => disconnectStrap(), `${p.name} – heart rate only (ECG unavailable)`);
    $('statusDot').className = 'dot busy';
    $button('btnRecord').disabled = true; // recordings need the ECG stream
  }
}

async function connectPolar(): Promise<void> {
  const log = $('btLog');
  log.textContent = '';
  log.hidden = false;
  setStatus('Connecting…', 'busy');
  try {
    await connectStrap(btLog);
  } catch (err) {
    const cancelled = errorName(err) === 'NotFoundError';
    btLog(cancelled ? 'No strap chosen (the list was closed or cancelled)' : `Error: ${errorName(err)}: ${errorMessage(err)}`);
    setStatus(cancelled ? 'No device selected' : `Connection failed: ${errorMessage(err)}`, '');
  }
}

function startDemo(scenario: Scenario): void {
  const sim = new EcgSimulator({ scenario, seed: Date.now() & 0xffff });
  sim.start(onSamples);
  startSource('demo', () => sim.stop(), `Demo signal (${scenario})`);
  $('battery').textContent = 'Simulated';
}
$button('btnDemoRest').addEventListener('click', () => startDemo('rest'));
$button('btnDemoWorkout').addEventListener('click', () => startDemo('workout'));
$button('btnDisconnect').addEventListener('click', () => {
  // the strap is shared: during a night's recording it stays connected
  if (source?.kind === 'polar' && sleepUI?.isRecording()) { setStatus('The strap is recording on Sleep monitor', 'on'); return; }
  void stopSource();
});

function ringWindow(): Float32Array {
  const n = ringCount;
  const out = new Float32Array(n);
  const start = total - n;
  for (let i = 0; i < n; i++) out[i] = ring[(start + i) % ring.length] ?? 0;
  return out;
}

function zoneOf(hr: number): { z: string; pct: number } {
  const pct = hr / settings.hrMax;
  if (pct < 0.5) return { z: '–', pct };
  return { z: `Z${Math.min(5, Math.floor((pct - 0.5) / 0.1) + 1)}`, pct };
}

function tick(): void {
  if (!source) return;
  if (rec) {
    const elapsed = rec.n / FS;
    $('timer').textContent = fmtTime(rec.limitS == null ? elapsed : Math.ceil(Math.max(0, rec.limitS - elapsed)));
    if (rec.limitS != null && elapsed >= rec.limitS) { void finishRecording(); return; }
    if (elapsed >= SPLIT_S) { void stopRecording().then(() => startRecording()); return; }
  }
  if (ringCount < 5 * FS) {
    if (deviceHR) $('liveHR').textContent = String(deviceHR);
    return;
  }
  const win = ringWindow();
  const a = analyze(win, { fs: FS, notch: settings.notch, qtcFormula: settings.qtcFormula });
  const recentRR = a.beats.slice(-6).flatMap((b) => (b.rr && !b.flags.length ? [b.rr] : []));
  const hr = recentRR.length >= 2 ? 60000 / (recentRR.reduce((s, v) => s + v, 0) / recentRR.length) : deviceHR;
  if (hr) $('liveHR').textContent = String(Math.round(hr));
  const h = hrvStats(a.beats);
  if (h.nnCount >= 10) {
    $('liveHRV').textContent = String(Math.round(h.hrvScore));
    $('liveRMSSD').textContent = `RMSSD ${Math.round(h.rmssd)} ms`;
    $('livePNN').textContent = String(Math.round(h.pnn50));
  }
  if (hr) {
    const z = zoneOf(hr);
    $('liveZone').textContent = z.z;
    $('liveZonePct').textContent = `${Math.round(z.pct * 100)} % of max HR`;
  }

  if (rec) {
    // events from the sliding window, skipping its edges, de-duplicated by time
    const r = rec;
    const winStartS = (total - win.length) / FS - r.startSample / FS;
    const winS = win.length / FS;
    for (const e of a.events) {
      if (e.t < 3 || e.t > winS - 0.6) continue;
      const t = winStartS + e.t;
      if (t < 0 || r.detected.some((d) => Math.abs(d - t) < 0.3)) continue;
      r.detected.push(t);
      if (settings.alertEvents) alert('event');
    }
    const beatsSoFar = Math.max(1, ((r.n / FS) * (hr || 60)) / 60);
    const pct = (100 * r.detected.length) / beatsSoFar;
    $('liveEvents').textContent = String(r.detected.length);
    $('liveEventPct').textContent = `${pct.toFixed(1)} % of beats`;
    if (settings.alertZone && hr) {
      if (hr < settings.zoneMin) alert('low');
      else if (hr > settings.zoneMax) alert('high');
    }
    if (settings.alertPnn50 && h.nnCount >= 30 && h.pnn50 > 45) alert('pnn50');
  }
}

// ---------- Alerts ----------

type AlertKind = 'low' | 'high' | 'pnn50' | 'event';
const ALERT_SOUNDS: Readonly<Record<AlertKind, readonly [number, number, number]>> = {
  low: [880, 500, 1], high: [880, 500, 2], pnn50: [330, 150, 1], event: [330, 150, 1],
};

let audio: AudioContext | null = null;
const lastAlert: Partial<Record<AlertKind, number>> = {};

function beep(freq: number, ms: number, count = 1): void {
  try {
    audio ??= new AudioContext();
    for (let i = 0; i < count; i++) {
      const o = audio.createOscillator(), g = audio.createGain();
      const t = audio.currentTime + i * (ms / 1000 + 0.15);
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
      o.connect(g).connect(audio.destination);
      o.start(t); o.stop(t + ms / 1000 + 0.05);
    }
  } catch { /* audio unavailable */ }
}

function alert(kind: AlertKind): void {
  const now = Date.now();
  if (now - (lastAlert[kind] ?? 0) < (kind === 'event' ? 2000 : 15000)) return;
  lastAlert[kind] = now;
  const [freq, ms, count] = ALERT_SOUNDS[kind];
  beep(freq, ms, count);
  if (settings.vibrate && 'vibrate' in navigator) navigator.vibrate(count === 2 ? [300, 150, 300] : [200]);
}
$button('btnTestAlert').addEventListener('click', () => { beep(880, 500, 2); setTimeout(() => beep(330, 150), 1500); });

// ---------- Recording ----------

let wakeLock: WakeLockSentinel | null = null;

async function requestWakeLock(): Promise<void> {
  try { wakeLock = 'wakeLock' in navigator ? await navigator.wakeLock.request('screen') : null; } catch { /* not supported */ }
}

/** The length chosen in "Record for"; null = until stopped. */
const recordingLength = (): number | null => durationSeconds(byId('recDuration', HTMLSelectElement).value, $input('recMinutes').value);

/** Shows the chosen length on the timer and locks the choice while recording. */
function showRecLength(): void {
  const choice = byId('recDuration', HTMLSelectElement);
  $('recMinutesLabel').hidden = choice.value !== 'custom';
  choice.disabled = rec != null;
  $input('recMinutes').disabled = rec != null;
  if (!rec) $('timer').textContent = fmtTime(recordingLength() ?? 0);
}

async function startRecording(): Promise<void> {
  const limitS = recordingLength();
  rec = { user: currentUser, start: Date.now(), startSample: total, chunks: [], n: 0, userEvents: [], detected: [], limitS };
  showRecLength();
  syncUserSelect();
  const btn = $button('btnRecord');
  btn.textContent = 'Stop';
  btn.classList.add('recording');
  $button('btnEvent').disabled = false;
  $('liveEvents').textContent = '0';
  $('timer').textContent = fmtTime(limitS ?? 0);
  try { audio ??= new AudioContext(); } catch { /* ignore */ }
  await requestWakeLock();
}

async function stopRecording(): Promise<Session | null> {
  const r = rec;
  rec = null;
  const btn = $button('btnRecord');
  btn.textContent = 'Start';
  btn.classList.remove('recording');
  showRecLength();
  $button('btnEvent').disabled = true;
  try { await wakeLock?.release(); } catch { /* ignore */ }
  wakeLock = null;
  syncUserSelect();
  if (!r || r.n < 10 * FS) {
    $('timer').textContent = 'Too short to save (min 10 s)';
    return null;
  }
  const all = new Int16Array(r.n);
  let o = 0;
  for (const c of r.chunks) { all.set(c, o); o += c.length; }
  // a chosen length is kept exactly (the timer checks once a second, so a little more may have arrived)
  const samples = r.limitS == null ? all : all.slice(0, Math.min(r.n, Math.round(r.limitS * FS)));
  const session: Session = {
    id: `s${r.start}`,
    user: r.user,
    start: r.start,
    durationS: samples.length / FS,
    fs: FS,
    alias: settings.alias,
    source: source?.kind ?? 'polar',
    userEvents: r.userEvents,
    summary: null,
  };
  await store.saveSession(session, samples);
  historyChanged();
  $('timer').textContent = `Saved ${fmtTime(session.durationS)}`;
  return session;
}

/** The chosen time is up: saves like Stop. The report opens if ECG live is showing; otherwise you stay on your page. */
async function finishRecording(): Promise<void> {
  const s = await stopRecording();
  if (!s) return;
  if ($('view-live').classList.contains('active')) await openReport(s.id);
  else await summarise(s.id);
}

$('recDuration').addEventListener('change', showRecLength);
$('recMinutes').addEventListener('input', showRecLength);

$button('btnRecord').addEventListener('click', () => {
  void (async () => {
    if (rec) {
      const s = await stopRecording();
      if (s) await openReport(s.id);
    } else {
      await startRecording();
    }
  })();
});
$button('btnEvent').addEventListener('click', () => {
  if (!rec) return;
  rec.userEvents.push({ t: rec.n / FS, label: 'Marked' });
  beep(660, 80);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && rec && !wakeLock) void requestWakeLock();
});

// ---------- History ----------

/** Gives a recording from before the trend figures were kept its figures. */
async function fillTrend(s: Session): Promise<Session | null> {
  let metrics: SessionMetrics | null = null;
  if (s.cloudOnly) metrics = parseEcgSummary(await store.loadSummaryCopy(s.id))?.metrics ?? null;
  else {
    const { samples } = await store.loadSession(s.id);
    if (samples) metrics = sessionMetrics(analyze(samples, { fs: s.fs, notch: settings.notch, qtcFormula: settings.qtcFormula, ignoreShape: s.ignoreShape === true }), s.durationS, { hrRest: settings.hrRest, hrMax: settings.hrMax, sex: settings.sex });
  }
  if (!metrics) return null;
  const filled: Session = { ...s, summary: { meanHR: metrics.meanHR, hrvScore: metrics.hrvScore, eventCount: metrics.eventCount, trend: trendValues(metrics) } };
  await store.updateSession(filled);
  return filled;
}

const trends = initTrends($('ecgTrends'), { fill: fillTrend });

async function renderHistory(): Promise<void> {
  const list = $('sessionList');
  let sessions: Session[] = [];
  try { sessions = await store.listSessions(currentUser); } catch { /* storage blocked */ }
  // watch strips saved before v1.41.1 whose heart rate came out blank (a burst at the start hid the beats): worked out again
  const blank = sessions.filter((s) => s.source === 'watch' && !s.cloudOnly && s.summary && !Number.isFinite(s.summary.meanHR));
  if (blank.length) {
    for (const s of blank) { await store.updateSession({ ...s, summary: null }); await summarise(s.id); }
    try { sessions = await store.listSessions(currentUser); } catch { /* storage blocked */ }
  }
  $('historyUser').textContent = `· ${userLabel(currentUser)}`;
  list.replaceChildren();
  $('emptyHistory').hidden = sessions.some((s) => s.source !== 'watch');
  trends.show(sessions.filter((s) => s.source !== 'watch')); // 30-second watch strips have their own section
  // synchronised trackings with watch ECG strips: one box with both readings, opening both ECGs together
  const pairs = store.loadSyncHistory().filter((e) => e.user === currentUser && e.ecgId).flatMap((e) => {
    const end = e.start + e.durationS * 1000;
    const strips = sessions.filter((s) => s.source === 'watch' && s.start < end && s.start + s.durationS * 1000 > e.start);
    const polar = sessions.find((s) => s.id === e.ecgId);
    return strips.length && polar ? [{ e, strips, polar }] : [];
  });
  const stripList = $('watchStripList');
  stripList.replaceChildren();
  const stripCount = sessions.filter((s) => s.source === 'watch').length;
  $('watchStripsSection').hidden = stripCount === 0;
  $('watchStripCount').textContent = stripCount ? `(${stripCount})` : '';
  const rows: ({ kind: 'one'; s: Session } | { kind: 'pair'; p: (typeof pairs)[number] })[] = [
    ...sessions.map((s) => ({ kind: 'one' as const, s })), ...pairs.map((p) => ({ kind: 'pair' as const, p })),
  ].sort((a, b) => (b.kind === 'one' ? b.s.start : b.p.e.start + 1) - (a.kind === 'one' ? a.s.start : a.p.e.start + 1));
  for (const row of rows) {
    if (row.kind === 'pair') {
      const { e, strips, polar } = row.p;
      const li = make('li', 'pair-row');
      li.append(
        make('span', 'when', `${new Date(e.start).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · From Synchronised Tracking`),
        make('span', 'stats pair-stats', trackingLine(e, false, !!polar, strips.length > 0)),
      );
      li.addEventListener('click', () => {
        openSync();
        syncUI?.openPair(e.id, { label: 'ECG history and trending', go: () => show('history') });
      });
      list.appendChild(li);
      continue;
    }
    const s = row.s;
    const sum = s.summary;
    const stats = sum
      ? `HR ${Math.round(sum.meanHR) || '--'} bpm · HRV ${Number.isFinite(sum.hrvScore) ? Math.round(sum.hrvScore) : '--'} · ${sum.eventCount} events`
      : 'Open to analyse';
    const li = make('li');
    li.append(
      make('span', 'when', new Date(s.start).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })),
      make('span', 'dur', [s.alias, s.source === 'demo' ? 'demo' : s.source === 'import' ? 'imported' : s.source === 'watch' ? (s.watchFs || s.cloudOnly ? 'Watch D2 ECG' : 'Watch D2 ECG · saved before v1.41.0, may be damaged') : '', s.sleepId ? 'with sleep' : '', s.syncTracking ? 'from synchronised tracking' : '', s.ignoreShape ? 'ignoring irregular shape' : '', s.cloudOnly ? 'summary copy' : ''].filter(Boolean).join(' · ')),
      make('span', 'stats', `${stats} · ${fmtTime(s.durationS)}`),
    );
    li.appendChild(deleteButton('this recording', async () => {
      await store.deleteSession(s.id);
      historyChanged();
      void renderHistory();
    }, 'Delete this recording? You can get it back from the Recovery centre. It is also removed from your other devices.'));
    li.addEventListener('click', () => void openReport(s.id));
    (s.source === 'watch' ? stripList : list).appendChild(li); // watch strips go in their own section below
  }
}

// labels of automatically detected events; on import these are recomputed instead of kept
const DETECTED_LABELS: readonly string[] = [EVENT_LABELS.premature, EVENT_LABELS.pause, EVENT_LABELS.shape];

const importInput = $input('importFile');
importInput.addEventListener('change', () => void importEdf());

async function importEdf(): Promise<void> {
  const file = importInput.files?.[0];
  importInput.value = '';
  if (!file) return;
  try {
    const edf = readEdf(await file.arrayBuffer());
    const samples = Int16Array.from(edf.samples, clip16);
    const session: Session = {
      id: `s${Date.now()}`,
      user: currentUser,
      start: edf.start,
      durationS: samples.length / edf.fs,
      fs: edf.fs,
      alias: edf.alias,
      source: 'import',
      userEvents: edf.events.filter((ev) => !DETECTED_LABELS.includes(ev.label)),
      summary: null,
    };
    await store.saveSession(session, samples);
    historyChanged();
    await openReport(session.id);
  } catch (err) {
    window.alert(`Could not import ${file.name}: ${errorMessage(err)}`);
  }
}

// ---------- Report ----------

interface CurrentReport {
  session: Session;
  samples: Int16Array | null; // null for a summary copy
  analysis: Analysis;
  metrics: SessionMetrics;
  events: ReportEvent[];
  copy: EcgSummary | null; // set for a summary copy from another device
}

const charts = [...document.querySelectorAll<HTMLElement>('#view-report .chart')].map((f) => new Plot(f));
const [hrPlot, beatPlot, poincarePlot, qtcPlot] = charts;
if (!hrPlot || !beatPlot || !poincarePlot || !qtcPlot) throw new Error('report needs four charts');
const viewer = new EcgViewer($canvas('viewerCanvas'));
let current: CurrentReport | null = null;

const viewerPos = $input('viewerPos');
viewer.addEventListener('move', () => {
  if (!viewer.duration) return;
  const span = Math.max(0.001, viewer.duration - viewer.span);
  viewerPos.value = String(Math.round((viewer.t0 / span) * 1000));
  $('viewerTime').textContent = `${fmtTime(viewer.t0)} / ${fmtTime(viewer.duration)}`;
});
viewerPos.addEventListener('input', () => viewer.goTo((Number(viewerPos.value) / 1000) * (viewer.duration - viewer.span)));
$button('zoomIn').addEventListener('click', () => viewer.zoom(1 / 1.5));
$button('zoomOut').addEventListener('click', () => viewer.zoom(1.5));


/** Works out a saved recording's list summary (HR, HRV, events) without opening it, as opening it would. */
async function summarise(id: string): Promise<void> {
  const { session, samples } = await store.loadSession(id);
  if (!session || !samples || session.summary || session.cloudOnly) return;
  const analysis = analyze(samples, { fs: session.fs, notch: settings.notch, qtcFormula: settings.qtcFormula, ignoreShape: session.ignoreShape === true });
  const metrics = sessionMetrics(analysis, session.durationS, { hrRest: settings.hrRest, hrMax: settings.hrMax, sex: settings.sex });
  await store.updateSession({ ...session, summary: { meanHR: metrics.meanHR, hrvScore: metrics.hrvScore, eventCount: analysis.events.length, trend: trendValues(metrics) } });
  if ($('view-history').classList.contains('active')) void renderHistory();
}

// "Ignore Irregular Shape": for the recording it was turned on for only; opening another one shows its original version
let ignoreShapeFor: string | null = null;
/** Whether Irregular Shape is ignored: always for a row saved ignoring it, otherwise only where the button was turned on. */
function ignoringShape(s: Session | null = current?.session ?? null): boolean {
  return s?.ignoreShape === true || (s != null && s.id === ignoreShapeFor);
}
function showIgnoreShape(): void {
  const b = $button('btnIgnoreShape'), s = current?.session ?? null, on = ignoringShape(s), fixed = s?.ignoreShape === true;
  b.setAttribute('aria-pressed', String(on));
  b.classList.toggle('primary', on);
  b.disabled = fixed;
  b.title = fixed ? 'This row was saved ignoring irregular shape, so it is always shown that way' : 'Count beats flagged only for their shape as ordinary beats, in every figure and on the ECG';
  b.textContent = on ? 'Ignoring Irregular Shape ✓' : 'Ignore Irregular Shape';
  const save = $button('btnSaveNoShape');
  save.hidden = !on;
  save.disabled = !current?.samples; // a summary copy has no ECG here to save
  save.title = current?.samples ? 'Save this recording as a new row in ECG history, always ignoring irregular shape' : 'A summary copy from another device can’t be saved again here';
}

/** "Save ignoring irregular shape": a new row with the same ECG and marks, analysed without Irregular Shape; never twice. */
async function saveWithoutShape(): Promise<void> {
  const c = current;
  if (!c?.samples) return;
  const from = c.session.derivedFrom ?? c.session.id;
  const same = c.session.ignoreShape ? c.session : (await store.listSessions(store.sessionUser(c.session)))
    .find((s) => s.ignoreShape && s.derivedFrom === from && JSON.stringify(s.userEvents) === JSON.stringify(c.session.userEvents));
  if (same) {
    window.alert(`Not saved again: this recording is already saved ignoring irregular shape, exactly the same (the row of ${new Date(same.start).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} marked “ignoring irregular shape” in ECG history).`);
    return;
  }
  const { synced: _s, cloudOnly: _c, sleepId: _sl, syncTracking: _st, summary: _sum, ...base } = c.session;
  const copy: Session = { ...base, id: `x${Date.now()}`, ignoreShape: true, derivedFrom: from, summary: { meanHR: c.metrics.meanHR, hrvScore: c.metrics.hrvScore, eventCount: c.analysis.events.length, trend: trendValues(c.metrics) } };
  await store.saveSession(copy, c.samples);
  historyChanged();
  account.cloud?.syncSoon();
  window.alert('Saved as a new row in ECG history, marked “ignoring irregular shape”. The original recording is unchanged.');
}

async function openReport(id: string): Promise<void> {
  if (id !== ignoreShapeFor) ignoreShapeFor = null; // another recording opens as it was recorded
  show('report');
  const busy = $('reportBusy'), body = $('reportBody');
  busy.hidden = false;
  body.hidden = true;
  await new Promise((r) => setTimeout(r, 30)); // let the busy state paint
  const { session, samples } = await store.loadSession(id);
  if (session?.cloudOnly) { await openSummaryCopy(session); return; }
  if (!session || !samples) { busy.textContent = 'Recording not found.'; return; }
  const ignore = ignoringShape(session);
  const analysis = analyze(samples, { fs: session.fs, notch: settings.notch, qtcFormula: settings.qtcFormula, ignoreShape: ignore });
  const metrics = sessionMetrics(analysis, session.durationS, { hrRest: settings.hrRest, hrMax: settings.hrMax, sex: settings.sex });
  const events: ReportEvent[] = [
    ...analysis.events.map((e) => ({ t: e.t, type: e.type, label: EVENT_LABELS[e.type] })),
    ...session.userEvents.map((e): ReportEvent => ({ t: e.t, type: 'user', label: e.label || 'Marked' })),
  ].sort((a, b) => a.t - b.t);
  current = { session, samples, analysis, metrics, events, copy: null };

  if (ignore === (session.ignoreShape === true)) { // the recordings list and trends keep each row's own figures
    session.summary = { meanHR: metrics.meanHR, hrvScore: metrics.hrvScore, eventCount: analysis.events.length, trend: trendValues(metrics) };
    store.updateSession(session).catch(() => {});
  }

  renderReport(current);
  busy.hidden = true;
  body.hidden = false;
  charts.forEach((p) => p.draw());
  viewer.load(analysis, events);
  viewer.dispatchEvent(new Event('move'));
}

/** A recording synced from another device: its stored results, the first 30 s and the event strips. */
async function openSummaryCopy(session: Session): Promise<void> {
  if (session.id !== ignoreShapeFor) ignoreShapeFor = null;
  const busy = $('reportBusy'), body = $('reportBody');
  const stored = parseEcgSummary(await store.loadSummaryCopy(session.id));
  if (!stored) { busy.textContent = 'This summary copy could not be read.'; return; }
  // the version ignoring Irregular Shape is only shown when asked for
  const noShape = ignoringShape(session) ? withoutShape(stored) : null;
  const copy = noShape ?? stored;
  const stripAnalysis = analyze(base64ToInt16(copy.strip.data), { fs: copy.fs, notch: copy.analysedWith.notch, qtcFormula: copy.analysedWith.qtcFormula , ignoreShape: ignoringShape(session) });
  // the report's charts use the stored average beat; there are no per-beat values in a summary copy
  const analysis: Analysis = {
    ...stripAnalysis, beats: [], events: [],
    template: copy.template ? Float64Array.from(copy.template) : null, templateMeasure: copy.templateMeasure,
    templatePre: copy.templatePre, polarity: copy.polarity,
  };
  // a copy's figures were worked out on the other device, so only its events and strips can leave Irregular Shape out
  const events = ignoringShape(session) && !noShape ? copy.events.filter((e) => e.type !== 'shape') : copy.events;
  current = { session, samples: null, analysis, metrics: copy.metrics, events, copy };
  renderReport(current);
  busy.hidden = true;
  body.hidden = false;
  charts.forEach((p) => p.draw());
  showStrip(copy, null);
}

/** Shows the first 30 s (event null) or the 10 s strip around an event of a summary copy in the viewer. */
function showStrip(copy: EcgSummary, event: ReportEvent | null): void {
  const strip = event ? copy.eventStrips.find((s) => Math.abs(s.t - event.t) < 0.01) : copy.strip;
  if (!strip) return;
  const a = analyze(base64ToInt16(strip.data), { fs: copy.fs, notch: copy.analysedWith.notch, qtcFormula: copy.analysedWith.qtcFormula , ignoreShape: ignoringShape() });
  const end = strip.start + a.x.length / copy.fs;
  const marks = copy.events.filter((e) => e.type === 'user' && e.t >= strip.start && e.t <= end).map((e) => ({ ...e, t: e.t - strip.start }));
  viewer.load(a, marks);
  if (event) { viewer.span = Math.min(viewer.duration, 10); viewer.center(event.t - strip.start); }
  const label = $('viewerLabel');
  label.hidden = false;
  label.textContent = event
    ? `Showing the 10 s around “${event.label}” at ${fmtTime(event.t)} (summary copy)`
    : `Showing the first ${Math.round(a.x.length / copy.fs)} s of the recording (summary copy). Click an event below to see its strip.`;
  viewer.dispatchEvent(new Event('move'));
}


/** The ECG result tiles (rhythm and waves) with reference ranges; out-of-range values go into `sink`. */
function ecgTileGroups(m: SessionMetrics, sink: Outlier[]): { rhythm: HTMLDivElement[]; waves: HTMLDivElement[]; exercise: boolean; maxSeen: number } {
  const metric = (k: string, v: string, unit: string, hint = '', ref?: MetricRef | null): HTMLDivElement => metricTile(k, v, unit, hint, ref, sink);
  const qtcName = settings.qtcFormula === 'fridericia' ? 'Fridericia' : 'Bazett';
  const R = referenceRanges(settings);
  // resting norms don't apply when much of the recording was exercise (above 60 % of max HR)
  const [, , z2, z3, z4, z5] = m.zones;
  const timed = m.zones.reduce((a, b) => a + b, 0) || 1;
  const exercise = (z2 + z3 + z4 + z5) / timed > 0.3;
  const ref = (key: keyof ReferenceRanges, value: number | null | undefined): MetricRef => (exercise && R[key].rest
    ? { skipped: 'Resting range not applied (exercise)' }
    : { range: R[key], value });
  const rhythm = [
    metric('Mean heart rate', fmt(m.meanHR), 'bpm', 'from normal beats', ref('meanHR', m.meanHR)),
    metric('HRV score', fmt(m.hrvScore), '', '15 × ln(RMSSD)', ref('hrvScore', m.hrvScore)),
    metric('RMSSD', fmt(m.rmssd), 'ms', '', ref('rmssd', m.rmssd)),
    metric('SDNN', fmt(m.sdnn), 'ms', '', ref('sdnn', m.sdnn)),
    metric('pNN50', fmt(m.pnn50, 1), '%', 'successive Δ > 50 ms', ref('pnn50', m.pnn50)),
    metric('pNN200', fmt(m.pnn200, 1), '%', 'successive Δ > 200 ms', ref('pnn200', m.pnn200)),
    metric('Poincaré SD1 / SD2', `${fmt(m.sd1)} / ${fmt(m.sd2)}`, 'ms'),
    metric('Events', String(m.eventCount), '', `${fmt(m.eventPct, 1)} % of beats`, { range: { ...R.eventPct, note: 'of beats' }, value: m.eventPct, display: `${fmt(m.eventPct, 1)} % of beats` }),
  ];
  const waves = [
    metric('QRS duration', fmt(m.qrs), 'ms', 'median beat', ref('qrs', m.qrs)),
    metric('QT', fmt(m.qt), 'ms', 'median beat'),
    metric('QTc', fmt(m.qtc), 'ms', `${qtcName}, median beat`, ref('qtc', m.qtc)),
    metric('T wave positive', fmt(m.tPositive), '%', '', ref('tPositive', m.tPositive)),
    metric('T-wave amplitude', fmt(m.tAmp), 'µV', 'median, vs PR baseline', ref('tAmp', m.tAmp)),
    metric('T/R ratio', fmt(m.trRatio, 2), '', 'T size ÷ R wave size, median', ref('trRatio', m.trRatio)),
    metric('J point', fmt(m.jPoint), 'µV', 'vs PR baseline', ref('jPoint', m.jPoint)),
    metric('ST at J+60 ms', fmt(m.st60), 'µV', '', ref('st60', m.st60)),
    metric('R amplitude', fmt(m.rAmp), 'µV', 'tallest upward wave; no reference range'),
    metric('S amplitude', fmt(Math.abs(m.sAmp)), 'µV', 'depth of the deepest downward wave; no reference range'),
    metric('2–8 Hz energy', fmt(m.hf, 1), '%', 'can include noise; no reference range'),
  ];
  const maxSeen = Math.max(0, ...m.hr.filter((v): v is number => v != null));
  return { rhythm, waves, exercise, maxSeen };
}

function renderReport({ session, analysis, metrics: m, events }: CurrentReport): void {
  showIgnoreShape();
  $('reportTitle').textContent = new Date(session.start).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' }) + (ignoringShape() ? ' · Irregular Shape ignored' : '');
  const copy = current?.copy ?? null;
  const note = $('reportCopyNote');
  note.hidden = !copy;
  if (copy) {
    const aw = copy.analysedWith;
    note.textContent = `Summary copy from another device: the results, heart-rate trend, average beat, first 30 s and ${copy.eventStrips.length} event strip${copy.eventStrips.length === 1 ? '' : 's'}. `
      + 'The full ECG stays on the device that recorded it. '
      + `Analysed with age ${aw.age}, ${aw.sex}, ${aw.qtcFormula === 'fridericia' ? 'Fridericia' : 'Bazett'} QTc; changing settings here doesn’t recalculate it.`
      + (ignoringShape() && !session.ignoreShape && !copy.noShape ? ' This copy was made before the version ignoring Irregular Shape was added: Irregular Shape is left out of its events and strips, but the figures stay as before until the device that recorded it syncs again.' : '');
  }
  $('reportMeta').textContent = [
    userLabel(store.sessionUser(session)),
    copy ? 'Summary copy' : store.biodataLine(settings),
    `Duration ${fmtTime(session.durationS)}`,
    `${m.beatCount} beats`,
    // the user label already shows the current alias; only mention one recorded under a different alias
    session.alias && !userLabel(store.sessionUser(session)).endsWith(`· ${session.alias}`) && `Alias ${session.alias}`,
    session.source === 'demo' ? 'Demo signal' : session.source === 'import' ? 'Imported EDF' : session.source === 'watch' ? 'Watch D2 (30-second ECG)' : 'Polar H10',
    session.sleepId ? 'Recorded with sleep monitor' : '',
    m.nnCount < 30 ? 'Short or noisy recording: HRV values are unreliable' : '',
  ].filter(Boolean).join(' · ');

  outliers = [];
  const g = ecgTileGroups(m, outliers);
  $('mRhythm').replaceChildren(...g.rhythm);
  $('mWaves').replaceChildren(...g.waves);
  const exercise = g.exercise, maxSeen = g.maxSeen;

  renderOutliers(exercise);
  renderCharts(analysis, m, maxSeen, copy !== null);
  renderEvents(events);
  for (const id of ['btnExportEdf', 'btnExportCsv']) {
    const b = $button(id);
    b.disabled = copy !== null;
    b.title = copy ? 'Needs the full ECG, which is on the device that recorded it' : '';
  }
  $('viewerLabel').hidden = copy === null;
  // only offer the night's report while that night still exists on this device
  $button('btnOpenSleep').hidden = true;
  if (session.sleepId) void store.loadSleep(session.sleepId).then(({ session: night }) => { $button('btnOpenSleep').hidden = !night; });
}

/** "ECG during the night" in a sleep report: that night's ECG results, with a link to the full ECG report. */
async function renderNightEcg(box: HTMLElement, ecgId: string): Promise<void> {
  box.replaceChildren(make('p', 'muted', 'Analysing the sleep ECG…'));
  await new Promise((r) => setTimeout(r, 30)); // let the message paint before a long analysis
  const { session, samples } = await store.loadSession(ecgId);
  if (!session) { box.replaceChildren(make('p', 'muted', 'The ECG recorded with this sleep isn’t on this device (it may have been deleted).')); return; }
  let m: SessionMetrics;
  if (session.cloudOnly) {
    const copy = parseEcgSummary(await store.loadSummaryCopy(ecgId));
    if (!copy) { box.replaceChildren(make('p', 'muted', 'The sleep ECG summary could not be read.')); return; }
    m = copy.metrics;
  } else if (samples) {
    const a = analyze(samples, { fs: session.fs, notch: settings.notch, qtcFormula: settings.qtcFormula });
    m = sessionMetrics(a, session.durationS, { hrRest: settings.hrRest, hrMax: settings.hrMax, sex: settings.sex });
  } else {
    box.replaceChildren(make('p', 'muted', 'The sleep ECG signal is missing.'));
    return;
  }
  const sink: Outlier[] = [];
  const g = ecgTileGroups(m, sink);
  const flags = make('div', 'flags');
  renderOutlierBox(flags, sink, session.cloudOnly ? ['Summary copy from another device, as calculated there.'] : []);
  const grid = (els: HTMLElement[]): HTMLDivElement => { const d = make('div', 'metrics'); d.append(...els); return d; };
  const open = make('button', 'no-print', 'Open full ECG report');
  open.addEventListener('click', () => void openReport(ecgId));
  box.replaceChildren(
    make('p', 'muted', [`${fmtTime(session.durationS)} of ECG`, `${m.beatCount} beats`, `${m.eventCount} events`, session.cloudOnly ? 'summary copy' : ''].filter(Boolean).join(' · ')),
    flags, make('h4', '', 'Rhythm and HRV'), grid(g.rhythm), make('h4', '', 'ECG waves'), grid(g.waves), open,
  );
}

function renderOutliers(exercise: boolean): void {
  renderOutlierBox($('reportFlags'), outliers, exercise ? ['Exercise recording: resting ranges for heart rate and HRV are not applied.'] : []);
}



function renderCharts(analysis: Analysis, m: SessionMetrics, maxSeen: number, isCopy = false): void {
  // heart rate over time
  const stride = Math.max(1, Math.ceil(m.hr.length / 1500));
  const hrPts: Point[] = [];
  for (let i = 0; i < m.hr.length; i += stride) hrPts.push([i + 1, m.hr[i] ?? null]);
  hrPlot?.set({
    type: 'line', points: hrPts, xFmt: fmtTime, yLabel: 'bpm', xLabel: 'time',
    refLines: maxSeen >= 0.85 * settings.hrMax ? [{ y: 0.9 * settings.hrMax, label: '90 % max' }] : [],
    tooltip: (p) => `${fmtTime(p[0])} · <b>${Math.round(p[1])} bpm</b>`,
  });

  // median beat
  const fs = analysis.fs;
  const tm = analysis.templateMeasure;
  const pre = Math.round(analysis.templatePre * fs);
  const toMs = (i: number): number => ((i - pre) / fs) * 1000;
  beatPlot?.set({
    type: 'line',
    points: analysis.template ? Array.from(analysis.template, (v, i): Point => [toMs(i), v]) : [],
    xLabel: 'ms from main QRS peak', yLabel: 'µV', empty: 'Not enough clean beats',
    vLines: tm ? [
      { x: toMs(tm.onset), label: 'Q', row: 0 },
      { x: toMs(tm.offset), label: 'J', row: 1 },
      ...(tm.tEnd != null ? [{ x: toMs(tm.tEnd), label: 'T end', row: 0 }] : []),
    ] : [],
    tooltip: (p) => `${Math.round(p[0])} ms · <b>${Math.round(p[1])} µV</b>`,
  });

  // Poincaré
  const beats = analysis.beats;
  const poin: Point[] = [];
  for (let k = 2; k < beats.length; k++) {
    const b = beats[k], prev = beats[k - 1];
    if (!b?.rr || !prev?.rr) continue;
    poin.push([prev.rr, b.rr, b.flags.length > 0 || prev.flags.length > 0]);
  }
  const pStride = Math.max(1, Math.ceil(poin.length / 4000));
  poincarePlot?.set({
    type: 'scatter', identity: true, points: poin.filter((_, i) => i % pStride === 0),
    xLabel: 'RRₙ (ms)', yLabel: 'RRₙ₊₁ (ms)', ...(isCopy ? { empty: 'Not included in summary copies' } : {}),
    tooltip: (p) => `RRₙ ${Math.round(p[0])} ms → <b>${Math.round(p[1])} ms</b>${p[2] ? ' · event' : ''}`,
  });

  // RR vs QTc
  const qpts = beats.flatMap((b): Point[] => (b.m?.qtc && b.rr ? [[b.rr, b.m.qtc]] : []));
  const qStride = Math.max(1, Math.ceil(qpts.length / 4000));
  qtcPlot?.set({
    type: 'scatter', points: qpts.filter((_, i) => i % qStride === 0),
    xLabel: 'RR (ms)', yLabel: 'QTc (ms)', empty: isCopy ? 'Not included in summary copies' : 'No measurable T waves',
    tooltip: (p) => `RR ${Math.round(p[0])} ms · <b>QTc ${Math.round(p[1])} ms</b>`,
  });
}

/** The events Previous and Next step through (those that can be shown), and the one shown last (-1 = none yet). */
let navEvents: ReportEvent[] = [];
let navIndex = -1;

/** Shows event `i` on the ECG strip. */
function goToEvent(i: number, scroll = false): void {
  const e = navEvents[i];
  if (!e) return;
  navIndex = i;
  const copy = current?.copy ?? null;
  if (copy) showStrip(copy, e);
  else { viewer.span = Math.min(viewer.span, 6); viewer.center(e.t); }
  updateEventNav();
  if (scroll) $canvas('viewerCanvas').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function updateEventNav(): void {
  const n = navEvents.length, e = navEvents[navIndex];
  $button('btnPrevEvent').disabled = navIndex <= 0;
  $button('btnNextEvent').disabled = navIndex >= n - 1;
  $('eventNavText').textContent = !n ? 'No events' : e ? `Event ${navIndex + 1} of ${n} · ${e.label} at ${fmtTime(e.t)}` : `${n} event${n > 1 ? 's' : ''}`;
}

$button('btnPrevEvent').addEventListener('click', () => goToEvent(navIndex - 1));
$button('btnNextEvent').addEventListener('click', () => goToEvent(navIndex + 1));

function renderEvents(events: readonly ReportEvent[]): void {
  const artifacts = current?.analysis?.artifacts ?? 0;
  $('eventCount').textContent = `(${events.length})${artifacts ? ` · ${artifacts} likely connection error${artifacts > 1 ? 's' : ''} not counted` : ''}`;
  const list = $('eventList');
  list.replaceChildren();
  const copy = current?.copy ?? null;
  const hasStrip = (e: ReportEvent): boolean => !copy || copy.eventStrips.some((s) => Math.abs(s.t - e.t) < 0.01);
  navEvents = events.filter(hasStrip);
  navIndex = -1;
  updateEventNav();
  for (const e of events.slice(0, 500)) {
    const li = make('li');
    li.append(make('span', '', fmtTime(e.t)), make('span', `badge ${e.type}`, e.label));
    if (!hasStrip(e)) { li.classList.add('no-strip'); li.append(make('span', 'muted', 'no strip in summary copy')); }
    li.addEventListener('click', () => {
      const i = navEvents.indexOf(e);
      if (i >= 0) goToEvent(i, true);
    });
    list.appendChild(li);
  }
  if (events.length > 500) list.appendChild(make('li', 'muted', `…and ${events.length - 500} more (see the exports)`));
  renderEventPrints(events);
}

const PRINTED_EVENTS = 5;

/** The tracings of the first events, in the printed report only. */
function renderEventPrints(events: readonly ReportEvent[]): void {
  const box = $('eventPrint'), chosen = events.slice(0, PRINTED_EVENTS);
  box.replaceChildren();
  if (!current || !chosen.length) return;
  const { analysis, copy } = current;
  box.append(
    make('h3', '', events.length > PRINTED_EVENTS ? `First ${PRINTED_EVENTS} of ${events.length} event tracings` : 'Event tracings'),
    make('p', 'note', ECG_SCALE_NOTE),
  );
  for (const e of chosen) {
    const strip = copy?.eventStrips.find((s) => Math.abs(s.t - e.t) < 0.01);
    if (copy && !strip) continue;
    const signal = strip && copy ? analyze(base64ToInt16(strip.data), { fs: copy.fs, notch: copy.analysedWith.notch, qtcFormula: copy.analysedWith.qtcFormula , ignoreShape: ignoringShape() }) : analysis;
    const item = make('div', 'event-strip'), canvas = make('canvas');
    canvas.setAttribute('aria-label', `ECG at ${fmtTime(e.t)}`);
    item.append(make('p', '', `${fmtTime(e.t)} · ${e.label}`), canvas);
    box.appendChild(item);
    drawEventStrip(canvas, signal.x, signal.fs, e.t - (strip?.start ?? 0));
  }
}

$button('btnBack').addEventListener('click', () => show('history'));
$button('btnIgnoreShape').addEventListener('click', () => {
  const on = !ignoringShape();
  ignoreShapeFor = on ? current?.session.id ?? null : null;
  if (current) void (current.copy ? openSummaryCopy(current.session) : openReport(current.session.id));
});
$button('btnSaveNoShape').addEventListener('click', () => void saveWithoutShape());
$button('btnOpenSleep').addEventListener('click', () => { const id = current?.session.sleepId; if (id) void sleepUI?.openReport(id); });

$button('btnPrint').addEventListener('click', () => window.print());
$button('btnDelete').addEventListener('click', () => {
  void (async () => {
    if (!current || !window.confirm('Delete this recording? You can get it back from the Recovery centre.')) return;
    await store.deleteSession(current.session.id);
    historyChanged();
    current = null;
    show('history');
  })();
});

function fileStem(session: Session): string {
  const d = new Date(session.start);
  const p = (v: number): string => String(v).padStart(2, '0');
  return `ecg_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}


$button('btnExportEdf').addEventListener('click', () => {
  if (!current) return;
  const { session, samples, events } = current;
  if (!samples) return;
  download(writeEdf({ samples, fs: session.fs, start: session.start, alias: session.alias, sex: settings.sex, events }), `${fileStem(session)}.edf`);
});
$button('btnExportCsv').addEventListener('click', () => {
  if (!current) return;
  const rows: string[][] = [['time_s', 'rr_ms', 'hr_bpm', 'flags', 'qrs_ms', 'qt_ms', 'qtc_ms', 't_amp_uv', 'j_point_uv', 'st60_uv', 'r_amp_uv', 's_amp_uv']];
  const r = (v: number | null | undefined, d = 1): string => (v == null || !Number.isFinite(v) ? '' : v.toFixed(d));
  for (const b of current.analysis.beats) {
    rows.push([r(b.t, 3), r(b.rr), b.rr ? r(60000 / b.rr) : '', b.flags.join('|'), r(b.m?.qrs), r(b.m?.qt), r(b.m?.qtc),
      r(b.m?.tAmp, 0), r(b.m?.jAmp, 0), r(b.m?.st60, 0), r(b.m?.rAmp, 0), r(b.m?.sAmp, 0)]);
  }
  download(new Blob([rows.map((x) => x.join(',')).join('\n')], { type: 'text/csv' }), `${fileStem(current.session)}_beats.csv`);
});
$button('btnExportJson').addEventListener('click', () => {
  if (!current) return;
  const { session, metrics, events } = current;
  const { summary: _summary, ...sessionInfo } = session;
  const out = { app: 'OpenBeat ECG', session: sessionInfo, summaryCopy: current.copy !== null, settings: current.copy?.analysedWith ?? settings, metrics, referenceRanges: referenceRanges(settings), outliers, events };
  download(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }), `${fileStem(session)}_report.json`);
});

// ---------- Settings ----------

const form = byId('settingsForm', HTMLFormElement);
type FormField = HTMLInputElement | HTMLSelectElement;
const isSettingKey = (k: string): k is keyof Settings => k in settings;

/** Biodata that may be left out; 0 means not given. */
const OPTIONAL_FIELDS: ReadonlySet<string> = new Set(['heightCm', 'weightKg', 'waistCm']);

function fillSettings(): void {
  $('biodataUser').textContent = `· ${userLabel(currentUser)}`;
  const b = store.bmi(settings), w = store.waistToHeight(settings);
  $('bmiLine').textContent = [
    b ? `BMI ${b.toFixed(1)}` : 'Add height and weight to see BMI.',
    w ? `Waist-to-height ${w.toFixed(2)} (usual guide: under 0.5)` : '',
  ].filter(Boolean).join(' · ');
  for (const el of form.elements) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement) || !isSettingKey(el.name)) continue;
    const v = settings[el.name];
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = Boolean(v);
    else if (OPTIONAL_FIELDS.has(el.name) && v === 0) el.value = ''; // not given: leave the box empty
    else el.value = String(v);
  }
}

/** Writes one form field into settings, keeping each setting's type. */
function applyField(el: FormField): void {
  const key = el.name;
  if (!isSettingKey(key)) return;
  const current = settings[key];
  const s = settings as unknown as Record<keyof Settings, unknown>;
  if (typeof current === 'boolean' && el instanceof HTMLInputElement) s[key] = el.checked;
  else if (typeof current === 'number') {
    const n = Number(el.value);
    if (Number.isFinite(n)) s[key] = n;
  } else if (key === 'alias') settings.alias = el.value.replace(/[^\w\-. ]/g, '').slice(0, 40);
  else if (key === 'sex' && (el.value === 'male' || el.value === 'female')) settings.sex = el.value;
  else if (key === 'qtcFormula' && (el.value === 'bazett' || el.value === 'fridericia')) settings.qtcFormula = el.value;
  if (key === 'age' && settings.age > 0) settings.hrMax = Math.round(220 - settings.age);
}

form.addEventListener('change', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) return;
  applyField(el);
  store.saveSettings(currentUser, settings);
  account.cloud?.syncSoon(); // other devices get the change
  fillSettings();
  if (el.name === 'alias') { renderUserOptions(); fillSettings(); }
});
fillSettings();

// ---------- Users ----------

const userSelects = [byId('userSelect', HTMLSelectElement), byId('settingsUserSelect', HTMLSelectElement)];

/** "User 2" or "User 2 · Anna" when that user has an alias. */
function userLabel(user: UserNumber): string {
  const alias = user === currentUser ? settings.alias : store.loadSettings(user).alias;
  return alias ? `User ${user} · ${alias}` : `User ${user}`;
}

function renderUserOptions(): void {
  for (const sel of userSelects) {
    sel.replaceChildren(...store.USERS.map((u) => {
      const o = make('option', '', userLabel(u));
      o.value = String(u);
      return o;
    }));
    sel.value = String(currentUser);
  }
}

/** Switching user is blocked while recording, so a recording can't change owner halfway. */
function syncUserSelect(): void {
  const recording = rec !== null || (sleepUI?.isRecording() ?? false);
  for (const sel of userSelects) {
    sel.disabled = recording;
    sel.title = recording ? 'Stop the recording to switch user' : '';
  }
}

for (const sel of userSelects) {
  sel.addEventListener('change', () => {
    const next = Number(sel.value);
    if (rec || sleepUI?.isRecording() || !store.isUserNumber(next) || next === currentUser) { sel.value = String(currentUser); return; }
    currentUser = next;
    store.saveCurrentUser(next);
    settings = store.loadSettings(next);
    renderUserOptions(); // keeps both selectors showing the same user
    fillSettings();
    current = null;
    if ($('view-report').classList.contains('active')) show('history');
    else if ($('view-history').classList.contains('active')) void renderHistory();
    else if ($('view-sleepReport').classList.contains('active')) show('sleepHistory');
    else if ($('view-sleepHistory').classList.contains('active')) void sleepUI?.renderHistory();
    else if ($('view-recovery').classList.contains('active')) show('recovery');
    sleepUI?.refreshUser();
    syncSleepUI?.schedule();
  });
}
renderUserOptions();

// settings saved more recently on another device
account.cloud?.addEventListener('settings', () => {
  settings = store.loadSettings(currentUser);
  renderUserOptions();
  fillSettings();
});

// recordings arrived from (or were deleted on) another device
account.cloud?.addEventListener('changed', () => {
  syncSleepUI?.schedule();
  scheduleReports();
  if ($('view-syncHistory').classList.contains('active')) syncUI?.refreshHistory();
  if ($('view-syncSleepHistory').classList.contains('active')) void openSyncSleep().refreshHistory();
  if ($('view-history').classList.contains('active')) void renderHistory();
});

sleepUI = initSleep({
  renderNightEcg,
  ecgDuring,
  sleepChanged: () => { syncSleepUI?.schedule(); scheduleReports(); },
  user: () => currentUser,
  notch: () => settings.notch,
  userLabel,
  showSleepView: show,
  recordingChanged: syncUserSelect,
});
onStrap(useStrap);
openSyncSleep().schedule(); // sleep that arrived or changed while the app was closed
scheduleReports();
if (store.keepAll()) void navigator.storage?.persist?.().catch(() => undefined); // asks the browser not to clear this data when space runs low

// ---------- Reference sources ----------

$('refSources').replaceChildren(...SOURCES.map(([what, text]) => {
  const li = make('li');
  li.append(make('b', '', `${what}: `), text);
  return li;
}));

// ---------- Startup ----------

$('copyYear').textContent = String(Math.max(2026, new Date().getFullYear()));

if (!bluetoothAvailable() || !window.isSecureContext) {
  $button('btnConnect').disabled = true;
  $('pairHint').hidden = true; // pairing instructions don't apply without Bluetooth
  const note = $('btNote');
  note.hidden = false;
  note.textContent = !window.isSecureContext
    ? 'Bluetooth needs a secure page (https:// or localhost). Demo modes still work.'
    : 'This browser has no Web Bluetooth. Use Chrome or Edge on desktop/Android, or the Bluefy browser on iPhone/iPad. Demo modes still work.';
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
