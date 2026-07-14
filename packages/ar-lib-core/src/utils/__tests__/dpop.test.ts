/**
 * DPoP (Demonstrating Proof of Possession) Tests
 * RFC 9449
 */

import { beforeAll, describe, it, expect, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, base64url, type JWK } from 'jose';
import {
  calculateAccessTokenHash,
  extractDPoPProof,
  isDPoPBoundToken,
  extractDPoPToken,
  isDPoPCriticalPath,
  isDPoPRequiredForRequest,
  validateDPoPProof,
} from '../dpop';
import { ALLOWED_DPOP_ALGS } from '../../constants';

describe('DPoP Utilities', () => {
  let privateKey: CryptoKey;
  let publicJwk: JWK;

  beforeAll(async () => {
    const pair = await generateKeyPair('ES256');
    privateKey = pair.privateKey as CryptoKey;
    publicJwk = await exportJWK(pair.publicKey);
  });

  async function proof(
    claims: Record<string, unknown> = {},
    header: Record<string, unknown> = {}
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      jti: 'jti-1',
      htm: 'POST',
      htu: 'https://api.example/token',
      iat: now,
      ...claims,
    })
      .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: publicJwk, ...header })
      .sign(privateKey);
  }

  function namespace(status = 200, body?: unknown) {
    const fetch = vi.fn(
      async () =>
        new Response(body === undefined ? null : JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    return {
      idFromName: vi.fn((name: string) => `id:${name}`),
      get: vi.fn(() => ({ fetch })),
      fetch,
    };
  }
  describe('Phase 1 algorithm policy', () => {
    it('should allow only the Phase 1 DPoP signing algorithms', () => {
      expect(ALLOWED_DPOP_ALGS).toEqual(['ES256', 'PS256', 'EdDSA']);
    });
  });

  describe('calculateAccessTokenHash', () => {
    it('should calculate SHA-256 hash of access token', async () => {
      const token = 'test_access_token_123';
      const hash = await calculateAccessTokenHash(token);

      // Hash should be base64url-encoded string
      expect(hash).toBeTypeOf('string');
      expect(hash.length).toBeGreaterThan(0);
      // Base64url should not contain +, /, or =
      expect(hash).not.toMatch(/[+/=]/);
    });

    it('should produce consistent hashes for same token', async () => {
      const token = 'test_token';
      const hash1 = await calculateAccessTokenHash(token);
      const hash2 = await calculateAccessTokenHash(token);

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different tokens', async () => {
      const hash1 = await calculateAccessTokenHash('token1');
      const hash2 = await calculateAccessTokenHash('token2');

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('isDPoPBoundToken', () => {
    it('should return true for DPoP authorization header', () => {
      const authHeader = 'DPoP some_token_here';
      expect(isDPoPBoundToken(authHeader)).toBe(true);
    });

    it('should return true for lowercase dpop', () => {
      const authHeader = 'dpop some_token_here';
      expect(isDPoPBoundToken(authHeader)).toBe(true);
    });

    it('should return false for Bearer authorization header', () => {
      const authHeader = 'Bearer some_token_here';
      expect(isDPoPBoundToken(authHeader)).toBe(false);
    });

    it('should return false for invalid format', () => {
      expect(isDPoPBoundToken('InvalidFormat')).toBe(false);
      expect(isDPoPBoundToken('')).toBe(false);
    });

    it('should handle extra whitespace', () => {
      const authHeader = '  DPoP   some_token_here  ';
      expect(isDPoPBoundToken(authHeader)).toBe(true);
    });
  });

  describe('extractDPoPToken', () => {
    it('should extract token from DPoP authorization header', () => {
      const authHeader = 'DPoP eyJhbGciOiJSUzI1NiJ9.payload.signature';
      const token = extractDPoPToken(authHeader);

      expect(token).toBe('eyJhbGciOiJSUzI1NiJ9.payload.signature');
    });

    it('should return undefined for Bearer header', () => {
      const authHeader = 'Bearer some_token';
      const token = extractDPoPToken(authHeader);

      expect(token).toBeUndefined();
    });

    it('should return undefined for invalid format', () => {
      expect(extractDPoPToken('DPoP')).toBeUndefined();
      expect(extractDPoPToken('InvalidFormat')).toBeUndefined();
      expect(extractDPoPToken('')).toBeUndefined();
    });

    it('should handle multiple spaces', () => {
      const authHeader = 'DPoP    token_with_spaces';
      const token = extractDPoPToken(authHeader);

      expect(token).toBe('token_with_spaces');
    });
  });

  describe('proof validation', () => {
    it('accepts a signed, fresh, request-bound proof and atomically stores its JTI', async () => {
      const store = namespace();
      const result = await validateDPoPProof(
        await proof(),
        'post',
        'https://api.example/token?ignored=query#fragment',
        undefined,
        store as never,
        'client-1',
        'tenant-a'
      );
      expect(result).toMatchObject({ valid: true, jkt: expect.any(String), jwk: { kty: 'EC' } });
      expect(store.idFromName).toHaveBeenCalledWith('client-1');
      expect(store.fetch).toHaveBeenCalledWith(
        'http://internal/check-and-store',
        expect.objectContaining({ method: 'POST' })
      );
      const body = JSON.parse(store.fetch.mock.calls[0][1]!.body as string);
      expect(body).toMatchObject({ jti: 'jti-1', client_id: 'client-1', ttl: 3600 });
    });

    it('validates the access-token hash when an access token is supplied', async () => {
      const token = 'access-token';
      const ath = await calculateAccessTokenHash(token);
      await expect(
        validateDPoPProof(
          await proof({ ath }),
          'POST',
          'https://api.example/token',
          token,
          namespace() as never,
          undefined,
          'tenant-a'
        )
      ).resolves.toMatchObject({ valid: true });
      await expect(
        validateDPoPProof(
          await proof({ ath: 'wrong' }),
          'POST',
          'https://api.example/token',
          token,
          namespace() as never,
          undefined,
          'tenant-a'
        )
      ).resolves.toMatchObject({ valid: false, error_description: expect.stringContaining('ath') });
      await expect(
        validateDPoPProof(
          await proof(),
          'POST',
          'https://api.example/token',
          token,
          namespace() as never,
          undefined,
          'tenant-a'
        )
      ).resolves.toMatchObject({ valid: false, error_description: expect.stringContaining('ath') });
    });

    it.each([
      [{ jti: undefined }, 'jti'],
      [{ jti: 1 }, 'jti'],
      [{ htm: 'GET' }, 'htm'],
      [{ htu: 'https://api.example/other' }, 'htu'],
      [{ iat: undefined }, 'iat'],
      [{ iat: Math.floor(Date.now() / 1000) + 3600 }, 'future'],
      [{ iat: Math.floor(Date.now() / 1000) - 3600 }, 'too old'],
    ])('rejects invalid signed claims %#', async (claims, message) => {
      await expect(
        validateDPoPProof(
          await proof(claims),
          'POST',
          'https://api.example/token',
          undefined,
          namespace() as never,
          undefined,
          'tenant-a'
        )
      ).resolves.toMatchObject({
        valid: false,
        error: 'invalid_dpop_proof',
        error_description: expect.stringContaining(message),
      });
    });

    it('rejects missing tenant and malformed JWT shapes before cryptography', async () => {
      await expect(
        validateDPoPProof(
          'not-a-jwt',
          'POST',
          'https://api.example/token',
          undefined,
          namespace() as never,
          undefined,
          ' '
        )
      ).resolves.toMatchObject({ error_description: expect.stringContaining('tenant') });
      await expect(
        validateDPoPProof(
          'not-a-jwt',
          'POST',
          'https://api.example/token',
          undefined,
          namespace() as never,
          undefined,
          'tenant-a'
        )
      ).resolves.toMatchObject({ error_description: expect.stringContaining('valid JWT') });
      await expect(
        validateDPoPProof(
          '..signature',
          'POST',
          'https://api.example/token',
          undefined,
          namespace() as never,
          undefined,
          'tenant-a'
        )
      ).resolves.toMatchObject({ error_description: expect.stringContaining('valid JWT') });
    });

    it.each([
      [{ typ: 'JWT' }, 'typ header'],
      [{ alg: 'none' }, 'supported signing algorithm'],
      [{ alg: 'HS256' }, 'supported signing algorithm'],
      [{ jwk: undefined }, 'jwk header'],
      [{ jwk: {} }, 'kty'],
      [{ jwk: { kty: 'EC', d: 'private' } }, 'private key material'],
      [{ jwk: { kty: 'EC', crv: 'P-256', x: 'bad', y: 'bad' } }, 'Invalid JWK'],
    ])('rejects unsafe protected header %#', async (header, message) => {
      const encodedHeader = base64url.encode(
        JSON.stringify({ typ: 'dpop+jwt', alg: 'ES256', jwk: publicJwk, ...header })
      );
      const encodedPayload = base64url.encode(JSON.stringify({ jti: 'jti' }));
      await expect(
        validateDPoPProof(
          `${encodedHeader}.${encodedPayload}.signature`,
          'POST',
          'https://api.example/token',
          undefined,
          namespace() as never,
          undefined,
          'tenant-a'
        )
      ).resolves.toMatchObject({ error_description: expect.stringContaining(message) });
    });

    it('rejects a tampered signature without exposing verification details', async () => {
      const signed = await proof();
      const [header, payload, encodedSignature] = signed.split('.');
      const signature = base64url.decode(encodedSignature);
      signature[0] ^= 0x01;
      const tampered = `${header}.${payload}.${base64url.encode(signature)}`;
      await expect(
        validateDPoPProof(
          tampered,
          'POST',
          'https://api.example/token',
          undefined,
          namespace() as never,
          undefined,
          'tenant-a'
        )
      ).resolves.toMatchObject({ error_description: 'DPoP proof signature verification failed' });
    });

    it('maps replay and store failures to OAuth errors', async () => {
      await expect(
        validateDPoPProof(
          await proof(),
          'POST',
          'https://api.example/token',
          undefined,
          namespace(400, { error_description: 'already used' }) as never,
          undefined,
          'tenant-a'
        )
      ).resolves.toMatchObject({
        valid: false,
        error: 'use_dpop_nonce',
        error_description: 'already used',
      });
      await expect(
        validateDPoPProof(
          await proof(),
          'POST',
          'https://api.example/token',
          undefined,
          namespace(400, {}) as never,
          undefined,
          'tenant-a'
        )
      ).resolves.toMatchObject({
        error: 'use_dpop_nonce',
        error_description: expect.stringContaining('replay'),
      });
      await expect(
        validateDPoPProof(
          await proof(),
          'POST',
          'https://api.example/token',
          undefined,
          namespace(500) as never,
          undefined,
          'tenant-a'
        )
      ).resolves.toMatchObject({ error: 'server_error' });
    });

    it('fails closed when replay validation is unavailable or input URL is invalid', async () => {
      await expect(
        validateDPoPProof(
          await proof(),
          'POST',
          'https://api.example/token',
          undefined,
          undefined as never,
          undefined,
          'tenant-a'
        )
      ).resolves.toMatchObject({ error: 'server_error' });
      await expect(
        validateDPoPProof(
          await proof(),
          'POST',
          'not a URL',
          undefined,
          namespace() as never,
          undefined,
          'tenant-a'
        )
      ).resolves.toMatchObject({ error_description: 'DPoP proof validation failed' });
    });
  });

  describe('request enforcement helpers', () => {
    it('extracts proof headers case-insensitively', () => {
      expect(extractDPoPProof(new Headers({ DPoP: 'proof' }))).toBe('proof');
      expect(extractDPoPProof(new Headers())).toBeUndefined();
    });

    it.each([
      ['/token', true],
      ['/oauth/token/', true],
      ['/tenant/oauth/revoke', true],
      ['/PAR', true],
      ['/userinfo', false],
    ])('classifies critical path %s', (path, expected) => {
      expect(isDPoPCriticalPath(path)).toBe(expected);
    });

    it.each([
      ['disabled', '/token', false, false],
      ['critical_only', '/token', false, true],
      ['critical_only', '/userinfo', false, false],
      ['all', '/userinfo', false, true],
      ['unknown', '/token', false, false],
      ['disabled', '/userinfo', true, true],
    ])('resolves DPoP mode %s for %s', (mode, path, legacy, expected) => {
      expect(isDPoPRequiredForRequest(mode as never, path, legacy)).toBe(expected);
    });
  });
});
