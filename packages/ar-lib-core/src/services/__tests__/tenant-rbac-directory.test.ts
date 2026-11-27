import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { DatabaseAdapter } from '../../db/adapter';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import {
  countGroupMembers,
  countRoleAssignments,
  listGroupMembersPage,
  listRoleAssignmentsPage,
  MAX_MERGED_ROWS,
  MergedPageTooDeepError,
} from '../tenant-rbac-directory';

const NOW = 1_800_000_000;

type Store = { db: DatabaseSync; adapter: DatabaseAdapter };

function openStore(): Store {
  const opened = sqliteAdapter();
  opened.db
    .prepare(
      `INSERT INTO tenants (id, tenant_code, tenant_key, name, created_at, updated_at)
       VALUES ('tenant-a', 'code-a', 'key-a', 'Tenant A', ?, ?)`
    )
    .run(NOW, NOW);
  return opened;
}

function addUser(store: Store, id: string) {
  store.db
    .prepare(
      `INSERT INTO identity_accounts
         (id, tenant_id, account_type, lifecycle_state, legacy_user_id, created_at, updated_at)
       VALUES (?, 'tenant-a', 'user', 'active', ?, ?, ?)`
    )
    .run(`account:${id}`, id, NOW, NOW);
}

function assign(
  store: Store,
  row: { id: string; subject: string; role: string; createdAt: number; expiresAt?: number }
) {
  store.db
    .prepare(
      `INSERT INTO role_assignments
         (id, tenant_id, subject_id, role_id, scope_type, scope_target, expires_at, created_at, updated_at)
       VALUES (?, 'tenant-a', ?, ?, 'global', '', ?, ?, ?)`
    )
    .run(row.id, row.subject, row.role, row.expiresAt ?? null, row.createdAt, row.createdAt);
}

function join(
  store: Store,
  row: { id: string; subject: string; group: string; createdAt: number }
) {
  store.db
    .prepare(
      `INSERT INTO group_memberships
         (id, tenant_id, group_id, subject_id, assignment_source, source_ref, created_at, updated_at)
       VALUES (?, 'tenant-a', ?, ?, 'manual', '', ?, ?)`
    )
    .run(row.id, row.group, row.subject, row.createdAt, row.createdAt);
}

/**
 * Two account databases (separate SQLite databases, as two user stores are separate D1
 * databases): the roles and groups their rows name are defined elsewhere (the metadata
 * database), and nothing here joins them.
 */
