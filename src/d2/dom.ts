// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — small DOM and formatting helpers shared by the screens.
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const SVG = 'http://www.w3.org/2000/svg';
export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, title?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (title) { const t = document.createElementNS(SVG, 'title'); t.textContent = title; e.appendChild(t); }
  return e;
}
export function button(text: string, cls = ''): HTMLButtonElement { const b = el('button', cls, text); b.type = 'button'; return b; }

export const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
export const shortDate = (ms: number): string => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}`; };
export const dayLabel = (ms: number): string => new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
export const hm = (min: number): string => {
  const total = Math.round(min);
  return total < 60 ? `${total} min` : `${Math.floor(total / 60)} h ${total % 60} min`;
};


/**
 * The dark red × that deletes a row (after asking). It doesn't open the row it sits on.
 * `what` names the row for screen readers and the question, e.g. "this night".
 */
export function deleteButton(what: string, onDelete: () => void | Promise<void>, question = `Delete ${what}?`): HTMLButtonElement {
  const b = button('×', 'row-del');
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
