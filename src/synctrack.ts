// Synchronised tracking: the Polar H10's ECG and the Watch D2's heartbeats side by side for a chosen time (1, 3 or 5 min,
// a custom time, or until stopped), plus a blood pressure reading taken on the watch within the hour after the start.
// The watch is reached through D2 Link (d2link.js); this page only uses what it offers.

import { PolarH10, ECG_FS, type EcgDetail, type HrDetail } from './polar';
import { EcgFilter } from './dsp';
import { LiveTrace } from './charts';
import { make } from './ui';
import * as store from './store';
import type { Session, SyncTrackingEntry, UserNumber } from './store';
import { historyChanged } from './account';
import { errorMessage, errorName } from './util';
import type { D2Api } from './d2/index'; // type only: D2 Link's code stays in d2link.js
import type { Beat, BloodPressure, LiveWatch } from './d2/live';

/** The watch's heartbeat test runs about a minute (as in Gadgetbridge); for longer tracking it is started again. */
export const WATCH_TEST_S = 55;
export const BP_WINDOW_MS = 3600000;

export interface SyncDeps {
  loadD2: () => Promise<D2Api>;
  account: () => string;
  user: () => number;
  notch: () => number;
  profile: () => { heightCm: number; weightKg: number; age: number; sex: 'male' | 'female' } | null;
  /** Why the strap can't be used here (in use on another page), or null. */
  polarBusy: () => string | null;
  /** Opens a saved recording's report in ECG history. */
  openEcg: (id: string) => void;
}

/** Recordings shorter than this aren't saved (as on ECG live). */
export const MIN_SAVE_S = 10;
const clip16 = (v: number): number => Math.max(-32768, Math.min(32767, Math.round(v)));

// ---------- numbers ----------

/** Beat intervals that can be used: good signal, 30–200 bpm. */
export const usable = (rr: readonly number[]): number[] => rr.filter((x) => x >= 300 && x <= 2000);

export function rmssd(rr: readonly number[]): number | null {
  const r = usable(rr);
  if (r.length < 3) return null;
  let s = 0;
  for (let i = 1; i < r.length; i++) s += (r[i]! - r[i - 1]!) ** 2;
  return Math.sqrt(s / (r.length - 1));
}

export function sdnn(rr: readonly number[]): number | null {
  const r = usable(rr);
  if (r.length < 3) return null;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
}

