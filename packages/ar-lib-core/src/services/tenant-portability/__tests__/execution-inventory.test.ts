import { runSqliteResourceDiscoveryStep } from '../sqlite-resource-discovery';
import { executeTenantBackupSlice } from '../operation-executor';
import { persistFixedBackupDatabaseResources } from '../fixed-database-resources';
import { persistBackupDatabaseResources, type BackupDatabaseResource } from '../database-resources';
import { readBackupSqliteDatabaseSchema } from '../sqlite-schema-reader';
import { SQLITE_SNAPSHOT_SCHEMA, sqliteSnapshotTriggers } from '../sqlite-snapshot';
import {
  persistSqliteTenantDatasetPlan,
  persistSqliteTenantDatasetPlanPage,
  verifyPersistedSqliteTenantDatasetPlan,
  verifyLiveSqliteTenantDatasetPlan,
} from '../sqlite-dataset-plan';
import { inspectBackupSchema } from '../../../../../../scripts/tenant-backup/schema-inventory';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../../db/adapter';
import { TenantBackupExecutionInventory } from '../execution-inventory';
import { TenantBackupOperationStore, type TenantBackupLease } from '../operation-store';
let db: DatabaseSync;
let adapter: Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>;
let store: TenantBackupOperationStore;
let lease: TenantBackupLease;
let inventory: TenantBackupExecutionInventory;
let now: number;
beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const file of [
    '003_tenant_backup_operations.sql',
    '004_tenant_backup_validation_index.sql',
    '008_tenant_backup_retry_state.sql',
    '010_tenant_backup_execution_inventory.sql',
  ])
    db.exec(
      readFileSync(
        new URL(`../../../../../../migrations/admin/d1/${file}`, import.meta.url),
        'utf8'
      )
    );
  adapter = {
    async query<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (db.prepare(sql).get(...(params as SQLInputValue[])) as T) ?? null;
    },
    async execute(sql: string, params: unknown[] = []) {
      return {
        success: true,
        rowsAffected: Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes),
      };
    },
  };
  store = new TenantBackupOperationStore(adapter);
  await store.create({
    id: 'op',
    tenantId: 'a',
    kind: 'export',
    idempotencyKey: 'request',
    requestDigest: 'a'.repeat(64),
    actorId: 'admin',
    now: 100,
  });
  const operation = await store.claim('a', 'op', 'worker', 101);
  if (!operation) throw new Error('missing_lease');
  lease = {
    tenantId: 'a',
    operationId: 'op',
    owner: 'worker',
    fencingToken: operation.fencing_token,
  };
  now = 102;
  inventory = new TenantBackupExecutionInventory(adapter, lease, () => now);
  await inventory.create();
});
afterEach(() => db.close());
it('pins a complete list, permits exact retries, and exposes bounded pages only after sealing', async () => {
  for (let i = 0; i < 20; i++)
    await inventory.append(i, `item-${i}`, JSON.stringify({ dataset: i }));
  await inventory.append(0, 'item-0', '{"dataset":0}');
  await expect(inventory.append(0, 'item-0', '{"dataset":1}')).rejects.toThrow('retry_conflict');
  await expect(inventory.readPage()).rejects.toThrow('not_sealed');
  const head = await inventory.head();
  await expect(inventory.seal(19, head.chain_digest)).rejects.toThrow('seal_conflict');
  await inventory.seal(20, head.chain_digest);
  await inventory.seal(20, head.chain_digest);
  expect(await inventory.readPage()).toHaveLength(16);
  expect((await inventory.readPage(16)).map((item) => item.ordinal)).toEqual([16, 17, 18, 19]);
  await expect(inventory.append(20, 'extra', '{}')).rejects.toThrow('append_conflict');
  expect(() =>
    db.exec("UPDATE tenant_backup_execution_inventory_items SET payload_json='{}'")
  ).toThrow('item_immutable');
  expect(() => db.exec("UPDATE tenant_backup_execution_inventories SET state='building'")).toThrow(
    'sealed_immutable'
  );
});
it('survives lease takeover without changing committed metadata', async () => {
  await inventory.append(0, 'first', '{}');
  now = 40000;
  const operation = await store.claim('a', 'op', 'new-worker', now);
  if (!operation) throw new Error('missing_takeover');
  await expect(inventory.append(1, 'second', '{}')).rejects.toThrow('fenced');
  const resumed = new TenantBackupExecutionInventory(
    adapter,
    { ...lease, owner: 'new-worker', fencingToken: operation.fencing_token },
    () => now
  );
  expect((await resumed.create()).item_count).toBe(1);
  await resumed.append(0, 'first', '{}');
  await resumed.append(1, 'second', '{}');
  const head = await resumed.head();
  await resumed.seal(2, head.chain_digest);
  expect(await resumed.readPage()).toHaveLength(2);
});
it('refuses cross-tenant access and interrupted readers', async () => {
  await inventory.append(0, 'first', '{}');
  const head = await inventory.head();
  await inventory.seal(1, head.chain_digest);
  const foreign = new TenantBackupExecutionInventory(
    adapter,
    { ...lease, tenantId: 'b' },
    () => now
  );
  await expect(foreign.head()).rejects.toThrow('fenced');
  const racing = new TenantBackupExecutionInventory(
    {
      ...adapter,
      async query<T>(sql: string, params: unknown[] = []) {
        const rows = await adapter.query<T>(sql, params);
        db.exec(
          "UPDATE tenant_backup_operations SET state='cancelled',lease_owner=NULL,lease_expires_at=NULL WHERE id='op'"
        );
        return rows;
      },
    },
    lease,
    () => now
  );
  await expect(racing.readPage()).rejects.toThrow('fenced');
});
it('rejects gaps, duplicates, oversized payloads and incomplete item storage', async () => {
  await expect(inventory.append(1, 'gap', '{}')).rejects.toThrow('append_conflict');
  await expect(inventory.append(0, 'huge', JSON.stringify('x'.repeat(262144)))).rejects.toThrow(
    'invalid_item'
  );
  await inventory.append(0, 'first', '{}');
  await expect(inventory.append(1, 'first', '{}')).rejects.toThrow();
  expect((await inventory.head()).item_count).toBe(1);
  const head = await inventory.head();
  db.exec('DELETE FROM tenant_backup_execution_inventory_items');
  await expect(inventory.seal(1, head.chain_digest)).rejects.toThrow('seal_conflict');
});
it('detects an internal gap even when a page still contains the expected number of rows', async () => {
  for (let i = 0; i < 17; i++) await inventory.append(i, `item-${i}`, '{}');
  const head = await inventory.head();
  await inventory.seal(17, head.chain_digest);
  db.exec('DELETE FROM tenant_backup_execution_inventory_items WHERE ordinal=0');
  await expect(inventory.readPage()).rejects.toThrow('backup_inventory_integrity');
  await expect(inventory.readPage(18)).rejects.toThrow('invalid_cursor');
});

