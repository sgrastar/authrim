import type { TenantPortableDataset } from './module-contract.js';
import type {
  PortableSqliteRow,
  SqliteDatasetInspectionPolicy,
} from './sqlite-dataset-inspector.js';
import type { CaptureSchema } from './sqlite-snapshot.js';

export const ARTIFACT_OBJECT_BODIES_DATASET = {
  id: 'artifacts.object_catalog_bodies',
  module: 'artifacts',
  kind: 'artifacts',
  store: 'object',
  schemaVersion: 1,
  disposition: 'include',
} as const satisfies TenantPortableDataset;

export const LOG_ARCHIVE_OBJECT_BODIES_DATASET = {
  id: 'logs.archive_object_bodies',
  module: 'logs',
  kind: 'log_dependencies',
  store: 'object',
  schemaVersion: 1,
  disposition: 'include',
} as const satisfies TenantPortableDataset;

export const TENANT_BACKUP_R2_CHUNK_BYTES = 5 * 1024 * 1024;
export const TENANT_BACKUP_R2_MAX_CHUNKS = 4096;

export type PortableR2DatasetId =
  | typeof ARTIFACT_OBJECT_BODIES_DATASET.id
  | typeof LOG_ARCHIVE_OBJECT_BODIES_DATASET.id;

export type PortableR2BucketBinding =
  | 'AUDIT_ARCHIVE'
  | 'DIAGNOSTIC_LOGS'
  | 'EXPORT_ARTIFACTS'
  | 'IMPORT_ARTIFACTS'
  | 'SENSITIVE_DETAILS';

export type PortableR2SourceEncoding =
  | 'plaintext'
  | 'object_artifact_v1'
  | 'log_chunk_v1'
  | 'log_chunk_records_v1'
  | 'sensitive_detail_record_v1';

export interface PortableR2ObjectChunk {
  tenantId: string;
  objectId: string;
  bucketBinding: PortableR2BucketBinding;
  objectKey: string;
  sourceEncoding: PortableR2SourceEncoding;
  objectSha256: string;
  totalBytes: number;
  chunkIndex: number;
  chunkCount: number;
  chunkSha256: string;
  bytes: Uint8Array;
  context: Readonly<Record<string, unknown>>;
  httpMetadata: Readonly<Record<string, unknown>> | null;
  customMetadata: Readonly<Record<string, string>> | null;
}

const COLUMNS = [
  'tenant_id',
  'object_id',
  'bucket_binding',
  'object_key',
  'source_encoding',
  'object_sha256',
  'total_bytes',
  'chunk_index',
  'chunk_count',
  'chunk_sha256',
  'bytes_base64',
  'context_json',
  'http_metadata_json',
  'custom_metadata_json',
] as const;

const SCHEMA: CaptureSchema = {
  table: 'tenant_r2_object_chunks_backup',
  tenantColumn: 'tenant_id',
  columns: COLUMNS,
  primaryKey: ['tenant_id', 'object_id', 'chunk_index'],
  uniqueKeys: [],
};

const BUCKET_BINDINGS = new Set<PortableR2BucketBinding>([
  'AUDIT_ARCHIVE',
  'DIAGNOSTIC_LOGS',
  'EXPORT_ARTIFACTS',
  'IMPORT_ARTIFACTS',
  'SENSITIVE_DETAILS',
]);
const SOURCE_ENCODINGS = new Set<PortableR2SourceEncoding>([
  'plaintext',
  'object_artifact_v1',
  'log_chunk_v1',
  'log_chunk_records_v1',
  'sensitive_detail_record_v1',
]);
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,256}$/u;
const SAFE_OBJECT_ID = /^[A-Za-z0-9_.:-]{1,512}$/u;

function invalid(): never {
  throw new Error('backup_portable_r2_object_invalid');
}

function text(row: PortableSqliteRow, key: string, maxBytes: number, empty = false): string {
  const value = row[key];
  if (
    value?.[0] !== 'text' ||
    value[1] === null ||
    (!empty && value[1].length === 0) ||
    new TextEncoder().encode(value[1]).length > maxBytes
  )
    invalid();
  return value[1];
}

