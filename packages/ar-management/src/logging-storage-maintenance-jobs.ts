import {
  AdminLoggingControlRepository,
  InternalNotificationEventRepository,
  isObjectClass,
  loadChunkedSensitiveDetailJson,
  readR2ObjectTextWithLimit,
  requireDedicatedAdminDatabaseAdapter,
  validateUrlForSSRF,
  type DatabaseAdapter,
  type Env,
  type ObjectClass,
} from '@authrim/ar-lib-core';
import {
  createLoggingId,
  LOG_PLANES,
  LOG_TYPES,
  type LogChunkCompression,
  type LogPlane,
  type LogType,
} from '@authrim/ar-lib-logging';
import {
  isArchiveLogRecordV1,
  projectArchiveLogRecordForExportV1,
} from '@authrim/ar-lib-logging/archive';
import {
  decodeStoredLogChunkRecord,
  defaultLogManifestShard,
  floorLogManifestBucket,
  writeLogChunkManifestToR2,
  type LogChunkManifestRow,
  type LogChunkRecordIndexRow,
} from '@authrim/ar-lib-logging/chunks';
import {
  enqueueLoggingDeliveryPayload,
  SqlLoggingDeliveryEventStore,
  type LoggingDeliveryLane,
} from '@authrim/ar-lib-logging/delivery';
import {
  enqueueLoggingMessagePayload,
  parseLoggingMessageQueuePayload,
  SqlLoggingMessageJobStore,
  writeLoggingMessagePayloadToR2,
  type ExportBuildMessagePayload,
  type LoggingMessageJobRecord,
} from '@authrim/ar-lib-logging/messaging';
import {
  validateDestinationProviderConfig,
  type DestinationHealthStatus,
  type DestinationKind,
  type DestinationProvider,
} from '@authrim/ar-lib-logging/destinations';
import {
  classifyLoggingRewrapPriority,
  SqlLoggingRewrapJobQueue,
} from '@authrim/ar-lib-logging/keys';
import { createLoggingTenantKeyResolver } from './logging-tenant-key';

interface LoggingStorageMaintenanceLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>, error?: Error) => void;
}

const LOGGING_MESSAGE_PAYLOAD_MAX_BYTES = 5 * 1024 * 1024;
const LOGGING_EXPORT_MANIFEST_MAX_BYTES = 1024 * 1024;
const LOGGING_EXPORT_CHUNK_OBJECT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_LOGGING_DELIVERY_EVENT_RETENTION_DAYS = 30;
const BULK_SUCCESS_DELIVERY_EVENT_RETENTION_DAYS = 7;
const RETRY_DLQ_DELIVERY_EVENT_RETENTION_DAYS = 90;
const CRITICAL_FAILURE_DELIVERY_EVENT_RETENTION_DAYS = 180;
const LOGGING_RETENTION_DELETE_BATCH_SIZE = 500;
const LOGGING_USAGE_WINDOW_KINDS = ['hour', 'day'] as const;
const LOGGING_QUOTA_METRICS = [
  'delivery_records',
  'delivery_bytes',
  'delivery_batches',
  'dlq_items',
  'catalog_objects',
  'catalog_bytes',
  'sensitive_detail_bytes',
  'message_jobs',
] as const;

type LoggingUsageWindowKind = (typeof LOGGING_USAGE_WINDOW_KINDS)[number];
type LoggingQuotaMetric = (typeof LOGGING_QUOTA_METRICS)[number];
type LoggingQuotaEnforcementMode =
  | 'disabled'
  | 'observe'
  | 'warn_only'
  | 'soft_limit'
  | 'hard_non_critical';
type LoggingQuotaState = 'ok' | 'warning' | 'soft_exceeded' | 'hard_exceeded';
type LoggingQuotaEnforcementAction =
  | 'none'
  | 'notify'
  | 'throttle_non_critical'
  | 'block_non_critical';

interface ScheduledDestinationRow {
  id: string;
  scope_type: string;
  scope_id: string;
  destination_kind: DestinationKind;
  provider: DestinationProvider;
  name: string;
  lifecycle_status: string;
  health_status: DestinationHealthStatus;
  provider_config: string;
  last_health_check_at: number | string | null;
}

interface ScheduledManifestChunkRow {
  id: string;
  tenant_key: string;
  log_type: LogType;
  plane: LogPlane;
  object_key: string;
  record_count: number | string;
  byte_count: number | string;
  checksum_sha256: string;
  committed_at: number | string;
}

interface RewrapCandidateRow {
  key_registry_id: string;
  tenant_key: string;
  surface: string | null;
  log_type: LogType;
  plane: LogPlane;
  active_version: number | string;
  from_version: number | string;
  key_version_status: 'rewrap_required' | 'compromised';
  object_catalog_id: string;
  object_key: string;
  record_count: number | string;
  committed_at: number | string | null;
}

interface RewrapJobRow {
  id: string;
  key_registry_id: string;
  from_version: number | string;
  to_version: number | string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped';
  metadata: string | null;
}

interface LoggingQuotaPolicyRow {
  id: string;
  scope_type: 'platform' | 'tenant';
  scope_id: string;
  log_type: LogType | null;
  plane: LogPlane | null;
  lane: LoggingDeliveryLane | null;
  metric_name: LoggingQuotaMetric;
  window_kind: LoggingUsageWindowKind;
  soft_limit: number | string | null;
  hard_limit: number | string | null;
  warning_ratio: number | string | null;
  enforcement_mode: LoggingQuotaEnforcementMode;
}

interface LoggingExportBuildFilters {
  tenant_key: string | null;
  log_type: LogType | null;
  plane: LogPlane | null;
  source: 'catalog' | 'record_index';
  time_start: number | null;
  time_end: number | null;
  limit: number;
  include_payload: boolean;
  detail_scope: 'none' | 'full';
}

interface LoggingExportBuildPartRow {
  partition_index: number | string;
  part_object_ref: string;
  part_checksum_sha256: string;
  part_record_count: number | string;
  part_byte_count: number | string;
}

interface LoggingExportBuildJobRow {
  id: string;
  format: 'jsonl' | 'csv' | 'zip';
  status: string;
  artifact_object_ref: string | null;
  manifest_object_ref: string | null;
  checksum_sha256: string | null;
  record_count: number | string;
  byte_count: number | string;
  expires_at: number | null;
}

interface LoggingExportRecordIndexRow extends Record<string, unknown> {
  record_id: string;
  tenant_key: string;
  log_type: LogType;
  plane: LogPlane;
  surface: string | null;
  object_catalog_id: string;
  chunk_id: string;
  object_key: string | null;
  object_kind: string | null;
  object_byte_count: number | string | null;
  compression: LogChunkCompression | null;
  encryption_scope: string | null;
  key_version: number | string | null;
  line_number: number | string | null;
  block_offset: number | string | null;
  block_length: number | string | null;
  record_offset: number | string | null;
  record_length: number | string | null;
  event_at: number | string;
  index_profile: string;
  indexed_fields: string | null;
  status: string;
  created_at: number | string;
}

interface LoggingExportPartRepairCandidateRow {
  message_job_id: string | null;
  export_job_id: string;
  part_object_ref: string;
  phase: string;
  tenant_key: string | null;
  kind: string | null;
  status: string | null;
  criticality: 'standard' | 'critical' | null;
  lane: 'critical' | 'default' | 'bulk' | null;
}

interface LoggingExportCleanupCandidateRow {
  message_job_id: string | null;
  export_job_id: string;
  part_object_ref: string | null;
  manifest_object_ref: string | null;
}

interface DestinationHealthCheckResult {
  check_type: 'quick' | 'deep' | 'adaptive';
  previous_health_status: DestinationHealthStatus | null;
  next_health_status: DestinationHealthStatus;
  result: 'success' | 'failure' | 'partial';
  error_class: string | null;
  latency_ms: number;
  metadata: Record<string, unknown>;
}

const EXPORT_BUILD_PART_SIZE = 1000;
const EXPORT_BUILD_MAX_PARTITIONS = 50;

export interface LoggingStorageMaintenanceResult {
  healthChecks: {
    checked: number;
    failed: number;
  };
  manifests: {
    published: number;
    skipped: number;
  };
  catalogRepair: {
    findings: number;
    applied: number;
    skipped: number;
  };
  rewrap: {
    candidates: number;
    jobsCreated: number;
    dispatched: number;
    queueUnavailable: number;
    skipped: number;
  };
  messageJobs: {
    repaired: number;
    repairFindings: number;
    expired: number;
    claimed: number;
    completed: number;
    retrying: number;
    dlq: number;
    blocked: number;
  };
  retention: {
    deliveryEventsDeleted: number;
    deliveryAggregatesDeleted: number;
    dlqItemsPurged: number;
  };
  usage: {
    windowsRefreshed: number;
    aggregatesRefreshed: number;
    quotaPoliciesEvaluated: number;
    quotaWarnings: number;
    quotaActions: number;
  };
}

