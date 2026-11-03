// Sleep monitor, sleep history and the sleep report.

import { connectStrap, disconnectStrap, keepStrapWhen, onStrap, strapReady } from './devices';
import { ACC_FS, ECG_FS, bluetoothAvailable, type PolarH10, type AccDetail, type EcgDetail, type HrDetail, type BatteryDetail } from './polar';
import { analyzeSleep, SleepRecorder, EPOCH_S, SCORE_EXPLANATION, type SleepAnalysis, type SleepData, type Stage } from './sleep';
import { simulateNight } from './sleepsim';
import { Plot, Hypnogram, Bars, drawDonut, fmtClock, fmtTime, STAGE_COLOR_VAR, STAGE_LABEL, type Point, type SleepStageKey } from './charts';
import { sleepRanges, personalRange, SLEEP_SOURCES } from './ranges';
import * as store from './store';
import type { Session, SleepSession, UserNumber } from './store';
import { $, $button, $canvas, make, deleteButton, fmt, fmtHM, metricTile, renderOutliers, download, type Outlier, type MetricRef } from './ui';
import { errorMessage, errorName, sleep } from './util';
import { current as account, historyChanged } from './account';
import { parseSleepReport, toAnalysis } from './summary';

export interface SleepDeps {
  /** Fills the sleep report's "ECG during the night" section (the ECG screens own the ECG tiles). */
  renderNightEcg: (box: HTMLElement, ecgId: string) => Promise<void>;
  user: () => UserNumber;
  userLabel: (u: UserNumber) => string;
  showSleepView: (view: 'sleep' | 'sleepHistory' | 'sleepReport') => void;
  /** The ECG live screen has the strap; it can only stream to one screen at a time. */
  /** Tell the app whether a sleep recording is running (it locks the user selector). */
  recordingChanged: () => void;
}

const MIN_SAVE_S = 10 * 60;

