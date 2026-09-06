import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  CloudflareControlApiError,
  buildTenantRuntimeRegistryGenerationKey,
  buildTenantRuntimeRegistrySnapshotKey,
  signTenantRuntimeRegistrySnapshot,
  type CloudflareWorkerSettings,
  type TenantRuntimeRegistrySnapshot,
} from '@authrim/ar-lib-core';
import type { JWK } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { D1ShardCleanupRepository } from '../shard-cleanup-repository';
import { ShardCleanupService } from '../shard-cleanup';

type SqliteValue = string | number | null | Uint8Array;
type TestJwk = JWK & { kty: string };
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const START = 1_800_000_000;

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqliteValue[]
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
    return this.executeRun();
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

function applyControlMigrations(database: DatabaseSync): void {
  const directory = resolve(REPO_ROOT, 'migrations/control/d1');
  for (const filename of readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    database.exec(readFileSync(resolve(directory, filename), 'utf8'));
  }
}

function seedRetiredShard(database: DatabaseSync): void {
  const hash = 'a'.repeat(64);
  database.exec(`
    INSERT INTO control_environments (
      environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
    ) VALUES ('env-test', 'test', 'urn:authrim:control:env-test', 'active', 1, 1);
    INSERT INTO control_operations (
      operation_id, environment_id, operation_kind, idempotency_key, status,
      requested_by_type, requested_by_id, attempt_count, created_at, completed_at, updated_at
    ) VALUES (
      'seed-op', 'env-test', 'provision_shard', 'seed', 'succeeded',
      'setup', 'setup', 1, 1, 1, 1
    );
    INSERT INTO control_residency_partitions (
      environment_id, residency_policy_id, residency_partition, status, created_at, updated_at
    ) VALUES ('env-test', 'default-policy', 'default', 'active', 1, 1);
    INSERT INTO control_environment_resource_policies (
      environment_id, max_concurrent_provisioning, max_ready_spares, max_d1_resources,
      daily_d1_create_budget, target_account_count, created_at, updated_at
    ) VALUES ('env-test', 2, 2, 100, 20, 100000, 1, 1);
    INSERT INTO control_tenant_placement_policies (
      environment_id, tenant_id, isolation_policy, policy_generation, policy_state,
      source_operation_id, idempotency_key, activated_at, created_at, updated_at
    ) VALUES (
      'env-test', 'tenant-a', 'shared_pool', 1, 'active',
      'seed-op', 'placement-a', 1, 1, 1
    );
    INSERT INTO control_desired_resources (
      desired_resource_id, environment_id, resource_kind, logical_shard_id,
      deterministic_name, ownership_fingerprint, provisioning_state,
      origin_operation_id, desired_spec_json, created_at, updated_at
    ) VALUES (
      'resource-retired', 'env-test', 'd1', 'retired-default',
      'test-retired-default', '${hash}', 'creating', 'seed-op', '{}', 1, 1
    );
    INSERT INTO control_observed_resources (
      observed_resource_id, environment_id, desired_resource_id, provider_resource_id,
      provider_name, resource_kind, ownership_fingerprint, observed_state,
      observed_spec_json, observed_at
    ) VALUES (
      'observed-retired', 'env-test', 'resource-retired', 'database-retired',
      'test-retired-default', 'd1', '${hash}', 'present', '{}', 1
    );
    UPDATE control_desired_resources
       SET observed_resource_id = 'observed-retired', provisioning_state = 'active'
      WHERE desired_resource_id = 'resource-retired';
    INSERT INTO control_tenant_shards (
      shard_id, environment_id, data_role, residency_policy_id, residency_partition,
      generation, logical_shard_id, binding_ref, d1_desired_resource_id,
      status, created_at, updated_at
    ) VALUES (
      'retired-default', 'env-test', 'tenant_core/default', 'default-policy', 'default',
      3, 'retired-default', 'TDB_RETIRED_DEFAULT', 'resource-retired',
      'active', 1, 1
    );
    INSERT INTO control_shard_capacity (
      shard_id, target_account_count, allocated_account_count,
      health_status, allocation_status, updated_at
    ) VALUES ('retired-default', 100000, 0, 'healthy', 'draining', 1);
    INSERT INTO control_tenant_shard_assignments (
      environment_id, tenant_id, data_role, residency_policy_id, residency_partition,
      shard_id, assignment_generation, assignment_state, source_operation_id,
      created_at, activated_at, updated_at
    ) VALUES (
      'env-test', 'tenant-a', 'tenant_core/default', 'default-policy', 'default',
      'retired-default', 1, 'active', 'seed-op', 1, 1, 1
    );
    INSERT INTO control_runtime_registry_routes (
      environment_id, tenant_id, route_generation, tenant_lifecycle_generation,
      quarantine_deny_generation, registry_publication_generation,
      tenant_lifecycle_state, route_status, residency_policy_id,
      route_projection_json, source_operation_id, created_at, updated_at
    ) VALUES (
      'env-test', 'tenant-a', 4, 1, 0, 9, 'active', 'active', 'default-policy',
      '{"targets":[{"shardId":"replacement-default"}]}', 'seed-op', 1, 1
    );
    INSERT INTO control_desired_worker_inventory (
      environment_id, worker_script_name, package_name, deployment_target,
      capability_manifest_digest, source_manifest_path, source_manifest_hash,
      generated_artifact_hash, source_kind, source_reference,
      registered_by_operation_id, registered_by, registered_at
    ) VALUES (
      'env-test', 'test-ar-auth', '@authrim/ar-auth', 'test-ar-auth',
      '${hash}', 'packages/ar-auth/authrim.capabilities.json', '${hash}', '${hash}',
      'core_manifest', 'packages/ar-auth', 'seed-op', 'setup', 1
    );
    INSERT INTO control_worker_required_data_roles (
      environment_id, worker_script_name, data_role, source_manifest_hash, updated_at
    ) VALUES ('env-test', 'test-ar-auth', 'tenant_core/default', '${hash}', 1);
    UPDATE control_tenant_shard_assignments
       SET assignment_state = 'retired', activated_at = NULL, retired_at = 2, updated_at = 2
     WHERE shard_id = 'retired-default';
    UPDATE control_tenant_shards SET status = 'retired', updated_at = 2
     WHERE shard_id = 'retired-default';
  `);
}

