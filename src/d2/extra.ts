// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — everything else the watch keeps besides sleep: activity per minute, today's totals, measurements kept by
// the watch's data dictionary (blood pressure, HRV, emotion), stress and workouts. (ECG recordings are not downloaded.)
// Ported from Gadgetbridge's fitness data, data dictionary sync, stress and workout code
// (https://codeberg.org/Freeyourgadget/Gadgetbridge), © Gadgetbridge contributors.
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

import { concat, fromUtf8, readUint, u64 } from './bytes';
import { HEALTH_APP_ID, WatchError, type D2Link, type Log } from './link';
import type { InPacket } from './packet';
import { Tlv } from './tlv';

const FITNESS = 0x07;
const WORKOUT = 0x17;
const P2P = 0x34;

/** Every item with this tag, read as nested fields. */
const objects = (t: Tlv, tag: number): Tlv[] => t.items.filter((i) => i.tag === tag).map((i) => Tlv.parse(i.value));
const sint = (v: number, bits: number): number => (v >= 2 ** (bits - 1) ? v - 2 ** bits : v);

// ---------- activity per minute ----------

/** One minute of activity; null where the watch didn't measure it. */
export interface ActivityMinute {
  t: number; // seconds since 1970
  // `kcal` is as the watch sends it: in calories (1/1000 kcal), e.g. 165 246 in a day = 165 kcal. Distance in metres.
  steps: number | null; kcal: number | null; distance: number | null;
  hr: number | null; restingHr: number | null; spo2: number | null;
  /** Values the watch sent whose meaning isn't known yet: "bitmap.bit" → value. */
  other?: Record<string, number>;
}

/** The fields of one minute: a feature bitmap (and a second one if its top bit is set), then each feature's value. */
export function parseActivityMinute(t: number, data: Uint8Array): ActivityMinute | null {
  const m: ActivityMinute = { t, steps: null, kcal: null, distance: null, hr: null, restingHr: null, spo2: null };
  if (!data.length) return null;
  let i = 0;
  const b1 = data[i++] ?? 0;
  const b2 = b1 & 0x80 ? data[i++] : 0;
  if (b2 === undefined) return null;
  const other: Record<string, number> = {};
  for (let bit = 1; bit < 0x80; bit <<= 1) {
    if (!(b1 & bit)) continue;
    const one = bit === 0x20 || bit === 0x40;
    if (data.length < i + (one ? 1 : 2)) return null;
    const v = one ? data[i++]! : (data[i++]! << 8) | data[i++]!;
    if (bit === 0x02) m.steps = v;
    else if (bit === 0x04) m.kcal = v;
    else if (bit === 0x08) m.distance = v;
    else if (bit === 0x40) m.hr = v > 0 && v < 255 ? v : null;
    else other[`1.${bit}`] = v;
  }
  for (let bit = 1; bit < 0x100; bit <<= 1) {
    if (!(b2 & bit)) continue;
    if (data.length < i + 1) return null;
    const v = data[i++]!;
    if (bit === 0x01) m.spo2 = v > 0 && v <= 100 ? v : null;
    else if (bit === 0x02) m.restingHr = v > 0 && v < 255 ? v : null;
    else other[`2.${bit}`] = v;
  }
  if (Object.keys(other).length) m.other = other;
  return m;
}

/** One block of minutes: a start time and, per minute, its offset in minutes and its fields. */
export function parseActivityBlock(t: Tlv): ActivityMinute[] {
  const c = objects(t, 0x81)[0];
  if (!c) return [];
  const base = c.has(0x03) ? c.int(0x03) : 0;
  return objects(c, 0x84).flatMap((s) => {
    const m = parseActivityMinute(base + 60 * sint(s.byte(0x05), 8), s.has(0x06) ? s.bytes(0x06) : new Uint8Array(0));
    return m ? [m] : [];
  });
}

export async function downloadActivity(link: D2Link, start: number, end: number, progress: (done: number, total: number) => void = () => {}): Promise<ActivityMinute[]> {
  const r = await link.request({ service: FITNESS, command: 0x0a, tlv: new Tlv().put(0x81).putInt(0x03, start).putInt(0x04, end) }, 8000, 'the activity request');
  const c = objects(r, 0x81)[0];
  const count = c?.has(0x02) ? c.short(0x02) : 0;
  const out: ActivityMinute[] = [];
  for (let i = 0; i < count; i++) {
    const b = await link.request({ service: FITNESS, command: 0x0b, tlv: new Tlv().putTlv(0x81, new Tlv().putShort(0x02, i)) }, 8000, 'an activity block request');
    out.push(...parseActivityBlock(b));
    progress(i + 1, count);
  }
  // the watch can also return minutes from long before (e.g. from before its clock was set): keep only the period asked for
  return out.filter((m) => m.t >= start - 86400 && m.t <= end + 3600);
}

