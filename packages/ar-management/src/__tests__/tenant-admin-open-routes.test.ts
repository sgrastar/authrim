import { describe, expect, it, vi } from 'vitest';
import type { Context, Next } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import {
  ADMIN_PERMISSIONS,
  classifyTenantRequestPath,
  extractTenantAdminOpenPathTenantId,
  isTenantAdminOpenInventoryPath,
  isTenantAdminOpenPath,
} from '@authrim/ar-lib-core';
import { app } from '../index';
import { isTenantScopedAdminPath } from '../admin-tenant-access';

const { stub } = vi.hoisted(() => ({
  stub: (name: string) => async (c: Context<{ Bindings: Env }>) => {
    const { requireTenantResourceAccess } = await import('../admin-tenant-access');
    const id = c.req.param('id') ?? c.req.param('tenantId') ?? '';
    const refusal = await requireTenantResourceAccess(c, id);
    return refusal ?? c.json({ stub: name, tenant: id });
  },
}));

/**
 * Drives the real management app (the platform guard on /api/admin/tenants/*, declared route
 * access, the real admin authentication middleware) for the tenant routes a tenant administrator
 * may open for their own tenant. Only two things are replaced:
 *  - the request context, which sets the request tenant the way the real one does (the header for
 *    tenant_scoped_admin, the path for the open inventory routes; the real middleware is covered
 *    in ar-lib-core) and stands in for the session lookup: an administrator who holds roles only in
 *    their home tenant is not found (no adminAuth, so a 401) when the request runs in another one;
 *  - the handlers, which keep only the real tenant access check.
 */
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requestContextMiddleware:
      () =>
      async (c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> => {
        const ctx = c as unknown as { set(key: string, value: unknown): void };
        const path = c.req.path;
        let tenantId = 'default';
        if (actual.isAdminTenantHeaderRequired(path)) {
          const header = c.req.header('X-Tenant-Id')?.trim();
          if (!header) return c.json({ error: 'invalid_request' }, 400);
          const pathTenantId = actual.extractTenantScopedPathTenantId(path);
          if (pathTenantId && pathTenantId !== header) {
            return c.json({ error: 'invalid_request' }, 400);
          }
          tenantId = header;
        } else if (actual.isTenantAdminOpenInventoryPath(path)) {
          tenantId = actual.extractTenantAdminOpenPathTenantId(path) ?? tenantId;
        }
        ctx.set('requestId', 'tenant-admin-open-routes');
        ctx.set('tenantId', tenantId);
        ctx.set('logger', actual.createLogger({ requestId: 'tenant-admin-open-routes', tenantId }));
        ctx.set('startTime', Date.now());
        const persona = (globalThis as unknown as { __personas: Personas }).__personas[
          c.req.header('X-Test-Persona') ?? ''
        ];
        if (persona) {
          const global = persona.tenantScope?.includes('*') === true;
          if (global || persona.tenantId === tenantId) ctx.set('adminAuth', persona);
        }
        await next();
      },
  };
});

// The tenant data context needs a runtime registry; the real one is exercised, with the real
// authentication, in tenant-admin-open-routes-real-auth.test.ts.
vi.mock('../admin-tenant-open-context', () => ({
  tenantAdminOpenDataContext: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../admin-info', () => ({ adminTenantInfoHandler: stub('info') }));
vi.mock('../admin-tenant-invitations', () => ({
  createTenantInvitationHandler: stub('invitations-create'),
  listTenantInvitationsHandler: stub('invitations-list'),
  cancelTenantInvitationHandler: stub('invitations-cancel'),
}));
vi.mock('../runtime-profiles', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  adminTenantRuntimeProfilesHandler: stub('runtime-profiles'),
}));
vi.mock('../routes/email-settings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTenantEmailSettingsHandler: stub('email-settings'),
}));
vi.mock('../admin-tenants', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const stubbed: Record<string, unknown> = { ...actual };
  for (const [name, value] of Object.entries(actual)) {
    if (typeof value === 'function' && /^adminTenant.*Handler$/.test(name)) {
      stubbed[name] = (c: Context) => c.json({ stub: name });
    }
  }
  return stubbed;
});

type Personas = Record<string, AdminAuthContext>;

