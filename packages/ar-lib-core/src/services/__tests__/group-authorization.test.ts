import { createUnifiedCheckService } from '../unified-check-service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KVNamespace } from '@cloudflare/workers-types';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import {
  getAccessTokenRBACClaims,
  getCompositeRBACCache,
  getIDTokenRBACClaims,
} from '../../utils/rbac-claims';
import { createGroup, updateGroup } from '../group-catalog';
import {
  replaceSourceMemberships,
  resolveSubjectGroups,
  revokeGroupMembership,
  revokeManualGroupMemberships,
  upsertGroupMembership,
  clearChangedServiceGroupsCache,
} from '../group-membership';
import { assignGroupRole, removeGroupRole } from '../group-role-assignments';
import {
  groupReferencedByPolicyRules,
  groupsCarryingRoles,
  policyConditionGroupIds,
  serviceGroupDecidedGroups,
} from '../dynamic-groups/role-guard';
import {
  resolveSubjectRoles,
  resolveSubjectRolesAndGroups,
  roleAssignmentHolds,
  resolveEffectiveRoleAssignments,
} from '../tenant-rbac';

const tenant = 'tenant-a';
const user = 'user-1';
const now = 1_800_000_000;

describe('end-user group authorization across two databases', () => {
  let meta: ReturnType<typeof sqliteAdapter>;
  let account: ReturnType<typeof sqliteAdapter>;
  const stores = () => ({ metadata: meta.adapter, account: account.adapter });
  const create = (key: string, parentGroupId?: string) =>
    createGroup(meta.adapter, tenant, { groupKey: key, displayName: key, parentGroupId });
  const join = (groupId: string, times = {}) =>
    upsertGroupMembership(stores(), tenant, user, { groupId, source: 'manual', ...times });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);
    meta = sqliteAdapter();
    account = sqliteAdapter();
    meta.db.exec(`INSERT INTO roles (id,tenant_id,name,permissions_json,created_at)
      VALUES ('reader','tenant-a','Reader','["reports:read"]',1),('writer','tenant-a','Writer','["reports:write"]',1)`);
  });
  afterEach(() => {
    meta.db.close();
    account.db.close();
    vi.useRealTimers();
  });

  it('stops the dynamic memberships a removed manual membership may have derived', async () => {
    const manualGroup = await create('manual');
    const derived = await create('derived');
    const other = await create('other');
    const dynamicRow = (id: string, groupId: string) =>
      account.db
        .prepare(
          `INSERT INTO group_memberships (id, tenant_id, group_id, subject_id, assignment_source,
             source_ref, stale_after, created_at, updated_at)
           VALUES (?, 'tenant-a', ?, 'user-1', 'dynamic', '0000000000000001:1', ?, 1, 1)`
        )
        .run(id, groupId, now + 3600);
    const staleAfter = () =>
      (
        account.db
          .prepare(
            "SELECT stale_after FROM group_memberships WHERE assignment_source = 'dynamic' ORDER BY id"
          )
          .all() as Array<{ stale_after: number }>
      ).map((row) => row.stale_after);
    const invalidations: string[] = [];
    const cache = {
      get: vi.fn(async () => null),
      put: vi.fn(async (key: string) => void invalidations.push(key)),
    } as unknown as KVNamespace;

    await join(manualGroup);
    dynamicRow('d-1', derived);
    // Through the groups API's path (one source reference).
    await revokeGroupMembership(
      stores(),
      tenant,
      user,
      { groupId: manualGroup, source: 'manual' },
      cache
    );
    expect(staleAfter()).toEqual([now]);
    expect(invalidations.length).toBeGreaterThan(0);
    const pending = account.db
      .prepare('SELECT invalidation_pending FROM dynamic_membership_publications')
      .get() as { invalidation_pending: number };
    expect(pending).toBeDefined();

    // Through the access reviews' path (every manual row of the group).
    await join(manualGroup);
    dynamicRow('d-2', other);
    await revokeManualGroupMemberships(stores(), tenant, user, manualGroup, cache);
    expect(staleAfter()).toEqual([now, now]);
    // Removing another source's row does not touch the dynamic rows.
    account.db.exec(
      "UPDATE group_memberships SET stale_after = NULL WHERE assignment_source = 'dynamic'"
    );
    await upsertGroupMembership(stores(), tenant, user, {
      groupId: manualGroup,
      source: 'rule',
      sourceRef: 'role_assignment_rule:r1',
    });
    await revokeGroupMembership(stores(), tenant, user, {
      groupId: manualGroup,
      source: 'rule',
      sourceRef: 'role_assignment_rule:r1',
    });
    expect(staleAfter()).toEqual([null, null]);
  });

  it('preserves both direct origins of a shared ancestor, scopes and expiration', async () => {
    const root = await create('root');
    const left = await create('left', root);
    const right = await create('right', root);
    await join(left);
    await join(right);
    account.db
      .exec(`INSERT INTO role_assignments(id,tenant_id,subject_id,role_id,created_at,updated_at)
      VALUES('direct','tenant-a','user-1','writer',1,1)`);
    await assignGroupRole(meta.adapter, tenant, {
      groupId: root,
      roleId: 'reader',
      scopeType: 'group',
      scopeTarget: 'group:reports',
    });
    await assignGroupRole(meta.adapter, tenant, {
      groupId: right,
      roleId: 'writer',
      expiresAt: now,
    });
    const rows = await resolveEffectiveRoleAssignments(stores(), tenant, user, now);
    expect(rows.map((row) => row.via)).toEqual(
      expect.arrayContaining([
        { kind: 'direct' },
        { kind: 'group', groupId: root, throughGroupId: left },
        { kind: 'group', groupId: root, throughGroupId: right },
      ])
    );
    expect(rows).toHaveLength(3);
    const options = { tenantId: tenant, claimsConfig: 'roles,scoped_roles,permissions' };
    const claims = await getAccessTokenRBACClaims(stores(), user, options);
    expect(claims.authrim_roles).toEqual(['Writer']);
    expect(claims.authrim_permissions).toEqual(['reports:write']);
    expect(claims.authrim_scoped_roles).toContainEqual({
      name: 'Reader',
      scope: 'group',
      scopeTarget: 'group:reports',
    });
    const check = createUnifiedCheckService({
      db: meta.adapter,
      subjectAccountDb: async () => account.adapter,
    });
    const request = {
      tenant_id: tenant,
      subject_id: user,
      permission: 'reports:read',
      resource_context: { group_id: 'reports' },
    };
    // A role held through a group is reported as such.
    expect(await check.check(request)).toMatchObject({
      allowed: true,
      resolved_via: ['group_role'],
    });
    expect(
      (await check.check({ ...request, resource_context: { group_id: 'other' } })).allowed
    ).toBe(false);
    const scoped = { scope: 'group', scopeTarget: 'group:reports' };
    expect(roleAssignmentHolds(scoped, { groupIds: new Set(['reports']) })).toBe(true);
    expect(roleAssignmentHolds(scoped, { groupIds: ['other'] })).toBe(false);
    // A row of a scope or target the readers do not know never holds.
    expect(roleAssignmentHolds({ scope: 'global', scopeTarget: 'x' }, {})).toBe(false);
    expect(roleAssignmentHolds({ scope: 'org', scopeTarget: 'org:reports' }, {})).toBe(false);
    expect(
      roleAssignmentHolds({ scope: 'group', scopeTarget: 'reports' }, { groupIds: ['reports'] })
    ).toBe(false);
    expect(
      roleAssignmentHolds(
        { scope: 'resource', scopeTarget: 'doc:1' },
        { resourceType: 'doc', resourceId: '1' }
      )
    ).toBe(false);
    expect(
      roleAssignmentHolds(
        { scope: 'resource', scopeTarget: 'resource:doc:1' },
        { resourceType: 'doc', resourceId: '1' }
      )
    ).toBe(true);
    await updateGroup(meta.adapter, tenant, root, { lifecycleState: 'suspended' });
    expect(await resolveSubjectRoles(stores(), tenant, user, now)).toHaveLength(1);
    expect((await check.check(request)).allowed).toBe(false);
    await removeGroupRole(meta.adapter, tenant, {
      groupId: root,
      roleId: 'reader',
      scopeType: 'group',
      scopeTarget: 'group:reports',
    });
    expect(meta.db.prepare('SELECT count(*) n FROM group_role_assignments').get()?.n).toBe(1);
  });

  it('puts only tenant-wide grants in the flat claims, and groups in authrim_groups', async () => {
    const root = await create('root');
    const child = await create('child', root);
    const other = await create('other');
    await join(child);
    await updateGroup(meta.adapter, tenant, other, { lifecycleState: 'suspended' });
    await join(other);
    account.db
      .exec(`INSERT INTO role_assignments(id,tenant_id,subject_id,role_id,scope_type,scope_target,created_at,updated_at)
      VALUES('wide','tenant-a','user-1','writer','global','',1,1),
            ('narrow','tenant-a','user-1','reader','resource','resource:doc:1',1,1)`);
    await assignGroupRole(meta.adapter, tenant, { groupId: root, roleId: 'reader' });
    await assignGroupRole(meta.adapter, tenant, {
      groupId: child,
      roleId: 'reader',
      scopeType: 'group',
      scopeTarget: 'group:reports',
    });
    meta.db.exec(
      `UPDATE roles SET permissions_json='["reports:read","reports:audit"]' WHERE id='reader'`
    );
    const config = 'roles,groups,permissions,scoped_roles';
    const options = { tenantId: tenant, claimsConfig: config };
    const expectedGroups = [
      { id: child, key: 'child', name: 'child', kind: 'static' },
      { id: root, key: 'root', name: 'root', kind: 'static' },
    ];
    for (const claims of [
      await getIDTokenRBACClaims(stores(), user, options),
      await getAccessTokenRBACClaims(stores(), user, options),
    ]) {
      // The tenant-wide group grant (Reader through root) and the global direct grant (Writer).
      expect(claims.authrim_roles).toEqual(['Reader', 'Writer']);
      expect(claims.authrim_permissions).toEqual([
        'reports:audit',
        'reports:read',
        'reports:write',
      ]);
      // The group-scoped and the resource-scoped grants stay in the scoped claim with a target.
      expect(claims.authrim_scoped_roles).toEqual(
        expect.arrayContaining([
          { name: 'Reader', scope: 'group', scopeTarget: 'group:reports' },
          { name: 'Reader', scope: 'resource', scopeTarget: 'resource:doc:1' },
        ])
      );
      // Direct memberships and ancestors, active only (the suspended group is out).
      expect(claims.authrim_groups).toEqual(expectedGroups);
    }
    // The access token default carries no group-scoped permission and the groups.
    const defaults = await getAccessTokenRBACClaims(stores(), user, { tenantId: tenant });
    expect(defaults.authrim_groups).toEqual(expectedGroups);
    expect(Object.keys(defaults).sort()).toEqual(['authrim_groups', 'authrim_roles']);
    const composite = await getCompositeRBACCache(stores(), user, { tenantId: tenant });
    expect(composite.groups).toEqual(expectedGroups);
    expect(composite.roles).toEqual(['Reader', 'Writer']);
  });

  it('keeps a role held only through a group scope or a resource out of the flat claims', async () => {
    const group = await create('team');
    await join(group);
    account.db
      .exec(`INSERT INTO role_assignments(id,tenant_id,subject_id,role_id,scope_type,scope_target,created_at,updated_at)
      VALUES('narrow','tenant-a','user-1','writer','resource','resource:doc:1',1,1)`);
    await assignGroupRole(meta.adapter, tenant, {
      groupId: group,
      roleId: 'reader',
      scopeType: 'resource',
      scopeTarget: 'resource:doc:2',
    });
    const claims = await getAccessTokenRBACClaims(stores(), user, {
      tenantId: tenant,
      claimsConfig: 'roles,scoped_roles,permissions',
    });
    expect(claims.authrim_roles).toBeUndefined();
    expect(claims.authrim_permissions).toBeUndefined();
    expect(claims.authrim_scoped_roles).toHaveLength(2);
  });

  it('replaces one source atomically and preserves overlapping ownership and other sources', async () => {
    const a = await create('a');
    const b = await create('b');
    const replace = (groups: string[]) =>
      replaceSourceMemberships(stores(), tenant, user, 'scim', 'connection', groups);
    await replace([a, b]);
    await join(a);
    const row = () =>
      account.db
        .prepare("SELECT id FROM group_memberships WHERE assignment_source='scim' AND group_id=?")
        .get(b);
    const original = row();
    await replace([b, b]);
    expect(row()).toEqual(original);
    await expect(replace(['missing'])).rejects.toThrow('group_not_found');
    expect((await resolveSubjectGroups(stores(), tenant, user, now)).directGroupIds).toEqual(
      new Set([a, b])
    );
    await revokeGroupMembership(stores(), tenant, user, { groupId: a, source: 'manual' });
    expect((await resolveSubjectGroups(stores(), tenant, user, now)).directGroupIds).toEqual(
      new Set([b])
    );
  });

  it('checks every time boundary and rejects missing and cyclic parents in the tenant', async () => {
    const root = await create('root');
    const leaf = await create('leaf', root);
    await join(leaf, { startsAt: now, expiresAt: now + 5, staleAfter: now + 2 });
    const effective = async (at: number) =>
      (await resolveSubjectGroups(stores(), tenant, user, at)).effectiveGroupIds;
    expect(await effective(now - 1)).toEqual(new Set());
    expect(await effective(now)).toEqual(new Set([leaf, root]));
    expect(await effective(now + 2)).toEqual(new Set());
    await join(leaf, { expiresAt: now });
    expect(await effective(now)).toEqual(new Set());
    await expect(
      updateGroup(meta.adapter, tenant, root, { parentGroupId: leaf })
    ).rejects.toThrow();
    await expect(
      updateGroup(meta.adapter, tenant, root, { parentGroupId: root })
    ).rejects.toThrow();
    await expect(
      createGroup(meta.adapter, 'other', {
        groupKey: 'foreign',
        displayName: 'X',
        parentGroupId: root,
      })
    ).rejects.toThrow();
    await join(leaf);
    meta.db.prepare('UPDATE "groups" SET parent_group_id=? WHERE id=?').run(leaf, root);
    expect(await effective(now)).toEqual(new Set([leaf, root]));
  });

  /** A plan of service groups (custom.team = value), as the store saves it. */
  const serviceGroup = (id: string, value: string, extra: Record<string, unknown> = {}) => ({
    id,
    tenantId: tenant,
    key: id,
    displayName: id,
    description: '',
    enabled: true,
    condition: { op: 'attribute', field: 'custom.team', compare: 'eq', value },
    ...extra,
  });
  const planJson = (groups: unknown[]) =>
    JSON.stringify({
      tenantId: tenant,
      groups,
      fields: { 'custom.team': { type: 'string' } },
      nodes: {},
      order: [],
      roots: {},
      attributes: {},
      dependents: {},
      dependencies: {},
    });
  /** Service groups `ids` as canonical groups (kind dynamic) and a catalog of them. */
  const dynamicGroups = async (ids: string[], revision: number) => {
    const created: Record<string, string> = {};
    for (const id of ids) {
      created[id] = await create(id);
      // A catalog-owned canonical group (canonical.ts): kind dynamic, key `dynamic:<id>`.
      meta.db
        .prepare(`UPDATE "groups" SET kind = 'dynamic', group_key = 'dynamic:' || id WHERE id = ?`)
        .run(created[id]);
    }
    const plan = planJson(ids.map((id) => serviceGroup(created[id], 'x')));
    meta.db
      .prepare(
        `INSERT INTO service_group_revisions (tenant_id, revision, plan_json, actor_id, created_at)
         VALUES ('tenant-a', ?, ?, 'actor', 1)`
      )
      .run(revision, plan);
    meta.db
      .prepare(
        `INSERT INTO service_group_catalog (tenant_id, revision, plan_json, updated_at, write_token)
         VALUES ('tenant-a', ?, ?, 1, '')`
      )
      .run(revision, plan);
    return created;
  };
  const dynamicRow = (subject: string, groupId: string, ref: string, staleAfter = now + 3600) =>
    account.db
      .prepare(
        `INSERT INTO group_memberships (id, tenant_id, group_id, subject_id, assignment_source,
           source_ref, stale_after, created_at, updated_at)
         VALUES (?, 'tenant-a', ?, ?, 'dynamic', ?, ?, 1, 1)`
      )
      .run(`d-${subject}-${groupId}`, groupId, subject, ref, staleAfter);
  const record = (subject: string, ref: string) =>
    account.db
      .prepare(
        `INSERT INTO dynamic_membership_publications (tenant_id, subject_id, generation,
           published_at, unknown_groups_json) VALUES ('tenant-a', ?, ?, 1, '[]')`
      )
      .run(subject, ref);
  const state = async (subject: string) => {
    const groups = await resolveSubjectGroups(stores(), tenant, subject, now);
    return {
      ids: [...groups.effectiveGroupIds].sort(),
      unknown: [...groups.unknownGroupIds].sort(),
    };
  };
  const saveCatalog = (revision: number, groups: unknown[]) =>
    meta.db
      .prepare(
        "UPDATE service_group_catalog SET revision = ?, plan_json = ? WHERE tenant_id = 'tenant-a'"
      )
      .run(revision, planJson(groups));

  it('leaves the service groups unknown for a subject never evaluated, other memberships known', async () => {
    clearChangedServiceGroupsCache();
    const manual = await create('manual');
    await join(manual);
    const { A, B } = await dynamicGroups(['A', 'B'], 3);
    // No publication on record (a new user): every enabled service group is unknown.
    await expect(state(user)).resolves.toEqual({ ids: [manual], unknown: [A, B].sort() });
    // A row of another generation than the record: the same.
    record(user, '0000000000000002:3');
    dynamicRow(user, A, '0000000000000001:3');
    await expect(state(user)).resolves.toEqual({ ids: [manual], unknown: [A, B].sort() });
    // Rows of the record: members of A, known not to be in B.
    account.db.exec("DELETE FROM group_memberships WHERE assignment_source = 'dynamic'");
    dynamicRow(user, A, '0000000000000002:3');
    await expect(state(user)).resolves.toEqual({ ids: [A, manual].sort(), unknown: [] });
    await expect(resolveSubjectRolesAndGroups(stores(), tenant, user, now)).resolves.toMatchObject({
      rolesComplete: true,
      unknownGroupIds: [],
    });
    // The current catalog cannot be read: the service groups are unknown, the manual one is not.
    const queryOne = meta.adapter.queryOne.bind(meta.adapter);
    vi.spyOn(meta.adapter, 'queryOne').mockImplementation((sql: string, params?: unknown[]) =>
      sql.includes('service_group_catalog')
        ? Promise.reject(new Error('metadata unavailable'))
        : queryOne(sql, params)
    );
    await expect(state(user)).resolves.toEqual({ ids: [manual], unknown: [A, B].sort() });
  });

  it('makes only the groups whose rule changed since the publication unknown', async () => {
    clearChangedServiceGroupsCache();
    const { A, B } = await dynamicGroups(['A', 'B'], 3);
    const other = 'user-2';
    const outsider = 'user-3';
    // user: rows in A and B; other: B only; outsider: a record and no row (in neither).
    for (const id of [A, B]) dynamicRow(user, id, '0000000000000001:3');
    dynamicRow(other, B, '0000000000000001:3');
    for (const subject of [user, other, outsider]) record(subject, '0000000000000001:3');

    // A rename only (revision 4): every membership kept.
    saveCatalog(4, [serviceGroup(A, 'x', { displayName: 'Renamed' }), serviceGroup(B, 'x')]);
    await expect(state(user)).resolves.toEqual({ ids: [A, B].sort(), unknown: [] });
    await expect(state(outsider)).resolves.toEqual({ ids: [], unknown: [] });

    // A's condition changed (revision 5), its rows expired at the save: A is unknown for everyone
    // (an older non-member may be one now), B stays known (B kept for the subject in both).
    saveCatalog(5, [serviceGroup(A, 'changed'), serviceGroup(B, 'x')]);
    account.db
      .prepare('UPDATE group_memberships SET stale_after = ? WHERE group_id = ?')
      .run(now, A);
    await expect(state(user)).resolves.toEqual({ ids: [B], unknown: [A] });
    await expect(state(other)).resolves.toEqual({ ids: [B], unknown: [A] });
    await expect(state(outsider)).resolves.toEqual({ ids: [], unknown: [A] });

    // A group added since (C) is unknown too; B removed is unknown.
    const C = await create('C');
    saveCatalog(6, [serviceGroup(A, 'x'), serviceGroup(C, 'x')]);
    await expect(state(other)).resolves.toEqual({ ids: [], unknown: [B, C].sort() });

    // The published revision's plan is not on record: every enabled service group is unknown.
    meta.db.exec('DELETE FROM service_group_revisions');
    clearChangedServiceGroupsCache();
    saveCatalog(7, [serviceGroup(A, 'x'), serviceGroup(B, 'x')]);
    await expect(state(other)).resolves.toEqual({ ids: [], unknown: [A, B].sort() });
  });

  it('treats groups the publication left undecided, and stale rows, as unknown', async () => {
    clearChangedServiceGroupsCache();
    const { A, B, C } = await dynamicGroups(['A', 'B', 'C'], 3);
    dynamicRow(user, B, '0000000000000001:3');
    dynamicRow(user, C, '0000000000000001:3', now - 1);
    // A evaluated as unknown (or left out for a self-writable field), recorded with the
    // publication; C's row went stale without a republication.
    account.db
      .prepare(
        `INSERT INTO dynamic_membership_publications (tenant_id, subject_id, generation,
           published_at, unknown_groups_json) VALUES ('tenant-a', ?, ?, 1, ?)`
      )
      .run(user, '0000000000000001:3', JSON.stringify([A]));
    await expect(state(user)).resolves.toEqual({ ids: [B], unknown: [A, C].sort() });
    // So a rule's not_in_any_group(A) does not pass for this subject (see ar-lib-policy).

    // An unreadable record: every service group is unknown.
    account.db.exec("UPDATE dynamic_membership_publications SET unknown_groups_json = '{'");
    await expect(state(user)).resolves.toEqual({ ids: [], unknown: [A, B, C].sort() });
  });

  it('keeps the shared revision difference intact across subjects', async () => {
    clearChangedServiceGroupsCache();
    const { A, B } = await dynamicGroups(['A', 'B'], 3);
    const other = 'user-2';
    const recordWith = (subject: string, undecided: string[]) =>
      account.db
        .prepare(
          `INSERT INTO dynamic_membership_publications (tenant_id, subject_id, generation,
             published_at, unknown_groups_json) VALUES ('tenant-a', ?, '0000000000000001:3', 1, ?)`
        )
        .run(subject, JSON.stringify(undecided));
    recordWith(user, [B]);
    recordWith(other, []);
    saveCatalog(4, [serviceGroup(A, 'changed'), serviceGroup(B, 'x')]);
    // The same (tenant, published, current) revisions, read one after the other.
    await expect(state(user)).resolves.toEqual({ ids: [], unknown: [A, B].sort() });
    await expect(state(other)).resolves.toEqual({ ids: [], unknown: [A] });
  });

  it('treats a record written before unknown_groups_json as every service group unknown', async () => {
    clearChangedServiceGroupsCache();
    const { A, B } = await dynamicGroups(['A', 'B'], 3);
    dynamicRow(user, A, '0000000000000001:3');
    account.db.exec(`INSERT INTO dynamic_membership_publications (tenant_id, subject_id,
      generation, published_at) VALUES ('tenant-a', 'user-1', '0000000000000001:3', 1)`);
    await expect(state(user)).resolves.toEqual({ ids: [], unknown: [A, B].sort() });
  });

  it('keeps a group known through another membership out of the unknown set', async () => {
    clearChangedServiceGroupsCache();
    const parent = await create('parent');
    const child = (await dynamicGroups(['child'], 3)).child;
    meta.db.prepare('UPDATE "groups" SET parent_group_id = ? WHERE id = ?').run(parent, child);
    await join(parent);
    await assignGroupRole(meta.adapter, tenant, { groupId: parent, roleId: 'reader' });
    // The child (a service group) was never evaluated for the subject: unknown, and so would its
    // ancestors be, but the parent is known through the manual membership.
    await expect(state(user)).resolves.toEqual({ ids: [parent], unknown: [child] });
    await expect(resolveSubjectRolesAndGroups(stores(), tenant, user, now)).resolves.toMatchObject({
      unknownGroupIds: [child],
      rolesComplete: true,
    });
  });

  it('counts only catalog-owned service groups, not an administrator group of the dynamic kind', async () => {
    clearChangedServiceGroupsCache();
    const adminGroup = await create('admin-dynamic');
    meta.db.prepare(`UPDATE "groups" SET kind = 'dynamic' WHERE id = ?`).run(adminGroup);
    // No publication on record, but no service group either: nothing unknown.
    await expect(state(user)).resolves.toEqual({ ids: [], unknown: [] });
  });

  it('names only the roles granted in force through service groups to deny-rule checks', async () => {
    const { A } = await dynamicGroups(['A'], 3);
    meta.db.exec(`INSERT INTO roles (id,tenant_id,name,permissions_json,created_at)
      VALUES ('expired-role','tenant-a','Expired','[]',1)`);
    await assignGroupRole(meta.adapter, tenant, { groupId: A, roleId: 'reader' });
    await assignGroupRole(meta.adapter, tenant, {
      groupId: A,
      roleId: 'expired-role',
      expiresAt: now - 1,
    });
    const decided = await serviceGroupDecidedGroups(meta.adapter, tenant, now);
    expect([...decided.roles]).toEqual(['Reader']);
    expect(decided.affected.has(A)).toBe(true);
  });

  it('counts roles as incomplete only when an unknown group carries a role grant', async () => {
    clearChangedServiceGroupsCache();
    const { A } = await dynamicGroups(['A'], 3);
    await expect(resolveSubjectRolesAndGroups(stores(), tenant, user, now)).resolves.toMatchObject({
      unknownGroupIds: [A],
      rolesComplete: true,
    });
    await assignGroupRole(meta.adapter, tenant, { groupId: A, roleId: 'reader' });
    await expect(resolveSubjectRolesAndGroups(stores(), tenant, user, now)).resolves.toMatchObject({
      unknownGroupIds: [A],
      rolesComplete: false,
    });
  });

  it('limits depth per direct membership and binds no more than 90 IDs per lookup', async () => {
    const chain = [await create('root')];
    for (let i = 1; i <= 18; i++) chain.push(await create('level-' + i, chain[i - 1]));
    const siblings = [];
    for (let i = 0; i < 95; i++) siblings.push(await create('sibling-' + i));
    await replaceSourceMemberships(stores(), tenant, user, 'rule', 'rule-1', [
      chain[18],
      ...siblings,
    ]);
    const query = vi.spyOn(meta.adapter, 'query');
    const groups = await resolveSubjectGroups(stores(), tenant, user, now);
    expect(groups.paths.get(chain[18])).toEqual(new Set(chain.slice(2).reverse()));
    await resolveEffectiveRoleAssignments(stores(), tenant, user, now);
    expect(
      query.mock.calls
        .filter(([sql]) => sql.includes(' IN ('))
        .every(([sql]) => (sql.match(/ IN \(([^)]+)\)/)?.[1].split(',').length ?? 0) <= 90)
    ).toBe(true);
    expect(groups.directGroupIds.size).toBe(96);
  });

  it('serves cached claims until a subject invalidation or a tenant version bump', async () => {
    const g = await create('g');
    const values = new Map<string, string>();
    const cache = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
      list: vi.fn(async ({ prefix }: { prefix: string }) => ({
        keys: [...values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      })),
      delete: vi.fn(async (key: string) => {
        values.delete(key);
      }),
    };
    const options = {
      cache: cache as unknown as KVNamespace,
      tenantId: tenant,
      claimsConfig: 'roles',
    };
    const read = async () => [
      (await getIDTokenRBACClaims(stores(), user, options)).authrim_roles ?? [],
      (await getAccessTokenRBACClaims(stores(), user, options)).authrim_roles ?? [],
      (await getCompositeRBACCache(stores(), user, options)).roles,
    ];
    // Writes are fire-and-forget: wait for the three entries (id, access, composite) to land.
    const settled = () =>
      vi.waitFor(() =>
        expect([...values.keys()].filter((key) => !key.includes('-version:'))).toHaveLength(3)
      );
    expect(await read()).toEqual([[], [], []]);
    await settled();
    // Cached: a group role granted without the cache being told is not seen yet ...
    await assignGroupRole(meta.adapter, tenant, { groupId: g, roleId: 'reader' });
    await upsertGroupMembership(stores(), tenant, user, { groupId: g, source: 'manual' });
    expect(await read()).toEqual([[], [], []]);
    // ... until the subject's entries are dropped by the membership write point.
    await upsertGroupMembership(
      stores(),
      tenant,
      user,
      { groupId: g, source: 'manual' },
      options.cache
    );
    expect(values.has(`rbac:v2:subject-version:${tenant}:${user}`)).toBe(true);
    expect(await read()).toEqual([['Reader'], ['Reader'], ['Reader']]);
    // Another tenant's change leaves this tenant's entries in place.
    await settled();
    const writes = cache.put.mock.calls.length;
    await createGroup(meta.adapter, 'other', { groupKey: 'g', displayName: 'G' });
    expect(await read()).toEqual([['Reader'], ['Reader'], ['Reader']]);
    expect(cache.put.mock.calls.length).toBe(writes);
    // A rename alone changes authrim_groups, so it bumps the tenant version too.
    await updateGroup(meta.adapter, tenant, g, { displayName: 'Renamed' }, options.cache);
    expect(values.has(`rbac:v2:tenant-version:${tenant}`)).toBe(true);
    // A cached entry is not served past the next scheduled change of the subject's roles.
    await upsertGroupMembership(
      stores(),
      tenant,
      user,
      { groupId: g, source: 'manual', staleAfter: now + 100 },
      options.cache
    );
    expect(await read()).toEqual([['Reader'], ['Reader'], ['Reader']]);
    await vi.waitFor(() =>
      expect(
        [...values.entries()]
          .filter(([key]) => !key.includes('-version:'))
          .map(([, value]) => (JSON.parse(value) as { validUntil: number }).validUntil)
      ).toEqual([now + 100, now + 100, now + 100])
    );
    vi.setSystemTime((now + 100) * 1000);
    expect(await read()).toEqual([[], [], []]);
    vi.setSystemTime(now * 1000);
    // Removing the group's role bumps the tenant version: every cached entry is bypassed.
    await removeGroupRole(meta.adapter, tenant, { groupId: g, roleId: 'reader' }, options.cache);
    expect(await read()).toEqual([[], [], []]);
  });

  it('lists the confirmed groups, caches nothing, while some memberships are unknown', async () => {
    const manual = await create('manual');
    const dynamic = await create('dynamic');
    await join(manual);
    // A dynamic row with no publication on record: that membership is not known.
    const dynamicRow = (subject: string) =>
      account.db
        .prepare(
          `INSERT INTO group_memberships (id, tenant_id, group_id, subject_id, assignment_source,
             source_ref, stale_after, created_at, updated_at)
           VALUES (?, 'tenant-a', ?, ?, 'dynamic', '0000000000000001:1', ?, 1, 1)`
        )
        .run(`d-${subject}`, dynamic, subject, now + 3600);
    dynamicRow(user);
    const cache = { get: vi.fn(async () => null), put: vi.fn(async () => undefined) };
    const options = {
      cache: cache as unknown as KVNamespace,
      tenantId: tenant,
      claimsConfig: 'roles,groups',
    };
    const { resolveSubjectGroupClaims } = await import('../../utils/rbac-claims');

    const id = await getIDTokenRBACClaims(stores(), user, options);
    const access = await getAccessTokenRBACClaims(stores(), user, options);
    const composite = await getCompositeRBACCache(stores(), user, options);
    // Only the roles asked for: still read with the groups once, and not cached either.
    await getAccessTokenRBACClaims(stores(), user, { ...options, claimsConfig: 'roles' });
    // The confirmed membership (manual) is listed; the unknown one is not (nor "not a member").
    expect(id.authrim_groups?.map((group) => group.id)).toEqual([manual]);
    expect(access.authrim_groups?.map((group) => group.id)).toEqual([manual]);
    expect(composite.groups.map((group) => group.id)).toEqual([manual]);
    await expect(resolveSubjectGroupClaims(stores(), tenant, user)).resolves.toMatchObject([
      { id: manual },
    ]);

    // Nothing confirmed and something unknown: no list at all (an empty one would say "none").
    const other = 'user-2';
    dynamicRow(other);
    expect((await getIDTokenRBACClaims(stores(), other, options)).authrim_groups).toBeUndefined();
    await expect(resolveSubjectGroupClaims(stores(), tenant, other)).rejects.toThrow(
      'subject_groups_uncertain'
    );
    // Give a (fire-and-forget) cache write the time to land: none does.
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 50));
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);
    expect(cache.put).not.toHaveBeenCalled();

    // Known again (the row gone): the list is in the claims, and cached.
    account.db.exec("DELETE FROM group_memberships WHERE id = 'd-user-1'");
    const known = await getIDTokenRBACClaims(stores(), user, options);
    expect(known.authrim_groups?.map((group) => group.id)).toEqual([manual]);
    await vi.waitFor(() => expect(cache.put).toHaveBeenCalled());
  });

  it('counts a group named by an enabled policy rule (or below one) as carrying authorization', async () => {
    const parent = await create('parent');
    const child = await create('child', parent);
    const unrelated = await create('unrelated');
    const rule = (id: string, conditions: unknown, enabled = 1) =>
      meta.db
        .prepare(
          `INSERT INTO policy_rules (id, tenant_id, name, effect, conditions, enabled, created_at,
             updated_at) VALUES (?, 'tenant-a', ?, 'deny', ?, ?, 1, 1)`
        )
        .run(id, id, JSON.stringify(conditions), enabled);

    expect([...(await groupsCarryingRoles(meta.adapter, tenant, [parent, child]))]).toEqual([]);
    // A disabled rule, and one whose conditions name no group, carry nothing.
    rule('disabled', [{ type: 'in_group', params: { group_id: parent } }], 0);
    rule('no-group', [{ type: 'attribute_exists', params: { name: 'x' } }]);
    expect(await groupReferencedByPolicyRules(meta.adapter, tenant, parent)).toBe(false);

    // A removal counts as much as an addition: not_in_any_group names the group too.
    rule('negative', [{ type: 'not_in_any_group', params: { group_ids: [parent] } }]);
    expect(await groupReferencedByPolicyRules(meta.adapter, tenant, parent)).toBe(true);
    // A member of the child is a member of the parent: the child carries it as well.
    expect(await groupReferencedByPolicyRules(meta.adapter, tenant, child)).toBe(true);
    expect(await groupReferencedByPolicyRules(meta.adapter, tenant, unrelated)).toBe(false);
    expect(
      [...(await groupsCarryingRoles(meta.adapter, tenant, [parent, child, unrelated]))].sort()
    ).toEqual([child, parent].sort());

    expect(
      policyConditionGroupIds([
        { type: 'in_group', params: { group_id: 'a' } },
        { type: 'in_any_group', params: { group_ids: ['b', 'c'] } },
        { type: 'in_all_groups', params: { group_ids: ['d'] } },
        { type: 'same_group', params: {} },
        { type: 'has_role', params: { role: 'r' } },
      ])
    ).toEqual(['a', 'b', 'c', 'd']);
  });
});
