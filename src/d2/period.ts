// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — the period to download: the last few days, or chosen start and end dates.
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

/** A day as YYYY-MM-DD in local time (the value of a date input). */
export const dateInput = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Seconds since 1970 for [start, end]: `choice` is a number of days back from now, or 'custom' with `from` and `to`
 * dates (from the start of `from` to the end of `to`, but not after now). Null with a reason when the dates don't work.
 */
export function downloadPeriod(choice: string, from: string, to: string, now = Date.now()): { start: number; end: number } | { error: string } {
  const nowS = Math.floor(now / 1000);
  if (choice !== 'custom') return { start: nowS - Number(choice) * 86400, end: nowS };
  const parse = (s: string): Date | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  };
  const a = parse(from), b = parse(to);
  if (!a || !b) return { error: 'Choose a start and an end date.' };
  if (a > b) return { error: 'The start date is after the end date.' };
  const start = Math.floor(a.getTime() / 1000);
  if (start > nowS) return { error: 'The start date is in the future.' };
  const end = Math.min(nowS, Math.floor(new Date(b.getFullYear(), b.getMonth(), b.getDate() + 1).getTime() / 1000) - 1);
  return { start, end };
}
