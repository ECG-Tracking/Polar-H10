import { PolarH10, ECG_FS, bluetoothAvailable } from './polar.js';
import { EcgSimulator } from './sim.js';
import { EcgFilter, analyze, hrvStats, sessionMetrics, EVENT_LABELS } from './dsp.js';
import { Plot, LiveTrace, EcgViewer, fmtTime } from './charts.js';
import { writeEdf, readEdf } from './edf.js';
import * as store from './store.js';
import { referenceRanges, checkRange, fmtRange, SOURCES } from './ranges.js';

const $ = (id) => document.getElementById(id);
const FS = ECG_FS;
const RING_S = 60;
const SPLIT_S = 4 * 3600; // start a new file every 4 h

let settings = store.loadSettings();

// ---------- Navigation ----------

function show(view) {
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.id === `view-${view}`);
  const tab = view === 'report' ? 'history' : view;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.view === tab));
  if (view === 'history') renderHistory();
  window.scrollTo(0, 0);
}
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => show(b.dataset.view));

// ---------- Live acquisition ----------

const trace = new LiveTrace($('liveCanvas'), FS);
let filter = new EcgFilter(FS, Number(settings.notch));
let source = null; // { kind, stop() }
let ring = new Float32Array(FS * RING_S);
let ringCount = 0;
let total = 0; // samples received since connect
let deviceHR = null;
let rec = null;
let tickTimer = null;
let drawing = false;

function setStatus(text, state) {
  $('statusText').textContent = text;
  $('statusDot').className = `dot ${state || ''}`;
}

function onSamples(samples) {
  const filtered = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    filtered[i] = filter.process(samples[i]);
    ring[(total + i) % ring.length] = samples[i];
  }
  total += samples.length;
  ringCount = Math.min(ring.length, ringCount + samples.length);
  trace.push(filtered);
  if (rec) {
    const c = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) c[i] = Math.max(-32768, Math.min(32767, samples[i]));
    rec.chunks.push(c);
    rec.n += c.length;
  }
}

