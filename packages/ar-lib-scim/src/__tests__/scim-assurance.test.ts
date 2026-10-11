import { describe, expect, it } from 'vitest';
import {
  parseIsoDate,
  parseIsoDateTime,
  parseScimAssuranceExtension,
  scimAssuranceExtensionValue,
  SCIM_ASSURANCE_ATTRIBUTES,
} from '../utils/scim-assurance';
import { applyPatchOperations, validateScimUser } from '../utils/scim-mapper';
import { SCIM_SCHEMAS } from '../types/scim';

const NOW = Date.parse('2026-10-11T00:00:00Z');
const URN = SCIM_SCHEMAS.ASSURANCE_USER;

describe('SCIM assurance extension', () => {
  it('is the Authrim assurance extension of the User resource', () => {
    expect(URN).toBe('urn:authrim:params:scim:schemas:extension:assurance:1.0:User');
    expect(SCIM_ASSURANCE_ATTRIBUTES).toEqual(['ial', 'verifiedAt', 'expiresAt']);
  });

  it('reads an IAL with when it was proofed and when that lapses', () => {
    expect(
      parseScimAssuranceExtension(
        { ial: 'IAL2', verifiedAt: '2026-09-01T09:00:00+09:00', expiresAt: '2027-09-01T00:00:00Z' },
        NOW
      )
    ).toEqual({
      errors: [],
      claim: {
        ial: 'IAL2',
        verifiedAt: Date.parse('2026-09-01T00:00:00Z'),
        expiresAt: Date.parse('2027-09-01T00:00:00Z'),
      },
    });
    expect(
      parseScimAssuranceExtension({ ial: 'IAL3', verifiedAt: '2026-09-01T00:00:00.500Z' }, NOW)
    ).toEqual({
      errors: [],
      claim: { ial: 'IAL3', verifiedAt: Date.parse('2026-09-01T00:00:00.500Z'), expiresAt: null },
    });
  });

  it('takes an absent or null extension as no claim', () => {
    expect(parseScimAssuranceExtension(undefined, NOW)).toEqual({ errors: [], claim: null });
    expect(parseScimAssuranceExtension(null, NOW)).toEqual({ errors: [], claim: null });
  });

  it.each([
    ['not an object', 'IAL2'],
    ['an array', []],
    ['no ial', { verifiedAt: '2026-09-01T00:00:00Z' }],
    ['an unknown ial', { ial: 'IAL4', verifiedAt: '2026-09-01T00:00:00Z' }],
    ['a lower-case ial', { ial: 'ial2', verifiedAt: '2026-09-01T00:00:00Z' }],
    ['no verifiedAt', { ial: 'IAL2' }],
    ['a verifiedAt that is not a date-time', { ial: 'IAL2', verifiedAt: 'yesterday' }],
    ['a verifiedAt without a time zone', { ial: 'IAL2', verifiedAt: '2026-09-01T00:00:00' }],
    ['a verifiedAt in the future', { ial: 'IAL2', verifiedAt: '2026-10-11T01:00:00Z' }],
    [
      'an expiresAt that is not after verifiedAt',
      { ial: 'IAL2', verifiedAt: '2026-09-01T00:00:00Z', expiresAt: '2026-09-01T00:00:00Z' },
    ],
    [
      'an expiresAt that is not a date-time',
      { ial: 'IAL2', verifiedAt: '2026-09-01T00:00:00Z', expiresAt: 'never' },
    ],
    // A day or time that does not exist is refused, not rolled over (Feb 31 is not March 3).
    ['a verifiedAt on February 31', { ial: 'IAL2', verifiedAt: '2026-02-31T00:00:00Z' }],
    ['a verifiedAt on February 30', { ial: 'IAL2', verifiedAt: '2026-02-30T00:00:00Z' }],
    [
      'a verifiedAt on February 29 of a year that is not a leap year',
      { ial: 'IAL2', verifiedAt: '2026-02-29T00:00:00Z' },
    ],
    [
      'a verifiedAt on February 29 of 2100, which is not a leap year',
      { ial: 'IAL2', verifiedAt: '2100-02-29T00:00:00Z' },
    ],
    ['a verifiedAt in month 13', { ial: 'IAL2', verifiedAt: '2026-13-01T00:00:00Z' }],
    ['a verifiedAt in month 0', { ial: 'IAL2', verifiedAt: '2026-00-01T00:00:00Z' }],
    ['a verifiedAt on day 31 of April', { ial: 'IAL2', verifiedAt: '2026-04-31T00:00:00Z' }],
    ['a verifiedAt on day 0', { ial: 'IAL2', verifiedAt: '2026-09-00T00:00:00Z' }],
    ['a verifiedAt at hour 24', { ial: 'IAL2', verifiedAt: '2026-09-01T24:00:00Z' }],
    ['a verifiedAt at minute 60', { ial: 'IAL2', verifiedAt: '2026-09-01T10:60:00Z' }],
    ['a verifiedAt at second 60', { ial: 'IAL2', verifiedAt: '2026-09-01T10:00:60Z' }],
    [
      'a verifiedAt with an offset of 24 hours',
      { ial: 'IAL2', verifiedAt: '2026-09-01T10:00:00+24:00' },
    ],
    [
      'a verifiedAt with an offset of 60 minutes',
      { ial: 'IAL2', verifiedAt: '2026-09-01T10:00:00+09:60' },
    ],
    [
      'an expiresAt on February 31',
      { ial: 'IAL2', verifiedAt: '2026-01-01T00:00:00Z', expiresAt: '2027-02-31T00:00:00Z' },
    ],
    [
      'an expiresAt on February 29 of a year that is not a leap year',
      { ial: 'IAL2', verifiedAt: '2026-01-01T00:00:00Z', expiresAt: '2027-02-29T00:00:00Z' },
    ],
    ['an attribute it does not have', { ial: 'IAL2', verifiedAt: '2026-09-01T00:00:00Z', x: 1 }],
  ])('refuses %s', (_label, value) => {
    const result = parseScimAssuranceExtension(value, NOW);
    expect(result.claim).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.every((error) => error.startsWith(`${URN}`))).toBe(true);
  });

  it('allows an expiresAt in the past, so a user whose claim lapsed can still be updated', () => {
    expect(
      parseScimAssuranceExtension(
        { ial: 'IAL2', verifiedAt: '2025-09-01T00:00:00Z', expiresAt: '2026-01-01T00:00:00Z' },
        NOW
      ).errors
    ).toEqual([]);
  });

  it('accepts the days and times that do exist', () => {
    for (const verifiedAt of [
      '2024-02-29T00:00:00Z',
      '2000-02-29T23:59:59Z',
      '2026-04-30T23:59:59.999-05:30',
      '2026-01-31T00:00:00+23:59',
    ]) {
      expect(parseScimAssuranceExtension({ ial: 'IAL2', verifiedAt }, NOW).errors).toEqual([]);
    }
  });

  it('reads dates and date-times strictly', () => {
    expect(parseIsoDate('2026-09-01')).toBe(Date.parse('2026-09-01T00:00:00Z'));
    expect(parseIsoDate('2024-02-29')).toBe(Date.parse('2024-02-29T00:00:00Z'));
    for (const bad of [
      '2026-02-29',
      '2026-02-31',
      '2026-13-01',
      '2026-9-1',
      '2026-09-01T00:00:00Z',
      5,
      null,
    ]) {
      expect(parseIsoDate(bad)).toBeNull();
    }
    expect(parseIsoDateTime('2026-09-01T09:00:00+09:00')).toBe(Date.parse('2026-09-01T00:00:00Z'));
    for (const bad of ['2026-02-31T00:00:00Z', '2026-09-01T00:00:00', '2026-09-01', 7, undefined]) {
      expect(parseIsoDateTime(bad)).toBeNull();
    }
  });

  it('is checked with the rest of a SCIM User', () => {
    const user = (extension: unknown) => ({
      schemas: [SCIM_SCHEMAS.USER, URN],
      userName: 'u',
      [URN]: extension,
    });
    expect(validateScimUser(user({ ial: 'IAL2', verifiedAt: '2026-09-01T00:00:00Z' }))).toEqual({
      valid: true,
      errors: [],
    });
    expect(validateScimUser(user({ ial: 'IAL9', verifiedAt: '2026-09-01T00:00:00Z' })).valid).toBe(
      false
    );
  });

  it('renders a claim as the extension a client reads', () => {
    expect(
      scimAssuranceExtensionValue({
        ial: 'IAL2',
        verifiedAt: Date.parse('2026-09-01T00:00:00Z'),
        expiresAt: null,
      })
    ).toEqual({ ial: 'IAL2', verifiedAt: '2026-09-01T00:00:00.000Z' });
  });
});