function parseProviderConfig(config: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(config) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function configString(config: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = config[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function getEnvBinding<T>(env: Env, bindingName: string): T | null {
  const value = (env as unknown as Record<string, unknown>)[bindingName];
  return value ? (value as T) : null;
}

async function runScheduledDestinationHealthCheck(
  env: Env,
  destination: ScheduledDestinationRow,
  now: number
): Promise<DestinationHealthCheckResult> {
  const start = Date.now();
  const previous = destination.health_status ?? 'unknown';
  const checkType = resolveScheduledDestinationHealthCheckType(destination, now);
  const metadata: Record<string, unknown> = {
    provider: destination.provider,
    destination_kind: destination.destination_kind,
    scheduled: true,
  };

  if (destination.lifecycle_status !== 'active') {
    return {
      check_type: checkType,
      previous_health_status: previous,
      next_health_status: 'failing',
      result: 'failure',
      error_class: 'destination_not_active',
      latency_ms: Date.now() - start,
      metadata,
    };
  }

  const config = parseProviderConfig(destination.provider_config);
  const validation = validateDestinationProviderConfig(destination.provider, config);
  if (!validation.valid) {
    return {
      check_type: checkType,
      previous_health_status: previous,
      next_health_status: 'failing',
      result: 'failure',
      error_class: 'provider_config_invalid',
      latency_ms: Date.now() - start,
      metadata: { ...metadata, validation_errors: validation.errors },
    };
  }

  if (destination.provider === 'r2') {
    const bindingName = configString(config, ['bindingRef', 'binding', 'bucketBinding']);
    const bucket = bindingName ? getEnvBinding<R2Bucket>(env, bindingName) : null;
    metadata.binding_ref = bindingName;
    if (!bucket || typeof bucket.put !== 'function') {
      return {
        check_type: checkType,
        previous_health_status: previous,
        next_health_status: 'unreachable',
        result: 'failure',
        error_class: 'r2_binding_unavailable',
        latency_ms: Date.now() - start,
        metadata,
      };
    }
    if (checkType === 'deep' || checkType === 'adaptive') {
      const prefix = configString(config, ['prefix', 'pathPrefix']) ?? 'authrim';
      const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, '') || 'authrim';
      const key = `${normalizedPrefix}/health/${destination.id}-${now}.txt`;
      await bucket.put(key, 'authrim destination health check');
      const object = typeof bucket.head === 'function' ? await bucket.head(key) : null;
      if (typeof bucket.delete === 'function') {
        await bucket.delete(key);
      }
      metadata.probe_key = key;
      if (!object) {
        return {
          check_type: checkType,
          previous_health_status: previous,
          next_health_status: 'degraded',
          result: 'partial',
          error_class: 'r2_head_missing_after_write',
          latency_ms: Date.now() - start,
          metadata,
        };
      }
    }
    return {
      check_type: checkType,
      previous_health_status: previous,
      next_health_status: 'healthy',
      result: 'success',
      error_class: null,
      latency_ms: Date.now() - start,
      metadata,
    };
  }

  if (destination.provider === 'http') {
    const url = configString(config, ['url', 'endpointUrl', 'healthUrl']);
    const validationResult = url
      ? validateUrlForSSRF(url)
      : { valid: false, error: 'url_required' };
    metadata.url_configured = Boolean(url);
    if (!validationResult.valid || (url && !url.startsWith('https://'))) {
      return {
        check_type: checkType,
        previous_health_status: previous,
        next_health_status: 'failing',
        result: 'failure',
        error_class: 'http_sink_url_invalid',
        latency_ms: Date.now() - start,
        metadata: { ...metadata, error: validationResult.error ?? 'https_required' },
      };
    }
    return {
      check_type: checkType,
      previous_health_status: previous,
      next_health_status: 'healthy',
      result: 'success',
      error_class: null,
      latency_ms: Date.now() - start,
      metadata,
    };
  }

  return {
    check_type: checkType,
    previous_health_status: previous,
    next_health_status: 'degraded',
    result: 'partial',
    error_class: 'provider_health_check_not_supported',
    latency_ms: Date.now() - start,
    metadata,
  };
}

function resolveScheduledDestinationHealthCheckType(
  destination: ScheduledDestinationRow,
  now: number
): DestinationHealthCheckResult['check_type'] {
  if (['degraded', 'failing', 'unreachable'].includes(destination.health_status)) {
    return 'adaptive';
  }
  const lastCheckedAt =
    typeof destination.last_health_check_at === 'number'
      ? destination.last_health_check_at
      : Number.parseInt(String(destination.last_health_check_at ?? ''), 10);
  if (Number.isFinite(lastCheckedAt) && now - lastCheckedAt >= 24 * 60 * 60 * 1000) {
    return 'deep';
  }
  return 'quick';
}

async function enqueueHealthNotification(
  adapter: DatabaseAdapter,
  destination: ScheduledDestinationRow,
  result: DestinationHealthCheckResult,
  checkedAt: number
): Promise<void> {
  if (result.result === 'success') {
    return;
  }

  const deduplicationKey = [
    'logging_destination_health',
    destination.id,
    result.check_type,
    result.next_health_status,
    result.error_class ?? 'none',
  ].join(':');
  const repository = new InternalNotificationEventRepository(adapter);
  await repository.enqueue({
    tenantId: destination.scope_id || 'global',
    category: 'logging_destination_health',
    eventType: `logging.destination.health.${result.next_health_status}`,
    severity:
      result.next_health_status === 'unreachable' || result.next_health_status === 'failing'
        ? 'high'
        : 'medium',
    deduplicationKey,
    payload: {
      destination_id: destination.id,
      destination_name: destination.name,
      scope_type: destination.scope_type,
      scope_id: destination.scope_id,
      check_type: result.check_type,
      previous_health_status: result.previous_health_status,
      next_health_status: result.next_health_status,
      result: result.result,
      error_class: result.error_class,
      latency_ms: result.latency_ms,
      metadata: result.metadata,
    },
    now: new Date(checkedAt),
  });
}

async function enqueueManifestPublishFailureNotification(
  adapter: DatabaseAdapter,
  input: {
    tenantKey: string;
    logType: LogType;
    plane: LogPlane;
    bucketStartAt: number;
    bucketEndAt: number;
    shard: string;
    errorClass: string;
    message?: string;
    now: number;
  }
): Promise<void> {
  const repository = new InternalNotificationEventRepository(adapter);
  await repository.enqueue({
    tenantId: input.tenantKey,
    category: 'logging_delivery_failure',
    eventType: 'logging.manifest.publish.failed',
    severity: 'medium',
    deduplicationKey: [
      'logging_manifest_publish_failed',
      input.tenantKey,
      input.logType,
      input.plane,
      input.bucketStartAt,
      input.shard,
      input.errorClass,
    ].join(':'),
    payload: {
      tenant_key: input.tenantKey,
      log_type: input.logType,
      plane: input.plane,
      bucket_start_at: input.bucketStartAt,
      bucket_end_at: input.bucketEndAt,
      shard: input.shard,
      error_class: input.errorClass,
      message: input.message,
    },
    now: new Date(input.now),
  });
}

async function runScheduledDestinationHealthChecks(
  env: Env,
  adapter: DatabaseAdapter,
  log: LoggingStorageMaintenanceLogger,
  now: number
): Promise<LoggingStorageMaintenanceResult['healthChecks']> {
  const staleBefore = now - 6 * 60 * 60 * 1000;
  const destinations = await adapter.query<ScheduledDestinationRow>(
    `SELECT id, scope_type, scope_id, destination_kind, provider, name,
            lifecycle_status, health_status, provider_config, last_health_check_at
     FROM admin_destinations
     WHERE deleted_at IS NULL
       AND lifecycle_status = 'active'
       AND (last_health_check_at IS NULL OR last_health_check_at < ?)
     ORDER BY COALESCE(last_health_check_at, 0) ASC, id ASC
     LIMIT ?`,
    [staleBefore, 50]
  );

  let failed = 0;
  for (const destination of destinations) {
    const result = await runScheduledDestinationHealthCheck(env, destination, now);
    if (result.result !== 'success') {
      failed += 1;
    }
    await adapter.execute(
      `INSERT INTO admin_destination_health_events (
        id, destination_id, check_type, previous_health_status, next_health_status,
        result, error_class, latency_ms, checked_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        createLoggingId('dhe', now),
        destination.id,
        result.check_type,
        result.previous_health_status,
        result.next_health_status,
        result.result,
        result.error_class,
        result.latency_ms,
        now,
        JSON.stringify(result.metadata),
      ]
    );
    await adapter.execute(
      `UPDATE admin_destinations
       SET health_status = ?, last_health_check_at = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL`,
      [result.next_health_status, now, now, destination.id]
    );
    try {
      await enqueueHealthNotification(adapter, destination, result, now);
    } catch (error) {
      log.warn('Logging destination health notification enqueue failed', {
        destinationId: destination.id,
        error: error instanceof Error ? error.message : 'unknown_error',
      });
    }
  }

  log.debug?.('Logging destination scheduled health checks completed', {
    checked: destinations.length,
    failed,
  });
  return { checked: destinations.length, failed };
}

function toInteger(value: number | string | null | undefined, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function integerOrNull(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function unknownToInteger(value: unknown, fallback = 0): number {
  return typeof value === 'number' ||
    typeof value === 'string' ||
    value === null ||
    value === undefined
    ? toInteger(value, fallback)
    : fallback;
}

function parseMetadata(value: string | null): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function compactUsageIdentifierSegment(value: string | null | undefined): string {
  return (value ?? 'all').replace(/[^A-Za-z0-9._=-]+/g, '_').slice(0, 96) || 'all';
}

function buildScheduledUsageAggregateId(input: {
  tenantId?: string | null;
  tenantKey?: string | null;
  logType?: string | null;
  plane?: string | null;
  lane?: string | null;
  metricName: string;
  windowKind: string;
  windowStartAt: number;
}): string {
  return [
    'uga',
    compactUsageIdentifierSegment(input.windowKind),
    String(input.windowStartAt),
    compactUsageIdentifierSegment(input.metricName),
    compactUsageIdentifierSegment(input.tenantId),
    compactUsageIdentifierSegment(input.tenantKey),
    compactUsageIdentifierSegment(input.logType),
    compactUsageIdentifierSegment(input.plane),
    compactUsageIdentifierSegment(input.lane),
  ].join(':');
}

function floorUsageWindow(now: number, windowKind: LoggingUsageWindowKind): number {
  const date = new Date(now);
  if (windowKind === 'day') {
    date.setUTCHours(0, 0, 0, 0);
  } else {
    date.setUTCMinutes(0, 0, 0);
  }
  return date.getTime();
}

function endUsageWindow(start: number, windowKind: LoggingUsageWindowKind): number {
  return start + (windowKind === 'day' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000);
}

function readNullableInteger(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = toInteger(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function readQuotaWarningRatio(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === '') {
    return 0.8;
  }
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : 0.8;
}

function quotaStateForValue(input: {
  value: number;
  softLimit: number | null;
  hardLimit: number | null;
  warningRatio: number;
}): LoggingQuotaState {
  if (input.hardLimit !== null && input.value >= input.hardLimit) {
    return 'hard_exceeded';
  }
  if (input.softLimit !== null && input.value >= input.softLimit) {
    return 'soft_exceeded';
  }
  const warningBase = input.softLimit ?? input.hardLimit;
  if (warningBase !== null && input.value >= Math.floor(warningBase * input.warningRatio)) {
    return 'warning';
  }
  return 'ok';
}

function isQuotaCriticalScope(input: {
  logType: LogType | null;
  plane: LogPlane | null;
  lane: LoggingDeliveryLane | null;
}): boolean {
  if (input.lane === 'critical' || input.plane === 'sensitive_detail') {
    return true;
  }
  return (
    input.logType === 'audit' || input.logType === 'admin_audit' || input.logType === 'security'
  );
}

function quotaEnforcementAction(input: {
  state: LoggingQuotaState;
  enforcementMode: LoggingQuotaEnforcementMode;
  critical: boolean;
}): LoggingQuotaEnforcementAction {
  if (
    input.state === 'ok' ||
    input.enforcementMode === 'disabled' ||
    input.enforcementMode === 'observe'
  ) {
    return 'none';
  }
  if (
    input.state === 'hard_exceeded' &&
    input.enforcementMode === 'hard_non_critical' &&
    !input.critical
  ) {
    return 'block_non_critical';
  }
  if (input.state !== 'warning' && input.enforcementMode === 'soft_limit' && !input.critical) {
    return 'throttle_non_critical';
  }
  return 'notify';
}

async function upsertScheduledUsageAggregate(
  adapter: DatabaseAdapter,
  row: {
    tenantId?: string | null;
    tenantKey?: string | null;
    logType?: string | null;
    plane?: string | null;
    lane?: string | null;
    metricName: LoggingQuotaMetric;
    windowKind: LoggingUsageWindowKind;
    windowStartAt: number;
    windowEndAt: number;
    value: number;
    sourceTable: string;
    metadata?: Record<string, unknown>;
    now: number;
  }
): Promise<void> {
  const id = buildScheduledUsageAggregateId(row);
  const existing = await adapter.queryOne<{ id: string }>(
    'SELECT id FROM logging_usage_aggregates WHERE id = ?',
    [id]
  );
  if (existing) {
    await adapter.execute(
      `UPDATE logging_usage_aggregates
       SET value = ?,
           source_table = ?,
           metadata_json = ?,
           refreshed_at = ?,
           updated_at = ?
       WHERE id = ?`,
      [row.value, row.sourceTable, JSON.stringify(row.metadata ?? {}), row.now, row.now, id]
    );
    return;
  }
  await adapter.execute(
    `INSERT INTO logging_usage_aggregates (
      id, tenant_id, tenant_key, log_type, plane, lane, metric_name, window_kind,
      window_start_at, window_end_at, value, source_table, metadata_json,
      refreshed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      row.tenantId ?? null,
      row.tenantKey ?? null,
      row.logType ?? null,
      row.plane ?? null,
      row.lane ?? null,
      row.metricName,
      row.windowKind,
      row.windowStartAt,
      row.windowEndAt,
      row.value,
      row.sourceTable,
      JSON.stringify(row.metadata ?? {}),
      row.now,
      row.now,
      row.now,
    ]
  );
}

async function refreshScheduledUsageAggregatesForWindow(
  adapter: DatabaseAdapter,
  input: {
    windowKind: LoggingUsageWindowKind;
    windowStartAt: number;
    now: number;
  }
): Promise<number> {
  const windowEndAt = endUsageWindow(input.windowStartAt, input.windowKind);
  let refreshed = 0;

  const deliveryRows = await adapter.query<Record<string, unknown>>(
    `SELECT tenant_key, log_type, plane, lane,
            SUM(record_count) AS record_count,
            SUM(byte_count) AS byte_count,
            SUM(batch_count) AS batch_count
     FROM logging_delivery_event_aggregates
     WHERE bucket_start_at >= ? AND bucket_start_at < ?
     GROUP BY tenant_key, log_type, plane, lane`,
    [input.windowStartAt, windowEndAt]
  );
  for (const row of deliveryRows) {
    for (const metricName of ['delivery_records', 'delivery_bytes', 'delivery_batches'] as const) {
      await upsertScheduledUsageAggregate(adapter, {
        tenantKey: String(row.tenant_key),
        logType: String(row.log_type),
        plane: String(row.plane),
        lane: String(row.lane),
        metricName,
        windowKind: input.windowKind,
        windowStartAt: input.windowStartAt,
        windowEndAt,
        value: unknownToInteger(
          metricName === 'delivery_records'
            ? row.record_count
            : metricName === 'delivery_bytes'
              ? row.byte_count
              : row.batch_count
        ),
        sourceTable: 'logging_delivery_event_aggregates',
        now: input.now,
      });
      refreshed += 1;
    }
  }

  const catalogRows = await adapter.query<Record<string, unknown>>(
    `SELECT tenant_key, log_type, plane,
            COUNT(*) AS object_count,
            SUM(byte_count) AS byte_count
     FROM log_object_catalog
     WHERE created_at >= ? AND created_at < ?
     GROUP BY tenant_key, log_type, plane`,
    [input.windowStartAt, windowEndAt]
  );
  for (const row of catalogRows) {
    for (const metricName of ['catalog_objects', 'catalog_bytes'] as const) {
      await upsertScheduledUsageAggregate(adapter, {
        tenantKey: String(row.tenant_key),
        logType: String(row.log_type),
        plane: String(row.plane),
        metricName,
        windowKind: input.windowKind,
        windowStartAt: input.windowStartAt,
        windowEndAt,
        value: unknownToInteger(
          metricName === 'catalog_objects' ? row.object_count : row.byte_count
        ),
        sourceTable: 'log_object_catalog',
        now: input.now,
      });
      refreshed += 1;
    }
  }

  const dlqRows = await adapter.query<Record<string, unknown>>(
    `SELECT tenant_key, lane, COUNT(*) AS item_count
     FROM logging_dlq_items
     WHERE created_at >= ? AND created_at < ?
     GROUP BY tenant_key, lane`,
    [input.windowStartAt, windowEndAt]
  );
  for (const row of dlqRows) {
    await upsertScheduledUsageAggregate(adapter, {
      tenantKey: String(row.tenant_key),
      lane: String(row.lane),
      metricName: 'dlq_items',
      windowKind: input.windowKind,
      windowStartAt: input.windowStartAt,
      windowEndAt,
      value: unknownToInteger(row.item_count),
      sourceTable: 'logging_dlq_items',
      now: input.now,
    });
    refreshed += 1;
  }

  const sensitiveRows = await adapter.query<Record<string, unknown>>(
    `SELECT tenant_id, object_class, SUM(byte_length) AS byte_count
     FROM sensitive_detail_chunk_index
     WHERE created_at >= ? AND created_at < ?
     GROUP BY tenant_id, object_class`,
    [input.windowStartAt, windowEndAt]
  );
  for (const row of sensitiveRows) {
    await upsertScheduledUsageAggregate(adapter, {
      tenantId: String(row.tenant_id),
      plane: 'sensitive_detail',
      metricName: 'sensitive_detail_bytes',
      windowKind: input.windowKind,
      windowStartAt: input.windowStartAt,
      windowEndAt,
      value: unknownToInteger(row.byte_count),
      sourceTable: 'sensitive_detail_chunk_index',
      metadata: { object_class: row.object_class },
      now: input.now,
    });
    refreshed += 1;
  }

  const messageJobRows = await adapter.query<Record<string, unknown>>(
    `SELECT tenant_key, lane, kind, COUNT(*) AS job_count
     FROM logging_message_jobs
     WHERE created_at >= ? AND created_at < ?
     GROUP BY tenant_key, lane, kind`,
    [input.windowStartAt, windowEndAt]
  );
  for (const row of messageJobRows) {
    await upsertScheduledUsageAggregate(adapter, {
      tenantKey: typeof row.tenant_key === 'string' ? row.tenant_key : null,
      lane: typeof row.lane === 'string' ? row.lane : null,
      metricName: 'message_jobs',
      windowKind: input.windowKind,
      windowStartAt: input.windowStartAt,
      windowEndAt,
      value: unknownToInteger(row.job_count),
      sourceTable: 'logging_message_jobs',
      metadata: { kind: row.kind },
      now: input.now,
    });
    refreshed += 1;
  }

  return refreshed;
}

async function evaluateScheduledQuotaPolicies(
  adapter: DatabaseAdapter,
  now: number
): Promise<{
  quotaPoliciesEvaluated: number;
  quotaWarnings: number;
  quotaActions: number;
}> {
  const policies = await adapter.query<LoggingQuotaPolicyRow>(
    `SELECT id, scope_type, scope_id, log_type, plane, lane, metric_name, window_kind,
            soft_limit, hard_limit, warning_ratio, enforcement_mode
     FROM logging_quota_policies
     WHERE status = 'active' AND deleted_at IS NULL
     ORDER BY scope_type ASC, scope_id ASC, metric_name ASC
     LIMIT 500`
  );
  const tenantKeyResolver = createLoggingTenantKeyResolver(adapter);
  const notificationRepo = new InternalNotificationEventRepository(adapter);
  let quotaWarnings = 0;
  let quotaActions = 0;

  for (const policy of policies) {
    const windowKind = policy.window_kind ?? 'day';
    const windowStartAt = floorUsageWindow(now, windowKind);
    const conditions = ['metric_name = ?', 'window_kind = ?', 'window_start_at = ?'];
    const params: unknown[] = [policy.metric_name, windowKind, windowStartAt];
    let tenantKey: string | null = null;

    if (policy.scope_type === 'tenant') {
      tenantKey = (await tenantKeyResolver(policy.scope_id)) ?? null;
      conditions.push('(tenant_id = ? OR tenant_key = ?)');
      params.push(policy.scope_id, tenantKey);
    }
    if (policy.log_type) {
      conditions.push('log_type = ?');
      params.push(policy.log_type);
    }
    if (policy.plane) {
      conditions.push('plane = ?');
      params.push(policy.plane);
    }
    if (policy.lane) {
      conditions.push('lane = ?');
      params.push(policy.lane);
    }

    const usage = await adapter.queryOne<{ value: number | string | null }>(
      `SELECT SUM(value) AS value
       FROM logging_usage_aggregates
       WHERE ${conditions.join(' AND ')}`,
      params
    );
    const value = toInteger(usage?.value);
    const softLimit = readNullableInteger(policy.soft_limit);
    const hardLimit = readNullableInteger(policy.hard_limit);
    const state = quotaStateForValue({
      value,
      softLimit,
      hardLimit,
      warningRatio: readQuotaWarningRatio(policy.warning_ratio),
    });
    const critical = isQuotaCriticalScope({
      logType: policy.log_type,
      plane: policy.plane,
      lane: policy.lane,
    });
    const enforcementAction = quotaEnforcementAction({
      state,
      enforcementMode: policy.enforcement_mode,
      critical,
    });
    let notificationEventId: string | null = null;
    if (state !== 'ok') {
      quotaWarnings += 1;
      const notification = await notificationRepo.enqueue({
        tenantId: policy.scope_type === 'tenant' ? policy.scope_id : 'global',
        category: 'logging_quota_warning',
        eventType: `logging.quota.${state}`,
        severity: state === 'hard_exceeded' ? 'high' : state === 'soft_exceeded' ? 'medium' : 'low',
        deduplicationKey: ['logging_quota', policy.id, windowKind, windowStartAt, state].join(':'),
        payload: {
          quota_policy_id: policy.id,
          scope_type: policy.scope_type,
          scope_id: policy.scope_id,
          tenant_key: tenantKey,
          metric_name: policy.metric_name,
          window_kind: windowKind,
          window_start_at: windowStartAt,
          value,
          soft_limit: softLimit,
          hard_limit: hardLimit,
          state,
          enforcement_action: enforcementAction,
        },
        routingPolicy: {
          providers: ['internal_event', 'webhook', 'email'],
          failurePolicy: 'retry_until_dead_letter',
          policyScope: 'deployment',
          allowProviderSuppression: true,
        },
        now: new Date(now),
      });
      notificationEventId = notification.id;
    }
    if (enforcementAction !== 'none' && enforcementAction !== 'notify') {
      quotaActions += 1;
    }

    await adapter.execute(
      `INSERT INTO logging_quota_evaluations (
        id, quota_policy_id, tenant_id, tenant_key, log_type, plane, lane,
        metric_name, window_kind, window_start_at, window_end_at, value,
        soft_limit, hard_limit, state, enforcement_action, evaluated_at,
        notification_event_id, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        createLoggingId('lqe', now),
        policy.id,
        policy.scope_type === 'tenant' ? policy.scope_id : null,
        tenantKey,
        policy.log_type,
        policy.plane,
        policy.lane,
        policy.metric_name,
        windowKind,
        windowStartAt,
        endUsageWindow(windowStartAt, windowKind),
        value,
        softLimit,
        hardLimit,
        state,
        enforcementAction,
        now,
        notificationEventId,
        JSON.stringify({ critical_scope: critical, enforcement_mode: policy.enforcement_mode }),
      ]
    );
  }

  return {
    quotaPoliciesEvaluated: policies.length,
    quotaWarnings,
    quotaActions,
  };
}

async function runScheduledUsageAndQuotaMaintenance(
  adapter: DatabaseAdapter,
  log: LoggingStorageMaintenanceLogger,
  now: number
): Promise<LoggingStorageMaintenanceResult['usage']> {
  let windowsRefreshed = 0;
  let aggregatesRefreshed = 0;
  for (const windowKind of LOGGING_USAGE_WINDOW_KINDS) {
    const windowStartAt = floorUsageWindow(now, windowKind);
    aggregatesRefreshed += await refreshScheduledUsageAggregatesForWindow(adapter, {
      windowKind,
      windowStartAt,
      now,
    });
    windowsRefreshed += 1;
  }
  const quota = await evaluateScheduledQuotaPolicies(adapter, now);
  const result = {
    windowsRefreshed,
    aggregatesRefreshed,
    ...quota,
  };
  log.debug?.('Logging usage/quota scheduled maintenance completed', result);
  return result;
}

function getManifestBucket(env: Env, plane: LogPlane): R2Bucket | null {
  if (plane === 'sensitive_detail') {
    return env.SENSITIVE_DETAILS ?? null;
  }
  if (plane === 'diagnostic_detail') {
    return env.DIAGNOSTIC_LOGS ?? null;
  }
  return env.AUDIT_ARCHIVE ?? null;
}

function manifestGroupKey(input: {
  tenantKey: string;
  logType: LogType;
  plane: LogPlane;
  surface?: string | null;
  bucketStartAt: number;
  shard: string;
}): string {
  return [
    input.tenantKey,
    input.logType,
    input.plane,
    String(input.bucketStartAt),
    input.shard,
  ].join('|');
}

async function upsertManifestRow(
  adapter: DatabaseAdapter,
  row: LogChunkManifestRow
): Promise<void> {
  const update = await adapter.execute(
    `UPDATE log_chunk_manifests
     SET id = ?,
         bucket_end_at = ?,
         manifest_object_key = ?,
         chunk_count = ?,
         record_count = ?,
         checksum_sha256 = ?,
         status = ?,
         updated_at = ?
     WHERE tenant_key = ?
       AND log_type = ?
       AND plane = ?
       AND bucket_start_at = ?
       AND shard = ?`,
    [
      row.id,
      row.bucketEndAt,
      row.manifestObjectKey,
      row.chunkCount,
      row.recordCount,
      row.checksumSha256,
      row.status,
      row.updatedAt,
      row.tenantKey,
      row.logType,
      row.plane,
      row.bucketStartAt,
      row.shard,
    ]
  );
  if (update.rowsAffected > 0) {
    return;
  }

  await adapter.execute(
    `INSERT INTO log_chunk_manifests (
      id, tenant_key, log_type, plane, bucket_start_at, bucket_end_at, shard,
      manifest_object_key, chunk_count, record_count, checksum_sha256, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.tenantKey,
      row.logType,
      row.plane,
      row.bucketStartAt,
      row.bucketEndAt,
      row.shard,
      row.manifestObjectKey,
      row.chunkCount,
      row.recordCount,
      row.checksumSha256,
      row.status,
      row.createdAt,
      row.updatedAt,
    ]
  );
}

async function runScheduledManifestPublish(
  env: Env,
  adapter: DatabaseAdapter,
  log: LoggingStorageMaintenanceLogger,
  now: number
): Promise<LoggingStorageMaintenanceResult['manifests']> {
  const bucketSizeMs = 60 * 60 * 1000;
  const readyBefore = now - 5 * 60 * 1000;
  const rows = await adapter.query<ScheduledManifestChunkRow>(
    `SELECT id, tenant_key, log_type, plane, object_key, record_count, byte_count,
            checksum_sha256, committed_at
     FROM log_object_catalog
     WHERE status = 'committed'
       AND object_kind = 'chunk'
       AND checksum_sha256 IS NOT NULL
       AND committed_at IS NOT NULL
       AND committed_at <= ?
     ORDER BY committed_at ASC, id ASC
     LIMIT ?`,
    [readyBefore, 500]
  );

  const groups = new Map<
    string,
    {
      tenantKey: string;
      logType: LogType;
      plane: LogPlane;
      bucketStartAt: number;
      bucketEndAt: number;
      shard: string;
      chunks: Array<{
        objectCatalogId: string;
        objectKey: string;
        chunkId: string;
        recordCount: number;
        byteCount: number;
        checksumSha256: string;
        minEventAt: number;
        maxEventAt: number;
      }>;
    }
  >();

  for (const row of rows) {
    const committedAt = toInteger(row.committed_at);
    const bucketStartAt = floorLogManifestBucket(committedAt, bucketSizeMs);
    const bucketEndAt = bucketStartAt + bucketSizeMs;
    if (bucketEndAt > readyBefore) {
      continue;
    }
    const shard = defaultLogManifestShard({ tenantKey: row.tenant_key });
    const key = manifestGroupKey({
      tenantKey: row.tenant_key,
      logType: row.log_type,
      plane: row.plane,
      bucketStartAt,
      shard,
    });
    const group = groups.get(key) ?? {
      tenantKey: row.tenant_key,
      logType: row.log_type,
      plane: row.plane,
      bucketStartAt,
      bucketEndAt,
      shard,
      chunks: [],
    };
    group.chunks.push({
      objectCatalogId: row.id,
      objectKey: row.object_key,
      chunkId: row.id,
      recordCount: toInteger(row.record_count),
      byteCount: toInteger(row.byte_count),
      checksumSha256: row.checksum_sha256,
      minEventAt: committedAt,
      maxEventAt: committedAt,
    });
    groups.set(key, group);
  }

  let published = 0;
  let skipped = 0;
  for (const group of groups.values()) {
    const existing = await adapter.queryOne<{ id: string }>(
      `SELECT id
       FROM log_chunk_manifests
       WHERE tenant_key = ?
         AND log_type = ?
         AND plane = ?
         AND bucket_start_at = ?
         AND shard = ?
         AND status = 'committed'
       LIMIT 1`,
      [group.tenantKey, group.logType, group.plane, group.bucketStartAt, group.shard]
    );
    if (existing) {
      skipped += 1;
      continue;
    }

    const bucket = getManifestBucket(env, group.plane);
    if (!bucket) {
      skipped += 1;
      try {
        await enqueueManifestPublishFailureNotification(adapter, {
          tenantKey: group.tenantKey,
          logType: group.logType,
          plane: group.plane,
          bucketStartAt: group.bucketStartAt,
          bucketEndAt: group.bucketEndAt,
          shard: group.shard,
          errorClass: 'manifest_bucket_unavailable',
          now,
        });
      } catch (error) {
        log.warn('Logging manifest publish failure notification enqueue failed', {
          tenantKey: group.tenantKey,
          logType: group.logType,
          plane: group.plane,
          error: error instanceof Error ? error.message : 'unknown_error',
        });
      }
      continue;
    }

    try {
      await writeLogChunkManifestToR2({
        bucket,
        tenantKey: group.tenantKey,
        logType: group.logType,
        plane: group.plane,
        bucketStartAt: group.bucketStartAt,
        bucketEndAt: group.bucketEndAt,
        shard: group.shard,
        chunks: group.chunks,
        now,
        catalogStore: {
          createPendingObject: async () => undefined,
          createPendingRecordIndexes: async () => undefined,
          commitObject: async () => undefined,
          commitRecordIndexes: async () => undefined,
          markObjectOrphanCandidate: async () => undefined,
          upsertManifest: async (row) => upsertManifestRow(adapter, row),
        },
      });
      published += 1;
    } catch (error) {
      skipped += 1;
      try {
        await enqueueManifestPublishFailureNotification(adapter, {
          tenantKey: group.tenantKey,
          logType: group.logType,
          plane: group.plane,
          bucketStartAt: group.bucketStartAt,
          bucketEndAt: group.bucketEndAt,
          shard: group.shard,
          errorClass: 'manifest_publish_failed',
          message: error instanceof Error ? error.message : 'unknown_error',
          now,
        });
      } catch (notificationError) {
        log.warn('Logging manifest publish failure notification enqueue failed', {
          tenantKey: group.tenantKey,
          logType: group.logType,
          plane: group.plane,
          error: notificationError instanceof Error ? notificationError.message : 'unknown_error',
        });
      }
    }
  }

  log.debug?.('Logging chunk manifest scheduled publish completed', {
    candidateChunks: rows.length,
    groups: groups.size,
    published,
    skipped,
  });

  return { published, skipped };
}

async function runScheduledCatalogSafeRepair(
  adapter: DatabaseAdapter,
  log: LoggingStorageMaintenanceLogger,
  now: number
): Promise<LoggingStorageMaintenanceResult['catalogRepair']> {
  const repository = new AdminLoggingControlRepository(adapter);
  const findings = await repository.detectCatalogRepairFindings({
    now,
    limit: 500,
    pendingTtlMs: 15 * 60 * 1000,
  });
  const safeFindings = findings.filter((finding) => finding.safety === 'safe_auto');
  const result =
    safeFindings.length > 0
      ? await repository.applySafeCatalogRepairs(safeFindings, now)
      : { applied: [], skipped: [] };

  log.debug?.('Logging catalog scheduled safe repair completed', {
    findings: findings.length,
    applied: result.applied.length,
    skipped: result.skipped.length,
  });

  return {
    findings: findings.length,
    applied: result.applied.length,
    skipped: result.skipped.length,
  };
}

function rewrapCandidateKey(input: {
  keyRegistryId: string;
  fromVersion: number;
  toVersion: number;
  objectCatalogId: string;
}): string {
  return [
    input.keyRegistryId,
    String(input.fromVersion),
    String(input.toVersion),
    input.objectCatalogId,
  ].join(':');
}

async function loadExistingRewrapJobKeys(
  adapter: DatabaseAdapter,
  candidates: readonly RewrapCandidateRow[]
): Promise<Map<string, RewrapJobRow>> {
  if (candidates.length === 0) {
    return new Map();
  }

  const rows = await adapter.query<RewrapJobRow>(
    `SELECT id, key_registry_id, from_version, to_version, status, metadata
     FROM logging_rewrap_jobs
     WHERE status IN ('queued', 'running', 'succeeded', 'failed', 'skipped')
     ORDER BY created_at DESC
     LIMIT ?`,
    [1000]
  );
  const candidateKeys = new Set(
    candidates.map((candidate) =>
      rewrapCandidateKey({
        keyRegistryId: candidate.key_registry_id,
        fromVersion: toInteger(candidate.from_version),
        toVersion: toInteger(candidate.active_version),
        objectCatalogId: candidate.object_catalog_id,
      })
    )
  );
  const existing = new Map<string, RewrapJobRow>();
  for (const row of rows) {
    const metadata = parseMetadata(row.metadata);
    const objectCatalogId =
      typeof metadata.object_catalog_id === 'string' ? metadata.object_catalog_id : null;
    if (!objectCatalogId) {
      continue;
    }
    const key = rewrapCandidateKey({
      keyRegistryId: row.key_registry_id,
      fromVersion: toInteger(row.from_version),
      toVersion: toInteger(row.to_version),
      objectCatalogId,
    });
    if (candidateKeys.has(key)) {
      existing.set(key, row);
    }
  }
  return existing;
}

async function recordRewrapDispatchEvent(input: {
  adapter: DatabaseAdapter;
  now: number;
  candidate: RewrapCandidateRow;
  jobId: string;
  status: 'queued' | 'retrying';
  errorClass?: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  await input.adapter.execute(
    `INSERT INTO logging_delivery_events (
      id, tenant_key, destination_id, log_type, plane, lane, status, attempt_count,
      error_class, object_catalog_id, created_at, updated_at, metadata
    ) VALUES (?, ?, ?, ?, ?, 'bulk', ?, 0, ?, ?, ?, ?, ?)`,
    [
      createLoggingId('lde', input.now),
      input.candidate.tenant_key,
      `rewrap:${input.jobId}`,
      input.candidate.log_type,
      input.candidate.plane,
      input.status,
      input.errorClass ?? null,
      input.candidate.object_catalog_id,
      input.now,
      input.now,
      JSON.stringify(input.metadata),
    ]
  );
}

async function dispatchRewrapJob(input: {
  env: Env;
  adapter: DatabaseAdapter;
  candidate: RewrapCandidateRow;
  jobId: string;
  now: number;
}): Promise<boolean> {
  const payload = {
    payload_type: 'rewrap_chunk' as const,
    schema_version: 1 as const,
    payload_id: createLoggingId('qpl', input.now),
    tenant_key: input.candidate.tenant_key,
    lane: 'bulk' as const,
    created_at: input.now,
    rewrap_job_id: input.jobId,
    object_catalog_id: input.candidate.object_catalog_id,
  };
  const result = await enqueueLoggingDeliveryPayload(
    payload,
    input.env as unknown as Record<string, unknown>
  );
  if (!result.queued) {
    await recordRewrapDispatchEvent({
      adapter: input.adapter,
      now: input.now,
      candidate: input.candidate,
      jobId: input.jobId,
      status: 'retrying',
      errorClass: 'logging_rewrap_delivery_queue_unavailable',
      metadata: {
        payload_id: payload.payload_id,
        attempted_binding_names: result.attemptedBindingNames,
      },
    });
    return false;
  }

  await input.adapter.execute(
    `UPDATE logging_rewrap_jobs
     SET status = 'running', started_at = ?
     WHERE id = ? AND status = 'queued'`,
    [input.now, input.jobId]
  );
  await recordRewrapDispatchEvent({
    adapter: input.adapter,
    now: input.now,
    candidate: input.candidate,
    jobId: input.jobId,
    status: 'queued',
    metadata: {
      payload_id: payload.payload_id,
      binding_name: result.bindingName,
      fallback_used: result.fallbackUsed,
    },
  });
  return true;
}

async function runScheduledRewrapDispatch(
  env: Env,
  adapter: DatabaseAdapter,
  log: LoggingStorageMaintenanceLogger,
  now: number
): Promise<LoggingStorageMaintenanceResult['rewrap']> {
  const candidates = await adapter.query<RewrapCandidateRow>(
    `SELECT kr.id AS key_registry_id, kr.tenant_key, kr.surface, kr.log_type, kr.plane,
            kr.active_version, kv.version AS from_version, kv.status AS key_version_status,
            loc.id AS object_catalog_id, loc.object_key, loc.record_count, loc.committed_at
     FROM logging_key_registry kr
     INNER JOIN logging_key_versions kv ON kv.key_registry_id = kr.id
     INNER JOIN log_object_catalog loc
       ON loc.tenant_key = kr.tenant_key
      AND loc.log_type = kr.log_type
      AND loc.plane = kr.plane
      AND COALESCE(loc.surface, '') = COALESCE(kr.surface, '')
      AND loc.key_version = kv.version
     WHERE kr.status IN ('active', 'rotating', 'stale', 'compromised')
       AND kv.status IN ('rewrap_required', 'compromised')
       AND kv.version < kr.active_version
       AND loc.status = 'committed'
       AND loc.object_kind = 'chunk'
       AND loc.encryption_scope IS NOT NULL
       AND loc.compression IS NOT NULL
     ORDER BY CASE kv.status WHEN 'compromised' THEN 0 ELSE 1 END,
              loc.committed_at ASC,
              loc.id ASC
     LIMIT ?`,
    [200]
  );
  const existingJobs = await loadExistingRewrapJobKeys(adapter, candidates);
  const queue = new SqlLoggingRewrapJobQueue(adapter);

  let jobsCreated = 0;
  let dispatched = 0;
  let queueUnavailable = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    const fromVersion = toInteger(candidate.from_version);
    const toVersion = toInteger(candidate.active_version);
    const candidateKey = rewrapCandidateKey({
      keyRegistryId: candidate.key_registry_id,
      fromVersion,
      toVersion,
      objectCatalogId: candidate.object_catalog_id,
    });
    const existing = existingJobs.get(candidateKey);
    if (existing && existing.status !== 'queued') {
      skipped += 1;
      continue;
    }

    const priority = classifyLoggingRewrapPriority({
      logType: candidate.log_type,
      plane: candidate.plane,
      compromised: candidate.key_version_status === 'compromised',
      critical: candidate.log_type === 'admin_audit' || candidate.log_type === 'audit',
    });
    const job =
      existing ??
      (await queue.enqueue({
        keyRegistryId: candidate.key_registry_id,
        fromVersion,
        toVersion,
        priority: priority.priority,
        metadata: {
          object_catalog_id: candidate.object_catalog_id,
          object_key: candidate.object_key,
          tenant_key: candidate.tenant_key,
          log_type: candidate.log_type,
          plane: candidate.plane,
          surface: candidate.surface,
          reason: priority.reason,
          record_count: toInteger(candidate.record_count),
        },
        now,
      }));
    if (!existing) {
      jobsCreated += 1;
    }

    const queued = await dispatchRewrapJob({
      env,
      adapter,
      candidate,
      jobId: job.id,
      now,
    });
    if (queued) {
      dispatched += 1;
    } else {
      queueUnavailable += 1;
    }
  }

  log.debug?.('Logging key rewrap dispatch completed', {
    candidates: candidates.length,
    jobsCreated,
    dispatched,
    queueUnavailable,
    skipped,
  });

  return {
    candidates: candidates.length,
    jobsCreated,
    dispatched,
    queueUnavailable,
    skipped,
  };
}

function getLoggingMessagePayloadBucket(env: Env): R2Bucket | null {
  return env.AUDIT_ARCHIVE ?? null;
}

type LoggingMessagePayloadReadResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'bucket_unavailable' | 'not_found' | 'too_large' | 'malformed_json' };

async function readLoggingMessagePayload(
  env: Env,
  objectRef: string
): Promise<LoggingMessagePayloadReadResult> {
  const bucket = getLoggingMessagePayloadBucket(env);
  if (!bucket) {
    return { ok: false, reason: 'bucket_unavailable' };
  }
  const object = await bucket.get(objectRef);
  if (!object) {
    return { ok: false, reason: 'not_found' };
  }
  let text: string;
  try {
    text = await readR2ObjectTextWithLimit(object, LOGGING_MESSAGE_PAYLOAD_MAX_BYTES);
  } catch {
    return { ok: false, reason: 'too_large' };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: 'malformed_json' };
  }
}

function computeMessageJobRetryBackoffMs(job: LoggingMessageJobRecord): number {
  const policyBackoff = job.errorClass
    ? job.attemptPolicy?.errorClassBackoffMs?.[job.errorClass]
    : undefined;
  if (typeof policyBackoff === 'number' && policyBackoff > 0) {
    return policyBackoff;
  }
  if (typeof job.attemptPolicy?.backoffMs === 'number' && job.attemptPolicy.backoffMs > 0) {
    return job.attemptPolicy.backoffMs;
  }
  if (job.lane === 'critical') {
    return 30 * 1000;
  }
  if (job.lane === 'bulk') {
    return 15 * 60 * 1000;
  }
  return 5 * 60 * 1000;
}

function getLoggingExportBucket(env: Env): R2Bucket | null {
  return env.EXPORT_ARTIFACTS ?? null;
}

function getCatalogObjectBucketForExport(
  env: Env,
  row: {
    object_kind: string | null;
    plane: LogPlane;
  }
): R2Bucket | null {
  if (row.object_kind === 'export_artifact') {
    return getLoggingExportBucket(env);
  }
  if (row.plane === 'sensitive_detail') {
    return env.SENSITIVE_DETAILS ?? null;
  }
  if (row.plane === 'diagnostic_detail') {
    return env.DIAGNOSTIC_LOGS ?? null;
  }
  return env.AUDIT_ARCHIVE ?? null;
}

function isLogType(value: unknown): value is LogType {
  return typeof value === 'string' && (LOG_TYPES as readonly string[]).includes(value);
}

function isLogPlane(value: unknown): value is LogPlane {
  return typeof value === 'string' && (LOG_PLANES as readonly string[]).includes(value);
}

function readOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function readExportBuildFilters(value: unknown): LoggingExportBuildFilters | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const source = record.source === 'record_index' ? 'record_index' : 'catalog';
  const logType =
    record.log_type === null || record.log_type === undefined ? null : record.log_type;
  const plane = record.plane === null || record.plane === undefined ? null : record.plane;
  if (logType !== null && !isLogType(logType)) {
    return null;
  }
  if (plane !== null && !isLogPlane(plane)) {
    return null;
  }
  return {
    tenant_key: typeof record.tenant_key === 'string' ? record.tenant_key : null,
    log_type: logType,
    plane,
    source,
    time_start: readOptionalNumber(record.time_start),
    time_end: readOptionalNumber(record.time_end),
    limit:
      typeof record.limit === 'number' && Number.isFinite(record.limit) && record.limit > 0
        ? Math.min(Math.trunc(record.limit), 5000)
        : 1000,
    include_payload: record.include_payload === true,
    detail_scope: record.detail_scope === 'full' ? 'full' : 'none',
  };
}

function logTypeForSensitiveDetailObjectClass(objectClass: ObjectClass): LogType {
  switch (objectClass) {
    case 'admin_audit_detail':
    case 'approval_transport_detail':
      return 'admin_audit';
    case 'webhook_delivery_payload':
      return 'webhook';
    case 'operational_log_detail':
      return 'operational';
    default:
      return 'operational';
  }
}

function surfaceForSensitiveDetailObjectClass(objectClass: ObjectClass): string {
  switch (objectClass) {
    case 'admin_audit_detail':
      return 'admin_audit';
    case 'webhook_delivery_payload':
      return 'webhook';
    case 'operational_log_detail':
      return 'operational';
    case 'approval_transport_detail':
      return 'approval_transport';
    default:
      return objectClass;
  }
}

function sensitiveDetailObjectClassesForLogType(logType: LogType | null): ObjectClass[] {
  if (!logType) {
    return [
      'admin_audit_detail',
      'approval_transport_detail',
      'webhook_delivery_payload',
      'operational_log_detail',
    ];
  }
  switch (logType) {
    case 'admin_audit':
      return ['admin_audit_detail', 'approval_transport_detail'];
    case 'webhook':
      return ['webhook_delivery_payload'];
    case 'operational':
      return ['operational_log_detail'];
    default:
      return [];
  }
}

function csvCell(value: unknown): string {
  const rawText =
    value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  const trimmed = rawText.trimStart();
  const text =
    trimmed.startsWith('=') ||
    trimmed.startsWith('+') ||
    trimmed.startsWith('@') ||
    /^-\D/.test(trimmed) ||
    /^[\t\r]/.test(rawText)
      ? `'${rawText}`
      : rawText;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function rowsToExportArtifact(rows: Record<string, unknown>[], format: 'jsonl' | 'csv'): string {
  if (format === 'jsonl') {
    return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
  }
  const preferredHeaders = [
    'id',
    'record_id',
    'tenant_key',
    'log_type',
    'plane',
    'surface',
    'object_catalog_id',
    'object_class',
    'chunk_id',
    'object_key',
    'object_kind',
    'bucket_binding',
    'content_encoding',
    'compression',
    'encryption_scope',
    'key_version',
    'status',
    'line_number',
    'block_offset',
    'block_length',
    'record_offset',
    'record_length',
    'record_payload',
    'record_payload_error',
    'event_at',
    'index_profile',
    'indexed_fields',
    'record_count',
    'byte_count',
    'checksum_sha256',
    'created_at',
    'committed_at',
  ];
  const extraHeaders = Array.from(
    new Set(
      rows.flatMap((row) => Object.keys(row)).filter((key) => !preferredHeaders.includes(key))
    )
  ).sort();
  const headers = [
    ...preferredHeaders.filter((header) => rows.some((row) => header in row)),
    ...extraHeaders,
  ];
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(',')),
  ].join('\n');
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function uint16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

function dosTimestamp(timestamp: number): { time: number; date: number } {
  const date = new Date(timestamp);
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time:
      (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

function buildStoredZip(files: Array<{ name: string; body: Uint8Array }>, now: number): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  const { time, date } = dosTimestamp(now);
  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const checksum = crc32(file.body);
    const local = concatBytes([
      uint32(0x04034b50),
      uint16(20),
      uint16(0),
      uint16(0),
      uint16(time),
      uint16(date),
      uint32(checksum),
      uint32(file.body.byteLength),
      uint32(file.body.byteLength),
      uint16(nameBytes.byteLength),
      uint16(0),
      nameBytes,
      file.body,
    ]);
    localParts.push(local);
    centralParts.push(
      concatBytes([
        uint32(0x02014b50),
        uint16(20),
        uint16(20),
        uint16(0),
        uint16(0),
        uint16(time),
        uint16(date),
        uint32(checksum),
        uint32(file.body.byteLength),
        uint32(file.body.byteLength),
        uint16(nameBytes.byteLength),
        uint16(0),
        uint16(0),
        uint16(0),
        uint16(0),
        uint32(0),
        uint32(offset),
        nameBytes,
      ])
    );
    offset += local.byteLength;
  }
  const centralDirectory = concatBytes(centralParts);
  return concatBytes([
    ...localParts,
    centralDirectory,
    uint32(0x06054b50),
    uint16(0),
    uint16(0),
    uint16(files.length),
    uint16(files.length),
    uint32(centralDirectory.byteLength),
    uint32(offset),
    uint16(0),
  ]);
}

async function projectRowsForExportArtifact(
  adapter: DatabaseAdapter,
  env: Env,
  rows: Record<string, unknown>[],
  filters: LoggingExportBuildFilters
): Promise<Record<string, unknown>[]> {
  if (
    filters.source !== 'record_index' ||
    !filters.include_payload ||
    filters.plane === 'sensitive_detail'
  ) {
    return rows;
  }
  const tenantIdByKey = new Map<string, string | null>();
  const resolveTenantId = async (tenantKey: string): Promise<string | null> => {
    if (tenantIdByKey.has(tenantKey)) {
      return tenantIdByKey.get(tenantKey) ?? null;
    }
    const row = await adapter.queryOne<{ id: string }>(
      `SELECT id FROM tenants WHERE tenant_key = ? LIMIT 1`,
      [tenantKey]
    );
    tenantIdByKey.set(tenantKey, row?.id ?? null);
    return row?.id ?? null;
  };
  return Promise.all(
    rows.map(async (row) => {
      const payload = row.record_payload;
      if (!isArchiveLogRecordV1(payload)) {
        return row;
      }
      const projection = projectArchiveLogRecordForExportV1(payload, {
        object_catalog_id: stringOrNull(row.object_catalog_id),
        chunk_id: stringOrNull(row.chunk_id),
        object_key: stringOrNull(row.object_key),
        line_number: integerOrNull(row.line_number),
        record_offset: integerOrNull(row.record_offset),
        record_length: integerOrNull(row.record_length),
        index_profile: stringOrNull(row.index_profile),
      }) as unknown as Record<string, unknown>;
      if (filters.detail_scope !== 'full' || !payload.detail_ref?.object_catalog_id) {
        return projection;
      }
      const objectClass = payload.detail_ref.class;
      if (!isObjectClass(objectClass)) {
        return { ...projection, detail_payload_error: 'unsupported_detail_class' };
      }
      const tenantId = await resolveTenantId(payload.tenant_key);
      if (!tenantId) {
        return { ...projection, detail_payload_error: 'tenant_key_not_resolved' };
      }
      try {
        const detailPayload = await loadChunkedSensitiveDetailJson(adapter, env, {
          tenantId,
          objectCatalogId: payload.detail_ref.object_catalog_id,
          expectedClass: objectClass,
        });
        return detailPayload === null
          ? { ...projection, detail_payload_error: 'detail_payload_unavailable' }
          : { ...projection, detail_payload: detailPayload };
      } catch {
        return { ...projection, detail_payload_error: 'detail_payload_unavailable' };
      }
    })
  );
}

async function sha256HexText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256HexBytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', value);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('object_encryption_root_key_invalid');
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }
  return bytes;
}