const BROAD = (Object.values(ADMIN_PERMISSIONS) as string[]).filter(
  (permission) => permission !== '*' && permission !== 'admin:*'
);

function session(overrides: Partial<AdminAuthContext>): AdminAuthContext {
  return {
    userId: 'admin-1',
    authMethod: 'session',
    actorType: 'human',
    tenantId: 'default',
    tenantScope: ['default'],
    roles: [],
    globalRoles: [],
    permissions: [],
    globalPermissions: [],
    hierarchyLevel: 0,
    mfaVerified: true,
    ...overrides,
  };
}

const PERSONAS: Personas = {
  tenantAdminT1: session({
    tenantId: 't1',
    tenantScope: ['t1'],
    roles: ['ar_tenant_admin'],
    permissions: BROAD,
  }),
  // A global machine token holding only the provisioning permission (the trial portal's).
  machineProvision: {
    userId: 'machine-1',
    authMethod: 'machine_access_token',
    actorType: 'machine',
    actorId: 'machine-1',
    tenantId: 'default',
    tenantScope: ['*'],
    roles: [],
    globalRoles: [],
    permissions: [ADMIN_PERMISSIONS.TENANT_PROVISION],
    globalPermissions: [ADMIN_PERMISSIONS.TENANT_PROVISION],
    hierarchyLevel: 0,
    mfaVerified: false,
  },
  platformAdmin: session({
    tenantScope: ['*'],
    roles: ['ar_super_admin'],
    globalRoles: ['ar_super_admin'],
    permissions: ['*'],
    globalPermissions: ['*'],
  }),
};
(globalThis as unknown as { __personas: Personas }).__personas = PERSONAS;

// An Admin database with no rows: no IP allowlist entries, so any address is allowed.
const emptyAdminDatabase = {
  query: async () => [],
  queryOne: async () => null,
  execute: async () => ({ success: true, changes: 0 }),
  transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(emptyAdminDatabase),
  batch: async () => [],
  isHealthy: async () => true,
  close: async () => undefined,
  getType: () => 'd1',
  getPartition: () => 'admin',
};

const counters = new Map<string, number>();
const env = {
  ISSUER_URL: 'https://op.example.com',
  BASE_DOMAIN: 'op.example.com',
  DB_ADMIN: emptyAdminDatabase,
  CONTROL: {
    getReleaseMigrationRolloutStatus: async () => ({ adminMutationMode: 'read_write' }),
  },
  SETTINGS: { get: async () => null },
  RATE_LIMITER: {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      incrementRpc: async (
        _key: string,
        config: { maxRequests: number; windowSeconds: number }
      ) => {
        const current = (counters.get(id) ?? 0) + 1;
        counters.set(id, current);
        return {
          allowed: true,
          current,
          limit: config.maxRequests,
          resetAt: Math.floor(Date.now() / 1000) + config.windowSeconds,
          retryAfter: 0,
        };
      },
    }),
  },
} as unknown as Env;

async function call(
  persona: string | null,
  method: string,
  path: string,
  tenantHeader?: string | null
) {
  const headers: Record<string, string> = {
    'CF-Connecting-IP': '192.0.2.10',
    'Content-Type': 'application/json',
    Origin: 'https://op.example.com',
  };
  if (persona) headers['X-Test-Persona'] = persona;
  if (tenantHeader) headers['X-Tenant-Id'] = tenantHeader;
  const response = await app.request(path, { method, headers }, env);
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body };
}

/** The tenant-admin-open routes with the tenant id left to fill in. */
const ROUTES = [
  {
    name: 'info',
    method: 'GET',
    headerScoped: false,
    path: (t: string) => `/api/admin/tenants/${t}/info`,
  },
  {
    name: 'invitations list',
    method: 'GET',
    headerScoped: false,
    path: (t: string) => `/api/admin/tenants/${t}/invitations`,
  },
  {
    name: 'invitations cancel',
    method: 'DELETE',
    headerScoped: false,
    path: (t: string) => `/api/admin/tenants/${t}/invitations/inv-1`,
  },
  {
    name: 'runtime-profiles',
    method: 'GET',
    headerScoped: false,
    path: (t: string) => `/api/admin/tenants/${t}/runtime-profiles`,
  },
  {
    // A header-scoped route (tenant_scoped_admin): the header has to name the path's tenant.
    name: 'email-settings',
    method: 'GET',
    headerScoped: true,
    path: (t: string) => `/api/admin/tenants/${t}/email-settings`,
  },
] as const;

