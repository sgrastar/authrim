/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AdminAuthContext, DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import { openCoreStore } from './helpers/core-schema-sqlite';

const mocked = vi.hoisted(() => ({
  stores: null as unknown as {
    metadata: DatabaseAdapter;
    accounts: DatabaseAdapter[];
    routed: boolean;
  },
  /** The account database of a subject; the one resolved last is the request's account. */
  routeOf: function (_id: string): number {
    return 0;
  },
  current: null as DatabaseAdapter | null,
  audit: vi.fn(async () => 'audit-id'),
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    getTenantIdFromContext: () => 'tenant-a',
    createAuthContextFromHono: () => ({ coreAdapter: mocked.stores.metadata }),
    createAccountAuthContextFromHono: () => ({
      coreAdapter: mocked.current ?? mocked.stores.accounts[0],
    }),
    createPIIContextFromHono: () => ({ defaultPiiAdapter: {} }),
    getAccountDataContextFromHono: () => ({}),
    hasPIIDatabase: () => false,
    resolveAccountDataContextFromHono: async (_c: unknown, userId: string) => {
      if (userId.startsWith('ghost')) throw new Error('account_data_route_not_found');
      if (userId.startsWith('inactive'))
        throw Object.assign(new Error('lookup_destination_revalidation_failed'), {
          cause: 'account_inactive',
        });
      mocked.current = mocked.stores.accounts[mocked.routeOf(userId)];
    },
    CanonicalRuntimeUserStore: class {
      async findById(userId: string) {
        return userId.startsWith('user-')
          ? { id: userId, email: `${userId}@example.com`, name: `Name ${userId}` }
          : null;
      }
    },
  };
});

vi.mock('../rbac-account-stores', async () => {
  const actual =
    await vi.importActual<typeof import('../rbac-account-stores')>('../rbac-account-stores');
  return {
    ...actual,
    routedSubjectContacts: async (_env: unknown, _tenant: string, ids: string[]) =>
      new Map(ids.map((id) => [id, { email: `${id}@example.com`, name: `Name ${id}` }])),
    tenantRBACStores: async () => ({
      metadata: mocked.stores.metadata,
      accounts: mocked.stores.accounts,
      routed: mocked.stores.routed,
    }),
  };
});

vi.mock('../admin-operation-audit', () => ({ recordAdminOperationAudit: mocked.audit }));

import {
  ADMIN_PERMISSIONS,
  hasAdminPermission,
  requireAdminPermissions,
} from '@authrim/ar-lib-core';
import {
  adminGroupCreateHandler,
  adminGroupDeleteHandler,
  adminGroupGetHandler,
  adminGroupMemberAddHandler,
  adminGroupMemberRemoveHandler,
  adminGroupMembersListHandler,
  adminGroupRoleAssignHandler,
  adminGroupRoleRemoveHandler,
  adminGroupRolesListHandler,
  adminGroupUpdateHandler,
  adminGroupsListHandler,
  adminUserGroupsListHandler,
} from '../admin-groups';
import { adminUserEffectivePermissionsHandler } from '../admin-rbac';
import { findAdminRouteAccessRule } from '../admin-route-access';
import { registerAdminResourcePermissionMiddleware } from '../admin-resource-permissions';

const superAdmin = {
  userId: 'admin-1',
  hierarchyLevel: 100,
  permissions: ['admin:*'],
} as unknown as AdminAuthContext;

/** Holds the grant permissions but a ceiling of tier 1: cannot delegate a tier 2 role. */
const lowCeilingAdmin = {
  userId: 'admin-2',
  hierarchyLevel: 80,
  maxGrantTier: 1,
  permissions: ['admin:groups:write', 'admin:groups:read', 'admin:roles:write'],
} as unknown as AdminAuthContext;

/** May change groups, but not roles. */
const groupsOnlyAdmin = {
  userId: 'admin-3',
  hierarchyLevel: 100,
  permissions: ['admin:groups:write', 'admin:groups:read'],
} as unknown as AdminAuthContext;

const readOnlyAdmin = {
  userId: 'admin-4',
  hierarchyLevel: 100,
  permissions: ['admin:groups:read'],
} as unknown as AdminAuthContext;

let currentAuth: AdminAuthContext = superAdmin;
let cachePuts: string[] = [];
const cache = {
  put: vi.fn(async (key: string) => {
    cachePuts.push(key);
  }),
  get: vi.fn(async () => null),
  delete: vi.fn(async () => undefined),
};

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c as unknown as { set(k: string, v: unknown): void }).set('adminAuth', currentAuth);
    await next();
  });
  const read = requireAdminPermissions([ADMIN_PERMISSIONS.GROUPS_READ]);
  const write = requireAdminPermissions([ADMIN_PERMISSIONS.GROUPS_WRITE]);
  app.get('/api/admin/groups', read, adminGroupsListHandler);
  app.post('/api/admin/groups', write, adminGroupCreateHandler);
  app.get('/api/admin/groups/:id', read, adminGroupGetHandler);
  app.put('/api/admin/groups/:id', write, adminGroupUpdateHandler);
  app.delete('/api/admin/groups/:id', write, adminGroupDeleteHandler);
  app.get('/api/admin/groups/:id/members', read, adminGroupMembersListHandler);
  app.post('/api/admin/groups/:id/members', write, adminGroupMemberAddHandler);
  app.delete('/api/admin/groups/:id/members/:subjectId', write, adminGroupMemberRemoveHandler);
  app.get('/api/admin/groups/:id/roles', read, adminGroupRolesListHandler);
  app.post('/api/admin/groups/:id/roles', write, adminGroupRoleAssignHandler);
  app.delete('/api/admin/groups/:id/roles/:roleId', write, adminGroupRoleRemoveHandler);
  app.get('/api/admin/users/:id/groups', read, adminUserGroupsListHandler);
  app.get('/api/admin/users/:id/effective-permissions', adminUserEffectivePermissionsHandler);
  return app;
}

const app = buildApp();

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: string, path: string, body?: unknown) {
  const response = await app.request(
    path,
    {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { REBAC_CACHE: cache }
  );
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Json };
}

let metadataDb: ReturnType<typeof openCoreStore>['db'];
let accountDb: ReturnType<typeof openCoreStore>['db'];

function seedRole(id: string, tier: number, permissions: string[] = ['docs:read']) {
  metadataDb
    .prepare(
      `INSERT INTO roles (id, name, tenant_id, grant_tier, hierarchy_level, permissions_json, created_at)
       VALUES (?, ?, 'tenant-a', ?, 1, ?, 1)`
    )
    .run(id, id, tier, JSON.stringify(permissions));
}

async function createGroupVia(key: string, parent?: string) {
  const result = await call('POST', '/api/admin/groups', {
    group_key: key,
    display_name: `Group ${key}`,
    ...(parent ? { parent_group_id: parent } : {}),
  });
  expect(result.status).toBe(201);
  return result.body.group.id as string;
}

function auditedActions() {
  return mocked.audit.mock.calls.map(
    (callArgs) => (callArgs as unknown as [unknown, { action: string }])[1].action
  );
}

beforeEach(() => {
  const metadata = openCoreStore('tenant-a');
  const account = openCoreStore('tenant-a');
  metadataDb = metadata.db;
  accountDb = account.db;
  mocked.stores = { metadata: metadata.adapter, accounts: [account.adapter], routed: false };
  mocked.routeOf = () => 0;
  mocked.current = null;
  mocked.audit.mockClear();
  cachePuts = [];
  cache.put.mockClear();
  currentAuth = superAdmin;
});