describe('tenant-wide RBAC reads across account databases', () => {
  let first: Store;
  let second: Store;

  beforeEach(() => {
    first = openStore();
    second = openStore();
    addUser(first, 'user-1');
    addUser(first, 'user-2');
    addUser(second, 'user-3');
    assign(first, { id: 'ra-1', subject: 'user-1', role: 'role-a', createdAt: NOW - 50 });
    // A second, scoped assignment of the same role: one holder, two assignments.
    assign(first, { id: 'ra-2', subject: 'user-1', role: 'role-a', createdAt: NOW - 40 });
    assign(first, {
      id: 'ra-3',
      subject: 'user-2',
      role: 'role-a',
      createdAt: NOW - 30,
      expiresAt: NOW - 1,
    });
    assign(second, { id: 'ra-4', subject: 'user-3', role: 'role-a', createdAt: NOW - 45 });
    assign(second, { id: 'ra-5', subject: 'user-3', role: 'role-b', createdAt: NOW - 20 });
    join(first, { id: 'm-1', subject: 'user-1', group: 'grp-1', createdAt: NOW - 10 });
    join(first, { id: 'm-2', subject: 'user-2', group: 'grp-1', createdAt: NOW - 30 });
    join(second, { id: 'm-3', subject: 'user-3', group: 'grp-1', createdAt: NOW - 20 });
    join(second, { id: 'm-4', subject: 'user-3', group: 'grp-2', createdAt: NOW - 5 });
  });

  it('adds up the holders of each role across the databases', async () => {
    const stores = [first.adapter, second.adapter];
    expect(
      Object.fromEntries(await countRoleAssignments(stores, 'tenant-a', { per: 'subject' }))
    ).toEqual({ 'role-a': 3, 'role-b': 1 });
    expect(
      Object.fromEntries(
        await countRoleAssignments(stores, 'tenant-a', { per: 'assignment', roleIds: ['role-a'] })
      )
    ).toEqual({ 'role-a': 4 });
    expect(
      Object.fromEntries(
        await countRoleAssignments(stores, 'tenant-a', { per: 'subject', activeAt: NOW })
      )
    ).toEqual({ 'role-a': 2, 'role-b': 1 });
    // Reading one database alone misses what the other holds.
    expect(
      Object.fromEntries(
        await countRoleAssignments([first.adapter], 'tenant-a', { per: 'subject' })
      )
    ).toEqual({ 'role-a': 2 });
  });

  it('counts the members of groups across the databases', async () => {
    const stores = [first.adapter, second.adapter];
    expect(
      Object.fromEntries(await countGroupMembers(stores, 'tenant-a', ['grp-1', 'grp-2'], NOW))
    ).toEqual({
      'grp-1': 3,
      'grp-2': 1,
    });
    expect(
      Object.fromEntries(await countGroupMembers(stores, 'tenant-a', ['grp-2', 'grp-9'], NOW))
    ).toEqual({ 'grp-2': 1 });
    expect((await countGroupMembers(stores, 'tenant-a', [], NOW)).size).toBe(0);
  });

  it('pages the unexpired assignments of a role newest first across the databases', async () => {
    const stores = [first.adapter, second.adapter];
    const page = (offset: number) =>
      listRoleAssignmentsPage(stores, 'tenant-a', 'role-a', { activeAt: NOW, limit: 2, offset });

    const firstPage = await page(0);
    expect(firstPage.total).toBe(3);
    expect(firstPage.items.map(({ store, row }) => [store, row.id])).toEqual([
      [0, 'ra-2'],
      [1, 'ra-4'],
    ]);
    const secondPage = await page(2);
    expect(secondPage.total).toBe(3);
    expect(secondPage.items.map(({ store, row }) => [store, row.id])).toEqual([[0, 'ra-1']]);
  });

  it('pages the members of a group newest first across the databases', async () => {
    const page = await listGroupMembersPage([first.adapter, second.adapter], 'tenant-a', 'grp-1', {
      limit: 10,
      offset: 0,
    });
    expect(page.total).toBe(3);
    expect(page.items.map(({ store, row }) => [store, row.subject_id])).toEqual([
      [0, 'user-1'],
      [1, 'user-3'],
      [0, 'user-2'],
    ]);
  });

  it('reads one database by its own page, and refuses pages too deep to merge', async () => {
    const single = await listGroupMembersPage([first.adapter], 'tenant-a', 'grp-1', {
      limit: 1,
      offset: MAX_MERGED_ROWS,
    });
    expect(single).toEqual({ total: 2, items: [] });
    // Two databases each read up to the end of the page: the rows read add up over both.
    const both = [first.adapter, second.adapter];
    await expect(
      listGroupMembersPage(both, 'tenant-a', 'grp-1', {
        limit: 1,
        offset: MAX_MERGED_ROWS / 2 - 1,
      })
    ).resolves.toMatchObject({ items: [] });
    await expect(
      listGroupMembersPage(both, 'tenant-a', 'grp-1', {
        limit: 1,
        offset: MAX_MERGED_ROWS / 2,
      })
    ).rejects.toBeInstanceOf(MergedPageTooDeepError);
  });

  it('reads only the tenant asked for', async () => {
    expect((await countRoleAssignments([first.adapter], 'tenant-b', { per: 'subject' })).size).toBe(
      0
    );
    expect(
      (
        await listRoleAssignmentsPage([first.adapter], 'tenant-b', 'role-a', {
          activeAt: NOW,
          limit: 10,
          offset: 0,
        })
      ).total
    ).toBe(0);
  });
});
