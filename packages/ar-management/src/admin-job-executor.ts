import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import { resolveAuthCorePersistenceAdapterFromEnv } from '@authrim/ar-lib-core';
import { materializeEncryptedObjectArtifact } from './object-artifact-materialization';

type AdminJobStatus = 'processing' | 'completed' | 'partial_failure';
type AdminJobResultDelivery = 'auto' | 'inline' | 'artifact';

const INLINE_RESULT_MAX_BYTES = 32 * 1024;
const DEFAULT_JOB_MAX_ATTEMPTS = 3;
const DEFAULT_JOB_BATCH_SIZE = 500;
const MAX_JOB_BATCH_SIZE = 1000;
const RETRY_BACKOFF_SECONDS = [60, 300, 900] as const;

export interface AdminJobRow {
  id: string;
  tenant_id: string;
  job_type: string;
  status: string;
  progress: string | null;
  config: string | null;
  created_at: number;
  attempt_count?: number | null;
  max_attempts?: number | null;
  next_run_at?: number | null;
}

interface AdminJobLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>, err?: Error) => void;
}

interface AdminJobProcessorResult {
  status: AdminJobStatus;
  progress: Record<string, unknown>;
  result?: Record<string, unknown>;
  nextRunAt?: number | null;
}

type AdminJobProcessor = (
  env: Env,
  adapter: DatabaseAdapter,
  job: AdminJobRow
) => Promise<AdminJobProcessorResult>;

const GENERIC_ADMIN_JOB_TYPES = [
  'users/bulk-update',
  'reports/generate',
  'organizations/bulk-members',
] as const;

type GenericAdminJobType = (typeof GENERIC_ADMIN_JOB_TYPES)[number];

const USER_BULK_UPDATE_COLUMNS = {
  status: {
    sql: 'status',
    normalize(value: unknown): string {
      if (value === 'active' || value === 'suspended' || value === 'locked') return value;
      throw new Error('Invalid status value');
    },
  },
  lifecycle_state: {
    sql: 'lifecycle_state',
    normalize(value: unknown): string {
      const allowed = new Set([
        'invited',
        'pending_verification',
        'provisioning',
        'incomplete',
        'active',
        'dormant',
        'archived',
        'deprovisioned',
      ]);
      if (typeof value === 'string' && allowed.has(value)) return value;
      throw new Error('Invalid lifecycle_state value');
    },
  },
  is_active: {
    sql: 'is_active',
    normalize(value: unknown): number {
      if (value === true || value === 1) return 1;
      if (value === false || value === 0) return 0;
      throw new Error('Invalid is_active value');
    },
  },
} as const;

const USER_BULK_FILTER_COLUMNS = {
  status: USER_BULK_UPDATE_COLUMNS.status,
  lifecycle_state: USER_BULK_UPDATE_COLUMNS.lifecycle_state,
  is_active: USER_BULK_UPDATE_COLUMNS.is_active,
  user_type: {
    sql: 'user_type',
    normalize(value: unknown): string {
      if (value === 'end_user' || value === 'admin' || value === 'm2m') return value;
      throw new Error('Invalid user_type filter value');
    },
  },
  pii_status: {
    sql: 'pii_status',
    normalize(value: unknown): string {
      const allowed = new Set(['none', 'pending', 'active', 'failed', 'deleted']);
      if (typeof value === 'string' && allowed.has(value)) return value;
      throw new Error('Invalid pii_status filter value');
    },
  },
  email_verified: {
    sql: 'email_verified',
    normalize(value: unknown): number {
      if (value === true || value === 1) return 1;
      if (value === false || value === 0) return 0;
      throw new Error('Invalid email_verified filter value');
    },
  },
  phone_number_verified: {
    sql: 'phone_number_verified',
    normalize(value: unknown): number {
      if (value === true || value === 1) return 1;
      if (value === false || value === 0) return 0;
      throw new Error('Invalid phone_number_verified filter value');
    },
  },
} as const;

