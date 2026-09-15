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

type Database = Pick<DatabaseAdapter, 'query' | 'batch' | 'getType'>;
type Family = 'core' | 'admin';
type CatalogKind = 'object_catalog_object' | 'log_object' | 'log_manifest';
const SHA256 = /^[a-f0-9]{64}$/u;

function invalid(): never {
  throw new Error('backup_r2_catalog_finalize_invalid');
}

async function sha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function identity(source: PortableR2ObjectChunk): {
  family: Family;
  databaseId: string;
  rowId: string;
} {
  const familySeparator = source.objectId.indexOf(':');
  const databaseSeparator = source.objectId.indexOf(':', familySeparator + 1);
  const family = source.objectId.slice(0, familySeparator);
  const databaseId = source.objectId.slice(familySeparator + 1, databaseSeparator);
  const rowId = source.objectId.slice(databaseSeparator + 1);
  if (
    familySeparator < 1 ||
    databaseSeparator <= familySeparator + 1 ||
    (family !== 'core' && family !== 'admin') ||
    !/^[A-Za-z0-9_.:-]{1,256}$/u.test(databaseId) ||
    !/^[A-Za-z0-9_.:-]{1,256}$/u.test(rowId)
  )
    invalid();
  return { family, databaseId, rowId };
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
  if (
    source.sourceEncoding === 'log_chunk_records_v1' &&
    (!restored.logRecords ||
      restored.logRecords.length < 1 ||
      restored.logRecords.length > 10_000 ||
      new Set(restored.logRecords.map(({ recordId }) => recordId)).size !==
        restored.logRecords.length ||
      restored.logRecords.some(
        (record) =>
          !/^[A-Za-z0-9_.:-]{1,256}$/u.test(record.recordId) ||
          !SHA256.test(record.sourceMetadataSha256) ||
          !Number.isSafeInteger(record.lineNumber) ||
          record.lineNumber < 0 ||
          !Number.isSafeInteger(record.blockOffset) ||
          record.blockOffset < 0 ||
          !Number.isSafeInteger(record.blockLength) ||
          record.blockLength < 1 ||
          !Number.isSafeInteger(record.recordOffset) ||
          record.recordOffset < 0 ||
          !Number.isSafeInteger(record.recordLength) ||
          record.recordLength < 1
      ))
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
  record_count?: number;
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
      (restored.logRecords == null || row.record_count === restored.logRecords.length) &&
      (restored.keyVersion === null || row.key_version === restored.keyVersion) &&
      (restored.encryptionScope === null || row.encryption_scope === restored.encryptionScope)
    );
  return row.manifest_object_key === restored.objectKey;
}

function contextString(source: PortableR2ObjectChunk, key: string): string {
  const value = source.context[key];
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/u.test(value)) invalid();
  return value;
}

function mappedLogRecordUpdateSql(database: Database): string {
  if (database.getType() === 'postgres')
    return `WITH mapped AS (
      SELECT "recordId" AS record_id,"lineNumber" AS line_number,
        "blockOffset" AS block_offset,"blockLength" AS block_length,
        "recordOffset" AS record_offset,"recordLength" AS record_length
      FROM json_to_recordset(?::json) AS value(
        "recordId" text,"sourceMetadataSha256" text,"lineNumber" bigint,
        "blockOffset" bigint,"blockLength" bigint,"recordOffset" bigint,"recordLength" bigint
      )
    )
    UPDATE log_chunk_record_index AS target SET
      line_number=mapped.line_number,block_offset=mapped.block_offset,
      block_length=mapped.block_length,record_offset=mapped.record_offset,
      record_length=mapped.record_length
    FROM mapped
    WHERE target.object_catalog_id=? AND target.tenant_key=? AND target.log_type=?
      AND target.plane=? AND target.chunk_id=? AND target.status='committed'
      AND target.record_id=mapped.record_id`;
  if (database.getType() !== 'd1') invalid();
  return `WITH mapped AS (
    SELECT json_extract(value,'$.recordId') AS record_id,
      json_extract(value,'$.lineNumber') AS line_number,
      json_extract(value,'$.blockOffset') AS block_offset,
      json_extract(value,'$.blockLength') AS block_length,
      json_extract(value,'$.recordOffset') AS record_offset,
      json_extract(value,'$.recordLength') AS record_length
    FROM json_each(?)
  )
  UPDATE log_chunk_record_index AS target SET
    line_number=(SELECT line_number FROM mapped WHERE record_id=target.record_id),
    block_offset=(SELECT block_offset FROM mapped WHERE record_id=target.record_id),
    block_length=(SELECT block_length FROM mapped WHERE record_id=target.record_id),
    record_offset=(SELECT record_offset FROM mapped WHERE record_id=target.record_id),
    record_length=(SELECT record_length FROM mapped WHERE record_id=target.record_id)
  WHERE target.object_catalog_id=? AND target.tenant_key=? AND target.log_type=?
    AND target.plane=? AND target.chunk_id=? AND target.status='committed'
    AND EXISTS(SELECT 1 FROM mapped WHERE record_id=target.record_id)`;
}

