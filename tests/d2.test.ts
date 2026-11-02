// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link tests. The byte vectors come from Gadgetbridge's own tests (TestHuaweiPacket), © Gadgetbridge contributors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc16, hex, unhex, varint, readVarint } from '../src/d2/bytes';
import { Tlv } from '../src/d2/tlv';
import { Decoder, defaultParams, encode, open } from '../src/d2/packet';

const bytes = (...b: number[]): Uint8Array => Uint8Array.from(b);
const zeroKeyParams = () => ({ ...defaultParams(), secretKey: new Uint8Array(16) });

test('D2 packets: CRC and variable-length sizes match Gadgetbridge', () => {
  assert.equal(crc16(bytes(0x5a, 0x00, 0x07, 0x00, 0x7f, 0x7f, 0x01, 0x02, 0x03, 0x04)), 0x40b6);
  for (const v of [0, 1, 127, 128, 300, 16383, 16384, 70000]) {
    const e = varint(v);
    assert.deepEqual(readVarint(e, 0), { value: v, size: e.length });
  }
  assert.equal(hex(varint(128)), '8100');
});

test('D2 packets: an unencrypted packet is written byte for byte like Gadgetbridge', async () => {
  const out = await encode(defaultParams(), { service: 1, command: 2, tlv: new Tlv().putInt(3, 0x05060708), sliced: false, encrypt: false });
  assert.equal(out.length, 1);
  assert.equal(hex(out[0]!), hex(bytes(0x5a, 0x00, 0x09, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0xa4, 0xf0)));
});

test('D2 packets: a long packet is split into the same slices as Gadgetbridge', async () => {
  const tlv = new Tlv().putInt(1, 0).putInt(2, 0).putInt(3, 0).putInt(4, 0);
  const out = await encode({ ...defaultParams(), sliceSize: 0x10 }, { service: 1, command: 2, tlv, encrypt: false });
  assert.deepEqual(out.map(hex), [
    '5A000B01000102010400000000' + '02CC98',
    '5A000B0201040000000003040000' + 'FAD3',
    '5A000A030200000404000000003' + '7CA',
  ].map((s) => s.replace(/\s/g, '')));
  // and the decoder joins them back
  const d = new Decoder();
  const bodies = out.flatMap((p) => d.push(p));
  assert.equal(bodies.length, 1);
  const pkt = await open(defaultParams(), bodies[0]!);
  assert.equal(pkt.service, 1);
  assert.equal(pkt.command, 2);
  assert.equal(pkt.tlv?.items.length, 4);
});

test('D2 packets: encrypted packets (AES-CBC, zero key and IV) match Gadgetbridge both ways', async () => {
  // Gadgetbridge's expected serialisation of {0x03: 0x05060708} with an all-zero key and IV
  const expected = '5A002A0001027C01017D1000000000000000000000000000000000' + '7E103B89FC79D9055EED5235FE16A08A4D5393C7';
  const p = { ...zeroKeyParams(), deviceSupportType: 0 };
  // fixed IV: replace the random IV by encrypting with a provider whose IV is zero
  const { encrypt } = await import('../src/d2/crypto');
  const cipher = await encrypt(false, new Tlv().putInt(3, 0x05060708).serialize(), p.secretKey, new Uint8Array(16));
  const body = new Tlv().putByte(0x7c, 1).put(0x7d, new Uint8Array(16)).put(0x7e, cipher).serialize();
  const frame = (await encode(p, { service: 1, command: 2, tlv: Tlv.parse(body), sliced: false, encrypt: false }))[0]!;
  assert.equal(hex(frame), expected);

  // and an encrypted packet from the watch is read and decrypted
  const input = unhex('5A002A007F7F7C01017D10000000000000000000000000000000007E109E40E1EA15F650808C4519D52ABB29B8D524');
  const [b] = new Decoder().push(input);
  const pkt = await open(p, b!);
  assert.equal(pkt.encrypted, true);
  assert.equal(pkt.tlv?.short(1), 0x0304);
});

// ---------- sleep file and the whole connection, against a fake watch ----------

import { parseSleepFile, STAGE_CODES } from '../src/d2/sleepfile';
import { writeSleepFile } from '../src/d2/sleepfile-writer';
import { D2Link, WatchError, type Pairing } from '../src/d2/link';
import { FakeWatch } from './d2fake';

