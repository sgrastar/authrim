import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockEnsureDatabaseAdapter,
  mockPublishTenantRuntimeRegistrySnapshot,
  mockResolveTenantRuntimePlacementSnapshot,
  mockRepository,
  MockTenantDatabaseRegistryRepository,
} = vi.hoisted(() => {
  const repository = {
    listActiveRegistryRowsForRole: vi.fn(),
    listActiveRegistryRowsForTenantRole: vi.fn(),
    getLatestRuntimeRegistrySnapshot: vi.fn(),
    upsertRegistryRow: vi.fn(),
    setActivePointer: vi.fn(),
  };
  function MockRepositoryConstructor() {
    return repository;
  }
  return {
    mockEnsureDatabaseAdapter: vi.fn((source: unknown) => source),
    mockPublishTenantRuntimeRegistrySnapshot: vi.fn(),
    mockResolveTenantRuntimePlacementSnapshot: vi.fn(),
    mockRepository: repository,
    MockTenantDatabaseRegistryRepository: vi.fn(MockRepositoryConstructor),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    ensureDatabaseAdapter: mockEnsureDatabaseAdapter,
    publishTenantRuntimeRegistrySnapshot: mockPublishTenantRuntimeRegistrySnapshot,
    TenantDatabaseRegistryRepository: MockTenantDatabaseRegistryRepository,
  };
});

vi.mock('../tenant-runtime-placement', () => ({
  resolveTenantRuntimePlacementSnapshot: mockResolveTenantRuntimePlacementSnapshot,
}));

import {
  isTenantRuntimeRegistryRefreshCron,
  refreshTenantRuntimeRegistrySnapshots,
} from '../tenant-runtime-registry-snapshot-jobs';

