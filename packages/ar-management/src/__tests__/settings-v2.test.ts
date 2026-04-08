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
import type { Env, SettingsGetResult, SettingsPatchResult } from '@authrim/ar-lib-core';
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

// Create test app with settings-v2 routes
function createTestApp(options: {
  kv?: KVNamespace;
  env?: Record<string, string>;
  adminAuth?: {
    userId: string;
    authMethod: 'bearer' | 'session';
    roles: string[];
    org_id?: string;
  };
} = {}) {
  const mockKV = options.kv ?? createMockKV();

  const app = new Hono<{
    Bindings: Env;
    Variables: {
      adminAuth?: {
        userId: string;
        authMethod: 'bearer' | 'session';
        roles: string[];
        org_id?: string;
      };
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
    BASE_DOMAIN: 'example.com', // enable multi-tenant mode so ensureSupportedTenantId passes
    ...options.env,
  } as unknown as Env;

  return { app, mockEnv, mockKV };
}

describe('Settings API v2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Tenant Settings', () => {
    describe('GET /tenants/:tenantId/settings/:category', () => {
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
        expect(body.values['login-entry.mode']).toBe('discovery_optional');
        expect(body.values['login-entry.discovery_methods']).toBe(
          '["email_domain","tenant_code","tenant_slug"]'
        );
        expect(body.values['login-entry.email_resolution_policy']).toBe(
          'exact_email_then_domain'
        );
        expect(body.values['login-entry.selection_policy']).toBe('select_if_multiple');
        expect(body.values['login-entry.allow_manual_tenant_entry']).toBe(true);
        expect(body.values['login-entry.remember_last_tenant']).toBe(true);
        expect(body.values['login-entry.redirect_default_login_to_discovery']).toBe(true);
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
          'client:client_abc:metadata': JSON.stringify({ tenant_id: 'test_tenant' }),
        });
        const { app, mockEnv } = createTestApp({ kv: mockKV });

        const res = await app.request(
          '/api/admin/clients/client_abc/settings',
          { method: 'GET' },
          mockEnv
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as SettingsGetResult;

        expect(body.category).toBe('client');
        expect(body.scope).toEqual({ type: 'client', id: 'client_abc' });
        expect(body.values).toBeDefined();
      });

      it('should reject access to clients in another tenant', async () => {
        const mockKV = createMockKV({
          'client:client_abc:metadata': JSON.stringify({ tenant_id: 'tenant_other' }),
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
          { method: 'GET' },
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
          'client:client_abc:metadata': JSON.stringify({ tenant_id: 'test_tenant' }),
        });
        const { app, mockEnv } = createTestApp({ kv: mockKV });

        // Get current version
        const getRes = await app.request(
          '/api/admin/clients/client_abc/settings',
          { method: 'GET' },
          mockEnv
        );
        const getData = (await getRes.json()) as SettingsGetResult;

        // Patch
        const res = await app.request(
          '/api/admin/clients/client_abc/settings',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
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

      it('should return login-entry metadata with seven settings', async () => {
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
        expect(Object.keys(body.settings)).toHaveLength(7);
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
      'consent',
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
  });
});
