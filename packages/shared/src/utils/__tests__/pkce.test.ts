/**
 * PKCE (Proof Key for Code Exchange) Unit Tests
 *
 * Tests for RFC 7636 PKCE implementation
 * Security-focused tests for code challenge/verifier generation and validation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  generateSecureRandomString,
  generateCodeChallenge,
  arrayBufferToBase64Url,
  base64UrlToArrayBuffer,
} from '../crypto';

// PKCE-specific validation functions
// These would typically be in a separate pkce.ts file, but are tested here for coverage

/**
 * Validate code_verifier format per RFC 7636
 * - Length: 43-128 characters
 * - Characters: [A-Z] / [a-z] / [0-9] / "-" / "." / "_" / "~"
 */
function validateCodeVerifier(codeVerifier: string): { valid: boolean; error?: string } {
  // Check length (43-128 characters)
  if (codeVerifier.length < 43) {
    return {
      valid: false,
      error: `code_verifier must be at least 43 characters (got ${codeVerifier.length})`,
    };
  }

  if (codeVerifier.length > 128) {
    return {
      valid: false,
      error: `code_verifier must be at most 128 characters (got ${codeVerifier.length})`,
    };
  }

  // Check character set: [A-Z] / [a-z] / [0-9] / "-" / "." / "_" / "~"
  const validPattern = /^[A-Za-z0-9\-._~]+$/;
  if (!validPattern.test(codeVerifier)) {
    return {
      valid: false,
      error: 'code_verifier contains invalid characters. Allowed: [A-Za-z0-9-._~]',
    };
  }

  return { valid: true };
}

/**
 * Verify PKCE code challenge against verifier
 */
async function verifyPKCE(
  codeChallenge: string,
  codeVerifier: string,
  method: 'S256' | 'plain'
): Promise<boolean> {
  if (method === 'plain') {
    return codeChallenge === codeVerifier;
  }

  // S256: BASE64URL(SHA256(code_verifier))
  const calculatedChallenge = await generateCodeChallenge(codeVerifier);
  return codeChallenge === calculatedChallenge;
}

