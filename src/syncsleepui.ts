// Synchronised Sleep Tracking: the page that records a sleep for both devices, the history of sleeps both measured,
// and the combined and comparison reports. The Polar H10 and D2 reports are the usual ones, opened from here.

import { connectStrap, currentStrap, disconnectStrap, onStrap } from './devices';
import { H10_RESTART_TIP, connectionLog, forgetStrapButton, trackFor } from './devicekit';
import { ECG_FS, type BatteryDetail, type EcgDetail, type PolarH10 } from './polar';
import { EcgFilter } from './dsp';
import { LiveTrace, Hypnogram, drawDonut, fmtClock, STAGE_COLOR_VAR, STAGE_LABEL, type SleepStageKey } from './charts';
import { checkRange, fmtRange, sleepRanges, type Range } from './ranges';
import { analyzeSleep, EPOCH_S, type SleepAnalysis, type SleepData, type Stage } from './sleep';
import * as store from './store';
import { buildReports, pairUp, whatChanged, type Known, type PastSleepReports, type PolarFigures, type SavedSleepReports, type SleepCopy, type SleepPair, type WatchSleep } from './syncsleep';
import { fromAnalysis, parseSleepReport, toAnalysis } from './summary';
import { fmt, fmtHM, make, whenLine } from './ui';
import { errorMessage, errorName } from './util';
import type { D2Api } from './d2/index'; // type only: D2 Link's code stays in d2link.js

export interface FoundEcg { id: string; label: string }

export interface SyncSleepDeps {
  loadD2: () => Promise<D2Api>;
  account: () => string;
  user: () => number;
  userLabel: () => string;
  /** The recording itself runs on Sleep monitor, so both pages show the same one. */
  /** The mains-hum filter chosen in Biodata, for the live ECG. */
  notch: () => number;
  sleep: { canStart: () => boolean; start: (lengthS: number | null) => Promise<void>; stop: () => Promise<string | null>; isRecording: () => boolean; elapsed: () => string };
  openPolar: (id: string, back: () => void) => void;
  openPolarCopy: (copy: SleepCopy, back: () => void) => void;
  openWatch: (id: string, back: () => void, copy?: unknown) => void;
  openEcg: (id: string) => void;
  ecgDuring: (from: number, to: number) => Promise<FoundEcg | null>;
  show: (view: 'd2' | 'sleep' | 'syncSleepHistory' | 'syncSleepReport') => void;
}

const clockSeconds = (ms: number | null): string => (ms == null ? '--' : new Date(ms).toLocaleTimeString('en-GB'));
const dateTime = (ms: number): string => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const dayName = (ms: number): string => new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const shortDay = (ms: number): string => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'numeric' });
const signed = (v: number | null, unit: string, d = 0): string => (v == null || !Number.isFinite(v) ? '--' : `${v > 0 ? '+' : ''}${v.toFixed(d)}${unit}`);
const clockOf = (ms: number | null): string => (ms == null ? '--' : fmtClock(ms));

