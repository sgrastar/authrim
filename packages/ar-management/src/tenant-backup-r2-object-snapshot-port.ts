import type { Env } from '@authrim/ar-lib-core';
import {
  decryptObjectArtifact,
  type EncryptedObjectArtifactEnvelope,
} from '@authrim/ar-lib-core/services/object-artifact-crypto';
import { isObjectClass, type ObjectClass } from '@authrim/ar-lib-core/services/object-catalog';
import { encodePortableLogChunkRecords } from '@authrim/ar-lib-core/services/tenant-portability/portable-log-chunk';
import { encodePortableSensitiveDetailRecord } from '@authrim/ar-lib-core/services/tenant-portability/portable-sensitive-detail';
import {
  encodePortableR2ObjectChunk,
  TENANT_BACKUP_R2_CHUNK_BYTES,
  TENANT_BACKUP_R2_MAX_CHUNKS,
  type PortableR2BucketBinding,
  type PortableR2DatasetId,
} from '@authrim/ar-lib-core/services/tenant-portability/portable-r2-object';
import {
  decodeLogRecordFromBlock,
  decryptLogChunkBody,
  deriveLogChunkEncryptionKey,
} from '@authrim/ar-lib-logging/chunks';
import {
  LOG_CHUNK_COMPRESSION,
  LOG_PLANES,
  LOG_TYPES,
  type LogPlane,
  type LogType,
} from '@authrim/ar-lib-logging/contract';
import type { AdapterContext } from './tenant-backup-export-dispatcher';
import {
  createDeferredEncryptedTenantBackupRecordSnapshotPort,
  type TenantBackupRecordSnapshotSummary,
} from './tenant-backup-record-snapshot-port';

const MAX_REENCRYPTABLE_OBJECT_BYTES = 64 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,256}$/u;
type LogChunkCompression = 'none' | 'gzip_block';
export type TenantBackupR2CatalogKind = 'object_catalog_object' | 'log_object' | 'log_manifest';

interface SourceIdentityContext {
  sourceFamily: 'core' | 'admin';
  sourceDatabaseId: string;
  sourceRowId: string;
}

interface BaseDescriptor {
  datasetId: PortableR2DatasetId;
  objectId: string;
  bucketBinding: PortableR2BucketBinding;
  objectKey: string;
  expectedStoredSha256?: string | null;
}

export interface PlaintextR2ObjectDescriptor extends BaseDescriptor {
  sourceEncoding: 'plaintext';
  context: Readonly<
    SourceIdentityContext & {
      tenantId: string;
      catalogKind: TenantBackupR2CatalogKind;
      [key: string]: unknown;
    }
  >;
}

export interface ObjectArtifactR2ObjectDescriptor extends BaseDescriptor {
  sourceEncoding: 'object_artifact_v1';
  context: Readonly<
    SourceIdentityContext & {
      tenantId: string;
      catalogKind: 'object_catalog_object';
      catalogId: string;
      objectClass: ObjectClass;
      [key: string]: unknown;
    }
  >;
}

export interface LogChunkR2ObjectDescriptor extends BaseDescriptor {
  sourceEncoding: 'log_chunk_v1';
  context: Readonly<
    SourceIdentityContext & {
      tenantId: string;
      catalogKind: 'log_object';
      tenantKey: string;
      logType: LogType;
      plane: LogPlane;
      chunkId: string;
      compression: LogChunkCompression;
      encryptionScope: string;
      keyVersion: number;
      [key: string]: unknown;
    }
  >;
}

export interface LogChunkRecordsR2ObjectDescriptor extends BaseDescriptor {
  sourceEncoding: 'log_chunk_records_v1';
  context: Readonly<
    SourceIdentityContext & {
      tenantId: string;
      catalogKind: 'log_object';
      sourceDatabaseId: string;
      sourceFamily: 'core' | 'admin';
      tenantKey: string;
      logType: LogType;
      plane: LogPlane;
      chunkId: string;
      compression: LogChunkCompression;
      windowFromInclusiveUnixMs: number | null;
      windowUntilInclusiveUnixMs: number;
      sourceEncrypted: boolean;
      targetEncryptionScope: string;
      encryptionScope?: string;
      keyVersion?: number;
      [key: string]: unknown;
    }
  >;
}

