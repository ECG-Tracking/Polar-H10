// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link: the other watch data (activity, totals, data dictionary, stress, workouts) against the fake watch,
// and how it is stored and synced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D2Link } from '../src/d2/link';
import {
  classBytes, downloadActivity, downloadReadings, downloadTotals, downloadWorkouts, parseActivityMinute, parseStressFile, parseWorkoutSamples,
} from '../src/d2/extra';
import { activityRecords, mergeMinutes, readingRecords, workoutRecords } from '../src/d2/records';
import { parseCloudDownload, parseCloudRecord, planDownloads } from '../src/d2/cloud';
import { nightContent, nilText, onlyChanged, recordContent } from '../src/d2/records';
import { emptySummary } from '../src/d2/sleepfile';
import { nothingCameBack } from '../src/d2/store';
import { Tlv } from '../src/d2/tlv';
import { FakeWatch } from './d2fake';

async function connected(w: FakeWatch): Promise<{ link: D2Link; log: string[] }> {
  const log: string[] = [];
  const link = new D2Link(w.transport, (l) => log.push(l));
  await link.connect(null);
  return { link, log };
}

// steps 0x0123, kcal 7, distance 300 m, heart rate 72; second bitmap: SpO₂ 97, resting HR 58
const MINUTE = Uint8Array.of(0x80 | 0x02 | 0x04 | 0x08 | 0x40, 0x03, 0x01, 0x23, 0x00, 0x07, 0x01, 0x2c, 72, 97, 58);

test('D2 activity: a minute’s fields are read by their feature bits', () => {
  assert.deepEqual(parseActivityMinute(60, MINUTE), { t: 60, steps: 0x123, kcal: 7, distance: 300, hr: 72, restingHr: 58, spo2: 97 });
  // unknown features are kept by bit; a cut-off minute is dropped
  assert.deepEqual(parseActivityMinute(0, Uint8Array.of(0x01, 0x00, 0x05))?.other, { '1.1': 5 });
  assert.equal(parseActivityMinute(0, MINUTE.slice(0, 4)), null);
});

const day = Math.floor(new Date(2026, 10, 2, 8, 0).getTime() / 1000);

test('D2 link: activity, totals and the data dictionary are read from the watch', async () => {
  const w = new FakeWatch({
    activity: [{ start: day, minutes: [[0, MINUTE], [1, MINUTE]] }, { start: day + 3600, minutes: [[0, MINUTE]] }, { start: 1596204660, minutes: [[0, MINUTE]] }],
    totals: { steps: 8000, kcal: 250, distance: 6100 },
    readings: { 10002: [{ start: day * 1000, values: { 10002001: 128, 10002002: 82 } }], 500044: [{ start: day * 1000 + 5000, values: { 500044831: 41 } }] },
  });
  const { link, log } = await connected(w);
  const minutes = await downloadActivity(link, day - 86400, day + 86400);
  assert.deepEqual(minutes.map((m) => m.t), [day, day + 60, day + 3600], 'a minute from 2020 (before the clock was set) is left out');
  assert.deepEqual(await downloadTotals(link, (l) => log.push(l)), { steps: 8000, kcal: 250, distance: 6100 });
  const readings = await downloadReadings(link, 0, (l) => log.push(l));
  const bp = readings.find((r) => r.cls === 10002);
  assert.deepEqual(bp?.values, { 10002001: 128, 10002002: 82 });
  assert.equal(readings.find((r) => r.cls === 500044)?.values['500044831'], 41);
  assert.ok(w.acks.length >= 2, 'each data message from the watch is acknowledged');
  assert.ok(log.some((l) => /Blood pressure: 1 record/.test(l)));
});

test('D2 link: an answer without totals gives none, and its layout is logged', async () => {
  const w = new FakeWatch({ totals: { steps: 0, kcal: 0, distance: 0 } });
  const { link, log } = await connected(w);
  assert.equal(await downloadTotals(link, (l) => log.push(l)), null);
  assert.ok(log.some((l) => /no totals \(fields: 81\{83\{5:4 6:2 7:4\}\}\)/.test(l)));
});

