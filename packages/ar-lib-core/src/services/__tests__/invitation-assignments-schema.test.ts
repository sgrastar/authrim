import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { DatabaseAdapter } from '../../db/adapter';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import { applyInvitationAssignments } from '../invitation-auth-core';
import { resolveScopedRoles } from '../../utils/rbac-claims';
import { evaluatePermissionsForScope } from '../../utils/policy-embedding';
import { singleDatabaseRBAC } from '../tenant-rbac';

const NOW = 1_800_000_000;

/**
 * The role and group an invitation gives, written where token issuance reads them
 * (role_assignments.subject_id, group_memberships.subject_id), in the real D1 schema.
 */
describe('invitation assignments in the real schema', () => {
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
       VALUES ('role-1', 'tenant-a', 'member', '["documents:read"]', ?, 'custom', 0)`
    ).run(NOW);
    db.prepare(
      `INSERT INTO "groups" (id, tenant_id, group_key, display_name, lifecycle_state, created_at,
         updated_at)
       VALUES ('grp-1', 'tenant-a', 'one', 'Group One', 'active', ?, ?)`
    ).run(NOW, NOW);
  });

  it('gives the role and the group to the user, once', async () => {
    const input = {
      userId: 'user-1',
      tenantId: 'tenant-a',
      roleId: 'role-1',
      groupId: 'grp-1',
      invitationId: 'inv-1',
    };
    const first = await applyInvitationAssignments(singleDatabaseRBAC(adapter), input);
    const second = await applyInvitationAssignments(singleDatabaseRBAC(adapter), input);

    expect(Object.keys(first).sort()).toEqual(['groupMembership', 'roleAssignment']);
    expect(first.roleAssignment).toMatchObject({ success: true });
    expect(first.groupMembership).toEqual({ success: true });
    expect(second.roleAssignment).toMatchObject({ success: true, error: 'Already assigned' });
    expect(second.groupMembership).toEqual({ success: true });
    expect(
      db
        .prepare(
          `SELECT subject_id, role_id, scope_type, scope_target FROM role_assignments
           WHERE tenant_id = 'tenant-a'`
        )
        .all()
    ).toEqual([
      { subject_id: 'user-1', role_id: 'role-1', scope_type: 'global', scope_target: '' },
    ]);
    expect(
      db
        .prepare(
          `SELECT subject_id, group_id, assignment_source, source_ref FROM group_memberships
           WHERE tenant_id = 'tenant-a'`
        )
        .all()
    ).toEqual([
      {
        subject_id: 'user-1',
        group_id: 'grp-1',
        assignment_source: 'invitation',
        source_ref: 'inv-1',
      },
    ]);
  });

  it('gives a role that token issuance and policy embedding read as tenant-wide', async () => {
    await applyInvitationAssignments(singleDatabaseRBAC(adapter), {
      userId: 'user-1',
      tenantId: 'tenant-a',
      roleId: 'role-1',
      groupId: null,
    });

    expect(await resolveScopedRoles(singleDatabaseRBAC(adapter), 'user-1', 'tenant-a')).toEqual([
      { name: 'member', scope: 'global' },
    ]);
    expect(
      await evaluatePermissionsForScope(
        singleDatabaseRBAC(adapter),
        'user-1',
        'openid documents:read',
        {
          tenantId: 'tenant-a',
        }
      )
    ).toEqual(['documents:read']);
  });

  it("gives nothing from another tenant's role or group", async () => {
    const result = await applyInvitationAssignments(singleDatabaseRBAC(adapter), {
      userId: 'user-1',
      tenantId: 'tenant-b',
      roleId: 'role-1',
      groupId: 'grp-1',
      invitationId: 'inv-1',
    });

    expect(result.roleAssignment).toMatchObject({ success: false });
    expect(result.groupMembership).toMatchObject({ success: false });
    expect(db.prepare('SELECT COUNT(*) AS n FROM role_assignments').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM group_memberships').get()).toEqual({ n: 0 });
  });
});
