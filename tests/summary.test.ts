import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EcgSimulator } from '../src/sim';
import { simulateNight } from '../src/sleepsim';
import { analyzeSleep } from '../src/sleep';
import { DEFAULT_SETTINGS, type Session } from '../src/store';
import {
  int16ToBase64, base64ToInt16, buildEcgSummary, parseEcgSummary, pickEventStrips, buildSleepReport, parseSleepReport, toAnalysis,
  STRIP_S, MAX_EVENT_STRIPS, type SummaryEvent,
} from '../src/summary';

const FS = 130;

function recording(minutes: number, seed = 5): { session: Session; samples: Int16Array } {
  const raw = new EcgSimulator({ scenario: 'rest', seed }).next(FS * 60 * minutes);
  const session: Session = {
    id: 's1', user: 1, start: Date.UTC(2026, 10, 2, 8), durationS: minutes * 60, fs: FS, alias: '', source: 'demo',
    userEvents: [{ t: 95, label: 'Marked' }], summary: null,
  };
  return { session, samples: Int16Array.from(raw) };
}

test('16-bit samples survive base64 exactly', () => {
  const a = Int16Array.from([0, 1, -1, 32767, -32768, 1234, -4321]);
  assert.deepEqual(Array.from(base64ToInt16(int16ToBase64(a))), Array.from(a));
});

test('ECG summary: results, trend, average beat, first 30 s and event strips; small and readable back', () => {
  const { session, samples } = recording(60);
  const summary = buildEcgSummary(session, samples, DEFAULT_SETTINGS);
  const json = JSON.stringify(summary);
  const kb = json.length / 1024;
  assert.ok(kb < 260, `summary of a 1 h recording is ${kb.toFixed(0)} KB`); // at most ~250 KB with all 50 event strips, vs ~914 KB for the full strip
  assert.equal(base64ToInt16(summary.strip.data).length, STRIP_S * FS);
  assert.ok(summary.eventStrips.length > 0 && summary.eventStrips.length <= MAX_EVENT_STRIPS);
  assert.ok(summary.eventStrips.some((s) => s.t === 95), 'the marked event has a strip');
  for (const s of summary.eventStrips) assert.equal(base64ToInt16(s.data).length, 10 * FS);
  assert.equal(summary.metrics.hr.length, 3600);
  assert.ok(summary.template && summary.template.length > 50);

  const back = parseEcgSummary(JSON.parse(json));
  assert.ok(back);
  assert.ok(Math.abs(back.metrics.meanHR - summary.metrics.meanHR) < 1e-9);
  assert.equal(back.metrics.qtc, summary.metrics.qtc);
  assert.equal(back.events.length, summary.events.length);
  // values that were NaN (shown as "--") stay NaN after the JSON trip instead of becoming 0
  const nanKeys = Object.entries(summary.metrics).filter(([, v]) => typeof v === 'number' && Number.isNaN(v)).map(([k]) => k);
  for (const k of nanKeys) assert.ok(Number.isNaN((back.metrics as unknown as Record<string, number>)[k]), `${k} restored as NaN`);
});

test('a damaged or foreign summary is rejected rather than shown wrongly', () => {
  assert.equal(parseEcgSummary(null), null);
  assert.equal(parseEcgSummary({ v: 2 }), null);
  assert.equal(parseEcgSummary({ v: 1, fs: 130, metrics: {} }), null);
});

test('event strips: marked events first, the rest spread over the recording, at most 50', () => {
  const events: SummaryEvent[] = [
    ...Array.from({ length: 200 }, (_, i): SummaryEvent => ({ t: i * 10, type: 'premature', label: 'Premature beat' })),
    { t: 1234, type: 'user', label: 'Marked' },
  ];
  const picked = pickEventStrips(events);
  assert.equal(picked.length, MAX_EVENT_STRIPS);
  assert.ok(picked.some((e) => e.type === 'user'));
  const times = picked.filter((e) => e.type !== 'user').map((e) => e.t);
  assert.ok((times[0] ?? 99) < 100 && (times[times.length - 1] ?? 0) > 1800, 'spread from start to end');
});

test('sleep report: all report outputs in a few tens of KB, identical when read back', () => {
  const { data } = simulateNight(9);
  const report = buildSleepReport(data);
  const json = JSON.stringify(report);
  assert.ok(json.length / 1024 < 40, `night report is ${(json.length / 1024).toFixed(0)} KB`); // vs ~4.7 MB raw
  const back = parseSleepReport(JSON.parse(json));
  assert.ok(back);
  const a = analyzeSleep(data), b = toAnalysis(back);
  assert.deepEqual(b.stages, a.stages);
  assert.equal(b.metrics.score, a.metrics.score);
  assert.equal(b.metrics.awakenings, a.metrics.awakenings);
  assert.equal(b.hr.length, a.hr.length);
});

test('a sleep & ECG night keeps its link both ways through the cloud', () => {
  const { session, samples } = recording(12);
  const ecg = buildEcgSummary({ ...session, sleepId: 'n1' }, samples, DEFAULT_SETTINGS);
  assert.equal(parseEcgSummary(JSON.parse(JSON.stringify(ecg)))?.sleepId, 'n1');
  const night = buildSleepReport(simulateNight(4).data, 's1');
  assert.equal(parseSleepReport(JSON.parse(JSON.stringify(night)))?.ecgId, 's1');
  // nights and recordings without a link stay without one
  assert.equal(parseSleepReport(JSON.parse(JSON.stringify(buildSleepReport(simulateNight(4).data))))?.ecgId, undefined);
});

import { withoutShape } from '../src/summary';

test('a summary carries the version ignoring Irregular Shape, kept apart until asked for', () => {
  const { session, samples } = recording(3);
  const odd = Int16Array.from(samples);
  for (let k = 0; k < 6; k++) { const at = (20 + k * 25) * FS; for (let i = at - 3; i <= at + 3; i++) odd[i] = -(odd[i] ?? 0); }
  const back = parseEcgSummary(JSON.parse(JSON.stringify(buildEcgSummary(session, odd, DEFAULT_SETTINGS))))!;
  assert.ok(back.noShape, 'the version is in the cloud copy');
  assert.ok(!back.noShape.events.some((e) => e.type === 'shape'));
  assert.equal(back.noShape.events.filter((e) => e.type === 'user').length, 1, 'marked events stay');
  const shown = withoutShape(back)!;
  assert.deepEqual(shown.metrics.hr, back.metrics.hr, 'the heart-rate trend is shared');
  assert.ok(shown.eventStrips.every((s) => shown.events.some((e) => e.t === s.t)), 'only strips of its own events');
  assert.equal(withoutShape({ ...back, noShape: undefined } as unknown as typeof back), null, 'an older copy has none');
  assert.equal(buildEcgSummary({ ...session, ignoreShape: true }, odd, DEFAULT_SETTINGS).noShape, undefined, 'a row saved ignoring it needs none');
});
