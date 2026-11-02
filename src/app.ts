import { PolarH10, ECG_FS, bluetoothAvailable, type EcgDetail, type HrDetail, type BatteryDetail } from './polar';
import { EcgSimulator, type Scenario } from './sim';
import { EcgFilter, analyze, hrvStats, sessionMetrics, EVENT_LABELS, type Analysis, type SessionMetrics } from './dsp';
import { Plot, LiveTrace, EcgViewer, fmtTime, type Point, type ReportEvent } from './charts';
import { writeEdf, readEdf } from './edf';
import * as store from './store';
import type { Session, Settings, UserEvent, UserNumber } from './store';
import { referenceRanges, SOURCES, type ReferenceRanges } from './ranges';
import { byId, $, $button, $input, $canvas, make, fmt, metricTile, renderOutliers as renderOutlierBox, download, type MetricRef, type Outlier } from './ui';
import { errorMessage, errorName } from './util';
import { initSleep } from './sleepui';

const FS = ECG_FS;

let outliers: Outlier[] = [];
const metric = (k: string, v: string, unit: string, hint = '', ref?: MetricRef | null): HTMLDivElement => metricTile(k, v, unit, hint, ref, outliers);

const RING_S = 60;
const SPLIT_S = 4 * 3600; // start a new file every 4 h

let currentUser: UserNumber = store.loadCurrentUser();
let settings: Settings = store.loadSettings(currentUser);

// ---------- Navigation ----------

type View = 'live' | 'history' | 'report' | 'sleep' | 'sleepHistory' | 'sleepReport' | 'settings';
const VIEWS: readonly View[] = ['live', 'history', 'report', 'sleep', 'sleepHistory', 'sleepReport', 'settings'];
const isView = (v: string | undefined): v is View => (VIEWS as readonly (string | undefined)[]).includes(v);
let sleepUI: ReturnType<typeof initSleep> | null = null;

function show(view: View): void {
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.id === `view-${view}`);
  const tab = view === 'report' ? 'history' : view === 'sleepReport' ? 'sleepHistory' : view;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button')) b.setAttribute('aria-selected', String(b.dataset['view'] === tab));
  if (view === 'history') void renderHistory();
  if (view === 'sleepHistory') void sleepUI?.renderHistory();
  if (view === 'sleep') sleepUI?.refreshUser();
  window.scrollTo(0, 0);
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
}

function btLog(line: string): void {
  const el = $('btLog');
  const t = new Date().toLocaleTimeString([], { hour12: false });
  el.textContent += `${t}  ${line}\n`;
  el.scrollTop = el.scrollHeight;
}

$button('btnConnect').addEventListener('click', () => void connectPolar());

