import { describe, expect, it } from 'vitest';
import { generateCIBAUserCode } from '../ciba';
import { generateUserCode } from '../device-flow';
import { randomCharacters, type RandomBytesSource } from '../unbiased-random';

const USER_CODE_CHARSET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** A byte source that hands out the given values in order, `length` at a time. */
function fixedBytes(values: number[]): RandomBytesSource {
  let position = 0;
  return (length) => {
    const chunk = values.slice(position, position + length);
    position += length;
    if (chunk.length < length) throw new Error('fixed byte source exhausted');
    return Uint8Array.from(chunk);
  };
}

describe('randomCharacters', () => {
  it('rejects the bytes above the largest multiple of the alphabet size', () => {
    // 31 characters: 256 - (256 % 31) = 248, so 248..255 are rejected
    const source = fixedBytes([255, 248, 0, 250, 1, 249, 30, 254, 31, 251, 2, 252, 3, 253, 4]);

    expect(randomCharacters(USER_CODE_CHARSET, 6, source)).toBe(
      [0, 1, 30, 31 % 31, 2, 3].map((index) => USER_CODE_CHARSET[index]).join('')
    );
  });

  it('accepts the largest byte below the limit', () => {
    expect(randomCharacters(USER_CODE_CHARSET, 1, fixedBytes([247]))).toBe(
      USER_CODE_CHARSET[247 % 31]
    );
    // 248 is the first rejected byte; the next byte is used instead
    expect(randomCharacters(USER_CODE_CHARSET, 1, fixedBytes([248, 247]))).toBe(
      USER_CODE_CHARSET[247 % 31]
    );
  });

  it.each([
    ['31 characters', USER_CODE_CHARSET, 248],
    ['20 characters', 'BCDFGHJKLMNPQRSTVWXZ', 240],
    ['10 digits', '0123456789', 250],
  ])('gives every character the same share of all 256 bytes (%s)', (_label, charset, limit) => {
    const allBytes = Array.from({ length: 256 }, (_, value) => value);
    const counts = new Map<string, number>();
    // Feed each byte value once, one character at a time
    for (const byte of allBytes) {
      let character = '';
      try {
        character = randomCharacters(charset, 1, fixedBytes([byte]));
      } catch {
        // rejected: the source had no second byte to offer
        expect(byte).toBeGreaterThanOrEqual(limit);
        continue;
      }
      counts.set(character, (counts.get(character) ?? 0) + 1);
    }

    expect(counts.size).toBe(charset.length);
    expect(new Set(counts.values())).toEqual(new Set([limit / charset.length]));
  });

  it('gives up on a source that only yields rejected bytes', () => {
    expect(() =>
      randomCharacters(USER_CODE_CHARSET, 4, () => Uint8Array.of(255, 255, 255, 255))
    ).toThrow('did not yield usable values');
  });

  it('refuses an alphabet that cannot be mapped evenly', () => {
    expect(() => randomCharacters('', 4)).toThrow(RangeError);
    expect(() => randomCharacters('x'.repeat(257), 4)).toThrow(RangeError);
  });

  it('draws from the Web Crypto generator by default', () => {
    const value = randomCharacters(USER_CODE_CHARSET, 64);

    expect(value).toHaveLength(64);
    expect([...value].every((character) => USER_CODE_CHARSET.includes(character))).toBe(true);
  });
});

describe.each([
  ['generateUserCode', generateUserCode],
  ['generateCIBAUserCode', generateCIBAUserCode],
])('%s', (_name, generate) => {
  it('keeps the format: 4 + 4 characters of the same alphabet, hyphen after the fourth', () => {
    for (let draw = 0; draw < 200; draw++) {
      expect(generate()).toMatch(
        /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/
      );
    }
  });

  it('maps bytes to characters in order and skips the biased tail', () => {
    // 250 and 255 are above the limit of 248 and must not become characters
    const code = generate(fixedBytes([0, 250, 1, 2, 255, 3, 247, 4, 5, 6, 7]));

    expect(code).toBe(
      `${[0, 1, 2, 3].map((index) => USER_CODE_CHARSET[index]).join('')}-${[247 % 31, 4, 5, 6]
        .map((index) => USER_CODE_CHARSET[index])
        .join('')}`
    );
  });
});