test('D2 link: without the data sync service, measurements are skipped with a note', async () => {
  const w = new FakeWatch({ noDataSync: true });
  const { link, log } = await connected(w);
  assert.deepEqual(await downloadReadings(link, 0, (l) => log.push(l)), []);
  assert.ok(log.some((l) => /didn’t answer/.test(l)));
});

test('D2 data dictionary: classes are sent in as few bytes as needed', () => {
  assert.deepEqual([...classBytes(10002)], [0x27, 0x12]);
  assert.deepEqual([...classBytes(500044)], [0x07, 0xa1, 0x4c]);
  assert.deepEqual([...classBytes(5)], [5]);
});

function stressFile(): Uint8Array {
  const b = new Uint8Array(48 + 66);
  const dv = new DataView(b.buffer);
  dv.setUint16(10, 3);
  dv.setUint32(48, day); dv.setUint32(52, day + 120); dv.setInt32(56, 2); dv.setInt8(60, 35); dv.setInt8(61, 1);
  for (let i = 0; i < 12; i++) dv.setFloat32(66 + 4 * i, i / 2);
  return b;
}

test('D2 files: stress downloads like the sleep file and is read back', async () => {
  const w = new FakeWatch({ files: { 0x10: stressFile() } });
  const { link } = await connected(w);
  const stress = parseStressFile(await link.downloadFile({ name: 'rrisqi_data.bin', type: 0x10, start: 0, end: day + 999, what: 'stress' }));
  assert.equal(stress.length, 1);
  assert.deepEqual({ start: stress[0]!.start, end: stress[0]!.end, score: stress[0]!.score, level: stress[0]!.level }, { start: day * 1000, end: (day + 120) * 1000, score: 35, level: 1 });
  assert.equal(stress[0]!.features[3], 1.5);
  // nothing recorded: an empty download, not an error
  assert.equal((await link.downloadFile({ name: 'x', type: 0x10 + 1, start: 0, end: 1, what: 'test' })).length, 0);
});

// one sample every 5 s: heart rate (1 byte) and speed (2 bytes)
function workoutBlock(): { header: Uint8Array; data: Uint8Array } {
  const header = new Uint8Array(14), hv = new DataView(header.buffer);
  hv.setUint16(0, 7); hv.setUint32(4, day); hv.setUint8(8, 5); hv.setUint16(9, 2); hv.setUint8(11, 3); hv.setUint16(12, 0b11);
  return { header, data: Uint8Array.of(120, 0, 30, 131, 0, 32) };
}

test('D2 workouts: list, summary and samples; the summary’s text stays out of the synced numbers', async () => {
  const w = new FakeWatch({ workouts: [{ number: 7, start: day, end: day + 1800, kcal: 210, type: 1, ...workoutBlock() }] });
  const { link, log } = await connected(w);
  const ws = await downloadWorkouts(link, 0, day + 9999, (l) => log.push(l));
  assert.equal(ws.length, 1);
  assert.deepEqual({ start: ws[0]!.start, kcal: ws[0]!.totals['kcal'], type: ws[0]!.totals['type'], hrMax: ws[0]!.totals['hrMax'] }, { start: day * 1000, kcal: 210, type: 1, hrMax: 150 });
  assert.deepEqual(ws[0]!.samples, [{ t: day, hr: 120, speed: 30 }, { t: day + 5, hr: 131, speed: 32 }]);
  const [rec] = workoutRecords(ws, 1, 'WATCH D2');
  assert.deepEqual(rec?.local, { texts: { 300010027: 'fresh' } });
  assert.ok(!JSON.stringify(rec?.data).includes('fresh'));
});

test('D2 workouts: a block whose length doesn’t match its header is dropped', () => {
  const { header, data } = workoutBlock();
  const t = new Tlv().putTlv(0x81, new Tlv().putShort(0x02, 7).putShort(0x03, 0).put(0x04, header).put(0x05, data.slice(0, 4)));
  assert.deepEqual(parseWorkoutSamples(t), []);
});

