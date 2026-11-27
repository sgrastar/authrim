import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import { openCoreStore } from './helpers/core-schema-sqlite';
import type { SQLiteDatabase } from './test-sqlite';

type Store = { db: SQLiteDatabase; adapter: DatabaseAdapter };

const state = vi.hoisted(() => ({
  metadata: null as unknown as { adapter: unknown },
  accounts: [] as Array<{ adapter: unknown; users: Set<string> }>,
  /** Users whose accounts are suspended: account routes refuse them. */
  suspended: new Set<string>(),
  /** Users whose accounts hold no personal data: the admin view refuses them. */
  withoutPii: new Set<string>(),
  /** The binding of the metadata database's own route, when one user store is that database. */
  metadataBinding: undefined as string | undefined,
  /** The registry's adapter of each user store (another object over the same database). */
  registryAdapters: null as unknown[] | null,
}));

vi.mock('../cross-shard-account-list', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cross-shard-account-list')>()),
  // The admin view finds a suspended account across the stores.
  CrossShardAccountExactSearchService: class {
    async find(input: { identifier: string; purpose: string }) {
      if (input.purpose !== 'admin_view') throw new Error('unexpected purpose');
      if (state.withoutPii.has(input.identifier)) {
        throw new Error('cross_shard_account_pii_owner_invalid');
      }
      const index = state.accounts.findIndex(({ users }) => users.has(input.identifier));
      return index < 0
        ? []
        : [
            {
              legacyUserId: input.identifier,
              coreBindingRef: `USERS_${index}`,
              piiBindingRef: `USERS_${index}`,
            },
          ];
    }
  },
}));

/** The account database a user is routed to. */
function accountOf(userId: string) {
  const account = state.accounts.find(({ users }) => users.has(userId));
  if (!account) throw new Error('account_data_route_not_found');
  return account.adapter;
}

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    // Accounts are routed: each to one of the tenant's user stores.
    getTenantMetadataContextFromHono: vi.fn(() => ({
      tenantId: 'tenant-a',
      route: { allocationScope: 'shared_pool', bindingRef: state.metadataBinding },
    })),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: state.metadata.adapter })),
    resolveTenantAssignedDatabaseSourcesFromRegistry: vi.fn(async () =>
      state.accounts.map((account, index) => ({
        bindingRef: `USERS_${index}`,
        source: state.registryAdapters?.[index] ?? account.adapter,
      }))
    ),
    resolveAccountDataContext: vi.fn(async (_env: unknown, input: { accountId: string }) => {
      if (state.suspended.has(input.accountId)) {
        throw new Error('lookup_destination_revalidation_failed', { cause: 'account_inactive' });
      }
      return { coreDb: accountOf(input.accountId), piiDb: accountOf(input.accountId) };
    }),
    resolveAccountDataContextFromHono: vi.fn(
      async (c: { set(key: string, value: unknown): void }, userId: string) => {
        const context = { tenantId: 'tenant-a', accountId: userId, coreDb: accountOf(userId) };
        c.set('accountDataContext', context);
        return context;
      }
    ),
    createAccountAuthContextFromHono: vi.fn((c: { get(key: string): unknown }) => ({
      coreAdapter: (c.get('accountDataContext') as { coreDb: unknown }).coreDb,
    })),
    hasPIIDatabase: vi.fn(() => true),
    createPIIContextFromHono: vi.fn(() => ({ defaultPiiAdapter: {} })),
    createAuditLogFromContext: vi.fn(async () => undefined),
    getLogger: vi.fn(() => ({
      module: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    })),
    // A user is found in the account database it is read from, and only there.
    CanonicalRuntimeUserStore: class {
      constructor(private readonly options: { coreAdapter: DatabaseAdapter }) {}
      async findById(userId: string) {
        const row = await this.options.coreAdapter.queryOne<{ id: string }>(
          'SELECT id FROM identity_accounts WHERE legacy_user_id = ?',
          [userId]
        );
        return row ? { id: userId, email: `${userId}@example.test`, name: userId } : null;
      }
    },
  };
});

import {
  adminRoleAssignmentsListHandler,
  adminRoleDeleteHandler,
  adminRoleGetHandler,
  adminRoleGroupAssignmentsListHandler,
  adminRolesListHandler,
  adminUserEffectivePermissionsHandler,
} from '../admin-rbac';
import { adminAccessControlStatsHandler } from '../admin-access-control-stats';
import { adminGroupMembersListHandler } from '../admin-groups';

// Admin operations are recorded through the forwarding shim (see the helper).
vi.mock('../admin-operation-audit', () => import('./helpers/legacy-admin-audit-shim'));

const NOW = Math.floor(Date.now() / 1000);