describe('groups: create, list, get, update, delete', () => {
  it('runs the whole life of a group and audits each change', async () => {
    const rootId = await createGroupVia('staff');
    const childId = await createGroupVia('staff.dev', rootId);

    const create = (body: unknown) => call('POST', '/api/admin/groups', body);
    expect((await create({ group_key: 'staff', display_name: 'X' })).status).toBe(409);
    expect((await create({ group_key: 'bad key!', display_name: 'X' })).status).toBe(400);
    expect((await create({ group_key: 'a', display_name: '' })).status).toBe(400);
    expect(
      (await create({ group_key: 'orphan', display_name: 'O', parent_group_id: 'missing' })).status
    ).toBe(400);

    const list = await call('GET', '/api/admin/groups?q=dev');
    expect(list.status).toBe(200);
    expect(list.body.groups.map((group: { id: string }) => group.id)).toEqual([childId]);
    expect((await call('GET', '/api/admin/groups')).body.pagination.total).toBe(2);
    expect((await call('GET', '/api/admin/groups?kind=scim')).body.groups).toEqual([]);
    expect((await call('GET', '/api/admin/groups?kind=nope')).status).toBe(400);
    expect((await call('GET', '/api/admin/groups?lifecycle_state=inactive')).body.groups).toEqual(
      []
    );

    const got = await call('GET', `/api/admin/groups/${childId}`);
    expect(got.status).toBe(200);
    expect(got.body.group).toMatchObject({
      id: childId,
      group_key: 'staff.dev',
      kind: 'static',
      parent_group_id: rootId,
      member_count: 0,
      roles: [],
    });
    expect(got.body.group.parent_chain.map((parent: { id: string }) => parent.id)).toEqual([
      rootId,
    ]);
    expect((await call('GET', '/api/admin/groups/missing')).status).toBe(404);

    // Updating fields, the state and the parent. The state and the parent bump the tenant version.
    cachePuts = [];
    const updated = await call('PUT', `/api/admin/groups/${childId}`, {
      display_name: 'Developers',
      description: 'The dev team',
      lifecycle_state: 'inactive',
      metadata: { team: 'dev' },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.group).toMatchObject({
      display_name: 'Developers',
      description: 'The dev team',
      lifecycle_state: 'inactive',
      metadata: { team: 'dev' },
    });
    expect(cachePuts.some((key) => key.includes('tenant-a'))).toBe(true);
    expect(
      (await call('GET', '/api/admin/groups?lifecycle_state=inactive')).body.groups
    ).toHaveLength(1);
    expect(
      (await call('PUT', `/api/admin/groups/${childId}`, { lifecycle_state: 'gone' })).status
    ).toBe(400);
    // A loop is refused.
    expect(
      (await call('PUT', `/api/admin/groups/${rootId}`, { parent_group_id: childId })).status
    ).toBe(400);
    expect(
      (await call('PUT', `/api/admin/groups/${rootId}`, { parent_group_id: rootId })).status
    ).toBe(400);
    expect((await call('PUT', '/api/admin/groups/missing', { display_name: 'X' })).status).toBe(
      404
    );
    const detached = await call('PUT', `/api/admin/groups/${childId}`, { parent_group_id: null });
    expect(detached.body.group.parent_group_id).toBeNull();
    await call('PUT', `/api/admin/groups/${childId}`, { parent_group_id: rootId });

    // A group with a child is not deleted.
    expect((await call('DELETE', `/api/admin/groups/${rootId}`)).status).toBe(409);
    expect((await call('DELETE', `/api/admin/groups/${childId}`)).status).toBe(200);
    expect((await call('DELETE', `/api/admin/groups/${rootId}`)).status).toBe(200);
    expect((await call('DELETE', `/api/admin/groups/${rootId}`)).status).toBe(404);
    expect(metadataDb.prepare('SELECT count(*) n FROM "groups"').get()).toEqual({ n: 0 });

    const actions = auditedActions();
    expect(actions.filter((action) => action === 'group.created')).toHaveLength(2);
    expect(actions.filter((action) => action === 'group.deleted')).toHaveLength(2);
    expect(actions).toContain('group.updated');
  });

  it('deletes the memberships and the role grants of the group with it', async () => {
    seedRole('role-a', 1);
    const groupId = await createGroupVia('team');
    expect(
      (await call('POST', `/api/admin/groups/${groupId}/members`, { subject_id: 'user-1' })).status
    ).toBe(201);
    expect(
      (await call('POST', `/api/admin/groups/${groupId}/roles`, { role_id: 'role-a' })).status
    ).toBe(201);
    cachePuts = [];
    expect((await call('DELETE', `/api/admin/groups/${groupId}`)).status).toBe(200);
    expect(accountDb.prepare('SELECT count(*) n FROM group_memberships').get()).toEqual({ n: 0 });
    expect(metadataDb.prepare('SELECT count(*) n FROM group_role_assignments').get()).toEqual({
      n: 0,
    });
    expect(cachePuts.length).toBeGreaterThan(0);
  });
});

describe('group members', () => {
  it('adds and removes a manual membership in the account database and invalidates the subject', async () => {
    const groupId = await createGroupVia('team');
    const added = await call('POST', `/api/admin/groups/${groupId}/members`, {
      subject_id: 'user-1',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(added.status).toBe(201);
    expect(
      accountDb.prepare('SELECT assignment_source, lifecycle_state FROM group_memberships').all()
    ).toEqual([{ assignment_source: 'manual', lifecycle_state: 'active' }]);
    // Memberships are not in the metadata database.
    expect(metadataDb.prepare('SELECT count(*) n FROM group_memberships').get()).toEqual({ n: 0 });
    expect(cachePuts.some((key) => key.includes('user-1'))).toBe(true);

    const members = await call('GET', `/api/admin/groups/${groupId}/members`);
    expect(members.status).toBe(200);
    expect(members.body.pagination.total).toBe(1);
    expect(members.body.members[0]).toMatchObject({
      subject_id: 'user-1',
      assignment_source: 'manual',
      lifecycle_state: 'active',
      user_email: 'user-1@example.com',
    });
    expect(members.body.members[0].expires_at).toEqual(expect.any(Number));
    expect((await call('GET', `/api/admin/groups/${groupId}`)).body.group.member_count).toBe(1);

    cachePuts = [];
    expect((await call('DELETE', `/api/admin/groups/${groupId}/members/user-1`)).status).toBe(200);
    expect(cachePuts.some((key) => key.includes('user-1'))).toBe(true);
    expect(accountDb.prepare('SELECT lifecycle_state FROM group_memberships').all()).toEqual([
      { lifecycle_state: 'revoked' },
    ]);
    expect(auditedActions()).toEqual(
      expect.arrayContaining(['group.member_added', 'group.member_removed'])
    );
  });

  it('validates the request and the subject', async () => {
    const groupId = await createGroupVia('team');
    const post = (body: unknown) => call('POST', `/api/admin/groups/${groupId}/members`, body);
    expect((await post({})).status).toBe(400);
    expect((await post({ subject_id: 'user-1', starts_at: 'now' })).status).toBe(400);
    expect((await post({ subject_id: 'user-1', starts_at: 200, expires_at: 100 })).status).toBe(
      400
    );
    expect((await post({ subject_id: 'ghost-1' })).status).toBe(404);
    expect((await post({ subject_id: 'unknown-user' })).status).toBe(404);
    expect(
      (await call('POST', '/api/admin/groups/missing/members', { subject_id: 'user-1' })).status
    ).toBe(404);
    expect((await call('DELETE', `/api/admin/groups/${groupId}/members/user-1`)).status).toBe(404);
  });

  it('refuses to remove a membership that only comes from another source', async () => {
    const groupId = await createGroupVia('team');
    accountDb
      .prepare(
        `INSERT INTO group_memberships (id, tenant_id, group_id, subject_id, assignment_source, source_ref, created_at, updated_at)
         VALUES ('m1', 'tenant-a', ?, 'user-2', 'scim', 'conn-1', 1, 1)`
      )
      .run(groupId);
    const result = await call('DELETE', `/api/admin/groups/${groupId}/members/user-2`);
    expect(result.status).toBe(409);
    expect(accountDb.prepare('SELECT lifecycle_state FROM group_memberships').all()).toEqual([
      { lifecycle_state: 'active' },
    ]);
    // The row still shows with its source.
    const members = await call('GET', `/api/admin/groups/${groupId}/members`);
    expect(members.body.members[0]).toMatchObject({
      assignment_source: 'scim',
      source_ref: 'conn-1',
    });
  });

  it('keeps another source when the manual membership is removed', async () => {
    const groupId = await createGroupVia('team');
    accountDb
      .prepare(
        `INSERT INTO group_memberships (id, tenant_id, group_id, subject_id, assignment_source, source_ref, created_at, updated_at)
         VALUES ('m1', 'tenant-a', ?, 'user-1', 'scim', 'conn-1', 1, 1)`
      )
      .run(groupId);
    await call('POST', `/api/admin/groups/${groupId}/members`, { subject_id: 'user-1' });
    expect((await call('DELETE', `/api/admin/groups/${groupId}/members/user-1`)).status).toBe(200);
    expect(
      accountDb
        .prepare(
          'SELECT assignment_source, lifecycle_state FROM group_memberships ORDER BY assignment_source'
        )
        .all()
    ).toEqual([
      { assignment_source: 'manual', lifecycle_state: 'revoked' },
      { assignment_source: 'scim', lifecycle_state: 'active' },
    ]);
  });
});

describe('roles granted to a group', () => {
  it('grants, lists and removes a role and bumps the tenant version', async () => {
    seedRole('role-a', 1);
    const groupId = await createGroupVia('team');
    const grant = (body: unknown) => call('POST', `/api/admin/groups/${groupId}/roles`, body);
    expect((await grant({})).status).toBe(400);
    expect((await grant({ role_id: 'nope' })).status).toBe(404);
    expect((await grant({ role_id: 'role-a', scope_type: 'org' })).status).toBe(400);
    expect((await grant({ role_id: 'role-a', scope_type: 'resource' })).status).toBe(400);
    expect((await grant({ role_id: 'role-a', expires_at: 5 })).status).toBe(400);

    cachePuts = [];
    expect((await grant({ role_id: 'role-a' })).status).toBe(201);
    expect(cachePuts.length).toBeGreaterThan(0);
    expect(
      (await grant({ role_id: 'role-a', scope_type: 'resource', scope_target: 'resource:doc:1' }))
        .status
    ).toBe(201);

    const listed = await call('GET', `/api/admin/groups/${groupId}/roles`);
    expect(listed.body.roles).toHaveLength(2);
    expect(listed.body.roles[0]).toMatchObject({
      role_id: 'role-a',
      role_name: 'role-a',
      scope_type: 'global',
    });
    expect((await call('GET', `/api/admin/groups/${groupId}`)).body.group.roles).toHaveLength(2);

    const scoped = `/api/admin/groups/${groupId}/roles/role-a?scope_type=resource&scope_target=resource:doc:1`;
    expect((await call('DELETE', scoped)).status).toBe(200);
    // Removing a grant that is gone answers 200 too (idempotent).
    expect((await call('DELETE', scoped)).status).toBe(200);
    expect((await call('DELETE', `/api/admin/groups/${groupId}/roles/role-a`)).status).toBe(200);
    expect((await call('GET', `/api/admin/groups/${groupId}/roles`)).body.roles).toEqual([]);
    expect(auditedActions()).toEqual(
      expect.arrayContaining(['group.role_assigned', 'group.role_removed'])
    );
  });
});

describe('delegation and permissions', () => {
  it('refuses an admin whose ceiling is below the role or who lacks admin:roles:write', async () => {
    seedRole('role-low', 1);
    seedRole('role-high', 2);
    const groupId = await createGroupVia('team');
    const childId = await createGroupVia('team.child', groupId);
    const otherId = await createGroupVia('other');
    expect(
      (await call('POST', `/api/admin/groups/${groupId}/roles`, { role_id: 'role-high' })).status
    ).toBe(201);

    currentAuth = lowCeilingAdmin;
    // Granting and removing the tier 2 role, and changing who is below it, are above the ceiling.
    const denied = (method: string, path: string, body?: unknown) =>
      call(method, path, body).then((result) => result.status);
    expect(
      await denied('POST', `/api/admin/groups/${otherId}/roles`, { role_id: 'role-high' })
    ).toBe(403);
    expect(await denied('DELETE', `/api/admin/groups/${groupId}/roles/role-high`)).toBe(403);
    expect(
      await denied('POST', `/api/admin/groups/${childId}/members`, { subject_id: 'user-1' })
    ).toBe(403);
    expect(await denied('PUT', `/api/admin/groups/${otherId}`, { parent_group_id: childId })).toBe(
      403
    );
    expect(
      await denied('PUT', `/api/admin/groups/${childId}`, { lifecycle_state: 'inactive' })
    ).toBe(403);
    expect(await denied('DELETE', `/api/admin/groups/${groupId}`)).toBe(409);
    expect(await denied('DELETE', `/api/admin/groups/${childId}`)).toBe(403);
    expect(accountDb.prepare('SELECT count(*) n FROM group_memberships').get()).toEqual({ n: 0 });
    expect(
      metadataDb.prepare('SELECT parent_group_id FROM "groups" WHERE id = ?').get(otherId)
    ).toEqual({
      parent_group_id: null,
    });
    // A role within the ceiling is granted.
    expect(
      await denied('POST', `/api/admin/groups/${otherId}/roles`, { role_id: 'role-low' })
    ).toBe(201);

    // Without admin:roles:write even a low role cannot be granted, nor a member added below roles.
    currentAuth = groupsOnlyAdmin;
    expect(
      await denied('POST', `/api/admin/groups/${groupId}/roles`, { role_id: 'role-low' })
    ).toBe(403);
    expect(
      await denied('POST', `/api/admin/groups/${otherId}/members`, { subject_id: 'user-1' })
    ).toBe(403);
    // Groups without roles stay open to the groups permission.
    const plainId = await createGroupVia('plain');
    expect(
      await denied('POST', `/api/admin/groups/${plainId}/members`, { subject_id: 'user-1' })
    ).toBe(201);

    // An administrator cannot add or remove themselves in a group that carries roles.
    currentAuth = { ...superAdmin, userId: 'user-2' };
    expect(
      await denied('POST', `/api/admin/groups/${groupId}/members`, { subject_id: 'user-2' })
    ).toBe(403);
    expect(await denied('DELETE', `/api/admin/groups/${groupId}/members/user-2`)).toBe(403);
  });

  it('gates every route on the groups permission', async () => {
    const groupId = await createGroupVia('team');
    currentAuth = readOnlyAdmin;
    expect((await call('GET', '/api/admin/groups')).status).toBe(200);
    expect((await call('GET', `/api/admin/groups/${groupId}/members`)).status).toBe(200);
    expect(
      (await call('POST', '/api/admin/groups', { group_key: 'x', display_name: 'X' })).status
    ).toBe(403);
    expect((await call('PUT', `/api/admin/groups/${groupId}`, { display_name: 'X' })).status).toBe(
      403
    );
    expect((await call('DELETE', `/api/admin/groups/${groupId}`)).status).toBe(403);
    expect(
      (await call('POST', `/api/admin/groups/${groupId}/members`, { subject_id: 'user-1' })).status
    ).toBe(403);
    expect(
      (await call('POST', `/api/admin/groups/${groupId}/roles`, { role_id: 'r' })).status
    ).toBe(403);
    currentAuth = {
      userId: 'admin-5',
      permissions: ['admin:users:*'],
    } as unknown as AdminAuthContext;
    expect((await call('GET', '/api/admin/groups')).status).toBe(403);
    expect((await call('GET', '/api/admin/users/user-1/groups')).status).toBe(403);
  });

  it('puts the routes behind the groups permissions in the deny-by-default gate', () => {
    const permissions = (method: string, path: string) =>
      findAdminRouteAccessRule(method, path)?.permissions;
    expect(permissions('GET', '/api/admin/groups')).toEqual([ADMIN_PERMISSIONS.GROUPS_READ]);
    expect(permissions('GET', '/api/admin/groups/g1/members')).toEqual([
      ADMIN_PERMISSIONS.GROUPS_READ,
    ]);
    expect(permissions('GET', '/api/admin/users/u1/groups')).toEqual([
      ADMIN_PERMISSIONS.GROUPS_READ,
    ]);
    for (const [method, path] of [
      ['POST', '/api/admin/groups'],
      ['PUT', '/api/admin/groups/g1'],
      ['DELETE', '/api/admin/groups/g1'],
      ['POST', '/api/admin/groups/g1/members'],
      ['DELETE', '/api/admin/groups/g1/members/u1'],
      ['POST', '/api/admin/groups/g1/roles'],
      ['DELETE', '/api/admin/groups/g1/roles/r1'],
    ]) {
      expect(permissions(method, path), `${method} ${path}`).toEqual([
        ADMIN_PERMISSIONS.GROUPS_WRITE,
      ]);
    }
  });

  it('carries the role permissions over to the group ones until the standard roles list them', () => {
    expect(hasAdminPermission(['admin:roles:*'], ADMIN_PERMISSIONS.GROUPS_WRITE)).toBe(true);
    expect(hasAdminPermission(['admin:roles:write'], ADMIN_PERMISSIONS.GROUPS_WRITE)).toBe(true);
    expect(hasAdminPermission(['admin:roles:read'], ADMIN_PERMISSIONS.GROUPS_READ)).toBe(true);
    expect(hasAdminPermission(['admin:roles:read'], ADMIN_PERMISSIONS.GROUPS_WRITE)).toBe(false);
    expect(hasAdminPermission(['admin:users:*'], ADMIN_PERMISSIONS.GROUPS_READ)).toBe(false);
    expect(hasAdminPermission(['admin:groups:*'], ADMIN_PERMISSIONS.GROUPS_WRITE)).toBe(true);
  });
});

describe("a user's groups", () => {
  it('lists the memberships and the groups they resolve to, ancestors included', async () => {
    const rootId = await createGroupVia('root');
    const childId = await createGroupVia('child', rootId);
    await call('POST', `/api/admin/groups/${childId}/members`, { subject_id: 'user-1' });

    const result = await call('GET', '/api/admin/users/user-1/groups');
    expect(result.status).toBe(200);
    expect(result.body.memberships).toEqual([
      expect.objectContaining({
        group_id: childId,
        group_key: 'child',
        assignment_source: 'manual',
        lifecycle_state: 'active',
      }),
    ]);
    expect(result.body.resolved.direct_group_ids).toEqual([childId]);
    expect(
      result.body.resolved.effective_groups
        .map((group: { id: string; direct: boolean }) => `${group.id}:${group.direct}`)
        .sort()
    ).toEqual([`${childId}:true`, `${rootId}:false`].sort());

    // A deactivated group stops the resolution; the membership row still shows.
    await call('PUT', `/api/admin/groups/${childId}`, { lifecycle_state: 'inactive' });
    const inactive = await call('GET', '/api/admin/users/user-1/groups');
    expect(inactive.body.memberships).toHaveLength(1);
    expect(inactive.body.resolved.effective_groups).toEqual([]);
    expect((await call('GET', '/api/admin/users/ghost-1/groups')).status).toBe(404);
    expect((await call('GET', '/api/admin/users/unknown/groups')).status).toBe(404);
  });
});

describe('effective permissions through groups', () => {
  it('says where each role came from', async () => {
    seedRole('role-direct', 1, ['docs:read']);
    seedRole('role-group', 1, ['docs:write']);
    const rootId = await createGroupVia('root');
    const childId = await createGroupVia('child', rootId);
    await call('POST', `/api/admin/groups/${rootId}/roles`, { role_id: 'role-group' });
    await call('POST', `/api/admin/groups/${childId}/members`, { subject_id: 'user-1' });
    accountDb
      .prepare(
        `INSERT INTO role_assignments (id, tenant_id, subject_id, role_id, scope_type, scope_target, created_at, updated_at)
         VALUES ('ra1', 'tenant-a', 'user-1', 'role-direct', 'global', '', 1, 1)`
      )
      .run();

    const result = await call('GET', '/api/admin/users/user-1/effective-permissions');
    expect(result.status).toBe(200);
    const roles = result.body.roles as Array<{ role_id: string; via: unknown }>;
    expect(roles.find((role) => role.role_id === 'role-direct')?.via).toEqual({ kind: 'direct' });
    expect(roles.find((role) => role.role_id === 'role-group')?.via).toEqual({
      kind: 'group',
      group_id: rootId,
      through_group_id: childId,
    });
    expect(
      result.body.permissions
        .map((permission: { permission: string }) => permission.permission)
        .sort()
    ).toEqual(['docs:read', 'docs:write']);
  });
});

describe('guards and validation of the second review', () => {
  const nowSeconds = () => Math.floor(Date.now() / 1000);

  it('refuses granting, moving or reactivating a group the operator is part of, above or below', async () => {
    seedRole('role-a', 1);
    const rootId = await createGroupVia('root');
    const childId = await createGroupVia('child', rootId);
    const grandId = await createGroupVia('grand', childId);
    const otherId = await createGroupVia('other');
    await call('POST', `/api/admin/groups/${childId}/members`, { subject_id: 'user-1' });
    await call('PUT', `/api/admin/groups/${grandId}`, { lifecycle_state: 'inactive' });

    currentAuth = { ...superAdmin, userId: 'user-1' };
    const grant = (id: string) =>
      call('POST', `/api/admin/groups/${id}/roles`, { role_id: 'role-a' }).then((r) => r.status);
    // The group the operator is in, an ancestor of it and a descendant of it.
    expect(await grant(childId)).toBe(403);
    expect(await grant(rootId)).toBe(403);
    expect(await grant(grandId)).toBe(403);
    expect(await grant(otherId)).toBe(201);
    // Moving the group the operator is in, and reactivating one below it.
    const put = (id: string, body: unknown) =>
      call('PUT', `/api/admin/groups/${id}`, body).then((r) => r.status);
    expect(await put(childId, { parent_group_id: otherId })).toBe(403);
    expect(await put(grandId, { lifecycle_state: 'active' })).toBe(403);
    // Other changes to those groups stay possible.
    expect(await put(childId, { display_name: 'Renamed' })).toBe(200);
    // Another operator is not held back.
    currentAuth = superAdmin;
    expect(await put(grandId, { lifecycle_state: 'active' })).toBe(200);
  });

  it('writes the state and the parent in one statement, once, and refuses a concurrent change', async () => {
    const aId = await createGroupVia('a');
    const bId = await createGroupVia('b');
    cachePuts = [];
    mocked.audit.mockClear();
    const both = await call('PUT', `/api/admin/groups/${aId}`, {
      parent_group_id: bId,
      lifecycle_state: 'inactive',
      display_name: 'A',
    });
    expect(both.status).toBe(200);
    expect(both.body.group).toMatchObject({ parent_group_id: bId, lifecycle_state: 'inactive' });
    expect(cachePuts).toHaveLength(1);
    expect(auditedActions()).toEqual(['group.updated']);

    // An unchanged state is left out of the write and does not bump the version.
    cachePuts = [];
    const same = await call('PUT', `/api/admin/groups/${aId}`, {
      lifecycle_state: 'inactive',
      description: 'd',
    });
    expect(same.status).toBe(200);
    // The version is bumped after every successful update, a same-value one included.
    expect(cachePuts).toHaveLength(1);

    // Something else changes the state between the read and the write.
    const adapter = mocked.stores.metadata;
    const original = adapter.execute.bind(adapter);
    adapter.execute = async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('UPDATE "groups"'))
        metadataDb
          .prepare('UPDATE "groups" SET lifecycle_state = \'active\' WHERE id = ?')
          .run(aId);
      return original(sql, params);
    };
    const raced = await call('PUT', `/api/admin/groups/${aId}`, {
      lifecycle_state: 'active',
      parent_group_id: null,
    });
    adapter.execute = original;
    expect(raced.status).toBe(409);
    expect(
      metadataDb.prepare('SELECT parent_group_id FROM "groups" WHERE id = ?').get(aId)
    ).toEqual({ parent_group_id: bId });
  });

  it('refuses bodies that are not objects or change nothing', async () => {
    const id = await createGroupVia('a');
    mocked.audit.mockClear();
    expect((await call('PUT', `/api/admin/groups/${id}`, [])).status).toBe(400);
    expect((await call('PUT', `/api/admin/groups/${id}`, 'text')).status).toBe(400);
    expect((await call('PUT', `/api/admin/groups/${id}`, {})).status).toBe(400);
    expect((await call('PUT', `/api/admin/groups/${id}`, { unknown: 1 })).status).toBe(400);
    expect(mocked.audit).not.toHaveBeenCalled();
  });

  it('cleans up what a failed delete left and answers 204 once, then 404', async () => {
    seedRole('role-a', 1);
    const id = await createGroupVia('team');
    await call('POST', `/api/admin/groups/${id}/members`, { subject_id: 'user-1' });
    await call('POST', `/api/admin/groups/${id}/roles`, { role_id: 'role-a' });
    // The definition is gone, the memberships and the grant are not.
    metadataDb.prepare('DELETE FROM "groups" WHERE id = ?').run(id);
    cachePuts = [];
    const retry = await app.request(
      `/api/admin/groups/${id}`,
      { method: 'DELETE' },
      {
        REBAC_CACHE: cache,
      }
    );
    expect(retry.status).toBe(204);
    expect(cachePuts).toHaveLength(2);
    expect(accountDb.prepare('SELECT count(*) n FROM group_memberships').get()).toEqual({ n: 0 });
    expect(metadataDb.prepare('SELECT count(*) n FROM group_role_assignments').get()).toEqual({
      n: 0,
    });
    expect((await call('DELETE', `/api/admin/groups/${id}`)).status).toBe(404);
  });

  it('bumps the tenant version once, then drops the claims of each former member', async () => {
    const id = await createGroupVia('team');
    for (const user of ['user-1', 'user-2'])
      await call('POST', `/api/admin/groups/${id}/members`, { subject_id: user });
    cachePuts = [];
    expect((await call('DELETE', `/api/admin/groups/${id}`)).status).toBe(200);
    expect(cachePuts).toHaveLength(3);
    expect(cachePuts.filter((key) => key.includes('user-1'))).toHaveLength(1);
    expect(cachePuts.filter((key) => key.includes('user-2'))).toHaveLength(1);
  });

  it('still answers success when the cache or the audit fails after the rows are gone', async () => {
    const id = await createGroupVia('team');
    await call('POST', `/api/admin/groups/${id}/members`, { subject_id: 'user-1' });
    cache.put.mockImplementationOnce(async (key: string) => {
      cachePuts.push(key);
    });
    cache.put.mockImplementationOnce(async () => {
      throw new Error('kv down');
    });
    mocked.audit.mockRejectedValueOnce(new Error('audit down'));
    expect((await call('DELETE', `/api/admin/groups/${id}`)).status).toBe(200);
    expect(metadataDb.prepare('SELECT count(*) n FROM "groups"').get()).toEqual({ n: 0 });
    expect(accountDb.prepare('SELECT count(*) n FROM group_memberships').get()).toEqual({ n: 0 });
  });

  it('refuses unknown keys, mixed with known ones too', async () => {
    const id = await createGroupVia('a');
    mocked.audit.mockClear();
    expect(
      (await call('PUT', `/api/admin/groups/${id}`, { display_name: 'X', kind: 'scim' })).status
    ).toBe(400);
    expect((await call('PUT', `/api/admin/groups/${id}`, { group_key: 'z' })).status).toBe(400);
    expect(mocked.audit).not.toHaveBeenCalled();
  });

  it('counts a scheduled membership and leaves a sibling alone', async () => {
    seedRole('role-a', 1);
    const parentId = await createGroupVia('parent');
    const mineId = await createGroupVia('mine', parentId);
    const siblingId = await createGroupVia('sibling', parentId);
    const futureId = await createGroupVia('future');
    // The operator is in `mine` now and in `future` from tomorrow.
    await call('POST', `/api/admin/groups/${mineId}/members`, { subject_id: 'user-1' });
    await call('POST', `/api/admin/groups/${futureId}/members`, {
      subject_id: 'user-1',
      starts_at: nowSeconds() + 86_400,
    });
    currentAuth = { ...superAdmin, userId: 'user-1' };
    const grant = (id: string) =>
      call('POST', `/api/admin/groups/${id}/roles`, { role_id: 'role-a' }).then((r) => r.status);
    expect(await grant(siblingId)).toBe(201);
    expect(await grant(futureId)).toBe(403);
    expect(await grant(mineId)).toBe(403);
    expect(await grant(parentId)).toBe(403);
  });

  it('keeps the read parent in the WHERE of a state-only update', async () => {
    const aId = await createGroupVia('a');
    const bId = await createGroupVia('b');
    const adapter = mocked.stores.metadata;
    const original = adapter.execute.bind(adapter);
    adapter.execute = async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('UPDATE "groups"'))
        metadataDb.prepare('UPDATE "groups" SET parent_group_id = ? WHERE id = ?').run(bId, aId);
      return original(sql, params);
    };
    const raced = await call('PUT', `/api/admin/groups/${aId}`, { lifecycle_state: 'inactive' });
    adapter.execute = original;
    expect(raced.status).toBe(409);
    expect(
      metadataDb.prepare('SELECT lifecycle_state FROM "groups" WHERE id = ?').get(aId)
    ).toEqual({
      lifecycle_state: 'active',
    });
  });

  it('checks the scope target the way roleAssignmentHolds reads it', async () => {
    seedRole('role-a', 1);
    const id = await createGroupVia('team');
    const other = await createGroupVia('other');
    const grant = (scope_type: string, scope_target?: string) =>
      call('POST', `/api/admin/groups/${id}/roles`, {
        role_id: 'role-a',
        scope_type,
        scope_target,
      }).then((r) => r.status);
    expect(await grant('global', 'x')).toBe(400);
    expect(await grant('global')).toBe(201);
    expect(await grant('tenant', 'tenant-b')).toBe(400);
    expect(await grant('tenant', 'tenant-a')).toBe(201);
    expect(await grant('group', 'missing')).toBe(400);
    expect(await grant('group', 'group:nope')).toBe(400);
    expect(await grant('group', `group:${other}`)).toBe(201);
    expect(await grant('resource', 'doc:1')).toBe(400);
    expect(await grant('resource', 'resource:')).toBe(400);
    expect(await grant('resource', 'resource:doc:1')).toBe(201);
    expect(await grant('resource', 'resource:doc1')).toBe(201);
  });

  it('accepts Unix seconds only, not milliseconds or unsafe integers', async () => {
    seedRole('role-a', 1);
    const id = await createGroupVia('team');
    const ms = Date.now() + 3_600_000;
    const member = (body: unknown) =>
      call('POST', `/api/admin/groups/${id}/members`, {
        subject_id: 'user-1',
        ...(body as object),
      });
    for (const value of [ms, 2 ** 60, -1, 1.5, '100']) {
      expect((await member({ expires_at: value })).status).toBe(400);
      expect(
        (
          await call('POST', `/api/admin/groups/${id}/roles`, {
            role_id: 'role-a',
            expires_at: value,
          })
        ).status
      ).toBe(400);
    }
    expect((await member({ starts_at: ms })).status).toBe(400);
    expect((await member({ expires_at: nowSeconds() + 60 })).status).toBe(201);
  });

  it('answers 409 for an account that is not active', async () => {
    const id = await createGroupVia('team');
    const add = await call('POST', `/api/admin/groups/${id}/members`, { subject_id: 'inactive-1' });
    expect(add.status).toBe(409);
    expect((await call('GET', '/api/admin/users/inactive-1/groups')).status).toBe(409);
  });

  it('counts and flags memberships by the conditions of effective membership', async () => {
    const id = await createGroupVia('team');
    await call('POST', `/api/admin/groups/${id}/members`, { subject_id: 'user-1' });
    const insert = (subject: string, column: string, value: unknown, state = 'active') =>
      accountDb
        .prepare(
          `INSERT INTO group_memberships (id, tenant_id, group_id, subject_id, assignment_source, source_ref, lifecycle_state, ${column}, created_at, updated_at)
           VALUES (?, 'tenant-a', ?, ?, 'scim', 'c', ?, ?, 1, 1)`
        )
        .run(`m-${subject}`, id, subject, state, value as number);
    insert('user-expired', 'expires_at', 5);
    insert('user-stale', 'stale_after', 5);
    insert('user-future', 'starts_at', nowSeconds() + 3600);
    insert('user-revoked', 'expires_at', null, 'revoked');
    expect((await call('GET', `/api/admin/groups/${id}`)).body.group.member_count).toBe(1);
    expect((await call('GET', '/api/admin/groups')).body.groups[0].member_count).toBe(1);
    const list = await call('GET', `/api/admin/groups/${id}/members?limit=100`);
    expect(list.body.pagination.total).toBe(5);
    const effective = Object.fromEntries(
      list.body.members.map((m: { subject_id: string; effective: boolean }) => [
        m.subject_id,
        m.effective,
      ])
    );
    expect(effective).toEqual({
      'user-1': true,
      'user-expired': false,
      'user-stale': false,
      'user-future': false,
      'user-revoked': false,
    });
  });

  it('turns BIGINT strings from the database into numbers', async () => {
    const id = await createGroupVia('team');
    await call('POST', `/api/admin/groups/${id}/members`, {
      subject_id: 'user-1',
      expires_at: nowSeconds() + 600,
    });
    const account = mocked.stores.accounts[0];
    const original = account.query.bind(account);
    account.query = (async (sql: string, params?: unknown[]) =>
      (await original(sql, params)).map((row) =>
        Object.fromEntries(
          Object.entries(row as Record<string, unknown>).map(([key, value]) => [
            key,
            typeof value === 'number' && /_at$|_after$/.test(key) ? String(value) : value,
          ])
        )
      )) as typeof account.query;
    const list = await call('GET', `/api/admin/groups/${id}/members`);
    account.query = original;
    expect(list.body.members[0]).toMatchObject({
      starts_at: null,
      expires_at: expect.any(Number),
      joined_at: expect.any(Number),
      effective: true,
    });
  });
});

