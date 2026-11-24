import { describe, expect, it } from 'vitest';
import { dateFormat, textToNumber, validTimeZone } from '../../core/text-date';
import { TransformFailure } from '../../core/transform-safety';

/** Runs a conversion and reports the failure code instead of a value. */
function failure(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof TransformFailure) return error.code;
    throw error;
  }
  return undefined;
}
const iso = (value: unknown, to = 'unix_ms', extra: Record<string, unknown> = {}) =>
  dateFormat(value, { from: 'iso', to, ...extra });
const MS_2024_01_15 = 1705276800000;

describe('validTimeZone', () => {
  it.each(['UTC', 'Asia/Tokyo', 'America/New_York', 'Etc/GMT+9', 'Etc/GMT-14'])(
    'accepts %s',
    (zone) => {
      expect(validTimeZone(zone)).toBe(true);
    }
  );

  it.each(['', '+09:00', '-05:00', 'Not/AZone', 'Mars/Phobos'])('rejects %j', (zone) => {
    expect(validTimeZone(zone)).toBe(false);
  });

  it.each([undefined, null, 9, {}, ['UTC']])('rejects the non-text value %j', (zone) => {
    expect(validTimeZone(zone)).toBe(false);
  });
});

describe('textToNumber', () => {
  it.each([
    ['42', 42],
    [' -7.5 ', -7.5],
    [3, 3],
    ['0', 0],
  ])('reads %j as %j', (input, output) => {
    expect(textToNumber(input)).toBe(output);
  });

  it.each(['', ' ', '0x10', '1e3', '+1', '1.', '.5', 'true', '1,5', 'NaN'])(
    'rejects %j',
    (input) => {
      expect(failure(() => textToNumber(input))).toBe('transform.invalid_output');
    }
  );

  it.each([true, null, undefined, {}, [], Number.NaN, Infinity, 2 ** 60])(
    'rejects the non-numeric or unsafe value %j',
    (input) => {
      expect(failure(() => textToNumber(input))).toBe('transform.invalid_output');
    }
  );
});

describe('ISO input', () => {
  it.each([
    ['2024-01-15', MS_2024_01_15],
    ['2024-01-15T00:00:00', MS_2024_01_15],
    ['2024-01-15T00:00:00Z', MS_2024_01_15],
    ['2024-01-15T10:20:30Z', MS_2024_01_15 + 37_230_000],
    ['2024-01-15T10:20:30', MS_2024_01_15 + 37_230_000],
    ['2024-01-15T00:00:00.5Z', MS_2024_01_15 + 500],
    ['2024-01-15T00:00:00.05Z', MS_2024_01_15 + 50],
    ['2024-01-15T00:00:00.123Z', MS_2024_01_15 + 123],
    ['2024-01-15T00:00:00.001', MS_2024_01_15 + 1],
    ['2024-01-15T10:00:00+09:00', MS_2024_01_15 + 3_600_000],
    ['2024-01-15T10:00:00-05:30', MS_2024_01_15 + 10 * 3_600_000 + 5.5 * 3_600_000],
    ['2024-01-15T10:00:00+00:00', MS_2024_01_15 + 10 * 3_600_000],
    ['2024-01-15T10:00:00+05:45', MS_2024_01_15 + 10 * 3_600_000 - 20_700_000],
    ['2024-01-15T00:00:00+23:59', MS_2024_01_15 - (23 * 60 + 59) * 60_000],
    ['2024-01-15T00:00:00-23:00', MS_2024_01_15 + 23 * 3_600_000],
    ['2024-01-15T00:00:00+09:59', MS_2024_01_15 - (9 * 60 + 59) * 60_000],
    ['2024-01-15T23:59:59Z', MS_2024_01_15 + 86_399_000],
    ['2024-02-29', 1709164800000],
    ['2024-12-31T23:59:59.999Z', 1735689599999],
  ])('reads %s', (input, output) => {
    expect(iso(input)).toBe(output);
  });

  it('treats years 1 to 99 as written, not as 1900s', () => {
    expect(iso('0050-06-15', 'date')).toBe('0050-06-15');
    expect(iso('0001-01-01', 'date')).toBe('0001-01-01');
    expect(iso('0001-01-01')).toBe(-62135596800000);
    expect(iso('9999-12-31T23:59:59.999Z')).toBe(253402300799999);
  });

  it.each([
    'x2024-01-15',
    '2024-01-15x',
    '2024-01-15T10:20:30Zx',
    ' 2024-01-15',
    '2024-1-15',
    '24-01-15',
    '2024-01-15T10:20',
    '2024-01-15T10:20:30.1234Z',
    '2024-01-15T10:20:30.Z',
    '2024-01-15T10:20:30+0900',
    '2024-01-15T10:20:30+9:00',
    '2024-01-15T10:20:30z',
    '2024/01/15',
    '',
    'tomorrow',
  ])('rejects the malformed text %j', (input) => {
    expect(failure(() => iso(input))).toBe('transform.invalid_output');
  });

  it.each([
    '0000-01-01',
    '2024-00-10',
    '2024-13-10',
    '2024-01-00',
    '2024-01-32',
    '2023-02-29',
    '2024-02-30',
    '2024-04-31',
    '2024-01-15T24:00:00Z',
    '2024-01-15T10:60:00Z',
    '2024-01-15T10:20:60Z',
    '2024-01-15T10:20:30+24:00',
    '2024-01-15T10:20:30+09:60',
    '2024-01-15T10:20:30-24:00',
  ])('rejects the impossible date %j', (input) => {
    expect(failure(() => iso(input))).toBe('transform.invalid_output');
  });

  it.each([0, 20240115, true, null, undefined, {}, ['2024-01-15']])(
    'rejects the non-text value %j',
    (input) => {
      expect(failure(() => iso(input))).toBe('transform.invalid_output');
    }
  );

  it('defaults to ISO parsing when no source format is named', () => {
    expect(dateFormat('2024-01-15', { to: 'unix_ms' })).toBe(MS_2024_01_15);
    expect(failure(() => dateFormat('1705276800', { to: 'unix_ms' }))).toBe(
      'transform.invalid_output'
    );
  });
});

