// Synchronised Tracking History: one row per version of each tracking, each with four reports (Polar H10, D2, Combined,
// Comparison). Versions are generated from the tracking's beats and ECG, and again when blood pressure or the watch's data changes.

import { analyze, sessionMetrics } from './dsp';
import { historyChanged } from './account';
import * as store from './store';
import type { SyncBp, SyncTrackingEntry } from './store';
import {
  combineHr, compareRows, makeVersion, trackingSuggestions, whatChanged,
  type CompareRow, type HrPoint, type SyncTrace, type TimedBeat, type TrackVersion,
} from './synccompare';
import { deleteButton, fmt, make } from './ui';
import { errorMessage } from './util';
import type { D2Api } from './d2/index'; // type only: D2 Link's code stays in d2link.js
import type { TrackingWatchData } from './d2/backup';

type Kind = 'polar' | 'watch' | 'combined' | 'comparison';

/** What keeping the reports up to date needs. */
export interface TrackingReportDeps {
  loadD2: () => Promise<D2Api>;
  account: () => string;
}

export interface SyncReportDeps extends TrackingReportDeps {
  user: () => number;
  /** Generates new versions now, if anything changed. */
  updateReports: () => Promise<boolean>;
  openEcg: (id: string) => void;
  /** Shows the report page, or the history again. */
  show: (view: 'syncReport' | 'syncHistory') => void;
}

/** One tracking, and the version of its reports being shown. */
interface Gathered { e: SyncTrackingEntry; trace: SyncTrace; v: TrackVersion; latest: boolean }

/** Stored watch readings this close to a tracking are shown with it, like blood pressure. */
const NEAR_MS = 3600000;

const dateTime = (ms: number): string => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const n = (v: number | null | undefined, digits = 0): string => (v == null || !Number.isFinite(v) ? '--' : fmt(v, digits));
const madeText = (v: TrackVersion): string => (v.changed === 'new'
  ? `Generated ${dateTime(v.generatedAt)}`
  : `Generated again ${dateTime(v.generatedAt)}, because ${v.changed === 'bp' ? 'the blood pressure readings' : v.changed === 'watch' ? 'the watch’s data' : 'the blood pressure readings and the watch’s data'} changed`);
const signed = (v: number, digits: number): string => { const s = Math.abs(v).toFixed(digits); return `${v < 0 && Number(s) !== 0 ? '-' : '+'}${s}`; };

function button(text: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = make('button', cls, text);
  b.addEventListener('click', onClick);
  return b;
}

function table(head: readonly string[], rows: readonly (readonly string[])[]): HTMLElement {
  const wrap = make('div', 'd2-table-wrap'), t = make('table', 'd2-table'), hr = make('tr');
  for (const h of head) hr.appendChild(make('th', '', h));
  t.appendChild(make('thead')).appendChild(hr);
  const body = make('tbody');
  for (const r of rows) { const tr = make('tr'); for (const c of r) tr.appendChild(make('td', '', c)); body.appendChild(tr); }
  t.appendChild(body);
  wrap.appendChild(t);
  return wrap;
}

function card(title: string, ...content: HTMLElement[]): HTMLElement {
  const s = make('section', 'card');
  s.append(make('h3', 'sync-h', title), ...content);
  return s;
}

