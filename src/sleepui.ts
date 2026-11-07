// Sleep monitor, sleep history and the sleep report.

import { connectStrap, disconnectStrap, keepStrapWhen, onStrap, strapReady } from './devices';
import { ACC_FS, ECG_FS, bluetoothAvailable, type PolarH10, type AccDetail, type EcgDetail, type HrDetail, type BatteryDetail } from './polar';
import { analyzeSleep, isNap, joinParts, SleepRecorder, EPOCH_S, SCORE_EXPLANATION, type SleepAnalysis, type SleepData, type Stage } from './sleep';
import { simulateNight } from './sleepsim';
import { EcgFilter } from './dsp';
import { Plot, LiveTrace, Hypnogram, Bars, drawDonut, fmtClock, fmtTime, STAGE_COLOR_VAR, STAGE_LABEL, type Point, type SleepStageKey } from './charts';
import { checkRange, fmtRange, sleepRanges, personalRange, SLEEP_SOURCES } from './ranges';
import * as store from './store';
import type { Session, SleepSession, UserNumber } from './store';
import { forgetStrapButton, trackFor } from './devicekit';
import { $, $button, $canvas, make, deleteButton, fmt, fmtHM, renderOutliers, download, type Outlier, type MetricRef } from './ui';
import { errorMessage, errorName, sleep } from './util';
import { current as account, historyChanged } from './account';
import { parseSleepReport, toAnalysis, type SleepReport } from './summary';

export interface SleepDeps {
  /** Fills the sleep report's "ECG during the night" section (the ECG screens own the ECG tiles). */
  renderNightEcg: (box: HTMLElement, ecgId: string) => Promise<void>;
  /** An ECG saved during this time, for a recording that didn't save its own. */
  ecgDuring: (from: number, to: number) => Promise<{ id: string } | null>;
  /** A recording was saved or deleted. */
  sleepChanged: () => void;
  user: () => UserNumber;
  /** The mains-hum filter chosen in Biodata, for the live trace. */
  notch: () => number;
  userLabel: (u: UserNumber) => string;
  showSleepView: (view: 'sleep' | 'sleepHistory' | 'sleepReport') => void;
  /** The ECG live screen has the strap; it can only stream to one screen at a time. */
  /** Tell the app whether a sleep recording is running (it locks the user selector). */
  recordingChanged: () => void;
}

const MIN_SAVE_S = 10 * 60;
const PART_MS = 60 * 60000; // how often a running recording is saved
const LIVE_PART_MS = 70 * 60000; // a recording saved this recently may still be running in another tab

