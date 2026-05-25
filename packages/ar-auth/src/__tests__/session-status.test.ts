import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const sessionStore = {
    getSessionRpc: vi.fn(),
    createSessionRpc: vi.fn(),
    extendSessionRpc: vi.fn(),
  };
  const challengeStore = {
    storeChallengeRpc: vi.fn(),
    consumeChallengeRpc: vi.fn(),
  };

  return {
    sessionStore,
    challengeStore,
    getCookie: vi.fn(),
    getSessionStoreBySessionId: vi.fn(() => ({ stub: sessionStore })),
    getChallengeStoreByChallengeId: vi.fn(async () => challengeStore),
    isShardedSessionId: vi.fn((sessionId: string) => /^\d+_session_/.test(sessionId)),
    getTenantIdFromContext: vi.fn(() => 'default'),
    hasPIIDatabase: vi.fn(() => false),
    createPIIContextFromHono: vi.fn(),
    generateCheckSessionIframeHtml: vi.fn(
      (issuerUrl: string, nonce: string) =>
        `<html><script nonce="${nonce}">window.issuer=${JSON.stringify(issuerUrl)}</script></html>`
    ),
    warn: vi.fn(),
    error: vi.fn(),
  };
});

vi.mock('hono/cookie', () => ({
  getCookie: mocks.getCookie,
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getSessionStoreBySessionId: mocks.getSessionStoreBySessionId,
    getChallengeStoreByChallengeId: mocks.getChallengeStoreByChallengeId,
    isShardedSessionId: mocks.isShardedSessionId,
    getTenantIdFromContext: mocks.getTenantIdFromContext,
    hasPIIDatabase: mocks.hasPIIDatabase,
    createPIIContextFromHono: mocks.createPIIContextFromHono,
    generateCheckSessionIframeHtml: mocks.generateCheckSessionIframeHtml,
    getLogger: vi.fn(() => ({
      module: () => ({
        warn: mocks.warn,
        error: mocks.error,
      }),
    })),
  };
});

function createContext() {
  return {
    req: {
      path: '/session/status',
      raw: new Request('https://issuer.example.com/session/status'),
      header: vi.fn(() => undefined),
      json: vi.fn(async () => ({})),
    },
    get: vi.fn((key: string) => (key === 'tenantId' ? 'default' : undefined)),
    env: {},
    json: (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  };
}

describe('session status OIDC assurance metadata', () => {
  beforeEach(() => {
    mocks.getCookie.mockReset().mockReturnValue('0_session_123');
    mocks.sessionStore.getSessionRpc.mockReset();
    mocks.sessionStore.createSessionRpc.mockReset();
    mocks.sessionStore.extendSessionRpc.mockReset();
    mocks.challengeStore.storeChallengeRpc.mockReset();
    mocks.challengeStore.consumeChallengeRpc.mockReset();
    mocks.getSessionStoreBySessionId.mockClear();
    mocks.getChallengeStoreByChallengeId.mockClear();
    mocks.isShardedSessionId.mockClear();
    mocks.getTenantIdFromContext.mockClear();
    mocks.hasPIIDatabase.mockReset().mockReturnValue(false);
    mocks.createPIIContextFromHono.mockReset();
    mocks.generateCheckSessionIframeHtml.mockClear();
    mocks.warn.mockClear();
    mocks.error.mockClear();
  });

  it('returns auth_time, acr, and amr for active managed browser sessions', async () => {
    mocks.sessionStore.getSessionRpc.mockResolvedValue({
      id: '0_session_123',
      userId: 'user_123',
      createdAt: 1700000000000,
      expiresAt: Date.now() + 60_000,
      data: {
        authTime: 1700000123,
        acr: 'urn:mace:incommon:iap:bronze',
        amr: ['passkey'],
      },
    });
    const { sessionStatusHandler } = await import('../session-management');

    const response = await sessionStatusHandler(createContext() as never);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      active: true,
      session_id: '0_session_123',
      user_id: 'user_123',
      auth_time: 1700000123,
      acr: 'urn:mace:incommon:iap:bronze',
      amr: ['passkey'],
    });
  });

  it('returns inactive no_session without touching the session store when the cookie is absent', async () => {
    mocks.getCookie.mockReturnValue(undefined);
    const { sessionStatusHandler } = await import('../session-management');

    const response = await sessionStatusHandler(createContext() as never);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      active: false,
      error: 'no_session',
    });
    expect(mocks.getSessionStoreBySessionId).not.toHaveBeenCalled();
    expect(mocks.sessionStore.getSessionRpc).not.toHaveBeenCalled();
  });

  it('returns inactive session_expired without store lookup for legacy session ids', async () => {
    mocks.getCookie.mockReturnValue('legacy-session-id');
    const { sessionStatusHandler } = await import('../session-management');

    const response = await sessionStatusHandler(createContext() as never);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      active: false,
      error: 'session_expired',
    });
    expect(mocks.getSessionStoreBySessionId).not.toHaveBeenCalled();
    expect(mocks.sessionStore.getSessionRpc).not.toHaveBeenCalled();
  });

  it('returns inactive session_expired when the sharded session is missing', async () => {
    mocks.sessionStore.getSessionRpc.mockResolvedValue(null);
    const { sessionStatusHandler } = await import('../session-management');

    const response = await sessionStatusHandler(createContext() as never);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      active: false,
      error: 'session_expired',
    });
    expect(mocks.getSessionStoreBySessionId).toHaveBeenCalledWith({}, '0_session_123', 'default');
    expect(mocks.sessionStore.getSessionRpc).toHaveBeenCalledWith('0_session_123');
  });

  it('returns inactive session_expired when the stored session has expired', async () => {
    mocks.sessionStore.getSessionRpc.mockResolvedValue({
      id: '0_session_123',
      userId: 'user_123',
      createdAt: 1700000000000,
      expiresAt: Date.now() - 1,
      data: {},
    });
    const { sessionStatusHandler } = await import('../session-management');

    const response = await sessionStatusHandler(createContext() as never);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      active: false,
      error: 'session_expired',
    });
  });

  it('falls back to created_at for auth_time when assurance metadata is absent', async () => {
    mocks.sessionStore.getSessionRpc.mockResolvedValue({
      id: '0_session_123',
      userId: 'user_123',
      createdAt: 1700000000000,
      expiresAt: Date.now() + 60_000,
      data: {},
    });
    const { sessionStatusHandler } = await import('../session-management');

    const response = await sessionStatusHandler(createContext() as never);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      active: true,
      session_id: '0_session_123',
      user_id: 'user_123',
      auth_time: 1700000000,
    });
    expect(body).not.toHaveProperty('acr');
    expect(body).not.toHaveProperty('amr');
  });
});