// ---------- today's totals ----------

export interface ActivityTotals { steps: number; kcal: number; distance: number }

export function parseTotals(t: Tlv): ActivityTotals {
  const totals: ActivityTotals = { steps: 0, kcal: 0, distance: 0 };
  for (const c of objects(t, 0x81).flatMap((x) => objects(x, 0x83))) {
    if (c.has(0x05)) totals.steps += c.asInt(0x05);
    if (c.has(0x06)) totals.kcal += c.asInt(0x06);
    if (c.has(0x07)) totals.distance += c.asInt(0x07);
  }
  return totals;
}

/** Today's totals; null when the watch answers without any (the layout of its answer is then logged, without values). */
export async function downloadTotals(link: D2Link, log: Log): Promise<ActivityTotals | null> {
  const r = await link.request({ service: FITNESS, command: 0x03, tlv: new Tlv().put(0x01) }, 8000, 'the totals request');
  const t = parseTotals(r);
  if (t.steps || t.kcal || t.distance) return t;
  const shape = (x: Tlv): string => x.items.map((i) => (i.tag & 0x80 ? `${i.tag.toString(16)}{${shape(Tlv.parse(i.value))}}` : `${i.tag.toString(16)}:${i.value.length}`)).join(' ');
  try { log(`Totals: the watch’s answer has no totals (fields: ${shape(r)}).`); } catch { log('Totals: the watch’s answer has no totals.'); }
  return null;
}

// ---------- the watch's data dictionary (measurements by kind) ----------

/** Kinds of measurement read from the watch's data dictionary, with the meaning of the fields that are known. */
export const READING_CLASSES: Readonly<Record<number, { name: string; fields: Readonly<Record<number, string>> }>> = {
  // blood pressure fields aren't described by Gadgetbridge; these three were identified from 127 readings of a Watch D2
  10002: { name: 'Blood pressure', fields: { 2006: 'Systolic (mmHg)', 2007: 'Diastolic (mmHg)', 10002537: 'Pulse (bpm)' } },
  500044: { name: 'HRV', fields: { 500044831: 'RMSSD (ms)' } },
  500031: { name: 'Emotion', fields: { 500031195: 'Status', 500031347: 'Valence', 500031160: 'Original status', 500031842: 'Arousal' } },
};

/** Kinds no longer read or shown (altitude, skin temperature, sleep apnoea, arterial stiffness, altitude sickness): stored ones are deleted. */
export const DROPPED_CLASSES: readonly number[] = [200003, 400012, 500002, 400017, 500006];

export interface Reading {
  cls: number;
  start: number; end: number | null; modified: number | null; // ms since 1970
  /** Number fields: dictionary field id → value. */
  values: Record<string, number>;
  /** Text fields: dictionary field id → text. */
  texts: Record<string, string>;
}

/** The answer to one dictionary request: records, each with a time and fields (numbers as doubles, or text). */
export function parseReadings(cls: number, t: Tlv): Reading[] {
  const out: Reading[] = [];
  for (const block of objects(t, 0x83)) {
    for (const r of objects(block, 0x84)) {
      if (!r.has(0x05)) continue;
      const reading: Reading = { cls, start: readUint(r.bytes(0x05)), end: r.has(0x06) ? readUint(r.bytes(0x06)) : null, modified: r.has(0x0c) ? readUint(r.bytes(0x0c)) : null, values: {}, texts: {} };
      for (const v of objects(r, 0x87).flatMap((x) => objects(x, 0x88))) {
        if (!v.has(0x09)) continue;
        const field = String(v.asInt(0x09));
        const num = v.maybeBytes(0x0a), text = v.maybeBytes(0x0b);
        if (num && num.length === 8) {
          const x = new DataView(num.buffer, num.byteOffset, 8).getFloat64(0);
          if (Number.isFinite(x)) reading.values[field] = x;
        } else if (num && num.length > 0 && num.length <= 4) reading.values[field] = readUint(num);
        if (text) reading.texts[field] = fromUtf8(text);
      }
      out.push(reading);
    }
  }
  return out;
}

