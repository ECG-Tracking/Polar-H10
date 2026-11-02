// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — the screen: pair with the watch, download sleep, and a Huawei Health-style night report.
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

import { D2Link, WatchError } from './link';
import { openWatch, serialAvailable } from './serial';
import { parseSleepFile, type D2Summary } from './sleepfile';
import { writeSleepFile } from './sleepfile-writer';
import * as store from './store';
import type { D2Night } from './store';

export interface D2Deps {
  /** Signed-in account id: nights and the pairing are kept per account. */
  account: string;
  user: () => number;
  userLabel: () => string;
}

// ---------- small DOM helpers ----------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const SVG = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, title?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (title) { const t = document.createElementNS(SVG, 'title'); t.textContent = title; e.appendChild(t); }
  return e;
}
function button(text: string, cls = ''): HTMLButtonElement { const b = el('button', cls, text); b.type = 'button'; return b; }

const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const shortDate = (ms: number): string => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}`; };
const dayLabel = (ms: number): string => new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const hm = (min: number): string => `${Math.floor(min / 60)} h ${Math.round(min % 60)} min`;

// ---------- what a night shows ----------

export const STAGE_NAME: Readonly<Record<number, string>> = { 1: 'Light sleep', 2: 'REM sleep', 3: 'Deep sleep', 4: 'Awake', 5: 'Nap' };
const STAGE_VAR: Readonly<Record<number, string>> = { 1: 'var(--stage-light)', 2: 'var(--stage-rem)', 3: 'var(--stage-deep)', 4: 'var(--stage-awake)', 5: 'var(--stage-light)' };
const STAGE_ROW: Readonly<Record<number, number>> = { 4: 0, 2: 1, 1: 2, 5: 2, 3: 3 }; // awake on top, deep at the bottom

export interface NightFigures { deepMin: number; lightMin: number; remMin: number; awakeMin: number; sleepMin: number; bedMs: number; wokeMs: number }

export function figures(n: D2Night): NightFigures {
  const count = (c: number): number => n.stages.filter((s) => s === c).length;
  const deepMin = count(3), lightMin = count(1) + count(5), remMin = count(2), awakeMin = count(4);
  const s = n.summary;
  const bedMs = s.bedTime != null ? s.bedTime * 1000 : n.start;
  const wokeMs = s.wakeupTime != null ? s.wakeupTime * 1000 : n.start + n.stages.length * 60000;
  return { deepMin, lightMin, remMin, awakeMin, sleepMin: deepMin + lightMin + remMin, bedMs, wokeMs };
}

type Verdict = { text: string; kind: 'normal' | 'high' | 'low' | 'personal' } | null;

/** Huawei Health's references: fixed ranges show Normal/High/Low, personal ranges show Within/Above/Below range. */
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

interface TileSpec { name: string; value: string; unit: string; verdict: Verdict; ref: string }

export function tiles(n: D2Night): TileSpec[] {
  const s: D2Summary = n.summary, f = figures(n);
  const pct = (m: number): number | null => (f.sleepMin > 0 ? Math.round((100 * m) / f.sleepMin) : null);
  const show = (v: number | null): string => (v == null ? '--' : String(v));
  const pr = (lo: number | null, hi: number | null, unit: string): string => (lo != null && hi != null && lo > 0 ? `Personal range: ${lo}–${hi}${unit}` : 'Personal range: not set yet');
  const light = pct(f.lightMin), deep = pct(f.deepMin), rem = pct(f.remMin);
  return [
    { name: 'Times woke up', value: show(s.wakeCount), unit: 'times', verdict: fixed(s.wakeCount, 0, 1), ref: 'References: 0–1 times' },
    { name: 'Light sleep', value: show(light), unit: '%', verdict: light == null ? null : light < 55 ? { text: 'Normal', kind: 'normal' } : { text: 'High', kind: 'high' }, ref: 'Reference: <55%' },
    { name: 'Avg heart rate', value: show(s.avgHeartRate), unit: 'bpm', verdict: personal(s.avgHeartRate, s.minHeartRateBaseline, s.maxHeartRateBaseline), ref: pr(s.minHeartRateBaseline, s.maxHeartRateBaseline, ' bpm') },
    { name: 'Night sleep', value: f.sleepMin ? hm(f.sleepMin).replace(' min', '') : '--', unit: 'min', verdict: f.sleepMin ? fixed(f.sleepMin / 60, 6, 10) : null, ref: 'References: 6–10 h' },
    { name: 'Deep sleep', value: show(deep), unit: '%', verdict: fixed(deep, 20, 60), ref: 'References: 20–60%' },
    { name: 'REM sleep', value: show(rem), unit: '%', verdict: fixed(rem, 10, 30), ref: 'References: 10–30%' },
    { name: 'Deep sleep continuity', value: show(s.deepPart), unit: 'points', verdict: fixed(s.deepPart, 70, 100), ref: 'References: 70–100 points' },
    { name: 'Breathing quality', value: show(s.sleepDataQuality), unit: 'points', verdict: fixed(s.sleepDataQuality, 70, 100), ref: 'References: 70–100 points *' },
    { name: 'Avg HRV', value: show(s.avgHrv), unit: 'ms', verdict: personal(s.avgHrv, s.minHrvBaseline, s.maxHrvBaseline), ref: pr(s.minHrvBaseline, s.maxHrvBaseline, ' ms') },
    { name: 'Avg SpO₂', value: show(s.avgOxygenSaturation), unit: '%', verdict: personal(s.avgOxygenSaturation, s.minOxygenSaturationBaseline, s.maxOxygenSaturationBaseline), ref: pr(s.minOxygenSaturationBaseline, s.maxOxygenSaturationBaseline, '%') },
    { name: 'Avg breathing rate', value: show(s.avgBreathRate), unit: 'per min', verdict: personal(s.avgBreathRate, s.minBreathRateBaseline, s.maxBreathRateBaseline), ref: pr(s.minBreathRateBaseline, s.maxBreathRateBaseline, '') },
  ];
}

// ---------- charts (SVG) ----------

function hypnogram(n: D2Night): SVGSVGElement {
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
  const max = Math.max(3, ...nights.map((x) => x.summary.wakeCount ?? 0));
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'd2-bars', role: 'img', 'aria-label': 'Times woke up, recent nights' });
  root.appendChild(svg('line', { x1: 0, x2: W, y1: H - 2, y2: H - 2, class: 'd2-row' }));
  nights.forEach((night, k) => {
    const v = night.summary.wakeCount;
    const cx = n === 1 ? W / 2 : 8 + (k * (W - 16)) / (n - 1);
    const h = v == null ? 0 : Math.max(4, ((H - 10) * v) / max);
    root.appendChild(svg('rect', { x: cx - bw / 2, y: H - 2 - h, width: bw, height: h, rx: 4, class: v != null && v > 1 ? 'd2-bar-high' : 'd2-bar-ok' },
      `${dayLabel(figures(night).wokeMs)}: ${v ?? '--'} times`));
  });
  return root;
}

// ---------- the screen ----------

export function mount(root: HTMLElement, deps: D2Deps): { refresh: () => void } {
  store.useAccount(deps.account);
  root.replaceChildren();
  const home = el('div', 'd2-home'), report = el('div', 'd2-report');
  report.hidden = true;
  root.append(home, report);

  // header and connection card
  const title = el('h2', '', 'D2 Link ');
  const userTag = el('span', 'muted');
  title.appendChild(userTag);
  const card = el('div', 'card');
  const status = el('div', 'status');
  const dot = el('span', 'dot'), statusText = el('span', '', 'Not connected');
  status.append(dot, statusText);
  const noSerial = el('p', 'd2-warn', 'This browser can’t reach the watch. Use Chrome on an Android phone (including Huawei phones) or on a computer; Safari, Firefox and iPhones can’t connect to a Huawei Watch D2.');
  noSerial.hidden = serialAvailable();
  const btnGo = button('Pair & download sleep', 'primary big');
  const btnSystem = button('Use the computer’s serial port');
  btnSystem.title = 'If Chrome can’t open the watch: choose the port the computer made for it (on a Mac “cu.HUAWEIWATCHD2-…”)';
  const btnDemo = button('Demo nights');
  const btnForget = button('Forget pairing');
  const days = el('select');
  for (const [v, t] of [[1, 'Last night'], [3, 'Last 3 days'], [7, 'Last 7 days'], [14, 'Last 14 days'], [30, 'Last 30 days']] as const) {
    const o = el('option', '', t); o.value = String(v); if (v === 7) o.selected = true; days.appendChild(o);
  }
  const daysLabel = el('label', 'd2-days', 'Download ');
  daysLabel.appendChild(days);
  const actions = el('div', 'row wrap');
  actions.append(btnGo, daysLabel, btnSystem, btnDemo, btnForget);
  const progress = el('p', 'note');
  const logBox = el('details', 'd2-log');
  logBox.appendChild(el('summary', '', 'Connection log'));
  const logPre = el('pre', 'log');
  logBox.appendChild(logPre);
  card.append(status, noSerial, actions, progress, logBox);

  const help = el('details', 'card d2-help');
  help.appendChild(el('summary', '', 'Before you start (first time)'));
  const steps = el('ol');
  for (const s of [
    'Use Chrome on an Android phone (Huawei phones work) or on a computer. Safari, Firefox and iPhones can’t reach the watch. On a Mac the watch may not answer (seen with macOS): use the phone instead.',
    'Make sure the watch is not connected to Huawei Health while you do this (disconnect it there, or use a phone without Huawei Health).',
    'Pair the watch in the phone’s or computer’s Bluetooth settings first (“HUAWEI WATCH D2-…”).',
    'Click “Pair & download sleep” and choose the watch in Chrome’s list. The first time, confirm the pairing on the watch if it asks.',
    'Afterwards, Huawei Health may need to reconnect to the watch.',
  ]) steps.appendChild(el('li', '', s));
  help.appendChild(steps);
  help.appendChild(el('p', 'note', 'D2 Link is experimental: it is built from Gadgetbridge’s open-source description of the Huawei protocol and has not yet been tested with every Watch D2 firmware. It reads sleep only; ECG and blood pressure stay on the watch. If the watch refuses, the connection log shows where it stopped.'));

  const listHead = el('h3', '', 'Nights from the watch');
  const list = el('ul', 'sessions');
  const empty = el('p', 'muted', 'No nights yet. Download from the watch, or try the demo nights.');
  home.append(title, card, help, listHead, empty, list);

  const log = (line: string): void => {
    logPre.textContent += `${clock(Date.now())} ${line}\n`;
    logPre.scrollTop = logPre.scrollHeight;
  };
  const setStatus = (text: string, state: '' | 'on' | 'busy'): void => { statusText.textContent = text; dot.className = `dot ${state}`; };
  const syncButtons = (busy = false): void => {
    const paired = store.loadPairing() != null;
    btnGo.textContent = paired ? 'Download sleep' : 'Pair & download sleep';
    btnGo.disabled = busy || !serialAvailable();
    btnSystem.disabled = busy || !serialAvailable();
    btnForget.hidden = !paired;
    btnForget.disabled = busy;
    btnDemo.disabled = busy;
    help.open = !paired;
  };

  let nights: D2Night[] = [];
  async function renderList(): Promise<void> {
    userTag.textContent = `· ${deps.userLabel()}`;
    nights = await store.listNights(deps.user());
    empty.hidden = nights.length > 0;
    list.replaceChildren(...nights.map((n) => {
      const f = figures(n);
      const li = el('li');
      const left = el('div');
      left.append(el('div', 'when', `Night of ${dayLabel(f.wokeMs)}`), el('div', 'stats', `${clock(f.bedMs)}–${clock(f.wokeMs)} · ${n.summary.sleepScore != null ? `${n.summary.sleepScore} points` : 'no score'}${n.source === 'demo' ? ' · demo' : ''}`));
      li.append(left, el('div', 'dur', f.sleepMin ? hm(f.sleepMin) : '--'));
      li.addEventListener('click', () => openReport(n.id));
      return li;
    }));
  }

  // ---------- download ----------
  const download = (mode: 'bluetooth' | 'system'): void => void (async () => {
    syncButtons(true);
    progress.textContent = '';
    setStatus('Choose the watch in Chrome’s list…', 'busy');
    let link: D2Link | null = null;
    try {
      const t = await openWatch(mode, log);
      log(mode === 'bluetooth' ? 'Connected to the watch’s Bluetooth serial service.' : 'Serial port opened.');
      setStatus('Connected – logging in…', 'busy');
      link = new D2Link(t, log);
      const kept = await link.connect(store.loadPairing());
      store.savePairing(kept);
      const name = link.info?.name || link.info?.model || 'Huawei Watch D2';
      setStatus(`${name}${link.info?.battery != null ? ` · battery ${link.info.battery}%` : ''} – downloading…`, 'on');
      const end = Math.floor(Date.now() / 1000), start = end - Number(days.value) * 86400;
      const file = await link.downloadSleep(start, end, (d, total) => { progress.textContent = `Downloading… ${Math.round((100 * d) / total)}%`; });
      const got = parseSleepFile(file).map((d) => store.nightFromData(d, deps.user(), name));
      await store.saveNights(got);
      log(`${got.length} night${got.length === 1 ? '' : 's'} saved.`);
      progress.textContent = got.length ? `${got.length} night${got.length === 1 ? '' : 's'} downloaded.` : 'The watch has no sleep records for this period.';
      setStatus(`${name} – done`, 'on');
      await renderList();
      const latest = got.sort((a, b) => b.start - a.start)[0];
      if (latest) openReport(latest.id);
    } catch (e) {
      const msg = e instanceof DOMException && e.name === 'NotFoundError' ? 'No watch was chosen.' : e instanceof Error ? e.message : String(e);
      log(`Stopped: ${msg}`);
      setStatus(msg, '');
      progress.textContent = e instanceof DOMException && e.name === 'NotFoundError'
        ? 'If the watch isn’t in the list, pair it in the computer’s Bluetooth settings first (see “Before you start”).'
        : mode === 'system' && e instanceof WatchError && /first message/.test(msg)
          ? 'The port opened but the watch didn’t answer on it: it is probably not the watch’s Huawei data channel.'
          : '';
    } finally {
      await link?.close();
      syncButtons(false);
    }
  })();
  btnGo.addEventListener('click', () => download('bluetooth'));
  btnSystem.addEventListener('click', () => download('system'));

  btnForget.addEventListener('click', () => {
    if (!window.confirm('Forget the pairing with the watch? Next time you will pair again (and may need to confirm on the watch). Downloaded nights are kept.')) return;
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

  // ---------- report ----------
  function openReport(id: string): void {
    const i = nights.findIndex((n) => n.id === id);
    const n = nights[i];
    if (!n) return;
    renderReport(report, n, nights, {
      back: () => { report.hidden = true; home.hidden = false; window.scrollTo(0, 0); },
      older: nights[i + 1] ? () => openReport(nights[i + 1]!.id) : null,
      newer: i > 0 ? () => openReport(nights[i - 1]!.id) : null,
      remove: async () => {
        if (!window.confirm('Delete this night from this device?')) return;
        await store.deleteNight(n.id);
        await renderList();
        report.hidden = true; home.hidden = false;
      },
    });
    home.hidden = true;
    report.hidden = false;
    window.scrollTo(0, 0);
  }

  syncButtons();
  void renderList();
  return { refresh: () => { report.hidden = true; home.hidden = false; void renderList(); } };
}

interface ReportActions { back: () => void; older: (() => void) | null; newer: (() => void) | null; remove: () => Promise<void> }

function renderReport(box: HTMLElement, n: D2Night, all: D2Night[], act: ReportActions): void {
  box.replaceChildren();
  const f = figures(n), s = n.summary;

  const bar = el('div', 'row between wrap');
  const back = button('← Nights');
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
  right.append(json, del);
  bar.append(back, right);

  // date and night sleep with the stage chart (Huawei's first screen)
  const top = el('div', 'card d2-night');
  const nav = el('div', 'd2-datenav');
  const prev = button('‹', 'd2-nav'), next = button('›', 'd2-nav');
  prev.setAttribute('aria-label', 'Previous night'); next.setAttribute('aria-label', 'Next night');
  prev.disabled = !act.older; next.disabled = !act.newer;
  prev.addEventListener('click', () => act.older?.());
  next.addEventListener('click', () => act.newer?.());
  nav.append(prev, el('span', 'd2-date', dayLabel(f.wokeMs)), next);
  const big = el('div', 'd2-big');
  big.append(el('div', 'muted', 'Night sleep'), el('div', 'd2-big-value', f.sleepMin ? hm(f.sleepMin) : '--'));
  const times = el('div', 'row between d2-times');
  const bedT = el('div'); bedT.append(el('div', 'muted', shortDate(f.bedMs)), el('div', '', `Bed time ${clock(f.bedMs)}`));
  const wokeT = el('div', 'd2-right'); wokeT.append(el('div', 'muted', shortDate(f.wokeMs)), el('div', '', `Woke up ${clock(f.wokeMs)}`));
  times.append(bedT, wokeT);
  const legend = el('div', 'legend d2-legend');
  for (const code of [3, 1, 2, 4]) {
    const it = el('span'); const sw = el('i'); sw.style.background = STAGE_VAR[code] ?? ''; it.append(sw, document.createTextNode(STAGE_NAME[code] ?? '')); legend.appendChild(it);
  }
  top.append(nav, big, hypnogram(n), times, legend);
  if (n.source === 'demo') top.appendChild(el('p', 'note', 'Demo night (made-up data) to show the report layout.'));

  // score, recent awakenings and the stage donut (Huawei's second screen)
  const scoreCard = el('div', 'card d2-score');
  const score = el('div', 'd2-score-main');
  const pts = el('div', 'd2-points');
  pts.append(document.createTextNode(s.sleepScore != null ? String(s.sleepScore) : '--'), el('small', '', ' points'));
  score.append(pts, stars(s.sleepScore), el('div', 'muted', 'Sleep score from the watch'));
  const recent = all.filter((x) => x.start <= n.start).slice(0, 7).reverse();
  const wake = el('div', 'd2-wake');
  const wakeHead = el('div', 'row between');
  const first = recent[0], last = recent[recent.length - 1];
  wakeHead.append(el('span', '', `Times woke up${first && last ? ` (${shortDate(figures(first).wokeMs)}–${shortDate(figures(last).wokeMs)})` : ''}`), el('span', s.wakeCount != null && s.wakeCount > 1 ? 'd2-high' : 'd2-normal', `${s.wakeCount ?? '--'} times`));
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
    `All results are calculated by the watch (${n.watch}) and downloaded as they are; D2 Link doesn’t recalculate them.`,
    'References are the ones Huawei Health shows for sleep. “Personal range” comes from the watch’s own baseline of your recent nights; until it has enough nights it isn’t set.',
    '* “Breathing quality” is the watch value Gadgetbridge calls “sleep data quality”; its exact meaning isn’t published.',
    'Not a medical device. Sleep stages from a wrist watch are estimates.',
  ]) ul.appendChild(el('li', '', line));
  notes.appendChild(ul);

  box.append(bar, top, scoreCard, grid, notes);
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
