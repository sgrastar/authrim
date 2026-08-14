import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { requireInternalVersionManagerAuthority } from '../internal-version-access';

function createApp(authContext: AdminAuthContext | undefined, permission: string) {
  const app = new Hono<{
    Bindings: Env;
    Variables: { adminAuth?: AdminAuthContext };
  }>();

  app.use('*', async (c, next) => {
    if (authContext) c.set('adminAuth', authContext);
    await next();
  });
  app.get('/internal', requireInternalVersionManagerAuthority(permission), (c) =>
    c.json({ ok: true })
  );
  return app;
}

function humanAuth(overrides: Partial<AdminAuthContext> = {}): AdminAuthContext {
  return {
    userId: 'admin-1',
    authMethod: 'session',
    tenantId: 'tenant-a',
    roles: ['system_admin'],
    permissions: [ADMIN_PERMISSIONS.CONTROL_PLANE_READ],
    hierarchyLevel: 100,
    mfaVerified: true,
    tenantScope: ['*'],
    ...overrides,
  };
}

describe('internal version manager authority', () => {
  it('rejects a tenant viewer even when it is given the named permission', async () => {
    const app = createApp(
      humanAuth({ roles: ['viewer'], tenantScope: ['tenant-a'] }),
      ADMIN_PERMISSIONS.CONTROL_PLANE_READ
    );

    expect((await app.request('/internal')).status).toBe(403);
  });

  it('rejects a tenant-scoped role named system_admin', async () => {
    const app = createApp(
      humanAuth({ tenantScope: ['tenant-a'] }),
      ADMIN_PERMISSIONS.CONTROL_PLANE_READ
    );

    expect((await app.request('/internal')).status).toBe(403);
  });

  it('rejects a global platform admin without the operation permission', async () => {
    const app = createApp(humanAuth({ permissions: [] }), ADMIN_PERMISSIONS.CONTROL_PLANE_READ);

    expect((await app.request('/internal')).status).toBe(403);
  });

  it('allows a global platform admin with the operation permission', async () => {
    const app = createApp(humanAuth(), ADMIN_PERMISSIONS.CONTROL_PLANE_READ);

    expect((await app.request('/internal')).status).toBe(200);
  });

  it('allows only the setup machine identity with the operation permission', async () => {
    const setupMachine = humanAuth({
      authMethod: 'machine_access_token',
      actorType: 'machine',
      roles: [],
      tenantScope: ['tenant-a'],
      principalType: 'setup_tool',
      clientId: 'authrim-setup',
    });
    const otherMachine = { ...setupMachine, clientId: 'tenant-automation' };

    expect(
      (await createApp(setupMachine, ADMIN_PERMISSIONS.CONTROL_PLANE_READ).request('/internal'))
        .status
    ).toBe(200);
    expect(
      (await createApp(otherMachine, ADMIN_PERMISSIONS.CONTROL_PLANE_READ).request('/internal'))
        .status
    ).toBe(403);
  });
});
