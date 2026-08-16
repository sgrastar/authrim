import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { requestContextMiddleware, getTenantIdFromContext } from '../request-context';
import type { Env } from '../../types/env';
import { TenantDatabaseResolverError } from '../../services/tenant-database-resolver';

const runtimeMocks = vi.hoisted(() => ({
  resolveTenantMetadata: vi.fn(),
}));

vi.mock('../../services/runtime-data-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/runtime-data-context')>()),
  resolveTenantMetadataContext: runtimeMocks.resolveTenantMetadata,
}));

// =============================================================================
// Mock helpers
// =============================================================================

function createMockDB(options: { tenantRow?: { id: string } | null; shouldThrow?: boolean } = {}) {
  const { tenantRow = null, shouldThrow = false } = options;

  return {
    prepare: vi.fn().mockImplementation((sql: string) => {
      const executeFirst = vi.fn().mockImplementation(async () => {
        if (shouldThrow) throw new Error('DB error');
        if (sql.includes('SELECT 1')) {
          return { '1': 1 };
        }
        return tenantRow;
      });

      return {
        bind: vi.fn().mockReturnValue({
          first: executeFirst,
        }),
        first: executeFirst,
      };
    }),
    batch: vi.fn(),
  } as unknown as D1Database;
}

function createMockKV(
  options: { cachedValue?: string | null; valuesByKey?: Record<string, string | null> } = {}
) {
  return {
    get: vi.fn().mockImplementation(async (key: string) => {
      if (options.valuesByKey && key in options.valuesByKey) {
        return options.valuesByKey[key] ?? null;
      }
      return options.cachedValue ?? null;
    }),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as KVNamespace;
}

type TestEnv = Partial<Env>;

function buildApp(env: TestEnv, requireTenant = true) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', requestContextMiddleware({ requireTenant }));
  app.get('/test', (c) => {
    const tenantId = getTenantIdFromContext(c);
    return c.json({ tenantId });
  });
  app.get('/admin-init-setup', (c) => {
    const tenantId = getTenantIdFromContext(c);
    return c.json({ tenantId });
  });
  app.get('/api/auth/discovery', (c) => {
    const tenantId = getTenantIdFromContext(c);
    return c.json({ tenantId });
  });
  app.get('/.well-known/oauth-protected-resource/mcp', (c) => {
    const tenantId = getTenantIdFromContext(c);
    return c.json({
      tenantId,
      hasTenantMetadataContext: Boolean(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c as any).get('tenantMetadataContext')
      ),
    });
  });
  app.get('/api/auth/authentication-methods', (c) => {
    const tenantId = getTenantIdFromContext(c);
    return c.json({
      tenantId,
      hasTenantMetadataContext: Boolean(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c as any).get('tenantMetadataContext')
      ),
    });
  });
  app.post('/api/auth/discovery/grant', (c) => {
    const tenantId = getTenantIdFromContext(c);
    return c.json({ tenantId });
  });
  app.post('/device_authorization', (c) => {
    const tenantId = getTenantIdFromContext(c);
    return c.json({ tenantId });
  });
  app.get('/api/admin/platform/tenant-domain-mappings', (c) => {
    return c.json({ tenantId: getTenantIdFromContext(c) });
  });
  app.get('/api/admin/settings/ui-config', (c) => {
    return c.json({ tenantId: getTenantIdFromContext(c) });
  });
  app.post('/api/admin/auth/passkey/options', (c) => {
    return c.json({ tenantId: getTenantIdFromContext(c) });
  });
  app.get('/api/admin/sessions/me', (c) => {
    return c.json({ tenantId: getTenantIdFromContext(c) });
  });
  app.get('/api/admin/me/session', (c) => {
    return c.json({ tenantId: getTenantIdFromContext(c) });
  });
  app.post('/api/admin/logout', (c) => {
    return c.json({ tenantId: getTenantIdFromContext(c) });
  });
  app.get('/api/admin/tenants', (c) => {
    return c.json({ tenantId: getTenantIdFromContext(c) });
  });
  app.get('/api/admin/tenants/:tenantId/info', (c) => {
    return c.json({
      tenantId: getTenantIdFromContext(c),
      hasTenantMetadataContext: Boolean(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c as any).get('tenantMetadataContext')
      ),
    });
  });
  app.get('/api/admin/tenants/:tenantId/provisioning', (c) => {
    return c.json({ tenantId: getTenantIdFromContext(c) });
  });
  app.post('/api/admin/tenants/:tenantId/provisioning/retry', (c) => {
    return c.json({ tenantId: getTenantIdFromContext(c) });
  });
  app.post('/api/admin/tenants/:tenantId/provisioning/cleanup', (c) => {
    return c.json({ tenantId: getTenantIdFromContext(c) });
  });
  app.get('/api/admin/users', (c) => {
    return c.json({ tenantId: getTenantIdFromContext(c) });
  });
  app.post('/api/admin/jobs/users/bulk-update', (c) => {
    return c.json({ tenantId: getTenantIdFromContext(c) });
  });
  app.get('/api/admin/tenants/:tenantId/settings/oauth', (c) => {
    return c.json({ tenantId: getTenantIdFromContext(c), pathTenantId: c.req.param('tenantId') });
  });
  return app;
}

