/**
 * The resource registry of self-contract checks (core migration 021): request grammar, the
 * stored resolver, and self-contract checks resolved from it on real SQL.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import { ReBACService } from '../../rebac/rebac-service';
import type { IStorageAdapter } from '../../storage/interfaces';
import { createUnifiedCheckService, parsePermission } from '../unified-check-service';
import { createGroup } from '../group-catalog';
import { upsertGroupMembership } from '../group-membership';
import type { IReBACCacheManager } from '../../rebac/interfaces';
import {
  CHECK_RESOURCE_ATTRIBUTES_MAX_BYTES,
  checkResourceUpsertStatement,
  isCheckResourceId,
  isCheckResourceName,
  isCheckSubjectRefId,
  parseCheckResourceFacts,
  parseCheckResourceRelations,
  StoredResourceContextResolver,
} from '../check-resource-registry';
import type {
  CheckApiRequest,
  PolicyEvaluationContext,
  TenantPolicySettings,
} from '../../types/check-api';

const TENANT = 'tenant-a';
const USER = 'user-1';

describe('registry grammar', () => {
  it.each([
    ['documents', true],
    ['doc_type2', true],
    ['a'.repeat(64), true],
    ['a'.repeat(65), false],
    ['Documents', false],
    ['1docs', false],
    ['doc-s', false],
    ['doc:s', false],
    ['', false],
  ])('name %s -> %s', (value, valid) => {
    expect(isCheckResourceName(value)).toBe(valid);
  });

  it.each([
    ['doc_1', true],
    ['DOC-1_v2', true],
    ['x'.repeat(256), true],
    ['x'.repeat(257), false],
    ['\u{20bb7}'.repeat(256), true],
    ['\u{20bb7}'.repeat(257), false],
    ['.', false],
    ['..', false],
    ['.hidden', true],
    ['DOC-1.v2', true],
    ['', false],
    ['has space', false],
    ['a:b', false],
    ['caf\u00e9', true],
    ['tab\there', false],
    ['nul\u0000', false],
    [1, false],
  ])('resource id %s -> %s (the permission parser agrees)', (value, valid) => {
    expect(isCheckResourceId(value)).toBe(valid);
    // `.` and `..` are the one place the registry is stricter than the parser (URL path segments).
    if (typeof value === 'string' && value.length <= 256 && value !== '.' && value !== '..') {
      const parses = (() => {
        try {
          parsePermission({ resource: 'documents', id: value, action: 'read' });
          return value !== '';
        } catch {
          return false;
        }
      })();
      expect(parses).toBe(valid);
    }
  });

  it.each([
    ['user-1', true],
    ['user.1@example', true],
    ['', false],
    ['a b', false],
    ['a:b', false],
  ])('owner / group id %s -> %s (their own grammar)', (value, valid) => {
    expect(isCheckSubjectRefId(value)).toBe(valid);
  });

  it('parses the facts of a resource (absent and null are none)', () => {
    expect(parseCheckResourceFacts({})).toEqual({
      ok: true,
      value: { owner_id: null, group_id: null, attributes: null },
    });
    expect(
      parseCheckResourceFacts({ owner_id: 'u1', group_id: null, attributes: { level: 2 } })
    ).toEqual({ ok: true, value: { owner_id: 'u1', group_id: null, attributes: { level: 2 } } });
  });

  it.each([
    [[], 'body'],
    [{ owner: 'u1' }, 'owner'],
    [{ owner_id: '' }, 'owner_id'],
    [{ owner_id: 'a b' }, 'owner_id'],
    [{ group_id: 7 }, 'group_id'],
    [{ attributes: [1] }, 'attributes'],
    [{ attributes: 'x' }, 'attributes'],
    [{ attributes: { big: 'x'.repeat(CHECK_RESOURCE_ATTRIBUTES_MAX_BYTES) } }, 'attributes'],
  ])('refuses facts %j (field %s)', (input, field) => {
    expect(parseCheckResourceFacts(input)).toEqual({ ok: false, field });
  });

  it('counts the attribute limit in UTF-8 bytes of the JSON', () => {
    // 3 bytes per character: 2,700 characters is 8,100 bytes plus the JSON around it.
    expect(parseCheckResourceFacts({ attributes: { k: 'あ'.repeat(2700) } }).ok).toBe(true);
    expect(parseCheckResourceFacts({ attributes: { k: 'あ'.repeat(2731) } }).ok).toBe(false);
  });

  it('parses an action-to-relation map', () => {
    expect(parseCheckResourceRelations({ read: 'viewer', write: 'editor' })).toEqual({
      ok: true,
      value: { read: 'viewer', write: 'editor' },
    });
    expect(parseCheckResourceRelations({})).toEqual({ ok: true, value: {} });
    expect(parseCheckResourceRelations({ Read: 'viewer' }).ok).toBe(false);
    expect(parseCheckResourceRelations({ read: 'Viewer' }).ok).toBe(false);
    expect(parseCheckResourceRelations(['viewer']).ok).toBe(false);
    expect(parseCheckResourceRelations(null).ok).toBe(false);
  });
});

describe('StoredResourceContextResolver', () => {
  let fixture: ReturnType<typeof sqliteAdapter>;
  let db: DatabaseSync;
  let resolver: StoredResourceContextResolver;

  function type(relations: Record<string, string>, tenant = TENANT, name = 'documents') {
    db.prepare(
      `INSERT INTO check_resource_types (tenant_id, resource_type, relations_json, row_token, created_at, updated_at)
       VALUES (?, ?, ?, 'token-1', 1, 1)`
    ).run(tenant, name, JSON.stringify(relations));
  }

  async function resource(
    id: string,
    facts: Partial<{ owner_id: string; group_id: string; attributes: Record<string, unknown> }>,
    tenant = TENANT
  ) {
    const statement = checkResourceUpsertStatement(
      tenant,
      'documents',
      id,
      { owner_id: null, group_id: null, attributes: null, ...facts },
      1
    );
    await fixture.adapter.execute(statement.sql, statement.params);
  }

  const lookup = (overrides: Record<string, unknown> = {}) => ({
    tenantId: TENANT,
    resourceType: 'documents',
    resourceId: 'doc_1',
    action: 'read',
    subjectId: USER,
    ...overrides,
  });

  beforeEach(() => {
    fixture = sqliteAdapter('core');
    db = fixture.db;
    resolver = new StoredResourceContextResolver(fixture.adapter);
  });
  afterEach(() => db.close());

  it('knows nothing without a type setting or a registered resource', async () => {
    expect(await resolver.resolve(lookup())).toBeNull();
  });

  it('returns the facts as stored, and the relation of a mapped action', async () => {
    type({ read: 'viewer', write: 'editor' });
    await resource('doc_1', {
      owner_id: 'user-9',
      group_id: 'group-1',
      attributes: { classification: 'internal' },
    });
    expect(await resolver.resolve(lookup())).toEqual({
      owner_id: 'user-9',
      group_id: 'group-1',
      attributes: { classification: 'internal' },
      rebac: { relation: 'viewer', object_type: 'documents', object_id: 'doc_1' },
    });
    expect((await resolver.resolve(lookup({ action: 'write' })))?.rebac?.relation).toBe('editor');
    expect(await resolver.resolve(lookup({ action: 'delete' }))).toEqual({
      owner_id: 'user-9',
      group_id: 'group-1',
      attributes: { classification: 'internal' },
    });
  });

  it('returns only the relation when only the type is set', async () => {
    type({ read: 'viewer' });
    expect(await resolver.resolve(lookup())).toEqual({
      rebac: { relation: 'viewer', object_type: 'documents', object_id: 'doc_1' },
    });
    expect(await resolver.resolve(lookup({ action: 'write' }))).toBeNull();
  });

  it('resolves nothing for a type-level permission (no resource, no object)', async () => {
    type({ read: 'viewer' });
    await resource('doc_1', { owner_id: USER });
    expect(await resolver.resolve(lookup({ resourceId: undefined }))).toBeNull();
  });

  it('does not answer with the registry of another tenant, and replaces a resource whole', async () => {
    type({ read: 'viewer' }, 'tenant-b');
    await resource('doc_1', { owner_id: USER }, 'tenant-b');
    expect(await resolver.resolve(lookup())).toBeNull();

    await resource('doc_1', { owner_id: USER, attributes: { a: 1 } });
    await resource('doc_1', { group_id: 'group-2' });
    expect(await resolver.resolve(lookup())).toEqual({ group_id: 'group-2' });
  });

  it('ignores an inherited key as an action (no relation from the prototype)', async () => {
    type({ read: 'viewer' });
    expect(await resolver.resolve(lookup({ action: 'constructor' }))).toBeNull();
    expect(await resolver.resolve(lookup({ action: 'toString' }))).toBeNull();
  });

  it('throws on a stored attribute value that is not an object (the check then has none)', async () => {
    db.prepare(
      `INSERT INTO check_resources (tenant_id, resource_type, resource_id, attributes_json, updated_at)
       VALUES (?, 'documents', 'doc_1', '[1]', 1)`
    ).run(TENANT);
    await expect(resolver.resolve(lookup())).rejects.toThrow();
  });
});

describe('self-contract checks resolved from the registry (real SQL)', () => {
  let fixture: ReturnType<typeof sqliteAdapter>;
  let db: DatabaseSync;
  const REQUEST: CheckApiRequest = {
    subject_id: USER,
    permission: 'documents:doc_1:read',
    tenant_id: TENANT,
  };

  const storage = (): IStorageAdapter => ({
    get: async () => null,
    set: async () => {},
    delete: async () => {},
    query: <T = unknown>(sql: string, params?: unknown[]) => fixture.adapter.query<T>(sql, params),
    execute: async (sql: string, params?: unknown[]) => {
      const result = await fixture.adapter.execute(sql, params);
      return { success: result.success, meta: { changes: result.rowsAffected, last_row_id: 0 } };
    },
  });

  function service(policy: Partial<TenantPolicySettings>, cache?: IReBACCacheManager) {
    return createUnifiedCheckService({
      db: fixture.adapter,
      subjectAccount: async (_tenant, subjectId) => ({ db: fixture.adapter, subjectId }),
      rebacService: new ReBACService(storage(), undefined, cache),
      tenantPolicy: async () => ({
        abac: false,
        verifiedAttributes: false,
        rebac: false,
        logDecisions: false,
        ...policy,
      }),
      resourceContextResolver: new StoredResourceContextResolver(fixture.adapter),
    });
  }

  async function owned(owner: string) {
    const statement = checkResourceUpsertStatement(
      TENANT,
      'documents',
      'doc_1',
      { owner_id: owner, group_id: null, attributes: { classification: 'internal' } },
      1
    );
    await fixture.adapter.execute(statement.sql, statement.params);
  }

  beforeEach(() => {
    fixture = sqliteAdapter('core');
    db = fixture.db;
  });
  afterEach(() => db.close());

  it('never grants on a registered owner alone (no owner shortcut in the self contract)', async () => {
    await owned(USER);
    expect((await service({}).check(REQUEST, { contract: 'self' })).allowed).toBe(false);
    // The server contract keeps its shortcut for an owner the server passes itself.
    expect(
      (await service({}).check({ ...REQUEST, resource_context: { owner_id: USER } })).allowed
    ).toBe(true);
  });

  it('gives the tenant rules the registered owner and attributes', async () => {
    await owned(USER);
    const seen: PolicyEvaluationContext[] = [];
    const evaluator = {
      evaluate: (context: PolicyEvaluationContext) => {
        seen.push(context);
        return {
          allowed:
            context.resourceOwnerId === context.subjectId &&
            context.resourceAttributes?.classification === 'internal' &&
            context.action === 'read',
          decidedBy: 'owners_read_internal',
        };
      },
    };
    const checks = service({ abac: true, evaluator });
    expect(await checks.check(REQUEST, { contract: 'self' })).toMatchObject({
      allowed: true,
      resolved_via: ['computed'],
    });
    expect(
      (
        await checks.check(
          { ...REQUEST, permission: 'documents:doc_1:delete' },
          { contract: 'self' }
        )
      ).allowed
    ).toBe(false);
    await owned('someone-else');
    expect((await checks.check(REQUEST, { contract: 'self' })).allowed).toBe(false);
    expect(seen[0]).toMatchObject({ resourceType: 'documents', resourceId: 'doc_1' });
  });

  describe('the relation a stored mapping names, through the full ReBAC service', () => {
    function mapRead(relation = 'viewer') {
      db.prepare(
        `INSERT INTO check_resource_types (tenant_id, resource_type, relations_json, row_token, created_at, updated_at)
         VALUES (?, 'documents', ?, 'token-1', 1, 1)`
      ).run(TENANT, JSON.stringify({ read: relation }));
    }
    function tuple(id: string, from: [string, string, string?], relation: string) {
      db.prepare(
        `INSERT INTO relationships (id, tenant_id, relationship_type, from_type, from_id,
           from_relation, to_type, to_id, permission_level, expires_at, is_bidirectional,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'documents', 'doc_1', 'full', NULL, 0, 0, 0)`
      ).run(id, TENANT, relation, from[0], from[1], from[2] ?? null);
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
    const self = (cache?: IReBACCacheManager) =>
      service({ rebac: true }, cache).check(REQUEST, { contract: 'self' });

    it('allows through a direct tuple', async () => {
      mapRead();
      tuple('d1', ['subject', USER], 'viewer');
      expect(await self()).toMatchObject({ allowed: true, resolved_via: ['rebac'] });
    });

    it('allows through a group userset the subject is a member of', async () => {
      mapRead();
      const group = await createGroup(fixture.adapter, TENANT, {
        groupKey: 'readers',
        displayName: 'Readers',
      });
      tuple('u1', ['group', group, 'member'], 'viewer');
      expect((await self()).allowed).toBe(false);
      await upsertGroupMembership(
        { metadata: fixture.adapter, account: fixture.adapter },
        TENANT,
        USER,
        { groupId: group, source: 'manual' }
      );
      expect(await self()).toMatchObject({ allowed: true, resolved_via: ['rebac'] });
    });

    it('denies through an exclusion in the relation definition', async () => {
      mapRead();
      tuple('d1', ['subject', USER], 'viewer');
      db.prepare(
        `INSERT INTO relation_definitions (id, tenant_id, object_type, relation_name,
           definition_json, priority, is_active, created_at, updated_at)
         VALUES ('def', ?, 'documents', 'viewer', ?, 0, 1, 0, 0)`
      ).run(
        TENANT,
        JSON.stringify({
          type: 'exclusion',
          base: { type: 'direct', relation: 'viewer' },
          subtract: { type: 'direct', relation: 'blocked' },
        })
      );
      expect((await self()).allowed).toBe(true);
      tuple('d2', ['subject', USER], 'blocked');
      expect((await self()).allowed).toBe(false);
    });

    it('denies an unknown membership, uncached', async () => {
      mapRead();
      const group = await createGroup(fixture.adapter, TENANT, {
        groupKey: 'computed',
        displayName: 'Computed',
      });
      tuple('u1', ['group', group, 'member'], 'viewer');
      // A dynamic membership with no publication record: its group is unknown, neither member
      // nor not.
      db.prepare(
        `INSERT INTO group_memberships (id, tenant_id, group_id, subject_id, assignment_source,
           source_ref, lifecycle_state, expires_at, created_at, updated_at)
         VALUES ('m1', ?, ?, ?, 'dynamic', 'dyn:1', 'active', NULL, 0, 0)`
      ).run(TENANT, group, USER);
      const cache = cacheSpy();
      expect(await self(cache)).toMatchObject({
        allowed: false,
        reason: 'unknown_membership',
      });
      expect(cache.set).not.toHaveBeenCalled();
    });
  });

  it('grants nothing from the tenant rules when the resolver fails (fail closed)', async () => {
    db.prepare(
      `INSERT INTO check_resources (tenant_id, resource_type, resource_id, attributes_json, updated_at)
       VALUES (?, 'documents', 'doc_1', '[1]', 1)`
    ).run(TENANT);
    const evaluate = vi.fn(() => ({ allowed: true, decidedBy: 'allow_everything' }));
    const result = await service({ abac: true, evaluator: { evaluate } }).check(REQUEST, {
      contract: 'self',
    });
    expect(result.allowed).toBe(false);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('checks the relation the type maps the action to, while the tenant enables ReBAC', async () => {
    db.prepare(
      `INSERT INTO check_resource_types (tenant_id, resource_type, relations_json, row_token, created_at, updated_at)
       VALUES (?, 'documents', '{"read":"viewer"}', 'token-1', 1, 1)`
    ).run(TENANT);
    db.prepare(
      `INSERT INTO relationships (id, tenant_id, relationship_type, from_type, from_id,
         from_relation, to_type, to_id, permission_level, expires_at, is_bidirectional,
         created_at, updated_at)
       VALUES ('t1', ?, 'viewer', 'subject', ?, NULL, 'documents', 'doc_1', 'full', NULL, 0, 0, 0)`
    ).run(TENANT, USER);

    expect(await service({ rebac: true }).check(REQUEST, { contract: 'self' })).toMatchObject({
      allowed: true,
      resolved_via: ['rebac'],
    });
    // An action the type does not map, ReBAC off, another resource: no relation, no allow.
    expect(
      (
        await service({ rebac: true }).check(
          { ...REQUEST, permission: 'documents:doc_1:write' },
          { contract: 'self' }
        )
      ).allowed
    ).toBe(false);
    expect((await service({}).check(REQUEST, { contract: 'self' })).allowed).toBe(false);
    expect(
      (
        await service({ rebac: true }).check(
          { ...REQUEST, permission: 'documents:doc_2:read' },
          { contract: 'self' }
        )
      ).allowed
    ).toBe(false);
  });
});
