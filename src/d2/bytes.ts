// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — byte helpers for the watch protocol.
// Ported from Gadgetbridge (https://codeberg.org/Freeyourgadget/Gadgetbridge), © Gadgetbridge contributors.
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

/** Uppercase hex, as Gadgetbridge (and the watch) use it. */
export function hex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s.toUpperCase();
}

export function unhex(s: string): Uint8Array {
  const t = s.length % 2 ? `0${s}` : s;
  const out = new Uint8Array(t.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = parseInt(t.slice(2 * i, 2 * i + 2), 16);
    if (Number.isNaN(v)) throw new Error('invalid hex');
    out[i] = v;
  }
  return out;
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const fromUtf8 = (b: Uint8Array): string => new TextDecoder().decode(b);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** CRC-16/CCITT with initial value 0, as used in every packet's footer. */
export function crc16(data: Uint8Array, init = 0): number {
  let crc = init;
  for (const b of data) {
    crc = ((crc >>> 8) | (crc << 8)) & 0xffff;
    crc ^= b;
    crc ^= (crc & 0xff) >> 4;
    crc ^= (crc << 12) & 0xffff;
    crc ^= ((crc & 0xff) << 5) & 0xffff;
  }
  return crc & 0xffff;
}

/** Big-endian variable-length integer, 7 bits per byte (TLV lengths). */
export function varint(value: number): Uint8Array {
  const bytes: number[] = [value & 0x7f];
  for (let v = value >>> 7; v !== 0; v >>>= 7) bytes.unshift((v & 0x7f) | 0x80);
  return Uint8Array.from(bytes);
}

export function readVarint(buf: Uint8Array, offset: number): { value: number; size: number } {
  let value = 0, size = 0;
  for (;;) {
    const b = buf[offset + size];
    if (b === undefined) throw new Error('truncated length');
    value = value * 128 + (b & 0x7f);
    size++;
    if ((b & 0x80) === 0) return { value, size };
    if (size > 4) throw new Error('length too long');
  }
}

export const u8 = (v: number): Uint8Array => Uint8Array.of(v & 0xff);
export const u16 = (v: number): Uint8Array => Uint8Array.of((v >>> 8) & 0xff, v & 0xff);
export const u32 = (v: number): Uint8Array => Uint8Array.of((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);

/** 64-bit big-endian, for values up to 2^53 (milliseconds). */
export function u64(v: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(Math.floor(v)));
  return out;
}

/** Unsigned big-endian integer of 1–6 bytes. */
export function readUint(b: Uint8Array): number {
  let v = 0;
  for (const x of b) v = v * 256 + x;
  return v;
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}
