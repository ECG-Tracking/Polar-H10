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

test('settings sync: the most recently saved copy wins', async () => {
  const { planSettings } = await import('../src/cloud');
  const { DEFAULT_SETTINGS } = await import('../src/store');
  const phone = { ...DEFAULT_SETTINGS, heightCm: 175, weightKg: 70 };
  const mac = { ...DEFAULT_SETTINGS, age: 55 };
  // nothing in the cloud yet: upload; settings saved before sync count as oldest (1)
  assert.deepEqual(planSettings({ stored: phone, at: 0 }, null, 9), { upload: { settings: phone, at: 1 } });
  assert.deepEqual(planSettings({ stored: null, at: 0 }, null, 9), {});
  // newer here: upload; newer in the cloud: keep the cloud's; same: nothing
  assert.deepEqual(planSettings({ stored: phone, at: 200 }, { data: mac, at: 100 }, 9), { upload: { settings: phone, at: 200 } });
  assert.deepEqual(planSettings({ stored: phone, at: 100 }, { data: mac, at: 200 }, 9), { keep: { settings: mac, at: 200 } });
  assert.deepEqual(planSettings({ stored: phone, at: 100 }, { data: phone, at: 100 }, 9), {});
  // never saved here: take the cloud's
  assert.deepEqual(planSettings({ stored: null, at: 0 }, { data: mac, at: 1 }, 9), { keep: { settings: mac, at: 1 } });
});

test('settings sync: settings saved before sync fill in what the cloud copy left at the default', async () => {
  const { planSettings } = await import('../src/cloud');
  const { DEFAULT_SETTINGS } = await import('../src/store');
  const phone = { ...DEFAULT_SETTINGS, heightCm: 175, weightKg: 70 };
  const mac = { ...DEFAULT_SETTINGS, age: 55 };
  const both = { ...DEFAULT_SETTINGS, age: 55, heightCm: 175, weightKg: 70 };
  assert.deepEqual(planSettings({ stored: phone, at: 0 }, { data: mac, at: 1 }, 9), { keep: { settings: both, at: 9 }, upload: { settings: both, at: 9 } });
  // a damaged cloud copy falls back to defaults field by field
  assert.deepEqual(planSettings({ stored: null, at: 0 }, { data: { age: 'x', heightCm: 180 }, at: 5 }, 9), { keep: { settings: { ...DEFAULT_SETTINGS, heightCm: 180 }, at: 5 } });
});

test('recording length: minutes, until stopped, or chosen minutes', async () => {
  const { durationSeconds } = await import('../src/ui');
  assert.equal(durationSeconds('60', ''), 60);
  assert.equal(durationSeconds('unlimited', '5'), null);
  assert.equal(durationSeconds('custom', '7'), 420);
  assert.equal(durationSeconds('custom', '0'), 600, 'an impossible number falls back to 10 minutes');
  assert.equal(durationSeconds('custom', '241'), 600);
});