async function signingKeys(kid = 'cleanup-key') {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  if (!('privateKey' in pair)) throw new Error('expected_ed25519_key_pair');
  const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as TestJwk;
  const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as TestJwk;
  Object.assign(privateJwk, { kid, alg: 'EdDSA', use: 'sig' });
  Object.assign(publicJwk, { kid, alg: 'EdDSA', use: 'sig' });
  return { privateJwk, publicJwk, kid };
}

async function registryDocuments(input: {
  privateJwk: TestJwk;
  kid: string;
  publishedAt: number;
  runtimeGeneration?: number;
  includeRetiredShard?: boolean;
}) {
  const runtimeGeneration = input.runtimeGeneration ?? 10;
  const publishedAt = new Date(input.publishedAt * 1000).toISOString();
  const expiresAt = new Date((input.publishedAt + 1800) * 1000).toISOString();
  const snapshot: TenantRuntimeRegistrySnapshot = {
    version: 4,
    tenantId: 'tenant-a',
    snapshotScope: 'tenant',
    deploymentTarget: 'default',
    runtimeGeneration,
    routeStatus: 'active',
    quarantineDenyGeneration: 0,
    backend: { provider: 'd1', resolver: 'control-plane' },
    placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 1 },
    publishedAt,
    expiresAt,
    stores: [
      {
        tenantId: 'tenant-a',
        role: 'tenant_core',
        dataRole: 'tenant_core/default',
        residencyPolicyId: 'default-policy',
        residencyPartition: 'default',
        shardId: input.includeRetiredShard ? 'retired-default' : 'replacement-default',
        assignmentGeneration: 1,
        bindingRouteGeneration: 4,
        placementPolicyGeneration: 1,
        allocationScope: 'tenant_exclusive',
        ownerTenantId: 'tenant-a',
        generation: 4,
        runtimeGeneration,
        schemaVersion: 1,
        shardGroup: 'default',
        shardIndex: 0,
        shardCount: 1,
        shardKeyStrategy: 'fixed',
        provider: 'd1',
        driver: 'd1',
        bindingRef: input.includeRetiredShard ? 'TDB_RETIRED_DEFAULT' : 'TDB_REPLACEMENT_DEFAULT',
        connectionRef: null,
        deploymentTarget: 'default',
        status: 'active',
        healthStatus: 'active',
        databaseId: input.includeRetiredShard ? 'database-retired' : 'database-replacement',
        databaseName: input.includeRetiredShard
          ? 'test-retired-default'
          : 'test-replacement-default',
        regionHint: null,
        jurisdiction: null,
      },
    ],
    metadata: {
      storeCount: 1,
      roles: ['tenant_core'],
      signature: null,
      signatureKeyId: null,
    },
  };
  const signed = await signTenantRuntimeRegistrySnapshot(
    snapshot,
    { privateJwk: input.privateJwk, keyId: input.kid },
    publishedAt
  );
  return {
    snapshot: JSON.stringify(signed),
    generation: JSON.stringify({
      runtimeGeneration,
      routeStatus: 'active',
      quarantineDenyGeneration: 0,
      publishedAt,
      expiresAt: new Date((input.publishedAt + 7 * 86400) * 1000).toISOString(),
    }),
  };
}

