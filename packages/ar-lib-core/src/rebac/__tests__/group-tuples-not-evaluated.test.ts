/**
 * Group userset tuples (`from_type = 'group'`) are stored but not evaluated until ReBAC usersets
 * are: saving one changes no check or list result (real SQL on the D1 schema).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import { createReBACService } from '../rebac-service';
import type { IStorageAdapter } from '../../storage/interfaces';

const TENANT = 'tenant-a';

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

function tuple(
  db: DatabaseSync,
  id: string,
  from: [string, string],
  relation: string,
  to: [string, string]
) {
  db.prepare(
    `INSERT INTO relationships (id, tenant_id, relationship_type, from_type, from_id, to_type, to_id,
       permission_level, expires_at, is_bidirectional, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'full', NULL, 0, 0, 0)`
  ).run(id, TENANT, relation, from[0], from[1], to[0], to[1]);
}

describe('group userset tuples', () => {
  let db: DatabaseSync;
  let service: ReturnType<typeof createReBACService>;

  beforeEach(() => {
    const fixture = sqliteAdapter('core');
    db = fixture.db;
    service = createReBACService(storage(fixture.adapter), { max_depth: 5 });
    db.prepare(
      `INSERT INTO relation_definitions (id, tenant_id, object_type, relation_name, definition_json,
         priority, is_active, created_at, updated_at)
       VALUES ('def-1', ?, 'document', 'viewer', ?, 0, 1, 0, 0)`
    ).run(TENANT, JSON.stringify({ type: 'direct', relation: 'viewer' }));
    // The subject is a member of the group (as a tuple, the way a userset would be written).
    tuple(db, 't-member', ['subject', 'user-1'], 'member', ['group', 'grp-1']);
  });

  async function results() {
    return {
      check: (
        await service.check({
          tenant_id: TENANT,
          user_id: 'user-1',
          relation: 'viewer',
          object: 'document:doc-1',
        })
      ).allowed,
      objects: (
        await service.listObjects({
          tenant_id: TENANT,
          user_id: 'user-1',
          relation: 'viewer',
          object_type: 'document',
        })
      ).object_ids,
      users: (
        await service.listUsers({
          tenant_id: TENANT,
          relation: 'viewer',
          object: 'document:doc-1',
        })
      ).user_ids,
    };
  }

  it('saving a group tuple changes no check or list result', async () => {
    const before = await results();
    tuple(db, 't-group', ['group', 'grp-1'], 'viewer', ['document', 'doc-1']);
    expect(await results()).toEqual(before);
    expect(before).toEqual({ check: false, objects: [], users: [] });
  });

  it('a direct subject tuple still grants', async () => {
    tuple(db, 't-direct', ['subject', 'user-1'], 'viewer', ['document', 'doc-1']);
    expect((await results()).check).toBe(true);
  });
});
