import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyBootstrapAcceleratorProof } from '@authrim/ar-lib-core/control-plane';
import {
  assertInitialBootstrapBindingExecutionCanContinue,
  buildInitialControlTopologyRegistration,
  isInitialBootstrapHandoffAccepted,
  listInitialBootstrapReconciledWorkerVersions,
  reconcileInitialBootstrapHandoffAsOperator,
  recordInitialBootstrapWorkerEvidence,
  registerInitialControlTopology,
  requestInitialBootstrapAcceleration,
  waitForInitialBootstrapHandoff,
} from '../core/control-bootstrap-handoff.js';
import type { DeployResult } from '../core/deploy.js';
import type { AuthrimLock } from '../core/lock.js';
import type { ReleaseMigrationManifest } from '../core/release-migrations.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const checksum = (value: string) => value.repeat(64);

function release(): ReleaseMigrationManifest {
  return {
    formatVersion: 1,
    productVersion: '0.4.0',
    streams: [
      {
        id: 'd1-core',
        dialect: 'sqlite',
        logicalRoles: ['core'],
        files: [{ path: '001_core.sql', checksum: checksum('1') }],
      },
      {
        id: 'd1-pii',
        dialect: 'sqlite',
        logicalRoles: ['pii'],
        files: [{ path: '001_pii.sql', checksum: checksum('2') }],
      },
      {
        id: 'd1-lookup',
        dialect: 'sqlite',
        logicalRoles: ['lookup'],
        files: [{ path: '001_lookup.sql', checksum: checksum('3') }],
      },
    ],
  };
}

function lock(): AuthrimLock {
  return {
    version: '1',
    env: 'test',
    d1: {
      CONTROL_DB: { id: 'control-id', name: 'authrim-test-control' },
      LOOKUP_DB: { id: 'lookup-id', name: 'authrim-test-lookup' },
      TEST_TDB_DEFAULT_BOOTSTRAP_CORE: {
        id: 'default-id',
        name: 'test-authrim-tenant-default-bootstrap-db',
      },
      TEST_TDB_USERS_BOOTSTRAP_CORE: {
        id: 'users-id',
        name: 'test-authrim-tenant-users-bootstrap-db',
      },
      TEST_TDB_PII_BOOTSTRAP_PII: { id: 'pii-id', name: 'test-authrim-tenant-pii-bootstrap-db' },
    },
    kv: {},
    workers: {},
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
  } as AuthrimLock;
}

function database(manifestDigest: string): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(resolve(ROOT, 'migrations/control/001_control_plane.sql'), 'utf8'));
  db.exec(
    readFileSync(
      resolve(ROOT, 'migrations/control/010_bootstrap_handoff_worker_evidence.sql'),
      'utf8'
    )
  );
  db.exec(
    readFileSync(
      resolve(ROOT, 'migrations/control/015_bootstrap_worker_evidence_refresh.sql'),
      'utf8'
    )
  );
  db.exec(
    readFileSync(resolve(ROOT, 'migrations/control/006_tenant_default_allocations.sql'), 'utf8')
  );
  db.exec(
    readFileSync(resolve(ROOT, 'migrations/control/011_tenant_physical_isolation.sql'), 'utf8')
  );
  db.exec(
    `INSERT INTO control_environments (
       environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
     ) VALUES ('test', 'test', 'urn:authrim:control:test', 'creating', 1, 1);
     INSERT INTO control_environment_resource_policies (
       environment_id, max_concurrent_provisioning, max_ready_spares, max_d1_resources,
       daily_d1_create_budget, target_account_count, created_at, updated_at
     ) VALUES ('test', 2, 2, 1000, 20, 100000, 1, 1);
     INSERT INTO control_residency_partitions (
       environment_id, residency_policy_id, residency_partition, status, created_at, updated_at
     ) VALUES ('test', 'builtin:residency:default', 'default', 'active', 1, 1);
     INSERT INTO control_operations (
       operation_id, environment_id, operation_kind, idempotency_key, status,
       requested_by_type, attempt_count, created_at, completed_at, updated_at
     ) VALUES (
       'release-op', 'test', 'register_migration_release', 'release-v1', 'succeeded',
       'setup', 1, 1, 1, 1
     );
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
        '${checksum('4')}', 'ar-control.json', '${checksum('5')}', '${checksum('6')}',
        'core_manifest', 'ar-control.json', 'active', 'inventory-op', 'setup', 1),
       ('test', 'test-ar-management', '@authrim/ar-management', 'test-ar-management',
        '${checksum('7')}', 'ar-management.json', '${checksum('8')}', '${checksum('9')}',
        'core_manifest', 'ar-management.json', 'active', 'inventory-op', 'setup', 1);
     INSERT INTO control_migration_release_catalog (
       environment_id, stream_id, release_id, manifest_digest, manifest_r2_object_key,
       state, active_stream_key, registered_by_operation_id, registered_at, activated_at
     ) VALUES
       ('test', 'd1-core', '0.4.0', '${manifestDigest}',
        'releases/0.4.0/${manifestDigest}/manifest.json', 'active', 'active', 'release-op', 1, 1),
       ('test', 'd1-pii', '0.4.0', '${manifestDigest}',
        'releases/0.4.0/${manifestDigest}/manifest.json', 'active', 'active', 'release-op', 1, 1),
       ('test', 'd1-lookup', '0.4.0', '${manifestDigest}',
        'releases/0.4.0/${manifestDigest}/manifest.json', 'active', 'active', 'release-op', 1, 1);`
  );
  return db;
}

