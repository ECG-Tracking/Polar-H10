// Synchronised ECG Tracking History: one row per version of each tracking, with its Polar H10 report and the two-ECG report (the D2,
// Combined and Comparison reports are no longer offered: the two-ECG report holds what they added). Formerly: (Polar H10, D2, Combined,
// Comparison). Versions are generated from the tracking's beats and ECG, and again when blood pressure or the watch's data changes.

import { during } from './diagnostics';
import { analyze, cleanInterval, sessionMetrics, EVENT_LABELS, type Analysis, type SessionMetrics } from './dsp';
import { BpStrip, EcgViewer, type ReportEvent } from './charts';
import { referenceRanges, checkRange, fmtRange, type Range, type ReferenceRanges } from './ranges';
import { agreedEvents, beatAgreement, flaggedOnEither, joinStrips, matchStrips, ONE_EVENT_S, SAME_BEAT_MS, type MatchedStrip, type StripIn, type StripSet } from './stripmatch';
import { historyChanged } from './account';
import { retireVersion } from './oldversions';
import * as store from './store';
import type { SyncBp, SyncTrackingEntry } from './store';
import {
  combineHr, compareRows, makeVersion, trackingSuggestions, whatChanged,
  type CompareRow, type HrPoint, type SyncTrace, type TimedBeat, type TrackVersion,
} from './synccompare';
import { deleteButton, fmt, make, renderOutliers, whenLine, type Outlier } from './ui';
import { errorMessage } from './util';
import type { D2Api } from './d2/index'; // type only: D2 Link's code stays in d2link.js
import type { TrackingWatchData } from './d2/backup';

type Kind = 'polar' | 'watch' | 'combined' | 'comparison' | 'ecg';

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
interface Gathered { e: SyncTrackingEntry; trace: SyncTrace; v: TrackVersion; latest: boolean; strips: Strips | null; why?: string }

/**
 * Why there is no Combined ECG, in words: the strips and the strap's full ECG are kept only on the device that recorded
 * them (other devices have summary copies), and an error is said rather than hidden behind "no strips".
 */
async function whyNoStrips(e: SyncTrackingEntry, failed: string | null): Promise<string> {
  const end = e.start + e.durationS * 1000;
  const all = await store.listSessions(e.user as store.UserNumber).catch(() => []);
  const strips = all.filter((s) => s.source === 'watch' && s.start < end && s.start + s.durationS * 1000 > e.start);
  if (failed) return `The watch’s strips couldn’t be put together with the strap’s ECG: ${failed}`;
  if (strips.length && strips.every((s) => s.cloudOnly)) return `The watch took ${strips.length} ECG strip${strips.length === 1 ? '' : 's'} during this tracking, but only their summaries are on this device. Their full ECG is kept on the computer or browser that recorded them: open the Combined ECG there.`;
  if (!strips.length) return 'No ECG strips from the watch were saved during this tracking. During a tracking, press Start watch ECG on this page, then take 30-second ECGs on the watch (fingertip on its lower button) until you stop. Each one appears here within seconds.';
  const polar = e.ecgId ? (await store.loadSession(e.ecgId).catch(() => ({ session: undefined, samples: undefined }))) : null;
  if (!polar?.session) {
    const binned = e.ecgId && (await store.listBin().catch(() => [])).some((b) => b.kind === 'ecg' && b.session.id === e.ecgId);
    if (binned) return 'The Polar H10 ECG of this tracking was deleted: it is in the Bin. Restore it from the Bin and the Combined ECG can be made.';
    return 'The Polar H10 ECG of this tracking isn’t on this device, so the watch’s strips have nothing to be lined up with.';
  }
  if (!polar.samples) return 'Only a summary of the Polar H10 ECG is on this device. Its full ECG is on the computer or browser that recorded it: open the Combined ECG there.';
  return 'The watch’s strips don’t overlap the strap’s ECG, so they can’t be shown together.';
}

/** The watch's 30-second ECG strips taken during a tracking, joined, and lined up with the strap's ECG when it has one. */
interface Strips {
  /** Strips left out because v1.39.0 cut them off and they couldn't be fetched again. */
  damaged: number;
  joined: NonNullable<ReturnType<typeof joinStrips>>;
  joinedM: SessionMetrics;
  set: StripSet | null;
  watchM: SessionMetrics | null;
  polarM: SessionMetrics | null;
}

const STRIP_FS = 130;

