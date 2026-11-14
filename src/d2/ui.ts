// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — the screen: pair with the watch, download sleep (or all its data), and a night report in the style of the watch's phone app.
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

import { CloudSetupError, syncNights, syncRecords, type CloudClient } from './cloud';
import { renderAllData } from './dataui';
import { renderGraphs, RANGES, type Range } from './graphsui';
import { dateInput, downloadPeriod } from './period';
import { downloadActivity, downloadReadings, downloadTotals, downloadWorkouts, parseEcgFile, parseStressFile, READING_CLASSES, type EcgRecording } from './extra';
import { D2Link, WatchError } from './link';
import { serialAvailable } from './serial';
import { connectWatch, disconnectWatch, ensureSetUp, logTo, onWatch, openedWatch, watchName } from './watch';
import { parseSleepFile, type D2Summary } from './sleepfile';
import { writeSleepFile } from './sleepfile-writer';
import { dateTime, button, clock, dayLabel, deleteButton, el, frontDeletes, hm, shortDate, svg } from './dom';
import { dayKey, figures, isNap } from './night';
import { CEILING_H, MIN_NIGHTS_TO_FIT, explainScore, fitScoreModel, type ScoreModel } from './score';
import type { Profile } from './setup';
import { activityRecords, readingRecords, stressRecords, totalsRecord, workoutRecords, nightContent, nilText, onlyChanged, recordContent } from './records';
import * as store from './store';
import { accountBox } from './accountbox';
import type { D2Night } from './store';
import { addDays, dateOf } from './trends';
import { renderTrends, type Period } from './trendsui';

export interface D2Deps {
  /** Signed-in account id: nights and the pairing are kept per account. */
  account: string;
  user: () => number;
  userLabel: () => string;
  /** The signed-in account's cloud client, or null when offline: nights then stay on this device until the next sync. */
  cloud: CloudClient | null;
  /** The user's biodata, sent to the watch as its profile before downloading all data (null if height or weight is missing). */
  profile?: () => Profile | null;
  /** Where the downloaded data goes ("D2 Link History"); without it, it is shown below the connection. */
  historyRoot?: HTMLElement;
  /** Shows the history page (after a download, or to open a night). */
  showHistory?: () => void;
  /** An ECG saved during this time, if there is one, and how to open it. */
  ecgDuring?: (from: number, to: number) => Promise<{ id: string; label: string } | null>;
  /** The list of nights was read again: something may have been downloaded, synced or deleted. */
  sleepChanged?: () => void;
  openEcg?: (id: string) => void;
  /** Saves the watch's 30-second ECGs in ECG history; without it, Download all data leaves them on the watch. */
  saveEcgs?: (recordings: readonly EcgRecording[]) => Promise<{ saved: number; same: number; short: number }>;
}

// ---------- what a night shows ----------

export const STAGE_NAME: Readonly<Record<number, string>> = { 1: 'Light sleep', 2: 'REM sleep', 3: 'Deep sleep', 4: 'Awake', 5: 'Nap' };
const STAGE_VAR: Readonly<Record<number, string>> = { 1: 'var(--stage-light)', 2: 'var(--stage-rem)', 3: 'var(--stage-deep)', 4: 'var(--stage-awake)', 5: 'var(--stage-light)' };
const STAGE_ROW: Readonly<Record<number, number>> = { 4: 0, 2: 1, 1: 2, 5: 2, 3: 3 }; // awake on top, deep at the bottom

type Verdict = { text: string; kind: 'normal' | 'high' | 'low' | 'personal' } | null;

/** The phone app's references: fixed ranges show Normal/High/Low, personal ranges show Within/Above/Below range. */
function fixed(v: number | null, lo: number, hi: number): Verdict {
  if (v == null || !Number.isFinite(v)) return null;
  if (v < lo) return { text: 'Low', kind: 'low' };
  if (v > hi) return { text: 'High', kind: 'high' };
  return { text: 'Normal', kind: 'normal' };
}
function personal(v: number | null, lo: number | null, hi: number | null): Verdict {
  if (v == null || lo == null || hi == null || lo <= 0 || hi < lo) return null;
  return { text: v < lo ? 'Below range' : v > hi ? 'Above range' : 'Within range', kind: 'personal' };
}

/** Night sleep: the phone app says "Below average" rather than "Low". */
function nightVerdict(hours: number): Verdict {
  const v = fixed(hours, 6, 10);
  return v?.kind === 'low' ? { text: 'Below average', kind: 'low' } : v;
}

interface TileSpec { name: string; value: string; unit: string; verdict: Verdict; ref: string }

export function tiles(n: D2Night): TileSpec[] {
  const s: D2Summary = n.summary, f = figures(n);
  const pct = (m: number): number | null => (f.sleepMin > 0 ? Math.round((100 * m) / f.sleepMin) : null);
  const show = (v: number | null): string => (v == null ? '--' : String(v));
  const pr = (lo: number | null, hi: number | null, unit: string): string => (lo != null && hi != null && lo > 0 ? `Personal range: ${lo}–${hi}${unit}` : 'Personal range: not set yet');
  // deep, light and REM add up to 100%, as on the watch's phone app (REM takes what rounding leaves)
  const light = pct(f.lightMin), deep = pct(f.deepMin), rem = light != null && deep != null ? 100 - light - deep : null;
  return [
    { name: 'Times woke up', value: show(f.wakeups), unit: 'times', verdict: fixed(f.wakeups, 0, 1), ref: s.wakeCount == null && f.wakeups != null ? 'References: 0–1 times · counted from the stages' : 'References: 0–1 times' },
    { name: 'Light sleep', value: show(light), unit: '%', verdict: light == null ? null : light < 55 ? { text: 'Normal', kind: 'normal' } : { text: 'High', kind: 'high' }, ref: 'Reference: <55%' },
    { name: 'Avg heart rate', value: show(s.avgHeartRate), unit: 'bpm', verdict: personal(s.avgHeartRate, s.minHeartRateBaseline, s.maxHeartRateBaseline), ref: pr(s.minHeartRateBaseline, s.maxHeartRateBaseline, ' bpm') },
    { name: 'Night sleep', value: f.sleepMin ? hm(f.sleepMin).replace(' min', '') : '--', unit: 'min', verdict: f.sleepMin ? nightVerdict(f.sleepMin / 60) : null, ref: 'References: 6–10 h' },
    { name: 'Deep sleep', value: show(deep), unit: '%', verdict: fixed(deep, 20, 60), ref: 'References: 20–60%' },
    { name: 'REM sleep', value: show(rem), unit: '%', verdict: fixed(rem, 10, 30), ref: 'References: 10–30%' },
    { name: 'Deep sleep continuity', value: show(s.deepPart), unit: 'points', verdict: fixed(s.deepPart, 70, 100), ref: 'References: 70–100 points' },
    { name: 'Breathing quality', value: '--', unit: 'points', verdict: null, ref: 'Not sent by the watch with the sleep record' },
    { name: 'Avg HRV', value: show(s.avgHrv), unit: 'ms', verdict: personal(s.avgHrv, s.minHrvBaseline, s.maxHrvBaseline), ref: pr(s.minHrvBaseline, s.maxHrvBaseline, ' ms') },
    { name: 'Avg SpO₂', value: show(s.avgOxygenSaturation), unit: '%', verdict: personal(s.avgOxygenSaturation, s.minOxygenSaturationBaseline, s.maxOxygenSaturationBaseline), ref: pr(s.minOxygenSaturationBaseline, s.maxOxygenSaturationBaseline, '%') },
    { name: 'Avg respiratory rate', value: show(s.avgBreathRate), unit: 'brpm', verdict: personal(s.avgBreathRate, s.minBreathRateBaseline, s.maxBreathRateBaseline), ref: pr(s.minBreathRateBaseline, s.maxBreathRateBaseline, '') },
  ];
}

