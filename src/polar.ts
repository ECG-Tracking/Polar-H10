// Polar H10 over Web Bluetooth: standard Heart Rate service + Polar PMD raw ECG and accelerometer streams.

import { errorMessage, sleep } from './util';

const PMD_SERVICE = 'fb005c80-02e7-f387-1cad-8acd2d8df0c8';
const PMD_CONTROL = 'fb005c81-02e7-f387-1cad-8acd2d8df0c8';
const PMD_DATA = 'fb005c82-02e7-f387-1cad-8acd2d8df0c8';

// Start ECG: op 0x02, type 0x00 (ECG), setting 0x00 (rate) = 130 Hz, setting 0x01 (resolution) = 14 bit
const START_ECG = new Uint8Array([0x02, 0x00, 0x00, 0x01, 0x82, 0x00, 0x01, 0x01, 0x0e, 0x00]);
const STOP_ECG = new Uint8Array([0x03, 0x00]);
// Start accelerometer: type 0x02, rate 25 Hz, resolution 16 bit, range 8 g (samples in mG)
const START_ACC = new Uint8Array([0x02, 0x02, 0x00, 0x01, 0x19, 0x00, 0x01, 0x01, 0x10, 0x00, 0x02, 0x01, 0x08, 0x00]);
const STOP_ACC = new Uint8Array([0x03, 0x02]);

// PMD control point error codes
const PMD_ERRORS: Readonly<Record<number, string>> = {
  1: 'invalid op code', 2: 'invalid measurement type', 3: 'not supported', 4: 'invalid length',
  5: 'invalid parameter', 6: 'already running', 7: 'invalid resolution', 8: 'invalid sample rate',
  9: 'invalid range', 10: 'invalid MTU', 11: 'invalid number of channels', 12: 'invalid state',
  13: 'sensor is charging',
};

export const ECG_FS = 130;
export const ACC_FS = 25;

/** µV. After lost packets, `samples` starts with `gap` zero samples ("no signal"), so the ECG keeps its true timing. */
export interface EcgDetail { samples: Int32Array; gap?: number }
export interface AccDetail { samples: Int16Array } // x, y, z interleaved, mG
export interface HrDetail { hr: number; rr: number[] } // rr in ms
export interface BatteryDetail { level: number }
export type ConnectResult = { ecg: true } | { ecg: false; reason: string };
type Log = (line: string) => void;
interface ControlReply { op: number; status: number }

/** Which streams a connection should run. Heart rate is always on. */
export interface StreamOptions { ecg?: boolean; acc?: boolean }

export function bluetoothAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

/** DataView carried by a characteristicvaluechanged event, if any. */
function eventValue(e: Event): DataView | undefined {
  return (e.target as BluetoothRemoteGATTCharacteristic | null)?.value;
}

/**
 * Events:
 *  'ecg'        CustomEvent<EcgDetail>
 *  'acc'        CustomEvent<AccDetail>
 *  'hr'         CustomEvent<HrDetail>
 *  'battery'    CustomEvent<BatteryDetail>
 *  'disconnect'
 */
export class PolarH10 extends EventTarget {
  device: BluetoothDevice | null = null;
  name = '';
  ecgOk = false;
  accOk = false;
  private wanted: Required<StreamOptions> = { ecg: true, acc: false };
  private control: BluetoothRemoteGATTCharacteristic | null = null;
  private ecgPackets = 0;
  /** The strap's time of the last ECG sample received (ns), to notice lost packets. */
  private lastEcgNs: bigint | null = null;
  private accPackets = 0;
  private reply: ((r: ControlReply | null) => void) | null = null;

