import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));

function migration(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8')
    .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', '1')
    .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '1000');
}

function controlDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(migration('migrations/control/001_pre_1_0_control_baseline.sql'));
  db.exec(
    `INSERT INTO control_environments (
       environment_id, environment_name, issuer, created_at, updated_at
     ) VALUES (
       'env-1', 'test', 'urn:authrim:control:env-1', 1, 1
     );
     INSERT INTO control_operations (
       operation_id, environment_id, operation_kind, idempotency_key,
       requested_by_type, created_at, updated_at
     ) VALUES (
       'op-1', 'env-1', 'bootstrap', 'bootstrap-1', 'setup', 1, 1
     );
     INSERT INTO control_environment_resource_policies (
       environment_id, max_concurrent_provisioning, max_ready_spares,
       max_d1_resources, daily_d1_create_budget, target_account_count,
       created_at, updated_at
     ) VALUES (
       'env-1', 2, 2, 1000, 20, 100000, 1, 1
     );`
  );
  return db;
}

function applyLookupGeneratedBindingMigration(db: DatabaseSync): void {}

describe('Control D1 schema', () => {
  it('keeps the built-in Lookup capacity domain explicit without constraining operator domains', () => {
    const db = controlDatabase();
    db.exec(
      `INSERT INTO control_residency_partitions (
         environment_id, residency_policy_id, residency_partition,
         lookup_capacity_domain_id, created_at, updated_at
       ) VALUES
         ('env-1', 'builtin:residency:default', 'default',
          'lookup:builtin:residency:default:default', 1, 1),
         ('env-1', 'operator:regional', 'apac', NULL, 1, 1);`
    );

    expect(
      db
        .prepare(
          `SELECT residency_policy_id, residency_partition, lookup_capacity_domain_id
             FROM control_residency_partitions
            ORDER BY residency_policy_id`
        )
        .all()
    ).toEqual([
      {
        residency_policy_id: 'builtin:residency:default',
        residency_partition: 'default',
        lookup_capacity_domain_id: 'lookup:builtin:residency:default:default',
      },
      {
        residency_policy_id: 'operator:regional',
        residency_partition: 'apac',
        lookup_capacity_domain_id: null,
      },
    ]);
    db.close();
  });

  it('exports additional physical Lookup shards to every Worker requiring the lookup role', () => {
    const db = controlDatabase();
    db.exec(
      `INSERT INTO control_desired_worker_inventory (
         environment_id, worker_script_name, package_name,
         deployment_target, capability_manifest_digest, source_manifest_path,
         source_manifest_hash, generated_artifact_hash, source_kind,
         source_reference, registration_mode, status, review_state,
         registered_by_operation_id, registered_by, registered_at
       ) VALUES (
         'env-1', 'test-ar-management', '@authrim/ar-management', 'default', '${'a'.repeat(64)}',
         'packages/ar-management/authrim.worker-capabilities.json', '${'b'.repeat(64)}',
         '${'c'.repeat(64)}', 'core_manifest',
         'packages/ar-management/authrim.worker-capabilities.json', 'auto', 'active',
         'auto_registered', 'op-1', 'setup', 1
       );
       INSERT INTO control_worker_required_data_roles (
         environment_id, worker_script_name, data_role, source_manifest_hash, updated_at
       ) VALUES ('env-1', 'test-ar-management', 'lookup', '${'b'.repeat(64)}', 1);
       INSERT INTO control_desired_resources (
         desired_resource_id, environment_id, resource_kind, logical_shard_id,
         deterministic_name, ownership_fingerprint, provisioning_state,
         origin_operation_id, created_at, updated_at
       ) VALUES
         ('resource-lookup-base', 'env-1', 'd1', 'lookup-base', 'lookup-base',
          'lookup-base-fingerprint', 'ready', 'op-1', 1, 1),
         ('resource-lookup-extra', 'env-1', 'd1', 'lookup-extra', 'lookup-extra',
          'lookup-extra-fingerprint', 'ready', 'op-1', 1, 1);
       INSERT INTO control_lookup_physical_shards (
         lookup_shard_id, environment_id, residency_partition, binding_ref,
         d1_desired_resource_id, status, created_at, updated_at
       ) VALUES
         ('lookup-base', 'env-1', 'default', 'LOOKUP_DB',
          'resource-lookup-base', 'active', 1, 1),
         ('lookup-extra', 'env-1', 'default', 'TDB_LOOKUP_EXTRA_LOOKUP',
          'resource-lookup-extra', 'active', 1, 1);
       INSERT INTO control_worker_desired_bindings (
         environment_id, worker_script_name, binding_name, binding_kind,
         data_role, desired_spec_json, updated_at
       ) VALUES (
         'env-1', 'test-ar-management', 'LOOKUP_DB', 'd1', 'lookup', '{}', 1
       );`
    );

    applyLookupGeneratedBindingMigration(db);

    expect(
      db
        .prepare(
          `SELECT binding_name, data_role, logical_resource_id
             FROM control_desired_worker_binding_export
            WHERE worker_script_name = 'test-ar-management'
            ORDER BY binding_name`
        )
        .all()
    ).toEqual([
      { binding_name: 'LOOKUP_DB', data_role: 'lookup', logical_resource_id: null },
      {
        binding_name: 'TDB_LOOKUP_EXTRA_LOOKUP',
        data_role: 'lookup',
        logical_resource_id: 'resource-lookup-extra',
      },
    ]);
    db.close();
  });

  it('migrates binding reconciliation inventory to support Lookup without weakening isolation', () => {
    const db = controlDatabase();
    db.exec(
      `INSERT INTO control_desired_worker_inventory (
         environment_id, worker_script_name, package_name,
         deployment_target, capability_manifest_digest, source_manifest_path,
         source_manifest_hash, generated_artifact_hash, source_kind,
         source_reference, registration_mode, status, review_state,
         registered_by_operation_id, registered_by, registered_at
       ) VALUES (
         'env-1', 'test-ar-auth', '@authrim/ar-auth', 'default', '${'a'.repeat(64)}',
         'packages/ar-auth/authrim.worker-capabilities.json', '${'b'.repeat(64)}',
         '${'c'.repeat(64)}', 'core_manifest',
         'packages/ar-auth/authrim.worker-capabilities.json', 'auto', 'active',
         'auto_registered', 'op-1', 'setup', 1
       );
       INSERT INTO control_residency_partitions (
         environment_id, residency_policy_id, residency_partition, created_at, updated_at
       ) VALUES ('env-1', 'policy-1', 'default', 1, 1);
       INSERT INTO control_desired_resources (
         desired_resource_id, environment_id, resource_kind, logical_shard_id,
         deterministic_name, ownership_fingerprint, origin_operation_id, created_at, updated_at
       ) VALUES
         ('resource-tenant', 'env-1', 'd1', 'tenant-default-1', 'tenant-default-1',
          'tenant-fingerprint', 'op-1', 1, 1),
         ('resource-lookup', 'env-1', 'd1', 'lookup-default-1', 'lookup-default-1',
          'lookup-fingerprint', 'op-1', 1, 1);
       INSERT INTO control_tenant_shards (
         shard_id, environment_id, data_role, residency_policy_id, residency_partition,
         generation, logical_shard_id, binding_ref, d1_desired_resource_id, created_at, updated_at
       ) VALUES (
         'tenant-shard-1', 'env-1', 'tenant_core/default', 'policy-1', 'default', 1,
         'tenant-default-1', 'TENANT_DEFAULT_1', 'resource-tenant', 1, 1
       );
       INSERT INTO control_lookup_physical_shards (
         lookup_shard_id, environment_id, residency_partition, binding_ref,
         d1_desired_resource_id, created_at, updated_at
       ) VALUES (
         'lookup-shard-1', 'env-1', 'default', 'LOOKUP_DEFAULT_1',
         'resource-lookup', 1, 1
       );
       INSERT INTO control_worker_binding_reconciliations (
         operation_id, environment_id, worker_script_name, shard_id, binding_ref,
         data_role, residency_partition, migration_generation, provider_database_id,
         created_at, updated_at
       ) VALUES (
         'op-1', 'env-1', 'test-ar-auth', 'tenant-shard-1', 'TENANT_DEFAULT_1',
         'tenant_core/default', 'default', 1, 'provider-tenant', 1, 1
       );`
    );

    expect(
      db
        .prepare(
          `SELECT shard_id, data_role, binding_ref
             FROM control_worker_binding_reconciliations
            WHERE operation_id = 'op-1' AND binding_ref = 'TENANT_DEFAULT_1'`
        )
        .get()
    ).toEqual({
      shard_id: 'tenant-shard-1',
      data_role: 'tenant_core/default',
      binding_ref: 'TENANT_DEFAULT_1',
    });

    const insertReconciliation = db.prepare(
      `INSERT INTO control_worker_binding_reconciliations (
         operation_id, environment_id, worker_script_name, shard_id, binding_ref,
         data_role, residency_partition, migration_generation, provider_database_id,
         created_at, updated_at
       ) VALUES ('op-1', 'env-1', 'test-ar-auth', ?, ?, ?, 'default', 1, ?, 2, 2)`
    );
    insertReconciliation.run('lookup-shard-1', 'LOOKUP_DEFAULT_1', 'lookup', 'provider-lookup');
    expect(() =>
      insertReconciliation.run(
        'tenant-shard-1',
        'LOOKUP_WRONG_INVENTORY',
        'lookup',
        'provider-invalid-lookup'
      )
    ).toThrow('control_worker_binding_inventory_mismatch');
    expect(() =>
      insertReconciliation.run(
        'lookup-shard-1',
        'TENANT_WRONG_INVENTORY',
        'tenant_core/default',
        'provider-invalid-tenant'
      )
    ).toThrow('control_worker_binding_inventory_mismatch');
    expect(() =>
      db.exec(
        `UPDATE control_worker_binding_reconciliations
            SET shard_id = 'lookup-shard-1', data_role = 'lookup'
          WHERE operation_id = 'op-1' AND binding_ref = 'TENANT_DEFAULT_1';`
      )
    ).toThrow('control_worker_binding_inventory_mismatch');
    db.close();
  });

  it('accepts Worker Loader desired bindings and preserves the export view', () => {
    const db = controlDatabase();
    db.exec(
      `INSERT INTO control_desired_worker_inventory (
         environment_id, worker_script_name, package_name,
         deployment_target, capability_manifest_digest, source_manifest_path,
         source_manifest_hash, generated_artifact_hash, source_kind,
         source_reference, registration_mode, status, review_state,
         registered_by_operation_id, registered_by, registered_at
       ) VALUES (
         'env-1', 'test-ar-plugin-runner', '@authrim/ar-plugin-runner',
         'default', '${'a'.repeat(64)}', 'packages/ar-plugin-runner/authrim.worker-capabilities.json',
         '${'b'.repeat(64)}', '${'c'.repeat(64)}', 'core_manifest',
         'packages/ar-plugin-runner/authrim.worker-capabilities.json', 'auto', 'active',
         'auto_registered', 'op-1', 'setup', 1
       );
       INSERT INTO control_worker_desired_bindings (
         environment_id, worker_script_name, binding_name, binding_kind,
         desired_spec_json, updated_at
       ) VALUES (
         'env-1', 'test-ar-plugin-runner', 'PLUGIN_LOADER', 'worker_loader', '{}', 1
       );`
    );

    expect(
      db
        .prepare(
          `SELECT binding_name, binding_kind
             FROM control_desired_worker_binding_export
            WHERE worker_script_name = 'test-ar-plugin-runner'`
        )
        .get()
    ).toEqual({ binding_name: 'PLUGIN_LOADER', binding_kind: 'worker_loader' });
    expect(() =>
      db.exec(
        `INSERT INTO control_worker_desired_bindings (
           environment_id, worker_script_name, binding_name, binding_kind,
           desired_spec_json, updated_at
         ) VALUES (
           'env-1', 'test-ar-plugin-runner', 'UNKNOWN', 'worker_loader_unknown', '{}', 1
         );`
      )
    ).toThrow();
    db.close();
  });

  it('keeps Automatic provisioning authority metadata internally consistent', () => {
    const db = controlDatabase();
    expect(() =>
      db.exec(
        `UPDATE control_environments
            SET automatic_provisioning_enabled = 1,
                provisioning_token_ownership = 'none',
                provisioning_capability_state = 'ready'
          WHERE environment_id = 'env-1';`
      )
    ).toThrow('control_automatic_provisioning_authority_invalid');
    db.exec(
      `UPDATE control_environments
          SET automatic_provisioning_enabled = 1,
              provisioning_token_ownership = 'none',
              provisioning_capability_state = 'pending'
        WHERE environment_id = 'env-1';
       UPDATE control_environments
          SET provisioning_token_ownership = 'account',
              provisioning_capability_state = 'ready',
              provisioning_capability_checked_at = 2
        WHERE environment_id = 'env-1';`
    );
    expect(
      db
        .prepare(
          `SELECT automatic_provisioning_enabled, provisioning_token_ownership,
                  provisioning_capability_state, provisioning_capability_checked_at
             FROM control_environments WHERE environment_id = 'env-1'`
        )
        .get()
    ).toEqual({
      automatic_provisioning_enabled: 1,
      provisioning_token_ownership: 'account',
      provisioning_capability_state: 'ready',
      provisioning_capability_checked_at: 2,
    });
    db.close();
  });

  it('enforces canonical operation and step state transitions', () => {
    const db = controlDatabase();
    db.exec(
      `INSERT INTO control_operation_steps (
         operation_id, step_key, status, updated_at
       ) VALUES ('op-1', 'create_d1', 'queued', 1);
       UPDATE control_operations SET status = 'running', updated_at = 2
        WHERE operation_id = 'op-1';
       UPDATE control_operation_steps SET status = 'running', updated_at = 2
        WHERE operation_id = 'op-1' AND step_key = 'create_d1';
       UPDATE control_operations SET status = 'waiting_retry', updated_at = 3
        WHERE operation_id = 'op-1';
       UPDATE control_operation_steps SET status = 'waiting_retry', updated_at = 3
        WHERE operation_id = 'op-1' AND step_key = 'create_d1';`
    );
    expect(() =>
      db.exec(
        `UPDATE control_operations SET status = 'queued', updated_at = 4
          WHERE operation_id = 'op-1';`
      )
    ).toThrow('invalid_control_operation_status_transition');
    expect(() =>
      db.exec(
        `UPDATE control_operation_steps SET status = 'succeeded', completed_at = 4, updated_at = 4
          WHERE operation_id = 'op-1' AND step_key = 'create_d1';`
      )
    ).toThrow('invalid_control_operation_step_status_transition');
    db.exec(
      `UPDATE control_operations SET status = 'running', updated_at = 4
        WHERE operation_id = 'op-1';
       UPDATE control_operations SET status = 'succeeded', completed_at = 5, updated_at = 5
        WHERE operation_id = 'op-1';`
    );
    expect(() =>
      db.exec(
        `UPDATE control_operations SET status = 'running', updated_at = 6
          WHERE operation_id = 'op-1';`
      )
    ).toThrow('invalid_control_operation_status_transition');
    db.close();
  });

  it('enforces desired resource identity and operation idempotency', () => {
    const db = controlDatabase();
    db.exec(
      `INSERT INTO control_desired_resources (
         desired_resource_id, environment_id, resource_kind, logical_shard_id,
         deterministic_name, ownership_fingerprint, origin_operation_id, created_at, updated_at
       ) VALUES ('r-1', 'env-1', 'd1', 'core-users-1', 'test-core-users-1', 'fp-1', 'op-1', 1, 1);`
    );
    expect(() =>
      db.exec(
        `INSERT INTO control_desired_resources (
           desired_resource_id, environment_id, resource_kind, logical_shard_id,
           deterministic_name, ownership_fingerprint, origin_operation_id, created_at, updated_at
         ) VALUES ('r-2', 'env-1', 'd1', 'core-users-1', 'different-name', 'fp-2', 'op-1', 1, 1);`
      )
    ).toThrow();
    expect(() =>
      db.exec(
        `INSERT INTO control_operations (
           operation_id, environment_id, operation_kind, idempotency_key,
           requested_by_type, created_at, updated_at
         ) VALUES ('op-2', 'env-1', 'retry', 'bootstrap-1', 'scheduler', 1, 1);`
      )
    ).toThrow();
    db.close();
  });

  it('rejects cross-environment operation and resource references', () => {
    const db = controlDatabase();
    db.exec(
      `INSERT INTO control_environments (
         environment_id, environment_name, issuer, created_at, updated_at
       ) VALUES ('env-2', 'other', 'urn:authrim:control:env-2', 1, 1);
       INSERT INTO control_operations (
         operation_id, environment_id, operation_kind, idempotency_key,
         requested_by_type, created_at, updated_at
       ) VALUES ('op-env-2', 'env-2', 'bootstrap', 'bootstrap-2', 'setup', 1, 1);
       INSERT INTO control_environment_resource_policies (
         environment_id, max_concurrent_provisioning, max_ready_spares,
         max_d1_resources, daily_d1_create_budget, target_account_count,
         created_at, updated_at
       ) VALUES ('env-2', 2, 2, 1000, 20, 100000, 1, 1);
       INSERT INTO control_desired_resources (
         desired_resource_id, environment_id, resource_kind, logical_shard_id,
         deterministic_name, ownership_fingerprint, origin_operation_id, created_at, updated_at
       ) VALUES ('r-env-1', 'env-1', 'd1', 'core-env-1', 'test-core-env-1',
                 'fp-env-1', 'op-1', 1, 1);`
    );
    expect(() =>
      db.exec(
        `INSERT INTO control_desired_resources (
           desired_resource_id, environment_id, resource_kind, logical_shard_id,
           deterministic_name, ownership_fingerprint, origin_operation_id, created_at, updated_at
         ) VALUES ('r-invalid-op', 'env-1', 'd1', 'invalid-op', 'test-invalid-op',
                   'fp-invalid', 'op-env-2', 1, 1);`
      )
    ).toThrow();
    expect(() =>
      db.exec(
        `INSERT INTO control_observed_resources (
           observed_resource_id, environment_id, desired_resource_id, provider_resource_id,
           provider_name, resource_kind, observed_state, observed_at
         ) VALUES ('observed-invalid', 'env-2', 'r-env-1', 'provider-1',
                   'test-core-env-1', 'd1', 'present', 1);`
      )
    ).toThrow();
    db.close();
  });

  it('rejects invalid handoff, release, rewrite, and signing-key states', () => {
    const db = controlDatabase();
    db.exec(
      `INSERT INTO control_operations (
         operation_id, environment_id, operation_kind, idempotency_key,
         requested_by_type, created_at, updated_at
       ) VALUES ('op-2', 'env-1', 'lookup_bucket_migration', 'rewrite-2', 'scheduler', 1, 1);`
    );
    expect(() =>
      db.exec(
        `INSERT INTO control_bootstrap_handoffs (
           environment_id, state, ownership_fingerprint, release_manifest_digest, updated_at
         ) VALUES ('env-1', 'accepted', 'fp', '${'a'.repeat(64)}', 1);`
      )
    ).toThrow();

    db.exec(
      `INSERT INTO control_migration_release_catalog (
         environment_id, stream_id, release_id, manifest_digest, manifest_r2_object_key,
         state, active_stream_key, registered_by_operation_id, registered_at
       ) VALUES ('env-1', 'd1-control', 'release-1', '${'a'.repeat(64)}',
                 'releases/release-1/${'a'.repeat(64)}/manifest.json',
                 'active', 'active', 'op-1', 1);`
    );
    expect(() =>
      db.exec(
        `INSERT INTO control_migration_release_catalog (
           environment_id, stream_id, release_id, manifest_digest, manifest_r2_object_key,
           state, active_stream_key, registered_by_operation_id, registered_at
         ) VALUES ('env-1', 'd1-control', 'release-2', '${'b'.repeat(64)}',
                   'releases/release-2/${'b'.repeat(64)}/manifest.json',
                   'active', 'active', 'op-1', 1);`
      )
    ).toThrow();
    expect(() =>
      db.exec(
        `UPDATE control_migration_release_catalog
            SET manifest_digest = '${'c'.repeat(64)}'
          WHERE environment_id = 'env-1' AND stream_id = 'd1-control' AND release_id = 'release-1';`
      )
    ).toThrow('control_release_catalog_immutable');
    db.exec(
      `INSERT INTO control_operation_release_pins (
         operation_id, environment_id, stream_id, release_id, manifest_digest, pinned_at
       ) VALUES ('op-1', 'env-1', 'd1-control', 'release-1', '${'a'.repeat(64)}', 1);`
    );
    expect(() =>
      db.exec(
        `UPDATE control_operation_release_pins SET release_id = 'release-2'
          WHERE operation_id = 'op-1' AND stream_id = 'd1-control';`
      )
    ).toThrow('control_operation_release_pin_immutable');

    db.exec(
      `INSERT INTO control_directory_rewrite_leases (
         environment_id, operation_id, operation_kind, owner_id, fencing_token,
         lease_expires_at, mutation_started, updated_at
       ) VALUES ('env-1', 'op-1', 'hmac_reindex', 'worker-a', 1, 1, 1, 1);`
    );
    expect(() =>
      db.exec(
        `UPDATE control_directory_rewrite_leases
            SET operation_id = 'op-2', operation_kind = 'lookup_bucket_migration',
                owner_id = 'worker-b', fencing_token = 2, updated_at = 2
          WHERE environment_id = 'env-1';`
      )
    ).toThrow('control_directory_rewrite_takeover_forbidden');
    expect(() =>
      db.exec(
        `UPDATE control_directory_rewrite_leases
            SET mutation_started = 0, updated_at = 2
          WHERE environment_id = 'env-1';`
      )
    ).toThrow('control_directory_rewrite_rollback_verification_required');
    expect(() =>
      db.exec(`DELETE FROM control_directory_rewrite_leases WHERE environment_id = 'env-1';`)
    ).toThrow('control_directory_rewrite_delete_forbidden_after_mutation');
    db.exec(
      `UPDATE control_directory_rewrite_leases
          SET mutation_started = 0, rollback_verified_at = 2, updated_at = 2
        WHERE environment_id = 'env-1';
       UPDATE control_directory_rewrite_leases
          SET operation_id = 'op-2', operation_kind = 'lookup_bucket_migration',
              owner_id = 'worker-b', fencing_token = 2, updated_at = 3
        WHERE environment_id = 'env-1';`
    );

    const validPublicJwkJson = JSON.stringify({
      kty: 'OKP',
      crv: 'Ed25519',
      x: 'A'.repeat(43),
      alg: 'EdDSA',
    });
    db.exec(
      `INSERT INTO control_signing_key_metadata (
         environment_id, key_purpose, slot, key_id, public_jwk_json,
         public_key_fingerprint, state, active_key_guard, updated_at
       ) VALUES ('env-1', 'smoke_rpc', 'a', 'smoke-a', '${validPublicJwkJson}',
                 'fp-a', 'active', 'active', 1);`
    );
    expect(() =>
      db.exec(
        `INSERT INTO control_signing_key_metadata (
           environment_id, key_purpose, slot, key_id, public_jwk_json,
           public_key_fingerprint, state, active_key_guard, updated_at
         ) VALUES ('env-1', 'smoke_rpc', 'b', 'smoke-b', '${validPublicJwkJson}',
                   'fp-b', 'active', 'active', 1);`
      )
    ).toThrow();
    db.close();
  });

  it('requires complete Runtime Registry activation and aggregate replication evidence', () => {
    const db = controlDatabase();
    expect(() =>
      db.exec(
        `INSERT INTO control_runtime_registry_routes (
           environment_id, tenant_id, route_generation, tenant_lifecycle_generation,
           quarantine_deny_generation, registry_publication_generation,
           tenant_lifecycle_state, route_status, residency_policy_id,
           route_projection_json, source_operation_id, created_at, updated_at
         ) VALUES (
           'env-1', 'tenant-1', 1, 1, 0, 1, 'creating', 'active', 'policy-1',
           '{}', 'op-1', 1, 1
         );`
      )
    ).toThrow();
    expect(() =>
      db.exec(
        `INSERT INTO control_runtime_registry_publications (
           environment_id, generation, active_slot, active_key_id, kv_object_key,
           publication_state, operation_id, updated_at
         ) VALUES ('env-1', 1, 'a', 'key-a', 'registry/1.jws', 'active', 'op-1', 1);`
      )
    ).toThrow();
    expect(() =>
      db.exec(
        `INSERT INTO control_read_replication_rollouts (
           operation_id, environment_id, desired_mode, status,
           eligible_policy_count, applied_policy_count, failed_policy_count,
           created_at, updated_at
         ) VALUES ('op-1', 'env-1', 'enabled', 'attention_required', 2, 2, 0, 1, 1);`
      )
    ).toThrow();
    db.close();
  });

  it('applies the resumable read-replication rollout schema and permits one active rollout', () => {
    const db = controlDatabase();
    const lookupColumns = db
      .prepare('PRAGMA table_info(control_lookup_physical_shards)')
      .all() as Array<{ name: string }>;
    const tenantColumns = db.prepare('PRAGMA table_info(control_tenant_shards)').all() as Array<{
      name: string;
    }>;
    expect(lookupColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'read_replication_mode',
        'observed_replication_state',
        'replication_checked_at',
        'replication_error_code',
      ])
    );
    expect(tenantColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['replication_checked_at', 'replication_error_code'])
    );
    db.exec(
      `INSERT INTO control_read_replication_rollouts (
         operation_id, environment_id, desired_mode, status, created_at, updated_at
       ) VALUES ('op-1', 'env-1', 'enabled', 'applying', 1, 1);
       INSERT INTO control_operations (
         operation_id, environment_id, operation_kind, idempotency_key,
         requested_by_type, created_at, updated_at
       ) VALUES ('op-2', 'env-1', 'read_replication_rollout', 'read-replication-2',
                 'admin', 2, 2);`
    );
    expect(() =>
      db.exec(
        `INSERT INTO control_read_replication_rollouts (
           operation_id, environment_id, desired_mode, status, created_at, updated_at
         ) VALUES ('op-2', 'env-1', 'disabled', 'queued', 2, 2);`
      )
    ).toThrow();
    db.close();
  });

  it('contains no columns capable of storing provider tokens or private signing keys', () => {
    const db = controlDatabase();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const columnNames = tables.flatMap((table) =>
      (db.prepare(`PRAGMA table_info(${table.name})`).all() as Array<{ name: string }>).map(
        (column) => column.name.toLowerCase()
      )
    );
    expect(
      columnNames.some((name) => /api_token|private_jwk|hmac_key_body|raw_email/.test(name))
    ).toBe(false);
    db.close();
  });

  it('rejects malformed or private signing JWK material at the database boundary', () => {
    const db = controlDatabase();
    for (const publicJwkJson of [
      'not-json',
      JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43), d: 'private' }),
      JSON.stringify({ kty: 'oct', k: 'symmetric' }),
      JSON.stringify({ kty: 'RSA', n: 'modulus', e: 'AQAB' }),
      JSON.stringify({ kty: 'OKP', crv: 'X25519', x: 'A'.repeat(43) }),
      JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'too-short' }),
    ]) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO control_signing_key_metadata (
               environment_id, key_purpose, slot, key_id, public_jwk_json,
               public_key_fingerprint, state, active_key_guard, updated_at
             ) VALUES ('env-1', 'smoke_rpc', 'a', 'key-a', ?, 'fingerprint',
                       'staged', 'slot:a', 1)`
          )
          .run(publicJwkJson)
      ).toThrow();
    }
    db.prepare(
      `INSERT INTO control_signing_key_metadata (
         environment_id, key_purpose, slot, key_id, public_jwk_json,
         public_key_fingerprint, state, active_key_guard, updated_at
       ) VALUES ('env-1', 'smoke_rpc', 'a', 'valid-key', ?, 'fingerprint',
                 'staged', 'slot:a', 1)`
    ).run(JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43), alg: 'EdDSA' }));
    db.close();
  });

  it('rejects D1 desired resources when the environment resource cap is reached', () => {
    const db = controlDatabase();
    db.exec(
      `UPDATE control_environment_resource_policies SET max_d1_resources = 1
        WHERE environment_id = 'env-1';
       INSERT INTO control_desired_resources (
         desired_resource_id, environment_id, resource_kind, logical_shard_id,
         deterministic_name, ownership_fingerprint, origin_operation_id, created_at, updated_at
       ) VALUES ('r-1', 'env-1', 'd1', 'core-1', 'test-core-1', 'fp-1', 'op-1', 1, 1);`
    );
    expect(() =>
      db.exec(
        `INSERT INTO control_desired_resources (
           desired_resource_id, environment_id, resource_kind, logical_shard_id,
           deterministic_name, ownership_fingerprint, origin_operation_id, created_at, updated_at
         ) VALUES ('r-2', 'env-1', 'd1', 'core-2', 'test-core-2', 'fp-2', 'op-1', 1, 1);`
      )
    ).toThrow('control_d1_resource_limit');
    db.close();
  });
});

describe('Lookup D1 schema', () => {
  it('enforces the three-state activation gate and tenant-scoped uniqueness authority', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(migration('migrations/lookup/001_pre_1_0_lookup_baseline.sql'));
    const identifierSql = `INSERT INTO lookup_identifiers (
      virtual_bucket, index_kind, normalization_version, hmac_key_generation,
      identifier_blind_digest, tenant_id, account_id, route_schema_version,
      account_route_generation, required_binding_route_generation, residency_policy_id,
      route_projection_json, tenant_lifecycle_state, runtime_route_status, lifecycle_state,
      created_at, updated_at
    ) VALUES (1, 'email_exact', 1, 1, 'digest', 'tenant-1', 'account-1', 1, 1, 1,
      'residency-1', '{}', 'creating', 'pending', 'active', 1, 1);`;
    expect(() => db.exec(identifierSql)).toThrow();

    db.exec(
      identifierSql.replace("'creating', 'pending'", "'active', 'active'") +
        `INSERT INTO lookup_identifier_reservations (
          virtual_bucket, tenant_id, index_kind, normalization_version, hmac_key_generation,
          identifier_blind_digest, account_id, operation_id, created_at, updated_at
        ) VALUES (1, 'tenant-1', 'email_exact', 1, 1, 'digest', 'account-1', 'op-1', 1, 1);`
    );
    expect(() =>
      db.exec(
        `INSERT INTO lookup_identifier_reservations (
          virtual_bucket, tenant_id, index_kind, normalization_version, hmac_key_generation,
          identifier_blind_digest, account_id, operation_id, created_at, updated_at
        ) VALUES (1, 'tenant-1', 'email_exact', 1, 1, 'digest', 'account-2', 'op-2', 1, 1);`
      )
    ).toThrow();
    db.close();
  });

  it('allows only one live tenant alias owner per exact alias digest', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(migration('migrations/lookup/001_pre_1_0_lookup_baseline.sql'));
    const insert = (tenantId: string, lifecycleState: 'pending' | 'active' | 'disabled') =>
      db
        .prepare(
          `INSERT INTO lookup_tenant_aliases (
             virtual_bucket, alias_kind, alias_sha256_digest, tenant_id,
             route_schema_version, route_projection_json, tenant_lifecycle_state,
             runtime_route_status, lifecycle_state, created_at, updated_at
           ) VALUES (1, 'tenant_code', 'digest', ?, 1, '{}', 'active', 'active', ?, 1, 1)`
        )
        .run(tenantId, lifecycleState);
    insert('tenant-1', 'pending');
    expect(() => insert('tenant-2', 'active')).toThrow();
    db.exec(
      `UPDATE lookup_tenant_aliases SET lifecycle_state = 'disabled'
        WHERE tenant_id = 'tenant-1'`
    );
    expect(() => insert('tenant-2', 'active')).not.toThrow();
    db.close();
  });

  it('stores discovery challenges without raw email or domain indexes', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(migration('migrations/lookup/001_pre_1_0_lookup_baseline.sql'));
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table'").all() as Array<{
      sql: string;
    }>;
    const serialized = schema
      .map((row) => row.sql)
      .join('\n')
      .toLowerCase();
    expect(serialized).not.toContain('raw_email');
    expect(serialized).not.toContain('email_domain');
    expect(serialized).toContain('email_blind_digest');
    db.close();
  });

  it('keeps replacement authority in PII and only blind verification gates in Lookup', () => {
    const oldHash = 'a'.repeat(64);
    const newHash = 'b'.repeat(64);
    const verifier = 'c'.repeat(64);
    const idempotencyHash = 'd'.repeat(64);
    const fingerprint = 'e'.repeat(64);
    const oldDigest = 'f'.repeat(64);
    const newDigest = '0'.repeat(64);
    const pii = new DatabaseSync(':memory:');
    pii.exec(migration('migrations/pii/001_pre_1_0_pii_baseline.sql'));
    const insertChallenge = (reauthenticatedAt: number) =>
      pii
        .prepare(
          `INSERT INTO identity_identifier_replacement_challenges (
             challenge_id, tenant_id, account_id, identifier_kind, normalized_value_json,
             value_sha256, otp_verifier, attempt_limit, expires_at, consumed_at,
             initiating_session_ref, recent_reauth_verified_at, created_at, updated_at
           ) VALUES ('challenge-1', 'tenant-1', 'account-1', 'email_exact', ?, ?, ?, 5,
                     1600, 1100, 'session-1', ?, 1000, 1000)`
        )
        .run(JSON.stringify('new@example.test'), newHash, verifier, reauthenticatedAt);
    expect(() => insertChallenge(699)).toThrow();
    expect(() => insertChallenge(700)).not.toThrow();
    pii.exec(
      `INSERT INTO identity_identifier_replacement_operations (
         operation_id, tenant_id, account_id, identifier_kind, authority,
         idempotency_key_sha256, request_fingerprint_sha256, challenge_id,
         initiating_session_ref, outbox_id, retry_budget_expires_at, created_at, updated_at
       ) VALUES ('replacement-1', 'tenant-1', 'account-1', 'email_exact', 'self_service',
                 '${idempotencyHash}', '${fingerprint}', 'challenge-1', 'session-1',
                 'outbox-1', 8200, 1000, 1000);
       INSERT INTO identity_identifier_replacement_history (
         operation_id, old_value_json, new_value_json, old_value_sha256, new_value_sha256,
         normalization_version, actor_ref, authority_evidence_json,
         verification_evidence_json, created_at
       ) VALUES ('replacement-1', '"old@example.test"', '"new@example.test"',
                 '${oldHash}', '${newHash}', 1, 'account-1', '{}', '{}', 1000);
       INSERT INTO identity_identifier_replacement_projections (
         operation_id, identifier_side, hmac_key_generation, normalization_version,
         virtual_bucket, blind_digest, created_at, updated_at
       ) VALUES
         ('replacement-1', 'old', 1, 1, 10, '${oldDigest}', 1000, 1000),
         ('replacement-1', 'new', 1, 1, 11, '${newDigest}', 1000, 1000);
       INSERT INTO identity_identifier_replacement_outbox (
         outbox_id, operation_id, tenant_id, account_id, event_kind, payload_json,
         created_at, updated_at
       ) VALUES ('outbox-1', 'replacement-1', 'tenant-1', 'account-1',
                 'identifier_replacement',
                 '{"operationId":"replacement-1","tenantId":"tenant-1","accountId":"account-1","projections":[]}',
                 1000, 1000);`
    );
    expect(() =>
      pii.exec(
        `UPDATE identity_identifier_replacement_history
            SET new_value_json = '"tampered@example.test"'
          WHERE operation_id = 'replacement-1'`
      )
    ).toThrow('identifier_replacement_history_immutable');
    expect(() =>
      pii.exec(
        `UPDATE identity_identifier_replacement_history
            SET old_value_json = NULL, new_value_json = NULL, raw_values_erased_at = 1200
          WHERE operation_id = 'replacement-1'`
      )
    ).toThrow('identifier_replacement_history_immutable');
    pii.exec(
      `UPDATE identity_identifier_replacement_operations
          SET state = 'canceled', updated_at = 1200
        WHERE operation_id = 'replacement-1'`
    );
    expect(() =>
      pii.exec(
        `UPDATE identity_identifier_replacement_history
            SET old_value_json = NULL, new_value_json = NULL, raw_values_erased_at = 1200
          WHERE operation_id = 'replacement-1'`
      )
    ).not.toThrow();
    pii.close();

    const db = new DatabaseSync(':memory:');
    db.exec(migration('migrations/lookup/001_pre_1_0_lookup_baseline.sql'));
    db.exec(
      `INSERT INTO lookup_identifier_replacements (
         replacement_id, tenant_id, account_id, index_kind, normalization_version,
         hmac_key_generation, old_virtual_bucket, old_blind_digest,
         new_virtual_bucket, new_blind_digest, gate_state, created_at, updated_at
       ) VALUES ('replacement-1', 'tenant-1', 'account-1', 'email_exact', 1, 1,
                 10, '${oldDigest}', 11, '${newDigest}', 'pending', 1000, 1000);`
    );
    const replacementSchema = String(
      db
        .prepare(
          `SELECT sql FROM sqlite_master
            WHERE type = 'table' AND name = 'lookup_identifier_replacements'`
        )
        .get()?.sql ?? ''
    ).toLowerCase();
    expect(replacementSchema).not.toContain('recent_reauth');
    expect(replacementSchema).not.toContain('otp_challenge');
    expect(replacementSchema).not.toContain('session_ref');
    expect(replacementSchema).toContain('blind_digest');
    db.close();
  });
  it('constrains Worker inventory drift evidence and resolution state', () => {
    const db = controlDatabase();
    expect(() =>
      db.exec(
        `INSERT INTO control_worker_inventory_drift_findings (
           finding_id, environment_id, worker_script_name, finding_kind, severity,
           redacted_details_json, first_observed_at, last_observed_at
         ) VALUES ('finding-invalid-json', 'env-1', 'test-extra', 'actual_only', 'warning',
                   '{', 10, 10);`
      )
    ).toThrow();
    expect(() =>
      db.exec(
        `INSERT INTO control_worker_inventory_drift_findings (
           finding_id, environment_id, worker_script_name, finding_kind, severity,
           first_observed_at, last_observed_at
         ) VALUES ('finding-invalid-time', 'env-1', 'test-extra', 'actual_only', 'warning',
                   20, 10);`
      )
    ).toThrow();
    db.exec(
      `INSERT INTO control_worker_inventory_drift_findings (
         finding_id, environment_id, worker_script_name, finding_kind, severity,
         first_observed_at, last_observed_at
       ) VALUES ('finding-1', 'env-1', 'test-extra', 'actual_only', 'warning', 10, 10);`
    );
    expect(() =>
      db.exec(
        `UPDATE control_worker_inventory_drift_findings
            SET review_state = 'resolved', notification_state = 'resolved'
          WHERE finding_id = 'finding-1';`
      )
    ).toThrow();
    db.exec(
      `UPDATE control_worker_inventory_drift_findings
          SET review_state = 'resolved', notification_state = 'resolved', resolved_at = 20
        WHERE finding_id = 'finding-1';`
    );
    db.close();
  });

  it('keeps external capability review evidence and Worker source ownership coherent', () => {
    const db = controlDatabase();
    expect(() =>
      db.exec(
        `INSERT INTO control_external_capability_sources (
           environment_id, source_kind, source_id, source_manifest_path, source_manifest_hash,
           capability_manifest_digest, aggregate_json, review_state,
           registered_by_operation_id, registered_at
         ) VALUES (
           'env-1', 'plugin_manifest', 'plugin-1', 'plugins/one/manifest.json',
           '${'a'.repeat(64)}', '${'b'.repeat(64)}', '{}', 'approved', 'op-1', 1
         );`
      )
    ).toThrow();
    db.exec(
      `INSERT INTO control_external_capability_sources (
         environment_id, source_kind, source_id, source_manifest_path, source_manifest_hash,
         capability_manifest_digest, aggregate_json, registered_by_operation_id, registered_at
       ) VALUES (
         'env-1', 'extension_manifest', 'extension-1', 'authrim.extension-capabilities.json',
         '${'a'.repeat(64)}', '${'b'.repeat(64)}', '{}', 'op-1', 1
       );
       INSERT INTO control_desired_worker_inventory (
         environment_id, worker_script_name, package_name, deployment_target,
         capability_manifest_digest, source_manifest_path, source_manifest_hash,
         generated_artifact_hash, source_kind, source_reference, status, review_state,
         registered_by_operation_id, registered_by, registered_at
       ) VALUES (
         'env-1', 'test-extension', 'extension:extension-1', 'extension',
         '${'b'.repeat(64)}', 'authrim.extension-capabilities.json', '${'a'.repeat(64)}',
         '${'c'.repeat(64)}', 'extension_manifest', 'extension:extension-1', 'active',
         'auto_registered', 'op-1', 'setup', 1
       );`
    );
    expect(() =>
      db.exec(
        `UPDATE control_desired_worker_inventory
            SET package_name = 'extension:attacker'
          WHERE worker_script_name = 'test-extension';`
      )
    ).toThrow('control_worker_inventory_source_ownership_immutable');
    db.close();
  });
});

describe('tenant and plugin outbox schemas', () => {
  it('keeps account routing and plugin delivery separate and fixes retention periods', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(migration('migrations/001_pre_1_0_core_baseline.sql'));
    db.exec(
      `INSERT INTO plugin_hook_outbox (
         outbox_id, tenant_id, plugin_installation_id, capability, event_type,
         event_version, idempotency_key, payload_json, created_at, updated_at
       ) VALUES ('outbox-1', 'tenant-1', 'plugin-1', 'after_create', 'account.created',
         1, 'idem-1', '{}', 1, 1);
       UPDATE plugin_hook_outbox
          SET status = 'locked', attempt_no = 1, claim_owner = 'runner-1',
              claim_token = 'claim-1', lease_until = 20, updated_at = 2
        WHERE outbox_id = 'outbox-1';
       UPDATE plugin_hook_outbox
          SET status = 'succeeded', claim_owner = NULL, claim_token = NULL,
              lease_until = NULL, succeeded_at = 10, delete_after = 604810, updated_at = 10
        WHERE outbox_id = 'outbox-1';`
    );
    db.exec(
      `INSERT INTO plugin_hook_outbox (
         outbox_id, tenant_id, plugin_installation_id, capability, event_type,
         event_version, idempotency_key, payload_json, created_at, updated_at
       ) VALUES ('outbox-2', 'tenant-1', 'plugin-1', 'after_create', 'account.created',
         1, 'idem-2', '{}', 1, 1);
       UPDATE plugin_hook_outbox
          SET status = 'locked', attempt_no = 1, claim_owner = 'runner-1',
              claim_token = 'claim-2', lease_until = 20, updated_at = 2
        WHERE outbox_id = 'outbox-2';`
    );
    expect(() =>
      db.exec(
        `UPDATE plugin_hook_outbox
            SET status = 'dead_letter', claim_owner = NULL, claim_token = NULL,
                lease_until = NULL, dead_lettered_at = 10, delete_after = 100, updated_at = 10
          WHERE outbox_id = 'outbox-2';`
      )
    ).toThrow();
    const outboxes = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%outbox'")
          .all() as Array<{ name: string }>
      ).map(({ name }) => name)
    );
    expect(outboxes.has('account_routing_outbox')).toBe(true);
    expect(outboxes.has('plugin_hook_outbox')).toBe(true);
    expect(outboxes.has('identifier_change_notification_outbox')).toBe(true);
    db.close();
  });

  it('enforces plugin outbox claim fencing and state transitions', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(migration('migrations/001_pre_1_0_core_baseline.sql'));
    db.exec(
      `INSERT INTO plugin_hook_outbox (
         outbox_id, tenant_id, plugin_installation_id, capability, event_type,
         event_version, idempotency_key, payload_json, created_at, updated_at
       ) VALUES (
         'outbox-claim', 'tenant-1', 'plugin-1', 'notifier.email', 'account.created',
         1, 'idem-claim', '{"account_ref":"account-1"}', 100, 100
       );`
    );
    expect(() =>
      db.exec(
        `UPDATE plugin_hook_outbox
            SET status = 'locked', claim_owner = 'runner-1', claim_token = 'claim-1',
                lease_until = 200, attempt_no = 2, updated_at = 101
          WHERE outbox_id = 'outbox-claim';`
      )
    ).toThrow();
    db.exec(
      `UPDATE plugin_hook_outbox
          SET status = 'locked', claim_owner = 'runner-1', claim_token = 'claim-1',
              lease_until = 200, attempt_no = 1, updated_at = 101
        WHERE outbox_id = 'outbox-claim';`
    );
    expect(() =>
      db.exec(
        `UPDATE plugin_hook_outbox
            SET claim_token = 'claim-2', updated_at = 102
          WHERE outbox_id = 'outbox-claim';`
      )
    ).toThrow();
    db.exec(
      `UPDATE plugin_hook_outbox
          SET lease_until = 210, updated_at = 102
        WHERE outbox_id = 'outbox-claim';
       UPDATE plugin_hook_outbox
          SET claim_owner = 'runner-2', claim_token = 'claim-2',
              lease_until = 250, attempt_no = 2, updated_at = 211
        WHERE outbox_id = 'outbox-claim';`
    );
    expect(
      db
        .prepare(
          `SELECT claim_owner, claim_token, attempt_no
             FROM plugin_hook_outbox WHERE outbox_id = 'outbox-claim'`
        )
        .get()
    ).toEqual({ claim_owner: 'runner-2', claim_token: 'claim-2', attempt_no: 2 });
    db.exec(
      `UPDATE plugin_hook_outbox
          SET status = 'waiting_retry', claim_owner = NULL, claim_token = NULL,
              lease_until = NULL, next_attempt_at = 300,
              last_error_code = 'provider_unavailable', updated_at = 102
        WHERE outbox_id = 'outbox-claim';`
    );
    expect(() =>
      db.exec(
        `UPDATE plugin_hook_outbox
            SET status = 'succeeded', next_attempt_at = NULL, succeeded_at = 103,
                delete_after = 604903, updated_at = 103
          WHERE outbox_id = 'outbox-claim';`
      )
    ).toThrow();
    db.close();
  });

  it('rejects overly broad plugin egress suffix wildcards', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(migration('migrations/plugin-runner/001_pre_1_0_plugin_runner_baseline.sql'));
    expect(() =>
      db.exec(
        `INSERT INTO plugin_runner_egress_allowed_hosts (
           plugin_id, rule_id, match_kind, host_pattern, created_at
         ) VALUES ('plugin-1', 'rule-1', 'suffix_wildcard', '*.com', 1);`
      )
    ).toThrow();
    db.exec(
      `INSERT INTO plugin_runner_egress_allowed_hosts (
         plugin_id, rule_id, match_kind, host_pattern, created_at
       ) VALUES ('plugin-1', 'rule-2', 'suffix_wildcard', '*.example.com', 1);`
    );
    db.close();
  });

  it('allows only one pending or running plugin sweep', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(migration('migrations/plugin-runner/001_pre_1_0_plugin_runner_baseline.sql'));
    db.exec(
      `INSERT INTO plugin_runner_full_sweep_state (
         sweep_id, state, active_sweep_key, created_at, updated_at
       ) VALUES ('sweep-1', 'pending', 'active', 1, 1);`
    );
    expect(() =>
      db.exec(
        `INSERT INTO plugin_runner_full_sweep_state (
           sweep_id, state, active_sweep_key, created_at, updated_at
         ) VALUES ('sweep-2', 'running', 'active', 2, 2);`
      )
    ).toThrow();
    expect(() =>
      db.exec(
        `UPDATE plugin_runner_full_sweep_state
            SET state = 'completed', completed_at = 2, updated_at = 2
          WHERE sweep_id = 'sweep-1';`
      )
    ).toThrow();
    db.exec(
      `UPDATE plugin_runner_full_sweep_state
          SET state = 'completed', active_sweep_key = 'sweep:sweep-1',
              completed_at = 2, updated_at = 2
        WHERE sweep_id = 'sweep-1';
       INSERT INTO plugin_runner_full_sweep_state (
         sweep_id, state, active_sweep_key, created_at, updated_at
       ) VALUES ('sweep-2', 'running', 'active', 2, 2);`
    );
    db.close();
  });
});
