import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { registerAdminResourcePermissionMiddleware } from '../admin-resource-permissions';
import { registerDeclaredAdminRouteAccessMiddleware } from '../admin-route-access';

/** Both gates, in the order the management app registers them. */
function createApp(permissions: string[]) {
  const app = new Hono<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>();
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
  registerDeclaredAdminRouteAccessMiddleware(app);
  registerAdminResourcePermissionMiddleware(app);
  app.get('/api/admin/users/user-1/assurance', (c) => c.json({ ok: true }));
  app.post('/api/admin/users/user-1/assurance/evidence', (c) => c.json({ ok: true }));
  app.post('/api/admin/users/user-1/assurance/evidence/ev-1/revoke', (c) => c.json({ ok: true }));
  return app;
}

describe('identity assurance access', () => {
  it('needs only the assurance permissions, never the general user ones', async () => {
    const reader = createApp([ADMIN_PERMISSIONS.ACCOUNT_ASSURANCE_READ]);
    const writer = createApp([ADMIN_PERMISSIONS.ACCOUNT_ASSURANCE_WRITE]);
    const userAdmin = createApp([ADMIN_PERMISSIONS.USERS_READ, ADMIN_PERMISSIONS.USERS_WRITE]);
    const path = '/api/admin/users/user-1/assurance';
    expect((await reader.request(path)).status).toBe(200);
    expect((await userAdmin.request(path)).status).toBe(403);
    for (const write of [`${path}/evidence`, `${path}/evidence/ev-1/revoke`]) {
      expect((await writer.request(write, { method: 'POST' })).status, write).toBe(200);
      expect((await reader.request(write, { method: 'POST' })).status, write).toBe(403);
      expect((await userAdmin.request(write, { method: 'POST' })).status, write).toBe(403);
    }
  });
});
