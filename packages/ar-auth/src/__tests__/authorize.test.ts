import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { authorizeConfirmHandler, authorizeHandler, authorizeLoginHandler } from '../authorize';
import type { Env } from '@authrim/ar-lib-core/types/env';

// Mock getClient and getClientCached at module level
const mockGetClient = vi.hoisted(() => vi.fn());
vi.mock('@authrim/ar-lib-core', async () => {
  const actual = await vi.importActual('@authrim/ar-lib-core');
  return {
    ...actual,
    getClient: mockGetClient,
    // getClientCached wraps getClient, so we need to mock it too
    getClientCached: vi
      .fn()
      .mockImplementation((_c, env, clientId) => mockGetClient(env, clientId)),
  };
});

/**
 * Mock KV namespace for testing
 */
class MockKVNamespace {
  private store: Map<string, string> = new Map();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) || null;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
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

/**
 * Mock D1 Database
 */
function createMockDB() {
  const mockStatement = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(null),
    all: vi.fn().mockResolvedValue({ results: [] }),
    run: vi.fn().mockResolvedValue({ success: true }),
  };

  return {
    prepare: vi.fn().mockReturnValue(mockStatement),
    batch: vi.fn().mockResolvedValue([]),
    _mockStatement: mockStatement,
  } as unknown as D1Database;
}

/**
 * Mock Durable Object Namespace with auth code storage
 */
function createMockAuthCodeStore() {
  const storedCodes = new Map<string, any>();

  return {
    idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-auth-code-id' }),
    get: vi.fn().mockReturnValue({
      fetch: vi.fn().mockImplementation(async (request: Request) => {
        const url = new URL(request.url);

        if (request.method === 'POST' && url.pathname === '/store') {
          const body = (await request.json()) as { code: string };
          storedCodes.set(body.code, body);
          return new Response(JSON.stringify({ success: true }));
        }

        if (request.method === 'POST' && url.pathname === '/get') {
          const body = (await request.json()) as { code: string };
          const data = storedCodes.get(body.code);
          if (data) {
            return new Response(JSON.stringify(data));
          }
          return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
        }

        return new Response(JSON.stringify({ success: true }));
      }),
      // RPC methods
      storeCodeRpc: vi.fn().mockResolvedValue({ success: true }),
      getCodeRpc: vi.fn().mockResolvedValue(null),
      consumeCodeRpc: vi.fn().mockResolvedValue(null),
    }),
    _storedCodes: storedCodes,
  };
}

/**
 * Mock generic Durable Object Namespace
 */
function createMockDO() {
  return {
    idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-do-id' }),
    get: vi.fn().mockReturnValue({
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }))),
    }),
  };
}

function createMockPARRequestStore(consumedRequest: Record<string, unknown>) {
  const consumeRequestRpc = vi.fn().mockResolvedValue(consumedRequest);

  return {
    idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-par-request-id' }),
    get: vi.fn().mockReturnValue({
      consumeRequestRpc,
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }))),
    }),
    _consumeRequestRpc: consumeRequestRpc,
  };
}

/**
 * Mock SessionStore Durable Object with RPC methods
 */
function createMockSessionStore() {
  const sessions = new Map<string, any>();
  const generatedSessionId = 'g1:apac:3:session_generated';

  return {
    idFromName: vi.fn().mockReturnValue({ toString: () => generatedSessionId }),
    get: vi.fn().mockReturnValue({
      getSessionRpc: vi.fn().mockImplementation(async (sessionId: string) => {
        return sessions.get(sessionId) || null;
      }),
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
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }))),
    }),
    _sessions: sessions,
  };
}

/**
 * Mock ChallengeStore Durable Object with RPC methods
 */