async function verifyLogRecords(
  db: Database,
  source: PortableR2ObjectChunk,
  rowId: string,
  restored: RestoredTenantR2Object
): Promise<boolean> {
  if (source.sourceEncoding !== 'log_chunk_records_v1') return true;
  const expected = restored.logRecords ?? invalid();
  const rows = await db.query<{
    record_id: string;
    line_number: number;
    block_offset: number;
    block_length: number;
    record_offset: number;
    record_length: number;
    event_at: number;
    surface: string | null;
    index_profile: string;
    indexed_fields: string | null;
    created_at: number;
  }>(
    `SELECT record_id,line_number,block_offset,block_length,record_offset,record_length,
       event_at,surface,index_profile,indexed_fields,created_at
     FROM log_chunk_record_index
     WHERE object_catalog_id=? AND tenant_key=? AND log_type=? AND plane=? AND chunk_id=?
       AND status='committed' ORDER BY record_id`,
    [
      rowId,
      tenantKey(source),
      contextString(source, 'logType'),
      contextString(source, 'plane'),
      contextString(source, 'chunkId'),
    ]
  );
  const sorted = [...expected].sort((left, right) => left.recordId.localeCompare(right.recordId));
  if (rows.length !== sorted.length) return false;
  for (const [index, row] of rows.entries()) {
    const item = sorted[index];
    if (
      item === undefined ||
      row.record_id !== item.recordId ||
      row.line_number !== item.lineNumber ||
      row.block_offset !== item.blockOffset ||
      row.block_length !== item.blockLength ||
      row.record_offset !== item.recordOffset ||
      row.record_length !== item.recordLength ||
      (await sha256(
        JSON.stringify({
          recordId: row.record_id,
          eventAt: row.event_at,
          surface: row.surface,
          indexProfile: row.index_profile,
          indexedFields: row.indexed_fields,
          createdAt: row.created_at,
        })
      )) !== item.sourceMetadataSha256
    )
      return false;
  }
  return true;
}

async function verifySensitiveDetail(
  db: Database,
  context: TenantBackupStepContext,
  source: PortableR2ObjectChunk,
  restored: RestoredTenantR2Object
): Promise<boolean> {
  if (source.sourceEncoding !== 'sensitive_detail_record_v1') return true;
  const catalogId = contextString(source, 'catalogId');
  const objectClass = contextString(source, 'objectClass');
  if (restored.storedBytes < 2 || restored.keyVersion === null) return false;
  const rows = await db.query<{
    object_key: string;
    content_encoding: string;
    line_number: number;
    byte_offset: number | null;
    byte_length: number | null;
    key_version: number;
    checksum_sha256: string | null;
  }>(
    `SELECT object_key,content_encoding,line_number,byte_offset,byte_length,key_version,
       checksum_sha256 FROM sensitive_detail_chunk_index
     WHERE catalog_id=? AND tenant_id=? AND object_class=? AND deleted_at IS NULL`,
    [catalogId, context.lease.tenantId, objectClass]
  );
  return (
    rows.length === 1 &&
    rows[0]?.object_key === restored.objectKey &&
    rows[0].content_encoding === 'none' &&
    rows[0].line_number === 0 &&
    rows[0].byte_offset === 0 &&
    rows[0].byte_length === restored.storedBytes - 1 &&
    rows[0].key_version === restored.keyVersion &&
    rows[0].checksum_sha256 === restored.storedSha256
  );
}

