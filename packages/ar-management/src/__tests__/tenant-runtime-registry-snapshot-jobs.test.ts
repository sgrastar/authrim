import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockEnsureDatabaseAdapter,
  mockPublishTenantRuntimeRegistrySnapshot,
  mockRepository,
  MockTenantDatabaseRegistryRepository,
} = vi.hoisted(() => {
  const repository = {
    listActiveRegistryRowsForRole: vi.fn(),
    getLatestRuntimeRegistrySnapshot: vi.fn(),
  };
  function MockRepositoryConstructor() {
    return repository;
  }
  return {
    mockEnsureDatabaseAdapter: vi.fn((source: unknown) => source),
    mockPublishTenantRuntimeRegistrySnapshot: vi.fn(),
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

import { refreshTenantRuntimeRegistrySnapshots } from '../tenant-runtime-registry-snapshot-jobs';

describe('tenant runtime registry snapshot jobs', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  };
  const snapshotStore = {
    put: vi.fn(async () => undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRepository.listActiveRegistryRowsForRole.mockResolvedValue([]);
    mockRepository.getLatestRuntimeRegistrySnapshot.mockResolvedValue(null);
    mockPublishTenantRuntimeRegistrySnapshot.mockResolvedValue({});
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
        DEFAULT_STORAGE_PROFILE_ID: 'builtin:storage:tenant-d1',
        AUTHRIM_DEPLOYMENT_TARGET: 'edge-a',
      } as never,
      logger,
      { now: new Date('2026-05-16T00:00:00.000Z') }
    );

    expect(summary).toEqual({ scanned: 2, published: 2, skipped: 0, failed: 0 });
    expect(mockRepository.listActiveRegistryRowsForRole).toHaveBeenCalledWith(
      'tenant_core',
      25,
      0
    );
    expect(mockPublishTenantRuntimeRegistrySnapshot).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        tenantId: 'tenant-a',
        storageProfileId: 'builtin:storage:tenant-d1',
        snapshotStore,
        deploymentTarget: 'edge-a',
        actorId: 'tenant-runtime-registry-snapshot',
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
});
