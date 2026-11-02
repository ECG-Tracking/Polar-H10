import { test } from 'node:test';
import assert from 'node:assert/strict';
import { USERS, isUserNumber, sessionUser, settingsKey } from '../src/store';

test('users are numbered 1 to 9', () => {
  assert.deepEqual([...USERS], [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(isUserNumber(1) && isUserNumber(9));
  assert.ok(!isUserNumber(0) && !isUserNumber(10) && !isUserNumber(2.5) && !isUserNumber('3'));
});

test('recordings made before users existed belong to User 1', () => {
  assert.equal(sessionUser({}), 1);
  assert.equal(sessionUser({ user: 4 }), 4);
});

test('User 1 keeps the original settings; others get their own', () => {
  assert.equal(settingsKey(1), 'ecg-analysis-settings');
  assert.equal(settingsKey(2), 'ecg-analysis-settings-u2');
  assert.equal(new Set(USERS.map(settingsKey)).size, 9);
});