function makeRequest(host: string, path = '/test', headers: Record<string, string> = {}) {
  return new Request(`https://${host}${path}`, {
    headers: { Host: host, ...headers },
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('requestContextMiddleware – tenant existence check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMocks.resolveTenantMetadata.mockImplementation(async (env: Env, tenantId: string) => ({
      tenantId,
      coreDb: env.DB,
      route: {},
    }));
  });

  describe('single-tenant mode (no BASE_DOMAIN)', () => {
    it('always passes without D1 check', async () => {
      const db = createMockDB({ tenantRow: null }); // returns nothing
      const env: TestEnv = { DB: db };
      const app = buildApp(env);
      const res = await app.request(makeRequest('example.com'), undefined, env as Env);
      expect(res.status).toBe(200);
      expect(db.prepare).not.toHaveBeenCalled();
    });
  });

  describe('multi-tenant mode (BASE_DOMAIN set)', () => {
    const BASE_DOMAIN = 'test.authrim.com';

    it('returns 200 for an existing active tenant', async () => {
      const db = createMockDB({ tenantRow: { id: 'sample' } });
      const kv = createMockKV({ cachedValue: null }); // no cache hit
      const env: TestEnv = { BASE_DOMAIN, DB: db, AUTHRIM_CONFIG: kv };
      const app = buildApp(env);
      const res = await app.request(makeRequest(`sample.${BASE_DOMAIN}`), undefined, env as Env);
      expect(res.status).toBe(200);
      const body = await res.json<{ tenantId: string }>();
      expect(body.tenantId).toBe('sample');
    });

    it('resolves tenant storage for discovery after the positive KV cache expires', async () => {
      const tenantDb = createMockDB({ tenantRow: { id: 'sample' } });
      const controlPlaneDb = createMockDB({ tenantRow: null });
      const kv = createMockKV({ cachedValue: null });
      const env: TestEnv = { BASE_DOMAIN, DB: controlPlaneDb, AUTHRIM_CONFIG: kv };
      runtimeMocks.resolveTenantMetadata.mockResolvedValueOnce({
        tenantId: 'sample',
        coreDb: tenantDb,
        route: {},
      });
      const app = buildApp(env);

      const res = await app.request(
        makeRequest(`sample.${BASE_DOMAIN}`, '/.well-known/oauth-protected-resource/mcp'),
        undefined,
        env as Env
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        tenantId: 'sample',
        hasTenantMetadataContext: true,
      });
      expect(runtimeMocks.resolveTenantMetadata).toHaveBeenCalledWith(env, 'sample');
      expect(controlPlaneDb.prepare).not.toHaveBeenCalled();
      expect(tenantDb.prepare).toHaveBeenCalledWith(
        "SELECT id FROM tenants WHERE id = ? AND lifecycle_state = 'active'"
      );
    });

    it('caches positive tenant existence within the same isolate', async () => {
      const db = createMockDB({ tenantRow: { id: 'sample' } });
      const kv = createMockKV({ cachedValue: null }); // isolate cache must handle request 2
      const env: TestEnv = { BASE_DOMAIN, DB: db, AUTHRIM_CONFIG: kv };
      const app = buildApp(env);

      const first = await app.request(makeRequest(`sample.${BASE_DOMAIN}`), undefined, env as Env);
      const second = await app.request(makeRequest(`sample.${BASE_DOMAIN}`), undefined, env as Env);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(
        vi.mocked(kv.get).mock.calls.filter(([key]) => key === 'v1:tenant-exists:sample')
      ).toHaveLength(1);
      expect(
        vi
          .mocked(db.prepare)
          .mock.calls.filter(
            ([sql]) => sql === "SELECT id FROM tenants WHERE id = ? AND lifecycle_state = 'active'"
          )
      ).toHaveLength(1);
    });

    it('returns 404 for a non-existent tenant', async () => {
      const db = createMockDB({ tenantRow: null }); // no row found
      const kv = createMockKV({ cachedValue: null });
      const env: TestEnv = { BASE_DOMAIN, DB: db, AUTHRIM_CONFIG: kv };
      const app = buildApp(env);
      const res = await app.request(makeRequest(`nosuch.${BASE_DOMAIN}`), undefined, env as Env);
      expect(res.status).toBe(404);
      const body = await res.json<{ error: string }>();
      expect(body.error).toBe('not_found');
    });

    it('returns 404 for a non-active tenant (no row returned)', async () => {
      // lifecycle_state != 'active' -> query returns nothing.
      const db = createMockDB({ tenantRow: null });
      const kv = createMockKV({ cachedValue: null });
      const env: TestEnv = { BASE_DOMAIN, DB: db, AUTHRIM_CONFIG: kv };
      const app = buildApp(env);
      const res = await app.request(makeRequest(`inactive.${BASE_DOMAIN}`), undefined, env as Env);
      expect(res.status).toBe(404);
    });

    it('passes via positive KV cache without hitting D1', async () => {
      const db = createMockDB({ tenantRow: null }); // would return 404 if queried
      const kv = createMockKV({ cachedValue: 'true' }); // cache hit
      const env: TestEnv = { BASE_DOMAIN, DB: db, AUTHRIM_CONFIG: kv };
      const app = buildApp(env);
      const res = await app.request(makeRequest(`sample.${BASE_DOMAIN}`), undefined, env as Env);
      expect(res.status).toBe(200);
      expect(db.prepare).not.toHaveBeenCalledWith(
        "SELECT id FROM tenants WHERE id = ? AND lifecycle_state = 'active'"
      );
    });

    it('returns 200 for naked domain → PRIMARY_TENANT (if it exists)', async () => {
      const db = createMockDB({ tenantRow: { id: 'default' } });
      const kv = createMockKV({ cachedValue: null });
      const env: TestEnv = {
        BASE_DOMAIN,
        NAKED_DOMAIN_AS_ISSUER: 'true',
        DB: db,
        AUTHRIM_CONFIG: kv,
      };
      const app = buildApp(env);
      const res = await app.request(makeRequest(BASE_DOMAIN), undefined, env as Env);
      expect(res.status).toBe(200);
      const body = await res.json<{ tenantId: string }>();
      expect(body.tenantId).toBe('default');
    });

    it('returns 200 for naked domain → explicit PRIMARY_TENANT when omission is enabled', async () => {
      const db = createMockDB({ tenantRow: { id: 'primary' } });
      const kv = createMockKV({ cachedValue: null });
      const env: TestEnv = {
        BASE_DOMAIN,
        DEFAULT_TENANT_ID: 'default',
        PRIMARY_TENANT_ID: 'primary',
        NAKED_DOMAIN_AS_ISSUER: 'true',
        DB: db,
        AUTHRIM_CONFIG: kv,
      };
      const app = buildApp(env);
      const res = await app.request(makeRequest(BASE_DOMAIN), undefined, env as Env);
      expect(res.status).toBe(200);
      const body = await res.json<{ tenantId: string }>();
      expect(body.tenantId).toBe('primary');
    });

    it('returns 404 for naked domain when tenant omission is disabled', async () => {
      const db = createMockDB({ tenantRow: { id: 'default' } });
      const kv = createMockKV({ cachedValue: null });
      const env: TestEnv = {
        BASE_DOMAIN,
        DEFAULT_TENANT_ID: 'default',
        DB: db,
        AUTHRIM_CONFIG: kv,
      };
      const app = buildApp(env);
      const res = await app.request(makeRequest(BASE_DOMAIN), undefined, env as Env);
      expect(res.status).toBe(404);
      expect(db.prepare).not.toHaveBeenCalled();
    });

    it('fails closed for an uncached tenant when D1 is unavailable', async () => {
      const db = createMockDB({ shouldThrow: true });
      const kv = createMockKV({ cachedValue: null });
      const env: TestEnv = { BASE_DOMAIN, DB: db, AUTHRIM_CONFIG: kv };
      const app = buildApp(env);
      const res = await app.request(makeRequest(`sample.${BASE_DOMAIN}`), undefined, env as Env);
      expect(res.status).toBe(404);
    });

    it('fails closed for an uncached tenant when the D1 binding is absent', async () => {
      const kv = createMockKV({ cachedValue: null });
      const env: TestEnv = { BASE_DOMAIN, AUTHRIM_CONFIG: kv };
      const app = buildApp(env);
      const res = await app.request(makeRequest(`sample.${BASE_DOMAIN}`), undefined, env as Env);
      expect(res.status).toBe(404);
    });

    it('allows discovery endpoint requests from a non-tenant common entry host', async () => {
      const db = createMockDB({ tenantRow: null });
      const kv = createMockKV({ cachedValue: null });
      const env: TestEnv = {
        BASE_DOMAIN,
        DEFAULT_TENANT_ID: 'default',
        DB: db,
        AUTHRIM_CONFIG: kv,
      };
      const app = buildApp(env);
      const res = await app.request(
        makeRequest('login.example.com', '/api/auth/discovery'),
        undefined,
        env as Env
      );
      expect(res.status).toBe(200);
      const body = await res.json<{ tenantId: string }>();
      expect(body.tenantId).toBe('default');
    });

    it('allows discovery grant endpoint requests from a non-tenant common entry host', async () => {
      const db = createMockDB({ tenantRow: null });
      const kv = createMockKV({ cachedValue: null });
      const env: TestEnv = {
        BASE_DOMAIN,
        DEFAULT_TENANT_ID: 'default',
        DB: db,
        AUTHRIM_CONFIG: kv,
      };
      const app = buildApp(env);
      const res = await app.request(
        new Request('https://login.example.com/api/auth/discovery/grant', {
          method: 'POST',
          headers: { Host: 'login.example.com', 'Content-Type': 'application/json' },
          body: JSON.stringify({ tenant_id: 'sample' }),
        }),
        undefined,
        env as Env
      );
      expect(res.status).toBe(200);
      const body = await res.json<{ tenantId: string }>();
      expect(body.tenantId).toBe('default');
    });

    it('allows admin login and session endpoints from a non-tenant admin host without X-Tenant-Id', async () => {
      const db = createMockDB({ tenantRow: null });
      const kv = createMockKV({ cachedValue: null });
      const env: TestEnv = {
        BASE_DOMAIN,
        DEFAULT_TENANT_ID: 'default',
        DB: db,
        AUTHRIM_CONFIG: kv,
      };
      const app = buildApp(env);

      const loginRes = await app.request(
        new Request('https://admin.pages.dev/api/admin/auth/passkey/options', {
          method: 'POST',
          headers: { Host: 'admin.pages.dev' },
        }),
        undefined,
        env as Env
      );
      const sessionRes = await app.request(
        makeRequest('admin.pages.dev', '/api/admin/sessions/me'),
        undefined,
        env as Env
      );
      const newSessionRes = await app.request(
        makeRequest('admin.pages.dev', '/api/admin/me/session'),
        undefined,
        env as Env
      );
      const logoutRes = await app.request(
        new Request('https://admin.pages.dev/api/admin/logout', {
          method: 'POST',
          headers: { Host: 'admin.pages.dev' },
        }),
        undefined,
        env as Env
      );

      expect(loginRes.status).toBe(200);
      expect(sessionRes.status).toBe(200);
      expect(newSessionRes.status).toBe(200);
      expect(logoutRes.status).toBe(200);
    });

    it('does not treat the configured Admin UI host as a tenant subdomain', async () => {
      const db = createMockDB({ tenantRow: null });
      const kv = createMockKV({ cachedValue: null });
      const env: TestEnv = {
        BASE_DOMAIN,
        DEFAULT_TENANT_ID: 'first',
        ADMIN_UI_URL: `https://admin.${BASE_DOMAIN}`,
        DB: db,
        AUTHRIM_CONFIG: kv,
      };
      const app = buildApp(env);

      const sessionRes = await app.request(
        makeRequest(`admin.${BASE_DOMAIN}`, '/api/admin/me/session'),
        undefined,
        env as Env
      );
      const tenantsRes = await app.request(
        makeRequest(`admin.${BASE_DOMAIN}`, '/api/admin/tenants'),
        undefined,
        env as Env
      );

      expect(sessionRes.status).toBe(200);
      await expect(sessionRes.json()).resolves.toEqual({ tenantId: 'first' });
      expect(tenantsRes.status).toBe(200);
      await expect(tenantsRes.json()).resolves.toEqual({ tenantId: 'first' });
      expect(db.prepare).not.toHaveBeenCalled();
    });

    it('keeps the naked issuer domain tenant-scoped when it is also the configured UI host', async () => {
      const db = createMockDB({ tenantRow: { id: 'first' } });
      const kv = createMockKV({ cachedValue: null });
      const env: TestEnv = {
        BASE_DOMAIN,
        DEFAULT_TENANT_ID: 'default',
        PRIMARY_TENANT_ID: 'first',
        NAKED_DOMAIN_AS_ISSUER: 'true',
        UI_URL: `https://${BASE_DOMAIN}`,
        ADMIN_UI_URL: `https://${BASE_DOMAIN}`,
        DB: db,
        AUTHRIM_CONFIG: kv,
      };
      const app = buildApp(env);

      const res = await app.request(
        makeRequest(BASE_DOMAIN, '/admin-init-setup'),
        undefined,
        env as Env
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ tenantId: 'first' });
    });

    it('keeps the primary tenant issuer host tenant-scoped when it is also the configured UI host', async () => {
      const db = createMockDB({ tenantRow: { id: 'first' } });
      const kv = createMockKV({
        valuesByKey: {
          'v1:tenant-exists:first': 'true',
        },
      });
      const env: TestEnv = {
        BASE_DOMAIN,
        DEFAULT_TENANT_ID: 'first',
        PRIMARY_TENANT_ID: 'first',
        UI_URL: `https://first.${BASE_DOMAIN}`,
        DB: db,
        AUTHRIM_CONFIG: kv,
      };
      const app = buildApp(env);

      const res = await app.request(
        makeRequest(`first.${BASE_DOMAIN}`, '/api/auth/authentication-methods'),
        undefined,
        env as Env
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        tenantId: 'first',
        hasTenantMetadataContext: false,
      });
    });

    it('skips tenant metadata resolution for the public authentication methods endpoint', async () => {
      const db = createMockDB({ tenantRow: { id: 'first' } });
      const kv = createMockKV({
        valuesByKey: {
          'v1:tenant-exists:first': 'true',
        },
      });
      const env: TestEnv = {
        BASE_DOMAIN,
        DEFAULT_TENANT_ID: 'first',
        PRIMARY_TENANT_ID: 'first',
        DB: db,
        AUTHRIM_CONFIG: kv,
      };
      const app = buildApp(env);

      const res = await app.request(
        makeRequest(`first.${BASE_DOMAIN}`, '/api/auth/authentication-methods'),
        undefined,
        env as Env
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        tenantId: 'first',
        hasTenantMetadataContext: false,
      });
      expect(kv.get).not.toHaveBeenCalledWith('settings:tenant:first:tenant-database');
    });

    it('keeps tenant inventory admin requests on the control-plane database', async () => {
      const db = createMockDB({ tenantRow: { id: 'first' } });
      const kv = createMockKV({
        valuesByKey: {
          'v1:tenant-exists:first': 'true',
        },
      });
      const env: TestEnv = {
        BASE_DOMAIN,
        DEFAULT_TENANT_ID: 'first',
        PRIMARY_TENANT_ID: 'first',
        NAKED_DOMAIN_AS_ISSUER: 'true',
        DB: db,
        AUTHRIM_CONFIG: kv,
      };
      const app = buildApp(env);

      const res = await app.request(
        makeRequest(BASE_DOMAIN, '/api/admin/tenants/first/info'),
        undefined,
        env as Env
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        tenantId: 'first',
        hasTenantMetadataContext: false,
      });
    });

    it('uses X-Tenant-Id for tenant-scoped admin requests from the Admin UI host', async () => {
      const db = createMockDB({ tenantRow: { id: 'first' } });
      const kv = createMockKV({
        valuesByKey: {
          'v1:tenant-exists:first': 'true',
        },
      });
      const env: TestEnv = {
        BASE_DOMAIN,
        DEFAULT_TENANT_ID: 'first',
        ADMIN_UI_URL: `https://admin.${BASE_DOMAIN}`,
        DB: db,
        AUTHRIM_CONFIG: kv,
      };
      const app = buildApp(env);

      const res = await app.request(
        new Request(`https://admin.${BASE_DOMAIN}/api/admin/users`, {
          headers: { Host: `admin.${BASE_DOMAIN}`, 'X-Tenant-Id': 'first' },
        }),
        undefined,
        env as Env
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ tenantId: 'first' });
    });

    it('does not treat the configured Login UI host as a tenant subdomain', async () => {
      const db = createMockDB({ tenantRow: null });
      const kv = createMockKV({ cachedValue: null });
      const env: TestEnv = {
        BASE_DOMAIN,
        DEFAULT_TENANT_ID: 'first',
        UI_URL: `https://login.${BASE_DOMAIN}`,
        DB: db,
        AUTHRIM_CONFIG: kv,
      };
      const app = buildApp(env);

      const res = await app.request(
        makeRequest(`login.${BASE_DOMAIN}`, '/api/auth/discovery'),
        undefined,
        env as Env
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ tenantId: 'first' });
      expect(db.prepare).not.toHaveBeenCalled();
    });

    it('allows global admin settings endpoints from a non-tenant admin host without X-Tenant-Id', async () => {
      const db = createMockDB({ tenantRow: null });
      const kv = createMockKV({ cachedValue: null });
      const env: TestEnv = {
        BASE_DOMAIN,
        DEFAULT_TENANT_ID: 'default',
        DB: db,
        AUTHRIM_CONFIG: kv,
      };
      const app = buildApp(env);

      const res = await app.request(
        makeRequest('admin.pages.dev', '/api/admin/settings/ui-config'),
        undefined,
        env as Env
      );

      expect(res.status).toBe(200);
    });

    it('rejects protocol requests when the request host is not in tenant.allowed_domains', async () => {
      const db = createMockDB({ tenantRow: { id: 'sample' } });
      const kv = createMockKV({
        valuesByKey: {
          'v1:tenant-exists:sample': 'true',
          'settings:tenant:sample:tenant': JSON.stringify({
            'tenant.allowed_domains': 'tenant.sample.example.com',
          }),
        },
      });
      const env: TestEnv = { BASE_DOMAIN, DB: db, AUTHRIM_CONFIG: kv };
      const app = buildApp(env);

      const res = await app.request(makeRequest(`sample.${BASE_DOMAIN}`), undefined, env as Env);

      expect(res.status).toBe(404);
    });

    it('rejects protocol requests when tenant.allowed_identifiers does not match the request issuer', async () => {
      const db = createMockDB({ tenantRow: { id: 'sample' } });
      const kv = createMockKV({
        valuesByKey: {
          'v1:tenant-exists:sample': null,
          'settings:tenant:sample:tenant': JSON.stringify({
            'tenant.allowed_identifiers': 'https://other.test.authrim.com',
          }),
        },
      });
      const env: TestEnv = { BASE_DOMAIN, DB: db, AUTHRIM_CONFIG: kv };
      const app = buildApp(env);

      const res = await app.request(makeRequest(`sample.${BASE_DOMAIN}`), undefined, env as Env);

      expect(res.status).toBe(404);
    });

    it('allows protocol requests when tenant.allowed_identifiers matches the request issuer', async () => {
      const db = createMockDB({ tenantRow: { id: 'sample' } });
      const kv = createMockKV({
        valuesByKey: {
          'v1:tenant-exists:sample': null,
          'settings:tenant:sample:tenant': JSON.stringify({
            'tenant.allowed_identifiers': 'https://sample.test.authrim.com',
          }),
        },
      });
      const env: TestEnv = { BASE_DOMAIN, DB: db, AUTHRIM_CONFIG: kv };
      const app = buildApp(env);

      const res = await app.request(makeRequest(`sample.${BASE_DOMAIN}`), undefined, env as Env);

      expect(res.status).toBe(200);
    });

    it('returns a PII-free 409 when the signed tenant runtime snapshot is missing', async () => {
      runtimeMocks.resolveTenantMetadata.mockRejectedValueOnce(
        new TenantDatabaseResolverError('missing_generation', 'Runtime generation is missing')
      );
      const db = createMockDB({ tenantRow: { id: 'sample' } });
      const kv = createMockKV({
        valuesByKey: {
          'v1:tenant-exists:sample': 'true',
        },
      });
      const env: TestEnv = {
        BASE_DOMAIN,
        DB: db,
        AUTHRIM_CONFIG: kv,
      };
      const app = buildApp(env);

      const res = await app.request(makeRequest(`sample.${BASE_DOMAIN}`), undefined, env as Env);

      expect(res.status).toBe(409);
      const body = await res.json<{
        error: string;
        route: string;
        tenant_id: string;
        email?: string;
      }>();
      expect(body).toMatchObject({
        error: 'missing_generation',
        route: '/test',
        tenant_id: 'sample',
      });
      expect(body.email).toBeUndefined();
    });

    it('returns a PII-free 409 for protocol routes without a signed snapshot', async () => {
      runtimeMocks.resolveTenantMetadata.mockRejectedValueOnce(
        new TenantDatabaseResolverError('missing_generation', 'Runtime generation is missing')
      );
      const db = createMockDB({ tenantRow: { id: 'sample' } });
      const kv = createMockKV({
        valuesByKey: {
          'v1:tenant-exists:sample': null,
        },
      });
      const env: TestEnv = {
        BASE_DOMAIN,
        DB: db,
        AUTHRIM_CONFIG: kv,
      };
      const app = buildApp(env);

      const res = await app.request(
        makeRequest(`sample.${BASE_DOMAIN}`, '/device_authorization'),
        undefined,
        env as Env
      );

      expect(res.status).toBe(409);
      const body = await res.json<{
        error: string;
        route: string;
        tenant_id: string;
        email?: string;
      }>();
      expect(body).toMatchObject({
        error: 'missing_generation',
        route: '/device_authorization',
        tenant_id: 'sample',
      });
      expect(body.email).toBeUndefined();
    });

    it('returns a PII-free 409 for tenant admin routes without a signed snapshot', async () => {
      runtimeMocks.resolveTenantMetadata.mockRejectedValueOnce(
        new TenantDatabaseResolverError('missing_generation', 'Runtime generation is missing')
      );
      const db = createMockDB({ tenantRow: { id: 'sample' } });
      const kv = createMockKV({
        valuesByKey: {
          'v1:tenant-exists:sample': null,
        },
      });
      const env: TestEnv = {
        BASE_DOMAIN,
        DB: db,
        AUTHRIM_CONFIG: kv,
      };
      const app = buildApp(env);

      const res = await app.request(
        makeRequest('admin.pages.dev', '/api/admin/jobs/users/bulk-update', {
          'X-Tenant-Id': 'sample',
        }),
        undefined,
        env as Env
      );

      expect(res.status).toBe(409);
      const body = await res.json<{
        error: string;
        route: string;
        tenant_id: string;
        email?: string;
      }>();
      expect(body).toMatchObject({
        error: 'missing_generation',
        route: '/api/admin/jobs/users/bulk-update',
        tenant_id: 'sample',
      });
      expect(body.email).toBeUndefined();
    });

    it.each([
      ['GET', '/api/admin/tenants/provisioning-tenant/provisioning'],
      ['POST', '/api/admin/tenants/provisioning-tenant/provisioning/retry'],
      ['POST', '/api/admin/tenants/provisioning-tenant/provisioning/cleanup'],
    ])('allows %s %s before the tenant runtime snapshot exists', async (method, path) => {
      const db = createMockDB({ tenantRow: null });
      const kv = createMockKV({ cachedValue: null });
      const env: TestEnv = {
        BASE_DOMAIN,
        DEFAULT_TENANT_ID: 'default',
        DB: db,
        AUTHRIM_CONFIG: kv,
      };
      const app = buildApp(env);
      const request = makeRequest('admin.pages.dev', path);

      const res = await app.request(
        new Request(request.url, { method, headers: request.headers }),
        undefined,
        env as Env
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ tenantId: 'default' });
      expect(db.prepare).not.toHaveBeenCalled();
    });

    it('allows platform admin requests without X-Tenant-Id', async () => {
      const db = createMockDB({ tenantRow: null });
      const kv = createMockKV({ cachedValue: null });
      const env: TestEnv = {
        BASE_DOMAIN,
        DEFAULT_TENANT_ID: 'default',
        DB: db,
        AUTHRIM_CONFIG: kv,
      };
      const app = buildApp(env);

      const res = await app.request(
        makeRequest('admin.pages.dev', '/api/admin/platform/tenant-domain-mappings'),
        undefined,
        env as Env
      );

      expect(res.status).toBe(200);
      expect(db.prepare).not.toHaveBeenCalled();
    });

    it('does not validate tenant existence for platform admin requests on a tenant API host', async () => {
      const db = createMockDB({ tenantRow: null });
      const kv = createMockKV({ cachedValue: null });
      const env: TestEnv = {
        BASE_DOMAIN,
        DEFAULT_TENANT_ID: 'first',
        PRIMARY_TENANT_ID: 'first',
        DB: db,
        AUTHRIM_CONFIG: kv,
      };
      const app = buildApp(env);

      const res = await app.request(
        makeRequest(`first.${BASE_DOMAIN}`, '/api/admin/platform/tenant-domain-mappings'),
        undefined,
        env as Env
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ tenantId: 'first' });
      expect(db.prepare).not.toHaveBeenCalled();
    });

    it('requires X-Tenant-Id for tenant-scoped admin requests', async () => {
      const db = createMockDB({ tenantRow: { id: 'default' } });
      const kv = createMockKV({ cachedValue: null });
      const env: TestEnv = {
        BASE_DOMAIN,
        DEFAULT_TENANT_ID: 'default',
        DB: db,
        AUTHRIM_CONFIG: kv,
      };
      const app = buildApp(env);

      const res = await app.request(
        makeRequest('admin.pages.dev', '/api/admin/users'),
        undefined,
        env as Env
      );

      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error).toBe('invalid_request');
    });

    it('rejects invalid X-Tenant-Id format for tenant-scoped admin requests', async () => {
      const db = createMockDB({ tenantRow: { id: 'default' } });
      const kv = createMockKV({ cachedValue: null });
      const env: TestEnv = {
        BASE_DOMAIN,
        DEFAULT_TENANT_ID: 'default',
        DB: db,
        AUTHRIM_CONFIG: kv,
      };
      const app = buildApp(env);

      const res = await app.request(
        makeRequest('admin.pages.dev', '/api/admin/users', { 'X-Tenant-Id': 'INVALID_HEADER' }),
        undefined,
        env as Env
      );

      expect(res.status).toBe(400);
    });

    it('rejects mismatched X-Tenant-Id for explicit tenant-scoped admin paths', async () => {
      const db = createMockDB({ tenantRow: { id: 'acme' } });
      const kv = createMockKV({ cachedValue: null });
      const env: TestEnv = {
        BASE_DOMAIN,
        DEFAULT_TENANT_ID: 'default',
        DB: db,
        AUTHRIM_CONFIG: kv,
      };
      const app = buildApp(env);

      const res = await app.request(
        makeRequest('admin.pages.dev', '/api/admin/tenants/acme/settings/oauth', {
          'X-Tenant-Id': 'beta',
        }),
        undefined,
        env as Env
      );

      expect(res.status).toBe(400);
    });
  });
});