it('persists the complete SQL plan and rejects changed or unsupported plans', async () => {
  const tables = inspectBackupSchema(['CREATE TABLE tenants(id TEXT PRIMARY KEY NOT NULL)']).tables;
  const input = {
    inventory,
    family: 'core' as const,
    resourceId: 'core-resource',
    firstOrdinal: 0,
    tables,
    selection: {
      settings: true,
      users: false,
      admin: false,
      artifacts: false,
      logs: { audit: false, other: false, sensitive: false, period: 'all' as const },
    },
  };
  expect(await persistSqliteTenantDatasetPlan(input)).toBe(1);
  expect(await persistSqliteTenantDatasetPlan(input)).toBe(1);
  const changed = inspectBackupSchema([
    'CREATE TABLE tenants(id TEXT PRIMARY KEY NOT NULL,changed TEXT)',
  ]).tables;
  await expect(persistSqliteTenantDatasetPlan({ ...input, tables: changed })).rejects.toThrow(
    'retry_conflict'
  );
  const unsupported = inspectBackupSchema(['CREATE TABLE tenants(id INTEGER PRIMARY KEY)']).tables;
  await expect(
    persistSqliteTenantDatasetPlan({
      ...input,
      resourceId: 'second',
      firstOrdinal: 1,
      tables: unsupported,
    })
  ).rejects.toThrow('adapters_unresolved');
  const head = await inventory.head();
  expect(head.item_count).toBe(1);
  await inventory.seal(1, head.chain_digest);
  expect(JSON.parse((await inventory.readPage())[0].payload_json)).toMatchObject({
    family: 'core',
    table: 'tenants',
    capture: { tenantColumn: 'id' },
  });
});

