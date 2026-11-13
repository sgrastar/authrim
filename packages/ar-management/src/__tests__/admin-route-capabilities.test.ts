/**
 * The capability gate of the Admin API: routes of a capability the platform turned off are closed
 * to callers without global platform authority, and only those routes.
 */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { app as managementApp } from '../index';
import {
  ADMIN_ROUTE_ACCESS_RULES,
  findAdminRouteAccessRule,
  registerDeclaredAdminRouteAccessMiddleware,
} from '../admin-route-access';

const DOC_KEY = 'settings:platform:tenant-capabilities';
const ROUTE_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const WRITE = new Set(['POST', 'PUT', 'PATCH']);

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
  const kv = { get, put: vi.fn(), delete: vi.fn(), list: vi.fn(), getWithMetadata: vi.fn() };
  return { kv: kv as unknown as KVNamespace, get };
}

const PERSONAS: Record<string, Partial<AdminAuthContext>> = {
  tenantAdmin: {
    authMethod: 'session',
    actorType: 'human',
    roles: ['ar_tenant_admin'],
    permissions: [ADMIN_PERMISSIONS.ALL],
    tenantScope: ['tenant-a'],
  },
  viewer: {
    authMethod: 'session',
    actorType: 'human',
    roles: ['ar_viewer'],
    permissions: [
      ADMIN_PERMISSIONS.SETTINGS_READ,
      ADMIN_PERMISSIONS.JOBS_READ,
      ADMIN_PERMISSIONS.WEBHOOKS_READ,
    ],
    tenantScope: ['tenant-a'],
  },
  support: {
    authMethod: 'session',
    actorType: 'human',
    roles: ['ar_support'],
    permissions: [ADMIN_PERMISSIONS.USERS_READ, ADMIN_PERMISSIONS.SETTINGS_READ],
    tenantScope: ['tenant-a'],
  },
  platformAdmin: {
    authMethod: 'session',
    actorType: 'human',
    roles: ['ar_super_admin'],
    globalRoles: ['ar_super_admin'],
    permissions: [ADMIN_PERMISSIONS.ALL],
    globalPermissions: [ADMIN_PERMISSIONS.ALL],
    tenantScope: ['*'],
  },
  globalMachine: {
    authMethod: 'machine_access_token',
    actorType: 'machine',
    roles: [],
    permissions: ['admin:*'],
    globalPermissions: ['admin:*'],
    tenantScope: ['*'],
  },
  tenantMachine: {
    authMethod: 'machine_access_token',
    actorType: 'machine',
    roles: [],
    permissions: ['admin:*'],
    tenantScope: ['tenant-a'],
  },
  agent: {
    authMethod: 'machine_access_token',
    actorType: 'agent',
    roles: [],
    permissions: ['admin:*'],
    tenantScope: ['tenant-a'],
  },
};

function harness(persona: string | null, switches: Switches) {
  const { kv, get } = settingsKv(switches);
  const app = new Hono<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>();
  app.use('*', async (c, next) => {
    if (persona) {
      c.set('adminAuth', {
        userId: 'admin-1',
        tenantId: 'tenant-a',
        hierarchyLevel: 0,
        mfaVerified: false,
        ...PERSONAS[persona],
      } as AdminAuthContext);
    }
    await next();
  });
  registerDeclaredAdminRouteAccessMiddleware(app);
  const ok = (c: { json: (body: unknown) => Response }) => c.json({ ok: true });
  app.get('/api/admin/webhooks', ok);
  app.post('/api/admin/webhooks', ok);
  app.get('/api/admin/webhooks/wh-1/deliveries', ok);
  app.post('/api/admin/webhooks/wh-1/replay', ok);
  app.delete('/api/admin/webhooks/wh-1', ok);
  app.get('/api/admin/jobs', ok);
  app.get('/api/admin/jobs/job-1/result', ok);
  app.post('/api/admin/jobs/users/import', ok);
  app.put('/api/admin/jobs/users/import/upload/up-1', ok);
  app.post('/api/admin/jobs/users/bulk-update', ok);
  app.patch('/api/admin/tenants/tenant-a/settings/dcr', ok);
  app.get('/api/admin/tenants/tenant-a/settings/dcr', ok);
  app.patch('/api/admin/tenants/tenant-a/settings/plugin', ok);
  app.patch('/api/admin/tenants/tenant-a/settings/diagnostic-logging', ok);
  app.get('/api/admin/clients', ok);
  const env = { SETTINGS: kv } as unknown as Env;
  const request = (method: string, path: string) => app.request(path, { method }, env);
  return { request, settingsGet: get };
}

