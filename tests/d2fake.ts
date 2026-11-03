// SPDX-License-Identifier: AGPL-3.0-or-later
// A fake Watch D2 for tests: the watch's side of link set-up, HiChain login, file downloads, activity, the data
// dictionary sync and workouts.
// It follows the same protocol description (Gadgetbridge), so it checks that D2 Link is self-consistent,
// not that a real watch accepts it.
import { concat, equal, hex, randomBytes, readUint, u32, u64, unhex, utf8 } from '../src/d2/bytes';
import { aesCbcEncrypt, aesGcmDecrypt, aesGcmEncrypt, digestSecret, hkdfSha256, hmacSha256, sha256 } from '../src/d2/crypto';
import { Decoder, defaultParams, encode, encryptBody, open, type InPacket } from '../src/d2/packet';
import { Tlv } from '../src/d2/tlv';
import type { Transport } from '../src/d2/link';

export interface FakeWatchOptions {
  deviceSupportType?: number; // 4 = HiChain3 (GCM)
  encryptMethod?: number;
  pin?: Uint8Array;
  sleepFile?: Uint8Array;
  blockSize?: number;
  /** A token the watch already trusts (a previous pairing). */
  knownToken?: Uint8Array;
  rejectToken?: boolean;
  /** Offsets in file blocks counted from the start of each block instead of the file. */
  relativeOffsets?: boolean;
  /** Ignore the first block request (the watch was busy). */
  dropFirstBlockRequest?: boolean;
  /** Other files by file type (0x10 stress). */
  files?: Record<number, Uint8Array>;
  /** Activity blocks: start (s) and per-minute [offset, fields]. */
  activity?: { start: number; minutes: [number, Uint8Array][] }[];
  totals?: { steps: number; kcal: number; distance: number };
  /** Data dictionary records by class: start (ms) and number fields. */
  readings?: Record<number, { start: number; values: Record<number, number> }[]>;
  /** The data sync service doesn't answer. */
  noDataSync?: boolean;
  /** Refuse workouts (code 100004) until the agreements were sent, as a watch that wasn't set up might. */
  refuseUntilAgreed?: boolean;
  workouts?: { number: number; start: number; end: number; kcal: number; type: number; header: Uint8Array; data: Uint8Array }[];
}

export class FakeWatch {
  readonly params = defaultParams();
  readonly log: string[] = [];
  authToken: Uint8Array | null;
  private decoder = new Decoder();
  private chain = Promise.resolve();
  private hc: { psk: Uint8Array; randSelf: Uint8Array; randPeer: Uint8Array; sessionKey?: Uint8Array; peerId: Uint8Array; clientId: Uint8Array; op: number } | null = null;
  private readonly watchId = utf8('D2FAKEWATCH000000000000000000001');
  private readonly pin: Uint8Array;
  readonly transport: Transport;
  private dropped = false;
  /** Acknowledgements the fake got for its data sync messages. */
  readonly acks: number[] = [];
  /** Set-up messages received ("service:command"). */
  readonly setup: string[] = [];
  agreed = false;

  constructor(private readonly o: FakeWatchOptions = {}) {
    this.params.deviceSupportType = o.deviceSupportType ?? 4;
    this.params.encryptMethod = o.encryptMethod ?? 0;
    this.params.authVersion = 3;
    this.pin = o.pin ?? utf8('123456');
    this.authToken = o.knownToken ?? null;
    const t: Transport = {
      onData: null,
      onClose: null,
      send: async (data) => { for (const b of this.decoder.push(data)) this.chain = this.chain.then(() => this.handle(b)); },
      close: async () => undefined,
    };
    this.transport = t;
  }

  private async reply(service: number, command: number, tlv: Tlv, encrypt = true): Promise<void> {
    for (const f of await encode(this.params, { service, command, tlv, encrypt })) setTimeout(() => this.transport.onData?.(f), 0);
  }

  private async replyRaw(service: number, command: number, body: Uint8Array): Promise<void> {
    // raw packets are framed like the others; build them by hand (unsliced)
    const { crc16 } = await import('../src/d2/bytes');
    const len = 2 + body.length;
    const head = concat(Uint8Array.of(0x5a, (len + 1) >> 8, (len + 1) & 0xff, 0, service, command), body);
    const c = crc16(head);
    const frame = concat(head, Uint8Array.of(c >> 8, c & 0xff));
    setTimeout(() => this.transport.onData?.(frame), 0);
  }

