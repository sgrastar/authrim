import { isObjectClass, type DatabaseAdapter } from '@authrim/ar-lib-core';
import { tenantBackupLogWindow } from '@authrim/ar-lib-core/services/tenant-portability/selection-contract';
import { LOG_CHUNK_COMPRESSION, LOG_PLANES, LOG_TYPES } from '@authrim/ar-lib-logging/contract';
import type { AdapterContext } from './tenant-backup-export-dispatcher';
import { tenantBackupDatabaseFamily } from './tenant-backup-database-inventory';
import type {
  TenantBackupR2ObjectDescriptor,
  TenantBackupR2CatalogKind,
} from './tenant-backup-r2-object-snapshot-port';
import type {
  PortableR2BucketBinding,
  PortableR2DatasetId,
} from '@authrim/ar-lib-core/services/tenant-portability/portable-r2-object';

const MAX_DESCRIPTORS = 4096;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,256}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const AUDIT_LOG_TYPES = new Set(['audit', 'admin_audit', 'security']);
const OTHER_LOG_TYPES = new Set(['normal', 'diagnostic', 'job', 'webhook', 'operational']);

type Family = 'core' | 'admin';
type Source = { family: Family; databaseId: string; database: Pick<DatabaseAdapter, 'query'> };

interface ObjectCatalogRow {
  id: string;
  object_class: string;
  bucket_binding: string;
  object_key: string;
  key_version: number;
  checksum_sha256: string | null;
  total_bytes: number | null;
  shared_detail_count: number;
}

interface LogObjectRow {
  id: string;
  log_type: string;
  plane: string;
  object_key: string;
  record_count: number;
  byte_count: number;
  checksum_sha256: string | null;
  compression: string | null;
  encryption_scope: string | null;
  key_version: number | null;
  created_at: number;
  index_count: number;
  first_event_at: number | null;
  last_event_at: number | null;
  first_chunk_id: string | null;
  last_chunk_id: string | null;
}

function invalid(code = 'backup_r2_catalog_list_invalid'): never {
  throw new Error(code);
}

function integer(value: unknown, allowZero = true): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) invalid();
  return parsed;
}

function sources(context: AdapterContext): Source[] {
  const result: Source[] = [];
  for (const resource of context.databases.tenant) {
    if (tenantBackupDatabaseFamily(resource) !== 'core') continue;
    result.push({ family: 'core', databaseId: resource.databaseId, database: resource.database });
  }
  for (const resource of context.databases.fixed) {
    if (resource.binding !== 'DB_ADMIN' || resource.family !== 'admin') continue;
    result.push({ family: 'admin', databaseId: resource.databaseId, database: resource.database });
  }
  if (
    !result.some(({ family }) => family === 'core') ||
    !result.some(({ family }) => family === 'admin')
  )
    invalid();
  return result.sort((left, right) =>
    `${left.family}:${left.databaseId}`.localeCompare(`${right.family}:${right.databaseId}`)
  );
}

function objectId(family: Family, rowId: string): string {
  if (!SAFE_ID.test(rowId)) invalid();
  return `${family}:${rowId}`;
}

function bucketForPlane(plane: string): PortableR2BucketBinding {
  if (!LOG_PLANES.includes(plane as (typeof LOG_PLANES)[number])) invalid();
  if (plane === 'sensitive_detail') return 'SENSITIVE_DETAILS';
  if (plane === 'diagnostic_detail') return 'DIAGNOSTIC_LOGS';
  return 'AUDIT_ARCHIVE';
}

function logTypeSelected(
  logType: string,
  context: AdapterContext,
  sensitiveDetail: boolean
): boolean {
  if (AUDIT_LOG_TYPES.has(logType))
    return context.selection.logs.audit && (!sensitiveDetail || context.selection.logs.sensitive);
  if (OTHER_LOG_TYPES.has(logType))
    return context.selection.logs.other && (!sensitiveDetail || context.selection.logs.sensitive);
  if (logType === 'pii') return context.selection.logs.sensitive;
  return invalid();
}

