// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — framing of the watch's packets: magic byte, length, slices, CRC, and the encrypted-body wrapper.
// Ported from Gadgetbridge's packet code (https://codeberg.org/Freeyourgadget/Gadgetbridge), © Gadgetbridge contributors.
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

import { concat, crc16, u16 } from './bytes';
import { decrypt, encrypt, nextIv } from './crypto';
import { Tlv } from './tlv';

const MAGIC = 0x5a;

/** What both sides agreed on for this connection. */
export interface LinkParams {
  sliceSize: number;
  deviceSupportType: number;
  encryptMethod: number;
  authVersion: number;
  authAlgo: number;
  /** Session key once logged in; packets are encrypted with it from then on. */
  secretKey: Uint8Array | null;
  counter: number;
}

export const defaultParams = (): LinkParams => ({ sliceSize: 0xf4, deviceSupportType: 0, encryptMethod: 0, authVersion: 0, authAlgo: 0, secretKey: null, counter: 0 });

const useGcm = (p: LinkParams): boolean => p.encryptMethod === 1 || p.deviceSupportType === 4;

// encrypted body: 0x7C = 1 (encrypted), 0x7D = IV, 0x7E = ciphertext
export async function encryptBody(p: LinkParams, plain: Uint8Array): Promise<Tlv> {
  if (!p.secretKey) throw new Error('not logged in');
  const iv = nextIv(p);
  return new Tlv().putByte(0x7c, 1).put(0x7d, iv).put(0x7e, await encrypt(useGcm(p), plain, p.secretKey, iv));
}

export async function decryptBody(p: LinkParams, tlv: Tlv): Promise<Uint8Array> {
  if (!p.secretKey) throw new Error('encrypted packet before login');
  return decrypt(useGcm(p), tlv.bytes(0x7e), p.secretKey, tlv.bytes(0x7d));
}

const withCrc = (b: Uint8Array): Uint8Array => concat(b, u16(crc16(b)));

function unsliced(service: number, command: number, body: Uint8Array): Uint8Array[] {
  const len = 2 + body.length;
  return [withCrc(concat(Uint8Array.of(MAGIC), u16(len + 1), Uint8Array.of(0, service, command), body))];
}

function sliced(sliceSize: number, service: number, command: number, body: Uint8Array): Uint8Array[] {
  const header = 5, footer = 2;
  const maxBody = sliceSize - header - footer;
  const count = Math.ceil((body.length + 2) / maxBody);
  if (count <= 1) return unsliced(service, command, body);
  const out: Uint8Array[] = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    const size = Math.min(sliceSize, body.length - pos + header + footer);
    const flag = i === 0 ? 1 : i === count - 1 ? 3 : 2;
    let content = size - header - footer;
    const ids = i === 0 ? Uint8Array.of(service, command) : new Uint8Array(0);
    content -= ids.length;
    out.push(withCrc(concat(Uint8Array.of(MAGIC), u16(size - header), Uint8Array.of(flag, i & 0xff), ids, body.slice(pos, pos + content))));
    pos += content;
  }
  return out;
}

export interface OutPacket {
  service: number;
  command: number;
  tlv: Tlv;
  /** Encrypt the body (only once logged in). Gadgetbridge's default is true. */
  encrypt?: boolean;
  /** Split into slices of sliceSize. Gadgetbridge's default is true. */
  sliced?: boolean;
}

export async function encode(p: LinkParams, pkt: OutPacket): Promise<Uint8Array[]> {
  const body = pkt.encrypt !== false && p.secretKey ? (await encryptBody(p, pkt.tlv.serialize())).serialize() : pkt.tlv.serialize();
  return pkt.sliced === false ? unsliced(pkt.service, pkt.command, body) : sliced(p.sliceSize, pkt.service, pkt.command, body);
}

export interface InPacket {
  service: number;
  command: number;
  /** The fields, already decrypted; null for the few raw (non-TLV) packets. */
  tlv: Tlv | null;
  /** Everything after service and command. */
  raw: Uint8Array;
  encrypted: boolean;
}

// these carry raw bytes instead of fields
const RAW = new Set(['10:5', '40:6', '44:5', '28:5']);

/** Turns the incoming byte stream into complete packets (joins slices, checks CRCs). */
export class Decoder {
  private buf = new Uint8Array(0);
  private slices: Uint8Array[] = [];
  badFrames = 0;

  /** Returns the complete packets in `data`, still to be decrypted with `open()`. */
  push(data: Uint8Array): Uint8Array[] {
    this.buf = concat(this.buf, data);
    const done: Uint8Array[] = [];
    for (;;) {
      const start = this.buf.indexOf(MAGIC);
      if (start < 0) { this.buf = new Uint8Array(0); break; }
      if (start > 0) this.buf = this.buf.slice(start); // skip noise until the next magic byte
      if (this.buf.length < 3) break;
      const size = ((this.buf[1] ?? 0) << 8) | (this.buf[2] ?? 0);
      const total = 3 + size + 2;
      if (this.buf.length < total) break;
      const frame = this.buf.slice(0, total);
      this.buf = this.buf.slice(total);
      const crc = ((frame[total - 2] ?? 0) << 8) | (frame[total - 1] ?? 0);
      if (crc16(frame.slice(0, total - 2)) !== crc) { this.badFrames++; continue; } // damaged: drop it
      const flag = frame[3] ?? 0;
      if (flag >= 1 && flag <= 3) {
        if (flag === 1) this.slices = [];
        this.slices.push(frame.slice(5, 3 + size));
        if (flag === 3) { done.push(concat(...this.slices)); this.slices = []; }
      } else {
        done.push(frame.slice(4, 3 + size));
      }
    }
    return done;
  }
}

/** Reads a complete packet body (service, command, fields) and decrypts it if needed. */
export async function open(p: LinkParams, body: Uint8Array): Promise<InPacket> {
  const service = body[0] ?? 0, command = body[1] ?? 0;
  const raw = body.slice(2);
  if (RAW.has(`${service}:${command}`)) return { service, command, tlv: null, raw, encrypted: false };
  let tlv = Tlv.parse(raw);
  let encrypted = false;
  if (tlv.has(0x7c) && tlv.bool(0x7c) && p.secretKey) {
    tlv = Tlv.parse(await decryptBody(p, tlv));
    encrypted = true;
  }
  return { service, command, tlv, raw, encrypted };
}
