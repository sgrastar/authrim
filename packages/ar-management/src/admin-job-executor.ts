import type {
  DatabaseAdapter,
  Env,
  ObjectClass,
  ObjectRepresentation,
  TenantDatabaseRole,
} from '@authrim/ar-lib-core';
import {
  buildTenantDatabaseBindingPlan,
  decryptObjectArtifact,
  ensureDatabaseAdapter,
  emitRuntimeLogRecords,
  evaluateTenantDatabaseBindingCapacity,
  resolveAuthCorePersistenceAdapterFromEnv,
  resolveUserStoreRuntimeSourcesFromEnv,
  readR2ObjectTextWithLimit,
  tombstoneObjectCatalogEntryForTenant,
  putTenantExistsCache,
  deleteTenantExistsCache,
  transitionAccountAuthenticationState,
} from '@authrim/ar-lib-core';
import { materializeEncryptedObjectArtifact } from './object-artifact-materialization';
import { createLoggingTenantKeyResolver } from './logging-tenant-key';
import { listScimTokens } from '@authrim/ar-lib-scim';

type AdminJobStatus = 'processing' | 'completed' | 'partial_failure';
type AdminJobResultDelivery = 'auto' | 'inline' | 'artifact';
type TenantDatabaseProvisionExecutionMode = 'plan_only' | 'operator_cli';
type TenantBackupKmsProvider = 'deployment_master_secret_hkdf' | 'external_kms_customer_managed';
type TenantDatabaseExportFormat = 'jsonl_per_table' | 'sqlite_d1_dump' | 'parquet';
type TenantDatabaseRestoreDryRunValidationMode =
  | 'manifest_checksum'
  | 'temporary_database_schema_import';

const INLINE_RESULT_MAX_BYTES = 32 * 1024;
const DEFAULT_JOB_MAX_ATTEMPTS = 3;
const DEFAULT_JOB_BATCH_SIZE = 500;
const MAX_JOB_BATCH_SIZE = 1000;
const RETRY_BACKOFF_SECONDS = [60, 300, 900] as const;
const TENANT_D1_BINDING_WARNING_THRESHOLD = 3000;
const TENANT_D1_BINDING_HARD_LIMIT = 5000;
const TENANT_D1_ROLES: TenantDatabaseRole[] = ['tenant_core', 'tenant_pii'];
const DEFAULT_TENANT_BACKUP_RETENTION_DAYS = 30;
const MAX_TENANT_BACKUP_RETENTION_DAYS = 3650;
const TENANT_DATABASE_RESTORE_DRY_RUN_CONFIRMATION = 'VALIDATE_TENANT_DATABASE_RESTORE_DRY_RUN';
const TENANT_DATABASE_BACKUP_PURGE_CONFIRMATION = 'PURGE_TENANT_DATABASE_BACKUP';
const TENANT_BACKUP_TABLE_ROW_LIMIT = 50_000;
const TENANT_BACKUP_ARTIFACT_OBJECT_MAX_BYTES = 40 * 1024 * 1024;
const TENANT_BACKUP_CORE_TABLES = [
  'identity_subjects',
  'identity_accounts',
  'subject_account_links',
  'profiles',
  'profile_attribute_values',
  'structured_attribute_values',
  'contact_points',
  'contact_verifications',
  'sessions',
  'passkeys',
  'roles',
  'user_roles',
  'session_clients',
] as const;
const TENANT_BACKUP_PII_TABLES = [
  'identity_sensitive_values',
  'subject_identifiers',
  'linked_identities',
  'audit_log_pii',
  'users_pii_tombstone',
] as const;

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
  tenant_lifecycle_state?: string | null;
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

async function emitAdminJobRuntimeLog(
  env: Env,
  adapter: DatabaseAdapter,
  logger: AdminJobLogger,
  input: {
    job: AdminJobRow;
    status: AdminJobStatus | 'failed' | 'retrying';
    eventAt: number;
    attemptCount?: number | null;
    nextRunAt?: number | null;
    completedAt?: number | null;
    objectCatalogId?: string | null;
    errorClass?: string | null;
  }
): Promise<void> {
  try {
    await emitRuntimeLogRecords({
      env: {
        ...env,
        DB_ADMIN: env.DB_ADMIN ?? adapter,
        LOGGING_INDEX_DB: adapter,
      },
      tenantId: input.job.tenant_id,
      logType: 'job',
      surface: 'admin_job',
      tenantKeyResolver: createLoggingTenantKeyResolver(adapter),
      records: [
        {
          id: `${input.job.id}:${input.status}:${input.eventAt}:${crypto.randomUUID()}`,
          eventAt: input.eventAt,
          payload: {
            job_id: input.job.id,
            job_type: input.job.job_type,
            status: input.status,
            attempt_count: input.attemptCount ?? input.job.attempt_count ?? null,
            max_attempts: input.job.max_attempts ?? null,
            next_run_at: input.nextRunAt ?? null,
            completed_at: input.completedAt ?? null,
            object_catalog_id: input.objectCatalogId ?? null,
            error_class: input.errorClass ?? null,
          },
          indexedFields: {
            surface: 'admin_job',
            jobType: input.job.job_type,
            status: input.status,
            attempt: input.attemptCount ?? input.job.attempt_count ?? null,
          },
        },
      ],
    });
  } catch (error) {
    logger.error(
      'Failed to emit admin job runtime log',
      {
        job_id: input.job.id,
        tenant_id: input.job.tenant_id,
        job_type: input.job.job_type,
        status: input.status,
      },
      error as Error
    );
  }
}

const GENERIC_ADMIN_JOB_TYPES = [
  'tenants/lifecycle-validation',
  'tenant-database/provision',
  'tenant-database/export',
  'tenant-database/restore-dry-run',
  'tenant-database/purge-backup',
  'users/bulk-update',
  'reports/generate',
  'organizations/bulk-members',
] as const;

type GenericAdminJobType = (typeof GENERIC_ADMIN_JOB_TYPES)[number];

export function isAdminJobAllowedForTenantLifecycle(
  lifecycleState: string,
  jobType: string
): boolean {
  if (lifecycleState === 'active') return true;
  if (lifecycleState === 'deleting') {
    return jobType === 'tenant-database/export';
  }
  if (jobType === 'tenants/lifecycle-validation') {
    return ['suspended', 'frozen', 'restore_pending', 'restore_validating'].includes(
      lifecycleState
    );
  }
  if (lifecycleState === 'suspended') {
    return ['tenant-database/export', 'tenant-database/restore-dry-run'].includes(jobType);
  }
  if (lifecycleState === 'frozen' || lifecycleState === 'migration_read_only') {
    return [
      'tenant-database/export',
      'tenant-database/restore-dry-run',
      'tenant-database/provision',
    ].includes(jobType);
  }
  if (lifecycleState === 'restore_pending' || lifecycleState === 'restore_validating') {
    return ['tenant-database/restore-dry-run'].includes(jobType);
  }
  return false;
}

interface TenantLifecycleValidationConfig {
  command: 'resume' | 'unfreeze' | 'restore-validate';
  validation_kind: string;
  source_state: string;
  target_state: 'active';
  reason: string;
  idempotency_key: string;
  actor_id?: string | null;
}

