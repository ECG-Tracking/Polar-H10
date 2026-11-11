// Synchronised ECG tracking: the Polar H10's ECG for a chosen time (1, 3 or 5 min, a custom time, or until stopped), with
// the Watch D2's ECG strips taken meanwhile (downloaded after Stop) and a blood pressure reading taken on the watch
// within the hour around the start.
// The watch is reached through D2 Link (d2link.js); this page only uses what it offers.

import { during } from './diagnostics';
import { ECG_FS, type EcgDetail, type HrDetail, type PolarH10 } from './polar';
import { connectStrap, currentStrap, disconnectStrap, onStrap } from './devices';
import { EcgFilter } from './dsp';
import { rmssd, sdnn, usable, type TimedBeat } from './synccompare';
import { initSyncReports } from './syncreports';
import { LiveTrace } from './charts';
import { make } from './ui';
import { H10_RESTART_TIP, connectionLog, forgetStrapButton, trackFor } from './devicekit';
import { collectStrips } from './watchecg';
import { watchCaptureCard } from './watchcapture';
import * as store from './store';
import type { Session, SyncBp, SyncTrackingEntry, UserNumber } from './store';
import { historyChanged } from './account';
import { errorMessage, errorName } from './util';
import type { D2Api } from './d2/index'; // type only: D2 Link's code stays in d2link.js
import type { LiveWatch } from './d2/live';

export const BP_WINDOW_MS = 3600000;

export interface SyncDeps {
  loadD2: () => Promise<D2Api>;
  account: () => string;
  user: () => number;
  notch: () => number;
  /** This user's settings, for analysing ECG from the watch. */
  settings: () => Pick<store.Settings, 'alias' | 'notch' | 'qtcFormula' | 'hrRest' | 'hrMax' | 'sex'>;
  profile: () => { heightCm: number; weightKg: number; age: number; sex: 'male' | 'female' } | null;
  /** Opens a saved recording's report in ECG history. */
  openEcg: (id: string) => void;
  /** Works out a saved recording's summary for the ECG history list. */
  summarise: (id: string) => Promise<void>;
  /** Shows the tracking report page, or the history again. */
  show: (view: 'syncReport' | 'syncHistory') => void;
  /** Generates new versions of the tracking reports, if anything changed. */
  updateReports: () => Promise<boolean>;
}

/** Recordings shorter than this aren't saved (as on ECG live). */
export const MIN_SAVE_S = 10;
const clip16 = (v: number): number => Math.max(-32768, Math.min(32767, Math.round(v)));

export { hrFrom, rmssd, sdnn, usable } from './synccompare';

// ---------- numbers ----------

/**
 * Each tracking's blood pressure: every reading taken from one hour before its start to one hour after (a reading can
 * fall within the hours of two trackings, and then belongs to both). Returns only the entries that changed.
 */
export function withReadings(entries: readonly SyncTrackingEntry[], readings: readonly SyncBp[]): SyncTrackingEntry[] {
  const out: SyncTrackingEntry[] = [];
  for (const e of entries) {
    const mine = readings.filter((b) => b.at >= e.start - BP_WINDOW_MS && b.at <= e.start + BP_WINDOW_MS).sort((a, b) => a.at - b.at);
    if (mine.length && JSON.stringify(store.syncBps(e)) !== JSON.stringify(mine)) out.push({ ...e, bp: mine[0] ?? null, bps: mine });
  }
  return out;
}

/** m:ss */
export const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r0 = (v: number | null): string => (v == null ? '--' : String(Math.round(v)));
const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const clockOf = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour12: false });

// ---------- the page ----------

