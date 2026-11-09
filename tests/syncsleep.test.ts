import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMBINE_RULE, buildReports, combine, tidyBlocks, compareMinutes, figuresOf, lineUp, midWakes, pairUp, polarStamp, stagesStamp, suggestions, watchStamp, whatChanged, type Minute, type SleepPair, type WatchSleep } from '../src/syncsleep';
import type { SleepSession } from '../src/store';
import { SLEEP_METHOD, type Stage } from '../src/sleep';

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

test('combining: the strap’s stage stands, and the watch fills its gaps', () => {
  const p: Minute[] = ['deep', 'light', 'deep', 'rem', null, 'light', 'asleep'];
  const w: Minute[] = ['deep', 'rem', 'light', 'deep', 'light', null, 'rem'];
  assert.deepEqual(combine(p, w), ['deep', 'light', 'deep', 'rem', 'light', 'light', 'rem']);
});

test('combining: a brief stir is sleep, a sustained one is awake, on either device', () => {
  const brief = combine(['light', 'awake', 'awake', 'light'], ['light', 'light', 'rem', 'light']);
  assert.deepEqual(brief, ['light', 'light', 'rem', 'light']);
  const long: Minute[] = Array(5).fill('awake');
  assert.deepEqual(combine(long, Array(5).fill('deep')), Array(5).fill('awake'));
  assert.deepEqual(combine(Array(5).fill('deep'), long), Array(5).fill('awake'));
});