async function writeTenantLifecycleJobAudit(
  env: Env,
  fallbackAdapter: DatabaseAdapter,
  job: AdminJobRow,
  input: {
    action: string;
    result: 'success' | 'failure';
    severity: 'info' | 'error';
    metadata: Record<string, unknown>;
    error?: unknown;
  }
): Promise<void> {
  const auditAdapter = ensureDatabaseAdapter(
    env.DB_ADMIN ?? fallbackAdapter,
    'tenant-lifecycle-job-audit'
  );
  const config = job.config ? (JSON.parse(job.config) as TenantLifecycleValidationConfig) : null;
  await auditAdapter.execute(
    `INSERT INTO admin_audit_log (
      id, tenant_id, admin_user_id, action, resource_type, resource_id,
      result, error_code, error_message, severity, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, 'tenant', ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      job.tenant_id,
      config?.actor_id ?? null,
      input.action,
      job.tenant_id,
      input.result,
      input.result === 'failure' ? 'tenant_lifecycle_validation_failed' : null,
      input.error instanceof Error ? input.error.message : input.error ? String(input.error) : null,
      input.severity,
      JSON.stringify({ job_id: job.id, ...input.metadata }),
      Date.now(),
    ]
  );
}

async function processTenantLifecycleValidationJob(
  env: Env,
  adapter: DatabaseAdapter,
  job: AdminJobRow
): Promise<AdminJobProcessorResult> {
  const config = parseJsonConfig<TenantLifecycleValidationConfig>(job);
  const tenant = await adapter.queryOne<{ id: string; lifecycle_state: string }>(
    'SELECT id, lifecycle_state FROM tenants WHERE id = ?',
    [job.tenant_id]
  );
  if (!tenant) throw new Error('tenant_lifecycle_validation_tenant_not_found');

  const allowedState =
    config.command === 'restore-validate' ? 'restore_validating' : config.source_state;
  if (tenant.lifecycle_state !== allowedState) {
    throw new Error(
      `tenant_lifecycle_validation_state_conflict:${tenant.lifecycle_state}:${allowedState}`
    );
  }

  const checks: Array<{ id: string; status: 'passed'; evidence: string }> = [];
  checks.push({ id: 'control_db', status: 'passed', evidence: 'tenant row present' });

  const tenantAdapter = await resolveAuthCorePersistenceAdapterFromEnv(
    env,
    'tenant-lifecycle-validation',
    { tenantId: job.tenant_id }
  );
  await tenantAdapter.queryOne('SELECT 1 AS ok');
  checks.push({ id: 'tenant_db_read', status: 'passed', evidence: 'SELECT 1 succeeded' });

  const probeId = `lifecycle:${job.id}`;
  await tenantAdapter.execute(
    `INSERT INTO authrim_runtime_probes
      (id, tenant_id, role, probe_kind, nonce, created_at)
     VALUES (?, ?, 'tenant_core', 'write_read', ?, ?)`,
    [probeId, job.tenant_id, crypto.randomUUID(), Math.floor(Date.now() / 1000)]
  );
  const probe = await tenantAdapter.queryOne<{ id: string; tenant_id: string }>(
    'SELECT id, tenant_id FROM authrim_runtime_probes WHERE id = ? AND tenant_id = ?',
    [probeId, job.tenant_id]
  );
  if (probe?.id !== probeId || probe.tenant_id !== job.tenant_id) {
    throw new Error('tenant_lifecycle_validation_write_read_failed');
  }
  await tenantAdapter.execute('DELETE FROM authrim_runtime_probes WHERE id = ? AND tenant_id = ?', [
    probeId,
    job.tenant_id,
  ]);
  checks.push({
    id: 'tenant_db_write_read',
    status: 'passed',
    evidence: 'probe round-trip succeeded',
  });

  const issuer = env.BASE_DOMAIN ? `https://${job.tenant_id}.${env.BASE_DOMAIN}` : env.ISSUER_URL;
  if (!issuer) throw new Error('tenant_lifecycle_validation_issuer_missing');
  new URL(issuer);
  if (!env.AUTHRIM_CONFIG) throw new Error('tenant_lifecycle_validation_kv_binding_missing');
  const tenantSettingsRaw = await env.AUTHRIM_CONFIG.get(`settings:tenant:${job.tenant_id}:tenant`);
  if (!tenantSettingsRaw) throw new Error('tenant_lifecycle_validation_tenant_settings_missing');
  const tenantSettings = JSON.parse(tenantSettingsRaw) as Record<string, unknown>;
  if (typeof tenantSettings['tenant.allowed_identifiers'] !== 'string') {
    throw new Error('tenant_lifecycle_validation_discovery_settings_invalid');
  }
  checks.push({ id: 'discovery_issuer', status: 'passed', evidence: issuer });

  if (config.command === 'restore-validate') {
    const samlProviders = await tenantAdapter.queryOne<{ count: number }>(
      `SELECT COUNT(*) AS count FROM identity_providers
        WHERE tenant_id = ? AND provider_type LIKE 'saml%'`,
      [job.tenant_id]
    );
    checks.push({
      id: 'saml',
      status: 'passed',
      evidence: `${samlProviders?.count ?? 0} tenant-scoped provider(s) queryable`,
    });

    if (!env.INITIAL_ACCESS_TOKENS) {
      throw new Error('tenant_lifecycle_validation_scim_token_store_missing');
    }
    const scimTokens = await listScimTokens(env, { tenantId: job.tenant_id });
    checks.push({
      id: 'scim',
      status: 'passed',
      evidence: `${scimTokens.length} tenant-scoped token record(s) queryable`,
    });
  }

  checks.push({
    id: 'kv',
    status: 'passed',
    evidence: 'tenant settings read and parsed',
  });

  if (config.command === 'restore-validate') {
    if (!env.EXPORT_ARTIFACTS) throw new Error('tenant_lifecycle_validation_r2_binding_missing');
    const r2ProbeKey = `lifecycle-validation/${job.tenant_id}/${job.id}.json`;
    const r2ProbeBody = JSON.stringify({ tenant_id: job.tenant_id, job_id: job.id });
    await env.EXPORT_ARTIFACTS.put(r2ProbeKey, r2ProbeBody);
    const restoredProbe = await env.EXPORT_ARTIFACTS.get(r2ProbeKey);
    if (!restoredProbe || (await restoredProbe.text()) !== r2ProbeBody) {
      throw new Error('tenant_lifecycle_validation_r2_round_trip_failed');
    }
    await env.EXPORT_ARTIFACTS.delete(r2ProbeKey);
    checks.push({ id: 'r2', status: 'passed', evidence: 'temporary object round-trip succeeded' });
  }

  const auditAdapter = ensureDatabaseAdapter(
    env.DB_ADMIN ?? adapter,
    'tenant-lifecycle-audit-probe'
  );
  await auditAdapter.queryOne('SELECT id FROM admin_audit_log WHERE tenant_id = ? LIMIT 1', [
    job.tenant_id,
  ]);
  checks.push({
    id: 'audit_sink',
    status: 'passed',
    evidence: 'admin audit storage is queryable',
  });

  const currentVersion = await adapter.queryOne<{ updated_at: number }>(
    'SELECT updated_at FROM tenants WHERE id = ?',
    [job.tenant_id]
  );
  const nowTs = Math.max(
    Math.floor(Date.now() / 1000),
    Number(currentVersion?.updated_at ?? 0) + 1
  );
  const update = await adapter.execute(
    'UPDATE tenants SET lifecycle_state = ?, updated_at = ? WHERE id = ? AND lifecycle_state = ?',
    [config.target_state, nowTs, job.tenant_id, allowedState]
  );
  if (update.rowsAffected === 0) throw new Error('tenant_lifecycle_validation_activation_conflict');
  if (config.target_state === 'active') {
    await putTenantExistsCache(env.AUTHRIM_CONFIG, job.tenant_id);
  } else {
    await deleteTenantExistsCache(env.AUTHRIM_CONFIG, job.tenant_id);
  }

  await writeTenantLifecycleJobAudit(env, adapter, job, {
    action: 'tenant.lifecycle.validation_completed',
    result: 'success',
    severity: 'info',
    metadata: { checks, source_state: config.source_state, target_state: config.target_state },
  });

  return {
    status: 'completed',
    progress: {
      stage: 'completed',
      total: checks.length,
      processed: checks.length,
      succeeded: checks.length,
      failed: 0,
      checks,
    },
    result: {
      summary: { total: checks.length, succeeded: checks.length, failed: 0 },
      checks,
      lifecycle_state: config.target_state,
      source_state: config.source_state,
      reason: config.reason,
      actor_id: config.actor_id ?? null,
      idempotency_key: config.idempotency_key,
    },
  };
}

const USER_BULK_UPDATE_COLUMNS = {
  status: {
    sql: "json_extract(COALESCE(metadata_json, '{}'), '$.status')",
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
    sql: "CASE WHEN lifecycle_state = 'active' THEN 1 ELSE 0 END",
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
    sql: 'account_type',
    normalize(value: unknown): string {
      if (value === 'end_user') return 'user';
      if (value === 'admin') return 'admin';
      if (value === 'm2m') return 'service_account';
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

export interface TenantDatabaseProvisionConfig {
  tenant_id?: string;
  tenant_slug?: string;
  generation?: number;
  activate?: boolean;
  execution_mode?: TenantDatabaseProvisionExecutionMode;
  reason?: string;
}

export interface TenantDatabaseExportConfig {
  policy?: 'deletion_before_purge' | 'manual' | 'scheduled_periodic';
  consistency?: 'maintenance_read_only' | 'best_effort_online';
  export_format?: TenantDatabaseExportFormat;
  tables?: {
    core?: string[];
    pii?: string[];
  };
  retention_days?: number;
  result_delivery?: AdminJobResultDelivery;
  reason?: string;
}

export interface TenantDatabaseRestoreDryRunConfig {
  manifest_object_catalog_id?: string;
  manifest_public_artifact_id?: string;
  validation_mode?: TenantDatabaseRestoreDryRunValidationMode;
  actor_roles?: string[];
  break_glass_confirmation?: string;
  result_delivery?: AdminJobResultDelivery;
  reason?: string;
}

export interface TenantDatabasePurgeBackupConfig {
  source_export_job_id?: string;
  manifest_object_catalog_id?: string;
  manifest_public_artifact_id?: string;
  table_object_catalog_ids?: string[];
  actor_roles?: string[];
  break_glass_confirmation?: string;
  retention_days?: number;
  completed_at?: number | string;
  result_delivery?: AdminJobResultDelivery;
  reason?: string;
}

interface TenantDatabaseProvisionResourcePlan {
  role: TenantDatabaseRole;
  database_name: string;
  binding_ref: string;
  worker_shard: string;
  generation: number;
  database_id: string | null;
}

interface TenantDatabaseProvisionProgress {
  stage?: string;
  resources?: TenantDatabaseProvisionResourcePlan[];
}

interface TenantBackupManifestTableArtifact {
  plane: 'core' | 'pii';
  table: string;
  row_count: number;
  plaintext_bytes: number;
  plaintext_sha256: string;
  object_catalog_id: string;
  public_artifact_id: string;
  object_key: string;
  chunked: boolean;
  chunk_count: number;
}

interface TenantBackupManifest {
  version: number;
  tenant_id: string;
  job_id: string;
  profile: string;
  schema_version: string;
  export_format: 'jsonl_per_table';
  consistency: 'maintenance_read_only' | 'best_effort_online';
  policy: NonNullable<TenantDatabaseExportConfig['policy']>;
  started_at: string;
  completed_at: string;
  retention_days: number;
  restore_order: Array<{ plane: 'core' | 'pii'; table: string }>;
  tables: TenantBackupManifestTableArtifact[];
  checksums: {
    whole_export_sha256: string;
  };
  encryption: {
    envelope: string;
    plane: 'EXPORT_ARTIFACTS';
    key_version: number;
    kms: string;
    key_scope: string;
    key_derivation?: string;
    external_kms_extension_point?: boolean;
    raw_keys_stored: boolean;
  };
}

interface TenantBackupEncryptionMaterial {
  rootKeyHex: string;
  metadata: {
    envelope: 'application-level';
    kms: TenantBackupKmsProvider;
    key_scope: 'tenant_backup';
    key_derivation: string;
    raw_keys_stored: false;
    external_kms_extension_point: boolean;
  };
}

interface TenantDatabaseExportJobResult {
  summary?: {
    retention_days?: number;
  };
  manifest?: {
    object_catalog_id?: string;
    public_artifact_id?: string;
  };
  table_artifacts?: Array<{
    object_catalog_id?: string;
  }>;
}

interface TenantBackupCatalogObjectRow {
  catalog_id: string;
  public_artifact_id: string;
  tenant_id: string;
  object_class: ObjectClass;
  representation: ObjectRepresentation;
  object_kind: 'single' | 'manifest' | 'chunk';
  object_index: number;
  bucket_binding: 'EXPORT_ARTIFACTS';
  object_key: string;
  key_version: number;
  checksum_sha256: string | null;
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

async function sha256Hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function deriveTenantBackupRootKeyHex(
  deploymentRootKeyHex: string,
  tenantId: string,
  keyVersion: number
): Promise<string> {
  if (!/^[0-9a-fA-F]{64}$/u.test(deploymentRootKeyHex)) {
    throw new Error('OBJECT_ENCRYPTION_ROOT_KEY must be 64 hex characters');
  }
  const rootBytes = new Uint8Array(
    deploymentRootKeyHex.match(/.{1,2}/gu)?.map((byte) => Number.parseInt(byte, 16)) ?? []
  );
  const material = await crypto.subtle.importKey('raw', rootBytes, 'HKDF', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('authrim-tenant-backup-root'),
      info: new TextEncoder().encode(`tenant:${tenantId}:backup:v${keyVersion}`),
    },
    material,
    256
  );
  return Array.from(new Uint8Array(derived))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function getTenantBackupKmsProvider(env: Env): TenantBackupKmsProvider {
  const configured = (env as unknown as { TENANT_BACKUP_KMS_PROVIDER?: string })
    .TENANT_BACKUP_KMS_PROVIDER;
  if (!configured || configured === 'deployment_master_secret_hkdf') {
    return 'deployment_master_secret_hkdf';
  }
  if (configured === 'external_kms_customer_managed') {
    return 'external_kms_customer_managed';
  }
  throw new Error(`Unsupported tenant backup KMS provider: ${configured}`);
}

async function resolveTenantBackupEncryptionMaterial(
  env: Env,
  tenantId: string,
  keyVersion: number
): Promise<TenantBackupEncryptionMaterial> {
  const provider = getTenantBackupKmsProvider(env);
  if (provider === 'external_kms_customer_managed') {
    throw new Error('tenant_backup_external_kms_customer_managed_not_implemented');
  }
  if (!env.OBJECT_ENCRYPTION_ROOT_KEY) {
    throw new Error('OBJECT_ENCRYPTION_ROOT_KEY is required for tenant database backup encryption');
  }
  return {
    rootKeyHex: await deriveTenantBackupRootKeyHex(
      env.OBJECT_ENCRYPTION_ROOT_KEY,
      tenantId,
      keyVersion
    ),
    metadata: {
      envelope: 'application-level',
      kms: provider,
      key_scope: 'tenant_backup',
      key_derivation: 'HKDF-SHA-256 tenant backup root',
      raw_keys_stored: false,
      external_kms_extension_point: true,
    },
  };
}

function normalizeTenantDatabaseProvisionExecutionMode(
  value: unknown
): TenantDatabaseProvisionExecutionMode {
  if (value === undefined || value === null) return 'plan_only';
  if (value === 'plan_only' || value === 'operator_cli') {
    return value;
  }
  throw new Error('Invalid tenant database provisioning execution_mode');
}

function getTenantDatabaseProvisionEnvironment(env: Env): string {
  const deploymentEnv = env as Env & {
    DEPLOY_ENV?: string;
    ENVIRONMENT?: string;
    NODE_ENV?: string;
  };
  return deploymentEnv.DEPLOY_ENV || deploymentEnv.ENVIRONMENT || deploymentEnv.NODE_ENV || 'prod';
}

function countCurrentTenantD1Bindings(env: Env): number {
  return Object.keys(env as unknown as Record<string, unknown>).filter((key) =>
    /^TDB_[A-Z0-9_]+_(CORE|PII|AUDIT|CUSTOM)(?:_S[0-9]+)?$/u.test(key)
  ).length;
}

function buildTenantDatabaseProvisionResources(
  env: Env,
  job: AdminJobRow,
  config: TenantDatabaseProvisionConfig
): TenantDatabaseProvisionResourcePlan[] {
  const environment = getTenantDatabaseProvisionEnvironment(env);
  const generation = config.generation ?? 1;
  return TENANT_D1_ROLES.map((role) => {
    const plan = buildTenantDatabaseBindingPlan({
      environment,
      tenantId: job.tenant_id,
      tenantSlug: config.tenant_slug,
      role,
    });
    return {
      role,
      database_name: plan.databaseName,
      binding_ref: plan.bindingRef,
      worker_shard: plan.workerShard,
      generation,
      database_id: null,
    };
  });
}

function escapeCliArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildTenantDatabaseProvisionCommand(
  env: Env,
  job: AdminJobRow,
  config: TenantDatabaseProvisionConfig
): string {
  const args = [
    'pnpm',
    '--filter',
    '@authrim/setup',
    'exec',
    'authrim-setup',
    'tenant-db',
    '--tenant-id',
    escapeCliArg(job.tenant_id),
    '--generation',
    String(config.generation ?? 1),
    '--env',
    escapeCliArg(getTenantDatabaseProvisionEnvironment(env)),
    '--yes',
  ];
  if (config.tenant_slug) {
    args.push('--tenant-slug', escapeCliArg(config.tenant_slug));
  }
  if (config.activate) {
    args.push('--activate');
  }
  return args.join(' ');
}

function buildWranglerD1BindingSnippet(resources: TenantDatabaseProvisionResourcePlan[]): string {
  return resources
    .map((resource) =>
      `
[[d1_databases]]
binding = "${resource.binding_ref}"
database_name = "${resource.database_name}"
database_id = "${resource.database_id ?? '<created-by-provisioning>'}"
`.trim()
    )
    .join('\n\n');
}

function buildBindingImpact(env: Env, resources: TenantDatabaseProvisionResourcePlan[]) {
  const currentBindings = countCurrentTenantD1Bindings(env);
  const generatedBindingRefs = resources.map((resource) => resource.binding_ref);
  const envBindings = new Set(Object.keys(env as unknown as Record<string, unknown>));
  const conflicts = generatedBindingRefs.filter((binding) => envBindings.has(binding));
  const uniqueBindings = new Set(generatedBindingRefs);
  if (uniqueBindings.size !== generatedBindingRefs.length) {
    conflicts.push(
      ...generatedBindingRefs.filter(
        (binding, index) => generatedBindingRefs.indexOf(binding) !== index
      )
    );
  }
  return {
    current_bindings: currentBindings,
    added_bindings: resources.length,
    generated_bindings: generatedBindingRefs,
    binding_conflicts: Array.from(new Set(conflicts)).sort(),
    capacity: evaluateTenantDatabaseBindingCapacity({
      currentBindings,
      tenantsToAdd: 1,
      rolesPerTenant: resources.length,
      warningThreshold: TENANT_D1_BINDING_WARNING_THRESHOLD,
      hardLimit: TENANT_D1_BINDING_HARD_LIMIT,
    }),
  };
}

function mergeProvisionResourcesWithProgress(
  planned: TenantDatabaseProvisionResourcePlan[],
  progress: TenantDatabaseProvisionProgress | null
): TenantDatabaseProvisionResourcePlan[] {
  const progressResources = new Map(
    (progress?.resources ?? []).map((resource) => [resource.role, resource])
  );
  return planned.map((resource) => ({
    ...resource,
    database_id: progressResources.get(resource.role)?.database_id ?? resource.database_id,
  }));
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
    `SELECT COUNT(*) as count FROM identity_accounts WHERE ${filter.whereSql}`,
    filter.params
  );
  return row?.count ?? 0;
}

async function processTenantDatabaseProvisionJob(
  env: Env,
  adapter: DatabaseAdapter,
  job: AdminJobRow
): Promise<AdminJobProcessorResult> {
  const config = parseJsonConfig<TenantDatabaseProvisionConfig>(job);
  const executionMode = normalizeTenantDatabaseProvisionExecutionMode(config.execution_mode);
  const previousProgress = parseJsonProgress<TenantDatabaseProvisionProgress>(job);
  const resources = mergeProvisionResourcesWithProgress(
    buildTenantDatabaseProvisionResources(env, job, config),
    previousProgress
  );
  const impact = buildBindingImpact(env, resources);

  if (impact.binding_conflicts.length > 0) {
    throw new Error(`tenant_d1_binding_conflict:${impact.binding_conflicts.join(',')}`);
  }
  if (impact.capacity.state === 'exceeds_limit') {
    throw new Error(`tenant_d1_binding_capacity_exceeded:${impact.capacity.projectedBindings}`);
  }

  const result: Record<string, unknown> = {
    summary: {
      total: resources.length,
      processed: resources.length,
      succeeded: resources.length,
      failed: 0,
      execution_mode: executionMode,
    },
    tenant_database_provisioning: {
      tenant_id: job.tenant_id,
      tenant_slug: config.tenant_slug ?? null,
      generation: config.generation ?? 1,
      activate: config.activate ?? false,
      reason: config.reason ?? null,
      resources,
      impact,
      generated_config: {
        wrangler_toml: buildWranglerD1BindingSnippet(resources),
      },
      operator_cli: {
        command: buildTenantDatabaseProvisionCommand(env, job, config),
      },
      setup_tool_execution:
        'Run the generated setup command from an operator workstation with wrangler access.',
    },
  };

  return {
    status: 'completed',
    progress: {
      total: resources.length,
      processed: resources.length,
      succeeded: resources.length,
      failed: 0,
      skipped: executionMode === 'plan_only' || executionMode === 'operator_cli' ? 1 : 0,
      stage: 'deployment_plan_generated',
    },
    result,
  };
}

function normalizeTenantDatabaseExportPolicy(
  value: unknown
): NonNullable<TenantDatabaseExportConfig['policy']> {
  if (value === undefined || value === null) return 'manual';
  if (value === 'deletion_before_purge' || value === 'manual' || value === 'scheduled_periodic') {
    return value;
  }
  throw new Error('Invalid tenant database export policy');
}

function normalizeTenantDatabaseExportConsistency(
  value: unknown,
  policy: NonNullable<TenantDatabaseExportConfig['policy']>
): NonNullable<TenantDatabaseExportConfig['consistency']> {
  if (value === 'maintenance_read_only' || value === 'best_effort_online') return value;
  return policy === 'scheduled_periodic' ? 'best_effort_online' : 'maintenance_read_only';
}

function normalizeTenantDatabaseExportFormat(value: unknown): TenantDatabaseExportFormat {
  if (value === undefined || value === null || value === 'jsonl_per_table') {
    return 'jsonl_per_table';
  }
  if (value === 'sqlite_d1_dump' || value === 'parquet') {
    throw new Error(`tenant_database_export_format_not_implemented:${value}`);
  }
  throw new Error('Invalid tenant database export_format');
}

function normalizeTenantDatabaseRestoreDryRunValidationMode(
  value: unknown
): TenantDatabaseRestoreDryRunValidationMode {
  if (value === undefined || value === null || value === 'manifest_checksum') {
    return 'manifest_checksum';
  }
  if (value === 'temporary_database_schema_import') {
    throw new Error('tenant_database_restore_dry_run_temp_database_import_not_implemented');
  }
  throw new Error('Invalid tenant database restore dry-run validation_mode');
}

function normalizeTenantBackupRetentionDays(configValue: unknown, env: Env): number {
  const envValue = (env as unknown as { TENANT_BACKUP_RETENTION_DAYS?: string | number })
    .TENANT_BACKUP_RETENTION_DAYS;
  const value = configValue ?? envValue ?? DEFAULT_TENANT_BACKUP_RETENTION_DAYS;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_TENANT_BACKUP_RETENTION_DAYS) {
    throw new Error(
      `Invalid tenant backup retention_days; expected 1-${MAX_TENANT_BACKUP_RETENTION_DAYS}`
    );
  }
  return parsed;
}

function assertTenantDatabaseRestoreDryRunApproval(
  config: TenantDatabaseRestoreDryRunConfig
): void {
  if (!Array.isArray(config.actor_roles) || !config.actor_roles.includes('system_admin')) {
    throw new Error('tenant_database_restore_dry_run_requires_system_admin');
  }
  if (config.break_glass_confirmation !== TENANT_DATABASE_RESTORE_DRY_RUN_CONFIRMATION) {
    throw new Error('tenant_database_restore_dry_run_requires_break_glass_confirmation');
  }
  if (!config.reason?.trim()) {
    throw new Error('tenant_database_restore_dry_run_requires_reason');
  }
}

function assertTenantDatabaseBackupPurgeApproval(config: TenantDatabasePurgeBackupConfig): void {
  if (!Array.isArray(config.actor_roles) || !config.actor_roles.includes('system_admin')) {
    throw new Error('tenant_database_backup_purge_requires_system_admin');
  }
  if (config.break_glass_confirmation !== TENANT_DATABASE_BACKUP_PURGE_CONFIRMATION) {
    throw new Error('tenant_database_backup_purge_requires_break_glass_confirmation');
  }
  if (!config.reason?.trim()) {
    throw new Error('tenant_database_backup_purge_requires_reason');
  }
}

function normalizeTenantBackupCompletedAt(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsedMs = Date.parse(value);
    if (Number.isFinite(parsedMs)) {
      return Math.floor(parsedMs / 1000);
    }
  }
  throw new Error('tenant_database_backup_purge_requires_completed_at');
}

function assertTenantBackupRetentionElapsed(completedAt: number, retentionDays: number): void {
  const eligibleAt = completedAt + retentionDays * 24 * 60 * 60;
  const nowTs = Math.floor(Date.now() / 1000);
  if (nowTs < eligibleAt) {
    throw new Error(`tenant_database_backup_purge_retention_not_elapsed:${eligibleAt}`);
  }
}

function parseTenantDatabaseExportJobResult(value: string | null): TenantDatabaseExportJobResult {
  if (!value) {
    throw new Error('tenant_database_backup_purge_source_export_missing_result');
  }
  const parsed = JSON.parse(value) as TenantDatabaseExportJobResult;
  if (!parsed.manifest?.object_catalog_id || !Array.isArray(parsed.table_artifacts)) {
    throw new Error('tenant_database_backup_purge_source_export_invalid_result');
  }
  return parsed;
}

function normalizeTenantBackupTables(
  requested: string[] | undefined,
  allowed: readonly string[]
): string[] {
  if (!requested || requested.length === 0) return [...allowed];
  const allowedSet = new Set(allowed);
  const normalized = Array.from(new Set(requested.map((table) => table.trim()).filter(Boolean)));
  for (const table of normalized) {
    if (!allowedSet.has(table)) {
      throw new Error(`Unsupported tenant backup table: ${table}`);
    }
  }
  return normalized;
}

function safeObjectKeySegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._=-]+/g, '_').slice(0, 160) || 'unknown';
}

