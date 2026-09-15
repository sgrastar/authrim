import type { DatabaseAdapter } from '../../db/adapter.js';
import {
  TENANT_BACKUP_R2_CHUNK_BYTES,
  TENANT_BACKUP_R2_MAX_CHUNKS,
  type PortableR2BucketBinding,
  type PortableR2DatasetId,
  type PortableR2ObjectChunk,
} from './portable-r2-object.js';

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,256}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const LIVE_OPERATION = `EXISTS (SELECT 1 FROM tenant_backup_operations o
  WHERE o.id=? AND o.tenant_id=? AND o.kind='import' AND o.state='running'
  AND o.lease_owner=? AND o.fencing_token=? AND o.lease_expires_at>? AND o.updated_at<=?)`;

export interface TenantBackupR2RestoreObject {
  operation_id: string;
  tenant_id: string;
  dataset_id: PortableR2DatasetId;
  object_id: string;
  source_object_key: string;
  source_encoding: PortableR2ObjectChunk['sourceEncoding'];
  write_mode: 'multipart' | 'staged';
  target_bucket_binding: PortableR2BucketBinding;
  target_object_key: string;
  object_sha256: string;
  total_bytes: number;
  chunk_count: number;
  context_json: string;
  http_metadata_json: string | null;
  custom_metadata_json: string | null;
  multipart_id: string | null;
  state: 'allocating' | 'uploading' | 'completing' | 'completed' | 'cancelling' | 'deleted';
  object_version: string | null;
  object_etag: string | null;
  stored_sha256: string | null;
  target_key_version: number | null;
  target_encryption_scope: string | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface TenantBackupR2RestorePart {
  chunk_index: number;
  byte_count: number;
  chunk_sha256: string;
  target_part_etag: string | null;
  staging_object_key: string | null;
}

interface Owner {
  operationId: string;
  tenantId: string;
  leaseOwner: string;
  fencingToken: number;
  datasetId: PortableR2DatasetId;
  objectId: string;
}

function invalid(): never {
  throw new Error('backup_r2_restore_store_invalid');
}

function timestamp(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) invalid();
}

function identifiers(owner: Owner): void {
  if (
    !SAFE_ID.test(owner.operationId) ||
    !SAFE_ID.test(owner.tenantId) ||
    !SAFE_ID.test(owner.leaseOwner) ||
    !Number.isSafeInteger(owner.fencingToken) ||
    owner.fencingToken <= 0 ||
    !SAFE_ID.test(owner.objectId) ||
    !['artifacts.object_catalog_bodies', 'logs.archive_object_bodies'].includes(owner.datasetId)
  )
    invalid();
}

function json(value: Readonly<Record<string, unknown>> | null): string | null {
  if (value === null) return null;
  const result = JSON.stringify(value);
  if (new TextEncoder().encode(result).length > 8192) invalid();
  return result;
}

function ownerFrom(input: Owner): Owner {
  const owner = { ...input };
  identifiers(owner);
  return owner;
}

function live(owner: Owner, now: number): unknown[] {
  timestamp(now);
  return [owner.operationId, owner.tenantId, owner.leaseOwner, owner.fencingToken, now, now];
}

/** Durable identity and chunk receipts for one unpublished target R2 object. */
export class TenantBackupR2RestoreStore {
  constructor(private readonly database: Pick<DatabaseAdapter, 'query' | 'queryOne'>) {}