/** A dictionary class as the watch expects it: as few big-endian bytes as needed. */
export function classBytes(v: number): Uint8Array {
  const out: number[] = [];
  do { out.unshift(v & 0xff); v = Math.floor(v / 256); } while (v > 0);
  return Uint8Array.from(out);
}

// the names the watch expects for the two sides of its data sync service (protocol constants, not shown to users)
const PING_FROM = HEALTH_APP_ID, SYNC_FROM = 'hw.unitedevice.datadictionarysync', SYNC_TO = 'hw.watch.health.filesync';

interface P2PMessage { cmd: number; seq: number; from: string; to: string; data: Uint8Array | null; code: number | null }

function readP2P(p: InPacket): P2PMessage | null {
  const t = p.tlv;
  if (!t || !t.has(0x01) || !t.has(0x02)) return null;
  return {
    cmd: t.byte(0x01), seq: t.short(0x02), from: t.has(0x03) ? t.string(0x03) : '', to: t.has(0x04) ? t.string(0x04) : '',
    data: t.maybeBytes(0x07), code: t.has(0x08) ? t.asInt(0x08) : null,
  };
}

/** Talks to the watch's data sync service: one request out, the watch's data comes back as a separate message. */
class DictionarySync {
  private seq = 1;
  private replies = new Map<number, (m: P2PMessage) => void>();
  private data: ((d: Uint8Array) => void) | null = null;
  private readonly onPacket: (p: InPacket) => void;

  constructor(private readonly link: D2Link, private readonly log: Log) {
    this.onPacket = (p) => {
      if (p.service !== P2P || p.command !== 0x01) return;
      const m = readP2P(p);
      if (!m) return;
      const waiting = this.replies.get(m.seq);
      if (waiting && m.cmd !== 2) { this.replies.delete(m.seq); waiting(m); return; }
      if (m.cmd === 2) {
        // acknowledge, as the phone app does, then hand the data on
        void this.packet(3, m.seq, m.to, m.from, null, null, 0xcf).catch(() => undefined);
        if (m.data) this.data?.(m.data);
      }
    };
    link.listeners.add(this.onPacket);
  }

  close(): void { this.link.listeners.delete(this.onPacket); }

  private packet(cmd: number, seq: number, from: string, to: string, fingerprints: [string, string] | null, data: Uint8Array | null, code: number | null = null): Promise<void> {
    const t = new Tlv().putByte(0x01, cmd).putShort(0x02, seq).putString(0x03, from).putString(0x04, to);
    if (fingerprints) t.putString(0x05, fingerprints[0]).putString(0x06, fingerprints[1]);
    if (data?.length) t.put(0x07, data);
    if (code != null) t.putInt(0x08, code);
    return this.link.send({ service: P2P, command: 0x01, tlv: t });
  }

  private next(): number { this.seq = (this.seq % 32000) + 1; return this.seq; }

  /** True if the watch's data sync service answers. */
  async ping(): Promise<boolean> {
    const seq = this.next();
    const reply = new Promise<P2PMessage | null>((resolve) => {
      const timer = setTimeout(() => { this.replies.delete(seq); resolve(null); }, 5000);
      this.replies.set(seq, (m) => { clearTimeout(timer); resolve(m); });
    });
    await this.packet(1, seq, PING_FROM, SYNC_TO, null, null);
    const m = await reply;
    return m?.code === 0xca;
  }

  /** One page of records of a class from `since` (ms); null if the watch didn't answer. */
  async page(cls: number, since: number): Promise<Reading[] | null> {
    const body = new Tlv().putByte(0x01, 1).put(0x02, classBytes(cls)).put(0x05, u64(since)).put(0x06, u64(Date.now())).putByte(0x0d, 1);
    const got = new Promise<Uint8Array | null>((resolve) => {
      const timer = setTimeout(() => { this.data = null; resolve(null); }, 10000);
      this.data = (d) => {
        if (d[0] !== 1) return;
        const t = Tlv.parse(d, 1);
        if (!t.has(0x02) || t.asInt(0x02) !== cls) return;
        clearTimeout(timer);
        this.data = null;
        resolve(d);
      };
    });
    await this.packet(2, this.next(), SYNC_FROM, SYNC_TO, ['UniteDeviceManagement', 'SystemApp'], concat(Uint8Array.of(1), body.serialize()));
    const d = await got;
    if (!d) return null;
    const t = Tlv.parse(d, 1);
    if (t.has(0x01) && t.asInt(0x01) !== 1) { this.log(`The watch answered ${READING_CLASSES[cls]?.name ?? cls} with an unknown operation.`); return []; }
    return parseReadings(cls, t);
  }
}

