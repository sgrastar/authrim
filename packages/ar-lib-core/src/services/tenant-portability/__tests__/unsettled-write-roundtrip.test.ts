import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../../db/adapter';
import { SavedGroupInputReader } from '../../dynamic-groups/inputs';
import { withGroupInputWrite } from '../../dynamic-groups/write-boundary';
import { inventoryBackupSchemas } from '../../../../../../scripts/tenant-backup/schema-inventory';
import { TENANT_DATASET_POLICIES } from '../dataset-registry';
import { sqliteSnapshotStartStatement } from '../sqlite-capture-plan';
import { sqliteSnapshotRowInsert } from '../sqlite-row-codec';
import {
  SQLITE_SNAPSHOT_SCHEMA,
  sqliteSnapshotPageQuery,
  sqliteSnapshotTriggers,
} from '../sqlite-snapshot';

function adapter(db: DatabaseSync): DatabaseAdapter {
  // The production paths exercised here need only these primary-local operations. Deliberately
  // do not model cross-database writes as one rollback-capable transaction.
  return {
    async execute(sql: string, params: unknown[] = []) {
      const result = db.prepare(sql).run(...(params as SQLInputValue[]));
      return { success: true, rowsAffected: Number(result.changes) };
    },
    async query<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (db.prepare(sql).get(...(params as SQLInputValue[])) ?? null) as T | null;
    },
  } as DatabaseAdapter;
}

describe('unsettled cross-database user writes in backup', () => {
  it('preserves the failed-write fence through a user-only roundtrip with logs off', async () => {
    const inventory = inventoryBackupSchemas(
      fileURLToPath(new URL('../../../../../../', import.meta.url))
    );
    const stores = [
      new DatabaseSync(':memory:'),
      new DatabaseSync(':memory:'),
      new DatabaseSync(':memory:'),
      new DatabaseSync(':memory:'),
    ];
    const [core, pii, restoredCore, restoredPii] = stores;
    const schema = {
      table: 'service_group_write_boundaries',
      tenantColumn: 'tenant_id',
      columns: ['id', 'tenant_id', 'user_id', 'operation', 'status', 'created_at'],
      primaryKey: ['id'],
      uniqueKeys: [],
    };
    try {
      for (const [index, family] of ['core', 'pii'].entries()) {
        const table = inventory.inspectedStreams
          .find((stream) => stream.id === `${family}-d1`)
          ?.tables.find((table) => table.name === schema.table);
        expect(table).toBeDefined();
        for (const db of [stores[index], stores[index + 2]]) {
          db.exec(`${table?.sql}; CREATE TABLE fixture_values (
            tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, value TEXT NOT NULL,
            PRIMARY KEY (tenant_id, user_id));`);
        }
      }
      core.exec("INSERT INTO fixture_values VALUES ('a','u','before')");
      pii.exec("INSERT INTO fixture_values VALUES ('a','u','before')");
      await expect(
        withGroupInputWrite(adapter(core), 'a', 'u', 'profile_update', async () => {
          await adapter(core).execute(
            "UPDATE fixture_values SET value = 'after' WHERE tenant_id='a' AND user_id='u'"
          );
          throw new Error('injected_pii_write_failure');
        })
      ).rejects.toThrow('injected_pii_write_failure');
      expect(core.prepare('SELECT value FROM fixture_values').get()?.value).toBe('after');
      expect(pii.prepare('SELECT value FROM fixture_values').get()?.value).toBe('before');
      const before = new SavedGroupInputReader(
        adapter(core),
        adapter(core),
        adapter(pii),
        'a',
        'u'
      );
      await expect(before.version()).rejects.toThrow('group_input_write_unsettled');

      // Add an unrelated tenant's guard to prove the backup must not copy it by table ownership.
      core.exec(
        "INSERT INTO service_group_write_boundaries VALUES ('foreign','b','u','update','failed',1)"
      );
      for (const [index, family] of ['core', 'pii'].entries()) {
        const source = stores[index];
        const target = stores[index + 2];
        const valuesSchema = {
          table: 'fixture_values',
          tenantColumn: 'tenant_id',
          columns: ['tenant_id', 'user_id', 'value'],
          primaryKey: ['tenant_id', 'user_id'],
          uniqueKeys: [],
        };
        source.exec(
          `${SQLITE_SNAPSHOT_SCHEMA} ${sqliteSnapshotTriggers(schema)} ${sqliteSnapshotTriggers(valuesSchema)}`
        );
        const start = sqliteSnapshotStartStatement([schema, valuesSchema], 'capture', 'a');
        expect(source.prepare(start.sql).run(...start.params).changes).toBe(1);
        for (const row of source
          .prepare(sqliteSnapshotPageQuery(valuesSchema, 'json'))
          .all('capture', 'a', '', 100)) {
          const insert = sqliteSnapshotRowInsert(
            valuesSchema.table,
            valuesSchema.columns,
            String(row.row_json)
          );
          target.prepare(insert.sql).run(...insert.params);
        }
        // The selection is deliberately users-only. Reclassifying the fence as a rebuildable
        // cache or optional log would drop it and make this regression fail.
        const selected = TENANT_DATASET_POLICIES.some(
          (policy) =>
            policy.family === family && policy.table === schema.table && policy.kind === 'users'
        );
        if (selected) {
          for (const record of source
            .prepare(sqliteSnapshotPageQuery(schema, 'json'))
            .all('capture', 'a', '', 100)) {
            const insert = sqliteSnapshotRowInsert(
              schema.table,
              schema.columns,
              String(record.row_json)
            );
            target.prepare(insert.sql).run(...insert.params);
          }
        }
      }
      const after = new SavedGroupInputReader(
        adapter(restoredCore),
        adapter(restoredCore),
        adapter(restoredPii),
        'a',
        'u'
      );
      const boundaries = await after.unsettledWrites();
      expect(restoredCore.prepare('SELECT value FROM fixture_values').get()?.value).toBe('after');
      expect(restoredPii.prepare('SELECT value FROM fixture_values').get()?.value).toBe('before');
      expect(boundaries).toHaveLength(1);
      expect(boundaries[0]).toMatchObject({ operation: 'profile_update', status: 'failed' });
      await expect(after.version()).rejects.toThrow('group_input_write_unsettled');
      expect(
        restoredCore
          .prepare("SELECT COUNT(*) AS n FROM service_group_write_boundaries WHERE tenant_id='b'")
          .get()?.n
      ).toBe(0);
    } finally {
      for (const db of stores) db.close();
    }
  });
});
