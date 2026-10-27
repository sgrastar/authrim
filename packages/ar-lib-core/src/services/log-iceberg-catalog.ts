import {
  IcebergRestCatalog,
  R2IcebergObjectStore,
  assertLogArchivePhysicalFingerprint,
  assertLogArchiveTableLocations,
  inspectLogArchiveTable,
  type IcebergLoadedTable,
} from '@authrim/ar-lib-logging/iceberg';
import { assertLogIcebergRemoteConfig, type LogIcebergConfig } from './log-iceberg-config';
import type { LogIcebergRuntimeEnv } from './log-iceberg-runtime';

export interface LogIcebergCatalogEnv extends LogIcebergRuntimeEnv {
  LOG_ARCHIVE_CATALOG_READ_TOKEN?: string;
  LOG_ARCHIVE_CATALOG_WRITE_TOKEN?: string;
}

/** Secrets stay in the server; a fresh REST load is required for each source-delete boundary. */
export function createLogIcebergCatalog(
  env: LogIcebergCatalogEnv,
  config: LogIcebergConfig,
  access: 'read' | 'write' = 'read'
): IcebergRestCatalog {
  assertLogIcebergRemoteConfig(config);
  const token =
    access === 'write' ? env.LOG_ARCHIVE_CATALOG_WRITE_TOKEN : env.LOG_ARCHIVE_CATALOG_READ_TOKEN;
  if (!token) throw new Error('log_iceberg_catalog_credentials_unavailable');
  return new IcebergRestCatalog({
    uri: config.catalogUri,
    warehouse: config.warehouse,
    namespace: [config.namespace],
    table: config.table,
    bucketName: config.bucket,
    token,
  });
}

export async function validateLogIcebergTable(
  config: LogIcebergConfig,
  table: IcebergLoadedTable
): Promise<void> {
  assertLogIcebergRemoteConfig(config);
  assertLogArchiveTableLocations(table, config.bucket);
  if (table.metadata['table-uuid'] !== config.tableUuid)
    throw new Error('log_iceberg_table_identity_changed');
  inspectLogArchiveTable(table.metadata, config.mode);
  await assertLogArchivePhysicalFingerprint(table.metadata, config.physicalFingerprint);
}

export function createLogIcebergObjectStore(
  env: LogIcebergCatalogEnv,
  table: IcebergLoadedTable
): R2IcebergObjectStore {
  if (!env.LOG_ARCHIVE) throw new Error('log_iceberg_bucket_unavailable');
  return new R2IcebergObjectStore(env.LOG_ARCHIVE, table.metadata.location);
}
