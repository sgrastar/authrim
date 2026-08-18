import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';

const mocked = vi.hoisted(() => ({
  getTenantIdFromContext: vi.fn(),
  createAuthContextFromHono: vi.fn(),
  createAccountAuthContextFromHono: vi.fn(),
  createPIIContextFromHono: vi.fn(),
  resolveAccountDataContextFromHono: vi.fn(),
  hasPIIDatabase: vi.fn(),
}));

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
  adminOrganizationHierarchyHandler,
  adminOrganizationMemberAddHandler,
  adminOrganizationMemberRemoveHandler,
  adminOrganizationMembersListHandler,
  adminUserEffectivePermissionsHandler,
  adminUserRoleAssignHandler,
  adminUserRolesListHandler,
} from '../admin-rbac';

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
      mocked.createPIIContextFromHono.mock.invocationCallOrder[0]!
    );
  });

  it('uses subject_org_membership for organization hierarchy member counts', async () => {
    const coreAdapter = createMockAdapter({
      queryOne: (sql, params) => {
        if (sql.includes('FROM organizations WHERE id = ? AND tenant_id = ?')) {
          expect(params).toEqual(['org-root', 'default']);
          return {
            id: 'org-root',
            name: 'Root',
            display_name: 'Root Org',
            parent_id: null,
            is_active: 1,
          };
        }
        return null;
      },
      query: (sql, params) => {
        if (sql.includes('WITH RECURSIVE org_tree')) {
          return [
            {
              id: 'org-root',
              name: 'Root',
              display_name: 'Root Org',
              parent_id: null,
              is_active: 1,
              depth: 0,
            },
            {
              id: 'org-child',
              name: 'Child',
              display_name: 'Child Org',
              parent_id: 'org-root',
              is_active: 1,
              depth: 1,
            },
          ];
        }

        if (sql.includes('FROM subject_org_membership')) {
          expect(sql).not.toContain('organization_members');
          expect(params).toEqual(['default', 'org-root', 'org-child']);
          return [
            { org_id: 'org-root', count: 2 },
            { org_id: 'org-child', count: 1 },
          ];
        }

        return [];
      },
    });

    mocked.createAuthContextFromHono.mockReturnValue({ coreAdapter });

    const c = createMockContext({
      params: { id: 'org-root' },
    });

    const res = await adminOrganizationHierarchyHandler(c);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      summary: { total_members: number; total_organizations: number };
    };
    expect(body.summary).toMatchObject({
      total_members: 3,
      total_organizations: 2,
    });
  });

  it('uses subject_org_membership and membership_type to resolve organization permissions', async () => {
    const coreAdapter = createMockAdapter({
      queryOne: (sql, params) => {
        return null;
      },
      query: (sql, params) => {
        if (sql.includes('FROM user_roles ur')) {
          return [];
        }

        if (sql.includes('FROM subject_org_membership om')) {
          expect(sql).not.toContain('organization_members');
          expect(sql).toContain('LEFT JOIN roles r ON r.name = om.membership_type');
          expect(params).toEqual(['user-1', 'default']);
          return [
            {
              org_id: 'org-1',
              org_name: 'Acme Org',
              role_id: 'role-admin',
              role_name: 'Admin',
              membership_type: 'admin',
              joined_at: 1700000000,
            },
          ];
        }

        if (sql.includes('SELECT permission FROM role_permissions WHERE role_id = ?')) {
          expect(params).toEqual(['role-admin']);
          return [{ permission: 'org:manage' }];
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

    const body = (await res.json()) as {
      permissions: Array<{ permission: string; source: string; source_name: string }>;
      summary: { from_organizations: number };
    };
    expect(body.permissions).toContainEqual(
      expect.objectContaining({
        permission: 'org:manage',
        source: 'organization',
        source_name: 'Acme Org (Admin)',
      })
    );
    expect(body.summary.from_organizations).toBe(1);
  });

  it('lists organization members with membership_type and tenant-scoped pii lookup', async () => {
    const piiAdapter = createMockAdapter({
      query: (sql, params) => {
        if (sql.includes('FROM users_pii WHERE tenant_id = ? AND id IN')) {
          expect(params).toEqual(['default', 'user-1']);
          return [{ id: 'user-1', email: 'member@example.com', name: 'Member User' }];
        }
        return [];
      },
    });

    const coreAdapter = createMockAdapter({
      queryOne: (sql, params) => {
        if (sql.includes('SELECT id FROM organizations WHERE tenant_id = ? AND id = ?')) {
          expect(params).toEqual(['default', 'org-1']);
          return { id: 'org-1' };
        }
        if (sql.includes('COUNT(*) as count FROM subject_org_membership')) {
          expect(params).toEqual(['default', 'org-1']);
          return { count: 1 };
        }
        return null;
      },
      query: (sql, params) => {
        if (sql.includes('FROM subject_org_membership m')) {
          expect(params).toEqual(['default', 'org-1', 20, 0]);
          return [
            {
              subject_id: 'user-1',
              org_id: 'org-1',
              membership_type: 'owner',
              is_primary: 1,
              created_at: 1700000000,
            },
          ];
        }
        return [];
      },
    });

    mocked.hasPIIDatabase.mockReturnValue(true);
    mocked.createAuthContextFromHono.mockReturnValue({ coreAdapter });
    mocked.createPIIContextFromHono.mockReturnValue({ defaultPiiAdapter: piiAdapter });

    const c = createMockContext({
      params: { id: 'org-1' },
      query: { page: '1', limit: '20' },
    });

    const res = await adminOrganizationMembersListHandler(c);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      members: Array<{ subject_id: string; membership_type: string; user_email: string | null }>;
    };
    expect(body.members).toEqual([
      expect.objectContaining({
        subject_id: 'user-1',
        membership_type: 'owner',
        user_email: 'member@example.com',
      }),
    ]);
  });

  it('adds organization members with membership_type and tenant-scoped guards', async () => {
    const coreAdapter = createMockAdapter({
      queryOne: (sql, params) => {
        if (sql.includes('SELECT id FROM organizations WHERE id = ? AND tenant_id = ?')) {
          expect(params).toEqual(['org-1', 'default']);
          return { id: 'org-1' };
        }
        if (sql.includes('SELECT subject_id FROM subject_org_membership')) {
          expect(params).toEqual(['default', 'org-1', 'user-1']);
          return null;
        }
        return null;
      },
    });

    mocked.createAuthContextFromHono.mockReturnValue({ coreAdapter });
    mocked.hasPIIDatabase.mockReturnValue(true);
    mocked.createPIIContextFromHono.mockReturnValue({ defaultPiiAdapter: createMockAdapter() });

    const c = createMockContext({
      params: { id: 'org-1' },
      body: {
        subject_id: 'user-1',
        membership_type: 'admin',
        is_primary: true,
      },
    });

    const res = await adminOrganizationMemberAddHandler(c);
    expect(res.status).toBe(201);

    const executeCalls = (coreAdapter.execute as any).mock.calls as Array<[string, unknown[]]>;
    expect(executeCalls).toContainEqual([
      expect.stringContaining('UPDATE subject_org_membership'),
      [expect.any(Number), 'default', 'user-1'],
    ]);
    expect(executeCalls).toContainEqual([
      expect.stringContaining('INSERT INTO subject_org_membership'),
      [
        expect.any(String),
        'default',
        'user-1',
        'org-1',
        'admin',
        1,
        expect.any(Number),
        expect.any(Number),
      ],
    ]);

    const body = (await res.json()) as {
      membership: { tenant_id: string; membership_type: string; subject_id: string };
    };
    expect(body.membership).toMatchObject({
      tenant_id: 'default',
      membership_type: 'admin',
      subject_id: 'user-1',
    });
  });

  it('removes organization members with tenant-scoped checks and delete', async () => {
    const coreAdapter = createMockAdapter({
      queryOne: (sql, params) => {
        if (sql.includes('SELECT subject_id FROM subject_org_membership')) {
          expect(params).toEqual(['default', 'org-1', 'user-1']);
          return { subject_id: 'user-1' };
        }
        return null;
      },
    });

    mocked.createAuthContextFromHono.mockReturnValue({ coreAdapter });

    const c = createMockContext({
      params: { id: 'org-1', subjectId: 'user-1' },
    });

    const res = await adminOrganizationMemberRemoveHandler(c);
    expect(res.status).toBe(200);
    expect(coreAdapter.execute).toHaveBeenCalledWith(
      'DELETE FROM subject_org_membership WHERE tenant_id = ? AND org_id = ? AND subject_id = ?',
      ['default', 'org-1', 'user-1']
    );
  });

  it('rejects assigning a role at the caller hierarchy level', async () => {
    const coreAdapter = createMockAdapter({
      queryOne: (sql, params) => {
        if (sql.includes('SELECT * FROM roles WHERE id = ? AND tenant_id = ?')) {
          expect(params).toEqual(['role-peer', 'default']);
          return {
            id: 'role-peer',
            name: 'peer',
            hierarchy_level: 50,
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
      hierarchyLevel: 50,
    });

    const res = await adminUserRoleAssignHandler(c);

    expect(res.status).toBe(403);
    expect(coreAdapter.execute).not.toHaveBeenCalled();
  });

  it('allows assigning a lower hierarchy role', async () => {
    const coreAdapter = createMockAdapter({
      queryOne: (sql, params) => {
        if (sql.includes('SELECT * FROM roles WHERE id = ? AND tenant_id = ?')) {
          expect(params).toEqual(['role-lower', 'default']);
          return {
            id: 'role-lower',
            name: 'lower',
            hierarchy_level: 10,
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
      hierarchyLevel: 50,
    });

    const res = await adminUserRoleAssignHandler(c);

    expect(res.status).toBe(201);
    expect(coreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO role_assignments'),
      expect.arrayContaining(['default', 'user-1', 'role-lower'])
    );
  });

  it('rejects creating a role at the caller hierarchy level', async () => {
    const coreAdapter = createMockAdapter();
    mocked.createAuthContextFromHono.mockReturnValue({ coreAdapter });

    const c = createMockContext({
      body: {
        name: 'peer_role',
        permissions: ['documents:read'],
        hierarchy_level: 50,
      },
    });
    c.set('adminAuth', {
      userId: 'admin-1',
      authMethod: 'session',
      roles: ['admin'],
      permissions: ['admin:roles:write'],
      hierarchyLevel: 50,
    });

    const res = await adminRoleCreateHandler(c);

    expect(res.status).toBe(403);
    expect(coreAdapter.execute).not.toHaveBeenCalled();
  });
});
