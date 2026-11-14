// The trending part of ECG history and trending: one graph for each ticked figure, over the chosen period.

import { BpStrip, Plot, type Point } from './charts';
import type { SyncBp } from './store';
import type { SessionMetrics } from './dsp';
import type { Session } from './store';
import { fmt, make } from './ui';

export type TrendValues = Record<string, number>;

/** Every figure of the ECG report that can be followed over time. */
export const TREND_PARAMS = [
  ['meanHR', 'Mean heart rate', 'bpm', 0], ['highestHr', 'Highest heart rate', 'bpm', 0], ['meanRR', 'Mean beat interval', 'ms', 0],
  ['hrvScore', 'HRV score', '', 0], ['rmssd', 'RMSSD', 'ms', 0], ['sdnn', 'SDNN', 'ms', 0], ['pnn50', 'pNN50', '%', 1], ['pnn200', 'pNN200', '%', 1],
  ['sd1', 'Poincaré SD1', 'ms', 0], ['sd2', 'Poincaré SD2', 'ms', 0], ['eventCount', 'Events', '', 0], ['eventPct', 'Events', '% of beats', 1],
  ['qrs', 'QRS duration', 'ms', 0], ['qt', 'QT', 'ms', 0], ['qtc', 'QTc', 'ms', 0], ['tPositive', 'T wave positive', '%', 0],
  ['tAmp', 'T-wave amplitude', 'µV', 0], ['trRatio', 'T/R ratio', '', 2], ['jPoint', 'J point', 'µV', 0], ['st60', 'ST at J+60 ms', 'µV', 0],
  ['rAmp', 'R amplitude', 'µV', 0], ['sAmp', 'S amplitude', 'µV', 0], ['hf', '2–8 Hz energy', '%', 1],
  ['trimp', 'Effort (TRIMP)', '', 1], ['hrr60', 'HR recovery (60 s)', 'bpm', 0], ['durationS', 'Recording length', 'min', 1], ['beatCount', 'Beats', '', 0],
] as const;
type Key = (typeof TREND_PARAMS)[number][0];

/** The figures kept with a recording, so the graphs don't have to analyse every ECG again. */
export function trendValues(m: SessionMetrics): TrendValues {
  const highestHr = m.hr.reduce<number>((a, b) => (b != null && b > a ? b : a), 0);
  const all: Record<Key, number | null | undefined> = {
    meanHR: m.meanHR, highestHr: highestHr || null, meanRR: m.meanRR, hrvScore: m.hrvScore, rmssd: m.rmssd, sdnn: m.sdnn, pnn50: m.pnn50, pnn200: m.pnn200,
    sd1: m.sd1, sd2: m.sd2, eventCount: m.eventCount, eventPct: m.eventPct, qrs: m.qrs, qt: m.qt, qtc: m.qtc, tPositive: m.tPositive, tAmp: m.tAmp,
    trRatio: m.trRatio, jPoint: m.jPoint, st60: m.st60, rAmp: m.rAmp, sAmp: m.sAmp == null ? null : Math.abs(m.sAmp), hf: m.hf,
    trimp: m.trimp, hrr60: m.recovery?.hrr60, durationS: m.durationS / 60, beatCount: m.beatCount,
  };
  return Object.fromEntries(Object.entries(all).filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1])));
}

export const PERIODS = [
  ['3h', '3 hours'], ['6h', '6 hours'], ['9h', '9 hours'], ['12h', '12 hours'], ['1d', '1 day'], ['3d', '3 days'], ['7d', '7 days'], ['14d', '14 days'], ['1m', '1 month'], ['3m', '3 months'], ['6m', '6 months'],
  ['12m', '1 year'], ['24m', '2 years'], ['36m', '3 years'], ['all', 'All'], ['custom', 'Custom'],
] as const;
export type Period = (typeof PERIODS)[number][0];

