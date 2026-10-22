import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { DatabaseAdapter } from '../../db/adapter';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import { assignRoleToUser, assignScopedRoleToUser } from '../org-domain-resolver';

const NOW = 1_800_000_000;

/**
 * The role a JIT rule gives (external IdP role rules, domain mappings), written where token
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
      `INSERT INTO users_core (id, tenant_id, created_at, updated_at) VALUES ('user-1', 'tenant-a', ?, ?)`
    ).run(NOW, NOW);
    db.prepare(
      `INSERT INTO roles (id, tenant_id, name, permissions_json, created_at, role_type, is_system)
       VALUES ('role-1', 'tenant-a', 'member', '[]', ?, 'custom', 0)`
    ).run(NOW);
  });

  it('gives an organisation-scoped role to the user, once', async () => {
    const first = await assignRoleToUser(adapter, 'user-1', 'role-1', 'org-1', 'tenant-a');
    const second = await assignRoleToUser(adapter, 'user-1', 'role-1', 'org-1', 'tenant-a');

    expect(first).toMatchObject({ success: true });
    expect(second).toMatchObject({ success: true, error: 'Already assigned' });
    expect(
      db
        .prepare(
          `SELECT subject_id, role_id, scope_type, scope_target FROM role_assignments
           WHERE tenant_id = 'tenant-a'`
        )
        .all()
    ).toEqual([
      { subject_id: 'user-1', role_id: 'role-1', scope_type: 'org', scope_target: 'org:org-1' },
    ]);
  });

  it('gives a role at the scope a JIT rule or the default role names', async () => {
    const result = await assignScopedRoleToUser(
      adapter,
      'user-1',
      'role-1',
      'global',
      '',
      'tenant-a'
    );

    expect(result).toMatchObject({ success: true });
    expect(
      db.prepare('SELECT subject_id, scope_type, scope_target FROM role_assignments').all()
    ).toEqual([{ subject_id: 'user-1', scope_type: 'global', scope_target: '' }]);
  });

  it("gives nothing from another tenant's role", async () => {
    const result = await assignRoleToUser(adapter, 'user-1', 'role-1', 'org-1', 'tenant-b');

    expect(result).toMatchObject({ success: false, error: 'Role not found' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM role_assignments').get()).toEqual({ n: 0 });
  });
});