async function gatherStrips(e: SyncTrackingEntry): Promise<Strips | null> {
  const end = e.start + e.durationS * 1000;
  const sessions = (await store.listSessions(e.user as store.UserNumber))
    .filter((s) => s.source === 'watch' && !s.cloudOnly && s.start < end && s.start + s.durationS * 1000 > e.start);
  if (!sessions.length) return null;
  const s = store.loadSettings(e.user);
  const opts = { notch: s.notch, qtcFormula: s.qtcFormula };
  const ins: StripIn[] = [];
  let damaged = 0;
  for (const x of sessions) {
    const { samples } = await store.loadSession(x.id);
    // a strip from v1.39.0 cut off by its scale error (the watch no longer had it to repair) would skew the wave figures
    if (samples && !x.watchFs && cutOff(samples)) { damaged++; continue; }
    if (samples) ins.push({ id: x.id, start: x.start, samples, fs: x.fs });
  }
  if (!ins.length) return null;
  const joined = joinStrips(ins, STRIP_FS, opts);
  if (!joined) return null;
  let set: StripSet | null = null;
  if (e.ecgId) {
    const { session, samples } = await store.loadSession(e.ecgId);
    if (session && samples && session.fs === STRIP_FS) set = matchStrips(ins, session.start, samples, STRIP_FS, opts);
  }
  const profile = { hrRest: s.hrRest, hrMax: s.hrMax, sex: s.sex };
  const metrics = (a: Analysis): SessionMetrics => sessionMetrics(a, a.x.length / a.fs, profile);
  // the figures leave out every heartbeat either device flagged (the events are counted separately)
  const both = set ? flaggedOnEither(set.watchA, set.polarA) : null;
  return { damaged, joined, joinedM: metrics(joined.watchA), set, watchM: both ? metrics(both.watchA) : null, polarM: both ? metrics(both.polarA) : null };
}

/** Over 1 % of samples at the 16-bit limit: cut off. */
function cutOff(uv: Int16Array): boolean {
  let n = 0;
  for (const v of uv) if (v >= 32767 || v <= -32768) n++;
  return n > uv.length / 100;
}

/** Figures from an ECG, as the Polar H10 report shows them: [name, value, decimals]. */
const ecgFigures = (m: SessionMetrics): [string, number, number][] => [
  ['Average heart rate (bpm)', m.meanHR, 0], ['RMSSD (ms)', m.rmssd, 1], ['SDNN (ms)', m.sdnn, 1], ['pNN50 (%)', m.pnn50, 1],
  ['QRS duration (ms)', m.qrs, 0], ['QT (ms)', m.qt, 0], ['QTc (ms)', m.qtc, 0],
  ['R amplitude (µV)', m.rAmp, 0], ['S amplitude (µV)', Math.abs(m.sAmp), 0], ['T-wave amplitude (µV)', m.tAmp, 0], ['T/R ratio', m.trRatio, 2],
  ['Events', m.eventCount, 0],
];

/**
 * The H10 ECG report's layout with two readings per box: the strap's and the watch's for the same moments, with the same
 * normal ranges: the values outside them listed first, then Rhythm and HRV, and ECG waves. Events count only where both
 * devices saw one at the same heartbeat.
 */
