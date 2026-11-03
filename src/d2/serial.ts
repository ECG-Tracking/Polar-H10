// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — the connection to the watch: Chrome's Web Serial API over classic Bluetooth (RFCOMM).
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

import type { Transport } from './link';

/** The watch's Bluetooth serial service (from Gadgetbridge's watch constants). */
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
 * 'bluetooth': Chrome connects to the watch's data service itself. 'system': any serial port, including the one the
 * computer made for the watch (on a Mac a /dev/cu.… port with the watch's name), for when Chrome's own connection times out.
 */
export async function openWatch(mode: 'bluetooth' | 'system' = 'bluetooth', log: (line: string) => void = () => {}): Promise<Transport> {
  const s = serial();
  if (!s) throw new Error('This browser cannot reach the watch. Use Chrome on an Android phone or on a computer.');
  const port = await s.requestPort(mode === 'bluetooth'
    ? { filters: [{ bluetoothServiceClassId: D2_SERVICE }], allowedBluetoothServiceClassIds: [D2_SERVICE] }
    : { allowedBluetoothServiceClassIds: [D2_SERVICE] });
  const id = port.getInfo().bluetoothServiceClassId;
  log(`Chosen port: ${id ? `Bluetooth service ${id}` : 'a serial port of this computer'}`);
  try {
    await port.open({ baudRate: 115200 }).catch(async (e: unknown) => {
      // still open from an earlier attempt: close it and try once more
      if (!(e instanceof Error && /already open/i.test(e.message))) throw e;
      await port.close().catch(() => undefined);
      await port.open({ baudRate: 115200 });
    }); // the rate is ignored for Bluetooth
  } catch (e) {
    throw new Error(mode === 'bluetooth'
      ? `Chrome could not open the watch’s connection (${e instanceof Error ? e.message : String(e)}). Try “Use the computer’s serial port” instead.`
      : `This serial port could not be opened (${e instanceof Error ? e.message : String(e)}).`);
  }
  const writer = port.writable?.getWriter();
  const reader = port.readable?.getReader();
  if (!writer || !reader) throw new Error('The watch connection could not be opened.');

  let open = true;
  // releases everything so the port can be opened again (after a disconnect as well as on close)
  const shutdown = async (): Promise<void> => {
    if (!open) return;
    open = false;
    await reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* already released */ }
    await writer.close().catch(() => undefined);
    try { writer.releaseLock(); } catch { /* already released */ }
    await port.close().catch(() => undefined);
  };
  const t: Transport = {
    onData: null,
    onClose: null,
    send: async (data) => { await writer.write(data); },
    close: shutdown,
  };
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) t.onData?.(value);
      }
    } catch { /* disconnected */ }
    if (open) { await shutdown(); t.onClose?.(); }
  })();
  return t;
}

export const BRIDGE_URL = 'ws://127.0.0.1:47820';

/**
 * The watch through the D2 Bridge app on a Mac (a separate program, not part of D2 Link): the app opens the watch's data channel with
 * macOS's Bluetooth and passes the bytes over a WebSocket on this Mac. Text messages are its status: "open <name>" or
 * "error <reason>"; everything else is the watch's bytes.
 */
export function openMacBridge(log: (line: string) => void = () => {}, url = BRIDGE_URL): Promise<Transport> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch (e) { reject(new Error(`D2 Bridge can’t be reached (${e instanceof Error ? e.message : String(e)}).`)); return; }
    ws.binaryType = 'arraybuffer';
    let ready = false;
    const fail = (msg: string): void => { if (!ready) { ready = true; clearTimeout(timer); reject(new Error(msg)); } };
    const timer = setTimeout(() => { fail('D2 Bridge didn’t connect to the watch in time. Wake the watch and switch off Bluetooth on the phone it is connected to.'); ws.close(); }, 45000);
    const t: Transport = {
      onData: null,
      onClose: null,
      send: async (data) => { if (ws.readyState !== WebSocket.OPEN) throw new Error('The watch is not connected.'); ws.send(data); },
      close: async () => { ws.close(); },
    };
    ws.onopen = () => log('Connected to D2 Bridge; it is connecting to the watch…');
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === 'string') {
        if (ev.data.startsWith('open')) { log(`D2 Bridge: connected to ${ev.data.slice(5) || 'the watch'}.`); if (!ready) { ready = true; clearTimeout(timer); resolve(t); } }
        else if (ev.data.startsWith('error')) { log(`D2 Bridge: ${ev.data.slice(6)}`); fail(ev.data.slice(6)); }
        return;
      }
      t.onData?.(new Uint8Array(ev.data as ArrayBuffer));
    };
    ws.onerror = () => fail('D2 Bridge isn’t running on this Mac. Press Cmd + Space, type “D2 Bridge” and press Return (it is in the Applications folder inside your home folder), keep its window open, and try again. To have it start with the Mac: System Settings → General → Login Items → Open at Login → +.');
    ws.onclose = () => { fail('D2 Bridge closed the connection.'); t.onClose?.(); };
  });
}
