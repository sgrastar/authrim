import type { CaptureSchema } from './sqlite-snapshot.js';
import type { PortableSqliteRow } from './sqlite-dataset-inspector.js';

/**
 * Tenant keys are environment-local routing identities. Portable rows use one fixed marker and the
 * restore policy replaces it with the target environment's key before writing any SQL row.
 */
export const PORTABLE_TENANT_KEY = 'authrim-portable-tenant-v1';

/** Installed SQL datasets that carry the environment-local tenant key in their row payload. */
export const PORTABLE_TENANT_KEY_SQLITE_DATASETS = [
  'admin.log_chunk_manifests',
  'admin.log_chunk_record_index',
  'admin.log_object_catalog',
  'admin.logging_catalog_repair_jobs',
  'admin.logging_delivery_event_aggregates',
  'admin.logging_delivery_events',
  'admin.logging_dlq_items',
  'admin.logging_export_jobs',
  'admin.logging_key_material_bodies',
  'admin.logging_key_registry',
  'admin.logging_message_jobs',
  'admin.logging_quota_evaluations',
  'admin.logging_usage_aggregates',
  'core.log_chunk_manifests',
  'core.log_chunk_record_index',
  'core.log_object_catalog',
  'core.logging_catalog_repair_jobs',
  'core.logging_quota_evaluations',
  'core.logging_usage_aggregates',
  'core.tenants',
] as const;

function invalid(): never {
  throw new Error('backup_portable_tenant_key_invalid');
}

export function assertEnvironmentTenantKey(value: string): string {
  if (value === PORTABLE_TENANT_KEY || !/^[A-Za-z0-9_.:-]{1,256}$/u.test(value)) invalid();
  return value;
}

/** Return the environment-local tenant-key column carried by an installed capture schema. */
export function portableTenantKeyColumn(schema: CaptureSchema): string | undefined {
  if (!('parent' in schema) && schema.tenantIdentity === 'tenantKey') return schema.tenantColumn;
  return schema.columns.includes('tenant_key') ? 'tenant_key' : undefined;
}

export function assertPortableTenantKeyRow(
  schema: CaptureSchema,
  row: PortableSqliteRow,
  required: boolean
): void {
  const column = portableTenantKeyColumn(schema);
  if (!column) invalid();
  const value = row[column];
  if (!value) invalid();
  if (value[0] === 'null' && value[1] === null && !required) return;
  if (value[0] !== 'text' || value[1] !== PORTABLE_TENANT_KEY) invalid();
}

export function normalizePortableTenantKeyRow(
  schema: CaptureSchema,
  rowJson: string,
  sourceTenantKey: string,
  required: boolean
): string {
  const column = portableTenantKeyColumn(schema);
  if (!column) invalid();
  assertEnvironmentTenantKey(sourceTenantKey);
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(rowJson) as Record<string, unknown>;
  } catch {
    return invalid();
  }
  const value = row[column];
  if (Array.isArray(value) && value.length === 2 && value[0] === 'null' && value[1] === null) {
    if (required) invalid();
    return rowJson;
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value[0] !== 'text' ||
    value[1] !== sourceTenantKey
  )
    invalid();
  row[column] = ['text', PORTABLE_TENANT_KEY];
  return JSON.stringify(row);
}