function quarantineRequest(idempotencyKey = 'quarantine-retired-default') {
  return {
    shardId: 'retired-default',
    requestedById: 'admin-a',
    reasonCode: 'operator_quarantine' as const,
    idempotencyKey,
  };
}

type CleanupFailureMode =
  | 'none'
  | 'patch_before_mutation'
  | 'patch_after_mutation'
  | 'concurrent_deployment'
  | 'delete_after_mutation';

type CleanupBindingMode = 'present' | 'absent' | 'wrong_name';

async function cleanupHarness(
  repository: D1ShardCleanupRepository,
  options: {
    destructiveOperationsEnabled?: boolean;
    failureMode?: CleanupFailureMode;
    bindingMode?: CleanupBindingMode;
  } = {}
) {
  const keys = await signingKeys();
  let now = START;
  let documents = await registryDocuments({
    privateJwk: keys.privateJwk,
    kid: keys.kid,
    publishedAt: now,
  });
  let deploymentState: 'old' | 'cleanup' | 'concurrent' = 'old';
  let databaseExists = true;
  let patchAttempts = 0;
  let deleteAttempts = 0;
  const oldDeployment = {
    id: 'deployment-old',
    created_on: '2027-01-15T08:00:00.000Z',
    source: 'api',
    strategy: 'percentage' as const,
    versions: [{ percentage: 100, version_id: 'version-old' }],
  };
  const cleanupDeployment = {
    id: 'deployment-cleanup',
    created_on: '2027-01-15T08:00:01.000Z',
    source: 'api',
    strategy: 'percentage' as const,
    versions: [{ percentage: 100, version_id: 'version-cleanup' }],
  };
  const concurrentDeployment = {
    id: 'deployment-concurrent',
    created_on: '2027-01-15T08:00:02.000Z',
    source: 'api',
    strategy: 'percentage' as const,
    versions: [{ percentage: 100, version_id: 'version-concurrent' }],
  };
  const beforeSettings: CloudflareWorkerSettings = {
    bindings: [
      { name: 'TDB_RETIRED_DEFAULT', type: 'd1', database_id: 'database-retired' },
      { name: 'AUTHRIM_CONTROL', type: 'service', service: 'test-ar-control' },
    ],
    compatibility_date: '2026-07-01',
    observability: { enabled: true },
  };
  const afterSettings: CloudflareWorkerSettings = {
    ...beforeSettings,
    bindings: [{ name: 'AUTHRIM_CONTROL', type: 'service', service: 'test-ar-control' }],
  };
  const initialSettings: CloudflareWorkerSettings =
    options.bindingMode === 'absent'
      ? afterSettings
      : options.bindingMode === 'wrong_name'
        ? {
            ...beforeSettings,
            bindings: [
              { name: 'UNEXPECTED_D1', type: 'd1', database_id: 'database-retired' },
              { name: 'AUTHRIM_CONTROL', type: 'service', service: 'test-ar-control' },
            ],
          }
        : beforeSettings;
  const workers = {
    listWorkerDeployments: vi.fn(async () => {
      if (deploymentState === 'concurrent') {
        return [concurrentDeployment, cleanupDeployment, oldDeployment];
      }
      return deploymentState === 'cleanup' ? [cleanupDeployment, oldDeployment] : [oldDeployment];
    }),
    getWorkerSettings: vi.fn(async () =>
      deploymentState === 'old' ? initialSettings : afterSettings
    ),
    patchWorkerSettings: vi.fn(async () => {
      patchAttempts += 1;
      if (options.failureMode === 'patch_before_mutation' && patchAttempts === 1) {
        throw new CloudflareControlApiError('workers.settings.patch', 502);
      }
      deploymentState = options.failureMode === 'concurrent_deployment' ? 'concurrent' : 'cleanup';
      if (options.failureMode === 'patch_after_mutation' && patchAttempts === 1) {
        throw new CloudflareControlApiError('workers.settings.patch', 502);
      }
      return afterSettings;
    }),
  };
  const d1Api = {
    getD1Database: vi.fn(async () => {
      if (!databaseExists) throw new CloudflareControlApiError('d1.get', 404);
      return { uuid: 'database-retired', name: 'test-retired-default' };
    }),
    deleteD1Database: vi.fn(async () => {
      deleteAttempts += 1;
      databaseExists = false;
      if (options.failureMode === 'delete_after_mutation' && deleteAttempts === 1) {
        throw new CloudflareControlApiError('d1.delete', 502);
      }
    }),
  };
  const service = new ShardCleanupService({
    repository,
    d1: d1Api,
    workers,
    registry: {
      get: async (key: string) =>
        key === buildTenantRuntimeRegistrySnapshotKey('tenant-a', 'default')
          ? documents.snapshot
          : documents.generation,
    },
    registryVerificationKeys: [{ publicJwk: keys.publicJwk, keyId: keys.kid }],
    deploymentTarget: 'default',
    destructiveOperationsEnabled: options.destructiveOperationsEnabled ?? true,
    now: () => now,
  });

  return {
    service,
    workers,
    d1Api,
    get databaseExists() {
      return databaseExists;
    },
    async advance(seconds: number) {
      now += seconds;
      documents = await registryDocuments({
        privateJwk: keys.privateJwk,
        kid: keys.kid,
        publishedAt: now - 5,
        runtimeGeneration: 11,
      });
    },
    async approve() {
      const quarantine = await service.quarantine('env-test', quarantineRequest());
      await service.reconcile();
      await this.advance(1800);
      await service.reconcile();
      return service.approveCleanup('env-test', {
        quarantineOperationId: quarantine.quarantineOperationId ?? '',
        requestedById: 'admin-a',
        reasonCode: 'operator_approve_cleanup',
        idempotencyKey: 'approve-cleanup-1',
        confirmation: 'DELETE_RETIRED_TENANT_SHARD',
        exportMode: 'skipped',
        exportEvidenceId: null,
        deleteDatabase: true,
      });
    },
  };
}