function buildTenantTableObjectKey(job: AdminJobRow, plane: 'core' | 'pii', table: string): string {
  return [
    'exports',
    safeObjectKeySegment(job.tenant_id),
    'tenant-backup',
    safeObjectKeySegment(job.id),
    safeObjectKeySegment(plane),
    `${safeObjectKeySegment(table)}.jsonl`,
  ].join('/');
}

async function exportTenantTableToArtifact(input: {
  adapter: DatabaseAdapter;
  artifactAdapter: DatabaseAdapter;
  bucket: R2Bucket;
  rootKeyHex: string;
  keyVersion: number;
  job: AdminJobRow;
  plane: 'core' | 'pii';
  table: string;
}): Promise<{
  plane: 'core' | 'pii';
  table: string;
  row_count: number;
  plaintext_bytes: number;
  plaintext_sha256: string;
  object_catalog_id: string;
  public_artifact_id: string;
  object_key: string;
  chunked: boolean;
  chunk_count: number;
}> {
  const tenantScopedQuery =
    input.plane === 'pii' && input.table === 'subject_identifiers'
      ? `SELECT scoped.* FROM subject_identifiers AS scoped
           INNER JOIN users_pii AS tenant_parent ON tenant_parent.id = scoped.user_id
           WHERE tenant_parent.tenant_id = ? LIMIT ?`
      : `SELECT * FROM ${input.table} WHERE tenant_id = ? LIMIT ?`;
  const rows = await input.adapter.query<Record<string, unknown>>(tenantScopedQuery, [
    input.job.tenant_id,
    TENANT_BACKUP_TABLE_ROW_LIMIT + 1,
  ]);
  if (rows.length > TENANT_BACKUP_TABLE_ROW_LIMIT) {
    throw new Error(
      `tenant_backup_table_row_limit_exceeded:${input.plane}:${input.table}:${TENANT_BACKUP_TABLE_ROW_LIMIT}`
    );
  }
  const content = rows.map((row) => JSON.stringify(row)).join('\n');
  const objectKey = buildTenantTableObjectKey(input.job, input.plane, input.table);
  const artifact = await materializeEncryptedObjectArtifact(input.artifactAdapter, input.bucket, {
    tenantId: input.job.tenant_id,
    objectClass: 'dr_bundle',
    representation: 'ndjson_projection',
    objectKeyBase: objectKey,
    content,
    contentType: 'application/x-ndjson',
    rootKeyHex: input.rootKeyHex,
    keyVersion: input.keyVersion,
  });
  return {
    plane: input.plane,
    table: input.table,
    row_count: rows.length,
    plaintext_bytes: utf8ByteLength(content),
    plaintext_sha256: await sha256Hex(content),
    object_catalog_id: artifact.catalogId,
    public_artifact_id: artifact.publicArtifactId,
    object_key: artifact.primaryObjectKey,
    chunked: artifact.chunked,
    chunk_count: artifact.chunkCount,
  };
}

