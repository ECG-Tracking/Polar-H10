// The "BP and ECG" page: every blood pressure reading from the watch with the ECG figures of the recordings taken around
// it. At the top, trending over the chosen period (as on ECG history and trending); then the picked reading's blood
// pressure graph with its Watch D2 and Polar H10 ECGs and their slider; then a table with one row per reading.

import { BpStrip, Plot, type Point } from './charts';
import { BP_NEAR_MS, figure, matchReading, readingsBetween, type BpMatch } from './bp';
import { colTable, type Column } from './coltable';
import { PERIODS, periodRange, type Period } from './ecgtrend';
import * as store from './store';
import type { Session, SyncBp, SyncTrackingEntry, UserNumber } from './store';
import { fmt, make } from './ui';

export interface BpEcgDeps {
  user: () => number;
  /** Every blood pressure reading on this device. */
  readings: () => Promise<SyncBp[]>;
  /** Works out the figures of a recording that doesn't have them yet (as for trending). */
  fill: (s: Session) => Promise<Session | null>;
  /** Shows a synchronised tracking's two ECGs, with their slider, in `root`. */
  pairInto: (root: HTMLElement, trackingId: string) => Promise<void>;
  openEcg: (id: string) => void;
}

/** ECG figures that can be shown for each device: [key, name, unit, decimals]. */
const FIGURES = [
  ['hrvScore', 'HRV score', '', 0], ['qrs', 'QRS duration', 'ms', 0], ['tPositive', 'T-wave positive', '%', 0],
  ['tAmp', 'T-wave amplitude', 'µV', 0], ['trRatio', 'T/R ratio', '', 2], ['qtc', 'QTc', 'ms', 0], ['eventCount', 'Events', '', 0],
  ['meanHR', 'Mean heart rate', 'bpm', 0], ['rmssd', 'RMSSD', 'ms', 0], ['sdnn', 'SDNN', 'ms', 0], ['qt', 'QT', 'ms', 0],
] as const;
const DEVICES = [['polar', 'Polar H10'], ['watch', 'Watch D2']] as const;
/** Shown at first: the date, the reading, and the strap's figures asked for; the watch's can be added. */
const DEFAULT_COLS = ['when', 'bp', 'hrvScore:polar', 'qrs:polar', 'tPositive:polar', 'tAmp:polar', 'trRatio:polar', 'qtc:polar', 'eventCount:polar'];

const withUnit = (name: string, unit: string): string => (unit ? `${name} (${unit})` : name);
const dateTime = (ms: number): string => new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const dateText = (ms: number): string => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short', year: '2-digit' });
const bpText = (b: SyncBp): string => `${b.systolic ?? '--'}/${b.diastolic ?? '--'}`;

/** Every column the table can show. */
function columns(): Column<BpMatch>[] {
  const cols: Column<BpMatch>[] = [
    { id: 'when', label: 'Date and time', value: (m) => m.bp.at, text: (m) => dateTime(m.bp.at) },
    { id: 'bp', label: 'BP reading (mmHg)', value: (m) => m.bp.systolic, text: (m) => bpText(m.bp) },
    { id: 'pulse', label: 'Pulse (bpm)', value: (m) => m.bp.pulse, text: (m) => (m.bp.pulse == null ? '--' : String(m.bp.pulse)) },
  ];
  for (const [key, name, unit, digits] of FIGURES) {
    for (const [dev, devName] of DEVICES) {
      cols.push({
        id: `${key}:${dev}`, label: `${withUnit(name, unit)} · ${devName}`,
        value: (m) => figure(m, dev, key),
        text: (m) => { const v = figure(m, dev, key); return v == null ? '--' : fmt(v, digits); },
      });
    }
  }
  cols.push({ id: 'source', label: 'ECGs', value: (m) => (m.tracking ? 2 : m.polar || m.watch.length ? 1 : 0), text: sourceText });
  return cols;
}

function sourceText(m: BpMatch): string {
  if (m.tracking) return 'Synchronised tracking';
  const parts = [m.polar ? 'Polar H10 ECG' : '', m.watch.length ? `${m.watch.length} watch strip${m.watch.length > 1 ? 's' : ''}` : ''].filter(Boolean);
  return parts.length ? parts.join(' + ') : 'No ECG within an hour';
}

const KEY = 'openbeat-bp-ecg';
interface Saved { period: Period; from: string; to: string; picked: string[] }
function load(): Saved {
  const none: Saved = { period: '1m', from: '', to: '', picked: ['systolic', 'diastolic'] };
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Saved> | null;
    if (!v) return none;
    return {
      period: PERIODS.some((p) => p[0] === v.period) ? v.period! : none.period,
      from: typeof v.from === 'string' ? v.from : '', to: typeof v.to === 'string' ? v.to : '',
      picked: Array.isArray(v.picked) ? v.picked.filter((x) => typeof x === 'string') : none.picked,
    };
  } catch { return none; }
}

