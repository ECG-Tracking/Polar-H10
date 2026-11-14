// The "BP and ECG" page: every blood pressure reading from the watch with the ECG figures of the recordings taken around
// it. At the top, the period (as on ECG history and trending), then the blood pressure graph over it and the picked
// reading's Watch D2 and Polar H10 ECGs, with one slider (as in a tracking's Combined ECG); then the choice of columns and
// a table with one row per reading in the period.

import { BpStrip } from './charts';
import { figure, matchReading, readingsBetween, type BpMatch } from './bp';
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
  pairInto: (root: HTMLElement, trackingId: string, opts: { compact: boolean; bp: BpStrip }) => Promise<void>;
  openEcg: (id: string) => void;
}

/** ECG figures that can be shown for each device: [key, name, unit, decimals]. */
const FIGURES = [
  ['hrvScore', 'HRV score', '', 0], ['qrs', 'QRS duration', 'ms', 0], ['tPositive', 'T-wave positive', '%', 0],
  ['tAmp', 'T-wave amplitude', 'µV', 0], ['trRatio', 'T/R ratio', '', 2], ['qtc', 'QTc', 'ms', 0], ['eventCount', 'Events', '', 0],
  ['meanHR', 'Mean heart rate', 'bpm', 0], ['rmssd', 'RMSSD', 'ms', 0], ['sdnn', 'SDNN', 'ms', 0], ['qt', 'QT', 'ms', 0],
] as const;
const DEVICES = [['polar', 'Polar H10'], ['watch', 'Watch D2']] as const;
/** Shown at first: the date, the reading and the figures asked for (each with both devices' values). */
const DEFAULT_COLS = ['when', 'bp', 'hrvScore', 'qrs', 'tPositive', 'tAmp', 'trRatio', 'qtc', 'eventCount'];

const withUnit = (name: string, unit: string): string => (unit ? `${name} (${unit})` : name);
const dateTime = (ms: number): string => new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const bpText = (b: SyncBp): string => `${b.systolic ?? '--'}/${b.diastolic ?? '--'}`;