// ---------- charts (SVG) ----------

function hypnogram(n: { start: number; stages: number[] }): SVGSVGElement {
  const W = 600, rowH = 34, gap = 10, top = 6, H = top + 4 * (rowH + gap);
  const total = Math.max(1, n.stages.length);
  const x = (m: number): number => (m / total) * W;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'd2-hypno', role: 'img', 'aria-label': 'Sleep stages through the night' });
  for (let r = 0; r < 4; r++) root.appendChild(svg('line', { x1: 0, x2: W, y1: top + r * (rowH + gap) + rowH / 2, y2: top + r * (rowH + gap) + rowH / 2, class: 'd2-row' }));
  let i = 0, prevRow: number | null = null, prevX = 0;
  while (i < n.stages.length) {
    const code = n.stages[i] ?? 0;
    let j = i;
    while (j < n.stages.length && n.stages[j] === code) j++;
    const row = STAGE_ROW[code];
    if (row != null) {
      const y = top + row * (rowH + gap);
      if (prevRow != null && prevRow !== row) { // the step between stages
        const y0 = top + prevRow * (rowH + gap) + rowH / 2, y1 = y + rowH / 2;
        root.appendChild(svg('line', { x1: prevX, x2: prevX, y1: y0, y2: y1, class: 'd2-step' }));
      }
      const from = n.start + i * 60000, to = n.start + j * 60000;
      root.appendChild(svg('rect', { x: x(i), y, width: Math.max(1.5, x(j) - x(i)), height: rowH, rx: 4, fill: STAGE_VAR[code] ?? 'var(--muted)' },
        `${STAGE_NAME[code] ?? 'Unknown'} ${clock(from)}–${clock(to)} (${j - i} min)`));
      prevRow = row;
      prevX = x(j);
    }
    i = j;
  }
  return root;
}

function donut(parts: { min: number; color: string; name: string }[]): SVGSVGElement {
  const R = 44, C = 2 * Math.PI * R, total = parts.reduce((s, p) => s + p.min, 0) || 1;
  const root = svg('svg', { viewBox: '0 0 120 120', class: 'd2-donut', role: 'img', 'aria-label': 'Share of deep, light and REM sleep' });
  root.appendChild(svg('circle', { cx: 60, cy: 60, r: R, class: 'd2-donut-track' }));
  let at = 0;
  for (const p of parts) {
    if (p.min <= 0) continue;
    const len = (p.min / total) * C;
    root.appendChild(svg('circle', {
      cx: 60, cy: 60, r: R, fill: 'none', stroke: p.color, 'stroke-width': 14,
      'stroke-dasharray': `${Math.max(0, len - 2)} ${C}`, 'stroke-dashoffset': -at, transform: 'rotate(-90 60 60)',
    }, `${p.name}: ${hm(p.min)} (${Math.round((100 * p.min) / total)}%)`));
    at += len;
  }
  return root;
}

function wakeBars(nights: D2Night[]): SVGSVGElement {
  const W = 210, H = 70, n = nights.length, bw = 12;
  const max = Math.max(3, ...nights.map((x) => figures(x).wakeups ?? 0));
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'd2-bars', role: 'img', 'aria-label': 'Times woke up, recent nights' });
  root.appendChild(svg('line', { x1: 0, x2: W, y1: H - 2, y2: H - 2, class: 'd2-row' }));
  nights.forEach((night, k) => {
    const v = figures(night).wakeups;
    const cx = n === 1 ? W / 2 : 8 + (k * (W - 16)) / (n - 1);
    const h = v == null ? 0 : Math.max(4, ((H - 10) * v) / max);
    root.appendChild(svg('rect', { x: cx - bw / 2, y: H - 2 - h, width: bw, height: h, rx: 4, class: v != null && v > 1 ? 'd2-bar-high' : 'd2-bar-ok' },
      `${dayLabel(figures(night).wokeMs)}: ${v ?? '--'} times`));
  });
  return root;
}

// ---------- the screen ----------

