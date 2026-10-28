import {
  LOG_ARCHIVE_IMPLEMENTED_MODES,
  LOG_ARCHIVE_SCHEMA_VERSION,
  type LogArchiveMode,
} from '@authrim/ar-lib-logging/iceberg/capabilities';

/** Non-secret settings for the two new storage modes. */
export interface LogIcebergSettingsEnv {
  AUTHRIM_LOG_ARCHIVE_LOCAL_STAGING_ONLY?: string;
  ISSUER_URL?: string;
  AUTHRIM_LOG_ARCHIVE_MODE?: string;
  AUTHRIM_LOG_ARCHIVE_STORAGE_GENERATION?: string;
  AUTHRIM_LOG_ARCHIVE_SCHEMA_VERSION?: string;
  AUTHRIM_LOG_ARCHIVE_ACTIVATED_AT?: string;
  AUTHRIM_LOG_ARCHIVE_ACCOUNT_ID?: string;
  AUTHRIM_LOG_ARCHIVE_BUCKET?: string;
  AUTHRIM_LOG_ARCHIVE_CATALOG_URI?: string;
  AUTHRIM_LOG_ARCHIVE_WAREHOUSE?: string;
  AUTHRIM_LOG_ARCHIVE_NAMESPACE?: string;
  AUTHRIM_LOG_ARCHIVE_TABLE?: string;
  AUTHRIM_LOG_ARCHIVE_TABLE_UUID?: string;
  AUTHRIM_LOG_ARCHIVE_PHYSICAL_FINGERPRINT?: string;
  AUTHRIM_LOG_ARCHIVE_DB_RETENTION_DAYS?: string;
  AUTHRIM_LOG_ARCHIVE_EXPORT_INTERVAL_MINUTES?: string;
}

interface LogIcebergCommonConfig {
  mode: LogArchiveMode;
  generation: string;
  schemaVersion: number;
  activatedAt: number;
  dbRetentionDays: number | null;
  exportIntervalMinutes: number | null;
}
export interface LogIcebergRemoteConfig extends LogIcebergCommonConfig {
  localStagingOnly?: false;
  accountId: string;
  bucket: string;
  catalogUri: string;
  warehouse: string;
  namespace: string;
  table: string;
  tableUuid: string;
  physicalFingerprint: string;
}
export interface LogIcebergLocalConfig extends LogIcebergCommonConfig {
  localStagingOnly: true;
  mode: 'scheduled';
  accountId: null;
  bucket: null;
  catalogUri: null;
  warehouse: null;
  namespace: null;
  table: null;
  tableUuid: null;
  physicalFingerprint: null;
}
export type LogIcebergConfig = LogIcebergRemoteConfig | LogIcebergLocalConfig;

export function assertLogIcebergRemoteConfig(
  config: LogIcebergConfig
): asserts config is LogIcebergRemoteConfig {
  if (config.localStagingOnly) throw new Error('log_iceberg_local_cold_archive_not_connected');
}

function invalid(): never {
  throw new Error('log_iceberg_configuration_invalid');
}

function integer(value: string | undefined, minimum: number, maximum: number): number {
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) invalid();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) invalid();
  return number;
}

