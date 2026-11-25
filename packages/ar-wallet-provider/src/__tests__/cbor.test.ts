import { describe, expect, it } from 'vitest';
import { CborError, decodeCbor, decodeCborPrefix } from '../domain/cbor';
import { cbor, cat, enc } from './support/der';

const u = (...n: number[]): Uint8Array => Uint8Array.from(n);

describe('strict CBOR', () => {
  it('round-trips maps, arrays, byte and text strings, negative ints', () => {
    const value = new Map<string | number, never>() as never;
    const m = new Map<string | number, unknown>([
      ['a', 1],
      [-2, u(1, 2)],
      ['t', 'hé'],
      ['l', [1, 2, [3]]],
    ]);
    void value;
    const out = decodeCbor(cbor(m as never)) as Map<string | number, unknown>;
    expect(out.get('a')).toBe(1);
    expect(out.get(-2)).toEqual(u(1, 2));
    expect(out.get('t')).toBe('hé');
    expect(out.get('l')).toEqual([1, 2, [3]]);
  });

  it('refuses indefinite lengths, tags, floats, simple values', () => {
    for (const bytes of [
      u(0x9f, 0xff),
      u(0xbf, 0xff),
      u(0x5f, 0xff),
      u(0xc1, 0x01),
      u(0xf9, 0, 0),
      u(0xf5),
      u(0x1b, 0, 0, 0, 0, 0, 0, 0, 1),
    ]) {
      expect(() => decodeCbor(bytes)).toThrow(CborError);
    }
  });

  it('refuses duplicate keys, bad key types, trailing bytes, truncation', () => {
    expect(() => decodeCbor(u(0xa2, 0x01, 0x01, 0x01, 0x02))).toThrow('cbor_duplicate_key');
    expect(() => decodeCbor(u(0xa1, 0x41, 0x61, 0x01))).toThrow('cbor_bad_key');
    expect(() => decodeCbor(u(0x01, 0x02))).toThrow('cbor_trailing_bytes');
    expect(() => decodeCbor(u(0x43, 1, 2))).toThrow('cbor_truncated');
    expect(() => decodeCbor(u())).toThrow('cbor_truncated');
  });

  it('refuses a declared length that exceeds the input before allocating', () => {
    expect(() => decodeCbor(u(0x5a, 0xff, 0xff, 0xff, 0xff))).toThrow('cbor_truncated');
    expect(() => decodeCbor(u(0x9a, 0xff, 0xff, 0xff, 0xff))).toThrow('cbor_truncated');
  });

  it('refuses invalid UTF-8 and excessive depth or item count', () => {
    expect(() => decodeCbor(u(0x62, 0xc3, 0x28))).toThrow('cbor_invalid_utf8');
    expect(() => decodeCbor(cat(...Array(10).fill(u(0x81)), u(0x01)))).toThrow('cbor_too_deep');
    expect(() => decodeCbor(cat(u(0x99, 0x01, 0x2c), ...Array(300).fill(u(0x01))))).toThrow(
      'cbor_too_many_items'
    );
  });

  it('reads one item of a concatenation and reports its length', () => {
    const first = cbor(new Map([['k', 1]]) as never);
    const { value, length } = decodeCborPrefix(cat(first, enc('rest')));
    expect(length).toBe(first.length);
    expect((value as Map<string, number>).get('k')).toBe(1);
  });
});