function startSource(kind, stopFn, label) {
  source = { kind, stop: stopFn };
  filter = new EcgFilter(FS, Number(settings.notch));
  ringCount = 0;
  total = 0;
  deviceHR = null;
  trace.clear();
  setStatus(label, 'on');
  $('btnRecord').disabled = false;
  $('btnConnect').hidden = $('btnDemoRest').hidden = $('btnDemoWorkout').hidden = true;
  $('btnDisconnect').hidden = false;
  tickTimer = setInterval(tick, 1000);
  if (!drawing) {
    drawing = true;
    const loop = () => { if (!source) { drawing = false; return; } trace.draw(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
}

async function stopSource(reason) {
  if (rec) await stopRecording();
  clearInterval(tickTimer);
  const s = source;
  source = null;
  if (s) await s.stop();
  setStatus(reason || 'Not connected', '');
  $('battery').textContent = '';
  $('btnRecord').disabled = true;
  $('btnEvent').disabled = true;
  $('btnConnect').hidden = $('btnDemoRest').hidden = $('btnDemoWorkout').hidden = false;
  $('btnDisconnect').hidden = true;
  for (const id of ['liveHR', 'liveHRV', 'livePNN', 'liveZone']) $(id).textContent = '--';
}

$('btnConnect').addEventListener('click', async () => {
  const polar = new PolarH10();
  polar.addEventListener('ecg', (e) => onSamples(e.detail.samples));
  polar.addEventListener('hr', (e) => { deviceHR = e.detail.hr; });
  polar.addEventListener('battery', (e) => {
    const lvl = e.detail.level;
    $('battery').textContent = `Battery ${lvl}%${lvl < 50 ? ' – signal quality drops below 50 %' : ''}`;
  });
  polar.addEventListener('disconnect', () => {
    btLog('Sensor disconnected');
    if (source?.kind === 'polar') stopSource('Sensor disconnected');
  });
  $('btLog').textContent = '';
  $('btLog').hidden = false;
  setStatus('Connecting…', 'busy');
  try {
    const result = await polar.connect(btLog);
    if (result.ecg) {
      startSource('polar', () => polar.disconnect(), `${polar.name} – streaming ECG`);
    } else {
      startSource('polar', () => polar.disconnect(), `${polar.name} – heart rate only (ECG unavailable)`);
      $('statusDot').className = 'dot busy';
      $('btnRecord').disabled = true; // recordings need the ECG stream
    }
  } catch (err) {
    btLog(`Error: ${err.name}: ${err.message}`);
    setStatus(err.name === 'NotFoundError' ? 'No device selected' : `Connection failed: ${err.message}`, '');
    polar.disconnect();
  }
});

function btLog(line) {
  const el = $('btLog');
  const t = new Date().toLocaleTimeString([], { hour12: false });
  el.textContent += `${t}  ${line}\n`;
  el.scrollTop = el.scrollHeight;
}

function startDemo(scenario) {
  const sim = new EcgSimulator({ scenario, seed: Date.now() & 0xffff });
  sim.start(onSamples);
  startSource('demo', () => sim.stop(), `Demo signal (${scenario})`);
  $('battery').textContent = 'Simulated';
}
$('btnDemoRest').addEventListener('click', () => startDemo('rest'));
$('btnDemoWorkout').addEventListener('click', () => startDemo('workout'));
$('btnDisconnect').addEventListener('click', () => stopSource());

function ringWindow() {
  const n = ringCount;
  const out = new Float32Array(n);
  const start = total - n;
  for (let i = 0; i < n; i++) out[i] = ring[(start + i) % ring.length];
  return out;
}

function zoneOf(hr) {
  const pct = hr / settings.hrMax;
  if (pct < 0.5) return { z: '–', pct };
  return { z: `Z${Math.min(5, Math.floor((pct - 0.5) / 0.1) + 1)}`, pct };
}

function tick() {
  if (!source) return;
  if (rec) {
    const elapsed = rec.n / FS;
    $('timer').textContent = fmtTime(elapsed);
    if (elapsed >= SPLIT_S) { stopRecording().then(() => startRecording()); return; }
  }
  if (ringCount < 5 * FS) {
    if (deviceHR) $('liveHR').textContent = deviceHR;
    return;
  }
  const win = ringWindow();
  const a = analyze(win, { fs: FS, notch: Number(settings.notch), qtcFormula: settings.qtcFormula });
  const recent = a.beats.slice(-6).filter((b) => b.rr && !b.flags.length);
  const hr = recent.length >= 2 ? 60000 / (recent.reduce((s, b) => s + b.rr, 0) / recent.length) : deviceHR;
  if (hr) $('liveHR').textContent = Math.round(hr);
  const h = hrvStats(a.beats);
  if (h.nnCount >= 10) {
    $('liveHRV').textContent = Math.round(h.hrvScore);
    $('liveRMSSD').textContent = `RMSSD ${Math.round(h.rmssd)} ms`;
    $('livePNN').textContent = Math.round(h.pnn50);
  }
  if (hr) {
    const z = zoneOf(hr);
    $('liveZone').textContent = z.z;
    $('liveZonePct').textContent = `${Math.round(z.pct * 100)} % of max HR`;
  }

  if (rec) {
    // events from the sliding window, skipping its edges, de-duplicated by time
    const winStartS = (total - win.length) / FS - rec.startSample / FS;
    const winS = win.length / FS;
    for (const e of a.events) {
      if (e.t < 3 || e.t > winS - 0.6) continue;
      const t = winStartS + e.t;
      if (t < 0 || rec.detected.some((d) => Math.abs(d - t) < 0.3)) continue;
      rec.detected.push(t);
      if (settings.alertEvents) alert('event');
    }
    const beatsSoFar = Math.max(1, ((rec.n / FS) * (hr || 60)) / 60);
    const pct = (100 * rec.detected.length) / beatsSoFar;
    $('liveEvents').textContent = rec.detected.length;
    $('liveEventPct').textContent = `${pct.toFixed(1)} % of beats`;
    if (settings.alertZone && hr) {
      if (hr < settings.zoneMin) alert('low');
      else if (hr > settings.zoneMax) alert('high');
    }
    if (settings.alertPnn50 && h.nnCount >= 30 && h.pnn50 > 45) alert('pnn50');
  }
}

// ---------- Alerts ----------

let audio = null;
const lastAlert = {};
function beep(freq, ms, count = 1) {
  try {
    audio ||= new AudioContext();
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
function alert(kind) {
  const now = Date.now();
  if (now - (lastAlert[kind] || 0) < (kind === 'event' ? 2000 : 15000)) return;
  lastAlert[kind] = now;
  const pattern = { low: [880, 500, 1], high: [880, 500, 2], pnn50: [330, 150, 1], event: [330, 150, 1] }[kind];
  beep(...pattern);
  if (settings.vibrate && navigator.vibrate) navigator.vibrate(pattern[2] === 2 ? [300, 150, 300] : [200]);
}
$('btnTestAlert').addEventListener('click', () => { beep(880, 500, 2); setTimeout(() => beep(330, 150), 1500); });

// ---------- Recording ----------

let wakeLock = null;

async function startRecording() {
  rec = { start: Date.now(), startSample: total, chunks: [], n: 0, userEvents: [], detected: [] };
  $('btnRecord').textContent = 'Stop';
  $('btnRecord').classList.add('recording');
  $('btnEvent').disabled = false;
  $('liveEvents').textContent = '0';
  $('timer').textContent = '0:00';
  try { audio ||= new AudioContext(); } catch { /* ignore */ }
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ }
}

async function stopRecording() {
  const r = rec;
  rec = null;
  $('btnRecord').textContent = 'Start';
  $('btnRecord').classList.remove('recording');
  $('btnEvent').disabled = true;
  try { await wakeLock?.release(); } catch { /* ignore */ }
  wakeLock = null;
  if (!r || r.n < 10 * FS) {
    $('timer').textContent = 'Too short to save (min 10 s)';
    return null;
  }
  const samples = new Int16Array(r.n);
  let o = 0;
  for (const c of r.chunks) { samples.set(c, o); o += c.length; }
  const session = {
    id: `s${r.start}`,
    start: r.start,
    durationS: r.n / FS,
    fs: FS,
    alias: settings.alias,
    source: source?.kind || 'polar',
    userEvents: r.userEvents,
    summary: null,
  };
  await store.saveSession(session, samples);
  $('timer').textContent = `Saved ${fmtTime(session.durationS)}`;
  return session;
}

$('btnRecord').addEventListener('click', async () => {
  if (rec) {
    const s = await stopRecording();
    if (s) openReport(s.id);
  } else {
    startRecording();
  }
});
$('btnEvent').addEventListener('click', () => {
  if (!rec) return;
  rec.userEvents.push({ t: rec.n / FS, label: 'Marked' });
  beep(660, 80);
});

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && rec && !wakeLock) {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* ignore */ }
  }
});

