import type { Env } from '@authrim/ar-lib-core';
import {
  decryptObjectArtifact,
  encryptObjectArtifact,
  type EncryptedObjectArtifactEnvelope,
} from '@authrim/ar-lib-core/services/object-artifact-crypto';
import { isObjectClass } from '@authrim/ar-lib-core/services/object-catalog';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import {
  type PortableR2BucketBinding,
  type PortableR2DatasetId,
  type PortableR2ObjectChunk,
} from '@authrim/ar-lib-core/services/tenant-portability/portable-r2-object';
import {
  TenantBackupR2RestoreStore,
  type TenantBackupR2RestoreObject,
} from '@authrim/ar-lib-core/services/tenant-portability/r2-restore-store';
import { encryptLogChunkBody, deriveLogChunkEncryptionKey } from '@authrim/ar-lib-logging/chunks';
import { LOG_CHUNK_COMPRESSION, LOG_PLANES, LOG_TYPES } from '@authrim/ar-lib-logging/contract';
import type { DatabaseAdapter } from '@authrim/ar-lib-core/db/adapter';

const MAX_STAGED_BYTES = 64 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;

export interface RestoredTenantR2Object {
  bucketBinding: PortableR2BucketBinding;
  objectKey: string;
  version: string;
  etag: string;
  storedSha256: string;
  storedBytes: number;
  keyVersion: number | null;
  encryptionScope: string | null;
}

export interface TenantBackupR2ObjectFinalizer {
  finalize(
    context: TenantBackupStepContext,
    planDigest: string,
    datasetId: PortableR2DatasetId,
    source: PortableR2ObjectChunk,
    restored: RestoredTenantR2Object
  ): Promise<void>;
  verify(
    context: TenantBackupStepContext,
    planDigest: string,
    datasetId: PortableR2DatasetId,
    source: PortableR2ObjectChunk,
    restored: RestoredTenantR2Object
  ): Promise<boolean>;
}

type RestoreEnv = Pick<
  Env,
  | 'AUDIT_ARCHIVE'
  | 'DIAGNOSTIC_LOGS'
  | 'EXPORT_ARTIFACTS'
  | 'IMPORT_ARTIFACTS'
  | 'SENSITIVE_DETAILS'
  | 'OBJECT_ENCRYPTION_ROOT_KEY'
  | 'OBJECT_ENCRYPTION_KEY_VERSION'
>;

function invalid(): never {
  throw new Error('backup_r2_object_restore_invalid');
}

function rootKey(env: RestoreEnv): string {
  const value = env.OBJECT_ENCRYPTION_ROOT_KEY;
  if (!value || !/^[a-fA-F0-9]{64}$/u.test(value)) invalid();
  return value;
}

function keyVersion(env: RestoreEnv): number {
  const value = env.OBJECT_ENCRYPTION_KEY_VERSION ?? '1';
  if (!/^[1-9][0-9]{0,8}$/u.test(value)) invalid();
  return Number(value);
}

function bucket(env: RestoreEnv, binding: PortableR2BucketBinding): R2Bucket {
  return env[binding] ?? invalid();
}

function owner(
  context: TenantBackupStepContext,
  datasetId: PortableR2DatasetId,
  chunk: PortableR2ObjectChunk
) {
  return {
    operationId: context.lease.operationId,
    tenantId: context.lease.tenantId,
    leaseOwner: context.lease.owner,
    fencingToken: context.lease.fencingToken,
    datasetId,
    objectId: chunk.objectId,
  };
}

function targetKey(
  context: TenantBackupStepContext,
  datasetId: PortableR2DatasetId,
  chunk: PortableR2ObjectChunk
): string {
  const dataset = datasetId === 'artifacts.object_catalog_bodies' ? 'artifacts' : 'logs';
  return `tenant-restores/${context.lease.tenantId}/${context.lease.operationId}/${dataset}/${chunk.objectId}`;
}

