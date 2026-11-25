import { DatabaseSync } from 'node:sqlite';
import type { CloudflareD1QueryResult } from '@authrim/ar-lib-core/control-plane';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  TenantMigrationOwnershipRule,
  TenantMigrationTableInventory,
} from '../tenant-placement-migration-inventory';
import {
  applyTenantMigrationBackfillPage,
  applyTenantMigrationOutboxBatch,
  type TenantMigrationOutboxRecord,
  type TenantMigrationTransferExecutor,
} from '../tenant-placement-migration-transfer';

let database: DatabaseSync;
const requests: string[] = [];

/** Runs statements on SQLite after the same JSON round trip the D1 REST client applies. */
function executor(): TenantMigrationTransferExecutor {
  return {
    queryD1(_databaseId, sql, params = []) {
      const wire = JSON.parse(JSON.stringify({ sql, params })) as {
        sql: string;
        params: unknown[];
      };
      requests.push(JSON.stringify(wire));
      for (const value of wire.params) {
        if (value !== null && typeof value !== 'string' && typeof value !== 'number') {
          return Promise.reject(new Error('d1_rest_unsupported_param'));
        }
      }
      const statement = database.prepare(wire.sql);
      if (/^\s*(SELECT|WITH)/iu.test(wire.sql) && !/^\s*WITH[\s\S]*DELETE/iu.test(wire.sql)) {
        return Promise.resolve([
          { success: true, results: statement.all(...(wire.params as never[])) },
        ] as CloudflareD1QueryResult[]);
      }
      const result = statement.run(...(wire.params as never[]));
      return Promise.resolve([
        { success: true, results: [], meta: { changes: Number(result.changes) } },
      ] as CloudflareD1QueryResult[]);
    },
    queryD1Batch: () => Promise.reject(new Error('unused')),
  };
}

const column = (name: string) => ({ name }) as never;
const tenantColumn: TenantMigrationOwnershipRule = { kind: 'tenant_column', column: 'tenant_id' };
const items: TenantMigrationTableInventory = {
  table: 'items',
  columns: ['id', 'tenant_id', 'payload'].map(column),
  primaryKey: ['id'],
  ownership: tenantColumn,
  disposition: 'migrate',
};
const children: TenantMigrationTableInventory = {
  table: 'children',
  columns: ['id', 'event_id', 'note'].map(column),
  primaryKey: ['id'],
  ownership: {
    kind: 'parent',
    foreignKeyColumn: 'event_id',
    parentTable: 'events',
    parentKeyColumn: 'id',
    parentTenantColumn: 'tenant_id',
  },
  disposition: 'migrate',
} as unknown as TenantMigrationTableInventory;