describe('epoch input', () => {
  it('reads seconds, milliseconds and the automatic guess', () => {
    expect(dateFormat(1705276800, { from: 'unix_s', to: 'unix_ms' })).toBe(MS_2024_01_15);
    expect(dateFormat(MS_2024_01_15, { from: 'unix_ms', to: 'unix_ms' })).toBe(MS_2024_01_15);
    expect(dateFormat(1705276800, { from: 'auto', to: 'unix_ms' })).toBe(MS_2024_01_15);
    expect(dateFormat(MS_2024_01_15, { from: 'auto', to: 'unix_ms' })).toBe(MS_2024_01_15);
    expect(dateFormat('1705276800', { from: 'auto', to: 'unix_ms' })).toBe(MS_2024_01_15);
  });

  it('switches from seconds to milliseconds at exactly 1e11', () => {
    expect(dateFormat(99_999_999_999, { from: 'auto', to: 'unix_ms' })).toBe(99_999_999_999_000);
    expect(dateFormat(1e11, { from: 'auto', to: 'unix_ms' })).toBe(1e11);
    expect(dateFormat(-1e11, { from: 'auto', to: 'unix_ms' })).toBe(-1e11);
    // Read as seconds this is before year 1, so it is refused rather than guessed as milliseconds.
    expect(failure(() => dateFormat(-99_999_999_999, { from: 'auto', to: 'unix_ms' }))).toBe(
      'transform.invalid_output'
    );
  });

  it('reads large numbers as seconds when the unit is named explicitly', () => {
    expect(dateFormat(1e11, { from: 'unix_s', to: 'unix_ms' })).toBe(1e14);
    expect(dateFormat(-1e11, { from: 'unix_ms', to: 'unix_ms' })).toBe(-1e11);
  });

  it('lets auto fall back to ISO for text that is not a plain number', () => {
    expect(dateFormat('2024-01-15', { from: 'auto', to: 'unix_ms' })).toBe(MS_2024_01_15);
    expect(dateFormat(' 1705276800 ', { from: 'auto', to: 'unix_ms' })).toBe(MS_2024_01_15);
  });

  it('does not coerce an epoch from non-plain numeric text', () => {
    for (const from of ['unix_s', 'unix_ms']) {
      for (const input of ['1e5', ' 1e5', '0x10', '', true, null]) {
        expect(failure(() => dateFormat(input, { from, to: 'unix_ms' }))).toBe(
          'transform.invalid_output'
        );
      }
    }
  });

  it('rejects results that are not safe integers', () => {
    expect(failure(() => dateFormat('9007199254740.993', { from: 'unix_s', to: 'unix_ms' }))).toBe(
      'transform.invalid_output'
    );
    expect(failure(() => dateFormat(2 ** 53, { from: 'unix_ms', to: 'unix_ms' }))).toBe(
      'transform.invalid_output'
    );
  });
});

