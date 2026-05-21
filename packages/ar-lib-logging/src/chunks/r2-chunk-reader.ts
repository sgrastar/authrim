import type { LogChunkCompression, LogPlane, LogType } from '../registry';
import { decodeLogRecordFromBlock } from './record-blocks';
import type { LogChunkRecordIndexRow } from './types';

export interface EncryptedLogChunkEnvelope {
  version: 1;
  algorithm: 'AES-256-GCM';
  contentType: 'application/authrim.log-chunk+jsonl';
  compression: LogChunkCompression;
  encryptionScope: string;
  keyVersion: number;
  iv: string;
  ciphertext: string;
}

export interface DecryptLogChunkBodyInput {
  storedBody: Uint8Array | string;
  keyBytes: Uint8Array;
  tenantKey: string;
  logType: LogType;
  plane: LogPlane;
  objectKey: string;
  chunkId: string;
  expectedEncryptionScope?: string;
  expectedKeyVersion?: number;
}

export interface DecodeStoredLogChunkBodyInput {
  storedBody: Uint8Array | string;
  compression: LogChunkCompression;
  encryption?: Omit<DecryptLogChunkBodyInput, 'storedBody'>;
}

export interface DecodedStoredLogChunkBody {
  body: Uint8Array;
  compression: LogChunkCompression;
  encryptionScope?: string;
  keyVersion?: number;
}

export interface DecodeStoredLogChunkRecordInput extends DecodeStoredLogChunkBodyInput {
  recordIndex: LogChunkRecordIndexRow;
}

function asBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === 'string' ? new TextEncoder().encode(value) : value;
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function readEncryptedLogChunkEnvelope(value: Uint8Array | string): EncryptedLogChunkEnvelope {
  const parsed = JSON.parse(
    new TextDecoder().decode(asBytes(value))
  ) as Partial<EncryptedLogChunkEnvelope>;
  if (
    parsed.version !== 1 ||
    parsed.algorithm !== 'AES-256-GCM' ||
    parsed.contentType !== 'application/authrim.log-chunk+jsonl' ||
    typeof parsed.compression !== 'string' ||
    typeof parsed.encryptionScope !== 'string' ||
    typeof parsed.keyVersion !== 'number' ||
    typeof parsed.iv !== 'string' ||
    typeof parsed.ciphertext !== 'string'
  ) {
    throw new Error('invalid_log_chunk_encryption_envelope');
  }
  return parsed as EncryptedLogChunkEnvelope;
}

export async function decryptLogChunkBody(
  input: DecryptLogChunkBodyInput
): Promise<DecodedStoredLogChunkBody> {
  if (input.keyBytes.length !== 32) {
    throw new Error('log_chunk_decryption_key_must_be_32_bytes');
  }

  const envelope = readEncryptedLogChunkEnvelope(input.storedBody);
  if (input.expectedEncryptionScope && input.expectedEncryptionScope !== envelope.encryptionScope) {
    throw new Error('log_chunk_encryption_scope_mismatch');
  }
  if (input.expectedKeyVersion !== undefined && input.expectedKeyVersion !== envelope.keyVersion) {
    throw new Error('log_chunk_key_version_mismatch');
  }

  const key = await crypto.subtle.importKey('raw', input.keyBytes, { name: 'AES-GCM' }, false, [
    'decrypt',
  ]);
  const aad = new TextEncoder().encode(
    JSON.stringify({
      tenant_key: input.tenantKey,
      log_type: input.logType,
      plane: input.plane,
      object_key: input.objectKey,
      chunk_id: input.chunkId,
      compression: envelope.compression,
      encryption_scope: envelope.encryptionScope,
      key_version: envelope.keyVersion,
    })
  );
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: fromBase64Url(envelope.iv),
      additionalData: aad,
      tagLength: 128,
    },
    key,
    fromBase64Url(envelope.ciphertext)
  );

  return {
    body: new Uint8Array(plaintext),
    compression: envelope.compression,
    encryptionScope: envelope.encryptionScope,
    keyVersion: envelope.keyVersion,
  };
}

export async function decodeStoredLogChunkBody(
  input: DecodeStoredLogChunkBodyInput
): Promise<DecodedStoredLogChunkBody> {
  if (!input.encryption) {
    return {
      body: asBytes(input.storedBody),
      compression: input.compression,
    };
  }
  return decryptLogChunkBody({
    storedBody: input.storedBody,
    ...input.encryption,
  });
}

export async function decodeStoredLogChunkRecord(
  input: DecodeStoredLogChunkRecordInput
): Promise<unknown> {
  const decoded = await decodeStoredLogChunkBody(input);
  const blockOffset = input.recordIndex.blockOffset ?? 0;
  const blockLength = input.recordIndex.blockLength ?? decoded.body.byteLength;
  return decodeLogRecordFromBlock(
    decoded.body,
    {
      blockIndex: 0,
      compressedOffset: blockOffset,
      compressedLength: blockLength,
      uncompressedLength: blockLength,
      firstLineNumber: input.recordIndex.lineNumber,
      lastLineNumber: input.recordIndex.lineNumber,
      recordCount: 1,
    },
    {
      recordId: input.recordIndex.recordId,
      lineNumber: input.recordIndex.lineNumber,
      blockIndex: 0,
      recordOffset: input.recordIndex.recordOffset,
      recordLength: input.recordIndex.recordLength,
    },
    decoded.compression
  );
}
