// "Watch message capture": for working out how the watch starts its ECG. Records every message the watch sends while it
// runs, whatever else is running (time, service/command, the fields' tags and lengths, and only protocol numbers as values), with marks
// the person adds ("ECG screen opened", "Finger on the button", …), and saves it as a text file to share.

import { download, make } from './ui';
import type { LiveWatch } from './d2/live';

export interface CaptureDeps {
  watch: () => LiveWatch | null;
  /** Pauses and resumes the watch's heartbeat test, so the ECG is seen on its own. */
  pauseHeartbeats: () => Promise<void>;
  resumeHeartbeats: () => Promise<void>;
  /** Pauses the check for new watch ECG strips (every 20 s, and on the watch’s cue), whose own replies would fill the capture; true if it was running. */
  pauseStripChecks: () => boolean;
  /** `fromMs`: strips from then on are fetched (those taken during the capture). */
  resumeStripChecks: (fromMs: number) => void;
  log: (line: string) => void;
}

const MARKS = ['Idle (nothing touched)', 'ECG screen opened on the watch', 'Finger on the button', 'ECG finished', 'ECG screen closed'] as const;
const SHOWN = 400; // lines on screen; the saved file has them all

export function watchCaptureCard(deps: CaptureDeps): { el: HTMLElement; update: () => void } {
  const box = make('details', 'card watch-capture') as HTMLDetailsElement;
  box.appendChild(make('summary', '', 'Watch message capture (testing)'));
  const note = make('p', 'note', 'For working out how the watch starts its ECG. While it runs, every message the watch sends is listed with its time, its layout and, for the known ECG messages, a few protocol numbers (package names, the configuration ID and action, state bytes) – never measurements or health data. Start it, then add a mark at each step as you take one ECG on the watch by hand: open the ECG screen, wait, put your finger on the button, let it finish, close the screen. Then press Save and share the file. The live heartbeat test can pause while it runs; the checks for new strips keep running unless you choose to pause them too.');
  const btnStart = make('button', 'primary', 'Start capture') as HTMLButtonElement;
  const btnStop = make('button', '', 'Stop') as HTMLButtonElement;
  btnStop.hidden = true;
  const pause = make('input') as HTMLInputElement;
  pause.type = 'checkbox';
  pause.checked = true;
  const pauseLabel = make('label', 'check');
  pauseLabel.append(pause, ' Pause the live heartbeat test while capturing (so the ECG is seen on its own)');
  const pauseStrips = make('input') as HTMLInputElement;
  pauseStrips.type = 'checkbox';
  pauseStrips.checked = false; // off: the capture then shows the downloads as they happen in ordinary use
  const pauseStripsLabel = make('label', 'check');
  pauseStripsLabel.append(pauseStrips, ' Also pause the checks for new watch ECG strips (a quieter record; strips taken meanwhile are fetched afterwards)');
  const mark = make('select') as HTMLSelectElement;
  mark.setAttribute('aria-label', 'Mark');
  for (const m of MARKS) { const o = make('option', '', m) as HTMLOptionElement; o.value = m; mark.appendChild(o); }
  const btnMark = make('button', '', 'Add mark') as HTMLButtonElement;
  const btnSave = make('button', '', 'Save as text') as HTMLButtonElement;
  btnSave.disabled = true;
  const row1 = make('div', 'row wrap'), row2 = make('div', 'row wrap');
  row1.append(btnStart, btnStop, btnSave);
  row2.append(mark, btnMark);
  const status = make('p', 'muted', 'Not running.');
  const pre = make('pre', 'log') as HTMLPreElement;
  pre.hidden = true;
  box.append(note, row1, pauseLabel, pauseStripsLabel, row2, status, pre);

  let lines: string[] = [], stop: (() => void) | null = null, count = 0, paused = false, stripsPaused = false, startedAt = 0;
  const stamp = (): string => { const d = new Date(); return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`; };
  const add = (line: string): void => {
    lines.push(line);
    pre.hidden = false;
    pre.textContent = lines.slice(-SHOWN).join('\n');
    pre.scrollTop = pre.scrollHeight;
    btnSave.disabled = false;
  };
  const update = (): void => {
    const w = deps.watch();
    btnStart.hidden = stop != null; btnStop.hidden = stop == null;
    btnStart.disabled = !w;
    btnMark.disabled = stop == null;
    if (!w && stop) { stop(); stop = null; add(`${stamp()}  -- the watch disconnected; capture stopped`); status.textContent = 'The watch disconnected: capture stopped.'; update(); }
    else if (!w && !stop) status.textContent = lines.length ? status.textContent : 'Connect the watch first.';
  };

  btnStart.addEventListener('click', () => void (async () => {
    const w = deps.watch();
    if (!w || stop) return;
    lines = [`OpenBeat ECG watch message capture · ${new Date().toISOString()} · ${navigator.userAgent}`, 'time  service/command [enc] fields (tag:length; containers [..]×repeats)'];
    count = 0;
    startedAt = Date.now();
    if (pause.checked) { await deps.pauseHeartbeats(); paused = true; add(`${stamp()}  -- heartbeat test paused`); }
    stripsPaused = pauseStrips.checked && deps.pauseStripChecks();
    if (stripsPaused) add(`${stamp()}  -- checks for new watch ECG strips paused (they are fetched after the capture)`);
    stop = w.capture((line) => { count++; add(line); status.textContent = `Capturing: ${count} message${count === 1 ? '' : 's'} from the watch.`; });
    add(`${stamp()}  -- capture started`);
    status.textContent = 'Capturing: 0 messages from the watch.';
    deps.log('Watch message capture started.');
    update();
  })());
  btnStop.addEventListener('click', () => void (async () => {
    stop?.(); stop = null;
    add(`${stamp()}  -- capture stopped (${count} messages)`);
    if (paused) { paused = false; await deps.resumeHeartbeats(); add(`${stamp()}  -- heartbeat test resumed`); }
    if (stripsPaused) { stripsPaused = false; deps.resumeStripChecks(startedAt - 60_000); add(`${stamp()}  -- checks for new watch ECG strips resumed`); }
    status.textContent = `Stopped: ${count} message${count === 1 ? '' : 's'}. Press Save as text to keep them.`;
    deps.log('Watch message capture stopped.');
    update();
  })());
  btnMark.addEventListener('click', () => add(`${stamp()}  >> MARK: ${mark.value}`));
  btnSave.addEventListener('click', () => {
    const d = new Date(), p = (n: number): string => String(n).padStart(2, '0');
    download(new Blob([`${lines.join('\n')}\n`], { type: 'text/plain' }), `watch-capture-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.txt`);
  });
  queueMicrotask(update);
  return { el: box, update };
}
