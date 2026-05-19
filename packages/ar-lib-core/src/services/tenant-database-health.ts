import { ensureDatabaseAdapter } from '../db/adapter-source';
import type { HealthStatus } from '../db/adapter';
import type { ResolvedTenantStore } from './tenant-database-resolver';

export const DEFAULT_TENANT_DATABASE_LIGHT_HEALTH_INTERVAL_SECONDS = 300;

export type TenantDatabaseHealthSeverity = 'healthy' | 'degraded' | 'failed';
export type TenantDatabaseSchemaDriftState =
  | 'none'
  | 'behind_registry'
  | 'ahead_of_registry'
  | 'unknown';

export interface TenantDatabaseHealthCheckResult {
  tenantId: string;
  role: ResolvedTenantStore['role'];
  generation: number;
  shardGroup: string;
  shardIndex: number;
  bindingRef: string;
  severity: TenantDatabaseHealthSeverity;
  latencyMs: number;
  checkedAt: string;
  error?: string;
  sourceHealth: HealthStatus;
}

export interface TenantDatabaseDeepHealthCheckResult extends TenantDatabaseHealthCheckResult {
  registrySchemaVersion: number;
  databaseSchemaVersion: number | null;
  schemaDrift: TenantDatabaseSchemaDriftState;
}

function parseMigrationVersion(filename: string): number | null {
  const match = filename.match(/^(\d+)_/u);
  return match ? Number.parseInt(match[1], 10) : null;
}

export async function readTenantDatabaseAppliedSchemaVersion(
  source: ResolvedTenantStore['source']
): Promise<number> {
  const adapter = ensureDatabaseAdapter(source, 'tenant-schema-version');
  const rows = await adapter.query<{ filename: string }>('SELECT filename FROM authrim_migrations');
  return rows.reduce((maxVersion, row) => {
    const version = parseMigrationVersion(row.filename);
    return version === null ? maxVersion : Math.max(maxVersion, version);
  }, 0);
}

export async function checkResolvedTenantDatabaseHealth(
  store: ResolvedTenantStore,
  checkedAt = new Date().toISOString()
): Promise<TenantDatabaseHealthCheckResult> {
  const adapter = ensureDatabaseAdapter(store.source, `tenant-${store.role}`);
  const sourceHealth = await adapter.isHealthy();
  const severity: TenantDatabaseHealthSeverity = sourceHealth.healthy
    ? store.healthStatus === 'active'
      ? 'healthy'
      : 'degraded'
    : 'failed';

  return {
    tenantId: store.tenantId,
    role: store.role,
    generation: store.generation,
    shardGroup: store.shardGroup,
    shardIndex: store.shardIndex,
    bindingRef: store.bindingRef,
    severity,
    latencyMs: sourceHealth.latencyMs,
    checkedAt,
    error: sourceHealth.error,
    sourceHealth,
  };
}

export async function checkResolvedTenantDatabaseDeepHealth(
  store: ResolvedTenantStore,
  checkedAt = new Date().toISOString()
): Promise<TenantDatabaseDeepHealthCheckResult> {
  const light = await checkResolvedTenantDatabaseHealth(store, checkedAt);
  const base = {
    ...light,
    registrySchemaVersion: store.schemaVersion,
    databaseSchemaVersion: null,
    schemaDrift: 'unknown' as TenantDatabaseSchemaDriftState,
  };

  if (!light.sourceHealth.healthy) {
    return base;
  }

  try {
    const databaseSchemaVersion = await readTenantDatabaseAppliedSchemaVersion(store.source);
    if (databaseSchemaVersion < store.schemaVersion) {
      return {
        ...base,
        severity: 'failed',
        databaseSchemaVersion,
        schemaDrift: 'behind_registry',
        error: `tenant_database_schema_version_too_old:${databaseSchemaVersion}<${store.schemaVersion}`,
      };
    }
    if (databaseSchemaVersion > store.schemaVersion) {
      return {
        ...base,
        severity: light.severity === 'failed' ? 'failed' : 'degraded',
        databaseSchemaVersion,
        schemaDrift: 'ahead_of_registry',
        error: `tenant_database_schema_version_ahead:${databaseSchemaVersion}>${store.schemaVersion}`,
      };
    }

    return {
      ...base,
      databaseSchemaVersion,
      schemaDrift: 'none',
    };
  } catch (error) {
    return {
      ...base,
      severity: 'failed',
      error: `tenant_database_schema_version_unreadable:${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