/** Parsing is separate from activation so Setup can validate an unfinished resource plan. */
export function resolveLogIcebergConfig(env: LogIcebergSettingsEnv): LogIcebergConfig {
  const mode = env.AUTHRIM_LOG_ARCHIVE_MODE;
  if (mode === undefined) throw new Error('log_iceberg_configuration_required');
  if (mode !== 'pipeline' && mode !== 'scheduled') invalid();
  const generation = env.AUTHRIM_LOG_ARCHIVE_STORAGE_GENERATION;
  if (!generation || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,95}$/.test(generation)) invalid();
  const schemaVersion = integer(env.AUTHRIM_LOG_ARCHIVE_SCHEMA_VERSION, 1, 1_000);
  if (schemaVersion !== LOG_ARCHIVE_SCHEMA_VERSION) invalid();
  const activatedText = env.AUTHRIM_LOG_ARCHIVE_ACTIVATED_AT;
  const activatedAt = Date.parse(activatedText ?? '');
  if (
    !Number.isSafeInteger(activatedAt) ||
    activatedAt < 0 ||
    new Date(activatedAt).toISOString() !== activatedText
  )
    invalid();
  const dbRetentionDays =
    mode === 'scheduled' ? integer(env.AUTHRIM_LOG_ARCHIVE_DB_RETENTION_DAYS, 1, 3650) : null;
  const exportIntervalMinutes =
    mode === 'scheduled' ? integer(env.AUTHRIM_LOG_ARCHIVE_EXPORT_INTERVAL_MINUTES, 1, 1440) : null;
  if (
    mode === 'pipeline' &&
    (env.AUTHRIM_LOG_ARCHIVE_DB_RETENTION_DAYS !== undefined ||
      env.AUTHRIM_LOG_ARCHIVE_EXPORT_INTERVAL_MINUTES !== undefined)
  )
    invalid();
  if (env.AUTHRIM_LOG_ARCHIVE_LOCAL_STAGING_ONLY !== undefined) {
    if (env.AUTHRIM_LOG_ARCHIVE_LOCAL_STAGING_ONLY !== 'true' || mode !== 'scheduled') invalid();
    let issuer: URL;
    try {
      issuer = new URL(env.ISSUER_URL ?? '');
    } catch {
      return invalid();
    }
    if (
      issuer.protocol !== 'http:' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(issuer.hostname)
    )
      invalid();
    const remote = [
      env.AUTHRIM_LOG_ARCHIVE_ACCOUNT_ID,
      env.AUTHRIM_LOG_ARCHIVE_BUCKET,
      env.AUTHRIM_LOG_ARCHIVE_CATALOG_URI,
      env.AUTHRIM_LOG_ARCHIVE_WAREHOUSE,
      env.AUTHRIM_LOG_ARCHIVE_NAMESPACE,
      env.AUTHRIM_LOG_ARCHIVE_TABLE,
      env.AUTHRIM_LOG_ARCHIVE_TABLE_UUID,
      env.AUTHRIM_LOG_ARCHIVE_PHYSICAL_FINGERPRINT,
    ];
    if (remote.some((value) => value !== undefined)) invalid();
    return {
      mode,
      localStagingOnly: true,
      generation,
      schemaVersion,
      activatedAt,
      dbRetentionDays,
      exportIntervalMinutes,
      accountId: null,
      bucket: null,
      catalogUri: null,
      warehouse: null,
      namespace: null,
      table: null,
      tableUuid: null,
      physicalFingerprint: null,
    };
  }
  const accountId = env.AUTHRIM_LOG_ARCHIVE_ACCOUNT_ID;
  const bucket = env.AUTHRIM_LOG_ARCHIVE_BUCKET;
  if (!accountId || !/^[a-f0-9]{32}$/.test(accountId)) invalid();
  if (!bucket || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) invalid();
  const warehouse = env.AUTHRIM_LOG_ARCHIVE_WAREHOUSE;
  if (!warehouse || warehouse !== `${accountId}_${bucket}`) invalid();
  const catalogUri = env.AUTHRIM_LOG_ARCHIVE_CATALOG_URI;
  if (catalogUri !== `https://catalog.cloudflarestorage.com/${accountId}/${bucket}`) invalid();
  const namespace = env.AUTHRIM_LOG_ARCHIVE_NAMESPACE;
  const table = env.AUTHRIM_LOG_ARCHIVE_TABLE;
  if (!namespace || !table || ![namespace, table].every((v) => /^[a-z][a-z0-9_]{0,62}$/.test(v)))
    invalid();
  const tableUuid = env.AUTHRIM_LOG_ARCHIVE_TABLE_UUID;
  const physicalFingerprint = env.AUTHRIM_LOG_ARCHIVE_PHYSICAL_FINGERPRINT;
  if (
    !tableUuid ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(tableUuid)
  )
    invalid();
  if (!physicalFingerprint || !/^[a-f0-9]{64}$/.test(physicalFingerprint)) invalid();
  return {
    mode,
    generation,
    schemaVersion,
    activatedAt,
    accountId,
    bucket,
    catalogUri,
    warehouse,
    namespace,
    table,
    tableUuid,
    physicalFingerprint,
    dbRetentionDays,
    exportIntervalMinutes,
  };
}

export function assertLogIcebergActivated(config: LogIcebergConfig): void {
  if (!LOG_ARCHIVE_IMPLEMENTED_MODES.includes(config.mode))
    throw new Error('log_iceberg_mode_not_implemented');
}
