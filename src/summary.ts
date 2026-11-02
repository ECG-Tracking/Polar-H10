// What is synced instead of raw data: an ECG recording's summary (results, heart-rate trend, average beat,
// first 30 s and up to 50 event strips) and a night's sleep report (numbers plus the per-30-s graph data).
// Both are plain JSON; strips are 16-bit samples in base64.

import { analyze, sessionMetrics, EVENT_LABELS, type BeatMeasure, type EventType, type Polarity, type SessionMetrics } from './dsp';
import { analyzeSleep, type SleepAnalysis, type SleepData, type SleepMetrics, type Stage } from './sleep';
import type { Session, Settings } from './store';

export const STRIP_S = 30; // representative strip: the first 30 s
export const EVENT_STRIP_S = 10; // 5 s before and after each event
export const MAX_EVENT_STRIPS = 50;

// ---------- base64 for 16-bit samples ----------

export function int16ToBase64(a: Int16Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToInt16(b64: string): Int16Array {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length - (s.length % 2));
  for (let i = 0; i < bytes.length; i++) bytes[i] = s.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

// ---------- ECG ----------

export interface SummaryEvent { t: number; type: EventType; label: string }
export interface Strip { start: number; data: string } // start in seconds from the beginning of the recording

export interface EcgSummary {
  v: 1;
  fs: number;
  metrics: SessionMetrics; // includes the heart-rate trend (one value per second)
  template: number[] | null; // average beat, µV
  templateMeasure: BeatMeasure | null;
  templatePre: number;
  polarity: Polarity;
  events: SummaryEvent[];
  strip: Strip;
  eventStrips: (Strip & { t: number })[];
  analysedWith: Pick<Settings, 'age' | 'sex' | 'hrRest' | 'hrMax' | 'qtcFormula' | 'notch'>;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** Up to MAX_EVENT_STRIPS events: every marked event first, then detected ones spread over the recording. */
export function pickEventStrips(events: readonly SummaryEvent[]): SummaryEvent[] {
  const marked = events.filter((e) => e.type === 'user').slice(0, MAX_EVENT_STRIPS);
  const detected = events.filter((e) => e.type !== 'user');
  const room = MAX_EVENT_STRIPS - marked.length;
  const step = detected.length > room ? detected.length / room : 1;
  const chosen: SummaryEvent[] = [];
  for (let k = 0; chosen.length < room && Math.floor(k * step) < detected.length; k++) {
    const e = detected[Math.floor(k * step)];
    if (e) chosen.push(e);
  }
  return [...marked, ...chosen].sort((a, b) => a.t - b.t);
}

export function buildEcgSummary(session: Session, samples: Int16Array, settings: Settings): EcgSummary {
  const fs = session.fs;
  const analysis = analyze(samples, { fs, notch: settings.notch, qtcFormula: settings.qtcFormula });
  const metrics = sessionMetrics(analysis, session.durationS, { hrRest: settings.hrRest, hrMax: settings.hrMax, sex: settings.sex });
  const events: SummaryEvent[] = [
    ...analysis.events.map((e) => ({ t: e.t, type: e.type, label: EVENT_LABELS[e.type] })),
    ...session.userEvents.map((e): SummaryEvent => ({ t: e.t, type: 'user', label: e.label || 'Marked' })),
  ].sort((a, b) => a.t - b.t);
  const cut = (startS: number, lengthS: number): Strip => {
    const a = Math.max(0, Math.round(startS * fs)), b = Math.min(samples.length, a + Math.round(lengthS * fs));
    return { start: a / fs, data: int16ToBase64(samples.slice(a, b)) };
  };
  return {
    v: 1,
    fs,
    metrics: { ...metrics, hr: metrics.hr.map((v) => (v == null ? null : round1(v))) },
    template: analysis.template ? Array.from(analysis.template, round1) : null,
    templateMeasure: analysis.templateMeasure,
    templatePre: analysis.templatePre,
    polarity: analysis.polarity,
    events,
    strip: cut(0, STRIP_S),
    eventStrips: pickEventStrips(events).map((e) => ({ t: e.t, ...cut(e.t - EVENT_STRIP_S / 2, EVENT_STRIP_S) })),
    analysedWith: { age: settings.age, sex: settings.sex, hrRest: settings.hrRest, hrMax: settings.hrMax, qtcFormula: settings.qtcFormula, notch: settings.notch },
  };
}

// ---------- reading payloads back (they come from the network, so check them) ----------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
/** JSON turns NaN into null; turn it back so "--" is shown instead of 0. */
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Restores numbers in a metrics object: null → NaN, except fields that are legitimately null or not numbers. */
function restoreNumbers<T>(m: Obj, keepAsIs: readonly string[]): T {
  const out: Obj = {};
  for (const [k, v] of Object.entries(m)) out[k] = keepAsIs.includes(k) || (v !== null && typeof v !== 'number') ? v : num(v);
  return out as T;
}

function parseStrip(v: unknown): Strip | null {
  return isObj(v) && typeof v['data'] === 'string' && typeof v['start'] === 'number' ? { start: v['start'], data: v['data'] } : null;
}

const EVENT_TYPES: readonly EventType[] = ['premature', 'pause', 'shape', 'user'];

export function parseEcgSummary(v: unknown): EcgSummary | null {
  if (!isObj(v) || v['v'] !== 1 || !isObj(v['metrics']) || typeof v['fs'] !== 'number') return null;
  const m = v['metrics'];
  if (!Array.isArray(m['hr']) || !Array.isArray(m['zones'])) return null;
  const strip = parseStrip(v['strip']);
  if (!strip) return null;
  const metrics = restoreNumbers<SessionMetrics>({ ...m, hr: (m['hr'] as unknown[]).map(numOrNull), zones: (m['zones'] as unknown[]).map((z) => num(z) || 0) }, ['hr', 'zones', 'recovery']);
  const events = (Array.isArray(v['events']) ? v['events'] : []).flatMap((e): SummaryEvent[] => {
    if (!isObj(e) || typeof e['t'] !== 'number' || typeof e['label'] !== 'string' || !EVENT_TYPES.includes(e['type'] as EventType)) return [];
    return [{ t: e['t'], type: e['type'] as EventType, label: e['label'] }];
  });
  const eventStrips = (Array.isArray(v['eventStrips']) ? v['eventStrips'] : []).flatMap((s): (Strip & { t: number })[] => {
    const p = parseStrip(s);
    return p && isObj(s) && typeof s['t'] === 'number' ? [{ ...p, t: s['t'] }] : [];
  });
  const tm = v['templateMeasure'];
  const aw = isObj(v['analysedWith']) ? v['analysedWith'] : {};
  return {
    v: 1,
    fs: v['fs'],
    metrics,
    template: Array.isArray(v['template']) ? (v['template'] as unknown[]).map((x) => num(x) || 0) : null,
    templateMeasure: isObj(tm) ? restoreNumbers<BeatMeasure>(tm, ['tEnd', 'qrs', 'qt', 'tAmp']) : null,
    templatePre: num(v['templatePre']) || 0.25,
    polarity: v['polarity'] === -1 ? -1 : 1,
    events,
    strip,
    eventStrips,
    analysedWith: {
      age: num(aw['age']), sex: aw['sex'] === 'female' ? 'female' : 'male', hrRest: num(aw['hrRest']), hrMax: num(aw['hrMax']),
      qtcFormula: aw['qtcFormula'] === 'fridericia' ? 'fridericia' : 'bazett', notch: num(aw['notch']),
    },
  };
}

// ---------- sleep ----------

export interface SleepReport {
  v: 1;
  metrics: SleepMetrics;
  stages: string; // one letter per 30 s: a = awake, r = REM, l = light, d = deep, n = no data
  hr: (number | null)[];
  breathing: (number | null)[];
  activity: (number | null)[];
}

const STAGE_CODE: Readonly<Record<Stage, string>> = { awake: 'a', rem: 'r', light: 'l', deep: 'd', nodata: 'n' };
const CODE_STAGE: Readonly<Record<string, Stage>> = { a: 'awake', r: 'rem', l: 'light', d: 'deep', n: 'nodata' };

export function buildSleepReport(data: SleepData): SleepReport {
  return fromAnalysis(analyzeSleep(data));
}

export function fromAnalysis(a: SleepAnalysis): SleepReport {
  const r = (v: number | null): number | null => (v == null ? null : round1(v));
  return { v: 1, metrics: a.metrics, stages: a.stages.map((s) => STAGE_CODE[s]).join(''), hr: a.hr.map(r), breathing: a.breathing.map(r), activity: a.activity.map(r) };
}

export function toAnalysis(rep: SleepReport): SleepAnalysis {
  return { stages: [...rep.stages].map((c) => CODE_STAGE[c] ?? 'nodata'), hr: rep.hr, breathing: rep.breathing, activity: rep.activity, metrics: rep.metrics };
}

export function parseSleepReport(v: unknown): SleepReport | null {
  if (!isObj(v) || v['v'] !== 1 || !isObj(v['metrics']) || typeof v['stages'] !== 'string') return null;
  const arr = (x: unknown): (number | null)[] => (Array.isArray(x) ? x.map(numOrNull) : []);
  return {
    v: 1,
    metrics: restoreNumbers<SleepMetrics>(v['metrics'], []),
    stages: v['stages'].replace(/[^arldn]/g, 'n'),
    hr: arr(v['hr']),
    breathing: arr(v['breathing']),
    activity: arr(v['activity']),
  };
}
