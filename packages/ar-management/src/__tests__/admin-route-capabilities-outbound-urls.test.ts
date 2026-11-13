/**
 * The route-tagged parts of directory_connectors (connector secrets, health check) and
 * external_identity_providers (create, update, register, OIDC discovery): while a capability is
 * off the tenant admin is refused at the gate (the handler is never reached), a caller with
 * global platform authority is not, and what does not call a tenant-chosen URL stays open.
 * (Saving the directory connector settings is judged by its handler: see
 * directory-connectors-capability.test.ts.)
 */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { app as managementApp } from '../index';
import {
  findAdminRouteAccessRule,
  registerDeclaredAdminRouteAccessMiddleware,
} from '../admin-route-access';

const DOC_KEY = 'settings:platform:tenant-capabilities';

type Switches = Partial<Record<string, boolean>> | 'down';

function settingsKv(switches: Switches) {
  const document = JSON.stringify(
    Object.fromEntries(
      Object.entries(switches === 'down' ? {} : switches).map(([name, value]) => [
        `tenant_capabilities.${name}`,
        value,
      ])
    )
  );
  const get = vi.fn(async (key: string) => {
    if (switches === 'down') throw new Error('kv down');
    return key === DOC_KEY ? document : null;
  });
  return { get, put: vi.fn(), delete: vi.fn(), list: vi.fn(), getWithMetadata: vi.fn() };
}

const TENANT_ADMIN: Partial<AdminAuthContext> = {
  authMethod: 'session',
  actorType: 'human',
  roles: ['ar_tenant_admin'],
  permissions: [ADMIN_PERMISSIONS.ALL],
  tenantScope: ['tenant-a'],
};
const PLATFORM_ADMIN: Partial<AdminAuthContext> = {
  authMethod: 'session',
  actorType: 'human',
  roles: ['ar_super_admin'],
  globalRoles: ['ar_super_admin'],
  permissions: [ADMIN_PERMISSIONS.ALL],
  globalPermissions: [ADMIN_PERMISSIONS.ALL],
  tenantScope: ['*'],
};

const ROUTES: Array<[string, string, string]> = [
  [
    'directory_connectors',
    'POST',
    '/api/admin/tenants/tenant-a/directory-connectors/campus/secret',
  ],
  [
    'directory_connectors',
    'POST',
    '/api/admin/tenants/tenant-a/directory-connectors/campus/secret/rotate',
  ],
  [
    'directory_connectors',
    'POST',
    '/api/admin/tenants/tenant-a/directory-connectors/campus/health',
  ],
  ['external_identity_providers', 'POST', '/api/admin/external-providers'],
  ['external_identity_providers', 'PUT', '/api/admin/external-providers/prov-1'],
  ['external_identity_providers', 'POST', '/api/admin/external-providers/prov-1/register'],
  ['external_identity_providers', 'POST', '/api/admin/external-providers/discover-oidc'],
];
const OPEN: Array<[string, string]> = [
  ['GET', '/api/admin/tenants/tenant-a/directory-connectors'],
  ['GET', '/api/admin/tenants/tenant-a/directory-connectors/fleet'],
  ['POST', '/api/admin/tenants/tenant-a/directory-connectors/fleet/instance-1'],
  ['POST', '/api/admin/tenants/tenant-a/directory-connectors/pending-users/pending-1'],
  ['GET', '/api/admin/tenants/tenant-a/directory-connectors/campus/events'],
  ['GET', '/api/admin/external-providers'],
  ['GET', '/api/admin/external-providers/prov-1'],
  ['DELETE', '/api/admin/external-providers/prov-1'],
];

function harness(persona: Partial<AdminAuthContext>, switches: Switches) {
  const kv = settingsKv(switches);
  const reached = vi.fn();
  const app = new Hono<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>();
  app.use('*', async (c, next) => {
    c.set('adminAuth', {
      userId: 'admin-1',
      tenantId: 'tenant-a',
      hierarchyLevel: 0,
      mfaVerified: false,
      ...persona,
    } as AdminAuthContext);
    await next();
  });
  registerDeclaredAdminRouteAccessMiddleware(app);
  const ok = (c: { json: (body: unknown) => Response }) => {
    reached();
    return c.json({ ok: true });
  };
  for (const [, method, path] of ROUTES) app.on(method, path, ok);
  for (const [method, path] of OPEN) app.on(method, path, ok);
  const env = { SETTINGS: kv } as unknown as Env;
  return {
    reached,
    request: (method: string, path: string) => app.request(path, { method }, env),
  };
}

