import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { DatabaseAdapter } from '../../db/adapter';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import { applyInvitationAssignments } from '../invitation-auth-core';
import { joinOrganization } from '../org-domain-resolver';
import { resolveScopedRoles } from '../../utils/rbac-claims';
import { evaluatePermissionsForScope } from '../../utils/policy-embedding';

const NOW = 1_800_000_000;

/**
 * The role and organisation an invitation gives, written where token issuance reads them
 * (role_assignments.subject_id, subject_org_membership.subject_id), in the real D1 schema.
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
      `INSERT INTO users_core (id, tenant_id, created_at, updated_at) VALUES ('user-1', 'tenant-a', ?, ?)`
    ).run(NOW, NOW);
    db.prepare(
      `INSERT INTO roles (id, tenant_id, name, permissions_json, created_at, role_type, is_system)
       VALUES ('role-1', 'tenant-a', 'member', '["documents:read"]', ?, 'custom', 0)`
    ).run(NOW);
    db.prepare(
      `INSERT INTO organizations (id, tenant_id, name, created_at, updated_at)
       VALUES ('org-1', 'tenant-a', 'Org One', ?, ?)`
    ).run(NOW, NOW);
  });

  it('gives the role and the organisation to the user, once', async () => {
    const first = await applyInvitationAssignments(adapter, {
      userId: 'user-1',
      tenantId: 'tenant-a',
      roleId: 'role-1',
      orgId: 'org-1',
    });
    const second = await applyInvitationAssignments(adapter, {
      userId: 'user-1',
      tenantId: 'tenant-a',
      roleId: 'role-1',
      orgId: 'org-1',
    });

    expect(first.roleAssignment).toMatchObject({ success: true });
    expect(first.orgMembership).toMatchObject({ success: true });
    expect(second.roleAssignment).toMatchObject({ success: true, error: 'Already assigned' });
    expect(second.orgMembership).toMatchObject({ success: true, error: 'Already a member' });
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
          `SELECT subject_id, org_id, membership_type FROM subject_org_membership
           WHERE tenant_id = 'tenant-a'`
        )
        .all()
    ).toEqual([{ subject_id: 'user-1', org_id: 'org-1', membership_type: 'member' }]);
  });

  it('gives a role that token issuance and policy embedding read as tenant-wide', async () => {
    await applyInvitationAssignments(adapter, {
      userId: 'user-1',
      tenantId: 'tenant-a',
      roleId: 'role-1',
      orgId: null,
    });

    expect(await resolveScopedRoles(adapter, 'user-1', 'tenant-a')).toEqual([
      { name: 'member', scope: 'global' },
    ]);
    expect(
      await evaluatePermissionsForScope(adapter, 'user-1', 'openid documents:read', {
        tenantId: 'tenant-a',
      })
    ).toEqual(['documents:read']);
  });

  it("gives nothing from another tenant's role or organisation", async () => {
    const result = await applyInvitationAssignments(adapter, {
      userId: 'user-1',
      tenantId: 'tenant-b',
      roleId: 'role-1',
      orgId: 'org-1',
    });

    expect(result.roleAssignment).toMatchObject({ success: false });
    expect(result.orgMembership).toMatchObject({ success: false });
    expect(db.prepare('SELECT COUNT(*) AS n FROM role_assignments').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM subject_org_membership').get()).toEqual({ n: 0 });
  });

  it('joins an organisation with the given membership type (external IdP domain rules)', async () => {
    const joined = await joinOrganization(adapter, 'user-1', 'org-1', 'tenant-a', 'admin');

    expect(joined).toMatchObject({ success: true, org_id: 'org-1' });
    expect(
      db.prepare('SELECT subject_id, membership_type FROM subject_org_membership').all()
    ).toEqual([{ subject_id: 'user-1', membership_type: 'admin' }]);
  });
});
