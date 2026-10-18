/**
 * Settings API v2 Integration Tests
 *
 * Tests for the unified settings API endpoints:
 * - GET/PATCH /tenants/:tenantId/settings/:category
 * - GET/PATCH /clients/:clientId/settings
 * - GET /platform/settings/:category (read-only)
 * - GET /settings/meta/:category
 */

import { readFileSync } from 'node:fs';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import type {
  AdminAuthContext,
  Env,
  SettingsGetResult,
  SettingsPatchResult,
} from '@authrim/ar-lib-core';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async (env: Env, partition: string) =>
      actual.ensureDatabaseAdapter(env.DB, partition)
    ),
    createAuditLogFromContext: vi.fn(actual.createAuditLogFromContext),
  };
});

import { createAuditLogFromContext } from '@authrim/ar-lib-core';
import { sweepExternalPluginGates } from '../external-plugin-gate-sweep';
import settingsV2 from '../routes/settings-v2';

// Response types
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type ApiResponse = Record<string, JsonValue>;
type SqlValue = string | number | null | Uint8Array;
const adminDatabases = new Set<DatabaseSync>();

class BoundSqliteStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[]
  ) {}

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async all<T>() {
    return { success: true, results: this.statement.all(...this.values) as T[], meta: {} };
  }

  async run<T>() {
    const result = this.statement.run(...this.values);
    return {
      success: true,
      results: [] as T[],
      meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
    };
  }
}

class SqliteStatement {
  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]): BoundSqliteStatement {
    return new BoundSqliteStatement(
      this.statement,
      values.map((value) => {
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          value === null ||
          value instanceof Uint8Array
        )
          return value;
        throw new Error('unsupported_test_sqlite_value');
      })
    );
  }

  first<T>() {
    return this.bind().first<T>();
  }

  all<T>() {
    return this.bind().all<T>();
  }

  run<T>() {
    return this.bind().run<T>();
  }
}

