// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — nights per day and their averages, for the Week and Month views (naps left out).
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

import { dayKey, figures, isNap } from './night';
import type { D2Night } from './store';

export interface DayPoint {
  day: string; // YYYY-MM-DD
  score: number | null;
  sleepMin: number; deepMin: number; lightMin: number; remMin: number;
  deepPct: number | null;
  hr: number | null; hrv: number | null;
  bedMs: number; wokeMs: number;
}

const positive = (v: number | null): number | null => (v != null && v > 0 ? v : null);

/** One point per day with a night sleep (the longest, if a day has more than one). */
export function dayPoints(nights: readonly D2Night[]): Map<string, DayPoint> {
  const out = new Map<string, DayPoint>();
  for (const n of nights) {
    if (isNap(n)) continue;
    const f = figures(n);
    if (f.sleepMin <= 0) continue;
    const p: DayPoint = {
      day: dayKey(n), score: n.summary.sleepScore, sleepMin: f.sleepMin, deepMin: f.deepMin, lightMin: f.lightMin, remMin: f.remMin,
      deepPct: (100 * f.deepMin) / f.sleepMin, hr: positive(n.summary.avgHeartRate), hrv: positive(n.summary.avgHrv), bedMs: f.bedMs, wokeMs: f.wokeMs,
    };
    const had = out.get(p.day);
    if (!had || p.sleepMin > had.sleepMin) out.set(p.day, p);
  }
  return out;
}

export const keyOf = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const dateOf = (key: string): Date => { const [y, m, d] = key.split('-').map(Number); return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1); };
export const addDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** Monday of the week containing `d` (weeks run Monday to Sunday). */
export function weekStart(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return addDays(x, -((x.getDay() + 6) % 7));
}

export function daysFrom(start: Date, count: number): string[] {
  return Array.from({ length: count }, (_, i) => keyOf(addDays(start, i)));
}

export const monthDays = (year: number, month: number): string[] => daysFrom(new Date(year, month, 1), new Date(year, month + 1, 0).getDate());

/** The Monday–Sunday weeks that touch a month, each limited to the month's days. */
export function weeksOfMonth(year: number, month: number): string[][] {
  const days = monthDays(year, month);
  const weeks: string[][] = [];
  for (const k of days) {
    const monday = keyOf(weekStart(dateOf(k)));
    const last = weeks[weeks.length - 1];
    if (last && keyOf(weekStart(dateOf(last[0] ?? k))) === monday) last.push(k);
    else weeks.push([k]);
  }
  return weeks;
}

export interface Averages {
  nights: number;
  score: number | null; sleepMin: number | null; deepPct: number | null; hr: number | null; hrv: number | null;
  /** Average clock times, minutes after midnight. */
  bedClock: number | null; wokeClock: number | null;
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/** Average time of day, treating times around midnight correctly (23:50 and 00:10 average to 00:00). */
export function meanClock(ms: number[]): number | null {
  if (!ms.length) return null;
  const mins = ms.map((t) => { const d = new Date(t); return d.getHours() * 60 + d.getMinutes(); });
  const shifted = mins.map((m) => (m + 720) % 1440); // noon-centred, so a night around midnight doesn't wrap
  return ((mean(shifted) ?? 0) + 720) % 1440;
}

export function averages(points: readonly DayPoint[]): Averages {
  const vals = (f: (p: DayPoint) => number | null): number[] => points.map(f).filter((v): v is number => v != null && Number.isFinite(v));
  return {
    nights: points.length,
    score: mean(vals((p) => p.score)), sleepMin: mean(vals((p) => p.sleepMin)), deepPct: mean(vals((p) => p.deepPct)),
    hr: mean(vals((p) => p.hr)), hrv: mean(vals((p) => p.hrv)),
    bedClock: meanClock(points.map((p) => p.bedMs)), wokeClock: meanClock(points.map((p) => p.wokeMs)),
  };
}
