/**
 * Crypto Utility Tests
 * Tests AES-256-GCM encryption/decryption for RP tokens
 */

import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, getEncryptionKey, getEncryptionKeyOrUndefined } from '../utils/crypto';

// Valid 32-byte (256-bit) key in hex format (64 characters)
const VALID_KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
const SHORT_KEY = 'a1b2c3d4e5f6a7b8'; // Too short
const LONG_KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4'; // Too long

describe('Crypto Utilities', () => {
  describe('encrypt', () => {
    it('should encrypt plaintext to base64 string', async () => {
      const plaintext = 'my-secret-token-12345';
      const encrypted = await encrypt(plaintext, VALID_KEY);

      expect(encrypted).toBeDefined();
      expect(typeof encrypted).toBe('string');
      // Base64 encoded should be different from plaintext
      expect(encrypted).not.toBe(plaintext);
      // Should be longer than plaintext (includes IV + tag)
      expect(encrypted.length).toBeGreaterThan(plaintext.length);
    });

    it('should produce different ciphertext for same plaintext (random IV)', async () => {
      const plaintext = 'same-secret-value';

      const encrypted1 = await encrypt(plaintext, VALID_KEY);
      const encrypted2 = await encrypt(plaintext, VALID_KEY);

      expect(encrypted1).not.toBe(encrypted2);
    });

    it('should handle empty string', async () => {
      const encrypted = await encrypt('', VALID_KEY);
      expect(encrypted).toBeDefined();
      expect(encrypted.length).toBeGreaterThan(0);
    });

    it('should handle unicode characters', async () => {
      const plaintext = '日本語トークン🔐🎉';
      const encrypted = await encrypt(plaintext, VALID_KEY);
      const decrypted = await decrypt(encrypted, VALID_KEY);
      expect(decrypted).toBe(plaintext);
    });

    it('should handle long strings', async () => {
      const plaintext = 'a'.repeat(10000);
      const encrypted = await encrypt(plaintext, VALID_KEY);
      const decrypted = await decrypt(encrypted, VALID_KEY);
      expect(decrypted).toBe(plaintext);
    });

    it('should throw error for invalid key length (too short)', async () => {
      await expect(encrypt('test', SHORT_KEY)).rejects.toThrow('Invalid encryption key');
    });

    it('should throw error for invalid key length (too long)', async () => {
      await expect(encrypt('test', LONG_KEY)).rejects.toThrow('Invalid encryption key');
    });

    it('should throw error for empty key', async () => {
      await expect(encrypt('test', '')).rejects.toThrow('Invalid encryption key');
    });
  });

  describe('decrypt', () => {
    it('should decrypt ciphertext back to original plaintext', async () => {
      const plaintext = 'my-secret-refresh-token-abc123';
      const encrypted = await encrypt(plaintext, VALID_KEY);
      const decrypted = await decrypt(encrypted, VALID_KEY);

      expect(decrypted).toBe(plaintext);
    });

    it('should fail with wrong key', async () => {
      const plaintext = 'sensitive-data';
      const encrypted = await encrypt(plaintext, VALID_KEY);

      const wrongKey = 'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3';
      await expect(decrypt(encrypted, wrongKey)).rejects.toThrow();
    });

    it('should fail with tampered ciphertext', async () => {
      const plaintext = 'important-secret';
      const encrypted = await encrypt(plaintext, VALID_KEY);

      // Tamper with the ciphertext (change a character in the middle)
      const tamperedIndex = Math.floor(encrypted.length / 2);
      const tampered =
        encrypted.substring(0, tamperedIndex) +
        (encrypted[tamperedIndex] === 'A' ? 'B' : 'A') +
        encrypted.substring(tamperedIndex + 1);

      await expect(decrypt(tampered, VALID_KEY)).rejects.toThrow();
    });

    it('should fail with truncated ciphertext', async () => {
      const plaintext = 'test-data';
      const encrypted = await encrypt(plaintext, VALID_KEY);

      // Truncate the ciphertext
      const truncated = encrypted.substring(0, encrypted.length - 10);

      await expect(decrypt(truncated, VALID_KEY)).rejects.toThrow();
    });

    it('should fail with invalid base64', async () => {
      await expect(decrypt('not-valid-base64!!!', VALID_KEY)).rejects.toThrow();
    });

    it('should fail with too short data', async () => {
      // Very short base64 that decodes to less than IV + tag
      const tooShort = btoa('abc');
      await expect(decrypt(tooShort, VALID_KEY)).rejects.toThrow('Invalid encrypted data');
    });
  });

  describe('getEncryptionKey', () => {
    it('should return key when configured', () => {
      const env = { RP_TOKEN_ENCRYPTION_KEY: VALID_KEY };
      expect(getEncryptionKey(env)).toBe(VALID_KEY);
    });

    it('should throw when key is not configured', () => {
      const env = {};
      expect(() => getEncryptionKey(env)).toThrow('RP_TOKEN_ENCRYPTION_KEY is not configured');
    });

    it('should throw when key is empty string', () => {
      const env = { RP_TOKEN_ENCRYPTION_KEY: '' };
      expect(() => getEncryptionKey(env)).toThrow('RP_TOKEN_ENCRYPTION_KEY is not configured');
    });
  });

  describe('getEncryptionKeyOrUndefined', () => {
    it('should return key when configured', () => {
      const env = { RP_TOKEN_ENCRYPTION_KEY: VALID_KEY };
      expect(getEncryptionKeyOrUndefined(env)).toBe(VALID_KEY);
    });

    it('should return undefined when key is not configured', () => {
      const env = {};
      expect(getEncryptionKeyOrUndefined(env)).toBeUndefined();
    });
  });

  describe('Round-trip encryption', () => {
    it('should handle typical OAuth access token', async () => {
      const accessToken =
        'ya29.a0AfH6SMBxyz123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      const encrypted = await encrypt(accessToken, VALID_KEY);
      const decrypted = await decrypt(encrypted, VALID_KEY);
      expect(decrypted).toBe(accessToken);
    });

    it('should handle typical OAuth refresh token', async () => {
      const refreshToken = '1//0abc-def-ghi-jkl-mno_pqr123456789ABCDEFGHIJKLMNO';
      const encrypted = await encrypt(refreshToken, VALID_KEY);
      const decrypted = await decrypt(encrypted, VALID_KEY);
      expect(decrypted).toBe(refreshToken);
    });

    it('should handle typical client secret', async () => {
      const clientSecret = 'GOCSPX-abcdefghijklmnopqrstuvwxyz123';
      const encrypted = await encrypt(clientSecret, VALID_KEY);
      const decrypted = await decrypt(encrypted, VALID_KEY);
      expect(decrypted).toBe(clientSecret);
    });

    it('should handle JWT-style tokens', async () => {
      const jwt =
        'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.signature';
      const encrypted = await encrypt(jwt, VALID_KEY);
      const decrypted = await decrypt(encrypted, VALID_KEY);
      expect(decrypted).toBe(jwt);
    });
  });
});