function pairBoxes(p: SessionMetrics, w: SessionMetrics, events: { polar: number; watch: number }, user: number): HTMLElement {
  const s = store.loadSettings(user as store.UserNumber);
  const R = referenceRanges(s);
  const [, , z2, z3, z4, z5] = p.zones;
  const exercise = (z2 + z3 + z4 + z5) / (p.zones.reduce((a, b) => a + b, 0) || 1) > 0.3;
  const qtcName = s.qtcFormula === 'fridericia' ? 'Fridericia' : 'Bazett';
  const outliers: Outlier[] = [];
  const devices = [['Polar H10', p], ['Watch D2', w]] as const;
  type Tile = { k: string; unit: string; f: (m: SessionMetrics) => number; hint?: string; key?: keyof ReferenceRanges; digits?: number; text?: (m: SessionMetrics) => string; range?: Range; refText?: string };
  const tile = (o: Tile): HTMLElement => {
    const el = make('div', 'metric');
    el.appendChild(make('div', 'k', o.k));
    const range = o.range ?? (o.key && !(exercise && R[o.key].rest) ? R[o.key] : undefined);
    const flags: HTMLElement[] = [];
    for (const [who, m] of devices) {
      const v = o.f(m), line = make('div', 'pair-line');
      const shown = o.text ? o.text(m) : Number.isFinite(v) ? fmt(v, o.digits ?? 0) : '--';
      const val = make('span', 'v', shown);
      if (o.unit && shown !== '--') val.appendChild(make('small', '', o.unit));
      line.append(make('span', 'pair-who', who), val);
      el.appendChild(line);
      const status = range ? checkRange(range, v) : null;
      if (status && range) {
        const label = status === 'high' ? range.highLabel : range.lowLabel;
        line.classList.add('out');
        el.classList.add('out');
        flags.push(make('div', 'flag', `${status === 'high' ? '▲' : '▼'} ${who}: ${label ?? (status === 'high' ? 'above range' : 'below range')}`));
        const rangeText = o.refText ?? `${fmtRange(range)}${o.unit ? ` ${o.unit}` : ''}`;
        outliers.push({ name: `${o.k} (${who})`, value: o.key === undefined && o.range ? `${fmt(v, 1)} % of beats` : `${shown}${o.unit ? ` ${o.unit}` : ''}`, range: rangeText, status });
      }
    }
    if (o.hint) el.appendChild(make('div', 'h', o.hint));
    if (range) el.appendChild(make('div', 'ref', `Ref ${o.refText ?? `${fmtRange(range)}${o.unit ? ` ${o.unit}` : ''}`}${range.note ? ` · ${range.note}` : ''}`));
    else if (o.key && exercise) el.appendChild(make('div', 'ref', 'Resting range not applied (exercise)'));
    el.append(...flags);
    return el;
  };
  // events: those both saw, as a share of each device's beats
  const pct = (m: SessionMetrics): number => (m.beatCount ? (100 * (m === p ? events.polar : events.watch)) / m.beatCount : NaN);
  const rhythm = [
    tile({ k: 'Mean heart rate', unit: 'bpm', f: (m) => m.meanHR, hint: 'from normal beats', key: 'meanHR' }),
    tile({ k: 'HRV score', unit: '', f: (m) => m.hrvScore, hint: '15 × ln(RMSSD)', key: 'hrvScore' }),
    tile({ k: 'RMSSD', unit: 'ms', f: (m) => m.rmssd, key: 'rmssd' }),
    tile({ k: 'SDNN', unit: 'ms', f: (m) => m.sdnn, key: 'sdnn' }),
    tile({ k: 'pNN50', unit: '%', f: (m) => m.pnn50, hint: 'successive Δ > 50 ms', key: 'pnn50', digits: 1 }),
    tile({ k: 'pNN200', unit: '%', f: (m) => m.pnn200, hint: 'successive Δ > 200 ms', key: 'pnn200', digits: 1 }),
    tile({ k: 'Poincaré SD1 / SD2', unit: 'ms', f: () => NaN, text: (m) => `${fmt(m.sd1)} / ${fmt(m.sd2)}` }),
    tile({ k: 'Events', unit: '', f: pct, text: (m) => `${m === p ? events.polar : events.watch} · ${fmt(pct(m), 1)} %`, hint: 'only where both devices saw it · % of beats', range: { ...R.eventPct, note: 'of beats' }, refText: `${fmtRange(R.eventPct)} %` }),
  ];
  const waves = [
    tile({ k: 'QRS duration', unit: 'ms', f: (m) => m.qrs, hint: 'median beat', key: 'qrs' }),
    tile({ k: 'QT', unit: 'ms', f: (m) => m.qt, hint: 'median beat · -- where the T wave is too flat to measure reliably' }),
    tile({ k: 'QTc', unit: 'ms', f: (m) => m.qtc, hint: `${qtcName}, median beat · -- where the T wave is too flat to measure reliably`, key: 'qtc' }),
    tile({ k: 'T wave positive', unit: '%', f: (m) => m.tPositive, key: 'tPositive' }),
    tile({ k: 'T-wave amplitude', unit: 'µV', f: (m) => m.tAmp, hint: 'median, vs PR baseline', key: 'tAmp' }),
    tile({ k: 'T/R ratio', unit: '', f: (m) => m.trRatio, hint: 'T size ÷ R wave size, median', key: 'trRatio', digits: 2 }),
    tile({ k: 'J point', unit: 'µV', f: (m) => m.jPoint, hint: 'vs PR baseline', key: 'jPoint' }),
    tile({ k: 'ST at J+60 ms', unit: 'µV', f: (m) => m.st60, key: 'st60' }),
    tile({ k: 'R amplitude', unit: 'µV', f: (m) => m.rAmp, hint: 'tallest upward wave; no reference range' }),
    tile({ k: 'S amplitude', unit: 'µV', f: (m) => Math.abs(m.sAmp), hint: 'depth of the deepest downward wave; no reference range' }),
    tile({ k: '2–8 Hz energy', unit: '%', f: (m) => m.hf, hint: 'can include noise; no reference range', digits: 1 }),
  ];
  const box = make('div', 'pair-report');
  const flags = make('div');
  renderOutliers(flags, outliers, ['The watch records lead I (wrist to fingertip), the strap a chest lead: wave sizes can differ even when both are right.']);
  const group = (title: string, tiles: HTMLElement[]): HTMLElement[] => { const g = make('div', 'metrics pair-metrics'); g.append(...tiles); return [make('h3', '', title), g]; };
  box.append(flags, ...group('Rhythm and HRV', rhythm), ...group('ECG waves', waves));
  return box;
}

/** Events that count: the strap's confirmed by the watch, and the watch's confirmed by the strap (a normal beat on the strap means no event). */
function bothEvents(set: StripSet): { polar: number; watch: number } {
  const polar = agreedEvents(set).filter((e) => e.agreed).length;
  const pt = set.polarA.events.map((e) => e.t);
  let watch = 0, last = -Infinity;
  for (const e of set.watchA.events) {
    if (e.t - last <= ONE_EVENT_S) continue;
    if (pt.some((t) => Math.abs(t - e.t) <= SAME_BEAT_MS / 1000)) { watch++; last = e.t; }
  }
  return { polar, watch };
}

