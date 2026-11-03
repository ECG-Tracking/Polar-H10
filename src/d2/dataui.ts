// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — the "All data" view: activity per day, the watch's measurements, stress and workouts.
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

import { clock, dayLabel, deleteButton, el, frontDeletes, hm } from './dom';
import { READING_CLASSES, WORKOUT_TYPES, type ActivityMinute } from './extra';
import { minutesOf } from './records';
import * as store from './store';
import type { D2Record } from './store';
import { dateOf } from './trends';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (v: number | null, digits = 0): string => (v == null ? '--' : v.toFixed(digits));
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const when = (ms: number): string => `${dayLabel(ms)} ${clock(ms)}`;

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

function section(title: string, note: string, content: HTMLElement | null): HTMLElement {
  const s = el('section', 'card d2-data');
  s.appendChild(el('h3', '', title));
  if (note) s.appendChild(el('p', 'note', note));
  if (content) s.appendChild(content);
  return s;
}

/** `changed` is called after a row was deleted (to show the data again and sync). */
export function renderAllData(box: HTMLElement, records: readonly D2Record[], changed: () => void = () => {}): void {
  const del = (r: D2Record): void => { void store.deleteRecord(r).then(changed); };
  box.replaceChildren();
  if (!records.length) {
    box.appendChild(el('p', 'muted', 'No other data yet. Use “Download all data” to read activity, measurements, stress and workouts from the watch.'));
    return;
  }
  const of = (k: D2Record['kind']): D2Record[] => records.filter((r) => r.kind === k).sort((a, b) => b.start - a.start);

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
    const hasTotals = totals != null && [totals.data['steps'], totals.data['kcal'], totals.data['distance']].some((v) => num(v));
    const note = totals && hasTotals ? `Today so far (at ${clock(totals.downloadedAt)}): ${num(totals.data['steps']) ?? 0} steps, ${((num(totals.data['distance']) ?? 0) / 1000).toFixed(2)} km, ${num(totals.data['kcal']) ?? 0} kcal.` : '';
    box.appendChild(section('Activity', note, rows.length ? table(['Day', 'Steps', 'km', 'kcal', 'Heart rate (range)', 'Resting HR', 'SpO₂ % (min)'], rows, days, del) : null));
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
      const cells = [when(r.start), ...fields.map((f) => (v[f] == null ? '--' : String(Math.round(v[f]! * 100) / 100)))];
      return withText ? [...cells, Object.values(texts).join(' · ')] : cells;
    });
    const head = ['Time', ...fields.map((f) => spec?.fields[Number(f)] ?? `Field ${f}`), ...(withText ? ['Text (this device only)'] : [])];
    const note = fields.some((f) => !named(f)) ? 'Fields shown by number: their meaning isn’t known yet.' : '';
    box.appendChild(section(spec?.name ?? `Measurements (kind ${cls})`, note, table(head, rows, rs, del)));
  }

  // stress
  const stress = of('stress');
  if (stress.length) {
    box.appendChild(section('Stress', 'Score and level as the watch measured them.', table(['Time', 'Score', 'Level'], stress.map((r) => [
      `${when(r.start)}–${clock(num(r.data['end']) ?? r.start)}`, String(num(r.data['score']) ?? '--'), String(num(r.data['level']) ?? '--'),
    ]), stress, del)));
  }

  // workouts
  const workouts = of('workout');
  if (workouts.length) {
    box.appendChild(section('Workouts', '', table(['Start', 'Type', 'Time', 'km', 'kcal', 'Steps', 'Heart rate'], workouts.map((r) => {
      const t = (r.data['totals'] as Record<string, number> | undefined) ?? {};
      const samples = Array.isArray(r.data['samples']) ? (r.data['samples'] as Record<string, number>[]) : [];
      const hr = samples.map((x) => x['hr']).filter((v): v is number => typeof v === 'number' && v > 0 && v < 255);
      const end = num(r.data['end']) ?? r.start;
      const type = t['type'];
      return [
        when(r.start), type != null ? WORKOUT_TYPES[type] ?? `Type ${type}` : '--', hm((end - r.start) / 60000),
        t['distance'] != null ? (t['distance'] / 1000).toFixed(2) : '--', t['kcal'] != null ? String(t['kcal']) : '--', t['steps'] != null ? String(t['steps']) : '--',
        hr.length ? `${round(mean(hr))} avg, ${Math.max(...hr)} max` : t['hrMax'] ? `${t['hrMax']} max` : '--',
      ];
    }), workouts, del)));
  }
}
