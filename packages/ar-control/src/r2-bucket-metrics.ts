import {
  CONTROL_R2_BUCKET_BINDINGS,
  type ControlR2BucketBinding,
  type ControlR2BucketMetric,
  type ControlR2BucketMetricInventory,
  type ControlR2BucketMetricReportRequest,
  type ControlR2MetricOwner,
} from '@authrim/ar-lib-core/control-plane';
import type { ControlEnv } from './types';

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const COMPLETE_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_ENCRYPTION_METHODS = 16;
const SAFE_METHOD = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

const OWNER_BY_BINDING: Record<ControlR2BucketBinding, ControlR2MetricOwner> = {
  MIGRATION_RELEASES: 'ar-control',
  PLUGIN_BUNDLES: 'ar-plugin-runner',
  PUBLIC_ASSETS: 'ar-management',
  DIAGNOSTIC_LOGS: 'ar-management',
  AUDIT_ARCHIVE: 'ar-management',
  IMPORT_ARTIFACTS: 'ar-management',
  EXPORT_ARTIFACTS: 'ar-management',
  SENSITIVE_DETAILS: 'ar-management',
};

const RETENTION_BY_BINDING: Record<ControlR2BucketBinding, string> = {
  MIGRATION_RELEASES: 'Immutable release artifacts retained for supported releases',
  PLUGIN_BUNDLES: 'Referenced signed bundles retained; superseded bundles policy managed',
  PUBLIC_ASSETS: 'Referenced objects retained; unreferenced objects removed after 24 hours',
  DIAGNOSTIC_LOGS: 'Tenant-configured; 30 days by default',
  AUDIT_ARCHIVE: 'Object-catalog and policy managed',
  IMPORT_ARTIFACTS: 'Terminal jobs: immediate; orphan uploads: 24 hours',
  EXPORT_ARTIFACTS: 'Object-catalog and policy managed',
  SENSITIVE_DETAILS: 'Object-catalog and policy managed',
};

interface StoredMetricRow {
  binding: string;
  owner_worker: string;
  object_count: number;
  total_bytes: number;
  oldest_object_at: number | null;
  encryption_methods_json: string;
  retention_overdue_objects: number | null;
  retention_policy: string;
  scan_complete: number;
  measured_at: number;
  reported_at: number;
}

interface ScanAccumulator extends Omit<ControlR2BucketMetric, 'scanComplete' | 'measuredAt'> {
  cursor: string | null;
}

function exactRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid_r2_bucket_metric_report');
  }
  const record = input as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== [...keys].sort().join(',')) {
    throw new Error('invalid_r2_bucket_metric_report');
  }
  return record;
}

function safeInteger(value: unknown, nullable = false): number | null {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('invalid_r2_bucket_metric_report');
  }
  return value as number;
}

function parseMetric(input: unknown, owner: ControlR2MetricOwner): ControlR2BucketMetric {
  const value = exactRecord(input, [
    'binding',
    'objectCount',
    'totalBytes',
    'oldestObjectAt',
    'encryptionMethods',
    'retentionOverdueObjects',
    'retentionPolicy',
    'scanComplete',
    'measuredAt',
  ]);
  if (
    typeof value.binding !== 'string' ||
    !CONTROL_R2_BUCKET_BINDINGS.includes(value.binding as ControlR2BucketBinding) ||
    OWNER_BY_BINDING[value.binding as ControlR2BucketBinding] !== owner ||
    typeof value.retentionPolicy !== 'string' ||
    value.retentionPolicy.length < 1 ||
    value.retentionPolicy.length > 256 ||
    typeof value.scanComplete !== 'boolean' ||
    !value.encryptionMethods ||
    typeof value.encryptionMethods !== 'object' ||
    Array.isArray(value.encryptionMethods)
  ) {
    throw new Error('invalid_r2_bucket_metric_report');
  }
  const encryptionEntries = Object.entries(value.encryptionMethods as Record<string, unknown>);
  if (encryptionEntries.length > MAX_ENCRYPTION_METHODS) {
    throw new Error('invalid_r2_bucket_metric_report');
  }
  const encryptionMethods: Record<string, number> = {};
  for (const [method, count] of encryptionEntries) {
    if (!SAFE_METHOD.test(method)) throw new Error('invalid_r2_bucket_metric_report');
    encryptionMethods[method] = safeInteger(count) as number;
  }
  return {
    binding: value.binding as ControlR2BucketBinding,
    objectCount: safeInteger(value.objectCount) as number,
    totalBytes: safeInteger(value.totalBytes) as number,
    oldestObjectAt: safeInteger(value.oldestObjectAt, true),
    encryptionMethods,
    retentionOverdueObjects: safeInteger(value.retentionOverdueObjects, true),
    retentionPolicy: value.retentionPolicy,
    scanComplete: value.scanComplete,
    measuredAt: safeInteger(value.measuredAt) as number,
  };
}