async function connectPolar(): Promise<void> {
  if (sleepUI?.isConnected()) {
    setStatus('The strap is in use on Sleep monitor – disconnect it there first', '');
    return;
  }
  const polar = new PolarH10();
  polar.addEventListener('ecg', (e) => onSamples((e as CustomEvent<EcgDetail>).detail.samples));
  polar.addEventListener('hr', (e) => { deviceHR = (e as CustomEvent<HrDetail>).detail.hr; });
  polar.addEventListener('battery', (e) => {
    const lvl = (e as CustomEvent<BatteryDetail>).detail.level;
    $('battery').textContent = `Battery ${lvl}%${lvl < 50 ? ' – signal quality drops below 50 %' : ''}`;
  });
  polar.addEventListener('disconnect', () => {
    btLog('Sensor disconnected');
    if (source?.kind === 'polar') void stopSource('Sensor disconnected');
  });
  const log = $('btLog');
  log.textContent = '';
  log.hidden = false;
  setStatus('Connecting…', 'busy');
  try {
    const result = await polar.connect(btLog);
    if (result.ecg) {
      startSource('polar', () => polar.disconnect(), `${polar.name} – streaming ECG`);
    } else {
      startSource('polar', () => polar.disconnect(), `${polar.name} – heart rate only (ECG unavailable)`);
      $('statusDot').className = 'dot busy';
      $button('btnRecord').disabled = true; // recordings need the ECG stream
    }
  } catch (err) {
    const cancelled = errorName(err) === 'NotFoundError';
    btLog(cancelled ? 'No strap chosen (the list was closed or cancelled)' : `Error: ${errorName(err)}: ${errorMessage(err)}`);
    setStatus(cancelled ? 'No device selected' : `Connection failed: ${errorMessage(err)}`, '');
    void polar.disconnect();
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
$button('btnDisconnect').addEventListener('click', () => void stopSource());

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
    $('timer').textContent = fmtTime(elapsed);
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

async function startRecording(): Promise<void> {
  rec = { user: currentUser, start: Date.now(), startSample: total, chunks: [], n: 0, userEvents: [], detected: [] };
  syncUserSelect();
  const btn = $button('btnRecord');
  btn.textContent = 'Stop';
  btn.classList.add('recording');
  $button('btnEvent').disabled = false;
  $('liveEvents').textContent = '0';
  $('timer').textContent = '0:00';
  try { audio ??= new AudioContext(); } catch { /* ignore */ }
  await requestWakeLock();
}

async function stopRecording(): Promise<Session | null> {
  const r = rec;
  rec = null;
  const btn = $button('btnRecord');
  btn.textContent = 'Start';
  btn.classList.remove('recording');
  $button('btnEvent').disabled = true;
  try { await wakeLock?.release(); } catch { /* ignore */ }
  wakeLock = null;
  syncUserSelect();
  if (!r || r.n < 10 * FS) {
    $('timer').textContent = 'Too short to save (min 10 s)';
    return null;
  }
  const samples = new Int16Array(r.n);
  let o = 0;
  for (const c of r.chunks) { samples.set(c, o); o += c.length; }
  const session: Session = {
    id: `s${r.start}`,
    user: r.user,
    start: r.start,
    durationS: r.n / FS,
    fs: FS,
    alias: settings.alias,
    source: source?.kind ?? 'polar',
    userEvents: r.userEvents,
    summary: null,
  };
  await store.saveSession(session, samples);
  $('timer').textContent = `Saved ${fmtTime(session.durationS)}`;
  return session;
}

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

async function renderHistory(): Promise<void> {
  const list = $('sessionList');
  let sessions: Session[] = [];
  try { sessions = await store.listSessions(currentUser); } catch { /* storage blocked */ }
  $('historyUser').textContent = `· ${userLabel(currentUser)}`;
  list.replaceChildren();
  $('emptyHistory').hidden = sessions.length > 0;
  for (const s of sessions) {
    const sum = s.summary;
    const stats = sum
      ? `HR ${Math.round(sum.meanHR) || '--'} bpm · HRV ${Number.isFinite(sum.hrvScore) ? Math.round(sum.hrvScore) : '--'} · ${sum.eventCount} events`
      : 'Open to analyse';
    const li = make('li');
    li.append(
      make('span', 'when', new Date(s.start).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })),
      make('span', 'dur', fmtTime(s.durationS)),
      make('span', 'stats', stats),
      make('span', 'muted', [s.alias, s.source === 'demo' ? 'demo' : s.source === 'import' ? 'imported' : ''].filter(Boolean).join(' · ')),
    );
    li.addEventListener('click', () => void openReport(s.id));
    list.appendChild(li);
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
    await openReport(session.id);
  } catch (err) {
    window.alert(`Could not import ${file.name}: ${errorMessage(err)}`);
  }
}

// ---------- Report ----------

