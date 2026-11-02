import { describe, expect, it } from 'vitest';
import {
  decodeStatusListBytes,
  encodeStatusListBytes,
  fromBase64Url,
  readStatusEntry,
  toBase64Url,
  writeStatusEntry,
} from '../status-list-codec';

describe('status list codec', () => {
  it('round-trips a Token Status List through zlib + base64url', async () => {
    const bytes = new Uint8Array(32);
    writeStatusEntry(bytes, 7, 2, 'lsb', 2);
    writeStatusEntry(bytes, 100, 2, 'lsb', 1);
    const encoded = await encodeStatusListBytes(bytes, 'ietf_tsl_v1');

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    // zlib stream (RFC 1950), not gzip
    expect(fromBase64Url(encoded)[0]).toBe(0x78);
    const decoded = await decodeStatusListBytes(encoded, 'ietf_tsl_v1');
    expect(decoded).toEqual(bytes);
    expect(readStatusEntry(decoded, 7, 2, 'lsb')).toBe(2);
    expect(readStatusEntry(decoded, 100, 2, 'lsb')).toBe(1);
    expect(readStatusEntry(decoded, 8, 2, 'lsb')).toBe(0);
  });

  it('round-trips a legacy list through gzip and keeps MSB-first order', async () => {
    const bytes = new Uint8Array(4);
    writeStatusEntry(bytes, 0, 1, 'msb', 1);
    expect(bytes[0]).toBe(0b10000000);
    const encoded = await encodeStatusListBytes(bytes, 'w3c_bitstring_v1');
    expect(fromBase64Url(encoded).slice(0, 2)).toEqual(new Uint8Array([0x1f, 0x8b]));
    expect(await decodeStatusListBytes(encoded, 'w3c_bitstring_v1')).toEqual(bytes);
  });

  it('matches the draft-14 bit layout for hand-computed vectors', () => {
    // bits=2, statuses [1, 2, 0, 3, 3, 0, 2, 1] -> bytes 0b11_00_10_01, 0b01_10_00_11
    const bytes = new Uint8Array([0b11001001, 0b01100011]);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => readStatusEntry(bytes, i, 2, 'lsb'))).toEqual([
      1, 2, 0, 3, 3, 0, 2, 1,
    ]);
    // bits=1: index 0 is the least significant bit of byte 0
    expect(readStatusEntry(new Uint8Array([0b00000001]), 0, 1, 'lsb')).toBe(1);
    expect(readStatusEntry(new Uint8Array([0b00000001]), 7, 1, 'lsb')).toBe(0);
    // bits=4: index 1 is the high nibble
    expect(readStatusEntry(new Uint8Array([0xa5]), 0, 4, 'lsb')).toBe(0x5);
    expect(readStatusEntry(new Uint8Array([0xa5]), 1, 4, 'lsb')).toBe(0xa);
  });

  it('refuses a Token Status List that is not zlib', async () => {
    const gzip = await encodeStatusListBytes(new Uint8Array(8), 'w3c_bitstring_v1');
    await expect(decodeStatusListBytes(gzip, 'ietf_tsl_v1')).rejects.toThrow('compression');
    await expect(
      decodeStatusListBytes(toBase64Url(new Uint8Array([1, 2, 3])), 'ietf_tsl_v1')
    ).rejects.toThrow('compression');
  });

  it('bounds the decompressed size', async () => {
    const encoded = await encodeStatusListBytes(new Uint8Array(4096), 'ietf_tsl_v1');
    await expect(decodeStatusListBytes(encoded, 'ietf_tsl_v1', 1024)).rejects.toThrow(
      'maximum size'
    );
  });

  it('rejects out-of-range indices and oversized values', () => {
    const bytes = new Uint8Array(1);
    expect(() => readStatusEntry(bytes, 4, 2, 'lsb')).toThrow('out of bounds');
    expect(() => writeStatusEntry(bytes, 0, 2, 'lsb', 4)).toThrow('does not fit');
    expect(() => readStatusEntry(bytes, -1, 2, 'lsb')).toThrow();
    expect(() => readStatusEntry(bytes, 0, 3, 'lsb')).toThrow();
  });
});
