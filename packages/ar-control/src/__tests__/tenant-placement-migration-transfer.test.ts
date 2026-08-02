import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CloudflareD1QueryResult } from '@authrim/ar-lib-core/control-plane';
import {
  applyTenantMigrationBackfillPage,
  applyTenantMigrationOutboxBatch,
  buildTenantMigrationPurgeQuery,
  readTenantMigrationBackfillPage,
  readTenantMigrationOutboxBatch,
  type TenantMigrationTransferExecutor,
} from '../tenant-placement-migration-transfer';
import type { TenantMigrationTableInventory } from '../tenant-placement-migration-inventory';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

type SqlValue = string | number | bigint | null | Uint8Array;

function values(input: readonly unknown[] | undefined): SqlValue[] {
  return (input ?? []).map((value) => {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    throw new Error('unsupported_test_sql_value');
  });
}

class SqliteTransferExecutor implements TenantMigrationTransferExecutor {
  constructor(private readonly databases: ReadonlyMap<string, DatabaseSync>) {}

  async queryD1(
    databaseId: string,
    sql: string,
    params?: unknown[]
  ): Promise<CloudflareD1QueryResult[]> {
    const database = this.databases.get(databaseId);
    if (!database) throw new Error('test_database_missing');
    const statement = database.prepare(sql);
    if (/^\s*(?:SELECT|PRAGMA)\b/iu.test(sql)) {
      return [{ success: true, results: statement.all(...values(params)) }];
    }
    const result = statement.run(...values(params));
    return [{ success: true, results: [], meta: { changes: Number(result.changes) } }];
  }

  async queryD1Batch(
    databaseId: string,
    batch: readonly { sql: string; params?: unknown[] }[]
  ): Promise<CloudflareD1QueryResult[]> {
    const results: CloudflareD1QueryResult[] = [];
    for (const query of batch)
      results.push(...(await this.queryD1(databaseId, query.sql, query.params)));
    return results;
  }
}

const usersInventory: TenantMigrationTableInventory = {
  table: 'users',
  columns: [
    { name: 'id', primaryKeyPosition: 1 },
    { name: 'tenant_id', primaryKeyPosition: 0 },
    { name: 'display_name', primaryKeyPosition: 0 },
  ],
  primaryKey: ['id'],
  ownership: { kind: 'tenant_column', column: 'tenant_id' },
  disposition: 'migrate',
};

const attemptsInventory: TenantMigrationTableInventory = {
  table: 'attempts',
  columns: [
    { name: 'id', primaryKeyPosition: 1 },
    { name: 'event_id', primaryKeyPosition: 0 },
    { name: 'status', primaryKeyPosition: 0 },
  ],
  primaryKey: ['id'],
  ownership: {
    kind: 'parent',
    foreignKeyColumn: 'event_id',
    parentTable: 'events',
    parentKeyColumn: 'id',
    parentTenantColumn: 'tenant_id',
  },
  disposition: 'migrate',
};

