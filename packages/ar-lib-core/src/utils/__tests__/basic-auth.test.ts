import { describe, it, expect } from 'vitest';
import {
  parseBasicAuth,
  extractClientCredentialsFromBasicAuth,
  type BasicAuthResult,
} from '../basic-auth';

/**
 * Test suite for HTTP Basic Authentication Parser
 * RFC 7617: The 'Basic' HTTP Authentication Scheme
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7617
 */
describe('Basic Auth Parser', () => {
  describe('parseBasicAuth', () => {
    describe('valid inputs', () => {
      it('should parse valid Basic auth header', () => {
        // Base64 of "client_id:client_secret"
        const encoded = btoa('client_id:client_secret');
        const result = parseBasicAuth(`Basic ${encoded}`);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.credentials.username).toBe('client_id');
          expect(result.credentials.password).toBe('client_secret');
        }
      });

      it('should handle empty password', () => {
        // RFC 7617: Password can be empty
        const encoded = btoa('client_id:');
        const result = parseBasicAuth(`Basic ${encoded}`);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.credentials.username).toBe('client_id');
          expect(result.credentials.password).toBe('');
        }
      });

      it('should handle password containing colons', () => {
        // RFC 7617: Only first colon is separator, password can contain colons
        const encoded = btoa('client_id:pass:word:with:colons');
        const result = parseBasicAuth(`Basic ${encoded}`);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.credentials.username).toBe('client_id');
          expect(result.credentials.password).toBe('pass:word:with:colons');
        }
      });

      it('should URL-decode credentials (RFC 7617 Section 2)', () => {
        // Special characters in client_id/secret are URL-encoded before Base64
        // client_id = "my@client" -> "my%40client"
        // client_secret = "secret+value" -> "secret%2Bvalue"
        const encoded = btoa('my%40client:secret%2Bvalue');
        const result = parseBasicAuth(`Basic ${encoded}`);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.credentials.username).toBe('my@client');
          expect(result.credentials.password).toBe('secret+value');
        }
      });

      it('should handle special characters in password', () => {
        // URL-encoded special characters
        const encoded = btoa('client:pass%3Dword%26special');
        const result = parseBasicAuth(`Basic ${encoded}`);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.credentials.username).toBe('client');
          expect(result.credentials.password).toBe('pass=word&special');
        }
      });

      it('should handle UUID-style client_id', () => {
        const clientId = 'b42bdc5e-7183-46ef-859c-fd21d4589cd6';
        const clientSecret = '6ec3c4aed67c40d9ae8891e4641292ae15cf215264ba4618b7c89356b54b0bde';
        const encoded = btoa(`${clientId}:${clientSecret}`);
        const result = parseBasicAuth(`Basic ${encoded}`);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.credentials.username).toBe(clientId);
          expect(result.credentials.password).toBe(clientSecret);
        }
      });
    });

    describe('invalid inputs', () => {
      it('should return error for missing header', () => {
        const result = parseBasicAuth(undefined);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBe('missing_header');
        }
      });

      it('should return error for empty header', () => {
        const result = parseBasicAuth('');

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBe('invalid_scheme');
        }
      });

      it('should return error for wrong scheme', () => {
        const result = parseBasicAuth('Bearer token123');

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBe('invalid_scheme');
        }
      });

      it('should return error for lowercase "basic"', () => {
        // RFC 7617: "Basic" is case-sensitive in strict implementations
        const encoded = btoa('client:secret');
        const result = parseBasicAuth(`basic ${encoded}`);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBe('invalid_scheme');
        }
      });

      it('should return error for malformed Base64', () => {
        const result = parseBasicAuth('Basic not-valid-base64!!!');

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBe('decode_error');
        }
      });

      it('should return error for credentials without colon', () => {
        const encoded = btoa('client_id_only');
        const result = parseBasicAuth(`Basic ${encoded}`);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBe('malformed_credentials');
        }
      });

      it('should return error for invalid URL encoding', () => {
        // Invalid percent-encoding
        const encoded = btoa('client:%GG');
        const result = parseBasicAuth(`Basic ${encoded}`);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBe('decode_error');
        }
      });
    });

    describe('edge cases', () => {
      it('should handle whitespace in credentials', () => {
        const encoded = btoa('client id:secret password');
        const result = parseBasicAuth(`Basic ${encoded}`);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.credentials.username).toBe('client id');
          expect(result.credentials.password).toBe('secret password');
        }
      });

      it('should handle Unicode characters', () => {
        // Unicode characters need URL-encoding
        const encoded = btoa('%E3%83%86%E3%82%B9%E3%83%88:password');
        const result = parseBasicAuth(`Basic ${encoded}`);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.credentials.username).toBe('テスト');
          expect(result.credentials.password).toBe('password');
        }
      });

      it('should handle very long credentials', () => {
        const longClientId = 'a'.repeat(200);
        const longSecret = 'b'.repeat(500);
        const encoded = btoa(`${longClientId}:${longSecret}`);
        const result = parseBasicAuth(`Basic ${encoded}`);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.credentials.username).toBe(longClientId);
          expect(result.credentials.password).toBe(longSecret);
        }
      });
    });
  });

  describe('extractClientCredentialsFromBasicAuth', () => {
    it('should extract credentials from valid header', () => {
      const encoded = btoa('client_id:client_secret');
      const result = extractClientCredentialsFromBasicAuth(`Basic ${encoded}`);

      expect(result.client_id).toBe('client_id');
      expect(result.client_secret).toBe('client_secret');
    });

    it('should return empty object for missing header', () => {
      const result = extractClientCredentialsFromBasicAuth(undefined);

      expect(result.client_id).toBeUndefined();
      expect(result.client_secret).toBeUndefined();
    });

    it('should return empty object for invalid header', () => {
      const result = extractClientCredentialsFromBasicAuth('Bearer token');

      expect(result.client_id).toBeUndefined();
      expect(result.client_secret).toBeUndefined();
    });

    it('should return empty object for malformed credentials', () => {
      const encoded = btoa('no-colon-here');
      const result = extractClientCredentialsFromBasicAuth(`Basic ${encoded}`);

      expect(result.client_id).toBeUndefined();
      expect(result.client_secret).toBeUndefined();
    });
  });

  describe('type guards', () => {
    it('should narrow type correctly on success', () => {
      const encoded = btoa('client:secret');
      const result: BasicAuthResult = parseBasicAuth(`Basic ${encoded}`);

      if (result.success) {
        // TypeScript should allow accessing credentials here
        const { username, password } = result.credentials;
        expect(typeof username).toBe('string');
        expect(typeof password).toBe('string');
      }
    });

    it('should narrow type correctly on failure', () => {
      const result: BasicAuthResult = parseBasicAuth(undefined);

      if (!result.success) {
        // TypeScript should allow accessing error here
        expect([
          'missing_header',
          'invalid_scheme',
          'malformed_credentials',
          'decode_error',
        ]).toContain(result.error);
      }
    });
  });
});