/** How long the spliced ECG is: the strips' time together, without the joins. */
const splicedText = (strips: readonly MatchedStrip[]): string => {
  const s = strips.reduce((a, x) => a + x.durationS, 0);
  return `Combined duration ${mmss(s)} (${strips.length} strip${strips.length === 1 ? '' : 's'} spliced together)`;
};

/** The user number and alias on the right of each row, e.g. "1:M". */
export function userTag(user: number): string {
  const alias = store.loadSettings(user as store.UserNumber).alias;
  return `${user}${alias ? `:${alias}` : ''}`;
}

/** A tracking's second line, the same everywhere it is listed: what was recorded, and how long. */
/** `durationS`: the combined duration of the spliced strips, where both ECGs are shown together; otherwise the tracking's. */
export function trackingLine(e: SyncTrackingEntry, bp: boolean, polar: boolean, watch: boolean, durationS = e.durationS): string {
  return [
    polar || e.polar || e.ecgId ? 'Polar H10' : null,
    watch || (e.watch && e.watch.beats > 0) ? 'Watch D2' : null, // a watch that sent no beats (an old stale heart rate) isn't listed
    bp || e.bps?.length || e.bp ? 'BP recorded' : null,
    `Duration ${mmss(durationS)}`,
  ].filter(Boolean).join(' · ');
}

/** Clock time of a moment in the joined ECGs. */
/** The real moment (ms) of a time in the joined strips. */
function realAt(strips: readonly MatchedStrip[], t: number): number | null {
  const s = [...strips].reverse().find((x) => x.at <= t + 1e-6) ?? strips[0];
  return s ? s.start + (t - s.at) * 1000 : null;
}

function clockAt(strips: readonly MatchedStrip[], t: number): string {
  const s = [...strips].reverse().find((x) => x.at <= t + 1e-6) ?? strips[0];
  return s ? new Date(s.start + (t - s.at) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '--';
}

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
    if (!t.polar.length) t.polar = a.beats.flatMap((b, k): TimedBeat[] => (b.rr && cleanInterval(a.beats, k) ? [[b.t, b.rr]] : []));
    if (!t.polarHr.length) t.polarHr = hr.flatMap((v, i): HrPoint[] => (v == null ? [] : [[i, v]]));
    return ecg;
  } catch { return null; } // the ECG was deleted
}

/** Adds a version to every tracking whose blood pressure or watch data changed. Says if anything changed. */
export async function updateTrackingReports(deps: TrackingReportDeps): Promise<boolean> {
  return during('tracking reports', () => updateTrackingReportsNow(deps));
}