async function listObjectCatalog(
  context: AdapterContext,
  source: Source,
  tenantId: string
): Promise<TenantBackupR2ObjectDescriptor[]> {
  const rows = await source.database.query<ObjectCatalogRow>(
    `SELECT p.id,c.object_class,p.bucket_binding,p.object_key,p.key_version,
       p.checksum_sha256,p.total_bytes,
       (SELECT count(*) FROM sensitive_detail_chunk_index s
         WHERE s.catalog_id=p.catalog_id AND s.object_key=p.object_key
           AND s.tenant_id=? AND s.deleted_at IS NULL) AS shared_detail_count
     FROM object_catalog_objects p JOIN object_catalog c ON c.id=p.catalog_id
     WHERE c.tenant_id=? AND c.deleted_at IS NULL AND p.deleted_at IS NULL
       AND c.object_class<>'dr_bundle'
     ORDER BY p.id LIMIT ?`,
    [tenantId, tenantId, MAX_DESCRIPTORS + 1]
  );
  if (rows.length > MAX_DESCRIPTORS) invalid('backup_r2_catalog_list_limit');
  return rows.map((row) => {
    context.context.signal.throwIfAborted();
    if (
      !isObjectClass(row.object_class) ||
      !['IMPORT_ARTIFACTS', 'EXPORT_ARTIFACTS', 'SENSITIVE_DETAILS'].includes(row.bucket_binding) ||
      !row.object_key ||
      new TextEncoder().encode(row.object_key).length > 1024 ||
      (row.checksum_sha256 !== null && !SHA256.test(row.checksum_sha256)) ||
      integer(row.key_version, false) < 1 ||
      (row.total_bytes !== null && integer(row.total_bytes) < 0)
    )
      invalid();
    if (integer(row.shared_detail_count) > 0)
      invalid('backup_r2_catalog_shared_detail_requires_repack');
    const bucketBinding = row.bucket_binding as PortableR2BucketBinding;
    const catalogKind: TenantBackupR2CatalogKind = 'object_catalog_object';
    return {
      datasetId: 'artifacts.object_catalog_bodies',
      objectId: objectId(source.family, row.id),
      bucketBinding,
      objectKey: row.object_key,
      expectedStoredSha256: row.checksum_sha256,
      sourceEncoding:
        bucketBinding === 'IMPORT_ARTIFACTS'
          ? ('plaintext' as const)
          : ('object_artifact_v1' as const),
      context: {
        tenantId,
        catalogKind,
        objectClass: row.object_class,
        sourceKeyVersion: integer(row.key_version, false),
      },
    } as TenantBackupR2ObjectDescriptor;
  });
}

