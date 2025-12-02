/**
 * Test Fixtures for Integration Tests
 *
 * Provides common test data, mock clients, and helper functions
 * for integration testing of OIDC flows.
 */

import type { Env } from '@authrim/shared/types/env';
import { generateSecureRandomString, generateCodeChallenge } from '@authrim/shared/utils/crypto';

/**
 * Shared key set for all tests in the suite.
 * This prevents module-level key caching issues in userinfo.ts
 * where the cached signing key would mismatch with newly generated keys.
 */
let sharedKeySet: {
  kid: string;
  privatePEM: string;
  publicJWK: Record<string, unknown>;
} | null = null;

/**
 * Get or create the shared key set for tests.
 * All tests in the suite will use the same keys, avoiding cache invalidation issues.
 */
async function getSharedKeySet(): Promise<{
  kid: string;
  privatePEM: string;
  publicJWK: Record<string, unknown>;
}> {
  if (sharedKeySet) {
    return sharedKeySet;
  }

  const { generateKeySet } = await import('@authrim/shared/utils/keys');
  const kid = `test-key-shared-${Date.now()}`;
  const keySet = await generateKeySet(kid, 2048);

  sharedKeySet = {
    kid,
    privatePEM: keySet.privatePEM,
    publicJWK: keySet.publicJWK,
  };

  return sharedKeySet;
}

/**
 * Mock client configuration
 */
export interface MockClient {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  scope: string;
  /** Allow claims parameter to request claims without corresponding scope (OIDC conformance) */
  allow_claims_without_scope?: boolean;
}

/**
 * Mock user data
 */
export interface MockUser {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
  preferred_username: string;
}

/**
 * Test clients
 */
export const testClients: Record<string, MockClient> = {
  confidential: {
    client_id: 'test-client-confidential',
    client_secret: 'test-secret-123',
    redirect_uris: ['https://example.com/callback', 'http://localhost:3000/callback'],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    scope: 'openid profile email',
  },
  public: {
    client_id: 'test-client-public',
    redirect_uris: ['https://example.com/callback'],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    scope: 'openid profile',
  },
  /** Client with flexible claims parameter handling (for OIDC conformance tests) */
  conformance: {
    client_id: 'test-client-conformance',
    client_secret: 'conformance-secret-456',
    redirect_uris: ['https://example.com/callback'],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    scope: 'openid profile email address phone',
    allow_claims_without_scope: true,
  },
};

/**
 * Test users
 */
export const testUsers: Record<string, MockUser> = {
  john: {
    sub: 'user-john-123',
    email: 'john@example.com',
    email_verified: true,
    name: 'John Doe',
    preferred_username: 'johndoe',
  },
  jane: {
    sub: 'user-jane-456',
    email: 'jane@example.com',
    email_verified: true,
    name: 'Jane Smith',
    preferred_username: 'janesmith',
  },
};

/**
 * Create a mock Cloudflare environment for testing
 * Note: This function is async because it needs to generate test keys
 */