  private async handle(body: Uint8Array): Promise<void> {
    const p: InPacket = await open(this.params, body);
    const t = p.tlv ?? new Tlv();
    this.log.push(`${p.service}:${p.command}${p.encrypted ? ' (encrypted)' : ''}`);
    if (p.service === 1 && p.command === 0x01) {
      return this.reply(1, 1, new Tlv().putByte(1, 2).putShort(2, 0xf4).putShort(3, 0x200).putShort(4, 10)
        .put(5, concat(Uint8Array.of(0, this.params.authVersion), randomBytes(16))).putByte(7, this.params.deviceSupportType).putByte(0x0c, this.params.encryptMethod), false);
    }
    if (p.service === 1 && p.command === 0x16) return this.reply(1, 0x16, new Tlv().putByte(1, 1), false);
    if (p.service === 1 && p.command === 0x33) { // HiChain3 answers 4 + 1 (= type 5); classic HiChain answers 1 alone (= 0x0186A0)
      return this.reply(1, 0x33, this.params.deviceSupportType === 4 ? new Tlv().putByte(1, 4).putByte(2, 1) : new Tlv().putByte(1, 1), false);
    }
    if (p.service === 1 && p.command === 0x2c) {
      const iv = randomBytes(16);
      return this.reply(1, 0x2c, new Tlv().put(1, await aesCbcEncrypt(this.pin, digestSecret(this.params.authVersion), iv)).put(2, iv), false);
    }
    if (p.service === 1 && p.command === 0x28) return this.hiChain(t);
    if (p.service === 1 && p.command === 0x07) return this.reply(1, 7, new Tlv().putString(7, '5.0.0.123').putString(9, 'SN123').putString(0x0a, 'WATCH D2').putString(0x11, 'WATCH D2-ABC'));
    if (p.service === 1 && p.command === 0x08) return this.reply(1, 8, new Tlv().putByte(1, 77));
    if (p.service === 1 && p.command === 0x02) { // every service asked about is supported
      this.setup.push('1:2');
      return this.reply(1, 2, new Tlv().put(0x02, new Uint8Array(t.bytes(0x01).length).fill(1)));
    }
    if (p.service === 1 && p.command === 0x03) { // every command asked about is supported
      this.setup.push('1:3');
      const out = new Tlv();
      for (const i of Tlv.parse(t.bytes(0x81)).items) {
        if (i.tag === 0x02) out.put(0x02, i.value);
        if (i.tag === 0x03) out.put(0x04, new Uint8Array(i.value.length).fill(1));
      }
      return this.reply(1, 3, new Tlv().putTlv(0x81, out));
    }
    if (p.service === 1 && p.command === 0x37) { this.setup.push('1:37'); return this.reply(1, 0x37, new Tlv().put(0x01, new Uint8Array(32).fill(0xff))); }
    if (p.service === 1 && p.command === 0x30) { this.setup.push('1:30'); this.agreed = true; return this.reply(1, 0x30, new Tlv().putInt(0x7f, 100000)); }
    if ((p.service === 1 && [0x05, 0x31, 0x32, 0x3e].includes(p.command)) || p.service === 0x1a || (p.service === 7 && p.command === 0x02) || p.service === 0x23) {
      this.setup.push(`${p.service.toString(16)}:${p.command.toString(16)}`);
      return this.reply(p.service, p.command, new Tlv().putInt(0x7f, 100000));
    }
    if (p.service === 0x2c) return this.file(p.command, t);
    if (p.service === 0x07) return this.fitness(p.command, t);
    if (p.service === 0x34) return this.dataSync(t);
    if (p.service === 0x17) return this.workout(p.command, t);
  }

  private inner = (t: Tlv): Tlv => Tlv.parse(t.bytes(0x81));

  private async fitness(command: number, t: Tlv): Promise<void> {
    const blocks = this.o.activity ?? [];
    if (command === 0x0a) return this.reply(7, 0x0a, new Tlv().putTlv(0x81, new Tlv().putShort(0x02, blocks.length)));
    if (command === 0x0b) {
      const i = this.inner(t).short(0x02), b = blocks[i];
      const c = new Tlv().putShort(0x02, i).putInt(0x03, b?.start ?? 0);
      for (const [off, data] of b?.minutes ?? []) c.putTlv(0x84, new Tlv().putByte(0x05, off).put(0x06, data));
      return this.reply(7, 0x0b, new Tlv().putTlv(0x81, c));
    }
    if (command === 0x03) {
      const x = this.o.totals ?? { steps: 0, kcal: 0, distance: 0 };
      return this.reply(7, 0x03, new Tlv().putTlv(0x81, new Tlv().putTlv(0x83, new Tlv().putInt(0x05, x.steps).putShort(0x06, x.kcal).putInt(0x07, x.distance))));
    }
    return undefined;
  }

