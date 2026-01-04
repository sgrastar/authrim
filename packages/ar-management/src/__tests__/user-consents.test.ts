/**
 * User Consent Management API Tests
 *
 * Tests for user consent listing and revocation endpoints.
 * Covers both Bearer token and session-based authentication.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

// Hoist mock functions
const {
  mockIntrospectTokenFromContext,
  mockGetSessionStoreBySessionId,
  mockGetTenantIdFromContext,
  mockCreateAuthContextFromHono,
  mockInvalidateConsentCache,
  mockRevokeToken,
  mockPublishEvent,
  mockCoreAdapter,
  mockLogger,
  mockGetLogger,
} = vi.hoisted(() => {
  const coreAdapter = {
    query: vi.fn(),
    execute: vi.fn(),
  };
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    module: vi.fn().mockReturnThis(),
  };
  return {
    mockIntrospectTokenFromContext: vi.fn(),
    mockGetSessionStoreBySessionId: vi.fn(),
    mockGetTenantIdFromContext: vi.fn().mockReturnValue('default'),
    mockCreateAuthContextFromHono: vi.fn().mockReturnValue({
      coreAdapter,
    }),
    mockInvalidateConsentCache: vi.fn(),
    mockRevokeToken: vi.fn(),
    mockPublishEvent: vi.fn().mockResolvedValue(undefined),
    mockCoreAdapter: coreAdapter,
    mockLogger: logger,
    mockGetLogger: vi.fn().mockReturnValue(logger),
  };
});

// Mock the shared module
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    introspectTokenFromContext: mockIntrospectTokenFromContext,
    getSessionStoreBySessionId: mockGetSessionStoreBySessionId,
    getTenantIdFromContext: mockGetTenantIdFromContext,
    createAuthContextFromHono: mockCreateAuthContextFromHono,
    invalidateConsentCache: mockInvalidateConsentCache,
    revokeToken: mockRevokeToken,
    publishEvent: mockPublishEvent,
    getLogger: mockGetLogger,
  };
});

// Mock hono/cookie
vi.mock('hono/cookie', () => ({
  getCookie: vi.fn(),
}));

import { userConsentsListHandler, userConsentRevokeHandler } from '../user-consents';
import { getCookie } from 'hono/cookie';

/**
 * Helper to create mock context
 */
function createMockContext(options: {
  method?: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  params?: Record<string, string>;
  body?: Record<string, unknown>;
  env?: Partial<Env>;
}) {
  const mockEnv: Partial<Env> = {
    ISSUER_URL: 'https://op.example.com',
    ...options.env,
  };

  // Setup getCookie mock
  vi.mocked(getCookie).mockImplementation((_c, name) => {
    return options.cookies?.[name] ?? undefined;
  });

  const c = {
    req: {
      header: (name: string) => options.headers?.[name],
      method: options.method || 'GET',
      param: (name: string) => options.params?.[name],
      json: vi.fn().mockResolvedValue(options.body || {}),
    },
    env: mockEnv as Env,
    get: (key: string) => {
      if (key === 'logger') return mockLogger;
      return undefined;
    },
    json: vi.fn((body, status = 200) => {
      const response = new Response(JSON.stringify(body), { status });
      return response;
    }),
  } as any;

  return c;
}