function stagingKey(
  context: TenantBackupStepContext,
  datasetId: PortableR2DatasetId,
  chunk: PortableR2ObjectChunk
): string {
  const dataset = datasetId === 'artifacts.object_catalog_bodies' ? 'artifacts' : 'logs';
  return `tenant-restore-staging/${context.lease.tenantId}/${context.lease.operationId}/${dataset}/${chunk.objectId}/${chunk.chunkIndex}`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  try {
    const binary = atob(value);
    const result = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (toBase64(result) !== value) invalid();
    return result;
  } catch {
    return invalid();
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function httpMetadata(value: Readonly<Record<string, unknown>> | null): R2HTTPMetadata {
  if (value === null) return {};
  const keys = Object.keys(value);
  if (
    keys.some(
      (key) =>
        ![
          'cacheControl',
          'cacheExpiry',
          'contentDisposition',
          'contentEncoding',
          'contentLanguage',
          'contentType',
        ].includes(key)
    ) ||
    Object.entries(value).some(([key, item]) => key !== 'cacheExpiry' && typeof item !== 'string')
  )
    invalid();
  let cacheExpiry: Date | undefined;
  if (value.cacheExpiry !== undefined) {
    if (typeof value.cacheExpiry !== 'string') invalid();
    cacheExpiry = new Date(value.cacheExpiry);
    if (!Number.isFinite(cacheExpiry.getTime()) || cacheExpiry.toISOString() !== value.cacheExpiry)
      invalid();
  }
  return {
    ...(typeof value.contentType === 'string' ? { contentType: value.contentType } : {}),
    ...(typeof value.contentLanguage === 'string'
      ? { contentLanguage: value.contentLanguage }
      : {}),
    ...(typeof value.contentDisposition === 'string'
      ? { contentDisposition: value.contentDisposition }
      : {}),
    ...(typeof value.contentEncoding === 'string'
      ? { contentEncoding: value.contentEncoding }
      : {}),
    ...(typeof value.cacheControl === 'string' ? { cacheControl: value.cacheControl } : {}),
    ...(cacheExpiry ? { cacheExpiry } : {}),
  };
}

function stagedContext(tenantId: string, key: string) {
  return { tenantId, objectKey: key, objectClass: 'dr_bundle' as const };
}

async function writeStagedChunk(
  env: RestoreEnv,
  context: TenantBackupStepContext,
  objectKey: string,
  bytes: Uint8Array
): Promise<void> {
  const staging = env.EXPORT_ARTIFACTS ?? invalid();
  const existing = await staging.get(objectKey);
  if (existing) {
    let envelope: EncryptedObjectArtifactEnvelope;
    try {
      envelope = JSON.parse(await existing.text()) as EncryptedObjectArtifactEnvelope;
    } catch {
      return invalid();
    }
    const saved = fromBase64(
      await decryptObjectArtifact(envelope, {
        rootKeyHex: rootKey(env),
        context: stagedContext(context.lease.tenantId, objectKey),
      })
    );
    if (
      envelope.plane !== 'EXPORT_ARTIFACTS' ||
      envelope.objectClass !== 'dr_bundle' ||
      saved.length !== bytes.length ||
      saved.some((value, index) => value !== bytes[index])
    )
      invalid();
    return;
  }
  const envelope = await encryptObjectArtifact(toBase64(bytes), {
    rootKeyHex: rootKey(env),
    plane: 'EXPORT_ARTIFACTS',
    keyVersion: keyVersion(env),
    contentType: 'application/octet-stream',
    context: stagedContext(context.lease.tenantId, objectKey),
  });
  await staging.put(objectKey, JSON.stringify(envelope), {
    httpMetadata: { contentType: 'application/json' },
  });
  await writeStagedChunk(env, context, objectKey, bytes);
}

async function readStagedChunk(
  env: RestoreEnv,
  context: TenantBackupStepContext,
  objectKey: string,
  expectedSha256: string
): Promise<Uint8Array> {
  const object = await (env.EXPORT_ARTIFACTS ?? invalid()).get(objectKey);
  if (!object) invalid();
  let envelope: EncryptedObjectArtifactEnvelope;
  try {
    envelope = JSON.parse(await object.text()) as EncryptedObjectArtifactEnvelope;
  } catch {
    return invalid();
  }
  if (envelope.plane !== 'EXPORT_ARTIFACTS' || envelope.objectClass !== 'dr_bundle') invalid();
  const bytes = fromBase64(
    await decryptObjectArtifact(envelope, {
      rootKeyHex: rootKey(env),
      context: stagedContext(context.lease.tenantId, objectKey),
    })
  );
  if ((await sha256(bytes)) !== expectedSha256) invalid();
  return bytes;
}

async function hashObject(
  target: R2Bucket,
  object: Pick<R2Object, 'etag' | 'version' | 'size'>,
  objectKey: string,
  signal: AbortSignal
): Promise<string> {
  const loaded = await target.get(objectKey, { onlyIf: { etagMatches: object.etag } });
  if (
    !loaded ||
    !('body' in loaded) ||
    loaded.etag !== object.etag ||
    loaded.version !== object.version ||
    loaded.size !== object.size
  )
    invalid();
  const workersCrypto = crypto as Crypto & {
    DigestStream?: new (
      algorithm: string
    ) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> };
  };
  if (workersCrypto.DigestStream) {
    const stream = new workersCrypto.DigestStream('SHA-256');
    await loaded.body.pipeTo(stream, { signal });
    return [...new Uint8Array(await stream.digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }
  if (loaded.size > MAX_STAGED_BYTES) invalid();
  return sha256(new Uint8Array(await loaded.arrayBuffer()));
}

function requiredString(context: Readonly<Record<string, unknown>>, key: string): string {
  const value = context[key];
  if (typeof value !== 'string' || !value || value.length > 256) invalid();
  return value;
}

function requiredInteger(context: Readonly<Record<string, unknown>>, key: string): number {
  const value = context[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid();
  return value as number;
}

async function encodeTargetBody(
  env: RestoreEnv,
  source: PortableR2ObjectChunk,
  objectKey: string,
  plaintext: Uint8Array
): Promise<{ bytes: Uint8Array; keyVersion: number | null; encryptionScope: string | null }> {
  if (source.sourceEncoding === 'plaintext')
    return { bytes: plaintext, keyVersion: null, encryptionScope: null };
  const version = keyVersion(env);
  if (source.sourceEncoding === 'object_artifact_v1') {
    const objectClass = requiredString(source.context, 'objectClass');
    const plane = source.bucketBinding;
    if (
      !isObjectClass(objectClass) ||
      (plane !== 'AUDIT_ARCHIVE' && plane !== 'EXPORT_ARTIFACTS' && plane !== 'SENSITIVE_DETAILS')
    )
      invalid();
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plaintext);
    } catch {
      return invalid();
    }
    const contentType =
      typeof source.context.contentType === 'string' && source.context.contentType
        ? source.context.contentType
        : 'application/octet-stream';
    const envelope = await encryptObjectArtifact(text, {
      rootKeyHex: rootKey(env),
      plane,
      keyVersion: version,
      contentType,
      context: { tenantId: source.tenantId, objectKey, objectClass },
    });
    return {
      bytes: new TextEncoder().encode(JSON.stringify(envelope)),
      keyVersion: version,
      encryptionScope: null,
    };
  }
  const tenantKey = requiredString(source.context, 'tenantKey');
  const logType = requiredString(source.context, 'logType');
  const plane = requiredString(source.context, 'plane');
  const chunkId = requiredString(source.context, 'chunkId');
  const compression = requiredString(source.context, 'compression');
  const encryptionScope = requiredString(source.context, 'encryptionScope');
  requiredInteger(source.context, 'keyVersion');
  if (
    !LOG_TYPES.includes(logType as (typeof LOG_TYPES)[number]) ||
    !LOG_PLANES.includes(plane as (typeof LOG_PLANES)[number]) ||
    !LOG_CHUNK_COMPRESSION.includes(compression as (typeof LOG_CHUNK_COMPRESSION)[number]) ||
    source.bucketBinding !== 'AUDIT_ARCHIVE'
  )
    invalid();
  const keyBytes = await deriveLogChunkEncryptionKey({
    rootKeyHex: rootKey(env),
    tenantKey,
    logType: logType as (typeof LOG_TYPES)[number],
    plane: plane as (typeof LOG_PLANES)[number],
    keyVersion: version,
  });
  return {
    bytes: await encryptLogChunkBody(plaintext, {
      keyBytes,
      encryptionScope,
      keyVersion: version,
      tenantKey,
      logType,
      plane,
      objectKey,
      chunkId,
      compression: compression as (typeof LOG_CHUNK_COMPRESSION)[number],
    }),
    keyVersion: version,
    encryptionScope,
  };
}

function restored(
  object: TenantBackupR2RestoreObject,
  storedBytes: number
): RestoredTenantR2Object {
  if (
    object.state !== 'completed' ||
    !object.object_version ||
    !object.object_etag ||
    !object.stored_sha256
  )
    invalid();
  return {
    bucketBinding: object.target_bucket_binding,
    objectKey: object.target_object_key,
    version: object.object_version,
    etag: object.object_etag,
    storedSha256: object.stored_sha256,
    storedBytes,
    keyVersion: object.target_key_version,
    encryptionScope:
      object.source_encoding === 'log_chunk_v1' ? object.target_encryption_scope : null,
  };
}

/** Restore portable R2 chunks into new target keys, then expose only verified object identities. */
export function createTenantBackupR2ObjectRestorePorts(input: {
  env: RestoreEnv;
  database: Pick<DatabaseAdapter, 'query' | 'queryOne'>;
  finalizer: TenantBackupR2ObjectFinalizer;
  now?: () => number;
}) {
  const store = new TenantBackupR2RestoreStore(input.database);
  const now = input.now ?? Date.now;

  const complete = async (
    context: TenantBackupStepContext,
    datasetId: PortableR2DatasetId,
    source: PortableR2ObjectChunk
  ): Promise<RestoredTenantR2Object> => {
    const identity = owner(context, datasetId, source);
    const prepared = await store.prepareCompletion(identity, now());
    if (prepared.object.state === 'completed') {
      const head = await bucket(input.env, prepared.object.target_bucket_binding).head(
        prepared.object.target_object_key
      );
      if (
        !head ||
        head.version !== prepared.object.object_version ||
        head.etag !== prepared.object.object_etag ||
        (await hashObject(
          bucket(input.env, prepared.object.target_bucket_binding),
          head,
          prepared.object.target_object_key,
          context.signal
        )) !== prepared.object.stored_sha256
      )
        invalid();
      return restored(prepared.object, head.size);
    }

    const target = bucket(input.env, prepared.object.target_bucket_binding);
    let head = await target.head(prepared.object.target_object_key);
    let keyVersionValue: number | null = null;
    let encryptionScope: string | null = null;
    if (prepared.object.write_mode === 'multipart') {
      if (!prepared.object.multipart_id) invalid();
      if (!head) {
        head = await target
          .resumeMultipartUpload(prepared.object.target_object_key, prepared.object.multipart_id)
          .complete(
            prepared.parts.map((part) => ({
              partNumber: part.chunk_index + 1,
              etag: part.target_part_etag ?? invalid(),
            }))
          );
      }
      if (
        head.size !== prepared.object.total_bytes ||
        (await hashObject(target, head, prepared.object.target_object_key, context.signal)) !==
          prepared.object.object_sha256
      )
        invalid();
    } else {
      if (prepared.object.total_bytes > MAX_STAGED_BYTES) invalid();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (const part of prepared.parts) {
        context.signal.throwIfAborted();
        const chunk = await readStagedChunk(
          input.env,
          context,
          part.staging_object_key ?? invalid(),
          part.chunk_sha256
        );
        chunks.push(chunk);
        bytes += chunk.length;
      }
      if (bytes !== prepared.object.total_bytes) invalid();
      const plaintext = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        plaintext.set(chunk, offset);
        offset += chunk.length;
      }
      if ((await sha256(plaintext)) !== prepared.object.object_sha256) invalid();
      const encoded = await encodeTargetBody(
        input.env,
        source,
        prepared.object.target_object_key,
        plaintext
      );
      keyVersionValue = encoded.keyVersion;
      encryptionScope = encoded.encryptionScope;
      const encodedSha256 = await sha256(encoded.bytes);
      const customMetadata = {
        ...(source.customMetadata ?? {}),
        ...(source.sourceEncoding === 'plaintext'
          ? {}
          : {
              checksumSha256: encodedSha256,
              keyVersion: String(encoded.keyVersion ?? invalid()),
              ...(encoded.encryptionScope ? { encryptionScope: encoded.encryptionScope } : {}),
            }),
      };
      await target.put(prepared.object.target_object_key, encoded.bytes, {
        httpMetadata: {
          ...httpMetadata(source.httpMetadata),
          ...(source.sourceEncoding === 'object_artifact_v1'
            ? { contentType: 'application/json', contentEncoding: undefined }
            : source.sourceEncoding === 'log_chunk_v1'
              ? {
                  contentType: 'application/authrim.log-chunk+encrypted',
                  contentEncoding: undefined,
                }
              : {}),
        },
        ...(Object.keys(customMetadata).length ? { customMetadata } : {}),
      });
      head = await target.head(prepared.object.target_object_key);
      if (!head || head.size !== encoded.bytes.length) invalid();
    }
    context.signal.throwIfAborted();
    const storedSha256 = await hashObject(
      target,
      head,
      prepared.object.target_object_key,
      context.signal
    );
    const completed = await store.markCompleted(identity, {
      version: head.version,
      etag: head.etag,
      storedSha256,
      targetKeyVersion: keyVersionValue,
      targetEncryptionScope: encryptionScope,
      now: now(),
    });
    return {
      ...restored(completed, head.size),
      keyVersion: keyVersionValue,
      encryptionScope,
    };
  };

  return {
    async importR2Chunk(
      context: TenantBackupStepContext,
      planDigest: string,
      datasetId: PortableR2DatasetId,
      source: PortableR2ObjectChunk
    ): Promise<void> {
      context.signal.throwIfAborted();
      if (
        !SHA256.test(planDigest) ||
        source.tenantId !== context.lease.tenantId ||
        !SHA256.test(source.chunkSha256) ||
        (await sha256(source.bytes)) !== source.chunkSha256
      )
        invalid();
      const identity = owner(context, datasetId, source);
      const writeMode =
        source.sourceEncoding === 'plaintext' && source.totalBytes > 0 ? 'multipart' : 'staged';
      let state = await store.create(identity, {
        chunk: source,
        writeMode,
        targetBucketBinding: source.bucketBinding,
        targetObjectKey: targetKey(context, datasetId, source),
        now: now(),
      });
      if (state.state === 'completing' || state.state === 'completed') {
        const result = await complete(context, datasetId, source);
        await input.finalizer.finalize(context, planDigest, datasetId, source, result);
        return;
      }
      if (state.state === 'allocating') {
        if (writeMode === 'multipart') {
          const target = bucket(input.env, state.target_bucket_binding);
          const multipart = await target.createMultipartUpload(state.target_object_key, {
            httpMetadata: httpMetadata(source.httpMetadata),
            ...(source.customMetadata ? { customMetadata: { ...source.customMetadata } } : {}),
          });
          try {
            await store.attachMultipart(identity, multipart.uploadId, now());
          } catch {
            await multipart.abort().catch(() => undefined);
            throw new Error('backup_r2_object_restore_invalid');
          }
        } else await store.beginStaging(identity, now());
        state = await store.get(identity, now());
      }
      if (state.state !== 'uploading') invalid();
      const part = await store.reservePart(identity, {
        chunkIndex: source.chunkIndex,
        byteCount: source.bytes.length,
        sha256: source.chunkSha256,
        now: now(),
      });
      if (writeMode === 'multipart') {
        if (!part.target_part_etag) {
          const upload = bucket(input.env, state.target_bucket_binding).resumeMultipartUpload(
            state.target_object_key,
            state.multipart_id ?? invalid()
          );
          const result = await upload.uploadPart(source.chunkIndex + 1, source.bytes);
          if (result.partNumber !== source.chunkIndex + 1) invalid();
          await store.acknowledgePart(identity, {
            chunkIndex: source.chunkIndex,
            byteCount: source.bytes.length,
            sha256: source.chunkSha256,
            targetPartEtag: result.etag,
            now: now(),
          });
        }
      } else if (!part.staging_object_key) {
        const key = stagingKey(context, datasetId, source);
        await writeStagedChunk(input.env, context, key, source.bytes);
        await store.acknowledgePart(identity, {
          chunkIndex: source.chunkIndex,
          byteCount: source.bytes.length,
          sha256: source.chunkSha256,
          stagingObjectKey: key,
          now: now(),
        });
      }
      if (source.chunkIndex + 1 === source.chunkCount) {
        const result = await complete(context, datasetId, source);
        await input.finalizer.finalize(context, planDigest, datasetId, source, result);
        if (writeMode === 'staged')
          await (input.env.EXPORT_ARTIFACTS ?? invalid()).delete(
            Array.from({ length: source.chunkCount }, (_, index) =>
              stagingKey(context, datasetId, { ...source, chunkIndex: index })
            )
          );
      }
    },

    async verifyR2Chunk(
      context: TenantBackupStepContext,
      planDigest: string,
      datasetId: PortableR2DatasetId,
      source: PortableR2ObjectChunk
    ): Promise<boolean> {
      context.signal.throwIfAborted();
      if (!SHA256.test(planDigest)) invalid();
      const identity = owner(context, datasetId, source);
      const state = await store.get(identity, now());
      if (state.state !== 'completed') return false;
      const part = await input.database.queryOne<{
        byte_count: number;
        chunk_sha256: string;
      }>(
        `SELECT byte_count,chunk_sha256 FROM tenant_backup_r2_restore_parts
         WHERE operation_id=? AND dataset_id=? AND object_id=? AND chunk_index=?`,
        [identity.operationId, identity.datasetId, identity.objectId, source.chunkIndex]
      );
      if (
        !part ||
        part.byte_count !== source.bytes.length ||
        part.chunk_sha256 !== source.chunkSha256
      )
        return false;
      const target = bucket(input.env, state.target_bucket_binding);
      const head = await target.head(state.target_object_key);
      if (
        !head ||
        head.version !== state.object_version ||
        head.etag !== state.object_etag ||
        (source.chunkIndex + 1 === source.chunkCount &&
          (await hashObject(target, head, state.target_object_key, context.signal)) !==
            state.stored_sha256)
      )
        return false;
      const result: RestoredTenantR2Object = {
        bucketBinding: state.target_bucket_binding,
        objectKey: state.target_object_key,
        version: state.object_version ?? invalid(),
        etag: state.object_etag ?? invalid(),
        storedSha256: state.stored_sha256 ?? invalid(),
        storedBytes: head.size,
        keyVersion: state.target_key_version,
        encryptionScope:
          source.sourceEncoding === 'log_chunk_v1' ? state.target_encryption_scope : null,
      };
      return input.finalizer.verify(context, planDigest, datasetId, source, result);
    },
  };
}