export interface SensitiveDetailRecordR2ObjectDescriptor extends BaseDescriptor {
  sourceEncoding: 'sensitive_detail_record_v1';
  context: Readonly<
    SourceIdentityContext & {
      tenantId: string;
      catalogKind: 'object_catalog_object';
      catalogId: string;
      objectClass: ObjectClass;
      contentEncoding: 'gzip' | 'none';
      lineNumber: number;
      byteOffset: number | null;
      byteLength: number | null;
      sourceKeyVersion: number;
      [key: string]: unknown;
    }
  >;
}

export type TenantBackupR2ObjectDescriptor =
  | PlaintextR2ObjectDescriptor
  | ObjectArtifactR2ObjectDescriptor
  | LogChunkR2ObjectDescriptor
  | LogChunkRecordsR2ObjectDescriptor
  | SensitiveDetailRecordR2ObjectDescriptor;

interface R2Identity {
  etag: string;
  version: string;
  size: number;
}

interface LoadedR2Metadata {
  httpMetadata: R2HTTPMetadata;
  customMetadata: Record<string, string>;
}

function invalid(): never {
  throw new Error('backup_r2_object_snapshot_invalid');
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? -1;
    return code <= 0x1f || code === 0x7f;
  });
}

function resolveBucket(
  env: Pick<
    Env,
    | 'AUDIT_ARCHIVE'
    | 'DIAGNOSTIC_LOGS'
    | 'EXPORT_ARTIFACTS'
    | 'IMPORT_ARTIFACTS'
    | 'SENSITIVE_DETAILS'
  >,
  binding: PortableR2BucketBinding
): R2Bucket {
  const bucket = env[binding];
  return bucket ?? invalid();
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function identity(object: Pick<R2Object, 'etag' | 'version' | 'size'>): R2Identity {
  if (!object.etag || !object.version || !Number.isSafeInteger(object.size) || object.size < 0)
    invalid();
  return { etag: object.etag, version: object.version, size: object.size };
}

function sameIdentity(left: R2Identity, right: R2Identity): boolean {
  return left.etag === right.etag && left.version === right.version && left.size === right.size;
}

function normalizeHttpMetadata(
  metadata: R2HTTPMetadata | undefined
): Readonly<Record<string, unknown>> {
  if (!metadata) return {};
  return {
    ...(metadata.contentType ? { contentType: metadata.contentType } : {}),
    ...(metadata.contentLanguage ? { contentLanguage: metadata.contentLanguage } : {}),
    ...(metadata.contentDisposition ? { contentDisposition: metadata.contentDisposition } : {}),
    ...(metadata.contentEncoding ? { contentEncoding: metadata.contentEncoding } : {}),
    ...(metadata.cacheControl ? { cacheControl: metadata.cacheControl } : {}),
    ...(metadata.cacheExpiry ? { cacheExpiry: metadata.cacheExpiry.toISOString() } : {}),
  };
}

function validateDescriptor(
  descriptor: TenantBackupR2ObjectDescriptor,
  datasetId: PortableR2DatasetId
): void {
  const source = descriptor.context;
  if (
    descriptor.datasetId !== datasetId ||
    !SAFE_ID.test(descriptor.objectId) ||
    !descriptor.objectKey ||
    new TextEncoder().encode(descriptor.objectKey).length > 1024 ||
    containsControlCharacter(descriptor.objectKey) ||
    !descriptor.expectedStoredSha256 ||
    !SHA256.test(descriptor.expectedStoredSha256) ||
    !['core', 'admin'].includes(source.sourceFamily) ||
    !SAFE_ID.test(source.sourceDatabaseId) ||
    !SAFE_ID.test(source.sourceRowId)
  )
    invalid();
  if (!SAFE_ID.test(descriptor.context.tenantId)) invalid();
  if (
    !['object_catalog_object', 'log_object', 'log_manifest'].includes(
      descriptor.context.catalogKind
    ) ||
    (datasetId === 'artifacts.object_catalog_bodies' &&
      descriptor.context.catalogKind !== 'object_catalog_object')
  )
    invalid();
  if (
    descriptor.sourceEncoding === 'object_artifact_v1' &&
    (descriptor.context.catalogKind !== 'object_catalog_object' ||
      !SAFE_ID.test(descriptor.context.catalogId) ||
      !isObjectClass(descriptor.context.objectClass) ||
      !['AUDIT_ARCHIVE', 'EXPORT_ARTIFACTS', 'SENSITIVE_DETAILS'].includes(
        descriptor.bucketBinding
      ))
  )
    invalid();
  if (descriptor.sourceEncoding === 'sensitive_detail_record_v1') {
    const value = descriptor.context;
    if (
      value.catalogKind !== 'object_catalog_object' ||
      !SAFE_ID.test(value.catalogId) ||
      !SAFE_ID.test(value.catalogId) ||
      !isObjectClass(value.objectClass) ||
      !['gzip', 'none'].includes(value.contentEncoding) ||
      !Number.isSafeInteger(value.lineNumber) ||
      value.lineNumber < 0 ||
      (value.byteOffset !== null &&
        (!Number.isSafeInteger(value.byteOffset) || value.byteOffset < 0)) ||
      (value.byteLength !== null &&
        (!Number.isSafeInteger(value.byteLength) || value.byteLength < 1)) ||
      !Number.isSafeInteger(value.sourceKeyVersion) ||
      value.sourceKeyVersion < 1 ||
      (value.contentEncoding === 'gzip' &&
        (value.byteOffset !== null || value.byteLength !== null)) ||
      (value.byteOffset === null) !== (value.byteLength === null) ||
      descriptor.bucketBinding !== 'SENSITIVE_DETAILS'
    )
      invalid();
  }
  if (
    descriptor.sourceEncoding === 'log_chunk_v1' &&
    (descriptor.context.catalogKind !== 'log_object' ||
      !descriptor.context.tenantKey ||
      !descriptor.context.chunkId ||
      !descriptor.context.encryptionScope ||
      !LOG_TYPES.includes(descriptor.context.logType) ||
      !LOG_PLANES.includes(descriptor.context.plane) ||
      !LOG_CHUNK_COMPRESSION.includes(descriptor.context.compression) ||
      !Number.isSafeInteger(descriptor.context.keyVersion) ||
      descriptor.context.keyVersion < 1 ||
      descriptor.bucketBinding !==
        (descriptor.context.plane === 'sensitive_detail'
          ? 'SENSITIVE_DETAILS'
          : descriptor.context.plane === 'diagnostic_detail'
            ? 'DIAGNOSTIC_LOGS'
            : 'AUDIT_ARCHIVE'))
  )
    invalid();
  if (descriptor.sourceEncoding === 'log_chunk_records_v1') {
    const value = descriptor.context;
    if (
      value.catalogKind !== 'log_object' ||
      !SAFE_ID.test(value.sourceDatabaseId) ||
      !['core', 'admin'].includes(value.sourceFamily) ||
      !SAFE_ID.test(value.tenantKey) ||
      !SAFE_ID.test(value.chunkId) ||
      !LOG_TYPES.includes(value.logType) ||
      !LOG_PLANES.includes(value.plane) ||
      !LOG_CHUNK_COMPRESSION.includes(value.compression) ||
      !Number.isSafeInteger(value.windowUntilInclusiveUnixMs) ||
      value.windowUntilInclusiveUnixMs < 0 ||
      (value.windowFromInclusiveUnixMs !== null &&
        (!Number.isSafeInteger(value.windowFromInclusiveUnixMs) ||
          value.windowFromInclusiveUnixMs < 0 ||
          value.windowFromInclusiveUnixMs > value.windowUntilInclusiveUnixMs)) ||
      typeof value.sourceEncrypted !== 'boolean' ||
      typeof value.targetEncryptionScope !== 'string' ||
      !value.targetEncryptionScope ||
      value.targetEncryptionScope.length > 256 ||
      (value.sourceEncrypted &&
        (!value.encryptionScope ||
          !Number.isSafeInteger(value.keyVersion) ||
          (value.keyVersion as number) < 1)) ||
      (!value.sourceEncrypted &&
        (value.encryptionScope !== undefined || value.keyVersion !== undefined)) ||
      descriptor.bucketBinding !==
        (value.plane === 'sensitive_detail'
          ? 'SENSITIVE_DETAILS'
          : value.plane === 'diagnostic_detail'
            ? 'DIAGNOSTIC_LOGS'
            : 'AUDIT_ARCHIVE')
    )
      invalid();
  }
}

interface SourceLogIndexRow {
  record_id: string;
  surface: string | null;
  line_number: number | null;
  block_offset: number | null;
  block_length: number | null;
  record_offset: number | null;
  record_length: number | null;
  event_at: number;
  index_profile: string;
  indexed_fields: string | null;
  created_at: number;
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}

function sourceDatabase(
  context: AdapterContext,
  sourceFamily: 'core' | 'admin',
  sourceDatabaseId: string
) {
  const candidates =
    sourceFamily === 'core'
      ? context.databases.tenant.filter((resource) => resource.databaseId === sourceDatabaseId)
      : context.databases.fixed.filter(
          (resource) => resource.family === 'admin' && resource.databaseId === sourceDatabaseId
        );
  if (candidates.length !== 1) invalid();
  return candidates[0].database;
}

function sourceLogDatabase(context: AdapterContext, descriptor: LogChunkRecordsR2ObjectDescriptor) {
  return sourceDatabase(
    context,
    descriptor.context.sourceFamily,
    descriptor.context.sourceDatabaseId
  );
}

async function assertDescriptorSnapshotActive(
  context: AdapterContext,
  descriptor: TenantBackupR2ObjectDescriptor
): Promise<void> {
  const resourceId = descriptor.context.sourceDatabaseId;
  const capture = await context.snapshotResources.loadCapture(context.context.lease, resourceId);
  if (capture.resourceId !== resourceId) invalid();
  const row = await sourceDatabase(context, descriptor.context.sourceFamily, resourceId).queryOne<{
    id: string;
  }>("SELECT id FROM tenant_backup_snapshots WHERE id=? AND tenant_id=? AND state='capturing'", [
    capture.snapshotId,
    context.context.lease.tenantId,
  ]);
  if (!row || row.id !== capture.snapshotId) invalid();
}

async function portableLogRecords(
  context: AdapterContext,
  descriptor: LogChunkRecordsR2ObjectDescriptor,
  body: Uint8Array
): Promise<Uint8Array> {
  const rows = await sourceLogDatabase(context, descriptor).query<SourceLogIndexRow>(
    `SELECT record_id,surface,line_number,block_offset,block_length,record_offset,record_length,
       event_at,index_profile,indexed_fields,created_at
     FROM log_chunk_record_index
     WHERE object_catalog_id=? AND tenant_key=? AND log_type=? AND plane=? AND chunk_id=?
       AND status='committed' AND event_at<=? AND (? IS NULL OR event_at>=?)
     ORDER BY event_at,record_id LIMIT 10001`,
    [
      descriptor.objectId.slice(descriptor.objectId.indexOf(':') + 1),
      descriptor.context.tenantKey,
      descriptor.context.logType,
      descriptor.context.plane,
      descriptor.context.chunkId,
      descriptor.context.windowUntilInclusiveUnixMs,
      descriptor.context.windowFromInclusiveUnixMs,
      descriptor.context.windowFromInclusiveUnixMs,
    ]
  );
  if (rows.length < 1 || rows.length > 10_000) invalid();
  const records = [];
  for (const [index, row] of rows.entries()) {
    context.context.signal.throwIfAborted();
    if (
      !SAFE_ID.test(row.record_id) ||
      (row.surface !== null && row.surface.length > 256) ||
      !row.index_profile ||
      row.index_profile.length > 128 ||
      (row.indexed_fields !== null && new TextEncoder().encode(row.indexed_fields).length > 65_536)
    )
      invalid();
    const lineNumber = row.line_number === null ? index : nonNegativeInteger(row.line_number);
    const blockOffset = row.block_offset === null ? 0 : nonNegativeInteger(row.block_offset);
    const blockLength =
      row.block_length === null ? body.length : nonNegativeInteger(row.block_length);
    const recordOffset = row.record_offset === null ? 0 : nonNegativeInteger(row.record_offset);
    const recordLength = nonNegativeInteger(row.record_length);
    if (
      blockLength < 1 ||
      recordLength < 1 ||
      blockOffset + blockLength > body.length ||
      (descriptor.context.compression === 'gzip_block' &&
        (row.block_offset === null || row.block_length === null))
    )
      invalid();
    let payload: unknown;
    try {
      payload = await decodeLogRecordFromBlock(
        body,
        {
          blockIndex: 0,
          compressedOffset: blockOffset,
          compressedLength: blockLength,
          uncompressedLength: blockLength,
          firstLineNumber: lineNumber,
          lastLineNumber: lineNumber,
          recordCount: 1,
        },
        {
          recordId: row.record_id,
          lineNumber,
          blockIndex: 0,
          recordOffset,
          recordLength,
        },
        descriptor.context.compression
      );
      if (row.indexed_fields !== null) JSON.parse(row.indexed_fields);
    } catch {
      return invalid();
    }
    records.push({
      recordId: row.record_id,
      eventAt: nonNegativeInteger(row.event_at),
      surface: row.surface,
      indexProfile: row.index_profile,
      indexedFields: row.indexed_fields,
      createdAt: nonNegativeInteger(row.created_at),
      payload,
    });
  }
  return encodePortableLogChunkRecords({
    version: 1,
    compression: descriptor.context.compression,
    records,
  });
}

async function decompressGzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') invalid();
  try {
    return new Uint8Array(
      await new Response(
        new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
      ).arrayBuffer()
    );
  } catch {
    return invalid();
  }
}

