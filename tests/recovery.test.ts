import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restoredCopy } from '../src/store';
import type { BinItem } from '../src/store';
import { binFromText, binToText } from '../src/backups';
import type { D2BinItem } from '../src/d2/store';
import { describe as describeD2 } from '../src/d2/recovery';

test('recovery: a restored recording is never marked as synced, so the next sync uploads it', () => {
  assert.deepEqual(restoredCopy({ id: 'a', start: 1, synced: true }, true), { id: 'a', start: 1 });
});

test('recovery: a restored summary copy stays a copy; with its signal it is a full recording again', () => {
  assert.deepEqual(restoredCopy({ id: 'a', synced: true, cloudOnly: true }, false), { id: 'a', cloudOnly: true });
  assert.deepEqual(restoredCopy({ id: 'a', synced: true, cloudOnly: true }, true), { id: 'a' });
});

test('recovery: names a deleted blood pressure reading and marks a delete from another device', () => {
  const item: D2BinItem = {
    id: 'record:reading:1:x', user: 1, deletedAt: 5, elsewhere: true,
    record: { key: 'reading:1:x', kind: 'reading', id: 'x', user: 1, start: 1000, data: { cls: 10002 }, source: 'd2', watch: 'Watch D2', downloadedAt: 1 },
  };
  const row = describeD2(item);
  assert.equal(row.what, 'Watch D2: Blood pressure');
  assert.equal(row.elsewhere, true);
  assert.ok(row.size > 0);
});

test('recovery: a deleted item and its raw signal survive the backup file', () => {
  const item = { id: 'sleep:n', kind: 'sleep', user: 2, deletedAt: 9, size: 1, session: { id: 'n', user: 2, start: 1, durationS: 60, source: 'demo', summary: null } } as BinItem;
  const signals = { rrT: Float64Array.of(1.5, 2.5), rr: Float32Array.of(800), acc: Int16Array.of(-3, 4), accFs: 25 };
  const back = binFromText(JSON.parse(JSON.stringify(binToText({ item, data: { id: item.id, signals } }))));
  assert.deepEqual(back.item, item);
  assert.deepEqual(back.data?.signals, signals);
  assert.equal(binFromText(binToText({ item })).data, undefined);
});