function createMockChallengeStore() {
  const challenges = new Map<string, any>();

  return {
    idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-challenge-store-id' }),
    get: vi.fn().mockReturnValue({
      // RPC methods
      storeChallengeRpc: vi.fn().mockImplementation(async (request: { id: string }) => {
        challenges.set(request.id, request);
        return { success: true };
      }),
      consumeChallengeRpc: vi.fn().mockImplementation(async (request: { id: string }) => {
        const data = challenges.get(request.id);
        if (data) {
          challenges.delete(request.id);
          return data;
        }
        throw new Error('Challenge not found');
      }),
      getChallengeRpc: vi.fn().mockImplementation(async (id: string) => {
        return challenges.get(id) || null;
      }),
      deleteChallengeRpc: vi.fn().mockImplementation(async (id: string) => {
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

// Type for error response
type ErrorResponse = Record<string, unknown>;
const TEST_SESSION_ID = 'g1:apac:3:session_test-session';

function getChallengeMap(env: Env): Map<string, unknown> {
  return (env.CHALLENGE_STORE as unknown as { _challenges: Map<string, unknown> })._challenges;
}

function getSessionMap(env: Env): Map<string, unknown> {
  return (env.SESSION_STORE as unknown as { _sessions: Map<string, unknown> })._sessions;
}

function getAuthCodeStore(env: Env): { storeCodeRpc: ReturnType<typeof vi.fn> } {
  const authCodeStore = env.AUTH_CODE_STORE as unknown as {
    get: () => { storeCodeRpc: ReturnType<typeof vi.fn> };
  };
  return authCodeStore.get();
}

function seedSession(env: Env, userId: string = 'test-user') {
  getSessionMap(env).set(TEST_SESSION_ID, {
    id: TEST_SESSION_ID,
    userId,
    createdAt: Date.now() - 60000,
    expiresAt: Date.now() + 3600000,
    data: {
      authTime: Math.floor(Date.now() / 1000) - 60,
    },
  });
}

async function configureClientSettings(
  env: Env,
  settings: Record<string, unknown>,
  clientId = 'test-client'
) {
  await (env.SETTINGS as unknown as MockKVNamespace).put(
    `settings:client:default:${clientId}:client`,
    JSON.stringify(settings)
  );
}

/**
 * Create a mock environment for testing (partial - only what's needed)
 */
function createMockEnv(): Env {
  return {
    ISSUER_URL: 'https://test.example.com',
    ACCESS_TOKEN_EXPIRY: '3600',
    AUTH_CODE_EXPIRY: '120',
    STATE_EXPIRY: '300',
    NONCE_EXPIRY: '300',
    REFRESH_TOKEN_EXPIRY: '2592000',
    ENABLE_HTTP_REDIRECT: 'true',
    ENABLE_CONFORMANCE_MODE: 'true', // Enable conformance mode for testing (uses built-in forms)
    STATE_STORE: new MockKVNamespace() as unknown as KVNamespace,
    NONCE_STORE: new MockKVNamespace() as unknown as KVNamespace,
    CLIENTS_CACHE: new MockKVNamespace() as unknown as KVNamespace,
    SETTINGS: new MockKVNamespace() as unknown as KVNamespace,
    AUTHRIM_CONFIG: new MockKVNamespace() as unknown as KVNamespace,
    DB: createMockDB(),
    AVATARS: {} as R2Bucket,
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
  } as unknown as Env;
}

describe('Authorization Handler', () => {
  let app: Hono<{ Bindings: Env }>;
  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock client for most tests
    mockGetClient.mockResolvedValue({
      client_id: 'test-client',
      client_secret: 'test-secret',
      redirect_uris: ['https://example.com/callback', 'http://localhost:3000/callback'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      scope: 'openid profile email',
      token_endpoint_auth_method: 'client_secret_basic',
    });

    app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      (c as unknown as { set: (key: string, value: string) => void }).set('tenantId', 'default');
      await next();
    });
    app.get('/authorize', authorizeHandler);
    app.post('/authorize', authorizeHandler);
    app.get('/flow/login', authorizeLoginHandler);
    app.post('/flow/login', authorizeLoginHandler);
    app.get('/flow/confirm', authorizeConfirmHandler);
    app.post('/flow/confirm', authorizeConfirmHandler);
    env = createMockEnv();
  });

  describe('Authorization Flow - Unauthenticated User', () => {
    it('should redirect to login page when user is not authenticated', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&state=test-state',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toBeTruthy();
      // Should redirect to login page with challenge_id
      expect(location).toContain('/flow/login');
      expect(location).toContain('challenge_id=');
    });

    it('should ignore caller-supplied internal confirmation parameters', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&state=test-state&_confirmed=true&_session_user_id=victim-user&_auth_time=1700000000',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toContain('/flow/login');
      expect(location).not.toContain('code=');
    });

    it('should preserve state parameter through login redirect', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&state=my-state',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      // Login redirect preserves authorization parameters in challenge
      expect(location).toContain('/flow/login');
    });

    it('should accept http://localhost redirect_uri when ENABLE_HTTP_REDIRECT is true', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=http://localhost:3000/callback&scope=openid',
        { method: 'GET' },
        env
      );

      // Should redirect to login (localhost is allowed)
      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toContain('/flow/login');
    });

    it('should redirect with temporarily_unavailable when login UI is not configured', async () => {
      env.ENABLE_CONFORMANCE_MODE = 'false';

      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&state=test-state',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toBeTruthy();
      const redirectUrl = new URL(location!, 'https://example.com');
      expect(redirectUrl.searchParams.get('error')).toBe('temporarily_unavailable');
      expect(redirectUrl.searchParams.get('error_description')).toBe('Login UI is not configured');
      expect(redirectUrl.searchParams.get('state')).toBe('test-state');
      expect(redirectUrl.searchParams.get('iss')).toBe('https://test.example.com');
      expect(getChallengeMap(env).size).toBe(0);
    });

    it('should preserve client-specific login_ui_url when global UI_URL is not configured', async () => {
      env.ENABLE_CONFORMANCE_MODE = 'false';
      mockGetClient.mockResolvedValue({
        client_id: 'test-client',
        client_secret: 'test-secret',
        redirect_uris: ['https://example.com/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: 'openid profile email',
        token_endpoint_auth_method: 'client_secret_basic',
        login_ui_url: 'https://client-login.example.com',
      });

      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toContain('https://client-login.example.com/login');
      expect(location).toContain('challenge_id=');
      expect(location).toContain('tenant_host=test.example.com');
    });

    it('routes OIDC certification clients to built-in login without global conformance mode', async () => {
      env.ENABLE_CONFORMANCE_MODE = 'false';
      env.UI_URL = 'https://login.example.com';
      env.LOGIN_UI_EXECUTION_HOST_MODE = 'dedicated';
      const certificationRedirectUri =
        'https://www.certification.openid.net/test/a/authrim/callback';
      mockGetClient.mockResolvedValue({
        client_id: 'test-client',
        client_secret: 'test-secret',
        redirect_uris: [certificationRedirectUri],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: 'openid profile email',
        token_endpoint_auth_method: 'client_secret_basic',
        login_ui_url: 'https://client-login.example.com',
      });

      const response = await app.request(
        `/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent(
          certificationRedirectUri
        )}&scope=openid&state=test-state`,
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toBeTruthy();
      const redirectUrl = new URL(location!, 'https://test.example.com');
      expect(redirectUrl.pathname).toBe('/flow/login');
      expect(redirectUrl.searchParams.get('challenge_id')).toBeTruthy();
      expect(location).not.toContain('login.example.com');
      expect(location).not.toContain('client-login.example.com');
    });

    it('should keep authorization UI redirects on the tenant issuer host in multi-tenant mode', async () => {
      env.ENABLE_CONFORMANCE_MODE = 'false';
      env.UI_URL = 'https://login.example.com';
      env.BASE_DOMAIN = 'test.authrim.com';

      const response = await app.request(
        'https://default.test.authrim.com/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid',
        {
          method: 'GET',
          headers: {
            Host: 'default.test.authrim.com',
          },
        },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toBeTruthy();
      const redirectUrl = new URL(location!);
      expect(redirectUrl.origin + redirectUrl.pathname).toBe(
        'https://default.test.authrim.com/login'
      );
      expect(redirectUrl.searchParams.get('challenge_id')).toBeTruthy();
      expect(redirectUrl.searchParams.get('tenant_host')).toBe('default.test.authrim.com');
      expect(redirectUrl.searchParams.get('tenant_hint')).toBe('default');
    });

    it('should use UI_URL for separate Login UI redirects in single-tenant mode', async () => {
      env.ENABLE_CONFORMANCE_MODE = 'false';
      env.UI_URL = 'https://login.example.com';
      env.LOGIN_UI_EXECUTION_HOST_MODE = 'dedicated';

      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toBeTruthy();
      const redirectUrl = new URL(location!);
      expect(redirectUrl.origin + redirectUrl.pathname).toBe('https://login.example.com/login');
      expect(redirectUrl.searchParams.get('challenge_id')).toBeTruthy();
      expect(redirectUrl.searchParams.get('tenant_host')).toBe('test.example.com');
    });

    it('should use the issuer for issuer-hosted single-tenant Login UI redirects', async () => {
      env.ENABLE_CONFORMANCE_MODE = 'false';
      env.UI_URL = 'https://login.example.com';
      env.LOGIN_UI_EXECUTION_HOST_MODE = 'issuer';

      const response = await app.request(
        'https://test.example.com/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toBeTruthy();
      expect(new URL(location!).origin + new URL(location!).pathname).toBe(
        'https://test.example.com/login'
      );
    });

    it('should use form_post for temporarily_unavailable when response_mode=form_post', async () => {
      env.ENABLE_CONFORMANCE_MODE = 'false';

      const response = await app.request(
        '/authorize?response_type=code&response_mode=form_post&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&state=test-state',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('form id="auth-form"');
      expect(body).toContain('action="https://example.com/callback"');
      expect(body).toContain('name="error" value="temporarily_unavailable"');
      expect(body).toContain('name="error_description" value="Login UI is not configured"');
      expect(body).toContain('name="state" value="test-state"');
    });

    it('should support POSTed form authorization requests and preserve login challenge metadata', async () => {
      const body = new URLSearchParams({
        response_type: 'code',
        client_id: 'test-client',
        redirect_uri: 'https://example.com/callback',
        scope: 'openid profile',
        state: 'post-state',
        nonce: 'post-nonce',
        prompt: 'login',
        max_age: '300',
        acr_values: 'urn:authrim:acr:mfa',
      });

      const response = await app.request(
        '/authorize',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
        },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toContain('/flow/login');

      const challengeId = new URL(location!, 'https://test.example.com').searchParams.get(
        'challenge_id'
      );
      expect(challengeId).toBeTruthy();
      const storedChallenge = getChallengeMap(env).get(challengeId!) as {
        metadata?: Record<string, unknown>;
      };
      expect(storedChallenge.metadata).toMatchObject({
        response_type: 'code',
        client_id: 'test-client',
        redirect_uri: 'https://example.com/callback',
        scope: 'openid profile',
        state: 'post-state',
        nonce: 'post-nonce',
        prompt: 'login',
        max_age: '300',
        acr_values: 'urn:authrim:acr:mfa',
      });
    });
  });

  describe('Authorization request validation matrix', () => {
    const base =
      '/authorize?response_type=code&client_id=test-client&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&scope=openid&state=test-state';

    it.each(['-1', '1.5', 'abc', '+1', ' 1'])('rejects invalid max_age=%s', async (maxAge) => {
      const response = await app.request(`${base}&max_age=${encodeURIComponent(maxAge)}`, {}, env);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: 'invalid_request',
        error_description: 'max_age must be a non-negative integer',
      });
    });

    it.each(['unsupported', 'query.invalid', 'fragment.invalid', 'form_post.invalid'])(
      'rejects unsupported response_mode=%s',
      async (mode) => {
        const response = await app.request(`${base}&response_mode=${mode}`, {}, env);
        expect(response.status).toBe(302);
        expect(response.headers.get('location')).toContain('error=invalid_request');
      }
    );

    it('rejects fragment mode for authorization-code-only responses', async () => {
      const response = await app.request(`${base}&response_mode=fragment`, {}, env);
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toContain('error=invalid_request');
    });

    it.each(['query', 'form_post', 'query.jwt', 'form_post.jwt', 'jwt'])(
      'accepts response_mode=%s for code flow through request validation',
      async (mode) => {
        const response = await app.request(`${base}&response_mode=${mode}`, {}, env);
        expect([200, 302]).toContain(response.status);
        const text = await response.clone().text();
        expect(text).not.toContain('Unsupported response_mode');
        expect(response.headers.get('location') ?? '').not.toContain('error=invalid_request');
      }
    );

    it('rejects prompt=none combined with interactive prompt values', async () => {
      const response = await app.request(`${base}&prompt=none%20login`, {}, env);
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toContain('error=invalid_request');
    });

    it('requires state when the OAuth CSRF setting is enabled', async () => {
      env.ENABLE_STATE_REQUIRED = 'true';
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&scope=openid',
        {},
        env
      );
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toContain('error=invalid_request');
    });

    it.each([
      '{',
      '[]',
      'null',
      JSON.stringify({ userinfo: 'not-an-object' }),
      JSON.stringify({ id_token: [] }),
    ])('rejects malformed claims request %s', async (claims) => {
      const response = await app.request(`${base}&claims=${encodeURIComponent(claims)}`, {}, env);
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toContain('error=invalid_request');
    });

    it('preserves validated OIDC UX parameters in the login challenge', async () => {
      const response = await app.request(
        `${base}&max_age=0&acr_values=${encodeURIComponent('urn:mace:incommon:iap:silver urn:mace:incommon:iap:bronze')}&display=popup&ui_locales=ja%20en&login_hint=user%40example.com`,
        {},
        env
      );
      expect(response.status).toBe(302);
      const location = response.headers.get('location');
      const challengeId = new URL(location!, 'https://test.example.com').searchParams.get(
        'challenge_id'
      );
      const challenge = getChallengeMap(env).get(challengeId!) as {
        metadata?: Record<string, unknown>;
      };
      expect(challenge.metadata).toMatchObject({
        max_age: '0',
        acr_values: 'urn:mace:incommon:iap:silver urn:mace:incommon:iap:bronze',
        display: 'popup',
        ui_locales: 'ja en',
        login_hint: 'user@example.com',
      });
    });

    it('requires PAR by default when FAPI mode is enabled', async () => {
      await (env.SETTINGS as unknown as MockKVNamespace).put(
        'system_settings',
        JSON.stringify({ fapi: { enabled: true } })
      );
      const response = await app.request(
        `${base}&code_challenge=${'a'.repeat(43)}&code_challenge_method=S256`,
        {},
        env
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error_description: expect.stringContaining('PAR is required'),
      });
    });

    it('rejects public clients when FAPI explicitly disallows them', async () => {
      await (env.SETTINGS as unknown as MockKVNamespace).put(
        'system_settings',
        JSON.stringify({
          fapi: { enabled: true, allowPublicClients: false },
          oidc: { requirePar: false },
        })
      );
      const response = await app.request(
        `${base}&code_challenge=${'a'.repeat(43)}&code_challenge_method=S256`,
        {},
        env
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: 'invalid_client',
        error_description: expect.stringContaining('Public clients'),
      });
    });

    it('requires S256 PKCE for a confidential FAPI client', async () => {
      mockGetClient.mockResolvedValueOnce({
        client_id: 'test-client',
        client_secret_hash: 'hash',
        redirect_uris: ['https://example.com/callback'],
        response_types: ['code'],
        scope: 'openid',
      });
      await (env.SETTINGS as unknown as MockKVNamespace).put(
        'system_settings',
        JSON.stringify({ fapi: { enabled: true }, oidc: { requirePar: false } })
      );
      const response = await app.request(base, {}, env);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error_description: expect.stringContaining('PKCE with S256'),
      });
    });

    it('continues with safe defaults when FAPI settings JSON is malformed', async () => {
      await (env.SETTINGS as unknown as MockKVNamespace).put('system_settings', '{');
      const response = await app.request(base, {}, env);
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toContain('/flow/login');
    });

    it('parses all supported form parameters without trusting non-string values', async () => {
      const body = new URLSearchParams({
        response_type: 'code',
        client_id: 'test-client',
        redirect_uri: 'https://example.com/callback',
        scope: 'openid profile',
        state: 'post-state',
        nonce: 'post-nonce',
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
        claims: JSON.stringify({ userinfo: { email: null } }),
        authorization_details: '',
        response_mode: 'query',
        prompt: 'login',
        max_age: '0',
        id_token_hint: 'invalid.jwt.value',
        acr_values: 'urn:mace:incommon:iap:bronze',
        display: 'page',
        ui_locales: 'ja en',
        login_hint: 'user@example.com',
        org_id: 'org-1',
        acting_as: 'delegated-user',
        error_uri: 'https://example.com/error',
        cancel_uri: 'https://example.com/cancel',
      });
      const response = await app.request(
        '/authorize',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        },
        env
      );
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toContain('/flow/login');
    });
  });

  describe('PKCE Support', () => {
    it('should accept valid PKCE parameters and redirect to login', async () => {
      const codeChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'; // Valid S256 challenge
      const response = await app.request(
        `/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&code_challenge=${codeChallenge}&code_challenge_method=S256`,
        { method: 'GET' },
        env
      );

      // Valid PKCE should proceed to login
      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toContain('/flow/login');
    });

    it('should redirect with error when code_challenge is provided without code_challenge_method', async () => {
      const codeChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
      const response = await app.request(
        `/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&code_challenge=${codeChallenge}`,
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toBeTruthy();
      const redirectUrl = new URL(location!, 'https://example.com');
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_request');
      expect(redirectUrl.searchParams.get('error_description')).toContain('code_challenge_method');
    });

    it('should reject unsupported code_challenge_method', async () => {
      const codeChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
      const response = await app.request(
        `/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&code_challenge=${codeChallenge}&code_challenge_method=plain`,
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      const redirectUrl = new URL(location!, 'https://example.com');
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_request');
      expect(redirectUrl.searchParams.get('error_description')).toContain('S256');
    });

    it('should reject invalid code_challenge format', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&code_challenge=invalid!@#&code_challenge_method=S256',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      const redirectUrl = new URL(location!, 'https://example.com');
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_request');
      expect(redirectUrl.searchParams.get('error_description')).toContain(
        'Invalid code_challenge format'
      );
    });

    it('should require PKCE with S256 when the client requires PKCE', async () => {
      mockGetClient.mockResolvedValue({
        client_id: 'pkce-client',
        client_secret: 'test-secret',
        redirect_uris: ['https://example.com/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: 'openid profile',
        token_endpoint_auth_method: 'client_secret_basic',
        require_pkce: true,
      });

      const response = await app.request(
        '/authorize?response_type=code&client_id=pkce-client&redirect_uri=https://example.com/callback&scope=openid&state=pkce-required',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const redirectUrl = new URL(response.headers.get('Location')!);
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_request');
      expect(redirectUrl.searchParams.get('error_description')).toContain('PKCE with S256');
      expect(redirectUrl.searchParams.get('state')).toBe('pkce-required');
    });

    it('should require PKCE with S256 for public clients', async () => {
      mockGetClient.mockResolvedValue({
        client_id: 'public-client',
        redirect_uris: ['https://example.com/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: 'openid profile',
        token_endpoint_auth_method: 'none',
      });

      const response = await app.request(
        '/authorize?response_type=code&client_id=public-client&redirect_uri=https://example.com/callback&scope=openid&state=public-pkce',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const redirectUrl = new URL(response.headers.get('Location')!);
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_request');
      expect(redirectUrl.searchParams.get('error_description')).toContain('PKCE with S256');
      expect(redirectUrl.searchParams.get('state')).toBe('public-pkce');
    });
  });

  describe('Parameter Validation - Direct Errors', () => {
    it('should return 400 when response_type is missing', async () => {
      const response = await app.request(
        '/authorize?client_id=test-client&redirect_uri=https://example.com/callback&scope=openid',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      // RFC 6749: missing required parameter should return invalid_request
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('response_type');
    });

    it('should return a local 400 error page when response_type is missing and external UI is configured', async () => {
      env.ENABLE_CONFORMANCE_MODE = 'false';
      await (env.SETTINGS as unknown as MockKVNamespace).put(
        'system_settings',
        JSON.stringify({
          ui: {
            baseUrl: 'https://login.example.com',
          },
        })
      );

      const response = await app.request(
        '/authorize?client_id=test-client&redirect_uri=https://example.com/callback&scope=openid',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(400);
      expect(response.headers.get('Location')).toBeNull();
      const body = await response.text();
      expect(body).toContain('Invalid Authorization Request');
      expect(body).toContain('invalid_request');
      expect(body).toContain('response_type is required');
    });

    it('should return 400 when response_type is unsupported', async () => {
      const response = await app.request(
        '/authorize?response_type=token&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe('unsupported_response_type');
      expect(body.error_description).toContain('response_type');
    });

    it('should return a local 400 error page when response_type is unsupported and external UI is configured', async () => {
      env.ENABLE_CONFORMANCE_MODE = 'false';
      await (env.SETTINGS as unknown as MockKVNamespace).put(
        'system_settings',
        JSON.stringify({
          ui: {
            baseUrl: 'https://login.example.com',
          },
        })
      );

      const response = await app.request(
        '/authorize?response_type=token&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(400);
      expect(response.headers.get('Location')).toBeNull();
      const body = await response.text();
      expect(body).toContain('Invalid Authorization Request');
      expect(body).toContain('unsupported_response_type');
      expect(body).toContain('Unsupported response_type');
    });

    it('escapes attacker-controlled values in local authorization error pages', async () => {
      env.ENABLE_CONFORMANCE_MODE = 'false';
      await (env.SETTINGS as unknown as MockKVNamespace).put(
        'system_settings',
        JSON.stringify({
          ui: {
            baseUrl: 'https://login.example.com',
          },
        })
      );

      const response = await app.request(
        '/authorize?response_type=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(body).not.toContain('<img src=x onerror=alert(1)>');
    });

    it('should return 400 when client_id is missing', async () => {
      const response = await app.request(
        '/authorize?response_type=code&redirect_uri=https://example.com/callback&scope=openid',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('client_id');
    });

    it('should return 400 when redirect_uri is missing', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&scope=openid',
        { method: 'GET' },
        env
      );

      // Returns HTML error page for redirect_uri issues (security)
      expect(response.status).toBe(400);
    });

    it('should return 400 when redirect_uri is invalid URL', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=not-a-url&scope=openid',
        { method: 'GET' },
        env
      );

      // Returns HTML error page for redirect_uri issues (security)
      expect(response.status).toBe(400);
    });

    it('should return a local HTML error page before redirect_uri is validated', async () => {
      env.ENABLE_CONFORMANCE_MODE = 'false';

      const response = await app.request(
        '/authorize?client_id=test-client&redirect_uri=https://example.com/callback&scope=openid',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain('Invalid Authorization Request');
      expect(body).toContain('invalid_request');
      expect(body).toContain('response_type is required');
    });
  });

  describe('Parameter Validation - Redirect Errors', () => {
    it('should redirect with error when scope is missing', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      const redirectUrl = new URL(location!, 'https://example.com');
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_scope');
    });

    it('should redirect with error when scope does not include openid', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=profile',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      const redirectUrl = new URL(location!, 'https://example.com');
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_scope');
      expect(redirectUrl.searchParams.get('error_description')).toContain('openid');
    });

    it('should redirect with error when state is too long', async () => {
      const longState = 'a'.repeat(513);
      const response = await app.request(
        `/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&state=${longState}`,
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      const redirectUrl = new URL(location!, 'https://example.com');
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_request');
      expect(redirectUrl.searchParams.get('error_description')).toContain('state');
    });

    it('should redirect with error when nonce is too long', async () => {
      const longNonce = 'a'.repeat(513);
      const response = await app.request(
        `/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&nonce=${longNonce}`,
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      const redirectUrl = new URL(location!, 'https://example.com');
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_request');
      expect(redirectUrl.searchParams.get('error_description')).toContain('nonce');
    });

    it('should include state in error redirect when state is provided', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=profile&state=test-state',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      const redirectUrl = new URL(location!, 'https://example.com');
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_scope');
      expect(redirectUrl.searchParams.get('state')).toBe('test-state');
    });
  });

  describe('Edge Cases', () => {
    it('issues an authorization code for an existing SSO session when consent is not required', async () => {
      await configureClientSettings(env, {
        'client.sso_enabled': true,
        'client.consent_required': false,
      });
      seedSession(env);
      const authCodeStore = getAuthCodeStore(env);

      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid%20profile&state=session-state&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256',
        {
          method: 'GET',
          headers: {
            Cookie: `authrim_session=${encodeURIComponent(TEST_SESSION_ID)}`,
          },
        },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toBeTruthy();
      const redirectUrl = new URL(location!);
      expect(redirectUrl.origin + redirectUrl.pathname).toBe('https://example.com/callback');
      expect(redirectUrl.searchParams.get('code')).toBeTruthy();
      expect(redirectUrl.searchParams.get('state')).toBe('session-state');
      expect(redirectUrl.searchParams.get('iss')).toBe('https://test.example.com');
      expect(redirectUrl.searchParams.get('session_state')).toBeTruthy();
      expect(authCodeStore.storeCodeRpc).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'default',
          clientId: 'test-client',
          redirectUri: 'https://example.com/callback',
          userId: 'test-user',
          scope: 'openid profile',
          codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
          codeChallengeMethod: 'S256',
          state: 'session-state',
          sid: expect.not.stringMatching('session_test-session'),
        })
      );
    });

    it('issues an authorization code for a confirmed login even when SSO is disabled', async () => {
      await configureClientSettings(env, {
        'client.consent_required': false,
      });
      getChallengeMap(env).set('confirm_login', {
        id: 'confirm_login',
        tenantId: 'default',
        type: 'reauth',
        userId: 'test-user',
        challenge: 'confirm_login',
        metadata: {
          purpose: 'authorize_confirmation',
          authTime: 1_700_000_100,
          sessionUserId: 'test-user',
        },
      });
      const authCodeStore = getAuthCodeStore(env);

      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&state=confirmed-state&_confirmation_challenge=confirm_login',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const redirectUrl = new URL(response.headers.get('Location')!);
      expect(redirectUrl.origin + redirectUrl.pathname).toBe('https://example.com/callback');
      expect(redirectUrl.searchParams.get('code')).toBeTruthy();
      expect(redirectUrl.searchParams.get('state')).toBe('confirmed-state');
      expect(redirectUrl.searchParams.get('error')).toBeNull();
      expect(getChallengeMap(env).has('confirm_login')).toBe(false);
      expect(authCodeStore.storeCodeRpc).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'default',
          clientId: 'test-client',
          userId: 'test-user',
          scope: 'openid',
          state: 'confirmed-state',
        })
      );
    });

    it('issues an authorization code for confirmed consent even when SSO is disabled', async () => {
      seedSession(env);
      getChallengeMap(env).set('confirm_consent', {
        id: 'confirm_consent',
        tenantId: 'default',
        type: 'consent',
        userId: 'test-user',
        challenge: 'confirm_consent',
        metadata: {
          purpose: 'authorize_consent_confirmation',
        },
      });
      const authCodeStore = getAuthCodeStore(env);

      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&state=consent-confirmed-state&_consent_confirmation_challenge=confirm_consent',
        {
          method: 'GET',
          headers: {
            Cookie: `authrim_session=${encodeURIComponent(TEST_SESSION_ID)}`,
          },
        },
        env
      );

      expect(response.status).toBe(302);
      const redirectUrl = new URL(response.headers.get('Location')!);
      expect(redirectUrl.origin + redirectUrl.pathname).toBe('https://example.com/callback');
      expect(redirectUrl.searchParams.get('code')).toBeTruthy();
      expect(redirectUrl.searchParams.get('state')).toBe('consent-confirmed-state');
      expect(redirectUrl.searchParams.get('error')).toBeNull();
      expect(getChallengeMap(env).has('confirm_consent')).toBe(false);
      expect(authCodeStore.storeCodeRpc).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'default',
          clientId: 'test-client',
          userId: 'test-user',
          scope: 'openid',
          state: 'consent-confirmed-state',
        })
      );
    });

    it('allows prompt=none for logged-in OIDC certification clients without global conformance mode', async () => {
      env.ENABLE_CONFORMANCE_MODE = 'false';
      const certificationRedirectUri =
        'https://www.certification.openid.net/test/a/authrim/callback';
      mockGetClient.mockResolvedValue({
        client_id: 'test-client',
        client_secret: 'test-secret',
        redirect_uris: [certificationRedirectUri],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: 'openid profile email',
        token_endpoint_auth_method: 'client_secret_basic',
      });
      await configureClientSettings(env, {
        'client.consent_required': false,
      });
      seedSession(env);
      const authCodeStore = getAuthCodeStore(env);

      const response = await app.request(
        `/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent(
          certificationRedirectUri
        )}&scope=openid&state=prompt-none-state&prompt=none`,
        {
          method: 'GET',
          headers: {
            Cookie: `authrim_session=${encodeURIComponent(TEST_SESSION_ID)}`,
          },
        },
        env
      );

      expect(response.status).toBe(302);
      const redirectUrl = new URL(response.headers.get('Location')!);
      expect(redirectUrl.origin + redirectUrl.pathname).toBe(certificationRedirectUri);
      expect(redirectUrl.searchParams.get('code')).toBeTruthy();
      expect(redirectUrl.searchParams.get('error')).toBeNull();
      expect(redirectUrl.searchParams.get('state')).toBe('prompt-none-state');
      expect(authCodeStore.storeCodeRpc).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'default',
          clientId: 'test-client',
          userId: 'test-user',
          scope: 'openid',
          state: 'prompt-none-state',
        })
      );
    });

    it('issues a handoff token for prompt=none SSO without returning an authorization code', async () => {
      await configureClientSettings(env, {
        'client.sso_enabled': true,
        'client.consent_required': false,
      });
      seedSession(env);

      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&state=handoff-state&prompt=none&handoff=true',
        {
          method: 'GET',
          headers: {
            Cookie: `authrim_session=${encodeURIComponent(TEST_SESSION_ID)}`,
          },
        },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      const redirectUrl = new URL(location!);
      expect(redirectUrl.origin + redirectUrl.pathname).toBe('https://example.com/callback');
      expect(redirectUrl.searchParams.get('handoff_token')).toBeTruthy();
      expect(redirectUrl.searchParams.get('code')).toBeNull();
      expect(redirectUrl.searchParams.get('state')).toBe('handoff-state');

      const handoffToken = redirectUrl.searchParams.get('handoff_token')!;
      expect(getChallengeMap(env).get(`handoff:${handoffToken}`)).toMatchObject({
        type: 'handoff',
        userId: 'test-user',
        challenge: TEST_SESSION_ID,
        metadata: expect.objectContaining({
          client_id: 'test-client',
          state: 'handoff-state',
          aud: 'handoff',
        }),
      });
    });

    it('does not let handoff bypass prompt=none consent requirements', async () => {
      await configureClientSettings(env, {
        'client.sso_enabled': true,
      });
      seedSession(env);

      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&state=handoff-state&prompt=none&handoff=true',
        {
          method: 'GET',
          headers: {
            Cookie: `authrim_session=${encodeURIComponent(TEST_SESSION_ID)}`,
          },
        },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toBeTruthy();
      const redirectUrl = new URL(location!);
      expect(redirectUrl.origin + redirectUrl.pathname).toBe('https://example.com/callback');
      expect(redirectUrl.searchParams.get('error')).toBe('consent_required');
      expect(redirectUrl.searchParams.get('handoff_token')).toBeNull();
    });

    it('ignores caller-supplied consent confirmation flags', async () => {
      await configureClientSettings(env, {
        'client.sso_enabled': true,
      });
      seedSession(env);

      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&state=consent-state&prompt=none&_consent_confirmed=true',
        {
          method: 'GET',
          headers: {
            Cookie: `authrim_session=${encodeURIComponent(TEST_SESSION_ID)}`,
          },
        },
        env
      );

      expect(response.status).toBe(302);
      const redirectUrl = new URL(response.headers.get('Location')!);
      expect(redirectUrl.origin + redirectUrl.pathname).toBe('https://example.com/callback');
      expect(redirectUrl.searchParams.get('error')).toBe('consent_required');
      expect(redirectUrl.searchParams.get('code')).toBeNull();
    });

    it('rejects response_type=none when the tenant profile does not allow session-check responses', async () => {
      await configureClientSettings(env, {
        'client.sso_enabled': true,
        'client.consent_required': false,
      });
      mockGetClient.mockResolvedValue({
        client_id: 'test-client',
        client_secret: 'test-secret',
        redirect_uris: ['https://example.com/callback'],
        grant_types: ['authorization_code'],
        response_types: ['none'],
        scope: 'openid profile email',
        token_endpoint_auth_method: 'client_secret_basic',
      });
      seedSession(env);

      const response = await app.request(
        '/authorize?response_type=none&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&state=check-state&prompt=none',
        {
          method: 'GET',
          headers: {
            Cookie: `authrim_session=${encodeURIComponent(TEST_SESSION_ID)}`,
          },
        },
        env
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: 'unauthorized_client',
        error_description: expect.stringContaining("Response type 'none' is not allowed"),
      });
    });

    it('redirects authenticated users to consent when no prior consent exists', async () => {
      await configureClientSettings(env, {
        'client.sso_enabled': true,
      });
      seedSession(env);

      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid%20email&state=needs-consent',
        {
          method: 'GET',
          headers: {
            Cookie: `authrim_session=${encodeURIComponent(TEST_SESSION_ID)}`,
          },
        },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toContain('/auth/consent');
      const challengeId = new URL(location!, 'https://test.example.com').searchParams.get(
        'challenge_id'
      );
      expect(challengeId).toBeTruthy();
      expect(getChallengeMap(env).get(challengeId!)).toMatchObject({
        type: 'consent',
        userId: 'test-user',
        metadata: expect.objectContaining({
          response_type: 'code',
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid email',
          state: 'needs-consent',
          sessionUserId: 'test-user',
        }),
      });
    });

    it('preserves authorization_details when redirecting authenticated users to consent', async () => {
      env.ENABLE_RAR = 'true';
      await configureClientSettings(env, {
        'client.sso_enabled': true,
      });
      seedSession(env);

      const authorizationDetails = encodeURIComponent(
        JSON.stringify([
          {
            type: 'payment_initiation',
            instructedAmount: { amount: '100.00', currency: 'EUR' },
            creditorAccount: { iban: 'DE89370400440532013000' },
          },
        ])
      );

      const response = await app.request(
        `/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid%20email&state=rar-needs-consent&authorization_details=${authorizationDetails}`,
        {
          method: 'GET',
          headers: {
            Cookie: `authrim_session=${encodeURIComponent(TEST_SESSION_ID)}`,
          },
        },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toContain('/auth/consent');
      const challengeId = new URL(location!, 'https://test.example.com').searchParams.get(
        'challenge_id'
      );
      expect(challengeId).toBeTruthy();
      expect(getChallengeMap(env).get(challengeId!)).toMatchObject({
        type: 'consent',
        metadata: expect.objectContaining({
          state: 'rar-needs-consent',
          authorization_details: JSON.stringify([
            {
              type: 'payment_initiation',
              instructedAmount: { amount: '100.00', currency: 'EUR' },
              creditorAccount: { iban: 'DE89370400440532013000' },
            },
          ]),
        }),
      });
    });

    it('rejects clients that require DPoP binding when no proof is supplied', async () => {
      await configureClientSettings(env, {
        'client.sso_enabled': true,
        'client.consent_required': false,
      });
      seedSession(env);
      mockGetClient.mockResolvedValue({
        client_id: 'test-client',
        client_secret: 'test-secret',
        redirect_uris: ['https://example.com/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: 'openid profile email',
        token_endpoint_auth_method: 'client_secret_basic',
        dpop_bound_access_tokens: true,
      });

      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&state=dpop-required',
        {
          method: 'GET',
          headers: {
            Cookie: `authrim_session=${encodeURIComponent(TEST_SESSION_ID)}`,
          },
        },
        env
      );

      expect(response.status).toBe(302);
      const redirectUrl = new URL(response.headers.get('Location')!);
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_dpop_proof');
      expect(redirectUrl.searchParams.get('error_description')).toBe(
        'DPoP proof is required for this client'
      );
      expect(redirectUrl.searchParams.get('state')).toBe('dpop-required');
    });

    it('renders the built-in login form with client display metadata from the login challenge', async () => {
      getChallengeMap(env).set('login_challenge', {
        id: 'login_challenge',
        type: 'login',
        metadata: {
          client_name: 'Example RP',
          logo_uri: 'https://example.com/logo.png',
          policy_uri: 'https://example.com/privacy',
          tos_uri: 'https://example.com/terms',
        },
      });

      const response = await app.request(
        '/flow/login?challenge_id=login_challenge',
        { method: 'GET' },
        env
      );
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain('Signing in to <strong>Example RP</strong>');
      expect(html).toContain('https://example.com/logo.png');
      expect(html).toContain('https://example.com/privacy');
      expect(html).toContain('https://example.com/terms');
      expect(html).toContain('name="challenge_id" value="login_challenge"');
    });

    it('drops unsafe client display metadata URLs from the built-in login form', async () => {
      getChallengeMap(env).set('unsafe_login_challenge', {
        id: 'unsafe_login_challenge',
        type: 'login',
        metadata: {
          client_name: '<img src=x onerror=alert(1)>',
          logo_uri: 'javascript:alert(1)',
          policy_uri: 'javascript:alert(1)',
          tos_uri: 'data:text/html,<script>alert(1)</script>',
        },
      });

      const response = await app.request(
        '/flow/login?challenge_id=unsafe_login_challenge',
        { method: 'GET' },
        env
      );
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(html).not.toContain('javascript:alert');
      expect(html).not.toContain('data:text/html');
      expect(html).not.toContain('<img src="javascript:');
      expect(html).not.toContain('href="javascript:');
    });

    it('processes built-in login by creating a session and restoring the authorization request', async () => {
      env.ENABLE_TEST_ENDPOINTS = 'true';
      getChallengeMap(env).set('login_challenge', {
        id: 'login_challenge',
        type: 'login',
        userId: 'anonymous',
        metadata: {
          response_type: 'code',
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid profile',
          state: 'login-state',
          nonce: 'login-nonce',
          code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
          code_challenge_method: 'S256',
          acr_values: 'urn:authrim:acr:mfa',
        },
      });

      const response = await app.request(
        '/flow/login',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            challenge_id: 'login_challenge',
            username: 'login-user@example.com',
            password: 'ignored-by-stub',
          }),
        },
        env
      );

      expect(response.status).toBe(302);
      expect(response.headers.get('Set-Cookie')).toContain('authrim_session=');
      const location = response.headers.get('Location')!;
      expect(location).toContain('/authorize?');
      const redirect = new URL(location, 'https://test.example.com');
      expect(redirect.searchParams.get('response_type')).toBe('code');
      expect(redirect.searchParams.get('client_id')).toBe('test-client');
      expect(redirect.searchParams.get('state')).toBe('login-state');
      expect(redirect.searchParams.get('nonce')).toBe('login-nonce');
      expect(redirect.searchParams.get('code_challenge_method')).toBe('S256');
      const confirmationChallenge = redirect.searchParams.get('_confirmation_challenge');
      expect(confirmationChallenge).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
      expect(getChallengeMap(env).get(confirmationChallenge!)).toEqual(
        expect.objectContaining({
          type: 'reauth',
          userId: expect.any(String),
          metadata: expect.objectContaining({
            purpose: 'authorize_confirmation',
            authTime: expect.any(Number),
          }),
        })
      );
      expect(getChallengeMap(env).has('login_challenge')).toBe(false);
    });

    it('renders and processes built-in reauthentication confirmation', async () => {
      getChallengeMap(env).set('reauth_challenge', {
        id: 'reauth_challenge',
        type: 'reauth',
        userId: 'test-user',
        metadata: {
          response_type: 'code',
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid',
          state: 'reauth-state',
          prompt: 'login',
          authTime: 1700000000,
          sessionUserId: 'test-user',
        },
      });

      const getResponse = await app.request(
        '/flow/confirm?challenge_id=reauth_challenge',
        { method: 'GET' },
        env
      );
      expect(getResponse.status).toBe(200);
      await expect(getResponse.text()).resolves.toContain('Re-authentication Required');

      const postResponse = await app.request(
        '/flow/confirm',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            challenge_id: 'reauth_challenge',
          }),
        },
        env
      );

      expect(postResponse.status).toBe(302);
      const redirect = new URL(postResponse.headers.get('Location')!, 'https://test.example.com');
      expect(redirect.pathname).toBe('/authorize');
      expect(redirect.searchParams.get('response_type')).toBe('code');
      expect(redirect.searchParams.get('client_id')).toBe('test-client');
      expect(redirect.searchParams.get('state')).toBe('reauth-state');
      expect(redirect.searchParams.get('prompt')).toBe('login');
      const confirmationChallenge = redirect.searchParams.get('_confirmation_challenge');
      expect(confirmationChallenge).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
      expect(getChallengeMap(env).get(confirmationChallenge!)).toEqual(
        expect.objectContaining({
          type: 'reauth',
          userId: 'test-user',
          metadata: expect.objectContaining({
            purpose: 'authorize_confirmation',
            authTime: 1700000000,
            sessionUserId: 'test-user',
          }),
        })
      );
      expect(getChallengeMap(env).has('reauth_challenge')).toBe(false);
    });

    it('should not reuse cached UI settings across different SETTINGS bindings', async () => {
      const envWithUi = createMockEnv();
      envWithUi.ENABLE_CONFORMANCE_MODE = 'false';
      await (envWithUi.SETTINGS as unknown as MockKVNamespace).put(
        'system_settings',
        JSON.stringify({
          ui: {
            baseUrl: 'https://login.example.com',
          },
        })
      );

      const firstResponse = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&state=test-state',
        { method: 'GET' },
        envWithUi
      );

      expect(firstResponse.status).toBe(302);
      expect(firstResponse.headers.get('Location')).toContain('https://login.example.com/login');

      const envWithoutUi = createMockEnv();
      envWithoutUi.ENABLE_CONFORMANCE_MODE = 'false';

      const secondResponse = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&state=test-state',
        { method: 'GET' },
        envWithoutUi
      );

      expect(secondResponse.status).toBe(302);
      const secondLocation = secondResponse.headers.get('Location');
      expect(secondLocation).not.toContain('https://login.example.com/login');

      const redirectUrl = new URL(secondLocation!, 'https://example.com');
      expect(redirectUrl.searchParams.get('error')).toBe('temporarily_unavailable');
      expect(redirectUrl.searchParams.get('error_description')).toBe('Login UI is not configured');
    });

    it('should clean up consent challenge when consent UI is not configured', async () => {
      env.ENABLE_CONFORMANCE_MODE = 'false';
      await (env.SETTINGS as unknown as MockKVNamespace).put(
        'settings:client:test-client:client',
        JSON.stringify({
          'client.sso_enabled': true,
        })
      );
      seedSession(env);

      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&state=test-state',
        {
          method: 'GET',
          headers: {
            Cookie: `authrim_session=${encodeURIComponent(TEST_SESSION_ID)}`,
          },
        },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toBeTruthy();
      const redirectUrl = new URL(location!, 'https://example.com');
      expect(redirectUrl.searchParams.get('error')).toBe('temporarily_unavailable');
      expect(redirectUrl.searchParams.get('error_description')).toBe('Login UI is not configured');
      expect(getChallengeMap(env).size).toBe(0);
    });

    it('routes OIDC certification clients to built-in consent without global conformance mode', async () => {
      env.ENABLE_CONFORMANCE_MODE = 'false';
      env.UI_URL = 'https://login.example.com';
      const certificationRedirectUri =
        'https://www.certification.openid.net/test/a/authrim/callback';
      mockGetClient.mockResolvedValue({
        client_id: 'test-client',
        client_secret: 'test-secret',
        redirect_uris: [certificationRedirectUri],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: 'openid profile email',
        token_endpoint_auth_method: 'client_secret_basic',
      });
      await configureClientSettings(env, {
        'client.sso_enabled': true,
      });
      seedSession(env);

      const response = await app.request(
        `/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent(
          certificationRedirectUri
        )}&scope=openid%20email&state=needs-consent`,
        {
          method: 'GET',
          headers: {
            Cookie: `authrim_session=${encodeURIComponent(TEST_SESSION_ID)}`,
          },
        },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toBeTruthy();
      const redirectUrl = new URL(location!, 'https://test.example.com');
      expect(redirectUrl.pathname).toBe('/auth/consent');
      const challengeId = redirectUrl.searchParams.get('challenge_id');
      expect(challengeId).toBeTruthy();
      expect(getChallengeMap(env).get(challengeId!)).toMatchObject({
        type: 'consent',
        userId: 'test-user',
        metadata: expect.objectContaining({
          client_id: 'test-client',
          redirect_uri: certificationRedirectUri,
          scope: 'openid email',
          state: 'needs-consent',
        }),
      });
    });

    it('should handle multiple scopes and redirect to login', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid%20profile%20email',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      // Valid request should redirect to login
      expect(location).toContain('/flow/login');
    });

    it('should reject invalid client_id format', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=invalid@client&redirect_uri=https://example.com/callback&scope=openid',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('client_id');
    });

    it('should redirect with error for empty state', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&state=',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      const redirectUrl = new URL(location!, 'https://example.com');
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_request');
      expect(redirectUrl.searchParams.get('error_description')).toContain('state');
    });

    it('should reject request with unregistered client', async () => {
      mockGetClient.mockResolvedValue(null);

      const response = await app.request(
        '/authorize?response_type=code&client_id=unknown-client&redirect_uri=https://example.com/callback&scope=openid',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toBe('client_id is invalid');
    });

    it('should return a local 400 error page for an unknown client when external UI is configured', async () => {
      env.ENABLE_CONFORMANCE_MODE = 'false';
      mockGetClient.mockResolvedValue(null);
      await (env.SETTINGS as unknown as MockKVNamespace).put(
        'system_settings',
        JSON.stringify({
          ui: {
            baseUrl: 'https://login.example.com',
          },
        })
      );

      const response = await app.request(
        '/authorize?response_type=code&client_id=unknown-client&redirect_uri=https://example.com/callback&scope=openid',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(400);
      expect(response.headers.get('Location')).toBeNull();
      const body = await response.text();
      expect(body).toContain('Invalid Client');
      expect(body).toContain('invalid_request');
      expect(body).toContain('client_id is invalid');
    });

    it('should reject request with mismatched redirect_uri', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://malicious.com/callback&scope=openid',
        { method: 'GET' },
        env
      );

      // Redirect URI mismatch returns error page (security)
      expect(response.status).toBe(400);
    });

    it('should return a local client configuration error when no redirect_uris are registered', async () => {
      mockGetClient.mockResolvedValue({
        client_id: 'no-redirect-client',
        client_secret: 'test-secret',
        redirect_uris: [],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: 'openid profile email',
        token_endpoint_auth_method: 'client_secret_basic',
      });

      const response = await app.request(
        '/authorize?response_type=code&client_id=no-redirect-client&redirect_uri=https://example.com/callback&scope=openid',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain('Client Configuration Error');
      expect(html).toContain('Client has no registered redirect URIs');
    });

    it('should reject custom error_uri outside the registered redirect origin', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&error_uri=https://evil.example.com/error',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain('Invalid Custom Redirect URI');
      expect(html).toContain('error_uri');
    });

    it('should reject scopes outside the client requestable_scopes whitelist', async () => {
      mockGetClient.mockResolvedValue({
        client_id: 'scoped-client',
        client_secret: 'test-secret',
        redirect_uris: ['https://example.com/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: 'openid profile email',
        requestable_scopes: ['openid', 'profile'],
        token_endpoint_auth_method: 'client_secret_basic',
      });

      const response = await app.request(
        '/authorize?response_type=code&client_id=scoped-client&redirect_uri=https://example.com/callback&scope=openid%20email&state=scoped-state',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const redirectUrl = new URL(response.headers.get('Location')!);
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_scope');
      expect(redirectUrl.searchParams.get('error_description')).toContain('email');
      expect(redirectUrl.searchParams.get('state')).toBe('scoped-state');
    });

    it('should reject scopes outside the client allowed_scopes whitelist', async () => {
      mockGetClient.mockResolvedValue({
        client_id: 'allowed-scopes-client',
        client_secret: 'test-secret',
        redirect_uris: ['https://example.com/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: 'openid profile email',
        allowed_scopes: ['openid', 'profile'],
        token_endpoint_auth_method: 'client_secret_basic',
      });

      const response = await app.request(
        '/authorize?response_type=code&client_id=allowed-scopes-client&redirect_uri=https://example.com/callback&scope=openid%20email&state=allowed-state',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const redirectUrl = new URL(response.headers.get('Location')!);
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_scope');
      expect(redirectUrl.searchParams.get('error_description')).toContain('email');
      expect(redirectUrl.searchParams.get('state')).toBe('allowed-state');
    });

    it('should reject authorization_details when RAR is not enabled', async () => {
      const authorizationDetails = encodeURIComponent(
        JSON.stringify([
          {
            type: 'payment_initiation',
            instructedAmount: { amount: '100.00', currency: 'EUR' },
            creditorAccount: { iban: 'DE89370400440532013000' },
          },
        ])
      );

      const response = await app.request(
        `/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&state=rar-disabled&authorization_details=${authorizationDetails}`,
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const redirectUrl = new URL(response.headers.get('Location')!);
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_request');
      expect(redirectUrl.searchParams.get('error_description')).toContain(
        'authorization_details parameter is not supported'
      );
      expect(redirectUrl.searchParams.get('state')).toBe('rar-disabled');
    });

    it('should reject malformed authorization_details when RAR is enabled', async () => {
      env.ENABLE_RAR = 'true';

      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&state=rar-json&authorization_details=%7Bnot-json',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const redirectUrl = new URL(response.headers.get('Location')!);
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_authorization_details');
      expect(redirectUrl.searchParams.get('error_description')).toBe(
        'authorization_details must be valid JSON'
      );
      expect(redirectUrl.searchParams.get('state')).toBe('rar-json');
    });

    it('should store sanitized authorization_details on the authorization code', async () => {
      env.ENABLE_RAR = 'true';
      await configureClientSettings(env, {
        'client.sso_enabled': true,
        'client.consent_required': false,
      });
      seedSession(env);
      const authCodeStore = getAuthCodeStore(env);
      const authorizationDetails = encodeURIComponent(
        JSON.stringify([
          {
            type: 'payment_initiation',
            instructedAmount: { amount: '100.00', currency: 'EUR' },
            creditorAccount: { iban: 'DE89370400440532013000' },
          },
        ])
      );

      const response = await app.request(
        `/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&state=rar-stored&authorization_details=${authorizationDetails}`,
        {
          method: 'GET',
          headers: {
            Cookie: `authrim_session=${encodeURIComponent(TEST_SESSION_ID)}`,
          },
        },
        env
      );

      expect(response.status).toBe(302);
      const redirectUrl = new URL(response.headers.get('Location')!);
      expect(redirectUrl.searchParams.get('code')).toBeTruthy();
      expect(authCodeStore.storeCodeRpc).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: 'test-client',
          state: 'rar-stored',
          authorizationDetails: JSON.stringify([
            {
              type: 'payment_initiation',
              instructedAmount: { amount: '100.00', currency: 'EUR' },
              creditorAccount: { iban: 'DE89370400440532013000' },
            },
          ]),
        })
      );
    });

    it('should preserve PAR authorization_details on the authorization code', async () => {
      env.ENABLE_RAR = 'true';
      await configureClientSettings(env, {
        'client.sso_enabled': true,
        'client.consent_required': false,
      });
      seedSession(env);
      const authCodeStore = getAuthCodeStore(env);
      const authorizationDetails = JSON.stringify([
        {
          type: 'payment_initiation',
          instructedAmount: { amount: '100.00', currency: 'EUR' },
          creditorAccount: { iban: 'DE89370400440532013000' },
        },
      ]);
      const requestUri = 'urn:ietf:params:oauth:request_uri:par_test';
      env.PAR_REQUEST_STORE = createMockPARRequestStore({
        client_id: 'test-client',
        response_type: 'code',
        redirect_uri: 'https://example.com/callback',
        scope: 'openid',
        state: 'rar-par-stored',
        authorization_details: authorizationDetails,
      }) as unknown as Env['PAR_REQUEST_STORE'];

      const response = await app.request(
        `/authorize?client_id=test-client&request_uri=${encodeURIComponent(requestUri)}`,
        {
          method: 'GET',
          headers: {
            Cookie: `authrim_session=${encodeURIComponent(TEST_SESSION_ID)}`,
          },
        },
        env
      );

      expect(response.status).toBe(302);
      const redirectUrl = new URL(response.headers.get('Location')!);
      expect(redirectUrl.searchParams.get('code')).toBeTruthy();
      expect(authCodeStore.storeCodeRpc).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: 'test-client',
          state: 'rar-par-stored',
          authorizationDetails: authorizationDetails,
        })
      );
    });

    it('should return error when redirect_uri is missing and client has multiple redirect_uris', async () => {
      // Default mock client has multiple redirect_uris
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&scope=openid&state=test-state',
        { method: 'GET' },
        env
      );

      // Should return error page when redirect_uri is required but missing
      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain('Missing Redirect URI');
      expect(body).toContain('redirect_uri is required when multiple redirect URIs are registered');
    });

    it('should use default redirect_uri when client has only one registered', async () => {
      // Mock client with single redirect_uri
      mockGetClient.mockResolvedValue({
        client_id: 'single-uri-client',
        client_secret: 'test-secret',
        redirect_uris: ['https://single.example.com/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: 'openid profile email',
        token_endpoint_auth_method: 'client_secret_basic',
      });

      const response = await app.request(
        '/authorize?response_type=code&client_id=single-uri-client&scope=openid&state=test-state',
        { method: 'GET' },
        env
      );

      // Should redirect to login (using default redirect_uri)
      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toBeTruthy();
      expect(location).toContain('/flow/login');
    });
  });
});