function jsonLineRange(bytes: Uint8Array, lineNumber: number): { start: number; end: number } {
  let currentLine = 0;
  let start = 0;
  for (let index = 0; index <= bytes.length; index += 1) {
    if (index !== bytes.length && bytes[index] !== 10) continue;
    if (currentLine === lineNumber) return { start, end: index };
    currentLine += 1;
    start = index + 1;
  }
  return invalid();
}

async function portableSensitiveDetail(
  rootKey: string,
  descriptor: SensitiveDetailRecordR2ObjectDescriptor,
  stored: Uint8Array
): Promise<Uint8Array> {
  const decoded =
    descriptor.context.contentEncoding === 'gzip' ? await decompressGzip(stored) : stored;
  const range = jsonLineRange(decoded, descriptor.context.lineNumber);
  if (descriptor.context.byteOffset !== null && descriptor.context.byteLength !== null) {
    const end = descriptor.context.byteOffset + descriptor.context.byteLength;
    if (descriptor.context.byteOffset !== range.start || end !== range.end) invalid();
  }
  const lineBytes = decoded.slice(range.start, range.end);
  let envelope: EncryptedObjectArtifactEnvelope;
  try {
    envelope = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(lineBytes)
    ) as EncryptedObjectArtifactEnvelope;
  } catch {
    return invalid();
  }
  if (
    envelope.plane !== 'SENSITIVE_DETAILS' ||
    envelope.objectClass !== descriptor.context.objectClass ||
    envelope.keyVersion !== descriptor.context.sourceKeyVersion
  )
    invalid();
  const plaintext = await decryptObjectArtifact(envelope, {
    rootKeyHex: rootKey,
    context: {
      tenantId: descriptor.context.tenantId,
      objectKey: descriptor.objectKey,
      objectClass: descriptor.context.objectClass,
    },
  });
  return encodePortableSensitiveDetailRecord({
    version: 1,
    contentType: envelope.contentType,
    plaintext,
  });
}