/** A heart-rate chart of one or more lines. */
function hrChart(lines: readonly { name: string; color: string; points: readonly HrPoint[] }[], spanS: number): HTMLElement {
  const box = make('div');
  const all = lines.flatMap((l) => l.points.map((p) => p[1]));
  if (!all.length) { box.appendChild(make('p', 'muted', 'No heart rate saved for this tracking.')); return box; }
  const W = 600, H = 180, L = 40, R = 8, T = 8, B = 22;
  const lo = Math.max(30, Math.floor((Math.min(...all) - 5) / 10) * 10), hi = Math.ceil((Math.max(...all) + 5) / 10) * 10;
  const span = Math.max(1, spanS);
  const x = (s: number): number => L + (s / span) * (W - L - R);
  const y = (v: number): number => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'd2-trend');
  const add = (tag: string, attrs: Record<string, string | number>, text?: string): void => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (text) e.textContent = text;
    svg.appendChild(e);
  };
  for (let v = lo; v <= hi; v += (hi - lo) / 4) { add('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'd2-row' }); add('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'd2-axis' }, String(Math.round(v))); }
  const step = [10, 30, 60, 120, 300, 600, 900, 1800, 3600].find((v) => span / v <= 7) ?? 3600;
  for (let s = 0; s <= span; s += step) add('text', { x: x(s), y: H - 6, 'text-anchor': 'middle', class: 'd2-axis' }, mmss(s));
  for (const l of lines) {
    if (l.points.length > 1) add('path', { d: l.points.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(''), fill: 'none', stroke: l.color, 'stroke-width': 2 });
  }
  if (lines.length > 1) {
    const legend = make('div', 'row wrap d2-graph-legend');
    for (const l of lines) { const i = make('span'), d = make('i'); d.style.background = l.color; i.append(d, l.name); legend.appendChild(i); }
    box.appendChild(legend);
  }
  box.appendChild(svg);
  return box;
}

/** The first time: a tracking from before its beats were kept takes them from its ECG, and the ECG's waves are kept. */
async function fromEcg(e: SyncTrackingEntry, t: SyncTrace): Promise<TrackVersion['ecg']> {
  if (!e.ecgId) return null;
  try {
    const { session, samples } = await store.loadSession(e.ecgId);
    if (!session || !samples) return null;
    const s = store.loadSettings(e.user);
    const a = analyze(samples, { fs: session.fs, notch: s.notch, qtcFormula: s.qtcFormula });
    const { hr, ...ecg } = sessionMetrics(a, session.durationS, { hrRest: s.hrRest, hrMax: s.hrMax, sex: s.sex });
    if (!t.polar.length) t.polar = a.beats.flatMap((b): TimedBeat[] => (b.rr && !b.flags.length ? [[b.t, b.rr]] : []));
    if (!t.polarHr.length) t.polarHr = hr.flatMap((v, i): HrPoint[] => (v == null ? [] : [[i, v]]));
    return ecg;
  } catch { return null; } // the ECG was deleted
}

/** Adds a version to every tracking whose blood pressure or watch data changed. Says if anything changed. */
export async function updateTrackingReports(deps: TrackingReportDeps): Promise<boolean> {
  const entries = store.loadSyncHistory();
  if (!entries.length) return false;
  const api = await deps.loadD2().catch(() => null);
  const data = api ? await api.backup.trackingData(deps.account(), entries.map((e) => ({ user: e.user, from: e.start, to: e.start + e.durationS * 1000 })), NEAR_MS).catch(() => null) : null;
  let changed = false;
  for (const [i, e] of entries.entries()) {
    await new Promise((r) => setTimeout(r, 0)); // keep the page responsive
    const trace: SyncTrace = (await store.loadSyncTrace(e.id)) ?? { id: e.id, polar: [], watch: [], polarHr: [], watchHr: [], watchPoor: 0 };
    const reports = trace.reports ?? [];
    const prev = reports[reports.length - 1];
    if (prev && !data) continue; // without D2 Link nothing can be said about the watch's data
    const stored = data?.[i] ?? null, bps = store.syncBps(e);
    const change = whatChanged(prev, bps, stored);
    if (!change) continue;
    const ecg = prev?.ecg ?? await fromEcg(e, trace);
    await store.saveSyncTrace({ ...trace, reports: [...reports, makeVersion(trace, bps, stored, ecg, change, Date.now())] });
    store.saveSyncEntry(e);
    changed = true;
  }
  if (changed) historyChanged();
  return changed;
}

const POLAR_COLOR = 'var(--accent)', WATCH_COLOR = 'var(--series-1)';

const figureRows = (rows: readonly CompareRow[], which: 'polar' | 'watch'): string[][] =>
  rows.flatMap((r) => (r[which] == null ? [] : [[r.name, n(r[which], r.digits)]]));

