import {
  createDiagnosticLogR2Adapter,
  createSettingsManager,
  DIAGNOSTIC_LOGGING_CATEGORY_META,
  ensureDatabaseAdapter,
  LOGIN_UI_CATEGORY_META,
  listEnvironmentTenantDefaultStores,
  resolveTenantUserStoreSourcesFromEnv,
  type DiagnosticLoggingSettings,
  type Env,
  type ControlR2BucketMetricView,
  type ControlR2BucketBinding,
  CONTROL_R2_BUCKET_BINDINGS,
} from '@authrim/ar-lib-core';
import { cleanupOrphanedUserImportUploads } from './user-import-jobs';

export const R2_STORAGE_MAINTENANCE_CRON = '0 */6 * * *';
const SCHEDULE_STATE_PREFIX = 'jobs:scheduled-task-state:v1:';
const DIAGNOSTIC_TENANT_CURSOR_KEY = 'jobs:r2-maintenance:diagnostic-tenant-cursor';
const PUBLIC_ASSET_CURSOR_KEY = 'jobs:r2-maintenance:public-assets-cursor';
const AUDIT_TRANSIENT_CURSOR_KEY = 'jobs:r2-maintenance:audit-transient-cursor';
const R2_METRICS_KEY = 'jobs:r2-maintenance:metrics:v1';
const R2_METRICS_SCAN_PREFIX = 'jobs:r2-maintenance:metrics-scan:v1:';
const PUBLIC_ASSET_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
const AUDIT_TRANSIENT_ORPHAN_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
const DIAGNOSTIC_TENANT_BATCH_SIZE = 16;
const OBJECT_SCAN_BATCH_SIZE = 500;
const SCHEDULED_TASK_LEASE_MS = 30 * 60 * 1000;

type ScheduleStatus = 'never_run' | 'running' | 'succeeded' | 'failed' | 'disabled';

interface MaintenanceLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>, error?: Error): void;
}

interface ScheduledTaskState {
  id: string;
  status: ScheduleStatus;
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
  lastErrorCode: string | null;
  lastResult: Record<string, unknown> | null;
}

class MaintenancePartialFailure extends Error {
  constructor(
    code: string,
    readonly result: Record<string, unknown>
  ) {
    super(code);
  }
}

export interface R2MaintenanceScheduleView extends ScheduledTaskState {
  name: string;
  enabled: boolean;
  cron: string;
  nextRunAt: number | null;
  disabledReason: string | null;
}

export interface R2BucketOperationalMetric {
  binding: ControlR2BucketBinding;
  objectCount: number;
  totalBytes: number;
  oldestObjectAt: number | null;
  encryptionMethods: Record<string, number>;
  retentionOverdueObjects: number | null;
  retentionPolicy: string;
  scanComplete: boolean;
  measuredAt: number;
  ownerWorker?: 'ar-control' | 'ar-management' | 'ar-plugin-runner';
  availability?: 'current' | 'stale' | 'pending';
  unavailableReason?: string | null;
  reportedAt?: number | null;
}

interface MetricScanAccumulator extends Omit<
  R2BucketOperationalMetric,
  'scanComplete' | 'measuredAt'
> {
  cursor: string | null;
}

interface DiagnosticRetentionCursor {
  afterTenantId: string | null;
  objectCursor: string | null;
}

interface AuditTransientCursor {
  prefixIndex: number;
  objectCursor: string | null;
}

const TASKS = [
  { id: 'r2_diagnostic_log_retention', name: 'Diagnostic log retention' },
  { id: 'r2_import_artifact_cleanup', name: 'Import artifact cleanup' },
  { id: 'r2_public_asset_orphan_cleanup', name: 'Public asset orphan cleanup' },
  { id: 'r2_audit_transient_orphan_cleanup', name: 'Audit transient orphan cleanup' },
  { id: 'r2_bucket_metrics_scan', name: 'R2 bucket metrics scan' },
  { id: 'logging_storage_maintenance', name: 'Logging storage maintenance' },
  { id: 'object_artifact_cleanup', name: 'Object artifact cleanup' },
] as const;

type TaskId = (typeof TASKS)[number]['id'];

const METRIC_BUCKETS = [
  'PUBLIC_ASSETS',
  'DIAGNOSTIC_LOGS',
  'AUDIT_ARCHIVE',
  'IMPORT_ARTIFACTS',
  'EXPORT_ARTIFACTS',
  'SENSITIVE_DETAILS',
] as const;

