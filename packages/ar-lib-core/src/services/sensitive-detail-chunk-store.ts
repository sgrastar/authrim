import { createLoggingId, type LogType } from '@authrim/ar-lib-logging/contract';
import { buildLogChunkObjectKey } from '@authrim/ar-lib-logging/chunks';
import {
  enqueueLoggingDeliveryPayload,
  type LoggingDeliveryLane,
} from '@authrim/ar-lib-logging/delivery';
import type { DatabaseAdapter } from '../db/adapter';
import { decryptObjectArtifact, encryptObjectArtifact } from './object-artifact-crypto';
import {
  createObjectCatalogEntry,
  generatePublicArtifactId,
  getObjectCatalogObjectRecord,
  type ObjectClass,
} from './object-catalog';
import { resolveAuditTenantKey, type TenantKeyResolver } from './audit/tenant-key';

const MAX_SENSITIVE_DETAIL_CHUNK_BYTES = 16 * 1024 * 1024;

export interface SensitiveDetailChunkIndexRow {
  catalog_id: string;
  tenant_id: string;
  object_class: ObjectClass;
  bucket_binding: 'SENSITIVE_DETAILS';
  object_key: string;
  content_encoding: 'gzip' | 'none';
  line_number: number;
  byte_offset: number | null;
  byte_length: number | null;
  key_version: number;
  checksum_sha256: string | null;
  created_at: number;
  deleted_at: number | null;
}

export interface LoadChunkedSensitiveDetailOptions {
  tenantId: string;
  objectCatalogId: string;
  expectedClass: ObjectClass;
}

export interface SensitiveDetailChunkReadEnv {
  SENSITIVE_DETAILS?: R2Bucket;
  OBJECT_ENCRYPTION_ROOT_KEY?: string;
}

export interface StoreChunkedSensitiveDetailOptions {
  adapter: DatabaseAdapter;
  bucket: R2Bucket;
  rootKeyHex: string;
  tenantId: string;
  objectClass: ObjectClass;
  payload: unknown;
  contentType: string;
  createdAt?: number;
  keyVersion?: number;
  tenantKeySalt?: string;
  tenantKeyResolver?: TenantKeyResolver;
  surface?: string;
  logType?: LogType;
  publicArtifactId?: string;
  queueBindings?: Record<string, unknown>;
  lane?: LoggingDeliveryLane;
  indexDbBinding?: 'DB' | 'DB_ADMIN' | 'LOGGING_INDEX_DB';
}

export interface StoreChunkedSensitiveDetailResult {
  catalogId: string;
  publicArtifactId: string;
  objectKey: string | null;
  lineNumber: number | null;
  checksumSha256: string | null;
  totalBytes: number;
  queued: boolean;
}

export interface StoreImmediateChunkedSensitiveDetailOptions {
  adapter: DatabaseAdapter;
  bucket: R2Bucket;
  rootKeyHex: string;
  tenantId: string;
  objectClass: ObjectClass;
  payload: unknown;
  contentType: string;
  createdAt?: number;
  keyVersion?: number;
  tenantKeySalt?: string;
  tenantKeyResolver?: TenantKeyResolver;
  surface?: string;
  logType?: LogType;
  catalogId?: string | null;
  publicArtifactId?: string;
}

function buildPendingSensitiveDetailObjectKey(catalogId: string): string {
  return `pending-sensitive-detail:${catalogId}`;
}

