// ECG from the Watch D2, for ECG live and Synchronised ECG Tracking. The watch can't stream its ECG: it records 30 seconds while
// a fingertip touches its button, then keeps the recording. While this runs, the app asks the watch every few seconds for
// new recordings, plays each one on screen like a Polar strip, analyses it and saves it in ECG history. The person starts
// the next 30-second ECG on the watch, again and again, until they press Stop.

import { LiveTrace } from './charts';
import { EcgFilter, analyze, sessionMetrics } from './dsp';
import { historyChanged } from './account';
import * as store from './store';
import type { Session, UserNumber } from './store';
import { make, fmt } from './ui';
import { errorMessage } from './util';
import type { LiveWatch } from './d2/live'; // type only: D2 Link's code stays in d2link.js

export const STRIP_FS = 130; // as the Polar H10, so every report, chart and export works the same
const POLL_MS = 5000;
const RATES = [125, 128, 250, 256, 300, 500, 512, 1000];

export interface WatchRecording { start: number; end: number; avgHr: number; samples: readonly number[] }

/**
 * The factor to µV. The watch doesn't say its unit, so it is the power of ten that makes the largest waves (99th
 * percentile around the middle) about 1 mV, as heartbeats are: mV, µV and nV all come out right (v1.39.0 assumed µV
 * for anything over 20, and its strips were cut off at the 16-bit limit).
 */
export function unitScale(samples: readonly number[]): number {
  if (!samples.length) return 1;
  const mid = [...samples].sort((a, b) => a - b)[samples.length >> 1] ?? 0;
  const dev = Array.from(samples, (v) => Math.abs(v - mid)).sort((a, b) => a - b);
  const p99 = dev[Math.floor(0.99 * (dev.length - 1))] ?? 0;
  if (!(p99 > 0)) return 1;
  return 1000 ** Math.round(Math.log10(1000 / p99) / 3); // steps of 1000: mV → ×1000, µV → ×1, nV → ×0.001
}

/** The watch's recording as µV at STRIP_FS: its rate worked out from the length, its unit from the size of the waves. */
export function toStrip(r: WatchRecording, rate?: number): { uv: Int16Array; sourceFs: number } {
  const n = r.samples.length, seconds = (r.end - r.start) / 1000;
  const raw = seconds > 0 ? n / seconds : 500;
  const near = RATES.reduce((a, b) => (Math.abs(b - raw) < Math.abs(a - raw) ? b : a));
  const sourceFs = rate ?? (Math.abs(near - raw) / near < 0.1 ? near : raw);
  const scale = unitScale(r.samples);
  const out = new Int16Array(Math.max(0, Math.floor((n / sourceFs) * STRIP_FS)));
  const half = sourceFs / STRIP_FS / 2;
  for (let i = 0; i < out.length; i++) {
    // the average around each new sample keeps out what the lower rate can't show
    const c = (i * sourceFs) / STRIP_FS, a = Math.max(0, Math.floor(c - half)), b = Math.min(n - 1, Math.ceil(c + half));
    let s = 0;
    for (let k = a; k <= b; k++) s += r.samples[k] ?? 0;
    out[i] = Math.max(-32768, Math.min(32767, Math.round((s / (b - a + 1)) * scale)));
  }
  return { uv: out, sourceFs };
}

/** A strip with over 1 % of its samples at the 16-bit limit was cut off (the scale error in v1.39.0). */
export function isCutOff(uv: Int16Array): boolean {
  let n = 0;
  for (const v of uv) if (v >= 32767 || v <= -32768) n++;
  return n > uv.length / 100;
}

/**
 * The rate that fits: the watch's file gives whole seconds only, and its strips come at 500 or 512 samples a second (seen
 * against the Polar H10: some strips 2.5 % too short at 500). The one whose heart rate is nearest the watch's own wins.
 */
export function bestRate(r: WatchRecording, s: { notch: number; qtcFormula: 'bazett' | 'fridericia' }): { uv: Int16Array; sourceFs: number } {
  const first = toStrip(r);
  if (!(r.avgHr > 0) || (first.sourceFs !== 500 && first.sourceFs !== 512)) return first;
  const other = toStrip(r, first.sourceFs === 500 ? 512 : 500);
  const hr = (uv: Int16Array): number => {
    const beats = analyze(uv, { fs: STRIP_FS, notch: s.notch, qtcFormula: s.qtcFormula }).beats.flatMap((b) => (b.rr && !b.flags.length ? [b.rr] : []));
    return beats.length ? 60000 / (beats.reduce((a, b) => a + b, 0) / beats.length) : NaN;
  };
  return Math.abs(hr(other.uv) - r.avgHr) < Math.abs(hr(first.uv) - r.avgHr) ? other : first;
}