export function initSleep(deps: SleepDeps): {
  renderHistory: () => Promise<void>;
  openReport: (id: string) => Promise<void>;
  isRecording: () => boolean;
  refreshUser: () => void;
} {
  let polar: PolarH10 | null = null;
  let attached: PolarH10 | null = null; // the strap this page listens to
  let recorder: SleepRecorder | null = null;
  let recUser: UserNumber = deps.user();
  // "Start sleep & ECG recording": the night's ECG, collected alongside the sleep data
  let ecg: { chunks: Int16Array[]; n: number } | null = null;
  let tick: ReturnType<typeof setInterval> | null = null;
  let wakeLock: WakeLockSentinel | null = null;
  let reconnecting = false;
  let gaps = 0;

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

  function syncButtons(): void {
    const connected = polar?.connected ?? false;
    $button('btnSleepConnect').hidden = connected;
    $button('btnSleepDemo').hidden = recorder !== null;
    $button('btnSleepDisconnect').hidden = !connected || recorder !== null;
    $('sleepPairHint').hidden = connected || $button('btnSleepConnect').disabled;
    const start = $button('btnSleepStart');
    start.disabled = !recorder && !(connected && polar?.accOk);
    start.textContent = recorder ? (ecg ? 'Stop sleep & ECG – I’m awake' : 'Stop – I’m awake') : 'Start sleep recording';
    start.classList.toggle('recording', recorder !== null);
    const both = $button('btnSleepEcgStart');
    both.hidden = recorder !== null;
    both.disabled = !(connected && polar?.accOk && polar.ecgOk);
    both.title = connected && !polar?.ecgOk ? 'The ECG stream isn’t running on this connection' : '';
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
        if (!recorder || !ecg) return;
        const s = (e as CustomEvent<EcgDetail>).detail.samples;
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
    if (p.accOk) status(`${p.name} – heart beats, movement${p.ecgOk ? ' and ECG' : ''}`, 'on');
    else status(`${p.name} – movement unavailable, sleep can't be analysed`, 'busy');
    syncButtons();
  }

  async function onDisconnect(): Promise<void> {
    if (!recorder) {
      status('Sensor disconnected', '');
      polar = null;
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
    await disconnectStrap();
    status('Not connected', '');
    $('sleepBattery').textContent = '';
    syncButtons();
  }

  // ---------- recording ----------

  async function requestWakeLock(): Promise<void> {
    try { wakeLock = 'wakeLock' in navigator ? await navigator.wakeLock.request('screen') : null; } catch { /* not supported */ }
  }

  async function startRecording(withEcg = false): Promise<void> {
    ecg = withEcg ? { chunks: [], n: 0 } : null;
    recorder = new SleepRecorder(ACC_FS);
    recUser = deps.user();
    gaps = 0;
    $('sleepGaps').textContent = 'no gaps';
    $('sleepSince').textContent = `since ${fmtClock(recorder.start)}`;
    await requestWakeLock();
    tick = setInterval(updateLive, 2000);
    updateLive();
    refreshUser();
    syncButtons();
    deps.recordingChanged();
  }

  function updateLive(): void {
    const r = recorder;
    if (!r) return;
    $('sleepElapsed').textContent = fmtTime(r.elapsedS);
    $('sleepDimClock').textContent = fmtTime(r.elapsedS);
    $('sleepBeats').textContent = String(r.beats);
    if (ecg) $('sleepGaps').textContent = `${gaps ? `${gaps} gap${gaps > 1 ? 's' : ''} · ` : ''}ECG ${fmtTime(ecg.n / ECG_FS)} recorded`;
    const recent = r.recent(10);
    $('sleepHR').textContent = recent.hr ? String(Math.round(recent.hr)) : '--';
    $('sleepMove').textContent = recent.moving === null ? '--' : recent.moving ? 'Moving' : 'Still';
  }

  async function stopRecording(): Promise<void> {
    const r = recorder;
    if (!r) return;
    const nightEcg = ecg;
    recorder = null;
    ecg = null;
    if (tick) clearInterval(tick);
    tick = null;
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
      return;
    }
    const session: SleepSession = { id: `n${r.start}`, user: recUser, start: r.start, durationS: data.durationS, source: 'polar', summary: null };
    if (nightEcg && nightEcg.n >= MIN_SAVE_S * ECG_FS) {
      // the night's ECG goes into ECG history too, linked both ways
      const samples = new Int16Array(nightEcg.n);
      let o = 0;
      for (const c of nightEcg.chunks) { samples.set(c, o); o += c.length; }
      const ecgSession: Session = {
        id: `s${r.start}`, user: recUser, start: r.start, durationS: nightEcg.n / ECG_FS, fs: ECG_FS, alias: store.loadSettings(recUser).alias,
        source: 'polar', userEvents: [], summary: null, sleepId: session.id,
      };
      await store.saveSession(ecgSession, samples);
      session.ecgId = ecgSession.id;
    }
    await store.saveSleep(session, data);
    historyChanged();
    await openReport(session.id);
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
      const li = make('li');
      li.append(
        make('span', 'when', `Night of ${new Date(n.start).toLocaleDateString([], { dateStyle: 'medium' })}`),
        make('span', 'dur', s ? fmtHM(s.sleepMin) : fmtTime(n.durationS)),
        make('span', 'stats', s ? `Score ${s.score} · ${s.awakenings} awakening${s.awakenings === 1 ? '' : 's'} · HR ${fmt(s.avgHR)} · HRV ${fmt(s.avgHrv)} ms` : 'Open to analyse'),
        make('span', 'muted', [`${fmtClock(n.start)}–${fmtClock(n.start + n.durationS * 1000)}`, n.source === 'demo' ? 'demo' : '', n.ecgId ? 'with ECG' : '', n.cloudOnly ? 'synced copy' : ''].filter(Boolean).join(' · ')),
      );
      li.appendChild(deleteButton('this night', async () => { await deleteNight(n); void renderHistory(); }, 'Delete this night? You can get it back from the Recovery centre. It is also removed from your other devices.'));
      li.addEventListener('click', () => void openReport(n.id));
      list.appendChild(li);
    }
  }

  // ---------- report ----------

  const hypno = new Hypnogram(document.querySelector<HTMLElement>('#view-sleepReport .chart.hypno') ?? $('sleepBody'));
  const bars = new Bars(document.querySelector<HTMLElement>('#view-sleepReport .chart.bars') ?? $('sleepBody'));
  const [hrChartEl, brChartEl] = [...document.querySelectorAll<HTMLElement>('#view-sleepReport .grid2:not(.sleep-summary) .chart')];
  if (!hrChartEl || !brChartEl) throw new Error('sleep report needs two charts');
  const hrPlot = new Plot(hrChartEl);
  const brPlot = new Plot(brChartEl);
  let current: { session: SleepSession; analysis: SleepAnalysis } | null = null;
  let donutParts: { key: SleepStageKey; value: number }[] = [];

  const stageKey = (s: Stage): SleepStageKey | null => (s === 'nodata' ? null : s);

  async function openReport(id: string): Promise<void> {
    deps.showSleepView('sleepReport');
    const busy = $('sleepBusy'), body = $('sleepBody');
    busy.hidden = false;
    busy.textContent = 'Analysing the night…';
    body.hidden = true;
    await new Promise((r) => setTimeout(r, 30));
    const { session, signals } = await store.loadSleep(id);
    if (!session) { busy.textContent = 'Recording not found.'; return; }
    let analysis: SleepAnalysis;
    if (session.cloudOnly) {
      // a report copy synced from another device: shown as it was calculated there
      const report = parseSleepReport(session.report);
      if (!report) { busy.textContent = 'This synced night could not be read.'; return; }
      analysis = toAnalysis(report);
    } else {
      if (!signals) { busy.textContent = 'Recording not found.'; return; }
      const data: SleepData = { durationS: session.durationS, ...signals };
      analysis = analyzeSleep(data);
      const m = analysis.metrics;
      session.summary = { sleepMin: m.sleepMin, score: m.score, awakenings: m.awakenings, avgHR: m.avgHR, avgHrv: m.avgHrv, breathingRate: m.breathingRate };
      store.updateSleep(session).catch(() => {});
    }
    current = { session, analysis };
    const earlier = (await store.listSleeps(session.user)).filter((n) => n.start < session.start);
    renderReport(session, analysis, earlier);
    busy.hidden = true;
    body.hidden = false;
    hypno.draw(); bars.draw(); hrPlot.draw(); brPlot.draw();
    const ecgSection = $('sleepEcgSection');
    ecgSection.hidden = !session.ecgId;
    if (session.ecgId) void deps.renderNightEcg($('sleepEcgBody'), session.ecgId);
    drawDonut($canvas('sleepDonut'), donutParts); // needs the report to be visible to have a size
  }

  function renderReport(session: SleepSession, a: SleepAnalysis, earlier: readonly SleepSession[]): void {
    const m = a.metrics;
    const start = session.start;
    const night = new Date(start);
    $('sleepMeta').textContent = [
      deps.userLabel(session.user),
      `Night of ${night.toLocaleDateString([], { dateStyle: 'full' })}`,
      session.source === 'demo' ? 'Demo night' : 'Polar H10',
      session.cloudOnly ? 'Synced copy from another device (as calculated there)' : '',
      m.coverage < 95 ? `Data for ${fmt(m.coverage)} % of the night (strap dropped out)` : '',
    ].filter(Boolean).join(' · ');
    $('sleepDuration').textContent = m.sleepMin ? fmtHM(m.sleepMin) : 'No sleep detected';

    hypno.set(a.stages.map(stageKey), start, EPOCH_S);
    $('sleepBed').textContent = fmtClock(start);
    $('sleepOnset').textContent = Number.isFinite(m.onsetS) ? fmtClock(start + m.onsetS * 1000) : '--';
    $('sleepWake').textContent = Number.isFinite(m.wakeS) ? fmtClock(start + m.wakeS * 1000) : '--';
    const keys: SleepStageKey[] = ['deep', 'light', 'rem', 'awake'];
    $('sleepLegend').replaceChildren(...keys.map((k) => {
      const item = make('span');
      const sw = make('span', 'swatch');
      sw.style.background = `var(${STAGE_COLOR_VAR[k]})`;
      item.append(sw, STAGE_LABEL[k]);
      return item;
    }));

    // score
    $('sleepScore').textContent = m.sleepMin ? String(m.score) : '--';
    $('sleepScoreWord').textContent = !m.sleepMin ? '' : m.score >= 85 ? 'Very good night' : m.score >= 70 ? 'Good night' : m.score >= 55 ? 'Fair night' : 'Poor night';
    $('sleepScoreHow').textContent = SCORE_EXPLANATION;

    // times woke up, last 7 nights including this one
    const week = [...earlier.slice(0, 6).reverse(), session];
    const dayLabel = (ms: number): string => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'numeric' });
    bars.set(week.map((n) => {
      const v = n.id === session.id ? m.awakenings : n.summary?.awakenings ?? 0;
      return { label: dayLabel(n.start), value: v, title: `${dayLabel(n.start)} · <b>${v} time${v === 1 ? '' : 's'}</b>`, highlight: n.id === session.id };
    }));
    $('sleepBarsRange').textContent = week.length > 1 ? `(${dayLabel(week[0]?.start ?? start)}–${dayLabel(start)})` : '';

    // stage ring and list
    const parts = [
      { key: 'deep' as const, value: m.deepMin, pct: m.deepPct },
      { key: 'light' as const, value: m.lightMin, pct: m.lightPct },
      { key: 'rem' as const, value: m.remMin, pct: m.remPct },
    ];
    donutParts = parts;
    $('sleepStageList').replaceChildren(...[...parts, { key: 'awake' as const, value: m.awakeMin, pct: NaN }].map((p) => {
      const li = make('li');
      const name = make('span', 'dot-label');
      const sw = make('span', 'swatch');
      sw.style.background = `var(${STAGE_COLOR_VAR[p.key]})`;
      name.append(sw, p.key === 'awake' ? 'Awake after falling asleep' : STAGE_LABEL[p.key]);
      li.append(name, make('span', '', fmtHM(p.value)), make('span', 'pct', Number.isFinite(p.pct) ? `${fmt(p.pct)} %` : ''));
      return li;
    }));

    // tiles with reference and personal ranges
    const R = sleepRanges();
    const outliers: Outlier[] = [];
    const tile = (k: string, v: string, unit: string, hint: string, ref?: MetricRef | null): HTMLDivElement => metricTile(k, v, unit, hint, ref, outliers);
    const normal = (range: MetricRef & { range: unknown }): MetricRef => ({ ...range, okLabel: 'Normal' });
    const personal = (values: number[], value: number, unit: string): MetricRef => {
      const range = personalRange(values);
      if (!range) return { skipped: `Personal range after 3 nights (${Math.min(values.length, 3)}/3 so far)` };
      return { range, value, label: 'Personal range', rangeText: `${range.lo}–${range.hi} ${unit}`, okLabel: 'Within range' };
    };
    const prev = (f: (s: NonNullable<SleepSession['summary']>) => number): number[] => earlier.flatMap((n) => (n.summary ? [f(n.summary)] : []));
    $('sleepTiles').replaceChildren(
      tile('Night sleep', fmtHM(m.sleepMin), '', 'deep + light + REM', normal({ range: R.sleepHours, value: m.sleepMin / 60, rangeText: '7–9 h' })),
      tile('Times woke up', String(m.awakenings), 'times', '', normal({ range: R.awakenings, value: m.awakenings, rangeText: '0–2 times' })),
      tile('Deep sleep', fmt(m.deepPct), '%', fmtHM(m.deepMin), normal({ range: R.deepPct, value: m.deepPct })),
      tile('Light sleep', fmt(m.lightPct), '%', fmtHM(m.lightMin), normal({ range: R.lightPct, value: m.lightPct })),
      tile('REM sleep', fmt(m.remPct), '%', fmtHM(m.remMin), normal({ range: R.remPct, value: m.remPct })),
      tile('Avg heart rate', fmt(m.avgHR), 'bpm', `lowest ${fmt(m.minHR)} bpm`, personal(prev((s) => s.avgHR), m.avgHR, 'bpm')),
      tile('Avg HRV', fmt(m.avgHrv), 'ms', 'RMSSD while asleep', personal(prev((s) => s.avgHrv), m.avgHrv, 'ms')),
      tile('Breathing rate', fmt(m.breathingRate, 1), '/min', 'while asleep', normal({ range: R.breathing, value: m.breathingRate })),
      tile('Breathing regularity', fmt(m.breathingRegularity), 'points', 'steady breathing scores higher', normal({ range: R.regularity, value: m.breathingRegularity, rangeText: '70–100 points' })),
      tile('Deep sleep continuity', fmt(m.deepContinuity), 'points', 'deep sleep in spells of 10 min or more', normal({ range: R.continuity, value: m.deepContinuity, rangeText: '70–100 points' })),
      tile('Sleep efficiency', fmt(m.efficiency), '%', `of ${fmtHM(m.timeInBedMin)} in bed`, normal({ range: R.efficiency, value: m.efficiency })),
      tile('Time to fall asleep', fmt(m.latencyMin), 'min', '', normal({ range: R.latency, value: m.latencyMin })),
      tile('Awake after falling asleep', fmt(m.awakeMin), 'min', '', normal({ range: R.waso, value: m.awakeMin })),
      tile('Avg SpO₂', '--', '', 'not measured: the Polar H10 has no blood-oxygen sensor'),
    );
    renderOutliers($('sleepFlags'), outliers, ['Sleep stages are estimates; see “About these results” below.']);

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
  $button('btnSleepEcgStart').addEventListener('click', () => void (recorder ? stopRecording() : startRecording(true)));
  $button('btnSleepDim').addEventListener('click', () => { $('sleepDim').hidden = false; });
  $('sleepDim').addEventListener('click', () => { $('sleepDim').hidden = true; });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && recorder && !wakeLock) void requestWakeLock();
  });
  $button('btnSleepBack').addEventListener('click', () => deps.showSleepView('sleepHistory'));
  $button('btnSleepPrint').addEventListener('click', () => window.print());
  /** Deletes a night (after the caller asked); its ECG is deleted too only if the user says so. */
  async function deleteNight(night: SleepSession): Promise<void> {
    const ecgId = night.ecgId;
    if (ecgId && window.confirm('Also delete the ECG recorded during this night? (Cancel keeps it in ECG history.)')) await store.deleteSession(ecgId);
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
  }
  $button('btnSleepDelete').addEventListener('click', () => {
    void (async () => {
      if (!current || !window.confirm('Delete this night? You can get it back from the Recovery centre.')) return;
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
    const out = { app: 'OpenBeat ECG', sleep: { ...session }, metrics: analysis.metrics, ranges: sleepRanges(), epochS: EPOCH_S, stages: analysis.stages };
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
    isRecording: () => recorder !== null,
    refreshUser,
  };
}
