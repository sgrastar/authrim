import { expect, it } from 'vitest';
import { openCoreStore } from './helpers/core-schema-sqlite';
import {
  createGroup,
  assignGroupRole,
  groupsCarryingRoles,
  type AdminAuthContext,
} from '@authrim/ar-lib-core';
import {
  adminAssignGroupRole,
  adminRemoveGroupRole,
  adminUpsertGroupMembership,
  adminReparentGroup,
  canManageGroupMembership,
} from '../group-role-management';
import { mayManageEndUserRole } from '../role-delegation';
import { IdentityMappingControlPlaneRepository } from '../identity-mapping-control-plane';

it('enforces the same grant ceiling on direct grants, group grants, membership and reparenting', async () => {
  const { db, adapter } = openCoreStore('test');
  try {
    const tenant = 'test';
    const admin = {
      maxGrantTier: 1,
      permissions: ['admin:roles:write'],
    } as AdminAuthContext;
    const role = { grant_tier: 2 };
    expect(mayManageEndUserRole(admin, role)).toBe(false);
    db.exec(
      "INSERT INTO roles (id,name,tenant_id,grant_tier,permissions_json,created_at) VALUES('role','R','test',2,'[]',1)"
    );
    const root = await createGroup(adapter, tenant, { groupKey: 'root', displayName: 'Root' });
    const child = await createGroup(adapter, tenant, {
      groupKey: 'child',
      displayName: 'Child',
      parentGroupId: root,
    });
    const other = await createGroup(adapter, tenant, { groupKey: 'other', displayName: 'Other' });
    const grant = { groupId: root, roleId: 'role' };
    await expect(adminAssignGroupRole(adapter, tenant, admin, grant)).rejects.toThrow(
      'role_delegation_denied'
    );
    await assignGroupRole(adapter, tenant, grant);
    await expect(adminRemoveGroupRole(adapter, tenant, admin, grant)).rejects.toThrow(
      'role_delegation_denied'
    );
    const stores = { metadata: adapter, account: adapter };
    await expect(
      adminUpsertGroupMembership(admin, stores, tenant, 'subject', {
        groupId: child,
        source: 'manual',
      })
    ).rejects.toThrow('role_delegation_denied');
    await expect(adminReparentGroup(adapter, tenant, admin, other, child)).rejects.toThrow(
      'role_delegation_denied'
    );
    await expect(adminReparentGroup(adapter, tenant, admin, child, null)).rejects.toThrow(
      'role_delegation_denied'
    );
    // A group that carries roles needs the role-grant permission, not only the grant ceiling.
    await expect(
      adminUpsertGroupMembership(
        { ...admin, maxGrantTier: 2, permissions: ['admin:settings:write'] },
        stores,
        tenant,
        'subject',
        { groupId: child, source: 'manual' }
      )
    ).rejects.toThrow('role_delegation_denied');
    expect(db.prepare('SELECT count(*) n FROM group_memberships').get()).toEqual({ n: 0 });
    await adminUpsertGroupMembership({ ...admin, maxGrantTier: 2 }, stores, tenant, 'subject', {
      groupId: child,
      source: 'manual',
    });
    expect(db.prepare('SELECT count(*) n FROM group_memberships').get()).toEqual({ n: 1 });
  } finally {
    db.close();
  }
});

it('reads delegation through the transaction that writes the group', async () => {
  const { db, adapter } = openCoreStore('test');
  try {
    // The PostgreSQL adapter leases its connection to the callback until it returns.
    const core = {
      ...adapter,
      query: async () => {
        throw new Error('outer connection is leased');
      },
    };
    const repo = new IdentityMappingControlPlaneRepository(adapter, Date.now, core);
    const parent = await repo.createGroup('test', { groupKey: 'p', displayName: 'Parent' });
    // A membership is written on the subject's account database, apart from any transaction of
    // the metadata database (identity-mapping-group-membership-shards.test.ts).
    await expect(
      repo.createGroup('test', {
        groupKey: 'c',
        displayName: 'Child',
        parentGroupId: parent.id,
      })
    ).resolves.toMatchObject({ groupKey: 'c' });
  } finally {
    db.close();
  }
});

it('files a SCIM membership written without a reference under the shared SCIM domain', async () => {
  const { db, adapter } = openCoreStore('test');
  try {
    const repo = new IdentityMappingControlPlaneRepository(
      adapter,
      Date.now,
      adapter,
      undefined,
      undefined,
      undefined,
      null,
      async (_tenantId, id) =>
        id.subjectId
          ? { subjectId: id.subjectId, accountId: `account:${id.subjectId}`, account: adapter }
          : null
    );
    const group = await repo.createGroup('test', { groupKey: 'g', displayName: 'G' });
    await repo.createGroupMembership('test', {
      groupId: group.id,
      subjectId: 'user',
      assignmentSource: 'scim',
    });
    await repo.createGroupMembership('test', {
      groupId: group.id,
      subjectId: 'user',
      assignmentSource: 'manual',
    });
    expect(
      db
        .prepare(
          'SELECT assignment_source, source_ref FROM group_memberships ORDER BY assignment_source'
        )
        .all()
    ).toEqual([
      { assignment_source: 'manual', source_ref: '' },
      { assignment_source: 'scim', source_ref: 'scim' },
    ]);
  } finally {
    db.close();
  }
});

it('treats a resource permission granted to a group or its ancestor as authorization the group carries', async () => {
  const { db, adapter } = openCoreStore('test');
  try {
    const tenant = 'test';
    const root = await createGroup(adapter, tenant, { groupKey: 'root', displayName: 'Root' });
    const child = await createGroup(adapter, tenant, {
      groupKey: 'child',
      displayName: 'Child',
      parentGroupId: root,
    });
    const settingsOnly = {
      maxGrantTier: 3,
      permissions: ['admin:settings:write'],
    } as AdminAuthContext;
    const roleWriter = { maxGrantTier: 1, permissions: ['admin:roles:write'] } as AdminAuthContext;
    expect(await canManageGroupMembership(adapter, tenant, settingsOnly, child)).toBe(true);
    expect([...(await groupsCarryingRoles(adapter, tenant, [child]))]).toEqual([]);
    const grant = (id: string, active: number, expiresAt: number | null) =>
      db
        .prepare(
          `INSERT INTO resource_permissions (id, tenant_id, subject_type, subject_id, resource_type,
             resource_id, actions_json, expires_at, is_active, created_at, updated_at)
           VALUES (?, 'test', 'group', ?, 'documents', ?, '["read"]', ?, ?, 0, 0)`
        )
        .run(id, root, id, expiresAt, active);
    // Inactive or expired grants carry nothing.
    grant('rp-off', 0, null);
    grant('rp-old', 1, Math.floor(Date.now() / 1000) - 60);
    expect(await canManageGroupMembership(adapter, tenant, settingsOnly, child)).toBe(true);
    expect([...(await groupsCarryingRoles(adapter, tenant, [child]))]).toEqual([]);
    grant('rp-on', 1, null);
    // Granted to the parent: membership of the child grants it, so it needs the role-write
    // permission (the resource permissions API's); no role is involved, so no grant ceiling.
    expect(await canManageGroupMembership(adapter, tenant, settingsOnly, child)).toBe(false);
    expect(await canManageGroupMembership(adapter, tenant, roleWriter, child)).toBe(true);
    expect([...(await groupsCarryingRoles(adapter, tenant, [child, root]))].sort()).toEqual(
      [child, root].sort()
    );
  } finally {
    db.close();
  }
});