function isTenantBackupCatalogObjectRow(value: {
  object_class: string;
  representation: string;
  object_kind: string;
  bucket_binding: string;
}): value is TenantBackupCatalogObjectRow {
  return (
    value.object_class === 'dr_bundle' &&
    (value.representation === 'canonical_json' || value.representation === 'ndjson_projection') &&
    (value.object_kind === 'single' ||
      value.object_kind === 'manifest' ||
      value.object_kind === 'chunk') &&
    value.bucket_binding === 'EXPORT_ARTIFACTS'
  );
}

async function listTenantBackupCatalogObjects(input: {
  adapter: DatabaseAdapter;
  tenantId: string;
  catalogId?: string;
  publicArtifactId?: string;
  representation: ObjectRepresentation;
}): Promise<TenantBackupCatalogObjectRow[]> {
  if (!input.catalogId && !input.publicArtifactId) {
    throw new Error('tenant_backup_restore_dry_run_requires_manifest_artifact_id');
  }
  const identifierColumn = input.catalogId ? 'oc.id' : 'oc.public_artifact_id';
  const identifierValue = input.catalogId ?? input.publicArtifactId;
  const rows = await input.adapter.query<{
    catalog_id: string;
    public_artifact_id: string;
    tenant_id: string;
    object_class: string;
    representation: string;
    object_kind: string;
    object_index: number;
    bucket_binding: string;
    object_key: string;
    key_version: number;
    checksum_sha256: string | null;
  }>(
    `SELECT
       oc.id AS catalog_id,
       oc.public_artifact_id,
       oc.tenant_id,
       oc.object_class,
       oco.representation,
       oco.object_kind,
       oco.object_index,
       oco.bucket_binding,
       oco.object_key,
       oco.key_version,
       oco.checksum_sha256
     FROM object_catalog oc
     INNER JOIN object_catalog_objects oco ON oco.catalog_id = oc.id
     WHERE oc.tenant_id = ?
       AND ${identifierColumn} = ?
       AND oc.deleted_at IS NULL
       AND oco.deleted_at IS NULL
       AND oco.representation = ?
     ORDER BY oco.object_index ASC`,
    [input.tenantId, identifierValue, input.representation]
  );
  const normalized = rows.filter(isTenantBackupCatalogObjectRow);
  if (normalized.length !== rows.length || normalized.length === 0) {
    throw new Error('tenant_backup_restore_dry_run_artifact_not_found_or_invalid');
  }
  return normalized;
}

