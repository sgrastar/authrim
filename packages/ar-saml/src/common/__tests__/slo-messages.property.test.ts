/**
 * SAML SLO Messages Property-Based Tests
 *
 * Uses fast-check to verify SAML Single Logout message building and parsing
 * across a wide range of inputs, ensuring correctness and security.
 *
 * SAML 2.0 Core Specification Section 3.7 - Single Logout Protocol
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  buildLogoutRequest,
  buildLogoutResponse,
  parseLogoutRequestXml,
  parseLogoutResponseXml,
  encodeForPostBinding,
  encodeForRedirectBinding,
} from '../slo-messages';
import { base64Decode } from '../xml-utils';
import * as pako from 'pako';
import {
  logoutRequestOptionsArb,
  minimalLogoutRequestOptionsArb,
  logoutResponseOptionsArb,
  minimalLogoutResponseOptionsArb,
  samlIdArb,
  samlDateTimeArb,
  entityIdArb,
  samlUrlArb,
  nameIdValueArb,
  nameIdFormatArb,
  sessionIndexArb,
  statusCodeArb,
} from './helpers/fc-generators';
import { STATUS_CODES } from '../constants';

// =============================================================================
// LogoutRequest Build/Parse Round-Trip Properties
// =============================================================================

describe('SAML SLO Messages Property Tests', () => {
  describe('LogoutRequest Build/Parse Round-Trip', () => {
    it('∀ LogoutRequestOptions: parseLogoutRequestXml(buildLogoutRequest(opts)) preserves core fields', () => {
      fc.assert(
        fc.property(minimalLogoutRequestOptionsArb, (opts) => {
          const xml = buildLogoutRequest(opts);
          const parsed = parseLogoutRequestXml(xml);

          expect(parsed.id).toBe(opts.id);
          expect(parsed.issueInstant).toBe(opts.issueInstant);
          expect(parsed.issuer).toBe(opts.issuer);
          expect(parsed.destination).toBe(opts.destination);
          expect(parsed.nameId).toBe(opts.nameId);
          expect(parsed.nameIdFormat).toBe(opts.nameIdFormat);
        }),
        { numRuns: 200 }
      );
    });

    it('∀ LogoutRequestOptions with sessionIndex: sessionIndex is preserved', () => {
      fc.assert(
        fc.property(minimalLogoutRequestOptionsArb, sessionIndexArb, (opts, sessionIndex) => {
          const optsWithSession = { ...opts, sessionIndex };
          const xml = buildLogoutRequest(optsWithSession);
          const parsed = parseLogoutRequestXml(xml);

          expect(parsed.sessionIndex).toBe(sessionIndex);
          expect(parsed.sessionIndices).toContain(sessionIndex);
        }),
        { numRuns: 100 }
      );
    });

    it('∀ LogoutRequestOptions: buildLogoutRequest produces valid XML', () => {
      fc.assert(
        fc.property(logoutRequestOptionsArb, (opts) => {
          const xml = buildLogoutRequest(opts);

          // Should have XML declaration
          expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');

          // Should have LogoutRequest element
          expect(xml).toContain('<samlp:LogoutRequest');
          expect(xml).toContain('</samlp:LogoutRequest>');

          // Should have required attributes
          expect(xml).toContain(`ID="${opts.id}"`);
          expect(xml).toContain('Version="2.0"');
          expect(xml).toContain(`IssueInstant="${opts.issueInstant}"`);
          expect(xml).toContain(`Destination="${opts.destination}"`);

          // Should have Issuer element
          expect(xml).toContain('<saml:Issuer>');
          expect(xml).toContain(opts.issuer);

          // Should have NameID element
          expect(xml).toContain('<saml:NameID');
          expect(xml).toContain(opts.nameId);
        }),
        { numRuns: 200 }
      );
    });

    it('∀ LogoutRequestOptions with optional fields: optional fields are included when provided', () => {
      fc.assert(
        fc.property(logoutRequestOptionsArb, (opts) => {
          const xml = buildLogoutRequest(opts);

          if (opts.sessionIndex) {
            expect(xml).toContain('<samlp:SessionIndex>');
            expect(xml).toContain(opts.sessionIndex);
          }

          if (opts.reason) {
            expect(xml).toContain(`Reason="${opts.reason}"`);
          }

          if (opts.notOnOrAfter) {
            expect(xml).toContain(`NotOnOrAfter="${opts.notOnOrAfter}"`);
          }
        }),
        { numRuns: 100 }
      );
    });
  });

  // =============================================================================
  // LogoutResponse Build/Parse Round-Trip Properties
  // =============================================================================

  describe('LogoutResponse Build/Parse Round-Trip', () => {
    it('∀ LogoutResponseOptions: parseLogoutResponseXml(buildLogoutResponse(opts)) preserves core fields', () => {
      fc.assert(
        fc.property(minimalLogoutResponseOptionsArb, (opts) => {
          const xml = buildLogoutResponse(opts);
          const parsed = parseLogoutResponseXml(xml);

          expect(parsed.id).toBe(opts.id);
          expect(parsed.issueInstant).toBe(opts.issueInstant);
          expect(parsed.issuer).toBe(opts.issuer);
          expect(parsed.destination).toBe(opts.destination);
          expect(parsed.inResponseTo).toBe(opts.inResponseTo);
        }),
        { numRuns: 200 }
      );
    });

    it('∀ LogoutResponseOptions: default status is Success', () => {
      fc.assert(
        fc.property(minimalLogoutResponseOptionsArb, (opts) => {
          const xml = buildLogoutResponse(opts);
          const parsed = parseLogoutResponseXml(xml);

          expect(parsed.statusCode).toBe(STATUS_CODES.SUCCESS);
        }),
        { numRuns: 100 }
      );
    });

    it('∀ LogoutResponseOptions with status: status code is preserved', () => {
      fc.assert(
        fc.property(minimalLogoutResponseOptionsArb, statusCodeArb, (opts, statusCode) => {
          const optsWithStatus = { ...opts, statusCode };
          const xml = buildLogoutResponse(optsWithStatus);
          const parsed = parseLogoutResponseXml(xml);

          expect(parsed.statusCode).toBe(statusCode);
        }),
        { numRuns: 100 }
      );
    });

    it('∀ LogoutResponseOptions: buildLogoutResponse produces valid XML', () => {
      fc.assert(
        fc.property(logoutResponseOptionsArb, (opts) => {
          const xml = buildLogoutResponse(opts);

          // Should have XML declaration
          expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');

          // Should have LogoutResponse element
          expect(xml).toContain('<samlp:LogoutResponse');
          expect(xml).toContain('</samlp:LogoutResponse>');

          // Should have required attributes
          expect(xml).toContain(`ID="${opts.id}"`);
          expect(xml).toContain('Version="2.0"');
          expect(xml).toContain(`IssueInstant="${opts.issueInstant}"`);
          expect(xml).toContain(`Destination="${opts.destination}"`);
          expect(xml).toContain(`InResponseTo="${opts.inResponseTo}"`);

          // Should have Status element
          expect(xml).toContain('<samlp:Status>');
          expect(xml).toContain('<samlp:StatusCode');
        }),
        { numRuns: 200 }
      );
    });

    it('∀ LogoutResponseOptions with statusMessage: message is included', () => {
      fc.assert(
        fc.property(
          minimalLogoutResponseOptionsArb,
          fc.constantFrom('Logout successful', 'Session terminated'),
          (opts, statusMessage) => {
            const optsWithMessage = { ...opts, statusMessage };
            const xml = buildLogoutResponse(optsWithMessage);

            expect(xml).toContain('<samlp:StatusMessage>');
            expect(xml).toContain(statusMessage);
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // =============================================================================
  // Encoding/Decoding Round-Trip Properties
  // =============================================================================

  describe('Encoding/Decoding Round-Trip', () => {
    it('∀ XML string: POST binding encodeForPostBinding is reversible with base64Decode', () => {
      fc.assert(
        fc.property(minimalLogoutRequestOptionsArb, (opts) => {
          const xml = buildLogoutRequest(opts);
          const encoded = encodeForPostBinding(xml);
          const decoded = base64Decode(encoded);

          expect(decoded).toBe(xml);
        }),
        { numRuns: 100 }
      );
    });

    it('∀ XML string: Redirect binding encodeForRedirectBinding is reversible', () => {
      fc.assert(
        fc.property(minimalLogoutRequestOptionsArb, (opts) => {
          const xml = buildLogoutRequest(opts);
          const encoded = encodeForRedirectBinding(xml);

          // Decode the redirect binding encoding
          // First restore base64 padding
          let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
          while (base64.length % 4 !== 0) {
            base64 += '=';
          }

          // Then decode base64 and inflate
          const compressed = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          const inflated = pako.inflateRaw(compressed, { toText: true });

          expect(inflated).toBe(xml);
        }),
        { numRuns: 100 }
      );
    });

    it('∀ LogoutResponse: POST and Redirect bindings produce different encodings', () => {
      fc.assert(
        fc.property(minimalLogoutResponseOptionsArb, (opts) => {
          const xml = buildLogoutResponse(opts);
          const postEncoded = encodeForPostBinding(xml);
          const redirectEncoded = encodeForRedirectBinding(xml);

          // They should be different (deflate compression changes output)
          expect(postEncoded).not.toBe(redirectEncoded);

          // Redirect should be shorter due to compression
          expect(redirectEncoded.length).toBeLessThan(postEncoded.length);
        }),
        { numRuns: 50 }
      );
    });
  });

  // =============================================================================
  // Parse Error Handling Properties
  // =============================================================================

  describe('Parse Error Handling', () => {
    it('empty string: parseLogoutRequestXml throws error', () => {
      expect(() => parseLogoutRequestXml('')).toThrow();
    });

    it('invalid XML: parseLogoutRequestXml throws error', () => {
      const invalidXmls = [
        '<not-a-logout-request/>',
        '<LogoutRequest/>',
        '<samlp:LogoutRequest>', // No closing tag
        'not xml at all',
      ];

      for (const xml of invalidXmls) {
        expect(() => parseLogoutRequestXml(xml)).toThrow();
      }
    });

    it('∀ LogoutRequest XML missing required elements: throws error', () => {
      // Missing Issuer
      const noIssuer = `<?xml version="1.0"?>
        <samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
          ID="_test" IssueInstant="2024-01-01T00:00:00Z">
          <saml:NameID xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">user@example.com</saml:NameID>
        </samlp:LogoutRequest>`;

      expect(() => parseLogoutRequestXml(noIssuer)).toThrow('missing Issuer');

      // Missing NameID
      const noNameId = `<?xml version="1.0"?>
        <samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
          xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
          ID="_test" IssueInstant="2024-01-01T00:00:00Z">
          <saml:Issuer>https://example.com</saml:Issuer>
        </samlp:LogoutRequest>`;

      expect(() => parseLogoutRequestXml(noNameId)).toThrow('missing NameID');
    });

    it('empty string: parseLogoutResponseXml throws error', () => {
      expect(() => parseLogoutResponseXml('')).toThrow();
    });

    it('invalid XML: parseLogoutResponseXml throws error', () => {
      const invalidXmls = ['<not-a-logout-response/>', '<LogoutResponse/>', 'not xml at all'];

      for (const xml of invalidXmls) {
        expect(() => parseLogoutResponseXml(xml)).toThrow();
      }
    });
  });

  // =============================================================================
  // NameID Format Properties
  // =============================================================================

  describe('NameID Format Properties', () => {
    it('∀ NameID format: format attribute is correctly included', () => {
      fc.assert(
        fc.property(minimalLogoutRequestOptionsArb, (opts) => {
          const xml = buildLogoutRequest(opts);
          expect(xml).toContain(`Format="${opts.nameIdFormat}"`);

          const parsed = parseLogoutRequestXml(xml);
          expect(parsed.nameIdFormat).toBe(opts.nameIdFormat);
        }),
        { numRuns: 100 }
      );
    });
  });

  // =============================================================================
  // SAML ID Properties
  // =============================================================================

  describe('SAML ID Properties', () => {
    it('∀ SAML ID: ID attribute is preserved exactly', () => {
      fc.assert(
        fc.property(
          samlIdArb,
          samlDateTimeArb,
          entityIdArb,
          samlUrlArb,
          nameIdValueArb,
          nameIdFormatArb,
          (id, issueInstant, issuer, destination, nameId, nameIdFormat) => {
            const opts = { id, issueInstant, issuer, destination, nameId, nameIdFormat };
            const xml = buildLogoutRequest(opts);
            const parsed = parseLogoutRequestXml(xml);

            expect(parsed.id).toBe(id);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('∀ different IDs: produce different requests', () => {
      fc.assert(
        fc.property(samlIdArb, samlIdArb, minimalLogoutRequestOptionsArb, (id1, id2, baseOpts) => {
          // Skip if IDs are the same
          if (id1 === id2) return;

          const xml1 = buildLogoutRequest({ ...baseOpts, id: id1 });
          const xml2 = buildLogoutRequest({ ...baseOpts, id: id2 });

          expect(xml1).not.toBe(xml2);
          expect(xml1).toContain(`ID="${id1}"`);
          expect(xml2).toContain(`ID="${id2}"`);
        }),
        { numRuns: 50 }
      );
    });
  });

  // =============================================================================
  // Namespace Properties
  // =============================================================================

  describe('Namespace Properties', () => {
    it('∀ LogoutRequest: includes correct SAML namespaces', () => {
      fc.assert(
        fc.property(minimalLogoutRequestOptionsArb, (opts) => {
          const xml = buildLogoutRequest(opts);

          // Should have protocol namespace
          expect(xml).toContain('xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"');

          // Should have assertion namespace
          expect(xml).toContain('xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"');
        }),
        { numRuns: 50 }
      );
    });

    it('∀ LogoutResponse: includes correct SAML namespaces', () => {
      fc.assert(
        fc.property(minimalLogoutResponseOptionsArb, (opts) => {
          const xml = buildLogoutResponse(opts);

          expect(xml).toContain('xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"');
          expect(xml).toContain('xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"');
        }),
        { numRuns: 50 }
      );
    });
  });
});
