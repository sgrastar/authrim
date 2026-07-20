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
  app.post('/api/admin/users/user-1/totp/reset', (c) => c.json({ ok: true }));
  app.delete('/api/admin/users/user-1/roles/assignment-1', (c) => c.json({ ok: true }));
  app.put('/api/admin/settings', (c) => c.json({ ok: true }));
  app.get('/api/admin/settings/agent', (c) => c.json({ ok: true }));
  app.patch('/api/admin/tenants/tenant-a/settings/assurance', (c) => c.json({ ok: true }));
  app.patch('/api/admin/tenants/tenant-a/settings/security', (c) => c.json({ ok: true }));
  app.patch('/api/admin/tenants/tenant-a/settings/tokens', (c) => c.json({ ok: true }));
  app.patch('/api/admin/tenants/tenant-a/settings/oauth', (c) => c.json({ ok: true }));
  app.patch('/api/admin/tenants/tenant-a/settings/session', (c) => c.json({ ok: true }));
  app.patch('/api/admin/tenants/tenant-a/settings/login-ui', (c) => c.json({ ok: true }));
  app.post('/api/admin/tenants/tenant-a/clone', (c) => c.json({ ok: true }));
  app.post('/api/admin/clients', (c) => c.json({ ok: true }));
  app.put('/api/admin/clients/client-1', (c) => c.json({ ok: true }));
  app.post('/api/admin/clients/client-1/regenerate-secret', (c) => c.json({ ok: true }));
  app.get('/api/admin/admin-invitations', (c) => c.json({ ok: true }));
  app.post('/api/admin/admin-invitations', (c) => c.json({ ok: true }));
  app.post('/api/admin/admin-invitations/invitation-1/resend', (c) => c.json({ ok: true }));
  app.delete('/api/admin/admin-invitations/invitation-1', (c) => c.json({ ok: true }));
  app.post('/api/admin/policies/simulate', (c) => c.json({ ok: true }));
  app.post('/api/admin/flows/flow-1/validate', (c) => c.json({ ok: true }));
  app.post('/api/admin/flows/flow-1/compile', (c) => c.json({ ok: true }));
  app.post('/api/admin/flows/flow-1/publish', (c) => c.json({ ok: true }));
  app.get('/api/admin/agent-grants/eligible-permissions', (c) => c.json({ ok: true }));
  app.post('/api/admin/agent-login-handoffs/alh_test/approve', (c) => c.json({ ok: true }));
  app.post('/api/admin/undocumented', (c) => c.json({ ok: true }));
  app.get('/api/admin/consent-policies', (c) => c.json({ ok: true }));
  app.post('/api/admin/consent-policies', (c) => c.json({ ok: true }));
  app.get('/api/admin/consent-policies/policy-1', (c) => c.json({ ok: true }));
  app.put('/api/admin/consent-policies/policy-1', (c) => c.json({ ok: true }));
  app.delete('/api/admin/consent-policies/policy-1', (c) => c.json({ ok: true }));
  app.put('/api/admin/consent-policies/policy-1/items', (c) => c.json({ ok: true }));
  app.get('/api/admin/consent-gate-policy-bindings', (c) => c.json({ ok: true }));
  app.post('/api/admin/consent-gate-policy-bindings', (c) => c.json({ ok: true }));
  app.post('/api/admin/consent-gate-policy-bindings/preview', (c) => c.json({ ok: true }));
  app.get('/api/admin/consent-gate-policy-bindings/binding-1', (c) => c.json({ ok: true }));
  app.put('/api/admin/consent-gate-policy-bindings/binding-1', (c) => c.json({ ok: true }));
  app.delete('/api/admin/consent-gate-policy-bindings/binding-1', (c) => c.json({ ok: true }));
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

  it('requires Admin user read access for invitation reads and both write permissions for changes', async () => {
    const reader = createHarness([ADMIN_PERMISSIONS.ADMIN_USERS_READ]);
    const partialWriter = createHarness([ADMIN_PERMISSIONS.ADMIN_USERS_WRITE]);
    const writer = createHarness([
      ADMIN_PERMISSIONS.ADMIN_USERS_WRITE,
      ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE,
    ]);

    await expect(reader.request('/api/admin/admin-invitations')).resolves.toMatchObject({
      status: 200,
    });
    await expect(
      reader.request('/api/admin/admin-invitations', { method: 'POST' })
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      partialWriter.request('/api/admin/admin-invitations', { method: 'POST' })
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      writer.request('/api/admin/admin-invitations', { method: 'POST' })
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      writer.request('/api/admin/admin-invitations/invitation-1/resend', { method: 'POST' })
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      writer.request('/api/admin/admin-invitations/invitation-1', { method: 'DELETE' })
    ).resolves.toMatchObject({ status: 200 });
  });

  it('enforces declared read/write/delete permissions before the handler runs', async () => {
    const reader = createHarness([ADMIN_PERMISSIONS.USERS_READ, ADMIN_PERMISSIONS.SETTINGS_READ]);
    const userWriter = createHarness([ADMIN_PERMISSIONS.USERS_DELETE]);
    const userUpdater = createHarness([ADMIN_PERMISSIONS.USERS_WRITE]);
    const settingsWriter = createHarness([ADMIN_PERMISSIONS.SETTINGS_WRITE]);

    const readUsers = await reader.request('/api/admin/users');
    const deniedDeleteUser = await reader.request('/api/admin/users/user-1', {
      method: 'DELETE',
    });
    const allowedDeleteUser = await userWriter.request('/api/admin/users/user-1', {
      method: 'DELETE',
    });
    const deniedTotpReset = await reader.request('/api/admin/users/user-1/totp/reset', {
      method: 'POST',
    });
    const allowedTotpReset = await userUpdater.request('/api/admin/users/user-1/totp/reset', {
      method: 'POST',
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
    expect(deniedTotpReset.status).toBe(403);
    expect(allowedTotpReset.status).toBe(200);
    expect(deniedUpdateSettings.status).toBe(403);
    expect(allowedUpdateSettings.status).toBe(200);
  });

  it('uses the dedicated Agent settings permission ahead of the generic settings wildcard', async () => {
    expect(findAdminRouteAccessRule('GET', '/api/admin/settings/agent')?.permissions).toEqual([
      ADMIN_PERMISSIONS.AGENT_SETTINGS_READ,
    ]);

    const agentSettingsReader = createHarness([ADMIN_PERMISSIONS.AGENT_SETTINGS_READ]);
    const genericSettingsReader = createHarness([ADMIN_PERMISSIONS.SETTINGS_READ]);
    expect((await agentSettingsReader.request('/api/admin/settings/agent')).status).toBe(200);
    expect((await genericSettingsReader.request('/api/admin/settings/agent')).status).toBe(403);
  });

  it('requires grant write permission for the grant eligibility helper', async () => {
    const reader = createHarness([ADMIN_PERMISSIONS.AGENT_GRANTS_READ]);
    const writer = createHarness([ADMIN_PERMISSIONS.AGENT_GRANTS_WRITE]);

    await expect(
      reader.request('/api/admin/agent-grants/eligible-permissions')
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      writer.request('/api/admin/agent-grants/eligible-permissions')
    ).resolves.toMatchObject({ status: 200 });

    expect(
      findAdminRouteAccessRule('GET', '/api/admin/agent-grants/eligible-permissions')?.permissions
    ).toEqual([ADMIN_PERMISSIONS.AGENT_GRANTS_WRITE]);
  });

  it('requires Agent use permission for central login-handoff approval', async () => {
    const reader = createHarness([ADMIN_PERMISSIONS.AGENT_GRANTS_READ]);
    const agentUser = createHarness([ADMIN_PERMISSIONS.AGENT_USE]);
    const path = '/api/admin/agent-login-handoffs/alh_test/approve';

    await expect(reader.request(path, { method: 'POST' })).resolves.toMatchObject({ status: 403 });
    await expect(agentUser.request(path, { method: 'POST' })).resolves.toMatchObject({
      status: 200,
    });
    expect(findAdminRouteAccessRule('POST', path)?.permissions).toEqual([
      ADMIN_PERMISSIONS.AGENT_USE,
    ]);
  });

  it('uses category-specific permissions for Agent-exposed tenant setting writes', async () => {
    const securityWriter = createHarness([ADMIN_PERMISSIONS.SETTINGS_SECURITY_UPDATE]);

    await expect(
      securityWriter.request('/api/admin/tenants/tenant-a/settings/security', { method: 'PATCH' })
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      securityWriter.request('/api/admin/tenants/tenant-a/settings/assurance', {
        method: 'PATCH',
      })
    ).resolves.toMatchObject({ status: 403 });
    expect(
      findAdminRouteAccessRule('PATCH', '/api/admin/tenants/tenant-a/settings/tokens')?.permissions
    ).toEqual([ADMIN_PERMISSIONS.SETTINGS_TOKEN_EXCHANGE_UPDATE]);
    expect(
      findAdminRouteAccessRule('PATCH', '/api/admin/tenants/tenant-a/settings/oauth')?.permissions
    ).toEqual([ADMIN_PERMISSIONS.SETTINGS_OAUTH_UPDATE]);
    expect(
      findAdminRouteAccessRule('PATCH', '/api/admin/tenants/tenant-a/settings/session')?.permissions
    ).toEqual([ADMIN_PERMISSIONS.SETTINGS_SESSION_UPDATE]);
    expect(
      findAdminRouteAccessRule('PATCH', '/api/admin/tenants/tenant-a/settings/login-ui')
        ?.permissions
    ).toEqual([ADMIN_PERMISSIONS.SETTINGS_LOGIN_UI_UPDATE]);
  });

  it('keeps tenant cloning on the platform-admin tenant administration boundary', async () => {
    const tenantWriter = createHarness([ADMIN_PERMISSIONS.SETTINGS_WRITE], ['tenant_admin']);
    const lifecycleWriter = createHarness(
      [ADMIN_PERMISSIONS.TENANT_LIFECYCLE_STANDARD],
      ['system_admin']
    );

    await expect(
      tenantWriter.request('/api/admin/tenants/tenant-a/clone', { method: 'POST' })
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      lifecycleWriter.request('/api/admin/tenants/tenant-a/clone', { method: 'POST' })
    ).resolves.toMatchObject({ status: 200 });

    const rule = findAdminRouteAccessRule('POST', '/api/admin/tenants/tenant-a/clone');
    expect(rule?.permissions).toEqual([ADMIN_PERMISSIONS.TENANT_LIFECYCLE_STANDARD]);
    expect(rule?.roles).toBeUndefined();
  });

  it('uses operation-specific client, policy simulation, and Flow permissions', async () => {
    const clientUpdater = createHarness([ADMIN_PERMISSIONS.CLIENTS_UPDATE]);
    const simulator = createHarness([ADMIN_PERMISSIONS.POLICY_SIMULATE]);
    const flowValidator = createHarness([ADMIN_PERMISSIONS.FLOWS_VALIDATE]);
    const flowPublisher = createHarness([ADMIN_PERMISSIONS.FLOWS_PUBLISH]);

    expect(findAdminRouteAccessRule('POST', '/api/admin/clients')?.permissions).toEqual([
      ADMIN_PERMISSIONS.CLIENTS_CREATE,
    ]);

    await expect(
      clientUpdater.request('/api/admin/clients/client-1', { method: 'PUT' })
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      clientUpdater.request('/api/admin/clients', { method: 'POST' })
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      clientUpdater.request('/api/admin/clients/client-1/regenerate-secret', { method: 'POST' })
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      simulator.request('/api/admin/policies/simulate', { method: 'POST' })
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      flowValidator.request('/api/admin/flows/flow-1/validate', { method: 'POST' })
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      flowValidator.request('/api/admin/flows/flow-1/publish', { method: 'POST' })
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      flowPublisher.request('/api/admin/flows/flow-1/publish', { method: 'POST' })
    ).resolves.toMatchObject({ status: 200 });
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
    await expect(reader.request('/api/admin/consent-gate-policy-bindings')).resolves.toMatchObject({
      status: 200,
    });
    await expect(
      reader.request('/api/admin/consent-gate-policy-bindings/binding-1')
    ).resolves.toMatchObject({ status: 200 });
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
      reader.request('/api/admin/consent-gate-policy-bindings', { method: 'POST' })
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      reader.request('/api/admin/consent-gate-policy-bindings/preview', { method: 'POST' })
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      reader.request('/api/admin/consent-gate-policy-bindings/binding-1', { method: 'DELETE' })
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
      writer.request('/api/admin/consent-gate-policy-bindings', { method: 'POST' })
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      writer.request('/api/admin/consent-gate-policy-bindings/preview', { method: 'POST' })
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      writer.request('/api/admin/consent-gate-policy-bindings/binding-1', { method: 'DELETE' })
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
