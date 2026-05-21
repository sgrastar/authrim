import { createLoggingId } from '../ids';
import { assertLogPlane, assertLogType, type LogChunkCompression } from '../registry';
import { filterLogChunkIndexedFields, getLogChunkIndexProfile } from './index-profiles';
import { buildLogChunkObjectKey } from './r2-keys';
import { encodeLogRecordBlocks } from './record-blocks';
import type {
  LogChunkRecordIndexRow,
  LogObjectCatalogRow,
  LogChunkEncryptionOptions,
  WriteLogChunkInput,
  WriteLogChunkResult,
} from './types';

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export async function encryptLogChunkBody(
  plaintext: Uint8Array,
  options: LogChunkEncryptionOptions & {
    tenantKey: string;
    logType: string;
    plane: string;
    objectKey: string;
    chunkId: string;
    compression: LogChunkCompression;
  }
): Promise<Uint8Array> {
  if (options.keyBytes.length !== 32) {
    throw new Error('log_chunk_encryption_key_must_be_32_bytes');
  }

  const key = await crypto.subtle.importKey('raw', options.keyBytes, { name: 'AES-GCM' }, false, [
    'encrypt',
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(
    JSON.stringify({
      tenant_key: options.tenantKey,
      log_type: options.logType,
      plane: options.plane,
      object_key: options.objectKey,
      chunk_id: options.chunkId,
      compression: options.compression,
      encryption_scope: options.encryptionScope,
      key_version: options.keyVersion,
    })
  );
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: aad,
      tagLength: 128,
    },
    key,
    plaintext
  );
  return new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      algorithm: 'AES-256-GCM',
      contentType: 'application/authrim.log-chunk+jsonl',
      compression: options.compression,
      encryptionScope: options.encryptionScope,
      keyVersion: options.keyVersion,
      iv: toBase64Url(iv),
      ciphertext: toBase64Url(new Uint8Array(ciphertext)),
    })
  );
}

export async function writeLogChunkToR2(input: WriteLogChunkInput): Promise<WriteLogChunkResult> {
  if (input.records.length === 0) {
    throw new Error('log_chunk_records_required');
  }

  assertLogType(input.logType);
  assertLogPlane(input.plane);

  const createdAt = input.now ?? Date.now();
  const chunkId = createLoggingId('chk', createdAt);
  const objectCatalogId = createLoggingId('obj', createdAt);
  const compression: LogChunkCompression = input.compression ?? 'gzip_block';
  const indexProfile = getLogChunkIndexProfile(input.indexProfile ?? input.logType).name;
  const encoded = await encodeLogRecordBlocks(input.records, { compression });
  const objectKey = buildLogChunkObjectKey({
    prefix: input.prefix,
    tenantKey: input.tenantKey,
    logType: input.logType,
    plane: input.plane,
    surface: input.surface,
    createdAt,
    chunkId,
    compression,
  });
  const storedBody = input.encryption
    ? await encryptLogChunkBody(encoded.body, {
        ...input.encryption,
        tenantKey: input.tenantKey,
        logType: input.logType,
        plane: input.plane,
        objectKey,
        chunkId,
        compression,
      })
    : encoded.body;
  const checksumSha256 = await sha256Hex(storedBody);

  const objectRow: LogObjectCatalogRow = {
    id: objectCatalogId,
    tenantKey: input.tenantKey,
    logType: input.logType,
    plane: input.plane,
    surface: input.surface,
    objectKey,
    objectKind: 'chunk',
    status: 'pending',
    recordCount: input.records.length,
    byteCount: storedBody.byteLength,
    compression,
    encryptionScope: input.encryption?.encryptionScope,
    keyVersion: input.encryption?.keyVersion,
    createdAt,
  };

  const indexRows: LogChunkRecordIndexRow[] = input.records.map((record, index) => {
    const location = encoded.records[index];
    const block = location ? encoded.blocks[location.blockIndex] : undefined;
    return {
      recordId: record.id,
      tenantKey: input.tenantKey,
      logType: input.logType,
      plane: input.plane,
      surface: input.surface,
      objectCatalogId,
      chunkId,
      lineNumber: location?.lineNumber ?? index,
      blockOffset: block?.compressedOffset ?? null,
      blockLength: block?.compressedLength ?? null,
      recordOffset: location?.recordOffset ?? 0,
      recordLength: location?.recordLength ?? 0,
      eventAt: record.eventAt,
      indexProfile,
      indexedFields: filterLogChunkIndexedFields(indexProfile, record.indexedFields),
      status: 'pending',
      createdAt,
    };
  });

  await input.catalogStore?.createPendingObject(objectRow);
  await input.catalogStore?.createPendingRecordIndexes(indexRows);

  try {
    await input.bucket.put(objectKey, storedBody, {
      httpMetadata: {
        contentType: input.encryption
          ? 'application/authrim.log-chunk+encrypted'
          : 'application/x-ndjson',
        contentEncoding: input.encryption
          ? undefined
          : compression === 'gzip_block'
            ? 'gzip'
            : undefined,
      },
      customMetadata: {
        tenantKey: input.tenantKey,
        logType: input.logType,
        plane: input.plane,
        recordCount: String(input.records.length),
        checksumSha256,
        compression,
        ...(input.encryption && {
          encryptionScope: input.encryption.encryptionScope,
          keyVersion: String(input.encryption.keyVersion),
        }),
        createdAt: String(createdAt),
      },
    });
  } catch (error) {
    await input.catalogStore?.markObjectOrphanCandidate(objectCatalogId, Date.now());
    throw error;
  }

  const committedAt = Date.now();
  await input.catalogStore?.commitObject(objectCatalogId, {
    byteCount: storedBody.byteLength,
    checksumSha256,
    committedAt,
  });
  await input.catalogStore?.commitRecordIndexes(objectCatalogId, committedAt);

  return {
    chunkId,
    objectCatalogId,
    objectKey,
    recordCount: input.records.length,
    byteCount: storedBody.byteLength,
    checksumSha256,
    compression,
    encryptionScope: input.encryption?.encryptionScope,
    keyVersion: input.encryption?.keyVersion,
    createdAt,
  };
}