async function readBody(
  bucket: R2Bucket,
  descriptor: TenantBackupR2ObjectDescriptor,
  head: R2Identity
): Promise<Uint8Array> {
  if (head.size > MAX_REENCRYPTABLE_OBJECT_BYTES) invalid();
  const object = await bucket.get(descriptor.objectKey, {
    onlyIf: { etagMatches: head.etag },
  });
  if (!object || !('body' in object) || !sameIdentity(head, identity(object))) invalid();
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length !== head.size) invalid();
  if (descriptor.expectedStoredSha256 && (await sha256(bytes)) !== descriptor.expectedStoredSha256)
    invalid();
  return bytes;
}

function metadata(object: Pick<R2Object, 'httpMetadata' | 'customMetadata'>): LoadedR2Metadata {
  return {
    httpMetadata: object.httpMetadata ?? {},
    customMetadata: object.customMetadata ?? {},
  };
}

async function getPinnedObject(
  bucket: R2Bucket,
  descriptor: TenantBackupR2ObjectDescriptor,
  pinned: R2Identity,
  options: R2GetOptions
): Promise<R2ObjectBody> {
  const object = await bucket.get(descriptor.objectKey, {
    ...options,
    onlyIf: { etagMatches: pinned.etag },
  });
  if (
    !object ||
    !('body' in object) ||
    object.etag !== pinned.etag ||
    object.version !== pinned.version
  )
    invalid();
  return object;
}