async function readStreamBytesWithLimit(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes = MAX_SENSITIVE_DETAIL_CHUNK_BYTES
): Promise<Uint8Array> {
  if (maxBytes <= 0) {
    throw new Error('Sensitive detail read limit must be greater than zero');
  }
  if (!stream) {
    return new Uint8Array();
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new Error(`Sensitive detail chunk exceeds maximum size: ${totalBytes} > ${maxBytes}`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function readR2ObjectBytesDecoded(
  object: R2ObjectBody,
  contentEncoding: 'gzip' | 'none'
): Promise<Uint8Array> {
  if (typeof object.size === 'number' && object.size > MAX_SENSITIVE_DETAIL_CHUNK_BYTES) {
    throw new Error(
      `Sensitive detail chunk exceeds maximum size: ${object.size} > ${MAX_SENSITIVE_DETAIL_CHUNK_BYTES}`
    );
  }

  if (contentEncoding === 'none') {
    return readStreamBytesWithLimit(object.body);
  }

  if (typeof DecompressionStream === 'undefined') {
    throw new Error('gzip_decompression_not_available');
  }

  return readStreamBytesWithLimit(object.body.pipeThrough(new DecompressionStream('gzip')));
}

async function readSensitiveDetailJsonLineFromRange(
  bucket: R2Bucket,
  row: SensitiveDetailChunkIndexRow
): Promise<string | null> {
  if (
    row.content_encoding !== 'none' ||
    typeof row.byte_offset !== 'number' ||
    typeof row.byte_length !== 'number' ||
    row.byte_offset < 0 ||
    row.byte_length <= 0
  ) {
    return null;
  }

  const rangedObject = await (
    bucket as unknown as {
      get(
        key: string,
        options?: { range?: { offset: number; length: number } }
      ): Promise<R2ObjectBody | null>;
    }
  ).get(row.object_key, {
    range: {
      offset: row.byte_offset,
      length: row.byte_length,
    },
  });
  if (!rangedObject) {
    return null;
  }

  const line = new TextDecoder()
    .decode(await readR2ObjectBytesDecoded(rangedObject, 'none'))
    .trim();
  return line || null;
}

function getJsonLine(text: string, lineNumber: number): string | null {
  if (lineNumber < 0) {
    return null;
  }

  let currentLine = 0;
  let start = 0;
  for (let index = 0; index <= text.length; index++) {
    if (index !== text.length && text[index] !== '\n') {
      continue;
    }
    if (currentLine === lineNumber) {
      return text.slice(start, index).trim() || null;
    }
    currentLine++;
    start = index + 1;
  }
  return null;
}

function surfaceForObjectClass(objectClass: ObjectClass): string {
  switch (objectClass) {
    case 'admin_audit_detail':
      return 'admin_audit';
    case 'event_log_detail':
      return 'event';
    case 'pii_log_values':
      return 'pii';
    case 'webhook_delivery_payload':
      return 'webhook';
    case 'operational_log_detail':
      return 'operational';
    case 'approval_transport_detail':
      return 'approval_transport';
    default:
      return objectClass;
  }
}

function logTypeForObjectClass(objectClass: ObjectClass): LogType {
  switch (objectClass) {
    case 'admin_audit_detail':
      return 'admin_audit';
    case 'event_log_detail':
      return 'audit';
    case 'pii_log_values':
      return 'pii';
    case 'webhook_delivery_payload':
      return 'webhook';
    case 'operational_log_detail':
      return 'operational';
    case 'approval_transport_detail':
      return 'admin_audit';
    default:
      return 'operational';
  }
}

function estimatePayloadBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function readExistingSensitiveDetailCatalog(
  adapter: DatabaseAdapter,
  input: { tenantId: string; objectClass: ObjectClass; catalogId: string | null | undefined }
): Promise<{ id: string; public_artifact_id: string; created_at: number } | null> {
  if (!input.catalogId) {
    return null;
  }
  return adapter.queryOne<{ id: string; public_artifact_id: string; created_at: number }>(
    `SELECT id, public_artifact_id, created_at
     FROM object_catalog
     WHERE id = ?
       AND tenant_id = ?
       AND object_class = ?
       AND deleted_at IS NULL
     LIMIT 1`,
    [input.catalogId, input.tenantId, input.objectClass]
  );
}

async function upsertSensitiveDetailPhysicalObject(
  adapter: DatabaseAdapter,
  input: {
    tenantId: string;
    catalogId: string;
    objectKey: string;
    keyVersion: number;
    checksumSha256: string;
    totalBytes: number;
    createdAt: number;
  }
): Promise<void> {
  const existing = await getObjectCatalogObjectRecord(
    adapter,
    input.tenantId,
    input.catalogId,
    'canonical_json',
    0
  );

  if (existing) {
    await adapter.execute(
      `UPDATE object_catalog_objects
       SET object_kind = 'chunk',
           bucket_binding = 'SENSITIVE_DETAILS',
           object_key = ?,
           key_version = ?,
           checksum_sha256 = ?,
           total_bytes = ?
       WHERE catalog_id = ?
         AND representation = 'canonical_json'
         AND object_index = 0
         AND deleted_at IS NULL`,
      [input.objectKey, input.keyVersion, input.checksumSha256, input.totalBytes, input.catalogId]
    );
    return;
  }

  await adapter.execute(
    `INSERT INTO object_catalog_objects (
      id, catalog_id, representation, object_kind, object_index, bucket_binding, object_key,
      key_version, checksum_sha256, total_bytes, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      input.catalogId,
      'canonical_json',
      'chunk',
      0,
      'SENSITIVE_DETAILS',
      input.objectKey,
      input.keyVersion,
      input.checksumSha256,
      input.totalBytes,
      input.createdAt,
    ]
  );
}

async function upsertSensitiveDetailChunkIndex(
  adapter: DatabaseAdapter,
  input: {
    catalogId: string;
    tenantId: string;
    objectClass: ObjectClass;
    objectKey: string;
    contentEncoding: 'none';
    lineNumber: number;
    byteOffset: number;
    byteLength: number;
    keyVersion: number;
    checksumSha256: string;
    createdAt: number;
  }
): Promise<void> {
  const existing = await adapter.queryOne<{ catalog_id: string }>(
    'SELECT catalog_id FROM sensitive_detail_chunk_index WHERE catalog_id = ? LIMIT 1',
    [input.catalogId]
  );

  if (existing) {
    await adapter.execute(
      `UPDATE sensitive_detail_chunk_index
       SET tenant_id = ?,
           object_class = ?,
           bucket_binding = 'SENSITIVE_DETAILS',
           object_key = ?,
           content_encoding = ?,
           line_number = ?,
           byte_offset = ?,
           byte_length = ?,
           key_version = ?,
           checksum_sha256 = ?,
           created_at = ?,
           deleted_at = NULL
       WHERE catalog_id = ?`,
      [
        input.tenantId,
        input.objectClass,
        input.objectKey,
        input.contentEncoding,
        input.lineNumber,
        input.byteOffset,
        input.byteLength,
        input.keyVersion,
        input.checksumSha256,
        input.createdAt,
        input.catalogId,
      ]
    );
    return;
  }

  await adapter.execute(
    `INSERT INTO sensitive_detail_chunk_index (
      catalog_id, tenant_id, object_class, bucket_binding, object_key,
      content_encoding, line_number, byte_offset, byte_length, key_version, checksum_sha256,
      created_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.catalogId,
      input.tenantId,
      input.objectClass,
      'SENSITIVE_DETAILS',
      input.objectKey,
      input.contentEncoding,
      input.lineNumber,
      input.byteOffset,
      input.byteLength,
      input.keyVersion,
      input.checksumSha256,
      input.createdAt,
      null,
    ]
  );
}

export async function storeImmediateChunkedSensitiveDetailJson(
  options: StoreImmediateChunkedSensitiveDetailOptions
): Promise<StoreChunkedSensitiveDetailResult> {
  const createdAt = options.createdAt ?? Date.now();
  const keyVersion = options.keyVersion ?? 1;
  const tenantKey = await resolveAuditTenantKey(options.tenantId, {
    tenantKeySalt: options.tenantKeySalt,
    tenantKeyResolver: options.tenantKeyResolver,
  });
  const surface = options.surface ?? surfaceForObjectClass(options.objectClass);
  const logType = options.logType ?? logTypeForObjectClass(options.objectClass);
  const existingCatalog = await readExistingSensitiveDetailCatalog(options.adapter, {
    tenantId: options.tenantId,
    objectClass: options.objectClass,
    catalogId: options.catalogId,
  });
  const catalogId = existingCatalog?.id ?? options.catalogId ?? crypto.randomUUID();
  const publicArtifactId =
    existingCatalog?.public_artifact_id ?? options.publicArtifactId ?? generatePublicArtifactId();
  const objectPartitionAt = existingCatalog?.created_at ?? createdAt;
  const objectKey = buildLogChunkObjectKey({
    prefix: 'sensitive-details/v1',
    tenantKey,
    logType,
    plane: 'sensitive_detail',
    surface,
    createdAt: objectPartitionAt,
    chunkId: catalogId,
    compression: 'none',
  });
  const encrypted = await encryptObjectArtifact(JSON.stringify(options.payload), {
    rootKeyHex: options.rootKeyHex,
    plane: 'SENSITIVE_DETAILS',
    keyVersion,
    contentType: options.contentType,
    context: {
      tenantId: options.tenantId,
      objectKey,
      objectClass: options.objectClass,
    },
  });
  const line = JSON.stringify(encrypted);
  const lineBytes = new TextEncoder().encode(line);
  const body = new TextEncoder().encode(`${line}\n`);
  const checksumSha256 = await sha256Hex(body);

  if (!existingCatalog) {
    await createObjectCatalogEntry(options.adapter, {
      id: catalogId,
      publicArtifactId,
      tenantId: options.tenantId,
      objectClass: options.objectClass,
      createdAt,
      objects: [],
    });
  } else {
    await options.adapter.execute(
      `UPDATE object_catalog
       SET updated_at = ?
       WHERE id = ?
         AND tenant_id = ?
         AND deleted_at IS NULL`,
      [createdAt, catalogId, options.tenantId]
    );
  }

  await options.bucket.put(objectKey, body, {
    httpMetadata: {
      contentType: 'application/x-ndjson',
    },
    customMetadata: {
      tenantKey,
      logType,
      plane: 'sensitive_detail',
      surface,
      recordCount: '1',
      checksumSha256,
      createdAt: String(createdAt),
    },
  });
  await upsertSensitiveDetailPhysicalObject(options.adapter, {
    tenantId: options.tenantId,
    catalogId,
    objectKey,
    keyVersion,
    checksumSha256,
    totalBytes: body.byteLength,
    createdAt,
  });
  await upsertSensitiveDetailChunkIndex(options.adapter, {
    catalogId,
    tenantId: options.tenantId,
    objectClass: options.objectClass,
    objectKey,
    contentEncoding: 'none',
    lineNumber: 0,
    byteOffset: 0,
    byteLength: lineBytes.byteLength,
    keyVersion,
    checksumSha256,
    createdAt,
  });

  return {
    catalogId,
    publicArtifactId,
    objectKey,
    lineNumber: 0,
    checksumSha256,
    totalBytes: body.byteLength,
    queued: false,
  };
}

export async function storeChunkedSensitiveDetailJson(
  options: StoreChunkedSensitiveDetailOptions
): Promise<StoreChunkedSensitiveDetailResult> {
  const createdAt = options.createdAt ?? Date.now();
  const keyVersion = options.keyVersion ?? 1;
  const tenantKey = await resolveAuditTenantKey(options.tenantId, {
    tenantKeySalt: options.tenantKeySalt,
    tenantKeyResolver: options.tenantKeyResolver,
  });
  const surface = options.surface ?? surfaceForObjectClass(options.objectClass);
  const logType = options.logType ?? logTypeForObjectClass(options.objectClass);
  const { catalogId, publicArtifactId } = await createObjectCatalogEntry(options.adapter, {
    tenantId: options.tenantId,
    objectClass: options.objectClass,
    publicArtifactId: options.publicArtifactId,
    createdAt,
    objects: [],
  });
  const pendingObjectKey = buildPendingSensitiveDetailObjectKey(catalogId);
  const encrypted = await encryptObjectArtifact(JSON.stringify(options.payload), {
    rootKeyHex: options.rootKeyHex,
    plane: 'SENSITIVE_DETAILS',
    keyVersion,
    contentType: options.contentType,
    context: {
      tenantId: options.tenantId,
      objectKey: pendingObjectKey,
      objectClass: options.objectClass,
    },
  });
  const record = {
    id: catalogId,
    catalog_id: catalogId,
    public_artifact_id: publicArtifactId,
    tenant_id: options.tenantId,
    object_class: options.objectClass,
    surface,
    content_type: options.contentType,
    payload_envelope_json: JSON.stringify(encrypted),
    pending_object_key: pendingObjectKey,
    key_version: keyVersion,
    event_at: createdAt,
    index_db_binding: options.indexDbBinding ?? 'DB',
  };
  const queueResult = await enqueueLoggingDeliveryPayload(
    {
      payload_type: 'chunk_write',
      schema_version: 1,
      payload_id: createLoggingId('qpl', createdAt),
      tenant_key: tenantKey,
      lane: options.lane ?? 'critical',
      created_at: createdAt,
      log_type: logType,
      plane: 'sensitive_detail',
      records: [record],
      surface,
    } as Parameters<typeof enqueueLoggingDeliveryPayload>[0],
    options.queueBindings ?? {}
  );
  if (!queueResult.queued) {
    throw new Error('sensitive_detail_chunk_queue_unavailable');
  }

  return {
    catalogId,
    publicArtifactId,
    objectKey: null,
    lineNumber: null,
    checksumSha256: null,
    totalBytes: estimatePayloadBytes(record),
    queued: true,
  };
}

export async function loadChunkedSensitiveDetailJson<T>(
  adapter: DatabaseAdapter,
  env: SensitiveDetailChunkReadEnv,
  options: LoadChunkedSensitiveDetailOptions
): Promise<T | null> {
  if (!env.SENSITIVE_DETAILS || !env.OBJECT_ENCRYPTION_ROOT_KEY) {
    return null;
  }

  const row = await adapter.queryOne<SensitiveDetailChunkIndexRow>(
    `SELECT sdci.*
     FROM sensitive_detail_chunk_index sdci
     INNER JOIN object_catalog oc
       ON oc.id = sdci.catalog_id
      AND oc.tenant_id = sdci.tenant_id
      AND oc.object_class = sdci.object_class
      AND oc.deleted_at IS NULL
     WHERE sdci.catalog_id = ?
       AND sdci.tenant_id = ?
       AND sdci.object_class = ?
       AND sdci.deleted_at IS NULL
     LIMIT 1`,
    [options.objectCatalogId, options.tenantId, options.expectedClass]
  );
  if (!row || row.bucket_binding !== 'SENSITIVE_DETAILS') {
    return null;
  }

  const rangedLine = await readSensitiveDetailJsonLineFromRange(env.SENSITIVE_DETAILS, row);
  let line = rangedLine;
  if (!line) {
    const object = await env.SENSITIVE_DETAILS.get(row.object_key);
    if (!object) {
      return null;
    }
    line = getJsonLine(
      new TextDecoder().decode(await readR2ObjectBytesDecoded(object, row.content_encoding)),
      row.line_number
    );
  }
  if (!line) {
    return null;
  }

  const envelope = JSON.parse(line) as Parameters<typeof decryptObjectArtifact>[0];
  const plaintext = await decryptObjectArtifact(envelope, {
    rootKeyHex: env.OBJECT_ENCRYPTION_ROOT_KEY,
    context: {
      tenantId: options.tenantId,
      objectKey: row.object_key,
      objectClass: row.object_class,
    },
  });
  return JSON.parse(plaintext) as T;
}
