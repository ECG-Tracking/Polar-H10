import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReports, combine, compareMinutes, figuresOf, lineUp, pairUp, suggestions, whatChanged, type Minute, type SleepPair, type WatchSleep } from '../src/syncsleep';
import type { SleepSession } from '../src/store';
import type { Stage } from '../src/sleep';

const at = (h: number, m = 0, d = 4): number => new Date(2026, 10, d, h, m).getTime();
const strap = (id: string, start: number, hours: number): SleepSession => ({ id, user: 1, start, durationS: hours * 3600, source: 'polar', summary: null });
const wrist = (id: string, bedMs: number, hours: number, nap = false): WatchSleep => ({
  id, start: bedMs, stages: [], nap, demo: false, watch: 'Watch D2', bedMs, wokeMs: bedMs + hours * 3600000,
  sleepMin: 0, deepMin: 0, lightMin: 0, remMin: 0, awakeMin: 0, wakeups: 0, score: 70, avgHR: 60, avgHrv: 40, avgSpo2: 97, avgBreath: 14,
});

test('recordings of one sleep are paired, others are not', () => {
  const pairs = pairUp([strap('a', at(23, 0, 3), 8), strap('b', at(14), 1)], [wrist('x', at(23, 20, 3), 7), wrist('y', at(10), 1, true)]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]?.polar.id, 'a');
  assert.equal(pairs[0]?.watch.id, 'x');
  assert.equal(pairs[0]?.nap, false);
});

test('each recording is used once, with the one it overlaps most', () => {
  const pairs = pairUp([strap('short', at(1), 1), strap('long', at(23, 0, 3), 8)], [wrist('x', at(23, 0, 3), 8)]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]?.polar.id, 'long');
});

test('a day-time recording pairs as a nap', () => {
  assert.equal(pairUp([strap('a', at(13), 1)], [wrist('x', at(13), 1, true)])[0]?.nap, true);
});

test('both recordings are put on one clock, minute by minute', () => {
  const start = Math.floor(at(23, 0, 3) / 60000) * 60000;
  const stages: Stage[] = ['light', 'light', 'deep', 'deep', 'deep', 'rem'];
  const t = lineUp(stages, start, 30, { start: start + 60000, stages: [1, 3, 4] });
  assert.equal(t.startMs, start);
  assert.deepEqual(t.polar, ['light', 'deep', 'deep', null]);
  assert.deepEqual(t.watch, [null, 'light', 'deep', 'awake']);
});

test('combining: agreement stands, deep or REM beats light, deep against REM follows the strap', () => {
  const p: Minute[] = ['deep', 'light', 'deep', 'rem', null, 'light'];
  const w: Minute[] = ['deep', 'rem', 'light', 'deep', 'light', null];
  assert.deepEqual(combine(p, w), ['deep', 'rem', 'deep', 'rem', 'light', 'light']);
});

test('combining: a brief stir is sleep, a sustained one is awake, on either device', () => {
  const brief = combine(['light', 'awake', 'awake', 'light'], ['light', 'light', 'rem', 'light']);
  assert.deepEqual(brief, ['light', 'light', 'rem', 'light']);
  const long: Minute[] = Array(5).fill('awake');
  assert.deepEqual(combine(long, Array(5).fill('deep')), Array(5).fill('awake'));
  assert.deepEqual(combine(Array(5).fill('deep'), long), Array(5).fill('awake'));
});

test('combining: a nap minute from the watch takes the strap\'s stage', () => {
  assert.deepEqual(combine(['rem', null], ['asleep', 'asleep']), ['rem', 'light']);
});

test('combined figures: minutes, waking up, and no score for a nap', () => {
  const s = ['awake', 'light', 'light', 'awake', 'awake', 'deep', 'rem', 'awake'] as const;
  const f = figuresOf(s, at(23), false);
  assert.equal(f.sleepMin, 4);
  assert.equal(f.awakeMin, 4);
  assert.equal(f.awakenings, 1);
  assert.equal(f.onsetMs, at(23, 1));
  assert.equal(f.wakeMs, at(23, 7));
  assert.equal(f.efficiency, 50);
  assert.ok(f.score != null);
  assert.equal(figuresOf(s, at(13), true).score, null);
});

test('agreement: identical sleep is complete, and minutes without data are left out', () => {
  const p: Minute[] = ['deep', 'light', 'rem', 'awake', null];
  const a = compareMinutes(p, ['deep', 'light', 'rem', 'awake', 'deep']);
  assert.equal(a.sharedMin, 4);
  assert.equal(a.stagePct, 100);
  assert.equal(a.kappa, 1);
  assert.equal(a.sleepWakePct, 100);
  assert.equal(a.matrix.rem.rem, 1);
});