async function hashPlaintextObject(
  bucket: R2Bucket,
  descriptor: PlaintextR2ObjectDescriptor,
  pinned: R2Identity,
  signal: AbortSignal
): Promise<string> {
  const object = await getPinnedObject(bucket, descriptor, pinned, {});
  const workersCrypto = crypto as Crypto & {
    DigestStream?: new (
      algorithm: string
    ) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> };
  };
  let result: string;
  if (workersCrypto.DigestStream) {
    const digestStream = new workersCrypto.DigestStream('SHA-256');
    await object.body.pipeTo(digestStream, { signal });
    result = [...new Uint8Array(await digestStream.digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  } else {
    if (pinned.size > MAX_REENCRYPTABLE_OBJECT_BYTES) invalid();
    result = await sha256(new Uint8Array(await object.arrayBuffer()));
  }
  if (descriptor.expectedStoredSha256 && descriptor.expectedStoredSha256 !== result) invalid();
  return result;
}

async function readPlaintextChunk(
  bucket: R2Bucket,
  descriptor: PlaintextR2ObjectDescriptor,
  pinned: R2Identity,
  chunkIndex: number
): Promise<Uint8Array> {
  if (pinned.size === 0) return new Uint8Array();
  const offset = chunkIndex * TENANT_BACKUP_R2_CHUNK_BYTES;
  const length = Math.min(TENANT_BACKUP_R2_CHUNK_BYTES, pinned.size - offset);
  if (length < 1) invalid();
  const object = await getPinnedObject(bucket, descriptor, pinned, {
    range: { offset, length },
  });
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length !== length) invalid();
  return bytes;
}

