import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';

const mocked = vi.hoisted(() => ({
  getTenantIdFromContext: vi.fn(),
  createAuthContextFromHono: vi.fn(),
  createAccountAuthContextFromHono: vi.fn(),
  createPIIContextFromHono: vi.fn(),
  resolveAccountDataContextFromHono: vi.fn(),
  hasPIIDatabase: vi.fn(),
  createAuditLogFromContext: vi.fn(async () => undefined),
  invalidateUserCache: vi.fn(async () => undefined),
  invalidateSubjectRBACCache: vi.fn(async () => undefined),
  tenantCoreStores: vi.fn(),
}));

vi.mock('../compliance/tenant-stores', () => ({ tenantCoreStores: mocked.tenantCoreStores }));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    getTenantIdFromContext: mocked.getTenantIdFromContext,
    createAuthContextFromHono: mocked.createAuthContextFromHono,
    createAccountAuthContextFromHono: mocked.createAccountAuthContextFromHono,
    createPIIContextFromHono: mocked.createPIIContextFromHono,
    resolveAccountDataContextFromHono: mocked.resolveAccountDataContextFromHono,
    hasPIIDatabase: mocked.hasPIIDatabase,
    createAuditLogFromContext: mocked.createAuditLogFromContext,
    invalidateUserCache: mocked.invalidateUserCache,
    invalidateSubjectRBACCache: mocked.invalidateSubjectRBACCache,
    CanonicalRuntimeUserStore: class {
      async findById(userId: string) {
        if (userId !== 'user-1' && userId !== '_WdnkLInMNDz8yJNZUlzA') {
          return null;
        }
        return {
          id: userId,
          email: 'member@example.com',
          name: 'Member User',
        };
      }
    },
  };
});

import {
  adminRoleCreateHandler,
  adminUserEffectivePermissionsHandler,
  adminUserRoleAssignHandler,
  adminUserRolesListHandler,
  adminUserRoleRemoveHandler,
} from '../admin-rbac';

// Admin operations are recorded through the forwarding shim (see the helper).
vi.mock('../admin-operation-audit', () => import('./helpers/legacy-admin-audit-shim'));

