// DOM helpers and report tiles shared by the ECG and sleep screens.

import { checkRange, fmtRange, type Range, type RangeStatus } from './ranges';

/** Element by id, checked to be of the expected type; a missing element is a bug in index.html. */
export function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`#${id} is missing or not a ${type.name}`);
  return el;
}
export const $ = (id: string): HTMLElement => byId(id, HTMLElement);
export const $button = (id: string): HTMLButtonElement => byId(id, HTMLButtonElement);
export const $input = (id: string): HTMLInputElement => byId(id, HTMLInputElement);
export const $canvas = (id: string): HTMLCanvasElement => byId(id, HTMLCanvasElement);

/** New element with an optional class and text. */
export function make<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

export const fmt = (v: number | null | undefined, d = 0): string => (v == null || !Number.isFinite(v) ? '--' : v.toFixed(d));

/** "6 h 49 min" */
/** A row's first line: the date and time in bold, then where it came from in normal weight. */
export function whenLine(date: string, from: string): HTMLSpanElement {
  const el = make('span', 'when', date);
  el.appendChild(make('span', 'from', ` · ${from}`));
  return el;
}

export function fmtHM(minutes: number): string {
  if (!Number.isFinite(minutes)) return '--';
  const m = Math.round(minutes);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

export interface Outlier { name: string; value: string; range: string; status: RangeStatus }

/** How a metric relates to its reference range. */
export type MetricRef =
  | {
    range: Range;
    value: number | null | undefined;
    display?: string; // value text for the outliers list
    label?: string; // instead of "Ref", e.g. "Personal range"
    rangeText?: string; // instead of the formatted range, e.g. "6–10 h"
    okLabel?: string; // shown when in range, e.g. "Normal"
  }
  | { skipped: string };

/** A report tile; a value outside its reference range is flagged and added to `outliers`. */
export function metricTile(k: string, v: string, unit: string, hint: string, ref: MetricRef | null | undefined, outliers: Outlier[]): HTMLDivElement {
  const el = make('div', 'metric');
  const value = make('div', 'v', v);
  if (unit && v !== '--') value.appendChild(make('small', '', unit));
  el.append(make('div', 'k', k), value, make('div', 'h', hint));
  if (ref && 'range' in ref) {
    const refUnit = ref.display ? '%' : unit.trim();
    const rangeText = ref.rangeText ?? `${fmtRange(ref.range)}${refUnit ? ` ${refUnit}` : ''}`;
    el.appendChild(make('div', 'ref', `${ref.label ?? 'Ref'} ${rangeText}${ref.range.note ? ` · ${ref.range.note}` : ''}`));
    const status = checkRange(ref.range, ref.value);
    if (status) {
      el.classList.add('out');
      const label = status === 'high' ? ref.range.highLabel : ref.range.lowLabel;
      el.appendChild(make('div', 'flag', `${status === 'high' ? '▲' : '▼'} ${label ?? (status === 'high' ? 'Above range' : 'Below range')}`));
      outliers.push({ name: label ? `${k} (${label.toLowerCase()})` : k, value: ref.display ?? `${v}${unit ? ` ${unit.trim()}` : ''}`, range: rangeText, status });
    } else if (ref.okLabel && ref.value != null && Number.isFinite(ref.value)) {
      el.appendChild(make('div', 'flag ok', `✓ ${ref.okLabel}`));
    }
  } else if (ref) {
    el.appendChild(make('div', 'ref', ref.skipped));
  }
  return el;
}

/** Outliers summary box: "N values outside the reference range" with one row each. */
export function renderOutliers(box: HTMLElement, outliers: readonly Outlier[], notes: readonly string[] = []): void {
  box.replaceChildren();
  box.className = `flags ${outliers.length ? 'has' : 'none'}`;
  box.appendChild(make('div', 'flags-head', outliers.length
    ? `${outliers.length} value${outliers.length > 1 ? 's' : ''} outside the reference range`
    : '✓ All values within reference ranges'));
  for (const o of outliers) {
    const row = make('div', 'flags-row');
    row.append(
      make('span', '', `${o.status === 'high' ? '▲' : '▼'} ${o.name}`),
      make('span', '', o.value),
      make('span', '', `ref ${o.range}`),
    );
    box.appendChild(row);
  }
  for (const n of notes) box.appendChild(make('div', 'flags-note', n));
}

export function download(blob: Blob, name: string): void {
  const a = make('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** A chosen length in seconds: 'unlimited' = null (until stopped), 'custom' = `minutes` (1–240, else 10), or a number of seconds. */
export function durationSeconds(choice: string, minutes: string): number | null {
  if (choice === 'unlimited') return null;
  if (choice === 'custom') { const m = Math.round(Number(minutes)); return m >= 1 && m <= 240 ? m * 60 : 600; }
  return Number(choice);
}

/**
 * The dark red × that deletes a row (after asking). It doesn't open the row it sits on.
 * `what` names the row for screen readers and the question, e.g. "this recording".
 */
export function deleteButton(what: string, onDelete: () => void | Promise<void>, question = `Delete ${what}?`): HTMLButtonElement {
  const b = make('button', 'row-del', '×');
  b.type = 'button';
  b.title = `Delete ${what}`;
  b.setAttribute('aria-label', `Delete ${what}`);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (window.confirm(question)) void onDelete();
  });
  return b;
}

/** Shows the × at the front of each row (cells .del-front) while the table is too wide and its end is out of sight. */
export function frontDeletes(wrap: HTMLElement): void {
  new ResizeObserver(() => {
    wrap.classList.remove('wide');
    wrap.classList.toggle('wide', wrap.scrollWidth > wrap.clientWidth + 1);
  }).observe(wrap);
}
