import { describe, expect, it, vi } from 'vitest';
import { adminAuthMiddleware, type AdminAuthContext } from '@authrim/ar-lib-core';
import { enforceDeclaredAdminRouteAccess } from '../admin-route-access';
import settingsV2 from '../routes/settings-v2';
import { canAccessTenant } from '../routes/settings-v2/settings-authorization';
import {
  GLOBAL_SUPER_ADMIN,
  GLOBAL_VIEWER_TENANT_SUPER_ADMIN,
  TENANT,
  TENANT_SUPER_ADMIN,
  setupApp,
  signIn,
} from './helpers/admin-authority-fixture';

/**
 * A path that names a tenant (`/tenants/{id}/settings/...`) is judged on the roles the caller holds
 * for that tenant. `adminAuth.roles` adds up the global assignments and the ones for the tenant the
 * request arrived on, so for any other tenant only the global assignments count: a ar_super_admin for
 * one tenant, or a viewer for every tenant next to a ar_super_admin for one, must not reach another.
 *
 * These run the real admin-auth middleware, route access and Settings API on the real Admin schema.
 * A PATCH without `ifMatch` answers 400 once it is authorized, so 403 vs 400 tells the verdict.
 */

const OTHER = 'tenant-b';

function setup() {
  return setupApp(
    (app) => {
      app.use(
        '/api/admin/*',
        adminAuthMiddleware({ plane: 'tenant' }),
        enforceDeclaredAdminRouteAccess()
      );
      app.route('/api/admin', settingsV2);
    },
    {
      BASE_DOMAIN: 'example.com',
      RATE_LIMITER: {
        idFromName: vi.fn().mockReturnValue('rate-limit-id'),
        get: vi.fn().mockReturnValue({
          incrementRpc: vi.fn().mockResolvedValue({
            allowed: true,
            current: 1,
            limit: 100,
            resetAt: Math.floor(Date.now() / 1000) + 60,
          }),
        }),
      },
    }
  );
}

const settingsPath = (tenant: string, category = 'session') =>
  `/api/admin/tenants/${tenant}/settings/${category}`;

describe('tenant settings of another tenant', () => {
  it('refuses a ar_super_admin of one tenant on the settings of another tenant', async () => {
    const context = setup();
    const admin = signIn(context.db, TENANT_SUPER_ADMIN);

    const read = await context.call(admin.cookie, 'GET', settingsPath(OTHER));
    const write = await context.call(admin.cookie, 'PATCH', settingsPath(OTHER), { set: {} });

    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
  });

  it('lets that ar_super_admin through to the settings of its own tenant', async () => {
    const context = setup();
    const admin = signIn(context.db, TENANT_SUPER_ADMIN);

    const write = await context.call(admin.cookie, 'PATCH', settingsPath(TENANT), { set: {} });
    const read = await context.call(admin.cookie, 'GET', settingsPath(TENANT));

    // Authorized: the missing ifMatch is what stops the write.
    expect(write.status).toBe(400);
    expect(read.status).not.toBe(403);
  });

  it('refuses a global viewer who is a ar_super_admin of one tenant on editing another tenant', async () => {
    const context = setup();
    const admin = signIn(context.db, GLOBAL_VIEWER_TENANT_SUPER_ADMIN);

    const otherWrite = await context.call(admin.cookie, 'PATCH', settingsPath(OTHER), {
      set: {},
    });
    const ownWrite = await context.call(admin.cookie, 'PATCH', settingsPath(TENANT), {
      set: {},
    });

    expect(otherWrite.status).toBe(403);
    // The tenant it is a ar_super_admin of is its own.
    expect(ownWrite.status).toBe(400);
  });

  it('refuses a viewer of one tenant on another tenant, and lets a global viewer read it', async () => {
    const context = setup();
    const tenantViewer = signIn(context.db, [{ role: 'role_ar_viewer', scope: 'tenant' }]);
    const globalViewer = signIn(context.db, [{ role: 'role_ar_viewer', scope: 'global' }]);

    const refused = await context.call(tenantViewer.cookie, 'GET', settingsPath(OTHER));
    const allowed = await context.call(globalViewer.cookie, 'GET', settingsPath(OTHER));
    const ownRead = await context.call(tenantViewer.cookie, 'GET', settingsPath(TENANT));

    expect(refused.status).toBe(403);
    expect(allowed.status).not.toBe(403);
    expect(ownRead.status).not.toBe(403);
  });

  it('lets a global ar_super_admin through to its own tenant and to another', async () => {
    const context = setup();
    const admin = signIn(context.db, GLOBAL_SUPER_ADMIN);

    const own = await context.call(admin.cookie, 'PATCH', settingsPath(TENANT), { set: {} });
    const other = await context.call(admin.cookie, 'PATCH', settingsPath(OTHER), { set: {} });
    const read = await context.call(admin.cookie, 'GET', settingsPath(OTHER));

    expect(own.status).toBe(400);
    expect(other.status).toBe(400);
    expect(read.status).not.toBe(403);
  });
});

describe('settings history of the request tenant', () => {
  it('stays with the tenant the request arrived on', async () => {
    const context = setup();
    const admin = signIn(context.db, TENANT_SUPER_ADMIN);

    // The history routes carry no tenant in the path; they act on the request's tenant, whose
    // roles the caller holds.
    const history = await context.call(admin.cookie, 'GET', '/api/admin/settings/oauth/history');
    expect(history.status).not.toBe(403);
  });
});

describe('canAccessTenant on what the real middleware builds', () => {
  async function authOf(assignments: Parameters<typeof signIn>[1]) {
    const context = setup();
    const admin = signIn(context.db, assignments);
    const probe = await context.call(admin.cookie, 'GET', `/probe/${TENANT}`);
    expect(probe.status).toBe(200);
    return probe.json as unknown as AdminAuthContext;
  }

  it('reaches another tenant only through a global assignment', async () => {
    const tenantSuperAdmin = await authOf(TENANT_SUPER_ADMIN);
    const globalSuperAdmin = await authOf(GLOBAL_SUPER_ADMIN);
    const globalViewerTenantSuperAdmin = await authOf(GLOBAL_VIEWER_TENANT_SUPER_ADMIN);
    const tenantViewer = await authOf([{ role: 'role_ar_viewer', scope: 'tenant' }]);

    expect(canAccessTenant(tenantSuperAdmin, TENANT)).toBe(true);
    expect(canAccessTenant(tenantSuperAdmin, OTHER)).toBe(false);
    expect(canAccessTenant(globalSuperAdmin, OTHER)).toBe(true);
    // The global part is only a viewer: it may look at another tenant, but the ar_super_admin is not
    // one there.
    expect(canAccessTenant(globalViewerTenantSuperAdmin, TENANT)).toBe(true);
    expect(canAccessTenant(tenantViewer, TENANT)).toBe(true);
    expect(canAccessTenant(tenantViewer, OTHER)).toBe(false);
  });

  it('ties a machine token to the tenant the request arrived on, as before', () => {
    const machine = (tenantScope: string[]) =>
      ({
        userId: 'm',
        authMethod: 'machine_access_token',
        actorType: 'machine',
        roles: [],
        tenantId: TENANT,
        tenantScope,
      }) as AdminAuthContext;

    expect(canAccessTenant(machine([TENANT]), TENANT)).toBe(true);
    expect(canAccessTenant(machine(['*']), TENANT)).toBe(true);
    expect(canAccessTenant(machine(['*']), OTHER)).toBe(false);
    expect(canAccessTenant(machine([TENANT]), OTHER)).toBe(false);
  });
});