interface CurrentReport {
  session: Session;
  samples: Int16Array;
  analysis: Analysis;
  metrics: SessionMetrics;
  events: ReportEvent[];
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


async function openReport(id: string): Promise<void> {
  show('report');
  const busy = $('reportBusy'), body = $('reportBody');
  busy.hidden = false;
  body.hidden = true;
  await new Promise((r) => setTimeout(r, 30)); // let the busy state paint
  const { session, samples } = await store.loadSession(id);
  if (!session || !samples) { busy.textContent = 'Recording not found.'; return; }
  const analysis = analyze(samples, { fs: session.fs, notch: settings.notch, qtcFormula: settings.qtcFormula });
  const metrics = sessionMetrics(analysis, session.durationS, { hrRest: settings.hrRest, hrMax: settings.hrMax, sex: settings.sex });
  const events: ReportEvent[] = [
    ...analysis.events.map((e) => ({ t: e.t, type: e.type, label: EVENT_LABELS[e.type] })),
    ...session.userEvents.map((e): ReportEvent => ({ t: e.t, type: 'user', label: e.label || 'Marked' })),
  ].sort((a, b) => a.t - b.t);
  current = { session, samples, analysis, metrics, events };

  session.summary = { meanHR: metrics.meanHR, hrvScore: metrics.hrvScore, eventCount: analysis.events.length };
  store.updateSession(session).catch(() => {});

  renderReport(current);
  busy.hidden = true;
  body.hidden = false;
  charts.forEach((p) => p.draw());
  viewer.load(analysis, events);
  viewer.dispatchEvent(new Event('move'));
}

function renderReport({ session, analysis, metrics: m, events }: CurrentReport): void {
  $('reportTitle').textContent = new Date(session.start).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' });
  $('reportMeta').textContent = [
    userLabel(store.sessionUser(session)),
    store.biodataLine(settings),
    `Duration ${fmtTime(session.durationS)}`,
    `${m.beatCount} beats`,
    // the user label already shows the current alias; only mention one recorded under a different alias
    session.alias && !userLabel(store.sessionUser(session)).endsWith(`· ${session.alias}`) && `Alias ${session.alias}`,
    session.source === 'demo' ? 'Demo signal' : session.source === 'import' ? 'Imported EDF' : 'Polar H10',
    m.nnCount < 30 ? 'Short or noisy recording: HRV values are unreliable' : '',
  ].filter(Boolean).join(' · ');

  const qtcName = settings.qtcFormula === 'fridericia' ? 'Fridericia' : 'Bazett';
  const R = referenceRanges(settings);
  // resting norms don't apply when much of the recording was exercise (above 60 % of max HR)
  const [, , z2, z3, z4, z5] = m.zones;
  const timed = m.zones.reduce((a, b) => a + b, 0) || 1;
  const exercise = (z2 + z3 + z4 + z5) / timed > 0.3;
  const ref = (key: keyof ReferenceRanges, value: number | null | undefined): MetricRef => (exercise && R[key].rest
    ? { skipped: 'Resting range not applied (exercise)' }
    : { range: R[key], value });
  outliers = [];
  $('mRhythm').replaceChildren(
    metric('Mean heart rate', fmt(m.meanHR), 'bpm', 'from normal beats', ref('meanHR', m.meanHR)),
    metric('HRV score', fmt(m.hrvScore), '', '15 × ln(RMSSD)', ref('hrvScore', m.hrvScore)),
    metric('RMSSD', fmt(m.rmssd), 'ms', '', ref('rmssd', m.rmssd)),
    metric('SDNN', fmt(m.sdnn), 'ms', '', ref('sdnn', m.sdnn)),
    metric('pNN50', fmt(m.pnn50, 1), '%', 'successive Δ > 50 ms', ref('pnn50', m.pnn50)),
    metric('pNN200', fmt(m.pnn200, 1), '%', 'successive Δ > 200 ms', ref('pnn200', m.pnn200)),
    metric('Poincaré SD1 / SD2', `${fmt(m.sd1)} / ${fmt(m.sd2)}`, 'ms'),
    metric('Events', String(m.eventCount), '', `${fmt(m.eventPct, 1)} % of beats`, { range: { ...R.eventPct, note: 'of beats' }, value: m.eventPct, display: `${fmt(m.eventPct, 1)} % of beats` }),
  );
  $('mWaves').replaceChildren(
    metric('QRS duration', fmt(m.qrs), 'ms', 'median', ref('qrs', m.qrs)),
    metric('QT', fmt(m.qt), 'ms', 'median'),
    metric('QTc', fmt(m.qtc), 'ms', `${qtcName}, median`, ref('qtc', m.qtc)),
    metric('T wave positive', fmt(m.tPositive), '%', '', ref('tPositive', m.tPositive)),
    metric('T-wave amplitude', fmt(m.tAmp), 'µV', 'median, vs PR baseline', ref('tAmp', m.tAmp)),
    metric('T/R ratio', fmt(m.trRatio, 2), '', 'T size ÷ R size, median', ref('trRatio', m.trRatio)),
    metric('J point', fmt(m.jPoint), 'µV', 'vs PR baseline', ref('jPoint', m.jPoint)),
    metric('ST at J+60 ms', fmt(m.st60), 'µV', '', ref('st60', m.st60)),
    metric('R amplitude', fmt(m.rAmp), 'µV', 'no reference range'),
    metric('2–8 Hz energy', fmt(m.hf, 1), '%', 'can include noise; no reference range'),
  );
  const maxSeen = Math.max(0, ...m.hr.filter((v): v is number => v != null));
  const rec60 = m.recovery;
  $('mTraining').replaceChildren(
    metric('Effort (TRIMP)', fmt(m.trimp, 1), '', 'Banister, uses rest/max HR'),
    metric('HR recovery (60 s)', rec60 ? fmt(rec60.hrr60) : '--', 'bpm',
      rec60 ? `${fmt(rec60.peak)} → ${fmt(rec60.after60)} bpm` : 'needs ≥1 min above 90 % of max HR',
      rec60 ? ref('hrr60', rec60.hrr60) : null),
    metric('Highest HR', maxSeen ? fmt(maxSeen) : '--', 'bpm', `max HR setting ${settings.hrMax}`),
  );

  renderOutliers(exercise);
  renderZones(m.zones);
  renderCharts(analysis, m, maxSeen);
  renderEvents(events);
}

function renderOutliers(exercise: boolean): void {
  renderOutlierBox($('reportFlags'), outliers, exercise ? ['Exercise recording: resting ranges for heart rate and HRV are not applied.'] : []);
}

const ZONE_NAMES = ['Below 50 %', 'Z1 50–60 %', 'Z2 60–70 %', 'Z3 70–80 %', 'Z4 80–90 %', 'Z5 90–100 %'] as const;

function renderZones(zones: SessionMetrics['zones']): void {
  const totalZ = zones.reduce((a, b) => a + b, 0) || 1;
  $('zoneBars').replaceChildren(...zones.map((secs, i) => {
    const row = make('div', 'zone');
    const fill = make('span');
    fill.style.width = `${(100 * secs) / totalZ}%`;
    const bar = make('div', 'bar');
    bar.appendChild(fill);
    row.append(make('span', '', ZONE_NAMES[i] ?? ''), bar, make('span', 't', fmtTime(secs)));
    return row;
  }));
}

function renderCharts(analysis: Analysis, m: SessionMetrics, maxSeen: number): void {
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
    xLabel: 'ms from R peak', yLabel: 'µV', empty: 'Not enough clean beats',
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
    xLabel: 'RRₙ (ms)', yLabel: 'RRₙ₊₁ (ms)',
    tooltip: (p) => `RRₙ ${Math.round(p[0])} ms → <b>${Math.round(p[1])} ms</b>${p[2] ? ' · event' : ''}`,
  });

  // RR vs QTc
  const qpts = beats.flatMap((b): Point[] => (b.m?.qtc && b.rr ? [[b.rr, b.m.qtc]] : []));
  const qStride = Math.max(1, Math.ceil(qpts.length / 4000));
  qtcPlot?.set({
    type: 'scatter', points: qpts.filter((_, i) => i % qStride === 0),
    xLabel: 'RR (ms)', yLabel: 'QTc (ms)', empty: 'No measurable T waves',
    tooltip: (p) => `RR ${Math.round(p[0])} ms · <b>QTc ${Math.round(p[1])} ms</b>`,
  });
}

