/**
 * Single Logout (SLO) Security Tests
 *
 * Tests based on SAML 2.0 Profiles Specification Section 4.4:
 * - LogoutRequest/LogoutResponse validation
 * - Time bound validation (NotOnOrAfter, IssueInstant)
 * - SessionIndex handling
 * - Status code processing
 * - Signature verification
 *
 * Security-critical validations:
 * - NotOnOrAfter must be checked to prevent replay attacks
 * - IssueInstant freshness prevents old requests
 * - SessionIndex must match to terminate correct session
 * - Signature on LogoutRequest/Response prevents forgery
 *
 * @see https://docs.oasis-open.org/security/saml/v2.0/saml-profiles-2.0-os.pdf
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildLogoutRequest,
  buildLogoutResponse,
  parseLogoutRequestXml,
  parseLogoutResponseXml,
  encodeForPostBinding,
  type LogoutRequestOptions,
  type LogoutResponseOptions,
} from '../slo-messages';
import { STATUS_CODES, DEFAULTS } from '../constants';
import { signXml, verifyXmlSignature, hasSignature } from '../signature';

// Test certificates (same as other test files)
const testPrivateKey = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC6GHFfTLe7OFyL
R7HdFE5ljqiUyCplJfyfJD0we+WnY7iZ77KnKjnXvZWUMNTC5PAzb9r6i8q7JD1n
c7NKofHSs8+QGtvwzTWLP4SWIcfGG9VV8qUY2xKNJ8TuOazbxg9SK5mmgyd0QwGh
gzIu0hvOKbcTZoKPc1IWyS82qU7xLJrABcti/hLnBg+sKXtesWAh+Xn0DPnCFQYt
Esw/X2ttIPW/4AXQana0FGsDNYYsKB1ufY7lV9allraI5jPHkE/ZfG0GOh56qDw0
AJNOgWrMOQ1LJDpbpDFvhM6eTbUKhPls1IFDgeJFlk032IIbkfuMWEni/M0tOoTe
Kof9dB5RAgMBAAECggEAAKsaVKMjdHoBYerlLEutb/zZAkM41GQ6w709zTPW6ic4
hdkuOJHFPiNVGJf8r/g5jXpXThYeK5Za+I16JhwklOntgUDhPgC7z1weFEbPQfwl
v4IbFmJlNV2rIQ2wwEG8jbEm9Fv1LA5P77mLnaqGbTLmmQptao7WbYKMNfEimob6
v5SouD1axF1filIuY3Wnj6vU6FOT6UZx91QbkIYlcy0/CDwK45sMpSXr1oddHe0K
hP5qaMquY4OewstHFWTEa6Mqlpwoo8fpgrxoEuPr0ldazBgVnkLgkSghlEYoRsiX
nUsHYlF/Yil24nlog+rC5IcGocX1KD+m4qlUxtkfAQKBgQD5Yvged8xotM+1lXsw
q7SFJ1f+XW+MwvNbIsDdWI/mLppej+Tb37Vwtxn1aWPyIZP73Bhy/4BjdshzNCyH
O1fb9IDP/JBhEIRIl33JkMhFylbotJLxUCTi5K2suEpFO84cXTCleI66D8tX5uDJ
BEoJDJVBMHIs19fVxbaLj8NHAQKBgQC/B83dPwEF+5a7JUpOxQNnWhy+zqNd2TU1
jY8rIAZsU5tb1F043p/lUmfbIivDhHx0FVBKnbiMAgupszk6tN5xRSVsDsYBHHu0
FDzYJXDqGZZUxT7q3zWggHud01uEykHkwh6AheACOokKEyGdxgfRVtx4INBDb55d
meMxblmnUQKBgDZNJHWN5EZQSIHjYIWCfbYYkQJj2ewubsrDUHdh10NplldMwapW
la1LUS2smwSX5x8KF5DCrXP64z6id6eidkkAfiPLfKyF6ifcRJllGxaHLlFRMEW3
C7ET1fUr05Arq39lkzgUfg9pbP9g2EUs1+oMgVtGbzXwcaCsgkj1LrIBAoGBAJJo
89IPOMSSF+tlYDdQ7hPnT8K58yG5mPtrfIAr8mBSD+9oqu4sSlZjOzALV4lpYE1E
DJ6zlT7RTokI0OL6vsYHne/cvssZPoI9RIjQ4WK6q6pa5qby3lIeRyAmXq0+qxQd
52zPrmlm3aM4GHqozVMXhLAZTiVxReotSKCZF+ORAoGACY9pYPmFI/2e18PN9xjo
Ht/ng/V8VLikEDl3tT8Zv9+r/83tcrjgmzDlf13tA9s0ac/KqJn2dlxa9oLb6iq0
oHPa1QEDdepuBOyiGmHNf8RHhBm3WsFxXOFKwBE5tGxgIQ529dcnehM6/o84C4eI
egw/OarojpPy6CaPG6w10G8=
-----END PRIVATE KEY-----`;

const testCertificate = `-----BEGIN CERTIFICATE-----
MIIDETCCAfmgAwIBAgIUEgn0BYLRk2hTRQbUKUKgmEofvuowDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNVGVzdCBTQU1MIElkUDAeFw0yNTEyMjAxMjE3MzJaFw0z
NTEyMTgxMjE3MzJaMBgxFjAUBgNVBAMMDVRlc3QgU0FNTCBJZFAwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQC6GHFfTLe7OFyLR7HdFE5ljqiUyCplJfyf
JD0we+WnY7iZ77KnKjnXvZWUMNTC5PAzb9r6i8q7JD1nc7NKofHSs8+QGtvwzTWL
P4SWIcfGG9VV8qUY2xKNJ8TuOazbxg9SK5mmgyd0QwGhgzIu0hvOKbcTZoKPc1IW
yS82qU7xLJrABcti/hLnBg+sKXtesWAh+Xn0DPnCFQYtEsw/X2ttIPW/4AXQana0
FGsDNYYsKB1ufY7lV9allraI5jPHkE/ZfG0GOh56qDw0AJNOgWrMOQ1LJDpbpDFv
hM6eTbUKhPls1IFDgeJFlk032IIbkfuMWEni/M0tOoTeKof9dB5RAgMBAAGjUzBR
MB0GA1UdDgQWBBTvFqiV3zmGR7gvZ4NHg0qBDcscpjAfBgNVHSMEGDAWgBTvFqiV
3zmGR7gvZ4NHg0qBDcscpjAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUA
A4IBAQAtRXwrFZW8H5ycRuiGnmUVprbfv66GrSiknO/fMWvcfD6rYdtckTFN9l8K
REcWpgeNgRhSx4RibZfuH8b+temXXm3/wgEVb/bZHddB/pVVeoTRfcYgOALrklzb
TCRBe6wVyQyrW+EVw/mfuN0COKkYxoe7GTql3l+JA2pK+FoIGShMJg2zpJjscX8+
Cz7UiUaH27x8IE4LGzcxDeZgpqYZDs2Bp1H0jRa4igkvH0zSNRZm0ErgpErOgJbz
p1hSbc73BFCq2TO7acDmxkKKAbQ9nfZhO6cZEqoMgkfRpqV2BrBDC9GBhoK0yaUU
rXDP3Op15iM4yR/FO2uFs9ZPLoHu
-----END CERTIFICATE-----`;

describe('SLO Security - SAML 2.0 Profiles Section 4.4', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('LogoutRequest Building and Parsing', () => {
    it('should build and parse LogoutRequest correctly', () => {
      const options: LogoutRequestOptions = {
        id: '_logout_123',
        issueInstant: new Date().toISOString(),
        issuer: 'https://sp.example.com',
        destination: 'https://idp.example.com/slo',
        nameId: 'user@example.com',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        sessionIndex: '_session_456',
      };

      const xml = buildLogoutRequest(options);
      const parsed = parseLogoutRequestXml(xml);

      expect(parsed.id).toBe('_logout_123');
      expect(parsed.issuer).toBe('https://sp.example.com');
      expect(parsed.nameId).toBe('user@example.com');
      expect(parsed.sessionIndex).toBe('_session_456');
    });

    it('should include NotOnOrAfter when specified', () => {
      const notOnOrAfter = new Date(Date.now() + 300000).toISOString();
      const options: LogoutRequestOptions = {
        id: '_logout_noa',
        issueInstant: new Date().toISOString(),
        issuer: 'https://sp.example.com',
        destination: 'https://idp.example.com/slo',
        nameId: 'user@example.com',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        notOnOrAfter,
      };

      const xml = buildLogoutRequest(options);
      const parsed = parseLogoutRequestXml(xml);

      expect(parsed.notOnOrAfter).toBe(notOnOrAfter);
    });

    it('should include Reason when specified', () => {
      const options: LogoutRequestOptions = {
        id: '_logout_reason',
        issueInstant: new Date().toISOString(),
        issuer: 'https://sp.example.com',
        destination: 'https://idp.example.com/slo',
        nameId: 'user@example.com',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        reason: 'urn:oasis:names:tc:SAML:2.0:logout:user',
      };

      const xml = buildLogoutRequest(options);
      expect(xml).toContain('Reason="urn:oasis:names:tc:SAML:2.0:logout:user"');
    });
  });

  describe('LogoutResponse Building and Parsing', () => {
    it('should build and parse LogoutResponse correctly', () => {
      const options: LogoutResponseOptions = {
        id: '_response_123',
        issueInstant: new Date().toISOString(),
        issuer: 'https://idp.example.com',
        destination: 'https://sp.example.com/slo',
        inResponseTo: '_logout_123',
        statusCode: STATUS_CODES.SUCCESS,
      };

      const xml = buildLogoutResponse(options);
      const parsed = parseLogoutResponseXml(xml);

      expect(parsed.id).toBe('_response_123');
      expect(parsed.issuer).toBe('https://idp.example.com');
      expect(parsed.inResponseTo).toBe('_logout_123');
      expect(parsed.statusCode).toBe(STATUS_CODES.SUCCESS);
    });

    it('should include StatusMessage when specified', () => {
      const options: LogoutResponseOptions = {
        id: '_response_msg',
        issueInstant: new Date().toISOString(),
        issuer: 'https://idp.example.com',
        destination: 'https://sp.example.com/slo',
        inResponseTo: '_logout_123',
        statusCode: STATUS_CODES.REQUESTER,
        statusMessage: 'Invalid NameID',
      };

      const xml = buildLogoutResponse(options);
      const parsed = parseLogoutResponseXml(xml);

      expect(parsed.statusCode).toBe(STATUS_CODES.REQUESTER);
      expect(parsed.statusMessage).toBe('Invalid NameID');
    });
  });

  describe('Time Bound Validation', () => {
    /**
     * Simulates the validation logic from idp/slo.ts and sp/slo.ts
     */
    function validateLogoutRequestTime(
      issueInstant: string,
      notOnOrAfter?: string
    ): { valid: boolean; error?: string } {
      const now = new Date();
      const issueTime = new Date(issueInstant);
      const skewMs = DEFAULTS.CLOCK_SKEW_SECONDS * 1000;
      const maxAge = DEFAULTS.REQUEST_VALIDITY_SECONDS * 1000;

      // Check if IssueInstant is in the future
      if (issueTime.getTime() > now.getTime() + skewMs) {
        return { valid: false, error: 'IssueInstant is in the future' };
      }

      // Check if request has expired (IssueInstant too old)
      if (now.getTime() - issueTime.getTime() > maxAge + skewMs) {
        return { valid: false, error: 'Request has expired (IssueInstant)' };
      }

      // Check NotOnOrAfter if present
      if (notOnOrAfter) {
        const notOnOrAfterTime = new Date(notOnOrAfter);
        if (now.getTime() > notOnOrAfterTime.getTime() + skewMs) {
          return { valid: false, error: 'Request has expired (NotOnOrAfter)' };
        }
      }

      return { valid: true };
    }

    it('should accept request with valid IssueInstant', () => {
      const issueInstant = new Date().toISOString();
      const result = validateLogoutRequestTime(issueInstant);

      expect(result.valid).toBe(true);
    });

    it('should reject request with IssueInstant in the future', () => {
      const futureTime = new Date(Date.now() + 600000).toISOString(); // 10 minutes from now
      const result = validateLogoutRequestTime(futureTime);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('future');
    });

    it('should accept request with IssueInstant within clock skew', () => {
      // 30 seconds in the future (within 60s clock skew)
      const issueInstant = new Date(Date.now() + 30000).toISOString();
      const result = validateLogoutRequestTime(issueInstant);

      expect(result.valid).toBe(true);
    });

    it('should reject request with expired IssueInstant', () => {
      // 10 minutes ago (beyond 5 minute validity + 1 minute skew)
      const oldTime = new Date(Date.now() - 600000).toISOString();
      const result = validateLogoutRequestTime(oldTime);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('expired');
    });

    it('should reject request when NotOnOrAfter has passed', () => {
      const issueInstant = new Date().toISOString();
      // NotOnOrAfter 5 minutes ago
      const notOnOrAfter = new Date(Date.now() - 300000).toISOString();
      const result = validateLogoutRequestTime(issueInstant, notOnOrAfter);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('NotOnOrAfter');
    });

    it('should accept request when NotOnOrAfter is in the future', () => {
      const issueInstant = new Date().toISOString();
      const notOnOrAfter = new Date(Date.now() + 300000).toISOString();
      const result = validateLogoutRequestTime(issueInstant, notOnOrAfter);

      expect(result.valid).toBe(true);
    });

    it('should handle boundary case at NotOnOrAfter with clock skew', () => {
      const issueInstant = new Date().toISOString();
      // NotOnOrAfter 30 seconds ago (within 60s clock skew)
      const notOnOrAfter = new Date(Date.now() - 30000).toISOString();
      const result = validateLogoutRequestTime(issueInstant, notOnOrAfter);

      expect(result.valid).toBe(true);
    });
  });

  describe('SessionIndex Handling', () => {
    it('should parse LogoutRequest with single SessionIndex', () => {
      const options: LogoutRequestOptions = {
        id: '_logout_session',
        issueInstant: new Date().toISOString(),
        issuer: 'https://sp.example.com',
        destination: 'https://idp.example.com/slo',
        nameId: 'user@example.com',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        sessionIndex: '_session_abc123',
      };

      const xml = buildLogoutRequest(options);
      const parsed = parseLogoutRequestXml(xml);

      expect(parsed.sessionIndex).toBe('_session_abc123');
    });

    it('should handle LogoutRequest without SessionIndex', () => {
      const options: LogoutRequestOptions = {
        id: '_logout_no_session',
        issueInstant: new Date().toISOString(),
        issuer: 'https://sp.example.com',
        destination: 'https://idp.example.com/slo',
        nameId: 'user@example.com',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        // No sessionIndex
      };

      const xml = buildLogoutRequest(options);
      const parsed = parseLogoutRequestXml(xml);

      expect(parsed.sessionIndex).toBeUndefined();
    });

    it('should handle LogoutRequest with multiple SessionIndex elements', () => {
      // SAML 2.0 allows multiple SessionIndex elements to terminate multiple sessions
      const baseXml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  ID="_multi_session"
  Version="2.0"
  IssueInstant="${new Date().toISOString()}"
  Destination="https://idp.example.com/slo">
  <saml:Issuer>https://sp.example.com</saml:Issuer>
  <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">user@example.com</saml:NameID>
  <samlp:SessionIndex>_session_1</samlp:SessionIndex>
  <samlp:SessionIndex>_session_2</samlp:SessionIndex>
  <samlp:SessionIndex>_session_3</samlp:SessionIndex>
</samlp:LogoutRequest>`;

      const parsed = parseLogoutRequestXml(baseXml);

      // sessionIndex returns first for backward compatibility
      expect(parsed.sessionIndex).toBe('_session_1');

      // sessionIndices returns all
      expect(parsed.sessionIndices).toBeDefined();
      expect(parsed.sessionIndices).toHaveLength(3);
      expect(parsed.sessionIndices).toEqual(['_session_1', '_session_2', '_session_3']);
    });
  });

  describe('Status Code Processing', () => {
    it('should handle Success status code', () => {
      const options: LogoutResponseOptions = {
        id: '_resp_success',
        issueInstant: new Date().toISOString(),
        issuer: 'https://idp.example.com',
        destination: 'https://sp.example.com/slo',
        inResponseTo: '_logout_123',
        statusCode: STATUS_CODES.SUCCESS,
      };

      const xml = buildLogoutResponse(options);
      const parsed = parseLogoutResponseXml(xml);

      expect(parsed.statusCode).toBe(STATUS_CODES.SUCCESS);
    });

    it('should handle Requester status code', () => {
      const options: LogoutResponseOptions = {
        id: '_resp_requester',
        issueInstant: new Date().toISOString(),
        issuer: 'https://idp.example.com',
        destination: 'https://sp.example.com/slo',
        inResponseTo: '_logout_123',
        statusCode: STATUS_CODES.REQUESTER,
        statusMessage: 'Invalid NameID format',
      };

      const xml = buildLogoutResponse(options);
      const parsed = parseLogoutResponseXml(xml);

      expect(parsed.statusCode).toBe(STATUS_CODES.REQUESTER);
      expect(parsed.statusMessage).toBe('Invalid NameID format');
    });

    it('should handle Responder status code', () => {
      const options: LogoutResponseOptions = {
        id: '_resp_responder',
        issueInstant: new Date().toISOString(),
        issuer: 'https://idp.example.com',
        destination: 'https://sp.example.com/slo',
        inResponseTo: '_logout_123',
        statusCode: STATUS_CODES.RESPONDER,
        statusMessage: 'Internal server error',
      };

      const xml = buildLogoutResponse(options);
      const parsed = parseLogoutResponseXml(xml);

      expect(parsed.statusCode).toBe(STATUS_CODES.RESPONDER);
    });

    it('should handle UnknownPrincipal status code', () => {
      const options: LogoutResponseOptions = {
        id: '_resp_unknown',
        issueInstant: new Date().toISOString(),
        issuer: 'https://idp.example.com',
        destination: 'https://sp.example.com/slo',
        inResponseTo: '_logout_123',
        statusCode: STATUS_CODES.UNKNOWN_PRINCIPAL,
        statusMessage: 'User not found',
      };

      const xml = buildLogoutResponse(options);
      const parsed = parseLogoutResponseXml(xml);

      expect(parsed.statusCode).toBe(STATUS_CODES.UNKNOWN_PRINCIPAL);
    });

    it('should handle RequestDenied status code', () => {
      const options: LogoutResponseOptions = {
        id: '_resp_denied',
        issueInstant: new Date().toISOString(),
        issuer: 'https://idp.example.com',
        destination: 'https://sp.example.com/slo',
        inResponseTo: '_logout_123',
        statusCode: STATUS_CODES.REQUEST_DENIED,
        statusMessage: 'Logout not allowed',
      };

      const xml = buildLogoutResponse(options);
      const parsed = parseLogoutResponseXml(xml);

      expect(parsed.statusCode).toBe(STATUS_CODES.REQUEST_DENIED);
    });
  });

  describe('Signature Verification', () => {
    it('should sign LogoutRequest', () => {
      const options: LogoutRequestOptions = {
        id: '_logout_sign',
        issueInstant: new Date().toISOString(),
        issuer: 'https://sp.example.com',
        destination: 'https://idp.example.com/slo',
        nameId: 'user@example.com',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      };

      const xml = buildLogoutRequest(options);
      const signedXml = signXml(xml, {
        privateKey: testPrivateKey,
        certificate: testCertificate,
        referenceUri: '#_logout_sign',
        signatureLocation: 'prepend',
        includeKeyInfo: true,
      });

      expect(hasSignature(signedXml)).toBe(true);
    });

    it('should verify signed LogoutRequest', () => {
      const options: LogoutRequestOptions = {
        id: '_logout_verify',
        issueInstant: new Date().toISOString(),
        issuer: 'https://sp.example.com',
        destination: 'https://idp.example.com/slo',
        nameId: 'user@example.com',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      };

      const xml = buildLogoutRequest(options);
      const signedXml = signXml(xml, {
        privateKey: testPrivateKey,
        certificate: testCertificate,
        referenceUri: '#_logout_verify',
        signatureLocation: 'prepend',
        includeKeyInfo: true,
      });

      // Should not throw
      expect(() =>
        verifyXmlSignature(signedXml, {
          certificateOrKey: testCertificate,
        })
      ).not.toThrow();
    });

    it('should sign LogoutResponse', () => {
      const options: LogoutResponseOptions = {
        id: '_response_sign',
        issueInstant: new Date().toISOString(),
        issuer: 'https://idp.example.com',
        destination: 'https://sp.example.com/slo',
        inResponseTo: '_logout_123',
        statusCode: STATUS_CODES.SUCCESS,
      };

      const xml = buildLogoutResponse(options);
      const signedXml = signXml(xml, {
        privateKey: testPrivateKey,
        certificate: testCertificate,
        referenceUri: '#_response_sign',
        signatureLocation: 'prepend',
        includeKeyInfo: true,
      });

      expect(hasSignature(signedXml)).toBe(true);
    });

    it('should verify signed LogoutResponse', () => {
      const options: LogoutResponseOptions = {
        id: '_response_verify',
        issueInstant: new Date().toISOString(),
        issuer: 'https://idp.example.com',
        destination: 'https://sp.example.com/slo',
        inResponseTo: '_logout_123',
        statusCode: STATUS_CODES.SUCCESS,
      };

      const xml = buildLogoutResponse(options);
      const signedXml = signXml(xml, {
        privateKey: testPrivateKey,
        certificate: testCertificate,
        referenceUri: '#_response_verify',
        signatureLocation: 'prepend',
        includeKeyInfo: true,
      });

      expect(() =>
        verifyXmlSignature(signedXml, {
          certificateOrKey: testCertificate,
        })
      ).not.toThrow();
    });

    it('should reject tampered signed LogoutRequest', () => {
      const options: LogoutRequestOptions = {
        id: '_logout_tamper',
        issueInstant: new Date().toISOString(),
        issuer: 'https://sp.example.com',
        destination: 'https://idp.example.com/slo',
        nameId: 'user@example.com',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      };

      const xml = buildLogoutRequest(options);
      const signedXml = signXml(xml, {
        privateKey: testPrivateKey,
        certificate: testCertificate,
        referenceUri: '#_logout_tamper',
        signatureLocation: 'prepend',
        includeKeyInfo: true,
      });

      // Tamper with the content
      const tamperedXml = signedXml.replace('user@example.com', 'attacker@example.com');

      expect(() =>
        verifyXmlSignature(tamperedXml, {
          certificateOrKey: testCertificate,
        })
      ).toThrow();
    });
  });

  describe('POST Binding Encoding', () => {
    it('should encode LogoutRequest for POST binding', () => {
      const options: LogoutRequestOptions = {
        id: '_logout_post',
        issueInstant: new Date().toISOString(),
        issuer: 'https://sp.example.com',
        destination: 'https://idp.example.com/slo',
        nameId: 'user@example.com',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      };

      const xml = buildLogoutRequest(options);
      const encoded = encodeForPostBinding(xml);

      // Should be base64 encoded
      expect(encoded).toBeTruthy();
      expect(encoded).not.toContain('<');
      expect(encoded).not.toContain('>');

      // Should decode back to original XML
      const decoded = atob(encoded);
      expect(decoded).toContain('LogoutRequest');
      expect(decoded).toContain('user@example.com');
    });

    it('should encode LogoutResponse for POST binding', () => {
      const options: LogoutResponseOptions = {
        id: '_response_post',
        issueInstant: new Date().toISOString(),
        issuer: 'https://idp.example.com',
        destination: 'https://sp.example.com/slo',
        inResponseTo: '_logout_123',
        statusCode: STATUS_CODES.SUCCESS,
      };

      const xml = buildLogoutResponse(options);
      const encoded = encodeForPostBinding(xml);

      const decoded = atob(encoded);
      expect(decoded).toContain('LogoutResponse');
      expect(decoded).toContain(STATUS_CODES.SUCCESS);
    });
  });

  describe('Invalid Input Handling', () => {
    it('should reject LogoutRequest without ID', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  Version="2.0"
  IssueInstant="${new Date().toISOString()}"
  Destination="https://idp.example.com/slo">
  <saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">https://sp.example.com</saml:Issuer>
  <saml:NameID xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">user@example.com</saml:NameID>
</samlp:LogoutRequest>`;

      expect(() => parseLogoutRequestXml(xml)).toThrow('missing required attributes');
    });

    it('should reject LogoutRequest without IssueInstant', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  ID="_logout_no_instant"
  Version="2.0"
  Destination="https://idp.example.com/slo">
  <saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">https://sp.example.com</saml:Issuer>
  <saml:NameID xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">user@example.com</saml:NameID>
</samlp:LogoutRequest>`;

      expect(() => parseLogoutRequestXml(xml)).toThrow('missing required attributes');
    });

    it('should reject LogoutRequest without Issuer', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  ID="_logout_no_issuer"
  Version="2.0"
  IssueInstant="${new Date().toISOString()}"
  Destination="https://idp.example.com/slo">
  <saml:NameID xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">user@example.com</saml:NameID>
</samlp:LogoutRequest>`;

      expect(() => parseLogoutRequestXml(xml)).toThrow('missing Issuer');
    });

    it('should reject LogoutRequest without NameID', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  ID="_logout_no_nameid"
  Version="2.0"
  IssueInstant="${new Date().toISOString()}"
  Destination="https://idp.example.com/slo">
  <saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">https://sp.example.com</saml:Issuer>
</samlp:LogoutRequest>`;

      expect(() => parseLogoutRequestXml(xml)).toThrow('missing NameID');
    });

    it('should reject LogoutResponse without Status', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:LogoutResponse xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  ID="_response_no_status"
  Version="2.0"
  IssueInstant="${new Date().toISOString()}"
  InResponseTo="_logout_123"
  Destination="https://sp.example.com/slo">
  <saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">https://idp.example.com</saml:Issuer>
</samlp:LogoutResponse>`;

      expect(() => parseLogoutResponseXml(xml)).toThrow('missing Status');
    });
  });

  describe('Destination Validation', () => {
    it('should include Destination in LogoutRequest', () => {
      const options: LogoutRequestOptions = {
        id: '_logout_dest',
        issueInstant: new Date().toISOString(),
        issuer: 'https://sp.example.com',
        destination: 'https://idp.example.com/saml/idp/slo',
        nameId: 'user@example.com',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      };

      const xml = buildLogoutRequest(options);
      const parsed = parseLogoutRequestXml(xml);

      expect(parsed.destination).toBe('https://idp.example.com/saml/idp/slo');
    });

    it('should include Destination in LogoutResponse', () => {
      const options: LogoutResponseOptions = {
        id: '_response_dest',
        issueInstant: new Date().toISOString(),
        issuer: 'https://idp.example.com',
        destination: 'https://sp.example.com/saml/sp/slo',
        inResponseTo: '_logout_123',
        statusCode: STATUS_CODES.SUCCESS,
      };

      const xml = buildLogoutResponse(options);
      const parsed = parseLogoutResponseXml(xml);

      expect(parsed.destination).toBe('https://sp.example.com/saml/sp/slo');
    });
  });

  describe('Partial Logout Handling', () => {
    it('should handle PartialLogout status for multi-SP scenarios', () => {
      // When IdP cannot logout all SPs, it should return PartialLogout as nested status
      // The top-level status is SUCCESS with nested PartialLogout to indicate incomplete logout

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:LogoutResponse xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  ID="_partial"
  Version="2.0"
  IssueInstant="${new Date().toISOString()}"
  InResponseTo="_logout_123"
  Destination="https://sp.example.com/slo">
  <saml:Issuer>https://idp.example.com</saml:Issuer>
  <samlp:Status>
    <samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success">
      <samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:PartialLogout"/>
    </samlp:StatusCode>
  </samlp:Status>
</samlp:LogoutResponse>`;

      const parsed = parseLogoutResponseXml(xml);

      // Current implementation returns top-level status code
      // The primary status is SUCCESS, with PartialLogout as a nested detail
      expect(parsed.statusCode).toBe(STATUS_CODES.SUCCESS);
    });
  });
});
