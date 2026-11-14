import test from 'node:test';
import assert from 'node:assert/strict';
import { periodRange, PERIODS, TREND_PARAMS, trendPoints, trendValues } from '../src/ecgtrend';
import type { Session } from '../src/store';
import type { SessionMetrics } from '../src/dsp';

const session = (id: string, start: number, trend?: Record<string, number>, source: Session['source'] = 'polar'): Session => ({
  id, start, durationS: 60, fs: 130, alias: '', source, userEvents: [], summary: trend ? { meanHR: 70, hrvScore: 40, eventCount: 0, trend } : null,
});

test('every period from the request is offered', () => {
  assert.deepEqual(PERIODS.map((p) => p[1]), ['3 hours', '6 hours', '9 hours', '12 hours', '1 day', '3 days', '7 days', '14 days', '1 month', '3 months', '6 months', '1 year', '2 years', '3 years', 'All', 'Custom']);
});

test('periods run back from now', () => {
  const now = new Date(2026, 10, 4, 12).getTime();
  assert.equal(periodRange('1d', now, 0)[0], now - 86400000);
  assert.equal(periodRange('14d', now, 0)[0], now - 14 * 86400000);
  assert.equal(new Date(periodRange('3m', now, 0)[0]).getMonth(), 7);
  assert.equal(new Date(periodRange('12m', now, 0)[0]).getFullYear(), 2025);
  assert.equal(new Date(periodRange('36m', now, 0)[0]).getFullYear(), 2023);
  assert.deepEqual(periodRange('all', now, 5), [5, now]);
});

test('a custom period covers both whole days, and an empty date means no limit', () => {
  const [a, b] = periodRange('custom', 9e12, 5, '2026-01-02', '2026-01-03');
  assert.equal(a, new Date(2026, 0, 2).getTime());
  assert.equal(b, new Date(2026, 0, 3, 23, 59, 59, 999).getTime());
  assert.deepEqual(periodRange('custom', 9e12, 5), [5, 9e12]);
});

test('points are in time order, within the period, and skip recordings without the figure', () => {
  const list = [session('b', 200, { rmssd: 20 }), session('a', 100, { rmssd: 10 }), session('c', 300, { sdnn: 5 }), session('d', 900, { rmssd: 90 }), session('e', 250)];
  assert.deepEqual(trendPoints(list, 'rmssd', 0, 500), [[100, 10], [200, 20]]);
});

test('figures: invalid ones are left out, S is a size, and length is in minutes', () => {
  const m = { meanHR: 80, rmssd: NaN, sAmp: -500, hr: [70, null, 90], durationS: 120, recovery: null, beatCount: 160 } as unknown as SessionMetrics;
  const v = trendValues(m);
  assert.equal(v['meanHR'], 80);
  assert.equal(v['highestHr'], 90);
  assert.equal(v['sAmp'], 500);
  assert.equal(v['durationS'], 2);
  assert.equal('rmssd' in v, false);
  assert.equal('hrr60' in v, false);
  for (const k of Object.keys(v)) assert.ok(TREND_PARAMS.some((p) => p[0] === k), k);
});

test('trending: the hour periods run back that many hours from now', async () => {
  const { periodRange } = await import('../src/ecgtrend');
  const now = Date.now();
  assert.deepEqual(periodRange('3h', now, 0), [now - 3 * 3600000, now]);
  assert.deepEqual(periodRange('12h', now, 0), [now - 12 * 3600000, now]);
});