test('agreement: sleep against sleep differs in stage, not in being asleep', () => {
  const a = compareMinutes(['deep', 'deep', 'light', 'light'], ['light', 'light', 'deep', 'deep']);
  assert.equal(a.stagePct, 0);
  assert.equal(a.sleepWakePct, 100);
  assert.equal(a.matrix.deep.light, 2);
  assert.ok((a.kappa ?? 0) < 0);
});

test('suggestions follow what differs, and never say which device is right', () => {
  const agreement = compareMinutes(Array(100).fill('light'), Array(100).fill('rem'));
  const base = { agreement, polarMin: 100, watchMin: 100, coverage: 99, sleepDiffMin: 0, onsetDiffMin: 0, wakeDiffMin: 0, deepDiffPct: 0, remDiffPct: 0, hrDiff: 1, hrvDiff: 1, nap: false };
  const plain = suggestions(base);
  assert.ok(plain.some((s) => s.includes('REM on one device')));
  assert.ok(plain.at(-1)?.includes('sleep study'));
  assert.ok(suggestions({ ...base, hrDiff: 8 }).some((s) => s.includes('8 bpm')));
  assert.ok(suggestions({ ...base, coverage: 80 }).some((s) => s.includes('80 %')));
  assert.ok(suggestions({ ...base, watchMin: 400 }).some((s) => s.includes('share only')));
});

const pairOf = (polar: SleepSession, watch: WatchSleep): SleepPair => pairUp([polar], [watch])[0]!;
const polarFigures = { sleepMin: 60, deepMin: 20, lightMin: 30, remMin: 10, awakeMin: 0, deepPct: 33, remPct: 17, awakenings: 0, avgHR: 55, avgHrv: 40, breathingRate: 14, score: 80, coverage: 99, onsetMs: null, wakeMs: null };
const summary = { sleepMin: 60, score: 80, awakenings: 0, avgHR: 55, avgHrv: 40, breathingRate: 14 };

test('saved reports stay until a recording changes, and say which one did', () => {
  const s = { ...strap('a', at(23, 0, 3), 1), summary };
  const w = { ...wrist('x', at(23, 0, 3), 1), stages: Array<number>(60).fill(1) };
  const stages = Array<Stage>(120).fill('light');
  const p = pairOf(s, w);
  assert.equal(whatChanged(undefined, p), 'new');
  const saved = buildReports(p, polarFigures, stages, 30, 1000);
  assert.equal(saved.changed, 'new');
  assert.equal(saved.agreement.stagePct, 100);
  assert.equal(whatChanged(saved, pairOf(s, { ...w })), null);

  const watchChanged = { ...w, stages: Array<number>(60).fill(3) };
  assert.equal(whatChanged(saved, pairOf(s, watchChanged)), 'watch');
  const polarChanged = { ...s, summary: { ...summary, sleepMin: 59 } };
  assert.equal(whatChanged(saved, pairOf(polarChanged, w)), 'polar');
  assert.equal(whatChanged(saved, pairOf(polarChanged, watchChanged)), 'both');

  const next = buildReports(pairOf(s, watchChanged), polarFigures, stages, 30, 2000, saved);
  assert.equal(next.firstAt, 1000);
  assert.equal(next.generatedAt, 2000);
  assert.equal(next.changed, 'watch');
  assert.equal(next.agreement.stagePct, 0);
  assert.equal(next.past?.length, 1);
  assert.equal(next.past?.[0]?.generatedAt, 1000);
  assert.equal(next.past?.[0]?.agreement.stagePct, 100);

  const third = buildReports(pairOf(polarChanged, watchChanged), polarFigures, stages, 30, 3000, next);
  assert.deepEqual(third.past?.map((v) => v.generatedAt), [1000, 2000]);
  assert.ok(third.past?.every((v) => !('past' in v)));
});

import { forCloud, mergeSleepReports, parseSleepReportsRow, type SavedSleepReports } from '../src/syncsleep';

test('sleep reports in the cloud: versions from two devices are kept, and the watch’s name goes with them', () => {
  const v = (generatedAt: number, past?: SavedSleepReports[]) => ({ id: 'x', user: 1, generatedAt, watchCopy: { watch: 'My watch', stages: [1] }, ...(past ? { past } : {}) }) as unknown as SavedSleepReports;
  const merged = mergeSleepReports(v(3, [v(1)]), v(4, [v(2), v(1)]));
  assert.equal(merged.generatedAt, 4);
  assert.deepEqual(merged.past?.map((p) => p.generatedAt), [1, 2, 3]);
  const sent = forCloud({ ...merged, synced: true });
  assert.equal('synced' in sent, false);
  assert.deepEqual(sent.watchCopy, { watch: 'My watch', stages: [1] });
  assert.equal(parseSleepReportsRow({ id: 5 }), null);
  assert.equal(parseSleepReportsRow(v(1))?.id, 'x');
});
