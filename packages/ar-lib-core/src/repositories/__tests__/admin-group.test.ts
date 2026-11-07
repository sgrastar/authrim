import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { readMigrationSource } from '../../../../../test/helpers/migration-source.mjs';
import type { DatabaseAdapter } from '../../db/adapter';
import { renderPortableMigrationSql } from '../../migrations/sql-portability';
import {
  AdminGroupRepository,
  adminInvitationGroupJoin,
  adminInvitationGroupJoinCheck,
} from '../admin/admin-group';
import { sqliteAdapter } from './sqlite-core-schema';

const ADMIN_MIGRATIONS = new URL('../../../../../migrations/admin/d1/', import.meta.url);
const TENANT = 'tenant-a';

function adminSchema(): { db: DatabaseSync; adapter: DatabaseAdapter } {
  const fixture = sqliteAdapter('admin');
  fixture.db.exec(
    renderPortableMigrationSql(
      readMigrationSource(ADMIN_MIGRATIONS, '012_admin_groups.sql'),
      'sqlite'
    )
  );
  return fixture;
}

function addAdmin(db: DatabaseSync, id: string, tenantId = TENANT): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO admin_users (id, tenant_id, email, is_active, status, created_at, updated_at)
     VALUES (?, ?, ?, 1, 'active', ?, ?)`
  ).run(id, tenantId, `${id}@example.test`, now, now);
}

function effective(db: DatabaseSync, adminUserId: string) {
  return db
    .prepare(
      `SELECT admin_role_id, source, admin_group_id, scope_type, scope_id, expires_at
         FROM admin_effective_role_assignments WHERE admin_user_id = ? ORDER BY admin_role_id`
    )
    .all(adminUserId);
}

describe('AdminGroupRepository in the real admin schema', () => {
  let db: DatabaseSync;
  let adapter: DatabaseAdapter;
  let groups: AdminGroupRepository;

  beforeEach(() => {
    ({ db, adapter } = adminSchema());
    groups = new AdminGroupRepository(adapter, TENANT);
    addAdmin(db, 'admin-1');
  });

  it('lists a group grant as an assignment of every member, for the tenant only', async () => {
    const group = await groups.create({ groupKey: 'help', displayName: 'Help', createdBy: null });
    expect(group).not.toBeNull();
    const granted = await groups.addGrant({
      groupId: group!.id,
      roleId: 'role_ar_support',
      expiresAt: null,
      assignedBy: null,
      expectedRevision: 1,
    });
    expect(granted.grant?.scope_id).toBe(TENANT);
    expect(
      await groups.addMember({
        groupId: group!.id,
        adminUserId: 'admin-1',
        addedBy: null,
        expectedRevision: 2,
      })
    ).toBe('added');

    expect(effective(db, 'admin-1')).toEqual([
      {
        admin_role_id: 'role_ar_support',
        source: 'group',
        admin_group_id: group!.id,
        scope_type: 'tenant',
        scope_id: TENANT,
        expires_at: null,
      },
    ]);
  });

  it('refuses a grant for another scope or another tenant in the schema itself', async () => {
    const group = await groups.create({ groupKey: 'help', displayName: 'Help', createdBy: null });
    const now = Date.now();
    const insert = (scopeType: string, scopeId: string) => () =>
      db
        .prepare(
          `INSERT INTO admin_group_role_grants
             (id, tenant_id, admin_group_id, admin_role_id, scope_type, scope_id, created_at, updated_at)
           VALUES (?, ?, ?, 'role_ar_support', ?, ?, ?, ?)`
        )
        .run(`g-${scopeType}-${scopeId}`, TENANT, group!.id, scopeType, scopeId, now, now);

    expect(insert('global', TENANT)).toThrow(/CHECK constraint/u);
    expect(insert('tenant', 'tenant-b')).toThrow(/CHECK constraint/u);
    // The platform role, however the row arrives (a restore, not only the API)
    expect(() =>
      db
        .prepare(
          `INSERT INTO admin_group_role_grants
             (id, tenant_id, admin_group_id, admin_role_id, scope_type, scope_id, created_at, updated_at)
           VALUES ('g-super', ?, ?, 'role_ar_super_admin', 'tenant', ?, ?, ?)`
        )
        .run(TENANT, group!.id, TENANT, now, now)
    ).toThrow(/CHECK constraint/u);
  });

  it('raises the revision with each grant and holds additions to the version they checked', async () => {
    const group = await groups.create({ groupKey: 'help', displayName: 'Help', createdBy: null });
    const first = await groups.addGrant({
      groupId: group!.id,
      roleId: 'role_ar_support',
      expiresAt: null,
      assignedBy: null,
      expectedRevision: 1,
    });
    expect(first.grant).not.toBeNull();
    expect((await groups.grantSnapshot(group!.id))?.revision).toBe(2);

    // Judged against revision 1: the support grant came in since.
    expect(
      await groups.addMember({
        groupId: group!.id,
        adminUserId: 'admin-1',
        addedBy: null,
        expectedRevision: 1,
      })
    ).toBe('changed');
    expect(
      await groups.addGrant({
        groupId: group!.id,
        roleId: 'role_ar_viewer',
        expiresAt: null,
        assignedBy: null,
        expectedRevision: 1,
      })
    ).toEqual({ grant: null, reason: 'changed' });
    // A refused grant leaves the revision where it was.
    expect((await groups.grantSnapshot(group!.id))?.revision).toBe(2);
    expect(effective(db, 'admin-1')).toEqual([]);
  });

  it('joins an invitation to the groups whose grants are still the ones it was judged against', async () => {
    const same = await groups.create({ groupKey: 'same', displayName: 'Same', createdBy: null });
    const changed = await groups.create({
      groupKey: 'changed',
      displayName: 'Changed',
      createdBy: null,
    });
    const now = Date.now();
    db.prepare(
      `INSERT INTO admin_invitations (
         id, tenant_id, admin_user_id, email, code_hash, status, admin_role_id, admin_role_name,
         scope_type, scope_id, expires_at, last_sent_at, created_by, created_at, updated_at,
         pending_email_key
       ) VALUES ('inv-1', ?, 'admin-1', 'admin-1@example.test', 'hash', 'pending',
         'role_ar_viewer', 'ar_viewer', 'tenant', ?, ?, ?, 'inviter', ?, ?, 'admin-1@example.test')`
    ).run(TENANT, TENANT, now + 60_000, now, now, now);
    for (const group of [same!, changed!]) {
      db.prepare(
        `INSERT INTO admin_invitation_groups
           (id, tenant_id, invitation_id, admin_group_id, group_display_name, group_revision,
            created_at)
         VALUES (?, ?, 'inv-1', ?, ?, 1, ?)`
      ).run(`ig-${group.id}`, TENANT, group.id, group.display_name, now);
    }
    await groups.addGrant({
      groupId: changed!.id,
      roleId: 'role_ar_support',
      expiresAt: null,
      assignedBy: null,
      expectedRevision: 1,
    });

    // Read as joinable, then changed before the write: the check fails the batch.
    const check = adminInvitationGroupJoinCheck('inv-1', [same!.id, changed!.id])!;
    const join = adminInvitationGroupJoin('inv-1', now);
    await expect(adapter.batch([check, join])).rejects.toThrow(/NOT NULL constraint/u);
    expect(await groups.groupsOfUser('admin-1')).toEqual([]);
    expect(adminInvitationGroupJoinCheck('inv-1', [])).toBeNull();

    const passing = adminInvitationGroupJoinCheck('inv-1', [same!.id])!;
    await adapter.batch([passing, join]);

    expect(await groups.groupsOfUser('admin-1')).toEqual([
      { id: same!.id, group_key: 'same', display_name: 'Same' },
    ]);
  });

  it('leaves the revision alone when a grant change is refused, and raises it when one goes in', async () => {
    const group = await groups.create({ groupKey: 'help', displayName: 'Help', createdBy: null });
    const added = await groups.addGrant({
      groupId: group!.id,
      roleId: 'role_ar_support',
      expiresAt: null,
      assignedBy: null,
      expectedRevision: 1,
    });
    const grantId = added.grant!.id;
    const refused = { sql: '0 = 1', params: [] };

    expect(
      await groups.updateGrantExpiry(group!.id, grantId, Date.now() + 60_000, null, refused)
    ).toBe(false);
    expect(await groups.updateGrantExpiry(group!.id, grantId, Date.now() + 60_000, 123)).toBe(
      false
    );
    expect(await groups.removeGrant(group!.id, grantId, refused)).toBe(false);
    expect((await groups.grantSnapshot(group!.id))?.revision).toBe(2);

    expect(await groups.updateGrantExpiry(group!.id, grantId, Date.now() + 60_000, null)).toBe(
      true
    );
    expect((await groups.grantSnapshot(group!.id))?.revision).toBe(3);
    expect(await groups.removeGrant(group!.id, grantId)).toBe(true);
    expect((await groups.grantSnapshot(group!.id))?.revision).toBe(4);
    // Removed already (a concurrent request did it): nothing changes now, nor the revision.
    expect(await groups.removeGrant(group!.id, grantId)).toBe(false);
    expect((await groups.grantSnapshot(group!.id))?.revision).toBe(4);
  });

  it('takes the members and grants away with the group', async () => {
    const group = await groups.create({ groupKey: 'help', displayName: 'Help', createdBy: null });
    await groups.addGrant({
      groupId: group!.id,
      roleId: 'role_ar_support',
      expiresAt: null,
      assignedBy: null,
      expectedRevision: 1,
    });
    await groups.addMember({
      groupId: group!.id,
      adminUserId: 'admin-1',
      addedBy: null,
      expectedRevision: 2,
    });

    expect(await groups.delete(group!.id, 1)).toBe(false);
    expect(await groups.delete(group!.id, 2)).toBe(true);
    expect(effective(db, 'admin-1')).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM admin_group_role_grants').get()).toEqual({ n: 0 });
  });

  it("keeps an invitation's group row, with its name, when the group is deleted", async () => {
    const group = await groups.create({ groupKey: 'gone', displayName: 'Gone', createdBy: null });
    const now = Date.now();
    db.prepare(
      `INSERT INTO admin_invitations (
         id, tenant_id, admin_user_id, email, code_hash, status, admin_role_id, admin_role_name,
         scope_type, scope_id, expires_at, last_sent_at, created_by, created_at, updated_at,
         pending_email_key
       ) VALUES ('inv-2', ?, 'admin-1', 'admin-1@example.test', 'hash', 'pending',
         'role_ar_viewer', 'ar_viewer', 'tenant', ?, ?, ?, 'inviter', ?, ?, 'admin-1@example.test')`
    ).run(TENANT, TENANT, now + 60_000, now, now, now);
    db.prepare(
      `INSERT INTO admin_invitation_groups
         (id, tenant_id, invitation_id, admin_group_id, group_display_name, group_revision,
          created_at)
       VALUES ('ig-gone', ?, 'inv-2', ?, 'Gone', 1, ?)`
    ).run(TENANT, group!.id, now);

    expect(await groups.delete(group!.id, 1)).toBe(true);
    const join = adminInvitationGroupJoin('inv-2', now);
    expect((await adapter.execute(join.sql, join.params)).rowsAffected).toBe(0);
    expect(
      db
        .prepare("SELECT group_display_name FROM admin_invitation_groups WHERE id = 'ig-gone'")
        .get()
    ).toEqual({ group_display_name: 'Gone' });
  });

  it('refuses a second group with the same key in the tenant', async () => {
    expect(
      await groups.create({ groupKey: 'help', displayName: 'Help', createdBy: null })
    ).not.toBeNull();
    expect(
      await groups.create({ groupKey: 'help', displayName: 'Again', createdBy: null })
    ).toBeNull();
  });
});