describe('supported year range', () => {
  const edge = { from: 'unix_ms', to: 'unix_ms' };
  it('accepts the first and last millisecond of years 1 and 9999', () => {
    expect(dateFormat(-62135596800000, edge)).toBe(-62135596800000);
    expect(dateFormat(253402300799999, edge)).toBe(253402300799999);
  });

  it.each([-62135596800001, 253402300800000, 8640000000000001, -8640000000000001])(
    'rejects %d',
    (ms) => {
      expect(failure(() => dateFormat(ms, edge))).toBe('transform.invalid_output');
    }
  );

  it('rejects a local year outside 1 to 9999 even when the UTC year is valid', () => {
    expect(
      failure(() =>
        dateFormat(-62135596800000, { from: 'unix_ms', to: 'date', timeZone: 'America/New_York' })
      )
    ).toBe('transform.invalid_output');
    expect(
      failure(() =>
        dateFormat(253402300799999, { from: 'unix_ms', to: 'date', timeZone: 'Asia/Tokyo' })
      )
    ).toBe('transform.invalid_output');
  });

  it('keeps year 9999 and year 1 formattable', () => {
    expect(dateFormat(253402300799999, { from: 'unix_ms', to: 'date' })).toBe('9999-12-31');
    expect(dateFormat(-62135596800000, { from: 'unix_ms', to: 'date' })).toBe('0001-01-01');
  });
});

describe('output formats', () => {
  it('floors Unix seconds, including before 1970', () => {
    expect(iso('2024-01-15T00:00:00.999Z', 'unix_s')).toBe(1705276800);
    expect(iso('1969-12-31T23:59:59.500Z', 'unix_s')).toBe(-1);
    expect(iso('1970-01-01T00:00:00Z', 'unix_s')).toBe(0);
  });

  it('keeps milliseconds for Unix milliseconds', () => {
    expect(iso('2024-01-15T00:00:00.123Z', 'unix_ms')).toBe(MS_2024_01_15 + 123);
  });

  it('formats a date in UTC by default and in a named zone on request', () => {
    expect(iso('2024-01-15T23:30:00Z', 'date')).toBe('2024-01-15');
    expect(iso('2024-01-15T23:30:00Z', 'date', { timeZone: 'Asia/Tokyo' })).toBe('2024-01-16');
    expect(iso('2024-01-15T01:30:00Z', 'date', { timeZone: 'America/New_York' })).toBe(
      '2024-01-14'
    );
  });

  it('formats ISO output with the zone offset', () => {
    expect(iso('2024-01-15T00:00:00Z', 'iso')).toBe('2024-01-15T00:00:00Z');
    expect(iso('2024-01-15T05:06:07.999Z', 'iso')).toBe('2024-01-15T05:06:07Z');
    expect(iso('2024-01-15T00:00:00Z', 'iso', { timeZone: 'Asia/Tokyo' })).toBe(
      '2024-01-15T09:00:00+09:00'
    );
    expect(iso('2024-01-15T00:00:00Z', 'iso', { timeZone: 'America/New_York' })).toBe(
      '2024-01-14T19:00:00-05:00'
    );
    expect(iso('2024-01-15T00:00:00Z', 'iso', { timeZone: 'Asia/Kolkata' })).toBe(
      '2024-01-15T05:30:00+05:30'
    );
    expect(iso('2024-01-15T00:00:00Z', 'iso', { timeZone: 'America/St_Johns' })).toBe(
      '2024-01-14T20:30:00-03:30'
    );
    expect(iso('2024-01-15T00:00:00Z', 'iso', { timeZone: 'Pacific/Kiritimati' })).toBe(
      '2024-01-15T14:00:00+14:00'
    );
    expect(iso('2024-07-15T00:00:00Z', 'iso', { timeZone: 'Europe/London' })).toBe(
      '2024-07-15T01:00:00+01:00'
    );
  });

  it('writes midnight as 00 and zero-pads every field', () => {
    expect(iso('0099-03-04T05:06:07Z', 'iso')).toBe('0099-03-04T05:06:07Z');
    expect(iso('2024-01-15T23:59:59Z', 'iso')).toBe('2024-01-15T23:59:59Z');
  });

  it('falls back to UTC when the time zone is not text', () => {
    expect(iso('2024-01-15T00:00:00Z', 'iso', { timeZone: 9 })).toBe('2024-01-15T00:00:00Z');
  });

  it('rejects an offset that the console format cannot show', () => {
    expect(failure(() => iso('1800-01-01T00:00:00Z', 'iso', { timeZone: 'Asia/Tokyo' }))).toBe(
      'transform.invalid_output'
    );
  });
});