export interface BulkUserUpdateConfig {
  fields: string[];
  filter?: Record<string, unknown>;
  values: Record<string, unknown>;
  dry_run?: boolean;
  batch_size?: number;
  result_delivery?: AdminJobResultDelivery;
}

interface BulkUserUpdateProgress {
  total?: number;
  processed?: number;
  succeeded?: number;
  failed?: number;
  stage?: string;
  cursor?: string | null;
  dry_run?: boolean;
}

export interface ReportGenerateConfig {
  type: 'user_activity' | 'access_summary' | 'compliance_audit' | 'security_events';
  from_date: string;
  to_date: string;
  format?: 'json' | 'csv';
  filters?: Record<string, unknown>;
  result_delivery?: AdminJobResultDelivery;
}

export interface OrganizationBulkMembersConfig {
  organization_id: string;
  organization_name?: string;
  action: 'add' | 'remove';
  role?: string;
  user_ids: string[];
  result_delivery?: AdminJobResultDelivery;
}

function normalizeResultDelivery(value: unknown): AdminJobResultDelivery {
  if (value === undefined || value === null) return 'auto';
  if (value === 'auto' || value === 'inline' || value === 'artifact') return value;
  throw new Error('Invalid result_delivery value');
}

function parseJsonConfig<T>(job: AdminJobRow): T {
  if (!job.config) throw new Error('Job config is missing');
  return JSON.parse(job.config) as T;
}

function parseJsonProgress<T>(job: AdminJobRow): T | null {
  if (!job.progress) return null;
  try {
    return JSON.parse(job.progress) as T;
  } catch {
    return null;
  }
}

function buildUserFilterWhere(
  tenantId: string,
  filter: Record<string, unknown> | undefined
): { whereSql: string; params: unknown[] } {
  const clauses = ['tenant_id = ?'];
  const params: unknown[] = [tenantId];
  for (const [key, value] of Object.entries(filter ?? {})) {
    const column = USER_BULK_FILTER_COLUMNS[key as keyof typeof USER_BULK_FILTER_COLUMNS];
    if (!column) {
      throw new Error(`Unsupported user filter field: ${key}`);
    }
    clauses.push(`${column.sql} = ?`);
    params.push(column.normalize(value));
  }
  return { whereSql: clauses.join(' AND '), params };
}

export function validateBulkUserUpdateConfig(config: BulkUserUpdateConfig): void {
  if (!Array.isArray(config.fields) || config.fields.length === 0) {
    throw new Error('fields must include at least one field');
  }
  for (const field of config.fields) {
    const column = USER_BULK_UPDATE_COLUMNS[field as keyof typeof USER_BULK_UPDATE_COLUMNS];
    if (!column) throw new Error(`Unsupported user update field: ${field}`);
    if (!Object.prototype.hasOwnProperty.call(config.values, field)) {
      throw new Error(`Missing value for user update field: ${field}`);
    }
    column.normalize(config.values[field]);
  }
  if (config.batch_size !== undefined) {
    if (
      !Number.isInteger(config.batch_size) ||
      config.batch_size < 1 ||
      config.batch_size > MAX_JOB_BATCH_SIZE
    ) {
      throw new Error(`batch_size must be an integer from 1 to ${MAX_JOB_BATCH_SIZE}`);
    }
  }
  buildUserFilterWhere('tenant-validation', config.filter);
}

export async function countBulkUserUpdateTargets(
  adapter: DatabaseAdapter,
  tenantId: string,
  config: BulkUserUpdateConfig
): Promise<number> {
  validateBulkUserUpdateConfig(config);
  const filter = buildUserFilterWhere(tenantId, config.filter);
  const row = await adapter.queryOne<{ count: number }>(
    `SELECT COUNT(*) as count FROM users_core WHERE ${filter.whereSql}`,
    filter.params
  );
  return row?.count ?? 0;
}