it('persists a SQL plan through a bounded resumable page', async () => {
  const tables = inspectBackupSchema(['CREATE TABLE tenants(id TEXT PRIMARY KEY NOT NULL)']).tables;
  const input = {
    inventory,
    family: 'core' as const,
    resourceId: 'core-resource',
    firstOrdinal: 0,
    tables,
    selection: {
      settings: true,
      users: false,
      admin: false,
      artifacts: false,
      logs: { audit: false, other: false, sensitive: false, period: 'all' as const },
    },
  };
  await expect(persistSqliteTenantDatasetPlanPage(input, -1)).rejects.toThrow('invalid_resource');
  await expect(persistSqliteTenantDatasetPlanPage(input, 2)).rejects.toThrow('inventory_limit');
  const page = await persistSqliteTenantDatasetPlanPage(input, 0);
  expect(page).toEqual({ nextEntryOffset: 1, nextOrdinal: 1, complete: true });
  expect(await persistSqliteTenantDatasetPlanPage(input, 0)).toEqual(page);
  expect((await inventory.head()).item_count).toBe(1);
});

it('revalidates full schema and dataset inventory before exposing capture definitions', async () => {
  const sql =
    "CREATE TABLE tenants(id TEXT PRIMARY KEY NOT NULL,value TEXT DEFAULT 'a'); CREATE TABLE users(id TEXT PRIMARY KEY NOT NULL,tenant_id TEXT NOT NULL);";
  const tables = inspectBackupSchema([sql]).tables;
  const input = {
    inventory,
    family: 'core' as const,
    resourceId: 'core',
    firstOrdinal: 0,
    tables,
    selection: {
      settings: true,
      users: false,
      admin: false,
      artifacts: false,
      logs: { audit: false, other: false, sensitive: false, period: 'all' as const },
    },
  };
  await persistSqliteTenantDatasetPlan(input);
  await expect(verifyPersistedSqliteTenantDatasetPlan(input)).rejects.toThrow('not_sealed');
  const head = await inventory.head();
  await inventory.seal(head.item_count, head.chain_digest);
  expect(
    (await verifyPersistedSqliteTenantDatasetPlan(input)).map((schema) => schema.table)
  ).toEqual(['tenants']);
  for (const altered of [
    sql.replace("DEFAULT 'a'", "DEFAULT 'b'"),
    sql + ' CREATE INDEX tenant_value ON tenants(value);',
  ]) {
    await expect(
      verifyPersistedSqliteTenantDatasetPlan({
        ...input,
        tables: inspectBackupSchema([altered]).tables,
      })
    ).rejects.toThrow('inventory_changed');
  }
  await expect(
    verifyPersistedSqliteTenantDatasetPlan({
      ...input,
      tables: tables.filter((table) => table.name !== 'users'),
    })
  ).rejects.toThrow('inventory_changed');
  await expect(
    verifyPersistedSqliteTenantDatasetPlan({ ...input, resourceId: 'other' })
  ).rejects.toThrow('inventory_changed');
  await expect(
    verifyPersistedSqliteTenantDatasetPlan({
      ...input,
      selection: { ...input.selection, users: true },
    })
  ).rejects.toThrow('inventory_changed');
});

