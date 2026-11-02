// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — writes a sleep file in the watch's format. Used by tests and for the demo night, so both go
// through the same reader as real downloads.
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

import { concat } from './bytes';
import { Tlv } from './tlv';
import { SLEEP_DICT, type D2Summary } from './sleepfile';

const IDS: Readonly<Partial<Record<keyof D2Summary, number>>> = {
  fallAsleepTime: 700013686, bedTime: 700013298, risingTime: 700013973, wakeupTime: 700013156, validData: 700013786,
  sleepDataQuality: 700013254, deepPart: 700013679, sleepScore: 700013245, sleepLatency: 700013713, sleepEfficiency: 700013232,
  minHeartRate: 700013436, maxHeartRate: 700013502, avgHeartRate: 700013580, minHeartRateBaseline: 700013722, maxHeartRateBaseline: 700013841,
  avgHrv: 700013878, minHrvBaseline: 700013305, maxHrvBaseline: 700013355, avgOxygenSaturation: 700013468,
  minOxygenSaturationBaseline: 700013633, maxOxygenSaturationBaseline: 700013227, avgBreathRate: 700013886,
  minBreathRateBaseline: 700013839, maxBreathRateBaseline: 700013225, wakeCount: 700013635, turnOverCount: 700013670, rdi: 700013759,
};

export interface SleepRecordInput { summary: Partial<D2Summary>; segments: { minutes: number; stage: number }[] }

function summaryBytes(s: Partial<D2Summary>): Uint8Array {
  const inner = new Tlv();
  for (const [k, id] of Object.entries(IDS)) {
    const v = s[k as keyof D2Summary];
    if (v == null || id == null) continue;
    inner.putTlv(0x82, new Tlv().putInt(0x03, id).putByte(0x04, 4).putInt(0x05, Math.round(v)));
  }
  return new Tlv().putTlv(0x81, inner).serialize();
}

function detailBytes(segments: SleepRecordInput['segments']): Uint8Array {
  const out = new Uint8Array(segments.length * 8);
  const dv = new DataView(out.buffer);
  segments.forEach((g, i) => { dv.setInt32(i * 8, g.minutes * 60, true); dv.setInt8(i * 8 + 4, g.stage); });
  return out;
}

export function writeSleepFile(records: SleepRecordInput[]): Uint8Array {
  const parts = records.map((r) => {
    const summary = summaryBytes(r.summary), details = detailBytes(r.segments);
    const head = new Uint8Array(32);
    const dv = new DataView(head.buffer);
    dv.setInt32(0, r.summary.bedTime ?? r.summary.fallAsleepTime ?? 0);
    dv.setInt32(4, r.summary.wakeupTime ?? 0);
    dv.setInt8(8, 1); // version
    dv.setInt8(9, 2); // summary type
    dv.setInt16(10, summary.length);
    dv.setInt32(12, details.length);
    return concat(head, summary, details);
  });
  const body = concat(...parts);
  const head = new Uint8Array(32);
  const dv = new DataView(head.buffer);
  dv.setInt32(0, body.length);
  dv.setInt32(4, SLEEP_DICT);
  dv.setInt16(8, 1); // file type
  dv.setInt16(10, 1); // file version
  return concat(head, body);
}