export interface StripSettings { alias: string; notch: number; qtcFormula: 'bazett' | 'fridericia'; hrRest: number; hrMax: number; sex: 'male' | 'female' }

/**
 * Saves one watch ECG in ECG history, as the "ECG from the Watch D2" card does: 'same' when it is already there (and not
 * one of v1.39.0's cut-off strips), 'short' when under 5 seconds. Used by the card and by D2 Link's Download all data.
 */
export async function saveWatchStrip(r: WatchRecording, user: number, s: StripSettings, syncTracking = false): Promise<{ result: 'saved' | 'same' | 'short'; session?: Session; metrics?: ReturnType<typeof sessionMetrics>; events?: number; uv?: Int16Array; sourceFs?: number }> {
  const id = `w${r.start}`;
  const old = await store.loadSession(id);
  if (old.session && old.session.watchFs && !(old.samples && isCutOff(old.samples))) return { result: 'same' };
  const { uv, sourceFs } = bestRate(r, s);
  if (uv.length < STRIP_FS * 5) return { result: 'short' };
  const a = analyze(uv, { fs: STRIP_FS, notch: s.notch, qtcFormula: s.qtcFormula });
  const m = sessionMetrics(a, uv.length / STRIP_FS, { hrRest: s.hrRest, hrMax: s.hrMax, sex: s.sex });
  // taken during a tracking: kept as such when it was saved that way before
  const during = syncTracking || old.session?.syncTracking === true;
  const session: Session = {
    id, user: user as UserNumber, start: r.start, durationS: uv.length / STRIP_FS, fs: STRIP_FS, alias: s.alias, source: 'watch',
    watchFs: sourceFs, userEvents: [], summary: { meanHR: m.meanHR, hrvScore: m.hrvScore, eventCount: a.events.length },
    ...(during ? { syncTracking: true } : {}),
  };
  await store.saveSession(session, uv);
  return { result: 'saved', session, metrics: m, events: a.events.length, uv, sourceFs };
}

export interface WatchEcgDeps {
  /** The connected watch, or null. */
  watch: () => LiveWatch | null;
  user: () => number;
  settings: () => Pick<store.Settings, 'alias' | 'notch' | 'qtcFormula' | 'hrRest' | 'hrMax' | 'sex'>;
  log: (line: string) => void;
  /** Saved during a synchronised ECG tracking. */
  syncTracking?: boolean;
  openReport: (id: string) => void;
}