async function updateTrackingReportsNow(deps: TrackingReportDeps): Promise<boolean> {
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
export function initSyncReports(box: HTMLElement, reportRoot: HTMLElement, deps: SyncReportDeps): { render: () => void; openPair: (id: string, back: { label: string; go: () => void }) => void; pairInto: (root: HTMLElement, id: string, opts?: { compact?: boolean; bp?: BpStrip }) => Promise<void> } {
  /** Where ← goes: Synchronised ECG Tracking History, or ECG history when the pair was opened from there. */
  let backTo: { label: string; go: () => void } | null = null;
  const backToHistory = (): void => { if (backTo) backTo.go(); else deps.show('syncHistory'); };

  function reportBar(e: SyncTrackingEntry, kind: Kind, at: number): HTMLElement {
    const bar = make('div', 'row between wrap no-print');
    bar.appendChild(button(`← ${backTo?.label ?? 'Synchronised ECG Tracking History'}`, '', backToHistory));
    const right = make('div', 'row wrap');
    for (const [k, label] of [['polar', 'Polar H10 report']] as const) {
      right.appendChild(button(label, k === kind ? 'primary' : '', () => void openReport(e.id, k, at)));
    }
    right.appendChild(button('Combined ECG', kind === 'ecg' ? 'primary' : '', () => void openReport(e.id, 'ecg', at)));
    right.appendChild(button('Print / PDF', '', () => window.print()));
    bar.appendChild(right);
    return bar;
  }

  const heading = (title: string, g: Gathered, durationS = g.e.durationS): HTMLElement[] => [
    make('h2', '', title), make('p', 'muted', `${dateTime(g.e.start)} · Duration ${mmss(durationS)}`),
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
      ...watchStripCards(g),
      bpCard(g.v.bps), ...storedCards(g.v.stored),
    ];
  }

  /** The D2 report's strips: all of them analysed together, as the Polar H10 report analyses its ECG. */
  function watchStripCards(g: Gathered): HTMLElement[] {
    const st = g.strips;
    if (!st) return [card('ECG strips from the watch', make('p', 'muted', 'No 30-second ECG strips were taken on the watch during this tracking. Take them with “Start watch ECG” on Synchronised ECG Tracking or ECG live.'))];
    const list = make('ul', 'watch-ecg-list');
    for (const s of st.joined.strips) {
      const li = make('li');
      li.append(make('span', '', `${clock(s.start)}:${String(new Date(s.start).getSeconds()).padStart(2, '0')} · ${n(s.durationS)} s`), button('Open', 'sync-open', () => deps.openEcg(s.id)));
      list.appendChild(li);
    }
    const total = st.joined.strips.reduce((a, s) => a + s.durationS, 0);
    return [card(`ECG strips from the watch (${st.joined.strips.length}, combined duration ${mmss(total)})`,
      table(['Figure', 'Watch D2 strips'], ecgFigures(st.joinedM).map(([k, v, d]) => [k, n(v, d)])),
      make('p', 'note', 'Every strip taken during the tracking, analysed together as one recording; the joins between strips are left out of every figure.'),
      list)];
  }

  /** The comparison report's strips: each one against the strap's ECG of the same moments, beat for beat. */
  function stripComparison(g: Gathered): HTMLElement[] {
    const st = g.strips;
    if (!st) return [];
    const set = st.set;
    if (!set || !st.watchM || !st.polarM) return [card('ECG strips: watch against Polar H10', make('p', 'muted', g.e.ecgId ? 'None of the watch’s strips overlaps the strap’s ECG.' : 'This tracking has no Polar H10 ECG to compare the strips with.'))];
    const a = beatAgreement(set);
    const wm = st.watchM, pm = st.polarM;
    const rows = ecgFigures(pm).map(([k, p, d], i) => {
      const w = ecgFigures(wm)[i]?.[1] ?? NaN, diff = w - p;
      return [k, n(p, d), n(w, d), Number.isFinite(diff) ? signed(diff, Math.max(1, d)) : '--', Number.isFinite(diff) && p ? `${signed((100 * diff) / p, 1)} %` : '--'];
    });
    return [card('ECG strips: watch against Polar H10, beat for beat',
      make('p', 'pair-duration', splicedText(set.strips)),
      make('p', 'note', `Only the moments the watch recorded: the strap’s ECG is cut to match each of the ${set.strips.length} strip${set.strips.length === 1 ? '' : 's'} and pieced together the same way.`),
      table(['Measure', 'Value'], [
        ['Watch beats that are also strap beats (%)', n(a.watchMatchedPct, 1)],
        ['Strap beats the watch also found (%)', n(a.polarFoundPct, 1)],
        ['Beat intervals compared', String(a.intervals)],
        ['Interval difference, watch minus strap (ms)', Number.isFinite(a.rrBias) ? signed(a.rrBias, 1) : '--'],
        ['Average size of the interval difference (ms)', n(a.rrMae, 1)],
        ['Intervals within ±10 ms (%)', n(a.within10Pct)],
      ]),
      table(['Figure', 'Polar H10 (same moments)', 'Watch D2 strips', 'Difference', 'Difference %'], rows),
      table(['Strip (watch’s time)', 'Shift to match the strap (s)', 'Length (s)', 'Beats lined up'],
        set.strips.map((s) => [clockAt([s], s.at), signed(s.offsetMs / 1000, 2), n(s.durationS), `${s.matched} of ${s.watchBeats}`])),
      make('p', 'note', 'Difference = watch minus strap. The watch records lead I (wrist to fingertip) and the strap a chest lead, so wave sizes and shapes are expected to differ; timing (heart rate, intervals, QRS and QT) should agree. The watch’s clock only gives whole seconds, so each strip is shifted to line up with the strap.'))];
  }

  /** The combined report's strips: the strap's ECG of the same moments, with only the events both devices saw. */
  function stripCombined(g: Gathered): HTMLElement[] {
    const st = g.strips, set = st?.set;
    if (!st || !set || !st.polarM) return [];
    const ev = agreedEvents(set), both = ev.filter((x) => x.agreed), strapOnly = ev.filter((x) => !x.agreed);
    const watchOnly = set.watchA.events.length - bothEvents(set).watch;
    // the figures are in the boxes at the top; here only what they don't show: which beats and events both saw
    return [card('Heartbeats and events both devices saw',
      make('p', 'note', 'Only the moments the watch recorded, beat for beat with the strap. An event counts only if both devices show one at the same heartbeat.'),
      table(['Figure', 'Combined'], [
        ['Heartbeats both found', String(set.pairs.length)],
        ['Events both agree on', String(both.length)], ['Strap events where the watch shows a normal beat (not counted)', String(strapOnly.length)],
        ['Watch events where the strap shows a normal beat (not counted)', String(Math.max(0, watchOnly))],
      ]),
      ...(ev.length ? [table(['Time', 'Event', 'Counted'], ev.map((x) => [clockAt(set.strips, x.t), EVENT_LABELS[x.type], x.agreed ? 'Yes: both' : 'No: strap only']))] : []))];
  }

  /** Both ECGs one above the other, moving together; with the comparison and combined figures. */
  /** `compact`: only the two ECGs, their slider and the events, for another page; `bp`: that page's BP graph, marked as they move. */
  function ecgPairReport(g: Gathered, opts: { compact?: boolean; bp?: BpStrip } = {}): { body: HTMLElement[]; after: () => void } {
    const st = g.strips, set = st?.set;
    const ecgId = g.e.ecgId;
    if ((!st || !set) && opts.compact) {
      return { body: [make('p', 'muted', g.why ?? 'The watch’s strips don’t overlap the strap’s ECG, so they can’t be shown together.'),
        ...(ecgId ? [button('Open the Polar H10 ECG', 'primary', () => deps.openEcg(ecgId))] : [])], after: () => undefined };
    }
    if (!st || !set) {
      return { body: [...heading('Combined ECG: watch strips and Polar H10', g), make('p', 'muted', g.why ?? 'The watch’s strips don’t overlap the strap’s ECG, so they can’t be shown together.'),
        ...(ecgId ? [button('Open the Polar H10 ECG', 'primary', () => deps.openEcg(ecgId))] : [])], after: () => undefined };
    }
    const agreed = agreedEvents(set);
    const wEvents: ReportEvent[] = set.watchA.events.map((e) => ({ t: e.t, type: e.type, label: EVENT_LABELS[e.type] }));
    const pEvents: ReportEvent[] = agreed.map((e) => ({ t: e.t, type: e.type, label: `${EVENT_LABELS[e.type]}${e.agreed ? ' (both)' : ' (strap only)'}` }));
    const mk = (title: string, label: string): { box: HTMLElement; canvas: HTMLCanvasElement } => {
      const canvas = make('canvas');
      canvas.setAttribute('aria-label', label);
      const box = make('div', 'card viewer');
      box.append(make('h3', 'sync-h', title), canvas);
      return { box, canvas };
    };
    const w = mk('Watch D2: the strips joined', 'ECG strips from the watch, joined'), p = mk('Polar H10: the same moments', 'The strap’s ECG of the same moments');
    // the tracking's blood pressure readings above both ECGs; the marker follows what they show
    const bp = opts.bp ?? new BpStrip(), trackEnd = g.e.start + g.e.durationS * 1000;
    if (!opts.bp) bp.set(g.v.bps, [g.e.start - NEAR_MS, trackEnd + NEAR_MS], [g.e.start, trackEnd]);
    const bpBox = make('div', 'card viewer bp-card');
    bpBox.appendChild(bp.el);
    const wv = new EcgViewer(w.canvas), pv = new EcgViewer(p.canvas);
    const pos = make('input');
    Object.assign(pos, { type: 'range', min: '0', max: '1000', value: '0' });
    pos.setAttribute('aria-label', 'Position in both ECGs');
    const time = make('span', 'muted', '');
    // one entry per heartbeat: the strap's and the watch's marks of the same beat (a few tens of ms apart on the two
    // leads), and a premature beat with the pause right after it, are one event
    type Spot = { t: number; watch: ReportEvent[]; polar: ReportEvent[] };
    const spots: Spot[] = [];
    for (const [who, e] of [...wEvents.map((x) => ['watch', x] as const), ...pEvents.map((x) => ['polar', x] as const)].sort((a, b) => a[1].t - b[1].t)) {
      const last = spots[spots.length - 1];
      const spot = last && e.t - last.t <= ONE_EVENT_S ? last : (spots[spots.length] = { t: e.t, watch: [], polar: [] });
      spot[who].push(e);
      if (who === 'polar' && spot.polar.length === 1) spot.t = e.t; // centred on the strap's beat
    }
    // as for counting: an event only where both devices saw it; one seen by just one of them is no event
    const counted = spots.filter((s) => s.watch.length && s.polar.length);
    spots.length = 0;
    spots.push(...counted);
    const both = spots.length;
    const all = spots.map((s) => s.t);
    const shownW = spots.flatMap((s) => s.watch), shownP = spots.flatMap((s) => s.polar);
    let idx = -1;
    const evText = make('span', 'muted', both ? `${both} event${both > 1 ? 's' : ''}, each seen by both devices` : 'No events seen by both devices');
    const goEvent = (i: number): void => {
      const s = spots[i];
      if (!s) return;
      idx = i;
      wv.center(s.t);
      const what = (s.polar[0] ?? s.watch[0])?.label.replace(/ \((both|strap only)\)$/, '') ?? 'Event';
      evText.textContent = `Event ${i + 1} of ${spots.length} at ${clockAt(set.strips, s.t)} · ${what} · seen by both`;
    };
    const bar = make('div', 'row wrap viewer-bar no-print');
    bar.append(pos, time);
    const evBar = make('div', 'row wrap event-nav no-print');
    evBar.append(button('← Previous event', '', () => goEvent(Math.max(0, idx - 1))), evText, button('Next event →', '', () => goEvent(Math.min(all.length - 1, idx + 1))));
    // move one and the other follows, so a heartbeat is at the same place in both
    let linking = false;
    const link = (a: EcgViewer, b: EcgViewer): void => a.addEventListener('move', () => {
      if (linking) return;
      linking = true;
      b.goTo(a.t0);
      linking = false;
      pos.value = String(Math.round((a.t0 / Math.max(0.001, a.duration - a.span)) * 1000));
      time.textContent = `${clockAt(set.strips, a.t0)} · ${n(a.span, 1)} s shown`;
      bp.mark(realAt(set.strips, a.t0), realAt(set.strips, a.t0 + a.span)); // the moments shown, marked on the BP graph
    });
    link(wv, pv); link(pv, wv);
    pos.addEventListener('input', () => wv.goTo((Number(pos.value) / 1000) * (wv.duration - wv.span)));
    return {
      body: opts.compact ? [w.box, p.box, bar, evBar] : [
        ...heading('Combined ECG: watch strips and Polar H10', g, set.strips.reduce((a, x) => a + x.durationS, 0)), // the spliced strips' combined duration
        make('p', 'note', `The ${set.strips.length} strip${set.strips.length === 1 ? '' : 's'} from the watch, joined, above the strap’s ECG of exactly the same moments. Drag, scroll or use the bar to move: both move together. Flat stretches are the joins between strips. Red triangles mark events: only those both devices saw at the same heartbeat, as they are counted.`),
        make('p', 'pair-duration', `${splicedText(set.strips)} · Polar H10 cut to the same moments${set.skipped.length ? ` · ${set.skipped.length} strip${set.skipped.length > 1 ? 's' : ''} left out (no clear heartbeats)` : ''}${st.damaged ? ` · ${st.damaged} damaged strip${st.damaged > 1 ? 's' : ''} left out (cut off in v1.39.0)` : ''}`),
        ...(st.polarM && st.watchM ? [pairBoxes(st.polarM, st.watchM, bothEvents(set), g.e.user)] : []), ...(g.v.bps.length ? [bpBox] : []), w.box, p.box, bar, evBar,
        ...stripComparison(g), ...stripCombined(g),
        ...(ecgId ? [button('Open the full Polar H10 ECG', '', () => deps.openEcg(ecgId))] : []),
      ],
      after: () => {
        // for showing: a beat flagged by one device only isn't marked as an event either
        const onlyCounted = (an: Analysis, shown: readonly ReportEvent[]): Analysis => ({
          ...an, beats: an.beats.map((b) => (b.flags.some((f) => f !== 'artifact') && !shown.some((e) => Math.abs(e.t - b.t) < 0.01) ? { ...b, flags: [] } : b)),
        });
        wv.load(onlyCounted(set.watchA, shownW), shownW); pv.load(onlyCounted(set.polarA, shownP), shownP); wv.dispatchEvent(new Event('move'));
      },
    };
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
      // with watch strips, events are counted once: only those both devices saw, in "ECG where both recorded" below
      ...(g.v.ecg ? [card('ECG waves (Polar H10 only)', table(['Figure', 'Polar H10'], g.strips?.set ? ecgRows(g.v.ecg).filter((r) => r[0] !== 'Events') : ecgRows(g.v.ecg)),
        ...(g.strips?.set ? [make('p', 'note', 'Events are counted once, below: only those the watch’s strips confirm.')] : []))] : []),
      ...stripCombined(g),
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
      ...stripComparison(g),
      ...(checks.length ? [card('Stored watch readings against the strap', table(['Reading', 'Watch D2', 'Polar H10', 'Difference'], checks), make('p', 'note', 'A reading taken outside the tracking is compared with the strap’s average for the whole tracking, so a larger difference there is expected.'))] : []),
      card('How to improve accuracy', tips),
    ];
  }

  /** `at` picks an earlier version by when it was generated; without it, the latest. */
  function openReport(id: string, kind: Kind, at?: number): Promise<void> { return during('opening a tracking report', () => openReportNow(id, kind, at)); }
  async function openReportNow(id: string, kind: Kind, at?: number): Promise<void> {
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
      if (!e || !trace || !v) { reportRoot.replaceChildren(button('← Synchronised ECG Tracking History', '', backToHistory), make('p', 'muted', 'This tracking is no longer in the history.')); return; }
      let failed: string | null = null;
      const strips = await gatherStrips(e).catch((err: unknown) => { failed = errorMessage(err); return null; });
      const g: Gathered = { e, trace, v, latest: v === latest, strips, ...(!strips?.set ? { why: await whyNoStrips(e, failed) } : {}) };
      if (kind === 'ecg') {
        const r = ecgPairReport(g);
        reportRoot.replaceChildren(reportBar(e, kind, v.generatedAt), ...r.body);
        r.after();
      } else {
        const body = kind === 'polar' ? polarReport(g) : kind === 'watch' ? watchReport(g) : kind === 'combined' ? combinedReport(g) : comparisonReport(g);
        reportRoot.replaceChildren(reportBar(e, kind, v.generatedAt), ...body);
      }
    } catch (err) {
      reportRoot.replaceChildren(button('← Synchronised ECG Tracking History', '', backToHistory), make('p', 'muted', `This report could not be made: ${errorMessage(err)}`));
    }
    window.scrollTo(0, 0);
  }

  async function render(): Promise<void> {
    const entries = store.loadSyncHistory().filter((e) => e.user === deps.user());
    if (!entries.length) { box.replaceChildren(make('p', 'muted', 'No synchronised ECG tracking yet on this device.')); return; }
    const list = make('ul', 'sessions');
    // the watch counts as recorded when it sent beats or when its ECG strips were taken during the tracking
    const strips = (await store.listSessions(deps.user() as store.UserNumber).catch(() => [])).filter((s) => s.source === 'watch');
    const hadStrips = (e: SyncTrackingEntry): boolean => strips.some((s) => s.start < e.start + e.durationS * 1000 && s.start + s.durationS * 1000 > e.start);
    for (const e of entries) {
      const versions = (await store.loadSyncTrace(e.id).catch(() => undefined))?.reports ?? [];
      const ecgId = e.ecgId;
      const remove = deleteButton('this tracking', () => {
        void (async () => {
          if (ecgId && window.confirm('Also delete its ECG from ECG history and trending? (Cancel keeps the ECG.)')) { await store.deleteSession(ecgId); historyChanged(); }
          await store.removeSyncEntry(e.id);
          historyChanged();
          void render();
        })();
      }, 'Delete this tracking from the history?');
      if (!versions.length) {
        const li = make('li', 'sync-sleep-row');
        const actions = make('div', 'row wrap sync-sleep-actions');
        actions.appendChild(remove);
        li.append(whenLine(dateTime(e.start), 'From Synchronised ECG Tracking'), make('span', 'dur', userTag(e.user)), make('span', 'stats', `${trackingLine(e, false, false, false)} · generating the reports…`), actions);
        list.appendChild(li);
        continue;
      }
      // one row per version, newest first, each with its Polar H10 report and the two-ECG report
      for (let i = versions.length; i >= 1; i--) {
        const v = versions[i - 1]!;
        const li = make('li', 'sync-sleep-row');
        li.append(
          whenLine(dateTime(e.start), `From Synchronised ECG Tracking${versions.length > 1 ? ` · Version ${i} of ${versions.length}${i === versions.length ? ' (latest)' : ''}` : ''}`),
          make('span', 'dur', userTag(e.user)),
          make('span', 'stats', trackingLine(e, v.bps.length > 0, !!v.p, !!v.w || hadStrips(e))),
        );
        const actions = make('div', 'row wrap sync-sleep-actions');
        for (const [k, label] of [['polar', 'Polar H10 report']] as const) {
          actions.appendChild(button(label, 'small', () => { backTo = null; void openReport(e.id, k, v.generatedAt); }));
        }
        actions.appendChild(button('Combined ECG', 'small', () => { backTo = null; void openReport(e.id, 'ecg', v.generatedAt); }));
        if (i === versions.length) actions.appendChild(remove); // the tracking goes, with all its versions
        else actions.appendChild(deleteButton(`version ${i}`, async () => { await retireVersion('tracking', e.id, v.generatedAt); void render(); },
          `Move version ${i} of this tracking's reports to the Recovery centre? (The latest version stays.)`));
        li.appendChild(actions);
        list.appendChild(li);
      }
    }
    box.replaceChildren(make('p', 'note', 'Each tracking has its Polar H10 report and its Combined ECG: the watch’s 30-second strips and the strap’s ECG of the same moments, together, compared beat for beat. When its blood pressure or the watch’s data changes, new reports are generated and the earlier ones stay as a version. Blood pressure: every reading taken on the watch within one hour before or after the start.'), list);
  }

  /** Shows the list now, then again if new versions were generated. */
  const refresh = (): void => {
    void render().then(() => deps.updateReports()).then((changed) => { if (changed) void render(); }).catch(() => undefined);
  };

  /** A tracking's Combined ECG (its latest version) shown inside another page, as on the BP and ECG page. */
  async function pairInto(root: HTMLElement, id: string, opts: { compact?: boolean; bp?: BpStrip } = {}): Promise<void> {
    root.replaceChildren(make('div', 'busy', 'Opening the ECGs…'));
    try {
      const e = store.loadSyncHistory().find((x) => x.id === id);
      const trace = e && await store.loadSyncTrace(id);
      const v = trace?.reports?.[trace.reports.length - 1];
      if (!e || !trace || !v) { root.replaceChildren(make('p', 'muted', 'This tracking’s reports aren’t ready yet: open Synchronised ECG Tracking History once to make them.')); return; }
      let failed: string | null = null;
      const strips = await gatherStrips(e).catch((err: unknown) => { failed = errorMessage(err); return null; });
      const g: Gathered = { e, trace, v, latest: true, strips, ...(!strips?.set ? { why: await whyNoStrips(e, failed) } : {}) };
      const r = ecgPairReport(g, opts);
      root.replaceChildren(...r.body);
      r.after();
    } catch (err) {
      root.replaceChildren(make('p', 'muted', `The ECGs could not be shown: ${errorMessage(err)}`));
    }
  }

  /** The two ECGs of a tracking, opened from ECG history: ← goes back there. */
  const openPair = (id: string, back: { label: string; go: () => void }): void => { backTo = back; void openReport(id, 'ecg'); };
  return { render: refresh, openPair, pairInto: (root, id, opts) => during('showing a tracking’s ECGs', () => pairInto(root, id, opts)) };
}