function integer(row: PortableSqliteRow, key: string): number {
  const value = row[key];
  if (value?.[0] !== 'integer' || value[1] === null || !/^(0|[1-9][0-9]{0,15})$/u.test(value[1]))
    invalid();
  const parsed = Number(value[1]);
  if (!Number.isSafeInteger(parsed)) invalid();
  return parsed;
}

function nullableText(row: PortableSqliteRow, key: string, maxBytes: number): string | null {
  const value = row[key];
  if (value?.[0] === 'null' && value[1] === null) return null;
  return text(row, key, maxBytes, true);
}

function parseObjectJson(value: string, maxBytes: number): Readonly<Record<string, unknown>> {
  if (new TextEncoder().encode(value).length > maxBytes) invalid();
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    return invalid();
  }
}

function stringMetadata(
  value: Readonly<Record<string, unknown>>
): Readonly<Record<string, string>> {
  if (Object.values(value).some((item) => typeof item !== 'string')) invalid();
  return value as Readonly<Record<string, string>>;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (encodeBase64(bytes) !== value) invalid();
    return bytes;
  } catch {
    return invalid();
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function validateObject(input: PortableR2ObjectChunk): void {
  const contextJson = JSON.stringify(input.context);
  const httpMetadataJson = input.httpMetadata === null ? null : JSON.stringify(input.httpMetadata);
  const customMetadataJson =
    input.customMetadata === null ? null : JSON.stringify(input.customMetadata);
  if (
    !SAFE_ID.test(input.tenantId) ||
    !SAFE_OBJECT_ID.test(input.objectId) ||
    !BUCKET_BINDINGS.has(input.bucketBinding) ||
    !SOURCE_ENCODINGS.has(input.sourceEncoding) ||
    !input.objectKey ||
    new TextEncoder().encode(input.objectKey).length > 1024 ||
    [...input.objectKey].some((character) => {
      const code = character.codePointAt(0) ?? -1;
      return code <= 0x1f || code === 0x7f;
    }) ||
    !SHA256.test(input.objectSha256) ||
    !SHA256.test(input.chunkSha256) ||
    !Number.isSafeInteger(input.totalBytes) ||
    input.totalBytes < 0 ||
    !Number.isSafeInteger(input.chunkIndex) ||
    input.chunkIndex < 0 ||
    !Number.isSafeInteger(input.chunkCount) ||
    input.chunkCount < 1 ||
    input.chunkCount > TENANT_BACKUP_R2_MAX_CHUNKS ||
    input.chunkIndex >= input.chunkCount ||
    !(input.bytes instanceof Uint8Array) ||
    input.bytes.length > TENANT_BACKUP_R2_CHUNK_BYTES ||
    (input.totalBytes === 0
      ? input.chunkCount !== 1 || input.chunkIndex !== 0 || input.bytes.length !== 0
      : input.bytes.length === 0) ||
    !contextJson ||
    new TextEncoder().encode(contextJson).length > 8192 ||
    (httpMetadataJson !== null && new TextEncoder().encode(httpMetadataJson).length > 8192) ||
    (customMetadataJson !== null && new TextEncoder().encode(customMetadataJson).length > 8192) ||
    (input.customMetadata !== null &&
      Object.values(input.customMetadata).some((value) => typeof value !== 'string'))
  )
    invalid();
  const expectedChunkCount = Math.max(
    1,
    Math.ceil(input.totalBytes / TENANT_BACKUP_R2_CHUNK_BYTES)
  );
  const expectedChunkBytes =
    input.totalBytes === 0
      ? 0
      : input.chunkIndex + 1 < expectedChunkCount
        ? TENANT_BACKUP_R2_CHUNK_BYTES
        : input.totalBytes - input.chunkIndex * TENANT_BACKUP_R2_CHUNK_BYTES;
  if (input.chunkCount !== expectedChunkCount || input.bytes.length !== expectedChunkBytes)
    invalid();
  if (
    input.chunkCount === 1 &&
    (input.totalBytes !== input.bytes.length || input.objectSha256 !== input.chunkSha256)
  )
    invalid();
}

function parseRow(rowJson: string): PortableSqliteRow {
  try {
    const parsed: unknown = JSON.parse(rowJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
    if (Object.keys(parsed).sort().join(',') !== [...COLUMNS].sort().join(',')) invalid();
    return parsed as PortableSqliteRow;
  } catch {
    return invalid();
  }
}

export async function encodePortableR2ObjectChunk(
  input: PortableR2ObjectChunk
): Promise<Uint8Array> {
  validateObject(input);
  if ((await sha256(input.bytes)) !== input.chunkSha256) invalid();
  const encoded = new TextEncoder().encode(
    `${JSON.stringify({
      tenant_id: ['text', input.tenantId],
      object_id: ['text', input.objectId],
      bucket_binding: ['text', input.bucketBinding],
      object_key: ['text', input.objectKey],
      source_encoding: ['text', input.sourceEncoding],
      object_sha256: ['text', input.objectSha256],
      total_bytes: ['integer', String(input.totalBytes)],
      chunk_index: ['integer', String(input.chunkIndex)],
      chunk_count: ['integer', String(input.chunkCount)],
      chunk_sha256: ['text', input.chunkSha256],
      bytes_base64: ['text', encodeBase64(input.bytes)],
      context_json: ['text', JSON.stringify(input.context)],
      http_metadata_json:
        input.httpMetadata === null ? ['null', null] : ['text', JSON.stringify(input.httpMetadata)],
      custom_metadata_json:
        input.customMetadata === null
          ? ['null', null]
          : ['text', JSON.stringify(input.customMetadata)],
    } satisfies PortableSqliteRow)}\n`
  );
  await decodePortableR2ObjectChunk(new TextDecoder().decode(encoded).trimEnd(), input.tenantId);
  return encoded;
}

export async function decodePortableR2ObjectChunk(
  rowJson: string,
  tenantId: string
): Promise<PortableR2ObjectChunk> {
  const row = parseRow(rowJson);
  const context = parseObjectJson(text(row, 'context_json', 8192), 8192);
  const httpMetadataValue = nullableText(row, 'http_metadata_json', 8192);
  const customMetadataValue = nullableText(row, 'custom_metadata_json', 8192);
  const result: PortableR2ObjectChunk = {
    tenantId: text(row, 'tenant_id', 256),
    objectId: text(row, 'object_id', 512),
    bucketBinding: text(row, 'bucket_binding', 32) as PortableR2BucketBinding,
    objectKey: text(row, 'object_key', 1024),
    sourceEncoding: text(row, 'source_encoding', 32) as PortableR2SourceEncoding,
    objectSha256: text(row, 'object_sha256', 64),
    totalBytes: integer(row, 'total_bytes'),
    chunkIndex: integer(row, 'chunk_index'),
    chunkCount: integer(row, 'chunk_count'),
    chunkSha256: text(row, 'chunk_sha256', 64),
    bytes: decodeBase64(text(row, 'bytes_base64', 7 * 1024 * 1024, true)),
    context,
    httpMetadata: httpMetadataValue === null ? null : parseObjectJson(httpMetadataValue, 8192),
    customMetadata:
      customMetadataValue === null
        ? null
        : stringMetadata(parseObjectJson(customMetadataValue, 8192)),
  };
  validateObject(result);
  if (result.tenantId !== tenantId || (await sha256(result.bytes)) !== result.chunkSha256)
    invalid();
  return result;
}

export function createPortableR2ObjectDatasetPolicies(): SqliteDatasetInspectionPolicy[] {
  return [ARTIFACT_OBJECT_BODIES_DATASET, LOG_ARCHIVE_OBJECT_BODIES_DATASET].map((dataset) => ({
    dataset: structuredClone(dataset),
    schema: structuredClone(SCHEMA),
    async inspectRow(row) {
      await decodePortableR2ObjectChunk(JSON.stringify(row), text(row, 'tenant_id', 256));
      return [];
    },
  }));
}