// ---------- History ----------

async function renderHistory() {
  const list = $('sessionList');
  let sessions = [];
  try { sessions = await store.listSessions(); } catch { /* storage blocked */ }
  list.replaceChildren();
  $('emptyHistory').hidden = sessions.length > 0;
  for (const s of sessions) {
    const li = document.createElement('li');
    const d = new Date(s.start);
    const sum = s.summary;
    const stats = sum
      ? `HR ${Math.round(sum.meanHR) || '--'} bpm · HRV ${Number.isFinite(sum.hrvScore) ? Math.round(sum.hrvScore) : '--'} · ${sum.eventCount} events`
      : 'Open to analyse';
    li.innerHTML = `<span class="when"></span><span class="dur"></span><span class="stats"></span><span class="muted"></span>`;
    li.children[0].textContent = d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    li.children[1].textContent = fmtTime(s.durationS);
    li.children[2].textContent = stats;
    li.children[3].textContent = [s.alias, s.source === 'demo' ? 'demo' : s.source === 'import' ? 'imported' : ''].filter(Boolean).join(' · ');
    li.addEventListener('click', () => openReport(s.id));
    list.appendChild(li);
  }
}

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const edf = readEdf(await file.arrayBuffer());
    const samples = new Int16Array(edf.samples.length);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.max(-32768, Math.min(32767, Math.round(edf.samples[i])));
    const session = {
      id: `s${Date.now()}`,
      start: edf.start,
      durationS: samples.length / edf.fs,
      fs: edf.fs,
      alias: edf.alias,
      source: 'import',
      // only user marks; detected events are recomputed
      userEvents: edf.events.filter((ev) => !Object.values(EVENT_LABELS).slice(0, 3).includes(ev.label)),
      summary: null,
    };
    await store.saveSession(session, samples);
    openReport(session.id);
  } catch (err) {
    window.alert(`Could not import ${file.name}: ${err.message}`);
  }
});

