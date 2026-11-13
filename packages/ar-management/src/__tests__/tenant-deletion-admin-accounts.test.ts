import { readRenderedMigrationSql } from '../../../../test/helpers/migration-source.mjs';
import { logProducerFixture } from '../../../../test/helpers/log-iceberg-producer-fixture.mjs';

import { resolve } from 'node:path';
import type { Env } from '@authrim/ar-lib-core';
import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLiteDatabase } from './test-sqlite';
import { sqliteAdapter } from './helpers/admin-authority-fixture';
import {
  createTenantAdminPurgeAuditWriter,
  purgeTenantHomedAdmins,
  type TenantAdminPurgeAuditEntry,
} from '../tenant-deletion-admin-accounts';

/**
 * The purge on the real Admin schema in SQLite (foreign keys enforced, so the cascades and the
 * constraints that block a delete are the real ones). Two tenants are seeded alike; purging X
 * must empty X and leave every row of Y as it was.
 */

const REPO_ROOT = resolve(__dirname, '../../../..');
const X = 'tenant-x';
const Y = 'tenant-y';
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

function openDatabase(): SQLiteDatabase {
  const db = new DatabaseSync(':memory:');
  for (const file of [
    '001_0_5_0_admin_baseline.sql',
    '003_admin_session_passkey_evidence.sql',
    '004_admin_second_factors.sql',
    '005_admin_second_factor_recoveries.sql',
    '006_admin_notices.sql',
    '007_admin_notice_indexes.sql',
    '008_admin_notice_delivery.sql',
    '010_keyring_second_factor_recoveries.sql',
    '011_admin_second_factor_reenroll_window.sql',
    '012_admin_groups.sql',
    '016_admin_invitation_code_delivery.sql',
  ]) {
    db.exec(readRenderedMigrationSql(resolve(REPO_ROOT, 'migrations/admin/d1/'), file));
  }
  return db;
}

type Row = Record<string, string | number | null>;

function put(db: SQLiteDatabase, table: string, row: Row): void {
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
  ).run(...columns.map((column) => row[column]));
}

function count(db: SQLiteDatabase, sql: string, ...params: Array<string | number>): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

/** Every table the purge may touch, and how to count the rows that belong to one tenant. */
const COUNTS: Record<string, string> = {
  admin_users: 'SELECT COUNT(*) AS n FROM admin_users WHERE tenant_id = ?',
  admin_sessions: 'SELECT COUNT(*) AS n FROM admin_sessions WHERE tenant_id = ?',
  admin_passkeys:
    'SELECT COUNT(*) AS n FROM admin_passkeys WHERE admin_user_id IN (SELECT id FROM admin_users WHERE tenant_id = ?)',
  admin_second_factors:
    'SELECT COUNT(*) AS n FROM admin_second_factors WHERE admin_user_id IN (SELECT id FROM admin_users WHERE tenant_id = ?)',
  admin_role_assignments: 'SELECT COUNT(*) AS n FROM admin_role_assignments WHERE tenant_id = ?',
  admin_roles: 'SELECT COUNT(*) AS n FROM admin_roles WHERE tenant_id = ?',
  admin_groups: 'SELECT COUNT(*) AS n FROM admin_groups WHERE tenant_id = ?',
  admin_group_members: 'SELECT COUNT(*) AS n FROM admin_group_members WHERE tenant_id = ?',
  admin_group_role_grants: 'SELECT COUNT(*) AS n FROM admin_group_role_grants WHERE tenant_id = ?',
  admin_invitations: 'SELECT COUNT(*) AS n FROM admin_invitations WHERE tenant_id = ?',
  admin_invitation_groups: 'SELECT COUNT(*) AS n FROM admin_invitation_groups WHERE tenant_id = ?',
  admin_invitation_enrollments:
    'SELECT COUNT(*) AS n FROM admin_invitation_enrollments WHERE invitation_id IN (SELECT id FROM admin_invitations WHERE tenant_id = ?)',
  admin_agent_grants: 'SELECT COUNT(*) AS n FROM admin_agent_grants WHERE tenant_id = ?',
  admin_agent_token_families:
    'SELECT COUNT(*) AS n FROM admin_agent_token_families WHERE tenant_id = ?',
  admin_agent_login_handoffs:
    'SELECT COUNT(*) AS n FROM admin_agent_login_handoffs WHERE target_tenant_id = ?',
  admin_audit_log: 'SELECT COUNT(*) AS n FROM admin_audit_log WHERE tenant_id = ?',
};

