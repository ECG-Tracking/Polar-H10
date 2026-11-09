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

test('watch capture: protocol numbers are shown for known ECG messages, nothing else', () => {
  const enc = new TextEncoder();
  const entry = new Tlv().putInt(0x05, 900300006).putByte(0x06, 2).put(0x07, Uint8Array.of(1, 1, 0)).put(0x08, new Uint8Array(8));
  const tlv = new Tlv().put(0x01, enc.encode('hw.health.ecganalysis')).put(0x02, enc.encode('hw.health.ecganalysis')).putTlv(0x83, new Tlv().putTlv(0x84, entry));
  const line = describePacket({ service: 0x37, command: 0x01, tlv, raw: tlv.serialize(), encrypted: true });
  assert.equal(line, '37/01 enc 01:21="hw.health.ecganalysis" 02:21="hw.health.ecganalysis" 83[84[05:4=900300006 06:1=2 07:3=65792 08:8]]');
  const other = new Tlv().putByte(0x01, 7);
  assert.equal(describePacket({ service: 0x07, command: 0x0a, tlv: other, raw: other.serialize(), encrypted: true }), '07/0a enc 01:1');
});
