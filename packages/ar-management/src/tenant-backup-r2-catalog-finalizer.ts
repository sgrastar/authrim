import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import type {
  PortableR2DatasetId,
  PortableR2ObjectChunk,
} from '@authrim/ar-lib-core/services/tenant-portability/portable-r2-object';
import type {
  RestoredTenantR2Object,
  TenantBackupR2ObjectFinalizer,
} from './tenant-backup-r2-object-restore-port';

type Database = Pick<DatabaseAdapter, 'query'>;
type Family = 'core' | 'admin';
type CatalogKind = 'object_catalog_object' | 'log_object' | 'log_manifest';
const SHA256 = /^[a-f0-9]{64}$/u;

function invalid(): never {
  throw new Error('backup_r2_catalog_finalize_invalid');
}

function identity(source: PortableR2ObjectChunk): { family: Family; rowId: string } {
  const separator = source.objectId.indexOf(':');
  const family = source.objectId.slice(0, separator);
  const rowId = source.objectId.slice(separator + 1);
  if (
    separator < 1 ||
    (family !== 'core' && family !== 'admin') ||
    !/^[A-Za-z0-9_.:-]{1,256}$/u.test(rowId)
  )
    invalid();
  return { family, rowId };
}

function catalogKind(source: PortableR2ObjectChunk): CatalogKind {
  const value = source.context.catalogKind;
  if (!['object_catalog_object', 'log_object', 'log_manifest'].includes(String(value))) invalid();
  return value as CatalogKind;
}

function tenantKey(source: PortableR2ObjectChunk): string {
  const value = source.context.tenantKey;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/u.test(value)) invalid();
  return value;
}

function validate(
  context: TenantBackupStepContext,
  planDigest: string,
  datasetId: PortableR2DatasetId,
  source: PortableR2ObjectChunk,
  restored: RestoredTenantR2Object
): void {
  if (
    !SHA256.test(planDigest) ||
    source.tenantId !== context.lease.tenantId ||
    restored.bucketBinding !== source.bucketBinding ||
    restored.objectKey === source.objectKey ||
    !restored.objectKey ||
    !restored.version ||
    !restored.etag ||
    !SHA256.test(restored.storedSha256) ||
    !Number.isSafeInteger(restored.storedBytes) ||
    restored.storedBytes < 0 ||
    (datasetId === 'artifacts.object_catalog_bodies' &&
      catalogKind(source) !== 'object_catalog_object') ||
    (catalogKind(source) === 'log_object' && datasetId !== 'logs.archive_object_bodies') ||
    (catalogKind(source) === 'log_manifest' && datasetId !== 'logs.archive_object_bodies')
  )
    invalid();
}

interface CatalogRow {
  id: string;
  object_key: string;
  bucket_binding?: string;
  key_version?: number | null;
  checksum_sha256: string | null;
  total_bytes?: number | null;
  byte_count?: number;
  encryption_scope?: string | null;
  manifest_object_key?: string;
}

function matches(kind: CatalogKind, row: CatalogRow, restored: RestoredTenantR2Object): boolean {
  if (row.checksum_sha256 !== restored.storedSha256) return false;
  if (kind === 'object_catalog_object')
    return (
      row.object_key === restored.objectKey &&
      row.bucket_binding === restored.bucketBinding &&
      row.total_bytes === restored.storedBytes &&
      (restored.keyVersion === null || row.key_version === restored.keyVersion)
    );
  if (kind === 'log_object')
    return (
      row.object_key === restored.objectKey &&
      row.byte_count === restored.storedBytes &&
      (restored.keyVersion === null || row.key_version === restored.keyVersion) &&
      (restored.encryptionScope === null || row.encryption_scope === restored.encryptionScope)
    );
  return row.manifest_object_key === restored.objectKey;
}

