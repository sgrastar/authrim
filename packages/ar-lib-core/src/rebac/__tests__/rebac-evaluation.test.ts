/**
 * ReBAC evaluation on the executable D1 schema (real SQL): resolved subject ids, tuple_to_userset
 * through the target's own definition, cycles, contextual tuples under definitions, dynamic
 * groups in a subtract, the per-tenant cache version, and list candidates checked against live
 * rows.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import { ReBACService } from '../rebac-service';
import { ClosureManager } from '../closure-manager';
import { ReBACCacheManager, bumpReBACTenantVersion } from '../cache-manager';
import { externalSubjectRef } from '../rebac-service';
import { relationDefinitionErrors } from '../relation-parser';
import { ruleOnRelationshipTupleSource } from '../tuple-type-rules';
import { MAX_DEFINITION_DEPTH } from '../userset';
import type { IReBACCacheManager } from '../interfaces';
import type { SubjectGroupsResolver } from '../types';
import type { IStorageAdapter } from '../../storage/interfaces';
import { createGroup } from '../../services/group-catalog';

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

/** A KV namespace in memory (the version store). */
function memoryKv() {
  const values = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  } as unknown as KVNamespace;
}

const groups =
  (effective: string[], unknown: string[] = []): SubjectGroupsResolver =>
  async () => ({ effectiveGroupIds: effective, unknownGroupIds: unknown });

const VIEWER_BUT_NOT_BLOCKED = {
  type: 'exclusion',
  base: { type: 'direct', relation: 'viewer' },
  subtract: { type: 'direct', relation: 'blocked' },
};
const PARENT_VIEWER = {
  type: 'tuple_to_userset',
  tupleset: { relation: 'parent' },
  computed_userset: { relation: 'viewer' },
};

