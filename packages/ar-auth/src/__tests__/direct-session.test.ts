import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const sessionStore = {
    getSessionRpc: vi.fn(),
  };
  const userCoreRepository = {
    findById: vi.fn(),
  };
  const userPIIRepository = {
    findById: vi.fn(),
  };

  return {
    sessionStore,
    userCoreRepository,
    userPIIRepository,
    getCookie: vi.fn(),
    getSessionStoreBySessionId: vi.fn(() => ({ stub: sessionStore })),
    isShardedSessionId: vi.fn((sessionId: string) => /^\d+_session_/.test(sessionId)),
    getTenantIdFromContext: vi.fn(() => 'default'),
    createAuthContextFromHono: vi.fn(() => ({
      repositories: {
        userCore: userCoreRepository,
      },
    })),
    resolveAccountDataContextFromHono: vi.fn(async (_c, userId: string) => ({
      tenantId: 'default',
      accountId: `account:${userId}`,
      legacyUserId: userId,
    })),
    createPIIContextFromHono: vi.fn(() => ({
      piiRepositories: {
        userPII: userPIIRepository,
      },
    })),
    hasPIIDatabase: vi.fn(() => true),
    error: vi.fn(),
    warn: vi.fn(),
  };
});

vi.mock('hono/cookie', () => ({
  getCookie: mocks.getCookie,
  setCookie: vi.fn(),
  deleteCookie: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    CanonicalRuntimeUserStore: class {
      async findById(userId: string) {
        const core = await mocks.userCoreRepository.findById(userId);
        if (!core) return null;
        const isActive = core.active ?? core.is_active;
        if (!isActive) {
          return {
            id: core.id,
            active: 0,
            account_type: core.user_type === 'admin' ? 'admin' : 'user',
            email: null,
            name: null,
            email_verified: core.email_verified ? 1 : 0,
            phone_number_verified: core.phone_number_verified ? 1 : 0,
            created_at: new Date(core.created_at ?? Date.now()).toISOString(),
            updated_at: new Date(core.updated_at ?? Date.now()).toISOString(),
            last_login_at: core.last_login_at ?? null,
          };
        }
        const pii = await mocks.userPIIRepository.findById(userId);
        return {
          id: core.id,
          active: isActive ? 1 : 0,
          account_type: core.user_type === 'admin' ? 'admin' : 'user',
          email: pii?.email ?? null,
          name: pii?.name ?? null,
          email_verified: core.email_verified ? 1 : 0,
          phone_number_verified: core.phone_number_verified ? 1 : 0,
          created_at: new Date(core.created_at ?? Date.now()).toISOString(),
          updated_at: new Date(core.updated_at ?? Date.now()).toISOString(),
          last_login_at: core.last_login_at ?? null,
        };
      }
    },
    getSessionStoreBySessionId: mocks.getSessionStoreBySessionId,
    isShardedSessionId: mocks.isShardedSessionId,
    getTenantIdFromContext: mocks.getTenantIdFromContext,
    createAuthContextFromHono: mocks.createAuthContextFromHono,
    createAccountAuthContextFromHono: mocks.createAuthContextFromHono,
    resolveAccountDataContextFromHono: mocks.resolveAccountDataContextFromHono,
    createPIIContextFromHono: mocks.createPIIContextFromHono,
    hasPIIDatabase: mocks.hasPIIDatabase,
    getLogger: vi.fn(() => ({
      module: () => ({
        error: mocks.error,
        warn: mocks.warn,
        info: vi.fn(),
      }),
    })),
  };
});