describe('PATCH paths into an extension', () => {
  const resource = () => ({
    schemas: [SCIM_SCHEMAS.USER],
    userName: 'u',
    [URN]: { ial: 'IAL2', verifiedAt: '2026-09-01T00:00:00Z' },
  });

  it('replaces one attribute of the extension named by its URN', () => {
    const result = applyPatchOperations(resource(), [
      { op: 'replace', path: `${URN}:ial`, value: 'IAL3' },
    ]) as Record<string, any>;
    expect(result[URN]).toEqual({ ial: 'IAL3', verifiedAt: '2026-09-01T00:00:00Z' });
    expect(Object.keys(result).filter((key) => key.startsWith('urn:'))).toEqual([URN]);
  });

  it('adds an attribute, creating the extension when there is none', () => {
    const result = applyPatchOperations({ schemas: [SCIM_SCHEMAS.USER], userName: 'u' }, [
      { op: 'add', path: `${URN}:expiresAt`, value: '2027-01-01T00:00:00Z' },
    ]) as Record<string, any>;
    expect(result[URN]).toEqual({ expiresAt: '2027-01-01T00:00:00Z' });
  });

  it('removes one attribute, or the whole extension', () => {
    const attribute = applyPatchOperations(resource(), [
      { op: 'remove', path: `${URN}:verifiedAt` },
    ]) as Record<string, any>;
    expect(attribute[URN]).toEqual({ ial: 'IAL2' });
    const whole = applyPatchOperations(resource(), [{ op: 'remove', path: URN }]) as Record<
      string,
      any
    >;
    expect(URN in whole).toBe(false);
  });

  it('takes the whole extension as a value without a path', () => {
    const result = applyPatchOperations(resource(), [
      { op: 'replace', value: { [URN]: { ial: 'IAL3', verifiedAt: '2026-09-02T00:00:00Z' } } },
    ]) as Record<string, any>;
    expect(result[URN]).toEqual({ ial: 'IAL3', verifiedAt: '2026-09-02T00:00:00Z' });
  });

  it('does the same for the enterprise extension, whose version has a dot too', () => {
    const result = applyPatchOperations({ schemas: [SCIM_SCHEMAS.USER], userName: 'u' }, [
      { op: 'add', path: `${SCIM_SCHEMAS.ENTERPRISE_USER}:department`, value: 'Physics' },
    ]) as Record<string, any>;
    expect(result[SCIM_SCHEMAS.ENTERPRISE_USER]).toEqual({ department: 'Physics' });
  });

  it('keeps dotted paths of the core schema as they were', () => {
    const result = applyPatchOperations(
      { schemas: [SCIM_SCHEMAS.USER], userName: 'u', name: { givenName: 'A' } },
      [{ op: 'replace', path: 'name.givenName', value: 'B' }]
    ) as Record<string, any>;
    expect(result.name).toEqual({ givenName: 'B' });
  });
});
