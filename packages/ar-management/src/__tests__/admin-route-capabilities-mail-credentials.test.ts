/**
 * The route-tagged parts of admin_sent_email (user send-email), machine_credentials (SCIM tokens,
 * Check API keys) and email_provider_config (tenant e-mail settings): while a capability is off the
 * tenant admin is refused at the gate (the handler is never reached), a caller with global
 * platform authority is not, and what does not issue or change anything stays open.
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
  ['admin_sent_email', 'POST', '/api/admin/users/u-1/send-email'],
  ['machine_credentials', 'POST', '/api/admin/scim-tokens'],
  ['machine_credentials', 'POST', '/api/admin/check-api-keys'],
  ['machine_credentials', 'POST', '/api/admin/check-api-keys/key-1/rotate'],
  ['email_provider_config', 'PATCH', '/api/admin/tenants/tenant-a/email-settings'],
];
const OPEN: Array<[string, string]> = [
  ['GET', '/api/admin/scim-tokens'],
  ['DELETE', '/api/admin/scim-tokens/hash-1'],
  ['GET', '/api/admin/check-api-keys'],
  ['GET', '/api/admin/check-api-keys/key-1'],
  ['DELETE', '/api/admin/check-api-keys/key-1'],
  ['GET', '/api/admin/tenants/tenant-a/email-settings'],
  ['GET', '/api/admin/users/u-1'],
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

describe('the route table for the mail and credential capabilities', () => {
  it('tags exactly the routes that send, issue or change the provider, with the catch-all permission', () => {
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
    const sendEmail = findAdminRouteAccessRule('POST', '/api/admin/users/u-1/send-email')!;
    const userWrite = findAdminRouteAccessRule('POST', '/api/admin/users/u-1/status-note')!;
    expect(sendEmail.permissions).toEqual(userWrite.permissions);
    expect(sendEmail.roles).toEqual(userWrite.roles);
  });

  it('tags every registered POST under the SCIM token and Check API key prefixes', () => {
    const routes = managementApp.routes.filter(
      (route) =>
        route.method === 'POST' &&
        (route.path.startsWith('/api/admin/scim-tokens') ||
          route.path.startsWith('/api/admin/check-api-keys'))
    );
    expect(routes.length).toBeGreaterThanOrEqual(3);
    for (const route of routes) {
      expect(findAdminRouteAccessRule('POST', route.path)?.capability, route.path).toBe(
        'machine_credentials'
      );
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
      admin_sent_email: false,
      machine_credentials: false,
      email_provider_config: false,
    });
    expect((await request(method, path)).status).toBe(200);
  });
});
