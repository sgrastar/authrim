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

function createMockKV(options: { cachedValue?: string | null } = {}) {
  const store = new Map<string, string>();
  if (options.cachedValue !== undefined && options.cachedValue !== null) {
    // pre-populate
  }
  return {
    get: vi.fn().mockImplementation(async (_key: string) => options.cachedValue ?? null),
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
  return app;
}

function makeRequest(host: string, path = '/test') {
  return new Request(`https://${host}${path}`, {
    headers: { Host: host },
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

    it('fail-open on D1 error (does not block request)', async () => {
      const db = createMockDB({ shouldThrow: true });
      const kv = createMockKV({ cachedValue: null });
      const env: TestEnv = { BASE_DOMAIN, DB: db, AUTHRIM_CONFIG: kv };
      const app = buildApp(env);
      const res = await app.request(makeRequest(`sample.${BASE_DOMAIN}`), undefined, env as Env);
      expect(res.status).toBe(200); // fail-open
    });
  });
});
