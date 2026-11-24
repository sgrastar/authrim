/**
 * SCIM assurance extension - mutation-hardening tests
 *
 * Calls the date helpers directly (not through the "not in the future" check) and pins
 * exact error lists and clock-skew boundaries.
 */

import { describe, expect, it } from 'vitest';
import {
  parseIsoDate,
  parseIsoDateTime,
  parseScimAssuranceExtension,
  scimAssuranceExtensionValue,
} from '../utils/scim-assurance';
import { SCIM_SCHEMAS } from '../types/scim';

const NOW = Date.parse('2026-10-11T00:00:00Z');
const URN = SCIM_SCHEMAS.ASSURANCE_USER;
const SKEW_MS = 5 * 60 * 1000;

describe('parseIsoDate calendar checks', () => {
  it.each([
    ['2024-02-29', '2024-02-29T00:00:00Z'],
    ['2000-02-29', '2000-02-29T00:00:00Z'],
    ['2026-01-01', '2026-01-01T00:00:00Z'],
    ['2026-12-31', '2026-12-31T00:00:00Z'],
    ['2026-04-30', '2026-04-30T00:00:00Z'],
    ['2026-02-28', '2026-02-28T00:00:00Z'],
  ])('accepts %s', (date, iso) => {
    expect(parseIsoDate(date)).toBe(Date.parse(iso));
  });

  it.each([
    '2100-02-29',
    '1900-02-29',
    '2026-02-29',
    '2026-02-30',
    '2026-04-31',
    '2026-06-31',
    '2026-09-31',
    '2026-11-31',
    '2026-01-32',
    '2026-00-10',
    '2026-13-10',
    '2026-09-00',
  ])('rejects %s', (date) => {
    expect(parseIsoDate(date)).toBeNull();
  });

  it('rejects text around the date', () => {
    expect(parseIsoDate('x2026-09-01')).toBeNull();
    expect(parseIsoDate('2026-09-01x')).toBeNull();
    expect(parseIsoDate(' 2026-09-01')).toBeNull();
  });
});