/** `historyRoot`: the “Synchronised ECG Tracking History” page. */
export function initSyncTracking(root: HTMLElement, historyRoot: HTMLElement, reportRoot: HTMLElement, deps: SyncDeps): { stop: () => void; refreshHistory: () => void; openPair: (id: string, back: { label: string; go: () => void }) => void } {
  root.replaceChildren();
  root.append(make('h2', '', 'Synchronised ECG Tracking'), make('p', 'note',
    'The Polar H10’s ECG, with the Watch D2’s 30-second ECGs taken meanwhile: they are downloaded after Stop. Wear both and connect both: the ECG shows as soon as the strap is connected. Choose how long to track, then start. Measure your blood pressure on the watch once, within one hour before or after the start; it is added to the tracking once D2 Link has downloaded it.'));

  // --- 1. Polar H10 ---
  const polarCard = make('div', 'card connect');
  const polarStatus = make('div', 'status');
  const polarDot = make('span', 'dot'), polarText = make('span', '', 'Polar H10: not connected');
  polarStatus.append(polarDot, polarText);
  const btnPolar = make('button', 'primary', '1. Pair with Polar H10');
  const btnPolarOff = make('button', '', 'Disconnect');
  btnPolarOff.hidden = true;
  const polarRow = make('div', 'row wrap');
  const logs = connectionLog('Connection log (Polar H10 and Watch D2)');
  const log = (s: string): void => logs.log(s);
  const forgetPolar = forgetStrapButton(log);
  polarRow.append(btnPolar, btnPolarOff, forgetPolar.el);
  polarCard.append(polarStatus, polarRow, make('p', 'note', 'Chrome shows a list: click your Polar H10, then Pair.'));

  // --- 2. Watch D2 ---
  const watchCard = make('div', 'card connect');
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
  const btnWatchForget = make('button', '', 'Forget pairing') as HTMLButtonElement;
  btnWatchForget.hidden = true;
  watchRow.append(btnWatch, viaLabel, btnWatchOff, btnWatchForget);
  const acctSlot = make('div');
  watchCard.append(watchStatus, watchRow, make('p', 'note', 'Switch off Bluetooth on the phone the watch is connected to. On a Mac, open the D2 Bridge app first. The watch only shares its data with its own account: enter its watch account ID below (D2 Link’s pairing and ID are used here too).'), acctSlot);
  /** The watch account ID box and Forget pairing come from D2 Link, which loads on its own. */
  const showWatchParts = (): void => void deps.loadD2().then((api) => {
    if (!acctSlot.firstChild) acctSlot.appendChild(api.accountBox(deps.account()));
    btnWatchForget.hidden = !api.pairing.saved(deps.account());
    btnWatchForget.disabled = watch != null;
    btnWatchForget.title = watch ? 'Disconnect the watch first' : 'Forget the pairing with the watch: the next connection pairs again';
  }).catch(() => undefined);
  btnWatchForget.addEventListener('click', () => void (async () => {
    if (!window.confirm('Forget the pairing with the watch? Next time you will pair again (and may need to confirm on the watch). Downloaded data is kept.')) return;
    (await deps.loadD2()).pairing.forget(deps.account());
    log('Watch D2 pairing forgotten.');
    showWatchParts();
  })());

  // --- 3. one minute ---
  const runCard = make('div', 'card controls');
  const timer = make('div', 'timer', '0:00');
  // how long: as on every page that tracks
  const track = trackFor('short', () => showDuration());
  const durRow = track.el;
  /** The chosen length in seconds; null = until stopped. */
  const durationS = (): number | null => track.seconds();
  const showDuration = (): void => {
    const d = durationS();
    if (timerId == null) timer.textContent = d == null ? '0:00' : mmss(d);
  };
  const btnStart = make('button', 'primary big', '3. Start tracking') as HTMLButtonElement;
  btnStart.disabled = true;
  const btnStop = make('button', 'big', 'Stop') as HTMLButtonElement;
  btnStop.hidden = true;
  const runRow = make('div', 'row');
  runRow.append(btnStart, btnStop);
  // after Stop: the download of every watch ECG strip from the tracking's period, and how it went
  const lastEcgText = make('p', 'note last-ecg');
  lastEcgText.hidden = true;
  const runNote = make('p', 'note', 'Connect at least one device. Sit still and breathe normally.');
  runCard.append(durRow, timer, runRow, lastEcgText, runNote);

  // --- live values ---
  const tile = (label: string, unit: string): { el: HTMLElement; value: HTMLElement; sub: HTMLElement } => {
    const el = make('div', 'tile'), value = make('span', '', '--'), sub = make('div', 'sub', '');
    const v = make('div', 'value'); v.append(value, make('small', '', unit));
    el.append(make('div', 'label', label), v, sub);
    return { el, value, sub };
  };
  const tPolarHr = tile('Polar heart rate', 'bpm'), tPolarHrv = tile('Polar RMSSD', 'ms');
  tPolarHr.el.classList.add('hero');
  const tiles = make('div', 'tiles');
  tiles.append(tPolarHr.el, tPolarHrv.el);

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

  const summary = make('div', 'card');
  summary.hidden = true;
  // every tracking on this device, newest first: on its own page
  const historyCard = make('div', 'card');
  const historyBox = make('div');
  historyCard.append(historyBox);
  historyRoot.replaceChildren(make('h2', '', 'Synchronised ECG Tracking History'), historyCard);
  const reports = initSyncReports(historyBox, reportRoot, deps);
  const renderHistory = reports.render;
  logs.el.classList.add('page-log');

  /** A strip belongs to a tracking only when one covers it: the one running now, or one in the history. */
  const inTracking = (r: { start: number; end: number }): boolean =>
    (timerId != null && t0 != null && r.end > t0) || store.loadSyncHistory().some((e) => r.start < e.start + e.durationS * 1000 && r.end > e.start);
  try { localStorage.removeItem('openbeat-ecg-prompts'); } catch { /* the removed ECG prompts' setting */ }
  /** True while a stopped tracking is being saved: Start again waits, so the new run can't mix with the old one. */
  let saving = false;
  const capture = watchCaptureCard({
    watch: () => watch, log,
  });
  root.append(polarCard, watchCard, logs.el, runCard, tiles, traceCard, chartCard, summary, capture.el);
  showWatchParts();

  // ---------- state ----------
  let polar: PolarH10 | null = null, watch: LiveWatch | null = null;
  let attached: PolarH10 | null = null; // the strap this page listens to
  let filter = new EcgFilter(ECG_FS, deps.notch());
  let t0: number | null = null, timerId: ReturnType<typeof setInterval> | null = null;
  let polarRr: number[] = [], watchRr: number[] = [];
  let polarBeats: TimedBeat[] = [], watchBeats: TimedBeat[] = [], watchPoor = 0; // kept with the tracking for its reports
  let polarHrNow: number | null = null;
  const polarSeries: [number, number][] = [], watchSeries: [number, number][] = [];
  let length: number | null = 60; // seconds of the current tracking; null = until stopped
  let drawFrame = 0;
  let ecgChunks: Int16Array[] = [], ecgN = 0;
  // the latest beats of each device, shown live whether or not tracking is running
  const LIVE_BEATS = 30;
  let polarLive: number[] = [];
  const keepLast = (a: number[], add: readonly number[]): number[] => [...a, ...add].slice(-LIVE_BEATS);

  const secondsIn = (): number => Math.round(((Date.now() - (t0 ?? Date.now())) / 1000) * 10) / 10;

  const ready = (): void => { btnStart.disabled = saving || (t0 != null && timerId != null) ? true : !(polar || watch); track.disable(timerId != null); forgetPolar.update(); showWatchParts(); };

  // the ECG is drawn continuously while the strap is connected, as on ECG live
  const drawLoop = (): void => { trace.draw(); drawFrame = polar ? requestAnimationFrame(drawLoop) : 0; };
  const startDrawing = (): void => { if (!drawFrame) drawFrame = requestAnimationFrame(drawLoop); };

  // ---------- Polar ----------
  btnPolar.addEventListener('click', () => void (async () => {
    polarDot.className = 'dot busy'; polarText.textContent = 'Polar H10: connecting…';
    try {
      await connectStrap(log);
    } catch (err) {
      polarDot.className = 'dot';
      polarText.textContent = errorName(err) === 'NotFoundError' ? 'Polar H10: no strap chosen' : `Polar H10: ${errorMessage(err)}`;
      log(H10_RESTART_TIP);
    }
    ready();
  })());

  /** What this page does with the shared strap, however it was paired. */
  function useStrap(p: PolarH10): void {
    if (attached !== p) {
      attached = p;
      p.addEventListener('ecg', (e) => {
        const s = (e as CustomEvent<EcgDetail>).detail.samples;
        trace.push(Float32Array.from(s, (v) => filter.process(v)));
        if (timerId != null) { ecgChunks.push(Int16Array.from(s, clip16)); ecgN += s.length; } // the tracked ECG, saved to ECG history
      });
      p.addEventListener('hr', (e) => {
        const d = (e as CustomEvent<HrDetail>).detail;
        polarHrNow = d.hr;
        polarLive = keepLast(polarLive, d.rr);
        if (timerId != null) { polarRr.push(...d.rr); polarBeats.push(...d.rr.map((rr): TimedBeat => [secondsIn(), rr])); }
      });
      p.addEventListener('disconnect', () => {
        if (currentStrap() === p) return; // a night's recording is getting it back
        log('Polar H10 disconnected.'); polar = null; polarLive = []; polarHrNow = null;
        polarDot.className = 'dot'; polarText.textContent = 'Polar H10: disconnected';
        btnPolar.hidden = false; btnPolarOff.hidden = true; ready();
      });
    }
    polar = p;
    filter = new EcgFilter(ECG_FS, deps.notch());
    trace.clear();
    startDrawing();
    polarDot.className = 'dot on';
    polarText.textContent = `${p.name}: ${p.ecgOk ? 'streaming ECG' : 'heart rate only (no ECG)'}`;
    btnPolar.hidden = true; btnPolarOff.hidden = false;
    ready();
  }
  btnPolarOff.addEventListener('click', () => void disconnectStrap());

  // ---------- Watch D2 ----------
  let joining = false;
  /** Connects, or joins the connection D2 Link already has. */
  async function joinWatch(api: D2Api): Promise<void> {
    if (watch || joining) return;
    joining = true;
    watchDot.className = 'dot busy'; watchText.textContent = 'Watch D2: connecting… (confirm on the watch if it asks)';
    btnWatch.disabled = true;
    try {
      const w = await api.connectLive({ account: deps.account(), user: deps.user(), via: via.value === 'mac' ? 'mac' : 'bluetooth', profile: deps.profile(), log });
      w.onClose = () => { log('Watch D2 disconnected.'); watch = null; capture.update(); watchDot.className = 'dot'; watchText.textContent = 'Watch D2: disconnected'; btnWatch.hidden = false; btnWatchOff.hidden = true; ready(); };
      watch = w;
      capture.update();
      watchDot.className = 'dot on';
      watchText.textContent = `${w.name}: connected${w.battery != null ? ` · battery ${w.battery}%` : ''}`;
      btnWatch.hidden = true; btnWatchOff.hidden = false;
    } catch (err) {
      watchDot.className = 'dot';
      watchText.textContent = errorName(err) === 'NotFoundError' ? 'Watch D2: no watch chosen' : `Watch D2: ${errorMessage(err)}`;
    }
    btnWatch.disabled = false;
    joining = false;
    ready();
  }
  btnWatch.addEventListener('click', () => void deps.loadD2().then(joinWatch).catch((err: unknown) => { watchText.textContent = `Watch D2: ${errorMessage(err)}`; }));
  btnWatchOff.addEventListener('click', () => void watch?.close());

  // ---------- live values (from connection) and the tracking ----------
  // The watch is not asked for heart rate during a tracking (its heartbeat test is never started here): its ECG strips
  // are downloaded after Stop, and its readings come from D2 Link's downloads.

  /** Every second: the live tiles (whenever a device is connected) and, while tracking, the timer and the chart. */
  function tick(): void {
    const tracking = timerId != null && t0 != null;
    tPolarHr.value.textContent = r0(polar ? polarHrNow : null);
    tPolarHrv.value.textContent = r0(polar ? rmssd(tracking ? polarRr : polarLive) : null);
    tPolarHrv.sub.textContent = tracking ? `${usable(polarRr).length} beats tracked` : polar ? 'last 30 beats' : '';
    if (!tracking || t0 == null) return;
    const s = (Date.now() - t0) / 1000;
    const left = length == null ? null : Math.max(0, length - s);
    timer.textContent = left == null ? mmss(s) : mmss(Math.ceil(left));
    if (polarHrNow != null && polar) polarSeries.push([s, polarHrNow]);
    drawChart();
    if (left != null && left <= 0) void finish();
  }
  const liveTimer = setInterval(tick, 1000);

  btnStart.addEventListener('click', () => void (async () => {
    t0 = Date.now();
    length = durationS();
    lastEcgText.hidden = true; // the last tracking's download line
    ecgChunks = []; ecgN = 0;
    polarRr = []; watchRr = []; polarBeats = []; watchBeats = []; watchPoor = 0; polarSeries.length = 0; watchSeries.length = 0;
    summary.hidden = true;
    btnStart.hidden = true; btnStop.hidden = false;
    runNote.textContent = `Tracking since ${clock(t0)}${length == null ? ' until you stop' : ` for ${mmss(length)}`}. A blood pressure reading taken on the watch from ${clock(t0 - BP_WINDOW_MS)} to ${clock(t0 + BP_WINDOW_MS)} is added to this tracking once D2 Link has downloaded it.`;
    timerId = setInterval(() => undefined, 1 << 30); // marks tracking as running; the live timer does the work
    ready();
    tick();
  })());
  btnStop.addEventListener('click', () => void finish());

  async function finish(): Promise<void> {
    if (timerId == null) return;
    try { await during('saving the tracking', finishTracking); } finally { saving = false; ready(); }
  }

  async function finishTracking(): Promise<void> {
    if (timerId == null) return;
    clearInterval(timerId);
    timerId = null;
    saving = true;
    btnStop.hidden = true; btnStart.hidden = false; btnStart.textContent = 'Start again';
    btnStart.disabled = true;
    timer.textContent = 'Done';
    const entry = showSummary();
    entry.ecgId = await saveEcg();
    await store.saveSyncTrace({ id: entry.id, polar: polarBeats, watch: watchBeats, polarHr: [...polarSeries], watchHr: [...watchSeries], watchPoor })
      .catch((e: unknown) => log(`The beats couldn’t be saved: ${errorMessage(e)}`));
    const thisStart = t0 ?? entry.start;
    store.saveSyncEntry(store.loadSyncHistory().find((x) => x.id === entry.id) ?? entry);
    saving = false;
    ready();
    renderHistory();
    // Stop downloads every watch ECG strip from the tracking's period (one started up to a minute before the start still
    // overlaps it): now, and again 45 and 90 s later for one still being recorded at Stop (it ends up to 30 s after, and
    // the watch takes a little longer to save it)
    const thisEnd = thisStart + entry.durationS * 1000;
    let downloaded = 0;
    const period = `${clockOf(thisStart)} to ${clockOf(thisEnd)}`;
    const collect = async (last: boolean): Promise<void> => {
      if (t0 !== thisStart || timerId != null) return; // a new tracking has started
      lastEcgText.hidden = false;
      if (!watch) { lastEcgText.textContent = `Watch ECG strips from ${period}: the watch isn’t connected. Connect it and use D2 Link › Download ECG to fetch them.`; return; }
      if (!downloaded) lastEcgText.textContent = `Downloading the watch’s ECG strips from ${period}…`;
      try {
        const { saved, found } = await collectStrips(watch, thisStart - 60_000, thisEnd, deps.user(), deps.settings(), inTracking, log);
        downloaded += saved;
        // strips from then that were saved another way (D2 Link) count as this tracking's too
        for (const x of await store.listSessions(deps.user() as UserNumber).catch(() => [])) {
          if (x.source !== 'watch' || x.syncTracking || x.cloudOnly || !(x.start < thisEnd && x.start + x.durationS * 1000 > thisStart)) continue;
          await store.updateSession({ ...x, syncTracking: true }).catch(() => undefined);
        }
        if (t0 !== thisStart || timerId != null) return;
        const strips = (k: number): string => `${k} strip${k === 1 ? '' : 's'}`;
        lastEcgText.textContent = `Watch ECG from ${period}: found ${strips(found)} on the watch, saved ${downloaded} new in ECG history${found > downloaded ? ` (${found - downloaded} already there)` : ''}.`
          + (last ? '' : ' Checking again shortly for a strip still finishing at Stop…');
        log(lastEcgText.textContent);
        if (saved) { historyChanged(); renderHistory(); }
      } catch (e) {
        lastEcgText.textContent = `The watch’s ECG strips from ${period} couldn’t be downloaded: ${errorMessage(e)}.${last ? ' Use D2 Link › Download ECG to fetch them.' : ' Trying again shortly…'}`;
      }
    };
    void collect(false);
    setTimeout(() => void collect(false), 45_000);
    setTimeout(() => void collect(true), 90_000);
    void fillBpFromStored(); // blood pressure already on this device for the new tracking
    ready();
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
      source: 'polar', userEvents: [], summary: null, syncTracking: true,
    };
    try {
      await store.saveSession(session, samples);
      await deps.summarise(session.id).catch(() => undefined); // HR, HRV and events in the ECG history list
      historyChanged();
      ecgChunks = []; ecgN = 0;
      const row = make('div', 'row wrap');
      const open = make('button', '', 'Open in ECG history and trending');
      open.addEventListener('click', () => deps.openEcg(session.id));
      row.append(make('span', 'note', `ECG saved to ECG history and trending (${mmss(session.durationS)}); results saved to Synchronised ECG Tracking History.`), open);
      summary.appendChild(row);
      log(`ECG saved to ECG history and trending (${mmss(session.durationS)}).`);
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
      watch: watchRr.length ? { hr: watchSeries.length ? wh : null, rmssd: rmssd(watchRr), sdnn: sdnn(watchRr), beats: usable(watchRr).length } : null,
      bp: null, ecgId: null,
    };
    const rows: [string, string, string][] = [
      ['Average heart rate (bpm)', r0(ph), r0(wh)],
      ['RMSSD (ms)', r0(rmssd(polarRr)), r0(rmssd(watchRr))],
      ['SDNN (ms)', r0(sdnn(polarRr)), r0(sdnn(watchRr))],
      ['Beats used', String(usable(polarRr).length), String(usable(watchRr).length)],
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

  renderHistory();
  void fillBpFromStored();
  onStrap(useStrap); // the strap, if another page already paired it
  // the watch, if D2 Link connected it (now or later)
  void deps.loadD2().then((api) => api.onWatch((w) => { if (w && !watch && !joining) void joinWatch(api); })).catch(() => undefined);
  // recordings saved before ECG history noted synchronised ECG tracking: mark them now
  void (async () => {
    // watch strips saved on this page outside any tracking (before v1.42.9 every one was marked as tracked)
    for (const s of await store.listSessions(deps.user() as UserNumber).catch(() => [])) {
      if (s.source !== 'watch' || !s.syncTracking || s.cloudOnly || inTracking({ start: s.start, end: s.start + s.durationS * 1000 })) continue;
      const { syncTracking: _t, ...rest } = s;
      await store.updateSession(rest).catch(() => undefined);
    }
    for (const e of store.loadSyncHistory()) {
      if (!e.ecgId) continue;
      try {
        const { session } = await store.loadSession(e.ecgId);
        if (session && !session.syncTracking) await store.updateSession({ ...session, syncTracking: true });
        if (session && !session.summary) await deps.summarise(e.ecgId); // saved before the summary was made on saving
      } catch { /* deleted */ }
    }
  })();

  // ---------- blood pressure ----------
  // The watch isn't asked for readings here: those D2 Link has downloaded fill in each tracking's history entry.
  /** Readings already on this device (downloaded by D2 Link or here) fill in the history, without the watch. */
  async function fillBpFromStored(): Promise<void> {
    const entries = store.loadSyncHistory().filter((e) => e.user === deps.user() && e.id !== `t${timerId != null ? t0 : ''}`);
    if (!entries.length) return;
    try {
      const api = await deps.loadD2();
      const changed = withReadings(entries, await api.backup.storedBloodPressure(deps.account()));
      for (const e of changed) store.saveSyncEntry(e);
      if (changed.length) renderHistory();
    } catch { /* D2 Link not available */ }
  }

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
    openPair: reports.openPair,
    refreshHistory: () => { renderHistory(); void fillBpFromStored(); },
    stop: () => {
      if (drawFrame) cancelAnimationFrame(drawFrame);
      clearInterval(liveTimer);
      if (timerId) clearInterval(timerId);
      void disconnectStrap();
      void watch?.close();
    },
  };
}
