/**
 * Test Fixtures for Integration Tests
 *
 * Provides common test data, mock clients, and helper functions
 * for integration testing of OIDC flows.
 */

import type { Env } from '../types/env';
import { generateSecureRandomString, generateCodeChallenge } from '../utils/crypto';

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
  // Generate a test key pair with unique key ID for each test
  // This prevents key caching issues in the userinfo handler
  const uniqueKeyId = `test-key-${Date.now()}-${generateSecureRandomString(8)}`;
  const { generateKeySet } = await import('../utils/keys');
  const keySet = await generateKeySet(uniqueKeyId, 2048);

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

    constructor(getKey: () => { kid: string; privatePEM: string }) {
      this.getKey = getKey;
    }

    async fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const path = url.pathname;

      if (path.endsWith('/active-with-private')) {
        return jsonResponse(this.getKey());
      }

      if (path.endsWith('/rotate')) {
        return jsonResponse({ success: true, key: this.getKey() });
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
            const hasSecret = sql.includes('client_secret');
            const hasDpopFlag = sql.includes('dpop_bound_access_tokens');
            const client_id = boundParams[0];
            const client_secret = hasSecret ? boundParams[1] : undefined;
            const redirect_uris = hasSecret ? boundParams[2] : boundParams[1];
            const grant_types = hasSecret ? boundParams[3] : boundParams[2];
            const response_types = hasSecret ? boundParams[4] : boundParams[3];
            const scope = hasSecret ? boundParams[5] : boundParams[4];
            const dpop_bound_access_tokens = hasDpopFlag
              ? boundParams[hasSecret ? 6 : 5]
              : undefined;

            const clientData = {
              client_id,
              client_secret,
              redirect_uris: JSON.parse(redirect_uris || '[]'),
              grant_types: JSON.parse(grant_types || '[]'),
              response_types: JSON.parse(response_types || '[]'),
              scope,
              dpop_bound_access_tokens,
            };

            await this.clientsKV.put(client_id, JSON.stringify(clientData));
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
          return null;
        },
        all: async () => ({ results: [] }),
      };

      return statement;
    }
  }

  const clientsKV = new MockKVNamespace();
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
    KEY_ID: uniqueKeyId,
    PRIVATE_KEY_PEM: keySet.privatePEM,
    PUBLIC_JWK_JSON: JSON.stringify(keySet.publicJWK),
    KEY_MANAGER_SECRET: 'test-key-manager-secret',
    AVATARS: new MockR2Bucket() as unknown as R2Bucket,
    KEY_MANAGER: createDurableObjectNamespace(
      () => new MockKeyManager(() => ({ kid: uniqueKeyId, privatePEM: keySet.privatePEM }))
    ),
    AUTH_CODE_STORE: createDurableObjectNamespace(() => new MockAuthorizationCodeStore()),
    PAR_REQUEST_STORE: createDurableObjectNamespace(() => new MockPARRequestStore()),
    DPOP_JTI_STORE: createDurableObjectNamespace(() => new MockDPoPJTIStore()),
    SESSION_STORE: createDurableObjectNamespace(() => new MockAuthorizationCodeStore()),
    REFRESH_TOKEN_ROTATOR: createDurableObjectNamespace(() => new MockRefreshTokenRotator()),
    CHALLENGE_STORE: createDurableObjectNamespace(() => new MockAuthorizationCodeStore()),
    RATE_LIMITER: createDurableObjectNamespace(() => new MockAuthorizationCodeStore()),
    USER_CODE_RATE_LIMITER: createDurableObjectNamespace(() => new MockAuthorizationCodeStore()),
    TOKEN_REVOCATION_STORE: createDurableObjectNamespace(() => new MockAuthorizationCodeStore()),
    DEVICE_CODE_STORE: createDurableObjectNamespace(() => new MockAuthorizationCodeStore()),
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
