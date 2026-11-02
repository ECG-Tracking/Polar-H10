// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — reads the watch's sleep file ("sequence data", dictionary 700013): the watch's own sleep result per night.
// Ported from Gadgetbridge's sequence-data and sleep-summary parsers
// (https://codeberg.org/Freeyourgadget/Gadgetbridge), © Gadgetbridge contributors.
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

import { readUint } from './bytes';
import { Tlv } from './tlv';

export const SLEEP_DICT = 700013;

/** Watch sleep stage codes, one per minute. */
export type D2Stage = 'light' | 'rem' | 'deep' | 'awake' | 'nap';
export const STAGE_CODES: Readonly<Record<number, D2Stage>> = { 1: 'light', 2: 'rem', 3: 'deep', 4: 'awake', 5: 'nap' };

/** The watch's summary of one night; null where the watch didn't report it. Times are seconds since 1970. */
export interface D2Summary {
  fallAsleepTime: number | null;
  bedTime: number | null;
  risingTime: number | null;
  wakeupTime: number | null;
  validData: number | null;
  sleepScore: number | null;
  sleepDataQuality: number | null;
  deepPart: number | null; // deep sleep continuity
  snoreFreq: number | null;
  sleepLatency: number | null;
  sleepEfficiency: number | null;
  minHeartRate: number | null;
  maxHeartRate: number | null;
  avgHeartRate: number | null;
  minHeartRateBaseline: number | null;
  maxHeartRateBaseline: number | null;
  avgHrv: number | null;
  minHrvBaseline: number | null;
  maxHrvBaseline: number | null;
  minOxygenSaturation: number | null;
  maxOxygenSaturation: number | null;
  avgOxygenSaturation: number | null;
  minOxygenSaturationBaseline: number | null;
  maxOxygenSaturationBaseline: number | null;
  minBreathRate: number | null;
  maxBreathRate: number | null;
  avgBreathRate: number | null;
  minBreathRateBaseline: number | null;
  maxBreathRateBaseline: number | null;
  rdi: number | null; // respiratory disturbance index
  wakeCount: number | null;
  turnOverCount: number | null;
  wakeUpFeeling: number | null;
  sleepVersion: number | null;
}

type Field = keyof D2Summary;
/** Dictionary ids of the summary values, with the range Gadgetbridge accepts for each. */
const FIELDS: Readonly<Record<number, readonly [Field, number, number]>> = {
  700013686: ['fallAsleepTime', 0, Infinity],
  700013298: ['bedTime', 0, Infinity],
  700013973: ['risingTime', 0, Infinity],
  700013156: ['wakeupTime', 0, Infinity],
  700013786: ['validData', 0, 2 ** 31 - 1],
  700013254: ['sleepDataQuality', 0, 2 ** 31 - 1],
  700013679: ['deepPart', 0, 2 ** 31 - 1],
  700013721: ['snoreFreq', 0, 2 ** 31 - 1],
  700013245: ['sleepScore', 0, 2 ** 31 - 1],
  700013713: ['sleepLatency', 0, 2 ** 31 - 1],
  700013232: ['sleepEfficiency', 0, 2 ** 31 - 1],
  700013436: ['minHeartRate', 0, 255],
  700013502: ['maxHeartRate', 0, 255],
  700013340: ['minOxygenSaturation', 0, Infinity],
  700013026: ['maxOxygenSaturation', 0, Infinity],
  700013646: ['minBreathRate', 0, 2 ** 31 - 1],
  700013492: ['maxBreathRate', 0, 2 ** 31 - 1],
  700013355: ['maxHrvBaseline', 0, 200],
  700013305: ['minHrvBaseline', 0, 200],
  700013878: ['avgHrv', 0, 200],
  700013225: ['maxBreathRateBaseline', 0, 80],
  700013839: ['minBreathRateBaseline', 0, 80],
  700013886: ['avgBreathRate', 0, 80],
  700013227: ['maxOxygenSaturationBaseline', 0, 100],
  700013633: ['minOxygenSaturationBaseline', 0, 100],
  700013468: ['avgOxygenSaturation', 0, 100],
  700013841: ['maxHeartRateBaseline', 0, 255],
  700013722: ['minHeartRateBaseline', 0, 255],
  700013580: ['avgHeartRate', 0, 255],
  700013759: ['rdi', 0, 100],
  700013635: ['wakeCount', 0, Infinity],
  700013670: ['turnOverCount', 0, Infinity],
  700013925: ['wakeUpFeeling', 0, Infinity],
  700013697: ['sleepVersion', 0, 100],
};