describe('the production permission middleware for /users/:id/groups', () => {
  function chain(permissions: string[]) {
    const prod = new Hono<{ Bindings: Env }>();
    prod.use('*', async (c, next) => {
      (c as unknown as { set(k: string, v: unknown): void }).set('adminAuth', {
        userId: 'admin-9',
        authMethod: 'session',
        tenantId: 'tenant-a',
        roles: ['ar_tenant_admin'],
        permissions,
        tenantScope: ['tenant-a'],
        hierarchyLevel: 0,
      });
      await next();
    });
    registerAdminResourcePermissionMiddleware(prod);
    prod.get(
      '/api/admin/users/:id/groups',
      requireAdminPermissions([ADMIN_PERMISSIONS.GROUPS_READ]),
      adminUserGroupsListHandler
    );
    return () => prod.request('/api/admin/users/user-1/groups', {}, {});
  }

  it('needs admin:groups:read only, not the user permissions', async () => {
    expect((await chain(['admin:groups:read'])()).status).toBe(200);
    expect((await chain(['admin:users:read'])()).status).toBe(403);
  });
});

describe('several account databases and another tenant', () => {
  let accountDb2: ReturnType<typeof openCoreStore>['db'];

  beforeEach(() => {
    const second = openCoreStore('tenant-a');
    accountDb2 = second.db;
    mocked.stores = {
      metadata: mocked.stores.metadata,
      accounts: [mocked.stores.accounts[0], second.adapter],
      routed: true,
    };
    // user-1 and user-3 are on the first shard, user-2 and user-4 on the second.
    mocked.routeOf = (id) => (id === 'user-2' || id === 'user-4' ? 1 : 0);
  });

  it('lists, counts and pages memberships across shards and deletes them on both', async () => {
    const id = await createGroupVia('team');
    for (const user of ['user-1', 'user-2', 'user-3', 'user-4'])
      expect(
        (await call('POST', `/api/admin/groups/${id}/members`, { subject_id: user })).status
      ).toBe(201);
    const subjectsOf = (db: typeof accountDb) =>
      db.prepare('SELECT subject_id FROM group_memberships ORDER BY subject_id').all();
    expect(subjectsOf(accountDb)).toEqual([{ subject_id: 'user-1' }, { subject_id: 'user-3' }]);
    expect(subjectsOf(accountDb2)).toEqual([{ subject_id: 'user-2' }, { subject_id: 'user-4' }]);
    // Newest first across both shards.
    const order: Array<[string, typeof accountDb, number]> = [
      ['user-1', accountDb, 400],
      ['user-2', accountDb2, 300],
      ['user-3', accountDb, 200],
      ['user-4', accountDb2, 100],
    ];
    for (const [user, db, at] of order)
      db.prepare('UPDATE group_memberships SET created_at = ? WHERE subject_id = ?').run(at, user);
    const subjects = async (query: string) =>
      (await call('GET', `/api/admin/groups/${id}/members?${query}`)).body.members.map(
        (m: { subject_id: string }) => m.subject_id
      );
    expect(await subjects('limit=3&page=1')).toEqual(['user-1', 'user-2', 'user-3']);
    expect(await subjects('limit=3&page=2')).toEqual(['user-4']);
    expect(await subjects('limit=2&page=2')).toEqual(['user-3', 'user-4']);
    expect(await subjects('limit=4&page=2')).toEqual([]);
    const paged = await call('GET', `/api/admin/groups/${id}/members?limit=2`);
    expect(paged.body.pagination).toMatchObject({ total: 4, totalPages: 2, hasNext: true });
    expect((await call('GET', `/api/admin/groups/${id}`)).body.group.member_count).toBe(4);
    // A user on the second shard is found there.
    expect((await call('GET', '/api/admin/users/user-2/groups')).body.memberships).toHaveLength(1);
    expect((await call('DELETE', `/api/admin/groups/${id}/members/user-4`)).status).toBe(200);
    expect(
      accountDb2
        .prepare("SELECT lifecycle_state FROM group_memberships WHERE subject_id = 'user-4'")
        .get()
    ).toEqual({ lifecycle_state: 'revoked' });

    expect((await call('DELETE', `/api/admin/groups/${id}`)).status).toBe(200);
    expect(accountDb.prepare('SELECT count(*) n FROM group_memberships').get()).toEqual({ n: 0 });
    expect(accountDb2.prepare('SELECT count(*) n FROM group_memberships').get()).toEqual({ n: 0 });
  });

  it('does not see or accept the rows of another tenant', async () => {
    metadataDb
      .prepare(
        "INSERT INTO tenants (id, tenant_code, tenant_key, name, created_at, updated_at) VALUES ('tenant-b', 'code-b', 'key-b', 'B', 1, 1)"
      )
      .run();
    const now = Math.floor(Date.now() / 1000);
    metadataDb
      .prepare(
        `INSERT INTO "groups" (id, tenant_id, group_key, display_name, created_at, updated_at) VALUES ('foreign-group', 'tenant-b', 'team', 'Foreign', ?, ?)`
      )
      .run(now, now);
    metadataDb
      .prepare(
        "INSERT INTO roles (id, name, tenant_id, grant_tier, hierarchy_level, permissions_json, created_at) VALUES ('foreign-role', 'foreign', 'tenant-b', 1, 1, '[]', 1)"
      )
      .run();
    const id = await createGroupVia('team');
    // A foreign membership row on the same group id and subject does not count here.
    for (const db of [accountDb, accountDb2])
      db.prepare(
        `INSERT INTO group_memberships (id, tenant_id, group_id, subject_id, assignment_source, source_ref, created_at, updated_at)
         VALUES ('foreign-m', 'tenant-b', ?, 'user-1', 'manual', '', 1, 1)`
      ).run(id);
    await call('POST', `/api/admin/groups/${id}/members`, { subject_id: 'user-1' });

    const status = (method: string, path: string, body?: unknown) =>
      call(method, path, body).then((r) => r.status);
    expect(await status('GET', '/api/admin/groups/foreign-group')).toBe(404);
    expect(await status('PUT', '/api/admin/groups/foreign-group', { display_name: 'X' })).toBe(404);
    expect(await status('DELETE', '/api/admin/groups/foreign-group')).toBe(404);
    expect(await status('GET', '/api/admin/groups/foreign-group/members')).toBe(404);
    expect(
      await status('POST', '/api/admin/groups/foreign-group/members', { subject_id: 'user-1' })
    ).toBe(404);
    expect(await status('POST', `/api/admin/groups/${id}/roles`, { role_id: 'foreign-role' })).toBe(
      404
    );
    expect(
      await status('POST', `/api/admin/groups/${id}/members`, { subject_id: 'outsider-1' })
    ).toBe(404);
    expect(
      await status('PUT', `/api/admin/groups/${id}`, { parent_group_id: 'foreign-group' })
    ).toBe(400);
    const listed = await call('GET', '/api/admin/groups');
    expect(listed.body.groups.map((g: { id: string }) => g.id)).toEqual([id]);
    const members = await call('GET', `/api/admin/groups/${id}/members`);
    expect(members.body.pagination.total).toBe(1);
    expect((await call('GET', `/api/admin/groups/${id}`)).body.group.member_count).toBe(1);
    // Deleting this tenant's group leaves the foreign rows.
    expect(await status('DELETE', `/api/admin/groups/${id}`)).toBe(200);
    const foreign = "SELECT count(*) n FROM group_memberships WHERE tenant_id = 'tenant-b'";
    expect(accountDb.prepare(foreign).get()).toEqual({ n: 1 });
    expect(accountDb2.prepare(foreign).get()).toEqual({ n: 1 });
  });
});

