import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { d1Over } from './sqlite-d1';

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

/** A D1 facade with the sessions API over node:sqlite. */
export function sessionD1(database: DatabaseSync): D1Database {
  const base = d1Over(database);
  return Object.assign(Object.create(base) as D1Database, {
    prepare: base.prepare.bind(base),
    batch: base.batch.bind(base),
    withSession: () => base,
  });
}

/** One active shared-pool tenant with a source shard for each required data role. */
export function seedPlacementTenant(database: DatabaseSync): void {
  database.exec(`
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
    INSERT INTO control_tenant_placement_policies (
      environment_id, tenant_id, isolation_policy, policy_generation, policy_state,
      source_operation_id, idempotency_key, activated_at, created_at, updated_at
    ) VALUES (
      'env-test', 'tenant-a', 'shared_pool', 1, 'active',
      'tenant-create-a', 'tenant-create-a', 1, 1, 1
    );
    INSERT INTO control_operations (
      operation_id, environment_id, operation_kind, idempotency_key, status,
      requested_by_type, attempt_count, created_at, completed_at, updated_at
    ) VALUES (
      'fixture-shards', 'env-test', 'tenant_shard_provision', 'fixture-shards',
      'succeeded', 'setup', 1, 1, 1, 1
    );
  `);
  for (const [index, role] of [
    'tenant_core/default',
    'tenant_core/users',
    'tenant_pii',
  ].entries()) {
    const shardId = `shared-${index + 1}`;
    database
      .prepare(
        `INSERT INTO control_desired_resources (
           desired_resource_id, environment_id, resource_kind, logical_shard_id,
           deterministic_name, ownership_fingerprint, provisioning_state,
           origin_operation_id, provider_create_state, provider_resource_id,
           provider_identity_checkpointed_at, created_at, updated_at
         ) VALUES (?, 'env-test', 'd1', ?, ?, ?, 'active', 'fixture-shards',
                   'identified', ?, 1, 1, 1)`
      )
      .run(
        `desired-${index + 1}`,
        `logical-${index + 1}`,
        `database-${index + 1}`,
        `fingerprint-${index + 1}`,
        `provider-database-${index + 1}`
      );
    database
      .prepare(
        `INSERT INTO control_tenant_shards (
           shard_id, environment_id, data_role, residency_policy_id, residency_partition,
           generation, logical_shard_id, binding_ref, d1_desired_resource_id,
           status, created_at, updated_at, allocation_scope, owner_tenant_id
         ) VALUES (?, 'env-test', ?, 'default', 'jp', 1, ?, ?, ?, 'active', 1, 1,
                   'shared_pool', NULL)`
      )
      .run(
        shardId,
        role,
        `logical-${index + 1}`,
        `TDB_SHARED_${index + 1}`,
        `desired-${index + 1}`
      );
    database
      .prepare(
        `INSERT INTO control_tenant_shard_assignments (
           environment_id, tenant_id, data_role, residency_policy_id, residency_partition,
           shard_id, assignment_generation, assignment_state, source_operation_id,
           created_at, activated_at, updated_at
         ) VALUES ('env-test', 'tenant-a', ?, 'default', 'jp', ?, 1, 'active',
                   'tenant-create-a', 1, 1, 1)`
      )
      .run(role, shardId);
  }
}

/** The 0.4.0 control baseline with one migratable shared-pool tenant. */
export function placementDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(
    readFileSync(resolve(REPO_ROOT, 'migrations/control/d1/001_0_4_0_control_baseline.sql'), 'utf8')
  );
  seedPlacementTenant(database);
  return database;
}