function createAdminD1(): D1Database {
  const database = new DatabaseSync(':memory:');
  database.exec(
    readFileSync(
      new URL('../../../../migrations/admin/d1/028_tenant_settings_documents.sql', import.meta.url),
      'utf8'
    )
  );
  database.exec(
    readFileSync(
      new URL(
        '../../../../migrations/admin/d1/038_tenant_settings_reconciled_at.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  database.exec(
    readFileSync(
      new URL(
        '../../../../migrations/admin/d1/039_platform_settings_documents.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  adminDatabases.add(database);
  const session = {
    prepare: (sql: string) => new SqliteStatement(database.prepare(sql)),
    getBookmark: () => 'settings-test-bookmark',
  };
  return {
    ...session,
    withSession: () => session,
    batch: async (statements: BoundSqliteStatement[]) =>
      Promise.all(statements.map((statement) => statement.run())),
    dump: async () => new ArrayBuffer(0),
    exec: async (sql: string) => {
      database.exec(sql);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;
}

// Mock KV namespace
function createMockKV(data: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(data));
  return {
    get: vi.fn(async (key: string, options?: 'text' | 'json' | 'arrayBuffer' | 'stream') => {
      const value = store.get(key);
      if (value === undefined) return null;
      // Handle JSON option
      if (options === 'json') {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      }
      return value;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

function createMockDB(): D1Database {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({ success: true }),
      all: vi.fn().mockResolvedValue({ results: [] }),
      first: vi.fn().mockResolvedValue(null),
    }),
    batch: vi.fn(),
    dump: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;
}

function createClientLookupDB(
  clients: Record<
    string,
    { tenant_id: string; client_id: string; redirect_uris: string[]; first_party?: boolean }
  >
): D1Database {
  return {
    prepare: vi.fn().mockImplementation((sql: string) => ({
      bind: vi.fn().mockImplementation((...params: string[]) => ({
        run: vi.fn().mockResolvedValue({ success: true }),
        all: vi.fn().mockImplementation(async () => {
          if (!sql.includes('FROM client_trust_policies')) {
            return { results: [] };
          }
          const [tenantId, targetType, clientId] = params;
          const client = targetType === 'oidc_client' ? clients[`${tenantId}:${clientId}`] : null;
          return {
            results:
              client?.first_party === true
                ? [
                    {
                      target_type: 'oidc_client',
                      target_id: clientId,
                      first_party: 1,
                      trusted: 1,
                      skip_authorization_consent: 1,
                    },
                  ]
                : [],
          };
        }),
        first: vi.fn().mockImplementation(async () => {
          if (!sql.includes('FROM oauth_clients')) {
            return null;
          }
          const [tenantId, clientId] = params;
          const client = clients[`${tenantId}:${clientId}`];
          return client ? { ...client, redirect_uris: JSON.stringify(client.redirect_uris) } : null;
        }),
      })),
    })),
    batch: vi.fn(),
    dump: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;
}

// Create test app with settings-v2 routes
function createTestApp(
  options: {
    kv?: KVNamespace;
    db?: D1Database;
    tenantId?: string;
    env?: Record<string, unknown>;
    adminAuth?: AdminAuthContext;
    /** The tenant's core database, as the request context would have resolved it. */
    tenantCoreDb?: D1Database;
  } = {}
) {
  const mockKV = options.kv ?? createMockKV();
  const mockRateLimiterIncrement = vi.fn().mockResolvedValue({
    allowed: true,
    current: 1,
    limit: 100,
    resetAt: Math.floor(Date.now() / 1000) + 60,
  });

  const app = new Hono<{
    Bindings: Env;
    Variables: {
      adminAuth?: AdminAuthContext;
      tenantId?: string;
    };
  }>();

  // Mock admin auth middleware - set adminAuth with system_admin role
  app.use('*', async (c, next) => {
    c.set(
      'adminAuth',
      options.adminAuth ?? {
        userId: 'test_admin',
        authMethod: 'bearer',
        roles: ['system_admin'], // system_admin has access to all settings
      }
    );
    c.set('tenantId', options.tenantId ?? 'default');
    (c as unknown as { set(key: string, value: unknown): void }).set('tenantMetadataContext', {
      tenantId: options.tenantId ?? 'default',
      coreDb: options.tenantCoreDb ?? c.env.DB,
    });
    await next();
  });

  // Mount settings-v2 routes
  app.route('/api/admin', settingsV2);

  // Create mock env
  // SETTINGS KV is used by SettingsManager for reading/writing settings
  // AUTHRIM_CONFIG KV is used for other config lookups (client data, etc.)
  const mockEnv = {
    AUTHRIM_CONFIG: mockKV,
    SETTINGS: mockKV,
    DB: options.db ?? createMockDB(),
    DB_ADMIN: createAdminD1(),
    RATE_LIMITER: {
      idFromName: vi.fn().mockReturnValue('rate-limit-id'),
      get: vi.fn().mockReturnValue({ incrementRpc: mockRateLimiterIncrement }),
    },
    BASE_DOMAIN: 'example.com', // enable multi-tenant mode so ensureSupportedTenantId passes
    ...options.env,
  } as unknown as Env;

  return { app, mockEnv, mockKV, mockRateLimiterIncrement };
}

const TURNSTILE_ENABLED_KEY =
  'plugins:enabled:human-verification-cloudflare-turnstile:tenant:tenant_123';
const TURNSTILE_GLOBAL_CONFIG_KEY = 'plugins:config:human-verification-cloudflare-turnstile';
const TURNSTILE_CONFIG = JSON.stringify({ siteKey: 'site', secretKey: 'secret' });
const AUTHENTICATION_METHODS_URL = '/api/admin/tenants/tenant_123/settings/authentication-methods';
const AUTHENTICATION_METHODS_KEY = 'settings:tenant:tenant_123:authentication-methods';

describe('Settings API v2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const database of adminDatabases) database.close();
    adminDatabases.clear();
  });

  describe('Tenant Settings', () => {
    describe('GET /tenants/:tenantId/settings/:category', () => {
      it('applies rate limiting to concrete mounted settings paths', async () => {
        const { app, mockEnv, mockRateLimiterIncrement } = createTestApp();

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/oauth',
          { method: 'GET', headers: { 'CF-Connecting-IP': '192.0.2.10' } },
          mockEnv
        );

        expect(res.status).toBe(200);
        expect(mockRateLimiterIncrement).toHaveBeenCalledTimes(1);
      });

      it('should return settings with default values', async () => {
        const { app, mockEnv } = createTestApp();

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/oauth',
          { method: 'GET' },
          mockEnv
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as SettingsGetResult;

        expect(body).toHaveProperty('category', 'oauth');
        expect(body).toHaveProperty('scope');
        expect(body.scope).toEqual({ type: 'tenant', id: 'tenant_123' });
        expect(body).toHaveProperty('version');
        expect(body).toHaveProperty('values');
        expect(body).toHaveProperty('sources');
      });

      it('shows the platform value and no longer the older stores', async () => {
        const { app, mockEnv } = createTestApp({
          kv: createMockKV({
            'settings:platform:security': JSON.stringify({ 'security.fapi_enabled': true }),
            // The older stores are imported once; the view does not read them.
            system_settings: 'not json',
            'oauth:config:TOKEN_EXPIRY': '900',
          }),
        });

        const security = await app.request(
          '/api/admin/tenants/tenant_123/settings/security',
          { method: 'GET' },
          mockEnv
        );
        expect(security.status).toBe(200);
        const body = (await security.json()) as SettingsGetResult;
        expect(body.values['security.fapi_enabled']).toBe(true);
        expect(body.sources['security.fapi_enabled']).toBe('platform');

        const oauth = (await (
          await app.request('/api/admin/tenants/tenant_123/settings/oauth', {}, mockEnv)
        ).json()) as SettingsGetResult;
        expect(oauth.values['oauth.access_token_expiry']).not.toBe(900);
        expect(oauth.sources['oauth.access_token_expiry']).not.toBe('platform');
      });

      it('answers 503 for a tenant view whose document is not an object, and records nothing', async () => {
        const kv = createMockKV({ 'settings:tenant:tenant_123:oauth': '[]' });
        const { app, mockEnv } = createTestApp({ kv });

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/oauth',
          { method: 'GET' },
          mockEnv
        );

        expect(res.status).toBe(503);
        const row = await mockEnv.DB_ADMIN.prepare(
          'SELECT COUNT(*) AS n FROM tenant_settings_documents'
        ).first<{ n: number }>();
        expect(row?.n).toBe(0);

        // Once the document is repaired, the view shows it.
        await kv.put(
          'settings:tenant:tenant_123:oauth',
          JSON.stringify({ 'oauth.access_token_expiry': 900 })
        );
        const repaired = await app.request(
          '/api/admin/tenants/tenant_123/settings/oauth',
          { method: 'GET' },
          mockEnv
        );
        expect(repaired.status).toBe(200);
        const body = (await repaired.json()) as SettingsGetResult;
        expect(body.values['oauth.access_token_expiry']).toBe(900);
      });

      it('answers 503 for a platform view whose Settings API document cannot be read', async () => {
        const { app, mockEnv } = createTestApp({
          kv: createMockKV({ 'settings:platform:feature-flags': 'not json' }),
        });

        const res = await app.request(
          '/api/admin/platform/settings/feature-flags',
          { method: 'GET' },
          mockEnv
        );

        expect(res.status).toBe(503);
        const body = (await res.json()) as ApiResponse;
        expect(body.error).toBe('temporarily_unavailable');
      });

      it('inherits a value set at the platform and reports it as the fallback', async () => {
        const { app, mockEnv } = createTestApp({
          kv: createMockKV({
            'settings:platform:rate-limit': JSON.stringify({ 'rate_limit.strict': 50 }),
          }),
        });

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/rate-limit',
          { method: 'GET' },
          mockEnv
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as SettingsGetResult;
        expect(body.values['rate_limit.strict']).toBe(50);
        expect(body.sources['rate_limit.strict']).toBe('platform');
        expect(body.inherited.values['rate_limit.strict']).toBe(50);
        expect(body.inherited.sources['rate_limit.strict']).toBe('platform');
        expect(body.sources['rate_limit.moderate']).toBe('default');
      });

      it('should return 404 for unknown category', async () => {
        const { app, mockEnv } = createTestApp();

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/unknown_category',
          { method: 'GET' },
          mockEnv
        );

        expect(res.status).toBe(404);
        const body = (await res.json()) as ApiResponse;
        expect(body.error).toBe('not_found');
      });

      it('should return KV values when present', async () => {
        const mockKV = createMockKV({
          'settings:tenant:tenant_123:oauth': JSON.stringify({
            'oauth.access_token_expiry': 7200,
          }),
        });
        const { app, mockEnv } = createTestApp({ kv: mockKV });

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/oauth',
          { method: 'GET' },
          mockEnv
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as SettingsGetResult;

        expect(body.values['oauth.access_token_expiry']).toBe(7200);
        expect(body.sources['oauth.access_token_expiry']).toBe('kv');
      });

      it('should return login-entry settings with default values', async () => {
        const { app, mockEnv } = createTestApp();

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-entry',
          { method: 'GET' },
          mockEnv
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as SettingsGetResult;

        expect(body.category).toBe('login-entry');
        expect(body.values['login-entry.override_enabled']).toBe(false);
        expect(body.values['login-entry.mode']).toBe('discovery_optional');
        expect(body.values['login-entry.discovery_methods']).toBe(
          '["email_exact","tenant_code","tenant_slug","wayf"]'
        );
        expect(body.values['login-entry.email_resolution_policy']).toBe('exact_email_only');
        expect(body.values['login-entry.selection_policy']).toBe('select_if_multiple');
        expect(body.values['login-entry.allow_manual_tenant_entry']).toBe(true);
        expect(body.values['login-entry.remember_last_tenant']).toBe(true);
        expect(body.values['login-entry.redirect_default_login_to_discovery']).toBe(true);
        expect(body.values['login-entry.require_common_discovery_before_login']).toBe(true);
        expect(body.values['login-entry.skip_discovery_if_only_one_tenant']).toBe(true);
        expect(body.values['login-entry.redirect_tenant_discover_to_common_entry']).toBe(true);
        expect(body.values['login-entry.post_login_behavior']).toBe('account');
        expect(body.values['login-entry.post_login_redirect_url']).toBe('/');
      });

      it('should return self-service settings with default values', async () => {
        const { app, mockEnv } = createTestApp();

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/self-service',
          { method: 'GET' },
          mockEnv
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as SettingsGetResult;

        expect(body.category).toBe('self-service');
        expect(body.values['self-service.account_page_enabled']).toBe(true);
        expect(body.values['self-service.account_page_path']).toBe('/account');
      });

      it('should return service-site settings with default values', async () => {
        const { app, mockEnv } = createTestApp();

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/service-site',
          { method: 'GET' },
          mockEnv
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as SettingsGetResult;

        expect(body.category).toBe('service-site');
        expect(body.values['service-site.fallback_enabled']).toBe(false);
      });

      it('should return tenant-discovery-ui settings for tenant scope', async () => {
        const { app, mockEnv } = createTestApp();

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/tenant-discovery-ui',
          { method: 'GET' },
          mockEnv
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as SettingsGetResult;

        expect(body.category).toBe('tenant-discovery-ui');
        expect(body.values['tenant-discovery-ui.override_enabled']).toBe(false);
        expect(body.values['tenant-discovery-ui.inherit_from_login_ui']).toBe(true);
        expect(body.values['tenant-discovery-ui.theme']).toBe('');
      });
    });

    describe('PATCH /tenants/:tenantId/settings/:category', () => {
      it('should require ifMatch parameter', async () => {
        const { app, mockEnv } = createTestApp();

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/oauth',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              set: { 'oauth.access_token_expiry': 1800 },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(400);
        const body = (await res.json()) as ApiResponse;
        expect(body.error).toBe('bad_request');
        expect(body.message as string).toContain('ifMatch');
      });

      it('should return 400 for invalid JSON body', async () => {
        const { app, mockEnv } = createTestApp();

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/oauth',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: 'invalid json {{{',
          },
          mockEnv
        );

        expect(res.status).toBe(400);
        const body = (await res.json()) as ApiResponse;
        expect(body.error).toBe('bad_request');
        expect(body.message).toBe('Invalid JSON body');
      });

      it('should apply valid settings', async () => {
        const mockKV = createMockKV();
        const { app, mockEnv } = createTestApp({ kv: mockKV });

        // First, get the current version
        const getRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/oauth',
          { method: 'GET' },
          mockEnv
        );
        const getData = (await getRes.json()) as SettingsGetResult;

        // Then patch
        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/oauth',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: getData.version,
              set: { 'oauth.access_token_expiry': 1800 },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as SettingsPatchResult;

        expect(body.applied).toContain('oauth.access_token_expiry');
        expect(body.version).toBeDefined();
      });

      describe('oauth.prompt_create_enabled', () => {
        const patchOauth = async (
          set: Record<string, unknown>,
          kv: ReturnType<typeof createMockKV> = createMockKV()
        ) => {
          const { app, mockEnv } = createTestApp({ kv });
          const getRes = await app.request(
            '/api/admin/tenants/tenant_123/settings/oauth',
            { method: 'GET' },
            mockEnv
          );
          const current = (await getRes.json()) as SettingsGetResult;
          const res = await app.request(
            '/api/admin/tenants/tenant_123/settings/oauth',
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ifMatch: current.version, set }),
            },
            mockEnv
          );
          return { res, app, mockEnv, current };
        };

        it('is off by default', async () => {
          const { app, mockEnv } = createTestApp();
          const res = await app.request(
            '/api/admin/tenants/tenant_123/settings/oauth',
            { method: 'GET' },
            mockEnv
          );
          const body = (await res.json()) as SettingsGetResult;
          expect(body.values['oauth.prompt_create_enabled']).toBe(false);
          expect(body.sources['oauth.prompt_create_enabled']).toBe('default');
        });

        it('turns on and off through the Settings API', async () => {
          const kv = createMockKV();
          const on = await patchOauth({ 'oauth.prompt_create_enabled': true }, kv);
          expect(on.res.status).toBe(200);
          expect(((await on.res.json()) as SettingsPatchResult).applied).toContain(
            'oauth.prompt_create_enabled'
          );
          const read = async () =>
            (await (
              await on.app.request(
                '/api/admin/tenants/tenant_123/settings/oauth',
                { method: 'GET' },
                on.mockEnv
              )
            ).json()) as SettingsGetResult;
          expect((await read()).values['oauth.prompt_create_enabled']).toBe(true);
          expect((await read()).sources['oauth.prompt_create_enabled']).toBe('kv');

          const current = await read();
          const off = await on.app.request(
            '/api/admin/tenants/tenant_123/settings/oauth',
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                ifMatch: current.version,
                set: { 'oauth.prompt_create_enabled': false },
              }),
            },
            on.mockEnv
          );
          expect(off.status).toBe(200);
          expect((await read()).values['oauth.prompt_create_enabled']).toBe(false);
        });

        it.each([['yes'], ['true'], [1], [null], [{}]])('refuses %j as a value', async (value) => {
          const { res } = await patchOauth({ 'oauth.prompt_create_enabled': value });
          expect(res.status).toBe(400);
          expect((await res.json()) as ApiResponse).toMatchObject({
            error: 'validation_failed',
          });
        });
      });

      it('does not fail the settings patch when audit mirroring fails', async () => {
        const mockKV = createMockKV();
        const failingAuditDb = {
          prepare: vi.fn().mockReturnValue({
            bind: vi.fn().mockReturnThis(),
            run: vi.fn().mockRejectedValue(new Error('audit unavailable')),
            all: vi.fn().mockResolvedValue({ results: [] }),
            first: vi.fn().mockResolvedValue(null),
          }),
          batch: vi.fn(),
          dump: vi.fn(),
          exec: vi.fn(),
        } as unknown as D1Database;
        const { app, mockEnv } = createTestApp({ kv: mockKV, db: failingAuditDb });

        const getRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-ui',
          { method: 'GET' },
          mockEnv
        );
        const getData = (await getRes.json()) as SettingsGetResult;

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-ui',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: getData.version,
              set: { 'login-ui.brand_name': 'Tenant Brand' },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as SettingsPatchResult;
        expect(body.applied).toContain('login-ui.brand_name');
      });

      it('bumps the authentication methods cache revision for tenant Login UI changes', async () => {
        const mockKV = createMockKV();
        const { app, mockEnv } = createTestApp({ kv: mockKV });
        const getRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-ui',
          { method: 'GET' },
          mockEnv
        );
        const current = (await getRes.json()) as SettingsGetResult;

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-ui',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: current.version,
              set: { 'login-ui.brand_name': 'Tenant Brand' },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(200);
        await expect(
          mockKV.get('cache:authentication-methods:v1:revision:tenant:tenant_123')
        ).resolves.toEqual(expect.any(String));
      });

      it('bumps the authentication methods cache revision when the SAML switch changes', async () => {
        const mockKV = createMockKV();
        const { app, mockEnv } = createTestApp({ kv: mockKV });
        const getRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/federation',
          { method: 'GET' },
          mockEnv
        );
        const current = await getRes.json<SettingsGetResult>();

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/federation',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: current.version,
              set: { 'federation.saml_enabled': false },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(200);
        await expect(
          mockKV.get('cache:authentication-methods:v1:revision:tenant:tenant_123')
        ).resolves.toEqual(expect.any(String));
      });

      it('automatically schedules inherited human-verification projection after enabling it', async () => {
        const mockKV = createMockKV({
          [TURNSTILE_ENABLED_KEY]: 'true',
          [TURNSTILE_GLOBAL_CONFIG_KEY]: TURNSTILE_CONFIG,
        });
        const { app, mockEnv } = createTestApp({ kv: mockKV });
        const getRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/authentication-methods',
          { method: 'GET' },
          mockEnv
        );
        const current = (await getRes.json()) as SettingsGetResult;

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/authentication-methods',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: current.version,
              set: {
                'authentication-methods.human_verification.provider':
                  'human-verification-cloudflare-turnstile',
                'authentication-methods.human_verification.login_enabled': true,
              },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(200);
        await expect(
          mockKV.get('plugins:provider-projection:desired:human-verification-cloudflare-turnstile')
        ).resolves.toEqual(expect.any(String));
      });

      it('does not schedule global projection for an explicit tenant provider override', async () => {
        const mockKV = createMockKV({
          [TURNSTILE_ENABLED_KEY]: 'true',
          'plugins:config:human-verification-cloudflare-turnstile:tenant:tenant_123':
            JSON.stringify({ siteKey: 'tenant-site', secretKey: 'encrypted' }),
        });
        const { app, mockEnv } = createTestApp({ kv: mockKV });
        const getRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/authentication-methods',
          { method: 'GET' },
          mockEnv
        );
        const current = (await getRes.json()) as SettingsGetResult;

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/authentication-methods',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: current.version,
              set: { 'authentication-methods.human_verification.login_enabled': true },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(200);
        await expect(
          mockKV.get('plugins:provider-projection:desired:human-verification-cloudflare-turnstile')
        ).resolves.toBeNull();
      });

      describe('human verification must not be required of a flow its provider cannot serve', () => {
        async function patchAuthenticationMethods(
          ctx: ReturnType<typeof createTestApp>,
          body: { set?: Record<string, unknown>; clear?: string[] }
        ) {
          const current = (await (
            await ctx.app.request(AUTHENTICATION_METHODS_URL, { method: 'GET' }, ctx.mockEnv)
          ).json()) as SettingsGetResult;
          const res = await ctx.app.request(
            AUTHENTICATION_METHODS_URL,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ifMatch: current.version, ...body }),
            },
            ctx.mockEnv
          );
          return {
            res,
            saved: JSON.parse(String((await ctx.mockKV.get(AUTHENTICATION_METHODS_KEY)) ?? '{}')),
          };
        }

        const LOGIN = 'authentication-methods.human_verification.login_enabled';
        const SIGNUP = 'authentication-methods.human_verification.signup_enabled';
        const PROVIDER = 'authentication-methods.human_verification.provider';

        it.each(['login_enabled', 'signup_enabled', 'reauth_enabled'])(
          'refuses %s while the provider was never enabled (400), and saves nothing',
          async (flow) => {
            const ctx = createTestApp({
              kv: createMockKV({ [TURNSTILE_GLOBAL_CONFIG_KEY]: TURNSTILE_CONFIG }),
            });
            const { res, saved } = await patchAuthenticationMethods(ctx, {
              set: { [`authentication-methods.human_verification.${flow}`]: true },
            });
            expect(res.status).toBe(400);
            await expect(res.json()).resolves.toMatchObject({
              error: 'human_verification_provider_unavailable',
              reason: 'provider_disabled',
              plugin_id: 'human-verification-cloudflare-turnstile',
              settings: [`authentication-methods.human_verification.${flow}`],
            });
            expect(saved[`authentication-methods.human_verification.${flow}`]).toBeUndefined();
          }
        );

        it('refuses it while the plugin is disabled explicitly', async () => {
          const ctx = createTestApp({
            kv: createMockKV({
              [TURNSTILE_ENABLED_KEY]: 'false',
              [TURNSTILE_GLOBAL_CONFIG_KEY]: TURNSTILE_CONFIG,
            }),
          });
          const { res } = await patchAuthenticationMethods(ctx, { set: { [LOGIN]: true } });
          expect(res.status).toBe(400);
        });

        it('refuses it while the plugin is enabled but has no credentials', async () => {
          const ctx = createTestApp({ kv: createMockKV({ [TURNSTILE_ENABLED_KEY]: 'true' }) });
          const { res } = await patchAuthenticationMethods(ctx, { set: { [LOGIN]: true } });
          expect(res.status).toBe(400);
          await expect(res.json()).resolves.toMatchObject({ reason: 'provider_unconfigured' });
        });

        it('accepts it once the provider is enabled and configured', async () => {
          const ctx = createTestApp({
            kv: createMockKV({
              [TURNSTILE_ENABLED_KEY]: 'true',
              [TURNSTILE_GLOBAL_CONFIG_KEY]: TURNSTILE_CONFIG,
            }),
          });
          const { res, saved } = await patchAuthenticationMethods(ctx, { set: { [LOGIN]: true } });
          expect(res.status).toBe(200);
          expect(saved[LOGIN]).toBe(true);
        });

        it('refuses switching the provider under a required flow to one that is not enabled', async () => {
          const ctx = createTestApp({
            kv: createMockKV({
              [TURNSTILE_ENABLED_KEY]: 'true',
              [TURNSTILE_GLOBAL_CONFIG_KEY]: TURNSTILE_CONFIG,
              [AUTHENTICATION_METHODS_KEY]: JSON.stringify({ [LOGIN]: true }),
            }),
          });
          const { res, saved } = await patchAuthenticationMethods(ctx, {
            set: { [PROVIDER]: 'human-verification-hcaptcha' },
          });
          expect(res.status).toBe(400);
          await expect(res.json()).resolves.toMatchObject({
            reason: 'provider_disabled',
            plugin_id: 'human-verification-hcaptcha',
          });
          expect(saved[PROVIDER]).toBeUndefined();
        });

        it('allows switching the provider while no flow requires one', async () => {
          const ctx = createTestApp();
          const { res } = await patchAuthenticationMethods(ctx, {
            set: { [PROVIDER]: 'human-verification-hcaptcha' },
          });
          expect(res.status).toBe(200);
        });

        it('judges the canonical document, not a stale KV projection', async () => {
          // Canonical: hCaptcha (never enabled), login off. The KV projection still holds the
          // earlier Turnstile + login on, as when a projection is pending.
          const ctx = createTestApp({
            kv: createMockKV({
              [TURNSTILE_ENABLED_KEY]: 'true',
              [TURNSTILE_GLOBAL_CONFIG_KEY]: TURNSTILE_CONFIG,
            }),
          });
          const first = await patchAuthenticationMethods(ctx, {
            set: { [PROVIDER]: 'human-verification-hcaptcha', [LOGIN]: false },
          });
          expect(first.res.status).toBe(200);
          await ctx.mockKV.put(
            AUTHENTICATION_METHODS_KEY,
            JSON.stringify({ [PROVIDER]: 'human-verification-cloudflare-turnstile', [LOGIN]: true })
          );

          const { res } = await patchAuthenticationMethods(ctx, { set: { [LOGIN]: true } });
          expect(res.status).toBe(400);
          await expect(res.json()).resolves.toMatchObject({
            reason: 'provider_disabled',
            plugin_id: 'human-verification-hcaptcha',
          });
        });

        it('judges what the manager would save when it rejects a conflicting operation', async () => {
          // Login requires Turnstile now. The request moves the provider to a disabled hCaptcha
          // and "turns login off" with set + clear for the same key: the manager rejects the
          // conflicting login operations and saves the provider alone, leaving login required.
          const ctx = createTestApp({
            kv: createMockKV({
              [TURNSTILE_ENABLED_KEY]: 'true',
              [TURNSTILE_GLOBAL_CONFIG_KEY]: TURNSTILE_CONFIG,
              [AUTHENTICATION_METHODS_KEY]: JSON.stringify({ [LOGIN]: true }),
            }),
          });
          const { res, saved } = await patchAuthenticationMethods(ctx, {
            set: { [PROVIDER]: 'human-verification-hcaptcha', [LOGIN]: false },
            clear: [LOGIN],
          });
          expect(res.status).toBe(400);
          await expect(res.json()).resolves.toMatchObject({ reason: 'provider_disabled' });
          expect(saved[PROVIDER]).toBeUndefined();
        });

        it('accepts switching the provider when the same request turns the required flow off', async () => {
          const ctx = createTestApp({
            kv: createMockKV({
              [TURNSTILE_ENABLED_KEY]: 'true',
              [TURNSTILE_GLOBAL_CONFIG_KEY]: TURNSTILE_CONFIG,
              [AUTHENTICATION_METHODS_KEY]: JSON.stringify({ [LOGIN]: true }),
            }),
          });
          const { res } = await patchAuthenticationMethods(ctx, {
            set: { [PROVIDER]: 'human-verification-hcaptcha', [LOGIN]: false },
          });
          expect(res.status).toBe(200);
        });

        it('refuses credentials the runner would not project (a site key past its limit)', async () => {
          const ctx = createTestApp({
            kv: createMockKV({
              [TURNSTILE_ENABLED_KEY]: 'true',
              [TURNSTILE_GLOBAL_CONFIG_KEY]: JSON.stringify({
                siteKey: 'a'.repeat(2_049),
                secretKey: 'secret',
              }),
            }),
          });
          const { res } = await patchAuthenticationMethods(ctx, { set: { [LOGIN]: true } });
          expect(res.status).toBe(400);
          await expect(res.json()).resolves.toMatchObject({ reason: 'provider_unconfigured' });
        });

        it('refuses a key of spaces as the credentials', async () => {
          const ctx = createTestApp({
            kv: createMockKV({
              [TURNSTILE_ENABLED_KEY]: 'true',
              [TURNSTILE_GLOBAL_CONFIG_KEY]: JSON.stringify({ siteKey: 'site', secretKey: '   ' }),
            }),
          });
          const { res } = await patchAuthenticationMethods(ctx, { set: { [LOGIN]: true } });
          expect(res.status).toBe(400);
          await expect(res.json()).resolves.toMatchObject({ reason: 'provider_unconfigured' });
        });

        describe('a tenant already in the mismatch', () => {
          function mismatched() {
            // Login already requires verification; the provider was never enabled.
            return createTestApp({
              kv: createMockKV({ [AUTHENTICATION_METHODS_KEY]: JSON.stringify({ [LOGIN]: true }) }),
            });
          }

          it('can still save its other settings', async () => {
            const ctx = mismatched();
            const { res, saved } = await patchAuthenticationMethods(ctx, {
              set: { 'authentication-methods.did.login_enabled': true },
            });
            expect(res.status).toBe(200);
            expect(saved['authentication-methods.did.login_enabled']).toBe(true);
            expect(saved[LOGIN]).toBe(true);
          });

          it('can save a human verification value that changes nothing', async () => {
            const { res } = await patchAuthenticationMethods(mismatched(), {
              set: { [LOGIN]: true },
            });
            expect(res.status).toBe(200);
          });

          it('can turn the flow off', async () => {
            const { res, saved } = await patchAuthenticationMethods(mismatched(), {
              set: { [LOGIN]: false },
            });
            expect(res.status).toBe(200);
            expect(saved[LOGIN]).toBe(false);
          });

          it('can clear the flow setting', async () => {
            const { res } = await patchAuthenticationMethods(mismatched(), { clear: [LOGIN] });
            expect(res.status).toBe(200);
          });

          it('cannot make another flow require the missing provider', async () => {
            const { res } = await patchAuthenticationMethods(mismatched(), {
              set: { [SIGNUP]: true },
            });
            expect(res.status).toBe(400);
          });
        });
      });

      it('keeps DID login off until a tenant turns it on, and saves the switch where sign-in reads it', async () => {
        const mockKV = createMockKV();
        const { app, mockEnv } = createTestApp({ kv: mockKV });
        const url = '/api/admin/tenants/tenant_123/settings/authentication-methods';

        const getRes = await app.request(url, { method: 'GET' }, mockEnv);
        const current = (await getRes.json()) as SettingsGetResult;
        expect(current.values['authentication-methods.did.login_enabled']).toBe(false);

        const res = await app.request(
          url,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: current.version,
              set: { 'authentication-methods.did.login_enabled': true },
            }),
          },
          mockEnv
        );
        expect(res.status).toBe(200);
        const patched = (await res.json()) as SettingsPatchResult;
        expect(patched.applied).toContain('authentication-methods.did.login_enabled');

        // The document DID sign-in reads (ar-auth: authentication-method-settings).
        const raw = await mockKV.get('settings:tenant:tenant_123:authentication-methods');
        expect(JSON.parse(String(raw))).toMatchObject({
          'authentication-methods.did.login_enabled': true,
        });

        const after = (await (
          await app.request(url, { method: 'GET' }, mockEnv)
        ).json()) as SettingsGetResult;
        expect(after.values['authentication-methods.did.login_enabled']).toBe(true);
      });

      it('refuses a DID login switch that is not a boolean', async () => {
        const { app, mockEnv } = createTestApp();
        const url = '/api/admin/tenants/tenant_123/settings/authentication-methods';
        const current = (await (
          await app.request(url, { method: 'GET' }, mockEnv)
        ).json()) as SettingsGetResult;

        const res = await app.request(
          url,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: current.version,
              set: { 'authentication-methods.did.login_enabled': 'sometimes' },
            }),
          },
          mockEnv
        );
        expect(res.status).toBe(400);
      });

      it('accepts every newly supported Login UI locale', async () => {
        const mockKV = createMockKV();
        const { app, mockEnv } = createTestApp({ kv: mockKV });
        const getRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-ui',
          { method: 'GET' },
          mockEnv
        );
        const current = (await getRes.json()) as SettingsGetResult;

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-ui',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: current.version,
              set: {
                'login-ui.supported_locales': 'hi,bn,tr,sw,am,pl',
                'login-ui.default_locale': 'am',
              },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as SettingsPatchResult;
        expect(body.applied).toContain('login-ui.supported_locales');
      });

      it('stores an explicit empty primary-language selection', async () => {
        const mockKV = createMockKV();
        const { app, mockEnv } = createTestApp({ kv: mockKV });
        const getRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-ui',
          { method: 'GET' },
          mockEnv
        );
        const current = (await getRes.json()) as SettingsGetResult;

        const patchRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-ui',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: current.version,
              set: { 'login-ui.primary_locales': [] },
            }),
          },
          mockEnv
        );

        expect(patchRes.status).toBe(200);
        const savedRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-ui',
          { method: 'GET' },
          mockEnv
        );
        const saved = (await savedRes.json()) as SettingsGetResult;
        expect(saved.values['login-ui.primary_locales']).toEqual([]);
        expect(saved.sources['login-ui.primary_locales']).toBe('kv');
      });

      it('rejects a seventh primary Login UI language', async () => {
        const mockKV = createMockKV();
        const { app, mockEnv } = createTestApp({ kv: mockKV });
        const getRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-ui',
          { method: 'GET' },
          mockEnv
        );
        const current = (await getRes.json()) as SettingsGetResult;

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-ui',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: current.version,
              set: {
                'login-ui.primary_locales': ['en', 'ja', 'de', 'fr', 'es', 'pt', 'it'],
              },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(400);
        const body = (await res.json()) as ApiResponse;
        expect(body.error).toBe('validation_failed');
      });

      it('rejects unsafe Login UI custom CSS', async () => {
        const mockKV = createMockKV();
        const { app, mockEnv } = createTestApp({ kv: mockKV });
        const getRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-ui',
          { method: 'GET' },
          mockEnv
        );
        const current = (await getRes.json()) as SettingsGetResult;

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-ui',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: current.version,
              set: { 'login-ui.custom_css': "body { background-image: url('x'); }" },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(400);
        const body = (await res.json()) as ApiResponse;
        expect(body.error).toBe('validation_failed');
      });

      it('accepts only a tenant UI on an allowed origin, with paths on that host', async () => {
        const mockKV = createMockKV();
        const { app, mockEnv } = createTestApp({
          kv: mockKV,
          env: {
            ISSUER_URL: 'https://id.example.com',
            ALLOWED_ORIGINS: 'https://login.example.org',
          },
        });
        const patch = async (set: Record<string, unknown>) => {
          const getRes = await app.request(
            '/api/admin/tenants/tenant_123/settings/tenant',
            { method: 'GET' },
            mockEnv
          );
          const current = (await getRes.json()) as SettingsGetResult;
          return app.request(
            '/api/admin/tenants/tenant_123/settings/tenant',
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ifMatch: current.version, set }),
            },
            mockEnv
          );
        };

        for (const set of [
          { 'tenant.ui_base_url': 'https://evil.example.net' },
          { 'tenant.ui_base_url': '   ' },
          { 'tenant.ui_base_url': '' },
          { 'tenant.ui_base_url': 'http://login.example.org' },
          { 'tenant.ui_login_path': '//evil.example.net/login' },
          { 'tenant.ui_error_path': 'error' },
          { 'tenant.ui_device_path': '//evil.example.net/device' },
          { 'tenant.ui_register_path': '/signup?next=x' },
          { 'tenant.ui_logged_out_path': '' },
        ]) {
          const res = await patch(set);
          expect(res.status, JSON.stringify(set)).toBe(400);
          expect((await res.json()) as ApiResponse).toMatchObject({ error: 'validation_failed' });
        }

        const res = await patch({
          'tenant.ui_base_url': 'https://login.example.org',
          'tenant.ui_login_path': '/signin',
        });
        expect(res.status).toBe(200);
      });

      it('rejects unsafe published Account Page snapshots', async () => {
        const mockKV = createMockKV();
        const { app, mockEnv } = createTestApp({ kv: mockKV });
        const getRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-ui',
          { method: 'GET' },
          mockEnv
        );
        const current = (await getRes.json()) as SettingsGetResult;
        const now = Date.now();
        const definition = {
          schema_version: 'authrim.account_page.v1',
          screens: [
            {
              id: 'unsafe',
              screen_key: 'unsafe_account',
              width: 'full',
              enabled: true,
              condition: 'always',
            },
          ],
        };
        const document = {
          schema_version: 'authrim.account_pages.v1',
          default_page_id: 'unsafe-page',
          pages: [
            {
              id: 'unsafe-page',
              name: 'Unsafe page',
              base_preset_id: 'authrim-default',
              base_preset_version: 1,
              draft: definition,
              published: {
                ...definition,
                resolved_at: new Date(now).toISOString(),
                screen_snapshots: {
                  unsafe_account: {
                    screen_key: 'unsafe_account',
                    screen_kind: 'account',
                    fields: [
                      {
                        field: 'auth.passkey',
                        label: 'Injected action',
                        block_type: 'auth_widget',
                      },
                    ],
                  },
                },
              },
              published_version: 1,
              published_at: new Date(now).toISOString(),
              created_at: now,
              updated_at: now,
            },
          ],
        };

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-ui',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: current.version,
              set: { 'login-ui.account_pages': JSON.stringify(document) },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(400);
        expect((await res.json()) as ApiResponse).toMatchObject({ error: 'validation_failed' });
      });

      it('rejects non-boolean guest widget visibility in Account Page settings', async () => {
        const mockKV = createMockKV();
        const { app, mockEnv } = createTestApp({ kv: mockKV });
        const getRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-ui',
          { method: 'GET' },
          mockEnv
        );
        const current = (await getRes.json()) as SettingsGetResult;
        const now = Date.now();
        const document = {
          schema_version: 'authrim.account_pages.v1',
          default_page_id: 'default-page',
          pages: [
            {
              id: 'default-page',
              name: 'Default',
              base_preset_id: 'authrim-default',
              base_preset_version: 3,
              draft: {
                schema_version: 'authrim.account_page.v1',
                screens: [
                  {
                    id: 'profile',
                    screen_key: 'account_profile',
                    width: 'half',
                    enabled: true,
                    condition: 'always',
                    show_for_guests: 'yes',
                  },
                ],
              },
              published_version: 0,
              published_at: '',
              created_at: now,
              updated_at: now,
            },
          ],
        };

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-ui',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: current.version,
              set: { 'login-ui.account_pages': JSON.stringify(document) },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(400);
        expect((await res.json()) as ApiResponse).toMatchObject({ error: 'validation_failed' });
      });

      it('stores disabled guest visibility through the Login UI settings API', async () => {
        const mockKV = createMockKV();
        const { app, mockEnv } = createTestApp({ kv: mockKV });
        const getRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-ui',
          { method: 'GET' },
          mockEnv
        );
        const current = (await getRes.json()) as SettingsGetResult;
        const now = Date.now();
        const document = {
          schema_version: 'authrim.account_pages.v1',
          default_page_id: 'default-page',
          pages: [
            {
              id: 'default-page',
              name: 'Default',
              base_preset_id: 'authrim-default',
              base_preset_version: 3,
              draft: {
                schema_version: 'authrim.account_page.v1',
                screens: [
                  {
                    id: 'profile',
                    screen_key: 'account_profile',
                    width: 'half',
                    enabled: true,
                    condition: 'always',
                    show_for_guests: false,
                  },
                ],
              },
              published_version: 0,
              published_at: '',
              created_at: now,
              updated_at: now,
            },
          ],
        };

        const patchRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-ui',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: current.version,
              set: { 'login-ui.account_pages': JSON.stringify(document) },
            }),
          },
          mockEnv
        );

        expect(patchRes.status).toBe(200);
        const savedRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-ui',
          { method: 'GET' },
          mockEnv
        );
        const saved = (await savedRes.json()) as SettingsGetResult;
        const savedDocument = JSON.parse(
          String(saved.values['login-ui.account_pages'])
        ) as typeof document;
        expect(savedDocument.pages[0]?.draft.screens[0]?.show_for_guests).toBe(false);
      });

      it('rejects untrusted external post-login redirect URLs', async () => {
        const mockKV = createMockKV();
        const { app, mockEnv } = createTestApp({ kv: mockKV });
        const getRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-entry',
          { method: 'GET' },
          mockEnv
        );
        const current = (await getRes.json()) as SettingsGetResult;

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-entry',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: current.version,
              set: {
                'login-entry.post_login_behavior': 'custom_url',
                'login-entry.post_login_redirect_url': 'https://evil.example/mypage',
              },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(400);
        const body = (await res.json()) as ApiResponse;
        expect(body.error).toBe('bad_request');
      });

      it('rejects trusted redirect origins that include paths', async () => {
        const mockKV = createMockKV();
        const { app, mockEnv } = createTestApp({ kv: mockKV });
        const getRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/security',
          { method: 'GET' },
          mockEnv
        );
        const current = (await getRes.json()) as SettingsGetResult;

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/security',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: current.version,
              set: { 'security.trusted_redirect_origins': '["https://app.example/path"]' },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(400);
        const body = (await res.json()) as ApiResponse;
        expect(body.error).toBe('bad_request');
      });

      it('rejects switching to custom_url when the effective redirect URL is invalid', async () => {
        const mockKV = createMockKV({
          'settings:tenant:tenant_123:login-entry': JSON.stringify({
            'login-entry.post_login_behavior': 'home',
            'login-entry.post_login_redirect_url': 'https://evil.example/mypage',
          }),
        });
        const { app, mockEnv } = createTestApp({ kv: mockKV });
        const getRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-entry',
          { method: 'GET' },
          mockEnv
        );
        const current = (await getRes.json()) as SettingsGetResult;

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-entry',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: current.version,
              set: { 'login-entry.post_login_behavior': 'custom_url' },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(400);
        const body = (await res.json()) as ApiResponse;
        expect(body.error).toBe('bad_request');
      });

      it('enables self-service account page when post-login behavior is account', async () => {
        const mockKV = createMockKV({
          'settings:tenant:tenant_123:login-entry': JSON.stringify({
            'login-entry.post_login_behavior': 'home',
          }),
          'settings:tenant:tenant_123:self-service': JSON.stringify({
            'self-service.account_page_enabled': false,
            'self-service.account_page_path': '/account',
          }),
        });
        const { app, mockEnv } = createTestApp({ kv: mockKV });
        const getRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-entry',
          { method: 'GET' },
          mockEnv
        );
        const current = (await getRes.json()) as SettingsGetResult;

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-entry',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: current.version,
              set: { 'login-entry.post_login_behavior': 'account' },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(200);
        const rawSelfService = await mockKV.get('settings:tenant:tenant_123:self-service');
        expect(JSON.parse(String(rawSelfService))).toMatchObject({
          'self-service.account_page_enabled': true,
          'self-service.account_page_path': '/account',
        });
        const canonical = [...adminDatabases][0]
          .prepare(
            `SELECT document_json,projection_state FROM tenant_settings_documents
            WHERE tenant_id=? AND scope_type='tenant' AND scope_id=? AND category='self-service'`
          )
          .get('tenant_123', 'tenant_123') as
          | { document_json: string; projection_state: string }
          | undefined;
        expect(canonical?.projection_state).toBe('applied');
        expect(JSON.parse(canonical?.document_json ?? '{}')).toMatchObject({
          'self-service.account_page_enabled': true,
          'self-service.account_page_path': '/account',
        });
      });

      it('rejects disabling account page while post-login behavior is account', async () => {
        const mockKV = createMockKV({
          'settings:tenant:tenant_123:login-entry': JSON.stringify({
            'login-entry.post_login_behavior': 'account',
          }),
          'settings:tenant:tenant_123:self-service': JSON.stringify({
            'self-service.account_page_enabled': true,
            'self-service.account_page_path': '/account',
          }),
        });
        const { app, mockEnv } = createTestApp({ kv: mockKV });
        const getRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/self-service',
          { method: 'GET' },
          mockEnv
        );
        const current = (await getRes.json()) as SettingsGetResult;

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/self-service',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: current.version,
              set: { 'self-service.account_page_enabled': false },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(400);
        const body = (await res.json()) as ApiResponse;
        expect(body.resolutionLink).toBe('/admin/login-ui#post-login');
      });

      it('should return 409 on version conflict', async () => {
        const { app, mockEnv } = createTestApp();

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/oauth',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: 'sha256:wrong_version',
              set: { 'oauth.access_token_expiry': 1800 },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(409);
        const body = (await res.json()) as ApiResponse;
        expect(body.error).toBe('conflict');
        expect(body.currentVersion).toBeDefined();
      });

      it('should reject unknown keys', async () => {
        const mockKV = createMockKV();
        const { app, mockEnv } = createTestApp({ kv: mockKV });

        // Get current version
        const getRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/oauth',
          { method: 'GET' },
          mockEnv
        );
        const getData = (await getRes.json()) as SettingsGetResult;

        // Patch with unknown key
        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/oauth',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: getData.version,
              set: { 'oauth.unknown_setting': 'value' },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(400);
        const body = (await res.json()) as ApiResponse & { rejected: Record<string, string> };
        expect(body.error).toBe('validation_failed');
        expect(body.rejected['oauth.unknown_setting']).toContain('Unknown');
      });

      it('should handle clear and disable operations', async () => {
        const mockKV = createMockKV({
          'settings:tenant:tenant_123:oauth': JSON.stringify({
            'oauth.access_token_expiry': 7200,
          }),
        });
        const { app, mockEnv } = createTestApp({ kv: mockKV });

        // Get current version
        const getRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/oauth',
          { method: 'GET' },
          mockEnv
        );
        const getData = (await getRes.json()) as SettingsGetResult;

        // Clear and disable (using a boolean setting that exists in oauth category)
        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/oauth',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: getData.version,
              clear: ['oauth.access_token_expiry'],
              disable: ['oauth.state_required'], // Use a boolean setting that exists in oauth category
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as SettingsPatchResult;
        expect(body.cleared).toContain('oauth.access_token_expiry');
        expect(body.disabled).toContain('oauth.state_required');
      });

      it('should patch login-entry settings', async () => {
        const mockKV = createMockKV();
        const { app, mockEnv } = createTestApp({ kv: mockKV });

        const getRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-entry',
          { method: 'GET' },
          mockEnv
        );
        const getData = (await getRes.json()) as SettingsGetResult;

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-entry',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: getData.version,
              set: {
                'login-entry.mode': 'tenant_only',
                'login-entry.discovery_methods': '["tenant_slug"]',
                'login-entry.email_resolution_policy': 'disabled',
                'login-entry.selection_policy': 'manual_only',
                'login-entry.allow_manual_tenant_entry': false,
                'login-entry.remember_last_tenant': false,
                'login-entry.redirect_default_login_to_discovery': false,
                'login-entry.require_common_discovery_before_login': false,
                'login-entry.skip_discovery_if_only_one_tenant': true,
                'login-entry.redirect_tenant_discover_to_common_entry': false,
              },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as SettingsPatchResult;

        expect(body.applied).toContain('login-entry.mode');
        expect(body.applied).toContain('login-entry.discovery_methods');
        expect(body.applied).toContain('login-entry.email_resolution_policy');
        expect(body.applied).toContain('login-entry.selection_policy');
        expect(body.applied).toContain('login-entry.allow_manual_tenant_entry');
        expect(body.applied).toContain('login-entry.remember_last_tenant');
        expect(body.applied).toContain('login-entry.redirect_default_login_to_discovery');
        expect(body.applied).toContain('login-entry.require_common_discovery_before_login');
        expect(body.applied).toContain('login-entry.skip_discovery_if_only_one_tenant');
        expect(body.applied).toContain('login-entry.redirect_tenant_discover_to_common_entry');
      });

      it('should patch App Login settings for an enabled first-party client', async () => {
        const mockKV = createMockKV({
          'settings:client:tenant_123:service_app:client': JSON.stringify({
            'client.app_login_enabled': true,
          }),
        });
        const { app, mockEnv } = createTestApp({
          kv: mockKV,
          db: createClientLookupDB({
            'tenant_123:service_app': {
              tenant_id: 'tenant_123',
              client_id: 'service_app',
              redirect_uris: ['https://service.example/callback'],
              first_party: true,
            },
          }),
        });

        const getRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-entry',
          { method: 'GET' },
          mockEnv
        );
        const getData = (await getRes.json()) as SettingsGetResult;

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-entry',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: getData.version,
              set: {
                'login-entry.post_login_behavior': 'app_login',
                'login-entry.app_login_client_id': 'service_app',
                'login-entry.app_login_redirect_uri': 'https://service.example/callback',
                'login-entry.app_login_scope': 'openid profile email',
              },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as SettingsPatchResult;
        expect(body.applied).toContain('login-entry.post_login_behavior');
        expect(body.applied).toContain('login-entry.app_login_client_id');
      });

      it('should reject App Login when the target client has not enabled it', async () => {
        const mockKV = createMockKV({
          'settings:client:tenant_123:service_app:client': JSON.stringify({
            'client.app_login_enabled': false,
          }),
        });
        const { app, mockEnv } = createTestApp({
          kv: mockKV,
          db: createClientLookupDB({
            'tenant_123:service_app': {
              tenant_id: 'tenant_123',
              client_id: 'service_app',
              redirect_uris: ['https://service.example/callback'],
            },
          }),
        });

        const getRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-entry',
          { method: 'GET' },
          mockEnv
        );
        const getData = (await getRes.json()) as SettingsGetResult;

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-entry',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: getData.version,
              set: {
                'login-entry.post_login_behavior': 'app_login',
                'login-entry.app_login_client_id': 'service_app',
                'login-entry.app_login_redirect_uri': 'https://service.example/callback',
                'login-entry.app_login_scope': 'openid profile email',
              },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(400);
        const body = (await res.json()) as ApiResponse;
        expect(body.message as string).toContain('App Login target client');
      });

      it('should patch tenant-discovery-ui settings for tenant scope', async () => {
        const mockKV = createMockKV();
        const { app, mockEnv } = createTestApp({ kv: mockKV });

        const getRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/tenant-discovery-ui',
          { method: 'GET' },
          mockEnv
        );
        const getData = (await getRes.json()) as SettingsGetResult;

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/tenant-discovery-ui',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: getData.version,
              set: {
                'tenant-discovery-ui.theme': 'dark',
                'tenant-discovery-ui.title_text': 'Find your workspace',
              },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as SettingsPatchResult;
        expect(body.applied).toContain('tenant-discovery-ui.theme');
        expect(body.applied).toContain('tenant-discovery-ui.title_text');
      });

      it('should reject unknown keys in login-entry settings', async () => {
        const mockKV = createMockKV();
        const { app, mockEnv } = createTestApp({ kv: mockKV });

        const getRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-entry',
          { method: 'GET' },
          mockEnv
        );
        const getData = (await getRes.json()) as SettingsGetResult;

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/login-entry',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: getData.version,
              set: { 'login-entry.unknown_key': 'value' },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(400);
        const body = (await res.json()) as ApiResponse & { rejected: Record<string, string> };
        expect(body.error).toBe('validation_failed');
        expect(body.rejected['login-entry.unknown_key']).toContain('Unknown');
      });

      it('should reject tenant edits for viewer role', async () => {
        const { app, mockEnv } = createTestApp({
          adminAuth: {
            userId: 'viewer_1',
            authMethod: 'bearer',
            roles: ['viewer'],
            org_id: 'tenant_123',
          },
        });

        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/oauth',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: 'sha256:test-version',
              set: { 'oauth.access_token_expiry': 1800 },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(403);
        const body = (await res.json()) as ApiResponse;
        expect(body.error).toBe('forbidden');
      });
    });
  });

  describe('Client Settings', () => {
    describe('GET /clients/:clientId/settings', () => {
      it('should return client settings', async () => {
        // Create KV with client metadata (required for tenant lookup)
        const mockKV = createMockKV({
          'client:test-tenant:client_abc:metadata': JSON.stringify({ tenant_id: 'test-tenant' }),
        });
        const { app, mockEnv } = createTestApp({ kv: mockKV });

        const res = await app.request(
          '/api/admin/clients/client_abc/settings',
          { method: 'GET', headers: { 'X-Tenant-Id': 'test-tenant' } },
          mockEnv
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as SettingsGetResult;

        expect(body.category).toBe('client');
        expect(body.scope).toEqual({ type: 'client', id: 'client_abc', tenantId: 'test-tenant' });
        expect(body.values).toBeDefined();
      });

      it('should reject access to clients in another tenant', async () => {
        const mockKV = createMockKV({
          'client:tenant-other:client_abc:metadata': JSON.stringify({ tenant_id: 'tenant-other' }),
        });
        const { app, mockEnv } = createTestApp({
          kv: mockKV,
          adminAuth: {
            userId: 'org_admin_1',
            authMethod: 'bearer',
            roles: ['org_admin'],
            org_id: 'tenant_123',
          },
        });

        const res = await app.request(
          '/api/admin/clients/client_abc/settings',
          { method: 'GET', headers: { 'X-Tenant-Id': 'tenant-other' } },
          mockEnv
        );

        expect(res.status).toBe(403);
        const body = (await res.json()) as ApiResponse;
        expect(body.error).toBe('forbidden');
      });
    });

    describe('PATCH /clients/:clientId/settings', () => {
      it('should update client settings', async () => {
        // Create KV with client metadata (required for tenant lookup)
        const mockKV = createMockKV({
          'client:test-tenant:client_abc:metadata': JSON.stringify({ tenant_id: 'test-tenant' }),
        });
        const { app, mockEnv } = createTestApp({ kv: mockKV });

        // Get current version
        const getRes = await app.request(
          '/api/admin/clients/client_abc/settings',
          { method: 'GET', headers: { 'X-Tenant-Id': 'test-tenant' } },
          mockEnv
        );
        const getData = (await getRes.json()) as SettingsGetResult;

        // Patch
        const res = await app.request(
          '/api/admin/clients/client_abc/settings',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': 'test-tenant' },
            body: JSON.stringify({
              ifMatch: getData.version,
              set: {
                'client.sso_enabled': true,
              },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as SettingsPatchResult;
        expect(body.applied).toContain('client.sso_enabled');
      });

      it.each(['client.default_audience', 'client.default_resource'])(
        'no longer lists %s and does not save it: the app registration holds the default target',
        async (key) => {
          const mockKV = createMockKV({
            'client:test-tenant:client_abc:metadata': JSON.stringify({ tenant_id: 'test-tenant' }),
            // A document saved before the keys were retired still holds them.
            'settings:client:test-tenant:client_abc:client': JSON.stringify({
              'client.sso_enabled': true,
              [key]: 'https://api.example.com',
            }),
          });
          const { app, mockEnv } = createTestApp({ kv: mockKV });
          const headers = { 'Content-Type': 'application/json', 'X-Tenant-Id': 'test-tenant' };

          const getRes = await app.request(
            '/api/admin/clients/client_abc/settings',
            { method: 'GET', headers },
            mockEnv
          );
          const current = (await getRes.json()) as SettingsGetResult;
          expect(current.values['client.sso_enabled']).toBe(true);
          expect(current.values).not.toHaveProperty(key);
          expect(current.sources).not.toHaveProperty(key);

          const res = await app.request(
            '/api/admin/clients/client_abc/settings',
            {
              method: 'PATCH',
              headers,
              body: JSON.stringify({ ifMatch: current.version, set: { [key]: 'https://other' } }),
            },
            mockEnv
          );
          expect(res.status).toBe(400);
          expect(((await res.json()) as SettingsPatchResult).rejected).toEqual({
            [key]: 'Unknown setting key',
          });
        }
      );

      it.each(['client.consent_required', 'client.first_party'])(
        'rejects deprecated consent authority key %s',
        async (key) => {
          const mockKV = createMockKV({
            'client:test-tenant:client_abc:metadata': JSON.stringify({ tenant_id: 'test-tenant' }),
          });
          const { app, mockEnv } = createTestApp({ kv: mockKV });
          const getRes = await app.request(
            '/api/admin/clients/client_abc/settings',
            { method: 'GET', headers: { 'X-Tenant-Id': 'test-tenant' } },
            mockEnv
          );
          const current = (await getRes.json()) as SettingsGetResult;

          const response = await app.request(
            '/api/admin/clients/client_abc/settings',
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': 'test-tenant' },
              body: JSON.stringify({ ifMatch: current.version, set: { [key]: false } }),
            },
            mockEnv
          );

          expect(response.status).toBe(400);
        }
      );

      it('lets a client set a setting whose dependency it inherits from the tenant', async () => {
        const mockKV = createMockKV({
          'client:test-tenant:client_abc:metadata': JSON.stringify({ tenant_id: 'test-tenant' }),
        });
        const { app, mockEnv } = createTestApp({ kv: mockKV, tenantId: 'test-tenant' });
        const headers = { 'Content-Type': 'application/json', 'X-Tenant-Id': 'test-tenant' };

        const tenantGet = await app.request(
          '/api/admin/tenants/test-tenant/settings/security',
          { method: 'GET', headers },
          mockEnv
        );
        const tenant = (await tenantGet.json()) as SettingsGetResult;
        const tenantPatch = await app.request(
          '/api/admin/tenants/test-tenant/settings/security',
          {
            method: 'PATCH',
            headers,
            body: JSON.stringify({
              ifMatch: tenant.version,
              set: { 'security.fapi_enabled': true },
            }),
          },
          mockEnv
        );
        expect(tenantPatch.status).toBe(200);

        const clientGet = await app.request(
          '/api/admin/clients/client_abc/settings/security',
          { method: 'GET', headers },
          mockEnv
        );
        const client = (await clientGet.json()) as SettingsGetResult;
        expect(client.values['security.fapi_enabled']).toBe(true);
        expect(client.sources['security.fapi_enabled']).toBe('tenant');

        const clientPatch = await app.request(
          '/api/admin/clients/client_abc/settings/security',
          {
            method: 'PATCH',
            headers,
            body: JSON.stringify({
              ifMatch: client.version,
              set: { 'security.fapi_strict_dpop': true },
            }),
          },
          mockEnv
        );
        const result = (await clientPatch.json()) as SettingsPatchResult;
        expect(result.rejected).toEqual({});
        expect(result.applied).toContain('security.fapi_strict_dpop');
      });

      it('rejects deprecated consent authority keys through the category route', async () => {
        const mockKV = createMockKV({
          'client:test-tenant:client_abc:metadata': JSON.stringify({ tenant_id: 'test-tenant' }),
        });
        const { app, mockEnv } = createTestApp({ kv: mockKV });
        const getRes = await app.request(
          '/api/admin/clients/client_abc/settings/client',
          { method: 'GET', headers: { 'X-Tenant-Id': 'test-tenant' } },
          mockEnv
        );
        const current = (await getRes.json()) as SettingsGetResult;

        const response = await app.request(
          '/api/admin/clients/client_abc/settings/client',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': 'test-tenant' },
            body: JSON.stringify({
              ifMatch: current.version,
              clear: ['client.first_party'],
            }),
          },
          mockEnv
        );

        expect(response.status).toBe(400);
      });

      it('authorizes tenant-scoped Machine Access tokens from settings permissions', async () => {
        const mockKV = createMockKV({
          'client:test-tenant:client_abc:metadata': JSON.stringify({ tenant_id: 'test-tenant' }),
        });
        const { app, mockEnv } = createTestApp({
          kv: mockKV,
          tenantId: 'test-tenant',
          adminAuth: {
            userId: 'setup-machine',
            authMethod: 'machine_access_token',
            actorType: 'machine',
            roles: [],
            tenantId: 'test-tenant',
            tenantScope: ['test-tenant'],
            permissions: ['admin:settings:read', 'admin:settings:write'],
          },
        });

        const getResponse = await app.request(
          '/api/admin/clients/client_abc/settings',
          { method: 'GET' },
          mockEnv
        );
        expect(getResponse.status).toBe(200);
        const current = (await getResponse.json()) as SettingsGetResult;

        const patchResponse = await app.request(
          '/api/admin/clients/client_abc/settings',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: current.version,
              set: { 'client.sso_enabled': true },
            }),
          },
          mockEnv
        );
        expect(patchResponse.status).toBe(200);
      });

      it('rejects Machine Access client settings without permission', async () => {
        const mockKV = createMockKV({
          'client:test-tenant:client_abc:metadata': JSON.stringify({ tenant_id: 'test-tenant' }),
        });
        const { app, mockEnv } = createTestApp({
          kv: mockKV,
          tenantId: 'test-tenant',
          adminAuth: {
            userId: 'setup-machine',
            authMethod: 'machine_access_token',
            actorType: 'machine',
            roles: ['system_admin'],
            tenantId: 'test-tenant',
            tenantScope: ['test-tenant'],
            permissions: ['admin:clients:read'],
          },
        });

        const response = await app.request(
          '/api/admin/clients/client_abc/settings',
          { method: 'GET' },
          mockEnv
        );
        expect(response.status).toBe(403);
      });

      it('rejects unsafe client Login UI custom CSS overrides', async () => {
        const mockKV = createMockKV({
          'client:test-tenant:client_abc:metadata': JSON.stringify({ tenant_id: 'test-tenant' }),
        });
        const { app, mockEnv } = createTestApp({ kv: mockKV });

        const getRes = await app.request(
          '/api/admin/clients/client_abc/settings/login-ui',
          { method: 'GET', headers: { 'X-Tenant-Id': 'test-tenant' } },
          mockEnv
        );
        const getData = (await getRes.json()) as SettingsGetResult;

        const res = await app.request(
          '/api/admin/clients/client_abc/settings/login-ui',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': 'test-tenant' },
            body: JSON.stringify({
              ifMatch: getData.version,
              set: {
                'login-ui.custom_css': ".auth-page { background-image: url('https://x'); }",
              },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(400);
        const body = (await res.json()) as ApiResponse;
        expect(body.error).toBe('validation_failed');
      });

      it('bumps the authentication methods cache revision for client Login UI overrides', async () => {
        const mockKV = createMockKV({
          'client:test-tenant:client_abc:metadata': JSON.stringify({ tenant_id: 'test-tenant' }),
        });
        const { app, mockEnv } = createTestApp({ kv: mockKV });
        const getRes = await app.request(
          '/api/admin/clients/client_abc/settings/login-ui',
          { method: 'GET', headers: { 'X-Tenant-Id': 'test-tenant' } },
          mockEnv
        );
        const current = (await getRes.json()) as SettingsGetResult;

        const res = await app.request(
          '/api/admin/clients/client_abc/settings/login-ui',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': 'test-tenant' },
            body: JSON.stringify({
              ifMatch: current.version,
              set: { 'login-ui.brand_name': 'Client Brand' },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(200);
        await expect(
          mockKV.get('cache:authentication-methods:v1:revision:tenant:test-tenant')
        ).resolves.toEqual(expect.any(String));
      });

      it('should reject disabling App Login on the configured target client', async () => {
        const mockKV = createMockKV({
          'client:test-tenant:client_abc:metadata': JSON.stringify({ tenant_id: 'test-tenant' }),
          'settings:tenant:test-tenant:login-entry': JSON.stringify({
            'login-entry.post_login_behavior': 'app_login',
            'login-entry.app_login_client_id': 'client_abc',
          }),
          'settings:client:test-tenant:client_abc:client': JSON.stringify({
            'client.app_login_enabled': true,
          }),
        });
        const { app, mockEnv } = createTestApp({ kv: mockKV });

        const getRes = await app.request(
          '/api/admin/clients/client_abc/settings/client',
          { method: 'GET', headers: { 'X-Tenant-Id': 'test-tenant' } },
          mockEnv
        );
        const getData = (await getRes.json()) as SettingsGetResult;

        const res = await app.request(
          '/api/admin/clients/client_abc/settings/client',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': 'test-tenant' },
            body: JSON.stringify({
              ifMatch: getData.version,
              set: {
                'client.app_login_enabled': false,
              },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(400);
        const body = (await res.json()) as ApiResponse;
        expect(body.message as string).toContain('Login UI App Login');
      });

      it('should reject enabling App Login without first-party client status', async () => {
        const mockKV = createMockKV({
          'client:test-tenant:client_abc:metadata': JSON.stringify({ tenant_id: 'test-tenant' }),
          'settings:client:test-tenant:client_abc:client': JSON.stringify({
            'client.app_login_enabled': false,
          }),
        });
        const { app, mockEnv } = createTestApp({ kv: mockKV });

        const getRes = await app.request(
          '/api/admin/clients/client_abc/settings/client',
          { method: 'GET', headers: { 'X-Tenant-Id': 'test-tenant' } },
          mockEnv
        );
        const getData = (await getRes.json()) as SettingsGetResult;

        const res = await app.request(
          '/api/admin/clients/client_abc/settings/client',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': 'test-tenant' },
            body: JSON.stringify({
              ifMatch: getData.version,
              set: {
                'client.app_login_enabled': true,
              },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(400);
        const body = (await res.json()) as ApiResponse;
        expect(body.message as string).toContain('first-party');
      });
    });
  });

  describe('Platform Settings', () => {
    describe('GET /platform/settings/:category', () => {
      it('keeps platform documents in the canonical store, starting from the KV copy', async () => {
        const mockKV = createMockKV({
          'settings:platform:login-entry': JSON.stringify({
            'login-entry.email_resolution_policy': 'disabled',
          }),
        });
        const { app, mockEnv } = createTestApp({ kv: mockKV });
        const url = '/api/admin/platform/settings/login-entry';
        const current = (await (
          await app.request(url, { method: 'GET' }, mockEnv)
        ).json()) as SettingsGetResult;
        expect(current.values['login-entry.email_resolution_policy']).toBe('disabled');

        const patch = (value: boolean) =>
          app.request(
            url,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                ifMatch: current.version,
                set: { 'login-entry.skip_discovery_if_only_one_tenant': value },
              }),
            },
            mockEnv
          );
        expect((await patch(true)).status).toBe(200);
        // A second save from the same version conflicts instead of overwriting the first.
        expect((await patch(false)).status).toBe(409);
        expect(
          JSON.parse((await mockKV.get('settings:platform:login-entry')) as string)
        ).toMatchObject({
          'login-entry.email_resolution_policy': 'disabled',
          'login-entry.skip_discovery_if_only_one_tenant': true,
        });
      });

      it('should return platform settings', async () => {
        const { app, mockEnv } = createTestApp();

        const res = await app.request(
          '/api/admin/platform/settings/infrastructure',
          { method: 'GET' },
          mockEnv
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as SettingsGetResult;

        expect(body.category).toBe('infrastructure');
        expect(body.scope).toEqual({ type: 'platform' });
      });

      it('should return login-entry settings for platform scope', async () => {
        const { app, mockEnv } = createTestApp();

        const res = await app.request(
          '/api/admin/platform/settings/login-entry',
          { method: 'GET' },
          mockEnv
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as SettingsGetResult;

        expect(body.category).toBe('login-entry');
        expect(body.scope).toEqual({ type: 'platform' });
        expect(body.values['login-entry.discovery_methods']).toBe(
          '["email_exact","tenant_code","tenant_slug","wayf"]'
        );
        expect(body.values['login-entry.require_common_discovery_before_login']).toBe(true);
        expect(body.values['login-entry.skip_discovery_if_only_one_tenant']).toBe(true);
      });
    });

    describe('PATCH /platform/settings/:category', () => {
      it('should return 405 Method Not Allowed for read-only categories', async () => {
        const { app, mockEnv } = createTestApp();

        const res = await app.request(
          '/api/admin/platform/settings/infrastructure',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: 'any',
              set: { 'infrastructure.some_key': 'value' },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(405);
        const body = (await res.json()) as ApiResponse;
        expect(body.error).toBe('method_not_allowed');
      });

      it('should patch writable platform categories', async () => {
        const mockKV = createMockKV();
        const { app, mockEnv } = createTestApp({ kv: mockKV });

        const getRes = await app.request(
          '/api/admin/platform/settings/tenant-discovery-ui',
          { method: 'GET' },
          mockEnv
        );
        const getData = (await getRes.json()) as SettingsGetResult;

        const res = await app.request(
          '/api/admin/platform/settings/tenant-discovery-ui',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: getData.version,
              set: {
                'tenant-discovery-ui.brand_name': 'Shared Discovery',
                'tenant-discovery-ui.theme': 'dark',
              },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as SettingsPatchResult;
        expect(body.applied).toContain('tenant-discovery-ui.brand_name');
        expect(body.applied).toContain('tenant-discovery-ui.theme');
      });

      it('should patch platform login-entry settings', async () => {
        const mockKV = createMockKV();
        const { app, mockEnv } = createTestApp({ kv: mockKV });

        const getRes = await app.request(
          '/api/admin/platform/settings/login-entry',
          { method: 'GET' },
          mockEnv
        );
        const getData = (await getRes.json()) as SettingsGetResult;

        const res = await app.request(
          '/api/admin/platform/settings/login-entry',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: getData.version,
              set: {
                'login-entry.discovery_methods': '["tenant_code"]',
                'login-entry.email_resolution_policy': 'disabled',
                'login-entry.require_common_discovery_before_login': false,
                'login-entry.skip_discovery_if_only_one_tenant': true,
              },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as SettingsPatchResult;
        expect(body.applied).toContain('login-entry.discovery_methods');
        expect(body.applied).toContain('login-entry.email_resolution_policy');
        expect(body.applied).toContain('login-entry.require_common_discovery_before_login');
        expect(body.applied).toContain('login-entry.skip_discovery_if_only_one_tenant');
      });
    });

    describe('PATCH validation of list and UI settings', () => {
      const patchAt = async (
        app: ReturnType<typeof createTestApp>['app'],
        mockEnv: ReturnType<typeof createTestApp>['mockEnv'],
        url: string,
        set: Record<string, unknown>
      ) => {
        const current = (await (
          await app.request(url, { method: 'GET' }, mockEnv)
        ).json()) as SettingsGetResult;
        return app.request(
          url,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ifMatch: current.version, set }),
          },
          mockEnv
        );
      };

      it('accepts only lists of known response types and auth methods, at every scope', async () => {
        const { app, mockEnv } = createTestApp({ kv: createMockKV() });
        for (const url of [
          '/api/admin/platform/settings/oauth',
          '/api/admin/tenants/tenant_123/settings/oauth',
        ]) {
          for (const set of [
            { 'oauth.response_types_supported': null },
            { 'oauth.response_types_supported': {} },
            { 'oauth.response_types_supported': [] },
            { 'oauth.response_types_supported': '["code"]' },
            { 'oauth.response_types_supported': ['code', 'code'] },
            { 'oauth.response_types_supported': ['token'] },
            { 'oauth.response_types_supported': [123] },
            { 'oauth.token_endpoint_auth_methods_supported': ['tls_client_auth'] },
            { 'oauth.token_endpoint_auth_methods_supported': [] },
          ]) {
            const res = await patchAt(app, mockEnv, url, set);
            expect(res.status, `${url} ${JSON.stringify(set)}`).toBe(400);
            expect((await res.json()) as ApiResponse).toMatchObject({ error: 'validation_failed' });
          }
          const res = await patchAt(app, mockEnv, url, {
            'oauth.response_types_supported': ['code', 'code id_token'],
            'oauth.token_endpoint_auth_methods_supported': ['private_key_jwt', 'none'],
          });
          expect(res.status, url).toBe(200);
        }
      });

      it('never accepts refresh_token for Token Exchange, and only https ID-JAG issuers', async () => {
        const { app, mockEnv } = createTestApp({ kv: createMockKV() });
        for (const url of [
          '/api/admin/platform/settings/tokens',
          '/api/admin/tenants/tenant_123/settings/tokens',
        ]) {
          for (const set of [
            { 'tokens.exchange_allowed_subject_token_types': 'access_token,refresh_token' },
            { 'tokens.exchange_allowed_subject_token_types': 'saml2' },
            { 'tokens.id_jag_allowed_issuers': ['http://idp.example.com'] },
            { 'tokens.id_jag_allowed_issuers': ['https://user:pass@idp.example.com'] },
            { 'tokens.id_jag_allowed_issuers': ['https://idp.example.com?x=1'] },
            { 'tokens.id_jag_allowed_issuers': 'https://idp.example.com' },
          ]) {
            const res = await patchAt(app, mockEnv, url, set);
            expect(res.status, `${url} ${JSON.stringify(set)}`).toBe(400);
          }
          const res = await patchAt(app, mockEnv, url, {
            'tokens.exchange_allowed_subject_token_types': 'access_token, id_token',
            'tokens.id_jag_allowed_issuers': [
              'https://idp.example.com/t,a',
              'https://idp2.example.com',
            ],
          });
          expect(res.status, url).toBe(200);
        }
      });

      it('accepts only usable signing algorithm lists and DPoP nonce choices', async () => {
        const { app, mockEnv } = createTestApp({ kv: createMockKV() });
        for (const url of [
          '/api/admin/platform/settings/security',
          '/api/admin/tenants/tenant_123/settings/security',
        ]) {
          for (const set of [
            { 'security.request_object_signing_algs': '' },
            { 'security.request_object_signing_algs': 'none' },
            { 'security.request_object_signing_algs': 'PS256,HS256' },
            { 'security.authorization_signing_algs': 'EdDSA' },
            { 'security.dpop_nonce_resource_overrides': [] },
            { 'security.dpop_nonce_resource_overrides': { 'https://api.example': 'false' } },
            { 'security.dpop_nonce_resource_overrides': { ' ': true } },
          ]) {
            const res = await patchAt(app, mockEnv, url, set);
            expect(res.status, `${url} ${JSON.stringify(set)}`).toBe(400);
            expect((await res.json()) as ApiResponse).toMatchObject({ error: 'validation_failed' });
          }
          const unlimited = await patchAt(app, mockEnv, url, {
            'security.fapi_message_signing_enabled': true,
            'security.authorization_signing_algs': '',
          });
          expect(unlimited.status, url).toBe(200);
          expect(((await unlimited.json()) as { rejected?: object }).rejected ?? {}).toEqual({});
          const res = await patchAt(app, mockEnv, url, {
            'security.request_object_signing_algs': 'PS256, ES256',
            'security.authorization_signing_algs': 'ES256,PS256',
            'security.dpop_nonce_resource_overrides': { 'https://api.example': false },
          });
          expect(res.status, url).toBe(200);
        }
      });

      it('accepts the assurance maps only as JSON objects of names to AAL1..AAL3', async () => {
        const { app, mockEnv } = createTestApp({ kv: createMockKV() });
        const url = '/api/admin/tenants/tenant_123/settings/assurance';
        for (const set of [
          { 'assurance.scope_aal_requirements': 'not json' },
          { 'assurance.scope_aal_requirements': '[]' },
          { 'assurance.scope_aal_requirements': '{"admin":"AAL0"}' },
          { 'assurance.upstream_acr_mappings': '{" silver":"AAL2"}' },
          { 'assurance.upstream_acr_mappings': '{"silver":"high"}' },
        ]) {
          const res = await patchAt(app, mockEnv, url, set);
          expect(res.status, JSON.stringify(set)).toBe(400);
          expect((await res.json()) as ApiResponse).toMatchObject({ error: 'validation_failed' });
        }
        const res = await patchAt(app, mockEnv, url, {
          'assurance.scope_aal_requirements': '{"admin":"AAL2"}',
          'assurance.upstream_acr_mappings': '{"urn:mace:incommon:iap:silver":"AAL2"}',
        });
        expect(res.status).toBe(200);
      });

      it("accepts the outbound acr table only as other vocabularies' acr values to an AAL", async () => {
        const { app, mockEnv } = createTestApp({ kv: createMockKV() });
        const url = '/api/admin/tenants/tenant_123/settings/assurance';
        for (const set of [
          { 'assurance.outbound_acr_mappings': 'not json' },
          { 'assurance.outbound_acr_mappings': '["urn:mace:incommon:iap:silver"]' },
          { 'assurance.outbound_acr_mappings': '{"urn:mace:incommon:iap:silver":"AAL4"}' },
          { 'assurance.outbound_acr_mappings': '{"urn:authrim:aal:2":"AAL2"}' },
          { 'assurance.outbound_acr_mappings': '{"silver gold":"AAL2"}' },
        ]) {
          const res = await patchAt(app, mockEnv, url, set);
          expect(res.status, JSON.stringify(set)).toBe(400);
          expect((await res.json()) as ApiResponse).toMatchObject({ error: 'validation_failed' });
        }
        const res = await patchAt(app, mockEnv, url, {
          'assurance.outbound_acr_mappings':
            '{"urn:mace:incommon:iap:silver":"AAL2","urn:mace:incommon:iap:bronze":"AAL1"}',
        });
        expect(res.status).toBe(200);
      });

      it('accepts the identity assurance settings only in the shapes runtime reads', async () => {
        const { app, mockEnv } = createTestApp({ kv: createMockKV() });
        const url = '/api/admin/tenants/tenant_123/settings/assurance';
        const gakunin = 'https://www.gakunin.jp/profile/IAL2';
        for (const set of [
          { 'assurance.scope_ial_requirements': '{"payroll":"AAL2"}' },
          { 'assurance.ial_assurance_values': '{"IAL2":"' + gakunin + '"}' },
          { 'assurance.ial_assurance_values': '{"IAL2":["not a uri"]}' },
          { 'assurance.ial_assurance_values': '{"IAL4":["' + gakunin + '"]}' },
          { 'assurance.saml_authn_context_aal': '{"AAL2":"AAL2"}' },
          { 'assurance.saml_authn_context_aal': '{"https://www.gakunin.jp/profile/AAL2":"IAL2"}' },
          { 'assurance.ida_profile': '{"trust_framework":"x y","claims":["given_name"]}' },
          { 'assurance.ida_profile': '{"trust_framework":"nist_800_63A","claims":["sub"]}' },
          { 'assurance.ida_profile': '{"trust_framework":"nist_800_63A","claims":[]}' },
          {
            'assurance.ida_profile':
              '{"trust_framework":"nist_800_63A","assurance_levels":{"IAL1":"x"},"claims":["name"]}',
          },
        ]) {
          const res = await patchAt(app, mockEnv, url, set);
          expect(res.status, JSON.stringify(set)).toBe(400);
          expect((await res.json()) as ApiResponse).toMatchObject({ error: 'validation_failed' });
        }
        const res = await patchAt(app, mockEnv, url, {
          'assurance.default_ial': 'IAL2',
          'assurance.scope_ial_requirements': '{"payroll":"IAL2"}',
          'assurance.ial_assurance_values': JSON.stringify({ IAL2: [gakunin] }),
          'assurance.saml_authn_context_aal': '{"https://www.gakunin.jp/profile/AAL2":"AAL2"}',
          'assurance.ida_profile': JSON.stringify({
            trust_framework: 'nist_800_63A',
            assurance_levels: { IAL2: 'nist_800_63A_ial_2' },
            claims: ['given_name', 'family_name', 'birthdate'],
          }),
        });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { rejected?: object }).rejected ?? {}).toEqual({});
        expect(
          (await patchAt(app, mockEnv, url, { 'assurance.ida_profile': '{}' })).status
        ).not.toBe(400);
      });

      it('accepts the SCIM IAL ceiling only as a whole number from 1 to 3', async () => {
        const { app, mockEnv } = createTestApp({ kv: createMockKV() });
        const url = '/api/admin/tenants/tenant_123/settings/assurance';
        for (const value of [0, 4, -1, 1.5, '2', 'IAL2', null, true]) {
          const res = await patchAt(app, mockEnv, url, { 'assurance.scim_max_ial': value });
          expect(res.status, JSON.stringify(value)).toBe(400);
          expect((await res.json()) as ApiResponse).toMatchObject({ error: 'validation_failed' });
        }
        for (const value of [1, 2, 3]) {
          const res = await patchAt(app, mockEnv, url, { 'assurance.scim_max_ial': value });
          expect(res.status, String(value)).toBe(200);
        }
      });

      it('accepts advertised claims only as empty or comma-separated names', async () => {
        const { app, mockEnv } = createTestApp({ kv: createMockKV() });
        for (const url of [
          '/api/admin/platform/settings/discovery',
          '/api/admin/tenants/tenant_123/settings/discovery',
        ]) {
          for (const set of [
            { 'discovery.claims_supported': 'sub,,email' },
            { 'discovery.claims_supported': ' ' },
          ]) {
            const res = await patchAt(app, mockEnv, url, set);
            expect(res.status, `${url} ${JSON.stringify(set)}`).toBe(400);
          }
          for (const value of ['', 'sub,email']) {
            const res = await patchAt(app, mockEnv, url, { 'discovery.claims_supported': value });
            expect(res.status, `${url} ${value}`).toBe(200);
          }
        }
      });

      it('accepts a JIT provider list only as empty or IDs, none of them empty', async () => {
        const { app, mockEnv } = createTestApp({ kv: createMockKV() });
        for (const url of [
          '/api/admin/platform/settings/external-idp',
          '/api/admin/tenants/tenant_123/settings/external-idp',
        ]) {
          for (const value of [' ', ',,', 'idp-a,,idp-b', ['idp-a']]) {
            const res = await patchAt(app, mockEnv, url, {
              'external_idp.jit_allowed_provider_ids': value,
            });
            expect(res.status, `${url} ${JSON.stringify(value)}`).toBe(400);
          }
          for (const value of ['', 'idp-a, idp-b', '-']) {
            const res = await patchAt(app, mockEnv, url, {
              'external_idp.jit_allowed_provider_ids': value,
            });
            expect(res.status, `${url} ${JSON.stringify(value)}`).toBe(200);
          }
        }
      });

      it('accepts only profile fields, each once, as the fields JIT updates on login', async () => {
        const { app, mockEnv } = createTestApp({ kv: createMockKV() });
        for (const url of [
          '/api/admin/platform/settings/external-idp',
          '/api/admin/tenants/tenant_123/settings/external-idp',
        ]) {
          for (const value of ['name', ['email'], ['preferred_username'], ['name', 'name'], [1]]) {
            // The fields apply with updates on login on (dependsOn).
            const res = await patchAt(app, mockEnv, url, {
              'external_idp.jit_update_on_login': true,
              'external_idp.jit_update_fields': value,
            });
            expect(res.status, `${url} ${JSON.stringify(value)}`).toBe(400);
          }
          for (const value of [[], ['nickname', 'website', 'locale']]) {
            // The fields apply with updates on login on (dependsOn).
            const res = await patchAt(app, mockEnv, url, {
              'external_idp.jit_update_on_login': true,
              'external_idp.jit_update_fields': value,
            });
            expect(res.status, `${url} ${JSON.stringify(value)}`).toBe(200);
          }
        }
      });

      it('accepts only a platform UI on an allowed origin, with paths on that host', async () => {
        const { app, mockEnv } = createTestApp({
          kv: createMockKV(),
          env: {
            ISSUER_URL: 'https://id.example.com',
            ALLOWED_ORIGINS: 'https://login.example.org',
          },
        });
        const url = '/api/admin/platform/settings/tenant';
        for (const set of [
          { 'tenant.ui_base_url': 'https://evil.example.net' },
          { 'tenant.ui_base_url': '' },
          { 'tenant.ui_login_path': '//evil.example.net/login' },
          { 'tenant.ui_device_authorize_path': '/device#x' },
        ]) {
          const res = await patchAt(app, mockEnv, url, set);
          expect(res.status, JSON.stringify(set)).toBe(400);
        }
        const res = await patchAt(app, mockEnv, url, {
          'tenant.ui_base_url': 'https://login.example.org',
          'tenant.ui_device_path': '/activate',
        });
        expect(res.status).toBe(200);
      });
    });

    describe('PUT /platform/settings/:category', () => {
      it('should return 405 Method Not Allowed', async () => {
        const { app, mockEnv } = createTestApp();

        const res = await app.request(
          '/api/admin/platform/settings/infrastructure',
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          },
          mockEnv
        );

        expect(res.status).toBe(405);
      });
    });

    describe('DELETE /platform/settings/:category', () => {
      it('should return 405 Method Not Allowed', async () => {
        const { app, mockEnv } = createTestApp();

        const res = await app.request(
          '/api/admin/platform/settings/infrastructure',
          { method: 'DELETE' },
          mockEnv
        );

        expect(res.status).toBe(405);
      });
    });
  });

  describe('Meta API', () => {
    describe('GET /settings/meta/:category', () => {
      it('should return category metadata', async () => {
        const { app, mockEnv } = createTestApp();

        const res = await app.request('/api/admin/settings/meta/oauth', { method: 'GET' }, mockEnv);

        expect(res.status).toBe(200);
        const body = (await res.json()) as ApiResponse;

        expect(body.category).toBe('oauth');
        expect(body.label).toBeDefined();
        expect(body.description).toBeDefined();
        expect(body.settings).toBeDefined();
        expect(typeof body.settings).toBe('object');
      });

      it('should return login-entry metadata with App Login settings', async () => {
        const { app, mockEnv } = createTestApp();

        const res = await app.request(
          '/api/admin/settings/meta/login-entry',
          { method: 'GET' },
          mockEnv
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as ApiResponse & {
          settings: Record<string, unknown>;
        };

        expect(body.category).toBe('login-entry');
        expect(Object.keys(body.settings)).toHaveLength(17);
        expect(body.settings).toHaveProperty('login-entry.app_login_client_id');
        expect(body.settings).toHaveProperty('login-entry.app_login_redirect_uri');
      });

      it('should return 404 for unknown category', async () => {
        const { app, mockEnv } = createTestApp();

        const res = await app.request(
          '/api/admin/settings/meta/unknown',
          { method: 'GET' },
          mockEnv
        );

        expect(res.status).toBe(404);
      });
    });

    describe('GET /settings/meta', () => {
      it('should return list of all categories', async () => {
        const { app, mockEnv } = createTestApp();

        const res = await app.request('/api/admin/settings/meta', { method: 'GET' }, mockEnv);

        expect(res.status).toBe(200);
        const body = (await res.json()) as { categories: ApiResponse[] };

        expect(body.categories).toBeDefined();
        expect(Array.isArray(body.categories)).toBe(true);
        expect(body.categories.length).toBeGreaterThan(0);

        // Check each category has required fields
        for (const cat of body.categories) {
          expect(cat).toHaveProperty('category');
          expect(cat).toHaveProperty('label');
          expect(cat).toHaveProperty('description');
          expect(cat).toHaveProperty('settingsCount');
        }
      });
    });
  });

  describe('CIBA bounds on PATCH /tenants/:tenantId/settings/ciba', () => {
    async function patcher(env: Record<string, string> = {}, stored: Record<string, string> = {}) {
      const mockKV = createMockKV(stored);
      const { app, mockEnv } = createTestApp({ kv: mockKV, env });
      const patch = async (body: Record<string, unknown>) => {
        const getRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/ciba',
          { method: 'GET' },
          mockEnv
        );
        const current = (await getRes.json()) as SettingsGetResult;
        return app.request(
          '/api/admin/tenants/tenant_123/settings/ciba',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ifMatch: current.version, ...body }),
          },
          mockEnv
        );
      };
      /** The effective values and where each comes from, read back through the API. */
      const read = async () => {
        const res = await app.request(
          '/api/admin/tenants/tenant_123/settings/ciba',
          { method: 'GET' },
          mockEnv
        );
        return (await res.json()) as SettingsGetResult;
      };
      return Object.assign(patch, { read });
    }

    it.each([
      [{ 'ciba.min_expires_in': 500, 'ciba.max_expires_in': 100 }, 'ciba.min_expires_in'],
      [{ 'ciba.min_interval': 30, 'ciba.max_interval': 10 }, 'ciba.min_interval'],
      [{ 'ciba.expires_in': 100, 'ciba.min_expires_in': 200 }, 'ciba.expires_in'],
      [{ 'ciba.poll_interval': 30, 'ciba.max_interval': 10 }, 'ciba.poll_interval'],
      [{ 'ciba.min_interval': 1 }, 'ciba.min_interval'],
    ])('refuses %j', async (set, namedKey) => {
      const patch = await patcher();
      const res = await patch({ set });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ApiResponse;
      expect(body.error).toBe('validation_failed');
      expect(body.message as string).toContain(namedKey);
    });

    it('checks a value against the bounds already saved, not only against the PATCH', async () => {
      const patch = await patcher();
      expect((await patch({ set: { 'ciba.max_interval': 20 } })).status).toBe(200);

      const res = await patch({ set: { 'ciba.min_interval': 30 } });
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiResponse).message as string).toContain('ciba.max_interval');

      // the default poll interval of 5 is inside [2, 20]; one above the saved maximum is not
      const poll = await patch({ set: { 'ciba.poll_interval': 25 } });
      expect(poll.status).toBe(400);
    });

    it('accepts a consistent document, and a cleared key counts as its default', async () => {
      const patch = await patcher();
      const ok = await patch({
        set: {
          'ciba.min_expires_in': 90,
          'ciba.max_expires_in': 300,
          'ciba.expires_in': 200,
          'ciba.min_interval': 3,
          'ciba.max_interval': 90,
          'ciba.poll_interval': 10,
        },
      });
      expect(ok.status).toBe(200);

      expect((await patch({ clear: ['ciba.max_expires_in', 'ciba.min_interval'] })).status).toBe(
        200
      );
      // The cleared maximum counts as its default (600)
      expect(
        (await patch({ set: { 'ciba.min_expires_in': 150 }, clear: ['ciba.max_expires_in'] }))
          .status
      ).toBe(200);
    });

    describe('a cleared key takes what it inherits, here from the environment', () => {
      it('accepts a clear that the environment value makes consistent', async () => {
        const patch = await patcher({ CIBA_DEFAULT_INTERVAL: '30' });
        expect(
          (
            await patch({
              set: { 'ciba.min_interval': 20, 'ciba.max_interval': 60, 'ciba.poll_interval': 60 },
            })
          ).status
        ).toBe(200);

        // Cleared, the poll interval is 30 (inside [20, 60]); as the default 5 it would be below 20
        const res = await patch({ clear: ['ciba.poll_interval'] });
        expect(res.status).toBe(200);
        const after = await patch.read();
        expect(after.values['ciba.poll_interval']).toBe(30);
        expect(after.sources['ciba.poll_interval']).toBe('env');
      });

      it('refuses a clear that the environment value makes inconsistent, and changes nothing', async () => {
        const patch = await patcher({ CIBA_MAX_INTERVAL: '10' });
        expect(
          (await patch({ set: { 'ciba.poll_interval': 20, 'ciba.max_interval': 60 } })).status
        ).toBe(200);

        const res = await patch({ clear: ['ciba.max_interval'] });
        expect(res.status).toBe(400);
        const body = (await res.json()) as ApiResponse;
        expect(body.message as string).toMatch(/poll_interval \(20\).*max_interval \(10\)/);
        const after = await patch.read();
        expect(after.values['ciba.max_interval']).toBe(60);
        expect(after.sources['ciba.max_interval']).toBe('kv');
        expect(after.values['ciba.poll_interval']).toBe(20);
      });
    });

    describe('a PATCH with a key that would be refused alone saves nothing', () => {
      it.each([
        [{ set: { 'ciba.min_interval': 6, 'ciba.poll_interval': 6.5 } }, 'ciba.poll_interval'],
        [{ set: { 'ciba.min_interval': 6, 'ciba.poll_interval': 'ten' } }, 'ciba.poll_interval'],
        [{ set: { 'ciba.min_interval': 6, 'ciba.poll_interval': 500 } }, 'ciba.poll_interval'],
        [
          {
            set: { 'ciba.min_interval': 6, 'ciba.poll_interval': 10 },
            clear: ['ciba.poll_interval'],
          },
          'ciba.poll_interval',
        ],
        [
          { set: { 'ciba.min_interval': 6, 'ciba.binding_message_required': 'yes' } },
          'ciba.binding_message_required',
        ],
        [{ set: { 'ciba.min_interval': 6 }, disable: ['ciba.max_interval'] }, 'ciba.max_interval'],
        [{ set: { 'ciba.min_interval': 6, 'ciba.unknown_key': 1 } }, 'ciba.unknown_key'],
      ])('%j', async (body, namedKey) => {
        const patch = await patcher();
        const before = await patch.read();

        const res = await patch(body);

        expect(res.status).toBe(400);
        expect(((await res.json()) as ApiResponse).message as string).toContain(namedKey);
        const after = await patch.read();
        expect(after.values).toEqual(before.values);
        expect(after.sources['ciba.min_interval']).not.toBe('kv');
        expect(after.version).toBe(before.version);
      });

      it('saves a fractional value of a setting that does not require a whole number', async () => {
        const patch = await patcher();
        const res = await patch({
          set: { 'ciba.push_notification_timeout_ms': 2500.5, 'ciba.min_interval': 3 },
        });

        expect(res.status).toBe(200);
        const after = await patch.read();
        expect(after.values['ciba.push_notification_timeout_ms']).toBe(2500.5);
        expect(after.sources['ciba.push_notification_timeout_ms']).toBe('kv');
        expect(after.values['ciba.min_interval']).toBe(3);
      });

      it('refuses the whole patch for a fractional value of a whole-number setting, next to a fractional one that is allowed', async () => {
        const patch = await patcher();
        const before = await patch.read();

        const res = await patch({
          set: { 'ciba.push_notification_timeout_ms': 2500.5, 'ciba.poll_interval': 6.5 },
        });

        expect(res.status).toBe(400);
        expect(((await res.json()) as ApiResponse).message as string).toContain(
          'ciba.poll_interval'
        );
        const after = await patch.read();
        expect(after.values).toEqual(before.values);
        expect(after.version).toBe(before.version);
        expect(after.sources['ciba.push_notification_timeout_ms']).not.toBe('kv');
      });

      it.each([
        ['ciba.slow_down_increment', 4],
        ['ciba.slow_down_increment', 5.5],
        ['ciba.max_poll_count', 9],
        ['ciba.ping_notification_timeout_ms', 999],
        ['ciba.ping_notification_timeout_ms', 2500.5],
      ])('refuses %s = %s and saves nothing', async (key, value) => {
        const patch = await patcher();
        const before = await patch.read();

        const res = await patch({ set: { [key]: value, 'ciba.min_interval': 3 } });

        expect(res.status).toBe(400);
        expect(((await res.json()) as ApiResponse).message as string).toContain(key);
        const after = await patch.read();
        expect(after.version).toBe(before.version);
        expect(after.sources['ciba.min_interval']).not.toBe('kv');
      });

      it('saves the new CIBA settings and reads them back', async () => {
        const patch = await patcher();
        const res = await patch({
          set: {
            'ciba.slow_down_increment': 10,
            'ciba.max_poll_count': 200,
            'ciba.user_code_enabled': true,
            'ciba.ping_notification_timeout_ms': 8000,
          },
        });

        expect(res.status).toBe(200);
        const after = await patch.read();
        expect(after.values).toMatchObject({
          'ciba.slow_down_increment': 10,
          'ciba.max_poll_count': 200,
          'ciba.user_code_enabled': true,
          'ciba.ping_notification_timeout_ms': 8000,
        });
      });

      describe('a document saved before four CIBA settings were retired', () => {
        const retired = {
          'ciba.auth_request_ttl': 120,
          'ciba.notifier_default_timeout_ms': 2000,
          'ciba.notifier_max_timeout_ms': 9000,
          'ciba.notifier_retry_delay_base_ms': 500,
        };
        const saved = {
          'settings:tenant:tenant_123:ciba': JSON.stringify({
            'ciba.expires_in': 200,
            ...retired,
          }),
        };

        it('reads without the retired keys, and keeps the others', async () => {
          const patch = await patcher({}, saved);
          const read = await patch.read();

          expect(read.values['ciba.expires_in']).toBe(200);
          expect(read.sources['ciba.expires_in']).toBe('kv');
          for (const key of Object.keys(retired)) {
            expect(read.values).not.toHaveProperty(key);
            expect(read.sources).not.toHaveProperty(key);
          }
        });

        it('still saves another setting', async () => {
          const patch = await patcher({}, saved);

          const res = await patch({ set: { 'ciba.max_poll_count': 200 } });

          expect(res.status).toBe(200);
          const after = await patch.read();
          expect(after.values['ciba.max_poll_count']).toBe(200);
          expect(after.values['ciba.expires_in']).toBe(200);
        });

        it.each(Object.keys(retired))(
          'refuses setting %s again as not a CIBA setting',
          async (key) => {
            const patch = await patcher({}, saved);
            const before = await patch.read();

            const res = await patch({ set: { [key]: 1000 } });

            expect(res.status).toBe(400);
            expect(((await res.json()) as ApiResponse).message as string).toBe(
              `${key} is not a CIBA setting`
            );
            expect((await patch.read()).version).toBe(before.version);
          }
        );
      });

      it('still saves a fully valid patch', async () => {
        const patch = await patcher();
        const res = await patch({ set: { 'ciba.min_interval': 6, 'ciba.poll_interval': 10 } });
        expect(res.status).toBe(200);
        const after = await patch.read();
        expect(after.values['ciba.min_interval']).toBe(6);
        expect(after.values['ciba.poll_interval']).toBe(10);
      });
    });
  });

  describe('device flow bounds on PATCH /tenants/:tenantId/settings/device-flow', () => {
    async function patcher(env: Record<string, string> = {}, stored: Record<string, string> = {}) {
      const mockKV = createMockKV(stored);
      const { app, mockEnv } = createTestApp({ kv: mockKV, env });
      const url = '/api/admin/tenants/tenant_123/settings/device-flow';
      const read = async () => {
        const res = await app.request(url, { method: 'GET' }, mockEnv);
        return (await res.json()) as SettingsGetResult;
      };
      const patch = async (body: Record<string, unknown>) => {
        const current = await read();
        return app.request(
          url,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ifMatch: current.version, ...body }),
          },
          mockEnv
        );
      };
      return Object.assign(patch, { read });
    }

    it.each([
      [{ 'device_flow.min_expires_in': 900, 'device_flow.max_expires_in': 400 }, 'min_expires_in'],
      [{ 'device_flow.min_interval': 30, 'device_flow.max_interval': 10 }, 'min_interval'],
      [{ 'device_flow.expires_in': 400, 'device_flow.min_expires_in': 700 }, 'expires_in'],
      [{ 'device_flow.poll_interval': 30, 'device_flow.max_interval': 10 }, 'poll_interval'],
      [{ 'device_flow.poll_interval': 2 }, 'poll_interval'],
    ])('refuses %j', async (set, namedKey) => {
      const patch = await patcher();
      const before = await patch.read();
      const res = await patch({ set });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ApiResponse;
      expect(body.error).toBe('validation_failed');
      expect(body.message as string).toContain(namedKey);
      const after = await patch.read();
      expect(after.version).toBe(before.version);
      expect(after.values).toEqual(before.values);
    });

    it('saves a consistent document and reads it back', async () => {
      const patch = await patcher();
      const res = await patch({
        set: {
          'device_flow.min_expires_in': 400,
          'device_flow.max_expires_in': 1200,
          'device_flow.expires_in': 900,
          'device_flow.min_interval': 3,
          'device_flow.max_interval': 90,
          'device_flow.poll_interval': 10,
          'device_flow.slow_down_increment': 10,
          'device_flow.max_poll_count': 200,
        },
      });

      expect(res.status).toBe(200);
      const after = await patch.read();
      expect(after.values).toMatchObject({
        'device_flow.expires_in': 900,
        'device_flow.poll_interval': 10,
        'device_flow.slow_down_increment': 10,
        'device_flow.max_poll_count': 200,
      });
      expect(after.sources['device_flow.expires_in']).toBe('kv');
    });

    it('checks a value against the bounds already saved, not only against the PATCH', async () => {
      const patch = await patcher();
      expect((await patch({ set: { 'device_flow.max_interval': 20 } })).status).toBe(200);

      const res = await patch({ set: { 'device_flow.min_interval': 30 } });
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiResponse).message as string).toContain(
        'device_flow.max_interval'
      );
      expect((await patch({ set: { 'device_flow.poll_interval': 25 } })).status).toBe(400);
    });

    it('takes a cleared key as what it inherits from the environment', async () => {
      const patch = await patcher({ DEVICE_FLOW_MAX_INTERVAL: '10' });
      expect(
        (await patch({ set: { 'device_flow.poll_interval': 20, 'device_flow.max_interval': 60 } }))
          .status
      ).toBe(200);

      const res = await patch({ clear: ['device_flow.max_interval'] });
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiResponse).message as string).toMatch(
        /poll_interval \(20\).*max_interval \(10\)/
      );
      const after = await patch.read();
      expect(after.values['device_flow.max_interval']).toBe(60);
      expect(after.sources['device_flow.max_interval']).toBe('kv');
    });

    describe('the user code charset and length (entropy floor of 34 bits)', () => {
      const CHARSET = 'device_flow.user_code_charset';
      const LENGTH = 'device_flow.user_code_length';

      it('reads BASE31 x 8 when nothing is saved', async () => {
        const patch = await patcher();
        const before = await patch.read();

        expect(before.values[CHARSET]).toBe('BASE31');
        expect(before.values[LENGTH]).toBe(8);
      });

      it.each([
        [{ [CHARSET]: 'NUMERIC', [LENGTH]: 10 }, /at least 11 characters with NUMERIC/],
        [{ [CHARSET]: 'NUMERIC' }, /user_code_length \(8\).*at least 11 characters with NUMERIC/],
        [{ [CHARSET]: 'BASE20', [LENGTH]: 7 }, /at least 8 characters with BASE20/],
        [{ [LENGTH]: 6 }, /at least 7 characters with BASE31/],
        [{ [CHARSET]: 'HEX' }, /must be one of: BASE31, BASE20, NUMERIC/],
        [{ [LENGTH]: 17 }, /user_code_length/],
      ])('refuses %j, names the minimum, and the read-back is unchanged', async (set, message) => {
        const patch = await patcher();
        const before = await patch.read();

        const res = await patch({ set });

        expect(res.status).toBe(400);
        const body = (await res.json()) as ApiResponse;
        expect(body.error).toBe('validation_failed');
        expect(body.message as string).toMatch(message);
        const after = await patch.read();
        expect(after.version).toBe(before.version);
        expect(after.values).toEqual(before.values);
        expect(after.sources[CHARSET]).not.toBe('kv');
        expect(after.sources[LENGTH]).not.toBe('kv');
      });

      it('saves a pair at or above the floor, in one request, and reads it back', async () => {
        const patch = await patcher();

        expect((await patch({ set: { [CHARSET]: 'NUMERIC', [LENGTH]: 11 } })).status).toBe(200);

        const after = await patch.read();
        expect(after.values).toMatchObject({ [CHARSET]: 'NUMERIC', [LENGTH]: 11 });
        expect(after.sources[CHARSET]).toBe('kv');
      });

      it('refuses a partial patch that would leave a pair below the floor, and keeps the saved pair', async () => {
        const patch = await patcher();
        expect((await patch({ set: { [CHARSET]: 'NUMERIC', [LENGTH]: 12 } })).status).toBe(200);
        const before = await patch.read();

        // the length alone falls under the NUMERIC floor
        const res = await patch({ set: { [LENGTH]: 10, 'device_flow.max_poll_count': 200 } });

        expect(res.status).toBe(400);
        const after = await patch.read();
        expect(after.values).toEqual(before.values);
        expect(after.version).toBe(before.version);
        expect(after.values[LENGTH]).toBe(12);
        expect(after.values['device_flow.max_poll_count']).not.toBe(200);
      });

      it('takes a cleared key as what it inherits (an environment variable)', async () => {
        const patch = await patcher({ DEVICE_FLOW_USER_CODE_LENGTH: '8' });
        expect((await patch({ set: { [CHARSET]: 'NUMERIC', [LENGTH]: 12 } })).status).toBe(200);

        const res = await patch({ clear: [LENGTH] });

        expect(res.status).toBe(400);
        expect(((await res.json()) as ApiResponse).message as string).toMatch(
          /user_code_length \(8\).*at least 11 characters with NUMERIC/
        );
        expect((await patch.read()).values[LENGTH]).toBe(12);
        // clearing both is fine: BASE31 x 8 (the environment length) is above the floor
        expect((await patch({ clear: [CHARSET, LENGTH] })).status).toBe(200);
        const cleared = await patch.read();
        expect(cleared.values).toMatchObject({ [CHARSET]: 'BASE31', [LENGTH]: 8 });
      });
    });

    describe('a PATCH with a key that would be refused alone saves nothing', () => {
      it.each([
        [
          { set: { 'device_flow.min_interval': 6, 'device_flow.poll_interval': 6.5 } },
          'device_flow.poll_interval',
        ],
        [
          { set: { 'device_flow.min_interval': 6, 'device_flow.slow_down_increment': 4 } },
          'device_flow.slow_down_increment',
        ],
        [
          { set: { 'device_flow.min_interval': 6, 'device_flow.max_poll_count': 9 } },
          'device_flow.max_poll_count',
        ],
        [
          { set: { 'device_flow.min_interval': 6, 'device_flow.expires_in': 'long' } },
          'device_flow.expires_in',
        ],
        [
          {
            set: { 'device_flow.min_interval': 6, 'device_flow.poll_interval': 10 },
            clear: ['device_flow.poll_interval'],
          },
          'device_flow.poll_interval',
        ],
        [
          { set: { 'device_flow.min_interval': 6 }, disable: ['device_flow.max_interval'] },
          'device_flow.max_interval',
        ],
        [
          { set: { 'device_flow.min_interval': 6, 'device_flow.unknown_key': 1 } },
          'device_flow.unknown_key',
        ],
      ])('%j', async (body, namedKey) => {
        const patch = await patcher();
        const before = await patch.read();

        const res = await patch(body);

        expect(res.status).toBe(400);
        expect(((await res.json()) as ApiResponse).message as string).toContain(namedKey);
        const after = await patch.read();
        expect(after.values).toEqual(before.values);
        expect(after.sources['device_flow.min_interval']).not.toBe('kv');
        expect(after.version).toBe(before.version);
      });
    });
  });

  describe('device flow bounds on PATCH /clients/:clientId/settings/device-flow', () => {
    const headers = { 'Content-Type': 'application/json', 'X-Tenant-Id': 'test-tenant' };
    const tenantUrl = '/api/admin/tenants/test-tenant/settings/device-flow';
    const clientUrl = '/api/admin/clients/client_abc/settings/device-flow';

    function setup(env: Record<string, string> = {}) {
      const mockKV = createMockKV({
        'client:test-tenant:client_abc:metadata': JSON.stringify({ tenant_id: 'test-tenant' }),
      });
      const { app, mockEnv } = createTestApp({ kv: mockKV, tenantId: 'test-tenant', env });
      const read = async (url: string) =>
        (await (
          await app.request(url, { method: 'GET', headers }, mockEnv)
        ).json()) as SettingsGetResult;
      const save = async (url: string, body: Record<string, unknown>) => {
        const current = await read(url);
        return app.request(
          url,
          {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ ifMatch: current.version, ...body }),
          },
          mockEnv
        );
      };
      return {
        tenant: (body: Record<string, unknown>) => save(tenantUrl, body),
        client: (body: Record<string, unknown>) => save(clientUrl, body),
        readClient: () => read(clientUrl),
        readTenant: () => read(tenantUrl),
      };
    }

    const tenantBounds = {
      'device_flow.min_expires_in': 400,
      'device_flow.max_expires_in': 900,
      'device_flow.max_interval': 30,
    };

    it('saves a lifetime and an interval inside the tenant bounds and reads them back', async () => {
      const api = setup();
      expect((await api.tenant({ set: tenantBounds })).status).toBe(200);

      const res = await api.client({
        set: { 'device_flow.expires_in': 450, 'device_flow.poll_interval': 8 },
      });

      expect(res.status).toBe(200);
      const after = await api.readClient();
      expect(after.values).toMatchObject({
        'device_flow.expires_in': 450,
        'device_flow.poll_interval': 8,
      });
      expect(after.sources['device_flow.expires_in']).toBe('kv');
      // the tenant's own document is untouched
      expect((await api.readTenant()).values['device_flow.expires_in']).toBe(600);
    });

    it.each([
      [{ 'device_flow.expires_in': 1500 }, 'device_flow.expires_in'],
      [{ 'device_flow.expires_in': 350 }, 'device_flow.expires_in'],
      [{ 'device_flow.poll_interval': 45 }, 'device_flow.poll_interval'],
    ])('refuses %j against the tenant bounds and saves nothing', async (set, namedKey) => {
      const api = setup();
      await api.tenant({ set: tenantBounds });
      const before = await api.readClient();

      const res = await api.client({ set });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ApiResponse;
      expect(body.error).toBe('validation_failed');
      expect(body.message as string).toContain(namedKey);
      const after = await api.readClient();
      expect(after.version).toBe(before.version);
      expect(after.values).toEqual(before.values);
    });

    it.each([
      [{ 'device_flow.max_expires_in': 1200 }, 'device_flow.max_expires_in'],
      [{ 'device_flow.min_expires_in': 300 }, 'device_flow.min_expires_in'],
      [{ 'device_flow.max_interval': 60 }, 'device_flow.max_interval'],
    ])('refuses %j: a client can only narrow the tenant bounds', async (set, namedKey) => {
      const api = setup();
      await api.tenant({ set: tenantBounds });
      const before = await api.readClient();

      const res = await api.client({ set });

      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiResponse).message as string).toContain(namedKey);
      expect((await api.readClient()).version).toBe(before.version);
    });

    it('accepts bounds that narrow the tenant bounds', async () => {
      const api = setup();
      await api.tenant({ set: tenantBounds });

      const res = await api.client({
        set: {
          'device_flow.min_expires_in': 500,
          'device_flow.max_expires_in': 600,
          'device_flow.max_interval': 20,
        },
      });

      expect(res.status).toBe(200);
      expect((await api.readClient()).values['device_flow.max_expires_in']).toBe(600);
    });

    it.each([
      [{ 'device_flow.user_code_charset': 'BASE31' }, 'device_flow.user_code_charset'],
      [{ 'device_flow.user_code_length': 12 }, 'device_flow.user_code_length'],
    ])('refuses %j: the user code format is a tenant setting', async (set, namedKey) => {
      const api = setup();
      const before = await api.readClient();

      const res = await api.client({ set });

      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiResponse).message as string).toContain(namedKey);
      const after = await api.readClient();
      expect(after.version).toBe(before.version);
      expect(after.values).toEqual(before.values);
    });

    it('shows a client the tenant user code format', async () => {
      // the tenant sets BASE20 x 9; the client has no value of its own for these keys
      const api = setup();
      await api.tenant({
        set: { 'device_flow.user_code_charset': 'BASE20', 'device_flow.user_code_length': 9 },
      });

      const client = await api.readClient();

      expect(client.values['device_flow.user_code_charset']).toBe('BASE20');
      expect(client.values['device_flow.user_code_length']).toBe(9);
    });

    it('checks the relations of the PATCH itself', async () => {
      const api = setup();
      const res = await api.client({
        set: { 'device_flow.min_interval': 20, 'device_flow.max_interval': 10 },
      });

      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiResponse).message as string).toContain(
        'device_flow.min_interval'
      );
    });

    it('refuses the whole patch when a key of it would be refused alone, and saves nothing', async () => {
      const api = setup();
      const before = await api.readClient();

      const res = await api.client({
        set: { 'device_flow.max_poll_count': 200, 'device_flow.slow_down_increment': 4 },
      });

      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiResponse).message as string).toContain(
        'device_flow.slow_down_increment'
      );
      const after = await api.readClient();
      expect(after.version).toBe(before.version);
      expect(after.sources['device_flow.max_poll_count']).not.toBe('kv');
    });

    it('takes a cleared key as the tenant value', async () => {
      const api = setup();
      await api.tenant({ set: { 'device_flow.max_interval': 30 } });
      expect(
        (
          await api.client({
            set: { 'device_flow.max_interval': 20, 'device_flow.poll_interval': 25 },
          })
        ).status
      ).toBe(400);
      expect(
        (
          await api.client({
            set: { 'device_flow.max_interval': 25, 'device_flow.poll_interval': 25 },
          })
        ).status
      ).toBe(200);

      // Cleared, the client's maximum is the tenant's 30, which still fits
      expect((await api.client({ clear: ['device_flow.max_interval'] })).status).toBe(200);
      const after = await api.readClient();
      expect(after.values['device_flow.max_interval']).toBe(30);
      expect(after.sources['device_flow.max_interval']).toBe('tenant');
    });
  });

  describe('tenant.name, retired from the tenant category', () => {
    const saved = {
      'settings:tenant:tenant_123:tenant': JSON.stringify({
        'tenant.name': 'Stale name',
        'tenant.logo_uri': 'https://cdn.example/logo.svg',
      }),
    };
    async function tenantSettings(env: Record<string, string> = {}) {
      const { app, mockEnv } = createTestApp({ kv: createMockKV(saved), env });
      const read = async () =>
        (await (
          await app.request(
            '/api/admin/tenants/tenant_123/settings/tenant',
            { method: 'GET' },
            mockEnv
          )
        ).json()) as SettingsGetResult;
      const patch = async (body: Record<string, unknown>) =>
        app.request(
          '/api/admin/tenants/tenant_123/settings/tenant',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ifMatch: (await read()).version, ...body }),
          },
          mockEnv
        );
      return { read, patch };
    }

    it('reads without the stored name or the TENANT_NAME variable, and keeps the other values', async () => {
      const { read } = await tenantSettings({ TENANT_NAME: 'From env' });
      const view = await read();

      expect(view.values['tenant.logo_uri']).toBe('https://cdn.example/logo.svg');
      expect(view.values).not.toHaveProperty('tenant.name');
      expect(view.sources).not.toHaveProperty('tenant.name');
    });

    it('still saves another setting while the document holds the stale name', async () => {
      const { read, patch } = await tenantSettings();
      const res = await patch({ set: { 'tenant.logo_uri': 'https://cdn.example/new.svg' } });

      expect(res.status).toBe(200);
      expect((await read()).values['tenant.logo_uri']).toBe('https://cdn.example/new.svg');
    });

    it.each(['set', 'clear', 'disable'])(
      'refuses naming it in %s as not a tenant setting',
      async (op) => {
        const { read, patch } = await tenantSettings();
        const before = await read();

        const res = await patch(
          op === 'set' ? { set: { 'tenant.name': 'New name' } } : { [op]: ['tenant.name'] }
        );

        expect(res.status).toBe(400);
        expect(((await res.json()) as ApiResponse).message).toBe(
          'tenant.name is not a tenant setting'
        );
        expect((await read()).version).toBe(before.version);
      }
    );

    it('refuses the whole PATCH when it names the retired key next to a valid one', async () => {
      const { read, patch } = await tenantSettings();
      const before = await read();

      const res = await patch({
        set: { 'tenant.name': 'New name', 'tenant.logo_uri': 'https://cdn.example/new.svg' },
      });

      expect(res.status).toBe(400);
      const after = await read();
      expect(after.version).toBe(before.version);
      expect(after.values['tenant.logo_uri']).toBe('https://cdn.example/logo.svg');
    });
  });

  describe.each([
    {
      category: 'plugin',
      noun: 'plugin',
      retired: [
        'plugin.memory_limit_mb',
        'plugin.notifier_console_enabled',
        'plugin.execution_timeout_ms',
        'plugin.auto_update_check',
        'plugin.notifier_resend_enabled',
      ],
      stale: {
        'plugin.memory_limit_mb': 256,
        'plugin.notifier_console_enabled': true,
        'plugin.execution_timeout_ms': 30000,
        'plugin.auto_update_check': true,
        'plugin.notifier_resend_enabled': false,
      },
      env: {
        PLUGIN_MEMORY_LIMIT_MB: '512',
        PLUGIN_NOTIFIER_CONSOLE_ENABLED: 'true',
        PLUGIN_EXECUTION_TIMEOUT_MS: '30000',
        PLUGIN_AUTO_UPDATE_CHECK: 'true',
        PLUGIN_NOTIFIER_RESEND_ENABLED: 'false',
      } as Record<string, string>,
      kept: ['plugin.enabled', true] as const,
    },
    {
      category: 'diagnostic-logging',
      noun: 'diagnostic logging',
      retired: ['diagnostic-logging.filter_tokens'],
      stale: { 'diagnostic-logging.filter_tokens': false },
      env: { DIAGNOSTIC_LOGGING_FILTER_TOKENS: 'false' } as Record<string, string>,
      kept: ['diagnostic-logging.filter_pii', false] as const,
    },
  ])('retired $category settings', ({ category, noun, retired, stale, env, kept }) => {
    const saved = {
      [`settings:tenant:tenant_123:${category}`]: JSON.stringify({ ...stale, [kept[0]]: kept[1] }),
    };
    async function categorySettings(vars: Record<string, string> = {}) {
      const { app, mockEnv } = createTestApp({ kv: createMockKV(saved), env: vars });
      const url = `/api/admin/tenants/tenant_123/settings/${category}`;
      const read = async () =>
        (await (await app.request(url, { method: 'GET' }, mockEnv)).json()) as SettingsGetResult;
      const patch = async (body: Record<string, unknown>) =>
        app.request(
          url,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ifMatch: (await read()).version, ...body }),
          },
          mockEnv
        );
      return { read, patch };
    }

    it('read without the stored values or the environment variables, keeping the others', async () => {
      const { read } = await categorySettings(env);
      const view = await read();

      expect(view.values[kept[0]]).toBe(kept[1]);
      expect(view.sources[kept[0]]).toBe('kv');
      for (const key of retired) {
        expect(view.values).not.toHaveProperty(key);
        expect(view.sources).not.toHaveProperty(key);
      }
    });

    it('are not listed in the category metadata', async () => {
      const { app, mockEnv } = createTestApp();
      const res = await app.request(
        `/api/admin/settings/meta/${category}`,
        { method: 'GET' },
        mockEnv
      );
      const body = (await res.json()) as { settings: Record<string, unknown> };

      expect(res.status).toBe(200);
      for (const key of retired) expect(body.settings).not.toHaveProperty(key);
    });

    it('do not stop another setting being saved', async () => {
      const { read, patch } = await categorySettings();
      const next =
        category === 'plugin'
          ? ['plugin.enabled', false]
          : ['diagnostic-logging.retention_days', 14];

      const res = await patch({ set: { [next[0] as string]: next[1] } });

      expect(res.status).toBe(200);
      expect((await read()).values[next[0] as string]).toBe(next[1]);
    });

    it.each(
      retired.flatMap((key) => (['set', 'clear', 'disable'] as const).map((op) => [key, op]))
    )('refuse naming %s in %s as not a setting of the category', async (key, op) => {
      const { read, patch } = await categorySettings();
      const before = await read();

      const res = await patch(op === 'set' ? { set: { [key]: 1 } } : { [op]: [key] });

      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiResponse).message).toBe(`${key} is not a ${noun} setting`);
      expect((await read()).version).toBe(before.version);
    });

    it('refuse the whole PATCH when it names a retired key next to a valid one', async () => {
      const { read, patch } = await categorySettings();
      const before = await read();

      const res = await patch({
        set: { [retired[0]]: 1, [kept[0]]: kept[1] === true ? false : true },
      });

      expect(res.status).toBe(400);
      const after = await read();
      expect(after.version).toBe(before.version);
      expect(after.values[kept[0]]).toBe(kept[1]);
    });
  });

  describe('plugin.enabled, the tenant permission for external plugin code', () => {
    const installationId = `plugin-installation-v1-${'a'.repeat(64)}`;
    const manifestDigest = 'c'.repeat(64);
    const approved = (pluginId: string) => ({
      pluginId,
      capabilityManifestDigest: manifestDigest,
      activeVersionDigest: 'a'.repeat(64),
      visibility: 'tenant' as const,
      capabilities: ['hook.account.lifecycle'],
      credentials: [],
      resources: [],
      updatedAt: 100,
    });

    function services(
      states: Record<string, 'enabled' | 'disabled'>,
      options: {
        failInstall?: string;
        failList?: boolean;
        failGate?: 'close' | 'open' | 'any';
        /** Only the nth close fails (1-based): a passing fault of the closing after the save. */
        failCloseFrom?: number;
        /** Runs right after the nth close was applied: something else happening at that moment. */
        afterClose?: (n: number, gate: { allowed: boolean; generation: number }) => void;
      } = {},
      onEvent: (event: string) => Promise<void> = async () => undefined
    ) {
      const gate = { allowed: false, generation: 0 };
      let closes = 0;
      const runner = {
        listTenantExternalGateCandidates: vi.fn(async () =>
          gate.allowed ? [{ tenantId: 'tenant_123', ...gate }] : []
        ),
        getTenantExternalGate: vi.fn(async (input: { tenantId: string }) => ({
          tenantId: input.tenantId,
          ...gate,
        })),
        setTenantExternalGate: vi.fn(
          async (input: { tenantId: string; allowed: boolean; ifGeneration?: number }) => {
            await onEvent(`gate:${input.allowed}`);
            const fails =
              options.failGate === 'any' ||
              (options.failGate === 'close' && !input.allowed) ||
              (options.failGate === 'open' && input.allowed);
            if (fails) throw new Error('plugin_sync_internal_error');
            // The runner's compare-and-swap: every close advances the generation, an open must
            // name the generation it read.
            if (input.allowed) {
              if (input.ifGeneration !== gate.generation) {
                throw new Error('plugin_dynamic_external_gate_generation_conflict');
              }
              if (!gate.allowed) {
                gate.allowed = true;
                gate.generation += 1;
              }
            } else {
              closes += 1;
              if (options.failCloseFrom !== undefined && closes === options.failCloseFrom) {
                throw new Error('plugin_sync_internal_error');
              }
              gate.allowed = false;
              gate.generation += 1;
              const reply = { tenantId: input.tenantId, ...gate };
              options.afterClose?.(closes, gate);
              return reply;
            }
            return { tenantId: input.tenantId, ...gate };
          }
        ),
        listApprovedDynamicPlugins: vi.fn(async () => {
          if (options.failList) throw new Error('runner_down');
          return Object.keys(states).map(approved);
        }),
        getDynamicPluginInstallationStatus: vi.fn(
          async (input: { tenantId: string; pluginId: string }) => ({
            installationId,
            tenantId: input.tenantId,
            pluginId: input.pluginId,
            state: states[input.pluginId],
            configVersion: 3,
            configuredKeys: [],
            missingRequiredFields: [],
            pinnedVersionDigest: states[input.pluginId] === 'enabled' ? 'a'.repeat(64) : null,
          })
        ),
        configureDynamicPluginInstallation: vi.fn(
          async (input: { tenantId: string; pluginId: string; enabled: boolean }) => {
            await onEvent(`install:${input.pluginId}:${input.enabled}`);
            if (input.pluginId === options.failInstall) throw new Error('runner_down');
            return {
              installationId,
              tenantId: input.tenantId,
              pluginId: input.pluginId,
              state: input.enabled ? ('enabled' as const) : ('disabled' as const),
              configVersion: 4,
              pinnedVersionDigest: input.enabled ? 'a'.repeat(64) : null,
            };
          }
        ),
      };
      const control = {
        validatePluginDynamicWorkerDesiredState: vi.fn(
          async (input: { tenantId: string; pluginId: string; enabled: boolean }) => ({
            environmentId: 'test',
            tenantId: input.tenantId,
            pluginId: input.pluginId,
            installationId,
            capabilityManifestDigest: manifestDigest,
            enabled: input.enabled,
            bindings: [],
            resources: [],
          })
        ),
        syncPluginDynamicWorkerObservedState: vi.fn(
          async (input: {
            installationId: string;
            tenantId: string;
            pluginId: string;
            state: 'enabled' | 'disabled';
            configVersion: number;
            pinnedVersionDigest: string | null;
          }) => ({
            operationId: 'op_sync',
            environmentId: 'test',
            capabilityManifestDigest: manifestDigest,
            enabled: input.state === 'enabled',
            bindings: [],
            resources: [],
            bindingStatus: 'deleted' as const,
            ...input,
          })
        ),
      };
      return { runner, control, gate };
    }

    async function pluginSettings(
      stored: boolean | null,
      states: Record<string, 'enabled' | 'disabled'>,
      options: {
        failInstall?: string;
        failList?: boolean;
        failGate?: 'close' | 'open' | 'any';
        failCloseFrom?: number;
        afterClose?: (n: number, gate: { allowed: boolean; generation: number }) => void;
        env?: Record<string, unknown>;
        noRunner?: boolean;
      } = {}
    ) {
      const events: string[] = [];
      let observe: (event: string) => Promise<void> = async () => undefined;
      const fake = services(states, options, (event) => observe(event));
      const { app, mockEnv } = createTestApp({
        kv: createMockKV(
          stored === null
            ? {}
            : { 'settings:tenant:tenant_123:plugin': JSON.stringify({ 'plugin.enabled': stored }) }
        ),
        env: {
          AUTHRIM_ENVIRONMENT_NAME: 'test',
          ...(options.noRunner ? {} : { PLUGIN_RUNNER: fake.runner, CONTROL: fake.control }),
          ...options.env,
        },
      });
      const url = '/api/admin/tenants/tenant_123/settings/plugin';
      const read = async () =>
        (await (await app.request(url, { method: 'GET' }, mockEnv)).json()) as SettingsGetResult;
      // Every runner call is recorded with the saved value as it stood when the call was made.
      observe = async (event) => {
        events.push(`${event}@saved=${String((await read()).values['plugin.enabled'])}`);
      };
      const patchRaw = async (body: Record<string, unknown>) =>
        app.request(
          url,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
          mockEnv
        );
      const patch = async (body: Record<string, unknown>) =>
        patchRaw({ ifMatch: (await read()).version, ...body });
      return { ...fake, env: mockEnv, events, read, patch, patchRaw };
    }

    const calledAudit = (action: string) =>
      vi.mocked(createAuditLogFromContext).mock.calls.filter(([, name]) => name === action);

    it('is off unless the tenant turns it on', async () => {
      const { read } = await pluginSettings(null, {});
      const view = await read();
      expect(view.values['plugin.enabled']).toBe(false);
      expect(view.sources['plugin.enabled']).toBe('default');
    });

    it.each([
      ['sets it to false', { set: { 'plugin.enabled': false } }],
      ['disables it', { disable: ['plugin.enabled'] }],
      ['clears the tenant value (nothing inherited is on)', { clear: ['plugin.enabled'] }],
    ])(
      'closes the runner gate, then switches installations off, then saves, when a PATCH %s',
      async (_, body) => {
        const { runner, control, events, read, patch } = await pluginSettings(true, {
          'custom-a': 'enabled',
        });

        const res = await patch(body);

        expect(res.status).toBe(200);
        expect((await read()).values['plugin.enabled']).toBe(false);
        // The gate is closed and the installations are off while the saved value still says on; the
        // gate is put in step with the saved value once more after the save.
        expect(events).toEqual([
          'gate:false@saved=true',
          'install:custom-a:false@saved=true',
          'gate:false@saved=false',
        ]);
        expect(runner.setTenantExternalGate).toHaveBeenCalledWith({
          tenantId: 'tenant_123',
          allowed: false,
        });
        expect(runner.configureDynamicPluginInstallation).toHaveBeenCalledWith({
          tenantId: 'tenant_123',
          pluginId: 'custom-a',
          enabled: false,
        });
        expect(control.syncPluginDynamicWorkerObservedState).toHaveBeenCalledTimes(1);
        expect(calledAudit('settings.plugin.external_shutdown')).toHaveLength(1);
        expect(calledAudit('settings.plugin.external_shutdown')[0][4]).toMatchObject({
          result: 'success',
          stopped_plugin_ids: ['custom-a'],
        });
      }
    );

    it('closes the gate even when no installation is on, and touches no installation that is off', async () => {
      const { runner, patch } = await pluginSettings(true, { 'custom-a': 'disabled' });

      expect((await patch({ set: { 'plugin.enabled': false } })).status).toBe(200);

      expect(runner.setTenantExternalGate).toHaveBeenCalledWith({
        tenantId: 'tenant_123',
        allowed: false,
      });
      expect(runner.configureDynamicPluginInstallation).not.toHaveBeenCalled();
      expect(calledAudit('settings.plugin.external_shutdown')).toHaveLength(0);
    });

    it('opens the gate from the saved value after a PATCH that turns it on, and switches nothing off', async () => {
      const { runner, events, read, patch } = await pluginSettings(false, {
        'custom-a': 'enabled',
      });

      const res = await patch({ set: { 'plugin.enabled': true } });
      const body = (await res.json()) as ApiResponse;

      expect(res.status).toBe(200);
      expect(body).not.toHaveProperty('externalPluginGate');
      expect((await read()).values['plugin.enabled']).toBe(true);
      expect(events).toEqual(['gate:true@saved=true']);
      expect(runner.listApprovedDynamicPlugins).not.toHaveBeenCalled();
      expect(runner.configureDynamicPluginInstallation).not.toHaveBeenCalled();
    });

    it('saves "on" but says the gate is pending when it cannot be opened, which leaves it closed', async () => {
      const { runner, read, patch } = await pluginSettings(false, {}, { failGate: 'open' });

      const res = await patch({ set: { 'plugin.enabled': true } });

      expect(res.status).toBe(200);
      expect((await res.json()) as ApiResponse).toMatchObject({
        applied: ['plugin.enabled'],
        externalPluginGate: 'pending',
      });
      expect((await read()).values['plugin.enabled']).toBe(true);
      expect(runner.setTenantExternalGate).toHaveBeenCalledTimes(1);
      expect(runner.setTenantExternalGate).toHaveBeenCalledWith({
        tenantId: 'tenant_123',
        allowed: true,
        ifGeneration: 0,
      });
    });

    it('keeps the gate open when clearing the tenant value leaves PLUGIN_ENABLED on', async () => {
      const { runner, events, read, patch } = await pluginSettings(
        false,
        { 'custom-a': 'enabled' },
        { env: { PLUGIN_ENABLED: 'true' } }
      );

      expect((await patch({ clear: ['plugin.enabled'] })).status).toBe(200);

      expect((await read()).values['plugin.enabled']).toBe(true);
      expect(events).toEqual(['gate:true@saved=true']);
      expect(runner.configureDynamicPluginInstallation).not.toHaveBeenCalled();
    });

    it('does not save the setting when the gate cannot be closed, and switches nothing off', async () => {
      const { runner, read, patch } = await pluginSettings(
        true,
        { 'custom-a': 'enabled' },
        { failGate: 'close' }
      );
      const before = await read();

      const res = await patch({ set: { 'plugin.enabled': false } });
      const body = (await res.json()) as ApiResponse;

      expect(res.status).toBe(503);
      expect(body).toMatchObject({
        error: 'temporarily_unavailable',
        reason: 'external_plugin_gate_unavailable',
      });
      expect(runner.configureDynamicPluginInstallation).not.toHaveBeenCalled();
      const after = await read();
      expect(after.version).toBe(before.version);
      expect(after.values['plugin.enabled']).toBe(true);
    });

    it('does not save the setting when a runner that cannot hold a gate is bound', async () => {
      const { runner, read, patch } = await pluginSettings(true, { 'custom-a': 'enabled' });
      delete (runner as Partial<typeof runner>).setTenantExternalGate;

      expect((await patch({ set: { 'plugin.enabled': false } })).status).toBe(503);
      expect((await read()).values['plugin.enabled']).toBe(true);
    });

    it('turns it off when there is no plugin runner at all: nothing external can run', async () => {
      const { read, patch } = await pluginSettings(true, {}, { noRunner: true });

      expect((await patch({ set: { 'plugin.enabled': false } })).status).toBe(200);
      expect((await read()).values['plugin.enabled']).toBe(false);
    });

    it('does not save the setting when an installation cannot be switched off, and records what was', async () => {
      const { runner, read, patch } = await pluginSettings(
        true,
        { 'custom-a': 'enabled', 'custom-b': 'enabled', 'custom-c': 'enabled' },
        { failInstall: 'custom-b' }
      );
      const before = await read();

      const res = await patch({ set: { 'plugin.enabled': false } });
      const body = (await res.json()) as ApiResponse;

      expect(res.status).toBe(503);
      expect(body).toMatchObject({
        error: 'temporarily_unavailable',
        reason: 'external_plugin_shutdown_failed',
        stopped_plugin_ids: ['custom-a'],
      });
      expect(
        runner.configureDynamicPluginInstallation.mock.calls.map(([input]) => input.pluginId)
      ).toEqual(['custom-a', 'custom-b']);
      const after = await read();
      expect(after.version).toBe(before.version);
      expect(after.values['plugin.enabled']).toBe(true);
      // The persistent audit says which plugins were stopped before the failure, and which failed.
      expect(calledAudit('settings.plugin.external_shutdown')[0][4]).toMatchObject({
        result: 'failure',
        stopped_plugin_ids: ['custom-a'],
        failed_plugin_id: 'custom-b',
      });
      expect(calledAudit('settings.patch.failure')[0][4]).toMatchObject({
        reason: 'external_plugin_shutdown_failed',
        stopped_plugin_ids: ['custom-a'],
        failed_plugin_id: 'custom-b',
      });
    });

    it('audits a failed listing of the external plugins as a failure, with nobody to blame', async () => {
      const { read, patch } = await pluginSettings(true, {}, { failList: true });
      const before = await read();

      const res = await patch({ set: { 'plugin.enabled': false } });

      expect(res.status).toBe(503);
      expect(((await res.json()) as ApiResponse).reason).toBe('external_plugin_shutdown_failed');
      expect((await read()).version).toBe(before.version);
      const audits = calledAudit('settings.plugin.external_shutdown');
      expect(audits).toHaveLength(1);
      expect(audits[0][4]).toMatchObject({ result: 'failure', stopped_plugin_ids: [] });
      expect(audits[0][4]).not.toHaveProperty('failed_plugin_id');
      expect(audits[0][5]).toBe('warning');
    });

    it('audits a switch-off that worked as a success', async () => {
      const { patch } = await pluginSettings(true, { 'custom-a': 'enabled' });

      expect((await patch({ set: { 'plugin.enabled': false } })).status).toBe(200);

      const audits = calledAudit('settings.plugin.external_shutdown');
      expect(audits[0][4]).toMatchObject({ result: 'success', stopped_plugin_ids: ['custom-a'] });
      expect(audits[0][5]).toBe('info');
    });

    it('says the gate is pending, records it, and has the reconciliation close a gate that a concurrent enable reopened', async () => {
      // The turn-off closes the gate and switches the installations off; an enable that read the
      // new generation and the still-saved "on" reopens the gate; the turn-off is saved; the
      // closing after the save fails on a passing fault. The setting is off and the gate is open.
      const { runner, gate, env, read, patch } = await pluginSettings(
        true,
        { 'custom-a': 'enabled' },
        {
          failCloseFrom: 2,
          afterClose: (n, state) => {
            if (n === 1) {
              state.allowed = true; // the concurrent enable's open, by compare-and-swap
              state.generation += 1;
            }
          },
        }
      );

      const res = await patch({ set: { 'plugin.enabled': false } });

      expect(res.status).toBe(200);
      expect((await res.json()) as ApiResponse).toMatchObject({
        applied: ['plugin.enabled'],
        externalPluginGate: 'pending',
      });
      expect((await read()).values['plugin.enabled']).toBe(false);
      expect(gate.allowed).toBe(true); // the drift
      expect(calledAudit('settings.patch.failure').map(([, , , , meta]) => meta)).toContainEqual(
        expect.objectContaining({ reason: 'external_plugin_gate_resync_failed' })
      );

      // The next reconciliation (the scheduled run) closes it.
      runner.setTenantExternalGate.mockClear();
      const result = await sweepExternalPluginGates(env, { info: vi.fn(), warn: vi.fn() });
      expect(result).toMatchObject({ examined: 1, closed: 1 });
      expect(gate.allowed).toBe(false);
    });

    it('does not say the gate is pending after a turn-off whose closing after the save worked', async () => {
      const { patch } = await pluginSettings(true, { 'custom-a': 'enabled' });
      const body = (await (
        await patch({ set: { 'plugin.enabled': false } })
      ).json()) as ApiResponse;
      expect(body).not.toHaveProperty('externalPluginGate');
    });

    describe('a request the settings manager refuses stops nothing', () => {
      it.each([
        [
          'set true with disable of the same key',
          { set: { 'plugin.enabled': true }, disable: ['plugin.enabled'] },
        ],
        [
          'set false with clear of the same key',
          { set: { 'plugin.enabled': false }, clear: ['plugin.enabled'] },
        ],
        [
          'clear with disable of the same key',
          { clear: ['plugin.enabled'], disable: ['plugin.enabled'] },
        ],
        [
          'set false with disable of the same key',
          { set: { 'plugin.enabled': false }, disable: ['plugin.enabled'] },
        ],
        [
          'set false next to a key that is not a plugin setting',
          { set: { 'plugin.enabled': false, 'plugin.notifier_resend_enabled': false } },
        ],
        ['set false with a value that is not boolean', { set: { 'plugin.enabled': 'off' } }],
      ])('%s', async (_, body) => {
        const { runner, events, read, patch } = await pluginSettings(true, {
          'custom-a': 'enabled',
        });
        const before = await read();

        const res = await patch(body);

        expect(res.status).toBe(400);
        expect(events).toEqual([]);
        expect(runner.setTenantExternalGate).not.toHaveBeenCalled();
        expect(runner.listApprovedDynamicPlugins).not.toHaveBeenCalled();
        expect(runner.configureDynamicPluginInstallation).not.toHaveBeenCalled();
        const after = await read();
        expect(after.version).toBe(before.version);
        expect(after.values['plugin.enabled']).toBe(true);
      });

      it('a version mismatch (ifMatch) is a conflict that stops nothing', async () => {
        const { runner, events, read, patchRaw } = await pluginSettings(true, {
          'custom-a': 'enabled',
        });
        const before = await read();

        const res = await patchRaw({
          ifMatch: 'not-the-current-version',
          set: { 'plugin.enabled': false },
        });

        expect(res.status).toBe(409);
        expect(events).toEqual([]);
        expect(runner.configureDynamicPluginInstallation).not.toHaveBeenCalled();
        expect((await read()).version).toBe(before.version);
      });

      it('a request without ifMatch stops nothing', async () => {
        const { runner, patchRaw } = await pluginSettings(true, { 'custom-a': 'enabled' });

        const res = await patchRaw({ set: { 'plugin.enabled': false } });

        expect(res.status).toBe(400);
        expect(runner.setTenantExternalGate).not.toHaveBeenCalled();
      });

      it('a PATCH of another category never touches the runner', async () => {
        const { app, mockEnv } = createTestApp();
        const runner = services({ 'custom-a': 'enabled' }).runner;
        const url = '/api/admin/tenants/tenant_123/settings/oauth';
        const read = (await (
          await app.request(url, { method: 'GET' }, { ...mockEnv, PLUGIN_RUNNER: runner } as never)
        ).json()) as SettingsGetResult;
        await app.request(
          url,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ifMatch: read.version, set: {} }),
          },
          { ...mockEnv, PLUGIN_RUNNER: runner } as never
        );
        expect(runner.setTenantExternalGate).not.toHaveBeenCalled();
        expect(runner.listApprovedDynamicPlugins).not.toHaveBeenCalled();
      });
    });
  });

  describe('default access token target of new apps on PATCH /tenants/:tenantId/settings/dcr', () => {
    async function dcrSettings(stored: Record<string, string> = {}) {
      const { app, mockEnv } = createTestApp({ kv: createMockKV(stored) });
      const read = async () =>
        (await (
          await app.request(
            '/api/admin/tenants/tenant_123/settings/dcr',
            { method: 'GET' },
            mockEnv
          )
        ).json()) as SettingsGetResult;
      const patch = async (body: Record<string, unknown>) =>
        app.request(
          '/api/admin/tenants/tenant_123/settings/dcr',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ifMatch: (await read()).version, ...body }),
          },
          mockEnv
        );
      return { read, patch };
    }

    it('lists both settings, empty by default', async () => {
      const { read } = await dcrSettings();
      const view = await read();

      expect(view.values['dcr.default_audience']).toBe('');
      expect(view.values['dcr.default_resource']).toBe('');
      expect(view.sources['dcr.default_audience']).toBe('default');
    });

    it('saves a valid audience and resource and reads them back', async () => {
      const { read, patch } = await dcrSettings();
      const res = await patch({
        set: {
          'dcr.default_audience': 'urn:example:api',
          'dcr.default_resource': 'https://api.example.com/v1',
        },
      });

      expect(res.status).toBe(200);
      const view = await read();
      expect(view.values['dcr.default_audience']).toBe('urn:example:api');
      expect(view.values['dcr.default_resource']).toBe('https://api.example.com/v1');
      expect(view.sources['dcr.default_resource']).toBe('kv');
    });

    it.each([
      ['dcr.default_resource', 'api.example.com/v1', 'absolute URI'],
      ['dcr.default_resource', 'https://api.example.com/v1#frag', 'fragment'],
      ['dcr.default_resource', 'http://api.example.com/v1', 'https'],
      ['dcr.default_resource', 'ftp://api.example.com/v1', 'https'],
      ['dcr.default_resource', 'https://api.example.com/a b', 'spaces'],
      ['dcr.default_audience', 'two words', 'spaces'],
      ['dcr.default_audience', ' padded', 'spaces'],
      ['dcr.default_audience', 'tab\there', 'control'],
      ['dcr.default_audience', 'https://tenant_123.example.com', 'issuer'],
      ['dcr.default_audience', 'https://tenant_123.example.com/userinfo', 'issuer'],
      ['dcr.default_resource', 'https://tenant_123.example.com/', 'issuer'],
      ['dcr.default_resource', 'https://TENANT_123.example.com:443/userinfo/', 'issuer'],
    ])('refuses %s = %j (%s) and saves nothing', async (key, value, mentions) => {
      const { read, patch } = await dcrSettings();
      const before = await read();

      const res = await patch({ set: { [key]: value, 'dcr.enabled': true } });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ApiResponse;
      expect(body.error).toBe('validation_failed');
      expect(body.message as string).toContain(key);
      expect(body.message as string).toContain(mentions);
      const after = await read();
      expect(after.version).toBe(before.version);
      expect(after.sources['dcr.enabled']).not.toBe('kv');
    });

    it.each([
      ['dcr.default_resource', `https://api.example.com/${'a'.repeat(2048)}`],
      ['dcr.default_audience', 'a'.repeat(2049)],
    ])('refuses %s longer than 2048 characters and saves nothing', async (key, value) => {
      const { read, patch } = await dcrSettings();
      const before = await read();

      const res = await patch({ set: { [key]: value } });

      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiResponse).message as string).toContain('at most 2048');
      expect((await read()).version).toBe(before.version);
    });

    it.each([
      ['dcr.default_resource', 'http://localhost:8080/api'],
      ['dcr.default_resource', 'http://127.0.0.1/api'],
      ['dcr.default_resource', 'http://[::1]:3000/api'],
      ['dcr.default_audience', 'https://tenant_123.example.com/api'],
      ['dcr.default_audience', 'https://other-tenant.example.com'],
      ['dcr.default_audience', ''],
    ])('accepts %s = %j', async (key, value) => {
      const { patch } = await dcrSettings();
      expect((await patch({ set: { [key]: value } })).status).toBe(200);
    });

    describe('for a tenant reachable on more than one issuer', () => {
      // The primary tenant answers on the naked domain and on its own subdomain, both allowed.
      async function nakedDomainTenant() {
        const { app, mockEnv } = createTestApp({
          kv: createMockKV({
            'settings:tenant:acme:tenant': JSON.stringify({
              'tenant.allowed_domains': 'example.com, acme.example.com',
              'tenant.allowed_identifiers': 'https://example.com, https://acme.example.com',
            }),
          }),
          env: { NAKED_DOMAIN_AS_ISSUER: 'true', PRIMARY_TENANT_ID: 'acme' },
        });
        const url = '/api/admin/tenants/acme/settings/dcr';
        return async (set: Record<string, unknown>) => {
          const current = (await (
            await app.request(url, { method: 'GET' }, mockEnv)
          ).json()) as SettingsGetResult;
          return app.request(
            url,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ifMatch: current.version, set }),
            },
            mockEnv
          );
        };
      }

      it.each([
        ['dcr.default_audience', 'https://example.com'],
        ['dcr.default_audience', 'https://acme.example.com'],
        ['dcr.default_resource', 'https://ACME.example.com:443/userinfo/'],
        ['dcr.default_resource', 'https://example.com/userinfo'],
      ])('refuses %s = %s: both are issuers of the tenant', async (key, value) => {
        const patch = await nakedDomainTenant();
        const res = await patch({ [key]: value });

        expect(res.status).toBe(400);
        expect(((await res.json()) as ApiResponse).message as string).toContain('issuer URL');
      });

      it('still accepts a target on neither', async () => {
        const patch = await nakedDomainTenant();
        expect((await patch({ 'dcr.default_audience': 'https://api.example.com' })).status).toBe(
          200
        );
      });
    });

    describe('when the primary custom domain of the tenant cannot be looked up', () => {
      const failingDb = () =>
        ({
          prepare: vi.fn().mockReturnValue({
            bind: vi.fn().mockReturnThis(),
            first: vi.fn().mockRejectedValue(new Error('D1 unavailable')),
            all: vi.fn().mockRejectedValue(new Error('D1 unavailable')),
          }),
        }) as unknown as D1Database;

      async function unavailable() {
        const { app, mockEnv } = createTestApp({
          kv: createMockKV(),
          tenantCoreDb: failingDb(),
        });
        const url = '/api/admin/tenants/tenant_123/settings/dcr';
        const read = async () =>
          (await (await app.request(url, { method: 'GET' }, mockEnv)).json()) as SettingsGetResult;
        const patch = async (set: Record<string, unknown>) =>
          app.request(
            url,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ifMatch: (await read()).version, set }),
            },
            mockEnv
          );
        return { read, patch };
      }

      it.each([
        ['dcr.default_audience', 'urn:example:api'],
        ['dcr.default_resource', 'https://api.example.com/v1'],
      ])('refuses %s with 503 and saves nothing: the issuers are unknown', async (key, value) => {
        const { read, patch } = await unavailable();
        const before = await read();

        const res = await patch({ [key]: value, 'dcr.enabled': true });

        expect(res.status).toBe(503);
        expect(((await res.json()) as ApiResponse).error).toBe('temporarily_unavailable');
        const after = await read();
        expect(after.version).toBe(before.version);
        expect(after.sources[key]).not.toBe('kv');
        expect(after.sources['dcr.enabled']).not.toBe('kv');
      });

      it('still saves a PATCH that sets no default target', async () => {
        const { read, patch } = await unavailable();

        expect((await patch({ 'dcr.enabled': true })).status).toBe(200);
        expect((await read()).values['dcr.enabled']).toBe(true);
      });

      it('still saves an empty default: nothing to compare', async () => {
        const { patch } = await unavailable();
        expect((await patch({ 'dcr.default_audience': '' })).status).toBe(200);
      });
    });

    it('accepts the subdomain of a tenant that answers on its subdomain only', async () => {
      // No allowed domains: the naked domain is not the tenant's, and only tenant_123's own
      // subdomain is reserved.
      const { patch } = await dcrSettings();
      expect((await patch({ set: { 'dcr.default_audience': 'https://example.com' } })).status).toBe(
        200
      );
    });

    it('does not take the other keys of the category into account', async () => {
      const { read, patch } = await dcrSettings();
      const res = await patch({
        set: { 'dcr.enabled': true, 'dcr.require_initial_access_token': false },
      });

      expect(res.status).toBe(200);
      expect((await read()).values['dcr.enabled']).toBe(true);
    });

    it('refuses a key the category does not have', async () => {
      const { patch } = await dcrSettings();
      const res = await patch({ set: { 'dcr.nope': 'x' } });

      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiResponse).message).toBe('dcr.nope is not a DCR setting');
    });
  });

  describe('All Category Types', () => {
    // Tenant-level categories
    const tenantCategories = [
      'oauth',
      'session',
      'security',
      'ciba',
      'rate-limit',
      'device-flow',
      'tokens',
      'external-idp',
      'credentials',
      'federation',
      'login-entry',
    ];

    // Platform-only categories (not available at tenant scope)
    const platformOnlyCategories = ['infrastructure', 'encryption'];

    it.each(tenantCategories)('should handle GET for tenant category: %s', async (category) => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request(
        `/api/admin/tenants/test_tenant/settings/${category}`,
        { method: 'GET' },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as SettingsGetResult;
      expect(body.category).toBe(category);
    });

    it.each(platformOnlyCategories)(
      'should return 400 for platform-only category at tenant scope: %s',
      async (category) => {
        const { app, mockEnv } = createTestApp();

        const res = await app.request(
          `/api/admin/tenants/test_tenant/settings/${category}`,
          { method: 'GET' },
          mockEnv
        );

        // Platform-only categories should return 400 at tenant scope
        expect(res.status).toBe(400);
        const body = (await res.json()) as ApiResponse;
        expect(body.error).toBe('bad_request');
      }
    );

    it.each(platformOnlyCategories)(
      'should handle GET for platform category: %s',
      async (category) => {
        const { app, mockEnv } = createTestApp();

        const res = await app.request(
          `/api/admin/platform/settings/${category}`,
          { method: 'GET' },
          mockEnv
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as SettingsGetResult;
        expect(body.category).toBe(category);
      }
    );
  });

  describe('Single-tenant tenant guard', () => {
    it('should allow login-entry settings for the default tenant', async () => {
      const { app, mockEnv } = createTestApp({
        env: {
          BASE_DOMAIN: '',
          DEFAULT_TENANT_ID: 'default',
        },
      });

      const res = await app.request(
        '/api/admin/tenants/default/settings/login-entry',
        { method: 'GET' },
        mockEnv
      );

      expect(res.status).toBe(200);
    });

    it('should reject login-entry settings for non-default tenant in single-tenant mode', async () => {
      const { app, mockEnv } = createTestApp({
        env: {
          BASE_DOMAIN: '',
          DEFAULT_TENANT_ID: 'default',
        },
      });

      const res = await app.request(
        '/api/admin/tenants/acme/settings/login-entry',
        { method: 'GET' },
        mockEnv
      );

      expect(res.status).toBe(404);
    });
  });

  describe('Authorization Boundaries', () => {
    it('should allow org_admin access to tenant settings for their own tenant via adminAuth', async () => {
      const { app, mockEnv } = createTestApp({
        adminAuth: {
          userId: 'org_admin_1',
          authMethod: 'bearer',
          roles: ['org_admin'],
          org_id: 'tenant_123',
        },
      });

      const res = await app.request(
        '/api/admin/tenants/tenant_123/settings/oauth',
        { method: 'GET' },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as SettingsGetResult;
      expect(body.scope).toEqual({ type: 'tenant', id: 'tenant_123' });
    });

    it('should reject tenant settings access across tenant boundaries', async () => {
      const { app, mockEnv } = createTestApp({
        adminAuth: {
          userId: 'org_admin_1',
          authMethod: 'bearer',
          roles: ['org_admin'],
          org_id: 'tenant_123',
        },
      });

      const res = await app.request(
        '/api/admin/tenants/tenant_other/settings/oauth',
        { method: 'GET' },
        mockEnv
      );

      expect(res.status).toBe(403);
      const body = (await res.json()) as ApiResponse;
      expect(body.error).toBe('forbidden');
    });

    it('allows an Agent downscope context only for its bound tenant and permission', async () => {
      const { app, mockEnv } = createTestApp({
        adminAuth: {
          userId: 'delegator-1',
          authMethod: 'bearer',
          actorType: 'agent',
          roles: [],
          tenantId: 'tenant_123',
          tenantScope: ['tenant_123'],
          permissions: ['admin:settings:read'],
        },
      });

      const allowed = await app.request(
        '/api/admin/tenants/tenant_123/settings/security',
        { method: 'GET' },
        mockEnv
      );
      expect(allowed.status).toBe(200);

      const crossTenant = await app.request(
        '/api/admin/tenants/tenant_other/settings/security',
        { method: 'GET' },
        mockEnv
      );
      expect(crossTenant.status).toBe(403);

      const writeWithoutPermission = await app.request(
        '/api/admin/tenants/tenant_123/settings/security',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ifMatch: 'v1', set: { 'security.fapi_enabled': true } }),
        },
        mockEnv
      );
      expect(writeWithoutPermission.status).toBe(403);
    });

    it('authorizes Machine Access tokens from permissions instead of human roles', async () => {
      const { app, mockEnv } = createTestApp({
        adminAuth: {
          userId: 'setup-machine',
          authMethod: 'machine_access_token',
          actorType: 'machine',
          roles: [],
          tenantId: 'tenant_123',
          tenantScope: ['tenant_123'],
          permissions: ['admin:settings:read', 'admin:settings:write'],
        },
      });

      const getResponse = await app.request(
        '/api/admin/tenants/tenant_123/settings/diagnostic-logging',
        { method: 'GET' },
        mockEnv
      );
      expect(getResponse.status).toBe(200);
      const current = (await getResponse.json()) as SettingsGetResult;

      const patchResponse = await app.request(
        '/api/admin/tenants/tenant_123/settings/diagnostic-logging',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ifMatch: current.version,
            set: { 'diagnostic-logging.enabled': true },
          }),
        },
        mockEnv
      );
      expect(patchResponse.status).toBe(200);
    });

    it('rejects a Machine Access token without the required settings permission', async () => {
      const { app, mockEnv } = createTestApp({
        adminAuth: {
          userId: 'read-other-machine',
          authMethod: 'machine_access_token',
          actorType: 'machine',
          roles: ['super_admin'],
          tenantId: 'tenant_123',
          tenantScope: ['tenant_123'],
          permissions: ['admin:clients:read'],
        },
      });

      const response = await app.request(
        '/api/admin/tenants/tenant_123/settings/diagnostic-logging',
        { method: 'GET' },
        mockEnv
      );
      expect(response.status).toBe(403);
    });

    it('requires the category-specific Agent permission for tenant settings writes', async () => {
      const { app, mockEnv } = createTestApp({
        adminAuth: {
          userId: 'delegator-1',
          authMethod: 'bearer',
          actorType: 'agent',
          roles: [],
          tenantId: 'tenant_123',
          tenantScope: ['tenant_123'],
          permissions: ['admin:settings:security:update'],
        },
      });

      const security = await app.request(
        '/api/admin/tenants/tenant_123/settings/security',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        },
        mockEnv
      );
      expect(security.status).toBe(401);

      const assurance = await app.request(
        '/api/admin/tenants/tenant_123/settings/assurance',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        },
        mockEnv
      );
      expect(assurance.status).toBe(403);
    });
  });
});