export function initSleep(deps: SleepDeps): {
  renderHistory: () => Promise<void>;
  openReport: (id: string, from?: () => void) => Promise<void>;
  openCopy: (session: SleepSession, report: SleepReport, from: () => void) => Promise<void>;
  isRecording: () => boolean;
  /** For Synchronised Sleep Tracking, which records through this page. */
  recording: { canStart: () => boolean; start: (lengthS: number | null) => Promise<void>; stop: () => Promise<string | null>; elapsed: () => string };
  refreshUser: () => void;
} {
  let polar: PolarH10 | null = null;
  let attached: PolarH10 | null = null; // the strap this page listens to
  let recorder: SleepRecorder | null = null;
  let recUser: UserNumber = deps.user();
  // every sleep recording keeps its ECG, which goes into ECG history when it stops
  let ecg: { chunks: Int16Array[]; n: number } | null = null;
  let tick: ReturnType<typeof setInterval> | null = null;
  let wakeLock: WakeLockSentinel | null = null;
  let reconnecting = false;
  let gaps = 0;
  // a running recording is saved in parts, so closing the page or a crash loses only the last minutes
  let partTimer: ReturnType<typeof setInterval> | null = null;
  let partSeq = 0, ecgSent = 0, partSaving: Promise<void> = Promise.resolve();

  const log = (line: string): void => {
    const el = $('sleepLog');
    el.hidden = false;
    el.textContent += `${new Date().toLocaleTimeString([], { hour12: false })}  ${line}\n`;
    el.scrollTop = el.scrollHeight;
  };
  const status = (text: string, state: '' | 'on' | 'busy'): void => {
    $('sleepStatus').textContent = text;
    $('sleepDot').className = `dot ${state}`;
  };

  function refreshUser(): void {
    $('sleepUser').textContent = deps.userLabel(recorder ? recUser : deps.user());
  }

  // Forget pairing and "Track for", as on every page that connects to the strap
  $('forgetSleepSlot').replaceWith(forgetStrapButton(log).el);
  const track = trackFor('sleep');
  $('sleepTrackSlot').replaceWith(track.el);
  /** Seconds after which the recording stops by itself (null = when you stop it), and whether its report opens then. */
  let stopAfter: number | null = null, showWhenDone = true;

  // ---------- live ECG, as on ECG live ----------

  const trace = new LiveTrace($canvas('sleepCanvas'), ECG_FS);
  let filter = new EcgFilter(ECG_FS, deps.notch());
  let drawFrame = 0;
  /** Drawn only while it can be seen: not on other pages or under Dim screen, to save the battery overnight. */
  function drawLoop(): void {
    if ($('view-sleep').classList.contains('active') && $('sleepDim').hidden) trace.draw();
    drawFrame = polar ? requestAnimationFrame(drawLoop) : 0;
  }
  function clearTrace(): void {
    filter = new EcgFilter(ECG_FS, deps.notch());
    trace.clear();
  }

  function syncButtons(): void {
    const connected = polar?.connected ?? false;
    $button('btnSleepConnect').hidden = connected;
    $button('btnSleepDemo').hidden = recorder !== null;
    $button('btnSleepDisconnect').hidden = !connected || recorder !== null;
    $('sleepPairHint').hidden = connected || $button('btnSleepConnect').disabled;
    const start = $button('btnSleepStart');
    start.disabled = !recorder && !(connected && polar?.accOk);
    start.textContent = recorder ? 'Stop – I’m awake' : 'Start sleep & ECG recording';
    start.title = connected && !polar?.ecgOk ? 'The ECG stream isn’t running on this connection: sleep is recorded without ECG' : '';
    start.classList.toggle('recording', recorder !== null);
    $button('btnSleepDim').disabled = recorder === null;
  }

  // ---------- connection ----------

  async function connect(): Promise<void> {
    $('sleepLog').textContent = '';
    status('Connecting…', 'busy');
    try {
      await connectStrap(log);
    } catch (err) {
      const cancelled = errorName(err) === 'NotFoundError';
      log(cancelled ? 'No strap chosen (the list was closed or cancelled)' : `Error: ${errorMessage(err)}`);
      status(cancelled ? 'No device selected' : `Connection failed: ${errorMessage(err)}`, '');
    }
    syncButtons();
  }

  /** What this page does with the shared strap, however it was paired. */
  function useStrap(p: PolarH10): void {
    if (attached !== p) {
      attached = p;
      p.addEventListener('hr', (e) => {
        const d = (e as CustomEvent<HrDetail>).detail;
        if (d.rr.length) recorder?.addRR(d.rr);
        if (!recorder) $('sleepHR').textContent = String(d.hr);
      });
      p.addEventListener('acc', (e) => recorder?.addAcc((e as CustomEvent<AccDetail>).detail.samples));
      p.addEventListener('ecg', (e) => {
        const s = (e as CustomEvent<EcgDetail>).detail.samples;
        trace.push(Float32Array.from(s, (v) => filter.process(v)));
        if (!recorder || !ecg) return;
        const c = Int16Array.from(s, (v) => Math.max(-32768, Math.min(32767, v)));
        ecg.chunks.push(c);
        ecg.n += c.length;
      });
      p.addEventListener('battery', (e) => {
        const lvl = (e as CustomEvent<BatteryDetail>).detail.level;
        $('sleepBattery').textContent = `Battery ${lvl}%${lvl < 50 ? ' – charge it before a full night' : ''}`;
      });
      p.addEventListener('disconnect', () => void onDisconnect());
    }
    polar = p;
    drawFrame ||= requestAnimationFrame(drawLoop);
    if (p.accOk) status(`${p.name} – heart beats, movement${p.ecgOk ? ' and ECG' : ''}`, 'on');
    else status(`${p.name} – movement unavailable, sleep can't be analysed`, 'busy');
    syncButtons();
  }

  async function onDisconnect(): Promise<void> {
    if (!recorder) {
      status('Sensor disconnected', '');
      polar = null;
      clearTrace();
      syncButtons();
      return;
    }
    // during the night: keep the recording and keep trying to get the strap back
    if (reconnecting || !polar) return;
    reconnecting = true;
    gaps++;
    $('sleepGaps').textContent = `${gaps} gap${gaps > 1 ? 's' : ''} (reconnected)`;
    while (recorder && polar && !polar.connected) {
      status('Strap disconnected – reconnecting…', 'busy');
      try {
        await polar.reconnect(log);
        strapReady(polar); // the other pages use it again too
      } catch (err) {
        log(`Reconnect failed: ${errorMessage(err)}`);
        await sleep(15000);
      }
    }
    reconnecting = false;
  }

  async function disconnect(): Promise<void> {
    polar = null;
    clearTrace();
    await disconnectStrap();
    status('Not connected', '');
    $('sleepBattery').textContent = '';
    syncButtons();
  }

  // ---------- recording ----------

  async function requestWakeLock(): Promise<void> {
    try { wakeLock = 'wakeLock' in navigator ? await navigator.wakeLock.request('screen') : null; } catch { /* not supported */ }
  }

  async function startRecording(lengthS: number | null = track.seconds(), show = true): Promise<void> {
    ecg = { chunks: [], n: 0 };
    recorder = new SleepRecorder(ACC_FS);
    stopAfter = lengthS; showWhenDone = show;
    track.disable(true);
    recUser = deps.user();
    gaps = 0;
    $('sleepGaps').textContent = 'no gaps';
    $('sleepSince').textContent = `since ${fmtClock(recorder.start)}${lengthS ? ` · stops at ${fmtClock(recorder.start + lengthS * 1000)}` : ''}`;
    await requestWakeLock();
    partSeq = 0; ecgSent = 0;
    store.setSleepRecording(true);
    partTimer = setInterval(() => void savePart(), PART_MS);
    tick = setInterval(updateLive, 2000);
    updateLive();
    refreshUser();
    syncButtons();
    deps.recordingChanged();
  }

  /** Saves what is new; one at a time, so the parts stay in order. */
  function savePart(): Promise<void> {
    const r = recorder, night = ecg;
    if (!r) return partSaving;
    const add = r.takeNew(), chunks = night?.chunks.slice(ecgSent) ?? [];
    ecgSent = night?.chunks.length ?? 0;
    const e = new Int16Array(chunks.reduce((s, c) => s + c.length, 0));
    let o = 0;
    for (const c of chunks) { e.set(c, o); o += c.length; }
    const seq = partSeq++;
    const part = { ...add, id: `${r.start}:${seq}`, rec: r.start, user: recUser, seq, at: Date.now(), ecg: e };
    partSaving = partSaving.then(() => store.saveRecordingPart(part)).catch((err: unknown) => log(`Couldn’t save part of the recording: ${errorMessage(err)}`));
    return partSaving;
  }

  /** Recordings left unfinished by a closed page or a crash are saved as they stood. */
  async function recoverRecordings(): Promise<void> {
    const parts = await store.listRecordingParts();
    for (const rec of new Set(parts.map((p) => p.rec))) {
      if (rec === recorder?.start) continue;
      const mine = parts.filter((p) => p.rec === rec);
      if (Date.now() - Math.max(...mine.map((p) => p.at)) < LIVE_PART_MS) continue; // probably still running in another tab
      const { session } = await store.loadSleep(`n${rec}`);
      if (!session) {
        const { data, ecg: samples } = joinParts(mine);
        if (data.durationS >= MIN_SAVE_S) {
          await saveRecording(rec, (mine[0]?.user ?? 1) as UserNumber, data, samples);
          const text = `A sleep recording from ${new Date(rec).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} wasn’t stopped, so it was restored up to ${fmtTime(data.durationS)} long. It is in Sleep history.`;
          for (const id of ['sleepRecovered', 'sleepRecoveredHistory']) { $(id).textContent = text; $(id).hidden = false; }
          if ($('view-sleepHistory').classList.contains('active')) void renderHistory();
        }
      }
      await store.deleteRecordingParts(rec);
    }
  }

  function updateLive(): void {
    const r = recorder;
    if (!r) return;
    if (stopAfter != null && r.elapsedS >= stopAfter) { void stopRecording(showWhenDone); return; }
    $('sleepElapsed').textContent = fmtTime(r.elapsedS);
    $('sleepDimClock').textContent = fmtTime(r.elapsedS);
    $('sleepBeats').textContent = String(r.beats);
    if (ecg) $('sleepGaps').textContent = `${gaps ? `${gaps} gap${gaps > 1 ? 's' : ''} · ` : ''}ECG ${fmtTime(ecg.n / ECG_FS)} recorded`;
    const recent = r.recent(10);
    $('sleepHR').textContent = recent.hr ? String(Math.round(recent.hr)) : '--';
    $('sleepMove').textContent = recent.moving === null ? '--' : recent.moving ? 'Moving' : 'Still';
  }

  /** Gives the saved recording's id; with `show`, opens its report. */
  async function stopRecording(show = true): Promise<string | null> {
    const r = recorder;
    if (!r) return null;
    const nightEcg = ecg;
    recorder = null;
    ecg = null;
    stopAfter = null;
    track.disable(false);
    if (tick) clearInterval(tick);
    tick = null;
    if (partTimer) clearInterval(partTimer);
    partTimer = null;
    await partSaving;
    try { await wakeLock?.release(); } catch { /* ignore */ }
    wakeLock = null;
    $('sleepDim').hidden = true;
    $('sleepSince').textContent = 'not recording';
    syncButtons();
    deps.recordingChanged();
    refreshUser();
    const data = r.data();
    if (data.durationS < MIN_SAVE_S) {
      $('sleepElapsed').textContent = 'Too short';
      $('sleepSince').textContent = 'recordings under 10 min aren’t saved';
      await store.deleteRecordingParts(r.start).catch(() => undefined);
      store.setSleepRecording(false);
      return null;
    }
    const samples = new Int16Array(nightEcg?.n ?? 0);
    let o = 0;
    for (const c of nightEcg?.chunks ?? []) { samples.set(c, o); o += c.length; }
    const id = await saveRecording(r.start, recUser, data, samples);
    await store.deleteRecordingParts(r.start).catch(() => undefined);
    store.setSleepRecording(false);
    if (show) await openReport(id);
    return id;
  }

  /** Saves a finished recording, and its ECG if long enough. */
  async function saveRecording(start: number, user: UserNumber, data: SleepData, samples: Int16Array): Promise<string> {
    const session: SleepSession = { id: `n${start}`, user, start, durationS: data.durationS, source: 'polar', summary: null };
    if (samples.length >= MIN_SAVE_S * ECG_FS) {
      // the night's ECG goes into ECG history too, linked both ways
      const ecgSession: Session = {
        id: `s${start}`, user, start, durationS: samples.length / ECG_FS, fs: ECG_FS, alias: store.loadSettings(user).alias,
        source: 'polar', userEvents: [], summary: null, sleepId: session.id,
      };
      await store.saveSession(ecgSession, samples);
      session.ecgId = ecgSession.id;
    }
    await store.saveSleep(session, data);
    historyChanged();
    deps.sleepChanged();
    return session.id;
  }

  async function demoNight(): Promise<void> {
    const seed = Date.now() & 0xffff;
    const { data } = simulateNight(seed);
    // pretend it was last night, going to bed around half past eleven
    const bed = new Date();
    bed.setDate(bed.getDate() - 1);
    bed.setHours(23, 20 + (seed % 25), 0, 0);
    const session: SleepSession = { id: `n${bed.getTime()}-${seed}`, user: deps.user(), start: bed.getTime(), durationS: data.durationS, source: 'demo', summary: null };
    await store.saveSleep(session, data);
    historyChanged();
    deps.sleepChanged();
    await openReport(session.id);
  }

  // ---------- history ----------

  async function renderHistory(): Promise<void> {
    const user = deps.user();
    $('sleepHistoryUser').textContent = `· ${deps.userLabel(user)}`;
    let nights: SleepSession[] = [];
    try { nights = await store.listSleeps(user); } catch { /* storage blocked */ }
    const list = $('sleepList');
    list.replaceChildren();
    $('sleepEmpty').hidden = nights.length > 0;
    for (const n of nights) {
      const s = n.summary;
      const nap = isNap(n.start, n.durationS, n.context);
      const li = make('li');
      const stats = s ? [nap ? '' : `Score ${s.score}`, `${s.awakenings} awakening${s.awakenings === 1 ? '' : 's'}`, `HR ${fmt(s.avgHR)} bpm`, `HRV ${fmt(s.avgHrv)} ms`, fmtHM(s.sleepMin)] : ['Open to analyse', fmtTime(n.durationS)];
      li.append(
        make('span', 'when', `${new Date(n.start).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · ${nap ? 'Nap' : 'Night'}`),
        make('span', 'dur', [n.source === 'demo' ? 'demo' : '', n.ecgId ? 'with ECG' : '', n.cloudOnly ? 'synced copy' : ''].filter(Boolean).join(' · ')),
        make('span', 'stats', stats.filter(Boolean).join(' · ')),
      );
      const word = nap ? 'nap' : 'night';
      li.appendChild(deleteButton(`this ${word}`, async () => { await deleteNight(n); void renderHistory(); }, `Delete this ${word}? You can get it back from the Recovery centre. It is also removed from your other devices.`));
      li.addEventListener('click', () => void openReport(n.id));
      list.appendChild(li);
    }
  }

  // ---------- report ----------

  const hypno = new Hypnogram(document.querySelector<HTMLElement>('#view-sleepReport .chart.hypno') ?? $('sleepBody'));
  const bars = new Bars(document.querySelector<HTMLElement>('#view-sleepReport .chart.bars') ?? $('sleepBody'));
  const [hrChartEl, brChartEl] = [...document.querySelectorAll<HTMLElement>('#view-sleepReport .grid2 .chart')];
  if (!hrChartEl || !brChartEl) throw new Error('sleep report needs two charts');
  const hrPlot = new Plot(hrChartEl);
  const brPlot = new Plot(brChartEl);
  let current: { session: SleepSession; analysis: SleepAnalysis } | null = null;
  let olderId: string | null = null, newerId: string | null = null;
  let backTo: (() => void) | null = null;
  let donutParts: { key: SleepStageKey; value: number }[] = [];

  const stageKey = (s: Stage): SleepStageKey | null => (s === 'nodata' || s === 'uncertain' ? null : s);

  /** `from` is set when another page opened the report: its back button returns there. */
  async function openReport(id: string, from?: () => void): Promise<void> {
    backTo = from ?? null;
    $('btnSleepBack').textContent = from ? '← Back' : '← Sleep history';
    deps.showSleepView('sleepReport');
    const busy = $('sleepBusy'), body = $('sleepBody');
    busy.hidden = false;
    busy.textContent = 'Analysing the recording…';
    body.hidden = true;
    await new Promise((r) => setTimeout(r, 30));
    const { session, signals } = await store.loadSleep(id);
    if (!session) { busy.textContent = 'Recording not found.'; return; }
    let analysis: SleepAnalysis;
    if (session.cloudOnly) {
      // a report copy synced from another device: shown as it was calculated there
      const report = parseSleepReport(session.report);
      if (!report) { busy.textContent = 'This synced recording could not be read.'; return; }
      analysis = toAnalysis(report);
    } else {
      if (!signals) { busy.textContent = 'Recording not found.'; return; }
      const data: SleepData = { durationS: session.durationS, ...signals };
      analysis = analyzeSleep(data, { onsetUnknown: session.onsetUnknown === true });
      const m = analysis.metrics;
      session.summary = { sleepMin: m.sleepMin, score: m.score, awakenings: m.awakenings, avgHR: m.avgHR, avgHrv: m.avgHrv, breathingRate: m.breathingRate };
      store.updateSleep(session).catch(() => {});
    }
    await showReport(session, analysis, from);
  }

  /** A saved version of a report, for Synchronised Sleep Tracking: it shows that version's results and can't be deleted. */
  async function openCopy(session: SleepSession, report: SleepReport, from: () => void): Promise<void> {
    backTo = from;
    $('btnSleepBack').textContent = '← Back';
    deps.showSleepView('sleepReport');
    await showReport(session, toAnalysis(report), from, true);
  }

  let showingCopy = false;

  async function showReport(session: SleepSession, analysis: SleepAnalysis, from?: () => void, copy = false): Promise<void> {
    const busy = $('sleepBusy'), body = $('sleepBody');
    current = { session, analysis };
    showingCopy = copy;
    // naps compare with naps and nights with nights: a nap would skew a night's ranges
    const nap = isNap(session.start, session.durationS, session.context);
    const all = await store.listSleeps(session.user);
    const earlier = all.filter((n) => n.start < session.start && isNap(n.start, n.durationS, n.context) === nap);
    renderReport(session, analysis, earlier, copy ? [session] : all);
    $button('btnSleepDelete').hidden = copy;
    if (copy) $('sleepMeta').textContent += ' · Saved version of this report';
    busy.hidden = true;
    body.hidden = false;
    hypno.draw(); bars.draw(); hrPlot.draw(); brPlot.draw();
    const ecgSection = $('sleepEcgSection');
    const ecgId = session.ecgId ?? (await deps.ecgDuring(session.start, session.start + session.durationS * 1000))?.id;
    ecgSection.hidden = !ecgId && !from;
    if (ecgId) void deps.renderNightEcg($('sleepEcgBody'), ecgId);
    else $('sleepEcgBody').replaceChildren(make('p', 'muted', 'No ECG was saved during this sleep.'));
    drawDonut($canvas('sleepDonut'), donutParts); // needs the report to be visible to have a size
  }

  function renderReport(session: SleepSession, a: SleepAnalysis, earlier: readonly SleepSession[], all: readonly SleepSession[]): void {
    const m = a.metrics;
    const start = session.start;
    const nap = isNap(start, session.durationS, session.context);
    const word = nap ? 'nap' : 'night';
    $('sleepMeta').textContent = [
      deps.userLabel(session.user),
      session.source === 'demo' ? 'Demo night' : 'Polar H10',
      session.cloudOnly ? 'Synced copy from another device (as calculated there)' : '',
      m.coverage < 95 ? `Heart and movement data for ${fmt(m.coverage)} % of the ${word}` : '',
    ].filter(Boolean).join(' · ');
    $('sleepHeroLabel').textContent = `${nap ? 'Nap' : 'Night'} sleep`;
    for (const [id, what] of [['sleepHrCaption', 'Heart rate'], ['sleepBrCaption', 'Breathing rate']] as const) $(id).textContent = `${what} through the ${word}`;
    $('sleepEcgHeading').textContent = `ECG during the ${word}`;
    document.querySelector('#view-sleepReport .chart.bars')?.setAttribute('aria-label', `Times woke up, last 7 ${word}s`);
    $('sleepDuration').textContent = m.sleepMin ? fmtHM(m.sleepMin) : 'No sleep detected';
    const wakeMs = Number.isFinite(m.wakeS) ? start + m.wakeS * 1000 : start + session.durationS * 1000;
    const dayLabel = (ms: number): string => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'numeric' });
    $('sleepDate').textContent = new Date(wakeMs).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    $('sleepBedDate').textContent = dayLabel(start);
    $('sleepWakeDate').textContent = dayLabel(wakeMs);
    // ‹ and › step through all of this user's sleep, newest first
    const at = all.findIndex((n) => n.id === session.id);
    olderId = all[at + 1]?.id ?? null;
    newerId = all[at - 1]?.id ?? null;
    $button('btnSleepOlder').disabled = !olderId;
    $button('btnSleepNewer').disabled = !newerId;

    hypno.set(a.stages.map(stageKey), start, EPOCH_S);
    $('sleepBed').textContent = fmtClock(start);
    $('sleepWake').textContent = Number.isFinite(m.wakeS) ? fmtClock(start + m.wakeS * 1000) : '--';
    const keys: SleepStageKey[] = ['deep', 'light', 'rem', 'awake'];
    $('sleepLegend').replaceChildren(...keys.map((k) => {
      const item = make('span');
      const sw = make('span', 'swatch');
      sw.style.background = `var(${STAGE_COLOR_VAR[k]})`;
      item.append(sw, STAGE_LABEL[k]);
      return item;
    }));

    // naps that day, listed under the night
    const naps = nap ? [] : all.filter((n) => isNap(n.start, n.durationS, n.context) && new Date(n.start).toDateString() === new Date(wakeMs).toDateString()).reverse();
    const napBox = $('sleepNaps');
    napBox.hidden = naps.length === 0;
    napBox.replaceChildren(make('h3', '', `Naps that day · ${fmtHM(naps.reduce((min, n) => min + (n.summary?.sleepMin ?? n.durationS / 60), 0))}`));
    for (const n of naps) {
      const r = make('div', 'row between d2-more-row');
      r.append(make('span', 'muted', `${fmtClock(n.start)}–${fmtClock(n.start + n.durationS * 1000)}`), make('span', '', fmtHM(n.summary?.sleepMin ?? n.durationS / 60)));
      napBox.appendChild(r);
    }

    // score
    $('sleepScoreCard').hidden = nap; // the score expects a full night, so naps aren't scored
    $('sleepScoreHowBox').hidden = nap;
    const half = Math.ceil(Math.max(0, Math.min(100, m.score)) / 10); // 0–10 half stars
    $('sleepStars').setAttribute('aria-label', `${half / 2} of 5 stars`);
    $('sleepStars').replaceChildren(...[0, 1, 2, 3, 4].map((i) => make('span', `d2-star ${half >= 2 * (i + 1) ? 'full' : half === 2 * i + 1 ? 'half' : 'empty'}`, '★')));
    $('sleepScore').textContent = m.sleepMin ? String(m.score) : '--';
    $('sleepScoreWord').textContent = !m.sleepMin ? '' : m.score >= 85 ? 'Very good night' : m.score >= 70 ? 'Good night' : m.score >= 55 ? 'Fair night' : 'Poor night';
    $('sleepScoreHow').textContent = SCORE_EXPLANATION;

    // times woke up, last 7 nights (or naps) including this one
    const week = [...earlier.slice(0, 6).reverse(), session];
    bars.set(week.map((n) => {
      const v = n.id === session.id ? m.awakenings : n.summary?.awakenings ?? 0;
      return { label: dayLabel(n.start), value: v, title: `${dayLabel(n.start)} · <b>${v} time${v === 1 ? '' : 's'}</b>`, highlight: n.id === session.id };
    }));
    $('sleepBarsRange').textContent = week.length > 1 ? `(${dayLabel(week[0]?.start ?? start)}–${dayLabel(start)})` : '';
    const wakeCount = $('sleepWakeCount');
    wakeCount.className = m.awakenings > 1 ? 'd2-high' : 'd2-normal';
    wakeCount.textContent = `${m.awakenings} time${m.awakenings === 1 ? '' : 's'}`;

    // stage ring and list
    const parts = [
      { key: 'deep' as const, value: m.deepMin, pct: m.deepPct },
      { key: 'light' as const, value: m.lightMin, pct: m.lightPct },
      { key: 'rem' as const, value: m.remMin, pct: m.remPct },
    ];
    donutParts = parts;
    $('sleepStageList').replaceChildren(...parts.map((p) => {
      const li = make('li');
      const name = make('span', 'dot-label');
      const sw = make('span', 'swatch');
      sw.style.background = `var(${STAGE_COLOR_VAR[p.key]})`;
      name.append(sw, STAGE_LABEL[p.key]);
      li.append(name, make('span', '', fmtHM(p.value)), make('span', 'pct', `${fmt(p.pct)} %`));
      return li;
    }));

    // tiles with reference and personal ranges
    const R = sleepRanges();
    const outliers: Outlier[] = [];
    /** Checks a value against its range: a value outside it goes on the outliers list. Gives the words and colour to show, and the reference text. */
    const judge = (k: string, v: string, unit: string, ref?: MetricRef | null): { text: string; kind: string; ref: string } | null => {
      if (!ref) return null;
      if (!('range' in ref)) return { text: '', kind: '', ref: ref.skipped };
      const rangeText = ref.rangeText ?? `${fmtRange(ref.range)}${unit ? ` ${unit}` : ''}`;
      const own = ref.label === 'Personal range';
      const refText = `${own ? 'Personal range:' : 'References:'} ${rangeText}`;
      const status = checkRange(ref.range, ref.value);
      if (status) {
        const label = status === 'high' ? ref.range.highLabel : ref.range.lowLabel;
        outliers.push({ name: label ? `${k} (${label.toLowerCase()})` : k, value: `${v}${unit ? ` ${unit}` : ''}`, range: rangeText, status });
        return { text: label ?? (own ? `${status === 'high' ? 'Above' : 'Below'} range` : status === 'high' ? 'High' : 'Low'), kind: own ? 'personal' : status, ref: refText };
      }
      return { text: ref.value != null && Number.isFinite(ref.value) ? ref.okLabel ?? '' : '', kind: own ? 'personal' : 'normal', ref: refText };
    };
    const tile = (k: string, v: string, unit: string, note: string, ref?: MetricRef | null): HTMLDivElement => {
      const verdict = judge(k, v, unit, ref);
      const box = make('div', 'd2-tile'), value = make('div', 'd2-tile-value', v);
      if (unit) value.appendChild(make('small', '', ` ${unit}`));
      if (verdict?.text) value.appendChild(make('span', `d2-verdict d2-${verdict.kind}`, ` ${verdict.text}`));
      box.append(make('div', 'd2-tile-name', k), value, make('div', 'd2-tile-ref', [verdict?.ref, note].filter(Boolean).join(' · ')));
      return box;
    };
    const normal = (range: MetricRef & { range: unknown }): MetricRef => ({ ...range, okLabel: 'Normal' });
    const personal = (values: number[], value: number, unit: string): MetricRef => {
      const range = personalRange(values);
      if (!range) return { skipped: `Personal range after 3 ${word}s (${Math.min(values.length, 3)}/3 so far)` };
      return { range, value, label: 'Personal range', rangeText: `${range.lo}–${range.hi} ${unit}`, okLabel: 'Within range' };
    };
    const prev = (f: (s: NonNullable<SleepSession['summary']>) => number): number[] => earlier.flatMap((n) => (n.summary ? [f(n.summary)] : []));
    // in the order of D2 Link's report
    $('sleepTiles').replaceChildren(
      tile('Times woke up', String(m.awakenings), 'times', '', normal({ range: R.awakenings, value: m.awakenings, rangeText: '0–1 times' })),
      tile('Light sleep', fmt(m.lightPct), '%', fmtHM(m.lightMin), normal({ range: R.lightPct, value: m.lightPct, rangeText: '<55 %' })),
      tile('Avg heart rate', fmt(m.avgHR), 'bpm', `lowest ${fmt(m.minHR)} bpm`, personal(prev((s) => s.avgHR), m.avgHR, 'bpm')),
      tile(`${nap ? 'Nap' : 'Night'} sleep`, fmtHM(m.sleepMin), '', 'deep + light + REM', nap ? null : normal({ range: R.sleepHours, value: m.sleepMin / 60, rangeText: '6–10 h' })),
      tile('Deep sleep', fmt(m.deepPct), '%', fmtHM(m.deepMin), normal({ range: R.deepPct, value: m.deepPct })),
      tile('REM sleep', fmt(m.remPct), '%', fmtHM(m.remMin), normal({ range: R.remPct, value: m.remPct })),
      tile('Deep sleep continuity', fmt(m.deepContinuity), 'points', 'deep sleep in spells of 10 min or more', normal({ range: R.continuity, value: m.deepContinuity, rangeText: '70–100 points' })),
      tile('Breathing quality', fmt(m.breathingRegularity), 'points', 'steady breathing scores higher', normal({ range: R.regularity, value: m.breathingRegularity, rangeText: '70–100 points' })),
      tile('Avg HRV', fmt(m.avgHrv), 'ms', 'RMSSD while asleep', personal(prev((s) => s.avgHrv), m.avgHrv, 'ms')),
      tile('Avg SpO₂', '--', '', 'Not measured: the Polar H10 has no blood-oxygen sensor'),
      tile('Avg respiratory rate', fmt(m.breathingRate, 1), 'brpm', 'while asleep', normal({ range: R.breathing, value: m.breathingRate })),
    );

    // the measures D2 Link lists under "More from the watch"
    const more = $('sleepMore');
    more.replaceChildren(make('h3', '', 'More from the strap'));
    const onset = Number.isFinite(m.onsetS) ? ` (fell asleep ${fmtClock(start + m.onsetS * 1000)})` : '';
    const moreRows: [string, string, MetricRef][] = [
      ['Sleep efficiency', fmt(m.efficiency), normal({ range: R.efficiency, value: m.efficiency })],
      ['Time to fall asleep', fmt(m.latencyMin), normal({ range: R.latency, value: m.latencyMin })],
      ['Awake after falling asleep', fmt(m.awakeMin), normal({ range: R.waso, value: m.awakeMin })],
    ];
    const row = (k: string, v: string): void => {
      const r = make('div', 'row between d2-more-row');
      r.append(make('span', 'muted', k), make('span', '', v));
      more.appendChild(r);
    };
    row('Time in bed', `${fmtClock(start)}–${fmtClock(start + session.durationS * 1000)} (${fmtHM(m.timeInBedMin)})`);
    for (const [k, v, ref] of moreRows) {
      const unit = k === 'Sleep efficiency' ? '%' : 'min';
      const verdict = judge(k, v, unit, ref);
      row(k, `${v} ${unit}${k === 'Sleep efficiency' ? ' (asleep ÷ time in bed)' : k === 'Time to fall asleep' ? onset : ''}${verdict?.text ? ` · ${verdict.text}` : ''}`);
    }

    renderOutliers($('sleepFlags'), outliers, [
      'Sleep stages are experimental estimates, not checked against a sleep study; see “About these numbers” below.',
      ...(m.rrPct == null ? [] : [`Signal: heart rate ${fmt(m.rrPct)} %, HRV ${fmt(m.hrvPct ?? NaN)} %, movement ${fmt(m.movementPct ?? NaN)} %, breathing ${fmt(m.breathingPct ?? NaN)} %.`]),
      ...(m.uncertainMin ? [`${fmtHM(m.uncertainMin)} of sleep had too little signal to name a stage. It counts as sleep, but appears as a gap in the stages.`] : []),
      ...(m.quietWakes ? [`Possibly awake while lying still ${m.quietWakes} time${m.quietWakes === 1 ? '' : 's'}: heart rate rose without movement. This doesn’t change the stages or score.`] : []),
      ...(session.onsetUnknown ? ['This recording started after you fell asleep, so the time you fell asleep isn’t known.'] : []),
    ]);
    renderContext(session, showingCopy);

    // heart rate and breathing through the night, as clock time
    const toPoints = (series: readonly (number | null)[]): Point[] => {
      const pts: Point[] = [];
      const stride = Math.max(1, Math.ceil(series.length / 600));
      for (let e = 0; e < series.length; e += stride) pts.push([start + e * EPOCH_S * 1000, series[e] ?? null]);
      return pts;
    };
    hrPlot.set({ type: 'line', points: toPoints(a.hr), xFmt: fmtClock, yLabel: 'bpm', tooltip: (p) => `${fmtClock(p[0])} · <b>${Math.round(p[1])} bpm</b>` });
    brPlot.set({ type: 'line', points: toPoints(a.breathing), xFmt: fmtClock, yLabel: '/min', tooltip: (p) => `${fmtClock(p[0])} · <b>${p[1].toFixed(1)} breaths/min</b>` });

    $('sleepSources').replaceChildren(...SLEEP_SOURCES.map(([what, text]) => {
      const li = make('li');
      li.append(make('b', '', `${what}: `), text);
      return li;
    }));
  }

  function fileStem(session: SleepSession): string {
    const d = new Date(session.start);
    const p = (v: number): string => String(v).padStart(2, '0');
    return `sleep_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  }

  // ---------- wiring ----------

  $button('btnSleepConnect').addEventListener('click', () => void connect());
  $button('btnSleepDisconnect').addEventListener('click', () => void disconnect());
  $button('btnSleepDemo').addEventListener('click', () => void demoNight());
  $button('btnSleepStart').addEventListener('click', () => void (recorder ? stopRecording() : startRecording()));
  $button('btnSleepDim').addEventListener('click', () => { $('sleepDim').hidden = false; });
  $('sleepDim').addEventListener('click', () => { $('sleepDim').hidden = true; });
  // the last minutes, if the page is going away, and a warning before it does
  window.addEventListener('pagehide', () => { if (recorder) void savePart(); });
  window.addEventListener('beforeunload', (e) => { if (recorder) e.preventDefault(); });
  void recoverRecordings().catch(() => undefined);
  setInterval(() => { if (!recorder) void recoverRecordings().catch(() => undefined); }, LIVE_PART_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && recorder && !wakeLock) void requestWakeLock();
  });
  $button('btnSleepBack').addEventListener('click', () => { if (backTo) backTo(); else deps.showSleepView('sleepHistory'); });
  $button('btnSleepOlder').addEventListener('click', () => { if (olderId) void openReport(olderId, backTo ?? undefined); });
  $button('btnSleepNewer').addEventListener('click', () => { if (newerId) void openReport(newerId, backTo ?? undefined); });
  $button('btnSleepPrint').addEventListener('click', () => window.print());
  /** Deletes a night (after the caller asked); its ECG is deleted too only if the user says so. */
  async function deleteNight(night: SleepSession): Promise<void> {
    const ecgId = night.ecgId;
    if (ecgId && window.confirm(`Also delete the ECG recorded during this ${isNap(night.start, night.durationS, night.context) ? 'nap' : 'night'}? (Cancel keeps it in ECG history and trending.)`)) await store.deleteSession(ecgId);
    else if (ecgId) {
      // keep the ECG, but stop it pointing at a night that no longer exists
      // (a cloud copy may keep the link; the ECG report hides "Open sleep report" when the night is gone)
      const { session: kept } = await store.loadSession(ecgId);
      if (kept) {
        const { sleepId: _gone, ...rest } = kept;
        await store.updateSession(rest);
      }
    }
    await store.deleteSleep(night.id);
    historyChanged();
    deps.sleepChanged();
  }
  /** Night or nap, and whether the recording began after falling asleep: the person knows better than the clock. */
  function renderContext(session: SleepSession, copy: boolean): void {
    const box = $('sleepContext');
    box.replaceChildren();
    if (copy) return; // a saved version shows the sleep as it was, so it can't be changed from here
    const pick = make('select'), label = make('label', 'd2-days', 'Count this as ');
    pick.setAttribute('aria-label', 'Count this as');
    for (const [v, t] of [['', 'Automatic (by the time)'], ['night', 'Night'], ['nap', 'Nap']] as const) { const o = make('option', '', t); o.value = v; pick.appendChild(o); }
    pick.value = session.context ?? '';
    label.appendChild(pick);
    const late = make('input'), lateLabel = make('label', 'd2-days');
    late.type = 'checkbox'; late.checked = session.onsetUnknown === true;
    lateLabel.append(late, ' Recording started after I fell asleep');
    const apply = (): void => void (async () => {
      const { session: now } = await store.loadSleep(session.id); // the recording as it is now, not as this page opened it
      if (!now) return;
      const { context: _c, onsetUnknown: _o, ...rest } = now;
      const next: SleepSession = { ...rest, labelAt: Date.now(), ...(pick.value === 'night' || pick.value === 'nap' ? { context: pick.value } : {}), ...(late.checked ? { onsetUnknown: true } : {}) };
      await store.updateSleep(next);
      deps.sleepChanged();
      historyChanged();
      await openReport(session.id);
    })();
    pick.addEventListener('change', apply);
    late.addEventListener('change', apply);
    box.replaceChildren(label, lateLabel);
  }

  $button('btnSleepDelete').addEventListener('click', () => {
    void (async () => {
      if (!current || !window.confirm(`Delete this ${isNap(current.session.start, current.session.durationS, current.session.context) ? 'nap' : 'night'}? You can get it back from the Recovery centre.`)) return;
      await deleteNight(current.session);
      current = null;
      deps.showSleepView('sleepHistory');
    })();
  });
  $button('btnSleepCsv').addEventListener('click', () => {
    if (!current) return;
    const { session, analysis: a } = current;
    const r = (v: number | null | undefined, d = 1): string => (v == null || !Number.isFinite(v) ? '' : v.toFixed(d));
    const rows = [['time', 'stage', 'hr_bpm', 'breathing_per_min', 'movement_mg']];
    a.stages.forEach((s, e) => rows.push([new Date(session.start + e * EPOCH_S * 1000).toISOString(), s, r(a.hr[e]), r(a.breathing[e]), r(a.activity[e])]));
    download(new Blob([rows.map((x) => x.join(',')).join('\n')], { type: 'text/csv' }), `${fileStem(session)}_epochs.csv`);
  });
  $button('btnSleepJson').addEventListener('click', () => {
    if (!current) return;
    const { session, analysis } = current;
    const { score: _metricsScore, ...napMetrics } = analysis.metrics;
    const { score: _summaryScore, ...napSummary } = session.summary ?? { score: 0 };
    const nap = isNap(session.start, session.durationS, session.context);
    const out = { app: 'OpenBeat ECG', sleep: nap ? { ...session, summary: napSummary } : { ...session }, metrics: nap ? napMetrics : analysis.metrics, ranges: sleepRanges(), epochS: EPOCH_S, stages: analysis.stages };
    download(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }), `${fileStem(session)}_sleep.json`);
  });

  if (!bluetoothAvailable() || !window.isSecureContext) {
    $button('btnSleepConnect').disabled = true;
    const note = $('sleepNote');
    note.hidden = false;
    note.textContent = 'This browser can’t connect to the strap (use Chrome or Edge, or Bluefy on iPhone). Demo night still works.';
  }
  // nights arrived from (or were deleted on) another device
  account.cloud?.addEventListener('changed', () => {
    if ($('view-sleepHistory').classList.contains('active')) void renderHistory();
  });
  refreshUser();
  syncButtons();

  keepStrapWhen(() => recorder !== null);
  onStrap(useStrap);

  return {
    renderHistory,
    openReport,
    openCopy,
    isRecording: () => recorder !== null,
    recording: {
      canStart: () => polar?.connected === true && polar.accOk === true,
      start: (lengthS) => startRecording(lengthS, false),
      stop: () => stopRecording(false),
      elapsed: () => (recorder ? fmtTime(recorder.elapsedS) : ''),
    },
    refreshUser,
  };
}