test('D2 records: activity is kept per day and merged with what is stored; text goes to `local`', () => {
  const m = (t: number, steps: number) => ({ t, steps, kcal: null, distance: null, hr: null, restingHr: null, spo2: null });
  const first = activityRecords([m(day, 10), m(day + 60, 20)], 1, 'W', []);
  assert.equal(first.length, 1);
  const again = activityRecords([m(day + 60, 25), m(day + 120, 5)], 1, 'W', first);
  assert.deepEqual((again[0]?.data['minutes'] as { steps: number }[]).map((x) => x.steps), [10, 25, 5]);
  assert.deepEqual(mergeMinutes([m(1, 1)], [m(1, 2)]).map((x) => x.steps), [2]);
  const [r] = readingRecords([{ cls: 10002, start: 5, end: null, modified: null, values: { 1: 120 }, texts: { 2: 'note' } }], 1, 'W');
  assert.deepEqual(r?.local, { texts: { 2: 'note' } });
});

test('D2 cloud: a record row is read back; damaged rows are rejected', () => {
  const row = { id: 'reading:2:10002-5', data: { v: 1, kind: 'reading', id: '10002-5', user: 2, start: 5, data: { cls: 10002 }, watch: 'W', downloadedAt: 9 } };
  const r = parseCloudRecord(row);
  assert.deepEqual({ key: r?.key, user: r?.user, synced: r?.synced }, { key: 'reading:2:10002-5', user: 2, synced: true });
  assert.equal(parseCloudRecord({ data: { ...row.data, kind: 'other' } }), null);
  assert.equal(parseCloudRecord({ data: { ...row.data, v: 2 } }), null);
  assert.equal(parseCloudRecord({ data: { ...row.data, data: [1] } }), null);
});

import { agreementsTlv, parseCommands, setUpWatch, timeFields } from '../src/d2/setup';

test('D2 set-up: the watch is set up like the phone app does; a refusal before it becomes data after it', async () => {
  const w = new FakeWatch({ refuseUntilAgreed: true, workouts: [{ number: 7, start: day, end: day + 1800, kcal: 210, type: 1, ...workoutBlock() }] });
  const { link, log } = await connected(w);
  await assert.rejects(downloadWorkouts(link, 0, day + 9999, (l) => log.push(l)), /code 100004/);
  const support = await setUpWatch(link, { watchName: 'WATCH D2', accountId: '20007000023812345', profile: { heightCm: 175, weightKg: 70, age: 55, sex: 'male' }, log: (l) => log.push(l), now: new Date(day * 1000) });
  for (const m of ['1:2', '1:3', '1:37', '1:5', '1:32', '1:31', '1:30', '1a:5', '1:3e', '7:2']) assert.ok(w.setup.includes(m), `sent ${m}`);
  assert.ok(support.commands.get(0x17)?.has(0x01));
  assert.ok(log.some((l) => /Watch supports: .*workouts yes/.test(l)));
  assert.equal((await downloadWorkouts(link, 0, day + 9999, (l) => log.push(l))).length, 1);
});

test('D2 set-up: message formats', () => {
  // supported commands: one byte per command asked about
  const asked = new Map([[0x17, [0x01, 0x04, 0x06]]]);
  const t = new Tlv().putTlv(0x81, new Tlv().putByte(0x02, 0x17).put(0x04, Uint8Array.of(1, 0, 1)));
  assert.deepEqual([...(parseCommands(t, asked).get(0x17) ?? [])], [0x01, 0x06]);
  // time: hours + 128 west of UTC, then minutes
  const f = timeFields(new Date(day * 1000));
  const off = -new Date(day * 1000).getTimezoneOffset();
  assert.equal(f.offset >> 8, off < 0 ? Math.floor(-off / 60) + 128 : Math.floor(off / 60));
  assert.equal(f.seconds, day);
  // three agreements, each accepted
  const a = Tlv.parse(agreementsTlv(1).bytes(0x81));
  assert.deepEqual(a.items.map((i) => Tlv.parse(i.value).string(0x03)), ['software_update_service_statement', 'device_information_management', 'user_license_agreement']);
});

test('D2 set-up: the account goes to the watch only when its ID was entered', async () => {
  const w1 = new FakeWatch();
  const a = await connected(w1);
  await setUpWatch(a.link, { watchName: 'W', profile: null, log: (l) => a.log.push(l) });
  assert.ok(!w1.setup.some((m) => m.startsWith('1a:5')), 'no account message without an ID');
  assert.ok(a.log.some((l) => /account step is skipped/.test(l)));
  const w2 = new FakeWatch();
  const b = await connected(w2);
  await setUpWatch(b.link, { watchName: 'W', profile: null, accountId: '20007000023812345', log: (l) => b.log.push(l) });
  assert.ok(w2.setup.includes('1a:5'));
});