function button(text: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = make('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function moreRow(k: string, v: string): HTMLElement {
  const r = make('div', 'row between d2-more-row');
  r.append(make('span', 'muted', k), make('span', '', v));
  return r;
}

/** A sleep-stage chart, drawn once it is on the page. */
function stageChart(title: string, stages: readonly (Known | null)[], startMs: number): { figure: HTMLElement; draw: () => void } {
  const figure = make('figure', 'chart hypno');
  figure.setAttribute('aria-label', `${title}: sleep stages`);
  if (title) figure.appendChild(make('figcaption', '', title));
  figure.appendChild(make('canvas'));
  const chart = new Hypnogram(figure);
  chart.set(stages as readonly (SleepStageKey | null)[], startMs, 60);
  return { figure, draw: () => chart.draw() };
}

function legend(): HTMLElement {
  const box = make('div', 'legend d2-legend');
  for (const k of ['deep', 'light', 'rem', 'awake'] as const) {
    const item = make('span'), sw = make('span', 'swatch');
    sw.style.background = `var(${STAGE_COLOR_VAR[k]})`;
    item.append(sw, STAGE_LABEL[k]);
    box.appendChild(item);
  }
  return box;
}

function stars(score: number): HTMLElement {
  const half = Math.ceil(Math.max(0, Math.min(100, score)) / 10);
  const box = make('div', 'd2-stars');
  box.setAttribute('aria-label', `${half / 2} of 5 stars`);
  for (let i = 0; i < 5; i++) box.appendChild(make('span', `d2-star ${half >= 2 * (i + 1) ? 'full' : half === 2 * i + 1 ? 'half' : 'empty'}`, '★'));
  return box;
}

function tile(name: string, value: string, unit: string, note: string, check?: { range: Range; value: number; text?: string }): HTMLElement {
  const box = make('div', 'd2-tile'), v = make('div', 'd2-tile-value', value);
  if (unit) v.appendChild(make('small', '', ` ${unit}`));
  const refs: string[] = [];
  if (check) {
    const status = checkRange(check.range, check.value);
    const label = status === 'low' ? check.range.lowLabel ?? 'Low' : status === 'high' ? check.range.highLabel ?? 'High' : 'Normal';
    v.appendChild(make('span', `d2-verdict d2-${status ?? 'normal'}`, ` ${label}`));
    refs.push(`References: ${check.text ?? `${fmtRange(check.range)}${unit ? ` ${unit}` : ''}`}`);
  }
  if (note) refs.push(note);
  box.append(make('div', 'd2-tile-name', name), v, make('div', 'd2-tile-ref', refs.join(' · ')));
  return box;
}

export function initSyncSleep(root: HTMLElement, historyRoot: HTMLElement, reportRoot: HTMLElement, deps: SyncSleepDeps): {
  refresh: () => void; refreshHistory: () => Promise<void>; schedule: () => void;
} {
  // ---------- the recording page ----------

  const title = make('h2', '', 'Synchronised Sleep Tracking ');
  const userTag = make('span', 'muted');
  title.appendChild(userTag);
  const intro = make('p', 'note', 'The Polar H10 and the Watch D2 record the same sleep. Connect the strap here and start when you go to bed; the watch records by itself. Afterwards, download the watch’s sleep in D2 Link and the four reports are made automatically.');

  // --- 1. Polar H10, as on Sleep monitor ---
  const logs = connectionLog('Polar H10 connection log');
  const polarCard = make('div', 'card connect');
  const status = make('div', 'status');
  const dot = make('span', 'dot'), statusText = make('span', '', 'Polar H10 not connected'), battery = make('span', 'muted', '');
  status.append(dot, statusText, battery);
  const btnConnect = button('1. Pair with Polar H10', 'primary', () => void connect());
  const btnOff = button('Disconnect', '', () => void disconnectStrap().then(() => { connected = false; refresh(); }));
  const forget = forgetStrapButton(logs.log);
  const row = make('div', 'row wrap');
  row.append(btnConnect, btnOff, forget.el);
  polarCard.append(status, row, make('p', 'note', 'Chrome shows a list: click your Polar H10, then Pair.'), logs.el);

  // --- 2. Watch D2: records by itself, downloaded afterwards ---
  const watchCard = make('div', 'card connect');
  const watchStatus = make('div', 'status');
  watchStatus.append(make('span', 'dot'), make('span', '', 'Watch D2: records your sleep by itself'));
  const acctSlot = make('div');
  watchCard.append(watchStatus,
    make('p', 'note', 'Wear the watch to bed; it needn’t stay connected. In the morning, download its sleep in D2 Link (which also has its Forget pairing).'),
    acctSlot);
  void deps.loadD2().then((api) => { acctSlot.replaceChildren(api.accountBox(deps.account())); }).catch(() => undefined);

  // --- 3. the live ECG, as on Sleep monitor ---
  const traceCard = make('div', 'card trace');
  const canvas = make('canvas');
  canvas.setAttribute('aria-label', 'Live ECG trace from the Polar H10');
  traceCard.append(make('h3', 'sync-h', 'ECG (Polar H10)'), canvas);
  const trace = new LiveTrace(canvas, ECG_FS);
  let filter = new EcgFilter(ECG_FS, deps.notch());
  let attached: PolarH10 | null = null, drawFrame = 0;
  /** Drawn only while this page can be seen, to save the battery overnight. */
  const drawLoop = (): void => { if (root.offsetParent) trace.draw(); drawFrame = currentStrap() ? requestAnimationFrame(drawLoop) : 0; };

  // --- 4. tracking ---
  const card = make('div', 'card controls');
  const track = trackFor('sleep');
  const btnStart = button('2. Start sleep & ECG recording', 'primary big', () => void startStop());
  btnStart.disabled = true;
  const elapsed = make('div', 'timer', '0:00');
  const done = make('div', '');
  const startRow = make('div', 'row');
  startRow.appendChild(btnStart);
  const links = make('div', 'row wrap');
  links.append(
    button('Dim screen on Sleep monitor', '', () => deps.show('sleep')),
    button('3. Download watch sleep in D2 Link', '', () => deps.show('d2')),
    button('Open history', '', () => deps.show('syncSleepHistory')),
  );
  card.append(track.el, elapsed, startRow, done, links);

  const steps = make('ol', 'd2-steps');
  for (const line of [
    'Put on the Polar H10 and the Watch D2, and connect the strap here.',
    'Start the recording when you go to bed. The strap records your sleep and ECG; the watch records your sleep by itself, so it needn’t stay connected.',
    'Stop the recording when you wake up, or choose how long to track and it stops by itself.',
    'Download the watch’s sleep in D2 Link. The combined and comparison reports are then generated automatically, and the sleep appears in Synchronised Sleep Tracking History with its four reports.',
  ]) steps.appendChild(make('li', '', line));
  const how = make('details', 'card d2-help');
  how.append(make('summary', '', 'How it works'), steps,
    make('p', 'note', 'Recordings that overlap for at least half of the shorter one count as one sleep, so sleep you recorded on both devices earlier is listed too. Keep the phone or computer running this page awake and in range of the strap.'));
  root.replaceChildren(title, intro, polarCard, watchCard, traceCard, card, how);

  let connected = false;
  onStrap((p) => {
    connected = p != null;
    if (attached !== p) {
      attached = p;
      p.addEventListener('ecg', (e) => trace.push(Float32Array.from((e as CustomEvent<EcgDetail>).detail.samples, (v) => filter.process(v))));
      p.addEventListener('battery', (e) => { battery.textContent = `Battery ${(e as CustomEvent<BatteryDetail>).detail.level}%`; });
      p.addEventListener('disconnect', () => { if (!deps.sleep.isRecording()) { connected = false; trace.clear(); battery.textContent = ''; refresh(); } });
    }
    filter = new EcgFilter(ECG_FS, deps.notch());
    trace.clear();
    drawFrame ||= requestAnimationFrame(drawLoop);
    refresh();
  });

  function refresh(): void {
    userTag.textContent = `· ${deps.userLabel()}`;
    const recording = deps.sleep.isRecording();
    const strap = currentStrap();
    connected = strap?.connected === true || deps.sleep.canStart();
    statusText.textContent = recording ? 'Recording sleep and ECG' : deps.sleep.canStart() ? `${strap?.name ?? 'Polar H10'} – heart beats, movement${strap?.ecgOk ? ' and ECG' : ''}` : connected ? 'Polar H10 connected, but its movement data isn’t available' : 'Polar H10 not connected';
    dot.className = `dot ${recording || deps.sleep.canStart() ? 'on' : connected ? 'busy' : ''}`;
    btnConnect.hidden = connected;
    btnOff.hidden = !connected || recording;
    btnStart.disabled = !recording && !deps.sleep.canStart();
    btnStart.textContent = recording ? 'Stop – I’m awake' : '2. Start sleep & ECG recording';
    btnStart.classList.toggle('recording', recording);
    track.disable(recording);
    elapsed.textContent = recording ? deps.sleep.elapsed() : '0:00';
    forget.update();
  }
  setInterval(() => { if (root.offsetParent) refresh(); }, 2000);

  async function connect(): Promise<void> {
    logs.clear();
    statusText.textContent = 'Connecting…';
    dot.className = 'dot busy';
    try {
      await connectStrap(logs.log);
    } catch (err) {
      const cancelled = errorName(err) === 'NotFoundError';
      logs.log(cancelled ? 'No strap chosen (the list was closed or cancelled)' : `Error: ${errorMessage(err)}`);
      logs.log(H10_RESTART_TIP);
      statusText.textContent = cancelled ? 'Polar H10 not connected' : `Could not connect: ${errorMessage(err)}`;
      dot.className = 'dot';
      return;
    }
    refresh();
  }

  async function startStop(): Promise<void> {
    done.replaceChildren();
    if (!deps.sleep.isRecording()) { await deps.sleep.start(track.seconds()); refresh(); return; }
    const id = await deps.sleep.stop();
    refresh();
    done.append(make('p', '', id
      ? 'Saved. The ECG is in ECG history and trending. Now download the watch’s sleep in D2 Link to get the four reports.'
      : 'Not saved: recordings under 10 minutes aren’t kept.'));
  }

  // ---------- keeping the reports up to date ----------

  async function loadPairs(): Promise<SleepPair[]> {
    const polar = await store.listSleeps(deps.user() as store.UserNumber);
    if (!polar.length) return []; // no need to load D2 Link
    const api = await deps.loadD2();
    return pairUp(polar, await api.pairingSleep(deps.account(), deps.user()));
  }

  /** The Polar H10 recording's analysis and, the first time, the summary its history row and reports use. */
  async function polarOf(p: SleepPair): Promise<{ stages: readonly Stage[]; figures: PolarFigures; copy: SleepCopy } | null> {
    const { session, signals } = await store.loadSleep(p.polar.id);
    if (!session) return null;
    let a: SleepAnalysis | null = null;
    if (session.cloudOnly) {
      const report = parseSleepReport(session.report);
      if (report) a = toAnalysis(report);
    } else if (signals) {
      a = analyzeSleep({ durationS: session.durationS, ...signals } satisfies SleepData, { onsetUnknown: session.onsetUnknown === true });
    }
    if (!a) return null;
    const m = a.metrics;
    if (!p.polar.summary || !session.cloudOnly) { // kept up to date with how the stages are worked out
      p.polar.summary = { sleepMin: m.sleepMin, score: m.score, awakenings: m.awakenings, avgHR: m.avgHR, avgHrv: m.avgHrv, breathingRate: m.breathingRate };
      await store.updateSleep({ ...session, summary: p.polar.summary }).catch(() => undefined);
    }
    const { report: _report, ...saved } = { ...session, summary: p.polar.summary };
    return {
      stages: a.stages,
      copy: { session: saved, report: fromAnalysis(a) },
      figures: {
        sleepMin: m.sleepMin, deepMin: m.deepMin, lightMin: m.lightMin, remMin: m.remMin, awakeMin: m.awakeMin, deepPct: m.deepPct, remPct: m.remPct,
        awakenings: m.awakenings, avgHR: m.avgHR, avgHrv: m.avgHrv, breathingRate: m.breathingRate, score: m.score, coverage: m.coverage,
        onsetMs: Number.isFinite(m.onsetS) ? p.polar.start + m.onsetS * 1000 : null, wakeMs: Number.isFinite(m.wakeS) ? p.polar.start + m.wakeS * 1000 : null,
      },
    };
  }

  let running: Promise<boolean> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** Reports whose recording was deleted for good. A recording in the Recovery centre can come back, so its reports wait for it. */
  async function dropForgotten(left: readonly SavedSleepReports[]): Promise<boolean> {
    if (!left.length) return false;
    const api = await deps.loadD2();
    const polar = new Set([
      ...(await store.listSleeps(deps.user() as store.UserNumber)).map((s) => s.id),
      ...(await store.listBin()).flatMap((i) => (i.kind === 'sleep' ? [i.session.id] : [])),
    ]);
    const watch = new Set([...(await api.pairingSleep(deps.account(), deps.user())).map((w) => w.id), ...await api.recovery.nightIds(deps.account())]);
    const gone = left.filter((r) => !polar.has(r.polarId) || !watch.has(r.watchId));
    for (const r of gone) await store.deleteSleepReports(r.id);
    return gone.length > 0;
  }

  /** Makes the reports of new sleeps and of sleeps whose recordings changed; each change adds a version. Says if anything changed. */
  async function updateAll(): Promise<boolean> {
    if (deps.sleep.isRecording()) return false; // an analysis would hold up the recording
    const pairs = await loadPairs();
    const saved = new Map((await store.listSleepReports(deps.user())).map((r) => [r.id, r]));
    let changed = false;
    for (const p of pairs) {
      await new Promise((r) => setTimeout(r, 0)); // keep the page responsive
      const before = saved.get(p.id);
      saved.delete(p.id);
      if (!p.polar.summary || !before?.polarCopy || whatChanged(before, p)) {
        const polar = await polarOf(p);
        if (!polar) continue;
        const copies = { polar: polar.copy, watch: await (await deps.loadD2()).nightCopy(deps.account(), p.watch.id) };
        if (whatChanged(before, p)) await store.saveSleepReports(buildReports(p, polar.figures, polar.stages, EPOCH_S, Date.now(), before, copies));
        else if (before) await store.saveSleepReports({ ...before, polarCopy: copies.polar, watchCopy: copies.watch }); // made before versions kept these
        changed = true;
      }
    }
    return (await dropForgotten([...saved.values()])) || changed;
  }

  function generate(): Promise<boolean> {
    running ??= updateAll().catch(() => false).finally(() => { running = null; });
    return running;
  }

  /** Something changed: a recording stopped, the watch's sleep arrived, or another device synced. */
  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void generate().then((changed) => { if (changed && historyRoot.offsetParent) void renderList(); });
    }, 2000);
  }

  // ---------- history ----------

  const ecgOf = async (r: { ecgId: string | null; start: number; end: number }): Promise<FoundEcg | null> => {
    if (r.ecgId) {
      const { session } = await store.loadSession(r.ecgId);
      if (session) return { id: session.id, label: dateTime(session.start) };
    }
    return deps.ecgDuring(r.start, r.end);
  };

  const backToHistory = (): void => deps.show('syncSleepHistory');

  const madeText = (r: PastSleepReports): string => (r.changed === 'new'
    ? `Generated ${dateTime(r.generatedAt)}`
    : r.changed === 'combine' && (r.combineRule ?? 1) >= 4 ? `Generated again ${dateTime(r.generatedAt)}, because where the Polar H10 couldn’t tell the stage, a waking the Watch D2 saw now counts`
    : r.changed === 'combine' && (r.combineRule ?? 1) >= 3 ? `Generated again ${dateTime(r.generatedAt)}, because breaks of 1–2 minutes inside a longer block are now part of it, and being awake before falling asleep no longer counts as waking up`
    : r.changed === 'combine' ? `Generated again ${dateTime(r.generatedAt)}, because the combined stages now come from the Polar H10, with the watch filling its gaps`
    : r.changed === 'labels' ? `Generated again ${dateTime(r.generatedAt)}, because you changed how this sleep is counted`
    : r.changed === 'method' ? `Generated again ${dateTime(r.generatedAt)}, because the Polar H10 sleep stages are now worked out better`
    : `Generated again ${dateTime(r.generatedAt)}, because ${r.changed === 'polar' ? 'the Polar H10 recording' : r.changed === 'watch' ? 'the watch’s sleep' : 'both recordings'} changed`);

  async function renderList(): Promise<void> {
    const head = make('h2', '', 'Synchronised Sleep Tracking History ');
    head.appendChild(make('span', 'muted', `· ${deps.userLabel()}`));
    let pairs: SleepPair[];
    try {
      pairs = await loadPairs();
    } catch (err) {
      historyRoot.replaceChildren(head, make('p', 'muted', `D2 Link could not be loaded (${errorMessage(err)}). Check the internet connection and reopen this page.`));
      return;
    }
    if (!pairs.length) {
      historyRoot.replaceChildren(head, make('p', 'muted', 'No sleep recorded by both devices yet. Record on Synchronised Sleep Tracking, or on Sleep monitor, then download the watch’s sleep in D2 Link.'));
      return;
    }
    const saved = new Map((await store.listSleepReports(deps.user())).map((r) => [r.id, r]));
    const list = make('ul', 'sessions');
    for (const p of pairs) {
      const r = saved.get(p.id);
      const ecg = await ecgOf({ ecgId: p.polar.ecgId ?? null, start: p.start, end: Math.max(p.polar.start + p.polar.durationS * 1000, p.watch.wokeMs) });
      const stale = !r || whatChanged(r, p) != null;
      const demo = p.polar.source === 'demo' || p.watch.demo;
      const tags = [demo ? 'demo' : '', ecg ? 'with ECG' : 'no ECG'].filter(Boolean).join(' · ');
      if (stale) {
        const li = make('li', 'sync-sleep-row');
        li.append(
          make('span', 'when', `${dateTime(p.start)} · ${p.nap ? 'Nap' : 'Night'}`), make('span', 'dur', tags),
          make('span', 'muted sync-sleep-made', deps.sleep.isRecording() ? 'Reports are generated when the recording stops' : 'Generating the combined and comparison reports…'),
        );
        list.appendChild(li);
      }
      if (!r) continue;
      // one row per version, newest first, each with its four reports
      const versions: PastSleepReports[] = [...(r.past ?? []), r];
      for (let n = versions.length; n >= 1; n--) {
        const v = versions[n - 1]!;
        const li = make('li', 'sync-sleep-row');
        li.append(
          whenLine(dateTime(p.start), `${p.nap ? 'Nap' : 'Night'}${versions.length > 1 ? ` · Version ${n} of ${versions.length}${n === versions.length ? ' (latest)' : ''}` : ''}`),
          make('span', 'dur', tags),
          make('span', 'stats', `Polar H10 ${fmtHM(v.polar.sleepMin)} · Watch D2 ${fmtHM(v.watch.sleepMin)}${v.agreement.stagePct == null ? '' : ` · ${fmt(v.agreement.stagePct)} % same stage`}`),
          make('span', 'muted sync-sleep-made', madeText(v)),
        );
        const actions = make('div', 'row wrap sync-sleep-actions');
        actions.append(
          button('Polar H10 report', 'small', () => openPolar(v, r, backToHistory)),
          button('D2 report', 'small', () => openWatch(v, r, backToHistory)),
          button('Combined report', 'small', () => void openReport(p.id, 'combined', v.generatedAt)),
          button('Comparison report', 'small', () => void openReport(p.id, 'comparison', v.generatedAt)),
        );
        if (ecg) actions.appendChild(button('ECG', 'small', () => deps.openEcg(ecg.id)));
        li.appendChild(actions);
        list.appendChild(li);
      }
    }
    historyRoot.replaceChildren(head, make('p', 'muted', 'Each sleep has four reports, and every report links to the ECG saved with it. The combined and comparison reports are generated automatically, and again if either recording changes.'), list);
  }

  async function refreshHistory(): Promise<void> {
    await renderList();
    if (await generate()) await renderList();
  }

  // ---------- combined and comparison reports ----------

  async function ecgCard(r: PastSleepReports): Promise<HTMLElement> {
    const box = make('div', 'card d2-more');
    box.appendChild(make('h3', '', `ECG during this ${r.nap ? 'nap' : 'night'}`));
    const ecg = await ecgOf(r);
    if (!ecg) { box.appendChild(make('p', 'muted', 'No ECG was saved during this sleep. Recordings made with the Start sleep & ECG recording button save one.')); return box; }
    box.append(moreRow('Saved ECG', ecg.label), button('Open ECG report', '', () => deps.openEcg(ecg.id)));
    return box;
  }

  /** The latest version is the report itself; an earlier one is its saved copy. */
  function openPolar(v: PastSleepReports, all: SavedSleepReports, back: () => void): void {
    if (v.generatedAt !== all.generatedAt && v.polarCopy) deps.openPolarCopy(v.polarCopy, back); else deps.openPolar(v.polarId, back);
  }
  function openWatch(v: PastSleepReports, all: SavedSleepReports, back: () => void): void {
    deps.openWatch(v.watchId, back, v.generatedAt !== all.generatedAt ? v.watchCopy : undefined);
  }

  /** `r` is the version on the page: its other reports, and coming back, stay on it. */
  function reportBar(r: PastSleepReports, kind: 'combined' | 'comparison', all: SavedSleepReports): HTMLElement {
    const at = r.generatedAt;
    const bar = make('div', 'row between wrap no-print');
    bar.appendChild(button('← Synchronised Sleep Tracking History', '', backToHistory));
    const right = make('div', 'row wrap');
    right.append(
      button('Polar H10 report', '', () => openPolar(r, all, () => void openReport(r.id, kind, at))),
      button('D2 report', '', () => openWatch(r, all, () => void openReport(r.id, kind, at))),
      button('Combined report', kind === 'combined' ? 'primary' : '', () => void openReport(r.id, 'combined', at)),
      button('Comparison report', kind === 'comparison' ? 'primary' : '', () => void openReport(r.id, 'comparison', at)),
      button('Print / PDF', '', () => window.print()),
    );
    bar.appendChild(right);
    return bar;
  }

  /** `at` picks an earlier version by when it was generated; without it, the latest. */
  async function openReport(id: string, kind: 'combined' | 'comparison', at?: number): Promise<void> {
    deps.show('syncSleepReport');
    reportRoot.replaceChildren(make('div', 'busy', 'Opening the report…'));
    await new Promise((r) => setTimeout(r, 30));
    await generate();
    const r = await store.loadSleepReports(id);
    if (!r) {
      reportRoot.replaceChildren(button('← Synchronised Sleep Tracking History', '', backToHistory), make('p', 'muted', deps.sleep.isRecording() ? 'This report is generated when the recording stops.' : 'One of the recordings is no longer on this device, so this report could not be generated.'));
      return;
    }
    const shown = r.past?.find((v) => v.generatedAt === at) ?? r;
    const ecg = await ecgCard(shown);
    if (kind === 'combined') renderCombined(shown, ecg, r); else renderComparison(shown, ecg, r);
    window.scrollTo(0, 0);
  }

  function renderCombined(r: PastSleepReports, ecg: HTMLElement, all: SavedSleepReports): void {
    const stages = r.combined.map((x) => (x === 'asleep' ? null : x)), f = r.figures, m = r.polar, w = r.watch, R = sleepRanges(), nap = r.nap;

    const top = make('div', 'card d2-night');
    const big = make('div', 'd2-big');
    big.append(make('div', 'muted', `Combined ${nap ? 'nap' : 'night'} sleep`), make('div', 'd2-big-value', fmtHM(f.sleepMin)));
    const chart = stageChart('', stages, r.timelineStart);
    const times = make('div', 'row between d2-times');
    const bed = make('div'), woke = make('div', 'd2-right');
    bed.append(make('div', 'muted', f.onsetMs ? shortDay(f.onsetMs) : ''), make('div', '', `Fell asleep ${clockOf(f.onsetMs)}`));
    woke.append(make('div', 'muted', f.wakeMs ? shortDay(f.wakeMs) : ''), make('div', '', `Woke up ${clockOf(f.wakeMs)}`));
    times.append(bed, woke);
    top.append(make('div', 'd2-datenav', dayName(f.wakeMs ?? r.start)), big, chart.figure, times, legend());

    const score = make('div', 'card d2-score');
    if (f.score != null) {
      const main = make('div', 'd2-score-main'), pts = make('div', 'd2-points', String(f.score));
      pts.appendChild(make('small', '', ' points'));
      main.append(pts, stars(f.score), make('div', 'muted', 'Sleep score worked out from the combined stages'));
      score.appendChild(main);
    }
    const mix = make('div', 'd2-mix'), donut = make('canvas');
    donut.width = donut.height = 160;
    const parts = [{ key: 'deep' as const, value: f.deepMin, pct: f.deepPct }, { key: 'light' as const, value: f.lightMin, pct: f.lightPct }, { key: 'rem' as const, value: f.remMin, pct: f.remPct }];
    const rows = make('ul', 'stage-list');
    for (const part of parts) {
      const li = make('li'), name = make('span', 'dot-label'), sw = make('span', 'swatch');
      sw.style.background = `var(${STAGE_COLOR_VAR[part.key]})`;
      name.append(sw, STAGE_LABEL[part.key]);
      li.append(name, make('span', '', fmtHM(part.value)), make('span', 'pct', `${fmt(part.pct)} %`));
      rows.appendChild(li);
    }
    mix.append(donut, rows);
    score.appendChild(mix);

    const tiles = make('div', 'd2-tiles');
    tiles.append(
      tile('Times woke up', String(f.awakenings), 'times', 'counted from the combined stages', { range: R.awakenings, value: f.awakenings, text: '0–1 times' }),
      tile('Light sleep', fmt(f.lightPct), '%', fmtHM(f.lightMin), { range: R.lightPct, value: f.lightPct, text: '<55 %' }),
      tile('Avg heart rate', fmt(m.avgHR), 'bpm', `Polar H10 · Watch D2 ${fmt(w.avgHR)} bpm`),
      ...(nap ? [tile('Nap sleep', fmtHM(f.sleepMin), '', '')] : [tile('Night sleep', fmtHM(f.sleepMin), '', '', { range: R.sleepHours, value: f.sleepMin / 60, text: '6–10 h' })]),
      tile('Deep sleep', fmt(f.deepPct), '%', fmtHM(f.deepMin), { range: R.deepPct, value: f.deepPct }),
      tile('REM sleep', fmt(f.remPct), '%', fmtHM(f.remMin), { range: R.remPct, value: f.remPct }),
      tile('Avg HRV', fmt(m.avgHrv), 'ms', `Polar H10 · Watch D2 ${fmt(w.avgHrv)} ms`),
      tile('Avg SpO₂', fmt(w.avgSpo2), w.avgSpo2 == null ? '' : '%', 'Watch D2 (the Polar H10 has no blood-oxygen sensor)'),
      tile('Avg respiratory rate', fmt(m.breathingRate, 1), 'brpm', `Polar H10 · Watch D2 ${fmt(w.avgBreath)} brpm`),
      tile('Sleep efficiency', fmt(f.efficiency), '%', 'asleep ÷ time recorded', { range: R.efficiency, value: f.efficiency }),
    );

    const about = make('details', 'card sources');
    about.appendChild(make('summary', '', 'How the two are combined'));
    const ul = make('ul');
    for (const line of [
      'The two recordings are lined up minute by minute on the clock. Where only one device has data, that device is used.',
      'Where both give the same stage, that stage is used.',
      'Where one says awake and the other asleep, it counts as awake if it lasts 5 minutes or more; a shorter stir counts as sleep.',
      'Where both say asleep but differ, deep or REM is used over light, because light is what both tend to fall back on. Deep against REM follows the strap, which has every heartbeat and your breathing.',
      'Heart rate, HRV and breathing come from the strap, and SpO₂ from the watch. The watch’s figures are shown beside them.',
      'This combining rule has not been checked against a sleep study, so treat the result as a third estimate, not a more accurate one. Not a medical device.',
    ]) ul.appendChild(make('li', '', line));
    about.appendChild(ul);

    reportRoot.replaceChildren(reportBar(r, 'combined', all), make('p', 'muted', madeText(r)), top, score, tiles, ecg, about);
    chart.draw();
    drawDonut(donut, parts);
  }

  function renderComparison(r: PastSleepReports, ecg: HTMLElement, all: SavedSleepReports): void {
    const m = r.polar, w = r.watch, agreement = r.agreement, nap = r.nap;
    const diff = (x: number | null, y: number | null): number | null => (x == null || y == null ? null : y - x);
    const minutes = (x: number | null, y: number | null): number | null => (x == null || y == null ? null : (y - x) / 60000);

    const head = make('div', 'card d2-score');
    const main = make('div', 'd2-score-top');
    const score = make('div', 'd2-score-main');
    const pts = make('div', 'd2-points', agreement.stagePct == null ? 'N/A' : fmt(agreement.stagePct));
    pts.appendChild(make('small', '', ' %'));
    score.append(pts, make('div', 'muted', 'of minutes in the same stage'));
    const facts = make('div');
    facts.append(
      moreRow('Same main stage in 5-minute blocks', agreement.fiveMinPct == null ? '--' : `${fmt(agreement.fiveMinPct)} %`),
      moreRow('Agree on asleep or awake', agreement.sleepWakePct == null ? '--' : `${fmt(agreement.sleepWakePct)} %`),
      moreRow('Agreement beyond chance (kappa)', agreement.kappa == null ? 'N/A: the watch gave no stages' : `${agreement.kappa.toFixed(2)} ${agreement.kappa >= 0.6 ? '(good)' : agreement.kappa >= 0.4 ? '(moderate)' : '(weak)'}`),
      moreRow('Minutes both recorded', String(agreement.sharedMin)),
    );
    main.append(score, facts);
    head.append(make('div', 'd2-datenav', `${dayName(r.start)} · ${nap ? 'Nap' : 'Night'}`), main);

    const charts = make('div', 'card d2-night');
    const polarChart = stageChart('Polar H10', r.polarMinutes.map((x) => (x === 'asleep' ? null : x)), r.timelineStart);
    const watchChart = stageChart('Watch D2', r.watchMinutes.map((x) => (x === 'asleep' ? 'light' : x)), r.timelineStart);
    charts.append(polarChart.figure, watchChart.figure, legend());

    const rows: [string, string, string, string][] = [
      ['Total sleep', fmtHM(m.sleepMin), fmtHM(w.sleepMin), signed(w.sleepMin - m.sleepMin, ' min')],
      ['Deep sleep', fmtHM(m.deepMin), fmtHM(w.deepMin), signed(w.deepMin - m.deepMin, ' min')],
      ['Light sleep', fmtHM(m.lightMin), fmtHM(w.lightMin), signed(w.lightMin - m.lightMin, ' min')],
      ['REM sleep', fmtHM(m.remMin), fmtHM(w.remMin), signed(w.remMin - m.remMin, ' min')],
      ['Awake after falling asleep', fmtHM(m.awakeMin), fmtHM(w.awakeMin), signed(w.awakeMin - m.awakeMin, ' min')],
      ['Fell asleep', clockSeconds(m.onsetMs), clockSeconds(w.bedMs), signed(m.onsetMs == null ? null : (w.bedMs - m.onsetMs) / 1000, ' s')],
      ['Woke up', clockOf(m.wakeMs), clockOf(w.wokeMs), signed(minutes(m.wakeMs, w.wokeMs), ' min')],
      ['Times woke up', String(m.awakenings), w.wakeups == null ? '--' : String(w.wakeups), signed(diff(m.awakenings, w.wakeups), '')],
      ['Avg heart rate', `${fmt(m.avgHR)} bpm`, w.avgHR == null ? '--' : `${w.avgHR} bpm`, signed(diff(m.avgHR, w.avgHR), ' bpm')],
      ['Avg HRV', `${fmt(m.avgHrv)} ms`, w.avgHrv == null ? '--' : `${w.avgHrv} ms`, signed(diff(m.avgHrv, w.avgHrv), ' ms')],
      ['Avg respiratory rate', `${fmt(m.breathingRate, 1)} brpm`, w.avgBreath == null ? '--' : `${w.avgBreath} brpm`, signed(diff(m.breathingRate, w.avgBreath), ' brpm', 1)],
      ...(nap ? [] : [['Sleep score', String(m.score), w.score == null ? '--' : String(w.score), signed(diff(m.score, w.score), '')] as [string, string, string, string]]),
    ];
    const tableCard = make('div', 'card');
    tableCard.appendChild(make('h3', '', 'Polar H10 and Watch D2 side by side'));
    tableCard.appendChild(table(['', 'Polar H10', 'Watch D2', 'Watch − Polar'], rows));

    const names: readonly Known[] = ['deep', 'light', 'rem', 'awake'];
    const matrix = make('div', 'card');
    matrix.append(make('h3', '', 'Where the stages differ'), make('p', 'note', 'Minutes in each stage on the Polar H10 (rows) and the Watch D2 (columns).'));
    matrix.appendChild(table(['Polar ↓ · Watch →', ...names.map((n) => STAGE_LABEL[n])], names.map((s) => [STAGE_LABEL[s], ...names.map((c) => String(agreement.matrix[s][c]))])));

    const tips = make('div', 'card');
    tips.appendChild(make('h3', '', 'How to improve accuracy'));
    const ul = make('ul', 'tips');
    for (const line of r.tips) ul.appendChild(make('li', '', line));
    tips.appendChild(ul);

    reportRoot.replaceChildren(reportBar(r, 'comparison', all), make('p', 'muted', madeText(r)), head, charts, tableCard, matrix, tips, ecg);
    polarChart.draw();
    watchChart.draw();
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

  return { refresh, refreshHistory, schedule };
}

export type { WatchSleep };