async function portablePlaintext(
  env: Pick<Env, 'OBJECT_ENCRYPTION_ROOT_KEY'>,
  context: AdapterContext,
  descriptor: TenantBackupR2ObjectDescriptor,
  stored: Uint8Array
): Promise<Uint8Array> {
  if (descriptor.sourceEncoding === 'plaintext') return stored;
  const rootKey = env.OBJECT_ENCRYPTION_ROOT_KEY;
  if (!rootKey) invalid();
  if (descriptor.sourceEncoding === 'object_artifact_v1') {
    let envelope: EncryptedObjectArtifactEnvelope;
    try {
      envelope = JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(stored)
      ) as EncryptedObjectArtifactEnvelope;
    } catch {
      return invalid();
    }
    if (
      envelope.objectClass !== descriptor.context.objectClass ||
      envelope.plane !== descriptor.bucketBinding
    )
      invalid();
    const plaintext = await decryptObjectArtifact(envelope, {
      rootKeyHex: rootKey,
      context: {
        tenantId: descriptor.context.tenantId,
        objectKey: descriptor.objectKey,
        objectClass: descriptor.context.objectClass,
      },
    });
    return new TextEncoder().encode(plaintext);
  }
  if (descriptor.sourceEncoding === 'sensitive_detail_record_v1')
    return portableSensitiveDetail(rootKey, descriptor, stored);
  const logDescriptor = descriptor;
  const encrypted =
    logDescriptor.sourceEncoding === 'log_chunk_v1' || logDescriptor.context.sourceEncrypted;
  const decrypted = encrypted
    ? await decryptLogChunkBody({
        storedBody: stored,
        keyBytes: await deriveLogChunkEncryptionKey({
          rootKeyHex: rootKey,
          tenantKey: logDescriptor.context.tenantKey,
          logType: logDescriptor.context.logType,
          plane: logDescriptor.context.plane,
          keyVersion: logDescriptor.context.keyVersion ?? invalid(),
        }),
        tenantKey: logDescriptor.context.tenantKey,
        logType: logDescriptor.context.logType,
        plane: logDescriptor.context.plane,
        objectKey: logDescriptor.objectKey,
        chunkId: logDescriptor.context.chunkId,
        expectedEncryptionScope: logDescriptor.context.encryptionScope,
        expectedKeyVersion: logDescriptor.context.keyVersion,
      })
    : { body: stored, compression: logDescriptor.context.compression };
  if (decrypted.compression !== logDescriptor.context.compression) invalid();
  return logDescriptor.sourceEncoding === 'log_chunk_records_v1'
    ? portableLogRecords(context, logDescriptor, decrypted.body)
    : decrypted.body;
}

