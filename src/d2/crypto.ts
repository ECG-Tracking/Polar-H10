// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — the encryption building blocks the watch uses, on the browser's built-in Web Crypto.
// Matches Gadgetbridge's CryptoUtils and HuaweiCrypto (https://codeberg.org/Freeyourgadget/Gadgetbridge), © Gadgetbridge contributors.
// Port © 2026 ECG-Tracking. See LICENSE-D2-LINK.txt.

import { randomBytes } from './bytes';

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;
const out = (b: ArrayBuffer): Uint8Array => new Uint8Array(b);

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return out(await subtle().digest('SHA-256', data));
}

export async function hmacSha256(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return out(await subtle().sign('HMAC', k, message));
}

export async function hkdfSha256(secret: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  return out(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, length * 8));
}

async function aesKey(key: Uint8Array, name: 'AES-CBC' | 'AES-GCM'): Promise<CryptoKey> {
  return subtle().importKey('raw', key, { name }, false, ['encrypt', 'decrypt']);
}

/** AES-CBC with PKCS#7 padding. */
export async function aesCbcEncrypt(data: Uint8Array, key: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
  return out(await subtle().encrypt({ name: 'AES-CBC', iv }, await aesKey(key, 'AES-CBC'), data));
}
export async function aesCbcDecrypt(data: Uint8Array, key: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
  return out(await subtle().decrypt({ name: 'AES-CBC', iv }, await aesKey(key, 'AES-CBC'), data));
}

/** AES-GCM with a 128-bit tag appended to the ciphertext (Java's layout). The IV may be 12 or 16 bytes. */
export async function aesGcmEncrypt(data: Uint8Array, key: Uint8Array, iv: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  const p: AesGcmParams = { name: 'AES-GCM', iv, tagLength: 128, ...(aad ? { additionalData: aad } : {}) };
  return out(await subtle().encrypt(p, await aesKey(key, 'AES-GCM'), data));
}
export async function aesGcmDecrypt(data: Uint8Array, key: Uint8Array, iv: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  const p: AesGcmParams = { name: 'AES-GCM', iv, tagLength: 128, ...(aad ? { additionalData: aad } : {}) };
  return out(await subtle().decrypt(p, await aesKey(key, 'AES-GCM'), data));
}

export async function encrypt(gcm: boolean, data: Uint8Array, key: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
  return gcm ? aesGcmEncrypt(data, key, iv) : aesCbcEncrypt(data, key, iv);
}
export async function decrypt(gcm: boolean, data: Uint8Array, key: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
  return gcm ? aesGcmDecrypt(data, key, iv) : aesCbcDecrypt(data, key, iv);
}

// Fixed secrets from the Huawei protocol; the watch decrypts the pairing PIN with one of them.
const DIGEST_SECRET_V1 = Uint8Array.of(0x70, 0xfb, 0x6c, 0x24, 0x03, 0x5f, 0xdb, 0x55, 0x2f, 0x38, 0x89, 0x8a, 0xee, 0xde, 0x3f, 0x69);
const DIGEST_SECRET_V2 = Uint8Array.of(0x93, 0xac, 0xde, 0xf7, 0x6a, 0xcb, 0x09, 0x85, 0x7d, 0xbf, 0xe5, 0x26, 0x1a, 0xab, 0xcd, 0x78);
const DIGEST_SECRET_V3 = Uint8Array.of(0x9c, 0x27, 0x63, 0xa9, 0xcc, 0xe1, 0x34, 0x76, 0x6d, 0xe3, 0xff, 0x61, 0x18, 0x20, 0x05, 0x53);

export function digestSecret(authVersion: number): Uint8Array {
  if (authVersion === 1 || authVersion === 4) return DIGEST_SECRET_V1;
  if (authVersion === 2) return DIGEST_SECRET_V2;
  return DIGEST_SECRET_V3;
}

/** The IV for an encrypted packet: random for HiChain3 watches, otherwise 12 random bytes plus a counter. */
export function nextIv(state: { deviceSupportType: number; counter: number }): Uint8Array {
  if (state.deviceSupportType === 4) return randomBytes(16);
  state.counter = state.counter >= 0xffffffff ? 1 : state.counter + 1;
  const iv = randomBytes(16);
  new DataView(iv.buffer).setUint32(12, state.counter);
  return iv;
}
