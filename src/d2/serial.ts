// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — the connection to the watch: Chrome's Web Serial API over classic Bluetooth (RFCOMM).
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

import type { Transport } from './link';

/** The watch's Bluetooth serial service (Gadgetbridge: HuaweiConstants.UUID_SERVICE_HUAWEI_SDP). */
export const D2_SERVICE = '82ff3820-8411-400c-b85a-55bdb32cf060';

// the parts of Web Serial used here (not in TypeScript's DOM types yet)
interface SerialPortLike {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  getInfo(): { bluetoothServiceClassId?: string };
}
interface SerialLike {
  requestPort(options: { filters?: { bluetoothServiceClassId: string }[]; allowedBluetoothServiceClassIds?: string[] }): Promise<SerialPortLike>;
}

const serial = (): SerialLike | null => (navigator as unknown as { serial?: SerialLike }).serial ?? null;

export const serialAvailable = (): boolean => serial() !== null;

/**
 * Asks the user to choose the watch (it must already be paired in the computer's Bluetooth settings) and opens it.
 * 'bluetooth': Chrome connects to the watch's Huawei service itself. 'system': any serial port, including the one the
 * computer made for the watch (on a Mac /dev/cu.HUAWEIWATCHD2-…), for when Chrome's own connection times out.
 */
export async function openWatch(mode: 'bluetooth' | 'system' = 'bluetooth', log: (line: string) => void = () => {}): Promise<Transport> {
  const s = serial();
  if (!s) throw new Error('This browser cannot reach classic Bluetooth. Use Chrome (version 117 or later) on a computer.');
  const port = await s.requestPort(mode === 'bluetooth'
    ? { filters: [{ bluetoothServiceClassId: D2_SERVICE }], allowedBluetoothServiceClassIds: [D2_SERVICE] }
    : { allowedBluetoothServiceClassIds: [D2_SERVICE] });
  const id = port.getInfo().bluetoothServiceClassId;
  log(`Chosen port: ${id ? `Bluetooth service ${id}` : 'a serial port of this computer'}`);
  try {
    await port.open({ baudRate: 115200 }); // the rate is ignored for Bluetooth
  } catch (e) {
    throw new Error(mode === 'bluetooth'
      ? `Chrome could not open the watch’s connection (${e instanceof Error ? e.message : String(e)}). Try “Use the computer’s serial port” instead.`
      : `This serial port could not be opened (${e instanceof Error ? e.message : String(e)}).`);
  }
  const writer = port.writable?.getWriter();
  const reader = port.readable?.getReader();
  if (!writer || !reader) throw new Error('The watch connection could not be opened.');

  let open = true;
  const t: Transport = {
    onData: null,
    onClose: null,
    send: async (data) => { await writer.write(data); },
    close: async () => {
      if (!open) return;
      open = false;
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      writer.releaseLock();
      await port.close().catch(() => undefined);
    },
  };
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) t.onData?.(value);
      }
    } catch { /* disconnected */ }
    if (open) { open = false; t.onClose?.(); }
  })();
  return t;
}