describe('tenant-admin-open routes under /api/admin/tenants/{id}/', () => {
  for (const route of ROUTES) {
    describe(route.name, () => {
      it('is reached by the tenant administrator for their own tenant', async () => {
        for (const header of ['t1', null, 't2']) {
          const own = await call('tenantAdminT1', route.method, route.path('t1'), header);
          if (route.headerScoped && header !== 't1') {
            expect(own.status).toBe(400);
          } else {
            expect({ header, ...own }).toMatchObject({
              header,
              status: 200,
              body: { tenant: 't1' },
            });
          }
        }
      });

      it("is refused for another tenant's id, whatever the header says", async () => {
        for (const header of ['t1', 't2', 'default', null]) {
          const other = await call('tenantAdminT1', route.method, route.path('t2'), header);
          expect(other.status).not.toBe(200);
          expect(other.body.tenant).toBeUndefined();
          expect(other.body.stub).toBeUndefined();
        }
      });

      it('is reached by a platform administrator for every tenant id', async () => {
        for (const tenant of ['default', 't1', 't2']) {
          const result = await call('platformAdmin', route.method, route.path(tenant), tenant);
          expect({ tenant, ...result }).toMatchObject({ tenant, status: 200 });
          if (!route.headerScoped) {
            // The inventory routes need no header (the console sends none for the info page),
            // and a header naming the default tenant, as the legacy UI sends, changes nothing.
            for (const header of [null, 'default']) {
              const other = await call('platformAdmin', route.method, route.path(tenant), header);
              expect({ tenant, header, ...other }).toMatchObject({ tenant, header, status: 200 });
            }
          }
        }
      });

      it('is refused without authentication', async () => {
        for (const tenant of ['t1', 'default']) {
          const result = await call(null, route.method, route.path(tenant), tenant);
          expect(result.status).toBe(401);
        }
      });

      it('gives the same outcome for percent-encoded variants of the path', async () => {
        const encode = (tenant: string) =>
          route
            .path(tenant)
            .replace(
              `/tenants/${tenant}/`,
              `/tenants/%${tenant.charCodeAt(0).toString(16)}${tenant.slice(1)}/`
            );
        const own = await call('tenantAdminT1', route.method, encode('t1'), 't1');
        const plain = await call('tenantAdminT1', route.method, route.path('t1'), 't1');
        expect(own.status).toBe(plain.status);
        const other = await call('tenantAdminT1', route.method, encode('t2'), 't1');
        expect(other.status).not.toBe(200);
      });
    });
  }

  it('an encoded letter of the route name does not change the outcome', async () => {
    const own = await call('tenantAdminT1', 'GET', '/api/admin/tenants/t1/%69nfo', null);
    expect(own.status).toBe(200);
    const other = await call('tenantAdminT1', 'GET', '/api/admin/tenants/t2/%69nfo', null);
    expect(other.status).not.toBe(200);
  });

  it('a dot-segment detour from an open route to a platform-only one stays refused', async () => {
    // The URL parser resolves the encoded dot segments before the router sees the path.
    for (const detour of [
      '/api/admin/tenants/t1/info/%2e%2e/provisioning',
      '/api/admin/tenants/t1/info/%2E%2E/set-default',
      '/api/admin/tenants/t1/invitations/%2e%2e/%2e%2e/t2/provisioning',
    ]) {
      const result = await call('tenantAdminT1', 'GET', detour, null);
      expect({ detour, refused: result.status >= 400 }).toEqual({ detour, refused: true });
    }
  });

  it('a global provisioning machine token keeps its routes and gains none of the open routes', async () => {
    const provisioning = await call(
      'machineProvision',
      'GET',
      '/api/admin/tenants/t1/provisioning'
    );
    expect(provisioning.status).toBe(200);
    const read = await call('machineProvision', 'GET', '/api/admin/tenants/t1');
    expect(read.status).toBe(200);
    // The declared route rules name the read / write permissions these routes need; the
    // provisioning permission is none of them.
    for (const route of ROUTES) {
      const result = await call('machineProvision', route.method, route.path('t1'), 't1');
      expect({ route: route.name, status: result.status }).toEqual({
        route: route.name,
        status: 403,
      });
    }
  });

  it('keeps the platform-only routes refused for the tenant administrator', async () => {
    const platformOnly: Array<[string, string]> = [
      ['GET', '/api/admin/tenants'],
      ['POST', '/api/admin/tenants'],
      ['GET', '/api/admin/tenants/t1'],
      ['PATCH', '/api/admin/tenants/t1'],
      ['DELETE', '/api/admin/tenants/t1'],
      ['GET', '/api/admin/tenants/t1/provisioning'],
      ['POST', '/api/admin/tenants/t1/provisioning/retry'],
      ['POST', '/api/admin/tenants/t1/provisioning/cleanup'],
      ['POST', '/api/admin/tenants/t1/set-default'],
      ['POST', '/api/admin/tenants/t1/clone'],
      ['POST', '/api/admin/tenants/t1/deletion/cancel'],
      ['POST', '/api/admin/tenants/t1/lifecycle/suspend'],
      ['POST', '/api/admin/tenants/t1/lifecycle/resume'],
      ['GET', '/api/admin/tenants/t1/lifecycle/jobs'],
      ['GET', '/api/admin/tenants/t1/placement-migrations/latest'],
      ['PUT', '/api/admin/tenants/t1/runtime-profiles'],
      ['GET', '/api/admin/tenants/t1/runtime-profiles/audit/default'],
    ];
    for (const [method, path] of platformOnly) {
      for (const header of ['t1', null, 'default']) {
        const result = await call('tenantAdminT1', method, path, header);
        expect({ method, path, header, refused: result.status >= 400 }).toEqual({
          method,
          path,
          header,
          refused: true,
        });
      }
    }
  });
});