export async function createMockEnv(): Promise<Env> {
  // Use shared key set across all tests to avoid module-level key caching issues
  // in userinfo.ts - the cached signing key will match the shared keys
  const keySet = await getSharedKeySet();

  const jsonResponse = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  // Mock KV namespace implementation
  class MockKVNamespace implements KVNamespace {
    private store: Map<string, { value: string; expiration?: number }> = new Map();

    async get(key: string): Promise<string | null> {
      const entry = this.store.get(key);
      if (!entry) return null;

      if (entry.expiration && Date.now() > entry.expiration) {
        this.store.delete(key);
        return null;
      }

      return entry.value;
    }

    async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
      const expiration = options?.expirationTtl
        ? Date.now() + options.expirationTtl * 1000
        : undefined;
      this.store.set(key, { value, expiration });
    }

    async delete(key: string): Promise<void> {
      this.store.delete(key);
    }

    async list(): Promise<any> {
      return { keys: Array.from(this.store.keys()).map((name) => ({ name })) };
    }

    async getWithMetadata(): Promise<any> {
      throw new Error('Not implemented');
    }
  }

  class MockR2Bucket implements R2Bucket {
    private store = new Map<string, R2ObjectBody | null>();
    async get(key: string): Promise<R2ObjectBody | null> {
      return this.store.get(key) || null;
    }
    async put(key: string, value: any): Promise<void> {
      this.store.set(key, value);
    }
    async delete(key: string): Promise<void> {
      this.store.delete(key);
    }
    async head(key: string): Promise<R2Object | null> {
      return this.store.has(key) ? ({ key } as R2Object) : null;
    }
  }

  function createDurableObjectNamespace<T extends { fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response> | Response }>(
    factory: () => T
  ): DurableObjectNamespace {
    const objects = new Map<string, T>();
    return {
      idFromName(name: string) {
        return name as unknown as DurableObjectId;
      },
      idFromString(id: string) {
        return id as unknown as DurableObjectId;
      },
      newUniqueId() {
        return crypto.randomUUID() as unknown as DurableObjectId;
      },
      get(id: DurableObjectId) {
        const key = String(id);
        if (!objects.has(key)) {
          objects.set(key, factory());
        }
        return objects.get(key)! as unknown as DurableObjectStub;
      },
    } as unknown as DurableObjectNamespace;
  }

  class MockAuthorizationCodeStore {
    private codes: Map<
      string,
      {
        code: string;
        clientId: string;
        redirectUri: string;
        userId: string;
        scope: string;
        codeChallenge?: string;
        codeChallengeMethod?: 'S256' | 'plain';
        nonce?: string;
        state?: string;
        claims?: string;
        authTime?: number;
        acr?: string;
        dpopJkt?: string;
        used: boolean;
        expiresAt: number;
      }
    > = new Map();

    async fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === 'POST' && (path.endsWith('/code') || path.endsWith('/code/create'))) {
        const body = (await request.json()) as any;
        const ttlMs = typeof body.ttlMs === 'number' ? body.ttlMs : 120000;
        this.codes.set(body.code, {
          ...body,
          used: false,
          expiresAt: Date.now() + ttlMs,
        });
        return jsonResponse({ success: true });
      }

      if (request.method === 'POST' && path.endsWith('/code/consume')) {
        const body = (await request.json()) as {
          code: string;
          clientId: string;
          codeVerifier?: string;
        };

        const record = this.codes.get(body.code);
        if (!record || record.used || record.expiresAt <= Date.now()) {
          return jsonResponse(
            {
              error: 'invalid_grant',
              error_description: 'Authorization code is invalid or expired',
            },
            400
          );
        }

        if (record.clientId !== body.clientId) {
          return jsonResponse(
            {
              error: 'invalid_grant',
              error_description: 'Client mismatch for authorization code',
            },
            400
          );
        }

        if (record.codeChallenge) {
          if (!body.codeVerifier) {
            return jsonResponse(
              {
                error: 'invalid_grant',
                error_description: 'code_verifier required for PKCE validation',
              },
              400
            );
          }

          const expectedChallenge =
            record.codeChallengeMethod === 'plain'
              ? body.codeVerifier
              : await generateCodeChallenge(body.codeVerifier);

          if (expectedChallenge !== record.codeChallenge) {
            return jsonResponse(
              {
                error: 'invalid_grant',
                error_description: 'Invalid code_verifier',
              },
              400
            );
          }
        }

        record.used = true;
        this.codes.set(record.code, record);

        return jsonResponse({
          userId: record.userId,
          scope: record.scope,
          redirectUri: record.redirectUri,
          nonce: record.nonce,
          state: record.state,
          claims: record.claims,
          authTime: record.authTime ?? Math.floor(Date.now() / 1000),
          acr: record.acr,
          dpopJkt: record.dpopJkt,
        });
      }

      return jsonResponse({ error: 'not_found' }, 404);
    }
  }

  class MockPARRequestStore {
    private requests: Map<
      string,
      { data: Record<string, unknown>; clientId?: string; expiresAt: number }
    > = new Map();

    async fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === 'POST' && path.endsWith('/request')) {
        const body = (await request.json()) as {
          requestUri: string;
          data: Record<string, unknown>;
          ttl?: number;
        };

        this.requests.set(body.requestUri, {
          data: body.data,
          clientId: (body.data as { client_id?: string }).client_id,
          expiresAt: Date.now() + (body.ttl ?? 600) * 1000,
        });

        return jsonResponse({ success: true });
      }

      if (request.method === 'POST' && path.endsWith('/request/consume')) {
        const body = (await request.json()) as { requestUri: string; client_id?: string };
        const stored = this.requests.get(body.requestUri);

        if (!stored || stored.expiresAt <= Date.now()) {
          return jsonResponse({ error: 'invalid_request_uri' }, 404);
        }

        if (body.client_id && stored.clientId && stored.clientId !== body.client_id) {
          return jsonResponse(
            { error: 'invalid_request', error_description: 'client_id mismatch' },
            400
          );
        }

        this.requests.delete(body.requestUri);
        return jsonResponse(stored.data);
      }

      return jsonResponse({ error: 'not_found' }, 404);
    }
  }

  class MockDPoPJTIStore {
    private jtis = new Map<string, number>();

    async fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === 'POST' && path.endsWith('/check-and-store')) {
        const body = (await request.json()) as { jti: string; ttl?: number };
        const existing = this.jtis.get(body.jti);

        if (existing && existing > Date.now()) {
          return jsonResponse(
            { error: 'use_dpop_nonce', error_description: 'DPoP proof jti already used' },
            400
          );
        }

        this.jtis.set(body.jti, Date.now() + (body.ttl ?? 3600) * 1000);
        return jsonResponse({ success: true });
      }

      return jsonResponse({ error: 'not_found' }, 404);
    }
  }

  class MockKeyManager {
    private getKey: () => { kid: string; privatePEM: string };
    private publicJWK: Record<string, unknown>;

    constructor(
      getKey: () => { kid: string; privatePEM: string },
      publicJWK: Record<string, unknown>
    ) {
      this.getKey = getKey;
      this.publicJWK = publicJWK;
    }

    async fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const path = url.pathname;

      if (path.endsWith('/active-with-private') || path === '/internal/active-with-private') {
        return jsonResponse(this.getKey());
      }

      if (path.endsWith('/rotate')) {
        return jsonResponse({ success: true, key: this.getKey() });
      }

      // JWKS endpoint for token introspection
      // Called as http://internal/jwks from token-introspection.ts
      if (path.endsWith('/jwks') || path === '/jwks') {
        return jsonResponse({ keys: [this.publicJWK] });
      }

      return jsonResponse({ error: 'not_found' }, 404);
    }
  }

  class MockRefreshTokenRotator {
    private families = new Map<string, { token: string; userId: string; clientId: string; scope: string; expiresAt: number }>();

    async fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === 'POST' && path.endsWith('/family')) {
        const body = (await request.json()) as {
          token: string;
          userId: string;
          clientId: string;
          scope: string;
          ttl: number;
        };

        this.families.set(body.token, {
          token: body.token,
          userId: body.userId,
          clientId: body.clientId,
          scope: body.scope,
          expiresAt: Date.now() + body.ttl * 1000,
        });

        return jsonResponse({ success: true });
      }

      if (request.method === 'GET' && path.endsWith('/validate')) {
        const token = url.searchParams.get('token') || '';
        const record = this.families.get(token);

        if (!record || record.expiresAt <= Date.now()) {
          return jsonResponse({ valid: false }, 404);
        }

        return jsonResponse({
          valid: true,
          token: record,
        });
      }

      return jsonResponse({ error: 'not_found' }, 404);
    }
  }

  /**
   * Mock Challenge Store for Passkey/Consent tests
   * Stores temporary challenges for WebAuthn registration/authentication
   */
  class MockChallengeStore {
    private challenges = new Map<
      string,
      {
        id: string;
        challenge: string;
        userId?: string;
        clientId?: string;
        redirectUri?: string;
        scope?: string;
        state?: string;
        nonce?: string;
        claims?: string;
        consumed: boolean;
        expiresAt: number;
      }
    >();

    async fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const path = url.pathname;

      // GET /challenge/:id - チャレンジ取得
      if (request.method === 'GET' && path.includes('/challenge')) {
        const id = url.searchParams.get('id') || path.split('/').pop() || '';
        const record = this.challenges.get(id);

        if (!record || record.expiresAt <= Date.now()) {
          return jsonResponse({ error: 'not_found' }, 404);
        }

        return jsonResponse({
          id: record.id,
          challenge: record.challenge,
          userId: record.userId,
          clientId: record.clientId,
          redirectUri: record.redirectUri,
          scope: record.scope,
          state: record.state,
          nonce: record.nonce,
          claims: record.claims,
          consumed: record.consumed,
        });
      }

      // POST /challenge - チャレンジ保存
      if (request.method === 'POST' && path.endsWith('/challenge')) {
        const body = (await request.json()) as {
          id: string;
          challenge: string;
          userId?: string;
          clientId?: string;
          redirectUri?: string;
          scope?: string;
          state?: string;
          nonce?: string;
          claims?: string;
          ttl?: number;
        };

        this.challenges.set(body.id, {
          id: body.id,
          challenge: body.challenge,
          userId: body.userId,
          clientId: body.clientId,
          redirectUri: body.redirectUri,
          scope: body.scope,
          state: body.state,
          nonce: body.nonce,
          claims: body.claims,
          consumed: false,
          expiresAt: Date.now() + (body.ttl ?? 300) * 1000,
        });

        return jsonResponse({ success: true });
      }

      // POST /challenge/consume - チャレンジ消費（原子的操作）
      if (request.method === 'POST' && path.endsWith('/challenge/consume')) {
        const body = (await request.json()) as { id: string };
        const record = this.challenges.get(body.id);

        if (!record || record.expiresAt <= Date.now()) {
          return jsonResponse({ error: 'not_found', error_description: 'Challenge not found or expired' }, 404);
        }

        if (record.consumed) {
          return jsonResponse({ error: 'already_consumed', error_description: 'Challenge already consumed' }, 400);
        }

        record.consumed = true;
        this.challenges.set(body.id, record);

        return jsonResponse({
          id: record.id,
          challenge: record.challenge,
          userId: record.userId,
          clientId: record.clientId,
          redirectUri: record.redirectUri,
          scope: record.scope,
          state: record.state,
          nonce: record.nonce,
          claims: record.claims,
        });
      }

      return jsonResponse({ error: 'not_found' }, 404);
    }
  }

  /**
   * Mock Session Store for session management tests
   * Stores user sessions with authentication metadata
   */
  class MockSessionStore {
    private sessions = new Map<
      string,
      {
        id: string;
        userId: string;
        email?: string;
        authTime: number;
        acr?: string;
        amr?: string[];
        expiresAt: number;
      }
    >();

    async fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const path = url.pathname;

      // POST /session - 新規セッション作成
      if (request.method === 'POST' && path.endsWith('/session')) {
        const body = (await request.json()) as {
          id: string;
          userId: string;
          email?: string;
          authTime?: number;
          acr?: string;
          amr?: string[];
          ttl?: number;
        };

        const session = {
          id: body.id,
          userId: body.userId,
          email: body.email,
          authTime: body.authTime ?? Math.floor(Date.now() / 1000),
          acr: body.acr,
          amr: body.amr,
          expiresAt: Date.now() + (body.ttl ?? 86400) * 1000,
        };

        this.sessions.set(body.id, session);

        return jsonResponse({ success: true, session });
      }

      // GET /session/:id - セッション取得
      if (request.method === 'GET' && path.includes('/session')) {
        const id = url.searchParams.get('id') || path.split('/').pop() || '';
        const session = this.sessions.get(id);

        if (!session || session.expiresAt <= Date.now()) {
          return jsonResponse({ error: 'not_found' }, 404);
        }

        return jsonResponse(session);
      }

      // DELETE /session/:id - セッション削除
      if (request.method === 'DELETE' && path.includes('/session')) {
        const id = url.searchParams.get('id') || path.split('/').pop() || '';
        const existed = this.sessions.delete(id);

        return jsonResponse({ success: existed });
      }

      return jsonResponse({ error: 'not_found' }, 404);
    }
  }

  /**
   * Mock Rate Limiter for device flow and security tests
   * Implements rate limiting with failure tracking
   */
  class MockRateLimiter {
    private failures = new Map<string, { count: number; blockedUntil: number }>();
    private readonly maxAttempts: number;
    private readonly blockDurationMs: number;

    constructor(maxAttempts = 5, blockDurationMs = 300000) {
      this.maxAttempts = maxAttempts;
      this.blockDurationMs = blockDurationMs;
    }

    async fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const path = url.pathname;

      // POST /check - ブロック状態確認
      if (request.method === 'POST' && path.endsWith('/check')) {
        const body = (await request.json()) as { key: string };
        const record = this.failures.get(body.key);

        if (record && record.blockedUntil > Date.now()) {
          return jsonResponse({
            blocked: true,
            remainingMs: record.blockedUntil - Date.now(),
            attempts: record.count,
          });
        }

        return jsonResponse({
          blocked: false,
          attempts: record?.count ?? 0,
        });
      }

      // POST /record-failure - 失敗記録
      if (request.method === 'POST' && path.endsWith('/record-failure')) {
        const body = (await request.json()) as { key: string };
        const record = this.failures.get(body.key) || { count: 0, blockedUntil: 0 };

        record.count += 1;

        if (record.count >= this.maxAttempts) {
          record.blockedUntil = Date.now() + this.blockDurationMs;
        }

        this.failures.set(body.key, record);

        return jsonResponse({
          success: true,
          attempts: record.count,
          blocked: record.count >= this.maxAttempts,
        });
      }

      // POST /reset - レート制限リセット
      if (request.method === 'POST' && path.endsWith('/reset')) {
        const body = (await request.json()) as { key: string };
        this.failures.delete(body.key);

        return jsonResponse({ success: true });
      }

      return jsonResponse({ error: 'not_found' }, 404);
    }
  }

  /**
   * Mock Device Code Store for Device Authorization Flow tests
   * Stores device codes with user code mapping
   */
  class MockDeviceCodeStore {
    private deviceCodes = new Map<
      string,
      {
        deviceCode: string;
        userCode: string;
        clientId: string;
        scope: string;
        verificationUri: string;
        verificationUriComplete?: string;
        expiresIn: number;
        interval: number;
        status: 'pending' | 'authorized' | 'denied' | 'expired';
        userId?: string;
        expiresAt: number;
      }
    >();
    private userCodeIndex = new Map<string, string>(); // userCode -> deviceCode

    async fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const path = url.pathname;

      // POST /store - デバイスコード保存
      if (request.method === 'POST' && path.endsWith('/store')) {
        const body = (await request.json()) as {
          deviceCode: string;
          userCode: string;
          clientId: string;
          scope: string;
          verificationUri: string;
          verificationUriComplete?: string;
          expiresIn: number;
          interval: number;
        };

        const record = {
          ...body,
          status: 'pending' as const,
          expiresAt: Date.now() + body.expiresIn * 1000,
        };

        this.deviceCodes.set(body.deviceCode, record);
        // Store normalized user code (uppercase, no dashes)
        const normalizedUserCode = body.userCode.toUpperCase().replace(/-/g, '');
        this.userCodeIndex.set(normalizedUserCode, body.deviceCode);

        return jsonResponse({ success: true });
      }

      // POST /get-by-user-code - ユーザーコードで検索
      if (request.method === 'POST' && path.endsWith('/get-by-user-code')) {
        const body = (await request.json()) as { userCode: string };
        // Normalize the input user code
        const normalizedUserCode = body.userCode.toUpperCase().replace(/-/g, '');
        const deviceCode = this.userCodeIndex.get(normalizedUserCode);

        if (!deviceCode) {
          return jsonResponse({ error: 'not_found' }, 404);
        }

        const record = this.deviceCodes.get(deviceCode);
        if (!record || record.expiresAt <= Date.now()) {
          return jsonResponse({ error: 'expired' }, 404);
        }

        return jsonResponse(record);
      }

      // GET /device-code/:code - デバイスコード取得
      if (request.method === 'GET' && path.includes('/device-code')) {
        const code = url.searchParams.get('code') || path.split('/').pop() || '';
        const record = this.deviceCodes.get(code);

        if (!record || record.expiresAt <= Date.now()) {
          return jsonResponse({ error: 'not_found' }, 404);
        }

        return jsonResponse(record);
      }

      // POST /authorize - デバイス認可
      if (request.method === 'POST' && path.endsWith('/authorize')) {
        const body = (await request.json()) as { deviceCode: string; userId: string };
        const record = this.deviceCodes.get(body.deviceCode);

        if (!record || record.expiresAt <= Date.now()) {
          return jsonResponse({ error: 'not_found' }, 404);
        }

        record.status = 'authorized';
        record.userId = body.userId;
        this.deviceCodes.set(body.deviceCode, record);

        return jsonResponse({ success: true });
      }

      // POST /deny - デバイス拒否
      if (request.method === 'POST' && path.endsWith('/deny')) {
        const body = (await request.json()) as { deviceCode: string };
        const record = this.deviceCodes.get(body.deviceCode);

        if (!record || record.expiresAt <= Date.now()) {
          return jsonResponse({ error: 'not_found' }, 404);
        }

        record.status = 'denied';
        this.deviceCodes.set(body.deviceCode, record);

        return jsonResponse({ success: true });
      }

      return jsonResponse({ error: 'not_found' }, 404);
    }
  }

  /**
   * Mock Token Revocation Store for token revocation tests
   * Stores revoked token JTIs with TTL
   */
  class MockTokenRevocationStore {
    private revokedTokens = new Map<string, { revokedAt: number; reason?: string; expiresAt: number }>();

    async fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const path = url.pathname;

      // POST /revoke - トークン失効
      if (request.method === 'POST' && path.endsWith('/revoke')) {
        const body = (await request.json()) as { jti: string; ttl: number; reason?: string };

        this.revokedTokens.set(body.jti, {
          revokedAt: Date.now(),
          reason: body.reason,
          expiresAt: Date.now() + body.ttl * 1000,
        });

        return jsonResponse({ success: true });
      }

      // GET /check - 失効確認
      if (request.method === 'GET' && path.endsWith('/check')) {
        const jti = url.searchParams.get('jti') || '';
        const record = this.revokedTokens.get(jti);

        if (!record) {
          return jsonResponse({ revoked: false });
        }

        // Clean up expired entries
        if (record.expiresAt <= Date.now()) {
          this.revokedTokens.delete(jti);
          return jsonResponse({ revoked: false });
        }

        return jsonResponse({
          revoked: true,
          revokedAt: record.revokedAt,
          reason: record.reason,
        });
      }

      return jsonResponse({ error: 'not_found' }, 404);
    }
  }

  // Mock D1 Database implementation
  class MockD1Database {
    private clientsKV: MockKVNamespace;

    constructor(clientsKV: MockKVNamespace) {
      this.clientsKV = clientsKV;
    }

    prepare(sql: string) {
      let boundParams: any[] = [];

      const statement = {
        bind: (...params: any[]) => {
          boundParams = params;
          return statement;
        },
        run: async () => {
          if (sql.includes('INSERT INTO oauth_clients')) {
            // Parse column names from SQL to properly map bound parameters
            const hasSecret = sql.includes('client_secret');
            const hasDpopFlag = sql.includes('dpop_bound_access_tokens');
            const hasClaimsFlag = sql.includes('allow_claims_without_scope');

            // Build client data object by parsing SQL columns and bound params
            // This is a simplified parser that handles our test SQL patterns
            let paramIndex = 0;
            const client_id = boundParams[paramIndex++];
            const client_secret = hasSecret ? boundParams[paramIndex++] : undefined;
            const redirect_uris = boundParams[paramIndex++];
            const grant_types = boundParams[paramIndex++];
            const response_types = boundParams[paramIndex++];
            const scope = boundParams[paramIndex++];

            // Optional flags
            let allow_claims_without_scope: number | undefined;
            let dpop_bound_access_tokens: number | undefined;

            if (hasClaimsFlag) {
              allow_claims_without_scope = boundParams[paramIndex++];
            }
            if (hasDpopFlag) {
              dpop_bound_access_tokens = boundParams[paramIndex++];
            }

            // Store data in D1-compatible format (JSON strings for arrays)
            // The getClient function in kv.ts will JSON.parse these fields
            const clientData: Record<string, unknown> = {
              client_id,
              client_secret,
              redirect_uris, // Keep as JSON string (like real D1)
              grant_types, // Keep as JSON string (like real D1)
              response_types, // Keep as JSON string (like real D1)
              scope,
            };

            // Add optional fields if present
            // Store as numbers (0/1) to match real D1 behavior
            // getClient() in kv.ts checks `result.allow_claims_without_scope === 1`
            if (allow_claims_without_scope !== undefined) {
              clientData.allow_claims_without_scope = allow_claims_without_scope;
            }
            if (dpop_bound_access_tokens !== undefined) {
              clientData.dpop_bound_access_tokens = dpop_bound_access_tokens;
            }

            await this.clientsKV.put(client_id as string, JSON.stringify(clientData));
            return { success: true };
          }

          return { success: true };
        },
        first: async () => {
          if (sql.includes('SELECT') && sql.includes('oauth_clients')) {
            const clientId = boundParams[0];
            const stored = clientId ? await this.clientsKV.get(clientId) : null;
            return stored ? JSON.parse(stored) : null;
          }
          // Mock user data for UserInfo tests
          if (sql.includes('SELECT') && sql.includes('users')) {
            const userId = boundParams[0];
            // Return test user data for known test users
            if (userId === 'test-user') {
              return {
                id: 'test-user',
                email: 'test@example.com',
                email_verified: 1,
                name: 'Test User',
                given_name: 'Test',
                family_name: 'User',
                preferred_username: 'testuser',
                phone_number: '+81 90-1234-5678',
                phone_number_verified: 1,
                // Note: userinfo.ts expects address_json field, not address
                address_json: JSON.stringify({
                  formatted: '123 Test St, Test City, TC 12345, Test Country',
                  street_address: '123 Test St',
                  locality: 'Test City',
                  region: 'TC',
                  postal_code: '12345',
                  country: 'Test Country',
                }),
                picture: 'https://example.com/avatar.png',
              };
            }
          }
          return null;
        },
        all: async () => ({ results: [] }),
      };

      return statement;
    }
  }

  const clientsKV = new MockKVNamespace();
  const clientsCacheKV = new MockKVNamespace();
  const authCodesKV = new MockKVNamespace();
  const stateKV = new MockKVNamespace();
  const nonceKV = new MockKVNamespace();
  const revokedKV = new MockKVNamespace();
  const refreshKV = new MockKVNamespace();
  const settingsKV = new MockKVNamespace();

  const env: Env = {
    AUTH_CODES: authCodesKV as unknown as KVNamespace,
    STATE_STORE: stateKV as unknown as KVNamespace,
    NONCE_STORE: nonceKV as unknown as KVNamespace,
    CLIENTS: clientsKV as unknown as KVNamespace,
    CLIENTS_CACHE: clientsCacheKV as unknown as KVNamespace,
    REVOKED_TOKENS: revokedKV as unknown as KVNamespace,
    REFRESH_TOKENS: refreshKV as unknown as KVNamespace,
    SETTINGS: settingsKV as unknown as KVNamespace,
    DB: new MockD1Database(clientsKV) as any,
    ISSUER_URL: 'http://localhost:8787',
    TOKEN_EXPIRY: '3600',
    REFRESH_TOKEN_EXPIRY: '604800',
    CODE_EXPIRY: '120',
    STATE_EXPIRY: '300',
    NONCE_EXPIRY: '300',
    KEY_ID: keySet.kid,
    PRIVATE_KEY_PEM: keySet.privatePEM,
    PUBLIC_JWK_JSON: JSON.stringify(keySet.publicJWK),
    KEY_MANAGER_SECRET: 'test-key-manager-secret',
    AVATARS: new MockR2Bucket() as unknown as R2Bucket,
    KEY_MANAGER: createDurableObjectNamespace(
      () =>
        new MockKeyManager(
          () => ({ kid: keySet.kid, privatePEM: keySet.privatePEM }),
          keySet.publicJWK
        )
    ),
    AUTH_CODE_STORE: createDurableObjectNamespace(() => new MockAuthorizationCodeStore()),
    PAR_REQUEST_STORE: createDurableObjectNamespace(() => new MockPARRequestStore()),
    DPOP_JTI_STORE: createDurableObjectNamespace(() => new MockDPoPJTIStore()),
    SESSION_STORE: createDurableObjectNamespace(() => new MockSessionStore()),
    REFRESH_TOKEN_ROTATOR: createDurableObjectNamespace(() => new MockRefreshTokenRotator()),
    CHALLENGE_STORE: createDurableObjectNamespace(() => new MockChallengeStore()),
    RATE_LIMITER: createDurableObjectNamespace(() => new MockRateLimiter()),
    USER_CODE_RATE_LIMITER: createDurableObjectNamespace(() => new MockRateLimiter()),
    TOKEN_REVOCATION_STORE: createDurableObjectNamespace(() => new MockTokenRevocationStore()),
    DEVICE_CODE_STORE: createDurableObjectNamespace(() => new MockDeviceCodeStore()),
    CIBA_REQUEST_STORE: createDurableObjectNamespace(() => new MockAuthorizationCodeStore()),
  };

  return env;
}

