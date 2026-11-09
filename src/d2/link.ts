// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — talks to a Watch D2: link set-up, login (pairing), watch details and file downloads (sleep and others).
// Ported from Gadgetbridge's watch support (connection, login, device settings and file download code)
// (https://codeberg.org/Freeyourgadget/Gadgetbridge), © Gadgetbridge contributors.
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

import { concat, equal, fromUtf8, hex, randomBytes, u64, unhex, utf8 } from './bytes';
import { aesCbcDecrypt, aesGcmDecrypt, aesGcmEncrypt, digestSecret, hkdfSha256, hmacSha256, sha256 } from './crypto';
import { Decoder, defaultParams, decryptBody, encode, open, type InPacket, type OutPacket } from './packet';
import { Tlv } from './tlv';
import { SLEEP_DICT } from './sleepfile';

/** A byte pipe to the watch (Web Serial over Bluetooth in the browser, a fake watch in tests). */
export interface Transport {
  send(data: Uint8Array): Promise<void>;
  onData: ((data: Uint8Array) => void) | null;
  onClose: (() => void) | null;
  close(): Promise<void>;
}

/** What the watch remembers about this browser after pairing; kept on this device only. */
export interface Pairing {
  authId: string; // our identity: 32 uppercase hex characters
  authToken: string; // hex, from the first pairing
}

export interface WatchInfo { model: string; software: string; serial: string; name: string; battery: number | null }

export type Log = (line: string) => void;

const DEVICE_CONFIG = 0x01;
const FILE_DOWNLOAD = 0x2c;
const GROUP_ID = '7B0BC0CBCE474F6C238D9661C63400B797B166EA7849B3A370FC73A9A236E989';
const ZERO4 = new Uint8Array(4);
/** The phone app id the watch expects in the login message and in data sync requests (a protocol constant, not shown to users). */
export const HEALTH_APP_ID = 'com.huawei.health';

export class WatchError extends Error {}

interface Waiter { service: number; command: number; resolve: (p: InPacket) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export class D2Link {
  readonly params = defaultParams();
  info: WatchInfo | null = null;
  private readonly decoder = new Decoder();
  private waiters: Waiter[] = [];
  private incoming: Promise<void> = Promise.resolve();
  private blockListener: ((p: InPacket) => void) | null = null;
  /** Get the messages the watch sends on its own (e.g. the data sync service, the live heartbeat test). */
  readonly listeners = new Set<(p: InPacket) => void>();
  private closed = false;

  constructor(private readonly t: Transport, private readonly log: Log) {
    t.onData = (d) => this.onData(d);
    t.onClose = () => this.fail(new WatchError('The watch disconnected.'));
  }

  // ---------- sending and receiving ----------

