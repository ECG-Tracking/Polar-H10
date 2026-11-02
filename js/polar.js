// Polar H10 over Web Bluetooth: standard Heart Rate service + Polar PMD raw ECG stream.

const PMD_SERVICE = 'fb005c80-02e7-f387-1cad-8acd2d8df0c8';
const PMD_CONTROL = 'fb005c81-02e7-f387-1cad-8acd2d8df0c8';
const PMD_DATA = 'fb005c82-02e7-f387-1cad-8acd2d8df0c8';

// Start ECG: op 0x02, type 0x00 (ECG), setting 0x00 (rate) = 130 Hz, setting 0x01 (resolution) = 14 bit
const START_ECG = new Uint8Array([0x02, 0x00, 0x00, 0x01, 0x82, 0x00, 0x01, 0x01, 0x0e, 0x00]);
const STOP_ECG = new Uint8Array([0x03, 0x00]);

// PMD control point error codes
const PMD_ERRORS = {
  1: 'invalid op code', 2: 'invalid measurement type', 3: 'not supported', 4: 'invalid length',
  5: 'invalid parameter', 6: 'already running', 7: 'invalid resolution', 8: 'invalid sample rate',
  9: 'invalid range', 10: 'invalid MTU', 11: 'invalid number of channels', 12: 'invalid state',
  13: 'sensor is charging',
};

export const ECG_FS = 130;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function bluetoothAvailable() {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

/**
 * Events:
 *  'ecg'        detail: { samples: Int32Array (µV) }
 *  'hr'         detail: { hr, rr: number[] (ms) }
 *  'battery'    detail: { level }
 *  'disconnect'
 */
export class PolarH10 extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.control = null;
    this.name = '';
    this.ecgOk = false;
    this.ecgPackets = 0;
    this._reply = null;
  }

  /** Connects and starts streaming. `log` receives progress lines. Returns { ecg: boolean, reason? }. */
  async connect(log = () => {}) {
    log('Waiting for you to choose the strap and click Pair…');
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'Polar H10' }],
      optionalServices: [PMD_SERVICE, 'heart_rate', 'battery_service'],
    });
    this.name = this.device.name || 'Polar H10';
    log(`Selected ${this.name}`);
    this.device.addEventListener('gattserverdisconnected', () => {
      this.dispatchEvent(new Event('disconnect'));
    });

    let server;
    for (let attempt = 1; ; attempt++) {
      try {
        log(attempt === 1 ? 'Connecting…' : `Connecting (attempt ${attempt})…`);
        // on macOS gatt.connect() can hang without ever settling, so give each attempt a deadline
        server = await Promise.race([
          this.device.gatt.connect(),
          sleep(10000).then(() => { throw new Error('timed out after 10 s'); }),
        ]);
        break;
      } catch (err) {
        log(`Connect failed: ${err.message}`);
        if (this.device.gatt.connected) this.device.gatt.disconnect();
        if (attempt >= 3) {
          throw new Error(`${err.message}. Try: forget the H10 in macOS Bluetooth settings, close Polar apps on your phone, then reconnect`);
        }
        await sleep(1500);
      }
    }
    await sleep(300); // macOS sometimes needs a moment before service discovery

    log('Connected. Starting heart rate…');
    const hrService = await server.getPrimaryService('heart_rate');
    const hrChar = await hrService.getCharacteristic('heart_rate_measurement');
    hrChar.addEventListener('characteristicvaluechanged', (e) => this._onHeartRate(e.target.value));
    await hrChar.startNotifications();
    log('Heart rate OK');

    try {
      const bat = await server.getPrimaryService('battery_service');
      const level = await bat.getCharacteristic('battery_level');
      const v = await level.readValue();
      this.dispatchEvent(new CustomEvent('battery', { detail: { level: v.getUint8(0) } }));
      log(`Battery ${v.getUint8(0)}%`);
    } catch {
      log('Battery level not available');
    }

    try {
      await this._startEcg(server, log);
      this.ecgOk = true;
      return { ecg: true };
    } catch (err) {
      log(`ECG stream failed: ${err.message}`);
      log('Continuing with heart rate only');
      return { ecg: false, reason: err.message };
    }
  }

  async _startEcg(server, log) {
    log('Starting ECG stream…');
    const pmd = await server.getPrimaryService(PMD_SERVICE);
    this.control = await pmd.getCharacteristic(PMD_CONTROL);
    const data = await pmd.getCharacteristic(PMD_DATA);
    this.control.addEventListener('characteristicvaluechanged', (e) => this._onControl(e.target.value));
    // Indications on the control point must be enabled before commands are accepted.
    await this.control.startNotifications();
    data.addEventListener('characteristicvaluechanged', (e) => this._onPmd(e.target.value));
    await data.startNotifications();

    // a stream left running by an earlier session makes the start command fail
    await this._command(STOP_ECG, 1500).catch(() => {});
    const reply = await this._command(START_ECG, 3000);
    if (!reply) {
      log('No reply to the start command; waiting for data…');
    } else if (reply.status !== 0 && reply.status !== 6) {
      throw new Error(`H10 refused: ${PMD_ERRORS[reply.status] || `code ${reply.status}`}`);
    }
    for (let i = 0; i < 25 && !this.ecgPackets; i++) await sleep(200);
    if (!this.ecgPackets) throw new Error('no ECG data received (is the strap worn with wet electrodes?)');
    log('ECG streaming');
  }

  /** Writes a control point command and resolves with its reply, or null on timeout. */
  async _command(bytes, timeoutMs) {
    const wait = new Promise((resolve) => {
      this._reply = resolve;
      setTimeout(() => resolve(null), timeoutMs);
    });
    if (this.control.writeValueWithResponse) await this.control.writeValueWithResponse(bytes);
    else await this.control.writeValue(bytes);
    const reply = await wait;
    this._reply = null;
    return reply;
  }

  async disconnect() {
    try {
      if (this.control && this.device?.gatt?.connected) await this.control.writeValueWithResponse(STOP_ECG);
    } catch {
      // device may already be gone
    }
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
  }

  _onControl(dv) {
    // reply: 0xF0, op code, measurement type, status, ...
    if (dv.byteLength < 4 || dv.getUint8(0) !== 0xf0) return;
    this._reply?.({ op: dv.getUint8(1), status: dv.getUint8(3) });
  }

  _onHeartRate(dv) {
    const flags = dv.getUint8(0);
    let i = 1;
    let hr;
    if (flags & 0x01) { hr = dv.getUint16(i, true); i += 2; } else { hr = dv.getUint8(i); i += 1; }
    if (flags & 0x08) i += 2; // energy expended
    const rr = [];
    if (flags & 0x10) {
      for (; i + 1 < dv.byteLength; i += 2) rr.push((dv.getUint16(i, true) / 1024) * 1000);
    }
    this.dispatchEvent(new CustomEvent('hr', { detail: { hr, rr } }));
  }

  _onPmd(dv) {
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
    this.dispatchEvent(new CustomEvent('ecg', { detail: { samples } }));
  }
}
