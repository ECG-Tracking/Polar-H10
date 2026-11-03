import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matches } from '../src/topbar';

test('Search: every word must appear in the page’s name or keywords, in any order and case', () => {
  assert.ok(matches('watch graph', 'D2 Link History Watch D2 watch nights week month graphs all data'));
  assert.ok(matches('', 'anything'));
  assert.ok(matches('ECG', 'ECG live'));
  assert.ok(!matches('blood sleep', 'Sleep monitor night record'));
});
