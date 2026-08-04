/**
 * Tests for Dynamic Client Registration Handler
 * https://openid.net/specs/openid-connect-registration-1_0.html
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core/types/env';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    buildIssuerUrl: (env: Partial<Env>, tenantId?: string) => {
      if (env.BASE_DOMAIN) {
        const resolvedTenantId = tenantId || env.DEFAULT_TENANT_ID || 'default';
        const primaryTenantId = env.PRIMARY_TENANT_ID || env.DEFAULT_TENANT_ID || 'default';
        if (env.NAKED_DOMAIN_AS_ISSUER === 'true' && resolvedTenantId === primaryTenantId) {
          return `https://${env.BASE_DOMAIN}`;
        }
        return `https://${resolvedTenantId}.${env.BASE_DOMAIN}`;
      }
      return env.ISSUER_URL || '';
    },
  };
});

// Mock crypto utils to handle ESM barrel export resolution issues in Vitest
vi.mock('@authrim/ar-lib-core/utils/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core/utils/crypto')>();
  return {
    ...actual,
    hashClientSecret: vi.fn(async (secret: string) => {
      const encoder = new TextEncoder();
      const data = encoder.encode(secret);
      const hashBuffer = await (globalThis as unknown as { crypto: Crypto }).crypto.subtle.digest(
        'SHA-256',
        data
      );
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    }),
  };
});

vi.mock('../tenant-alias-directory', () => ({
  resolveTenantDiscoveryAliasDirectoryInput: vi.fn(async (_env, input) => ({
    ...input,
    routeProjection: {},
  })),
  prepareTenantDiscoveryAliasDirectory: vi.fn(async () => undefined),
  activateTenantDiscoveryAliasDirectory: vi.fn(async () => undefined),
  ensureActiveTenantDiscoveryAliasDirectory: vi.fn(async () => undefined),
}));

import { buildConformanceTestUserId, registerHandler } from '../register';

// Helper to create mock D1Database
function createMockDB() {
  const mockStatement = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(null),
    all: vi.fn().mockResolvedValue({ results: [] }),
    run: vi.fn().mockResolvedValue({ success: true }),
  };

  return {
    prepare: vi.fn().mockReturnValue(mockStatement),
    batch: vi.fn(async (statements: D1PreparedStatement[]) =>
      statements.map(() => ({
        success: true,
        meta: { changes: 1 },
      }))
    ),
    _mockStatement: mockStatement,
  } as unknown as D1Database & { _mockStatement: typeof mockStatement };
}

// Type for dynamic client registration response
type RegistrationResponse = Record<string, unknown>;

// Mock environment factory (partial - only what's needed for these tests)
function createMockEnv(options?: { db?: D1Database }): Env {
  return {
    ISSUER_URL: 'https://id.example.com',
    ACCESS_TOKEN_EXPIRY: '3600',
    AUTH_CODE_EXPIRY: '120',
    STATE_EXPIRY: '300',
    NONCE_EXPIRY: '300',
    REFRESH_TOKEN_EXPIRY: '2592000',
    ENABLE_HTTP_REDIRECT: 'true',
    PRIVATE_KEY_PEM: 'mock-private-key',
    PUBLIC_JWK_JSON: '{"kty":"RSA"}',
    KEY_ID: 'test-key-id',
    DCR_ENABLED: 'true', // Enable DCR for tests
    STATE_STORE: {} as KVNamespace,
    NONCE_STORE: {} as KVNamespace,
    CLIENTS_CACHE: {} as KVNamespace,
    DB: options?.db ?? createMockDB(),
    AVATARS: {} as R2Bucket,
    KEY_MANAGER: {} as unknown as Env['KEY_MANAGER'],
    SESSION_STORE: {} as unknown as Env['SESSION_STORE'],
    AUTH_CODE_STORE: {} as unknown as Env['AUTH_CODE_STORE'],
    REFRESH_TOKEN_ROTATOR: {} as unknown as Env['REFRESH_TOKEN_ROTATOR'],
    CHALLENGE_STORE: {} as DurableObjectNamespace,
    RATE_LIMITER: {} as unknown as Env['RATE_LIMITER'],
    USER_CODE_RATE_LIMITER: {} as DurableObjectNamespace,
    PAR_REQUEST_STORE: {} as unknown as Env['PAR_REQUEST_STORE'],
    DPOP_JTI_STORE: {} as DurableObjectNamespace,
    TOKEN_REVOCATION_STORE: {} as DurableObjectNamespace,
    DEVICE_CODE_STORE: {} as DurableObjectNamespace,
    CIBA_REQUEST_STORE: {} as DurableObjectNamespace,
  } as unknown as Env;
}

// Default mock environment (re-created in beforeEach)
let mockEnv: Env;

// Mock KV storage
const mockKVStore = new Map<string, string>();

// Mock KV namespace with get, put, delete
const createMockKV = (): KVNamespace => {
  return {
    get: async (key: string) => mockKVStore.get(key) || null,
    put: async (key: string, value: string) => {
      mockKVStore.set(key, value);
    },
    delete: async (key: string) => {
      mockKVStore.delete(key);
    },
  } as unknown as KVNamespace;
};

function getLastBindArgs(env: Env): unknown[] {
  const db = env.DB as unknown as ReturnType<typeof createMockDB>;
  const calls = db._mockStatement.bind.mock.calls;
  return calls[calls.length - 1] ?? [];
}

function getOauthClientInsertPlaceholderCount(env: Env): number {
  const db = env.DB as unknown as ReturnType<typeof createMockDB>;
  const call = vi
    .mocked(db.prepare)
    .mock.calls.find(([sql]) => String(sql).includes('INSERT INTO oauth_clients'));
  return (String(call?.[0] ?? '').match(/\?/g) ?? []).length;
}

function attachTenantContexts(
  c: { env: Env; set(key: string, value: unknown): void },
  tenantId: string
) {
  c.set('tenantId', tenantId);
  c.set('tenantMetadataContext', {
    tenantId,
    coreDb: c.env.DB,
  });
  c.set('accountDataContext', {
    tenantId,
    accountId: 'test-account',
    coreDb: c.env.DB,
    piiDb: c.env.DB,
  });
}

describe('Dynamic Client Registration Handler', () => {
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    mockKVStore.clear();

    // Create fresh mock environment with working DB
    mockEnv = createMockEnv();

    // Create fresh app instance
    app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      attachTenantContexts(c as never, 'default');
      await next();
    });
    app.post('/register', registerHandler);
    app.post('/oauth/admin-agent/register', registerHandler);

    // Setup mock KV namespaces
    mockEnv.CLIENTS_CACHE = createMockKV();
  });

  describe('Successful Registration', () => {
    it('registers a restricted Agent public client without an initial access token', async () => {
      const res = await app.request(
        '/oauth/admin-agent/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            redirect_uris: ['http://127.0.0.1:57939/callback/session'],
            client_name: 'Codex',
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
          }),
        },
        { ...mockEnv, ENABLE_AGENT_MCP: 'true' } as Env
      );

      expect(res.status).toBe(201);
      const json = (await res.json()) as RegistrationResponse;
      expect(json.token_endpoint_auth_method).toBe('none');
      expect(json.require_pkce).toBe(true);
      expect(json.scope).toBe('agent:read agent:user-data:read agent:write');
      expect(json.client_secret).toBeUndefined();
      expect(json.client_secret_expires_at).toBeUndefined();
      expect(json.registration_access_token).toBeUndefined();
      expect(json.registration_client_uri).toBeUndefined();
      expect(json.redirect_uris).toEqual(['http://127.0.0.1:57939/callback/session']);
      const stored = getLastBindArgs({ ...mockEnv, ENABLE_AGENT_MCP: 'true' } as Env);
      expect(stored).toHaveLength(72);
      expect(getOauthClientInsertPlaceholderCount(mockEnv)).toBe(stored.length);
      expect(stored[55]).toBeNull();
      expect(stored[65]).toBe('restricted_dcr');
      expect(stored[66]).toEqual(expect.any(Number));
      expect(stored[67]).toBeNull();
      expect(stored[68]).toBe(0);
      expect(stored[69]).toBe('default');
    });

    it('does not expand an explicitly requested restricted Agent scope subset', async () => {
      const res = await app.request(
        '/oauth/admin-agent/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            redirect_uris: ['http://127.0.0.1:57939/callback'],
            token_endpoint_auth_method: 'none',
            scope: 'agent:read',
          }),
        },
        { ...mockEnv, ENABLE_AGENT_MCP: 'true' } as Env
      );

      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ scope: 'agent:read' });
      const stored = getLastBindArgs({ ...mockEnv, ENABLE_AGENT_MCP: 'true' } as Env);
      expect(stored).toContain('["agent:read"]');
    });

    it('fails closed when restricted Agent registration is disabled', async () => {
      const res = await app.request(
        '/oauth/admin-agent/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            redirect_uris: ['http://127.0.0.1:57939/callback'],
            token_endpoint_auth_method: 'none',
          }),
        },
        { ...mockEnv, ENABLE_AGENT_MCP: 'false' } as Env
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'access_denied' });
    });

    it('rejects confidential metadata in the restricted Agent profile', async () => {
      const res = await app.request(
        '/oauth/admin-agent/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            redirect_uris: ['http://127.0.0.1:57939/callback'],
            token_endpoint_auth_method: 'client_secret_basic',
          }),
        },
        { ...mockEnv, ENABLE_AGENT_MCP: 'true' } as Env
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_client_metadata' });
    });

    it('rejects a non-loopback HTTP redirect in the restricted Agent profile', async () => {
      const res = await app.request(
        '/oauth/admin-agent/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            redirect_uris: ['http://client.example.com/callback'],
            token_endpoint_auth_method: 'none',
          }),
        },
        { ...mockEnv, ENABLE_AGENT_MCP: 'true' } as Env
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_redirect_uri' });
    });

    it('enforces the per-tenant active restricted registration limit', async () => {
      const database = mockEnv.DB as unknown as ReturnType<typeof createMockDB>;
      database._mockStatement.first.mockResolvedValueOnce({ total: 20 });
      const res = await app.request(
        '/oauth/admin-agent/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            redirect_uris: ['http://127.0.0.1:57939/callback'],
            token_endpoint_auth_method: 'none',
          }),
        },
        { ...mockEnv, ENABLE_AGENT_MCP: 'true' } as Env
      );

      expect(res.status).toBe(429);
      expect(await res.json()).toMatchObject({
        error: 'access_denied',
        error_description: 'Agent self-service client registration limit reached',
      });
    });

    it('fails closed on a concurrent restricted registration slot collision', async () => {
      const database = mockEnv.DB as unknown as ReturnType<typeof createMockDB>;
      database._mockStatement.first
        .mockResolvedValueOnce({ total: 0 })
        .mockResolvedValueOnce({ total: 1 });
      database._mockStatement.run
        .mockResolvedValueOnce({ success: true })
        .mockRejectedValue(
          new Error(
            'UNIQUE constraint failed: oauth_clients.tenant_id, oauth_clients.agent_access_registration_slot'
          )
        );
      const res = await app.request(
        '/oauth/admin-agent/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            redirect_uris: ['http://127.0.0.1:57939/callback'],
            token_endpoint_auth_method: 'none',
          }),
        },
        { ...mockEnv, ENABLE_AGENT_MCP: 'true' } as Env
      );

      expect(res.status).toBe(429);
      expect(await res.json()).toMatchObject({
        error: 'access_denied',
        error_description: expect.stringContaining('retry registration'),
      });
    });

    it('should register a client with minimal required fields', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(201);

      const json = (await res.json()) as RegistrationResponse;
      expect(json).toHaveProperty('client_id');
      expect(json).toHaveProperty('client_secret');
      expect(json).toHaveProperty('client_id_issued_at');
      expect(json).toHaveProperty('client_secret_expires_at');
      expect(json.client_secret_expires_at).toBe(0); // Never expires
      expect(json.redirect_uris).toEqual(['https://example.com/callback']);
      expect(json.token_endpoint_auth_method).toBe('client_secret_basic'); // Default
      expect(json.grant_types).toEqual(['authorization_code']); // Default
      expect(json.response_types).toEqual(['code']); // Default
      expect(json.application_type).toBe('web'); // Default

      // Verify client_id format (base64url with prefix, ~135 characters total)
      expect(json.client_id).toMatch(/^client_[A-Za-z0-9_-]+$/);
      expect((json.client_id as string).length).toBeGreaterThanOrEqual(135); // 'client_' (7 chars) + ~128 chars

      // Verify client_secret is base64url encoded
      expect(json.client_secret).toMatch(/^[A-Za-z0-9_-]+$/);

      // Verify Cache-Control headers
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Pragma')).toBe('no-cache');
    });

    it('registers a CIBA-only private_key_jwt client without redirect URIs', async () => {
      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_types: ['urn:openid:params:grant-type:ciba'],
            response_types: [],
            token_endpoint_auth_method: 'private_key_jwt',
            token_endpoint_auth_signing_alg: 'PS256',
            jwks: {
              keys: [
                {
                  kty: 'RSA',
                  use: 'sig',
                  alg: 'PS256',
                  kid: 'client-key',
                  n: 'n',
                  e: 'AQAB',
                  x5c: [btoa('leaf-certificate')],
                },
              ],
            },
            backchannel_token_delivery_mode: 'ping',
            backchannel_client_notification_endpoint:
              'https://certification.openid.net/ciba-notification-endpoint',
            backchannel_authentication_request_signing_alg: 'PS256',
            backchannel_user_code_parameter: false,
            id_token_signed_response_alg: 'PS256',
            tls_client_certificate_bound_access_tokens: true,
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(201);
      await expect(res.json()).resolves.toMatchObject({
        redirect_uris: [],
        grant_types: ['urn:openid:params:grant-type:ciba'],
        response_types: [],
        token_endpoint_auth_method: 'private_key_jwt',
        token_endpoint_auth_signing_alg: 'PS256',
        backchannel_token_delivery_mode: 'ping',
        backchannel_authentication_request_signing_alg: 'PS256',
        id_token_signed_response_alg: 'PS256',
        tls_client_certificate_bound_access_tokens: true,
      });
      const bindCalls = (mockEnv.DB as unknown as ReturnType<typeof createMockDB>)._mockStatement
        .bind.mock.calls;
      expect(
        bindCalls.some((args) =>
          args.some(
            (value) => value === 'https://certification.openid.net/ciba-notification-endpoint'
          )
        )
      ).toBe(true);
    });

    it('registers a CIBA client with refresh-token grant without redirect URIs', async () => {
      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_types: ['urn:openid:params:grant-type:ciba', 'refresh_token'],
            response_types: [],
            token_endpoint_auth_method: 'private_key_jwt',
            token_endpoint_auth_signing_alg: 'PS256',
            jwks: {
              keys: [
                {
                  kty: 'RSA',
                  use: 'sig',
                  alg: 'PS256',
                  kid: 'client-key',
                  n: 'n',
                  e: 'AQAB',
                  x5c: [btoa('leaf-certificate')],
                },
              ],
            },
            backchannel_token_delivery_mode: 'poll',
            backchannel_authentication_request_signing_alg: 'PS256',
            id_token_signed_response_alg: 'PS256',
            tls_client_certificate_bound_access_tokens: true,
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(201);
      await expect(res.json()).resolves.toMatchObject({
        redirect_uris: [],
        grant_types: ['urn:openid:params:grant-type:ciba', 'refresh_token'],
        response_types: [],
        backchannel_token_delivery_mode: 'poll',
      });
    });

    it('stores issuer URL as the default access-token resource for authorization-code clients', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(201);

      const args = getLastBindArgs(mockEnv);
      expect(args).toHaveLength(72);
      expect(args).toContain('https://id.example.com');
    });

    it('uses tenant client.default_resource before the issuer URL default', async () => {
      mockEnv.SETTINGS = createMockKV();
      await mockEnv.SETTINGS.put(
        'settings:tenant:default:client',
        JSON.stringify({ 'client.default_resource': 'https://api.example.com/' })
      );

      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(201);

      const args = getLastBindArgs(mockEnv);
      expect(args).toHaveLength(72);
      expect(args).toContain('https://api.example.com/');
      expect(args).not.toContain('https://id.example.com');
    });

    it('should register a client with all optional fields', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback', 'https://example.com/callback2'],
        client_name: 'Test Application',
        client_uri: 'https://example.com',
        logo_uri: 'https://example.com/logo.png',
        contacts: ['admin@example.com', 'support@example.com'],
        tos_uri: 'https://example.com/tos',
        policy_uri: 'https://example.com/privacy',
        jwks_uri: 'https://example.com/.well-known/jwks.json',
        software_id: 'test-software-123',
        software_version: '1.0.0',
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        application_type: 'native',
        scope: 'openid profile email',
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(201);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.client_name).toBe('Test Application');
      expect(json.client_uri).toBe('https://example.com');
      expect(json.logo_uri).toBe('https://example.com/logo.png');
      expect(json.contacts).toEqual(['admin@example.com', 'support@example.com']);
      expect(json.tos_uri).toBe('https://example.com/tos');
      expect(json.policy_uri).toBe('https://example.com/privacy');
      expect(json.jwks_uri).toBe('https://example.com/.well-known/jwks.json');
      expect(json.software_id).toBe('test-software-123');
      expect(json.software_version).toBe('1.0.0');
      expect(json.token_endpoint_auth_method).toBe('client_secret_post');
      expect(json.grant_types).toEqual(['authorization_code', 'refresh_token']);
      expect(json.response_types).toEqual(['code']);
      expect(json.application_type).toBe('native');
      expect(json.scope).toBe('openid profile email');
    });

    it('should default require_pkce to true for public authorization code clients', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(201);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.require_pkce).toBe(true);
    });

    it('uses the request host for registration_client_uri in multi-tenant mode', async () => {
      const localApp = new Hono<{ Bindings: Env }>();
      localApp.use('*', async (c, next) => {
        attachTenantContexts(c as never, 'tenant1');
        await next();
      });
      localApp.post('/register', registerHandler);

      const response = await localApp.fetch(
        new Request('https://tenant1.example.com/register', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            redirect_uris: ['https://example.com/callback'],
          }),
        }),
        {
          ...mockEnv,
          BASE_DOMAIN: 'example.com',
          DEFAULT_TENANT_ID: 'tenant1',
        } as Env
      );

      const json = (await response.json()) as RegistrationResponse;
      expect(json.registration_client_uri).toMatch(/^https:\/\/tenant1\.example\.com\/clients\//);
    });

    it('should store client metadata in D1 database', async () => {
      const mockDB = createMockDB();
      const localMockEnv = createMockEnv({ db: mockDB });
      localMockEnv.CLIENTS_CACHE = createMockKV();

      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        client_name: 'Test Client',
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        localMockEnv
      );

      expect(res.status).toBe(201);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.client_id).toBeDefined();
      expect(json.client_name).toBe('Test Client');

      // Verify client was stored in the core relational source of truth.
      expect(mockDB.prepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO oauth_clients')
      );

      const insertSql = vi
        .mocked(mockDB.prepare)
        .mock.calls.map(([sql]) => String(sql))
        .find((sql) => sql.includes('INSERT INTO oauth_clients'));
      expect(insertSql).toBeDefined();
      const insertMatch = insertSql?.match(
        /INSERT INTO oauth_clients\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)/
      );
      expect(insertMatch).toBeTruthy();
      const columnCount = insertMatch?.[1]
        .split(',')
        .filter((column: string) => column.trim()).length;
      const placeholderCount = insertMatch?.[2].match(/\?/g)?.length;
      const bindCount = getLastBindArgs(localMockEnv).length;
      expect(placeholderCount).toBe(columnCount);
      expect(bindCount).toBe(columnCount);

      // Verify the run method was called (client was actually inserted)
      expect(mockDB._mockStatement.run).toHaveBeenCalled();
    });

    it('should accept http://localhost redirect_uri for development', async () => {
      const requestBody = {
        redirect_uris: ['http://localhost:3000/callback'],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(201);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.redirect_uris).toEqual(['http://localhost:3000/callback']);
    });

    it('should build registration_client_uri with default tenant subdomain when naked domain is disabled', async () => {
      const localApp = new Hono<{ Bindings: Env }>();
      localApp.use('*', async (c, next) => {
        attachTenantContexts(c as never, 'default');
        await next();
      });
      localApp.post('/register', registerHandler);

      const localMockEnv = createMockEnv();
      localMockEnv.CLIENTS_CACHE = createMockKV();
      localMockEnv.BASE_DOMAIN = 'oidc.example.com';

      const res = await localApp.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            redirect_uris: ['https://example.com/callback'],
          }),
        },
        localMockEnv
      );

      expect(res.status).toBe(201);
      const json = (await res.json()) as RegistrationResponse;
      expect(json.registration_client_uri).toMatch(
        /^https:\/\/default\.oidc\.example\.com\/clients\//
      );
    });

    it('should build registration_client_uri with naked domain for the default tenant when enabled', async () => {
      const localApp = new Hono<{ Bindings: Env }>();
      localApp.use('*', async (c, next) => {
        attachTenantContexts(c as never, 'default');
        await next();
      });
      localApp.post('/register', registerHandler);

      const localMockEnv = createMockEnv();
      localMockEnv.CLIENTS_CACHE = createMockKV();
      localMockEnv.BASE_DOMAIN = 'oidc.example.com';
      localMockEnv.NAKED_DOMAIN_AS_ISSUER = 'true';

      const res = await localApp.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            redirect_uris: ['https://example.com/callback'],
          }),
        },
        localMockEnv
      );

      expect(res.status).toBe(201);
      const json = (await res.json()) as RegistrationResponse;
      expect(json.registration_client_uri).toMatch(/^https:\/\/oidc\.example\.com\/clients\//);
    });

    it('should keep tenant subdomains for non-primary tenants when naked domain is enabled', async () => {
      const localApp = new Hono<{ Bindings: Env }>();
      localApp.use('*', async (c, next) => {
        attachTenantContexts(c as never, 'acme');
        await next();
      });
      localApp.post('/register', registerHandler);

      const localMockEnv = createMockEnv();
      localMockEnv.CLIENTS_CACHE = createMockKV();
      localMockEnv.BASE_DOMAIN = 'oidc.example.com';
      localMockEnv.NAKED_DOMAIN_AS_ISSUER = 'true';

      const res = await localApp.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            redirect_uris: ['https://example.com/callback'],
          }),
        },
        localMockEnv
      );

      expect(res.status).toBe(201);
      const json = (await res.json()) as RegistrationResponse;
      expect(json.registration_client_uri).toMatch(
        /^https:\/\/acme\.oidc\.example\.com\/clients\//
      );
    });
  });

  describe('Validation - OIDC response signing algorithms', () => {
    it('rejects ambiguous client key sources', async () => {
      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            redirect_uris: ['https://example.com/callback'],
            jwks: { keys: [] },
            jwks_uri: 'https://client.example.com/jwks.json',
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: 'invalid_client_metadata',
        error_description: 'jwks and jwks_uri must not both be provided',
      });
    });

    it.each([
      ['token_endpoint_auth_signing_alg', 'HS256'],
      ['id_token_signed_response_alg', 'RS512'],
      ['userinfo_signed_response_alg', 'RS512'],
      ['request_object_signing_alg', 'HS256'],
      ['authorization_signed_response_alg', 'RS512'],
      ['authorization_encrypted_response_alg', 'dir'],
      ['authorization_encrypted_response_enc', 'A128CBC-HS256'],
    ])('rejects unsupported %s values', async (field, value) => {
      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            redirect_uris: ['https://example.com/callback'],
            [field]: value,
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: 'invalid_client_metadata' });
    });

    it('accepts ES256 for ID Token and signed UserInfo responses', async () => {
      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            redirect_uris: ['https://example.com/callback'],
            id_token_signed_response_alg: 'ES256',
            userinfo_signed_response_alg: 'ES256',
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(201);
      await expect(res.json()).resolves.toMatchObject({
        id_token_signed_response_alg: 'ES256',
        userinfo_signed_response_alg: 'ES256',
      });
    });

    it.each(['RS256', 'ES256', 'PS256', 'EdDSA'])(
      'accepts and returns %s for private_key_jwt client authentication',
      async (algorithm) => {
        const res = await app.request(
          '/register',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              redirect_uris: ['https://example.com/callback'],
              token_endpoint_auth_method: 'private_key_jwt',
              token_endpoint_auth_signing_alg: algorithm,
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(201);
        await expect(res.json()).resolves.toMatchObject({
          token_endpoint_auth_signing_alg: algorithm,
        });
      }
    );

    it('stores and returns FAPI Message Signing and JARM client metadata', async () => {
      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            redirect_uris: ['https://example.com/callback'],
            token_endpoint_auth_signing_alg: 'ES256',
            request_object_signing_alg: 'ES256',
            authorization_signed_response_alg: 'ES256',
            authorization_encrypted_response_alg: 'RSA-OAEP',
            authorization_encrypted_response_enc: 'A256GCM',
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(201);
      await expect(res.json()).resolves.toMatchObject({
        token_endpoint_auth_signing_alg: 'ES256',
        request_object_signing_alg: 'ES256',
        authorization_signed_response_alg: 'ES256',
        authorization_encrypted_response_alg: 'RSA-OAEP',
        authorization_encrypted_response_enc: 'A256GCM',
      });
      expect(getLastBindArgs(mockEnv)).toEqual(
        expect.arrayContaining(['ES256', 'RSA-OAEP', 'A256GCM'])
      );
    });

    it('rejects a JARM signing algorithm excluded by the active Message Signing profile', async () => {
      mockKVStore.set(
        'settings:tenant:default:certification-profile',
        JSON.stringify({
          fapi: {
            enabled: true,
            messageSigning: {
              enabled: true,
              authorizationSigningAlgorithms: ['ES256'],
            },
          },
        })
      );
      mockEnv.SETTINGS = createMockKV();

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            redirect_uris: ['https://example.com/callback'],
            token_endpoint_auth_method: 'private_key_jwt',
            authorization_signed_response_alg: 'RS256',
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: 'invalid_client_metadata',
        error_description: expect.stringContaining('authorization_signed_response_alg'),
      });
    });

    it('rejects secret-based client authentication in an active FAPI profile', async () => {
      mockKVStore.set(
        'settings:tenant:default:certification-profile',
        JSON.stringify({ fapi: { enabled: true } })
      );
      mockEnv.SETTINGS = createMockKV();

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            redirect_uris: ['https://example.com/callback'],
            token_endpoint_auth_method: 'client_secret_basic',
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: 'invalid_client_metadata',
        error_description: expect.stringContaining('private_key_jwt'),
      });
    });
  });

  describe('Validation - redirect_uris', () => {
    it('should reject request without redirect_uris', async () => {
      const requestBody = {
        client_name: 'Test Client',
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.error).toBe('invalid_redirect_uri');
      expect(json.error_description).toContain('redirect_uris is required');
    });

    it('should reject empty redirect_uris array', async () => {
      const requestBody = {
        redirect_uris: [],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.error).toBe('invalid_redirect_uri');
      expect(json.error_description).toContain('non-empty array');
    });

    it('should reject non-array redirect_uris', async () => {
      const requestBody = {
        redirect_uris: 'https://example.com/callback',
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.error).toBe('invalid_redirect_uri');
    });

    it('should reject HTTP redirect_uri (except localhost)', async () => {
      const requestBody = {
        redirect_uris: ['http://example.com/callback'],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.error).toBe('invalid_redirect_uri');
      expect(json.error_description).toContain('HTTPS');
    });

    it('should reject redirect_uri with fragment identifier', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback#fragment'],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.error).toBe('invalid_redirect_uri');
      expect(json.error_description).toContain('fragment');
    });

    it('should reject invalid URI format', async () => {
      const requestBody = {
        redirect_uris: ['not-a-valid-uri'],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.error).toBe('invalid_redirect_uri');
      expect(json.error_description).toContain('Invalid URI');
    });
  });

  describe('Validation - Optional URI Fields', () => {
    it('should reject invalid client_uri', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        client_uri: 'not-a-uri',
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.error).toBe('invalid_client_metadata');
      expect(json.error_description).toContain('client_uri');
    });

    it('should reject invalid logo_uri', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        logo_uri: 'invalid-logo-uri',
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.error).toBe('invalid_client_metadata');
      expect(json.error_description).toContain('logo_uri');
    });

    it('should reject invalid jwks_uri', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        jwks_uri: 'not-valid',
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.error).toBe('invalid_client_metadata');
    });
  });

  describe('Validation - contacts', () => {
    it('should reject non-array contacts', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        contacts: 'admin@example.com',
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.error).toBe('invalid_client_metadata');
      expect(json.error_description).toContain('contacts must be an array');
    });

    it('should reject contacts with non-string values', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        contacts: ['admin@example.com', 123],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.error).toBe('invalid_client_metadata');
      expect(json.error_description).toContain('All contacts must be strings');
    });
  });

  describe('Validation - token_endpoint_auth_method', () => {
    it('should accept valid token_endpoint_auth_method', async () => {
      const validMethods = ['client_secret_basic', 'client_secret_post', 'none'];

      for (const method of validMethods) {
        const requestBody = {
          redirect_uris: ['https://example.com/callback'],
          token_endpoint_auth_method: method,
        };

        const res = await app.request(
          '/register',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
          },
          mockEnv
        );

        expect(res.status).toBe(201);

        const json = (await res.json()) as RegistrationResponse;
        expect(json.token_endpoint_auth_method).toBe(method);
      }
    });

    it('should reject invalid token_endpoint_auth_method', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        token_endpoint_auth_method: 'invalid_method',
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.error).toBe('invalid_client_metadata');
      expect(json.error_description).toContain('token_endpoint_auth_method');
    });
  });

  describe('Validation - application_type', () => {
    it('should accept valid application_type', async () => {
      const validTypes = ['web', 'native'];

      for (const type of validTypes) {
        const requestBody = {
          redirect_uris: ['https://example.com/callback'],
          application_type: type,
        };

        const res = await app.request(
          '/register',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
          },
          mockEnv
        );

        expect(res.status).toBe(201);

        const json = (await res.json()) as RegistrationResponse;
        expect(json.application_type).toBe(type);
      }
    });

    it('should reject invalid application_type', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        application_type: 'invalid',
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.error).toBe('invalid_client_metadata');
      expect(json.error_description).toContain('application_type');
    });

    it('should reject legacy app_suite in public registration', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        app_suite: 'wallet-suite',
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as RegistrationResponse;
      expect(json).toMatchObject({
        error: 'legacy_app_suite_not_supported',
        error_uri: 'https://docs.authrim.com/errors/error-codes#legacy-app-suite-not-supported',
        error_details: expect.objectContaining({
          code: 'legacy_app_suite_not_supported',
          severity: 'fatal',
        }),
      });
    });

    it('should reject managed trust group fields in public registration', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        trust_group_id: 'wallet-suite',
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.error).toBe('invalid_client_metadata');
      expect(json.error_description).toContain('trust_group_id is not supported');
    });
  });

  describe('Validation - grant_types', () => {
    it('should accept valid grant_types', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(201);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.grant_types).toEqual(['authorization_code', 'refresh_token']);
    });

    it('should reject non-array grant_types', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        grant_types: 'authorization_code',
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.error).toBe('invalid_client_metadata');
      expect(json.error_description).toContain('grant_types must be an array');
    });

    it('should register a private_key_jwt client for client_credentials', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        grant_types: ['client_credentials'],
        token_endpoint_auth_method: 'private_key_jwt',
        client_credentials_allowed: true,
        allowed_scopes: ['fapi'],
        default_scope: 'fapi',
        default_resource: 'https://api.example.com/resource',
        jwks: { keys: [{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y', kid: 'sig-1' }] },
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(201);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.grant_types).toEqual(['client_credentials']);
      expect(json.client_credentials_allowed).toBe(true);
      expect(json.allowed_scopes).toEqual(['fapi']);
    });

    it('rejects client_credentials without its explicit safety opt-in', async () => {
      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            redirect_uris: ['https://example.com/callback'],
            grant_types: ['client_credentials'],
            token_endpoint_auth_method: 'private_key_jwt',
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: 'invalid_client_metadata',
        error_description: expect.stringContaining('client_credentials_allowed'),
      });
    });
  });

  describe('Validation - require_pkce', () => {
    it('should reject non-boolean require_pkce', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        require_pkce: 'true',
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.error).toBe('invalid_client_metadata');
      expect(json.error_description).toContain('require_pkce must be a boolean');
    });

    it('should reject require_pkce false for public authorization code clients', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        require_pkce: false,
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.error).toBe('invalid_client_metadata');
      expect(json.error_description).toContain('require_pkce must be true');
    });
  });

  describe('Validation - response_types', () => {
    it('should accept valid response_types', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        response_types: ['code'],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(201);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.response_types).toEqual(['code']);
    });

    it('should reject non-array response_types', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        response_types: 'code',
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.error).toBe('invalid_client_metadata');
      expect(json.error_description).toContain('response_types must be an array');
    });

    it('should reject unsupported response_type', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        response_types: ['code', 'unsupported'],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.error).toBe('invalid_client_metadata');
      expect(json.error_description).toContain('Unsupported response_type');
    });
  });

  describe('Error Handling', () => {
    it('should reject non-JSON request body', async () => {
      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: 'not-json',
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.error).toBe('invalid_request');
      expect(json.error_description).toContain('JSON object');
    });

    it('should reject null request body', async () => {
      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(null),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.error).toBe('invalid_request');
    });

    it('should handle missing Content-Type gracefully', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      // Should still work without Content-Type header
      expect(res.status).toBe(201);
    });
  });

  describe('Security', () => {
    it('should generate unique client_id for each registration', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
      };

      const res1 = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      const res2 = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      const json1 = (await res1.json()) as RegistrationResponse;
      const json2 = (await res2.json()) as RegistrationResponse;

      expect(json1.client_id).not.toBe(json2.client_id);
    });

    it('should generate unique client_secret for each registration', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
      };

      const res1 = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      const res2 = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      const json1 = (await res1.json()) as RegistrationResponse;
      const json2 = (await res2.json()) as RegistrationResponse;

      expect(json1.client_secret).not.toBe(json2.client_secret);
    });

    it('should generate client_secret with sufficient length', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      const json = (await res.json()) as RegistrationResponse;

      // 32 bytes base64url encoded should be at least 40 characters
      expect((json.client_secret as string).length).toBeGreaterThanOrEqual(40);
    });
  });

  describe('Validation - post_logout_redirect_uris (OIDC RP-Initiated Logout 1.0)', () => {
    it('should accept valid post_logout_redirect_uris', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        post_logout_redirect_uris: ['https://example.com/logout', 'https://example.com/signout'],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(201);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.post_logout_redirect_uris).toEqual([
        'https://example.com/logout',
        'https://example.com/signout',
      ]);
    });

    it('should accept http://localhost for post_logout_redirect_uris', async () => {
      const requestBody = {
        redirect_uris: ['http://localhost:3000/callback'],
        post_logout_redirect_uris: ['http://localhost:3000/logout'],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(201);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.post_logout_redirect_uris).toEqual(['http://localhost:3000/logout']);
    });

    it('should reject non-array post_logout_redirect_uris', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        post_logout_redirect_uris: 'https://example.com/logout',
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.error).toBe('invalid_client_metadata');
      expect(json.error_description).toContain('post_logout_redirect_uris must be an array');
    });

    it('should reject post_logout_redirect_uris with non-string values', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        post_logout_redirect_uris: ['https://example.com/logout', 123],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.error).toBe('invalid_client_metadata');
      expect(json.error_description).toContain('All post_logout_redirect_uris must be strings');
    });

    it('should reject HTTP post_logout_redirect_uri (except localhost)', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        post_logout_redirect_uris: ['http://example.com/logout'],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.error).toBe('invalid_client_metadata');
      expect(json.error_description).toContain('HTTPS');
    });

    it('should reject post_logout_redirect_uri with fragment identifier', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        post_logout_redirect_uris: ['https://example.com/logout#fragment'],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.error).toBe('invalid_client_metadata');
      expect(json.error_description).toContain('fragment');
    });

    it('should reject invalid post_logout_redirect_uri format', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        post_logout_redirect_uris: ['not-a-valid-uri'],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.error).toBe('invalid_client_metadata');
      expect(json.error_description).toContain('Invalid post_logout_redirect_uri');
    });

    it('should store post_logout_redirect_uris in database', async () => {
      const mockDB = createMockDB();
      const localMockEnv = createMockEnv({ db: mockDB });
      localMockEnv.CLIENTS_CACHE = createMockKV();

      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        post_logout_redirect_uris: ['https://example.com/logout'],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        localMockEnv
      );

      expect(res.status).toBe(201);

      // Verify the INSERT statement includes post_logout_redirect_uris column
      expect(mockDB.prepare).toHaveBeenCalledWith(
        expect.stringContaining('post_logout_redirect_uris')
      );
    });
  });

  describe('Validation - backchannel_logout_uri', () => {
    it('should reject backchannel_logout_uri that targets internal addresses', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        backchannel_logout_uri: 'https://169.254.169.254/latest/meta-data',
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.error).toBe('invalid_client_metadata');
      expect(json.error_description).toContain('internal addresses');
    });
  });

  describe('Validation - jwks_uri', () => {
    it('should reject jwks_uri that targets internal addresses', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        jwks_uri: 'https://169.254.169.254/latest/meta-data',
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as RegistrationResponse;
      expect(json.error).toBe('invalid_client_metadata');
      expect(json.error_description).toContain('internal addresses');
    });
  });
});

describe('conformance test user tenant isolation', () => {
  it('keeps the legacy ID for the default tenant and scopes other tenant IDs', () => {
    expect(buildConformanceTestUserId('default')).toBe('user-oidc-conformance-test');
    expect(buildConformanceTestUserId('fapi2')).toBe('user-oidc-conformance-test-fapi2');
    expect(buildConformanceTestUserId('primary', 'primary')).toBe('user-oidc-conformance-test');
  });
});
