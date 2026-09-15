import { readNextShardedSqliteDatasetChunk } from '../sqlite-sharded-dataset-reader';
import { readNextPlannedSqliteDatasetChunk } from '../sqlite-planned-dataset-reader';
import { runPreparedSnapshotBoundaryStep } from '../snapshot-boundary-step';
import { startTenantBackupSnapshotBoundary, sqliteBoundaryParticipant } from '../snapshot-boundary';
import { TenantBackupBoundaryReceipts } from '../boundary-receipts';
import { TenantBackupMutationAdmission } from '../mutation-admission';
import { runSqliteResourcePreparationStep } from '../sqlite-resource-preparation';
import { runSqliteResourceDiscoveryStep } from '../sqlite-resource-discovery';
import { executeTenantBackupSlice } from '../operation-executor';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../../db/adapter';
import { TenantBackupSnapshotResources } from '../snapshot-resources';
import { SQLITE_SNAPSHOT_SCHEMA } from '../sqlite-snapshot';
import {
  runTenantBackupSqliteCaptureStep,
  prepareTenantBackupSqliteCapture,
  startTenantBackupSqliteCapture,
} from '../sqlite-operation-capture';
import { TenantBackupExecutionInventory } from '../execution-inventory';
import {
  persistSqliteTenantDatasetPlan,
  verifyLiveSqliteTenantDatasetPlan,
} from '../sqlite-dataset-plan';
import { readBackupSqliteDatabaseSchema } from '../sqlite-schema-reader';
import { sqliteCapturePlan } from '../sqlite-capture-plan';
import { readSqliteSnapshotDataset } from '../sqlite-dataset-source';
import { TenantBackupOperationStore, type TenantBackupLease } from '../operation-store';
let db: DatabaseSync;
let adapter: Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>;
let store: TenantBackupOperationStore;
let lease: TenantBackupLease;
let resources: TenantBackupSnapshotResources;
let now: number;
beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const file of [
    '003_tenant_backup_operations.sql',
    '004_tenant_backup_validation_index.sql',
    '008_tenant_backup_retry_state.sql',
    '010_tenant_backup_execution_inventory.sql',
    '011_tenant_backup_snapshot_resources.sql',
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
  resources = new TenantBackupSnapshotResources(adapter, () => now);
  db.exec(SQLITE_SNAPSHOT_SCHEMA);
});
afterEach(() => db.close());

async function fixture(prepare = true, secondResource = false, clients = false) {
  const sourceDb = new DatabaseSync(':memory:');
  const database = {
    async query<T>(sql: string, params: unknown[] = []) {
      return sourceDb.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (sourceDb.prepare(sql).get(...(params as SQLInputValue[])) as T) ?? null;
    },
    async execute(sql: string, params: unknown[] = []) {
      return {
        success: true,
        rowsAffected: Number(sourceDb.prepare(sql).run(...(params as SQLInputValue[])).changes),
      };
    },
  };
  const inventory = new TenantBackupExecutionInventory(adapter, lease, () => now);
  await inventory.create();
  sourceDb.exec(
    clients
      ? "CREATE TABLE oauth_clients(id TEXT PRIMARY KEY NOT NULL,tenant_id TEXT NOT NULL,value TEXT); INSERT INTO oauth_clients VALUES ('client-a','a','before'),('foreign','b','private');"
      : "CREATE TABLE tenants(id TEXT PRIMARY KEY NOT NULL,value TEXT); INSERT INTO tenants VALUES ('a','before'),('b','private');"
  );
  const signal = new AbortController().signal;
  const plan = {
    inventory,
    family: 'core' as const,
    resourceId: 'physical-a',
    firstOrdinal: 0,
    selection: {
      settings: true,
      users: false,
      admin: false,
      artifacts: false,
      logs: { audit: false, other: false, sensitive: false, period: 'all' as const },
    },
  };
  const tables = await readBackupSqliteDatabaseSchema(database, 'core', signal);
  const nextOrdinal = await persistSqliteTenantDatasetPlan({ ...plan, tables });
  if (secondResource)
    await persistSqliteTenantDatasetPlan({
      ...plan,
      tables,
      resourceId: 'physical-b',
      firstOrdinal: nextOrdinal,
    });
  const head = await inventory.head();
  await inventory.seal(head.item_count, head.chain_digest);
  const schemas = await verifyLiveSqliteTenantDatasetPlan({ ...plan, database, signal });
  sourceDb.exec(SQLITE_SNAPSHOT_SCHEMA);
  const operation = (await store.get('a', 'op'))!;
  const result = {
    sourceDb,
    schemas,
    input: {
      ...plan,
      context: { operation, lease, signal },
      resources,
      source: { resourceId: 'physical-a', database },
      snapshotId: 'snapshot-a',
      async assertBoundary() {},
    },
  };
  if (prepare) await prepareTenantBackupSqliteCapture(result.input, 0);
  return result;
}

