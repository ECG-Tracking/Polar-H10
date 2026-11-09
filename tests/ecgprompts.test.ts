import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchPrompts, promptSummary, promptTimes } from '../src/ecgprompts';

test('ECG prompts: times start 30 s in, then every interval', () => {
  assert.deepEqual(promptTimes(0, 180_000, 420_000), [30_000, 210_000, 390_000]);
});

test('ECG prompts: a strip counts for the prompt it was recorded after, even if downloaded late; others are missed', () => {
  const p = matchPrompts([30_000, 210_000, 390_000], [400_000, 60_000, 90_000]);
  assert.deepEqual(p, [{ at: 30_000, strip: 60_000 }, { at: 210_000, strip: null }, { at: 390_000, strip: 400_000 }]);
  assert.equal(promptSummary(p), '2 of 3 ECGs taken');
  assert.equal(matchPrompts([30_000], [10_000])[0]?.strip, null, 'a strip before the first prompt is not counted');
});