function deploymentResults(versionSuffix = 'v1'): DeployResult[] {
  return [
    {
      component: 'ar-control',
      workerName: 'test-ar-control',
      success: true,
      cloudflareVersionId: `control-${versionSuffix}`,
    },
    {
      component: 'ar-management',
      workerName: 'test-ar-management',
      success: true,
      cloudflareVersionId: `management-${versionSuffix}`,
    },
  ];
}

function bootstrapClient(versionSuffix = 'v1') {
  return {
    getWorkerSettings: async () => ({
      compatibility_date: '2026-07-30',
      bindings: [],
    }),
    listWorkerDeployments: async (scriptName: string) => [
      {
        id: `${scriptName}-deployment-${versionSuffix}`,
        created_on: '2026-07-30T00:00:00.000Z',
        source: 'api',
        strategy: 'percentage' as const,
        versions: [
          {
            percentage: 100,
            version_id: scriptName.endsWith('ar-control')
              ? `control-${versionSuffix}`
              : `management-${versionSuffix}`,
          },
        ],
      },
    ],
  };
}

const openDatabases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of openDatabases.splice(0)) db.close();
});

describe('initial Control topology handoff registration', () => {
  it('waits through transient binding propagation and cross-operation Worker lease contention', () => {
    expect(() =>
      assertInitialBootstrapBindingExecutionCanContinue({
        operationId: 'op-a',
        state: 'awaiting_smoke',
        errorCode: null,
        nextAttemptAt: null,
      })
    ).not.toThrow();
    expect(() =>
      assertInitialBootstrapBindingExecutionCanContinue({
        operationId: 'op-b',
        state: 'retry_required',
        errorCode: 'control_worker_patch_propagating',
        nextAttemptAt: 120,
      })
    ).not.toThrow();
    expect(() =>
      assertInitialBootstrapBindingExecutionCanContinue({
        operationId: 'op-c',
        state: 'lease_unavailable',
        errorCode: 'control_worker_deployment_lease_busy',
        nextAttemptAt: null,
      })
    ).not.toThrow();
  });

  it('fails closed for blocked or unexpected bootstrap binding results', () => {
    expect(() =>
      assertInitialBootstrapBindingExecutionCanContinue({
        operationId: 'op-a',
        state: 'blocked',
        errorCode: 'control_worker_binding_reconciliation_failed',
        nextAttemptAt: null,
      })
    ).toThrow('control_worker_binding_reconciliation_failed');
    expect(() =>
      assertInitialBootstrapBindingExecutionCanContinue({
        operationId: 'op-b',
        state: 'lease_unavailable',
        errorCode: 'unexpected_lease_failure',
        nextAttemptAt: null,
      })
    ).toThrow('unexpected_lease_failure');
  });

  it('registers exactly Lookup plus default/users/PII and 4096 Lookup buckets idempotently', async () => {
    const plan = await buildInitialControlTopologyRegistration({
      environmentId: 'test',
      tenantId: 'default',
      placementPolicy: 'tenant_exclusive',
      lock: lock(),
      release: release(),
      now: 100,
    });
    expect(plan.plans.map((entry) => entry.role)).toEqual([
      'lookup',
      'tenant_core/default',
      'tenant_core/users',
      'tenant_pii',
    ]);
    expect(plan.ownershipFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(plan.sql).toContain('tenant_default_67de978f01b15fe93148924d44ba9d6f');

    const db = database(plan.manifestDigest);
    openDatabases.push(db);
    const execute = async (_name: string, sql: string) => {
      db.exec(sql);
      return { success: true } as never;
    };
    const query = async (_name: string, sql: string) => db.prepare(sql).all() as never;
    const registration = {
      environmentId: 'test',
      tenantId: 'default',
      placementPolicy: 'tenant_exclusive',
      controlDatabaseName: 'control',
      lock: lock(),
      release: release(),
      now: 100,
      execute,
      query,
    };
    await expect(registerInitialControlTopology(registration)).resolves.toEqual({
      ownershipFingerprint: plan.ownershipFingerprint,
      manifestDigest: plan.manifestDigest,
    });
    db.exec(`
      INSERT INTO control_shard_capacity (
        shard_id, target_account_count, allocated_account_count,
        health_status, allocation_status, checked_at, updated_at
      )
      SELECT shard_id, 100000, 0, 'healthy', 'eligible', 100, 100
        FROM control_tenant_shards
       WHERE data_role = 'tenant_core/default';
    `);
    db.prepare(
      `UPDATE control_bootstrap_handoffs
          SET state = 'pending_verification', updated_at = 101
        WHERE environment_id = 'test'`
    ).run();
    await expect(registerInitialControlTopology(registration)).resolves.toEqual({
      ownershipFingerprint: plan.ownershipFingerprint,
      manifestDigest: plan.manifestDigest,
    });
    await expect(registerInitialControlTopology(registration)).resolves.toEqual({
      ownershipFingerprint: plan.ownershipFingerprint,
      manifestDigest: plan.manifestDigest,
    });
    expect(
      db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM control_desired_resources) AS resources,
             (SELECT COUNT(*) FROM control_tenant_shards) AS shards,
             (SELECT COUNT(*) FROM control_lookup_physical_shards) AS lookup_shards,
             (SELECT COUNT(*) FROM control_lookup_bucket_assignments) AS buckets,
             (SELECT COUNT(*) FROM control_tenant_shard_assignments
               WHERE tenant_id = 'default' AND assignment_state = 'active') AS assignments,
             (SELECT COUNT(*) FROM control_tenant_default_allocations
               WHERE tenant_id = 'default' AND reservation_state = 'committed'
                 AND capacity_counted_at IS NOT NULL) AS default_routes,
             (SELECT allocated_account_count FROM control_shard_capacity capacity
               JOIN control_tenant_shards shard ON shard.shard_id = capacity.shard_id
              WHERE shard.data_role = 'tenant_core/default') AS default_capacity,
             (SELECT COUNT(*) FROM control_tenant_database_migration_state
               WHERE state = 'ready') AS migrations`
        )
        .get()
    ).toEqual({
      resources: 4,
      shards: 3,
      lookup_shards: 1,
      buckets: 4096,
      assignments: 3,
      default_routes: 1,
      default_capacity: 1,
      migrations: 4,
    });
    expect(
      db
        .prepare(
          `SELECT isolation_policy, policy_state
             FROM control_tenant_placement_policies
            WHERE environment_id = 'test' AND tenant_id = 'default'`
        )
        .get()
    ).toEqual({ isolation_policy: 'tenant_exclusive', policy_state: 'active' });
    expect(
      db
        .prepare(
          `SELECT status, last_error_code, COUNT(*) AS count
             FROM control_operations
            WHERE operation_kind = 'provision_shard'
            GROUP BY status, last_error_code`
        )
        .get()
    ).toEqual({ status: 'blocked', last_error_code: 'operator_action_required', count: 3 });
    expect(
      db
        .prepare(
          `SELECT status, COUNT(*) AS count
             FROM control_operation_steps
            WHERE step_key = 'reconcile_worker_bindings'
            GROUP BY status`
        )
        .get()
    ).toEqual({ status: 'blocked', count: 3 });
    expect(
      db
        .prepare(
          `SELECT data_role, binding_ref, status, allocation_scope, owner_tenant_id
             FROM control_tenant_shards
            ORDER BY data_role`
        )
        .all()
    ).toEqual([
      {
        data_role: 'tenant_core/default',
        binding_ref: 'TEST_TDB_DEFAULT_BOOTSTRAP_CORE',
        status: 'ready',
        allocation_scope: 'tenant_exclusive',
        owner_tenant_id: 'default',
      },
      {
        data_role: 'tenant_core/users',
        binding_ref: 'TEST_TDB_USERS_BOOTSTRAP_CORE',
        status: 'ready',
        allocation_scope: 'tenant_exclusive',
        owner_tenant_id: 'default',
      },
      {
        data_role: 'tenant_pii',
        binding_ref: 'TEST_TDB_PII_BOOTSTRAP_PII',
        status: 'ready',
        allocation_scope: 'tenant_exclusive',
        owner_tenant_id: 'default',
      },
    ]);
  });

  it('registers shared-pool bootstrap shards as platform-owned and tenant-assigned', async () => {
    const plan = await buildInitialControlTopologyRegistration({
      environmentId: 'test',
      tenantId: 'default',
      placementPolicy: 'shared_pool',
      lock: lock(),
      release: release(),
      now: 100,
    });
    const db = database(plan.manifestDigest);
    openDatabases.push(db);
    const execute = async (_name: string, sql: string) => {
      db.exec(sql);
      return { success: true } as never;
    };
    const query = async (_name: string, sql: string) => db.prepare(sql).all() as never;

    await expect(
      registerInitialControlTopology({
        environmentId: 'test',
        tenantId: 'default',
        placementPolicy: 'shared_pool',
        controlDatabaseName: 'control',
        lock: lock(),
        release: release(),
        now: 100,
        execute,
        query,
      })
    ).resolves.toEqual({
      ownershipFingerprint: plan.ownershipFingerprint,
      manifestDigest: plan.manifestDigest,
    });
    expect(
      db
        .prepare(
          `SELECT shard.allocation_scope, shard.owner_tenant_id,
                  desired.resource_scope, desired.tenant_id, COUNT(*) AS count
             FROM control_tenant_shards shard
             JOIN control_desired_resources desired
               ON desired.desired_resource_id = shard.d1_desired_resource_id
            GROUP BY shard.allocation_scope, shard.owner_tenant_id,
                     desired.resource_scope, desired.tenant_id`
        )
        .get()
    ).toEqual({
      allocation_scope: 'shared_pool',
      owner_tenant_id: null,
      resource_scope: 'platform',
      tenant_id: null,
      count: 3,
    });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count
             FROM control_tenant_shard_assignments
            WHERE tenant_id = 'default' AND assignment_state = 'active'`
        )
        .get()
    ).toEqual({ count: 3 });
  });

  it('fails closed instead of reusing shared-pool resources as tenant-exclusive resources', async () => {
    const sharedPlan = await buildInitialControlTopologyRegistration({
      environmentId: 'test',
      tenantId: 'default',
      placementPolicy: 'shared_pool',
      lock: lock(),
      release: release(),
      now: 100,
    });
    const db = database(sharedPlan.manifestDigest);
    openDatabases.push(db);
    db.exec(sharedPlan.sql);

    await expect(
      registerInitialControlTopology({
        environmentId: 'test',
        tenantId: 'default',
        placementPolicy: 'tenant_exclusive',
        controlDatabaseName: 'control',
        lock: lock(),
        release: release(),
        now: 101,
        execute: async (_name, sql) => {
          db.exec(sql);
          return { success: true } as never;
        },
        query: async (_name, sql) => db.prepare(sql).all() as never,
      })
    ).rejects.toThrow('control_tenant_shard_owner_policy_invalid');
  });

  it('queues initial binding reconciliation when Automatic provisioning is enabled', async () => {
    const plan = await buildInitialControlTopologyRegistration({
      environmentId: 'test',
      tenantId: 'default',
      placementPolicy: 'tenant_exclusive',
      lock: lock(),
      release: release(),
      automaticProvisioning: true,
      now: 100,
    });
    const db = database(plan.manifestDigest);
    openDatabases.push(db);
    db.exec(plan.sql);

    expect(
      db
        .prepare(
          `SELECT status, last_error_code, COUNT(*) AS count
             FROM control_operations
            WHERE operation_kind = 'provision_shard'
            GROUP BY status, last_error_code`
        )
        .get()
    ).toEqual({ status: 'waiting_retry', last_error_code: null, count: 3 });
    expect(
      db
        .prepare(
          `SELECT status, COUNT(*) AS count
             FROM control_operation_steps
            WHERE step_key = 'reconcile_worker_bindings'
            GROUP BY status`
        )
        .get()
    ).toEqual({ status: 'queued', count: 3 });
  });

  it('fails closed when a required lock binding is absent', async () => {
    const incomplete = lock();
    delete incomplete.d1.TEST_TDB_USERS_BOOTSTRAP_CORE;
    await expect(
      buildInitialControlTopologyRegistration({
        environmentId: 'test',
        tenantId: 'default',
        placementPolicy: 'tenant_exclusive',
        lock: incomplete,
        release: release(),
      })
    ).rejects.toThrow('initial_control_plane_binding_missing:TEST_TDB_USERS_BOOTSTRAP_CORE');
  });

  it('rejects an invalid bootstrap tenant identifier before generating SQL', async () => {
    await expect(
      buildInitialControlTopologyRegistration({
        environmentId: 'test',
        tenantId: 'Other Tenant',
        placementPolicy: 'tenant_exclusive',
        lock: lock(),
        release: release(),
      })
    ).rejects.toThrow('control_bootstrap_tenant_id_invalid');
  });

  it('rejects a post-accept setup registration instead of reopening the handoff', async () => {
    const plan = await buildInitialControlTopologyRegistration({
      environmentId: 'test',
      tenantId: 'default',
      placementPolicy: 'tenant_exclusive',
      lock: lock(),
      release: release(),
      now: 100,
    });
    const db = database(plan.manifestDigest);
    openDatabases.push(db);
    db.exec(plan.sql);
    db.exec(
      `UPDATE control_bootstrap_handoffs
          SET state = 'accepted', verified_at = 101, accepted_at = 101 WHERE environment_id = 'test'`
    );
    await expect(
      registerInitialControlTopology({
        environmentId: 'test',
        tenantId: 'default',
        placementPolicy: 'tenant_exclusive',
        controlDatabaseName: 'control',
        lock: lock(),
        release: release(),
        now: 102,
        execute: async (_name, sql) => {
          db.exec(sql);
          return { success: true } as never;
        },
        query: async () =>
          db
            .prepare(
              `SELECT state, ownership_fingerprint, release_manifest_digest,
                      4 AS resource_count, 4 AS migration_count, 3 AS shard_count,
                      3 AS exclusive_shard_count, 1 AS placement_policy_count,
                      3 AS active_assignment_count,
                      1 AS lookup_count, 4096 AS bucket_count
                 FROM control_bootstrap_handoffs WHERE environment_id = 'test'`
            )
            .all() as never,
      })
    ).rejects.toThrow('control_bootstrap_topology_registration_mismatch');
    expect(
      db.prepare(`SELECT state FROM control_bootstrap_handoffs WHERE environment_id = 'test'`).get()
    ).toEqual({ state: 'accepted' });
  });

  it('records immutable exact Worker deployment evidence and resumes idempotently', async () => {
    const plan = await buildInitialControlTopologyRegistration({
      environmentId: 'test',
      tenantId: 'default',
      placementPolicy: 'tenant_exclusive',
      lock: lock(),
      release: release(),
      now: 100,
    });
    const db = database(plan.manifestDigest);
    openDatabases.push(db);
    db.exec(plan.sql);
    const execute = async (_name: string, sql: string) => {
      db.exec(sql);
      return { success: true } as never;
    };
    const query = async (_name: string, sql: string) => db.prepare(sql).all() as never;
    const input = {
      environmentId: 'test',
      controlDatabaseName: 'control',
      deployments: deploymentResults(),
      now: 101,
      accountId: 'account-id',
      token: 'workers-token',
      createClient: () => bootstrapClient(),
      execute,
      query,
    };

    await expect(recordInitialBootstrapWorkerEvidence(input)).resolves.toEqual({
      workerCount: 2,
      controlDeploymentId: 'test-ar-control-deployment-v1',
      controlVersionId: 'control-v1',
    });
    await expect(recordInitialBootstrapWorkerEvidence(input)).resolves.toEqual({
      workerCount: 2,
      controlDeploymentId: 'test-ar-control-deployment-v1',
      controlVersionId: 'control-v1',
    });
    expect(
      db
        .prepare(
          `SELECT worker_script_name, expected_version_id, state
             FROM control_bootstrap_worker_evidence ORDER BY worker_script_name`
        )
        .all()
    ).toEqual([
      {
        worker_script_name: 'test-ar-control',
        expected_version_id: 'control-v1',
        state: 'pending',
      },
      {
        worker_script_name: 'test-ar-management',
        expected_version_id: 'management-v1',
        state: 'pending',
      },
    ]);
  });

  it('accepts only a secret-triggered Control version chain after token registration', async () => {
    const plan = await buildInitialControlTopologyRegistration({
      environmentId: 'test',
      tenantId: 'default',
      placementPolicy: 'tenant_exclusive',
      lock: lock(),
      release: release(),
      now: 100,
    });
    const db = database(plan.manifestDigest);
    openDatabases.push(db);
    db.exec(plan.sql);
    const execute = async (_name: string, sql: string) => {
      db.exec(sql);
      return { success: true } as never;
    };
    const query = async (_name: string, sql: string) => db.prepare(sql).all() as never;
    const createClient = (triggeredBy: string) => ({
      getWorkerSettings: async () => ({ compatibility_date: '2026-07-30', bindings: [] }),
      listWorkerDeployments: async (scriptName: string) => {
        const baseVersion = scriptName.endsWith('ar-control') ? 'control-v1' : 'management-v1';
        const deployments = [
          {
            id: `${scriptName}-deployment-v1`,
            created_on: '2026-07-30T00:00:00.000Z',
            source: 'api',
            strategy: 'percentage' as const,
            annotations: { 'workers/triggered_by': 'deployment' },
            versions: [{ percentage: 100, version_id: baseVersion }],
          },
        ];
        if (scriptName.endsWith('ar-control')) {
          deployments.push({
            id: `${scriptName}-deployment-secret`,
            created_on: '2026-07-30T00:01:00.000Z',
            source: 'api',
            strategy: 'percentage' as const,
            annotations: { 'workers/triggered_by': triggeredBy },
            versions: [{ percentage: 100, version_id: 'control-secret-v2' }],
          });
        }
        return deployments;
      },
    });
    const input = {
      environmentId: 'test',
      controlDatabaseName: 'control',
      deployments: deploymentResults(),
      allowSecretTriggeredVersionAdvanceFor: ['test-ar-control'],
      now: 101,
      accountId: 'account-id',
      token: 'workers-token',
      execute,
      query,
    };

    await expect(
      recordInitialBootstrapWorkerEvidence({ ...input, createClient: () => createClient('secret') })
    ).resolves.toMatchObject({ controlVersionId: 'control-secret-v2' });
    await expect(
      recordInitialBootstrapWorkerEvidence({ ...input, createClient: () => createClient('upload') })
    ).rejects.toThrow('control_bootstrap_worker_version_mismatch:test-ar-control');
  });

  it('accepts only an exact Worker deployment recorded by a succeeded binding reconciliation', async () => {
    const plan = await buildInitialControlTopologyRegistration({
      environmentId: 'test',
      tenantId: 'default',
      placementPolicy: 'tenant_exclusive',
      lock: lock(),
      release: release(),
      now: 100,
    });
    const db = database(plan.manifestDigest);
    openDatabases.push(db);
    db.exec(plan.sql);
    const execute = async (_name: string, sql: string) => {
      db.exec(sql);
      return { success: true } as never;
    };
    const query = async (_name: string, sql: string) => db.prepare(sql).all() as never;
    const createClient = () => ({
      getWorkerSettings: async () => ({ compatibility_date: '2026-07-30', bindings: [] }),
      listWorkerDeployments: async (scriptName: string) => [
        {
          id: `${scriptName}-deployment-v1`,
          created_on: '2026-07-30T00:00:00.000Z',
          source: 'api',
          strategy: 'percentage' as const,
          versions: [
            {
              percentage: 100,
              version_id: scriptName.endsWith('ar-control') ? 'control-v1' : 'management-v1',
            },
          ],
        },
        ...(scriptName.endsWith('ar-control')
          ? [
              {
                id: 'test-ar-control-binding-deployment-v2',
                created_on: '2026-07-30T00:01:00.000Z',
                source: 'api',
                strategy: 'percentage' as const,
                versions: [{ percentage: 100, version_id: 'control-binding-v2' }],
              },
            ]
          : []),
      ],
    });
    const input = {
      environmentId: 'test',
      controlDatabaseName: 'control',
      deployments: deploymentResults(),
      now: 101,
      accountId: 'account-id',
      token: 'workers-token',
      createClient,
      execute,
      query,
    };

    await expect(recordInitialBootstrapWorkerEvidence(input)).rejects.toThrow(
      'control_bootstrap_worker_version_mismatch:test-ar-control'
    );
    db.exec(`
      INSERT INTO control_worker_binding_reconciliations (
        operation_id, environment_id, worker_script_name, shard_id, binding_ref,
        data_role, residency_partition, migration_generation, provider_database_id,
        state, expected_source_version_id, previous_deployment_id,
        patch_result_version_id, patch_result_deployment_id, previous_restore_settings_json,
        smoke_attempt_count, consecutive_smoke_successes, created_at, updated_at, completed_at
      )
      SELECT operation.operation_id, operation.environment_id, 'test-ar-control', shard.shard_id,
             shard.binding_ref, shard.data_role, shard.residency_partition, shard.generation,
             migration.provider_database_id, 'succeeded', 'control-v1',
             'test-ar-control-deployment-v1', 'control-binding-v2',
             'test-ar-control-binding-deployment-v2', '{}', 1, 3, 100, 101, 101
        FROM control_operations operation
        JOIN control_tenant_database_migration_state migration
          ON migration.operation_id = operation.operation_id
        JOIN control_tenant_shards shard
          ON shard.d1_desired_resource_id = migration.desired_resource_id
       WHERE operation.environment_id = 'test'
         AND operation.operation_kind = 'provision_shard'
       LIMIT 1;
    `);

    await expect(recordInitialBootstrapWorkerEvidence(input)).resolves.toMatchObject({
      controlDeploymentId: 'test-ar-control-binding-deployment-v2',
      controlVersionId: 'control-binding-v2',
    });
  });

  it('refreshes changed evidence before acceptance and rejects changes after acceptance', async () => {
    const plan = await buildInitialControlTopologyRegistration({
      environmentId: 'test',
      tenantId: 'default',
      placementPolicy: 'tenant_exclusive',
      lock: lock(),
      release: release(),
      now: 100,
    });
    const db = database(plan.manifestDigest);
    openDatabases.push(db);
    db.exec(plan.sql);
    const execute = async (_name: string, sql: string) => {
      db.exec(sql);
      return { success: true } as never;
    };
    const query = async (_name: string, sql: string) => db.prepare(sql).all() as never;
    const base = {
      environmentId: 'test',
      controlDatabaseName: 'control',
      now: 101,
      accountId: 'account-id',
      token: 'workers-token',
      execute,
      query,
    };
    await recordInitialBootstrapWorkerEvidence({
      ...base,
      deployments: deploymentResults(),
      createClient: () => bootstrapClient(),
    });
    await expect(
      recordInitialBootstrapWorkerEvidence({
        ...base,
        deployments: deploymentResults('v2'),
        createClient: () => bootstrapClient('v2'),
      })
    ).resolves.toEqual({
      workerCount: 2,
      controlDeploymentId: 'test-ar-control-deployment-v2',
      controlVersionId: 'control-v2',
    });
    expect(
      db
        .prepare(
          `SELECT worker_script_name, expected_version_id, state
             FROM control_bootstrap_worker_evidence ORDER BY worker_script_name`
        )
        .all()
    ).toEqual([
      {
        worker_script_name: 'test-ar-control',
        expected_version_id: 'control-v2',
        state: 'pending',
      },
      {
        worker_script_name: 'test-ar-management',
        expected_version_id: 'management-v2',
        state: 'pending',
      },
    ]);

    db.prepare(
      `UPDATE control_bootstrap_handoffs
          SET state = 'accepted', verified_at = 102, accepted_at = 102, updated_at = 102
        WHERE environment_id = 'test' AND state = 'pending_verification'`
    ).run();
    await expect(
      recordInitialBootstrapWorkerEvidence({
        ...base,
        deployments: deploymentResults('v3'),
        createClient: () => bootstrapClient('v3'),
      })
    ).rejects.toThrow('control_bootstrap_worker_evidence_reflection_mismatch');
    await expect(
      recordInitialBootstrapWorkerEvidence({
        ...base,
        deployments: [...deploymentResults(), deploymentResults()[0]!],
        createClient: () => bootstrapClient(),
      })
    ).rejects.toThrow('control_bootstrap_worker_deploy_result_duplicate:test-ar-control');
  });

  it('waits for Control acceptance and surfaces a stable blocked result', async () => {
    let time = 0;
    const progress: string[] = [];
    const states = [
      {
        state: 'pending_verification',
        verification_error_code: null,
        accepted_at: null,
        total_bindings: 2,
        pending_bindings: 2,
      },
      {
        state: 'accepted',
        verification_error_code: null,
        accepted_at: 200,
        total_bindings: 2,
        pending_bindings: 0,
      },
    ];
    await expect(
      waitForInitialBootstrapHandoff({
        environmentId: 'test',
        controlDatabaseName: 'control',
        query: async () => [states.shift()!] as never,
        now: () => time,
        sleep: async (milliseconds) => {
          time += milliseconds;
        },
        onProgress: (message) => progress.push(message),
        timeoutMs: 1_000,
        pollIntervalMs: 250,
      })
    ).resolves.toEqual({ state: 'accepted', acceptedAt: 200 });
    expect(progress).toEqual([
      'Control bootstrap verification progress: 0/2 binding checks complete (2 remaining)...',
    ]);

    await expect(
      waitForInitialBootstrapHandoff({
        environmentId: 'test',
        controlDatabaseName: 'control',
        query: async () =>
          [
            {
              state: 'blocked',
              verification_error_code: 'control_bootstrap_worker_binding_mismatch',
              accepted_at: null,
              total_bindings: 2,
              pending_bindings: 1,
            },
          ] as never,
      })
    ).rejects.toThrow(
      'control_bootstrap_handoff_blocked:control_bootstrap_worker_binding_mismatch'
    );
  });

  it('surfaces a failed binding immediately instead of waiting for the handoff timeout', async () => {
    await expect(
      waitForInitialBootstrapHandoff({
        environmentId: 'test',
        controlDatabaseName: 'control',
        query: async () =>
          [
            {
              state: 'creating',
              verification_error_code: null,
              accepted_at: null,
              total_bindings: 102,
              pending_bindings: 3,
              failed_bindings: 1,
              failed_binding_error_code: 'control_worker_settings_request_rejected',
              latest_binding_update: 200,
            },
          ] as never,
      })
    ).rejects.toThrow('control_bootstrap_binding_blocked:control_worker_settings_request_rejected');
  });

  it('extends a bounded wait while retryable binding work is still changing', async () => {
    let time = 0;
    let update = 1;
    await expect(
      waitForInitialBootstrapHandoff({
        environmentId: 'test',
        controlDatabaseName: 'control',
        timeoutMs: 2_000,
        stallTimeoutMs: 500,
        pollIntervalMs: 250,
        now: () => time,
        sleep: async (milliseconds) => {
          time += milliseconds;
          update += 1;
        },
        advanceBindings: async () => undefined,
        query: async () =>
          time < 1_250
            ? ([
                {
                  state: 'creating',
                  verification_error_code: null,
                  accepted_at: null,
                  total_bindings: 102,
                  pending_bindings: 3,
                  failed_bindings: 0,
                  failed_binding_error_code: null,
                  latest_binding_update: update,
                },
              ] as never)
            : ([
                {
                  state: 'accepted',
                  verification_error_code: null,
                  accepted_at: 300,
                  total_bindings: 102,
                  pending_bindings: 0,
                  failed_bindings: 0,
                  failed_binding_error_code: null,
                  latest_binding_update: update,
                },
              ] as never),
      })
    ).resolves.toEqual({ state: 'accepted', acceptedAt: 300 });
  });

  it('detects an already accepted handoff without mutating its evidence', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ state: 'accepted' }])
      .mockResolvedValueOnce([{ state: 'pending_verification' }]);

    await expect(
      isInitialBootstrapHandoffAccepted({
        environmentId: 'test',
        controlDatabaseName: 'control',
        query,
      })
    ).resolves.toBe(true);
    await expect(
      isInitialBootstrapHandoffAccepted({
        environmentId: 'test',
        controlDatabaseName: 'control',
        query,
      })
    ).resolves.toBe(false);
  });

  it('loads only Control-recorded binding reconciliation Worker versions', async () => {
    const query = vi.fn(async (_databaseName: string, sql: string) => {
      expect(sql).toContain(
        "state IN ('settings_patched', 'smoke_verifying', 'stabilizing', 'succeeded')"
      );
      return [
        {
          worker_script_name: 'test-ar-auth',
          patch_result_version_id: 'version-reconciled',
        },
      ];
    });

    await expect(
      listInitialBootstrapReconciledWorkerVersions({
        environmentId: 'test',
        controlDatabaseName: 'control',
        query,
      })
    ).resolves.toEqual(new Set(['test-ar-auth\0version-reconciled']));
  });

  it('advances bindings first and verifies only after every binding succeeds', async () => {
    const events: string[] = [];
    let time = 0;
    const states = [
      {
        state: 'pending_verification',
        verification_error_code: null,
        accepted_at: null,
        total_bindings: 2,
        pending_bindings: 2,
      },
      {
        state: 'pending_verification',
        verification_error_code: null,
        accepted_at: null,
        total_bindings: 2,
        pending_bindings: 0,
      },
      {
        state: 'pending_verification',
        verification_error_code: null,
        accepted_at: null,
        total_bindings: 2,
        pending_bindings: 0,
      },
      {
        state: 'accepted',
        verification_error_code: null,
        accepted_at: 200,
        total_bindings: 2,
        pending_bindings: 0,
      },
    ];

    await expect(
      waitForInitialBootstrapHandoff({
        environmentId: 'test',
        controlDatabaseName: 'control',
        advanceBindings: async () => {
          events.push('advance');
        },
        refreshEvidence: async () => {
          events.push('refresh');
        },
        reconcile: async () => {
          events.push('reconcile');
        },
        query: async () => {
          events.push('query');
          return [states.shift()!] as never;
        },
        now: () => time,
        sleep: async (milliseconds) => {
          events.push('sleep');
          time += milliseconds;
        },
        timeoutMs: 1_000,
        pollIntervalMs: 250,
      })
    ).resolves.toEqual({ state: 'accepted', acceptedAt: 200 });
    expect(events).toEqual([
      'advance',
      'query',
      'sleep',
      'advance',
      'query',
      'sleep',
      'advance',
      'query',
      'refresh',
      'reconcile',
      'sleep',
      'advance',
      'query',
    ]);
  });

  it('uses the Wrangler OAuth operator client for handoff reconciliation without a direct token', async () => {
    const createClient = vi.fn(async ({ expectedAccountId }: { expectedAccountId?: string }) => {
      expect(expectedAccountId).toBe('account-id');
      return {
        queryD1Batch: vi.fn(async () => [{ success: true, results: [], meta: {} }]),
      } as never;
    });

    await expect(
      reconcileInitialBootstrapHandoffAsOperator({
        accountId: 'account-id',
        controlDatabaseId: '11111111-1111-1111-1111-111111111111',
        createClient,
      })
    ).resolves.toEqual({ attempted: 0, accepted: 0, blocked: 0, retrying: 0 });
    expect(createClient).toHaveBeenCalledOnce();
  });

  it('sends a short-lived environment-bound proof to the internal accelerator route', async () => {
    const keysDir = await mkdtemp(join(tmpdir(), 'authrim-bootstrap-accelerator-'));
    try {
      const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
      if (!('privateKey' in pair)) throw new Error('expected_key_pair');
      const privateJwk = {
        ...(await crypto.subtle.exportKey('jwk', pair.privateKey)),
        kid: 'smoke-a',
        alg: 'EdDSA',
        use: 'sig',
      };
      const publicJwk = {
        ...(await crypto.subtle.exportKey('jwk', pair.publicKey)),
        kid: 'smoke-a',
        alg: 'EdDSA',
        use: 'sig',
      };
      await writeFile(
        join(keysDir, 'smoke_rpc_signing_jwk_slot_a.private.jwk.json'),
        JSON.stringify(privateJwk),
        'utf8'
      );
      const fetcher = vi.fn<typeof fetch>(async (input, init) => {
        expect(String(input)).toBe(
          'https://test.example.com/api/internal/control/bootstrap/advance'
        );
        expect(init?.method).toBe('POST');
        const authorization = new Headers(init?.headers).get('Authorization');
        expect(authorization).toMatch(/^Bearer /u);
        await expect(
          verifyBootstrapAcceleratorProof(authorization!.slice('Bearer '.length), {
            environmentId: 'test',
            publicJwk,
          })
        ).resolves.toMatchObject({
          purpose: 'initial_bootstrap_advance',
          environmentId: 'test',
        });
        return new Response(null, { status: 202 });
      });

      await expect(
        requestInitialBootstrapAcceleration({
          apiBaseUrl: 'https://test.example.com/',
          environmentId: 'test',
          keysDir,
          activeSlot: 'A',
          activeKeyId: 'smoke-a',
          fetch: fetcher,
        })
      ).resolves.toBe('accepted');
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      await rm(keysDir, { recursive: true, force: true });
    }
  });
});