/** Atomically retarget restored catalog rows inside the unpublished Core/Admin databases. */
export function createTenantBackupR2CatalogFinalizer(input: {
  resolveAdmin(
    context: TenantBackupStepContext,
    planDigest: string,
    sourceDatabaseId: string
  ): Promise<Database>;
  resolveCore(
    context: TenantBackupStepContext,
    planDigest: string,
    sourceDatabaseId: string
  ): Promise<Database>;
}): TenantBackupR2ObjectFinalizer {
  const database = (
    context: TenantBackupStepContext,
    planDigest: string,
    family: Family,
    sourceDatabaseId: string
  ): Promise<Database> =>
    family === 'admin'
      ? input.resolveAdmin(context, planDigest, sourceDatabaseId)
      : input.resolveCore(context, planDigest, sourceDatabaseId);

  const read = async (
    context: TenantBackupStepContext,
    planDigest: string,
    source: PortableR2ObjectChunk
  ): Promise<CatalogRow> => {
    const target = identity(source);
    const db = await database(context, planDigest, target.family, target.databaseId);
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
        `SELECT id,object_key,record_count,byte_count,checksum_sha256,encryption_scope,key_version
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
      const db = await database(context, planDigest, target.family, target.databaseId);
      const kind = catalogKind(source);
      let rows: CatalogRow[];
      if (kind === 'object_catalog_object') {
        const objectUpdate = {
          sql: `UPDATE object_catalog_objects AS p SET bucket_binding=?,object_key=?,
            key_version=coalesce(?,key_version),checksum_sha256=?,total_bytes=?
            WHERE p.id=? AND p.object_key IN (?,?) AND p.deleted_at IS NULL
              AND (? IS NULL OR p.catalog_id=?)
              AND EXISTS(SELECT 1 FROM object_catalog c WHERE c.id=p.catalog_id
                AND c.tenant_id=? AND c.deleted_at IS NULL)`,
          params: [
            restored.bucketBinding,
            restored.objectKey,
            restored.keyVersion,
            restored.storedSha256,
            restored.storedBytes,
            target.rowId,
            source.objectKey,
            restored.objectKey,
            source.sourceEncoding === 'sensitive_detail_record_v1'
              ? contextString(source, 'catalogId')
              : null,
            source.sourceEncoding === 'sensitive_detail_record_v1'
              ? contextString(source, 'catalogId')
              : null,
            context.lease.tenantId,
          ],
        };
        if (source.sourceEncoding === 'sensitive_detail_record_v1') {
          if (restored.storedBytes < 2 || restored.keyVersion === null) invalid();
          const results = await db.batch([
            objectUpdate,
            {
              sql: `UPDATE sensitive_detail_chunk_index SET object_key=?,content_encoding='none',
                line_number=0,byte_offset=0,byte_length=?,key_version=?,checksum_sha256=?,
                deleted_at=NULL
                WHERE catalog_id=? AND tenant_id=? AND object_class=?
                  AND object_key IN (?,?)`,
              params: [
                restored.objectKey,
                restored.storedBytes - 1,
                restored.keyVersion,
                restored.storedSha256,
                contextString(source, 'catalogId'),
                context.lease.tenantId,
                contextString(source, 'objectClass'),
                source.objectKey,
                restored.objectKey,
              ],
            },
          ]);
          if (
            results.length !== 2 ||
            results.some(({ success }) => !success) ||
            results.some(({ rowsAffected }) => rowsAffected !== 1)
          )
            invalid();
          rows = [await read(context, planDigest, source)];
        } else {
          rows = await db.query<CatalogRow>(
            `${objectUpdate.sql}
             RETURNING id,bucket_binding,object_key,key_version,checksum_sha256,total_bytes`,
            objectUpdate.params
          );
        }
      } else if (kind === 'log_object') {
        if (source.sourceEncoding === 'log_chunk_records_v1') {
          const logRecords = restored.logRecords ?? invalid();
          const mappings = JSON.stringify(logRecords);
          const logType = contextString(source, 'logType');
          const plane = contextString(source, 'plane');
          const chunkId = contextString(source, 'chunkId');
          const results = await db.batch([
            {
              sql: `UPDATE log_object_catalog SET object_key=?,record_count=?,byte_count=?,
                checksum_sha256=?,encryption_scope=?,key_version=?
                WHERE id=? AND tenant_key=? AND log_type=? AND plane=?
                  AND object_key IN (?,?) AND deleted_at IS NULL`,
              params: [
                restored.objectKey,
                logRecords.length,
                restored.storedBytes,
                restored.storedSha256,
                restored.encryptionScope,
                restored.keyVersion,
                target.rowId,
                tenantKey(source),
                logType,
                plane,
                source.objectKey,
                restored.objectKey,
              ],
            },
            {
              sql: mappedLogRecordUpdateSql(db),
              params: [mappings, target.rowId, tenantKey(source), logType, plane, chunkId],
            },
            {
              sql: `UPDATE log_chunk_manifests SET status='repair_needed'
                WHERE tenant_key=? AND log_type=? AND plane=? AND status='committed'`,
              params: [tenantKey(source), logType, plane],
            },
          ]);
          if (
            results.length !== 3 ||
            results.some(({ success }) => !success) ||
            results[0]?.rowsAffected !== 1 ||
            results[1]?.rowsAffected !== logRecords.length
          )
            invalid();
          rows = [await read(context, planDigest, source)];
        } else {
          rows = await db.query<CatalogRow>(
            `UPDATE log_object_catalog SET object_key=?,byte_count=?,checksum_sha256=?,
               encryption_scope=coalesce(?,encryption_scope),key_version=coalesce(?,key_version)
             WHERE id=? AND tenant_key=? AND object_key IN (?,?) AND deleted_at IS NULL
             RETURNING id,object_key,record_count,byte_count,checksum_sha256,encryption_scope,key_version`,
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
        }
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
      if (!(await verifyLogRecords(db, source, target.rowId, restored))) invalid();
      if (!(await verifySensitiveDetail(db, context, source, restored))) invalid();
      context.signal.throwIfAborted();
    },
    async verify(context, planDigest, datasetId, source, restored) {
      validate(context, planDigest, datasetId, source, restored);
      context.signal.throwIfAborted();
      const target = identity(source);
      const db = await database(context, planDigest, target.family, target.databaseId);
      return (
        matches(catalogKind(source), await read(context, planDigest, source), restored) &&
        (await verifyLogRecords(db, source, target.rowId, restored)) &&
        (await verifySensitiveDetail(db, context, source, restored))
      );
    },
  };
}
