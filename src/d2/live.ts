// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — live use of the watch for OpenBeat ECG's synchronised ECG tracking: the watch's 60-second heartbeat test
// (each beat-to-beat interval as it is measured, with its signal quality) and blood pressure readings taken on the watch.
// Ported from Gadgetbridge's heartbeat (RRI) test (https://codeberg.org/Freeyourgadget/Gadgetbridge), © Gadgetbridge contributors.
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

import { downloadReadings, parseEcgFile, type EcgRecording } from './extra';
import type { Log } from './link';
import type { InPacket } from './packet';
import { readingRecords } from './records';
import type { Profile } from './setup';
import * as store from './store';
import { Tlv } from './tlv';
import { connectWatch, disconnectWatch, ensureSetUp, logTo, onWatch } from './watch';

const HR_TEST = 0x19;
const ECG_SERVICE = 0x23;
/** The code seen in 23/0d after an ECG finished (and when its screen closed). */
const ECG_DONE = 103;

/** One heartbeat from the watch: the interval since the previous beat (ms) and its signal quality (0 = unusable). */
export interface Beat { rri: number; sqi: number }

/** The watch's heartbeat message: 82 { 83 { 04 interval, 05 quality } … }. */
export function parseBeats(t: Tlv): Beat[] {
  const c = t.items.find((i) => i.tag === 0x82);
  if (!c) return [];
  return Tlv.parse(c.value).items.filter((i) => i.tag === 0x83).flatMap((i) => {
    const b = Tlv.parse(i.value);
    return b.has(0x04) ? [{ rri: b.short(0x04), sqi: b.has(0x05) ? b.sbyte(0x05) : 0 }] : [];
  });
}

export interface BloodPressure { at: number; systolic: number | null; diastolic: number | null; pulse: number | null }

export interface LiveWatch {
  name: string;
  battery: number | null;
  /** Starts the heartbeat test; `onBeats` gets each group of beats as it arrives. */
  startHeartbeats(onBeats: (beats: Beat[]) => void): Promise<void>;
  stopHeartbeats(): Promise<void>;
  /**
   * ECG recordings taken on the watch (its 30-second ECG, a fingertip on the button) that started at or after `sinceMs`,
   * oldest first. Downloaded as the watch's ECG file; the watch can't stream its ECG while measuring.
   */
  ecgSince(sinceMs: number): Promise<EcgRecording[]>;
  /** Blood pressure readings taken on the watch since `sinceMs`, newest last (also saved with D2 Link's data). */
  bloodPressureSince(sinceMs: number): Promise<BloodPressure[]>;
  close(): Promise<void>;
  /** Called when the watch disconnects. */
  onClose: (() => void) | null;
  /**
   * Records every message the watch sends, whatever is running, as one line each: time, service/command and its fields'
   * tags and lengths (never their values). Returns the function that stops it.
   */
  capture(onLine: (line: string) => void): () => void;
  /**
   * The watch's ECG service message 23/0d, seen with code 103 after an ECG finished and again when its screen closed: a
   * cue to look for a new ECG, not proof of one. Returns the function that stops listening.
   */
  onEcgCue(fn: (code: number) => void): () => void;
}

/**
 * Fields whose values a capture shows, per message: protocol numbers only (result codes, package names, the
 * configuration ID and action, small state bytes), never measurements. Paths go through containers, e.g. "83.84.05".
 */
const SHOWN_VALUES: Readonly<Record<string, readonly string[]>> = {
  '19/01': ['7f'], '2c/06': ['7f', '01'], '01/3d': ['01'], '23/0d': ['01'], '1f/01': ['81.02', '81.03'],
  '37/01': ['01', '02', '83.84.05', '83.84.06', '83.84.07'], '37/02': ['01', '02', '83.84.05', '83.84.06'],
  '37/03': ['01', '02', '83.84.05', '83.84.06'], '37/04': ['01', '02', '83.84.05', '83.84.06'],
  '34/01': ['01', '02', '03', '04'],
};