  async create(
    ownerInput: Owner,
    input: {
      chunk: PortableR2ObjectChunk;
      writeMode: 'multipart' | 'staged';
      targetBucketBinding: PortableR2BucketBinding;
      targetObjectKey: string;
      now: number;
    }
  ): Promise<TenantBackupR2RestoreObject> {
    const owner = ownerFrom(ownerInput);
    timestamp(input.now);
    if (
      input.chunk.tenantId !== owner.tenantId ||
      input.chunk.objectId !== owner.objectId ||
      input.chunk.chunkCount > TENANT_BACKUP_R2_MAX_CHUNKS ||
      input.chunk.objectSha256.length !== 64 ||
      !SHA256.test(input.chunk.objectSha256) ||
      !['multipart', 'staged'].includes(input.writeMode) ||
      !input.targetObjectKey ||
      input.targetObjectKey === input.chunk.objectKey ||
      new TextEncoder().encode(input.targetObjectKey).length > 1024
    )
      invalid();
    const contextJson = json(input.chunk.context) ?? invalid();
    const httpMetadataJson = json(input.chunk.httpMetadata);
    const customMetadataJson = json(input.chunk.customMetadata);
    await this.database.queryOne(
      `INSERT INTO tenant_backup_r2_restore_objects(
        operation_id,tenant_id,dataset_id,object_id,source_object_key,source_encoding,write_mode,
        target_bucket_binding,target_object_key,object_sha256,total_bytes,chunk_count,
        context_json,http_metadata_json,custom_metadata_json,created_at,updated_at
      ) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
        FROM tenant_backup_operations
        WHERE id=? AND tenant_id=? AND kind='import' AND state='running'
          AND lease_owner=? AND fencing_token=? AND lease_expires_at>? AND updated_at<=?
      ON CONFLICT(operation_id,dataset_id,object_id) DO NOTHING RETURNING object_id`,
      [
        owner.operationId,
        owner.tenantId,
        owner.datasetId,
        owner.objectId,
        input.chunk.objectKey,
        input.chunk.sourceEncoding,
        input.writeMode,
        input.targetBucketBinding,
        input.targetObjectKey,
        input.chunk.objectSha256,
        input.chunk.totalBytes,
        input.chunk.chunkCount,
        contextJson,
        httpMetadataJson,
        customMetadataJson,
        input.now,
        input.now,
        ...live(owner, input.now),
      ]
    );
    const saved = await this.get(owner, input.now);
    if (
      saved.source_object_key !== input.chunk.objectKey ||
      saved.source_encoding !== input.chunk.sourceEncoding ||
      saved.write_mode !== input.writeMode ||
      saved.target_bucket_binding !== input.targetBucketBinding ||
      saved.target_object_key !== input.targetObjectKey ||
      saved.object_sha256 !== input.chunk.objectSha256 ||
      saved.total_bytes !== input.chunk.totalBytes ||
      saved.chunk_count !== input.chunk.chunkCount ||
      saved.context_json !== contextJson ||
      saved.http_metadata_json !== httpMetadataJson ||
      saved.custom_metadata_json !== customMetadataJson
    )
      invalid();
    return saved;
  }

  async get(ownerInput: Owner, now: number): Promise<TenantBackupR2RestoreObject> {
    const owner = ownerFrom(ownerInput);
    timestamp(now);
    const row = await this.database.queryOne<TenantBackupR2RestoreObject>(
      `SELECT * FROM tenant_backup_r2_restore_objects
       WHERE operation_id=? AND tenant_id=? AND dataset_id=? AND object_id=? AND state!='deleted'
         AND ${LIVE_OPERATION}`,
      [owner.operationId, owner.tenantId, owner.datasetId, owner.objectId, ...live(owner, now)]
    );
    return row ?? invalid();
  }

  async attachMultipart(ownerInput: Owner, multipartId: string, now: number): Promise<void> {
    const owner = ownerFrom(ownerInput);
    timestamp(now);
    if (!multipartId || multipartId.length > 1024) invalid();
    const current = await this.get(owner, now);
    if (current.write_mode !== 'multipart') invalid();
    await this.database.queryOne(
      `UPDATE tenant_backup_r2_restore_objects
       SET multipart_id=?,state='uploading',updated_at=?
       WHERE operation_id=? AND tenant_id=? AND dataset_id=? AND object_id=?
         AND state='allocating' AND multipart_id IS NULL AND write_mode='multipart'
         AND ${LIVE_OPERATION} RETURNING object_id`,
      [
        multipartId,
        now,
        owner.operationId,
        owner.tenantId,
        owner.datasetId,
        owner.objectId,
        ...live(owner, now),
      ]
    );
    const saved = await this.get(owner, now);
    if (saved.multipart_id !== multipartId || saved.state !== 'uploading') invalid();
  }

  async beginStaging(ownerInput: Owner, now: number): Promise<void> {
    const owner = ownerFrom(ownerInput);
    timestamp(now);
    await this.database.queryOne(
      `UPDATE tenant_backup_r2_restore_objects
       SET state='uploading',updated_at=?
       WHERE operation_id=? AND tenant_id=? AND dataset_id=? AND object_id=?
         AND state='allocating' AND multipart_id IS NULL AND write_mode='staged'
         AND ${LIVE_OPERATION} RETURNING object_id`,
      [now, owner.operationId, owner.tenantId, owner.datasetId, owner.objectId, ...live(owner, now)]
    );
    const saved = await this.get(owner, now);
    if (saved.write_mode !== 'staged' || saved.multipart_id !== null || saved.state !== 'uploading')
      invalid();
  }

