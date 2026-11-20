/**
 * Test environment for the authorization endpoint (authorize.ts): in-memory KV, D1, Durable
 * Objects and a Hono app with the tenant context set. The tests mock '@authrim/ar-lib-core'
 * themselves (getClient / getClientCached) and pass that mock here.
 */
import { vi } from 'vitest';
import { Hono } from 'hono';
import { buildPolicyConstrainedRegionShardConfig } from '@authrim/ar-lib-core';
import type { Env } from '@authrim/ar-lib-core/types/env';
import { systemSettingsPlatformDocuments } from '@authrim/ar-lib-core/utils/system-settings-fields';
import { authorizeHandler } from '../../authorize';

export const TEST_REGION_CONFIG = buildPolicyConstrainedRegionShardConfig({
  residency: {
    version: 1,
    residencyPolicyId: 'test-residency',
    residencyPartition: 'default',
    policyGeneration: 1,
    allowedRegions: ['apac'],
    jurisdiction: null,
  },
  totalShards: 1,
  now: 1,
  updatedBy: 'test',
});

export const SESSION_ID = 'g1:apac:3:session_test-session';

export class MockKVNamespace {
  private store: Map<string, string> = new Map();

  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) this.store.set(key, value);
  }

  async get<T = string>(key: string, options?: { type?: string }): Promise<T | null> {
    const value = this.store.get(key);
    if (value === undefined) return null;
    return (options?.type === 'json' ? JSON.parse(value) : value) as T;
  }

  async put(key: string, value: string, _options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  // Helper method for testing
  async getAll(): Promise<Map<string, string>> {
    return this.store;
  }
}

export function createMockDB() {
  const trustPolicies = new Map<string, Record<string, unknown>>();
  // The bridge's external providers (`upstream_providers`), answered as the query asks for them:
  // the tenant's enabled rows, in order, up to the limit. `failure` makes the read throw.
  const upstreamProviders = {
    rows: [] as Array<Record<string, unknown>>,
    failure: false,
  };
  const prepare = vi.fn((sql: string) => {
    let boundParams: unknown[] = [];
    const statement = {
      bind: vi.fn((...params: unknown[]) => {
        boundParams = params;
        return statement;
      }),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn(async () => {
        if (sql.includes('FROM client_trust_policies')) {
          const [tenantId, targetType, targetId] = boundParams.map(String);
          const policy = trustPolicies.get(`${tenantId}:${targetType}:${targetId}`);
          return { results: policy ? [policy] : [] };
        }
        if (sql.includes('FROM upstream_providers')) {
          if (upstreamProviders.failure) throw new Error('D1 unavailable');
          const [tenantId, limit] = boundParams;
          return {
            results: upstreamProviders.rows
              .filter((row) => row.tenant_id === tenantId && row.enabled === 1)
              .slice(0, Number(limit)),
          };
        }
        return { results: [] };
      }),
      // D1 reports the rows a write changed.
      run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
    };
    return statement;
  });

  return {
    prepare,
    // A batch reports the rows each statement changed (the consent write and its history).
    batch: vi.fn(async (statements: unknown[]) =>
      statements.map(() => ({ success: true, meta: { changes: 1 } }))
    ),
    _trustPolicies: trustPolicies,
    _upstreamProviders: upstreamProviders,
  } as unknown as D1Database & {
    _trustPolicies: Map<string, Record<string, unknown>>;
    _upstreamProviders: typeof upstreamProviders;
  };
}

export function createMockAuthCodeStore() {
  const stub = {
    storeCodeRpc: vi.fn().mockResolvedValue({ success: true }),
    getCodeRpc: vi.fn().mockResolvedValue(null),
    consumeCodeRpc: vi.fn().mockResolvedValue(null),
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }))),
  };
  return {
    idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-auth-code-id' }),
    get: vi.fn().mockReturnValue(stub),
  };
}

export function createMockDO() {
  return {
    idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-do-id' }),
    get: vi.fn().mockReturnValue({
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }))),
    }),
  };
}

export function createMockPARRequestStore(request: Record<string, unknown>) {
  const storedRequest = {
    tenant_id: 'default',
    authorization_server: 'default',
    consumed: false,
    ...request,
  };
  const getRequestRpc = vi.fn().mockResolvedValue(storedRequest);
  const consumeRequestRpc = vi.fn().mockResolvedValue(storedRequest);

  return {
    idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-par-request-id' }),
    get: vi.fn().mockReturnValue({
      getRequestRpc,
      consumeRequestRpc,
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }))),
    }),
    _getRequestRpc: getRequestRpc,
    _consumeRequestRpc: consumeRequestRpc,
  };
}

