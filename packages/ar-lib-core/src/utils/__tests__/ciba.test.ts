/**
 * CIBA Utilities Unit Tests
 * Tests for CIBA helper functions and validation
 */

import { describe, it, expect } from 'vitest';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import type { JWK } from 'jose';
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
  validateCIBAIdTokenHint,
  validateCIBALoginHintToken,
  CIBA_CONSTANTS,
} from '../ciba';

describe('CIBA Utilities', () => {
  describe('generateAuthReqId', () => {
    it('should generate an unpadded Base64URL value with 256 bits of entropy', () => {
      const authReqId = generateAuthReqId();
      expect(authReqId).toHaveLength(43);
      expect(authReqId).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(CIBA_CONSTANTS.AUTH_REQ_ID_ENTROPY_BITS).toBeGreaterThanOrEqual(160);
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

    it('should accept a requested expiry shorter than the server default', () => {
      const result = validateCIBARequest({
        scope: 'openid',
        login_hint: 'user@example.com',
        requested_expiry: 5,
      });

      expect(result.valid).toBe(true);
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'should reject non-positive or non-integer requested expiry %s',
      (requested_expiry) => {
        const result = validateCIBARequest({
          scope: 'openid',
          login_hint: 'user@example.com',
          requested_expiry,
        });

        expect(result).toEqual({
          valid: false,
          error: 'invalid_request',
          error_description: 'requested_expiry must be a positive integer',
        });
      }
    );
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

  describe('validateCIBAIdTokenHint - Signature Verification', () => {
    const ISSUER_URL = 'https://auth.example.com';

    it('should validate id_token_hint with valid signature', async () => {
      // Generate key pair
      const { privateKey, publicKey } = await generateKeyPair('RS256');
      const publicJwk = await exportJWK(publicKey);
      publicJwk.kid = 'test-key-1';
      publicJwk.alg = 'RS256';
      publicJwk.use = 'sig';

      // Create a valid JWT
      const jwt = await new SignJWT({ sub: 'user-123' })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
        .setIssuedAt()
        .setIssuer(ISSUER_URL)
        .setExpirationTime('1h')
        .sign(privateKey);

      const result = await validateCIBAIdTokenHint(jwt, {
        issuerUrl: ISSUER_URL,
        jwks: { keys: [publicJwk as JWK] },
      });

      expect(result.valid).toBe(true);
      expect(result.subjectId).toBe('user-123');
    });

    it('should reject id_token_hint with invalid signature', async () => {
      // Generate two different key pairs
      const { privateKey: signingKey } = await generateKeyPair('RS256');
      const { publicKey: wrongPublicKey } = await generateKeyPair('RS256');
      const wrongJwk = await exportJWK(wrongPublicKey);
      wrongJwk.kid = 'test-key-1';
      wrongJwk.alg = 'RS256';
      wrongJwk.use = 'sig';

      // Sign with one key
      const jwt = await new SignJWT({ sub: 'user-123' })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
        .setIssuedAt()
        .setIssuer(ISSUER_URL)
        .setExpirationTime('1h')
        .sign(signingKey);

      // Verify with different key - should fail
      const result = await validateCIBAIdTokenHint(jwt, {
        issuerUrl: ISSUER_URL,
        jwks: { keys: [wrongJwk as JWK] },
      });

      expect(result.valid).toBe(false);
      expect(result.error_description).toContain('signature verification failed');
    });

    it('should reject id_token_hint when no matching key in JWKS', async () => {
      const { privateKey } = await generateKeyPair('RS256');
      const { publicKey: differentKey } = await generateKeyPair('RS256');
      const differentJwk = await exportJWK(differentKey);
      differentJwk.kid = 'different-key';
      differentJwk.alg = 'RS256';
      differentJwk.use = 'sig';

      // Sign with kid 'test-key-1'
      const jwt = await new SignJWT({ sub: 'user-123' })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
        .setIssuedAt()
        .setIssuer(ISSUER_URL)
        .setExpirationTime('1h')
        .sign(privateKey);

      // JWKS only has 'different-key'
      const result = await validateCIBAIdTokenHint(jwt, {
        issuerUrl: ISSUER_URL,
        jwks: { keys: [differentJwk as JWK] },
      });

      expect(result.valid).toBe(false);
      expect(result.error_description).toContain('no matching key found');
    });

    it('should skip signature verification when JWKS not provided', async () => {
      const { privateKey } = await generateKeyPair('RS256');

      const jwt = await new SignJWT({ sub: 'user-123' })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
        .setIssuedAt()
        .setIssuer(ISSUER_URL)
        .setExpirationTime('1h')
        .sign(privateKey);

      // No JWKS provided - signature verification is skipped
      const result = await validateCIBAIdTokenHint(jwt, {
        issuerUrl: ISSUER_URL,
      });

      expect(result.valid).toBe(true);
      expect(result.subjectId).toBe('user-123');
    });
  });

  describe('validateCIBALoginHintToken - Signature Verification', () => {
    const AUDIENCE = 'https://auth.example.com';

    it('should validate login_hint_token with valid signature', async () => {
      const { privateKey, publicKey } = await generateKeyPair('ES256');
      const publicJwk = await exportJWK(publicKey);
      publicJwk.kid = 'third-party-key';
      publicJwk.alg = 'ES256';
      publicJwk.use = 'sig';

      const jwt = await new SignJWT({ sub: 'user-456' })
        .setProtectedHeader({ alg: 'ES256', kid: 'third-party-key' })
        .setIssuedAt()
        .setIssuer('https://third-party.com')
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(privateKey);

      const result = await validateCIBALoginHintToken(jwt, {
        audience: AUDIENCE,
        jwks: { keys: [publicJwk as JWK] },
      });

      expect(result.valid).toBe(true);
      expect(result.subjectId).toBe('user-456');
    });

    it('should reject login_hint_token with invalid signature', async () => {
      const { privateKey: signingKey } = await generateKeyPair('ES256');
      const { publicKey: wrongPublicKey } = await generateKeyPair('ES256');
      const wrongJwk = await exportJWK(wrongPublicKey);
      wrongJwk.kid = 'third-party-key';
      wrongJwk.alg = 'ES256';
      wrongJwk.use = 'sig';

      const jwt = await new SignJWT({ sub: 'user-456' })
        .setProtectedHeader({ alg: 'ES256', kid: 'third-party-key' })
        .setIssuedAt()
        .setIssuer('https://third-party.com')
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(signingKey);

      const result = await validateCIBALoginHintToken(jwt, {
        audience: AUDIENCE,
        jwks: { keys: [wrongJwk as JWK] },
      });

      expect(result.valid).toBe(false);
      expect(result.error_description).toContain('signature verification failed');
    });
  });
});