function parseReport(
  input: unknown,
  owner: ControlR2MetricOwner,
  nowMs: number
): ControlR2BucketMetric[] {
  const report = exactRecord(input, ['metrics']) as unknown as ControlR2BucketMetricReportRequest;
  const maxMetrics = Object.values(OWNER_BY_BINDING).filter((value) => value === owner).length;
  if (
    !Array.isArray(report.metrics) ||
    report.metrics.length < 1 ||
    report.metrics.length > maxMetrics
  ) {
    throw new Error('invalid_r2_bucket_metric_report');
  }
  const metrics = report.metrics.map((metric) => parseMetric(metric, owner));
  if (
    metrics.some(
      (metric) =>
        metric.measuredAt > nowMs + 5 * 60 * 1000 ||
        (metric.oldestObjectAt !== null && metric.oldestObjectAt > metric.measuredAt)
    )
  ) {
    throw new Error('invalid_r2_bucket_metric_report');
  }
  if (new Set(metrics.map((metric) => metric.binding)).size !== metrics.length) {
    throw new Error('invalid_r2_bucket_metric_report');
  }
  return metrics;
}

async function storeMetrics(
  database: D1Database,
  environmentId: string,
  owner: ControlR2MetricOwner,
  metrics: ControlR2BucketMetric[],
  reportedAt: number
): Promise<void> {
  await database.batch(
    metrics.map((metric) =>
      database
        .prepare(
          `INSERT INTO control_r2_bucket_metric_reports (
             environment_id, binding, owner_worker, object_count, total_bytes,
             oldest_object_at, encryption_methods_json, retention_overdue_objects,
             retention_policy, scan_complete, measured_at, reported_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(environment_id, binding) DO UPDATE SET
             owner_worker = excluded.owner_worker,
             object_count = excluded.object_count,
             total_bytes = excluded.total_bytes,
             oldest_object_at = excluded.oldest_object_at,
             encryption_methods_json = excluded.encryption_methods_json,
             retention_overdue_objects = excluded.retention_overdue_objects,
             retention_policy = excluded.retention_policy,
             scan_complete = excluded.scan_complete,
             measured_at = excluded.measured_at,
             reported_at = excluded.reported_at`
        )
        .bind(
          environmentId,
          metric.binding,
          owner,
          metric.objectCount,
          metric.totalBytes,
          metric.oldestObjectAt,
          JSON.stringify(metric.encryptionMethods),
          metric.retentionOverdueObjects,
          metric.retentionPolicy,
          metric.scanComplete ? 1 : 0,
          metric.measuredAt,
          reportedAt
        )
    )
  );
}

export async function reportR2BucketMetrics(
  database: D1Database,
  environmentId: string,
  owner: Exclude<ControlR2MetricOwner, 'ar-control'>,
  input: unknown,
  nowMs = Date.now()
): Promise<ControlR2BucketMetricInventory> {
  const metrics = parseReport(input, owner, nowMs);
  await storeMetrics(database, environmentId, owner, metrics, nowMs);
  return getR2BucketMetricInventory(database, environmentId, nowMs);
}

function decodeMethods(raw: string): Record<string, number> {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([method, count]) =>
          SAFE_METHOD.test(method) &&
          typeof count === 'number' &&
          Number.isSafeInteger(count) &&
          count >= 0
      )
    ) as Record<string, number>;
  } catch {
    return {};
  }
}

export async function getR2BucketMetricInventory(
  database: D1Database,
  environmentId: string,
  nowMs = Date.now()
): Promise<ControlR2BucketMetricInventory> {
  const result = await database
    .prepare(
      `SELECT binding, owner_worker, object_count, total_bytes, oldest_object_at,
              encryption_methods_json, retention_overdue_objects, retention_policy,
              scan_complete, measured_at, reported_at
         FROM control_r2_bucket_metric_reports
        WHERE environment_id = ?`
    )
    .bind(environmentId)
    .all<StoredMetricRow>();
  const byBinding = new Map(result.results.map((row) => [row.binding, row]));
  return {
    metrics: CONTROL_R2_BUCKET_BINDINGS.map((binding) => {
      const row = byBinding.get(binding);
      if (!row) {
        return {
          binding,
          ownerWorker: OWNER_BY_BINDING[binding],
          availability: 'pending' as const,
          unavailableReason: 'metric_not_reported',
          reportedAt: null,
          objectCount: 0,
          totalBytes: 0,
          oldestObjectAt: null,
          encryptionMethods: {},
          retentionOverdueObjects: null,
          retentionPolicy: RETENTION_BY_BINDING[binding],
          scanComplete: false,
          measuredAt: 0,
        };
      }
      const stale = nowMs - row.reported_at > STALE_AFTER_MS;
      return {
        binding,
        ownerWorker: OWNER_BY_BINDING[binding],
        availability: stale ? ('stale' as const) : ('current' as const),
        unavailableReason: stale ? 'metric_report_stale' : null,
        reportedAt: row.reported_at,
        objectCount: row.object_count,
        totalBytes: row.total_bytes,
        oldestObjectAt: row.oldest_object_at,
        encryptionMethods: decodeMethods(row.encryption_methods_json),
        retentionOverdueObjects: row.retention_overdue_objects,
        retentionPolicy: row.retention_policy,
        scanComplete: row.scan_complete === 1,
        measuredAt: row.measured_at,
      };
    }),
    generatedAt: nowMs,
  };
}

