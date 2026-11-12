/**
 * The resource permission layer chooses the permission from the path. It judges the path the
 * router dispatches on, so an escaped spelling (`/%61nonymize`) cannot ask for a weaker one.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { registerAdminResourcePermissionMiddleware } from '../admin-resource-permissions';

function harness(permissions: string[]) {
  const app = new Hono<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>();
  app.use('*', async (c, next) => {
    c.set('adminAuth', {
      userId: 'admin-1',
      authMethod: 'session',
      tenantId: 'tenant-a',
      roles: ['ar_tenant_admin'],
      permissions,
      tenantScope: ['tenant-a'],
      hierarchyLevel: 0,
      mfaVerified: false,
    } as AdminAuthContext);
    await next();
  });
  registerAdminResourcePermissionMiddleware(app);
  const ok = (c: { json: (body: unknown) => Response }) => c.json({ ok: true });
  app.all('/api/admin/users/:id/anonymize', ok);
  app.all('/api/admin/users/:id/pii', ok);
  app.all('/api/admin/settings/agent', ok);
  app.all('/api/admin/external-token-refresh/run', ok);
  app.all('/api/admin/credential-profiles/:id/offers', ok);
  return (method: string, path: string) => app.request(path, { method }, {});
}

const P = ADMIN_PERMISSIONS;
// [method, plain path, escaped path, the weaker permission, the permission the route asks for]
const cases: Array<[string, string, string, string, string]> = [
  [
    'POST',
    '/api/admin/users/x/anonymize',
    '/api/admin/users/x/%61nonymize',
    P.USERS_WRITE,
    P.USERS_DELETE,
  ],
  ['DELETE', '/api/admin/users/x/pii', '/api/admin/users/x/%70ii', P.USERS_WRITE, P.USERS_DELETE],
  [
    'PATCH',
    '/api/admin/settings/agent',
    '/api/admin/settings/%61gent',
    P.SETTINGS_WRITE,
    P.AGENT_SETTINGS_WRITE,
  ],
  [
    'POST',
    '/api/admin/external-token-refresh/run',
    '/api/admin/external-token-refresh/%72un',
    P.EXTERNAL_TOKEN_REFRESH_WRITE,
    P.EXTERNAL_TOKEN_REFRESH_RUN,
  ],
  [
    'POST',
    '/api/admin/credential-profiles/x/offers',
    '/api/admin/credential-profiles/x/%6fffers',
    P.VC_CREDENTIAL_PROFILES_WRITE,
    P.VC_CREDENTIAL_OFFERS_CREATE,
  ],
];

describe('the permission a path asks for does not depend on how it is spelled', () => {
  it.each(cases)(
    '%s %s with only the weaker permission',
    async (method, plain, escaped, weaker) => {
      const call = harness([weaker]);
      expect((await call(method, plain)).status).toBe(403);
      expect((await call(method, escaped)).status).toBe(403);
    }
  );

  it.each(cases)(
    '%s %s with the permission it asks for',
    async (method, plain, escaped, _w, asked) => {
      const call = harness([asked]);
      expect((await call(method, plain)).status).toBe(200);
      expect((await call(method, escaped)).status).toBe(200);
    }
  );
});