describe('ReBAC evaluation on real SQL', () => {
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
    options: {
      subjectGroups?: SubjectGroupsResolver;
      cache?: IReBACCacheManager;
      closure?: ClosureManager;
      versions?: KVNamespace;
    } = {}
  ) {
    return new ReBACService(
      storage(fixture.adapter),
      {
        max_depth: 5,
        ...(options.subjectGroups && { subject_groups: options.subjectGroups }),
        ...(options.versions && { version_namespace: options.versions }),
      },
      options.cache ?? cacheSpy(),
      options.closure ?? null
    );
  }

  const resolved = (rebac: ReBACService, subjectId: string, objectId = 'doc-1') =>
    rebac.checkResolved({
      tenantId: TENANT,
      subjectId,
      relation: 'viewer',
      objectType: 'document',
      objectId,
    });

  beforeEach(() => {
    fixture = sqliteAdapter('core');
    db = fixture.db;
  });
  afterEach(() => db.close());

  it('takes a resolved subject id verbatim (ids that differ only by a `:` prefix)', async () => {
    tuple('t1', ['subject', 'team:alice'], 'viewer', ['document', 'doc-1']);
    tuple('t2', ['subject', 'alice'], 'viewer', ['document', 'doc-2']);
    const rebac = service();
    expect((await resolved(rebac, 'team:alice')).allowed).toBe(true);
    expect((await resolved(rebac, 'alice')).allowed).toBe(false);
    expect((await resolved(rebac, 'team:alice', 'doc-2')).allowed).toBe(false);
    expect((await resolved(rebac, 'alice', 'doc-2')).allowed).toBe(true);
    // The /api/rebac boundary still reads `user:<id>` (and so `team:alice` as `alice`).
    expect(
      (
        await rebac.check({
          tenant_id: TENANT,
          user_id: 'user:alice',
          relation: 'viewer',
          object: 'document:doc-2',
        })
      ).allowed
    ).toBe(true);
  });

  it('takes only a single leading `user:` away at the /api/rebac boundary', async () => {
    tuple('t1', ['subject', 'team:alice'], 'viewer', ['document', 'doc-1']);
    tuple('t2', ['subject', 'alice'], 'viewer', ['document', 'doc-2']);
    const rebac = service();
    const check = (user_id: string, object: string) =>
      rebac.check({ tenant_id: TENANT, user_id, relation: 'viewer', object });
    expect((await check('team:alice', 'document:doc-1')).allowed).toBe(true);
    expect((await check('user:team:alice', 'document:doc-1')).allowed).toBe(true);
    expect((await check('team:alice', 'document:doc-2')).allowed).toBe(false);
    expect((await check('user:alice', 'document:doc-1')).allowed).toBe(false);
    // An id a list returns checks the same subject.
    const listed = await rebac.listUsers({
      tenant_id: TENANT,
      relation: 'viewer',
      object: 'document:doc-1',
    });
    expect(listed.user_ids).toEqual(['team:alice']);
    expect((await check(listed.user_ids[0], 'document:doc-1')).allowed).toBe(true);
    expect(
      (
        await rebac.listObjects({
          tenant_id: TENANT,
          user_id: 'team:alice',
          relation: 'viewer',
          object_type: 'document',
        })
      ).object_ids
    ).toEqual(['doc-1']);
  });

  it('round-trips stored ids that begin with user: through the external form', async () => {
    tuple('a', ['subject', 'alice'], 'viewer', ['document', 'doc-1']);
    tuple('b', ['subject', 'user:alice'], 'viewer', ['document', 'doc-2']);
    const rebac = service();
    for (const [doc, stored] of [
      ['doc-1', 'alice'],
      ['doc-2', 'user:alice'],
    ] as const) {
      const listed = (
        await rebac.listUsers({ tenant_id: TENANT, relation: 'viewer', object: `document:${doc}` })
      ).user_ids.map(externalSubjectRef);
      expect(listed).toEqual([`user:${stored}`]);
      const check = (user_id: string, object: string) =>
        rebac.check({ tenant_id: TENANT, user_id, relation: 'viewer', object });
      expect((await check(listed[0], `document:${doc}`)).allowed).toBe(true);
      // The other subject's document stays denied.
      const other = doc === 'doc-1' ? 'doc-2' : 'doc-1';
      expect((await check(listed[0], `document:${other}`)).allowed).toBe(false);
    }
  });

  it('evaluates from the database when the KV cache fails, and shares duplicate checks', async () => {
    tuple('v', ['subject', USER], 'viewer', ['document', 'doc-1']);
    const failing = {
      get: vi.fn(async () => {
        throw new Error('kv unavailable');
      }),
      put: vi.fn(async () => {
        throw new Error('kv unavailable');
      }),
      delete: vi.fn(async () => undefined),
    } as unknown as KVNamespace;
    const rebac = new ReBACService(storage(fixture.adapter), {
      cache_namespace: failing,
      version_namespace: memoryKv(),
    });
    expect((await resolved(rebac, USER)).allowed).toBe(true);
    expect(failing.get).toHaveBeenCalled();
    expect(failing.put).toHaveBeenCalled();
    // A batch of identical checks evaluates once (one cache read, one write).
    vi.mocked(failing.get).mockClear();
    vi.mocked(failing.put).mockClear();
    const request = {
      tenant_id: TENANT,
      user_id: USER,
      relation: 'viewer',
      object: 'document:doc-1',
    };
    const batch = await rebac.batchCheck({ checks: [request, request, request] });
    expect(batch.results.map((result) => result.allowed)).toEqual([true, true, true]);
    expect(failing.get).toHaveBeenCalledTimes(1);
    expect(failing.put).toHaveBeenCalledTimes(1);
  });

  it('refuses a definition naming more direct relations than one list query can bind', async () => {
    const many = (count: number) => ({
      type: 'union',
      children: Array.from({ length: count }, (_, i) => ({ type: 'direct', relation: `r${i}` })),
    });
    expect(relationDefinitionErrors(many(80))).toEqual([]);
    expect(relationDefinitionErrors(many(81)).length).toBeGreaterThan(0);
    // A stored one is unusable: checks deny.
    definition('def', 'document', 'viewer', many(81));
    tuple('v', ['subject', USER], 'r0', ['document', 'doc-1']);
    expect(await resolved(service(), USER)).toEqual({ allowed: false, resolved_via: 'computed' });
  });

  it('walks definitions to one depth: deeper ones are refused, unusable and list nothing', async () => {
    const nested = (levels: number): unknown =>
      levels === 0
        ? { type: 'direct', relation: 'viewer' }
        : { type: 'union', children: [nested(levels - 1)] };
    expect(relationDefinitionErrors(nested(MAX_DEFINITION_DEPTH))).toEqual([]);
    expect(relationDefinitionErrors(nested(MAX_DEFINITION_DEPTH + 1)).length).toBeGreaterThan(0);

    tuple('v', ['subject', USER], 'viewer', ['document', 'doc-1']);
    definition('def', 'document', 'viewer', nested(MAX_DEFINITION_DEPTH));
    const rebac = service();
    const list = () =>
      rebac.listObjects({
        tenant_id: TENANT,
        user_id: USER,
        relation: 'viewer',
        object_type: 'document',
      });
    // At the bound: evaluated and listed in full.
    expect((await resolved(rebac, USER)).allowed).toBe(true);
    expect((await list()).object_ids).toEqual(['doc-1']);
    fixture.db
      .prepare('UPDATE relation_definitions SET definition_json = ? WHERE id = ?')
      .run(JSON.stringify(nested(MAX_DEFINITION_DEPTH + 1)), 'def');
    expect(await resolved(service(), USER)).toEqual({ allowed: false, resolved_via: 'computed' });
    expect((await list()).object_ids).toEqual([]);
  });

  it('declares no object edge through an unusable definition (tuple rules use the loader)', async () => {
    const rule = () =>
      ruleOnRelationshipTupleSource(fixture.adapter, {
        tenantId: TENANT,
        fromType: 'document',
        relationshipType: 'parent',
      });
    const deep = (levels: number): unknown =>
      levels === 0 ? PARENT_VIEWER : { type: 'union', children: [deep(levels - 1)] };
    definition('def', 'document', 'viewer', deep(MAX_DEFINITION_DEPTH));
    expect(await rule()).toMatchObject({ allowed: true, kind: 'object_edge' });
    fixture.db
      .prepare('UPDATE relation_definitions SET definition_json = ? WHERE id = ?')
      .run(JSON.stringify(deep(MAX_DEFINITION_DEPTH + 1)), 'def');
    expect(await rule()).toEqual({ allowed: false, reason: 'undeclared_object_edge' });
  });

  it('keeps cache keys apart for ids that contain `:`', async () => {
    const cache = new ReBACCacheManager(undefined, 60);
    await cache.set('t', 'a:b', 'c', 'document', 'd', { allowed: true, resolved_via: 'direct' });
    expect(await cache.get('t', 'a', 'b:c', 'document', 'd')).toBeNull();
    expect(await cache.get('t', 'a:b', 'c', 'document', 'd')).toMatchObject({ allowed: true });
    await cache.set('t', 'u', 'viewer', 'doc:x', 'y', { allowed: true, resolved_via: 'direct' });
    expect(await cache.get('t', 'u', 'viewer', 'doc', 'x:y')).toBeNull();
    // Invalidation reads the components, not a pattern over the joined key.
    await cache.invalidateObject('t', 'doc', 'x:y');
    expect(await cache.get('t', 'u', 'viewer', 'doc:x', 'y')).not.toBeNull();
    await cache.invalidateObject('t', 'doc:x', 'y');
    expect(await cache.get('t', 'u', 'viewer', 'doc:x', 'y')).toBeNull();
    await cache.invalidateUser('t', 'a:b');
    expect(await cache.get('t', 'a:b', 'c', 'document', 'd')).toBeNull();
  });

  describe('tuple_to_userset through the target definition', () => {
    beforeEach(() => {
      definition('doc-viewer', 'document', 'viewer', PARENT_VIEWER);
      tuple('edge', ['document', 'doc-1'], 'parent', ['folder', 'folder-1']);
    });

    it('lets the folder exclusion block the document', async () => {
      definition('folder-viewer', 'folder', 'viewer', VIEWER_BUT_NOT_BLOCKED);
      tuple('v', ['subject', USER], 'viewer', ['folder', 'folder-1']);
      expect((await resolved(service(), USER)).allowed).toBe(true);
      tuple('b', ['subject', USER], 'blocked', ['folder', 'folder-1']);
      expect(await resolved(service(), USER)).toEqual({
        allowed: false,
        resolved_via: 'computed',
      });
    });

    it('does not take a bare direct tuple on a target whose relation has a definition', async () => {
      definition('folder-viewer', 'folder', 'viewer', { type: 'direct', relation: 'owner' });
      tuple('v', ['subject', USER], 'viewer', ['folder', 'folder-1']);
      expect((await resolved(service(), USER)).allowed).toBe(false);
      tuple('o', ['subject', USER], 'owner', ['folder', 'folder-1']);
      expect((await resolved(service(), USER)).allowed).toBe(true);
    });

    it('denies through an unusable target definition, uncached', async () => {
      definition('folder-viewer', 'folder', 'viewer', { type: 'wildcard' });
      tuple('v', ['subject', USER], 'viewer', ['folder', 'folder-1']);
      const cache = cacheSpy();
      expect(await resolved(service({ cache }), USER)).toEqual({
        allowed: false,
        resolved_via: 'computed',
      });
      expect(cache.set).not.toHaveBeenCalled();
    });

    it('terminates a cycle with an uncached deny', async () => {
      definition('folder-viewer', 'folder', 'viewer', PARENT_VIEWER);
      tuple('loop-1', ['folder', 'folder-1'], 'parent', ['folder', 'folder-2']);
      tuple('loop-2', ['folder', 'folder-2'], 'parent', ['folder', 'folder-1']);
      const cache = cacheSpy();
      expect((await resolved(service({ cache }), USER)).allowed).toBe(false);
      expect(cache.set).not.toHaveBeenCalled();
    });

    it('stops at the depth limit with an uncached deny', async () => {
      definition('folder-viewer', 'folder', 'viewer', {
        type: 'union',
        children: [{ type: 'direct', relation: 'viewer' }, PARENT_VIEWER],
      });
      for (let i = 1; i <= 8; i++)
        tuple(`chain-${i}`, ['folder', `folder-${i}`], 'parent', ['folder', `folder-${i + 1}`]);
      tuple('top', ['subject', USER], 'viewer', ['folder', 'folder-9']);
      const cache = cacheSpy();
      expect((await resolved(service({ cache }), USER)).allowed).toBe(false);
      expect(cache.set).not.toHaveBeenCalled();
      tuple('near', ['subject', USER], 'viewer', ['folder', 'folder-2']);
      expect((await resolved(service(), USER)).allowed).toBe(true);
    });
  });

  describe('contextual tuples', () => {
    const withContext = (rebac: ReBACService, relation: string, tupleRelation: string) =>
      rebac.check({
        tenant_id: TENANT,
        user_id: USER,
        relation,
        object: 'document:doc-1',
        context: {
          contextual_tuples: [{ user_id: USER, relation: tupleRelation, object: 'document:doc-1' }],
        },
      });

    it('are seen by the subtract as well: they cannot bypass an exclusion', async () => {
      definition('def', 'document', 'viewer', VIEWER_BUT_NOT_BLOCKED);
      tuple('v', ['subject', USER], 'viewer', ['document', 'doc-1']);
      const cache = cacheSpy();
      expect((await withContext(service({ cache }), 'viewer', 'blocked')).allowed).toBe(false);
      tuple('b', ['subject', USER], 'blocked', ['document', 'doc-1']);
      expect((await withContext(service({ cache }), 'viewer', 'viewer')).allowed).toBe(false);
      expect(cache.set).not.toHaveBeenCalled();
      expect(cache.get).not.toHaveBeenCalled();
    });

    it('deny on check and on batch check alike (stored viewer, contextual blocked)', async () => {
      definition('def', 'document', 'viewer', VIEWER_BUT_NOT_BLOCKED);
      tuple('v', ['subject', USER], 'viewer', ['document', 'doc-1']);
      const request = {
        tenant_id: TENANT,
        user_id: USER,
        relation: 'viewer',
        object: 'document:doc-1',
        context: {
          contextual_tuples: [{ user_id: USER, relation: 'blocked', object: 'document:doc-1' }],
        },
      };
      const rebac = service();
      expect((await rebac.check(request)).allowed).toBe(false);
      expect((await rebac.batchCheck({ checks: [request] })).results[0]?.allowed).toBe(false);
      // Without the tuple the stored viewer is allowed.
      expect((await rebac.check({ ...request, context: undefined })).allowed).toBe(true);
    });

    it('allow through the definition, never cached', async () => {
      definition('def', 'document', 'viewer', {
        type: 'union',
        children: [{ type: 'direct', relation: 'editor' }],
      });
      const cache = cacheSpy();
      expect((await withContext(service({ cache }), 'viewer', 'viewer')).allowed).toBe(false);
      expect(await withContext(service({ cache }), 'viewer', 'editor')).toEqual({
        allowed: true,
        resolved_via: 'context',
        path: ['contextual_tuple'],
      });
      expect(cache.set).not.toHaveBeenCalled();
    });
  });

  describe('dynamic groups in a subtract', () => {
    it('does not trust non-membership of a service group: the exclusion is undecided', async () => {
      definition('def', 'document', 'viewer', VIEWER_BUT_NOT_BLOCKED);
      tuple('v', ['subject', USER], 'viewer', ['document', 'doc-1']);
      const dynamicId = 'svc-1';
      await createGroup(fixture.adapter, TENANT, {
        id: dynamicId,
        groupKey: `dynamic:${dynamicId}`,
        displayName: 'Contractors',
        kind: 'dynamic',
      });
      const parent = await createGroup(fixture.adapter, TENANT, {
        groupKey: 'outside',
        displayName: 'Outside',
      });
      db.prepare(`UPDATE "groups" SET parent_group_id = ? WHERE id = ?`).run(parent, dynamicId);
      const plain = await createGroup(fixture.adapter, TENANT, {
        groupKey: 'plain',
        displayName: 'Plain',
      });

      tuple('u1', ['group', plain, 'member'], 'blocked', ['document', 'doc-1']);
      expect((await resolved(service({ subjectGroups: groups([]) }), USER)).allowed).toBe(true);

      // A userset on the service group, or on a group above one: "not a member" is not trusted.
      for (const groupId of [dynamicId, parent]) {
        db.prepare('DELETE FROM relationships WHERE id = ?').run('u2');
        tuple('u2', ['group', groupId, 'member'], 'blocked', ['document', 'doc-1']);
        expect(await resolved(service({ subjectGroups: groups([]) }), USER)).toEqual({
          allowed: false,
          resolved_via: 'unknown_membership',
        });
      }
      // A known member is excluded as before.
      expect((await resolved(service({ subjectGroups: groups([parent]) }), USER)).allowed).toBe(
        false
      );
    });

    it('trusts non-membership on the positive side (a userset there only grants)', async () => {
      const dynamicId = 'svc-1';
      await createGroup(fixture.adapter, TENANT, {
        id: dynamicId,
        groupKey: `dynamic:${dynamicId}`,
        displayName: 'Contractors',
        kind: 'dynamic',
      });
      tuple('u1', ['group', dynamicId, 'member'], 'viewer', ['document', 'doc-1']);
      expect(await resolved(service({ subjectGroups: groups([]) }), USER)).toEqual({
        allowed: false,
        resolved_via: 'direct',
      });
    });
  });

  describe('cache version', () => {
    it('serves an allow from the cache until a write bumps the tenant version', async () => {
      tuple('v', ['subject', USER], 'viewer', ['document', 'doc-1']);
      const versions = memoryKv();
      const cache = new ReBACCacheManager(undefined, 60);
      const rebac = () => service({ cache, versions });
      expect((await resolved(rebac(), USER)).allowed).toBe(true);
      expect((await resolved(rebac(), USER)).resolved_via).toBe('cache');

      definition('def', 'document', 'viewer', VIEWER_BUT_NOT_BLOCKED);
      tuple('b', ['subject', USER], 'blocked', ['document', 'doc-1']);
      // Without the bump the cached allow would still be served...
      expect((await resolved(rebac(), USER)).allowed).toBe(true);
      // ...the definition and tuple writes bump the version: the next check is computed afresh.
      await bumpReBACTenantVersion(versions, TENANT);
      expect(await resolved(rebac(), USER)).toEqual({ allowed: false, resolved_via: 'computed' });
    });

    it('does not cache an allow that relies on a tuple expiring within the TTL', async () => {
      const now = Math.floor(Date.now() / 1000);
      tuple('v', ['subject', USER], 'viewer', ['document', 'doc-1'], now + 30);
      tuple('w', ['subject', USER], 'viewer', ['document', 'doc-2'], now + 3600);
      const cache = cacheSpy();
      const rebac = service({ cache, versions: memoryKv() });
      expect((await resolved(rebac, USER)).allowed).toBe(true);
      expect(cache.set).not.toHaveBeenCalled();
      expect((await resolved(rebac, USER, 'doc-2')).allowed).toBe(true);
      expect(cache.set).toHaveBeenCalledTimes(1);
    });

    it('does not use a shared cache without a version store', async () => {
      tuple('v', ['subject', USER], 'viewer', ['document', 'doc-1']);
      const cache = cacheSpy();
      const rebac = new ReBACService(
        storage(fixture.adapter),
        { cache_namespace: memoryKv() },
        cache
      );
      expect((await resolved(rebac, USER)).allowed).toBe(true);
      expect(cache.get).not.toHaveBeenCalled();
      expect(cache.set).not.toHaveBeenCalled();
    });
  });

  describe('lists', () => {
    it('check closure candidates against live rows (stale and expired closure rows)', async () => {
      const now = Math.floor(Date.now() / 1000);
      tuple('live', ['subject', USER], 'viewer', ['document', 'doc-live']);
      tuple('gone', ['subject', USER], 'viewer', ['document', 'doc-expired'], now - 10);
      const closureRow = db.prepare(
        `INSERT INTO relationship_closure (id, tenant_id, ancestor_type, ancestor_id,
           descendant_type, descendant_id, relation, depth, path_json, effective_permission,
           created_at, updated_at)
         VALUES (?, ?, 'subject', ?, 'document', ?, 'viewer', ?, '[]', 'full', 0, 0)`
      );
      closureRow.run('c1', TENANT, USER, 'doc-live', 1);
      closureRow.run('c2', TENANT, USER, 'doc-multi-hop', 2); // written before migration 020
      closureRow.run('c3', TENANT, USER, 'doc-expired', 1);
      const rebac = service({ closure: new ClosureManager(storage(fixture.adapter), 5) });
      expect(
        (
          await rebac.listObjects({
            tenant_id: TENANT,
            user_id: USER,
            relation: 'viewer',
            object_type: 'document',
          })
        ).object_ids
      ).toEqual(['doc-live']);
      const users = await rebac.listUsers({
        tenant_id: TENANT,
        relation: 'viewer',
        object: 'document:doc-multi-hop',
      });
      expect(users.user_ids).toEqual([]);
    });

    it('never list from a closure row without a live direct tuple (a userset-only allow)', async () => {
      const group = 'grp-1';
      tuple('u', ['group', group, 'member'], 'viewer', ['document', 'doc-1']);
      db.prepare(
        `INSERT INTO relationship_closure (id, tenant_id, ancestor_type, ancestor_id,
           descendant_type, descendant_id, relation, depth, path_json, effective_permission,
           created_at, updated_at)
         VALUES ('stale', ?, 'subject', ?, 'document', 'doc-1', 'viewer', 1, '[]', 'full', 0, 0)`
      ).run(TENANT, USER);
      const rebac = service({
        subjectGroups: groups([group]),
        closure: new ClosureManager(storage(fixture.adapter), 5),
      });
      // The check allows (through the userset)...
      expect((await resolved(rebac, USER)).allowed).toBe(true);
      // ...but the stale closure row lists nothing.
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
    });

    it('take the direct tuples of the relations the definition names as candidates', async () => {
      definition('def', 'document', 'viewer', {
        type: 'union',
        children: [
          { type: 'direct', relation: 'viewer' },
          { type: 'direct', relation: 'editor' },
        ],
      });
      tuple('e', ['subject', USER], 'editor', ['document', 'doc-1']);
      tuple('v', ['subject', 'user-2'], 'viewer', ['document', 'doc-1']);
      tuple('o', ['subject', USER], 'owner', ['document', 'doc-2']);
      for (const closure of [undefined, new ClosureManager(storage(fixture.adapter), 5)]) {
        const rebac = service({ ...(closure && { closure }) });
        expect(
          (
            await rebac.listObjects({
              tenant_id: TENANT,
              user_id: USER,
              relation: 'viewer',
              object_type: 'document',
            })
          ).object_ids
        ).toEqual(['doc-1']);
        expect(
          (
            await rebac.listUsers({
              tenant_id: TENANT,
              relation: 'viewer',
              object: 'document:doc-1',
            })
          ).user_ids
        ).toEqual([USER, 'user-2']);
      }
    });

    it('flag usersets on the relations the definition names (viewer = direct(editor))', async () => {
      definition('def', 'document', 'viewer', { type: 'direct', relation: 'editor' });
      tuple('u', ['group', 'grp-1', 'member'], 'editor', ['document', 'doc-1']);
      const rebac = service({ subjectGroups: groups(['grp-1']) });
      expect((await resolved(rebac, USER)).allowed).toBe(true);
      expect(
        (
          await rebac.listObjects({
            tenant_id: TENANT,
            user_id: USER,
            relation: 'viewer',
            object_type: 'document',
          })
        ).userset_subjects_omitted
      ).toBe(true);
      expect(
        (await rebac.listUsers({ tenant_id: TENANT, relation: 'viewer', object: 'document:doc-1' }))
          .userset_subjects_omitted
      ).toBe(true);
    });

    it('flag the computed relations they do not enumerate', async () => {
      tuple('v', ['subject', USER], 'viewer', ['document', 'doc-1']);
      const rebac = service();
      const list = () =>
        rebac.listObjects({
          tenant_id: TENANT,
          user_id: USER,
          relation: 'viewer',
          object_type: 'document',
        });
      expect((await list()).computed_relations_omitted).toBe(false);
      definition('def', 'document', 'viewer', {
        type: 'union',
        children: [{ type: 'direct', relation: 'viewer' }, PARENT_VIEWER],
      });
      expect(await list()).toMatchObject({
        object_ids: ['doc-1'],
        computed_relations_omitted: true,
      });
      expect(
        (await rebac.listUsers({ tenant_id: TENANT, relation: 'viewer', object: 'document:doc-1' }))
          .computed_relations_omitted
      ).toBe(true);
    });
  });
});