describe('the route table for the outbound-URL capabilities', () => {
  it('tags exactly the routes that make the platform call a tenant-chosen endpoint', () => {
    for (const [capability, method, path] of ROUTES) {
      expect(findAdminRouteAccessRule(method, path)?.capability, `${method} ${path}`).toBe(
        capability
      );
    }
    for (const [method, path] of OPEN) {
      expect(findAdminRouteAccessRule(method, path)?.capability, `${method} ${path}`).toBe(
        undefined
      );
    }
  });

  it('keeps the permission the catch-all rules gave these routes', () => {
    const secret = findAdminRouteAccessRule(
      'POST',
      '/api/admin/tenants/tenant-a/directory-connectors/campus/secret'
    )!;
    const fleet = findAdminRouteAccessRule(
      'POST',
      '/api/admin/tenants/tenant-a/directory-connectors/fleet/instance-1'
    )!;
    expect(secret.permissions).toEqual(fleet.permissions);
    const create = findAdminRouteAccessRule('POST', '/api/admin/external-providers')!;
    const remove = findAdminRouteAccessRule('DELETE', '/api/admin/external-providers/prov-1')!;
    expect(create.permissions).toEqual([ADMIN_PERMISSIONS.EXTERNAL_PROVIDERS_WRITE]);
    expect(remove.permissions).toEqual([ADMIN_PERMISSIONS.EXTERNAL_PROVIDERS_DELETE]);
  });

  it('tags every registered write route of the external provider admin API', () => {
    const routes = managementApp.routes.filter(
      (route) =>
        route.path.startsWith('/api/admin/external-providers') &&
        route.method !== 'GET' &&
        route.method !== 'DELETE' &&
        route.method !== 'ALL'
    );
    expect(routes.length).toBeGreaterThanOrEqual(4);
    for (const route of routes) {
      expect(
        findAdminRouteAccessRule(route.method, route.path.replace(/:[^/]+/g, 'x'))?.capability,
        `${route.method} ${route.path}`
      ).toBe('external_identity_providers');
    }
  });

  it('tags every registered connector POST that is not a fleet or pending-user action', () => {
    const routes = managementApp.routes.filter(
      (route) =>
        route.method === 'POST' &&
        route.path.startsWith('/api/admin/tenants/:tenantId/directory-connectors/:connectorId/')
    );
    expect(routes.length).toBe(3);
    for (const route of routes) {
      expect(
        findAdminRouteAccessRule('POST', route.path.replace(/:[^/]+/g, 'x'))?.capability,
        route.path
      ).toBe('directory_connectors');
    }
  });
});

describe.each(ROUTES)('%s: %s %s', (capability, method, path) => {
  it('is refused for a tenant admin with 403 capability_disabled while off; the handler is not reached', async () => {
    const { request, reached } = harness(TENANT_ADMIN, { [capability]: false });
    const response = await request(method, path);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'capability_disabled', capability });
    expect(reached).not.toHaveBeenCalled();
  });

  it('answers 503 temporarily_unavailable with Retry-After when the switch cannot be read', async () => {
    const { request, reached } = harness(TENANT_ADMIN, 'down');
    const response = await request(method, path);
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBeTruthy();
    expect(await response.json()).toMatchObject({ error: 'temporarily_unavailable', capability });
    expect(reached).not.toHaveBeenCalled();
  });

  it('works while on, and is not affected by another capability being off', async () => {
    for (const switches of [{}, { webhooks: false, bulk_jobs: false }]) {
      const { request, reached } = harness(TENANT_ADMIN, switches);
      expect((await request(method, path)).status).toBe(200);
      expect(reached).toHaveBeenCalledOnce();
    }
  });

  it('is allowed for a caller with global platform authority while off', async () => {
    const { request, reached } = harness(PLATFORM_ADMIN, { [capability]: false });
    expect((await request(method, path)).status).toBe(200);
    expect(reached).toHaveBeenCalledOnce();
  });
});

describe('what stays open while the capabilities are off', () => {
  it.each(OPEN)('%s %s is allowed for a tenant admin', async (method, path) => {
    const { request } = harness(TENANT_ADMIN, {
      directory_connectors: false,
      external_identity_providers: false,
    });
    expect((await request(method, path)).status).toBe(200);
  });
});
