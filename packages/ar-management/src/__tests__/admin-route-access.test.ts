import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { app as managementApp } from '../index';
import {
  ADMIN_ROUTE_ACCESS_RULES,
  enforceDeclaredAdminRouteAccess,
  findAdminRouteAccessRule,
  registerDeclaredAdminRouteAccessMiddleware,
} from '../admin-route-access';

const ROUTE_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

function createHarness(permissions: string[], roles: string[] = []) {
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
      roles,
      permissions,
      hierarchyLevel: 0,
      mfaVerified: false,
    });
    await next();
  });

  registerDeclaredAdminRouteAccessMiddleware(app);

  app.get('/api/admin/users', (c) => c.json({ ok: true }));
  app.delete('/api/admin/users/user-1', (c) => c.json({ ok: true }));
  app.delete('/api/admin/users/user-1/roles/assignment-1', (c) => c.json({ ok: true }));
  app.put('/api/admin/settings', (c) => c.json({ ok: true }));
  app.post('/api/admin/undocumented', (c) => c.json({ ok: true }));
  app.get('/api/admin/consent-policies', (c) => c.json({ ok: true }));
  app.post('/api/admin/consent-policies', (c) => c.json({ ok: true }));
  app.get('/api/admin/consent-policies/policy-1', (c) => c.json({ ok: true }));
  app.put('/api/admin/consent-policies/policy-1', (c) => c.json({ ok: true }));
  app.delete('/api/admin/consent-policies/policy-1', (c) => c.json({ ok: true }));
  app.put('/api/admin/consent-policies/policy-1/items', (c) => c.json({ ok: true }));
  app.get('/api/admin/client-trust-policies', (c) => c.json({ ok: true }));
  app.put('/api/admin/client-trust-policies', (c) => c.json({ ok: true }));
  app.get('/api/admin/sign-in-confirmation-policies', (c) => c.json({ ok: true }));
  app.put('/api/admin/sign-in-confirmation-policies', (c) => c.json({ ok: true }));
  app.get('/api/admin/tenants/tenant-a/directory-auth/overview', (c) => c.json({ ok: true }));
  app.get('/api/admin/tenants/tenant-a/directory-connectors', (c) => c.json({ ok: true }));
  app.put('/api/admin/tenants/tenant-a/directory-connectors', (c) => c.json({ ok: true }));
  app.post('/api/admin/tenants/tenant-a/directory-auth/migration/campaigns', (c) =>
    c.json({ ok: true })
  );
  app.post('/api/admin/tenants/tenant-a/directory-auth/compliance/evidence-exports', (c) =>
    c.json({ ok: true })
  );
  app.get(
    '/api/admin/tenants/tenant-a/directory-auth/compliance/evidence-exports/daex_1/download',
    (c) => c.json({ ok: true })
  );
  app.get('/api/admin/tenants/tenant-a/directory-auth/support/bundles/dasb_1/download', (c) =>
    c.json({ ok: true })
  );
  app.post('/api/admin/tenants/tenant-a/directory-auth/maintenance/cleanup', (c) =>
    c.json({ ok: true })
  );

  return app;
}