async function readR2ObjectText(bucket: R2Bucket, objectKey: string): Promise<string> {
  const object = await bucket.get(objectKey);
  if (!object) {
    throw new Error(`tenant_backup_restore_dry_run_missing_object:${objectKey}`);
  }
  return readR2ObjectTextWithLimit(object, TENANT_BACKUP_ARTIFACT_OBJECT_MAX_BYTES);
}

async function loadTenantBackupArtifactContent(input: {
  adapter: DatabaseAdapter;
  bucket: R2Bucket;
  env: Env;
  tenantId: string;
  catalogId?: string;
  publicArtifactId?: string;
  representation: ObjectRepresentation;
}): Promise<{ content: string; catalogId: string; publicArtifactId: string }> {
  const rows = await listTenantBackupCatalogObjects(input);
  const payloadRows = rows.filter((row) => row.object_kind !== 'manifest');
  if (payloadRows.length === 0) {
    throw new Error('tenant_backup_restore_dry_run_no_payload_objects');
  }

  const chunks: string[] = [];
  for (const row of payloadRows) {
    const rawPayload = await readR2ObjectText(input.bucket, row.object_key);
    if (row.checksum_sha256 && (await sha256Hex(rawPayload)) !== row.checksum_sha256) {
      throw new Error(`tenant_backup_restore_dry_run_envelope_checksum_mismatch:${row.object_key}`);
    }
    const envelope = JSON.parse(rawPayload) as Parameters<typeof decryptObjectArtifact>[0];
    const encryptionMaterial = await resolveTenantBackupEncryptionMaterial(
      input.env,
      input.tenantId,
      row.key_version
    );
    chunks.push(
      await decryptObjectArtifact(envelope, {
        rootKeyHex: encryptionMaterial.rootKeyHex,
        context: {
          tenantId: input.tenantId,
          objectKey: row.object_key,
          objectClass: row.object_class,
        },
      })
    );
  }

  const first = rows[0];
  return {
    content: chunks.join(''),
    catalogId: first.catalog_id,
    publicArtifactId: first.public_artifact_id,
  };
}

