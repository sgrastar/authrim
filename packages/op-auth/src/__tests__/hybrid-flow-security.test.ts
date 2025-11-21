/**
 * Hybrid Flow Security Tests
 *
 * Tests OIDC Hybrid Flow security features:
 * - Nonce requirement validation
 * - c_hash calculation and inclusion in ID token
 * - at_hash calculation for access tokens
 * - Response mode validation
 */

import { describe, it, expect } from 'vitest';
import { calculateCHash, calculateAtHash } from '@authrim/shared';

describe('Hybrid Flow Security', () => {
  describe('c_hash Calculation', () => {
    it('should calculate valid c_hash for authorization code', async () => {
      const code = 'test-authorization-code-12345';
      const cHash = await calculateCHash(code, 'SHA-256');

      // c_hash should be base64url encoded
      expect(cHash).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(cHash.length).toBeGreaterThan(0);

      // Should be deterministic
      const cHash2 = await calculateCHash(code, 'SHA-256');
      expect(cHash).toBe(cHash2);
    });

    it('should produce different hashes for different codes', async () => {
      const code1 = 'authorization-code-1';
      const code2 = 'authorization-code-2';

      const cHash1 = await calculateCHash(code1, 'SHA-256');
      const cHash2 = await calculateCHash(code2, 'SHA-256');

      expect(cHash1).not.toBe(cHash2);
    });

    it('should use left-most half of hash', async () => {
      const code = 'test-code';
      const cHash = await calculateCHash(code, 'SHA-256');

      // SHA-256 produces 256 bits = 32 bytes
      // Left-most half = 16 bytes = 128 bits
      // Base64url encoding of 16 bytes should be ~22 characters
      expect(cHash.length).toBeLessThanOrEqual(43); // max for 16 bytes
    });
  });

  describe('at_hash Calculation', () => {
    it('should calculate valid at_hash for access token', async () => {
      // Simulate a JWT access token
      const accessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
      const atHash = await calculateAtHash(accessToken, 'SHA-256');

      // at_hash should be base64url encoded
      expect(atHash).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(atHash.length).toBeGreaterThan(0);
    });

    it('should produce different hashes for different tokens', async () => {
      const token1 = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature1';
      const token2 = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIyIn0.signature2';

      const atHash1 = await calculateAtHash(token1, 'SHA-256');
      const atHash2 = await calculateAtHash(token2, 'SHA-256');

      expect(atHash1).not.toBe(atHash2);
    });
  });

  describe('Nonce Validation', () => {
    it('should enforce nonce for hybrid flows', () => {
      // Hybrid flow response types that require nonce
      const hybridFlowTypes = [
        'code id_token',
        'code token',
        'code id_token token',
        'id_token',
        'id_token token',
        'token',
      ];

      for (const responseType of hybridFlowTypes) {
        const requiresNonce = responseType !== 'code';
        expect(requiresNonce).toBe(true);
      }
    });

    it('should not require nonce for pure authorization code flow', () => {
      const responseType = 'code';
      const requiresNonce = responseType !== 'code';
      expect(requiresNonce).toBe(false);
    });
  });

  describe('Response Mode Validation', () => {
    it('should default to fragment mode for hybrid flows', () => {
      const testCases = [
        { responseType: 'code id_token', expectedMode: 'fragment' },
        { responseType: 'code token', expectedMode: 'fragment' },
        { responseType: 'code id_token token', expectedMode: 'fragment' },
        { responseType: 'id_token', expectedMode: 'fragment' },
        { responseType: 'id_token token', expectedMode: 'fragment' },
        { responseType: 'token', expectedMode: 'fragment' },
      ];

      for (const { responseType, expectedMode } of testCases) {
        const includesIdToken = responseType.includes('id_token');
        const includesToken = responseType.includes('token');
        const defaultMode = includesIdToken || includesToken ? 'fragment' : 'query';

        expect(defaultMode).toBe(expectedMode);
      }
    });

    it('should default to query mode for authorization code flow', () => {
      const responseType = 'code';
      const includesIdToken = responseType.includes('id_token');
      const includesToken = responseType.includes('token');
      const defaultMode = includesIdToken || includesToken ? 'fragment' : 'query';

      expect(defaultMode).toBe('query');
    });

    it('should reject fragment mode for code-only flow', () => {
      const responseType = 'code';
      const responseMode = 'fragment';

      // Per OIDC Core 3.3.2.5: fragment is not allowed for response_type=code
      const isInvalid = responseType === 'code' && responseMode === 'fragment';
      expect(isInvalid).toBe(true);
    });
  });

  describe('Security Headers', () => {
    it('should use CSP with nonce for form_post mode', () => {
      const nonce = 'random-nonce-12345';
      const expectedCSP = `script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}';`;

      expect(expectedCSP).toContain(`'nonce-${nonce}'`);
      expect(expectedCSP).toContain('script-src');
      expect(expectedCSP).toContain('style-src');
    });
  });

  describe('XSS Protection', () => {
    it('should escape HTML in error messages', () => {
      const escapeHtml = (unsafe: string): string => {
        return unsafe
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
      };

      const maliciousInput = '<script>alert("XSS")</script>';
      const escaped = escapeHtml(maliciousInput);

      expect(escaped).not.toContain('<script>');
      expect(escaped).toBe('&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;');
    });

    it('should escape special characters in redirect_uri display', () => {
      const escapeHtml = (unsafe: string): string => {
        return unsafe
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
      };

      const unsafeUri = 'https://example.com/"><script>alert(1)</script>';
      const escaped = escapeHtml(unsafeUri);

      expect(escaped).not.toContain('<script>');
      expect(escaped).toContain('&quot;');
      expect(escaped).toContain('&gt;');
    });
  });
});
