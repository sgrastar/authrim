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
  upsertGroupMembership,
} from '../group-membership';
import { assignGroupRole, removeGroupRole } from '../group-role-assignments';
import {
  resolveSubjectRoles,
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
    expect((await check.check(request)).allowed).toBe(true);
    expect(
      (await check.check({ ...request, resource_context: { group_id: 'other' } })).allowed
    ).toBe(false);
    const scoped = { scope: 'group', scopeTarget: 'group:reports' };
    expect(roleAssignmentHolds(scoped, { groupIds: new Set(['reports']) })).toBe(true);
    expect(roleAssignmentHolds(scoped, { groupIds: ['other'] })).toBe(false);
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
            ('narrow','tenant-a','user-1','reader','resource','doc:1',1,1)`);
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
          { name: 'Reader', scope: 'resource', scopeTarget: 'doc:1' },
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
      VALUES('narrow','tenant-a','user-1','writer','resource','doc:1',1,1)`);
    await assignGroupRole(meta.adapter, tenant, {
      groupId: group,
      roleId: 'reader',
      scopeType: 'resource',
      scopeTarget: 'doc:2',
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

  it('limits depth per direct membership and binds no more than 90 IDs per lookup', async () => {
    const chain = [await create('root')];
    for (let i = 1; i <= 18; i++) chain.push(await create('level-' + i, chain[i - 1]));
    const siblings = [];
    for (let i = 0; i < 95; i++) siblings.push(await create('sibling-' + i));
    await replaceSourceMemberships(stores(), tenant, user, 'dynamic', 'rule-1', [
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
});