describe('the route table', () => {
  const tagged = ADMIN_ROUTE_ACCESS_RULES.filter((rule) => rule.capability);

  it('tags every webhooks rule, whatever the pattern under the prefix', () => {
    const family = ADMIN_ROUTE_ACCESS_RULES.filter(
      (rule) =>
        rule.pattern === '/api/admin/webhooks' || rule.pattern.startsWith('/api/admin/webhooks/')
    );
    expect(family.length).toBeGreaterThan(0);
    expect(family.filter((rule) => rule.capability !== 'webhooks')).toEqual([]);
  });

  it('tags every registered webhooks route, so a new one cannot be added untagged', () => {
    const routes = managementApp.routes.filter(
      (route) =>
        ROUTE_METHODS.has(route.method) &&
        (route.path === '/api/admin/webhooks' || route.path.startsWith('/api/admin/webhooks/'))
    );
    expect(routes.length).toBeGreaterThan(5);
    for (const route of routes) {
      expect(findAdminRouteAccessRule(route.method, route.path)?.capability, route.path).toBe(
        'webhooks'
      );
    }
  });

  it('tags every write under the jobs prefix as bulk work, and no read or delete', () => {
    const family = ADMIN_ROUTE_ACCESS_RULES.filter(
      (rule) => rule.pattern === '/api/admin/jobs' || rule.pattern.startsWith('/api/admin/jobs/')
    );
    for (const rule of family) {
      const writesOnly = rule.methods.every((method) => WRITE.has(method));
      expect(rule.capability, `${rule.pattern} ${rule.methods.join(',')}`).toBe(
        writesOnly ? 'bulk_jobs' : undefined
      );
    }
    const routes = managementApp.routes.filter(
      (route) =>
        ROUTE_METHODS.has(route.method) &&
        (route.path === '/api/admin/jobs' || route.path.startsWith('/api/admin/jobs/'))
    );
    const writes = routes.filter((route) => WRITE.has(route.method));
    expect(writes.length).toBeGreaterThanOrEqual(6);
    for (const route of writes) {
      expect(findAdminRouteAccessRule(route.method, route.path)?.capability, route.path).toBe(
        'bulk_jobs'
      );
    }
    for (const route of routes.filter((candidate) => !WRITE.has(candidate.method))) {
      expect(findAdminRouteAccessRule(route.method, route.path)?.capability, route.path).toBe(
        undefined
      );
    }
  });

  it('tags the dcr and plugin settings writes before the settings catch-all, and their reads not', () => {
    const dcr = findAdminRouteAccessRule('PATCH', '/api/admin/tenants/t/settings/dcr');
    const plugin = findAdminRouteAccessRule('PATCH', '/api/admin/tenants/t/settings/plugin');
    expect(dcr?.capability).toBe('dynamic_client_registration');
    expect(plugin?.capability).toBe('external_plugins');
    for (const method of ['GET']) {
      expect(
        findAdminRouteAccessRule(method, '/api/admin/tenants/t/settings/dcr')?.capability
      ).toBe(undefined);
      expect(
        findAdminRouteAccessRule(method, '/api/admin/tenants/t/settings/plugin')?.capability
      ).toBe(undefined);
    }
    // The rules give exactly what the catch-all gives for a write.
    const catchAll = findAdminRouteAccessRule(
      'PATCH',
      '/api/admin/tenants/t/settings/diagnostic-logging'
    )!;
    for (const rule of [dcr!, plugin!]) {
      expect(rule.permissions).toEqual(catchAll.permissions);
      expect(rule.anyPermissions).toEqual(catchAll.anyPermissions);
      expect(rule.roles).toEqual(catchAll.roles);
      expect(rule.authenticated).toEqual(catchAll.authenticated);
    }
  });

  it('tags nothing else', () => {
    const summary = [
      ...new Set(
        tagged.map((rule) => `${rule.capability} ${rule.pattern} ${rule.methods.join(',')}`)
      ),
    ].sort();
    expect(summary).toEqual([
      'admin_sent_email /api/admin/users/:id/send-email POST',
      'bulk_jobs /api/admin/jobs POST,PUT,PATCH',
      'bulk_jobs /api/admin/jobs/* POST,PUT,PATCH',
      'directory_connectors /api/admin/tenants/:tenantId/directory-connectors/:connectorId/health POST',
      'directory_connectors /api/admin/tenants/:tenantId/directory-connectors/:connectorId/secret POST',
      'directory_connectors /api/admin/tenants/:tenantId/directory-connectors/:connectorId/secret/rotate POST',
      'dynamic_client_registration /api/admin/tenants/:tenantId/settings/dcr POST,PUT,PATCH,DELETE',
      'email_provider_config /api/admin/tenants/:tenantId/email-settings DELETE',
      'email_provider_config /api/admin/tenants/:tenantId/email-settings POST,PUT,PATCH',
      'external_identity_providers /api/admin/external-providers POST,PUT,PATCH',
      'external_identity_providers /api/admin/external-providers/* POST,PUT,PATCH',
      'external_plugins /api/admin/tenants/:tenantId/settings/plugin POST,PUT,PATCH,DELETE',
      'machine_credentials /api/admin/check-api-keys POST,PUT,PATCH',
      'machine_credentials /api/admin/check-api-keys/* POST,PUT,PATCH',
      'machine_credentials /api/admin/scim-tokens POST,PUT,PATCH',
      'machine_credentials /api/admin/scim-tokens/* POST,PUT,PATCH',
      'webhooks /api/admin/webhooks DELETE',
      'webhooks /api/admin/webhooks GET',
      'webhooks /api/admin/webhooks POST,PUT,PATCH',
      'webhooks /api/admin/webhooks/* DELETE',
      'webhooks /api/admin/webhooks/* GET',
      'webhooks /api/admin/webhooks/* POST,PUT,PATCH',
    ]);
  });
});

