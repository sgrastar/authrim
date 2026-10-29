import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  ADMIN_ROLE_DEFINITIONS,
  ADMIN_ROLES,
  type AdminAuthContext,
  type Env,
} from '@authrim/ar-lib-core';
import {
  findAdminRouteAccessRule,
  registerDeclaredAdminRouteAccessMiddleware,
} from '../admin-route-access';

/**
 * What each standard Admin role may reach in the declared route access rules, with the permissions
 * the role really carries (read from the role definitions). Platform-wide handlers add their own
 * role check on top (`requireSystemAdmin`, `hasGlobalPlatformAuthority`), so a row marked as open
 * here for a rule that also names the platform roles is a first gate only.
 */

const [SUPER, TENANT_ADMIN, SUPPORT, VIEWER] = [
  ADMIN_ROLES.SUPER_ADMIN,
  ADMIN_ROLES.TENANT_ADMIN,
  ADMIN_ROLES.SUPPORT,
  ADMIN_ROLES.VIEWER,
];

function contextOf(roleName: string): AdminAuthContext {
  const role = ADMIN_ROLE_DEFINITIONS.find((definition) => definition.name === roleName)!;
  const isGlobal = roleName === SUPER;
  return {
    userId: `user-${roleName}`,
    authMethod: 'session',
    tenantId: 'tenant-a',
    roles: [roleName],
    permissions: [...role.permissions],
    hierarchyLevel: role.hierarchyLevel,
    mfaVerified: true,
    tenantScope: isGlobal ? ['*'] : ['tenant-a'],
    globalRoles: isGlobal ? [roleName] : [],
    globalPermissions: isGlobal ? [...role.permissions] : [],
    globalHierarchyLevel: isGlobal ? role.hierarchyLevel : 0,
  } as unknown as AdminAuthContext;
}

function harness(roleName: string) {
  const app = new Hono<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>();
  app.use('*', async (c, next) => {
    c.set('adminAuth', contextOf(roleName));
    await next();
  });
  registerDeclaredAdminRouteAccessMiddleware(app);
  app.all('/api/admin/*', (c) => c.json({ ok: true }));
  return app;
}

const apps = {
  [SUPER]: harness(SUPER),
  [TENANT_ADMIN]: harness(TENANT_ADMIN),
  [SUPPORT]: harness(SUPPORT),
  [VIEWER]: harness(VIEWER),
};

type Row = readonly [
  method: string,
  path: string,
  allowed: readonly [boolean, boolean, boolean, boolean],
];
const T = true;
const F = false;

/** [super_admin, tenant_admin, support, viewer] */
const MATRIX: readonly Row[] = [
  // People and sessions
  ['GET', '/api/admin/users', [T, T, T, T]],
  ['POST', '/api/admin/users', [T, T, F, F]],
  ['DELETE', '/api/admin/users/user-1', [T, T, F, F]],
  ['GET', '/api/admin/sessions', [T, T, T, T]],
  ['GET', '/api/admin/users/user-1/support-context', [T, T, T, T]],
  ['PUT', '/api/admin/users/user-1/support-context', [T, T, T, F]],
  ['GET', '/api/admin/users/user-1/legal-holds', [T, T, T, T]],
  ['POST', '/api/admin/users/user-1/legal-holds', [T, T, F, F]],
  // Apps, authorization and the tenant's settings
  ['GET', '/api/admin/clients', [T, T, T, T]],
  ['POST', '/api/admin/clients', [T, T, F, F]],
  ['GET', '/api/admin/custom-claims', [T, T, F, T]],
  ['PUT', '/api/admin/custom-claims/claim-1', [T, T, F, F]],
  ['GET', '/api/admin/rebac/relation-definitions', [T, T, F, T]],
  ['POST', '/api/admin/rebac/relation-definitions', [T, T, F, F]],
  ['GET', '/api/admin/security/signing-keys', [T, T, F, T]],
  ['POST', '/api/admin/security/signing-keys', [T, T, F, F]],
  ['GET', '/api/admin/ip-allowlist', [T, T, F, T]],
  ['POST', '/api/admin/ip-allowlist', [T, T, F, F]],
  ['GET', '/api/admin/webhooks', [T, T, F, T]],
  ['POST', '/api/admin/webhooks', [T, T, F, F]],
  // Audit and logs
  ['GET', '/api/admin/audit-logs', [T, T, T, T]],
  ['GET', '/api/admin/admin-audit-log', [T, T, F, T]],
  ['GET', '/api/admin/email-deliveries', [T, T, F, T]],
  // Support operations
  ['GET', '/api/admin/support-ops/registry', [T, T, T, T]],
  // Admins of the tenant
  ['GET', '/api/admin/admins', [T, T, F, F]],
  ['POST', '/api/admin/admins/admin-1/roles', [T, T, F, F]],
  ['GET', '/api/admin/admin-roles', [T, T, F, F]],
  ['POST', '/api/admin/admin-roles', [T, T, F, F]],
  // Platform-wide: only the super admin
  ['GET', '/api/admin/platform/control-plane/status', [T, F, F, F]],
  ['GET', '/api/admin/platform/read-replication', [T, F, F, F]],
  ['GET', '/api/admin/platform/tenant-domain-mappings', [T, F, F, F]],
  ['GET', '/api/admin/jobs/schedules', [T, F, F, F]],
  ['GET', '/api/admin/tenant-backups', [T, F, F, F]],
  ['POST', '/api/admin/tenant-backups/exports', [T, F, F, F]],
];

describe('the standard Admin roles against the declared route access rules', () => {
  for (const [method, path, allowed] of MATRIX) {
    it(`${method} ${path}`, async () => {
      expect(findAdminRouteAccessRule(method, path), 'a declared rule').not.toBeNull();
      const roles = [SUPER, TENANT_ADMIN, SUPPORT, VIEWER] as const;
      const statuses = await Promise.all(
        roles.map(async (role) => (await apps[role].request(path, { method })).status)
      );
      expect(statuses.map((status) => status === 200)).toEqual([...allowed]);
      for (const status of statuses) expect([200, 403]).toContain(status);
    });
  }

  it('reaches no undeclared route with any role, the super admin included', async () => {
    for (const role of [SUPER, TENANT_ADMIN, SUPPORT, VIEWER] as const) {
      const response = await apps[role].request('/api/admin/not-declared', { method: 'GET' });
      expect(response.status).toBe(403);
    }
  });

  it('does not let the retired role names open the rules that name roles', async () => {
    for (const retired of ['super_admin', 'system_admin', 'admin', 'tenant_admin']) {
      const app = new Hono<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>();
      app.use('*', async (c, next) => {
        c.set('adminAuth', {
          ...contextOf(VIEWER),
          roles: [retired],
          permissions: [],
          globalRoles: [retired],
          tenantScope: ['*'],
        } as unknown as AdminAuthContext);
        await next();
      });
      registerDeclaredAdminRouteAccessMiddleware(app);
      app.all('/api/admin/*', (c) => c.json({ ok: true }));
      for (const path of ['/api/admin/jobs/schedules', '/api/admin/rebac/relation-definitions']) {
        expect((await app.request(path)).status, `${retired} ${path}`).toBe(403);
      }
    }
  });
});