function parseTenantBackupManifest(content: string, tenantId: string): TenantBackupManifest {
  const parsed = JSON.parse(content) as Partial<TenantBackupManifest>;
  if (
    parsed.version !== 1 ||
    parsed.tenant_id !== tenantId ||
    parsed.export_format !== 'jsonl_per_table' ||
    !Array.isArray(parsed.tables) ||
    !parsed.checksums?.whole_export_sha256 ||
    parsed.encryption?.plane !== 'EXPORT_ARTIFACTS' ||
    typeof parsed.encryption.key_version !== 'number'
  ) {
    throw new Error('tenant_backup_restore_dry_run_invalid_manifest');
  }
  return parsed as TenantBackupManifest;
}

function countJsonlRows(content: string): number {
  if (content.length === 0) return 0;
  return content.split('\n').length;
}

async function processTenantDatabaseExportJob(
  env: Env,
  adapter: DatabaseAdapter,
  job: AdminJobRow
): Promise<AdminJobProcessorResult> {
  if (!env.EXPORT_ARTIFACTS) {
    throw new Error('EXPORT_ARTIFACTS binding is required for tenant database export');
  }

  const config = parseJsonConfig<TenantDatabaseExportConfig>(job);
  normalizeResultDelivery(config.result_delivery);
  const policy = normalizeTenantDatabaseExportPolicy(config.policy);
  const consistency = normalizeTenantDatabaseExportConsistency(config.consistency, policy);
  const exportFormat = normalizeTenantDatabaseExportFormat(config.export_format);
  const retentionDays = normalizeTenantBackupRetentionDays(config.retention_days, env);
  const coreTables = normalizeTenantBackupTables(config.tables?.core, TENANT_BACKUP_CORE_TABLES);
  const piiTables = normalizeTenantBackupTables(config.tables?.pii, TENANT_BACKUP_PII_TABLES);
  const runtimeSources = await resolveUserStoreRuntimeSourcesFromEnv(env, job.tenant_id, {
    requestPath: '/internal/admin-jobs/tenant-database/export',
  });
  const coreAdapter = ensureDatabaseAdapter(runtimeSources.coreDb, 'core');
  const piiAdapter = runtimeSources.piiDb
    ? ensureDatabaseAdapter(runtimeSources.piiDb, 'pii')
    : coreAdapter;
  const keyVersion = Number.parseInt(env.OBJECT_ENCRYPTION_KEY_VERSION || '1', 10) || 1;
  const encryptionMaterial = await resolveTenantBackupEncryptionMaterial(
    env,
    job.tenant_id,
    keyVersion
  );
  const startedAt = new Date().toISOString();
  const tableArtifacts = [];

  for (const table of coreTables) {
    tableArtifacts.push(
      await exportTenantTableToArtifact({
        adapter: coreAdapter,
        artifactAdapter: adapter,
        bucket: env.EXPORT_ARTIFACTS,
        rootKeyHex: encryptionMaterial.rootKeyHex,
        keyVersion,
        job,
        plane: 'core',
        table,
      })
    );
  }
  for (const table of piiTables) {
    tableArtifacts.push(
      await exportTenantTableToArtifact({
        adapter: piiAdapter,
        artifactAdapter: adapter,
        bucket: env.EXPORT_ARTIFACTS,
        rootKeyHex: encryptionMaterial.rootKeyHex,
        keyVersion,
        job,
        plane: 'pii',
        table,
      })
    );
  }

  const manifest = {
    version: 1,
    tenant_id: job.tenant_id,
    job_id: job.id,
    profile: runtimeSources.storageProfile.id,
    schema_version: runtimeSources.userCacheScope.schemaVersion,
    export_format: 'jsonl_per_table',
    consistency,
    policy,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    retention_days: retentionDays,
    restore_order: tableArtifacts.map((artifact) => ({
      plane: artifact.plane,
      table: artifact.table,
    })),
    tables: tableArtifacts,
    checksums: {
      whole_export_sha256: await sha256Hex(
        tableArtifacts.map((artifact) => artifact.plaintext_sha256).join('\n')
      ),
    },
    encryption: {
      ...encryptionMaterial.metadata,
      plane: 'EXPORT_ARTIFACTS',
      key_version: keyVersion,
    },
  };
  const manifestContent = JSON.stringify(manifest, null, 2);
  const manifestArtifact = await materializeEncryptedObjectArtifact(adapter, env.EXPORT_ARTIFACTS, {
    tenantId: job.tenant_id,
    objectClass: 'dr_bundle',
    representation: 'canonical_json',
    objectKeyBase: `exports/${job.tenant_id}/tenant-backup/${job.id}/manifest.json`,
    content: manifestContent,
    contentType: 'application/json',
    rootKeyHex: encryptionMaterial.rootKeyHex,
    keyVersion,
  });

  return {
    status: 'completed',
    progress: {
      total: tableArtifacts.length,
      processed: tableArtifacts.length,
      succeeded: tableArtifacts.length,
      failed: 0,
      stage: 'completed',
    },
    result: {
      summary: {
        total_tables: tableArtifacts.length,
        total_rows: tableArtifacts.reduce((sum, artifact) => sum + artifact.row_count, 0),
        policy,
        consistency,
        export_format: exportFormat,
        retention_days: retentionDays,
      },
      manifest: {
        object_catalog_id: manifestArtifact.catalogId,
        public_artifact_id: manifestArtifact.publicArtifactId,
        object_key: manifestArtifact.primaryObjectKey,
        checksum_sha256: await sha256Hex(manifestContent),
        encryption: {
          ...encryptionMaterial.metadata,
          plane: 'EXPORT_ARTIFACTS',
          key_version: keyVersion,
        },
      },
      table_artifacts: tableArtifacts,
    },
  };
}

