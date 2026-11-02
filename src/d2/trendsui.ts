// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — the Week and Month views: averages, night sleep per day (deep/light/REM), and trends for score,
// deep sleep, heart rate and HRV; the Month view adds weekly averages.
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

import { button, el, hm, svg } from './dom';
import type { D2Night } from './store';
import { averages, dateOf, dayPoints, daysFrom, monthDays, weekStart, weeksOfMonth, type DayPoint } from './trends';

export type Period = 'week' | 'month';

const clockOf = (min: number | null): string => (min == null ? '--' : `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(Math.round(min % 60) % 60).padStart(2, '0')}`);
const r0 = (v: number | null): string => (v == null ? '--' : String(Math.round(v)));
const dayShort = (key: string): string => dateOf(key).toLocaleDateString([], { weekday: 'short', day: 'numeric' });
const dayLong = (key: string): string => dateOf(key).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

const W = 600, PAD_L = 36, PAD_R = 8, PAD_T = 10, PAD_B = 22;

function xScale(n: number): (i: number) => number {
  const inner = W - PAD_L - PAD_R;
  return (i) => PAD_L + ((i + 0.5) * inner) / n;
}

function xLabels(root: SVGSVGElement, days: string[], x: (i: number) => number, H: number): void {
  days.forEach((k, i) => {
    const d = dateOf(k);
    const show = days.length <= 7 || d.getDate() === 1 || d.getDate() % 5 === 0;
    if (!show) return;
    const label = days.length <= 7 ? d.toLocaleDateString([], { weekday: 'short' }) : String(d.getDate());
    const t = svg('text', { x: x(i), y: H - 6, 'text-anchor': 'middle', class: 'd2-axis' });
    t.textContent = label;
    root.appendChild(t);
  });
}

function yGrid(root: SVGSVGElement, ticks: number[], y: (v: number) => number, fmt: (v: number) => string): void {
  for (const v of ticks) {
    root.appendChild(svg('line', { x1: PAD_L, x2: W - PAD_R, y1: y(v), y2: y(v), class: 'd2-row' }));
    const t = svg('text', { x: PAD_L - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'd2-axis' });
    t.textContent = fmt(v);
    root.appendChild(t);
  }
}

/** Night sleep per day, stacked deep (bottom) / light / REM, in hours. */
function sleepBars(days: string[], pts: Map<string, DayPoint>, open: (day: string) => void): SVGSVGElement {
  const H = 190;
  const maxH = Math.max(8, Math.ceil(Math.max(0, ...days.map((k) => (pts.get(k)?.sleepMin ?? 0) / 60))));
  const y = (h: number): number => PAD_T + (H - PAD_T - PAD_B) * (1 - h / maxH);
  const x = xScale(days.length);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'd2-trend', role: 'img', 'aria-label': 'Night sleep per day: deep, light and REM sleep' });
  const ticks = Array.from({ length: Math.floor(maxH / 2) + 1 }, (_, i) => i * 2);
  yGrid(root, ticks, y, (v) => `${v} h`);
  const bw = Math.min(26, ((W - PAD_L - PAD_R) / days.length) * 0.6);
  days.forEach((k, i) => {
    const p = pts.get(k);
    if (!p) return;
    const g = svg('g', { class: 'd2-hit' }, `${dayLong(k)}: night sleep ${hm(p.sleepMin)} · deep ${hm(p.deepMin)} · light ${hm(p.lightMin)} · REM ${hm(p.remMin)}${p.score != null ? ` · ${p.score} points` : ''}`);
    g.addEventListener('click', () => open(k));
    let base = 0;
    const segs: [number, string][] = [[p.deepMin, 'var(--stage-deep)'], [p.lightMin, 'var(--stage-light)'], [p.remMin, 'var(--stage-rem)']];
    segs.forEach(([min, color], si) => {
      if (min <= 0) return;
      const h0 = base / 60, h1 = (base + min) / 60;
      const top = y(h1), bottom = y(h0) - (si > 0 ? 2 : 0); // 2px gap between segments
      g.appendChild(svg('rect', { x: x(i) - bw / 2, y: top, width: bw, height: Math.max(1, bottom - top), rx: 2, fill: color }));
      base += min;
    });
    // a wider invisible target for hover and tap
    g.appendChild(svg('rect', { x: x(i) - bw / 2 - 4, y: PAD_T, width: bw + 8, height: H - PAD_T - PAD_B, fill: 'transparent' }));
    root.appendChild(g);
  });
  xLabels(root, days, x, H);
  return root;
}