/** All records of every known class since `since` (ms). Classes the watch doesn't keep are skipped. */
/** `classes`: only these kinds (default: all in READING_CLASSES). */
export async function downloadReadings(link: D2Link, since: number, log: Log, classes: readonly number[] = Object.keys(READING_CLASSES).map(Number)): Promise<Reading[]> {
  const sync = new DictionarySync(link, log);
  try {
    if (!(await sync.ping())) { log('The watch’s data sync service didn’t answer: no measurements read.'); return []; }
    const out: Reading[] = [];
    for (const cls of classes) {
      let from = since, pages = 0, n = 0;
      for (;;) {
        const page = await sync.page(cls, from);
        if (page === null) { log(`${READING_CLASSES[cls]?.name}: no answer from the watch.`); break; }
        if (!page.length) break;
        out.push(...page);
        n += page.length;
        const last = Math.max(...page.map((r) => Math.max(r.start, r.end ?? 0, r.modified ?? 0)));
        if (++pages >= 50 || last < from) break;
        from = last + 1000; // the phone app asks again from just after the newest record
      }
      if (n) log(`${READING_CLASSES[cls]?.name}: ${n} record${n === 1 ? '' : 's'}.`);
    }
    return out;
  } finally {
    sync.close();
  }
}

// ---------- stress (file rrisqi_data.bin) ----------

export interface StressRecord { start: number; end: number; algorithm: number; score: number; level: number; cFlag: number; type: number; accFlag: number; ppgFlag: number; features: number[] }

/** Version 3 files: a 48-byte header, then 66-byte entries (times in seconds; 12 float features). */
export function parseStressFile(b: Uint8Array): StressRecord[] {
  if (b.length < 48) return [];
  const dv = new DataView(b.buffer, b.byteOffset, b.length);
  if (dv.getUint16(10) !== 3) return [];
  const out: StressRecord[] = [];
  for (let o = 48; o + 66 <= b.length; o += 66) {
    const start = dv.getUint32(o), end = dv.getUint32(o + 4);
    if (!start || !end) continue;
    const features = Array.from({ length: 12 }, (_, i) => dv.getFloat32(o + 18 + 4 * i));
    out.push({
      start: start * 1000, end: end * 1000, algorithm: dv.getInt32(o + 8), score: dv.getInt8(o + 12), level: dv.getInt8(o + 13),
      cFlag: dv.getInt8(o + 14), type: dv.getInt8(o + 15), accFlag: dv.getInt8(o + 16), ppgFlag: dv.getInt8(o + 17),
      features: features.map((f) => (Number.isFinite(f) ? f : 0)),
    });
  }
  return out.sort((a, b2) => a.end - b2.end);
}

// ---------- ECG recordings (file ecg_analysis_data.bin) ----------

export interface EcgRecording {
  start: number; end: number; // ms since 1970
  avgHr: number;
  /** The watch's codes for its arrhythmia result and the symptoms the user chose. */
  arrhythmia: number; symptoms: number;
  appVersion: string;
  /** The ECG as the watch stores it (32-bit floats). */
  samples: number[];
}

/** Version 0 files: a 32-byte header and a package name, then recordings (56-byte header + samples). */
export function parseEcgFile(b: Uint8Array, now = Date.now()): EcgRecording[] {
  if (b.length < 32) return [];
  const dv = new DataView(b.buffer, b.byteOffset, b.length);
  if (dv.getUint16(6) !== 0) return [];
  let o = 32 + (b[8] ?? 0);
  const out: EcgRecording[] = [];
  while (b.length - o >= 56) {
    const start = dv.getUint32(o) * 1000, end = dv.getUint32(o + 4) * 1000;
    let len = dv.getUint32(o + 8);
    if (len > 2400000) len = 0;
    if (start <= 0 || end < start || end > now) break; // damaged or not a recording: stop, as Gadgetbridge does
    const appVersion = fromUtf8(b.slice(o + 12, o + 44)).replace(/\0/g, '').trim();
    const arrhythmia = dv.getUint32(o + 44), avgHr = dv.getUint16(o + 48), symptoms = dv.getUint32(o + 52);
    o += 56;
    if (b.length - o < len) break;
    const samples: number[] = [];
    for (let i = 0; i + 4 <= len; i += 4) { const v = dv.getFloat32(o + i); samples.push(Number.isFinite(v) ? v : 0); }
    o += len;
    out.push({ start, end, avgHr, arrhythmia, symptoms, appVersion, samples });
  }
  return out;
}

