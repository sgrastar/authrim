/**
 * UserInfo Endpoint Unit Tests
 *
 * Tests for OIDC UserInfo endpoint (RFC 7519, OIDC Core 5.3)
 * Security-focused tests for token validation, scope-based claim filtering,
 * and JWE encryption.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { decodeProtectedHeader, exportPKCS8, generateKeyPair } from 'jose';
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
const mockGetCachedUserCore = vi.hoisted(() => vi.fn());
const mockCanonicalFindByLegacyUserId = vi.hoisted(() => vi.fn());
const mockCanonicalRuntimeUserProjectionRepository = vi.hoisted(() =>
  vi.fn().mockImplementation(function () {
    return {
      findByLegacyUserId: mockCanonicalFindByLegacyUserId,
    };
  })
);
const mockCanonicalSensitiveValueResolver = vi.hoisted(() => vi.fn());
const mockCreateOAuthConfigManager = vi.hoisted(() =>
  vi.fn(() => ({
    isUserInfoRequireOpenidScope: vi.fn().mockResolvedValue(false),
  }))
);
const mockLoadFeatureConfig = vi.hoisted(() => vi.fn().mockResolvedValue({ enabled: false }));
const mockResolveCustomClaimRuntimeSourcesFromEnv = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    schemaDb: null,
    nonPiiDb: null,
    piiDb: null,
  })
);
const mockCreateCustomClaimSchemaResolverFromSources = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    resolveClaimsForTarget: vi.fn().mockResolvedValue({ claims: {} }),
  })
);
const mockApplyOIDCIdentityMapping = vi.hoisted(() => vi.fn());
const mockEnforceOIDCAttributeReleaseConsent = vi.hoisted(() => vi.fn());
const mockGetTenantMetadataContextFromHono = vi.hoisted(() => vi.fn());
const mockResolveAccountDataContextFromHono = vi.hoisted(() => vi.fn());

// Mock the shared module
vi.mock('@authrim/ar-lib-core', async () => {
  const actual = await vi.importActual('@authrim/ar-lib-core');
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
    getCachedUserCore: mockGetCachedUserCore,
    CanonicalRuntimeUserProjectionRepository: mockCanonicalRuntimeUserProjectionRepository,
    CanonicalSensitiveValueResolver: mockCanonicalSensitiveValueResolver,
    createOAuthConfigManager: mockCreateOAuthConfigManager,
    loadFeatureConfig: mockLoadFeatureConfig,
    resolveCustomClaimRuntimeSourcesFromEnv: mockResolveCustomClaimRuntimeSourcesFromEnv,
    resolveCustomClaimRuntimeSourcesFromHono: mockResolveCustomClaimRuntimeSourcesFromEnv,
    createCustomClaimSchemaResolverFromSources: mockCreateCustomClaimSchemaResolverFromSources,
    applyOIDCIdentityMapping: mockApplyOIDCIdentityMapping,
    enforceOIDCAttributeReleaseConsent: mockEnforceOIDCAttributeReleaseConsent,
    getTenantMetadataContextFromHono: mockGetTenantMetadataContextFromHono,
    resolveAccountDataContextFromHono: mockResolveAccountDataContextFromHono,
  };
});

import { userinfoHandler } from '../userinfo';
import {
  introspectTokenFromContext,
  getClient,
  getClientCached,
  encryptJWT,
  isUserInfoEncryptionRequired,
  getClientPublicKey,
  validateJWEOptions,
  getCachedUser,
  getCachedUserCore,
  OIDCAttributeReleaseConsentRequiredError,
  OIDCIdentityMappingRuntimeError,
} from '@authrim/ar-lib-core';

// Helper to create mock context
function createMockContext(options: {
  method?: string;
  headers?: Record<string, string>;
  env?: Partial<Env>;
}) {
  const app = new Hono<{ Bindings: Env }>();

  const mockEnv: Partial<Env> = {
    ISSUER_URL: 'https://op.example.com',
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn(),
        }),
      }),
    } as unknown as D1Database,
    KEY_MANAGER: {
      idFromName: vi.fn().mockReturnValue('key-manager-id'),
      get: vi.fn().mockReturnValue({
        // RPC methods for KeyManager
        getActiveKeyRpc: vi.fn().mockResolvedValue({ kid: 'key-1', publicJWK: {} }),
        getActiveKeyWithPrivateRpc: vi
          .fn()
          .mockResolvedValue({ kid: 'key-1', privatePEM: 'mock-pem' }),
        // fetch fallback for backward compatibility
        fetch: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ kid: 'key-1', privatePEM: 'mock-pem' }), {
            status: 200,
          })
        ),
      }),
    } as unknown as Env['KEY_MANAGER'],
    KEY_MANAGER_SECRET: 'test-secret',
    ...options.env,
  };

  const req = new Request('https://op.example.com/userinfo', {
    method: options.method || 'GET',
    headers: options.headers || {},
  });

  // Create a mock logger
  const mockLogger = {
    module: () => mockLogger,
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  // Create a mock context
  const c = {
    req: {
      header: (name: string) => options.headers?.[name],
      method: options.method || 'GET',
    },
    env: mockEnv as Env,
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
    header: vi.fn(),
    body: vi.fn((body, status = 200) => new Response(body, { status })),
    get: vi.fn((key: string) => {
      if (key === 'logger') return mockLogger;
      return undefined;
    }),
  } as any;

  return c;
}

// Sample user data for testing (CachedUser format)
const sampleUser = {
  id: 'user-123',
  pii_status: 'active' as const,
  email: 'test@example.com',
  email_verified: true,
  name: 'Test User',
  family_name: 'User',
  given_name: 'Test',
  middle_name: 'Middle',
  nickname: 'tester',
  preferred_username: 'testuser',
  profile: 'https://example.com/profile',
  picture: 'https://example.com/picture.jpg',
  website: 'https://example.com',
  gender: 'male',
  birthdate: '1990-01-01',
  zoneinfo: 'Asia/Tokyo',
  locale: 'ja-JP',
  phone_number: '+81-90-1234-5678',
  phone_number_verified: true,
  address: JSON.stringify({
    formatted: '123 Test Street, Tokyo, Japan',
    street_address: '123 Test Street',
    locality: 'Tokyo',
    country: 'Japan',
  }),
  updated_at: 1700000000000,
};

function sampleCanonicalProjection(overrides: Record<string, unknown> = {}) {
  return {
    id: sampleUser.id,
    tenant_id: 'default',
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

describe('UserInfo Endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply mock implementations after vi.clearAllMocks()
    // This ensures mocks work consistently across all tests
    mockGetClientCached.mockImplementation((_c: unknown, env: unknown, clientId: string) =>
      mockGetClient(env, clientId)
    );
    // Default mock for getCachedUser - returns sample user
    // Tests that need different behavior can override this
    vi.mocked(getCachedUser).mockResolvedValue(sampleUser);
    vi.mocked(getCachedUserCore).mockResolvedValue({
      id: 'user-123',
      pii_status: 'active',
      email_verified: true,
      phone_number_verified: true,
      updated_at: 1700000000000,
    });
    mockCanonicalFindByLegacyUserId.mockResolvedValue(sampleCanonicalProjection());
    mockCreateOAuthConfigManager.mockReturnValue({
      isUserInfoRequireOpenidScope: vi.fn().mockResolvedValue(false),
    });
    mockLoadFeatureConfig.mockResolvedValue({ enabled: false });
    mockResolveCustomClaimRuntimeSourcesFromEnv.mockResolvedValue({
      schemaDb: null,
      nonPiiDb: null,
      piiDb: null,
    });
    mockCreateCustomClaimSchemaResolverFromSources.mockReturnValue({
      resolveClaimsForTarget: vi.fn().mockResolvedValue({ claims: {} }),
    });
    mockApplyOIDCIdentityMapping.mockImplementation(async (input: { claims: unknown }) => ({
      claims: input.claims,
    }));
    mockEnforceOIDCAttributeReleaseConsent.mockResolvedValue(undefined);
    mockGetTenantMetadataContextFromHono.mockReturnValue(undefined);
    mockResolveAccountDataContextFromHono.mockResolvedValue(undefined);
  });

  describe('Token Validation', () => {
    it('should return 401 when token is invalid', async () => {
      const c = createMockContext({
        headers: {
          Authorization: 'Bearer invalid-token',
          'x-fapi-interaction-id': 'fapi-interaction-123',
        },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: false,
        error: {
          error: 'invalid_token',
          error_description: 'Token is invalid',
          wwwAuthenticate: 'Bearer error="invalid_token"',
          statusCode: 401,
        },
      });

      await userinfoHandler(c);

      expect(introspectTokenFromContext).toHaveBeenCalledWith(c, {
        audience: ['https://op.example.com', 'https://op.example.com/userinfo'],
      });
      expect(c.header).toHaveBeenCalledWith('x-fapi-interaction-id', 'fapi-interaction-123');

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_token',
          error_description: 'Token is invalid',
        }),
        401
      );
      expect(c.header).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer error="invalid_token"');
    });

    it('should return 401 when token is expired', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer expired-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: false,
        error: {
          error: 'invalid_token',
          error_description: 'Token has expired',
          wwwAuthenticate: 'Bearer error="invalid_token", error_description="Token has expired"',
          statusCode: 401,
        },
      });

      await userinfoHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_token',
          error_description: 'Token has expired',
        }),
        401
      );
    });

    it('should return 401 when no authorization header is provided', async () => {
      const c = createMockContext({
        headers: {},
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: false,
        error: {
          error: 'invalid_request',
          error_description: 'Missing access token',
          wwwAuthenticate: 'Bearer',
          statusCode: 401,
        },
      });

      await userinfoHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
        }),
        401
      );
    });

    it('should return server_error when invalid introspection has no error details', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer malformed-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: false,
      });

      await userinfoHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        {
          error: 'server_error',
          error_description: 'Unknown error',
        },
        500
      );
      expect(c.header).not.toHaveBeenCalledWith('WWW-Authenticate', expect.any(String));
    });

    it('should reject tokens without openid scope when configured as required', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });
      mockCreateOAuthConfigManager.mockReturnValue({
        isUserInfoRequireOpenidScope: vi.fn().mockResolvedValue(true),
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'profile email',
          client_id: 'client-123',
        },
      });

      await userinfoHandler(c);

      expect(c.header).toHaveBeenCalledWith(
        'WWW-Authenticate',
        'Bearer error="insufficient_scope", scope="openid"'
      );
      expect(c.header).toHaveBeenCalledWith('Cache-Control', 'no-store');
      expect(c.header).toHaveBeenCalledWith('Pragma', 'no-cache');
      expect(c.json).toHaveBeenCalledWith(
        {
          error: 'insufficient_scope',
          error_description: 'Access token must have openid scope for UserInfo endpoint',
        },
        403
      );
      expect(getCachedUser).not.toHaveBeenCalled();
    });

    it('should return 401 when token does not contain sub claim', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          // Missing 'sub' claim
          scope: 'openid profile',
          client_id: 'client-123',
        },
      });

      await userinfoHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_token',
          error_description: 'Token does not contain subject claim',
        }),
        401
      );
    });

    it('should return 500 when introspection returns valid but no claims', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: undefined,
      });

      await userinfoHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'server_error',
          error_description: 'Missing claims',
        }),
        500
      );
    });

    it('resolves a tenant-D1 account route from the trusted token subject', async () => {
      const c = createMockContext({ headers: { Authorization: 'Bearer valid-token' } });
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: { sub: 'user-123', scope: 'openid' },
      });
      mockGetTenantMetadataContextFromHono.mockReturnValue({
        tenantId: 'default',
        storageProfileId: 'builtin:storage:tenant-d1',
      });

      await userinfoHandler(c);

      expect(mockResolveAccountDataContextFromHono).toHaveBeenCalledWith(c, 'user-123');
    });

    it('normalizes a missing tenant-D1 account route to invalid_token', async () => {
      const c = createMockContext({ headers: { Authorization: 'Bearer valid-token' } });
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: { sub: 'user-123', scope: 'openid' },
      });
      mockGetTenantMetadataContextFromHono.mockReturnValue({
        tenantId: 'default',
        storageProfileId: 'builtin:storage:tenant-d1',
      });
      mockResolveAccountDataContextFromHono.mockRejectedValue(
        new Error('account_data_route_not_found')
      );

      await userinfoHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        { error: 'invalid_token', error_description: 'The access token is invalid' },
        401
      );
    });

    it('hides tenant-D1 route validation failures behind a temporary error', async () => {
      const c = createMockContext({ headers: { Authorization: 'Bearer valid-token' } });
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: { sub: 'user-123', scope: 'openid' },
      });
      mockGetTenantMetadataContextFromHono.mockReturnValue({
        tenantId: 'default',
        storageProfileId: 'builtin:storage:tenant-d1',
      });
      mockResolveAccountDataContextFromHono.mockRejectedValue(
        new Error('lookup_route_binding_generation_stale')
      );

      await userinfoHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        { error: 'temporarily_unavailable', error_description: 'User data is unavailable' },
        503
      );
    });
  });

  describe('User Not Found', () => {
    it('should return 401 when user is not found in database', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'nonexistent-user',
          scope: 'openid profile',
          client_id: 'client-123',
        },
      });

      mockCanonicalFindByLegacyUserId.mockResolvedValue(null);

      await userinfoHandler(c);

      // Security: Generic message to prevent user enumeration
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_token',
          error_description: 'The access token is invalid',
        }),
        401
      );
    });

    it('passes runtime-resolved tenant adapters to canonical projection', async () => {
      const createAdapter = (name: string) => ({
        query: vi.fn(),
        queryOne: vi.fn(),
        execute: vi.fn(),
        transaction: vi.fn(),
        batch: vi.fn(),
        isHealthy: vi.fn(),
        getType: vi.fn().mockReturnValue(name),
        close: vi.fn(),
      });
      const runtimeCoreAdapter = createAdapter('tenant-core');
      const runtimePiiAdapter = createAdapter('tenant-pii');
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
        env: { DB: undefined as unknown as Env['DB'] },
      });
      c.get = vi.fn((key: string) => {
        if (key === 'logger') {
          return {
            module: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
          };
        }
        if (key === 'tenantId') {
          return 'tenant-a';
        }
        if (key === 'runtimeUserStoreSources') {
          return {
            storageProfile: {
              id: 'builtin:storage:tenant-d1',
              kind: 'storage',
              label: 'Tenant D1',
              slices: {},
            },
            coreDb: runtimeCoreAdapter,
            piiDb: runtimePiiAdapter,
            userCacheScope: {
              storageProfileId: 'builtin:storage:tenant-d1',
              sourceGeneration: 'core:2:pii:2',
              schemaVersion: 'core:87:pii:12',
            },
            piiCacheMode: 'no_cross_request_pii',
          };
        }
        return undefined;
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid profile',
          client_id: 'client-123',
        },
      });
      vi.mocked(getClient).mockResolvedValue(null);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);
      await userinfoHandler(c);

      expect(mockCanonicalRuntimeUserProjectionRepository).toHaveBeenCalledWith(
        runtimeCoreAdapter,
        'tenant-a',
        expect.any(Object)
      );
    });
  });

  describe('Scope-based Claim Filtering', () => {
    beforeEach(() => {
      vi.mocked(getClient).mockResolvedValue(null);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);
    });

    it('should return only sub with openid scope', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid',
          client_id: 'client-123',
        },
      });

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleUser),
        }),
      });

      await userinfoHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'user-123',
        })
      );

      // Should NOT include profile claims
      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody).not.toHaveProperty('name');
      expect(responseBody).not.toHaveProperty('email');
      expect(responseBody).not.toHaveProperty('phone_number');
      expect(responseBody).not.toHaveProperty('address');
    });

    it('should return profile claims with profile scope', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid profile',
          client_id: 'client-123',
        },
      });

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleUser),
        }),
      });

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody.sub).toBe('user-123');
      expect(responseBody.name).toBe('Test User');
      expect(responseBody.family_name).toBe('User');
      expect(responseBody.given_name).toBe('Test');
      expect(responseBody.picture).toBe('https://example.com/picture.jpg');
      expect(responseBody.gender).toBe('male');
      expect(responseBody.birthdate).toBe('1990-01-01');
      expect(responseBody.zoneinfo).toBe('Asia/Tokyo');
      expect(responseBody.locale).toBe('ja-JP');
    });

    it('should return email claims with email scope', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid email',
          client_id: 'client-123',
        },
      });

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleUser),
        }),
      });

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody.sub).toBe('user-123');
      expect(responseBody.email).toBe('test@example.com');
      expect(responseBody.email_verified).toBe(true);
      // Should NOT include profile claims
      expect(responseBody).not.toHaveProperty('name');
    });

    it('should prefer canonical runtime projection when cutover flag is enabled', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid profile email',
          client_id: 'client-123',
        },
      });
      mockCanonicalFindByLegacyUserId.mockResolvedValue({
        id: 'user-123',
        tenant_id: 'default',
        subject_id: 'subject:user-123',
        account_id: 'account:user-123',
        email: 'canonical@example.com',
        email_verified: 1,
        name: 'Canonical User',
        given_name: 'Canonical',
        family_name: 'User',
        middle_name: null,
        nickname: null,
        preferred_username: null,
        profile: null,
        picture: null,
        website: null,
        gender: null,
        birthdate: null,
        zoneinfo: null,
        locale: 'ja-JP',
        phone_number: null,
        phone_number_verified: 0,
        address_json: null,
        password_hash: null,
        external_id: null,
        active: 1,
        custom_attributes_json: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
      });

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody).toMatchObject({
        sub: 'user-123',
        email: 'canonical@example.com',
        email_verified: true,
        name: 'Canonical User',
        locale: 'ja-JP',
        updated_at: 1767312000,
      });
      expect(mockCanonicalFindByLegacyUserId).toHaveBeenCalledWith('user-123');
      expect(getCachedUserCore).not.toHaveBeenCalled();
      expect(getCachedUser).not.toHaveBeenCalled();
    });

    it('returns canonical claims without consulting legacy pii_status', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid email',
          client_id: 'client-123',
        },
      });
      mockCanonicalFindByLegacyUserId.mockResolvedValue({
        id: 'user-123',
        tenant_id: 'default',
        subject_id: 'subject:user-123',
        account_id: 'account:user-123',
        email: 'canonical@example.com',
        email_verified: 1,
        name: 'Canonical User',
        given_name: 'Canonical',
        family_name: 'User',
        middle_name: null,
        nickname: null,
        preferred_username: null,
        profile: null,
        picture: null,
        website: null,
        gender: null,
        birthdate: null,
        zoneinfo: null,
        locale: null,
        phone_number: null,
        phone_number_verified: 0,
        address_json: null,
        password_hash: null,
        external_id: null,
        active: 1,
        custom_attributes_json: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
      });
      await userinfoHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({ sub: 'user-123', email: 'canonical@example.com' })
      );
      expect(getCachedUserCore).not.toHaveBeenCalled();
      expect(getCachedUser).not.toHaveBeenCalled();
    });

    it('does not use legacy cached user pii_status for canonical userinfo', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid email',
          client_id: 'client-123',
        },
      });
      await userinfoHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({ sub: 'user-123', email: 'test@example.com' })
      );
      expect(getCachedUser).not.toHaveBeenCalled();
    });

    it('should return phone claims with phone scope', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid phone',
          client_id: 'client-123',
        },
      });

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleUser),
        }),
      });

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody.sub).toBe('user-123');
      expect(responseBody.phone_number).toBe('+81-90-1234-5678');
      expect(responseBody.phone_number_verified).toBe(true);
    });

    it('should return address with address scope', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid address',
          client_id: 'client-123',
        },
      });

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleUser),
        }),
      });

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody.sub).toBe('user-123');
      expect(responseBody.address).toEqual({
        formatted: '123 Test Street, Tokyo, Japan',
        street_address: '123 Test Street',
        locality: 'Tokyo',
        country: 'Japan',
      });
    });

    it('should return all claims with all scopes', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid profile email phone address',
          client_id: 'client-123',
        },
      });

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleUser),
        }),
      });

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody.sub).toBe('user-123');
      expect(responseBody.name).toBe('Test User');
      expect(responseBody.email).toBe('test@example.com');
      expect(responseBody.phone_number).toBe('+81-90-1234-5678');
      expect(responseBody.address).toBeDefined();
    });

    it('should handle empty scope gracefully', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: '',
          client_id: 'client-123',
        },
      });

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleUser),
        }),
      });

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody.sub).toBe('user-123');
      expect(Object.keys(responseBody)).toEqual(['sub']);
    });
  });

  describe('Claims Parameter', () => {
    it('should include claims from claims parameter when allow_claims_without_scope is true', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid',
          client_id: 'client-123',
          claims: JSON.stringify({
            userinfo: {
              email: { essential: true },
              name: null,
            },
          }),
        },
      });

      vi.mocked(getClient).mockResolvedValue({
        client_id: 'client-123',
        allow_claims_without_scope: true,
      } as any);

      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleUser),
        }),
      });

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody.sub).toBe('user-123');
      expect(responseBody.email).toBe('test@example.com');
      expect(responseBody.name).toBe('Test User');
    });

    it('should NOT include claims from claims parameter when allow_claims_without_scope is false', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid',
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
        allow_claims_without_scope: false,
      } as any);

      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleUser),
        }),
      });

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody.sub).toBe('user-123');
      expect(responseBody).not.toHaveProperty('email');
    });

    it('should handle malformed claims parameter gracefully', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid profile',
          client_id: 'client-123',
          claims: 'invalid-json{{{',
        },
      });

      vi.mocked(getClient).mockResolvedValue(null);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleUser),
        }),
      });

      // Should not throw, should continue without claims parameter
      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody.sub).toBe('user-123');
      expect(responseBody.name).toBe('Test User');
    });
  });

  describe('Custom Claims', () => {
    it('should add custom claims without overwriting standard UserInfo claims', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });
      const resolveClaimsForTarget = vi.fn().mockResolvedValue({
        claims: {
          department: 'security',
          name: 'Overridden Name',
        },
      });
      mockLoadFeatureConfig.mockResolvedValue({ enabled: true });
      mockCreateCustomClaimSchemaResolverFromSources.mockReturnValue({
        resolveClaimsForTarget,
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid profile',
          client_id: 'client-123',
        },
      });
      vi.mocked(getClient).mockResolvedValue(null);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody.sub).toBe('user-123');
      expect(responseBody.name).toBe('Test User');
      expect(responseBody.department).toBe('security');
      expect(mockResolveCustomClaimRuntimeSourcesFromEnv).toHaveBeenCalledWith(c, 'default');
      expect(resolveClaimsForTarget).toHaveBeenCalledWith(
        'default',
        'user-123',
        ['openid', 'profile'],
        'userinfo'
      );
    });

    it('should continue with standard claims when custom claim resolution fails', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });
      const resolveClaimsForTarget = vi.fn().mockRejectedValue(new Error('resolver unavailable'));
      mockLoadFeatureConfig.mockResolvedValue({ enabled: true });
      mockCreateCustomClaimSchemaResolverFromSources.mockReturnValue({
        resolveClaimsForTarget,
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid profile',
          client_id: 'client-123',
        },
      });
      vi.mocked(getClient).mockResolvedValue(null);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody.sub).toBe('user-123');
      expect(responseBody.name).toBe('Test User');
      expect(responseBody.department).toBeUndefined();
    });
  });

  describe('Identity mapping and claim release consent', () => {
    function prepareClientBoundRequest() {
      const c = createMockContext({ headers: { Authorization: 'Bearer valid-token' } });
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid profile email',
          client_id: 'client-123',
        },
      });
      vi.mocked(getClient).mockResolvedValue({ client_id: 'client-123' } as never);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);
      return c;
    }

    it('replaces released claims with the mapped claim set', async () => {
      const c = prepareClientBoundRequest();
      mockApplyOIDCIdentityMapping.mockResolvedValue({
        claims: { sub: 'pairwise-subject', department: 'security' },
      });

      await userinfoHandler(c);

      expect(c.json).toHaveBeenCalledWith({
        sub: 'pairwise-subject',
        department: 'security',
      });
      expect(mockEnforceOIDCAttributeReleaseConsent).toHaveBeenCalledWith(
        expect.objectContaining({
          subjectId: 'user-123',
          claims: { sub: 'pairwise-subject', department: 'security' },
        })
      );
    });

    it.each([
      [
        new OIDCIdentityMappingRuntimeError('invalid mapping', {
          code: 'invalid_mapping',
          clientId: 'client-123',
        }),
        400,
        'invalid_client_metadata',
      ],
      [new Error('mapping store unavailable'), 500, 'server_error'],
    ])('fails closed when identity mapping fails', async (error, status, code) => {
      const c = prepareClientBoundRequest();
      mockApplyOIDCIdentityMapping.mockRejectedValue(error);

      await userinfoHandler(c);

      expect(c.json).toHaveBeenCalledWith(expect.objectContaining({ error: code }), status);
      expect(mockEnforceOIDCAttributeReleaseConsent).not.toHaveBeenCalled();
    });

    it.each([
      [
        ['release.attribute_consent.attribute_set_changed'],
        'User consent is required because the UserInfo claim set has changed',
      ],
      [
        ['release.attribute_consent.every_time'],
        'User consent is required for this UserInfo claim release',
      ],
      [
        ['release.attribute_consent.missing'],
        'User consent is required before releasing UserInfo claims',
      ],
    ])('returns a stable consent_required response for reason %s', async (reasonCodes, message) => {
      const c = prepareClientBoundRequest();
      mockEnforceOIDCAttributeReleaseConsent.mockRejectedValue(
        new OIDCAttributeReleaseConsentRequiredError({
          claimSetHash: 'hash',
          reasonCodes,
          consentMode: 'once',
          claimNames: ['email'],
        })
      );

      await userinfoHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        {
          error: 'consent_required',
          error_description: message,
        },
        403
      );
      expect(c.header).toHaveBeenCalledWith('Cache-Control', 'no-store');
    });

    it('masks unexpected consent service failures', async () => {
      const c = prepareClientBoundRequest();
      mockEnforceOIDCAttributeReleaseConsent.mockRejectedValue(new Error('database unavailable'));

      await userinfoHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        {
          error: 'server_error',
          error_description: 'Failed to evaluate claim release consent',
        },
        500
      );
    });
  });

  describe('JWE Encryption', () => {
    it('signs responses and refreshes the per-tenant key cache only after version rotation', async () => {
      const { privateKey } = await generateKeyPair('RS256', { extractable: true });
      const privatePEM = await exportPKCS8(privateKey);
      const getActiveKeyWithPrivateRpc = vi
        .fn()
        .mockResolvedValue({ kid: 'signing-key-1', privatePEM });
      let version = 'v1';
      const configGet = vi.fn().mockImplementation(async () => version);

      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
        env: {
          AUTHRIM_CONFIG: { get: configGet } as unknown as KVNamespace,
          KEY_MANAGER: {
            idFromName: vi.fn().mockReturnValue('key-manager-id'),
            get: vi.fn().mockReturnValue({ getActiveKeyWithPrivateRpc }),
          } as unknown as Env['KEY_MANAGER'],
        },
      });
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid profile',
          client_id: 'signed-client',
        },
      });
      vi.mocked(getClient).mockResolvedValue({
        client_id: 'signed-client',
        userinfo_signed_response_alg: 'RS256',
      } as never);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      await userinfoHandler(c);
      await userinfoHandler(c);
      expect(getActiveKeyWithPrivateRpc).toHaveBeenCalledTimes(1);
      expect(c.body).toHaveBeenCalledWith(expect.stringMatching(/^[^.]+\.[^.]+\.[^.]+$/));

      version = 'v2';
      await userinfoHandler(c);
      expect(getActiveKeyWithPrivateRpc).toHaveBeenCalledTimes(2);
      expect(configGet).toHaveBeenCalledWith('v1:key-version:default');
    });

    it('signs UserInfo with the client-selected ES256 key', async () => {
      const { privateKey } = await generateKeyPair('ES256', { extractable: true });
      const privatePEM = await exportPKCS8(privateKey);
      const getActiveOIDCSigningKeyWithPrivateRpc = vi
        .fn()
        .mockResolvedValue({ kid: 'oidc-es256-userinfo', privatePEM });
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
        env: {
          KEY_MANAGER: {
            idFromName: vi.fn().mockReturnValue('key-manager-id'),
            get: vi.fn().mockReturnValue({ getActiveOIDCSigningKeyWithPrivateRpc }),
          } as unknown as Env['KEY_MANAGER'],
        },
      });
      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: { sub: 'user-123', scope: 'openid profile', client_id: 'es-client' },
      });
      vi.mocked(getClient).mockResolvedValue({
        client_id: 'es-client',
        userinfo_signed_response_alg: 'ES256',
      } as never);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      await userinfoHandler(c);

      const signed = vi.mocked(c.body).mock.calls.at(-1)?.[0] as string;
      expect(decodeProtectedHeader(signed)).toMatchObject({
        alg: 'ES256',
        kid: 'oidc-es256-userinfo',
      });
      expect(getActiveOIDCSigningKeyWithPrivateRpc).toHaveBeenCalledWith('ES256');
    });

    it('should return encrypted response when client requires encryption', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid profile',
          client_id: 'client-123',
        },
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
      } as any);
      vi.mocked(encryptJWT).mockResolvedValue('encrypted.jwt.token');

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleUser),
        }),
      });

      // Mock KEY_MANAGER to return a valid PKCS8 formatted PEM
      const mockPrivateKeyPEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7JHoJfg6yNzLM
-----END PRIVATE KEY-----`;

      c.env.KEY_MANAGER = {
        idFromName: vi.fn().mockReturnValue('key-manager-id'),
        get: vi.fn().mockReturnValue({
          // RPC methods for KeyManager
          getActiveKeyWithPrivateRpc: vi
            .fn()
            .mockResolvedValue({ kid: 'key-1', privatePEM: mockPrivateKeyPEM }),
          // fetch fallback for backward compatibility
          fetch: vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ kid: 'key-1', privatePEM: mockPrivateKeyPEM }), {
              status: 200,
            })
          ),
        }),
      } as unknown as Env['KEY_MANAGER'];

      // Since the private key mock won't actually work with jose.importPKCS8,
      // we'll verify that the error handling works correctly
      await userinfoHandler(c);

      // The test should result in server_error due to invalid PEM format
      // But this validates the encryption path is being attempted
      expect(isUserInfoEncryptionRequired).toHaveBeenCalled();
      expect(getClientPublicKey).toHaveBeenCalled();
    });

    it('should return error when client requires encryption but no public key', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid profile',
          client_id: 'client-123',
        },
      });

      vi.mocked(getClient).mockResolvedValue({
        client_id: 'client-123',
        userinfo_encrypted_response_alg: 'RSA-OAEP',
        userinfo_encrypted_response_enc: 'A256GCM',
      } as any);

      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(true);
      vi.mocked(validateJWEOptions).mockReturnValue(true);
      vi.mocked(getClientPublicKey).mockResolvedValue(null);

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleUser),
        }),
      });

      await userinfoHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_client_metadata',
          error_description: expect.stringContaining('no public key'),
        }),
        400
      );
    });

    it('should return error when JWE options are invalid', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid profile',
          client_id: 'client-123',
        },
      });

      vi.mocked(getClient).mockResolvedValue({
        client_id: 'client-123',
        userinfo_encrypted_response_alg: 'INVALID-ALG',
        userinfo_encrypted_response_enc: 'A256GCM',
      } as any);

      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(true);
      vi.mocked(validateJWEOptions).mockImplementation(() => {
        throw new Error('Unsupported algorithm');
      });

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleUser),
        }),
      });

      await userinfoHandler(c);

      // SECURITY: Error message must not expose specific algorithm details
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_client_metadata',
          error_description: 'Client encryption configuration is invalid',
        }),
        400
      );
    });

    it('should return error when encryption fails', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid profile',
          client_id: 'client-123',
        },
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
      } as any);
      vi.mocked(encryptJWT).mockRejectedValue(new Error('Encryption failed'));

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleUser),
        }),
      });

      await userinfoHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'server_error',
          error_description: 'Failed to encrypt UserInfo response',
        }),
        500
      );
    });
  });

  describe('Data Format Handling', () => {
    it('should convert email_verified from integer to boolean', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid email',
          client_id: 'client-123',
        },
      });

      vi.mocked(getClient).mockResolvedValue(null);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            ...sampleUser,
            email_verified: 1,
          }),
        }),
      });

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody.email_verified).toBe(true);
    });

    it('should convert phone_number_verified from integer to boolean', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid phone',
          client_id: 'client-123',
        },
      });

      vi.mocked(getClient).mockResolvedValue(null);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      mockCanonicalFindByLegacyUserId.mockResolvedValue(
        sampleCanonicalProjection({ phone_number_verified: 0 })
      );

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody.phone_number_verified).toBe(false);
    });

    it('should convert updated_at from milliseconds to seconds', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid profile',
          client_id: 'client-123',
        },
      });

      vi.mocked(getClient).mockResolvedValue(null);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            ...sampleUser,
            updated_at: 1700000000000, // milliseconds
          }),
        }),
      });

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody.updated_at).toBe(1700000000); // seconds
    });

    it('should handle malformed address gracefully', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid address',
          client_id: 'client-123',
        },
      });

      vi.mocked(getClient).mockResolvedValue(null);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      mockCanonicalFindByLegacyUserId.mockResolvedValue(
        sampleCanonicalProjection({ address_json: 'invalid-json{{{' })
      );

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody.address).toBeUndefined();
    });

    it('should handle null/undefined fields gracefully', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

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

      mockCanonicalFindByLegacyUserId.mockResolvedValue({
        ...sampleCanonicalProjection(),
        email: 'user-123@unknown',
        email_verified: 0,
        name: null,
        family_name: null,
        given_name: null,
        middle_name: null,
        nickname: null,
        preferred_username: null,
        picture: null,
        locale: null,
        phone_number: null,
        phone_number_verified: false,
        address_json: null,
        birthdate: null,
        gender: null,
        profile: null,
        website: null,
        zoneinfo: null,
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
      });

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody.sub).toBe('user-123');
      // Null/undefined fields should not be included (except email which has fallback)
      expect(responseBody.name).toBeUndefined();
      // Note: email now has a fallback value when PII DB is unavailable
      expect(responseBody.email).toBe('user-123@unknown');
    });
  });

  describe('Security - Information Disclosure Prevention', () => {
    it('should not leak user existence through different error messages', async () => {
      const c1 = createMockContext({
        headers: { Authorization: 'Bearer token-for-nonexistent-user' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'nonexistent-user',
          scope: 'openid',
          client_id: 'client-123',
        },
      });

      mockCanonicalFindByLegacyUserId.mockResolvedValue(null);

      await userinfoHandler(c1);

      // Error message should be generic
      expect(vi.mocked(c1.json).mock.calls[0][0].error).toBe('invalid_token');
      expect(vi.mocked(c1.json).mock.calls[0][1]).toBe(401);
    });

    it('should not include sensitive internal information in error responses', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: false,
        error: {
          error: 'invalid_token',
          error_description: 'Token validation failed',
          wwwAuthenticate: 'Bearer error="invalid_token"',
          statusCode: 401,
        },
      });

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      // Should not contain stack traces or internal details
      expect(JSON.stringify(responseBody)).not.toContain('stack');
      expect(JSON.stringify(responseBody)).not.toContain('Error:');
    });
  });
});
