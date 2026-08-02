import type {
  ControlTenantPlacementMigrationView,
  DatabaseAdapter,
  Env,
} from '@authrim/ar-lib-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantPlacementMigrationJobView } from '../tenant-placement-migration-job';

const mocks = vi.hoisted(() => ({
  repository: {
    upsertRegistryRow: vi.fn(),
    setActivePointer: vi.fn(),
  },
  repositoryAdapters: [] as unknown[],
  publishSnapshot: vi.fn(),
  createSigner: vi.fn(),
  prepareAlias: vi.fn(),
  activateAlias: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    TenantDatabaseRegistryRepository: vi.fn().mockImplementation(function MockRepository(
      adapter: unknown
    ) {
      mocks.repositoryAdapters.push(adapter);
      return mocks.repository;
    }),
    publishTenantRuntimeRegistrySnapshot: mocks.publishSnapshot,
  };
});

vi.mock('../control-runtime-registry-signer', () => ({
  createControlRuntimeRegistrySigner: mocks.createSigner,
}));

vi.mock('../tenant-alias-directory', () => ({
  prepareTenantAliasPlacementMigration: mocks.prepareAlias,
  activateTenantAliasDirectory: mocks.activateAlias,
}));

import { createTenantPlacementMigrationSagaDependencies } from '../tenant-placement-migration-dependencies';

function migration(): ControlTenantPlacementMigrationView {
  return {
    operationId: 'control-operation-a',
    tenantId: 'tenant-a',
    state: 'cutover_committed',
    sourceIsolationPolicy: 'shared_pool',
    targetIsolationPolicy: 'tenant_exclusive',
    sourcePolicyGeneration: 1,
    targetPolicyGeneration: 2,
    writeFenceState: 'active',
    routeCutoverStarted: true,
    canCancel: false,
    canApprovePurge: false,
    sourceRetentionExpiresAt: null,
    lastErrorCode: null,
    createdAt: 1,
    updatedAt: 2,
    shards: (['tenant_core/default', 'tenant_core/users', 'tenant_pii'] as const).map(
      (dataRole, index) => ({
        dataRole,
        residencyPolicyId: 'builtin:residency:eu',
        residencyPartition: index === 0 ? 'eu-primary' : `eu-${index}`,
        sourceShardId: `source-${index}`,
        sourceAssignmentGeneration: 1,
        targetShardId: `target-${index}`,
        target: {
          shardId: `target-${index}`,
          assignmentGeneration: 2,
          routeGeneration: 5,
          bindingRef: `TDB_TARGET_${index}`,
          databaseId: `database-${index}`,
          databaseName: `tenant-a-${index}`,
        },
        state: 'cutover_committed',
        inventoryTableCount: 1,
        sourceRowCount: 1,
        targetRowCount: 1,
        lastObservedSourceSequence: 0,
        lastAppliedSourceSequence: 0,
        lastErrorCode: null,
        updatedAt: 2,
      })
    ),
  };
}

function job(): TenantPlacementMigrationJobView {
  return {
    operationId: 'management-operation-a',
    environmentId: 'test',
    tenantId: 'tenant-a',
    controlOperationId: 'control-operation-a',
    targetIsolationPolicy: 'tenant_exclusive',
    status: 'running',
    currentStep: 'publish_registry',
    lookupCursor: null,
    lookupPreparedRowCount: 0,
    lookupActivatedRowCount: 0,
    lookupVerifiedRowCount: 0,
    requestHash: 'a'.repeat(64),
    idempotencyKey: 'request-a',
    attemptCount: 1,
    retryBudgetStartedAt: 1,
    nextAttemptAt: null,
    lastErrorCode: null,
    fencingToken: 1,
    requestedBy: 'admin-a',
    createdAt: 1,
    startedAt: 1,
    completedAt: null,
    updatedAt: 1,
  };
}

describe('tenant placement migration dependencies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.repositoryAdapters.length = 0;
    mocks.createSigner.mockResolvedValue({ sign: vi.fn() });
  });

  it('keeps Platform, Admin Registry, target D1, and residency projection boundaries distinct', async () => {
    const platformAdapter = {
      queryOne: vi.fn(async (sql: string) =>
        sql.includes('tenant_code')
          ? { tenant_code: 'acme' }
          : { isolation_policy: 'tenant_exclusive' }
      ),
      execute: vi.fn(async () => ({ changes: 1 })),
    } as unknown as DatabaseAdapter;
    const adminAdapter = { boundary: 'admin-registry' } as unknown as DatabaseAdapter;
    const targetRun = vi.fn(async () => ({ success: true, meta: { changes: 1 } }));
    const targetFirst = vi.fn(async () => ({ isolation_policy: 'tenant_exclusive' }));
    const targetSession = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({ run: targetRun, first: targetFirst })),
      })),
    };
    const withSession = vi.fn(() => targetSession);
    const currentMigration = migration();
    mocks.publishSnapshot.mockResolvedValue({
      snapshot: {
        tenantId: 'tenant-a',
        routeStatus: 'active',
        stores: currentMigration.shards.map((shard) => ({
          bindingRef: shard.target!.bindingRef,
        })),
      },
    });
    const env = {
      DEFAULT_STORAGE_PROFILE_ID: 'builtin:storage:tenant-d1',
      TENANT_RUNTIME_REGISTRY: { put: vi.fn(), get: vi.fn() },
      TDB_TARGET_0: { withSession },
    } as unknown as Env;
    const dependencies = createTenantPlacementMigrationSagaDependencies(
      env,
      platformAdapter,
      adminAdapter
    );
    const currentJob = job();

    await dependencies.prepareAlias(currentJob, currentMigration);
    await dependencies.publishRegistry(currentJob, currentMigration);
    await dependencies.activateAlias(currentJob, currentMigration);

    expect(mocks.repositoryAdapters).toEqual([adminAdapter]);
    expect(platformAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET isolation_policy = 'tenant_exclusive'"),
      expect.arrayContaining(['tenant-a'])
    );
    expect(withSession).toHaveBeenCalledWith('first-primary');
    expect(targetRun).toHaveBeenCalledOnce();
    expect(mocks.prepareAlias).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        tenantId: 'tenant-a',
        tenantCode: 'acme',
        routeProjection: expect.objectContaining({
          residencyPolicyId: 'builtin:residency:eu',
          target: expect.objectContaining({
            residencyPartition: 'eu-primary',
            bindingRef: 'TDB_TARGET_0',
          }),
        }),
      })
    );
    expect(mocks.activateAlias).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        routeProjection: expect.objectContaining({
          residencyPolicyId: 'builtin:residency:eu',
        }),
      })
    );

    const registryRows = mocks.repository.upsertRegistryRow.mock.calls.map(([row]) => row);
    expect(registryRows).toHaveLength(3);
    expect(registryRows.map((row) => JSON.parse(String(row.metadata_json)))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          control_operation_id: 'control-operation-a',
          residency_policy_id: 'builtin:residency:eu',
          residency_partition: 'eu-primary',
        }),
      ])
    );
  });
});
