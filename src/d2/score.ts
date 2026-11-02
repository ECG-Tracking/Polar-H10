// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — an estimate of how the watch builds its sleep score, to explain each night's score.
// Not the maker's formula (that stays in the watch): a fit of the watch's scores to three things it measures,
//   score ≈ base + perHour × duration + perEfficiency × sleep efficiency (%) + perDeep × deep sleep (%),
// where duration counts the hours slept up to 8, and each hour beyond 8 counts against.
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

import { figures, isNap } from './night';
import type { D2Night } from './store';

export const CEILING_H = 8;
export const MIN_NIGHTS_TO_FIT = 10;

export interface ScoreModel {
  base: number; perHour: number; perEfficiency: number; perDeep: number;
  /** Nights the model was fitted on; 0 = the starting estimate. */
  fittedOn: number;
  /** Typical difference from the watch's score, in points (null when not fitted). */
  rmse: number | null;
}

/** Fitted on 30 nights of a Watch D2 (Oct–Nov 2026): within 1.1 points on average, 3.2 at most. */
export const STARTING_MODEL: ScoreModel = { base: 26.16, perHour: 4.03, perEfficiency: 0.236, perDeep: 0.252, fittedOn: 0, rmse: null };

export interface ScoreInputs { hours: number; durationTerm: number; efficiency: number; deepPct: number }

export const durationTerm = (hours: number): number => Math.min(hours, CEILING_H) - Math.max(0, hours - CEILING_H);

/** The three measures for a night, or null for naps and nights without them. */
export function scoreInputs(n: D2Night): ScoreInputs | null {
  if (isNap(n)) return null;
  const f = figures(n);
  if (f.sleepMin <= 0) return null;
  const inBed = (f.inBedToMs - f.inBedFromMs) / 60000;
  const efficiency = n.summary.sleepEfficiency ?? (inBed > 0 ? Math.min(100, (100 * f.sleepMin) / inBed) : null);
  if (efficiency == null) return null;
  const hours = f.sleepMin / 60;
  return { hours, durationTerm: durationTerm(hours), efficiency, deepPct: (100 * f.deepMin) / f.sleepMin };
}

/** Least squares for a small system (normal equations, Gaussian elimination). */
function solve(rows: number[][], y: number[]): number[] | null {
  const k = rows[0]?.length ?? 0;
  const a = Array.from({ length: k }, (_, i) => Array.from({ length: k + 1 }, (_, j) =>
    j < k ? rows.reduce((s, r) => s + (r[i] ?? 0) * (r[j] ?? 0), 0) : rows.reduce((s, r, ri) => s + (r[i] ?? 0) * (y[ri] ?? 0), 0)));
  for (let i = 0; i < k; i++) {
    let p = i;
    for (let r = i + 1; r < k; r++) if (Math.abs(a[r]![i]!) > Math.abs(a[p]![i]!)) p = r;
    [a[i], a[p]] = [a[p]!, a[i]!];
    const piv = a[i]![i]!;
    if (Math.abs(piv) < 1e-9) return null;
    for (let r = 0; r < k; r++) {
      if (r === i) continue;
      const f = a[r]![i]! / piv;
      for (let j = i; j <= k; j++) a[r]![j]! -= f * a[i]![j]!;
    }
  }
  return a.map((r, i) => r[k]! / r[i]!);
}

/** Fits the model to the user's own scored nights; keeps the starting estimate until there are enough, or if a fit looks wrong. */
export function fitScoreModel(nights: readonly D2Night[]): ScoreModel {
  const data = nights.flatMap((n) => {
    const x = scoreInputs(n);
    return x && n.summary.sleepScore != null ? [{ x, y: n.summary.sleepScore }] : [];
  });
  if (data.length < MIN_NIGHTS_TO_FIT) return STARTING_MODEL;
  const b = solve(data.map((d) => [1, d.x.durationTerm, d.x.efficiency, d.x.deepPct]), data.map((d) => d.y));
  if (!b || b.slice(1).some((v) => !(v > 0))) return STARTING_MODEL; // every measure should help the score
  const [base, perHour, perEfficiency, perDeep] = b as [number, number, number, number];
  const err = data.map((d) => base + perHour * d.x.durationTerm + perEfficiency * d.x.efficiency + perDeep * d.x.deepPct - d.y);
  return { base, perHour, perEfficiency, perDeep, fittedOn: data.length, rmse: Math.sqrt(err.reduce((s, e) => s + e * e, 0) / err.length) };
}

export interface ScoreExplanation { base: number; duration: number; efficiency: number; deep: number; estimate: number; actual: number | null; inputs: ScoreInputs }

export function explainScore(n: D2Night, m: ScoreModel): ScoreExplanation | null {
  const x = scoreInputs(n);
  if (!x) return null;
  const duration = m.perHour * x.durationTerm, efficiency = m.perEfficiency * x.efficiency, deep = m.perDeep * x.deepPct;
  return { base: m.base, duration, efficiency, deep, estimate: m.base + duration + efficiency + deep, actual: n.summary.sleepScore, inputs: x };
}