  private seq = 100;
  private async dataSync(t: Tlv): Promise<void> {
    if (this.o.noDataSync) return;
    const cmd = t.byte(0x01), seq = t.short(0x02), from = t.string(0x03), to = t.string(0x04);
    const msg = (c: number, s: number, src: string, dst: string, data: Uint8Array | null, code: number | null): Promise<void> => {
      const m = new Tlv().putByte(0x01, c).putShort(0x02, s).putString(0x03, src).putString(0x04, dst);
      if (data) m.put(0x07, data);
      if (code != null) m.putByte(0x08, code);
      return this.reply(0x34, 0x01, m);
    };
    if (cmd === 3) { this.acks.push(seq); return; }
    if (cmd === 1) return msg(3, seq, to, from, null, 0xca);
    if (cmd !== 2) return;
    await msg(3, seq, to, from, null, 0xca);
    const req = Tlv.parse(t.bytes(0x07), 1);
    const cls = readUint(req.bytes(0x02)), since = readUint(req.bytes(0x05));
    const block = new Tlv();
    for (const r of (this.o.readings?.[cls] ?? []).filter((x) => x.start >= since)) {
      const fields = new Tlv();
      for (const [f, v] of Object.entries(r.values)) {
        const d = new Uint8Array(8);
        new DataView(d.buffer).setFloat64(0, v);
        fields.putTlv(0x88, new Tlv().putInt(0x09, Number(f)).put(0x0a, d));
      }
      block.putTlv(0x84, new Tlv().put(0x05, u64(r.start)).put(0x06, u64(r.start + 60000)).putTlv(0x87, fields));
    }
    const answer = new Tlv().putByte(0x01, 1).put(0x02, req.bytes(0x02)).putTlv(0x83, block);
    return msg(2, ++this.seq, to, from, concat(Uint8Array.of(1), answer.serialize()), null);
  }

  private async workout(command: number, t: Tlv): Promise<void> {
    const ws = this.o.workouts ?? [];
    if (this.o.refuseUntilAgreed && !this.agreed) return this.reply(0x17, command, new Tlv().putInt(0x7f, 100004));
    if (command === 0x07) {
      const c = new Tlv().putShort(0x02, ws.length);
      for (const w of ws) c.putTlv(0x85, new Tlv().putShort(0x06, w.number).putShort(0x07, 1).putShort(0x08, 0));
      return this.reply(0x17, 0x07, new Tlv().putTlv(0x81, c));
    }
    const n = this.inner(t).short(0x02), w = ws.find((x) => x.number === n);
    if (!w) return this.reply(0x17, command, new Tlv().putInt(0x7f, 0x1234));
    if (command === 0x08) {
      return this.reply(0x17, 0x08, new Tlv().putTlv(0x81, new Tlv().putShort(0x02, n).putInt(0x04, w.start).putInt(0x05, w.end).putInt(0x06, w.kcal)
        .put(0x0c, Uint8Array.of(70, 150)).putByte(0x14, w.type).putTlv(0xe7, new Tlv().putInt(0x68, 300010027).putString(0x69, 'fresh'))));
    }
    if (command === 0x0a) {
      return this.reply(0x17, 0x0a, new Tlv().putTlv(0x81, new Tlv().putShort(0x02, n).putShort(0x03, 0).put(0x04, w.header).put(0x05, w.data)));
    }
    return undefined;
  }