describe('PKCE', () => {
  describe('Code Verifier Validation', () => {
    it('should accept valid code_verifier (43 characters minimum)', () => {
      // Exactly 43 characters
      const verifier = 'a'.repeat(43);
      const result = validateCodeVerifier(verifier);
      expect(result.valid).toBe(true);
    });

    it('should accept valid code_verifier (128 characters maximum)', () => {
      // Exactly 128 characters
      const verifier = 'a'.repeat(128);
      const result = validateCodeVerifier(verifier);
      expect(result.valid).toBe(true);
    });

    it('should reject code_verifier shorter than 43 characters', () => {
      const verifier = 'a'.repeat(42);
      const result = validateCodeVerifier(verifier);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('at least 43 characters');
    });

    it('should reject code_verifier longer than 128 characters', () => {
      const verifier = 'a'.repeat(129);
      const result = validateCodeVerifier(verifier);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('at most 128 characters');
    });

    it('should accept code_verifier with all valid characters', () => {
      // All valid characters: [A-Za-z0-9-._~]
      const verifier = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk0123456789-._~';
      const result = validateCodeVerifier(verifier);
      expect(result.valid).toBe(true);
    });

    it('should reject code_verifier with invalid characters (space)', () => {
      const verifier = 'a'.repeat(40) + ' ' + 'a'.repeat(3);
      const result = validateCodeVerifier(verifier);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('invalid characters');
    });

    it('should reject code_verifier with invalid characters (+)', () => {
      const verifier = 'a'.repeat(42) + '+';
      const result = validateCodeVerifier(verifier);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('invalid characters');
    });

    it('should reject code_verifier with invalid characters (/)', () => {
      const verifier = 'a'.repeat(42) + '/';
      const result = validateCodeVerifier(verifier);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('invalid characters');
    });

    it('should reject code_verifier with invalid characters (=)', () => {
      const verifier = 'a'.repeat(42) + '=';
      const result = validateCodeVerifier(verifier);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('invalid characters');
    });

    it('should reject code_verifier with Unicode characters', () => {
      const verifier = 'a'.repeat(42) + '\u00e9'; // é
      const result = validateCodeVerifier(verifier);
      expect(result.valid).toBe(false);
    });

    it('should reject empty code_verifier', () => {
      const result = validateCodeVerifier('');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('at least 43 characters');
    });
  });

  describe('Code Challenge Generation (S256)', () => {
    it('should generate correct code_challenge for known verifier', async () => {
      // Test vector from RFC 7636 Appendix B
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      const expectedChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

      const challenge = await generateCodeChallenge(verifier);
      expect(challenge).toBe(expectedChallenge);
    });

    it('should generate different challenges for different verifiers', async () => {
      const verifier1 = 'a'.repeat(43);
      const verifier2 = 'b'.repeat(43);

      const challenge1 = await generateCodeChallenge(verifier1);
      const challenge2 = await generateCodeChallenge(verifier2);

      expect(challenge1).not.toBe(challenge2);
    });

    it('should generate consistent challenge for same verifier', async () => {
      const verifier = generateSecureRandomString(32); // ~43 chars

      const challenge1 = await generateCodeChallenge(verifier);
      const challenge2 = await generateCodeChallenge(verifier);

      expect(challenge1).toBe(challenge2);
    });

    it('should generate base64url encoded challenge (no +/= characters)', async () => {
      // Generate multiple challenges to ensure proper encoding
      for (let i = 0; i < 10; i++) {
        const verifier = generateSecureRandomString(32);
        const challenge = await generateCodeChallenge(verifier);

        expect(challenge).not.toContain('+');
        expect(challenge).not.toContain('/');
        expect(challenge).not.toContain('=');
      }
    });

    it('should generate 43-character challenge (SHA-256 = 32 bytes = 43 base64url chars)', async () => {
      const verifier = generateSecureRandomString(32);
      const challenge = await generateCodeChallenge(verifier);

      // SHA-256 produces 32 bytes, base64url encoded = 43 characters (no padding)
      expect(challenge.length).toBe(43);
    });
  });

  describe('PKCE Verification (S256)', () => {
    it('should verify valid S256 code_challenge', async () => {
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

      const result = await verifyPKCE(challenge, verifier, 'S256');
      expect(result).toBe(true);
    });

    it('should reject invalid S256 verification', async () => {
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      const wrongChallenge = 'wrong_challenge_value_1234567890123456789012';

      const result = await verifyPKCE(wrongChallenge, verifier, 'S256');
      expect(result).toBe(false);
    });

    it('should reject verification with wrong verifier', async () => {
      const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
      const wrongVerifier = 'wrong_verifier_value_1234567890123456789012';

      const result = await verifyPKCE(challenge, wrongVerifier, 'S256');
      expect(result).toBe(false);
    });
  });

  describe('PKCE Verification (plain)', () => {
    it('should verify valid plain code_challenge', async () => {
      const verifier = 'a'.repeat(43);
      const challenge = verifier; // plain method: challenge === verifier

      const result = await verifyPKCE(challenge, verifier, 'plain');
      expect(result).toBe(true);
    });

    it('should reject invalid plain verification', async () => {
      const verifier = 'a'.repeat(43);
      const challenge = 'b'.repeat(43); // Different value

      const result = await verifyPKCE(challenge, verifier, 'plain');
      expect(result).toBe(false);
    });
  });

  describe('Secure Random String Generation', () => {
    it('should generate strings of expected length', () => {
      // 32 bytes -> ~43 base64url characters
      const str32 = generateSecureRandomString(32);
      expect(str32.length).toBeGreaterThanOrEqual(42);
      expect(str32.length).toBeLessThanOrEqual(44);

      // 96 bytes -> ~128 base64url characters (default)
      const str96 = generateSecureRandomString(96);
      expect(str96.length).toBeGreaterThanOrEqual(126);
      expect(str96.length).toBeLessThanOrEqual(130);
    });

    it('should generate unique strings', () => {
      const strings = new Set<string>();
      for (let i = 0; i < 100; i++) {
        strings.add(generateSecureRandomString(32));
      }
      // All 100 strings should be unique
      expect(strings.size).toBe(100);
    });

    it('should generate base64url-safe strings', () => {
      for (let i = 0; i < 10; i++) {
        const str = generateSecureRandomString(32);
        expect(str).not.toContain('+');
        expect(str).not.toContain('/');
        expect(str).not.toContain('=');
      }
    });
  });

  describe('Base64URL Encoding/Decoding', () => {
    it('should correctly encode and decode', () => {
      const original = new Uint8Array([0, 1, 2, 3, 255, 254, 253]);
      const encoded = arrayBufferToBase64Url(original);
      const decoded = base64UrlToArrayBuffer(encoded);

      expect(Array.from(decoded)).toEqual(Array.from(original));
    });

    it('should handle empty input', () => {
      const original = new Uint8Array([]);
      const encoded = arrayBufferToBase64Url(original);
      const decoded = base64UrlToArrayBuffer(encoded);

      expect(decoded.length).toBe(0);
    });

    it('should not produce padding characters', () => {
      // Test various lengths to ensure no padding
      for (let len = 1; len <= 10; len++) {
        const data = new Uint8Array(len);
        crypto.getRandomValues(data);
        const encoded = arrayBufferToBase64Url(data);
        expect(encoded).not.toContain('=');
      }
    });

    it('should use URL-safe characters', () => {
      // Generate many random values to trigger all possible outputs
      for (let i = 0; i < 50; i++) {
        const data = new Uint8Array(32);
        crypto.getRandomValues(data);
        const encoded = arrayBufferToBase64Url(data);
        expect(encoded).not.toContain('+');
        expect(encoded).not.toContain('/');
      }
    });
  });

  describe('Security Edge Cases', () => {
    it('should handle very long verifier (128 chars)', async () => {
      const verifier = 'a'.repeat(128);
      const challenge = await generateCodeChallenge(verifier);
      const result = await verifyPKCE(challenge, verifier, 'S256');
      expect(result).toBe(true);
    });

    it('should handle minimum length verifier (43 chars)', async () => {
      const verifier = 'abcdefghijklmnopqrstuvwxyz0123456789-._~123';
      expect(verifier.length).toBe(43);

      const challenge = await generateCodeChallenge(verifier);
      const result = await verifyPKCE(challenge, verifier, 'S256');
      expect(result).toBe(true);
    });

    it('should handle verifier with special characters', async () => {
      const verifier = '-.~_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij01234';
      expect(validateCodeVerifier(verifier).valid).toBe(true);

      const challenge = await generateCodeChallenge(verifier);
      const result = await verifyPKCE(challenge, verifier, 'S256');
      expect(result).toBe(true);
    });

    it('should reject NULL byte in verifier', () => {
      const verifier = 'a'.repeat(42) + '\0';
      const result = validateCodeVerifier(verifier);
      expect(result.valid).toBe(false);
    });

    it('should reject newline in verifier', () => {
      const verifier = 'a'.repeat(42) + '\n';
      const result = validateCodeVerifier(verifier);
      expect(result.valid).toBe(false);
    });

    it('should handle high entropy verifier from generateSecureRandomString', async () => {
      const verifier = generateSecureRandomString(32);

      // Verify it's a valid verifier (length and characters)
      const validation = validateCodeVerifier(verifier);
      expect(validation.valid).toBe(true);

      // Verify PKCE flow works
      const challenge = await generateCodeChallenge(verifier);
      const result = await verifyPKCE(challenge, verifier, 'S256');
      expect(result).toBe(true);
    });
  });
});
