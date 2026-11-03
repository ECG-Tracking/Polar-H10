// Synchronised tracking: the Polar H10's ECG and the Watch D2's heartbeats side by side for one minute, plus a blood
// pressure reading taken on the watch during the minute or within the hour after the start.
// The watch is reached through D2 Link (d2link.js); this page only uses what it offers.

import { PolarH10, ECG_FS, type EcgDetail, type HrDetail } from './polar';
import { EcgFilter } from './dsp';
import { LiveTrace } from './charts';
import { make } from './ui';
import { errorMessage, errorName } from './util';
import type { D2Api } from './d2/index'; // type only: D2 Link's code stays in d2link.js
import type { Beat, BloodPressure, LiveWatch } from './d2/live';

export const TRACK_S = 60;
export const BP_WINDOW_MS = 3600000;

export interface SyncDeps {
  loadD2: () => Promise<D2Api>;
  account: () => string;
  user: () => number;
  notch: () => number;
  profile: () => { heightCm: number; weightKg: number; age: number; sex: 'male' | 'female' } | null;
  /** Why the strap can't be used here (in use on another page), or null. */
  polarBusy: () => string | null;
}

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
    'The Polar H10’s ECG and the Watch D2’s heartbeats side by side for one minute. Wear both, connect both, then start. Measure your blood pressure on the watch once, during the minute or within one hour of the start.'));

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
  const btnStart = make('button', 'primary big', '3. Start 1-minute tracking') as HTMLButtonElement;
  btnStart.disabled = true;
  const btnStop = make('button', 'big', 'Stop') as HTMLButtonElement;
  btnStop.hidden = true;
  const runRow = make('div', 'row');
  runRow.append(btnStart, btnStop);
  const runNote = make('p', 'note', 'Connect at least one device. Sit still and breathe normally.');
  runCard.append(timer, runRow, runNote);

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

  // --- 5. heart rate from both, over the minute ---
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
  const logBox = make('details', 'd2-log');
  logBox.appendChild(make('summary', '', 'Connection log'));
  const logPre = make('pre', 'log');
  logBox.appendChild(logPre);

  root.append(polarCard, watchCard, runCard, tiles, traceCard, chartCard, bpCard, summary, logBox);
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

  const ready = (): void => { btnStart.disabled = t0 != null && timerId != null ? true : !(polar || watch); };

  // ---------- Polar ----------
  btnPolar.addEventListener('click', () => void (async () => {
    const busy = deps.polarBusy();
    if (busy) { polarText.textContent = busy; return; }
    const p = new PolarH10();
    p.addEventListener('ecg', (e) => {
      const s = (e as CustomEvent<EcgDetail>).detail.samples;
      trace.push(Float32Array.from(s, (v) => filter.process(v)));
    });
    p.addEventListener('hr', (e) => {
      const d = (e as CustomEvent<HrDetail>).detail;
      polarHrNow = d.hr;
      if (timerId != null) polarRr.push(...d.rr);
    });
    p.addEventListener('disconnect', () => { log('Polar H10 disconnected.'); polar = null; polarDot.className = 'dot'; polarText.textContent = 'Polar H10: disconnected'; btnPolar.hidden = false; btnPolarOff.hidden = true; ready(); });
    polarDot.className = 'dot busy'; polarText.textContent = 'Polar H10: connecting…';
    try {
      const r = await p.connect(log);
      polar = p;
      filter = new EcgFilter(ECG_FS, deps.notch());
      trace.clear();
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
      w.onClose = () => { log('Watch D2 disconnected.'); watch = null; watchDot.className = 'dot'; watchText.textContent = 'Watch D2: disconnected'; btnWatch.hidden = false; btnWatchOff.hidden = true; btnBp.disabled = true; ready(); };
      watch = w;
      watchDot.className = 'dot on';
      watchText.textContent = `${w.name}: connected${w.battery != null ? ` · battery ${w.battery}%` : ''}`;
      btnWatch.hidden = true; btnWatchOff.hidden = false;
      btnBp.disabled = t0 == null;
    } catch (err) {
      watchDot.className = 'dot';
      watchText.textContent = errorName(err) === 'NotFoundError' ? 'Watch D2: no watch chosen' : `Watch D2: ${errorMessage(err)}`;
    }
    btnWatch.disabled = false;
    ready();
  })());
  btnWatchOff.addEventListener('click', () => void (async () => { await watch?.stopHeartbeats(); await watch?.close(); })());

  // ---------- the minute ----------
  const onBeats = (beats: Beat[]): void => {
    for (const b of beats) {
      lastSqi = b.sqi;
      if (b.sqi !== 0) watchRr.push(b.rri);
      tWatchRr.value.textContent = String(b.rri);
    }
  };

  function tick(): void {
    if (t0 == null) return;
    const s = (Date.now() - t0) / 1000;
    const left = Math.max(0, TRACK_S - s);
    timer.textContent = `0:${String(Math.ceil(left)).padStart(2, '0')}`;
    if (polarHrNow != null && polar) polarSeries.push([s, polarHrNow]);
    const wHr = hrFrom(watchRr);
    if (wHr != null && watch) watchSeries.push([s, wHr]);
    tPolarHr.value.textContent = r0(polar ? polarHrNow : null);
    tPolarHrv.value.textContent = r0(rmssd(polarRr));
    tWatchHr.value.textContent = r0(wHr);
    tWatchHrv.value.textContent = r0(rmssd(watchRr));
    tWatchSqi.value.textContent = lastSqi == null ? '--' : lastSqi === 0 ? 'poor' : 'good';
    tWatchSqi.sub.textContent = `${watchRr.length} beats`;
    tPolarHrv.sub.textContent = `${usable(polarRr).length} beats`;
    drawChart();
    if (left <= 0) void finish();
  }

  btnStart.addEventListener('click', () => void (async () => {
    t0 = Date.now();
    polarRr = []; watchRr = []; polarSeries.length = 0; watchSeries.length = 0; lastSqi = null; bpReadings = [];
    summary.hidden = true;
    btnStart.hidden = true; btnStop.hidden = false;
    runNote.textContent = `Tracking since ${clock(t0)}. Measure your blood pressure on the watch now or before ${clock(t0 + BP_WINDOW_MS)}.`;
    bpText.textContent = `Measure your blood pressure on the watch once, before ${clock(t0 + BP_WINDOW_MS)}. It is checked every minute while the watch is connected.`;
    bpList.replaceChildren();
    timerId = setInterval(tick, 1000);
    if (watch) {
      try { await watch.startHeartbeats(onBeats); log('Watch heartbeat test started.'); } catch (e) { log(`Watch heartbeat test didn’t start: ${errorMessage(e)}`); watchText.textContent = `Watch D2: no live heartbeats – ${errorMessage(e)}`; }
    }
    btnBp.disabled = !watch;
    tick();
  })());
  btnStop.addEventListener('click', () => void finish());

  async function finish(): Promise<void> {
    if (timerId == null) return;
    clearInterval(timerId);
    timerId = null;
    btnStop.hidden = true; btnStart.hidden = false; btnStart.textContent = 'Start again';
    await watch?.stopHeartbeats().catch(() => undefined);
    timer.textContent = 'Done';
    showSummary();
    ready();
    startBpChecks();
  }

  function showSummary(): void {
    const ph = mean(polarSeries.map((p) => p[1])), wh = mean(watchSeries.map((p) => p[1]));
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
  }

  // ---------- blood pressure ----------
  async function checkBp(): Promise<void> {
    if (!watch || t0 == null) return;
    btnBp.disabled = true;
    try {
      const found = await watch.bloodPressureSince(t0);
      if (found.length) bpReadings = found;
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
    const x = (s: number): number => L + (s / TRACK_S) * (W - L - R);
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
    for (let s = 0; s <= TRACK_S; s += 10) add('text', { x: x(s), y: H - 6, 'text-anchor': 'middle', class: 'd2-axis' }, `${s} s`);
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
      if (timerId) clearInterval(timerId);
      if (bpTimer) clearInterval(bpTimer);
      void polar?.disconnect();
      void watch?.close();
    },
  };
}