async function processBulkUserUpdateJob(
  _env: Env,
  adapter: DatabaseAdapter,
  job: AdminJobRow
): Promise<AdminJobProcessorResult> {
  const config = parseJsonConfig<BulkUserUpdateConfig>(job);
  validateBulkUserUpdateConfig(config);
  const filter = buildUserFilterWhere(job.tenant_id, config.filter);
  const total = await countBulkUserUpdateTargets(adapter, job.tenant_id, config);
  const nowTs = Math.floor(Date.now() / 1000);

  if (config.dry_run) {
    return {
      status: 'completed',
      progress: { total, processed: total, succeeded: total, failed: 0, stage: 'dry_run' },
      result: {
        summary: { total, processed: total, succeeded: total, failed: 0, dry_run: true },
        updated_fields: config.fields,
      },
    };
  }

  const previous = parseJsonProgress<BulkUserUpdateProgress>(job) ?? {};
  const batchSize = Math.min(config.batch_size ?? DEFAULT_JOB_BATCH_SIZE, MAX_JOB_BATCH_SIZE);
  const cursor = typeof previous.cursor === 'string' ? previous.cursor : null;
  const selectionClauses = [filter.whereSql];
  const selectionParams = [...filter.params];
  if (cursor) {
    selectionClauses.push('id > ?');
    selectionParams.push(cursor);
  }

  const selected = await adapter.query<{ id: string }>(
    `SELECT id FROM users_core
      WHERE ${selectionClauses.join(' AND ')}
      ORDER BY id ASC
      LIMIT ?`,
    [...selectionParams, batchSize]
  );

  if (selected.length === 0) {
    const processed = previous.processed ?? 0;
    const succeeded = previous.succeeded ?? 0;
    return {
      status: 'completed',
      progress: {
        total,
        processed,
        succeeded,
        failed: previous.failed ?? 0,
        stage: 'completed',
        cursor,
      },
      result: {
        summary: { total, processed, succeeded, failed: previous.failed ?? 0, dry_run: false },
        updated_fields: config.fields,
      },
    };
  }

  const assignments: string[] = [];
  const values: unknown[] = [];
  for (const field of config.fields) {
    const column = USER_BULK_UPDATE_COLUMNS[field as keyof typeof USER_BULK_UPDATE_COLUMNS];
    assignments.push(`${column.sql} = ?`);
    values.push(column.normalize(config.values[field]));
  }
  assignments.push('updated_at = ?');
  values.push(nowTs);

  const ids = selected.map((row) => row.id);
  const idPlaceholders = ids.map(() => '?').join(', ');
  const updateResult = await adapter.execute(
    `UPDATE users_core SET ${assignments.join(', ')} WHERE tenant_id = ? AND id IN (${idPlaceholders})`,
    [...values, job.tenant_id, ...ids]
  );
  const batchSucceeded = updateResult.rowsAffected ?? selected.length;
  const processed = (previous.processed ?? 0) + selected.length;
  const succeeded = (previous.succeeded ?? 0) + batchSucceeded;
  const failed = previous.failed ?? 0;
  const nextCursor = ids[ids.length - 1] ?? cursor;
  const completed = selected.length < batchSize || processed >= total;
  const progress = {
    total,
    processed,
    succeeded,
    failed,
    stage: completed ? 'completed' : 'processing',
    cursor: nextCursor,
    batch_size: batchSize,
  };

  return {
    status: completed ? 'completed' : 'processing',
    progress,
    nextRunAt: completed ? null : Math.floor(Date.now() / 1000),
    ...(completed
      ? {
          result: {
            summary: { total, processed, succeeded, failed, dry_run: false },
            updated_fields: config.fields,
          },
        }
      : {}),
  };
}

function toUnixSeconds(value: string): number {
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) throw new Error(`Invalid report date: ${value}`);
  return Math.floor(ts / 1000);
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0] ?? {});
  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => escape(row[header])).join(',')),
  ].join('\n');
}

