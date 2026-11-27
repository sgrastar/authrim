import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openCoreStore } from './helpers/core-schema-sqlite';

const mocks = vi.hoisted(() => ({ stores: vi.fn() }));
vi.mock('../compliance/tenant-stores', () => ({ tenantCoreStores: mocks.stores }));

import { roleUsage } from '../admin-compliance';

type Store = ReturnType<typeof openCoreStore>;

function role(db: Store['db'], id: string, tenantId: string) {
  db.prepare(
    `INSERT INTO roles (id, tenant_id, name, permissions_json, created_at) VALUES (?, ?, ?, '[]', 0)`
  ).run(id, tenantId, id);
}

function assign(
  db: Store['db'],
  id: string,
  tenantId: string,
  userId: string,
  roleId: string,
  expiresAt: number | null = null
) {
  db.prepare(
    `INSERT INTO role_assignments (id, tenant_id, subject_id, role_id, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 0)`
  ).run(id, tenantId, userId, roleId, expiresAt);
}

function group(
  db: Store['db'],
  id: string,
  tenantId: string,
  parent: string | null = null,
  lifecycle = 'active'
) {
  db.prepare(
    `INSERT INTO "groups" (id, tenant_id, group_key, display_name, parent_group_id, lifecycle_state,
       kind, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'scim', 0, 0)`
  ).run(id, tenantId, `scim:${id}`, id, parent, lifecycle);
}

function grant(
  db: Store['db'],
  groupId: string,
  tenantId: string,
  roleId: string,
  expiresAt: number | null = null
) {
  db.prepare(
    `INSERT INTO group_role_assignments (id, tenant_id, group_id, role_id, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 0)`
  ).run(`gra-${groupId}-${roleId}`, tenantId, groupId, roleId, expiresAt);
}

function member(
  db: Store['db'],
  tenantId: string,
  userId: string,
  groupId: string,
  options: { source?: string; ref?: string; state?: string; expiresAt?: number | null } = {}
) {
  db.prepare(
    `INSERT INTO group_memberships (id, tenant_id, group_id, subject_id, assignment_source, source_ref,
       lifecycle_state, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`
  ).run(
    crypto.randomUUID(),
    tenantId,
    groupId,
    userId,
    options.source ?? 'scim',
    options.ref ?? 'token-a',
    options.state ?? 'active',
    options.expiresAt ?? null
  );
}

describe('compliance role usage', () => {
  let main: Store;
  beforeEach(() => {
    main = openCoreStore('tenant-a');
    mocks.stores.mockResolvedValue([{ bindingRef: 'DB', adapter: main.adapter }]);
    role(main.db, 'admin', 'tenant-a');
    role(main.db, 'viewer', 'tenant-a');
    role(main.db, 'other', 'tenant-b');
  });

  it('counts users with an unexpired assignment, each user once', async () => {
    const now = Math.floor(Date.now() / 1000);
    assign(main.db, 'ra-1', 'tenant-a', 'user-both', 'admin');
    assign(main.db, 'ra-1b', 'tenant-a', 'user-both', 'viewer');
    assign(main.db, 'ra-2', 'tenant-a', 'user-assigned', 'admin', now + 3600);
    // Not counted: an expired assignment, and roles of another tenant.
    assign(main.db, 'ra-3', 'tenant-a', 'user-expired', 'admin', now - 1);
    assign(main.db, 'ra-4', 'tenant-b', 'user-b', 'other');

    expect(await roleUsage({} as never, 'tenant-a', main.adapter)).toEqual({
      active_roles: 2,
      users_with_roles: 2,
    });
  });

  it('counts members of a group that holds a role, also through an ancestor', async () => {
    const now = Math.floor(Date.now() / 1000);
    group(main.db, 'parent', 'tenant-a');
    group(main.db, 'child', 'tenant-a', 'parent');
    group(main.db, 'plain', 'tenant-a');
    group(main.db, 'stopped', 'tenant-a', 'parent', 'suspended');
    group(main.db, 'expired-grant', 'tenant-a');
    grant(main.db, 'parent', 'tenant-a', 'viewer');
    grant(main.db, 'expired-grant', 'tenant-a', 'viewer', now - 1);
    // A direct member of the granted group, and a member of its child (SCIM and manual alike).
    member(main.db, 'tenant-a', 'user-parent', 'parent');
    member(main.db, 'tenant-a', 'user-child', 'child', { source: 'manual', ref: '' });
    // A user both assigned directly and through a group is one user.
    assign(main.db, 'ra-1', 'tenant-a', 'user-child', 'admin');
    // Not counted: a group without roles, an inactive group below the granted one, an expired
    // group grant, and memberships no longer in force.
    member(main.db, 'tenant-a', 'user-plain', 'plain');
    member(main.db, 'tenant-a', 'user-stopped', 'stopped');
    member(main.db, 'tenant-a', 'user-expired-grant', 'expired-grant');
    member(main.db, 'tenant-a', 'user-revoked', 'parent', { state: 'revoked' });
    member(main.db, 'tenant-a', 'user-ended', 'parent', { expiresAt: now - 1 });

    expect(await roleUsage({} as never, 'tenant-a', main.adapter)).toEqual({
      active_roles: 2,
      users_with_roles: 2,
    });
  });

  it('never reads the SCIM role table (user_roles)', async () => {
    const query = vi.spyOn(main.adapter, 'query');
    await roleUsage({} as never, 'tenant-a', main.adapter);
    expect(query).toHaveBeenCalled();
    for (const [sql] of query.mock.calls) expect(String(sql)).not.toContain('user_roles');
  });

  it('reads no membership when no group holds a role, and never the whole group table', async () => {
    group(main.db, 'plain', 'tenant-a');
    member(main.db, 'tenant-a', 'user-plain', 'plain');
    assign(main.db, 'ra-1', 'tenant-a', 'user-1', 'admin');
    const query = vi.spyOn(main.adapter, 'query');
    expect(await roleUsage({} as never, 'tenant-a', main.adapter)).toMatchObject({
      users_with_roles: 1,
    });
    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes('group_memberships'))).toBe(false);
    expect(statements.some((sql) => sql.includes('FROM "groups"'))).toBe(false);

    // With a granted group, groups are read by id and by parent only.
    grant(main.db, 'plain', 'tenant-a', 'viewer');
    query.mockClear();
    expect(await roleUsage({} as never, 'tenant-a', main.adapter)).toMatchObject({
      users_with_roles: 2,
    });
    for (const sql of query.mock.calls.map(([sql]) => String(sql)))
      if (sql.includes('FROM "groups"')) expect(sql).toMatch(/AND (id|parent_group_id) IN \(/);
  });

  it('adds the users of each store, counting a user with holdings in two stores once', async () => {
    const users = openCoreStore('tenant-a');
    group(main.db, 'g', 'tenant-a');
    grant(main.db, 'g', 'tenant-a', 'viewer');
    // Memberships and assignments live with each account; the definitions in the metadata store.
    member(users.db, 'tenant-a', 'user-1', 'g');
    assign(main.db, 'ra-1', 'tenant-a', 'user-1', 'admin');
    assign(users.db, 'ra-2', 'tenant-a', 'user-2', 'admin');
    mocks.stores.mockResolvedValue([
      { bindingRef: 'DB', adapter: main.adapter },
      { bindingRef: 'DB_USERS_1', adapter: users.adapter },
    ]);
    expect(await roleUsage({} as never, 'tenant-a', main.adapter)).toMatchObject({
      users_with_roles: 2,
    });
  });
});
