import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { requestContextMiddleware, getTenantIdFromContext } from '../request-context';
import type { Env } from '../../types/env';

// =============================================================================
// Mock helpers
// =============================================================================

function createMockDB(options: { tenantRow?: { id: string } | null; shouldThrow?: boolean } = {}) {
  const { tenantRow = null, shouldThrow = false } = options;

  return {
    prepare: vi.fn().mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockImplementation(async () => {
          if (shouldThrow) throw new Error('DB error');
          return tenantRow;
        }),
      }),
    })),
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
  app.get('/api/auth/discovery', (c) => {
    const tenantId = getTenantIdFromContext(c);
    return c.json({ tenantId });
  });
  app.get('/api/admin/platform/tenant-domain-mappings', (c) => {
    return c.json({ tenantId: getTenantIdFromContext(c) });
  });
  app.get('/api/admin/tenants', (c) => {
    return c.json({ tenantId: getTenantIdFromContext(c) });
  });
  app.get('/api/admin/users', (c) => {
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

    it('returns 404 for an inactive tenant (no row returned)', async () => {
      // is_active = 0 → query returns nothing (WHERE is_active = 1)
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
      expect(db.prepare).not.toHaveBeenCalled(); // no D1 query
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

    it('fail-open on D1 error (does not block request)', async () => {
      const db = createMockDB({ shouldThrow: true });
      const kv = createMockKV({ cachedValue: null });
      const env: TestEnv = { BASE_DOMAIN, DB: db, AUTHRIM_CONFIG: kv };
      const app = buildApp(env);
      const res = await app.request(makeRequest(`sample.${BASE_DOMAIN}`), undefined, env as Env);
      expect(res.status).toBe(200); // fail-open
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

    it('rejects protocol requests when the request host is not in tenant.allowed_domains', async () => {
      const db = createMockDB({ tenantRow: { id: 'sample' } });
      const kv = createMockKV({
        valuesByKey: {
          'v1:tenant-exists:sample': null,
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

    it('allows platform admin requests without X-Tenant-Id', async () => {
      const db = createMockDB({ tenantRow: null });
      const kv = createMockKV({ cachedValue: null });
      const env: TestEnv = { BASE_DOMAIN, DEFAULT_TENANT_ID: 'default', DB: db, AUTHRIM_CONFIG: kv };
      const app = buildApp(env);

      const res = await app.request(
        makeRequest('admin.pages.dev', '/api/admin/platform/tenant-domain-mappings'),
        undefined,
        env as Env
      );

      expect(res.status).toBe(200);
      expect(db.prepare).not.toHaveBeenCalled();
    });

    it('requires X-Tenant-Id for tenant-scoped admin requests', async () => {
      const db = createMockDB({ tenantRow: { id: 'default' } });
      const kv = createMockKV({ cachedValue: null });
      const env: TestEnv = { BASE_DOMAIN, DEFAULT_TENANT_ID: 'default', DB: db, AUTHRIM_CONFIG: kv };
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
      const env: TestEnv = { BASE_DOMAIN, DEFAULT_TENANT_ID: 'default', DB: db, AUTHRIM_CONFIG: kv };
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
      const env: TestEnv = { BASE_DOMAIN, DEFAULT_TENANT_ID: 'default', DB: db, AUTHRIM_CONFIG: kv };
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
