// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — the "All data" view: everything downloaded from the watch over a chosen period: sleep, activity per day,
// the daily totals, the watch's measurements (blood pressure, HRV, emotion), stress, workouts and the ECG recordings.
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

import { clock, dateTime, dayLabel, deleteButton, el, frontDeletes, hm } from './dom';
import { READING_CLASSES, WORKOUT_TYPES, type ActivityMinute } from './extra';
import { rangePicker, spanOf, type CustomDates, type Range, type WatchEcg } from './graphsui';
import { figures, isNap } from './night';
import { minutesOf } from './records';
import * as store from './store';
import type { D2Night, D2Record } from './store';
import { dateOf } from './trends';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (v: number | null, digits = 0): string => (v == null ? '--' : v.toFixed(digits));
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/** A table; with `recs`, each row ends in a × that deletes its record (row i ↔ recs[i]). */
function table(head: string[], rows: string[][], recs?: readonly D2Record[], onDelete?: (r: D2Record) => void): HTMLElement {
  const wrap = el('div', 'd2-table-wrap');
  const t = el('table', 'd2-table');
  const tr = el('tr');
  if (recs) tr.appendChild(el('th', 'del-col del-front'));
  for (const h of head) tr.appendChild(el('th', '', h));
  if (recs) tr.appendChild(el('th', 'del-col'));
  t.appendChild(el('thead')).appendChild(tr);
  const body = el('tbody');
  rows.forEach((r, i) => {
    const row = el('tr');
    const rec = recs?.[i];
    const delCell = (cls: string): HTMLElement => {
      const td = el('td', cls);
      if (rec && onDelete) td.appendChild(deleteButton('this row', () => onDelete(rec), 'Delete this row? You can get it back from the Recovery centre. It is also removed from your other devices.'));
      return td;
    };
    if (recs) row.appendChild(delCell('del-col del-front'));
    for (const c of r) row.appendChild(el('td', '', c));
    if (recs) row.appendChild(delCell('del-col'));
    body.appendChild(row);
  });
  t.appendChild(body);
  wrap.appendChild(t);
  if (recs) frontDeletes(wrap);
  return wrap;
}

/** The category open in All data (kept while the view is drawn again, e.g. after a delete or a new period). */
let openTitle: string | null = null;
/** "Display all": every category open; off again, one at a time. */
let showAll = false;

/**
 * One category as a heading that opens when clicked; opening one closes the others (one open at a time). The heading
 * shows how many rows it has.
 */
function section(title: string, note: string, content: HTMLElement | null): HTMLElement {
  const s = el('details', 'card d2-data d2-fold');
  s.dataset['title'] = title;
  const rows = content?.querySelectorAll('tbody tr').length ?? 0;
  const head = el('summary');
  head.append(el('h3', '', title), el('span', 'muted', rows ? `${rows} row${rows === 1 ? '' : 's'}` : ''));
  s.appendChild(head);
  if (note) s.appendChild(el('p', 'note', note));
  if (content) s.appendChild(content);
  s.open = showAll || openTitle === title;
  s.addEventListener('toggle', () => {
    if (showAll) return; // all open: each can still be closed and opened on its own
    if (s.open) {
      openTitle = title;
      for (const o of s.parentElement?.querySelectorAll<HTMLDetailsElement>('details.d2-fold') ?? []) if (o !== s) o.open = false;
    } else if (openTitle === title) openTitle = null;
  });
  return s;
}

/** What All data shows besides the records: sleep, the ECG recordings, and the period ("Show", as in Graphs). */
export interface AllDataOpts {
  nights?: readonly D2Night[];
  ecgs?: readonly WatchEcg[];
  openEcg?: (id: string) => void;
  range?: Range; dates?: CustomDates; onRange?: (r: Range, dates?: CustomDates) => void;
  now?: number;
}