test('combining: a nap minute from the watch takes the strap\'s stage', () => {
  assert.deepEqual(combine(['rem', null], ['asleep', 'asleep']), ['rem', 'asleep'], 'with no stage from either, none is invented');
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

test('times woke up when combined is between the two devices', () => {
  assert.equal(midWakes(1, 5), 3);
  assert.equal(midWakes(2, 5), 4);
  assert.equal(midWakes(2, null), 2);
  assert.equal(figuresOf(['light', 'light'], 0, false, 3).awakenings, 3);
});

test('agreement in 5-minute blocks forgives a stage starting a minute apart', () => {
  const p: Minute[] = ['deep', 'deep', 'deep', 'deep', 'deep', 'rem', 'rem', 'rem', 'rem', 'rem'];
  const w: Minute[] = ['light', 'deep', 'deep', 'deep', 'deep', 'deep', 'rem', 'rem', 'rem', 'rem'];
  const a = compareMinutes(p, w);
  assert.equal(a.stagePct, 80);
  assert.equal(a.fiveMinPct, 100);
  assert.equal(compareMinutes([null, null, null, null, null], [null, null, null, null, null]).fiveMinPct, null);
});

test('reports made with the earlier stage rules are generated again, but only where the raw recording is', () => {
  const polar = { id: 'n', user: 1, start: 0, durationS: 60, source: 'polar', summary: null } as SleepSession;
  const watch = {} as WatchSleep;
  const p: SleepPair = { id: 'x', polar, watch, start: 0, nap: false };
  const saved = { method: 1, polarStamp: 'a', watchStamp: 'b' } as unknown as Parameters<typeof whatChanged>[0];
  assert.equal(whatChanged(saved, p), 'method');
  assert.notEqual(whatChanged(saved, { ...p, polar: { ...polar, cloudOnly: true } }), 'method');
});

test('sleep with an uncertain stage still counts as sleep, and no stage is invented', () => {
  const t = lineUp(['uncertain', 'uncertain', 'uncertain', 'uncertain'] as Stage[], 0, 30, { start: 0, stages: [5, 5] });
  assert.deepEqual(t.polar, ['asleep', 'asleep']);
  const a = compareMinutes(t.polar, t.watch);
  assert.equal(a.sharedMin, 2);
  assert.equal(a.sleepWakePct, 100);
  assert.equal(a.stagePct, null, 'nothing to compare stage by stage');
  assert.equal(a.kappa, null);
  const c = combine(t.polar, t.watch);
  assert.deepEqual(c, ['asleep', 'asleep']);
  const f = figuresOf(c, 0, true);
  assert.equal(f.sleepMin, 2);
  assert.equal(f.lightMin, 0);
});

test('changing night or nap, or a late start, makes new reports', () => {
  const polar = { id: 'n', user: 1, start: 0, durationS: 60, source: 'polar', summary: null } as SleepSession;
  const saved = { method: SLEEP_METHOD, combineRule: COMBINE_RULE, polarStamp: polarStamp(polar), watchStamp: watchStamp({} as WatchSleep) } as unknown as Parameters<typeof whatChanged>[0];
  const p: SleepPair = { id: 'x', polar, watch: {} as WatchSleep, start: 0, nap: false };
  assert.equal(whatChanged(saved, p), null);
  assert.equal(whatChanged(saved, { ...p, polar: { ...polar, context: 'nap' } }), 'labels');
  assert.equal(whatChanged(saved, { ...p, polar: { ...polar, onsetUnknown: true } }), 'labels');
});

test('a new report from another device with the same totals but different stages makes new reports', () => {
  const copy = (stages: string) => ({ id: 'n', user: 1, start: 0, durationS: 60, source: 'polar', summary: null, cloudOnly: true, report: { stages, method: 3 } }) as unknown as SleepSession;
  const stages = ['light', 'rem', 'deep', 'awake'] as Stage[];
  const saved = { method: 3, combineRule: COMBINE_RULE, stagesStamp: stagesStamp(stages), watchStamp: watchStamp({} as WatchSleep) } as unknown as Parameters<typeof whatChanged>[0];
  const p = (polar: SleepSession): SleepPair => ({ id: 'x', polar, watch: {} as WatchSleep, start: 0, nap: false });
  assert.equal(whatChanged(saved, p(copy('lrda'))), null, 'the same stages, whether worked out here or read from the cloud');
  assert.equal(whatChanged(saved, p(copy('lrla'))), 'polar');
  assert.equal(whatChanged({ ...saved!, combineRule: 1 }, p(copy('lrda'))), 'combine', 'reports combined the old way are made again');
});

test('reports made from an older cloud copy keep that copy’s rule version', () => {
  const polar = { id: 'n', user: 1, start: 0, durationS: 60, source: 'polar', summary: null, cloudOnly: true, report: { stages: 'l', method: 3 } } as unknown as SleepSession;
  const watch = { id: 'w', start: 0, stages: [1], nap: false, demo: false, watch: 'W', bedMs: 0, wokeMs: 60000 } as unknown as WatchSleep;
  const figures = { sleepMin: 1, deepPct: 0, remPct: 0 } as unknown as Parameters<typeof buildReports>[1];
  assert.equal(buildReports({ id: 'x', polar, watch, start: 0, nap: false }, figures, ['light'], 30, 1).method, 3);
  const { cloudOnly: _c, report: _r, ...own } = polar;
  assert.equal(buildReports({ id: 'x', polar: own, watch, start: 0, nap: false }, figures, ['light'], 30, 1).method, SLEEP_METHOD);
});

test('rule 4: where the strap has no stage, the watch’s awake minute stands and counts as waking up (night of 9–10 Nov 2026)', () => {
  const l = 'light' as const, s = 'asleep' as const, A = 'awake' as const;
  // 02:55–03:04 as recorded: strap light, then asleep with no stage, then light; the watch light with one awake minute
  const polar = [l, l, s, s, s, s, s, s, l, l, l, l];
  const watch = [l, l, l, l, l, l, l, A, l, l, l, l];
  const c = tidyBlocks(combine(polar, watch), (i) => watch[i] === 'awake');
  assert.equal(c[7], 'awake');
  assert.equal(c.filter((x) => x === 'awake').length, 1);
  assert.equal(figuresOf(c, 0, false, undefined, watch).awakenings, 1);
  // without the watch saying so, a one-minute awake isn't waking up, and the strap's stage still decides elsewhere
  assert.equal(figuresOf(c, 0, false).awakenings, 0);
  assert.equal(combine(['light'], ['awake'])[0], 'light');
});