async function deriveExportLogChunkEncryptionKey(input: {
  rootKeyHex: string;
  tenantKey: string;
  logType: LogType;
  plane: LogPlane;
  keyVersion: number;
}): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    'raw',
    hexToBytes(input.rootKeyHex),
    'HKDF',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('authrim-log-chunk-archive-encryption'),
      info: new TextEncoder().encode(
        `${input.tenantKey}:${input.logType}:${input.plane}:v${input.keyVersion}`
      ),
    },
    material,
    256
  );
  return new Uint8Array(bits);
}

function buildExportChunkRecordIndex(row: LoggingExportRecordIndexRow): LogChunkRecordIndexRow {
  return {
    recordId: row.record_id,
    tenantKey: row.tenant_key,
    logType: row.log_type,
    plane: row.plane,
    surface: row.surface ?? undefined,
    objectCatalogId: row.object_catalog_id,
    chunkId: row.chunk_id,
    lineNumber: toInteger(row.line_number),
    blockOffset: row.block_offset === null ? null : toInteger(row.block_offset),
    blockLength: row.block_length === null ? null : toInteger(row.block_length),
    recordOffset: toInteger(row.record_offset),
    recordLength: toInteger(row.record_length),
    eventAt: toInteger(row.event_at),
    indexProfile: row.index_profile,
    indexedFields: parseMetadata(row.indexed_fields),
    status: row.status === 'deleted' || row.status === 'pending' ? row.status : 'committed',
    createdAt: toInteger(row.created_at),
  };
}

