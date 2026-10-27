import { LOG_ARCHIVE_SCHEMA_VERSION } from './capabilities.js';

/** IDs are persistent Iceberg column identities; never renumber or reuse them. */
export const LOG_ARCHIVE_FIELDS = [
  { id: 1, name: 'schema_version', type: 'int', required: true },
  { id: 2, name: 'storage_generation', type: 'string', required: true },
  { id: 3, name: 'event_id', type: 'string', required: true },
  { id: 4, name: 'tenant_key', type: 'string', required: true },
  { id: 5, name: 'source_dataset', type: 'string', required: true },
  { id: 6, name: 'log_type', type: 'string', required: true },
  { id: 7, name: 'event_at', type: 'long', required: true },
  { id: 8, name: 'ingested_at', type: 'long', required: true },
  { id: 9, name: 'expires_at', type: 'long', required: false },
  { id: 10, name: 'action', type: 'string', required: false },
  { id: 11, name: 'result', type: 'string', required: false },
  { id: 12, name: 'severity', type: 'string', required: false },
  { id: 13, name: 'reason_code', type: 'string', required: false },
  { id: 14, name: 'request_id', type: 'string', required: false },
  { id: 15, name: 'subject_id', type: 'string', required: false },
  { id: 16, name: 'client_id', type: 'string', required: false },
  { id: 17, name: 'resource_id', type: 'string', required: false },
  { id: 18, name: 'detail_ciphertext', type: 'string', required: true },
  { id: 19, name: 'detail_key_version', type: 'string', required: true },
  { id: 20, name: 'payload_hmac', type: 'string', required: true },
] as const;

export const LOG_ARCHIVE_ICEBERG_SCHEMA = {
  type: 'struct' as const,
  'schema-id': 0,
  'identifier-field-ids': [3, 4, 5],
  fields: LOG_ARCHIVE_FIELDS.map((field) => ({ ...field })),
};

export const LOG_ARCHIVE_STREAM_SCHEMA = {
  fields: LOG_ARCHIVE_FIELDS.map(({ name, type, required }) => ({
    name,
    type: type === 'int' ? ('int32' as const) : type === 'long' ? ('int64' as const) : type,
    required,
  })),
};

export interface LogArchiveRecord {
  schema_version: number;
  storage_generation: string;
  event_id: string;
  tenant_key: string;
  source_dataset: string;
  log_type: string;
  /** Milliseconds since Unix epoch. Pipeline JSON must remain lossless. */
  event_at: number;
  ingested_at: number;
  expires_at: number | null;
  action: string | null;
  result: string | null;
  severity: string | null;
  reason_code: string | null;
  request_id: string | null;
  subject_id: string | null;
  client_id: string | null;
  resource_id: string | null;
  /** Already encrypted, authenticated to tenant/event/dataset/schema context. */
  detail_ciphertext: string;
  detail_key_version: string;
  payload_hmac: string;
}

/** Reject undeclared columns before either destination receives plaintext metadata. */
export function assertLogArchiveRecord(value: unknown): asserts value is LogArchiveRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid log archive record');
  }
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== LOG_ARCHIVE_FIELDS.length) {
    throw new Error('Unexpected log archive fields');
  }
  for (const field of LOG_ARCHIVE_FIELDS) {
    const item = row[field.name];
    if (item === null && !field.required) continue;
    if (field.type === 'string') {
      const maximum =
        field.name === 'detail_ciphertext'
          ? 4 * 1024 * 1024
          : field.name === 'storage_generation'
            ? 96
            : field.name === 'detail_key_version'
              ? 9
              : field.name === 'payload_hmac'
                ? 64
                : field.required
                  ? 256
                  : 512;
      if (
        typeof item !== 'string' ||
        item.length > maximum ||
        (field.required && item.length === 0)
      ) {
        throw new Error(`Invalid archive field ${field.name}`);
      }
      if (field.name === 'detail_key_version' && !/^[1-9][0-9]{0,8}$/.test(item))
        throw new Error('Invalid archive key version');
      if (field.name === 'payload_hmac' && !/^[a-f0-9]{64}$/.test(item))
        throw new Error('Invalid archive payload HMAC');
    } else if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0) {
      throw new Error(`Invalid archive field ${field.name}`);
    }
  }
  if (row.schema_version !== LOG_ARCHIVE_SCHEMA_VERSION)
    throw new Error('Unsupported archive schema');
}

export async function logArchiveSchemaDigest(): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(LOG_ARCHIVE_FIELDS));
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
