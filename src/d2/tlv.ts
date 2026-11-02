// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — tag/length/value fields, the body of every Huawei packet.
// Ported from Gadgetbridge's HuaweiTLV (https://codeberg.org/Freeyourgadget/Gadgetbridge), © Gadgetbridge contributors.
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

import { concat, fromUtf8, readUint, readVarint, u16, u32, u8, utf8, varint } from './bytes';

export interface TlvItem { tag: number; value: Uint8Array }

export class Tlv {
  readonly items: TlvItem[] = [];

  static parse(buf: Uint8Array, offset = 0, length = buf.length - offset): Tlv {
    const t = new Tlv();
    let parsed = 0;
    while (parsed < length) {
      const tag = buf[offset + parsed] ?? 0;
      parsed += 1;
      if (parsed === length && tag === 0) break; // an extra null byte can follow encrypted data
      const { value: size, size: lenBytes } = readVarint(buf, offset + parsed);
      parsed += lenBytes;
      if (size > length - parsed) throw new Error(`field ${tag} is longer than the packet`);
      t.items.push({ tag, value: buf.slice(offset + parsed, offset + parsed + size) });
      parsed += size;
    }
    return t;
  }

  put(tag: number, value: Uint8Array = new Uint8Array(0)): this { this.items.push({ tag: tag & 0xff, value }); return this; }
  putByte(tag: number, v: number): this { return this.put(tag, u8(v)); }
  putShort(tag: number, v: number): this { return this.put(tag, u16(v)); }
  putInt(tag: number, v: number): this { return this.put(tag, u32(v)); }
  putBool(tag: number, v: boolean): this { return this.putByte(tag, v ? 1 : 0); }
  putString(tag: number, v: string): this { return this.put(tag, utf8(v)); }
  putTlv(tag: number, v: Tlv): this { return this.put(tag, v.serialize()); }

  serialize(): Uint8Array {
    return concat(...this.items.flatMap((i) => [u8(i.tag), varint(i.value.length), i.value]));
  }

  has(tag: number): boolean { return this.items.some((i) => i.tag === tag); }

  bytes(tag: number): Uint8Array {
    const item = this.items.find((i) => i.tag === tag);
    if (!item) throw new Error(`missing field 0x${tag.toString(16)}`);
    return item.value;
  }
  maybeBytes(tag: number): Uint8Array | null { return this.items.find((i) => i.tag === tag)?.value ?? null; }
  byte(tag: number): number { return this.bytes(tag)[0] ?? 0; }
  /** Signed byte, e.g. a status of −1. */
  sbyte(tag: number): number { const b = this.byte(tag); return b > 127 ? b - 256 : b; }
  short(tag: number): number { return readUint(this.bytes(tag).slice(0, 2)); }
  int(tag: number): number { return readUint(this.bytes(tag).slice(0, 4)); }
  /** 1, 2 or 4 byte unsigned value. */
  asInt(tag: number): number { return readUint(this.bytes(tag).slice(0, 4)); }
  bool(tag: number): boolean { return this.byte(tag) === 1; }
  string(tag: number): string { return fromUtf8(this.bytes(tag)); }

  /** Nested fields: every item whose tag has the top bit set. */
  containers(): Tlv[] {
    return this.items.filter((i) => (i.tag & 0x80) !== 0).map((i) => Tlv.parse(i.value));
  }
}
