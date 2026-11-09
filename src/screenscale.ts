// How many pixels make a real millimetre on this screen. A web page can't find that out, so it is measured once against
// a ruler or a bank card and kept on this device. Browser zoom is allowed for; a new display setting needs a new calibration.

import { make } from './ui';

const KEY = 'openbeat-screen-scale', SIZE_KEY = 'openbeat-ecg-size';
/** Used until the screen is calibrated; the printed strips always use it, because paper is measured in real mm. */
export const DEFAULT_PX_PER_MM = 4;
/** The short side of a bank card, and short enough to fit on a phone. */
export const BAR_MM = 54;
const MIN_PX_PER_MM = 2.5, MAX_PX_PER_MM = 9;

/** How many times bigger than actual size the live ECG is shown. The squares are simply magnified. */
export const SIZES = [[1, 'Actual size'], [2, 'Double size'], [3, 'Triple size']] as const;
export type EcgSize = (typeof SIZES)[number][0];
export const parseSize = (text: string | null): EcgSize => SIZES.find(([v]) => String(v) === text)?.[0] ?? 1;

export interface ScreenScale { pxPerMm: number; dpr: number } // dpr: the browser's zoom when it was measured

export function parseScale(text: string | null): ScreenScale | null {
  try {
    const v = JSON.parse(text ?? 'null') as Partial<ScreenScale> | null;
    if (typeof v?.pxPerMm === 'number' && v.pxPerMm >= MIN_PX_PER_MM && v.pxPerMm <= MAX_PX_PER_MM && typeof v.dpr === 'number' && v.dpr > 0) return { pxPerMm: v.pxPerMm, dpr: v.dpr };
  } catch { /* unreadable: not calibrated */ }
  return null;
}

/** Zooming in makes each page pixel bigger, so fewer of them make a millimetre. */
export const atZoom = (s: ScreenScale, dpr: number): number => (s.pxPerMm * s.dpr) / dpr;

const zoom = (): number => globalThis.devicePixelRatio || 1;

function load(): ScreenScale | null {
  try { return parseScale(localStorage.getItem(KEY)); } catch { return null; }
}

let saved: ScreenScale | null | undefined; // read once: live traces ask on every frame
const scale = (): ScreenScale | null => (saved === undefined ? (saved = load()) : saved);
const listeners = new Set<() => void>();

/** Runs `fn` whenever the calibration or the ECG size setting changes. */
export function onScaleChange(fn: () => void): void { listeners.add(fn); }

export function pxPerMm(): number {
  const s = scale();
  return s ? atZoom(s, zoom()) : DEFAULT_PX_PER_MM;
}

let size: EcgSize | undefined;

export function ecgSize(): EcgSize {
  if (size === undefined) {
    try { size = parseSize(localStorage.getItem(SIZE_KEY)); } catch { size = 1; }
  }
  return size;
}

function keepSize(next: EcgSize): void {
  size = next;
  try { localStorage.setItem(SIZE_KEY, String(next)); } catch { /* kept for this visit only */ }
  for (const fn of listeners) fn();
}

function keep(next: ScreenScale | null): void {
  saved = next;
  try {
    if (next) localStorage.setItem(KEY, JSON.stringify(next)); else localStorage.removeItem(KEY);
  } catch { /* kept for this visit only */ }
  for (const fn of listeners) fn();
}

/** The scale note below a live trace, with the calibration that goes with it. */
export function scaleNote(text: string): HTMLElement {
  const box = make('div', 'scale-note');
  const note = make('p', 'note');
  const choose = make('select');
  choose.setAttribute('aria-label', 'Size of the ECG trace');
  for (const [value, label] of SIZES) { const o = make('option', '', label); o.value = String(value); choose.appendChild(o); }
  choose.addEventListener('change', () => keepSize(parseSize(choose.value)));
  const open = make('button', 'small');
  open.type = 'button';
  const panel = make('div', 'scale-panel');
  panel.hidden = true;

  const bar = make('div', 'scale-bar');
  const slider = make('input');
  slider.type = 'range';
  slider.min = String(MIN_PX_PER_MM);
  slider.max = String(MAX_PX_PER_MM);
  slider.step = '0.01';
  slider.setAttribute('aria-label', 'Length of the bar');
  const show = (): void => { bar.style.width = `${BAR_MM * Number(slider.value)}px`; };
  slider.addEventListener('input', show);

  const save = make('button', 'primary', 'Save');
  const reset = make('button', '', 'Reset');
  const cancel = make('button', '', 'Cancel');
  for (const b of [save, reset, cancel]) b.type = 'button';
  const actions = make('div', 'row');
  actions.append(save, reset, cancel);
  panel.append(make('p', 'note', `Hold a ruler or the short side of a bank card against the screen, then drag the slider until the bar is exactly ${BAR_MM} mm long. Saved on this device only. Calibrate again if you change the display setting or use another screen.`), bar, slider, actions);

  const refresh = (): void => {
    const done = scale() != null, times = ecgSize();
    const square = times === 1 ? '1 mm' : `${times} mm (magnified ${times} times)`;
    note.textContent = `${text} ${done ? `Calibrated for this screen: one small square is ${square}.` : `This screen isn’t calibrated, so a small square may not be exactly ${square}.`}`;
    choose.value = String(times);
    open.textContent = done ? 'Calibrate again' : 'Calibrate screen';
    reset.hidden = !done;
  };
  open.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    slider.value = String(pxPerMm());
    show();
  });
  save.addEventListener('click', () => { keep({ pxPerMm: Number(slider.value), dpr: zoom() }); panel.hidden = true; });
  reset.addEventListener('click', () => { keep(null); panel.hidden = true; });
  cancel.addEventListener('click', () => { panel.hidden = true; });

  listeners.add(refresh);
  refresh();
  const controls = make('div', 'row');
  controls.append(choose, open);
  box.append(note, controls, panel);
  return box;
}
