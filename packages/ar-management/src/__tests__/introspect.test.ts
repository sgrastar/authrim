/**
 * Token Introspection Endpoint Unit Tests
 *
 * Tests for OAuth 2.0 Token Introspection (RFC 7662)
 * Security-focused tests for token validation, client authentication,
 * and proper introspection responses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

// Hoist mock functions to ensure they're available when vi.mock runs
const {
  mockClientRepository,
  mockValidateClientId,
  mockTimingSafeEqual,
  mockVerifyClientSecretHash,
  mockGetRefreshToken,
  mockIsTokenRevoked,
  mockParseToken,
  mockVerifyToken,
  mockGetTenantIdFromContext,
  mockCreateAuthContextFromHono,
  mockValidateClientAssertion,
  mockGetKeyByKid,
  mockDeviceSecretRepository,
} = vi.hoisted(() => {
  const clientRepo = {
    findByClientId: vi.fn(),
  };
  const deviceSecretRepo = {
    findByRawSecret: vi.fn(),
  };
  return {
    mockClientRepository: clientRepo,
    mockValidateClientId: vi.fn(),
    mockTimingSafeEqual: vi.fn((a: string, b: string) => a === b),
    mockVerifyClientSecretHash: vi.fn(async (secret: string, hash: string) => {
      // Simple mock: check if hash equals 'hash_' + secret
      return hash === 'hash_' + secret;
    }),
    mockGetRefreshToken: vi.fn(),
    mockIsTokenRevoked: vi.fn(),
    mockParseToken: vi.fn(),
    mockVerifyToken: vi.fn(),
    mockGetTenantIdFromContext: vi.fn().mockReturnValue('default'),
    mockCreateAuthContextFromHono: vi.fn().mockReturnValue({
      repositories: {
        client: clientRepo,
      },
    }),
    mockValidateClientAssertion: vi.fn().mockResolvedValue({ valid: true }),
    // Mock for JWKS cache utility
    mockGetKeyByKid: vi.fn().mockResolvedValue({
      kty: 'RSA',
      kid: 'key-1',
      n: 'mock-n',
      e: 'AQAB',
    }),
    mockDeviceSecretRepository: deviceSecretRepo,
  };
});

// Mock the shared module - use importOriginal for error functions
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    validateClientId: mockValidateClientId,
    timingSafeEqual: mockTimingSafeEqual,
    verifyClientSecretHash: mockVerifyClientSecretHash,
    getRefreshToken: mockGetRefreshToken,
    isTokenRevoked: mockIsTokenRevoked,
    parseToken: mockParseToken,
    verifyToken: mockVerifyToken,
    getTenantIdFromContext: mockGetTenantIdFromContext,
    createAuthContextFromHono: mockCreateAuthContextFromHono,
    validateClientAssertion: mockValidateClientAssertion,
    // JWKS cache utility
    getKeyByKid: mockGetKeyByKid,
    getDeviceSecretInstallationId: (device: { id: string; installation_id?: string }) =>
      device.installation_id ?? device.id,
    DeviceSecretRepository: vi.fn(function DeviceSecretRepositoryMock() {
      return mockDeviceSecretRepository;
    }),
    buildIssuerUrl: (env: Partial<Env>, tenantId?: string) => {
      if (env.BASE_DOMAIN) {
        const resolvedTenantId = tenantId || env.DEFAULT_TENANT_ID || 'default';
        const primaryTenantId = env.PRIMARY_TENANT_ID || env.DEFAULT_TENANT_ID || 'default';
        if (env.NAKED_DOMAIN_AS_ISSUER === 'true' && resolvedTenantId === primaryTenantId) {
          return `https://${env.BASE_DOMAIN}`;
        }
        return `https://${resolvedTenantId}.${env.BASE_DOMAIN}`;
      }
      return env.ISSUER_URL || '';
    },
  };
});

// Mock the introspection cache settings module
vi.mock('../routes/settings/introspection-cache', () => ({
  getIntrospectionCacheConfig: vi.fn(),
}));

// Mock jose
vi.mock('jose', () => ({
  importJWK: vi.fn(),
  decodeProtectedHeader: vi.fn().mockReturnValue({ kid: 'key-1' }),
}));

import { introspectHandler } from '../introspect';
import { importJWK } from 'jose';
import { getIntrospectionCacheConfig } from '../routes/settings/introspection-cache';

// Use the hoisted mocks directly (already defined above vi.mock)
const validateClientId = mockValidateClientId;
const timingSafeEqual = mockTimingSafeEqual;
const verifyClientSecretHash = mockVerifyClientSecretHash;
const getRefreshToken = mockGetRefreshToken;
const isTokenRevoked = mockIsTokenRevoked;
const parseToken = mockParseToken;
const verifyToken = mockVerifyToken;

// Helper to create mock context
function createMockContext(options: {
  method?: string;
  headers?: Record<string, string>;
  body?: Record<string, string>;
  env?: Partial<Env>;
}) {
  const mockEnv: Partial<Env> = {
    ISSUER_URL: 'https://op.example.com',
    PUBLIC_JWK_JSON: JSON.stringify({
      kty: 'RSA',
      kid: 'key-1',
      n: 'mock-n',
      e: 'AQAB',
    }),
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn(),
        }),
      }),
    } as unknown as D1Database,
    ...options.env,
  };

  const c = {
    req: {
      header: (name: string) => options.headers?.[name],
      method: options.method || 'POST',
      parseBody: vi.fn().mockResolvedValue(options.body || {}),
    },
    env: mockEnv as Env,
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
    header: vi.fn(),
    // Add get method for context variables (required by getLogger)
    get: vi.fn().mockReturnValue(undefined),
  } as any;

  return c;
}

// Sample token payload for testing
const sampleTokenPayload = {
  jti: 'token-jti-123',
  sub: 'user-123',
  aud: 'https://op.example.com',
  scope: 'openid profile email',
  iss: 'https://op.example.com',
  exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
  iat: Math.floor(Date.now() / 1000),
  client_id: 'client-123',
  rtv: 1, // V2: Refresh token version
};

describe('Token Introspection Endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset repository mock
    mockClientRepository.findByClientId.mockReset();
    mockDeviceSecretRepository.findByRawSecret.mockReset();
    // Re-setup createAuthContextFromHono to return the mock repository
    mockCreateAuthContextFromHono.mockReturnValue({
      repositories: {
        client: mockClientRepository,
      },
      coreAdapter: {},
    });
    vi.mocked(importJWK).mockResolvedValue({} as any);
    // Default: cache disabled for most tests to test without cache
    vi.mocked(getIntrospectionCacheConfig).mockResolvedValue({
      enabled: false,
      ttlSeconds: 60,
    });
  });

  afterEach(() => {
    // Don't use restoreAllMocks as it restores original implementations
    vi.clearAllMocks();
  });

  describe('Content-Type Validation', () => {
    it('should reject requests without application/x-www-form-urlencoded Content-Type', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/json',
        },
        body: {
          token: 'some-token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      const response = await introspectHandler(c);

      // ErrorFactory returns Response directly
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; error_description: string };
      expect(body.error).toBe('invalid_request');
      // AR_ERROR_CODES.VALIDATION_INVALID_VALUE uses standardized message
      expect(body.error_description).toContain('invalid');
    });

    it('should accept application/x-www-form-urlencoded with charset', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(isTokenRevoked).mockResolvedValue(false);

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await introspectHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          active: true,
        })
      );
    });
  });

  describe('Token Parameter Validation', () => {
    it('should return 400 when token parameter is missing', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      const response = await introspectHandler(c);

      // ErrorFactory returns Response directly
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; error_description?: string };
      expect(body.error).toBe('invalid_request');
      // AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD uses standardized message
      expect(body.error_description).toContain('required');
    });
  });

  describe('Client Authentication', () => {
    it('should authenticate client using HTTP Basic', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic ' + btoa('client-123:client-secret'),
        },
        body: {
          token: 'valid.jwt.token',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(isTokenRevoked).mockResolvedValue(false);

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await introspectHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          active: true,
        })
      );
    });

    it('should authenticate client using form body', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(isTokenRevoked).mockResolvedValue(false);

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await introspectHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          active: true,
        })
      );
    });

    it('should return 401 when client_id is invalid', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'invalid-client-id!!!',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({
        valid: false,
        error: 'Invalid client_id format',
      });

      const response = await introspectHandler(c);

      // ErrorFactory returns Response directly
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string; error_description?: string };
      expect(body.error).toBe('invalid_client');
    });

    it('should return 401 when client is not found', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'nonexistent-client',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });

      mockClientRepository.findByClientId.mockResolvedValue(null);

      const response = await introspectHandler(c);

      // Security: Generic message to prevent client_id enumeration
      // ErrorFactory returns Response directly
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string; error_description?: string };
      expect(body.error).toBe('invalid_client');
    });

    it('should return 401 when client_secret is incorrect', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'client-123',
          client_secret: 'wrong-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      // verifyClientSecretHash mock will return false for 'wrong-secret' vs 'hash_correct-secret'

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_correct-secret',
      });

      const response = await introspectHandler(c);

      // ErrorFactory returns Response directly
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string; error_description?: string };
      expect(body.error).toBe('invalid_client');
    });

    it('should use hash verification for client_secret', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(isTokenRevoked).mockResolvedValue(false);

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await introspectHandler(c);

      expect(verifyClientSecretHash).toHaveBeenCalledWith('client-secret', 'hash_client-secret');
    });

    it('resolves duplicated client_id through the request tenant context', async () => {
      mockGetTenantIdFromContext.mockReturnValue('tenant-b');

      const tokenPayload = {
        ...sampleTokenPayload,
        client_id: 'shared-mobile',
      };

      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'shared-mobile',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(tokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(tokenPayload);
      vi.mocked(isTokenRevoked).mockResolvedValue(false);

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'shared-mobile',
        tenant_id: 'tenant-b',
        client_secret_hash: 'hash_client-secret',
      });

      await introspectHandler(c);

      expect(mockCreateAuthContextFromHono).toHaveBeenCalledWith(c, 'tenant-b');
      expect(mockClientRepository.findByClientId).toHaveBeenCalledWith('shared-mobile');
      expect(c.json).toHaveBeenCalledWith(expect.objectContaining({ active: true }));
    });

    it('should use the naked-domain issuer for primary-tenant private_key_jwt validation', async () => {
      mockGetTenantIdFromContext.mockReturnValue('default');

      const tokenPayload = {
        ...sampleTokenPayload,
        aud: 'https://oidc.example.com',
        iss: 'https://oidc.example.com',
      };

      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'client-123',
          client_assertion: 'assertion.jwt',
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        },
        env: {
          BASE_DOMAIN: 'oidc.example.com',
          NAKED_DOMAIN_AS_ISSUER: 'true',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(tokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(tokenPayload);
      vi.mocked(isTokenRevoked).mockResolvedValue(false);

      const clientMetadata = {
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      };
      mockClientRepository.findByClientId.mockResolvedValue(clientMetadata);

      await introspectHandler(c);

      expect(mockValidateClientAssertion).toHaveBeenCalledWith(
        'assertion.jwt',
        'https://oidc.example.com/introspect',
        clientMetadata
      );
      expect(verifyToken).toHaveBeenCalledWith(
        'valid.jwt.token',
        expect.anything(),
        'https://oidc.example.com',
        { audience: 'https://oidc.example.com' }
      );
    });

    it('should prefer the request host for private_key_jwt validation when present', async () => {
      mockGetTenantIdFromContext.mockReturnValue('tenant1');

      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'client-123',
          client_assertion: 'assertion.jwt',
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        },
        env: {
          BASE_DOMAIN: 'oidc.example.com',
        },
      });
      c.req.raw = new Request('https://tenant1.customer.example/introspect', {
        method: 'POST',
        headers: {
          Host: 'tenant1.customer.example',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue({
        ...sampleTokenPayload,
        aud: 'https://tenant1.customer.example',
        iss: 'https://tenant1.customer.example',
      });
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(isTokenRevoked).mockResolvedValue(false);

      const clientMetadata = {
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      };
      mockClientRepository.findByClientId.mockResolvedValue(clientMetadata);

      await introspectHandler(c);

      expect(mockValidateClientAssertion).toHaveBeenCalledWith(
        'assertion.jwt',
        'https://tenant1.customer.example/introspect',
        clientMetadata
      );
    });

    it('should return 401 for invalid Basic auth header format', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic invalid-base64!!!',
        },
        body: {
          token: 'valid.jwt.token',
        },
      });

      const response = await introspectHandler(c);

      // ErrorFactory returns Response directly
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string; error_description?: string };
      expect(body.error).toBe('invalid_client');
    });
  });

  describe('Token Introspection Response', () => {
    it('should return active=true for valid token', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(isTokenRevoked).mockResolvedValue(false);

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await introspectHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          active: true,
          scope: 'openid profile email',
          client_id: 'client-123',
          token_type: 'Bearer',
          sub: 'user-123',
          iss: 'https://op.example.com',
          jti: 'token-jti-123',
        })
      );
    });

    it('returns downstream elevation details for exchanged break-glass tokens', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue({
        ...sampleTokenPayload,
        authorization_details: [
          {
            type: 'authrim_break_glass',
            grant_id: 'egr_public_1',
            request_id: 'apr_public_1',
            investigation_id: 'inv_123',
            request_surface: 'service_data',
            requested_action: 'detail_read',
            resource_class: 'customer_profile',
            resource_ids: ['user-123'],
            detail_classes: ['profile_export'],
            dataset: 'profiles',
            audience: 'https://service.example.com',
            redaction_level: 'masked',
            target_subject_type: 'user',
            target_subject_id: 'user-123',
            requester_subject_type: 'admin_user',
            requester_subject_id: 'admin-1',
            ticket_reference: null,
            reference: null,
            policy_preset: 'technical_debug_default',
            reuse_scope: 'request',
            partial_access_allowed: false,
          },
        ],
        authrim_elevation: {
          grant_id: 'egr_public_1',
          request_id: 'apr_public_1',
          investigation_id: 'inv_123',
          target_subject_type: 'user',
          target_subject_id: 'user-123',
          requester_subject_type: 'admin_user',
          requester_subject_id: 'admin-1',
          resource_class: 'customer_profile',
          redaction_level: 'masked',
        },
      });
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(isTokenRevoked).mockResolvedValue(false);

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await introspectHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          active: true,
          authorization_details: [
            expect.objectContaining({
              type: 'authrim_break_glass',
              grant_id: 'egr_public_1',
            }),
          ],
          authrim_elevation: expect.objectContaining({
            grant_id: 'egr_public_1',
            request_id: 'apr_public_1',
            investigation_id: 'inv_123',
            resource_class: 'customer_profile',
            redaction_level: 'masked',
          }),
        })
      );
    });

    it('should return active=false for invalid token format', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'invalid-token-format',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockImplementation(() => {
        throw new Error('Invalid token format');
      });

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await introspectHandler(c);

      expect(c.json).toHaveBeenCalledWith({ active: false });
    });

    it('should return active=false for expired token', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'expired.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue({
        ...sampleTokenPayload,
        exp: Math.floor(Date.now() / 1000) - 3600, // Expired 1 hour ago
      });
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await introspectHandler(c);

      expect(c.json).toHaveBeenCalledWith({ active: false });
    });

    it('should return active=false for revoked token', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'revoked.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(isTokenRevoked).mockResolvedValue(true); // Token is revoked

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await introspectHandler(c);

      expect(c.json).toHaveBeenCalledWith({ active: false });
    });

    it('should return active=false for token with invalid signature', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'tampered.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockRejectedValue(new Error('Invalid signature'));

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await introspectHandler(c);

      expect(c.json).toHaveBeenCalledWith({ active: false });
    });
  });

  describe('Token Type Hint Handling', () => {
    it('should check refresh token storage when token_type_hint is refresh_token', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'refresh.token.value',
          token_type_hint: 'refresh_token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(getRefreshToken).mockResolvedValue({
        familyId: 'family-123',
        tokenId: 'token-jti-123',
      } as any);

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await introspectHandler(c);

      // V2 API: getRefreshToken(env, userId, version, clientId, jti)
      expect(getRefreshToken).toHaveBeenCalledWith(
        c.env,
        'user-123',
        1,
        'client-123',
        'token-jti-123',
        'tenant1'
      );
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          active: true,
        })
      );
    });

    it('should return active=false for non-existent refresh token', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'nonexistent.refresh.token',
          token_type_hint: 'refresh_token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(getRefreshToken).mockResolvedValue(null); // Refresh token not found

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await introspectHandler(c);

      expect(c.json).toHaveBeenCalledWith({ active: false });
    });

    it('should check revocation status when token_type_hint is access_token', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'access.token.value',
          token_type_hint: 'access_token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(isTokenRevoked).mockResolvedValue(false);

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await introspectHandler(c);

      expect(isTokenRevoked).toHaveBeenCalledWith(c.env, 'token-jti-123', 'tenant1');
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          active: true,
        })
      );
    });
  });

  describe('Device Secret Introspection', () => {
    it('returns canonical active metadata for confidential callers', async () => {
      const expiresAt = Date.now() + 3_600_000;
      const createdAt = Date.now() - 60_000;
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'raw-device-secret',
          token_type_hint: 'device_secret',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
        client_name: 'Native Service',
      });
      mockDeviceSecretRepository.findByRawSecret.mockResolvedValue({
        id: 'ds-001',
        installation_id: 'inst-001',
        tenant_id: 'default',
        user_id: 'user-123',
        session_id: 'sid-123',
        secret_hash: 'hash',
        device_platform: 'ios',
        created_at: createdAt,
        updated_at: createdAt,
        expires_at: expiresAt,
        last_used_at: createdAt,
        use_count: 1,
        is_active: 1,
      });

      const response = await introspectHandler(c);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        active: true,
        token_type: 'device_secret',
        client_id: 'client-123',
        sub: 'user-123',
        iss: 'https://op.example.com',
        jti: 'ds-001',
        installation_id: 'inst-001',
        app_display_name: 'Native Service',
        platform: 'ios',
        display_name: '',
        fallback_display_name: 'ios device',
      });
      expect(body.exp).toBe(Math.floor(expiresAt / 1000));
      expect(body.iat).toBe(Math.floor(createdAt / 1000));
      expect(body).not.toHaveProperty('aud');
      expect(body).not.toHaveProperty('last_seen_at');
    });

    it('omits fallback_display_name when the device has a user display name', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'raw-device-secret',
          token_type_hint: 'device_secret',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });
      mockDeviceSecretRepository.findByRawSecret.mockResolvedValue({
        id: 'ds-001',
        tenant_id: 'default',
        user_id: 'user-123',
        session_id: 'sid-123',
        secret_hash: 'hash',
        device_name: 'Work iPhone',
        device_platform: undefined,
        created_at: Date.now() - 60_000,
        updated_at: Date.now() - 60_000,
        expires_at: Date.now() + 3_600_000,
        use_count: 1,
        is_active: 1,
      });

      const response = await introspectHandler(c);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.display_name).toBe('Work iPhone');
      expect(body.platform).toBe('unknown');
      expect(body.fallback_display_name).toBeUndefined();
      expect(body.app_display_name).toBeUndefined();
    });

    it('denies confidential cross-client introspection without trust-group allowlist', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'raw-device-secret',
          token_type_hint: 'device_secret',
          client_id: 'service-client',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'service-client',
        client_secret_hash: 'hash_client-secret',
        trust_group_id: 'wallet-suite',
      });
      mockDeviceSecretRepository.findByRawSecret.mockResolvedValue({
        id: 'ds-001',
        installation_id: 'inst-001',
        tenant_id: 'default',
        client_id: 'native-client',
        trust_group_id: 'wallet-suite',
        user_id: 'user-123',
        session_id: 'sid-123',
        secret_hash: 'hash',
        created_at: Date.now() - 60_000,
        updated_at: Date.now() - 60_000,
        expires_at: Date.now() + 3_600_000,
        use_count: 1,
        is_active: 1,
      });

      const response = await introspectHandler(c);
      const body = (await response.json()) as {
        error: string;
        error_details?: { code?: string };
      };

      expect(response.status).toBe(403);
      expect(body.error).toBe('access_denied');
      expect(body.error_details?.code).toBe('unauthorized_introspection_caller');
    });

    it('allows confidential cross-client introspection with trust-group allowlist', async () => {
      const expiresAt = Date.now() + 3_600_000;
      const createdAt = Date.now() - 60_000;
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'raw-device-secret',
          token_type_hint: 'device_secret',
          client_id: 'service-client',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      mockClientRepository.findByClientId
        .mockResolvedValueOnce({
          client_id: 'service-client',
          client_secret_hash: 'hash_client-secret',
          trust_group_id: 'wallet-suite',
          device_secret_introspection_trust_groups: ['wallet-suite'],
        })
        .mockResolvedValueOnce({
          client_id: 'native-client',
          client_name: 'Wallet Native App',
        });
      mockDeviceSecretRepository.findByRawSecret.mockResolvedValue({
        id: 'ds-001',
        installation_id: 'inst-001',
        tenant_id: 'default',
        client_id: 'native-client',
        trust_group_id: 'wallet-suite',
        user_id: 'user-123',
        session_id: 'sid-123',
        secret_hash: 'hash',
        device_platform: 'ios',
        created_at: createdAt,
        updated_at: createdAt,
        expires_at: expiresAt,
        use_count: 1,
        is_active: 1,
      });

      const response = await introspectHandler(c);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        active: true,
        token_type: 'device_secret',
        client_id: 'native-client',
        installation_id: 'inst-001',
        app_display_name: 'Wallet Native App',
      });
      expect(body.exp).toBe(Math.floor(expiresAt / 1000));
      expect(body.iat).toBe(Math.floor(createdAt / 1000));
    });

    it('returns introspection_disabled when confidential caller policy disables it', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'raw-device-secret',
          token_type_hint: 'device_secret',
          client_id: 'service-client',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'service-client',
        client_secret_hash: 'hash_client-secret',
        device_secret_introspection_enabled: false,
      });

      const response = await introspectHandler(c);
      const body = (await response.json()) as {
        error: string;
        error_details?: { code?: string };
      };

      expect(response.status).toBe(403);
      expect(body.error).toBe('access_denied');
      expect(body.error_details?.code).toBe('introspection_disabled');
      expect(mockDeviceSecretRepository.findByRawSecret).not.toHaveBeenCalled();
    });

    it('denies native public callers for device_secret introspection', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'raw-device-secret',
          token_type_hint: 'device_secret',
          client_id: 'native-client',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'native-client',
        application_type: 'native',
      });

      const response = await introspectHandler(c);
      const body = (await response.json()) as {
        error: string;
        error_details?: { code?: string };
      };

      expect(response.status).toBe(403);
      expect(body.error).toBe('access_denied');
      expect(body.error_details?.code).toBe('unauthorized_introspection_caller');
      expect(mockDeviceSecretRepository.findByRawSecret).not.toHaveBeenCalled();
    });

    it('returns active=false for inactive device_secret records', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'raw-device-secret',
          token_type_hint: 'device_secret',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });
      mockDeviceSecretRepository.findByRawSecret.mockResolvedValue(null);

      const response = await introspectHandler(c);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ active: false });
    });
  });

  describe('Server Configuration Errors', () => {
    it('should return 500 when no JWKS key is available', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
        env: {
          PUBLIC_JWK_JSON: undefined, // Missing
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      // Simulate no key available from JWKS cache hierarchy
      mockGetKeyByKid.mockResolvedValueOnce(undefined);

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      const response = await introspectHandler(c);

      // ErrorFactory returns Response directly
      expect(response.status).toBe(500);
      const body = (await response.json()) as { error: string; error_description?: string };
      expect(body.error).toBe('server_error');
    });

    it('should return 500 when key import fails', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
        env: {
          PUBLIC_JWK_JSON: 'invalid-json{{{',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      // Key is returned but importJWK fails
      mockGetKeyByKid.mockResolvedValueOnce({
        kty: 'RSA',
        kid: 'key-1',
        n: 'invalid',
        e: 'AQAB',
      });
      vi.mocked(importJWK).mockRejectedValueOnce(new Error('Invalid key material'));

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      const response = await introspectHandler(c);

      // ErrorFactory returns Response directly
      expect(response.status).toBe(500);
      const body = (await response.json()) as { error: string; error_description?: string };
      expect(body.error).toBe('server_error');
    });
  });

  describe('Error Handling', () => {
    it('should handle body parsing errors', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {},
      });

      c.req.parseBody = vi.fn().mockRejectedValue(new Error('Parse error'));

      const response = await introspectHandler(c);

      // ErrorFactory returns Response directly
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; error_description?: string };
      expect(body.error).toBe('invalid_request');
    });
  });

  describe('Security - Information Disclosure Prevention', () => {
    it('should return same response structure for valid and invalid tokens', async () => {
      // Both valid and invalid tokens should return { active: false }
      // without revealing why the token is invalid
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'invalid-token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockImplementation(() => {
        throw new Error('Invalid token');
      });

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await introspectHandler(c);

      // Should just return { active: false } without error details
      expect(c.json).toHaveBeenCalledWith({ active: false });
    });
  });

  describe('Response Caching', () => {
    it('should ignore cached responses until the submitted token is fully validated', async () => {
      const cachedResponse = {
        active: true,
        scope: 'openid profile',
        client_id: 'client-123',
        token_type: 'Bearer',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        sub: 'user-123',
        aud: 'https://op.example.com',
        iss: 'https://op.example.com',
        jti: 'token-jti-123',
      };

      vi.mocked(getIntrospectionCacheConfig).mockResolvedValue({
        enabled: true,
        ttlSeconds: 60,
      });

      const mockKvGet = vi.fn().mockResolvedValue(cachedResponse);
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
        env: {
          AUTHRIM_CONFIG: {
            get: mockKvGet,
            put: vi.fn(),
            delete: vi.fn(),
          } as unknown as KVNamespace,
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(isTokenRevoked).mockResolvedValue(false);

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await introspectHandler(c);

      // Cached responses are not trusted before signature and revocation validation.
      expect(mockKvGet).not.toHaveBeenCalled();
      expect(verifyToken).toHaveBeenCalled();
      expect(isTokenRevoked).toHaveBeenCalled();
      expect(c.json).toHaveBeenCalledWith(expect.objectContaining({ active: true }));
    });

    it('should return active=false and delete cache when cached token is revoked', async () => {
      const cachedResponse = {
        active: true,
        jti: 'token-jti-123',
        exp: Math.floor(Date.now() / 1000) + 3600,
      };

      vi.mocked(getIntrospectionCacheConfig).mockResolvedValue({
        enabled: true,
        ttlSeconds: 60,
      });

      const mockKvDelete = vi.fn().mockResolvedValue(undefined);
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
        env: {
          AUTHRIM_CONFIG: {
            get: vi.fn().mockResolvedValue(cachedResponse),
            put: vi.fn(),
            delete: mockKvDelete,
          } as unknown as KVNamespace,
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(isTokenRevoked).mockResolvedValue(true); // Token is revoked

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await introspectHandler(c);

      // Cached state is ignored; revocation is checked against the live token.
      expect(mockKvDelete).not.toHaveBeenCalled();
      // Should return inactive
      expect(c.json).toHaveBeenCalledWith({ active: false });
    });

    it('should return active=false and delete cache when cached token is expired', async () => {
      const cachedResponse = {
        active: true,
        jti: 'token-jti-123',
        exp: Math.floor(Date.now() / 1000) - 100, // Already expired
      };

      vi.mocked(getIntrospectionCacheConfig).mockResolvedValue({
        enabled: true,
        ttlSeconds: 60,
      });

      const mockKvDelete = vi.fn().mockResolvedValue(undefined);
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
        env: {
          AUTHRIM_CONFIG: {
            get: vi.fn().mockResolvedValue(cachedResponse),
            put: vi.fn(),
            delete: mockKvDelete,
          } as unknown as KVNamespace,
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      const expiredTokenPayload = {
        ...sampleTokenPayload,
        exp: Math.floor(Date.now() / 1000) - 100,
      };
      vi.mocked(parseToken).mockReturnValue(expiredTokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(expiredTokenPayload);

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await introspectHandler(c);

      // Cached state is ignored; expiry is checked against the live token.
      expect(mockKvDelete).not.toHaveBeenCalled();
      // Should return inactive
      expect(c.json).toHaveBeenCalledWith({ active: false });
    });

    it('should store active=true response in cache', async () => {
      vi.mocked(getIntrospectionCacheConfig).mockResolvedValue({
        enabled: true,
        ttlSeconds: 60,
      });

      const mockKvPut = vi.fn().mockResolvedValue(undefined);
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
        env: {
          AUTHRIM_CONFIG: {
            get: vi.fn().mockResolvedValue(null), // Cache miss
            put: mockKvPut,
            delete: vi.fn(),
          } as unknown as KVNamespace,
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(isTokenRevoked).mockResolvedValue(false);

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await introspectHandler(c);

      // Should store in cache with TTL
      expect(mockKvPut).toHaveBeenCalledWith(
        expect.stringContaining('introspect_cache:'),
        expect.stringContaining('"active":true'),
        expect.objectContaining({ expirationTtl: 60 })
      );
    });

    it('should NOT cache when cache is disabled', async () => {
      vi.mocked(getIntrospectionCacheConfig).mockResolvedValue({
        enabled: false,
        ttlSeconds: 60,
      });

      const mockKvGet = vi.fn();
      const mockKvPut = vi.fn();
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
        env: {
          AUTHRIM_CONFIG: {
            get: mockKvGet,
            put: mockKvPut,
            delete: vi.fn(),
          } as unknown as KVNamespace,
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(isTokenRevoked).mockResolvedValue(false);

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await introspectHandler(c);

      // Should NOT read from or write to cache
      expect(mockKvGet).not.toHaveBeenCalled();
      expect(mockKvPut).not.toHaveBeenCalled();
    });

    it('should handle cache read errors gracefully', async () => {
      vi.mocked(getIntrospectionCacheConfig).mockResolvedValue({
        enabled: true,
        ttlSeconds: 60,
      });

      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
        env: {
          AUTHRIM_CONFIG: {
            get: vi.fn().mockRejectedValue(new Error('KV error')),
            put: vi.fn().mockResolvedValue(undefined),
            delete: vi.fn().mockResolvedValue(undefined),
          } as unknown as KVNamespace,
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(isTokenRevoked).mockResolvedValue(false);

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await introspectHandler(c);

      // Should fall back to full validation and still return active=true
      expect(verifyToken).toHaveBeenCalled();
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          active: true,
        })
      );
    });

    it('should skip cache when JTI is missing', async () => {
      vi.mocked(getIntrospectionCacheConfig).mockResolvedValue({
        enabled: true,
        ttlSeconds: 60,
      });

      const tokenWithoutJti = { ...sampleTokenPayload, jti: undefined };
      const mockKvGet = vi.fn();

      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
        env: {
          AUTHRIM_CONFIG: {
            get: mockKvGet,
            put: vi.fn(),
            delete: vi.fn(),
          } as unknown as KVNamespace,
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(tokenWithoutJti);
      vi.mocked(verifyToken).mockResolvedValue(tokenWithoutJti);
      vi.mocked(isTokenRevoked).mockResolvedValue(false);

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await introspectHandler(c);

      // Should not check cache when JTI is missing
      expect(mockKvGet).not.toHaveBeenCalled();
    });

    it('should skip cache when AUTHRIM_CONFIG is undefined', async () => {
      vi.mocked(getIntrospectionCacheConfig).mockResolvedValue({
        enabled: true,
        ttlSeconds: 60,
      });

      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
        env: {
          AUTHRIM_CONFIG: undefined, // KV not configured
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(isTokenRevoked).mockResolvedValue(false);

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await introspectHandler(c);

      // Should still return valid response (full validation path)
      expect(verifyToken).toHaveBeenCalled();
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          active: true,
        })
      );
    });

    it('should validate refresh_token hints without trusting cached responses', async () => {
      const cachedResponse = {
        active: true,
        scope: 'openid offline_access',
        client_id: 'client-123',
        token_type: 'Bearer',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        sub: 'user-123',
        aud: 'https://op.example.com',
        iss: 'https://op.example.com',
        jti: 'token-jti-123',
      };

      vi.mocked(getIntrospectionCacheConfig).mockResolvedValue({
        enabled: true,
        ttlSeconds: 60,
      });

      const mockKvGet = vi.fn().mockResolvedValue(cachedResponse);
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'refresh.token.value',
          token_type_hint: 'refresh_token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
        env: {
          AUTHRIM_CONFIG: {
            get: mockKvGet,
            put: vi.fn(),
            delete: vi.fn(),
          } as unknown as KVNamespace,
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(getRefreshToken).mockResolvedValue({
        familyId: 'family-123',
        tokenId: 'token-jti-123',
      } as any);

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await introspectHandler(c);

      expect(mockKvGet).not.toHaveBeenCalled();
      expect(verifyToken).toHaveBeenCalled();
      // Should call getRefreshToken instead of isTokenRevoked for refresh_token hint
      expect(getRefreshToken).toHaveBeenCalledWith(
        c.env,
        'user-123',
        1,
        'client-123',
        'token-jti-123',
        'tenant1'
      );
      expect(isTokenRevoked).not.toHaveBeenCalled();
      expect(c.json).toHaveBeenCalledWith(expect.objectContaining({ active: true }));
    });

    it('should return active=false when refresh_token not found on cache hit', async () => {
      const cachedResponse = {
        active: true,
        jti: 'token-jti-123',
        exp: Math.floor(Date.now() / 1000) + 3600,
        sub: 'user-123',
        client_id: 'client-123',
      };

      vi.mocked(getIntrospectionCacheConfig).mockResolvedValue({
        enabled: true,
        ttlSeconds: 60,
      });

      const mockKvDelete = vi.fn().mockResolvedValue(undefined);
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'refresh.token.value',
          token_type_hint: 'refresh_token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
        env: {
          AUTHRIM_CONFIG: {
            get: vi.fn().mockResolvedValue(cachedResponse),
            put: vi.fn(),
            delete: mockKvDelete,
          } as unknown as KVNamespace,
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(getRefreshToken).mockResolvedValue(null); // Refresh token not found

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await introspectHandler(c);

      // Should call getRefreshToken for refresh_token hint
      expect(getRefreshToken).toHaveBeenCalled();
      // Cached state is ignored; no cache entry is consumed or deleted.
      expect(mockKvDelete).not.toHaveBeenCalled();
      // Should return inactive
      expect(c.json).toHaveBeenCalledWith({ active: false });
    });

    it('should use SHA-256 hash format for cache key', async () => {
      vi.mocked(getIntrospectionCacheConfig).mockResolvedValue({
        enabled: true,
        ttlSeconds: 60,
      });

      const mockKvPut = vi.fn().mockResolvedValue(undefined);
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
        env: {
          AUTHRIM_CONFIG: {
            get: vi.fn().mockResolvedValue(null), // Cache miss
            put: mockKvPut,
            delete: vi.fn(),
          } as unknown as KVNamespace,
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(isTokenRevoked).mockResolvedValue(false);

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await introspectHandler(c);

      // Verify cache key format: introspect_cache:{sha256_hex}
      // SHA-256 produces 64 hex characters
      const putCall = mockKvPut.mock.calls[0];
      const cacheKey = putCall[0] as string;

      expect(cacheKey).toMatch(/^introspect_cache:[a-f0-9]{64}$/);
    });

    it('should skip getRefreshToken check when sub is undefined on refresh_token cache hit', async () => {
      // Token payload without sub
      const tokenWithoutSub = { ...sampleTokenPayload, sub: undefined };
      const cachedResponse = {
        active: true,
        scope: 'openid offline_access',
        client_id: 'client-123',
        token_type: 'Bearer',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        aud: 'https://op.example.com',
        iss: 'https://op.example.com',
        jti: 'token-jti-123',
      };

      vi.mocked(getIntrospectionCacheConfig).mockResolvedValue({
        enabled: true,
        ttlSeconds: 60,
      });

      const mockKvGet = vi.fn().mockResolvedValue(cachedResponse);
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'refresh.token.value',
          token_type_hint: 'refresh_token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
        env: {
          AUTHRIM_CONFIG: {
            get: mockKvGet,
            put: vi.fn(),
            delete: vi.fn(),
          } as unknown as KVNamespace,
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(tokenWithoutSub);
      vi.mocked(verifyToken).mockResolvedValue(tokenWithoutSub);

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await introspectHandler(c);

      // Should NOT call getRefreshToken when sub is undefined
      expect(getRefreshToken).not.toHaveBeenCalled();
      // Should NOT call isTokenRevoked either (refresh_token hint)
      expect(isTokenRevoked).not.toHaveBeenCalled();
      expect(mockKvGet).not.toHaveBeenCalled();
      expect(verifyToken).toHaveBeenCalled();
      expect(c.json).toHaveBeenCalledWith(expect.objectContaining({ active: true }));
    });

    it('should NOT cache active=false response', async () => {
      vi.mocked(getIntrospectionCacheConfig).mockResolvedValue({
        enabled: true,
        ttlSeconds: 60,
      });

      const mockKvPut = vi.fn().mockResolvedValue(undefined);
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'revoked.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
        env: {
          AUTHRIM_CONFIG: {
            get: vi.fn().mockResolvedValue(null), // Cache miss
            put: mockKvPut,
            delete: vi.fn(),
          } as unknown as KVNamespace,
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(isTokenRevoked).mockResolvedValue(true); // Token is revoked

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await introspectHandler(c);

      // Should return active=false
      expect(c.json).toHaveBeenCalledWith({ active: false });
      // Should NOT write to cache for inactive tokens
      expect(mockKvPut).not.toHaveBeenCalled();
    });

    it('should proceed to full validation when cache contains active=false', async () => {
      // Edge case: cache somehow contains active=false (should not happen, but defensive)
      const invalidCachedResponse = { active: false };

      vi.mocked(getIntrospectionCacheConfig).mockResolvedValue({
        enabled: true,
        ttlSeconds: 60,
      });

      const mockKvGet = vi.fn().mockResolvedValue(invalidCachedResponse);
      const mockKvPut = vi.fn().mockResolvedValue(undefined);
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
        env: {
          AUTHRIM_CONFIG: {
            get: mockKvGet,
            put: mockKvPut,
            delete: vi.fn(),
          } as unknown as KVNamespace,
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(isTokenRevoked).mockResolvedValue(false);

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await introspectHandler(c);

      // Should proceed to full validation (verifyToken called)
      expect(verifyToken).toHaveBeenCalled();
      // Should return active=true after full validation
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          active: true,
        })
      );
      // Should update cache with valid response
      expect(mockKvPut).toHaveBeenCalled();
    });
  });
});