describe('User Consents API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset crypto.randomUUID mock
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('test-uuid-12345');
    // Reset adapter mocks
    mockCoreAdapter.query.mockReset();
    mockCoreAdapter.execute.mockReset();
    // Reset auth mocks
    mockIntrospectTokenFromContext.mockReset();
    mockGetSessionStoreBySessionId.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication', () => {
    it('should authenticate with Bearer token', async () => {
      mockIntrospectTokenFromContext.mockResolvedValue({
        valid: true,
        claims: { sub: 'user-123' },
      });
      mockCoreAdapter.query.mockResolvedValue([]);

      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      const response = await userConsentsListHandler(c);
      expect(response.status).toBe(200);
      expect(mockIntrospectTokenFromContext).toHaveBeenCalled();
    });

    it('should authenticate with session cookie', async () => {
      const mockSessionStore = {
        fetch: vi
          .fn()
          .mockResolvedValue(new Response(JSON.stringify({ userId: 'user-456' }), { status: 200 })),
      };
      mockGetSessionStoreBySessionId.mockReturnValue({ stub: mockSessionStore });
      mockCoreAdapter.query.mockResolvedValue([]);

      const c = createMockContext({
        cookies: { sid: 'session-id-123' },
      });

      const response = await userConsentsListHandler(c);
      expect(response.status).toBe(200);
      expect(mockGetSessionStoreBySessionId).toHaveBeenCalled();
    });

    it('should reject request without authentication', async () => {
      const c = createMockContext({});

      const response = await userConsentsListHandler(c);
      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body).toEqual({
        error: 'unauthorized',
        error_description: 'Authentication required',
      });
    });

    it('should reject invalid Bearer token', async () => {
      mockIntrospectTokenFromContext.mockResolvedValue({
        valid: false,
        claims: null,
      });

      const c = createMockContext({
        headers: { Authorization: 'Bearer invalid-token' },
      });

      const response = await userConsentsListHandler(c);
      expect(response.status).toBe(401);
    });
  });

  describe('userConsentsListHandler', () => {
    beforeEach(() => {
      mockIntrospectTokenFromContext.mockResolvedValue({
        valid: true,
        claims: { sub: 'user-123' },
      });
    });

    it('should return empty list when no consents exist', async () => {
      mockCoreAdapter.query.mockResolvedValue([]);

      const c = createMockContext({
        headers: { Authorization: 'Bearer token' },
      });

      const response = await userConsentsListHandler(c);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toEqual({
        consents: [],
        total: 0,
      });
    });

    it('should return list of consents', async () => {
      mockCoreAdapter.query.mockResolvedValue([
        {
          id: 'consent-1',
          client_id: 'client-abc',
          scope: 'openid profile email',
          selected_scopes: JSON.stringify(['openid', 'profile']),
          granted_at: 1700000000000,
          expires_at: null,
          privacy_policy_version: 'v1.0.0',
          tos_version: 'v1.5.0',
          consent_version: 2,
          client_name: 'Test Client',
          logo_uri: 'https://example.com/logo.png',
        },
      ]);

      const c = createMockContext({
        headers: { Authorization: 'Bearer token' },
      });

      const response = await userConsentsListHandler(c);
      expect(response.status).toBe(200);

      const body = (await response.json()) as { total: number; consents: unknown[] };
      expect(body.total).toBe(1);
      expect(body.consents[0]).toEqual({
        id: 'consent-1',
        clientId: 'client-abc',
        clientName: 'Test Client',
        clientLogoUri: 'https://example.com/logo.png',
        scopes: ['openid', 'profile', 'email'],
        selectedScopes: ['openid', 'profile'],
        grantedAt: 1700000000000,
        expiresAt: undefined,
        policyVersions: {
          privacyPolicyVersion: 'v1.0.0',
          tosVersion: 'v1.5.0',
          consentVersion: 2,
        },
      });
    });

    it('should handle consents without policy versions', async () => {
      mockCoreAdapter.query.mockResolvedValue([
        {
          id: 'consent-2',
          client_id: 'client-xyz',
          scope: 'openid',
          selected_scopes: null,
          granted_at: 1700000000000,
          expires_at: 1800000000000,
          privacy_policy_version: null,
          tos_version: null,
          consent_version: null,
          client_name: null,
          logo_uri: null,
        },
      ]);

      const c = createMockContext({
        headers: { Authorization: 'Bearer token' },
      });

      const response = await userConsentsListHandler(c);
      const body = (await response.json()) as { consents: Array<Record<string, unknown>> };

      expect(body.consents[0].policyVersions).toBeUndefined();
      expect(body.consents[0].selectedScopes).toBeUndefined();
      expect(body.consents[0].expiresAt).toBe(1800000000000);
    });
  });

  describe('userConsentRevokeHandler', () => {
    beforeEach(() => {
      mockIntrospectTokenFromContext.mockResolvedValue({
        valid: true,
        claims: { sub: 'user-123' },
      });
    });

    it('should revoke consent successfully', async () => {
      // Mock finding existing consent
      mockCoreAdapter.query.mockResolvedValue([
        { id: 'consent-1', scope: 'openid profile', granted_at: 1700000000000 },
      ]);
      mockCoreAdapter.execute.mockResolvedValue(undefined);

      const c = createMockContext({
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' },
        params: { clientId: 'client-abc' },
      });

      const response = await userConsentRevokeHandler(c);
      expect(response.status).toBe(200);

      const body = (await response.json()) as { success: boolean; revokedAt: number };
      expect(body.success).toBe(true);
      expect(body.revokedAt).toBeDefined();

      // Verify DELETE was called
      expect(mockCoreAdapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM oauth_client_consents'),
        expect.arrayContaining(['user-123', 'client-abc', 'default'])
      );

      // Verify history was recorded (revoked is in SQL string, not params)
      expect(mockCoreAdapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO consent_history'),
        expect.arrayContaining(['user-123', 'client-abc'])
      );

      // Verify cache invalidation
      expect(mockInvalidateConsentCache).toHaveBeenCalledWith(
        expect.anything(),
        'user-123',
        'client-abc'
      );

      // Verify event was published
      expect(mockPublishEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          type: 'consent.revoked',
          data: expect.objectContaining({
            userId: 'user-123',
            clientId: 'client-abc',
          }),
        })
      );
    });

    it('should return 404 if consent not found', async () => {
      mockCoreAdapter.query.mockResolvedValue([]);

      const c = createMockContext({
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' },
        params: { clientId: 'nonexistent-client' },
      });

      const response = await userConsentRevokeHandler(c);
      expect(response.status).toBe(404);

      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('not_found');
    });

    it('should return 400 if clientId is missing', async () => {
      const c = createMockContext({
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' },
        params: {}, // No clientId
      });

      const response = await userConsentRevokeHandler(c);
      expect(response.status).toBe(400);

      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('invalid_request');
    });

    it('should handle revoke_tokens option from body', async () => {
      mockCoreAdapter.query.mockResolvedValue([
        { id: 'consent-1', scope: 'openid', granted_at: 1700000000000 },
      ]);
      mockCoreAdapter.execute.mockResolvedValue(undefined);

      const c = createMockContext({
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer token',
          'Content-Type': 'application/json',
        },
        params: { clientId: 'client-abc' },
        body: { revoke_tokens: false },
      });

      const response = await userConsentRevokeHandler(c);
      expect(response.status).toBe(200);

      // Token revocation should NOT be called when revoke_tokens=false
      expect(mockRevokeToken).not.toHaveBeenCalled();
    });

    it('should require authentication', async () => {
      mockIntrospectTokenFromContext.mockResolvedValue({
        valid: false,
        claims: null,
      });

      const c = createMockContext({
        method: 'DELETE',
        headers: { Authorization: 'Bearer invalid' },
        params: { clientId: 'client-abc' },
      });

      const response = await userConsentRevokeHandler(c);
      expect(response.status).toBe(401);
    });
  });
});