/** The chosen period as [from, to] in ms. `custom` runs from the start of one date to the end of the other. */
export function periodRange(period: Period, now: number, first: number, from = '', to = ''): [number, number] {
  if (period === 'all') return [first, now];
  if (period === 'custom') {
    const a = from ? new Date(`${from}T00:00:00`).getTime() : NaN, b = to ? new Date(`${to}T23:59:59.999`).getTime() : NaN;
    return [Number.isFinite(a) ? a : first, Number.isFinite(b) ? b : now];
  }
  const n = Number(period.slice(0, -1));
  if (period.endsWith('h')) return [now - n * 3600000, now];
  if (period.endsWith('d')) return [now - n * 86400000, now];
  const d = new Date(now);
  d.setMonth(d.getMonth() - n);
  return [d.getTime(), now];
}

/** One figure's points in time order. A recording without it (for example no HR recovery) is left out. */
export function trendPoints(sessions: readonly Session[], key: string, from: number, to: number): Point[] {
  return sessions.flatMap((s): Point[] => {
    const v = s.summary?.trend?.[key];
    return v != null && s.start >= from && s.start <= to ? [[s.start, v]] : [];
  }).sort((a, b) => a[0] - b[0]);
}

const KEY = 'openbeat-ecg-trends';
/** Blood pressure: the watch's readings over the period, systolic and diastolic, on the blood pressure chart. */
const BP_KEY = 'bloodPressure';
interface Saved { period: Period; picked: string[]; from: string; to: string }

function load(): Saved {
  const none: Saved = { period: '1m', picked: ['meanHR', 'rmssd', 'qtc'], from: '', to: '' };
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Saved> | null;
    if (!v) return none;
    return {
      period: PERIODS.some((p) => p[0] === v.period) ? v.period! : none.period,
      picked: Array.isArray(v.picked) ? v.picked.filter((k) => k === BP_KEY || TREND_PARAMS.some((p) => p[0] === k)) : none.picked,
      from: typeof v.from === 'string' ? v.from : '', to: typeof v.to === 'string' ? v.to : '',
    };
  } catch { return none; }
}

const dateText = (ms: number): string => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short', year: '2-digit' });
const label = (name: string, unit: string): string => (unit ? `${name} (${unit})` : name);

export interface TrendDeps {
  /** Works out the figures of a recording that doesn't have them yet; returns it with them, or null if it can't. */
  fill: (s: Session) => Promise<Session | null>;
  /** The blood pressure readings on this device (the watch's). */
  readings: () => Promise<SyncBp[]>;
}

/** Every choice, in alphabetical order: the ECG figures and blood pressure. */
const CHOICES: readonly (readonly [key: string, name: string, unit: string, digits: number])[] = [
  ...TREND_PARAMS, [BP_KEY, 'Blood pressure', 'mmHg', 0] as const,
].sort((a, b) => label(a[1], a[2]).localeCompare(label(b[1], b[2]), undefined, { sensitivity: 'base', numeric: true }));

