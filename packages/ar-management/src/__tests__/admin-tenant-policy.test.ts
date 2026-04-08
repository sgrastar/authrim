import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { getTenantIdFromContext, requestContextMiddleware } from '@authrim/ar-lib-core';
import { adminTenantPolicyMiddleware } from '../admin-tenant-policy';

function createMockDB(options: { tenantRow?: { id: string } | null } = {}) {
  const { tenantRow = null } = options;

  return {
    prepare: vi.fn().mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(tenantRow),
      }),
    })),
  } as unknown as D1Database;
}

function createMockKV(cachedValue: string | null = null) {
  return {
    get: vi.fn().mockResolvedValue(cachedValue),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as KVNamespace;
}

function buildApp(env: Partial<Env>) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', requestContextMiddleware());
  app.use('/api/admin/*', adminTenantPolicyMiddleware);
  app.get('/api/admin/platform/tenant-domain-mappings', (c) =>
    c.json({ tenantId: getTenantIdFromContext(c) })
  );
  app.get('/api/admin/tenants', (c) => c.json({ tenantId: getTenantIdFromContext(c) }));
  app.get('/api/admin/users', (c) => c.json({ tenantId: getTenantIdFromContext(c) }));
  app.get('/api/admin/tenants/:tenantId/settings/oauth', (c) =>
    c.json({ tenantId: getTenantIdFromContext(c), pathTenantId: c.req.param('tenantId') })
  );
  return { app, env: env as Env };
}

function makeRequest(path: string, headers: Record<string, string> = {}) {
  return new Request(`https://admin.pages.dev${path}`, {
    headers: {
      Host: 'admin.pages.dev',
      ...headers,
    },
  });
}

describe('adminTenantPolicyMiddleware', () => {
  it('allows platform admin endpoints without X-Tenant-Id', async () => {
    const { app, env } = buildApp({
      BASE_DOMAIN: 'auth.example.com',
      DEFAULT_TENANT_ID: 'default',
      DB: createMockDB(),
      AUTHRIM_CONFIG: createMockKV(),
    });

    const res = await app.request(
      makeRequest('/api/admin/platform/tenant-domain-mappings'),
      undefined,
      env
    );

    expect(res.status).toBe(200);
  });

  it('allows tenant inventory endpoints without X-Tenant-Id', async () => {
    const { app, env } = buildApp({
      BASE_DOMAIN: 'auth.example.com',
      DEFAULT_TENANT_ID: 'default',
      DB: createMockDB(),
      AUTHRIM_CONFIG: createMockKV(),
    });

    const res = await app.request(makeRequest('/api/admin/tenants'), undefined, env);

    expect(res.status).toBe(200);
  });

  it('returns 400 when tenant-scoped admin endpoints omit X-Tenant-Id', async () => {
    const { app, env } = buildApp({
      BASE_DOMAIN: 'auth.example.com',
      DEFAULT_TENANT_ID: 'default',
      DB: createMockDB({ tenantRow: { id: 'default' } }),
      AUTHRIM_CONFIG: createMockKV(),
    });

    const res = await app.request(makeRequest('/api/admin/users'), undefined, env);

    expect(res.status).toBe(400);
  });

  it('returns 400 when X-Tenant-Id format is invalid', async () => {
    const { app, env } = buildApp({
      BASE_DOMAIN: 'auth.example.com',
      DEFAULT_TENANT_ID: 'default',
      DB: createMockDB({ tenantRow: { id: 'default' } }),
      AUTHRIM_CONFIG: createMockKV(),
    });

    const res = await app.request(
      makeRequest('/api/admin/users', { 'X-Tenant-Id': 'INVALID_HEADER' }),
      undefined,
      env
    );

    expect(res.status).toBe(400);
  });

  it('returns 404 when X-Tenant-Id points to an unknown tenant', async () => {
    const { app, env } = buildApp({
      BASE_DOMAIN: 'auth.example.com',
      DEFAULT_TENANT_ID: 'default',
      DB: createMockDB({ tenantRow: null }),
      AUTHRIM_CONFIG: createMockKV(),
    });

    const res = await app.request(
      makeRequest('/api/admin/users', { 'X-Tenant-Id': 'ghost' }),
      undefined,
      env
    );

    expect(res.status).toBe(404);
  });

  it('returns 400 when X-Tenant-Id does not match explicit tenant path', async () => {
    const { app, env } = buildApp({
      BASE_DOMAIN: 'auth.example.com',
      DEFAULT_TENANT_ID: 'default',
      DB: createMockDB({ tenantRow: { id: 'acme' } }),
      AUTHRIM_CONFIG: createMockKV(),
    });

    const res = await app.request(
      makeRequest('/api/admin/tenants/acme/settings/oauth', { 'X-Tenant-Id': 'beta' }),
      undefined,
      env
    );

    expect(res.status).toBe(400);
  });
});