describe('ITP session token lifecycle', () => {
  beforeEach(() => {
    mocks.getCookie.mockReset().mockReturnValue('0_session_123');
    mocks.sessionStore.getSessionRpc.mockReset();
    mocks.sessionStore.createSessionRpc.mockReset();
    mocks.sessionStore.extendSessionRpc.mockReset();
    mocks.challengeStore.storeChallengeRpc.mockReset();
    mocks.challengeStore.consumeChallengeRpc.mockReset();
    mocks.getSessionStoreBySessionId.mockClear();
    mocks.getChallengeStoreByChallengeId.mockClear();
    mocks.isShardedSessionId.mockClear();
    mocks.getTenantIdFromContext.mockClear();
    mocks.hasPIIDatabase.mockReset().mockReturnValue(false);
    mocks.createPIIContextFromHono.mockReset();
    mocks.generateCheckSessionIframeHtml.mockClear();
    mocks.warn.mockClear();
    mocks.error.mockClear();
  });

  it('issues a short-lived single-use token bound to the active session', async () => {
    mocks.sessionStore.getSessionRpc.mockResolvedValue({
      id: '0_session_123',
      userId: 'user_123',
      createdAt: 1700000000000,
      expiresAt: Date.now() + 60_000,
      data: {},
    });
    const { issueSessionTokenHandler } = await import('../session-management');

    const response = await issueSessionTokenHandler(createContext() as never);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      expires_in: 300,
      session_id: '0_session_123',
    });
    expect(typeof body.token).toBe('string');
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith({
      id: `session_token:${body.token}`,
      tenantId: 'default',
      type: 'session_token',
      userId: 'user_123',
      challenge: body.token,
      ttl: 300,
      metadata: {
        sessionId: '0_session_123',
      },
    });
  });

  it('rejects session token issuance when no browser session cookie exists', async () => {
    mocks.getCookie.mockReturnValue(undefined);
    const { issueSessionTokenHandler } = await import('../session-management');

    const response = await issueSessionTokenHandler(createContext() as never);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(body).toEqual({
      error: 'invalid_token',
      error_description: 'No active session found',
    });
    expect(mocks.getSessionStoreBySessionId).not.toHaveBeenCalled();
    expect(mocks.challengeStore.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('verifies a single-use session token and creates an RP-scoped session', async () => {
    const context = createContext();
    context.req.json = vi.fn(async () => ({
      token: 'session-token-123',
      rp_origin: 'https://rp.example.com',
    }));
    mocks.challengeStore.consumeChallengeRpc.mockResolvedValue({
      challenge: 'session-token-123',
      userId: 'user_123',
      metadata: {
        sessionId: '0_session_123',
      },
    });
    mocks.sessionStore.getSessionRpc.mockResolvedValue({
      id: '0_session_123',
      userId: 'user_123',
      createdAt: 1700000000000,
      expiresAt: 1700003600000,
      data: {},
    });
    mocks.sessionStore.createSessionRpc.mockResolvedValue({
      id: '0_session_rp',
      userId: 'user_123',
      createdAt: 1700000000000,
      expiresAt: 1700003600000,
      data: {},
    });
    const { verifySessionTokenHandler } = await import('../session-management');

    const response = await verifySessionTokenHandler(context as never);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      session_id: '0_session_rp',
      user_id: 'user_123',
      expires_at: 1700003600000,
      verified: true,
    });
    expect(mocks.challengeStore.consumeChallengeRpc).toHaveBeenCalledWith({
      id: 'session_token:session-token-123',
      tenantId: 'default',
      type: 'session_token',
      challenge: 'session-token-123',
    });
    expect(mocks.sessionStore.createSessionRpc).toHaveBeenCalledWith(
      expect.any(String),
      'user_123',
      86400,
      {
        rpOrigin: 'https://rp.example.com',
        parentSessionId: '0_session_123',
      },
      'default'
    );
  });

  it('rejects verification when the single-use token was consumed already', async () => {
    const context = createContext();
    context.req.json = vi.fn(async () => ({ token: 'session-token-123' }));
    mocks.challengeStore.consumeChallengeRpc.mockRejectedValue(new Error('already used'));
    const { verifySessionTokenHandler } = await import('../session-management');

    const response = await verifySessionTokenHandler(context as never);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(body).toEqual({
      error: 'invalid_token',
      error_description: 'Token not found, expired, or already used',
    });
    expect(mocks.sessionStore.getSessionRpc).not.toHaveBeenCalled();
    expect(mocks.sessionStore.createSessionRpc).not.toHaveBeenCalled();
  });

  it('refreshes a cookie session with the requested active TTL extension', async () => {
    const context = createContext();
    context.req.json = vi.fn(async () => ({ extend_seconds: 120 }));
    mocks.sessionStore.extendSessionRpc.mockResolvedValue({
      id: '0_session_123',
      userId: 'user_123',
      createdAt: 1700000000000,
      expiresAt: 1700003720000,
      data: {},
    });
    const { refreshSessionHandler } = await import('../session-management');

    const response = await refreshSessionHandler(context as never);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      session_id: '0_session_123',
      user_id: 'user_123',
      expires_at: 1700003720000,
      extended_by: 120,
      message: 'Session extended successfully',
    });
    expect(mocks.sessionStore.extendSessionRpc).toHaveBeenCalledWith('0_session_123', 120);
  });

  it('rejects refresh requests with an unsafe extension duration', async () => {
    const context = createContext();
    context.req.json = vi.fn(async () => ({ extend_seconds: 86401 }));
    const { refreshSessionHandler } = await import('../session-management');

    const response = await refreshSessionHandler(context as never);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: 'invalid_request',
      error_description: 'Extension duration must be between 0 and 86400 seconds',
    });
    expect(mocks.sessionStore.extendSessionRpc).not.toHaveBeenCalled();
  });

  it('serves the check-session iframe with a nonce-based CSP and no caching', async () => {
    const { checkSessionIframeHandler } = await import('../session-management');

    const response = await checkSessionIframeHandler(createContext() as never);
    const body = await response.text();
    const csp = response.headers.get('Content-Security-Policy') ?? '';

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('X-Frame-Options')).toBe('ALLOWALL');
    expect(response.headers.get('Cache-Control')).toBe('no-cache, no-store, must-revalidate');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('frame-ancestors *');
    expect(csp).toContain("script-src 'nonce-");
    expect(csp).not.toContain('unsafe-inline');
    expect(body).toContain('https://issuer.example.com');
    expect(mocks.generateCheckSessionIframeHtml).toHaveBeenCalledWith(
      'https://issuer.example.com',
      expect.any(String)
    );
  });
});
