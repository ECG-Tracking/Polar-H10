// The "BP and ECG" page: every blood pressure reading from the watch with the ECG figures of the recordings taken around
// it. At the top, the period (as on ECG history and trending); then the blood pressure graph over the period, and every
// ECG recorded in it on two strips (Watch D2 above, Polar H10 below) with one slider that runs through them all and marks
// its date and time on the graph; then the choice of columns and a table with one row per reading in the period.

import { BpStrip, EcgViewer, type ReportEvent } from './charts';
import { EVENT_LABELS, type Analysis } from './dsp';
import { joinSegments, realAt, segmentAt, stripAt, type PeriodEcg, type Segment } from './periodecg';
import { matchStrips, type StripIn } from './stripmatch';
import { ensureCombined } from './syncreports';
import type { CombinedResult } from './synccompare';
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
}

const FS = 130;
/** A recording longer than this (an overnight one) is left off the strips: it would bury the others. */
const LONGEST_S = 3 * 3600;

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
    const val = (m: BpMatch, dev: 'polar' | 'watch'): string => {
      // events and their % of beats: for a tracking, those both devices saw (its Combined ECG's); else each device's own
      if (key === 'eventCount') {
        const n = figure(m, dev, 'eventCount'), pct = figure(m, dev, 'eventPct');
        return n == null ? '--' : `${fmt(n, 0)}${pct == null ? '' : ` · ${fmt(pct, 1)} %`}`;
      }
      const v = figure(m, dev, key); return v == null ? '--' : fmt(v, digits);
    };
    cols.push({
      id: key, label: key === 'eventCount' ? 'Events (counted · % of beats)' : withUnit(name, unit),
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
  /** Each tracking's saved Combined ECG results (its figures and the events both devices saw). */
  const combined = new Map<string, CombinedResult | null>();

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
  const strip = (title: string, label: string): { box: HTMLElement; canvas: HTMLCanvasElement } => {
    const canvas = make('canvas');
    canvas.setAttribute('aria-label', label);
    const box = make('div', 'card viewer');
    box.append(make('h3', 'sync-h', title), canvas);
    return { box, canvas };
  };
  const w = strip('Watch D2', 'Every Watch D2 ECG strip of the period, in time order'), p = strip('Polar H10', 'Every Polar H10 ECG of the period, in time order');
  const wv = new EcgViewer(w.canvas), pv = new EcgViewer(p.canvas);
  const pos = make('input');
  Object.assign(pos, { type: 'range', min: '0', max: '1000', value: '0' });
  pos.setAttribute('aria-label', 'Position in the period’s ECGs');
  const time = make('span', 'muted', '');
  const bar = make('div', 'row wrap viewer-bar no-print');
  bar.append(pos, time);
  const evText = make('span', 'muted', '');
  const prevBtn = make('button', '', '← Previous event'), nextBtn = make('button', '', 'Next event →');
  const evBar = make('div', 'row wrap event-nav no-print');
  evBar.append(prevBtn, evText, nextBtn);
  const ecgNote = make('p', 'note', '');
  // the piece of ECG on the strips now: when it began and ended, and how long it is
  const pieceLine = make('p', 'pair-duration', '');
  shown.append(top, status, shownTitle, bpBox, pieceLine, w.box, p.box, bar, evBar, ecgNote);

  // ---- the table, with the choice of columns just above it ----
  const table = colTable<BpMatch>({
    columns: columns(), defaults: { cols: [...DEFAULT_COLS], sort: null, folded: [] }, storageKey: `${KEY}-table2`, // v1.45.3: a column per figure
    rowKey: (m) => String(m.bp.at), baseOrder: (a, b) => b.bp.at - a.bp.at, // latest on top
    onPick: (m) => { pickedAt = m.bp.at; table.set(visible(), String(pickedAt)); showPicked(m); },
    empty: 'No blood pressure readings in this period. Readings come from the Watch D2 through D2 Link.',
  });
  const tableCard = make('section', 'card');
  tableCard.append(make('h3', 'sync-h', 'Blood pressure readings'),
    make('p', 'note', 'One row for each blood pressure reading in the period. The ECG figures are from the synchronised tracking the reading belongs to, or else from the Polar H10 ECG and the watch strips taken within an hour of it (the median of the strips; their events added up). -- where there is none. Click a row to move the strips at the top to its ECG.'),
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
    void fillIn(run); // the period's trackings not yet counted
  });

  // ---- the period's ECGs on two strips, one slider ----
  let pe: PeriodEcg | null = null, spots: { t: number; label: string }[] = [], idx = -1, linking = false, periodRun = 0, loadedFor = '';

  /** Every ECG of the period as pieces: a tracking's strips with the strap's ECG of the same moments; other ECGs alone. */
  async function gather(a: number, b: number): Promise<Segment[]> {
    const inP = (x: { start: number; durationS: number }): boolean => x.start < b && x.start + x.durationS * 1000 > a;
    const segs: Segment[] = [], used = new Set<string>();
    const samplesOf = async (id: string): Promise<{ session: Session; samples: Int16Array } | null> => {
      const { session, samples } = await store.loadSession(id).catch(() => ({ session: undefined, samples: undefined }));
      return session && samples && session.fs === FS ? { session, samples } : null;
    };
    for (const e of entries.filter(inP)) {
      const end = e.start + e.durationS * 1000;
      const ins: StripIn[] = [];
      for (const x of sessions.filter((s) => s.source === 'watch' && !s.cloudOnly && s.start < end && s.start + s.durationS * 1000 > e.start)) {
        used.add(x.id);
        const got = await samplesOf(x.id);
        if (got) ins.push({ id: x.id, start: x.start, samples: got.samples, fs: FS });
      }
      const polar = e.ecgId ? await samplesOf(e.ecgId) : null;
      if (e.ecgId) used.add(e.ecgId);
      const set = polar && ins.length ? matchStrips(ins, polar.session.start, polar.samples, FS) : null;
      if (set) {
        for (const m of set.strips) {
          const from = Math.round(m.at * FS), to = from + Math.round(m.durationS * FS);
          segs.push({ start: m.start, durS: m.durationS, watch: set.watch.subarray(from, to), polar: set.polar.subarray(from, to) });
        }
      } else {
        if (polar) segs.push({ start: polar.session.start, durS: polar.samples.length / FS, watch: null, polar: polar.samples });
        for (const x of ins) segs.push({ start: x.start, durS: x.samples.length / FS, watch: x.samples, polar: null });
      }
    }
    // the rest: ECGs not part of a tracking (not one recorded with a sleep)
    for (const x of sessions.filter(inP)) {
      if (used.has(x.id) || x.cloudOnly || x.source === 'demo' || x.sleepId || x.durationS > LONGEST_S) continue;
      const got = await samplesOf(x.id);
      if (!got) continue;
      segs.push({ start: x.start, durS: got.samples.length / FS, watch: x.source === 'watch' ? got.samples : null, polar: x.source === 'watch' ? null : got.samples });
    }
    return segs;
  }

  const clockText = (ms: number | null): string => (ms == null ? '--' : new Date(ms).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }));
  const events = (an: Analysis, who: string): ReportEvent[] => an.events.map((e) => ({ t: e.t, type: e.type, label: `${EVENT_LABELS[e.type]} (${who})` }));

  /** Gathers the period's ECGs again when the period changed. */
  async function loadPeriod(): Promise<void> {
    const [a, b] = range();
    const key = `${a}-${b}-${entries.length}-${sessions.length}`;
    custom.hidden = state.period !== 'custom';
    if (key === loadedFor) return;
    loadedFor = key;
    const mine = ++periodRun;
    ecgNote.textContent = 'Gathering the period’s ECGs…';
    const segs = await gather(a, b).catch(() => []);
    if (mine !== periodRun) return;
    pe = joinSegments(segs, FS);
    topBp.set(readingsBetween(all, a, b), [a, b], (pe?.segments ?? []).map((s) => [s.start, s.start + s.durS * 1000] as [number, number]));
    for (const el of [w.box, p.box, bar, evBar, pieceLine]) el.hidden = !pe;
    if (!pe) { ecgNote.textContent = 'No ECG was recorded in this period.'; return; }
    const n = pe.segments.length, both = pe.segments.filter((s) => s.watch && s.polar).length;
    ecgNote.textContent = `${n} ECG piece${n > 1 ? 's' : ''} from ${clockText(pe.segments[0]!.start)} to ${clockText(pe.segments[n - 1]!.start)}, in time order (${both} with both devices). The slider runs through all of them; the hours between recordings are left out, and the time shown and the mark on the graph give the real date and time. A strip is flat where its device didn’t record.`;
    const we = events(pe.watchA, 'Watch D2'), ppe = events(pe.polarA, 'Polar H10');
    wv.load(pe.watchA, we); pv.load(pe.polarA, ppe);
    spots = [...we, ...ppe].sort((x, y) => x.t - y.t).map((e) => ({ t: e.t, label: e.label }));
    idx = -1;
    evText.textContent = spots.length ? `${spots.length} event${spots.length > 1 ? 's' : ''} in the period` : 'No events in the period';
    const m = matches.find((x) => x.bp.at === pickedAt);
    if (m) jumpTo(m.bp.at); else wv.goTo(Math.max(0, pe.durationS - wv.span)); // the latest
  }

  /** Moves both strips to the ECG at (or nearest) a moment. */
  function jumpTo(ms: number): void {
    if (!pe) return;
    wv.center(stripAt(pe, ms));
  }

  const link = (x: EcgViewer, y: EcgViewer): void => x.addEventListener('move', () => {
    if (linking || !pe) return;
    linking = true;
    y.goTo(x.t0);
    linking = false;
    pos.value = String(Math.round((x.t0 / Math.max(0.001, x.duration - x.span)) * 1000));
    const at = realAt(pe, x.t0);
    time.textContent = `${clockText(at)} · ${fmt(x.span, 1)} s shown`;
    topBp.mark(at, realAt(pe, x.t0 + x.span));
    const seg = segmentAt(pe, x.t0 + x.span / 2);
    if (seg) {
      const end = seg.start + seg.durS * 1000;
      const endText = new Date(end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      const secs = Math.round(seg.durS), dur = secs >= 60 ? `${Math.floor(secs / 60)} min ${secs % 60} s` : `${secs} s`;
      const devices = seg.watch && seg.polar ? 'Watch D2 and Polar H10' : seg.watch ? 'Watch D2 only' : 'Polar H10 only';
      pieceLine.textContent = `ECG shown: ${clockText(seg.start)} to ${endText} · ${dur} · ${devices}`;
    }
  });
  link(wv, pv); link(pv, wv);
  pos.addEventListener('input', () => wv.goTo((Number(pos.value) / 1000) * (wv.duration - wv.span)));
  const goEvent = (i: number): void => {
    const sp = spots[i];
    if (!sp || !pe) return;
    idx = i;
    wv.center(sp.t);
    evText.textContent = `Event ${i + 1} of ${spots.length} at ${clockText(realAt(pe, sp.t))} · ${sp.label}`;
  };
  prevBtn.addEventListener('click', () => goEvent(Math.max(0, idx - 1)));
  nextBtn.addEventListener('click', () => goEvent(Math.min(spots.length - 1, idx + 1)));

  function showPicked(m: BpMatch | null): void {
    shownTitle.textContent = m ? `Blood pressure ${bpText(m.bp)} mmHg at ${dateTime(m.bp.at)}` : 'Blood pressure with the ECGs';
    if (m) jumpTo(m.bp.at);
  }

  function draw(): void {
    const rows = visible();
    if (pickedAt == null || !rows.some((m) => m.bp.at === pickedAt)) pickedAt = rows.reduce<number | null>((a, m) => (a == null || m.bp.at > a ? m.bp.at : a), null);
    table.set(rows, pickedAt == null ? null : String(pickedAt));
    showPicked(rows.find((m) => m.bp.at === pickedAt) ?? null);
    void loadPeriod();
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
    // then any tracking in the period without saved Combined ECG results gets them (worked out once, then saved)
    const tracks = [...new Map(visible().flatMap((m) => (m.tracking && !combined.get(m.tracking.id) ? [[m.tracking.id, m.tracking] as const] : []))).values()];
    let j = 0;
    for (const t of tracks) {
      if (mine !== run) return;
      status.textContent = `Saving the Combined ECG results of tracking ${++j} of ${tracks.length} (once only)…`;
      await new Promise((r) => setTimeout(r, 0));
      combined.set(t.id, await ensureCombined(t).catch(() => null));
      if (j % 3 === 0) { rematch(); table.set(visible(), pickedAt == null ? null : String(pickedAt)); }
    }
    status.textContent = '';
    if (need.size || tracks.length) { rematch(); table.set(visible(), pickedAt == null ? null : String(pickedAt)); }
  }

  function rematch(): void {
    matches = all.map((r) => { const m = matchReading(r, sessions, entries); return { ...m, combined: m.tracking ? combined.get(m.tracking.id) ?? null : null }; });
  }

  async function refresh(): Promise<void> {
    const mine = ++run;
    status.textContent = 'Loading the readings…';
    const user = deps.user();
    const [readings, list] = await Promise.all([deps.readings().catch(() => []), store.listSessions(user as UserNumber).catch(() => [])]);
    if (mine !== run) return;
    all = readings; sessions = list;
    entries = store.loadSyncHistory().filter((e) => e.user === user);
    for (const e of entries) combined.set(e.id, (await store.loadSyncTrace(e.id).catch(() => undefined))?.combined ?? null); // saved with each tracking
    if (mine !== run) return;
    status.textContent = all.length ? '' : 'No blood pressure readings yet. Take one on the Watch D2 and download it with D2 Link.';
    rematch();
    draw();
    void fillIn(mine);
  }

  return { refresh: () => void refresh() };
}