function renderEvents(events: readonly ReportEvent[]): void {
  $('eventCount').textContent = `(${events.length})`;
  const list = $('eventList');
  list.replaceChildren();
  for (const e of events.slice(0, 500)) {
    const li = make('li');
    li.append(make('span', '', fmtTime(e.t)), make('span', `badge ${e.type}`, e.label));
    li.addEventListener('click', () => {
      viewer.span = Math.min(viewer.span, 6);
      viewer.center(e.t);
      $canvas('viewerCanvas').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    list.appendChild(li);
  }
  if (events.length > 500) list.appendChild(make('li', 'muted', `…and ${events.length - 500} more (see the exports)`));
}

$button('btnBack').addEventListener('click', () => show('history'));
$button('btnPrint').addEventListener('click', () => window.print());
$button('btnDelete').addEventListener('click', () => {
  void (async () => {
    if (!current || !window.confirm('Delete this recording permanently?')) return;
    await store.deleteSession(current.session.id);
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
  download(writeEdf({ samples, fs: session.fs, start: session.start, alias: session.alias, sex: settings.sex, events }), `${fileStem(session)}.edf`);
});
$button('btnExportCsv').addEventListener('click', () => {
  if (!current) return;
  const rows: string[][] = [['time_s', 'rr_ms', 'hr_bpm', 'flags', 'qrs_ms', 'qt_ms', 'qtc_ms', 't_amp_uv', 'j_point_uv', 'st60_uv', 'r_amp_uv']];
  const r = (v: number | null | undefined, d = 1): string => (v == null || !Number.isFinite(v) ? '' : v.toFixed(d));
  for (const b of current.analysis.beats) {
    rows.push([r(b.t, 3), r(b.rr), b.rr ? r(60000 / b.rr) : '', b.flags.join('|'), r(b.m?.qrs), r(b.m?.qt), r(b.m?.qtc),
      r(b.m?.tAmp, 0), r(b.m?.jAmp, 0), r(b.m?.st60, 0), r(b.m?.rAmp, 0)]);
  }
  download(new Blob([rows.map((x) => x.join(',')).join('\n')], { type: 'text/csv' }), `${fileStem(current.session)}_beats.csv`);
});
$button('btnExportJson').addEventListener('click', () => {
  if (!current) return;
  const { session, metrics, events } = current;
  const { summary: _summary, ...sessionInfo } = session;
  const out = { app: 'OpenBeat ECG', session: sessionInfo, settings, metrics, referenceRanges: referenceRanges(settings), outliers, events };
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
    sleepUI?.refreshUser();
  });
}
renderUserOptions();

sleepUI = initSleep({
  user: () => currentUser,
  userLabel,
  showSleepView: show,
  ecgConnected: () => source?.kind === 'polar',
  recordingChanged: syncUserSelect,
});

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
