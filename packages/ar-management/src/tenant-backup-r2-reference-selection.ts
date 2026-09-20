import type { AdapterContext } from './tenant-backup-export-dispatcher';
import { tenantBackupRecordSnapshotId } from './tenant-backup-phase5-adapter';
import type {
  EncryptedTenantBackupRecordSnapshotPort,
  TenantBackupRecordSnapshotSummary,
} from './tenant-backup-record-snapshot-port';

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,256}$/u;
const MAX_CACHE_ENTRIES = 8;

export interface TenantBackupR2ReferenceSelection {
  objectCatalogRows: ReadonlySet<string>;
  objectPhysicalRows: ReadonlySet<string>;
  logCatalogRows: ReadonlySet<string>;
}

function invalid(): never {
  throw new Error('backup_r2_reference_selection_invalid');
}

export function tenantBackupR2ReferenceKey(
  family: string,
  databaseId: string,
  rowId: string
): string {
  if (!['core', 'admin'].includes(family) || !SAFE_ID.test(databaseId) || !SAFE_ID.test(rowId))
    invalid();
  return JSON.stringify([family, databaseId, rowId]);
}

function addSummary(
  selection: {
    objectCatalogRows: Set<string>;
    objectPhysicalRows: Set<string>;
    logCatalogRows: Set<string>;
  },
  summary: TenantBackupRecordSnapshotSummary
): void {
  const keys = Object.keys(summary).sort().join(',');
  const family = summary.family;
  const databaseId = summary.databaseId;
  const rowId = summary.rowId;
  if (typeof family !== 'string' || typeof databaseId !== 'string' || typeof rowId !== 'string')
    invalid();
  const rowKey = tenantBackupR2ReferenceKey(family, databaseId, rowId);
  if (summary.kind === 'hold') {
    if (
      keys !== 'databaseId,family,holdDatasetId,kind,rowId' ||
      !['admin.logging_dlq_items', 'admin.logging_message_jobs'].includes(
        String(summary.holdDatasetId)
      )
    )
      invalid();
    return;
  }
  if (summary.kind === 'object') {
    if (keys !== 'catalogId,databaseId,family,kind,rowId' || typeof summary.catalogId !== 'string')
      invalid();
    selection.objectPhysicalRows.add(rowKey);
    selection.objectCatalogRows.add(
      tenantBackupR2ReferenceKey(family, databaseId, summary.catalogId)
    );
    return;
  }
  if (summary.kind !== 'log' || keys !== 'databaseId,family,kind,rowId') invalid();
  selection.logCatalogRows.add(rowKey);
}

/** Resolve the exact R2 reference closure persisted at the held bundle boundary. */
export function createTenantBackupR2ReferenceSelectionLoader(input: {
  artifactObjects: EncryptedTenantBackupRecordSnapshotPort;
  logArchiveObjects: EncryptedTenantBackupRecordSnapshotPort;
}) {
  const cache = new Map<string, Promise<TenantBackupR2ReferenceSelection>>();
  return async (context: AdapterContext): Promise<TenantBackupR2ReferenceSelection> => {
    const boundaryUnixMs = context.boundaryUnixMs;
    if (!Number.isSafeInteger(boundaryUnixMs) || (boundaryUnixMs ?? -1) < 0) invalid();
    const head = await context.inventory.headForLease(context.context.lease);
    if (head.state !== 'sealed') invalid();
    const cacheKey = JSON.stringify([
      context.context.lease.tenantId,
      context.context.lease.operationId,
      head.chain_digest,
      boundaryUnixMs,
    ]);
    const existing = cache.get(cacheKey);
    if (existing) return existing;
    const loading = (async () => {
      const [artifactSummaries, logSummaries] = await Promise.all([
        input.artifactObjects.readSummaries(
          context,
          await tenantBackupRecordSnapshotId(context, input.artifactObjects.resourceId),
          boundaryUnixMs ?? -1
        ),
        input.logArchiveObjects.readSummaries(
          context,
          await tenantBackupRecordSnapshotId(context, input.logArchiveObjects.resourceId),
          boundaryUnixMs ?? -1
        ),
      ]);
      const selected = {
        objectCatalogRows: new Set<string>(),
        objectPhysicalRows: new Set<string>(),
        logCatalogRows: new Set<string>(),
      };
      for (const summary of [...artifactSummaries, ...logSummaries]) addSummary(selected, summary);
      return Object.freeze(selected) satisfies TenantBackupR2ReferenceSelection;
    })();
    cache.set(cacheKey, loading);
    if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value ?? '');
    try {
      return await loading;
    } catch (error) {
      cache.delete(cacheKey);
      throw error;
    }
  };
}