/** Every column the table can show. */
function columns(): Column<BpMatch>[] {
  const cols: Column<BpMatch>[] = [
    { id: 'when', label: 'Date and time', value: (m) => m.bp.at, text: (m) => dateTime(m.bp.at) },
    { id: 'bp', label: 'BP reading (mmHg)', value: (m) => m.bp.systolic, text: (m) => bpText(m.bp) },
    { id: 'pulse', label: 'Pulse (bpm)', value: (m) => m.bp.pulse, text: (m) => (m.bp.pulse == null ? '--' : String(m.bp.pulse)) },
  ];
  // each figure in one column, the Polar H10's value above the Watch D2's (as in the ECG figure boxes); it sorts by the
  // strap's value, or the watch's where the strap has none
  for (const [key, name, unit, digits] of FIGURES) {
    const val = (m: BpMatch, dev: 'polar' | 'watch'): string => { const v = figure(m, dev, key); return v == null ? '--' : fmt(v, digits); };
    cols.push({
      id: key, label: withUnit(name, unit),
      value: (m) => figure(m, 'polar', key) ?? figure(m, 'watch', key),
      text: (m) => `Polar H10 ${val(m, 'polar')} · Watch D2 ${val(m, 'watch')}`,
      cell: (m) => {
        const box = make('div', 'pair-cell');
        for (const [dev, devName] of DEVICES) {
          const line = make('div', 'pair-line');
          line.append(make('span', 'pair-who', devName), make('span', 'v', val(m, dev)));
          box.appendChild(line);
        }
        return box;
      },
    });
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
interface Saved { period: Period; from: string; to: string }
function load(): Saved {
  const none: Saved = { period: '1m', from: '', to: '' };
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Saved> | null;
    if (!v) return none;
    return {
      period: PERIODS.some((p) => p[0] === v.period) ? v.period! : none.period,
      from: typeof v.from === 'string' ? v.from : '', to: typeof v.to === 'string' ? v.to : '',
    };
  } catch { return none; }
}

export function initBpEcg(root: HTMLElement, deps: BpEcgDeps): { refresh: () => void } {
  const state = load();
  const save = (): void => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* not kept */ } };
  let all: SyncBp[] = [], sessions: Session[] = [], entries: SyncTrackingEntry[] = [], matches: BpMatch[] = [];
  let pickedAt: number | null = null, run = 0;

  // ---- top: the period, then the blood pressure graph over it and the picked reading's two ECGs, with one slider ----
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
  const status = make('p', 'note');
  const shown = make('section', 'card');
  const shownTitle = make('h3', 'sync-h', 'Blood pressure with the ECGs');
  const topBp = new BpStrip(true);
  const bpBox = make('div', 'card viewer bp-card');
  bpBox.appendChild(topBp.el);
  const shownBody = make('div');
  shown.append(top, status, shownTitle, bpBox, shownBody);

  // ---- the table, with the choice of columns just above it ----
  const table = colTable<BpMatch>({
    columns: columns(), defaults: { cols: [...DEFAULT_COLS], sort: null, folded: [] }, storageKey: `${KEY}-table2`, // v1.45.3: a column per figure
    rowKey: (m) => String(m.bp.at), baseOrder: (a, b) => b.bp.at - a.bp.at, // latest on top
    onPick: (m) => { pickedAt = m.bp.at; table.set(visible(), String(pickedAt)); void showPicked(m); },
    empty: 'No blood pressure readings in this period. Readings come from the Watch D2 through D2 Link.',
  });
  const tableCard = make('section', 'card');
  tableCard.append(make('h3', 'sync-h', 'Blood pressure readings'),
    make('p', 'note', 'One row for each blood pressure reading in the period. The ECG figures are from the synchronised tracking the reading belongs to, or else from the Polar H10 ECG and the watch strips taken within an hour of it (the median of the strips; their events added up). -- where there is none. Click a row to show it at the top.'),
    table.el);
  root.replaceChildren(shown, tableCard);

  const range = (): [number, number] => {
    const first = all.reduce((a, r) => Math.min(a, r.at), Date.now());
    return periodRange(state.period, Date.now(), first, state.from, state.to);
  };
  const visible = (): BpMatch[] => { const [a, b] = range(); return matches.filter((m) => m.bp.at >= a && m.bp.at <= b); };

  for (const c of [period, from, to]) c.addEventListener('change', () => {
    state.period = period.value as Period; state.from = from.value; state.to = to.value;
    save(); draw();
  });

  /** The BP graph covers the whole period; `recording`: the picked tracking, shaded. */
  function drawBp(recording: [number, number] | null): void {
    custom.hidden = state.period !== 'custom';
    const [a, b] = range();
    topBp.set(readingsBetween(all, a, b), [a, b], recording);
  }

  async function showPicked(m: BpMatch | null): Promise<void> {
    if (!m) {
      shownTitle.textContent = 'Blood pressure with the ECGs';
      drawBp(null);
      shownBody.replaceChildren(make('p', 'muted', 'No reading in this period.'));
      return;
    }
    shownTitle.textContent = `Blood pressure ${bpText(m.bp)} mmHg at ${dateTime(m.bp.at)}`;
    if (m.tracking) {
      // the tracking shaded on the period's graph; the slider moves both ECGs and the mark on it
      const t = m.tracking;
      drawBp([t.start, t.start + t.durationS * 1000]);
      await deps.pairInto(shownBody, t.id, { compact: true, bp: topBp });
      return;
    }
    // no tracking: the readings around this one, and the ECGs taken near it to open
    drawBp(null);
    topBp.mark(m.bp.at);
    const buttons = make('div', 'row wrap');
    const polar = m.polar;
    if (polar) { const b = make('button', '', `Open the Polar H10 ECG (${dateTime(polar.start)})`); b.addEventListener('click', () => deps.openEcg(polar.id)); buttons.appendChild(b); }
    for (const w of m.watch) { const b = make('button', 'small', `Watch strip ${dateTime(w.start)}`); b.addEventListener('click', () => deps.openEcg(w.id)); buttons.appendChild(b); }
    shownBody.replaceChildren(make('p', 'note', polar || m.watch.length
      ? 'This reading isn’t part of a synchronised tracking, so its ECGs weren’t recorded together and can’t be shown on one slider. Open them here:'
      : 'No ECG was taken within an hour of this reading.'), buttons);
  }

  function draw(): void {
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
    if (need.size) { rematch(); table.set(visible(), pickedAt == null ? null : String(pickedAt)); }
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