function normalizeRecordPayloadExportError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message.slice(0, 128)
    : 'record_payload_decode_failed';
}

async function readR2ObjectBytes(object: R2ObjectBody): Promise<Uint8Array> {
  if (typeof object.size === 'number' && object.size > LOGGING_EXPORT_CHUNK_OBJECT_MAX_BYTES) {
    throw new Error('logging_export_chunk_object_too_large');
  }

  if (object.body) {
    const reader = object.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        totalBytes += value.byteLength;
        if (totalBytes > LOGGING_EXPORT_CHUNK_OBJECT_MAX_BYTES) {
          throw new Error('logging_export_chunk_object_too_large');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength > LOGGING_EXPORT_CHUNK_OBJECT_MAX_BYTES) {
    throw new Error('logging_export_chunk_object_too_large');
  }
  return bytes;
}

async function expandRecordIndexExportRows(input: {
  env: Env;
  rows: LoggingExportRecordIndexRow[];
}): Promise<Record<string, unknown>[]> {
  const objectCache = new Map<string, Uint8Array>();
  const { env, rows } = input;
  return Promise.all(
    rows.map(async (row) => {
      try {
        if (!row.object_key) {
          return { ...row, record_payload_error: 'object_key_unavailable' };
        }
        const bucket = getCatalogObjectBucketForExport(env, row);
        if (!bucket) {
          return { ...row, record_payload_error: 'object_bucket_unavailable' };
        }
        const objectByteCount =
          row.object_byte_count === null || row.object_byte_count === undefined
            ? null
            : toInteger(row.object_byte_count);
        if (objectByteCount !== null && objectByteCount > LOGGING_EXPORT_CHUNK_OBJECT_MAX_BYTES) {
          return { ...row, record_payload_error: 'logging_export_chunk_object_too_large' };
        }
        let storedBody = objectCache.get(row.object_key);
        if (!storedBody) {
          const object = await bucket.get(row.object_key);
          if (!object) {
            return { ...row, record_payload_error: 'object_not_found' };
          }
          storedBody = await readR2ObjectBytes(object);
          objectCache.set(row.object_key, storedBody);
        }
        const keyVersion = row.key_version === null ? null : toInteger(row.key_version);
        const encryption =
          row.encryption_scope && keyVersion
            ? env.OBJECT_ENCRYPTION_ROOT_KEY
              ? {
                  keyBytes: await deriveExportLogChunkEncryptionKey({
                    rootKeyHex: env.OBJECT_ENCRYPTION_ROOT_KEY,
                    tenantKey: row.tenant_key,
                    logType: row.log_type,
                    plane: row.plane,
                    keyVersion,
                  }),
                  tenantKey: row.tenant_key,
                  logType: row.log_type,
                  plane: row.plane,
                  objectKey: row.object_key,
                  chunkId: row.chunk_id,
                  expectedEncryptionScope: row.encryption_scope,
                  expectedKeyVersion: keyVersion,
                }
              : undefined
            : undefined;
        if (row.encryption_scope && !encryption) {
          return { ...row, record_payload_error: 'object_encryption_root_key_unavailable' };
        }
        const recordPayload = await decodeStoredLogChunkRecord({
          storedBody,
          compression: row.compression ?? 'none',
          encryption,
          recordIndex: buildExportChunkRecordIndex(row),
        });
        return { ...row, record_payload: recordPayload };
      } catch (error) {
        return { ...row, record_payload_error: normalizeRecordPayloadExportError(error) };
      }
    })
  );
}

async function queryExportBuildRows(input: {
  env: Env;
  adapter: DatabaseAdapter;
  filters: LoggingExportBuildFilters;
  snapshotCutoffAt: number;
  offset?: number;
}): Promise<Record<string, unknown>[]> {
  const { env, adapter, filters, snapshotCutoffAt } = input;
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  if (filters.plane === 'sensitive_detail') {
    const objectClasses = sensitiveDetailObjectClassesForLogType(filters.log_type);
    if (objectClasses.length === 0) {
      return [];
    }
    const conditions = [
      'sdci.deleted_at IS NULL',
      'oc.deleted_at IS NULL',
      'sdci.created_at <= ?',
      `sdci.object_class IN (${objectClasses.map(() => '?').join(', ')})`,
    ];
    const params: unknown[] = [snapshotCutoffAt, ...objectClasses];
    if (filters.tenant_key) {
      conditions.push('t.tenant_key = ?');
      params.push(filters.tenant_key);
    }
    if (filters.time_start !== null) {
      conditions.push('sdci.created_at >= ?');
      params.push(filters.time_start);
    }
    if (filters.time_end !== null) {
      conditions.push('sdci.created_at <= ?');
      params.push(filters.time_end);
    }
    const rows = await adapter.query<Record<string, unknown>>(
      `SELECT oc.public_artifact_id AS record_id,
              sdci.tenant_id,
              t.tenant_key AS tenant_key,
              sdci.catalog_id AS object_catalog_id,
              sdci.object_class,
              sdci.object_key,
              'chunk' AS object_kind,
              sdci.bucket_binding,
              sdci.content_encoding,
              sdci.line_number,
              sdci.key_version,
              sdci.checksum_sha256,
              sdci.created_at
       FROM sensitive_detail_chunk_index sdci
       INNER JOIN object_catalog oc
         ON oc.id = sdci.catalog_id
        AND oc.tenant_id = sdci.tenant_id
        AND oc.object_class = sdci.object_class
       LEFT JOIN tenants t ON t.id = sdci.tenant_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY sdci.created_at ASC, sdci.catalog_id ASC
       LIMIT ? OFFSET ?`,
      [...params, filters.limit, offset]
    );
    return Promise.all(
      rows.map(async (row) => {
        const objectClass = row.object_class;
        if (typeof objectClass !== 'string' || !isObjectClass(objectClass)) {
          return { ...row, record_payload_error: 'unsupported_sensitive_detail_object_class' };
        }
        const base = {
          ...row,
          object_class: objectClass,
          log_type: logTypeForSensitiveDetailObjectClass(objectClass),
          plane: 'sensitive_detail',
          surface: surfaceForSensitiveDetailObjectClass(objectClass),
          status: 'committed',
          tenant_id: undefined,
        };
        if (!filters.include_payload) {
          const { tenant_id: _tenantId, ...sanitized } = base;
          return sanitized;
        }
        try {
          const payload = await loadChunkedSensitiveDetailJson(adapter, env, {
            tenantId: String(row.tenant_id),
            objectCatalogId: String(row.object_catalog_id),
            expectedClass: objectClass,
          });
          const { tenant_id: _tenantId, ...sanitized } = base;
          return payload === null
            ? { ...sanitized, record_payload_error: 'record_payload_unavailable' }
            : { ...sanitized, record_payload: payload };
        } catch {
          const { tenant_id: _tenantId, ...sanitized } = base;
          return { ...sanitized, record_payload_error: 'record_payload_unavailable' };
        }
      })
    );
  }

  const timeColumn = filters.source === 'record_index' ? 'event_at' : 'created_at';
  const conditions = ['status = ?', `${timeColumn} <= ?`];
  const params: unknown[] = ['committed', snapshotCutoffAt];
  if (filters.tenant_key) {
    conditions.push('tenant_key = ?');
    params.push(filters.tenant_key);
  }
  if (filters.log_type) {
    conditions.push('log_type = ?');
    params.push(filters.log_type);
  }
  if (filters.plane) {
    conditions.push('plane = ?');
    params.push(filters.plane);
  }
  if (filters.time_start !== null) {
    conditions.push(`${timeColumn} >= ?`);
    params.push(filters.time_start);
  }
  if (filters.time_end !== null) {
    conditions.push(`${timeColumn} <= ?`);
    params.push(filters.time_end);
  }

  if (filters.source === 'record_index') {
    const rows = await adapter.query<LoggingExportRecordIndexRow>(
      `SELECT idx.record_id, idx.tenant_key, idx.log_type, idx.plane, idx.surface,
              idx.object_catalog_id, idx.chunk_id, catalog.object_key, catalog.object_kind,
              catalog.byte_count AS object_byte_count,
              catalog.compression, catalog.encryption_scope, catalog.key_version,
              idx.line_number, idx.block_offset, idx.block_length,
              idx.record_offset, idx.record_length, idx.event_at, idx.index_profile,
              idx.indexed_fields, idx.status, idx.created_at
       FROM log_chunk_record_index idx
       LEFT JOIN log_object_catalog catalog ON catalog.id = idx.object_catalog_id
       WHERE ${conditions.map((condition) => `idx.${condition}`).join(' AND ')}
       ORDER BY idx.event_at ASC, idx.record_id ASC
       LIMIT ? OFFSET ?`,
      [...params, filters.limit, offset]
    );
    return filters.include_payload ? expandRecordIndexExportRows({ env, rows }) : rows;
  }

  return adapter.query<Record<string, unknown>>(
    `SELECT id, tenant_key, log_type, plane, surface, object_key, object_kind, status,
            record_count, byte_count, checksum_sha256, created_at, committed_at
     FROM log_object_catalog
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at ASC, id ASC
     LIMIT ? OFFSET ?`,
    [...params, filters.limit, offset]
  );
}

async function recordExportBuildDeliveryEvent(
  adapter: DatabaseAdapter,
  input: {
    exportId: string;
    filters: LoggingExportBuildFilters;
    format: 'jsonl' | 'csv' | 'zip';
    artifactObjectRef: string | null;
    manifestObjectRef: string;
    checksumSha256: string;
    recordCount: number;
    byteCount: number;
    now: number;
  }
): Promise<void> {
  if (!input.filters.tenant_key || !input.filters.log_type || !input.filters.plane) {
    return;
  }
  const store = new SqlLoggingDeliveryEventStore(adapter);
  await store.insertEvent({
    tenantKey: input.filters.tenant_key,
    destinationId: 'export_artifact',
    logType: input.filters.log_type,
    plane: input.filters.plane,
    lane: 'bulk',
    status: 'delivered',
    now: input.now,
    metadata: {
      event_type: 'logging_export.completed',
      export_id: input.exportId,
      format: input.format,
      source: input.filters.source,
      artifact_object_ref: input.artifactObjectRef,
      manifest_object_ref: input.manifestObjectRef,
      checksum_sha256: input.checksumSha256,
      record_count: input.recordCount,
      byte_count: input.byteCount,
    },
  });
}

function exportPartObjectRef(input: {
  exportJobId: string;
  partitionIndex: number;
  format: 'jsonl' | 'csv' | 'zip';
}): string {
  const extension = input.format === 'csv' ? 'csv' : input.format === 'zip' ? 'zip' : 'jsonl';
  return `logging-exports/v1/${input.exportJobId}/parts/part-${String(
    input.partitionIndex
  ).padStart(5, '0')}.${extension}`;
}

function exportManifestObjectRef(exportJobId: string): string {
  return `logging-exports/v1/${exportJobId}/manifest.json`;
}

function getExportBuildPartSize(payload: ExportBuildMessagePayload): number {
  if (
    typeof payload.part_size === 'number' &&
    Number.isInteger(payload.part_size) &&
    payload.part_size > 0
  ) {
    return Math.min(payload.part_size, EXPORT_BUILD_PART_SIZE);
  }
  return EXPORT_BUILD_PART_SIZE;
}

function getExportBuildPartitionCount(
  filters: LoggingExportBuildFilters,
  payload: ExportBuildMessagePayload
): number {
  const partSize = getExportBuildPartSize(payload);
  return Math.max(1, Math.min(EXPORT_BUILD_MAX_PARTITIONS, Math.ceil(filters.limit / partSize)));
}

async function writeExportBuildPartition(input: {
  env: Env;
  adapter: DatabaseAdapter;
  bucket: R2Bucket;
  exportJobId: string;
  format: 'jsonl' | 'csv' | 'zip';
  filters: LoggingExportBuildFilters;
  snapshotCutoffAt: number;
  partitionIndex: number;
  partSize: number;
}): Promise<{
  objectRef: string;
  checksumSha256: string;
  recordCount: number;
  byteCount: number;
}> {
  const remaining = Math.max(0, input.filters.limit - input.partitionIndex * input.partSize);
  const partitionLimit = Math.min(input.partSize, remaining);
  const rows =
    partitionLimit > 0
      ? await queryExportBuildRows({
          env: input.env,
          adapter: input.adapter,
          filters: { ...input.filters, limit: partitionLimit },
          snapshotCutoffAt: input.snapshotCutoffAt,
          offset: input.partitionIndex * input.partSize,
        })
      : [];
  const artifactRows = await projectRowsForExportArtifact(
    input.adapter,
    input.env,
    rows,
    input.filters
  );
  const artifact =
    input.format === 'zip'
      ? buildStoredZip(
          [
            {
              name: 'records.jsonl',
              body: new TextEncoder().encode(rowsToExportArtifact(artifactRows, 'jsonl')),
            },
            {
              name: 'manifest.json',
              body: new TextEncoder().encode(
                JSON.stringify(
                  {
                    schema_version: 'authrim.log.export.zip_part.v1',
                    export_job_id: input.exportJobId,
                    partition_index: input.partitionIndex,
                    format: 'zip',
                    record_count: rows.length,
                    generated_at: new Date(input.snapshotCutoffAt).toISOString(),
                    filters: input.filters,
                  },
                  null,
                  2
                )
              ),
            },
          ],
          input.snapshotCutoffAt
        )
      : rowsToExportArtifact(artifactRows, input.format);
  const checksum =
    typeof artifact === 'string' ? await sha256HexText(artifact) : await sha256HexBytes(artifact);
  const objectRef = exportPartObjectRef({
    exportJobId: input.exportJobId,
    partitionIndex: input.partitionIndex,
    format: input.format,
  });
  const byteCount =
    typeof artifact === 'string' ? new TextEncoder().encode(artifact).byteLength : artifact.length;
  await input.bucket.put(objectRef, artifact, {
    httpMetadata: {
      contentType:
        input.format === 'csv'
          ? 'text/csv'
          : input.format === 'zip'
            ? 'application/zip'
            : 'application/x-ndjson',
    },
  });
  return {
    objectRef,
    checksumSha256: checksum,
    recordCount: rows.length,
    byteCount,
  };
}

async function runSinglePartExportBuild(input: {
  env: Env;
  adapter: DatabaseAdapter;
  job: LoggingMessageJobRecord;
  payload: ExportBuildMessagePayload;
  exportJob: LoggingExportBuildJobRow;
  filters: LoggingExportBuildFilters;
  bucket: R2Bucket;
  now: number;
}): Promise<void> {
  const { env, adapter, job, payload, exportJob, filters, bucket, now } = input;
  const part = await writeExportBuildPartition({
    env,
    adapter,
    bucket,
    exportJobId: payload.export_job_id,
    format: exportJob.format,
    filters,
    snapshotCutoffAt: payload.snapshot_cutoff_at,
    partitionIndex: 0,
    partSize: filters.limit,
  });
  const manifestObjectRef = exportManifestObjectRef(payload.export_job_id);
  const manifest = {
    schema_version: 1,
    export_id: payload.export_job_id,
    message_job_id: job.id,
    format: exportJob.format,
    snapshot_cutoff_at: payload.snapshot_cutoff_at,
    filters,
    parts: [
      {
        partition_index: 0,
        object_ref: part.objectRef,
        checksum_sha256: part.checksumSha256,
        record_count: part.recordCount,
        byte_count: part.byteCount,
      },
    ],
    checksum_sha256: part.checksumSha256,
    record_count: part.recordCount,
    byte_count: part.byteCount,
    skipped_count: 0,
    pending_count: 0,
    late_arriving_count: 0,
    created_at: now,
    expires_at: exportJob.expires_at,
  };

  await bucket.put(manifestObjectRef, JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });
  await adapter.execute(
    `UPDATE logging_export_jobs
     SET status = ?, artifact_object_ref = ?, manifest_object_ref = ?,
         checksum_sha256 = ?, record_count = ?, byte_count = ?,
         updated_at = ?, completed_at = ?
     WHERE id = ?`,
    [
      'completed',
      part.objectRef,
      manifestObjectRef,
      part.checksumSha256,
      part.recordCount,
      part.byteCount,
      now,
      now,
      payload.export_job_id,
    ]
  );
  await adapter.execute(
    `UPDATE logging_message_export_builds
     SET phase = ?, partition_count = ?, part_object_ref = ?, part_checksum_sha256 = ?,
         part_record_count = ?, part_byte_count = ?, manifest_object_ref = ?,
         final_checksum_sha256 = ?, final_record_count = ?, final_byte_count = ?,
         skipped_count = ?, pending_count = ?, late_arriving_count = ?,
         metadata_json = ?, updated_at = ?
     WHERE message_job_id = ? AND export_job_id = ?`,
    [
      'verify_manifest',
      1,
      part.objectRef,
      part.checksumSha256,
      part.recordCount,
      part.byteCount,
      manifestObjectRef,
      part.checksumSha256,
      part.recordCount,
      part.byteCount,
      0,
      0,
      0,
      JSON.stringify({ manifest }),
      now,
      job.id,
      payload.export_job_id,
    ]
  );
  await recordExportBuildDeliveryEvent(adapter, {
    exportId: payload.export_job_id,
    filters,
    format: exportJob.format,
    artifactObjectRef: part.objectRef,
    manifestObjectRef,
    checksumSha256: part.checksumSha256,
    recordCount: part.recordCount,
    byteCount: part.byteCount,
    now,
  });
}