function snapshot(db: SQLiteDatabase, tenantId: string): Record<string, number> {
  return Object.fromEntries(
    Object.entries(COUNTS).map(([table, sql]) => [table, count(db, sql, tenantId)])
  );
}

function admin(db: SQLiteDatabase, tenant: string, id: string, email = `${id}@example.test`) {
  put(db, 'admin_users', {
    id,
    tenant_id: tenant,
    email,
    is_active: 1,
    status: 'active',
    created_at: NOW,
    updated_at: NOW,
  });
}

function assignment(
  db: SQLiteDatabase,
  id: string,
  tenant: string,
  userId: string,
  roleId: string,
  scopeType: 'global' | 'tenant',
  expiresAt: number | null = null
) {
  put(db, 'admin_role_assignments', {
    id,
    tenant_id: tenant,
    admin_user_id: userId,
    admin_role_id: roleId,
    scope_type: scopeType,
    scope_id: scopeType === 'tenant' ? tenant : null,
    expires_at: expiresAt,
    created_at: NOW,
  });
}

function session(
  db: SQLiteDatabase,
  id: string,
  tenant: string,
  userId: string,
  derived?: { parent: string; target: string }
) {
  put(db, 'admin_sessions', {
    id,
    tenant_id: tenant,
    admin_user_id: userId,
    created_at: NOW,
    expires_at: NOW + HOUR,
    parent_session_id: derived?.parent ?? null,
    derived_target_tenant_id: derived?.target ?? null,
  });
}

function agentGrant(db: SQLiteDatabase, id: string, tenant: string, grantor: string) {
  put(db, 'admin_agent_grants', {
    id,
    tenant_id: tenant,
    client_id: 'client',
    grantor_id: grantor,
    delegator_id: grantor,
    permissions: '[]',
    scopes: '[]',
    active_uniqueness_key: 'active',
    status: 'active',
    expires_at: NOW + 2 * HOUR,
    created_at: NOW,
    updated_at: NOW,
    task_set_id: 'ts',
    task_set_version: 1,
    scope_policy_id: 'sp',
    scope_policy_version: 1,
    resolved_tools: '["tool"]',
    resolved_scope_constraints: '{}',
    access_snapshot_hash: 'A'.repeat(43),
  });
}

function tokenFamily(db: SQLiteDatabase, id: string, tenant: string, grant: string, user: string) {
  put(db, 'admin_agent_token_families', {
    family_id: id,
    family_jti: `${id}-jti`,
    tenant_id: tenant,
    grant_id: grant,
    grant_generation: 1,
    admin_user_id: user,
    client_id: 'client',
    consent_version: 1,
    finalization_nonce: 'nonce',
    expires_at: NOW + HOUR,
    created_at: NOW,
    updated_at: NOW,
  });
}

function invitation(
  db: SQLiteDatabase,
  id: string,
  tenant: string,
  userId: string,
  status: 'pending' | 'accepted'
) {
  const email = `${userId}@example.test`;
  put(db, 'admin_invitations', {
    id,
    tenant_id: tenant,
    admin_user_id: userId,
    email,
    pending_email_key: status === 'pending' ? email : null,
    code_hash: `${id}-code`,
    status,
    admin_role_id: 'role_ar_tenant_admin',
    admin_role_name: 'ar_tenant_admin',
    scope_type: 'tenant',
    scope_id: tenant,
    expires_at: NOW + HOUR,
    last_sent_at: NOW,
    created_by: 'creator',
    created_at: NOW,
    updated_at: NOW,
  });
}