function bpCard(bps: readonly SyncBp[]): HTMLElement {
  return card('Blood pressure (watch)', bps.length
    ? table(['Time', 'Blood pressure (mmHg)', 'Pulse (bpm)'], bps.map((b) => [clock(b.at), `${n(b.systolic)}/${n(b.diastolic)}`, n(b.pulse)]))
    : make('p', 'muted', 'No reading within one hour before or after the start.'));
}

function ecgRows(m: NonNullable<TrackVersion['ecg']>): string[][] {
  return [
    ['QRS duration (ms)', n(m.qrs)], ['QT (ms)', n(m.qt)], ['QTc (ms)', n(m.qtc)],
    ['T-wave amplitude (µV)', n(m.tAmp)], ['T/R ratio', n(m.trRatio, 2)], ['T wave positive (%)', n(m.tPositive)],
    ['J point (µV)', n(m.jPoint)], ['ST at J+60 ms (µV)', n(m.st60)],
    ['R amplitude (µV)', n(m.rAmp)], ['S amplitude (µV)', n(Math.abs(m.sAmp))],
    ['Events', `${m.eventCount} (${n(m.eventPct, 1)} % of beats)`],
  ];
}

/** `box`: the history page's list; `reportRoot`: the report page. */
export function initSyncReports(box: HTMLElement, reportRoot: HTMLElement, deps: SyncReportDeps): { render: () => void } {
  const backToHistory = (): void => deps.show('syncHistory');

  function reportBar(e: SyncTrackingEntry, kind: Kind, at: number): HTMLElement {
    const bar = make('div', 'row between wrap no-print');
    bar.appendChild(button('← Synchronised Tracking History', '', backToHistory));
    const right = make('div', 'row wrap');
    for (const [k, label] of [['polar', 'Polar H10 report'], ['watch', 'D2 report'], ['combined', 'Combined report'], ['comparison', 'Comparison report']] as const) {
      right.appendChild(button(label, k === kind ? 'primary' : '', () => void openReport(e.id, k, at)));
    }
    const ecgId = e.ecgId;
    if (ecgId) right.appendChild(button('ECG', '', () => deps.openEcg(ecgId)));
    right.appendChild(button('Print / PDF', '', () => window.print()));
    bar.appendChild(right);
    return bar;
  }

  const heading = (title: string, g: Gathered): HTMLElement[] => [
    make('h2', '', title), make('p', 'muted', `${dateTime(g.e.start)} · Duration ${mmss(g.e.durationS)}`),
    ...(g.latest ? [] : [make('p', 'note', `Saved version of this report: ${madeText(g.v)}.`)]),
  ];

  const oldNote = (g: Gathered): HTMLElement[] => (g.trace.watch.length || !g.e.watch ? [] : [make('p', 'note', 'This tracking was saved before beats were kept, so the watch’s figures are limited to its saved summary. The strap’s figures come from the saved ECG, if there is one.')]);

  function polarReport(g: Gathered): HTMLElement[] {
    const rows = figureRows(compareRows(g.v.p, null, g.e.polar, null), 'polar');
    return [
      ...heading('Polar H10 report', g), ...oldNote(g),
      card('Heart rate', hrChart([{ name: 'Polar H10', color: POLAR_COLOR, points: g.trace.polarHr }], g.e.durationS)),
      card('Beats and HRV', table(['Figure', 'Polar H10'], rows.length ? rows : [['No beats saved', '--']])),
      ...(g.v.ecg ? [card('ECG waves', table(['Figure', 'Polar H10'], ecgRows(g.v.ecg)))] : [card('ECG waves', make('p', 'muted', 'No ECG was saved with this tracking.'))]),
    ];
  }

  function storedCards(d: TrackingWatchData | null): HTMLElement[] {
    if (!d) return [make('p', 'note', 'D2 Link could not be loaded, so the watch’s downloaded data isn’t shown.')];
    const out: HTMLElement[] = [];
    if (d.minutes.length) {
      out.push(card('Minute by minute, from the watch’s download', table(['Time', 'Heart rate', 'Resting HR', 'SpO₂ %', 'Steps', 'kcal', 'Metres'],
        d.minutes.map((m) => [clock(m.t * 1000), n(m.hr), n(m.restingHr), n(m.spo2), n(m.steps), m.kcal == null ? '--' : n(m.kcal / 1000), n(m.distance)]))));
    }
    if (d.hrv.length) out.push(card('HRV readings near this tracking', table(['Time', 'RMSSD (ms)'], d.hrv.map((h) => [clock(h.at), n(h.rmssd, 1)]))));
    if (d.stress.length) out.push(card('Stress near this tracking', table(['Time', 'Score', 'Level'], d.stress.map((s) => [`${clock(s.at)}–${clock(s.end)}`, n(s.score), n(s.level)]))));
    if (d.emotion.length) out.push(card('Emotion near this tracking', table(['Time', 'Status', 'Valence', 'Arousal'], d.emotion.map((x) => [clock(x.at), n(x.status), n(x.valence), n(x.arousal)]))));
    if (d.workouts.length) out.push(card('Workouts during this tracking', table(['Start', 'End'], d.workouts.map((w) => [clock(w.at), clock(w.end)]))));
    if (!out.length) out.push(make('p', 'note', 'Nothing downloaded from the watch covers this time yet. Use “Download all data” in D2 Link, then reopen this report.'));
    return out;
  }

  function watchReport(g: Gathered): HTMLElement[] {
    const rows = figureRows(compareRows(null, g.v.w, null, g.e.watch), 'watch');
    if (g.trace.watch.length) rows.push(['Beats marked unusable by the watch', String(g.trace.watchPoor)]);
    return [
      ...heading('D2 report', g), ...oldNote(g),
      card('Heart rate', hrChart([{ name: 'Watch D2', color: WATCH_COLOR, points: g.trace.watchHr }], g.e.durationS)),
      card('Beats and HRV', table(['Figure', 'Watch D2'], rows.length ? rows : [['No beats saved', '--']])),
      bpCard(g.v.bps), ...storedCards(g.v.stored),
    ];
  }

  function combinedReport(g: Gathered): HTMLElement[] {
    const rows = figureRows(compareRows(g.v.c, null, null, null), 'polar');
    const share = g.v.combinedBeats ? (100 * g.v.fromWatch) / g.v.combinedBeats : 0;
    return [
      ...heading('Combined report', g), ...oldNote(g),
      card('How the two are combined', make('p', 'note', `The chest strap’s beats stand, because it measures the heart’s electrical signal. Where it has a gap of over 2.5 s, the watch’s beats fill in. Here ${n(share, 1)} % of the beats came from the watch. The heart rate below is the average of the two each second.`)),
      card('Heart rate', hrChart([{ name: 'Combined', color: POLAR_COLOR, points: combineHr(g.trace.polarHr, g.trace.watchHr) }], g.e.durationS)),
      card('Beats and HRV', table(['Figure', 'Combined'], rows.length ? rows : [['No beats saved', '--']])),
      bpCard(g.v.bps),
      ...(g.v.ecg ? [card('ECG waves (Polar H10 only)', table(['Figure', 'Polar H10'], ecgRows(g.v.ecg)))] : []),
    ];
  }

  /** Readings the watch stored against what the strap measured at that time. */
  function crossChecks(g: Gathered): string[][] {
    const out: string[][] = [];
    const avgAround = (t: number, s: number): number | null => {
      const inRange = g.trace.polarHr.filter((p) => Math.abs(p[0] - t) <= s).map((p) => p[1]);
      return inRange.length ? inRange.reduce((a, b) => a + b, 0) / inRange.length : null;
    };
    const line = (name: string, w: number | null, p: number | null, digits = 0): void => {
      out.push([name, n(w, digits), n(p, digits), w == null || p == null ? '--' : signed(w - p, 1)]);
    };
    for (const m of g.v.stored?.minutes ?? []) {
      if (m.hr != null) line(`Stored heart rate, ${clock(m.t * 1000)} (bpm)`, m.hr, avgAround(m.t - g.e.start / 1000 + 30, 30));
    }
    for (const b of g.v.bps) {
      if (b.pulse != null) line(`Blood pressure pulse, ${clock(b.at)} (bpm)`, b.pulse, avgAround((b.at - g.e.start) / 1000, 30) ?? g.v.p?.meanHr ?? null);
    }
    for (const h of g.v.stored?.hrv ?? []) line(`Stored HRV reading, ${clock(h.at)} (ms)`, h.rmssd, g.v.p?.rmssd ?? null, 1);
    return out;
  }

  function comparisonReport(g: Gathered): HTMLElement[] {
    const a = g.v.agreement;
    const rows = compareRows(g.v.p, g.v.w, g.e.polar, g.e.watch).filter((r) => r.polar != null || r.watch != null).map((r) => {
      const d = r.polar != null && r.watch != null ? r.watch - r.polar : null;
      return [r.name, n(r.polar, r.digits), n(r.watch, r.digits), d == null ? '--' : signed(d, Math.max(1, r.digits)), d == null || !r.polar ? '--' : `${signed((100 * d) / r.polar, 1)} %`];
    });
    const checks = crossChecks(g);
    const tips = make('ul', 'tips');
    for (const s of trackingSuggestions(g.v.p, g.v.w, a, g.e.durationS, g.trace.watchPoor, g.v.bps.length > 0)) tips.appendChild(make('li', '', s));
    return [
      ...heading('Comparison report', g), ...oldNote(g),
      card('Heart rate', hrChart([{ name: 'Polar H10', color: POLAR_COLOR, points: g.trace.polarHr }, { name: 'Watch D2', color: WATCH_COLOR, points: g.trace.watchHr }], g.e.durationS)),
      card('Heart rate agreement', a
        ? table(['Measure', 'Value'], [
          ['Average difference, watch minus Polar (bpm)', signed(a.bias, 1)],
          ['Limits of agreement (bpm)', `${signed(a.low, 1)} to ${signed(a.high, 1)}`],
          ['Average size of the difference (bpm)', n(a.mae, 1)],
          ['5-second stretches within ±5 bpm (%)', n(a.within5Pct)],
          ['Correlation', n(a.r, 2)],
          ['5-second stretches compared', String(a.bins)],
        ])
        : make('p', 'muted', 'Second-by-second heart rate from both devices is needed for this.')),
      card('Every figure side by side', rows.length ? table(['Figure', 'Polar H10', 'Watch D2', 'Difference', 'Difference %'], rows) : make('p', 'muted', 'No figures saved.'), make('p', 'note', 'Difference = watch minus Polar. Only the strap records ECG waves: see the Polar H10 report.')),
      ...(checks.length ? [card('Stored watch readings against the strap', table(['Reading', 'Watch D2', 'Polar H10', 'Difference'], checks), make('p', 'note', 'A reading taken outside the tracking is compared with the strap’s average for the whole tracking, so a larger difference there is expected.'))] : []),
      card('How to improve accuracy', tips),
    ];
  }

  /** `at` picks an earlier version by when it was generated; without it, the latest. */
  async function openReport(id: string, kind: Kind, at?: number): Promise<void> {
    deps.show('syncReport');
    reportRoot.replaceChildren(make('div', 'busy', 'Opening the report…'));
    await new Promise((r) => setTimeout(r, 30));
    try {
      await deps.updateReports();
      const e = store.loadSyncHistory().find((x) => x.id === id);
      const trace = e && await store.loadSyncTrace(id);
      const versions = trace?.reports ?? [];
      const latest = versions[versions.length - 1];
      const v = versions.find((x) => x.generatedAt === at) ?? latest;
      if (!e || !trace || !v) { reportRoot.replaceChildren(button('← Synchronised Tracking History', '', backToHistory), make('p', 'muted', 'This tracking is no longer in the history.')); return; }
      const g: Gathered = { e, trace, v, latest: v === latest };
      const body = kind === 'polar' ? polarReport(g) : kind === 'watch' ? watchReport(g) : kind === 'combined' ? combinedReport(g) : comparisonReport(g);
      reportRoot.replaceChildren(reportBar(e, kind, v.generatedAt), ...body);
    } catch (err) {
      reportRoot.replaceChildren(button('← Synchronised Tracking History', '', backToHistory), make('p', 'muted', `This report could not be made: ${errorMessage(err)}`));
    }
    window.scrollTo(0, 0);
  }

  async function render(): Promise<void> {
    const entries = store.loadSyncHistory().filter((e) => e.user === deps.user());
    if (!entries.length) { box.replaceChildren(make('p', 'muted', 'No synchronised tracking yet on this device.')); return; }
    const list = make('ul', 'sessions');
    for (const e of entries) {
      const versions = (await store.loadSyncTrace(e.id).catch(() => undefined))?.reports ?? [];
      const ecgId = e.ecgId;
      const when = `${dateTime(e.start)} · ${mmss(e.durationS)}`, tag = ecgId ? 'with ECG' : 'no ECG';
      const remove = deleteButton('this tracking', () => {
        void (async () => {
          if (ecgId && window.confirm('Also delete its ECG from ECG history? (Cancel keeps the ECG.)')) { await store.deleteSession(ecgId); historyChanged(); }
          await store.removeSyncEntry(e.id);
          historyChanged();
          void render();
        })();
      }, 'Delete this tracking from the history?');
      if (!versions.length) {
        const li = make('li', 'sync-sleep-row');
        const actions = make('div', 'row wrap sync-sleep-actions');
        actions.appendChild(remove);
        li.append(make('span', 'when', when), make('span', 'dur', tag), make('span', 'muted sync-sleep-made', 'Generating the reports…'), actions);
        list.appendChild(li);
        continue;
      }
      // one row per version, newest first, each with its four reports
      for (let i = versions.length; i >= 1; i--) {
        const v = versions[i - 1]!;
        const hr = (f: TrackVersion['p'], s: SyncTrackingEntry['polar']): number | null => f?.meanHr ?? s?.hr ?? null;
        const rm = (f: TrackVersion['p'], s: SyncTrackingEntry['polar']): number | null => f?.rmssd ?? s?.rmssd ?? null;
        const ph = hr(v.p, e.polar), wh = hr(v.w, e.watch);
        const side = (name: string, s: SyncTrackingEntry['polar'], f: TrackVersion['p']): string => (s || f ? `${name} ${n(hr(f, s))} bpm, RMSSD ${n(rm(f, s))} ms` : `${name} not connected`);
        const li = make('li', 'sync-sleep-row');
        li.append(
          make('span', 'when', `${when}${versions.length > 1 ? ` · Version ${i} of ${versions.length}${i === versions.length ? ' (latest)' : ''}` : ''}`),
          make('span', 'dur', tag),
          make('span', 'stats', `${side('Polar H10', e.polar, v.p)} · ${side('Watch D2', e.watch, v.w)}${ph == null || wh == null ? '' : ` · ${signed(wh - ph, 1)} bpm`}`),
          make('span', 'muted sync-sleep-made', `${v.bps.length ? `Blood pressure ${v.bps.map((b) => `${n(b.systolic)}/${n(b.diastolic)} at ${clock(b.at)}`).join(', ')}` : 'No blood pressure reading'} · ${madeText(v)}`),
        );
        const actions = make('div', 'row wrap sync-sleep-actions');
        for (const [k, label] of [['polar', 'Polar H10 report'], ['watch', 'D2 report'], ['combined', 'Combined report'], ['comparison', 'Comparison report']] as const) {
          actions.appendChild(button(label, 'small', () => void openReport(e.id, k, v.generatedAt)));
        }
        if (ecgId) actions.appendChild(button('ECG', 'small', () => deps.openEcg(ecgId)));
        if (i === versions.length) actions.appendChild(remove); // the tracking goes, with all its versions
        li.appendChild(actions);
        list.appendChild(li);
      }
    }
    box.replaceChildren(make('p', 'note', 'Each tracking has four reports. When its blood pressure or the watch’s data changes, new reports are generated and the earlier ones stay as a version. Blood pressure: every reading taken on the watch within one hour before or after the start.'), list);
  }

  /** Shows the list now, then again if new versions were generated. */
  const refresh = (): void => {
    void render().then(() => deps.updateReports()).then((changed) => { if (changed) void render(); }).catch(() => undefined);
  };

  return { render: refresh };
}