describe('who is allowed does not change with the switches on', () => {
  const requests: Array<[string, string]> = [
    ['GET', '/api/admin/webhooks'],
    ['POST', '/api/admin/webhooks'],
    ['DELETE', '/api/admin/webhooks/wh-1'],
    ['GET', '/api/admin/jobs'],
    ['POST', '/api/admin/jobs/users/import'],
    ['PUT', '/api/admin/jobs/users/import/upload/up-1'],
    ['PATCH', '/api/admin/tenants/tenant-a/settings/dcr'],
    ['PATCH', '/api/admin/tenants/tenant-a/settings/plugin'],
    ['PATCH', '/api/admin/tenants/tenant-a/settings/diagnostic-logging'],
  ];

  it('gives the dcr and plugin writes the decision the settings catch-all gives, for each persona', async () => {
    for (const persona of Object.keys(PERSONAS)) {
      const { request } = harness(persona, {});
      const reference = (
        await request('PATCH', '/api/admin/tenants/tenant-a/settings/diagnostic-logging')
      ).status;
      for (const category of ['dcr', 'plugin']) {
        const status = (await request('PATCH', `/api/admin/tenants/tenant-a/settings/${category}`))
          .status;
        expect(status, `${persona} ${category}`).toBe(reference);
      }
    }
  });

  it('allows tenant admins and platform admins, and refuses viewers and support, as before', async () => {
    const decisions: Record<string, number[]> = {};
    for (const persona of ['tenantAdmin', 'viewer', 'support', 'platformAdmin']) {
      const { request } = harness(persona, {});
      decisions[persona] = [];
      for (const [method, path] of requests) {
        decisions[persona].push((await request(method, path)).status);
      }
    }
    expect(decisions).toEqual({
      tenantAdmin: [200, 200, 200, 200, 200, 200, 200, 200, 200],
      viewer: [200, 403, 403, 200, 403, 403, 403, 403, 403],
      support: [403, 403, 403, 403, 403, 403, 403, 403, 403],
      platformAdmin: [200, 200, 200, 200, 200, 200, 200, 200, 200],
    });
  });
});