  private async hiChain(t: Tlv): Promise<void> {
    const v = JSON.parse(t.string(1)) as { payload: Record<string, unknown>; message: number };
    const pl = v.payload;
    const op = t.byte(2);
    // the numbers a real watch expects (Gadgetbridge): pairing 1, 2, 3, 4; logging in 0x11, 0x12, then 0x13 for the last message
    const step = typeof pl['seed'] === 'string' ? 1 : typeof pl['token'] === 'string' ? 2 : typeof pl['encData'] === 'string' ? 3 : 4;
    const expected = op === 2 ? 0x10 | Math.min(step, 3) : step;
    this.log.push(`hichain op ${op} message 0x${v.message.toString(16)}`);
    if (v.message !== expected) return; // a real watch doesn't answer a message with the wrong number
    const msg = (payload: Record<string, unknown>): Promise<void> => this.reply(1, 0x28, new Tlv().putString(1, JSON.stringify({ payload })).putByte(4, 0), false);
    if (typeof pl['seed'] === 'string') { // step 1
      const key = op === 1 ? await sha256(utf8(hex(this.pin))) : this.authToken;
      if (!key) return msg({ errorCode: 5 });
      const psk = await hmacSha256(key, unhex(pl['seed']));
      const randSelf = unhex(String(pl['isoSalt'])), randPeer = randomBytes(16);
      const clientId = unhex(String(pl['peerAuthId']));
      this.hc = { psk, randSelf, randPeer, peerId: this.watchId, clientId, op };
      let token = await hmacSha256(psk, concat(randPeer, randSelf, clientId, this.watchId));
      if (this.o.rejectToken) token = randomBytes(32);
      return msg({ isoSalt: hex(randPeer), peerAuthId: hex(this.watchId), peerUserType: 0, token: hex(token) });
    }
    const hc = this.hc;
    if (!hc) return msg({ errorCode: 1 });
    if (typeof pl['token'] === 'string') { // step 2
      const want = await hmacSha256(hc.psk, concat(hc.randSelf, hc.randPeer, hc.peerId, hc.clientId));
      if (!equal(want, unhex(pl['token']))) return msg({ errorCode: 2 });
      hc.sessionKey = await hkdfSha256(hc.psk, concat(hc.randSelf, hc.randPeer), utf8('hichain_iso_session_key'), 32);
      return msg({ returnCodeMac: hex(await hmacSha256(hc.psk, new Uint8Array(4))) });
    }
    if (typeof pl['encData'] === 'string' && hc.sessionKey) { // step 3 (pairing)
      const challenge = await aesGcmDecrypt(unhex(pl['encData']), hc.sessionKey, unhex(String(pl['nonce'])), utf8('hichain_iso_exchange'));
      this.authToken = randomBytes(32);
      const nonce = randomBytes(12);
      return msg({ nonce: hex(nonce), encAuthToken: hex(await aesGcmEncrypt(this.authToken, hc.sessionKey, nonce, challenge)) });
    }
    if (typeof pl['encResult'] === 'string' && hc.sessionKey) { // step 4
      await aesGcmDecrypt(unhex(pl['encResult']), hc.sessionKey, unhex(String(pl['nonce'])), utf8('hichain_iso_result'));
      await this.reply(1, 0x28, new Tlv().putString(1, 'ok').putByte(4, 1), false);
      if (hc.op === 2) { // logged in: everything is encrypted from now on
        const key = await hkdfSha256(hc.sessionKey, concat(hc.randSelf, hc.randPeer), utf8('hichain_return_key'), 32);
        this.params.secretKey = key; // the reply above is already encoded (unencrypted); everything after is encrypted
      }
    }
    return undefined;
  }

  private fileOf(type: number): Uint8Array {
    return type === 0x16 ? this.o.sleepFile ?? new Uint8Array(0) : this.o.files?.[type] ?? new Uint8Array(0);
  }

  private async file(command: number, t: Tlv): Promise<void> {
    const file = this.fileOf(t.byte(1)); // the file id is the file type here
    if (command === 0x01) {
      const f = this.fileOf(t.byte(2));
      return this.reply(0x2c, 1, new Tlv().putString(1, t.string(1)).putByte(2, t.byte(2)).putByte(3, t.byte(2)).putInt(4, f.length));
    }
    if (command === 0x03) return this.reply(0x2c, 3, new Tlv().putByte(1, t.byte(1)).putByte(2, 5).putShort(3, 0x100).putInt(4, this.o.blockSize ?? 1000).putByte(5, 0));
    if (command === 0x04) {
      if (this.o.dropFirstBlockRequest && !this.dropped) { this.dropped = true; return undefined; }
      const offset = t.int(2), size = t.int(3);
      for (let o = offset; o < offset + size; o += 200) {
        const chunk = file.slice(o, Math.min(o + 200, offset + size));
        const plain = concat(Uint8Array.of(t.byte(1)), u32(this.o.relativeOffsets ? o - offset : o), Uint8Array.of(0), chunk);
        await this.replyRaw(0x2c, 5, (await encryptBody(this.params, plain)).serialize());
      }
    }
    return undefined;
  }
}