function orderedDescriptors(
  descriptors: readonly TenantBackupR2ObjectDescriptor[],
  datasetId: PortableR2DatasetId
): TenantBackupR2ObjectDescriptor[] {
  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    validateDescriptor(descriptor, datasetId);
    if (seen.has(descriptor.objectId)) invalid();
    seen.add(descriptor.objectId);
  }
  return [...descriptors].sort((left, right) => left.objectId.localeCompare(right.objectId));
}

async function* captureDataset(
  env: Pick<
    Env,
    | 'AUDIT_ARCHIVE'
    | 'DIAGNOSTIC_LOGS'
    | 'EXPORT_ARTIFACTS'
    | 'IMPORT_ARTIFACTS'
    | 'SENSITIVE_DETAILS'
    | 'OBJECT_ENCRYPTION_ROOT_KEY'
  >,
  context: AdapterContext,
  datasetId: PortableR2DatasetId,
  list: (
    context: AdapterContext,
    datasetId: PortableR2DatasetId
  ) => Promise<readonly TenantBackupR2ObjectDescriptor[]>
): AsyncIterable<Uint8Array> {
  const tenantId = context.context.lease.tenantId;
  const descriptors = orderedDescriptors(await list(context, datasetId), datasetId);
  for (const descriptor of descriptors) {
    context.context.signal.throwIfAborted();
    if (descriptor.context.tenantId !== tenantId) invalid();
    const bucket = resolveBucket(env, descriptor.bucketBinding);
    const sourceHead = await bucket.head(descriptor.objectKey);
    if (!sourceHead) invalid();
    const pinned = identity(sourceHead);
    const loadedMetadata = metadata(sourceHead);
    const plaintextDescriptor = descriptor.sourceEncoding === 'plaintext' ? descriptor : null;
    const bytes = plaintextDescriptor
      ? null
      : await portablePlaintext(
          env,
          context,
          descriptor,
          await readBody(bucket, descriptor, pinned)
        );
    const totalBytes = bytes?.length ?? pinned.size;
    const objectSha256 =
      bytes === null
        ? await hashPlaintextObject(
            bucket,
            plaintextDescriptor ?? invalid(),
            pinned,
            context.context.signal
          )
        : await sha256(bytes);
    const chunkCount = Math.max(1, Math.ceil(totalBytes / TENANT_BACKUP_R2_CHUNK_BYTES));
    if (chunkCount > TENANT_BACKUP_R2_MAX_CHUNKS) invalid();
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      context.context.signal.throwIfAborted();
      const chunk =
        bytes === null
          ? await readPlaintextChunk(bucket, plaintextDescriptor ?? invalid(), pinned, chunkIndex)
          : bytes.slice(
              chunkIndex * TENANT_BACKUP_R2_CHUNK_BYTES,
              Math.min(bytes.length, (chunkIndex + 1) * TENANT_BACKUP_R2_CHUNK_BYTES)
            );
      yield encodePortableR2ObjectChunk({
        tenantId,
        objectId: descriptor.objectId,
        bucketBinding: descriptor.bucketBinding,
        objectKey: descriptor.objectKey,
        sourceEncoding: descriptor.sourceEncoding,
        objectSha256,
        totalBytes,
        chunkIndex,
        chunkCount,
        chunkSha256: await sha256(chunk),
        bytes: chunk,
        context: descriptor.context,
        httpMetadata: normalizeHttpMetadata(loadedMetadata.httpMetadata),
        customMetadata: loadedMetadata.customMetadata,
      });
    }
    const after = await bucket.head(descriptor.objectKey);
    if (!after || !sameIdentity(pinned, identity(after))) invalid();
  }
}

