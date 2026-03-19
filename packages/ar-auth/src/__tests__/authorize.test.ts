import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { authorizeHandler } from '../authorize';
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

/**
 * Mock SessionStore Durable Object with RPC methods
 */
function createMockSessionStore() {
  const sessions = new Map<string, any>();

  return {
    idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-session-store-id' }),
    get: vi.fn().mockReturnValue({
      getSessionRpc: vi.fn().mockImplementation(async (sessionId: string) => {
        return sessions.get(sessionId) || null;
      }),
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
    app.get('/authorize', authorizeHandler);
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
      expect(redirectUrl.searchParams.get('error_description')).toBe(
        'Login UI is not configured'
      );
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
      expect(redirectUrl.searchParams.get('error_description')).toBe(
        'Login UI is not configured'
      );
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
      expect(redirectUrl.searchParams.get('error_description')).toBe(
        'Login UI is not configured'
      );
      expect(getChallengeMap(env).size).toBe(0);
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