async function processReportGenerateJob(
  _env: Env,
  adapter: DatabaseAdapter,
  job: AdminJobRow
): Promise<AdminJobProcessorResult> {
  const config = parseJsonConfig<ReportGenerateConfig>(job);
  const fromTs = toUnixSeconds(config.from_date);
  const toTs = toUnixSeconds(config.to_date);
  if (fromTs > toTs) throw new Error('from_date must be before to_date');

  let rows: Array<Record<string, unknown>>;
  switch (config.type) {
    case 'user_activity':
      rows = await adapter.query<Record<string, unknown>>(
        `SELECT status, COUNT(*) as count
           FROM users_core
          WHERE tenant_id = ? AND created_at >= ? AND created_at <= ?
          GROUP BY status
          ORDER BY status ASC`,
        [job.tenant_id, fromTs, toTs]
      );
      break;
    case 'access_summary':
      rows = [
        {
          metric: 'organizations',
          count:
            (
              await adapter.queryOne<{ count: number }>(
                'SELECT COUNT(*) as count FROM organizations WHERE tenant_id = ?',
                [job.tenant_id]
              )
            )?.count ?? 0,
        },
        {
          metric: 'organization_memberships',
          count:
            (
              await adapter.queryOne<{ count: number }>(
                'SELECT COUNT(*) as count FROM subject_org_membership WHERE tenant_id = ?',
                [job.tenant_id]
              )
            )?.count ?? 0,
        },
      ];
      break;
    case 'compliance_audit':
      rows = await adapter.query<Record<string, unknown>>(
        `SELECT job_type, status, COUNT(*) as count
           FROM admin_jobs
          WHERE tenant_id = ? AND created_at >= ? AND created_at <= ?
          GROUP BY job_type, status
          ORDER BY job_type ASC, status ASC`,
        [job.tenant_id, fromTs, toTs]
      );
      break;
    case 'security_events':
      rows = await adapter.query<Record<string, unknown>>(
        `SELECT severity, COUNT(*) as count
           FROM suspicious_activities
          WHERE tenant_id = ? AND created_at >= ? AND created_at <= ?
          GROUP BY severity
          ORDER BY severity ASC`,
        [job.tenant_id, fromTs, toTs]
      );
      break;
    default:
      throw new Error(`Unsupported report type: ${(config as { type: string }).type}`);
  }

  const format = config.format ?? 'json';
  return {
    status: 'completed',
    progress: {
      total: rows.length,
      processed: rows.length,
      succeeded: rows.length,
      failed: 0,
      stage: 'completed',
    },
    result: {
      summary: { total_rows: rows.length, report_type: config.type, format },
      report: {
        type: config.type,
        from_date: config.from_date,
        to_date: config.to_date,
        format,
        rows,
        ...(format === 'csv' ? { content: toCsv(rows), content_type: 'text/csv' } : {}),
      },
    },
  };
}

function normalizeMembershipType(role: string | undefined): 'member' | 'admin' | 'owner' {
  if (role === undefined || role === '') return 'member';
  if (role === 'member' || role === 'admin' || role === 'owner') return role;
  throw new Error('Invalid organization membership role');
}