/** One tenant's worth of administrators and everything that hangs off them. */
function seedTenant(db: SQLiteDatabase, t: string) {
  const roleId = `${t}-custom-role`;
  put(db, 'admin_roles', {
    id: roleId,
    tenant_id: t,
    name: 'custom',
    permissions_json: '[]',
    role_type: 'custom',
    is_system: 0,
    created_at: NOW,
    updated_at: NOW,
  });
  for (const user of ['one', 'two', 'invited']) admin(db, t, `${t}-${user}`);

  assignment(db, `${t}-direct`, t, `${t}-one`, 'role_ar_tenant_admin', 'tenant');
  assignment(db, `${t}-custom`, t, `${t}-two`, roleId, 'tenant');
  session(db, `${t}-session`, t, `${t}-one`);
  put(db, 'admin_passkeys', {
    id: `${t}-passkey`,
    admin_user_id: `${t}-one`,
    credential_id: `${t}-cred`,
    public_key: 'key',
    created_at: NOW,
  });
  put(db, 'admin_second_factors', {
    id: `${t}-factor`,
    admin_user_id: `${t}-one`,
    kind: 'keyring_holder_key',
    holder_jkt: `${t}-jkt`,
    created_at: NOW,
  });

  // A group, a member, and the role the group gives (the group-derived assignment).
  put(db, 'admin_groups', {
    id: `${t}-group`,
    tenant_id: t,
    group_key: 'ops',
    display_name: 'Ops',
    created_at: NOW,
    updated_at: NOW,
  });
  put(db, 'admin_group_members', {
    id: `${t}-member`,
    tenant_id: t,
    admin_group_id: `${t}-group`,
    admin_user_id: `${t}-two`,
    created_at: NOW,
  });
  put(db, 'admin_group_role_grants', {
    id: `${t}-grant`,
    tenant_id: t,
    admin_group_id: `${t}-group`,
    admin_role_id: 'role_ar_viewer',
    scope_type: 'tenant',
    scope_id: t,
    created_at: NOW,
    updated_at: NOW,
  });

  invitation(db, `${t}-inv-pending`, t, `${t}-invited`, 'pending');
  invitation(db, `${t}-inv-accepted`, t, `${t}-one`, 'accepted');
  put(db, 'admin_invitation_groups', {
    id: `${t}-inv-group`,
    tenant_id: t,
    invitation_id: `${t}-inv-pending`,
    admin_group_id: `${t}-group`,
    group_display_name: 'Ops',
    group_revision: 1,
    created_at: NOW,
  });
  put(db, 'admin_invitation_enrollments', {
    token_hash: `${t}-enroll`,
    invitation_id: `${t}-inv-pending`,
    phase: 'redeemed',
    state_json: '{}',
    expires_at: NOW + HOUR,
    created_at: NOW,
    updated_at: NOW,
  });

  // Rows that foreign keys without cascade tie to the administrator.
  agentGrant(db, `${t}-agent-grant`, t, `${t}-one`);
  tokenFamily(db, `${t}-family`, t, `${t}-agent-grant`, `${t}-one`);
  put(db, 'admin_agent_login_handoffs', {
    id: `${t}-handoff`,
    target_tenant_id: t,
    target_origin: 'https://example.test',
    authorization_path: '/oauth/admin-agent/authorize',
    browser_binding_hash: 'hash',
    admin_user_id: `${t}-one`,
    last_transition_id: `${t}-transition`,
    created_at: NOW,
    expires_at: NOW + HOUR,
  });
  put(db, 'admin_audit_log', {
    id: `${t}-audit`,
    tenant_id: t,
    action: 'admin.login',
    result: 'success',
    created_at: NOW,
  });
}

function setup() {
  const db = openDatabase();
  seedTenant(db, X);
  seedTenant(db, Y);
  // Platform administrators: homed in the default tenant, global role, a base session and one
  // derived into X.
  admin(db, 'default', 'platform');
  assignment(db, 'platform-global', 'default', 'platform', 'role_ar_super_admin', 'global');
  session(db, 'platform-base', 'default', 'platform');
  session(db, 'platform-derived-x', 'default', 'platform', { parent: 'platform-base', target: X });
  session(db, 'platform-derived-y', 'default', 'platform', { parent: 'platform-base', target: Y });
  admin(db, 'default', 'default-admin');
  assignment(
    db,
    'default-admin-tenant',
    'default',
    'default-admin',
    'role_ar_tenant_admin',
    'tenant'
  );
  return db;
}