it('resumes an uncertain source start without replacing preimages or the original boundary', async () => {
  const { sourceDb, schemas, input } = await fixture();
  try {
    let first = true;
    const uncertain = {
      ...input,
      source: {
        ...input.source,
        database: {
          ...input.source.database,
          async execute(sql: string, params?: unknown[]) {
            const result = await input.source.database.execute(sql, params);
            if (first) {
              first = false;
              throw new Error('lost_response');
            }
            return result;
          },
        },
      },
    };
    await expect(startTenantBackupSqliteCapture(uncertain)).rejects.toThrow('lost_response');
    sourceDb.exec("UPDATE tenants SET value='after' WHERE id='a'");
    await startTenantBackupSqliteCapture(input);
    let output = '';
    for await (const chunk of readSqliteSnapshotDataset({
      database: input.source.database,
      schema: schemas[0],
      snapshotId: 'snapshot-a',
      tenantId: 'a',
      signal: input.context.signal,
    }))
      output += new TextDecoder().decode(chunk);
    expect(output).toContain('before');
    expect(output).not.toContain('after');
    expect(output).not.toContain('private');
    expect(sourceDb.prepare('SELECT count(*) AS n FROM tenant_backup_snapshots').get()?.n).toBe(1);
  } finally {
    sourceDb.close();
  }
});

it('rejects missing capture triggers on resume and never revives an invalid snapshot', async () => {
  const { sourceDb, input, schemas } = await fixture();
  try {
    await startTenantBackupSqliteCapture(input);
    sourceDb.exec('DROP TRIGGER tenant_backup_tenants_delete');
    await expect(startTenantBackupSqliteCapture(input)).rejects.toThrow('start_rejected');
    sourceDb.exec(
      sqliteCapturePlan(schemas).triggers.find((trigger) => trigger.name.endsWith('_delete'))!.sql
    );
    sourceDb.exec("UPDATE tenant_backup_snapshots SET state='invalid'");
    await expect(startTenantBackupSqliteCapture(input)).rejects.toThrow('start_rejected');
    expect(sourceDb.prepare('SELECT state FROM tenant_backup_snapshots').get()?.state).toBe(
      'invalid'
    );
  } finally {
    sourceDb.close();
  }
});

it('keeps a discoverable reservation when cancellation races source execution', async () => {
  const { sourceDb, input } = await fixture();
  try {
    await expect(
      startTenantBackupSqliteCapture({
        ...input,
        source: {
          ...input.source,
          database: {
            ...input.source.database,
            async execute(sql: string, params?: unknown[]) {
              await store.requestCancel('a', 'op', now);
              return input.source.database.execute(sql, params);
            },
          },
        },
      })
    ).rejects.toThrow('fenced');
    expect(
      db.prepare('SELECT snapshot_id FROM tenant_backup_snapshot_resources').get()?.snapshot_id
    ).toBe('snapshot-a');
    const operation = (await store.claimCancellation('a', 'op', 'cleaner', now))!;
    const context = {
      operation,
      lease: { ...lease, owner: 'cleaner', fencingToken: operation.fencing_token },
      signal: input.context.signal,
    };
    await resources.cleanupCancellationPage(context, async () => input.source);
    expect(sourceDb.prepare('SELECT state FROM tenant_backup_snapshots').get()?.state).toBe(
      'invalid'
    );
  } finally {
    sourceDb.close();
  }
});

