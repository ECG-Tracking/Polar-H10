// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — the set-up messages the phone app sends after logging in, before the watch shares its health data:
// what it supports, the time and time zone, the agreements, account, country and profile.
// Ported from Gadgetbridge's device set-up code (https://codeberg.org/Freeyourgadget/Gadgetbridge), © Gadgetbridge contributors.
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

import { u32 } from './bytes';
import type { D2Link, Log } from './link';
import { Tlv } from './tlv';

const DEVICE = 0x01;

/** Services the phone side knows (asked about with 01/02). */
export const KNOWN_SERVICES = [
  0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14,
  0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1d, 0x20, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x2a, 0x2b, 0x2d, 0x2e,
  0x30, 0x32, 0x33, 0x34, 0x35,
];

/** Commands asked about per service (01/03); the watch answers with one byte per command, 1 = supported. */
export const KNOWN_COMMANDS: Readonly<Record<number, readonly number[]>> = {
  0x01: [0x04, 0x07, 0x08, 0x09, 0x0a, 0x0d, 0x0e, 0x10, 0x11, 0x12, 0x13, 0x14, 0x1b, 0x1a, 0x1d, 0x21, 0x22, 0x23, 0x24, 0x29, 0x2a, 0x2b, 0x32, 0x2e, 0x31, 0x30, 0x35, 0x36, 0x37, 0x2f],
  0x02: [0x01, 0x04, 0x05, 0x06, 0x07, 0x08], 0x03: [0x01, 0x03, 0x04], 0x04: [0x01], 0x05: [0x01], 0x06: [0x01],
  0x07: [0x01, 0x03, 0x05, 0x07, 0x08, 0x09, 0x0a, 0x0e, 0x10, 0x13, 0x16, 0x15, 0x17, 0x18, 0x1b, 0x1c, 0x1d, 0x1e, 0x21, 0x22, 0x23, 0x24, 0x25, 0x28, 0x29, 0x06, 0x1f],
  0x08: [0x01, 0x02, 0x03], 0x09: [0x01, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f], 0x0a: [0x01, 0x09, 0x0a], 0x0b: [0x01, 0x03], 0x0c: [0x01], 0x0d: [0x01],
  0x0f: [0x01, 0x03, 0x05, 0x06, 0x07, 0x08, 0x0a, 0x0b, 0x0c], 0x10: [0x01], 0x11: [0x01], 0x12: [0x01], 0x13: [0x01], 0x14: [0x01], 0x15: [0x01],
  0x16: [0x01, 0x03, 0x07], 0x17: [0x01, 0x04, 0x06, 0x07, 0x0b, 0x0c, 0x10, 0x12, 0x15, 0x17], 0x18: [0x01, 0x02, 0x04, 0x05, 0x06, 0x09],
  0x19: [0x01, 0x04], 0x1a: [0x01, 0x03, 0x07, 0x05, 0x06], 0x1b: [0x01, 0x0f, 0x19, 0x1a], 0x1d: [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a],
  0x20: [0x01, 0x02, 0x03, 0x04, 0x09, 0x0a], 0x22: [0x01], 0x23: [0x02, 0x0b, 0x10], 0x24: [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c],
  0x25: [0x02, 0x04, 0x0e], 0x26: [0x02, 0x03], 0x27: [0x01, 0x0e], 0x2a: [0x01, 0x06], 0x2b: [0x12], 0x2d: [0x01], 0x2e: [0x01, 0x02, 0x03], 0x30: [0x01],
  0x32: [0x01], 0x33: [0x01, 0x02], 0x34: [0x01], 0x35: [0x03, 0x04],
};

/** What the watch said it supports. */
export interface WatchSupport {
  services: Set<number>;
  commands: Map<number, Set<number>>;
  /** The watch's capability bits (01/37), or null if it didn't send them. */
  capabilities: Uint8Array | null;
}