describe('parseIsoDateTime strictness', () => {
  it('accepts a zone offset at its limits', () => {
    expect(parseIsoDateTime('2026-09-01T10:00:00+23:59')).toBe(
      Date.parse('2026-09-01T10:00:00Z') - (23 * 60 + 59) * 60 * 1000
    );
    expect(parseIsoDateTime('2026-09-01T10:00:00-00:00')).toBe(Date.parse('2026-09-01T10:00:00Z'));
    expect(parseIsoDateTime('2026-09-01T23:59:59Z')).toBe(Date.parse('2026-09-01T23:59:59Z'));
  });

  it('keeps fractional seconds', () => {
    expect(parseIsoDateTime('2026-09-01T00:00:00.123456789Z')).toBe(
      Date.parse('2026-09-01T00:00:00.123Z')
    );
  });

  it.each([
    '2026-09-01T10:00:00+24:00',
    '2026-09-01T10:00:00+09:60',
    '2026-09-01T10:60:00Z',
    '2026-09-01T10:00:60Z',
    '2026-09-01T25:00:00Z',
    '2100-02-29T00:00:00Z',
    '2026-02-31T00:00:00Z',
    'x2026-09-01T00:00:00Z',
    '2026-09-01T00:00:00Zx',
    '2026-09-01T00:00:00.Z',
    '2026-09-01T00:00:00',
    '2026-09-01 00:00:00Z',
    '',
  ])('rejects %j', (value) => {
    expect(parseIsoDateTime(value)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(parseIsoDateTime(null)).toBeNull();
    expect(parseIsoDateTime(1788000000000)).toBeNull();
    expect(parseIsoDateTime({})).toBeNull();
  });
});

describe('parseScimAssuranceExtension details', () => {
  const verifiedAt = '2026-09-01T00:00:00Z';
  const verifiedMs = Date.parse(verifiedAt);

  it.each(['IAL1', 'IAL2', 'IAL3'] as const)('accepts %s', (ial) => {
    expect(parseScimAssuranceExtension({ ial, verifiedAt }, NOW)).toEqual({
      errors: [],
      claim: { ial, verifiedAt: verifiedMs, expiresAt: null },
    });
  });

  it('accepts a verifiedAt exactly at the clock skew limit', () => {
    const at = new Date(NOW + SKEW_MS).toISOString();
    expect(parseScimAssuranceExtension({ ial: 'IAL1', verifiedAt: at }, NOW).errors).toEqual([]);
  });

  it('refuses a verifiedAt one millisecond past the clock skew limit', () => {
    const at = new Date(NOW + SKEW_MS + 1).toISOString();
    expect(parseScimAssuranceExtension({ ial: 'IAL1', verifiedAt: at }, NOW)).toEqual({
      claim: null,
      errors: [`${URN}.verifiedAt must not be in the future`],
    });
  });

  it('accepts a verifiedAt equal to now and slightly in the future', () => {
    const atNow = new Date(NOW).toISOString();
    const soon = new Date(NOW + 60 * 1000).toISOString();
    expect(parseScimAssuranceExtension({ ial: 'IAL1', verifiedAt: atNow }, NOW).errors).toEqual([]);
    expect(parseScimAssuranceExtension({ ial: 'IAL1', verifiedAt: soon }, NOW).errors).toEqual([]);
  });

  it('refuses a verifiedAt 10 minutes ahead of the clock', () => {
    const at = new Date(NOW + 10 * 60 * 1000).toISOString();
    expect(parseScimAssuranceExtension({ ial: 'IAL1', verifiedAt: at }, NOW).errors).toEqual([
      `${URN}.verifiedAt must not be in the future`,
    ]);
  });

  it('uses the current time when now is not given', () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    expect(parseScimAssuranceExtension({ ial: 'IAL1', verifiedAt: past }).errors).toEqual([]);
    expect(parseScimAssuranceExtension({ ial: 'IAL1', verifiedAt: future }).errors).toEqual([
      `${URN}.verifiedAt must not be in the future`,
    ]);
  });

  it('takes a null expiresAt as no expiry', () => {
    expect(parseScimAssuranceExtension({ ial: 'IAL2', verifiedAt, expiresAt: null }, NOW)).toEqual({
      errors: [],
      claim: { ial: 'IAL2', verifiedAt: verifiedMs, expiresAt: null },
    });
  });

  it('refuses an expiresAt one millisecond after verifiedAt only when it is later', () => {
    const later = new Date(verifiedMs + 1).toISOString();
    expect(
      parseScimAssuranceExtension({ ial: 'IAL2', verifiedAt, expiresAt: later }, NOW).claim
    ).toEqual({ ial: 'IAL2', verifiedAt: verifiedMs, expiresAt: verifiedMs + 1 });
    const earlier = new Date(verifiedMs - 1).toISOString();
    expect(
      parseScimAssuranceExtension({ ial: 'IAL2', verifiedAt, expiresAt: earlier }, NOW)
    ).toEqual({ claim: null, errors: [`${URN}.expiresAt must be after verifiedAt`] });
  });

  it('reports an invalid expiresAt', () => {
    expect(
      parseScimAssuranceExtension({ ial: 'IAL2', verifiedAt, expiresAt: 'never' }, NOW)
    ).toEqual({ claim: null, errors: [`${URN}.expiresAt must be a date-time with a time zone`] });
  });

  it.each([
    ['a string', 'IAL2'],
    ['a number', 5],
    ['an array', []],
    ['an array with an entry', [{ ial: 'IAL1', verifiedAt }]],
    ['a boolean', true],
  ])('refuses %s with a single error', (_label, value) => {
    expect(parseScimAssuranceExtension(value, NOW)).toEqual({
      claim: null,
      errors: [`${URN} must be an object`],
    });
  });

  it('accepts an empty object as an invalid claim with both required errors', () => {
    expect(parseScimAssuranceExtension({}, NOW)).toEqual({
      claim: null,
      errors: [
        `${URN}.ial must be IAL1, IAL2 or IAL3`,
        `${URN}.verifiedAt must be a date-time with a time zone`,
      ],
    });
  });

  it('names an unknown attribute and still reads the rest', () => {
    expect(parseScimAssuranceExtension({ ial: 'IAL2', verifiedAt, extra: 1 }, NOW)).toEqual({
      claim: null,
      errors: [`${URN}.extra is not an attribute of the extension`],
    });
  });

  it('refuses a non-string ial', () => {
    expect(parseScimAssuranceExtension({ ial: 2, verifiedAt }, NOW).errors).toEqual([
      `${URN}.ial must be IAL1, IAL2 or IAL3`,
    ]);
  });
});

describe('scimAssuranceExtensionValue', () => {
  it('includes expiresAt as ISO text when the claim has one', () => {
    expect(
      scimAssuranceExtensionValue({
        ial: 'IAL3',
        verifiedAt: Date.parse('2026-09-01T00:00:00Z'),
        expiresAt: Date.parse('2027-09-01T12:30:00Z'),
      })
    ).toEqual({
      ial: 'IAL3',
      verifiedAt: '2026-09-01T00:00:00.000Z',
      expiresAt: '2027-09-01T12:30:00.000Z',
    });
  });
});