it('reads the actual source DB and detects table and application trigger changes', async () => {
  const sourceDb = new DatabaseSync(':memory:');
  const source: Pick<DatabaseAdapter, 'query' | 'queryOne'> = {
    async query<T>(sql: string, params: unknown[] = []) {
      return sourceDb.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (sourceDb.prepare(sql).get(...(params as SQLInputValue[])) as T) ?? null;
    },
  };
  const signal = new AbortController().signal;
  try {
    sourceDb.exec('CREATE TABLE tenants(id TEXT PRIMARY KEY NOT NULL,value TEXT)');
    const tables = await readBackupSqliteDatabaseSchema(source, 'core', signal);
    const input = {
      inventory,
      family: 'core' as const,
      resourceId: 'core-db',
      firstOrdinal: 0,
      selection: {
        settings: true,
        users: false,
        admin: false,
        artifacts: false,
        logs: { audit: false, other: false, sensitive: false, period: 'all' as const },
      },
    };
    await persistSqliteTenantDatasetPlan({ ...input, tables });
    const head = await inventory.head();
    await inventory.seal(head.item_count, head.chain_digest);
    const verified = await verifyLiveSqliteTenantDatasetPlan({
      ...input,
      database: source,
      signal,
    });
    expect(verified).toHaveLength(1);
    sourceDb.exec(SQLITE_SNAPSHOT_SCHEMA + sqliteSnapshotTriggers(verified[0]));
    expect(await verifyLiveSqliteTenantDatasetPlan({ ...input, database: source, signal })).toEqual(
      verified
    );
    sourceDb.exec('CREATE TRIGGER changed_behavior AFTER UPDATE ON tenants BEGIN SELECT 1; END;');
    await expect(
      verifyLiveSqliteTenantDatasetPlan({ ...input, database: source, signal })
    ).rejects.toThrow('inventory_changed');
    sourceDb.exec('DROP TRIGGER changed_behavior; CREATE TABLE unexpected(id TEXT)');
    await expect(
      verifyLiveSqliteTenantDatasetPlan({ ...input, database: source, signal })
    ).rejects.toThrow('unclassified_table');
    sourceDb.exec('DROP TABLE unexpected');
    const racing = {
      ...source,
      async query<T>(sql: string, params: unknown[] = []) {
        const result = await source.query<T>(sql, params);
        if (sql.includes('pragma_table_xinfo'))
          sourceDb.exec('CREATE INDEX new_index ON tenants(value)');
        return result;
      },
    };
    await expect(readBackupSqliteDatabaseSchema(racing, 'core', signal)).rejects.toThrow(
      'changed_during_inspection'
    );
  } finally {
    sourceDb.close();
  }
});

it('pins database placement generations and refuses rerouting a resumed operation', async () => {
  const resource: BackupDatabaseResource = {
    databaseId: 'database-a',
    runtimeGeneration: 8,
    deploymentTarget: 'edge',
    database: adapter as DatabaseAdapter,
    assignments: [
      {
        role: 'tenant_core',
        dataRole: 'tenant_core/default',
        residencyPartition: 'default',
        shardId: 'core-shard',
        assignmentGeneration: 1,
        bindingRouteGeneration: 2,
        generation: 1,
        schemaVersion: 2,
        bindingRef: 'TDB_CORE',
      },
    ],
  };
  expect(await persistBackupDatabaseResources(inventory, 0, [resource])).toBe(1);
  expect(await persistBackupDatabaseResources(inventory, 0, [resource])).toBe(1);
  await expect(
    persistBackupDatabaseResources(inventory, 0, [{ ...resource, runtimeGeneration: 9 }])
  ).rejects.toThrow('retry_conflict');
  const head = await inventory.head();
  await inventory.seal(1, head.chain_digest);
  const descriptor = JSON.parse((await inventory.readPage())[0].payload_json);
  expect(descriptor.databaseId).toBe('database-a');
  expect(descriptor).not.toHaveProperty('database');
});

it('pins fixed database IDs without serializing live adapters', async () => {
  const resource = {
    binding: 'DB_ADMIN' as const,
    family: 'admin' as const,
    databaseId: 'admin-db',
    database: adapter as DatabaseAdapter,
  };
  await persistFixedBackupDatabaseResources(inventory, 0, [resource]);
  await persistFixedBackupDatabaseResources(inventory, 0, [resource]);
  await expect(
    persistFixedBackupDatabaseResources(inventory, 0, [{ ...resource, databaseId: 'other-db' }])
  ).rejects.toThrow('retry_conflict');
  const head = await inventory.head();
  await inventory.seal(1, head.chain_digest);
  expect(JSON.parse((await inventory.readPage())[0].payload_json)).toEqual({
    version: 1,
    binding: 'DB_ADMIN',
    family: 'admin',
    databaseId: 'admin-db',
  });
});