function run(
  db: SQLiteDatabase,
  overrides: Partial<Parameters<typeof purgeTenantHomedAdmins>[0]> = {}
) {
  /** The per-administrator events; the tenant-level one is in `tenantAudits`. */
  const audits: TenantAdminPurgeAuditEntry[] = [];
  const tenantAudits: TenantAdminPurgeAuditEntry[] = [];
  const info = vi.fn();
  const options = {
    adapter: sqliteAdapter(db),
    tenantId: X,
    jobId: 'job-1',
    auditTenantId: 'operator',
    auditAt: NOW,
    now: NOW,
    writeAudit: async (entry: TenantAdminPurgeAuditEntry) => {
      (entry.adminUserId ? audits : tenantAudits).push(entry);
    },
    log: { info },
    ...overrides,
  };
  return { audits, tenantAudits, info, result: () => purgeTenantHomedAdmins(options) };
}

const adminIds = (db: SQLiteDatabase, tenant: string) =>
  (
    db.prepare('SELECT id FROM admin_users WHERE tenant_id = ? ORDER BY id').all(tenant) as Array<{
      id: string;
    }>
  ).map((row) => row.id);

describe('purging the administrators of a deleted tenant', () => {
  it('removes every row of the tenant and leaves every row of another tenant alone', async () => {
    const db = setup();
    const beforeY = snapshot(db, Y);
    const beforeDefault = snapshot(db, 'default');
    const derivedBefore = count(
      db,
      'SELECT COUNT(*) AS n FROM admin_sessions WHERE derived_target_tenant_id = ?',
      Y
    );
    expect(snapshot(db, X)).toEqual(beforeY);
    expect(beforeY.admin_agent_token_families).toBe(1);

    const { result, audits } = run(db);
    const outcome = await result();

    expect(outcome).toEqual({ removed: 3, kept: [] });
    const afterX = snapshot(db, X);
    // The tenant's audit history is not ours to delete (and has no foreign key to block anything).
    expect({ ...afterX, admin_audit_log: 0 }).toEqual(
      Object.fromEntries(Object.keys(COUNTS).map((table) => [table, 0]))
    );
    expect(afterX.admin_audit_log).toBe(1);
    expect(snapshot(db, Y)).toEqual(beforeY);
    // The default tenant is untouched but for the platform administrator's session derived into X.
    expect(snapshot(db, 'default')).toEqual({
      ...beforeDefault,
      admin_sessions: beforeDefault.admin_sessions - 1,
    });
    expect(
      count(db, 'SELECT COUNT(*) AS n FROM admin_sessions WHERE derived_target_tenant_id = ?', Y)
    ).toBe(derivedBefore);
    // Nothing outside the tenant's own rows: the system roles and the other tenants' roles stay.
    expect(count(db, "SELECT COUNT(*) AS n FROM admin_roles WHERE id = 'role_ar_viewer'")).toBe(1);
    expect(audits.map((audit) => audit.adminUserId).sort()).toEqual([
      `${X}-invited`,
      `${X}-one`,
      `${X}-two`,
    ]);
  });

  it("removes a platform administrator's session derived into the tenant and keeps the rest", async () => {
    const db = setup();

    await run(db).result();

    const ids = (
      db.prepare('SELECT id FROM admin_sessions ORDER BY id').all() as Array<{
        id: string;
      }>
    ).map((row) => row.id);
    expect(ids).toContain('platform-base');
    expect(ids).toContain('platform-derived-y');
    expect(ids).not.toContain('platform-derived-x');
    expect(adminIds(db, 'default')).toEqual(['default-admin', 'platform']);
    expect(
      count(db, "SELECT COUNT(*) AS n FROM admin_role_assignments WHERE tenant_id = 'default'")
    ).toBe(2);
  });

  it('removes a session that targets the tenant even without a parent, and keeps base sessions', async () => {
    const db = setup();
    put(db, 'admin_sessions', {
      id: 'orphan-derived-x',
      tenant_id: 'default',
      admin_user_id: 'platform',
      created_at: NOW,
      expires_at: NOW + HOUR,
      parent_session_id: null,
      derived_target_tenant_id: X,
    });

    await run(db).result();

    const ids = (
      db.prepare('SELECT id FROM admin_sessions ORDER BY id').all() as Array<{ id: string }>
    ).map((row) => row.id);
    expect(ids).not.toContain('orphan-derived-x');
    // Base sessions (no derived target) of the platform and of another tenant's administrators stay.
    expect(ids).toContain('platform-base');
    expect(
      count(
        db,
        'SELECT COUNT(*) AS n FROM admin_sessions WHERE tenant_id = ? AND derived_target_tenant_id IS NULL',
        Y
      )
    ).toBeGreaterThan(0);
  });

  it('keeps an administrator with a current global assignment, with every row and the assignment', async () => {
    const db = setup();
    admin(db, X, `${X}-global`);
    // The global assignment carries the home tenant and uses one of the tenant's custom roles.
    assignment(
      db,
      `${X}-global-assignment`,
      X,
      `${X}-global`,
      `${X}-custom-role`,
      'global',
      NOW + HOUR
    );
    session(db, `${X}-global-session`, X, `${X}-global`);
    put(db, 'admin_passkeys', {
      id: `${X}-global-passkey`,
      admin_user_id: `${X}-global`,
      credential_id: `${X}-global-cred`,
      public_key: 'key',
      created_at: NOW,
    });

    const { result, audits, info } = run(db);
    const outcome = await result();

    expect(outcome.removed).toBe(3);
    expect(outcome.kept).toEqual([
      { adminUserId: `${X}-global`, reason: 'current_global_assignment' },
    ]);
    expect(adminIds(db, X)).toEqual([`${X}-global`]);
    expect(
      count(
        db,
        'SELECT COUNT(*) AS n FROM admin_role_assignments WHERE id = ?',
        `${X}-global-assignment`
      )
    ).toBe(1);
    expect(
      count(db, 'SELECT COUNT(*) AS n FROM admin_sessions WHERE id = ?', `${X}-global-session`)
    ).toBe(1);
    expect(
      count(db, 'SELECT COUNT(*) AS n FROM admin_passkeys WHERE id = ?', `${X}-global-passkey`)
    ).toBe(1);
    // The custom role the kept administrator's global assignment uses is not deleted under them.
    expect(
      count(db, 'SELECT COUNT(*) AS n FROM admin_roles WHERE id = ?', `${X}-custom-role`)
    ).toBe(1);
    // The tenant-scoped assignments of the tenant are gone, the global one is not.
    expect(
      count(db, 'SELECT COUNT(*) AS n FROM admin_role_assignments WHERE tenant_id = ?', X)
    ).toBe(1);
    expect(audits.map((audit) => audit.adminUserId)).not.toContain(`${X}-global`);
    expect(count(db, 'SELECT is_active AS n FROM admin_users WHERE id = ?', `${X}-global`)).toBe(1);
    expect(info).toHaveBeenCalledWith(
      'Tenant admin accounts purged with the tenant',
      expect.objectContaining({
        kept_count: 1,
        kept_admins: [{ id: `${X}-global`, reason: 'current_global_assignment' }],
      })
    );
  });

  it('removes an administrator whose global assignment has expired', async () => {
    const db = setup();
    admin(db, X, `${X}-expired`);
    assignment(
      db,
      `${X}-expired-assignment`,
      X,
      `${X}-expired`,
      'role_ar_viewer',
      'global',
      NOW - 1
    );

    const outcome = await run(db).result();

    expect(outcome).toEqual({ removed: 4, kept: [] });
    expect(adminIds(db, X)).toEqual([]);
    expect(
      count(
        db,
        'SELECT COUNT(*) AS n FROM admin_role_assignments WHERE id = ?',
        `${X}-expired-assignment`
      )
    ).toBe(0);
  });

  it('removes an administrator with an agent token family and a login handoff without a foreign key error', async () => {
    const db = setup();
    // A second grant and family only the token-family foreign key (admin_user_id) ties to the admin.
    agentGrant(db, `${X}-other-grant`, X, `${X}-two`);
    tokenFamily(db, `${X}-other-family`, X, `${X}-other-grant`, `${X}-one`);

    await run(db).result();

    expect(
      count(db, 'SELECT COUNT(*) AS n FROM admin_agent_token_families WHERE tenant_id = ?', X)
    ).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM admin_agent_grants WHERE tenant_id = ?', X)).toBe(
      0
    );
    expect(
      count(
        db,
        'SELECT COUNT(*) AS n FROM admin_agent_login_handoffs WHERE admin_user_id LIKE ?',
        `${X}%`
      )
    ).toBe(0);
    expect(
      count(db, 'SELECT COUNT(*) AS n FROM admin_agent_token_families WHERE tenant_id = ?', Y)
    ).toBe(1);
  });

  it('deactivates and strips an administrator it cannot delete, and leaves other tenants alone', async () => {
    const db = setup();
    // An admin another tenant's agent grant points to, with a setup token and a recovery.
    agentGrant(db, `${Y}-grant-by-x`, Y, `${X}-one`);
    put(db, 'admin_setup_tokens', {
      id: 'setup-one',
      tenant_id: X,
      admin_user_id: `${X}-one`,
      expires_at: NOW + HOUR,
      created_at: NOW,
    });
    put(db, 'admin_second_factor_recoveries', {
      id: 'recovery-one',
      admin_user_id: `${X}-one`,
      tenant_id: X,
      status: 'pending',
      kind: 'keyring_holder_key',
      holder_jkt: 'recovery-jkt',
      admin_credential_id: 'cred',
      requested_session_id: 'session',
      requested_at: NOW,
      not_before: NOW,
      expires_at: NOW + HOUR,
    });
    const beforeY = snapshot(db, Y);

    const { result, audits } = run(db);
    const outcome = await result();

    expect(outcome.kept).toEqual([
      { adminUserId: `${X}-one`, reason: 'agent_reference_outside_tenant', deactivated: true },
    ]);
    expect(adminIds(db, X)).toEqual([`${X}-one`]);
    const row = db
      .prepare('SELECT is_active, updated_at FROM admin_users WHERE id = ?')
      .get(`${X}-one`) as { is_active: number; updated_at: number };
    expect(row.is_active).toBe(0);
    for (const table of [
      'admin_sessions',
      'admin_passkeys',
      'admin_second_factors',
      'admin_setup_tokens',
      'admin_second_factor_recoveries',
    ]) {
      expect(
        count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE admin_user_id = ?`, `${X}-one`)
      ).toBe(0);
    }
    expect(audits.map((audit) => [audit.action, audit.adminUserId, audit.id]).sort()).toEqual([
      ['admin_user.deactivate_with_tenant', `${X}-one`, `tenant-admin-deactivate:job-1:${X}-one`],
      ['admin_user.purge_with_tenant', `${X}-invited`, `tenant-admin-purge:job-1:${X}-invited`],
      ['admin_user.purge_with_tenant', `${X}-two`, `tenant-admin-purge:job-1:${X}-two`],
    ]);
    // The other tenant keeps everything, including the grant that made the admin undeletable.
    expect(snapshot(db, Y)).toEqual(beforeY);

    // A second run neither errors nor writes another deactivation audit.
    const second = run(db);
    const again = await second.result();
    expect(again.kept).toEqual(outcome.kept);
    expect(second.audits).toHaveLength(0);
  });

  it('deactivates an administrator a backup restore mapping names, which cannot be deleted', async () => {
    const db = setup();
    // Restore mapping rows are immutable history; a bare row stands in for one (the FK check is
    // switched off only to insert it without the operation and head rows).
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('DROP TRIGGER tenant_backup_admin_mapping_insert_authorized');
    db.exec('DROP TRIGGER tenant_backup_admin_mapping_insert_revision');
    db.exec(
      `INSERT INTO tenant_backup_admin_mappings (operation_id, tenant_id, source_admin_id, target_admin_id, updated_by, updated_at)
       VALUES ('op', '${X}', 'source', '${X}-two', 'u', 1)`
    );
    db.exec('PRAGMA foreign_keys = ON');

    const outcome = await run(db).result();

    expect(outcome.kept).toEqual([
      { adminUserId: `${X}-two`, reason: 'backup_admin_mapping', deactivated: true },
    ]);
    expect(adminIds(db, X)).toEqual([`${X}-two`]);
    expect(count(db, 'SELECT is_active AS n FROM admin_users WHERE id = ?', `${X}-two`)).toBe(0);
    expect(
      count(db, 'SELECT COUNT(*) AS n FROM admin_sessions WHERE admin_user_id = ?', `${X}-two`)
    ).toBe(0);
  });

  it('is idempotent: a second run changes nothing and writes no further audit', async () => {
    const db = setup();
    admin(db, X, `${X}-global`);
    assignment(db, `${X}-global-assignment`, X, `${X}-global`, 'role_ar_viewer', 'global');
    const first = run(db);
    await first.result();
    const afterFirst = { x: snapshot(db, X), y: snapshot(db, Y), ids: adminIds(db, X) };

    const second = run(db);
    const outcome = await second.result();

    expect(outcome.removed).toBe(0);
    expect(outcome.kept).toHaveLength(1);
    expect({ x: snapshot(db, X), y: snapshot(db, Y), ids: adminIds(db, X) }).toEqual(afterFirst);
    expect(first.audits).toHaveLength(3);
    expect(second.audits).toHaveLength(0);
  });

  it('writes one audit entry per removed administrator, with stable ids, the job and the e-mail', async () => {
    const db = setup();

    const { result, audits } = run(db);
    await result();

    expect(audits).toHaveLength(3);
    expect(audits[0]).toEqual({
      action: 'admin_user.purge_with_tenant',
      auditAt: NOW,
      id: `tenant-admin-purge:job-1:${X}-invited`,
      tenantId: 'operator',
      purgedTenantId: X,
      jobId: 'job-1',
      adminUserId: `${X}-invited`,
      email: `${X}-invited@example.test`,
    });
  });

  it('removes nothing, tenant-level rows included, when the audit cannot be written', async () => {
    const db = setup();
    const before = snapshot(db, X);
    const derivedBefore = count(
      db,
      'SELECT COUNT(*) AS n FROM admin_sessions WHERE derived_target_tenant_id = ?',
      X
    );
    expect(derivedBefore).toBe(1);
    expect(before.admin_invitations).toBeGreaterThan(0);
    expect(before.admin_invitation_enrollments).toBeGreaterThan(0);
    expect(before.admin_agent_login_handoffs).toBeGreaterThan(0);

    const { result } = run(db, {
      writeAudit: async () => {
        throw new Error('log store down');
      },
    });

    await expect(result()).rejects.toThrow('tenant_deletion_admin_purge_audit_failed');
    expect(snapshot(db, X)).toEqual(before);
    expect(
      count(db, 'SELECT COUNT(*) AS n FROM admin_sessions WHERE derived_target_tenant_id = ?', X)
    ).toBe(derivedBefore);
    // The retry (the audit back) completes the purge.
    const retry = await run(db).result();
    expect(retry.removed).toBe(3);
    expect(adminIds(db, X)).toEqual([]);
  });

  it('writes one tenant-level audit record first, even when every administrator is kept', async () => {
    const db = setup();
    for (const id of ['one', 'two', 'invited']) {
      assignment(db, `${X}-g-${id}`, X, `${X}-${id}`, 'role_ar_viewer', 'global');
    }

    const { result, audits, tenantAudits } = run(db);
    const outcome = await result();

    expect(outcome.removed).toBe(0);
    expect(audits).toHaveLength(0);
    expect(tenantAudits).toEqual([
      {
        id: `tenant-admin-access-purge:job-1`,
        action: 'tenant.admin_access_purge',
        auditAt: NOW,
        tenantId: 'operator',
        purgedTenantId: X,
        jobId: 'job-1',
        adminUserId: null,
        email: null,
      },
    ]);
    expect(count(db, COUNTS.admin_invitations, X)).toBe(0);
  });

  it('keeps every custom role of the tenant while one is still held, with the roles it inherits', async () => {
    const db = setup();
    // R (held by a kept administrator's global assignment) inherits from P, which nobody holds.
    const parent = `${X}-parent-role`;
    put(db, 'admin_roles', {
      id: parent,
      tenant_id: X,
      name: 'parent',
      permissions_json: '[]',
      role_type: 'custom',
      is_system: 0,
      created_at: NOW,
      updated_at: NOW,
    });
    db.prepare('UPDATE admin_roles SET inherits_from = ? WHERE id = ?').run(
      parent,
      `${X}-custom-role`
    );
    admin(db, X, `${X}-global`);
    assignment(db, `${X}-global-assignment`, X, `${X}-global`, `${X}-custom-role`, 'global');

    await run(db).result();

    const roles = (
      db.prepare('SELECT id FROM admin_roles WHERE tenant_id = ? ORDER BY id').all(X) as Array<{
        id: string;
      }>
    ).map((row) => row.id);
    expect(roles).toEqual([`${X}-custom-role`, parent]);
  });

  it("keeps the roles another tenant's role inherits from", async () => {
    const db = setup();
    db.prepare('UPDATE admin_roles SET inherits_from = ? WHERE id = ?').run(
      `${X}-custom-role`,
      `${Y}-custom-role`
    );

    await run(db).result();

    expect(count(db, 'SELECT COUNT(*) AS n FROM admin_roles WHERE tenant_id = ?', X)).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM admin_roles WHERE tenant_id = ?', Y)).toBe(1);
  });

  it('retries after a partial attempt against the real audit store without an event collision', async () => {
    const db = setup();
    const logging = await logProducerFixture('scheduled', {
      tenantId: 'operator',
      separateAdmin: true,
    });
    try {
      const write = createTenantAdminPurgeAuditWriter(
        logging.adminAdapter,
        logging.env as unknown as Env
      );
      let calls = 0;
      const auditAt = Date.now();
      const first = run(db, {
        auditAt,
        writeAudit: async (entry) => {
          calls += 1;
          // The tenant-level record and the first administrator are written, then the log
          // store fails once.
          if (calls === 3) throw new Error('transient');
          await write(entry);
        },
      });
      await expect(first.result()).rejects.toThrow('tenant_deletion_admin_purge_audit_failed');
      expect(adminIds(db, X)).toHaveLength(3);

      // The retry runs later: the events must still be identical.
      await new Promise((resolve) => setTimeout(resolve, 15));
      const second = run(db, { auditAt, writeAudit: write });
      await expect(second.result()).resolves.toMatchObject({ removed: 3 });
      expect(adminIds(db, X)).toEqual([]);

      const rows = await logging.rows('admin.admin_audit_log', 'operator');
      expect(rows.map((row) => String(row.action)).sort()).toEqual([
        'admin_user.purge_with_tenant',
        'admin_user.purge_with_tenant',
        'admin_user.purge_with_tenant',
        'tenant.admin_access_purge',
      ]);
    } finally {
      logging.close();
    }
  });

  it('handles more administrators than one batch holds', async () => {
    const db = setup();
    for (let index = 0; index < 60; index += 1) {
      admin(db, X, `${X}-bulk-${String(index).padStart(3, '0')}`);
    }
    const beforeY = snapshot(db, Y);

    const outcome = await run(db).result();

    expect(outcome.removed).toBe(63);
    expect(adminIds(db, X)).toEqual([]);
    expect(snapshot(db, Y)).toEqual(beforeY);
  });

  it('refuses the default tenant, the platform scope and an audit tenant equal to the target', async () => {
    const db = setup();
    const before = snapshot(db, 'default');

    await expect(run(db, { tenantId: 'default' }).result()).rejects.toThrow(
      'tenant_deletion_target_is_default'
    );
    await expect(run(db, { tenantId: 'platform' }).result()).rejects.toThrow(
      'tenant_deletion_target_is_default'
    );
    await expect(run(db, { auditTenantId: X }).result()).rejects.toThrow(
      'tenant_deletion_job_config_invalid'
    );
    await expect(run(db, { tenantId: "x' OR '1'='1" }).result()).rejects.toThrow(
      'tenant_deletion_job_config_invalid'
    );
    expect(snapshot(db, 'default')).toEqual(before);
    expect(adminIds(db, X)).toHaveLength(3);
  });
});
