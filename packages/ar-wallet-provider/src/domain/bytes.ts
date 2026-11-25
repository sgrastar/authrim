/**
 * Small byte helpers shared by the domain code. Pure; WebCrypto only (runs on Workers and Node).
 */

export type Bytes = Uint8Array;

export function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function equalBytes(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

export function utf8(text: string): Bytes {
  return Uint8Array.from(new TextEncoder().encode(text));
}

export async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

export function toHex(bytes: Bytes): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function toBase64(bytes: Bytes): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Strict standard base64 (padding required, no whitespace). Returns null on any deviation. */
export function fromBase64(value: string): Bytes | null {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    return null;
  }
  try {
    const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    // Canonical form only: the unused padding bits must be zero, so one byte string has one text.
    return toBase64(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

export function toBase64Url(bytes: Bytes): string {
  return toBase64(bytes).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/** Strict unpadded base64url. Returns null on any deviation. */
export function fromBase64Url(value: string): Bytes | null {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) return null;
  const padded = value.replace(/-/gu, '+').replace(/_/gu, '/');
  return fromBase64(padded + '='.repeat((4 - (padded.length % 4)) % 4));
}

export function readUint32(bytes: Bytes, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

export function fromHex(hex: string): Bytes | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/iu.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1)
    out[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return out;
}
