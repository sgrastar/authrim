import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockResolveAuthCorePersistenceAdapterFromEnv,
  mockTombstoneObjectCatalogEntryForTenant,
  mockListDeletedObjectCatalogObjectsForSystemCleanup,
  mockPurgeDeletedObjectCatalogObjectsForSystemCleanup,
  mockAdapter,
} = vi.hoisted(() => {
  const adapter = {
    query: vi.fn(),
    execute: vi.fn(),
  };

  return {
    mockResolveAuthCorePersistenceAdapterFromEnv: vi.fn().mockResolvedValue(adapter),
    mockTombstoneObjectCatalogEntryForTenant: vi.fn(),
    mockListDeletedObjectCatalogObjectsForSystemCleanup: vi.fn(),
    mockPurgeDeletedObjectCatalogObjectsForSystemCleanup: vi.fn(),
    mockAdapter: adapter,
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveAuthCorePersistenceAdapterFromEnv: mockResolveAuthCorePersistenceAdapterFromEnv,
    tombstoneObjectCatalogEntryForTenant: mockTombstoneObjectCatalogEntryForTenant,
    listDeletedObjectCatalogObjectsForSystemCleanup:
      mockListDeletedObjectCatalogObjectsForSystemCleanup,
    purgeDeletedObjectCatalogObjectsForSystemCleanup:
      mockPurgeDeletedObjectCatalogObjectsForSystemCleanup,
  };
});

import {
  cleanupExpiredAdminJobArtifacts,
  cleanupExpiredDataExportArtifacts,
  purgeDeletedObjectArtifacts,
} from '../artifact-cleanup';

describe('artifact cleanup', () => {
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAuthCorePersistenceAdapterFromEnv.mockResolvedValue(mockAdapter);
    mockAdapter.query.mockReset();
    mockAdapter.execute.mockReset();
    mockTombstoneObjectCatalogEntryForTenant.mockReset();
    mockListDeletedObjectCatalogObjectsForSystemCleanup.mockReset();
    mockPurgeDeletedObjectCatalogObjectsForSystemCleanup.mockReset();
  });

  it('tombstones expired data export object catalogs', async () => {
    mockAdapter.query.mockResolvedValue([
      {
        id: 'export-1',
        tenant_id: 'default',
        object_catalog_id: 'catalog-1',
        file_path: 'exports/default/data-export/export-1/artifact.json',
      },
    ]);

    const cleaned = await cleanupExpiredDataExportArtifacts(
      {
        EXPORT_ARTIFACTS: {
          delete: vi.fn(),
        } as unknown as R2Bucket,
      } as any,
      logger
    );

    expect(cleaned).toBe(1);
    expect(mockTombstoneObjectCatalogEntryForTenant).toHaveBeenCalledWith(
      mockAdapter,
      'default',
      'catalog-1',
      expect.any(Number)
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE data_export_requests'),
      ['export-1', 'default']
    );
  });

  it('deletes legacy expired data export objects without catalog pointers', async () => {
    const deleteObject = vi.fn();
    mockAdapter.query.mockResolvedValue([
      {
        id: 'export-legacy',
        tenant_id: 'default',
        object_catalog_id: null,
        file_path: 'exports/default/data-export/export-legacy/artifact.json',
      },
    ]);

    const cleaned = await cleanupExpiredDataExportArtifacts(
      {
        EXPORT_ARTIFACTS: {
          delete: deleteObject,
        } as unknown as R2Bucket,
      } as any,
      logger
    );

    expect(cleaned).toBe(1);
    expect(deleteObject).toHaveBeenCalledWith(
      'exports/default/data-export/export-legacy/artifact.json'
    );
  });

  it('tombstones expired admin job artifacts', async () => {
    mockAdapter.query.mockResolvedValue([
      {
        id: 'job-1',
        tenant_id: 'default',
        object_catalog_id: 'catalog-job-1',
        result_r2_key: 'exports/default/users-import/job-1/result.json',
      },
    ]);

    const cleaned = await cleanupExpiredAdminJobArtifacts(
      {
        EXPORT_ARTIFACTS: {
          delete: vi.fn(),
        } as unknown as R2Bucket,
      } as any,
      logger
    );

    expect(cleaned).toBe(1);
    expect(mockTombstoneObjectCatalogEntryForTenant).toHaveBeenCalledWith(
      mockAdapter,
      'default',
      'catalog-job-1',
      expect.any(Number)
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(expect.stringContaining('UPDATE admin_jobs'), [
      'job-1',
      'default',
    ]);
  });

  it('purges deleted object artifacts from configured buckets', async () => {
    const exportDelete = vi.fn();
    const sensitiveDelete = vi.fn();
    mockListDeletedObjectCatalogObjectsForSystemCleanup.mockResolvedValue([
      {
        physicalId: 'physical-1',
        catalogId: 'catalog-1',
        publicArtifactId: 'oa_1',
        tenantId: 'default',
        objectClass: 'user_export',
        bucketBinding: 'EXPORT_ARTIFACTS',
        objectKey: 'exports/default/data-export/export-1/artifact.json',
        representation: 'canonical_json',
        objectKind: 'single',
        chunkIndex: 0,
        deletedAt: Date.now(),
      },
      {
        physicalId: 'physical-2',
        catalogId: 'catalog-2',
        publicArtifactId: 'oa_2',
        tenantId: 'default',
        objectClass: 'approval_transport_detail',
        bucketBinding: 'SENSITIVE_DETAILS',
        objectKey: 'sensitive/default/approval/request-1/detail.json',
        representation: 'canonical_json',
        objectKind: 'single',
        chunkIndex: 0,
        deletedAt: Date.now(),
      },
    ]);
    mockPurgeDeletedObjectCatalogObjectsForSystemCleanup.mockResolvedValue(2);

    const purged = await purgeDeletedObjectArtifacts(
      {
        EXPORT_ARTIFACTS: { delete: exportDelete } as unknown as R2Bucket,
        SENSITIVE_DETAILS: { delete: sensitiveDelete } as unknown as R2Bucket,
      } as any,
      mockAdapter as any,
      logger
    );

    expect(purged).toBe(2);
    expect(exportDelete).toHaveBeenCalledWith('exports/default/data-export/export-1/artifact.json');
    expect(sensitiveDelete).toHaveBeenCalledWith(
      'sensitive/default/approval/request-1/detail.json'
    );
    expect(mockPurgeDeletedObjectCatalogObjectsForSystemCleanup).toHaveBeenCalledWith(mockAdapter, [
      'physical-1',
      'physical-2',
    ]);
  });
});