describe('third review', () => {
  it('refuses an empty-string key in a PUT body', async () => {
    const id = await createGroupVia('a');
    expect((await call('PUT', `/api/admin/groups/${id}`, { '': 'x' })).status).toBe(400);
    expect(
      (await call('PUT', `/api/admin/groups/${id}`, { display_name: 'X', '': 'x' })).status
    ).toBe(400);
  });

  it('refuses to delete a group that is the scope of a group role grant', async () => {
    seedRole('role-a', 1);
    const scopeId = await createGroupVia('scope');
    const holderId = await createGroupVia('holder');
    expect(
      (
        await call('POST', `/api/admin/groups/${holderId}/roles`, {
          role_id: 'role-a',
          scope_type: 'group',
          scope_target: `group:${scopeId}`,
        })
      ).status
    ).toBe(201);
    expect((await call('DELETE', `/api/admin/groups/${scopeId}`)).status).toBe(409);
    expect(metadataDb.prepare('SELECT count(*) n FROM "groups"').get()).toEqual({ n: 2 });
    expect(
      (
        await call(
          'DELETE',
          `/api/admin/groups/${holderId}/roles/role-a?scope_type=group&scope_target=group:${scopeId}`
        )
      ).status
    ).toBe(200);
    expect((await call('DELETE', `/api/admin/groups/${scopeId}`)).status).toBe(200);
  });

  it('deactivates the group before the bump, and a failed bump leaves it inactive for a retry', async () => {
    const id = await createGroupVia('team');
    await call('POST', `/api/admin/groups/${id}/members`, { subject_id: 'user-1' });
    cache.put.mockImplementationOnce(async () => {
      throw new Error('kv down');
    });
    expect((await call('DELETE', `/api/admin/groups/${id}`)).status).toBe(500);
    // Nothing was removed, but the group no longer resolves.
    expect(metadataDb.prepare('SELECT lifecycle_state FROM "groups" WHERE id = ?').get(id)).toEqual(
      {
        lifecycle_state: 'inactive',
      }
    );
    expect(accountDb.prepare('SELECT count(*) n FROM group_memberships').get()).toEqual({ n: 1 });
    const resolved = await call('GET', '/api/admin/users/user-1/groups');
    expect(resolved.body.resolved.effective_groups).toEqual([]);
    // The retry resumes from the inactive group.
    expect((await call('DELETE', `/api/admin/groups/${id}`)).status).toBe(200);
    expect(metadataDb.prepare('SELECT count(*) n FROM "groups"').get()).toEqual({ n: 0 });
    expect(accountDb.prepare('SELECT count(*) n FROM group_memberships').get()).toEqual({ n: 0 });
  });

  it('removes a group role idempotently and bumps the version every time', async () => {
    seedRole('role-a', 1);
    const id = await createGroupVia('team');
    await call('POST', `/api/admin/groups/${id}/roles`, { role_id: 'role-a' });
    cachePuts = [];
    expect((await call('DELETE', `/api/admin/groups/${id}/roles/role-a`)).status).toBe(200);
    expect((await call('DELETE', `/api/admin/groups/${id}/roles/role-a`)).status).toBe(200);
    expect(cachePuts).toHaveLength(2);
    expect((await call('DELETE', '/api/admin/groups/missing/roles/role-a')).status).toBe(404);
  });

  it('serialises a role grant with the catalog lock and checks inside the transaction', async () => {
    seedRole('role-a', 1);
    const id = await createGroupVia('team');
    const adapter = mocked.stores.metadata;
    const original = adapter.transaction.bind(adapter);
    let transactions = 0;
    adapter.transaction = (async (fn: Parameters<typeof original>[0]) => {
      transactions += 1;
      return original(fn);
    }) as typeof adapter.transaction;
    const granted = await call('POST', `/api/admin/groups/${id}/roles`, { role_id: 'role-a' });
    adapter.transaction = original;
    expect(granted.status).toBe(201);
    expect(transactions).toBe(1);
    expect(metadataDb.prepare('SELECT count(*) n FROM group_role_assignments').get()).toEqual({
      n: 1,
    });
  });
});