type MetricBucketBinding = (typeof METRIC_BUCKETS)[number];

function metricOwner(
  binding: ControlR2BucketBinding
): 'ar-control' | 'ar-management' | 'ar-plugin-runner' {
  if (binding === 'MIGRATION_RELEASES') return 'ar-control';
  if (binding === 'PLUGIN_BUNDLES') return 'ar-plugin-runner';
  return 'ar-management';
}

function withPendingFleetMetrics(
  localMetrics: R2BucketOperationalMetric[],
  reason: string
): R2BucketOperationalMetric[] {
  const reported = new Set(localMetrics.map((metric) => metric.binding));
  return [
    ...localMetrics.map((metric) => ({
      ...metric,
      ownerWorker: metric.ownerWorker ?? metricOwner(metric.binding),
      availability: metric.availability ?? ('current' as const),
      unavailableReason: metric.unavailableReason ?? null,
      reportedAt: metric.reportedAt ?? metric.measuredAt,
    })),
    ...CONTROL_R2_BUCKET_BINDINGS.filter((binding) => !reported.has(binding)).map(
      (binding): ControlR2BucketMetricView => ({
        binding,
        ownerWorker: metricOwner(binding),
        availability: 'pending',
        unavailableReason: reason,
        reportedAt: null,
        objectCount: 0,
        totalBytes: 0,
        oldestObjectAt: null,
        encryptionMethods: {},
        retentionOverdueObjects: null,
        retentionPolicy: 'Metrics unavailable until the owning Worker reports to Control',
        scanComplete: false,
        measuredAt: 0,
      })
    ),
  ];
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function nextMaintenanceRunAt(afterMs: number): number {
  const next = new Date(afterMs);
  next.setUTCMinutes(0, 0, 0);
  const currentHour = next.getUTCHours();
  const nextHour = (Math.floor(currentHour / 6) + 1) * 6;
  if (nextHour >= 24) {
    next.setUTCDate(next.getUTCDate() + 1);
    next.setUTCHours(0);
  } else {
    next.setUTCHours(nextHour);
  }
  return next.getTime();
}

function stateKey(id: TaskId): string {
  return `${SCHEDULE_STATE_PREFIX}${id}`;
}

async function readTaskState(env: Env, id: TaskId): Promise<ScheduledTaskState | null> {
  if (!env.AUTHRIM_CONFIG) return null;
  return parseJson<ScheduledTaskState>(await env.AUTHRIM_CONFIG.get(stateKey(id)));
}

async function writeTaskState(env: Env, state: ScheduledTaskState): Promise<void> {
  if (!env.AUTHRIM_CONFIG) return;
  await env.AUTHRIM_CONFIG.put(stateKey(state.id as TaskId), JSON.stringify(state));
}

function taskAvailability(env: Env, id: TaskId): { enabled: boolean; reason: string | null } {
  if (!env.AUTHRIM_CONFIG) {
    return { enabled: false, reason: 'AUTHRIM_CONFIG is not configured' };
  }
  if (env.AUTHRIM_R2_MAINTENANCE_CRON_ENABLED !== 'true') {
    return { enabled: false, reason: 'The setup-managed R2 maintenance cron is not enabled' };
  }
  if (!env.DB_ADMIN) {
    return { enabled: false, reason: 'DB_ADMIN is not configured' };
  }
  if (id === 'logging_storage_maintenance') {
    return env.AUDIT_ARCHIVE
      ? { enabled: true, reason: null }
      : { enabled: false, reason: 'AUDIT_ARCHIVE is not configured' };
  }
  if (id === 'object_artifact_cleanup') {
    return env.EXPORT_ARTIFACTS && env.IMPORT_ARTIFACTS && env.SENSITIVE_DETAILS
      ? { enabled: true, reason: null }
      : { enabled: false, reason: 'Artifact R2 bindings are incomplete' };
  }
  if (id === 'r2_diagnostic_log_retention') {
    return env.DIAGNOSTIC_LOGS
      ? { enabled: true, reason: null }
      : { enabled: false, reason: 'DIAGNOSTIC_LOGS is not configured' };
  }
  if (id === 'r2_import_artifact_cleanup') {
    return env.IMPORT_ARTIFACTS
      ? { enabled: true, reason: null }
      : { enabled: false, reason: 'IMPORT_ARTIFACTS is not configured' };
  }
  if (id === 'r2_public_asset_orphan_cleanup') {
    return env.PUBLIC_ASSETS
      ? { enabled: true, reason: null }
      : { enabled: false, reason: 'PUBLIC_ASSETS is not configured' };
  }
  if (id === 'r2_audit_transient_orphan_cleanup') {
    return env.AUDIT_ARCHIVE && env.DB_ADMIN
      ? { enabled: true, reason: null }
      : {
          enabled: false,
          reason: 'AUDIT_ARCHIVE and DB_ADMIN are required',
        };
  }
  return METRIC_BUCKETS.some((binding) => Boolean(env[binding]))
    ? { enabled: true, reason: null }
    : { enabled: false, reason: 'No observable R2 bucket is configured' };
}

async function acquireTaskLease(
  env: Env,
  id: TaskId,
  token: string,
  now: number
): Promise<boolean> {
  if (!env.DB_ADMIN) return false;
  const adapter = ensureDatabaseAdapter(env.DB_ADMIN, `scheduled-task-lease:${id}`);
  const result = await adapter.execute(
    `INSERT INTO scheduled_task_leases (task_id, lease_token, lease_until, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET
       lease_token = excluded.lease_token,
       lease_until = excluded.lease_until,
       updated_at = excluded.updated_at
     WHERE scheduled_task_leases.lease_until <= excluded.updated_at`,
    [id, token, now + SCHEDULED_TASK_LEASE_MS, now]
  );
  return (result.rowsAffected ?? 0) > 0;
}

async function releaseTaskLease(env: Env, id: TaskId, token: string): Promise<void> {
  if (!env.DB_ADMIN) return;
  const adapter = ensureDatabaseAdapter(env.DB_ADMIN, `scheduled-task-lease-release:${id}`);
  await adapter.execute('DELETE FROM scheduled_task_leases WHERE task_id = ? AND lease_token = ?', [
    id,
    token,
  ]);
}

async function runTrackedTask(
  env: Env,
  id: TaskId,
  operation: () => Promise<Record<string, unknown>>,
  log: MaintenanceLogger
): Promise<void> {
  const availability = taskAvailability(env, id);
  if (!availability.enabled) {
    const previous = await readTaskState(env, id);
    await writeTaskState(env, {
      id,
      status: 'disabled',
      lastStartedAt: previous?.lastStartedAt ?? null,
      lastCompletedAt: previous?.lastCompletedAt ?? null,
      lastErrorCode: availability.reason,
      lastResult: previous?.lastResult ?? null,
    });
    return;
  }

  const startedAt = Date.now();
  const leaseToken = crypto.randomUUID();
  if (!(await acquireTaskLease(env, id, leaseToken, startedAt))) {
    log.warn('R2 scheduled maintenance task skipped because another lease is active', {
      taskId: id,
    });
    return;
  }
  const previous = await readTaskState(env, id);
  await writeTaskState(env, {
    id,
    status: 'running',
    lastStartedAt: startedAt,
    lastCompletedAt: previous?.lastCompletedAt ?? null,
    lastErrorCode: null,
    lastResult: previous?.lastResult ?? null,
  });
  try {
    const result = await operation();
    await writeTaskState(env, {
      id,
      status: 'succeeded',
      lastStartedAt: startedAt,
      lastCompletedAt: Date.now(),
      lastErrorCode: null,
      lastResult: result,
    });
  } catch (error) {
    const rawErrorCode = error instanceof Error ? error.message : '';
    const errorCode = /^[a-z0-9][a-z0-9_:-]{0,127}$/u.test(rawErrorCode)
      ? rawErrorCode
      : `${id}_failed`;
    await writeTaskState(env, {
      id,
      status: 'failed',
      lastStartedAt: startedAt,
      lastCompletedAt: Date.now(),
      lastErrorCode: errorCode,
      lastResult: error instanceof MaintenancePartialFailure ? error.result : null,
    });
    log.error('R2 scheduled maintenance task failed', { taskId: id, errorCode }, error as Error);
  } finally {
    try {
      await releaseTaskLease(env, id, leaseToken);
    } catch (error) {
      log.warn('R2 scheduled maintenance lease release failed; it will expire automatically', {
        taskId: id,
        errorCode: error instanceof Error ? error.message : 'lease_release_failed',
      });
    }
  }
}

export async function runTrackedLoggingStorageMaintenance(
  env: Env,
  operation: () => Promise<Record<string, unknown>>,
  log: MaintenanceLogger
): Promise<void> {
  await runTrackedTask(env, 'logging_storage_maintenance', operation, log);
}

export async function runTrackedObjectArtifactCleanup(
  env: Env,
  operation: () => Promise<Record<string, unknown>>,
  log: MaintenanceLogger
): Promise<void> {
  await runTrackedTask(env, 'object_artifact_cleanup', operation, log);
}

async function loadDiagnosticSettings(
  env: Env,
  tenantId: string
): Promise<DiagnosticLoggingSettings> {
  const manager = createSettingsManager({
    env: env as unknown as Record<string, string | undefined>,
    kv: env.SETTINGS ?? null,
    cacheTTL: 0,
  });
  manager.registerCategory(DIAGNOSTIC_LOGGING_CATEGORY_META);
  const result = await manager.getAll('diagnostic-logging', { type: 'tenant', id: tenantId });
  return result.values as unknown as DiagnosticLoggingSettings;
}

export async function cleanupDiagnosticLogs(env: Env): Promise<Record<string, unknown>> {
  if (!env.DIAGNOSTIC_LOGS || !env.AUTHRIM_CONFIG) {
    throw new Error('diagnostic_log_retention_unavailable');
  }
  const rawCursor = (await env.AUTHRIM_CONFIG.get(DIAGNOSTIC_TENANT_CURSOR_KEY))?.trim() ?? '';
  const parsedCursor = parseJson<DiagnosticRetentionCursor>(rawCursor);
  const cursor: DiagnosticRetentionCursor = parsedCursor ?? {
    afterTenantId: rawCursor || null,
    objectCursor: null,
  };
  let deleted = 0;
  let scanned = 0;
  let failures = 0;
  for (let index = 0; index < DIAGNOSTIC_TENANT_BATCH_SIZE; index += 1) {
    const tenants = await listEnvironmentTenantDefaultStores(env, {
      limit: 1,
      afterTenantId: cursor.afterTenantId ?? undefined,
      concurrency: 1,
    });
    const tenant = tenants[0];
    if (!tenant) {
      await env.AUTHRIM_CONFIG.delete(DIAGNOSTIC_TENANT_CURSOR_KEY);
      const result = { tenantsScanned: scanned, objectsDeleted: deleted, failures, cursor: null };
      if (failures > 0) {
        throw new MaintenancePartialFailure('diagnostic_log_retention_partial_failure', result);
      }
      return result;
    }
    scanned += 1;
    try {
      const settings = await loadDiagnosticSettings(env, tenant.tenantId);
      const retentionDays = Math.max(
        1,
        Math.min(3650, settings['diagnostic-logging.retention_days'] ?? 30)
      );
      const adapter = createDiagnosticLogR2Adapter(env.DIAGNOSTIC_LOGS, {
        pathPrefix: settings['diagnostic-logging.r2_path_prefix'] || 'diagnostic-logs',
        tenantId: tenant.tenantId,
        tenantKeySalt: env.LOGGING_TENANT_KEY_SALT,
      });
      const page = await adapter.deleteByRetentionPage(
        Date.now() - retentionDays * 24 * 60 * 60 * 1000,
        OBJECT_SCAN_BATCH_SIZE,
        cursor.objectCursor ?? undefined
      );
      deleted += page.deleted;
      if (page.cursor) {
        cursor.objectCursor = page.cursor;
        await env.AUTHRIM_CONFIG.put(DIAGNOSTIC_TENANT_CURSOR_KEY, JSON.stringify(cursor));
        const result = {
          tenantsScanned: scanned,
          objectsDeleted: deleted,
          failures,
          cursor,
        };
        if (failures > 0) {
          throw new MaintenancePartialFailure('diagnostic_log_retention_partial_failure', result);
        }
        return result;
      }
    } catch {
      failures += 1;
    }
    cursor.afterTenantId = tenant.tenantId;
    cursor.objectCursor = null;
  }
  await env.AUTHRIM_CONFIG.put(DIAGNOSTIC_TENANT_CURSOR_KEY, JSON.stringify(cursor));
  const result = { tenantsScanned: scanned, objectsDeleted: deleted, failures, cursor };
  if (failures > 0) {
    throw new MaintenancePartialFailure('diagnostic_log_retention_partial_failure', result);
  }
  return result;
}

function parseLoginUiAssetKey(
  key: string
): { tenantId: string; kind: string; filename: string; publicUrl: string } | null {
  const match =
    /^public\/([A-Za-z0-9_-]{1,128})\/login-ui\/(logo|background|panel-background|favicon|thumbnail)\/([A-Za-z0-9._-]+)$/u.exec(
      key
    );
  if (!match) return null;
  const [, tenantId, kind, filename] = match;
  return {
    tenantId,
    kind,
    filename,
    publicUrl: `/api/assets/${encodeURIComponent(tenantId)}/login-ui/${kind}/${filename}`,
  };
}

function parseAvatarAssetKey(
  key: string
): { tenantId: string; filename: string; publicPath: string } | null {
  const match = /^avatars\/([A-Za-z0-9_-]{1,128})\/users\/([A-Za-z0-9._-]+)$/u.exec(key);
  if (!match) return null;
  const [, tenantId, filename] = match;
  return {
    tenantId,
    filename,
    publicPath: `/api/avatars/${filename}`,
  };
}

async function loadReferencedAvatarPaths(env: Env, tenantId: string): Promise<Set<string>> {
  const sources = await resolveTenantUserStoreSourcesFromEnv(env, tenantId);
  const pii = ensureDatabaseAdapter(sources.piiDb, `avatar-orphan-cleanup:${tenantId}`);
  const rows = await pii.query<{ value_json: string | null }>(
    `SELECT value_json
     FROM identity_sensitive_values
     WHERE tenant_id = ?
       AND owner_type = 'runtime_user'
       AND value_key = 'picture'
       AND lifecycle_state = 'active'`,
    [tenantId]
  );
  const paths = new Set<string>();
  for (const row of rows) {
    if (!row.value_json) continue;
    try {
      const value = JSON.parse(row.value_json) as unknown;
      if (typeof value === 'string') {
        const url = new URL(value);
        if (/^\/api\/avatars\/[A-Za-z0-9._-]+$/u.test(url.pathname)) {
          paths.add(url.pathname);
        }
      }
    } catch {
      // Malformed or non-URL picture values are not owned avatar references.
    }
  }
  return paths;
}

async function loadLoginUiSettingsJson(env: Env, tenantId: string): Promise<string> {
  const manager = createSettingsManager({
    env: env as unknown as Record<string, string | undefined>,
    kv: env.SETTINGS ?? null,
    cacheTTL: 0,
  });
  manager.registerCategory(LOGIN_UI_CATEGORY_META);
  const result = await manager.getAll('login-ui', { type: 'tenant', id: tenantId });
  return JSON.stringify(result.values);
}

export async function cleanupOrphanedPublicAssets(env: Env): Promise<Record<string, unknown>> {
  if (!env.PUBLIC_ASSETS || !env.AUTHRIM_CONFIG) {
    throw new Error('public_asset_orphan_cleanup_unavailable');
  }
  const cursor = (await env.AUTHRIM_CONFIG.get(PUBLIC_ASSET_CURSOR_KEY))?.trim() || undefined;
  const listed = await env.PUBLIC_ASSETS.list({
    limit: OBJECT_SCAN_BATCH_SIZE,
    cursor,
  });
  const settingsCache = new Map<string, string>();
  const avatarReferenceCache = new Map<string, Set<string> | null>();
  let deleted = 0;
  let referenced = 0;
  let young = 0;
  let skipped = 0;
  let failures = 0;
  const cutoff = Date.now() - PUBLIC_ASSET_ORPHAN_GRACE_MS;

  for (const object of listed.objects) {
    const parsed = parseLoginUiAssetKey(object.key);
    const avatar = parseAvatarAssetKey(object.key);
    if (!parsed && !avatar) {
      skipped += 1;
      continue;
    }
    if (!(object.uploaded instanceof Date) || object.uploaded.getTime() > cutoff) {
      young += 1;
      continue;
    }
    try {
      if (parsed) {
        let settingsJson = settingsCache.get(parsed.tenantId);
        if (settingsJson === undefined) {
          settingsJson = await loadLoginUiSettingsJson(env, parsed.tenantId);
          settingsCache.set(parsed.tenantId, settingsJson);
        }
        if (settingsJson.includes(parsed.publicUrl)) {
          referenced += 1;
          continue;
        }
      } else if (avatar) {
        let avatarReferences = avatarReferenceCache.get(avatar.tenantId);
        if (avatarReferences === undefined) {
          try {
            avatarReferences = await loadReferencedAvatarPaths(env, avatar.tenantId);
          } catch {
            avatarReferences = null;
          }
          avatarReferenceCache.set(avatar.tenantId, avatarReferences);
        }
        if (avatarReferences === null) {
          failures += 1;
          continue;
        }
        if (avatarReferences.has(avatar.publicPath)) {
          referenced += 1;
          continue;
        }
      }
      await env.PUBLIC_ASSETS.delete(object.key);
      deleted += 1;
    } catch {
      failures += 1;
    }
  }

  const nextCursor = listed.truncated ? (listed.cursor ?? '') : '';
  if (nextCursor) {
    await env.AUTHRIM_CONFIG.put(PUBLIC_ASSET_CURSOR_KEY, nextCursor);
  } else {
    await env.AUTHRIM_CONFIG.delete(PUBLIC_ASSET_CURSOR_KEY);
  }
  const result = {
    scanned: listed.objects.length,
    deleted,
    referenced,
    young,
    skipped,
    failures,
    cursor: nextCursor || null,
  };
  if (failures > 0) {
    throw new MaintenancePartialFailure('public_asset_orphan_cleanup_partial_failure', result);
  }
  return result;
}

export async function cleanupOrphanedAuditTransientPayloads(
  env: Env
): Promise<Record<string, unknown>> {
  if (!env.AUDIT_ARCHIVE || !env.AUTHRIM_CONFIG || !env.DB_ADMIN) {
    throw new Error('audit_transient_orphan_cleanup_unavailable');
  }
  const prefixes = ['logging-delivery-payloads/v1/', 'message-jobs/'] as const;
  const rawCursor = (await env.AUTHRIM_CONFIG.get(AUDIT_TRANSIENT_CURSOR_KEY))?.trim() ?? '';
  const cursor = parseJson<AuditTransientCursor>(rawCursor) ?? {
    prefixIndex: 0,
    objectCursor: rawCursor || null,
  };
  const cutoff = Date.now() - AUDIT_TRANSIENT_ORPHAN_GRACE_MS;
  const admin = ensureDatabaseAdapter(env.DB_ADMIN, 'audit-transient-orphan-cleanup');
  let scanned = 0;
  let deleted = 0;
  let retainedActive = 0;
  for (; cursor.prefixIndex < prefixes.length; cursor.prefixIndex += 1) {
    const listed = await env.AUDIT_ARCHIVE.list({
      prefix: prefixes[cursor.prefixIndex],
      limit: OBJECT_SCAN_BATCH_SIZE,
      cursor: cursor.objectCursor ?? undefined,
    });
    scanned += listed.objects.length;
    let expiredKeys = listed.objects
      .filter((object) => object.uploaded instanceof Date && object.uploaded.getTime() <= cutoff)
      .map((object) => object.key);
    if (prefixes[cursor.prefixIndex] === 'message-jobs/' && expiredKeys.length > 0) {
      const placeholders = expiredKeys.map(() => '?').join(', ');
      const activeRows = await admin.query<{ payload_object_ref: string }>(
        `SELECT payload_object_ref
         FROM logging_message_jobs
         WHERE payload_object_ref IN (${placeholders})
           AND status IN ('queued', 'claimed', 'running', 'retrying', 'blocked')`,
        expiredKeys
      );
      const activeRefs = new Set(activeRows.map((row) => row.payload_object_ref));
      retainedActive += activeRefs.size;
      expiredKeys = expiredKeys.filter((key) => !activeRefs.has(key));
    }
    if (expiredKeys.length > 0) {
      await env.AUDIT_ARCHIVE.delete(expiredKeys);
      deleted += expiredKeys.length;
    }
    if (listed.truncated && listed.cursor) {
      cursor.objectCursor = listed.cursor;
      await env.AUTHRIM_CONFIG.put(AUDIT_TRANSIENT_CURSOR_KEY, JSON.stringify(cursor));
      return { scanned, deleted, retained: scanned - deleted, retainedActive, cursor };
    }
    cursor.objectCursor = null;
  }
  await env.AUTHRIM_CONFIG.delete(AUDIT_TRANSIENT_CURSOR_KEY);
  return {
    scanned,
    deleted,
    retained: scanned - deleted,
    retainedActive,
    cursor: null,
  };
}

function retentionPolicy(binding: MetricBucketBinding): { label: string; cutoffMs: number | null } {
  if (binding === 'DIAGNOSTIC_LOGS') {
    return { label: 'Tenant-configured; 30 days by default', cutoffMs: null };
  }
  if (binding === 'IMPORT_ARTIFACTS') {
    return {
      label: 'Terminal jobs: immediate; orphan uploads: 24 hours',
      cutoffMs: 24 * 60 * 60 * 1000,
    };
  }
  if (binding === 'PUBLIC_ASSETS') {
    return {
      label: 'Referenced objects retained; unreferenced objects removed after 24 hours',
      cutoffMs: null,
    };
  }
  return { label: 'Object-catalog and policy managed', cutoffMs: null };
}

function encryptionMethod(
  binding: MetricBucketBinding,
  object: R2Object & { customMetadata?: Record<string, string> }
): string {
  if (object.customMetadata?.encryption === 'authrim-object-envelope-v1') {
    return 'authrim-object-envelope-v1';
  }
  if (object.customMetadata?.keyVersion || object.customMetadata?.encryptionAlgorithm) {
    return 'authrim-log-chunk-encryption';
  }
  if (binding === 'PUBLIC_ASSETS') return 'public-object';
  if (binding === 'DIAGNOSTIC_LOGS') return 'privacy-sanitized-plaintext';
  if (binding === 'IMPORT_ARTIFACTS') return 'private-plaintext-csv';
  return 'legacy-plaintext-or-unclassified';
}

function emptyAccumulator(binding: MetricBucketBinding): MetricScanAccumulator {
  return {
    binding,
    objectCount: 0,
    totalBytes: 0,
    oldestObjectAt: null,
    encryptionMethods: {},
    retentionOverdueObjects: retentionPolicy(binding).cutoffMs === null ? null : 0,
    retentionPolicy: retentionPolicy(binding).label,
    cursor: null,
  };
}

async function scanBucketMetric(
  env: Env,
  binding: MetricBucketBinding,
  bucket: R2Bucket,
  nowMs: number
): Promise<R2BucketOperationalMetric> {
  const accumulatorKey = `${R2_METRICS_SCAN_PREFIX}${binding}`;
  const stored = env.AUTHRIM_CONFIG
    ? parseJson<MetricScanAccumulator>(await env.AUTHRIM_CONFIG.get(accumulatorKey))
    : null;
  const accumulator = stored ?? emptyAccumulator(binding);
  const listOptions = {
    limit: 1000,
    cursor: accumulator.cursor ?? undefined,
    include: ['customMetadata'] as const,
  };
  const listed = await bucket.list(listOptions);
  const policy = retentionPolicy(binding);
  for (const object of listed.objects) {
    const uploadedAt = object.uploaded instanceof Date ? object.uploaded.getTime() : nowMs;
    accumulator.objectCount += 1;
    accumulator.totalBytes += object.size;
    accumulator.oldestObjectAt =
      accumulator.oldestObjectAt === null
        ? uploadedAt
        : Math.min(accumulator.oldestObjectAt, uploadedAt);
    const method = encryptionMethod(binding, object);
    accumulator.encryptionMethods[method] = (accumulator.encryptionMethods[method] ?? 0) + 1;
    if (
      policy.cutoffMs !== null &&
      uploadedAt <= nowMs - policy.cutoffMs &&
      accumulator.retentionOverdueObjects !== null
    ) {
      accumulator.retentionOverdueObjects += 1;
    }
  }
  accumulator.cursor = listed.truncated ? (listed.cursor ?? null) : null;
  const metric: R2BucketOperationalMetric = {
    binding,
    objectCount: accumulator.objectCount,
    totalBytes: accumulator.totalBytes,
    oldestObjectAt: accumulator.oldestObjectAt,
    encryptionMethods: accumulator.encryptionMethods,
    retentionOverdueObjects: accumulator.retentionOverdueObjects,
    retentionPolicy: accumulator.retentionPolicy,
    scanComplete: !listed.truncated,
    measuredAt: nowMs,
  };
  if (env.AUTHRIM_CONFIG) {
    if (listed.truncated) {
      await env.AUTHRIM_CONFIG.put(accumulatorKey, JSON.stringify(accumulator));
    } else {
      await env.AUTHRIM_CONFIG.delete(accumulatorKey);
    }
  }
  return metric;
}

export async function scanR2Metrics(env: Env): Promise<Record<string, unknown>> {
  if (!env.AUTHRIM_CONFIG) throw new Error('r2_metrics_state_store_unavailable');
  const nowMs = Date.now();
  const metrics: R2BucketOperationalMetric[] = [];
  for (const binding of METRIC_BUCKETS) {
    const bucket = env[binding];
    if (bucket) {
      metrics.push(await scanBucketMetric(env, binding, bucket, nowMs));
    }
  }
  await env.AUTHRIM_CONFIG.put(R2_METRICS_KEY, JSON.stringify(metrics));
  if (env.CONTROL?.reportR2BucketMetrics) {
    await env.CONTROL.reportR2BucketMetrics({ metrics });
  }
  return {
    bucketCount: metrics.length,
    completeBucketCount: metrics.filter((metric) => metric.scanComplete).length,
  };
}

export async function processR2StorageMaintenance(env: Env, log: MaintenanceLogger): Promise<void> {
  await runTrackedTask(env, 'r2_diagnostic_log_retention', () => cleanupDiagnosticLogs(env), log);
  await runTrackedTask(
    env,
    'r2_import_artifact_cleanup',
    async () => ({ ...(await cleanupOrphanedUserImportUploads(env, log)) }),
    log
  );
  await runTrackedTask(
    env,
    'r2_public_asset_orphan_cleanup',
    () => cleanupOrphanedPublicAssets(env),
    log
  );
  await runTrackedTask(
    env,
    'r2_audit_transient_orphan_cleanup',
    () => cleanupOrphanedAuditTransientPayloads(env),
    log
  );
  await runTrackedTask(env, 'r2_bucket_metrics_scan', () => scanR2Metrics(env), log);
}

export async function deleteTenantPublicAssets(env: Env, tenantId: string): Promise<number> {
  if (!env.PUBLIC_ASSETS) return 0;
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(tenantId)) {
    throw new Error('tenant_public_asset_cleanup_invalid_tenant');
  }
  let deleted = 0;
  for (const prefix of [`public/${tenantId}/`, `avatars/${tenantId}/`]) {
    let cursor: string | undefined;
    do {
      const listed = await env.PUBLIC_ASSETS.list({ prefix, limit: 1000, cursor });
      if (listed.objects.length > 0) {
        await env.PUBLIC_ASSETS.delete(listed.objects.map((object) => object.key));
        deleted += listed.objects.length;
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }
  return deleted;
}

export async function getR2MaintenanceDashboard(env: Env): Promise<{
  schedules: R2MaintenanceScheduleView[];
  storageMetrics: R2BucketOperationalMetric[];
}> {
  const now = Date.now();
  const schedules = await Promise.all(
    TASKS.map(async (task): Promise<R2MaintenanceScheduleView> => {
      const availability = taskAvailability(env, task.id);
      const state = await readTaskState(env, task.id);
      return {
        id: task.id,
        name: task.name,
        enabled: availability.enabled,
        cron: R2_STORAGE_MAINTENANCE_CRON,
        nextRunAt: availability.enabled ? nextMaintenanceRunAt(now) : null,
        disabledReason: availability.reason,
        status: availability.enabled ? (state?.status ?? 'never_run') : 'disabled',
        lastStartedAt: state?.lastStartedAt ?? null,
        lastCompletedAt: state?.lastCompletedAt ?? null,
        lastErrorCode: state?.lastErrorCode ?? null,
        lastResult: state?.lastResult ?? null,
      };
    })
  );
  const localMetrics = env.AUTHRIM_CONFIG
    ? (parseJson<R2BucketOperationalMetric[]>(await env.AUTHRIM_CONFIG.get(R2_METRICS_KEY)) ?? [])
    : [];
  let storageMetrics: R2BucketOperationalMetric[] = withPendingFleetMetrics(
    localMetrics,
    'control_metrics_unavailable'
  );
  if (env.CONTROL?.getR2BucketMetrics) {
    try {
      const inventory = await env.CONTROL.getR2BucketMetrics();
      storageMetrics = inventory.metrics;
    } catch {
      storageMetrics = withPendingFleetMetrics(localMetrics, 'control_metrics_unavailable');
    }
  }
  return { schedules, storageMetrics };
}
