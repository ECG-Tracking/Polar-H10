// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — what a night (or nap) from the watch amounts to: the part Huawei Health shows, stage minutes, awakenings.
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

import type { D2Night } from './store';

export interface NightFigures {
  deepMin: number; lightMin: number; remMin: number; awakeMin: number; sleepMin: number;
  /** Huawei Health's "Bed time": when sleep started (the watch's fallAsleepTime). */
  bedMs: number;
  /** When you woke up (wakeupTime). */
  wokeMs: number;
  wakeups: number | null;
  /** Lying in bed, from the watch: bedTime to risingTime. */
  inBedFromMs: number; inBedToMs: number;
  /** The stages Huawei Health shows: from falling asleep to waking up. */
  shown: { start: number; stages: number[] };
}

/** Awake spells between sleep (not before falling asleep or after the last sleep), from the stage list. */
export function countWakeups(stages: readonly number[]): number {
  const asleep = (c: number | undefined): boolean => c === 1 || c === 2 || c === 3 || c === 5;
  const first = stages.findIndex(asleep);
  let last = -1;
  for (let i = stages.length - 1; i >= 0; i--) if (asleep(stages[i])) { last = i; break; }
  let n = 0;
  for (let i = first + 1; first >= 0 && i <= last; i++) if (stages[i] === 4 && stages[i - 1] !== 4) n++;
  return n;
}

export function figures(n: D2Night): NightFigures {
  const s = n.summary;
  const endMs = n.start + n.stages.length * 60000;
  const at = (sec: number | null, fallback: number): number => (sec != null ? Math.min(endMs, Math.max(n.start, sec * 1000)) : fallback);
  // Huawei Health shows the night from falling asleep to waking up; the watch records from lying down to getting up
  const bedMs = at(s.fallAsleepTime, n.start), wokeMs = at(s.wakeupTime, endMs);
  const from = Math.round((bedMs - n.start) / 60000), to = Math.max(from, Math.round((wokeMs - n.start) / 60000));
  const shown = { start: n.start + from * 60000, stages: n.stages.slice(from, to) };
  const count = (c: number): number => shown.stages.filter((x) => x === c).length;
  const deepMin = count(3), lightMin = count(1) + count(5), remMin = count(2), awakeMin = count(4);
  // the watch's own count when it sends one, otherwise counted from the stages (as Huawei Health shows it)
  const wakeups = s.wakeCount ?? (shown.stages.length ? countWakeups(shown.stages) : null);
  return {
    deepMin, lightMin, remMin, awakeMin, sleepMin: deepMin + lightMin + remMin, bedMs, wokeMs, wakeups,
    inBedFromMs: at(s.bedTime, n.start), inBedToMs: at(s.risingTime, endMs), shown,
  };
}

/** A daytime nap: the watch marks its minutes with stage 5 and gives it no score. */
export function isNap(n: D2Night): boolean {
  const asleep = n.stages.filter((c) => c !== 4 && c !== 0);
  return asleep.length > 0 && asleep.filter((c) => c === 5).length >= 0.8 * asleep.length;
}

/** The local calendar day (YYYY-MM-DD) a night belongs to: the day you woke up; for a nap, the day it ended. */
export function dayKey(n: D2Night): string {
  const d = new Date(figures(n).wokeMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
