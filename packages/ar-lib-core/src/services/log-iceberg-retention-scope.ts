import type { PreparedStatement } from '../db/adapter';
import type { LogIcebergConfig, LogIcebergRemoteConfig } from './log-iceberg-config';
import { logIcebergDigest, logIcebergGuard, type LogIcebergSqlGuard } from './log-iceberg-store';
import { LOG_ICEBERG_DB_NOW } from './log-iceberg-lease';
export interface LogIcebergRetentionScope {
  tenantId: string;
  tenantKey: string;
  sourceDataset: string;
}
export function logIcebergRetentionScopeId(
  config: Pick<LogIcebergRemoteConfig, 'tableUuid' | 'generation'>,
  scope: Pick<LogIcebergRetentionScope, 'tenantKey' | 'sourceDataset'>
): Promise<string> {
  return logIcebergDigest(
    JSON.stringify([
      'retention',
      config.tableUuid,
      config.generation,
      scope.tenantKey,
      scope.sourceDataset,
    ])
  );
}
/** Add to the same source/business batch and guard as the first log write.
 * One metadata row per scope avoids scanning the growing log receipt history. */
export async function prepareLogIcebergRetentionScope(
  config: LogIcebergConfig,
  scope: LogIcebergRetentionScope,
  guard?: LogIcebergSqlGuard
): Promise<PreparedStatement[]> {
  if (
    !scope.tenantId ||
    scope.tenantId.length > 256 ||
    !scope.tenantKey ||
    scope.tenantKey.length > 256 ||
    scope.sourceDataset.length > 256 ||
    !/^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_]*$/.test(scope.sourceDataset)
  )
    throw new Error('log_iceberg_retention_scope_invalid');
  if (config.localStagingOnly) return [];
  const id = await logIcebergRetentionScopeId(config, scope),
    condition = logIcebergGuard(guard);
  return [
    {
      sql: `INSERT INTO log_iceberg_retention_jobs(id,table_uuid,storage_generation,tenant_id,tenant_key,source_dataset,cutoff,state,created_at,updated_at) SELECT ?,?,?,?,?,?,0,'completed',${LOG_ICEBERG_DB_NOW},${LOG_ICEBERG_DB_NOW} WHERE 1=1${condition.sql} ON CONFLICT(id) DO NOTHING`,
      params: [
        id,
        config.tableUuid,
        config.generation,
        scope.tenantId,
        scope.tenantKey,
        scope.sourceDataset,
        ...condition.params,
      ],
    },
  ];
}