it('does not start if the coordinator boundary is lost after planning', async () => {
  const { sourceDb, input } = await fixture();
  try {
    let checks = 0;
    await expect(
      startTenantBackupSqliteCapture({
        ...input,
        async assertBoundary() {
          if (++checks === 2) throw new Error('boundary_lost');
        },
      })
    ).rejects.toThrow('boundary_lost');
    expect(sourceDb.prepare('SELECT count(*) AS n FROM tenant_backup_snapshots').get()?.n).toBe(0);
  } finally {
    sourceDb.close();
  }
});

it('a new worker resumes the same sealed plan while the old lease is rejected', async () => {
  const { sourceDb, input } = await fixture();
  try {
    await startTenantBackupSqliteCapture(input);
    sourceDb.exec("UPDATE tenants SET value='after' WHERE id='a'");
    now = 40000;
    const operation = (await store.claim('a', 'op', 'replacement', now))!;
    const nextLease = { ...lease, owner: 'replacement', fencingToken: operation.fencing_token };
    await expect(startTenantBackupSqliteCapture(input)).rejects.toThrow('fenced');
    await startTenantBackupSqliteCapture({
      ...input,
      inventory: new TenantBackupExecutionInventory(adapter, nextLease, () => now),
      context: { ...input.context, operation, lease: nextLease },
    });
    expect(sourceDb.prepare('SELECT count(*) AS n FROM tenant_backup_preimages').get()?.n).toBe(1);
    expect(sourceDb.prepare('SELECT count(*) AS n FROM tenant_backup_snapshots').get()?.n).toBe(1);
  } finally {
    sourceDb.close();
  }
});

it('retries partial installation after an uncertain DDL response without replacing existing triggers', async () => {
  const { sourceDb, input } = await fixture(false);
  try {
    let calls = 0;
    const uncertain = {
      ...input,
      source: {
        ...input.source,
        database: {
          ...input.source.database,
          async execute(sql: string, params?: unknown[]) {
            const result = await input.source.database.execute(sql, params);
            if (++calls === 1) throw new Error('lost_install_response');
            return result;
          },
        },
      },
    };
    await expect(prepareTenantBackupSqliteCapture(uncertain, 0)).rejects.toThrow(
      'lost_install_response'
    );
    expect(
      sourceDb
        .prepare(
          "SELECT count(*) AS n FROM sqlite_schema WHERE type='trigger' AND tbl_name='tenants'"
        )
        .get()?.n
    ).toBe(1);
    await expect(startTenantBackupSqliteCapture(input)).rejects.toThrow('start_rejected');
    expect(await prepareTenantBackupSqliteCapture(input, 0)).toEqual({
      nextTableOrdinal: 1,
      complete: true,
    });
    expect(await prepareTenantBackupSqliteCapture(input, 0)).toEqual({
      nextTableOrdinal: 1,
      complete: true,
    });
    await startTenantBackupSqliteCapture(input);
    sourceDb.exec("UPDATE tenants SET value='changed' WHERE id='a'");
    expect(sourceDb.prepare('SELECT count(*) AS n FROM tenant_backup_preimages').get()?.n).toBe(1);
  } finally {
    sourceDb.close();
  }
});

it('never repairs missing capture protection for an active snapshot', async () => {
  const { sourceDb, input } = await fixture();
  try {
    await startTenantBackupSqliteCapture(input);
    sourceDb.exec('DROP TRIGGER tenant_backup_tenants_update');
    sourceDb.exec("UPDATE tenants SET value='unprotected' WHERE id='a'");
    await expect(prepareTenantBackupSqliteCapture(input, 0)).rejects.toThrow(
      'install_during_capture'
    );
    expect(
      sourceDb
        .prepare("SELECT name FROM sqlite_schema WHERE name='tenant_backup_tenants_update'")
        .get()
    ).toBeUndefined();
    await expect(startTenantBackupSqliteCapture(input)).rejects.toThrow('start_rejected');
  } finally {
    sourceDb.close();
  }
});