describe('the gate', () => {
  const closed: Array<[string, string, string]> = [
    ['webhooks', 'GET', '/api/admin/webhooks'],
    ['webhooks', 'POST', '/api/admin/webhooks'],
    ['webhooks', 'GET', '/api/admin/webhooks/wh-1/deliveries'],
    ['webhooks', 'POST', '/api/admin/webhooks/wh-1/replay'],
    ['webhooks', 'DELETE', '/api/admin/webhooks/wh-1'],
    ['bulk_jobs', 'POST', '/api/admin/jobs/users/import'],
    ['bulk_jobs', 'PUT', '/api/admin/jobs/users/import/upload/up-1'],
    ['bulk_jobs', 'POST', '/api/admin/jobs/users/bulk-update'],
    ['dynamic_client_registration', 'PATCH', '/api/admin/tenants/tenant-a/settings/dcr'],
    ['external_plugins', 'PATCH', '/api/admin/tenants/tenant-a/settings/plugin'],
  ];

  it('refuses a tenant admin with 403 capability_disabled and the capability, while it is off', async () => {
    for (const [capability, method, path] of closed) {
      const { request } = harness('tenantAdmin', { [capability]: false });
      const response = await request(method, path);
      expect(response.status, `${method} ${path}`).toBe(403);
      const body = await response.json<Record<string, unknown>>();
      expect(body.error).toBe('capability_disabled');
      expect(body.capability).toBe(capability);
      expect(typeof body.error_description).toBe('string');
    }
  });

  it('is unchanged while a capability is on, and another capability being off changes nothing here', async () => {
    for (const [capability, method, path] of closed) {
      expect((await harness('tenantAdmin', {}).request(method, path)).status).toBe(200);
      expect(
        (await harness('tenantAdmin', { [capability]: true }).request(method, path)).status
      ).toBe(200);
      const other = capability === 'webhooks' ? 'bulk_jobs' : 'webhooks';
      expect((await harness('tenantAdmin', { [other]: false }).request(method, path)).status).toBe(
        200
      );
    }
  });

  it('leaves reads of jobs and settings, and untagged routes, open while capabilities are off', async () => {
    const off = {
      webhooks: false,
      bulk_jobs: false,
      dynamic_client_registration: false,
      external_plugins: false,
    };
    const { request } = harness('tenantAdmin', off);
    for (const [method, path] of [
      ['GET', '/api/admin/jobs'],
      ['GET', '/api/admin/jobs/job-1/result'],
      ['GET', '/api/admin/tenants/tenant-a/settings/dcr'],
      ['PATCH', '/api/admin/tenants/tenant-a/settings/diagnostic-logging'],
      ['GET', '/api/admin/clients'],
    ]) {
      expect((await request(method, path)).status, `${method} ${path}`).toBe(200);
    }
  });

  it('lets callers with global platform authority through while it is off', async () => {
    for (const persona of ['platformAdmin', 'globalMachine']) {
      for (const [capability, method, path] of closed) {
        const { request } = harness(persona, { [capability]: false });
        expect((await request(method, path)).status, `${persona} ${method} ${path}`).toBe(200);
      }
    }
  });

  it('refuses a tenant-scoped machine token and an agent while it is off', async () => {
    for (const persona of ['tenantMachine', 'agent']) {
      for (const [capability, method, path] of closed) {
        const { request } = harness(persona, { [capability]: false });
        const response = await request(method, path);
        expect(response.status, `${persona} ${method} ${path}`).toBe(403);
        expect((await response.json<{ error: string }>()).error).toBe('capability_disabled');
      }
    }
  });

  it('learns the real reason before the permission: a viewer gets capability_disabled while it is off', async () => {
    const { request } = harness('viewer', { webhooks: false });
    const response = await request('POST', '/api/admin/webhooks');
    expect((await response.json<{ error: string }>()).error).toBe('capability_disabled');
  });

  it('answers 503 for a tagged route when the switch cannot be read, never as if it were on', async () => {
    for (const [, method, path] of closed) {
      const { request } = harness('tenantAdmin', 'down');
      const response = await request(method, path);
      expect(response.status, `${method} ${path}`).toBe(503);
      const body = await response.json<Record<string, unknown>>();
      expect(body.error).toBe('temporarily_unavailable');
    }
  });

  it('keeps refusing a caller the rule refuses with 403 insufficient_permissions when unreadable', async () => {
    const { request } = harness('support', 'down');
    const response = await request('POST', '/api/admin/webhooks');
    expect(response.status).toBe(403);
    expect((await response.json<{ error: string }>()).error).toBe('insufficient_permissions');
  });

  it('does not touch the switch for untagged routes, and not for callers with global authority', async () => {
    const down = harness('tenantAdmin', 'down');
    expect((await down.request('GET', '/api/admin/clients')).status).toBe(200);
    expect((await down.request('GET', '/api/admin/jobs')).status).toBe(200);
    expect(down.settingsGet).not.toHaveBeenCalled();

    const platform = harness('platformAdmin', 'down');
    expect((await platform.request('POST', '/api/admin/webhooks')).status).toBe(200);
    expect(platform.settingsGet).not.toHaveBeenCalled();
  });

  it('answers 401 first for an unauthenticated request, without reading the switch', async () => {
    const { request, settingsGet } = harness(null, { webhooks: false });
    const response = await request('POST', '/api/admin/webhooks');
    expect(response.status).toBe(401);
    expect((await response.json<{ error: string }>()).error).toBe('invalid_token');
    expect(settingsGet).not.toHaveBeenCalled();
  });
});
