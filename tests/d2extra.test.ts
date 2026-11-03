// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link: the other watch data (activity, totals, data dictionary, stress, ECG, workouts) against the fake watch,
// and how it is stored and synced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D2Link } from '../src/d2/link';
import {
  classBytes, downloadActivity, downloadReadings, downloadTotals, downloadWorkouts, parseActivityMinute, parseEcgFile, parseStressFile, parseWorkoutSamples,
} from '../src/d2/extra';
import { activityRecords, ecgRecords, mergeMinutes, readingRecords, workoutRecords } from '../src/d2/records';
import { parseCloudRecord } from '../src/d2/cloud';
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
    activity: [{ start: day, minutes: [[0, MINUTE], [1, MINUTE]] }, { start: day + 3600, minutes: [[0, MINUTE]] }],
    totals: { steps: 8000, kcal: 250, distance: 6100 },
    readings: { 10002: [{ start: day * 1000, values: { 10002001: 128, 10002002: 82 } }], 500044: [{ start: day * 1000 + 5000, values: { 500044831: 41 } }] },
  });
  const { link, log } = await connected(w);
  const minutes = await downloadActivity(link, day - 86400, day + 86400);
  assert.deepEqual(minutes.map((m) => m.t), [day, day + 60, day + 3600]);
  assert.deepEqual(await downloadTotals(link), { steps: 8000, kcal: 250, distance: 6100 });
  const readings = await downloadReadings(link, 0, (l) => log.push(l));
  const bp = readings.find((r) => r.cls === 10002);
  assert.deepEqual(bp?.values, { 10002001: 128, 10002002: 82 });
  assert.equal(readings.find((r) => r.cls === 500044)?.values['500044831'], 41);
  assert.ok(w.acks.length >= 2, 'each data message from the watch is acknowledged');
  assert.ok(log.some((l) => /Blood pressure: 1 record/.test(l)));
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

function ecgFile(): Uint8Array {
  const samples = [0.1, 0.5, -0.2, 0.0];
  const pkg = 'ecg.app';
  const b = new Uint8Array(32 + pkg.length + 56 + samples.length * 4);
  const dv = new DataView(b.buffer);
  b[8] = pkg.length;
  b.set(new TextEncoder().encode(pkg), 32);
  const o = 32 + pkg.length;
  dv.setUint32(o, day); dv.setUint32(o + 4, day + 30); dv.setUint32(o + 8, samples.length * 4);
  b.set(new TextEncoder().encode('1.2.3'), o + 12);
  dv.setUint32(o + 44, 1); dv.setUint16(o + 48, 66); dv.setUint32(o + 52, 4);
  samples.forEach((v, i) => dv.setFloat32(o + 56 + 4 * i, v));
  return b;
}

test('D2 files: stress and ECG recordings download like the sleep file and are read back', async () => {
  const w = new FakeWatch({ files: { 0x10: stressFile(), 0x18: ecgFile() } });
  const { link } = await connected(w);
  const stress = parseStressFile(await link.downloadFile({ name: 'rrisqi_data.bin', type: 0x10, start: 0, end: day + 999, what: 'stress' }));
  assert.equal(stress.length, 1);
  assert.deepEqual({ start: stress[0]!.start, end: stress[0]!.end, score: stress[0]!.score, level: stress[0]!.level }, { start: day * 1000, end: (day + 120) * 1000, score: 35, level: 1 });
  assert.equal(stress[0]!.features[3], 1.5);
  const ecg = parseEcgFile(await link.downloadFile({ name: 'ecg_analysis_data.bin', type: 0x18, start: 0, end: day + 999, what: 'ECG' }));
  assert.equal(ecg.length, 1);
  assert.deepEqual({ avgHr: ecg[0]!.avgHr, arrhythmia: ecg[0]!.arrhythmia, symptoms: ecg[0]!.symptoms, appVersion: ecg[0]!.appVersion }, { avgHr: 66, arrhythmia: 1, symptoms: 4, appVersion: '1.2.3' });
  assert.deepEqual(ecg[0]!.samples.map((v) => Math.round(v * 10) / 10), [0.1, 0.5, -0.2, 0]);
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
  const [e] = ecgRecords([{ start: 1, end: 2, avgHr: 60, arrhythmia: 0, symptoms: 0, appVersion: '1.0', samples: [1] }], 1, 'W');
  assert.equal('appVersion' in (e?.data ?? {}), false);
});

test('D2 cloud: a record row is read back; damaged rows are rejected', () => {
  const row = { id: 'reading:2:10002-5', data: { v: 1, kind: 'reading', id: '10002-5', user: 2, start: 5, data: { cls: 10002 }, watch: 'W', downloadedAt: 9 } };
  const r = parseCloudRecord(row);
  assert.deepEqual({ key: r?.key, user: r?.user, synced: r?.synced }, { key: 'reading:2:10002-5', user: 2, synced: true });
  assert.equal(parseCloudRecord({ data: { ...row.data, kind: 'other' } }), null);
  assert.equal(parseCloudRecord({ data: { ...row.data, v: 2 } }), null);
  assert.equal(parseCloudRecord({ data: { ...row.data, data: [1] } }), null);
});
