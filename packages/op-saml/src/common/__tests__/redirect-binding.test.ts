/**
 * HTTP-Redirect Binding Tests
 *
 * Tests based on SAML 2.0 Bindings Specification Section 3.4:
 * - DEFLATE compression
 * - Base64 URL encoding
 * - Query string construction
 * - Signature generation and verification
 *
 * @see https://docs.oasis-open.org/security/saml/v2.0/saml-bindings-2.0-os.pdf
 */

import { describe, it, expect } from 'vitest';
import {
  buildLogoutRequest,
  buildLogoutResponse,
  encodeForRedirectBinding,
  parseLogoutRequestRedirect,
  parseLogoutResponseRedirect,
  type LogoutRequestOptions,
  type LogoutResponseOptions,
} from '../slo-messages';
import { signRedirectBinding, verifyRedirectBindingSignature } from '../signature';

// Test private key (same as signature-security.test.ts)
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

describe('HTTP-Redirect Binding - SAML 2.0 Bindings Section 3.4', () => {
  describe('DEFLATE Encoding/Decoding', () => {
    it('should encode LogoutRequest for redirect binding', () => {
      const requestOptions: LogoutRequestOptions = {
        id: '_logout_request_123',
        issueInstant: new Date().toISOString(),
        issuer: 'https://sp.example.com/saml/sp',
        destination: 'https://idp.example.com/slo',
        nameId: 'user@example.com',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        sessionIndex: '_session_456',
      };

      const xml = buildLogoutRequest(requestOptions);
      const encoded = encodeForRedirectBinding(xml);

      // Should be a base64url-like string
      expect(encoded).toBeTruthy();
      expect(encoded).not.toContain('+'); // No + (replaced with -)
      expect(encoded).not.toContain('/'); // No / (replaced with _)
      expect(encoded).not.toContain('='); // No padding
    });

    it('should decode LogoutRequest from redirect binding', () => {
      const requestOptions: LogoutRequestOptions = {
        id: '_logout_request_789',
        issueInstant: new Date().toISOString(),
        issuer: 'https://sp.example.com/saml/sp',
        destination: 'https://idp.example.com/slo',
        nameId: 'admin@example.com',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      };

      const xml = buildLogoutRequest(requestOptions);
      const encoded = encodeForRedirectBinding(xml);

      // Convert back to standard base64 for parsing
      const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
      const parsed = parseLogoutRequestRedirect(base64);

      expect(parsed.id).toBe('_logout_request_789');
      expect(parsed.issuer).toBe('https://sp.example.com/saml/sp');
      expect(parsed.nameId).toBe('admin@example.com');
    });

    it('should encode LogoutResponse for redirect binding', () => {
      const responseOptions: LogoutResponseOptions = {
        id: '_logout_response_123',
        issueInstant: new Date().toISOString(),
        issuer: 'https://idp.example.com',
        destination: 'https://sp.example.com/slo',
        inResponseTo: '_logout_request_123',
        statusCode: 'urn:oasis:names:tc:SAML:2.0:status:Success',
      };

      const xml = buildLogoutResponse(responseOptions);
      const encoded = encodeForRedirectBinding(xml);

      expect(encoded).toBeTruthy();
    });

    it('should decode LogoutResponse from redirect binding', () => {
      const responseOptions: LogoutResponseOptions = {
        id: '_logout_response_456',
        issueInstant: new Date().toISOString(),
        issuer: 'https://idp.example.com',
        destination: 'https://sp.example.com/slo',
        inResponseTo: '_logout_request_456',
        statusCode: 'urn:oasis:names:tc:SAML:2.0:status:Success',
      };

      const xml = buildLogoutResponse(responseOptions);
      const encoded = encodeForRedirectBinding(xml);

      const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
      const parsed = parseLogoutResponseRedirect(base64);

      expect(parsed.id).toBe('_logout_response_456');
      expect(parsed.issuer).toBe('https://idp.example.com');
      expect(parsed.inResponseTo).toBe('_logout_request_456');
      expect(parsed.statusCode).toBe('urn:oasis:names:tc:SAML:2.0:status:Success');
    });
  });

  describe('RelayState Handling', () => {
    it('should preserve RelayState through encoding', () => {
      const relayState = 'https://app.example.com/original-page?param=value';

      // RelayState is passed separately, not encoded in the SAML message
      // It should be URL-encoded in the query string
      const encodedRelayState = encodeURIComponent(relayState);

      expect(decodeURIComponent(encodedRelayState)).toBe(relayState);
    });

    it('should handle RelayState with special characters', () => {
      const relayState = 'state={test: "value", flag: true}';
      const encodedRelayState = encodeURIComponent(relayState);

      expect(decodeURIComponent(encodedRelayState)).toBe(relayState);
    });

    it('should handle empty RelayState', () => {
      const relayState = '';
      const encodedRelayState = encodeURIComponent(relayState);

      expect(encodedRelayState).toBe('');
    });
  });

  describe('Signature for Redirect Binding', () => {
    it('should create valid signature for redirect binding', async () => {
      const requestOptions: LogoutRequestOptions = {
        id: '_logout_request_sign',
        issueInstant: new Date().toISOString(),
        issuer: 'https://sp.example.com/saml/sp',
        destination: 'https://idp.example.com/slo',
        nameId: 'user@example.com',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      };

      const xml = buildLogoutRequest(requestOptions);
      const encoded = encodeForRedirectBinding(xml);
      const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');

      const result = await signRedirectBinding(
        'SAMLRequest',
        base64,
        'relayState123',
        testPrivateKey
      );

      expect(result.signature).toBeTruthy();
      expect(result.sigAlg).toBe('http://www.w3.org/2001/04/xmldsig-more#rsa-sha256');
      expect(result.signedUrl).toContain('SAMLRequest=');
      expect(result.signedUrl).toContain('RelayState=');
      expect(result.signedUrl).toContain('SigAlg=');
      expect(result.signedUrl).toContain('Signature=');
    });

    it('should verify valid redirect binding signature', async () => {
      const requestOptions: LogoutRequestOptions = {
        id: '_logout_request_verify',
        issueInstant: new Date().toISOString(),
        issuer: 'https://sp.example.com/saml/sp',
        destination: 'https://idp.example.com/slo',
        nameId: 'user@example.com',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      };

      const xml = buildLogoutRequest(requestOptions);
      const encoded = encodeForRedirectBinding(xml);
      const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
      const relayState = 'test_relay';

      // Sign
      const signResult = await signRedirectBinding(
        'SAMLRequest',
        base64,
        relayState,
        testPrivateKey
      );

      // Verify
      const isValid = await verifyRedirectBindingSignature(
        'SAMLRequest',
        encodeURIComponent(base64),
        encodeURIComponent(relayState),
        signResult.signature,
        signResult.sigAlg,
        testCertificate
      );

      expect(isValid).toBe(true);
    });

    it('should reject tampered redirect binding signature', async () => {
      const requestOptions: LogoutRequestOptions = {
        id: '_logout_request_tamper',
        issueInstant: new Date().toISOString(),
        issuer: 'https://sp.example.com/saml/sp',
        destination: 'https://idp.example.com/slo',
        nameId: 'user@example.com',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      };

      const xml = buildLogoutRequest(requestOptions);
      const encoded = encodeForRedirectBinding(xml);
      const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
      const relayState = 'test_relay';

      // Sign
      const signResult = await signRedirectBinding(
        'SAMLRequest',
        base64,
        relayState,
        testPrivateKey
      );

      // Tamper with signature
      const tamperedSignature = signResult.signature.replace(/A/g, 'B');

      // Verify should fail
      const isValid = await verifyRedirectBindingSignature(
        'SAMLRequest',
        encodeURIComponent(base64),
        encodeURIComponent(relayState),
        tamperedSignature,
        signResult.sigAlg,
        testCertificate
      );

      expect(isValid).toBe(false);
    });

    it('should handle signature without RelayState', async () => {
      const requestOptions: LogoutRequestOptions = {
        id: '_logout_request_no_relay',
        issueInstant: new Date().toISOString(),
        issuer: 'https://sp.example.com/saml/sp',
        destination: 'https://idp.example.com/slo',
        nameId: 'user@example.com',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      };

      const xml = buildLogoutRequest(requestOptions);
      const encoded = encodeForRedirectBinding(xml);
      const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');

      // Sign without RelayState
      const signResult = await signRedirectBinding(
        'SAMLRequest',
        base64,
        undefined,
        testPrivateKey
      );

      expect(signResult.signedUrl).not.toContain('RelayState=');

      // Verify
      const isValid = await verifyRedirectBindingSignature(
        'SAMLRequest',
        encodeURIComponent(base64),
        undefined,
        signResult.signature,
        signResult.sigAlg,
        testCertificate
      );

      expect(isValid).toBe(true);
    });
  });

  describe('Invalid Input Handling', () => {
    it('should reject invalid base64 encoding', () => {
      expect(() => parseLogoutRequestRedirect('not-valid-base64!!!')).toThrow();
    });

    it('should reject non-deflated data', () => {
      // Just base64-encoded XML without deflation
      const xml = '<LogoutRequest>test</LogoutRequest>';
      const base64 = btoa(xml);

      expect(() => parseLogoutRequestRedirect(base64)).toThrow();
    });

    it('should reject malformed XML after decompression', () => {
      // Properly deflate but with invalid XML content
      // This test documents expected behavior for corrupted data
      const malformedXml = '<NotAValidSAMLMessage>';
      const encoded = encodeForRedirectBinding(malformedXml);
      const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');

      expect(() => parseLogoutRequestRedirect(base64)).toThrow();
    });

    it('should reject unsupported signature algorithm', async () => {
      // Only RSA-SHA256 should be accepted
      await expect(
        verifyRedirectBindingSignature(
          'SAMLRequest',
          'encoded_value',
          'relay_state',
          'fake_signature',
          'http://www.w3.org/2000/09/xmldsig#rsa-sha1', // SHA-1 not allowed
          testCertificate
        )
      ).rejects.toThrow('Unsupported signature algorithm');
    });
  });

  describe('URL Length Considerations', () => {
    it('should warn about potentially long URLs', () => {
      // HTTP-Redirect binding has URL length limits (browser-dependent, typically 2KB-8KB)
      // Large SAML messages should use HTTP-POST binding

      const largeRequestOptions: LogoutRequestOptions = {
        id: '_logout_request_large',
        issueInstant: new Date().toISOString(),
        issuer: 'https://sp.example.com/saml/sp/with/very/long/path/that/makes/the/url/longer',
        destination: 'https://idp.example.com/slo',
        nameId: 'user-with-very-long-email-address@subdomain.example.com',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        sessionIndex: '_session_' + 'x'.repeat(100),
      };

      const xml = buildLogoutRequest(largeRequestOptions);
      const encoded = encodeForRedirectBinding(xml);

      // DEFLATE should significantly reduce the size
      expect(encoded.length).toBeLessThan(xml.length);

      // Log warning if the encoded value is too large for typical URL limits
      const estimatedUrlLength = encoded.length + 200; // Add overhead for query params
      if (estimatedUrlLength > 2000) {
        console.warn(
          `Encoded SAML message is ${estimatedUrlLength} bytes - may exceed URL length limits`
        );
      }
    });
  });
});