describe('tenant runtime registry snapshot jobs', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  };
  const snapshotStore = {
    put: vi.fn(async () => undefined),
  };
  const controlSigner = {
    getRuntimeRegistrySignerMetadata: vi.fn(async () => ({
      keyId: 'runtime-registry-a',
      algorithm: 'EdDSA' as const,
      type: 'authrim-runtime-registry+jws' as const,
    })),
    signRuntimeRegistryPayload: vi.fn(async () => ({
      keyId: 'runtime-registry-a',
      algorithm: 'EdDSA' as const,
      type: 'authrim-runtime-registry+jws' as const,
      compactJws: 'unused.mock.signature',
    })),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRepository.listActiveRegistryRowsForRole.mockResolvedValue([]);
    mockRepository.listActiveRegistryRowsForTenantRole.mockResolvedValue([]);
    mockRepository.getLatestRuntimeRegistrySnapshot.mockResolvedValue(null);
    mockRepository.upsertRegistryRow.mockImplementation(async (row: unknown) => row);
    mockRepository.setActivePointer.mockImplementation(async (row: unknown) => row);
    mockPublishTenantRuntimeRegistrySnapshot.mockResolvedValue({});
    mockResolveTenantRuntimePlacementSnapshot.mockResolvedValue({
      isolationPolicy: 'tenant_exclusive',
      policyGeneration: 4,
    });
  });

  it('uses the existing two-minute scheduled lane only', () => {
    expect(isTenantRuntimeRegistryRefreshCron('*/2 * * * *')).toBe(true);
    expect(isTenantRuntimeRegistryRefreshCron('* * * * *')).toBe(false);
    expect(isTenantRuntimeRegistryRefreshCron('0 */6 * * *')).toBe(false);
  });

  it('skips when DB_ADMIN is not configured', async () => {
    const summary = await refreshTenantRuntimeRegistrySnapshots({} as never, logger);

    expect(summary).toEqual({ scanned: 0, published: 0, skipped: 0, failed: 0 });
    expect(logger.warn).toHaveBeenCalledWith(
      'Tenant runtime registry snapshot refresh skipped because DB_ADMIN is not configured'
    );
  });

  it('skips when runtime registry KV is not configured', async () => {
    const summary = await refreshTenantRuntimeRegistrySnapshots(
      { DB_ADMIN: 'control' } as never,
      logger
    );

    expect(summary).toEqual({ scanned: 0, published: 0, skipped: 0, failed: 0 });
    expect(logger.warn).toHaveBeenCalledWith(
      'Tenant runtime registry snapshot refresh skipped because TENANT_RUNTIME_REGISTRY is not configured'
    );
  });

  it('publishes one idempotent snapshot per tenant discovered from active tenant core rows', async () => {
    mockRepository.listActiveRegistryRowsForRole.mockResolvedValue([
      { tenant_id: 'tenant-b', role: 'tenant_core' },
      { tenant_id: 'tenant-a', role: 'tenant_core' },
      { tenant_id: 'tenant-a', role: 'tenant_core' },
    ]);

    const summary = await refreshTenantRuntimeRegistrySnapshots(
      {
        DB_ADMIN: 'control',
        TENANT_RUNTIME_REGISTRY: snapshotStore,
        CONTROL: controlSigner,
        AUTHRIM_DEPLOYMENT_TARGET: 'edge-a',
      } as never,
      logger,
      { now: new Date('2026-05-16T00:00:00.000Z') }
    );

    expect(summary).toEqual({ scanned: 2, published: 2, skipped: 0, failed: 0 });
    expect(mockRepository.listActiveRegistryRowsForRole).toHaveBeenCalledWith('tenant_core', 25, 0);
    expect(mockPublishTenantRuntimeRegistrySnapshot).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        tenantId: 'tenant-a',
        placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 4 },
        snapshotStore,
        deploymentTarget: 'edge-a',
        actorId: 'tenant-runtime-registry-snapshot',
        externalSigner: expect.objectContaining({
          keyId: 'runtime-registry-a',
          algorithm: 'EdDSA',
          type: 'authrim-runtime-registry+jws',
        }),
      })
    );
    expect(mockPublishTenantRuntimeRegistrySnapshot).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        tenantId: 'tenant-b',
      })
    );
    expect(logger.info).toHaveBeenCalledWith('Tenant runtime registry snapshot refresh completed', {
      scanned: 2,
      published: 2,
      skipped: 0,
      failed: 0,
    });
  });

  it('reconciles every Control scale-out target before publishing the tenant snapshot', async () => {
    const metadata = (dataRole: string) =>
      JSON.stringify({
        control_data_role: dataRole,
        control_residency_policy_id: 'builtin:residency:default',
        control_residency_partition: 'default',
      });
    mockRepository.listActiveRegistryRowsForRole.mockResolvedValue([
      { tenant_id: 'tenant-a', role: 'tenant_core', status: 'active' },
    ]);
    mockRepository.listActiveRegistryRowsForTenantRole.mockImplementation(
      async (_tenantId: string, role: string) =>
        role === 'tenant_core'
          ? [
              {
                tenant_id: 'tenant-a',
                role: 'tenant_core',
                shard_group: 'default',
                binding_ref: 'TDB_DEFAULT',
                metadata_json: metadata('tenant_core/default'),
              },
              {
                tenant_id: 'tenant-a',
                role: 'tenant_core',
                shard_group: 'users',
                binding_ref: 'TDB_USERS_1',
                metadata_json: metadata('tenant_core/users'),
              },
            ]
          : [
              {
                tenant_id: 'tenant-a',
                role: 'tenant_pii',
                shard_group: 'default',
                binding_ref: 'TDB_PII_1',
                metadata_json: metadata('tenant_pii'),
              },
            ]
    );
    const target = (
      dataRole: 'tenant_core/default' | 'tenant_core/users' | 'tenant_pii',
      suffix: string,
      assignmentGeneration: number
    ) => ({
      shardId: `shard-${suffix}`,
      dataRole,
      residencyPolicyId: 'builtin:residency:default',
      residencyPartition: 'default',
      routeGeneration: 1,
      bindingRef: `TDB_${suffix}`,
      databaseId: `database-${suffix}`,
      databaseName: `database-${suffix}`,
      allocationScope: 'tenant_exclusive' as const,
      ownerTenantId: 'tenant-a',
      assignmentGeneration,
    });
    const getTenantRuntimeRouteTargets = vi.fn(async () => [
      target('tenant_core/default', 'DEFAULT', 1),
      target('tenant_core/users', 'USERS_1', 1),
      target('tenant_core/users', 'USERS_2', 2),
      target('tenant_pii', 'PII_1', 1),
      target('tenant_pii', 'PII_2', 2),
    ]);

    const summary = await refreshTenantRuntimeRegistrySnapshots(
      {
        DB_ADMIN: 'control',
        TENANT_RUNTIME_REGISTRY: snapshotStore,
        CONTROL: { ...controlSigner, getTenantRuntimeRouteTargets },
      } as never,
      logger
    );

    expect(summary).toEqual({ scanned: 1, published: 1, skipped: 0, failed: 0 });
    expect(getTenantRuntimeRouteTargets).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      residencyPolicyId: 'builtin:residency:default',
      residencyPartition: 'default',
    });
    expect(mockRepository.upsertRegistryRow).toHaveBeenCalledTimes(5);
    expect(mockRepository.upsertRegistryRow).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant-a',
        role: 'tenant_core',
        shard_group: 'users',
        shard_index: 1,
        shard_count: 2,
        binding_ref: 'TDB_USERS_2',
      })
    );
    expect(mockRepository.setActivePointer).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant-a',
        role: 'tenant_pii',
        shard_group: 'default',
        shard_count: 2,
        runtime_generation: 4,
      })
    );
    expect(mockPublishTenantRuntimeRegistrySnapshot).toHaveBeenCalledTimes(1);
  });

  it('continues publishing remaining tenants when one snapshot fails', async () => {
    mockRepository.listActiveRegistryRowsForRole.mockResolvedValue([
      { tenant_id: 'tenant-a', role: 'tenant_core' },
      { tenant_id: 'tenant-b', role: 'tenant_core' },
    ]);
    mockPublishTenantRuntimeRegistrySnapshot
      .mockRejectedValueOnce(new Error('kv_unavailable'))
      .mockResolvedValueOnce({});

    const summary = await refreshTenantRuntimeRegistrySnapshots(
      {
        DB_ADMIN: 'control',
        TENANT_RUNTIME_REGISTRY: snapshotStore,
        CONTROL: controlSigner,
      } as never,
      logger
    );

    expect(summary).toEqual({ scanned: 2, published: 1, skipped: 0, failed: 1 });
    expect(logger.warn).toHaveBeenCalledWith('Tenant runtime registry snapshot refresh failed', {
      tenant_id: 'tenant-a',
      error: 'kv_unavailable',
    });
  });

  it('skips tenants whose active snapshot is not near expiry', async () => {
    mockRepository.listActiveRegistryRowsForRole.mockResolvedValue([
      { tenant_id: 'tenant-a', role: 'tenant_core', status: 'active' },
    ]);
    mockRepository.getLatestRuntimeRegistrySnapshot.mockResolvedValue({
      expires_at: '2026-05-20T00:00:00.000Z',
    });

    const summary = await refreshTenantRuntimeRegistrySnapshots(
      {
        DB_ADMIN: 'control',
        TENANT_RUNTIME_REGISTRY: snapshotStore,
      } as never,
      logger,
      { now: new Date('2026-05-16T00:00:00.000Z') }
    );

    expect(summary).toEqual({ scanned: 1, published: 0, skipped: 1, failed: 0 });
    expect(mockPublishTenantRuntimeRegistrySnapshot).not.toHaveBeenCalled();
  });

  it('refreshes an active snapshot with less than ten minutes remaining', async () => {
    mockRepository.listActiveRegistryRowsForRole.mockResolvedValue([
      { tenant_id: 'tenant-a', role: 'tenant_core', status: 'active' },
    ]);
    mockRepository.getLatestRuntimeRegistrySnapshot.mockResolvedValue({
      expires_at: '2026-05-16T00:09:59.000Z',
    });

    const summary = await refreshTenantRuntimeRegistrySnapshots(
      {
        DB_ADMIN: 'control',
        TENANT_RUNTIME_REGISTRY: snapshotStore,
        CONTROL: controlSigner,
      } as never,
      logger,
      { now: new Date('2026-05-16T00:00:00.000Z') }
    );

    expect(summary).toEqual({ scanned: 1, published: 1, skipped: 0, failed: 0 });
    expect(mockPublishTenantRuntimeRegistrySnapshot).toHaveBeenCalledTimes(1);
  });
});
