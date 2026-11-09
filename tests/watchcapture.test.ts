import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describePacket } from '../src/d2/live';
import { Tlv } from '../src/d2/tlv';

test('watch capture: a message is described by its layout only, never its values', () => {
  const beat = (rri: number): Tlv => new Tlv().putShort(0x04, rri).putByte(0x05, 1);
  const inner = new Tlv().putTlv(0x83, beat(812)).putTlv(0x83, beat(797)).putTlv(0x83, beat(805));
  const tlv = new Tlv().putTlv(0x82, inner);
  const line = describePacket({ service: 0x19, command: 0x05, tlv, raw: tlv.serialize(), encrypted: true });
  assert.equal(line, '19/05 enc 82[83[04:2 05:1]×3]');
  assert.ok(!/812|797|805/.test(line));
  assert.equal(describePacket({ service: 0x0a, command: 0x05, tlv: null, raw: new Uint8Array(20), encrypted: false }), '0a/05 raw 20 bytes');
});