/** The "ECG from the Watch D2" card: instructions, Start and Stop, the strip on screen, its results and the saved strips. */
export function watchEcgCard(deps: WatchEcgDeps): { el: HTMLElement; stop: () => void; update: () => void; start: (fromMs?: number) => void; running: () => boolean; collect: (sinceMs: number) => Promise<number> } {
  const card = make('div', 'card watch-ecg');
  const steps = make('ol', 'd2-steps');
  for (const line of [
    'Connect the watch, then press Start watch ECG.',
    'On the watch, open the ECG app. Rest your arms, and keep a fingertip of the other hand on the watch’s lower button for the 30 seconds it records.',
    'When the watch finishes, this page downloads the recording within seconds, shows it here, analyses it and saves it in ECG history.',
    'Start the next ECG on the watch straight away, again and again, until you press Stop. The watch can’t record continuously, so it is one 30-second strip at a time.',
  ]) steps.appendChild(make('li', '', line));
  const btnStart = make('button', 'primary', 'Start watch ECG') as HTMLButtonElement;
  const btnStop = make('button', '', 'Stop') as HTMLButtonElement;
  btnStop.hidden = true;
  const row = make('div', 'row wrap');
  row.append(btnStart, btnStop);
  const status = make('p', 'note', 'Not started.');
  const canvas = make('canvas');
  canvas.setAttribute('aria-label', 'ECG from the Watch D2');
  const traceBox = make('div', 'trace');
  traceBox.appendChild(canvas);
  const results = make('p', 'watch-ecg-results');
  const list = make('ul', 'watch-ecg-list');
  card.append(make('h3', 'sync-h', 'ECG from the Watch D2 (30-second strips)'), steps, row, status, traceBox, results, list);

  const trace = new LiveTrace(canvas, STRIP_FS);
  let filter = new EcgFilter(STRIP_FS, deps.settings().notch);
  let queue: Float32Array[] = [], playing: ReturnType<typeof setInterval> | null = null, frame = 0;
  let running = false, timer: ReturnType<typeof setTimeout> | null = null, since = 0, strips = 0;
  const seen = new Set<number>();

  /** Plays the strips at their real speed, one after the other, as the Polar ECG is shown. */
  const play = (): void => {
    if (playing) return;
    const step = Math.round(STRIP_FS / 10);
    playing = setInterval(() => {
      const next = queue[0];
      if (!next) { if (playing) clearInterval(playing); playing = null; return; }
      trace.push(next.subarray(0, step));
      queue[0] = next.subarray(step);
      if (!queue[0]?.length) queue.shift();
    }, 100);
    const draw = (): void => { if (card.offsetParent) trace.draw(); frame = playing || running ? requestAnimationFrame(draw) : 0; };
    frame ||= requestAnimationFrame(draw);
  };

  const update = (): void => {
    const w = deps.watch();
    btnStart.hidden = running;
    btnStop.hidden = !running;
    btnStart.disabled = !w;
    btnStart.title = w ? '' : 'Connect the watch first';
    if (!running) status.textContent = w ? (strips ? `${strips} strip${strips > 1 ? 's' : ''} saved. Press Start watch ECG to take more.` : 'Ready: press Start watch ECG.') : 'Connect the watch first.';
  };

  async function save(r: WatchRecording): Promise<void> {
    const id = `w${r.start}`;
    // already saved (on the other page, or by D2 Link); one from before v1.41.0 (cut off, or its rate not checked) is replaced
    const got = await saveWatchStrip(r, deps.user(), deps.settings(), deps.syncTracking);
    if (got.result === 'same') return;
    if (got.result === 'short' || !got.session || !got.metrics || !got.uv) { deps.log(`A watch ECG from ${clock(r.start)} is too short to use.`); return; }
    const { session, metrics: m, uv, sourceFs = 0 } = got;
    const events = got.events ?? 0;
    historyChanged();
    strips++;
    queue.push(Float32Array.from(uv, (v) => filter.process(v)));
    play();
    const r0 = (v: number): string => (Number.isFinite(v) ? fmt(v) : '--');
    results.textContent = `Strip ${strips} · ${clock(r.start)}: heart rate ${r0(m.meanHR)} bpm (watch ${r.avgHr || '--'}) · RMSSD ${r0(m.rmssd)} ms · QRS ${r0(m.qrs)} ms · QT ${r0(m.qt)} ms · QTc ${r0(m.qtc)} ms · ${events} event${events === 1 ? '' : 's'}`;
    const li = make('li');
    const open = make('button', 'sync-open', 'Open report') as HTMLButtonElement;
    open.addEventListener('click', () => deps.openReport(id));
    li.append(make('span', '', `${clock(r.start)} · ${Math.round(session.durationS)} s · ${r0(m.meanHR)} bpm`), open);
    list.prepend(li);
    deps.log(`Watch ECG from ${clock(r.start)} saved (${Math.round(sourceFs)} Hz on the watch).`);
  }

  async function poll(): Promise<void> {
    timer = null;
    if (!running) return;
    const w = deps.watch();
    if (!w) { status.textContent = 'The watch disconnected: reconnect it to carry on.'; }
    else {
      try {
        const found = (await w.ecgSince(since)).filter((r) => !seen.has(r.start));
        for (const r of found) { seen.add(r.start); await save(r); }
        status.textContent = `Waiting for the next ECG on the watch (fingertip on its lower button for 30 s)…${strips ? ` ${strips} strip${strips > 1 ? 's' : ''} so far.` : ''}`;
      } catch (err) {
        status.textContent = `Couldn’t read the watch’s ECG: ${errorMessage(err)}. Trying again…`;
      }
    }
    if (running) timer = setTimeout(() => void poll(), POLL_MS);
  }

  /** `fromMs`: the earliest ECG to fetch (default: one finished just before Start counts too). */
  const start = (fromMs?: number): void => {
    if (running || !deps.watch()) return;
    running = true;
    since = fromMs ?? Date.now() - 60_000;
    filter = new EcgFilter(STRIP_FS, deps.settings().notch);
    update();
    status.textContent = 'Start an ECG on the watch now: fingertip on its lower button for 30 seconds.';
    deps.log('Watch ECG started: checking the watch for new ECG recordings every 5 seconds.');
    void poll();
  };
  btnStart.addEventListener('click', () => start());
  /** One check now for every ECG since `sinceMs` not saved yet (at the end of a tracking); returns how many were new. */
  const collect = async (sinceMs: number): Promise<number> => {
    const w = deps.watch();
    if (!w) return 0;
    const before = strips;
    const found = (await w.ecgSince(sinceMs)).filter((r) => !seen.has(r.start));
    for (const r of found) { seen.add(r.start); await save(r); }
    return strips - before;
  };
  const stop = (): void => {
    running = false;
    if (timer) clearTimeout(timer);
    timer = null;
    update();
  };
  btnStop.addEventListener('click', () => { stop(); deps.log('Watch ECG stopped.'); });
  queueMicrotask(update); // the page that made this card may not have its watch ready yet
  return { el: card, stop, update, start, running: () => running, collect };
}

const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