beforeEach(() => {
  requests.length = 0;
  database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE items (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, payload BLOB);
    CREATE TABLE events (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL);
    CREATE TABLE children (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, note TEXT);
    INSERT INTO events VALUES ('e1', 'tenant-1'), ('e2', 'tenant-2');
  `);
});
afterEach(() => database.close());

const backfill = (
  table: TenantMigrationTableInventory,
  rows: Record<string, unknown>[],
  tenantId = 'tenant-1'
) =>
  applyTenantMigrationBackfillPage({
    executor: executor(),
    targetDatabaseId: 'target',
    table,
    tenantId,
    tenantKey: 'key-1',
    rows,
  });
const stored = (sql: string) => database.prepare(sql).all();

describe('backfill against real SQLite', () => {
  it('inserts new rows and re-applies the same tenant rows idempotently', async () => {
    await backfill(items, [{ id: 'a', tenant_id: 'tenant-1', payload: 'v1' }]);
    await backfill(items, [{ id: 'a', tenant_id: 'tenant-1', payload: 'v2' }]);
    expect(stored('SELECT id, tenant_id, payload FROM items')).toEqual([
      { id: 'a', tenant_id: 'tenant-1', payload: 'v2' },
    ]);
  });

  it('refuses to overwrite a row of another tenant and leaves it untouched', async () => {
    database.exec("INSERT INTO items VALUES ('a', 'tenant-2', 'secret')");
    await expect(
      backfill(items, [{ id: 'a', tenant_id: 'tenant-1', payload: 'stolen' }])
    ).rejects.toThrow(/^tenant_migration_backfill_owner_mismatch$/u);
    expect(stored('SELECT id, tenant_id, payload FROM items')).toEqual([
      { id: 'a', tenant_id: 'tenant-2', payload: 'secret' },
    ]);
  });

  it('stores blobs byte for byte through the JSON wire format', async () => {
    await backfill(items, [
      { id: 'a', tenant_id: 'tenant-1', payload: { $authrim_blob_hex: '00FF10' } },
      { id: 'b', tenant_id: 'tenant-1', payload: { $authrim_blob_hex: '' } },
    ]);
    const rows = stored('SELECT id, payload FROM items ORDER BY id') as {
      id: string;
      payload: Uint8Array;
    }[];
    expect(Array.from(rows[0]?.payload ?? [])).toEqual([0, 255, 16]);
    expect(Array.from(rows[1]?.payload ?? [1])).toEqual([]);
    expect(requests.every((request) => !request.includes('"0":'))).toBe(true);
  });

  it('guards child rows through the parent owner', async () => {
    await backfill(children, [{ id: 'c', event_id: 'e1', note: 'n1' }]);
    await backfill(children, [{ id: 'c', event_id: 'e1', note: 'n2' }]);
    expect(stored('SELECT note FROM children')).toEqual([{ note: 'n2' }]);
    database.exec("INSERT INTO children VALUES ('d', 'e2', 'foreign')");
    await expect(backfill(children, [{ id: 'd', event_id: 'e1', note: 'stolen' }])).rejects.toThrow(
      /^tenant_migration_backfill_owner_mismatch$/u
    );
    expect(stored("SELECT note, event_id FROM children WHERE id = 'd'")).toEqual([
      { note: 'foreign', event_id: 'e2' },
    ]);
  });
});

describe('outbox against real SQLite', () => {
  const record = (
    id: string,
    row: Record<string, unknown>,
    sequence = 1
  ): TenantMigrationOutboxRecord => ({
    sourceSequence: sequence,
    operationId: 'op-1',
    tenantId: 'tenant-1',
    tableName: 'items',
    mutationKind: 'upsert',
    mutationKey: { id },
    row,
    captureFencingToken: 4,
  });
  const apply = (records: TenantMigrationOutboxRecord[]) => {
    database.exec(
      'CREATE TABLE IF NOT EXISTS tenant_placement_migration_outbox (operation_id, tenant_id, capture_fencing_token, delivery_state, applied_at, source_sequence)'
    );
    return applyTenantMigrationOutboxBatch({
      executor: executor(),
      sourceDatabaseId: 'source',
      targetDatabaseId: 'target',
      operationId: 'op-1',
      tenantId: 'tenant-1',
      tenantKey: 'key-1',
      fencingToken: 4,
      inventory: [items],
      records,
      now: 1,
    });
  };

  it('applies same tenant upserts and refuses foreign rows without changing them', async () => {
    await apply([record('a', { id: 'a', tenant_id: 'tenant-1', payload: 'v1' })]);
    await apply([record('a', { id: 'a', tenant_id: 'tenant-1', payload: 'v2' })]);
    expect(stored('SELECT payload FROM items')).toEqual([{ payload: 'v2' }]);
    database.exec("INSERT INTO items VALUES ('f', 'tenant-2', 'secret')");
    await expect(
      apply([record('f', { id: 'f', tenant_id: 'tenant-1', payload: 'stolen' })])
    ).rejects.toThrow(/^tenant_migration_outbox_owner_mismatch$/u);
    expect(stored("SELECT tenant_id, payload FROM items WHERE id = 'f'")).toEqual([
      { tenant_id: 'tenant-2', payload: 'secret' },
    ]);
  });

  it('writes blobs byte for byte', async () => {
    await apply([
      record('a', { id: 'a', tenant_id: 'tenant-1', payload: { $authrim_blob_hex: 'DEADBEEF' } }),
    ]);
    const [row] = stored('SELECT payload FROM items') as { payload: Uint8Array }[];
    expect(Array.from(row?.payload ?? [])).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });
});