describe('declared admin route access', () => {
  it('fails closed when an admin route has no declaration', async () => {
    const app = createHarness([ADMIN_PERMISSIONS.ALL]);
    const response = await app.request('/api/admin/undocumented', { method: 'POST' });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(403);
    expect(body.error).toBe('insufficient_permissions');
  });

  it('enforces declared read/write/delete permissions before the handler runs', async () => {
    const reader = createHarness([ADMIN_PERMISSIONS.USERS_READ, ADMIN_PERMISSIONS.SETTINGS_READ]);
    const userWriter = createHarness([ADMIN_PERMISSIONS.USERS_DELETE]);
    const settingsWriter = createHarness([ADMIN_PERMISSIONS.SETTINGS_WRITE]);

    const readUsers = await reader.request('/api/admin/users');
    const deniedDeleteUser = await reader.request('/api/admin/users/user-1', {
      method: 'DELETE',
    });
    const allowedDeleteUser = await userWriter.request('/api/admin/users/user-1', {
      method: 'DELETE',
    });
    const deniedUpdateSettings = await reader.request('/api/admin/settings', {
      method: 'PUT',
    });
    const allowedUpdateSettings = await settingsWriter.request('/api/admin/settings', {
      method: 'PUT',
    });

    expect(readUsers.status).toBe(200);
    expect(deniedDeleteUser.status).toBe(403);
    expect(allowedDeleteUser.status).toBe(200);
    expect(deniedUpdateSettings.status).toBe(403);
    expect(allowedUpdateSettings.status).toBe(200);
  });

  it('keeps role assignment removal on roles write permission for existing admins', async () => {
    const app = createHarness([ADMIN_PERMISSIONS.ROLES_WRITE]);
    const response = await app.request('/api/admin/users/user-1/roles/assignment-1', {
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
  });

  it('enforces consent policy read and write permissions across policy controls', async () => {
    const reader = createHarness([ADMIN_PERMISSIONS.SETTINGS_READ]);
    const writer = createHarness([ADMIN_PERMISSIONS.SETTINGS_WRITE]);

    await expect(reader.request('/api/admin/consent-policies')).resolves.toMatchObject({
      status: 200,
    });
    await expect(reader.request('/api/admin/consent-policies/policy-1')).resolves.toMatchObject({
      status: 200,
    });
    await expect(reader.request('/api/admin/client-trust-policies')).resolves.toMatchObject({
      status: 200,
    });
    await expect(reader.request('/api/admin/sign-in-confirmation-policies')).resolves.toMatchObject(
      {
        status: 200,
      }
    );

    await expect(
      reader.request('/api/admin/consent-policies', { method: 'POST' })
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      reader.request('/api/admin/consent-policies/policy-1', { method: 'PUT' })
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      reader.request('/api/admin/consent-policies/policy-1', { method: 'DELETE' })
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      reader.request('/api/admin/consent-policies/policy-1/items', { method: 'PUT' })
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      reader.request('/api/admin/client-trust-policies', { method: 'PUT' })
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      reader.request('/api/admin/sign-in-confirmation-policies', { method: 'PUT' })
    ).resolves.toMatchObject({ status: 403 });

    await expect(
      writer.request('/api/admin/consent-policies', { method: 'POST' })
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      writer.request('/api/admin/consent-policies/policy-1', { method: 'PUT' })
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      writer.request('/api/admin/consent-policies/policy-1', { method: 'DELETE' })
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      writer.request('/api/admin/consent-policies/policy-1/items', { method: 'PUT' })
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      writer.request('/api/admin/client-trust-policies', { method: 'PUT' })
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      writer.request('/api/admin/sign-in-confirmation-policies', { method: 'PUT' })
    ).resolves.toMatchObject({ status: 200 });
  });

  it('keeps directory authentication tenant-scoped and permission-specific', async () => {
    const reader = createHarness([ADMIN_PERMISSIONS.DIRECTORY_AUTH_READ]);
    const writer = createHarness([ADMIN_PERMISSIONS.DIRECTORY_AUTH_WRITE]);
    const migrationWriter = createHarness([ADMIN_PERMISSIONS.DIRECTORY_AUTH_MIGRATION_WRITE]);
    const evidenceExporter = createHarness([
      ADMIN_PERMISSIONS.DIRECTORY_AUTH_EVIDENCE_EXPORT_CREATE,
    ]);
    const tenantAdmin = createHarness([], ['tenant_admin']);

    await expect(
      reader.request('/api/admin/tenants/tenant-a/directory-auth/overview')
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      reader.request('/api/admin/tenants/tenant-a/directory-connectors')
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      reader.request('/api/admin/tenants/tenant-a/directory-connectors', { method: 'PUT' })
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      writer.request('/api/admin/tenants/tenant-a/directory-connectors', { method: 'PUT' })
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      reader.request('/api/admin/tenants/tenant-a/directory-auth/migration/campaigns', {
        method: 'POST',
      })
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      migrationWriter.request('/api/admin/tenants/tenant-a/directory-auth/migration/campaigns', {
        method: 'POST',
      })
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      migrationWriter.request(
        '/api/admin/tenants/tenant-a/directory-auth/compliance/evidence-exports',
        {
          method: 'POST',
        }
      )
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      evidenceExporter.request(
        '/api/admin/tenants/tenant-a/directory-auth/compliance/evidence-exports',
        {
          method: 'POST',
        }
      )
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      reader.request(
        '/api/admin/tenants/tenant-a/directory-auth/compliance/evidence-exports/daex_1/download'
      )
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      evidenceExporter.request(
        '/api/admin/tenants/tenant-a/directory-auth/compliance/evidence-exports/daex_1/download'
      )
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      reader.request('/api/admin/tenants/tenant-a/directory-auth/support/bundles/dasb_1/download')
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      writer.request('/api/admin/tenants/tenant-a/directory-auth/support/bundles/dasb_1/download')
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      evidenceExporter.request('/api/admin/tenants/tenant-a/directory-auth/maintenance/cleanup', {
        method: 'POST',
      })
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      tenantAdmin.request('/api/admin/tenants/tenant-a/directory-auth/maintenance/cleanup', {
        method: 'POST',
      })
    ).resolves.toMatchObject({ status: 200 });
  });

  it('keeps the production admin route table covered by declared access rules', () => {
    const routes = managementApp.routes
      .filter((route) => ROUTE_METHODS.has(route.method))
      .filter((route) => route.path.startsWith('/api/admin'));

    const uncoveredRoutes = routes
      .filter((route) => !findAdminRouteAccessRule(route.method, route.path))
      .map((route) => `${route.method} ${route.path}`)
      .sort();

    expect(routes.length).toBeGreaterThan(300);
    expect(uncoveredRoutes).toEqual([]);
  });

  it('does not rely on a blanket /api/admin/* declaration', async () => {
    const hasBlanketRule = ADMIN_ROUTE_ACCESS_RULES.some((rule) => rule.pattern === '/api/admin/*');
    expect(hasBlanketRule).toBe(false);

    const app = new Hono<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>();
    app.use('*', async (c, next) => {
      c.set('adminAuth', {
        userId: 'admin-1',
        authMethod: 'machine_access_token',
        actorType: 'machine',
        tenantId: 'tenant-a',
        roles: [],
        permissions: [ADMIN_PERMISSIONS.ALL],
        hierarchyLevel: 0,
        mfaVerified: false,
      });
      await next();
    });
    app.use('/api/admin/*', enforceDeclaredAdminRouteAccess());
    app.get('/api/admin/new-control-plane', (c) => c.json({ ok: true }));

    const response = await app.request('/api/admin/new-control-plane');
    expect(response.status).toBe(403);
  });
});