  /** Asks the user to choose the strap, connects and starts streaming. `log` receives progress lines. */
  async connect(log: Log = () => {}, streams: StreamOptions = {}): Promise<ConnectResult> {
    this.wanted = { ecg: streams.ecg ?? true, acc: streams.acc ?? false };
    log('Waiting for you to choose the strap and click Pair…');
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'Polar H10' }],
      optionalServices: [PMD_SERVICE, 'heart_rate', 'battery_service'],
    });
    this.device = device;
    this.name = device.name || 'Polar H10';
    log(`Selected ${this.name}`);
    device.addEventListener('gattserverdisconnected', () => {
      this.dispatchEvent(new Event('disconnect'));
    });
    return this.open(log);
  }

  /** Reconnects to the same strap without asking again (e.g. after it dropped out overnight). */
  async reconnect(log: Log = () => {}): Promise<ConnectResult> {
    if (!this.device) throw new Error('no strap chosen yet');
    return this.open(log);
  }

  private async open(log: Log): Promise<ConnectResult> {
    const gatt = this.device?.gatt;
    if (!gatt) throw new Error('this device has no Bluetooth services');
    this.ecgPackets = 0;
    this.accPackets = 0;
    this.ecgOk = false;
    this.accOk = false;

    let server: BluetoothRemoteGATTServer;
    for (let attempt = 1; ; attempt++) {
      try {
        log(attempt === 1 ? 'Connecting…' : `Connecting (attempt ${attempt})…`);
        // on macOS gatt.connect() can hang without ever settling, so give each attempt a deadline
        server = await Promise.race([
          gatt.connect(),
          sleep(10000).then((): never => { throw new Error('timed out after 10 s'); }),
        ]);
        break;
      } catch (err) {
        log(`Connect failed: ${errorMessage(err)}`);
        if (gatt.connected) gatt.disconnect();
        if (attempt >= 3) {
          throw new Error(`${errorMessage(err)}. Try: forget the H10 in macOS Bluetooth settings, close Polar apps on your phone, then reconnect`);
        }
        await sleep(1500);
      }
    }
    await sleep(300); // macOS sometimes needs a moment before service discovery

    log('Connected. Starting heart rate…');
    const hrService = await server.getPrimaryService('heart_rate');
    const hrChar = await hrService.getCharacteristic('heart_rate_measurement');
    hrChar.addEventListener('characteristicvaluechanged', (e) => {
      const dv = eventValue(e);
      if (dv) this.onHeartRate(dv);
    });
    await hrChar.startNotifications();
    log('Heart rate OK');

    try {
      const bat = await server.getPrimaryService('battery_service');
      const level = await bat.getCharacteristic('battery_level');
      const v = await level.readValue();
      this.dispatchEvent(new CustomEvent<BatteryDetail>('battery', { detail: { level: v.getUint8(0) } }));
      log(`Battery ${v.getUint8(0)}%`);
    } catch {
      log('Battery level not available');
    }

    let ecgFailure = '';
    try {
      await this.openPmd(server);
      if (this.wanted.ecg) {
        try {
          await this.startStream('ECG', START_ECG, STOP_ECG, () => this.ecgPackets, log);
          this.ecgOk = true;
        } catch (err) {
          ecgFailure = errorMessage(err);
          log(`ECG stream failed: ${ecgFailure}`);
        }
      }
      if (this.wanted.acc) {
        try {
          await this.startStream('Motion', START_ACC, STOP_ACC, () => this.accPackets, log);
          this.accOk = true;
        } catch (err) {
          log(`Motion stream failed: ${errorMessage(err)}`);
        }
      }
    } catch (err) {
      ecgFailure = errorMessage(err);
      log(`Polar data service unavailable: ${ecgFailure}`);
    }
    if (this.wanted.ecg && !this.ecgOk) {
      log('Continuing with heart rate only');
      return { ecg: false, reason: ecgFailure || 'ECG did not start' };
    }
    if (!this.wanted.ecg) return { ecg: false, reason: 'not requested' };
    return { ecg: true };
  }

  /** Subscribes to the PMD control point and data characteristics. */
  private async openPmd(server: BluetoothRemoteGATTServer): Promise<void> {
    const pmd = await server.getPrimaryService(PMD_SERVICE);
    const control = await pmd.getCharacteristic(PMD_CONTROL);
    this.control = control;
    const data = await pmd.getCharacteristic(PMD_DATA);
    control.addEventListener('characteristicvaluechanged', (e) => {
      const dv = eventValue(e);
      if (dv) this.onControl(dv);
    });
    // Indications on the control point must be enabled before commands are accepted.
    await control.startNotifications();
    data.addEventListener('characteristicvaluechanged', (e) => {
      const dv = eventValue(e);
      if (dv) this.onPmd(dv);
    });
    await data.startNotifications();
  }

  private async startStream(label: string, start: Uint8Array, stop: Uint8Array, packets: () => number, log: Log): Promise<void> {
    const control = this.control;
    if (!control) throw new Error('Polar data service not open');
    log(`Starting ${label.toLowerCase()} stream…`);
    // a stream left running by an earlier session makes the start command fail
    await this.command(control, stop, 1500).catch(() => null);
    const reply = await this.command(control, start, 3000);
    if (!reply) {
      log(`No reply to the ${label.toLowerCase()} start command; waiting for data…`);
    } else if (reply.status !== 0 && reply.status !== 6) {
      throw new Error(`H10 refused: ${PMD_ERRORS[reply.status] ?? `code ${reply.status}`}`);
    }
    for (let i = 0; i < 25 && !packets(); i++) await sleep(200);
    if (!packets()) throw new Error(`no ${label.toLowerCase()} data received (is the strap worn with wet electrodes?)`);
    log(`${label} streaming`);
  }

  /** Writes a control point command and resolves with its reply, or null on timeout. */
  private async command(control: BluetoothRemoteGATTCharacteristic, bytes: Uint8Array, timeoutMs: number): Promise<ControlReply | null> {
    const wait = new Promise<ControlReply | null>((resolve) => {
      this.reply = resolve;
      setTimeout(() => resolve(null), timeoutMs);
    });
    // older Web Bluetooth implementations (e.g. some iOS browsers) only have writeValue
    if (typeof control.writeValueWithResponse === 'function') await control.writeValueWithResponse(bytes);
    else await control.writeValue(bytes);
    const reply = await wait;
    this.reply = null;
    return reply;
  }

  get connected(): boolean {
    return this.device?.gatt?.connected ?? false;
  }

  async disconnect(): Promise<void> {
    const gatt = this.device?.gatt;
    this.wanted = { ecg: false, acc: false };
    try {
      if (this.control && gatt?.connected) {
        if (this.ecgOk) await this.control.writeValueWithResponse(STOP_ECG);
        if (this.accOk) await this.control.writeValueWithResponse(STOP_ACC);
      }
    } catch {
      // device may already be gone
    }
    if (gatt?.connected) gatt.disconnect();
  }

  private onControl(dv: DataView): void {
    // reply: 0xF0, op code, measurement type, status, ...
    if (dv.byteLength < 4 || dv.getUint8(0) !== 0xf0) return;
    this.reply?.({ op: dv.getUint8(1), status: dv.getUint8(3) });
  }

  private onHeartRate(dv: DataView): void {
    const flags = dv.getUint8(0);
    let i = 1;
    let hr: number;
    if (flags & 0x01) { hr = dv.getUint16(i, true); i += 2; } else { hr = dv.getUint8(i); i += 1; }
    if (flags & 0x08) i += 2; // energy expended
    const rr: number[] = [];
    if (flags & 0x10) {
      for (; i + 1 < dv.byteLength; i += 2) rr.push((dv.getUint16(i, true) / 1024) * 1000);
    }
    this.dispatchEvent(new CustomEvent<HrDetail>('hr', { detail: { hr, rr } }));
  }

  private onPmd(dv: DataView): void {
    // [0] measurement type, [1..8] timestamp (ns), [9] frame type, then little-endian signed samples
    if (dv.byteLength < 10) return;
    const type = dv.getUint8(0), frame = dv.getUint8(9);
    if (type === 0x00 && frame === 0x00) this.onEcg(dv);
    else if (type === 0x02 && frame <= 0x02) this.onAcc(dv, frame + 1); // frame 0/1/2 = 1/2/3 bytes per axis
  }

  private onEcg(dv: DataView): void {
    this.ecgPackets++;
    const n = Math.floor((dv.byteLength - 10) / 3);
    const ns = dv.getBigUint64(1, true); // the time of the packet's last sample
    const gap = this.lastEcgNs == null ? 0 : lostSamples(Number(ns - this.lastEcgNs) / 1e9, n, ECG_FS);
    this.lastEcgNs = ns;
    const samples = new Int32Array(gap + n); // the lost stretch stays as zeros: a flat line, marked as no signal
    for (let k = 0, o = 10; k < n; k++, o += 3) samples[gap + k] = readSigned(dv, o, 3);
    this.dispatchEvent(new CustomEvent<EcgDetail>('ecg', { detail: gap ? { samples, gap } : { samples } }));
  }

  private onAcc(dv: DataView, bytes: number): void {
    this.accPackets++;
    const n = Math.floor((dv.byteLength - 10) / (3 * bytes));
    const samples = new Int16Array(n * 3);
    for (let k = 0, o = 10; k < n * 3; k++, o += bytes) samples[k] = Math.max(-32768, Math.min(32767, readSigned(dv, o, bytes)));
    this.dispatchEvent(new CustomEvent<AccDetail>('acc', { detail: { samples } }));
  }
}

/** Longest stretch of lost ECG kept as a flat line; a longer outage is shortened to this. */
export const MAX_GAP_S = 120;

/**
 * Samples lost before a packet of `n` samples that arrived `dtS` after the previous one (by the strap's own clock).
 * Small differences are clock jitter; a lost packet is about 73 samples.
 */
export function lostSamples(dtS: number, n: number, fs: number): number {
  if (!Number.isFinite(dtS) || dtS <= 0) return 0;
  const missing = Math.round(dtS * fs) - n;
  return missing >= Math.round(0.1 * fs) ? Math.min(missing, MAX_GAP_S * fs) : 0;
}

/** Little-endian signed integer of 1–3 bytes. */
function readSigned(dv: DataView, o: number, bytes: number): number {
  let v = 0;
  for (let b = 0; b < bytes; b++) v |= dv.getUint8(o + b) << (8 * b);
  const sign = 1 << (8 * bytes - 1);
  return v & sign ? v - 2 * sign : v;
}