export const emptySummary = (): D2Summary => {
  const s = {} as Record<Field, number | null>;
  for (const [f] of Object.values(FIELDS)) s[f] = null;
  return s as D2Summary;
};

/** A value in the dictionary: 1/2/4 = integer, 3 = long, 6 = double; 0xBF800000 (−1.0f) means "none". */
function readValue(type: number, b: Uint8Array): number | null {
  if (b.length === 0) return null;
  if (type === 1 || type === 2 || type === 4) {
    if (b.length > 4 || (b.length === 4 && b[0] === 0xbf && b[1] === 0x80 && b[2] === 0 && b[3] === 0)) return null;
    return readUint(b);
  }
  if (type === 3) return b.length > 8 ? null : Number(b.reduce((v, x) => (v << 8n) | BigInt(x), 0n));
  if (type === 6 && b.length === 8) return new DataView(b.buffer, b.byteOffset, 8).getFloat64(0);
  return null;
}

function parseSummary(bytes: Uint8Array): D2Summary {
  const s = emptySummary();
  for (const outer of Tlv.parse(bytes).containers()) {
    for (const item of outer.containers()) {
      try {
        const def = FIELDS[item.asInt(0x03)];
        if (!def) continue;
        const v = readValue(item.asInt(0x04), item.bytes(0x05));
        const [field, lo, hi] = def;
        if (v != null && v >= lo && v <= hi) s[field] = field.endsWith('OxygenSaturation') && !field.startsWith('avg') ? v : Math.trunc(v);
      } catch { /* a field we can't read: skip it, like Gadgetbridge */ }
    }
  }
  if (s.validData == null) { // some watches send random values when the night isn't valid
    s.bedTime = null; s.risingTime = null; s.sleepScore = null; s.sleepDataQuality = null; s.deepPart = null;
    s.snoreFreq = null; s.sleepEfficiency = null; s.sleepLatency = null;
  }
  return s;
}

/** Stage per minute from `start` (seconds): each record is a little-endian duration in seconds, a stage code and 3 spare bytes. */
export function parseStages(details: Uint8Array, start: number): { start: number; stages: number[] } {
  const stages: number[] = [];
  if (details.length % 4 !== 0) return { start, stages };
  const dv = new DataView(details.buffer, details.byteOffset, details.length);
  for (let o = 0; o + 8 <= details.length; o += 8) {
    const duration = dv.getInt32(o, true), status = dv.getInt8(o + 4);
    if (duration <= 0 || status <= 0 || duration % 60 !== 0 || duration / 60 > 1440) continue;
    for (let i = 0; i < duration / 60; i++) stages.push(status);
  }
  return { start, stages };
}

export interface D2NightData {
  summary: D2Summary;
  /** Start of the stage list, seconds since 1970 (bed time, or the minute sleep started). */
  start: number;
  /** One watch stage code per minute (see STAGE_CODES). */
  stages: number[];
  recordStart: number;
  recordEnd: number;
}

/** Reads a downloaded sleep file into nights. Unknown or damaged records are skipped. */
export function parseSleepFile(data: Uint8Array): D2NightData[] {
  if (data.length < 32) return [];
  const dv = new DataView(data.buffer, data.byteOffset, data.length);
  const fileType = dv.getUint16(8);
  const nights: D2NightData[] = [];
  let o = 32; // dataSize(4) dictId(4) fileType(2) fileVersion(2) extra(20)
  while (data.length - o >= 32) {
    const recordStart = dv.getInt32(o), recordEnd = dv.getInt32(o + 4);
    const version = dv.getInt8(o + 8), summaryType = dv.getInt8(o + 9);
    const summaryLen = dv.getInt16(o + 10), detailLen = dv.getInt32(o + 12);
    o += 32; // + 16 spare bytes
    let summary: Uint8Array | null = null, details: Uint8Array | null = null;
    if (version === 1 && summaryLen > 0 && data.length - o >= summaryLen) { summary = data.slice(o, o + summaryLen); o += summaryLen; }
    if (detailLen > 0 && detailLen <= 20 * 1025 * 1024) {
      if (data.length - o < detailLen) break; // truncated file
      details = data.slice(o, o + detailLen);
      o += detailLen;
    }
    if (!summary || summaryType !== 2 || fileType === 2) continue;
    const s = parseSummary(summary);
    if (s.fallAsleepTime == null && s.bedTime == null) continue;
    const t = s.validData == null || s.bedTime == null ? (s.fallAsleepTime ?? 0) : s.bedTime;
    const start = t - (t % 60);
    nights.push({ summary: s, ...parseStages(details ?? new Uint8Array(0), start), recordStart, recordEnd });
  }
  return nights;
}
