/**
 * Admin API for external IdP token refresh: authentication, permissions, platform authority,
 * run listing and the manual run.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_PERMISSIONS, type AdminAuthContext, type Env } from '@authrim/ar-lib-core';
import { argRec, callArg } from './helpers/mock-args';

const service = vi.hoisted(() => ({
  getTokenRefreshConfig: vi.fn(),
  setTokenRefreshConfig: vi.fn(),
  listTokenRefreshRuns: vi.fn(),
  refreshExpiringTokensForTenantManual: vi.fn(),
}));
vi.mock('../services/token-refresh', () => service);
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getTenantIdFromContext: () => 'tenant-a',
}));

import {
  handleAdminGetTokenRefreshConfig,
  handleAdminListTokenRefreshRuns,
  handleAdminRunTokenRefresh,
  handleAdminUpdateTokenRefreshConfig,
} from '../admin/token-refresh';

const READ = ADMIN_PERMISSIONS.EXTERNAL_TOKEN_REFRESH_READ;
const WRITE = ADMIN_PERMISSIONS.EXTERNAL_TOKEN_REFRESH_WRITE;
const RUN = ADMIN_PERMISSIONS.EXTERNAL_TOKEN_REFRESH_RUN;
const ENV = {} as Env;

const platformAdmin = (): Partial<AdminAuthContext> => ({
  roles: ['ar_super_admin'],
  permissions: ['*'],
  tenantScope: ['*'],
  globalRoles: ['ar_super_admin'],
  globalPermissions: ['*'],
});
const tenantAdmin = (permissions: string[]): Partial<AdminAuthContext> => ({
  roles: ['ar_tenant_admin'],
  permissions,
  tenantScope: ['tenant-a'],
  globalRoles: [],
  globalPermissions: [],
});

function app(auth: Partial<AdminAuthContext> | null) {
  const instance = new Hono<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>();
  instance.use('*', async (c, next) => {
    if (auth) {
      c.set('adminAuth', {
        userId: 'admin-1',
        actorType: 'admin_user',
        actorId: 'admin-1',
        authMethod: 'session',
        roles: [],
        permissions: [],
        hierarchyLevel: 0,
        mfaVerified: true,
        ...auth,
      } as AdminAuthContext);
    }
    await next();
  });
  instance.get('/config', handleAdminGetTokenRefreshConfig);
  instance.put('/config', handleAdminUpdateTokenRefreshConfig);
  instance.get('/runs', handleAdminListTokenRefreshRuns);
  instance.post('/run', handleAdminRunTokenRefresh);
  return instance;
}

const call = (
  auth: Partial<AdminAuthContext> | null,
  method: string,
  path: string,
  body?: string
) =>
  Promise.resolve(
    app(auth).request(
      `https://admin.example.com${path}`,
      { method, headers: { 'Content-Type': 'application/json' }, body },
      ENV
    )
  );

beforeEach(() => {
  vi.clearAllMocks();
  service.getTokenRefreshConfig.mockResolvedValue({ enabled: true });
  service.setTokenRefreshConfig.mockImplementation(async (_env: unknown, body: unknown) => body);
  service.listTokenRefreshRuns.mockResolvedValue([{ id: 'run-1' }]);
  service.refreshExpiringTokensForTenantManual.mockResolvedValue({
    runId: 'run-2',
    tenantId: 'tenant-a',
    tokensRefreshed: 3,
    status: 'completed',
  });
});

describe('authentication and permissions', () => {
  const endpoints: Array<[string, string, string, string?]> = [
    ['get config', 'GET', '/config'],
    ['update config', 'PUT', '/config', '{}'],
    ['list runs', 'GET', '/runs'],
    ['run', 'POST', '/run'],
  ];

  it.each(endpoints)('%s requires an authenticated admin', async (_name, method, path, body) => {
    expect((await call(null, method, path, body)).status).toBe(401);
  });

  it.each(endpoints)('%s requires its permission', async (_name, method, path, body) => {
    expect((await call(tenantAdmin([]), method, path, body)).status).toBe(403);
  });

  it('keeps each permission to its own endpoint', async () => {
    expect((await call(tenantAdmin([READ]), 'POST', '/run')).status).toBe(403);
    expect((await call(tenantAdmin([RUN]), 'GET', '/runs')).status).toBe(403);
    expect((await call(tenantAdmin([READ]), 'PUT', '/config', '{}')).status).toBe(403);
    expect((await call(tenantAdmin([WRITE]), 'GET', '/config')).status).toBe(403);
  });

  it('treats a missing permission list as no permissions', async () => {
    expect((await call({ permissions: undefined }, 'GET', '/runs')).status).toBe(403);
  });
});

describe('config', () => {
  it('shows the shared config to the platform only', async () => {
    const response = await call(platformAdmin(), 'GET', '/config');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ config: { enabled: true } });
    expect(callArg(service.getTokenRefreshConfig, 0, 0)).toBe(ENV);
    expect((await call(tenantAdmin([READ]), 'GET', '/config')).status).toBe(403);
    expect(service.getTokenRefreshConfig).toHaveBeenCalledTimes(1);
  });

  it('saves a new config and returns what was stored', async () => {
    const response = await call(platformAdmin(), 'PUT', '/config', '{"enabled":false,"batch":5}');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ config: { enabled: false, batch: 5 } });
    expect(callArg(service.setTokenRefreshConfig, 0, 0)).toBe(ENV);
    expect(callArg(service.setTokenRefreshConfig, 0, 1)).toEqual({ enabled: false, batch: 5 });
    expect((await call(tenantAdmin([WRITE]), 'PUT', '/config', '{}')).status).toBe(403);
  });

  it('answers 400 for a body that is not JSON or a config the service refuses', async () => {
    expect((await call(platformAdmin(), 'PUT', '/config', '{nope')).status).toBe(400);
    service.setTokenRefreshConfig.mockRejectedValue(new Error('invalid'));
    expect((await call(platformAdmin(), 'PUT', '/config', '{}')).status).toBe(400);
  });
});

describe('runs', () => {
  it('lists the runs of the tenant, whole for the platform and in part for a tenant admin', async () => {
    const platform = await call(platformAdmin(), 'GET', '/runs');
    expect(await platform.json()).toEqual({ runs: [{ id: 'run-1' }] });
    expect(service.listTokenRefreshRuns).toHaveBeenLastCalledWith(ENV, 'tenant-a', 50, 'platform');
    await call(tenantAdmin([READ]), 'GET', '/runs');
    expect(service.listTokenRefreshRuns).toHaveBeenLastCalledWith(ENV, 'tenant-a', 50, 'tenant');
  });

  it('takes the limit from the query', async () => {
    await call(platformAdmin(), 'GET', '/runs?limit=7');
    expect(callArg(service.listTokenRefreshRuns, 0, 2)).toBe(7);
    await call(platformAdmin(), 'GET', '/runs?limit=abc');
    expect(callArg(service.listTokenRefreshRuns, 1, 2)).toBeNaN();
  });
});

describe('manual run', () => {
  it('refreshes the tenant tokens as the calling admin', async () => {
    const response = await call(tenantAdmin([RUN]), 'POST', '/run');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runId: 'run-2',
      tenantId: 'tenant-a',
      tokensRefreshed: 3,
      status: 'completed',
    });
    expect(callArg(service.refreshExpiringTokensForTenantManual, 0, 0)).toBe(ENV);
    expect(callArg(service.refreshExpiringTokensForTenantManual, 0, 1)).toBe('tenant-a');
    expect(argRec(service.refreshExpiringTokensForTenantManual, 0, 2)).toMatchObject({
      actorId: 'admin-1',
      permissions: [RUN],
    });
  });

  it('answers 500 when the run fails, without detail', async () => {
    service.refreshExpiringTokensForTenantManual.mockRejectedValue(new Error('secret detail'));
    const response = await call(tenantAdmin([RUN]), 'POST', '/run');
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('secret detail');
  });
});
