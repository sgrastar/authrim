/**
 * The Check API's self contract asks ReBACService for the relation and object its resolver names
 * (real SQL): group usersets, definitions and exclusion apply, and a membership the role check
 * could not read leaves a userset undecided.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import { ReBACService } from '../rebac-service';
import type { IStorageAdapter } from '../../storage/interfaces';
import { createUnifiedCheckService } from '../../services/unified-check-service';
import { createGroup } from '../../services/group-catalog';
import { upsertGroupMembership } from '../../services/group-membership';
import type { CheckApiRequest, TenantPolicySettings } from '../../types/check-api';

const TENANT = 'tenant-a';
const USER = 'user-1';
const REQUEST: CheckApiRequest = {
  subject_id: USER,
  permission: 'documents:doc-1:read',
  tenant_id: TENANT,
};
const POLICY: TenantPolicySettings = {
  abac: false,
  verifiedAttributes: false,
  rebac: true,
  logDecisions: false,
};

describe('self contract ReBAC on real SQL', () => {
  let fixture: ReturnType<typeof sqliteAdapter>;
  let db: DatabaseSync;

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

  function tuple(id: string, from: [string, string, string?], relation: string) {
    db.prepare(
      `INSERT INTO relationships (id, tenant_id, relationship_type, from_type, from_id,
         from_relation, to_type, to_id, permission_level, expires_at, is_bidirectional,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'document', 'doc-1', 'full', NULL, 0, 0, 0)`
    ).run(id, TENANT, relation, from[0], from[1], from[2] ?? null);
  }

  function checkService(accountReadable = true) {
    return createUnifiedCheckService({
      db: fixture.adapter,
      subjectAccount: async (_tenant, subjectId) => {
        if (!accountReadable) throw new Error('account database unavailable');
        return { db: fixture.adapter, subjectId };
      },
      rebacService: new ReBACService(storage()),
      tenantPolicy: async () => POLICY,
      resourceContextResolver: {
        resolve: async () => ({
          rebac: { relation: 'viewer', object_type: 'document', object_id: 'doc-1' },
        }),
      },
    });
  }

  beforeEach(() => {
    fixture = sqliteAdapter('core');
    db = fixture.db;
  });
  afterEach(() => db.close());

  it('allows a member of a group with a userset on the object', async () => {
    const group = await createGroup(fixture.adapter, TENANT, {
      groupKey: 'readers',
      displayName: 'Readers',
    });
    tuple('u1', ['group', group, 'member'], 'viewer');
    const deniedFirst = await checkService().check(REQUEST, { contract: 'self' });
    expect(deniedFirst.allowed).toBe(false);

    await upsertGroupMembership(
      { metadata: fixture.adapter, account: fixture.adapter },
      TENANT,
      USER,
      {
        groupId: group,
        source: 'manual',
      }
    );
    expect(await checkService().check(REQUEST, { contract: 'self' })).toMatchObject({
      allowed: true,
      resolved_via: ['rebac'],
    });
  });

  it('leaves a userset undecided when the memberships cannot be read', async () => {
    const group = await createGroup(fixture.adapter, TENANT, {
      groupKey: 'readers',
      displayName: 'Readers',
    });
    tuple('u1', ['group', group, 'member'], 'viewer');
    await upsertGroupMembership(
      { metadata: fixture.adapter, account: fixture.adapter },
      TENANT,
      USER,
      {
        groupId: group,
        source: 'manual',
      }
    );
    expect((await checkService(false).check(REQUEST, { contract: 'self' })).allowed).toBe(false);
  });

  it('checks the resolved subject id verbatim (a `:` in it is not a type prefix)', async () => {
    tuple('d1', ['subject', 'team:alice'], 'viewer');
    const as = (subjectId: string) =>
      checkService().check({ ...REQUEST, subject_id: subjectId }, { contract: 'self' });
    expect((await as('team:alice')).allowed).toBe(true);
    db.prepare('DELETE FROM relationships').run();
    tuple('d2', ['subject', 'alice'], 'viewer');
    expect((await as('team:alice')).allowed).toBe(false);
    expect((await as('alice')).allowed).toBe(true);
  });

  it('denies before ReBAC when the subject account cannot be resolved', async () => {
    // A tuple naming the raw request id must not grant: the check stops at the resolver.
    tuple('d1', ['subject', USER], 'viewer');
    expect(await checkService(false).check(REQUEST, { contract: 'self' })).toMatchObject({
      allowed: false,
      reason: 'no_matching_permission',
    });
    expect((await checkService().check(REQUEST, { contract: 'self' })).allowed).toBe(true);
  });

  it('applies the relation definition, exclusion included, to a direct tuple', async () => {
    tuple('d1', ['subject', USER], 'viewer');
    expect((await checkService().check(REQUEST, { contract: 'self' })).allowed).toBe(true);
    db.prepare(
      `INSERT INTO relation_definitions (id, tenant_id, object_type, relation_name,
         definition_json, priority, is_active, created_at, updated_at)
       VALUES ('def', ?, 'document', 'viewer', ?, 0, 1, 0, 0)`
    ).run(
      TENANT,
      JSON.stringify({
        type: 'exclusion',
        base: { type: 'direct', relation: 'viewer' },
        subtract: { type: 'direct', relation: 'blocked' },
      })
    );
    tuple('d2', ['subject', USER], 'blocked');
    expect((await checkService().check(REQUEST, { contract: 'self' })).allowed).toBe(false);
  });
});
