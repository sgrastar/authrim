import {
  assertLogArchiveRecord,
  type LogArchiveRecord,
} from '@authrim/ar-lib-logging/iceberg/schema';
import {
  decryptObjectArtifact,
  encryptObjectArtifact,
  type EncryptedObjectArtifactEnvelope,
} from './object-artifact-crypto';
import type { LogIcebergConfig } from './log-iceberg-config';

const encoder = new TextEncoder();
export const LOG_ICEBERG_MAX_BODY_BYTES = 3 * 1024 * 1024 - 32 * 1024;
export const LOG_ICEBERG_ROW_BODY_SCHEMA = 'authrim.log.iceberg-row.v1';
const OVERVIEW_FIELDS = [
  'action',
  'result',
  'severity',
  'reason_code',
  'request_id',
  'subject_id',
  'client_id',
  'resource_id',
] as const;
export type LogIcebergOverview = Pick<LogArchiveRecord, (typeof OVERVIEW_FIELDS)[number]>;
export interface LogIcebergRecordInput {
  eventId: string;
  tenantKey: string;
  sourceDataset: string;
  logType: string;
  eventAt: number;
  ingestedAt: number;
  expiresAt: number | null;
  /** Only explicitly selected overview fields; never spread arbitrary event metadata here. */
  overview?: Partial<LogIcebergOverview>;
  body: Record<string, unknown>;
}

export interface LogIcebergRecordKeys {
  rootKeyHex: string;
  keyVersion: number;
  /** Stable across encryption-key rotations and storage generations. */
  contentHmacKeyHex: string;
}

function invalid(): never {
  throw new Error('log_iceberg_record_invalid');
}

/** Stable JSON is used for duplicate detection, never an unkeyed hash of sensitive values. */
function canonical(value: unknown, depth = 0): string {
  if (depth > 32) invalid();
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
      invalid();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) invalid();
    return `[${value.map((v) => canonical(v, depth + 1)).join(',')}]`;
  }
  if (typeof value !== 'object' || !value) invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key], depth + 1)}`)
    .join(',')}}`;
}

function identity(record: Omit<LogArchiveRecord, 'detail_ciphertext' | 'payload_hmac'>) {
  // A generation labels storage, not logical identity. The same envelope is kept on retry.
  const {
    storage_generation: _generation,
    ingested_at: _ingested,
    detail_key_version: _keyVersion,
    ...semantic
  } = record;
  return semantic;
}

function cryptoContext(record: Omit<LogArchiveRecord, 'detail_ciphertext'>) {
  return {
    tenantId: record.tenant_key,
    objectKey: canonical(record),
    objectClass: 'event_log_detail' as const,
  };
}