export async function scanControlR2BucketMetrics(
  env: ControlEnv,
  nowMs = Date.now()
): Promise<void> {
  const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
  if (!environmentId || !env.MIGRATION_RELEASES) return;
  const state = await env.CONTROL_DB.prepare(
    `SELECT accumulator_json FROM control_r2_metric_scan_state
      WHERE environment_id = ? AND binding = 'MIGRATION_RELEASES'`
  )
    .bind(environmentId)
    .first<{ accumulator_json: string }>();
  if (!state) {
    const previous = await env.CONTROL_DB.prepare(
      `SELECT scan_complete, reported_at FROM control_r2_bucket_metric_reports
        WHERE environment_id = ? AND binding = 'MIGRATION_RELEASES'`
    )
      .bind(environmentId)
      .first<{ scan_complete: number; reported_at: number }>();
    if (previous?.scan_complete === 1 && nowMs - previous.reported_at < COMPLETE_SCAN_INTERVAL_MS) {
      return;
    }
  }
  let accumulator: ScanAccumulator = {
    binding: 'MIGRATION_RELEASES',
    objectCount: 0,
    totalBytes: 0,
    oldestObjectAt: null,
    encryptionMethods: {},
    retentionOverdueObjects: null,
    retentionPolicy: RETENTION_BY_BINDING.MIGRATION_RELEASES,
    cursor: null,
  };
  if (state) {
    try {
      accumulator = JSON.parse(state.accumulator_json) as ScanAccumulator;
    } catch {
      // Restart a corrupt, internal-only accumulator without exposing its contents.
    }
  }
  const listed = await env.MIGRATION_RELEASES.list({
    limit: 1000,
    cursor: accumulator.cursor ?? undefined,
  });
  for (const object of listed.objects) {
    const uploadedAt = object.uploaded instanceof Date ? object.uploaded.getTime() : nowMs;
    accumulator.objectCount += 1;
    accumulator.totalBytes += object.size;
    accumulator.oldestObjectAt =
      accumulator.oldestObjectAt === null
        ? uploadedAt
        : Math.min(accumulator.oldestObjectAt, uploadedAt);
    const method = 'release-artifact';
    accumulator.encryptionMethods[method] = (accumulator.encryptionMethods[method] ?? 0) + 1;
  }
  accumulator.cursor = listed.truncated ? (listed.cursor ?? null) : null;
  const metric: ControlR2BucketMetric = {
    binding: 'MIGRATION_RELEASES',
    objectCount: accumulator.objectCount,
    totalBytes: accumulator.totalBytes,
    oldestObjectAt: accumulator.oldestObjectAt,
    encryptionMethods: accumulator.encryptionMethods,
    retentionOverdueObjects: accumulator.retentionOverdueObjects,
    retentionPolicy: accumulator.retentionPolicy,
    scanComplete: !listed.truncated,
    measuredAt: nowMs,
  };
  await storeMetrics(env.CONTROL_DB, environmentId, 'ar-control', [metric], nowMs);
  if (listed.truncated) {
    await env.CONTROL_DB.prepare(
      `INSERT INTO control_r2_metric_scan_state (environment_id, binding, accumulator_json, updated_at)
       VALUES (?, 'MIGRATION_RELEASES', ?, ?)
       ON CONFLICT(environment_id, binding) DO UPDATE SET
         accumulator_json = excluded.accumulator_json, updated_at = excluded.updated_at`
    )
      .bind(environmentId, JSON.stringify(accumulator), nowMs)
      .run();
  } else {
    await env.CONTROL_DB.prepare(
      `DELETE FROM control_r2_metric_scan_state
        WHERE environment_id = ? AND binding = 'MIGRATION_RELEASES'`
    )
      .bind(environmentId)
      .run();
  }
}
