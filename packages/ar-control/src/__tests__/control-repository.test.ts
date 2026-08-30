import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { D1ControlRepository } from '../repository';
import { D1WorkerBindingRepository } from '../worker-binding-repository';
import type { TenantShardPlan } from '../types';

type SqliteValue = string | number | null | Uint8Array;

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('required_test_value_missing');
  return value;
}

function sqliteValues(values: unknown[]): SqliteValue[] {
  return values.map((value) => {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      value === null ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    throw new Error('unsupported_test_sqlite_value');
  });
}

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqliteValue[],
    private readonly readOnly: boolean
  ) {}

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async all<T>() {
    return {
      success: true,
      results: this.statement.all(...this.values) as T[],
      meta: { changes: 0 },
    };
  }

  async run() {
    const result = this.statement.run(...this.values);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    };
  }

  executeRun() {
    if (this.readOnly) {
      return {
        success: true,
        results: this.statement.all(...this.values),
        meta: { changes: 0 },
      };
    }
    const result = this.statement.run(...this.values);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    };
  }
}

class PreparedStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly readOnly: boolean
  ) {}

  bind(...values: unknown[]): BoundStatement {
    return new BoundStatement(this.statement, sqliteValues(values), this.readOnly);
  }
}

function d1Adapter(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return new PreparedStatement(
        database.prepare(sql),
        /^\s*(?:SELECT|PRAGMA|EXPLAIN)\b/iu.test(sql)
      );
    },
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

function plan(suffix: string): TenantShardPlan {
  return {
    operationId: `op-${suffix}`,
    desiredResourceId: `resource-${suffix}`,
    shardId: `shard-${suffix}`,
    environmentId: 'env-test',
    environmentName: 'test',
    dataRole: 'tenant_core/users',
    residencyPolicyId: 'default',
    residencyPartition: 'jp',
    lookupCapacityDomainId: null,
    logicalShardId: `users:jp:${suffix}`,
    databaseName: `authrim-test-users-jp-${suffix}`,
    bindingRef: `TDB_USERS_${suffix.toUpperCase()}`,
    ownershipFingerprint: `fingerprint-${suffix}`,
    allocationScope: 'shared_pool',
    ownerTenantId: null,
    locationHint: 'apac',
    readReplicationMode: 'disabled',
    migrationStreamId: 'd1-core',
    idempotencyKey: `idempotency-${suffix}`,
  };
}

function insertRollbackFailedBinding(
  database: DatabaseSync,
  shardPlan: TenantShardPlan,
  options: { workerScriptName?: string; errorCode?: string } = {}
): void {
  const workerScriptName = options.workerScriptName ?? 'ar-auth-test';
  const errorCode = options.errorCode ?? 'control_worker_rollback_failed';
  database
    .prepare(
      `INSERT INTO control_desired_worker_inventory (
         environment_id, worker_script_name, package_name, deployment_target,
         capability_manifest_digest, source_manifest_path, source_manifest_hash,
         generated_artifact_hash, source_kind, source_reference,
         registered_by_operation_id, registered_by, registered_at
       ) VALUES (
         'env-test', ?, '@authrim/ar-auth', ?, ?,
         'packages/ar-auth/authrim.worker-capabilities.json', ?, ?,
         'core_manifest', '@authrim/ar-auth', 'op-release', 'setup:test', 140
       )`
    )
    .run(workerScriptName, workerScriptName, 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64));
  database
    .prepare(
      `INSERT INTO control_worker_binding_reconciliations (
         operation_id, environment_id, worker_script_name, shard_id, binding_ref,
         data_role, residency_partition, migration_generation, provider_database_id,
         state, expected_source_version_id, previous_deployment_id,
         patch_result_version_id, patch_result_deployment_id,
         previous_restore_settings_json, last_error_code, created_at, updated_at
       ) VALUES (?, 'env-test', ?, ?, ?, 'tenant_core/users', 'jp', 1,
                 'provider-database-id', 'blocked', 'version-before', 'deployment-before',
                 'version-patched', 'deployment-patched', ?, ?, 150, 150)`
    )
    .run(
      shardPlan.operationId,
      workerScriptName,
      shardPlan.shardId,
      shardPlan.bindingRef,
      JSON.stringify({ bindings: [{ name: 'existing-binding', type: 'plain_text' }] }),
      errorCode
    );
  database
    .prepare(
      `UPDATE control_operations
          SET status = 'blocked', last_error_code = ?, updated_at = 150
        WHERE operation_id = ?`
    )
    .run(errorCode, shardPlan.operationId);
  database
    .prepare(
      `UPDATE control_operation_steps
          SET status = CASE
                WHEN step_key = 'create_d1' THEN 'skipped'
                WHEN step_key = 'apply_migrations' THEN 'skipped'
                ELSE 'blocked'
              END,
              last_error_code = CASE
                WHEN step_key IN ('reconcile_worker_bindings', 'smoke_bindings', 'stabilize_bindings')
                THEN ? ELSE NULL END,
              updated_at = 150
        WHERE operation_id = ?`
    )
    .run(errorCode, shardPlan.operationId);
  database
    .prepare(
      `UPDATE control_tenant_shards SET status = 'failed', updated_at = 150 WHERE shard_id = ?`
    )
    .run(shardPlan.shardId);
}

