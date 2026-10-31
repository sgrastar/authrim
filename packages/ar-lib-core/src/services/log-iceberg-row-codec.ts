import type { LogArchiveRecord } from '@authrim/ar-lib-logging/iceberg/schema';
import {
  LOG_ICEBERG_ROW_BODY_SCHEMA,
  logIcebergCanonicalJson,
  logIcebergContentDigest,
  type LogIcebergRecordKeys,
} from './log-iceberg-record';
import {
  decryptObjectArtifact,
  encryptObjectArtifact,
  type EncryptedObjectArtifactEnvelope,
} from './object-artifact-crypto';
import { logIcebergDigest } from './log-iceberg-store';

export type LogIcebergSqlRow = Record<string, string | number | null>;
interface DetailContext {
  tenantKey: string;
  sourceDataset: string;
  eventId: string;
  generation: string;
  schemaVersion: number;
}
interface ProtectedDetail {
  schema_version: 1;
  payload_hmac: string;
  key_version: number;
  envelope: EncryptedObjectArtifactEnvelope;
}
const CLASSES = {
  'admin.admin_audit_log': 'admin_audit_detail',
  'core.operational_logs': 'operational_log_detail',
  'pii.pii_log': 'pii_log_values',
} as const;
// The previous Admin writer left only these actor/proxy fields in the normal
// row. Full arbitrary metadata remains behind ADMIN_AUDIT_DETAIL_READ.
const ADMIN_INLINE_METADATA_KEYS = new Set([
  'admin_actor_type',
  'admin_actor_id',
  'admin_auth_method',
  'admin_machine_principal_id',
  'admin_machine_principal_type',
  'admin_machine_credential_id',
  'admin_machine_client_id',
  'admin_machine_client_auth_method',
  'admin_machine_credential_strength',
  'admin_machine_sender_constrained',
  'admin_delegator_id',
  'admin_agent_client_id',
  'admin_agent_mode',
  'admin_agent_assurance',
  'admin_agent_grant_id',
  'admin_agent_grant_generation',
  'admin_agent_consent_version',
  'admin_agent_source_token_jti',
  'admin_agent_correlation_id',
  'admin_transport_actor_type',
  'admin_transport_actor_id',
  'admin_transport_principal_type',
  'admin_transport_credential_id',
  'admin_transport_client_id',
  'admin_transport_auth_method',
  'admin_transport_client_auth_method',
  'admin_ui_api_mode',
  'admin_ui_bff_forwarded_host',
  'admin_ui_bff_forwarded_proto',
  'admin_ui_bff_request_id',
  'admin_ui_bff_correlation_id',
]);
export function normalizeAdminInlineMetadata(
  input: Record<string, unknown>
): Record<string, string | number | boolean | null> {
  const projection: Record<string, string | number | boolean | null> = {};
  for (const [name, value] of Object.entries(input)) {
    if (!ADMIN_INLINE_METADATA_KEYS.has(name)) invalid();
    if (value === undefined) continue;
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'boolean' &&
      !(
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (!Number.isInteger(value) || Number.isSafeInteger(value))
      )
    )
      invalid();
    projection[name] = value;
  }
  return projection;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function invalid(): never {
  throw new Error('log_iceberg_row_body_invalid');
}
function detailClass(dataset: string) {
  if (!Object.hasOwn(CLASSES, dataset)) invalid();
  return CLASSES[dataset as keyof typeof CLASSES];
}
function detailIdentity(context: DetailContext) {
  return {
    domain: 'authrim.iceberg-protected-detail.v1',
    tenant_key: context.tenantKey,
    source_dataset: context.sourceDataset,
    event_id: context.eventId,
  };
}
function aad(context: DetailContext, digest: string, keyVersion: number) {
  return {
    tenantId: context.tenantKey,
    objectClass: detailClass(context.sourceDataset),
    objectKey: logIcebergCanonicalJson({
      ...detailIdentity(context),
      storage_generation: context.generation,
      schema_version: context.schemaVersion,
      detail_key_version: keyVersion,
      payload_hmac: digest,
    }),
  };
}
export async function logIcebergDetailReference(
  context: Pick<DetailContext, 'tenantKey' | 'sourceDataset' | 'eventId'>
): Promise<string> {
  return `ilgd_${await logIcebergDigest(JSON.stringify([context.tenantKey, context.sourceDataset, context.eventId]))}`;
}

/** Replace the old immediate-R2 detail split with a nested authenticated envelope.
 * General log readers may decrypt the row without obtaining before/after/reasons. */