  async reservePart(
    ownerInput: Owner,
    input: { chunkIndex: number; byteCount: number; sha256: string; now: number }
  ): Promise<TenantBackupR2RestorePart> {
    const owner = ownerFrom(ownerInput);
    timestamp(input.now);
    const object = await this.get(owner, input.now);
    const expectedBytes =
      input.chunkIndex + 1 < object.chunk_count
        ? TENANT_BACKUP_R2_CHUNK_BYTES
        : object.total_bytes - input.chunkIndex * TENANT_BACKUP_R2_CHUNK_BYTES;
    if (
      object.state !== 'uploading' ||
      !Number.isSafeInteger(input.chunkIndex) ||
      input.chunkIndex < 0 ||
      input.chunkIndex >= object.chunk_count ||
      input.byteCount !== expectedBytes ||
      !SHA256.test(input.sha256)
    )
      invalid();
    await this.database.queryOne(
      `INSERT INTO tenant_backup_r2_restore_parts(
        operation_id,dataset_id,object_id,chunk_index,byte_count,chunk_sha256,created_at,updated_at
      ) SELECT ?,?,?,?,?,?,?,? WHERE ${LIVE_OPERATION}
      ON CONFLICT(operation_id,dataset_id,object_id,chunk_index) DO NOTHING RETURNING chunk_index`,
      [
        owner.operationId,
        owner.datasetId,
        owner.objectId,
        input.chunkIndex,
        input.byteCount,
        input.sha256,
        input.now,
        input.now,
        ...live(owner, input.now),
      ]
    );
    const saved = await this.database.queryOne<TenantBackupR2RestorePart>(
      `SELECT chunk_index,byte_count,chunk_sha256,target_part_etag,staging_object_key
       FROM tenant_backup_r2_restore_parts
       WHERE operation_id=? AND dataset_id=? AND object_id=? AND chunk_index=?
         AND ${LIVE_OPERATION}`,
      [
        owner.operationId,
        owner.datasetId,
        owner.objectId,
        input.chunkIndex,
        ...live(owner, input.now),
      ]
    );
    if (!saved || saved.byte_count !== input.byteCount || saved.chunk_sha256 !== input.sha256)
      invalid();
    return saved;
  }

  async acknowledgePart(
    ownerInput: Owner,
    input: {
      chunkIndex: number;
      byteCount: number;
      sha256: string;
      targetPartEtag?: string;
      stagingObjectKey?: string;
      now: number;
    }
  ): Promise<void> {
    const owner = ownerFrom(ownerInput);
    const object = await this.get(owner, input.now);
    if (
      Boolean(input.targetPartEtag) === Boolean(input.stagingObjectKey) ||
      (input.targetPartEtag?.length ?? input.stagingObjectKey?.length ?? 0) > 1024
    )
      invalid();
    const part = await this.reservePart(owner, input);
    if (
      (object.write_mode === 'multipart' && !input.targetPartEtag) ||
      (object.write_mode === 'staged' && !input.stagingObjectKey)
    )
      invalid();
    const targetPartEtag = input.targetPartEtag ?? null;
    const stagingObjectKey = input.stagingObjectKey ?? null;
    if (
      (part.target_part_etag !== null && part.target_part_etag !== targetPartEtag) ||
      (part.staging_object_key !== null && part.staging_object_key !== stagingObjectKey)
    )
      invalid();
    await this.database.queryOne(
      `UPDATE tenant_backup_r2_restore_parts
       SET target_part_etag=?,staging_object_key=?,updated_at=?
       WHERE operation_id=? AND dataset_id=? AND object_id=? AND chunk_index=?
         AND target_part_etag IS NULL AND staging_object_key IS NULL
         AND ${LIVE_OPERATION} RETURNING chunk_index`,
      [
        targetPartEtag,
        stagingObjectKey,
        input.now,
        owner.operationId,
        owner.datasetId,
        owner.objectId,
        input.chunkIndex,
        ...live(owner, input.now),
      ]
    );
    const saved = await this.reservePart(owner, input);
    if (saved.target_part_etag !== targetPartEtag || saved.staging_object_key !== stagingObjectKey)
      invalid();
  }