  private onData(d: Uint8Array): void {
    for (const body of this.decoder.push(d)) {
      this.incoming = this.incoming.then(async () => {
        const p = await open(this.params, body);
        const w = this.waiters.find((x) => x.service === p.service && x.command === p.command);
        if (w) {
          this.waiters = this.waiters.filter((x) => x !== w);
          clearTimeout(w.timer);
          w.resolve(p);
        } else if (p.service === FILE_DOWNLOAD && p.command === 0x05) {
          this.blockListener?.(p);
        } else {
          for (const l of this.listeners) l(p);
        }
      }).catch((e: unknown) => this.log(`Could not read a packet from the watch: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  private fail(e: Error): void {
    this.closed = true;
    for (const w of this.waiters) { clearTimeout(w.timer); w.reject(e); }
    this.waiters = [];
  }

  async send(pkt: OutPacket): Promise<void> {
    if (this.closed) throw new WatchError('The watch is not connected.');
    for (const frame of await encode(this.params, pkt)) await this.t.send(frame);
  }

  /** Sends a request and waits for the watch's answer to the same service and command. */
  async request(pkt: OutPacket, timeoutMs = 5000, what = 'the request'): Promise<Tlv> {
    const answer = new Promise<InPacket>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x.timer !== timer);
        reject(new WatchError(`The watch did not answer ${what}.`));
      }, timeoutMs);
      this.waiters.push({ service: pkt.service, command: pkt.command, resolve, reject, timer });
    });
    await this.send(pkt);
    const p = await answer;
    if (!p.tlv) throw new WatchError(`Unexpected answer to ${what}.`);
    return p.tlv;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.t.close().catch(() => undefined);
  }

  // ---------- link set-up and login ----------

  /**
   * Connects, logs in (pairing first if `pairing` is null) and reads the watch details. Returns the pairing to keep.
   * `onPaired` gets a new pairing as soon as the watch accepts it, so it is kept even if a later step fails.
   */
  async connect(pairing: Pairing | null, onPaired: (p: Pairing) => void = () => {}): Promise<Pairing> {
    try {
      return await this.connectOnce(pairing, onPaired);
    } catch (e) {
      // the watch keeps one pairing per phone or computer: after pairing elsewhere on the same device, the saved one is refused
      if (!pairing || this.closed || !(e instanceof WatchError) || !/refused the login|no longer accepts/.test(e.message)) throw e;
      this.log(`The watch no longer accepts the saved pairing (${e.message.replace(/^The watch /, '').replace(/\.$/, '')}); pairing again – confirm on the watch if it asks…`);
      this.params.secretKey = null;
      return this.connectOnce(null, onPaired);
    }
  }

  private async connectOnce(pairing: Pairing | null, onPaired: (p: Pairing) => void): Promise<Pairing> {
    this.log('Reading the connection settings…');
    const lp = await this.request({ service: DEVICE_CONFIG, command: 0x01, tlv: new Tlv().put(1).put(2).put(3).put(4), encrypt: false, sliced: false }, 8000, 'the first message');
    if (lp.has(0x02)) this.params.sliceSize = lp.short(0x02);
    const nonceField = lp.bytes(0x05);
    this.params.authVersion = nonceField[1] ?? 0;
    this.params.deviceSupportType = lp.has(0x07) ? lp.byte(0x07) : 0;
    this.params.authAlgo = lp.has(0x08) ? lp.byte(0x08) : 0;
    this.params.encryptMethod = lp.has(0x0c) ? lp.byte(0x0c) : 0;
    this.log(`Protocol: auth version ${this.params.authVersion}, support type ${this.params.deviceSupportType}, encryption ${this.params.encryptMethod === 1 ? 'AES-GCM' : this.params.deviceSupportType === 4 ? 'AES-GCM' : 'AES-CBC'}, slice ${this.params.sliceSize} bytes`);

    // classic-Bluetooth watches report whether they are free to log in
    const st = await this.request({ service: DEVICE_CONFIG, command: 0x16, tlv: new Tlv().put(1), encrypt: false }, 5000, 'the status request')
      .catch(() => null);
    const status = st?.has(0x01) ? st.sbyte(0x01) : -1;
    if (status !== -1 && status !== 0 && status !== 1) throw new WatchError(`The watch is busy (status ${status}). Close the watch's app on your phone or turn off the phone's Bluetooth, then try again.`);

    const type = this.params.deviceSupportType;
    if (type !== 1 && type !== 3 && type !== 4) {
      throw new WatchError(type === 2
        ? 'This watch uses the "HiChain Lite" login, which D2 Link does not support yet.'
        : 'This watch uses an older login, which D2 Link does not support yet.');
    }
    const authMode = type === 4 ? 4 : 2;
    const neg = new Tlv().putByte(0x01, authMode).putByte(0x02, 1);
    const authId = pairing?.authId ?? hex(randomBytes(16));
    neg.put(0x05, utf8(authId)).putByte(0x03, 1).putByte(0x04, 0);
    if (authMode === 4) neg.put(0x06).putString(0x07, 'OpenBeat ECG');
    if (this.params.encryptMethod === 1) neg.putByte(0x0d, 1);
    const sn = await this.request({ service: DEVICE_CONFIG, command: 0x33, tlv: neg, encrypt: false }, 5000, 'the security negotiation');
    const authType = negotiatedAuthType(sn);
    if (!(authType === 0x0186a0 || authType === 5 || authType === 6)) {
      throw new WatchError(`The watch asked for login type ${authType}, which D2 Link does not support yet.`);
    }

    let token = pairing ? unhex(pairing.authToken) : null;
    if (!token) {
      this.log('Pairing: asking the watch for its pairing code…');
      const pin = await this.pinCode();
      this.log('Pairing: confirm the request on the watch if it asks (you have 60 seconds)…');
      const pinKey = await sha256(utf8(hex(pin)));
      const first = await this.hiChain(1, utf8(authId), pinKey);
      if (!first.authToken) throw new WatchError('Pairing did not return a key.');
      token = first.authToken;
      onPaired({ authId, authToken: hex(token) });
      this.log('Pairing accepted by the watch (saved on this device).');
    }
    this.log('Logging in…');
    const bind = await this.hiChain(2, utf8(authId), token);
    this.params.secretKey = await hkdfSha256(bind.sessionKey, concat(bind.randSelf, bind.randPeer), utf8('hichain_return_key'), 32);
    this.log('Logged in; the connection is now encrypted.');
    const kept: Pairing = { authId, authToken: hex(token) };

    await this.readInfo();
    return kept;
  }

  private async pinCode(): Promise<Uint8Array> {
    const r = await this.request({ service: DEVICE_CONFIG, command: 0x2c, tlv: new Tlv().put(1), encrypt: false }, 8000, 'the pairing code request');
    const message = r.bytes(0x01), iv = r.bytes(0x02);
    const key = digestSecret(this.params.authVersion);
    return this.params.encryptMethod === 1 ? aesGcmDecrypt(message, key, iv) : aesCbcDecrypt(message, key, iv);
  }

  /** One HiChain run: operation 1 pairs with the PIN-derived key and returns the auth token; operation 2 logs in with the token. */
  private async hiChain(op: 1 | 2, selfId: Uint8Array, key: Uint8Array): Promise<{ authToken: Uint8Array | null; sessionKey: Uint8Array; randSelf: Uint8Array; randPeer: Uint8Array }> {
    const requestId = Date.now();
    const seed = randomBytes(32), randSelf = randomBytes(16);
    const send = async (step: number, payload: Record<string, unknown>, value: Record<string, unknown> = {}, messageStep = step): Promise<Tlv> => {
      const json = hiChainJson(op, messageStep, requestId, selfId, payload, value);
      const tlv = new Tlv().putString(0x01, json).putByte(0x02, op).put(0x03, u64(requestId));
      const wait = op === 1 && step === 1 ? 60000 : 10000;
      return this.request({ service: DEVICE_CONFIG, command: 0x28, tlv, encrypt: false }, wait, `login step ${step}`);
    };
    // the identifiers below are values the watch expects in the login message (protocol constants, not shown to users)
    const opExtra = op === 2 ? { pkgName: 'com.huawei.devicegroupmanage', serviceType: GROUP_ID, keyLength: 0x20 } : {};
    const deviceLevel = op === 2 ? { isDeviceLevel: false } : {};

    // step 1: exchange salts; check the watch's token
    const r1 = hiChainPayload(await send(1, { isoSalt: hex(randSelf), peerAuthId: hex(selfId), operationCode: op, seed: hex(seed), peerUserType: 0, ...opExtra }, deviceLevel));
    const randPeer = unhex(str(r1, 'isoSalt')), peerId = unhex(str(r1, 'peerAuthId'));
    const psk = await hmacSha256(key, seed);
    const expected = await hmacSha256(psk, concat(randPeer, randSelf, selfId, peerId));
    if (!equal(expected, unhex(str(r1, 'token')))) {
      throw new WatchError(op === 1 ? 'The watch rejected the pairing code.' : 'The watch no longer accepts this browser’s pairing.');
    }

    // step 2: our token; check the watch's confirmation
    const selfToken = await hmacSha256(psk, concat(randSelf, randPeer, peerId, selfId));
    const r2 = hiChainPayload(await send(2, { peerAuthId: hex(selfId), token: hex(selfToken) }, deviceLevel));
    if (!equal(await hmacSha256(psk, ZERO4), unhex(str(r2, 'returnCodeMac')))) throw new WatchError('The watch’s login confirmation did not match.');

    // step 3: session key; when pairing, the watch sends the auth token encrypted with it
    const sessionKey = await hkdfSha256(psk, concat(randSelf, randPeer), utf8('hichain_iso_session_key'), 32);
    let authToken: Uint8Array | null = null;
    if (op === 1) {
      const nonce = randomBytes(12), challenge = randomBytes(16);
      const encData = await aesGcmEncrypt(challenge, sessionKey, nonce, utf8('hichain_iso_exchange'));
      const r3 = hiChainPayload(await send(3, { nonce: hex(nonce), encData: hex(encData) }));
      authToken = await aesGcmDecrypt(unhex(str(r3, 'encAuthToken')), sessionKey, unhex(str(r3, 'nonce')), challenge);
    }

    // step 4: confirm the result
    const nonce = randomBytes(12);
    const encResult = await aesGcmEncrypt(ZERO4, sessionKey, nonce, utf8('hichain_iso_result'));
    // when logging in (operation 2) step 3 is skipped, but the message keeps step 3's number (0x13), as in Gadgetbridge
    const r4 = await send(4, { nonce: hex(nonce), encResult: hex(encResult), operationCode: op }, {}, op === 2 ? 3 : 4);
    if (r4.has(0x04) && r4.byte(0x04) === 0) {
      const p = hiChainPayload(r4);
      if (typeof p['errorCode'] === 'number' && p['errorCode'] !== 0) throw new WatchError(`The watch ended the login with error ${p['errorCode']}.`);
    }
    return { authToken, sessionKey, randSelf, randPeer };
  }

  private async readInfo(): Promise<void> {
    const tags = [0x01, 0x02, 0x07, 0x09, 0x0a, 0x11, 0x12, 0x16, 0x1a, 0x1d, 0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23];
    const pi = await this.request({ service: DEVICE_CONFIG, command: 0x07, tlv: tags.reduce((t, x) => t.put(x), new Tlv()) }, 5000, 'the product information request')
      .catch((e: unknown) => { this.log(`Watch details not available: ${e instanceof Error ? e.message : String(e)}`); return null; });
    const s = (t: Tlv | null, tag: number): string => (t?.has(tag) ? t.string(tag).trim() : '');
    let battery: number | null = null;
    const bl = await this.request({ service: DEVICE_CONFIG, command: 0x08, tlv: new Tlv().put(1) }, 5000, 'the battery request').catch(() => null);
    if (bl?.has(0x01)) battery = bl.byte(0x01);
    this.info = { model: s(pi, 0x0a), software: s(pi, 0x07), serial: s(pi, 0x09), name: s(pi, 0x11), battery };
    this.log(`Watch: ${this.info.name || this.info.model || 'unknown'}${this.info.software ? `, software ${this.info.software}` : ''}${battery != null ? `, battery ${battery}%` : ''}`);
  }

  // ---------- sleep download ----------

  /** Downloads the watch's sleep file for [start, end] (seconds since 1970). An empty result means no nights. */
  async downloadSleep(start: number, end: number, progress: (done: number, total: number) => void = () => {}): Promise<Uint8Array> {
    this.log('Asking the watch for its sleep records…');
    const file = await this.downloadFile({ name: 'sequence_data', type: 0x16, start, end, dict: SLEEP_DICT, what: 'sleep' }, progress);
    if (file.length) this.log('Sleep records downloaded.');
    return file;
  }

  /**
   * Downloads one of the watch's files for [start, end] (seconds since 1970): `type` 0x16 = sequence data (with a
   * dictionary id), 0x10 = stress (heartbeat intervals), 0x18 = ECG recordings. An empty result means nothing recorded.
   */
  /** One file download at a time: the watch's pieces carry no file ID, so two at once would mix them up. */
  private fileQueue: Promise<unknown> = Promise.resolve();

  downloadFile(f: { name: string; type: number; start: number; end: number; dict?: number; what: string }, progress: (done: number, total: number) => void = () => {}): Promise<Uint8Array> {
    const run = this.fileQueue.then(() => this.downloadFileNow(f, progress), () => this.downloadFileNow(f, progress));
    this.fileQueue = run.catch(() => undefined);
    return run;
  }

  private async downloadFileNow(f: { name: string; type: number; start: number; end: number; dict?: number; what: string }, progress: (done: number, total: number) => void): Promise<Uint8Array> {
    const init = new Tlv().putString(0x01, f.name).putByte(0x02, f.type).putInt(0x05, f.start).putInt(0x06, f.end);
    if (f.dict != null) init.putInt(0x0c, f.dict);
    const r = await this.request({ service: FILE_DOWNLOAD, command: 0x01, tlv: init }, 10000, `the ${f.what} download request`);
    if (!r.has(0x03)) throw new WatchError(r.has(0x7f) ? `The watch refused the ${f.what} download (code ${r.asInt(0x7f)}).` : `The watch refused the ${f.what} download.`);
    const fileId = r.byte(0x03), size = r.has(0x04) ? r.int(0x04) : 0;
    if (size === 0) {
      await this.send({ service: FILE_DOWNLOAD, command: 0x06, tlv: new Tlv().putByte(0x01, fileId).putByte(0x02, 1) });
      return new Uint8Array(0);
    }
    const fi = await this.request({ service: FILE_DOWNLOAD, command: 0x03, tlv: new Tlv().putByte(0x01, fileId).put(2).put(3).put(4).put(5) }, 10000, 'the file information request');
    const timeoutS = Math.max(5, fi.has(0x02) ? fi.byte(0x02) : 10);
    const maxBlock = Math.max(1, fi.has(0x04) ? fi.int(0x04) : 4096);
    const noEncrypt = fi.has(0x05) && fi.bool(0x05);
    this.log(`Downloading ${(size / 1024).toFixed(1)} KB of ${f.what} data (blocks of up to ${maxBlock} bytes, ${noEncrypt ? 'unencrypted' : 'encrypted'} requests)…`);
    // Like Gadgetbridge: pieces are appended in the order they arrive (the offset the watch sends is only logged),
    // and a block is done when its bytes have arrived. Pieces are handled one at a time, so order is kept.
    const file = new Uint8Array(size);
    let received = 0, offsetsSeen = 0;
    const fetchBlock = (blockStart: number, blockSize: number): Promise<void> => new Promise<void>((resolve, reject) => {
      const stalled = (): void => reject(new WatchError(`stalled at ${received} of ${size} bytes`));
      let timer = setTimeout(stalled, timeoutS * 1000);
      let chain = Promise.resolve();
      this.blockListener = (p) => {
        chain = chain.then(async () => {
          const b = await this.readBlock(p);
          if (b.fileId !== fileId || received >= size) return;
          if (offsetsSeen++ < 3) this.log(`Piece: ${b.data.length} bytes, watch offset ${b.offset}, at ${received}`);
          const take = b.data.slice(0, size - received);
          file.set(take, received);
          received += take.length;
          progress(received, size);
          clearTimeout(timer);
          if (received - blockStart >= blockSize || received >= size) resolve();
          else timer = setTimeout(stalled, timeoutS * 1000);
        }).catch(reject);
      };
      const req = new Tlv().putByte(0x01, fileId).putInt(0x02, blockStart).putInt(0x03, blockSize);
      if (f.dict != null) req.putInt(0x04, f.dict);
      this.send({ service: FILE_DOWNLOAD, command: 0x04, tlv: req, encrypt: !noEncrypt }).catch(reject);
    });
    try {
      while (received < size) {
        const blockStart = received, blockSize = Math.min(size - received, maxBlock);
        for (let attempt = 1; ; attempt++) {
          try {
            await fetchBlock(received, blockSize - (received - blockStart));
            break;
          } catch (e) {
            if (!(e instanceof WatchError) || attempt >= 3) {
              throw new WatchError(`The ${f.what} download stopped (${e instanceof Error ? e.message : String(e)}).`);
            }
            this.log(`No more data from the watch at ${received} of ${size} bytes; asking again (${attempt + 1} of 3)…`);
          }
        }
      }
    } finally {
      this.blockListener = null;
    }
    await this.send({ service: FILE_DOWNLOAD, command: 0x06, tlv: new Tlv().putByte(0x01, fileId).putByte(0x02, 1) });
    return file;
  }

  /** A file block: fileId, offset, one spare byte, data; the body may be encrypted. */
  private async readBlock(p: InPacket): Promise<{ fileId: number; offset: number; data: Uint8Array }> {
    let b = p.raw;
    if (b[0] === 0x7c && b[1] === 0x01 && b[2] === 0x01) b = await decryptBody(this.params, Tlv.parse(b));
    const dv = new DataView(b.buffer, b.byteOffset, b.length);
    if (b.length < 6) throw new WatchError('A damaged file block arrived.');
    return { fileId: b[0] ?? 0, offset: dv.getInt32(1), data: b.slice(6) };
  }
}

// ---------- HiChain messages ----------

export function hiChainJson(op: number, step: number, requestId: number, selfId: Uint8Array, payload: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  const value: Record<string, unknown> = {
    authForm: 0,
    payload: { ...payload, version: { minVersion: '1.0.0', currentVersion: '2.0.16' } },
    groupAndModuleVersion: '2.0.1',
    message: op === 2 ? step | 0x10 : step,
    ...extra,
  };
  if (op === 1) {
    const id = fromUtf8(selfId);
    Object.assign(value, {
      requestId: String(requestId), groupId: GROUP_ID, groupName: 'health_group_name', groupOp: 2, groupType: 256,
      peerDeviceId: id, connDeviceId: id, appId: HEALTH_APP_ID, ownerName: '',
    });
  }
  return JSON.stringify(value);
}

/**
 * The JSON object in a text, ignoring anything around it (e.g. a trailing zero byte), as Java's JSON reader does.
 * Returns null if there is no readable object.
 */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const v: unknown = JSON.parse(text.slice(a, b + 1));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

/** How a text that isn't JSON starts and ends, without its content: first and last byte codes, any zero bytes. */
function textShape(b: Uint8Array): string {
  const code = (x: number | undefined): string => (x == null ? '-' : x >= 0x20 && x < 0x7f ? `'${String.fromCharCode(x)}'` : `0x${x.toString(16).padStart(2, '0')}`);
  const zeros = b.filter((x) => x === 0).length;
  return ` text[first ${code(b[0])} ${code(b[1])}, last ${code(b[b.length - 2])} ${code(b[b.length - 1])}${zeros ? `, ${zeros} zero bytes` : ''}]`;
}

/** A short, value-free description of a login reply for the connection log: its fields and JSON keys. */
export function describeReply(tlv: Tlv): string {
  return tlv.items.map((i) => {
    let text = '';
    try { text = fromUtf8(i.value); } catch { /* binary */ }
    let keys = '';
    {
      const v = parseJsonObject(text);
      if (typeof v === 'object' && v !== null) {
        const top = v as Record<string, unknown>;
        const pl = top['payload'];
        keys = ` JSON{${Object.keys(top).join(',')}}${typeof pl === 'object' && pl !== null ? ` payload{${Object.keys(pl).join(',')}}` : typeof pl === 'string' ? ' payload:text' : ''}${typeof top['message'] === 'number' ? ` message=${top['message']}` : ''}`;
      }
    }
    return `0x${i.tag.toString(16)}:${i.value.length}B${keys || (i.value.length <= 4 ? `=${hex(i.value)}` : textShape(i.value))}`;
  }).join(' ');
}

/**
 * The JSON payload of a login reply. These watches use one of two layouts (both in Gadgetbridge):
 * field 0x04 = type (0 = JSON in 0x01), or field 0x01 = data type (2 = JSON in 0x02).
 */
export function hiChainPayload(tlv: Tlv): Record<string, unknown> {
  if (tlv.has(0x04) && tlv.byte(0x04) !== 0) return {};
  const candidates = [0x01, 0x02].filter((t) => tlv.has(t)).map((t) => { try { return fromUtf8(tlv.bytes(t)); } catch { return ''; } });
  for (const text of candidates) {
    const top = parseJsonObject(text);
    if (!top) continue;
    let payload: unknown = top['payload'];
    if (typeof payload === 'string') payload = parseJsonObject(payload) ?? payload;
    const p = (typeof payload === 'object' && payload !== null ? payload : top) as Record<string, unknown>;
    const err = p['errorCode'] ?? top['errorCode'];
    if (typeof err === 'number' && err !== 0) throw new WatchError(`The watch refused the login (error ${err}).`);
    // PAKE replies carry an ephemeral key; classic replies (isoSalt, token…) are numbered 0x8000 + our message, e.g. 32785
    if (('epk' in p || 'challenge' in p) && !('isoSalt' in p) && !('returnCodeMac' in p) && !('encAuthToken' in p)) {
      throw new WatchError(`This watch uses a newer login (“PAKE”), which D2 Link does not support yet. Reply: ${describeReply(tlv)}`);
    }
    return p;
  }
  if (tlv.has(0x01) && !tlv.has(0x02) && tlv.items.length === 1 && candidates[0] === '') return {}; // an empty acknowledgement
  throw new WatchError(`The watch sent a login message D2 Link can’t read yet. Reply: ${describeReply(tlv)}`);
}

const str = (p: Record<string, unknown>, k: string): string => {
  const v = p[k];
  if (typeof v !== 'string') throw new WatchError(`The watch's login message is missing "${k}".`);
  return v;
};

/** Gadgetbridge's reading of the security negotiation answer. */
export function negotiatedAuthType(t: Tlv): number {
  let authType = -1, pw = -1;
  if (t.has(0x01)) {
    if (t.byte(0x01) === 0x01) authType = 0x0186a0;
    if (t.byte(0x01) === 0x04) pw = 4;
  }
  if (t.has(0x02)) {
    authType = t.sbyte(0x02);
    if (pw !== -1) authType ^= pw;
  }
  if (t.has(0x7f)) authType = t.sbyte(0x7f);
  return authType;
}