/** One measure per day as a line with dots; gaps where there is no night. */
function lineChart(days: string[], pts: Map<string, DayPoint>, value: (p: DayPoint) => number | null, label: string, unit: string): SVGSVGElement {
  const H = 130;
  const vals = days.map((k) => { const p = pts.get(k); return p ? value(p) : null; });
  const have = vals.filter((v): v is number => v != null);
  const lo0 = have.length ? Math.min(...have) : 0, hi0 = have.length ? Math.max(...have) : 1;
  const span = Math.max(4, hi0 - lo0);
  const step = span > 40 ? 20 : span > 16 ? 10 : span > 8 ? 4 : 2;
  const lo = Math.floor((lo0 - span * 0.15) / step) * step, hi = Math.ceil((hi0 + span * 0.15) / step) * step;
  const y = (v: number): number => PAD_T + (H - PAD_T - PAD_B) * (1 - (v - lo) / (hi - lo || 1));
  const x = xScale(days.length);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'd2-trend', role: 'img', 'aria-label': `${label} per day` });
  const ticks: number[] = [];
  for (let v = lo; v <= hi; v += step) ticks.push(v);
  yGrid(root, ticks.length > 4 ? ticks.filter((_, i) => i % 2 === 0) : ticks, y, (v) => String(v));
  let path = '';
  vals.forEach((v, i) => { if (v == null) return; path += `${path && vals[i - 1] != null ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; });
  if (path) root.appendChild(svg('path', { d: path, class: 'd2-line' }));
  vals.forEach((v, i) => {
    if (v == null) return;
    const k = days[i] ?? '';
    root.appendChild(svg('circle', { cx: x(i), cy: y(v), r: 4, class: 'd2-dot' }, `${dayLong(k)}: ${label.toLowerCase()} ${Math.round(v)}${unit}`));
  });
  xLabels(root, days, x, H);
  return root;
}

export interface TrendsNav { prev: () => void; next: () => void; open: (day: string) => void }

export function renderTrends(box: HTMLElement, nights: readonly D2Night[], period: Period, anchor: Date, nav: TrendsNav): void {
  box.replaceChildren();
  const pts = dayPoints(nights);
  const days = period === 'week' ? daysFrom(weekStart(anchor), 7) : monthDays(anchor.getFullYear(), anchor.getMonth());
  const first = days[0] ?? '', last = days[days.length - 1] ?? '';
  const inPeriod = days.flatMap((k) => { const p = pts.get(k); return p ? [p] : []; });

  const head = el('div', 'd2-datenav');
  const prev = button('‹', 'd2-nav'), next = button('›', 'd2-nav');
  prev.setAttribute('aria-label', period === 'week' ? 'Previous week' : 'Previous month');
  next.setAttribute('aria-label', period === 'week' ? 'Next week' : 'Next month');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  next.disabled = dateOf(last) >= today; // nothing to show after today
  prev.addEventListener('click', nav.prev);
  next.addEventListener('click', nav.next);
  const title = period === 'week'
    ? `${dateOf(first).toLocaleDateString([], { day: 'numeric', month: 'short' })} – ${dateOf(last).toLocaleDateString([], { day: 'numeric', month: 'short' })}`
    : dateOf(first).toLocaleDateString([], { month: 'long', year: 'numeric' });
  head.append(prev, el('span', 'd2-date', title), next);
  box.appendChild(head);

  if (!inPeriod.length) {
    box.appendChild(el('p', 'muted d2-center', `No nights in this ${period}.`));
    return;
  }

  // averages, like a week/month summary
  const a = averages(inPeriod);
  const tiles = el('div', 'd2-tiles d2-avg');
  const tile = (name: string, value: string, unit: string, sub = ''): void => {
    const t = el('div', 'd2-tile');
    const v = el('div', 'd2-tile-value');
    v.append(document.createTextNode(value), el('small', '', unit ? ` ${unit}` : ''));
    t.append(el('div', 'd2-tile-name', name), v);
    if (sub) t.appendChild(el('div', 'd2-tile-ref', sub));
    tiles.appendChild(t);
  };
  tile('Avg sleep score', r0(a.score), 'points', `${a.nights} night${a.nights === 1 ? '' : 's'}`);
  tile('Avg night sleep', a.sleepMin == null ? '--' : hm(a.sleepMin).replace(' min', ''), 'min', `Bed ${clockOf(a.bedClock)} · woke ${clockOf(a.wokeClock)}`);
  tile('Avg deep sleep', r0(a.deepPct), '%');
  tile('Avg heart rate', r0(a.hr), 'bpm');
  tile('Avg HRV', r0(a.hrv), 'ms');
  box.appendChild(tiles);

  const chart = (titleText: string, svgEl: SVGSVGElement, legend?: [string, string][]): void => {
    const c = el('div', 'card d2-chart');
    c.appendChild(el('h3', '', titleText));
    if (legend) {
      const lg = el('div', 'legend');
      for (const [name, color] of legend) { const it = el('span'); const sw = el('i'); sw.className = 'd2-swatch'; sw.style.background = color; it.append(sw, document.createTextNode(name)); lg.appendChild(it); }
      c.appendChild(lg);
    }
    c.appendChild(svgEl);
    box.appendChild(c);
  };
  chart('Night sleep', sleepBars(days, pts, nav.open), [['Deep sleep', 'var(--stage-deep)'], ['Light sleep', 'var(--stage-light)'], ['REM sleep', 'var(--stage-rem)']]);
  chart(`Sleep score · avg ${r0(a.score)}`, lineChart(days, pts, (p) => p.score, 'Sleep score', ' points'));
  chart(`Deep sleep · avg ${r0(a.deepPct)}%`, lineChart(days, pts, (p) => p.deepPct, 'Deep sleep', '%'));
  chart(`Avg heart rate · avg ${r0(a.hr)} bpm`, lineChart(days, pts, (p) => p.hr, 'Heart rate', ' bpm'));
  chart(`Avg HRV · avg ${r0(a.hrv)} ms`, lineChart(days, pts, (p) => p.hrv, 'HRV', ' ms'));

  if (period === 'month') {
    const c = el('div', 'card');
    c.appendChild(el('h3', '', 'Weekly averages'));
    const table = el('table', 'd2-table');
    const headRow = el('tr');
    for (const h of ['Week', 'Nights', 'Score', 'Night sleep', 'Deep', 'Heart rate', 'HRV']) headRow.appendChild(el('th', '', h));
    table.appendChild(el('thead')).appendChild(headRow);
    const body = el('tbody');
    for (const week of weeksOfMonth(anchor.getFullYear(), anchor.getMonth())) {
      const wp = week.flatMap((k) => { const p = pts.get(k); return p ? [p] : []; });
      const w = averages(wp);
      const tr = el('tr');
      const range = `${dateOf(week[0] ?? '').getDate()}–${dateOf(week[week.length - 1] ?? '').getDate()}`;
      for (const v of [range, String(w.nights), r0(w.score), w.sleepMin == null ? '--' : hm(w.sleepMin), w.deepPct == null ? '--' : `${r0(w.deepPct)}%`, w.hr == null ? '--' : `${r0(w.hr)} bpm`, w.hrv == null ? '--' : `${r0(w.hrv)} ms`]) tr.appendChild(el('td', '', v));
      body.appendChild(tr);
    }
    table.appendChild(body);
    const wrap = el('div', 'd2-table-wrap');
    wrap.appendChild(table);
    c.appendChild(wrap);
    box.appendChild(c);
  }
  box.appendChild(el('p', 'note', `Tap a day's bar to open that night. Naps are not included. Days without a night sleep are left empty. ${dayShort(first)}–${dayShort(last)}.`));
}