export const supportsCommand = (s: WatchSupport, service: number, command: number): boolean => s.commands.get(service)?.has(command) ?? false;
export function hasCapability(s: WatchSupport, bit: number): boolean | null {
  if (!s.capabilities) return null;
  return bit < s.capabilities.length * 8 && ((s.capabilities[bit >> 3] ?? 0) & (1 << (bit % 8))) !== 0;
}

/** The commands answer: per service its id (02) and one byte per command asked about (04). */
export function parseCommands(t: Tlv, asked: ReadonlyMap<number, readonly number[]>): Map<number, Set<number>> {
  const out = new Map<number, Set<number>>();
  const c = t.items.find((i) => i.tag === 0x81);
  let service: number | null = null;
  for (const item of c ? Tlv.parse(c.value).items : []) {
    if (item.tag === 0x02) service = item.value[0] ?? null;
    else if (item.tag === 0x04 && service != null) {
      const list = asked.get(service) ?? [];
      out.set(service, new Set(list.filter((_, i) => item.value[i] === 1)));
    }
  }
  return out;
}

/** The time with the offset from UTC: seconds since 1970, then hours (+128 if west of UTC) and minutes. */
export function timeFields(now: Date): { seconds: number; offset: number; zone: string } {
  const off = -now.getTimezoneOffset() * 60; // seconds east of UTC
  const hours = off < 0 ? Math.floor(-off / 3600) + 128 : Math.floor(off / 3600);
  const minutes = Math.floor(Math.abs(off) / 60) % 60;
  let zone = 'UTC';
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { /* default */ }
  return { seconds: Math.floor(now.getTime() / 1000), offset: (hours << 8) | minutes, zone };
}

export interface Profile { heightCm: number; weightKg: number; age: number; sex: 'male' | 'female' }

/** The agreements the phone app reports as accepted (as Gadgetbridge sends them). */
export function agreementsTlv(now = Date.now()): Tlv {
  const list = new Tlv();
  for (const name of ['software_update_service_statement', 'device_information_management', 'user_license_agreement']) {
    list.putTlv(0x82, new Tlv().putString(0x03, name).putByte(0x04, 1).putString(0x05, '20230508-20230508-0-0').putString(0x06, String(now)));
  }
  return new Tlv().putTlv(0x81, list);
}

/**
 * Sends the set-up messages and returns what the watch supports. Each step is optional: one the watch refuses or
 * doesn't answer is logged and the next one follows.
 */