interface R2DescriptorPlan {
  version: 1;
  datasetId: PortableR2DatasetId;
  descriptor: TenantBackupR2ObjectDescriptor;
}

function encodeDescriptorPlan(
  descriptor: TenantBackupR2ObjectDescriptor,
  datasetId: PortableR2DatasetId
): Uint8Array {
  validateDescriptor(descriptor, datasetId);
  return new TextEncoder().encode(`${JSON.stringify({ version: 1, datasetId, descriptor })}\n`);
}

function decodeDescriptorPlan(
  bytes: Uint8Array,
  datasetId: PortableR2DatasetId
): TenantBackupR2ObjectDescriptor {
  let value: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1) invalid();
    value = JSON.parse(text.slice(0, -1)) as unknown;
  } catch {
    return invalid();
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'datasetId,descriptor,version'
  )
    invalid();
  const plan = value as R2DescriptorPlan;
  if (plan.version !== 1 || plan.datasetId !== datasetId || !plan.descriptor) invalid();
  validateDescriptor(plan.descriptor, datasetId);
  return plan.descriptor;
}

function summarizeDescriptor(
  descriptor: TenantBackupR2ObjectDescriptor
): TenantBackupRecordSnapshotSummary {
  const value = descriptor.context;
  const family = value.sourceFamily;
  if (
    (family !== 'core' && family !== 'admin') ||
    typeof value.sourceDatabaseId !== 'string' ||
    !SAFE_ID.test(value.sourceDatabaseId) ||
    typeof value.sourceRowId !== 'string' ||
    !SAFE_ID.test(value.sourceRowId) ||
    !['object_catalog_object', 'log_object'].includes(String(value.catalogKind))
  )
    invalid();
  if (value.catalogKind === 'object_catalog_object') {
    if (typeof value.catalogId !== 'string' || !SAFE_ID.test(value.catalogId)) invalid();
    return {
      kind: 'object',
      family,
      databaseId: value.sourceDatabaseId,
      rowId: value.sourceRowId,
      catalogId: value.catalogId,
    };
  }
  return {
    kind: 'log',
    family,
    databaseId: value.sourceDatabaseId,
    rowId: value.sourceRowId,
  };
}

/** Capture referenced R2 bodies into immutable, environment-encrypted record snapshots. */
export function createTenantBackupR2ObjectSnapshotPorts(input: {
  env: Pick<
    Env,
    | 'AUDIT_ARCHIVE'
    | 'DIAGNOSTIC_LOGS'
    | 'EXPORT_ARTIFACTS'
    | 'IMPORT_ARTIFACTS'
    | 'SENSITIVE_DETAILS'
    | 'OBJECT_ENCRYPTION_ROOT_KEY'
    | 'OBJECT_ENCRYPTION_KEY_VERSION'
  >;
  assertSource(context: AdapterContext): Promise<void>;
  list(
    context: AdapterContext,
    datasetId: PortableR2DatasetId
  ): Promise<readonly TenantBackupR2ObjectDescriptor[]>;
}) {
  const snapshot = (datasetId: PortableR2DatasetId) =>
    createDeferredEncryptedTenantBackupRecordSnapshotPort({
      env: input.env,
      resourceId: `r2-bodies:${datasetId}`,
      assertSource: (context) => input.assertSource(context),
      async *capturePlans(context) {
        const tenantId = context.context.lease.tenantId;
        const descriptors = orderedDescriptors(await input.list(context, datasetId), datasetId);
        for (const descriptor of descriptors) {
          context.context.signal.throwIfAborted();
          if (descriptor.context.tenantId !== tenantId) invalid();
          yield encodeDescriptorPlan(descriptor, datasetId);
        }
      },
      async *materializePlan(context, plan) {
        const descriptor = decodeDescriptorPlan(plan, datasetId);
        await assertDescriptorSnapshotActive(context, descriptor);
        yield* captureDataset(input.env, context, datasetId, async () => [descriptor]);
        await assertDescriptorSnapshotActive(context, descriptor);
      },
      summarizePlan: (plan) => summarizeDescriptor(decodeDescriptorPlan(plan, datasetId)),
    });
  return {
    artifactObjects: snapshot('artifacts.object_catalog_bodies'),
    logArchiveObjects: snapshot('logs.archive_object_bodies'),
  };
}