const bed = Date.UTC(2026, 10, 1, 16, 7) / 1000; // 00:07 in Singapore
const night = {
  summary: {
    bedTime: bed, fallAsleepTime: bed + 240, wakeupTime: bed + 417 * 60, validData: 1, sleepScore: 82, deepPart: 79, sleepDataQuality: 94,
    avgHeartRate: 56, minHeartRateBaseline: 47, maxHeartRateBaseline: 54, avgHrv: 45, minHrvBaseline: 39, maxHrvBaseline: 61,
    avgOxygenSaturation: 97, minOxygenSaturationBaseline: 96, maxOxygenSaturationBaseline: 99, wakeCount: 3, avgBreathRate: 15,
  },
  segments: [
    { minutes: 4, stage: 4 }, { minutes: 60, stage: 1 }, { minutes: 41, stage: 3 }, { minutes: 30, stage: 2 }, { minutes: 2, stage: 4 },
    { minutes: 90, stage: 1 }, { minutes: 60, stage: 3 }, { minutes: 48, stage: 2 }, { minutes: 2, stage: 4 }, { minutes: 80, stage: 1 },
  ],
};

test('D2 sleep file: summary values and minute-by-minute stages are read back', () => {
  const file = writeSleepFile([night]);
  const [n] = parseSleepFile(file);
  assert.ok(n);
  assert.equal(n.summary.sleepScore, 82);
  assert.equal(n.summary.wakeCount, 3);
  assert.equal(n.summary.avgHrv, 45);
  assert.equal(n.summary.maxOxygenSaturationBaseline, 99);
  assert.equal(n.summary.snoreFreq, null); // not in the file
  assert.equal(n.start, bed);
  assert.equal(n.stages.length, 417);
  const count = (code: number): number => n.stages.filter((s) => s === code).length;
  assert.equal(count(3), 101); // deep 1 h 41 min
  assert.equal(count(1), 230); // light 3 h 50 min
  assert.equal(count(2), 78); // REM 1 h 18 min
  assert.equal(STAGE_CODES[4], 'awake');
  // a damaged (truncated) file gives what could be read, without throwing
  assert.deepEqual(parseSleepFile(file.slice(0, 40)), []);
});

async function connectFake(w: FakeWatch, pairing: Pairing | null): Promise<{ link: D2Link; kept: Pairing; log: string[] }> {
  const log: string[] = [];
  const link = new D2Link(w.transport, (l) => log.push(l));
  const kept = await link.connect(pairing);
  return { link, kept, log };
}

for (const deviceSupportType of [4, 3]) {
  test(`D2 link (support type ${deviceSupportType}): pairs, logs in again with the saved pairing, downloads the sleep file`, async () => {
    const file = writeSleepFile([night]);
    const w = new FakeWatch({ deviceSupportType, sleepFile: file, blockSize: 700 });
    const first = await connectFake(w, null);
    assert.ok(first.log.some((l) => l.includes('Pairing accepted')));
    assert.equal(first.link.info?.battery, 77);
    assert.equal(first.link.info?.name, 'HUAWEI WATCH D2-ABC');
    assert.ok(w.log.includes('1:7 (encrypted)'), 'requests after login are encrypted');
    const got = await first.link.downloadSleep(bed - 86400, bed + 86400);
    assert.equal(hex(got), hex(file));

    // a later connection uses the saved pairing: no PIN step
    const w2 = new FakeWatch({ deviceSupportType, sleepFile: file, ...(w.authToken ? { knownToken: w.authToken } : {}) });
    const again = await connectFake(w2, first.kept);
    assert.ok(!w2.log.includes('1:44'), 'no pairing code requested');
    assert.equal(again.kept.authId, first.kept.authId);
    assert.equal(parseSleepFile(await again.link.downloadSleep(0, bed + 86400))[0]?.summary.sleepScore, 82);
  });
}

test('D2 link: a watch that does not trust the pairing gives a clear error', async () => {
  const w = new FakeWatch({ rejectToken: true });
  await assert.rejects(connectFake(w, null), (e: unknown) => e instanceof WatchError && /rejected the pairing code/.test(e.message));
});

test('D2 link: no nights on the watch gives an empty download', async () => {
  const w = new FakeWatch({ sleepFile: new Uint8Array(0) });
  const { link } = await connectFake(w, null);
  assert.equal((await link.downloadSleep(0, 1)).length, 0);
});