export function createMockSessionStore() {
  type StoredSession = {
    id: string;
    userId: string;
    createdAt: number;
    expiresAt: number;
    data?: Record<string, unknown>;
  };
  const sessions = new Map<string, StoredSession>();
  const generatedSessionId = 'g1:apac:3:session_generated';

  return {
    idFromName: vi.fn().mockReturnValue({ toString: () => generatedSessionId }),
    get: vi.fn().mockReturnValue({
      getSessionRpc: vi.fn(async (sessionId: string) => sessions.get(sessionId) ?? null),
      createSessionRpc: vi
        .fn()
        .mockImplementation(
          async (sessionId: string, userId: string, ttl: number, data: Record<string, unknown>) => {
            sessions.set(sessionId, {
              id: sessionId,
              userId,
              createdAt: Date.now(),
              expiresAt: Date.now() + ttl * 1000,
              data,
            });
            return { id: sessionId };
          }
        ),
      updateSessionDataRpc: vi
        .fn()
        .mockImplementation(
          async (
            sessionId: string,
            updates: Record<string, unknown>,
            options?: { ifDataMatches?: Record<string, unknown> }
          ) => {
            const session = sessions.get(sessionId);
            if (!session) return null;
            const stale = Object.entries(options?.ifDataMatches ?? {}).some(
              ([field, value]) => JSON.stringify(session.data?.[field]) !== JSON.stringify(value)
            );
            if (!stale) session.data = { ...session.data, ...updates };
            return session;
          }
        ),
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }))),
    }),
    _sessions: sessions,
  };
}

export function createMockChallengeStore() {
  const challenges = new Map<string, Record<string, unknown>>();

  return {
    idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-challenge-store-id' }),
    get: vi.fn().mockReturnValue({
      // RPC methods
      storeChallengeRpc: vi.fn(async (request: { id: string } & Record<string, unknown>) => {
        challenges.set(request.id, request);
        return { success: true };
      }),
      consumeChallengeRpc: vi.fn(async (request: { id: string }) => {
        const data = challenges.get(request.id);
        if (data) {
          challenges.delete(request.id);
          return data;
        }
        throw new Error('Challenge not found');
      }),
      getChallengeRpc: vi.fn(async (id: string) => challenges.get(id) ?? null),
      deleteChallengeRpc: vi.fn(async (id: string) => {
        const existed = challenges.has(id);
        challenges.delete(id);
        return { deleted: existed };
      }),
      // Legacy fetch method (kept for backwards compatibility)
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }))),
    }),
    _challenges: challenges,
  };
}

/** Save an older `system_settings` document's values as the platform's Settings API values. */
export async function putSystemSettings(env: Env, document: Record<string, unknown>) {
  for (const [key, values] of Object.entries(systemSettingsPlatformDocuments(document))) {
    await env.SETTINGS!.put(key, JSON.stringify(values));
  }
}

export async function putTenantSettings(
  env: Env,
  category: string,
  values: Record<string, unknown>
): Promise<void> {
  await env.SETTINGS!.put(`settings:tenant:default:${category}`, JSON.stringify(values));
}

export function challengeMap(env: Env): Map<string, Record<string, unknown>> {
  return (env.CHALLENGE_STORE as unknown as { _challenges: Map<string, Record<string, unknown>> })
    ._challenges;
}

export function sessionMap(env: Env): Map<string, Record<string, unknown>> {
  return (env.SESSION_STORE as unknown as { _sessions: Map<string, Record<string, unknown>> })
    ._sessions;
}

export function seedSession(
  env: Env,
  userId = 'test-user',
  authTime = Math.floor(Date.now() / 1000) - 60,
  sessionId = SESSION_ID
) {
  sessionMap(env).set(sessionId, {
    id: sessionId,
    userId,
    createdAt: Date.now() - 60000,
    expiresAt: Date.now() + 3600000,
    data: { authTime },
  });
}

