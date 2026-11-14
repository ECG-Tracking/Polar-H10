// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — the "Graphs" view: everything downloaded from the watch (sleep, activity, heart rate, SpO₂, blood pressure,
// HRV, stress, emotion, workouts) over a chosen period, from 1 day to all.
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

import { el, hm, svg } from './dom';
import type { ActivityMinute } from './extra';
import { figures, isNap } from './night';
import { minutesOf } from './records';
import type { D2Night, D2Record } from './store';

export type Range = '1d' | '7d' | '1m' | '3m' | '6m' | '9m' | '1y' | '3y' | '5y' | 'all' | 'custom';
export const RANGES: readonly (readonly [Range, string])[] = [
  ['1d', '1 day'], ['7d', '7 days'], ['1m', '1 month'], ['3m', '3 months'], ['6m', '6 months'], ['9m', '9 months'],
  ['1y', '1 year'], ['3y', '3 years'], ['5y', '5 years'], ['all', 'All'], ['custom', 'Custom'],
];

/** Chosen dates (YYYY-MM-DD) for the custom period. */
export interface CustomDates { from: string; to: string }

/** The custom period in ms: from the start of `from` to the end of `to` (not after now); the last 7 days where a date is missing. */
export function customSpan(d: CustomDates, now: number): [number, number] {
  const day = (s: string, end: boolean): number => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + (end ? 1 : 0)).getTime() - (end ? 1 : 0) : NaN;
  };
  const to = Math.min(now, Number.isFinite(day(d.to, true)) ? day(d.to, true) : now);
  const from = Number.isFinite(day(d.from, false)) ? day(d.from, false) : to - 7 * DAY;
  return from < to ? [from, to] : [to - DAY, to];
}

const DAY = 86400000;
type Mode = 'raw' | 'hour' | 'day' | 'week';

/** Start of the period ending `now` (for "all": the earliest data, or 7 days if there is none). */
export function rangeStart(range: Range, now: number, earliest: number | null): number {
  const d = new Date(now);
  const back = (months: number): number => new Date(d.getFullYear(), d.getMonth() - months, d.getDate(), d.getHours(), d.getMinutes()).getTime();
  switch (range) {
    case '1d': return now - DAY;
    case '7d': return now - 7 * DAY;
    case '1m': return back(1);
    case '3m': return back(3);
    case '6m': return back(6);
    case '9m': return back(9);
    case '1y': return back(12);
    case '3y': return back(36);
    case '5y': return back(60);
    default: return earliest != null && earliest < now ? earliest : now - 7 * DAY;
  }
}

/** How finely to show the period: single readings for up to 2 days, then days, then weeks beyond 13 months. */
export const modeFor = (from: number, to: number): Mode => (to - from <= 2 * DAY ? 'raw' : to - from <= 400 * DAY ? 'day' : 'week');

export function bucketStart(t: number, mode: Mode): number {
  const d = new Date(t);
  if (mode === 'raw') return t;
  if (mode === 'hour') return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (mode === 'day') return day.getTime();
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - ((day.getDay() + 6) % 7)).getTime(); // Monday
}
const bucketWidth = (mode: Mode): number => (mode === 'hour' ? 3600000 : mode === 'day' ? DAY : mode === 'week' ? 7 * DAY : 0);

export interface Pt { t: number; v: number; lo?: number; hi?: number; n?: number }

/** Values per bucket: the mean (with the lowest and highest), or the sum. Each point sits in the middle of its bucket. */
export function aggregate(points: readonly { t: number; v: number }[], mode: Mode, how: 'mean' | 'sum'): Pt[] {
  if (mode === 'raw') return [...points].sort((a, b) => a.t - b.t);
  const by = new Map<number, number[]>();
  for (const p of points) {
    const k = bucketStart(p.t, mode);
    const list = by.get(k);
    if (list) list.push(p.v); else by.set(k, [p.v]);
  }
  return [...by].sort((a, b) => a[0] - b[0]).map(([k, vs]) => {
    const sum = vs.reduce((s, x) => s + x, 0);
    return { t: k + bucketWidth(mode) / 2, v: how === 'sum' ? sum : sum / vs.length, lo: Math.min(...vs), hi: Math.max(...vs), n: vs.length };
  });
}

