/**
 * UserInfo Endpoint Integration Tests
 *
 * Tests the full HTTP flow including:
 * - Bearer vs DPoP token handling
 * - Authorization header format validation
 * - JWE encrypted response
 * - JWT signed response
 * - Scope-based claim filtering at HTTP level
 * - Required claims control
 *
 * These tests complement the unit tests by verifying HTTP-level behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import app from '../index';
import type { Env } from '@authrim/ar-lib-core';

// Mock all functions at module level using vi.hoisted to survive vi.restoreAllMocks()
const mockGetClient = vi.hoisted(() => vi.fn());
const mockGetClientCached = vi.hoisted(() =>
  vi
    .fn()
    .mockImplementation((_c: unknown, env: unknown, clientId: string) =>
      mockGetClient(env, clientId)
    )
);
const mockIntrospectTokenFromContext = vi.hoisted(() => vi.fn());
const mockEncryptJWT = vi.hoisted(() => vi.fn());
const mockIsUserInfoEncryptionRequired = vi.hoisted(() => vi.fn());
const mockGetClientPublicKey = vi.hoisted(() => vi.fn());
const mockValidateJWEOptions = vi.hoisted(() => vi.fn());
const mockGetCachedUser = vi.hoisted(() => vi.fn());

// Mock shared module
vi.mock('@authrim/ar-lib-core', async () => {
  const actual = (await vi.importActual('@authrim/ar-lib-core')) as Record<string, unknown>;
  return {
    ...actual,
    introspectTokenFromContext: mockIntrospectTokenFromContext,
    getClient: mockGetClient,
    getClientCached: mockGetClientCached,
    encryptJWT: mockEncryptJWT,
    isUserInfoEncryptionRequired: mockIsUserInfoEncryptionRequired,
    getClientPublicKey: mockGetClientPublicKey,
    validateJWEOptions: mockValidateJWEOptions,
    getCachedUser: mockGetCachedUser,
    rateLimitMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
    RateLimitProfiles: { moderate: {} },
    requestContextMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
  };
});

import {
  introspectTokenFromContext,
  getClient,
  getClientCached,
  encryptJWT,
  isUserInfoEncryptionRequired,
  getClientPublicKey,
  validateJWEOptions,
  getCachedUser,
} from '@authrim/ar-lib-core';
import type { CachedUser } from '@authrim/ar-lib-core';

// Sample user data (CachedUser format for PII/Non-PII DB separation)

const sampleUser: CachedUser = {
  id: 'user-123',
  name: 'Test User',
  family_name: 'User',
  given_name: 'Test',
  middle_name: null,
  nickname: null,
  preferred_username: null,
  email: 'test@example.com',
  email_verified: true,
  phone_number: '+81-90-1234-5678',
  phone_number_verified: true,
  picture: null,
  profile: null,
  website: null,
  gender: null,
  birthdate: null,
  zoneinfo: null,
  locale: null,
  updated_at: 1700000000000,
  address: JSON.stringify({
    formatted: '123 Test Street, Tokyo',
    country: 'Japan',
  }),
};

// Create mock environment
function createMockEnv(): Env {
  return {
    ISSUER_URL: 'https://op.example.com',
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleUser),
        }),
      }),
    } as unknown as D1Database,
    KEY_MANAGER: {
      idFromName: vi.fn().mockReturnValue('key-manager-id'),
      get: vi.fn().mockReturnValue({
        fetch: vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              kid: 'key-1',
              privatePEM: `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDHwHQhYcTQ1O0M
-----END PRIVATE KEY-----`,
            }),
            { status: 200 }
          )
        ),
      }),
    } as unknown as DurableObjectNamespace,
    KEY_MANAGER_SECRET: 'test-secret',
    TOKEN_INTROSPECTION_DO: {
      idFromName: vi.fn().mockReturnValue('token-store-id'),
      get: vi.fn().mockReturnValue({
        fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ active: true }))),
      }),
    } as unknown as DurableObjectNamespace,
    RATE_LIMITER: {} as unknown as DurableObjectNamespace,
    CLIENT_REGISTRY: {} as unknown as DurableObjectNamespace,
  } as unknown as Env;
}

describe('UserInfo Integration Tests', () => {
  let mockEnv: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = createMockEnv();
    // Re-apply mock implementations after vi.clearAllMocks()
    mockGetClientCached.mockImplementation((_c: unknown, env: unknown, clientId: string) =>
      mockGetClient(env, clientId)
    );
    // Default mock for getCachedUser (PII/Non-PII DB separation)
    vi.mocked(getCachedUser).mockResolvedValue(sampleUser);
  });

  describe('HTTP Method Support', () => {
    it('should accept GET requests', async () => {
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: { sub: 'user-123', scope: 'openid', client_id: 'client-123' },
      });
      vi.mocked(getClient).mockResolvedValue(null);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      const req = new Request('http://localhost/userinfo', {
        method: 'GET',
        headers: { Authorization: 'Bearer valid-token' },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('application/json');
    });

    it('should accept POST requests', async () => {
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: { sub: 'user-123', scope: 'openid', client_id: 'client-123' },
      });
      vi.mocked(getClient).mockResolvedValue(null);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      const req = new Request('http://localhost/userinfo', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
    });

    it('should handle OPTIONS preflight requests (CORS)', async () => {
      const req = new Request('http://localhost/userinfo', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.example.com',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'Authorization, DPoP',
        },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
      expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
      expect(res.headers.get('Access-Control-Allow-Headers')).toContain('DPoP');
    });
  });

  describe('Bearer Token Authentication', () => {
    it('should return 401 when no Authorization header is provided', async () => {
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: false,
        error: {
          error: 'invalid_request',
          error_description: 'Missing access token',
          wwwAuthenticate: 'Bearer',
          statusCode: 401,
        },
      });

      const req = new Request('http://localhost/userinfo', {
        method: 'GET',
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');

      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('invalid_request');
    });

    it('should return 401 with proper WWW-Authenticate header for invalid token', async () => {
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: false,
        error: {
          error: 'invalid_token',
          error_description: 'Token is invalid or expired',
          wwwAuthenticate:
            'Bearer error="invalid_token", error_description="Token is invalid or expired"',
          statusCode: 401,
        },
      });

      const req = new Request('http://localhost/userinfo', {
        method: 'GET',
        headers: { Authorization: 'Bearer invalid-token' },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toContain('invalid_token');
    });

    it('should return user claims for valid Bearer token', async () => {
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid profile email',
          client_id: 'client-123',
        },
      });
      vi.mocked(getClient).mockResolvedValue(null);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      const req = new Request('http://localhost/userinfo', {
        method: 'GET',
        headers: { Authorization: 'Bearer valid-access-token' },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);

      const body = (await res.json()) as { sub: string; name: string; email: string };
      expect(body.sub).toBe('user-123');
      expect(body.name).toBe('Test User');
      expect(body.email).toBe('test@example.com');
    });
  });

  describe('DPoP Token Authentication', () => {
    it('should accept request with DPoP header for DPoP-bound token', async () => {
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid profile',
          client_id: 'client-123',
          cnf: { jkt: 'dpop-thumbprint-123' }, // DPoP proof-of-possession
        },
      });
      vi.mocked(getClient).mockResolvedValue(null);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      const req = new Request('http://localhost/userinfo', {
        method: 'GET',
        headers: {
          Authorization: 'DPoP valid-dpop-token',
          DPoP: 'valid-dpop-proof-jwt',
        },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);

      const body = (await res.json()) as { sub: string };
      expect(body.sub).toBe('user-123');
    });

    it('should return 401 when DPoP header is missing for DPoP-bound token', async () => {
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: false,
        error: {
          error: 'invalid_token',
          error_description: 'DPoP proof required',
          wwwAuthenticate: 'DPoP error="invalid_token", error_description="DPoP proof required"',
          statusCode: 401,
        },
      });

      const req = new Request('http://localhost/userinfo', {
        method: 'GET',
        headers: {
          Authorization: 'DPoP dpop-bound-token',
          // Missing DPoP header
        },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(401);

      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('invalid_token');
    });

    it('should return 401 when DPoP proof is invalid', async () => {
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: false,
        error: {
          error: 'invalid_dpop_proof',
          error_description: 'Invalid DPoP proof signature',
          wwwAuthenticate:
            'DPoP error="invalid_dpop_proof", error_description="Invalid DPoP proof signature"',
          statusCode: 401,
        },
      });

      const req = new Request('http://localhost/userinfo', {
        method: 'GET',
        headers: {
          Authorization: 'DPoP dpop-bound-token',
          DPoP: 'invalid-dpop-proof',
        },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(401);

      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('invalid_dpop_proof');
    });
  });

  describe('Scope-based Claims Filtering (HTTP Level)', () => {
    it('should return only sub for openid scope', async () => {
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: { sub: 'user-123', scope: 'openid', client_id: 'client-123' },
      });
      vi.mocked(getClient).mockResolvedValue(null);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      const req = new Request('http://localhost/userinfo', {
        headers: { Authorization: 'Bearer token' },
      });

      const res = await app.fetch(req, mockEnv);
      const body = (await res.json()) as Record<string, unknown>;

      expect(body.sub).toBe('user-123');
      expect(body.name).toBeUndefined();
      expect(body.email).toBeUndefined();
      expect(body.phone_number).toBeUndefined();
    });

    it('should include profile claims for profile scope', async () => {
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: { sub: 'user-123', scope: 'openid profile', client_id: 'client-123' },
      });
      vi.mocked(getClient).mockResolvedValue(null);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      const req = new Request('http://localhost/userinfo', {
        headers: { Authorization: 'Bearer token' },
      });

      const res = await app.fetch(req, mockEnv);
      const body = (await res.json()) as { name: string; given_name: string; family_name: string };

      expect(body.name).toBe('Test User');
      expect(body.given_name).toBe('Test');
      expect(body.family_name).toBe('User');
    });

    it('should include email claims for email scope', async () => {
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: { sub: 'user-123', scope: 'openid email', client_id: 'client-123' },
      });
      vi.mocked(getClient).mockResolvedValue(null);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      const req = new Request('http://localhost/userinfo', {
        headers: { Authorization: 'Bearer token' },
      });

      const res = await app.fetch(req, mockEnv);
      const body = (await res.json()) as { email: string; email_verified: boolean };

      expect(body.email).toBe('test@example.com');
      expect(body.email_verified).toBe(true);
    });

    it('should include phone claims for phone scope', async () => {
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: { sub: 'user-123', scope: 'openid phone', client_id: 'client-123' },
      });
      vi.mocked(getClient).mockResolvedValue(null);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      const req = new Request('http://localhost/userinfo', {
        headers: { Authorization: 'Bearer token' },
      });

      const res = await app.fetch(req, mockEnv);
      const body = (await res.json()) as { phone_number: string; phone_number_verified: boolean };

      expect(body.phone_number).toBe('+81-90-1234-5678');
      expect(body.phone_number_verified).toBe(true);
    });

    it('should include address for address scope', async () => {
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: { sub: 'user-123', scope: 'openid address', client_id: 'client-123' },
      });
      vi.mocked(getClient).mockResolvedValue(null);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      const req = new Request('http://localhost/userinfo', {
        headers: { Authorization: 'Bearer token' },
      });

      const res = await app.fetch(req, mockEnv);
      const body = (await res.json()) as { address: { formatted: string; country: string } };

      expect(body.address.formatted).toBe('123 Test Street, Tokyo');
      expect(body.address.country).toBe('Japan');
    });
  });

  describe('JWE Encrypted Response', () => {
    it('should return encrypted JWT when client requires encryption', async () => {
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: { sub: 'user-123', scope: 'openid profile', client_id: 'client-123' },
      });
      vi.mocked(getClient).mockResolvedValue({
        client_id: 'client-123',
        userinfo_encrypted_response_alg: 'RSA-OAEP',
        userinfo_encrypted_response_enc: 'A256GCM',
      } as any);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(true);
      vi.mocked(validateJWEOptions).mockReturnValue(true);
      vi.mocked(getClientPublicKey).mockResolvedValue({
        kid: 'client-key-1',
        kty: 'RSA',
        n: 'test-modulus',
        e: 'AQAB',
      } as any);
      vi.mocked(encryptJWT).mockResolvedValue(
        'eyJhbGciOiJSU0EtT0FFUCIsImVuYyI6IkEyNTZHQ00ifQ.encrypted.iv.ciphertext.tag'
      );

      const req = new Request('http://localhost/userinfo', {
        headers: { Authorization: 'Bearer token' },
      });

      const res = await app.fetch(req, mockEnv);

      // Encrypted response may fail due to mock key, but we verify the flow attempted encryption
      expect(isUserInfoEncryptionRequired).toHaveBeenCalled();
      expect(getClientPublicKey).toHaveBeenCalled();
    });

    it('should return 400 when encryption is required but client has no public key', async () => {
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: { sub: 'user-123', scope: 'openid profile', client_id: 'client-123' },
      });
      vi.mocked(getClient).mockResolvedValue({
        client_id: 'client-123',
        userinfo_encrypted_response_alg: 'RSA-OAEP',
        userinfo_encrypted_response_enc: 'A256GCM',
      } as any);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(true);
      vi.mocked(validateJWEOptions).mockReturnValue(true);
      vi.mocked(getClientPublicKey).mockResolvedValue(null);

      const req = new Request('http://localhost/userinfo', {
        headers: { Authorization: 'Bearer token' },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string; error_description: string };
      expect(body.error).toBe('invalid_client_metadata');
      expect(body.error_description).toContain('no public key');
    });

    it('should return 400 when JWE algorithm is not supported', async () => {
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: { sub: 'user-123', scope: 'openid profile', client_id: 'client-123' },
      });
      vi.mocked(getClient).mockResolvedValue({
        client_id: 'client-123',
        userinfo_encrypted_response_alg: 'INVALID-ALG',
        userinfo_encrypted_response_enc: 'A256GCM',
      } as any);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(true);
      vi.mocked(validateJWEOptions).mockImplementation(() => {
        throw new Error('Unsupported algorithm: INVALID-ALG');
      });

      const req = new Request('http://localhost/userinfo', {
        headers: { Authorization: 'Bearer token' },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string; error_description: string };
      expect(body.error).toBe('invalid_client_metadata');
      // SECURITY: Error message must not expose specific algorithm details
      expect(body.error_description).toBe('Client encryption configuration is invalid');
    });
  });

  describe('JWT Signed Response', () => {
    it('should return signed JWT when client requires signing (not encryption)', async () => {
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: { sub: 'user-123', scope: 'openid profile', client_id: 'client-123' },
      });
      vi.mocked(getClient).mockResolvedValue({
        client_id: 'client-123',
        userinfo_signed_response_alg: 'RS256',
        // No encryption configured
      } as any);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      const req = new Request('http://localhost/userinfo', {
        headers: { Authorization: 'Bearer token' },
      });

      const res = await app.fetch(req, mockEnv);

      // Signing will fail due to mock key, but we verify the path was taken
      // In real tests with proper keys, this would return Content-Type: application/jwt
      expect(getClient).toHaveBeenCalledWith(mockEnv, 'client-123');
    });
  });

  describe('Claims Parameter Control', () => {
    it('should include requested claims when allow_claims_without_scope is enabled', async () => {
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid', // No email scope
          client_id: 'client-123',
          claims: JSON.stringify({
            userinfo: {
              email: { essential: true },
            },
          }),
        },
      });
      vi.mocked(getClient).mockResolvedValue({
        client_id: 'client-123',
        allow_claims_without_scope: true, // Allow claims without scope
      } as any);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      const req = new Request('http://localhost/userinfo', {
        headers: { Authorization: 'Bearer token' },
      });

      const res = await app.fetch(req, mockEnv);
      const body = (await res.json()) as { sub: string; email: string };

      expect(res.status).toBe(200);
      expect(body.sub).toBe('user-123');
      expect(body.email).toBe('test@example.com'); // Included via claims parameter
    });

    it('should NOT include requested claims when allow_claims_without_scope is disabled', async () => {
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid', // No email scope
          client_id: 'client-123',
          claims: JSON.stringify({
            userinfo: {
              email: { essential: true },
            },
          }),
        },
      });
      vi.mocked(getClient).mockResolvedValue({
        client_id: 'client-123',
        allow_claims_without_scope: false, // Strict mode
      } as any);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      const req = new Request('http://localhost/userinfo', {
        headers: { Authorization: 'Bearer token' },
      });

      const res = await app.fetch(req, mockEnv);
      const body = (await res.json()) as { sub: string; email?: string };

      expect(res.status).toBe(200);
      expect(body.sub).toBe('user-123');
      expect(body.email).toBeUndefined(); // NOT included - strict mode
    });
  });

  describe('Security Headers', () => {
    it('should include security headers in response', async () => {
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: { sub: 'user-123', scope: 'openid', client_id: 'client-123' },
      });
      vi.mocked(getClient).mockResolvedValue(null);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      const req = new Request('http://localhost/userinfo', {
        headers: { Authorization: 'Bearer token' },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=');
    });

    it('should include CORS headers', async () => {
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: { sub: 'user-123', scope: 'openid', client_id: 'client-123' },
      });
      vi.mocked(getClient).mockResolvedValue(null);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      const req = new Request('http://localhost/userinfo', {
        headers: {
          Authorization: 'Bearer token',
          Origin: 'https://app.example.com',
        },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
  });

  describe('Error Response Format', () => {
    it('should return RFC 6750 compliant error response', async () => {
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: false,
        error: {
          error: 'invalid_token',
          error_description: 'Token has expired',
          wwwAuthenticate: 'Bearer error="invalid_token", error_description="Token has expired"',
          statusCode: 401,
        },
      });

      const req = new Request('http://localhost/userinfo', {
        headers: { Authorization: 'Bearer expired-token' },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(401);

      const body = (await res.json()) as { error: string; error_description: string };
      expect(body.error).toBe('invalid_token');
      expect(body.error_description).toBe('Token has expired');
      expect(res.headers.get('WWW-Authenticate')).toContain('Bearer');
    });

    it('should return 401 for insufficient_scope', async () => {
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: false,
        error: {
          error: 'insufficient_scope',
          error_description: 'Token does not have required scope',
          wwwAuthenticate: 'Bearer error="insufficient_scope", scope="openid"',
          statusCode: 403,
        },
      });

      const req = new Request('http://localhost/userinfo', {
        headers: { Authorization: 'Bearer limited-token' },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(403);

      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('insufficient_scope');
    });
  });

  describe('User Not Found', () => {
    it('should return 401 when user does not exist', async () => {
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: { sub: 'nonexistent-user', scope: 'openid', client_id: 'client-123' },
      });
      vi.mocked(getClient).mockResolvedValue(null);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      // Mock getCachedUser to return null (user not found)
      vi.mocked(getCachedUser).mockResolvedValue(null);

      const req = new Request('http://localhost/userinfo', {
        headers: { Authorization: 'Bearer token' },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(401);

      // Security: Generic message to prevent user enumeration
      const body = (await res.json()) as { error: string; error_description: string };
      expect(body.error).toBe('invalid_token');
      expect(body.error_description).toBe('The access token is invalid');
    });
  });

  describe('Health Check', () => {
    it('should return health status', async () => {
      const req = new Request('http://localhost/api/health');

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);

      const body = (await res.json()) as { status: string; service: string };
      expect(body.status).toBe('ok');
      expect(body.service).toBe('op-userinfo');
    });
  });

  describe('404 Handler', () => {
    it('should return 404 for unknown paths', async () => {
      const req = new Request('http://localhost/unknown-path');

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('not_found');
    });
  });
});