/** Atomically retarget restored catalog rows inside the unpublished Core/Admin databases. */
export function createTenantBackupR2CatalogFinalizer(input: {
  resolveAdmin(context: TenantBackupStepContext, planDigest: string): Promise<Database>;
  resolveCore(context: TenantBackupStepContext, planDigest: string): Promise<Database>;
}): TenantBackupR2ObjectFinalizer {
  const database = (
    context: TenantBackupStepContext,
    planDigest: string,
    family: Family
  ): Promise<Database> =>
    family === 'admin'
      ? input.resolveAdmin(context, planDigest)
      : input.resolveCore(context, planDigest);

  const read = async (
    context: TenantBackupStepContext,
    planDigest: string,
    source: PortableR2ObjectChunk
  ): Promise<CatalogRow> => {
    const target = identity(source);
    const db = await database(context, planDigest, target.family);
    const kind = catalogKind(source);
    let rows: CatalogRow[];
    if (kind === 'object_catalog_object') {
      rows = await db.query<CatalogRow>(
        `SELECT p.id,p.bucket_binding,p.object_key,p.key_version,p.checksum_sha256,p.total_bytes
         FROM object_catalog_objects p JOIN object_catalog c ON c.id=p.catalog_id
         WHERE p.id=? AND c.tenant_id=? AND p.deleted_at IS NULL AND c.deleted_at IS NULL`,
        [target.rowId, context.lease.tenantId]
      );
    } else if (kind === 'log_object') {
      rows = await db.query<CatalogRow>(
        `SELECT id,object_key,byte_count,checksum_sha256,encryption_scope,key_version
         FROM log_object_catalog WHERE id=? AND tenant_key=? AND deleted_at IS NULL`,
        [target.rowId, tenantKey(source)]
      );
    } else {
      rows = await db.query<CatalogRow>(
        `SELECT id,manifest_object_key,checksum_sha256 FROM log_chunk_manifests
         WHERE id=? AND tenant_key=?`,
        [target.rowId, tenantKey(source)]
      );
    }
    if (rows.length !== 1) invalid();
    return rows[0];
  };

  return {
    async finalize(context, planDigest, datasetId, source, restored) {
      validate(context, planDigest, datasetId, source, restored);
      context.signal.throwIfAborted();
      const target = identity(source);
      const db = await database(context, planDigest, target.family);
      const kind = catalogKind(source);
      let rows: CatalogRow[];
      if (kind === 'object_catalog_object') {
        rows = await db.query<CatalogRow>(
          `UPDATE object_catalog_objects AS p SET bucket_binding=?,object_key=?,
             key_version=coalesce(?,key_version),checksum_sha256=?,total_bytes=?
           WHERE p.id=? AND p.object_key IN (?,?) AND p.deleted_at IS NULL
             AND EXISTS(SELECT 1 FROM object_catalog c WHERE c.id=p.catalog_id
               AND c.tenant_id=? AND c.deleted_at IS NULL)
           RETURNING id,bucket_binding,object_key,key_version,checksum_sha256,total_bytes`,
          [
            restored.bucketBinding,
            restored.objectKey,
            restored.keyVersion,
            restored.storedSha256,
            restored.storedBytes,
            target.rowId,
            source.objectKey,
            restored.objectKey,
            context.lease.tenantId,
          ]
        );
      } else if (kind === 'log_object') {
        rows = await db.query<CatalogRow>(
          `UPDATE log_object_catalog SET object_key=?,byte_count=?,checksum_sha256=?,
             encryption_scope=coalesce(?,encryption_scope),key_version=coalesce(?,key_version)
           WHERE id=? AND tenant_key=? AND object_key IN (?,?) AND deleted_at IS NULL
           RETURNING id,object_key,byte_count,checksum_sha256,encryption_scope,key_version`,
          [
            restored.objectKey,
            restored.storedBytes,
            restored.storedSha256,
            restored.encryptionScope,
            restored.keyVersion,
            target.rowId,
            tenantKey(source),
            source.objectKey,
            restored.objectKey,
          ]
        );
      } else {
        rows = await db.query<CatalogRow>(
          `UPDATE log_chunk_manifests SET manifest_object_key=?,checksum_sha256=?
           WHERE id=? AND tenant_key=? AND manifest_object_key IN (?,?)
           RETURNING id,manifest_object_key,checksum_sha256`,
          [
            restored.objectKey,
            restored.storedSha256,
            target.rowId,
            tenantKey(source),
            source.objectKey,
            restored.objectKey,
          ]
        );
      }
      if (rows.length !== 1 || !matches(kind, rows[0], restored)) invalid();
      context.signal.throwIfAborted();
    },
    async verify(context, planDigest, datasetId, source, restored) {
      validate(context, planDigest, datasetId, source, restored);
      context.signal.throwIfAborted();
      return matches(catalogKind(source), await read(context, planDigest, source), restored);
    },
  };
}