import { aggregate, bucketStart, modeFor, rangeStart, customSpan } from '../src/d2/graphsui';
import { DROPPED_CLASSES, READING_CLASSES } from '../src/d2/extra';

test('D2 graphs: periods, how finely they are shown, and per-day values', () => {
  const now = new Date(2026, 10, 3, 12, 0).getTime();
  assert.equal(rangeStart('1d', now, null), now - 86400000);
  assert.equal(new Date(rangeStart('3m', now, null)).getMonth(), 7); // 3 Aug
  assert.equal(new Date(rangeStart('5y', now, null)).getFullYear(), 2021);
  assert.equal(rangeStart('all', now, now - 5 * 86400000), now - 5 * 86400000);
  assert.equal(modeFor(now - 86400000, now), 'raw');
  assert.equal(modeFor(now - 90 * 86400000, now), 'day');
  assert.equal(modeFor(now - 3 * 365 * 86400000, now), 'week');
  assert.equal(new Date(bucketStart(new Date(2026, 10, 5, 15).getTime(), 'week')).getDay(), 1); // weeks start on Monday
  const d0 = new Date(2026, 10, 2).getTime();
  const pts = [{ t: d0 + 3600000, v: 10 }, { t: d0 + 7200000, v: 30 }, { t: d0 + 86400000 + 60000, v: 5 }];
  assert.deepEqual(aggregate(pts, 'day', 'sum').map((p) => p.v), [40, 5]);
  assert.deepEqual(aggregate(pts, 'day', 'mean').map((p) => [p.v, p.lo, p.hi]), [[20, 10, 30], [5, 5, 5]]);
});

test('D2 measurements: blood pressure fields are named; dropped kinds are no longer read', () => {
  assert.deepEqual(READING_CLASSES[10002]?.fields, { 2006: 'Systolic (mmHg)', 2007: 'Diastolic (mmHg)', 10002537: 'Pulse (bpm)' });
  for (const cls of DROPPED_CLASSES) assert.equal(READING_CLASSES[cls], undefined);
  assert.deepEqual(Object.keys(READING_CLASSES).map(Number).sort(), [10002, 500031, 500044]);
});

test('D2: ECG recordings are no longer downloaded, kept or sent the ECG switch', async () => {
  const { D2_KINDS, DROPPED_KINDS } = await import('../src/d2/store');
  assert.ok(!(D2_KINDS as readonly string[]).includes('ecg'));
  assert.deepEqual([...DROPPED_KINDS], ['ecg']);
  const row = { data: { v: 1, kind: 'ecg', id: '1', user: 1, start: 1, data: { avgHr: 70 }, watch: 'W', downloadedAt: 1 } };
  assert.equal(parseCloudRecord(row), null, 'an ECG record from the cloud is not taken');
  const w = new FakeWatch();
  const { link, log } = await connected(w);
  await setUpWatch(link, { watchName: 'W', profile: null, log: (l) => log.push(l) });
  assert.ok(!w.setup.includes('23:10'));
});

import { downloadPeriod } from '../src/d2/period';

test('D2 download period: last days, or chosen dates from the start of one day to the end of the other', () => {
  const now = new Date(2026, 10, 3, 14, 0).getTime(), nowS = now / 1000;
  assert.deepEqual(downloadPeriod('7', '', '', now), { start: nowS - 7 * 86400, end: nowS });
  assert.deepEqual(downloadPeriod('custom', '2026-10-01', '2026-10-31', now), { start: new Date(2026, 9, 1).getTime() / 1000, end: new Date(2026, 10, 1).getTime() / 1000 - 1 });
  assert.deepEqual(downloadPeriod('custom', '2026-11-01', '2026-11-03', now), { start: new Date(2026, 10, 1).getTime() / 1000, end: nowS }, 'not after now');
  assert.ok('error' in downloadPeriod('custom', '2026-11-02', '2026-11-01', now));
  assert.ok('error' in downloadPeriod('custom', '', '2026-11-01', now));
  assert.ok('error' in downloadPeriod('custom', '2026-12-01', '2026-12-02', now));
});