export async function encodeLogIcebergRow(input: {
  context: DetailContext;
  row: LogIcebergSqlRow;
  keys: LogIcebergRecordKeys;
  protectedDetail?: Record<string, unknown>;
  /** Separate trusted actor/proxy projection; never derive this from arbitrary metadata. */
  adminInlineMetadata?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const row = { ...input.row };
  let detail = input.protectedDetail;
  if (
    input.context.sourceDataset === 'admin.admin_audit_log' &&
    ((row.before_json !== null && row.before_json !== undefined) ||
      (row.after_json !== null && row.after_json !== undefined) ||
      (row.metadata_json !== null && row.metadata_json !== undefined))
  ) {
    if (detail) invalid();
    detail = {
      before_json: row.before_json ?? null,
      after_json: row.after_json ?? null,
      metadata_json: row.metadata_json ?? null,
    };
    row.before_json = null;
    row.after_json = null;
    if (row.metadata_json !== null && row.metadata_json !== undefined) {
      if (typeof row.metadata_json !== 'string') invalid();
      const metadata: unknown = JSON.parse(row.metadata_json);
      if (!object(metadata)) invalid();
      row.metadata_json = null;
    }
  }
  if (input.adminInlineMetadata) {
    if (input.context.sourceDataset !== 'admin.admin_audit_log') invalid();
    row.metadata_json = JSON.stringify(normalizeAdminInlineMetadata(input.adminInlineMetadata));
  }
  if (!detail) return { format: LOG_ICEBERG_ROW_BODY_SCHEMA, row };
  const plaintext = logIcebergCanonicalJson(detail);
  if (new TextEncoder().encode(plaintext).byteLength > 2 * 1024 * 1024)
    throw new Error('log_iceberg_detail_too_large');
  const digest = await logIcebergContentDigest(
    plaintext,
    input.keys.contentHmacKeyHex,
    detailIdentity(input.context)
  );
  const envelope = await encryptObjectArtifact(plaintext, {
    rootKeyHex: input.keys.rootKeyHex,
    keyVersion: input.keys.keyVersion,
    plane: 'SENSITIVE_DETAILS',
    contentType: 'application/authrim.iceberg-log-detail+json',
    context: aad(input.context, digest, input.keys.keyVersion),
  });
  const ref = await logIcebergDetailReference(input.context);
  if (input.context.sourceDataset === 'pii.pii_log') {
    row.values_encrypted = null;
    row.values_r2_key = ref;
  } else row.detail_object_catalog_id = ref;
  if (input.context.sourceDataset === 'core.operational_logs') {
    row.reason_detail_encrypted = null;
    row.encryption_key_version = 0;
  }
  const protected_detail: ProtectedDetail = {
    schema_version: 1,
    payload_hmac: digest,
    key_version: input.keys.keyVersion,
    envelope,
  };
  return { format: LOG_ICEBERG_ROW_BODY_SCHEMA, row, protected_detail };
}

export function decodeLogIcebergRow(
  body: Record<string, unknown>,
  tenantId: string,
  eventId: string
): LogIcebergSqlRow {
  if (body.format !== LOG_ICEBERG_ROW_BODY_SCHEMA || !object(body.row)) invalid();
  const row: LogIcebergSqlRow = {};
  for (const [name, value] of Object.entries(body.row)) {
    if (
      !/^[a-z_][a-z0-9_]*$/.test(name) ||
      (value !== null &&
        typeof value !== 'string' &&
        !(
          typeof value === 'number' &&
          Number.isFinite(value) &&
          (!Number.isInteger(value) || Number.isSafeInteger(value))
        ))
    )
      invalid();
    row[name] = value;
  }
  if (row.tenant_id !== tenantId || row.id !== eventId) invalid();
  return row;
}

/** Call only after the endpoint's additional sensitive-detail permission check. */
export async function decryptProtectedLogIcebergDetail(input: {
  record: LogArchiveRecord;
  body: Record<string, unknown>;
  resolveKeys: (
    keyVersion: number
  ) => Promise<Pick<LogIcebergRecordKeys, 'rootKeyHex' | 'contentHmacKeyHex'>>;
}): Promise<Record<string, unknown> | null> {
  if (input.body.format !== LOG_ICEBERG_ROW_BODY_SCHEMA) invalid();
  if (input.body.protected_detail === undefined) return null;
  const value = input.body.protected_detail;
  if (
    !object(value) ||
    value.schema_version !== 1 ||
    typeof value.payload_hmac !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.payload_hmac) ||
    !Number.isSafeInteger(value.key_version) ||
    Number(value.key_version) < 1 ||
    Number(value.key_version) > 999_999_999 ||
    !object(value.envelope)
  )
    invalid();
  const context: DetailContext = {
    tenantKey: input.record.tenant_key,
    sourceDataset: input.record.source_dataset,
    eventId: input.record.event_id,
    generation: input.record.storage_generation,
    schemaVersion: input.record.schema_version,
  };
  const keyVersion = Number(value.key_version);
  const encoded = value.envelope;
  const objectClass = detailClass(context.sourceDataset);
  if (
    encoded.version !== 1 ||
    encoded.algorithm !== 'AES-256-GCM' ||
    encoded.plane !== 'SENSITIVE_DETAILS' ||
    encoded.objectClass !== objectClass ||
    encoded.keyVersion !== keyVersion ||
    encoded.contentType !== 'application/authrim.iceberg-log-detail+json' ||
    typeof encoded.iv !== 'string' ||
    !/^[A-Za-z0-9_-]{16}$/.test(encoded.iv) ||
    typeof encoded.ciphertext !== 'string' ||
    encoded.ciphertext.length > 3 * 1024 * 1024 ||
    !/^[A-Za-z0-9_-]+$/.test(encoded.ciphertext)
  )
    invalid();
  const envelope: EncryptedObjectArtifactEnvelope = {
    version: 1,
    algorithm: 'AES-256-GCM',
    plane: 'SENSITIVE_DETAILS',
    objectClass,
    keyVersion,
    contentType: encoded.contentType,
    iv: encoded.iv,
    ciphertext: encoded.ciphertext,
  };
  const keys = await input.resolveKeys(keyVersion);
  const plaintext = await decryptObjectArtifact(envelope, {
    rootKeyHex: keys.rootKeyHex,
    context: aad(context, value.payload_hmac, keyVersion),
  });
  if (new TextEncoder().encode(plaintext).byteLength > 2 * 1024 * 1024) invalid();
  const detail: unknown = JSON.parse(plaintext);
  if (!object(detail) || logIcebergCanonicalJson(detail) !== plaintext) invalid();
  const expected = await logIcebergContentDigest(
    plaintext,
    keys.contentHmacKeyHex,
    detailIdentity(context)
  );
  let difference = 0;
  for (let i = 0; i < expected.length; i++)
    difference |= expected.charCodeAt(i) ^ value.payload_hmac.charCodeAt(i);
  if (difference !== 0) invalid();
  return detail;
}
