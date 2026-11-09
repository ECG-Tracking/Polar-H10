// The parts every page that connects to a device shares, so they look and work the same:
// the connection log, "Forget pairing" for the Polar H10, and the "Track for" choice.

import { make, durationSeconds } from './ui';
import { currentStrap, disconnectStrap, onStrap } from './devices';

/** What to do when the Polar H10 isn't in Chrome's list or won't connect. */
export const H10_RESTART_TIP = 'If the Polar H10 didn’t appear in the list or wouldn’t connect: switch it off for 30 seconds (unclip the sensor from the strap), clip it back on, wet the electrodes, wear it, then press Connect again.';

export interface LogBox { el: HTMLPreElement; log: (line: string) => void; clear: () => void }

/** The connection log as on ECG live: hidden until there is something in it. Pass an existing <pre> to use it. */
export function connectionLog(label = 'Connection log', pre: HTMLPreElement = make('pre', 'log') as HTMLPreElement): LogBox {
  pre.classList.add('log');
  pre.setAttribute('aria-label', label);
  pre.hidden = !pre.textContent;
  return {
    el: pre,
    log: (line) => {
      pre.hidden = false;
      pre.textContent += `${new Date().toLocaleTimeString([], { hour12: false })}  ${line}\n`;
      pre.scrollTop = pre.scrollHeight;
    },
    clear: () => { pre.textContent = ''; pre.hidden = true; },
  };
}

const isStrap = (d: BluetoothDevice): boolean => (d.name ?? '').startsWith('Polar H10');

/** Polar H10 straps this browser remembers (Chrome keeps the permission after a pairing). */
async function rememberedStraps(): Promise<BluetoothDevice[]> {
  const bt = typeof navigator !== 'undefined' ? navigator.bluetooth as (Bluetooth & { getDevices?: () => Promise<BluetoothDevice[]> }) | undefined : undefined;
  try { return (await bt?.getDevices?.())?.filter(isStrap) ?? []; } catch { return []; }
}

type Forgettable = BluetoothDevice & { forget?: () => Promise<void> };
const forgetAll = new Set<() => void>(); // every page's button, so they all update together

/** "Forget pairing" for the Polar H10: disconnects it and makes the browser forget it, so the next connection pairs again. */
export function forgetStrapButton(log: (line: string) => void): { el: HTMLButtonElement; update: () => void } {
  const el = make('button', '', 'Forget pairing') as HTMLButtonElement;
  el.title = 'Disconnect the Polar H10 and make this browser forget it';
  el.hidden = true;
  const update = (): void => {
    void rememberedStraps().then((known) => { el.hidden = !(currentStrap() || known.length); });
  };
  el.addEventListener('click', () => void (async () => {
    if (!window.confirm('Forget the pairing with the Polar H10? It is disconnected, and next time you choose it from Chrome’s list again. Recordings are kept.')) return;
    const own = currentStrap()?.device as Forgettable | null | undefined;
    await disconnectStrap();
    const devices = new Set<Forgettable>([...(own ? [own] : []), ...await rememberedStraps()]);
    let forgot = 0;
    for (const d of devices) { try { await d.forget?.(); forgot++; } catch { /* already gone */ } }
    log(forgot ? 'Polar H10 pairing forgotten.' : 'Polar H10 disconnected. This browser can’t forget it itself: remove it in the computer’s or phone’s Bluetooth settings.');
    for (const fn of forgetAll) fn();
  })());
  forgetAll.add(update);
  onStrap(() => update());
  update();
  return { el, update };
}

/** Every page's Forget pairing buttons check again (after a connection or a disconnection). */
export function updateForgetButtons(): void { for (const fn of forgetAll) fn(); }

export type TrackKind = 'short' | 'sleep';

const CHOICES: Record<TrackKind, readonly (readonly [string, string])[]> = {
  short: [['60', '1 minute'], ['180', '3 minutes'], ['300', '5 minutes'], ['360', '6 minutes'], ['420', '7 minutes'], ['600', '10 minutes'], ['unlimited', 'Until I stop'], ['custom', 'Choose minutes…']],
  sleep: [['unlimited', 'Until I stop'], ['21600', '6 hours'], ['25200', '7 hours'], ['28800', '8 hours'], ['32400', '9 hours'], ['custom', 'Choose hours…']],
};

/** The chosen sleep length: 'custom' = `hours` (1–14, else 8). */
export function sleepSeconds(choice: string, hours: string): number | null {
  if (choice === 'unlimited') return null;
  if (choice === 'custom') { const h = Number(hours); return h >= 1 && h <= 14 ? Math.round(h * 3600) : 8 * 3600; }
  return Number(choice);
}

export interface TrackFor { el: HTMLElement; select: HTMLSelectElement; seconds: () => number | null; disable: (off: boolean) => void }

/**
 * "Track for …" with its choices; `select` and `custom` can be existing elements (ECG live's are in the page).
 * Short trackings are in minutes, sleep in hours.
 */
export function trackFor(kind: TrackKind, onChange: () => void = () => undefined, existing?: { select: HTMLSelectElement; custom: HTMLInputElement; customLabel: HTMLElement }): TrackFor {
  const select = existing?.select ?? make('select') as HTMLSelectElement;
  select.replaceChildren();
  for (const [v, t] of CHOICES[kind]) { const o = make('option', '', t) as HTMLOptionElement; o.value = v; select.appendChild(o); }
  select.value = kind === 'short' ? 'unlimited' : 'unlimited';
  const custom = existing?.custom ?? make('input') as HTMLInputElement;
  Object.assign(custom, kind === 'short' ? { type: 'number', min: '1', max: '240', step: '1', value: custom.value || '10' } : { type: 'number', min: '1', max: '14', step: '0.5', value: '8' });
  custom.setAttribute('aria-label', kind === 'short' ? 'Minutes' : 'Hours');
  const customLabel = existing?.customLabel ?? make('label', 'd2-days');
  if (!existing) customLabel.append(custom, kind === 'short' ? ' min' : ' h');
  else { const unit = customLabel.lastChild; if (unit?.nodeType === Node.TEXT_NODE) unit.textContent = kind === 'short' ? ' min' : ' h'; }
  customLabel.hidden = true;
  let el: HTMLElement;
  if (existing) el = select.closest('.sync-dur') ?? select.parentElement ?? select;
  else {
    const label = make('label', 'd2-days', 'Track for ');
    label.appendChild(select);
    el = make('div', 'row wrap sync-dur');
    el.append(label, customLabel);
  }
  const seconds = (): number | null => (kind === 'short' ? durationSeconds(select.value, custom.value) : sleepSeconds(select.value, custom.value));
  const changed = (): void => { customLabel.hidden = select.value !== 'custom'; onChange(); };
  select.addEventListener('change', changed);
  custom.addEventListener('input', changed);
  return { el, select, seconds, disable: (off) => { select.disabled = off; custom.disabled = off; } };
}
