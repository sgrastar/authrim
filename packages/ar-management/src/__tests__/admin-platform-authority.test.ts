import { describe, expect, it } from 'vitest';
import {
  adminAuthMiddleware,
  requireSystemAdmin,
  type AdminAuthContext,
} from '@authrim/ar-lib-core';
import { readReplicationRouter } from '../routes/admin-management/read-replication';
import { controlPlaneOperationsRouter } from '../routes/admin-management/control-plane-operations';
import { actorReachesTenants } from '../routes/admin-management/tenant-reach';
import {
  canAccessTenantResource,
  hasPlatformTenantManagementAuthority,
} from '../admin-tenant-access';
import { requireInternalVersionManagerAuthority } from '../internal-version-access';
import { enforceDeclaredAdminRouteAccess } from '../admin-route-access';
import {
  GLOBAL_SUPER_ADMIN,
  GLOBAL_VIEWER_TENANT_SUPER_ADMIN,
  TENANT,
  TENANT_SUPER_ADMIN,
  insertRole,
  setupApp,
  signIn,
  type Assignment,
} from './helpers/admin-authority-fixture';

/**
 * Operations that take effect across tenants (the control plane, read replication, the Worker
 * versions, managing tenants) ask for a platform role or the wildcard held through a global
 * assignment. `roles` and `permissions` add up every assignment that applies to the request,
 * so a platform role or the wildcard held for one tenant is in them too.
 *
 * These run the real admin-auth middleware on the real Admin schema.
 */

function setup() {
  return setupApp((app) => {
    app.route('/api/admin/platform/read-replication', readReplicationRouter);
    app.route('/api/admin/platform/control-plane', controlPlaneOperationsRouter);
    // Admin sign-in is by Admin role name; this guard asks for a platform role on top of it.
    app.get(
      '/guarded/system-admin',
      adminAuthMiddleware({ plane: 'tenant' }),
      requireSystemAdmin(),
      (c) => c.json({ ok: true })
    );
    app.get(
      '/guarded/versions',
      adminAuthMiddleware({ plane: 'tenant' }),
      requireInternalVersionManagerAuthority('admin:control_plane:read'),
      (c) => c.json({ ok: true })
    );
    app.get(
      '/guarded/tenants',
      adminAuthMiddleware({ plane: 'tenant' }),
      (c, next) => {
        const auth = (c as unknown as { get(key: string): AdminAuthContext }).get('adminAuth');
        // The tenant inventory and its mutations ask for platform authority; a tenant's own
        // resources for the tenant or the platform.
        const platform = hasPlatformTenantManagementAuthority(auth);
        const own = canAccessTenantResource(auth, TENANT, TENANT);
        const other = canAccessTenantResource(auth, 'tenant-b', TENANT);
        return platform || own || other ? c.json({ platform, own, other }) : next();
      },
      (c) => c.json({ platform: false, own: false, other: false })
    );
  });
}

type Kind =
  | 'global super_admin'
  | 'tenant-limited super_admin'
  | 'global viewer + tenant super_admin'
  | 'global viewer'
  | 'tenant viewer';

const KINDS: Record<Kind, Assignment[]> = {
  'global super_admin': GLOBAL_SUPER_ADMIN,
  'tenant-limited super_admin': TENANT_SUPER_ADMIN,
  'global viewer + tenant super_admin': GLOBAL_VIEWER_TENANT_SUPER_ADMIN,
  'global viewer': [{ role: 'role_viewer', scope: 'global' }],
  'tenant viewer': [{ role: 'role_viewer', scope: 'tenant' }],
};

describe('platform-wide routes', () => {
  it.each([
    ['global super_admin', 'allowed'],
    ['tenant-limited super_admin', 'denied'],
    ['global viewer + tenant super_admin', 'denied'],
    ['global viewer', 'denied'],
    ['tenant viewer', 'denied'],
  ] as Array<[Kind, 'allowed' | 'denied']>)(
    'read replication and the control plane for a %s are %s',
    async (kind, outcome) => {
      const context = setup();
      const actor = signIn(context.db, KINDS[kind]);

      const replication = await context.call(
        actor.cookie,
        'GET',
        '/api/admin/platform/read-replication'
      );
      const topology = await context.call(
        actor.cookie,
        'GET',
        '/api/admin/platform/control-plane/storage-topology'
      );

      // Past the authority check the routes find no Control binding to ask: 503, not 403.
      const expected = outcome === 'allowed' ? 503 : 403;
      expect(replication.status).toBe(expected);
      expect(topology.status).toBe(expected);
    }
  );

  it.each([
    ['global super_admin', 200],
    ['tenant-limited super_admin', 403],
    ['global viewer + tenant super_admin', 403],
  ] as Array<[Kind, number]>)(
    'the system-admin guard and the Worker version guard for a %s answer %s',
    async (kind, status) => {
      const context = setup();
      const actor = signIn(context.db, KINDS[kind]);

      const guard = await context.call(actor.cookie, 'GET', '/guarded/system-admin');
      const versions = await context.call(actor.cookie, 'GET', '/guarded/versions');

      expect(guard.status).toBe(status);
      expect(versions.status).toBe(status);
    }
  );

  it('does not let a custom role named like a platform role be one: only its global assignment counts', async () => {
    const context = setup();
    // A legacy custom role with a platform name, held for the tenant, next to a viewer.
    insertRole(context.db, {
      id: 'role_named_system_admin',
      name: 'system_admin',
      permissions: ['admin:control_plane:read'],
      hierarchy: 10,
    });
    const local = signIn(context.db, [
      { role: 'role_viewer', scope: 'tenant' },
      { role: 'role_named_system_admin', scope: 'tenant' },
    ]);
    const global = signIn(context.db, [
      { role: 'role_viewer', scope: 'tenant' },
      { role: 'role_named_system_admin', scope: 'global' },
    ]);

    const localGuard = await context.call(local.cookie, 'GET', '/guarded/system-admin');
    const globalGuard = await context.call(global.cookie, 'GET', '/guarded/system-admin');

    expect(localGuard.status).toBe(403);
    expect(globalGuard.status).toBe(200);
  });
});

