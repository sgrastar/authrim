/**
 * fast-check Custom Arbitraries for SCIM Property-Based Testing
 *
 * RFC 7643/7644 compliant generators for testing SCIM filter parsing,
 * resource mapping, and patch operations.
 *
 * Note: Uses fast-check v4 API (string with unit constraint)
 */

import * as fc from 'fast-check';
import type { InternalUser, InternalGroup } from '../../utils/scim-mapper';
import type { ScimUser, ScimGroup, ScimEmail, ScimName, ScimAddress } from '../../types/scim';

// =============================================================================
// SCIM Filter Generators
// =============================================================================

/**
 * Valid SCIM attribute names for filtering
 */
const SCIM_ATTRIBUTES = [
  'userName',
  'email',
  'displayName',
  'active',
  'name.familyName',
  'name.givenName',
  'externalId',
  'id',
  'meta.created',
  'meta.lastModified',
];

/**
 * SCIM comparison operators
 */
const SCIM_COMPARISON_OPERATORS = ['eq', 'ne', 'co', 'sw', 'ew', 'gt', 'ge', 'lt', 'le'] as const;

/**
 * SCIM operator (including 'pr' which doesn't take a value)
 */
export const scimOperatorArb = fc.constantFrom(...SCIM_COMPARISON_OPERATORS);

/**
 * SCIM attribute name
 */
export const scimAttributeArb = fc.constantFrom(...SCIM_ATTRIBUTES);

/**
 * Safe SCIM filter string value (no quotes or special chars that break parsing)
 */
export const scimStringValueArb = fc.string({
  unit: fc.constantFrom(
    ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.@'.split('')
  ),
  minLength: 1,
  maxLength: 50,
});

/**
 * SCIM filter value (string, number, boolean, or null)
 */
export const scimValueArb = fc.oneof(
  scimStringValueArb,
  fc.boolean(),
  fc.integer({ min: -1000000, max: 1000000 })
);

/**
 * Simple SCIM filter: attribute operator value
 * Example: userName eq "john"
 */
export const scimSimpleFilterArb = fc
  .tuple(scimAttributeArb, scimOperatorArb, scimValueArb)
  .map(([attr, op, value]) => {
    if (typeof value === 'string') {
      return `${attr} ${op} "${value}"`;
    } else if (typeof value === 'boolean') {
      return `${attr} ${op} ${value}`;
    } else {
      return `${attr} ${op} ${value}`;
    }
  });

/**
 * SCIM 'pr' (present) filter
 * Example: userName pr
 */
export const scimPresentFilterArb = scimAttributeArb.map((attr) => `${attr} pr`);

/**
 * Basic SCIM filter (simple or present)
 */
export const scimBasicFilterArb = fc.oneof(scimSimpleFilterArb, scimPresentFilterArb);

/**
 * SCIM filter with AND operator
 * Example: userName eq "john" and active eq true
 */
export const scimAndFilterArb = fc
  .tuple(scimBasicFilterArb, scimBasicFilterArb)
  .map(([left, right]) => `${left} and ${right}`);

/**
 * SCIM filter with OR operator
 * Example: userName eq "john" or userName eq "jane"
 */
export const scimOrFilterArb = fc
  .tuple(scimBasicFilterArb, scimBasicFilterArb)
  .map(([left, right]) => `${left} or ${right}`);

/**
 * SCIM filter with NOT operator
 * Example: not (userName eq "john")
 */
export const scimNotFilterArb = scimBasicFilterArb.map((filter) => `not (${filter})`);

/**
 * SCIM filter with grouping
 * Example: (userName eq "john")
 */
export const scimGroupedFilterArb = scimBasicFilterArb.map((filter) => `(${filter})`);

/**
 * Valid SCIM filter (basic, and, or, not, grouped)
 */
export const scimValidFilterArb = fc.oneof(
  scimBasicFilterArb,
  scimAndFilterArb,
  scimOrFilterArb,
  scimNotFilterArb,
  scimGroupedFilterArb
);

/**
 * Invalid SCIM filter: unknown operator
 */
export const scimInvalidOperatorArb = fc
  .tuple(
    scimAttributeArb,
    fc.constantFrom('equals', 'like', 'contains', 'matches', '==', '!='),
    scimStringValueArb
  )
  .map(([attr, op, value]) => `${attr} ${op} "${value}"`);

