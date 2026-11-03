import { test } from 'node:test';
import assert from 'node:assert/strict';
import { b64, isBackup, isComparison } from '../src/backups';

test('backups: signals survive the trip to text and back', () => {
  const i16 = Int16Array.of(-32768, -1, 0, 1, 32767), f32 = Float32Array.of(812.5, 0.25), f64 = Float64Array.of(1793690000.125, -2);
  assert.deepEqual([...new Int16Array(b64.fromB64(b64.toB64(i16)))], [...i16]);
  assert.deepEqual([...new Float32Array(b64.fromB64(b64.toB64(f32)))], [...f32]);
  assert.deepEqual([...new Float64Array(b64.fromB64(b64.toB64(f64)))], [...f64]);
  const big = new Int16Array(100000).map((_, k) => k % 3000); // more than one chunk
  assert.deepEqual(new Int16Array(b64.fromB64(b64.toB64(big))), big);
});

test('backups: only our own files are accepted', () => {
  assert.ok(isBackup({ kind: 'openbeat-account-backup', v: 1, ecg: [], sleep: [] }));
  assert.ok(!isBackup({ kind: 'openbeat-account-backup', v: 2, ecg: [], sleep: [] }));
  assert.ok(!isBackup({ nights: [] }));
  assert.ok(isComparison({ kind: 'openbeat-comparison', v: 1, cloud: {} }));
  assert.ok(!isComparison({ kind: 'openbeat-account-backup', v: 1 }));
});