/**
 * Generate random state parameter
 * Uses cryptographically secure random generation
 */
export function generateState(): string {
  return `state-${Date.now()}-${generateSecureRandomString(12)}`;
}

/**
 * Generate random nonce parameter
 * Uses cryptographically secure random generation
 */
export function generateNonce(): string {
  return `nonce-${Date.now()}-${generateSecureRandomString(12)}`;
}

/**
 * Build authorization request URL
 */
export function buildAuthorizationUrl(params: {
  issuer: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  state?: string;
  nonce?: string;
  response_type?: string;
  claims?: string;
}): string {
  const url = new URL(`${params.issuer}/authorize`);
  url.searchParams.set('client_id', params.client_id);
  url.searchParams.set('redirect_uri', params.redirect_uri);
  url.searchParams.set('scope', params.scope);
  url.searchParams.set('response_type', params.response_type || 'code');

  if (params.state) {
    url.searchParams.set('state', params.state);
  }

  if (params.nonce) {
    url.searchParams.set('nonce', params.nonce);
  }

  if (params.claims) {
    url.searchParams.set('claims', params.claims);
  }

  return url.toString();
}

/**
 * Parse authorization response
 */
export function parseAuthorizationResponse(redirectUri: string): {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
} {
  const url = new URL(redirectUri);
  const params = url.searchParams;

  return {
    code: params.get('code') || undefined,
    state: params.get('state') || undefined,
    error: params.get('error') || undefined,
    error_description: params.get('error_description') || undefined,
  };
}

/**
 * Build token request body
 */
export function buildTokenRequestBody(params: {
  grant_type: string;
  code: string;
  client_id: string;
  redirect_uri: string;
  client_secret?: string;
}): URLSearchParams {
  const body = new URLSearchParams();
  body.set('grant_type', params.grant_type);
  body.set('code', params.code);
  body.set('client_id', params.client_id);
  body.set('redirect_uri', params.redirect_uri);

  if (params.client_secret) {
    body.set('client_secret', params.client_secret);
  }

  return body;
}

/**
 * Parse ID token claims (without verification)
 */
export function parseIdToken(idToken: string): any {
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }

  const payload = parts[1];
  if (!payload) {
    throw new Error('Invalid JWT payload');
  }

  // Convert base64url to base64 (Workers-compatible)
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');

  // Decode using atob (available in test environment)
  const decoded = atob(base64);

  return JSON.parse(decoded);
}

/**
 * Wait for a specified duration
 */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
