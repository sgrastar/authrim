import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateVerificationToken,
  getVerificationRecordName,
  getExpectedRecordValue,
  queryDnsTxtRecords,
  verifyDomainDnsTxt,
  calculateVerificationExpiry,
  isVerificationExpired,
  VERIFICATION_TOKEN_TTL_SECONDS,
} from '../dns-verification';

describe('DNS Verification Utility', () => {
  describe('generateVerificationToken', () => {
    it('should generate a 64-character hex token', async () => {
      const token = await generateVerificationToken();
      expect(token).toHaveLength(64);
      expect(/^[0-9a-f]+$/.test(token)).toBe(true);
    });

    it('should generate unique tokens', async () => {
      const token1 = await generateVerificationToken();
      const token2 = await generateVerificationToken();
      expect(token1).not.toBe(token2);
    });
  });

  describe('getVerificationRecordName', () => {
    it('should return correct record name for domain', () => {
      const name = getVerificationRecordName('example.com');
      expect(name).toBe('_authrim-verify.example.com');
    });

    it('should handle leading dot in domain', () => {
      const name = getVerificationRecordName('.example.com');
      expect(name).toBe('_authrim-verify.example.com');
    });

    it('should use custom prefix', () => {
      const name = getVerificationRecordName('example.com', { recordPrefix: '_custom' });
      expect(name).toBe('_custom.example.com');
    });
  });

  describe('getExpectedRecordValue', () => {
    it('should return correct TXT value format', () => {
      const value = getExpectedRecordValue('abc123');
      expect(value).toBe('authrim-domain-verify=abc123');
    });

    it('should use custom token prefix', () => {
      const value = getExpectedRecordValue('abc123', { tokenPrefix: 'custom-verify=' });
      expect(value).toBe('custom-verify=abc123');
    });
  });

  describe('calculateVerificationExpiry', () => {
    // The function reads the clock itself: frozen, so that a second boundary falling between
    // its read and the test's cannot add one to the difference.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00.999Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should return a future timestamp', () => {
      const now = Math.floor(Date.now() / 1000);
      const expiry = calculateVerificationExpiry();
      expect(expiry).toBeGreaterThan(now);
      expect(expiry - now).toBe(VERIFICATION_TOKEN_TTL_SECONDS);
    });

    it('should use custom TTL', () => {
      const now = Math.floor(Date.now() / 1000);
      const customTtl = 3600; // 1 hour
      const expiry = calculateVerificationExpiry(customTtl);
      expect(expiry - now).toBe(customTtl);
    });
  });

  describe('isVerificationExpired', () => {
    it('should return false for future timestamp', () => {
      const futureTime = Math.floor(Date.now() / 1000) + 3600;
      expect(isVerificationExpired(futureTime)).toBe(false);
    });

    it('should return true for past timestamp', () => {
      const pastTime = Math.floor(Date.now() / 1000) - 3600;
      expect(isVerificationExpired(pastTime)).toBe(true);
    });
  });

  describe('queryDnsTxtRecords', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('should parse TXT records from DoH response', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          Status: 0,
          Answer: [
            {
              name: '_authrim-verify.example.com.',
              type: 16,
              TTL: 300,
              data: '"authrim-domain-verify=abc123"',
            },
          ],
        }),
      });

      const records = await queryDnsTxtRecords('_authrim-verify.example.com');
      expect(records).toEqual(['authrim-domain-verify=abc123']);
    });

    it('should return empty array for NXDOMAIN', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          Status: 3, // NXDOMAIN
          Answer: undefined,
        }),
      });

      const records = await queryDnsTxtRecords('_authrim-verify.nonexistent.com');
      expect(records).toEqual([]);
    });

    it('should throw on network error', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      await expect(queryDnsTxtRecords('_authrim-verify.example.com')).rejects.toThrow(
        'Network error'
      );
    });
  });

  describe('verifyDomainDnsTxt', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('should return verified:true when record matches', async () => {
      const token = 'test-token-12345';
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          Status: 0,
          Answer: [
            {
              name: '_authrim-verify.example.com.',
              type: 16,
              TTL: 300,
              data: `"authrim-domain-verify=${token}"`,
            },
          ],
        }),
      });

      const result = await verifyDomainDnsTxt('example.com', token);
      expect(result.verified).toBe(true);
      expect(result.recordFound).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should return verified:false when record does not match', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          Status: 0,
          Answer: [
            {
              name: '_authrim-verify.example.com.',
              type: 16,
              TTL: 300,
              data: '"authrim-domain-verify=wrong-token"',
            },
          ],
        }),
      });

      const result = await verifyDomainDnsTxt('example.com', 'expected-token');
      expect(result.verified).toBe(false);
      expect(result.recordFound).toBe(true);
      expect(result.actualValues).toContain('authrim-domain-verify=wrong-token');
    });

    it('should return verified:false when no records found', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          Status: 0,
          Answer: undefined,
        }),
      });

      const result = await verifyDomainDnsTxt('example.com', 'test-token');
      expect(result.verified).toBe(false);
      expect(result.recordFound).toBe(false);
    });

    it('should return error on DNS query failure', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('DNS query failed'));

      const result = await verifyDomainDnsTxt('example.com', 'test-token');
      expect(result.verified).toBe(false);
      expect(result.recordFound).toBe(false);
      expect(result.error).toBe('DNS query failed');
    });
  });
});