import { parseBeats } from '../src/d2/live';

test('D2 live: the heartbeat test streams beat intervals with their signal quality', async () => {
  const w = new FakeWatch();
  const { link } = await connected(w);
  const got: { rri: number; sqi: number }[] = [];
  const done = new Promise<void>((resolve) => {
    link.listeners.add((p) => { if (p.service === 0x19 && p.command === 0x05 && p.tlv) { got.push(...parseBeats(p.tlv)); resolve(); } });
  });
  await link.request({ service: 0x19, command: 0x01, tlv: new Tlv().putByte(0x01, 3) }, 2000, 'test');
  await done;
  assert.deepEqual(got, [{ rri: 800, sqi: 1 }, { rri: 820, sqi: 1 }, { rri: 790, sqi: 0 }]);
  assert.ok(w.setup.includes('19:1:3'));
});

import { connectLive } from '../src/d2/live';
import { connectWatch, disconnectWatch, onWatch, ensureSetUp } from '../src/d2/watch';

test('D2 watch: one connection is shared by D2 Link and Synchronised Tracking', async () => {
  // D2 Bridge stood in for by a socket that talks to the fake watch
  const w = new FakeWatch();
  let sockets = 0;
  class FakeSocket {
    static OPEN = 1;
    readyState = 1; binaryType = '';
    onopen: (() => void) | null = null; onmessage: ((e: { data: unknown }) => void) | null = null; onerror: (() => void) | null = null; onclose: (() => void) | null = null;
    constructor() {
      sockets++;
      w.transport.onData = (d) => this.onmessage?.({ data: d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) });
      setTimeout(() => { this.onopen?.(); this.onmessage?.({ data: 'open WATCH D2' }); }, 0);
    }
    send(d: Uint8Array): void { void w.transport.send(d); }
    close(): void { this.readyState = 3; this.onclose?.(); }
  }
  const saved = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket;
  try {
    const states: boolean[] = [];
    onWatch((s) => states.push(s != null));
    const first = await connectWatch('test', 'mac'); // D2 Link connects
    await ensureSetUp(first, null);
    const setupsAfterFirst = w.setup.filter((m) => m === '1:2').length;
    let closed = 0;
    const live = await connectLive({ account: 'test', user: 1, via: 'mac', profile: null, log: () => {} }); // Synchronised Tracking joins
    live.onClose = () => { closed++; };
    assert.equal(sockets, 1, 'no second connection or pairing');
    assert.equal(w.setup.filter((m) => m === '1:2').length, setupsAfterFirst, 'the set-up isn’t repeated');
    assert.equal(await connectWatch('test', 'mac'), first);
    await live.startHeartbeats(() => {});
    assert.ok(w.setup.includes('19:1:3'), 'the page that joined can use the watch');
    await disconnectWatch();
    assert.equal(closed, 1, 'the other page hears it is disconnected');
    assert.deepEqual(states, [false, true, false]);
  } finally {
    (globalThis as { WebSocket?: unknown }).WebSocket = saved;
  }
});

test('D2 records: text from the watch comes back from the cloud', () => {
  const data = { v: 1, kind: 'reading', id: 'a', user: 1, start: 5, data: { cls: 1 }, local: { texts: { 2: 'note' } } };
  const r = parseCloudRecord({ data });
  assert.deepEqual(r?.local, { texts: { 2: 'note' } });
  assert.equal(r?.textSynced, true);
  assert.equal(parseCloudRecord({ data: { ...data, local: undefined } })?.local, undefined);
});