it('covers tenant settings and cache revision writes with one backup permit', async () => {
  const { app, mockEnv, mockKV } = createTestApp();
  mockEnv.TENANT_BACKUP_WRAPPING_KEY = 'ab'.repeat(32);
  const acquire = vi.fn().mockResolvedValue({ admitted: false });
  const complete = vi.fn(async () => {
    expect(
      await mockKV.get('cache:authentication-methods:v1:revision:tenant:tenant_123')
    ).not.toBeNull();
  });
  mockEnv.CONTROL = {
    acquireTenantBackupMutationPermit: acquire,
    completeTenantBackupMutationPermit: complete,
  } as unknown as Env['CONTROL'];
  const url = '/api/admin/tenants/tenant_123/settings/login-ui';
  const current: unknown = await (await app.request(url, { method: 'GET' }, mockEnv)).json();
  if (!current || typeof current !== 'object' || !('version' in current))
    throw new Error('missing settings version');
  const request = {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ifMatch: current.version,
      set: { 'login-ui.brand_name': 'Covered Brand' },
    }),
  };
  expect((await app.request(url, request, mockEnv)).status).toBe(503);
  expect(vi.mocked(mockKV).put.mock.calls).toHaveLength(0);
  expect(complete).not.toHaveBeenCalled();
  acquire.mockResolvedValue({ admitted: true });
  expect((await app.request(url, request, mockEnv)).status).toBe(200);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(complete.mock.calls[0]).toEqual(acquire.mock.calls[1]);
});

