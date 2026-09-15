import type { MigrationSchemaFamily } from '../control-plane/migration-stream-contract.js';
import type { BackupRowOwnership } from './row-ownership.js';

const byTenantId: BackupRowOwnership = {
  kind: 'tenant',
  column: 'tenant_id',
  identity: 'tenantId',
};
const byTenantKey: BackupRowOwnership = {
  kind: 'tenant',
  column: 'tenant_key',
  identity: 'tenantKey',
};
const tenantScope: BackupRowOwnership = {
  kind: 'scope',
  typeColumn: 'scope_type',
  idColumn: 'scope_id',
};

function parent(
  table: string,
  child: string,
  parentColumn: string,
  ownership: BackupRowOwnership = byTenantId
): BackupRowOwnership {
  return { kind: 'parent', table, keys: [{ child, parent: parentColumn }], ownership };
}

/**
 * Reviewed row selectors for indirect/scoped ownership. This registry is intentionally
 * incomplete; an absent entry is unresolved, never permission to export every row.
 * Platform-scoped defaults require separate dependency handling, not a broader selector.
 */
export const TENANT_BACKUP_OWNERSHIP_RULES: ReadonlyArray<{
  family: MigrationSchemaFamily;
  table: string;
  ownership: BackupRowOwnership;
}> = [
  ...[
    'admin_destination_capabilities',
    'admin_destination_health_events',
    'admin_logging_critical_policies',
    'admin_logging_sensitive_detail_policies',
    'credential_secret_metadata',
    'credential_secret_bodies',
  ].map((table) => ({
    family: 'admin' as const,
    table,
    ownership: parent('admin_destinations', 'destination_id', 'id', tenantScope),
  })),
  ...['logging_key_versions', 'logging_rewrap_jobs'].map((table) => ({
    family: 'admin' as const,
    table,
    ownership: parent('logging_key_registry', 'key_registry_id', 'id', byTenantKey),
  })),
  {
    family: 'core',
    table: 'tenants',
    ownership: { kind: 'tenant', column: 'id', identity: 'tenantId' },
  },
  ...(['core', 'admin'] as const).flatMap((family) => [
    {
      family,
      table: 'object_catalog_objects',
      ownership: parent('object_catalog', 'catalog_id', 'id'),
    },
    {
      family,
      table: 'internal_notification_delivery_attempts',
      ownership: parent('internal_notification_events', 'event_id', 'id'),
    },
    ...['internal_notification_delivery_routes', 'logging_quota_policies'].map((table) => ({
      family,
      table,
      ownership: tenantScope,
    })),
    ...[
      'log_chunk_manifests',
      'log_chunk_record_index',
      'log_object_catalog',
      'logging_catalog_repair_jobs',
    ].map((table) => ({
      family,
      table,
      ownership: byTenantKey,
    })),
  ]),
  ...['identity_identifier_replacement_history', 'identity_identifier_replacement_projections'].map(
    (table) => ({
      family: 'pii' as const,
      table,
      ownership: parent(
        'identity_identifier_replacement_operations',
        'operation_id',
        'operation_id'
      ),
    })
  ),
  ...[
    'admin_destinations',
    'admin_storage_destinations',
    'logging_fallback_policies',
    'logging_policy_snapshots',
  ].map((table) => ({
    family: 'admin' as const,
    table,
    ownership: tenantScope,
  })),
  ...[
    'logging_delivery_event_aggregates',
    'logging_delivery_events',
    'logging_dlq_items',
    'logging_export_jobs',
    'logging_key_material_bodies',
    'logging_key_registry',
  ].map((table) => ({
    family: 'admin' as const,
    table,
    ownership: byTenantKey,
  })),
  // Parent joins verified against the owning repositories and migration foreign keys.
  ...[
    ['admin_passkeys', 'admin_users', 'admin_user_id'],
    ['agent_baseline_exceptions', 'agent_baseline_assignments', 'assignment_id'],
    ['agent_task_set_versions', 'agent_task_sets', 'task_set_id'],
    ['agent_scope_policy_versions', 'agent_scope_policies', 'scope_policy_id'],
    ['approval_request_approvals', 'approval_requests', 'approval_request_id'],
  ].map(([table, parentTable, childColumn]) => ({
    family: 'admin' as const,
    table,
    ownership: parent(parentTable, childColumn, 'id'),
  })),
  ...[
    ['agent_baselines', 'control_tenant_id'],
    ['agent_configuration_templates', 'source_tenant_id'],
    ['agent_template_copies', 'target_tenant_id'],
  ].map(([table, column]) => ({
    family: 'admin' as const,
    table,
    ownership: { kind: 'tenant' as const, column, identity: 'tenantId' as const },
  })),
  {
    family: 'admin',
    table: 'agent_configuration_plan_steps',
    ownership: {
      kind: 'parent',
      table: 'agent_configuration_plans',
      keys: [
        { child: 'plan_id', parent: 'id' },
        { child: 'plan_version', parent: 'version' },
      ],
      ownership: byTenantId,
    },
  },
];

export function requireBackupOwnership(
  family: MigrationSchemaFamily,
  table: string
): BackupRowOwnership {
  const matches = TENANT_BACKUP_OWNERSHIP_RULES.filter(
    (entry) => entry.family === family && entry.table === table
  );
  if (matches.length !== 1) throw new Error(`backup_ownership_unresolved:${family}:${table}`);
  return matches[0].ownership;
}