function createMockAdapter(
  options: {
    queryOne?: (sql: string, params: unknown[]) => unknown | Promise<unknown>;
    query?: (sql: string, params: unknown[]) => unknown[] | Promise<unknown[]>;
  } = {}
): DatabaseAdapter {
  const queryImpl: DatabaseAdapter['query'] = async <T>(
    sql: string,
    params: unknown[] = []
  ): Promise<T[]> => ((await options.query?.(sql, params)) ?? []) as T[];

  const queryOneImpl: DatabaseAdapter['queryOne'] = async <T>(
    sql: string,
    params: unknown[] = []
  ): Promise<T | null> => ((await options.queryOne?.(sql, params)) ?? null) as T | null;

  const transactionImpl: DatabaseAdapter['transaction'] = async <T>(
    fn: Parameters<DatabaseAdapter['transaction']>[0]
  ): Promise<T> => (await fn({} as DatabaseAdapter)) as T;

  return {
    query: vi.fn(queryImpl) as unknown as DatabaseAdapter['query'],
    queryOne: vi.fn(queryOneImpl) as unknown as DatabaseAdapter['queryOne'],
    execute: vi.fn().mockResolvedValue({ rowsAffected: 1, insertId: undefined }),
    transaction: vi.fn(transactionImpl) as unknown as DatabaseAdapter['transaction'],
    batch: vi.fn().mockResolvedValue([]),
    isHealthy: vi.fn().mockResolvedValue(true),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockContext(options: {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  env?: Partial<Env>;
}) {
  const contextStore = new Map<string, unknown>();

  return {
    req: {
      param: vi.fn((name: string) => options.params?.[name]),
      query: vi.fn((name: string) => options.query?.[name]),
      json: vi.fn().mockResolvedValue(options.body ?? {}),
    },
    env: {
      DB: {},
      ...options.env,
    } as Env,
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
    get: vi.fn((key: string) => contextStore.get(key)),
    set: vi.fn((key: string, value: unknown) => contextStore.set(key, value)),
  } as any;
}

describe('admin-rbac schema alignment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.getTenantIdFromContext.mockReturnValue('default');
    mocked.hasPIIDatabase.mockReturnValue(false);
    mocked.createPIIContextFromHono.mockReturnValue({ defaultPiiAdapter: null });
    mocked.createAccountAuthContextFromHono.mockImplementation((...args) =>
      mocked.createAuthContextFromHono(...args)
    );
    mocked.resolveAccountDataContextFromHono.mockImplementation(async (c) => {
      c.set('accountDataContext', { tenantId: 'default', coreDb: {}, piiDb: {} });
    });
  });

  it('resolves the account shard before listing roles for underscore-prefixed user IDs', async () => {
    const coreAdapter = createMockAdapter({ query: () => [] });
    const piiAdapter = createMockAdapter();
    mocked.hasPIIDatabase.mockReturnValue(true);
    mocked.createAuthContextFromHono.mockReturnValue({ coreAdapter });
    mocked.createAccountAuthContextFromHono.mockReturnValue({ coreAdapter });
    mocked.createPIIContextFromHono.mockReturnValue({ defaultPiiAdapter: piiAdapter });
    const c = createMockContext({ params: { id: '_WdnkLInMNDz8yJNZUlzA' } });

    const response = await adminUserRolesListHandler(c);

    expect(response.status).toBe(200);
    expect(mocked.resolveAccountDataContextFromHono).toHaveBeenCalledWith(
      c,
      '_WdnkLInMNDz8yJNZUlzA'
    );
    expect(mocked.resolveAccountDataContextFromHono.mock.invocationCallOrder[0]).toBeLessThan(
      mocked.createPIIContextFromHono.mock.invocationCallOrder[0]
    );
  });

  it('derives effective permissions from tenant-wide role assignments, as tokens do', async () => {
    const coreAdapter = createMockAdapter({
      query: (sql) => {
        if (sql.includes('FROM role_assignments')) {
          return [
            {
              id: 'ra-1',
              role_id: 'role-admin',
              scope_type: 'global',
              scope_target: '',
              expires_at: null,
              assigned_by: null,
              created_at: 1700000000,
            },
            {
              id: 'ra-2',
              role_id: 'role-editor',
              scope_type: 'group',
              scope_target: 'group:grp-1',
              expires_at: null,
              assigned_by: null,
              created_at: 1700000001,
            },
          ];
        }
        if (sql.includes('FROM roles')) {
          return [
            { id: 'role-admin', name: 'admin', permissions_json: '["users:manage"]' },
            { id: 'role-editor', name: 'editor', permissions_json: '["doc:write"]' },
          ];
        }
        return [];
      },
    });

    mocked.createAuthContextFromHono.mockReturnValue({ coreAdapter });
    mocked.hasPIIDatabase.mockReturnValue(true);
    mocked.createPIIContextFromHono.mockReturnValue({ defaultPiiAdapter: createMockAdapter() });

    const c = createMockContext({
      params: { id: 'user-1' },
    });

    const res = await adminUserEffectivePermissionsHandler(c);
    expect(res.status).toBe(200);
    expect(mocked.resolveAccountDataContextFromHono).toHaveBeenCalledWith(c, 'user-1');

    const body = (await res.json()) as {
      permissions: Array<{ permission: string; source: string; source_name: string }>;
      roles: Array<{ role_name: string; scope: string }>;
    };
    // The group-scoped role holds for its group's resources only: not a tenant-wide permission.
    expect(body.permissions).toEqual([
      expect.objectContaining({ permission: 'users:manage', source: 'role', source_name: 'admin' }),
    ]);
    expect(body.roles).toEqual([
      expect.objectContaining({ role_name: 'admin', scope: 'global' }),
      expect.objectContaining({ role_name: 'editor', scope: 'group' }),
    ]);
    expect(body).not.toHaveProperty('organizations');
  });

  it('removes a role assignment of the user only, audits it and drops cached claims', async () => {
    const coreAdapter = createMockAdapter({
      queryOne: (sql) =>
        sql.includes('FROM role_assignments')
          ? { id: 'ra-1', role_id: 'role-1' }
          : sql.includes('FROM roles WHERE tenant_id = ? AND id = ?')
            ? { id: 'role-1', grant_tier: 1 }
            : null,
    });
    mocked.createAuthContextFromHono.mockReturnValue({ coreAdapter });
    const rebacCache = { list: vi.fn(), delete: vi.fn() };
    const c = createMockContext({
      params: { id: 'user-1', assignmentId: 'ra-1' },
      env: { REBAC_CACHE: rebacCache as never },
    });
    c.set('adminAuth', { userId: 'admin-1', maxGrantTier: 1 });

    const res = await adminUserRoleRemoveHandler(c);
    expect(res.status).toBe(200);
    expect(coreAdapter.execute).toHaveBeenCalledWith(
      'DELETE FROM role_assignments WHERE tenant_id = ? AND id = ? AND subject_id = ?',
      ['default', 'ra-1', 'user-1']
    );
    expect(mocked.createAuditLogFromContext).toHaveBeenCalledWith(
      c,
      'role_assignment.removed',
      'role_assignment',
      'ra-1',
      { user_id: 'user-1' },
      'info',
      undefined,
      undefined
    );
    expect(mocked.invalidateSubjectRBACCache).toHaveBeenCalledWith(rebacCache, 'default', 'user-1');
  });

  it('removes an assignment of a role the tenant no longer has', async () => {
    const coreAdapter = createMockAdapter({
      queryOne: (sql) =>
        sql.includes('FROM role_assignments') ? { id: 'ra-1', role_id: 'role-deleted' } : null,
    });
    mocked.createAuthContextFromHono.mockReturnValue({ coreAdapter });
    const c = createMockContext({ params: { id: 'user-1', assignmentId: 'ra-1' } });
    c.set('adminAuth', { userId: 'admin-1', hierarchyLevel: 1 });

    const res = await adminUserRoleRemoveHandler(c);

    expect(res.status).toBe(200);
    expect(coreAdapter.execute).toHaveBeenCalledWith(
      'DELETE FROM role_assignments WHERE tenant_id = ? AND id = ? AND subject_id = ?',
      ['default', 'ra-1', 'user-1']
    );
  });

  it("removes a suspended user's role assignment from its account database", async () => {
    // Account routes refuse a suspended account (of any type, with or without personal data);
    // it is found in the user store that holds it.
    mocked.resolveAccountDataContextFromHono.mockRejectedValue(
      new Error('lookup_destination_revalidation_failed', { cause: 'account_inactive' })
    );
    const metadata = createMockAdapter();
    const otherStore = createMockAdapter();
    const account = createMockAdapter({
      queryOne: (sql) =>
        sql.includes('FROM identity_accounts')
          ? { id: 'account:user-1' }
          : sql.includes('FROM role_assignments')
            ? { id: 'ra-1', role_id: 'role-deleted' }
            : null,
    });
    mocked.tenantCoreStores.mockResolvedValue([
      { bindingRef: 'DB_USERS_0', adapter: otherStore },
      { bindingRef: 'DB_USERS_1', adapter: account },
    ]);
    mocked.createAuthContextFromHono.mockReturnValue({ coreAdapter: metadata });
    const env = {} as never;

    const role = createMockContext({ params: { id: 'user-1', assignmentId: 'ra-1' }, env });
    role.set('adminAuth', { userId: 'admin-1', hierarchyLevel: 1 });
    expect((await adminUserRoleRemoveHandler(role)).status).toBe(200);

    expect(mocked.tenantCoreStores).toHaveBeenCalledWith(
      expect.anything(),
      'default',
      expect.objectContaining({ accountsOfRoutedTenant: true })
    );
    expect(account.execute).toHaveBeenCalledWith(
      'DELETE FROM role_assignments WHERE tenant_id = ? AND id = ? AND subject_id = ?',
      ['default', 'ra-1', 'user-1']
    );
    expect(metadata.execute).not.toHaveBeenCalled();
    expect(otherStore.execute).not.toHaveBeenCalled();
  });

  it('answers not found when removing from an account the tenant does not have', async () => {
    mocked.resolveAccountDataContextFromHono.mockRejectedValue(
      new Error('account_data_route_not_found')
    );
    mocked.createAuthContextFromHono.mockReturnValue({ coreAdapter: createMockAdapter() });
    const c = createMockContext({ params: { id: 'user-x', assignmentId: 'ra-1' } });
    c.set('adminAuth', { userId: 'admin-1', hierarchyLevel: 1 });
    expect((await adminUserRoleRemoveHandler(c)).status).toBe(404);
    expect(mocked.tenantCoreStores).not.toHaveBeenCalled();
  });

  it('rejects assigning a role above the caller grant tier, whatever its hierarchy level', async () => {
    const coreAdapter = createMockAdapter({
      queryOne: (sql, params) => {
        if (sql.includes('FROM roles WHERE tenant_id = ? AND id = ?')) {
          expect(params).toEqual(['default', 'role-peer']);
          return {
            id: 'role-peer',
            name: 'peer',
            grant_tier: 3,
            is_assignable: 1,
          };
        }
        return null;
      },
    });

    mocked.createAuthContextFromHono.mockReturnValue({ coreAdapter });
    mocked.hasPIIDatabase.mockReturnValue(true);
    mocked.createPIIContextFromHono.mockReturnValue({ defaultPiiAdapter: createMockAdapter() });

    const c = createMockContext({
      params: { id: 'user-1' },
      body: { role_id: 'role-peer' },
    });
    c.set('adminAuth', {
      userId: 'admin-1',
      authMethod: 'session',
      roles: ['admin'],
      permissions: ['admin:roles:write'],
      hierarchyLevel: 100,
      maxGrantTier: 2,
    });

    const res = await adminUserRoleAssignHandler(c);

    expect(res.status).toBe(403);
    expect(coreAdapter.execute).not.toHaveBeenCalled();
  });

  it.each([0, false])('rejects assigning a role that is not assignable (%s)', async (flag) => {
    const coreAdapter = createMockAdapter({
      queryOne: (sql) =>
        sql.includes('FROM roles WHERE tenant_id = ? AND id = ?')
          ? { id: 'role-fixed', name: 'fixed', grant_tier: 1, is_assignable: flag }
          : null,
    });

    mocked.createAuthContextFromHono.mockReturnValue({ coreAdapter });
    mocked.hasPIIDatabase.mockReturnValue(true);
    mocked.createPIIContextFromHono.mockReturnValue({ defaultPiiAdapter: createMockAdapter() });

    const c = createMockContext({
      params: { id: 'user-1' },
      body: { role_id: 'role-fixed' },
    });
    c.set('adminAuth', {
      userId: 'admin-1',
      authMethod: 'session',
      roles: ['admin'],
      permissions: ['admin:roles:write'],
      hierarchyLevel: 100,
      maxGrantTier: 2,
    });

    const res = await adminUserRoleAssignHandler(c);

    expect(res.status).toBe(403);
    expect(coreAdapter.execute).not.toHaveBeenCalled();
  });

  it.each([
    [1, 201],
    [2, 201],
    [3, 403],
  ])('checks grant tier %i against the caller ceiling (2)', async (tier, status) => {
    const coreAdapter = createMockAdapter({
      queryOne: (sql, params) => {
        if (sql.includes('FROM roles WHERE tenant_id = ? AND id = ?')) {
          expect(params).toEqual(['default', 'role-lower']);
          return {
            id: 'role-lower',
            grant_tier: tier,
            name: 'lower',
            is_assignable: 1,
          };
        }
        if (sql.includes('SELECT id FROM role_assignments')) {
          return null;
        }
        return null;
      },
    });

    mocked.createAuthContextFromHono.mockReturnValue({ coreAdapter });
    mocked.hasPIIDatabase.mockReturnValue(true);
    mocked.createPIIContextFromHono.mockReturnValue({ defaultPiiAdapter: createMockAdapter() });

    const c = createMockContext({
      params: { id: 'user-1' },
      body: { role_id: 'role-lower' },
    });
    c.set('adminAuth', {
      userId: 'admin-1',
      authMethod: 'session',
      roles: ['admin'],
      permissions: ['admin:roles:write'],
      hierarchyLevel: 100,
      maxGrantTier: 2,
    });

    const res = await adminUserRoleAssignHandler(c);

    expect(res.status).toBe(status);
    if (status === 403) {
      expect(coreAdapter.execute).not.toHaveBeenCalled();
      return;
    }
    expect(coreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO role_assignments'),
      expect.arrayContaining(['default', 'user-1', 'role-lower'])
    );
  });

  it.each([
    [{ scope: 'global', scope_target: 'x' }, 400],
    [{ scope: 'org', scope_target: 'org:o1' }, 400],
    [{ scope: 'group', scope_target: 'grp-1' }, 400],
    [{ scope: 'group', scope_target: 'group:grp-missing' }, 400],
    [{ scope: 'tenant', scope_target: 'other-tenant' }, 400],
    [{ scope: 'resource', scope_target: 'resource:doc:1' }, 201],
    [{ scope: 'group', scope_target: 'group:grp-1' }, 201],
  ])('checks the scope and target of a direct grant %j', async (scope, status) => {
    const coreAdapter = createMockAdapter({
      queryOne: (sql, params) => {
        if (sql.includes('FROM roles WHERE tenant_id = ? AND id = ?'))
          return { id: 'role-lower', grant_tier: 1, name: 'lower', is_assignable: 1 };
        if (sql.includes('FROM "groups"')) return params[1] === 'grp-1' ? { id: 'grp-1' } : null;
        return null;
      },
    });
    mocked.createAuthContextFromHono.mockReturnValue({ coreAdapter });
    mocked.hasPIIDatabase.mockReturnValue(true);
    mocked.createPIIContextFromHono.mockReturnValue({ defaultPiiAdapter: createMockAdapter() });
    const c = createMockContext({
      params: { id: 'user-1' },
      body: { role_id: 'role-lower', ...scope },
    });
    (c as { set: (key: string, value: unknown) => void }).set('adminAuth', {
      userId: 'admin-1',
      authMethod: 'session',
      roles: ['admin'],
      permissions: ['admin:roles:write'],
      maxGrantTier: 2,
    });
    const res = await adminUserRoleAssignHandler(c);
    expect(res.status).toBe(status);
    if (status === 400) expect(coreAdapter.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['milliseconds', () => Date.now() + 3_600_000, 400],
    ['a past time', () => Math.floor(Date.now() / 1000) - 60, 400],
    ['a fraction', () => Math.floor(Date.now() / 1000) + 60.5, 400],
    ['a string', () => String(Math.floor(Date.now() / 1000) + 60), 400],
    ['seconds', () => Math.floor(Date.now() / 1000) + 3600, 201],
  ])('takes expires_at of a direct grant in Unix seconds (%s)', async (_, value, status) => {
    const expiresAt = value();
    const coreAdapter = createMockAdapter({
      queryOne: (sql) =>
        sql.includes('FROM roles WHERE tenant_id = ? AND id = ?')
          ? { id: 'role-lower', grant_tier: 1, name: 'lower', is_assignable: 1 }
          : null,
    });
    mocked.createAuthContextFromHono.mockReturnValue({ coreAdapter });
    mocked.hasPIIDatabase.mockReturnValue(true);
    mocked.createPIIContextFromHono.mockReturnValue({ defaultPiiAdapter: createMockAdapter() });
    const c = createMockContext({
      params: { id: 'user-1' },
      body: { role_id: 'role-lower', expires_at: expiresAt },
    });
    (c as { set: (key: string, value: unknown) => void }).set('adminAuth', {
      userId: 'admin-1',
      authMethod: 'session',
      roles: ['admin'],
      permissions: ['admin:roles:write'],
      maxGrantTier: 2,
    });
    const res = await adminUserRoleAssignHandler(c);
    expect(res.status).toBe(status);
    if (status === 400) {
      expect(coreAdapter.execute).not.toHaveBeenCalled();
      return;
    }
    // Stored and answered as sent: seconds.
    expect(coreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO role_assignments'),
      expect.arrayContaining([expiresAt])
    );
    const body = (await res.json()) as { assignment: { expires_at: number } };
    expect(body.assignment.expires_at).toBe(expiresAt);
  });

  it('lists direct role assignments with expires_at in Unix seconds', async () => {
    const coreAdapter = createMockAdapter({
      query: (sql) => {
        if (sql.includes('FROM role_assignments')) {
          return [
            {
              id: 'ra-1',
              role_id: 'role-admin',
              scope_type: 'global',
              scope_target: '',
              expires_at: '1900000000',
              assigned_by: null,
              created_at: 1700000000,
            },
          ];
        }
        if (sql.includes('FROM roles')) {
          return [{ id: 'role-admin', name: 'admin', permissions_json: '["users:manage"]' }];
        }
        return [];
      },
    });
    mocked.hasPIIDatabase.mockReturnValue(true);
    mocked.createAuthContextFromHono.mockReturnValue({ coreAdapter });
    mocked.createAccountAuthContextFromHono.mockReturnValue({ coreAdapter });
    mocked.createPIIContextFromHono.mockReturnValue({ defaultPiiAdapter: createMockAdapter() });
    const res = await adminUserRolesListHandler(createMockContext({ params: { id: 'user-1' } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      roles: Array<{ expires_at: number | null; created_at: number }>;
    };
    expect(body.roles[0]).toMatchObject({ expires_at: 1900000000, created_at: 1700000000000 });
  });

  it.each([
    ['["*"]', 2, 409],
    ['["*:*"]', 1, 409],
    ['["docs:*"]', 1, 409],
    ['["docs:*"]', 2, 201],
    ['["*"]', 3, 201],
  ])(
    'checks a stored %s role of grant tier %i against its wildcard floor at assignment',
    async (permissionsJson, tier, status) => {
      const coreAdapter = createMockAdapter({
        queryOne: (sql) =>
          sql.includes('FROM roles WHERE tenant_id = ? AND id = ?')
            ? {
                id: 'role-wild',
                grant_tier: tier,
                name: 'wild',
                is_assignable: 1,
                permissions_json: permissionsJson,
              }
            : null,
      });
      mocked.createAuthContextFromHono.mockReturnValue({ coreAdapter });
      mocked.hasPIIDatabase.mockReturnValue(true);
      mocked.createPIIContextFromHono.mockReturnValue({ defaultPiiAdapter: createMockAdapter() });
      const c = createMockContext({ params: { id: 'user-1' }, body: { role_id: 'role-wild' } });
      (c as { set: (key: string, value: unknown) => void }).set('adminAuth', {
        userId: 'admin-1',
        authMethod: 'session',
        roles: ['admin'],
        permissions: ['admin:roles:write'],
        maxGrantTier: 3,
      });
      const res = await adminUserRoleAssignHandler(c);
      expect(res.status).toBe(status);
      if (status === 409) {
        await expect(res.json()).resolves.toMatchObject({
          error: 'role_grant_tier_below_wildcard',
        });
        expect(coreAdapter.execute).not.toHaveBeenCalled();
      }
    }
  );

  it('lists effective permissions with expires_at in Unix seconds', async () => {
    const coreAdapter = createMockAdapter({
      query: (sql) => {
        if (sql.includes('FROM role_assignments')) {
          return [
            {
              id: 'ra-1',
              role_id: 'role-admin',
              scope_type: 'global',
              scope_target: '',
              expires_at: 1900000000,
              assigned_by: null,
              created_at: 1700000000,
            },
          ];
        }
        if (sql.includes('FROM roles')) {
          return [{ id: 'role-admin', name: 'admin', permissions_json: '["users:manage"]' }];
        }
        return [];
      },
    });
    mocked.createAuthContextFromHono.mockReturnValue({ coreAdapter });
    mocked.hasPIIDatabase.mockReturnValue(true);
    mocked.createPIIContextFromHono.mockReturnValue({ defaultPiiAdapter: createMockAdapter() });
    const res = await adminUserEffectivePermissionsHandler(
      createMockContext({ params: { id: 'user-1' } })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      permissions: Array<{ expires_at: number | null }>;
      roles: Array<{ expires_at: number | null; granted_at: number }>;
    };
    expect(body.permissions[0].expires_at).toBe(1900000000);
    expect(body.roles[0]).toMatchObject({ expires_at: 1900000000, granted_at: 1700000000000 });
  });

  it('rejects creating a role without a grant tier ceiling', async () => {
    const coreAdapter = createMockAdapter();
    mocked.createAuthContextFromHono.mockReturnValue({ coreAdapter });

    const c = createMockContext({
      body: {
        name: 'peer_role',
        permissions: ['documents:read'],
      },
    });
    c.set('adminAuth', {
      userId: 'admin-1',
      authMethod: 'session',
      roles: ['admin'],
      permissions: ['admin:roles:write'],
      hierarchyLevel: 100,
      maxGrantTier: 0,
    });

    const res = await adminRoleCreateHandler(c);

    expect(res.status).toBe(403);
    expect(coreAdapter.execute).not.toHaveBeenCalled();
  });
});
