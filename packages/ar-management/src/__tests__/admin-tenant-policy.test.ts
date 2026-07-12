import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  getTenantIdFromContext,
  requestContextMiddleware,
  requireSystemAdmin,
} from '@authrim/ar-lib-core';
import { adminTenantPolicyMiddleware } from '../admin-tenant-policy';
import { isTenantScopedAdminPath } from '../admin-tenant-access';

function createMockDB(options: { tenantRow?: { id: string } | null } = {}) {
  const { tenantRow = null } = options;

  return {
    prepare: vi.fn().mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(tenantRow),
        all: vi.fn().mockResolvedValue({ results: tenantRow ? [tenantRow] : [] }),
        run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
      }),
      first: vi.fn().mockResolvedValue(sql === 'SELECT 1' ? { ok: 1 } : tenantRow),
      all: vi.fn().mockResolvedValue({ results: tenantRow ? [tenantRow] : [] }),
      run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
    })),
    batch: vi.fn().mockResolvedValue([]),
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
  app.get('/api/admin/settings/ui-config', (c) => c.json({ tenantId: getTenantIdFromContext(c) }));
  app.put('/api/admin/settings/ui-config', (c) => c.json({ tenantId: getTenantIdFromContext(c) }));
  app.post('/api/admin/auth/passkey/options', (c) =>
    c.json({ tenantId: getTenantIdFromContext(c) })
  );
  app.get('/api/admin/sessions/me', (c) => c.json({ tenantId: getTenantIdFromContext(c) }));
  app.get('/api/admin/me/session', (c) => c.json({ tenantId: getTenantIdFromContext(c) }));
  app.post('/api/admin/logout', (c) => c.json({ tenantId: getTenantIdFromContext(c) }));
  app.get('/api/admin/tenants', (c) => c.json({ tenantId: getTenantIdFromContext(c) }));
  app.get('/api/admin/runtime-profiles', (c) => c.json({ tenantId: getTenantIdFromContext(c) }));
  app.get('/api/admin/users', (c) => c.json({ tenantId: getTenantIdFromContext(c) }));
  app.get('/api/admin/tenants/:id/runtime-profiles', (c) =>
    c.json({ tenantId: getTenantIdFromContext(c), pathTenantId: c.req.param('id') })
  );
  app.get('/api/admin/tenants/:id/info', (c) =>
    c.json({ tenantId: getTenantIdFromContext(c), pathTenantId: c.req.param('id') })
  );
  app.get('/api/admin/tenants/:id/invitations', (c) =>
    c.json({ tenantId: getTenantIdFromContext(c), pathTenantId: c.req.param('id') })
  );
  app.get('/api/admin/tenants/:tenantId/settings/oauth', (c) =>
    c.json({ tenantId: getTenantIdFromContext(c), pathTenantId: c.req.param('tenantId') })
  );
  app.get('/api/admin/tenants/:tenantId/email-settings', (c) =>
    c.json({ tenantId: getTenantIdFromContext(c), pathTenantId: c.req.param('tenantId') })
  );
  app.get('/api/admin/settings/logging/tenant/:tenantId', (c) =>
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

function buildPlatformGuardApp(roles: string[]) {
  const app = new Hono<{ Bindings: Env; Variables: { adminAuth?: unknown } }>();
  app.use('*', async (c, next) => {
    c.set('adminAuth', {
      userId: 'admin-1',
      authMethod: 'session',
      roles,
      tenantId: 'tenant-a',
      permissions: [],
    });
    await next();
  });
  app.get('/api/admin/platform/tenant-domain-mappings', requireSystemAdmin(), (c) =>
    c.json({ ok: true })
  );
  return app;
}

describe('adminTenantPolicyMiddleware', () => {
  it('identifies tenant-scoped admin subresources that are managed by tenant admins', () => {
    expect(isTenantScopedAdminPath('/api/admin/tenants/tenant-a/directory-auth/overview')).toBe(
      true
    );
    expect(isTenantScopedAdminPath('/api/admin/tenants/tenant-a/directory-connectors')).toBe(true);
    expect(isTenantScopedAdminPath('/api/admin/tenants/tenant-a/settings/login-ui')).toBe(true);
    expect(isTenantScopedAdminPath('/api/admin/tenants/tenant-a')).toBe(false);
    expect(isTenantScopedAdminPath('/api/admin/tenants/tenant-a/email-settings')).toBe(false);
  });

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

  it('rejects tenant admins at the tenant-domain mapping platform guard', async () => {
    const app = buildPlatformGuardApp(['admin']);
    const res = await app.request(
      makeRequest('/api/admin/platform/tenant-domain-mappings'),
      undefined,
      {} as Env
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'access_denied' });
  });

  it('allows platform admins at the tenant-domain mapping platform guard', async () => {
    const app = buildPlatformGuardApp(['super_admin']);
    const res = await app.request(
      makeRequest('/api/admin/platform/tenant-domain-mappings'),
      undefined,
      {} as Env
    );

    expect(res.status).toBe(200);
  });

  it('allows global admin settings endpoints without X-Tenant-Id', async () => {
    const { app, env } = buildApp({
      BASE_DOMAIN: 'auth.example.com',
      DEFAULT_TENANT_ID: 'default',
      DB: createMockDB(),
      AUTHRIM_CONFIG: createMockKV(),
    });

    const getRes = await app.request(makeRequest('/api/admin/settings/ui-config'), undefined, env);
    const putRes = await app.request(
      new Request('https://admin.pages.dev/api/admin/settings/ui-config', {
        method: 'PUT',
        headers: { Host: 'admin.pages.dev' },
      }),
      undefined,
      env
    );

    expect(getRes.status).toBe(200);
    expect(putRes.status).toBe(200);
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

  it('allows platform runtime profile registry endpoints without X-Tenant-Id', async () => {
    const { app, env } = buildApp({
      BASE_DOMAIN: 'auth.example.com',
      DEFAULT_TENANT_ID: 'default',
      DB: createMockDB(),
      AUTHRIM_CONFIG: createMockKV(),
    });

    const res = await app.request(makeRequest('/api/admin/runtime-profiles'), undefined, env);

    expect(res.status).toBe(200);
  });

  it('allows tenant runtime profile inventory endpoints without X-Tenant-Id', async () => {
    const { app, env } = buildApp({
      BASE_DOMAIN: 'auth.example.com',
      DEFAULT_TENANT_ID: 'default',
      DB: createMockDB(),
      AUTHRIM_CONFIG: createMockKV(),
    });

    const res = await app.request(
      makeRequest('/api/admin/tenants/default/runtime-profiles'),
      undefined,
      env
    );

    expect(res.status).toBe(200);
  });

  it('allows tenant info and invitation inventory endpoints without X-Tenant-Id', async () => {
    const { app, env } = buildApp({
      BASE_DOMAIN: 'auth.example.com',
      DEFAULT_TENANT_ID: 'default',
      DB: createMockDB(),
      AUTHRIM_CONFIG: createMockKV(),
    });

    const infoRes = await app.request(
      makeRequest('/api/admin/tenants/default/info'),
      undefined,
      env
    );
    const invitationsRes = await app.request(
      makeRequest('/api/admin/tenants/default/invitations'),
      undefined,
      env
    );

    expect(infoRes.status).toBe(200);
    expect(invitationsRes.status).toBe(200);
  });

  it('allows admin login endpoints without X-Tenant-Id', async () => {
    const { app, env } = buildApp({
      BASE_DOMAIN: 'auth.example.com',
      DEFAULT_TENANT_ID: 'default',
      DB: createMockDB(),
      AUTHRIM_CONFIG: createMockKV(),
    });

    const res = await app.request(
      new Request('https://admin.pages.dev/api/admin/auth/passkey/options', {
        method: 'POST',
        headers: { Host: 'admin.pages.dev' },
      }),
      undefined,
      env
    );

    expect(res.status).toBe(200);
  });

  it('allows admin session status and logout endpoints without X-Tenant-Id', async () => {
    const { app, env } = buildApp({
      BASE_DOMAIN: 'auth.example.com',
      DEFAULT_TENANT_ID: 'default',
      DB: createMockDB(),
      AUTHRIM_CONFIG: createMockKV(),
    });

    const sessionRes = await app.request(makeRequest('/api/admin/sessions/me'), undefined, env);
    const newSessionRes = await app.request(makeRequest('/api/admin/me/session'), undefined, env);
    const logoutRes = await app.request(
      new Request('https://admin.pages.dev/api/admin/logout', {
        method: 'POST',
        headers: { Host: 'admin.pages.dev' },
      }),
      undefined,
      env
    );

    expect(sessionRes.status).toBe(200);
    expect(newSessionRes.status).toBe(200);
    expect(logoutRes.status).toBe(200);
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

  it('returns 400 when X-Tenant-Id does not match tenant email-settings path', async () => {
    const { app, env } = buildApp({
      BASE_DOMAIN: 'auth.example.com',
      DEFAULT_TENANT_ID: 'default',
      DB: createMockDB({ tenantRow: { id: 'acme' } }),
      AUTHRIM_CONFIG: createMockKV(),
    });

    const res = await app.request(
      makeRequest('/api/admin/tenants/acme/email-settings', { 'X-Tenant-Id': 'beta' }),
      undefined,
      env
    );

    expect(res.status).toBe(400);
  });

  it('returns 400 when X-Tenant-Id does not match tenant logging override path', async () => {
    const { app, env } = buildApp({
      BASE_DOMAIN: 'auth.example.com',
      DEFAULT_TENANT_ID: 'default',
      DB: createMockDB({ tenantRow: { id: 'acme' } }),
      AUTHRIM_CONFIG: createMockKV(),
    });

    const res = await app.request(
      makeRequest('/api/admin/settings/logging/tenant/acme', { 'X-Tenant-Id': 'beta' }),
      undefined,
      env
    );

    expect(res.status).toBe(400);
  });
});
