import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { ADMIN_PERMISSIONS, type AdminAuthContext, type Env } from '@authrim/ar-lib-core';

const service = vi.hoisted(() => ({
  getTokenRefreshConfig: vi.fn(async () => ({ enabled: true })),
  setTokenRefreshConfig: vi.fn(async (_env: unknown, body: unknown) => body),
  listTokenRefreshRuns: vi.fn(async () => []),
  refreshExpiringTokensForTenantManual: vi.fn(async () => ({ refreshed: 0 })),
}));
vi.mock('../services/token-refresh', () => service);

import {
  handleAdminGetTokenRefreshConfig,
  handleAdminListTokenRefreshRuns,
  handleAdminUpdateTokenRefreshConfig,
} from '../admin/token-refresh';

/**
 * The refresh config is one document shared by every tenant, so a tenant administrator who holds
 * the permission for its own tenant must not read or change it.
 */

function app(auth: Partial<AdminAuthContext>) {
  const instance = new Hono<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>();
  instance.use('*', async (c, next) => {
    c.set('adminAuth', {
      userId: 'admin',
      authMethod: 'session',
      roles: [],
      permissions: [],
      hierarchyLevel: 0,
      mfaVerified: true,
      ...auth,
    } as AdminAuthContext);
    await next();
  });
  instance.get('/config', handleAdminGetTokenRefreshConfig as never);
  instance.put('/config', handleAdminUpdateTokenRefreshConfig as never);
  instance.get('/runs', handleAdminListTokenRefreshRuns as never);
  return instance;
}

const request = (instance: ReturnType<typeof app>, method: 'GET' | 'PUT') =>
  instance.request('/config', {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'PUT' ? JSON.stringify({ enabled: false }) : undefined,
  });

const permissions = [
  ADMIN_PERMISSIONS.EXTERNAL_TOKEN_REFRESH_READ,
  ADMIN_PERMISSIONS.EXTERNAL_TOKEN_REFRESH_WRITE,
];

describe('external token refresh config', () => {
  it('is refused to a tenant administrator that holds the permission for its tenant only', async () => {
    const tenantAdmin = app({
      roles: ['ar_tenant_admin'],
      permissions,
      tenantScope: ['tenant-a'],
      globalRoles: [],
      globalPermissions: [],
    });

    expect((await request(tenantAdmin, 'GET')).status).toBe(403);
    expect((await request(tenantAdmin, 'PUT')).status).toBe(403);
    expect(service.setTokenRefreshConfig).not.toHaveBeenCalled();
  });

  it('is refused to a global tenant administrator too: the permission is not the platform role', async () => {
    const globalTenantAdmin = app({
      roles: ['ar_tenant_admin'],
      permissions,
      tenantScope: ['*'],
      globalRoles: ['ar_tenant_admin'],
      globalPermissions: permissions,
    });

    expect((await request(globalTenantAdmin, 'PUT')).status).toBe(403);
  });

  it('is open to the super admin held through a global assignment', async () => {
    const superAdmin = app({
      roles: ['ar_super_admin'],
      permissions: ['*'],
      tenantScope: ['*'],
      globalRoles: ['ar_super_admin'],
      globalPermissions: ['*'],
    });

    expect((await request(superAdmin, 'GET')).status).toBe(200);
    expect((await request(superAdmin, 'PUT')).status).toBe(200);
    expect(service.setTokenRefreshConfig).toHaveBeenCalledTimes(1);
  });
});

describe('external token refresh runs', () => {
  it('are shown to a tenant administrator as its own part, and whole to the super admin', async () => {
    const tenantAdmin = app({
      roles: ['ar_tenant_admin'],
      permissions,
      tenantScope: ['tenant-a'],
      globalRoles: [],
      globalPermissions: [],
    });
    const superAdmin = app({
      roles: ['ar_super_admin'],
      permissions: ['*'],
      tenantScope: ['*'],
      globalRoles: ['ar_super_admin'],
      globalPermissions: ['*'],
    });

    await tenantAdmin.request('/runs');
    await superAdmin.request('/runs');

    const views = service.listTokenRefreshRuns.mock.calls.map((call) => (call as unknown[])[3]);
    expect(views).toEqual(['tenant', 'platform']);
  });
});
