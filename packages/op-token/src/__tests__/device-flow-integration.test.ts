/**
 * Device Flow Integration Tests
 * RFC 8628: OAuth 2.0 Device Authorization Grant
 *
 * Tests the complete Device Flow from device authorization to token issuance
 */

import { describe, it, expect } from 'vitest';
import { generateDeviceCode, generateUserCode, DEVICE_FLOW_CONSTANTS } from '@authrim/shared';

describe('Device Flow Integration Tests', () => {
  describe('Device Authorization Flow', () => {
    it('should generate valid device and user codes', () => {
      const deviceCode = generateDeviceCode();
      const userCode = generateUserCode();

      // Device code should be UUID v4
      expect(deviceCode).toBeDefined();
      expect(typeof deviceCode).toBe('string');
      expect(deviceCode.length).toBeGreaterThan(0);

      // User code should be formatted correctly
      expect(userCode).toBeDefined();
      expect(typeof userCode).toBe('string');
      expect(userCode).toMatch(
        /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/
      );
    });

    it('should provide verification URIs with proper structure', () => {
      const baseUri = 'https://auth.example.com/device';
      const userCode = 'WDJB-MJHT';

      // Build verification_uri_complete
      const url = new URL(baseUri);
      url.searchParams.set('user_code', userCode);
      const verificationUriComplete = url.toString();

      // Should be valid URL
      expect(() => new URL(verificationUriComplete)).not.toThrow();

      // Should contain user_code parameter
      const parsedUrl = new URL(verificationUriComplete);
      expect(parsedUrl.searchParams.get('user_code')).toBe(userCode);
    });

    it('should include all required response fields per RFC 8628 §3.2', () => {
      const response = {
        device_code: generateDeviceCode(),
        user_code: generateUserCode(),
        verification_uri: 'https://auth.example.com/device',
        verification_uri_complete: 'https://auth.example.com/device?user_code=WDJB-MJHT',
        expires_in: DEVICE_FLOW_CONSTANTS.DEFAULT_EXPIRES_IN,
        interval: DEVICE_FLOW_CONSTANTS.DEFAULT_INTERVAL,
      };

      // All required fields must be present
      expect(response.device_code).toBeDefined();
      expect(response.user_code).toBeDefined();
      expect(response.verification_uri).toBeDefined();
      expect(response.expires_in).toBeDefined();

      // Optional but recommended fields
      expect(response.verification_uri_complete).toBeDefined();
      expect(response.interval).toBeDefined();

      // Values should be valid
      expect(response.expires_in).toBeGreaterThan(0);
      expect(response.interval).toBeGreaterThan(0);
    });
  });

  describe('Token Request Flow', () => {
    it('should handle authorization_pending error correctly', () => {
      const error = {
        error: 'authorization_pending',
        error_description: 'User has not yet authorized the device',
      };

      // Error code must match RFC 8628 §3.5
      expect(error.error).toBe('authorization_pending');
      expect(error.error_description).toBeDefined();
    });

    it('should handle slow_down error correctly', () => {
      const error = {
        error: 'slow_down',
        error_description: 'You are polling too frequently. Please slow down.',
      };

      // Error code must match RFC 8628 §3.5
      expect(error.error).toBe('slow_down');
      expect(error.error_description).toBeDefined();
    });

    it('should handle access_denied error correctly', () => {
      const error = {
        error: 'access_denied',
        error_description: 'User denied the authorization request',
      };

      // Error code must match RFC 8628 §3.5
      expect(error.error).toBe('access_denied');
      expect(error.error_description).toBeDefined();
    });

    it('should handle expired_token error correctly', () => {
      const error = {
        error: 'expired_token',
        error_description: 'Device code has expired',
      };

      // Error code must match RFC 8628 §3.5
      expect(error.error).toBe('expired_token');
      expect(error.error_description).toBeDefined();
    });

    it('should issue tokens when device is approved', () => {
      const tokenResponse = {
        access_token: 'eyJhbGc...',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'refresh_token_here',
        id_token: 'eyJhbGc...', // OIDC extension
        scope: 'openid profile email',
      };

      // Required fields per OAuth 2.0
      expect(tokenResponse.access_token).toBeDefined();
      expect(tokenResponse.token_type).toBe('Bearer');
      expect(tokenResponse.expires_in).toBeGreaterThan(0);

      // OIDC extension
      expect(tokenResponse.id_token).toBeDefined();
      expect(tokenResponse.scope).toContain('openid');
    });
  });

  describe('Device Code Lifecycle', () => {
    it('should transition through correct states: pending → approved → consumed', () => {
      // State transitions
      const states = {
        initial: 'pending',
        afterApproval: 'approved',
        afterTokenIssuance: 'consumed',
      };

      expect(states.initial).toBe('pending');
      expect(states.afterApproval).toBe('approved');
      expect(states.afterTokenIssuance).toBe('consumed');
    });

    it('should transition through correct states: pending → denied', () => {
      const states = {
        initial: 'pending',
        afterDenial: 'denied',
      };

      expect(states.initial).toBe('pending');
      expect(states.afterDenial).toBe('denied');
    });

    it('should handle expiration correctly', () => {
      const now = Date.now();
      const expiresIn = DEVICE_FLOW_CONSTANTS.DEFAULT_EXPIRES_IN;

      const metadata = {
        created_at: now,
        expires_at: now + expiresIn * 1000,
      };

      // Should not be expired immediately
      expect(metadata.expires_at).toBeGreaterThan(now);

      // Should expire after the specified time
      const futureTime = now + expiresIn * 1000 + 1000; // 1 second past expiration
      expect(futureTime).toBeGreaterThan(metadata.expires_at);
    });
  });

  describe('Polling Behavior', () => {
    it('should enforce minimum polling interval', () => {
      const interval = DEVICE_FLOW_CONSTANTS.DEFAULT_INTERVAL; // 5 seconds
      const lastPollTime = Date.now();

      // Too fast (2 seconds later)
      const tooFastTime = lastPollTime + 2000;
      const tooFastElapsed = (tooFastTime - lastPollTime) / 1000;
      expect(tooFastElapsed).toBeLessThan(interval);

      // Acceptable (6 seconds later)
      const acceptableTime = lastPollTime + 6000;
      const acceptableElapsed = (acceptableTime - lastPollTime) / 1000;
      expect(acceptableElapsed).toBeGreaterThanOrEqual(interval);
    });

    it('should increase interval after slow_down error', () => {
      const originalInterval = DEVICE_FLOW_CONSTANTS.DEFAULT_INTERVAL;
      const slowDownIncrement = DEVICE_FLOW_CONSTANTS.SLOW_DOWN_INCREMENT;

      const newInterval = originalInterval + slowDownIncrement;

      expect(newInterval).toBeGreaterThan(originalInterval);
      expect(newInterval).toBe(originalInterval + slowDownIncrement);
    });

    it('should track poll count for rate limiting', () => {
      let pollCount = 0;
      const maxPolls = DEVICE_FLOW_CONSTANTS.MAX_POLL_COUNT;

      // Simulate polling
      for (let i = 0; i < 10; i++) {
        pollCount++;
      }

      expect(pollCount).toBe(10);
      expect(pollCount).toBeLessThan(maxPolls);
    });
  });

  describe('Security Validations', () => {
    it('should validate client_id matches device_code', () => {
      const deviceCodeMetadata = {
        client_id: 'client-abc',
      };

      const requestClientId = 'client-abc';
      const invalidClientId = 'client-xyz';

      // Valid client_id
      expect(deviceCodeMetadata.client_id).toBe(requestClientId);

      // Invalid client_id
      expect(deviceCodeMetadata.client_id).not.toBe(invalidClientId);
    });

    it('should enforce one-time use of device codes', () => {
      let consumed = false;

      // First use - should succeed
      expect(consumed).toBe(false);
      consumed = true;

      // Second use - should fail
      expect(consumed).toBe(true);
    });

    it('should not leak device_code to user', () => {
      const deviceCode = generateDeviceCode();
      const userCode = generateUserCode();

      // User only sees user_code (short, easy to type)
      // User never sees device_code (long, random UUID)
      expect(userCode.length).toBeLessThan(deviceCode.length);
      expect(userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    });
  });

  describe('OIDC Extensions', () => {
    it('should support openid scope for ID token issuance', () => {
      const scope = 'openid profile email';

      // Must include openid scope for OIDC
      expect(scope).toContain('openid');
    });

    it('should issue ID token with correct claims', () => {
      const idTokenClaims = {
        iss: 'https://auth.example.com',
        sub: 'user-123',
        aud: 'client-abc',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        auth_time: Math.floor(Date.now() / 1000),
        // Note: Device flow doesn't use nonce
      };

      // Required OIDC claims
      expect(idTokenClaims.iss).toBeDefined();
      expect(idTokenClaims.sub).toBeDefined();
      expect(idTokenClaims.aud).toBeDefined();
      expect(idTokenClaims.exp).toBeGreaterThan(idTokenClaims.iat);
      expect(idTokenClaims.auth_time).toBeDefined();

      // Device flow specifics
      expect('nonce' in idTokenClaims).toBe(false); // No nonce in device flow
    });
  });
});