function context(options: { id?: string; query?: Record<string, string> } = {}) {
  const values = new Map<string, unknown>([
    ['adminAuth', { userId: 'admin-1', maxGrantTier: 3, permissions: ['admin:*'] }],
  ]);
  return {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => values.set(key, value),
    req: {
      param: (name: string) => (name === 'id' ? options.id : undefined),
      query: (name: string) => options.query?.[name],
      json: async () => ({}),
    },
    // The user stores' bindings, by the names their routes give.
    env: Object.fromEntries(
      state.accounts.map(({ adapter }, index) => [`USERS_${index}`, adapter])
    ),
    json: (body: unknown, status = 200) => Response.json(body, { status }),
  } as never;
}

function addUser(store: Store, id: string) {
  store.db
    .prepare(
      `INSERT INTO identity_accounts
         (id, tenant_id, account_type, lifecycle_state, legacy_user_id, created_at, updated_at)
       VALUES (?, 'tenant-a', 'user', 'active', ?, ?, ?)`
    )
    .run(`account:${id}`, id, NOW, NOW);
  state.accounts.find(({ adapter }) => adapter === store.adapter)!.users.add(id);
}

function assign(
  store: Store,
  row: { id: string; subject: string; role: string; scope?: string; target?: string; at: number }
) {
  store.db
    .prepare(
      `INSERT INTO role_assignments
         (id, tenant_id, subject_id, role_id, scope_type, scope_target, created_at, updated_at)
       VALUES (?, 'tenant-a', ?, ?, ?, ?, ?, ?)`
    )
    .run(row.id, row.subject, row.role, row.scope ?? 'global', row.target ?? '', row.at, row.at);
}

function join(store: Store, row: { id: string; subject: string; group: string; at: number }) {
  store.db
    .prepare(
      `INSERT INTO group_memberships
         (id, tenant_id, group_id, subject_id, assignment_source, source_ref, created_at, updated_at)
       VALUES (?, 'tenant-a', ?, ?, 'manual', '', ?, ?)`
    )
    .run(row.id, row.group, row.subject, row.at, row.at);
}

/**
 * Routed account storage: role and group definitions in the tenant metadata database,
 * each account's assignments and memberships in its own user store. Three separate SQLite
 * databases stand in for the three D1 databases, so a count or list that reads only one of them
 * (or joins a definition in an account database) comes out wrong here.
 */
