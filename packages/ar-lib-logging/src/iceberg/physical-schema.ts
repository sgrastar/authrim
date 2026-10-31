import { LOG_ARCHIVE_FIELDS } from './schema.js';
import type { LogArchiveMode } from './capabilities.js';
import type { IcebergTableMetadata } from './types.js';

export const LOG_ARCHIVE_PROVIDER_INGEST_TS = '__ingest_ts';
export type LogArchiveFieldName = (typeof LOG_ARCHIVE_FIELDS)[number]['name'];
export interface LogArchivePhysicalProfile {
  mode: LogArchiveMode;
  metadata: IcebergTableMetadata;
  schema: IcebergTableMetadata['schemas'][number];
  spec: IcebergTableMetadata['partition-specs'][number];
  fieldIds: Readonly<Record<LogArchiveFieldName, number>>;
  providerField?: IcebergTableMetadata['schemas'][number]['fields'][number];
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireTable(value: unknown): asserts value is IcebergTableMetadata {
  if (
    !object(value) ||
    value['format-version'] !== 2 ||
    typeof value['table-uuid'] !== 'string' ||
    typeof value.location !== 'string' ||
    !Array.isArray(value.schemas) ||
    !Array.isArray(value['partition-specs']) ||
    !Array.isArray(value['sort-orders']) ||
    !Number.isSafeInteger(value['last-sequence-number']) ||
    !Number.isSafeInteger(value['current-schema-id']) ||
    !Number.isSafeInteger(value['default-spec-id'])
  ) {
    throw new Error('Unsupported archive Iceberg table');
  }
}

/** Only the two new storage profiles are supported. Physical field identities
 * in a provider-created table are matched by name/type, never renumbered. */
export function inspectLogArchiveTable(
  value: unknown,
  expectedMode?: LogArchiveMode
): LogArchivePhysicalProfile {
  requireTable(value);
  const schema = value.schemas.find(
    (item) => object(item) && item['schema-id'] === value['current-schema-id']
  );
  const spec = value['partition-specs'].find(
    (item) => object(item) && item['spec-id'] === value['default-spec-id']
  );
  if (
    !schema ||
    schema.type !== 'struct' ||
    !Array.isArray(schema.fields) ||
    !spec ||
    !Array.isArray(spec.fields)
  )
    throw new Error('Missing archive physical schema or spec');
  const fields = new Map<string, IcebergTableMetadata['schemas'][number]['fields'][number]>();
  const ids = new Set<number>();
  for (const field of schema.fields) {
    if (
      !object(field) ||
      typeof field.name !== 'string' ||
      typeof field.id !== 'number' ||
      !Number.isSafeInteger(field.id) ||
      field.id < 1 ||
      typeof field.required !== 'boolean' ||
      fields.has(field.name) ||
      ids.has(field.id)
    )
      throw new Error('Invalid archive physical field identity');
    fields.set(field.name, field);
    ids.add(field.id);
  }
  const provider = fields.get(LOG_ARCHIVE_PROVIDER_INGEST_TS);
  const mode: LogArchiveMode = provider ? 'pipeline' : 'scheduled';
  if (expectedMode && mode !== expectedMode) throw new Error('Archive physical mode mismatch');
  if (fields.size !== LOG_ARCHIVE_FIELDS.length + (provider ? 1 : 0))
    throw new Error('Unexpected archive physical columns');
  const fieldIds: Partial<Record<LogArchiveFieldName, number>> = {};
  for (const expected of LOG_ARCHIVE_FIELDS) {
    const actual = fields.get(expected.name);
    if (
      !actual ||
      actual.type !== expected.type ||
      (mode === 'scheduled' && (actual.id !== expected.id || actual.required !== expected.required))
    ) {
      throw new Error('Archive Iceberg field identity mismatch');
    }
    // Provider nullability is a storage detail. Required logical values are
    // independently enforced before send/write and after every physical read.
    fieldIds[expected.name] = actual.id;
  }
  if (provider && provider.type !== 'timestamp' && provider.type !== 'timestamptz')
    throw new Error('Unsupported provider ingest timestamp type');
  const providerId = provider?.id;
  for (const candidate of value['partition-specs'] as unknown[]) {
    if (
      !object(candidate) ||
      !Number.isSafeInteger(candidate['spec-id']) ||
      !Array.isArray(candidate.fields)
    )
      throw new Error('Invalid archive partition spec');
    if (mode === 'scheduled') {
      if (candidate.fields.length !== 0)
        throw new Error('Scheduled archive requires unpartitioned storage');
    } else {
      if (candidate.fields.length === 0 && candidate['spec-id'] !== spec['spec-id']) continue;
      const field: unknown = candidate.fields[0];
      if (
        candidate.fields.length !== 1 ||
        !object(field) ||
        field['source-id'] !== providerId ||
        field.transform !== 'day' ||
        typeof field.name !== 'string' ||
        field.name.length < 1 ||
        field.name.length > 128 ||
        !Number.isSafeInteger(field['field-id'])
      ) {
        throw new Error('Pipeline archive requires provider ingest DAY partition');
      }
    }
  }
  return {
    mode,
    metadata: value,
    schema,
    spec,
    fieldIds: fieldIds as Record<LogArchiveFieldName, number>,
    ...(provider ? { providerField: provider } : {}),
  };
}

/** Persist alongside table UUID at activation; verify before every later use. */
export async function logArchivePhysicalFingerprint(value: unknown): Promise<string> {
  const profile = inspectLogArchiveTable(value);
  const metadata = profile.metadata;
  const normalized = {
    mode: profile.mode,
    formatVersion: metadata['format-version'],
    schemaId: metadata['current-schema-id'],
    schemas: [...metadata.schemas]
      .sort((a, b) => a['schema-id'] - b['schema-id'])
      .map((schema) => ({
        id: schema['schema-id'],
        identifierIds: [...(schema['identifier-field-ids'] ?? [])].sort((a, b) => a - b),
        fields: schema.fields.map(({ id, name, type, required }) => ({ id, name, type, required })),
      })),
    defaultSpecId: metadata['default-spec-id'],
    specs: [...metadata['partition-specs']]
      .sort((a, b) => a['spec-id'] - b['spec-id'])
      .map((spec) => ({
        id: spec['spec-id'],
        fields: spec.fields.map((field) => ({
          id: field['field-id'],
          sourceId: field['source-id'],
          name: field.name,
          transform: field.transform,
        })),
      })),
    defaultSortOrderId: metadata['default-sort-order-id'],
    sortOrders: [...metadata['sort-orders']]
      .sort((a, b) => a['order-id'] - b['order-id'])
      .map((order) => ({
        id: order['order-id'],
        fields: order.fields.map((field) => ({
          sourceId: field['source-id'],
          transform: field.transform,
          direction: field.direction,
          nullOrder: field['null-order'],
        })),
      })),
  };
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(normalized))
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function assertLogArchivePhysicalFingerprint(
  value: unknown,
  expected: string
): Promise<LogArchivePhysicalProfile> {
  if (!/^[a-f0-9]{64}$/.test(expected) || (await logArchivePhysicalFingerprint(value)) !== expected)
    throw new Error('Archive physical schema fingerprint mismatch');
  return inspectLogArchiveTable(value);
}

export function assertLogArchiveTableLocations(
  table: { metadata: IcebergTableMetadata; metadataLocation: string },
  bucketName: string
): void {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucketName))
    throw new Error('Invalid archive bucket identity');
  const canonical = (input: string): URL => {
    const url = new URL(input);
    if (
      url.protocol !== 's3:' ||
      url.hostname !== bucketName ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname.length < 2 ||
      url.pathname.includes('%') ||
      url.pathname.split('/').some((part) => part === '..' || part === '.')
    )
      throw new Error('Archive catalog location is outside the configured R2 bucket');
    return url;
  };
  const location = canonical(table.metadata.location);
  const metadata = canonical(table.metadataLocation);
  const prefix = location.pathname.replace(/\/$/, '') + '/metadata/';
  if (!metadata.pathname.startsWith(prefix) || metadata.pathname.length === prefix.length)
    throw new Error('Archive metadata location is outside its table');
}
