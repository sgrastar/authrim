import type { TenantPortableDataset } from './module-contract';
import type { PortableSqliteRow, SqliteDatasetInspectionPolicy } from './sqlite-dataset-inspector';
import type { CaptureSchema } from './sqlite-snapshot';
import {
  normalizeKeyManagerTenantBackupSnapshot,
  type KeyManagerTenantBackupSnapshot,
} from './key-manager-portability';

export const KEY_MANAGER_TENANT_BACKUP_DATASET: TenantPortableDataset = {
  id: 'credentials.key_manager_tenant_state',
  module: 'credentials',
  kind: 'settings',
  store: 'durable_object',
  schemaVersion: 1,
  disposition: 'include',
};

export const KEY_MANAGER_TENANT_BACKUP_SCHEMA: CaptureSchema = {
  table: 'key_manager_tenant_backup_state',
  tenantColumn: 'tenant_id',
  columns: ['tenant_id', 'snapshot_json'],
  primaryKey: ['tenant_id'],
  uniqueKeys: [],
};

function invalid(): never {
  throw new Error('backup_key_manager_dataset_invalid');
}

function field(row: PortableSqliteRow, name: string): string {
  const value = row[name];
  if (!value || value[0] !== 'text' || value[1] === null) invalid();
  return value[1];
}

function parseRow(value: string): PortableSqliteRow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return invalid();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
  const row = parsed as PortableSqliteRow;
  if (Object.keys(row).sort().join(',') !== 'snapshot_json,tenant_id') invalid();
  return row;
}

export async function decodeKeyManagerTenantBackupRow(
  rowJson: string,
  expectedTenantId: string
): Promise<KeyManagerTenantBackupSnapshot> {
  const row = parseRow(rowJson);
  if (field(row, 'tenant_id') !== expectedTenantId) invalid();
  try {
    return await normalizeKeyManagerTenantBackupSnapshot(JSON.parse(field(row, 'snapshot_json')));
  } catch {
    return invalid();
  }
}

export async function encodeKeyManagerTenantBackupRow(
  tenantId: string,
  snapshot: KeyManagerTenantBackupSnapshot
): Promise<Uint8Array> {
  if (!tenantId || new TextEncoder().encode(tenantId).length > 256) invalid();
  const normalized = await normalizeKeyManagerTenantBackupSnapshot(snapshot);
  const row: PortableSqliteRow = {
    tenant_id: ['text', tenantId],
    snapshot_json: ['text', JSON.stringify(normalized)],
  };
  return new TextEncoder().encode(`${JSON.stringify(row)}\n`);
}

export function createKeyManagerTenantBackupInspectionPolicy(): SqliteDatasetInspectionPolicy {
  return {
    dataset: structuredClone(KEY_MANAGER_TENANT_BACKUP_DATASET),
    schema: structuredClone(KEY_MANAGER_TENANT_BACKUP_SCHEMA),
    async inspectRow(row) {
      const tenantId = field(row, 'tenant_id');
      await decodeKeyManagerTenantBackupRow(JSON.stringify(row), tenantId);
      return [];
    },
  };
}
