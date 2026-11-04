import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beatFigures, combineBeats, combineHr, compareRows, hrAgreement, hrvBands, makeVersion, mergeVersions, parseTrackingRow, planTracking, trackingSuggestions, whatChanged, type HrPoint, type SyncTrace, type TimedBeat } from '../src/synccompare';
import type { SyncBp, SyncTrackingEntry } from '../src/store';

/** Beats of `rr(i)` ms, timed from the start. */
function timed(count: number, rr: (i: number) => number, from = 0): TimedBeat[] {
  const out: TimedBeat[] = [];
  let t = from;
  for (let i = 0; i < count; i++) { const x = rr(i); t += x / 1000; out.push([t, x]); }
  return out;
}

test('figures: heart rate, HRV and the calculated ones from the beats', () => {
  const f = beatFigures(timed(10, (i) => (i % 2 ? 1020 : 980)))!;
  assert.equal(f.beats, 10);
  assert.ok(Math.abs(f.meanHr - 60) < 0.01);
  assert.equal(f.minRR, 980);
  assert.equal(f.maxRR, 1020);
  assert.ok(Math.abs(f.rmssd! - 40) < 1e-9);
  assert.ok(Math.abs(f.hrvScore! - 15 * Math.log(40)) < 1e-9);
  assert.equal(f.pnn50, 0);
  assert.equal(f.pnn20, 100);
  assert.ok(Math.abs(f.sd1! - 40 / Math.SQRT2) < 1e-9);
  assert.equal(f.lf, null, 'too short for LF and HF');
});

test('figures: average HRV is the RMSSD of each minute, and irregular beats are left out', () => {
  const steady = timed(70, () => 1000), lively = timed(70, (i) => (i % 2 ? 1030 : 970), 70);
  const f = beatFigures([...steady, ...lively])!;
  assert.ok(f.minHrv! < 1, `lowest ${f.minHrv}`);
  assert.ok(f.maxHrv! > 50, `highest ${f.maxHrv}`);
  assert.ok(f.avgHrv! > f.minHrv! && f.avgHrv! < f.maxHrv!);
  const g = beatFigures([[1, 800], [2, 810], [3, 400], [4, 800], [5, 790]])!;
  assert.equal(g.rawBeats, 5);
  assert.equal(g.beats, 4);
  assert.equal(g.leftOutPct, 20);
  assert.equal(beatFigures([[1, 800]]), null);
});

test('frequency bands: a rhythm at 0.25 Hz is high frequency, at 0.1 Hz low frequency', () => {
  const wave = (hz: number) => { const rr: number[] = []; let t = 0; while (t < 300) { const x = 1000 + 30 * Math.sin(2 * Math.PI * hz * t); rr.push(x); t += x / 1000; } return rr; };
  const high = hrvBands(wave(0.25))!, low = hrvBands(wave(0.1))!;
  assert.ok(high.hf > 10 * high.lf, `HF ${high.hf} LF ${high.lf}`);
  assert.ok(low.lf > 10 * low.hf, `LF ${low.lf} HF ${low.hf}`);
  assert.equal(hrvBands(wave(0.25).slice(0, 60)), null, 'under 2 minutes');
});

test('agreement: the average difference, its limits and how many stretches are close', () => {
  const polar: HrPoint[] = Array.from({ length: 60 }, (_, i) => [i, 70 + (i % 20)]);
  const watch: HrPoint[] = polar.map(([t, hr], i) => [t, hr + 2 + (i % 10 < 5 ? 1 : -1)]);
  const a = hrAgreement(polar, watch)!;
  assert.equal(a.bins, 12);
  assert.ok(Math.abs(a.bias - 2) < 0.5, `bias ${a.bias}`);
  assert.ok(a.low < a.bias && a.high > a.bias);
  assert.equal(a.within5Pct, 100);
  assert.ok(a.r! > 0.8);
  assert.equal(hrAgreement(polar, []), null);
});

test('combining: the strap stands, and the watch fills its gaps', () => {
  const strap: TimedBeat[] = [[1, 800], [2, 800], [3, 800], [8, 800], [9, 800]];
  const wrist: TimedBeat[] = [[1.1, 790], [4, 810], [5, 810], [6, 810], [8.5, 820]];
  const c = combineBeats(strap, wrist);
  assert.equal(c.fromWatch, 3, 'only the beats in the 3–8 s gap');
  assert.deepEqual(c.beats.map((b) => b[0]), [1, 2, 3, 4, 5, 6, 8, 9]);
  assert.deepEqual(combineBeats([], wrist).fromWatch, 5, 'without the strap, all the watch’s beats');
  assert.deepEqual(combineHr([[1, 60], [2, 62]], [[1, 64]]), [[1, 62], [2, 62]]);
});

