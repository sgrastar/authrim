import type { LogChunkCompression, LogPlane, LogType } from '../registry';
import { decryptLogChunkBody } from './r2-chunk-reader';
import { encryptLogChunkBody } from './r2-chunk-writer';

export interface RewrapLogChunkObjectCatalogUpdate {
  objectCatalogId: string;
  byteCount: number;
  checksumSha256: string;
  encryptionScope: string;
  keyVersion: number;
  updatedAt: number;
}

export interface RewrapLogChunkCatalogUpdater {
  updateRewrappedObject(update: RewrapLogChunkObjectCatalogUpdate): Promise<void>;
}

export interface RewrapLogChunkObjectInput {
  bucket: R2Bucket;
  objectCatalogId: string;
  objectKey: string;
  chunkId: string;
  tenantKey: string;
  logType: LogType;
  plane: LogPlane;
  compression: LogChunkCompression;
  from: {
    keyBytes: Uint8Array;
    encryptionScope: string;
    keyVersion: number;
  };
  to: {
    keyBytes: Uint8Array;
    encryptionScope: string;
    keyVersion: number;
  };
  now?: number;
  catalogUpdater?: RewrapLogChunkCatalogUpdater;
  maxBytes?: number;
}

export interface RewrapLogChunkObjectResult {
  objectCatalogId: string;
  objectKey: string;
  byteCount: number;
  checksumSha256: string;
  encryptionScope: string;
  keyVersion: number;
  updatedAt: number;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

const DEFAULT_LOG_CHUNK_REWRAP_MAX_OBJECT_BYTES = 64 * 1024 * 1024;

function resolveMaxObjectBytes(maxBytes?: number): number {
  if (!Number.isFinite(maxBytes ?? DEFAULT_LOG_CHUNK_REWRAP_MAX_OBJECT_BYTES)) {
    return DEFAULT_LOG_CHUNK_REWRAP_MAX_OBJECT_BYTES;
  }
  return Math.max(
    0,
    Math.min(
      Math.trunc(maxBytes ?? DEFAULT_LOG_CHUNK_REWRAP_MAX_OBJECT_BYTES),
      DEFAULT_LOG_CHUNK_REWRAP_MAX_OBJECT_BYTES
    )
  );
}

async function readR2ObjectBytesWithLimit(
  object: R2ObjectBody,
  maxBytes: number
): Promise<Uint8Array> {
  if (typeof object.size === 'number' && object.size > maxBytes) {
    throw new Error('log_chunk_rewrap_object_too_large');
  }

  if (object.body) {
    const reader = object.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          throw new Error('log_chunk_rewrap_object_too_large');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new Error('log_chunk_rewrap_object_too_large');
  }
  return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}

export async function rewrapLogChunkObject(
  input: RewrapLogChunkObjectInput
): Promise<RewrapLogChunkObjectResult> {
  const object = await input.bucket.get(input.objectKey);
  if (!object) {
    throw new Error('log_chunk_rewrap_object_not_found');
  }

  const storedBody = await readR2ObjectBytesWithLimit(
    object,
    resolveMaxObjectBytes(input.maxBytes)
  );
  const decoded = await decryptLogChunkBody({
    storedBody,
    keyBytes: input.from.keyBytes,
    tenantKey: input.tenantKey,
    logType: input.logType,
    plane: input.plane,
    objectKey: input.objectKey,
    chunkId: input.chunkId,
    expectedEncryptionScope: input.from.encryptionScope,
    expectedKeyVersion: input.from.keyVersion,
  });
  const rewrappedBody = await encryptLogChunkBody(decoded.body, {
    keyBytes: input.to.keyBytes,
    encryptionScope: input.to.encryptionScope,
    keyVersion: input.to.keyVersion,
    tenantKey: input.tenantKey,
    logType: input.logType,
    plane: input.plane,
    objectKey: input.objectKey,
    chunkId: input.chunkId,
    compression: input.compression,
  });
  const checksumSha256 = await sha256Hex(rewrappedBody);
  const updatedAt = input.now ?? Date.now();

  await input.bucket.put(input.objectKey, rewrappedBody, {
    httpMetadata: {
      contentType: 'application/authrim.log-chunk+encrypted',
    },
    customMetadata: {
      tenantKey: input.tenantKey,
      logType: input.logType,
      plane: input.plane,
      checksumSha256,
      compression: input.compression,
      encryptionScope: input.to.encryptionScope,
      keyVersion: String(input.to.keyVersion),
      rewrappedAt: String(updatedAt),
    },
  });

  const update = {
    objectCatalogId: input.objectCatalogId,
    byteCount: rewrappedBody.byteLength,
    checksumSha256,
    encryptionScope: input.to.encryptionScope,
    keyVersion: input.to.keyVersion,
    updatedAt,
  };
  await input.catalogUpdater?.updateRewrappedObject(update);

  return {
    objectCatalogId: input.objectCatalogId,
    objectKey: input.objectKey,
    byteCount: rewrappedBody.byteLength,
    checksumSha256,
    encryptionScope: input.to.encryptionScope,
    keyVersion: input.to.keyVersion,
    updatedAt,
  };
}