it('discovers all SQL resources across pages and retries without duplicate counts', async () => {
  await inventory.create();
  for (let ordinal = 0; ordinal < 18; ordinal++) {
    const resourceId = ordinal < 17 ? 'physical-a' : 'physical-b';
    const table = `table_${ordinal}`;
    await inventory.append(
      ordinal,
      `${resourceId}:${table}`,
      JSON.stringify({
        version: 1,
        resourceId,
        family: 'core',
        table,
        kind: 'settings',
        selection: 'settings',
        capture: ordinal < 17 ? { table } : null,
        schemaDigest: 'a'.repeat(64),
      })
    );
  }
  const head = await inventory.head();
  await inventory.seal(head.item_count, head.chain_digest);
  const operation = (await store.get('a', 'op'))!;
  const saved = await store.checkpoint(
    lease,
    operation.revision,
    'discover_sqlite_resources',
    null,
    now
  );
  await store.release(lease, saved!.revision, 'queued', now);
  for (let slice = 0; slice < 3; slice++) {
    now += 40000;
    const execution = executeTenantBackupSlice(
      store,
      {
        tenantId: 'a',
        operationId: 'op',
        workerId: `discover-${slice}`,
        signal: new AbortController().signal,
      },
      {
        async run(context) {
          const result = await runSqliteResourceDiscoveryStep({
            context,
            inventory: new TenantBackupExecutionInventory(adapter, context.lease, () => now),
          });
          if (slice === 0) throw new Error('lost response');
          return result;
        },
        async cleanup() {
          throw new Error('unexpected cleanup');
        },
      },
      () => now
    );
    if (slice === 0) await expect(execution).rejects.toThrow('backup_operation_slice_failed');
    else await execution;
  }
  const result = (await store.get('a', 'op'))!;
  expect(result.phase).toBe('prepare_capture_resources');
  expect(JSON.parse(result.cursor_json!).resources).toEqual([
    { resourceId: 'physical-a', family: 'core', firstOrdinal: 0, tableCount: 17, captureCount: 17 },
    { resourceId: 'physical-b', family: 'core', firstOrdinal: 17, tableCount: 1, captureCount: 0 },
  ]);
});

it('rejects split SQL resource groups instead of accepting an incomplete table range', async () => {
  await inventory.create();
  for (const [ordinal, table] of [
    [0, 'first'],
    [2, 'last'],
  ] as const) {
    if (ordinal === 2) await inventory.append(1, 'metadata', JSON.stringify({ version: 1 }));
    await inventory.append(
      ordinal,
      `physical:${table}`,
      JSON.stringify({
        version: 1,
        resourceId: 'physical',
        family: 'core',
        table,
        capture: null,
        schemaDigest: 'a'.repeat(64),
      })
    );
  }
  const head = await inventory.head();
  await inventory.seal(head.item_count, head.chain_digest);
  const operation = (await store.get('a', 'op'))!;
  await expect(
    runSqliteResourceDiscoveryStep({
      inventory,
      context: {
        lease,
        signal: new AbortController().signal,
        operation: { ...operation, phase: 'discover_sqlite_resources', cursor_json: null },
      },
    })
  ).rejects.toThrow('backup_sqlite_resource_inventory_invalid');
});

it('checks the entire sealed database set, including fixed resources and cancellation', async () => {
  const descriptors = [
    { id: 'database:core-a', payload: JSON.stringify({ generation: 1 }) },
    { id: 'fixed-database:DB_ADMIN', payload: JSON.stringify({ databaseId: 'admin-a' }) },
  ];
  await inventory.append(0, descriptors[0].id, descriptors[0].payload);
  await inventory.append(1, 'core-a:table', '{}');
  await inventory.append(2, descriptors[1].id, descriptors[1].payload);
  await expect(inventory.assertDatabaseResources(descriptors)).rejects.toThrow('not_sealed');
  const head = await inventory.head();
  await inventory.seal(3, head.chain_digest);
  await inventory.assertDatabaseResources([...descriptors].reverse());
  for (const changed of [
    descriptors.slice(0, 1),
    [...descriptors, { id: 'database:extra', payload: '{}' }],
    [{ ...descriptors[0], payload: JSON.stringify({ generation: 2 }) }, descriptors[1]],
    [descriptors[0], { ...descriptors[1], payload: JSON.stringify({ databaseId: 'admin-b' }) }],
  ])
    await expect(inventory.assertDatabaseResources(changed)).rejects.toThrow('inventory_changed');
  await expect(inventory.assertDatabaseResources([])).rejects.toThrow('invalid_inventory');
  await expect(inventory.assertDatabaseResources([descriptors[0], descriptors[0]])).rejects.toThrow(
    'invalid_inventory'
  );
  await store.requestCancel('a', 'op', now);
  await expect(inventory.assertDatabaseResources(descriptors)).rejects.toThrow('fenced');
});
