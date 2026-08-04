import {
  ensureDatabaseAdapter,
  getTenantEmailSettings,
  listEnvironmentTenantDefaultStores,
  putTenantEmailSettings,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import {
  decryptSecretFields,
  getPluginEncryptionKey,
  type EncryptedConfig,
} from '@authrim/ar-lib-plugin';
import {
  disableTenantBuiltinNotificationProvider,
  projectTenantNotificationProviderCredential,
  removeTenantNotificationProviderFromOrder,
} from './notification-provider-projection';
import {
  BUILTIN_HUMAN_VERIFICATION_PROVIDER_IDS,
  disableTenantHumanVerificationProvider,
  projectTenantHumanVerificationProvider,
} from './human-verification-provider-projection';

const BUILTIN_NOTIFICATION_PROVIDER_IDS = new Set(['notifier-resend', 'notifier-cloudflare']);
const SUPPORTED_PROVIDER_IDS = [
  ...BUILTIN_NOTIFICATION_PROVIDER_IDS,
  ...BUILTIN_HUMAN_VERIFICATION_PROVIDER_IDS,
] as const;
const JOB_BATCH_SIZE = 10;
const JOB_LEASE_SECONDS = 120;

interface DesiredRevision {
  revision: string;
  updatedAt: number;
}

interface JobRow {
  job_id: string;
  plugin_id: string;
  desired_revision: string;
  status: string;
  cursor_tenant_id: string | null;
  processed_tenants: number | string;
  succeeded_tenants: number | string;
  skipped_tenants: number | string;
  failed_tenants: number | string;
  attempt_count: number | string;
  max_attempts: number | string;
  fencing_token: number | string;
}

export interface ProviderReprojectionLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface ProviderReprojectionSummary {
  claimed: number;
  completed: number;
  retried: number;
  superseded: number;
}

export interface ProviderReprojectionStatus {
  pluginId: string;
  revision: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'superseded';
  total: number;
  processed: number;
  succeeded: number;
  skipped: number;
  failed: number;
  lastErrorCode: string | null;
  updatedAt: number;
}

function revisionKey(pluginId: string): string {
  return `plugins:provider-projection:desired:${pluginId}`;
}

function safeCount(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error('provider_reprojection_row_invalid');
  return parsed;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function adminAdapter(env: Env): DatabaseAdapter {
  if (!env.DB_ADMIN) throw new Error('provider_reprojection_admin_db_unavailable');
  return ensureDatabaseAdapter(env.DB_ADMIN, 'provider-reprojection-jobs');
}

async function readDesiredRevision(env: Env, pluginId: string): Promise<DesiredRevision | null> {
  const raw = await env.SETTINGS?.get(revisionKey(pluginId));
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Partial<DesiredRevision>;
  if (
    typeof parsed.revision !== 'string' ||
    !/^[0-9a-f-]{36}$/u.test(parsed.revision) ||
    !Number.isSafeInteger(parsed.updatedAt) ||
    (parsed.updatedAt as number) < 1
  ) {
    throw new Error('provider_reprojection_revision_invalid');
  }
  return parsed as DesiredRevision;
}

async function readGlobalConfig(env: Env, pluginId: string): Promise<Record<string, unknown>> {
  const raw = await env.SETTINGS?.get(`plugins:config:${pluginId}`);
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('provider_reprojection_config_invalid');
  }
  const encrypted = parsed as EncryptedConfig;
  if (!encrypted._encrypted?.length) return parsed as Record<string, unknown>;
  const key = await getPluginEncryptionKey(
    env as { PLUGIN_ENCRYPTION_KEY?: string; PLUGIN_ENCRYPTION_SALT?: string }
  );
  return decryptSecretFields(encrypted, key);
}

async function ensureJob(
  env: Env,
  adapter: DatabaseAdapter,
  pluginId: string,
  desired: DesiredRevision,
  now: number
): Promise<void> {
  const jobId = `provider-reprojection-${await sha256(`${pluginId}\0${desired.revision}`)}`;
  await adapter.execute(
    `INSERT OR IGNORE INTO provider_reprojection_jobs (
       job_id, plugin_id, desired_revision, status, total_tenants,
       max_attempts, next_run_at, created_at, updated_at
     ) VALUES (?, ?, ?, 'pending', ?, 100, ?, ?, ?)`,
    [jobId, pluginId, desired.revision, 0, now, now, now]
  );
  await adapter.execute(
    `UPDATE provider_reprojection_jobs
        SET status = 'superseded', lease_owner = NULL, lease_expires_at = NULL,
            completed_at = ?, updated_at = ?
      WHERE plugin_id = ? AND desired_revision <> ?
        AND status IN ('pending', 'processing')`,
    [now, now, pluginId, desired.revision]
  );
}

export async function markGlobalProviderDesiredRevision(
  env: Env,
  pluginId: string,
  now = Math.floor(Date.now() / 1_000)
): Promise<string> {
  if (!SUPPORTED_PROVIDER_IDS.includes(pluginId as never) || !env.SETTINGS) {
    throw new Error('provider_reprojection_provider_unsupported');
  }
  const desired = { revision: crypto.randomUUID(), updatedAt: now };
  await env.SETTINGS.put(revisionKey(pluginId), JSON.stringify(desired));
  try {
    await ensureJob(env, adminAdapter(env), pluginId, desired, now);
  } catch {
    // Cron reconciles fixed provider revision keys, so a transient enqueue failure is recoverable.
  }
  return desired.revision;
}

async function pluginIsEnabled(env: Env, pluginId: string, tenantId: string): Promise<boolean> {
  const tenant = await env.SETTINGS?.get(`plugins:enabled:${pluginId}:tenant:${tenantId}`);
  if (tenant !== null && tenant !== undefined) return tenant === 'true';
  return (await env.SETTINGS?.get(`plugins:enabled:${pluginId}`)) !== 'false';
}

function enabled(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}

async function projectTenant(
  env: Env,
  pluginId: string,
  tenantId: string,
  config: Record<string, unknown>,
  revision: string
): Promise<{ status: 'applied' | 'skipped'; source: 'inherited' | 'override' }> {
  const override = await env.SETTINGS?.get(`plugins:config:${pluginId}:tenant:${tenantId}`);
  if (override !== null && override !== undefined) {
    return { status: 'skipped', source: 'override' };
  }
  const isEnabled = await pluginIsEnabled(env, pluginId, tenantId);
  if (BUILTIN_NOTIFICATION_PROVIDER_IDS.has(pluginId)) {
    const settings = await getTenantEmailSettings(env, tenantId);
    if (!isEnabled) {
      await disableTenantBuiltinNotificationProvider(env, {
        tenantId,
        channel: 'email',
        pluginId,
      });
      await removeTenantNotificationProviderFromOrder(env, {
        tenantId,
        channel: 'email',
        pluginId,
        operationId: `provider-reprojection-disable-${revision}-${tenantId}`,
      });
      await putTenantEmailSettings(env, tenantId, {
        strategy: 'priority_failover',
        providerOrder: settings.providerOrder.filter((candidate) => candidate !== pluginId),
      });
      return { status: 'applied', source: 'inherited' };
    }
    if (!settings.providerOrder.includes(pluginId)) {
      return { status: 'skipped', source: 'inherited' };
    }
    await projectTenantNotificationProviderCredential(env, {
      tenantId,
      channel: 'email',
      pluginId,
      config,
    });
    return { status: 'applied', source: 'inherited' };
  }

  const rawMethods = await env.SETTINGS?.get(`settings:tenant:${tenantId}:authentication-methods`);
  const methods = rawMethods ? (JSON.parse(rawMethods) as Record<string, unknown>) : {};
  const selected =
    typeof methods['authentication-methods.human_verification.provider'] === 'string'
      ? methods['authentication-methods.human_verification.provider']
      : 'human-verification-cloudflare-turnstile';
  const inUse = ['login', 'signup', 'reauth'].some((action) =>
    enabled(methods[`authentication-methods.human_verification.${action}_enabled`])
  );
  if (selected !== pluginId) {
    await disableTenantHumanVerificationProvider(env, {
      tenantId,
      pluginId,
      operationId: `provider-reprojection-disable-${revision}-${tenantId}`,
    });
    return { status: 'applied', source: 'inherited' };
  }
  if (!isEnabled || !inUse) {
    await disableTenantHumanVerificationProvider(env, {
      tenantId,
      pluginId,
      operationId: `provider-reprojection-disable-${revision}-${tenantId}`,
    });
    return { status: 'applied', source: 'inherited' };
  }
  await projectTenantHumanVerificationProvider(env, {
    tenantId,
    pluginId,
    config,
    operationId: `provider-reprojection-config-${revision}-${tenantId}`,
  });
  return { status: 'applied', source: 'inherited' };
}

function errorCode(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  return /^[a-z][a-z0-9_]{0,127}$/u.test(code) ? code : 'provider_reprojection_failed';
}

async function recordTenantState(
  adapter: DatabaseAdapter,
  input: {
    pluginId: string;
    tenantId: string;
    revision: string;
    source: 'inherited' | 'override';
    status: 'applied' | 'skipped' | 'failed';
    error: string | null;
    now: number;
  }
): Promise<void> {
  await adapter.execute(
    `INSERT INTO provider_reprojection_tenant_state (
       plugin_id, tenant_id, desired_revision, applied_revision,
       source_scope, status, last_error_code, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(plugin_id, tenant_id) DO UPDATE SET
       desired_revision = excluded.desired_revision,
       applied_revision = excluded.applied_revision,
       source_scope = excluded.source_scope,
       status = excluded.status,
       last_error_code = excluded.last_error_code,
       updated_at = excluded.updated_at`,
    [
      input.pluginId,
      input.tenantId,
      input.revision,
      input.status === 'applied' ? input.revision : null,
      input.source,
      input.status,
      input.error,
      input.now,
    ]
  );
}

async function claimJob(
  adapter: DatabaseAdapter,
  job: JobRow,
  owner: string,
  now: number
): Promise<JobRow | null> {
  const claimed = await adapter.execute(
    `UPDATE provider_reprojection_jobs
        SET status = 'processing', lease_owner = ?, lease_expires_at = ?,
            fencing_token = fencing_token + 1, updated_at = ?
      WHERE job_id = ? AND (
        (status = 'pending' AND (next_run_at IS NULL OR next_run_at <= ?)) OR
        (status = 'processing' AND lease_expires_at <= ?)
      )`,
    [owner, now + JOB_LEASE_SECONDS, now, job.job_id, now, now]
  );
  if (claimed.rowsAffected !== 1) return null;
  return adapter.queryOne<JobRow>(
    `SELECT job_id, plugin_id, desired_revision, status, cursor_tenant_id,
            processed_tenants, succeeded_tenants, skipped_tenants, failed_tenants,
            attempt_count, max_attempts, fencing_token
       FROM provider_reprojection_jobs WHERE job_id = ? AND lease_owner = ?`,
    [job.job_id, owner]
  );
}

export async function processProviderReprojectionJobs(
  env: Env,
  logger: ProviderReprojectionLogger,
  options: { now?: number; limit?: number } = {}
): Promise<ProviderReprojectionSummary> {
  const summary = { claimed: 0, completed: 0, retried: 0, superseded: 0 };
  if (!env.SETTINGS || !env.DB_ADMIN) return summary;
  const now = options.now ?? Math.floor(Date.now() / 1_000);
  const adapter = adminAdapter(env);
  for (const pluginId of SUPPORTED_PROVIDER_IDS) {
    try {
      const desired = await readDesiredRevision(env, pluginId);
      if (desired) await ensureJob(env, adapter, pluginId, desired, now);
    } catch {
      logger.warn('Provider reprojection desired state reconciliation failed', { pluginId });
    }
  }
  const due = await adapter.query<JobRow>(
    `SELECT job_id, plugin_id, desired_revision, status, cursor_tenant_id,
            processed_tenants, succeeded_tenants, skipped_tenants, failed_tenants,
            attempt_count, max_attempts, fencing_token
       FROM provider_reprojection_jobs
      WHERE (status = 'pending' AND (next_run_at IS NULL OR next_run_at <= ?))
         OR (status = 'processing' AND lease_expires_at <= ?)
      ORDER BY created_at ASC LIMIT ?`,
    [now, now, options.limit ?? 3]
  );
  for (const candidate of due) {
    const owner = `provider-reprojection-${crypto.randomUUID()}`;
    const job = await claimJob(adapter, candidate, owner, now);
    if (!job) continue;
    summary.claimed += 1;
    const fence = safeCount(job.fencing_token);
    const desired = await readDesiredRevision(env, job.plugin_id);
    if (!desired || desired.revision !== job.desired_revision) {
      await adapter.execute(
        `UPDATE provider_reprojection_jobs
            SET status = 'superseded', lease_owner = NULL, lease_expires_at = NULL,
                completed_at = ?, updated_at = ?
          WHERE job_id = ? AND lease_owner = ? AND fencing_token = ?`,
        [now, now, job.job_id, owner, fence]
      );
      summary.superseded += 1;
      continue;
    }
    const config = await readGlobalConfig(env, job.plugin_id);
    const tenants = await listEnvironmentTenantDefaultStores(env, {
      afterTenantId: job.cursor_tenant_id ?? undefined,
      limit: JOB_BATCH_SIZE + 1,
      concurrency: 4,
    });
    const batch = tenants.slice(0, JOB_BATCH_SIZE);
    let cursor = job.cursor_tenant_id;
    let succeeded = 0;
    let skipped = 0;
    let failure: { tenantId: string; code: string } | null = null;
    for (const tenant of batch) {
      try {
        const outcome = await projectTenant(
          env,
          job.plugin_id,
          tenant.tenantId,
          config,
          job.desired_revision
        );
        await recordTenantState(adapter, {
          pluginId: job.plugin_id,
          tenantId: tenant.tenantId,
          revision: job.desired_revision,
          source: outcome.source,
          status: outcome.status,
          error: null,
          now,
        });
        cursor = tenant.tenantId;
        if (outcome.status === 'applied') succeeded += 1;
        else skipped += 1;
      } catch (error) {
        failure = { tenantId: tenant.tenantId, code: errorCode(error) };
        await recordTenantState(adapter, {
          pluginId: job.plugin_id,
          tenantId: tenant.tenantId,
          revision: job.desired_revision,
          source: 'inherited',
          status: 'failed',
          error: failure.code,
          now,
        });
        break;
      }
    }
    if (failure) {
      const attempts = safeCount(job.attempt_count) + 1;
      const terminal = attempts >= safeCount(job.max_attempts);
      await adapter.execute(
        `UPDATE provider_reprojection_jobs
            SET status = ?, cursor_tenant_id = ?,
                total_tenants = MAX(total_tenants, processed_tenants + ?),
                processed_tenants = processed_tenants + ?,
                succeeded_tenants = succeeded_tenants + ?,
                skipped_tenants = skipped_tenants + ?, failed_tenants = 1,
                attempt_count = ?, next_run_at = ?, last_error_code = ?,
                lease_owner = NULL, lease_expires_at = NULL,
                completed_at = ?, updated_at = ?
          WHERE job_id = ? AND lease_owner = ? AND fencing_token = ?`,
        [
          terminal ? 'failed' : 'pending',
          cursor,
          succeeded + skipped,
          succeeded + skipped,
          succeeded,
          skipped,
          attempts,
          terminal ? null : now + Math.min(3_600, 2 ** Math.min(attempts, 10)),
          failure.code,
          terminal ? now : null,
          now,
          job.job_id,
          owner,
          fence,
        ]
      );
      summary.retried += terminal ? 0 : 1;
      logger.warn('Provider reprojection tenant failed', {
        pluginId: job.plugin_id,
        tenantId: failure.tenantId,
        code: failure.code,
      });
      continue;
    }
    const complete = tenants.length <= JOB_BATCH_SIZE;
    await adapter.execute(
      `UPDATE provider_reprojection_jobs
          SET status = ?, cursor_tenant_id = ?,
              total_tenants = MAX(total_tenants, processed_tenants + ?),
              processed_tenants = processed_tenants + ?,
              succeeded_tenants = succeeded_tenants + ?,
              skipped_tenants = skipped_tenants + ?, failed_tenants = 0,
              attempt_count = 0, next_run_at = ?, last_error_code = NULL,
              lease_owner = NULL, lease_expires_at = NULL,
              completed_at = ?, updated_at = ?
        WHERE job_id = ? AND lease_owner = ? AND fencing_token = ?`,
      [
        complete ? 'completed' : 'pending',
        cursor,
        succeeded + skipped,
        succeeded + skipped,
        succeeded,
        skipped,
        complete ? null : now,
        complete ? now : null,
        now,
        job.job_id,
        owner,
        fence,
      ]
    );
    if (complete) summary.completed += 1;
  }
  return summary;
}

export async function listProviderReprojectionStatus(
  env: Env
): Promise<ProviderReprojectionStatus[]> {
  const rows = await adminAdapter(env).query<{
    plugin_id: string;
    desired_revision: string;
    status: ProviderReprojectionStatus['status'];
    total_tenants: number | string;
    processed_tenants: number | string;
    succeeded_tenants: number | string;
    skipped_tenants: number | string;
    failed_tenants: number | string;
    last_error_code: string | null;
    updated_at: number | string;
  }>(
    `SELECT job.plugin_id, job.desired_revision, job.status, job.total_tenants,
            job.processed_tenants, job.succeeded_tenants, job.skipped_tenants,
            job.failed_tenants, job.last_error_code, job.updated_at
       FROM provider_reprojection_jobs job
      WHERE job.job_id = (
        SELECT latest.job_id
          FROM provider_reprojection_jobs latest
         WHERE latest.plugin_id = job.plugin_id
         ORDER BY latest.created_at DESC, latest.rowid DESC
         LIMIT 1
      )
      ORDER BY job.plugin_id`
  );
  return rows.map((row) => ({
    pluginId: row.plugin_id,
    revision: row.desired_revision,
    status: row.status,
    total: safeCount(row.total_tenants),
    processed: safeCount(row.processed_tenants),
    succeeded: safeCount(row.succeeded_tenants),
    skipped: safeCount(row.skipped_tenants),
    failed: safeCount(row.failed_tenants),
    lastErrorCode: row.last_error_code,
    updatedAt: safeCount(row.updated_at),
  }));
}