export function mount(root: HTMLElement, deps: D2Deps): { refresh: () => void; openNight: (id: string, back: () => void, copy?: unknown) => Promise<void> } {
  store.useAccount(deps.account);
  root.replaceChildren();
  // two pages: D2 Link (connect and download) and D2 Link History (the nights and other data, and a night's report)
  const home = el('div', 'd2-home');
  root.append(home);
  const histRoot = deps.historyRoot ?? root;
  if (deps.historyRoot) histRoot.replaceChildren();
  const histHome = el('div', 'd2-home'), report = el('div', 'd2-report');
  report.hidden = true;
  histRoot.append(histHome, report);
  const toHistory = (): void => deps.showHistory?.();

  // header and connection card
  const title = el('h2', '', 'D2 Link ');
  const userTag = el('span', 'muted');
  title.appendChild(userTag);
  const card = el('div', 'card');
  const status = el('div', 'status');
  const dot = el('span', 'dot'), statusText = el('span', '', 'Not connected');
  status.append(dot, statusText);
  const noSerial = el('p', 'd2-warn', 'This browser can’t reach the watch. Use Chrome on an Android phone or on a computer; Safari, Firefox and iPhones can’t connect to a Watch D2.');
  noSerial.hidden = serialAvailable();
  const btnGo = button('Pair & download sleep', 'primary big');
  const btnEcg = button('Pair & download ECG', 'primary big');
  btnEcg.title = 'The watch’s 30-second ECG recordings, saved in ECG history';
  const btnBp = button('Pair & download BP', 'primary big');
  btnBp.title = 'The blood pressure readings taken on the watch (with its other measurements: HRV and emotion)';
  const btnAll = button('Pair & download all data', 'primary big');
  btnAll.title = 'Sleep, activity per minute, heart rate, SpO₂, blood pressure, HRV, emotion, stress, workouts and the 30-second ECG recordings';
  const goButtons = el('div', 'd2-go');
  goButtons.append(btnGo, btnEcg, btnBp, btnAll);
  // how to reach the watch: Chrome's Bluetooth (phones, most computers), the D2 Bridge app on a Mac, or a serial port
  type Via = 'bluetooth' | 'mac' | 'system';
  const isMac = /Mac/i.test(navigator.platform || navigator.userAgent);
  const via = el('select');
  for (const [v, t] of [['bluetooth', 'Chrome Bluetooth'], ['mac', 'D2 Bridge app (Mac)'], ['system', 'Computer’s serial port']] as const) {
    const o = el('option', '', t); o.value = v; via.appendChild(o);
  }
  try { const v = localStorage.getItem('d2link-via'); if (v === 'bluetooth' || v === 'mac' || v === 'system') via.value = v; else if (isMac) via.value = 'mac'; } catch { if (isMac) via.value = 'mac'; }
  via.title = 'On a Mac, Chrome can’t open the watch’s data channel: use the D2 Bridge app (see “Before you start”)';
  const viaLabel = el('label', 'd2-days', 'Connect via ');
  viaLabel.appendChild(via);
  const btnDemo = button('Demo nights');
  const btnForget = button('Forget pairing');
  const btnDisconnect = button('Disconnect watch');
  btnDisconnect.hidden = true;
  const days = el('select');
  for (const [v, t] of [[1, 'Last 1 day'], [3, 'Last 3 days'], [7, 'Last 7 days'], [14, 'Last 14 days'], [30, 'Last 30 days']] as const) {
    const o = el('option', '', t); o.value = String(v); if (v === 7) o.selected = true; days.appendChild(o);
  }
  { const o = el('option', '', 'Choose dates…'); o.value = 'custom'; days.appendChild(o); }
  const daysLabel = el('label', 'd2-days', 'Download ');
  daysLabel.appendChild(days);
  // custom period: start and end dates
  const dateRow = el('div', 'row wrap d2-dates');
  const fromIn = el('input'), toIn = el('input');
  for (const i of [fromIn, toIn]) { i.type = 'date'; i.max = dateInput(new Date()); }
  fromIn.value = dateInput(new Date(Date.now() - 29 * 86400000));
  toIn.value = dateInput(new Date());
  const fromLabel = el('label', 'd2-days', 'From '), toLabel = el('label', 'd2-days', 'to ');
  fromLabel.appendChild(fromIn); toLabel.appendChild(toIn);
  dateRow.append(fromLabel, toLabel);
  dateRow.hidden = true;
  days.addEventListener('change', () => { dateRow.hidden = days.value !== 'custom'; });
  const actions = el('div', 'row wrap');
  actions.append(goButtons, daysLabel, viaLabel, btnDemo, btnDisconnect, btnForget);
  // the account the watch belongs to (optional): the watch may keep health data back from a phone without it
  const acct = accountBox(deps.account);
  const progress = el('p', 'note');
  // the connection log as on ECG live: shown once there is something in it
  const logPre = el('pre', 'log');
  logPre.setAttribute('aria-label', 'Connection log');
  logPre.hidden = true;
  card.append(status, noSerial, actions, dateRow, progress, logPre, acct);

  const help = el('details', 'card d2-help');
  help.appendChild(el('summary', '', 'Before you start (first time)'));
  const steps = el('ol');
  for (const s of [
    'Use Chrome on an Android phone or on a computer. Safari, Firefox and iPhones can’t reach the watch.',
    'On a Mac: Chrome can’t open the watch’s data channel there, so open the “D2 Bridge” app first (a separate Mac app by ECG-Tracking) and choose “Connect via: D2 Bridge app (Mac)”. Chrome may ask to let this page reach apps on this device: allow it.',
    'The watch talks to one device at a time: switch off Bluetooth on the phone it is connected to while you download.',
    'Make sure the watch is not connected to its phone app while you do this (disconnect it there, or use a phone without that app).',
    'Pair the watch in the phone’s or computer’s Bluetooth settings first (it is listed with “WATCH D2” in its name).',
    'Click “Pair & download sleep” (or “Pair & download all data”) and choose the watch in Chrome’s list. The first time, confirm the pairing on the watch if it asks.',
    'Afterwards, the watch’s phone app may need to reconnect to it.',
  ]) steps.appendChild(el('li', '', s));
  help.appendChild(steps);
  help.appendChild(el('p', 'note', 'D2 Link is experimental: it is built from Gadgetbridge’s open-source description of the watch protocol and has not yet been tested with every Watch D2 firmware. “Download all data” also reads activity, blood pressure, HRV, emotion, stress, workouts and the watch’s 30-second ECG recordings (saved in ECG history); numbers and any text the watch sends sync to your other devices. If the watch refuses something, the connection log shows where it stopped.'));

  // download history: when, which button, how, which dates, and what came back
  const history = el('details', 'card d2-history');
  history.appendChild(el('summary', '', 'Download history'));
  const historyBox = el('div');
  history.appendChild(historyBox);
  const renderHistory = (): void => {
    const entries = store.loadDownloadLog().filter((e) => e.user === deps.user());
    if (!entries.length) { historyBox.replaceChildren(el('p', 'muted', 'No downloads yet on this device.')); return; }
    const day = (ms: number): string => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
    const wrap = el('div', 'd2-table-wrap');
    const t = el('table', 'd2-table d2-history-table');
    const hr = el('tr');
    hr.appendChild(el('th', 'del-col del-front'));
    for (const h of ['Date and time', 'Download', 'Dates', 'Result', '']) hr.appendChild(el('th', '', h));
    t.appendChild(el('thead')).appendChild(hr);
    const body = el('tbody');
    for (const e of entries) {
      const remove = async (): Promise<void> => { await store.removeDownloadLog(e.at); renderHistory(); };
      const tr = el('tr', 'd2-history-main');
      const frontTd = el('td', 'del-col del-front');
      frontTd.appendChild(deleteButton('this download from the history', remove, 'Remove this download from the history? (The data it downloaded is kept.)'));
      tr.appendChild(frontTd);
      for (const c of [dateTime(e.at), `${e.button === 'all' ? 'All data' : e.button === 'ecg' ? 'ECG' : e.button === 'bp' ? 'Blood pressure' : 'Sleep'} · ${e.via}`, `${day(e.from)} – ${day(e.to)}`, e.result]) tr.appendChild(el('td', '', c));
      const delTd = el('td', 'del-col');
      delTd.appendChild(deleteButton('this download from the history', remove, 'Remove this download from the history? (The data it downloaded is kept.)'));
      tr.append(delTd);
      if (!e.ok) tr.classList.add('d2-history-failed');
      // what came back, on its own full-width row
      const got = e.items.filter((i) => i.count != null).map((i) => `${/^nights?$/.test(i.what) ? sleepRecords(i.count ?? 0) : `${i.count} ${i.what}`}${nilText(i.count ?? 0, i.nil ?? 0)}`).join(' · '); // older entries say nights
      const missed = e.items.filter((i) => i.count == null).map((i) => `${i.what}${i.note ? ` (${i.note})` : ''}`);
      const detail = el('tr', 'd2-history-detail');
      const td = el('td', '', `${got ? `Downloaded: ${got}` : 'Nothing downloaded'}${missed.length ? `. Not downloaded: ${missed.join(', ')}` : ''}${e.watch ? ` · ${e.watch}` : ''}`);
      td.colSpan = 6;
      detail.appendChild(td);
      body.append(tr, detail);
    }
    t.appendChild(body);
    wrap.appendChild(t);
    frontDeletes(wrap);
    historyBox.replaceChildren(el('p', 'note', 'Synced to your other devices. Newest first.'), wrap);
  };

  const listHead = el('h3', '', 'Sleep from the watch');
  const syncRow = el('div', 'row between wrap d2-sync');
  const syncText = el('span', 'note');
  const btnSync = button('Sync now');
  const btnExport = button('Export all sleep');
  btnExport.title = 'Save all sleep of this user from the watch (nights and naps) as one JSON file';
  const btnExportAll = button('Export all data');
  btnExportAll.title = 'Save everything downloaded from the watch for this user (sleep, activity, measurements, stress, workouts) as one JSON file';
  const syncButtons2 = el('div', 'row wrap');
  syncButtons2.append(btnSync, btnExport, btnExportAll);
  syncRow.append(syncText, syncButtons2);
  const list = el('ul', 'sessions');
  const empty = el('p', 'muted', 'No sleep yet. Download from the watch, or try the demo nights.');
  // Nights / Week / Month
  const tabs = el('div', 'd2-tabs');
  tabs.setAttribute('role', 'tablist');
  const TAB_NAMES = { nights: 'Sleep', week: 'Week', month: 'Month', data: 'All data', graphs: 'Graphs' } as const;
  const tabBtns = (['nights', 'week', 'month', 'data', 'graphs'] as const).map((v) => {
    const b = button(TAB_NAMES[v]);
    b.setAttribute('role', 'tab');
    b.dataset['view'] = v;
    tabs.appendChild(b);
    return b;
  });
  const trendsBox = el('div', 'd2-trends');
  const dataBox = el('div', 'd2-alldata');
  const graphsBox = el('div', 'd2-alldata d2-graphs');
  const histTitle = el('h2', '', 'D2 Link History ');
  const histUserTag = el('span', 'muted');
  histTitle.appendChild(histUserTag);
  home.append(title, card, help, history);
  histHome.append(...(deps.historyRoot ? [histTitle] : []), listHead, syncRow, tabs, empty, list, trendsBox, dataBox, graphsBox);

  const log = (line: string): void => {
    logPre.hidden = false;
    logPre.textContent += `${clock(Date.now())} ${line}\n`;
    logPre.scrollTop = logPre.scrollHeight;
  };
  const setStatus = (text: string, state: '' | 'on' | 'busy'): void => { statusText.textContent = text; dot.className = `dot ${state}`; };
  const syncButtons = (busy = false): void => {
    const paired = store.loadPairing() != null;
    btnGo.textContent = paired ? 'Download sleep' : 'Pair & download sleep';
    btnAll.textContent = paired ? 'Download all data' : 'Pair & download all data';
    btnEcg.textContent = paired ? 'Download ECG' : 'Pair & download ECG';
    btnBp.textContent = paired ? 'Download BP' : 'Pair & download BP';
    btnEcg.hidden = !deps.saveEcgs;
    const reachable = via.value === 'mac' || serialAvailable();
    btnGo.disabled = busy || !reachable;
    btnAll.disabled = busy || !reachable;
    btnEcg.disabled = busy || !reachable;
    btnBp.disabled = busy || !reachable;
    via.disabled = busy;
    noSerial.hidden = reachable;
    btnForget.hidden = !paired;
    btnForget.disabled = busy;
    btnDemo.disabled = busy;
    help.open = !paired;
  };

  let nights: D2Night[] = []; // night sleeps, newest first
  let napsByDay = new Map<string, D2Night[]>(); // daytime naps, by the day they belong to
  let model: ScoreModel = fitScoreModel([]);
  async function renderList(): Promise<void> {
    userTag.textContent = `· ${deps.userLabel()}`;
    histUserTag.textContent = `· ${deps.userLabel()}`;
    const all = await store.listNights(deps.user());
    nights = all.filter((n) => !isNap(n));
    model = fitScoreModel(nights.filter((n) => n.source !== 'demo'));
    napsByDay = new Map();
    for (const n of all.filter(isNap).sort((a, b) => a.start - b.start)) {
      const k = dayKey(n);
      napsByDay.set(k, [...(napsByDay.get(k) ?? []), n]);
    }
    empty.hidden = all.length > 0;
    const nightDays = new Set(nights.map(dayKey));
    const rows: { ms: number; li: HTMLLIElement }[] = nights.map((n) => {
      const f = figures(n);
      const naps = napsByDay.get(dayKey(n)) ?? [];
      const li = el('li');
      const left = el('div');
      const stats = [n.summary.sleepScore != null ? `Score ${n.summary.sleepScore}` : '', f.wakeups != null ? `${f.wakeups} awakening${f.wakeups === 1 ? '' : 's'}` : '', f.sleepMin ? hm(f.sleepMin) : ''];
      left.append(el('div', 'when', `${dateTime(f.bedMs)} · Night`), el('div', 'stats', stats.filter(Boolean).join(' · ')));
      li.append(left, el('div', 'dur', [naps.length ? `+ ${naps.length} nap${naps.length > 1 ? 's' : ''}` : '', n.source === 'demo' ? 'demo' : ''].filter(Boolean).join(' · ')), deleteButton('this night', () => removeNights([n]),
        n.synced ? 'Delete this night from this device and from your other devices? You can get it back from the Recovery centre.' : 'Delete this night from this device? You can get it back from the Recovery centre.'));
      li.addEventListener('click', () => openReport(n.id));
      return { ms: f.wokeMs, li };
    });
    // naps on a day without a night sleep: listed on their own
    for (const [k, naps] of napsByDay) {
      if (nightDays.has(k) || !naps[0]) continue;
      const li = el('li', 'd2-naps-only');
      const left = el('div');
      const asleep = hm(naps.reduce((m, x) => m + figures(x).sleepMin, 0));
      left.append(el('div', 'when', `${dateTime(figures(naps[0]).bedMs)} · ${naps.length === 1 ? 'Nap' : `${naps.length} naps`}`), el('div', 'stats', [...naps.map(napText), asleep].join(' · ')));
      li.append(left, el('div', 'dur'), deleteButton('these naps', () => removeNights(naps), `Delete ${naps.length === 1 ? 'this nap' : `these ${naps.length} naps`}? You can get ${naps.length === 1 ? 'it' : 'them'} back from the Recovery centre.`));
      rows.push({ ms: figures(naps[0]).wokeMs, li });
    }
    list.replaceChildren(...rows.sort((a, b) => b.ms - a.ms).map((r) => r.li));
    showView();
    deps.sleepChanged?.();
  }

  // ---------- Nights / Week / Month ----------
  let view: 'nights' | 'data' | 'graphs' | Period = 'nights';
  const RANGE_KEY = 'd2link-graphs-range';
  let range: Range = '7d';
  try { const r = localStorage.getItem(RANGE_KEY); if (RANGES.some(([v]) => v === r)) range = r as Range; } catch { /* default */ }
  let anchor = new Date();
  function showView(): void {
    for (const b of tabBtns) b.setAttribute('aria-selected', String(b.dataset['view'] === view));
    list.hidden = view !== 'nights';
    empty.hidden = view !== 'nights' || nights.length > 0 || napsByDay.size > 0;
    trendsBox.hidden = view === 'nights' || view === 'data' || view === 'graphs';
    dataBox.hidden = view !== 'data';
    graphsBox.hidden = view !== 'graphs';
    if (view === 'data') { void store.listRecords(deps.user()).then((rs) => renderAllData(dataBox, rs, () => { showView(); void sync(); })); return; }
    if (view === 'graphs') {
      void Promise.all([store.listNights(deps.user()), store.listRecords(deps.user())]).then(([ns, rs]) => renderGraphs(graphsBox, ns, rs, range, (r) => {
        range = r;
        try { localStorage.setItem(RANGE_KEY, r); } catch { /* not kept */ }
        showView();
      }));
      return;
    }
    if (view === 'nights') return;
    const period = view;
    renderTrends(trendsBox, nights, period, anchor, {
      prev: () => { anchor = period === 'week' ? addDays(anchor, -7) : new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1); showView(); },
      next: () => { anchor = period === 'week' ? addDays(anchor, 7) : new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1); showView(); },
      open: (day) => { const n = nights.find((x) => dayKey(x) === day); if (n) openReport(n.id); },
    });
  }
  for (const b of tabBtns) {
    b.addEventListener('click', () => {
      const v = b.dataset['view'];
      if (v !== 'nights' && v !== 'week' && v !== 'month' && v !== 'data' && v !== 'graphs') return;
      view = v;
      const latest = nights[0];
      anchor = latest ? dateOf(dayKey(latest)) : new Date(); // start at the most recent night
      showView();
    });
  }

  // ---------- cloud sync: nights downloaded on one device appear on the others ----------
  let syncing: Promise<void> | null = null;
  function sync(): Promise<void> {
    if (!deps.cloud) {
      syncText.textContent = 'Offline: sleep stays on this device and syncs when you’re back online.';
      btnSync.disabled = true;
      return Promise.resolve();
    }
    const client = deps.cloud;
    syncing ??= (async () => {
      btnSync.disabled = true;
      syncText.textContent = 'Syncing with the cloud…';
      try {
        const n = await syncNights(client);
        let rec = { uploaded: 0, downloaded: 0, deleted: 0 };
        try { rec = await syncRecords(client); } catch (e) { if (e instanceof CloudSetupError) throw e; log(`Sync of the other watch data failed: ${e instanceof Error ? e.message : String(e)}`); }
        const r = { uploaded: n.uploaded + rec.uploaded, downloaded: n.downloaded + rec.downloaded, deleted: n.deleted };
        const parts = [r.uploaded && `${r.uploaded} uploaded`, r.downloaded && `${r.downloaded} downloaded`, r.deleted && `${r.deleted} removed`].filter(Boolean);
        syncText.textContent = `Synced at ${clock(Date.now())}${parts.length ? ` (${parts.join(', ')})` : ''}. Sleep and the watch’s numbers are shared with your other devices; demo nights and text from the watch stay here.`;
        if (r.downloaded || r.deleted) { await renderList(); renderHistory(); }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        syncText.textContent = e instanceof CloudSetupError ? e.message
          : /failed to fetch|network|load failed/i.test(msg) ? 'Can’t reach the cloud (no internet?). Nights stay on this device; tap Sync now to try again.'
          : `Sync failed: ${msg}`;
      } finally {
        btnSync.disabled = false;
        syncing = null;
      }
    })();
    return syncing;
  }
  btnSync.addEventListener('click', () => void sync());
  const saveJson = (file: Record<string, unknown>, name: string): void => {
    const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
    const a = el('a'); a.href = URL.createObjectURL(blob); a.download = `${name}-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  btnExport.addEventListener('click', () => void (async () => {
    const all = (await store.listNights(deps.user())).filter((n) => n.source !== 'demo').sort((a, b) => a.start - b.start);
    if (!all.length) { window.alert('There is no sleep from the watch to export yet.'); return; }
    saveJson({ app: 'OpenBeat ECG – D2 Link', exportedAt: new Date().toISOString(), user: deps.user(), nights: all }, 'd2-nights');
  })());
  // everything for this user, grouped by kind (each record with its numbers and, where there is any, the text kept on this device)
  btnExportAll.addEventListener('click', () => void (async () => {
    const nightsAll = (await store.listNights(deps.user())).filter((n) => n.source !== 'demo').sort((a, b) => a.start - b.start);
    const records = (await store.listRecords(deps.user())).filter((r) => r.source !== 'demo').sort((a, b) => a.start - b.start);
    if (!nightsAll.length && !records.length) { window.alert('There is no data from the watch to export yet.'); return; }
    const byKind = Object.fromEntries(store.D2_KINDS.map((k) => [k, records.filter((r) => r.kind === k)]));
    saveJson({ app: 'OpenBeat ECG – D2 Link', exportedAt: new Date().toISOString(), user: deps.user(), nights: nightsAll, ...byKind }, 'd2-all-data');
  })());

  // ---------- download ----------
  via.addEventListener('change', () => { try { localStorage.setItem('d2link-via', via.value); } catch { /* not kept */ } syncButtons(); });
  const download = (mode: Via, all = false, ecgOnly = false, bpOnly = false): void => void (async () => {
    const period = downloadPeriod(days.value, fromIn.value, toIn.value);
    if ('error' in period) { progress.textContent = period.error; return; }
    syncButtons(true);
    progress.textContent = '';
    const entry: store.DownloadLogEntry = {
      at: Date.now(), user: deps.user(), button: ecgOnly ? 'ecg' : bpOnly ? 'bp' : all ? 'all' : 'sleep', via: via.selectedOptions[0]?.textContent ?? mode,
      from: period.start * 1000, to: period.end * 1000, watch: '', items: [], ok: false, result: '',
    };
    setStatus(mode === 'mac' ? 'Connecting through D2 Bridge…' : 'Choose the watch in Chrome’s list…', 'busy');
    let link: D2Link | null = null;
    try {
      logTo(log);
      const w = await connectWatch(deps.account, mode, (text) => setStatus(text, 'busy'));
      link = w.link;
      const name = w.name;
      entry.watch = name;
      setStatus(`${name}${w.battery != null ? ` · battery ${w.battery}%` : ''} – downloading…`, 'on');
      const { start, end } = period;
      if (days.value === 'custom') log(`Period: ${new Date(start * 1000).toLocaleDateString()} – ${new Date(end * 1000).toLocaleDateString()}.`);
      if (bpOnly) {
        const n = await downloadBp(link, start, name, entry.items);
        progress.textContent = n.total ? `${n.total} blood pressure reading${n.total === 1 ? '' : 's'}${nilText(n.total, n.same)}.` : 'The watch has no blood pressure readings for this period.';
        setStatus(`${name} – done`, 'on');
        void sync();
        entry.ok = true;
        entry.result = 'Done';
        return;
      }
      if (ecgOnly) {
        const counts = await downloadEcgs(link, start, end, entry.items);
        progress.textContent = counts ? `${counts}.` : 'The watch has no ECG recordings for this period.';
        setStatus(`${name} – done`, 'on');
        entry.ok = true;
        entry.result = 'Done';
        return;
      }
      const file = await link.downloadSleep(start, end, (d, total) => { progress.textContent = `Downloading… ${Math.round((100 * d) / total)}%`; });
      const got = parseSleepFile(file).map((d) => store.nightFromData(d, deps.user(), name));
      const { changed, same } = onlyChanged(got, await store.listAllNights(), (n) => n.id, nightContent);
      await store.saveNights(changed);
      entry.items.push({ what: got.length === 1 ? 'sleep record' : 'sleep records', count: got.length, nil: same.length });
      log(`${sleepRecords(got.length)}: ${changed.length} saved, ${same.length} nil change.`);
      void sync();
      progress.textContent = got.length ? `${sleepRecords(got.length)} downloaded${nilText(got.length, same.length)}.` : 'The watch has no sleep records for this period.';
      setStatus(`${name} – done`, 'on');
      await renderList();
      const latest = got.sort((a, b) => b.start - a.start)[0];
      if (all) {
        setStatus(`${name} – downloading the other data…`, 'on');
        const counts = await downloadOthers(link, start, end, name, entry.items);
        progress.textContent = `${sleepRecords(got.length)}${nilText(got.length, same.length)}${counts ? `; ${counts}` : '; no other data'}.`;
        setStatus(`${name} – done`, 'on');
        void sync();
        view = 'data';
        showView();
        toHistory();
      } else if (latest) openReport(latest.id);
      entry.ok = true;
      entry.result = 'Done';
    } catch (e) {
      const msg = e instanceof DOMException && e.name === 'NotFoundError' ? 'No watch was chosen.' : e instanceof Error ? e.message : String(e);
      entry.result = `Stopped: ${msg}`;
      log(`Stopped: ${msg}`);
      setStatus(msg, '');
      progress.textContent = e instanceof DOMException && e.name === 'NotFoundError'
        ? 'If the watch isn’t in the list, pair it in the computer’s Bluetooth settings first (see “Before you start”).'
        : mode === 'system' && e instanceof WatchError && /first message/.test(msg)
          ? 'The port opened but the watch didn’t answer on it: it is probably not the watch’s data channel.'
          : '';
    } finally {
      // the connection stays open for the next download and for Synchronised ECG Tracking
      syncButtons(false);
      if (!store.nothingCameBack(entry)) store.addDownloadLog(entry);
      renderHistory();
    }
  })();
  /** Everything besides sleep; each kind on its own, so one the watch refuses doesn't stop the others. Returns a summary. */
  async function downloadOthers(link: D2Link, start: number, end: number, name: string, items: store.DownloadLogItem[]): Promise<string> {
    const user = deps.user(), parts: string[] = [];
    progress.textContent = 'Setting up the watch…';
    const w = openedWatch();
    if (w) await ensureSetUp(w, deps.profile?.() ?? null);
    const step = async (what: string, fn: () => Promise<store.D2Record[]>): Promise<void> => {
      progress.textContent = `Downloading ${what}…`;
      try {
        const rs = await fn();
        const { changed, same } = onlyChanged(rs, await store.listAllRecords(), (r) => r.key, recordContent);
        if (changed.length) await store.saveRecords(changed);
        if (rs.length) parts.push(`${rs.length} ${what}${nilText(rs.length, same.length)}`);
        if (what === 'measurements') { // one line per kind, e.g. "127 blood pressure"
          for (const [cls, spec] of Object.entries(READING_CLASSES)) {
            const ofKind = (l: readonly store.D2Record[]): number => l.filter((r) => r.data['cls'] === Number(cls)).length;
            items.push({ what: spec.name, count: ofKind(rs), nil: ofKind(same) });
          }
        } else items.push({ what, count: rs.length, nil: same.length });
        log(`${what}: ${changed.length} saved, ${same.length} nil change.`);
      } catch (e) {
        items.push({ what, count: null, note: e instanceof Error ? e.message.replace(/^The watch /, '').replace(/\.$/, '') : String(e) });
        log(`${what}: not downloaded (${e instanceof Error ? e.message : String(e)}).`);
        if (e instanceof WatchError && /not connected|disconnected/.test(e.message)) throw e;
      }
    };
    const existing = await store.listRecords(user, 'activity');
    await step('activity days', async () => activityRecords(await downloadActivity(link, start, end, (d, t) => { progress.textContent = `Downloading activity… ${d} of ${t}`; }), user, name, existing));
    await step('daily totals', async () => { const t = await downloadTotals(link, log); return t ? [totalsRecord(t, user, name)] : []; });
    await step('measurements', async () => readingRecords(await downloadReadings(link, start * 1000, log), user, name));
    await step('stress records', async () => stressRecords(parseStressFile(await link.downloadFile({ name: 'rrisqi_data.bin', type: 0x10, start, end, what: 'stress' })), user, name));
    await step('workouts', async () => workoutRecords(await downloadWorkouts(link, start, end, log), user, name));
    const ecg = await downloadEcgs(link, start, end, items);
    if (ecg) parts.push(ecg);
    return parts.join(', ');
  }

  /**
   * The blood pressure readings since `start` (s). They come in the watch's measurements file with its HRV and emotion
   * readings, which are saved too. Returns how many blood pressure readings came, and how many were already here.
   */
  async function downloadBp(link: D2Link, start: number, name: string, items: store.DownloadLogItem[]): Promise<{ total: number; same: number }> {
    progress.textContent = 'Setting up the watch…';
    const w = openedWatch();
    if (w) await ensureSetUp(w, deps.profile?.() ?? null);
    progress.textContent = 'Downloading blood pressure…';
    const rs = readingRecords(await downloadReadings(link, start * 1000, log), deps.user(), name);
    const { changed, same } = onlyChanged(rs, await store.listAllRecords(), (r) => r.key, recordContent);
    if (changed.length) await store.saveRecords(changed);
    const bp = (l: readonly store.D2Record[]): number => l.filter((r) => r.data['cls'] === 10002).length;
    items.push({ what: 'Blood pressure', count: bp(rs), nil: bp(same) });
    log(`Blood pressure: ${bp(changed)} saved, ${bp(same)} nil change (with ${rs.length - bp(rs)} other measurements).`);
    return { total: bp(rs), same: bp(same) };
  }

  /** The watch's 30-second ECGs, saved in ECG history as from ECG live; returns a summary ('' when there were none). */
  async function downloadEcgs(link: D2Link, start: number, end: number, items: store.DownloadLogItem[]): Promise<string> {
    if (!deps.saveEcgs) return '';
    progress.textContent = 'Downloading ECG recordings…';
    try {
      const recs = parseEcgFile(await link.downloadFile({ name: 'ecg_analysis_data.bin', type: 0x18, start: start - 5, end: end + 5, what: 'ECG' }))
        .filter((r) => r.samples.length > 0 && r.start >= start * 1000 - 5000 && r.start <= end * 1000 + 5000);
      const n = await deps.saveEcgs(recs);
      items.push({ what: 'ECG recordings', count: recs.length, nil: n.same });
      log(`ECG recordings: ${n.saved} saved in ECG history, ${n.same} nil change${n.short ? `, ${n.short} too short to use` : ''}.`);
      return recs.length ? `${recs.length} ECG recording${recs.length === 1 ? '' : 's'}${nilText(recs.length, n.same)}` : '';
    } catch (e) {
      items.push({ what: 'ECG recordings', count: null, note: e instanceof Error ? e.message.replace(/^The watch /, '').replace(/\.$/, '') : String(e) });
      log(`ECG recordings: not downloaded (${e instanceof Error ? e.message : String(e)}).`);
      if (e instanceof WatchError && /not connected|disconnected/.test(e.message)) throw e;
      return '';
    }
  }

  btnGo.addEventListener('click', () => download(via.value as Via));
  btnEcg.addEventListener('click', () => download(via.value as Via, false, true));
  btnBp.addEventListener('click', () => download(via.value as Via, false, false, true));
  btnAll.addEventListener('click', () => download(via.value as Via, true));

  btnForget.addEventListener('click', () => {
    if (!window.confirm('Forget the pairing with the watch? Next time you will pair again (and may need to confirm on the watch). Downloaded sleep records are kept.')) return;
    store.savePairing(null);
    log('Pairing forgotten.');
    syncButtons();
  });

  btnDemo.addEventListener('click', () => void (async () => {
    await store.saveNights(demoNights(deps.user()));
    await renderList();
    const latest = nights[0];
    if (latest) openReport(latest.id);
  })());

  async function removeNights(ns: readonly D2Night[]): Promise<void> {
    for (const n of ns) await store.deleteNight(n.id);
    await renderList();
    void sync();
  }

  // ---------- report ----------
  /** `from` is set when another page opened the report: its back button returns there. */
  function openReport(id: string, from?: () => void, copy?: D2Night): void {
    const i = copy ? -1 : nights.findIndex((n) => n.id === id);
    const n = copy ?? nights[i] ?? [...napsByDay.values()].flat().find((x) => x.id === id);
    if (!n) return;
    renderReport(report, n, nights, copy ? [] : napsByDay.get(dayKey(n)) ?? [], model, {
      back: () => { report.hidden = true; histHome.hidden = false; window.scrollTo(0, 0); from?.(); },
      backLabel: from ? '← Back' : '← Sleep',
      copy: copy != null,
      older: !copy && nights[i + 1] ? () => openReport(nights[i + 1]!.id, from) : null,
      newer: i > 0 ? () => openReport(nights[i - 1]!.id, from) : null,
      ecg: (box) => {
        const f = figures(n);
        void deps.ecgDuring?.(f.inBedFromMs, f.inBedToMs).then((hit) => {
          box.hidden = !hit && !from;
          box.appendChild(el('h3', '', `ECG during this ${isNap(n) ? 'nap' : 'night'}`));
          if (!hit) { box.appendChild(el('p', 'muted', 'No ECG was saved during this sleep.')); return; }
          const r = el('div', 'row between d2-more-row');
          r.append(el('span', 'muted', 'Saved ECG'), el('span', '', hit.label));
          const open = button('Open ECG report');
          open.addEventListener('click', () => deps.openEcg?.(hit.id));
          box.append(r, open);
        });
      },
      remove: async () => {
        if (!window.confirm(n.synced ? 'Delete this night from this device and from your other devices? You can get it back from the Recovery centre.' : 'Delete this night from this device? You can get it back from the Recovery centre.')) return;
        await store.deleteNight(n.id);
        await renderList();
        void sync();
        report.hidden = true; histHome.hidden = false;
      },
    });
    histHome.hidden = true;
    report.hidden = false;
    toHistory();
    window.scrollTo(0, 0);
  }

  // the watch connection is shared with Synchronised ECG Tracking: this page shows it, whichever page connected it
  logTo(log);
  btnDisconnect.addEventListener('click', () => void disconnectWatch());
  onWatch((w) => {
    btnDisconnect.hidden = !w;
    if (w) setStatus(`${w.name}${w.battery != null ? ` · battery ${w.battery}%` : ''} – connected`, 'on');
    else setStatus('Not connected', '');
  });

  syncButtons();
  renderHistory();
  void renderList().then(sync);
  return {
    refresh: () => { report.hidden = true; histHome.hidden = false; void store.dropFailedDownloads().then(renderHistory); void renderList().then(sync); },
    openNight: async (id, back, copy) => { await renderList(); openReport(id, back, copy as D2Night | undefined); },
  };
}

interface ReportActions { back: () => void; backLabel: string; copy: boolean; ecg: (box: HTMLElement) => void; older: (() => void) | null; newer: (() => void) | null; remove: () => Promise<void> }

const napText = (n: D2Night): string => { const f = figures(n); return `${clock(f.bedMs)}–${clock(f.wokeMs)} (${f.sleepMin} min)`; };

/** A download can hold naps as well as nights. */
const sleepRecords = (n: number): string => `${n} sleep record${n === 1 ? '' : 's'}`;

/** "What made your score": the estimate's parts for this night. */
function scoreCardFor(n: D2Night, model: ScoreModel): HTMLElement | null {
  const e = explainScore(n, model);
  if (!e) return null;
  const card = el('div', 'card d2-why');
  card.appendChild(el('h3', '', 'What made your score'));
  const x = e.inputs;
  const pts = (v: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v))}`;
  const parts: { name: string; detail: string; value: number; color: string }[] = [
    { name: 'Sleep duration', detail: `${hm(x.hours * 60)}${x.hours > CEILING_H ? ` (more than ${CEILING_H} h lowers it)` : ''}`, value: e.duration, color: 'var(--stage-deep)' },
    { name: 'Sleep efficiency', detail: `${Math.round(x.efficiency)}% of time in bed asleep`, value: e.efficiency, color: 'var(--stage-light)' },
    { name: 'Deep sleep', detail: `${Math.round(x.deepPct)}% of sleep`, value: e.deep, color: 'var(--stage-rem)' },
  ];
  const summary = el('p', 'd2-why-sum', `Starting point ${Math.round(e.base)} · ${parts.map((p) => `${p.name.toLowerCase().replace('sleep ', '')} ${pts(p.value)}`).join(' · ')} = ${Math.round(e.estimate)}${e.actual != null ? ` (watch: ${e.actual})` : ''}`);
  card.appendChild(summary);
  // one bar: the share of the estimate each part makes up
  const bar = el('div', 'd2-why-bar');
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', summary.textContent ?? '');
  const total = Math.max(1, e.base + parts.reduce((s, p) => s + Math.max(0, p.value), 0));
  const seg = (w: number, color: string, title: string): void => {
    const d = el('span'); d.style.width = `${(100 * Math.max(0, w)) / total}%`; d.style.background = color; d.title = title; bar.appendChild(d);
  };
  seg(e.base, 'var(--line)', `Starting point ${Math.round(e.base)}`);
  for (const p of parts) seg(p.value, p.color, `${p.name} ${pts(p.value)}`);
  card.appendChild(bar);
  for (const p of parts) {
    const r = el('div', 'row between d2-more-row');
    const name = el('span'); const sw = el('i'); sw.style.background = p.color; name.append(sw, document.createTextNode(`${p.name} · `), el('span', 'muted', p.detail));
    r.append(name, el('b', '', `${pts(p.value)} points`));
    card.appendChild(r);
  }
  card.appendChild(el('p', 'note', `Each hour of sleep up to ${CEILING_H} h adds about ${model.perHour.toFixed(1)} points; each 10% of efficiency about ${(10 * model.perEfficiency).toFixed(1)}; each 10% of deep sleep about ${(10 * model.perDeep).toFixed(1)}.`));
  card.appendChild(el('p', 'note', model.fittedOn
    ? `Our estimate of how the watch scores sleep, fitted to your ${model.fittedOn} scored nights (typically within ${model.rmse != null ? model.rmse.toFixed(1) : '?'} points of the watch). The watch’s maker doesn’t publish its formula.`
    : `Our starting estimate of how the watch scores sleep (fitted to 30 nights of a Watch D2); it is fitted to your own nights once you have ${MIN_NIGHTS_TO_FIT}. The watch’s maker doesn’t publish its formula.`));
  return card;
}

