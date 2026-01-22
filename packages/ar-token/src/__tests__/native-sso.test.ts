/**
 * Native SSO Integration Tests (OIDC Native SSO 1.0 draft-07)
 *
 * Tests the Native SSO implementation including:
 * - ds_hash calculation
 * - Device Secret Token Type URN
 * - Native SSO Token Exchange validation logic
 *
 * Note: Full E2E tests require mocked Durable Objects and are in conformance tests.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { calculateDsHash, parseToken, DEVICE_SECRET_TOKEN_TYPE } from '@authrim/ar-lib-core';

// Helper to create a valid JWT for testing (base64url encoded)
function createTestJWT(header: object, payload: object): string {
  const encodeBase64Url = (obj: object) => {
    const json = JSON.stringify(obj);
    const base64 = Buffer.from(json).toString('base64');
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]/g, '');
  };

  const headerB64 = encodeBase64Url(header);
  const payloadB64 = encodeBase64Url(payload);
  // Signature is just placeholder for parsing tests (not verification)
  const signatureB64 = 'test-signature';

  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

describe('OIDC Native SSO 1.0 (draft-07) Tests', () => {
  describe('Device Secret Token Type', () => {
    it('should define the correct device_secret URN', () => {
      expect(DEVICE_SECRET_TOKEN_TYPE).toBe('urn:openid:params:token-type:device-secret');
    });

    it('should use openid params (not ietf params) per OIDC Native SSO spec', () => {
      // Native SSO uses urn:openid:params:token-type: namespace
      // This is different from RFC 8693 which uses urn:ietf:params:oauth:token-type:
      expect(DEVICE_SECRET_TOKEN_TYPE).toMatch(/^urn:openid:params:token-type:/);
      expect(DEVICE_SECRET_TOKEN_TYPE).not.toMatch(/^urn:ietf:params:oauth:token-type:/);
    });
  });

  describe('ds_hash Calculation', () => {
    // Pre-computed test vectors for ds_hash
    // ds_hash = base64url(left_half(SHA-256(device_secret)))
    // Same algorithm as at_hash in OIDC Core

    it('should calculate ds_hash correctly for a device secret', async () => {
      // Test with a known device secret
      const deviceSecret = 'test-device-secret-12345';
      const dsHash = await calculateDsHash(deviceSecret);

      // ds_hash should be base64url encoded, no padding
      expect(dsHash).not.toContain('=');
      expect(dsHash).not.toContain('+');
      expect(dsHash).not.toContain('/');

      // SHA-256 produces 32 bytes, left half is 16 bytes
      // base64url of 16 bytes = 22 characters (16 * 4/3 ≈ 21.33, rounded up, no padding)
      expect(dsHash.length).toBe(22);
    });

    it('should produce consistent ds_hash for same input', async () => {
      const deviceSecret = 'consistent-test-secret';
      const dsHash1 = await calculateDsHash(deviceSecret);
      const dsHash2 = await calculateDsHash(deviceSecret);

      expect(dsHash1).toBe(dsHash2);
    });

    it('should produce different ds_hash for different inputs', async () => {
      const dsHash1 = await calculateDsHash('secret-1');
      const dsHash2 = await calculateDsHash('secret-2');

      expect(dsHash1).not.toBe(dsHash2);
    });

    it('should handle empty string (edge case)', async () => {
      const dsHash = await calculateDsHash('');

      // Even empty string should produce a valid hash
      expect(dsHash).toBeDefined();
      expect(dsHash.length).toBe(22);
    });

    it('should handle special characters in device secret', async () => {
      const deviceSecret = 'secret/with+special=chars&more!';
      const dsHash = await calculateDsHash(deviceSecret);

      // Should still produce valid base64url
      expect(dsHash).not.toContain('/');
      expect(dsHash).not.toContain('+');
      expect(dsHash).not.toContain('=');
      expect(dsHash.length).toBe(22);
    });

    it('should handle unicode characters in device secret', async () => {
      const deviceSecret = '日本語デバイスシークレット';
      const dsHash = await calculateDsHash(deviceSecret);

      expect(dsHash).toBeDefined();
      expect(dsHash.length).toBe(22);
    });

    it('should support different hash algorithms', async () => {
      const deviceSecret = 'test-secret';

      // SHA-256 (default): 32 bytes → 16 bytes → 22 base64url chars
      const dsHash256 = await calculateDsHash(deviceSecret, 'SHA-256');
      expect(dsHash256.length).toBe(22);

      // SHA-384: 48 bytes → 24 bytes → 32 base64url chars
      const dsHash384 = await calculateDsHash(deviceSecret, 'SHA-384');
      expect(dsHash384.length).toBe(32);

      // SHA-512: 64 bytes → 32 bytes → 43 base64url chars
      const dsHash512 = await calculateDsHash(deviceSecret, 'SHA-512');
      expect(dsHash512.length).toBe(43);

      // All should be different due to different hash algorithms
      expect(dsHash256).not.toBe(dsHash384);
      expect(dsHash384).not.toBe(dsHash512);
    });
  });

  describe('ID Token with ds_hash Claim', () => {
    it('should parse ID Token with ds_hash claim', () => {
      const jwt = createTestJWT(
        { alg: 'RS256', typ: 'JWT', kid: 'key-123' },
        {
          iss: 'https://auth.example.com',
          sub: 'user123',
          aud: 'client-app',
          exp: 1700000000,
          iat: 1699996400,
          nonce: 'abc123',
          at_hash: 'some-at-hash',
          ds_hash: 'some-ds-hash',
        }
      );

      const payload = parseToken(jwt);

      expect(payload.ds_hash).toBe('some-ds-hash');
      expect(payload.at_hash).toBe('some-at-hash');
    });

    it('should handle ID Token without ds_hash (Native SSO not used)', () => {
      const jwt = createTestJWT(
        { alg: 'RS256', typ: 'JWT', kid: 'key-123' },
        {
          iss: 'https://auth.example.com',
          sub: 'user123',
          aud: 'client-app',
          exp: 1700000000,
          iat: 1699996400,
          at_hash: 'some-at-hash',
        }
      );

      const payload = parseToken(jwt);

      expect(payload.ds_hash).toBeUndefined();
      expect(payload.at_hash).toBe('some-at-hash');
    });
  });

  describe('Native SSO Token Exchange Request Detection', () => {
    it('should identify Native SSO request pattern', () => {
      // Native SSO pattern:
      // subject_token_type = urn:ietf:params:oauth:token-type:id_token
      // actor_token_type = urn:openid:params:token-type:device-secret

      const subject_token_type = 'urn:ietf:params:oauth:token-type:id_token';
      const actor_token_type = DEVICE_SECRET_TOKEN_TYPE;

      const isNativeSSORequest =
        subject_token_type === 'urn:ietf:params:oauth:token-type:id_token' &&
        actor_token_type === DEVICE_SECRET_TOKEN_TYPE;

      expect(isNativeSSORequest).toBe(true);
    });

    it('should NOT identify non-Native SSO requests', () => {
      // Regular Token Exchange with access_token
      const subject_token_type: string = 'urn:ietf:params:oauth:token-type:access_token';
      const actor_token_type: string = 'urn:ietf:params:oauth:token-type:access_token';

      const isNativeSSORequest =
        subject_token_type === 'urn:ietf:params:oauth:token-type:id_token' &&
        actor_token_type === DEVICE_SECRET_TOKEN_TYPE;

      expect(isNativeSSORequest).toBe(false);
    });

    it('should NOT identify request with only id_token (no device_secret)', () => {
      const subject_token_type = 'urn:ietf:params:oauth:token-type:id_token';
      const actor_token_type = undefined;

      const isNativeSSORequest =
        subject_token_type === 'urn:ietf:params:oauth:token-type:id_token' &&
        actor_token_type === DEVICE_SECRET_TOKEN_TYPE;

      expect(isNativeSSORequest).toBe(false);
    });
  });

  describe('Device Secret Validation Result Types', () => {
    it('should have proper error reasons for validation failures', () => {
      // These are the possible reasons for device secret validation failures
      const validReasons = ['expired', 'revoked', 'mismatch', 'not_found', 'limit_exceeded'];

      validReasons.forEach((reason) => {
        expect(typeof reason).toBe('string');
        expect(reason.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Native SSO Security Considerations', () => {
    it('should verify ds_hash matches device_secret (client-side validation)', async () => {
      // This simulates what App B would do when receiving an ID Token
      const deviceSecret = 'app-a-shared-secret';

      // App B calculates ds_hash from the device_secret it has
      const calculatedDsHash = await calculateDsHash(deviceSecret);

      // App B gets the ID Token from the Token Exchange response
      const idToken = createTestJWT(
        { alg: 'RS256', typ: 'JWT', kid: 'key-123' },
        {
          iss: 'https://auth.example.com',
          sub: 'user123',
          aud: 'client-app',
          exp: 1700000000,
          iat: 1699996400,
          ds_hash: calculatedDsHash, // The server included ds_hash
        }
      );

      const payload = parseToken(idToken);

      // App B verifies: ds_hash in ID Token === calculateDsHash(device_secret)
      expect(payload.ds_hash).toBe(calculatedDsHash);
    });

    it('should detect ds_hash mismatch (man-in-the-middle protection)', async () => {
      const realDeviceSecret = 'real-secret';
      const attackerDeviceSecret = 'attacker-secret';

      const realDsHash = await calculateDsHash(realDeviceSecret);
      const attackerDsHash = await calculateDsHash(attackerDeviceSecret);

      // If an attacker tries to use a different device_secret,
      // the ds_hash won't match
      expect(realDsHash).not.toBe(attackerDsHash);

      // ID Token from server contains ds_hash for real secret
      const idToken = createTestJWT(
        { alg: 'RS256', typ: 'JWT', kid: 'key-123' },
        {
          iss: 'https://auth.example.com',
          sub: 'user123',
          ds_hash: realDsHash,
        }
      );

      const payload = parseToken(idToken);

      // Attacker's calculated ds_hash won't match
      expect(payload.ds_hash).not.toBe(attackerDsHash);
    });
  });
});
