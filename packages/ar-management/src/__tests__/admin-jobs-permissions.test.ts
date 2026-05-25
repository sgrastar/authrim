import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import { registerAdminJobPermissionMiddleware } from '../admin-jobs';

function createApp() {
  const app = new Hono<{
    Bindings: Env;
    Variables: { adminAuth?: AdminAuthContext };
  }>();

  app.use('*', async (c, next) => {
    const roles = (c.req.header('X-Admin-Roles') || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const permissions = (c.req.header('X-Admin-Permissions') || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    c.set('adminAuth', {
      userId: 'admin-1',
      authMethod: 'session',
      tenantId: 'tenant-a',
      roles,
      permissions,
      hierarchyLevel: 50,
      mfaVerified: true,
    });

    await next();
  });

  registerAdminJobPermissionMiddleware(app);

  app.get('/api/admin/jobs', (c) => c.json({ ok: true }));
  app.post('/api/admin/jobs/users/import/upload-url', (c) => c.json({ ok: true }, 201));
  app.get('/api/admin/jobs/:id/result/download', (c) => c.json({ ok: true }));
  app.get('/api/admin/jobs/artifacts/:artifactId/chunks/:index', (c) => c.json({ ok: true }));

  return app;
}

function buildHeaders(permissions: string[]): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'X-Admin-Roles': 'tenant_admin',
    'X-Admin-Permissions': permissions.join(','),
  };
}

describe('admin jobs permission middleware', () => {
  it('rejects jobs list without jobs read permission', async () => {
    const app = createApp();
    const res = await app.request('/api/admin/jobs', {
      method: 'GET',
      headers: buildHeaders([]),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('insufficient_permissions');
  });

  it('allows jobs list with jobs read permission', async () => {
    const app = createApp();
    const res = await app.request('/api/admin/jobs', {
      method: 'GET',
      headers: buildHeaders(['admin:jobs:read']),
    });

    expect(res.status).toBe(200);
  });

  it('rejects import upload URL creation without jobs write permission', async () => {
    const app = createApp();
    const res = await app.request('/api/admin/jobs/users/import/upload-url', {
      method: 'POST',
      headers: buildHeaders(['admin:jobs:read']),
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('insufficient_permissions');
  });

  it('allows artifact download routes through middleware with jobs read permission', async () => {
    const app = createApp();
    const res = await app.request('/api/admin/jobs/123/result/download', {
      method: 'GET',
      headers: buildHeaders(['admin:jobs:read']),
    });

    expect(res.status).toBe(200);
  });

  it('allows artifact chunk reads with jobs read permission at middleware level', async () => {
    const app = createApp();
    const res = await app.request('/api/admin/jobs/artifacts/artifact-1/chunks/0', {
      method: 'GET',
      headers: buildHeaders(['admin:jobs:read']),
    });

    expect(res.status).toBe(200);
  });
});
