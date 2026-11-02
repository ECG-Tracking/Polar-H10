// SPDX-License-Identifier: AGPL-3.0-or-later
// A fake Huawei Watch D2 for tests: the watch's side of link set-up, HiChain login and the sleep download.
// It follows the same protocol description (Gadgetbridge), so it checks that D2 Link is self-consistent,
// not that a real watch accepts it.
import { concat, equal, hex, randomBytes, u32, unhex, utf8 } from '../src/d2/bytes';
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
    if (p.service === 1 && p.command === 0x07) return this.reply(1, 7, new Tlv().putString(7, '5.0.0.123').putString(9, 'SN123').putString(0x0a, 'WATCH D2').putString(0x11, 'HUAWEI WATCH D2-ABC'));
    if (p.service === 1 && p.command === 0x08) return this.reply(1, 8, new Tlv().putByte(1, 77));
    if (p.service === 0x2c) return this.file(p.command, t);
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

  private async file(command: number, t: Tlv): Promise<void> {
    const file = this.o.sleepFile ?? new Uint8Array(0);
    if (command === 0x01) return this.reply(0x2c, 1, new Tlv().putString(1, t.string(1)).putByte(2, t.byte(2)).putByte(3, 0x16).putInt(4, file.length));
    if (command === 0x03) return this.reply(0x2c, 3, new Tlv().putByte(1, t.byte(1)).putByte(2, 5).putShort(3, 0x100).putInt(4, this.o.blockSize ?? 1000).putByte(5, 0));
    if (command === 0x04) {
      const offset = t.int(2), size = t.int(3);
      for (let o = offset; o < offset + size; o += 200) {
        const chunk = file.slice(o, Math.min(o + 200, offset + size));
        const plain = concat(Uint8Array.of(t.byte(1)), u32(o), Uint8Array.of(0), chunk);
        await this.replyRaw(0x2c, 5, (await encryptBody(this.params, plain)).serialize());
      }
    }
    return undefined;
  }
}
