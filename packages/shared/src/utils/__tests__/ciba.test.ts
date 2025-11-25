/**
 * CIBA Utilities Unit Tests
 * Tests for CIBA helper functions and validation
 */

import { describe, it, expect } from 'vitest';
import {
  generateAuthReqId,
  generateCIBAUserCode,
  validateCIBARequest,
  validateBindingMessage,
  parseLoginHint,
  determineDeliveryMode,
  calculatePollingInterval,
  isCIBARequestExpired,
  isPollingTooFast,
  CIBA_CONSTANTS,
} from '../ciba';

describe('CIBA Utilities', () => {
  describe('generateAuthReqId', () => {
    it('should generate a valid UUID v4', () => {
      const authReqId = generateAuthReqId();
      expect(authReqId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    it('should generate unique IDs', () => {
      const id1 = generateAuthReqId();
      const id2 = generateAuthReqId();
      expect(id1).not.toBe(id2);
    });
  });

  describe('generateCIBAUserCode', () => {
    it('should generate a 9-character user code', () => {
      const userCode = generateCIBAUserCode();
      expect(userCode).toHaveLength(9);
    });

    it('should generate user code in XXXX-XXXX format', () => {
      const userCode = generateCIBAUserCode();
      expect(userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    });

    it('should generate unique user codes', () => {
      const code1 = generateCIBAUserCode();
      const code2 = generateCIBAUserCode();
      expect(code1).not.toBe(code2);
    });
  });

  describe('parseLoginHint', () => {
    it('should parse email login hint', () => {
      const result = parseLoginHint('user@example.com');
      expect(result.type).toBe('email');
      expect(result.value).toBe('user@example.com');
    });

    it('should parse phone login hint', () => {
      const result = parseLoginHint('+1234567890');
      expect(result.type).toBe('phone');
      expect(result.value).toBe('+1234567890');
    });

    it('should parse sub login hint', () => {
      const result = parseLoginHint('sub:user123');
      expect(result.type).toBe('sub');
      expect(result.value).toBe('user123');
    });

    it('should parse username login hint', () => {
      const result = parseLoginHint('username:johndoe');
      expect(result.type).toBe('username');
      expect(result.value).toBe('johndoe');
    });

    it('should default to username for unknown format', () => {
      const result = parseLoginHint('johndoe');
      expect(result.type).toBe('username');
      expect(result.value).toBe('johndoe');
    });
  });

  describe('validateBindingMessage', () => {
    it('should accept binding message within limit', () => {
      const result = validateBindingMessage('Short message');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept binding message exactly at limit', () => {
      const message = 'a'.repeat(CIBA_CONSTANTS.MAX_BINDING_MESSAGE_LENGTH);
      const result = validateBindingMessage(message);
      expect(result.valid).toBe(true);
    });

    it('should reject binding message exceeding limit', () => {
      const message = 'a'.repeat(CIBA_CONSTANTS.MAX_BINDING_MESSAGE_LENGTH + 1);
      const result = validateBindingMessage(message);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('too long');
    });

    it('should accept empty binding message', () => {
      const result = validateBindingMessage('');
      expect(result.valid).toBe(true);
    });

    it('should accept undefined binding message', () => {
      const result = validateBindingMessage(undefined);
      expect(result.valid).toBe(true);
    });
  });

  describe('validateCIBARequest', () => {
    it('should accept valid CIBA request', () => {
      const result = validateCIBARequest({
        scope: 'openid profile',
        login_hint: 'user@example.com',
      });
      expect(result.valid).toBe(true);
    });

    it('should require scope', () => {
      const result = validateCIBARequest({
        scope: '',
        login_hint: 'user@example.com',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_request');
      expect(result.error_description).toContain('scope');
    });

    it('should require at least one login hint', () => {
      const result = validateCIBARequest({
        scope: 'openid profile',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_request');
      expect(result.error_description).toContain('login_hint');
    });

    it('should accept login_hint', () => {
      const result = validateCIBARequest({
        scope: 'openid profile',
        login_hint: 'user@example.com',
      });
      expect(result.valid).toBe(true);
    });

    it('should validate binding message', () => {
      const longMessage = 'a'.repeat(200);
      const result = validateCIBARequest({
        scope: 'openid profile',
        login_hint: 'user@example.com',
        binding_message: longMessage,
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('binding_message');
    });
  });

  describe('determineDeliveryMode', () => {
    it('should default to poll mode', () => {
      const mode = determineDeliveryMode(null, null, null);
      expect(mode).toBe('poll');
    });

    it('should select ping mode when requested', () => {
      const mode = determineDeliveryMode('ping', 'https://client.example.com/callback', 'token123');
      expect(mode).toBe('ping');
    });

    it('should select push mode when requested', () => {
      const mode = determineDeliveryMode('push', 'https://client.example.com/callback', 'token123');
      expect(mode).toBe('push');
    });

    it('should fallback to poll if ping endpoint missing', () => {
      const mode = determineDeliveryMode('ping', null, 'token123');
      expect(mode).toBe('poll');
    });

    it('should fallback to poll if ping token missing', () => {
      const mode = determineDeliveryMode('ping', 'https://client.example.com/callback', null);
      expect(mode).toBe('poll');
    });
  });

  describe('calculatePollingInterval', () => {
    it('should return default interval', () => {
      const interval = calculatePollingInterval(null);
      expect(interval).toBe(CIBA_CONSTANTS.DEFAULT_INTERVAL);
    });

    it('should accept requested interval within limits', () => {
      const interval = calculatePollingInterval(10);
      expect(interval).toBe(10);
    });

    it('should enforce minimum interval', () => {
      const interval = calculatePollingInterval(1);
      expect(interval).toBe(CIBA_CONSTANTS.MIN_INTERVAL);
    });

    it('should enforce maximum interval', () => {
      const interval = calculatePollingInterval(100);
      expect(interval).toBe(CIBA_CONSTANTS.MAX_INTERVAL);
    });
  });

  describe('isCIBARequestExpired', () => {
    it('should return false for non-expired request', () => {
      const metadata = {
        auth_req_id: 'auth_123',
        client_id: 'client_123',
        scope: 'openid',
        status: 'pending' as const,
        delivery_mode: 'poll' as const,
        created_at: Date.now() - 60 * 1000,
        expires_at: Date.now() + 300 * 1000, // 5 minutes in future
        interval: 5,
      };
      const expired = isCIBARequestExpired(metadata);
      expect(expired).toBe(false);
    });

    it('should return true for expired request', () => {
      const metadata = {
        auth_req_id: 'auth_123',
        client_id: 'client_123',
        scope: 'openid',
        status: 'pending' as const,
        delivery_mode: 'poll' as const,
        created_at: Date.now() - 600 * 1000,
        expires_at: Date.now() - 10 * 1000, // 10 seconds ago
        interval: 5,
      };
      const expired = isCIBARequestExpired(metadata);
      expect(expired).toBe(true);
    });

    it('should return true for exactly expired request', () => {
      const metadata = {
        auth_req_id: 'auth_123',
        client_id: 'client_123',
        scope: 'openid',
        status: 'pending' as const,
        delivery_mode: 'poll' as const,
        created_at: Date.now() - 300 * 1000,
        expires_at: Date.now(), // Expires now
        interval: 5,
      };
      const expired = isCIBARequestExpired(metadata);
      expect(expired).toBe(true);
    });
  });

  describe('isPollingTooFast', () => {
    it('should return false when polling at correct interval', () => {
      const metadata = {
        auth_req_id: 'auth_123',
        client_id: 'client_123',
        scope: 'openid',
        status: 'pending' as const,
        delivery_mode: 'poll' as const,
        created_at: Date.now() - 300 * 1000,
        expires_at: Date.now() + 300 * 1000,
        interval: 5, // 5 seconds
        last_poll_at: Date.now() - 6 * 1000, // 6 seconds ago
      };
      const tooFast = isPollingTooFast(metadata);
      expect(tooFast).toBe(false);
    });

    it('should return true when polling too quickly', () => {
      const metadata = {
        auth_req_id: 'auth_123',
        client_id: 'client_123',
        scope: 'openid',
        status: 'pending' as const,
        delivery_mode: 'poll' as const,
        created_at: Date.now() - 300 * 1000,
        expires_at: Date.now() + 300 * 1000,
        interval: 5, // 5 seconds
        last_poll_at: Date.now() - 2 * 1000, // 2 seconds ago (too fast)
      };
      const tooFast = isPollingTooFast(metadata);
      expect(tooFast).toBe(true);
    });

    it('should return false for first poll', () => {
      const metadata = {
        auth_req_id: 'auth_123',
        client_id: 'client_123',
        scope: 'openid',
        status: 'pending' as const,
        delivery_mode: 'poll' as const,
        created_at: Date.now() - 10 * 1000,
        expires_at: Date.now() + 300 * 1000,
        interval: 5, // 5 seconds
        // No last_poll_at - first poll
      };
      const tooFast = isPollingTooFast(metadata);
      expect(tooFast).toBe(false);
    });

    it('should return false when exactly at interval', () => {
      const metadata = {
        auth_req_id: 'auth_123',
        client_id: 'client_123',
        scope: 'openid',
        status: 'pending' as const,
        delivery_mode: 'poll' as const,
        created_at: Date.now() - 300 * 1000,
        expires_at: Date.now() + 300 * 1000,
        interval: 5, // 5 seconds
        last_poll_at: Date.now() - 5 * 1000, // Exactly 5 seconds ago
      };
      const tooFast = isPollingTooFast(metadata);
      expect(tooFast).toBe(false);
    });
  });
});