export function createMockEnv(): Env {
  return {
    ISSUER_URL: 'https://test.example.com',
    ACCESS_TOKEN_EXPIRY: '3600',
    AUTH_CODE_EXPIRY: '120',
    STATE_EXPIRY: '300',
    NONCE_EXPIRY: '300',
    REFRESH_TOKEN_EXPIRY: '2592000',
    HTTPS_REDIRECT_ONLY: 'false',
    UI_URL: 'https://login.example.com', // Login UI that login, re-authentication and consent go to
    STATE_STORE: new MockKVNamespace() as unknown as KVNamespace,
    NONCE_STORE: new MockKVNamespace() as unknown as KVNamespace,
    CLIENTS_CACHE: new MockKVNamespace() as unknown as KVNamespace,
    SETTINGS: new MockKVNamespace() as unknown as KVNamespace,
    AUTHRIM_CONFIG: new MockKVNamespace({
      'region_shard_config:default': JSON.stringify(TEST_REGION_CONFIG),
    }) as unknown as KVNamespace,
    DB: createMockDB(),
    // The Admin database: a Mapping Set the app is bound to is read from it.
    DB_ADMIN: createMockDB(),
    PUBLIC_ASSETS: {} as R2Bucket,
    KEY_MANAGER: createMockDO() as unknown as Env['KEY_MANAGER'],
    SESSION_STORE: createMockSessionStore() as unknown as Env['SESSION_STORE'],
    AUTH_CODE_STORE: createMockAuthCodeStore() as unknown as Env['AUTH_CODE_STORE'],
    REFRESH_TOKEN_ROTATOR: createMockDO() as unknown as Env['REFRESH_TOKEN_ROTATOR'],
    CHALLENGE_STORE: createMockChallengeStore() as unknown as Env['CHALLENGE_STORE'],
    RATE_LIMITER: createMockDO() as unknown as Env['RATE_LIMITER'],
    USER_CODE_RATE_LIMITER: createMockDO() as unknown as DurableObjectNamespace,
    PAR_REQUEST_STORE: createMockDO() as unknown as Env['PAR_REQUEST_STORE'],
    DPOP_JTI_STORE: createMockDO() as unknown as DurableObjectNamespace,
    TOKEN_REVOCATION_STORE: createMockDO() as unknown as DurableObjectNamespace,
    DEVICE_CODE_STORE: createMockDO() as unknown as DurableObjectNamespace,
    CIBA_REQUEST_STORE: createMockDO() as unknown as DurableObjectNamespace,
    ACCOUNT_PROVISIONER: {
      provisionAuthAccount: vi.fn(
        async (request: { operationId: string; candidateUserId: string }) => ({
          status: 201 as const,
          operationId: request.operationId,
          accountId: `account:${request.candidateUserId}`,
          userId: request.candidateUserId,
        })
      ),
    },
  } as unknown as Env;
}

export const DEFAULT_CLIENT = {
  client_id: 'test-client',
  client_secret: 'test-secret',
  redirect_uris: ['https://example.com/callback', 'http://localhost:3000/callback'],
  grant_types: ['authorization_code'],
  response_types: ['code'],
  scope: 'openid profile email',
  token_endpoint_auth_method: 'client_secret_basic',
};

/** A Hono app serving GET and POST /authorize for `tenantId`. */
export function createAuthorizeApp(tenantId = 'default'): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c as unknown as { set: (key: string, value: string) => void }).set('tenantId', tenantId);
    c.set(
      'tenantMetadataContext' as never,
      {
        tenantId,
        coreDb: c.env.DB,
        route: {
          tenantId,
          dataRole: 'core',
          bindingRef: 'DB',
          residencyPartition: 'default',
          generation: 1,
        },
      } as never
    );
    await next();
  });
  app.get('/authorize', authorizeHandler);
  app.post('/authorize', authorizeHandler);
  return app;
}

/** The query string of an authorization request: `overrides` replace (undefined removes) values. */
export function authorizeQuery(overrides: Record<string, string | undefined> = {}): string {
  const values: Record<string, string | undefined> = {
    response_type: 'code',
    client_id: 'test-client',
    redirect_uri: 'https://example.com/callback',
    scope: 'openid',
    state: 'test-state',
    ...overrides,
  };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, value);
  }
  return `/authorize?${params.toString()}`;
}

/** The error a redirect carried back to the client (query or fragment). */
export function redirectedError(response: Response): {
  target: string;
  params: URLSearchParams;
} {
  const location = response.headers.get('Location');
  if (!location) throw new Error(`expected a redirect, got ${response.status}`);
  const url = new URL(location);
  const params = url.hash ? new URLSearchParams(url.hash.slice(1)) : url.searchParams;
  return { target: url.origin + url.pathname, params };
}
