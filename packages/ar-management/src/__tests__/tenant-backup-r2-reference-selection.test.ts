import { describe, expect, it, vi } from 'vitest';
import type { AdapterContext } from '../tenant-backup-export-dispatcher';
import type {
  EncryptedTenantBackupRecordSnapshotPort,
  TenantBackupRecordSnapshotSummary,
} from '../tenant-backup-record-snapshot-port';
import {
  createTenantBackupR2ReferenceSelectionLoader,
  tenantBackupR2ReferenceKey,
} from '../tenant-backup-r2-reference-selection';

function context(): AdapterContext {
  return {
    boundaryUnixMs: 100,
    context: {
      lease: { tenantId: 'tenant-a', operationId: 'operation-a' },
      signal: new AbortController().signal,
    },
    inventory: {
      headForLease: vi.fn(async () => ({ state: 'sealed', chain_digest: 'a'.repeat(64) })),
    },
  } as unknown as AdapterContext;
}

function port(
  resourceId: string,
  summaries: readonly TenantBackupRecordSnapshotSummary[]
): EncryptedTenantBackupRecordSnapshotPort {
  return {
    resourceId,
    readSummaries: vi.fn(async () => summaries),
  } as unknown as EncryptedTenantBackupRecordSnapshotPort;
}

describe('tenant backup R2 reference selection', () => {
  it('builds and caches an exact database-qualified catalog closure', async () => {
    const artifacts = port('r2-bodies:artifacts.object_catalog_bodies', [
      {
        kind: 'object',
        family: 'core',
        databaseId: 'core-a',
        rowId: 'physical-a',
        catalogId: 'catalog-a',
      },
    ]);
    const logs = port('r2-bodies:logs.archive_object_bodies', [
      {
        kind: 'log',
        family: 'admin',
        databaseId: 'admin-a',
        rowId: 'log-a',
      },
    ]);
    const load = createTenantBackupR2ReferenceSelectionLoader({
      artifactObjects: artifacts,
      logArchiveObjects: logs,
    });
    const input = context();

    const first = await load(input);
    const second = await load(input);

    expect(second).toBe(first);
    expect(first.objectCatalogRows).toEqual(
      new Set([tenantBackupR2ReferenceKey('core', 'core-a', 'catalog-a')])
    );
    expect(first.objectPhysicalRows).toEqual(
      new Set([tenantBackupR2ReferenceKey('core', 'core-a', 'physical-a')])
    );
    expect(first.logCatalogRows).toEqual(
      new Set([tenantBackupR2ReferenceKey('admin', 'admin-a', 'log-a')])
    );
    expect(artifacts.readSummaries).toHaveBeenCalledTimes(1);
    expect(logs.readSummaries).toHaveBeenCalledTimes(1);
  });

  it('fails closed for malformed or cross-contract summaries', async () => {
    const load = createTenantBackupR2ReferenceSelectionLoader({
      artifactObjects: port('r2-bodies:artifacts.object_catalog_bodies', [
        { kind: 'object', family: 'core', databaseId: 'core-a', rowId: 'physical-a' },
      ]),
      logArchiveObjects: port('r2-bodies:logs.archive_object_bodies', []),
    });

    await expect(load(context())).rejects.toThrow('backup_r2_reference_selection_invalid');
  });
});
