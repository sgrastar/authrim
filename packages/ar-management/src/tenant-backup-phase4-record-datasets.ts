import type { TenantPortableDataset } from '@authrim/ar-lib-core/services/tenant-portability/module-contract';
import type {
  PortableSqliteRow,
  SqliteDatasetInspectionPolicy,
} from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import type { CaptureSchema } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-snapshot';

export const SAML_LOCAL_SIGNING_DATASET: TenantPortableDataset = {
  id: 'federation.saml_local_signing_state',
  module: 'federation',
  kind: 'settings',
  store: 'durable_object',
  schemaVersion: 1,
  disposition: 'include',
};

export const DIRECTORY_CONNECTOR_SECRETS_DATASET: TenantPortableDataset = {
  id: 'integrations.directory_connector_secrets',
  module: 'integrations',
  kind: 'settings',
  store: 'kv',
  schemaVersion: 1,
  disposition: 'include',
};

const SAML_SCHEMA: CaptureSchema = {
  table: 'saml_local_signing_backup_state',
  tenantColumn: 'tenant_id',
  columns: ['tenant_id', 'bundle_json'],
  primaryKey: ['tenant_id'],
  uniqueKeys: [],
};

const DIRECTORY_SCHEMA: CaptureSchema = {
  table: 'directory_connector_secret_backup_state',
  tenantColumn: 'tenant_id',
  columns: ['tenant_id', 'connector_id', 'secret_json'],
  primaryKey: ['tenant_id', 'connector_id'],
  uniqueKeys: [],
};

export interface DirectoryConnectorSecretBackupRecord {
  active: { keyId: string; secret: string; createdAt: string };
  previous?: { keyId: string; secret: string; createdAt: string; retireAfter: string };
}

function invalid(): never {
  throw new Error('backup_phase4_record_dataset_invalid');
}

function text(row: PortableSqliteRow, key: string, maxBytes: number): string {
  const value = row[key];
  if (
    !value ||
    value[0] !== 'text' ||
    value[1] === null ||
    new TextEncoder().encode(value[1]).length > maxBytes
  )
    invalid();
  return value[1];
}

function parseRow(rowJson: string, columns: readonly string[]): PortableSqliteRow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rowJson) as unknown;
  } catch {
    return invalid();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
  if (Object.keys(parsed).sort().join(',') !== [...columns].sort().join(',')) invalid();
  return parsed as PortableSqliteRow;
}

function boundedString(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value || new TextEncoder().encode(value).length > max)
    invalid();
  return value;
}

function instant(value: unknown): string {
  const result = boundedString(value, 64);
  if (!Number.isFinite(Date.parse(result))) invalid();
  return result;
}

function secretVersion(value: unknown, previous: boolean) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  const expected = previous ? 'createdAt,keyId,retireAfter,secret' : 'createdAt,keyId,secret';
  if (Object.keys(record).sort().join(',') !== expected) invalid();
  return {
    keyId: boundedString(record.keyId, 256),
    secret: boundedString(record.secret, 4096),
    createdAt: instant(record.createdAt),
    ...(previous ? { retireAfter: instant(record.retireAfter) } : {}),
  };
}

export function normalizeDirectoryConnectorSecretBackupRecord(
  value: unknown
): DirectoryConnectorSecretBackupRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !['active', 'previous'].includes(key)) ||
    !Object.hasOwn(record, 'active')
  )
    invalid();
  const active = secretVersion(
    record.active,
    false
  ) as DirectoryConnectorSecretBackupRecord['active'];
  const previous =
    record.previous === undefined
      ? undefined
      : (secretVersion(record.previous, true) as NonNullable<
          DirectoryConnectorSecretBackupRecord['previous']
        >);
  if (
    previous?.keyId === active.keyId ||
    (previous && Date.parse(previous.retireAfter) < Date.parse(previous.createdAt))
  )
    invalid();
  return { active, ...(previous ? { previous } : {}) };
}

export function encodeSamlLocalSigningBackupRow(tenantId: string, bundle: unknown): Uint8Array {
  const bundleJson = JSON.stringify(bundle);
  if (!bundleJson || new TextEncoder().encode(bundleJson).length > 8 * 1024 * 1024) invalid();
  return encodeRow({ tenant_id: ['text', tenantId], bundle_json: ['text', bundleJson] });
}

export async function decodeSamlLocalSigningBackupRow(
  rowJson: string,
  tenantId: string,
  validate: (bundle: unknown, tenantId: string) => Promise<void>
): Promise<unknown> {
  const row = parseRow(rowJson, SAML_SCHEMA.columns);
  if (text(row, 'tenant_id', 256) !== tenantId) invalid();
  let bundle: unknown;
  try {
    bundle = JSON.parse(text(row, 'bundle_json', 8 * 1024 * 1024));
  } catch {
    return invalid();
  }
  await validate(bundle, tenantId);
  return bundle;
}

export function encodeDirectoryConnectorSecretBackupRow(
  tenantId: string,
  connectorId: string,
  secret: DirectoryConnectorSecretBackupRecord
): Uint8Array {
  const normalized = normalizeDirectoryConnectorSecretBackupRecord(secret);
  return encodeRow({
    tenant_id: ['text', boundedString(tenantId, 256)],
    connector_id: ['text', boundedString(connectorId, 128)],
    secret_json: ['text', JSON.stringify(normalized)],
  });
}

export function decodeDirectoryConnectorSecretBackupRow(rowJson: string, tenantId: string) {
  const row = parseRow(rowJson, DIRECTORY_SCHEMA.columns);
  if (text(row, 'tenant_id', 256) !== tenantId) invalid();
  const connectorId = text(row, 'connector_id', 128);
  let secret: unknown;
  try {
    secret = JSON.parse(text(row, 'secret_json', 16 * 1024));
  } catch {
    return invalid();
  }
  return { connectorId, secret: normalizeDirectoryConnectorSecretBackupRecord(secret) };
}

function encodeRow(row: PortableSqliteRow): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(row)}\n`);
}

export function createPhase4RecordDatasetPolicies(input: {
  validateSamlBundle(bundle: unknown, tenantId: string): Promise<void>;
}): SqliteDatasetInspectionPolicy[] {
  return [
    {
      dataset: structuredClone(SAML_LOCAL_SIGNING_DATASET),
      schema: structuredClone(SAML_SCHEMA),
      async inspectRow(row) {
        const tenantId = text(row, 'tenant_id', 256);
        await decodeSamlLocalSigningBackupRow(
          JSON.stringify(row),
          tenantId,
          input.validateSamlBundle
        );
        return [];
      },
    },
    {
      dataset: structuredClone(DIRECTORY_CONNECTOR_SECRETS_DATASET),
      schema: structuredClone(DIRECTORY_SCHEMA),
      async inspectRow(row) {
        decodeDirectoryConnectorSecretBackupRow(JSON.stringify(row), text(row, 'tenant_id', 256));
        return [];
      },
    },
  ];
}