describe('RBAC admin views under routed account storage', () => {
  let metadata: Store;
  let first: Store;
  let second: Store;

  beforeEach(() => {
    metadata = openCoreStore();
    first = openCoreStore();
    second = openCoreStore();
    state.metadata = metadata;
    state.suspended = new Set();
    state.withoutPii = new Set();
    state.metadataBinding = undefined;
    state.registryAdapters = null;
    state.accounts = [
      { adapter: first.adapter, users: new Set() },
      { adapter: second.adapter, users: new Set() },
    ];
    metadata.db
      .prepare(
        `INSERT INTO roles (id, tenant_id, name, permissions_json, created_at, role_type, is_system)
         VALUES ('role-a', 'tenant-a', 'auditor', '["audit:read"]', ?, 'custom', 0),
                ('role-b', 'tenant-a', 'editor', '["doc:write"]', ?, 'custom', 0),
                ('role-free', 'tenant-a', 'unused', '["x:y"]', ?, 'custom', 0)`
      )
      .run(NOW, NOW, NOW);
    metadata.db
      .prepare(
        `INSERT INTO "groups" (id, tenant_id, group_key, display_name, created_at, updated_at)
         VALUES ('grp-root', 'tenant-a', 'root', 'Root', ?, ?)`
      )
      .run(NOW, NOW);
    metadata.db
      .prepare(
        `INSERT INTO "groups" (id, tenant_id, group_key, display_name, parent_group_id, created_at,
           updated_at)
         VALUES ('grp-child', 'tenant-a', 'child', 'Child', 'grp-root', ?, ?)`
      )
      .run(NOW, NOW);
    addUser(first, 'user-1');
    addUser(first, 'user-2');
    addUser(second, 'user-3');
    assign(first, { id: 'ra-1', subject: 'user-1', role: 'role-a', at: NOW - 30 });
    assign(second, { id: 'ra-2', subject: 'user-3', role: 'role-a', at: NOW - 10 });
    assign(second, {
      id: 'ra-3',
      subject: 'user-3',
      role: 'role-b',
      scope: 'group',
      target: 'group:grp-root',
      at: NOW - 20,
    });
    // An assignment of a role deleted since: it names nothing and is counted nowhere.
    assign(first, { id: 'ra-4', subject: 'user-2', role: 'role-gone', at: NOW - 5 });
    join(first, { id: 'm-1', subject: 'user-1', group: 'grp-root', at: NOW - 30 });
    join(second, { id: 'm-2', subject: 'user-3', group: 'grp-root', at: NOW - 10 });
    join(second, { id: 'm-3', subject: 'user-3', group: 'grp-child', at: NOW - 5 });
  });

  it('counts the holders of each role in every account database', async () => {
    const body = (await (await adminRolesListHandler(context())).json()) as {
      roles: Array<{ id: string; assignment_count: number }>;
    };
    expect(Object.fromEntries(body.roles.map((role) => [role.id, role.assignment_count]))).toEqual({
      'role-a': 2,
      'role-b': 1,
      'role-free': 0,
    });
    const role = (await (await adminRoleGetHandler(context({ id: 'role-a' }))).json()) as {
      role: { assignment_count: number };
    };
    expect(role.role.assignment_count).toBe(2);
  });

  it('refuses to delete a role assigned in another account database, and deletes it after', async () => {
    // Only the second database holds role-b.
    const refused = await adminRoleDeleteHandler(context({ id: 'role-b' }));
    expect(refused.status).toBe(409);
    expect((await refused.json()) as { error: string }).toMatchObject({ error: 'role_in_use' });
    expect(metadata.db.prepare("SELECT id FROM roles WHERE id = 'role-b'").get()).toBeTruthy();

    const deleted = await adminRoleDeleteHandler(context({ id: 'role-free' }));
    expect(deleted.status).toBe(200);
    expect(metadata.db.prepare("SELECT id FROM roles WHERE id = 'role-free'").get()).toBeFalsy();
  });

  it('pages the assignments of a role across the account databases, with their contacts', async () => {
    const page = async (pageNumber: string) =>
      (await (
        await adminRoleAssignmentsListHandler(
          context({ id: 'role-a', query: { page: pageNumber, limit: '1' } })
        )
      ).json()) as {
        assignments: Array<{ assignment_id: string; user_email: string | null }>;
        pagination: { total: number; totalPages: number; hasNext: boolean };
      };
    const firstPage = await page('1');
    expect(firstPage.assignments).toEqual([
      expect.objectContaining({ assignment_id: 'ra-2', user_email: 'user-3@example.test' }),
    ]);
    expect(firstPage.pagination).toMatchObject({ total: 2, totalPages: 2, hasNext: true });
    expect((await page('2')).assignments).toEqual([
      expect.objectContaining({ assignment_id: 'ra-1', user_email: 'user-1@example.test' }),
    ]);
  });

  it('lists the groups a role is granted to, with the group and the scope, paged', async () => {
    const grant = (id: string, group: string, at: number, scope = 'global', target = '') =>
      metadata.db
        .prepare(
          `INSERT INTO group_role_assignments
             (id, tenant_id, group_id, role_id, scope_type, scope_target, expires_at, assigned_by,
              created_at, updated_at)
           VALUES (?, 'tenant-a', ?, 'role-a', ?, ?, ?, 'admin-1', ?, ?)`
        )
        .run(id, group, scope, target, id === 'gr-2' ? NOW + 3600 : null, at, at);
    grant('gr-1', 'grp-root', NOW - 20);
    grant('gr-2', 'grp-child', NOW - 10, 'group', 'group:grp-root');
    // A grant of another role and of a group deleted since.
    metadata.db
      .prepare(
        `INSERT INTO group_role_assignments (id, tenant_id, group_id, role_id, created_at, updated_at)
         VALUES ('gr-other', 'tenant-a', 'grp-root', 'role-b', ?, ?)`
      )
      .run(NOW, NOW);
    grant('gr-3', 'grp-gone', NOW - 5);

    const page = async (id: string, pageNumber = '1', limit = '10') => {
      const response = await adminRoleGroupAssignmentsListHandler(
        context({ id, query: { page: pageNumber, limit } })
      );
      return {
        status: response.status,
        body: (await response.json()) as {
          role_name: string;
          group_assignments: Array<Record<string, unknown>>;
          pagination: { total: number; totalPages: number; hasNext: boolean };
        },
      };
    };
    const all = await page('role-a');
    expect(all.body.role_name).toBe('auditor');
    expect(all.body.group_assignments.map((row) => row.assignment_id)).toEqual([
      'gr-1',
      'gr-2',
      'gr-3',
    ]);
    expect(all.body.group_assignments[0]).toMatchObject({
      group_id: 'grp-root',
      group_key: 'root',
      group_display_name: 'Root',
      scope: 'global',
      expires_at: null,
    });
    expect(all.body.group_assignments[1]).toMatchObject({
      group_key: 'child',
      scope: 'group',
      scope_target: 'group:grp-root',
      assigned_by: 'admin-1',
      expires_at: (NOW + 3600) * 1000,
    });
    expect(all.body.group_assignments[2]).toMatchObject({ group_key: null });
    const second = await page('role-a', '2', '2');
    expect(second.body.group_assignments.map((row) => row.assignment_id)).toEqual(['gr-3']);
    expect(second.body.pagination).toMatchObject({ total: 3, totalPages: 2, hasNext: false });
    expect((await page('role-b')).body.group_assignments).toHaveLength(1);
    expect((await page('role-missing')).status).toBe(404);

    // The listing reads the metadata database only: no account store is resolved, so an
    // unavailable one cannot break it.
    const lib = await import('@authrim/ar-lib-core');
    const resolve = vi.mocked(lib.resolveTenantAssignedDatabaseSourcesFromRegistry);
    resolve.mockClear();
    expect((await page('role-a')).status).toBe(200);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('lists the members of a group in every account database', async () => {
    const members = (await (
      await adminGroupMembersListHandler(context({ id: 'grp-root' }))
    ).json()) as {
      members: Array<{ subject_id: string }>;
      pagination: { total: number };
    };
    expect(members.pagination.total).toBe(2);
    expect(members.members.map((member) => member.subject_id)).toEqual(['user-3', 'user-1']);
  });

  it("reads a user's effective permissions from its account and the role definitions", async () => {
    const body = (await (
      await adminUserEffectivePermissionsHandler(context({ id: 'user-3' }))
    ).json()) as {
      permissions: Array<{ permission: string; source_name: string }>;
      roles: Array<{ role_id: string; scope: string }>;
    };
    // role-b is assigned for grp-root only: it grants nothing tenant-wide.
    expect(body.permissions).toEqual([
      expect.objectContaining({ permission: 'audit:read', source_name: 'auditor' }),
    ]);
    expect(body.roles.map((role) => [role.role_id, role.scope])).toEqual([
      ['role-a', 'global'],
      ['role-b', 'group'],
    ]);
    expect(body).not.toHaveProperty('organizations');
  });

  it("lists a suspended member's contact, read through the admin view of the stores", async () => {
    state.suspended.add('user-3');
    const members = (await (
      await adminGroupMembersListHandler(context({ id: 'grp-root' }))
    ).json()) as { members: Array<{ subject_id: string; user_email: string | null }> };
    expect(members.members).toEqual([
      expect.objectContaining({ subject_id: 'user-3', user_email: 'user-3@example.test' }),
      expect.objectContaining({ subject_id: 'user-1', user_email: 'user-1@example.test' }),
    ]);
  });

  it('lists a suspended member that holds no personal data, without a contact', async () => {
    state.suspended.add('user-3');
    state.withoutPii.add('user-3');
    const response = await adminGroupMembersListHandler(context({ id: 'grp-root' }));
    expect(response.status).toBe(200);
    const members = (await response.json()) as {
      members: Array<{ subject_id: string; user_email: string | null }>;
    };
    expect(members.members).toEqual([
      expect.objectContaining({ subject_id: 'user-3', user_email: null }),
      expect.objectContaining({ subject_id: 'user-1', user_email: 'user-1@example.test' }),
    ]);
  });

  it('counts a user store that is the metadata database itself once', async () => {
    // The default and the first user store are one D1 database, reached through two adapters.
    state.metadata = first;
    state.metadataBinding = 'USERS_0';
    state.registryAdapters = [{ ...first.adapter }, second.adapter];
    first.db
      .prepare(
        `INSERT INTO relationships (id, tenant_id, relationship_type, from_type, from_id, to_type, to_id, created_at, updated_at)
         VALUES ('rel-1', 'tenant-a', 'parent_child', 'subject', 'user-1', 'subject', 'user-2', ?, ?)`
      )
      .run(NOW, NOW);
    const body = (await (await adminAccessControlStatsHandler(context())).json()) as {
      rebac: { total_tuples: number };
    };
    expect(body.rebac.total_tuples).toBe(1);
  });

  it('adds up access-control totals over the account databases, without dangling assignments', async () => {
    first.db
      .prepare(
        `INSERT INTO relationships (id, tenant_id, relationship_type, from_type, from_id, to_type, to_id, created_at, updated_at)
         VALUES ('rel-1', 'tenant-a', 'parent_child', 'subject', 'user-1', 'subject', 'user-2', ?, ?)`
      )
      .run(NOW, NOW);
    // The Admin API writes tuples in the metadata database today; they count too.
    metadata.db
      .prepare(
        `INSERT INTO relationships (id, tenant_id, relationship_type, from_type, from_id, to_type, to_id, created_at, updated_at)
         VALUES ('rel-2', 'tenant-a', 'parent_child', 'subject', 'user-3', 'subject', 'user-1', ?, ?)`
      )
      .run(NOW, NOW);
    const body = (await (await adminAccessControlStatsHandler(context())).json()) as {
      rbac: { total_roles: number; total_assignments: number };
      rebac: { total_tuples: number };
    };
    expect(body.rbac).toEqual({ total_roles: 3, total_assignments: 3 });
    expect(body.rebac.total_tuples).toBe(2);
  });
});