async function processTenantDatabaseRestoreDryRunJob(
  env: Env,
  adapter: DatabaseAdapter,
  job: AdminJobRow
): Promise<AdminJobProcessorResult> {
  if (!env.EXPORT_ARTIFACTS) {
    throw new Error('EXPORT_ARTIFACTS binding is required for tenant database restore dry-run');
  }

  const config = parseJsonConfig<TenantDatabaseRestoreDryRunConfig>(job);
  normalizeResultDelivery(config.result_delivery);
  const validationMode = normalizeTenantDatabaseRestoreDryRunValidationMode(config.validation_mode);
  assertTenantDatabaseRestoreDryRunApproval(config);
  const manifestArtifact = await loadTenantBackupArtifactContent({
    adapter,
    bucket: env.EXPORT_ARTIFACTS,
    tenantId: job.tenant_id,
    catalogId: config.manifest_object_catalog_id,
    publicArtifactId: config.manifest_public_artifact_id,
    representation: 'canonical_json',
    env,
  });
  const manifest = parseTenantBackupManifest(manifestArtifact.content, job.tenant_id);

  const expectedWholeChecksum = await sha256Hex(
    manifest.tables.map((artifact) => artifact.plaintext_sha256).join('\n')
  );
  if (expectedWholeChecksum !== manifest.checksums.whole_export_sha256) {
    throw new Error('tenant_backup_restore_dry_run_whole_checksum_mismatch');
  }

  const validations = [];
  for (const table of manifest.tables) {
    const tableArtifact = await loadTenantBackupArtifactContent({
      adapter,
      bucket: env.EXPORT_ARTIFACTS,
      tenantId: job.tenant_id,
      catalogId: table.object_catalog_id,
      representation: 'ndjson_projection',
      env,
    });
    const actualChecksum = await sha256Hex(tableArtifact.content);
    const actualBytes = utf8ByteLength(tableArtifact.content);
    const actualRows = countJsonlRows(tableArtifact.content);
    if (actualChecksum !== table.plaintext_sha256) {
      throw new Error(
        `tenant_backup_restore_dry_run_table_checksum_mismatch:${table.plane}:${table.table}`
      );
    }
    if (actualBytes !== table.plaintext_bytes) {
      throw new Error(
        `tenant_backup_restore_dry_run_table_byte_count_mismatch:${table.plane}:${table.table}`
      );
    }
    if (actualRows !== table.row_count) {
      throw new Error(
        `tenant_backup_restore_dry_run_table_row_count_mismatch:${table.plane}:${table.table}`
      );
    }
    validations.push({
      plane: table.plane,
      table: table.table,
      row_count: actualRows,
      plaintext_bytes: actualBytes,
      checksum_sha256: actualChecksum,
      object_catalog_id: tableArtifact.catalogId,
      status: 'valid',
    });
  }

  return {
    status: 'completed',
    progress: {
      total: validations.length,
      processed: validations.length,
      succeeded: validations.length,
      failed: 0,
      stage: 'dry_run_completed',
    },
    result: {
      summary: {
        dry_run: true,
        validation_mode: validationMode,
        manifest_valid: true,
        total_tables: validations.length,
        total_rows: validations.reduce((sum, validation) => sum + validation.row_count, 0),
        import_performed: false,
      },
      manifest: {
        object_catalog_id: manifestArtifact.catalogId,
        public_artifact_id: manifestArtifact.publicArtifactId,
        source_job_id: manifest.job_id,
        profile: manifest.profile,
        schema_version: manifest.schema_version,
        consistency: manifest.consistency,
        policy: manifest.policy,
        whole_export_sha256: manifest.checksums.whole_export_sha256,
        encryption: manifest.encryption,
      },
      table_validations: validations,
    },
  };
}

async function processTenantDatabasePurgeBackupJob(
  _env: Env,
  adapter: DatabaseAdapter,
  job: AdminJobRow
): Promise<AdminJobProcessorResult> {
  const config = parseJsonConfig<TenantDatabasePurgeBackupConfig>(job);
  normalizeResultDelivery(config.result_delivery);
  assertTenantDatabaseBackupPurgeApproval(config);

  let completedAt = config.completed_at;
  let retentionDaysSource: unknown = config.retention_days;
  let manifestCatalogId = config.manifest_object_catalog_id;
  let manifestPublicArtifactId = config.manifest_public_artifact_id;
  let tableCatalogIds = Array.from(
    new Set((config.table_object_catalog_ids ?? []).filter((id) => id.trim().length > 0))
  );

  if (config.source_export_job_id) {
    const sourceExport = await adapter.queryOne<{
      id: string;
      result: string | null;
      completed_at: number | null;
    }>(
      `SELECT id, result, completed_at
         FROM admin_jobs
        WHERE id = ?
          AND tenant_id = ?
          AND job_type = 'tenant-database/export'
          AND status = 'completed'`,
      [config.source_export_job_id, job.tenant_id]
    );
    if (!sourceExport) {
      throw new Error(
        `tenant_database_backup_purge_source_export_not_found:${config.source_export_job_id}`
      );
    }

    const sourceResult = parseTenantDatabaseExportJobResult(sourceExport.result);
    completedAt = completedAt ?? sourceExport.completed_at ?? undefined;
    retentionDaysSource = retentionDaysSource ?? sourceResult.summary?.retention_days;
    manifestCatalogId = manifestCatalogId ?? sourceResult.manifest?.object_catalog_id;
    manifestPublicArtifactId =
      manifestPublicArtifactId ?? sourceResult.manifest?.public_artifact_id;
    const sourceTableArtifacts = sourceResult.table_artifacts ?? [];
    tableCatalogIds = Array.from(
      new Set([
        ...tableCatalogIds,
        ...sourceTableArtifacts
          .map((artifact) => artifact.object_catalog_id)
          .filter((id): id is string => typeof id === 'string' && id.trim().length > 0),
      ])
    );
  }

  const retentionDays = normalizeTenantBackupRetentionDays(retentionDaysSource, _env);
  const normalizedCompletedAt = normalizeTenantBackupCompletedAt(completedAt);
  assertTenantBackupRetentionElapsed(normalizedCompletedAt, retentionDays);

  const catalogIds = Array.from(
    new Set([manifestCatalogId, ...tableCatalogIds].filter((id): id is string => !!id))
  );
  if (catalogIds.length === 0 && !manifestPublicArtifactId) {
    throw new Error('tenant_database_backup_purge_requires_artifact_reference');
  }
  if (!manifestCatalogId && manifestPublicArtifactId) {
    throw new Error('tenant_database_backup_purge_requires_catalog_id_for_purge');
  }

  const deletedAt = Date.now();
  for (const catalogId of catalogIds) {
    await tombstoneObjectCatalogEntryForTenant(adapter, job.tenant_id, catalogId, deletedAt);
  }

  return {
    status: 'completed',
    progress: {
      total: catalogIds.length,
      processed: catalogIds.length,
      succeeded: catalogIds.length,
      failed: 0,
      stage: 'tombstoned',
    },
    result: {
      summary: {
        tombstoned_catalogs: catalogIds.length,
        source_export_job_id: config.source_export_job_id ?? null,
        retention_days: retentionDays,
        completed_at: normalizedCompletedAt,
        physical_purge_deferred_to_object_artifact_cleanup: true,
      },
      manifest: {
        object_catalog_id: manifestCatalogId ?? null,
        public_artifact_id: manifestPublicArtifactId ?? null,
      },
      table_object_catalog_ids: tableCatalogIds,
    },
  };
}

