import test from 'node:test';
import assert from 'node:assert/strict';
import { ecgHoursIn, formatBytes, needRows, sizeOf, usageRows, type Measured } from '../src/storageuse';
import type { StoreName, StoreUse } from '../src/store';

const use = (bytes = 0, count = 0, seconds = 0): StoreUse => ({ count, bytes, seconds });
function measured(stores: Partial<Record<StoreName, StoreUse>> = {}, d2: Measured['d2'] = null): Measured {
  const empty = { sessions: use(), signals: use(), sleeps: use(), sleepSignals: use(), ecgSummaries: use(), bin: use(), binSignals: use(), sleepReports: use(), syncTraces: use() };
  return { stores: { ...empty, ...stores }, d2, settings: { count: 2, bytes: 100 }, app: { count: 5, bytes: 2000 } };
}

test('sizeOf counts typed arrays by their bytes and walks objects', () => {
  assert.equal(sizeOf(new Int16Array(100)), 200);
  assert.equal(sizeOf(new Float64Array(10).buffer), 80);
  assert.ok(sizeOf({ a: new Int16Array(100) }) > 200);
  assert.ok(sizeOf([1, 2, 3]) < sizeOf([1.5, 2.5, 3.5]));
  assert.equal(sizeOf(null), 1);
});

test('formatBytes picks a sensible unit', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(4800), '5 KB');
  assert.equal(formatBytes(9_360_000), '9.4 MB');
  assert.equal(formatBytes(1_500_000_000), '1.5 GB');
});

test('usageRows groups the stores, largest first', () => {
  const rows = usageRows(measured({ sessions: use(100, 2), signals: use(5000, 2), ecgSummaries: use(50, 1), bin: use(10, 1), binSignals: use(40, 1) }));
  assert.deepEqual(rows[0], { name: 'ECG recordings', count: 2, bytes: 5150 });
  assert.equal(rows.find((r) => r.name === 'Recovery centre')?.bytes, 50);
  assert.equal(rows.find((r) => r.name === 'Recovery centre')?.count, 1);
  assert.ok(!rows.some((r) => r.name.startsWith('Watch D2')), 'no watch rows when D2 Link is not loaded');
});

test('usageRows adds the watch data and its deleted items', () => {
  const z = { count: 0, bytes: 0 };
  const rows = usageRows(measured({ bin: use(10, 1) }, { nights: { count: 3, bytes: 300 }, activity: z, measurements: z, stress: z, workouts: z, bin: { count: 2, bytes: 90 } }));
  assert.equal(rows.find((r) => r.name === 'Watch D2 sleep')?.bytes, 300);
  assert.deepEqual(rows.find((r) => r.name === 'Recovery centre'), { name: 'Recovery centre', count: 3, bytes: 100 });
});

test('needRows gives the ECG from its rate even with no recordings', () => {
  const rows = needRows(measured());
  assert.equal(rows.find((r) => r.name === '1 hour of ECG')?.bytes, 130 * 2 * 3600);
  assert.equal(rows.find((r) => r.name === '8 hours of sleep, without ECG')?.bytes, null);
  assert.equal(rows.find((r) => r.name === 'One Watch D2 sleep')?.bytes, null);
});

test('needRows scales your sleep recordings to 8 hours and adds the ECG', () => {
  const rows = needRows(measured({ sleeps: use(1000, 1, 4 * 3600), sleepSignals: use(9000, 1) }));
  assert.equal(rows.find((r) => r.name === '8 hours of sleep, without ECG')?.bytes, 20000);
  assert.equal(rows.find((r) => r.name === '8 hours of sleep, with ECG')?.bytes, 20000 + 130 * 2 * 8 * 3600);
});

test('ecgHoursIn rounds down', () => {
  assert.equal(ecgHoursIn(130 * 2 * 3600 * 2.9), 2);
  assert.equal(ecgHoursIn(0), 0);
});
