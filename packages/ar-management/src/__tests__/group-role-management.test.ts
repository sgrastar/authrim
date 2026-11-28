import { expect, it } from 'vitest';
import { openCoreStore } from './helpers/core-schema-sqlite';
import {
  createGroup,
  assignGroupRole,
  groupsCarryingRoles,
  TENANT_POLICY_RULES_CACHE_TTL_MS,
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

it('treats a ReBAC group userset on a group or its ancestor as authorization the group carries', async () => {
  const { db, adapter } = openCoreStore('test');
  try {
    const tenant = 'test';
    const root = await createGroup(adapter, tenant, { groupKey: 'root', displayName: 'Root' });
    const child = await createGroup(adapter, tenant, {
      groupKey: 'child',
      displayName: 'Child',
      parentGroupId: root,
    });
    const other = await createGroup(adapter, tenant, { groupKey: 'other', displayName: 'Other' });
    const settingsOnly = {
      maxGrantTier: 3,
      permissions: ['admin:settings:write'],
    } as AdminAuthContext;
    const roleWriter = { maxGrantTier: 1, permissions: ['admin:roles:write'] } as AdminAuthContext;
    const stores = { metadata: adapter, account: adapter };
    const userset = (id: string, expiresAt: number | null) =>
      db
        .prepare(
          `INSERT INTO relationships (id, tenant_id, relationship_type, from_type, from_id,
             from_relation, to_type, to_id, permission_level, expires_at, is_bidirectional,
             created_at, updated_at)
           VALUES (?, 'test', 'viewer', 'group', ?, 'member', 'document', ?, 'full', ?, 0, 0, 0)`
        )
        .run(id, root, id, expiresAt);
    userset('expired', Math.floor(Date.now() / 1000) - 60);
    expect(await canManageGroupMembership(adapter, tenant, settingsOnly, child)).toBe(true);
    // A legacy group row (no `member`, from before migration 020) is inert: it carries nothing.
    db.prepare(
      `INSERT INTO relationships (id, tenant_id, relationship_type, from_type, from_id,
         from_relation, to_type, to_id, permission_level, expires_at, is_bidirectional,
         created_at, updated_at)
       VALUES ('legacy', 'test', 'viewer', 'group', ?, NULL, 'document', 'legacy', 'full', NULL,
         0, 0, 0)`
    ).run(root);
    expect(await canManageGroupMembership(adapter, tenant, settingsOnly, child)).toBe(true);
    expect([...(await groupsCarryingRoles(adapter, tenant, [child, root]))]).toEqual([]);
    userset('live', null);
    // Membership add on the userset-only group (or below it) needs the role-write permission.
    await expect(
      adminUpsertGroupMembership(settingsOnly, stores, tenant, 'subject', {
        groupId: child,
        source: 'manual',
      })
    ).rejects.toThrow('role_delegation_denied');
    await adminUpsertGroupMembership(roleWriter, stores, tenant, 'subject', {
      groupId: child,
      source: 'manual',
    });
    // So does moving a group under it, or moving it.
    await expect(adminReparentGroup(adapter, tenant, settingsOnly, other, root)).rejects.toThrow(
      'role_delegation_denied'
    );
    await expect(adminReparentGroup(adapter, tenant, settingsOnly, child, null)).rejects.toThrow(
      'role_delegation_denied'
    );
    await adminReparentGroup(adapter, tenant, roleWriter, other, root);
  } finally {
    db.close();
  }
});

it('treats a group named only by an enabled policy rule as carrying authorization', async () => {
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
    const stores = { metadata: adapter, account: adapter };
    expect(await canManageGroupMembership(adapter, tenant, settingsOnly, child)).toBe(true);
    // A deny on non-members: removing a member changes what the rule decides as much as adding.
    db.prepare(
      `INSERT INTO policy_rules (id, tenant_id, name, effect, conditions, enabled, created_at,
         updated_at) VALUES ('rule', 'test', 'Outsiders', 'deny', ?, 1, 0, 0)`
    ).run(JSON.stringify([{ type: 'not_in_any_group', params: { group_ids: [root] } }]));
    // Named on the parent: membership of the child counts as membership of the parent.
    expect(await canManageGroupMembership(adapter, tenant, settingsOnly, root)).toBe(false);
    expect(await canManageGroupMembership(adapter, tenant, settingsOnly, child)).toBe(false);
    await expect(
      adminUpsertGroupMembership(settingsOnly, stores, tenant, 'subject', {
        groupId: child,
        source: 'manual',
      })
    ).rejects.toThrow('role_delegation_denied');
    await expect(adminReparentGroup(adapter, tenant, settingsOnly, child, null)).rejects.toThrow(
      'role_delegation_denied'
    );
    // Editing the rule needs the role-write permission; so does changing whom it matches.
    expect(await canManageGroupMembership(adapter, tenant, roleWriter, child)).toBe(true);
    // Disabled just now: the policy service may still evaluate it from its rule cache.
    const nowSeconds = Math.floor(Date.now() / 1000);
    db.prepare("UPDATE policy_rules SET enabled = 0, updated_at = ? WHERE id = 'rule'").run(
      nowSeconds
    );
    expect(await canManageGroupMembership(adapter, tenant, settingsOnly, child)).toBe(false);
    // Disabled longer ago than that cache lives, it decides nothing.
    db.prepare("UPDATE policy_rules SET updated_at = ? WHERE id = 'rule'").run(
      nowSeconds - Math.ceil(TENANT_POLICY_RULES_CACHE_TTL_MS / 1000) - 1
    );
    expect(await canManageGroupMembership(adapter, tenant, settingsOnly, child)).toBe(true);
  } finally {
    db.close();
  }
});