async function listLogObjects(
  context: AdapterContext,
  source: Source,
  tenantId: string,
  tenantKey: string
): Promise<TenantBackupR2ObjectDescriptor[]> {
  const rows = await source.database.query<LogObjectRow>(
    `SELECT l.id,l.log_type,l.plane,l.object_key,l.record_count,l.byte_count,
       l.checksum_sha256,l.compression,l.encryption_scope,l.key_version,l.created_at,
       count(i.record_id) AS index_count,min(i.event_at) AS first_event_at,
       max(i.event_at) AS last_event_at,min(i.chunk_id) AS first_chunk_id,
       max(i.chunk_id) AS last_chunk_id
     FROM log_object_catalog l LEFT JOIN log_chunk_record_index i
       ON i.object_catalog_id=l.id AND i.tenant_key=l.tenant_key
       AND i.log_type=l.log_type AND i.plane=l.plane AND i.status='committed'
     WHERE l.tenant_key=? AND l.status='committed' AND l.object_kind='chunk'
       AND l.deleted_at IS NULL
     GROUP BY l.id,l.log_type,l.plane,l.object_key,l.record_count,l.byte_count,
       l.checksum_sha256,l.compression,l.encryption_scope,l.key_version,l.created_at
     ORDER BY l.id LIMIT ?`,
    [tenantKey, MAX_DESCRIPTORS + 1]
  );
  if (rows.length > MAX_DESCRIPTORS) invalid('backup_r2_catalog_list_limit');
  const boundaryUnixMs = integer(context.context.operation.created_at);
  const window = tenantBackupLogWindow(context.selection.logs.period, boundaryUnixMs);
  const descriptors: TenantBackupR2ObjectDescriptor[] = [];
  for (const row of rows) {
    context.context.signal.throwIfAborted();
    if (
      !SAFE_ID.test(row.id) ||
      !LOG_TYPES.includes(row.log_type as (typeof LOG_TYPES)[number]) ||
      !LOG_PLANES.includes(row.plane as (typeof LOG_PLANES)[number]) ||
      !row.object_key ||
      !SHA256.test(row.checksum_sha256 ?? '') ||
      !LOG_CHUNK_COMPRESSION.includes(row.compression as (typeof LOG_CHUNK_COMPRESSION)[number]) ||
      integer(row.record_count, false) !== integer(row.index_count, false) ||
      integer(row.byte_count, false) < 1 ||
      row.first_event_at === null ||
      row.last_event_at === null ||
      row.first_chunk_id === null ||
      row.first_chunk_id !== row.last_chunk_id ||
      !SAFE_ID.test(row.first_chunk_id)
    )
      invalid();
    const selected = logTypeSelected(row.log_type, context, row.plane === 'sensitive_detail');
    if (!selected) continue;
    const first = integer(row.first_event_at);
    const last = integer(row.last_event_at);
    if (
      last > window.untilInclusiveUnixMs ||
      (window.fromInclusiveUnixMs !== null && first < window.fromInclusiveUnixMs)
    ) {
      if (
        first <= window.untilInclusiveUnixMs &&
        (window.fromInclusiveUnixMs === null || last >= window.fromInclusiveUnixMs)
      )
        invalid('backup_r2_catalog_log_window_requires_repack');
      continue;
    }
    const bucketBinding = bucketForPlane(row.plane);
    const encrypted = row.encryption_scope !== null || row.key_version !== null;
    if (encrypted && (!row.encryption_scope || integer(row.key_version, false) < 1)) invalid();
    descriptors.push({
      datasetId: 'logs.archive_object_bodies',
      objectId: objectId(source.family, row.id),
      bucketBinding,
      objectKey: row.object_key,
      expectedStoredSha256: row.checksum_sha256,
      sourceEncoding: encrypted ? 'log_chunk_v1' : 'plaintext',
      context: {
        tenantId,
        catalogKind: 'log_object',
        tenantKey,
        logType: row.log_type,
        plane: row.plane,
        chunkId: row.first_chunk_id,
        compression: row.compression,
        ...(encrypted
          ? { encryptionScope: row.encryption_scope, keyVersion: integer(row.key_version, false) }
          : {}),
      },
    } as TenantBackupR2ObjectDescriptor);
  }
  return descriptors;
}

/** List only tenant-owned, committed catalog rows from the sealed source inventory. */
export function createTenantBackupR2CatalogLister(input: { tenantKey: string }) {
  if (!SAFE_ID.test(input.tenantKey)) invalid();
  return async (
    context: AdapterContext,
    datasetId: PortableR2DatasetId
  ): Promise<readonly TenantBackupR2ObjectDescriptor[]> => {
    const tenantId = context.context.lease.tenantId;
    if (!SAFE_ID.test(tenantId)) invalid();
    const listed = (
      await Promise.all(
        sources(context).map((source) =>
          datasetId === 'artifacts.object_catalog_bodies'
            ? listObjectCatalog(context, source, tenantId)
            : listLogObjects(context, source, tenantId, input.tenantKey)
        )
      )
    ).flat();
    if (listed.length > MAX_DESCRIPTORS) invalid('backup_r2_catalog_list_limit');
    const ids = listed.map(({ objectId: id }) => id);
    if (new Set(ids).size !== ids.length) invalid('backup_r2_catalog_duplicate_identity');
    return listed.sort((left, right) => left.objectId.localeCompare(right.objectId));
  };
}