describe('fourth review', () => {
  it('revokes every manual row of the subject in one statement and drops the cache once', async () => {
    const id = await createGroupVia('team');
    await call('POST', `/api/admin/groups/${id}/members`, { subject_id: 'user-1' });
    accountDb
      .prepare(
        `INSERT INTO group_memberships (id, tenant_id, group_id, subject_id, assignment_source, source_ref, created_at, updated_at)
         VALUES ('m-extra', 'tenant-a', ?, 'user-1', 'manual', 'other-ref', 1, 1)`
      )
      .run(id);
    const account = mocked.stores.accounts[0];
    const original = account.execute.bind(account);
    const updates: string[] = [];
    account.execute = async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('UPDATE group_memberships')) updates.push(sql);
      return original(sql, params);
    };
    cachePuts = [];
    const removed = await call('DELETE', `/api/admin/groups/${id}/members/user-1`);
    account.execute = original;
    expect(removed.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(cachePuts).toHaveLength(1);
    expect(
      accountDb
        .prepare("SELECT count(*) n FROM group_memberships WHERE lifecycle_state = 'active'")
        .get()
    ).toEqual({ n: 0 });
  });

  it('answers 200 and still bumps when the role definition is gone, but keeps the permission check', async () => {
    seedRole('role-a', 1);
    const id = await createGroupVia('team');
    await call('POST', `/api/admin/groups/${id}/roles`, { role_id: 'role-a' });
    expect((await call('DELETE', `/api/admin/groups/${id}/roles/role-a`)).status).toBe(200);
    metadataDb.prepare("DELETE FROM roles WHERE id = 'role-a'").run();
    cachePuts = [];
    expect((await call('DELETE', `/api/admin/groups/${id}/roles/role-a`)).status).toBe(200);
    expect(cachePuts).toHaveLength(1);
    currentAuth = groupsOnlyAdmin;
    cachePuts = [];
    expect((await call('DELETE', `/api/admin/groups/${id}/roles/role-a`)).status).toBe(403);
    expect(cachePuts).toEqual([]);
  });

  it('does not grant a role that is not assignable', async () => {
    seedRole('role-a', 1);
    metadataDb.prepare("UPDATE roles SET is_assignable = 0 WHERE id = 'role-a'").run();
    const id = await createGroupVia('team');
    expect(
      (await call('POST', `/api/admin/groups/${id}/roles`, { role_id: 'role-a' })).status
    ).toBe(400);
  });

  it('checks children and scope references in one transaction with the catalog lock', async () => {
    const parentId = await createGroupVia('parent');
    await createGroupVia('child', parentId);
    const adapter = mocked.stores.metadata;
    const original = adapter.transaction.bind(adapter);
    let transactions = 0;
    adapter.transaction = (async (fn: Parameters<typeof original>[0]) => {
      transactions += 1;
      return original(fn);
    }) as typeof adapter.transaction;
    expect((await call('DELETE', `/api/admin/groups/${parentId}`)).status).toBe(409);
    adapter.transaction = original;
    expect(transactions).toBe(1);
    expect(
      metadataDb.prepare('SELECT lifecycle_state FROM "groups" WHERE id = ?').get(parentId)
    ).toEqual({ lifecycle_state: 'active' });
  });
});

