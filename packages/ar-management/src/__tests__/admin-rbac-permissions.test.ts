import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { registerAdminRbacPermissionMiddleware } from '../admin-rbac-permissions';

function createApp(permissions: string[]) {
  const app = new Hono<{
    Bindings: Env;
    Variables: { adminAuth?: AdminAuthContext };
  }>();

  app.use('*', async (c, next) => {
    c.set('adminAuth', {
      userId: 'admin-1',
      authMethod: 'machine_access_token',
      actorType: 'machine',
      tenantId: 'tenant-a',
      roles: [],
      permissions,
      hierarchyLevel: 0,
      mfaVerified: false,
    });
    await next();
  });

  registerAdminRbacPermissionMiddleware(app);

  app.get('/api/admin/roles', (c) => c.json({ ok: true }));
  app.post('/api/admin/roles', (c) => c.json({ ok: true }, 201));
  app.delete('/api/admin/roles/:id', (c) => c.json({ ok: true }));
  app.post('/api/admin/users/:id/roles', (c) => c.json({ ok: true }, 201));
  app.get('/api/admin/users/:id/effective-permissions', (c) => c.json({ ok: true }));

  return app;
}

describe('admin RBAC permission middleware', () => {
  it('rejects role creation with only users read permission', async () => {
    const app = createApp([ADMIN_PERMISSIONS.USERS_READ]);
    const response = await app.request('/api/admin/roles', { method: 'POST' });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(403);
    expect(body.error).toBe('insufficient_permissions');
  });

  it('rejects user role assignment with only users read permission', async () => {
    const app = createApp([ADMIN_PERMISSIONS.USERS_READ]);
    const response = await app.request('/api/admin/users/user-1/roles', { method: 'POST' });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(403);
    expect(body.error).toBe('insufficient_permissions');
  });

  it('allows user role assignment with roles write permission', async () => {
    const app = createApp([ADMIN_PERMISSIONS.ROLES_WRITE]);
    const response = await app.request('/api/admin/users/user-1/roles', { method: 'POST' });

    expect(response.status).toBe(201);
  });

  it('requires roles delete permission for deleting role definitions', async () => {
    const withWrite = createApp([ADMIN_PERMISSIONS.ROLES_WRITE]);
    const denied = await withWrite.request('/api/admin/roles/role-1', { method: 'DELETE' });

    const withDelete = createApp([ADMIN_PERMISSIONS.ROLES_DELETE]);
    const allowed = await withDelete.request('/api/admin/roles/role-1', { method: 'DELETE' });

    expect(denied.status).toBe(403);
    expect(allowed.status).toBe(200);
  });

  it('allows read-only RBAC inspection with roles read permission', async () => {
    const app = createApp([ADMIN_PERMISSIONS.ROLES_READ]);
    const roles = await app.request('/api/admin/roles');
    const effective = await app.request('/api/admin/users/user-1/effective-permissions');

    expect(roles.status).toBe(200);
    expect(effective.status).toBe(200);
  });
});
