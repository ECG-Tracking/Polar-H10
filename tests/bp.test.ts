import { test } from 'node:test';
import assert from 'node:assert/strict';
import { figure, matchReading, mergeReadings, readingsBetween } from '../src/bp';
import type { Session, SyncBp, SyncTrackingEntry } from '../src/store';

const H = 3600000;
const bp = (at: number, systolic = 120, diastolic = 80): SyncBp => ({ at, systolic, diastolic, pulse: 70 });
const session = (id: string, start: number, durationS: number, source: Session['source'], trend: Record<string, number>, extra: Partial<Session> = {}): Session => ({
  id, user: 1, start, durationS, fs: 130, alias: '', source, userEvents: [], summary: { meanHR: 60, hrvScore: 40, eventCount: 0, trend }, ...extra,
});
const tracking = (start: number, durationS: number, ecgId: string, bps: SyncBp[] = []): SyncTrackingEntry => ({
  id: `t${start}`, user: 1, start, durationS, polar: null, watch: null, bp: bps[0] ?? null, bps, ecgId,
});

test('BP: readings from D2 Link and the trackings are merged once each', () => {
  const t0 = 1_000_000_000_000;
  const merged = mergeReadings([bp(t0), bp(t0 + 2 * H, 130, 85)], [tracking(t0 - 600000, 300, 's1', [bp(t0 + 20000)])]);
  assert.deepEqual(merged.map((r) => r.at), [t0, t0 + 2 * H], 'the same reading kept with a tracking is not added again');
  assert.equal(readingsBetween(merged, t0 + H, t0 + 3 * H).length, 1);
});

test('BP: a reading takes its tracking’s ECGs, or else the nearest strap ECG and the watch strips within an hour', () => {
  const t0 = 1_000_000_000_000;
  const polarT = session('s1', t0, 300, 'polar', { qtc: 400, eventCount: 2 });
  const strips = [session('w1', t0 + 60000, 30, 'watch', { qtc: 430, eventCount: 1 }), session('w2', t0 + 120000, 30, 'watch', { qtc: 450, eventCount: 3 })];
  const far = session('s2', t0 + 5 * H, 300, 'polar', { qtc: 380 });
  const sleepEcg = session('s3', t0 + 9 * H, 8 * 3600, 'polar', { qtc: 390 }, { sleepId: 'n1' });
  const all = [polarT, ...strips, far, sleepEcg];
  const tr = tracking(t0, 300, 's1');

  const withTracking = matchReading(bp(t0 + 30 * 60000), all, [tr]);
  assert.equal(withTracking.tracking?.id, tr.id);
  assert.equal(withTracking.polar?.id, 's1');
  assert.deepEqual(withTracking.watch.map((s) => s.id), ['w1', 'w2']);
  assert.equal(figure(withTracking, 'polar', 'qtc'), 400);
  assert.equal(figure(withTracking, 'watch', 'qtc'), 440, 'the median of the strips');
  assert.equal(figure(withTracking, 'watch', 'eventCount'), 4, 'events added up');
  assert.equal(figure(withTracking, 'polar', 'tAmp'), null);

  const alone = matchReading(bp(t0 + 5 * H + 20 * 60000), all, [tr]);
  assert.equal(alone.tracking, null);
  assert.equal(alone.polar?.id, 's2');
  assert.equal(alone.watch.length, 0);

  const none = matchReading(bp(t0 + 9 * H + 30 * 60000), all, [tr]);
  assert.equal(none.polar, null, 'an ECG recorded with a sleep is not matched');
});

test('BP: a tracking’s saved Combined ECG results are used in place of each recording’s own', async () => {
  const t0 = 1_000_000_000_000;
  const polarT = session('s1', t0, 300, 'polar', { qtc: 400, eventCount: 34 });
  const strip = session('w1', t0 + 60000, 30, 'watch', { qtc: 470, eventCount: 5 });
  const tr = tracking(t0, 300, 's1');
  const m = matchReading(bp(t0 + 600000), [polarT, strip], [tr]);
  const combined = { method: 1, stamp: 's1|w1', at: t0, polar: { qtc: 380 }, watch: { qtc: 445 }, events: { polar: 11, watch: 11, polarPct: 3.1, watchPct: 3.2 } };
  const withSaved = { ...m, combined };
  assert.equal(figure(withSaved, 'polar', 'qtc'), 380);
  assert.equal(figure(withSaved, 'watch', 'qtc'), 445);
  assert.equal(figure(withSaved, 'polar', 'eventCount'), 11, 'only events both saw');
  assert.equal(figure(withSaved, 'watch', 'eventPct'), 3.2);
  assert.equal(figure(m, 'polar', 'eventCount'), 34, 'nothing saved yet: the recording’s own');
  const { mergeTrace } = await import('../src/synccompare');
  const base = { id: tr.id, polar: [], watch: [], polarHr: [], watchHr: [], watchPoor: 0 };
  const merged = mergeTrace({ ...base, combined: { ...combined, at: t0 + 5 } }, { ...base, combined: { ...combined, at: t0 + 1, polar: { qtc: 1 } } });
  assert.equal(merged.combined?.polar?.['qtc'], 380, 'the newer saved results win at a sync');
  assert.ok(mergeTrace({ ...base, combined }, base).combined, 'kept when the other device has none');
});

import { addManual, checkManual, deleteManual, manualReadings, mergeManual, parseManual } from '../src/manualbp';

test('Manual BP: added, checked, marked apart from D2 BP, deleted, and merged with another device’s copy', () => {
  const t = new Date(2026, 10, 24, 9, 30).getTime();
  assert.equal(checkManual(120, 80, t, t), null);
  assert.match(checkManual(80, 120, t, t) ?? '', /lower than SBP/);
  assert.match(checkManual(120.5, 80, t, t) ?? '', /whole number/);
  assert.match(checkManual(120, 80, t + 3600000, t) ?? '', /future/);
  const list = addManual([], 1, t, 120, 80, t);
  const rs = manualReadings(list, 1);
  assert.deepEqual(rs.map((r) => [r.at, r.systolic, r.diastolic, r.source]), [[t, 120, 80, 'manual']]);
  assert.equal(manualReadings(list, 2).length, 0, 'each user has their own');
  const gone = deleteManual(list, list[0]!.id, t + 1000);
  assert.equal(manualReadings(gone, 1).length, 0);
  // the deletion is newer, so it wins over the other device's older copy, and that copy over this one's older one
  assert.equal(manualReadings(mergeManual(list, gone), 1).length, 0);
  assert.equal(manualReadings(mergeManual(gone, list), 1).length, 0);
  assert.equal(parseManual({ ...list[0], systolic: 'x' }), null);
  assert.deepEqual(parseManual(JSON.parse(JSON.stringify(gone[0]))), gone[0]);
});
