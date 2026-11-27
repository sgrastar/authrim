/**
 * SCIM assurance extension - date / date-time boundary tests
 *
 * Pins the exact accept / reject boundaries of parseIsoDate and parseIsoDateTime so that a
 * roll-over date (Feb 30, hour 24, ...) can never be taken as a valid claim time.
 */

import { describe, it, expect } from 'vitest';
import {
  parseIsoDate,
  parseIsoDateTime,
  parseScimAssuranceExtension,
} from '../utils/scim-assurance';
import { SCIM_SCHEMAS } from '../types/scim';

describe('parseIsoDateTime', () => {
  it.each([
    ['2026-01-01T23:59:59Z', 1767311999000],
    ['2026-01-01T00:00:00+23:59', 1767139260000],
    ['2026-01-01T00:00:00+09:00', 1767193200000],
    ['2026-01-01T00:00:00-12:00', 1767268800000],
    ['2026-01-01T00:00:00.123456789Z', 1767225600123],
    ['2024-02-29T00:00:00Z', 1709164800000],
  ])('accepts %s', (value, ms) => {
    expect(parseIsoDateTime(value)).toBe(ms);
  });

  it.each([
    ['hour 24', '2026-01-01T24:00:00Z'],
    ['minute 60', '2026-01-01T23:60:00Z'],
    ['second 60', '2026-01-01T23:00:60Z'],
    ['offset hour 24', '2026-01-01T00:00:00+24:00'],
    ['offset minute 60', '2026-01-01T00:00:00+00:60'],
    ['offset hour and minute out of range', '2026-01-01T00:00:00+23:60'],
    ['Feb 29 in a common year', '2026-02-29T00:00:00Z'],
    ['April 31', '2026-04-31T00:00:00Z'],
    ['month 13', '2026-13-01T00:00:00Z'],
    ['month 0', '2026-00-10T00:00:00Z'],
    ['day 0', '2026-01-00T00:00:00Z'],
    ['leading junk', 'x2026-01-01T00:00:00Z'],
    ['trailing junk', '2026-01-01T00:00:00Zx'],
    ['trailing newline', '2026-01-01T00:00:00Z\n'],
    ['no time zone', '2026-01-01T00:00:00'],
    ['date only', '2026-01-01'],
    ['10 fractional digits', '2026-01-01T00:00:00.1234567890Z'],
  ])('rejects %s', (_label, value) => {
    expect(parseIsoDateTime(value)).toBeNull();
  });

  it('rejects non-string input', () => {
    expect(parseIsoDateTime(1767225600000)).toBeNull();
    expect(parseIsoDateTime(undefined)).toBeNull();
    expect(parseIsoDateTime(new Date(0))).toBeNull();
  });

  it('rejects a string longer than any valid date-time', () => {
    expect(parseIsoDateTime(`2026-01-01T00:00:00Z${' '.repeat(30)}`)).toBeNull();
  });
});

describe('parseIsoDate', () => {
  it.each([
    ['2026-01-01', 1767225600000],
    ['2000-02-29', 951782400000],
    ['2026-12-31', 1798675200000],
    ['2026-01-31', 1769817600000],
  ])('accepts %s', (value, ms) => {
    expect(parseIsoDate(value)).toBe(ms);
  });

  it.each([
    '2026-02-29',
    '1900-02-29',
    '2026-06-31',
    '2026-01-32',
    '2026-00-01',
    '2026-13-01',
    '2026-01-00',
    '2026-01-01x',
    'x2026-01-01',
  ])('rejects %s', (value) => {
    expect(parseIsoDate(value)).toBeNull();
  });

  it('rejects non-string input', () => {
    expect(parseIsoDate(20260101)).toBeNull();
  });
});

describe('parseScimAssuranceExtension time validation', () => {
  const now = Date.parse('2026-06-01T00:00:00Z');
  const schema = SCIM_SCHEMAS.ASSURANCE_USER;

  it('refuses a claim whose verifiedAt rolls over to a later day', () => {
    const result = parseScimAssuranceExtension(
      { ial: 'IAL2', verifiedAt: '2026-02-30T00:00:00Z' },
      now
    );
    expect(result.claim).toBeNull();
    expect(result.errors).toEqual([`${schema}.verifiedAt must be a date-time with a time zone`]);
  });

  it('allows verifiedAt exactly at the clock-skew limit and refuses one second past it', () => {
    const limit = now + 5 * 60 * 1000;
    const at = parseScimAssuranceExtension(
      { ial: 'IAL1', verifiedAt: new Date(limit).toISOString() },
      now
    );
    expect(at.errors).toEqual([]);
    expect(at.claim?.verifiedAt).toBe(limit);

    const past = parseScimAssuranceExtension(
      { ial: 'IAL1', verifiedAt: new Date(limit + 1000).toISOString() },
      now
    );
    expect(past.claim).toBeNull();
    expect(past.errors).toEqual([`${schema}.verifiedAt must not be in the future`]);
  });
});
