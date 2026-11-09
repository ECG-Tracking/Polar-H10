import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERSION_KEEP_MS, dueVersions, isRetired, mergeRetirement, shown } from '../src/versions';
import { tidyBlocks, figuresOf, mergeSleepReports, type Combined, type SavedSleepReports } from '../src/syncsleep';

const DAY = 24 * 3600 * 1000;

test('a version replaced over a week ago is due; the newest and restored ones never are', () => {
  const now = 100 * DAY;
  const v = [{ generatedAt: now - 20 * DAY }, { generatedAt: now - 10 * DAY }, { generatedAt: now - 2 * DAY }];
  assert.deepEqual(dueVersions(v, undefined, now).map((x) => x.generatedAt), [now - 20 * DAY]);
  assert.deepEqual(dueVersions(v, { kept: [now - 20 * DAY] }, now), []);
  assert.equal(dueVersions([{ generatedAt: 0 }], undefined, now).length, 0);
  assert.ok(VERSION_KEEP_MS === 7 * DAY);
});

test('retired versions stay away after a merge, unless restored', () => {
  const r = mergeRetirement({ retired: [1] }, { kept: [2], retired: [2] });
  assert.deepEqual(r, { retired: [1, 2], kept: [2] });
  assert.ok(isRetired(1, r) && !isRetired(2, r));
  assert.deepEqual(shown([{ generatedAt: 1 }, { generatedAt: 2 }, { generatedAt: 3 }], r).map((x) => x.generatedAt), [2, 3]);
  const base = { user: 1, start: 0 } as unknown as SavedSleepReports;
  const here = { ...base, id: 'a', generatedAt: 3, past: [{ ...base, id: 'a', generatedAt: 2 }], retired: [1] } as SavedSleepReports;
  const there = { ...base, id: 'a', generatedAt: 2, past: [{ ...base, id: 'a', generatedAt: 1 }] } as SavedSleepReports;
  const m = mergeSleepReports(there, here);
  assert.equal(m.generatedAt, 3);
  assert.deepEqual(m.past?.map((v) => v.generatedAt), [2]);
  assert.deepEqual(m.retired, [1]);
});

test('a 1–2 minute break (missing minutes too) inside a block is part of it', () => {
  const L = 'light', D = 'deep', A = 'awake';
  const s: Combined[] = [L, L, L, D, D, null, D, D, D, A, A, D, D, L, D, D, D];
  assert.deepEqual(tidyBlocks(s), [L, L, L, D, D, D, D, D, D, D, D, D, D, D, D, D, D]);
  // a block of only one minute on a side isn't broken up
  assert.deepEqual(tidyBlocks([D, A, D, D]), [D, A, D, D]);
  // three minutes is a block of its own
  assert.deepEqual(tidyBlocks([D, D, A, A, A, D, D]), [D, D, A, A, A, D, D]);
});

test('being awake before falling asleep is not waking up', () => {
  const s: Combined[] = ['awake', 'awake', 'awake', 'light', 'light', 'deep', 'awake', 'awake', 'awake', 'light', 'awake', 'awake'];
  assert.equal(figuresOf(s, 0, false).awakenings, 1);
});
