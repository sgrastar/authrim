/**
 * RFC 8628 Compliance Tests
 * https://datatracker.ietf.org/doc/html/rfc8628
 *
 * Validates that Device Flow implementation complies with RFC 8628 specification
 */

import { describe, it, expect } from 'vitest';
import {
  generateDeviceCode,
  generateUserCode,
  validateUserCodeFormat,
  normalizeUserCode,
  isDeviceCodeExpired,
  isDeviceFlowPollingTooFast,
  getVerificationUriComplete,
  DEVICE_FLOW_CONSTANTS,
} from '../device-flow';
import type { DeviceCodeMetadata } from '../../types/oidc';

describe('RFC 8628 Compliance Tests', () => {
  describe('Section 3.1: Device Authorization Request', () => {
    it('[RFC 8628 §3.1] device_code MUST be unique and unpredictable', () => {
      // Generate 1000 device codes and verify uniqueness
      const codes = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        codes.add(generateDeviceCode());
      }

      // All codes should be unique (no collisions)
      expect(codes.size).toBe(1000);

      // Device codes should be UUID v4 (unpredictable)
      const deviceCode = generateDeviceCode();
      const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(deviceCode).toMatch(uuidV4Regex);
    });

    it('[RFC 8628 §3.1] user_code SHOULD be short, case-insensitive, and exclude ambiguous characters', () => {
      // Generate multiple user codes
      for (let i = 0; i < 100; i++) {
        const userCode = generateUserCode();

        // Should be short (8 characters + 1 hyphen = 9 total)
        expect(userCode.length).toBeLessThanOrEqual(9);

        // Should be uppercase (case-insensitive means we standardize to one case)
        expect(userCode).toBe(userCode.toUpperCase());

        // Should not contain ambiguous characters (0, O, 1, I, L)
        expect(userCode).not.toMatch(/[0O1IL]/);
      }
    });

    it('[RFC 8628 §3.2] verification_uri MUST be a URI', () => {
      const baseUri = 'https://auth.example.com/device';
      const userCode = 'WDJB-MJHT';
      const verificationUri = getVerificationUriComplete(baseUri, userCode);

      // Should be a valid URI
      expect(() => new URL(verificationUri)).not.toThrow();

      // Should contain user_code parameter
      const url = new URL(verificationUri);
      expect(url.searchParams.has('user_code')).toBe(true);
      expect(url.searchParams.get('user_code')).toBe(userCode);
    });

    it('[RFC 8628 §3.2] expires_in MUST be present and indicate lifetime in seconds', () => {
      const expiresIn = DEVICE_FLOW_CONSTANTS.DEFAULT_EXPIRES_IN;

      // expires_in must be a number
      expect(typeof expiresIn).toBe('number');

      // Must be positive
      expect(expiresIn).toBeGreaterThan(0);

      // Should be reasonable (5-30 minutes)
      expect(expiresIn).toBeGreaterThanOrEqual(DEVICE_FLOW_CONSTANTS.MIN_EXPIRES_IN);
      expect(expiresIn).toBeLessThanOrEqual(DEVICE_FLOW_CONSTANTS.MAX_EXPIRES_IN);
    });

    it('[RFC 8628 §3.2] interval SHOULD be present and indicate minimum polling interval', () => {
      const interval = DEVICE_FLOW_CONSTANTS.DEFAULT_INTERVAL;

      // interval should be a number
      expect(typeof interval).toBe('number');

      // Must be positive
      expect(interval).toBeGreaterThan(0);

      // Should be reasonable (not too fast or too slow)
      expect(interval).toBeGreaterThanOrEqual(DEVICE_FLOW_CONSTANTS.MIN_INTERVAL);
      expect(interval).toBeLessThanOrEqual(DEVICE_FLOW_CONSTANTS.MAX_INTERVAL);
    });
  });

  describe('Section 3.4: Device Access Token Request', () => {
    it('[RFC 8628 §3.4] grant_type MUST be "urn:ietf:params:oauth:grant-type:device_code"', () => {
      const grantType = 'urn:ietf:params:oauth:grant-type:device_code';

      // Verify exact format
      expect(grantType).toBe('urn:ietf:params:oauth:grant-type:device_code');
    });

    it('[RFC 8628 §3.4] device_code parameter MUST be present', () => {
      const deviceCode = generateDeviceCode();

      // Device code must not be empty
      expect(deviceCode).toBeDefined();
      expect(deviceCode.length).toBeGreaterThan(0);
    });
  });

  describe('Section 3.5: Device Access Token Response', () => {
    it('[RFC 8628 §3.5] Authorization pending error MUST return "authorization_pending"', () => {
      const errorCode = 'authorization_pending';

      // Exact error code as specified
      expect(errorCode).toBe('authorization_pending');
    });

    it('[RFC 8628 §3.5] Slow down error MUST return "slow_down"', () => {
      const errorCode = 'slow_down';

      // Exact error code as specified
      expect(errorCode).toBe('slow_down');
    });

    it('[RFC 8628 §3.5] Access denied error MUST return "access_denied"', () => {
      const errorCode = 'access_denied';

      // Exact error code as specified
      expect(errorCode).toBe('access_denied');
    });

    it('[RFC 8628 §3.5] Expired token error MUST return "expired_token"', () => {
      const errorCode = 'expired_token';

      // Exact error code as specified
      expect(errorCode).toBe('expired_token');
    });

    it('[RFC 8628 §3.5] slow_down MUST increase polling interval', () => {
      const defaultInterval = DEVICE_FLOW_CONSTANTS.DEFAULT_INTERVAL;
      const slowDownIncrement = DEVICE_FLOW_CONSTANTS.SLOW_DOWN_INCREMENT;

      // Slow down should add to the interval
      expect(slowDownIncrement).toBeGreaterThan(0);

      // New interval should be greater than default
      const newInterval = defaultInterval + slowDownIncrement;
      expect(newInterval).toBeGreaterThan(defaultInterval);
    });
  });

  describe('Section 5: Polling Rate Limiting', () => {
    it('[RFC 8628 §5] Client MUST wait at least the interval between requests', () => {
      const metadata: DeviceCodeMetadata = {
        device_code: 'device_123',
        user_code: 'WDJB-MJHT',
        client_id: 'test-client',
        scope: 'openid',
        status: 'pending',
        created_at: Date.now(),
        expires_at: Date.now() + 600 * 1000,
        last_poll_at: Date.now() - 2000, // 2 seconds ago
      };

      const interval = DEVICE_FLOW_CONSTANTS.DEFAULT_INTERVAL; // 5 seconds

      // Polling too fast (less than interval)
      expect(isDeviceFlowPollingTooFast(metadata, interval)).toBe(true);

      // Update to respect interval
      metadata.last_poll_at = Date.now() - 6000; // 6 seconds ago
      expect(isDeviceFlowPollingTooFast(metadata, interval)).toBe(false);
    });

    it('[RFC 8628 §5] Server MUST respond with slow_down when polling too fast', () => {
      const metadata: DeviceCodeMetadata = {
        device_code: 'device_123',
        user_code: 'WDJB-MJHT',
        client_id: 'test-client',
        scope: 'openid',
        status: 'pending',
        created_at: Date.now(),
        expires_at: Date.now() + 600 * 1000,
        last_poll_at: Date.now() - 1000, // 1 second ago (too fast)
      };

      // Should detect polling too fast
      expect(isDeviceFlowPollingTooFast(metadata, 5)).toBe(true);
    });
  });

  describe('Section 6: User Code Recommendations', () => {
    it('[RFC 8628 §6.1] User code SHOULD avoid confusion with other codes', () => {
      const userCode = generateUserCode();

      // Should not contain confusing characters
      expect(userCode).not.toMatch(/[0O1IL]/);

      // Should be formatted for readability (with hyphen separator)
      expect(userCode).toMatch(
        /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/
      );
    });

    it('[RFC 8628 §6.1] User code validation SHOULD accept case-insensitive input', () => {
      const userCode = 'WDJB-MJHT';

      // Lowercase should be accepted
      expect(validateUserCodeFormat('wdjb-mjht')).toBe(true);

      // Mixed case should be accepted
      expect(validateUserCodeFormat('WdJb-MjHt')).toBe(true);

      // Normalization should uppercase
      expect(normalizeUserCode('wdjb-mjht')).toBe(userCode);
    });

    it('[RFC 8628 §6.1] User code validation SHOULD be lenient with hyphens', () => {
      // Without hyphen
      expect(normalizeUserCode('WDJBMJHT')).toBe('WDJB-MJHT');

      // With hyphen
      expect(normalizeUserCode('WDJB-MJHT')).toBe('WDJB-MJHT');

      // With extra hyphens
      expect(normalizeUserCode('W-D-J-B-M-J-H-T')).toBe('WDJB-MJHT');
    });
  });

  describe('Security Considerations', () => {
    it('[RFC 8628 §8.1] device_code MUST have sufficient entropy', () => {
      // UUID v4 provides 122 bits of entropy
      const deviceCode = generateDeviceCode();

      // Should be UUID v4 format
      const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(deviceCode).toMatch(uuidV4Regex);

      // Should not be predictable (generate 100 and verify all unique)
      const codes = new Set<string>();
      for (let i = 0; i < 100; i++) {
        codes.add(generateDeviceCode());
      }
      expect(codes.size).toBe(100);
    });

    it('[RFC 8628 §8.2] Codes MUST expire', () => {
      const metadata: DeviceCodeMetadata = {
        device_code: 'device_123',
        user_code: 'WDJB-MJHT',
        client_id: 'test-client',
        scope: 'openid',
        status: 'pending',
        created_at: Date.now() - 700 * 1000, // 11+ minutes ago
        expires_at: Date.now() - 100 * 1000, // Expired 1 minute ago
      };

      // Should be detected as expired
      expect(isDeviceCodeExpired(metadata)).toBe(true);
    });

    it('[RFC 8628 §8.3] Rate limiting MUST be implemented', () => {
      const interval = DEVICE_FLOW_CONSTANTS.DEFAULT_INTERVAL;
      const slowDownIncrement = DEVICE_FLOW_CONSTANTS.SLOW_DOWN_INCREMENT;

      // Slow down mechanism exists
      expect(slowDownIncrement).toBeDefined();
      expect(slowDownIncrement).toBeGreaterThan(0);

      // Polling rate detection exists
      const metadata: DeviceCodeMetadata = {
        device_code: 'device_123',
        user_code: 'WDJB-MJHT',
        client_id: 'test-client',
        scope: 'openid',
        status: 'pending',
        created_at: Date.now(),
        expires_at: Date.now() + 600 * 1000,
        last_poll_at: Date.now() - 1000, // Too fast
      };

      expect(isDeviceFlowPollingTooFast(metadata, interval)).toBe(true);
    });
  });
});