it.each(['', '/client'])(
  'covers client PATCH%s under its verified tenant before any write',
  async (suffix) => {
    const mockKV = createMockKV({
      'client:test-tenant:client_abc:metadata': JSON.stringify({ tenant_id: 'test-tenant' }),
    });
    const { app, mockEnv } = createTestApp({ kv: mockKV });
    mockEnv.TENANT_BACKUP_WRAPPING_KEY = 'ab'.repeat(32);
    const acquire = vi.fn().mockResolvedValue({ admitted: false });
    const complete = vi.fn().mockResolvedValue(undefined);
    mockEnv.CONTROL = {
      acquireTenantBackupMutationPermit: acquire,
      completeTenantBackupMutationPermit: complete,
    } as unknown as Env['CONTROL'];
    const url = `/api/admin/clients/client_abc/settings${suffix}`;
    const current: unknown = await (
      await app.request(url, { method: 'GET', headers: { 'X-Tenant-Id': 'test-tenant' } }, mockEnv)
    ).json();
    if (!current || typeof current !== 'object' || !('version' in current))
      throw new Error('missing settings version');
    const update = {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': 'test-tenant' },
      body: JSON.stringify({ ifMatch: current.version, set: { 'client.sso_enabled': true } }),
    };
    expect((await app.request(url, update, mockEnv)).status).toBe(503);
    expect(vi.mocked(mockKV).put.mock.calls).toHaveLength(0);
    expect(complete).not.toHaveBeenCalled();
    expect(acquire.mock.calls[0][0]).toMatchObject({ tenantId: 'test-tenant' });
    acquire.mockResolvedValue({ admitted: true });
    expect((await app.request(url, update, mockEnv)).status).toBe(200);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0]).toEqual(acquire.mock.calls[1][0]);
    const calls = acquire.mock.calls.length;
    expect(
      (
        await app.request(
          url,
          { ...update, headers: { ...update.headers, 'X-Tenant-Id': 'other' } },
          mockEnv
        )
      ).status
    ).toBe(404);
    expect(acquire).toHaveBeenCalledTimes(calls);
  }
);

