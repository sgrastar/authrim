import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ stores: vi.fn() }));
vi.mock('../compliance/tenant-stores', () => ({ tenantCoreStores: mocks.stores }));

import { roleUsage } from '../admin-compliance';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

type SqlValue = string | number | null;
const values = (params: unknown[] = []) =>
  params.map((value): SqlValue => (value === undefined ? null : (value as SqlValue)));

function store() {
  const db = new DatabaseSync(':memory:');
  db.exec(
    readFileSync(resolve(REPO_ROOT, 'migrations/core/d1/001_0_4_0_core_baseline.sql'), 'utf8')
      .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
      .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
  );
  db.exec('PRAGMA foreign_keys = OFF');
  return {
    db,
    adapter: {
      async queryOne(sql: string, params?: unknown[]) {
        return db.prepare(sql).get(...values(params)) ?? null;
      },
      async query(sql: string, params?: unknown[]) {
        return db.prepare(sql).all(...values(params));
      },
    },
  };
}

function role(db: DatabaseSync, id: string, tenantId: string) {
  db.prepare(
    `INSERT INTO roles (id, tenant_id, name, permissions_json, created_at) VALUES (?, ?, ?, '[]', 0)`
  ).run(id, tenantId, id);
}

function assign(
  db: DatabaseSync,
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

function scim(db: DatabaseSync, tenantId: string, userId: string, roleId: string) {
  db.prepare(
    'INSERT INTO user_roles (user_id, role_id, created_at, tenant_id) VALUES (?, ?, 0, ?)'
  ).run(userId, roleId, tenantId);
}

describe('compliance role usage', () => {
  let main: ReturnType<typeof store>;
  beforeEach(() => {
    main = store();
    mocks.stores.mockResolvedValue([{ bindingRef: 'DB', adapter: main.adapter }]);
    role(main.db, 'admin', 'tenant-a');
    role(main.db, 'viewer', 'tenant-a');
    role(main.db, 'other', 'tenant-b');
  });

  it('counts users with a role from SCIM or an unexpired assignment, each user once', async () => {
    const now = Math.floor(Date.now() / 1000);
    // SCIM only.
    scim(main.db, 'tenant-a', 'user-scim', 'viewer');
    // Both ways (counted once).
    assign(main.db, 'ra-1', 'tenant-a', 'user-both', 'admin');
    scim(main.db, 'tenant-a', 'user-both', 'viewer');
    // An assignment only.
    assign(main.db, 'ra-2', 'tenant-a', 'user-assigned', 'admin', now + 3600);
    // Not counted: an expired assignment, and roles of another tenant.
    assign(main.db, 'ra-3', 'tenant-a', 'user-expired', 'admin', now - 1);
    assign(main.db, 'ra-4', 'tenant-b', 'user-b', 'other');
    scim(main.db, 'tenant-b', 'user-b2', 'other');

    expect(await roleUsage({} as never, 'tenant-a', main.adapter as never)).toEqual({
      active_roles: 2,
      users_with_roles: 3,
    });
  });

  it('adds the users of each store (a routed tenant keeps them with each account)', async () => {
    const users = store();
    scim(main.db, 'tenant-a', 'user-1', 'viewer');
    // A user store holds its own assignment and the role it names (sign-in joins them there).
    assign(users.db, 'ra-1', 'tenant-a', 'user-2', 'admin');
    role(users.db, 'admin', 'tenant-a');
    mocks.stores.mockResolvedValue([
      { bindingRef: 'DB', adapter: main.adapter },
      { bindingRef: 'DB_USERS_1', adapter: users.adapter },
    ]);
    expect(await roleUsage({} as never, 'tenant-a', main.adapter as never)).toMatchObject({
      users_with_roles: 2,
    });
  });

  it('counts a user with roles in two stores once', async () => {
    const users = store();
    role(users.db, 'admin', 'tenant-a');
    // SCIM gave the user a role in the default store; an assignment lives with the account.
    scim(main.db, 'tenant-a', 'user-1', 'viewer');
    assign(users.db, 'ra-1', 'tenant-a', 'user-1', 'admin');
    assign(users.db, 'ra-2', 'tenant-a', 'user-2', 'admin');
    mocks.stores.mockResolvedValue([
      { bindingRef: 'DB', adapter: main.adapter },
      { bindingRef: 'DB_USERS_1', adapter: users.adapter },
    ]);
    expect(await roleUsage({} as never, 'tenant-a', main.adapter as never)).toMatchObject({
      users_with_roles: 2,
    });
  });
});