// ---------- workouts ----------

export const WORKOUT_TYPES: Readonly<Record<number, string>> = {
  1: 'Running', 2: 'Walking', 3: 'Cycling', 4: 'Mountain hike', 5: 'Indoor run', 6: 'Pool swim', 7: 'Indoor cycle', 8: 'Open water swim',
  11: 'Trail run', 13: 'Indoor walk', 14: 'Hiking', 21: 'Jump rope', 134: 'Elliptical', 135: 'Rowing machine', 136: 'Stepper', 137: 'Yoga',
  138: 'Pilates', 139: 'Aerobics', 140: 'Strength training', 141: 'Spinning', 143: 'HIIT', 145: 'CrossFit', 146: 'Functional training',
  147: 'Physical training', 157: 'Core training', 166: 'Tai chi', 167: 'Dance', 177: 'Stair climbing', 255: 'Other',
};

/** Summary fields by tag (all numbers); 0x0c (heart-rate peaks) is split into hrMin and hrMax. */
const TOTAL_FIELDS: Readonly<Record<number, string>> = {
  0x03: 'status', 0x06: 'kcal', 0x07: 'distance', 0x08: 'steps', 0x09: 'totalTime', 0x0b: 'elevationGain', 0x0d: 'load',
  0x0e: 'aerobicEffect', 0x10: 'maxMet', 0x11: 'recoveryTime', 0x12: 'duration', 0x14: 'type', 0x15: 'swimType', 0x16: 'strokes',
  0x17: 'avgStrokeRate', 0x18: 'poolLength', 0x19: 'laps', 0x1a: 'avgSwolf', 0x1b: 'elevationLoss', 0x1c: 'maxAltitude',
  0x1d: 'minAltitude', 0x20: 'anaerobicEffect', 0x24: 'hrZoneType', 0x5b: 'longestStreak', 0x5c: 'tripped', 0x5d: 'algType', 0x63: 'trainingPoints',
};

export interface WorkoutSample {
  t: number; // seconds since 1970
  [field: string]: number;
}

export interface Workout {
  number: number;
  start: number; end: number; // ms since 1970
  totals: Record<string, number>;
  /** Extra summary values the watch sends as text (field id → text). */
  texts: Record<string, string>;
  samples: WorkoutSample[];
}

export function parseWorkoutTotals(t: Tlv): Omit<Workout, 'samples'> | null {
  const c = objects(t, 0x81)[0];
  if (!c || t.has(0x7f) || !c.has(0x04) || !c.has(0x05)) return null;
  const totals: Record<string, number> = {};
  for (const [tag, name] of Object.entries(TOTAL_FIELDS)) if (c.has(Number(tag))) totals[name] = readUint(c.bytes(Number(tag)).slice(0, 4));
  for (const k of ['maxAltitude', 'minAltitude', 'elevationGain', 'elevationLoss'] as const) { const v = totals[k]; if (v != null) totals[k] = sint(v, 32); }
  const peaks = c.maybeBytes(0x0c);
  if (peaks && peaks.length >= 2) { totals['hrMin'] = peaks[0]!; totals['hrMax'] = peaks[1]!; }
  const texts: Record<string, string> = {};
  for (const x of objects(c, 0xe7)) if (x.has(0x68) && x.has(0x69)) texts[String(x.asInt(0x68))] = x.string(0x69);
  return { number: c.has(0x02) ? c.short(0x02) : 0, start: c.int(0x04) * 1000, end: c.int(0x05) * 1000, totals, texts };
}

const SAMPLE_FIELDS: readonly (readonly [string, number, boolean])[] = [ // name, bytes, signed
  ['hr', 1, false], ['speed', 2, true], ['stepRate', 1, false], ['swolf', 2, true], ['strokeRate', 2, true], ['altitude', 4, true],
  ['', -1, false], ['kcal', 2, true], ['frequency', 2, true], ['cyclingPower', 2, true],
];
const INNER_FIELDS: readonly (readonly [string, number, number])[] = [ // name, bytes, divide by
  ['cadence', 2, 1], ['stepLength', 2, 1], ['groundContactTime', 2, 1], ['impact', 1, 1], ['swingAngle', 2, 1], ['foreFootLanding', 1, 1],
  ['midFootLanding', 1, 1], ['backFootLanding', 1, 1], ['eversionAngle', 1, 1], ['hangTime', 2, 1], ['impactHangRate', 2, 1], ['rideCadence', 1, 1],
  ['ap', 2, 10], ['vo', 2, 10], ['gtb', 2, 100], ['vr', 2, 10], ['ceiling', 1, 1], ['temp', 1, 1], ['spo2', 1, 1], ['cns', 2, 1],
  ['', 2, 1], ['', 1, 1], ['', 2, 1],
];