async function processOrganizationBulkMembersJob(
  _env: Env,
  adapter: DatabaseAdapter,
  job: AdminJobRow
): Promise<AdminJobProcessorResult> {
  const config = parseJsonConfig<OrganizationBulkMembersConfig>(job);
  const membershipType = normalizeMembershipType(config.role);
  const org = await adapter.queryOne<{ id: string }>(
    'SELECT id FROM organizations WHERE id = ? AND tenant_id = ?',
    [config.organization_id, job.tenant_id]
  );
  if (!org) throw new Error('Organization does not belong to the job tenant');

  let succeeded = 0;
  let skipped = 0;
  const failures: Array<{ user_id: string; error: string }> = [];
  const nowTs = Math.floor(Date.now() / 1000);

  for (const userId of config.user_ids) {
    const user = await adapter.queryOne<{ id: string }>(
      'SELECT id FROM users_core WHERE id = ? AND tenant_id = ?',
      [userId, job.tenant_id]
    );
    if (!user) {
      failures.push({ user_id: userId, error: 'user_not_found' });
      continue;
    }

    const existing = await adapter.queryOne<{ id: string }>(
      `SELECT id FROM subject_org_membership
       WHERE tenant_id = ? AND org_id = ? AND subject_id = ?`,
      [job.tenant_id, config.organization_id, userId]
    );

    if (config.action === 'add') {
      if (existing) {
        failures.push({ user_id: userId, error: 'membership_already_exists' });
        continue;
      }
      await adapter.execute(
        `INSERT INTO subject_org_membership (
          id, tenant_id, subject_id, org_id, membership_type, is_primary, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
        [
          crypto.randomUUID(),
          job.tenant_id,
          userId,
          config.organization_id,
          membershipType,
          nowTs,
          nowTs,
        ]
      );
      succeeded += 1;
      continue;
    }

    if (!existing) {
      skipped += 1;
      continue;
    }
    await adapter.execute(
      'DELETE FROM subject_org_membership WHERE tenant_id = ? AND org_id = ? AND subject_id = ?',
      [job.tenant_id, config.organization_id, userId]
    );
    succeeded += 1;
  }

  const total = config.user_ids.length;
  const failed = failures.length;
  return {
    status: failed > 0 ? 'partial_failure' : 'completed',
    progress: { total, processed: total, succeeded, failed, skipped, stage: 'completed' },
    result: {
      summary: { total, processed: total, succeeded, failed, skipped, action: config.action },
      organization_id: config.organization_id,
      organization_name: config.organization_name,
      failures,
    },
  };
}

const ADMIN_JOB_PROCESSORS: Record<GenericAdminJobType, AdminJobProcessor> = {
  'users/bulk-update': processBulkUserUpdateJob,
  'reports/generate': processReportGenerateJob,
  'organizations/bulk-members': processOrganizationBulkMembersJob,
};

function getJobResultDelivery(job: AdminJobRow): AdminJobResultDelivery {
  const parsed = job.config ? (JSON.parse(job.config) as { result_delivery?: unknown }) : {};
  return normalizeResultDelivery(parsed.result_delivery);
}

function buildGenericJobResultKey(job: AdminJobRow): string {
  const safeJobType = job.job_type.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return `exports/${job.tenant_id}/admin-jobs/${safeJobType}/${job.id}/result.json`;
}

async function finalizeGenericJobResult(
  env: Env,
  adapter: DatabaseAdapter,
  job: AdminJobRow,
  processorResult: AdminJobProcessorResult
): Promise<{
  resultJson: string;
  resultR2Key: string | null;
  objectCatalogId: string | null;
}> {
  if (!processorResult.result) {
    throw new Error('Completed job result is missing');
  }

  const payload = JSON.stringify(processorResult.result);
  const delivery = getJobResultDelivery(job);
  const shouldMaterialize =
    delivery === 'artifact' ||
    (delivery === 'auto' && new TextEncoder().encode(payload).byteLength > INLINE_RESULT_MAX_BYTES);

  if (!shouldMaterialize) {
    return {
      resultJson: payload,
      resultR2Key: null,
      objectCatalogId: null,
    };
  }

  if (!env.EXPORT_ARTIFACTS) {
    if (delivery === 'artifact') {
      throw new Error('EXPORT_ARTIFACTS binding is required for artifact result delivery');
    }
    return {
      resultJson: payload,
      resultR2Key: null,
      objectCatalogId: null,
    };
  }

  if (!env.OBJECT_ENCRYPTION_ROOT_KEY) {
    if (delivery === 'artifact') {
      throw new Error('OBJECT_ENCRYPTION_ROOT_KEY is required for artifact result delivery');
    }
    return {
      resultJson: payload,
      resultR2Key: null,
      objectCatalogId: null,
    };
  }

  const key = buildGenericJobResultKey(job);
  const keyVersion = Number.parseInt(env.OBJECT_ENCRYPTION_KEY_VERSION || '1', 10) || 1;
  const artifact = await materializeEncryptedObjectArtifact(adapter, env.EXPORT_ARTIFACTS, {
    tenantId: job.tenant_id,
    objectClass: 'admin_job_result',
    representation: 'canonical_json',
    objectKeyBase: key,
    content: payload,
    contentType: 'application/json',
    rootKeyHex: env.OBJECT_ENCRYPTION_ROOT_KEY,
    keyVersion,
  });

  return {
    resultJson: JSON.stringify({
      summary: processorResult.result.summary,
      artifact_id: artifact.publicArtifactId,
      result_r2_key: artifact.primaryObjectKey,
      delivery: 'artifact',
    }),
    resultR2Key: artifact.primaryObjectKey,
    objectCatalogId: artifact.catalogId,
  };
}

function getMaxAttempts(job: AdminJobRow): number {
  const value = job.max_attempts;
  return typeof value === 'number' && value > 0 ? value : DEFAULT_JOB_MAX_ATTEMPTS;
}

function getAttemptCount(job: AdminJobRow): number {
  const value = job.attempt_count;
  return typeof value === 'number' && value >= 0 ? value : 0;
}

function getRetryDelaySeconds(attemptCount: number): number {
  return RETRY_BACKOFF_SECONDS[Math.min(attemptCount, RETRY_BACKOFF_SECONDS.length - 1)];
}

function buildFailureResult(job: AdminJobRow, error: unknown, attemptCount: number) {
  const message = error instanceof Error ? error.message : String(error);
  return JSON.stringify({
    summary: {
      total: 1,
      processed: 1,
      succeeded: 0,
      failed: 1,
      attempts: attemptCount,
    },
    logs: [
      {
        timestamp: new Date().toISOString(),
        level: 'error',
        code: 'job_processor_error',
        message,
      },
    ],
    job_type: job.job_type,
  });
}

export async function processPendingGenericAdminJobs(
  env: Env,
  logger: AdminJobLogger
): Promise<void> {
  const adapter = await resolveAuthCorePersistenceAdapterFromEnv(env, 'management-generic-jobs');
  const nowTs = Math.floor(Date.now() / 1000);
  const staleCutoffTs = nowTs - 15 * 60;
  const placeholders = GENERIC_ADMIN_JOB_TYPES.map(() => '?').join(', ');
  const jobs = await adapter.query<AdminJobRow>(
    `SELECT id, tenant_id, job_type, status, progress, config, created_at,
            COALESCE(attempt_count, 0) AS attempt_count,
            COALESCE(max_attempts, ?) AS max_attempts,
            next_run_at
       FROM admin_jobs
      WHERE job_type IN (${placeholders})
        AND (
          (status = 'pending' AND (next_run_at IS NULL OR next_run_at <= ?))
          OR (status = 'processing' AND (next_run_at IS NOT NULL AND next_run_at <= ?))
          OR (status = 'processing' AND updated_at < ?)
        )
      ORDER BY created_at ASC
      LIMIT 5`,
    [DEFAULT_JOB_MAX_ATTEMPTS, ...GENERIC_ADMIN_JOB_TYPES, nowTs, nowTs, staleCutoffTs]
  );

  for (const job of jobs) {
    const processor = ADMIN_JOB_PROCESSORS[job.job_type as GenericAdminJobType];
    if (!processor) continue;

    const startedTs = Math.floor(Date.now() / 1000);
    const transition = await adapter.execute(
      `UPDATE admin_jobs
          SET status = 'processing', started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE id = ? AND tenant_id = ?
          AND (
            (status = 'pending' AND (next_run_at IS NULL OR next_run_at <= ?))
            OR (status = 'processing' AND (next_run_at IS NOT NULL AND next_run_at <= ?))
            OR (status = 'processing' AND updated_at < ?)
          )`,
      [startedTs, startedTs, job.id, job.tenant_id, startedTs, startedTs, staleCutoffTs]
    );
    if (transition.rowsAffected === 0) continue;

    try {
      const result = await processor(env, adapter, job);
      if (result.status === 'processing') {
        const continuationTs = Math.floor(Date.now() / 1000);
        await adapter.execute(
          `UPDATE admin_jobs
              SET status = 'processing', progress = ?, next_run_at = ?, updated_at = ?
            WHERE id = ? AND tenant_id = ?`,
          [
            JSON.stringify(result.progress),
            result.nextRunAt ?? continuationTs,
            continuationTs,
            job.id,
            job.tenant_id,
          ]
        );
        logger.info('Generic admin job chunk completed', {
          job_id: job.id,
          tenant_id: job.tenant_id,
          job_type: job.job_type,
        });
        continue;
      }

      const finalized = await finalizeGenericJobResult(env, adapter, job, result);
      const completedTs = Math.floor(Date.now() / 1000);
      await adapter.execute(
        `UPDATE admin_jobs
            SET status = ?, progress = ?, result = ?, result_r2_key = COALESCE(?, result_r2_key),
                object_catalog_id = COALESCE(?, object_catalog_id),
                next_run_at = NULL, completed_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?`,
        [
          result.status,
          JSON.stringify(result.progress),
          finalized.resultJson,
          finalized.resultR2Key,
          finalized.objectCatalogId,
          completedTs,
          completedTs,
          job.id,
          job.tenant_id,
        ]
      );
      logger.info('Generic admin job completed', {
        job_id: job.id,
        tenant_id: job.tenant_id,
        job_type: job.job_type,
        status: result.status,
      });
    } catch (error) {
      const failedTs = Math.floor(Date.now() / 1000);
      const nextAttemptCount = getAttemptCount(job) + 1;
      const maxAttempts = getMaxAttempts(job);
      const exhausted = nextAttemptCount >= maxAttempts;
      const nextRunAt = exhausted ? null : failedTs + getRetryDelaySeconds(nextAttemptCount - 1);
      if (exhausted) {
        await adapter.execute(
          `UPDATE admin_jobs
              SET status = 'failed', error_message = ?, result = ?, attempt_count = ?,
                  max_attempts = COALESCE(max_attempts, ?), next_run_at = NULL,
                  dead_lettered_at = ?, completed_at = ?, updated_at = ?
            WHERE id = ? AND tenant_id = ?`,
          [
            String(error),
            buildFailureResult(job, error, nextAttemptCount),
            nextAttemptCount,
            maxAttempts,
            failedTs,
            failedTs,
            failedTs,
            job.id,
            job.tenant_id,
          ]
        );
      } else {
        await adapter.execute(
          `UPDATE admin_jobs
              SET status = 'pending', error_message = ?, attempt_count = ?,
                  max_attempts = COALESCE(max_attempts, ?), next_run_at = ?, updated_at = ?
            WHERE id = ? AND tenant_id = ?`,
          [String(error), nextAttemptCount, maxAttempts, nextRunAt, failedTs, job.id, job.tenant_id]
        );
      }
      logger.error(
        exhausted ? 'Generic admin job dead-lettered' : 'Generic admin job retry scheduled',
        {
          job_id: job.id,
          tenant_id: job.tenant_id,
          job_type: job.job_type,
          attempt_count: nextAttemptCount,
          max_attempts: maxAttempts,
          next_run_at: nextRunAt,
        },
        error as Error
      );
    }
  }
}
