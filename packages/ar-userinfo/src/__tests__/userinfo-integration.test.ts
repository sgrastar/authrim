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
import { generateKeyPairSync } from 'node:crypto';
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
const mockCanonicalFindByLegacyUserId = vi.hoisted(() => vi.fn());
const mockCanonicalRuntimeUserProjectionRepository = vi.hoisted(() =>
  vi.fn().mockImplementation(function () {
    return {
      findByLegacyUserId: mockCanonicalFindByLegacyUserId,
    };
  })
);
const mockCanonicalSensitiveValueResolver = vi.hoisted(() => vi.fn());
const mockResolveAccountDataContextFromHono = vi.hoisted(() => vi.fn());
const { privateKey: testSigningPrivateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

// Mock shared module
vi.mock('@authrim/ar-lib-core', async () => {
  const actual = (await vi.importActual('@authrim/ar-lib-core')) as Record<string, unknown>;
  const oidcClaims = (await vi.importActual('@authrim/ar-lib-core/utils/oidc-claims')) as Record<
    string,
    unknown
  >;
  return {
    ...actual,
    ...oidcClaims,
    introspectTokenFromContext: mockIntrospectTokenFromContext,
    getClient: mockGetClient,
    getClientCached: mockGetClientCached,
    encryptJWT: mockEncryptJWT,
    isUserInfoEncryptionRequired: mockIsUserInfoEncryptionRequired,
    getClientPublicKey: mockGetClientPublicKey,
    validateJWEOptions: mockValidateJWEOptions,
    getCachedUser: mockGetCachedUser,
    CanonicalRuntimeUserProjectionRepository: mockCanonicalRuntimeUserProjectionRepository,
    CanonicalSensitiveValueResolver: mockCanonicalSensitiveValueResolver,
    resolveAccountDataContextFromHono: mockResolveAccountDataContextFromHono,
    rateLimitMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
    RateLimitProfiles: { moderate: {} },
    requestContextMiddleware:
      () =>
      async (
        c: { env?: Env; set?: (key: string, value: unknown) => void },
        next: () => Promise<void>
      ) => {
        c.set?.('tenantId', 'tenant-a');
        c.set?.('tenantMetadataContext', {
          tenantId: 'tenant-a',
          coreDb: c.env?.DB,
        });
        await next();
      },
    pluginContextMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
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
  birthdate: '1990-01-01',
  zoneinfo: null,
  locale: null,
  updated_at: 1700000000000,
  address: JSON.stringify({
    formatted: '123 Test Street, Tokyo',
    country: 'Japan',
  }),
};

function sampleCanonicalProjection(overrides: Record<string, unknown> = {}) {
  return {
    id: sampleUser.id,
    tenant_id: 'tenant-a',
    subject_id: `subject:${sampleUser.id}`,
    account_id: `account:${sampleUser.id}`,
    email: sampleUser.email,
    email_verified: 1,
    name: sampleUser.name,
    given_name: sampleUser.given_name,
    family_name: sampleUser.family_name,
    middle_name: sampleUser.middle_name,
    nickname: sampleUser.nickname,
    preferred_username: sampleUser.preferred_username,
    profile: sampleUser.profile,
    picture: sampleUser.picture,
    website: sampleUser.website,
    gender: sampleUser.gender,
    birthdate: sampleUser.birthdate,
    zoneinfo: sampleUser.zoneinfo,
    locale: sampleUser.locale,
    phone_number: sampleUser.phone_number,
    phone_number_verified: 1,
    address_json: sampleUser.address,
    password_hash: null,
    external_id: null,
    active: 1,
    custom_attributes_json: null,
    created_at: new Date(1_700_000_000_000).toISOString(),
    updated_at: new Date(sampleUser.updated_at).toISOString(),
    ...overrides,
  };
}

// Create mock environment
function createMockEnv(): Env {
  return {
    ISSUER_URL: 'https://op.example.com',
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleUser),
          all: vi.fn().mockResolvedValue({ results: [] }),
          run: vi.fn().mockResolvedValue({ success: true }),
        }),
      }),
    } as unknown as D1Database,
    KEY_MANAGER: {
      idFromName: vi.fn().mockReturnValue('key-manager-id'),
      get: vi.fn().mockReturnValue({
        getActiveKeyWithPrivateRpc: vi.fn().mockResolvedValue({
          kid: 'key-1',
          privatePEM: testSigningPrivateKey,
        }),
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
    mockCanonicalFindByLegacyUserId.mockResolvedValue(sampleCanonicalProjection());
    mockResolveAccountDataContextFromHono.mockImplementation(
      async (c: { env: Env; set: (key: string, value: unknown) => void }, accountId: string) => {
        const accountContext = {
          tenantId: 'tenant-a',
          accountId,
          legacyUserId: accountId,
          coreDb: c.env.DB,
          piiDb: c.env.DB,
          userCacheScope: {
            routeGeneration: 1,
            coreBindingGeneration: 1,
            piiBindingGeneration: 1,
            coreSchemaGeneration: 1,
            piiSchemaGeneration: 1,
          },
          piiCacheMode: 'no_cross_request_pii',
        };
        c.set('accountDataContext', accountContext);
        return accountContext;
      }
    );
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

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('application/jwt');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(await res.text()).toBe(
        'eyJhbGciOiJSU0EtT0FFUCIsImVuYyI6IkEyNTZHQ00ifQ.encrypted.iv.ciphertext.tag'
      );
      expect(isUserInfoEncryptionRequired).toHaveBeenCalled();
      expect(getClientPublicKey).toHaveBeenCalled();
      expect(encryptJWT).toHaveBeenCalledWith(
        expect.stringMatching(/^[^.]+\.[^.]+\.[^.]+$/),
        expect.objectContaining({ kid: 'client-key-1' }),
        {
          alg: 'RSA-OAEP',
          enc: 'A256GCM',
          cty: 'JWT',
          kid: 'client-key-1',
        }
      );
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

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('application/jwt');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect((await res.text()).split('.')).toHaveLength(3);
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

    it('should include requested claims using claim-level policy without corresponding scope', async () => {
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid',
          client_id: 'client-123',
          claims: JSON.stringify({
            userinfo: {
              email: null,
            },
          }),
        },
      });
      vi.mocked(getClient).mockResolvedValue({
        client_id: 'client-123',
        claims_parameter_policy: { email: 'claims_allowed' },
      } as any);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      const req = new Request('http://localhost/userinfo', {
        headers: { Authorization: 'Bearer token' },
      });

      const res = await app.fetch(req, mockEnv);
      const body = (await res.json()) as { email?: string };

      expect(res.status).toBe(200);
      expect(body.email).toBe('test@example.com');
    });

    it('should apply protected ASC predefined transformed claims and SAO omit', async () => {
      vi.mocked(getCachedUser).mockResolvedValue({
        ...sampleUser,
        birthdate: '2000-01-01',
        address: JSON.stringify({ country: 'JP' }),
      });
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid',
          client_id: 'client-123',
          claims_request_protected: true,
          claims: JSON.stringify({
            userinfo: {
              '::age_over_18': { value: true },
              address: null,
            },
            _asc: {
              sao: {
                userinfo: [
                  {
                    loc: '/address/postal_code',
                    method: 'exists',
                    else: 'omit',
                    what: ['/address'],
                  },
                ],
              },
            },
          }),
        },
      });
      vi.mocked(getClient).mockResolvedValue({
        client_id: 'client-123',
        claims_parameter_policy: {
          birthdate: 'claims_allowed',
          address: 'claims_allowed',
          '::age_over_18': 'claims_allowed',
        },
      } as any);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      const req = new Request('http://localhost/userinfo', {
        headers: { Authorization: 'Bearer token' },
      });

      const res = await app.fetch(req, mockEnv);
      const body = (await res.json()) as { '::age_over_18'?: boolean; address?: unknown };

      expect(res.status).toBe(200);
      expect(body['::age_over_18']).toBe(true);
      expect(body.address).toBeUndefined();
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
      expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
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

      mockCanonicalFindByLegacyUserId.mockResolvedValue(null);

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
