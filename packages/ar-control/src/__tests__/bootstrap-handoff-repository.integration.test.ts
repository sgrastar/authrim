import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { D1BootstrapHandoffRepository, type BootstrapHandoff } from '../bootstrap-handoff';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[]
  ) {}

  async all<T>() {
    return { success: true, results: this.statement.all(...this.values) as T[], meta: {} };
  }

  executeRun() {
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class PreparedStatement {
  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]): BoundStatement {
    return new BoundStatement(
      this.statement,
      values.map((value) => {
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          value === null ||
          value instanceof Uint8Array
        ) {
          return value;
        }
        throw new Error('unsupported_test_sqlite_value');
      })
    );
  }
}

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return new PreparedStatement(database.prepare(sql));
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

const handoff: BootstrapHandoff = {
  environmentId: 'test',
  environmentName: 'test',
  ownershipFingerprint: 'a'.repeat(64),
  releaseManifestDigest: 'b'.repeat(64),
  observedDeploymentId: 'deployment-control',
  observedVersionId: 'version-control',
};

describe('D1BootstrapHandoffRepository', () => {
  let database: DatabaseSync;
  let repository: D1BootstrapHandoffRepository;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/control/001_pre_1_0_control_baseline.sql'),
        'utf8'
      )
    );
    database.exec(
      `INSERT INTO control_environments (
         environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
       ) VALUES ('test', 'test', 'urn:authrim:control:test', 'creating', 1, 1);
       INSERT INTO control_operations (
         operation_id, environment_id, operation_kind, idempotency_key, status,
         requested_by_type, attempt_count, created_at, completed_at, updated_at
       ) VALUES (
         'inventory-op', 'test', 'register_worker_inventory', 'inventory-v1', 'succeeded',
         'setup', 1, 1, 1, 1
       );
       INSERT INTO control_desired_worker_inventory (
         environment_id, worker_script_name, package_name, deployment_target,
         capability_manifest_digest, source_manifest_path, source_manifest_hash,
         generated_artifact_hash, source_kind, source_reference, status,
         registered_by_operation_id, registered_by, registered_at
       ) VALUES
         ('test', 'test-ar-control', '@authrim/ar-control', 'test-ar-control',
          '${'c'.repeat(64)}', 'ar-control.json', '${'d'.repeat(64)}', '${'e'.repeat(64)}',
          'core_manifest', 'ar-control.json', 'active', 'inventory-op', 'setup', 1),
         ('test', 'test-ar-management', '@authrim/ar-management', 'test-ar-management',
          '${'f'.repeat(64)}', 'ar-management.json', '${'1'.repeat(64)}', '${'2'.repeat(64)}',
          'core_manifest', 'ar-management.json', 'active', 'inventory-op', 'setup', 1);
       INSERT INTO control_worker_required_data_roles (
         environment_id, worker_script_name, data_role, source_manifest_hash, updated_at
       ) VALUES
         ('test', 'test-ar-management', 'tenant_core/default', '${'1'.repeat(64)}', 1),
         ('test', 'test-ar-management', 'lookup', '${'1'.repeat(64)}', 1);
       INSERT INTO control_bootstrap_worker_evidence (
         environment_id, worker_script_name, expected_deployment_id, expected_version_id,
         expected_settings_digest, state, updated_at
       ) VALUES
         ('test', 'test-ar-control', 'deployment-control', 'version-control',
          '${'3'.repeat(64)}', 'pending', 1),
         ('test', 'test-ar-management', 'deployment-management', 'version-management',
          '${'4'.repeat(64)}', 'pending', 1);
       INSERT INTO control_bootstrap_handoffs (
         environment_id, state, ownership_fingerprint, release_manifest_digest,
         observed_deployment_id, observed_version_id, updated_at
       ) VALUES (
         'test', 'pending_verification', '${'a'.repeat(64)}', '${'b'.repeat(64)}',
         'deployment-control', 'version-control', 1
       );`
    );
    repository = new D1BootstrapHandoffRepository(d1(database));
  });

  afterEach(() => database.close());

  it('reads exact active inventory evidence and atomically accepts the handoff', async () => {
    await expect(repository.listPending(5)).resolves.toEqual([handoff]);
    await expect(repository.listWorkers('test')).resolves.toEqual([
      {
        workerScriptName: 'test-ar-control',
        expectedDeploymentId: 'deployment-control',
        expectedVersionId: 'version-control',
        expectedSettingsDigest: '3'.repeat(64),
        requiredDataRoles: [],
      },
      {
        workerScriptName: 'test-ar-management',
        expectedDeploymentId: 'deployment-management',
        expectedVersionId: 'version-management',
        expectedSettingsDigest: '4'.repeat(64),
        requiredDataRoles: ['lookup', 'tenant_core/default'],
      },
    ]);

    await repository.accept(
      handoff,
      [
        { workerScriptName: 'test-ar-control', settingsDigest: '3'.repeat(64) },
        { workerScriptName: 'test-ar-management', settingsDigest: '4'.repeat(64) },
      ],
      100
    );
    expect(
      database
        .prepare(
          `SELECT handoff.state, environment.lifecycle_state,
                  handoff.verified_at, handoff.accepted_at
             FROM control_bootstrap_handoffs handoff
             JOIN control_environments environment USING (environment_id)`
        )
        .get()
    ).toEqual({
      state: 'accepted',
      lifecycle_state: 'active',
      verified_at: 100,
      accepted_at: 100,
    });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM control_bootstrap_worker_evidence
            WHERE state = 'verified' AND observed_settings_digest = expected_settings_digest`
        )
        .get()
    ).toEqual({ count: 2 });
  });

  it('reads the exact active d1-core, d1-pii, and d1-lookup release streams', async () => {
    database.exec(
      `INSERT INTO control_migration_release_catalog (
         environment_id, stream_id, release_id, manifest_digest, manifest_r2_object_key,
         state, active_stream_key, registered_by_operation_id, registered_at, activated_at
       ) VALUES
         ('test', 'd1-core', 'release-v1', '${'b'.repeat(64)}',
          'releases/release-v1/${'b'.repeat(64)}/manifest.json',
          'active', 'active', 'inventory-op', 1, 1),
         ('test', 'd1-pii', 'release-v1', '${'b'.repeat(64)}',
          'releases/release-v1/${'b'.repeat(64)}/manifest.json',
          'active', 'active', 'inventory-op', 1, 1),
         ('test', 'd1-lookup', 'release-v1', '${'b'.repeat(64)}',
          'releases/release-v1/${'b'.repeat(64)}/manifest.json',
          'active', 'active', 'inventory-op', 1, 1);`
    );

    await expect(repository.listPinnedReleaseStreams('test', 'b'.repeat(64))).resolves.toEqual([
      {
        streamId: 'd1-core',
        releaseId: 'release-v1',
        manifestDigest: 'b'.repeat(64),
        state: 'active',
      },
      {
        streamId: 'd1-lookup',
        releaseId: 'release-v1',
        manifestDigest: 'b'.repeat(64),
        state: 'active',
      },
      {
        streamId: 'd1-pii',
        releaseId: 'release-v1',
        manifestDigest: 'b'.repeat(64),
        state: 'active',
      },
    ]);
  });

  it('projects platform Lookup and tenant-exclusive bootstrap ownership metadata', async () => {
    const manifestDigest = 'b'.repeat(64);
    const checksum = '5'.repeat(64);
    const lookupSpec = JSON.stringify({
      bootstrap: true,
      bootstrap_role: 'lookup',
      data_role: 'lookup',
      migration_stream_id: 'd1-lookup',
      release_id: 'release-v1',
      manifest_digest: manifestDigest,
      migration_files: [{ path: '001_lookup.sql', checksum }],
    });
    const tenantSpec = JSON.stringify({
      bootstrap: true,
      bootstrap_role: 'tenant_core/default',
      data_role: 'tenant_core/default',
      allocation_scope: 'tenant_exclusive',
      owner_tenant_id: 'default',
      migration_stream_id: 'd1-core',
      release_id: 'release-v1',
      manifest_digest: manifestDigest,
      migration_files: [{ path: '001_core.sql', checksum }],
    });
    database.exec(
      `INSERT INTO control_residency_partitions (
         environment_id, residency_policy_id, residency_partition, status, created_at, updated_at
       ) VALUES ('test', 'builtin:residency:default', 'default', 'active', 1, 1);
       INSERT INTO control_environment_resource_policies (
         environment_id, max_concurrent_provisioning, max_ready_spares, max_d1_resources,
         daily_d1_create_budget, target_account_count, created_at, updated_at
       ) VALUES ('test', 2, 2, 1000, 20, 100000, 1, 1);
       INSERT INTO control_operations (
         operation_id, environment_id, operation_kind, idempotency_key, status,
         requested_by_type, attempt_count, release_id, release_stream_id,
         release_manifest_digest, created_at, completed_at, updated_at
       ) VALUES (
         'bootstrap-op', 'test', 'provision_shard', 'bootstrap:default:v1', 'succeeded',
         'setup', 1, 'release-v1', 'd1-core', '${manifestDigest}', 1, 1, 1
       );
       INSERT INTO control_migration_release_catalog (
         environment_id, stream_id, release_id, manifest_digest, manifest_r2_object_key,
         state, active_stream_key, registered_by_operation_id, registered_at, activated_at
       ) VALUES (
         'test', 'd1-core', 'release-v1', '${manifestDigest}',
         'releases/release-v1/${manifestDigest}/manifest.json',
         'active', 'active', 'inventory-op', 1, 1
       );
       INSERT INTO control_operation_release_pins (
         operation_id, environment_id, stream_id, release_id, manifest_digest, pinned_at
       ) VALUES ('bootstrap-op', 'test', 'd1-core', 'release-v1', '${manifestDigest}', 1);
       INSERT INTO control_desired_resources (
         desired_resource_id, environment_id, resource_kind, logical_shard_id,
         resource_scope, tenant_id, deterministic_name, ownership_fingerprint,
         desired_state, provisioning_state, origin_operation_id, observed_resource_id,
         desired_spec_json, created_at, updated_at
       ) VALUES
         ('lookup-resource', 'test', 'd1', 'lookup-default', 'platform', NULL,
          'authrim-test-lookup', '${'6'.repeat(64)}', 'present', 'ready', 'inventory-op',
          'lookup-observed', '${lookupSpec.replaceAll("'", "''")}', 1, 1),
         ('tenant-resource', 'test', 'd1', 'tenant-default', 'tenant', 'default',
          'authrim-test-tenant-default', '${'7'.repeat(64)}', 'present', 'ready',
          'bootstrap-op', 'tenant-observed', '${tenantSpec.replaceAll("'", "''")}', 1, 1);
       INSERT INTO control_observed_resources (
         observed_resource_id, environment_id, desired_resource_id, provider_resource_id,
         provider_name, resource_kind, ownership_fingerprint, observed_state,
         observed_spec_json, observed_at
       ) VALUES
         ('lookup-observed', 'test', 'lookup-resource', 'lookup-db-id',
          'authrim-test-lookup', 'd1', '${'6'.repeat(64)}', 'present', '{}', 1),
         ('tenant-observed', 'test', 'tenant-resource', 'tenant-db-id',
          'authrim-test-tenant-default', 'd1', '${'7'.repeat(64)}', 'present', '{}', 1);
       INSERT INTO control_lookup_physical_shards (
         lookup_shard_id, environment_id, residency_partition, binding_ref,
         d1_desired_resource_id, status, created_at, updated_at
       ) VALUES ('lookup-shard', 'test', 'default', 'LOOKUP_DB', 'lookup-resource', 'ready', 1, 1);
       INSERT INTO control_tenant_placement_policies (
         environment_id, tenant_id, isolation_policy, policy_generation, policy_state,
         source_operation_id, idempotency_key, activated_at, created_at, updated_at
       ) VALUES (
         'test', 'default', 'tenant_exclusive', 1, 'active', 'bootstrap-op',
         'bootstrap:placement:default:v1', 1, 1, 1
       );
       INSERT INTO control_tenant_shards (
         shard_id, environment_id, data_role, residency_policy_id, residency_partition,
         generation, logical_shard_id, binding_ref, d1_desired_resource_id,
         read_replication_mode, observed_replication_state, status,
         allocation_scope, owner_tenant_id, created_at, updated_at
       ) VALUES (
         'tenant-shard', 'test', 'tenant_core/default', 'builtin:residency:default', 'default',
         1, 'tenant-default', 'TDB_DEFAULT_BOOTSTRAP_CORE', 'tenant-resource',
         'disabled', 'disabled', 'active', 'tenant_exclusive', 'default', 1, 1
       );
       INSERT INTO control_shard_capacity (
         shard_id, target_account_count, allocated_account_count, health_status,
         allocation_status, updated_at
       ) VALUES ('tenant-shard', 100000, 0, 'healthy', 'eligible', 1);
       INSERT INTO control_tenant_shard_assignments (
         environment_id, tenant_id, data_role, residency_policy_id, residency_partition,
         shard_id, assignment_generation, assignment_state, source_operation_id,
         created_at, activated_at, updated_at
       ) VALUES (
         'test', 'default', 'tenant_core/default', 'builtin:residency:default', 'default',
         'tenant-shard', 1, 'active', 'bootstrap-op', 1, 1, 1
       );
       INSERT INTO control_tenant_database_migration_state (
         desired_resource_id, environment_id, operation_id, stream_id, release_id,
         manifest_digest, provider_database_id, state, expected_file_count,
         applied_file_count, last_filename, observed_sentinel_json,
         started_at, completed_at, updated_at
       ) VALUES (
         'tenant-resource', 'test', 'bootstrap-op', 'd1-core', 'release-v1',
         '${manifestDigest}', 'tenant-db-id', 'ready', 1, 1, '001_core.sql', '{}', 1, 1, 1
       );`
    );

    const resources = await repository.listResources('test');

    expect(resources).toHaveLength(2);
    expect(resources.find((resource) => resource.role === 'lookup')).toMatchObject({
      providerDatabaseId: 'lookup-db-id',
      desiredResourceScope: 'platform',
      desiredTenantId: null,
      allocationScope: null,
      ownerTenantId: null,
      assignmentCount: 0,
      placementIsolationPolicy: null,
    });
    expect(resources.find((resource) => resource.role === 'tenant_core/default')).toMatchObject({
      providerDatabaseId: 'tenant-db-id',
      desiredResourceScope: 'tenant',
      desiredTenantId: 'default',
      allocationScope: 'tenant_exclusive',
      ownerTenantId: 'default',
      assignmentCount: 1,
      assignmentTenantId: 'default',
      assignmentState: 'active',
      placementIsolationPolicy: 'tenant_exclusive',
      placementPolicyState: 'active',
      shardStatus: 'active',
      capacityHealthStatus: 'healthy',
    });
  });

  it('rejects incomplete observations and freezes expectations after acceptance', async () => {
    await expect(
      repository.accept(
        handoff,
        [{ workerScriptName: 'test-ar-control', settingsDigest: '3'.repeat(64) }],
        100
      )
    ).rejects.toThrow('control_bootstrap_accept_conflict');
    expect(
      database
        .prepare('SELECT state FROM control_bootstrap_handoffs WHERE environment_id = ?')
        .get('test')
    ).toEqual({ state: 'pending_verification' });
    database
      .prepare(
        `UPDATE control_bootstrap_handoffs
            SET state = 'accepted', verified_at = 101, accepted_at = 101, updated_at = 101
          WHERE environment_id = 'test'`
      )
      .run();
    expect(() =>
      database
        .prepare(
          `UPDATE control_bootstrap_worker_evidence SET expected_version_id = 'tampered'
            WHERE environment_id = 'test' AND worker_script_name = 'test-ar-control'`
        )
        .run()
    ).toThrow('control_bootstrap_worker_evidence_immutable');
  });

  it('records only a stable redacted error code when verification blocks', async () => {
    await repository.block(handoff, 'control_bootstrap_worker_binding_mismatch', 200);
    expect(
      database
        .prepare(
          `SELECT state, verification_error_code FROM control_bootstrap_handoffs
            WHERE environment_id = 'test'`
        )
        .get()
    ).toEqual({
      state: 'blocked',
      verification_error_code: 'control_bootstrap_worker_binding_mismatch',
    });
    const audit = database
      .prepare(
        `SELECT redacted_payload_json FROM control_audit_events
          WHERE event_type = 'control.bootstrap_handoff.blocked'`
      )
      .get() as { redacted_payload_json: string };
    expect(JSON.parse(audit.redacted_payload_json)).toEqual({
      error_code: 'control_bootstrap_worker_binding_mismatch',
    });
    await expect(repository.block(handoff, 'Bearer secret', 201)).rejects.toThrow(
      'control_bootstrap_error_code_invalid'
    );
  });
});
