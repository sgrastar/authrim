import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { d1Over } from './sqlite-d1';

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

/** A D1 facade with the sessions API over node:sqlite. */
export function bucketD1(database: DatabaseSync): D1Database {
  const base = d1Over(database);
  return Object.assign(Object.create(base) as D1Database, {
    prepare: base.prepare.bind(base),
    batch: base.batch.bind(base),
    withSession: () => base,
  });
}

/** Three active Lookup shards in two partitions with three buckets assigned to the first. */
export function bucketDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(
    readFileSync(resolve(REPO_ROOT, 'migrations/control/d1/001_0_4_0_control_baseline.sql'), 'utf8')
  );
  database.exec(
    `INSERT INTO control_environments (
       environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
     ) VALUES ('test', 'test', 'urn:authrim:control:test', 'active', 1, 1);
     INSERT INTO control_operations (
       operation_id, environment_id, operation_kind, idempotency_key, status,
       requested_by_type, attempt_count, created_at, completed_at, updated_at
     ) VALUES (
       'seed', 'test', 'provision_shard', 'seed', 'succeeded', 'setup', 1, 1, 1, 1
     );
     INSERT INTO control_environment_resource_policies (
       environment_id, max_concurrent_provisioning, max_ready_spares,
       max_d1_resources, daily_d1_create_budget, target_account_count,
       created_at, updated_at
     ) VALUES ('test', 2, 2, 10, 10, 100000, 1, 1);
     INSERT INTO control_residency_partitions (
       environment_id, residency_policy_id, residency_partition,
       lookup_capacity_domain_id, status, created_at, updated_at
     ) VALUES
       ('test', 'global', 'default', 'lookup:global:default', 'active', 1, 1),
       ('test', 'global-eu', 'eu', 'lookup:global-eu:eu', 'active', 1, 1);
     INSERT INTO control_desired_resources (
       desired_resource_id, environment_id, resource_kind, logical_shard_id,
       deterministic_name, ownership_fingerprint, provisioning_state,
       origin_operation_id, desired_spec_json, provider_create_state,
       provider_resource_id, provider_identity_checkpointed_at, created_at, updated_at
     ) VALUES
       ('resource-a', 'test', 'd1', 'lookup-a', 'lookup-a', 'fingerprint-a', 'active', 'seed',
        '{"residency_policy_id":"global","lookup_capacity_domain_id":"lookup:global:default"}',
        'identified', 'database-a', 1, 1, 1),
       ('resource-b', 'test', 'd1', 'lookup-b', 'lookup-b', 'fingerprint-b', 'active', 'seed',
        '{"residency_policy_id":"global","lookup_capacity_domain_id":"lookup:global:default"}',
        'identified', 'database-b', 1, 1, 1),
       ('resource-c', 'test', 'd1', 'lookup-c', 'lookup-c', 'fingerprint-c', 'active', 'seed',
        '{"residency_policy_id":"global-eu","lookup_capacity_domain_id":"lookup:global-eu:eu"}',
        'identified', 'database-c', 1, 1, 1);
     INSERT INTO control_lookup_physical_shards (
       lookup_shard_id, environment_id, residency_partition, binding_ref,
       d1_desired_resource_id, status, created_at, updated_at
     ) VALUES
       ('lookup-a', 'test', 'default', 'LOOKUP_A', 'resource-a', 'active', 1, 1),
       ('lookup-b', 'test', 'default', 'LOOKUP_B', 'resource-b', 'active', 1, 1),
       ('lookup-c', 'test', 'eu', 'LOOKUP_C', 'resource-c', 'active', 1, 1);
     INSERT INTO control_lookup_bucket_assignments (
       environment_id, virtual_bucket, lookup_shard_id, assignment_generation, state, updated_at
     ) VALUES
       ('test', 7, 'lookup-a', 3, 'active', 1),
       ('test', 8, 'lookup-a', 1, 'active', 1),
       ('test', 9, 'lookup-a', 1, 'active', 1);`
  );
  return database;
}