it('rejects conflicting trigger definitions and lost admission guard before installing', async () => {
  const { sourceDb, input } = await fixture(false);
  try {
    sourceDb.exec(
      'CREATE TRIGGER tenant_backup_tenants_delete BEFORE DELETE ON tenants BEGIN SELECT 1; END'
    );
    await expect(prepareTenantBackupSqliteCapture(input, 0)).rejects.toThrow('trigger_conflict');
    expect(
      sourceDb
        .prepare(
          "SELECT count(*) AS n FROM sqlite_schema WHERE type='trigger' AND tbl_name='tenants'"
        )
        .get()?.n
    ).toBe(1);
    sourceDb.exec('DROP TRIGGER tenant_backup_tenants_delete');
    let checks = 0;
    await expect(
      prepareTenantBackupSqliteCapture(
        {
          ...input,
          async assertBoundary() {
            if (++checks === 2) throw new Error('admission_lost');
          },
        },
        0
      )
    ).rejects.toThrow('admission_lost');
    expect(
      sourceDb
        .prepare(
          "SELECT count(*) AS n FROM sqlite_schema WHERE type='trigger' AND tbl_name='tenants'"
        )
        .get()?.n
    ).toBe(0);
    await expect(prepareTenantBackupSqliteCapture(input, -1)).rejects.toThrow('install_cursor');
  } finally {
    sourceDb.close();
  }
});

it('checkpoints installation and start, retaining the snapshot after a lost outer checkpoint', async () => {
  const { sourceDb, input } = await fixture(false);
  try {
    const head = await input.inventory.head();
    const original = (await store.get('a', 'op'))!;
    const prepared = await store.checkpoint(
      lease,
      original.revision,
      'prepare_sqlite_capture',
      JSON.stringify({
        version: 1,
        resourceId: input.resourceId,
        snapshotId: input.snapshotId,
        inventoryDigest: head.chain_digest,
        tableOrdinal: 0,
      }),
      now
    );
    await store.release(lease, prepared!.revision, 'queued', now);
    let loseStart = true;
    for (let slice = 0; slice < 3; slice++) {
      now += 40000;
      const execute = executeTenantBackupSlice(
        store,
        {
          tenantId: 'a',
          operationId: 'op',
          workerId: `slice-${slice}`,
          signal: input.context.signal,
        },
        {
          async run(context) {
            const result = await runTenantBackupSqliteCaptureStep({
              ...input,
              context,
              inventory: new TenantBackupExecutionInventory(adapter, context.lease, () => now),
            });
            if (context.operation.phase === 'start_sqlite_capture' && loseStart) {
              loseStart = false;
              sourceDb.exec("UPDATE tenants SET value='after' WHERE id='a'");
              throw new Error('lost outer checkpoint');
            }
            return result;
          },
          async cleanup() {
            throw new Error('unexpected cleanup');
          },
        },
        () => now
      );
      if (slice === 1) await expect(execute).rejects.toThrow('backup_operation_slice_failed');
      else await execute;
    }
    expect((await store.get('a', 'op'))?.phase).toBe('advance_capture_resource');
    expect(sourceDb.prepare('SELECT count(*) n FROM tenant_backup_snapshots').get()?.n).toBe(1);
    expect(sourceDb.prepare('SELECT count(*) n FROM tenant_backup_preimages').get()?.n).toBe(1);
  } finally {
    sourceDb.close();
  }
});

it('rejects changed plan/resource cursors before installing any trigger', async () => {
  const { sourceDb, input } = await fixture(false);
  try {
    const head = await input.inventory.head();
    const cursor = {
      version: 1,
      resourceId: input.resourceId,
      snapshotId: input.snapshotId,
      inventoryDigest: head.chain_digest,
      tableOrdinal: 0,
    };
    for (const change of [
      { resourceId: 'other-db' },
      { snapshotId: 'other-snapshot' },
      { inventoryDigest: '0'.repeat(64) },
      { tableOrdinal: -1 },
      { extra: true },
    ]) {
      await expect(
        runTenantBackupSqliteCaptureStep({
          ...input,
          context: {
            ...input.context,
            operation: {
              ...input.context.operation,
              phase: 'prepare_sqlite_capture',
              cursor_json: JSON.stringify({ ...cursor, ...change }),
            },
          },
        })
      ).rejects.toThrow('backup_capture_step_cursor');
    }
    expect(
      sourceDb
        .prepare("SELECT count(*) n FROM sqlite_schema WHERE type='trigger' AND tbl_name='tenants'")
        .get()?.n
    ).toBe(0);
  } finally {
    sourceDb.close();
  }
});

