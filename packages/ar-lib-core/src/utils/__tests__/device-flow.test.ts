/**
 * Device Flow Utilities Tests
 * RFC 8628: OAuth 2.0 Device Authorization Grant
 */

import { describe, it, expect } from 'vitest';
import {
  generateDeviceCode,
  generateUserCode,
  validateUserCodeFormat,
  normalizeUserCode,
  formatUserCode,
  isDeviceCodeExpired,
  isDeviceFlowPollingTooFast,
  getVerificationUriComplete,
  DEVICE_FLOW_CONSTANTS,
} from '../device-flow';
import type { DeviceCodeMetadata } from '../../types/oidc';

describe('Device Flow Utilities', () => {
  describe('generateDeviceCode', () => {
    it('should generate a valid UUID v4 device code', () => {
      const deviceCode = generateDeviceCode();

      expect(deviceCode).toBeDefined();
      expect(typeof deviceCode).toBe('string');
      expect(deviceCode.length).toBeGreaterThan(0);

      // UUID v4 format: xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(deviceCode).toMatch(uuidRegex);
    });

    it('should generate unique device codes', () => {
      const codes = new Set<string>();
      for (let i = 0; i < 100; i++) {
        codes.add(generateDeviceCode());
      }

      expect(codes.size).toBe(100); // All codes should be unique
    });
  });

  describe('generateUserCode', () => {
    it('should generate a valid user code in XXXX-XXXX format', () => {
      const userCode = generateUserCode();

      expect(userCode).toBeDefined();
      expect(typeof userCode).toBe('string');
      expect(userCode.length).toBe(9); // 4 + hyphen + 4

      // Format: XXXX-XXXX (uppercase letters and digits, excluding 0, O, 1, I, L)
      const userCodeRegex =
        /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;
      expect(userCode).toMatch(userCodeRegex);
    });

    it('should not contain ambiguous characters (0, O, 1, I, L)', () => {
      for (let i = 0; i < 100; i++) {
        const userCode = generateUserCode();
        expect(userCode).not.toMatch(/[0O1IL]/);
      }
    });

    it('should generate unique user codes', () => {
      const codes = new Set<string>();
      for (let i = 0; i < 100; i++) {
        codes.add(generateUserCode());
      }

      // With 32^8 possibilities, 100 codes should be unique
      expect(codes.size).toBe(100);
    });
  });

  describe('validateUserCodeFormat', () => {
    it('accepts a well-formed code in every length and shape the server issues', () => {
      expect(validateUserCodeFormat('WDJB-MJHT')).toBe(true);
      expect(validateUserCodeFormat('2345-6789')).toBe(true);
      expect(validateUserCodeFormat('WDJBMJHT')).toBe(true);
      expect(validateUserCodeFormat('ABCD')).toBe(true);
      expect(validateUserCodeFormat('1234-5678-901')).toBe(true);
      expect(validateUserCodeFormat('ABCD-EFGH-JKMN-PQRS')).toBe(true);
    });

    it('accepts any case, space and hyphen variant', () => {
      expect(validateUserCodeFormat('wdjb-mjht')).toBe(true);
      expect(validateUserCodeFormat('WdJb-MjHt')).toBe(true);
      expect(validateUserCodeFormat('wdjb mjht')).toBe(true);
      expect(validateUserCodeFormat(' WDJB\u2013MJHT ')).toBe(true);
    });

    it('does not judge the alphabet: the tenant setting may have changed since the code was issued', () => {
      // 0, O, 1, I and L are not in BASE31, but a NUMERIC code has 0 and 1
      expect(validateUserCodeFormat('0123-4567')).toBe(true);
      expect(validateUserCodeFormat('O1IL-ABCD')).toBe(true);
    });

    it('rejects what cannot be a code', () => {
      expect(validateUserCodeFormat('')).toBe(false);
      expect(validateUserCodeFormat('WDJ')).toBe(false); // 3 characters
      expect(validateUserCodeFormat('ABCD-EFGH-JKMN-PQRS-T')).toBe(false); // 17 characters
      expect(validateUserCodeFormat('WDJB_MJHT')).toBe(false); // underscore is not a separator
      expect(validateUserCodeFormat('WDJB.MJHT')).toBe(false);
      expect(validateUserCodeFormat('WDJB-MJH\u00dc')).toBe(false); // not A-Z
      expect(validateUserCodeFormat('WDJB-MJH%')).toBe(false);
      expect(validateUserCodeFormat('<script>')).toBe(false);
    });
  });

  describe('normalizeUserCode', () => {
    it('is upper case with the separators removed', () => {
      expect(normalizeUserCode('wdjbmjht')).toBe('WDJBMJHT');
      expect(normalizeUserCode('wdjb-mjht')).toBe('WDJBMJHT');
      expect(normalizeUserCode('WdJbMjHt')).toBe('WDJBMJHT');
      expect(normalizeUserCode(' wdjb  mjht ')).toBe('WDJBMJHT');
    });

    it('removes any number of hyphens, of any kind', () => {
      expect(normalizeUserCode('WD-JB-MJ-HT')).toBe('WDJBMJHT');
      expect(normalizeUserCode('W-D-J-B-M-J-H-T')).toBe('WDJBMJHT');
      for (const hyphen of ['\u2010', '\u2011', '\u2012', '\u2013', '\u2014', '\u2212', '\uFF0D']) {
        expect(normalizeUserCode(`WDJB${hyphen}MJHT`), hyphen).toBe('WDJBMJHT');
      }
    });

    it('keeps the length of the code: it is not padded or grouped', () => {
      expect(normalizeUserCode('1234-5678-901')).toBe('12345678901');
      expect(normalizeUserCode('abcd')).toBe('ABCD');
    });
  });

  describe('formatUserCode', () => {
    it.each([
      ['ABCD', 'ABCD'],
      ['ABCDE', 'ABCD-E'],
      ['ABCDEFGH', 'ABCD-EFGH'],
      ['12345678901', '1234-5678-901'],
      ['abcdefghjkmnpqrs', 'ABCD-EFGH-JKMN-PQRS'],
      ['abcd efgh', 'ABCD-EFGH'],
      ['AB-CDEF-GH', 'ABCD-EFGH'],
    ])('%s -> %s', (typed, shown) => {
      expect(formatUserCode(typed)).toBe(shown);
    });

    it('is the inverse of normalizeUserCode for every length', () => {
      for (let length = 4; length <= 16; length++) {
        const canonical = 'ABCDEFGHJKMNPQRS'.slice(0, length);
        expect(normalizeUserCode(formatUserCode(canonical))).toBe(canonical);
        expect(formatUserCode(formatUserCode(canonical))).toBe(formatUserCode(canonical));
      }
    });
  });

  describe('isDeviceCodeExpired', () => {
    it('should return false for non-expired device codes', () => {
      const metadata: DeviceCodeMetadata = {
        device_code: 'device_123',
        user_code: 'WDJB-MJHT',
        client_id: 'test-client',
        scope: 'openid',
        status: 'pending',
        created_at: Date.now(),
        expires_at: Date.now() + 600 * 1000, // 10 minutes from now
      };

      expect(isDeviceCodeExpired(metadata)).toBe(false);
    });

    it('should return true for expired device codes', () => {
      const metadata: DeviceCodeMetadata = {
        device_code: 'device_123',
        user_code: 'WDJB-MJHT',
        client_id: 'test-client',
        scope: 'openid',
        status: 'pending',
        created_at: Date.now() - 700 * 1000, // 11 minutes ago
        expires_at: Date.now() - 100 * 1000, // 1 minute ago (expired)
      };

      expect(isDeviceCodeExpired(metadata)).toBe(true);
    });

    it('should return true for device codes that just expired', () => {
      const metadata: DeviceCodeMetadata = {
        device_code: 'device_123',
        user_code: 'WDJB-MJHT',
        client_id: 'test-client',
        scope: 'openid',
        status: 'pending',
        created_at: Date.now() - 600 * 1000,
        expires_at: Date.now() - 1, // Just expired (1ms ago)
      };

      expect(isDeviceCodeExpired(metadata)).toBe(true);
    });
  });

  describe('isDeviceFlowPollingTooFast', () => {
    it('should return false if no previous poll', () => {
      const metadata: DeviceCodeMetadata = {
        device_code: 'device_123',
        user_code: 'WDJB-MJHT',
        client_id: 'test-client',
        scope: 'openid',
        status: 'pending',
        created_at: Date.now(),
        expires_at: Date.now() + 600 * 1000,
        // No last_poll_at
      };

      expect(isDeviceFlowPollingTooFast(metadata, 5)).toBe(false);
    });

    it('should return true if polling too fast', () => {
      const metadata: DeviceCodeMetadata = {
        device_code: 'device_123',
        user_code: 'WDJB-MJHT',
        client_id: 'test-client',
        scope: 'openid',
        status: 'pending',
        created_at: Date.now(),
        expires_at: Date.now() + 600 * 1000,
        last_poll_at: Date.now() - 2000, // 2 seconds ago (< 5 second interval)
      };

      expect(isDeviceFlowPollingTooFast(metadata, 5)).toBe(true);
    });

    it('should return false if polling at correct interval', () => {
      const metadata: DeviceCodeMetadata = {
        device_code: 'device_123',
        user_code: 'WDJB-MJHT',
        client_id: 'test-client',
        scope: 'openid',
        status: 'pending',
        created_at: Date.now(),
        expires_at: Date.now() + 600 * 1000,
        last_poll_at: Date.now() - 6000, // 6 seconds ago (> 5 second interval)
      };

      expect(isDeviceFlowPollingTooFast(metadata, 5)).toBe(false);
    });

    it('should use default interval of 5 seconds', () => {
      const metadata: DeviceCodeMetadata = {
        device_code: 'device_123',
        user_code: 'WDJB-MJHT',
        client_id: 'test-client',
        scope: 'openid',
        status: 'pending',
        created_at: Date.now(),
        expires_at: Date.now() + 600 * 1000,
        last_poll_at: Date.now() - 3000, // 3 seconds ago
      };

      expect(isDeviceFlowPollingTooFast(metadata)).toBe(true); // Default 5 seconds
    });
  });

  describe('getVerificationUriComplete', () => {
    it('should create complete verification URI with user code', () => {
      const baseUri = 'https://auth.example.com/device';
      const userCode = 'WDJB-MJHT';

      const uri = getVerificationUriComplete(baseUri, userCode);

      expect(uri).toBe('https://auth.example.com/device?user_code=WDJB-MJHT');
    });

    it('should preserve existing query parameters', () => {
      const baseUri = 'https://auth.example.com/device?foo=bar';
      const userCode = 'WDJB-MJHT';

      const uri = getVerificationUriComplete(baseUri, userCode);

      expect(uri).toContain('foo=bar');
      expect(uri).toContain('user_code=WDJB-MJHT');
    });

    it('should URL-encode user code', () => {
      const baseUri = 'https://auth.example.com/device';
      const userCode = 'TEST CODE'; // Space needs encoding

      const uri = getVerificationUriComplete(baseUri, userCode);

      expect(uri).toContain('user_code=TEST+CODE');
    });
  });

  describe('DEVICE_FLOW_CONSTANTS', () => {
    it('should have valid expiration time constants', () => {
      expect(DEVICE_FLOW_CONSTANTS.DEFAULT_EXPIRES_IN).toBe(600); // 10 minutes
      expect(DEVICE_FLOW_CONSTANTS.MIN_EXPIRES_IN).toBe(300); // 5 minutes
      expect(DEVICE_FLOW_CONSTANTS.MAX_EXPIRES_IN).toBe(1800); // 30 minutes
    });

    it('should have valid interval constants', () => {
      expect(DEVICE_FLOW_CONSTANTS.DEFAULT_INTERVAL).toBe(5); // 5 seconds
      expect(DEVICE_FLOW_CONSTANTS.MIN_INTERVAL).toBe(1); // 1 second
      expect(DEVICE_FLOW_CONSTANTS.MAX_INTERVAL).toBe(60); // 1 minute
    });

    it('should have valid slow down increment', () => {
      expect(DEVICE_FLOW_CONSTANTS.SLOW_DOWN_INCREMENT).toBe(5); // 5 seconds
    });

    it('should have valid max poll count', () => {
      expect(DEVICE_FLOW_CONSTANTS.MAX_POLL_COUNT).toBe(120); // 120 polls
    });
  });
});
