// Polar H10 over Web Bluetooth: standard Heart Rate service + Polar PMD raw ECG stream.

import { errorMessage, sleep } from './util';

const PMD_SERVICE = 'fb005c80-02e7-f387-1cad-8acd2d8df0c8';
const PMD_CONTROL = 'fb005c81-02e7-f387-1cad-8acd2d8df0c8';
const PMD_DATA = 'fb005c82-02e7-f387-1cad-8acd2d8df0c8';

// Start ECG: op 0x02, type 0x00 (ECG), setting 0x00 (rate) = 130 Hz, setting 0x01 (resolution) = 14 bit
const START_ECG = new Uint8Array([0x02, 0x00, 0x00, 0x01, 0x82, 0x00, 0x01, 0x01, 0x0e, 0x00]);
const STOP_ECG = new Uint8Array([0x03, 0x00]);

// PMD control point error codes
const PMD_ERRORS: Readonly<Record<number, string>> = {
  1: 'invalid op code', 2: 'invalid measurement type', 3: 'not supported', 4: 'invalid length',
  5: 'invalid parameter', 6: 'already running', 7: 'invalid resolution', 8: 'invalid sample rate',
  9: 'invalid range', 10: 'invalid MTU', 11: 'invalid number of channels', 12: 'invalid state',
  13: 'sensor is charging',
};

export const ECG_FS = 130;

export interface EcgDetail { samples: Int32Array } // µV
export interface HrDetail { hr: number; rr: number[] } // rr in ms
export interface BatteryDetail { level: number }
export type ConnectResult = { ecg: true } | { ecg: false; reason: string };
type Log = (line: string) => void;
interface ControlReply { op: number; status: number }

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
 *  'hr'         CustomEvent<HrDetail>
 *  'battery'    CustomEvent<BatteryDetail>
 *  'disconnect'
 */
export class PolarH10 extends EventTarget {
  device: BluetoothDevice | null = null;
  name = '';
  ecgOk = false;
  private control: BluetoothRemoteGATTCharacteristic | null = null;
  private ecgPackets = 0;
  private reply: ((r: ControlReply | null) => void) | null = null;

  /** Connects and starts streaming. `log` receives progress lines. */
  async connect(log: Log = () => {}): Promise<ConnectResult> {
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
    const gatt = device.gatt;
    if (!gatt) throw new Error('this device has no Bluetooth services');

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

    try {
      await this.startEcg(server, log);
      this.ecgOk = true;
      return { ecg: true };
    } catch (err) {
      log(`ECG stream failed: ${errorMessage(err)}`);
      log('Continuing with heart rate only');
      return { ecg: false, reason: errorMessage(err) };
    }
  }

  private async startEcg(server: BluetoothRemoteGATTServer, log: Log): Promise<void> {
    log('Starting ECG stream…');
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

    // a stream left running by an earlier session makes the start command fail
    await this.command(control, STOP_ECG, 1500).catch(() => null);
    const reply = await this.command(control, START_ECG, 3000);
    if (!reply) {
      log('No reply to the start command; waiting for data…');
    } else if (reply.status !== 0 && reply.status !== 6) {
      throw new Error(`H10 refused: ${PMD_ERRORS[reply.status] ?? `code ${reply.status}`}`);
    }
    for (let i = 0; i < 25 && !this.ecgPackets; i++) await sleep(200);
    if (!this.ecgPackets) throw new Error('no ECG data received (is the strap worn with wet electrodes?)');
    log('ECG streaming');
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

  async disconnect(): Promise<void> {
    const gatt = this.device?.gatt;
    try {
      if (this.control && gatt?.connected) await this.control.writeValueWithResponse(STOP_ECG);
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
    // [0] measurement type, [1..8] timestamp (ns), [9] frame type, then 3-byte signed LE samples (µV)
    if (dv.byteLength < 10 || dv.getUint8(0) !== 0x00 || dv.getUint8(9) !== 0x00) return;
    this.ecgPackets++;
    const n = Math.floor((dv.byteLength - 10) / 3);
    const samples = new Int32Array(n);
    for (let k = 0, o = 10; k < n; k++, o += 3) {
      let v = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);
      if (v & 0x800000) v -= 0x1000000;
      samples[k] = v;
    }
    this.dispatchEvent(new CustomEvent<EcgDetail>('ecg', { detail: { samples } }));
  }
}
