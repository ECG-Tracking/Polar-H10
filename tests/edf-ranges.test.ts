import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeEdf, readEdf } from '../src/edf';
import { referenceRanges, checkRange, fmtRange } from '../src/ranges';

test('EDF+ round trip keeps samples, start time, alias and events', async () => {
  const samples = Int16Array.from({ length: 130 * 20 }, (_, i) => Math.round(1000 * Math.sin(i / 7)));
  const start = new Date(2026, 10, 2, 8, 30, 5).getTime();
  const events = [{ t: 12.5, label: 'Marked' }, { t: 12.6, label: 'Premature beat' }];
  const blob = writeEdf({ samples, fs: 130, start, alias: 'test user', events });
  const back = readEdf(await blob.arrayBuffer());
  assert.equal(back.fs, 130);
  assert.equal(back.samples.length, samples.length);
  assert.ok(samples.every((v, i) => back.samples[i] === v), 'samples differ');
  assert.equal(back.start, start);
  assert.equal(back.alias, 'test_user');
  assert.deepEqual(back.events, events);
});

test('reference ranges follow age and sex', () => {
  const young = referenceRanges({ age: 25, sex: 'male' });
  const old = referenceRanges({ age: 65, sex: 'female' });
  assert.ok((young.rmssd.lo ?? 0) > (old.rmssd.lo ?? 0));
  assert.equal(young.qtc.hi, 450);
  assert.equal(old.qtc.hi, 460);
});

test('range checks and labels', () => {
  const r = referenceRanges({ age: 40, sex: 'male' });
  assert.equal(checkRange(r.qrs, 130), 'high');
  assert.equal(checkRange(r.qrs, 50), 'low');
  assert.equal(checkRange(r.qrs, 90), null);
  assert.equal(checkRange(r.qrs, NaN), null);
  assert.equal(fmtRange(r.qrs), '60–120');
  assert.equal(fmtRange(r.pnn50), '≤ 50');
  assert.equal(fmtRange(r.tPositive), '≥ 90');
});
