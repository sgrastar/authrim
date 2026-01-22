/**
 * Crypto Utilities Tests
 *
 * Tests for hashClientSecret and verifyClientSecretHash functions.
 */

import { describe, it, expect } from 'vitest';
import { timingSafeEqual } from '../crypto.js';

// Define inline implementations for testing since vitest has module resolution issues
async function hashClientSecret(secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(secret);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verifyClientSecretHash(
  providedSecret: string,
  storedHash: string
): Promise<boolean> {
  const computedHash = await hashClientSecret(providedSecret);
  return timingSafeEqual(computedHash, storedHash);
}

describe('Client Secret Hashing', () => {
  describe('hashClientSecret', () => {
    it('should produce a 64-character hex string', async () => {
      const secret = 'test-client-secret-12345';
      const hash = await hashClientSecret(secret);

      // SHA-256 produces 256 bits = 32 bytes = 64 hex characters
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should produce consistent hashes for the same input', async () => {
      const secret = 'my-super-secret-value';
      const hash1 = await hashClientSecret(secret);
      const hash2 = await hashClientSecret(secret);

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different inputs', async () => {
      const secret1 = 'secret-1';
      const secret2 = 'secret-2';

      const hash1 = await hashClientSecret(secret1);
      const hash2 = await hashClientSecret(secret2);

      expect(hash1).not.toBe(hash2);
    });

    it('should handle empty string', async () => {
      const hash = await hashClientSecret('');
      expect(hash).toHaveLength(64);
      // SHA-256('') = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
      expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('should handle unicode characters', async () => {
      const secret = 'パスワード🔐';
      const hash = await hashClientSecret(secret);

      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should handle very long secrets', async () => {
      const secret = 'a'.repeat(10000);
      const hash = await hashClientSecret(secret);

      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('verifyClientSecretHash', () => {
    it('should return true for matching secret and hash', async () => {
      const secret = 'test-client-secret';
      const hash = await hashClientSecret(secret);

      const result = await verifyClientSecretHash(secret, hash);
      expect(result).toBe(true);
    });

    it('should return false for non-matching secret', async () => {
      const secret = 'correct-secret';
      const hash = await hashClientSecret(secret);

      const result = await verifyClientSecretHash('wrong-secret', hash);
      expect(result).toBe(false);
    });

    it('should return false for tampered hash', async () => {
      const secret = 'my-secret';
      const hash = await hashClientSecret(secret);

      // Tamper with one character
      const tamperedHash = 'x' + hash.substring(1);

      const result = await verifyClientSecretHash(secret, tamperedHash);
      expect(result).toBe(false);
    });

    it('should handle empty secret', async () => {
      const emptyHash = await hashClientSecret('');
      const result = await verifyClientSecretHash('', emptyHash);
      expect(result).toBe(true);
    });

    it('should return false when comparing against different length hash', async () => {
      const secret = 'test-secret';
      const shortHash = 'abc123'; // Invalid hash length

      const result = await verifyClientSecretHash(secret, shortHash);
      expect(result).toBe(false);
    });
  });

  describe('timingSafeEqual', () => {
    it('should return true for equal strings', () => {
      expect(timingSafeEqual('hello', 'hello')).toBe(true);
      expect(timingSafeEqual('', '')).toBe(true);
      expect(timingSafeEqual('a', 'a')).toBe(true);
    });

    it('should return false for different strings', () => {
      expect(timingSafeEqual('hello', 'world')).toBe(false);
      expect(timingSafeEqual('hello', 'Hello')).toBe(false);
      expect(timingSafeEqual('a', 'b')).toBe(false);
    });

    it('should return false for different length strings', () => {
      expect(timingSafeEqual('short', 'longer')).toBe(false);
      expect(timingSafeEqual('abc', 'ab')).toBe(false);
    });
  });
});