describe('managing tenants', () => {
  it('is platform authority for a global super_admin, and for no one who holds the wildcard or the role for a tenant', async () => {
    const results: Record<string, unknown> = {};
    for (const kind of Object.keys(KINDS) as Kind[]) {
      const context = setup();
      const actor = signIn(context.db, KINDS[kind]);
      results[kind] = (await context.call(actor.cookie, 'GET', '/guarded/tenants')).json;
    }

    expect(results).toEqual({
      'global super_admin': { platform: true, own: true, other: true },
      'tenant-limited super_admin': { platform: false, own: true, other: false },
      'global viewer + tenant super_admin': { platform: false, own: true, other: false },
      // Reaching a tenant's resources with what the request's tenant gives is allowed; the
      // permission to do something with them is the route's own.
      'global viewer': { platform: false, own: true, other: false },
      'tenant viewer': { platform: false, own: true, other: false },
    });
  });

  it('asks for the named permission from a global assignment', () => {
    const base = {
      userId: 'admin',
      authMethod: 'session',
      roles: [],
      tenantScope: ['*'],
    } satisfies AdminAuthContext;

    expect(
      hasPlatformTenantManagementAuthority(
        { ...base, permissions: ['admin:tenants:lifecycle:standard'], globalPermissions: [] },
        'admin:tenants:lifecycle:standard'
      )
    ).toBe(false);
    expect(
      hasPlatformTenantManagementAuthority(
        {
          ...base,
          permissions: ['admin:tenants:lifecycle:standard'],
          globalPermissions: ['admin:tenants:lifecycle:standard'],
        },
        'admin:tenants:lifecycle:standard'
      )
    ).toBe(true);
    // The platform role of the same Admin, held for the tenant only.
    expect(
      hasPlatformTenantManagementAuthority({
        ...base,
        tenantScope: ['*'],
        roles: ['super_admin'],
        globalRoles: ['viewer'],
      })
    ).toBe(false);
  });

  it('keeps a machine token with a global scope, whose permissions are all global ones', () => {
    expect(
      hasPlatformTenantManagementAuthority({
        userId: 'machine',
        authMethod: 'machine_access_token',
        roles: [],
        tenantScope: ['*'],
        permissions: ['admin:settings:write'],
        globalPermissions: ['admin:settings:write'],
      })
    ).toBe(true);
  });
});

describe('declared route access for the platform roles', () => {
  it('lets a platform role through a rule that names it only when the role is global', async () => {
    // The role has no permission of its own, so the role name is all the rule can go by.
    const run = async (scope: 'tenant' | 'global') => {
      const context = setupApp((app) => {
        app.use(
          '/api/admin/*',
          adminAuthMiddleware({ plane: 'tenant', requireRoles: ['system_admin', 'viewer'] }),
          enforceDeclaredAdminRouteAccess()
        );
        app.get('/api/admin/tenants', (c) => c.json({ ok: true }));
      });
      insertRole(context.db, {
        id: 'role_named_system_admin',
        name: 'system_admin',
        permissions: [],
        hierarchy: 10,
      });
      const actor = signIn(context.db, [{ role: 'role_named_system_admin', scope }]);
      return (await context.call(actor.cookie, 'GET', '/api/admin/tenants')).status;
    };

    expect(await run('tenant')).toBe(403);
    expect(await run('global')).toBe(200);
  });
});

describe('acting on tenants other than the request tenant', () => {
  const auth = (overrides: Partial<AdminAuthContext>): AdminAuthContext => ({
    userId: 'admin',
    authMethod: 'session',
    roles: [],
    permissions: ['admin:bulk_plans:create'],
    ...overrides,
  });

  it('reaches only the listed tenants without a global scope', () => {
    const a = auth({ tenantScope: ['tenant-a'] });
    expect(actorReachesTenants(a, 'tenant-a', ['tenant-a'], 'admin:bulk_plans:create')).toBe(true);
    expect(
      actorReachesTenants(a, 'tenant-a', ['tenant-a', 'tenant-b'], 'admin:bulk_plans:create')
    ).toBe(false);
  });

  it('reaches other tenants with a global scope only by the permission from a global assignment', () => {
    const mixed = auth({ tenantScope: ['*'], globalPermissions: ['admin:users:read'] });
    const global = auth({ tenantScope: ['*'], globalPermissions: ['admin:bulk_plans:create'] });

    expect(actorReachesTenants(mixed, 'tenant-a', ['tenant-b'], 'admin:bulk_plans:create')).toBe(
      false
    );
    expect(actorReachesTenants(mixed, 'tenant-a', ['tenant-a'], 'admin:bulk_plans:create')).toBe(
      true
    );
    expect(
      actorReachesTenants(global, 'tenant-a', ['tenant-a', 'tenant-b'], 'admin:bulk_plans:create')
    ).toBe(true);
  });
});