it('treats every group as carrying authorization while an enabled rule uses same_group', async () => {
  const { db, adapter } = openCoreStore('test');
  try {
    const tenant = 'test';
    const group = await createGroup(adapter, tenant, { groupKey: 'any', displayName: 'Any' });
    const settingsOnly = {
      maxGrantTier: 3,
      permissions: ['admin:settings:write'],
    } as AdminAuthContext;
    expect(await canManageGroupMembership(adapter, tenant, settingsOnly, group)).toBe(true);
    // same_group compares with the resource's groups at run time: any group may decide it.
    db.prepare(
      `INSERT INTO policy_rules (id, tenant_id, name, effect, conditions, enabled, created_at,
         updated_at) VALUES ('rule', 'test', 'Same group', 'allow', ?, 1, 0, 0)`
    ).run(JSON.stringify([{ type: 'same_group', params: {} }]));
    expect(await canManageGroupMembership(adapter, tenant, settingsOnly, group)).toBe(false);
    expect([...(await groupsCarryingRoles(adapter, tenant, [group]))]).toEqual([group]);
  } finally {
    db.close();
  }
});

it('refuses granting a role a deny rule names to a service group or a group above one', async () => {
  const { db, adapter } = openCoreStore('test');
  try {
    const tenant = 'test';
    db.exec(
      "INSERT INTO roles (id,name,tenant_id,grant_tier,permissions_json,created_at) VALUES('blocked','Blocked','test',1,'[]',1)"
    );
    const parent = await createGroup(adapter, tenant, { groupKey: 'parent', displayName: 'P' });
    const service = await createGroup(adapter, tenant, {
      groupKey: 'svc',
      displayName: 'S',
      parentGroupId: parent,
    });
    const other = await createGroup(adapter, tenant, { groupKey: 'other', displayName: 'O' });
    // A catalog-owned service group (canonical.ts).
    db.prepare(
      `UPDATE "groups" SET kind = 'dynamic', group_key = 'dynamic:' || id WHERE id = ?`
    ).run(service);
    const admin = { maxGrantTier: 3, permissions: ['admin:roles:write'] } as AdminAuthContext;
    // A deny rule on the role, saved first.
    db.prepare(
      `INSERT INTO policy_rules (id, tenant_id, name, effect, conditions, enabled, created_at,
         updated_at) VALUES ('deny', 'test', 'Deny blocked', 'deny', ?, 1, 0, 0)`
    ).run(JSON.stringify([{ type: 'has_role', params: { role: 'Blocked' } }]));
    for (const groupId of [service, parent])
      await expect(
        adminAssignGroupRole(adapter, tenant, admin, { groupId, roleId: 'blocked' })
      ).rejects.toThrow('dynamic_group_negative_condition');
    // A group no service group decides: granted.
    await adminAssignGroupRole(adapter, tenant, admin, { groupId: other, roleId: 'blocked' });
    expect(db.prepare('SELECT group_id FROM group_role_assignments').all()).toEqual([
      { group_id: other },
    ]);
  } finally {
    db.close();
  }
});