// ---------- Report ----------

const plots = [...document.querySelectorAll('#view-report .chart')].map((f) => new Plot(f));
const viewer = new EcgViewer($('viewerCanvas'));
let current = null; // { session, samples, analysis, metrics, events }

viewer.addEventListener('move', () => {
  if (!viewer.duration) return;
  const span = Math.max(0.001, viewer.duration - viewer.span);
  $('viewerPos').value = Math.round((viewer.t0 / span) * 1000);
  $('viewerTime').textContent = `${fmtTime(viewer.t0)} / ${fmtTime(viewer.duration)}`;
});
$('viewerPos').addEventListener('input', (e) => viewer.goTo((e.target.value / 1000) * (viewer.duration - viewer.span)));
$('zoomIn').addEventListener('click', () => viewer.zoom(1 / 1.5));
$('zoomOut').addEventListener('click', () => viewer.zoom(1.5));

const fmt = (v, d = 0) => (v == null || !Number.isFinite(v) ? '--' : v.toFixed(d));
let outliers = [];

/** ref: { range, value } from referenceRanges(); a value outside it is flagged and listed in the summary. */
function metric(k, v, unit, hint, ref) {
  const el = document.createElement('div');
  el.className = 'metric';
  el.innerHTML = '<div class="k"></div><div class="v"></div><div class="h"></div>';
  el.children[0].textContent = k;
  el.children[1].textContent = v;
  if (unit && v !== '--') { const s = document.createElement('small'); s.textContent = unit; el.children[1].appendChild(s); }
  el.children[2].textContent = hint || '';
  if (ref?.range) {
    const r = document.createElement('div');
    r.className = 'ref';
    const refUnit = ref.display ? '%' : unit.trim();
    r.textContent = `Ref ${fmtRange(ref.range)}${refUnit ? ` ${refUnit}` : ''}${ref.range.note ? ` · ${ref.range.note}` : ''}`;
    el.appendChild(r);
    const status = checkRange(ref.range, ref.value);
    if (status) {
      el.classList.add('out');
      const f = document.createElement('div');
      f.className = 'flag';
      f.textContent = status === 'high' ? '▲ Above range' : '▼ Below range';
      el.appendChild(f);
      outliers.push({ name: k, value: ref.display || `${v}${unit ? ` ${unit.trim()}` : ''}`, range: fmtRange(ref.range), status });
    }
  } else if (ref?.skipped) {
    const r = document.createElement('div');
    r.className = 'ref';
    r.textContent = ref.skipped;
    el.appendChild(r);
  }
  return el;
}

