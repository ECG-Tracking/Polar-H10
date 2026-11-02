import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Minimal in-memory localStorage for code that keeps small settings there. */
function fakeLocalStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => { m.delete(k); },
    setItem: (k, v) => { m.set(k, String(v)); },
  };
}

test('each account gets its own storage; the first one keeps the data from before accounts', async () => {
  Object.defineProperty(globalThis, 'localStorage', { value: fakeLocalStorage(), configurable: true });
  const store = await import('../src/store');
  store.useAccount('first-account');
  assert.equal(store.settingsKey(1), 'ecg-analysis-settings'); // unchanged: existing settings stay with it
  assert.equal(store.settingsKey(3), 'ecg-analysis-settings-u3');
  store.useAccount('second-account');
  assert.equal(store.settingsKey(1), 'second-account:ecg-analysis-settings');
  store.saveSettings(1, { ...store.DEFAULT_SETTINGS, alias: 'Second' });
  store.useAccount('first-account');
  assert.equal(store.loadSettings(1).alias, ''); // the second account's settings don't leak
  store.useAccount('second-account');
  assert.equal(store.loadSettings(1).alias, 'Second');
});

test('recordings deleted locally are remembered for removal from the cloud', async () => {
  Object.defineProperty(globalThis, 'localStorage', { value: fakeLocalStorage(), configurable: true });
  const store = await import('../src/store');
  store.useAccount('a');
  assert.deepEqual(store.pendingCloudDeletes(), []);
  store.setPendingCloudDeletes(['s1', 's2']);
  assert.deepEqual(store.pendingCloudDeletes(), ['s1', 's2']);
  store.useAccount('b');
  assert.deepEqual(store.pendingCloudDeletes(), []); // per account
});

test('rows from the cloud are checked before use', async () => {
  const { parseRow } = await import('../src/cloud');
  const good = { id: 's1', user_no: 2, started_at: 1_700_000_000_000, duration_s: 60, fs: 130, alias: 'A', source: 'polar', user_events: [{ t: 3, label: 'Marked' }, { bad: 1 }], signal_bytes: 15600 };
  const r = parseRow(good);
  assert.ok(r);
  assert.equal(r.user_no, 2);
  assert.deepEqual(r.user_events, [{ t: 3, label: 'Marked' }]);
  assert.equal(parseRow({ ...good, source: 'hacked' }), null);
  assert.equal(parseRow({ ...good, fs: 'x' }), null);
  assert.equal(parseRow(null), null);
});
