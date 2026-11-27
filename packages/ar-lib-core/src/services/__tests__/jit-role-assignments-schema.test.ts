import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { DatabaseAdapter } from '../../db/adapter';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import { assignScopedRoleToUser } from '../jit-role-assignment';
import { singleDatabaseRBAC } from '../tenant-rbac';

const NOW = 1_800_000_000;

/**
 * The role a JIT rule gives (external IdP role rules, the default role), written where token
 * issuance reads it (role_assignments.subject_id), in the real D1 schema.
 */
describe('JIT role assignments in the real schema', () => {
  let db: DatabaseSync;
  let adapter: DatabaseAdapter;

  beforeEach(() => {
    const opened = sqliteAdapter();
    db = opened.db;
    adapter = {
      ...opened.adapter,
      transaction: async () => {
        throw new Error('not used');
      },
      isHealthy: async () => ({ healthy: true, latencyMs: 0 }),
      getType: () => 'sqlite',
      close: async () => undefined,
    } as DatabaseAdapter;
    db.prepare(
      `INSERT INTO tenants (id, tenant_code, tenant_key, name, created_at, updated_at)
       VALUES ('tenant-a', 'code-a', 'key-a', 'Tenant A', ?, ?)`
    ).run(NOW, NOW);
    db.prepare(
      `INSERT INTO identity_accounts (id, tenant_id, account_type, legacy_user_id, created_at, updated_at) VALUES ('account:user-1', 'tenant-a', 'user', 'user-1', ?, ?)`
    ).run(NOW, NOW);
    db.prepare(
      `INSERT INTO roles (id, tenant_id, name, permissions_json, created_at, role_type, is_system)
       VALUES ('role-1', 'tenant-a', 'member', '[]', ?, 'custom', 0)`
    ).run(NOW);
  });

  it('gives a role at the scope a JIT rule or the default role names, once', async () => {
    const result = await assignScopedRoleToUser(
      singleDatabaseRBAC(adapter),
      'user-1',
      'role-1',
      'global',
      '',
      'tenant-a'
    );

    const again = await assignScopedRoleToUser(
      singleDatabaseRBAC(adapter),
      'user-1',
      'role-1',
      'global',
      '',
      'tenant-a'
    );

    expect(result).toMatchObject({ success: true });
    expect(again).toMatchObject({ success: true, error: 'Already assigned' });
    expect(
      db.prepare('SELECT subject_id, scope_type, scope_target FROM role_assignments').all()
    ).toEqual([{ subject_id: 'user-1', scope_type: 'global', scope_target: '' }]);
  });

  it('skips a role that is not assignable', async () => {
    db.exec(`UPDATE roles SET is_assignable = 0 WHERE id = 'role-1'`);
    const result = await assignScopedRoleToUser(
      singleDatabaseRBAC(adapter),
      'user-1',
      'role-1',
      'global',
      '',
      'tenant-a'
    );

    expect(result).toMatchObject({ success: false, error: 'Role not assignable' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM role_assignments').get()).toEqual({ n: 0 });
  });

  it("gives nothing from another tenant's role", async () => {
    const result = await assignScopedRoleToUser(
      singleDatabaseRBAC(adapter),
      'user-1',
      'role-1',
      'global',
      '',
      'tenant-b'
    );

    expect(result).toMatchObject({ success: false, error: 'Role not found' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM role_assignments').get()).toEqual({ n: 0 });
  });
});