// ---------- drawing ----------

const W = 640, H = 200, L = 58, R = 10, T = 10, B = 24;

interface Series { name: string; color: string; points: Pt[]; kind: 'line' | 'dots' | 'bars'; band?: boolean; stack?: Pt[][]; stackColors?: string[]; stackNames?: string[] }

function niceTicks(lo: number, hi: number): number[] {
  const span = hi - lo || 1;
  const raw = span / 4, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

function timeTicks(from: number, to: number): { t: number; label: string }[] {
  const span = to - from, out: { t: number; label: string }[] = [];
  const d = new Date(from);
  if (span <= 2 * DAY) {
    const step = span <= DAY ? 3 : 6;
    for (let t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime(); t <= to; t += 3600000) {
      const h = new Date(t).getHours();
      if (h % step === 0) out.push({ t, label: h === 0 ? new Date(t).toLocaleDateString([], { weekday: 'short' }) : `${String(h).padStart(2, '0')}:00` });
    }
  } else if (span <= 40 * DAY) {
    const every = span <= 8 * DAY ? 1 : 5;
    for (let t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(); t + DAY / 2 <= to; t += DAY) {
      const x = new Date(t);
      if (span <= 8 * DAY || x.getDate() === 1 || x.getDate() % every === 0) out.push({ t: t + DAY / 2, label: span <= 8 * DAY ? x.toLocaleDateString([], { weekday: 'short' }) : String(x.getDate()) });
    }
  } else if (span <= 3 * 366 * DAY) {
    const every = span <= 200 * DAY ? 1 : span <= 400 * DAY ? 2 : 6;
    for (let m = new Date(d.getFullYear(), d.getMonth() + 1, 1); m.getTime() <= to; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
      if (m.getMonth() % every === 0) out.push({ t: m.getTime(), label: m.getMonth() === 0 ? String(m.getFullYear()) : m.toLocaleDateString([], { month: 'short' }) });
    }
  } else {
    for (let y = new Date(d.getFullYear() + 1, 0, 1); y.getTime() <= to; y = new Date(y.getFullYear() + 1, 0, 1)) out.push({ t: y.getTime(), label: String(y.getFullYear()) });
  }
  return out;
}

const fmtTime = (t: number, mode: Mode): string => {
  const d = new Date(t);
  if (mode === 'raw' || mode === 'hour') return d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  if (mode === 'day') return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  return `Week of ${new Date(t - 3.5 * DAY).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}`;
};

function chart(from: number, to: number, mode: Mode, series: Series[], unit: string, fmt: (v: number) => string, zero = false): SVGSVGElement {
  const all = series.flatMap((s) => (s.stack ? s.stack.flat() : s.points).flatMap((p) => [p.v, p.lo ?? p.v, p.hi ?? p.v]));
  const stackTotals = series.flatMap((s) => (s.stack ? s.stack[0]!.map((_, i) => s.stack!.reduce((sum, layer) => sum + (layer[i]?.v ?? 0), 0)) : []));
  let lo = Math.min(...all, ...stackTotals), hi = Math.max(...all, ...stackTotals);
  if (zero || series.some((s) => s.kind === 'bars')) lo = Math.min(0, lo);
  if (hi === lo) { hi += 1; lo -= zero ? 0 : 1; }
  const pad = (hi - lo) * 0.08;
  if (!(zero || series.some((s) => s.kind === 'bars'))) lo -= pad;
  hi += pad;
  const x = (t: number): number => L + ((t - from) / (to - from || 1)) * (W - L - R);
  const y = (v: number): number => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'd2-trend d2-graph', role: 'img', 'aria-label': series.map((s) => s.name).join(', ') });
  for (const v of niceTicks(lo, hi)) {
    root.appendChild(svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'd2-row' }));
    const t = svg('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'd2-axis' });
    t.textContent = fmt(v);
    root.appendChild(t);
  }
  for (const tick of timeTicks(from, to)) {
    const t = svg('text', { x: x(tick.t), y: H - 6, 'text-anchor': 'middle', class: 'd2-axis' });
    t.textContent = tick.label;
    root.appendChild(t);
  }
  const bw = Math.max(2, Math.min(28, (bucketWidth(mode === 'raw' ? 'hour' : mode) / (to - from)) * (W - L - R) * 0.7));
  for (const s of series) {
    const tip = (p: Pt, name = s.name): string => `${fmtTime(p.t, mode)}: ${name} ${fmt(p.v)}${unit}${p.lo != null && p.hi != null && p.n && p.n > 1 && s.kind !== 'bars' ? ` (${fmt(p.lo)}–${fmt(p.hi)})` : ''}`;
    if (s.stack) { // stacked bars (sleep stages)
      s.stack[0]!.forEach((p0, i) => {
        let base = 0;
        const g = svg('g', { class: 'd2-hit' }, `${fmtTime(p0.t, mode)}: ${s.stack!.map((layer, j) => `${s.stackNames?.[j] ?? ''} ${fmt(layer[i]?.v ?? 0)}${unit}`).join(' · ')}`);
        s.stack!.forEach((layer, j) => {
          const v = layer[i]?.v ?? 0;
          if (v <= 0) return;
          g.appendChild(svg('rect', { x: x(p0.t) - bw / 2, y: y(base + v), width: bw, height: Math.max(1, y(base) - y(base + v)), rx: 2, fill: s.stackColors?.[j] ?? s.color }));
          base += v;
        });
        root.appendChild(g);
      });
      continue;
    }
    if (s.kind === 'bars') {
      for (const p of s.points) {
        const h = Math.max(1, y(0) - y(p.v));
        root.appendChild(svg('rect', { x: x(p.t) - bw / 2, y: y(0) - h, width: bw, height: h, rx: 2, fill: s.color, class: 'd2-hit' }, tip(p)));
      }
      continue;
    }
    if (s.band && s.points.some((p) => p.lo != null && p.hi != null && p.hi > p.lo)) {
      const top = s.points.map((p) => `${x(p.t).toFixed(1)},${y(p.hi ?? p.v).toFixed(1)}`), bottom = s.points.map((p) => `${x(p.t).toFixed(1)},${y(p.lo ?? p.v).toFixed(1)}`).reverse();
      root.appendChild(svg('polygon', { points: [...top, ...bottom].join(' '), fill: s.color, opacity: 0.15 }));
    }
    if (s.kind === 'line' && s.points.length > 1) {
      // break the line where data is missing for more than three buckets
      const gap = Math.max(bucketWidth(mode === 'raw' ? 'hour' : mode) * 3, mode === 'raw' ? 3 * 3600000 : 0);
      let d = '';
      s.points.forEach((p, i) => { d += `${i && p.t - s.points[i - 1]!.t <= gap ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`; });
      root.appendChild(svg('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    }
    const many = s.points.length > 150;
    for (const p of s.points) {
      if (s.kind === 'line' && many) continue; // too many to mark each one; the line carries them
      root.appendChild(svg('circle', { cx: x(p.t), cy: y(p.v), r: s.kind === 'dots' ? (many ? 2.5 : 4) : 3.5, fill: s.color, stroke: 'var(--surface)', 'stroke-width': many ? 0 : 1.5, class: 'd2-hit' }, tip(p)));
    }
  }
  return root;
}

function card(title: string, summary: string, legend: { name: string; color: string }[], body: SVGSVGElement): HTMLElement {
  const c = el('section', 'card d2-data d2-graphcard');
  const head = el('div', 'row between wrap');
  head.append(el('h3', '', title), el('span', 'note', summary));
  c.appendChild(head);
  if (legend.length > 1) {
    const lg = el('div', 'row wrap d2-graph-legend');
    for (const s of legend) { const i = el('span'); const dot = el('i'); dot.style.background = s.color; i.append(dot, s.name); lg.appendChild(i); }
    c.appendChild(lg);
  }
  c.appendChild(body);
  return c;
}

const r0 = (v: number): string => String(Math.round(v));
const r1 = (v: number): string => (Math.abs(v) >= 100 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toString());
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

// ---------- the view ----------

const COLORS = { blue: 'var(--series-1)', red: 'var(--accent)', green: 'var(--good)', amber: 'var(--warn)', deep: 'var(--stage-deep)', light: 'var(--stage-light)', rem: 'var(--stage-rem)' };

export function renderGraphs(box: HTMLElement, nights: readonly D2Night[], records: readonly D2Record[], range: Range, onRange: (r: Range, dates?: CustomDates) => void, now = Date.now(), dates: CustomDates = { from: '', to: '' }): void {
  box.replaceChildren();
  const pick = el('label', 'd2-days', 'Show ');
  const sel = el('select');
  for (const [v, t] of RANGES) { const o = el('option', '', t); o.value = v; if (v === range) o.selected = true; sel.appendChild(o); }
  // custom: a start and an end date
  const dateIn = (v: string, name: string): HTMLInputElement => { const i = el('input'); i.type = 'date'; i.value = v; i.setAttribute('aria-label', name); return i; };
  const fromIn = dateIn(dates.from, 'From'), toIn = dateIn(dates.to, 'To');
  const customRow = el('span', 'row wrap');
  customRow.append(' From ', fromIn, ' to ', toIn);
  customRow.hidden = range !== 'custom';
  sel.addEventListener('change', () => onRange(sel.value as Range, { from: fromIn.value, to: toIn.value }));
  for (const i of [fromIn, toIn]) i.addEventListener('change', () => onRange('custom', { from: fromIn.value, to: toIn.value }));
  pick.appendChild(sel);
  const top = el('div', 'row wrap');
  top.append(pick, customRow);
  box.appendChild(top);

  const sleeps = nights.filter((n) => !isNap(n));
  const times = [...sleeps.map((n) => n.start), ...records.map((r) => r.start)].filter((t) => t > 0);
  const [from, to] = range === 'custom' ? customSpan(dates, now) : [rangeStart(range, now, times.length ? Math.min(...times) : null), now];
  const mode = modeFor(from, to), sumMode: Mode = mode === 'raw' ? 'hour' : mode;
  const inRange = (t: number): boolean => t >= from && t <= to;
  const cards: HTMLElement[] = [];
  const add = (title: string, summary: string, series: Series[], unit: string, fmt: (v: number) => string, zero = false): void => {
    if (!series.some((s) => (s.stack ? s.stack[0]!.length : s.points.length))) return;
    cards.push(card(title, summary, series.flatMap((s) => (s.stack ? s.stack.map((_, j) => ({ name: s.stackNames?.[j] ?? '', color: s.stackColors?.[j] ?? s.color })) : [{ name: s.name, color: s.color }])), chart(from, to, mode, series, unit, fmt, zero)));
  };
  const avgText = (pts: { v: number }[], fmt: (v: number) => string, unit: string): string => { const m = mean(pts.map((p) => p.v)); return m == null ? '' : `average ${fmt(m)}${unit}`; };

  // sleep
  const ns = sleeps.map((n) => ({ n, f: figures(n) })).filter(({ f }) => inRange(f.wokeMs) && f.sleepMin > 0);
  const stageMode: Mode = mode === 'raw' ? 'day' : mode;
  const layer = (pick2: (f: ReturnType<typeof figures>) => number): Pt[] => aggregate(ns.map(({ f }) => ({ t: f.wokeMs, v: pick2(f) / 60 })), stageMode, 'mean');
  const deep = layer((f) => f.deepMin), light = layer((f) => f.lightMin), rem = layer((f) => f.remMin);
  if (deep.length) {
    add('Sleep', avgText(ns.map(({ f }) => ({ v: f.sleepMin })), (v) => hm(v), ''), [{ name: 'Sleep', color: COLORS.deep, points: deep, kind: 'bars', stack: [deep, light, rem], stackColors: [COLORS.deep, COLORS.light, COLORS.rem], stackNames: ['Deep', 'Light', 'REM'] }], ' h', r1, true);
  }
  const score = aggregate(ns.flatMap(({ n, f }) => (n.summary.sleepScore != null ? [{ t: f.wokeMs, v: n.summary.sleepScore }] : [])), stageMode, 'mean');
  add('Sleep score', avgText(score, r0, ' points'), [{ name: 'Score', color: COLORS.blue, points: score, kind: 'line', band: true }], ' points', r0);

  // activity
  const minutes: ActivityMinute[] = records.filter((r) => r.kind === 'activity').flatMap(minutesOf).filter((m) => inRange(m.t * 1000));
  const series = (f: (m: ActivityMinute) => number | null): { t: number; v: number }[] => minutes.flatMap((m) => { const v = f(m); return v == null ? [] : [{ t: m.t * 1000, v }]; });
  const steps = aggregate(series((m) => m.steps), sumMode, 'sum');
  add('Steps', avgText(steps, r0, ` per ${sumMode === 'hour' ? 'hour' : sumMode}`), [{ name: 'Steps', color: COLORS.blue, points: steps, kind: 'bars' }], '', r0, true);
  const dist = aggregate(series((m) => (m.distance == null ? null : m.distance / 1000)), sumMode, 'sum');
  add('Distance', avgText(dist, (v) => v.toFixed(2), ` km per ${sumMode === 'hour' ? 'hour' : sumMode}`), [{ name: 'Distance', color: COLORS.green, points: dist, kind: 'bars' }], ' km', (v) => v.toFixed(v < 10 ? 1 : 0), true);
  const kcal = aggregate(series((m) => (m.kcal == null ? null : m.kcal / 1000)), sumMode, 'sum');
  add('Calories', avgText(kcal, r0, ` kcal per ${sumMode === 'hour' ? 'hour' : sumMode}`), [{ name: 'Calories', color: COLORS.amber, points: kcal, kind: 'bars' }], ' kcal', r0, true);
  const hr = aggregate(series((m) => m.hr), mode, 'mean');
  add('Heart rate', avgText(series((m) => m.hr), r0, ' bpm'), [{ name: 'Heart rate', color: COLORS.red, points: hr, kind: 'line', band: true }], ' bpm', r0);
  const rest = aggregate(series((m) => m.restingHr), mode === 'raw' ? 'raw' : mode, 'mean');
  add('Resting heart rate', avgText(rest, r0, ' bpm'), [{ name: 'Resting heart rate', color: COLORS.red, points: rest, kind: 'line' }], ' bpm', r0);
  const spo2 = aggregate(series((m) => m.spo2), mode, 'mean');
  add('SpO₂', avgText(series((m) => m.spo2), r0, '%'), [{ name: 'SpO₂', color: COLORS.blue, points: spo2, kind: mode === 'raw' ? 'dots' : 'line', band: true }], '%', r0);

  // measurements
  const reading = (cls: number, field: number): { t: number; v: number }[] => records.flatMap((r) => {
    if (r.kind !== 'reading' || r.data['cls'] !== cls || !inRange(r.start)) return [];
    const v = (r.data['values'] as Record<string, number> | undefined)?.[String(field)];
    return typeof v === 'number' && Number.isFinite(v) ? [{ t: r.start, v }] : [];
  });
  const bpMode: Mode = mode === 'raw' || reading(10002, 2006).length <= 120 ? 'raw' : mode;
  const sys = aggregate(reading(10002, 2006), bpMode, 'mean'), dia = aggregate(reading(10002, 2007), bpMode, 'mean');
  const ms = mean(sys.map((p) => p.v)), md = mean(dia.map((p) => p.v));
  add('Blood pressure', ms != null && md != null ? `average ${r0(ms)}/${r0(md)} mmHg` : '', [
    { name: 'Systolic', color: COLORS.red, points: sys, kind: 'line' }, { name: 'Diastolic', color: COLORS.blue, points: dia, kind: 'line' },
  ], ' mmHg', r0);
  const pulse = aggregate(reading(10002, 10002537), bpMode, 'mean');
  add('Pulse (blood pressure readings)', avgText(pulse, r0, ' bpm'), [{ name: 'Pulse', color: COLORS.amber, points: pulse, kind: 'line' }], ' bpm', r0);
  const hrv = aggregate(reading(500044, 500044831), mode, 'mean');
  add('HRV (RMSSD)', avgText(reading(500044, 500044831), r0, ' ms'), [{ name: 'HRV', color: COLORS.green, points: hrv, kind: mode === 'raw' ? 'dots' : 'line', band: true }], ' ms', r0);
  const stressPts = records.flatMap((r) => (r.kind === 'stress' && inRange(r.start) && typeof r.data['score'] === 'number' && (r.data['score'] as number) > 0 ? [{ t: r.start, v: r.data['score'] as number }] : []));
  add('Stress', avgText(stressPts, r0, ''), [{ name: 'Stress', color: COLORS.amber, points: aggregate(stressPts, mode, 'mean'), kind: mode === 'raw' ? 'dots' : 'line', band: true }], '', r0);
  const val = aggregate(reading(500031, 500031347), mode, 'mean'), aro = aggregate(reading(500031, 500031842), mode, 'mean');
  add('Emotion', 'valence and arousal, 0–100', [{ name: 'Valence', color: COLORS.green, points: val, kind: mode === 'raw' ? 'dots' : 'line' }, { name: 'Arousal', color: COLORS.amber, points: aro, kind: mode === 'raw' ? 'dots' : 'line' }], '', r0);

  // workouts
  const wk = records.filter((r) => r.kind === 'workout' && inRange(r.start));
  const wkMin = aggregate(wk.map((r) => ({ t: r.start, v: ((typeof r.data['end'] === 'number' ? (r.data['end'] as number) : r.start) - r.start) / 60000 })), stageMode, 'sum');
  add('Workouts', `${wk.length} workout${wk.length === 1 ? '' : 's'}`, [{ name: 'Workout time', color: COLORS.green, points: wkMin, kind: 'bars' }], ' min', r0, true);
  const wkKcal = aggregate(wk.flatMap((r) => { const k = (r.data['totals'] as Record<string, number> | undefined)?.['kcal']; return typeof k === 'number' ? [{ t: r.start, v: k }] : []; }), stageMode, 'sum');
  add('Workout calories', avgText(wkKcal, r0, ' kcal'), [{ name: 'Workout calories', color: COLORS.amber, points: wkKcal, kind: 'bars' }], ' kcal', r0, true);

  const period = RANGES.find(([v]) => v === range)?.[1] ?? '';
  box.appendChild(el('p', 'note', `${new Date(from).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })} – ${new Date(to).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}${mode === 'day' ? ' · one value per day' : mode === 'week' ? ' · one value per week' : ''}. Hover or tap a point for its value.`));
  if (!cards.length) box.appendChild(el('p', 'muted', `No data from the watch in the last ${period.toLowerCase()}.`));
  box.append(...cards);
}