  async prepareCompletion(
    ownerInput: Owner,
    now: number
  ): Promise<{
    object: TenantBackupR2RestoreObject;
    parts: TenantBackupR2RestorePart[];
  }> {
    const owner = ownerFrom(ownerInput);
    timestamp(now);
    let object = await this.get(owner, now);
    if (!['uploading', 'completing', 'completed'].includes(object.state)) invalid();
    const parts = await this.database.query<TenantBackupR2RestorePart>(
      `SELECT chunk_index,byte_count,chunk_sha256,target_part_etag,staging_object_key
       FROM tenant_backup_r2_restore_parts
       WHERE operation_id=? AND dataset_id=? AND object_id=? AND ${LIVE_OPERATION}
       ORDER BY chunk_index`,
      [owner.operationId, owner.datasetId, owner.objectId, ...live(owner, now)]
    );
    if (
      parts.length !== object.chunk_count ||
      parts.some(
        (part, index) =>
          part.chunk_index !== index ||
          (object.write_mode === 'multipart'
            ? part.target_part_etag === null || part.staging_object_key !== null
            : part.staging_object_key === null || part.target_part_etag !== null)
      ) ||
      parts.reduce((sum, part) => sum + part.byte_count, 0) !== object.total_bytes
    )
      invalid();
    if (object.state === 'uploading') {
      await this.database.queryOne(
        `UPDATE tenant_backup_r2_restore_objects SET state='completing',updated_at=?
         WHERE operation_id=? AND tenant_id=? AND dataset_id=? AND object_id=? AND state='uploading'
           AND ${LIVE_OPERATION}
         RETURNING object_id`,
        [
          now,
          owner.operationId,
          owner.tenantId,
          owner.datasetId,
          owner.objectId,
          ...live(owner, now),
        ]
      );
      object = await this.get(owner, now);
    }
    if (!['completing', 'completed'].includes(object.state)) invalid();
    return { object, parts };
  }

  async markCompleted(
    ownerInput: Owner,
    input: {
      version: string;
      etag: string;
      storedSha256: string;
      targetKeyVersion: number | null;
      targetEncryptionScope: string | null;
      now: number;
    }
  ): Promise<TenantBackupR2RestoreObject> {
    const owner = ownerFrom(ownerInput);
    timestamp(input.now);
    const object = await this.get(owner, input.now);
    if (
      !input.version ||
      input.version.length > 1024 ||
      !input.etag ||
      input.etag.length > 1024 ||
      !SHA256.test(input.storedSha256) ||
      (input.targetKeyVersion !== null &&
        (!Number.isSafeInteger(input.targetKeyVersion) || input.targetKeyVersion < 1)) ||
      (input.targetEncryptionScope !== null &&
        (!input.targetEncryptionScope || input.targetEncryptionScope.length > 256)) ||
      (object.source_encoding === 'plaintext' &&
        (input.targetKeyVersion !== null || input.targetEncryptionScope !== null)) ||
      (object.source_encoding === 'object_artifact_v1' &&
        (input.targetKeyVersion === null || input.targetEncryptionScope !== null)) ||
      (object.source_encoding === 'log_chunk_v1' &&
        (input.targetKeyVersion === null || input.targetEncryptionScope === null))
    )
      invalid();
    if (object.state === 'completed') {
      if (
        object.object_version !== input.version ||
        object.object_etag !== input.etag ||
        object.stored_sha256 !== input.storedSha256 ||
        object.target_key_version !== input.targetKeyVersion ||
        object.target_encryption_scope !== input.targetEncryptionScope
      )
        invalid();
      return object;
    }
    if (object.state !== 'completing') invalid();
    await this.database.queryOne(
      `UPDATE tenant_backup_r2_restore_objects
       SET state='completed',object_version=?,object_etag=?,stored_sha256=?,
         target_key_version=?,target_encryption_scope=?,completed_at=?,updated_at=?
       WHERE operation_id=? AND tenant_id=? AND dataset_id=? AND object_id=? AND state='completing'
         AND ${LIVE_OPERATION}
       RETURNING object_id`,
      [
        input.version,
        input.etag,
        input.storedSha256,
        input.targetKeyVersion,
        input.targetEncryptionScope,
        input.now,
        input.now,
        owner.operationId,
        owner.tenantId,
        owner.datasetId,
        owner.objectId,
        ...live(owner, input.now),
      ]
    );
    const saved = await this.get(owner, input.now);
    if (
      saved.state !== 'completed' ||
      saved.object_version !== input.version ||
      saved.object_etag !== input.etag ||
      saved.stored_sha256 !== input.storedSha256 ||
      saved.target_key_version !== input.targetKeyVersion ||
      saved.target_encryption_scope !== input.targetEncryptionScope
    )
      invalid();
    return saved;
  }
}