function insertRejectedWorkerSettingsBinding(
  database: DatabaseSync,
  shardPlan: TenantShardPlan,
  errorCode = 'control_worker_settings_request_rejected'
): void {
  database
    .prepare(
      `INSERT INTO control_desired_worker_inventory (
         environment_id, worker_script_name, package_name, deployment_target,
         capability_manifest_digest, source_manifest_path, source_manifest_hash,
         generated_artifact_hash, source_kind, source_reference,
         registered_by_operation_id, registered_by, registered_at
       ) VALUES (
         'env-test', 'test-ar-auth', '@authrim/ar-auth', 'test-ar-auth', ?,
         'packages/ar-auth/authrim.worker-capabilities.json', ?, ?,
         'core_manifest', '@authrim/ar-auth', 'op-release', 'setup:test', 140
       )`
    )
    .run('b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64));
  database
    .prepare(
      `INSERT INTO control_worker_binding_reconciliations (
         operation_id, environment_id, worker_script_name, shard_id, binding_ref,
         data_role, residency_partition, migration_generation, provider_database_id,
         state, expected_source_version_id, previous_deployment_id,
         previous_restore_settings_json, last_error_code, created_at, updated_at
       ) VALUES (?, 'env-test', 'test-ar-auth', ?, ?, 'tenant_core/users', 'jp', 1,
                 'provider-database-id', 'blocked', 'version-before', 'deployment-before',
                 ?, ?, 150, 150)`
    )
    .run(
      shardPlan.operationId,
      shardPlan.shardId,
      shardPlan.bindingRef,
      JSON.stringify({ bindings: [{ name: 'DB', type: 'inherit', version_id: 'version-before' }] }),
      errorCode
    );
  database
    .prepare(
      `INSERT INTO control_worker_deployment_leases (
         environment_id, worker_script_name, owner_operation_id, fencing_token,
         lease_expires_at, expected_source_version_id, previous_deployment_id,
         mutation_started, updated_at
       ) VALUES ('env-test', 'test-ar-auth', ?, 1, 450, 'version-before',
                 'deployment-before', 1, 150)`
    )
    .run(shardPlan.operationId);
  database
    .prepare(
      `UPDATE control_operations
          SET status = 'blocked', last_error_code = ?, updated_at = 150
        WHERE operation_id = ?`
    )
    .run(errorCode, shardPlan.operationId);
  database
    .prepare(
      `UPDATE control_operation_steps
          SET status = CASE
                WHEN step_key IN ('create_d1', 'apply_migrations') THEN 'skipped'
                ELSE 'blocked'
              END,
              last_error_code = CASE WHEN step_key = 'reconcile_worker_bindings' THEN ? ELSE NULL END,
              updated_at = 150
        WHERE operation_id = ?`
    )
    .run(errorCode, shardPlan.operationId);
}

describe('D1ControlRepository lease and budget integration', () => {
  let database: DatabaseSync;
  let repository: D1ControlRepository;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/control/001_pre_1_0_control_baseline.sql'),
        'utf8'
      )
    );
    database.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/control/002_lookup_predictive_scale_out.sql'),
        'utf8'
      )
    );
    database.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/control/003_worker_binding_patch_intent_recovery.sql'),
        'utf8'
      )
    );
    database.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/control/004_worker_binding_reconciler_lease.sql'),
        'utf8'
      )
    );
    database.exec(
      `INSERT INTO control_environments (
         environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
       ) VALUES ('env-test', 'test', 'urn:authrim:control:env-test', 'active', 1, 1);
       INSERT INTO control_environment_resource_policies (
         environment_id, max_concurrent_provisioning, max_ready_spares,
         max_d1_resources, daily_d1_create_budget, target_account_count,
         created_at, updated_at
       ) VALUES ('env-test', 2, 2, 10, 1, 100000, 1, 1);
       INSERT INTO control_residency_partitions (
         environment_id, residency_policy_id, residency_partition, location_hint,
         status, created_at, updated_at
       ) VALUES ('env-test', 'default', 'jp', 'apac', 'active', 1, 1);
       INSERT INTO control_operations (
         operation_id, environment_id, operation_kind, idempotency_key, status,
         requested_by_type, attempt_count, created_at, completed_at, updated_at
       ) VALUES (
         'op-release', 'env-test', 'register_migration_release', 'release:0.4.0',
         'succeeded', 'setup', 1, 1, 1, 1
       );
       INSERT INTO control_migration_release_catalog (
         environment_id, stream_id, release_id, manifest_digest, manifest_r2_object_key,
         state, active_stream_key, registered_by_operation_id, registered_by_actor_id,
         registered_at, activated_at
       ) VALUES (
         'env-test', 'd1-core', '0.4.0', '${'a'.repeat(64)}',
         'releases/0.4.0/${'a'.repeat(64)}/manifest.json', 'active', 'active',
         'op-release', 'setup:test', 1, 1
       );`
    );
    repository = new D1ControlRepository(d1Adapter(database));
  });

  afterEach(() => database.close());

  it('detects and assigns low-watermark capacity for shared and exclusive tenants', async () => {
    database.exec(`
      INSERT INTO control_tenant_placement_policies (
        environment_id, tenant_id, isolation_policy, policy_generation, policy_state,
        source_operation_id, idempotency_key, activated_at, created_at, updated_at
      ) VALUES
        ('env-test', 'tenant-shared', 'shared_pool', 1, 'active',
         'op-release', 'placement-shared', 2, 2, 2),
        ('env-test', 'tenant-exclusive', 'tenant_exclusive', 1, 'active',
         'op-release', 'placement-exclusive', 2, 2, 2);
    `);
    const shared = plan('low-water-shared');
    const exclusive = {
      ...plan('low-water-exclusive'),
      allocationScope: 'tenant_exclusive' as const,
      ownerTenantId: 'tenant-exclusive',
    };
    await repository.createShardPlan(shared, 3, 'admin');
    await repository.createShardPlan(exclusive, 3, 'admin');
    database
      .prepare(
        `UPDATE control_tenant_shards SET status = 'active'
          WHERE shard_id IN (?, ?)`
      )
      .run(shared.shardId, exclusive.shardId);
    database
      .prepare(
        `INSERT INTO control_shard_capacity (
           shard_id, target_account_count, allocated_account_count, observed_account_count,
           health_status, allocation_status, updated_at
         ) VALUES (?, 100, 10, 10, 'healthy', 'eligible', 3),
                  (?, 100, 90, 90, 'healthy', 'eligible', 3)`
      )
      .run(shared.shardId, exclusive.shardId);
    database
      .prepare(
        `INSERT INTO control_tenant_shard_assignments (
           environment_id, tenant_id, data_role, residency_policy_id, residency_partition,
           shard_id, assignment_generation, assignment_state, source_operation_id,
           created_at, activated_at, updated_at
         ) VALUES
           ('env-test', 'tenant-shared', 'tenant_core/users', 'default', 'jp',
            ?, 1, 'active', 'op-release', 3, 3, 3),
           ('env-test', 'tenant-exclusive', 'tenant_core/users', 'default', 'jp',
            ?, 1, 'active', 'op-release', 3, 3, 3)`
      )
      .run(shared.shardId, exclusive.shardId);

    const initial = await repository.listLowWatermarkRequests(20, 'env-test');
    await expect(
      repository.getActiveTenantShardSupplyCount({
        environmentId: 'env-test',
        dataRole: 'tenant_core/users',
        residencyPolicyId: 'default',
        residencyPartition: 'jp',
        allocationScope: 'shared_pool',
        ownerTenantId: null,
      })
    ).resolves.toBe(1);
    await expect(
      repository.getActiveTenantShardSupplyCount({
        environmentId: 'env-test',
        dataRole: 'tenant_core/users',
        residencyPolicyId: 'default',
        residencyPartition: 'jp',
        allocationScope: 'tenant_exclusive',
        ownerTenantId: 'tenant-exclusive',
      })
    ).resolves.toBe(1);
    expect(
      initial.find(
        (request) =>
          request.tenantId === 'tenant-shared' && request.dataRole === 'tenant_core/users'
      )
    ).toBeUndefined();
    expect(
      initial.find(
        (request) =>
          request.tenantId === 'tenant-exclusive' && request.dataRole === 'tenant_core/users'
      )
    ).toMatchObject({
      allocationScope: 'tenant_exclusive',
      ownerTenantId: 'tenant-exclusive',
      activeSupplyCount: 1,
    });

    const exclusiveSpare = {
      ...plan('low-water-exclusive-spare'),
      allocationScope: 'tenant_exclusive' as const,
      ownerTenantId: 'tenant-exclusive',
    };
    await repository.createShardPlan(exclusiveSpare, 4, 'scheduler');
    database
      .prepare(`UPDATE control_operations SET status = 'blocked' WHERE operation_id = ?`)
      .run(exclusiveSpare.operationId);
    await expect(
      repository.findCapacityProvisioningOperation({
        environmentId: 'env-test',
        tenantId: 'tenant-exclusive',
        dataRole: 'tenant_core/users',
        residencyPolicyId: 'default',
        residencyPartition: 'jp',
        allocationScope: 'tenant_exclusive',
        ownerTenantId: 'tenant-exclusive',
      })
    ).resolves.toMatchObject({ operationId: exclusiveSpare.operationId, status: 'blocked' });
    // A pending shard must not advance the low-water generation. Concurrent reconcilers that
    // observed the same active fleet must therefore derive the same idempotency key.
    await expect(
      repository.getActiveTenantShardSupplyCount({
        environmentId: 'env-test',
        dataRole: 'tenant_core/users',
        residencyPolicyId: 'default',
        residencyPartition: 'jp',
        allocationScope: 'tenant_exclusive',
        ownerTenantId: 'tenant-exclusive',
      })
    ).resolves.toBe(1);
    expect(
      (await repository.listLowWatermarkRequests(20, 'env-test')).find(
        (request) =>
          request.tenantId === 'tenant-exclusive' && request.dataRole === 'tenant_core/users'
      )
    ).toBeUndefined();

    database
      .prepare(`UPDATE control_tenant_shards SET status = 'active' WHERE shard_id = ?`)
      .run(exclusiveSpare.shardId);
    database
      .prepare(
        `INSERT INTO control_shard_capacity (
           shard_id, target_account_count, allocated_account_count, observed_account_count,
           health_status, allocation_status, updated_at
         ) VALUES (?, 100, 0, 0, 'healthy', 'eligible', 4)`
      )
      .run(exclusiveSpare.shardId);
    database
      .prepare(
        `UPDATE control_desired_resources
            SET desired_state = 'present', provisioning_state = 'ready',
                observed_resource_id = ?
          WHERE desired_resource_id = ?`
      )
      .run('observed-low-water-exclusive-spare', exclusiveSpare.desiredResourceId);
    database
      .prepare(
        `INSERT INTO control_observed_resources (
           observed_resource_id, environment_id, desired_resource_id, provider_resource_id,
           provider_name, resource_kind, ownership_fingerprint, observed_state,
           observed_spec_json, observed_at
         ) VALUES (?, 'env-test', ?, 'database-low-water-exclusive-spare', ?, 'd1', ?,
                   'present', '{}', 4)`
      )
      .run(
        'observed-low-water-exclusive-spare',
        exclusiveSpare.desiredResourceId,
        exclusiveSpare.databaseName,
        exclusiveSpare.ownershipFingerprint
      );
    expect(
      (await repository.listLowWatermarkRequests(20, 'env-test')).find(
        (request) =>
          request.tenantId === 'tenant-exclusive' && request.dataRole === 'tenant_core/users'
      )
    ).toMatchObject({ activeSupplyCount: 2 });

    await repository.assignTenantShard(
      {
        environmentId: 'env-test',
        tenantId: 'tenant-exclusive',
        dataRole: 'tenant_core/users',
        residencyPolicyId: 'default',
        residencyPartition: 'jp',
        shardId: exclusiveSpare.shardId,
        sourceOperationId: exclusiveSpare.operationId,
      },
      5
    );
    expect(
      (await repository.listLowWatermarkRequests(20, 'env-test')).find(
        (request) =>
          request.tenantId === 'tenant-exclusive' && request.dataRole === 'tenant_core/users'
      )
    ).toBeUndefined();

    database
      .prepare(
        `UPDATE control_shard_capacity
            SET allocated_account_count = 90, observed_account_count = 90
          WHERE shard_id = ?`
      )
      .run(shared.shardId);
    expect(
      (await repository.listLowWatermarkRequests(20, 'env-test')).find(
        (request) =>
          request.tenantId === 'tenant-shared' && request.dataRole === 'tenant_core/users'
      )
    ).toMatchObject({
      allocationScope: 'shared_pool',
      ownerTenantId: null,
      activeSupplyCount: 1,
    });
  });

  it('reports durable release rollout progress and the Admin mutation fence', async () => {
    await expect(repository.getReleaseMigrationRolloutStatus('env-test')).resolves.toEqual({
      operationId: null,
      sourceVersion: null,
      targetVersion: null,
      phase: 'idle',
      completedTargets: 0,
      totalTargets: 0,
      blockedTargetCount: 0,
      blockedTargets: [],
      adminMutationMode: 'available',
      lastErrorCode: null,
      updatedAt: null,
    });

    database.exec(`
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, attempt_count, release_id, release_stream_id,
        release_manifest_digest, created_at, updated_at
      ) VALUES (
        'release-rollout-1', 'env-test', 'release_migration_rollout', 'release-rollout:0.5.0',
        'running', 'setup', 1, '0.5.0', 'all', '${'c'.repeat(64)}', 200, 220
      );
      INSERT INTO control_operation_steps (
        operation_id, step_key, display_order, status, attempt_count,
        progress_current, progress_total, updated_at
      ) VALUES
        ('release-rollout-1', 'apply_managed_migrations', 10, 'succeeded', 1, 12, 12, 215),
        ('release-rollout-1', 'await_setup', 20, 'running', 1, NULL, NULL, 220),
        ('release-rollout-1', 'verify_release', 30, 'queued', 0, NULL, NULL, 220);
      INSERT INTO control_release_migration_rollouts (
        operation_id, environment_id, source_version, target_version, release_id,
        manifest_digest, manifest_r2_object_key, database_execution, worker_activation,
        admin_mutation_mode, handoff_state, active_environment_key,
        created_at, updated_at
      ) VALUES (
        'release-rollout-1', 'env-test', NULL, '0.5.0', '0.5.0', '${'c'.repeat(64)}',
        'releases/0.5.0/${'c'.repeat(64)}/manifest.json', 'setup_then_control',
        'after_required_databases', 'read_only', 'awaiting_setup', 'env-test', 200, 220
      );
    `);

    await expect(repository.getReleaseMigrationRolloutStatus('env-test')).resolves.toEqual({
      operationId: 'release-rollout-1',
      sourceVersion: null,
      targetVersion: '0.5.0',
      phase: 'awaiting_setup',
      completedTargets: 12,
      totalTargets: 12,
      blockedTargetCount: 0,
      blockedTargets: [],
      adminMutationMode: 'read_only',
      lastErrorCode: null,
      updatedAt: 220,
    });
  });

  it('prefers an active rollout over a completed rollout created in the same second', async () => {
    const digest = 'd'.repeat(64);
    database.exec(`
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, attempt_count, created_at, completed_at, updated_at
      ) VALUES
        ('release-rollout-completed', 'env-test', 'release_migration_rollout',
         'release-rollout:completed', 'succeeded', 'setup', 1, 300, 320, 320),
        ('release-rollout-active', 'env-test', 'release_migration_rollout',
         'release-rollout:active', 'running', 'setup', 1, 300, NULL, 310);
      INSERT INTO control_release_migration_rollouts (
        operation_id, environment_id, source_version, target_version, release_id,
        manifest_digest, manifest_r2_object_key, database_execution, worker_activation,
        admin_mutation_mode, handoff_state, active_environment_key, completed_at,
        created_at, updated_at
      ) VALUES
        ('release-rollout-completed', 'env-test', '0.4.0', '0.5.0', '0.5.0', '${digest}',
         'releases/0.5.0/${digest}/manifest.json', 'setup_then_control',
         'after_required_databases', 'read_only', 'completed',
         'completed:release-rollout-completed', 320, 300, 320),
        ('release-rollout-active', 'env-test', '0.5.0', '0.6.0', '0.6.0', '${digest}',
         'releases/0.6.0/${digest}/manifest.json', 'setup_then_control',
         'after_required_databases', 'read_only', 'database_rollout', 'env-test',
         NULL, 300, 310);
      INSERT INTO control_operation_steps (
        operation_id, step_key, display_order, status, attempt_count,
        progress_current, progress_total, updated_at
      ) VALUES
        ('release-rollout-active', 'apply_managed_migrations', 10, 'running', 1, 2, 5, 310),
        ('release-rollout-active', 'await_setup', 20, 'queued', 0, NULL, NULL, 310),
        ('release-rollout-active', 'verify_release', 30, 'queued', 0, NULL, NULL, 310);
    `);

    await expect(repository.getReleaseMigrationRolloutStatus('env-test')).resolves.toMatchObject({
      operationId: 'release-rollout-active',
      targetVersion: '0.6.0',
      phase: 'database_rollout',
      completedTargets: 2,
      totalTargets: 5,
      adminMutationMode: 'read_only',
    });
  });

  it('fails closed when a completed handoff contradicts its operation or required steps', async () => {
    const digest = 'e'.repeat(64);
    database.exec(`
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, attempt_count, release_id, release_stream_id,
        release_manifest_digest, created_at, updated_at
      ) VALUES (
        'release-rollout-inconsistent', 'env-test', 'release_migration_rollout',
        'release-rollout:inconsistent', 'running', 'setup', 1, '0.7.0', 'all',
        '${digest}', 400, 410
      );
      INSERT INTO control_release_migration_rollouts (
        operation_id, environment_id, source_version, target_version, release_id,
        manifest_digest, manifest_r2_object_key, database_execution, worker_activation,
        admin_mutation_mode, handoff_state, active_environment_key, completed_at,
        created_at, updated_at
      ) VALUES (
        'release-rollout-inconsistent', 'env-test', '0.6.0', '0.7.0', '0.7.0',
        '${digest}', 'releases/0.7.0/${digest}/manifest.json', 'setup_then_control',
        'after_required_databases', 'read_only', 'completed',
        'completed:release-rollout-inconsistent', 410, 400, 410
      );
      INSERT INTO control_operation_steps (
        operation_id, step_key, display_order, status, attempt_count,
        progress_current, progress_total, updated_at
      ) VALUES
        ('release-rollout-inconsistent', 'apply_managed_migrations', 10, 'succeeded', 1, 4, 5, 410),
        ('release-rollout-inconsistent', 'await_setup', 20, 'running', 1, NULL, NULL, 410),
        ('release-rollout-inconsistent', 'verify_release', 30, 'queued', 0, NULL, NULL, 410);
    `);

    await expect(repository.getReleaseMigrationRolloutStatus('env-test')).resolves.toMatchObject({
      operationId: 'release-rollout-inconsistent',
      phase: 'blocked',
      adminMutationMode: 'read_only',
      lastErrorCode: 'release_rollout_state_inconsistent',
    });
  });

  it('resumes only initial bootstrap operations handed to the operator before credentials were ready', async () => {
    database.exec(`
      INSERT INTO control_bootstrap_handoffs (
        environment_id, state, ownership_fingerprint, release_manifest_digest, updated_at
      ) VALUES ('env-test', 'pending_verification', '${'a'.repeat(64)}', '${'b'.repeat(64)}', 10);
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, requested_by_id, attempt_count, last_error_code, created_at, updated_at
      ) VALUES (
        'op_bootstrap_requeue', 'env-test', 'provision_shard', 'bootstrap-requeue', 'blocked',
        'setup', 'setup:init', 1, 'operator_action_required', 10, 10
      );
      INSERT INTO control_operation_steps (
        operation_id, step_key, display_order, status, attempt_count, last_error_code, updated_at
      ) VALUES
        ('op_bootstrap_requeue', 'reconcile_worker_bindings', 30, 'blocked', 0, 'operator_action_required', 10),
        ('op_bootstrap_requeue', 'smoke_bindings', 40, 'blocked', 0, 'operator_action_required', 10),
        ('op_bootstrap_requeue', 'stabilize_bindings', 50, 'blocked', 0, 'operator_action_required', 10);
    `);

    await expect(repository.resumeAutomaticBootstrapOperations('env-test', 100)).resolves.toBe(1);
    expect(
      database
        .prepare(
          `SELECT status, last_error_code FROM control_operations
            WHERE operation_id = 'op_bootstrap_requeue'`
        )
        .get()
    ).toEqual({ status: 'waiting_retry', last_error_code: null });
    expect(
      database
        .prepare(
          `SELECT step_key, status, last_error_code FROM control_operation_steps
            WHERE operation_id = 'op_bootstrap_requeue' ORDER BY display_order`
        )
        .all()
    ).toEqual([
      { step_key: 'reconcile_worker_bindings', status: 'running', last_error_code: null },
      { step_key: 'smoke_bindings', status: 'running', last_error_code: null },
      { step_key: 'stabilize_bindings', status: 'running', last_error_code: null },
    ]);

    database.exec(`
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, requested_by_id, attempt_count, last_error_code, created_at, updated_at
      ) VALUES (
        'op_bootstrap_waiting', 'env-test', 'provision_shard', 'bootstrap-waiting', 'waiting_retry',
        'setup', 'setup:init', 1, 'control_worker_binding_reconciliation_failed', 10, 10
      );
      INSERT INTO control_operation_steps (
        operation_id, step_key, display_order, status, attempt_count, updated_at
      ) VALUES
        ('op_bootstrap_waiting', 'reconcile_worker_bindings', 30, 'waiting_retry', 0, 10),
        ('op_bootstrap_waiting', 'smoke_bindings', 40, 'waiting_retry', 0, 10),
        ('op_bootstrap_waiting', 'stabilize_bindings', 50, 'waiting_retry', 0, 10);
    `);

    await expect(repository.resumeAutomaticBootstrapOperations('env-test', 101)).resolves.toBe(2);
    expect(
      database
        .prepare(
          `SELECT step_key, status, last_error_code FROM control_operation_steps
            WHERE operation_id = 'op_bootstrap_waiting' ORDER BY display_order`
        )
        .all()
    ).toEqual([
      { step_key: 'reconcile_worker_bindings', status: 'running', last_error_code: null },
      { step_key: 'smoke_bindings', status: 'running', last_error_code: null },
      { step_key: 'stabilize_bindings', status: 'running', last_error_code: null },
    ]);
  });

  it('activates a placement policy only with a matching observed Runtime Registry route', async () => {
    database.exec(`
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, attempt_count, created_at, updated_at
      ) VALUES ('tenant-create-route', 'env-test', 'tenant_create', 'tenant-create-route',
                'running', 'admin', 1, 10, 10);
      INSERT INTO control_tenant_placement_policies (
        environment_id, tenant_id, isolation_policy, policy_generation, policy_state,
        source_operation_id, idempotency_key, created_at, updated_at
      ) VALUES ('env-test', 'tenant-route', 'tenant_exclusive', 1, 'provisioning',
                'tenant-create-route', 'tenant-route-policy', 10, 10);
      INSERT INTO control_desired_resources (
        desired_resource_id, environment_id, resource_kind, logical_shard_id, resource_scope,
        tenant_id, deterministic_name, ownership_fingerprint, provisioning_state,
        origin_operation_id, created_at, updated_at
      ) VALUES
        ('desired-route-default', 'env-test', 'd1', 'route-default', 'tenant', 'tenant-route',
         'route-default', 'fp-default', 'active', 'tenant-create-route', 10, 10),
        ('desired-route-users', 'env-test', 'd1', 'route-users', 'tenant', 'tenant-route',
         'route-users', 'fp-users', 'active', 'tenant-create-route', 10, 10),
        ('desired-route-pii', 'env-test', 'd1', 'route-pii', 'tenant', 'tenant-route',
         'route-pii', 'fp-pii', 'active', 'tenant-create-route', 10, 10);
      INSERT INTO control_tenant_shards (
        shard_id, environment_id, data_role, residency_policy_id, residency_partition,
        generation, logical_shard_id, binding_ref, d1_desired_resource_id, location_hint,
        status, created_at, updated_at, allocation_scope, owner_tenant_id
      ) VALUES
        ('shard-route-default', 'env-test', 'tenant_core/default', 'default', 'jp', 4,
         'route-default', 'TDB_ROUTE_DEFAULT', 'desired-route-default', 'apac', 'active', 10, 10,
         'tenant_exclusive', 'tenant-route'),
        ('shard-route-users', 'env-test', 'tenant_core/users', 'default', 'jp', 4,
         'route-users', 'TDB_ROUTE_USERS', 'desired-route-users', 'apac', 'active', 10, 10,
         'tenant_exclusive', 'tenant-route'),
        ('shard-route-pii', 'env-test', 'tenant_pii', 'default', 'jp', 4,
         'route-pii', 'TDB_ROUTE_PII', 'desired-route-pii', 'apac', 'active', 10, 10,
         'tenant_exclusive', 'tenant-route');
      INSERT INTO control_tenant_shard_assignments (
        environment_id, tenant_id, data_role, residency_policy_id, residency_partition,
        shard_id, assignment_generation, assignment_state, source_operation_id,
        created_at, activated_at, updated_at
      ) VALUES
        ('env-test', 'tenant-route', 'tenant_core/default', 'default', 'jp',
         'shard-route-default', 1, 'active', 'tenant-create-route', 10, 10, 10),
        ('env-test', 'tenant-route', 'tenant_core/users', 'default', 'jp',
         'shard-route-users', 1, 'active', 'tenant-create-route', 10, 10, 10),
        ('env-test', 'tenant-route', 'tenant_pii', 'default', 'jp',
         'shard-route-pii', 1, 'active', 'tenant-create-route', 10, 10, 10);
      INSERT INTO control_tenant_default_allocations (
        allocation_id, environment_id, tenant_id, residency_policy_id, residency_partition,
        selected_shard_id, reservation_state, idempotency_key, route_generation,
        capacity_counted_at, created_at, committed_at, updated_at
      ) VALUES ('default-route-allocation', 'env-test', 'tenant-route', 'default', 'jp',
                'shard-route-default', 'committed', 'default-route-allocation', 4,
                10, 10, 10, 10);
    `);
    const request = {
      tenantId: 'tenant-route',
      sourceOperationId: 'tenant-create-route',
      idempotencyKey: 'tenant-route-activation',
      runtimeRoute: {
        runtimeGeneration: 4,
        registryPublicationGeneration: 4,
        tenantLifecycleState: 'active' as const,
        routeStatus: 'active' as const,
        targets: [
          {
            dataRole: 'tenant_core/default' as const,
            shardId: 'shard-route-default',
            bindingRef: 'TDB_ROUTE_DEFAULT',
            generation: 4,
          },
          {
            dataRole: 'tenant_core/users' as const,
            shardId: 'shard-route-users',
            bindingRef: 'TDB_ROUTE_USERS',
            generation: 4,
          },
          {
            dataRole: 'tenant_pii' as const,
            shardId: 'shard-route-pii',
            bindingRef: 'TDB_ROUTE_PII',
            generation: 4,
          },
        ],
      },
      environmentId: 'env-test',
    };

    await expect(repository.activateTenantPlacementPolicy(request, 20)).resolves.toMatchObject({
      state: 'active',
    });
    const activatedRoute = database
      .prepare(
        `SELECT route_generation, route_status, tenant_lifecycle_state, source_operation_id
           FROM control_runtime_registry_routes WHERE tenant_id = 'tenant-route'`
      )
      .get() as
      | {
          route_generation: number;
          route_status: string;
          tenant_lifecycle_state: string;
          source_operation_id: string;
        }
      | undefined;
    expect(activatedRoute).toMatchObject({
      route_generation: 4,
      route_status: 'active',
      tenant_lifecycle_state: 'active',
    });
    expect(activatedRoute?.source_operation_id).toMatch(/^op_runtime_route_[a-f0-9]{32}$/u);
    await expect(repository.activateTenantPlacementPolicy(request, 21)).resolves.toMatchObject({
      state: 'active',
    });
    await expect(
      repository.activateTenantPlacementPolicy(
        { ...request, idempotencyKey: 'tenant-route-dr-observation' },
        21
      )
    ).resolves.toMatchObject({ state: 'active' });

    database.exec(`
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, attempt_count, created_at, started_at, completed_at, updated_at
      ) VALUES ('legacy-route-observation', 'env-test', 'tenant_runtime_route_observation',
                'legacy-route-observation', 'succeeded', 'admin', 1, 21, 21, 21, 21);
      UPDATE control_runtime_registry_routes
         SET source_operation_id = 'legacy-route-observation'
       WHERE tenant_id = 'tenant-route';
    `);
    await expect(
      repository.activateTenantPlacementPolicy(
        { ...request, idempotencyKey: 'tenant-route-later-observation' },
        21
      )
    ).resolves.toMatchObject({ state: 'active' });

    database.exec("DELETE FROM control_runtime_registry_routes WHERE tenant_id = 'tenant-route'");
    database.exec("DELETE FROM control_operations WHERE operation_id = 'legacy-route-observation'");
    await expect(repository.activateTenantPlacementPolicy(request, 22)).resolves.toMatchObject({
      state: 'active',
    });
    const repairedRoute = database
      .prepare(
        `SELECT route_generation, route_status, source_operation_id
           FROM control_runtime_registry_routes WHERE tenant_id = 'tenant-route'`
      )
      .get() as
      | { route_generation: number; route_status: string; source_operation_id: string }
      | undefined;
    expect(repairedRoute).toMatchObject({
      route_generation: 4,
      route_status: 'active',
    });
    expect(repairedRoute?.source_operation_id).toMatch(/^op_runtime_route_[a-f0-9]{32}$/u);
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM control_operations
            WHERE operation_kind = 'tenant_runtime_route_observation'`
        )
        .get()
    ).toEqual({ count: 1 });

    database.exec(
      "UPDATE control_runtime_registry_routes SET source_operation_id = 'tenant-create-route' WHERE tenant_id = 'tenant-route'"
    );
    await expect(repository.activateTenantPlacementPolicy(request, 23)).rejects.toThrow(
      'control_tenant_runtime_route_observation_conflict'
    );
  });

  it('rejects a wrong-shard Runtime Registry observation before activation', async () => {
    database.exec(`
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, attempt_count, created_at, updated_at
      ) VALUES ('tenant-create-wrong-route', 'env-test', 'tenant_create', 'tenant-create-wrong-route',
                'running', 'admin', 1, 10, 10);
      INSERT INTO control_tenant_placement_policies (
        environment_id, tenant_id, isolation_policy, policy_generation, policy_state,
        source_operation_id, idempotency_key, created_at, updated_at
      ) VALUES ('env-test', 'tenant-wrong-route', 'tenant_exclusive', 1, 'provisioning',
                'tenant-create-wrong-route', 'tenant-wrong-route-policy', 10, 10);
    `);
    await expect(
      repository.activateTenantPlacementPolicy(
        {
          tenantId: 'tenant-wrong-route',
          sourceOperationId: 'tenant-create-wrong-route',
          idempotencyKey: 'tenant-wrong-route-activation',
          runtimeRoute: {
            runtimeGeneration: 1,
            registryPublicationGeneration: 1,
            tenantLifecycleState: 'active',
            routeStatus: 'active',
            targets: [
              {
                dataRole: 'tenant_core/default',
                shardId: 'wrong-default',
                bindingRef: 'WRONG_DEFAULT',
                generation: 1,
              },
              {
                dataRole: 'tenant_core/users',
                shardId: 'wrong-users',
                bindingRef: 'WRONG_USERS',
                generation: 1,
              },
              {
                dataRole: 'tenant_pii',
                shardId: 'wrong-pii',
                bindingRef: 'WRONG_PII',
                generation: 1,
              },
            ],
          },
          environmentId: 'env-test',
        },
        20
      )
    ).rejects.toThrow('control_tenant_runtime_route_observation_mismatch');
    expect(
      database
        .prepare(
          `SELECT policy_state FROM control_tenant_placement_policies WHERE tenant_id = 'tenant-wrong-route'`
        )
        .get()
    ).toEqual({ policy_state: 'provisioning' });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM control_runtime_registry_routes WHERE tenant_id = 'tenant-wrong-route'`
        )
        .get()
    ).toEqual({ count: 0 });
  });

  it('stores a Lookup capacity unit outside tenant shard inventory', async () => {
    database.exec(`INSERT INTO control_migration_release_catalog (
      environment_id, stream_id, release_id, manifest_digest, manifest_r2_object_key,
      state, active_stream_key, registered_by_operation_id, registered_by_actor_id,
      registered_at, activated_at
    ) VALUES (
      'env-test', 'd1-lookup', '0.4.0', '${'b'.repeat(64)}',
      'releases/0.4.0/${'b'.repeat(64)}/manifest.json', 'active', 'active',
      'op-release', 'setup:test', 1, 1
    )`);
    const lookupPlan: TenantShardPlan = {
      ...plan('lookup-capacity'),
      shardId: 'lookup-lookup-capacity',
      dataRole: 'lookup',
      logicalShardId: 'lookup:jp:lookup-capacity',
      databaseName: 'authrim-test-lookup-jp-lookup-capacity',
      bindingRef: 'TDB_LOOKUP_CAPACITY_LOOKUP',
      migrationStreamId: 'd1-lookup',
    };

    await repository.createShardPlan(lookupPlan, 100, 'admin');

    expect(
      database
        .prepare('SELECT COUNT(*) AS count FROM control_tenant_shards WHERE shard_id = ?')
        .get(lookupPlan.shardId)
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare(
          `SELECT lookup_shard_id, residency_partition, binding_ref, status
             FROM control_lookup_physical_shards WHERE lookup_shard_id = ?`
        )
        .get(lookupPlan.shardId)
    ).toEqual({
      lookup_shard_id: lookupPlan.shardId,
      residency_partition: 'jp',
      binding_ref: lookupPlan.bindingRef,
      status: 'requested',
    });
    await expect(repository.listPendingShardPlans(10)).resolves.toEqual([
      expect.objectContaining({ dataRole: 'lookup', migrationStreamId: 'd1-lookup' }),
    ]);
    const createLease = await repository.tryStartProvisioning(
      lookupPlan.operationId,
      'lookup-create-owner',
      101
    );
    if (!createLease) throw new Error('expected_lookup_create_lease');
    await repository.markDatabaseCreated(
      createLease,
      lookupPlan,
      'lookup-database-id',
      'disabled',
      102
    );
    const [migrationPlan] = await repository.listPendingMigrationPlans(10);
    expect(migrationPlan).toMatchObject({
      dataRole: 'lookup',
      streamId: 'd1-lookup',
      databaseId: 'lookup-database-id',
    });
    if (!migrationPlan) throw new Error('expected_lookup_migration_plan');
    const migrationLease = await repository.tryStartMigration(
      lookupPlan.operationId,
      'lookup-migration-owner',
      103
    );
    if (!migrationLease) throw new Error('expected_lookup_migration_lease');
    await repository.markMigrationReady(
      migrationLease,
      migrationPlan,
      {
        totalFiles: 1,
        appliedFiles: 1,
        skippedFiles: 0,
        responseLossRecoveries: 0,
        lastFilename: '001_lookup.sql',
      },
      104
    );
    expect(
      database
        .prepare('SELECT status FROM control_lookup_physical_shards WHERE lookup_shard_id = ?')
        .get(lookupPlan.shardId)
    ).toEqual({ status: 'ready' });
    database.exec(`INSERT INTO control_desired_worker_inventory (
      environment_id, worker_script_name, package_name, deployment_target,
      capability_manifest_digest, source_manifest_path, source_manifest_hash,
      generated_artifact_hash, source_kind, source_reference, status,
      registered_by_operation_id, registered_by, registered_at
    ) VALUES (
      'env-test', 'test-ar-management', '@authrim/ar-management', 'test-ar-management',
      '${'c'.repeat(64)}', 'management.json', '${'d'.repeat(64)}', '${'e'.repeat(64)}',
      'core_manifest', 'test', 'active', 'op-release', 'setup:test', 105
    );
    INSERT INTO control_worker_required_data_roles (
      environment_id, worker_script_name, data_role, source_manifest_hash, updated_at
    ) VALUES ('env-test', 'test-ar-management', 'lookup', '${'d'.repeat(64)}', 105);`);
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count
             FROM control_operations o
             JOIN control_tenant_database_migration_state m ON m.operation_id = o.operation_id
             JOIN control_lookup_physical_shards l
               ON l.d1_desired_resource_id = m.desired_resource_id
             JOIN control_worker_required_data_roles r
               ON r.environment_id = o.environment_id AND r.data_role = 'lookup'
             JOIN control_desired_worker_inventory i
               ON i.environment_id = r.environment_id
              AND i.worker_script_name = r.worker_script_name
              AND i.status = 'active'
            WHERE o.operation_id = ? AND o.status = 'waiting_retry'
              AND m.state = 'ready' AND m.provider_database_id IS NOT NULL
              AND l.status = 'ready'`
        )
        .get(lookupPlan.operationId)
    ).toEqual({ count: 1 });
    const bindingRepository = new D1WorkerBindingRepository(d1Adapter(database));
    await bindingRepository.ensurePendingTargets(106);
    expect(
      database
        .prepare(
          `SELECT o.status AS operation_status, o.last_error_code,
                  m.state AS migration_state, l.status AS lookup_status,
                  (SELECT COUNT(*) FROM control_worker_binding_reconciliations r
                    WHERE r.operation_id = o.operation_id) AS target_count
             FROM control_operations o
             JOIN control_tenant_database_migration_state m ON m.operation_id = o.operation_id
             JOIN control_lookup_physical_shards l
               ON l.d1_desired_resource_id = m.desired_resource_id
            WHERE o.operation_id = ?`
        )
        .get(lookupPlan.operationId)
    ).toEqual({
      operation_status: 'waiting_retry',
      last_error_code: null,
      migration_state: 'ready',
      lookup_status: 'ready',
      target_count: 1,
    });
    await expect(bindingRepository.listDueTargets(10, 106)).resolves.toEqual([
      expect.objectContaining({
        dataRole: 'lookup',
        bindingRef: lookupPlan.bindingRef,
        databaseId: 'lookup-database-id',
      }),
    ]);
  });

  it('inventories assigned tenant shards and finalizes deletion state idempotently', async () => {
    const roles = [
      ['tenant_core/default', 'default'],
      ['tenant_core/users', 'users'],
      ['tenant_pii', 'pii'],
    ] as const;
    for (const [dataRole, suffix] of roles) {
      await repository.createShardPlan({ ...plan(suffix), dataRole }, 100, 'admin');
    }
    database.exec(
      `INSERT INTO control_tenant_placement_policies (
         environment_id, tenant_id, isolation_policy, policy_generation, policy_state,
         source_operation_id, idempotency_key, activated_at, created_at, updated_at
       ) VALUES ('env-test', 'tenant-delete', 'shared_pool', 1, 'active',
                 'tenant-create-delete', 'tenant-placement-delete', 110, 100, 110);
       UPDATE control_tenant_shards SET status = 'active', updated_at = 110
        WHERE shard_id IN ('shard-default', 'shard-users', 'shard-pii');
       INSERT INTO control_shard_capacity (
         shard_id, target_account_count, allocated_account_count,
         health_status, allocation_status, updated_at
       ) VALUES
         ('shard-default', 100000, 1, 'healthy', 'eligible', 110),
         ('shard-users', 100000, 1, 'healthy', 'eligible', 110),
         ('shard-pii', 100000, 0, 'healthy', 'eligible', 110);
       INSERT INTO control_tenant_shard_assignments (
         environment_id, tenant_id, data_role, residency_policy_id, residency_partition,
         shard_id, assignment_generation, assignment_state, source_operation_id,
         created_at, activated_at, updated_at
       ) VALUES
         ('env-test', 'tenant-delete', 'tenant_core/default', 'default', 'jp',
          'shard-default', 1, 'active', 'op-default', 110, 110, 110),
         ('env-test', 'tenant-delete', 'tenant_core/users', 'default', 'jp',
          'shard-users', 1, 'active', 'op-users', 110, 110, 110),
         ('env-test', 'tenant-delete', 'tenant_pii', 'default', 'jp',
          'shard-pii', 1, 'active', 'op-pii', 110, 110, 110);
       INSERT INTO control_tenant_default_allocations (
         allocation_id, environment_id, tenant_id, residency_policy_id, residency_partition,
         selected_shard_id, reservation_state, idempotency_key, route_generation,
         capacity_counted_at, created_at, committed_at, updated_at
       ) VALUES ('default-allocation-delete', 'env-test', 'tenant-delete', 'default', 'jp',
                 'shard-default', 'committed', 'default-delete', 1, 110, 110, 110, 110);
       INSERT INTO control_tenant_shard_allocations (
         allocation_id, environment_id, tenant_id, account_id_blind_digest, data_role,
         residency_partition, selected_shard_id, reservation_state, idempotency_key,
         route_generation, capacity_counted_at, created_at, committed_at, updated_at
       ) VALUES ('account-allocation-delete', 'env-test', 'tenant-delete', 'digest-delete',
                 'tenant_core/users', 'jp', 'shard-users', 'committed', 'account-delete',
                 1, 110, 110, 110, 110);
       INSERT INTO control_lookup_physical_shards (
         lookup_shard_id, environment_id, residency_partition, binding_ref,
         d1_desired_resource_id, status, created_at, updated_at
       ) VALUES ('lookup-delete', 'env-test', 'jp', 'LOOKUP_DELETE',
                 'resource-default', 'active', 110, 110);
       INSERT INTO control_runtime_registry_routes (
         environment_id, tenant_id, route_generation, tenant_lifecycle_generation,
         quarantine_deny_generation, registry_publication_generation,
         tenant_lifecycle_state, route_status, residency_policy_id,
         route_projection_json, source_operation_id, created_at, updated_at
       ) VALUES ('env-test', 'tenant-delete', 1, 1, 0, 1, 'active', 'active', 'default',
                 '{}', 'op-default', 110, 110);`
    );

    await expect(repository.listTenantDeletionLookupShards('env-test')).resolves.toEqual([
      { lookupShardId: 'lookup-delete', bindingRef: 'LOOKUP_DELETE', status: 'active' },
    ]);
    await expect(
      repository.listTenantDeletionShards({
        environmentId: 'env-test',
        tenantId: 'tenant-delete',
      })
    ).resolves.toEqual([
      expect.objectContaining({
        shardId: 'shard-default',
        dataRole: 'tenant_core/default',
        allocationScope: 'shared_pool',
        ownerTenantId: null,
      }),
      expect.objectContaining({
        shardId: 'shard-users',
        dataRole: 'tenant_core/users',
        allocationScope: 'shared_pool',
        ownerTenantId: null,
      }),
      expect.objectContaining({
        shardId: 'shard-pii',
        dataRole: 'tenant_pii',
        allocationScope: 'shared_pool',
        ownerTenantId: null,
      }),
    ]);

    const input = {
      environmentId: 'env-test',
      tenantId: 'tenant-delete',
      operationId: 'delete-operation',
    };
    const first = await repository.finalizeTenantDeletionControlState(input, 120);
    const second = await repository.finalizeTenantDeletionControlState(input, 130);

    expect(first).toEqual(second);
    expect(first.finalizedAt).toBe(120);
    expect(
      database
        .prepare(
          `SELECT shard_id, allocated_account_count FROM control_shard_capacity
            WHERE shard_id IN ('shard-default', 'shard-users', 'shard-pii') ORDER BY shard_id`
        )
        .all()
    ).toEqual([
      { shard_id: 'shard-default', allocated_account_count: 0 },
      { shard_id: 'shard-pii', allocated_account_count: 0 },
      { shard_id: 'shard-users', allocated_account_count: 0 },
    ]);
    expect(
      database
        .prepare(
          `SELECT assignment_state, retired_at FROM control_tenant_shard_assignments
            WHERE tenant_id = 'tenant-delete' ORDER BY data_role`
        )
        .all()
    ).toEqual([
      { assignment_state: 'retired', retired_at: 120 },
      { assignment_state: 'retired', retired_at: 120 },
      { assignment_state: 'retired', retired_at: 120 },
    ]);
    expect(
      database
        .prepare(
          `SELECT policy_state FROM control_tenant_placement_policies
            WHERE tenant_id = 'tenant-delete'`
        )
        .get()
    ).toEqual({ policy_state: 'retired' });
    expect(
      database
        .prepare(
          `SELECT tenant_lifecycle_state, route_status, quarantine_deny_generation
             FROM control_runtime_registry_routes WHERE tenant_id = 'tenant-delete'`
        )
        .get()
    ).toEqual({
      tenant_lifecycle_state: 'disabled',
      route_status: 'disabled',
      quarantine_deny_generation: 1,
    });
    expect(
      database
        .prepare(
          `SELECT reservation_state, capacity_counted_at FROM control_tenant_shard_allocations
            WHERE tenant_id = 'tenant-delete'`
        )
        .get()
    ).toEqual({ reservation_state: 'released', capacity_counted_at: null });
    expect(
      database
        .prepare(
          `SELECT reservation_state, capacity_counted_at, released_at
             FROM control_tenant_default_allocations WHERE tenant_id = 'tenant-delete'`
        )
        .get()
    ).toEqual({ reservation_state: 'released', capacity_counted_at: null, released_at: 120 });
  });

  it('builds shared and tenant-exclusive planner inputs only from matching shard scope', async () => {
    database.exec(`INSERT INTO control_desired_worker_inventory (
      environment_id, worker_script_name, package_name, deployment_target,
      capability_manifest_digest, source_manifest_path, source_manifest_hash,
      generated_artifact_hash, source_kind, source_reference, status,
      registered_by_operation_id, registered_by, registered_at
    ) VALUES
      ('env-test', 'test-ar-management', '@authrim/ar-management', 'test-ar-management',
       '${'b'.repeat(64)}', 'management.json', '${'c'.repeat(64)}', '${'d'.repeat(64)}',
       'core_manifest', 'test', 'active', 'op-release', 'setup:test', 2),
      ('env-test', 'test-ar-auth', '@authrim/ar-auth', 'test-ar-auth',
       '${'b'.repeat(64)}', 'auth.json', '${'c'.repeat(64)}', '${'d'.repeat(64)}',
       'core_manifest', 'test', 'active', 'op-release', 'setup:test', 2),
      ('env-test', 'test-ar-userinfo', '@authrim/ar-userinfo', 'test-ar-userinfo',
       '${'b'.repeat(64)}', 'userinfo.json', '${'c'.repeat(64)}', '${'d'.repeat(64)}',
       'core_manifest', 'test', 'active', 'op-release', 'setup:test', 2);
    INSERT INTO control_worker_required_data_roles (
      environment_id, worker_script_name, data_role, source_manifest_hash, updated_at
    ) VALUES
      ('env-test', 'test-ar-management', 'tenant_core/default', '${'c'.repeat(64)}', 2),
      ('env-test', 'test-ar-management', 'lookup', '${'c'.repeat(64)}', 2),
      ('env-test', 'test-ar-auth', 'tenant_core/users', '${'c'.repeat(64)}', 2),
      ('env-test', 'test-ar-userinfo', 'tenant_pii', '${'c'.repeat(64)}', 2);
    INSERT INTO control_tenant_placement_policies (
      environment_id, tenant_id, isolation_policy, policy_generation, policy_state,
      source_operation_id, idempotency_key, activated_at, created_at, updated_at
    ) VALUES ('env-test', 'tenant-exclusive', 'tenant_exclusive', 1, 'active',
              'tenant-create', 'tenant-policy', 2, 2, 2);`);

    const shared = await repository.getCapacityPlannerInput('env-test', 'shared_pool', null);
    expect(shared).toMatchObject({
      scope: 'shared_pool',
      tenantId: null,
      currentEnvironmentD1Count: 0,
      environmentD1Limit: 10,
    });
    expect(shared.targets).toHaveLength(4);
    expect(shared.targets.map((target) => target.minimumRequiredUnits)).toEqual([1, 1, 1, 1]);

    database.exec(`
      UPDATE control_residency_partitions
         SET lookup_capacity_domain_id = 'lookup:shared:jp'
       WHERE environment_id = 'env-test' AND residency_policy_id = 'default';
      INSERT INTO control_residency_partitions (
        environment_id, residency_policy_id, residency_partition, location_hint,
        lookup_capacity_domain_id, status, created_at, updated_at
      ) VALUES (
        'env-test', 'secondary', 'jp', 'apac', 'lookup:shared:jp', 'active', 2, 2
      );
    `);
    const sharedCapacityDomain = await repository.getCapacityPlannerInput(
      'env-test',
      'shared_pool',
      null
    );
    const sharedLookupTargets = sharedCapacityDomain.targets.filter(
      (target) => target.resources[0]?.dataRole === 'lookup'
    );
    expect(sharedLookupTargets).toHaveLength(1);
    expect(sharedLookupTargets[0]).toMatchObject({
      unitKey: 'lookup:shared:jp',
      resources: [
        expect.objectContaining({
          lookupCapacityDomainId: 'lookup:shared:jp',
          residencyPolicyId: 'default',
          residencyPartition: 'jp',
        }),
      ],
    });
    database.exec(`
      UPDATE control_residency_partitions
         SET jurisdiction = 'eu', location_hint = NULL
       WHERE environment_id = 'env-test' AND residency_policy_id = 'secondary';
    `);
    await expect(
      repository.getCapacityPlannerInput('env-test', 'shared_pool', null)
    ).rejects.toThrow('control_lookup_capacity_domain_incompatible');
    database.exec(`
      DELETE FROM control_residency_partitions
       WHERE environment_id = 'env-test' AND residency_policy_id = 'secondary';
      UPDATE control_residency_partitions
         SET lookup_capacity_domain_id = NULL
       WHERE environment_id = 'env-test' AND residency_policy_id = 'default';
      INSERT INTO control_desired_resources (
        desired_resource_id, environment_id, resource_kind, logical_shard_id,
        deterministic_name, ownership_fingerprint, provisioning_state,
        origin_operation_id, desired_spec_json, created_at, updated_at
      ) VALUES (
        'resource-lookup-drift', 'env-test', 'd1', 'lookup-drift',
        'authrim-test-lookup-drift', 'fingerprint-lookup-drift', 'active',
        'op-release',
        '{"residency_policy_id":"default","lookup_capacity_domain_id":"lookup:stale:jp"}',
        2, 2
      );
      INSERT INTO control_lookup_physical_shards (
        lookup_shard_id, environment_id, residency_partition, binding_ref,
        d1_desired_resource_id, status, created_at, updated_at
      ) VALUES (
        'lookup-drift', 'env-test', 'jp', 'LOOKUP_DRIFT',
        'resource-lookup-drift', 'active', 2, 2
      );
    `);
    await expect(
      repository.getCapacityPlannerInput('env-test', 'shared_pool', null)
    ).rejects.toThrow('control_lookup_capacity_domain_drift');
    database.exec(`
      DELETE FROM control_lookup_physical_shards WHERE lookup_shard_id = 'lookup-drift';
      DELETE FROM control_desired_resources WHERE desired_resource_id = 'resource-lookup-drift';
    `);

    const sharedDefaultPlan: TenantShardPlan = {
      ...plan('shared-default-pending'),
      dataRole: 'tenant_core/default',
      logicalShardId: 'default:jp:shared-default-pending',
      databaseName: 'authrim-test-default-jp-shared-default-pending',
      bindingRef: 'TDB_DEFAULT_SHARED_PENDING',
      allocationScope: 'shared_pool',
      ownerTenantId: null,
    };
    await repository.createShardPlan(sharedDefaultPlan, 3, 'admin');
    const sharedWithInFlight = await repository.getCapacityPlannerInput(
      'env-test',
      'shared_pool',
      null
    );
    expect(
      sharedWithInFlight.targets.find(
        (target) => target.unitKey === 'default:jp:tenant_core/default'
      )
    ).toMatchObject({
      readyUnits: 0,
      inFlightUnits: 1,
      minimumRequiredUnits: 1,
      recommendedTargetUnits: 1,
    });

    database
      .prepare(
        `UPDATE control_tenant_shards SET status = 'active', updated_at = 4 WHERE shard_id = ?`
      )
      .run(sharedDefaultPlan.shardId);
    database
      .prepare(
        `INSERT INTO control_shard_capacity (
           shard_id, target_account_count, allocated_account_count, observed_account_count,
           health_status, allocation_status, updated_at
         ) VALUES (?, 100000, 0, 0, 'healthy', 'eligible', 4)`
      )
      .run(sharedDefaultPlan.shardId);
    const sharedWithHealthyCapacity = await repository.getCapacityPlannerInput(
      'env-test',
      'shared_pool',
      null
    );
    expect(
      sharedWithHealthyCapacity.targets.find(
        (target) => target.unitKey === 'default:jp:tenant_core/default'
      )
    ).toMatchObject({
      readyUnits: 1,
      inFlightUnits: 0,
      minimumRequiredUnits: 1,
      recommendedTargetUnits: 1,
    });

    const exclusive = await repository.getCapacityPlannerInput(
      'env-test',
      'tenant_exclusive',
      'tenant-exclusive'
    );
    expect(exclusive.targets).toHaveLength(3);
    expect(exclusive.targets.every((target) => target.readyUnits === 0)).toBe(true);

    const exclusiveDefaultPlan: TenantShardPlan = {
      ...plan('exclusive-default'),
      dataRole: 'tenant_core/default',
      logicalShardId: 'default:jp:exclusive-default',
      databaseName: 'authrim-test-default-jp-exclusive-default',
      bindingRef: 'TDB_DEFAULT_EXCLUSIVE_DEFAULT',
      allocationScope: 'tenant_exclusive',
      ownerTenantId: 'tenant-exclusive',
    };
    await repository.createShardPlan(exclusiveDefaultPlan, 3, 'admin');
    database
      .prepare(
        `UPDATE control_tenant_shards SET status = 'active', updated_at = 4 WHERE shard_id = ?`
      )
      .run(exclusiveDefaultPlan.shardId);

    const exclusiveAfterFullDefault = await repository.getCapacityPlannerInput(
      'env-test',
      'tenant_exclusive',
      'tenant-exclusive'
    );
    expect(
      exclusiveAfterFullDefault.targets.find(
        (target) => target.unitKey === 'default:jp:tenant_core/default'
      )
    ).toMatchObject({
      readyUnits: 1,
      inFlightUnits: 0,
      minimumRequiredUnits: 2,
      recommendedTargetUnits: 2,
    });
    await expect(
      repository.getCapacityPlannerInput('env-test', 'tenant_exclusive', 'missing-tenant')
    ).rejects.toThrow('control_capacity_tenant_policy_mismatch');
  });

  it('pins the active release atomically and rejects planning without one', async () => {
    const shardPlan = plan('pinned');
    await repository.createShardPlan(shardPlan, 100, 'admin');
    expect(
      database
        .prepare(
          `SELECT stream_id, release_id, manifest_digest
             FROM control_operation_release_pins WHERE operation_id = ?`
        )
        .get(shardPlan.operationId)
    ).toEqual({ stream_id: 'd1-core', release_id: '0.4.0', manifest_digest: 'a'.repeat(64) });
    expect(
      database
        .prepare(
          `SELECT state, stream_id, release_id
             FROM control_tenant_database_migration_state WHERE desired_resource_id = ?`
        )
        .get(shardPlan.desiredResourceId)
    ).toEqual({ state: 'requested', stream_id: 'd1-core', release_id: '0.4.0' });

    database.exec(`UPDATE control_migration_release_catalog
      SET state = 'retired', active_stream_key = 'release:0.4.0'
      WHERE environment_id = 'env-test' AND stream_id = 'd1-core'`);
    const missingPlan = plan('missing');
    await expect(repository.createShardPlan(missingPlan, 101, 'admin')).rejects.toThrow(
      'control_active_migration_release_missing'
    );
    expect(
      database
        .prepare('SELECT COUNT(*) AS count FROM control_operations WHERE operation_id = ?')
        .get(missingPlan.operationId)
    ).toEqual({ count: 0 });
  });

  it('returns redacted provisioning steps only within the owning environment', async () => {
    const shardPlan = plan('status');
    await repository.createShardPlan(shardPlan, 100, 'admin');

    const detail = await repository.getProvisioningOperation(shardPlan.operationId, 'env-test');
    expect(detail).toMatchObject({
      operationId: shardPlan.operationId,
      operationKind: 'provision_shard',
      status: 'queued',
      availableActions: [],
    });
    expect(detail?.steps.map((step) => step.stepKey)).toEqual([
      'create_d1',
      'apply_migrations',
      'reconcile_worker_bindings',
      'smoke_bindings',
      'stabilize_bindings',
    ]);
    expect(JSON.stringify(detail)).not.toContain('lastErrorRedacted');
    await expect(
      repository.getProvisioningOperation(shardPlan.operationId, 'env-other')
    ).resolves.toBeNull();
  });

  it('retries a blocked D1 creation with a fresh budget and idempotent audit evidence', async () => {
    const shardPlan = plan('manual-retry-create');
    await repository.createShardPlan(shardPlan, 100, 'admin');
    const lease = await repository.tryStartProvisioning(shardPlan.operationId, 'create-owner', 100);
    if (!lease) throw new Error('expected_create_lease');
    await repository.markOperationBlocked(lease, 'cloudflare_d1_retry_budget_exhausted', 200);

    const request = {
      operationId: shardPlan.operationId,
      stepKey: 'create_d1' as const,
      requestedById: 'admin-1',
      reasonCode: 'operator_retry' as const,
      idempotencyKey: 'manual-retry-create-1',
    };
    const retried = await repository.retryProvisioningOperationStep(request, 'env-test', 500);
    expect(retried).toMatchObject({
      operationId: shardPlan.operationId,
      status: 'running',
      lastErrorCode: null,
    });
    expect(retried.steps.find((step) => step.stepKey === 'create_d1')).toMatchObject({
      status: 'running',
      lastErrorCode: null,
    });
    expect(
      database
        .prepare(
          `SELECT retry_budget_started_at, lock_expires_at
             FROM control_operations WHERE operation_id = ?`
        )
        .get(shardPlan.operationId)
    ).toEqual({ retry_budget_started_at: 500, lock_expires_at: 500 });
    expect(
      database
        .prepare(
          `SELECT event_type, actor_type, actor_id, resource_id, outcome, redacted_payload_json
             FROM control_audit_events
            WHERE event_id = ?`
        )
        .get('audit:env-test:operator-retry:manual-retry-create-1')
    ).toEqual({
      event_type: 'control.operation.retry_step',
      actor_type: 'admin',
      actor_id: 'admin-1',
      resource_id: 'create_d1',
      outcome: 'succeeded',
      redacted_payload_json: JSON.stringify({
        step_key: 'create_d1',
        reason_code: 'operator_retry',
        idempotency_key: 'manual-retry-create-1',
        before: { operation_status: 'blocked', step_status: 'blocked' },
        after: { operation_status: 'running', step_status: 'running' },
      }),
    });

    const resumed = await repository.tryStartProvisioning(
      shardPlan.operationId,
      'retry-owner',
      500
    );
    expect(resumed?.operation.retryBudgetStartedAt).toBe(500);
    await expect(
      repository.retryProvisioningOperationStep(request, 'env-test', 501)
    ).resolves.toMatchObject({ operationId: shardPlan.operationId, status: 'running' });
    await expect(
      repository.retryProvisioningOperationStep(
        { ...request, operationId: 'different-operation' },
        'env-test',
        501
      )
    ).rejects.toThrow('control_operation_retry_conflict');
  });

  it('retries only a settings request rejected before a Worker version was created', async () => {
    const shardPlan = plan('manual-retry-worker-settings');
    await repository.createShardPlan(shardPlan, 100, 'admin');
    insertRejectedWorkerSettingsBinding(database, shardPlan);

    await expect(
      repository.getProvisioningOperation(shardPlan.operationId, 'env-test')
    ).resolves.toMatchObject({
      availableActions: ['retry_reconcile_worker_bindings'],
    });

    const retried = await repository.retryProvisioningOperationStep(
      {
        operationId: shardPlan.operationId,
        stepKey: 'reconcile_worker_bindings',
        requestedById: 'admin-1',
        reasonCode: 'operator_retry',
        idempotencyKey: 'manual-retry-worker-settings-1',
      },
      'env-test',
      500
    );
    expect(retried).toMatchObject({ status: 'running', availableActions: [] });
    expect(
      retried.steps.find((step) => step.stepKey === 'reconcile_worker_bindings')
    ).toMatchObject({ status: 'running', lastErrorCode: null });
    expect(
      database
        .prepare(
          `SELECT state, expected_source_version_id, previous_deployment_id,
                  previous_restore_settings_json, last_error_code
             FROM control_worker_binding_reconciliations WHERE operation_id = ?`
        )
        .get(shardPlan.operationId)
    ).toEqual({
      state: 'pending',
      expected_source_version_id: null,
      previous_deployment_id: null,
      previous_restore_settings_json: null,
      last_error_code: null,
    });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM control_worker_deployment_leases
            WHERE owner_operation_id = ?`
        )
        .get(shardPlan.operationId)
    ).toEqual({ count: 0 });
  });

  it('does not retry an ambiguous Worker settings failure', async () => {
    const shardPlan = plan('manual-retry-worker-settings-denied');
    await repository.createShardPlan(shardPlan, 100, 'admin');
    insertRejectedWorkerSettingsBinding(
      database,
      shardPlan,
      'control_worker_source_version_changed'
    );
    const request = {
      operationId: shardPlan.operationId,
      stepKey: 'reconcile_worker_bindings' as const,
      requestedById: 'admin-1',
      reasonCode: 'operator_retry' as const,
      idempotencyKey: 'manual-retry-worker-settings-denied-1',
    };

    await expect(
      repository.getProvisioningOperation(shardPlan.operationId, 'env-test')
    ).resolves.toMatchObject({ availableActions: [] });
    await expect(
      repository.retryProvisioningOperationStep(request, 'env-test', 500)
    ).rejects.toThrow('control_operation_retry_not_retryable');
  });

  it('atomically blocks Automatic provisioning authority after a provider capability rejection', async () => {
    database.exec(`UPDATE control_environments
      SET automatic_provisioning_enabled = 1,
          provisioning_token_ownership = 'account',
          provisioning_capability_state = 'ready',
          provisioning_capability_checked_at = 90,
          updated_at = 90
      WHERE environment_id = 'env-test'`);
    const shardPlan = plan('authority-blocked');
    await repository.createShardPlan(shardPlan, 100, 'admin');
    const lease = await repository.tryStartProvisioning(
      shardPlan.operationId,
      'authority-owner',
      110
    );
    if (!lease) throw new Error('expected_authority_lease');

    await repository.markOperationBlocked(lease, 'cloudflare_d1_capability_rejected', 120);

    expect(
      database
        .prepare(
          `SELECT provisioning_capability_state, provisioning_capability_checked_at
             FROM control_environments WHERE environment_id = 'env-test'`
        )
        .get()
    ).toEqual({
      provisioning_capability_state: 'blocked',
      provisioning_capability_checked_at: 120,
    });
    expect(
      database
        .prepare(
          `SELECT event_type, outcome, redacted_payload_json
             FROM control_audit_events
            WHERE event_type = 'control.provisioning.authority_blocked'`
        )
        .get()
    ).toEqual({
      event_type: 'control.provisioning.authority_blocked',
      outcome: 'blocked',
      redacted_payload_json: JSON.stringify({
        reason_code: 'cloudflare_d1_capability_rejected',
      }),
    });
  });

  it('atomically blocks Automatic provisioning authority after a Workers capability rejection', async () => {
    database.exec(`UPDATE control_environments
      SET automatic_provisioning_enabled = 1,
          provisioning_token_ownership = 'user',
          provisioning_capability_state = 'ready',
          provisioning_capability_checked_at = 90,
          updated_at = 90
      WHERE environment_id = 'env-test'`);
    const shardPlan = plan('workers-authority-blocked');
    await repository.createShardPlan(shardPlan, 100, 'admin');
    insertRollbackFailedBinding(database, shardPlan);
    const bindingRepository = new D1WorkerBindingRepository(d1Adapter(database));

    await bindingRepository.markBlocked(
      {
        operationId: shardPlan.operationId,
        environmentId: shardPlan.environmentId,
        environmentName: shardPlan.environmentName,
        workerScriptName: 'ar-auth-test',
        shardId: shardPlan.shardId,
        bindingRef: shardPlan.bindingRef,
        dataRole: shardPlan.dataRole,
        residencyPartition: shardPlan.residencyPartition,
        migrationGeneration: 1,
        databaseId: 'provider-database-id',
        state: 'blocked',
        expectedSourceVersionId: 'version-before',
        previousDeploymentId: 'deployment-before',
        patchResultVersionId: 'version-patched',
        patchResultDeploymentId: 'deployment-patched',
        previousRestoreSettingsJson: '{}',
        smokeAttemptCount: 0,
        consecutiveSmokeSuccesses: 0,
        stabilizationNotBefore: null,
        lastErrorCode: 'control_worker_rollback_failed',
        manualSettingsRestoreRequested: false,
      },
      'control_workers_capability_rejected',
      130
    );

    expect(
      database
        .prepare(
          `SELECT provisioning_capability_state, provisioning_capability_checked_at
             FROM control_environments WHERE environment_id = 'env-test'`
        )
        .get()
    ).toEqual({
      provisioning_capability_state: 'blocked',
      provisioning_capability_checked_at: 130,
    });
    expect(
      database
        .prepare(
          `SELECT outcome, redacted_payload_json FROM control_audit_events
            WHERE event_type = 'control.provisioning.authority_blocked'`
        )
        .get()
    ).toEqual({
      outcome: 'blocked',
      redacted_payload_json: JSON.stringify({
        reason_code: 'control_workers_capability_rejected',
      }),
    });
  });

  it('blocks the operation but preserves a pre-mutation target as pending', async () => {
    const shardPlan = plan('binding-preflight-blocked');
    await repository.createShardPlan(shardPlan, 100, 'admin');
    database.exec(`INSERT INTO control_desired_worker_inventory (
      environment_id, worker_script_name, package_name, deployment_target,
      capability_manifest_digest, source_manifest_path, source_manifest_hash,
      generated_artifact_hash, source_kind, source_reference, status,
      registered_by_operation_id, registered_by, registered_at
    ) VALUES (
      'env-test', 'test-ar-auth', '@authrim/ar-auth', 'test-ar-auth',
      '${'b'.repeat(64)}', 'packages/ar-auth/authrim.worker-capabilities.json',
      '${'c'.repeat(64)}', '${'d'.repeat(64)}', 'core_manifest', 'test-fixture', 'active',
      'op-release', 'setup:test', 101
    );`);
    database
      .prepare(
        `INSERT INTO control_worker_binding_reconciliations (
           operation_id, environment_id, worker_script_name, shard_id, binding_ref,
           data_role, residency_partition, migration_generation, provider_database_id,
           state, created_at, updated_at
         ) VALUES (?, 'env-test', 'test-ar-auth', ?, ?, 'tenant_core/users', 'jp', 1,
                   'provider-database-id', 'pending', 102, 102)`
      )
      .run(shardPlan.operationId, shardPlan.shardId, shardPlan.bindingRef);
    database
      .prepare(`UPDATE control_operations SET status = 'running' WHERE operation_id = ?`)
      .run(shardPlan.operationId);
    const bindingRepository = new D1WorkerBindingRepository(d1Adapter(database));
    const [target] = await bindingRepository.listDueTargets(10, 103);
    if (!target) throw new Error('expected_worker_binding_target');

    await expect(
      bindingRepository.markBlocked(target, 'control_worker_preflight_rejected', 104)
    ).resolves.toBeUndefined();
    expect(
      database
        .prepare(
          `SELECT state, expected_source_version_id, previous_restore_settings_json,
                  last_error_code
             FROM control_worker_binding_reconciliations
            WHERE operation_id = ? AND worker_script_name = ? AND binding_ref = ?`
        )
        .get(shardPlan.operationId, 'test-ar-auth', shardPlan.bindingRef)
    ).toEqual({
      state: 'pending',
      expected_source_version_id: null,
      previous_restore_settings_json: null,
      last_error_code: 'control_worker_preflight_rejected',
    });
    expect(
      database
        .prepare(`SELECT status, last_error_code FROM control_operations WHERE operation_id = ?`)
        .get(shardPlan.operationId)
    ).toEqual({ status: 'blocked', last_error_code: 'control_worker_preflight_rejected' });
    await expect(bindingRepository.listDueTargets(10, 105)).resolves.toEqual([]);
  });

  it('retries only a blocked migration whose D1 already exists', async () => {
    const shardPlan = plan('manual-retry-migration');
    await repository.createShardPlan(shardPlan, 100, 'admin');
    const createLease = await repository.tryStartProvisioning(
      shardPlan.operationId,
      'create-owner',
      100
    );
    if (!createLease) throw new Error('expected_create_lease');
    database
      .prepare(
        `UPDATE control_operation_steps
            SET next_attempt_at = 109, last_error_code = 'cloudflare_d1_request_failed',
                last_error_redacted = 'redacted'
          WHERE operation_id = ? AND step_key = 'create_d1'`
      )
      .run(shardPlan.operationId);
    await repository.markDatabaseCreated(createLease, shardPlan, 'database-id', 'disabled', 110);
    expect(
      database
        .prepare(
          `SELECT status, next_attempt_at, last_error_code, last_error_redacted
             FROM control_operation_steps
            WHERE operation_id = ? AND step_key = 'create_d1'`
        )
        .get(shardPlan.operationId)
    ).toEqual({
      status: 'succeeded',
      next_attempt_at: null,
      last_error_code: null,
      last_error_redacted: null,
    });
    const migrationLease = await repository.tryStartMigration(
      shardPlan.operationId,
      'migration-owner',
      120
    );
    if (!migrationLease) throw new Error('expected_migration_lease');
    await repository.markMigrationBlocked(
      migrationLease,
      'cloudflare_d1_retry_budget_exhausted',
      130
    );

    const retried = await repository.retryProvisioningOperationStep(
      {
        operationId: shardPlan.operationId,
        stepKey: 'apply_migrations',
        requestedById: 'admin-1',
        reasonCode: 'operator_retry',
        idempotencyKey: 'manual-retry-migration-1',
      },
      'env-test',
      500
    );
    expect(retried.status).toBe('running');
    expect(retried.steps.find((step) => step.stepKey === 'apply_migrations')).toMatchObject({
      status: 'running',
    });
    expect(
      database
        .prepare(
          `SELECT state, last_error_code
             FROM control_tenant_database_migration_state WHERE operation_id = ?`
        )
        .get(shardPlan.operationId)
    ).toEqual({ state: 'waiting_retry', last_error_code: null });
    const resumed = await repository.tryStartMigration(
      shardPlan.operationId,
      'migration-retry-owner',
      500
    );
    expect(resumed?.operation.retryBudgetStartedAt).toBe(500);
  });

  it('rejects unsupported, cross-environment, and non-blocked manual retries', async () => {
    const shardPlan = plan('manual-retry-rejected');
    await repository.createShardPlan(shardPlan, 100, 'admin');
    const request = {
      operationId: shardPlan.operationId,
      stepKey: 'create_d1' as const,
      requestedById: 'admin-1',
      reasonCode: 'operator_retry' as const,
      idempotencyKey: 'manual-retry-rejected-1',
    };
    await expect(
      repository.retryProvisioningOperationStep(request, 'env-test', 200)
    ).rejects.toThrow('control_operation_retry_not_retryable');
    await expect(
      repository.retryProvisioningOperationStep(
        { ...request, idempotencyKey: 'manual-retry-cross-environment' },
        'env-other',
        200
      )
    ).rejects.toThrow('control_operation_retry_not_retryable');
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM control_audit_events
            WHERE event_type = 'control.operation.retry_step'`
        )
        .get()
    ).toEqual({ count: 0 });
  });

  it('cancels a blocked pre-activation operation while retaining provider evidence', async () => {
    const shardPlan = plan('manual-cancel');
    await repository.createShardPlan(shardPlan, 100, 'admin');
    const createLease = await repository.tryStartProvisioning(
      shardPlan.operationId,
      'create-owner',
      100
    );
    if (!createLease) throw new Error('expected_create_lease');
    await repository.markDatabaseCreated(createLease, shardPlan, 'database-id', 'disabled', 110);
    const migrationLease = await repository.tryStartMigration(
      shardPlan.operationId,
      'migration-owner',
      120
    );
    if (!migrationLease) throw new Error('expected_migration_lease');
    await repository.markMigrationBlocked(
      migrationLease,
      'cloudflare_d1_retry_budget_exhausted',
      130
    );

    const before = await repository.getProvisioningOperation(shardPlan.operationId, 'env-test');
    expect(before?.availableActions).toEqual(['retry_apply_migrations', 'cancel']);
    const request = {
      operationId: shardPlan.operationId,
      requestedById: 'admin-1',
      reasonCode: 'operator_cancel' as const,
      idempotencyKey: 'manual-cancel-1',
    };
    const canceled = await repository.cancelProvisioningOperation(request, 'env-test', 200);

    expect(canceled.status).toBe('canceled');
    expect(canceled.availableActions).toEqual([]);
    expect(canceled.steps.map((step) => [step.stepKey, step.status])).toEqual([
      ['create_d1', 'succeeded'],
      ['apply_migrations', 'canceled'],
      ['reconcile_worker_bindings', 'canceled'],
      ['smoke_bindings', 'canceled'],
      ['stabilize_bindings', 'canceled'],
    ]);
    expect(
      database
        .prepare(
          `SELECT desired.observed_resource_id, observed.provider_resource_id,
                  migration.provider_database_id, migration.state
             FROM control_desired_resources desired
             JOIN control_observed_resources observed
               ON observed.observed_resource_id = desired.observed_resource_id
             JOIN control_tenant_database_migration_state migration
               ON migration.desired_resource_id = desired.desired_resource_id
            WHERE desired.origin_operation_id = ?`
        )
        .get(shardPlan.operationId)
    ).toEqual({
      observed_resource_id: `observed:${shardPlan.desiredResourceId}`,
      provider_resource_id: 'database-id',
      provider_database_id: 'database-id',
      state: 'blocked',
    });
    expect(
      database
        .prepare(
          `SELECT event_type, actor_type, actor_id, resource_id, outcome, redacted_payload_json
             FROM control_audit_events WHERE event_id = ?`
        )
        .get('audit:env-test:operator-cancel:manual-cancel-1')
    ).toEqual({
      event_type: 'control.operation.cancel',
      actor_type: 'admin',
      actor_id: 'admin-1',
      resource_id: shardPlan.operationId,
      outcome: 'succeeded',
      redacted_payload_json: JSON.stringify({
        reason_code: 'operator_cancel',
        idempotency_key: 'manual-cancel-1',
        before: { operation_status: 'blocked' },
        after: { operation_status: 'canceled' },
        retained_resources: true,
      }),
    });
    await expect(
      repository.cancelProvisioningOperation(request, 'env-test', 201)
    ).resolves.toMatchObject({ status: 'canceled' });
    await expect(
      repository.cancelProvisioningOperation(
        { ...request, operationId: 'different-operation' },
        'env-test',
        201
      )
    ).rejects.toThrow('control_operation_cancel_conflict');
  });

  it('cancels a blocked plugin-resource operation so Control can quarantine its resources', async () => {
    database.exec(`
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, attempt_count, last_error_code, created_at, updated_at
      ) VALUES (
        'plugin-resource-op', 'env-test', 'provision_plugin_resources',
        'plugin-resource-op', 'blocked', 'admin', 1, 'plugin_resource_provider_request_rejected',
        100, 100
      );
      INSERT INTO control_operation_steps (
        operation_id, step_key, display_order, status, attempt_count, last_error_code, updated_at
      ) VALUES (
        'plugin-resource-op', 'plugin_resource_provider', 0, 'blocked', 1,
        'plugin_resource_provider_request_rejected', 100
      );
      INSERT INTO control_plugin_desired_resources (
        plugin_resource_id, environment_id, operation_id, plugin_installation_id,
        tenant_id, resource_kind, logical_resource_id, binding_name, lifecycle_mode,
        provider_resource_id, provider_name, injection_policy_json, desired_spec_json,
        status, updated_at
      ) VALUES (
        'plugin-resource-a', 'env-test', 'plugin-resource-op', 'plugin-installation-a',
        'tenant-a', 'kv_namespace', 'cache', 'PLUGIN_CACHE', 'managed',
        'namespace-a', 'namespace-a', '{}',
        '{"pluginId":"plugin-a","ownershipFingerprint":"${'a'.repeat(64)}","ownership":"authrim_managed","deleteProviderResource":true}',
        'failed', 100
      );
    `);

    await expect(
      repository.getProvisioningOperation('plugin-resource-op', 'env-test')
    ).resolves.toMatchObject({ availableActions: ['cancel'] });

    const canceled = await repository.cancelProvisioningOperation(
      {
        operationId: 'plugin-resource-op',
        requestedById: 'admin-1',
        reasonCode: 'operator_cancel',
        idempotencyKey: 'cancel-plugin-resource-a',
      },
      'env-test',
      200
    );

    expect(canceled).toMatchObject({
      operationId: 'plugin-resource-op',
      operationKind: 'provision_plugin_resources',
      status: 'canceled',
    });
    expect(canceled.steps).toEqual([
      expect.objectContaining({ stepKey: 'plugin_resource_provider', status: 'canceled' }),
    ]);
    expect(
      database
        .prepare(
          `SELECT status, provider_resource_id FROM control_plugin_desired_resources
            WHERE plugin_resource_id = 'plugin-resource-a'`
        )
        .get()
    ).toEqual({ status: 'failed', provider_resource_id: 'namespace-a' });
  });

  it('fails closed when a route already references the shard being canceled', async () => {
    const shardPlan = plan('cancel-routed');
    await repository.createShardPlan(shardPlan, 100, 'admin');
    const lease = await repository.tryStartProvisioning(shardPlan.operationId, 'owner', 100);
    if (!lease) throw new Error('expected_create_lease');
    await repository.markOperationBlocked(lease, 'cloudflare_d1_retry_budget_exhausted', 110);
    database
      .prepare(
        `INSERT INTO control_runtime_registry_routes (
           environment_id, tenant_id, route_generation, tenant_lifecycle_generation,
           registry_publication_generation, tenant_lifecycle_state, route_status,
           residency_policy_id, route_projection_json, source_operation_id, created_at, updated_at
         ) VALUES (?, 'tenant-1', 1, 1, 1, 'creating', 'pending', 'default', ?, ?, 120, 120)`
      )
      .run(
        'env-test',
        JSON.stringify({ target: { shardId: shardPlan.shardId } }),
        shardPlan.operationId
      );

    const detail = await repository.getProvisioningOperation(shardPlan.operationId, 'env-test');
    expect(detail?.availableActions).toEqual(['retry_create_d1']);
    await expect(
      repository.cancelProvisioningOperation(
        {
          operationId: shardPlan.operationId,
          requestedById: 'admin-1',
          reasonCode: 'operator_cancel',
          idempotencyKey: 'cancel-routed-1',
        },
        'env-test',
        130
      )
    ).rejects.toThrow('control_operation_cancel_not_allowed');
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM control_audit_events
            WHERE event_type = 'control.operation.cancel'`
        )
        .get()
    ).toEqual({ count: 0 });
  });

  it('does not offer cancel after allocation or Worker binding reconciliation starts', async () => {
    const allocatedPlan = plan('cancel-allocated');
    await repository.createShardPlan(allocatedPlan, 100, 'admin');
    const allocationLease = await repository.tryStartProvisioning(
      allocatedPlan.operationId,
      'allocation-owner',
      100
    );
    if (!allocationLease) throw new Error('expected_create_lease');
    await repository.markOperationBlocked(
      allocationLease,
      'cloudflare_d1_retry_budget_exhausted',
      110
    );
    database.exec(
      `INSERT INTO control_tenant_placement_policies (
         environment_id, tenant_id, isolation_policy, policy_generation, policy_state,
         source_operation_id, idempotency_key, activated_at, created_at, updated_at
       ) VALUES ('env-test', 'tenant-1', 'shared_pool', 1, 'active',
                 'tenant-create-1', 'tenant-placement-1', 110, 110, 110);
       UPDATE control_tenant_shards
          SET status = 'active', updated_at = 110
        WHERE shard_id = '${allocatedPlan.shardId}';
       INSERT INTO control_tenant_shard_assignments (
         environment_id, tenant_id, data_role, residency_policy_id, residency_partition,
         shard_id, assignment_generation, assignment_state, source_operation_id,
         created_at, activated_at, updated_at
       ) VALUES ('env-test', 'tenant-1', 'tenant_core/users', 'default', 'jp',
                 '${allocatedPlan.shardId}', 1, 'active', '${allocatedPlan.operationId}',
                 110, 110, 110);`
    );
    database
      .prepare(
        `INSERT INTO control_tenant_shard_allocations (
           allocation_id, environment_id, tenant_id, account_id_blind_digest, data_role,
           residency_partition, selected_shard_id, reservation_state, idempotency_key,
           route_generation, created_at, updated_at
         ) VALUES ('allocation-1', 'env-test', 'tenant-1', 'digest-1', 'tenant_core/users',
                   'jp', ?, 'reserved', 'allocation-1', 1, 120, 120)`
      )
      .run(allocatedPlan.shardId);
    expect(
      (await repository.getProvisioningOperation(allocatedPlan.operationId, 'env-test'))
        ?.availableActions
    ).toEqual(['retry_create_d1']);

    const bindingPlan = plan('cancel-binding');
    await repository.createShardPlan(bindingPlan, 130, 'admin');
    const bindingLease = await repository.tryStartProvisioning(
      bindingPlan.operationId,
      'binding-owner',
      130
    );
    if (!bindingLease) throw new Error('expected_create_lease');
    await repository.markOperationBlocked(
      bindingLease,
      'cloudflare_d1_retry_budget_exhausted',
      140
    );
    database.exec(
      `INSERT INTO control_desired_worker_inventory (
         environment_id, worker_script_name, package_name, deployment_target,
         capability_manifest_digest, source_manifest_path, source_manifest_hash,
         generated_artifact_hash, source_kind, source_reference,
         registered_by_operation_id, registered_by, registered_at
       ) VALUES (
         'env-test', 'ar-auth-test', '@authrim/ar-auth', 'ar-auth-test', '${'b'.repeat(64)}',
         'packages/ar-auth/authrim.worker-capabilities.json', '${'c'.repeat(64)}',
         '${'d'.repeat(64)}', 'core_manifest', '@authrim/ar-auth', 'op-release', 'setup:test', 140
       );`
    );
    database
      .prepare(
        `INSERT INTO control_worker_binding_reconciliations (
           operation_id, environment_id, worker_script_name, shard_id, binding_ref,
           data_role, residency_partition, migration_generation, provider_database_id,
           state, created_at, updated_at
         ) VALUES (?, 'env-test', 'ar-auth-test', ?, ?, 'tenant_core/users', 'jp', 1,
                   'provider-database-id', 'pending', 150, 150)`
      )
      .run(bindingPlan.operationId, bindingPlan.shardId, bindingPlan.bindingRef);
    expect(
      (await repository.getProvisioningOperation(bindingPlan.operationId, 'env-test'))
        ?.availableActions
    ).toEqual(['retry_create_d1']);
  });

  it('requeues only a recorded rollback failure for guarded previous-settings restore', async () => {
    const shardPlan = plan('manual-restore-settings');
    await repository.createShardPlan(shardPlan, 100, 'admin');
    insertRollbackFailedBinding(database, shardPlan);

    const before = await repository.getProvisioningOperation(shardPlan.operationId, 'env-test');
    expect(before?.availableActions).toEqual(['restore_previous_settings']);
    const request = {
      operationId: shardPlan.operationId,
      requestedById: 'admin-1',
      reasonCode: 'operator_restore_previous_settings' as const,
      idempotencyKey: 'manual-restore-settings-1',
    };
    const restored = await repository.restoreProvisioningOperationPreviousSettings(
      request,
      'env-test',
      200
    );

    expect(restored).toMatchObject({ status: 'running', availableActions: [] });
    expect(
      database
        .prepare(
          `SELECT state, last_error_code
             FROM control_worker_binding_reconciliations
            WHERE operation_id = ?`
        )
        .get(shardPlan.operationId)
    ).toEqual({
      state: 'rollback_required',
      last_error_code: 'control_worker_manual_restore_requested',
    });
    expect(
      restored.steps
        .filter((step) => step.stepKey.includes('binding'))
        .map((step) => [step.stepKey, step.status])
    ).toEqual([
      ['reconcile_worker_bindings', 'running'],
      ['smoke_bindings', 'running'],
      ['stabilize_bindings', 'running'],
    ]);
    const audit = database
      .prepare(
        `SELECT event_type, actor_id, resource_id, redacted_payload_json
           FROM control_audit_events WHERE event_id = ?`
      )
      .get('audit:env-test:operator-restore-settings:manual-restore-settings-1');
    expect(audit).toEqual({
      event_type: 'control.operation.restore_previous_settings',
      actor_id: 'admin-1',
      resource_id: shardPlan.operationId,
      redacted_payload_json: JSON.stringify({
        reason_code: 'operator_restore_previous_settings',
        idempotency_key: 'manual-restore-settings-1',
        before: { operation_status: 'blocked', binding_state: 'blocked' },
        after: { operation_status: 'running', binding_state: 'rollback_required' },
        provider_mutation: 'deferred_to_reconciler',
      }),
    });
    expect(JSON.stringify(audit)).not.toContain('existing-binding');
    await expect(
      repository.restoreProvisioningOperationPreviousSettings(request, 'env-test', 201)
    ).resolves.toMatchObject({ status: 'running' });
    await expect(
      repository.restoreProvisioningOperationPreviousSettings(
        { ...request, requestedById: 'admin-2' },
        'env-test',
        201
      )
    ).rejects.toThrow('control_operation_restore_conflict');

    const bindingRepository = new D1WorkerBindingRepository(d1Adapter(database));
    const [restoreTarget] = await bindingRepository.listDueTargets(10, 202);
    expect(restoreTarget?.manualSettingsRestoreRequested).toBe(true);
    if (!restoreTarget) throw new Error('expected_restore_target');
    await bindingRepository.recordTransientError(
      restoreTarget,
      'control_worker_deployment_lease_busy',
      220,
      202
    );
    expect(
      database
        .prepare(
          `SELECT status, last_error_code, last_error_redacted
             FROM control_operations WHERE operation_id = ?`
        )
        .get(shardPlan.operationId)
    ).toEqual({
      status: 'waiting_retry',
      last_error_code: null,
      last_error_redacted: null,
    });
    await expect(bindingRepository.listDueTargets(10, 203)).resolves.toEqual([]);
    const [retriedTarget] = await bindingRepository.listDueTargets(10, 220);
    expect(retriedTarget).toMatchObject({
      lastErrorCode: 'control_worker_deployment_lease_busy',
      manualSettingsRestoreRequested: true,
    });
    if (!retriedTarget) throw new Error('expected_retried_restore_target');
    await bindingRepository.recordTransientError(
      retriedTarget,
      'control_worker_settings_request_failed',
      240,
      220
    );
    expect(
      database
        .prepare(
          `SELECT status, last_error_code, last_error_redacted
             FROM control_operations WHERE operation_id = ?`
        )
        .get(shardPlan.operationId)
    ).toEqual({
      status: 'waiting_retry',
      last_error_code: 'control_worker_settings_request_failed',
      last_error_redacted: 'control_worker_settings_request_failed',
    });

    await bindingRepository.ensurePendingTargets(221);
    expect(
      database
        .prepare(
          `SELECT status, last_error_code, last_error_redacted
             FROM control_operations WHERE operation_id = ?`
        )
        .get(shardPlan.operationId)
    ).toEqual({
      status: 'waiting_retry',
      last_error_code: 'control_worker_settings_request_failed',
      last_error_redacted: 'control_worker_settings_request_failed',
    });

    database
      .prepare(
        `UPDATE control_worker_binding_reconciliations
            SET state = 'pending', last_error_code = NULL, updated_at = 221
          WHERE operation_id = ?`
      )
      .run(shardPlan.operationId);
    database
      .prepare(
        `UPDATE control_operations
            SET last_error_code = 'control_worker_binding_reconciliation_failed',
                last_error_redacted = 'control_worker_binding_reconciliation_failed',
                updated_at = 221
          WHERE operation_id = ?`
      )
      .run(shardPlan.operationId);

    await bindingRepository.ensurePendingTargets(222);

    expect(
      database
        .prepare(
          `SELECT status, last_error_code, last_error_redacted
             FROM control_operations WHERE operation_id = ?`
        )
        .get(shardPlan.operationId)
    ).toEqual({
      status: 'waiting_retry',
      last_error_code: null,
      last_error_redacted: null,
    });
  });

  it('does not offer restore when blocked binding failures require different repairs', async () => {
    const shardPlan = plan('manual-restore-mixed');
    await repository.createShardPlan(shardPlan, 100, 'admin');
    insertRollbackFailedBinding(database, shardPlan);
    insertRollbackFailedBinding(database, shardPlan, {
      workerScriptName: 'ar-token-test',
      errorCode: 'control_worker_newer_deployment_detected',
    });
    database
      .prepare(
        `UPDATE control_worker_binding_reconciliations
            SET last_error_code = NULL
          WHERE operation_id = ? AND worker_script_name = 'ar-token-test'`
      )
      .run(shardPlan.operationId);

    expect(
      (await repository.getProvisioningOperation(shardPlan.operationId, 'env-test'))
        ?.availableActions
    ).toEqual([]);
    await expect(
      repository.restoreProvisioningOperationPreviousSettings(
        {
          operationId: shardPlan.operationId,
          requestedById: 'admin-1',
          reasonCode: 'operator_restore_previous_settings',
          idempotencyKey: 'manual-restore-mixed-1',
        },
        'env-test',
        200
      )
    ).rejects.toThrow('control_operation_restore_not_allowed');
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM control_audit_events
            WHERE event_type = 'control.operation.restore_previous_settings'`
        )
        .get()
    ).toEqual({ count: 0 });
  });

  it('does not partially restore when another rollback target lacks required evidence', async () => {
    const shardPlan = plan('manual-restore-incomplete-evidence');
    await repository.createShardPlan(shardPlan, 100, 'admin');
    insertRollbackFailedBinding(database, shardPlan);
    insertRollbackFailedBinding(database, shardPlan, {
      workerScriptName: 'ar-token-test',
    });
    database
      .prepare(
        `UPDATE control_worker_binding_reconciliations
            SET patch_result_deployment_id = NULL
          WHERE operation_id = ? AND worker_script_name = 'ar-token-test'`
      )
      .run(shardPlan.operationId);

    expect(
      (await repository.getProvisioningOperation(shardPlan.operationId, 'env-test'))
        ?.availableActions
    ).toEqual([]);
    await expect(
      repository.restoreProvisioningOperationPreviousSettings(
        {
          operationId: shardPlan.operationId,
          requestedById: 'admin-1',
          reasonCode: 'operator_restore_previous_settings',
          idempotencyKey: 'manual-restore-incomplete-evidence-1',
        },
        'env-test',
        200
      )
    ).rejects.toThrow('control_operation_restore_not_allowed');
    expect(
      database
        .prepare(
          `SELECT state FROM control_worker_binding_reconciliations
            WHERE operation_id = ? ORDER BY worker_script_name`
        )
        .all(shardPlan.operationId)
    ).toEqual([{ state: 'blocked' }, { state: 'blocked' }]);
  });

  it('does not restore a blocked binding when no binding step remains repairable', async () => {
    const shardPlan = plan('manual-restore-no-blocked-step');
    await repository.createShardPlan(shardPlan, 100, 'admin');
    insertRollbackFailedBinding(database, shardPlan);
    database
      .prepare(
        `UPDATE control_operation_steps
            SET status = 'canceled', updated_at = 151
          WHERE operation_id = ?
            AND step_key IN (
              'reconcile_worker_bindings',
              'smoke_bindings',
              'stabilize_bindings'
            )`
      )
      .run(shardPlan.operationId);

    expect(
      (await repository.getProvisioningOperation(shardPlan.operationId, 'env-test'))
        ?.availableActions
    ).toEqual([]);
    await expect(
      repository.restoreProvisioningOperationPreviousSettings(
        {
          operationId: shardPlan.operationId,
          requestedById: 'admin-1',
          reasonCode: 'operator_restore_previous_settings',
          idempotencyKey: 'manual-restore-no-blocked-step-1',
        },
        'env-test',
        200
      )
    ).rejects.toThrow('control_operation_restore_not_allowed');
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM control_audit_events
            WHERE event_type = 'control.operation.restore_previous_settings'`
        )
        .get()
    ).toEqual({ count: 0 });
  });

  it('blocks a ready shard when no active Worker requires its data role', async () => {
    const shardPlan = plan('no-target');
    await repository.createShardPlan(shardPlan, 100, 'scheduler');
    const createLease = await repository.tryStartProvisioning(
      shardPlan.operationId,
      'create-owner',
      100
    );
    if (!createLease) throw new Error('expected_create_lease');
    await repository.markDatabaseCreated(createLease, shardPlan, 'database-id', 'disabled', 110);
    const [migrationPlan] = await repository.listPendingMigrationPlans(10);
    if (!migrationPlan) throw new Error('expected_migration_plan');
    const migrationLease = await repository.tryStartMigration(
      shardPlan.operationId,
      'migration-owner',
      120
    );
    if (!migrationLease) throw new Error('expected_migration_lease');
    await repository.markMigrationReady(
      migrationLease,
      migrationPlan,
      {
        totalFiles: 1,
        appliedFiles: 1,
        skippedFiles: 0,
        responseLossRecoveries: 0,
        lastFilename: '001_schema.sql',
      },
      130
    );

    const bindingRepository = new D1WorkerBindingRepository(d1Adapter(database));
    await bindingRepository.ensurePendingTargets(131);

    expect(
      database
        .prepare('SELECT status, last_error_code FROM control_operations WHERE operation_id = ?')
        .get(shardPlan.operationId)
    ).toEqual({
      status: 'blocked',
      last_error_code: 'control_worker_binding_targets_missing',
    });
    expect(
      database
        .prepare('SELECT status FROM control_tenant_shards WHERE shard_id = ?')
        .get(shardPlan.shardId)
    ).toEqual({ status: 'failed' });
    expect(
      database
        .prepare(
          `SELECT event_type, outcome FROM control_audit_events
            WHERE operation_id = ? AND event_type = 'control.worker_binding.targets_missing'`
        )
        .get(shardPlan.operationId)
    ).toEqual({ event_type: 'control.worker_binding.targets_missing', outcome: 'blocked' });
  });

  it('repairs blocked aggregate binding steps through valid status transitions', async () => {
    const shardPlan = plan('aggregate-repair');
    await repository.createShardPlan(shardPlan, 100, 'scheduler');
    const createLease = await repository.tryStartProvisioning(
      shardPlan.operationId,
      'create-owner',
      100
    );
    if (!createLease) throw new Error('expected_create_lease');
    await repository.markDatabaseCreated(createLease, shardPlan, 'database-id', 'disabled', 110);
    const [migrationPlan] = await repository.listPendingMigrationPlans(10);
    if (!migrationPlan) throw new Error('expected_migration_plan');
    const migrationLease = await repository.tryStartMigration(
      shardPlan.operationId,
      'migration-owner',
      120
    );
    if (!migrationLease) throw new Error('expected_migration_lease');
    await repository.markMigrationReady(
      migrationLease,
      migrationPlan,
      {
        totalFiles: 1,
        appliedFiles: 1,
        skippedFiles: 0,
        responseLossRecoveries: 0,
        lastFilename: '001_schema.sql',
      },
      130
    );

    database.exec(`INSERT INTO control_desired_worker_inventory (
      environment_id, worker_script_name, package_name, deployment_target,
      capability_manifest_digest, source_manifest_path, source_manifest_hash,
      generated_artifact_hash, source_kind, source_reference, status,
      registered_by_operation_id, registered_by, registered_at
    ) VALUES (
      'env-test', 'test-ar-auth', '@authrim/ar-auth', 'test-ar-auth',
      '${'c'.repeat(64)}', 'packages/ar-auth/authrim.worker-capabilities.json',
      '${'d'.repeat(64)}', '${'e'.repeat(64)}', 'core_manifest', 'test-fixture', 'active',
      'op-release', 'setup:test', 131
    );
    INSERT INTO control_worker_required_data_roles (
      environment_id, worker_script_name, data_role, source_manifest_hash, updated_at
    ) VALUES ('env-test', 'test-ar-auth', 'tenant_core/users', '${'d'.repeat(64)}', 131);`);

    const bindingRepository = new D1WorkerBindingRepository(d1Adapter(database));
    await expect(
      bindingRepository.acquireReconcilerLease({
        environmentId: 'env-test',
        ownerId: 'run-1',
        now: 100,
        ttlSeconds: 300,
      })
    ).resolves.toBe(true);
    await expect(
      bindingRepository.acquireReconcilerLease({
        environmentId: 'env-test',
        ownerId: 'run-2',
        now: 101,
        ttlSeconds: 300,
      })
    ).resolves.toBe(false);
    await expect(
      bindingRepository.releaseReconcilerLease({
        environmentId: 'env-test',
        ownerId: 'run-2',
      })
    ).resolves.toBe(false);
    await expect(
      bindingRepository.acquireReconcilerLease({
        environmentId: 'env-test',
        ownerId: 'run-2',
        now: 400,
        ttlSeconds: 300,
      })
    ).resolves.toBe(true);
    await expect(
      bindingRepository.releaseReconcilerLease({
        environmentId: 'env-test',
        ownerId: 'run-2',
      })
    ).resolves.toBe(true);
    await bindingRepository.ensurePendingTargets(132);
    database
      .prepare(
        `UPDATE control_worker_binding_reconciliations
            SET state = 'succeeded', expected_source_version_id = 'version-before',
                previous_restore_settings_json = '{"bindings":[]}',
                patch_result_version_id = 'version-after',
                patch_result_deployment_id = 'deployment-after',
                completed_at = 133, updated_at = 133
          WHERE operation_id = ?`
      )
      .run(shardPlan.operationId);
    database
      .prepare(
        `INSERT INTO control_worker_deployment_leases (
           environment_id, worker_script_name, owner_operation_id, fencing_token,
           lease_expires_at, expected_source_version_id, mutation_started,
           previous_deployment_id, patch_result_version_id, patch_result_deployment_id, updated_at
         ) VALUES (
           'env-test', 'test-ar-auth', ?, 1, 433, 'version-before', 1,
           'deployment-before', 'version-after', 'deployment-after', 133
         )`
      )
      .run(shardPlan.operationId);
    database
      .prepare(
        `UPDATE control_operation_steps
            SET status = 'blocked', last_error_code = 'operator_action_required',
                last_error_redacted = 'Operator execution is required.', updated_at = 133
          WHERE operation_id = ?
            AND step_key IN (
              'reconcile_worker_bindings', 'smoke_bindings', 'stabilize_bindings'
            )`
      )
      .run(shardPlan.operationId);

    await bindingRepository.ensurePendingTargets(134);

    expect(
      database
        .prepare(
          `SELECT step_key, status, progress_current, progress_total, last_error_code
             FROM control_operation_steps
            WHERE operation_id = ? AND display_order >= 30
            ORDER BY display_order`
        )
        .all(shardPlan.operationId)
    ).toEqual([
      {
        step_key: 'reconcile_worker_bindings',
        status: 'succeeded',
        progress_current: 1,
        progress_total: 1,
        last_error_code: null,
      },
      {
        step_key: 'smoke_bindings',
        status: 'succeeded',
        progress_current: 1,
        progress_total: 1,
        last_error_code: null,
      },
      {
        step_key: 'stabilize_bindings',
        status: 'succeeded',
        progress_current: 1,
        progress_total: 1,
        last_error_code: null,
      },
    ]);
    expect(
      database
        .prepare('SELECT status, last_error_code FROM control_operations WHERE operation_id = ?')
        .get(shardPlan.operationId)
    ).toEqual({ status: 'succeeded', last_error_code: null });
    expect(
      database
        .prepare('SELECT status FROM control_tenant_shards WHERE shard_id = ?')
        .get(shardPlan.shardId)
    ).toEqual({ status: 'active' });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM control_worker_deployment_leases
            WHERE owner_operation_id = ?`
        )
        .get(shardPlan.operationId)
    ).toEqual({ count: 0 });
  });

  it('reclaims a non-mutating Worker lease left by a completed operation', async () => {
    database
      .prepare(
        `INSERT INTO control_worker_deployment_leases (
           environment_id, worker_script_name, owner_operation_id, fencing_token,
           lease_expires_at, expected_source_version_id, mutation_started, updated_at
         ) VALUES ('env-test', 'test-ar-bridge', 'op-release', 1, 1000,
                   'version-before', 0, 101)`
      )
      .run();

    const bindingRepository = new D1WorkerBindingRepository(d1Adapter(database));
    await bindingRepository.ensurePendingTargets(102);

    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM control_worker_deployment_leases
            WHERE owner_operation_id = 'op-release'`
        )
        .get()
    ).toEqual({ count: 0 });
  });

  it('resumes migration and retains an adopted-binding lease through smoke', async () => {
    const shardPlan = plan('migration');
    await repository.createShardPlan(shardPlan, 100, 'scheduler');
    const createLease = await repository.tryStartProvisioning(
      shardPlan.operationId,
      'create-owner',
      100
    );
    if (!createLease) throw new Error('expected_create_lease');
    await repository.markDatabaseCreated(createLease, shardPlan, 'database-id', 'disabled', 110);

    database.exec(`UPDATE control_migration_release_catalog
      SET state = 'retired', active_stream_key = 'release:' || release_id
      WHERE environment_id = 'env-test' AND stream_id = 'd1-core' AND state = 'active';
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, attempt_count, created_at, completed_at, updated_at
      ) VALUES (
        'op-release-next', 'env-test', 'register_migration_release', 'release:0.5.0',
        'succeeded', 'setup', 1, 111, 111, 111
      );
      INSERT INTO control_migration_release_catalog (
        environment_id, stream_id, release_id, manifest_digest, manifest_r2_object_key,
        state, active_stream_key, registered_by_operation_id, registered_by_actor_id,
        registered_at, activated_at
      ) VALUES (
        'env-test', 'd1-core', '0.5.0', '${'b'.repeat(64)}',
        'releases/0.5.0/${'b'.repeat(64)}/manifest.json', 'active', 'active', 'op-release-next',
        'setup:test', 111, 111
      );`);

    const [migrationPlan] = await repository.listPendingMigrationPlans(10);
    expect(migrationPlan).toEqual({
      operationId: shardPlan.operationId,
      desiredResourceId: shardPlan.desiredResourceId,
      shardId: shardPlan.shardId,
      environmentId: 'env-test',
      databaseId: 'database-id',
      streamId: 'd1-core',
      releaseId: '0.4.0',
      manifestDigest: 'a'.repeat(64),
      manifestObjectKey: `releases/0.4.0/${'a'.repeat(64)}/manifest.json`,
      bindingRef: shardPlan.bindingRef,
      dataRole: shardPlan.dataRole,
      residencyPartition: shardPlan.residencyPartition,
      migrationGeneration: 1,
    });
    if (!migrationPlan) throw new Error('expected_migration_plan');
    const migrationLease = await repository.tryStartMigration(
      shardPlan.operationId,
      'migration-owner',
      120
    );
    if (!migrationLease) throw new Error('expected_migration_lease');
    const completed = await repository.markMigrationReady(
      migrationLease,
      migrationPlan,
      {
        totalFiles: 2,
        appliedFiles: 2,
        skippedFiles: 0,
        responseLossRecoveries: 0,
        lastFilename: '002_index.sql',
      },
      130
    );
    expect(completed.status).toBe('waiting_retry');
    expect(
      database
        .prepare(
          `SELECT state, expected_file_count, applied_file_count, last_filename
             FROM control_tenant_database_migration_state WHERE desired_resource_id = ?`
        )
        .get(shardPlan.desiredResourceId)
    ).toEqual({
      state: 'ready',
      expected_file_count: 2,
      applied_file_count: 2,
      last_filename: '002_index.sql',
    });
    expect(
      database
        .prepare('SELECT status FROM control_tenant_shards WHERE shard_id = ?')
        .get(shardPlan.shardId)
    ).toEqual({ status: 'ready' });
    expect(
      database
        .prepare(
          `SELECT status, progress_current, progress_total
             FROM control_operation_steps
            WHERE operation_id = ? AND step_key = 'apply_migrations'`
        )
        .get(shardPlan.operationId)
    ).toEqual({ status: 'succeeded', progress_current: 2, progress_total: 2 });
    expect(
      database
        .prepare(
          `SELECT step_key, status
             FROM control_operation_steps
            WHERE operation_id = ? AND display_order >= 30
            ORDER BY display_order`
        )
        .all(shardPlan.operationId)
    ).toEqual([
      { step_key: 'reconcile_worker_bindings', status: 'queued' },
      { step_key: 'smoke_bindings', status: 'queued' },
      { step_key: 'stabilize_bindings', status: 'queued' },
    ]);

    database.exec(`INSERT INTO control_desired_worker_inventory (
      environment_id, worker_script_name, package_name, deployment_target,
      capability_manifest_digest, source_manifest_path, source_manifest_hash,
      generated_artifact_hash, source_kind, source_reference, status,
      registered_by_operation_id, registered_by, registered_at
    ) VALUES (
      'env-test', 'test-ar-auth', '@authrim/ar-auth', 'test-ar-auth',
      '${'c'.repeat(64)}', 'packages/ar-auth/authrim.worker-capabilities.json',
      '${'d'.repeat(64)}', '${'e'.repeat(64)}', 'core_manifest', 'test-fixture', 'active',
      'op-release', 'setup:test', 131
    );
    INSERT INTO control_worker_required_data_roles (
      environment_id, worker_script_name, data_role, source_manifest_hash, updated_at
    ) VALUES ('env-test', 'test-ar-auth', 'tenant_core/users', '${'d'.repeat(64)}', 131);`);

    database
      .prepare(
        `UPDATE control_operations
            SET status = 'blocked', last_error_code = 'operator_action_required'
          WHERE operation_id = ?`
      )
      .run(shardPlan.operationId);
    database
      .prepare(
        `UPDATE control_operation_steps
            SET status = 'blocked', last_error_code = 'operator_action_required'
          WHERE operation_id = ? AND step_key = 'reconcile_worker_bindings'`
      )
      .run(shardPlan.operationId);

    const bindingRepository = new D1WorkerBindingRepository(d1Adapter(database));
    await bindingRepository.ensurePendingTargets(132);
    await expect(bindingRepository.listDueTargets(10, 132)).resolves.toEqual([]);

    database
      .prepare(
        `UPDATE control_operations
            SET status = 'running', last_error_code = NULL
          WHERE operation_id = ?`
      )
      .run(shardPlan.operationId);
    database
      .prepare(
        `UPDATE control_operation_steps
            SET status = 'running', last_error_code = NULL
          WHERE operation_id = ? AND step_key = 'reconcile_worker_bindings'`
      )
      .run(shardPlan.operationId);

    const [target] = await bindingRepository.listDueTargets(10, 132);
    expect(target).toMatchObject({
      operationId: shardPlan.operationId,
      environmentName: 'test',
      workerScriptName: 'test-ar-auth',
      bindingRef: shardPlan.bindingRef,
      databaseId: 'database-id',
      state: 'pending',
    });
    if (!target) throw new Error('expected_worker_binding_target');

    const firstLease = await bindingRepository.acquireDeploymentLease({
      target,
      expectedSourceVersionId: 'version-before',
      now: 133,
    });
    const currentLease = await bindingRepository.acquireDeploymentLease({
      target,
      expectedSourceVersionId: 'version-before',
      now: 134,
    });
    if (!firstLease || !currentLease) throw new Error('expected_worker_binding_lease');
    expect(currentLease.fencingToken).toBe(firstLease.fencingToken + 1);
    await expect(bindingRepository.leaseIsCurrent(firstLease, 134)).resolves.toBe(false);
    await expect(bindingRepository.leaseIsCurrent(currentLease, 134)).resolves.toBe(true);

    await bindingRepository.recordPatchStarted({
      target,
      lease: currentLease,
      previousDeploymentId: 'deployment-before',
      restoreSettingsJson: JSON.stringify({ bindings: [] }),
      now: 135,
    });
    expect(
      database
        .prepare(
          `SELECT mutation_started, mutation_started_at
             FROM control_worker_deployment_leases
            WHERE owner_operation_id = ? AND worker_script_name = ?`
        )
        .get(target.operationId, target.workerScriptName)
    ).toEqual({ mutation_started: 1, mutation_started_at: 135 });
    await expect(
      bindingRepository.rearmPatchIntent({ target, lease: firstLease, now: 136 })
    ).resolves.toBe(false);
    await expect(
      bindingRepository.rearmPatchIntent({ target, lease: currentLease, now: 136 })
    ).resolves.toBe(true);
    await expect(
      bindingRepository.rearmPatchIntent({ target, lease: currentLease, now: 136 })
    ).resolves.toBe(false);
    expect(
      database
        .prepare(
          `SELECT mutation_started, mutation_started_at, previous_deployment_id
             FROM control_worker_deployment_leases
            WHERE owner_operation_id = ? AND worker_script_name = ?`
        )
        .get(target.operationId, target.workerScriptName)
    ).toEqual({
      mutation_started: 0,
      mutation_started_at: null,
      previous_deployment_id: null,
    });

    await bindingRepository.recordAlreadySatisfied({
      target,
      lease: currentLease,
      versionId: 'version-after',
      deploymentId: 'deployment-after',
      settingsJson: JSON.stringify({
        bindings: [{ name: 'DB', type: 'inherit', version_id: 'version-before' }],
      }),
      now: 136,
    });
    expect(
      database
        .prepare(
          `SELECT mutation_started, patch_result_version_id
             FROM control_worker_deployment_leases
            WHERE owner_operation_id = ? AND worker_script_name = ?`
        )
        .get(target.operationId, target.workerScriptName)
    ).toEqual({ mutation_started: 0, patch_result_version_id: 'version-after' });
    database
      .prepare(
        `UPDATE control_worker_deployment_leases
            SET mutation_started = 1, patch_result_version_id = NULL,
                patch_result_deployment_id = NULL
          WHERE owner_operation_id = ? AND worker_script_name = ?`
      )
      .run(target.operationId, target.workerScriptName);
    const recoveredLease = await bindingRepository.acquireDeploymentLease({
      target,
      expectedSourceVersionId: 'version-before',
      now: 135,
    });
    expect(recoveredLease).toMatchObject({
      patchResultVersionId: 'version-after',
      patchResultDeploymentId: 'deployment-after',
    });
    database
      .prepare(
        `UPDATE control_worker_deployment_leases
            SET mutation_started = 0, patch_result_version_id = NULL,
                patch_result_deployment_id = NULL
          WHERE owner_operation_id = ? AND worker_script_name = ?`
      )
      .run(target.operationId, target.workerScriptName);
    const recoveredAlreadySatisfiedLease = await bindingRepository.acquireDeploymentLease({
      target,
      expectedSourceVersionId: 'version-before',
      now: 136,
    });
    expect(recoveredAlreadySatisfiedLease).toMatchObject({
      patchResultVersionId: 'version-after',
      patchResultDeploymentId: 'deployment-after',
    });
    const smokeTarget = {
      ...target,
      state: 'settings_patched' as const,
      patchResultVersionId: 'version-after',
      patchResultDeploymentId: 'deployment-after',
    };
    await bindingRepository.adoptSupersedingSmokeDeployment({
      target: smokeTarget,
      lease: required(recoveredAlreadySatisfiedLease),
      versionId: 'version-superseding',
      deploymentId: 'deployment-superseding',
      now: 136,
    });
    expect(
      database
        .prepare(
          `SELECT state, patch_result_version_id, patch_result_deployment_id, last_error_code
             FROM control_worker_binding_reconciliations
            WHERE operation_id = ? AND worker_script_name = ? AND binding_ref = ?`
        )
        .get(target.operationId, target.workerScriptName, target.bindingRef)
    ).toEqual({
      state: 'settings_patched',
      patch_result_version_id: 'version-superseding',
      patch_result_deployment_id: 'deployment-superseding',
      last_error_code: 'control_worker_version_superseded',
    });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM control_worker_deployment_leases
            WHERE owner_operation_id = ? AND worker_script_name = ?`
        )
        .get(target.operationId, target.workerScriptName)
    ).toEqual({ count: 0 });
    const adoptedTarget = {
      ...smokeTarget,
      patchResultVersionId: 'version-superseding',
      patchResultDeploymentId: 'deployment-superseding',
    };
    await bindingRepository.acquireDeploymentLease({
      target: adoptedTarget,
      expectedSourceVersionId: 'version-before',
      now: 136,
    });
    for (const attempt of [1, 2, 3]) {
      await bindingRepository.recordSmokeProgress({
        target: adoptedTarget,
        successful: true,
        attempt,
        ...(attempt === 3 ? { stabilizationNotBefore: 170 } : {}),
        now: 136 + attempt,
      });
    }
    expect(
      database
        .prepare(
          `SELECT lease_expires_at FROM control_worker_deployment_leases
            WHERE owner_operation_id = ? AND worker_script_name = ?`
        )
        .get(target.operationId, target.workerScriptName)
    ).toEqual({ lease_expires_at: 1039 });
    await expect(bindingRepository.listDueTargets(10, 169)).resolves.toEqual([]);
    database
      .prepare(
        `INSERT INTO control_operations (
           operation_id, environment_id, operation_kind, idempotency_key, status,
           requested_by_type, created_at, updated_at
         ) VALUES ('op-000-pending-binding', 'env-test', 'provision_shard',
                   'pending-binding-priority', 'running', 'admin', 169, 169)`
      )
      .run();
    database
      .prepare(
        `INSERT INTO control_worker_binding_reconciliations (
           operation_id, environment_id, worker_script_name, shard_id, binding_ref,
           data_role, residency_partition, migration_generation, provider_database_id,
           state, created_at, updated_at
         ) VALUES ('op-000-pending-binding', 'env-test', 'test-ar-auth', ?,
                   ?, 'tenant_core/users', 'jp', 1,
                   'provider-database-id', 'pending', 169, 169)`
      )
      .run(target.shardId, target.bindingRef);
    const [stabilizingTarget] = await bindingRepository.listDueTargets(1, 170);
    expect(stabilizingTarget).toMatchObject({
      operationId: target.operationId,
      state: 'stabilizing',
      patchResultVersionId: 'version-superseding',
      patchResultDeploymentId: 'deployment-superseding',
    });
    if (!stabilizingTarget) throw new Error('expected_stabilizing_worker_binding_target');
    const siblingPlan = plan('sibling');
    await repository.createShardPlan(siblingPlan, 169, 'scheduler');
    database
      .prepare(
        `INSERT INTO control_worker_binding_reconciliations (
           operation_id, environment_id, worker_script_name, shard_id, binding_ref,
           data_role, residency_partition, migration_generation, provider_database_id,
           state, expected_source_version_id, previous_deployment_id,
           patch_result_version_id, patch_result_deployment_id, previous_restore_settings_json,
           smoke_attempt_count, consecutive_smoke_successes, stabilization_not_before,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'tenant_core/users', 'jp', 1, 'provider-database-id',
                   'stabilizing', 'version-superseding', 'deployment-superseding',
                   'version-superseding', 'deployment-superseding', '{}', 3, 3, 170, 169, 169)`
      )
      .run(
        target.operationId,
        target.environmentId,
        target.workerScriptName,
        siblingPlan.shardId,
        siblingPlan.bindingRef
      );
    database
      .prepare(
        `UPDATE control_operation_steps
            SET progress_total = 2
          WHERE operation_id = ?
            AND step_key IN ('reconcile_worker_bindings', 'smoke_bindings', 'stabilize_bindings')`
      )
      .run(target.operationId);
    await bindingRepository.markSucceeded(stabilizingTarget, 170);
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM control_worker_deployment_leases
            WHERE owner_operation_id = ?`
        )
        .get(target.operationId)
    ).toEqual({ count: 1 });
    const siblingTarget = (await bindingRepository.listDueTargets(10, 171)).find(
      (entry) =>
        entry.operationId === target.operationId && entry.bindingRef === siblingPlan.bindingRef
    );
    if (!siblingTarget) throw new Error('expected_sibling_stabilizing_worker_binding_target');
    const siblingLease = await bindingRepository.acquireDeploymentLease({
      target: siblingTarget,
      expectedSourceVersionId: 'version-superseding',
      now: 171,
    });
    expect(siblingLease).toMatchObject({
      patchResultVersionId: 'version-superseding',
      patchResultDeploymentId: 'deployment-superseding',
    });
    await bindingRepository.recordSmokeProgress({
      target: siblingTarget,
      successful: true,
      attempt: 4,
      completeStabilizationCheck: true,
      now: 171,
    });
    await bindingRepository.markSucceeded(siblingTarget, 171);
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM control_worker_deployment_leases
            WHERE owner_operation_id = ?`
        )
        .get(target.operationId)
    ).toEqual({ count: 0 });
    database
      .prepare(
        `DELETE FROM control_worker_binding_reconciliations
          WHERE operation_id = ? AND worker_script_name = ? AND binding_ref = ?`
      )
      .run(target.operationId, target.workerScriptName, siblingPlan.bindingRef);
    database
      .prepare(
        `INSERT INTO control_operation_steps (
           operation_id, step_key, status, display_order, started_at, updated_at
         ) VALUES (?, 'test_incomplete_gate', 'running', 99, 170, 170)`
      )
      .run(target.operationId);
    await expect(bindingRepository.completeOperationIfReady(target.operationId, 170)).resolves.toBe(
      false
    );
    database
      .prepare(
        `UPDATE control_operation_steps
            SET status = 'succeeded', completed_at = 170, updated_at = 170
          WHERE operation_id = ? AND step_key = 'test_incomplete_gate'`
      )
      .run(target.operationId);
    expect(
      database
        .prepare(
          `SELECT step_key, status FROM control_operation_steps
            WHERE operation_id = ? AND status NOT IN ('succeeded', 'skipped')`
        )
        .all(target.operationId)
    ).toEqual([]);
    expect(
      database
        .prepare(`SELECT status FROM control_operations WHERE operation_id = ?`)
        .get(target.operationId)
    ).toEqual({ status: 'running' });
    database
      .prepare(
        `UPDATE control_tenant_shards SET status = 'failed', updated_at = 170
          WHERE shard_id = ? AND status = 'ready'`
      )
      .run(target.shardId);
    await expect(bindingRepository.completeOperationIfReady(target.operationId, 170)).resolves.toBe(
      false
    );
    expect(
      database
        .prepare(`SELECT status FROM control_operations WHERE operation_id = ?`)
        .get(target.operationId)
    ).toEqual({ status: 'running' });
    expect(
      database
        .prepare(`SELECT COUNT(*) AS count FROM control_shard_capacity WHERE shard_id = ?`)
        .get(target.shardId)
    ).toEqual({ count: 0 });
    database
      .prepare(
        `UPDATE control_tenant_shards SET status = 'ready', updated_at = 170
          WHERE shard_id = ? AND status = 'failed'`
      )
      .run(target.shardId);
    await repository.registerTenantPlacementPolicy(
      {
        environmentId: target.environmentId,
        tenantId: 'tenant-test',
        isolationPolicy: 'shared_pool',
        sourceOperationId: 'tenant-create-test',
        idempotencyKey: 'tenant-placement-test',
      },
      170
    );
    await repository.registerTenantPlacementPolicy(
      {
        environmentId: target.environmentId,
        tenantId: 'tenant-shared-second',
        isolationPolicy: 'shared_pool',
        sourceOperationId: 'tenant-create-shared-second',
        idempotencyKey: 'tenant-placement-shared-second',
      },
      170
    );
    await repository.registerTenantPlacementPolicy(
      {
        environmentId: target.environmentId,
        tenantId: 'tenant-exclusive-other',
        isolationPolicy: 'tenant_exclusive',
        sourceOperationId: 'tenant-create-exclusive-other',
        idempotencyKey: 'tenant-placement-exclusive-other',
      },
      170
    );
    database
      .prepare(
        `UPDATE control_tenant_placement_policies
            SET policy_state = 'active', activated_at = 170, updated_at = 170
          WHERE environment_id = ?
            AND tenant_id IN ('tenant-test', 'tenant-shared-second', 'tenant-exclusive-other')`
      )
      .run(target.environmentId);
    await expect(bindingRepository.completeOperationIfReady(target.operationId, 170)).resolves.toBe(
      true
    );
    expect(
      database
        .prepare('SELECT status FROM control_operations WHERE operation_id = ?')
        .get(target.operationId)
    ).toEqual({ status: 'succeeded' });
    expect(
      database
        .prepare('SELECT status FROM control_tenant_shards WHERE shard_id = ?')
        .get(target.shardId)
    ).toEqual({ status: 'active' });
    expect(
      database
        .prepare(
          `SELECT target_account_count, allocated_account_count, health_status, allocation_status
             FROM control_shard_capacity WHERE shard_id = ?`
        )
        .get(target.shardId)
    ).toEqual({
      target_account_count: 100000,
      allocated_account_count: 0,
      health_status: 'healthy',
      allocation_status: 'eligible',
    });
    expect(
      database
        .prepare(
          `SELECT tenant_id, assignment_generation, source_operation_id
             FROM control_tenant_shard_assignments
            WHERE environment_id = ? AND shard_id = ?
            ORDER BY tenant_id`
        )
        .all(target.environmentId, target.shardId)
    ).toEqual([
      {
        tenant_id: 'tenant-shared-second',
        assignment_generation: 1,
        source_operation_id: target.operationId,
      },
      {
        tenant_id: 'tenant-test',
        assignment_generation: 1,
        source_operation_id: target.operationId,
      },
    ]);
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count
             FROM control_tenant_shard_assignments
            WHERE environment_id = ? AND tenant_id = 'tenant-exclusive-other'`
        )
        .get(target.environmentId)
    ).toEqual({ count: 0 });
    if (target.dataRole === 'lookup') {
      throw new Error('expected_tenant_shard_plan');
    }
    await repository.assignTenantShard(
      {
        environmentId: target.environmentId,
        tenantId: 'tenant-test',
        dataRole: target.dataRole,
        residencyPolicyId: shardPlan.residencyPolicyId,
        residencyPartition: target.residencyPartition,
        shardId: target.shardId,
        sourceOperationId: target.operationId,
      },
      170
    );
    await expect(
      repository.findAssignableTenantShard({
        environmentId: target.environmentId,
        tenantId: 'tenant-test',
        dataRole: target.dataRole,
        residencyPolicyId: shardPlan.residencyPolicyId,
        residencyPartition: target.residencyPartition,
        allocationScope: 'shared_pool',
        ownerTenantId: null,
      })
    ).resolves.toBeNull();
    await expect(
      repository.findEligibleTenantShard({
        environmentId: target.environmentId,
        tenantId: 'tenant-test',
        dataRole: target.dataRole,
        residencyPolicyId: shardPlan.residencyPolicyId,
        residencyPartition: target.residencyPartition,
        allocationScope: 'shared_pool',
        ownerTenantId: null,
      })
    ).resolves.toEqual({
      shardId: target.shardId,
      dataRole: target.dataRole,
      residencyPolicyId: shardPlan.residencyPolicyId,
      residencyPartition: target.residencyPartition,
      routeGeneration: 1,
      bindingRef: target.bindingRef,
      databaseId: 'database-id',
      databaseName: shardPlan.databaseName,
      allocationScope: 'shared_pool',
      ownerTenantId: null,
      assignmentGeneration: 1,
    });
    await expect(
      repository.listActiveTenantShardTargets({
        environmentId: target.environmentId,
        tenantId: 'tenant-test',
        residencyPolicyId: shardPlan.residencyPolicyId,
        residencyPartition: target.residencyPartition,
      })
    ).resolves.toEqual([
      {
        shardId: target.shardId,
        dataRole: target.dataRole,
        residencyPolicyId: shardPlan.residencyPolicyId,
        residencyPartition: target.residencyPartition,
        routeGeneration: 1,
        bindingRef: target.bindingRef,
        databaseId: 'database-id',
        databaseName: shardPlan.databaseName,
        allocationScope: 'shared_pool',
        ownerTenantId: null,
        assignmentGeneration: 1,
      },
    ]);
    expect(
      database
        .prepare(
          `SELECT provider_resource_id, observed_version_id, observed_deployment_id
             FROM control_worker_observed_bindings
            WHERE environment_id = ? AND worker_script_name = ? AND binding_name = ?`
        )
        .get(target.environmentId, target.workerScriptName, target.bindingRef)
    ).toEqual({
      provider_resource_id: 'database-id',
      observed_version_id: 'version-superseding',
      observed_deployment_id: 'deployment-superseding',
    });
  });

  it('assigns an activated exclusive shard only to its owning tenant', async () => {
    for (const [tenantId, isolationPolicy] of [
      ['tenant-exclusive-owner', 'tenant_exclusive'],
      ['tenant-exclusive-other', 'tenant_exclusive'],
      ['tenant-shared-other', 'shared_pool'],
    ] as const) {
      await repository.registerTenantPlacementPolicy(
        {
          environmentId: 'env-test',
          tenantId,
          isolationPolicy,
          sourceOperationId: `tenant-create-${tenantId}`,
          idempotencyKey: `tenant-placement-${tenantId}`,
        },
        100
      );
    }
    database.exec(`
      UPDATE control_tenant_placement_policies
         SET policy_state = 'active', activated_at = 100, updated_at = 100
       WHERE environment_id = 'env-test';
    `);

    const shardPlan = {
      ...plan('exclusive-activation'),
      allocationScope: 'tenant_exclusive' as const,
      ownerTenantId: 'tenant-exclusive-owner',
    };
    await repository.createShardPlan(shardPlan, 101, 'scheduler');
    const createLease = await repository.tryStartProvisioning(
      shardPlan.operationId,
      'create-owner',
      101
    );
    if (!createLease) throw new Error('expected_create_lease');
    await repository.markDatabaseCreated(
      createLease,
      shardPlan,
      'exclusive-database-id',
      'disabled',
      102
    );
    const [migrationPlan] = await repository.listPendingMigrationPlans(10);
    if (!migrationPlan) throw new Error('expected_migration_plan');
    const migrationLease = await repository.tryStartMigration(
      shardPlan.operationId,
      'migration-owner',
      103
    );
    if (!migrationLease) throw new Error('expected_migration_lease');
    await repository.markMigrationReady(
      migrationLease,
      migrationPlan,
      {
        totalFiles: 1,
        appliedFiles: 1,
        skippedFiles: 0,
        responseLossRecoveries: 0,
        lastFilename: '001_schema.sql',
      },
      104
    );
    database.exec(`
      INSERT INTO control_desired_worker_inventory (
        environment_id, worker_script_name, package_name, deployment_target,
        capability_manifest_digest, source_manifest_path, source_manifest_hash,
        generated_artifact_hash, source_kind, source_reference, status,
        registered_by_operation_id, registered_by, registered_at
      ) VALUES (
        'env-test', 'test-exclusive-auth', '@authrim/ar-auth', 'test-exclusive-auth',
        '${'1'.repeat(64)}', 'packages/ar-auth/authrim.worker-capabilities.json',
        '${'2'.repeat(64)}', '${'3'.repeat(64)}', 'core_manifest', 'test-fixture', 'active',
        'op-release', 'setup:test', 105
      );
      INSERT INTO control_worker_required_data_roles (
        environment_id, worker_script_name, data_role, source_manifest_hash, updated_at
      ) VALUES (
        'env-test', 'test-exclusive-auth', 'tenant_core/users', '${'2'.repeat(64)}', 105
      );
    `);
    const bindingRepository = new D1WorkerBindingRepository(d1Adapter(database));
    await bindingRepository.ensurePendingTargets(105);
    database
      .prepare(
        `UPDATE control_worker_binding_reconciliations
            SET state = 'succeeded', expected_source_version_id = 'version-before',
                previous_restore_settings_json = '{}', completed_at = 106, updated_at = 106
          WHERE operation_id = ?`
      )
      .run(shardPlan.operationId);
    database
      .prepare(
        `UPDATE control_operation_steps
            SET status = 'running', started_at = COALESCE(started_at, 105), updated_at = 105
          WHERE operation_id = ? AND status = 'queued'`
      )
      .run(shardPlan.operationId);
    database
      .prepare(
        `UPDATE control_operation_steps
            SET status = 'succeeded', completed_at = 106, updated_at = 106
          WHERE operation_id = ? AND status = 'running'`
      )
      .run(shardPlan.operationId);
    database
      .prepare(
        `UPDATE control_operations
            SET status = 'running', next_attempt_at = NULL, updated_at = 106
          WHERE operation_id = ?`
      )
      .run(shardPlan.operationId);

    await expect(
      bindingRepository.completeOperationIfReady(shardPlan.operationId, 107)
    ).resolves.toBe(true);
    expect(
      database
        .prepare(
          `SELECT tenant_id, assignment_generation, source_operation_id
             FROM control_tenant_shard_assignments
            WHERE environment_id = 'env-test' AND shard_id = ?`
        )
        .all(shardPlan.shardId)
    ).toEqual([
      {
        tenant_id: 'tenant-exclusive-owner',
        assignment_generation: 1,
        source_operation_id: shardPlan.operationId,
      },
    ]);
  });

  it('fences stale owners and records redacted retry audit evidence', async () => {
    const shardPlan = plan('one');
    await repository.createShardPlan(shardPlan, 100, 'admin');
    const firstLease = await repository.tryStartProvisioning(shardPlan.operationId, 'owner-a', 100);
    if (!firstLease) throw new Error('expected_first_lease');
    expect(await repository.tryStartProvisioning(shardPlan.operationId, 'owner-b', 101)).toBeNull();

    const takeover = await repository.tryStartProvisioning(shardPlan.operationId, 'owner-b', 401);
    if (!takeover) throw new Error('expected_takeover_lease');
    expect(takeover.fencingToken).toBe(2);
    await repository.markOperationBlocked(firstLease, 'stale_owner_must_not_win', 402);
    expect((await repository.getOperation(shardPlan.operationId))?.status).toBe('running');

    await repository.markOperationRetry(takeover, 'cloudflare_d1_request_failed', 500, 402);
    const state = await repository.getOperation(shardPlan.operationId);
    expect(state?.status).toBe('waiting_retry');
    expect(state?.lastErrorCode).toBe('cloudflare_d1_request_failed');
    const audit = database
      .prepare(
        `SELECT outcome, redacted_payload_json FROM control_audit_events
          WHERE event_id = 'audit:op-one:2:retry'`
      )
      .get() as { outcome: string; redacted_payload_json: string };
    expect(audit.outcome).toBe('failed');
    expect(audit.redacted_payload_json).not.toContain('stale_owner_must_not_win');
  });

  it('fences migration retries and records only redacted failure evidence', async () => {
    const shardPlan = plan('migration-retry');
    await repository.createShardPlan(shardPlan, 100, 'scheduler');
    const createLease = await repository.tryStartProvisioning(
      shardPlan.operationId,
      'create-owner',
      100
    );
    if (!createLease) throw new Error('expected_create_lease');
    await repository.markDatabaseCreated(createLease, shardPlan, 'database-id', 'disabled', 110);
    const first = await repository.tryStartMigration(shardPlan.operationId, 'migration-a', 120);
    if (!first) throw new Error('expected_migration_lease');
    await repository.markMigrationRetry(first, 'migration_d1_batch_failed', 200, 130);

    const retryAudit = database
      .prepare(
        `SELECT outcome, redacted_payload_json FROM control_audit_events
          WHERE event_id = ?`
      )
      .get(`audit:${shardPlan.operationId}:${first.fencingToken}:migration-retry`) as {
      outcome: string;
      redacted_payload_json: string;
    };
    expect(retryAudit.outcome).toBe('failed');
    expect(JSON.parse(retryAudit.redacted_payload_json)).toEqual({
      error_code: 'migration_d1_batch_failed',
      retry_at: 200,
    });

    const takeover = await repository.tryStartMigration(shardPlan.operationId, 'migration-b', 200);
    if (!takeover) throw new Error('expected_migration_takeover');
    await repository.markMigrationBlocked(first, 'stale_owner_must_not_win', 201);
    expect((await repository.getOperation(shardPlan.operationId))?.status).toBe('running');
    await repository.markMigrationBlocked(takeover, 'migration_release_manifest_missing', 202);
    expect((await repository.getOperation(shardPlan.operationId))?.status).toBe('blocked');
    const blockedAudit = database
      .prepare(
        `SELECT outcome, redacted_payload_json FROM control_audit_events
          WHERE event_id = ?`
      )
      .get(`audit:${shardPlan.operationId}:${takeover.fencingToken}:migration-blocked`) as {
      outcome: string;
      redacted_payload_json: string;
    };
    expect(blockedAudit.outcome).toBe('blocked');
    expect(blockedAudit.redacted_payload_json).not.toContain('stale_owner_must_not_win');
  });

  it('atomically limits daily D1 create reservations across operations', async () => {
    const firstPlan = plan('one');
    const secondPlan = plan('two');
    await repository.createShardPlan(firstPlan, 100, 'scheduler');
    await repository.createShardPlan(secondPlan, 100, 'scheduler');
    const firstLease = await repository.tryStartProvisioning(firstPlan.operationId, 'owner-a', 100);
    const secondLease = await repository.tryStartProvisioning(
      secondPlan.operationId,
      'owner-b',
      100
    );
    if (!firstLease || !secondLease) throw new Error('expected_budget_test_leases');

    expect(await repository.reserveD1CreateBudget(firstLease, 100)).toBe(true);
    expect(await repository.reserveD1CreateBudget(firstLease, 101)).toBe(true);
    expect(await repository.reserveD1CreateBudget(secondLease, 101)).toBe(false);
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM control_d1_create_budget_reservations').get()
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          `SELECT actor_type FROM control_audit_events
            WHERE event_id = 'audit:op-two:requested'`
        )
        .get()
    ).toEqual({ actor_type: 'scheduler' });
  });

  it('returns only active desired Workers in the requested environment', async () => {
    database.exec(
      `INSERT INTO control_operations (
         operation_id, environment_id, operation_kind, idempotency_key, status,
         requested_by_type, attempt_count, created_at, completed_at, updated_at
       ) VALUES (
         'op-inventory', 'env-test', 'register_worker_inventory', 'inventory:test', 'succeeded',
         'setup', 1, 1, 1, 1
       );
       INSERT INTO control_desired_worker_inventory (
         environment_id, worker_script_name, package_name, deployment_target,
         capability_manifest_digest, source_manifest_path, source_manifest_hash,
         generated_artifact_hash, source_kind, source_reference, registration_mode,
         status, review_state, registered_by_operation_id, registered_by, registered_at
       ) VALUES
         ('env-test', 'test-ar-auth', '@authrim/ar-auth', 'default',
          '${'a'.repeat(64)}', 'packages/ar-auth/authrim.worker-capabilities.json',
          '${'b'.repeat(64)}', '${'c'.repeat(64)}', 'core_manifest', 'manifest', 'auto',
          'active', 'auto_registered', 'op-inventory', 'setup:test', 1),
         ('env-test', 'test-ar-token', '@authrim/ar-token', 'default',
          '${'d'.repeat(64)}', 'packages/ar-token/authrim.worker-capabilities.json',
          '${'e'.repeat(64)}', '${'f'.repeat(64)}', 'core_manifest', 'manifest', 'auto',
          'disabled', 'auto_registered', 'op-inventory', 'setup:test', 1);`
    );

    expect(await repository.getActiveDesiredWorker('env-test', 'test-ar-auth')).toEqual(
      expect.objectContaining({
        environment_id: 'env-test',
        worker_script_name: 'test-ar-auth',
        status: 'active',
      })
    );
    expect(await repository.getActiveDesiredWorker('env-test', 'test-ar-token')).toBeNull();
    expect(await repository.getActiveDesiredWorker('other-env', 'test-ar-auth')).toBeNull();
  });

  it('records actual-only Worker drift idempotently and resolves disappeared findings', async () => {
    await repository.recordActualOnlyWorkerFindings('env-test', ['test-unmanaged'], 100);
    await repository.recordActualOnlyWorkerFindings('env-test', ['test-unmanaged'], 110);

    expect(await repository.listPendingWorkerInventoryDriftFindings('env-test', 10)).toEqual([
      expect.objectContaining({
        worker_script_name: 'test-unmanaged',
        first_observed_at: 100,
        last_observed_at: 110,
        notification_state: 'pending',
      }),
    ]);
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM control_audit_events
            WHERE event_type = 'control.worker_inventory.actual_only'`
        )
        .get()
    ).toEqual({ count: 1 });

    await repository.acknowledgeWorkerInventoryDriftNotifications(
      'env-test',
      ['drift:env-test:actual_only:test-unmanaged'],
      115
    );
    expect(await repository.listPendingWorkerInventoryDriftFindings('env-test', 10)).toEqual([]);
    expect(
      database
        .prepare(
          `SELECT notification_state, notified_at
             FROM control_worker_inventory_drift_findings
            WHERE worker_script_name = 'test-unmanaged'`
        )
        .get()
    ).toEqual({ notification_state: 'acknowledged', notified_at: 115 });

    await repository.resolveMissingActualOnlyWorkerFindings('env-test', [], 120);
    expect(await repository.listPendingWorkerInventoryDriftFindings('env-test', 10)).toEqual([]);
    expect(
      database
        .prepare(
          `SELECT review_state, notification_state, resolved_at
             FROM control_worker_inventory_drift_findings
            WHERE worker_script_name = 'test-unmanaged'`
        )
        .get()
    ).toEqual({ review_state: 'resolved', notification_state: 'resolved', resolved_at: 120 });

    await repository.recordActualOnlyWorkerFindings('env-test', ['test-unmanaged'], 130);
    expect(await repository.listPendingWorkerInventoryDriftFindings('env-test', 10)).toEqual([
      expect.objectContaining({
        review_state: 'unreviewed',
        notification_state: 'pending',
        first_observed_at: 130,
        notified_at: null,
        resolved_at: null,
      }),
    ]);
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM control_audit_events
            WHERE event_type = 'control.worker_inventory.actual_only'`
        )
        .get()
    ).toEqual({ count: 2 });
  });

  it('lists and reviews actual-only Worker findings without mutating Worker inventory', async () => {
    await repository.recordActualOnlyWorkerFindings('env-test', ['test-unmanaged'], 100);

    await expect(repository.listWorkerInventoryDriftFindings('env-test', 10)).resolves.toEqual([
      expect.objectContaining({
        finding_id: 'drift:env-test:actual_only:test-unmanaged',
        review_state: 'unreviewed',
        notification_state: 'pending',
      }),
    ]);

    const reviewed = await repository.reviewWorkerInventoryDriftFinding(
      'env-test',
      {
        findingId: 'drift:env-test:actual_only:test-unmanaged',
        disposition: 'reviewed',
        reviewedBy: 'admin-1',
        idempotencyKey: 'review-request-1',
      },
      110
    );
    expect(reviewed.review_state).toBe('reviewed');

    await repository.reviewWorkerInventoryDriftFinding(
      'env-test',
      {
        findingId: 'drift:env-test:actual_only:test-unmanaged',
        disposition: 'reviewed',
        reviewedBy: 'admin-1',
        idempotencyKey: 'review-request-1',
      },
      111
    );
    expect(
      database
        .prepare(
          `SELECT event_type, actor_type, actor_id, resource_id, redacted_payload_json
             FROM control_audit_events
            WHERE event_type = 'control.worker_inventory.reviewed'`
        )
        .all()
    ).toEqual([
      {
        event_type: 'control.worker_inventory.reviewed',
        actor_type: 'admin',
        actor_id: 'admin-1',
        resource_id: 'test-unmanaged',
        redacted_payload_json: JSON.stringify({
          finding_id: 'drift:env-test:actual_only:test-unmanaged',
          disposition: 'reviewed',
        }),
      },
    ]);
    expect(await repository.listActiveDesiredWorkerNames('env-test')).toEqual([]);
    await expect(
      repository.reviewWorkerInventoryDriftFinding(
        'other-env',
        {
          findingId: 'drift:env-test:actual_only:test-unmanaged',
          disposition: 'dismissed',
          reviewedBy: 'admin-1',
          idempotencyKey: 'cross-environment-review',
        },
        120
      )
    ).rejects.toThrow('control_worker_inventory_drift_review_conflict');

    await repository.resolveMissingActualOnlyWorkerFindings('env-test', [], 125);
    await expect(
      repository.reviewWorkerInventoryDriftFinding(
        'env-test',
        {
          findingId: 'drift:env-test:actual_only:test-unmanaged',
          disposition: 'dismissed',
          reviewedBy: 'admin-1',
          idempotencyKey: 'resolved-review',
        },
        130
      )
    ).rejects.toThrow('control_worker_inventory_drift_review_conflict');
  });
});
