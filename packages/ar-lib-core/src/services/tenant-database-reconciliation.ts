import { isDatabaseSource } from '../db';
import type { TenantDatabaseRegistryRow } from '../repositories/admin/tenant-database-registry';

export type TenantDatabaseReconciliationFindingType =
  | 'missing_binding'
  | 'database_id_not_found'
  | 'inactive_registry_row';

export interface TenantDatabaseDerivedBindingManifestEntry {
  tenantId: string;
  role: TenantDatabaseRegistryRow['role'];
  generation: number;
  shardGroup: string;
  shardIndex: number;
  bindingRef: string | null;
  databaseId: string | null;
  databaseName: string | null;
  workerShard: string | null;
  deploymentTarget: string | null;
  derivedFrom: 'tenant_database_registry';
}

export interface TenantDatabaseReconciliationFinding {
  type: TenantDatabaseReconciliationFindingType;
  severity: 'warning' | 'critical';
  entry: TenantDatabaseDerivedBindingManifestEntry;
}

export interface TenantDatabaseReconciliationResult {
  checked: number;
  findings: TenantDatabaseReconciliationFinding[];
}

function toManifestEntry(
  row: TenantDatabaseRegistryRow
): TenantDatabaseDerivedBindingManifestEntry {
  return {
    tenantId: row.tenant_id,
    role: row.role,
    generation: row.generation,
    shardGroup: row.shard_group,
    shardIndex: row.shard_index,
    bindingRef: row.binding_ref,
    databaseId: row.database_id,
    databaseName: row.database_name,
    workerShard: row.worker_shard,
    deploymentTarget: row.deployment_target,
    derivedFrom: 'tenant_database_registry',
  };
}

export function createTenantDatabaseDerivedBindingManifest(
  rows: TenantDatabaseRegistryRow[]
): TenantDatabaseDerivedBindingManifestEntry[] {
  return rows.map(toManifestEntry).sort((left, right) => {
    const tenantCompare = left.tenantId.localeCompare(right.tenantId);
    if (tenantCompare !== 0) return tenantCompare;
    const roleCompare = left.role.localeCompare(right.role);
    if (roleCompare !== 0) return roleCompare;
    return left.shardIndex - right.shardIndex;
  });
}

export function reconcileTenantDatabaseDerivedBindings(options: {
  env: Record<string, unknown>;
  rows: TenantDatabaseRegistryRow[];
  cloudflareDatabaseIds?: Set<string>;
}): TenantDatabaseReconciliationResult {
  const findings: TenantDatabaseReconciliationFinding[] = [];
  for (const row of options.rows) {
    const entry = toManifestEntry(row);
    if (!['ready', 'active', 'degraded', 'degraded_pending_snapshot'].includes(row.status)) {
      findings.push({ type: 'inactive_registry_row', severity: 'warning', entry });
      continue;
    }
    if (!row.binding_ref || !isDatabaseSource(options.env[row.binding_ref])) {
      findings.push({ type: 'missing_binding', severity: 'critical', entry });
    }
    if (
      options.cloudflareDatabaseIds &&
      row.database_id &&
      !options.cloudflareDatabaseIds.has(row.database_id)
    ) {
      findings.push({ type: 'database_id_not_found', severity: 'critical', entry });
    }
  }
  return {
    checked: options.rows.length,
    findings,
  };
}