test('D2 download history in the cloud: uploaded once, fetched from elsewhere, and deletions carry across', () => {
  const log = (at: number, synced: boolean) => ({ at, user: 1, button: 'all' as const, via: 'x', from: 0, to: 1, watch: 'W', items: [], ok: true, result: 'Done', synced });
  const id = (at: number) => `log:1:${at}`;
  const plan = planDownloads([log(1, false), log(2, true), log(3, true), log(4, false)], new Set([id(1), id(3), id(7), id(8)]), new Set([id(8)]));
  assert.deepEqual(plan.markSynced.map((e) => e.at), [1]);
  assert.deepEqual(plan.upload.map((e) => e.at), [4]);
  assert.deepEqual(plan.removeHere.map((e) => e.at), [2]);
  assert.deepEqual(plan.fetch, [id(7)]);
  assert.deepEqual(planDownloads([log(5, true), log(6, true)], new Set([id(5), id(6), id(4), id(9)]), new Set(), 2).fetch, [id(9)], 'a full history skips older ones');
  assert.equal(parseCloudDownload({ data: { at: 'x' } }), null);
  assert.equal(parseCloudDownload({ data: log(1, false) })?.synced, true);
});

test('D2 downloads: an identical record is left alone and counted as nil change', () => {
  const rec = (key: string, v: number, downloadedAt: number) => ({ key, kind: 'stress' as const, id: key, user: 1, start: 5, data: { score: v }, source: 'd2' as const, watch: 'W', downloadedAt });
  const stored = [rec('a', 1, 10), rec('b', 2, 10)];
  const { changed, same } = onlyChanged([rec('a', 1, 99), rec('b', 3, 99), rec('c', 4, 99)], stored, (r) => r.key, recordContent);
  assert.deepEqual(same.map((r) => r.key), ['a'], 'the time of the download doesn’t count as a change');
  assert.deepEqual(changed.map((r) => r.key), ['b', 'c']);
  const night = (stages: number[]) => ({ id: 'd2-1', user: 1, start: 1000, stages, summary: emptySummary(), source: 'd2' as const, watch: 'W', downloadedAt: 1 });
  assert.equal(onlyChanged([night([1, 2])], [{ ...night([1, 2]), downloadedAt: 9, synced: true }], (n) => n.id, nightContent).same.length, 1);
  assert.equal(onlyChanged([night([1, 3])], [night([1, 2])], (n) => n.id, nightContent).changed.length, 1);
  assert.equal(nilText(2, 2), ' (nil change)');
  assert.equal(nilText(3, 1), ' (1 nil change)');
  assert.equal(nilText(3, 0), '');
});

test('D2 downloads: a failed connection isn’t recorded, but a download that stopped part way is', () => {
  assert.equal(nothingCameBack({ ok: false, items: [] }), true);
  assert.equal(nothingCameBack({ ok: false, items: [{ what: 'sleep records', count: 0 }] }), true);
  assert.equal(nothingCameBack({ ok: false, items: [{ what: 'sleep records', count: 2 }] }), false);
  assert.equal(nothingCameBack({ ok: true, items: [{ what: 'sleep records', count: 0 }] }), false);
});

test('D2 link: a message that can’t be sent fails at once and leaves no stray error; one that never sends ends at the time limit', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown): void => { unhandled.push(e); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const failing = { onData: null, onClose: null, close: async () => undefined, send: async () => { throw new Error('GATT busy'); } };
    const link = new D2Link(failing, () => undefined);
    await assert.rejects(link.request({ service: 0x2c, command: 0x01, tlv: new Tlv().put(1), encrypt: false, sliced: false }, 30, 'the test'), /GATT busy/);
    const stuck = { onData: null, onClose: null, close: async () => undefined, send: () => new Promise<void>(() => undefined) };
    const link2 = new D2Link(stuck, () => undefined);
    await assert.rejects(link2.request({ service: 0x2c, command: 0x01, tlv: new Tlv().put(1), encrypt: false, sliced: false }, 30, 'the test'), /did not answer the test/);
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', onUnhandled); }
});

test('D2 Link graphs: a custom period runs from the start of its first date to the end of its last, not after now', () => {
  const now = new Date(2026, 10, 14, 9, 0).getTime();
  const [a, b] = customSpan({ from: '2026-11-01', to: '2026-11-07' }, now);
  assert.equal(a, new Date(2026, 10, 1).getTime());
  assert.equal(b, new Date(2026, 10, 8).getTime() - 1);
  assert.equal(customSpan({ from: '2026-11-10', to: '2026-11-30' }, now)[1], now, 'not after now');
  assert.equal(customSpan({ from: '', to: '' }, now)[0], now - 7 * 86400000, 'no dates: the last 7 days');
});