/**
 * Invalid SCIM filter: missing value
 */
export const scimMissingValueFilterArb = fc
  .tuple(scimAttributeArb, scimOperatorArb)
  .map(([attr, op]) => `${attr} ${op}`);

/**
 * Invalid SCIM filter: unbalanced parentheses
 * Note: Some parsers may accept trailing ) after a complete expression
 */
export const scimUnbalancedParenArb = fc.oneof(
  scimSimpleFilterArb.map((f) => `(${f}`),
  scimSimpleFilterArb.map((f) => `((${f})`),
  fc.constant('(userName eq "test"'),
  fc.constant('((userName eq "test")')
);

// =============================================================================
// Internal User Generators
// =============================================================================

/**
 * Valid email address
 */
export const emailArb = fc
  .tuple(
    fc.string({
      unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
      minLength: 3,
      maxLength: 20,
    }),
    fc.constantFrom('example.com', 'test.org', 'company.co.jp', 'authrim.dev')
  )
  .map(([local, domain]) => `${local}@${domain}`);

/**
 * UUID v4
 */
export const uuidArb = fc.uuid();

/**
 * ISO date string (constrained to valid range)
 * Uses integer-based generation to avoid fc.date shrinking issues
 */
export const isoDateArb = fc
  .integer({
    min: new Date('2020-01-01T00:00:00.000Z').getTime(),
    max: new Date('2025-12-31T23:59:59.999Z').getTime(),
  })
  .map((timestamp) => new Date(timestamp).toISOString());

/**
 * Optional ISO date string
 */
export const optionalIsoDateArb = fc.oneof(
  isoDateArb.map((s) => s as string | undefined),
  fc.constant(undefined as string | undefined)
);

/**
 * Valid name string
 */
export const nameArb = fc.string({
  unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ '.split('')),
  minLength: 2,
  maxLength: 30,
});

/**
 * Internal User generator
 */
export const internalUserArb: fc.Arbitrary<InternalUser> = fc.record({
  id: uuidArb,
  tenant_id: fc.option(uuidArb, { nil: undefined }),
  email: emailArb,
  email_verified: fc.constantFrom(0, 1),
  name: fc.option(nameArb, { nil: null }),
  given_name: fc.option(nameArb, { nil: null }),
  family_name: fc.option(nameArb, { nil: null }),
  middle_name: fc.option(nameArb, { nil: null }),
  nickname: fc.option(nameArb, { nil: null }),
  preferred_username: fc.option(emailArb, { nil: null }),
  profile: fc.option(fc.webUrl(), { nil: null }),
  picture: fc.option(fc.webUrl(), { nil: null }),
  website: fc.option(fc.webUrl(), { nil: null }),
  gender: fc.option(fc.constantFrom('male', 'female', 'other'), { nil: null }),
  birthdate: fc.option(
    fc
      .integer({
        min: new Date('1950-01-01T00:00:00.000Z').getTime(),
        max: new Date('2010-01-01T00:00:00.000Z').getTime(),
      })
      .map((timestamp) => new Date(timestamp).toISOString().slice(0, 10)),
    { nil: null }
  ),
  zoneinfo: fc.option(fc.constantFrom('Asia/Tokyo', 'America/New_York', 'Europe/London'), {
    nil: null,
  }),
  locale: fc.option(fc.constantFrom('en-US', 'ja-JP', 'de-DE'), { nil: null }),
  phone_number: fc.option(
    fc.string({ unit: fc.constantFrom(...'0123456789+-'.split('')), minLength: 10, maxLength: 15 }),
    { nil: null }
  ),
  phone_number_verified: fc.option(fc.constantFrom(0, 1), { nil: undefined }),
  address_json: fc.option(fc.constant(null), { nil: null }),
  updated_at: isoDateArb,
  created_at: isoDateArb,
  custom_attributes_json: fc.option(fc.constant(null), { nil: null }),
  password_hash: fc.option(fc.constant(null), { nil: null }),
  external_id: fc.option(uuidArb, { nil: null }),
  active: fc.option(fc.constantFrom(0, 1), { nil: undefined }),
});

/**
 * Minimal Internal User (required fields only)
 */
