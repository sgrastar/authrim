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
  mockCreateAccountAuthContextFromHono,
  mockResolveAccountDataContextFromHono,
  mockInvalidateConsentCache,
  mockRevokeToken,
  mockPublishEvent,
  mockCoreAdapter,
  mockTenantMetadataAdapter,
  mockLogger,
  mockGetLogger,
} = vi.hoisted(() => {
  // Consents live in the user's account database; the tenant metadata database holds clients.
  const adapterShape = () => ({
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn(() => 'mock'),
    close: vi.fn(),
  });
  const coreAdapter = adapterShape();
  const tenantMetadataAdapter = adapterShape();
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
      coreAdapter: tenantMetadataAdapter,
    }),
    mockCreateAccountAuthContextFromHono: vi.fn().mockReturnValue({
      coreAdapter,
    }),
    mockResolveAccountDataContextFromHono: vi.fn(),
    mockInvalidateConsentCache: vi.fn(),
    mockRevokeToken: vi.fn(),
    mockPublishEvent: vi.fn().mockResolvedValue(undefined),
    mockCoreAdapter: coreAdapter,
    mockTenantMetadataAdapter: tenantMetadataAdapter,
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
    createAccountAuthContextFromHono: mockCreateAccountAuthContextFromHono,
    resolveAccountDataContextFromHono: mockResolveAccountDataContextFromHono,
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
import { DatabaseSync } from './test-sqlite';

type SqlValue = string | number | null;

// A sharded session id (generation:region:shard:session_...) as the login issues them.
const SESSION_ID = 'g1:apac:0:session_0123456789abcdefghijkl';