describe('tenant placement migration outbox transfer', () => {
  let source: DatabaseSync;
  let target: DatabaseSync;
  let executor: SqliteTransferExecutor;

  beforeEach(() => {
    source = new DatabaseSync(':memory:');
    target = new DatabaseSync(':memory:');
    source.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/040_tenant_placement_migration_outbox.sql'),
        'utf8'
      )
    );
    source.exec(
      'CREATE TABLE users (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, display_name TEXT NOT NULL)'
    );
    target.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, display_name TEXT NOT NULL);
      CREATE TABLE events (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL);
      CREATE TABLE attempts (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        status TEXT NOT NULL,
        FOREIGN KEY (event_id) REFERENCES events(id)
      );
    `);
    source
      .prepare(
        `INSERT INTO tenant_placement_migration_captures (
           operation_id, tenant_id, source_shard_id, migration_generation, capture_state,
           fencing_token, installed_at, updated_at
         ) VALUES (?, ?, ?, ?, 'capturing', ?, ?, ?)`
      )
      .run('migration-a', 'tenant-a', 'source-a', 2, 7, 100, 100);
    executor = new SqliteTransferExecutor(
      new Map([
        ['source', source],
        ['target', target],
      ])
    );
  });

  it('purges only the selected tenant in bounded primary-key batches', async () => {
    const insert = source.prepare(
      'INSERT INTO users (id, tenant_id, display_name) VALUES (?, ?, ?)'
    );
    for (let index = 0; index < 150; index += 1) {
      insert.run(`tenant-a-${String(index).padStart(3, '0')}`, 'tenant-a', `A ${index}`);
    }
    insert.run('tenant-b-000', 'tenant-b', 'Tenant B remains');
    const query = buildTenantMigrationPurgeQuery({
      table: usersInventory,
      tenantId: 'tenant-a',
      tenantKey: 'tenant-key-a',
      limit: 100,
    });

    const first = await executor.queryD1('source', query.sql, query.params);
    const second = await executor.queryD1('source', query.sql, query.params);

    expect(first[0]?.meta?.changes).toBe(100);
    expect(second[0]?.meta?.changes).toBe(50);
    expect(source.prepare('SELECT id, tenant_id FROM users').all()).toEqual([
      { id: 'tenant-b-000', tenant_id: 'tenant-b' },
    ]);
  });

  afterEach(() => {
    source.close();
    target.close();
  });

  function enqueue(input: {
    table: string;
    kind: 'upsert' | 'delete';
    key: Record<string, unknown>;
    row: Record<string, unknown> | null;
  }): void {
    source
      .prepare(
        `INSERT INTO tenant_placement_migration_outbox (
           operation_id, tenant_id, table_name, mutation_kind, mutation_key_json, row_json,
           capture_fencing_token, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'migration-a',
        'tenant-a',
        input.table,
        input.kind,
        JSON.stringify(input.key),
        input.row ? JSON.stringify(input.row) : null,
        7,
        100
      );
  }

  it('applies and acknowledges a bounded batch idempotently after response loss', async () => {
    enqueue({
      table: 'users',
      kind: 'upsert',
      key: { id: 'user-a' },
      row: { id: 'user-a', tenant_id: 'tenant-a', display_name: 'User A' },
    });
    const records = await readTenantMigrationOutboxBatch({
      executor,
      sourceDatabaseId: 'source',
      operationId: 'migration-a',
      tenantId: 'tenant-a',
      fencingToken: 7,
      afterSequence: 0,
    });

    await applyTenantMigrationOutboxBatch({
      executor,
      sourceDatabaseId: 'source',
      targetDatabaseId: 'target',
      operationId: 'migration-a',
      tenantId: 'tenant-a',
      tenantKey: 'tenant-key-a',
      fencingToken: 7,
      inventory: [usersInventory],
      records,
      now: 110,
    });
    await applyTenantMigrationOutboxBatch({
      executor,
      sourceDatabaseId: 'source',
      targetDatabaseId: 'target',
      operationId: 'migration-a',
      tenantId: 'tenant-a',
      tenantKey: 'tenant-key-a',
      fencingToken: 7,
      inventory: [usersInventory],
      records,
      now: 111,
    });

    expect(target.prepare('SELECT * FROM users').all()).toEqual([
      { id: 'user-a', tenant_id: 'tenant-a', display_name: 'User A' },
    ]);
    expect(
      source
        .prepare('SELECT delivery_state, applied_at FROM tenant_placement_migration_outbox')
        .get()
    ).toEqual({ delivery_state: 'applied', applied_at: 110 });
  });

  it('backfills by primary-key cursor without reading a co-resident tenant', async () => {
    const insert = source.prepare(
      'INSERT INTO users (id, tenant_id, display_name) VALUES (?, ?, ?)'
    );
    insert.run('a-1', 'tenant-a', 'A1');
    insert.run('a-2', 'tenant-a', 'A2');
    insert.run('b-1', 'tenant-b', 'B1');

    const first = await readTenantMigrationBackfillPage({
      executor,
      sourceDatabaseId: 'source',
      table: usersInventory,
      tenantId: 'tenant-a',
      tenantKey: 'tenant-key-a',
      cursor: null,
      limit: 1,
    });
    expect(first).toMatchObject({
      rows: [{ id: 'a-1', tenant_id: 'tenant-a', display_name: 'A1' }],
      nextCursor: { id: 'a-1' },
      done: false,
    });
    await applyTenantMigrationBackfillPage({
      executor,
      targetDatabaseId: 'target',
      table: usersInventory,
      tenantId: 'tenant-a',
      tenantKey: 'tenant-key-a',
      rows: first.rows,
    });

    const second = await readTenantMigrationBackfillPage({
      executor,
      sourceDatabaseId: 'source',
      table: usersInventory,
      tenantId: 'tenant-a',
      tenantKey: 'tenant-key-a',
      cursor: first.nextCursor,
      limit: 100,
    });
    expect(second).toMatchObject({
      rows: [{ id: 'a-2', tenant_id: 'tenant-a', display_name: 'A2' }],
      nextCursor: { id: 'a-2' },
      done: true,
    });
    await applyTenantMigrationBackfillPage({
      executor,
      targetDatabaseId: 'target',
      table: usersInventory,
      tenantId: 'tenant-a',
      tenantKey: 'tenant-key-a',
      rows: second.rows,
    });

    expect(target.prepare('SELECT * FROM users ORDER BY id').all()).toEqual([
      { id: 'a-1', tenant_id: 'tenant-a', display_name: 'A1' },
      { id: 'a-2', tenant_id: 'tenant-a', display_name: 'A2' },
    ]);
  });

  it('rejects a cross-tenant upsert before writing the target', async () => {
    enqueue({
      table: 'users',
      kind: 'upsert',
      key: { id: 'user-b' },
      row: { id: 'user-b', tenant_id: 'tenant-b', display_name: 'User B' },
    });
    const records = await readTenantMigrationOutboxBatch({
      executor,
      sourceDatabaseId: 'source',
      operationId: 'migration-a',
      tenantId: 'tenant-a',
      fencingToken: 7,
      afterSequence: 0,
    });

    await expect(
      applyTenantMigrationOutboxBatch({
        executor,
        sourceDatabaseId: 'source',
        targetDatabaseId: 'target',
        operationId: 'migration-a',
        tenantId: 'tenant-a',
        tenantKey: 'tenant-key-a',
        fencingToken: 7,
        inventory: [usersInventory],
        records,
        now: 110,
      })
    ).rejects.toThrow('tenant_migration_outbox_owner_mismatch');
    expect(target.prepare('SELECT * FROM users').all()).toEqual([]);
  });

  it('does not delete a target row owned by another tenant', async () => {
    target
      .prepare('INSERT INTO users (id, tenant_id, display_name) VALUES (?, ?, ?)')
      .run('user-b', 'tenant-b', 'User B');
    enqueue({ table: 'users', kind: 'delete', key: { id: 'user-b' }, row: null });
    const records = await readTenantMigrationOutboxBatch({
      executor,
      sourceDatabaseId: 'source',
      operationId: 'migration-a',
      tenantId: 'tenant-a',
      fencingToken: 7,
      afterSequence: 0,
    });

    await expect(
      applyTenantMigrationOutboxBatch({
        executor,
        sourceDatabaseId: 'source',
        targetDatabaseId: 'target',
        operationId: 'migration-a',
        tenantId: 'tenant-a',
        tenantKey: 'tenant-key-a',
        fencingToken: 7,
        inventory: [usersInventory],
        records,
        now: 110,
      })
    ).rejects.toThrow('tenant_migration_outbox_owner_mismatch');
    expect(target.prepare('SELECT tenant_id FROM users WHERE id = ?').get('user-b')).toEqual({
      tenant_id: 'tenant-b',
    });
  });

  it('requires an indirectly owned row to resolve through the target parent', async () => {
    target.prepare('INSERT INTO events (id, tenant_id) VALUES (?, ?)').run('event-b', 'tenant-b');
    enqueue({
      table: 'attempts',
      kind: 'upsert',
      key: { id: 'attempt-b' },
      row: { id: 'attempt-b', event_id: 'event-b', status: 'queued' },
    });
    const records = await readTenantMigrationOutboxBatch({
      executor,
      sourceDatabaseId: 'source',
      operationId: 'migration-a',
      tenantId: 'tenant-a',
      fencingToken: 7,
      afterSequence: 0,
    });

    await expect(
      applyTenantMigrationOutboxBatch({
        executor,
        sourceDatabaseId: 'source',
        targetDatabaseId: 'target',
        operationId: 'migration-a',
        tenantId: 'tenant-a',
        tenantKey: 'tenant-key-a',
        fencingToken: 7,
        inventory: [attemptsInventory],
        records,
        now: 110,
      })
    ).rejects.toThrow('tenant_migration_outbox_parent_owner_mismatch');
  });
});