export const minimalInternalUserArb: fc.Arbitrary<InternalUser> = fc.record({
  id: uuidArb,
  email: emailArb,
  email_verified: fc.constantFrom(0, 1),
  updated_at: isoDateArb,
  created_at: isoDateArb,
});

// =============================================================================
// Internal Group Generators
// =============================================================================

/**
 * Internal Group generator
 */
export const internalGroupArb: fc.Arbitrary<InternalGroup> = fc.record({
  id: uuidArb,
  name: nameArb,
  description: fc.option(fc.string({ minLength: 10, maxLength: 100 }), { nil: null }),
  created_at: isoDateArb,
  updated_at: optionalIsoDateArb,
  external_id: fc.option(uuidArb, { nil: null }),
});

// =============================================================================
// SCIM User Generators
// =============================================================================

/**
 * SCIM Name object
 */
export const scimNameArb: fc.Arbitrary<ScimName> = fc.record({
  formatted: fc.option(nameArb, { nil: undefined }),
  familyName: fc.option(nameArb, { nil: undefined }),
  givenName: fc.option(nameArb, { nil: undefined }),
  middleName: fc.option(nameArb, { nil: undefined }),
  honorificPrefix: fc.option(fc.constantFrom('Mr.', 'Ms.', 'Dr.'), { nil: undefined }),
  honorificSuffix: fc.option(fc.constantFrom('Jr.', 'Sr.', 'III'), { nil: undefined }),
});

/**
 * SCIM Email object
 */
export const scimEmailArb: fc.Arbitrary<ScimEmail> = fc.record({
  value: emailArb,
  type: fc.option(fc.constantFrom('work', 'home', 'other'), { nil: undefined }),
  primary: fc.option(fc.boolean(), { nil: undefined }),
  display: fc.option(emailArb, { nil: undefined }),
});

/**
 * SCIM Address object
 */
export const scimAddressArb: fc.Arbitrary<ScimAddress> = fc.record({
  formatted: fc.option(fc.string({ minLength: 10, maxLength: 100 }), { nil: undefined }),
  streetAddress: fc.option(fc.string({ minLength: 5, maxLength: 50 }), { nil: undefined }),
  locality: fc.option(fc.constantFrom('Tokyo', 'New York', 'London'), { nil: undefined }),
  region: fc.option(fc.constantFrom('Tokyo', 'NY', 'Greater London'), { nil: undefined }),
  postalCode: fc.option(
    fc.string({ unit: fc.constantFrom(...'0123456789-'.split('')), minLength: 5, maxLength: 10 }),
    { nil: undefined }
  ),
  country: fc.option(fc.constantFrom('JP', 'US', 'GB'), { nil: undefined }),
  type: fc.option(fc.constantFrom('work', 'home'), { nil: undefined }),
  primary: fc.option(fc.boolean(), { nil: undefined }),
});

/**
 * SCIM Group (partial, for testing scimToGroup)
 */
export const partialScimGroupArb = fc.record({
  displayName: fc.option(nameArb, { nil: undefined }),
  externalId: fc.option(uuidArb, { nil: undefined }),
});

// =============================================================================
// Patch Operation Generators
// =============================================================================

/**
 * Safe path for patch operations (no prototype pollution)
 */
export const safePatchPathArb = fc.constantFrom(
  'displayName',
  'nickName',
  'active',
  'name.givenName',
  'name.familyName',
  'emails',
  'phoneNumbers',
  'locale',
  'timezone'
);

/**
 * Dangerous path for prototype pollution testing
 */
export const dangerousPatchPathArb = fc.constantFrom(
  '__proto__',
  'constructor',
  'prototype',
  '__proto__.polluted',
  'constructor.prototype',
  '__proto__.constructor'
);

/**
 * Valid patch operation
 */
export const validPatchOpArb = fc.record({
  op: fc.constantFrom('add', 'replace', 'remove') as fc.Arbitrary<'add' | 'replace' | 'remove'>,
  path: safePatchPathArb,
  value: fc.option(scimValueArb, { nil: undefined }),
});

/**
 * Prototype pollution patch operation
 */
export const prototypePollutionPatchOpArb = fc.record({
  op: fc.constantFrom('add', 'replace') as fc.Arbitrary<'add' | 'replace'>,
  path: dangerousPatchPathArb,
  value: fc.string({ minLength: 1, maxLength: 20 }),
});