describe('service groups through the groups API', () => {
  function seedServiceGroup(id: string, parentId: string | null, selfWritableField: boolean) {
    metadataDb
      .prepare(
        `INSERT INTO "groups" (id, tenant_id, group_key, display_name, parent_group_id, kind,
          rule_revision, created_at, updated_at) VALUES (?, 'tenant-a', ?, ?, ?, 'dynamic', 1, 1, 1)`
      )
      .run(id, `dynamic:${id}`, id, parentId);
    if (!selfWritableField) return;
    metadataDb.exec(`INSERT INTO custom_claim_schemas (id, tenant_id, field_key, display_label,
      field_type, is_active, operation_status, schema_version, show_on_registration, created_at,
      updated_at) VALUES ('tenant-a:team', 'tenant-a', 'team', 'Team', 'string', 1, 'active', 1, 1,
      1, 1)`);
    const plan = {
      tenantId: 'tenant-a',
      groups: [
        { id, tenantId: 'tenant-a', key: id, displayName: id, description: '', enabled: true },
      ],
      fields: { 'custom.team': { type: 'string', schemaId: 'tenant-a:team', schemaVersion: 1 } },
      nodes: {},
      order: [id],
      roots: {},
      attributes: { 'custom.team': [id] },
      dependents: { [id]: [] },
      dependencies: { [id]: [] },
    };
    metadataDb
      .prepare(
        `INSERT INTO service_group_catalog (tenant_id, revision, plan_json, updated_at, write_token)
         VALUES ('tenant-a', 1, ?, 1, 't')`
      )
      .run(JSON.stringify(plan));
  }

  it('refuses state, parent and deletion changes of a catalog-owned group (409)', async () => {
    const parentId = await createGroupVia('parent');
    seedServiceGroup('dyn', null, false);
    for (const [method, body] of [
      ['PUT', { lifecycle_state: 'inactive' }],
      ['PUT', { parent_group_id: parentId }],
      ['DELETE', undefined],
    ] as const) {
      const result = await call(method, '/api/admin/groups/dyn', body);
      expect(result.status).toBe(409);
      expect(result.body.error).toBe('group_managed_by_service_group');
    }
    // Only the catalog's own key (`dynamic:<id>`) marks a catalog-owned group.
    metadataDb.exec(`INSERT INTO "groups" (id, tenant_id, group_key, display_name, kind,
      created_at, updated_at) VALUES ('hand', 'tenant-a', 'dynamic:someone', 'Hand', 'dynamic', 1, 1)`);
    expect(
      (await call('PUT', '/api/admin/groups/hand', { lifecycle_state: 'inactive' })).status
    ).toBe(200);
    // Its name may still be edited here (the catalog writes it back on its next save).
    expect((await call('PUT', '/api/admin/groups/dyn', { display_name: 'Dyn' })).status).toBe(200);
    expect(
      metadataDb.prepare('SELECT lifecycle_state FROM "groups" WHERE id = ?').get('dyn')
    ).toEqual({ lifecycle_state: 'active' });
  });

  it('refuses a role reaching a service group decided by a self-writable field (400)', async () => {
    seedRole('reader', 1);
    const holderId = await createGroupVia('holder');
    const bearerId = await createGroupVia('bearer');
    seedServiceGroup('dyn', holderId, true);
    // A role on the group above it.
    const grant = await call('POST', `/api/admin/groups/${holderId}/roles`, { role_id: 'reader' });
    expect(grant.status).toBe(400);
    expect(grant.body.error).toBe('group_self_writable_attribute');
    // Moving the group above it under a role-bearing parent.
    expect(
      (await call('POST', `/api/admin/groups/${bearerId}/roles`, { role_id: 'reader' })).status
    ).toBe(201);
    const moved = await call('PUT', `/api/admin/groups/${holderId}`, { parent_group_id: bearerId });
    expect(moved.status).toBe(400);
    expect(moved.body.error).toBe('group_self_writable_attribute');
  });

  it("never lists a membership without a group in a user's groups", async () => {
    seedServiceGroup('dyn', null, false);
    accountDb.exec(`INSERT INTO group_memberships (id, tenant_id, group_id, subject_id,
      assignment_source, source_ref, stale_after, created_at, updated_at)
      VALUES ('m', 'tenant-a', 'dyn', 'user-1', 'dynamic', '0000000000000002:1', 9999999999, 1, 1);
      INSERT INTO dynamic_membership_publications (tenant_id, subject_id, generation, published_at)
      VALUES ('tenant-a', 'user-1', '0000000000000002:1', 1)`);
    const result = await call('GET', '/api/admin/users/user-1/groups');
    expect(result.status).toBe(200);
    expect(result.body.memberships.map((m: { group_id: string }) => m.group_id)).toEqual(['dyn']);
    expect(
      accountDb.prepare(`SELECT COUNT(*) AS n FROM group_memberships WHERE group_id = ''`).get()
    ).toEqual({ n: 0 });
  });
});
