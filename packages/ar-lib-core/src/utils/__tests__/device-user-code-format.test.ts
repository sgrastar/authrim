/**
 * The user code format: the three alphabets, the entropy floor, the canonical and display forms,
 * and the generator that draws codes in the tenant's format.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_USER_CODE_CHARSET,
  DEFAULT_USER_CODE_LENGTH,
  USER_CODE_CHARSETS,
  USER_CODE_CHARSET_NAMES,
  USER_CODE_MAX_LENGTH,
  USER_CODE_MIN_ENTROPY_BITS,
  USER_CODE_MIN_LENGTH,
  formatUserCode,
  generateUserCode,
  isUserCodeFormatAllowed,
  minimumUserCodeLength,
  normalizeUserCode,
  resolveUserCodeFormat,
  userCodeEntropyBits,
  userCodeFormatProblem,
  validateUserCodeFormat,
  type UserCodeCharsetName,
} from '../device-flow';
import type { RandomBytesSource } from '../unbiased-random';

function fixedBytes(values: number[]): RandomBytesSource {
  let position = 0;
  return (length) => {
    const chunk = values.slice(position, position + length);
    position += length;
    if (chunk.length < length) throw new Error('fixed byte source exhausted');
    return Uint8Array.from(chunk);
  };
}

const lengths = Array.from(
  { length: USER_CODE_MAX_LENGTH - USER_CODE_MIN_LENGTH + 1 },
  (_, index) => USER_CODE_MIN_LENGTH + index
);

describe('the alphabets', () => {
  it('are the three the setting offers, with the sizes the entropy depends on', () => {
    expect(USER_CODE_CHARSET_NAMES).toEqual(['BASE31', 'BASE20', 'NUMERIC']);
    expect(USER_CODE_CHARSETS.BASE31).toBe('23456789ABCDEFGHJKMNPQRSTUVWXYZ');
    expect(USER_CODE_CHARSETS.BASE31).toHaveLength(31);
    expect(USER_CODE_CHARSETS.BASE20).toBe('BCDFGHJKLMNPQRSTVWXZ');
    expect(USER_CODE_CHARSETS.BASE20).toHaveLength(20);
    expect(USER_CODE_CHARSETS.NUMERIC).toBe('0123456789');
    for (const name of USER_CODE_CHARSET_NAMES) {
      expect(new Set(USER_CODE_CHARSETS[name]).size, name).toBe(USER_CODE_CHARSETS[name].length);
    }
  });

  it('keep the confusable characters out of BASE31 and the vowels out of BASE20', () => {
    expect(USER_CODE_CHARSETS.BASE31).not.toMatch(/[01OIL]/);
    expect(USER_CODE_CHARSETS.BASE20).not.toMatch(/[AEIOUY]/);
  });

  it('give the entropy the setting descriptions quote', () => {
    expect(userCodeEntropyBits('BASE31', 8)).toBeCloseTo(39.63, 2);
    expect(userCodeEntropyBits('BASE20', 8)).toBeCloseTo(34.58, 2);
    expect(userCodeEntropyBits('NUMERIC', 10)).toBeCloseTo(33.22, 2);
    expect(userCodeEntropyBits('NUMERIC', 11)).toBeCloseTo(36.54, 2);
  });
});

describe('the entropy floor', () => {
  it('is 34 bits', () => {
    expect(USER_CODE_MIN_ENTROPY_BITS).toBe(34);
  });

  it('needs 7 characters of BASE31, 8 of BASE20 and 11 digits', () => {
    expect(minimumUserCodeLength('BASE31')).toBe(7);
    expect(minimumUserCodeLength('BASE20')).toBe(8);
    expect(minimumUserCodeLength('NUMERIC')).toBe(11);
  });

  // [charset, shortest allowed length]
  const table: Array<[UserCodeCharsetName, number]> = [
    ['BASE31', 7],
    ['BASE20', 8],
    ['NUMERIC', 11],
  ];

  describe.each(table)('%s (shortest allowed: %i)', (charset, shortest) => {
    it.each(lengths)('length %i', (length) => {
      const allowed = length >= shortest;
      expect(isUserCodeFormatAllowed(charset, length)).toBe(allowed);
      // the same relation, computed from first principles
      expect(userCodeEntropyBits(charset, length) >= 34).toBe(allowed);
      expect(userCodeFormatProblem(charset, length) === null).toBe(allowed);
    });
  });

  it('names the minimum for the charset in the message', () => {
    expect(userCodeFormatProblem('NUMERIC', 10)).toMatch(
      /NUMERIC.*33\.2 bits.*at least 11 characters/
    );
    expect(userCodeFormatProblem('BASE20', 7)).toMatch(/BASE20.*at least 8 characters/);
    expect(userCodeFormatProblem('BASE31', 4)).toMatch(/BASE31.*at least 7 characters/);
  });

  it('refuses a length outside 4..16 with the range, whatever the charset', () => {
    expect(userCodeFormatProblem('BASE31', 3)).toMatch(/between 4 and 16/);
    expect(userCodeFormatProblem('BASE31', 17)).toMatch(/between 4 and 16/);
    expect(isUserCodeFormatAllowed('BASE31', 17)).toBe(false);
  });

  it.each([
    ['unknown charset', 'HEX', 8],
    ['lower case charset', 'base31', 8],
    ['fractional length', 'BASE31', 8.5],
    ['string length', 'BASE31', '8'],
    ['missing length', 'BASE31', undefined],
    ['NaN length', 'BASE31', NaN],
    ['prototype key as charset', 'toString', 8],
    ['__proto__ as charset', '__proto__', 8],
  ])('never allows %s', (_name, charset, length) => {
    expect(isUserCodeFormatAllowed(charset, length)).toBe(false);
  });

  describe('resolveUserCodeFormat falls back to the default PAIR', () => {
    it('keeps an allowed pair', () => {
      expect(resolveUserCodeFormat('NUMERIC', 12)).toEqual({
        userCodeCharset: 'NUMERIC',
        userCodeLength: 12,
      });
    });

    it.each([
      ['NUMERIC', 10],
      ['BASE20', 7],
      ['BASE31', 6],
      ['NUMERIC', 8],
      ['BASE31', 99],
      ['nope', 12],
    ])('%s x %j', (charset, length) => {
      expect(resolveUserCodeFormat(charset, length)).toEqual({
        userCodeCharset: DEFAULT_USER_CODE_CHARSET,
        userCodeLength: DEFAULT_USER_CODE_LENGTH,
      });
    });
  });
});

describe('the canonical and the display form', () => {
  it('turn "abcd efgh", "ABCD-EFGH" and "abcdefgh" into one canonical code', () => {
    const forms = ['abcd efgh', 'ABCD-EFGH', 'abcdefgh', 'Abcd–Efgh', '\tabcd-efgh\n'];
    expect(new Set(forms.map(normalizeUserCode))).toEqual(new Set(['ABCDEFGH']));
    expect(forms.every(validateUserCodeFormat)).toBe(true);
  });

  it.each([
    [4, 'ABCD'],
    [5, 'ABCD-E'],
    [7, 'ABCD-EFG'],
    [8, 'ABCD-EFGH'],
    [11, 'ABCD-EFGH-JKM'],
    [12, 'ABCD-EFGH-JKMN'],
    [16, 'ABCD-EFGH-JKMN-PQRS'],
  ])('shows %i characters in groups of 4: %s', (length, shown) => {
    const canonical = 'ABCDEFGHJKMNPQRS'.slice(0, length);
    expect(formatUserCode(canonical)).toBe(shown);
    expect(normalizeUserCode(shown)).toBe(canonical);
  });
});

describe('generateUserCode', () => {
  it('without a format is today: 8 characters of BASE31 with a hyphen after the fourth', () => {
    for (let draw = 0; draw < 200; draw++) {
      expect(generateUserCode()).toMatch(
        /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/
      );
    }
  });

  describe.each(USER_CODE_CHARSET_NAMES)('%s', (charset) => {
    const shortest = minimumUserCodeLength(charset);
    const lengthsToTry = [...new Set([shortest, 8, 11, 12, 16])].filter(
      (length) => length >= shortest
    );

    it.each(lengthsToTry)('draws length %i from the alphabet, in groups of 4', (length) => {
      for (let draw = 0; draw < 60; draw++) {
        const code = generateUserCode({ userCodeCharset: charset, userCodeLength: length });
        const groups = code.split('-');
        expect(groups.slice(0, -1).every((group) => group.length === 4)).toBe(true);
        expect(groups.at(-1)!.length).toBeGreaterThan(0);
        expect(groups.at(-1)!.length).toBeLessThanOrEqual(4);
        const canonical = normalizeUserCode(code);
        expect(canonical).toHaveLength(length);
        expect(
          [...canonical].every((character) => USER_CODE_CHARSETS[charset].includes(character))
        ).toBe(true);
        // a code is a fixed point of the display form and survives a round trip through typing
        expect(formatUserCode(code)).toBe(code);
        expect(validateUserCodeFormat(code)).toBe(true);
        expect(normalizeUserCode(code.toLowerCase().replace(/-/g, ' '))).toBe(canonical);
      }
    });

    it('refuses a length below the floor, whatever the caller passes', () => {
      expect(() =>
        generateUserCode({ userCodeCharset: charset, userCodeLength: shortest - 1 })
      ).toThrow(RangeError);
    });
  });

  it('refuses an unknown charset and a length outside 4..16', () => {
    expect(() => generateUserCode({ userCodeCharset: 'HEX' as never, userCodeLength: 8 })).toThrow(
      RangeError
    );
    expect(() => generateUserCode({ userCodeCharset: 'BASE31', userCodeLength: 17 })).toThrow(
      RangeError
    );
    expect(() => generateUserCode({ userCodeCharset: 'BASE31', userCodeLength: 4 })).toThrow(
      RangeError
    );
  });

  it('shapes the groups: 8 -> ABCD-EFGH, 11 -> XXXX-XXXX-XXX, no hyphen for 4 (the shortest is allowed only where the floor is)', () => {
    const zero = (count: number) => fixedBytes(Array.from({ length: count }, () => 0));
    expect(generateUserCode({ userCodeCharset: 'BASE31', userCodeLength: 8 }, zero(8))).toBe(
      '2222-2222'
    );
    expect(generateUserCode({ userCodeCharset: 'NUMERIC', userCodeLength: 11 }, zero(11))).toBe(
      '0000-0000-000'
    );
    expect(generateUserCode({ userCodeCharset: 'BASE20', userCodeLength: 16 }, zero(16))).toBe(
      'BBBB-BBBB-BBBB-BBBB'
    );
  });

  describe('rejection sampling', () => {
    it.each([
      ['BASE31', 31],
      ['BASE20', 20],
      ['NUMERIC', 10],
    ] as const)('%s skips the biased tail and maps the rest in order', (charset, size) => {
      const limit = 256 - (256 % size);
      // limit and 255 are above the usable range and must not become characters
      const bytes = [limit, 0, 255, 1, limit + 1, size - 1, size, limit - 1];
      const code = generateUserCode(
        { userCodeCharset: charset, userCodeLength: charset === 'NUMERIC' ? 11 : 8 },
        fixedBytes([...bytes, ...Array.from({ length: 16 }, () => 2)])
      );
      const alphabet = USER_CODE_CHARSETS[charset];
      const expected = [0, 1, size - 1, 0, (limit - 1) % size].map((index) => alphabet[index]);
      expect(normalizeUserCode(code).slice(0, 5)).toBe(expected.join(''));
    });

    it.each([
      ['BASE31', 8],
      ['BASE20', 8],
      ['NUMERIC', 11],
    ] as const)('%s x %i has every character equally often', (charset, length) => {
      const alphabet = USER_CODE_CHARSETS[charset];
      const counts = new Map<string, number>([...alphabet].map((c) => [c, 0]));
      const draws = 4000;
      for (let draw = 0; draw < draws; draw++) {
        for (const character of normalizeUserCode(
          generateUserCode({ userCodeCharset: charset, userCodeLength: length })
        )) {
          counts.set(character, (counts.get(character) ?? 0) + 1);
        }
      }
      const total = draws * length;
      const expected = total / alphabet.length;
      // a modulo-biased generator over-produces the first (256 % size) characters by 1/size_of_range
      // each; with this many samples that is far outside five standard deviations
      const deviation = Math.sqrt(expected * (1 - 1 / alphabet.length));
      for (const [character, count] of counts) {
        expect(Math.abs(count - expected), character).toBeLessThan(5 * deviation);
      }
    });
  });
});