it('prepares both databases before admission and safely repeats an installed table', async () => {
  const { sourceDb, input } = await fixture(false, true);
  const second = new DatabaseSync(':memory:');
  try {
    second.exec('CREATE TABLE tenants(id TEXT PRIMARY KEY NOT NULL,value TEXT)');
    second.exec(SQLITE_SNAPSHOT_SCHEMA);
    const secondAdapter = {
      async query<T>(sql: string, params: unknown[] = []) {
        return second.prepare(sql).all(...(params as SQLInputValue[])) as T[];
      },
      async queryOne<T>(sql: string, params: unknown[] = []) {
        return (second.prepare(sql).get(...(params as SQLInputValue[])) as T) ?? null;
      },
      async execute(sql: string, params: unknown[] = []) {
        return {
          success: true,
          rowsAffected: Number(second.prepare(sql).run(...(params as SQLInputValue[])).changes),
        };
      },
    };
    const discovered = await runSqliteResourceDiscoveryStep({
      inventory: input.inventory,
      context: {
        ...input.context,
        operation: {
          ...input.context.operation,
          phase: 'discover_sqlite_resources',
          cursor_json: null,
        },
      },
    });
    await expect(
      runSqliteResourcePreparationStep({
        ...input,
        context: {
          ...input.context,
          operation: {
            ...input.context.operation,
            phase: discovered.phase,
            cursor_json: discovered.cursor,
          },
        },
        async resolveSource() {
          return { ...input.source, resourceId: 'wrong-resource' };
        },
      })
    ).rejects.toThrow('backup_resource_destination_changed');
    expect(
      sourceDb
        .prepare("SELECT count(*) n FROM sqlite_schema WHERE type='trigger' AND tbl_name='tenants'")
        .get()?.n
    ).toBe(0);
    const op = (await store.get('a', 'op'))!;
    const saved = await store.checkpoint(
      lease,
      op.revision,
      discovered.phase,
      discovered.cursor,
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
          workerId: `prepare-${slice}`,
          signal: input.context.signal,
        },
        {
          async run(context) {
            const result = await runSqliteResourcePreparationStep({
              ...input,
              context,
              inventory: new TenantBackupExecutionInventory(adapter, context.lease, () => now),
              async resolveSource(resource) {
                return {
                  resourceId: resource.resourceId,
                  database:
                    resource.resourceId === 'physical-a' ? input.source.database : secondAdapter,
                };
              },
            });
            if (slice === 0) throw new Error('lost progress');
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
      for (const database of [sourceDb, second])
        expect(database.prepare('SELECT count(*) n FROM tenant_backup_snapshots').get()?.n).toBe(0);
    }
    expect((await store.get('a', 'op'))?.phase).toBe('admit_snapshot_boundary');
    for (const file of [
      '005_tenant_backup_mutation_admission.sql',
      '006_tenant_backup_mutation_environment_scope.sql',
      '007_tenant_backup_boundary_receipts.sql',
      '010_tenant_backup_snapshot_timestamp.sql',
    ])
      db.exec(
        readFileSync(
          new URL(`../../../../../../migrations/control/d1/${file}`, import.meta.url),
          'utf8'
        )
      );
    for (let attempt = 0; attempt < 2; attempt++) {
      now += 40000;
      const executing = executeTenantBackupSlice(
        store,
        {
          tenantId: 'a',
          operationId: 'op',
          workerId: `boundary-${attempt}`,
          signal: input.context.signal,
        },
        {
          async run(context) {
            const args = {
              ...input,
              context,
              inventory: new TenantBackupExecutionInventory(adapter, context.lease, () => now),
              environmentId: 'env',
              boundaryTenantId: 'a',
              admission: new TenantBackupMutationAdmission(adapter, 'env'),
              receipts: new TenantBackupBoundaryReceipts(adapter),
              additionalParticipants: [],
              now: () => now,
              async assertReady() {},
              async assertCoverage(
                physical: readonly { resourceId: string }[],
                participants: readonly { resourceId: string }[]
              ) {
                expect(physical.map((r) => r.resourceId)).toEqual(['physical-a', 'physical-b']);
                expect(participants.map((r) => r.resourceId)).toEqual(['physical-a', 'physical-b']);
              },
              async resolveSource(resource: { resourceId: string }) {
                return {
                  resourceId: resource.resourceId,
                  database:
                    resource.resourceId === 'physical-a' ? input.source.database : secondAdapter,
                };
              },
            };
            if (attempt === 0) {
              await expect(
                runPreparedSnapshotBoundaryStep({
                  ...args,
                  context: {
                    ...context,
                    operation: {
                      ...context.operation,
                      cursor_json: JSON.stringify({
                        ...(JSON.parse(context.operation.cursor_json!) as Record<string, unknown>),
                        resourceIndex: 0,
                      }),
                    },
                  },
                })
              ).rejects.toThrow('preparation_incomplete');
              await expect(
                runPreparedSnapshotBoundaryStep({
                  ...args,
                  async assertCoverage() {
                    throw new Error('missing KV participant');
                  },
                })
              ).rejects.toThrow('missing KV participant');
              expect(
                db.prepare('SELECT count(*) n FROM tenant_backup_mutation_boundaries').get()?.n
              ).toBe(0);
            }
            const result = await runPreparedSnapshotBoundaryStep(args);
            expect(result.phase).toBe('prepare_export_artifact');
            if (attempt === 0) {
              sourceDb.exec("UPDATE tenants SET value='after' WHERE id='a'");
              throw new Error('lost boundary checkpoint');
            }
            return result;
          },
          async cleanup() {
            throw new Error('unexpected cleanup');
          },
        },
        () => now
      );
      if (attempt === 0) await expect(executing).rejects.toThrow('backup_operation_slice_failed');
      else await executing;
    }
    expect((await store.get('a', 'op'))?.phase).toBe('prepare_export_artifact');
    expect(db.prepare('SELECT count(*) n FROM tenant_backup_boundary_receipts').get()?.n).toBe(2);
    expect(db.prepare('SELECT count(*) n FROM tenant_backup_mutation_boundaries').get()?.n).toBe(1);
    for (const database of [sourceDb, second])
      expect(database.prepare('SELECT count(*) n FROM tenant_backup_snapshots').get()?.n).toBe(1);
    expect(sourceDb.prepare('SELECT count(*) n FROM tenant_backup_preimages').get()?.n).toBe(1);

    for (const database of [sourceDb, second])
      expect(
        database
          .prepare(
            "SELECT count(*) n FROM sqlite_schema WHERE type='trigger' AND tbl_name='tenants'"
          )
          .get()?.n
      ).toBe(3);
  } finally {
    sourceDb.close();
    second.close();
  }
});

it('connects real SQL snapshot start to durable boundary receipts and preserves its image after release', async () => {
  const { sourceDb, input } = await fixture();
  try {
    for (const file of [
      '005_tenant_backup_mutation_admission.sql',
      '006_tenant_backup_mutation_environment_scope.sql',
      '007_tenant_backup_boundary_receipts.sql',
      '010_tenant_backup_snapshot_timestamp.sql',
    ])
      db.exec(
        readFileSync(
          new URL(`../../../../../../migrations/control/d1/${file}`, import.meta.url),
          'utf8'
        )
      );
    const admission = new TenantBackupMutationAdmission(adapter, 'env');
    const receipts = new TenantBackupBoundaryReceipts(adapter);
    const head = await input.inventory.head();
    const identity = {
      environmentId: 'env',
      tenantId: 'a',
      boundaryId: 'boundary',
      operationId: 'op',
      inventoryDigest: head.chain_digest,
    };
    const participant = sqliteBoundaryParticipant(input);
    const released = await startTenantBackupSnapshotBoundary({
      identity,
      admission,
      receipts,
      participants: [participant],
      signal: input.context.signal,
      now: () => now,
      async assertReady() {
        await input.inventory.headForLease(lease);
      },
    });
    expect(released.state).toBe('released');
    expect(
      sourceDb.prepare("SELECT state FROM tenant_backup_snapshots WHERE id='snapshot-a'").get()
        ?.state
    ).toBe('capturing');
    expect(
      db
        .prepare(
          "SELECT snapshot_id FROM tenant_backup_boundary_receipts WHERE resource_id='physical-a'"
        )
        .get()?.snapshot_id
    ).toBe('snapshot-a');
    expect(await admission.acquire('a', 'new-write', now)).toBe(true);
    sourceDb.exec("UPDATE tenants SET value='after' WHERE id='a'");
    expect(sourceDb.prepare('SELECT count(*) n FROM tenant_backup_preimages').get()?.n).toBe(1);
    expect(await receipts.readReleased(identity, [participant], now)).not.toBeNull();
  } finally {
    sourceDb.close();
  }
});

it('reads only the owned planned snapshot and binds continuation to dataset, source and operation', async () => {
  const { sourceDb, input } = await fixture();
  try {
    await startTenantBackupSqliteCapture(input);
    sourceDb.exec("UPDATE tenants SET value='after' WHERE id='a'");
    let resolutions = 0;
    const args = {
      ...input,
      table: 'tenants',
      dataset: {
        id: 'core.tenants',
        module: 'tenant-runtime' as const,
        kind: 'settings' as const,
        store: 'database' as const,
        schemaVersion: 1,
        disposition: 'include' as const,
      },
      async resolveSource() {
        resolutions++;
        return input.source;
      },
      async assertSourceStable() {},
    };
    const first = await readNextPlannedSqliteDatasetChunk(args, null);
    expect(first).not.toBeNull();
    expect(new TextDecoder().decode(first!.bytes)).toContain('before');
    expect(new TextDecoder().decode(first!.bytes)).not.toContain('private');
    expect(await readNextPlannedSqliteDatasetChunk(args, first!.nextCursor)).toBeNull();
    expect(await readNextPlannedSqliteDatasetChunk(args, null)).toEqual(first);
    const before = resolutions;
    for (const changes of [
      { datasetId: 'other' },
      { resourceId: 'other' },
      { snapshotId: 'other' },
      { tenantId: 'other' },
      { operationId: 'other' },
      { inventoryDigest: 'ef'.repeat(32) },
    ]) {
      const cursor = JSON.stringify({
        ...(JSON.parse(first!.nextCursor) as Record<string, unknown>),
        ...changes,
      });
      await expect(readNextPlannedSqliteDatasetChunk(args, cursor)).rejects.toThrow(
        'reader_cursor'
      );
    }
    expect(resolutions).toBe(before);
    await expect(
      readNextPlannedSqliteDatasetChunk(
        {
          ...args,
          async resolveSource() {
            return { ...input.source, resourceId: 'other' };
          },
        },
        null
      )
    ).rejects.toThrow('destination_changed');
    await store.requestCancel('a', 'op', now);
    await expect(readNextPlannedSqliteDatasetChunk(args, null)).rejects.toThrow();
  } finally {
    sourceDb.close();
  }
});

it.each([false, true])(
  'continues across fixed shards with an empty first shard=%s',
  async (emptyFirst) => {
    const { sourceDb, input } = await fixture(true, true, true);
    const second = new DatabaseSync(':memory:');
    try {
      second.exec(
        "CREATE TABLE oauth_clients(id TEXT PRIMARY KEY NOT NULL,tenant_id TEXT NOT NULL,value TEXT); INSERT INTO oauth_clients VALUES ('client-b','a','second'),('foreign','b','private');"
      );
      second.exec(SQLITE_SNAPSHOT_SCHEMA);
      const secondAdapter = {
        async query<T>(sql: string, params: unknown[] = []) {
          return second.prepare(sql).all(...(params as SQLInputValue[])) as T[];
        },
        async queryOne<T>(sql: string, params: unknown[] = []) {
          return (second.prepare(sql).get(...(params as SQLInputValue[])) as T) ?? null;
        },
        async execute(sql: string, params: unknown[] = []) {
          return {
            success: true,
            rowsAffected: Number(second.prepare(sql).run(...(params as SQLInputValue[])).changes),
          };
        },
      };
      const other = {
        ...input,
        resourceId: 'physical-b',
        firstOrdinal: 1,
        snapshotId: 'snapshot-b',
        source: { resourceId: 'physical-b', database: secondAdapter },
      };
      await prepareTenantBackupSqliteCapture(other, 0);
      if (emptyFirst) sourceDb.exec("DELETE FROM oauth_clients WHERE tenant_id='a'");
      await startTenantBackupSqliteCapture(input);
      await startTenantBackupSqliteCapture(other);
      sourceDb.exec("UPDATE oauth_clients SET value='changed' WHERE tenant_id='a'");
      second.exec("UPDATE oauth_clients SET value='changed' WHERE tenant_id='a'");
      const shards = [
        { resourceId: 'physical-a', firstOrdinal: 0, snapshotId: 'snapshot-a' },
        { resourceId: 'physical-b', firstOrdinal: 1, snapshotId: 'snapshot-b' },
      ];
      const filteredResources: string[] = [];
      const args = {
        ...input,
        table: 'oauth_clients',
        dataset: {
          id: 'core.oauth_clients',
          module: 'applications' as const,
          kind: 'settings' as const,
          store: 'database' as const,
          schemaVersion: 1,
          disposition: 'include' as const,
        },
        shards,
        async assertResourceSet(actual: readonly { resourceId: string }[]) {
          expect(actual.map((s) => s.resourceId)).toEqual(['physical-a', 'physical-b']);
        },
        async assertSourceStable() {},
        async filterShardRow(shard: { resourceId: string }) {
          filteredResources.push(shard.resourceId);
          return true;
        },
        async resolveSource(shard: { resourceId: string }) {
          return shard.resourceId === 'physical-a' ? input.source : other.source;
        },
      };
      const first = await readNextShardedSqliteDatasetChunk(args, null);
      expect(first).not.toBeNull();
      const next = await readNextShardedSqliteDatasetChunk(
        { ...args, shards: [...shards].reverse() },
        first!.nextCursor
      );
      if (emptyFirst) {
        expect(new TextDecoder().decode(first!.bytes)).toContain('client-b');
        expect(next).toBeNull();
        expect(await readNextShardedSqliteDatasetChunk(args, null)).toEqual(first);
      } else {
        expect(next).not.toBeNull();
        expect(new TextDecoder().decode(first!.bytes)).toContain('client-a');
        expect(new TextDecoder().decode(next!.bytes)).toContain('client-b');
        expect(new TextDecoder().decode(next!.bytes)).not.toContain('changed');
        expect(new TextDecoder().decode(next!.bytes)).not.toContain('private');
        expect(await readNextShardedSqliteDatasetChunk(args, first!.nextCursor)).toEqual(next);
        expect(await readNextShardedSqliteDatasetChunk(args, next!.nextCursor)).toBeNull();
      }
      expect(new Set(filteredResources)).toEqual(
        new Set(emptyFirst ? ['physical-b'] : ['physical-a', 'physical-b'])
      );
      await expect(
        readNextShardedSqliteDatasetChunk(
          { ...args, shards: shards.slice(0, 1) },
          first!.nextCursor
        )
      ).rejects.toThrow('shards_cursor');
      await expect(
        readNextShardedSqliteDatasetChunk(
          { ...args, shards: [shards[0], { ...shards[1], snapshotId: 'replacement' }] },
          first!.nextCursor
        )
      ).rejects.toThrow('shards_cursor');
      await expect(
        readNextShardedSqliteDatasetChunk(
          {
            ...args,
            async assertResourceSet() {
              throw new Error('missing required shard');
            },
          },
          null
        )
      ).rejects.toThrow('missing required shard');
    } finally {
      sourceDb.close();
      second.close();
    }
  }
);