async function createExportBuildChildJob(input: {
  env: Env;
  adapter: DatabaseAdapter;
  parentJob: LoggingMessageJobRecord;
  parentPayload: ExportBuildMessagePayload;
  phase: 'build_partition' | 'finalize' | 'verify_manifest';
  filters: LoggingExportBuildFilters;
  partitionIndex: number;
  partitionCount: number;
  partSize: number;
  now: number;
  exportExpiresAt: number | null;
}): Promise<void> {
  const bucket = getLoggingMessagePayloadBucket(input.env);
  if (!bucket) {
    throw new Error('message_payload_bucket_unavailable');
  }
  const jobId = createLoggingId('lmj', input.now + input.partitionIndex + 1);
  const payload: ExportBuildMessagePayload = {
    ...input.parentPayload,
    payload_id: createLoggingId('qpl', input.now + input.partitionIndex + 1),
    message_job_id: jobId,
    created_at: input.now,
    phase: input.phase,
    partition_key:
      input.phase === 'build_partition'
        ? `query_page:${input.partitionIndex}`
        : `${input.phase}:${input.partitionCount}`,
    partition_index: input.partitionIndex,
    partition_count: input.partitionCount,
    part_size: input.partSize,
  };
  const payloadWrite = await writeLoggingMessagePayloadToR2({
    bucket,
    jobId,
    payloadType: 'export_build',
    schemaVersion: 1,
    lane: payload.lane,
    criticality: input.parentJob.criticality,
    sourceType: 'payload_object',
    tenantKey: payload.tenant_key ?? input.parentJob.tenantKey,
    payload: { ...payload, filters: input.filters },
    now: input.now,
  });
  const store = new SqlLoggingMessageJobStore(input.adapter);
  const child = await store.createJob({
    id: jobId,
    kind: 'export_build',
    lane: input.parentJob.lane,
    criticality: input.parentJob.criticality,
    priority:
      input.phase === 'build_partition'
        ? input.parentJob.priority
        : Math.max(0, input.parentJob.priority - 1),
    topology: {
      tenantId: input.parentJob.tenantId,
      tenantKey: input.parentJob.tenantKey,
      topologyType: input.parentJob.topologyType,
      databaseBindingRef: input.parentJob.databaseBindingRef,
      connectionRef: input.parentJob.connectionRef,
      topologySnapshotVersion: input.parentJob.topologySnapshotVersion,
      topologyResolvedAt: input.parentJob.topologyResolvedAt ?? input.now,
    },
    scopeType: input.parentJob.scopeType,
    scopeId: input.parentJob.scopeId,
    scopeKey: input.parentJob.scopeKey,
    sourceType: 'payload_object',
    sourceId: input.parentPayload.export_job_id,
    rootJobId: input.parentJob.rootJobId ?? input.parentJob.id,
    parentJobId: input.parentJob.id,
    depth: input.parentJob.depth + 1,
    payloadObjectRef: payloadWrite.objectRef,
    payloadSha256: payloadWrite.sha256,
    payloadType: 'export_build',
    payloadSchemaVersion: 1,
    redactedSummary: payloadWrite.redactedSummary,
    validationSummary: payloadWrite.validationSummary,
    idempotencyKey: [
      'export_build',
      input.parentPayload.export_job_id,
      input.parentJob.id,
      input.phase,
      input.partitionIndex,
    ].join(':'),
    dedupeUntil:
      input.exportExpiresAt ?? input.parentJob.dedupeUntil ?? input.now + 24 * 60 * 60 * 1000,
    notBefore: input.now,
    maxAttempts: input.parentJob.maxAttempts,
    attemptPolicy: input.parentJob.attemptPolicy,
    requestedBy: input.parentPayload.requested_by,
    reason: `logging export ${input.phase}`,
    now: input.now,
    expiresAt: input.exportExpiresAt,
  });
  await input.adapter.execute(
    `INSERT INTO logging_message_export_builds (
      id, message_job_id, export_job_id, phase, partition_strategy, partition_key,
      partition_index, partition_count, snapshot_cutoff_at,
      part_object_ref, part_checksum_sha256, part_record_count, part_byte_count,
      manifest_object_ref, final_checksum_sha256, final_record_count, final_byte_count,
      skipped_count, pending_count, late_arriving_count, cleanup_status,
      metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      createLoggingId('lexp', input.now + input.partitionIndex + 1),
      child.id,
      input.parentPayload.export_job_id,
      input.phase,
      input.parentPayload.partition_strategy ?? 'query_page',
      payload.partition_key ?? null,
      input.partitionIndex,
      input.partitionCount,
      input.parentPayload.snapshot_cutoff_at,
      null,
      null,
      0,
      0,
      null,
      null,
      0,
      0,
      0,
      0,
      0,
      'not_required',
      JSON.stringify({ filters: input.filters, parent_message_job_id: input.parentJob.id }),
      input.now,
      input.now,
    ]
  );
  await enqueueLoggingMessagePayload(payload, input.env as unknown as Record<string, unknown>);
}

async function runPartitionedExportBuildPlan(input: {
  env: Env;
  adapter: DatabaseAdapter;
  job: LoggingMessageJobRecord;
  payload: ExportBuildMessagePayload;
  exportJob: LoggingExportBuildJobRow;
  filters: LoggingExportBuildFilters;
  now: number;
}): Promise<void> {
  const partSize = getExportBuildPartSize(input.payload);
  const partitionCount = getExportBuildPartitionCount(input.filters, input.payload);
  for (let index = 0; index < partitionCount; index += 1) {
    await createExportBuildChildJob({
      env: input.env,
      adapter: input.adapter,
      parentJob: input.job,
      parentPayload: input.payload,
      phase: 'build_partition',
      filters: input.filters,
      partitionIndex: index,
      partitionCount,
      partSize,
      now: input.now,
      exportExpiresAt: input.exportJob.expires_at,
    });
  }
  await createExportBuildChildJob({
    env: input.env,
    adapter: input.adapter,
    parentJob: input.job,
    parentPayload: input.payload,
    phase: 'finalize',
    filters: input.filters,
    partitionIndex: partitionCount,
    partitionCount,
    partSize,
    now: input.now,
    exportExpiresAt: input.exportJob.expires_at,
  });
  await input.adapter.execute(
    `UPDATE logging_message_export_builds
     SET partition_count = ?, metadata_json = ?, updated_at = ?
     WHERE message_job_id = ? AND export_job_id = ?`,
    [
      partitionCount,
      JSON.stringify({
        filters: input.filters,
        part_size: partSize,
        child_jobs_created: partitionCount + 1,
      }),
      input.now,
      input.job.id,
      input.payload.export_job_id,
    ]
  );
}

async function runExportBuildPartition(input: {
  env: Env;
  adapter: DatabaseAdapter;
  job: LoggingMessageJobRecord;
  payload: ExportBuildMessagePayload;
  exportJob: LoggingExportBuildJobRow;
  filters: LoggingExportBuildFilters;
  bucket: R2Bucket;
  now: number;
}): Promise<void> {
  const partitionIndex = input.payload.partition_index ?? 0;
  const partitionCount = input.payload.partition_count ?? 1;
  const partSize = getExportBuildPartSize(input.payload);
  const part = await writeExportBuildPartition({
    env: input.env,
    adapter: input.adapter,
    bucket: input.bucket,
    exportJobId: input.payload.export_job_id,
    format: input.exportJob.format,
    filters: input.filters,
    snapshotCutoffAt: input.payload.snapshot_cutoff_at,
    partitionIndex,
    partSize,
  });
  await input.adapter.execute(
    `UPDATE logging_message_export_builds
     SET partition_count = ?, part_object_ref = ?, part_checksum_sha256 = ?,
         part_record_count = ?, part_byte_count = ?, metadata_json = ?, updated_at = ?
     WHERE message_job_id = ? AND export_job_id = ?`,
    [
      partitionCount,
      part.objectRef,
      part.checksumSha256,
      part.recordCount,
      part.byteCount,
      JSON.stringify({
        filters: input.filters,
        partition_index: partitionIndex,
        part_size: partSize,
      }),
      input.now,
      input.job.id,
      input.payload.export_job_id,
    ]
  );
}

async function runFinalizeExportBuild(input: {
  env: Env;
  adapter: DatabaseAdapter;
  job: LoggingMessageJobRecord;
  payload: ExportBuildMessagePayload;
  exportJob: LoggingExportBuildJobRow;
  filters: LoggingExportBuildFilters;
  bucket: R2Bucket;
  now: number;
}): Promise<void> {
  const expectedPartitions = input.payload.partition_count ?? 1;
  const parts = await input.adapter.query<LoggingExportBuildPartRow>(
    `SELECT partition_index, part_object_ref, part_checksum_sha256,
            part_record_count, part_byte_count
     FROM logging_message_export_builds
     WHERE export_job_id = ?
       AND phase = ?
       AND part_object_ref IS NOT NULL
     ORDER BY partition_index ASC`,
    [input.payload.export_job_id, 'build_partition']
  );
  if (parts.length < expectedPartitions) {
    throw new Error(`export_build_parts_pending:${parts.length}/${expectedPartitions}`);
  }
  const selectedParts = parts.slice(0, expectedPartitions);
  const checksum = await sha256HexText(
    selectedParts
      .map((part) => `${toInteger(part.partition_index)}:${part.part_checksum_sha256}`)
      .join('\n')
  );
  const recordCount = selectedParts.reduce(
    (total, part) => total + toInteger(part.part_record_count),
    0
  );
  const byteCount = selectedParts.reduce(
    (total, part) => total + toInteger(part.part_byte_count),
    0
  );
  const manifestObjectRef = exportManifestObjectRef(input.payload.export_job_id);
  const manifest = {
    schema_version: 1,
    export_id: input.payload.export_job_id,
    message_job_id: input.job.id,
    format: input.exportJob.format,
    snapshot_cutoff_at: input.payload.snapshot_cutoff_at,
    filters: input.filters,
    parts: selectedParts.map((part) => ({
      partition_index: toInteger(part.partition_index),
      object_ref: part.part_object_ref,
      checksum_sha256: part.part_checksum_sha256,
      record_count: toInteger(part.part_record_count),
      byte_count: toInteger(part.part_byte_count),
    })),
    checksum_sha256: checksum,
    record_count: recordCount,
    byte_count: byteCount,
    skipped_count: 0,
    pending_count: 0,
    late_arriving_count: 0,
    created_at: input.now,
    expires_at: input.exportJob.expires_at,
  };
  await input.bucket.put(manifestObjectRef, JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });
  await input.adapter.execute(
    `UPDATE logging_export_jobs
     SET status = ?, artifact_object_ref = ?, manifest_object_ref = ?,
         checksum_sha256 = ?, record_count = ?, byte_count = ?,
         updated_at = ?, completed_at = ?
     WHERE id = ?`,
    [
      'running',
      null,
      manifestObjectRef,
      checksum,
      recordCount,
      byteCount,
      input.now,
      null,
      input.payload.export_job_id,
    ]
  );
  await input.adapter.execute(
    `UPDATE logging_message_export_builds
     SET phase = ?, partition_count = ?, manifest_object_ref = ?,
         final_checksum_sha256 = ?, final_record_count = ?, final_byte_count = ?,
         skipped_count = ?, pending_count = ?, late_arriving_count = ?,
         metadata_json = ?, updated_at = ?
     WHERE message_job_id = ? AND export_job_id = ?`,
    [
      'finalize',
      expectedPartitions,
      manifestObjectRef,
      checksum,
      recordCount,
      byteCount,
      0,
      0,
      0,
      JSON.stringify({ manifest }),
      input.now,
      input.job.id,
      input.payload.export_job_id,
    ]
  );
  await createExportBuildChildJob({
    env: input.env,
    adapter: input.adapter,
    parentJob: input.job,
    parentPayload: input.payload,
    phase: 'verify_manifest',
    filters: input.filters,
    partitionIndex: expectedPartitions + 1,
    partitionCount: expectedPartitions,
    partSize: getExportBuildPartSize(input.payload),
    now: input.now,
    exportExpiresAt: input.exportJob.expires_at,
  });
}

async function readExportManifest(input: {
  bucket: R2Bucket;
  manifestObjectRef: string | null;
}): Promise<{
  parts: Array<{ object_ref?: unknown; record_count?: unknown; byte_count?: unknown }>;
  checksum_sha256?: unknown;
  record_count?: unknown;
  byte_count?: unknown;
}> {
  if (!input.manifestObjectRef) {
    throw new Error('export_manifest_ref_missing');
  }
  const object = await input.bucket.get(input.manifestObjectRef);
  if (!object) {
    throw new Error('export_manifest_missing');
  }
  let manifestText: string;
  try {
    manifestText = await readR2ObjectTextWithLimit(object, LOGGING_EXPORT_MANIFEST_MAX_BYTES);
  } catch {
    throw new Error('export_manifest_too_large');
  }
  const manifest = JSON.parse(manifestText) as {
    parts?: Array<{ object_ref?: unknown; record_count?: unknown; byte_count?: unknown }>;
    checksum_sha256?: unknown;
    record_count?: unknown;
    byte_count?: unknown;
  };
  if (!Array.isArray(manifest.parts)) {
    throw new Error('export_manifest_malformed');
  }
  return { ...manifest, parts: manifest.parts };
}

async function exportObjectExists(bucket: R2Bucket, objectRef: string): Promise<boolean> {
  if (typeof bucket.head === 'function') {
    return !!(await bucket.head(objectRef));
  }
  return !!(await bucket.get(objectRef));
}

async function runVerifyExportManifest(input: {
  adapter: DatabaseAdapter;
  job: LoggingMessageJobRecord;
  payload: ExportBuildMessagePayload;
  exportJob: LoggingExportBuildJobRow;
  filters: LoggingExportBuildFilters;
  bucket: R2Bucket;
  now: number;
}): Promise<void> {
  const manifest = await readExportManifest({
    bucket: input.bucket,
    manifestObjectRef: input.exportJob.manifest_object_ref,
  });
  const partRefs = manifest.parts
    .map((part) => part.object_ref)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (partRefs.length === 0) {
    throw new Error('export_manifest_parts_missing');
  }
  for (const partRef of partRefs) {
    if (!(await exportObjectExists(input.bucket, partRef))) {
      throw new Error(`export_part_missing:${partRef}`);
    }
  }
  const checksum =
    typeof manifest.checksum_sha256 === 'string'
      ? manifest.checksum_sha256
      : (input.exportJob.checksum_sha256 ?? 'unknown');
  const recordCount =
    typeof manifest.record_count === 'number'
      ? Math.trunc(manifest.record_count)
      : toInteger(input.exportJob.record_count);
  const byteCount =
    typeof manifest.byte_count === 'number'
      ? Math.trunc(manifest.byte_count)
      : toInteger(input.exportJob.byte_count);

  await input.adapter.execute(
    `UPDATE logging_export_jobs
     SET status = ?, checksum_sha256 = ?, record_count = ?, byte_count = ?,
         updated_at = ?, completed_at = ?
     WHERE id = ?`,
    [
      'completed',
      checksum,
      recordCount,
      byteCount,
      input.now,
      input.now,
      input.payload.export_job_id,
    ]
  );
  await input.adapter.execute(
    `UPDATE logging_message_export_builds
     SET phase = ?, manifest_object_ref = ?, final_checksum_sha256 = ?,
         final_record_count = ?, final_byte_count = ?, pending_count = ?,
         metadata_json = ?, updated_at = ?
     WHERE message_job_id = ? AND export_job_id = ?`,
    [
      'verify_manifest',
      input.exportJob.manifest_object_ref,
      checksum,
      recordCount,
      byteCount,
      0,
      JSON.stringify({ verified_parts: partRefs.length }),
      input.now,
      input.job.id,
      input.payload.export_job_id,
    ]
  );
  await recordExportBuildDeliveryEvent(input.adapter, {
    exportId: input.payload.export_job_id,
    filters: input.filters,
    format: input.exportJob.format,
    artifactObjectRef: input.exportJob.artifact_object_ref,
    manifestObjectRef: input.exportJob.manifest_object_ref ?? '',
    checksumSha256: checksum,
    recordCount,
    byteCount,
    now: input.now,
  });
}

function readCleanupObjectRefs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

async function collectExportCleanupObjectRefs(
  adapter: DatabaseAdapter,
  exportJobId: string,
  explicitRefs: string[]
): Promise<string[]> {
  const refs = new Set(explicitRefs);
  const rows = await adapter.query<{
    part_object_ref: string | null;
    manifest_object_ref: string | null;
    export_artifact_object_ref: string | null;
    export_manifest_object_ref: string | null;
  }>(
    `SELECT eb.part_object_ref, eb.manifest_object_ref,
            ej.artifact_object_ref AS export_artifact_object_ref,
            ej.manifest_object_ref AS export_manifest_object_ref
     FROM logging_message_export_builds eb
     LEFT JOIN logging_export_jobs ej ON ej.id = eb.export_job_id
     WHERE eb.export_job_id = ?`,
    [exportJobId]
  );
  for (const row of rows) {
    if (row.part_object_ref) {
      refs.add(row.part_object_ref);
    }
    if (row.manifest_object_ref) {
      refs.add(row.manifest_object_ref);
    }
    if (row.export_artifact_object_ref) {
      refs.add(row.export_artifact_object_ref);
    }
    if (row.export_manifest_object_ref) {
      refs.add(row.export_manifest_object_ref);
    }
  }
  return Array.from(refs);
}

async function runCleanupExportBuild(input: {
  adapter: DatabaseAdapter;
  payload: ExportBuildMessagePayload;
  rawPayload: Record<string, unknown>;
  bucket: R2Bucket;
  now: number;
}): Promise<void> {
  const refs = await collectExportCleanupObjectRefs(
    input.adapter,
    input.payload.export_job_id,
    readCleanupObjectRefs(input.rawPayload.cleanup_object_refs)
  );
  for (const ref of refs) {
    await input.bucket.delete(ref);
  }
  await input.adapter.execute(
    `UPDATE logging_message_export_builds
     SET cleanup_status = ?, metadata_json = ?, updated_at = ?
     WHERE export_job_id = ?`,
    [
      'completed',
      JSON.stringify({
        cleanup_reason: input.payload.cleanup_reason ?? 'manual',
        cleanup_object_count: refs.length,
      }),
      input.now,
      input.payload.export_job_id,
    ]
  );
  await input.adapter.execute(
    `UPDATE logging_export_jobs
     SET artifact_object_ref = NULL, manifest_object_ref = NULL, updated_at = ?
     WHERE id = ?`,
    [input.now, input.payload.export_job_id]
  );
}

async function runExportBuildMessageJob(input: {
  env: Env;
  adapter: DatabaseAdapter;
  job: LoggingMessageJobRecord;
  payload: ExportBuildMessagePayload;
  rawPayload: Record<string, unknown>;
  now: number;
}): Promise<void> {
  const { env, adapter, job, payload, rawPayload, now } = input;
  const bucket = getLoggingExportBucket(env);
  if (!bucket) {
    throw new Error('export_artifact_bucket_unavailable');
  }
  const filters = readExportBuildFilters(rawPayload.filters);
  const exportJob = await adapter.queryOne<LoggingExportBuildJobRow>(
    `SELECT id, format, status, artifact_object_ref, manifest_object_ref,
            checksum_sha256, record_count, byte_count, expires_at
     FROM logging_export_jobs
     WHERE id = ?`,
    [payload.export_job_id]
  );
  if (!exportJob) {
    throw new Error('export_job_not_found');
  }
  if (payload.phase === 'cleanup') {
    await runCleanupExportBuild({ adapter, payload, rawPayload, bucket, now });
    return;
  }
  if (job.cancelRequestedAt !== null || exportJob.status === 'cancelled') {
    await adapter.execute(
      `UPDATE logging_export_jobs
       SET status = ?, updated_at = ?, completed_at = ?
       WHERE id = ?`,
      ['cancelled', now, now, payload.export_job_id]
    );
    return;
  }
  await adapter.execute(
    `UPDATE logging_export_jobs
     SET status = ?, updated_at = ?
     WHERE id = ? AND status IN (?, ?)`,
    ['running', now, payload.export_job_id, 'queued', 'retrying']
  );

  if (!filters) {
    throw new Error('invalid_export_build_filters');
  }
  if (payload.phase === 'plan') {
    const partitionCount = getExportBuildPartitionCount(filters, payload);
    if (partitionCount <= 1) {
      await runSinglePartExportBuild({
        env,
        adapter,
        job,
        payload,
        exportJob,
        filters,
        bucket,
        now,
      });
      return;
    }
    await runPartitionedExportBuildPlan({ env, adapter, job, payload, exportJob, filters, now });
    return;
  }
  if (payload.phase === 'build_partition') {
    await runExportBuildPartition({ env, adapter, job, payload, exportJob, filters, bucket, now });
    return;
  }
  if (payload.phase === 'finalize') {
    await runFinalizeExportBuild({ env, adapter, job, payload, exportJob, filters, bucket, now });
    return;
  }
  if (payload.phase === 'verify_manifest') {
    await runVerifyExportManifest({ adapter, job, payload, exportJob, filters, bucket, now });
    return;
  }
  throw new Error(`unsupported_export_build_phase:${payload.phase}`);
}

async function enqueueMessageJobDlqNotification(
  adapter: DatabaseAdapter,
  job: LoggingMessageJobRecord,
  now: number,
  reason: string
): Promise<void> {
  if (job.criticality !== 'critical' && job.lane !== 'critical') {
    return;
  }
  const repository = new InternalNotificationEventRepository(adapter);
  await repository.enqueue({
    tenantId: job.tenantKey ?? 'global',
    category: 'logging_dlq_backlog',
    eventType: 'logging.message_job.dlq',
    severity: 'critical',
    deduplicationKey: ['logging_message_job_dlq', job.id, reason].join(':'),
    payload: {
      message_job_id: job.id,
      kind: job.kind,
      lane: job.lane,
      criticality: job.criticality,
      tenant_key: job.tenantKey,
      source_type: job.sourceType,
      source_id: job.sourceId,
      reason,
    },
    routingPolicy: {
      providers: ['internal_event', 'webhook', 'email'],
      failurePolicy: 'retry_until_dead_letter',
      policyScope: 'deployment',
      allowProviderSuppression: true,
    },
    now: new Date(now),
  });
}

async function enqueueExportPartRepairNotification(
  adapter: DatabaseAdapter,
  row: LoggingExportPartRepairCandidateRow,
  now: number
): Promise<void> {
  if (row.criticality !== 'critical' && row.lane !== 'critical') {
    return;
  }
  const repository = new InternalNotificationEventRepository(adapter);
  await repository.enqueue({
    tenantId: row.tenant_key ?? 'global',
    category: 'logging_dlq_backlog',
    eventType: 'logging.export_part.missing',
    severity: 'critical',
    deduplicationKey: ['logging_export_part_missing', row.export_job_id, row.part_object_ref].join(
      ':'
    ),
    payload: {
      message_job_id: row.message_job_id,
      export_job_id: row.export_job_id,
      part_object_ref: row.part_object_ref,
      phase: row.phase,
      tenant_key: row.tenant_key,
    },
    routingPolicy: {
      providers: ['internal_event', 'webhook', 'email'],
      failurePolicy: 'retry_until_dead_letter',
      policyScope: 'deployment',
      allowProviderSuppression: true,
    },
    now: new Date(now),
  });
}

async function detectMissingExportParts(
  env: Env,
  store: SqlLoggingMessageJobStore,
  adapter: DatabaseAdapter,
  now: number,
  result: LoggingStorageMaintenanceResult['messageJobs']
): Promise<void> {
  const bucket = getLoggingExportBucket(env);
  if (!bucket || typeof bucket.head !== 'function') {
    return;
  }
  const rows = await adapter.query<LoggingExportPartRepairCandidateRow>(
    `SELECT eb.message_job_id, eb.export_job_id, eb.part_object_ref, eb.phase,
            mj.tenant_key, mj.kind, mj.status, mj.criticality, mj.lane
     FROM logging_message_export_builds eb
     LEFT JOIN logging_message_jobs mj ON mj.id = eb.message_job_id
     WHERE eb.part_object_ref IS NOT NULL
       AND eb.phase IN (?, ?, ?)
     ORDER BY eb.updated_at DESC
     LIMIT ?`,
    ['build_partition', 'finalize', 'verify_manifest', 50]
  );

  for (const row of rows) {
    if (!row.part_object_ref || !row.message_job_id) {
      continue;
    }
    const object = await bucket.head(row.part_object_ref);
    if (object) {
      continue;
    }
    await store.recordRepairFinding({
      messageJobId: row.message_job_id,
      findingType: 'missing_export_part',
      severity: row.criticality === 'critical' || row.lane === 'critical' ? 'critical' : 'error',
      safeAction: 'rebuild_export_partition',
      dangerousAction: 'mark_export_failed_and_cleanup_manifest',
      impact: {
        export_job_id: row.export_job_id,
        part_object_ref: row.part_object_ref,
        phase: row.phase,
      },
      now,
    });
    await adapter.execute(
      `UPDATE logging_export_jobs
       SET status = ?, error_class = ?, updated_at = ?
       WHERE id = ? AND status IN (?, ?, ?)`,
      ['retrying', 'missing_export_part', now, row.export_job_id, 'queued', 'running', 'completed']
    );
    result.repairFindings += 1;
    await enqueueExportPartRepairNotification(adapter, row, now);
  }
}

async function runExportArtifactCleanup(
  env: Env,
  adapter: DatabaseAdapter,
  now: number,
  result: LoggingStorageMaintenanceResult['messageJobs']
): Promise<void> {
  const bucket = getLoggingExportBucket(env);
  if (!bucket || typeof bucket.delete !== 'function') {
    return;
  }
  const rows = await adapter.query<LoggingExportCleanupCandidateRow>(
    `SELECT eb.message_job_id, eb.export_job_id, eb.part_object_ref,
            COALESCE(eb.manifest_object_ref, ej.manifest_object_ref) AS manifest_object_ref
     FROM logging_message_export_builds eb
     LEFT JOIN logging_export_jobs ej ON ej.id = eb.export_job_id
     WHERE eb.cleanup_status = ?
     ORDER BY eb.updated_at ASC
     LIMIT ?`,
    ['queued', 50]
  );
  for (const row of rows) {
    if (row.part_object_ref) {
      await bucket.delete(row.part_object_ref);
    }
    if (row.manifest_object_ref) {
      await bucket.delete(row.manifest_object_ref);
    }
    await adapter.execute(
      `UPDATE logging_message_export_builds
       SET cleanup_status = ?, updated_at = ?
       WHERE export_job_id = ? AND cleanup_status = ?`,
      ['completed', now, row.export_job_id, 'queued']
    );
    await adapter.execute(
      `UPDATE logging_export_jobs
       SET artifact_object_ref = NULL, manifest_object_ref = NULL, updated_at = ?
       WHERE id = ?`,
      [now, row.export_job_id]
    );
    result.repaired += 1;
  }
}

async function runScheduledLoggingMessageJobRepairs(
  store: SqlLoggingMessageJobStore,
  env: Env,
  adapter: DatabaseAdapter,
  now: number,
  result: LoggingStorageMaintenanceResult['messageJobs']
): Promise<void> {
  await runExportArtifactCleanup(env, adapter, now, result);
  await detectMissingExportParts(env, store, adapter, now, result);

  const expiredJobs = await store.listExpiredQueuedJobs({ now, limit: 50 });
  for (const job of expiredJobs) {
    const repaired = await store.markExpired({
      id: job.id,
      now,
      lastError: 'Message job expired before it could be completed.',
    });
    if (!repaired) {
      continue;
    }
    result.repaired += 1;
    result.expired += 1;
    await store.recordRepairFinding({
      messageJobId: job.id,
      findingType: job.status === 'retrying' ? 'expired_retrying' : 'expired_queued',
      severity: job.criticality === 'critical' ? 'critical' : 'warning',
      status: 'safe_repaired',
      safeAction: 'mark_expired',
      impact: {
        previous_status: job.status,
        expires_at: job.expiresAt,
      },
      now,
    });
    await enqueueMessageJobDlqNotification(adapter, job, now, 'message_job_expired');
  }

  const stuckJobs = await store.listStuckClaimJobs({ now, limit: 50 });
  for (const job of stuckJobs) {
    if (job.expiresAt !== null && job.expiresAt <= now) {
      const expired = await store.markExpired({
        id: job.id,
        now,
        lastError: 'Claim lease expired after message job TTL.',
      });
      if (!expired) {
        continue;
      }
      result.repaired += 1;
      result.expired += 1;
      await store.recordRepairFinding({
        messageJobId: job.id,
        findingType: 'stuck_claim',
        severity: job.criticality === 'critical' ? 'critical' : 'warning',
        status: 'safe_repaired',
        safeAction: 'mark_expired',
        impact: {
          previous_status: job.status,
          claimed_until: job.claimedUntil,
          expires_at: job.expiresAt,
        },
        now,
      });
      await enqueueMessageJobDlqNotification(adapter, job, now, 'message_job_expired');
      continue;
    }

    if (job.attemptCount >= job.maxAttempts) {
      const dlq = await store.repairStuckLeaseToDlq({
        id: job.id,
        now,
        errorClass: 'claim_lease_timeout',
        lastError: 'Claim lease expired and max attempts were reached.',
      });
      if (!dlq) {
        continue;
      }
      result.repaired += 1;
      result.dlq += 1;
      await store.recordRepairFinding({
        messageJobId: job.id,
        findingType: 'stuck_claim',
        severity: job.criticality === 'critical' ? 'critical' : 'warning',
        status: 'safe_repaired',
        safeAction: 'mark_dlq',
        impact: {
          previous_status: job.status,
          claimed_until: job.claimedUntil,
          attempt_count: job.attemptCount,
          max_attempts: job.maxAttempts,
        },
        now,
      });
      await enqueueMessageJobDlqNotification(adapter, job, now, 'claim_lease_timeout');
      continue;
    }

    const retrying = await store.repairStuckLeaseForRetry({
      id: job.id,
      now,
      notBefore: now + computeMessageJobRetryBackoffMs(job),
      errorClass: 'claim_lease_timeout',
      lastError: 'Claim lease expired before completion.',
    });
    if (!retrying) {
      continue;
    }
    result.repaired += 1;
    result.retrying += 1;
    await store.recordRepairFinding({
      messageJobId: job.id,
      findingType: 'stuck_claim',
      severity: job.criticality === 'critical' ? 'critical' : 'warning',
      status: 'safe_repaired',
      safeAction: 'retry_after_lease_timeout',
      impact: {
        previous_status: job.status,
        claimed_until: job.claimedUntil,
        attempt_count: job.attemptCount,
        max_attempts: job.maxAttempts,
      },
      now,
    });
  }
}

async function runScheduledLoggingMessageJobs(
  env: Env,
  adapter: DatabaseAdapter,
  log: LoggingStorageMaintenanceLogger,
  now: number
): Promise<LoggingStorageMaintenanceResult['messageJobs']> {
  const store = new SqlLoggingMessageJobStore(adapter);
  const result: LoggingStorageMaintenanceResult['messageJobs'] = {
    repaired: 0,
    repairFindings: 0,
    expired: 0,
    claimed: 0,
    completed: 0,
    retrying: 0,
    dlq: 0,
    blocked: 0,
  };

  await runScheduledLoggingMessageJobRepairs(store, env, adapter, now, result);

  for (let index = 0; index < 25; index += 1) {
    const claimToken = createLoggingId('qpl', now + index);
    const claimed = await store.claimDueJob({
      now,
      leaseMs: 5 * 60 * 1000,
      claimToken,
      limit: 1,
    });
    if (!claimed) {
      break;
    }
    result.claimed += 1;
    await store.markRunning(claimed.id, claimToken, now);

    if (claimed.cancelRequestedAt !== null) {
      if (await store.markCancelled(claimed.id, now)) {
        result.blocked += 1;
      }
      continue;
    }

    const payloadObject = await readLoggingMessagePayload(env, claimed.payloadObjectRef);
    if (!payloadObject.ok) {
      if (payloadObject.reason === 'bucket_unavailable') {
        if (claimed.attemptCount >= claimed.maxAttempts) {
          if (
            await store.markFailed({
              id: claimed.id,
              claimToken,
              now,
              status: 'dlq',
              errorClass: 'message_payload_bucket_unavailable',
              lastError: 'No logging message payload bucket is available.',
            })
          ) {
            result.dlq += 1;
            await enqueueMessageJobDlqNotification(
              adapter,
              claimed,
              now,
              'message_payload_bucket_unavailable'
            );
          }
          continue;
        }
        if (
          await store.markRetrying({
            id: claimed.id,
            claimToken,
            now,
            notBefore: now + computeMessageJobRetryBackoffMs(claimed),
            errorClass: 'message_payload_bucket_unavailable',
            lastError: 'No logging message payload bucket is available.',
          })
        ) {
          result.retrying += 1;
        }
        continue;
      }
      await store.markBlocked({
        id: claimed.id,
        now,
        blockedReason:
          payloadObject.reason === 'not_found'
            ? 'missing_payload_object'
            : payloadObject.reason === 'too_large'
              ? 'payload_object_too_large'
              : 'malformed_payload_json',
        errorClass: payloadObject.reason,
      });
      await store.recordRepairFinding({
        messageJobId: claimed.id,
        findingType: 'missing_payload_object',
        severity: claimed.criticality === 'critical' ? 'critical' : 'warning',
        safeAction: 'mark_blocked',
        impact: {
          payload_object_ref: claimed.payloadObjectRef,
          read_reason: payloadObject.reason,
        },
        now,
      });
      await enqueueMessageJobDlqNotification(adapter, claimed, now, payloadObject.reason);
      result.blocked += 1;
      continue;
    }

    const parsed = parseLoggingMessageQueuePayload(payloadObject.value);
    if (!parsed.ok) {
      if (parsed.reason === 'unsupported_schema') {
        if (
          await store.markFailed({
            id: claimed.id,
            claimToken,
            now,
            status: 'dlq',
            errorClass: 'unsupported_schema',
            lastError: 'Unsupported logging message payload schema.',
          })
        ) {
          result.dlq += 1;
          await enqueueMessageJobDlqNotification(adapter, claimed, now, 'unsupported_schema');
        }
        continue;
      }
      await store.markBlocked({
        id: claimed.id,
        now,
        blockedReason: 'malformed_payload',
        errorClass: parsed.reason,
      });
      await store.recordRepairFinding({
        messageJobId: claimed.id,
        findingType: 'missing_payload_object',
        severity: claimed.criticality === 'critical' ? 'critical' : 'warning',
        safeAction: 'mark_blocked',
        impact: {
          payload_object_ref: claimed.payloadObjectRef,
          parse_reason: parsed.reason,
        },
        now,
      });
      result.blocked += 1;
      continue;
    }

    if (parsed.payload.message_job_id !== claimed.id) {
      await store.markBlocked({
        id: claimed.id,
        now,
        blockedReason: 'message_job_id_mismatch',
        errorClass: 'event_job_mismatch',
      });
      await store.recordRepairFinding({
        messageJobId: claimed.id,
        findingType: 'event_job_mismatch',
        severity: claimed.criticality === 'critical' ? 'critical' : 'warning',
        safeAction: 'mark_blocked',
        impact: {
          payload_message_job_id: parsed.payload.message_job_id,
          claimed_message_job_id: claimed.id,
        },
        now,
      });
      await enqueueMessageJobDlqNotification(adapter, claimed, now, 'message_job_id_mismatch');
      result.blocked += 1;
      continue;
    }

    if (parsed.payload.payload_type === 'export_build') {
      try {
        await runExportBuildMessageJob({
          env,
          adapter,
          job: claimed,
          payload: parsed.payload,
          rawPayload: payloadObject.value as Record<string, unknown>,
          now,
        });
        if (await store.markCompleted(claimed.id, claimToken, now)) {
          result.completed += 1;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'export_build_failed';
        const blocked =
          errorMessage === 'invalid_export_build_filters' ||
          errorMessage === 'export_job_not_found' ||
          errorMessage.startsWith('unsupported_export_build_phase:');
        if (blocked) {
          await store.markBlocked({
            id: claimed.id,
            now,
            blockedReason: errorMessage,
            errorClass: 'export_build_configuration',
            lastError: errorMessage,
          });
          await store.recordRepairFinding({
            messageJobId: claimed.id,
            findingType: 'blocked_configuration',
            severity: claimed.criticality === 'critical' ? 'critical' : 'warning',
            safeAction: 'mark_blocked',
            impact: {
              payload_object_ref: claimed.payloadObjectRef,
              error: errorMessage,
            },
            now,
          });
          await enqueueMessageJobDlqNotification(adapter, claimed, now, errorMessage);
          result.blocked += 1;
          continue;
        }
        if (claimed.attemptCount >= claimed.maxAttempts) {
          if (
            await store.markFailed({
              id: claimed.id,
              claimToken,
              now,
              status: 'dlq',
              errorClass: 'export_build_failed',
              lastError: errorMessage,
            })
          ) {
            await adapter.execute(
              `UPDATE logging_export_jobs
               SET status = ?, error_class = ?, updated_at = ?, completed_at = ?
               WHERE id = ?`,
              ['failed', errorMessage, now, now, parsed.payload.export_job_id]
            );
            result.dlq += 1;
            await enqueueMessageJobDlqNotification(adapter, claimed, now, errorMessage);
          }
          continue;
        }
        if (
          await store.markRetrying({
            id: claimed.id,
            claimToken,
            now,
            notBefore: now + computeMessageJobRetryBackoffMs(claimed),
            errorClass: 'export_build_failed',
            lastError: errorMessage,
          })
        ) {
          await adapter.execute(
            `UPDATE logging_export_jobs
             SET status = ?, error_class = ?, updated_at = ?
             WHERE id = ?`,
            ['retrying', errorMessage, now, parsed.payload.export_job_id]
          );
          result.retrying += 1;
        }
      }
      continue;
    }

    const enqueueResult = await enqueueLoggingDeliveryPayload(
      parsed.payload.replay_payload,
      env as unknown as Record<string, unknown>
    );
    if (enqueueResult.queued) {
      if (await store.markCompleted(claimed.id, claimToken, now)) {
        result.completed += 1;
      }
      continue;
    }

    if (claimed.attemptCount >= claimed.maxAttempts) {
      if (
        await store.markFailed({
          id: claimed.id,
          claimToken,
          now,
          status: 'dlq',
          errorClass: 'logging_delivery_queue_unavailable',
          lastError: 'No logging delivery queue binding is available for retry delivery.',
        })
      ) {
        result.dlq += 1;
        await enqueueMessageJobDlqNotification(
          adapter,
          claimed,
          now,
          'logging_delivery_queue_unavailable'
        );
      }
      continue;
    }

    if (
      await store.markRetrying({
        id: claimed.id,
        claimToken,
        now,
        notBefore: now + computeMessageJobRetryBackoffMs(claimed),
        errorClass: 'logging_delivery_queue_unavailable',
        lastError: 'No logging delivery queue binding is available for retry delivery.',
      })
    ) {
      result.retrying += 1;
    }
  }

  log.debug?.('Logging message job scheduled processing completed', result);
  return result;
}

async function deleteRowsById(
  adapter: DatabaseAdapter,
  tableName: string,
  ids: string[]
): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }
  const placeholders = ids.map(() => '?').join(', ');
  const result = await adapter.execute(
    `DELETE FROM ${tableName} WHERE id IN (${placeholders})`,
    ids
  );
  return result.rowsAffected ?? ids.length;
}

async function runScheduledDeliveryEventRetention(
  adapter: DatabaseAdapter,
  log: LoggingStorageMaintenanceLogger,
  now: number
): Promise<LoggingStorageMaintenanceResult['retention']> {
  const dayMs = 24 * 60 * 60 * 1000;
  const defaultCutoff = now - DEFAULT_LOGGING_DELIVERY_EVENT_RETENTION_DAYS * dayMs;
  const bulkSuccessCutoff = now - BULK_SUCCESS_DELIVERY_EVENT_RETENTION_DAYS * dayMs;
  const retryDlqCutoff = now - RETRY_DLQ_DELIVERY_EVENT_RETENTION_DAYS * dayMs;
  const criticalFailureCutoff = now - CRITICAL_FAILURE_DELIVERY_EVENT_RETENTION_DAYS * dayMs;
  const deliveryEvents = await adapter.query<{ id: string }>(
    `SELECT id
     FROM logging_delivery_events
     WHERE (
       (lane = 'bulk' AND status = 'delivered' AND created_at < ?)
       OR (lane <> 'bulk' AND status = 'delivered' AND created_at < ?)
       OR (lane = 'critical' AND status IN ('retrying', 'failed', 'dlq') AND created_at < ?)
       OR (lane <> 'critical' AND status IN ('retrying', 'failed', 'dlq') AND created_at < ?)
       OR (status = 'queued' AND created_at < ?)
     )
     ORDER BY created_at ASC
     LIMIT ?`,
    [
      bulkSuccessCutoff,
      defaultCutoff,
      criticalFailureCutoff,
      retryDlqCutoff,
      defaultCutoff,
      LOGGING_RETENTION_DELETE_BATCH_SIZE,
    ]
  );
  const deliveryEventsDeleted = await deleteRowsById(
    adapter,
    'logging_delivery_events',
    deliveryEvents.map((row) => row.id)
  );

  const aggregateResult = await adapter.execute(
    `DELETE FROM logging_delivery_event_aggregates
     WHERE (
       (lane = 'bulk' AND status = 'delivered' AND bucket_end_at < ?)
       OR (lane <> 'bulk' AND status = 'delivered' AND bucket_end_at < ?)
       OR (lane = 'critical' AND status IN ('retrying', 'failed', 'dlq') AND bucket_end_at < ?)
       OR (lane <> 'critical' AND status IN ('retrying', 'failed', 'dlq') AND bucket_end_at < ?)
       OR (status = 'queued' AND bucket_end_at < ?)
     )`,
    [bulkSuccessCutoff, defaultCutoff, criticalFailureCutoff, retryDlqCutoff, defaultCutoff]
  );
  const dlqRows = await adapter.query<{ id: string }>(
    `SELECT id
     FROM logging_dlq_items
     WHERE status IN ('deleted', 'purged', 'replayed')
       AND (
         (lane = 'critical' AND updated_at < ?)
         OR (lane <> 'critical' AND updated_at < ?)
       )
     ORDER BY updated_at ASC
     LIMIT ?`,
    [criticalFailureCutoff, retryDlqCutoff, LOGGING_RETENTION_DELETE_BATCH_SIZE]
  );
  const dlqItemsPurged = await deleteRowsById(
    adapter,
    'logging_dlq_items',
    dlqRows.map((row) => row.id)
  );
  const result = {
    deliveryEventsDeleted,
    deliveryAggregatesDeleted: aggregateResult.rowsAffected ?? 0,
    dlqItemsPurged,
  };
  log.debug?.('Logging delivery event retention completed', result);
  return result;
}

export async function processLoggingStorageMaintenanceJobs(
  env: Env,
  log: LoggingStorageMaintenanceLogger
): Promise<LoggingStorageMaintenanceResult> {
  const now = Date.now();
  const adapter = requireDedicatedAdminDatabaseAdapter(env, 'logging-storage-maintenance');

  const result: LoggingStorageMaintenanceResult = {
    healthChecks: { checked: 0, failed: 0 },
    manifests: { published: 0, skipped: 0 },
    catalogRepair: { findings: 0, applied: 0, skipped: 0 },
    rewrap: { candidates: 0, jobsCreated: 0, dispatched: 0, queueUnavailable: 0, skipped: 0 },
    messageJobs: {
      repaired: 0,
      repairFindings: 0,
      expired: 0,
      claimed: 0,
      completed: 0,
      retrying: 0,
      dlq: 0,
      blocked: 0,
    },
    retention: { deliveryEventsDeleted: 0, deliveryAggregatesDeleted: 0, dlqItemsPurged: 0 },
    usage: {
      windowsRefreshed: 0,
      aggregatesRefreshed: 0,
      quotaPoliciesEvaluated: 0,
      quotaWarnings: 0,
      quotaActions: 0,
    },
  };

  try {
    result.healthChecks = await runScheduledDestinationHealthChecks(env, adapter, log, now);
  } catch (error) {
    log.error('Logging destination scheduled health checks failed', {}, error as Error);
  }

  try {
    result.manifests = await runScheduledManifestPublish(env, adapter, log, now);
  } catch (error) {
    log.error('Logging chunk manifest scheduled publish failed', {}, error as Error);
  }

  try {
    result.catalogRepair = await runScheduledCatalogSafeRepair(adapter, log, now);
  } catch (error) {
    log.error('Logging catalog scheduled safe repair failed', {}, error as Error);
  }

  try {
    result.rewrap = await runScheduledRewrapDispatch(env, adapter, log, now);
  } catch (error) {
    log.error('Logging key rewrap dispatch failed', {}, error as Error);
  }

  try {
    result.messageJobs = await runScheduledLoggingMessageJobs(env, adapter, log, now);
  } catch (error) {
    log.error('Logging message job scheduled processing failed', {}, error as Error);
  }

  try {
    result.usage = await runScheduledUsageAndQuotaMaintenance(adapter, log, now);
  } catch (error) {
    log.error('Logging usage/quota scheduled maintenance failed', {}, error as Error);
  }

  try {
    result.retention = await runScheduledDeliveryEventRetention(adapter, log, now);
  } catch (error) {
    log.error('Logging delivery event retention failed', {}, error as Error);
  }

  log.info('Logging/storage maintenance completed', {
    healthChecks: result.healthChecks,
    manifests: result.manifests,
    catalogRepair: result.catalogRepair,
    rewrap: result.rewrap,
    messageJobs: result.messageJobs,
    usage: result.usage,
    retention: result.retention,
  });
  return result;
}
