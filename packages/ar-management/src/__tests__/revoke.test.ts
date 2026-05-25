/**
 * Token Revocation Endpoint Unit Tests
 *
 * Tests for OAuth 2.0 Token Revocation (RFC 7009)
 * Security-focused tests for token revocation, client authentication,
 * and timing attack prevention.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

// Hoist mock functions to ensure they're available when vi.mock runs
const {
  mockClientRepository,
  mockValidateClientId,
  mockTimingSafeEqual,
  mockVerifyClientSecretHash,
  mockDeleteRefreshToken,
  mockGetRefreshToken,
  mockRevokeToken,
  mockParseToken,
  mockVerifyToken,
  mockGetTenantIdFromContext,
  mockCreateAuthContextFromHono,
  mockValidateClientAssertion,
  mockCreateOAuthConfigManager,
  mockGetKeyByKid,
  mockDeviceSecretRepository,
} = vi.hoisted(() => {
  const clientRepo = {
    findByClientId: vi.fn(),
  };
  const deviceSecretRepo = {
    findByRawSecret: vi.fn(),
    revoke: vi.fn(),
    revokeByRawSecret: vi.fn(),
  };
  // Mock ConfigManager with getNumber method
  const mockConfigManager = {
    getNumber: vi.fn().mockResolvedValue(3600),
    getString: vi.fn(),
    getBoolean: vi.fn(),
  };
  return {
    mockClientRepository: clientRepo,
    mockValidateClientId: vi.fn(),
    mockTimingSafeEqual: vi.fn((a: string, b: string) => a === b),
    mockVerifyClientSecretHash: vi.fn(async (secret: string, hash: string) => {
      return hash === 'hash_' + secret;
    }),
    mockDeleteRefreshToken: vi.fn(),
    mockGetRefreshToken: vi.fn(),
    mockRevokeToken: vi.fn(),
    mockParseToken: vi.fn(),
    mockVerifyToken: vi.fn(),
    mockGetTenantIdFromContext: vi.fn().mockReturnValue('default'),
    mockCreateAuthContextFromHono: vi.fn().mockReturnValue({
      repositories: {
        client: clientRepo,
      },
    }),
    mockValidateClientAssertion: vi.fn().mockResolvedValue({ valid: true }),
    mockCreateOAuthConfigManager: vi.fn().mockReturnValue(mockConfigManager),
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
    deleteRefreshToken: mockDeleteRefreshToken,
    getRefreshToken: mockGetRefreshToken,
    revokeToken: mockRevokeToken,
    parseToken: mockParseToken,
    verifyToken: mockVerifyToken,
    getTenantIdFromContext: mockGetTenantIdFromContext,
    createAuthContextFromHono: mockCreateAuthContextFromHono,
    validateClientAssertion: mockValidateClientAssertion,
    createOAuthConfigManager: mockCreateOAuthConfigManager,
    getKeyByKid: mockGetKeyByKid,
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

// Mock jose
vi.mock('jose', () => ({
  importJWK: vi.fn(),
  decodeProtectedHeader: vi.fn(),
}));

import { revokeHandler } from '../revoke';
import { importJWK, decodeProtectedHeader } from 'jose';

// Use the hoisted mocks directly (already defined above vi.mock)
const validateClientId = mockValidateClientId;
const timingSafeEqual = mockTimingSafeEqual;
const verifyClientSecretHash = mockVerifyClientSecretHash;
const deleteRefreshToken = mockDeleteRefreshToken;
const getRefreshToken = mockGetRefreshToken;
const revokeToken = mockRevokeToken;
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
    ACCESS_TOKEN_EXPIRY: '3600',
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
    body: vi.fn((body, status = 200) => new Response(body, { status })),
    header: vi.fn(),
    // Add get method for context variables (required by getLogger)
    get: vi.fn().mockReturnValue(undefined),
  } as any;

  return c;
}

describe('Token Revocation Endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset repository mock
    mockClientRepository.findByClientId.mockReset();
    mockDeviceSecretRepository.findByRawSecret.mockReset().mockResolvedValue(null);
    mockDeviceSecretRepository.revoke.mockReset().mockResolvedValue(true);
    mockDeviceSecretRepository.revokeByRawSecret.mockReset().mockResolvedValue(true);
    // Re-setup createAuthContextFromHono to return the mock repository
    mockCreateAuthContextFromHono.mockReturnValue({
      repositories: {
        client: mockClientRepository,
      },
      coreAdapter: {},
    });
    // Setup jose mocks for signature verification
    vi.mocked(importJWK).mockResolvedValue({} as any);
    vi.mocked(decodeProtectedHeader).mockReturnValue({ alg: 'RS256', kid: 'key-1' });
    // verifyToken succeeds by default
    verifyToken.mockResolvedValue({} as any);
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

      const response = await revokeHandler(c);

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
      vi.mocked(parseToken).mockReturnValue({
        jti: 'token-jti-123',
        client_id: 'client-123',
      });

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await revokeHandler(c);

      expect(c.body).toHaveBeenCalledWith(null, 200);
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

      const response = await revokeHandler(c);

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
      vi.mocked(parseToken).mockReturnValue({
        jti: 'token-jti-123',
        client_id: 'client-123',
      });

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await revokeHandler(c);

      expect(c.body).toHaveBeenCalledWith(null, 200);
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
      vi.mocked(parseToken).mockReturnValue({
        jti: 'token-jti-123',
        client_id: 'client-123',
      });

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await revokeHandler(c);

      expect(c.body).toHaveBeenCalledWith(null, 200);
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

      const response = await revokeHandler(c);

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

      const response = await revokeHandler(c);

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

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_correct-secret', // won't match 'wrong-secret'
      });

      const response = await revokeHandler(c);

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
      vi.mocked(parseToken).mockReturnValue({
        jti: 'token-jti-123',
        client_id: 'client-123',
      });

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await revokeHandler(c);

      expect(verifyClientSecretHash).toHaveBeenCalledWith('client-secret', 'hash_client-secret');
    });

    it('resolves duplicated client_id through the request tenant context', async () => {
      mockGetTenantIdFromContext.mockReturnValue('tenant-b');

      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          token_type_hint: 'access_token',
          client_id: 'shared-mobile',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue({
        jti: 'token-jti-123',
        client_id: 'shared-mobile',
        aud: 'https://op.example.com',
        sub: 'user-123',
        rtv: 1,
      });

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'shared-mobile',
        tenant_id: 'tenant-b',
        client_secret_hash: 'hash_client-secret',
      });

      await revokeHandler(c);

      expect(mockCreateAuthContextFromHono).toHaveBeenCalledWith(c, 'tenant-b');
      expect(mockClientRepository.findByClientId).toHaveBeenCalledWith('shared-mobile');
      expect(revokeToken).toHaveBeenCalledWith(c.env, 'token-jti-123', 3600, undefined, 'tenant-b');
    });

    it('should use tenant subdomain issuer for non-primary private_key_jwt validation', async () => {
      mockGetTenantIdFromContext.mockReturnValue('acme');

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
      vi.mocked(parseToken).mockReturnValue({
        jti: 'token-jti-123',
        client_id: 'client-123',
        aud: 'https://acme.oidc.example.com',
        iss: 'https://acme.oidc.example.com',
        sub: 'user-123',
        rtv: 1,
      });

      const clientMetadata = {
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      };
      mockClientRepository.findByClientId.mockResolvedValue(clientMetadata);

      await revokeHandler(c);

      expect(mockValidateClientAssertion).toHaveBeenCalledWith(
        'assertion.jwt',
        'https://acme.oidc.example.com/revoke',
        clientMetadata
      );
      expect(verifyToken).toHaveBeenCalledWith(
        'valid.jwt.token',
        expect.anything(),
        'https://acme.oidc.example.com',
        { audience: 'https://acme.oidc.example.com' }
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
      c.req.raw = new Request('https://tenant1.customer.example/revoke', {
        method: 'POST',
        headers: {
          Host: 'tenant1.customer.example',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue({
        jti: 'token-jti-123',
        client_id: 'client-123',
        aud: 'https://tenant1.customer.example',
        iss: 'https://tenant1.customer.example',
        sub: 'user-123',
        rtv: 1,
      });

      const clientMetadata = {
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      };
      mockClientRepository.findByClientId.mockResolvedValue(clientMetadata);

      await revokeHandler(c);

      expect(mockValidateClientAssertion).toHaveBeenCalledWith(
        'assertion.jwt',
        'https://tenant1.customer.example/revoke',
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

      const response = await revokeHandler(c);

      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string; error_description?: string };
      expect(body.error).toBe('invalid_client');
    });
  });

  describe('Token Revocation (RFC 7009 Compliance)', () => {
    it('should return 200 for successfully revoked token', async () => {
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
        jti: 'token-jti-123',
        client_id: 'client-123',
      });
      vi.mocked(getRefreshToken).mockResolvedValue(null); // Not a refresh token

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await revokeHandler(c);

      expect(revokeToken).toHaveBeenCalledWith(c.env, 'token-jti-123', 3600, undefined, 'tenant1');
      expect(c.body).toHaveBeenCalledWith(null, 200);
    });

    it('should return 200 for invalid token (per RFC 7009)', async () => {
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

      await revokeHandler(c);

      // Per RFC 7009: Return 200 even for invalid token to prevent token scanning
      expect(c.body).toHaveBeenCalledWith(null, 200);
    });

    it('should return 200 when token has no JTI (per RFC 7009)', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'token.without.jti',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue({
        // No 'jti' field
        client_id: 'client-123',
      });

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await revokeHandler(c);

      // Should return success without trying to revoke
      expect(c.body).toHaveBeenCalledWith(null, 200);
    });

    it('should return 200 when client tries to revoke another client token (per RFC 7009)', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'other.client.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue({
        jti: 'token-jti-123',
        client_id: 'other-client-456', // Different client
      });

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await revokeHandler(c);

      // Per RFC 7009: Return success even if client doesn't own the token
      // (prevents information disclosure)
      expect(c.body).toHaveBeenCalledWith(null, 200);
    });
  });

  describe('Token Type Hint Handling', () => {
    it('should revoke refresh token when token_type_hint is refresh_token', async () => {
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
      vi.mocked(parseToken).mockReturnValue({
        jti: 'refresh-token-jti',
        client_id: 'client-123',
      });

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await revokeHandler(c);

      expect(deleteRefreshToken).toHaveBeenCalledWith(
        c.env,
        'refresh-token-jti',
        'client-123',
        'tenant1'
      );
      expect(c.body).toHaveBeenCalledWith(null, 200);
    });

    it('should revoke access token when token_type_hint is access_token', async () => {
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
      vi.mocked(parseToken).mockReturnValue({
        jti: 'access-token-jti',
        client_id: 'client-123',
      });

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await revokeHandler(c);

      expect(revokeToken).toHaveBeenCalledWith(
        c.env,
        'access-token-jti',
        3600,
        undefined,
        'tenant1'
      );
      expect(c.body).toHaveBeenCalledWith(null, 200);
    });

    it('should try both token types when token_type_hint is not provided', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'unknown.token.type',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      // V2: Must include sub (userId) for getRefreshToken to be called
      vi.mocked(parseToken).mockReturnValue({
        jti: 'token-jti-123',
        client_id: 'client-123',
        sub: 'user-123',
        rtv: 1,
      });
      vi.mocked(getRefreshToken).mockResolvedValue({
        familyId: 'family-123',
        tokenId: 'token-jti-123',
      } as any);

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await revokeHandler(c);

      // Should check if it's a refresh token first
      expect(getRefreshToken).toHaveBeenCalled();
      // Since it's a refresh token, should delete it
      expect(deleteRefreshToken).toHaveBeenCalled();
      expect(c.body).toHaveBeenCalledWith(null, 200);
    });

    it('should treat as access token when not found as refresh token', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'access.token.value',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      // V2: Must include sub (userId) for getRefreshToken to be called
      vi.mocked(parseToken).mockReturnValue({
        jti: 'token-jti-123',
        client_id: 'client-123',
        sub: 'user-123',
        rtv: 1,
      });
      vi.mocked(getRefreshToken).mockResolvedValue(null); // Not a refresh token

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await revokeHandler(c);

      expect(getRefreshToken).toHaveBeenCalled();
      expect(revokeToken).toHaveBeenCalled(); // Treated as access token
      expect(c.body).toHaveBeenCalledWith(null, 200);
    });
  });

  describe('Security - Information Disclosure Prevention', () => {
    it('should return same response for valid and invalid tokens', async () => {
      const validTokenContext = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      const invalidTokenContext = createMockContext({
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

      // Setup for valid token
      vi.mocked(parseToken).mockReturnValueOnce({
        jti: 'token-jti-123',
        client_id: 'client-123',
      });

      // Setup for invalid token
      vi.mocked(parseToken).mockImplementationOnce(() => {
        throw new Error('Invalid token');
      });

      // Both contexts use the same mock repository
      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await revokeHandler(validTokenContext);
      await revokeHandler(invalidTokenContext);

      // Both should return 200 with null body
      expect(validTokenContext.body).toHaveBeenCalledWith(null, 200);
      expect(invalidTokenContext.body).toHaveBeenCalledWith(null, 200);
    });

    it('should not reveal token ownership through response', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'other.client.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue({
        jti: 'token-jti-123',
        client_id: 'other-client', // Token belongs to different client
      });

      mockClientRepository.findByClientId.mockResolvedValue({
        client_id: 'client-123',
        client_secret_hash: 'hash_client-secret',
      });

      await revokeHandler(c);

      // Should return success (not reveal that token belongs to different client)
      expect(c.body).toHaveBeenCalledWith(null, 200);
    });
  });

  describe('Device Secret Revocation', () => {
    it('allows native public clients to revoke a presented device_secret', async () => {
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

      await revokeHandler(c);

      expect(mockDeviceSecretRepository.findByRawSecret).toHaveBeenCalledWith(
        'raw-device-secret',
        'tenant1'
      );
      expect(mockDeviceSecretRepository.revoke).toHaveBeenCalledWith('ds-001', 'logout', 'tenant1');
      expect(c.body).toHaveBeenCalledWith(null, 200);
    });

    it('denies native public clients from revoking cross-client device_secrets', async () => {
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
      mockDeviceSecretRepository.findByRawSecret.mockResolvedValue({
        id: 'ds-001',
        installation_id: 'inst-001',
        tenant_id: 'default',
        client_id: 'other-native-client',
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

      const response = await revokeHandler(c);
      const body = (await response.json()) as {
        error: string;
        error_details?: { code?: string };
      };

      expect(response.status).toBe(403);
      expect(body.error).toBe('access_denied');
      expect(body.error_details?.code).toBe('revoke_disabled');
      expect(mockDeviceSecretRepository.revoke).not.toHaveBeenCalled();
    });

    it('denies confidential client device_secret revoke unless explicitly enabled by policy', async () => {
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
        installation_id: 'inst-001',
        tenant_id: 'default',
        client_id: 'client-123',
        user_id: 'user-123',
        session_id: 'sid-123',
        secret_hash: 'hash',
        created_at: Date.now() - 60_000,
        updated_at: Date.now() - 60_000,
        expires_at: Date.now() + 3_600_000,
        use_count: 1,
        is_active: 1,
      });

      const response = await revokeHandler(c);
      const body = (await response.json()) as {
        error: string;
        error_details?: { code?: string };
      };

      expect(response.status).toBe(403);
      expect(body.error).toBe('access_denied');
      expect(body.error_details?.code).toBe('revoke_disabled');
      expect(mockDeviceSecretRepository.revoke).not.toHaveBeenCalled();
    });

    it('allows confidential client device_secret revoke when policy opt-in is present', async () => {
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
        device_secret_revoke_enabled: true,
      });
      mockDeviceSecretRepository.findByRawSecret.mockResolvedValue({
        id: 'ds-001',
        installation_id: 'inst-001',
        tenant_id: 'default',
        client_id: 'client-123',
        user_id: 'user-123',
        session_id: 'sid-123',
        secret_hash: 'hash',
        created_at: Date.now() - 60_000,
        updated_at: Date.now() - 60_000,
        expires_at: Date.now() + 3_600_000,
        use_count: 1,
        is_active: 1,
      });

      await revokeHandler(c);

      expect(mockDeviceSecretRepository.revoke).toHaveBeenCalledWith(
        'ds-001',
        'token_revocation',
        'tenant1'
      );
      expect(c.body).toHaveBeenCalledWith(null, 200);
    });

    it('denies confidential cross-client revoke without trust-group allowlist', async () => {
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
        device_secret_revoke_enabled: true,
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

      const response = await revokeHandler(c);
      const body = (await response.json()) as {
        error: string;
        error_details?: { code?: string };
      };

      expect(response.status).toBe(403);
      expect(body.error_details?.code).toBe('revoke_disabled');
      expect(mockDeviceSecretRepository.revoke).not.toHaveBeenCalled();
    });

    it('allows confidential cross-client revoke with trust-group allowlist', async () => {
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
        device_secret_revoke_trust_groups: ['wallet-suite'],
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

      await revokeHandler(c);

      expect(mockDeviceSecretRepository.revoke).toHaveBeenCalledWith(
        'ds-001',
        'token_revocation',
        'tenant1'
      );
      expect(c.body).toHaveBeenCalledWith(null, 200);
    });

    it('treats unknown device_secret revoke as success', async () => {
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
      mockDeviceSecretRepository.findByRawSecret.mockResolvedValue(null);

      await revokeHandler(c);

      expect(c.body).toHaveBeenCalledWith(null, 200);
      expect(mockDeviceSecretRepository.revoke).not.toHaveBeenCalled();
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

      const response = await revokeHandler(c);

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; error_description?: string };
      expect(body.error).toBe('invalid_request');
      // AR_ERROR_CODES.VALIDATION_INVALID_VALUE uses standardized message
      expect(body.error_description).toContain('invalid');
    });
  });
});
