/**
 * Email Code (OTP) Utilities Unit Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateEmailCode,
  hashEmailCode,
  verifyEmailCodeHash,
  hashEmail,
} from '../email-code-utils';

describe('Email Code Utilities', () => {
  describe('generateEmailCode', () => {
    it('should generate a 6-digit numeric code', () => {
      const code = generateEmailCode();
      expect(code).toMatch(/^\d{6}$/);
    });

    it('should pad codes with leading zeros', () => {
      // Mock crypto.getRandomValues to return a small number
      const originalGetRandomValues = crypto.getRandomValues;
      crypto.getRandomValues = vi.fn((array: Uint32Array) => {
        array[0] = 123; // Will result in '000123'
        return array;
      }) as unknown as typeof crypto.getRandomValues;

      const code = generateEmailCode();
      expect(code).toBe('000123');
      expect(code).toHaveLength(6);

      crypto.getRandomValues = originalGetRandomValues;
    });

    it('should generate different codes on successive calls', () => {
      const codes = new Set<string>();
      for (let i = 0; i < 100; i++) {
        codes.add(generateEmailCode());
      }
      // With CSPRNG, we should get many unique codes
      expect(codes.size).toBeGreaterThan(90);
    });

    it('should handle maximum value correctly', () => {
      const originalGetRandomValues = crypto.getRandomValues;
      crypto.getRandomValues = vi.fn((array: Uint32Array) => {
        array[0] = 999999; // Maximum 6-digit number
        return array;
      }) as unknown as typeof crypto.getRandomValues;

      const code = generateEmailCode();
      expect(code).toBe('999999');

      crypto.getRandomValues = originalGetRandomValues;
    });

    it('should handle modulo overflow correctly', () => {
      const originalGetRandomValues = crypto.getRandomValues;
      crypto.getRandomValues = vi.fn((array: Uint32Array) => {
        array[0] = 1000000; // Should wrap to 000000
        return array;
      }) as unknown as typeof crypto.getRandomValues;

      const code = generateEmailCode();
      expect(code).toBe('000000');

      crypto.getRandomValues = originalGetRandomValues;
    });
  });

  describe('hashEmailCode', () => {
    const testCode = '123456';
    const testEmail = 'test@example.com';
    const testSessionId = 'session-123';
    const testIssuedAt = 1700000000000;
    const testSecret = 'test-secret-key';

    it('should generate a hex string hash', async () => {
      const hash = await hashEmailCode(
        testCode,
        testEmail,
        testSessionId,
        testIssuedAt,
        testSecret
      );
      expect(hash).toMatch(/^[a-f0-9]{64}$/); // SHA-256 produces 64 hex chars
    });

    it('should produce consistent hashes for same inputs', async () => {
      const hash1 = await hashEmailCode(
        testCode,
        testEmail,
        testSessionId,
        testIssuedAt,
        testSecret
      );
      const hash2 = await hashEmailCode(
        testCode,
        testEmail,
        testSessionId,
        testIssuedAt,
        testSecret
      );
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different codes', async () => {
      const hash1 = await hashEmailCode(
        '123456',
        testEmail,
        testSessionId,
        testIssuedAt,
        testSecret
      );
      const hash2 = await hashEmailCode(
        '654321',
        testEmail,
        testSessionId,
        testIssuedAt,
        testSecret
      );
      expect(hash1).not.toBe(hash2);
    });

    it('should produce different hashes for different emails', async () => {
      const hash1 = await hashEmailCode(
        testCode,
        'test1@example.com',
        testSessionId,
        testIssuedAt,
        testSecret
      );
      const hash2 = await hashEmailCode(
        testCode,
        'test2@example.com',
        testSessionId,
        testIssuedAt,
        testSecret
      );
      expect(hash1).not.toBe(hash2);
    });

    it('should produce different hashes for different session IDs', async () => {
      const hash1 = await hashEmailCode(testCode, testEmail, 'session-1', testIssuedAt, testSecret);
      const hash2 = await hashEmailCode(testCode, testEmail, 'session-2', testIssuedAt, testSecret);
      expect(hash1).not.toBe(hash2);
    });

    it('should produce different hashes for different timestamps', async () => {
      const hash1 = await hashEmailCode(
        testCode,
        testEmail,
        testSessionId,
        1700000000000,
        testSecret
      );
      const hash2 = await hashEmailCode(
        testCode,
        testEmail,
        testSessionId,
        1700000001000,
        testSecret
      );
      expect(hash1).not.toBe(hash2);
    });

    it('should produce different hashes for different secrets', async () => {
      const hash1 = await hashEmailCode(
        testCode,
        testEmail,
        testSessionId,
        testIssuedAt,
        'secret-1'
      );
      const hash2 = await hashEmailCode(
        testCode,
        testEmail,
        testSessionId,
        testIssuedAt,
        'secret-2'
      );
      expect(hash1).not.toBe(hash2);
    });

    it('should normalize email to lowercase', async () => {
      const hash1 = await hashEmailCode(
        testCode,
        'TEST@EXAMPLE.COM',
        testSessionId,
        testIssuedAt,
        testSecret
      );
      const hash2 = await hashEmailCode(
        testCode,
        'test@example.com',
        testSessionId,
        testIssuedAt,
        testSecret
      );
      expect(hash1).toBe(hash2);
    });
  });

  describe('verifyEmailCodeHash', () => {
    const testCode = '123456';
    const testEmail = 'test@example.com';
    const testSessionId = 'session-123';
    const testIssuedAt = 1700000000000;
    const testSecret = 'test-secret-key';

    it('should return true for valid code', async () => {
      const hash = await hashEmailCode(
        testCode,
        testEmail,
        testSessionId,
        testIssuedAt,
        testSecret
      );
      const isValid = await verifyEmailCodeHash(
        testCode,
        testEmail,
        testSessionId,
        testIssuedAt,
        hash,
        testSecret
      );
      expect(isValid).toBe(true);
    });

    it('should return false for invalid code', async () => {
      const hash = await hashEmailCode(
        testCode,
        testEmail,
        testSessionId,
        testIssuedAt,
        testSecret
      );
      const isValid = await verifyEmailCodeHash(
        '000000',
        testEmail,
        testSessionId,
        testIssuedAt,
        hash,
        testSecret
      );
      expect(isValid).toBe(false);
    });

    it('should return false for wrong email', async () => {
      const hash = await hashEmailCode(
        testCode,
        testEmail,
        testSessionId,
        testIssuedAt,
        testSecret
      );
      const isValid = await verifyEmailCodeHash(
        testCode,
        'wrong@example.com',
        testSessionId,
        testIssuedAt,
        hash,
        testSecret
      );
      expect(isValid).toBe(false);
    });

    it('should return false for wrong session ID', async () => {
      const hash = await hashEmailCode(
        testCode,
        testEmail,
        testSessionId,
        testIssuedAt,
        testSecret
      );
      const isValid = await verifyEmailCodeHash(
        testCode,
        testEmail,
        'wrong-session',
        testIssuedAt,
        hash,
        testSecret
      );
      expect(isValid).toBe(false);
    });

    it('should return false for wrong timestamp', async () => {
      const hash = await hashEmailCode(
        testCode,
        testEmail,
        testSessionId,
        testIssuedAt,
        testSecret
      );
      const isValid = await verifyEmailCodeHash(
        testCode,
        testEmail,
        testSessionId,
        testIssuedAt + 1000,
        hash,
        testSecret
      );
      expect(isValid).toBe(false);
    });

    it('should return false for wrong secret', async () => {
      const hash = await hashEmailCode(
        testCode,
        testEmail,
        testSessionId,
        testIssuedAt,
        testSecret
      );
      const isValid = await verifyEmailCodeHash(
        testCode,
        testEmail,
        testSessionId,
        testIssuedAt,
        hash,
        'wrong-secret'
      );
      expect(isValid).toBe(false);
    });

    it('should handle email case insensitivity in verification', async () => {
      const hash = await hashEmailCode(
        testCode,
        'TEST@EXAMPLE.COM',
        testSessionId,
        testIssuedAt,
        testSecret
      );
      const isValid = await verifyEmailCodeHash(
        testCode,
        'test@example.com',
        testSessionId,
        testIssuedAt,
        hash,
        testSecret
      );
      expect(isValid).toBe(true);
    });

    it('should return false for tampered hash', async () => {
      const hash = await hashEmailCode(
        testCode,
        testEmail,
        testSessionId,
        testIssuedAt,
        testSecret
      );
      const tamperedHash = hash.substring(0, 63) + (hash[63] === '0' ? '1' : '0');
      const isValid = await verifyEmailCodeHash(
        testCode,
        testEmail,
        testSessionId,
        testIssuedAt,
        tamperedHash,
        testSecret
      );
      expect(isValid).toBe(false);
    });
  });

  describe('hashEmail', () => {
    it('should generate a SHA-256 hash of email', async () => {
      const hash = await hashEmail('test@example.com');
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should produce consistent hashes', async () => {
      const hash1 = await hashEmail('test@example.com');
      const hash2 = await hashEmail('test@example.com');
      expect(hash1).toBe(hash2);
    });

    it('should normalize email to lowercase', async () => {
      const hash1 = await hashEmail('TEST@EXAMPLE.COM');
      const hash2 = await hashEmail('test@example.com');
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different emails', async () => {
      const hash1 = await hashEmail('user1@example.com');
      const hash2 = await hashEmail('user2@example.com');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('Constant Time Comparison (Security)', () => {
    it('should take similar time regardless of where mismatch occurs', async () => {
      const testCode = '123456';
      const testEmail = 'test@example.com';
      const testSessionId = 'session-123';
      const testIssuedAt = 1700000000000;
      const testSecret = 'test-secret-key';

      const hash = await hashEmailCode(
        testCode,
        testEmail,
        testSessionId,
        testIssuedAt,
        testSecret
      );

      // Test multiple verification attempts with different wrong codes
      const wrongCodes = ['000000', '100000', '120000', '123000', '123400', '123450'];
      const times: number[] = [];

      for (const wrongCode of wrongCodes) {
        const start = performance.now();
        for (let i = 0; i < 100; i++) {
          await verifyEmailCodeHash(
            wrongCode,
            testEmail,
            testSessionId,
            testIssuedAt,
            hash,
            testSecret
          );
        }
        const end = performance.now();
        times.push(end - start);
      }

      // All times should be relatively similar (within reasonable variance)
      const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
      const maxDeviation = Math.max(...times.map((t) => Math.abs(t - avgTime)));

      // The maximum deviation should be less than 100% of average time
      // This is a rough check - timing attacks are hard to detect in unit tests
      // Note: Using 100% threshold to account for CPU load variance during parallel test execution
      expect(maxDeviation).toBeLessThan(avgTime * 1.0);
    });
  });
});