export function initBpEcg(root: HTMLElement, deps: BpEcgDeps): { refresh: () => void } {
  const state = load();
  const save = (): void => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* not kept */ } };
  let all: SyncBp[] = [], sessions: Session[] = [], entries: SyncTrackingEntry[] = [], matches: BpMatch[] = [];
  let pickedAt: number | null = null, run = 0;

  // ---- trending: the period, the figures to follow, one graph each ----
  const period = make('select');
  period.setAttribute('aria-label', 'Period');
  for (const [v, t] of PERIODS) { const o = make('option', '', t); o.value = v; period.appendChild(o); }
  period.value = state.period;
  const dateInput = (value: string, name: string): HTMLInputElement => { const i = make('input'); i.type = 'date'; i.value = value; i.setAttribute('aria-label', name); return i; };
  const from = dateInput(state.from, 'From'), to = dateInput(state.to, 'To');
  const custom = make('span', 'row wrap');
  custom.append('From ', from, ' to ', to);
  const top = make('div', 'row wrap trend-period');
  const periodLabel = make('label', 'd2-days', 'Show the last ');
  periodLabel.appendChild(period);
  top.append(periodLabel, custom);

  type Trend = [id: string, label: string, digits: number, get: (m: BpMatch) => number | null];
  const trends: Trend[] = [
    ['systolic', 'Systolic (mmHg)', 0, (m) => m.bp.systolic], ['diastolic', 'Diastolic (mmHg)', 0, (m) => m.bp.diastolic], ['pulse', 'Pulse (bpm)', 0, (m) => m.bp.pulse],
    ...FIGURES.flatMap(([key, name, unit, digits]) => DEVICES.map(([dev, devName]): Trend => [`${key}:${dev}`, `${withUnit(name, unit)} · ${devName}`, digits, (m) => figure(m, dev, key)])),
  ];
  const ticks = new Map<string, HTMLInputElement>();
  const grid = make('div', 'trend-ticks');
  for (const [id, label] of trends) {
    const box = make('input'), l = make('label');
    box.type = 'checkbox';
    box.checked = state.picked.includes(id);
    box.addEventListener('change', () => { state.picked = trends.map((t) => t[0]).filter((k) => ticks.get(k)?.checked); save(); drawTrends(); });
    ticks.set(id, box);
    l.append(box, ` ${label}`);
    grid.appendChild(l);
  }
  const status = make('p', 'note');
  const graphs = make('div');
  const trendCard = make('section', 'card');
  trendCard.append(make('h3', 'sync-h', 'Trending'), top, grid, status);

  // ---- the picked reading: its blood pressure graph and its two ECGs ----
  const shown = make('section', 'card');
  const shownTitle = make('h3', 'sync-h', 'Blood pressure with the ECGs');
  const shownBody = make('div');
  shown.append(shownTitle, shownBody);

  // ---- the table ----
  const table = colTable<BpMatch>({
    columns: columns(), defaults: { cols: [...DEFAULT_COLS], sort: null, folded: [] }, storageKey: `${KEY}-table`,
    rowKey: (m) => String(m.bp.at), baseOrder: (a, b) => b.bp.at - a.bp.at, // latest on top
    onPick: (m) => { pickedAt = m.bp.at; table.set(visible(), String(pickedAt)); void showPicked(m); },
    empty: 'No blood pressure readings in this period. Readings come from the Watch D2 through D2 Link.',
  });
  const tableCard = make('section', 'card');
  tableCard.append(make('h3', 'sync-h', 'Blood pressure readings'),
    make('p', 'note', 'One row for each blood pressure reading. The ECG figures are from the synchronised tracking the reading belongs to, or else from the Polar H10 ECG and the watch strips taken within an hour of it (the median of the strips; their events added up). -- where there is none. Click a row to show its ECGs above.'),
    table.el);
  root.replaceChildren(trendCard, graphs, shown, tableCard);

  const range = (): [number, number] => {
    const first = all.reduce((a, r) => Math.min(a, r.at), Date.now());
    return periodRange(state.period, Date.now(), first, state.from, state.to);
  };
  const visible = (): BpMatch[] => { const [a, b] = range(); return matches.filter((m) => m.bp.at >= a && m.bp.at <= b); };

  for (const c of [period, from, to]) c.addEventListener('change', () => {
    state.period = period.value as Period; state.from = from.value; state.to = to.value;
    save(); draw();
  });

  function drawTrends(): void {
    custom.hidden = state.period !== 'custom';
    const [a, b] = range();
    const rows = visible();
    const cards: HTMLElement[] = [], plots: (() => void)[] = [];
    for (const [id, label, digits, get] of trends) {
      if (!state.picked.includes(id)) continue;
      const pts = rows.flatMap((m): Point[] => { const v = get(m); return v == null ? [] : [[m.bp.at, v]]; }).sort((x, y) => x[0] - y[0]);
      const wrap = make('div', 'chart'), canvas = make('canvas'), card = make('section', 'card');
      canvas.setAttribute('aria-label', `${label} over time`);
      wrap.appendChild(canvas);
      card.append(make('h3', 'sync-h', label), wrap);
      cards.push(card);
      plots.push(() => new Plot(wrap).set({
        type: pts.length > 1 ? 'line' : 'scatter', points: pts, xFmt: dateText, ...(b > a ? { xDomain: [a, b] as const } : {}),
        yFmt: (v) => fmt(v, digits), empty: 'No readings in this period',
        tooltip: (p) => `${dateTime(p[0])}<br>${fmt(p[1], digits)}`,
      }));
    }
    graphs.replaceChildren(...cards);
    for (const p of plots) p();
  }

  async function showPicked(m: BpMatch | null): Promise<void> {
    if (!m) { shownTitle.textContent = 'Blood pressure with the ECGs'; shownBody.replaceChildren(make('p', 'muted', 'No reading picked.')); return; }
    shownTitle.textContent = `Blood pressure ${bpText(m.bp)} mmHg at ${dateTime(m.bp.at)}`;
    if (m.tracking) { await deps.pairInto(shownBody, m.tracking.id); return; } // its graph, both ECGs and the slider
    // no tracking: the readings around this one, and the ECGs taken near it to open
    const bp = new BpStrip();
    const box = make('div', 'card viewer bp-card');
    box.appendChild(bp.el);
    const buttons = make('div', 'row wrap');
    const polar = m.polar;
    if (polar) { const b = make('button', '', `Open the Polar H10 ECG (${dateTime(polar.start)})`); b.addEventListener('click', () => deps.openEcg(polar.id)); buttons.appendChild(b); }
    for (const w of m.watch) { const b = make('button', 'small', `Watch strip ${dateTime(w.start)}`); b.addEventListener('click', () => deps.openEcg(w.id)); buttons.appendChild(b); }
    shownBody.replaceChildren(box, make('p', 'note', polar || m.watch.length
      ? 'This reading isn’t part of a synchronised tracking, so its ECGs weren’t recorded together and can’t be shown side by side. Open them here:'
      : 'No ECG was taken within an hour of this reading.'), buttons);
    bp.set(readingsBetween(all, m.bp.at - BP_NEAR_MS, m.bp.at + BP_NEAR_MS), [m.bp.at - BP_NEAR_MS, m.bp.at + BP_NEAR_MS], null);
    bp.mark(m.bp.at);
  }

  function draw(): void {
    drawTrends();
    const rows = visible();
    if (pickedAt == null || !rows.some((m) => m.bp.at === pickedAt)) pickedAt = rows.reduce<number | null>((a, m) => (a == null || m.bp.at > a ? m.bp.at : a), null);
    table.set(rows, pickedAt == null ? null : String(pickedAt));
    void showPicked(rows.find((m) => m.bp.at === pickedAt) ?? null);
  }

  /** The recordings the readings use that don't have their figures yet get them, a few at a time. */
  async function fillIn(mine: number): Promise<void> {
    const need = new Map<string, Session>();
    for (const m of matches) for (const s of [m.polar, ...m.watch]) if (s && !s.summary?.trend && s.source !== 'demo') need.set(s.id, s);
    let i = 0;
    for (const s of need.values()) {
      if (mine !== run) return;
      status.textContent = `Working out the figures of the ECGs: ${++i} of ${need.size}…`;
      await new Promise((r) => setTimeout(r, 0));
      const done = await deps.fill(s).catch(() => null);
      if (mine !== run) return;
      if (done) sessions = sessions.map((x) => (x.id === done.id ? done : x));
    }
    status.textContent = '';
    if (need.size) { rematch(); drawTrends(); table.set(visible(), pickedAt == null ? null : String(pickedAt)); }
  }

  function rematch(): void { matches = all.map((r) => matchReading(r, sessions, entries)); }

  async function refresh(): Promise<void> {
    const mine = ++run;
    status.textContent = 'Loading the readings…';
    const user = deps.user();
    const [readings, list] = await Promise.all([deps.readings().catch(() => []), store.listSessions(user as UserNumber).catch(() => [])]);
    if (mine !== run) return;
    all = readings; sessions = list;
    entries = store.loadSyncHistory().filter((e) => e.user === user);
    status.textContent = all.length ? '' : 'No blood pressure readings yet. Take one on the Watch D2 and download it with D2 Link.';
    rematch();
    draw();
    void fillIn(mine);
  }

  return { refresh: () => void refresh() };
}