/** `changed` is called after a row was deleted (to show the data again and sync). */
export function renderAllData(box: HTMLElement, allRecords: readonly D2Record[], changed: () => void = () => {}, opts: AllDataOpts = {}): void {
  const del = (r: D2Record): void => { void store.deleteRecord(r).then(changed); };
  const nights = opts.nights ?? [], ecgs = opts.ecgs ?? [], range = opts.range ?? 'all', dates = opts.dates ?? { from: '', to: '' };
  box.replaceChildren();
  if (opts.onRange) box.appendChild(rangePicker(range, dates, opts.onRange));
  const [from, to] = spanOf(range, dates, opts.now ?? Date.now(), [...nights.map((n) => n.start), ...allRecords.map((r) => r.start), ...ecgs.map((e) => e.start)]);
  const inRange = (t: number): boolean => t >= from && t <= to;
  // an activity day is in the period when any part of the day is; the daily totals by when they were downloaded
  const records = allRecords.filter((r) => (r.kind === 'activity' ? (() => { const d = dateOf(r.id).getTime(); return d <= to && d + 86400000 > from; })() : r.kind === 'totals' ? inRange(r.downloadedAt) : inRange(r.start)));
  const sleeps = nights.filter((n) => inRange(figures(n).wokeMs)).sort((a, b) => b.start - a.start);
  const ecgIn = ecgs.filter((e) => inRange(e.start)).sort((a, b) => b.start - a.start);
  const day = (t: number): string => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  box.appendChild(el('p', 'note', `${day(from)} – ${day(to)}. Newest first. Click a heading to open it.`));
  const all = el('button', showAll ? 'primary' : '', 'Display all');
  all.type = 'button';
  all.setAttribute('aria-pressed', String(showAll));
  all.title = showAll ? 'Back to one category at a time' : 'Open every category';
  all.addEventListener('click', () => {
    showAll = !showAll;
    all.setAttribute('aria-pressed', String(showAll));
    all.className = showAll ? 'primary' : '';
    all.title = showAll ? 'Back to one category at a time' : 'Open every category';
    for (const d of box.querySelectorAll<HTMLDetailsElement>('details.d2-fold')) d.open = showAll || d.dataset['title'] === openTitle;
  });
  const allRow = el('div', 'row wrap d2-fold-all');
  allRow.appendChild(all);
  box.appendChild(allRow);
  if (!records.length && !sleeps.length && !ecgIn.length) {
    box.appendChild(el('p', 'muted', allRecords.length || nights.length || ecgs.length ? 'Nothing downloaded from the watch in this period.' : 'No data yet. Use “Download all data” to read sleep, activity, measurements, stress, workouts and ECG recordings from the watch.'));
    return;
  }
  const of = (k: D2Record['kind']): D2Record[] => records.filter((r) => r.kind === k).sort((a, b) => b.start - a.start);

  // sleep: each night and nap, as the watch recorded it
  if (sleeps.length) {
    box.appendChild(section('Sleep', 'Nights and naps from the watch. Open one from the Sleep tab for its full report.', table(
      ['Woke up', 'Kind', 'Asleep', 'Deep', 'Light', 'REM', 'Awake', 'Awakenings', 'Score'],
      sleeps.map((n) => {
        const f = figures(n);
        return [dateTime(f.wokeMs), isNap(n) ? 'Nap' : 'Night', hm(f.sleepMin), hm(f.deepMin), hm(f.lightMin), hm(f.remMin), hm(f.awakeMin), f.wakeups == null ? '--' : String(f.wakeups), n.summary.sleepScore == null ? '--' : String(n.summary.sleepScore)];
      }))));
  }

  // activity per day
  const days = of('activity');
  const totals = of('totals')[0];
  if (days.length || totals) {
    const rows = days.map((r) => {
      const ms: ActivityMinute[] = minutesOf(r);
      const vals = (f: (m: ActivityMinute) => number | null): number[] => ms.map(f).filter((v): v is number => v != null);
      const hr = vals((m) => m.hr), spo2 = vals((m) => m.spo2), rest = vals((m) => m.restingHr);
      const sum = (xs: number[]): number => xs.reduce((s, x) => s + x, 0);
      return [
        dayLabel(dateOf(r.id).getTime()), String(sum(vals((m) => m.steps))), (sum(vals((m) => m.distance)) / 1000).toFixed(2), String(Math.round(sum(vals((m) => m.kcal)) / 1000)),
        hr.length ? `${round(mean(hr))} (${Math.min(...hr)}–${Math.max(...hr)})` : '--', rest.length ? String(rest[rest.length - 1]) : '--',
        spo2.length ? `${round(mean(spo2))} (min ${Math.min(...spo2)})` : '--',
      ];
    });
    if (rows.length) box.appendChild(section('Activity', '', table(['Day', 'Steps', 'km', 'kcal', 'Heart rate (range)', 'Resting HR', 'SpO₂ % (min)'], rows, days, del)));
    const hasTotals = totals != null && [totals.data['steps'], totals.data['kcal'], totals.data['distance']].some((v) => num(v));
    if (totals && hasTotals) {
      box.appendChild(section('Daily totals', 'The watch’s count for the day so far, at the last download.', table(['Downloaded', 'Steps', 'km', 'kcal'], [[
        dateTime(totals.downloadedAt), String(num(totals.data['steps']) ?? 0), ((num(totals.data['distance']) ?? 0) / 1000).toFixed(2), String(num(totals.data['kcal']) ?? 0),
      ]], [totals], del)));
    }
  }

  // the watch's measurements, by kind
  const readings = of('reading');
  // only the kinds still kept (others, e.g. altitude, are not shown and are deleted at the next sync)
  const classes = [...new Set(readings.map((r) => num(r.data['cls']) ?? 0))].filter((c) => READING_CLASSES[c]);
  for (const cls of classes) {
    const spec = READING_CLASSES[cls];
    const rs = readings.filter((r) => r.data['cls'] === cls);
    const named = (f: string): boolean => spec?.fields[Number(f)] != null;
    const fields = [...new Set(rs.flatMap((r) => Object.keys((r.data['values'] as Record<string, number> | undefined) ?? {})))]
      .sort((a, b) => Number(named(b)) - Number(named(a)) || (named(a) ? Object.keys(spec!.fields).indexOf(a) - Object.keys(spec!.fields).indexOf(b) : a.localeCompare(b)));
    const withText = rs.some((r) => r.local?.['texts']);
    const rows = rs.map((r) => {
      const v = (r.data['values'] as Record<string, number> | undefined) ?? {};
      const texts = (r.local?.['texts'] as Record<string, string> | undefined) ?? {};
      const cells = [dateTime(r.start), ...fields.map((f) => (v[f] == null ? '--' : String(Math.round(v[f]! * 100) / 100)))];
      return withText ? [...cells, Object.values(texts).join(' · ')] : cells;
    });
    const head = ['Date and time', ...fields.map((f) => spec?.fields[Number(f)] ?? `Field ${f}`), ...(withText ? ['Text'] : [])];
    const note = fields.some((f) => !named(f)) ? 'Fields shown by number: their meaning isn’t known yet.' : '';
    box.appendChild(section(spec?.name ?? `Measurements (kind ${cls})`, note, table(head, rows, rs, del)));
  }

  // stress
  const stress = of('stress');
  if (stress.length) {
    box.appendChild(section('Stress', 'Score and level as the watch measured them.', table(['Date and time', 'Score', 'Level'], stress.map((r) => [
      `${dateTime(r.start)}–${clock(num(r.data['end']) ?? r.start)}`, String(num(r.data['score']) ?? '--'), String(num(r.data['level']) ?? '--'),
    ]), stress, del)));
  }

  // workouts
  const workouts = of('workout');
  if (workouts.length) {
    box.appendChild(section('Workouts', '', table(['Date and time', 'Type', 'Duration', 'km', 'kcal', 'Steps', 'Heart rate'], workouts.map((r) => {
      const t = (r.data['totals'] as Record<string, number> | undefined) ?? {};
      const samples = Array.isArray(r.data['samples']) ? (r.data['samples'] as Record<string, number>[]) : [];
      const hr = samples.map((x) => x['hr']).filter((v): v is number => typeof v === 'number' && v > 0 && v < 255);
      const end = num(r.data['end']) ?? r.start;
      const type = t['type'];
      return [
        dateTime(r.start), type != null ? WORKOUT_TYPES[type] ?? `Type ${type}` : '--', hm((end - r.start) / 60000),
        t['distance'] != null ? (t['distance'] / 1000).toFixed(2) : '--', t['kcal'] != null ? String(t['kcal']) : '--', t['steps'] != null ? String(t['steps']) : '--',
        hr.length ? `${round(mean(hr))} avg, ${Math.max(...hr)} max` : t['hrMax'] ? `${t['hrMax']} max` : '--',
      ];
    }), workouts, del)));
  }

  // the watch's 30-second ECG recordings, saved in ECG history
  if (ecgIn.length) {
    const t = table(['Date and time', 'Length', 'Heart rate (bpm)', 'Events'], ecgIn.map((e) => [
      dateTime(e.start), `${Math.round(e.durationS)} s`, e.hr == null ? '--' : String(Math.round(e.hr)), e.events == null ? '--' : String(e.events),
    ]));
    if (opts.openEcg) {
      const open = opts.openEcg;
      t.querySelectorAll('tbody tr').forEach((row, i) => {
        const e = ecgIn[i];
        if (!e) return;
        row.classList.add('d2-click');
        row.setAttribute('title', 'Open this ECG');
        row.addEventListener('click', () => open(e.id));
      });
    }
    box.appendChild(section('ECG recordings', `${ecgIn.length} recording${ecgIn.length === 1 ? '' : 's'}, saved in ECG history. Click one to open it.`, t));
  }
}
