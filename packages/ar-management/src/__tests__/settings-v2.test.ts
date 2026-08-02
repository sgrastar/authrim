/**
 * Settings API v2 Integration Tests
 *
 * Tests for the unified settings API endpoints:
 * - GET/PATCH /tenants/:tenantId/settings/:category
 * - GET/PATCH /clients/:clientId/settings
 * - GET /platform/settings/:category (read-only)
 * - GET /settings/meta/:category
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import type {
  AdminAuthContext,
  Env,
  SettingsGetResult,
  SettingsPatchResult,
  StorageProfile,
} from '@authrim/ar-lib-core';
import settingsV2 from '../routes/settings-v2';

// Response types
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type ApiResponse = Record<string, JsonValue>;

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

function makeStorageProfile(id: string, slices: StorageProfile['slices']): StorageProfile {
  return {
    id,
    kind: 'storage',
    label: id,
    slices,
  };
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
    env?: Record<string, string>;
    adminAuth?: AdminAuthContext;
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
    RATE_LIMITER: {
      idFromName: vi.fn().mockReturnValue('rate-limit-id'),
      get: vi.fn().mockReturnValue({ incrementRpc: mockRateLimiterIncrement }),
    },
    BASE_DOMAIN: 'example.com', // enable multi-tenant mode so ensureSupportedTenantId passes
    ...options.env,
  } as unknown as Env;

  return { app, mockEnv, mockKV, mockRateLimiterIncrement };
}

describe('Settings API v2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

      it('automatically schedules inherited human-verification projection after enabling it', async () => {
        const mockKV = createMockKV();
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
                'login-ui.supported_locales': 'ar,it,th,vi',
                'login-ui.default_locale': 'ar',
              },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as SettingsPatchResult;
        expect(body.applied).toEqual(
          expect.arrayContaining(['login-ui.supported_locales', 'login-ui.default_locale'])
        );
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

      it('rejects tenant storage profile overrides that change the auth core plane', async () => {
        const disallowedProfile = makeStorageProfile('tenant-external-storage', {
          identity_core: {
            driver: 'postgres',
            connectionRef: 'tenant-a-core',
            role: 'core',
          },
          identity_pii: {
            driver: 'postgres',
            connectionRef: 'tenant-a-pii',
            role: 'pii',
          },
        });
        const mockKV = createMockKV({
          'profile-registry:storage:tenant-external-storage': JSON.stringify(disallowedProfile),
        });
        const { app, mockEnv } = createTestApp({
          kv: mockKV,
          env: {
            DEFAULT_STORAGE_PROFILE_ID: 'builtin:storage:standard',
          },
        });

        const getRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/tenant',
          { method: 'GET' },
          mockEnv
        );
        const current = (await getRes.json()) as SettingsGetResult;

        const patchRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/tenant',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: current.version,
              set: {
                'tenant.storage_profile_id': 'tenant-external-storage',
              },
            }),
          },
          mockEnv
        );

        expect(patchRes.status).toBe(400);
        const body = (await patchRes.json()) as ApiResponse;
        expect(body.error).toBe('bad_request');
        expect(body.message as string).toContain('auth core plane');
        expect(body.code).toBe('tenant_auth_core_override_not_allowed');
      });

      it('allows tenant storage profile overrides when the auth core plane is compatible', async () => {
        const allowedProfile = makeStorageProfile('tenant-pii-storage', {
          identity_pii: {
            driver: 'postgres',
            connectionRef: 'tenant-a-pii',
            role: 'pii',
          },
          custom_pii: {
            driver: 'postgres',
            connectionRef: 'tenant-a-pii',
            role: 'pii',
          },
        });
        const mockKV = createMockKV({
          'profile-registry:storage:tenant-pii-storage': JSON.stringify(allowedProfile),
        });
        const { app, mockEnv } = createTestApp({
          kv: mockKV,
          env: {
            DEFAULT_STORAGE_PROFILE_ID: 'builtin:storage:standard',
            AUTHRIM_REGISTERED_SCHEMA_REFS: JSON.stringify([
              'connection:tenant-a-pii:external-postgres-pii',
            ]),
          },
        });
        (mockEnv as unknown as Record<string, unknown>).HYPERDRIVE_TENANT_A_PII = {
          connectionString: 'postgres://tenant-a-pii',
        };

        const getRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/tenant',
          { method: 'GET' },
          mockEnv
        );
        const current = (await getRes.json()) as SettingsGetResult;

        const patchRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/tenant',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ifMatch: current.version,
              set: {
                'tenant.storage_profile_id': 'tenant-pii-storage',
              },
            }),
          },
          mockEnv
        );

        expect(patchRes.status).toBe(200);
        const verifyRes = await app.request(
          '/api/admin/tenants/tenant_123/settings/tenant',
          { method: 'GET' },
          mockEnv
        );
        const body = (await verifyRes.json()) as SettingsGetResult;
        expect(body.values['tenant.storage_profile_id']).toBe('tenant-pii-storage');
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
                'client.access_token_ttl': 7200,
                'client.pkce_required': true,
              },
            }),
          },
          mockEnv
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as SettingsPatchResult;
        expect(body.applied).toContain('client.access_token_ttl');
        expect(body.applied).toContain('client.pkce_required');
      });

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
