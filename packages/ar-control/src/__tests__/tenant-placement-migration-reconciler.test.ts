import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ControlService } from '../service';
import { buildTenantMigrationCapturePlan } from '../tenant-placement-migration-capture';
import type { TenantMigrationTableInventory } from '../tenant-placement-migration-inventory';
import {
  TENANT_PLACEMENT_SOURCE_RETENTION_SECONDS,
  TenantPlacementMigrationService,
} from '../tenant-placement-migration';
import { TenantPlacementMigrationReconciler } from '../tenant-placement-migration-reconciler';
import type { TenantMigrationTransferExecutor } from '../tenant-placement-migration-transfer';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
type SqlValue = string | number | bigint | null | Uint8Array;

function values(input: readonly unknown[] = []): SqlValue[] {
  return input.map((value) => {
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

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly bound: SqlValue[]
  ) {}

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.bound) as T | undefined) ?? null;
  }

  async all<T>() {
    return {
      success: true,
      results: this.statement.all(...this.bound) as T[],
      meta: { changes: 0 },
    };
  }

  async run() {
    return this.executeRun();
  }

  executeRun() {
    const result = this.statement.run(...this.bound);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class PreparedStatement {
  constructor(private readonly statement: StatementSync) {}

  bind(...bound: unknown[]): BoundStatement {
    return new BoundStatement(this.statement, values(bound));
  }
}

function controlD1(database: DatabaseSync): D1Database {
  const session = {
    prepare(sql: string) {
      return new PreparedStatement(database.prepare(sql));
    },
  };
  return {
    ...session,
    withSession: () => session,
    async batch(statements: unknown[]) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => {
          if (!(statement instanceof BoundStatement)) throw new Error('invalid_test_statement');
          return statement.executeRun();
        });
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

class SqliteTransferExecutor implements TenantMigrationTransferExecutor {
  constructor(private readonly databases: ReadonlyMap<string, DatabaseSync>) {}

  async queryD1(databaseId: string, sql: string, params?: unknown[]) {
    const database = this.databases.get(databaseId);
    if (!database) throw new Error('test_database_missing');
    const statement = database.prepare(sql);
    if (/^\s*(?:SELECT|PRAGMA)\b/iu.test(sql)) {
      return [{ success: true, results: statement.all(...values(params)) }];
    }
    const result = statement.run(...values(params));
    return [{ success: true, results: [], meta: { changes: Number(result.changes) } }];
  }

  async queryD1Batch(databaseId: string, batch: readonly { sql: string; params?: unknown[] }[]) {
    const results = [];
    for (const query of batch) {
      results.push(...(await this.queryD1(databaseId, query.sql, query.params)));
    }
    return results;
  }
}

const inventories: ReadonlyArray<{
  role: 'tenant_core/default' | 'tenant_core/users' | 'tenant_pii';
  table: TenantMigrationTableInventory;
  create: string;
  insert: string;
}> = [
  {
    role: 'tenant_core/default',
    table: {
      table: 'tenants',
      columns: [
        { name: 'id', primaryKeyPosition: 1 },
        { name: 'tenant_key', primaryKeyPosition: 0 },
        { name: 'name', primaryKeyPosition: 0 },
      ],
      primaryKey: ['id'],
      ownership: { kind: 'tenant_row', column: 'id' },
      disposition: 'migrate',
      foreignKeys: [],
    },
    create:
      'CREATE TABLE tenants (id TEXT PRIMARY KEY, tenant_key TEXT NOT NULL, name TEXT NOT NULL)',
    insert: "INSERT INTO tenants VALUES ('tenant-a', 'tenant-key-a', 'Tenant A')",
  },
  {
    role: 'tenant_core/users',
    table: {
      table: 'identity_accounts',
      columns: [
        { name: 'id', primaryKeyPosition: 1 },
        { name: 'tenant_id', primaryKeyPosition: 0 },
        { name: 'display_name', primaryKeyPosition: 0 },
      ],
      primaryKey: ['id'],
      ownership: { kind: 'tenant_column', column: 'tenant_id' },
      disposition: 'migrate',
      foreignKeys: [],
    },
    create:
      'CREATE TABLE identity_accounts (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, display_name TEXT NOT NULL)',
    insert: "INSERT INTO identity_accounts VALUES ('account-a', 'tenant-a', 'Account A')",
  },
  {
    role: 'tenant_pii',
    table: {
      table: 'users_pii',
      columns: [
        { name: 'id', primaryKeyPosition: 1 },
        { name: 'tenant_id', primaryKeyPosition: 0 },
        { name: 'email', primaryKeyPosition: 0 },
      ],
      primaryKey: ['id'],
      ownership: { kind: 'tenant_column', column: 'tenant_id' },
      disposition: 'migrate',
      foreignKeys: [],
    },
    create:
      'CREATE TABLE users_pii (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, email TEXT NOT NULL)',
    insert: "INSERT INTO users_pii VALUES ('user-a', 'tenant-a', 'a@example.test')",
  },
];

describe('tenant placement migration verification and write fence', () => {
  let control: DatabaseSync;
  let physical: Map<string, DatabaseSync>;
  let reconciler: TenantPlacementMigrationReconciler;

  beforeEach(async () => {
    control = new DatabaseSync(':memory:');
    for (const file of [
      '001_control_plane.sql',
      '006_tenant_default_allocations.sql',
      '011_tenant_physical_isolation.sql',
      '012_tenant_placement_migrations.sql',
    ]) {
      control.exec(readFileSync(resolve(REPO_ROOT, 'migrations/control', file), 'utf8'));
    }
    control.exec(`
      INSERT INTO control_environments (
        environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
      ) VALUES ('env-test', 'test', 'urn:authrim:control:env-test', 'active', 1, 1);
      INSERT INTO control_residency_partitions (
        environment_id, residency_policy_id, residency_partition, status, created_at, updated_at
      ) VALUES ('env-test', 'default', 'jp', 'active', 1, 1);
      INSERT INTO control_environment_resource_policies (
        environment_id, max_concurrent_provisioning, max_ready_spares, max_d1_resources,
        daily_d1_create_budget, target_account_count, created_at, updated_at
      ) VALUES ('env-test', 10, 10, 100, 100, 100000, 1, 1);
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, attempt_count, created_at, completed_at, updated_at
      ) VALUES (
        'op-seed', 'env-test', 'tenant_shard_provision', 'op-seed',
        'succeeded', 'setup', 1, 1, 1, 1
      ), (
        'op-migration', 'env-test', 'tenant_placement_migration', 'op-migration',
        'running', 'admin', 1, 1, NULL, 1
      );
      INSERT INTO control_tenant_placement_policies (
        environment_id, tenant_id, isolation_policy, policy_generation, policy_state,
        source_operation_id, idempotency_key, activated_at, created_at, updated_at
      ) VALUES (
        'env-test', 'tenant-a', 'shared_pool', 1, 'active',
        'tenant-create-a', 'tenant-create-a', 1, 1, 1
      );
    `);

    physical = new Map();
    const captureSql = readFileSync(
      resolve(REPO_ROOT, 'migrations/040_tenant_placement_migration_outbox.sql'),
      'utf8'
    );
    for (const [index, fixture] of inventories.entries()) {
      const sourceId = `source-db-${index}`;
      const targetId = `target-db-${index}`;
      const source = new DatabaseSync(':memory:');
      const target = new DatabaseSync(':memory:');
      source.exec(captureSql);
      source.exec(fixture.create);
      target.exec(fixture.create);
      source.exec(fixture.insert);
      target.exec(fixture.insert);
      physical.set(sourceId, source);
      physical.set(targetId, target);

      control
        .prepare(
          `INSERT INTO control_desired_resources (
             desired_resource_id, environment_id, resource_kind, logical_shard_id,
             deterministic_name, ownership_fingerprint, provisioning_state,
             origin_operation_id, created_at, updated_at
           ) VALUES (?, 'env-test', 'd1', ?, ?, ?, 'active', 'op-seed', 1, 1)`
        )
        .run(
          `source-desired-${index}`,
          `source-shard-${index}`,
          `source-shard-${index}-db`,
          `source-shard-${index}-owner`
        );
      control
        .prepare(
          `INSERT INTO control_observed_resources (
             observed_resource_id, environment_id, desired_resource_id, provider_resource_id,
             provider_name, resource_kind, ownership_fingerprint, observed_state, observed_at
           ) VALUES (?, 'env-test', ?, ?, ?, 'd1', ?, 'present', 1)`
        )
        .run(
          `source-observed-${index}`,
          `source-desired-${index}`,
          sourceId,
          `source-shard-${index}-db`,
          `source-shard-${index}-owner`
        );
      control
        .prepare(
          `INSERT INTO control_tenant_shards (
             shard_id, environment_id, data_role, residency_policy_id, residency_partition,
             generation, logical_shard_id, binding_ref, d1_desired_resource_id,
             status, created_at, updated_at, allocation_scope, owner_tenant_id
           ) VALUES (?, 'env-test', ?, 'default', 'jp', 1, ?, ?, ?,
                     'active', 1, 1, 'shared_pool', NULL)`
        )
        .run(
          `source-shard-${index}`,
          fixture.role,
          `source-shard-${index}`,
          `TDB_SOURCE_${index}`,
          `source-desired-${index}`
        );
      control
        .prepare(
          `INSERT INTO control_tenant_shard_assignments (
             environment_id, tenant_id, data_role, residency_policy_id, residency_partition,
             shard_id, assignment_generation, assignment_state, source_operation_id,
             created_at, activated_at, updated_at
           ) VALUES ('env-test', 'tenant-a', ?, 'default', 'jp', ?, 1, 'active',
                     'tenant-create-a', 1, 1, 1)`
        )
        .run(fixture.role, `source-shard-${index}`);
    }
    control.exec(`
      INSERT INTO control_tenant_default_allocations (
        allocation_id, environment_id, tenant_id, residency_policy_id, residency_partition,
        selected_shard_id, reservation_state, idempotency_key, route_generation,
        capacity_counted_at, created_at, committed_at, updated_at
      ) VALUES (
        'default-allocation-a', 'env-test', 'tenant-a', 'default', 'jp',
        'source-shard-0', 'committed', 'default-allocation-a', 1, 1, 1, 1, 1
      );
      INSERT INTO control_tenant_shard_allocations (
        allocation_id, environment_id, tenant_id, account_id_blind_digest, data_role,
        residency_partition, selected_shard_id, reservation_state, idempotency_key,
        route_generation, capacity_counted_at, created_at, committed_at, updated_at
      ) VALUES (
        'account-users-a', 'env-test', 'tenant-a', 'digest-a', 'tenant_core/users',
        'jp', 'source-shard-1', 'committed', 'account-a', 1, 1, 1, 1, 1
      ), (
        'account-pii-a', 'env-test', 'tenant-a', 'digest-a', 'tenant_pii',
        'jp', 'source-shard-2', 'committed', 'account-a', 1, 1, 1, 1, 1
      );
    `);

    control.exec(`
      INSERT INTO control_tenant_placement_migrations (
        operation_id, environment_id, tenant_id, source_policy_generation,
        target_policy_generation, source_isolation_policy, target_isolation_policy,
        migration_state, active_operation_key, idempotency_key, inventory_digest,
        inventory_verified_at, created_by, created_at, updated_at
      ) VALUES (
        'op-migration', 'env-test', 'tenant-a', 1, 2, 'shared_pool', 'tenant_exclusive',
        'planning', 'active', 'op-migration', '${'a'.repeat(64)}', 1, 'admin-a', 1, 1
      );
      UPDATE control_tenant_placement_policies
         SET policy_state = 'migrating', pending_isolation_policy = 'tenant_exclusive',
             pending_policy_generation = 2, migration_operation_id = 'op-migration', updated_at = 2
       WHERE environment_id = 'env-test' AND tenant_id = 'tenant-a';
    `);

    const executor = new SqliteTransferExecutor(physical);
    for (const [index, fixture] of inventories.entries()) {
      control
        .prepare(
          `INSERT INTO control_desired_resources (
             desired_resource_id, environment_id, resource_kind, logical_shard_id,
             deterministic_name, ownership_fingerprint, provisioning_state,
             origin_operation_id, created_at, updated_at
           ) VALUES (?, 'env-test', 'd1', ?, ?, ?, 'active', 'op-seed', 2, 2)`
        )
        .run(
          `target-desired-${index}`,
          `target-shard-${index}`,
          `target-shard-${index}-db`,
          `target-shard-${index}-owner`
        );
      control
        .prepare(
          `INSERT INTO control_observed_resources (
             observed_resource_id, environment_id, desired_resource_id, provider_resource_id,
             provider_name, resource_kind, ownership_fingerprint, observed_state, observed_at
           ) VALUES (?, 'env-test', ?, ?, ?, 'd1', ?, 'present', 2)`
        )
        .run(
          `target-observed-${index}`,
          `target-desired-${index}`,
          `target-db-${index}`,
          `target-shard-${index}-db`,
          `target-shard-${index}-owner`
        );
      control
        .prepare(
          `INSERT INTO control_tenant_shards (
             shard_id, environment_id, data_role, residency_policy_id, residency_partition,
             generation, logical_shard_id, binding_ref, d1_desired_resource_id,
             status, created_at, updated_at, allocation_scope, owner_tenant_id
           ) VALUES (?, 'env-test', ?, 'default', 'jp', 1, ?, ?, ?,
                     'active', 2, 2, 'tenant_exclusive', 'tenant-a')`
        )
        .run(
          `target-shard-${index}`,
          fixture.role,
          `target-shard-${index}`,
          `TDB_TARGET_${index}`,
          `target-desired-${index}`
        );
      control
        .prepare(
          `INSERT INTO control_tenant_shard_assignments (
             environment_id, tenant_id, data_role, residency_policy_id, residency_partition,
             shard_id, assignment_generation, assignment_state, source_operation_id,
             created_at, updated_at
           ) VALUES ('env-test', 'tenant-a', ?, 'default', 'jp', ?, 2, 'pending',
                     'op-migration', 2, 2)`
        )
        .run(fixture.role, `target-shard-${index}`);
      control
        .prepare(
          `INSERT INTO control_tenant_placement_migration_shards (
             operation_id, environment_id, tenant_id, data_role, residency_policy_id,
             residency_partition, source_shard_id, source_assignment_generation,
             target_shard_id, target_assignment_generation, shard_state, table_cursor_json,
             last_observed_source_sequence, last_applied_source_sequence,
             capture_fencing_token, inventory_table_count, inventory_verified_at,
             capture_installed_at, created_at, updated_at
           ) VALUES (
             'op-migration', 'env-test', 'tenant-a', ?, 'default', 'jp', ?, 1, ?, 2,
             'verifying', ?, 0, 0, 7, 1, 2, 2, 2, 2
           )`
        )
        .run(
          fixture.role,
          `source-shard-${index}`,
          `target-shard-${index}`,
          JSON.stringify({
            phase: 'preliminary',
            tableIndex: 0,
            cursor: null,
            rowCount: 0,
            checksum: '0'.repeat(64),
            baselineSequence: 0,
          })
        );
      control
        .prepare(
          `INSERT INTO control_tenant_placement_migration_inventory (
             operation_id, source_shard_id, table_name, ownership_kind, disposition,
             primary_key_json, columns_json, foreign_keys_json, ownership_json,
             columns_digest, inventory_state, observed_at
           ) VALUES (
             'op-migration', ?, ?, ?, 'migrate', ?, ?, '[]', ?, ?, 'verified', 2
           )`
        )
        .run(
          `source-shard-${index}`,
          fixture.table.table,
          fixture.table.ownership.kind,
          JSON.stringify(fixture.table.primaryKey),
          JSON.stringify(fixture.table.columns),
          JSON.stringify(fixture.table.ownership),
          'b'.repeat(64)
        );
      const plan = await buildTenantMigrationCapturePlan({
        operationId: 'op-migration',
        tenantId: 'tenant-a',
        tenantKey: 'tenant-key-a',
        sourceShardId: `source-shard-${index}`,
        migrationGeneration: 2,
        fencingToken: 7,
        inventory: [fixture.table],
        now: 2,
      });
      await executor.queryD1Batch(`source-db-${index}`, plan.install);
    }
    for (const state of [
      'targets_provisioning',
      'inventory_verifying',
      'capture_installing',
      'backfilling',
      'catching_up',
      'verifying',
    ]) {
      control
        .prepare('UPDATE control_tenant_placement_migrations SET migration_state = ?')
        .run(state);
    }

    reconciler = new TenantPlacementMigrationReconciler(
      controlD1(control),
      {} as ControlService,
      executor,
      () => 100
    );
  });

  afterEach(() => {
    control.close();
    for (const database of physical.values()) database.close();
  });

  it('reaches cutover-ready only after all roles are verified and fenced', async () => {
    for (let index = 0; index < 20; index += 1) await reconciler.reconcile(1);

    expect(
      control
        .prepare(
          `SELECT migration_state, write_fence_state
             FROM control_tenant_placement_migrations WHERE operation_id = 'op-migration'`
        )
        .get()
    ).toEqual({ migration_state: 'cutover_ready', write_fence_state: 'active' });
    expect(
      control
        .prepare(
          `SELECT data_role, shard_state, source_row_count, target_row_count
             FROM control_tenant_placement_migration_shards ORDER BY data_role`
        )
        .all()
    ).toEqual([
      {
        data_role: 'tenant_core/default',
        shard_state: 'write_fenced',
        source_row_count: 1,
        target_row_count: 1,
      },
      {
        data_role: 'tenant_core/users',
        shard_state: 'write_fenced',
        source_row_count: 1,
        target_row_count: 1,
      },
      {
        data_role: 'tenant_pii',
        shard_state: 'write_fenced',
        source_row_count: 1,
        target_row_count: 1,
      },
    ]);

    const ready = await new TenantPlacementMigrationService(controlD1(control), () => 109).get(
      'env-test',
      'op-migration'
    );
    expect(ready?.shards[0]).toMatchObject({
      sourceAssignmentGeneration: 1,
      target: {
        shardId: 'target-shard-0',
        assignmentGeneration: 2,
        routeGeneration: 1,
        bindingRef: 'TDB_TARGET_0',
        databaseId: 'target-db-0',
        databaseName: 'target-shard-0-db',
      },
    });
    expect(ready).toMatchObject({ routeCutoverStarted: false, canCancel: true });

    const migrationService = new TenantPlacementMigrationService(controlD1(control), () => 109);
    const routeCutover = await migrationService.beginRouteCutover('env-test', {
      operationId: 'op-migration',
      requestedById: 'admin-a',
      idempotencyKey: 'route-cutover-a',
    });
    expect(routeCutover).toMatchObject({ routeCutoverStarted: true, canCancel: false });
    expect(
      control
        .prepare(
          `SELECT event_type, actor_id, redacted_payload_json
             FROM control_audit_events
            WHERE operation_id = 'op-migration'
              AND event_type = 'tenant_placement_migration.route_cutover_started'`
        )
        .get()
    ).toEqual({
      event_type: 'tenant_placement_migration.route_cutover_started',
      actor_id: 'admin-a',
      redacted_payload_json: '{}',
    });

    const committed = await new TenantPlacementMigrationService(
      controlD1(control),
      () => 110
    ).commitCutover('env-test', {
      operationId: 'op-migration',
      requestedById: 'admin-a',
      idempotencyKey: 'cutover-a',
    });
    expect(committed).toMatchObject({ state: 'cutover_committed', canCancel: false });
    expect(
      control
        .prepare(
          `SELECT isolation_policy, policy_generation, policy_state
             FROM control_tenant_placement_policies WHERE tenant_id = 'tenant-a'`
        )
        .get()
    ).toEqual({
      isolation_policy: 'tenant_exclusive',
      policy_generation: 2,
      policy_state: 'active',
    });
    expect(
      control
        .prepare(
          `SELECT data_role, selected_shard_id
             FROM control_tenant_shard_allocations ORDER BY data_role`
        )
        .all()
    ).toEqual([
      { data_role: 'tenant_core/users', selected_shard_id: 'target-shard-1' },
      { data_role: 'tenant_pii', selected_shard_id: 'target-shard-2' },
    ]);
    expect(
      control
        .prepare(
          `SELECT assignment_state, COUNT(*) AS count
             FROM control_tenant_shard_assignments GROUP BY assignment_state ORDER BY assignment_state`
        )
        .all()
    ).toEqual([
      { assignment_state: 'active', count: 3 },
      { assignment_state: 'quarantined', count: 3 },
    ]);

    const finalized = await new TenantPlacementMigrationService(controlD1(control), () => 111, {
      sourceD1: new SqliteTransferExecutor(physical),
    }).finalizeCutover('env-test', {
      operationId: 'op-migration',
      requestedById: 'admin-a',
      idempotencyKey: 'finalize-a',
    });
    expect(finalized).toMatchObject({
      state: 'source_quarantined',
      writeFenceState: 'released',
      routeCutoverStarted: false,
      canCancel: false,
    });
    expect(
      control.prepare('SELECT COUNT(*) AS count FROM control_directory_rewrite_leases').get()
    ).toEqual({ count: 0 });

    const usersSource = physical.get('source-db-1')!;
    expect(() =>
      usersSource
        .prepare("UPDATE identity_accounts SET display_name = 'blocked' WHERE id = 'account-a'")
        .run()
    ).toThrow('tenant_placement_migration_write_fenced');
    usersSource
      .prepare(
        "INSERT INTO identity_accounts VALUES ('account-b', 'tenant-b', 'Other tenant remains writable')"
      )
      .run();
    expect(
      usersSource.prepare("SELECT display_name FROM identity_accounts WHERE id = 'account-b'").get()
    ).toEqual({ display_name: 'Other tenant remains writable' });

    await expect(
      new TenantPlacementMigrationService(controlD1(control), () => 112).approvePurge('env-test', {
        operationId: 'op-migration',
        requestedById: 'admin-a',
        idempotencyKey: 'purge-too-early',
      })
    ).rejects.toThrow('control_tenant_placement_migration_purge_not_allowed');

    const purgeNow = 111 + TENANT_PLACEMENT_SOURCE_RETENTION_SECONDS + 1;
    const approved = await new TenantPlacementMigrationService(
      controlD1(control),
      () => purgeNow
    ).approvePurge('env-test', {
      operationId: 'op-migration',
      requestedById: 'admin-a',
      idempotencyKey: 'purge-a',
    });
    expect(approved).toMatchObject({ state: 'purge_pending', canApprovePurge: false });
    expect(
      control
        .prepare(
          `SELECT event_type, actor_type, actor_id, redacted_payload_json
             FROM control_audit_events
            WHERE event_type = 'tenant_placement_migration.source_purge_approved'`
        )
        .get()
    ).toEqual({
      event_type: 'tenant_placement_migration.source_purge_approved',
      actor_type: 'admin',
      actor_id: 'admin-a',
      redacted_payload_json: '{}',
    });

    const purgeReconciler = new TenantPlacementMigrationReconciler(
      controlD1(control),
      {} as ControlService,
      new SqliteTransferExecutor(physical),
      () => purgeNow + 1
    );
    for (let index = 0; index < 20; index += 1) await purgeReconciler.reconcile(1);

    expect(
      control
        .prepare(
          `SELECT migration_state, active_operation_key, completed_at
             FROM control_tenant_placement_migrations WHERE operation_id = 'op-migration'`
        )
        .get()
    ).toEqual({
      migration_state: 'complete',
      active_operation_key: null,
      completed_at: purgeNow + 1,
    });
    expect(
      control
        .prepare(
          `SELECT shard_state, COUNT(*) AS count
             FROM control_tenant_placement_migration_shards GROUP BY shard_state`
        )
        .get()
    ).toEqual({ shard_state: 'purged', count: 3 });
    expect(
      control
        .prepare(
          `SELECT assignment_state, COUNT(*) AS count
             FROM control_tenant_shard_assignments GROUP BY assignment_state ORDER BY assignment_state`
        )
        .all()
    ).toEqual([
      { assignment_state: 'active', count: 3 },
      { assignment_state: 'retired', count: 3 },
    ]);
    expect(physical.get('source-db-0')!.prepare('SELECT * FROM tenants').all()).toEqual([]);
    expect(
      usersSource.prepare('SELECT id, tenant_id FROM identity_accounts ORDER BY id').all()
    ).toEqual([{ id: 'account-b', tenant_id: 'tenant-b' }]);
    expect(physical.get('source-db-2')!.prepare('SELECT * FROM users_pii').all()).toEqual([]);
    expect(physical.get('target-db-0')!.prepare('SELECT id FROM tenants').all()).toEqual([
      { id: 'tenant-a' },
    ]);
    expect(
      control
        .prepare(
          `SELECT event_type, actor_type, actor_id, redacted_payload_json
             FROM control_audit_events
            WHERE event_type = 'tenant_placement_migration.source_purge_complete'`
        )
        .get()
    ).toEqual({
      event_type: 'tenant_placement_migration.source_purge_complete',
      actor_type: 'system',
      actor_id: 'control-worker',
      redacted_payload_json: '{}',
    });
  });

  it('rejects route cutover while another directory rewrite owns the environment lease', async () => {
    for (let index = 0; index < 20; index += 1) await reconciler.reconcile(1);
    await expect(
      new TenantPlacementMigrationService(controlD1(control), () => 109).commitCutover('env-test', {
        operationId: 'op-migration',
        requestedById: 'admin-a',
        idempotencyKey: 'cutover-without-route-lease',
      })
    ).rejects.toThrow('control_tenant_placement_migration_route_lease_required');
    control.exec(`
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, attempt_count, created_at, updated_at
      ) VALUES (
        'lookup-rewrite', 'env-test', 'lookup_bucket_migration', 'lookup-rewrite',
        'running', 'scheduler', 1, 100, 100
      );
      INSERT INTO control_directory_rewrite_leases (
        environment_id, operation_id, operation_kind, owner_id, fencing_token,
        checkpoint_json, lease_expires_at, mutation_started, updated_at
      ) VALUES (
        'env-test', 'lookup-rewrite', 'lookup_bucket_migration', 'lookup-worker', 1,
        '{}', 500, 1, 100
      );
    `);

    await expect(
      new TenantPlacementMigrationService(controlD1(control), () => 109).beginRouteCutover(
        'env-test',
        {
          operationId: 'op-migration',
          requestedById: 'admin-a',
          idempotencyKey: 'route-cutover-conflict',
        }
      )
    ).rejects.toThrow('control_tenant_placement_migration_route_lease_conflict');
  });

  it('fails closed on a stable target mismatch before starting the write fence', async () => {
    physical
      .get('target-db-2')!
      .prepare("UPDATE users_pii SET email = 'wrong@example.test' WHERE id = 'user-a'")
      .run();

    for (let index = 0; index < 12; index += 1) await reconciler.reconcile(1);

    expect(
      control
        .prepare(
          `SELECT migration_state, write_fence_state, last_error_code
             FROM control_tenant_placement_migrations WHERE operation_id = 'op-migration'`
        )
        .get()
    ).toEqual({
      migration_state: 'blocked',
      write_fence_state: 'inactive',
      last_error_code: 'control_tenant_placement_verification_mismatch',
    });
  });
});