test('comparison: an old tracking still shows its saved summary', () => {
  const rows = compareRows(null, null, { hr: 80, rmssd: 20, sdnn: 30, beats: 100 }, { hr: 82, rmssd: 25, sdnn: 31, beats: 90 });
  const hr = rows.find((r) => r.name.startsWith('Average heart rate'))!;
  assert.equal(hr.polar, 80);
  assert.equal(hr.watch, 82);
  assert.equal(rows.find((r) => r.name.startsWith('pNN50'))!.polar, null);
});

test('suggestions follow what differs', () => {
  const f = beatFigures(timed(400, (i) => 800 + (i % 2 ? 10 : -10)))!;
  const worse = { ...f, rmssd: f.rmssd! * 1.5, rawBeats: 100 };
  const a = { bins: 20, bias: 6, low: -2, high: 14, mae: 6, within5Pct: 40, r: 0.5 };
  const tips = trackingSuggestions(f, worse, a, 120, 30, false).join(' ');
  for (const w of ['6.0 bpm higher', 'moved apart', 'over 20 %', 'fewer beats', '5 minutes', 'blood pressure']) assert.ok(tips.includes(w), w);
  assert.deepEqual(trackingSuggestions(f, f, { ...a, bias: 0.5, low: -2, high: 2 }, 300, 0, true), ['The two devices agree well in this tracking.']);
});

const trace: SyncTrace = { id: 't1', polar: timed(200, () => 800), watch: timed(190, () => 805), polarHr: [[1, 75], [6, 75]], watchHr: [[1, 76], [6, 76]], watchPoor: 2 };
const bp = (systolic: number): SyncBp => ({ at: 1000, systolic, diastolic: 80, pulse: 70 });
const entry = (id: string, savedAt: number, synced: boolean): SyncTrackingEntry => ({ id, user: 1, start: 1, durationS: 60, polar: null, watch: null, bp: null, ecgId: null, savedAt, synced });

test('versions: a new one only when blood pressure or the watch’s data changes', () => {
  assert.equal(whatChanged(undefined, [], null), 'new');
  const v = makeVersion(trace, [bp(120)], null, null, 'new', 5);
  assert.equal(v.generatedAt, 5);
  assert.ok(v.p && v.w && v.c);
  assert.equal(v.agreement?.bias, 1);
  assert.equal(whatChanged(v, [bp(120)], null), null);
  assert.equal(whatChanged(v, [bp(125)], null), 'bp');
  const stored = { minutes: [], hrv: [{ at: 1, rmssd: 30 }], emotion: [], stress: [], workouts: [] };
  assert.equal(whatChanged(v, [bp(120)], stored), 'watch');
  assert.equal(whatChanged(v, [bp(125)], stored), 'both');
});

test('cloud: the newest copy wins, and a tracking gone from the cloud was deleted elsewhere', () => {
  const cloud = new Map([['same', 10], ['older-here', 20], ['newer-here', 10], ['only-cloud', 10], ['deleting', 10]]);
  const plan = planTracking([entry('same', 10, false), entry('older-here', 10, true), entry('newer-here', 20, true), entry('new', 5, false), entry('gone', 5, true)], cloud, new Set(['deleting']));
  assert.deepEqual(plan.markSynced, ['same']);
  assert.deepEqual(plan.upload.sort(), ['new', 'newer-here']);
  assert.deepEqual(plan.download.sort(), ['older-here', 'only-cloud']);
  assert.deepEqual(plan.removeHere, ['gone']);
});

test('cloud: versions from two devices are both kept, and bad rows are ignored', () => {
  const v = (at: number) => makeVersion(trace, [], null, null, 'new', at);
  assert.deepEqual(mergeVersions([v(1), v(3)], [v(2), v(3)]).map((x) => x.generatedAt), [1, 2, 3]);
  assert.equal(parseTrackingRow(null), null);
  assert.equal(parseTrackingRow({ entry: { id: 5 } }), null);
  assert.equal(parseTrackingRow({ entry: entry('t1', 1, false), trace: { id: 'other', polar: [], watch: [] } })?.trace, null);
  assert.equal(parseTrackingRow({ entry: entry('t1', 1, false), trace })?.trace?.id, 't1');
});