/** An executable database holding the consent and refresh-token family index tables. */
function createConsentDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE oauth_client_consents (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      granted_at INTEGER NOT NULL,
      UNIQUE (tenant_id, user_id, client_id)
    );
    CREATE TABLE consent_history (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      action TEXT NOT NULL,
      scopes_before TEXT,
      scopes_after TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE oauth_client_consent_revocations (
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0,
      revoked_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, user_id, client_id)
    );
    CREATE TABLE user_token_families (
      jti TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      is_revoked INTEGER DEFAULT 0
    );
  `);
  const values = (params: unknown[] = []) => params as SqlValue[];
  const adapter = {
    query: vi.fn(async (sql: string, params?: unknown[]) => db.prepare(sql).all(...values(params))),
    queryOne: vi.fn(
      async (sql: string, params?: unknown[]) => db.prepare(sql).get(...values(params)) ?? null
    ),
    execute: vi.fn(async (sql: string, params?: unknown[]) => ({
      success: true,
      rowsAffected: Number(db.prepare(sql).run(...values(params)).changes),
    })),
    transaction: vi.fn(),
    // All or nothing, as a D1 batch.
    batch: vi.fn(async (statements: Array<{ sql: string; params?: unknown[] }>) => {
      db.exec('BEGIN');
      try {
        const results = statements.map((statement) => ({
          success: true,
          rowsAffected: Number(db.prepare(statement.sql).run(...values(statement.params)).changes),
        }));
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }),
    isHealthy: vi.fn(),
    getType: vi.fn(() => 'sqlite'),
    close: vi.fn(),
  };
  const rows = (sql: string) => db.prepare(sql).all();
  return {
    db,
    adapter,
    consents: () => rows('SELECT client_id FROM oauth_client_consents ORDER BY client_id'),
    history: () => rows('SELECT client_id, action FROM consent_history'),
    revokedFamilies: () =>
      rows('SELECT jti FROM user_token_families WHERE is_revoked = 1 ORDER BY jti'),
    withdrawals: () =>
      rows('SELECT client_id, revoked_at FROM oauth_client_consent_revocations') as Array<{
        client_id: string;
        revoked_at: number;
      }>,
    generation: () =>
      (
        db.prepare('SELECT generation FROM oauth_client_consent_revocations').get() as
          | { generation: number }
          | undefined
      )?.generation ?? 0,
    seedConsent(clientId: string) {
      db.prepare(
        `INSERT INTO oauth_client_consents (id, tenant_id, user_id, client_id, scope, granted_at)
         VALUES (?, 'default', 'user-123', ?, 'openid offline_access', 1700000000000)`
      ).run(`consent-${clientId}`, clientId);
    },
    seedFamily(jti: string, clientId: string) {
      db.prepare(
        `INSERT INTO user_token_families (jti, tenant_id, user_id, client_id, generation, expires_at)
         VALUES (?, 'default', 'user-123', ?, 1, ?)`
      ).run(jti, clientId, Date.now() + 3_600_000);
    },
  };
}

/** RefreshTokenRotator namespace recording which instances revoked which user's family. */
function createRotatorNamespace(revokeFamilyRpc = vi.fn().mockResolvedValue(undefined)) {
  const revokedInstances: string[] = [];
  return {
    revokeFamilyRpc,
    revokedInstances,
    namespace: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn((name: string) => ({
        revokeFamilyRpc: async (userId: string, reason?: string) => {
          await revokeFamilyRpc(userId, reason);
          revokedInstances.push(name);
        },
      })),
    },
  };
}

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
    header: vi.fn(),
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
    mockTenantMetadataAdapter.query.mockReset().mockResolvedValue([]);
    mockTenantMetadataAdapter.execute.mockReset();
    mockCreateAuthContextFromHono
      .mockReset()
      .mockReturnValue({ coreAdapter: mockTenantMetadataAdapter });
    mockCreateAccountAuthContextFromHono
      .mockReset()
      .mockReturnValue({ coreAdapter: mockCoreAdapter });
    mockResolveAccountDataContextFromHono.mockReset().mockResolvedValue({
      tenantId: 'default',
      accountId: 'user-123',
    });
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

    it('should authenticate with the authrim_session cookie', async () => {
      const mockSessionStore = {
        getSessionRpc: vi.fn().mockResolvedValue({
          id: SESSION_ID,
          userId: 'user-456',
          tenantId: 'default',
          expiresAt: Date.now() + 60_000,
        }),
      };
      mockGetSessionStoreBySessionId.mockReturnValue({ stub: mockSessionStore });
      mockCoreAdapter.query.mockResolvedValue([]);

      const c = createMockContext({
        cookies: { authrim_session: SESSION_ID },
      });

      const response = await userConsentsListHandler(c);
      expect(response.status).toBe(200);
      expect(mockSessionStore.getSessionRpc).toHaveBeenCalledWith(SESSION_ID);
      expect(mockResolveAccountDataContextFromHono).toHaveBeenCalledWith(c, 'user-456');
    });

    it.each([
      ['an expired session', { userId: 'user-456', tenantId: 'default', expiresAt: 1 }],
      [
        'a session of another tenant',
        { userId: 'user-456', tenantId: 'other', expiresAt: Date.now() + 60_000 },
      ],
      ['an unknown session', null],
    ])('should reject %s', async (_label, stored) => {
      mockGetSessionStoreBySessionId.mockReturnValue({
        stub: { getSessionRpc: vi.fn().mockResolvedValue(stored) },
      });

      const response = await userConsentsListHandler(
        createMockContext({ cookies: { authrim_session: SESSION_ID } })
      );

      expect(response.status).toBe(401);
    });

    it('should not accept the legacy sid cookie', async () => {
      const getSessionRpc = vi.fn();
      mockGetSessionStoreBySessionId.mockReturnValue({ stub: { getSessionRpc } });

      const response = await userConsentsListHandler(
        createMockContext({ cookies: { sid: SESSION_ID } })
      );

      expect(response.status).toBe(401);
      expect(getSessionRpc).not.toHaveBeenCalled();
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
        },
      ]);
      mockTenantMetadataAdapter.query.mockResolvedValue([
        {
          client_id: 'client-abc',
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

    it('reads consents from the account database and client names from tenant metadata', async () => {
      mockCoreAdapter.query.mockResolvedValue([
        {
          id: 'consent-routed',
          client_id: 'client-routed',
          scope: 'openid',
          selected_scopes: null,
          granted_at: 1700000000000,
          expires_at: null,
          privacy_policy_version: null,
          tos_version: null,
          consent_version: 1,
        },
      ]);
      mockTenantMetadataAdapter.query.mockResolvedValue([
        { client_id: 'client-routed', client_name: 'Routed Client', logo_uri: null },
      ]);

      const response = await userConsentsListHandler(
        createMockContext({ headers: { Authorization: 'Bearer token' } })
      );
      const body = (await response.json()) as { consents: Array<Record<string, unknown>> };

      expect(response.status).toBe(200);
      expect(mockResolveAccountDataContextFromHono).toHaveBeenCalledWith(
        expect.anything(),
        'user-123'
      );
      expect(body.consents).toEqual([
        expect.objectContaining({ clientId: 'client-routed', clientName: 'Routed Client' }),
      ]);
      expect(mockCoreAdapter.query).toHaveBeenCalledWith(
        expect.stringContaining('FROM oauth_client_consents'),
        ['default', 'user-123']
      );
      expect(mockTenantMetadataAdapter.query).not.toHaveBeenCalledWith(
        expect.stringContaining('oauth_client_consents'),
        expect.anything()
      );
    });

    it('returns no consents for a user without an account route', async () => {
      mockResolveAccountDataContextFromHono.mockRejectedValue(
        new Error('account_data_route_not_found')
      );

      const response = await userConsentsListHandler(
        createMockContext({ headers: { Authorization: 'Bearer token' } })
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ consents: [], total: 0 });
      expect(mockCoreAdapter.query).not.toHaveBeenCalled();
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
      // The user has the consent and no refresh-token families.
      const account = createConsentDatabase();
      account.seedConsent('client-abc');
      mockCreateAccountAuthContextFromHono.mockReturnValueOnce({ coreAdapter: account.adapter });

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

      // The consent and its history are written in the user's account database only.
      expect(mockResolveAccountDataContextFromHono).toHaveBeenCalledWith(
        expect.anything(),
        'user-123'
      );
      expect(mockTenantMetadataAdapter.query).not.toHaveBeenCalled();
      expect(mockTenantMetadataAdapter.execute).not.toHaveBeenCalled();
      expect(account.consents()).toEqual([]);
      expect(account.history()).toEqual([{ client_id: 'client-abc', action: 'revoked' }]);
      expect(account.withdrawals()).toEqual([
        { client_id: 'client-abc', revoked_at: body.revokedAt },
      ]);

      // Verify cache invalidation
      expect(mockInvalidateConsentCache).toHaveBeenCalledWith(
        expect.anything(),
        'user-123',
        'default',
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

    it('changes nothing and fails when the withdrawal cannot be recorded', async () => {
      const account = createConsentDatabase();
      account.seedConsent('client-abc');
      account.seedFamily('g1:wnam:3:rt_abc1', 'client-abc');
      account.db.exec('DROP TABLE oauth_client_consent_revocations');
      mockCreateAccountAuthContextFromHono.mockReturnValueOnce({ coreAdapter: account.adapter });
      const rotator = createRotatorNamespace();

      const response = await userConsentRevokeHandler(
        createMockContext({
          method: 'DELETE',
          headers: { Authorization: 'Bearer token' },
          params: { clientId: 'client-abc' },
          env: { REFRESH_TOKEN_ROTATOR: rotator.namespace as never },
        })
      );

      expect(response.status).toBe(500);
      expect(rotator.revokeFamilyRpc).not.toHaveBeenCalled();
      expect(account.consents()).toEqual([{ client_id: 'client-abc' }]);
      expect(account.revokedFamilies()).toEqual([]);
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

    it('returns 404 for a user without an account route', async () => {
      mockResolveAccountDataContextFromHono.mockRejectedValue(
        new Error('account_data_route_not_found')
      );

      const response = await userConsentRevokeHandler(
        createMockContext({
          method: 'DELETE',
          headers: { Authorization: 'Bearer token' },
          params: { clientId: 'client-abc' },
        })
      );

      expect(response.status).toBe(404);
      expect(mockCoreAdapter.execute).not.toHaveBeenCalled();
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

    it("revokes the client's refresh-token families in the account database, then the consent", async () => {
      const account = createConsentDatabase();
      const metadata = createConsentDatabase();
      account.seedConsent('client-abc');
      account.seedConsent('client-other');
      account.seedFamily('g1:wnam:3:rt_abc1', 'client-abc');
      account.seedFamily('g1:wnam:5:rt_abc2', 'client-abc');
      account.seedFamily('g1:wnam:3:rt_other', 'client-other');
      mockCreateAccountAuthContextFromHono.mockReturnValueOnce({ coreAdapter: account.adapter });
      mockCreateAuthContextFromHono.mockReturnValue({ coreAdapter: metadata.adapter });
      // The withdrawal is recorded, and the consent still there, while the families are revoked.
      let withdrawnDuringRevocation: number | undefined;
      let generationDuringRevocation: number | undefined;
      const rotator = createRotatorNamespace(
        vi.fn(async () => {
          expect(account.consents()).toContainEqual({ client_id: 'client-abc' });
          withdrawnDuringRevocation = account.withdrawals()[0]?.revoked_at;
          generationDuringRevocation = account.generation();
        })
      );

      const response = await userConsentRevokeHandler(
        createMockContext({
          method: 'DELETE',
          headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
          params: { clientId: 'client-abc' },
          // Withdrawing the grant ends its refresh tokens whatever the caller asks.
          body: { revoke_tokens: false },
          env: { REFRESH_TOKEN_ROTATOR: rotator.namespace as never },
        })
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, refreshTokensRevoked: 2 });
      expect(rotator.revokeFamilyRpc).toHaveBeenCalledTimes(2);
      expect(rotator.revokeFamilyRpc).toHaveBeenCalledWith('user-123', 'consent_revoked');
      expect(rotator.revokedInstances.sort()).toEqual([
        'tenant:default:refresh-rotator:client-abc:v1:shard-3',
        'tenant:default:refresh-rotator:client-abc:v1:shard-5',
      ]);
      expect(account.revokedFamilies()).toEqual([
        { jti: 'g1:wnam:3:rt_abc1' },
        { jti: 'g1:wnam:5:rt_abc2' },
      ]);
      expect(account.consents()).toEqual([{ client_id: 'client-other' }]);
      expect(account.history()).toEqual([{ client_id: 'client-abc', action: 'revoked' }]);
      // Recorded first, then moved on to when the consent was deleted.
      expect(withdrawnDuringRevocation).toEqual(expect.any(Number));
      const [withdrawal] = account.withdrawals();
      expect(withdrawal.client_id).toBe('client-abc');
      expect(withdrawal.revoked_at).toBeGreaterThanOrEqual(withdrawnDuringRevocation!);
      // The generation moved on before the families were revoked and again with the deletion.
      expect(generationDuringRevocation).toBe(1);
      expect(account.generation()).toBe(2);
      expect(metadata.adapter.query).not.toHaveBeenCalled();
      expect(metadata.adapter.execute).not.toHaveBeenCalled();
      // No unread consent_revoked marker is written any more.
      expect(mockRevokeToken).not.toHaveBeenCalled();
    });

    it('keeps the consent and fails when a refresh-token family cannot be revoked', async () => {
      const account = createConsentDatabase();
      account.seedConsent('client-abc');
      account.seedFamily('g1:wnam:3:rt_abc1', 'client-abc');
      mockCreateAccountAuthContextFromHono.mockReturnValueOnce({ coreAdapter: account.adapter });
      const rotator = createRotatorNamespace(
        vi.fn().mockRejectedValue(new Error('rotator unavailable'))
      );

      const response = await userConsentRevokeHandler(
        createMockContext({
          method: 'DELETE',
          headers: { Authorization: 'Bearer token' },
          params: { clientId: 'client-abc' },
          env: { REFRESH_TOKEN_ROTATOR: rotator.namespace as never },
        })
      );

      expect(response.status).toBe(500);
      expect(account.consents()).toEqual([{ client_id: 'client-abc' }]);
      expect(account.history()).toEqual([]);
      expect(account.revokedFamilies()).toEqual([]);
      // The recorded withdrawal already refuses the family that survived; a retry completes it.
      expect(account.withdrawals()).toEqual([
        { client_id: 'client-abc', revoked_at: expect.any(Number) },
      ]);
      expect(mockInvalidateConsentCache).not.toHaveBeenCalled();
      expect(mockPublishEvent).not.toHaveBeenCalled();
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
