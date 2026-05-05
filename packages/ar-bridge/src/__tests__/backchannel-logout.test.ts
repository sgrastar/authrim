import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCoreQuery,
  mockCoreExecute,
  mockSessionFetch,
  mockFindByProviderSub,
  mockUpdateLinkedIdentity,
  mockGetProvider,
  mockJwtVerify,
  mockCreateLocalJwkSet,
  MockD1Adapter,
  sqlTracker,
} = vi.hoisted(() => {
  const tracker = {
    calls: [] as { method: string; sql: string; params: unknown[] }[],
    reset() {
      this.calls.length = 0;
    },
  };

  const coreQuery = vi.fn().mockResolvedValue([]);
  const coreExecute = vi.fn().mockResolvedValue({ rowsAffected: 1 });
  const sessionFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  const findByProviderSub = vi.fn().mockResolvedValue([]);
  const updateLinkedIdentity = vi.fn().mockResolvedValue(true);
  const getProvider = vi.fn().mockResolvedValue({
    id: 'provider-google',
    name: 'Google',
    issuer: 'https://accounts.google.com',
    clientId: 'client-123',
    jwksUri: 'https://accounts.google.com/jwks',
  });
  const jwtVerify = vi.fn();
  const createLocalJwkSet = vi.fn().mockReturnValue({});

  class D1AdapterClass {
    constructor(_options: { db: unknown }) {}

    query = (sql: string, params?: unknown[]) => {
      tracker.calls.push({ method: 'query', sql, params: params || [] });
      return coreQuery(sql, params);
    };

    execute = (sql: string, params?: unknown[]) => {
      tracker.calls.push({ method: 'execute', sql, params: params || [] });
      return coreExecute(sql, params);
    };
  }

  return {
    mockCoreQuery: coreQuery,
    mockCoreExecute: coreExecute,
    mockSessionFetch: sessionFetch,
    mockFindByProviderSub: findByProviderSub,
    mockUpdateLinkedIdentity: updateLinkedIdentity,
    mockGetProvider: getProvider,
    mockJwtVerify: jwtVerify,
    mockCreateLocalJwkSet: createLocalJwkSet,
    MockD1Adapter: D1AdapterClass,
    sqlTracker: tracker,
  };
});

vi.mock('@authrim/ar-lib-core', () => ({
  D1Adapter: MockD1Adapter,
  resolveAuthCorePersistenceAdapterFromEnv: vi
    .fn()
    .mockResolvedValue(new MockD1Adapter({ db: {} })),
  getSessionStoreBySessionId: vi.fn(() => ({
    stub: {
      fetch: mockSessionFetch,
    },
  })),
  isShardedSessionId: vi.fn(() => true),
  createErrorResponse: vi.fn((_c, _code, _opts) => new Response(null, { status: 400 })),
  AR_ERROR_CODES: {
    ADMIN_RESOURCE_NOT_FOUND: 'not_found',
    VALIDATION_REQUIRED_FIELD: 'required',
    VALIDATION_INVALID_VALUE: 'invalid',
  },
  getLogger: vi.fn(() => ({
    module: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  })),
  getTenantIdFromContext: vi.fn((c: { get?: (key: string) => unknown }) => c.get?.('tenantId')),
}));

vi.mock('../services/provider-store', () => ({
  getProviderByIdOrSlug: mockGetProvider,
}));

vi.mock('../services/linked-identity-store', () => ({
  findLinkedIdentitiesByProviderSub: mockFindByProviderSub,
  updateLinkedIdentity: mockUpdateLinkedIdentity,
}));

vi.mock('jose', () => ({
  createLocalJWKSet: mockCreateLocalJwkSet,
  jwtVerify: mockJwtVerify,
}));

import { handleBackchannelLogout } from '../handlers/backchannel-logout';

describe('backchannel logout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlTracker.reset();
    mockCoreQuery.mockReset().mockResolvedValue([{ id: 'sess-1' }]);
    mockCoreExecute.mockReset().mockResolvedValue({ rowsAffected: 1 });
    mockSessionFetch.mockReset().mockResolvedValue(new Response(null, { status: 200 }));
    mockFindByProviderSub.mockReset().mockResolvedValue([
      {
        id: 'link-1',
        tenantId: 'tenant-a',
      },
    ]);
    mockUpdateLinkedIdentity.mockReset().mockResolvedValue(true);
    mockGetProvider.mockReset().mockResolvedValue({
      id: 'provider-google',
      name: 'Google',
      issuer: 'https://accounts.google.com',
      clientId: 'client-123',
      jwksUri: 'https://accounts.google.com/jwks',
    });
    mockJwtVerify.mockReset().mockResolvedValue({
      payload: {
        iss: 'https://accounts.google.com',
        aud: 'client-123',
        iat: Math.floor(Date.now() / 1000),
        jti: 'logout-token-1',
        sub: 'provider-sub-123',
        events: {
          'http://schemas.openid.net/event/backchannel-logout': {},
        },
      },
    });
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ keys: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as typeof fetch;
  });

  it('limits linked identity and session invalidation to the tenant in context', async () => {
    const contextStore = new Map<string, unknown>([['tenantId', 'tenant-a']]);
    const env = {
      DB: {},
      SETTINGS: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
      },
    };
    const c = {
      req: {
        param: vi.fn(() => 'google'),
        query: vi.fn(() => undefined),
        header: vi.fn((name: string) =>
          name === 'Content-Type' ? 'application/x-www-form-urlencoded' : undefined
        ),
        parseBody: vi.fn().mockResolvedValue({
          logout_token: 'signed.logout.token',
        }),
      },
      env,
      get: vi.fn((key: string) => contextStore.get(key)),
    };

    const response = await handleBackchannelLogout(c as never);

    expect(response.status).toBe(200);
    expect(mockFindByProviderSub).toHaveBeenCalledWith(
      env,
      'tenant-a',
      'provider-google',
      'provider-sub-123'
    );
    expect(sqlTracker.calls[0]?.params).toEqual([
      'provider-google',
      'provider-sub-123',
      'tenant-a',
      expect.any(Number),
    ]);
    expect(sqlTracker.calls[1]?.params).toEqual([
      'provider-google',
      'provider-sub-123',
      'tenant-a',
    ]);
  });
});