async function openReport(id) {
  show('report');
  $('reportBusy').hidden = false;
  $('reportBody').hidden = true;
  await new Promise((r) => setTimeout(r, 30)); // let the busy state paint
  const { session, samples } = await store.loadSession(id);
  if (!session || !samples) { $('reportBusy').textContent = 'Recording not found.'; return; }
  const analysis = analyze(samples, { fs: session.fs, notch: Number(settings.notch), qtcFormula: settings.qtcFormula });
  const profile = { hrRest: settings.hrRest, hrMax: settings.hrMax, sex: settings.sex };
  const metrics = sessionMetrics(analysis, session.durationS, profile);
  const events = [
    ...analysis.events.map((e) => ({ ...e, label: EVENT_LABELS[e.type] })),
    ...(session.userEvents || []).map((e) => ({ t: e.t, type: 'user', label: e.label || 'Marked' })),
  ].sort((a, b) => a.t - b.t);
  current = { session, samples, analysis, metrics, events };

  session.summary = { meanHR: metrics.meanHR, hrvScore: metrics.hrvScore, eventCount: analysis.events.length };
  store.updateSession(session).catch(() => {});

  renderReport();
  $('reportBusy').hidden = true;
  $('reportBody').hidden = false;
  plots.forEach((p) => p.draw());
  viewer.load(analysis, events);
  viewer.dispatchEvent(new Event('move'));
}