/** `root`: the top of the page. `show` is called with this user's recordings whenever they change. */
export function initTrends(root: HTMLElement, deps: TrendDeps): { show: (sessions: readonly Session[]) => void } {
  const state = load();
  const save = (): void => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* not kept */ } };
  let sessions: Session[] = [];
  let readings: SyncBp[] = [];
  let run = 0;

  const period = make('select');
  period.setAttribute('aria-label', 'Period');
  for (const [v, t] of PERIODS) { const o = make('option', '', t); o.value = v; period.appendChild(o); }
  period.value = state.period;
  const dateInput = (value: string, name: string): HTMLInputElement => {
    const i = make('input');
    i.type = 'date'; i.value = value;
    i.setAttribute('aria-label', name);
    return i;
  };
  const from = dateInput(state.from, 'From'), to = dateInput(state.to, 'To');
  const custom = make('span', 'row wrap');
  custom.append('From ', from, ' to ', to);
  const top = make('div', 'row wrap trend-period');
  const periodLabel = make('label', 'd2-days', 'Show the last ');
  periodLabel.appendChild(period);
  top.append(periodLabel, custom);

  const allBox = make('input'), ticks = new Map<string, HTMLInputElement>();
  allBox.type = 'checkbox';
  const allLabel = make('label', 'trend-all');
  allLabel.append(allBox, ' Select all');
  const grid = make('div', 'trend-ticks');
  for (const [key, name, unit] of CHOICES) {
    const box = make('input'), l = make('label');
    box.type = 'checkbox';
    box.checked = state.picked.includes(key);
    box.addEventListener('change', () => {
      state.picked = CHOICES.map((p) => p[0]).filter((k) => ticks.get(k)?.checked);
      save();
      draw();
    });
    ticks.set(key, box);
    l.append(box, ` ${label(name, unit)}`);
    grid.appendChild(l);
  }
  allBox.addEventListener('change', () => {
    for (const b of ticks.values()) b.checked = allBox.checked;
    state.picked = allBox.checked ? CHOICES.map((p) => p[0]) : [];
    save();
    draw();
  });

  const status = make('p', 'note');
  const graphs = make('div');
  const panel = make('section', 'card');
  panel.append(make('h3', 'sync-h', 'Trending'), top, allLabel, grid, status);
  root.replaceChildren(panel, graphs);

  const changed = (): void => {
    state.period = period.value as Period; state.from = from.value; state.to = to.value;
    save();
    draw();
  };
  for (const c of [period, from, to]) c.addEventListener('change', changed);

  function draw(): void {
    custom.hidden = state.period !== 'custom';
    allBox.checked = state.picked.length === CHOICES.length;
    allBox.indeterminate = state.picked.length > 0 && !allBox.checked;
    const real = sessions.filter((s) => s.source !== 'demo');
    const first = real.reduce((a, s) => Math.min(a, s.start), Date.now());
    const [a, b] = periodRange(state.period, Date.now(), first, state.from, state.to);
    const cards: HTMLElement[] = [];
    const plots: (() => void)[] = [];
    for (const [key, name, unit, digits] of CHOICES) {
      if (!state.picked.includes(key)) continue;
      if (key === BP_KEY) { // the blood pressure chart, as on the BP and ECG page
        const chart = new BpStrip(true), card = make('section', 'card');
        card.appendChild(chart.el);
        cards.push(card);
        plots.push(() => chart.set(readings.filter((r) => r.at >= a && r.at <= b), [a, b], null));
        continue;
      }
      const pts = trendPoints(real, key, a, b);
      const wrap = make('div', 'chart'), canvas = make('canvas'), card = make('section', 'card');
      canvas.setAttribute('aria-label', `${name} over time`);
      wrap.appendChild(canvas);
      card.append(make('h3', 'sync-h', label(name, unit)), wrap);
      cards.push(card);
      plots.push(() => new Plot(wrap).set({
        type: pts.length > 1 ? 'line' : 'scatter', points: pts, xFmt: dateText, ...(b > a ? { xDomain: [a, b] as const } : {}),
        yFmt: (v) => fmt(v, digits), yLabel: unit, empty: 'No recordings in this period',
        tooltip: (p) => `${new Date(p[0]).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}<br>${fmt(p[1], digits)} ${unit}`,
      }));
    }
    graphs.replaceChildren(...cards);
    for (const p of plots) p(); // once in the page, so each knows its size
  }

  /** Recordings from before these figures were kept get them now, a few at a time so the page stays usable. */
  async function fillIn(mine: number): Promise<void> {
    const missing = sessions.filter((s) => s.source !== 'demo' && !s.summary?.trend);
    for (const [i, s] of missing.entries()) {
      if (mine !== run) return;
      status.textContent = `Working out the figures of earlier recordings: ${i + 1} of ${missing.length}…`;
      await new Promise((r) => setTimeout(r, 0));
      const done = await deps.fill(s).catch(() => null);
      if (mine !== run) return;
      if (done) sessions = sessions.map((x) => (x.id === done.id ? done : x));
      if (i % 5 === 4) draw();
    }
    status.textContent = '';
    if (missing.length) draw();
  }

  return {
    show(list) {
      sessions = [...list];
      draw();
      void deps.readings().then((r) => { readings = r; if (state.picked.includes(BP_KEY)) draw(); }).catch(() => undefined);
      void fillIn(++run);
    },
  };
}