async function digest(body: string, rootKey: string, semantic: unknown): Promise<string> {
  if (!/^[a-fA-F0-9]{64}$/.test(rootKey)) invalid();
  const material = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(rootKey.match(/../g) ?? [], (value) => Number.parseInt(value, 16)),
    'HKDF',
    false,
    ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('authrim-iceberg-payload-hmac-v1'),
      info: encoder.encode('event-content'),
    },
    material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${canonical(semantic)}\n${body}`)
  );
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Encryption epochs/nonces of separately authorized details are not business
 * content. Their stable keyed digest is itself authenticated by the outer AEAD. */
function contentBody(body: Record<string, unknown>): Record<string, unknown> {
  if (body.format !== LOG_ICEBERG_ROW_BODY_SCHEMA) return body;
  if (
    !body.row ||
    typeof body.row !== 'object' ||
    Array.isArray(body.row) ||
    Object.keys(body).some((key) => !['format', 'row', 'protected_detail'].includes(key))
  )
    invalid();
  if (body.protected_detail === undefined) return body;
  const detail = body.protected_detail;
  if (
    !detail ||
    typeof detail !== 'object' ||
    Array.isArray(detail) ||
    !('schema_version' in detail) ||
    detail.schema_version !== 1 ||
    !('payload_hmac' in detail) ||
    typeof detail.payload_hmac !== 'string' ||
    !/^[a-f0-9]{64}$/.test(detail.payload_hmac) ||
    Object.keys(detail).length !== 4 ||
    !('key_version' in detail) ||
    !('envelope' in detail)
  )
    invalid();
  return { ...body, protected_detail: { schema_version: 1, payload_hmac: detail.payload_hmac } };
}

export { canonical as logIcebergCanonicalJson, digest as logIcebergContentDigest };

export async function buildLogIcebergRecord(
  config: LogIcebergConfig,
  input: LogIcebergRecordInput,
  encryption: LogIcebergRecordKeys
): Promise<LogArchiveRecord> {
  if (
    !Number.isSafeInteger(encryption.keyVersion) ||
    encryption.keyVersion < 1 ||
    encryption.keyVersion > 999_999_999 ||
    !Number.isSafeInteger(input.ingestedAt) ||
    input.ingestedAt < config.activatedAt ||
    !/^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_]*$/.test(input.sourceDataset)
  )
    invalid();
  for (const value of [input.eventId, input.tenantKey, input.sourceDataset, input.logType])
    if (typeof value !== 'string' || !value || value.length > 256) invalid();
  const overview = Object.fromEntries(
    OVERVIEW_FIELDS.map((key) => {
      const value = input.overview?.[key] ?? null;
      if (value !== null && (typeof value !== 'string' || value.length > 512)) invalid();
      return [key, value];
    })
  ) as LogIcebergOverview;
  if (
    input.overview &&
    Object.keys(input.overview).some(
      (key) => !OVERVIEW_FIELDS.includes(key as keyof LogIcebergOverview)
    )
  )
    invalid();
  const body = canonical(input.body);
  if (encoder.encode(body).byteLength > LOG_ICEBERG_MAX_BODY_BYTES)
    throw new Error('log_iceberg_record_too_large');
  const header = {
    schema_version: config.schemaVersion,
    storage_generation: config.generation,
    event_id: input.eventId,
    tenant_key: input.tenantKey,
    source_dataset: input.sourceDataset,
    log_type: input.logType,
    event_at: input.eventAt,
    ingested_at: input.ingestedAt,
    expires_at: input.expiresAt,
    ...overview,
    detail_key_version: String(encryption.keyVersion),
  };
  const authenticated = {
    ...header,
    payload_hmac: await digest(
      canonical(contentBody(input.body)),
      encryption.contentHmacKeyHex,
      identity(header)
    ),
  };
  const envelope = await encryptObjectArtifact(body, {
    rootKeyHex: encryption.rootKeyHex,
    keyVersion: encryption.keyVersion,
    plane: 'AUDIT_ARCHIVE',
    contentType: 'application/authrim.iceberg-log+json',
    context: cryptoContext(authenticated),
  });
  const record = { ...authenticated, detail_ciphertext: JSON.stringify(envelope) };
  assertLogArchiveRecord(record);
  return record;
}

/** The caller authorizes tenant/dataset access before resolving key material or calling this. */
export async function decryptLogIcebergRecord(
  record: LogArchiveRecord,
  expected: { tenantKey: string; sourceDataset: string; eventId?: string },
  resolveKeys: (
    keyVersion: number
  ) => Promise<Pick<LogIcebergRecordKeys, 'rootKeyHex' | 'contentHmacKeyHex'>>
): Promise<Record<string, unknown>> {
  assertLogArchiveRecord(record);
  if (
    record.tenant_key !== expected.tenantKey ||
    record.source_dataset !== expected.sourceDataset ||
    (expected.eventId !== undefined && record.event_id !== expected.eventId) ||
    record.detail_ciphertext.length > LOG_ICEBERG_MAX_BODY_BYTES * 1.5 + 4096 ||
    !/^[1-9][0-9]{0,8}$/.test(record.detail_key_version) ||
    !/^[a-f0-9]{64}$/.test(record.payload_hmac)
  )
    invalid();
  const envelope = JSON.parse(record.detail_ciphertext) as EncryptedObjectArtifactEnvelope;
  const keyVersion = Number(record.detail_key_version);
  if (
    envelope.version !== 1 ||
    envelope.algorithm !== 'AES-256-GCM' ||
    envelope.plane !== 'AUDIT_ARCHIVE' ||
    envelope.objectClass !== 'event_log_detail' ||
    envelope.contentType !== 'application/authrim.iceberg-log+json' ||
    envelope.keyVersion !== keyVersion
  )
    invalid();
  const { rootKeyHex, contentHmacKeyHex } = await resolveKeys(keyVersion);
  const { detail_ciphertext: _ciphertext, ...authenticated } = record;
  const plaintext = await decryptObjectArtifact(envelope, {
    rootKeyHex,
    context: cryptoContext(authenticated),
  });
  if (encoder.encode(plaintext).byteLength > LOG_ICEBERG_MAX_BODY_BYTES) invalid();
  const body: unknown = JSON.parse(plaintext);
  if (!body || typeof body !== 'object' || Array.isArray(body) || canonical(body) !== plaintext)
    invalid();
  const { payload_hmac: _hmac, ...header } = authenticated;
  const computed = await digest(
    canonical(contentBody(body as Record<string, unknown>)),
    contentHmacKeyHex,
    identity(header)
  );
  // Both strings are fixed-size digests; compare every byte.
  let difference = 0;
  for (let i = 0; i < computed.length; i++)
    difference |= computed.charCodeAt(i) ^ record.payload_hmac.charCodeAt(i);
  if (difference !== 0) invalid();
  return body as Record<string, unknown>;
}