function renderReport() {
  const { session, analysis, metrics: m, events } = current;
  const d = new Date(session.start);
  $('reportTitle').textContent = d.toLocaleString([], { dateStyle: 'full', timeStyle: 'short' });
  $('reportMeta').textContent = [
    `Duration ${fmtTime(session.durationS)}`,
    `${m.beatCount} beats`,
    session.alias && `Alias ${session.alias}`,
    session.source === 'demo' ? 'Demo signal' : session.source === 'import' ? 'Imported EDF' : 'Polar H10',
    m.nnCount < 30 ? 'Short or noisy recording: HRV values are unreliable' : '',
  ].filter(Boolean).join(' · ');

  const qtcName = settings.qtcFormula === 'fridericia' ? 'Fridericia' : 'Bazett';
  const R = referenceRanges(settings);
  // resting norms don't apply when much of the recording was exercise (above 60 % of max HR)
  const timed = m.zones.reduce((a, b) => a + b, 0) || 1;
  const exercise = (m.zones[2] + m.zones[3] + m.zones[4] + m.zones[5]) / timed > 0.3;
  const ref = (key, value) => (exercise && R[key].rest
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
    metric('J point', fmt(m.jPoint), 'µV', 'vs PR baseline', ref('jPoint', m.jPoint)),
    metric('ST at J+60 ms', fmt(m.st60), 'µV', '', ref('st60', m.st60)),
    metric('R amplitude', fmt(m.rAmp), 'µV', 'no reference range'),
    metric('2–8 Hz energy', fmt(m.hf, 1), '%', 'can include noise; no reference range'),
  );
  const maxSeen = Math.max(0, ...m.hr.filter((v) => v != null));
  $('mTraining').replaceChildren(
    metric('Effort (TRIMP)', fmt(m.trimp, 1), '', 'Banister, uses rest/max HR'),
    metric('HR recovery (60 s)', m.recovery ? fmt(m.recovery.hrr60) : '--', 'bpm',
      m.recovery ? `${fmt(m.recovery.peak)} → ${fmt(m.recovery.after60)} bpm` : 'needs ≥1 min above 90 % of max HR',
      m.recovery ? ref('hrr60', m.recovery.hrr60) : null),
    metric('Highest HR', maxSeen ? fmt(maxSeen) : '--', 'bpm', `max HR setting ${settings.hrMax}`),
  );

  // outliers summary at the top of the report
  const box = $('reportFlags');
  box.replaceChildren();
  box.className = `flags ${outliers.length ? 'has' : 'none'}`;
  const head = document.createElement('div');
  head.className = 'flags-head';
  head.textContent = outliers.length
    ? `${outliers.length} value${outliers.length > 1 ? 's' : ''} outside the reference range`
    : '✓ All values within reference ranges';
  box.appendChild(head);
  for (const o of outliers) {
    const row = document.createElement('div');
    row.className = 'flags-row';
    row.innerHTML = '<span></span><span></span><span></span>';
    row.children[0].textContent = `${o.status === 'high' ? '▲' : '▼'} ${o.name}`;
    row.children[1].textContent = o.value;
    row.children[2].textContent = `ref ${o.range}`;
    box.appendChild(row);
  }
  if (exercise) {
    const n = document.createElement('div');
    n.className = 'flags-note';
    n.textContent = 'Exercise recording: resting ranges for heart rate and HRV are not applied.';
    box.appendChild(n);
  }

  const zoneNames = ['Below 50 %', 'Z1 50–60 %', 'Z2 60–70 %', 'Z3 70–80 %', 'Z4 80–90 %', 'Z5 90–100 %'];
  const totalZ = m.zones.reduce((a, b) => a + b, 0) || 1;
  $('zoneBars').replaceChildren(...m.zones.map((secs, i) => {
    const row = document.createElement('div');
    row.className = 'zone';
    row.innerHTML = '<span></span><div class="bar"><span></span></div><span class="t"></span>';
    row.children[0].textContent = zoneNames[i];
    row.children[1].firstChild.style.width = `${(100 * secs) / totalZ}%`;
    row.children[2].textContent = fmtTime(secs);
    return row;
  }));

  // heart rate over time
  const stride = Math.max(1, Math.ceil(m.hr.length / 1500));
  const hrPts = [];
  for (let i = 0; i < m.hr.length; i += stride) hrPts.push([i + 1, m.hr[i] == null ? null : m.hr[i]]);
  plots[0].set({
    type: 'line', points: hrPts, xFmt: fmtTime, yLabel: 'bpm', xLabel: 'time',
    refLines: maxSeen >= 0.85 * settings.hrMax ? [{ y: 0.9 * settings.hrMax, label: '90 % max' }] : [],
    tooltip: (p) => `${fmtTime(p[0])} · <b>${Math.round(p[1])} bpm</b>`,
  });

  // median beat
  const fs = analysis.fs;
  const tm = analysis.templateMeasure;
  const pre = Math.round(analysis.templatePre * fs);
  const toMs = (i) => ((i - pre) / fs) * 1000;
  plots[1].set({
    type: 'line',
    points: analysis.template ? Array.from(analysis.template, (v, i) => [toMs(i), v]) : [],
    xLabel: 'ms from R peak', yLabel: 'µV', empty: 'Not enough clean beats',
    vLines: tm ? [
      { x: toMs(tm.onset), label: 'Q', row: 0 },
      { x: toMs(tm.offset), label: 'J', row: 1 },
      ...(tm.tEnd != null ? [{ x: toMs(tm.tEnd), label: 'T end', row: 0 }] : []),
    ] : [],
    tooltip: (p) => `${Math.round(p[0])} ms · <b>${Math.round(p[1])} µV</b>`,
  });

  // Poincaré
  const b = analysis.beats;
  const poin = [];
  for (let k = 2; k < b.length; k++) {
    if (!b[k].rr || !b[k - 1].rr) continue;
    poin.push([b[k - 1].rr, b[k].rr, b[k].flags.length || b[k - 1].flags.length]);
  }
  const pStride = Math.max(1, Math.ceil(poin.length / 4000));
  plots[2].set({
    type: 'scatter', identity: true, points: poin.filter((_, i) => i % pStride === 0),
    xLabel: 'RRₙ (ms)', yLabel: 'RRₙ₊₁ (ms)',
    tooltip: (p) => `RRₙ ${Math.round(p[0])} ms → <b>${Math.round(p[1])} ms</b>${p[2] ? ' · event' : ''}`,
  });

  // RR vs QTc
  const qpts = b.filter((x) => x.m?.qtc && x.rr).map((x) => [x.rr, x.m.qtc]);
  const qStride = Math.max(1, Math.ceil(qpts.length / 4000));
  plots[3].set({
    type: 'scatter', points: qpts.filter((_, i) => i % qStride === 0),
    xLabel: 'RR (ms)', yLabel: 'QTc (ms)', empty: 'No measurable T waves',
    tooltip: (p) => `RR ${Math.round(p[0])} ms · <b>QTc ${Math.round(p[1])} ms</b>`,
  });

  // events
  $('eventCount').textContent = `(${events.length})`;
  const list = $('eventList');
  list.replaceChildren();
  for (const e of events.slice(0, 500)) {
    const li = document.createElement('li');
    li.innerHTML = '<span></span><span class="badge"></span>';
    li.children[0].textContent = fmtTime(e.t);
    li.children[1].textContent = e.label;
    li.children[1].classList.add(e.type);
    li.addEventListener('click', () => {
      viewer.span = Math.min(viewer.span, 6);
      viewer.center(e.t);
      $('viewerCanvas').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    list.appendChild(li);
  }
  if (events.length > 500) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = `…and ${events.length - 500} more (see the exports)`;
    list.appendChild(li);
  }
}

$('btnBack').addEventListener('click', () => show('history'));
$('btnPrint').addEventListener('click', () => window.print());
$('btnDelete').addEventListener('click', async () => {
  if (!current || !window.confirm('Delete this recording permanently?')) return;
  await store.deleteSession(current.session.id);
  current = null;
  show('history');
});

function fileStem() {
  const d = new Date(current.session.start);
  const p = (v) => String(v).padStart(2, '0');
  return `ecg_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

$('btnExportEdf').addEventListener('click', () => {
  const { session, samples, events } = current;
  download(writeEdf({ samples, fs: session.fs, start: session.start, alias: session.alias, events }), `${fileStem()}.edf`);
});
$('btnExportCsv').addEventListener('click', () => {
  const rows = [['time_s', 'rr_ms', 'hr_bpm', 'flags', 'qrs_ms', 'qt_ms', 'qtc_ms', 't_amp_uv', 'j_point_uv', 'st60_uv', 'r_amp_uv']];
  const r = (v, d = 1) => (v == null || !Number.isFinite(v) ? '' : v.toFixed(d));
  for (const b of current.analysis.beats) {
    rows.push([r(b.t, 3), r(b.rr), b.rr ? r(60000 / b.rr) : '', b.flags.join('|'), r(b.m?.qrs), r(b.m?.qt), r(b.m?.qtc),
      r(b.m?.tAmp, 0), r(b.m?.jAmp, 0), r(b.m?.st60, 0), r(b.m?.rAmp, 0)]);
  }
  download(new Blob([rows.map((x) => x.join(',')).join('\n')], { type: 'text/csv' }), `${fileStem()}_beats.csv`);
});
$('btnExportJson').addEventListener('click', () => {
  const { session, metrics, events } = current;
  const out = { app: 'OpenBeat ECG', session: { ...session, summary: undefined }, settings, metrics, referenceRanges: referenceRanges(settings), outliers, events };
  download(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }), `${fileStem()}_report.json`);
});

// ---------- Settings ----------

const form = $('settingsForm');
function fillSettings() {
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') el.checked = !!settings[el.name];
    else el.value = settings[el.name];
  }
}
form.addEventListener('change', (e) => {
  const el = e.target;
  if (!el.name) return;
  let v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
  if (el.name === 'notch') v = Number(v);
  if (el.name === 'alias') v = String(v).replace(/[^\w\-. ]/g, '').slice(0, 40);
  settings[el.name] = v;
  if (el.name === 'age' && v > 0) settings.hrMax = Math.round(220 - v);
  store.saveSettings(settings);
  fillSettings();
});
fillSettings();

// ---------- Reference sources ----------

$('refSources').replaceChildren(...SOURCES.map(([what, text]) => {
  const li = document.createElement('li');
  const b = document.createElement('b');
  b.textContent = `${what}: `;
  li.append(b, text);
  return li;
}));

// ---------- Startup ----------

$('copyYear').textContent = String(Math.max(2026, new Date().getFullYear()));

if (!bluetoothAvailable() || !window.isSecureContext) {
  $('btnConnect').disabled = true;
  const note = $('btNote');
  note.hidden = false;
  note.textContent = !window.isSecureContext
    ? 'Bluetooth needs a secure page (https:// or localhost). Demo modes still work.'
    : 'This browser has no Web Bluetooth. Use Chrome or Edge on desktop/Android, or the Bluefy browser on iPhone/iPad. Demo modes still work.';
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