describe('retired shard quarantine and cleanup', () => {
  let database: DatabaseSync;
  let repository: D1ShardCleanupRepository;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    applyControlMigrations(database);
    seedRetiredShard(database);
    repository = new D1ShardCleanupRepository(d1(database));
  });

  afterEach(() => database.close());

  it('atomically disables allocation and prevents route or assignment resurrection', async () => {
    await repository.startQuarantine({
      environmentId: 'env-test',
      operationId: 'quarantine-op',
      request: quarantineRequest(),
      now: START,
    });

    expect(
      database
        .prepare(
          `SELECT shard.quarantine_state, capacity.allocation_status
             FROM control_tenant_shards shard
             JOIN control_shard_capacity capacity ON capacity.shard_id = shard.shard_id
            WHERE shard.shard_id = 'retired-default'`
        )
        .get()
    ).toEqual({ quarantine_state: 'quarantining', allocation_status: 'blocked' });

    expect(() =>
      database.exec(
        `UPDATE control_tenant_shard_assignments
            SET assignment_state = 'active', activated_at = 3, retired_at = NULL
          WHERE shard_id = 'retired-default'`
      )
    ).toThrow('control_shard_quarantine_allocation_forbidden');
    expect(() =>
      database.exec(
        `UPDATE control_runtime_registry_routes
            SET route_projection_json = '{"target":{"shardId":"retired-default"}}'
          WHERE environment_id = 'env-test' AND tenant_id = 'tenant-a'`
      )
    ).toThrow('control_shard_quarantine_runtime_route_forbidden');
  });

  it('quarantines an unreferenced failed pre-activation shard through the same drain gate', async () => {
    database.exec(`
      DELETE FROM control_tenant_shard_assignments WHERE shard_id = 'retired-default';
      UPDATE control_tenant_shards
         SET status = 'failed', updated_at = 3
       WHERE shard_id = 'retired-default';
      UPDATE control_shard_capacity
         SET health_status = 'unavailable', allocation_status = 'blocked', updated_at = 3
       WHERE shard_id = 'retired-default';
    `);
    let now = START;
    const service = new ShardCleanupService({
      repository,
      d1: { getD1Database: vi.fn(), deleteD1Database: vi.fn() },
      workers: {
        getWorkerSettings: vi.fn(),
        patchWorkerSettings: vi.fn(),
        listWorkerDeployments: vi.fn(),
      },
      destructiveOperationsEnabled: false,
      now: () => now,
    });

    await expect(service.list('env-test')).resolves.toEqual([
      expect.objectContaining({
        shardId: 'retired-default',
        shardStatus: 'failed',
        availableActions: ['quarantine'],
      }),
    ]);
    const started = await service.quarantine('env-test', quarantineRequest());
    expect(started).toMatchObject({
      shardStatus: 'failed',
      quarantineState: 'quarantining',
      quarantineOperationState: 'draining',
    });
    await expect(service.reconcile()).resolves.toMatchObject({
      quarantineAttempted: 1,
      waitingRetry: 1,
    });

    now += 1800;
    await expect(service.reconcile()).resolves.toMatchObject({
      quarantineAttempted: 1,
      quarantineReady: 1,
    });
    const ready = await service.get('env-test', 'retired-default');
    expect(ready).toMatchObject({
      shardStatus: 'failed',
      quarantineState: 'quarantined',
      quarantineOperationState: 'ready_for_cleanup',
      availableActions: ['approve_cleanup'],
    });
    await expect(
      service.approveCleanup('env-test', {
        quarantineOperationId: ready?.quarantineOperationId ?? '',
        requestedById: 'admin-a',
        reasonCode: 'operator_approve_cleanup',
        idempotencyKey: 'approve-failed-cleanup-1',
        confirmation: 'DELETE_RETIRED_TENANT_SHARD',
        exportMode: 'skipped',
        exportEvidenceId: null,
        deleteDatabase: true,
      })
    ).resolves.toMatchObject({
      shardStatus: 'failed',
      cleanupState: 'blocked',
      lastErrorCode: 'control_destructive_operations_disabled',
    });
  });

  it('rejects a failed shard with an active reference without leaving a partial operation', async () => {
    database.exec(`
      UPDATE control_tenant_shard_assignments
         SET assignment_state = 'active', activated_at = 3, retired_at = NULL, updated_at = 3
       WHERE shard_id = 'retired-default';
      UPDATE control_tenant_shards SET status = 'failed', updated_at = 3
       WHERE shard_id = 'retired-default';
      UPDATE control_shard_capacity SET allocation_status = 'blocked', updated_at = 3
       WHERE shard_id = 'retired-default';
    `);

    await expect(
      repository.startQuarantine({
        environmentId: 'env-test',
        operationId: 'failed-reference-quarantine-op',
        request: quarantineRequest('failed-reference-quarantine'),
        now: START,
      })
    ).rejects.toThrow('control_shard_quarantine_conflict');
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM control_operations
            WHERE operation_id = 'failed-reference-quarantine-op'`
        )
        .get()
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare(
          `SELECT quarantine_state, quarantine_operation_id FROM control_tenant_shards
            WHERE shard_id = 'retired-default'`
        )
        .get()
    ).toEqual({ quarantine_state: 'none', quarantine_operation_id: null });
  });

  it('requires a fresh signed deny snapshot and the complete 30 minute drain', async () => {
    const keys = await signingKeys();
    let now = START;
    let documents = await registryDocuments({
      privateJwk: keys.privateJwk,
      kid: keys.kid,
      publishedAt: now,
    });
    const service = new ShardCleanupService({
      repository,
      d1: { getD1Database: vi.fn(), deleteD1Database: vi.fn() },
      workers: {
        getWorkerSettings: vi.fn(),
        patchWorkerSettings: vi.fn(),
        listWorkerDeployments: vi.fn(),
      },
      registry: {
        get: async (key: string) =>
          key === buildTenantRuntimeRegistrySnapshotKey('tenant-a', 'default')
            ? documents.snapshot
            : key === buildTenantRuntimeRegistryGenerationKey('tenant-a', 'default')
              ? documents.generation
              : null,
      },
      registryVerificationKeys: [{ publicJwk: keys.publicJwk, keyId: keys.kid }],
      deploymentTarget: 'default',
      destructiveOperationsEnabled: false,
      now: () => now,
    });

    await service.quarantine('env-test', quarantineRequest());
    await expect(service.reconcile()).resolves.toMatchObject({
      quarantineAttempted: 1,
      quarantineReady: 0,
      waitingRetry: 1,
    });

    now = START + 1800;
    documents = await registryDocuments({
      privateJwk: keys.privateJwk,
      kid: keys.kid,
      publishedAt: now - 10,
      runtimeGeneration: 11,
    });
    await expect(service.reconcile()).resolves.toMatchObject({
      quarantineAttempted: 1,
      quarantineReady: 1,
    });
    await expect(service.get('env-test', 'retired-default')).resolves.toMatchObject({
      quarantineState: 'quarantined',
      quarantineOperationState: 'ready_for_cleanup',
      availableActions: ['approve_cleanup'],
    });
  });

  it('blocks a registry that still exposes the retired shard and supports exact retry only', async () => {
    const keys = await signingKeys();
    let now = START;
    let documents = await registryDocuments({
      privateJwk: keys.privateJwk,
      kid: keys.kid,
      publishedAt: now,
      includeRetiredShard: true,
    });
    const service = new ShardCleanupService({
      repository,
      d1: { getD1Database: vi.fn(), deleteD1Database: vi.fn() },
      workers: {
        getWorkerSettings: vi.fn(),
        patchWorkerSettings: vi.fn(),
        listWorkerDeployments: vi.fn(),
      },
      registry: {
        get: async (key: string) =>
          key === buildTenantRuntimeRegistrySnapshotKey('tenant-a', 'default')
            ? documents.snapshot
            : documents.generation,
      },
      registryVerificationKeys: [{ publicJwk: keys.publicJwk, keyId: keys.kid }],
      deploymentTarget: 'default',
      destructiveOperationsEnabled: false,
      now: () => now,
    });
    const started = await service.quarantine('env-test', quarantineRequest());
    await expect(service.reconcile()).resolves.toMatchObject({ blocked: 1 });

    const retry = {
      quarantineOperationId: started.quarantineOperationId ?? '',
      requestedById: 'admin-a',
      reasonCode: 'operator_retry_quarantine' as const,
      idempotencyKey: 'retry-quarantine-1',
    };
    await expect(service.retryQuarantine('env-test', retry)).resolves.toMatchObject({
      quarantineOperationState: 'draining',
    });
    await expect(
      service.retryQuarantine('env-test', { ...retry, requestedById: 'admin-b' })
    ).rejects.toThrow('control_shard_quarantine_retry_not_allowed');

    now = START + 1800;
    documents = await registryDocuments({
      privateJwk: keys.privateJwk,
      kid: keys.kid,
      publishedAt: now - 5,
      runtimeGeneration: 12,
    });
    const retried = await service.reconcile();
    expect(retried).toMatchObject({ quarantineReady: 1 });
  });

  it('removes every role consumer binding and deletes the D1 only after revalidation', async () => {
    const keys = await signingKeys();
    let now = START;
    let documents = await registryDocuments({
      privateJwk: keys.privateJwk,
      kid: keys.kid,
      publishedAt: now,
    });
    let patched = false;
    let databaseExists = true;
    const oldDeployment = {
      id: 'deployment-old',
      created_on: '2027-01-15T08:00:00.000Z',
      source: 'api',
      strategy: 'percentage' as const,
      versions: [{ percentage: 100, version_id: 'version-old' }],
    };
    const newDeployment = {
      id: 'deployment-new',
      created_on: '2027-01-15T08:00:01.000Z',
      source: 'api',
      strategy: 'percentage' as const,
      versions: [{ percentage: 100, version_id: 'version-new' }],
    };
    const beforeSettings: CloudflareWorkerSettings = {
      bindings: [
        { name: 'TDB_RETIRED_DEFAULT', type: 'd1', database_id: 'database-retired' },
        { name: 'AUTHRIM_CONTROL', type: 'service', service: 'test-ar-control' },
      ],
      compatibility_date: '2026-07-01',
      observability: { enabled: true },
    };
    const afterSettings: CloudflareWorkerSettings = {
      ...beforeSettings,
      bindings: [{ name: 'AUTHRIM_CONTROL', type: 'service', service: 'test-ar-control' }],
    };
    const workers = {
      listWorkerDeployments: vi.fn(async () =>
        patched ? [newDeployment, oldDeployment] : [oldDeployment]
      ),
      getWorkerSettings: vi.fn(async () => (patched ? afterSettings : beforeSettings)),
      patchWorkerSettings: vi.fn(async (_script: string, settings: CloudflareWorkerSettings) => {
        expect(settings.bindings).not.toContainEqual(
          expect.objectContaining({ name: 'TDB_RETIRED_DEFAULT' })
        );
        expect(settings.bindings).toContainEqual(
          expect.objectContaining({
            name: 'AUTHRIM_CONTROL',
            type: 'inherit',
            version_id: 'latest',
          })
        );
        patched = true;
        return afterSettings;
      }),
    };
    const d1Api = {
      getD1Database: vi.fn(async () => {
        if (!databaseExists) throw new CloudflareControlApiError('d1.get', 404);
        return { uuid: 'database-retired', name: 'test-retired-default' };
      }),
      deleteD1Database: vi.fn(async () => {
        databaseExists = false;
      }),
    };
    const service = new ShardCleanupService({
      repository,
      d1: d1Api,
      workers,
      registry: {
        get: async (key: string) =>
          key === buildTenantRuntimeRegistrySnapshotKey('tenant-a', 'default')
            ? documents.snapshot
            : documents.generation,
      },
      registryVerificationKeys: [{ publicJwk: keys.publicJwk, keyId: keys.kid }],
      deploymentTarget: 'default',
      destructiveOperationsEnabled: true,
      now: () => now,
    });

    const quarantine = await service.quarantine('env-test', quarantineRequest());
    const drainingResult = await service.reconcile();
    expect(drainingResult).toMatchObject({ waitingRetry: 1 });
    now = START + 1800;
    documents = await registryDocuments({
      privateJwk: keys.privateJwk,
      kid: keys.kid,
      publishedAt: now - 5,
      runtimeGeneration: 11,
    });
    const readyResult = await service.reconcile();
    expect(readyResult.quarantineReady).toBe(1);
    await service.approveCleanup('env-test', {
      quarantineOperationId: quarantine.quarantineOperationId ?? '',
      requestedById: 'admin-a',
      reasonCode: 'operator_approve_cleanup',
      idempotencyKey: 'approve-cleanup-1',
      confirmation: 'DELETE_RETIRED_TENANT_SHARD',
      exportMode: 'skipped',
      exportEvidenceId: null,
      deleteDatabase: true,
    });

    const cleanupResult = await service.reconcile();
    expect(cleanupResult).toMatchObject({ cleanupAttempted: 1, cleanupSucceeded: 1 });
    await expect(service.get('env-test', 'retired-default')).resolves.toMatchObject({
      shardStatus: 'deleted',
      cleanupState: 'succeeded',
      bindings: [{ workerScriptName: 'test-ar-auth', state: 'removed' }],
    });
    expect(workers.patchWorkerSettings).toHaveBeenCalledTimes(1);
    expect(d1Api.deleteD1Database).toHaveBeenCalledWith('database-retired');
    expect(databaseExists).toBe(false);
  });

  it('records approval but performs no provider mutation while destructive operations are disabled', async () => {
    const harness = await cleanupHarness(repository, { destructiveOperationsEnabled: false });
    const cleanup = await harness.approve();

    expect(cleanup).toMatchObject({
      cleanupState: 'blocked',
      lastErrorCode: 'control_destructive_operations_disabled',
      destructiveOperationsEnabled: false,
    });
    await expect(harness.service.reconcile()).resolves.toMatchObject({ cleanupAttempted: 0 });
    expect(harness.workers.patchWorkerSettings).not.toHaveBeenCalled();
    expect(harness.d1Api.deleteD1Database).not.toHaveBeenCalled();
  });

  it('adopts a binding that was never attached to a failed pre-activation shard', async () => {
    const harness = await cleanupHarness(repository, { bindingMode: 'absent' });
    await harness.approve();

    await expect(harness.service.reconcile()).resolves.toMatchObject({ cleanupSucceeded: 1 });
    await expect(harness.service.get('env-test', 'retired-default')).resolves.toMatchObject({
      shardStatus: 'deleted',
      cleanupState: 'succeeded',
      bindings: [{ workerScriptName: 'test-ar-auth', state: 'removed' }],
    });
    expect(harness.workers.patchWorkerSettings).not.toHaveBeenCalled();
    expect(harness.d1Api.deleteD1Database).toHaveBeenCalledWith('database-retired');
  });

  it('blocks when the same D1 remains attached under an unexpected binding name', async () => {
    const harness = await cleanupHarness(repository, { bindingMode: 'wrong_name' });
    await harness.approve();

    await expect(harness.service.reconcile()).resolves.toMatchObject({ blocked: 1 });
    await expect(harness.service.get('env-test', 'retired-default')).resolves.toMatchObject({
      cleanupState: 'blocked',
      lastErrorCode: 'control_shard_cleanup_binding_identity_mismatch',
    });
    expect(harness.workers.patchWorkerSettings).not.toHaveBeenCalled();
    expect(harness.d1Api.deleteD1Database).not.toHaveBeenCalled();
  });

  it.each([
    ['before provider mutation', 'patch_before_mutation' as const, 2],
    ['after provider mutation', 'patch_after_mutation' as const, 1],
  ])(
    'resumes safely when a Worker patch response is lost %s',
    async (_label, failureMode, calls) => {
      const harness = await cleanupHarness(repository, { failureMode });
      await harness.approve();

      await expect(harness.service.reconcile()).resolves.toMatchObject({ waitingRetry: 1 });
      await harness.advance(15);
      await expect(harness.service.reconcile()).resolves.toMatchObject({ cleanupSucceeded: 1 });
      expect(harness.workers.patchWorkerSettings).toHaveBeenCalledTimes(calls);
      expect(harness.d1Api.deleteD1Database).toHaveBeenCalledTimes(1);
    }
  );

  it('blocks cleanup when another Worker deployment wins after the binding patch', async () => {
    const harness = await cleanupHarness(repository, { failureMode: 'concurrent_deployment' });
    await harness.approve();

    await expect(harness.service.reconcile()).resolves.toMatchObject({ blocked: 1 });
    await expect(harness.service.get('env-test', 'retired-default')).resolves.toMatchObject({
      cleanupState: 'blocked',
      lastErrorCode: 'control_worker_concurrent_deployment_detected',
    });
    expect(harness.d1Api.deleteD1Database).not.toHaveBeenCalled();
  });

  it('adopts verified D1 absence after a delete response is lost', async () => {
    const harness = await cleanupHarness(repository, { failureMode: 'delete_after_mutation' });
    await harness.approve();

    await expect(harness.service.reconcile()).resolves.toMatchObject({ waitingRetry: 1 });
    expect(harness.databaseExists).toBe(false);
    await harness.advance(15);
    await expect(harness.service.reconcile()).resolves.toMatchObject({ cleanupSucceeded: 1 });
    expect(harness.d1Api.deleteD1Database).toHaveBeenCalledTimes(1);
  });

  it('rechecks active references after binding removal and before D1 deletion', async () => {
    const harness = await cleanupHarness(repository);
    await harness.approve();
    const references = vi
      .spyOn(repository, 'countActiveReferences')
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);

    await expect(harness.service.reconcile()).resolves.toMatchObject({ waitingRetry: 1 });
    expect(references).toHaveBeenCalledTimes(2);
    expect(harness.d1Api.deleteD1Database).not.toHaveBeenCalled();
  });
});