it('covers platform changes with an environment permit and denies unsupported categories before admission', async () => {
  const { app, mockEnv, mockKV } = createTestApp();
  mockEnv.TENANT_BACKUP_WRAPPING_KEY = 'ab'.repeat(32);
  const acquire = vi.fn().mockResolvedValue({ admitted: false });
  const complete = vi.fn().mockResolvedValue(undefined);
  const tenantAcquire = vi.fn();
  mockEnv.CONTROL = {
    acquireEnvironmentBackupMutationPermit: acquire,
    completeEnvironmentBackupMutationPermit: complete,
    acquireTenantBackupMutationPermit: tenantAcquire,
  } as unknown as Env['CONTROL'];
  const url = '/api/admin/platform/settings/login-entry';
  const current: unknown = await (await app.request(url, { method: 'GET' }, mockEnv)).json();
  if (!current || typeof current !== 'object' || !('version' in current))
    throw new Error('missing settings version');
  const update = {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ifMatch: current.version,
      set: { 'login-entry.skip_discovery_if_only_one_tenant': true },
    }),
  };
  expect((await app.request(url, update, mockEnv)).status).toBe(503);
  expect(vi.mocked(mockKV).put.mock.calls).toHaveLength(0);
  expect(complete).not.toHaveBeenCalled();
  acquire.mockResolvedValue({ admitted: true });
  expect((await app.request(url, update, mockEnv)).status).toBe(200);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(complete.mock.calls[0]).toEqual(acquire.mock.calls[1]);
  expect(tenantAcquire).not.toHaveBeenCalled();
  const count = acquire.mock.calls.length;
  expect(
    (await app.request('/api/admin/platform/settings/infrastructure', update, mockEnv)).status
  ).toBe(405);
  expect(acquire).toHaveBeenCalledTimes(count);
});