function createContext(authorization?: string, tenantExclusive = false) {
  return {
    req: {
      header: vi.fn((name: string) => {
        if (name.toLowerCase() === 'authorization') return authorization;
        return undefined;
      }),
    },
    env: {},
    get: vi.fn((key: string) => {
      if (key === 'tenantId') return 'default';
      if (key === 'tenantMetadataContext' && tenantExclusive) {
        return { tenantId: 'default', storageProfileId: 'builtin:storage:tenant-d1' };
      }
      return undefined;
    }),
    json: (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  };
}

function createJsonContext(body: Record<string, unknown>) {
  return {
    req: {
      json: vi.fn(async () => body),
      header: vi.fn(() => undefined),
    },
    env: {},
    json: (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  };
}

describe('Direct Auth session endpoint', () => {
  beforeEach(() => {
    mocks.getCookie.mockReset().mockReturnValue(undefined);
    mocks.sessionStore.getSessionRpc.mockReset();
    mocks.userCoreRepository.findById.mockReset();
    mocks.userPIIRepository.findById.mockReset();
    mocks.getSessionStoreBySessionId.mockClear();
    mocks.isShardedSessionId.mockClear();
    mocks.getTenantIdFromContext.mockClear();
    mocks.createAuthContextFromHono.mockClear();
    mocks.resolveAccountDataContextFromHono.mockClear();
    mocks.createPIIContextFromHono.mockClear();
    mocks.hasPIIDatabase.mockReset().mockReturnValue(true);
    mocks.error.mockClear();
    mocks.warn.mockClear();
  });

  it('returns 401 no_session when neither cookie nor bearer session is present', async () => {
    const { directSessionHandler } = await import('../direct-auth');

    const response = await directSessionHandler(createContext() as never);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(body).toEqual({
      error: 'no_session',
      error_description: 'No session found',
    });
    expect(mocks.getSessionStoreBySessionId).not.toHaveBeenCalled();
  });

  it('resolves a bearer session into SDK-compatible session and user payloads', async () => {
    mocks.sessionStore.getSessionRpc.mockResolvedValue({
      id: '0_session_123',
      userId: 'user_123',
      createdAt: 1700000000000,
      expiresAt: Date.now() + 60_000,
      data: {
        amr: ['passkey'],
      },
    });
    mocks.userCoreRepository.findById.mockResolvedValue({
      id: 'user_123',
      email_verified: true,
      is_active: true,
      created_at: 1699990000000,
      updated_at: 1699995000000,
      last_login_at: 1700000000000,
    });
    mocks.userPIIRepository.findById.mockResolvedValue({
      email: 'user@example.com',
      name: 'Example User',
    });
    const { directSessionHandler } = await import('../direct-auth');

    const response = await directSessionHandler(createContext('Bearer 0_session_123') as never);
    const body = (await response.json()) as Record<string, Record<string, unknown>>;

    expect(response.status).toBe(200);
    expect(body.session).toMatchObject({
      id: '0_session_123',
      userId: 'user_123',
      data: {
        amr: ['passkey'],
      },
    });
    expect(body.user).toMatchObject({
      id: 'user_123',
      email: 'user@example.com',
      name: 'Example User',
      emailVerified: true,
    });
    expect(mocks.getSessionStoreBySessionId).toHaveBeenCalledWith({}, '0_session_123', 'default');
  });

  it('returns 401 session_expired for legacy or expired session ids', async () => {
    mocks.getCookie.mockReturnValue('legacy-session-id');
    const { directSessionHandler } = await import('../direct-auth');

    const response = await directSessionHandler(createContext() as never);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(body).toEqual({
      error: 'session_expired',
      error_description: 'Session has expired',
    });
    expect(mocks.getSessionStoreBySessionId).not.toHaveBeenCalled();
  });

  it('returns 401 user_not_found when the session user is inactive', async () => {
    mocks.getCookie.mockReturnValue('0_session_123');
    mocks.sessionStore.getSessionRpc.mockResolvedValue({
      id: '0_session_123',
      userId: 'user_123',
      createdAt: 1700000000000,
      expiresAt: Date.now() + 60_000,
      data: {},
    });
    mocks.userCoreRepository.findById.mockResolvedValue({
      id: 'user_123',
      is_active: false,
    });
    const { directSessionHandler } = await import('../direct-auth');

    const response = await directSessionHandler(createContext() as never);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(body).toEqual({
      error: 'user_not_found',
      error_description: 'User not found',
    });
    expect(mocks.userPIIRepository.findById).not.toHaveBeenCalled();
  });

  it('resolves the account-scoped user store for a tenant-exclusive session', async () => {
    mocks.getCookie.mockReturnValue('0_session_123');
    mocks.sessionStore.getSessionRpc.mockResolvedValue({
      id: '0_session_123',
      userId: 'user_123',
      createdAt: 1700000000000,
      expiresAt: Date.now() + 60_000,
      data: {},
    });
    mocks.userCoreRepository.findById.mockResolvedValue({
      id: 'user_123',
      is_active: true,
      created_at: 1700000000000,
      updated_at: 1700000000000,
    });
    const context = createContext(undefined, true);
    const { directSessionHandler } = await import('../direct-auth');

    const response = await directSessionHandler(context as never);

    expect(response.status).toBe(200);
    expect(mocks.resolveAccountDataContextFromHono).toHaveBeenCalledWith(context, 'user_123');
  });
});

describe('Direct Auth authenticated passkey registration', () => {
  beforeEach(() => {
    mocks.getCookie.mockReset().mockReturnValue(undefined);
    mocks.sessionStore.getSessionRpc.mockReset();
    mocks.getSessionStoreBySessionId.mockClear();
    mocks.isShardedSessionId.mockClear();
    mocks.getTenantIdFromContext.mockClear();
    mocks.resolveAccountDataContextFromHono.mockClear();
    mocks.error.mockClear();
  });

  it('requires an existing session before issuing passkey registration options', async () => {
    const { directPasskeyRegisterStartHandler } = await import('../direct-auth');

    const response = await directPasskeyRegisterStartHandler(createContext() as never);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(body).toMatchObject({
      error: 'login_required',
      error_code: 'AR000003',
    });
    expect(mocks.getSessionStoreBySessionId).not.toHaveBeenCalled();
  });

  it('rejects passkey registration completion without challenge and credential', async () => {
    const { directPasskeyRegisterFinishHandler } = await import('../direct-auth');

    const response = await directPasskeyRegisterFinishHandler(createJsonContext({}) as never);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: 'invalid_request',
      error_code: 'AR130001',
    });
  });
});
