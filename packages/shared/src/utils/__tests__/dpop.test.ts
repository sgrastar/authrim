/**
 * DPoP (Demonstrating Proof of Possession) Tests
 * RFC 9449
 */

import { describe, it, expect } from 'vitest';
import { calculateAccessTokenHash, isDPoPBoundToken, extractDPoPToken } from '../dpop';

describe('DPoP Utilities', () => {
  describe('calculateAccessTokenHash', () => {
    it('should calculate SHA-256 hash of access token', async () => {
      const token = 'test_access_token_123';
      const hash = await calculateAccessTokenHash(token);

      // Hash should be base64url-encoded string
      expect(hash).toBeTypeOf('string');
      expect(hash.length).toBeGreaterThan(0);
      // Base64url should not contain +, /, or =
      expect(hash).not.toMatch(/[+/=]/);
    });

    it('should produce consistent hashes for same token', async () => {
      const token = 'test_token';
      const hash1 = await calculateAccessTokenHash(token);
      const hash2 = await calculateAccessTokenHash(token);

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different tokens', async () => {
      const hash1 = await calculateAccessTokenHash('token1');
      const hash2 = await calculateAccessTokenHash('token2');

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('isDPoPBoundToken', () => {
    it('should return true for DPoP authorization header', () => {
      const authHeader = 'DPoP some_token_here';
      expect(isDPoPBoundToken(authHeader)).toBe(true);
    });

    it('should return true for lowercase dpop', () => {
      const authHeader = 'dpop some_token_here';
      expect(isDPoPBoundToken(authHeader)).toBe(true);
    });

    it('should return false for Bearer authorization header', () => {
      const authHeader = 'Bearer some_token_here';
      expect(isDPoPBoundToken(authHeader)).toBe(false);
    });

    it('should return false for invalid format', () => {
      expect(isDPoPBoundToken('InvalidFormat')).toBe(false);
      expect(isDPoPBoundToken('')).toBe(false);
    });

    it('should handle extra whitespace', () => {
      const authHeader = '  DPoP   some_token_here  ';
      expect(isDPoPBoundToken(authHeader)).toBe(true);
    });
  });

  describe('extractDPoPToken', () => {
    it('should extract token from DPoP authorization header', () => {
      const authHeader = 'DPoP eyJhbGciOiJSUzI1NiJ9.payload.signature';
      const token = extractDPoPToken(authHeader);

      expect(token).toBe('eyJhbGciOiJSUzI1NiJ9.payload.signature');
    });

    it('should return undefined for Bearer header', () => {
      const authHeader = 'Bearer some_token';
      const token = extractDPoPToken(authHeader);

      expect(token).toBeUndefined();
    });

    it('should return undefined for invalid format', () => {
      expect(extractDPoPToken('DPoP')).toBeUndefined();
      expect(extractDPoPToken('InvalidFormat')).toBeUndefined();
      expect(extractDPoPToken('')).toBeUndefined();
    });

    it('should handle multiple spaces', () => {
      const authHeader = 'DPoP    token_with_spaces';
      const token = extractDPoPToken(authHeader);

      expect(token).toBe('token_with_spaces');
    });
  });
});