/** One block of workout samples: a 14-byte header (start, interval, count, length, bitmap) and fixed-size samples. */
export function parseWorkoutSamples(t: Tlv): WorkoutSample[] {
  const c = objects(t, 0x81)[0];
  if (!c || t.has(0x7f)) return [];
  const head = c.maybeBytes(0x04), data = c.maybeBytes(0x05) ?? new Uint8Array(0);
  if (!head || head.length !== 14) return [];
  const hv = new DataView(head.buffer, head.byteOffset, 14);
  const start = hv.getUint32(4), interval = hv.getUint8(8), count = hv.getUint16(9), length = hv.getUint8(11), bitmap = hv.getUint16(12);
  const innerLength = c.has(0x08) ? c.asInt(0x08) : 0, innerBitmap = c.has(0x09) ? c.asInt(0x09) : 0;
  if (count * length !== data.length) return [];
  const dv = new DataView(data.buffer, data.byteOffset, data.length);
  const read = (o: number, n: number, signed: boolean): number => {
    if (n === 1) return signed ? dv.getInt8(o) : dv.getUint8(o);
    if (n === 2) return signed ? dv.getInt16(o) : dv.getUint16(o);
    return signed ? dv.getInt32(o) : dv.getUint32(o);
  };
  const out: WorkoutSample[] = [];
  let o = 0;
  for (let k = 0; k < count; k++) {
    const s: WorkoutSample = { t: start + interval * k };
    const end = o + length;
    for (let j = 0; j < SAMPLE_FIELDS.length; j++) {
      if (!(bitmap & (1 << j))) continue;
      const [name, n, signed] = SAMPLE_FIELDS[j]!;
      if (n === -1) { // running form and other details: their own bitmap
        let p = o;
        for (let q = 0; q < INNER_FIELDS.length; q++) {
          if (!(innerBitmap & (1 << q))) continue;
          const [iname, bytes, div] = INNER_FIELDS[q]!;
          if (p + bytes > o + innerLength) break;
          if (iname) s[iname] = read(p, bytes, true) / div;
          p += bytes;
        }
        o += innerLength;
        continue;
      }
      if (o + n > end) break;
      if (name) s[name] = read(o, n, signed);
      o += n;
    }
    o = end;
    out.push(s);
  }
  return out;
}

export async function downloadWorkouts(link: D2Link, start: number, end: number, log: Log): Promise<Workout[]> {
  const r = await link.request({ service: WORKOUT, command: 0x07, tlv: new Tlv().putTlv(0x81, new Tlv().putInt(0x03, start).putInt(0x04, end)) }, 8000, 'the workout list request');
  if (r.has(0x7f)) throw new WatchError(`The watch refused the workout list (code ${r.asInt(0x7f)}).`);
  const c = objects(r, 0x81)[0];
  const list = c ? objects(c, 0x85).map((x) => ({ number: x.short(0x06), dataCount: x.has(0x07) ? x.short(0x07) : 0 })) : [];
  const out: Workout[] = [];
  for (const w of list.sort((a, b) => a.number - b.number)) {
    const tot = parseWorkoutTotals(await link.request({ service: WORKOUT, command: 0x08, tlv: new Tlv().putTlv(0x81, new Tlv().putShort(0x02, w.number)) }, 8000, 'a workout summary request'));
    if (!tot) continue;
    const samples: WorkoutSample[] = [];
    for (let k = 0; k < w.dataCount; k++) {
      const d = await link.request({ service: WORKOUT, command: 0x0a, tlv: new Tlv().putTlv(0x81, new Tlv().putShort(0x02, w.number).putShort(0x03, k).put(0x07)) }, 8000, 'a workout data request');
      samples.push(...parseWorkoutSamples(d));
    }
    out.push({ ...tot, samples });
  }
  if (out.length) log(`${out.length} workout${out.length === 1 ? '' : 's'} read.`);
  return out;
}