async function processBulkUserUpdateJob(
  env: Env,
  adapter: DatabaseAdapter,
  job: AdminJobRow
): Promise<AdminJobProcessorResult> {
  const config = parseJsonConfig<BulkUserUpdateConfig>(job);
  validateBulkUserUpdateConfig(config);
  const filter = buildUserFilterWhere(job.tenant_id, config.filter);
  const total = await countBulkUserUpdateTargets(adapter, job.tenant_id, config);
  const nowMs = Date.now();

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
    selectionClauses.push('legacy_user_id > ?');
    selectionParams.push(cursor);
  }

  const selected = await adapter.query<{ id: string }>(
    `SELECT legacy_user_id as id FROM identity_accounts
      WHERE ${selectionClauses.join(' AND ')}
        AND legacy_user_id IS NOT NULL
      ORDER BY legacy_user_id ASC
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
    const normalized = column.normalize(config.values[field]);
    if (field === 'status') {
      assignments.push(`metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.status', ?)`);
      values.push(normalized);
    } else if (field === 'is_active') {
      assignments.push('lifecycle_state = ?');
      values.push(normalized === 1 ? 'active' : 'deprovisioned');
    } else {
      assignments.push(`${column.sql} = ?`);
      values.push(normalized);
    }
  }
  assignments.push('updated_at = ?');
  values.push(nowMs);

  const ids = selected.map((row) => row.id);
  const requestedStatus =
    typeof config.values.status === 'string' ? config.values.status : undefined;
  const requestedActive =
    typeof config.values.is_active === 'boolean' ? config.values.is_active : undefined;
  const targetLifecycle =
    requestedActive === false
      ? 'inactive'
      : requestedActive === true || requestedStatus === 'active'
        ? 'active'
        : requestedStatus === 'suspended' || requestedStatus === 'locked'
          ? requestedStatus
          : null;
  if (targetLifecycle && targetLifecycle !== 'active') {
    await Promise.all(
      ids.map((userId) =>
        transitionAccountAuthenticationState(env, {
          tenantId: job.tenant_id,
          userId,
          lifecycle: targetLifecycle,
          sourceVersionMs: nowMs,
          operationId: crypto.randomUUID(),
          revokeSessions: true,
        })
      )
    );
  }
  const idPlaceholders = ids.map(() => '?').join(', ');
  const updateResult = await adapter.execute(
    `UPDATE identity_accounts SET ${assignments.join(', ')} WHERE tenant_id = ? AND legacy_user_id IN (${idPlaceholders})`,
    [...values, job.tenant_id, ...ids]
  );
  if (targetLifecycle === 'active') {
    await Promise.all(
      ids.map((userId) =>
        transitionAccountAuthenticationState(env, {
          tenantId: job.tenant_id,
          userId,
          lifecycle: 'active',
          sourceVersionMs: nowMs,
          operationId: crypto.randomUUID(),
          revokeSessions: false,
        })
      )
    );
  }
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
    const rawText = value === null || value === undefined ? '' : String(value);
    const trimmed = rawText.trimStart();
    const text =
      trimmed.startsWith('=') ||
      trimmed.startsWith('+') ||
      trimmed.startsWith('@') ||
      /^-\D/.test(trimmed) ||
      /^[\t\r]/.test(rawText)
        ? `'${rawText}`
        : rawText;
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
        `SELECT json_extract(COALESCE(metadata_json, '{}'), '$.status') as status, COUNT(*) as count
           FROM identity_accounts
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
      "SELECT legacy_user_id as id FROM identity_accounts WHERE legacy_user_id = ? AND tenant_id = ? AND lifecycle_state = 'active'",
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
  'tenants/lifecycle-validation': processTenantLifecycleValidationJob,
  'tenant-database/provision': processTenantDatabaseProvisionJob,
  'tenant-database/export': processTenantDatabaseExportJob,
  'tenant-database/restore-dry-run': processTenantDatabaseRestoreDryRunJob,
  'tenant-database/purge-backup': processTenantDatabasePurgeBackupJob,
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
  return [
    'exports',
    safeObjectKeySegment(job.tenant_id),
    'admin-jobs',
    safeObjectKeySegment(safeJobType),
    safeObjectKeySegment(job.id),
    'result.json',
  ].join('/');
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
  const lifecycleCheckId = (() => {
    if (job.job_type !== 'tenants/lifecycle-validation') return null;
    if (message.includes('_kv_') || message.includes('tenant_settings')) return 'kv';
    if (message.includes('_r2_')) return 'r2';
    if (message.includes('_scim_')) return 'scim';
    if (message.includes('_saml_')) return 'saml';
    if (message.includes('_issuer_') || message.includes('_discovery_')) return 'discovery_issuer';
    if (message.includes('_write_read_')) return 'tenant_db_write_read';
    if (message.includes('_audit_')) return 'audit_sink';
    if (message.includes('_state_') || message.includes('_activation_')) return 'control_db';
    return 'tenant_db_read';
  })();
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
    ...(lifecycleCheckId
      ? { checks: [{ id: lifecycleCheckId, status: 'failed', evidence: message }] }
      : {}),
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
            next_run_at,
            (SELECT lifecycle_state FROM tenants WHERE tenants.id = admin_jobs.tenant_id)
              AS tenant_lifecycle_state
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

    if (
      typeof job.tenant_lifecycle_state === 'string' &&
      !isAdminJobAllowedForTenantLifecycle(job.tenant_lifecycle_state, job.job_type)
    ) {
      const blockedAt = Math.floor(Date.now() / 1000);
      await adapter.execute(
        `UPDATE admin_jobs
            SET status = 'partial_failure', progress = ?, error_message = ?, completed_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND status IN ('pending', 'processing')`,
        [
          JSON.stringify({ stage: 'blocked_by_tenant_lifecycle', processed: 0, failed: 1 }),
          `tenant_lifecycle_blocked:${job.tenant_lifecycle_state}`,
          blockedAt,
          blockedAt,
          job.id,
          job.tenant_id,
        ]
      );
      continue;
    }

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
    await emitAdminJobRuntimeLog(env, adapter, logger, {
      job,
      status: 'processing',
      eventAt: startedTs * 1000,
      attemptCount: getAttemptCount(job),
    });

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
        await emitAdminJobRuntimeLog(env, adapter, logger, {
          job,
          status: 'processing',
          eventAt: continuationTs * 1000,
          attemptCount: getAttemptCount(job),
          nextRunAt: result.nextRunAt ?? continuationTs,
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
      await emitAdminJobRuntimeLog(env, adapter, logger, {
        job,
        status: result.status,
        eventAt: completedTs * 1000,
        attemptCount: getAttemptCount(job),
        completedAt: completedTs,
        objectCatalogId: finalized.objectCatalogId,
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
        if (job.job_type === 'tenants/lifecycle-validation') {
          const failureResult = JSON.parse(
            buildFailureResult(job, error, nextAttemptCount)
          ) as Record<string, unknown>;
          await adapter.execute(
            `UPDATE admin_jobs
              SET status = 'pending', progress = ?, error_message = ?, attempt_count = ?,
                  max_attempts = COALESCE(max_attempts, ?), next_run_at = ?, updated_at = ?
            WHERE id = ? AND tenant_id = ?`,
            [
              JSON.stringify({
                stage: 'validation_failed_retry_scheduled',
                checks: failureResult.checks ?? [],
              }),
              String(error),
              nextAttemptCount,
              maxAttempts,
              nextRunAt,
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
            [
              String(error),
              nextAttemptCount,
              maxAttempts,
              nextRunAt,
              failedTs,
              job.id,
              job.tenant_id,
            ]
          );
        }
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
      if (job.job_type === 'tenants/lifecycle-validation') {
        await writeTenantLifecycleJobAudit(env, adapter, job, {
          action: exhausted
            ? 'tenant.lifecycle.validation_failed'
            : 'tenant.lifecycle.validation_retry_scheduled',
          result: 'failure',
          severity: 'error',
          error,
          metadata: {
            attempt_count: nextAttemptCount,
            max_attempts: maxAttempts,
            next_run_at: nextRunAt,
            safe_state_preserved: true,
          },
        }).catch((auditError) => {
          logger.error(
            'Failed to write tenant lifecycle validation audit',
            { job_id: job.id, tenant_id: job.tenant_id },
            auditError as Error
          );
        });
      }
      await emitAdminJobRuntimeLog(env, adapter, logger, {
        job,
        status: exhausted ? 'failed' : 'retrying',
        eventAt: failedTs * 1000,
        attemptCount: nextAttemptCount,
        nextRunAt,
        completedAt: exhausted ? failedTs : null,
        errorClass: error instanceof Error ? error.name : 'Error',
      });
    }
  }
}