/** A shown value: text when it reads as text, a number up to 4 bytes, else hex (up to 8 bytes). */
export function showValue(v: Uint8Array): string {
  if (v.length >= 3 && v.every((b) => b >= 0x20 && b < 0x7f)) return `"${String.fromCharCode(...v)}"`;
  if (v.length >= 1 && v.length <= 4) return String(v.reduce((n, b) => n * 256 + b, 0));
  if (v.length <= 8) return `0x${Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  return `${v.length} bytes`;
}

/** One received message: "19/05 enc 82[83[04:2 05:1]×3]"; only the fields in SHOWN_VALUES also show "=value". */
export function describePacket(p: Pick<InPacket, 'service' | 'command' | 'tlv' | 'raw' | 'encrypted'>): string {
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  const key = `${hex(p.service)}/${hex(p.command)}`;
  const shown = new Set(SHOWN_VALUES[key] ?? []);
  const fields = (t: Tlv, depth: number, path: string): string => {
    const parts: string[] = [];
    for (const i of t.items) {
      const here = path ? `${path}.${hex(i.tag)}` : hex(i.tag);
      // tags from 0x80 hold further fields: shown one level down, repeats counted
      if (i.tag >= 0x80 && depth < 3) {
        let inner: string;
        try { inner = fields(Tlv.parse(i.value), depth + 1, here); } catch { inner = `${i.value.length} bytes`; }
        const last = parts[parts.length - 1], item = `${hex(i.tag)}[${inner}]`;
        const m = last?.match(/^(.*?)(?:×(\d+))?$/);
        if (m && m[1] === item) parts[parts.length - 1] = `${item}×${Number(m[2] ?? 1) + 1}`;
        else parts.push(item);
      } else parts.push(`${hex(i.tag)}:${i.value.length}${shown.has(here) ? `=${showValue(i.value)}` : ''}`);
    }
    return parts.join(' ');
  };
  return `${key}${p.encrypted ? ' enc' : ''} ${p.tlv ? fields(p.tlv, 0, '') : `raw ${p.raw.length} bytes`}`;
}

export interface LiveOptions {
  account: string; user: number;
  /** 'bluetooth' = Chrome's Bluetooth; 'mac' = the D2 Bridge app on a Mac. */
  via: 'bluetooth' | 'mac';
  profile: Profile | null;
  log: Log;
}

/** The watch live, on the shared connection: connects (pairing first if needed) only if it isn't connected yet. */
export async function connectLive(o: LiveOptions): Promise<LiveWatch> {
  store.useAccount(o.account);
  logTo(o.log);
  const w = await connectWatch(o.account, o.via);
  const link = w.link;
  let onBeats: ((b: Beat[]) => void) | null = null;
  let seen = 0;
  const listen = (p: InPacket): void => {
    if (p.service === HR_TEST && p.command === 0x05 && p.tlv && onBeats) { onBeats(parseBeats(p.tlv)); return; }
    // anything else the watch sends during the test: logged (layout only, no values) to see what it does
    if (seen++ < 12) o.log(`Watch sent ${p.service.toString(16)}/${p.command.toString(16)}${p.tlv ? ` (fields ${p.tlv.items.map((i) => i.tag.toString(16)).join(' ')})` : ` (${p.raw.length} bytes)`}.`);
  };
  const live: LiveWatch = {
    name: w.name, battery: w.battery, onClose: null,
    async startHeartbeats(cb) {
      onBeats = cb;
      link.listeners.add(listen);
      const r = await link.request({ service: HR_TEST, command: 0x01, tlv: new Tlv().putByte(0x01, 3) }, 5000, 'the heartbeat test').catch((e: unknown) => {
        o.log(`Heartbeat test: no confirmation from the watch (${e instanceof Error ? e.message : String(e)}); waiting for beats anyway.`);
        return null;
      });
      const code = r?.has(0x7f) ? r.asInt(0x7f) : null;
      if (code != null && code !== 100000) {
        throw new Error(code === 100004 ? 'the watch refused the heartbeat test (code 100004): enter the watch account ID in D2 Link (“Watch account ID”)' : `the watch refused the heartbeat test (code ${code})`);
      }
    },
    async stopHeartbeats() {
      onBeats = null;
      link.listeners.delete(listen);
      await link.send({ service: HR_TEST, command: 0x01, tlv: new Tlv().putByte(0x01, 4) }).catch(() => undefined);
    },
    async ecgSince(sinceMs) {
      const file = await link.downloadFile({ name: 'ecg_analysis_data.bin', type: 0x18, start: Math.floor(sinceMs / 1000) - 5, end: Math.ceil(Date.now() / 1000) + 5, what: 'ECG' });
      return parseEcgFile(file).filter((r) => r.start >= sinceMs && r.samples.length > 0).sort((a, b) => a.start - b.start);
    },
    async bloodPressureSince(sinceMs) {
      const rs = (await downloadReadings(link, sinceMs, o.log, [10002])).filter((r) => r.start >= sinceMs);
      if (rs.length) await store.saveRecords(readingRecords(rs, o.user, live.name));
      return rs.sort((a, b) => a.start - b.start).map((r) => ({
        at: r.start, systolic: r.values['2006'] ?? null, diastolic: r.values['2007'] ?? null, pulse: r.values['10002537'] ?? null,
      }));
    },
    async close() { await disconnectWatch(); },
    onEcgCue(fn) {
      const cue = (p: InPacket): void => {
        if (p.service !== ECG_SERVICE || p.command !== 0x0d) return;
        const code = p.tlv?.has(0x01) ? p.tlv.byte(0x01) : -1;
        if (code === ECG_DONE) fn(code); else o.log(`The watch sent ECG message 23/0d with code ${code} (not ${ECG_DONE}): no check started.`);
      };
      link.listeners.add(cue);
      return () => { link.listeners.delete(cue); };
    },
    capture(onLine) {
      const t = (): string => { const d = new Date(); return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`; };
      const fn = (p: InPacket): void => onLine(`${t()}  ${describePacket(p)}`);
      link.listeners.add(fn);
      return () => { link.listeners.delete(fn); };
    },
  };
  let gone = false;
  onWatch((now) => { if (now?.link !== link && !gone) { gone = true; live.onClose?.(); } });
  await ensureSetUp(w, o.profile);
  return live;
}
