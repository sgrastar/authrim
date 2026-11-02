/**
 * XML Encoding Property-Based Tests
 *
 * Uses fast-check to verify XML parsing, serialization, and security features
 * across a wide range of inputs.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  parseXml,
  serializeXml,
  createDocument,
  createElement,
  setAttribute,
  setTextContent,
  appendChild,
  formatDateTime,
  parseDateTime,
  generateSAMLId,
  base64Encode,
  base64Decode,
  base64UrlEncode,
  base64UrlDecode,
} from '../xml-utils';
import { SAML_NAMESPACES } from '../constants';
import {
  safeXmlTextArb,
  mixedXmlTextArb,
  xxeAttackPatternArb,
  billionLaughsPatternArb,
  samlIdArb,
  samlDateTimeArb,
} from './helpers/fc-generators';

// =============================================================================
// Base64 Encoding Properties
// =============================================================================

describe('XML Encoding Property Tests', () => {
  describe('Base64 Encoding Properties', () => {
    it('∀ string: base64Decode(base64Encode(s)) === s (round-trip)', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 0, maxLength: 1000 }), (s) => {
          const encoded = base64Encode(s);
          const decoded = base64Decode(encoded);
          expect(decoded).toBe(s);
        }),
        { numRuns: 200 }
      );
    });

    it('∀ string: base64Encode produces valid base64 characters', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1, maxLength: 500 }), (s) => {
          const encoded = base64Encode(s);
          // Base64 characters: A-Z, a-z, 0-9, +, /, =
          expect(encoded).toMatch(/^[A-Za-z0-9+/=]*$/);
        }),
        { numRuns: 200 }
      );
    });

    it('∀ string: base64UrlDecode(base64UrlEncode(s)) === s (round-trip)', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 0, maxLength: 500 }), (s) => {
          const encoded = base64UrlEncode(s);
          const decoded = base64UrlDecode(encoded);
          expect(decoded).toBe(s);
        }),
        { numRuns: 200 }
      );
    });

    it('∀ string: base64UrlEncode produces URL-safe characters', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1, maxLength: 500 }), (s) => {
          const encoded = base64UrlEncode(s);
          // Base64URL characters: A-Z, a-z, 0-9, -, _ (no padding)
          expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
          // Should not contain standard base64 special chars
          expect(encoded).not.toContain('+');
          expect(encoded).not.toContain('/');
          expect(encoded).not.toContain('=');
        }),
        { numRuns: 200 }
      );
    });

    it('base64 vs base64url: same content, different encoding', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 10, maxLength: 100 }), (s) => {
          const base64 = base64Encode(s);
          const base64url = base64UrlEncode(s);

          // If base64 contains special chars, base64url should be different
          if (/[+/=]/.test(base64)) {
            expect(base64url).not.toBe(base64);
          }

          // Both should decode to same value
          const decoded64 = base64Decode(base64);
          const decodedUrl = base64UrlDecode(base64url);
          expect(decoded64).toBe(s);
          expect(decodedUrl).toBe(s);
        }),
        { numRuns: 100 }
      );
    });
  });

  // =============================================================================
  // DateTime Formatting Properties
  // =============================================================================

  describe('DateTime Formatting Properties', () => {
    it('∀ valid Date: formatDateTime produces ISO format without milliseconds', () => {
      fc.assert(
        fc.property(
          fc.integer({
            min: new Date('2020-01-01').getTime(),
            max: new Date('2025-12-31').getTime(),
          }),
          (timestamp) => {
            const date = new Date(timestamp);
            const formatted = formatDateTime(date);

            // Should end with Z (UTC)
            expect(formatted).toMatch(/Z$/);

            // Should not have milliseconds
            expect(formatted).not.toMatch(/\.\d{3}Z$/);

            // Should be valid ISO format
            expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('∀ valid Date: parseDateTime(formatDateTime(d)) preserves date (within second)', () => {
      fc.assert(
        fc.property(
          fc.integer({
            min: new Date('2020-01-01').getTime(),
            max: new Date('2025-12-31').getTime(),
          }),
          (timestamp) => {
            const date = new Date(timestamp);
            const formatted = formatDateTime(date);
            const parsed = parseDateTime(formatted);

            // Should be within 1 second (milliseconds are stripped)
            const diff = Math.abs(parsed.getTime() - date.getTime());
            expect(diff).toBeLessThan(1000);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('parseDateTime throws for invalid date strings', () => {
      const invalidDates = [
        'not-a-date',
        '2024-13-01T00:00:00Z', // Invalid month
        '2024-01-32T00:00:00Z', // Invalid day
        '',
      ];

      for (const invalid of invalidDates) {
        expect(() => parseDateTime(invalid)).toThrow('Invalid date format');
      }
    });
  });

  // =============================================================================
  // SAML ID Generation Properties
  // =============================================================================

  describe('SAML ID Generation Properties', () => {
    it('generateSAMLId produces ID starting with underscore', () => {
      for (let i = 0; i < 100; i++) {
        const id = generateSAMLId();
        expect(id).toMatch(/^_/);
      }
    });

    it('generateSAMLId produces hex characters after underscore', () => {
      for (let i = 0; i < 100; i++) {
        const id = generateSAMLId();
        expect(id).toMatch(/^_[0-9a-f]+$/);
      }
    });

    it('generateSAMLId produces 33-character IDs', () => {
      // _ + 32 hex chars = 33 characters
      for (let i = 0; i < 100; i++) {
        const id = generateSAMLId();
        expect(id.length).toBe(33);
      }
    });

    it('generateSAMLId produces unique IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        ids.add(generateSAMLId());
      }
      // All 1000 should be unique
      expect(ids.size).toBe(1000);
    });
  });

  // =============================================================================
  // XML Parse/Serialize Properties
  // =============================================================================

  describe('XML Parse/Serialize Properties', () => {
    it('∀ simple XML document: serializeXml(parseXml(xml)) preserves structure', () => {
      fc.assert(
        fc.property(safeXmlTextArb, (text) => {
          const xml = `<?xml version="1.0"?><root>${text}</root>`;
          const doc = parseXml(xml);
          const serialized = serializeXml(doc);

          expect(serialized).toContain('<root>');
          expect(serialized).toContain('</root>');
          expect(serialized).toContain(text);
        }),
        { numRuns: 100 }
      );
    });

    it('∀ element with attributes: attributes are preserved', () => {
      fc.assert(
        fc.property(samlIdArb, samlDateTimeArb, (id, instant) => {
          const xml = `<?xml version="1.0"?><root ID="${id}" IssueInstant="${instant}"/>`;
          const doc = parseXml(xml);
          const root = doc.documentElement;

          expect(root).not.toBeNull();
          expect(root.getAttribute('ID')).toBe(id);
          expect(root.getAttribute('IssueInstant')).toBe(instant);
        }),
        { numRuns: 100 }
      );
    });
  });

  // =============================================================================
  // XML Creation Properties
  // =============================================================================

  describe('XML Creation Properties', () => {
    it('createElement with namespace: produces namespaced element', () => {
      fc.assert(
        fc.property(fc.constantFrom('Request', 'Response', 'Issuer', 'NameID'), (localName) => {
          const doc = createDocument();
          const elem = createElement(doc, SAML_NAMESPACES.SAML2P, localName, 'samlp');

          expect(elem.localName).toBe(localName);
          expect(elem.namespaceURI).toBe(SAML_NAMESPACES.SAML2P);
        }),
        { numRuns: 50 }
      );
    });

    it('setAttribute: sets attribute value correctly', () => {
      fc.assert(
        fc.property(samlIdArb, (value) => {
          const doc = createDocument();
          const elem = createElement(doc, SAML_NAMESPACES.SAML2P, 'Request', 'samlp');
          setAttribute(elem, 'ID', value);

          expect(elem.getAttribute('ID')).toBe(value);
        }),
        { numRuns: 50 }
      );
    });

    it('setTextContent: sets text content correctly', () => {
      fc.assert(
        fc.property(safeXmlTextArb, (text) => {
          const doc = createDocument();
          const elem = createElement(doc, SAML_NAMESPACES.SAML2, 'Issuer', 'saml');
          setTextContent(elem, text);

          expect(elem.textContent).toBe(text);
        }),
        { numRuns: 50 }
      );
    });

    it('appendChild: child is added to parent', () => {
      const doc = createDocument();
      const parent = createElement(doc, SAML_NAMESPACES.SAML2P, 'Request', 'samlp');
      const child = createElement(doc, SAML_NAMESPACES.SAML2, 'Issuer', 'saml');

      appendChild(parent, child);

      expect(parent.childNodes.length).toBe(1);
      expect(parent.firstChild).toBe(child);
    });
  });

  // =============================================================================
  // XXE Security Properties
  // =============================================================================

  describe('XXE Security Properties', () => {
    it('∀ XXE attack pattern: parseXml rejects the input', () => {
      fc.assert(
        fc.property(xxeAttackPatternArb, (maliciousXml) => {
          expect(() => parseXml(maliciousXml)).toThrow(/XML security error/);
        }),
        { numRuns: 50 }
      );
    });

    it('billion laughs attack: parseXml rejects the input', () => {
      fc.assert(
        fc.property(billionLaughsPatternArb, (attack) => {
          expect(() => parseXml(attack)).toThrow(/XML security error/);
        }),
        { numRuns: 10 }
      );
    });

    it('DOCTYPE declaration: parseXml rejects input with DOCTYPE', () => {
      const doctypePatterns = [
        '<!DOCTYPE foo><foo/>',
        '<!DOCTYPE foo SYSTEM "http://evil.com/foo.dtd"><foo/>',
        '<?xml version="1.0"?><!DOCTYPE test><test/>',
      ];

      for (const pattern of doctypePatterns) {
        expect(() => parseXml(pattern)).toThrow(/DOCTYPE/);
      }
    });

    it('ENTITY declaration: parseXml rejects input with ENTITY', () => {
      const entityPatterns = [
        '<!ENTITY test "value"><foo/>',
        '<?xml version="1.0"?><!ENTITY xxe SYSTEM "file:///etc/passwd"><foo/>',
      ];

      for (const pattern of entityPatterns) {
        expect(() => parseXml(pattern)).toThrow(/XML security error/);
      }
    });

    it('SYSTEM reference: parseXml rejects input with SYSTEM', () => {
      expect(() => parseXml('SYSTEM "file:///etc/passwd"')).toThrow(/XML security error/);
    });

    it('PUBLIC reference: parseXml rejects input with PUBLIC', () => {
      expect(() => parseXml('PUBLIC "-//W3C//DTD" "http://evil.com"')).toThrow(
        /XML security error/
      );
    });
  });

  // =============================================================================
  // Valid SAML Document Properties
  // =============================================================================

  describe('Valid SAML Document Properties', () => {
    it('valid SAML message: parseXml succeeds', () => {
      const validSamlXmls = [
        `<?xml version="1.0"?>
         <samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
           xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
           ID="_test" Version="2.0" IssueInstant="2024-01-01T00:00:00Z">
           <saml:Issuer>https://example.com</saml:Issuer>
           <saml:NameID>user@example.com</saml:NameID>
         </samlp:LogoutRequest>`,
        `<?xml version="1.0"?>
         <samlp:LogoutResponse xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
           xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
           ID="_test" Version="2.0" IssueInstant="2024-01-01T00:00:00Z" InResponseTo="_req">
           <saml:Issuer>https://example.com</saml:Issuer>
           <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
         </samlp:LogoutResponse>`,
      ];

      for (const xml of validSamlXmls) {
        expect(() => parseXml(xml)).not.toThrow();
      }
    });
  });
});