/** Heart rate from the last few intervals (bpm). */
/** m:ss */
export const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function hrFrom(rr: readonly number[], last = 5): number | null {
  const r = usable(rr).slice(-last);
  return r.length ? 60000 / (r.reduce((a, b) => a + b, 0) / r.length) : null;
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r0 = (v: number | null): string => (v == null ? '--' : String(Math.round(v)));
const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

// ---------- the page ----------

export function initSyncTracking(root: HTMLElement, deps: SyncDeps): { stop: () => void } {
  root.replaceChildren();
  root.append(make('h2', '', 'Synchronised tracking'), make('p', 'note',
    'The Polar H10’s ECG and the Watch D2’s heartbeats side by side. Wear both and connect both: the ECG shows as soon as the strap is connected. Choose how long to track, then start. Measure your blood pressure on the watch once, during the tracking or within one hour of the start.'));

  // --- 1. Polar H10 ---
  const polarCard = make('div', 'card');
  const polarStatus = make('div', 'status');
  const polarDot = make('span', 'dot'), polarText = make('span', '', 'Polar H10: not connected');
  polarStatus.append(polarDot, polarText);
  const btnPolar = make('button', 'primary', '1. Pair with Polar H10');
  const btnPolarOff = make('button', '', 'Disconnect');
  btnPolarOff.hidden = true;
  const polarRow = make('div', 'row wrap');
  polarRow.append(btnPolar, btnPolarOff);
  polarCard.append(polarStatus, polarRow, make('p', 'note', 'Chrome shows a list: click your Polar H10, then Pair.'));

  // --- 2. Watch D2 ---
  const watchCard = make('div', 'card');
  const watchStatus = make('div', 'status');
  const watchDot = make('span', 'dot'), watchText = make('span', '', 'Watch D2: not connected');
  watchStatus.append(watchDot, watchText);
  const via = make('select') as HTMLSelectElement;
  for (const [v, t] of [['bluetooth', 'Chrome Bluetooth'], ['mac', 'D2 Bridge app (Mac)']] as const) { const o = make('option', '', t) as HTMLOptionElement; o.value = v; via.appendChild(o); }
  try { const v = localStorage.getItem('d2link-via'); via.value = v === 'mac' || (v == null && /Mac/i.test(navigator.platform)) ? 'mac' : 'bluetooth'; } catch { /* default */ }
  const viaLabel = make('label', 'd2-days', 'Connect via ');
  viaLabel.appendChild(via);
  const btnWatch = make('button', 'primary', '2. Pair with Watch D2');
  const btnWatchOff = make('button', '', 'Disconnect');
  btnWatchOff.hidden = true;
  const watchRow = make('div', 'row wrap');
  watchRow.append(btnWatch, viaLabel, btnWatchOff);
  watchCard.append(watchStatus, watchRow, make('p', 'note', 'Switch off Bluetooth on the phone the watch is connected to. On a Mac, open the D2 Bridge app first. The watch only shares live heartbeats and blood pressure with its own account: enter the watch account ID in D2 Link first (its pairing is used here too).'));

  // --- 3. one minute ---
  const runCard = make('div', 'card controls');
  const timer = make('div', 'timer', '1:00');
  // how long: 1, 3 or 5 minutes, until stopped, or a chosen number of minutes
  const dur = make('select') as HTMLSelectElement;
  for (const [v, t] of [['60', '1 minute'], ['180', '3 minutes'], ['300', '5 minutes'], ['unlimited', 'Until I stop'], ['custom', 'Choose minutes…']] as const) {
    const o = make('option', '', t) as HTMLOptionElement; o.value = v; dur.appendChild(o);
  }
  const customMin = make('input') as HTMLInputElement;
  Object.assign(customMin, { type: 'number', min: '1', max: '240', step: '1', value: '10' });
  customMin.setAttribute('aria-label', 'Minutes');
  const customLabel = make('label', 'd2-days');
  customLabel.append(customMin, ' min');
  customLabel.hidden = true;
  const durLabel = make('label', 'd2-days', 'Track for ');
  durLabel.appendChild(dur);
  const durRow = make('div', 'row wrap sync-dur');
  durRow.append(durLabel, customLabel);
  /** The chosen length in seconds; null = until stopped. */
  const durationS = (): number | null => {
    if (dur.value === 'unlimited') return null;
    if (dur.value === 'custom') { const m = Math.round(Number(customMin.value)); return m >= 1 && m <= 240 ? m * 60 : 600; }
    return Number(dur.value);
  };
  const showDuration = (): void => {
    customLabel.hidden = dur.value !== 'custom';
    const d = durationS();
    if (timerId == null) timer.textContent = d == null ? '0:00' : mmss(d);
  };
  dur.addEventListener('change', showDuration);
  customMin.addEventListener('input', showDuration);
  const btnStart = make('button', 'primary big', '3. Start tracking') as HTMLButtonElement;
  btnStart.disabled = true;
  const btnStop = make('button', 'big', 'Stop') as HTMLButtonElement;
  btnStop.hidden = true;
  const runRow = make('div', 'row');
  runRow.append(btnStart, btnStop);
  const runNote = make('p', 'note', 'Connect at least one device. Sit still and breathe normally.');
  runCard.append(durRow, timer, runRow, runNote);

  // --- live values ---
  const tile = (label: string, unit: string): { el: HTMLElement; value: HTMLElement; sub: HTMLElement } => {
    const el = make('div', 'tile'), value = make('span', '', '--'), sub = make('div', 'sub', '');
    const v = make('div', 'value'); v.append(value, make('small', '', unit));
    el.append(make('div', 'label', label), v, sub);
    return { el, value, sub };
  };
  const tPolarHr = tile('Polar heart rate', 'bpm'), tPolarHrv = tile('Polar RMSSD', 'ms');
  const tWatchHr = tile('Watch heart rate', 'bpm'), tWatchRr = tile('Watch beat interval', 'ms');
  const tWatchHrv = tile('Watch RMSSD', 'ms'), tWatchSqi = tile('Watch signal', '');
  const tBp = tile('Blood pressure (watch)', 'mmHg');
  tPolarHr.el.classList.add('hero');
  const tiles = make('div', 'tiles');
  tiles.append(tPolarHr.el, tPolarHrv.el, tWatchHr.el, tWatchRr.el, tWatchHrv.el, tWatchSqi.el, tBp.el);

  // --- 4. ECG as on ECG live ---
  const traceCard = make('div', 'card trace');
  const canvas = make('canvas') as HTMLCanvasElement;
  canvas.setAttribute('aria-label', 'Live ECG trace from the Polar H10');
  traceCard.append(make('h3', 'sync-h', 'ECG (Polar H10)'), canvas);
  const trace = new LiveTrace(canvas, ECG_FS);

  // --- 5. heart rate from both, over the tracking ---
  const chartCard = make('div', 'card');
  const chartBox = make('div');
  chartCard.append(make('h3', 'sync-h', 'Heart rate: Polar H10 and Watch D2'), chartBox);

  // --- 6. blood pressure ---
  const bpCard = make('div', 'card');
  const bpText = make('p', '', 'Start the tracking first.');
  const btnBp = make('button', '', 'Check the watch for blood pressure now') as HTMLButtonElement;
  btnBp.disabled = true;
  const bpList = make('div');
  bpCard.append(make('h3', 'sync-h', 'Blood pressure'), bpText, btnBp, bpList);

  const summary = make('div', 'card');
  summary.hidden = true;
  // every tracking on this device, newest first
  const historyCard = make('div', 'card');
  const historyBox = make('div');
  historyCard.append(make('h3', 'sync-h', 'History of Synchronised Tracking'), historyBox);
  const logBox = make('details', 'd2-log');
  logBox.appendChild(make('summary', '', 'Connection log (Polar H10 and Watch D2)'));
  const logPre = make('pre', 'log');
  logBox.appendChild(logPre);

  root.append(polarCard, watchCard, logBox, runCard, tiles, traceCard, chartCard, bpCard, summary, historyCard);
  const log = (s: string): void => { logPre.textContent += `${clock(Date.now())} ${s}\n`; logPre.scrollTop = logPre.scrollHeight; };

  // ---------- state ----------
  let polar: PolarH10 | null = null, watch: LiveWatch | null = null;
  let filter = new EcgFilter(ECG_FS, deps.notch());
  let t0: number | null = null, timerId: ReturnType<typeof setInterval> | null = null, bpTimer: ReturnType<typeof setInterval> | null = null;
  let polarRr: number[] = [], watchRr: number[] = [];
  let polarHrNow: number | null = null;
  const polarSeries: [number, number][] = [], watchSeries: [number, number][] = [];
  let lastSqi: number | null = null;
  let bpReadings: BloodPressure[] = [];
  let length: number | null = 60; // seconds of the current tracking; null = until stopped
  let watchTestAt = 0, restarting = false, watchTesting = false; // the watch's heartbeat test: last started (ms), running
  let drawFrame = 0;
  let ecgChunks: Int16Array[] = [], ecgN = 0;
  // the latest beats of each device, shown live whether or not tracking is running
  const LIVE_BEATS = 30;
  let polarLive: number[] = [], watchLive: number[] = [];
  const keepLast = (a: number[], add: readonly number[]): number[] => [...a, ...add].slice(-LIVE_BEATS);

  const ready = (): void => { btnStart.disabled = t0 != null && timerId != null ? true : !(polar || watch); dur.disabled = timerId != null; customMin.disabled = timerId != null; };

  // the ECG is drawn continuously while the strap is connected, as on ECG live
  const drawLoop = (): void => { trace.draw(); drawFrame = polar ? requestAnimationFrame(drawLoop) : 0; };
  const startDrawing = (): void => { if (!drawFrame) drawFrame = requestAnimationFrame(drawLoop); };

  // ---------- Polar ----------
  btnPolar.addEventListener('click', () => void (async () => {
    const busy = deps.polarBusy();
    if (busy) { polarText.textContent = busy; return; }
    const p = new PolarH10();
    p.addEventListener('ecg', (e) => {
      const s = (e as CustomEvent<EcgDetail>).detail.samples;
      trace.push(Float32Array.from(s, (v) => filter.process(v)));
      if (timerId != null) { ecgChunks.push(Int16Array.from(s, clip16)); ecgN += s.length; } // the tracked ECG, saved to ECG history
    });
    p.addEventListener('hr', (e) => {
      const d = (e as CustomEvent<HrDetail>).detail;
      polarHrNow = d.hr;
      polarLive = keepLast(polarLive, d.rr);
      if (timerId != null) polarRr.push(...d.rr);
    });
    p.addEventListener('disconnect', () => { log('Polar H10 disconnected.'); polar = null; polarLive = []; polarHrNow = null; polarDot.className = 'dot'; polarText.textContent = 'Polar H10: disconnected'; btnPolar.hidden = false; btnPolarOff.hidden = true; ready(); });
    polarDot.className = 'dot busy'; polarText.textContent = 'Polar H10: connecting…';
    try {
      const r = await p.connect(log);
      polar = p;
      filter = new EcgFilter(ECG_FS, deps.notch());
      trace.clear();
      startDrawing();
      polarDot.className = 'dot on';
      polarText.textContent = `${p.name}: ${r.ecg ? 'streaming ECG' : 'heart rate only (no ECG)'}`;
      btnPolar.hidden = true; btnPolarOff.hidden = false;
    } catch (err) {
      polarDot.className = 'dot';
      polarText.textContent = errorName(err) === 'NotFoundError' ? 'Polar H10: no strap chosen' : `Polar H10: ${errorMessage(err)}`;
      void p.disconnect();
    }
    ready();
  })());
  btnPolarOff.addEventListener('click', () => void polar?.disconnect());

  // ---------- Watch D2 ----------
  btnWatch.addEventListener('click', () => void (async () => {
    watchDot.className = 'dot busy'; watchText.textContent = 'Watch D2: connecting… (confirm on the watch if it asks)';
    btnWatch.disabled = true;
    try {
      const api = await deps.loadD2();
      const w = await api.connectLive({ account: deps.account(), user: deps.user(), via: via.value === 'mac' ? 'mac' : 'bluetooth', profile: deps.profile(), log });
      w.onClose = () => { log('Watch D2 disconnected.'); watch = null; watchTesting = false; watchLive = []; lastSqi = null; watchDot.className = 'dot'; watchText.textContent = 'Watch D2: disconnected'; btnWatch.hidden = false; btnWatchOff.hidden = true; btnBp.disabled = true; ready(); };
      watch = w;
      watchDot.className = 'dot on';
      watchText.textContent = `${w.name}: connected${w.battery != null ? ` · battery ${w.battery}%` : ''}`;
      btnWatch.hidden = true; btnWatchOff.hidden = false;
      btnBp.disabled = t0 == null;
      await startWatchTest(); // live heartbeats straight away, before any tracking
    } catch (err) {
      watchDot.className = 'dot';
      watchText.textContent = errorName(err) === 'NotFoundError' ? 'Watch D2: no watch chosen' : `Watch D2: ${errorMessage(err)}`;
    }
    btnWatch.disabled = false;
    ready();
  })());
  btnWatchOff.addEventListener('click', () => void (async () => { watchTesting = false; await watch?.stopHeartbeats(); await watch?.close(); })());

  // ---------- live values (from connection) and the tracking ----------
  const onBeats = (beats: Beat[]): void => {
    for (const b of beats) {
      lastSqi = b.sqi;
      tWatchRr.value.textContent = String(b.rri);
      if (b.sqi === 0) continue;
      watchLive = keepLast(watchLive, [b.rri]);
      if (timerId != null) watchRr.push(b.rri);
    }
  };

  async function startWatchTest(): Promise<void> {
    if (!watch) return;
    try {
      await watch.startHeartbeats(onBeats);
      watchTesting = true;
      watchTestAt = Date.now();
      log('Watch heartbeat test started.');
    } catch (e) {
      watchTesting = false;
      log(`Watch heartbeat test didn’t start: ${errorMessage(e)}`);
      watchText.textContent = `Watch D2: no live heartbeats – ${errorMessage(e)}`;
    }
  }

  /** The watch's test stops after about a minute, so it is started again while the watch is connected. */
  async function keepWatchTest(): Promise<void> {
    if (!watch || !watchTesting || restarting || Date.now() - watchTestAt < WATCH_TEST_S * 1000) return;
    restarting = true;
    try { await watch.stopHeartbeats(); await watch.startHeartbeats(onBeats); } catch (e) { log(`Watch heartbeat test couldn’t continue: ${errorMessage(e)}`); }
    watchTestAt = Date.now();
    restarting = false;
  }

  /** Every second: the live tiles (whenever a device is connected) and, while tracking, the timer and the chart. */
  function tick(): void {
    void keepWatchTest();
    const tracking = timerId != null && t0 != null;
    const wHr = hrFrom(watchLive);
    tPolarHr.value.textContent = r0(polar ? polarHrNow : null);
    tPolarHrv.value.textContent = r0(polar ? rmssd(tracking ? polarRr : polarLive) : null);
    tPolarHrv.sub.textContent = tracking ? `${usable(polarRr).length} beats tracked` : polar ? 'last 30 beats' : '';
    tWatchHr.value.textContent = r0(watch ? wHr : null);
    tWatchHrv.value.textContent = r0(watch ? rmssd(tracking ? watchRr : watchLive) : null);
    tWatchSqi.value.textContent = !watch || lastSqi == null ? '--' : lastSqi === 0 ? 'poor' : 'good';
    tWatchSqi.sub.textContent = tracking ? `${watchRr.length} beats tracked` : watch && watchTesting ? 'live' : '';
    if (!watch) tWatchRr.value.textContent = '--';
    if (!tracking || t0 == null) return;
    const s = (Date.now() - t0) / 1000;
    const left = length == null ? null : Math.max(0, length - s);
    timer.textContent = left == null ? mmss(s) : mmss(Math.ceil(left));
    if (polarHrNow != null && polar) polarSeries.push([s, polarHrNow]);
    if (wHr != null && watch) watchSeries.push([s, wHr]);
    drawChart();
    if (left != null && left <= 0) void finish();
  }
  const liveTimer = setInterval(tick, 1000);

  btnStart.addEventListener('click', () => void (async () => {
    t0 = Date.now();
    length = durationS();
    watchTestAt = 0;
    ecgChunks = []; ecgN = 0;
    polarRr = []; watchRr = []; polarSeries.length = 0; watchSeries.length = 0; lastSqi = null; bpReadings = [];
    summary.hidden = true;
    btnStart.hidden = true; btnStop.hidden = false;
    runNote.textContent = `Tracking since ${clock(t0)}${length == null ? ' until you stop' : ` for ${mmss(length)}`}. Measure your blood pressure on the watch now or before ${clock(t0 + BP_WINDOW_MS)}.`;
    bpText.textContent = `Measure your blood pressure on the watch once, before ${clock(t0 + BP_WINDOW_MS)}. It is checked every minute while the watch is connected.`;
    bpList.replaceChildren();
    timerId = setInterval(() => undefined, 1 << 30); // marks tracking as running; the live timer does the work
    ready();
    if (watch && !watchTesting) await startWatchTest();
    btnBp.disabled = !watch;
    tick();
  })());
  btnStop.addEventListener('click', () => void finish());

  async function finish(): Promise<void> {
    if (timerId == null) return;
    clearInterval(timerId);
    timerId = null;
    btnStop.hidden = true; btnStart.hidden = false; btnStart.textContent = 'Start again';
    timer.textContent = 'Done'; // the watch's heartbeat test keeps running for the live values
    const entry = showSummary();
    entry.ecgId = await saveEcg();
    store.saveSyncEntry(entry);
    renderHistory();
    ready();
    startBpChecks();
  }

  /** The strap's ECG from the tracking goes into ECG history, like a recording on ECG live. */
  async function saveEcg(): Promise<string | null> {
    if (t0 == null || !ecgN) return null;
    if (ecgN < MIN_SAVE_S * ECG_FS) { summary.appendChild(make('p', 'note', `The ECG was too short to save (under ${MIN_SAVE_S} s).`)); return null; }
    const samples = new Int16Array(ecgN);
    let o = 0;
    for (const c of ecgChunks) { samples.set(c, o); o += c.length; }
    const user = deps.user() as UserNumber;
    const session: Session = {
      id: `s${t0}`, user, start: t0, durationS: ecgN / ECG_FS, fs: ECG_FS, alias: store.loadSettings(user).alias,
      source: 'polar', userEvents: [], summary: null,
    };
    try {
      await store.saveSession(session, samples);
      historyChanged();
      ecgChunks = []; ecgN = 0;
      const row = make('div', 'row wrap');
      const open = make('button', '', 'Open in ECG history');
      open.addEventListener('click', () => deps.openEcg(session.id));
      row.append(make('span', 'note', `ECG saved to ECG history (${mmss(session.durationS)}).`), open);
      summary.appendChild(row);
      log(`ECG saved to ECG history (${mmss(session.durationS)}).`);
      return session.id;
    } catch (e) {
      summary.appendChild(make('p', 'note', `The ECG couldn’t be saved: ${errorMessage(e)}`));
      return null;
    }
  }

  /** Shows the summary and returns it as a history entry. */
  function showSummary(): SyncTrackingEntry {
    const ph = mean(polarSeries.map((p) => p[1])), wh = mean(watchSeries.map((p) => p[1]));
    const start = t0 ?? Date.now();
    const entry: SyncTrackingEntry = {
      id: `t${start}`, user: deps.user() as UserNumber, start, durationS: Math.round((Date.now() - start) / 1000),
      polar: polarSeries.length || polarRr.length ? { hr: ph, rmssd: rmssd(polarRr), sdnn: sdnn(polarRr), beats: usable(polarRr).length } : null,
      watch: watchSeries.length || watchRr.length ? { hr: wh, rmssd: rmssd(watchRr), sdnn: sdnn(watchRr), beats: watchRr.length } : null,
      bp: null, ecgId: null,
    };
    const rows: [string, string, string][] = [
      ['Average heart rate (bpm)', r0(ph), r0(wh)],
      ['RMSSD (ms)', r0(rmssd(polarRr)), r0(rmssd(watchRr))],
      ['SDNN (ms)', r0(sdnn(polarRr)), r0(sdnn(watchRr))],
      ['Beats counted', String(usable(polarRr).length), String(watchRr.length)],
    ];
    const t = make('table', 'd2-table');
    const hr = make('tr');
    for (const h of ['', 'Polar H10', 'Watch D2']) hr.appendChild(make('th', '', h));
    t.appendChild(make('thead')).appendChild(hr);
    const body = make('tbody');
    for (const r of rows) { const tr = make('tr'); for (const c of r) tr.appendChild(make('td', '', c)); body.appendChild(tr); }
    t.appendChild(body);
    const diff = ph != null && wh != null ? `The watch read ${Math.abs(wh - ph).toFixed(1)} bpm ${wh >= ph ? 'higher' : 'lower'} than the chest strap on average.` : '';
    summary.replaceChildren(make('h3', 'sync-h', `Summary · ${t0 ? clock(t0) : ''}`), t, make('p', 'note', diff));
    summary.hidden = false;
    return entry;
  }

  function renderHistory(): void {
    const entries = store.loadSyncHistory().filter((e) => e.user === deps.user());
    if (!entries.length) { historyBox.replaceChildren(make('p', 'muted', 'No synchronised tracking yet on this device.')); return; }
    const day = (ms: number): string => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
    const head = ['Date and time', 'Duration', 'Polar HR', 'Watch HR', 'Difference', 'Polar RMSSD', 'Watch RMSSD', 'Polar SDNN', 'Watch SDNN', 'Polar beats', 'Watch beats', 'Blood pressure', 'Pulse (BP)', 'BP time', 'ECG'];
    const units = ['', 'm:ss', 'bpm', 'bpm', 'bpm', 'ms', 'ms', 'ms', 'ms', '', '', 'mmHg', 'bpm', '', ''];
    const wrap = make('div', 'd2-table-wrap');
    const t = make('table', 'd2-table sync-history');
    const hr = make('tr');
    head.forEach((h, i) => { const th = make('th', '', h); if (units[i]) th.appendChild(make('small', 'sync-unit', ` ${units[i]}`)); hr.appendChild(th); });
    t.appendChild(make('thead')).appendChild(hr);
    const body = make('tbody');
    for (const e of entries) {
      const diff = e.polar?.hr != null && e.watch?.hr != null ? e.watch.hr - e.polar.hr : null;
      const cells = [
        `${day(e.start)} ${clock(e.start)}`, mmss(e.durationS), r0(e.polar?.hr ?? null), r0(e.watch?.hr ?? null),
        diff == null ? '--' : `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}`,
        r0(e.polar?.rmssd ?? null), r0(e.watch?.rmssd ?? null), r0(e.polar?.sdnn ?? null), r0(e.watch?.sdnn ?? null),
        e.polar ? String(e.polar.beats) : '--', e.watch ? String(e.watch.beats) : '--',
        e.bp ? `${r0(e.bp.systolic)}/${r0(e.bp.diastolic)}` : '--', r0(e.bp?.pulse ?? null), e.bp ? clock(e.bp.at) : '--',
      ];
      const tr = make('tr');
      for (const c of cells) tr.appendChild(make('td', '', c));
      const ecgCell = make('td');
      const ecgId = e.ecgId;
      if (ecgId) { const b = make('button', 'sync-open', 'Open'); b.addEventListener('click', () => deps.openEcg(ecgId)); ecgCell.appendChild(b); } else ecgCell.textContent = '--';
      tr.appendChild(ecgCell);
      body.appendChild(tr);
    }
    t.appendChild(body);
    wrap.appendChild(t);
    historyBox.replaceChildren(make('p', 'note', 'Kept on this device. Difference = watch minus Polar. Blood pressure: the reading taken on the watch within one hour of the start.'), wrap);
  }
  renderHistory();

  // ---------- blood pressure ----------
  async function checkBp(): Promise<void> {
    if (!watch || t0 == null) return;
    btnBp.disabled = true;
    try {
      const found = await watch.bloodPressureSince(t0);
      if (found.length) {
        bpReadings = found;
        // the first reading after the start goes into this tracking's history entry
        const e = store.loadSyncHistory().find((x) => x.id === `t${t0}`);
        const b = found[0]!;
        if (e && (!e.bp || e.bp.at !== b.at)) { store.saveSyncEntry({ ...e, bp: b }); renderHistory(); }
      }
      showBp();
    } catch (e) {
      log(`Blood pressure check failed: ${errorMessage(e)}`);
    }
    btnBp.disabled = !watch;
  }

  function showBp(): void {
    if (!bpReadings.length) { bpList.replaceChildren(make('p', 'muted', `No reading yet (checked at ${clock(Date.now())}).`)); return; }
    const last = bpReadings[bpReadings.length - 1]!;
    tBp.value.textContent = `${r0(last.systolic)}/${r0(last.diastolic)}`;
    tBp.sub.textContent = `pulse ${r0(last.pulse)} · ${clock(last.at)}`;
    bpList.replaceChildren(...bpReadings.map((b) => make('p', 'sync-bp', `${clock(b.at)}: ${r0(b.systolic)}/${r0(b.diastolic)} mmHg, pulse ${r0(b.pulse)} bpm`)));
    if (t0 != null) bpText.textContent = `Reading${bpReadings.length > 1 ? 's' : ''} taken since ${clock(t0)}:`;
  }

  function startBpChecks(): void {
    if (bpTimer) clearInterval(bpTimer);
    const start = t0;
    if (start == null) return;
    void checkBp();
    bpTimer = setInterval(() => {
      if (Date.now() > start + BP_WINDOW_MS || bpReadings.length) { if (bpTimer) clearInterval(bpTimer); bpTimer = null; return; }
      void checkBp();
    }, 60000);
  }
  btnBp.addEventListener('click', () => void checkBp());

  // ---------- chart ----------
  function drawChart(): void {
    const W = 600, H = 180, L = 40, R = 8, T = 8, B = 22;
    const all = [...polarSeries, ...watchSeries].map((p) => p[1]);
    const lo = Math.max(30, Math.floor((Math.min(...all, 60) - 5) / 10) * 10), hi = Math.ceil((Math.max(...all, 100) + 5) / 10) * 10;
    const elapsed = t0 != null ? (Date.now() - t0) / 1000 : 0;
    const span = length ?? Math.max(60, Math.ceil(elapsed / 60) * 60); // until stopped: the axis grows a minute at a time
    const x = (s: number): number => L + (s / span) * (W - L - R);
    const y = (v: number): number => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const ns = 'http://www.w3.org/2000/svg';
    const svgEl = document.createElementNS(ns, 'svg');
    svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svgEl.setAttribute('class', 'd2-trend');
    const add = (tag: string, attrs: Record<string, string | number>, text?: string): void => {
      const e = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      if (text) e.textContent = text;
      svgEl.appendChild(e);
    };
    for (let v = lo; v <= hi; v += (hi - lo) / 4) { add('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'd2-row' }); add('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'd2-axis' }, String(Math.round(v))); }
    const step = [10, 30, 60, 120, 300, 600, 900, 1800, 3600].find((v) => span / v <= 7) ?? 3600;
    for (let s = 0; s <= span; s += step) add('text', { x: x(s), y: H - 6, 'text-anchor': 'middle', class: 'd2-axis' }, span <= 120 ? `${s} s` : mmss(s));
    const line = (pts: [number, number][], color: string): void => {
      if (pts.length > 1) add('path', { d: pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(''), fill: 'none', stroke: color, 'stroke-width': 2 });
    };
    line(polarSeries, 'var(--accent)');
    line(watchSeries, 'var(--series-1)');
    const legend = make('div', 'row wrap d2-graph-legend');
    for (const [n, c] of [['Polar H10', 'var(--accent)'], ['Watch D2', 'var(--series-1)']] as const) { const i = make('span'); const d = make('i'); d.style.background = c; i.append(d, n); legend.appendChild(i); }
    chartBox.replaceChildren(legend, svgEl);
  }
  drawChart();

  return {
    stop: () => {
      if (drawFrame) cancelAnimationFrame(drawFrame);
      clearInterval(liveTimer);
      if (timerId) clearInterval(timerId);
      if (bpTimer) clearInterval(bpTimer);
      void polar?.disconnect();
      void watch?.close();
    },
  };
}
