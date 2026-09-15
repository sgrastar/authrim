import type { Env } from '@authrim/ar-lib-core';
import {
  decryptObjectArtifact,
  type EncryptedObjectArtifactEnvelope,
} from '@authrim/ar-lib-core/services/object-artifact-crypto';
import { isObjectClass, type ObjectClass } from '@authrim/ar-lib-core/services/object-catalog';
import {
  encodePortableR2ObjectChunk,
  TENANT_BACKUP_R2_CHUNK_BYTES,
  TENANT_BACKUP_R2_MAX_CHUNKS,
  type PortableR2BucketBinding,
  type PortableR2DatasetId,
} from '@authrim/ar-lib-core/services/tenant-portability/portable-r2-object';
import { decryptLogChunkBody, deriveLogChunkEncryptionKey } from '@authrim/ar-lib-logging/chunks';
import {
  LOG_CHUNK_COMPRESSION,
  LOG_PLANES,
  LOG_TYPES,
  type LogPlane,
  type LogType,
} from '@authrim/ar-lib-logging/contract';
import type { AdapterContext } from './tenant-backup-export-dispatcher';
import { createEncryptedTenantBackupRecordSnapshotPort } from './tenant-backup-record-snapshot-port';

const MAX_REENCRYPTABLE_OBJECT_BYTES = 64 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,256}$/u;
type LogChunkCompression = 'none' | 'gzip_block';

interface BaseDescriptor {
  datasetId: PortableR2DatasetId;
  objectId: string;
  bucketBinding: PortableR2BucketBinding;
  objectKey: string;
  expectedStoredSha256?: string | null;
}

export interface PlaintextR2ObjectDescriptor extends BaseDescriptor {
  sourceEncoding: 'plaintext';
  context: Readonly<{
    tenantId: string;
    [key: string]: unknown;
  }>;
}

export interface ObjectArtifactR2ObjectDescriptor extends BaseDescriptor {
  sourceEncoding: 'object_artifact_v1';
  context: Readonly<{
    tenantId: string;
    objectClass: ObjectClass;
    [key: string]: unknown;
  }>;
}

export interface LogChunkR2ObjectDescriptor extends BaseDescriptor {
  sourceEncoding: 'log_chunk_v1';
  context: Readonly<{
    tenantId: string;
    tenantKey: string;
    logType: LogType;
    plane: LogPlane;
    chunkId: string;
    compression: LogChunkCompression;
    encryptionScope: string;
    keyVersion: number;
    [key: string]: unknown;
  }>;
}

export type TenantBackupR2ObjectDescriptor =
  | PlaintextR2ObjectDescriptor
  | ObjectArtifactR2ObjectDescriptor
  | LogChunkR2ObjectDescriptor;

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
  if (
    descriptor.datasetId !== datasetId ||
    !SAFE_ID.test(descriptor.objectId) ||
    !descriptor.objectKey ||
    new TextEncoder().encode(descriptor.objectKey).length > 1024 ||
    /[\u0000-\u001f\u007f]/u.test(descriptor.objectKey) ||
    (descriptor.expectedStoredSha256 != null && !SHA256.test(descriptor.expectedStoredSha256))
  )
    invalid();
  if (!SAFE_ID.test(descriptor.context.tenantId)) invalid();
  if (
    descriptor.sourceEncoding === 'object_artifact_v1' &&
    (!isObjectClass(descriptor.context.objectClass) ||
      !['AUDIT_ARCHIVE', 'EXPORT_ARTIFACTS', 'SENSITIVE_DETAILS'].includes(
        descriptor.bucketBinding
      ))
  )
    invalid();
  if (
    descriptor.sourceEncoding === 'log_chunk_v1' &&
    (!descriptor.context.tenantKey ||
      !descriptor.context.chunkId ||
      !descriptor.context.encryptionScope ||
      !LOG_TYPES.includes(descriptor.context.logType) ||
      !LOG_PLANES.includes(descriptor.context.plane) ||
      !LOG_CHUNK_COMPRESSION.includes(descriptor.context.compression) ||
      !Number.isSafeInteger(descriptor.context.keyVersion) ||
      descriptor.context.keyVersion < 1 ||
      descriptor.bucketBinding !== 'AUDIT_ARCHIVE')
  )
    invalid();
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
  const decrypted = await decryptLogChunkBody({
    storedBody: stored,
    keyBytes: await deriveLogChunkEncryptionKey({
      rootKeyHex: rootKey,
      tenantKey: descriptor.context.tenantKey,
      logType: descriptor.context.logType,
      plane: descriptor.context.plane,
      keyVersion: descriptor.context.keyVersion,
    }),
    tenantKey: descriptor.context.tenantKey,
    logType: descriptor.context.logType,
    plane: descriptor.context.plane,
    objectKey: descriptor.objectKey,
    chunkId: descriptor.context.chunkId,
    expectedEncryptionScope: descriptor.context.encryptionScope,
    expectedKeyVersion: descriptor.context.keyVersion,
  });
  if (decrypted.compression !== descriptor.context.compression) invalid();
  return decrypted.body;
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
      : await portablePlaintext(env, descriptor, await readBody(bucket, descriptor, pinned));
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
    createEncryptedTenantBackupRecordSnapshotPort({
      env: input.env,
      resourceId: `r2-bodies:${datasetId}`,
      assertSource: input.assertSource,
      capture: (context) => captureDataset(input.env, context, datasetId, input.list),
    });
  return {
    artifactObjects: snapshot('artifacts.object_catalog_bodies'),
    logArchiveObjects: snapshot('logs.archive_object_bodies'),
  };
}
