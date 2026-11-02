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

test('biodata: BMI and summary line use only the details given', async () => {
  const { DEFAULT_SETTINGS, bmi, biodataLine } = await import('../src/store');
  const base = { ...DEFAULT_SETTINGS, age: 55, sex: 'male' as const };
  assert.equal(bmi(base), null);
  assert.equal(biodataLine(base), '55 y · male');
  const full = { ...base, heightCm: 175, weightKg: 70 };
  assert.ok(Math.abs((bmi(full) ?? 0) - 22.86) < 0.01);
  assert.equal(biodataLine(full), '55 y · male · 175 cm · 70 kg');
  const { waistToHeight } = await import('../src/store');
  assert.equal(waistToHeight(full), null);
  const withWaist = { ...full, waistCm: 84 };
  assert.ok(Math.abs((waistToHeight(withWaist) ?? 0) - 0.48) < 0.001);
  assert.equal(biodataLine(withWaist), '55 y · male · 175 cm · 70 kg · waist 84 cm');
});
