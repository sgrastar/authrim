/**
 * ReBAC on the executable D1 schema (real SQL): group usersets, the declared-paths rule, exclusion
 * against direct tuples, unusable definitions, and lists that never return what the check denies.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import { ReBACService } from '../rebac-service';
import { ClosureManager } from '../closure-manager';
import type { IReBACCacheManager } from '../interfaces';
import type { SubjectGroupsResolver } from '../types';
import type { IStorageAdapter } from '../../storage/interfaces';
import { createGroup } from '../../services/group-catalog';
import { subjectGroupsResolver, upsertGroupMembership } from '../../services/group-membership';
import { relationDefinitionErrors } from '../relation-parser';
import { expressionContainsExclusion } from '../userset';

const TENANT = 'tenant-a';
const USER = 'user-1';

function storage(adapter: ReturnType<typeof sqliteAdapter>['adapter']): IStorageAdapter {
  return {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
    query: <T = unknown>(sql: string, params?: unknown[]) => adapter.query<T>(sql, params),
    execute: async (sql: string, params?: unknown[]) => {
      const result = await adapter.execute(sql, params);
      return { success: result.success, meta: { changes: result.rowsAffected, last_row_id: 0 } };
    },
  };
}

function cacheSpy(): IReBACCacheManager & { set: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    invalidate: vi.fn(async () => {}),
    invalidatePattern: vi.fn(async () => {}),
    invalidateObject: vi.fn(async () => {}),
    invalidateUser: vi.fn(async () => {}),
  };
}

const groups =
  (effective: string[], unknown: string[] = []): SubjectGroupsResolver =>
  async () => ({ effectiveGroupIds: effective, unknownGroupIds: unknown });

describe('ReBAC on real SQL', () => {
  let fixture: ReturnType<typeof sqliteAdapter>;
  let db: DatabaseSync;

  function tuple(
    id: string,
    from: [string, string, string?],
    relation: string,
    to: [string, string],
    expiresAt: number | null = null
  ) {
    db.prepare(
      `INSERT INTO relationships (id, tenant_id, relationship_type, from_type, from_id,
         from_relation, to_type, to_id, permission_level, expires_at, is_bidirectional,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'full', ?, 0, 0, 0)`
    ).run(id, TENANT, relation, from[0], from[1], from[2] ?? null, to[0], to[1], expiresAt);
  }
  const userset = (id: string, groupId: string, relation: string, to: [string, string]) =>
    tuple(id, ['group', groupId, 'member'], relation, to);

  function definition(id: string, objectType: string, relation: string, expression: unknown) {
    db.prepare(
      `INSERT INTO relation_definitions (id, tenant_id, object_type, relation_name,
         definition_json, priority, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 1, 0, 0)`
    ).run(
      id,
      TENANT,
      objectType,
      relation,
      typeof expression === 'string' ? expression : JSON.stringify(expression)
    );
  }

  function service(
    subjectGroups?: SubjectGroupsResolver,
    cache: IReBACCacheManager = cacheSpy(),
    closure?: ClosureManager
  ) {
    return new ReBACService(
      storage(fixture.adapter),
      { max_depth: 5, ...(subjectGroups && { subject_groups: subjectGroups }) },
      cache,
      closure ?? null
    );
  }

  const check = (rebac: ReBACService, relation = 'viewer', object = 'document:doc-1') =>
    rebac.check({ tenant_id: TENANT, user_id: USER, relation, object });

  beforeEach(() => {
    fixture = sqliteAdapter('core');
    db = fixture.db;
  });
  afterEach(() => db.close());

  describe('group usersets', () => {
    it('allows a member of the group, through the direct lookup', async () => {
      userset('u1', 'grp-1', 'viewer', ['document', 'doc-1']);
      const cache = cacheSpy();
      expect(await check(service(groups(['grp-1']), cache))).toEqual({
        allowed: true,
        resolved_via: 'direct',
        path: ['group:grp-1#member'],
      });
      // A result that depends on memberships is not cached (they change without a tuple write).
      expect(cache.set).not.toHaveBeenCalled();
    });

    it('denies a subject that is not a member', async () => {
      userset('u1', 'grp-1', 'viewer', ['document', 'doc-1']);
      expect(await check(service(groups(['grp-2'])))).toEqual({
        allowed: false,
        resolved_via: 'direct',
      });
    });

    it('denies an unknown membership as unknown_membership, never cached', async () => {
      userset('u1', 'grp-1', 'viewer', ['document', 'doc-1']);
      const cache = cacheSpy();
      const resolver = vi
        .fn<SubjectGroupsResolver>()
        .mockResolvedValueOnce({ effectiveGroupIds: [], unknownGroupIds: ['grp-1'] })
        .mockResolvedValueOnce({ effectiveGroupIds: ['grp-1'], unknownGroupIds: [] });
      const rebac = service(resolver, cache);
      expect(await check(rebac)).toEqual({ allowed: false, resolved_via: 'unknown_membership' });
      expect(cache.set).not.toHaveBeenCalled();
      // Asked again: decided afresh (nothing was cached).
      expect((await check(rebac)).allowed).toBe(true);
      expect(resolver).toHaveBeenCalledTimes(2);
    });

    it('treats a failing resolver, or none, as unknown', async () => {
      userset('u1', 'grp-1', 'viewer', ['document', 'doc-1']);
      const failing: SubjectGroupsResolver = async () => {
        throw new Error('account database unavailable');
      };
      expect((await check(service(failing))).resolved_via).toBe('unknown_membership');
      expect((await check(service())).resolved_via).toBe('unknown_membership');
    });

    it('does not ask for memberships when no userset is on the path (and caches)', async () => {
      tuple('d1', ['subject', USER], 'viewer', ['document', 'doc-1']);
      const resolver = vi.fn(groups([]));
      const cache = cacheSpy();
      expect((await check(service(resolver, cache))).allowed).toBe(true);
      expect((await check(service(resolver, cache), 'editor')).allowed).toBe(false);
      expect(resolver).not.toHaveBeenCalled();
      expect(cache.set).toHaveBeenCalledTimes(2);
    });

    it('ignores an expired userset, and a group row that is not the member userset', async () => {
      tuple('u1', ['group', 'grp-1', 'member'], 'viewer', ['document', 'doc-1'], 1);
      tuple('u2', ['group', 'grp-1'], 'viewer', ['document', 'doc-2']);
      expect((await check(service(groups(['grp-1'])))).allowed).toBe(false);
      expect((await check(service(groups(['grp-1'])), 'viewer', 'document:doc-2')).allowed).toBe(
        false
      );
    });

    it('allows a member of a descendant group (effective groups include ancestors)', async () => {
      const parent = await createGroup(fixture.adapter, TENANT, {
        groupKey: 'engineering',
        displayName: 'Engineering',
      });
      const child = await createGroup(fixture.adapter, TENANT, {
        groupKey: 'platform',
        displayName: 'Platform',
        parentGroupId: parent,
      });
      const stores = { metadata: fixture.adapter, account: fixture.adapter };
      await upsertGroupMembership(stores, TENANT, USER, { groupId: child, source: 'manual' });
      userset('u1', parent, 'viewer', ['document', 'doc-1']);
      const resolver = subjectGroupsResolver(fixture.adapter, async (_tenant, subjectId) => ({
        db: fixture.adapter,
        subjectId,
      }));
      expect(await check(service(resolver))).toEqual({
        allowed: true,
        resolved_via: 'direct',
        path: [`group:${parent}#member`],
      });
      expect(
        (
          await service(resolver).check({
            tenant_id: TENANT,
            user_id: 'user-2',
            relation: 'viewer',
            object: 'document:doc-1',
          })
        ).allowed
      ).toBe(false);
    });

    it('allows through a userset inside a definition (tuple_to_userset to a folder)', async () => {
      definition('def-doc-viewer', 'document', 'viewer', {
        type: 'union',
        children: [
          { type: 'direct', relation: 'viewer' },
          {
            type: 'tuple_to_userset',
            tupleset: { relation: 'parent' },
            computed_userset: { relation: 'viewer' },
          },
        ],
      });
      tuple('edge', ['document', 'doc-1'], 'parent', ['folder', 'folder-1']);
      userset('u1', 'grp-1', 'viewer', ['folder', 'folder-1']);
      const allowed = await check(service(groups(['grp-1'])));
      expect(allowed).toMatchObject({ allowed: true, resolved_via: 'computed' });
      expect(await check(service(groups([], ['grp-1'])))).toEqual({
        allowed: false,
        resolved_via: 'unknown_membership',
      });
      expect(await check(service(groups(['grp-2'])))).toEqual({
        allowed: false,
        resolved_via: 'computed',
      });
    });
  });

  describe('exclusion and direct tuples', () => {
    const viewerButNotBlocked = {
      type: 'exclusion',
      base: { type: 'direct', relation: 'viewer' },
      subtract: { type: 'direct', relation: 'blocked' },
    };

    it('does not allow a direct tuple ahead of the exclusion', async () => {
      definition('def', 'document', 'viewer', viewerButNotBlocked);
      tuple('d1', ['subject', USER], 'viewer', ['document', 'doc-1']);
      expect((await check(service(groups([])))).allowed).toBe(true);
      tuple('d2', ['subject', USER], 'blocked', ['document', 'doc-1']);
      expect(await check(service(groups([])))).toMatchObject({
        allowed: false,
        resolved_via: 'computed',
      });
    });

    it('lets a userset subtract a member, and makes an unknown one undecided', async () => {
      definition('def', 'document', 'viewer', viewerButNotBlocked);
      tuple('d1', ['subject', USER], 'viewer', ['document', 'doc-1']);
      userset('u1', 'grp-blocked', 'blocked', ['document', 'doc-1']);
      expect((await check(service(groups(['grp-blocked'])))).allowed).toBe(false);
      expect((await check(service(groups(['grp-other'])))).allowed).toBe(true);
      expect(await check(service(groups([], ['grp-blocked'])))).toEqual({
        allowed: false,
        resolved_via: 'unknown_membership',
      });
    });

    it('lets the definition alone decide: a tuple counts only through a direct leaf', async () => {
      definition('def', 'document', 'viewer', { type: 'direct', relation: 'editor' });
      tuple('d1', ['subject', USER], 'viewer', ['document', 'doc-1']);
      expect(await check(service())).toEqual({ allowed: false, resolved_via: 'computed' });
      tuple('d2', ['subject', USER], 'editor', ['document', 'doc-1']);
      expect(await check(service())).toEqual({
        allowed: true,
        resolved_via: 'computed',
        path: ['d2'],
      });
    });

    it('leaves an exclusion of the same relation empty: direct(reader) - direct(reader)', async () => {
      definition('def', 'document', 'viewer', {
        type: 'exclusion',
        base: { type: 'direct', relation: 'reader' },
        subtract: { type: 'direct', relation: 'reader' },
      });
      tuple('d1', ['subject', USER], 'reader', ['document', 'doc-1']);
      expect((await check(service())).allowed).toBe(false);
    });
  });

  describe('unusable stored definitions', () => {
    for (const [name, stored] of [
      ['not JSON', '{'],
      ['an unknown expression type', { type: 'wildcard' }],
      ['a malformed shape', { type: 'union', children: 'viewer' }],
      ['an empty union', { type: 'union', children: [] }],
    ] as const) {
      it(`denies every check on the relation (${name}), with no direct fallback`, async () => {
        definition('def', 'document', 'viewer', stored);
        tuple('d1', ['subject', USER], 'viewer', ['document', 'doc-1']);
        const cache = cacheSpy();
        expect(await check(service(undefined, cache))).toEqual({
          allowed: false,
          resolved_via: 'computed',
        });
        expect(cache.set).not.toHaveBeenCalled();
        const rebac = service();
        expect(
          (
            await rebac.listObjects({
              tenant_id: TENANT,
              user_id: USER,
              relation: 'viewer',
              object_type: 'document',
            })
          ).object_ids
        ).toEqual([]);
      });
    }
  });

  describe('declared paths only', () => {
    // user -member-> team, team -viewer-> document: no definition declares the path.
    beforeEach(() => {
      tuple('t1', ['subject', USER], 'member', ['team', 'team-1']);
      tuple('t2', ['team', 'team-1'], 'viewer', ['document', 'doc-1']);
    });

    it('denies a relation reached only through an undeclared path', async () => {
      expect(await check(service())).toEqual({ allowed: false, resolved_via: 'direct' });
    });

    it('lists nothing the check denies (no closure: direct queries)', async () => {
      const rebac = service();
      expect(
        await rebac.listObjects({
          tenant_id: TENANT,
          user_id: USER,
          relation: 'viewer',
          object_type: 'document',
        })
      ).toEqual({
        object_ids: [],
        next_cursor: undefined,
        userset_subjects_omitted: false,
        computed_relations_omitted: false,
      });
      expect(
        (await rebac.listUsers({ tenant_id: TENANT, relation: 'viewer', object: 'document:doc-1' }))
          .user_ids
      ).toEqual([]);
    });

    it('lists nothing the check denies (closure)', async () => {
      const closure = new ClosureManager(storage(fixture.adapter), 5);
      await closure.recomputeForUser(TENANT, USER);
      await closure.recomputeForObject(TENANT, 'document', 'doc-1');
      const rebac = service(undefined, cacheSpy(), closure);
      expect(
        (
          await rebac.listObjects({
            tenant_id: TENANT,
            user_id: USER,
            relation: 'viewer',
            object_type: 'document',
          })
        ).object_ids
      ).toEqual([]);
      expect(
        (await rebac.listUsers({ tenant_id: TENANT, relation: 'viewer', object: 'document:doc-1' }))
          .user_ids
      ).toEqual([]);
      // The closure holds the direct tuple, which the check allows.
      expect(
        (
          await rebac.listObjects({
            tenant_id: TENANT,
            user_id: USER,
            relation: 'member',
            object_type: 'team',
          })
        ).object_ids
      ).toEqual(['team-1']);
      expect((await check(rebac, 'member', 'team:team-1')).allowed).toBe(true);
    });
  });

  describe('lists', () => {
    it('leave usersets out and flag them', async () => {
      userset('u1', 'grp-1', 'viewer', ['document', 'doc-1']);
      tuple('d1', ['subject', 'user-2'], 'viewer', ['document', 'doc-1']);
      const rebac = service(groups(['grp-1']));
      // The subject is allowed only through the userset...
      expect((await check(rebac)).allowed).toBe(true);
      // ...and is not listed; the lists say usersets were left out.
      expect(
        await rebac.listUsers({ tenant_id: TENANT, relation: 'viewer', object: 'document:doc-1' })
      ).toEqual({
        user_ids: ['user-2'],
        next_cursor: undefined,
        userset_subjects_omitted: true,
        computed_relations_omitted: false,
      });
      expect(
        await rebac.listObjects({
          tenant_id: TENANT,
          user_id: USER,
          relation: 'viewer',
          object_type: 'document',
        })
      ).toEqual({
        object_ids: [],
        next_cursor: undefined,
        userset_subjects_omitted: true,
        computed_relations_omitted: false,
      });
      // No userset for another relation or object: no flag.
      expect(
        (await rebac.listUsers({ tenant_id: TENANT, relation: 'viewer', object: 'document:doc-2' }))
          .userset_subjects_omitted
      ).toBe(false);
      expect(
        (
          await rebac.listObjects({
            tenant_id: TENANT,
            user_id: USER,
            relation: 'editor',
            object_type: 'document',
          })
        ).userset_subjects_omitted
      ).toBe(false);
    });

    it('leave out a direct tuple the exclusion denies', async () => {
      definition('def', 'document', 'viewer', {
        type: 'exclusion',
        base: { type: 'direct', relation: 'viewer' },
        subtract: { type: 'direct', relation: 'blocked' },
      });
      tuple('d1', ['subject', USER], 'viewer', ['document', 'doc-1']);
      tuple('d2', ['subject', 'user-2'], 'viewer', ['document', 'doc-1']);
      tuple('d3', ['subject', USER], 'blocked', ['document', 'doc-1']);
      const rebac = service(groups([]));
      expect((await check(rebac)).allowed).toBe(false);
      expect(
        (await rebac.listUsers({ tenant_id: TENANT, relation: 'viewer', object: 'document:doc-1' }))
          .user_ids
      ).toEqual(['user-2']);
      expect(
        (
          await rebac.listObjects({
            tenant_id: TENANT,
            user_id: USER,
            relation: 'viewer',
            object_type: 'document',
          })
        ).object_ids
      ).toEqual([]);
    });
  });
});

describe('relation definition validity', () => {
  it('accepts every expression type with its fields', () => {
    expect(
      relationDefinitionErrors({
        type: 'union',
        children: [
          { type: 'direct', relation: 'viewer' },
          {
            type: 'tuple_to_userset',
            tupleset: { relation: 'parent' },
            computed_userset: { relation: 'viewer' },
          },
          {
            type: 'intersection',
            children: [{ type: 'direct', relation: 'member' }],
          },
          {
            type: 'exclusion',
            base: { type: 'direct', relation: 'viewer' },
            subtract: { type: 'direct', relation: 'blocked' },
          },
        ],
      })
    ).toEqual([]);
  });

  it('rejects unknown types and malformed shapes', () => {
    for (const bad of [
      null,
      'viewer',
      [],
      '{',
      { type: 'wildcard' },
      { relation: 'viewer' },
      { type: 'direct' },
      { type: 'direct', relation: '' },
      { type: 'union', children: [] },
      { type: 'union', children: [{ type: 'nope' }] },
      { type: 'tuple_to_userset', tupleset: { relation: 'parent' } },
      { type: 'exclusion', base: { type: 'direct', relation: 'viewer' } },
    ]) {
      expect(relationDefinitionErrors(bad).length, JSON.stringify(bad)).toBeGreaterThan(0);
    }
  });

  it('finds an exclusion anywhere in the expression', () => {
    const exclusion = {
      type: 'exclusion' as const,
      base: { type: 'direct' as const, relation: 'viewer' },
      subtract: { type: 'direct' as const, relation: 'blocked' },
    };
    expect(expressionContainsExclusion(exclusion)).toBe(true);
    expect(
      expressionContainsExclusion({
        type: 'union',
        children: [{ type: 'intersection', children: [exclusion] }],
      })
    ).toBe(true);
    expect(expressionContainsExclusion({ type: 'direct', relation: 'viewer' })).toBe(false);
  });
});
