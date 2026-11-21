// Three event bars under two ECGs shown one above the other: events both devices saw at the same heartbeat, the Polar
// H10's alone and the Watch D2's alone, each with its own Previous and Next.

import { EVENT_LABELS } from './dsp';
import type { EventKind, EventSpot } from './stripmatch';
import { make } from './ui';

const TITLES: Readonly<Record<EventKind, string>> = { both: 'Both H10 and D2', polar: 'H10 only', watch: 'D2 only' };
const SEEN: Readonly<Record<EventKind, string>> = { both: 'seen by both devices', polar: 'seen by the H10 only', watch: 'seen by the D2 only' };

export interface EventNav {
  el: HTMLElement;
  /** The events to step through; `note` adds a word about one (for example where the other device wasn't recording). */
  set(spots: readonly EventSpot[], note?: (s: EventSpot) => string): void;
}

/** `go` moves both ECGs to a moment (s); `when` gives its time of day. */
export function eventNav(go: (t: number) => void, when: (t: number) => string): EventNav {
  const el = make('div', 'event-navs no-print');
  const rows = (['both', 'polar', 'watch'] as const).map((kind) => {
    const text = make('span', 'muted', '');
    const prev = make('button', '', '← Previous event'), next = make('button', '', 'Next event →');
    prev.type = next.type = 'button';
    const row = make('div', 'row wrap event-nav');
    row.append(make('strong', 'event-kind', TITLES[kind]), prev, text, next);
    el.appendChild(row);
    let list: EventSpot[] = [], idx = -1, note: (s: EventSpot) => string = () => '';
    const show = (i: number): void => {
      const s = list[i];
      if (!s) return;
      idx = i;
      go(s.t);
      const extra = note(s);
      text.textContent = `Event ${i + 1} of ${list.length} at ${when(s.t)} · ${EVENT_LABELS[s.type]} · ${SEEN[kind]}${extra ? ` · ${extra}` : ''}`;
    };
    prev.addEventListener('click', () => show(Math.max(0, idx - 1)));
    next.addEventListener('click', () => show(Math.min(list.length - 1, idx + 1)));
    return (all: readonly EventSpot[], n?: (s: EventSpot) => string): void => {
      list = all.filter((s) => s.kind === kind);
      idx = -1;
      note = n ?? (() => '');
      prev.disabled = next.disabled = !list.length;
      text.textContent = list.length ? `${list.length} event${list.length > 1 ? 's' : ''}, ${SEEN[kind]}` : `No events ${SEEN[kind]}`;
    };
  });
  return { el, set: (spots, n) => { for (const r of rows) r(spots, n); } };
}