export async function setUpWatch(link: D2Link, o: { watchName: string; profile: Profile | null; accountId?: string; log: Log; now?: Date }): Promise<WatchSupport> {
  const { log } = o;
  const support: WatchSupport = { services: new Set(), commands: new Map(), capabilities: null };
  const step = async (what: string, fn: () => Promise<void>): Promise<void> => {
    try { await fn(); } catch (e) { log(`Set-up: ${what} – ${e instanceof Error ? e.message : String(e)}`); }
  };
  const ask = (command: number, tlv: Tlv, what: string, service = DEVICE): Promise<Tlv> => link.request({ service, command, tlv }, 4000, what);
  /** Sends and waits briefly for an answer, which some watches don't send. */
  const tell = async (command: number, tlv: Tlv, what: string, service = DEVICE): Promise<void> => {
    const r = await ask(command, tlv, what, service).catch(() => null);
    if (r?.has(0x7f) && r.asInt(0x7f) !== 100000) log(`Set-up: ${what} – the watch answered code ${r.asInt(0x7f)}.`);
  };

  await step('supported services', async () => {
    const r = await ask(0x02, new Tlv().put(0x01, Uint8Array.from(KNOWN_SERVICES)), 'the supported services request');
    const flags = r.maybeBytes(0x02) ?? new Uint8Array(0);
    support.services.add(DEVICE); // always there
    KNOWN_SERVICES.forEach((s, i) => { if (flags[i] === 1) support.services.add(s); });
  });
  await step('supported commands', async () => {
    let max = link.params.sliceSize - 32;
    max = max - (max % 16) - 4;
    const services = [...support.services].filter((s) => KNOWN_COMMANDS[s]);
    for (let i = 0; i < services.length;) {
      const asked = new Map<number, readonly number[]>(), inner = new Tlv();
      while (i < services.length) {
        const s = services[i]!, cmds = KNOWN_COMMANDS[s]!;
        if (asked.size && inner.serialize().length + cmds.length + 5 > max) break;
        inner.putByte(0x02, s).put(0x03, Uint8Array.from(cmds));
        asked.set(s, cmds);
        i++;
      }
      for (const [s, set] of parseCommands(await ask(0x03, new Tlv().putTlv(0x81, inner), 'the supported commands request'), asked)) support.commands.set(s, set);
    }
  });
  await step('capabilities', async () => { support.capabilities = (await ask(0x37, new Tlv().put(0x01), 'the capabilities request')).maybeBytes(0x01); });

  const t = timeFields(o.now ?? new Date());
  await step('time', () => tell(0x05, new Tlv().putInt(0x01, t.seconds).putShort(0x02, t.offset), 'the time'));
  await step('time zone', () => tell(0x32, new Tlv().putInt(0x01, t.seconds).putShort(0x02, t.offset).putString(0x03, t.zone), 'the time zone'));
  await step('settings', async () => { await ask(0x31, new Tlv().put(1).put(2).put(3).put(4).put(5).put(6), 'the settings request'); });
  await step('agreements', () => tell(0x30, agreementsTlv(), 'the agreements'));
  // the account the watch belongs to: sent only when the user entered its ID (an empty one makes the watch hold back data)
  if (o.accountId && /^\d{5,30}$/.test(o.accountId)) await step('account', () => tell(0x05, new Tlv().putString(0x01, o.accountId!), 'the account', 0x1a));
  else log('Set-up: no watch account ID entered, so the account step is skipped.');
  const region = (typeof navigator === 'undefined' ? '' : navigator.language.split('-')[1] ?? '').toUpperCase();
  if (/^[A-Z]{2}$/.test(region)) await step('country', () => tell(0x0a, new Tlv().putString(0x01, region), 'the country', 0x1a));
  if (hasCapability(support, 109)) await step('main device', () => tell(0x3e, new Tlv().putByte(0x01, 1).putString(0x02, o.watchName).putByte(0x03, 0), 'the device status'));
  const p = o.profile;
  if (p && p.heightCm > 0 && p.weightKg > 0) {
    await step('profile', () => {
      const u = new Tlv().putByte(0x01, Math.round(p.heightCm)).putByte(0x02, Math.round(p.weightKg)).putByte(0x03, Math.max(0, Math.min(120, Math.round(p.age))))
        .putByte(0x05, p.sex === 'female' ? 2 : 1).putByte(0x06, Math.round(0.42 * p.heightCm)).putByte(0x07, Math.round(0.83 * p.heightCm));
      if (hasCapability(support, 0xb3)) u.put(0x0b, u32(Math.round(p.weightKg * 100)));
      return tell(0x02, u, 'the profile', 0x07);
    });
  }

  const yes = (v: boolean | null): string => (v == null ? 'unknown' : v ? 'yes' : 'no');
  log(`Watch supports: ${support.services.size} services; workouts ${yes(supportsCommand(support, 0x17, 0x01))}, stress ${yes(supportsCommand(support, 0x20, 0x09))}, `
    + `data sync ${yes(supportsCommand(support, 0x34, 0x01))}, HRV ${yes(hasCapability(support, 235))}, `
    + `agreements ${yes(supportsCommand(support, 0x01, 0x30))}.`);
  // only asked, never sent: whether the watch has the ECG service (0x23) and its ECG on/off command (0x10), the one
  // ECG command known (Gadgetbridge's SetECGOpen); a first step towards starting the watch's ECG from the app
  log(`Watch ECG: service ${support.services.has(0x23) ? 'yes' : 'no'}, ECG on/off command ${support.services.has(0x23) ? yes(supportsCommand(support, 0x23, 0x10)) : 'no'}.`);
  return support;
}