function renderReport(box: HTMLElement, n: D2Night, all: D2Night[], naps: D2Night[], model: ScoreModel, act: ReportActions): void {
  box.replaceChildren();
  const f = figures(n), s = n.summary;

  const bar = el('div', 'row between wrap');
  const back = button(act.backLabel);
  back.addEventListener('click', act.back);
  const right = el('div', 'row wrap');
  const json = button('JSON');
  json.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(n, null, 2)], { type: 'application/json' });
    const a = el('a'); a.href = URL.createObjectURL(blob); a.download = `d2-night-${new Date(n.start).toISOString().slice(0, 10)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  const del = button('Delete', 'danger');
  del.addEventListener('click', () => void act.remove());
  right.append(json);
  if (!act.copy) right.appendChild(del); // a saved version: the recording itself is deleted from its own report
  bar.append(back, right);

  // date and night sleep with the stage chart
  const top = el('div', 'card d2-night');
  const nav = el('div', 'd2-datenav');
  const prev = button('‹', 'd2-nav'), next = button('›', 'd2-nav');
  prev.setAttribute('aria-label', 'Previous night'); next.setAttribute('aria-label', 'Next night');
  prev.disabled = !act.older; next.disabled = !act.newer;
  prev.addEventListener('click', () => act.older?.());
  next.addEventListener('click', () => act.newer?.());
  nav.append(prev, el('span', 'd2-date', dayLabel(f.wokeMs)), next);
  const big = el('div', 'd2-big');
  big.append(el('div', 'muted', isNap(n) ? 'Nap sleep' : 'Night sleep'), el('div', 'd2-big-value', f.sleepMin ? hm(f.sleepMin) : '--'));
  const times = el('div', 'row between d2-times');
  const bedT = el('div'); bedT.append(el('div', 'muted', shortDate(f.bedMs)), el('div', '', `Bed time ${clock(f.bedMs)}`));
  const wokeT = el('div', 'd2-right'); wokeT.append(el('div', 'muted', shortDate(f.wokeMs)), el('div', '', `Woke up ${clock(f.wokeMs)}`));
  times.append(bedT, wokeT);
  const legend = el('div', 'legend d2-legend');
  for (const code of [3, 1, 2, 4]) {
    const it = el('span'); const sw = el('i'); sw.style.background = STAGE_VAR[code] ?? ''; it.append(sw, document.createTextNode(STAGE_NAME[code] ?? '')); legend.appendChild(it);
  }
  top.append(nav, big, hypnogram(f.shown), times, legend);
  if (act.copy) top.appendChild(el('p', 'note', 'Saved version of this report.'));
  if (n.source === 'demo') top.appendChild(el('p', 'note', 'Demo night (made-up data) to show the report layout.'));

  // score, recent awakenings and the stage donut
  const scoreCard = el('div', 'card d2-score');
  const score = el('div', 'd2-score-main');
  const pts = el('div', 'd2-points');
  pts.append(document.createTextNode(s.sleepScore != null ? String(s.sleepScore) : '--'), el('small', '', ' points'));
  score.append(pts, stars(s.sleepScore), el('div', 'muted', 'Sleep score from the watch'));
  const recent = all.filter((x) => x.start <= n.start).slice(0, 7).reverse();
  const wake = el('div', 'd2-wake');
  const wakeHead = el('div', 'row between');
  const first = recent[0], last = recent[recent.length - 1];
  wakeHead.append(el('span', '', `Times woke up${first && last ? ` (${shortDate(figures(first).wokeMs)}–${shortDate(figures(last).wokeMs)})` : ''}`), el('span', f.wakeups != null && f.wakeups > 1 ? 'd2-high' : 'd2-normal', `${f.wakeups ?? '--'} times`));
  wake.append(wakeHead, wakeBars(recent));
  const mix = el('div', 'd2-mix');
  const parts = [
    { min: f.deepMin, color: 'var(--stage-deep)', name: 'Deep sleep' },
    { min: f.lightMin, color: 'var(--stage-light)', name: 'Light sleep' },
    { min: f.remMin, color: 'var(--stage-rem)', name: 'REM sleep' },
  ];
  const rows = el('div', 'd2-mix-rows');
  for (const p of parts) {
    const r = el('div', 'row between');
    const name = el('span'); const sw = el('i'); sw.style.background = p.color; name.append(sw, document.createTextNode(p.name));
    r.append(name, el('span', '', hm(p.min)));
    rows.appendChild(r);
  }
  mix.append(donut(parts), rows);
  scoreCard.append(el('div', 'd2-score-top'), mix);
  scoreCard.firstChild?.appendChild(score);
  scoreCard.firstChild?.appendChild(wake);

  // tiles
  const grid = el('div', 'd2-tiles');
  for (const t of tiles(n)) {
    const tile = el('div', 'd2-tile');
    const v = el('div', 'd2-tile-value');
    v.append(document.createTextNode(t.value), el('small', '', ` ${t.unit}`));
    if (t.verdict) v.appendChild(el('span', `d2-verdict d2-${t.verdict.kind}`, ` ${t.verdict.text}`));
    tile.append(el('div', 'd2-tile-name', t.name), v, el('div', 'd2-tile-ref', t.ref));
    grid.appendChild(tile);
  }

  const notes = el('details', 'sources');
  notes.appendChild(el('summary', '', 'About these numbers'));
  const ul = el('ul');
  for (const line of [
    `All results are calculated by the watch (${watchName(n.watch)}) and downloaded as they are; D2 Link doesn’t recalculate them.`,
    'References are the ones the watch’s phone app shows for sleep. “Personal range” comes from the watch’s own baseline of your recent nights; until it has enough nights it isn’t set.',
    'The phone app shows the night from falling asleep to waking up; the watch also records when you lay down and got up (see “More from the watch”). “Breathing quality” comes from separate breathing data that D2 Link doesn’t download yet.',
    'Not a medical device. Sleep stages from a wrist watch are estimates.',
  ]) ul.appendChild(el('li', '', line));
  notes.appendChild(ul);

  // what the watch sends that the phone app's sleep page doesn't show
  const more = el('div', 'card d2-more');
  more.appendChild(el('h3', '', 'More from the watch'));
  const moreRows: [string, string][] = [
    ['Time in bed', `${clock(f.inBedFromMs)}–${clock(f.inBedToMs)} (${hm((f.inBedToMs - f.inBedFromMs) / 60000)})`],
    ['Time to fall asleep', s.sleepLatency != null ? `${s.sleepLatency} min` : '--'],
    ['Sleep efficiency', s.sleepEfficiency != null ? `${s.sleepEfficiency}% (asleep ÷ time in bed)` : '--'],
    ['Awake in the night', `${f.awakeMin} min`],
  ];
  for (const [k, v] of moreRows) {
    const r = el('div', 'row between d2-more-row');
    r.append(el('span', 'muted', k), el('span', '', v));
    more.appendChild(r);
  }

  // naps that day, listed under the night
  const napCard = el('div', 'card d2-more');
  napCard.hidden = naps.length === 0;
  napCard.appendChild(el('h3', '', `Naps that day · ${hm(naps.reduce((m, x) => m + figures(x).sleepMin, 0))}`));
  for (const x of naps) {
    const r = el('div', 'row between d2-more-row');
    const f = figures(x);
    r.append(el('span', 'muted', `${clock(f.bedMs)}–${clock(f.wokeMs)}`), el('span', '', hm(f.sleepMin)));
    napCard.appendChild(r);
  }

  const ecgBox = el('div', 'card d2-more');
  ecgBox.hidden = true;
  act.ecg(ecgBox);

  const why = scoreCardFor(n, model);
  box.append(bar, top, napCard, scoreCard, ...(why ? [why] : []), grid, more, ecgBox, notes);
}

function stars(score: number | null): HTMLElement {
  const box = el('div', 'd2-stars');
  const half = score == null ? 0 : Math.ceil(Math.max(0, Math.min(100, score)) / 10); // 0–10 half stars
  box.setAttribute('aria-label', `${half / 2} of 5 stars`);
  for (let i = 0; i < 5; i++) {
    const filled = half >= 2 * (i + 1) ? 'full' : half === 2 * i + 1 ? 'half' : 'empty';
    box.appendChild(el('span', `d2-star ${filled}`, '★'));
  }
  return box;
}

/** Seven made-up nights in the watch's own file format, read back through the same parser as real downloads. */
export function demoNights(user: number): D2Night[] {
  const now = new Date();
  const out: D2Night[] = [];
  for (let k = 0; k < 7; k++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - k, 0, 7 + 9 * k);
    const bed = Math.floor(d.getTime() / 1000);
    const wakes = [3, 1, 2, 0, 2, 2, 1][k] ?? 1;
    const segs: { minutes: number; stage: number }[] = [{ minutes: 4, stage: 4 }];
    const cycle = [[1, 55], [3, 38], [1, 20], [2, 22]] as const;
    for (let c = 0; c < 4; c++) {
      for (const [stage, m] of cycle) segs.push({ minutes: Math.max(5, m + ((c * 7 + k * 3) % 11) - 5 - (stage === 3 ? c * 6 : 0)), stage });
      if (c < wakes) segs.push({ minutes: 2, stage: 4 });
    }
    const total = segs.reduce((s, g) => s + g.minutes, 0);
    const file = writeSleepFile([{
      summary: {
        bedTime: bed, fallAsleepTime: bed + 240, wakeupTime: bed + total * 60, validData: 1, sleepScore: 76 + ((k * 5) % 15), deepPart: 72 + ((k * 3) % 20),
        sleepDataQuality: 88 + (k % 8), avgHeartRate: 52 + (k % 5), minHeartRateBaseline: 47, maxHeartRateBaseline: 54, avgHrv: 42 + ((k * 4) % 15),
        minHrvBaseline: 39, maxHrvBaseline: 61, avgOxygenSaturation: 96 + (k % 3), minOxygenSaturationBaseline: 96, maxOxygenSaturationBaseline: 99,
        avgBreathRate: 14 + (k % 3), minBreathRateBaseline: 13, maxBreathRateBaseline: 17, wakeCount: wakes,
      },
      segments: segs,
    }]);
    const [night] = parseSleepFile(file);
    if (night) out.push({ ...store.nightFromData(night, user, 'demo watch'), id: `d2-demo-${night.start}`, source: 'demo' });
  }
  return out;
}