describe('the open-route table and the request classification do not drift', () => {
  const OPEN = [
    '/api/admin/tenants/t1/directory-auth/policy',
    '/api/admin/tenants/t1/directory-connectors',
    '/api/admin/tenants/t1/settings/session',
    '/api/admin/tenants/t1/info',
    '/api/admin/tenants/t1/invitations',
    '/api/admin/tenants/t1/invitations/inv-1',
    '/api/admin/tenants/t1/email-settings',
    '/api/admin/tenants/t1/runtime-profiles',
  ];
  const PLATFORM_ONLY = [
    '/api/admin/tenants',
    '/api/admin/tenants/t1',
    '/api/admin/tenants/t1/provisioning',
    '/api/admin/tenants/t1/provisioning/retry',
    '/api/admin/tenants/t1/provisioning/cleanup',
    '/api/admin/tenants/t1/set-default',
    '/api/admin/tenants/t1/clone',
    '/api/admin/tenants/t1/deletion/cancel',
    '/api/admin/tenants/t1/lifecycle/suspend',
    '/api/admin/tenants/t1/lifecycle/jobs',
    '/api/admin/tenants/t1/lifecycle/jobs/job-1/retry',
    '/api/admin/tenants/t1/invitations/inv-1/extra',
    '/api/admin/tenants/t1/runtime-profiles/audit/default',
  ];

  it.each(OPEN)(
    '%s: open to tenant administrators and run in the tenant of the request',
    (path) => {
      expect(isTenantAdminOpenPath(path)).toBe(true);
      expect(isTenantScopedAdminPath(path)).toBe(true);
      expect(extractTenantAdminOpenPathTenantId(path)).toBe('t1');
      // Either the header names the tenant (tenant_scoped_admin), or the context takes it from the
      // path (open inventory route): never the host's tenant.
      const requestClass = classifyTenantRequestPath(path);
      expect(
        requestClass === 'tenant_scoped_admin' ||
          (requestClass === 'tenant_inventory_admin' && isTenantAdminOpenInventoryPath(path))
      ).toBe(true);
    }
  );

  it.each(PLATFORM_ONLY)('%s: platform-only and not open', (path) => {
    expect(isTenantAdminOpenPath(path)).toBe(false);
    expect(isTenantAdminOpenInventoryPath(path)).toBe(false);
  });
});
