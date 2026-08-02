import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import {
  ADMIN_PERMISSIONS,
  AdminLoggingControlRepository,
  AR_ERROR_CODES,
  InternalNotificationEventRepository,
  OBJECT_CLASSES,
  createErrorResponse,
  createRuntimeProfileRegistryFromEnv,
  ensureDatabaseAdapter,
  getTenantIdFromContext,
  hasAdminPermission,
  loadChunkedSensitiveDetailJson,
  loadEnvironmentProfileDefaultsFromEnv,
  readR2ObjectTextWithLimit,
  requireDedicatedAdminDatabaseAdapter,
  resolveRuntimeLoggingPolicyTargetFromEnv,
  resolveTenantDatabaseSourceFromRegistry,
  resolveTenantRuntimeProfilesFromEnv,
  validateUrlForSSRF,
  type DatabaseAdapter,
  type ObjectClass,
  type ResidencyProfile,
  type TenantDatabaseRole,
} from '@authrim/ar-lib-core';
import { createLoggingId, deriveTenantKeyFromTenantId } from '@authrim/ar-lib-logging';
import {
  DESTINATION_PROVIDER_SCHEMAS,
  getDefaultDestinationCapabilities,
  validateDestinationProviderConfig,
  type DestinationCapability,
  type DestinationHealthStatus,
  type DestinationKind,
  type DestinationEncryptionMode,
  type DestinationProvider,
  type DestinationScopeType,
} from '@authrim/ar-lib-logging/destinations';
import {
  activateCredentialRotation,
  D1EncryptedCredentialSecretBackend,
  finishCredentialRetirement,
  classifyLoggingRewrapPriority,
  markCredentialRotationReady,
  parseCredentialSecretRef,
  prepareCredentialRotation,
  R2EncryptedCredentialSecretBackend,
  SqlLoggingRewrapJobQueue,
  type CredentialSecretBackend,
  type CredentialSecretBackendKind,
} from '@authrim/ar-lib-logging/keys';
import {
  decodeLoggingCursor,
  encodeLoggingCursor,
  parseLoggingDeliveryQueuePayload,
  type LoggingDeliveryLane,
  type LoggingCursorPayload,
} from '@authrim/ar-lib-logging/delivery';
import {
  buildDangerousLogCatalogRepairPlan,
  normalizeR2Prefix,
  type DangerousLogCatalogRepairAction,
  type DangerousLogCatalogRepairPlan,
} from '@authrim/ar-lib-logging/chunks';
import {
  buildRuntimeLoggingPolicySnapshotPointerKey,
  createRuntimeLoggingPolicySnapshot,
  publishRuntimeLoggingPolicySnapshot,
  type LoggingFallbackMode,
} from '@authrim/ar-lib-logging/policies';
import {
  enqueueLoggingMessagePayload,
  SqlLoggingMessageJobStore,
  writeLoggingMessagePayloadToR2,
  type ExportBuildMessagePayload,
  type LoggingMessageJobKind,
  type LoggingMessageJobRepairFindingRecord,
  type LoggingMessageJobRecord,
  type LoggingMessageJobSourceType,
  type LoggingMessageJobStatus,
  type RetryDeliveryMessagePayload,
} from '@authrim/ar-lib-logging/messaging';
import {
  LOGGING_ADMIN_AUDIT_COVERAGE_REGISTRY,
  buildAdminAuditCoverageStatusView,
  summarizeAdminAuditCoverage,
} from '@authrim/ar-lib-logging/coverage';
import { LOG_PLANES, LOG_TYPES, type LogPlane, type LogType } from '@authrim/ar-lib-logging';
import { writeAdminAuditLog } from '../../admin-shared';
import {
  adminActionEnvelope,
  adminDetailEnvelope,
  adminListEnvelope,
  adminMutationEnvelope,
  createAdminErrorResponseWithDetails,
  createAdminFieldErrorResponse,
  createAdminPermissionErrorResponse,
  fieldError,
} from './response-helpers';
import { createLoggingTenantKeyResolverFromSource } from '../../logging-tenant-key';

type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

const DELIVERY_EVENTS_CURSOR_TTL_MS = 15 * 60 * 1000;
const LOGGING_EXPORT_CREATE_PERMISSION = 'admin:logging:exports:create';
const LOGGING_SENSITIVE_DETAIL_EXPORT_PERMISSION = 'admin:logging:sensitive_detail:export';
const LOGGING_DELIVERY_RETRY_PERMISSION = 'admin:logging:delivery:retry';
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
const LOGGING_USAGE_WINDOW_KINDS = ['hour', 'day'] as const;
const LOGGING_QUOTA_ENFORCEMENT_MODES = [
  'disabled',
  'observe',
  'warn_only',
  'soft_limit',
  'hard_non_critical',
] as const;
const TENANT_DATABASE_PROBE_ROLES: readonly TenantDatabaseRole[] = [
  'tenant_core',
  'tenant_pii',
  'tenant_audit',
  'tenant_custom',
];
const NOTIFICATION_DELIVERY_PROVIDERS = ['webhook', 'email', 'slack', 'custom'] as const;
const NOTIFICATION_DELIVERY_MIN_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
const NOTIFICATION_DELIVERY_FAILURE_POLICIES = [
  'best_effort',
  'retry_until_dead_letter',
  'fail_closed',
] as const;

type LoggingQuotaMetric = (typeof LOGGING_QUOTA_METRICS)[number];
type LoggingUsageWindowKind = (typeof LOGGING_USAGE_WINDOW_KINDS)[number];
type LoggingQuotaEnforcementMode = (typeof LOGGING_QUOTA_ENFORCEMENT_MODES)[number];
type NotificationDeliveryProvider = (typeof NOTIFICATION_DELIVERY_PROVIDERS)[number];
type NotificationDeliveryMinSeverity = (typeof NOTIFICATION_DELIVERY_MIN_SEVERITIES)[number];
type NotificationDeliveryFailurePolicy = (typeof NOTIFICATION_DELIVERY_FAILURE_POLICIES)[number];

const NOTIFICATION_SEVERITY_RANK: Record<NotificationDeliveryMinSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

function getAdminAdapter(c: AdminContext) {
  return requireDedicatedAdminDatabaseAdapter(c.env, 'admin-logging-control');
}

function getAdminLoggingControlRepository(c: AdminContext) {
  return new AdminLoggingControlRepository(getAdminAdapter(c));
}

function getAuth(c: AdminContext): AdminAuthContext {
  return c.get('adminAuth') as AdminAuthContext;
}

function hasPermission(authContext: AdminAuthContext, permission: string): boolean {
  return hasAdminPermission(authContext.permissions || [], permission);
}

function hasAnyPermission(authContext: AdminAuthContext, permissions: string[]): boolean {
  return permissions.some((permission) => hasPermission(authContext, permission));
}

function hasPlatformAuthority(authContext: AdminAuthContext): boolean {
  return (
    hasPermission(authContext, ADMIN_PERMISSIONS.ALL) ||
    (authContext.roles || []).includes('super_admin') ||
    (authContext.roles || []).includes('system_admin') ||
    authContext.tenantScope?.includes('*') === true
  );
}

async function requirePlatformAuthority(c: AdminContext): Promise<Response | null> {
  if (hasPlatformAuthority(getAuth(c))) {
    return null;
  }
  return createAdminPermissionErrorResponse(c, {
    required_scope: 'platform',
    reason: 'platform_authority_required',
  });
}

async function resolveScopedTenantKey(c: AdminContext, tenantId: string): Promise<string> {
  const resolver = createLoggingTenantKeyResolverFromSource(
    getAdminAdapter(c),
    'admin-logging-control-tenant-key'
  );
  const resolved = await resolver?.(tenantId);
  return resolved ?? deriveTenantKeyFromTenantId(tenantId, c.env.LOGGING_TENANT_KEY_SALT);
}

async function resolveTenantKeyFilter(
  c: AdminContext,
  requestedTenantKey: string | undefined
): Promise<{ ok: true; tenantKey: string | null } | { ok: false; response: Response }> {
  if (hasPlatformAuthority(getAuth(c))) {
    return { ok: true, tenantKey: requestedTenantKey ?? null };
  }

  const tenantId = getTenantIdFromContext(c);
  const scopedTenantKey = await resolveScopedTenantKey(c, tenantId);
  if (requestedTenantKey && requestedTenantKey !== scopedTenantKey) {
    return {
      ok: false,
      response: await createAdminPermissionErrorResponse(c, {
        required_scope: 'current_tenant',
        reason: 'tenant_key_scope_mismatch',
      }),
    };
  }
  return { ok: true, tenantKey: scopedTenantKey };
}

async function resolveTenantKeyOrTenantIdFilter(
  c: AdminContext,
  input: { tenantKey?: string; tenantId?: string }
): Promise<{ ok: true; tenantKey: string | null } | { ok: false; response: Response }> {
  const requestedTenantKey = parseOptionalString(input.tenantKey) ?? undefined;
  const requestedTenantId = parseOptionalString(input.tenantId) ?? undefined;

  if (hasPlatformAuthority(getAuth(c))) {
    if (!requestedTenantId) {
      return { ok: true, tenantKey: requestedTenantKey ?? null };
    }

    const resolvedTenantKey = await resolveScopedTenantKey(c, requestedTenantId);
    if (requestedTenantKey && requestedTenantKey !== resolvedTenantKey) {
      return {
        ok: false,
        response: await createAdminFieldErrorResponse(c, [
          fieldError(
            'tenant_id',
            'tenant_key_mismatch',
            'tenant_id and tenant_key do not refer to the same tenant.'
          ),
        ]),
      };
    }
    return { ok: true, tenantKey: resolvedTenantKey };
  }

  const tenantId = getTenantIdFromContext(c);
  if (requestedTenantId && requestedTenantId !== tenantId) {
    return {
      ok: false,
      response: await createAdminPermissionErrorResponse(c, {
        required_scope: 'current_tenant',
        reason: 'tenant_id_scope_mismatch',
      }),
    };
  }

  const scopedTenantKey = await resolveScopedTenantKey(c, tenantId);
  if (requestedTenantKey && requestedTenantKey !== scopedTenantKey) {
    return {
      ok: false,
      response: await createAdminPermissionErrorResponse(c, {
        required_scope: 'current_tenant',
        reason: 'tenant_key_scope_mismatch',
      }),
    };
  }
  return { ok: true, tenantKey: scopedTenantKey };
}

async function requireTenantKeyAccess(
  c: AdminContext,
  tenantKey: string | null | undefined
): Promise<Response | null> {
  if (hasPlatformAuthority(getAuth(c))) {
    return null;
  }

  const scopedTenantKey = await resolveScopedTenantKey(c, getTenantIdFromContext(c));
  if (tenantKey !== scopedTenantKey) {
    return createAdminPermissionErrorResponse(c, {
      required_scope: 'current_tenant',
      reason: 'tenant_key_scope_mismatch',
    });
  }
  return null;
}

async function resolveTenantIdFilter(
  c: AdminContext,
  requestedTenantId: string | undefined
): Promise<{ ok: true; tenantId: string | null } | { ok: false; response: Response }> {
  if (hasPlatformAuthority(getAuth(c))) {
    return { ok: true, tenantId: requestedTenantId ?? null };
  }

  const tenantId = getTenantIdFromContext(c);
  if (requestedTenantId && requestedTenantId !== tenantId) {
    return {
      ok: false,
      response: await createAdminPermissionErrorResponse(c, {
        required_scope: 'current_tenant',
        reason: 'tenant_scope_mismatch',
      }),
    };
  }
  return { ok: true, tenantId };
}

function parseLimit(c: AdminContext, defaultLimit = 50, maxLimit = 200): number {
  const raw = Number.parseInt(c.req.query('limit') || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return defaultLimit;
  }
  return Math.min(raw, maxLimit);
}

function parseOffset(c: AdminContext): number {
  const raw = Number.parseInt(c.req.query('offset') || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function versionEtag(version: number): string {
  return `"v${version}"`;
}

function parseIfMatchVersion(c: AdminContext): number | null {
  const raw = c.req.header('if-match');
  if (!raw) {
    return null;
  }
  const normalized = raw.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  const version = normalized.startsWith('v')
    ? Number.parseInt(normalized.slice(1), 10)
    : Number.parseInt(normalized, 10);
  return Number.isInteger(version) && version > 0 ? version : Number.NaN;
}

function parseSince(c: AdminContext): number | null {
  const raw = Number.parseInt(
    c.req.query('time_start') || c.req.query('from') || c.req.query('since') || '',
    10
  );
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

function parseUntil(c: AdminContext): number | null {
  const raw = Number.parseInt(
    c.req.query('time_end') || c.req.query('to') || c.req.query('until') || '',
    10
  );
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

function readLoggingMessageKind(value: string | undefined): LoggingMessageJobKind | undefined {
  return value === 'retry_delivery' || value === 'export_build' ? value : undefined;
}

function readLoggingMessageStatus(value: string | undefined): LoggingMessageJobStatus | undefined {
  return value === 'queued' ||
    value === 'claimed' ||
    value === 'running' ||
    value === 'retrying' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'dlq' ||
    value === 'cancelled' ||
    value === 'expired' ||
    value === 'blocked'
    ? value
    : undefined;
}

function readLoggingMessageLane(value: string | undefined): LoggingDeliveryLane | undefined {
  return value === 'critical' || value === 'default' || value === 'bulk' ? value : undefined;
}

function readLoggingMessageSourceType(
  value: string | undefined
): LoggingMessageJobSourceType | undefined {
  return value === 'dlq_item' || value === 'delivery_event' || value === 'payload_object'
    ? value
    : undefined;
}

function readLoggingMessageRepairSeverity(
  value: string | undefined
): LoggingMessageJobRepairFindingRecord['severity'] | undefined {
  return value === 'info' || value === 'warning' || value === 'error' || value === 'critical'
    ? value
    : undefined;
}

function readLoggingMessageRepairStatus(
  value: string | undefined
): LoggingMessageJobRepairFindingRecord['status'] | undefined {
  return value === 'open' ||
    value === 'safe_repaired' ||
    value === 'dangerous_previewed' ||
    value === 'dangerous_applied' ||
    value === 'ignored'
    ? value
    : undefined;
}

function readLoggingMessageRepairFindingType(
  value: string | undefined
): LoggingMessageJobRepairFindingRecord['findingType'] | undefined {
  return value === 'stuck_claim' ||
    value === 'expired_queued' ||
    value === 'expired_retrying' ||
    value === 'missing_payload_object' ||
    value === 'missing_export_part' ||
    value === 'orphan_staging_object' ||
    value === 'event_job_mismatch' ||
    value === 'blocked_configuration'
    ? value
    : undefined;
}

function serializeLoggingMessageJob(job: LoggingMessageJobRecord): Record<string, unknown> {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    lane: job.lane,
    criticality: job.criticality,
    priority: job.priority,
    tenant_key: job.tenantKey,
    topology_type: job.topologyType,
    scope_type: job.scopeType,
    scope_id: job.scopeId,
    scope_key: job.scopeKey,
    source_type: job.sourceType,
    source_id: job.sourceId,
    root_job_id: job.rootJobId,
    parent_job_id: job.parentJobId,
    depth: job.depth,
    payload_object_ref: job.payloadObjectRef,
    payload_sha256: job.payloadSha256,
    payload_type: job.payloadType,
    payload_schema_version: job.payloadSchemaVersion,
    redacted_summary: job.redactedSummary,
    validation_summary: job.validationSummary,
    idempotency_key: job.idempotencyKey,
    dedupe_until: job.dedupeUntil,
    not_before: job.notBefore,
    attempt_count: job.attemptCount,
    max_attempts: job.maxAttempts,
    attempt_policy: job.attemptPolicy,
    has_claim_token: job.claimToken !== null,
    claimed_at: job.claimedAt,
    claimed_until: job.claimedUntil,
    requested_by: job.requestedBy,
    reason: job.reason,
    error_class: job.errorClass,
    last_error: job.lastError,
    blocked_reason: job.blockedReason,
    cancel_requested_at: job.cancelRequestedAt,
    cancelled_by: job.cancelledBy,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    started_at: job.startedAt,
    completed_at: job.completedAt,
    expires_at: job.expiresAt,
  };
}

function serializeLoggingMessageRepairFinding(
  finding: LoggingMessageJobRepairFindingRecord
): Record<string, unknown> {
  return {
    id: finding.id,
    message_job_id: finding.messageJobId,
    finding_type: finding.findingType,
    severity: finding.severity,
    status: finding.status,
    safe_action: finding.safeAction,
    dangerous_action: finding.dangerousAction,
    impact: finding.impact,
    detected_at: finding.detectedAt,
    updated_at: finding.updatedAt,
    resolved_at: finding.resolvedAt,
    applied_at: finding.appliedAt,
    applied_by: finding.appliedBy,
    tenant_key: finding.tenantKey,
    job_kind: finding.jobKind,
    job_status: finding.jobStatus,
  };
}

function buildMessageRepairConfirmation(findingId: string): string {
  return `APPLY MESSAGE REPAIR ${findingId}`;
}

async function getLoggingExportJobForRepair(
  adapter: ReturnType<typeof getAdminAdapter>,
  exportJobId: string
): Promise<LoggingExportJobRow | null> {
  return adapter.queryOne<LoggingExportJobRow>(
    `SELECT id, tenant_key, log_type, plane, format, status, artifact_object_ref,
            manifest_object_ref, checksum_sha256, record_count, byte_count,
            requested_by, error_class, filter_json, created_at, updated_at,
            completed_at, expires_at
     FROM logging_export_jobs
     WHERE id = ?`,
    [exportJobId]
  );
}

function readExportJobIdFromRepairFinding(
  finding: LoggingMessageJobRepairFindingRecord
): string | null {
  const exportJobId = finding.impact?.export_job_id;
  return typeof exportJobId === 'string' && exportJobId ? exportJobId : null;
}

async function enqueueExportBuildRepairJob(input: {
  c: AdminContext;
  adapter: ReturnType<typeof getAdminAdapter>;
  exportJob: LoggingExportJobRow;
  finding: LoggingMessageJobRepairFindingRecord;
  now: number;
}): Promise<{
  jobId: string;
  queued: boolean;
  queueBinding: string | null;
  payloadObjectRef: string;
}> {
  const { c, adapter, exportJob, finding, now } = input;
  const filters = parseJsonObjectValue(exportJob.filter_json) ?? {};
  const tenantKey =
    typeof filters.tenant_key === 'string' ? filters.tenant_key : exportJob.tenant_key;
  const source = filters.source === 'record_index' ? 'record_index' : 'catalog';
  const includePayload = filters.include_payload === true;
  const lane: LoggingDeliveryLane =
    includePayload || source === 'record_index' ? 'bulk' : 'default';
  const criticality = exportJob.plane === 'sensitive_detail' ? 'critical' : 'standard';
  const messageJobId = createLoggingId('lmj', now);
  const messagePayload: ExportBuildMessagePayload = {
    payload_type: 'export_build',
    schema_version: 1,
    payload_id: createLoggingId('qpl', now),
    message_job_id: messageJobId,
    tenant_key: tenantKey,
    lane,
    created_at: now,
    export_job_id: exportJob.id,
    phase: 'plan',
    partition_strategy:
      exportJob.plane === 'sensitive_detail'
        ? 'chunk_index'
        : source === 'record_index'
          ? 'query_page'
          : 'time_bucket_shard',
    snapshot_cutoff_at: now,
    requested_by: getAuth(c).userId ?? 'unknown_admin',
  };
  const payloadBucket = getLoggingMessagePayloadBucket(c);
  if (!payloadBucket) {
    throw new Error('logging_message_payload_bucket_unavailable');
  }
  const payloadWrite = await writeLoggingMessagePayloadToR2({
    bucket: payloadBucket,
    jobId: messageJobId,
    payloadType: 'export_build',
    schemaVersion: 1,
    lane,
    criticality,
    sourceType: 'payload_object',
    tenantKey,
    payload: { ...messagePayload, filters },
    now,
  });
  const store = new SqlLoggingMessageJobStore(adapter);
  const job = await store.createJob({
    id: messageJobId,
    kind: 'export_build',
    lane,
    criticality,
    priority: criticality === 'critical' ? 100 : lane === 'bulk' ? 0 : 10,
    topology: {
      tenantKey,
      topologyType: tenantKey ? 'unknown' : 'platform',
      topologyResolvedAt: now,
    },
    scopeType: tenantKey ? 'tenant' : 'platform',
    scopeId: tenantKey,
    scopeKey: tenantKey ? `tenant:${tenantKey}` : 'platform',
    sourceType: 'payload_object',
    sourceId: exportJob.id,
    parentJobId: finding.messageJobId,
    depth: 1,
    payloadObjectRef: payloadWrite.objectRef,
    payloadSha256: payloadWrite.sha256,
    payloadType: 'export_build',
    payloadSchemaVersion: 1,
    redactedSummary: payloadWrite.redactedSummary,
    validationSummary: payloadWrite.validationSummary,
    idempotencyKey: ['repair', finding.id, exportJob.id, now].join(':'),
    dedupeUntil: now + 24 * 60 * 60 * 1000,
    notBefore: now,
    maxAttempts: 5,
    attemptPolicy: { maxAttempts: 5, leaseTimeoutMs: 10 * 60 * 1000 },
    requestedBy: getAuth(c).userId ?? 'unknown_admin',
    reason: `repair:${finding.id}:${finding.safeAction ?? 'safe_rebuild'}`,
    now,
    expiresAt: exportJob.expires_at ?? now + 7 * 24 * 60 * 60 * 1000,
  });
  await adapter.execute(
    `INSERT INTO logging_message_export_builds (
      id, message_job_id, export_job_id, phase, partition_strategy, partition_key,
      partition_index, partition_count, snapshot_cutoff_at,
      part_object_ref, part_checksum_sha256, part_record_count, part_byte_count,
      manifest_object_ref, final_checksum_sha256, final_record_count, final_byte_count,
      skipped_count, pending_count, late_arriving_count, cleanup_status,
      metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      createLoggingId('lexp', now),
      job.id,
      exportJob.id,
      'plan',
      messagePayload.partition_strategy ?? null,
      null,
      0,
      1,
      messagePayload.snapshot_cutoff_at,
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
      JSON.stringify({ filters, repair_finding_id: finding.id }),
      now,
      now,
    ]
  );
  await adapter.execute(
    `UPDATE logging_export_jobs
     SET status = ?, error_class = NULL, updated_at = ?, completed_at = NULL
     WHERE id = ?`,
    ['queued', now, exportJob.id]
  );
  const enqueueResult = await enqueueLoggingMessagePayload(
    messagePayload,
    c.env as unknown as Record<string, unknown>
  );
  return {
    jobId: job.id,
    queued: enqueueResult.queued,
    queueBinding: enqueueResult.bindingName,
    payloadObjectRef: payloadWrite.objectRef,
  };
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function safeDownloadFilenameBase(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 160) || 'export';
}

async function hashFilter(value: Record<string, unknown>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(value)));
  return `sha256:${toHex(digest)}`;
}

function getLoggingCursorSecret(c: AdminContext): string | undefined {
  return c.env.LOGGING_CURSOR_HMAC_SECRET;
}

function getCursorSort(payload: LoggingCursorPayload): { createdAt: number; id: string } | null {
  const createdAt = Number(payload.sort.created_at);
  const id = typeof payload.sort.id === 'string' ? payload.sort.id : null;
  if (!Number.isFinite(createdAt) || !id) {
    return null;
  }
  return { createdAt, id };
}

async function parseJsonObject(c: AdminContext): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

interface DlqItemRow {
  id: string;
  tenant_key: string;
  payload_type: string;
  schema_version: number;
  lane: string;
  destination_id: string | null;
  payload_object_ref: string;
  error_class: string;
  attempt_count: number;
  status: string;
  created_at: number;
  updated_at: number;
}

interface LoggingDeliveryEventRow {
  id: string;
  tenant_key: string;
  destination_id: string | null;
  log_type: LogType;
  plane: LogPlane;
  lane: string;
  status: string;
  attempt_count: number;
  error_class: string | null;
  object_catalog_id: string | null;
  created_at: number;
  updated_at: number;
  next_retry_at: number | null;
  metadata: string | null;
}

interface RetryDeliveryRequestBody {
  source_type: 'dlq_item' | 'delivery_event' | 'payload_object';
  source_id: string;
  payload_object_ref?: string;
  reason?: string;
  idempotency_key?: string;
  not_before?: number;
  dedupe_until?: number;
  max_attempts?: number;
  lease_timeout_ms?: number;
}

interface AdminDestinationRow {
  id: string;
  scope_type: DestinationScopeType;
  scope_id: string;
  destination_kind: DestinationKind;
  provider: DestinationProvider;
  name: string;
  display_name: string;
  description: string | null;
  lifecycle_status: string;
  health_status: DestinationHealthStatus;
  rotation_status: string;
  provider_config: string;
  credential_ref: string | null;
  credential_version: number;
  next_credential_ref: string | null;
  next_credential_version: number | null;
  previous_credential_ref: string | null;
  previous_credential_retire_after: number | null;
  allowed_tenant_ids: string | null;
  allowed_log_types: string | null;
  allowed_planes: string | null;
  region: string | null;
  critical_allowed: number;
  default_fallback_eligible: number;
  retention_days: number | null;
  encryption_mode: DestinationEncryptionMode;
  last_health_check_at: number | null;
  version: number;
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

interface LoggingDestinationOverrideRow {
  id: string;
  tenant_id: string | null;
  log_type: LogType;
  plane: LogPlane;
  destination_id: string;
  fallback_policy_id: string | null;
  enabled: number;
  managed_by: 'platform' | 'tenant';
  change_protection: 'confirm' | 'approval_required' | 'config_only';
  approval_policy_id: string | null;
  policy_hash: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
  version: number;
}

interface LoggingFallbackPolicyRow {
  id: string;
  scope_type: 'platform' | 'tenant';
  scope_id: string;
  log_type: LogType;
  plane: LogPlane;
  fallback_destination_id: string | null;
  failure_mode: string;
  created_at: number;
  updated_at: number;
  version: number;
}

interface LoggingExportJobRow {
  id: string;
  tenant_key: string | null;
  log_type: string | null;
  plane: string | null;
  format: 'jsonl' | 'csv' | 'zip';
  status: string;
  artifact_object_ref: string | null;
  manifest_object_ref: string | null;
  checksum_sha256: string | null;
  record_count: number;
  byte_count: number;
  requested_by: string | null;
  error_class: string | null;
  filter_json: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  expires_at: number | null;
}

interface LogObjectCatalogRow {
  id: string;
  tenant_key: string;
  log_type: LogType;
  plane: LogPlane;
  object_key: string;
  object_kind: string;
  status: string;
  record_count: number | string;
  byte_count: number | string;
}

interface LogChunkManifestRow {
  id: string;
  tenant_key: string;
  log_type: LogType;
  plane: LogPlane;
  manifest_object_key: string;
  record_count: number | string;
  status: string;
}

interface LoggingCatalogRepairJobRow extends Record<string, unknown> {
  id: string;
  job_kind: string;
  status: string;
  tenant_key: string | null;
  log_type: string | null;
  plane: string | null;
  requested_action: string | null;
  progress_current: number | string;
  progress_total: number | string | null;
  preview_artifact_ref: string | null;
  result_json: string | null;
  error_class: string | null;
  last_error: string | null;
  requested_by: string | null;
  created_at: number | string;
  updated_at: number | string;
  started_at: number | string | null;
  completed_at: number | string | null;
  cancel_requested_at: number | string | null;
  cancel_requested_by: string | null;
  metadata_json: string | null;
}

const DLQ_REDACTED_VALUE = '[redacted]';
const DLQ_NON_JSON_PREVIEW = '[non-json payload redacted]';
const DLQ_REDACTION_MAX_DEPTH = 8;
const DLQ_REDACTION_MAX_ARRAY_ITEMS = 50;
const DLQ_REDACTION_MAX_OBJECT_KEYS = 100;
const DLQ_REDACTION_MAX_STRING_LENGTH = 4096;
const RETRY_PAYLOAD_OBJECT_MAX_BYTES = 1024 * 1024;
const DLQ_PAYLOAD_INLINE_READ_MAX_BYTES = 1024 * 1024;
const LOGGING_EXPORT_ARTIFACT_INLINE_DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;
const LOGGING_EXPORT_MANIFEST_INLINE_READ_MAX_BYTES = 1024 * 1024;
const LOGGING_EXPORT_INLINE_PART_MAX_COUNT = 1000;
const DLQ_SENSITIVE_KEY_PATTERN =
  /(?:authorization|cookie|token|secret|password|passphrase|credential|private[_-]?key|api[_-]?key|client[_-]?secret|signature|hmac|assertion|saml[_-]?response|id[_-]?token|access[_-]?token|refresh[_-]?token)/i;

async function requireTenantIdAccess(
  c: AdminContext,
  tenantId: string | null | undefined
): Promise<Response | null> {
  if (hasPlatformAuthority(getAuth(c))) {
    return null;
  }
  if (tenantId !== getTenantIdFromContext(c)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  return null;
}

function getDlqPayloadBucket(c: AdminContext): R2Bucket | null {
  return c.env.AUDIT_ARCHIVE ?? null;
}

function getLoggingExportBucket(c: AdminContext): R2Bucket | null {
  return c.env.EXPORT_ARTIFACTS ?? null;
}

async function writeCatalogRepairJobPreviewArtifact(
  c: AdminContext,
  input: { jobId: string; payload: Record<string, unknown>; now: number }
): Promise<string | null> {
  const bucket = getLoggingExportBucket(c);
  if (!bucket) {
    return null;
  }
  const key = `catalog-repair-jobs/v1/${input.jobId}/preview.json`;
  await bucket.put(key, JSON.stringify(input.payload), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: {
      jobId: input.jobId,
      createdAt: String(input.now),
      artifactKind: 'catalog_repair_preview',
    },
  });
  return `r2://${key}`;
}

function isLoggingExportObjectRefAllowed(item: LoggingExportJobRow, objectRef: string): boolean {
  return objectRef.startsWith(`logging-exports/v1/${item.id}/`);
}

function requiresSensitiveDetailExportRead(item: Pick<LoggingExportJobRow, 'plane'>): boolean {
  return item.plane === 'sensitive_detail';
}

async function requireSensitiveDetailExportReadPermission(
  c: AdminContext,
  item: Pick<LoggingExportJobRow, 'plane'>
): Promise<Response | null> {
  if (
    requiresSensitiveDetailExportRead(item) &&
    !hasPermission(getAuth(c), LOGGING_SENSITIVE_DETAIL_EXPORT_PERMISSION)
  ) {
    return createAdminPermissionErrorResponse(c, {
      required_permission: LOGGING_SENSITIVE_DETAIL_EXPORT_PERMISSION,
      reason: 'sensitive_detail_export_permission_required',
    });
  }
  return null;
}

function getLoggingMessagePayloadBucket(c: AdminContext): R2Bucket | null {
  return c.env.AUDIT_ARCHIVE ?? null;
}

function getCatalogObjectBucket(c: AdminContext, row: LogObjectCatalogRow): R2Bucket | null {
  if (row.object_kind === 'dlq_payload') {
    return getDlqPayloadBucket(c);
  }
  if (row.object_kind === 'export_artifact') {
    return getLoggingExportBucket(c);
  }
  if (row.plane === 'sensitive_detail') {
    return c.env.SENSITIVE_DETAILS ?? null;
  }
  if (row.plane === 'diagnostic_detail' || row.log_type === 'diagnostic') {
    return c.env.DIAGNOSTIC_LOGS ?? null;
  }
  return c.env.AUDIT_ARCHIVE ?? null;
}

async function readR2TextWithLimit(
  object: R2ObjectBody,
  maxBytes: number
): Promise<{ ok: true; text: string; bytes: number } | { ok: false; error: 'object_too_large' }> {
  try {
    const text = await readR2ObjectTextWithLimit(object, maxBytes);
    const bytes = new TextEncoder().encode(text).byteLength;
    return { ok: true, text, bytes };
  } catch {
    return { ok: false, error: 'object_too_large' };
  }
}

async function readR2BytesWithLimit(
  object: R2ObjectBody,
  maxBytes: number
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: 'object_too_large' }> {
  if (typeof object.size === 'number' && object.size > maxBytes) {
    return { ok: false, error: 'object_too_large' };
  }
  if (object.body) {
    const reader = object.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (!value) {
          continue;
        }
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => undefined);
          return { ok: false, error: 'object_too_large' };
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
    return { ok: true, bytes };
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    return { ok: false, error: 'object_too_large' };
  }
  return { ok: true, bytes };
}

function loggingExportContentType(format: LoggingExportJobRow['format']): string {
  return format === 'csv'
    ? 'text/csv'
    : format === 'zip'
      ? 'application/zip'
      : 'application/x-ndjson';
}

function loggingExportFileExtension(format: LoggingExportJobRow['format']): string {
  return format === 'csv' ? 'csv' : format === 'zip' ? 'zip' : 'jsonl';
}

interface LoggingKeyRegistryVersionRow extends Record<string, unknown> {
  id: string;
  tenant_key: string;
  surface: string | null;
  log_type: LogType;
  plane: LogPlane;
  active_version: number | string;
  registry_status: string;
  last_rotated_at: number | string | null;
  registry_created_at: number | string;
  registry_updated_at: number | string;
  version: number | string | null;
  backend_ref: string | null;
  version_status: string | null;
  usage_count: number | string | null;
  stale_count: number | string | null;
  version_created_at: number | string | null;
  retired_at: number | string | null;
}

interface LoggingRewrapJobViewRow extends Record<string, unknown> {
  id: string;
  key_registry_id: string;
  from_version: number | string;
  to_version: number | string;
  priority: number | string;
  status: string;
  created_at: number | string;
  started_at: number | string | null;
  completed_at: number | string | null;
  metadata: string | null;
}

function serializeLoggingRewrapJob(row: LoggingRewrapJobViewRow): Record<string, unknown> {
  const metadata = parseJsonMetadata(row.metadata);
  return {
    id: row.id,
    key_registry_id: row.key_registry_id,
    from_version: toInteger(row.from_version),
    to_version: toInteger(row.to_version),
    priority: toInteger(row.priority),
    status: row.status,
    created_at: toInteger(row.created_at),
    started_at: readNullableInteger(row.started_at),
    completed_at: readNullableInteger(row.completed_at),
    object_catalog_id:
      typeof metadata.object_catalog_id === 'string' ? metadata.object_catalog_id : null,
    object_key: typeof metadata.object_key === 'string' ? metadata.object_key : null,
    tenant_key: typeof metadata.tenant_key === 'string' ? metadata.tenant_key : null,
    log_type: typeof metadata.log_type === 'string' ? metadata.log_type : null,
    plane: typeof metadata.plane === 'string' ? metadata.plane : null,
    reason: typeof metadata.reason === 'string' ? metadata.reason : null,
    error: typeof metadata.error === 'string' ? metadata.error : null,
    metadata,
  };
}

interface SensitiveDetailChunkProbeRow extends Record<string, unknown> {
  catalog_id: string;
  tenant_id: string;
  object_class: string;
  bucket_binding: string;
  object_key: string;
  content_encoding: string;
  line_number: number | string;
  byte_offset: number | string | null;
  byte_length: number | string | null;
  key_version: number | string;
  checksum_sha256: string | null;
  created_at: number | string;
  deleted_at: number | string | null;
  public_artifact_id: string | null;
}

interface LoggingRewrapCandidateRow extends Record<string, unknown> {
  key_registry_id: string;
  tenant_key: string;
  surface: string | null;
  log_type: LogType;
  plane: LogPlane;
  active_version: number | string;
  from_version: number | string;
  key_version_status: string;
  object_catalog_id: string;
  object_key: string;
  record_count: number | string;
  byte_count: number | string;
  committed_at: number | string | null;
}

function readNullableInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJsonMetadata(value: string | null): Record<string, unknown> {
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

function serializeLoggingCatalogRepairJob(
  row: LoggingCatalogRepairJobRow
): Record<string, unknown> {
  return {
    id: row.id,
    job_kind: row.job_kind,
    status: row.status,
    tenant_key: row.tenant_key,
    log_type: row.log_type,
    plane: row.plane,
    requested_action: row.requested_action,
    progress_current: toInteger(row.progress_current),
    progress_total: readNullableInteger(row.progress_total),
    preview_artifact_ref: row.preview_artifact_ref,
    result: parseJsonMetadata(row.result_json),
    error_class: row.error_class,
    last_error: row.last_error,
    requested_by: row.requested_by,
    created_at: toInteger(row.created_at),
    updated_at: toInteger(row.updated_at),
    started_at: readNullableInteger(row.started_at),
    completed_at: readNullableInteger(row.completed_at),
    cancel_requested_at: readNullableInteger(row.cancel_requested_at),
    cancel_requested_by: row.cancel_requested_by,
    metadata: parseJsonMetadata(row.metadata_json),
  };
}

async function getDlqItem(adapter: ReturnType<typeof getAdminAdapter>, id: string) {
  return adapter.queryOne<DlqItemRow>(
    `SELECT id, tenant_key, payload_type, schema_version, lane, destination_id,
            payload_object_ref, error_class, attempt_count, status, created_at, updated_at
     FROM logging_dlq_items
     WHERE id = ?`,
    [id]
  );
}

async function getDeliveryEvent(adapter: ReturnType<typeof getAdminAdapter>, id: string) {
  return adapter.queryOne<LoggingDeliveryEventRow>(
    `SELECT id, tenant_key, destination_id, log_type, plane, lane, status, attempt_count,
            error_class, object_catalog_id, created_at, updated_at, next_retry_at, metadata
     FROM logging_delivery_events
     WHERE id = ?`,
    [id]
  );
}

async function getCatalogObject(adapter: ReturnType<typeof getAdminAdapter>, id: string) {
  return adapter.queryOne<LogObjectCatalogRow>(
    `SELECT id, tenant_key, log_type, plane, object_key, object_kind, status,
            record_count, byte_count
     FROM log_object_catalog
     WHERE id = ?`,
    [id]
  );
}

function getSensitiveDetailProbeAdapters(c: AdminContext): Array<{
  binding: 'DB_ADMIN' | 'LOGGING_INDEX_DB' | 'DB';
  adapter: DatabaseAdapter;
}> {
  const adapters: Array<{
    binding: 'DB_ADMIN' | 'LOGGING_INDEX_DB' | 'DB';
    adapter: DatabaseAdapter;
  }> = [];
  if (c.env.LOGGING_INDEX_DB) {
    adapters.push({
      binding: 'LOGGING_INDEX_DB',
      adapter: ensureDatabaseAdapter(c.env.LOGGING_INDEX_DB, 'sensitive-detail-probe'),
    });
  }
  if (c.env.DB_ADMIN) {
    adapters.push({ binding: 'DB_ADMIN', adapter: getAdminAdapter(c) });
  }
  adapters.push({
    binding: 'DB',
    adapter: ensureDatabaseAdapter(c.env.DB, 'sensitive-detail-probe'),
  });
  return adapters;
}

async function getSensitiveDetailChunkProbeRow(
  adapter: DatabaseAdapter,
  input: { catalogId: string; tenantId?: string | null; objectClass?: string | null }
) {
  const conditions = ['sdci.catalog_id = ?', 'sdci.deleted_at IS NULL'];
  const params: unknown[] = [input.catalogId];
  if (input.tenantId) {
    conditions.push('sdci.tenant_id = ?');
    params.push(input.tenantId);
  }
  if (input.objectClass) {
    conditions.push('sdci.object_class = ?');
    params.push(input.objectClass);
  }
  return adapter.queryOne<SensitiveDetailChunkProbeRow>(
    `SELECT sdci.catalog_id, sdci.tenant_id, sdci.object_class, sdci.bucket_binding,
            sdci.object_key, sdci.content_encoding, sdci.line_number,
            sdci.byte_offset, sdci.byte_length, sdci.key_version, sdci.checksum_sha256,
            sdci.created_at, sdci.deleted_at, oc.public_artifact_id
     FROM sensitive_detail_chunk_index sdci
     LEFT JOIN object_catalog oc
       ON oc.id = sdci.catalog_id
      AND oc.tenant_id = sdci.tenant_id
      AND oc.object_class = sdci.object_class
      AND oc.deleted_at IS NULL
     WHERE ${conditions.join(' AND ')}
     LIMIT 1`,
    params
  );
}

async function findSensitiveDetailChunkProbeRow(
  c: AdminContext,
  input: { catalogId: string; tenantId?: string | null; objectClass?: string | null }
): Promise<{
  binding: 'DB_ADMIN' | 'LOGGING_INDEX_DB' | 'DB';
  adapter: DatabaseAdapter;
  row: SensitiveDetailChunkProbeRow;
} | null> {
  for (const source of getSensitiveDetailProbeAdapters(c)) {
    try {
      const row = await getSensitiveDetailChunkProbeRow(source.adapter, input);
      if (row) {
        return { ...source, row };
      }
    } catch {
      continue;
    }
  }
  return null;
}

function requireOpenDlqItem(c: AdminContext, item: DlqItemRow | null) {
  if (!item) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
  if (item.status !== 'open') {
    return createAdminFieldErrorResponse(c, [
      fieldError('status', 'invalid_state', 'Only open DLQ items can be modified.'),
    ]);
  }
  return null;
}

async function listOpenDlqItemsForBulkReplay(
  c: AdminContext,
  input: {
    tenantKey: string | null;
    lane?: LoggingDeliveryLane;
    destinationId?: string | null;
    payloadType?: string | null;
    limit: number;
  }
): Promise<DlqItemRow[]> {
  const conditions = ['status = ?'];
  const params: unknown[] = ['open'];
  if (input.tenantKey) {
    conditions.push('tenant_key = ?');
    params.push(input.tenantKey);
  }
  if (input.lane) {
    conditions.push('lane = ?');
    params.push(input.lane);
  }
  if (input.destinationId) {
    conditions.push('destination_id = ?');
    params.push(input.destinationId);
  }
  if (input.payloadType) {
    conditions.push('payload_type = ?');
    params.push(input.payloadType);
  }
  return getAdminAdapter(c).query<DlqItemRow>(
    `SELECT id, tenant_key, payload_type, schema_version, lane, destination_id,
            payload_object_ref, error_class, attempt_count, status, created_at, updated_at
     FROM logging_dlq_items
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at ASC, id ASC
     LIMIT ?`,
    [...params, input.limit]
  );
}

function normalizeLoggingDeliveryLane(value: string | null | undefined): LoggingDeliveryLane {
  return value === 'critical' || value === 'default' || value === 'bulk' ? value : 'default';
}

function truncateDlqString(value: string): string {
  if (value.length <= DLQ_REDACTION_MAX_STRING_LENGTH) {
    return value;
  }
  return `${value.slice(0, DLQ_REDACTION_MAX_STRING_LENGTH)}...[truncated]`;
}

function redactDlqPayloadValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return truncateDlqString(value);
  }
  if (typeof value !== 'object') {
    return value;
  }
  if (depth >= DLQ_REDACTION_MAX_DEPTH) {
    return '[max-depth-redacted]';
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, DLQ_REDACTION_MAX_ARRAY_ITEMS)
      .map((item) => redactDlqPayloadValue(item, depth + 1));
    if (value.length > DLQ_REDACTION_MAX_ARRAY_ITEMS) {
      items.push(`[${value.length - DLQ_REDACTION_MAX_ARRAY_ITEMS} items truncated]`);
    }
    return items;
  }

  const redacted: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, entryValue] of entries.slice(0, DLQ_REDACTION_MAX_OBJECT_KEYS)) {
    redacted[key] = DLQ_SENSITIVE_KEY_PATTERN.test(key)
      ? DLQ_REDACTED_VALUE
      : redactDlqPayloadValue(entryValue, depth + 1);
  }
  if (entries.length > DLQ_REDACTION_MAX_OBJECT_KEYS) {
    redacted.__truncated_keys = entries.length - DLQ_REDACTION_MAX_OBJECT_KEYS;
  }
  return redacted;
}

function parseJsonForDlqPayload(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function inspectDlqPayloadJson(value: unknown) {
  const inspection: Record<string, unknown> = {
    json_parse: { ok: true },
    redaction: {
      applied: true,
      redacted_value: DLQ_REDACTED_VALUE,
      max_depth: DLQ_REDACTION_MAX_DEPTH,
      max_array_items: DLQ_REDACTION_MAX_ARRAY_ITEMS,
      max_object_keys: DLQ_REDACTION_MAX_OBJECT_KEYS,
      max_string_length: DLQ_REDACTION_MAX_STRING_LENGTH,
    },
    redacted_json: redactDlqPayloadValue(value),
  };

  const candidates: Array<{ source: string; value: unknown }> = [{ source: 'root', value }];
  if (isRecord(value) && 'body' in value) {
    candidates.unshift({ source: 'body', value: value.body });
  }
  if (isRecord(value) && typeof value.bodyJson === 'string') {
    const bodyJson = parseJsonForDlqPayload(value.bodyJson);
    inspection.body_json_parse = { ok: bodyJson.ok };
    if (bodyJson.ok) {
      inspection.redacted_body_json = redactDlqPayloadValue(bodyJson.value);
      candidates.unshift({ source: 'bodyJson', value: bodyJson.value });
    }
  }

  const parsedQueuePayloads = candidates.map((candidate) => {
    const parsed = parseLoggingDeliveryQueuePayload(candidate.value);
    if (parsed.ok) {
      return {
        source: candidate.source,
        ok: true,
        payload_type: parsed.payload.payload_type,
        schema_version: parsed.payload.schema_version,
        payload_id: parsed.payload.payload_id,
        tenant_key: parsed.payload.tenant_key,
        lane: parsed.payload.lane,
      };
    }
    return {
      source: candidate.source,
      ok: false,
      reason: parsed.reason,
      payload_type: parsed.payloadType ?? null,
      schema_version: parsed.schemaVersion ?? null,
      payload_id: parsed.payloadId ?? null,
      tenant_key: parsed.tenantKey ?? null,
      lane: parsed.lane ?? null,
    };
  });
  inspection.queue_payload_parse = parsedQueuePayloads;

  return inspection;
}

function extractDeliveryQueuePayload(value: unknown) {
  const candidates: unknown[] = [value];
  if (isRecord(value)) {
    candidates.unshift(value.body);
    if (typeof value.bodyJson === 'string') {
      const parsedBody = parseJsonForDlqPayload(value.bodyJson);
      if (parsedBody.ok) {
        candidates.unshift(parsedBody.value);
      }
    }
  }

  for (const candidate of candidates) {
    const parsed = parseLoggingDeliveryQueuePayload(candidate);
    if (parsed.ok) {
      return parsed.payload;
    }
  }
  return null;
}

function parseRetryDeliveryRequestBody(
  value: Record<string, unknown>
): RetryDeliveryRequestBody | null {
  const sourceType = value.source_type;
  const sourceId = parseOptionalString(value.source_id);
  const maxAttempts = parseOptionalPositiveInteger(value.max_attempts);
  const leaseTimeoutMs = parseOptionalPositiveInteger(value.lease_timeout_ms);
  if (
    (sourceType !== 'dlq_item' &&
      sourceType !== 'delivery_event' &&
      sourceType !== 'payload_object') ||
    !sourceId
  ) {
    return null;
  }
  return {
    source_type: sourceType,
    source_id: sourceId,
    payload_object_ref: parseOptionalString(value.payload_object_ref) ?? undefined,
    reason: parseOptionalString(value.reason) ?? undefined,
    idempotency_key: parseOptionalString(value.idempotency_key) ?? undefined,
    not_before: typeof value.not_before === 'number' ? value.not_before : undefined,
    dedupe_until: typeof value.dedupe_until === 'number' ? value.dedupe_until : undefined,
    max_attempts:
      typeof maxAttempts === 'number' && Number.isFinite(maxAttempts) ? maxAttempts : undefined,
    lease_timeout_ms:
      typeof leaseTimeoutMs === 'number' && Number.isFinite(leaseTimeoutMs)
        ? leaseTimeoutMs
        : undefined,
  };
}

function isCriticalRetryPayload(input: {
  lane: LoggingDeliveryLane;
  logType?: string | null;
}): boolean {
  return (
    input.lane === 'critical' || input.logType === 'admin_audit' || input.logType === 'security'
  );
}

function buildRetryIdempotencyKey(input: {
  sourceType: string;
  sourceId: string;
  payloadHash?: string | null;
}): string {
  return ['retry_delivery', input.sourceType, input.sourceId, input.payloadHash ?? 'pending'].join(
    ':'
  );
}

async function readJsonPayloadObject(c: AdminContext, objectRef: string) {
  const bucket = getLoggingMessagePayloadBucket(c);
  if (!bucket) {
    return { ok: false as const, error: 'payload_bucket_unavailable' };
  }
  const object = await bucket.get(objectRef);
  if (!object) {
    return { ok: false as const, error: 'payload_object_not_found' };
  }
  const objectRead = await readR2TextWithLimit(object, RETRY_PAYLOAD_OBJECT_MAX_BYTES);
  if (!objectRead.ok) {
    return { ok: false as const, error: 'payload_object_too_large' };
  }
  const parsed = parseJsonForDlqPayload(objectRead.text);
  return parsed.ok
    ? { ok: true as const, value: parsed.value }
    : { ok: false as const, error: 'payload_object_malformed_json' };
}

async function resolveRetryDeliverySource(
  c: AdminContext,
  request: RetryDeliveryRequestBody,
  now: number
): Promise<
  | {
      ok: true;
      tenantKey: string;
      lane: LoggingDeliveryLane;
      logType: LogType | null;
      replayPayload: RetryDeliveryMessagePayload['replay_payload'];
      sourcePayloadObjectRef: string | null;
    }
  | { ok: false; response: Response }
> {
  const adapter = getAdminAdapter(c);
  if (request.source_type === 'dlq_item') {
    const item = await getDlqItem(adapter, request.source_id);
    const stateResponse = requireOpenDlqItem(c, item);
    if (stateResponse) {
      return { ok: false, response: await stateResponse };
    }
    if (!item) {
      return {
        ok: false,
        response: await createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND),
      };
    }
    const accessError = await requireTenantKeyAccess(c, item.tenant_key);
    if (accessError) {
      return { ok: false, response: accessError };
    }
    const dlqBucket = getDlqPayloadBucket(c);
    const dlqObject = dlqBucket ? await dlqBucket.get(item.payload_object_ref) : null;
    if (!dlqBucket || !dlqObject) {
      return {
        ok: false,
        response: await createAdminFieldErrorResponse(c, [
          fieldError(
            'payload_object_ref',
            'payload_object_not_found',
            'Retry payload object cannot be read.'
          ),
        ]),
      };
    }
    const dlqObjectRead = await readR2TextWithLimit(dlqObject, DLQ_PAYLOAD_INLINE_READ_MAX_BYTES);
    if (!dlqObjectRead.ok) {
      return {
        ok: false,
        response: await createAdminFieldErrorResponse(c, [
          fieldError(
            'payload_object_ref',
            'payload_object_too_large',
            'Retry payload object is too large to read inline.'
          ),
        ]),
      };
    }
    const payloadRead = parseJsonForDlqPayload(dlqObjectRead.text);
    if (!payloadRead.ok) {
      return {
        ok: false,
        response: await createAdminFieldErrorResponse(c, [
          fieldError(
            'payload_object_ref',
            'payload_object_malformed_json',
            'Retry payload object must be JSON.'
          ),
        ]),
      };
    }
    const replayPayload = extractDeliveryQueuePayload(payloadRead.value);
    if (!replayPayload) {
      return {
        ok: false,
        response: await createAdminFieldErrorResponse(c, [
          fieldError(
            'payload_object_ref',
            'unsupported_retry_payload',
            'Retry source payload must contain a supported logging delivery queue payload.'
          ),
        ]),
      };
    }
    return {
      ok: true,
      tenantKey: item.tenant_key,
      lane: normalizeLoggingDeliveryLane(replayPayload.lane || item.lane),
      logType: 'log_type' in replayPayload ? replayPayload.log_type : null,
      replayPayload,
      sourcePayloadObjectRef: item.payload_object_ref,
    };
  }

  if (request.source_type === 'delivery_event') {
    const event = await getDeliveryEvent(adapter, request.source_id);
    if (!event) {
      return {
        ok: false,
        response: await createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND),
      };
    }
    const accessError = await requireTenantKeyAccess(c, event.tenant_key);
    if (accessError) {
      return { ok: false, response: accessError };
    }
    if (!event.destination_id || !event.object_catalog_id) {
      return {
        ok: false,
        response: await createAdminFieldErrorResponse(c, [
          fieldError(
            'source_id',
            'delivery_event_not_replayable',
            'Delivery event must reference a destination and catalog object to be retried.'
          ),
        ]),
      };
    }
    const catalog = await getCatalogObject(adapter, event.object_catalog_id);
    if (!catalog || catalog.status !== 'committed') {
      return {
        ok: false,
        response: await createAdminFieldErrorResponse(c, [
          fieldError(
            'source_id',
            'catalog_object_not_replayable',
            'Delivery event catalog object must exist and be committed.'
          ),
        ]),
      };
    }
    const lane = normalizeLoggingDeliveryLane(event.lane);
    return {
      ok: true,
      tenantKey: event.tenant_key,
      lane,
      logType: event.log_type,
      replayPayload: {
        payload_type: 'delivery_fanout',
        schema_version: 1,
        payload_id: createLoggingId('qpl', now),
        tenant_key: event.tenant_key,
        lane,
        created_at: now,
        catalog_id: catalog.id,
        object_key: catalog.object_key,
        destination_id: event.destination_id,
        log_type: event.log_type,
        plane: event.plane,
        record_count: Number(catalog.record_count),
      },
      sourcePayloadObjectRef: catalog.object_key,
    };
  }

  if (!hasPlatformAuthority(getAuth(c))) {
    return {
      ok: false,
      response: await createAdminPermissionErrorResponse(c, {
        required_scope: 'platform',
        reason: 'payload_object_retry_requires_platform_admin',
      }),
    };
  }

  const objectRef = request.payload_object_ref ?? request.source_id;
  const payloadRead = await readJsonPayloadObject(c, objectRef);
  if (!payloadRead.ok) {
    return {
      ok: false,
      response: await createAdminFieldErrorResponse(c, [
        fieldError('payload_object_ref', payloadRead.error, 'Retry payload object cannot be read.'),
      ]),
    };
  }
  const replayPayload = extractDeliveryQueuePayload(payloadRead.value);
  if (!replayPayload) {
    return {
      ok: false,
      response: await createAdminFieldErrorResponse(c, [
        fieldError(
          'payload_object_ref',
          'unsupported_retry_payload',
          'Retry source payload must contain a supported logging delivery queue payload.'
        ),
      ]),
    };
  }
  const accessError = await requireTenantKeyAccess(c, replayPayload.tenant_key);
  if (accessError) {
    return { ok: false, response: accessError };
  }
  return {
    ok: true,
    tenantKey: replayPayload.tenant_key,
    lane: replayPayload.lane,
    logType: 'log_type' in replayPayload ? replayPayload.log_type : null,
    replayPayload,
    sourcePayloadObjectRef: objectRef,
  };
}

async function readDlqPayloadPreview(c: AdminContext, item: DlqItemRow, previewBytes: number) {
  const bucket = getDlqPayloadBucket(c);
  if (!bucket) {
    return {
      ok: false as const,
      response: await createAdminFieldErrorResponse(c, [
        fieldError(
          'payload_object_ref',
          'bucket_unavailable',
          'DLQ payload bucket is unavailable.'
        ),
      ]),
    };
  }
  const object = await bucket.get(item.payload_object_ref);
  if (!object) {
    return {
      ok: false as const,
      response: await createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND),
    };
  }
  const objectRead = await readR2TextWithLimit(object, DLQ_PAYLOAD_INLINE_READ_MAX_BYTES);
  if (!objectRead.ok) {
    return {
      ok: false as const,
      response: await createAdminFieldErrorResponse(c, [
        fieldError(
          'payload_object_ref',
          'payload_object_too_large',
          'DLQ payload object is too large to preview inline.'
        ),
      ]),
    };
  }

  const rawEncoded = new TextEncoder().encode(objectRead.text);
  const parsedJson = parseJsonForDlqPayload(objectRead.text);
  const inspection = parsedJson.ok
    ? inspectDlqPayloadJson(parsedJson.value)
    : {
        json_parse: { ok: false },
        redaction: {
          applied: true,
          raw_preview_suppressed: true,
          reason: 'payload_is_not_json',
        },
      };
  const previewSource = parsedJson.ok
    ? JSON.stringify((inspection as { redacted_json?: unknown }).redacted_json)
    : DLQ_NON_JSON_PREVIEW;
  const previewEncoded = new TextEncoder().encode(previewSource);
  const truncated = previewEncoded.byteLength > previewBytes;
  const preview = truncated
    ? new TextDecoder().decode(previewEncoded.slice(0, previewBytes))
    : previewSource;
  const objectMetadata = object as R2ObjectBody & {
    httpMetadata?: { contentType?: string };
    size?: number;
  };

  return {
    ok: true as const,
    value: {
      content_type: objectMetadata.httpMetadata?.contentType ?? 'application/octet-stream',
      byte_count: objectMetadata.size ?? rawEncoded.byteLength,
      text_preview: preview,
      truncated,
      parsed: inspection,
    },
  };
}

async function recordDlqAdminAudit(
  c: AdminContext,
  item: DlqItemRow,
  action: 'delete' | 'purge',
  result: 'success' | 'failure',
  metadata: Record<string, unknown> = {}
): Promise<string | null> {
  return writeAdminAuditLog(c, {
    action: `logging.dlq.${action}`,
    resourceType: 'logging_dlq_item',
    resourceId: item.id,
    result,
    severity: result === 'failure' || action === 'purge' ? 'warn' : 'info',
    metadata: {
      dlq_item_id: item.id,
      tenant_key: item.tenant_key,
      payload_type: item.payload_type,
      lane: item.lane,
      previous_status: item.status,
      ...metadata,
    },
  });
}

function parseDestinationProviderConfig(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const DESTINATION_PROVIDERS = Object.keys(DESTINATION_PROVIDER_SCHEMAS) as DestinationProvider[];
const DESTINATION_SCOPE_TYPES: DestinationScopeType[] = ['platform', 'tenant', 'shared'];
const DESTINATION_ENCRYPTION_MODES: DestinationEncryptionMode[] = [
  'platform_managed',
  'external_managed',
  'none',
];
const LOGGING_FALLBACK_FAILURE_MODES = [
  'platform_default',
  'retry_then_platform_default',
  'retry_then_dlq',
  'drop_non_critical',
] as const satisfies readonly LoggingFallbackMode[];
const LOGGING_CHANGE_PROTECTIONS = ['confirm', 'approval_required', 'config_only'] as const;
const RUNTIME_SUPPORTED_DESTINATION_PROVIDERS: readonly DestinationProvider[] = ['r2', 'http'];
const FORBIDDEN_PROVIDER_CONFIG_FIELDS = [
  'secret',
  'token',
  'password',
  'privateKey',
  'private_key',
  'accessKey',
  'access_key',
  'accessKeyId',
  'secretAccessKey',
  'apiKey',
  'api_key',
];
const PROVIDER_CONFIG_SECRET_KEY_PATTERN =
  /(?:authorization|cookie|token|secret|password|passphrase|credential|private[_-]?key|api[_-]?key|client[_-]?secret|signature|hmac|assertion|access[_-]?key)/i;

function parseOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readObjectClass(value: unknown): ObjectClass | null {
  return typeof value === 'string' && (OBJECT_CLASSES as readonly string[]).includes(value)
    ? (value as ObjectClass)
    : null;
}

function getDestinationRuntimeSupport(provider: string): {
  runtime_supported: boolean;
  runtime_status: 'supported' | 'unsupported';
  runtime_unsupported_reason: string | null;
} {
  const supported = RUNTIME_SUPPORTED_DESTINATION_PROVIDERS.includes(
    provider as DestinationProvider
  );
  return {
    runtime_supported: supported,
    runtime_status: supported ? 'supported' : 'unsupported',
    runtime_unsupported_reason: supported ? null : 'provider_runtime_not_implemented',
  };
}

function withDestinationRuntimeSupport<T extends Record<string, unknown>>(item: T): T {
  const provider = typeof item.provider === 'string' ? item.provider : 'unknown';
  return {
    ...item,
    ...getDestinationRuntimeSupport(provider),
  };
}

function parseDestinationStringArray(value: unknown): string[] | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const items = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? [...new Set(items)] : null;
}

function parseOptionalBoolean(value: unknown, defaultValue: boolean): boolean {
  return typeof value === 'boolean' ? value : defaultValue;
}

function parseOptionalPositiveInteger(value: unknown): number | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : Number.NaN;
}

function parseProviderConfig(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function validateHttpSinkProviderUrl(
  provider: DestinationProvider,
  providerConfig: Record<string, unknown>
): ReturnType<typeof fieldError> | null {
  if (provider !== 'http') {
    return null;
  }

  const url = configString(providerConfig, ['url']);
  if (!url) {
    return null;
  }

  const validation = validateUrlForSSRF(url);
  if (!validation.valid || !url.startsWith('https://')) {
    return fieldError(
      'provider_config.url',
      'http_sink_url_invalid',
      'HTTP sink URL must be HTTPS and must not target localhost or private network addresses.'
    );
  }
  return null;
}

function parseJsonObjectValue(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function hasForbiddenProviderConfigField(
  config: Record<string, unknown>,
  path: string[] = []
): string | null {
  const lowerForbidden = new Set(
    FORBIDDEN_PROVIDER_CONFIG_FIELDS.map((field) => field.toLowerCase())
  );
  for (const [key, value] of Object.entries(config)) {
    const nextPath = [...path, key];
    if (lowerForbidden.has(key.toLowerCase()) || PROVIDER_CONFIG_SECRET_KEY_PATTERN.test(key)) {
      return nextPath.join('.');
    }
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        if (item && typeof item === 'object') {
          const nested = hasForbiddenProviderConfigField(item as Record<string, unknown>, [
            ...nextPath,
            String(index),
          ]);
          if (nested) {
            return nested;
          }
        }
      }
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = hasForbiddenProviderConfigField(value as Record<string, unknown>, nextPath);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

function redactProviderConfigPreviewValue(value: unknown, depth = 0): unknown {
  if (depth > 8) {
    return '[max-depth-redacted]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactProviderConfigPreviewValue(item, depth + 1));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = PROVIDER_CONFIG_SECRET_KEY_PATTERN.test(key)
      ? DLQ_REDACTED_VALUE
      : redactProviderConfigPreviewValue(entryValue, depth + 1);
  }
  return redacted;
}

function buildDestinationProviderPayloadPreview(input: {
  provider: DestinationProvider;
  providerConfig: Record<string, unknown>;
  capabilities?: unknown;
}): {
  provider: DestinationProvider;
  destination_kind: DestinationKind;
  provider_config: unknown;
  schema: {
    required_fields: string[];
    optional_fields: string[];
    default_capabilities: DestinationCapability[];
  };
  runtime: {
    supported: boolean;
    status: 'supported' | 'unsupported';
    unsupported_reason: string | null;
  };
  capabilities: DestinationCapability[];
  validation: {
    valid: boolean;
    errors: Array<{ path: string; code: string; message: string }>;
  };
  security: {
    inline_secret_detected: boolean;
    inline_secret_path: string | null;
    credential_ref_required: boolean;
  };
} {
  const schema = DESTINATION_PROVIDER_SCHEMAS[input.provider];
  const errors: Array<{ path: string; code: string; message: string }> = [];
  const configValidation = validateDestinationProviderConfig(input.provider, input.providerConfig);
  for (const error of configValidation.errors) {
    errors.push(
      fieldError(
        `provider_config.${error.field}`,
        error.message,
        'Provider config field is required.'
      )
    );
  }
  const forbidden = hasForbiddenProviderConfigField(input.providerConfig);
  if (forbidden) {
    errors.push(
      fieldError(
        `provider_config.${forbidden}`,
        'secret_not_allowed',
        'Provider config must reference credentials, not include secret values.'
      )
    );
  }
  const urlError = validateHttpSinkProviderUrl(input.provider, input.providerConfig);
  if (urlError) {
    errors.push(urlError);
  }

  return {
    provider: input.provider,
    destination_kind: schema.destinationKind,
    provider_config: redactProviderConfigPreviewValue(input.providerConfig),
    schema: {
      required_fields: [...schema.requiredFields],
      optional_fields: [...schema.optionalFields],
      default_capabilities: [...schema.defaultCapabilities],
    },
    runtime: {
      supported: getDestinationRuntimeSupport(input.provider).runtime_supported,
      status: getDestinationRuntimeSupport(input.provider).runtime_status,
      unsupported_reason: getDestinationRuntimeSupport(input.provider).runtime_unsupported_reason,
    },
    capabilities: parseDestinationCapabilities(input.capabilities, input.provider),
    validation: {
      valid: errors.length === 0,
      errors,
    },
    security: {
      inline_secret_detected: Boolean(forbidden),
      inline_secret_path: forbidden ? `provider_config.${forbidden}` : null,
      credential_ref_required: ['aws_s3', 'http', 'firehose'].includes(input.provider),
    },
  };
}

function jsonArrayOrNull(value: string[] | null): string | null {
  return value ? JSON.stringify(value) : null;
}

function parseDestinationCapabilities(
  value: unknown,
  provider: DestinationProvider
): DestinationCapability[] {
  const defaultCapabilities = getDefaultDestinationCapabilities(provider);
  if (!Array.isArray(value)) {
    return defaultCapabilities;
  }
  const allowed = new Set<DestinationCapability>([
    'archive_write',
    'sensitive_detail_write',
    'log_sink_write',
    'dlq_replay_payload_write',
    'export_artifact_write',
  ]);
  const parsed = value.filter((item): item is DestinationCapability => {
    return typeof item === 'string' && allowed.has(item as DestinationCapability);
  });
  return parsed.length > 0 ? [...new Set(parsed)] : defaultCapabilities;
}

async function replaceDestinationCapabilities(
  adapter: ReturnType<typeof getAdminAdapter>,
  destinationId: string,
  capabilities: DestinationCapability[],
  now: number
): Promise<void> {
  await adapter.execute('DELETE FROM admin_destination_capabilities WHERE destination_id = ?', [
    destinationId,
  ]);
  for (const capability of capabilities) {
    await adapter.execute(
      `INSERT INTO admin_destination_capabilities (
        destination_id, capability, source, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [destinationId, capability, 'platform_override', 1, now, now]
    );
  }
}

async function replaceStorageDestinationAssignments(
  adapter: ReturnType<typeof getAdminAdapter>,
  input: {
    destinationId: string;
    tenantIds: string[] | null;
    logTypes: string[] | null;
    planes: string[] | null;
    actorId: string | null;
    now: number;
  }
): Promise<void> {
  await adapter.execute('DELETE FROM storage_destination_assignments WHERE destination_id = ?', [
    input.destinationId,
  ]);
  const tenantIds = input.tenantIds && input.tenantIds.length > 0 ? input.tenantIds : [null];
  const logTypes = input.logTypes && input.logTypes.length > 0 ? input.logTypes : [null];
  const planes = input.planes && input.planes.length > 0 ? input.planes : [null];
  for (const tenantId of tenantIds) {
    for (const logType of logTypes) {
      for (const plane of planes) {
        await adapter.execute(
          `INSERT INTO storage_destination_assignments (
            id, destination_id, tenant_id, log_type, plane, enabled,
            created_by, updated_by, created_at, updated_at, version
          ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 1)`,
          [
            createLoggingId('sda', input.now),
            input.destinationId,
            tenantId,
            logType,
            plane,
            input.actorId,
            input.actorId,
            input.now,
            input.now,
          ]
        );
      }
    }
  }
}

async function readDestinationBody(
  c: AdminContext,
  mode: 'create' | 'update'
): Promise<
  | {
      ok: true;
      value: {
        scopeType: DestinationScopeType;
        scopeId: string;
        provider: DestinationProvider;
        destinationKind: DestinationKind;
        name: string;
        displayName: string;
        description: string | null;
        providerConfig: Record<string, unknown>;
        allowedTenantIds: string[] | null;
        allowedLogTypes: string[] | null;
        allowedPlanes: string[] | null;
        region: string | null;
        criticalAllowed: boolean;
        defaultFallbackEligible: boolean;
        retentionDays: number | null;
        encryptionMode: DestinationEncryptionMode;
        capabilities: DestinationCapability[];
        expectedVersion: number | null;
      };
    }
  | { ok: false; response: Response }
> {
  const body = await parseJsonObject(c);
  const errors: Array<{ path: string; code: string; message: string }> = [];
  const rawProvider = body.provider;
  const provider =
    typeof rawProvider === 'string' &&
    DESTINATION_PROVIDERS.includes(rawProvider as DestinationProvider)
      ? (rawProvider as DestinationProvider)
      : null;
  const scopeType =
    typeof body.scope_type === 'string' &&
    DESTINATION_SCOPE_TYPES.includes(body.scope_type as DestinationScopeType)
      ? (body.scope_type as DestinationScopeType)
      : null;
  const name = parseOptionalString(body.name);
  const displayName = parseOptionalString(body.display_name) ?? name;
  const providerConfig = parseProviderConfig(body.provider_config);
  const retentionDays = parseOptionalPositiveInteger(body.retention_days);
  const encryptionMode =
    typeof body.encryption_mode === 'string' &&
    DESTINATION_ENCRYPTION_MODES.includes(body.encryption_mode as DestinationEncryptionMode)
      ? (body.encryption_mode as DestinationEncryptionMode)
      : 'platform_managed';

  if (!scopeType) {
    errors.push(
      fieldError('scope_type', 'invalid_value', 'Scope type must be platform, tenant, or shared.')
    );
  }
  if (!provider) {
    errors.push(fieldError('provider', 'invalid_value', 'Provider is not supported.'));
  }
  if (!name) {
    errors.push(fieldError('name', 'required', 'Destination name is required.'));
  }
  if (!displayName) {
    errors.push(fieldError('display_name', 'required', 'Display name is required.'));
  }
  if (Number.isNaN(retentionDays)) {
    errors.push(
      fieldError('retention_days', 'invalid_value', 'Retention days must be a positive integer.')
    );
  }
  if (mode === 'update' && body.expected_version !== undefined) {
    const expectedVersion = Number.parseInt(String(body.expected_version), 10);
    if (!Number.isInteger(expectedVersion) || expectedVersion <= 0) {
      errors.push(
        fieldError(
          'expected_version',
          'invalid_value',
          'Expected version must be a positive integer.'
        )
      );
    }
  }
  const ifMatchVersion = mode === 'update' ? parseIfMatchVersion(c) : null;
  if (Number.isNaN(ifMatchVersion)) {
    errors.push(fieldError('If-Match', 'invalid_value', 'If-Match must contain a version ETag.'));
  }

  if (provider) {
    const configValidation = validateDestinationProviderConfig(provider, providerConfig);
    for (const error of configValidation.errors) {
      errors.push(
        fieldError(
          `provider_config.${error.field}`,
          error.message,
          'Provider config field is required.'
        )
      );
    }
    const urlError = validateHttpSinkProviderUrl(provider, providerConfig);
    if (urlError) {
      errors.push(urlError);
    }
    const forbidden = hasForbiddenProviderConfigField(providerConfig);
    if (forbidden) {
      errors.push(
        fieldError(
          `provider_config.${forbidden}`,
          'secret_not_allowed',
          'Provider config must reference credentials, not include secret values.'
        )
      );
    }
  }

  if (errors.length > 0 || !scopeType || !provider || !name || !displayName) {
    return { ok: false, response: await createAdminFieldErrorResponse(c, errors) };
  }

  const expectedVersion =
    body.expected_version === undefined || body.expected_version === null
      ? ifMatchVersion
      : Number.parseInt(String(body.expected_version), 10);
  const scopeId = parseOptionalString(body.scope_id) ?? (scopeType === 'tenant' ? '' : 'global');
  if (scopeType === 'tenant' && !scopeId) {
    return {
      ok: false,
      response: await createAdminFieldErrorResponse(c, [
        fieldError('scope_id', 'required', 'Tenant-scoped destinations require scope_id.'),
      ]),
    };
  }

  return {
    ok: true,
    value: {
      scopeType,
      scopeId,
      provider,
      destinationKind: DESTINATION_PROVIDER_SCHEMAS[provider].destinationKind,
      name,
      displayName,
      description: parseOptionalString(body.description),
      providerConfig,
      allowedTenantIds: parseDestinationStringArray(body.allowed_tenant_ids),
      allowedLogTypes: parseDestinationStringArray(body.allowed_log_types),
      allowedPlanes: parseDestinationStringArray(body.allowed_planes),
      region: parseOptionalString(body.region),
      criticalAllowed: parseOptionalBoolean(body.critical_allowed, false),
      defaultFallbackEligible: parseOptionalBoolean(body.default_fallback_eligible, false),
      retentionDays,
      encryptionMode,
      capabilities: parseDestinationCapabilities(body.capabilities, provider),
      expectedVersion,
    },
  };
}

function getCredentialRootKey(c: AdminContext): string | null {
  return c.env.OBJECT_ENCRYPTION_ROOT_KEY ?? null;
}

function getCredentialSecretBucket(c: AdminContext): R2Bucket | null {
  return c.env.SENSITIVE_DETAILS ?? null;
}

function getCredentialSecretBackend(
  c: AdminContext,
  requestedBackend: CredentialSecretBackendKind | null
): { backend: CredentialSecretBackend; backendKind: CredentialSecretBackendKind } | null {
  const rootKeyHex = getCredentialRootKey(c);
  if (!rootKeyHex) {
    return null;
  }
  const adapter = getAdminAdapter(c);
  const bucket = getCredentialSecretBucket(c);
  const backendKind =
    requestedBackend ??
    (bucket ? ('r2_encrypted_object' as const) : ('d1_encrypted_table' as const));

  if (backendKind === 'r2_encrypted_object') {
    if (!bucket) {
      return null;
    }
    return {
      backendKind,
      backend: new R2EncryptedCredentialSecretBackend({
        bucket,
        metadataStore: adapter,
        rootKeyHex,
        bucketName: 'admin-secrets',
      }),
    };
  }
  if (backendKind === 'd1_encrypted_table') {
    return {
      backendKind,
      backend: new D1EncryptedCredentialSecretBackend({
        store: adapter,
        rootKeyHex,
      }),
    };
  }
  return null;
}

function credentialBackendKindFromRef(ref: string): CredentialSecretBackendKind | null {
  const parsed = parseCredentialSecretRef(ref);
  if (parsed.scheme === 'r2secret') {
    return 'r2_encrypted_object';
  }
  if (parsed.scheme === 'd1secret') {
    return 'd1_encrypted_table';
  }
  return null;
}

async function getDestinationForCredentialMutation(
  c: AdminContext,
  id: string
): Promise<AdminDestinationRow | null> {
  const adapter = getAdminAdapter(c);
  return adapter.queryOne<AdminDestinationRow>(
    `SELECT id, scope_type, scope_id, destination_kind, provider, name, display_name,
            description, lifecycle_status, health_status, rotation_status, provider_config,
            credential_ref, credential_version, next_credential_ref, next_credential_version,
            previous_credential_ref, previous_credential_retire_after,
            allowed_tenant_ids, allowed_log_types, allowed_planes, region, critical_allowed,
            default_fallback_eligible, retention_days, encryption_mode,
            last_health_check_at, version
     FROM admin_destinations
     WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
}

async function readCredentialPrepareBody(c: AdminContext): Promise<
  | {
      ok: true;
      value: {
        plaintext: string;
        backendKind: CredentialSecretBackendKind | null;
        contentType: string;
      };
    }
  | { ok: false; response: Response }
> {
  const body = await parseJsonObject(c);
  const plaintext =
    parseOptionalString(body.secret_value) ??
    parseOptionalString(body.credential_value) ??
    parseOptionalString(body.plaintext);
  const backendKind =
    body.backend === 'r2_encrypted_object' || body.backend === 'd1_encrypted_table'
      ? (body.backend as CredentialSecretBackendKind)
      : null;
  const contentType = parseOptionalString(body.content_type) ?? 'text/plain';

  if (!plaintext) {
    return {
      ok: false,
      response: await createAdminFieldErrorResponse(c, [
        fieldError('secret_value', 'required', 'Credential secret value is required.'),
      ]),
    };
  }

  return {
    ok: true,
    value: {
      plaintext,
      backendKind,
      contentType,
    },
  };
}

function parseJsonStringArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function hideDestinationTenantAllowlist<T extends Record<string, unknown>>(item: T): T {
  const sanitized = { ...item };
  delete sanitized.allowed_tenant_ids;
  return sanitized;
}

function parseDestinationJsonArrayForDiff(value: string | null): string[] | null {
  const parsed = parseJsonStringArray(value);
  return parsed.length > 0 ? parsed : null;
}

function normalizeDestinationComparable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item)).filter(Boolean))].sort();
  }
  if (value && typeof value === 'object') {
    return JSON.parse(stableJson(value));
  }
  return value ?? null;
}

function destinationValueChanged(previous: unknown, next: unknown): boolean {
  return (
    stableJson(normalizeDestinationComparable(previous)) !==
    stableJson(normalizeDestinationComparable(next))
  );
}

function destinationDiffEntry(field: string, previous: unknown, next: unknown) {
  return {
    field,
    previous: normalizeDestinationComparable(previous),
    next: normalizeDestinationComparable(next),
    changed: destinationValueChanged(previous, next),
  };
}

function classifyDestinationDiffDanger(input: {
  current: AdminDestinationRow;
  next: {
    provider: DestinationProvider;
    providerConfig: Record<string, unknown>;
    allowedTenantIds: string[] | null;
    allowedLogTypes: string[] | null;
    allowedPlanes: string[] | null;
    criticalAllowed: boolean;
    defaultFallbackEligible: boolean;
    retentionDays: number | null;
    encryptionMode: DestinationEncryptionMode;
  };
}): { level: 'none' | 'review' | 'dangerous'; reasons: string[] } {
  const reasons: string[] = [];
  let level: 'none' | 'review' | 'dangerous' = 'none';
  const markReview = (reason: string) => {
    reasons.push(reason);
    if (level === 'none') {
      level = 'review';
    }
  };
  const markDangerous = (reason: string) => {
    reasons.push(reason);
    level = 'dangerous';
  };

  if (input.current.provider !== input.next.provider) {
    markDangerous('provider_change');
  }
  if (input.current.critical_allowed === 1 && !input.next.criticalAllowed) {
    markDangerous('critical_delivery_removed');
  }
  if (input.current.default_fallback_eligible === 1 && !input.next.defaultFallbackEligible) {
    markDangerous('fallback_eligibility_removed');
  }
  if (
    input.current.encryption_mode === 'platform_managed' &&
    input.next.encryptionMode !== 'platform_managed'
  ) {
    markDangerous('encryption_weakened');
  }
  if (
    input.current.retention_days !== null &&
    input.next.retentionDays !== null &&
    input.next.retentionDays < input.current.retention_days
  ) {
    markDangerous('retention_reduced');
  }
  if (
    destinationValueChanged(
      parseDestinationJsonArrayForDiff(input.current.allowed_tenant_ids),
      input.next.allowedTenantIds
    )
  ) {
    markReview('tenant_allowlist_changed');
  }
  if (
    destinationValueChanged(
      parseDestinationJsonArrayForDiff(input.current.allowed_log_types),
      input.next.allowedLogTypes
    )
  ) {
    markReview('log_type_allowlist_changed');
  }
  if (
    destinationValueChanged(
      parseDestinationJsonArrayForDiff(input.current.allowed_planes),
      input.next.allowedPlanes
    )
  ) {
    markReview('plane_allowlist_changed');
  }
  if (
    destinationValueChanged(
      parseDestinationProviderConfig(input.current.provider_config),
      input.next.providerConfig
    )
  ) {
    markReview('provider_config_changed');
  }

  return { level, reasons };
}

function isCriticalLoggingPolicy(logType: LogType, plane: LogPlane): boolean {
  if (['audit', 'admin_audit', 'security', 'pii'].includes(logType)) {
    return true;
  }
  if (plane === 'sensitive_detail') {
    return true;
  }
  return logType === 'audit' && plane === 'archive';
}

function isTenantConfigurableLogType(logType: LogType): boolean {
  return ['diagnostic', 'webhook', 'job'].includes(logType);
}

function readLogType(value: unknown): LogType | null {
  return typeof value === 'string' && (LOG_TYPES as readonly string[]).includes(value)
    ? (value as LogType)
    : null;
}

function readLogPlane(value: unknown): LogPlane | null {
  return typeof value === 'string' && (LOG_PLANES as readonly string[]).includes(value)
    ? (value as LogPlane)
    : null;
}

function readLoggingDeliveryLane(value: unknown): LoggingDeliveryLane | null {
  return value === 'critical' || value === 'default' || value === 'bulk'
    ? (value as LoggingDeliveryLane)
    : null;
}

function readLoggingQuotaMetric(value: unknown): LoggingQuotaMetric | null {
  return typeof value === 'string' && (LOGGING_QUOTA_METRICS as readonly string[]).includes(value)
    ? (value as LoggingQuotaMetric)
    : null;
}

function readLoggingUsageWindowKind(value: unknown): LoggingUsageWindowKind | null {
  return typeof value === 'string' &&
    (LOGGING_USAGE_WINDOW_KINDS as readonly string[]).includes(value)
    ? (value as LoggingUsageWindowKind)
    : null;
}

function readLoggingQuotaEnforcementMode(value: unknown): LoggingQuotaEnforcementMode | null {
  return typeof value === 'string' &&
    (LOGGING_QUOTA_ENFORCEMENT_MODES as readonly string[]).includes(value)
    ? (value as LoggingQuotaEnforcementMode)
    : null;
}

function readTenantDatabaseProbeRole(value: unknown): TenantDatabaseRole | null {
  return typeof value === 'string' &&
    (TENANT_DATABASE_PROBE_ROLES as readonly string[]).includes(value)
    ? (value as TenantDatabaseRole)
    : null;
}

function readQuotaScopeType(value: unknown): 'platform' | 'tenant' | null {
  return value === 'platform' || value === 'tenant' ? value : null;
}

function readOptionalPositiveIntegerField(value: unknown): number | null | typeof Number.NaN {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : Number.NaN;
}

function readWarningRatio(value: unknown): number {
  if (value === undefined || value === null || value === '') {
    return 0.8;
  }
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : Number.NaN;
}

function compactIdentifierSegment(value: string | null | undefined): string {
  return (value ?? 'all').replace(/[^A-Za-z0-9._=-]+/g, '_').slice(0, 96) || 'all';
}

function buildUsageAggregateId(input: {
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
    compactIdentifierSegment(input.windowKind),
    String(input.windowStartAt),
    compactIdentifierSegment(input.metricName),
    compactIdentifierSegment(input.tenantId),
    compactIdentifierSegment(input.tenantKey),
    compactIdentifierSegment(input.logType),
    compactIdentifierSegment(input.plane),
    compactIdentifierSegment(input.lane),
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

async function upsertLoggingUsageAggregate(
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
  const id = buildUsageAggregateId(row);
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

function quotaStateForValue(input: {
  value: number;
  softLimit: number | null;
  hardLimit: number | null;
  warningRatio: number;
}): 'ok' | 'warning' | 'soft_exceeded' | 'hard_exceeded' {
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
  logType: string | null;
  plane: string | null;
  lane: string | null;
}): boolean {
  if (input.lane === 'critical') {
    return true;
  }
  return isCriticalLoggingPolicy(
    (input.logType ?? 'diagnostic') as LogType,
    (input.plane ?? 'external_sink') as LogPlane
  );
}

async function readQuotaPolicyBody(
  c: AdminContext,
  mode: 'create' | 'update'
): Promise<
  | {
      ok: true;
      value: {
        scopeType: 'platform' | 'tenant';
        scopeId: string;
        logType: LogType | null;
        plane: LogPlane | null;
        lane: LoggingDeliveryLane | null;
        metricName: LoggingQuotaMetric;
        windowKind: LoggingUsageWindowKind;
        softLimit: number | null;
        hardLimit: number | null;
        warningRatio: number;
        enforcementMode: LoggingQuotaEnforcementMode;
        status: 'active' | 'disabled';
        expectedVersion: number | null;
      };
    }
  | { ok: false; response: Response }
> {
  const body = await parseJsonObject(c);
  const errors: ReturnType<typeof fieldError>[] = [];
  const scopeType = readQuotaScopeType(body.scope_type) ?? (mode === 'create' ? 'tenant' : null);
  const metricName = readLoggingQuotaMetric(body.metric_name);
  const windowKind = readLoggingUsageWindowKind(body.window_kind) ?? 'day';
  const softLimit = readOptionalPositiveIntegerField(body.soft_limit);
  const hardLimit = readOptionalPositiveIntegerField(body.hard_limit);
  const warningRatio = readWarningRatio(body.warning_ratio);
  const enforcementMode = readLoggingQuotaEnforcementMode(body.enforcement_mode) ?? 'warn_only';
  const status = body.status === 'disabled' ? 'disabled' : 'active';
  const expectedVersion =
    body.expected_version === undefined || body.expected_version === null
      ? null
      : Number.parseInt(String(body.expected_version), 10);

  if (!scopeType) {
    errors.push(
      fieldError('scope_type', 'invalid_value', 'Scope type must be platform or tenant.')
    );
  }
  if (!metricName) {
    errors.push(fieldError('metric_name', 'invalid_value', 'Quota metric is not supported.'));
  }
  if (Number.isNaN(softLimit)) {
    errors.push(
      fieldError('soft_limit', 'invalid_value', 'Soft limit must be a positive integer.')
    );
  }
  if (Number.isNaN(hardLimit)) {
    errors.push(
      fieldError('hard_limit', 'invalid_value', 'Hard limit must be a positive integer.')
    );
  }
  if (Number.isNaN(warningRatio)) {
    errors.push(
      fieldError('warning_ratio', 'invalid_value', 'Warning ratio must be greater than 0 and <= 1.')
    );
  }
  if (
    softLimit !== null &&
    hardLimit !== null &&
    !Number.isNaN(softLimit) &&
    !Number.isNaN(hardLimit) &&
    softLimit > hardLimit
  ) {
    errors.push(
      fieldError('soft_limit', 'invalid_value', 'Soft limit must not exceed hard limit.')
    );
  }
  if (
    body.expected_version !== undefined &&
    (expectedVersion === null || !Number.isInteger(expectedVersion) || expectedVersion <= 0)
  ) {
    errors.push(
      fieldError(
        'expected_version',
        'invalid_value',
        'Expected version must be a positive integer.'
      )
    );
  }

  if (errors.length > 0 || !scopeType || !metricName) {
    return { ok: false, response: await createAdminFieldErrorResponse(c, errors) };
  }

  const scopeId =
    parseOptionalString(body.scope_id) ??
    (scopeType === 'platform' ? 'global' : getTenantIdFromContext(c));
  if (scopeType === 'platform') {
    const platformError = await requirePlatformAuthority(c);
    if (platformError) {
      return { ok: false, response: platformError };
    }
  } else {
    const tenantFilter = await resolveTenantIdFilter(c, scopeId);
    if (!tenantFilter.ok) {
      return { ok: false, response: tenantFilter.response };
    }
  }

  return {
    ok: true,
    value: {
      scopeType,
      scopeId,
      logType: readLogType(body.log_type),
      plane: readLogPlane(body.plane),
      lane: readLoggingDeliveryLane(body.lane),
      metricName,
      windowKind,
      softLimit: Number.isNaN(softLimit) ? null : softLimit,
      hardLimit: Number.isNaN(hardLimit) ? null : hardLimit,
      warningRatio: Number.isNaN(warningRatio) ? 0.8 : warningRatio,
      enforcementMode,
      status,
      expectedVersion,
    },
  };
}

async function refreshLoggingUsageAggregatesForWindow(
  adapter: DatabaseAdapter,
  input: {
    windowKind: LoggingUsageWindowKind;
    windowStartAt: number;
    now: number;
    tenantKey?: string | null;
    tenantId?: string | null;
  }
): Promise<{ refreshed: number; window_start_at: number; window_end_at: number }> {
  const windowEndAt = endUsageWindow(input.windowStartAt, input.windowKind);
  const tenantKeyCondition = input.tenantKey ? 'AND tenant_key = ?' : '';
  const tenantKeyParams = input.tenantKey ? [input.tenantKey] : [];
  const tenantIdCondition = input.tenantId ? 'AND tenant_id = ?' : '';
  const tenantIdParams = input.tenantId ? [input.tenantId] : [];
  let refreshed = 0;

  const deliveryRows = await adapter.query<Record<string, unknown>>(
    `SELECT tenant_key, log_type, plane, lane,
            SUM(record_count) AS record_count,
            SUM(byte_count) AS byte_count,
            SUM(batch_count) AS batch_count
     FROM logging_delivery_event_aggregates
     WHERE bucket_start_at >= ? AND bucket_start_at < ?
       ${tenantKeyCondition}
     GROUP BY tenant_key, log_type, plane, lane`,
    [input.windowStartAt, windowEndAt, ...tenantKeyParams]
  );
  for (const row of deliveryRows) {
    for (const metricName of ['delivery_records', 'delivery_bytes', 'delivery_batches'] as const) {
      const sourceValue =
        metricName === 'delivery_records'
          ? row.record_count
          : metricName === 'delivery_bytes'
            ? row.byte_count
            : row.batch_count;
      await upsertLoggingUsageAggregate(adapter, {
        tenantKey: String(row.tenant_key),
        logType: String(row.log_type),
        plane: String(row.plane),
        lane: String(row.lane),
        metricName,
        windowKind: input.windowKind,
        windowStartAt: input.windowStartAt,
        windowEndAt,
        value: toInteger(sourceValue),
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
       ${tenantKeyCondition}
     GROUP BY tenant_key, log_type, plane`,
    [input.windowStartAt, windowEndAt, ...tenantKeyParams]
  );
  for (const row of catalogRows) {
    for (const metricName of ['catalog_objects', 'catalog_bytes'] as const) {
      await upsertLoggingUsageAggregate(adapter, {
        tenantKey: String(row.tenant_key),
        logType: String(row.log_type),
        plane: String(row.plane),
        metricName,
        windowKind: input.windowKind,
        windowStartAt: input.windowStartAt,
        windowEndAt,
        value: toInteger(metricName === 'catalog_objects' ? row.object_count : row.byte_count),
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
       ${tenantKeyCondition}
     GROUP BY tenant_key, lane`,
    [input.windowStartAt, windowEndAt, ...tenantKeyParams]
  );
  for (const row of dlqRows) {
    await upsertLoggingUsageAggregate(adapter, {
      tenantKey: String(row.tenant_key),
      lane: String(row.lane),
      metricName: 'dlq_items',
      windowKind: input.windowKind,
      windowStartAt: input.windowStartAt,
      windowEndAt,
      value: toInteger(row.item_count),
      sourceTable: 'logging_dlq_items',
      now: input.now,
    });
    refreshed += 1;
  }

  const sensitiveRows = await adapter.query<Record<string, unknown>>(
    `SELECT tenant_id, object_class, SUM(byte_length) AS byte_count
     FROM sensitive_detail_chunk_index
     WHERE created_at >= ? AND created_at < ?
       ${tenantIdCondition}
     GROUP BY tenant_id, object_class`,
    [input.windowStartAt, windowEndAt, ...tenantIdParams]
  );
  for (const row of sensitiveRows) {
    await upsertLoggingUsageAggregate(adapter, {
      tenantId: String(row.tenant_id),
      plane: 'sensitive_detail',
      metricName: 'sensitive_detail_bytes',
      windowKind: input.windowKind,
      windowStartAt: input.windowStartAt,
      windowEndAt,
      value: toInteger(row.byte_count),
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
       ${tenantKeyCondition}
     GROUP BY tenant_key, lane, kind`,
    [input.windowStartAt, windowEndAt, ...tenantKeyParams]
  );
  for (const row of messageJobRows) {
    await upsertLoggingUsageAggregate(adapter, {
      tenantKey: typeof row.tenant_key === 'string' ? row.tenant_key : null,
      lane: typeof row.lane === 'string' ? row.lane : null,
      metricName: 'message_jobs',
      windowKind: input.windowKind,
      windowStartAt: input.windowStartAt,
      windowEndAt,
      value: toInteger(row.job_count),
      sourceTable: 'logging_message_jobs',
      metadata: { kind: row.kind },
      now: input.now,
    });
    refreshed += 1;
  }

  return { refreshed, window_start_at: input.windowStartAt, window_end_at: windowEndAt };
}

function readLoggingChangeProtection(
  value: unknown
): LoggingDestinationOverrideRow['change_protection'] | null {
  return typeof value === 'string' &&
    (LOGGING_CHANGE_PROTECTIONS as readonly string[]).includes(value)
    ? (value as LoggingDestinationOverrideRow['change_protection'])
    : null;
}

function normalizeRegion(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function destinationSatisfiesResidency(input: {
  destinationRegion: string | null;
  residencyProfile: ResidencyProfile | null;
}): boolean {
  const allowedRegions = input.residencyProfile?.allowedRegions ?? [];
  if (allowedRegions.length === 0) {
    return true;
  }
  const destinationRegion = normalizeRegion(input.destinationRegion);
  if (!destinationRegion) {
    return false;
  }
  return allowedRegions.map((region) => region.toLowerCase()).includes(destinationRegion);
}

async function resolveResidencyProfileForLoggingPolicy(
  c: AdminContext,
  tenantId: string | null
): Promise<ResidencyProfile | null> {
  if (tenantId) {
    return (
      await resolveTenantRuntimeProfilesFromEnv(
        c.env as unknown as Parameters<typeof resolveTenantRuntimeProfilesFromEnv>[0],
        tenantId
      )
    ).residencyProfile;
  }

  const defaults = await loadEnvironmentProfileDefaultsFromEnv(
    c.env as unknown as Parameters<typeof loadEnvironmentProfileDefaultsFromEnv>[0]
  );
  const registry = createRuntimeProfileRegistryFromEnv(
    c.env as unknown as Parameters<typeof createRuntimeProfileRegistryFromEnv>[0]
  );
  return registry.get<ResidencyProfile>('residency', defaults.residencyProfileId);
}

function destinationAllowsAssignment(input: {
  destination: AdminDestinationRow;
  tenantId: string | null;
  logType: LogType;
  plane: LogPlane;
  critical: boolean;
  residencyProfile: ResidencyProfile | null;
  fieldName?: string;
}): ReturnType<typeof fieldError> | null {
  const { destination, tenantId, logType, plane, critical } = input;
  const fieldName = input.fieldName ?? 'destination_id';
  if (destination.lifecycle_status !== 'active') {
    return fieldError(fieldName, 'destination_inactive', 'Destination is not active.');
  }
  if (!['configured', 'healthy'].includes(destination.health_status)) {
    return fieldError(fieldName, 'destination_unhealthy', 'Destination is not selectable.');
  }
  if (critical && destination.critical_allowed !== 1) {
    return fieldError(
      fieldName,
      'critical_not_allowed',
      'Destination is not approved for critical logs.'
    );
  }
  if (
    !destinationSatisfiesResidency({
      destinationRegion: destination.region,
      residencyProfile: input.residencyProfile,
    })
  ) {
    return fieldError(
      fieldName,
      'region_mismatch',
      'Destination region is not compatible with the residency policy.'
    );
  }

  if (!tenantId && destination.scope_type === 'tenant') {
    return fieldError(
      fieldName,
      'tenant_destination_for_platform_policy',
      'Tenant-scoped destinations cannot be used for platform defaults.'
    );
  }
  if (tenantId && destination.scope_type === 'tenant' && destination.scope_id !== tenantId) {
    return fieldError(fieldName, 'tenant_not_allowed', 'Destination is not assigned to tenant.');
  }
  return null;
}

async function destinationHasStorageAssignment(input: {
  adapter: ReturnType<typeof getAdminAdapter>;
  destinationId: string;
  tenantId: string | null;
  logType: LogType | null;
  plane: LogPlane | null;
}): Promise<boolean> {
  const row = await input.adapter.queryOne<{ id: string }>(
    `SELECT id
     FROM storage_destination_assignments
     WHERE destination_id = ?
       AND enabled = 1
       AND (? IS NULL OR tenant_id IS NULL OR tenant_id = ?)
       AND (? IS NULL OR log_type IS NULL OR log_type = ?)
       AND (? IS NULL OR plane IS NULL OR plane = ?)
     ORDER BY
       CASE WHEN tenant_id IS NULL THEN 1 ELSE 0 END,
       CASE WHEN log_type IS NULL THEN 1 ELSE 0 END,
       CASE WHEN plane IS NULL THEN 1 ELSE 0 END
     LIMIT 1`,
    [
      input.destinationId,
      input.tenantId,
      input.tenantId,
      input.logType,
      input.logType,
      input.plane,
      input.plane,
    ]
  );
  return typeof row?.id === 'string' && row.id.length > 0;
}

function storageAssignmentFieldError(input: {
  tenantId: string | null;
  logType: LogType;
  plane: LogPlane;
}): ReturnType<typeof fieldError> {
  if (input.tenantId) {
    return fieldError(
      'destination_id',
      'tenant_not_allowed',
      'Destination is not assigned to tenant.'
    );
  }
  if (input.logType) {
    return fieldError(
      'destination_id',
      'log_type_or_plane_not_allowed',
      'Destination is not assigned to this log type and plane.'
    );
  }
  return fieldError(
    'destination_id',
    'plane_not_allowed',
    'Destination does not allow this plane.'
  );
}

async function canTenantReadDestination(
  adapter: ReturnType<typeof getAdminAdapter>,
  destination: AdminDestinationRow,
  tenantId: string
): Promise<boolean> {
  if (destination.scope_type === 'tenant') {
    return destination.scope_id === tenantId;
  }
  if (destination.scope_type !== 'platform' && destination.scope_type !== 'shared') {
    return false;
  }
  return destinationHasStorageAssignment({
    adapter,
    destinationId: destination.id,
    tenantId,
    logType: null,
    plane: null,
  });
}

async function requireDestinationForLoggingOverride(
  c: AdminContext,
  destinationId: string,
  tenantId: string | null,
  logType: LogType,
  plane: LogPlane,
  critical: boolean,
  fieldName = 'destination_id'
): Promise<{ ok: true; destination: AdminDestinationRow } | { ok: false; response: Response }> {
  const adapter = getAdminAdapter(c);
  const destination = await adapter.queryOne<AdminDestinationRow>(
    `SELECT id, scope_type, scope_id, destination_kind, provider, name, display_name,
            description, lifecycle_status, health_status, provider_config, allowed_tenant_ids,
            allowed_log_types, allowed_planes, region, critical_allowed,
            default_fallback_eligible, retention_days, encryption_mode,
            last_health_check_at, version
     FROM admin_destinations
     WHERE id = ? AND deleted_at IS NULL`,
    [destinationId]
  );
  if (!destination) {
    return {
      ok: false,
      response: await createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND),
    };
  }
  const residencyProfile = await resolveResidencyProfileForLoggingPolicy(c, tenantId);
  const eligibilityError = destinationAllowsAssignment({
    destination,
    tenantId,
    logType,
    plane,
    critical,
    residencyProfile,
    fieldName,
  });
  if (eligibilityError) {
    return { ok: false, response: await createAdminFieldErrorResponse(c, [eligibilityError]) };
  }
  const assigned = await destinationHasStorageAssignment({
    adapter,
    destinationId,
    tenantId,
    logType,
    plane,
  });
  if (!assigned) {
    return {
      ok: false,
      response: await createAdminFieldErrorResponse(c, [
        {
          ...storageAssignmentFieldError({ tenantId, logType, plane }),
          path: fieldName,
        },
      ]),
    };
  }
  return { ok: true, destination };
}

async function readLoggingDestinationOverrideBody(
  c: AdminContext,
  mode: 'create' | 'update'
): Promise<
  | {
      ok: true;
      value: {
        tenantId: string | null;
        logType: LogType;
        plane: LogPlane;
        destinationId: string;
        fallbackPolicyId: string | null;
        enabled: boolean;
        changeProtection: LoggingDestinationOverrideRow['change_protection'];
        approvalPolicyId: string | null;
        expectedVersion: number | null;
        confirmation: string | null;
      };
    }
  | { ok: false; response: Response }
> {
  const body = await parseJsonObject(c);
  const fields: ReturnType<typeof fieldError>[] = [];
  const logType = readLogType(body.log_type);
  const plane = readLogPlane(body.plane);
  const destinationId = parseOptionalString(body.destination_id);
  const tenantId = parseOptionalString(body.tenant_id);
  const fallbackPolicyId = parseOptionalString(body.fallback_policy_id);
  const approvalPolicyId = parseOptionalString(body.approval_policy_id);
  const changeProtection = readLoggingChangeProtection(body.change_protection) ?? 'confirm';
  const expectedVersion =
    body.expected_version === undefined || body.expected_version === null
      ? null
      : Number.parseInt(String(body.expected_version), 10);
  const ifMatchVersion = mode === 'update' ? parseIfMatchVersion(c) : null;

  if (!logType) {
    fields.push(fieldError('log_type', 'invalid_value', 'Log type is not supported.'));
  }
  if (!plane) {
    fields.push(fieldError('plane', 'invalid_value', 'Log plane is not supported.'));
  }
  if (!destinationId) {
    fields.push(fieldError('destination_id', 'required', 'Destination id is required.'));
  }
  if (
    mode === 'update' &&
    expectedVersion !== null &&
    (!Number.isInteger(expectedVersion) || expectedVersion <= 0)
  ) {
    fields.push(
      fieldError(
        'expected_version',
        'invalid_value',
        'Expected version must be a positive integer.'
      )
    );
  }
  if (Number.isNaN(ifMatchVersion)) {
    fields.push(fieldError('If-Match', 'invalid_value', 'If-Match must contain a version ETag.'));
  }
  if (fields.length > 0 || !logType || !plane || !destinationId) {
    return { ok: false, response: await createAdminFieldErrorResponse(c, fields) };
  }

  return {
    ok: true,
    value: {
      tenantId,
      logType,
      plane,
      destinationId,
      fallbackPolicyId,
      enabled: body.enabled === undefined ? true : body.enabled !== false,
      changeProtection,
      approvalPolicyId,
      expectedVersion: expectedVersion ?? ifMatchVersion,
      confirmation: parseOptionalString(body.confirmation),
    },
  };
}

async function readLoggingFallbackPolicyBody(
  c: AdminContext,
  mode: 'create' | 'update'
): Promise<
  | {
      ok: true;
      value: {
        scopeType: 'platform' | 'tenant';
        scopeId: string;
        logType: LogType;
        plane: LogPlane;
        fallbackDestinationId: string | null;
        failureMode: string;
        expectedVersion: number | null;
        confirmation: string | null;
      };
    }
  | { ok: false; response: Response }
> {
  const body = await parseJsonObject(c);
  const fields: ReturnType<typeof fieldError>[] = [];
  const scopeType = body.scope_type === 'tenant' ? 'tenant' : 'platform';
  const scopeId =
    parseOptionalString(body.scope_id) ??
    (scopeType === 'platform' ? 'global' : getTenantIdFromContext(c));
  const logType = readLogType(body.log_type);
  const plane = readLogPlane(body.plane);
  const failureMode =
    typeof body.failure_mode === 'string' &&
    (LOGGING_FALLBACK_FAILURE_MODES as readonly string[]).includes(body.failure_mode)
      ? body.failure_mode
      : null;
  const expectedVersion =
    body.expected_version === undefined || body.expected_version === null
      ? null
      : Number.parseInt(String(body.expected_version), 10);
  const ifMatchVersion = mode === 'update' ? parseIfMatchVersion(c) : null;

  if (!logType) {
    fields.push(fieldError('log_type', 'invalid_value', 'Log type is not supported.'));
  }
  if (!plane) {
    fields.push(fieldError('plane', 'invalid_value', 'Log plane is not supported.'));
  }
  if (!failureMode) {
    fields.push(
      fieldError('failure_mode', 'invalid_value', 'Fallback failure mode is not supported.')
    );
  }
  if (
    mode === 'update' &&
    expectedVersion !== null &&
    (!Number.isInteger(expectedVersion) || expectedVersion <= 0)
  ) {
    fields.push(
      fieldError(
        'expected_version',
        'invalid_value',
        'Expected version must be a positive integer.'
      )
    );
  }
  if (Number.isNaN(ifMatchVersion)) {
    fields.push(fieldError('If-Match', 'invalid_value', 'If-Match must contain a version ETag.'));
  }
  if (fields.length > 0 || !logType || !plane || !failureMode) {
    return { ok: false, response: await createAdminFieldErrorResponse(c, fields) };
  }

  return {
    ok: true,
    value: {
      scopeType,
      scopeId,
      logType,
      plane,
      fallbackDestinationId: parseOptionalString(body.fallback_destination_id),
      failureMode,
      expectedVersion: expectedVersion ?? ifMatchVersion,
      confirmation: parseOptionalString(body.confirmation),
    },
  };
}

async function requireLoggingPolicyMutationPermission(
  c: AdminContext,
  value: {
    tenantId: string | null;
    logType: LogType;
    plane: LogPlane;
    confirmation: string | null;
  }
): Promise<Response | null> {
  const authContext = getAuth(c);
  const critical = isCriticalLoggingPolicy(value.logType, value.plane);
  const requiredPermission = value.tenantId
    ? ADMIN_PERMISSIONS.LOGGING_TENANT_OVERRIDES_UPDATE
    : ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE;
  if (!hasPermission(authContext, requiredPermission)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  if (!value.tenantId && !hasPlatformAuthority(authContext)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  if (
    value.tenantId &&
    !hasPlatformAuthority(authContext) &&
    value.tenantId !== getTenantIdFromContext(c)
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  if (value.tenantId && critical) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  if (value.tenantId && !isTenantConfigurableLogType(value.logType)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  if (critical && !hasPermission(authContext, ADMIN_PERMISSIONS.LOGGING_CRITICAL_UPDATE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const confirmation = `CHANGE CRITICAL LOGGING ${value.logType}:${value.plane}`;
  if (critical && value.confirmation !== confirmation) {
    return createAdminFieldErrorResponse(c, [
      fieldError(
        'confirmation',
        'confirmation_mismatch',
        `Confirmation must be "${confirmation}".`
      ),
    ]);
  }
  return null;
}

async function requireCurrentLoggingOverrideMutationAccess(
  c: AdminContext,
  current: { tenant_id: string | null }
): Promise<Response | null> {
  if (hasPlatformAuthority(getAuth(c))) {
    return null;
  }
  if (!current.tenant_id || current.tenant_id !== getTenantIdFromContext(c)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  return null;
}

async function hashLoggingDestinationOverride(input: {
  tenantId: string | null;
  logType: LogType;
  plane: LogPlane;
  destinationId: string;
  fallbackPolicyId: string | null;
  enabled: boolean;
  managedBy: 'platform' | 'tenant';
  changeProtection: LoggingDestinationOverrideRow['change_protection'];
  approvalPolicyId: string | null;
}): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(input)));
  return `sha256:${toHex(digest)}`;
}

async function insertLoggingDestinationOverrideHistory(
  adapter: ReturnType<typeof getAdminAdapter>,
  input: {
    overrideId: string;
    previous: LoggingDestinationOverrideRow | null;
    next: {
      tenant_id: string | null;
      log_type: LogType;
      plane: LogPlane;
      destination_id: string;
      fallback_policy_id: string | null;
      enabled: number;
      change_protection: LoggingDestinationOverrideRow['change_protection'];
      approval_policy_id: string | null;
      policy_hash: string | null;
      version: number;
    };
    changedBy: string | null;
    changedAt: number;
    changeReason: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await adapter.execute(
    `INSERT INTO logging_destination_override_history (
      id, override_id, tenant_id, log_type, plane,
      previous_destination_id, next_destination_id,
      previous_fallback_policy_id, next_fallback_policy_id,
      previous_enabled, next_enabled,
      previous_change_protection, next_change_protection,
      previous_approval_policy_id, next_approval_policy_id,
      previous_policy_hash, next_policy_hash,
      previous_version, next_version,
      changed_by, changed_at, change_reason, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      createLoggingId('loh', input.changedAt),
      input.overrideId,
      input.next.tenant_id,
      input.next.log_type,
      input.next.plane,
      input.previous?.destination_id ?? null,
      input.next.destination_id,
      input.previous?.fallback_policy_id ?? null,
      input.next.fallback_policy_id,
      input.previous?.enabled ?? null,
      input.next.enabled,
      input.previous?.change_protection ?? null,
      input.next.change_protection,
      input.previous?.approval_policy_id ?? null,
      input.next.approval_policy_id,
      input.previous?.policy_hash ?? null,
      input.next.policy_hash,
      input.previous?.version ?? null,
      input.next.version,
      input.changedBy,
      input.changedAt,
      input.changeReason,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ]
  );
}

async function requireCurrentLoggingFallbackMutationAccess(
  c: AdminContext,
  current: { scope_type: string; scope_id: string }
): Promise<Response | null> {
  if (hasPlatformAuthority(getAuth(c))) {
    return null;
  }
  if (current.scope_type !== 'tenant' || current.scope_id !== getTenantIdFromContext(c)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  return null;
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

async function runDestinationHealthCheck(
  env: Env,
  destination: AdminDestinationRow,
  checkType: DestinationHealthCheckResult['check_type']
): Promise<DestinationHealthCheckResult> {
  const start = Date.now();
  const previous = destination.health_status ?? 'unknown';
  const metadata: Record<string, unknown> = {
    provider: destination.provider,
    destination_kind: destination.destination_kind,
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

  const config = parseDestinationProviderConfig(destination.provider_config);
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
      const key = `${normalizeR2Prefix(prefix)}/health/${destination.id}-${Date.now()}.txt`;
      await bucket.put(key, 'authrim destination health check');
      const object = typeof bucket.head === 'function' ? await bucket.head(key) : null;
      if (typeof bucket.delete === 'function') {
        await bucket.delete(key);
      }
      if (!object) {
        return {
          check_type: checkType,
          previous_health_status: previous,
          next_health_status: 'degraded',
          result: 'partial',
          error_class: 'r2_head_missing_after_write',
          latency_ms: Date.now() - start,
          metadata: { ...metadata, probe_key: key },
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

async function enqueueDestinationHealthNotification(
  c: AdminContext,
  destination: AdminDestinationRow,
  result: DestinationHealthCheckResult,
  checkedAt: number
): Promise<void> {
  if (result.result === 'success') {
    return;
  }
  const adapter = getAdminAdapter(c);
  const repository = new InternalNotificationEventRepository(adapter);
  await repository.enqueue({
    tenantId: destination.scope_id || 'global',
    category: 'logging_destination_health',
    eventType: `logging.destination.health.${result.next_health_status}`,
    severity:
      result.next_health_status === 'unreachable' || result.next_health_status === 'failing'
        ? 'high'
        : 'medium',
    deduplicationKey: [
      'logging_destination_health',
      destination.id,
      result.check_type,
      result.next_health_status,
      result.error_class ?? 'none',
    ].join(':'),
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

export const destinationsRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

export const loggingPoliciesRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

export const adminLoggingRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

export const notificationsRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

const NOTIFICATION_CENTER_CATEGORIES = [
  'storage_registry_security',
  'storage_registry_health',
  'tenant_database_stats',
  'tenant_database_health',
  'control_plane_drift',
  'logging_destination_health',
  'logging_delivery_failure',
  'logging_fallback_used',
  'logging_dlq_backlog',
  'logging_quota_warning',
  'logging_repair_job_status',
  'notification_delivery_failure',
] as const;
const NOTIFICATION_CENTER_STATUSES = [
  'pending',
  'delivered',
  'failed',
  'dead_letter',
  'suppressed',
] as const;
const NOTIFICATION_CENTER_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
const NOTIFICATION_CENTER_UNRESOLVED_STATUSES = ['pending', 'failed', 'dead_letter'];
const NOTIFICATION_CENTER_READ_PERMISSIONS = [
  ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ,
  ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ,
  ADMIN_PERMISSIONS.ADMIN_LOGGING_OVERVIEW_READ,
  ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_READ,
  ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_LIST,
  ADMIN_PERMISSIONS.DATABASE_ROUTING_READ,
];

interface NotificationDeliveryRouteRow {
  id: string;
  name: string;
  scope_type: 'platform' | 'tenant';
  scope_id: string;
  provider: NotificationDeliveryProvider;
  destination_id: string | null;
  categories_json: string | null;
  severities_json: string | null;
  min_severity: NotificationDeliveryMinSeverity;
  enabled: number | string;
  failure_policy: NotificationDeliveryFailurePolicy;
  max_attempts: number | string;
  retry_after_seconds: number | string;
  suppression_key: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: number | string;
  updated_at: number | string;
  version: number | string;
}

interface NotificationDeliveryEventRow {
  id: string;
  tenant_id: string;
  category: string;
  event_type: string;
  severity: NotificationDeliveryMinSeverity;
  status: string;
  payload_json: string;
  attempts: number | string;
}

function parseCsvQueryValues(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function sqlPlaceholders(values: unknown[]): string {
  return values.map(() => '?').join(', ');
}

function readNotificationDeliveryProvider(value: unknown): NotificationDeliveryProvider | null {
  return typeof value === 'string' &&
    (NOTIFICATION_DELIVERY_PROVIDERS as readonly string[]).includes(value)
    ? (value as NotificationDeliveryProvider)
    : null;
}

function readNotificationDeliverySeverity(value: unknown): NotificationDeliveryMinSeverity | null {
  return typeof value === 'string' &&
    (NOTIFICATION_DELIVERY_MIN_SEVERITIES as readonly string[]).includes(value)
    ? (value as NotificationDeliveryMinSeverity)
    : null;
}

function readNotificationDeliveryFailurePolicy(
  value: unknown
): NotificationDeliveryFailurePolicy | null {
  return typeof value === 'string' &&
    (NOTIFICATION_DELIVERY_FAILURE_POLICIES as readonly string[]).includes(value)
    ? (value as NotificationDeliveryFailurePolicy)
    : null;
}

function parseJsonStringFilter(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const items = value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
  return items.length > 0 ? [...new Set(items)] : null;
}

function parseNotificationRoutingProviders(payloadJson: string): string[] | null {
  const payload = parseJsonMetadata(payloadJson);
  const policy = payload.notification_routing_policy;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return null;
  }
  const providers = (policy as Record<string, unknown>).providers;
  return Array.isArray(providers)
    ? providers.filter((item): item is string => typeof item === 'string')
    : null;
}

function notificationRouteMatchesEvent(
  route: NotificationDeliveryRouteRow,
  event: NotificationDeliveryEventRow
): boolean {
  if (String(route.enabled) !== '1') {
    return false;
  }
  if (route.scope_type === 'tenant' && route.scope_id !== event.tenant_id) {
    return false;
  }
  const categories = parseJsonStringArray(route.categories_json);
  if (categories.length > 0 && !categories.includes(event.category)) {
    return false;
  }
  const severities = parseJsonStringArray(route.severities_json);
  if (severities.length > 0 && !severities.includes(event.severity)) {
    return false;
  }
  if (NOTIFICATION_SEVERITY_RANK[event.severity] > NOTIFICATION_SEVERITY_RANK[route.min_severity]) {
    return false;
  }
  const routingProviders = parseNotificationRoutingProviders(event.payload_json);
  if (routingProviders && !routingProviders.includes(route.provider)) {
    return false;
  }
  return true;
}

async function readNotificationDeliveryRouteBody(c: AdminContext): Promise<
  | {
      ok: true;
      value: {
        name: string;
        scopeType: 'platform' | 'tenant';
        scopeId: string;
        provider: NotificationDeliveryProvider;
        destinationId: string | null;
        categories: string[] | null;
        severities: string[] | null;
        minSeverity: NotificationDeliveryMinSeverity;
        enabled: boolean;
        failurePolicy: NotificationDeliveryFailurePolicy;
        maxAttempts: number;
        retryAfterSeconds: number;
        suppressionKey: string | null;
      };
    }
  | { ok: false; response: Response }
> {
  const body = await parseJsonObject(c);
  const errors: ReturnType<typeof fieldError>[] = [];
  const name = parseOptionalString(body.name);
  const scopeType = readQuotaScopeType(body.scope_type) ?? 'platform';
  const provider = readNotificationDeliveryProvider(body.provider);
  const minSeverity = readNotificationDeliverySeverity(body.min_severity) ?? 'medium';
  const failurePolicy =
    readNotificationDeliveryFailurePolicy(body.failure_policy) ?? 'retry_until_dead_letter';
  const maxAttempts = Number.parseInt(String(body.max_attempts ?? '5'), 10);
  const retryAfterSeconds = Number.parseInt(String(body.retry_after_seconds ?? '300'), 10);

  if (!name) {
    errors.push(fieldError('name', 'required', 'Route name is required.'));
  }
  if (!provider) {
    errors.push(fieldError('provider', 'invalid_value', 'Notification provider is not supported.'));
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0 || maxAttempts > 50) {
    errors.push(fieldError('max_attempts', 'invalid_value', 'Max attempts must be 1-50.'));
  }
  if (!Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 0) {
    errors.push(
      fieldError('retry_after_seconds', 'invalid_value', 'Retry delay must be zero or greater.')
    );
  }
  if (errors.length > 0 || !name || !provider) {
    return { ok: false, response: await createAdminFieldErrorResponse(c, errors) };
  }
  const scopeId =
    parseOptionalString(body.scope_id) ??
    (scopeType === 'platform' ? 'global' : getTenantIdFromContext(c));
  if (scopeType === 'platform') {
    const platformError = await requirePlatformAuthority(c);
    if (platformError) {
      return { ok: false, response: platformError };
    }
  } else {
    const tenantFilter = await resolveTenantIdFilter(c, scopeId);
    if (!tenantFilter.ok) {
      return { ok: false, response: tenantFilter.response };
    }
  }
  return {
    ok: true,
    value: {
      name,
      scopeType,
      scopeId,
      provider,
      destinationId: parseOptionalString(body.destination_id),
      categories: parseJsonStringFilter(body.categories),
      severities: parseJsonStringFilter(body.severities),
      minSeverity,
      enabled: body.enabled !== false,
      failurePolicy,
      maxAttempts,
      retryAfterSeconds,
      suppressionKey: parseOptionalString(body.suppression_key),
    },
  };
}

async function deliverNotificationViaRoute(
  c: AdminContext,
  input: {
    event: NotificationDeliveryEventRow;
    route: NotificationDeliveryRouteRow;
    now: number;
  }
): Promise<{ route_id: string; status: 'delivered' | 'failed'; error_class: string | null }> {
  const adapter = getAdminAdapter(c);
  let status: 'delivered' | 'failed' = 'failed';
  let errorClass: string | null = null;
  let errorMessage: string | null = null;
  let responseStatus: number | null = null;
  try {
    if (!input.route.destination_id) {
      throw new Error('notification_destination_required');
    }
    const destination = await adapter.queryOne<AdminDestinationRow>(
      `SELECT id, scope_type, scope_id, destination_kind, provider, name, display_name,
              description, lifecycle_status, health_status, rotation_status, provider_config,
              credential_ref, credential_version, next_credential_ref, next_credential_version,
              previous_credential_ref, previous_credential_retire_after,
              allowed_tenant_ids, allowed_log_types, allowed_planes, region, critical_allowed,
              default_fallback_eligible, retention_days, encryption_mode,
              last_health_check_at, version
       FROM admin_destinations
       WHERE id = ? AND deleted_at IS NULL`,
      [input.route.destination_id]
    );
    if (!destination || destination.lifecycle_status !== 'active') {
      throw new Error('notification_destination_unavailable');
    }
    const config = parseDestinationProviderConfig(destination.provider_config);
    const url = parseOptionalString(config.url);
    if (destination.provider !== 'http' || !url) {
      throw new Error('notification_provider_requires_http_destination');
    }
    const validation = validateUrlForSSRF(url);
    if (!validation.valid || !url.startsWith('https://')) {
      throw new Error('notification_destination_url_invalid');
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-authrim-notification': input.event.id,
        'x-authrim-notification-route': input.route.id,
      },
      body: JSON.stringify({
        id: input.event.id,
        tenant_id: input.event.tenant_id,
        category: input.event.category,
        event_type: input.event.event_type,
        severity: input.event.severity,
        payload: parseJsonMetadata(input.event.payload_json),
      }),
    });
    responseStatus = response.status;
    if (!response.ok) {
      throw new Error(`notification_destination_http_${response.status}`);
    }
    status = 'delivered';
  } catch (error) {
    errorClass =
      error instanceof Error ? error.message.split(':')[0] : 'notification_delivery_failed';
    errorMessage = error instanceof Error ? error.message : 'notification_delivery_failed';
  }

  const attemptCount = toInteger(input.event.attempts) + 1;
  await adapter.execute(
    `INSERT INTO internal_notification_delivery_attempts (
      id, event_id, route_id, provider, destination_id, status, attempt_count,
      response_status, error_class, error_message, next_attempt_at, payload_sha256,
      delivered_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      createLoggingId('inda', input.now),
      input.event.id,
      input.route.id,
      input.route.provider,
      input.route.destination_id,
      status,
      attemptCount,
      responseStatus,
      errorClass,
      errorMessage,
      status === 'failed' ? input.now + toInteger(input.route.retry_after_seconds) * 1000 : null,
      null,
      status === 'delivered' ? input.now : null,
      input.now,
      input.now,
    ]
  );
  if (status === 'failed') {
    await adapter.execute(
      `UPDATE internal_notification_events
       SET status = CASE WHEN attempts + 1 >= ? THEN 'dead_letter' ELSE 'failed' END,
           attempts = attempts + 1,
           last_error = ?,
           next_attempt_at = ?,
           updated_at = ?
       WHERE id = ?`,
      [
        toInteger(input.route.max_attempts),
        errorMessage,
        new Date(input.now + toInteger(input.route.retry_after_seconds) * 1000).toISOString(),
        new Date(input.now).toISOString(),
        input.event.id,
      ]
    );
  }
  return { route_id: input.route.id, status, error_class: errorClass };
}

function adminAuditCoverageRows(now: number) {
  return buildAdminAuditCoverageStatusView(LOGGING_ADMIN_AUDIT_COVERAGE_REGISTRY).map((row) => ({
    ...row,
    first_seen_at: now,
    last_seen_at: now,
    updated_at: now,
  }));
}

function toInteger(value: unknown, defaultValue = 0): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

async function detectLogCatalogRepairs(
  c: AdminContext,
  input?: {
    limit?: number;
    tenantKey?: string | null;
    logType?: LogType | null;
    plane?: LogPlane | null;
  }
) {
  const now = Date.now();
  const limit = Math.min(Math.max(input?.limit ?? parseLimit(c, 100, 500), 1), 500);
  const pendingTtlMs = Math.min(
    Math.max(toInteger(c.req.query('pending_ttl_ms'), 15 * 60 * 1000), 60 * 1000),
    24 * 60 * 60 * 1000
  );
  const rawFindings = await getAdminLoggingControlRepository(c).detectCatalogRepairFindings({
    now,
    limit,
    pendingTtlMs,
  });
  const findings = rawFindings.filter((finding) => {
    if (input?.tenantKey && finding.tenantKey !== input.tenantKey) {
      return false;
    }
    if (input?.logType && finding.logType !== input.logType) {
      return false;
    }
    if (input?.plane && finding.plane !== input.plane) {
      return false;
    }
    return true;
  });

  return { findings, now, pendingTtlMs };
}

async function parseCatalogRepairScope(
  c: AdminContext,
  input: Record<string, unknown> = {}
): Promise<
  | {
      ok: true;
      tenantKey: string | null;
      logType: LogType | null;
      plane: LogPlane | null;
    }
  | { ok: false; response: Response }
> {
  const requestedTenantKey =
    parseOptionalString(input.tenant_key) ??
    c.req.query('filter[tenant_key]') ??
    c.req.query('tenant_key') ??
    undefined;
  const tenantKeyFilter = await resolveTenantKeyFilter(c, requestedTenantKey);
  if (!tenantKeyFilter.ok) {
    return tenantKeyFilter;
  }

  const logTypeRaw =
    parseOptionalString(input.log_type) ??
    c.req.query('filter[log_type]') ??
    c.req.query('log_type');
  const planeRaw =
    parseOptionalString(input.plane) ?? c.req.query('filter[plane]') ?? c.req.query('plane');
  const logType = readLogType(logTypeRaw);
  const plane = readLogPlane(planeRaw);
  const errors = [
    logTypeRaw && !logType
      ? fieldError('log_type', 'invalid_value', 'Log type is not supported.')
      : null,
    planeRaw && !plane ? fieldError('plane', 'invalid_value', 'Log plane is not supported.') : null,
  ].filter((error): error is ReturnType<typeof fieldError> => error !== null);
  if (errors.length > 0) {
    return { ok: false, response: await createAdminFieldErrorResponse(c, errors) };
  }

  return {
    ok: true,
    tenantKey: tenantKeyFilter.tenantKey,
    logType,
    plane,
  };
}

function readDangerousRepairAction(value: unknown): DangerousLogCatalogRepairAction | null {
  return value === 'delete_object' ||
    value === 'purge_record_indexes' ||
    value === 'rewrite_manifest_lineage'
    ? value
    : null;
}

async function buildDangerousCatalogRepairPlanFromRequest(c: AdminContext): Promise<
  | {
      ok: true;
      action: DangerousLogCatalogRepairAction;
      plan: DangerousLogCatalogRepairPlan;
      object: LogObjectCatalogRow | null;
      manifest: LogChunkManifestRow | null;
      confirmation: string | null;
    }
  | { ok: false; response: Response }
> {
  const body = await parseJsonObject(c);
  const action = readDangerousRepairAction(body.action);
  const objectCatalogId = parseOptionalString(body.object_catalog_id);
  const manifestId = parseOptionalString(body.manifest_id);
  const manifestObjectKey = parseOptionalString(body.manifest_object_key);
  const confirmation = parseOptionalString(body.confirmation);

  if (!action) {
    return {
      ok: false,
      response: await createAdminFieldErrorResponse(c, [
        fieldError('action', 'invalid_value', 'Dangerous repair action is not supported.'),
      ]),
    };
  }

  const adapter = getAdminAdapter(c);
  if (action === 'delete_object' || action === 'purge_record_indexes') {
    if (!objectCatalogId) {
      return {
        ok: false,
        response: await createAdminFieldErrorResponse(c, [
          fieldError('object_catalog_id', 'required', 'Object catalog id is required.'),
        ]),
      };
    }

    const object = await adapter.queryOne<LogObjectCatalogRow>(
      `SELECT id, tenant_key, log_type, plane, object_key, object_kind, status,
              record_count, byte_count
       FROM log_object_catalog
       WHERE id = ?`,
      [objectCatalogId]
    );
    if (!object) {
      return {
        ok: false,
        response: await createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND),
      };
    }
    const accessError = await requireTenantKeyAccess(c, object.tenant_key);
    if (accessError) {
      return { ok: false, response: accessError };
    }

    return {
      ok: true,
      action,
      object,
      manifest: null,
      confirmation,
      plan: buildDangerousLogCatalogRepairPlan({
        action,
        tenantKey: object.tenant_key,
        logType: object.log_type,
        plane: object.plane,
        objectCatalogId: object.id,
        objectKey: object.object_key,
        affectedRecordCount: toInteger(object.record_count),
      }),
    };
  }

  if (!manifestId && !manifestObjectKey) {
    return {
      ok: false,
      response: await createAdminFieldErrorResponse(c, [
        fieldError('manifest_id', 'required', 'Manifest id or manifest object key is required.'),
      ]),
    };
  }

  const manifest = manifestId
    ? await adapter.queryOne<LogChunkManifestRow>(
        `SELECT id, tenant_key, log_type, plane, manifest_object_key, record_count, status
         FROM log_chunk_manifests
         WHERE id = ?`,
        [manifestId]
      )
    : await adapter.queryOne<LogChunkManifestRow>(
        `SELECT id, tenant_key, log_type, plane, manifest_object_key, record_count, status
         FROM log_chunk_manifests
         WHERE manifest_object_key = ?`,
        [manifestObjectKey]
      );
  if (!manifest) {
    return {
      ok: false,
      response: await createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND),
    };
  }
  const accessError = await requireTenantKeyAccess(c, manifest.tenant_key);
  if (accessError) {
    return { ok: false, response: accessError };
  }

  return {
    ok: true,
    action,
    object: null,
    manifest,
    confirmation,
    plan: buildDangerousLogCatalogRepairPlan({
      action,
      tenantKey: manifest.tenant_key,
      logType: manifest.log_type,
      plane: manifest.plane,
      manifestObjectKey: manifest.manifest_object_key,
      affectedRecordCount: toInteger(manifest.record_count),
    }),
  };
}

async function loadAdminLoggingCriticalPolicy(c: AdminContext) {
  return getAdminLoggingControlRepository(c).loadCriticalPolicy();
}

async function loadSensitiveDetailPolicy(c: AdminContext) {
  return getAdminLoggingControlRepository(c).loadSensitiveDetailPolicy();
}

interface LoggingPolicySnapshotDraftBody {
  scopeType: 'platform' | 'tenant';
  scopeId: string;
  expiresAt: number | null;
}

interface LoggingPolicySnapshotDiff {
  compared_to_snapshot_id: string | null;
  compared_to_version: number | null;
  assignment_added: number;
  assignment_removed: number;
  assignment_changed: number;
  fallback_added: number;
  fallback_removed: number;
  fallback_changed: number;
  destination_added: number;
  destination_removed: number;
  destination_changed: number;
}

function stablePolicyRow(value: unknown): string {
  return stableJson(value ?? null);
}

function rowIdentity(row: Record<string, unknown>, fallbackPrefix: string): string {
  if (typeof row.id === 'string' && row.id) {
    return row.id;
  }
  const parts = [
    row.tenant_id ?? row.scope_type ?? fallbackPrefix,
    row.scope_id ?? 'global',
    row.log_type ?? 'unknown',
    row.plane ?? 'unknown',
  ];
  return parts.map((part) => String(part)).join(':');
}

function diffPolicyRows(
  previousRows: unknown,
  nextRows: unknown,
  fallbackPrefix: string
): { added: number; removed: number; changed: number } {
  const previous = Array.isArray(previousRows)
    ? previousRows.filter((row): row is Record<string, unknown> => {
        return row !== null && typeof row === 'object' && !Array.isArray(row);
      })
    : [];
  const next = Array.isArray(nextRows)
    ? nextRows.filter((row): row is Record<string, unknown> => {
        return row !== null && typeof row === 'object' && !Array.isArray(row);
      })
    : [];
  const previousMap = new Map(
    previous.map((row) => [rowIdentity(row, fallbackPrefix), stablePolicyRow(row)])
  );
  const nextMap = new Map(
    next.map((row) => [rowIdentity(row, fallbackPrefix), stablePolicyRow(row)])
  );

  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const [key, value] of nextMap) {
    if (!previousMap.has(key)) {
      added += 1;
    } else if (previousMap.get(key) !== value) {
      changed += 1;
    }
  }
  for (const key of previousMap.keys()) {
    if (!nextMap.has(key)) {
      removed += 1;
    }
  }
  return { added, removed, changed };
}

function parseSnapshotPolicies(value: unknown): {
  assignments: unknown[];
  fallbacks: unknown[];
  destinations: unknown[];
} {
  const snapshot = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const policies =
    snapshot.policies && typeof snapshot.policies === 'object'
      ? (snapshot.policies as Record<string, unknown>)
      : {};
  return {
    assignments: Array.isArray(policies.assignments) ? policies.assignments : [],
    fallbacks: Array.isArray(policies.fallbacks) ? policies.fallbacks : [],
    destinations: Array.isArray(policies.destinations) ? policies.destinations : [],
  };
}

function buildPolicySnapshotDiff(input: {
  previous: unknown | null;
  previousSnapshotId: string | null;
  previousVersion: number | null;
  next: unknown;
}): LoggingPolicySnapshotDiff {
  const previous = parseSnapshotPolicies(input.previous);
  const next = parseSnapshotPolicies(input.next);
  const assignment = diffPolicyRows(previous.assignments, next.assignments, 'assignment');
  const fallback = diffPolicyRows(previous.fallbacks, next.fallbacks, 'fallback');
  const destination = diffPolicyRows(previous.destinations, next.destinations, 'destination');
  return {
    compared_to_snapshot_id: input.previousSnapshotId,
    compared_to_version: input.previousVersion,
    assignment_added: assignment.added,
    assignment_removed: assignment.removed,
    assignment_changed: assignment.changed,
    fallback_added: fallback.added,
    fallback_removed: fallback.removed,
    fallback_changed: fallback.changed,
    destination_added: destination.added,
    destination_removed: destination.removed,
    destination_changed: destination.changed,
  };
}

async function readPolicySnapshotDraftBody(
  c: AdminContext
): Promise<
  { ok: true; value: LoggingPolicySnapshotDraftBody } | { ok: false; response: Response }
> {
  const body = await parseJsonObject(c);
  const fields: ReturnType<typeof fieldError>[] = [];
  if (
    body.scope_type !== undefined &&
    body.scope_type !== 'platform' &&
    body.scope_type !== 'tenant'
  ) {
    fields.push(
      fieldError('scope_type', 'invalid_value', 'Scope type must be platform or tenant.')
    );
  }
  if (body.expires_at !== undefined && typeof body.expires_at !== 'number') {
    fields.push(fieldError('expires_at', 'invalid_type', 'Expires at must be a timestamp number.'));
  }
  if (fields.length > 0) {
    return { ok: false, response: await createAdminFieldErrorResponse(c, fields) };
  }

  const scopeType = body.scope_type === 'platform' ? 'platform' : 'tenant';
  if (scopeType === 'platform') {
    const platformError = await requirePlatformAuthority(c);
    if (platformError) {
      return { ok: false, response: platformError };
    }
  }
  const scopeId =
    typeof body.scope_id === 'string' && body.scope_id.trim()
      ? body.scope_id.trim()
      : scopeType === 'platform'
        ? 'global'
        : getTenantIdFromContext(c);
  if (
    scopeType === 'tenant' &&
    !hasPlatformAuthority(getAuth(c)) &&
    scopeId !== getTenantIdFromContext(c)
  ) {
    return {
      ok: false,
      response: await createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS),
    };
  }

  return {
    ok: true,
    value: {
      scopeType,
      scopeId,
      expiresAt: typeof body.expires_at === 'number' ? body.expires_at : null,
    },
  };
}

async function buildPolicySnapshotCandidate(
  c: AdminContext,
  input: LoggingPolicySnapshotDraftBody
) {
  const adapter = getAdminAdapter(c);
  const versionRow = await adapter.queryOne<{ next_version: number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
     FROM logging_policy_snapshots
     WHERE scope_type = ? AND scope_id = ?`,
    [input.scopeType, input.scopeId]
  );
  const version = Number(versionRow?.next_version ?? 1);
  const [assignments, fallbacks, destinations, previousRow] = await Promise.all([
    adapter.query<Record<string, unknown>>(
      `SELECT *
       FROM logging_destination_overrides
       WHERE tenant_id IS NULL OR tenant_id = ?
       ORDER BY log_type ASC, plane ASC, tenant_id ASC`,
      [input.scopeId]
    ),
    adapter.query<Record<string, unknown>>(
      `SELECT *
       FROM logging_fallback_policies
       WHERE scope_type = 'platform' OR (scope_type = ? AND scope_id = ?)
       ORDER BY scope_type ASC, log_type ASC, plane ASC`,
      [input.scopeType, input.scopeId]
    ),
    adapter.query<Record<string, unknown>>(
      `SELECT id, scope_type, scope_id, destination_kind, provider, name, display_name,
              lifecycle_status, health_status, provider_config, allowed_tenant_ids,
              allowed_log_types, allowed_planes, region, critical_allowed,
              default_fallback_eligible, retention_days, encryption_mode,
              version, updated_at
       FROM admin_destinations
       WHERE deleted_at IS NULL
       ORDER BY scope_type ASC, scope_id ASC, name ASC`,
      []
    ),
    adapter.queryOne<{
      id: string;
      version: number;
      snapshot_json: string | null;
    }>(
      `SELECT id, version, snapshot_json
       FROM logging_policy_snapshots
       WHERE scope_type = ? AND scope_id = ? AND status = 'published'
       ORDER BY version DESC
       LIMIT 1`,
      [input.scopeType, input.scopeId]
    ),
  ]);
  const sourceUpdatedAt = Math.max(
    0,
    ...assignments.map((row) => Number(row.updated_at ?? row.created_at ?? 0)),
    ...fallbacks.map((row) => Number(row.updated_at ?? row.created_at ?? 0)),
    ...destinations.map((row) => Number(row.updated_at ?? row.created_at ?? 0))
  );
  const snapshot = await createRuntimeLoggingPolicySnapshot({
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    version,
    sourceUpdatedAt,
    expiresAt: input.expiresAt,
    policies: {
      assignments,
      fallbacks,
      destinations,
    },
  });
  const previousSnapshot =
    previousRow?.snapshot_json && previousRow.snapshot_json.trim()
      ? JSON.parse(previousRow.snapshot_json)
      : null;
  const diff = buildPolicySnapshotDiff({
    previous: previousSnapshot,
    previousSnapshotId: previousRow?.id ?? null,
    previousVersion: previousRow?.version ?? null,
    next: snapshot,
  });
  return {
    snapshot,
    diff,
    assignments,
    fallbacks,
    destinations,
  };
}

destinationsRouter.get('/', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_LIST)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const scopeType = c.req.query('scope_type');
  const params: unknown[] = [];
  const conditions = ['deleted_at IS NULL'];
  if (scopeType === 'platform' || scopeType === 'tenant' || scopeType === 'shared') {
    conditions.push('scope_type = ?');
    params.push(scopeType);
  }
  if (!hasPlatformAuthority(authContext)) {
    const tenantId = getTenantIdFromContext(c);
    conditions.push(
      `(scope_type = 'shared'
        OR (scope_type = 'tenant' AND scope_id = ?)
        OR EXISTS (
          SELECT 1
          FROM storage_destination_assignments sda
          WHERE sda.destination_id = admin_destinations.id
            AND sda.enabled = 1
            AND (sda.tenant_id IS NULL OR sda.tenant_id = ?)
        ))`
    );
    params.push(tenantId, tenantId);
  }

  try {
    const adapter = getAdminAdapter(c);
    const items = await adapter.query<Record<string, unknown>>(
      `SELECT id, scope_type, scope_id, destination_kind, provider, name, display_name,
              description, lifecycle_status, health_status, allowed_tenant_ids,
              allowed_log_types, allowed_planes, region, critical_allowed,
              default_fallback_eligible, retention_days, encryption_mode,
              last_health_check_at, version, created_at, updated_at
       FROM admin_destinations
       WHERE ${conditions.join(' AND ')}
       ORDER BY scope_type ASC, name ASC
       LIMIT ?`,
      [...params, parseLimit(c)]
    );
    const visibleItems = (
      hasPlatformAuthority(authContext)
        ? items
        : items.map((item) => hideDestinationTenantAllowlist(item))
    ).map((item) => withDestinationRuntimeSupport(item));
    return c.json(adminListEnvelope(visibleItems));
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

destinationsRouter.post('/provider-preview', async (c) => {
  const authContext = getAuth(c);
  if (
    !hasAnyPermission(authContext, [
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREATE,
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_UPDATE,
    ])
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatformAuthority(c);
  if (platformError) {
    return platformError;
  }

  const body = await parseJsonObject(c);
  const provider =
    typeof body.provider === 'string' &&
    DESTINATION_PROVIDERS.includes(body.provider as DestinationProvider)
      ? (body.provider as DestinationProvider)
      : null;
  if (!provider) {
    return createAdminFieldErrorResponse(c, [
      fieldError('provider', 'invalid_value', 'Provider is not supported.'),
    ]);
  }

  const item = buildDestinationProviderPayloadPreview({
    provider,
    providerConfig: parseProviderConfig(body.provider_config),
    capabilities: body.capabilities,
  });
  return c.json(adminDetailEnvelope(item));
});

destinationsRouter.post('/', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREATE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatformAuthority(c);
  if (platformError) {
    return platformError;
  }

  const parsed = await readDestinationBody(c, 'create');
  if (!parsed.ok) {
    return parsed.response;
  }

  try {
    const adapter = getAdminAdapter(c);
    const now = Date.now();
    const id = createLoggingId('dest', now);
    const value = parsed.value;
    await adapter.execute(
      `INSERT INTO admin_destinations (
        id, scope_type, scope_id, destination_kind, provider, name, display_name, description,
        lifecycle_status, health_status, provider_config, allowed_tenant_ids, allowed_log_types,
        allowed_planes, region, critical_allowed, default_fallback_eligible, retention_days,
        encryption_mode, created_by, updated_by, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        value.scopeType,
        value.scopeId,
        value.destinationKind,
        value.provider,
        value.name,
        value.displayName,
        value.description,
        'active',
        'configured',
        JSON.stringify(value.providerConfig),
        jsonArrayOrNull(value.allowedTenantIds),
        jsonArrayOrNull(value.allowedLogTypes),
        jsonArrayOrNull(value.allowedPlanes),
        value.region,
        value.criticalAllowed ? 1 : 0,
        value.defaultFallbackEligible ? 1 : 0,
        value.retentionDays,
        value.encryptionMode,
        authContext.userId,
        authContext.userId,
        now,
        now,
        1,
      ]
    );
    await replaceDestinationCapabilities(adapter, id, value.capabilities, now);
    await replaceStorageDestinationAssignments(adapter, {
      destinationId: id,
      tenantIds: value.allowedTenantIds,
      logTypes: value.allowedLogTypes,
      planes: value.allowedPlanes,
      actorId: authContext.userId,
      now,
    });
    const auditId = await writeAdminAuditLog(c, {
      action: 'storage_destination.create',
      resourceType: 'admin_destination',
      resourceId: id,
      result: 'success',
      severity: value.criticalAllowed ? 'warn' : 'info',
      after: {
        id,
        scope_type: value.scopeType,
        scope_id: value.scopeId,
        provider: value.provider,
        name: value.name,
        allowed_tenant_ids: value.allowedTenantIds,
        allowed_log_types: value.allowedLogTypes,
        allowed_planes: value.allowedPlanes,
        critical_allowed: value.criticalAllowed,
      },
    });

    return c.json(
      adminMutationEnvelope(
        {
          id,
          scope_type: value.scopeType,
          scope_id: value.scopeId,
          destination_kind: value.destinationKind,
          provider: value.provider,
          ...getDestinationRuntimeSupport(value.provider),
          name: value.name,
          display_name: value.displayName,
          lifecycle_status: 'active',
          health_status: 'configured',
          version: 1,
        },
        { auditId }
      ),
      201
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

destinationsRouter.get('/:id', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const adapter = getAdminAdapter(c);
    const id = c.req.param('id');
    const destination = await adapter.queryOne<AdminDestinationRow>(
      `SELECT id, scope_type, scope_id, destination_kind, provider, name, display_name,
              description, lifecycle_status, health_status, rotation_status, provider_config,
              credential_ref, credential_version, next_credential_ref, next_credential_version,
              previous_credential_ref, previous_credential_retire_after,
              allowed_tenant_ids, allowed_log_types, allowed_planes, region, critical_allowed,
              default_fallback_eligible, retention_days, encryption_mode,
              last_health_check_at, version
       FROM admin_destinations
       WHERE id = ? AND deleted_at IS NULL`,
      [id]
    );
    if (!destination) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const platform = hasPlatformAuthority(authContext);
    if (
      !platform &&
      !(await canTenantReadDestination(adapter, destination, getTenantIdFromContext(c)))
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const capabilities = await adapter.query<Record<string, unknown>>(
      `SELECT capability, source, enabled, created_at, updated_at
       FROM admin_destination_capabilities
       WHERE destination_id = ?
       ORDER BY capability ASC`,
      [destination.id]
    );
    const item: Record<string, unknown> = {
      id: destination.id,
      scope_type: destination.scope_type,
      scope_id: destination.scope_id,
      destination_kind: destination.destination_kind,
      provider: destination.provider,
      ...getDestinationRuntimeSupport(destination.provider),
      name: destination.name,
      display_name: destination.display_name,
      description: destination.description,
      lifecycle_status: destination.lifecycle_status,
      health_status: destination.health_status,
      allowed_tenant_ids: destination.allowed_tenant_ids,
      allowed_log_types: destination.allowed_log_types,
      allowed_planes: destination.allowed_planes,
      region: destination.region,
      critical_allowed: destination.critical_allowed,
      default_fallback_eligible: destination.default_fallback_eligible,
      retention_days: destination.retention_days,
      encryption_mode: destination.encryption_mode,
      last_health_check_at: destination.last_health_check_at,
      version: destination.version,
      capabilities,
    };
    if (!platform) {
      delete item.allowed_tenant_ids;
    }
    if (platform) {
      item.rotation_status = destination.rotation_status;
      item.provider_config = parseDestinationProviderConfig(destination.provider_config);
      item.credential_ref = destination.credential_ref;
      item.credential_version = destination.credential_version;
      item.next_credential_ref = destination.next_credential_ref;
      item.next_credential_version = destination.next_credential_version;
      item.previous_credential_ref = destination.previous_credential_ref;
      item.previous_credential_retire_after = destination.previous_credential_retire_after;
    }

    c.header('ETag', versionEtag(destination.version));
    return c.json(adminDetailEnvelope(item));
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

destinationsRouter.post('/:id/diff-preview', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_UPDATE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatformAuthority(c);
  if (platformError) {
    return platformError;
  }

  const parsed = await readDestinationBody(c, 'update');
  if (!parsed.ok) {
    return parsed.response;
  }

  try {
    const adapter = getAdminAdapter(c);
    const id = c.req.param('id');
    const current = await adapter.queryOne<AdminDestinationRow>(
      `SELECT id, scope_type, scope_id, destination_kind, provider, name, display_name,
              description, lifecycle_status, health_status, provider_config, allowed_tenant_ids,
              allowed_log_types, allowed_planes, region, critical_allowed,
              default_fallback_eligible, retention_days, encryption_mode,
              last_health_check_at, version
       FROM admin_destinations
       WHERE id = ? AND deleted_at IS NULL`,
      [id]
    );
    if (!current) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const value = parsed.value;
    const currentCapabilities = await adapter.query<{ capability: string }>(
      `SELECT capability
       FROM admin_destination_capabilities
       WHERE destination_id = ? AND enabled = 1
       ORDER BY capability ASC`,
      [id]
    );
    const affected = await adapter.queryOne<Record<string, number | string>>(
      `SELECT
        (SELECT COUNT(*) FROM storage_destination_assignments
          WHERE destination_id = ? AND enabled = 1) AS assignment_count,
        (SELECT COUNT(*) FROM logging_destination_overrides
          WHERE destination_id = ? AND enabled = 1) AS logging_override_count,
        (SELECT COUNT(*) FROM logging_fallback_policies
          WHERE fallback_destination_id = ?) AS fallback_policy_count,
        (SELECT COUNT(*) FROM admin_logging_critical_policies
          WHERE destination_id = ? AND status = 'active') AS critical_policy_count,
        (SELECT COUNT(*) FROM admin_logging_sensitive_detail_policies
          WHERE destination_id = ? AND status = 'active') AS sensitive_detail_policy_count`,
      [id, id, id, id, id]
    );
    const diff = [
      destinationDiffEntry('scope_type', current.scope_type, value.scopeType),
      destinationDiffEntry('scope_id', current.scope_id, value.scopeId),
      destinationDiffEntry('provider', current.provider, value.provider),
      destinationDiffEntry(
        'provider_config',
        parseDestinationProviderConfig(current.provider_config),
        value.providerConfig
      ),
      destinationDiffEntry('name', current.name, value.name),
      destinationDiffEntry('display_name', current.display_name, value.displayName),
      destinationDiffEntry('description', current.description, value.description),
      destinationDiffEntry(
        'allowed_tenant_ids',
        parseDestinationJsonArrayForDiff(current.allowed_tenant_ids),
        value.allowedTenantIds
      ),
      destinationDiffEntry(
        'allowed_log_types',
        parseDestinationJsonArrayForDiff(current.allowed_log_types),
        value.allowedLogTypes
      ),
      destinationDiffEntry(
        'allowed_planes',
        parseDestinationJsonArrayForDiff(current.allowed_planes),
        value.allowedPlanes
      ),
      destinationDiffEntry('region', current.region, value.region),
      destinationDiffEntry(
        'critical_allowed',
        current.critical_allowed === 1,
        value.criticalAllowed
      ),
      destinationDiffEntry(
        'default_fallback_eligible',
        current.default_fallback_eligible === 1,
        value.defaultFallbackEligible
      ),
      destinationDiffEntry('retention_days', current.retention_days, value.retentionDays),
      destinationDiffEntry('encryption_mode', current.encryption_mode, value.encryptionMode),
      destinationDiffEntry(
        'capabilities',
        currentCapabilities.map((row) => row.capability),
        value.capabilities
      ),
    ].filter((entry) => entry.changed);
    const classification = classifyDestinationDiffDanger({ current, next: value });
    const confirmation =
      classification.level === 'dangerous' ? `CONFIRM DESTINATION CHANGE ${current.name}` : null;

    return c.json(
      adminDetailEnvelope({
        destination_id: current.id,
        current_version: current.version,
        expected_version: value.expectedVersion,
        changed: diff.length > 0,
        diff,
        dangerous_classification: classification.level,
        dangerous_reasons: classification.reasons,
        affected_assignments: {
          storage_destination_assignments: toInteger(affected?.assignment_count),
          logging_destination_overrides: toInteger(affected?.logging_override_count),
          logging_fallback_policies: toInteger(affected?.fallback_policy_count),
          admin_logging_critical_policies: toInteger(affected?.critical_policy_count),
          admin_logging_sensitive_detail_policies: toInteger(
            affected?.sensitive_detail_policy_count
          ),
        },
        confirmation,
        previewed_at: Date.now(),
      })
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

destinationsRouter.patch('/:id', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_UPDATE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatformAuthority(c);
  if (platformError) {
    return platformError;
  }

  const parsed = await readDestinationBody(c, 'update');
  if (!parsed.ok) {
    return parsed.response;
  }

  try {
    const adapter = getAdminAdapter(c);
    const id = c.req.param('id');
    const current = await adapter.queryOne<AdminDestinationRow>(
      `SELECT id, scope_type, scope_id, destination_kind, provider, name, display_name,
              description, lifecycle_status, health_status, provider_config, allowed_tenant_ids,
              allowed_log_types, allowed_planes, region, critical_allowed,
              default_fallback_eligible, retention_days, encryption_mode,
              last_health_check_at, version
       FROM admin_destinations
       WHERE id = ? AND deleted_at IS NULL`,
      [id]
    );
    if (!current) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (parsed.value.expectedVersion && parsed.value.expectedVersion !== current.version) {
      return createAdminErrorResponseWithDetails(c, AR_ERROR_CODES.ADMIN_CONFLICT, {
        conflict: {
          expected_version: parsed.value.expectedVersion,
          actual_version: current.version,
        },
      });
    }

    const now = Date.now();
    const value = parsed.value;
    await adapter.execute(
      `UPDATE admin_destinations
       SET scope_type = ?, scope_id = ?, destination_kind = ?, provider = ?, name = ?,
           display_name = ?, description = ?, provider_config = ?, allowed_tenant_ids = ?,
           allowed_log_types = ?, allowed_planes = ?, region = ?, critical_allowed = ?,
           default_fallback_eligible = ?, retention_days = ?, encryption_mode = ?,
           updated_by = ?, updated_at = ?, version = version + 1
       WHERE id = ? AND deleted_at IS NULL`,
      [
        value.scopeType,
        value.scopeId,
        value.destinationKind,
        value.provider,
        value.name,
        value.displayName,
        value.description,
        JSON.stringify(value.providerConfig),
        jsonArrayOrNull(value.allowedTenantIds),
        jsonArrayOrNull(value.allowedLogTypes),
        jsonArrayOrNull(value.allowedPlanes),
        value.region,
        value.criticalAllowed ? 1 : 0,
        value.defaultFallbackEligible ? 1 : 0,
        value.retentionDays,
        value.encryptionMode,
        authContext.userId,
        now,
        id,
      ]
    );
    await replaceDestinationCapabilities(adapter, id, value.capabilities, now);
    await replaceStorageDestinationAssignments(adapter, {
      destinationId: id,
      tenantIds: value.allowedTenantIds,
      logTypes: value.allowedLogTypes,
      planes: value.allowedPlanes,
      actorId: authContext.userId,
      now,
    });
    const auditId = await writeAdminAuditLog(c, {
      action: 'storage_destination.update',
      resourceType: 'admin_destination',
      resourceId: id,
      result: 'success',
      severity: value.criticalAllowed || current.critical_allowed === 1 ? 'warn' : 'info',
      before: {
        id: current.id,
        scope_type: current.scope_type,
        scope_id: current.scope_id,
        provider: current.provider,
        name: current.name,
        version: current.version,
      },
      after: {
        id,
        scope_type: value.scopeType,
        scope_id: value.scopeId,
        provider: value.provider,
        name: value.name,
        version: current.version + 1,
      },
    });

    return c.json(
      adminMutationEnvelope(
        {
          id,
          version: current.version + 1,
          updated_at: now,
        },
        { auditId }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

destinationsRouter.delete('/:id', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_DELETE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatformAuthority(c);
  if (platformError) {
    return platformError;
  }

  try {
    const adapter = getAdminAdapter(c);
    const id = c.req.param('id');
    const current = await adapter.queryOne<AdminDestinationRow>(
      `SELECT id, scope_type, scope_id, destination_kind, provider, name, display_name,
              description, lifecycle_status, health_status, provider_config, allowed_tenant_ids,
              allowed_log_types, allowed_planes, region, critical_allowed,
              default_fallback_eligible, retention_days, encryption_mode,
              last_health_check_at, version
       FROM admin_destinations
       WHERE id = ? AND deleted_at IS NULL`,
      [id]
    );
    if (!current) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const body = await parseJsonObject(c);
    const expectedConfirmation = `DELETE DESTINATION ${current.name}`;
    if (body.confirmation !== expectedConfirmation) {
      return createAdminFieldErrorResponse(c, [
        fieldError(
          'confirmation',
          'confirmation_mismatch',
          `Confirmation must be "${expectedConfirmation}".`
        ),
      ]);
    }

    const expectedVersion =
      body.expected_version === undefined || body.expected_version === null
        ? null
        : Number.parseInt(String(body.expected_version), 10);
    if (expectedVersion && expectedVersion !== current.version) {
      return createAdminErrorResponseWithDetails(c, AR_ERROR_CODES.ADMIN_CONFLICT, {
        conflict: {
          expected_version: expectedVersion,
          actual_version: current.version,
        },
      });
    }

    const now = Date.now();
    await adapter.execute(
      `UPDATE admin_destinations
       SET lifecycle_status = 'deleted', deleted_at = ?, updated_by = ?,
           updated_at = ?, version = version + 1
       WHERE id = ? AND deleted_at IS NULL`,
      [now, authContext.userId, now, id]
    );
    await adapter.execute('DELETE FROM admin_destination_capabilities WHERE destination_id = ?', [
      id,
    ]);
    const auditId = await writeAdminAuditLog(c, {
      action: 'storage_destination.delete',
      resourceType: 'admin_destination',
      resourceId: id,
      result: 'success',
      severity: current.critical_allowed === 1 ? 'critical' : 'warn',
      before: {
        id: current.id,
        scope_type: current.scope_type,
        scope_id: current.scope_id,
        provider: current.provider,
        name: current.name,
        version: current.version,
      },
      after: {
        id,
        lifecycle_status: 'deleted',
        version: current.version + 1,
      },
    });

    return c.json(
      adminMutationEnvelope(
        {
          id,
          lifecycle_status: 'deleted',
          deleted_at: now,
          version: current.version + 1,
        },
        { auditId }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

destinationsRouter.post('/:id/disable', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_UPDATE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatformAuthority(c);
  if (platformError) {
    return platformError;
  }

  try {
    const adapter = getAdminAdapter(c);
    const id = c.req.param('id');
    const destination = await getDestinationForCredentialMutation(c, id);
    if (!destination) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const body = await parseJsonObject(c);
    const confirmation = `FORCE DISABLE ${destination.name}`;
    if (body.confirmation !== confirmation) {
      return createAdminFieldErrorResponse(c, [
        fieldError(
          'confirmation',
          'confirmation_mismatch',
          `Confirmation must be "${confirmation}".`
        ),
      ]);
    }

    const now = Date.now();
    await adapter.execute(
      `UPDATE admin_destinations
       SET lifecycle_status = 'disabled', updated_by = ?, updated_at = ?,
           version = version + 1
       WHERE id = ? AND deleted_at IS NULL`,
      [authContext.userId, now, destination.id]
    );
    const auditId = await writeAdminAuditLog(c, {
      action: 'storage_destination.force_disable',
      resourceType: 'admin_destination',
      resourceId: destination.id,
      result: 'success',
      severity: destination.critical_allowed === 1 ? 'critical' : 'warn',
      before: {
        id: destination.id,
        lifecycle_status: destination.lifecycle_status,
        health_status: destination.health_status,
        version: destination.version,
      },
      after: {
        id: destination.id,
        lifecycle_status: 'disabled',
        version: destination.version + 1,
      },
    });

    return c.json(
      adminMutationEnvelope(
        {
          id: destination.id,
          lifecycle_status: 'disabled',
          version: destination.version + 1,
          updated_at: now,
        },
        { auditId }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

destinationsRouter.post('/:id/enable', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_UPDATE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatformAuthority(c);
  if (platformError) {
    return platformError;
  }

  try {
    const adapter = getAdminAdapter(c);
    const id = c.req.param('id');
    const destination = await getDestinationForCredentialMutation(c, id);
    if (!destination) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const now = Date.now();
    await adapter.execute(
      `UPDATE admin_destinations
       SET lifecycle_status = 'active', updated_by = ?, updated_at = ?,
           version = version + 1
       WHERE id = ? AND deleted_at IS NULL`,
      [authContext.userId, now, destination.id]
    );
    const auditId = await writeAdminAuditLog(c, {
      action: 'storage_destination.enable',
      resourceType: 'admin_destination',
      resourceId: destination.id,
      result: 'success',
      severity: 'warn',
      before: {
        id: destination.id,
        lifecycle_status: destination.lifecycle_status,
        version: destination.version,
      },
      after: {
        id: destination.id,
        lifecycle_status: 'active',
        version: destination.version + 1,
      },
    });

    return c.json(
      adminMutationEnvelope(
        {
          id: destination.id,
          lifecycle_status: 'active',
          version: destination.version + 1,
          updated_at: now,
        },
        { auditId }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

destinationsRouter.post('/:id/credentials/prepare', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREDENTIALS_WRITE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatformAuthority(c);
  if (platformError) {
    return platformError;
  }

  const parsed = await readCredentialPrepareBody(c);
  if (!parsed.ok) {
    return parsed.response;
  }

  try {
    const adapter = getAdminAdapter(c);
    const id = c.req.param('id');
    const destination = await getDestinationForCredentialMutation(c, id);
    if (!destination) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const backendSelection = getCredentialSecretBackend(c, parsed.value.backendKind);
    if (!backendSelection) {
      return createAdminFieldErrorResponse(c, [
        fieldError(
          'backend',
          'backend_unavailable',
          'Credential secret backend is not configured.'
        ),
      ]);
    }

    const now = Date.now();
    const nextVersion =
      Math.max(destination.credential_version ?? 0, destination.next_credential_version ?? 0) + 1;
    const nextCredentialRef = await backendSelection.backend.rotateSecret({
      destinationId: destination.id,
      nextVersion,
      nextPlaintext: parsed.value.plaintext,
      metadata: {
        status: 'next',
        contentType: parsed.value.contentType,
        rotatedAt: now,
        labels: {
          provider: destination.provider,
          destination_name: destination.name,
        },
      },
    });
    const nextState = prepareCredentialRotation(
      {
        credentialRef: destination.credential_ref,
        credentialVersion: destination.credential_version,
        nextCredentialRef: destination.next_credential_ref,
        nextCredentialVersion: destination.next_credential_version,
        previousCredentialRef: destination.previous_credential_ref,
        previousCredentialRetireAfter: destination.previous_credential_retire_after,
        rotationStatus: destination.rotation_status as never,
      },
      {
        credentialRef: nextCredentialRef,
        credentialVersion: nextVersion,
      }
    );

    await adapter.execute(
      `UPDATE admin_destinations
       SET next_credential_ref = ?, next_credential_version = ?,
           rotation_status = ?, updated_by = ?, updated_at = ?,
           version = version + 1
       WHERE id = ? AND deleted_at IS NULL`,
      [
        nextState.nextCredentialRef,
        nextState.nextCredentialVersion,
        nextState.rotationStatus,
        authContext.userId,
        now,
        destination.id,
      ]
    );
    const auditId = await writeAdminAuditLog(c, {
      action: 'storage_destination.credentials.prepare',
      resourceType: 'admin_destination',
      resourceId: destination.id,
      result: 'success',
      severity: 'warn',
      metadata: {
        destination_id: destination.id,
        provider: destination.provider,
        backend: backendSelection.backendKind,
        next_credential_ref: nextCredentialRef,
        next_credential_version: nextVersion,
        rotation_status: nextState.rotationStatus,
      },
    });

    return c.json(
      adminMutationEnvelope(
        {
          id: destination.id,
          rotation_status: nextState.rotationStatus,
          next_credential_ref: nextCredentialRef,
          next_credential_version: nextVersion,
          version: destination.version + 1,
          updated_at: now,
        },
        { auditId }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

destinationsRouter.post('/:id/credentials/ready', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREDENTIALS_WRITE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatformAuthority(c);
  if (platformError) {
    return platformError;
  }

  try {
    const adapter = getAdminAdapter(c);
    const id = c.req.param('id');
    const destination = await getDestinationForCredentialMutation(c, id);
    if (!destination) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const nextState = markCredentialRotationReady({
      credentialRef: destination.credential_ref,
      credentialVersion: destination.credential_version,
      nextCredentialRef: destination.next_credential_ref,
      nextCredentialVersion: destination.next_credential_version,
      previousCredentialRef: destination.previous_credential_ref,
      previousCredentialRetireAfter: destination.previous_credential_retire_after,
      rotationStatus: destination.rotation_status as never,
    });
    const now = Date.now();
    await adapter.execute(
      `UPDATE admin_destinations
       SET rotation_status = ?, updated_by = ?, updated_at = ?, version = version + 1
       WHERE id = ? AND deleted_at IS NULL`,
      [nextState.rotationStatus, authContext.userId, now, destination.id]
    );
    const auditId = await writeAdminAuditLog(c, {
      action: 'storage_destination.credentials.ready',
      resourceType: 'admin_destination',
      resourceId: destination.id,
      result: nextState.rotationStatus === 'ready' ? 'success' : 'failure',
      severity: 'warn',
      metadata: {
        destination_id: destination.id,
        next_credential_ref: destination.next_credential_ref,
        next_credential_version: destination.next_credential_version,
        rotation_status: nextState.rotationStatus,
      },
    });

    return c.json(
      adminMutationEnvelope(
        {
          id: destination.id,
          rotation_status: nextState.rotationStatus,
          next_credential_ref: destination.next_credential_ref,
          next_credential_version: destination.next_credential_version,
          version: destination.version + 1,
          updated_at: now,
        },
        { auditId }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

destinationsRouter.post('/:id/credentials/activate', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREDENTIALS_WRITE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatformAuthority(c);
  if (platformError) {
    return platformError;
  }

  try {
    const adapter = getAdminAdapter(c);
    const id = c.req.param('id');
    const destination = await getDestinationForCredentialMutation(c, id);
    if (!destination) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const body = await parseJsonObject(c);
    const confirmation = `ACTIVATE CREDENTIAL ${destination.name}`;
    if (body.confirmation !== confirmation) {
      return createAdminFieldErrorResponse(c, [
        fieldError(
          'confirmation',
          'confirmation_mismatch',
          `Confirmation must be "${confirmation}".`
        ),
      ]);
    }
    const overlapMs =
      typeof body.overlap_ms === 'number' && body.overlap_ms >= 0
        ? Math.min(body.overlap_ms, 30 * 24 * 60 * 60 * 1000)
        : 24 * 60 * 60 * 1000;
    const now = Date.now();
    const result = activateCredentialRotation(
      {
        credentialRef: destination.credential_ref,
        credentialVersion: destination.credential_version,
        nextCredentialRef: destination.next_credential_ref,
        nextCredentialVersion: destination.next_credential_version,
        previousCredentialRef: destination.previous_credential_ref,
        previousCredentialRetireAfter: destination.previous_credential_retire_after,
        rotationStatus: destination.rotation_status as never,
      },
      { now, overlapMs }
    );
    await adapter.execute(
      `UPDATE admin_destinations
       SET credential_ref = ?, credential_version = ?, next_credential_ref = NULL,
           next_credential_version = NULL, previous_credential_ref = ?,
           previous_credential_retire_after = ?, rotation_status = ?,
           updated_by = ?, updated_at = ?, version = version + 1
       WHERE id = ? AND deleted_at IS NULL`,
      [
        result.state.credentialRef,
        result.state.credentialVersion,
        result.state.previousCredentialRef,
        result.state.previousCredentialRetireAfter,
        result.state.rotationStatus,
        authContext.userId,
        now,
        destination.id,
      ]
    );
    const auditId = await writeAdminAuditLog(c, {
      action: 'storage_destination.credentials.activate',
      resourceType: 'admin_destination',
      resourceId: destination.id,
      result: result.state.rotationStatus === 'failed' ? 'failure' : 'success',
      severity: 'critical',
      metadata: {
        destination_id: destination.id,
        credential_ref: result.state.credentialRef,
        credential_version: result.state.credentialVersion,
        previous_credential_ref: result.state.previousCredentialRef,
        previous_credential_retire_after: result.state.previousCredentialRetireAfter,
        rotation_status: result.state.rotationStatus,
      },
    });

    return c.json(
      adminMutationEnvelope(
        {
          id: destination.id,
          credential_ref: result.state.credentialRef,
          credential_version: result.state.credentialVersion,
          previous_credential_ref: result.state.previousCredentialRef,
          previous_credential_retire_after: result.state.previousCredentialRetireAfter,
          rotation_status: result.state.rotationStatus,
          version: destination.version + 1,
          updated_at: now,
        },
        { auditId }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

destinationsRouter.post('/:id/credentials/retire-previous', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREDENTIALS_WRITE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatformAuthority(c);
  if (platformError) {
    return platformError;
  }

  try {
    const adapter = getAdminAdapter(c);
    const id = c.req.param('id');
    const destination = await getDestinationForCredentialMutation(c, id);
    if (!destination) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (!destination.previous_credential_ref) {
      return createAdminFieldErrorResponse(c, [
        fieldError(
          'previous_credential_ref',
          'invalid_state',
          'No previous credential is waiting for retirement.'
        ),
      ]);
    }

    const body = await parseJsonObject(c);
    const now = Date.now();
    const retireAfter = destination.previous_credential_retire_after ?? 0;
    const force = retireAfter > now;
    const confirmation = `RETIRE CREDENTIAL ${destination.name}`;
    if (force && body.confirmation !== confirmation) {
      return createAdminFieldErrorResponse(c, [
        fieldError(
          'confirmation',
          'confirmation_mismatch',
          `Confirmation must be "${confirmation}".`
        ),
      ]);
    }

    const backendKind = credentialBackendKindFromRef(destination.previous_credential_ref);
    const backendSelection = backendKind ? getCredentialSecretBackend(c, backendKind) : null;
    if (!backendSelection) {
      return createAdminFieldErrorResponse(c, [
        fieldError(
          'backend',
          'backend_unavailable',
          'Credential secret backend is not configured.'
        ),
      ]);
    }

    await backendSelection.backend.retireSecret(destination.previous_credential_ref);
    const nextState = force
      ? {
          credentialRef: destination.credential_ref,
          credentialVersion: destination.credential_version,
          nextCredentialRef: destination.next_credential_ref,
          nextCredentialVersion: destination.next_credential_version,
          previousCredentialRef: null,
          previousCredentialRetireAfter: null,
          rotationStatus: 'none' as const,
        }
      : finishCredentialRetirement(
          {
            credentialRef: destination.credential_ref,
            credentialVersion: destination.credential_version,
            nextCredentialRef: destination.next_credential_ref,
            nextCredentialVersion: destination.next_credential_version,
            previousCredentialRef: destination.previous_credential_ref,
            previousCredentialRetireAfter: destination.previous_credential_retire_after,
            rotationStatus: destination.rotation_status as never,
          },
          now
        );

    await adapter.execute(
      `UPDATE admin_destinations
       SET previous_credential_ref = ?, previous_credential_retire_after = ?,
           rotation_status = ?, updated_by = ?, updated_at = ?,
           version = version + 1
       WHERE id = ? AND deleted_at IS NULL`,
      [
        nextState.previousCredentialRef,
        nextState.previousCredentialRetireAfter,
        nextState.rotationStatus,
        authContext.userId,
        now,
        destination.id,
      ]
    );
    const auditId = await writeAdminAuditLog(c, {
      action: 'storage_destination.credentials.retire_previous',
      resourceType: 'admin_destination',
      resourceId: destination.id,
      result: 'success',
      severity: force ? 'critical' : 'warn',
      metadata: {
        destination_id: destination.id,
        retired_credential_ref: destination.previous_credential_ref,
        previous_credential_retire_after: destination.previous_credential_retire_after,
        forced: force,
        backend: backendSelection.backendKind,
        rotation_status: nextState.rotationStatus,
      },
    });

    return c.json(
      adminMutationEnvelope(
        {
          id: destination.id,
          previous_credential_ref: nextState.previousCredentialRef,
          previous_credential_retire_after: nextState.previousCredentialRetireAfter,
          rotation_status: nextState.rotationStatus,
          version: destination.version + 1,
          updated_at: now,
        },
        { auditId }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

destinationsRouter.post('/:id/health-check', async (c) => {
  const authContext = getAuth(c);
  if (
    !hasAnyPermission(authContext, [
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_HEALTH_CHECK,
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_TEST,
    ])
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatformAuthority(c);
  if (platformError) {
    return platformError;
  }

  const id = c.req.param('id');
  const body = await parseJsonObject(c);
  const checkType =
    body.check_type === 'deep' || body.check_type === 'adaptive' ? body.check_type : 'quick';

  try {
    const adapter = getAdminAdapter(c);
    const destination = await adapter.queryOne<AdminDestinationRow>(
      `SELECT id, scope_type, scope_id, destination_kind, provider, name, display_name,
              lifecycle_status, health_status, provider_config, last_health_check_at
       FROM admin_destinations
       WHERE id = ? AND deleted_at IS NULL`,
      [id]
    );
    if (!destination) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const checkedAt = Date.now();
    const result = await runDestinationHealthCheck(c.env, destination, checkType);
    await adapter.execute(
      `INSERT INTO admin_destination_health_events (
        id, destination_id, check_type, previous_health_status, next_health_status,
        result, error_class, latency_ms, checked_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        createLoggingId('dhe', checkedAt),
        destination.id,
        result.check_type,
        result.previous_health_status,
        result.next_health_status,
        result.result,
        result.error_class,
        result.latency_ms,
        checkedAt,
        JSON.stringify(result.metadata),
      ]
    );
    await adapter.execute(
      `UPDATE admin_destinations
       SET health_status = ?, last_health_check_at = ?, updated_at = ?
       WHERE id = ?`,
      [result.next_health_status, checkedAt, checkedAt, destination.id]
    );
    await enqueueDestinationHealthNotification(c, destination, result, checkedAt);
    const auditId = await writeAdminAuditLog(c, {
      action: 'storage_destination.health_check',
      resourceType: 'admin_destination',
      resourceId: destination.id,
      result: result.result === 'success' ? 'success' : 'failure',
      severity: result.result === 'success' ? 'info' : 'warn',
      metadata: {
        destination_id: destination.id,
        scope_type: destination.scope_type,
        scope_id: destination.scope_id,
        check_type: result.check_type,
        previous_health_status: result.previous_health_status,
        next_health_status: result.next_health_status,
        error_class: result.error_class,
        latency_ms: result.latency_ms,
      },
    });

    return c.json(
      adminMutationEnvelope(
        {
          destination_id: destination.id,
          checked_at: checkedAt,
          ...result,
        },
        { auditId }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

async function handleLoggingPolicyMatrix(c: AdminContext): Promise<Response> {
  const authContext = getAuth(c);
  if (
    !hasAnyPermission(authContext, [
      ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ,
      ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_READ,
      ADMIN_PERMISSIONS.LOGGING_TENANT_OVERRIDES_READ,
    ])
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const tenantIdFilter = await resolveTenantIdFilter(c, c.req.query('tenant_id') || undefined);
  if (!tenantIdFilter.ok) {
    return tenantIdFilter.response;
  }
  const tenantId = tenantIdFilter.tenantId ?? getTenantIdFromContext(c);

  try {
    const adapter = getAdminAdapter(c);
    const assignments = await adapter.query<Record<string, unknown>>(
      `SELECT lpa.*, ad.name AS destination_name, ad.provider AS destination_provider
       FROM logging_destination_overrides lpa
       LEFT JOIN admin_destinations ad ON ad.id = lpa.destination_id
       WHERE lpa.tenant_id IS NULL OR lpa.tenant_id = ?
       ORDER BY lpa.log_type ASC, lpa.plane ASC, lpa.tenant_id ASC
       LIMIT ?`,
      [tenantId, parseLimit(c)]
    );
    const fallbacks = await adapter.query<Record<string, unknown>>(
      `SELECT *
       FROM logging_fallback_policies
       WHERE scope_type = 'platform' OR (scope_type = 'tenant' AND scope_id = ?)
       ORDER BY scope_type ASC, log_type ASC, plane ASC
       LIMIT ?`,
      [tenantId, parseLimit(c)]
    );
    const snapshots = await adapter.query<Record<string, unknown>>(
      `SELECT id, scope_type, scope_id, version, status, policy_hash, object_ref,
              created_at, published_at
       FROM logging_policy_snapshots
       WHERE scope_type = 'platform' OR (scope_type = 'tenant' AND scope_id = ?)
       ORDER BY version DESC
       LIMIT ?`,
      [tenantId, Math.min(parseLimit(c), 25)]
    );
    const matrixVersion = Math.max(0, ...snapshots.map((row) => Number(row.version ?? 0)));
    if (matrixVersion > 0) {
      c.header('ETag', versionEtag(matrixVersion));
    }

    return c.json(
      adminDetailEnvelope({
        tenant_id: tenantId,
        version: matrixVersion,
        assignments,
        fallbacks,
        snapshots,
      })
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

loggingPoliciesRouter.get('/', handleLoggingPolicyMatrix);

loggingPoliciesRouter.get('/matrix', handleLoggingPolicyMatrix);

loggingPoliciesRouter.post('/assignments', async (c) => {
  const parsed = await readLoggingDestinationOverrideBody(c, 'create');
  if (!parsed.ok) {
    return parsed.response;
  }
  const permissionError = await requireLoggingPolicyMutationPermission(c, parsed.value);
  if (permissionError) {
    return permissionError;
  }

  try {
    const critical = isCriticalLoggingPolicy(parsed.value.logType, parsed.value.plane);
    const destinationResult = await requireDestinationForLoggingOverride(
      c,
      parsed.value.destinationId,
      parsed.value.tenantId,
      parsed.value.logType,
      parsed.value.plane,
      critical
    );
    if (!destinationResult.ok) {
      return destinationResult.response;
    }

    const adapter = getAdminAdapter(c);
    const authContext = getAuth(c);
    const now = Date.now();
    const id = createLoggingId('pol', now);
    const managedBy = parsed.value.tenantId && !critical ? 'tenant' : 'platform';
    const policyHash = await hashLoggingDestinationOverride({
      tenantId: parsed.value.tenantId,
      logType: parsed.value.logType,
      plane: parsed.value.plane,
      destinationId: parsed.value.destinationId,
      fallbackPolicyId: parsed.value.fallbackPolicyId,
      enabled: parsed.value.enabled,
      managedBy,
      changeProtection: parsed.value.changeProtection,
      approvalPolicyId: parsed.value.approvalPolicyId,
    });
    await adapter.execute(
      `INSERT INTO logging_destination_overrides (
	        id, tenant_id, log_type, plane, destination_id, fallback_policy_id,
	        enabled, managed_by, change_protection, approval_policy_id, policy_hash,
	        created_by, updated_by, created_at, updated_at, version
	      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        parsed.value.tenantId,
        parsed.value.logType,
        parsed.value.plane,
        parsed.value.destinationId,
        parsed.value.fallbackPolicyId,
        parsed.value.enabled ? 1 : 0,
        managedBy,
        parsed.value.changeProtection,
        parsed.value.approvalPolicyId,
        policyHash,
        authContext.userId,
        authContext.userId,
        now,
        now,
        1,
      ]
    );
    await insertLoggingDestinationOverrideHistory(adapter, {
      overrideId: id,
      previous: null,
      next: {
        tenant_id: parsed.value.tenantId,
        log_type: parsed.value.logType,
        plane: parsed.value.plane,
        destination_id: parsed.value.destinationId,
        fallback_policy_id: parsed.value.fallbackPolicyId,
        enabled: parsed.value.enabled ? 1 : 0,
        change_protection: parsed.value.changeProtection,
        approval_policy_id: parsed.value.approvalPolicyId,
        policy_hash: policyHash,
        version: 1,
      },
      changedBy: authContext.userId,
      changedAt: now,
      changeReason: 'create',
    });
    const auditId = await writeAdminAuditLog(c, {
      action: 'logging_destination_override.create',
      resourceType: 'logging_destination_override',
      resourceId: id,
      result: 'success',
      severity: critical ? 'warn' : 'info',
      after: {
        id,
        tenant_id: parsed.value.tenantId,
        log_type: parsed.value.logType,
        plane: parsed.value.plane,
        destination_id: parsed.value.destinationId,
        fallback_policy_id: parsed.value.fallbackPolicyId,
        enabled: parsed.value.enabled,
        managed_by: managedBy,
        change_protection: parsed.value.changeProtection,
        approval_policy_id: parsed.value.approvalPolicyId,
        policy_hash: policyHash,
      },
    });

    return c.json(
      adminMutationEnvelope(
        {
          id,
          tenant_id: parsed.value.tenantId,
          log_type: parsed.value.logType,
          plane: parsed.value.plane,
          destination_id: parsed.value.destinationId,
          fallback_policy_id: parsed.value.fallbackPolicyId,
          enabled: parsed.value.enabled ? 1 : 0,
          managed_by: managedBy,
          change_protection: parsed.value.changeProtection,
          approval_policy_id: parsed.value.approvalPolicyId,
          policy_hash: policyHash,
          version: 1,
          created_at: now,
          updated_at: now,
        },
        { auditId }
      ),
      201
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.post('/fallbacks', async (c) => {
  const parsed = await readLoggingFallbackPolicyBody(c, 'create');
  if (!parsed.ok) {
    return parsed.response;
  }
  const tenantId = parsed.value.scopeType === 'tenant' ? parsed.value.scopeId : null;
  const permissionError = await requireLoggingPolicyMutationPermission(c, {
    tenantId,
    logType: parsed.value.logType,
    plane: parsed.value.plane,
    confirmation: parsed.value.confirmation,
  });
  if (permissionError) {
    return permissionError;
  }

  try {
    const critical = isCriticalLoggingPolicy(parsed.value.logType, parsed.value.plane);
    if (parsed.value.fallbackDestinationId) {
      const destinationResult = await requireDestinationForLoggingOverride(
        c,
        parsed.value.fallbackDestinationId,
        tenantId,
        parsed.value.logType,
        parsed.value.plane,
        critical,
        'fallback_destination_id'
      );
      if (!destinationResult.ok) {
        return destinationResult.response;
      }
      if (destinationResult.destination.default_fallback_eligible !== 1) {
        return createAdminFieldErrorResponse(c, [
          fieldError(
            'fallback_destination_id',
            'fallback_not_allowed',
            'Destination is not approved as a fallback target.'
          ),
        ]);
      }
    }

    const adapter = getAdminAdapter(c);
    const now = Date.now();
    const id = createLoggingId('pol', now);
    await adapter.execute(
      `INSERT INTO logging_fallback_policies (
        id, scope_type, scope_id, log_type, plane, fallback_destination_id,
        failure_mode, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        parsed.value.scopeType,
        parsed.value.scopeId,
        parsed.value.logType,
        parsed.value.plane,
        parsed.value.fallbackDestinationId,
        parsed.value.failureMode,
        now,
        now,
        1,
      ]
    );
    const auditId = await writeAdminAuditLog(c, {
      action: 'logging_fallback_policy.create',
      resourceType: 'logging_fallback_policy',
      resourceId: id,
      result: 'success',
      severity: critical ? 'warn' : 'info',
      after: {
        id,
        scope_type: parsed.value.scopeType,
        scope_id: parsed.value.scopeId,
        log_type: parsed.value.logType,
        plane: parsed.value.plane,
        fallback_destination_id: parsed.value.fallbackDestinationId,
        failure_mode: parsed.value.failureMode,
      },
    });

    return c.json(
      adminMutationEnvelope(
        {
          id,
          scope_type: parsed.value.scopeType,
          scope_id: parsed.value.scopeId,
          log_type: parsed.value.logType,
          plane: parsed.value.plane,
          fallback_destination_id: parsed.value.fallbackDestinationId,
          failure_mode: parsed.value.failureMode,
          version: 1,
          created_at: now,
          updated_at: now,
        },
        { auditId }
      ),
      201
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.patch('/fallbacks/:fallback_id', async (c) => {
  const parsed = await readLoggingFallbackPolicyBody(c, 'update');
  if (!parsed.ok) {
    return parsed.response;
  }

  try {
    const adapter = getAdminAdapter(c);
    const fallbackId = c.req.param('fallback_id');
    const current = await adapter.queryOne<LoggingFallbackPolicyRow>(
      `SELECT id, scope_type, scope_id, log_type, plane, fallback_destination_id,
              failure_mode, created_at, updated_at, version
       FROM logging_fallback_policies
       WHERE id = ?`,
      [fallbackId]
    );
    if (!current) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const currentAccessError = await requireCurrentLoggingFallbackMutationAccess(c, current);
    if (currentAccessError) {
      return currentAccessError;
    }

    const tenantId = parsed.value.scopeType === 'tenant' ? parsed.value.scopeId : null;
    const permissionError = await requireLoggingPolicyMutationPermission(c, {
      tenantId,
      logType: parsed.value.logType,
      plane: parsed.value.plane,
      confirmation: parsed.value.confirmation,
    });
    if (permissionError) {
      return permissionError;
    }
    if (parsed.value.expectedVersion && parsed.value.expectedVersion !== current.version) {
      return createAdminErrorResponseWithDetails(c, AR_ERROR_CODES.ADMIN_CONFLICT, {
        conflict: {
          expected_version: parsed.value.expectedVersion,
          actual_version: current.version,
        },
      });
    }

    const critical = isCriticalLoggingPolicy(parsed.value.logType, parsed.value.plane);
    if (parsed.value.fallbackDestinationId) {
      const destinationResult = await requireDestinationForLoggingOverride(
        c,
        parsed.value.fallbackDestinationId,
        tenantId,
        parsed.value.logType,
        parsed.value.plane,
        critical,
        'fallback_destination_id'
      );
      if (!destinationResult.ok) {
        return destinationResult.response;
      }
      if (destinationResult.destination.default_fallback_eligible !== 1) {
        return createAdminFieldErrorResponse(c, [
          fieldError(
            'fallback_destination_id',
            'fallback_not_allowed',
            'Destination is not approved as a fallback target.'
          ),
        ]);
      }
    }

    const now = Date.now();
    await adapter.execute(
      `UPDATE logging_fallback_policies
       SET scope_type = ?, scope_id = ?, log_type = ?, plane = ?,
           fallback_destination_id = ?, failure_mode = ?, updated_at = ?,
           version = version + 1
       WHERE id = ?`,
      [
        parsed.value.scopeType,
        parsed.value.scopeId,
        parsed.value.logType,
        parsed.value.plane,
        parsed.value.fallbackDestinationId,
        parsed.value.failureMode,
        now,
        fallbackId,
      ]
    );
    const auditId = await writeAdminAuditLog(c, {
      action: 'logging_fallback_policy.update',
      resourceType: 'logging_fallback_policy',
      resourceId: fallbackId,
      result: 'success',
      severity: critical ? 'warn' : 'info',
      before: {
        id: current.id,
        scope_type: current.scope_type,
        scope_id: current.scope_id,
        log_type: current.log_type,
        plane: current.plane,
        fallback_destination_id: current.fallback_destination_id,
        failure_mode: current.failure_mode,
        version: current.version,
      },
      after: {
        id: fallbackId,
        scope_type: parsed.value.scopeType,
        scope_id: parsed.value.scopeId,
        log_type: parsed.value.logType,
        plane: parsed.value.plane,
        fallback_destination_id: parsed.value.fallbackDestinationId,
        failure_mode: parsed.value.failureMode,
        version: current.version + 1,
      },
    });

    return c.json(
      adminMutationEnvelope(
        {
          id: fallbackId,
          scope_type: parsed.value.scopeType,
          scope_id: parsed.value.scopeId,
          log_type: parsed.value.logType,
          plane: parsed.value.plane,
          fallback_destination_id: parsed.value.fallbackDestinationId,
          failure_mode: parsed.value.failureMode,
          version: current.version + 1,
          updated_at: now,
        },
        { auditId }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

async function handleLoggingDestinationOverridePatch(
  c: AdminContext,
  policyId: string
): Promise<Response> {
  const parsed = await readLoggingDestinationOverrideBody(c, 'update');
  if (!parsed.ok) {
    return parsed.response;
  }

  try {
    const adapter = getAdminAdapter(c);
    const current = await adapter.queryOne<LoggingDestinationOverrideRow>(
      `SELECT id, tenant_id, log_type, plane, destination_id, fallback_policy_id,
	              enabled, managed_by, change_protection, approval_policy_id, policy_hash,
	              created_by, updated_by, created_at, updated_at, version
	       FROM logging_destination_overrides
	       WHERE id = ?`,
      [policyId]
    );
    if (!current) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const currentAccessError = await requireCurrentLoggingOverrideMutationAccess(c, current);
    if (currentAccessError) {
      return currentAccessError;
    }

    const value = {
      ...parsed.value,
      tenantId: parsed.value.tenantId ?? current.tenant_id,
    };
    const permissionError = await requireLoggingPolicyMutationPermission(c, value);
    if (permissionError) {
      return permissionError;
    }
    if (value.expectedVersion && value.expectedVersion !== current.version) {
      return createAdminErrorResponseWithDetails(c, AR_ERROR_CODES.ADMIN_CONFLICT, {
        conflict: {
          expected_version: value.expectedVersion,
          actual_version: current.version,
        },
      });
    }

    const critical = isCriticalLoggingPolicy(value.logType, value.plane);
    const destinationResult = await requireDestinationForLoggingOverride(
      c,
      value.destinationId,
      value.tenantId,
      value.logType,
      value.plane,
      critical
    );
    if (!destinationResult.ok) {
      return destinationResult.response;
    }

    const authContext = getAuth(c);
    const now = Date.now();
    const managedBy = value.tenantId && !critical ? 'tenant' : 'platform';
    const nextChangeProtection = value.changeProtection ?? current.change_protection;
    const policyHash = await hashLoggingDestinationOverride({
      tenantId: value.tenantId,
      logType: value.logType,
      plane: value.plane,
      destinationId: value.destinationId,
      fallbackPolicyId: value.fallbackPolicyId,
      enabled: value.enabled,
      managedBy,
      changeProtection: nextChangeProtection,
      approvalPolicyId: value.approvalPolicyId,
    });
    await adapter.execute(
      `UPDATE logging_destination_overrides
	       SET tenant_id = ?, log_type = ?, plane = ?, destination_id = ?, fallback_policy_id = ?,
	           enabled = ?, managed_by = ?, change_protection = ?, approval_policy_id = ?,
	           policy_hash = ?, updated_by = ?, updated_at = ?, version = version + 1
	       WHERE id = ?`,
      [
        value.tenantId,
        value.logType,
        value.plane,
        value.destinationId,
        value.fallbackPolicyId,
        value.enabled ? 1 : 0,
        managedBy,
        nextChangeProtection,
        value.approvalPolicyId,
        policyHash,
        authContext.userId,
        now,
        policyId,
      ]
    );
    await insertLoggingDestinationOverrideHistory(adapter, {
      overrideId: policyId,
      previous: current,
      next: {
        tenant_id: value.tenantId,
        log_type: value.logType,
        plane: value.plane,
        destination_id: value.destinationId,
        fallback_policy_id: value.fallbackPolicyId,
        enabled: value.enabled ? 1 : 0,
        change_protection: nextChangeProtection,
        approval_policy_id: value.approvalPolicyId,
        policy_hash: policyHash,
        version: current.version + 1,
      },
      changedBy: authContext.userId,
      changedAt: now,
      changeReason: 'update',
    });
    const auditId = await writeAdminAuditLog(c, {
      action: 'logging_destination_override.update',
      resourceType: 'logging_destination_override',
      resourceId: policyId,
      result: 'success',
      severity: critical ? 'warn' : 'info',
      before: {
        id: current.id,
        tenant_id: current.tenant_id,
        log_type: current.log_type,
        plane: current.plane,
        destination_id: current.destination_id,
        fallback_policy_id: current.fallback_policy_id,
        enabled: current.enabled === 1,
        managed_by: current.managed_by,
        change_protection: current.change_protection,
        approval_policy_id: current.approval_policy_id,
        policy_hash: current.policy_hash,
        version: current.version,
      },
      after: {
        id: policyId,
        tenant_id: value.tenantId,
        log_type: value.logType,
        plane: value.plane,
        destination_id: value.destinationId,
        fallback_policy_id: value.fallbackPolicyId,
        enabled: value.enabled,
        managed_by: managedBy,
        change_protection: nextChangeProtection,
        approval_policy_id: value.approvalPolicyId,
        policy_hash: policyHash,
        version: current.version + 1,
      },
    });

    return c.json(
      adminMutationEnvelope(
        {
          id: policyId,
          tenant_id: value.tenantId,
          log_type: value.logType,
          plane: value.plane,
          destination_id: value.destinationId,
          fallback_policy_id: value.fallbackPolicyId,
          enabled: value.enabled ? 1 : 0,
          managed_by: managedBy,
          change_protection: nextChangeProtection,
          approval_policy_id: value.approvalPolicyId,
          policy_hash: policyHash,
          version: current.version + 1,
          updated_at: now,
        },
        { auditId }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

async function handleLoggingDestinationOverrideRollback(
  c: AdminContext,
  policyId: string
): Promise<Response> {
  const body = await parseJsonObject(c);
  try {
    const adapter = getAdminAdapter(c);
    const current = await adapter.queryOne<LoggingDestinationOverrideRow>(
      `SELECT id, tenant_id, log_type, plane, destination_id, fallback_policy_id,
              enabled, managed_by, change_protection, approval_policy_id, policy_hash,
              created_by, updated_by, created_at, updated_at, version
       FROM logging_destination_overrides
       WHERE id = ?`,
      [policyId]
    );
    if (!current) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const currentAccessError = await requireCurrentLoggingOverrideMutationAccess(c, current);
    if (currentAccessError) {
      return currentAccessError;
    }
    const permissionError = await requireLoggingPolicyMutationPermission(c, {
      tenantId: current.tenant_id,
      logType: current.log_type,
      plane: current.plane,
      confirmation: parseOptionalString(body.confirmation),
    });
    if (permissionError) {
      return permissionError;
    }

    const previous = await adapter.queryOne<{
      previous_destination_id: string | null;
      previous_fallback_policy_id: string | null;
      previous_enabled: number | null;
      previous_change_protection: LoggingDestinationOverrideRow['change_protection'] | null;
      previous_approval_policy_id: string | null;
      previous_policy_hash: string | null;
      previous_version: number | null;
    }>(
      `SELECT previous_destination_id, previous_fallback_policy_id, previous_enabled,
              previous_change_protection, previous_approval_policy_id, previous_policy_hash,
              previous_version
       FROM logging_destination_override_history
       WHERE override_id = ? AND previous_version IS NOT NULL
       ORDER BY changed_at DESC
       LIMIT 1`,
      [policyId]
    );
    if (!previous?.previous_destination_id || previous.previous_enabled === null) {
      return createAdminErrorResponseWithDetails(c, AR_ERROR_CODES.ADMIN_CONFLICT, {
        conflict: { reason: 'rollback_state_not_available' },
      });
    }

    const authContext = getAuth(c);
    const now = Date.now();
    const nextVersion = current.version + 1;
    const nextChangeProtection = previous.previous_change_protection ?? current.change_protection;
    const policyHash = await hashLoggingDestinationOverride({
      tenantId: current.tenant_id,
      logType: current.log_type,
      plane: current.plane,
      destinationId: previous.previous_destination_id,
      fallbackPolicyId: previous.previous_fallback_policy_id,
      enabled: previous.previous_enabled === 1,
      managedBy: current.managed_by,
      changeProtection: nextChangeProtection,
      approvalPolicyId: previous.previous_approval_policy_id,
    });

    await adapter.execute(
      `UPDATE logging_destination_overrides
       SET destination_id = ?, fallback_policy_id = ?, enabled = ?,
           change_protection = ?, approval_policy_id = ?, policy_hash = ?,
           updated_by = ?, updated_at = ?, version = version + 1
       WHERE id = ?`,
      [
        previous.previous_destination_id,
        previous.previous_fallback_policy_id,
        previous.previous_enabled,
        nextChangeProtection,
        previous.previous_approval_policy_id,
        policyHash,
        authContext.userId,
        now,
        policyId,
      ]
    );
    const next = {
      tenant_id: current.tenant_id,
      log_type: current.log_type,
      plane: current.plane,
      destination_id: previous.previous_destination_id,
      fallback_policy_id: previous.previous_fallback_policy_id,
      enabled: previous.previous_enabled,
      change_protection: nextChangeProtection,
      approval_policy_id: previous.previous_approval_policy_id,
      policy_hash: policyHash,
      version: nextVersion,
    };
    await insertLoggingDestinationOverrideHistory(adapter, {
      overrideId: policyId,
      previous: current,
      next,
      changedBy: authContext.userId,
      changedAt: now,
      changeReason: 'rollback',
      metadata: { restored_previous_version: previous.previous_version },
    });
    const auditId = await writeAdminAuditLog(c, {
      action: 'logging_destination_override.rollback',
      resourceType: 'logging_destination_override',
      resourceId: policyId,
      result: 'success',
      severity: isCriticalLoggingPolicy(current.log_type, current.plane) ? 'warn' : 'info',
      before: current as unknown as Record<string, unknown>,
      after: next as unknown as Record<string, unknown>,
    });

    return c.json(
      adminMutationEnvelope(
        {
          id: policyId,
          destination_id: next.destination_id,
          fallback_policy_id: next.fallback_policy_id,
          enabled: next.enabled,
          change_protection: next.change_protection,
          approval_policy_id: next.approval_policy_id,
          policy_hash: next.policy_hash,
          version: next.version,
          updated_at: now,
        },
        { auditId }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

loggingPoliciesRouter.patch('/rows/:rowId', async (c) =>
  handleLoggingDestinationOverridePatch(c, c.req.param('rowId')!)
);

loggingPoliciesRouter.post('/rows/:rowId/rollback', async (c) =>
  handleLoggingDestinationOverrideRollback(c, c.req.param('rowId')!)
);

loggingPoliciesRouter.post('/overrides/:rowId/rollback', async (c) =>
  handleLoggingDestinationOverrideRollback(c, c.req.param('rowId')!)
);

loggingPoliciesRouter.patch('/:policy_id', async (c) =>
  handleLoggingDestinationOverridePatch(c, c.req.param('policy_id')!)
);

loggingPoliciesRouter.get('/delivery-events', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const conditions: string[] = [];
  const params: unknown[] = [];
  const requestedTenantKey = c.req.query('filter[tenant_key]') || c.req.query('tenant_key');
  const requestedTenantId = c.req.query('filter[tenant_id]') || c.req.query('tenant_id');
  const tenantKeyFilter = await resolveTenantKeyOrTenantIdFilter(c, {
    tenantKey: requestedTenantKey,
    tenantId: requestedTenantId,
  });
  if (!tenantKeyFilter.ok) {
    return tenantKeyFilter.response;
  }
  const tenantKey = tenantKeyFilter.tenantKey;
  const lane = c.req.query('filter[lane]') || c.req.query('lane');
  const status = c.req.query('filter[status]') || c.req.query('status');
  const from = parseSince(c);
  const to = parseUntil(c);
  const limit = parseLimit(c);
  const filterHash = await hashFilter({
    tenant_key: tenantKey ?? null,
    lane: lane ?? null,
    status: status ?? null,
    time_start: from,
    time_end: to,
  });

  if (tenantKey) {
    conditions.push('tenant_key = ?');
    params.push(tenantKey);
  }
  if (lane) {
    conditions.push('lane = ?');
    params.push(lane);
  }
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (from) {
    conditions.push('created_at >= ?');
    params.push(from);
  }
  if (to) {
    conditions.push('created_at <= ?');
    params.push(to);
  }

  const cursor = c.req.query('cursor');
  if (cursor) {
    const secret = getLoggingCursorSecret(c);
    if (!secret) {
      return createAdminFieldErrorResponse(c, [
        fieldError(
          'cursor',
          'cursor_secret_unavailable',
          'Cursor signing secret is not configured.'
        ),
      ]);
    }

    const result = await decodeLoggingCursor(cursor, secret);
    if (!result.valid || !result.payload) {
      return createAdminFieldErrorResponse(c, [
        fieldError('cursor', result.reason ?? 'invalid_cursor', 'Cursor is invalid or expired.'),
      ]);
    }
    if (result.payload.filterHash !== filterHash || result.payload.direction !== 'next') {
      return createAdminFieldErrorResponse(c, [
        fieldError('cursor', 'filter_mismatch', 'Cursor does not match the current filters.'),
      ]);
    }

    const sort = getCursorSort(result.payload);
    if (!sort) {
      return createAdminFieldErrorResponse(c, [
        fieldError('cursor', 'invalid_sort', 'Cursor sort key is invalid.'),
      ]);
    }

    conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
    params.push(sort.createdAt, sort.createdAt, sort.id);
  }

  try {
    const adapter = getAdminAdapter(c);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await adapter.query<Record<string, unknown>>(
      `SELECT *
       FROM logging_delivery_events
       ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [...params, limit + 1]
    );
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const lastItem = items.at(-1);
    const secret = getLoggingCursorSecret(c);
    const nextCursor =
      hasMore && lastItem && secret
        ? await encodeLoggingCursor(
            {
              sort: {
                created_at: Number(lastItem.created_at),
                id: String(lastItem.id),
              },
              direction: 'next',
              filterHash,
              expiresAt: Date.now() + DELIVERY_EVENTS_CURSOR_TTL_MS,
            },
            secret
          )
        : undefined;

    return c.json(
      adminListEnvelope(items, {
        page: {
          next_cursor: nextCursor ?? null,
          has_more: hasMore,
          limit,
          ...(from && { time_start: from }),
          ...(to && { time_end: to }),
        },
      })
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.get('/delivery-summary', async (c) => {
  const authContext = getAuth(c);
  if (
    !hasAnyPermission(authContext, [
      ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ,
      ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ,
    ])
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const conditions: string[] = [];
  const params: unknown[] = [];
  const requestedTenantKey = c.req.query('filter[tenant_key]') || c.req.query('tenant_key');
  const requestedTenantId = c.req.query('filter[tenant_id]') || c.req.query('tenant_id');
  const tenantKeyFilter = await resolveTenantKeyOrTenantIdFilter(c, {
    tenantKey: requestedTenantKey,
    tenantId: requestedTenantId,
  });
  if (!tenantKeyFilter.ok) {
    return tenantKeyFilter.response;
  }
  const tenantKey = tenantKeyFilter.tenantKey;
  const lane = c.req.query('filter[lane]') || c.req.query('lane');
  const status = c.req.query('filter[status]') || c.req.query('status');
  const from = parseSince(c) ?? Date.now() - 24 * 60 * 60 * 1000;
  const to = parseUntil(c);

  conditions.push('bucket_start_at >= ?');
  params.push(from);
  if (to) {
    conditions.push('bucket_start_at <= ?');
    params.push(to);
  }
  if (tenantKey) {
    conditions.push('tenant_key = ?');
    params.push(tenantKey);
  }
  if (lane) {
    conditions.push('lane = ?');
    params.push(lane);
  }
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }

  try {
    const adapter = getAdminAdapter(c);
    const rows = await adapter.query<Record<string, unknown>>(
      `SELECT lane, status, log_type, plane,
              SUM(batch_count) AS batch_count,
              SUM(record_count) AS record_count,
              SUM(byte_count) AS byte_count,
              SUM(attempt_count_sum) AS attempt_count_sum,
              MIN(first_seen_at) AS first_seen_at,
              MAX(last_seen_at) AS last_seen_at
       FROM logging_delivery_event_aggregates
       WHERE ${conditions.join(' AND ')}
       GROUP BY lane, status, log_type, plane
       ORDER BY lane ASC, status ASC, log_type ASC, plane ASC
       LIMIT ?`,
      [...params, parseLimit(c, 100, 500)]
    );

    return c.json(
      adminDetailEnvelope({
        window_start_at: from,
        window_end_at: to,
        items: rows,
      })
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.post('/runtime/resolve', async (c) => {
  const authContext = getAuth(c);
  if (
    !hasAnyPermission(authContext, [
      ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ,
      ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ,
    ])
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const body = await parseJsonObject(c);
  const requestedTenantId = parseOptionalString(body.tenant_id) ?? undefined;
  const tenantIdFilter = await resolveTenantIdFilter(c, requestedTenantId);
  if (!tenantIdFilter.ok) {
    return tenantIdFilter.response;
  }
  const tenantId = tenantIdFilter.tenantId ?? getTenantIdFromContext(c);
  const logType = readLogType(body.log_type);
  const plane = readLogPlane(body.plane);
  const region = parseOptionalString(body.region);
  if (!tenantId || !logType || !plane) {
    return createAdminFieldErrorResponse(c, [
      ...(!tenantId ? [fieldError('tenant_id', 'required', 'Tenant id is required.')] : []),
      ...(!logType ? [fieldError('log_type', 'invalid_value', 'Log type is not supported.')] : []),
      ...(!plane ? [fieldError('plane', 'invalid_value', 'Log plane is not supported.')] : []),
    ]);
  }

  try {
    const resolution = await resolveRuntimeLoggingPolicyTargetFromEnv(c.env, {
      tenantId,
      logType,
      plane,
      region,
    });
    const target = resolution?.target ?? null;
    const bindingRef = target?.type === 'r2' ? target.bucketRef : null;
    const bindingConfigured = bindingRef
      ? Boolean((c.env as unknown as Record<string, unknown>)[bindingRef])
      : target !== null;
    return c.json(
      adminDetailEnvelope({
        input: { tenant_id: tenantId, log_type: logType, plane, region },
        resolved: resolution !== null,
        resolution,
        target_status: {
          target_type: target?.type ?? null,
          binding_ref: bindingRef,
          binding_configured: bindingConfigured,
        },
      })
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.get('/runtime/topology', async (c) => {
  const authContext = getAuth(c);
  if (
    !hasAnyPermission(authContext, [
      ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ,
      ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ,
    ])
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const requestedTenantId = c.req.query('tenant_id') || c.req.query('filter[tenant_id]');
  const tenantIdFilter = await resolveTenantIdFilter(c, requestedTenantId);
  if (!tenantIdFilter.ok) {
    return tenantIdFilter.response;
  }
  const tenantId = tenantIdFilter.tenantId ?? getTenantIdFromContext(c);
  const tenantKey = tenantId ? await resolveScopedTenantKey(c, tenantId) : null;

  try {
    const profiles = tenantId
      ? await resolveTenantRuntimeProfilesFromEnv(
          c.env as unknown as Parameters<typeof resolveTenantRuntimeProfilesFromEnv>[0],
          tenantId
        ).catch((error) => ({
          error: error instanceof Error ? error.message : 'profile_resolution_failed',
        }))
      : null;
    return c.json(
      adminDetailEnvelope({
        tenant_id: tenantId,
        tenant_key: tenantKey,
        bindings: {
          db: Boolean(c.env.DB),
          db_admin: Boolean(c.env.DB_ADMIN),
          db_pii: Boolean(c.env.DB_PII),
          logging_index_db: Boolean(c.env.LOGGING_INDEX_DB),
          authrim_config: Boolean(c.env.AUTHRIM_CONFIG),
          diagnostic_logs: Boolean(c.env.DIAGNOSTIC_LOGS),
          audit_archive: Boolean(c.env.AUDIT_ARCHIVE),
          sensitive_details: Boolean(c.env.SENSITIVE_DETAILS),
          logging_delivery_critical_queue: Boolean(c.env.LOGGING_DELIVERY_CRITICAL_QUEUE),
          logging_delivery_queue: Boolean(c.env.LOGGING_DELIVERY_QUEUE),
          logging_delivery_bulk_queue: Boolean(c.env.LOGGING_DELIVERY_BULK_QUEUE),
        },
        runtime_profiles: profiles,
        checked_at: Date.now(),
      })
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.get('/runtime/verify', async (c) => {
  const authContext = getAuth(c);
  if (
    !hasAnyPermission(authContext, [
      ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ,
      ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ,
      ADMIN_PERMISSIONS.LOGGING_SNAPSHOTS_PUBLISH,
    ])
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const scopeTypeRaw = c.req.query('scope_type') || c.req.query('filter[scope_type]') || 'tenant';
  const scopeType = scopeTypeRaw === 'platform' || scopeTypeRaw === 'tenant' ? scopeTypeRaw : null;
  if (!scopeType) {
    return createAdminFieldErrorResponse(c, [
      fieldError('scope_type', 'invalid_value', 'Scope type must be platform or tenant.'),
    ]);
  }

  let scopeId = c.req.query('scope_id') || c.req.query('filter[scope_id]') || '';
  if (scopeType === 'platform') {
    const platformError = await requirePlatformAuthority(c);
    if (platformError) {
      return platformError;
    }
    scopeId = scopeId || 'global';
  } else {
    const requestedTenantId =
      c.req.query('tenant_id') || c.req.query('filter[tenant_id]') || scopeId || undefined;
    const tenantIdFilter = await resolveTenantIdFilter(c, requestedTenantId);
    if (!tenantIdFilter.ok) {
      return tenantIdFilter.response;
    }
    scopeId = tenantIdFilter.tenantId ?? getTenantIdFromContext(c);
  }

  try {
    const pointerKey = buildRuntimeLoggingPolicySnapshotPointerKey({ scopeType, scopeId });
    const pointerJson = c.env.AUTHRIM_CONFIG ? await c.env.AUTHRIM_CONFIG.get(pointerKey) : null;
    const parseJsonObjectOrNull = (value: string | null): Record<string, unknown> | null => {
      if (!value) {
        return null;
      }
      try {
        const parsed = JSON.parse(value) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      } catch {
        return null;
      }
    };
    const pointer = parseJsonObjectOrNull(pointerJson);
    const objectRef = typeof pointer?.objectRef === 'string' ? pointer.objectRef : null;
    let snapshotJson: string | null = null;
    let objectStatus = 'not_referenced';
    if (objectRef) {
      if (objectRef.startsWith('kv://')) {
        snapshotJson = c.env.AUTHRIM_CONFIG
          ? await c.env.AUTHRIM_CONFIG.get(objectRef.slice('kv://'.length))
          : null;
        objectStatus = snapshotJson ? 'readable' : 'missing';
      } else if (c.env.DIAGNOSTIC_LOGS?.get) {
        const object = await c.env.DIAGNOSTIC_LOGS.get(objectRef);
        if (object) {
          snapshotJson = await readR2ObjectTextWithLimit(object, 1024 * 1024).catch(() => null);
          objectStatus = snapshotJson ? 'readable' : 'unreadable';
        } else {
          objectStatus = 'missing';
        }
      } else {
        objectStatus = 'object_store_unavailable';
      }
    }
    const snapshot = parseJsonObjectOrNull(snapshotJson);
    const latestPublished = await getAdminAdapter(c).queryOne<Record<string, unknown>>(
      `SELECT id, version, policy_hash, object_ref, published_at
       FROM logging_policy_snapshots
       WHERE scope_type = ?
         AND scope_id = ?
         AND status = 'published'
       ORDER BY published_at DESC, created_at DESC
       LIMIT 1`,
      [scopeType, scopeId]
    );
    const pointerStatus = pointer ? 'readable' : pointerJson ? 'invalid_json' : 'missing';
    const snapshotStatus = snapshot ? 'readable' : snapshotJson ? 'invalid_json' : objectStatus;
    const pointerMatchesSnapshot =
      pointer !== null && snapshot !== null
        ? pointer.snapshotId === snapshot.snapshotId &&
          pointer.version === snapshot.version &&
          pointer.policyHash === snapshot.policyHash &&
          pointer.scopeType === snapshot.scopeType &&
          pointer.scopeId === snapshot.scopeId
        : false;
    const pointerMatchesDatabase =
      pointer !== null && latestPublished !== null
        ? pointer.snapshotId === latestPublished.id &&
          pointer.version === latestPublished.version &&
          pointer.policyHash === latestPublished.policy_hash &&
          pointer.objectRef === latestPublished.object_ref
        : false;
    const checks = {
      pointer_present: Boolean(pointer),
      object_ref_present: Boolean(objectRef),
      snapshot_present: Boolean(snapshot),
      pointer_matches_snapshot: pointerMatchesSnapshot,
      pointer_matches_database: pointerMatchesDatabase,
      database_latest_present: Boolean(latestPublished),
    };

    return c.json(
      adminDetailEnvelope({
        scope_type: scopeType,
        scope_id: scopeId,
        pointer_key: pointerKey,
        pointer_status: pointerStatus,
        object_status: objectStatus,
        snapshot_status: snapshotStatus,
        pointer: pointer
          ? {
              snapshot_id: pointer.snapshotId ?? null,
              version: pointer.version ?? null,
              policy_hash: pointer.policyHash ?? null,
              object_ref: objectRef,
              published_at: pointer.publishedAt ?? null,
              expires_at: pointer.expiresAt ?? null,
            }
          : null,
        snapshot: snapshot
          ? {
              snapshot_id: snapshot.snapshotId ?? null,
              version: snapshot.version ?? null,
              policy_hash: snapshot.policyHash ?? null,
              synchronized_at: snapshot.synchronizedAt ?? null,
              source_updated_at: snapshot.sourceUpdatedAt ?? null,
            }
          : null,
        database_latest: latestPublished ?? null,
        checks,
        verified_at: Date.now(),
      })
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.get('/runtime/tenant-db-health', async (c) => {
  const authContext = getAuth(c);
  if (
    !hasAnyPermission(authContext, [
      ADMIN_PERMISSIONS.DATABASE_ROUTING_READ,
      ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ,
    ])
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const requestedTenantId = c.req.query('tenant_id') || c.req.query('filter[tenant_id]');
  const tenantIdFilter = await resolveTenantIdFilter(c, requestedTenantId);
  if (!tenantIdFilter.ok) {
    return tenantIdFilter.response;
  }
  const tenantId = tenantIdFilter.tenantId ?? getTenantIdFromContext(c);
  const role = c.req.query('role') || c.req.query('filter[role]');
  if (
    role &&
    role !== 'tenant_core' &&
    role !== 'tenant_pii' &&
    role !== 'tenant_audit' &&
    role !== 'tenant_custom'
  ) {
    return createAdminFieldErrorResponse(c, [
      fieldError('role', 'invalid_value', 'Tenant database role is not supported.'),
    ]);
  }

  try {
    const params: unknown[] = [tenantId];
    const roleCondition = role ? 'AND p.role = ?' : '';
    if (role) {
      params.push(role);
    }
    const rows = await getAdminAdapter(c).query<Record<string, unknown>>(
      `SELECT p.tenant_id, p.role, p.shard_group, p.generation,
              p.shard_count, p.shard_key_strategy, p.runtime_generation,
              p.status AS pointer_status, p.updated_at AS pointer_updated_at,
              p.metadata_json AS pointer_metadata_json,
              r.provider, r.database_id, r.database_name, r.binding_ref, r.connection_ref,
              r.schema_version, r.status AS registry_status, r.region_hint, r.jurisdiction,
              r.updated_at AS registry_updated_at, r.metadata_json AS registry_metadata_json
       FROM tenant_database_active_pointers p
       LEFT JOIN tenant_database_registry r
         ON r.tenant_id = p.tenant_id
        AND r.role = p.role
        AND r.generation = p.generation
        AND r.shard_group = p.shard_group
       WHERE p.tenant_id = ?
       ${roleCondition}
       ORDER BY p.role ASC, p.shard_group ASC, p.generation DESC`,
      params
    );
    const items = rows.map((row) => {
      const bindingRef = typeof row.binding_ref === 'string' ? row.binding_ref : null;
      const connectionRef = typeof row.connection_ref === 'string' ? row.connection_ref : null;
      const bindingConfigured = bindingRef
        ? Boolean((c.env as unknown as Record<string, unknown>)[bindingRef])
        : connectionRef
          ? true
          : false;
      const pointerStatus = String(row.pointer_status ?? 'unknown');
      const registryStatus = row.registry_status ? String(row.registry_status) : 'missing';
      const healthState =
        registryStatus === 'missing' ||
        registryStatus === 'failed' ||
        registryStatus === 'disabled' ||
        pointerStatus === 'disabled' ||
        !bindingConfigured
          ? 'failed'
          : registryStatus === 'degraded' ||
              registryStatus === 'degraded_pending_snapshot' ||
              pointerStatus === 'degraded_pending_snapshot'
            ? 'degraded'
            : 'healthy';
      return {
        tenant_id: row.tenant_id,
        role: row.role,
        shard_group: row.shard_group,
        generation: toInteger(row.generation),
        shard_count: toInteger(row.shard_count),
        shard_key_strategy: row.shard_key_strategy,
        runtime_generation: toInteger(row.runtime_generation),
        pointer_status: pointerStatus,
        pointer_updated_at: row.pointer_updated_at,
        registry_status: registryStatus,
        provider: row.provider ?? null,
        database_id: row.database_id ?? null,
        database_name: row.database_name ?? null,
        binding_ref: bindingRef,
        connection_ref: connectionRef,
        binding_configured: bindingConfigured,
        schema_version: readNullableInteger(row.schema_version),
        region_hint: row.region_hint ?? null,
        jurisdiction: row.jurisdiction ?? null,
        registry_updated_at: row.registry_updated_at ?? null,
        health_state: healthState,
        pointer_metadata: parseJsonMetadata(
          typeof row.pointer_metadata_json === 'string' ? row.pointer_metadata_json : null
        ),
        registry_metadata: parseJsonMetadata(
          typeof row.registry_metadata_json === 'string' ? row.registry_metadata_json : null
        ),
      };
    });
    const summary = {
      healthy: items.filter((item) => item.health_state === 'healthy').length,
      degraded: items.filter((item) => item.health_state === 'degraded').length,
      failed: items.filter((item) => item.health_state === 'failed').length,
      missing_registry: items.filter((item) => item.registry_status === 'missing').length,
      missing_binding: items.filter((item) => !item.binding_configured).length,
    };
    return c.json(
      adminDetailEnvelope({
        tenant_id: tenantId,
        role: role ?? null,
        items,
        summary,
        checked_at: Date.now(),
      })
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.post('/runtime/tenant-db-probe', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.DATABASE_ROUTING_WRITE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const body = await parseJsonObject(c);
  const requestedTenantId = parseOptionalString(body.tenant_id);
  const tenantIdFilter = await resolveTenantIdFilter(c, requestedTenantId ?? undefined);
  if (!tenantIdFilter.ok) {
    return tenantIdFilter.response;
  }
  const tenantId = tenantIdFilter.tenantId ?? getTenantIdFromContext(c);
  const role = readTenantDatabaseProbeRole(body.role) ?? 'tenant_core';
  const shardGroup = parseOptionalString(body.shard_group) ?? 'default';
  const shardIndexRaw = Number.parseInt(String(body.shard_index ?? '0'), 10);
  const shardIndex = Number.isInteger(shardIndexRaw) && shardIndexRaw >= 0 ? shardIndexRaw : 0;
  const probeKind =
    body.probe_kind === 'write_read_delete' || body.probe_kind === undefined
      ? 'write_read_delete'
      : null;
  if (!probeKind) {
    return createAdminFieldErrorResponse(c, [
      fieldError('probe_kind', 'invalid_value', 'Probe kind must be write_read_delete.'),
    ]);
  }

  const now = Date.now();
  const probeId = createLoggingId('tdp', now);
  const startedAt = Date.now();
  let status: 'succeeded' | 'failed' = 'failed';
  let errorClass: string | null = null;
  let errorMessage: string | null = null;
  let metadata: Record<string, unknown> = {};
  let resolved: Awaited<ReturnType<typeof resolveTenantDatabaseSourceFromRegistry>> | null = null;

  try {
    resolved = await resolveTenantDatabaseSourceFromRegistry(
      c.env as Parameters<typeof resolveTenantDatabaseSourceFromRegistry>[0],
      {
        tenantId,
        role,
        shardGroup,
        shardIndex,
        runtimeSnapshotMode: 'optional',
      }
    );
    const tenantAdapter = ensureDatabaseAdapter(resolved.source, 'tenant-db-probe');
    await tenantAdapter.execute(
      `CREATE TABLE IF NOT EXISTS authrim_runtime_probes (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        role TEXT NOT NULL,
        probe_kind TEXT NOT NULL,
        nonce TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`
    );
    const nonce = crypto.randomUUID();
    await tenantAdapter.execute(
      `INSERT INTO authrim_runtime_probes (id, tenant_id, role, probe_kind, nonce, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [probeId, tenantId, role, probeKind, nonce, now]
    );
    const readBack = await tenantAdapter.queryOne<{ nonce: string }>(
      'SELECT nonce FROM authrim_runtime_probes WHERE id = ?',
      [probeId]
    );
    await tenantAdapter.execute('DELETE FROM authrim_runtime_probes WHERE id = ?', [probeId]);
    if (readBack?.nonce !== nonce) {
      throw new Error('tenant_database_probe_readback_mismatch');
    }
    status = 'succeeded';
    metadata = {
      shard_count: resolved.shardCount,
      runtime_generation: resolved.runtimeGeneration,
      deployment_target: resolved.deploymentTarget,
      health_status: resolved.healthStatus,
    };
  } catch (error) {
    errorClass =
      error instanceof Error && error.name === 'TenantDatabaseResolverError'
        ? error.message.split(':')[0]
        : 'tenant_database_probe_failed';
    errorMessage = error instanceof Error ? error.message : 'tenant_database_probe_failed';
  }

  try {
    await getAdminAdapter(c).execute(
      `INSERT INTO tenant_database_probe_results (
        id, tenant_id, role, shard_group, shard_index, generation, probe_kind, status,
        latency_ms, binding_ref, connection_ref, provider, schema_version,
        error_class, error_message, metadata_json, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        probeId,
        tenantId,
        role,
        shardGroup,
        shardIndex,
        resolved?.generation ?? null,
        probeKind,
        status,
        Date.now() - startedAt,
        resolved?.bindingRef ?? null,
        resolved?.registryRow.connection_ref ?? null,
        resolved?.registryRow.provider ?? null,
        resolved?.schemaVersion ?? null,
        errorClass,
        errorMessage,
        JSON.stringify(metadata),
        authContext.userId ?? null,
        now,
      ]
    );
  } catch {
    // Probe result persistence must not mask the actual probe result.
  }

  const auditId = await writeAdminAuditLog(c, {
    action: 'logging.runtime.tenant_db_probe',
    resourceType: 'tenant_database',
    resourceId: `${tenantId}:${role}:${shardGroup}:${shardIndex}`,
    result: status === 'succeeded' ? 'success' : 'failure',
    severity: status === 'succeeded' ? 'info' : 'warn',
    metadata: {
      tenant_id: tenantId,
      role,
      shard_group: shardGroup,
      shard_index: shardIndex,
      probe_kind: probeKind,
      error_class: errorClass,
    },
  });

  return c.json(
    adminActionEnvelope(
      {
        id: probeId,
        tenant_id: tenantId,
        role,
        shard_group: shardGroup,
        shard_index: shardIndex,
        probe_kind: probeKind,
        status,
        latency_ms: Date.now() - startedAt,
        binding_ref: resolved?.bindingRef ?? null,
        connection_ref: resolved?.registryRow.connection_ref ?? null,
        provider: resolved?.registryRow.provider ?? null,
        schema_version: resolved?.schemaVersion ?? null,
        error_class: errorClass,
        error_message: errorMessage,
        metadata,
        checked_at: now,
      },
      { auditId }
    ),
    status === 'succeeded' ? 200 : 503
  );
});

loggingPoliciesRouter.get('/runtime/tenant-db-probes', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.DATABASE_ROUTING_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const requestedTenantId = c.req.query('filter[tenant_id]') || c.req.query('tenant_id');
  const tenantIdFilter = await resolveTenantIdFilter(c, requestedTenantId);
  if (!tenantIdFilter.ok) {
    return tenantIdFilter.response;
  }
  const role = readTenantDatabaseProbeRole(c.req.query('filter[role]') || c.req.query('role'));
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (tenantIdFilter.tenantId) {
    conditions.push('tenant_id = ?');
    params.push(tenantIdFilter.tenantId);
  }
  if (role) {
    conditions.push('role = ?');
    params.push(role);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  try {
    const rows = await getAdminAdapter(c).query<Record<string, unknown>>(
      `SELECT id, tenant_id, role, shard_group, shard_index, generation, probe_kind,
              status, latency_ms, binding_ref, connection_ref, provider, schema_version,
              error_class, error_message, metadata_json, created_by, created_at
       FROM tenant_database_probe_results
       ${where}
       ORDER BY created_at DESC
       LIMIT ?`,
      [...params, parseLimit(c, 25, 100)]
    );
    return c.json(adminListEnvelope(rows));
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.get('/usage-aggregates', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const requestedTenantKey = c.req.query('filter[tenant_key]') || c.req.query('tenant_key');
  const requestedTenantId = c.req.query('filter[tenant_id]') || c.req.query('tenant_id');
  const tenantKeyFilter = await resolveTenantKeyOrTenantIdFilter(c, {
    tenantKey: requestedTenantKey,
    tenantId: requestedTenantId,
  });
  if (!tenantKeyFilter.ok) {
    return tenantKeyFilter.response;
  }
  const metricName = readLoggingQuotaMetric(
    c.req.query('filter[metric_name]') || c.req.query('metric_name')
  );
  const windowKind =
    readLoggingUsageWindowKind(c.req.query('filter[window_kind]') || c.req.query('window_kind')) ??
    'day';
  const from = parseSince(c) ?? Date.now() - 24 * 60 * 60 * 1000;
  const to = parseUntil(c);
  const conditions = ['window_kind = ?', 'window_start_at >= ?'];
  const params: unknown[] = [windowKind, from];
  if (to) {
    conditions.push('window_start_at <= ?');
    params.push(to);
  }
  if (tenantKeyFilter.tenantKey) {
    conditions.push('tenant_key = ?');
    params.push(tenantKeyFilter.tenantKey);
  }
  if (metricName) {
    conditions.push('metric_name = ?');
    params.push(metricName);
  }
  try {
    const rows = await getAdminAdapter(c).query<Record<string, unknown>>(
      `SELECT id, tenant_id, tenant_key, log_type, plane, lane, metric_name,
              window_kind, window_start_at, window_end_at, value, source_table,
              metadata_json, refreshed_at, created_at, updated_at
       FROM logging_usage_aggregates
       WHERE ${conditions.join(' AND ')}
       ORDER BY window_start_at DESC, metric_name ASC
       LIMIT ?`,
      [...params, parseLimit(c, 100, 500)]
    );
    return c.json(adminListEnvelope(rows));
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.post('/usage-aggregates/refresh', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatformAuthority(c);
  if (platformError) {
    return platformError;
  }
  const body = await parseJsonObject(c);
  const windowKind = readLoggingUsageWindowKind(body.window_kind) ?? 'hour';
  const requestedStart = Number.parseInt(String(body.window_start_at ?? ''), 10);
  const windowStartAt =
    Number.isFinite(requestedStart) && requestedStart > 0
      ? requestedStart
      : floorUsageWindow(Date.now() - endUsageWindow(0, windowKind), windowKind);
  const tenantKey = parseOptionalString(body.tenant_key);
  const tenantId = parseOptionalString(body.tenant_id);

  try {
    const result = await refreshLoggingUsageAggregatesForWindow(getAdminAdapter(c), {
      windowKind,
      windowStartAt,
      tenantKey,
      tenantId,
      now: Date.now(),
    });
    const auditId = await writeAdminAuditLog(c, {
      action: 'logging.usage_aggregates.refresh',
      resourceType: 'logging_usage_aggregate',
      resourceId: `${windowKind}:${windowStartAt}`,
      result: 'success',
      severity: 'info',
      metadata: { ...result, tenant_key: tenantKey, tenant_id: tenantId },
    });
    return c.json(adminActionEnvelope(result, { auditId }));
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.get('/quota-policies', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const scopeType = readQuotaScopeType(
    c.req.query('filter[scope_type]') || c.req.query('scope_type')
  );
  const requestedScopeId = c.req.query('filter[scope_id]') || c.req.query('scope_id');
  const conditions = ["status <> 'deleted'"];
  const params: unknown[] = [];
  if (scopeType) {
    conditions.push('scope_type = ?');
    params.push(scopeType);
  }
  if (requestedScopeId) {
    if (scopeType === 'tenant') {
      const tenantFilter = await resolveTenantIdFilter(c, requestedScopeId);
      if (!tenantFilter.ok) {
        return tenantFilter.response;
      }
    } else if (!hasPlatformAuthority(authContext)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }
    conditions.push('scope_id = ?');
    params.push(requestedScopeId);
  } else if (!hasPlatformAuthority(authContext)) {
    conditions.push('(scope_type = ? AND scope_id = ?)');
    params.push('tenant', getTenantIdFromContext(c));
  }

  try {
    const rows = await getAdminAdapter(c).query<Record<string, unknown>>(
      `SELECT id, scope_type, scope_id, log_type, plane, lane, metric_name, window_kind,
              soft_limit, hard_limit, warning_ratio, enforcement_mode, critical_behavior,
              status, created_by, updated_by, created_at, updated_at, version
       FROM logging_quota_policies
       WHERE ${conditions.join(' AND ')}
       ORDER BY scope_type ASC, scope_id ASC, metric_name ASC, window_kind ASC
       LIMIT ?`,
      [...params, parseLimit(c, 100, 500)]
    );
    return c.json(adminListEnvelope(rows));
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.post('/quota-policies', async (c) => {
  const authContext = getAuth(c);
  if (
    !hasAnyPermission(authContext, [
      ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE,
      ADMIN_PERMISSIONS.LOGGING_TENANT_OVERRIDES_UPDATE,
    ])
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const parsed = await readQuotaPolicyBody(c, 'create');
  if (!parsed.ok) {
    return parsed.response;
  }
  if (
    parsed.value.scopeType === 'platform' &&
    !hasPermission(authContext, ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE)
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  if (
    parsed.value.scopeType === 'tenant' &&
    !hasPermission(authContext, ADMIN_PERMISSIONS.LOGGING_TENANT_OVERRIDES_UPDATE)
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const adapter = getAdminAdapter(c);
    const now = Date.now();
    const id = createLoggingId('lqp', now);
    const value = parsed.value;
    await adapter.execute(
      `INSERT INTO logging_quota_policies (
        id, scope_type, scope_id, log_type, plane, lane, metric_name, window_kind,
        soft_limit, hard_limit, warning_ratio, enforcement_mode, critical_behavior,
        status, created_by, updated_by, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'never_block', ?, ?, ?, ?, ?, 1)`,
      [
        id,
        value.scopeType,
        value.scopeId,
        value.logType,
        value.plane,
        value.lane,
        value.metricName,
        value.windowKind,
        value.softLimit,
        value.hardLimit,
        value.warningRatio,
        value.enforcementMode,
        value.status,
        authContext.userId ?? null,
        authContext.userId ?? null,
        now,
        now,
      ]
    );
    const auditId = await writeAdminAuditLog(c, {
      action: 'logging.quota_policy.create',
      resourceType: 'logging_quota_policy',
      resourceId: id,
      result: 'success',
      severity: value.enforcementMode === 'hard_non_critical' ? 'warn' : 'info',
      metadata: value,
    });
    return c.json(adminMutationEnvelope({ id, version: 1, created_at: now }, { auditId }), 201);
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.patch('/quota-policies/:id', async (c) => {
  const authContext = getAuth(c);
  if (
    !hasAnyPermission(authContext, [
      ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE,
      ADMIN_PERMISSIONS.LOGGING_TENANT_OVERRIDES_UPDATE,
    ])
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const parsed = await readQuotaPolicyBody(c, 'update');
  if (!parsed.ok) {
    return parsed.response;
  }

  try {
    const adapter = getAdminAdapter(c);
    const id = c.req.param('id');
    const current = await adapter.queryOne<Record<string, unknown>>(
      `SELECT id, scope_type, scope_id, version
       FROM logging_quota_policies
       WHERE id = ? AND deleted_at IS NULL`,
      [id]
    );
    if (!current) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (
      current.scope_type === 'platform' &&
      !hasPermission(authContext, ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE)
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }
    if (
      current.scope_type === 'tenant' &&
      !hasPermission(authContext, ADMIN_PERMISSIONS.LOGGING_TENANT_OVERRIDES_UPDATE)
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }
    if (
      parsed.value.expectedVersion &&
      parsed.value.expectedVersion !== toInteger(current.version)
    ) {
      return createAdminErrorResponseWithDetails(c, AR_ERROR_CODES.ADMIN_CONFLICT, {
        conflict: {
          expected_version: parsed.value.expectedVersion,
          actual_version: toInteger(current.version),
        },
      });
    }

    const now = Date.now();
    const value = parsed.value;
    await adapter.execute(
      `UPDATE logging_quota_policies
       SET scope_type = ?,
           scope_id = ?,
           log_type = ?,
           plane = ?,
           lane = ?,
           metric_name = ?,
           window_kind = ?,
           soft_limit = ?,
           hard_limit = ?,
           warning_ratio = ?,
           enforcement_mode = ?,
           status = ?,
           updated_by = ?,
           updated_at = ?,
           version = version + 1
       WHERE id = ? AND deleted_at IS NULL`,
      [
        value.scopeType,
        value.scopeId,
        value.logType,
        value.plane,
        value.lane,
        value.metricName,
        value.windowKind,
        value.softLimit,
        value.hardLimit,
        value.warningRatio,
        value.enforcementMode,
        value.status,
        authContext.userId ?? null,
        now,
        id,
      ]
    );
    const auditId = await writeAdminAuditLog(c, {
      action: 'logging.quota_policy.update',
      resourceType: 'logging_quota_policy',
      resourceId: id,
      result: 'success',
      severity: value.enforcementMode === 'hard_non_critical' ? 'warn' : 'info',
      metadata: value,
    });
    return c.json(
      adminMutationEnvelope(
        { id, version: toInteger(current.version) + 1, updated_at: now },
        { auditId }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.post('/quota/evaluate', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatformAuthority(c);
  if (platformError) {
    return platformError;
  }
  const now = Date.now();
  try {
    const adapter = getAdminAdapter(c);
    const policies = await adapter.query<Record<string, unknown>>(
      `SELECT id, scope_type, scope_id, log_type, plane, lane, metric_name, window_kind,
              soft_limit, hard_limit, warning_ratio, enforcement_mode
       FROM logging_quota_policies
       WHERE status = 'active' AND deleted_at IS NULL
       ORDER BY scope_type ASC, scope_id ASC, metric_name ASC
       LIMIT 500`
    );
    const evaluations: Record<string, unknown>[] = [];
    const notificationRepo = new InternalNotificationEventRepository(adapter);
    for (const policy of policies) {
      const windowKind = readLoggingUsageWindowKind(policy.window_kind) ?? 'day';
      const windowStartAt = floorUsageWindow(now, windowKind);
      const conditions = ['metric_name = ?', 'window_kind = ?', 'window_start_at = ?'];
      const params: unknown[] = [policy.metric_name, windowKind, windowStartAt];
      if (policy.scope_type === 'tenant') {
        const tenantKey = await resolveScopedTenantKey(c, String(policy.scope_id));
        conditions.push('(tenant_id = ? OR tenant_key = ?)');
        params.push(policy.scope_id, tenantKey);
      }
      for (const field of ['log_type', 'plane', 'lane'] as const) {
        if (policy[field]) {
          conditions.push(`${field} = ?`);
          params.push(policy[field]);
        }
      }
      const usage = await adapter.queryOne<{ value: number | string }>(
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
        warningRatio:
          typeof policy.warning_ratio === 'number'
            ? policy.warning_ratio
            : Number.parseFloat(String(policy.warning_ratio ?? '0.8')),
      });
      const critical = isQuotaCriticalScope({
        logType: typeof policy.log_type === 'string' ? policy.log_type : null,
        plane: typeof policy.plane === 'string' ? policy.plane : null,
        lane: typeof policy.lane === 'string' ? policy.lane : null,
      });
      const enforcementMode =
        readLoggingQuotaEnforcementMode(policy.enforcement_mode) ?? 'warn_only';
      const enforcementAction =
        state === 'ok' || enforcementMode === 'disabled' || enforcementMode === 'observe'
          ? 'none'
          : state === 'hard_exceeded' && enforcementMode === 'hard_non_critical' && !critical
            ? 'block_non_critical'
            : enforcementMode === 'soft_limit' && state !== 'warning' && !critical
              ? 'throttle_non_critical'
              : 'notify';
      let notificationEventId: string | null = null;
      if (state !== 'ok') {
        const notification = await notificationRepo.enqueue({
          tenantId: policy.scope_type === 'tenant' ? String(policy.scope_id) : 'global',
          category: 'logging_quota_warning',
          eventType: `logging.quota.${state}`,
          severity:
            state === 'hard_exceeded' ? 'high' : state === 'soft_exceeded' ? 'medium' : 'low',
          deduplicationKey: ['logging_quota', policy.id, windowKind, windowStartAt, state].join(
            ':'
          ),
          payload: {
            quota_policy_id: policy.id,
            scope_type: policy.scope_type,
            scope_id: policy.scope_id,
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
        });
        notificationEventId = notification.id;
      }
      const evaluationId = createLoggingId('lqe', now);
      const evaluation = {
        id: evaluationId,
        quota_policy_id: policy.id,
        tenant_id: policy.scope_type === 'tenant' ? policy.scope_id : null,
        tenant_key: null,
        log_type: policy.log_type ?? null,
        plane: policy.plane ?? null,
        lane: policy.lane ?? null,
        metric_name: policy.metric_name,
        window_kind: windowKind,
        window_start_at: windowStartAt,
        window_end_at: endUsageWindow(windowStartAt, windowKind),
        value,
        soft_limit: softLimit,
        hard_limit: hardLimit,
        state,
        enforcement_action: enforcementAction,
        evaluated_at: now,
        notification_event_id: notificationEventId,
      };
      await adapter.execute(
        `INSERT INTO logging_quota_evaluations (
          id, quota_policy_id, tenant_id, tenant_key, log_type, plane, lane,
          metric_name, window_kind, window_start_at, window_end_at, value,
          soft_limit, hard_limit, state, enforcement_action, evaluated_at,
          notification_event_id, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          evaluation.id,
          evaluation.quota_policy_id,
          evaluation.tenant_id,
          evaluation.tenant_key,
          evaluation.log_type,
          evaluation.plane,
          evaluation.lane,
          evaluation.metric_name,
          evaluation.window_kind,
          evaluation.window_start_at,
          evaluation.window_end_at,
          evaluation.value,
          evaluation.soft_limit,
          evaluation.hard_limit,
          evaluation.state,
          evaluation.enforcement_action,
          evaluation.evaluated_at,
          evaluation.notification_event_id,
          JSON.stringify({ critical_scope: critical, enforcement_mode: enforcementMode }),
        ]
      );
      evaluations.push(evaluation);
    }
    const auditId = await writeAdminAuditLog(c, {
      action: 'logging.quota.evaluate',
      resourceType: 'logging_quota_policy',
      resourceId: 'bulk-evaluate',
      result: 'success',
      severity: evaluations.some((item) => item.state === 'hard_exceeded') ? 'warn' : 'info',
      metadata: { evaluated_count: evaluations.length },
    });
    return c.json(
      adminActionEnvelope({ evaluated_count: evaluations.length, evaluations }, { auditId })
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.get('/quota-evaluations', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const conditions: string[] = [];
  const params: unknown[] = [];
  const requestedTenantId = c.req.query('filter[tenant_id]') || c.req.query('tenant_id');
  const tenantFilter = await resolveTenantIdFilter(c, requestedTenantId);
  if (!tenantFilter.ok) {
    return tenantFilter.response;
  }
  if (tenantFilter.tenantId) {
    conditions.push('tenant_id = ?');
    params.push(tenantFilter.tenantId);
  }
  const state = c.req.query('filter[state]') || c.req.query('state');
  if (state) {
    conditions.push('state = ?');
    params.push(state);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  try {
    const rows = await getAdminAdapter(c).query<Record<string, unknown>>(
      `SELECT id, quota_policy_id, tenant_id, tenant_key, log_type, plane, lane,
              metric_name, window_kind, window_start_at, window_end_at, value,
              soft_limit, hard_limit, state, enforcement_action, evaluated_at,
              notification_event_id, metadata_json
       FROM logging_quota_evaluations
       ${where}
       ORDER BY evaluated_at DESC
       LIMIT ?`,
      [...params, parseLimit(c, 50, 200)]
    );
    return c.json(adminListEnvelope(rows));
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.get('/usage-summary', async (c) => {
  const authContext = getAuth(c);
  if (
    !hasAnyPermission(authContext, [
      ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ,
      ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ,
    ])
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const requestedTenantKey = c.req.query('filter[tenant_key]') || c.req.query('tenant_key');
  const requestedTenantId = c.req.query('filter[tenant_id]') || c.req.query('tenant_id');
  const tenantKeyFilter = await resolveTenantKeyOrTenantIdFilter(c, {
    tenantKey: requestedTenantKey,
    tenantId: requestedTenantId,
  });
  if (!tenantKeyFilter.ok) {
    return tenantKeyFilter.response;
  }
  const tenantIdFilter = await resolveTenantIdFilter(c, requestedTenantId);
  if (!tenantIdFilter.ok) {
    return tenantIdFilter.response;
  }
  const from = parseSince(c) ?? Date.now() - 24 * 60 * 60 * 1000;
  const to = parseUntil(c);

  try {
    const adapter = getAdminAdapter(c);
    const deliveryConditions = ['bucket_start_at >= ?'];
    const deliveryParams: unknown[] = [from];
    const catalogConditions = ['created_at >= ?'];
    const catalogParams: unknown[] = [from];
    const dlqConditions = ['created_at >= ?'];
    const dlqParams: unknown[] = [from];
    if (to) {
      deliveryConditions.push('bucket_start_at <= ?');
      deliveryParams.push(to);
      catalogConditions.push('created_at <= ?');
      catalogParams.push(to);
      dlqConditions.push('created_at <= ?');
      dlqParams.push(to);
    }
    if (tenantKeyFilter.tenantKey) {
      deliveryConditions.push('tenant_key = ?');
      deliveryParams.push(tenantKeyFilter.tenantKey);
      catalogConditions.push('tenant_key = ?');
      catalogParams.push(tenantKeyFilter.tenantKey);
      dlqConditions.push('tenant_key = ?');
      dlqParams.push(tenantKeyFilter.tenantKey);
    }

    const sensitiveConditions = ['created_at >= ?'];
    const sensitiveParams: unknown[] = [from];
    if (to) {
      sensitiveConditions.push('created_at <= ?');
      sensitiveParams.push(to);
    }
    if (tenantIdFilter.tenantId) {
      sensitiveConditions.push('tenant_id = ?');
      sensitiveParams.push(tenantIdFilter.tenantId);
    }

    const [delivery, catalog, dlq, sensitiveDetail] = await Promise.all([
      adapter.query<Record<string, unknown>>(
        `SELECT tenant_key, log_type, plane, lane, status,
                SUM(batch_count) AS batch_count,
                SUM(record_count) AS record_count,
                SUM(byte_count) AS byte_count,
                SUM(attempt_count_sum) AS attempt_count_sum
         FROM logging_delivery_event_aggregates
         WHERE ${deliveryConditions.join(' AND ')}
         GROUP BY tenant_key, log_type, plane, lane, status
         ORDER BY tenant_key ASC, log_type ASC, plane ASC, lane ASC, status ASC
         LIMIT ?`,
        [...deliveryParams, parseLimit(c, 100, 500)]
      ),
      adapter.query<Record<string, unknown>>(
        `SELECT tenant_key, log_type, plane, object_kind, status,
                COUNT(*) AS object_count,
                SUM(record_count) AS record_count,
                SUM(byte_count) AS byte_count
         FROM log_object_catalog
         WHERE ${catalogConditions.join(' AND ')}
         GROUP BY tenant_key, log_type, plane, object_kind, status
         ORDER BY tenant_key ASC, log_type ASC, plane ASC, object_kind ASC, status ASC
         LIMIT ?`,
        [...catalogParams, parseLimit(c, 100, 500)]
      ),
      adapter.query<Record<string, unknown>>(
        `SELECT tenant_key, lane, status, payload_type,
                COUNT(*) AS item_count,
                SUM(attempt_count) AS attempt_count_sum
         FROM logging_dlq_items
         WHERE ${dlqConditions.join(' AND ')}
         GROUP BY tenant_key, lane, status, payload_type
         ORDER BY tenant_key ASC, lane ASC, status ASC, payload_type ASC
         LIMIT ?`,
        [...dlqParams, parseLimit(c, 100, 500)]
      ),
      adapter.query<Record<string, unknown>>(
        `SELECT tenant_id, object_class,
                COUNT(*) AS chunk_index_count,
                SUM(byte_length) AS byte_count,
                MAX(created_at) AS last_created_at
         FROM sensitive_detail_chunk_index
         WHERE ${sensitiveConditions.join(' AND ')}
         GROUP BY tenant_id, object_class
         ORDER BY tenant_id ASC, object_class ASC
         LIMIT ?`,
        [...sensitiveParams, parseLimit(c, 100, 500)]
      ),
    ]);

    return c.json(
      adminDetailEnvelope({
        window_start_at: from,
        window_end_at: to,
        tenant_key: tenantKeyFilter.tenantKey,
        tenant_id: tenantIdFilter.tenantId,
        delivery,
        catalog,
        dlq,
        sensitive_detail: sensitiveDetail,
      })
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.get('/notifications', async (c) => {
  const authContext = getAuth(c);
  if (
    !hasAnyPermission(authContext, [
      ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ,
      ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ,
    ])
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const conditions = [
    `category IN (
      'logging_destination_health',
      'logging_delivery_failure',
      'logging_fallback_used',
      'logging_dlq_backlog'
    )`,
  ];
  const params: unknown[] = [];
  const requestedTenantId = c.req.query('filter[tenant_id]') || c.req.query('tenant_id');
  const tenantIdFilter = await resolveTenantIdFilter(c, requestedTenantId);
  if (!tenantIdFilter.ok) {
    return tenantIdFilter.response;
  }
  const tenantId = tenantIdFilter.tenantId;
  const status = c.req.query('filter[status]') || c.req.query('status');
  const severity = c.req.query('filter[severity]') || c.req.query('severity');
  const from = parseSince(c);
  const to = parseUntil(c);

  if (tenantId) {
    conditions.push('tenant_id = ?');
    params.push(tenantId);
  }
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  } else {
    conditions.push("status IN ('pending', 'failed', 'dead_letter')");
  }
  if (severity) {
    conditions.push('severity = ?');
    params.push(severity);
  }
  if (from) {
    conditions.push('created_at >= ?');
    params.push(new Date(from).toISOString());
  }
  if (to) {
    conditions.push('created_at <= ?');
    params.push(new Date(to).toISOString());
  }

  try {
    const adapter = getAdminAdapter(c);
    const rows = await adapter.query<Record<string, unknown>>(
      `SELECT id, tenant_id, category, event_type, severity, status,
              deduplication_key, payload_json, attempts, last_error,
              next_attempt_at, created_at, updated_at, delivered_at
       FROM internal_notification_events
       WHERE ${conditions.join(' AND ')}
       ORDER BY
         CASE severity
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'medium' THEN 2
           WHEN 'low' THEN 3
           ELSE 4
         END,
         created_at DESC
       LIMIT ?`,
      [...params, parseLimit(c, 25, 100)]
    );

    return c.json(adminListEnvelope(rows));
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.post('/notifications/:id/resolve', async (c) => {
  const authContext = getAuth(c);
  if (
    !hasAnyPermission(authContext, [
      ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ,
      ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ,
    ])
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const adapter = getAdminAdapter(c);
    const id = c.req.param('id');
    const row = await adapter.queryOne<{
      id: string;
      tenant_id: string;
      category: string;
      event_type: string;
      severity: string;
      status: string;
    }>(
      `SELECT id, tenant_id, category, event_type, severity, status
       FROM internal_notification_events
       WHERE id = ?
         AND category IN (
           'logging_destination_health',
           'logging_delivery_failure',
           'logging_fallback_used',
           'logging_dlq_backlog'
         )`,
      [id]
    );
    if (!row) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const accessError = await requireTenantIdAccess(c, row.tenant_id);
    if (accessError) {
      return accessError;
    }
    if (!['pending', 'failed', 'dead_letter'].includes(row.status)) {
      return createAdminFieldErrorResponse(c, [
        fieldError('status', 'invalid_state', 'Only unresolved notifications can be resolved.'),
      ]);
    }

    const nowIso = new Date().toISOString();
    await adapter.execute(
      `UPDATE internal_notification_events
       SET status = 'suppressed',
           updated_at = ?,
           last_error = NULL,
           next_attempt_at = NULL
       WHERE id = ?`,
      [nowIso, row.id]
    );
    const auditId = await writeAdminAuditLog(c, {
      action: 'logging_notification.resolve',
      resourceType: 'internal_notification_event',
      resourceId: row.id,
      result: 'success',
      severity: row.severity === 'critical' || row.severity === 'high' ? 'warn' : 'info',
      metadata: {
        tenant_id: row.tenant_id,
        category: row.category,
        event_type: row.event_type,
        previous_status: row.status,
        next_status: 'suppressed',
      },
    });

    return c.json(
      adminActionEnvelope(
        {
          id: row.id,
          status: 'suppressed',
          updated_at: nowIso,
        },
        { auditId }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

notificationsRouter.get('/', async (c) => {
  const authContext = getAuth(c);
  if (!hasAnyPermission(authContext, NOTIFICATION_CENTER_READ_PERMISSIONS)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const requestedTenantId = c.req.query('filter[tenant_id]') || c.req.query('tenant_id');
  const tenantIdFilter = await resolveTenantIdFilter(c, requestedTenantId);
  if (!tenantIdFilter.ok) {
    return tenantIdFilter.response;
  }
  const requestedCategories = parseCsvQueryValues(
    c.req.query('filter[category]') || c.req.query('category')
  );
  const status = c.req.query('filter[status]') || c.req.query('status') || 'unresolved';
  const severity = c.req.query('filter[severity]') || c.req.query('severity');
  const from = parseSince(c);
  const to = parseUntil(c);

  const fields: ReturnType<typeof fieldError>[] = [];
  const invalidCategories = requestedCategories.filter(
    (category) => !NOTIFICATION_CENTER_CATEGORIES.includes(category as never)
  );
  if (invalidCategories.length > 0) {
    fields.push(fieldError('category', 'invalid_value', 'Notification category is not supported.'));
  }
  if (
    status !== 'all' &&
    status !== 'unresolved' &&
    !NOTIFICATION_CENTER_STATUSES.includes(status as never)
  ) {
    fields.push(fieldError('status', 'invalid_value', 'Notification status is not supported.'));
  }
  if (severity && !NOTIFICATION_CENTER_SEVERITIES.includes(severity as never)) {
    fields.push(fieldError('severity', 'invalid_value', 'Notification severity is not supported.'));
  }
  if (fields.length > 0) {
    return createAdminFieldErrorResponse(c, fields);
  }

  const conditions: string[] = [];
  const params: unknown[] = [];
  const categories =
    requestedCategories.length > 0 ? requestedCategories : [...NOTIFICATION_CENTER_CATEGORIES];
  conditions.push(`category IN (${sqlPlaceholders(categories)})`);
  params.push(...categories);

  if (tenantIdFilter.tenantId) {
    conditions.push('tenant_id = ?');
    params.push(tenantIdFilter.tenantId);
  }
  if (status === 'unresolved') {
    conditions.push(`status IN (${sqlPlaceholders(NOTIFICATION_CENTER_UNRESOLVED_STATUSES)})`);
    params.push(...NOTIFICATION_CENTER_UNRESOLVED_STATUSES);
  } else if (status !== 'all') {
    conditions.push('status = ?');
    params.push(status);
  }
  if (severity) {
    conditions.push('severity = ?');
    params.push(severity);
  }
  if (from) {
    conditions.push('created_at >= ?');
    params.push(new Date(from).toISOString());
  }
  if (to) {
    conditions.push('created_at <= ?');
    params.push(new Date(to).toISOString());
  }

  try {
    const adapter = getAdminAdapter(c);
    const whereClause = conditions.join(' AND ');
    const limit = parseLimit(c, 50, 200);
    const [rows, summary, totalRow] = await Promise.all([
      adapter.query<Record<string, unknown>>(
        `SELECT id, tenant_id, category, event_type, severity, status,
                deduplication_key, payload_json, attempts, last_error,
                next_attempt_at, created_at, updated_at, delivered_at
         FROM internal_notification_events
         WHERE ${whereClause}
         ORDER BY
           CASE severity
             WHEN 'critical' THEN 0
             WHEN 'high' THEN 1
             WHEN 'medium' THEN 2
             WHEN 'low' THEN 3
             ELSE 4
           END,
           created_at DESC
         LIMIT ?`,
        [...params, limit]
      ),
      adapter.query<Record<string, unknown>>(
        `SELECT category, severity, status, COUNT(*) AS count
         FROM internal_notification_events
         WHERE ${whereClause}
        GROUP BY category, severity, status
         ORDER BY category ASC, severity ASC, status ASC`,
        params
      ),
      adapter.queryOne<{ total: number | string }>(
        `SELECT COUNT(*) AS total
         FROM internal_notification_events
         WHERE ${whereClause}`,
        params
      ),
    ]);

    return c.json(
      adminListEnvelope(rows, {
        total: Number(totalRow?.total ?? rows.length),
        page: {
          filters: {
            tenant_id: tenantIdFilter.tenantId,
            categories,
            status,
            severity: severity ?? null,
            time_start: from ?? null,
            time_end: to ?? null,
          },
          summary,
        },
      })
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

notificationsRouter.post('/:id/resolve', async (c) => {
  const authContext = getAuth(c);
  if (!hasAnyPermission(authContext, NOTIFICATION_CENTER_READ_PERMISSIONS)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const adapter = getAdminAdapter(c);
    const id = c.req.param('id');
    const row = await adapter.queryOne<{
      id: string;
      tenant_id: string;
      category: string;
      event_type: string;
      severity: string;
      status: string;
    }>(
      `SELECT id, tenant_id, category, event_type, severity, status
       FROM internal_notification_events
       WHERE id = ?
         AND category IN (${sqlPlaceholders([...NOTIFICATION_CENTER_CATEGORIES])})`,
      [id, ...NOTIFICATION_CENTER_CATEGORIES]
    );
    if (!row) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const accessError = await requireTenantIdAccess(c, row.tenant_id);
    if (accessError) {
      return accessError;
    }
    if (!NOTIFICATION_CENTER_UNRESOLVED_STATUSES.includes(row.status)) {
      return createAdminFieldErrorResponse(c, [
        fieldError('status', 'invalid_state', 'Only unresolved notifications can be resolved.'),
      ]);
    }

    const nowIso = new Date().toISOString();
    await adapter.execute(
      `UPDATE internal_notification_events
       SET status = 'suppressed',
           updated_at = ?,
           last_error = NULL,
           next_attempt_at = NULL
       WHERE id = ?`,
      [nowIso, row.id]
    );
    const auditId = await writeAdminAuditLog(c, {
      action: 'internal_notification.resolve',
      resourceType: 'internal_notification_event',
      resourceId: row.id,
      result: 'success',
      severity: row.severity === 'critical' || row.severity === 'high' ? 'warn' : 'info',
      metadata: {
        tenant_id: row.tenant_id,
        category: row.category,
        event_type: row.event_type,
        previous_status: row.status,
        next_status: 'suppressed',
      },
    });

    return c.json(
      adminActionEnvelope(
        {
          id: row.id,
          status: 'suppressed',
          updated_at: nowIso,
        },
        { auditId }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

notificationsRouter.get('/delivery-routes', async (c) => {
  const authContext = getAuth(c);
  if (!hasAnyPermission(authContext, NOTIFICATION_CENTER_READ_PERMISSIONS)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (!hasPlatformAuthority(authContext)) {
    conditions.push('(scope_type = ? AND scope_id = ?)');
    params.push('tenant', getTenantIdFromContext(c));
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  try {
    const rows = await getAdminAdapter(c).query<NotificationDeliveryRouteRow>(
      `SELECT id, name, scope_type, scope_id, provider, destination_id, categories_json,
              severities_json, min_severity, enabled, failure_policy, max_attempts,
              retry_after_seconds, suppression_key, created_by, updated_by,
              created_at, updated_at, version
       FROM internal_notification_delivery_routes
       ${where}
       ORDER BY scope_type ASC, scope_id ASC, name ASC
       LIMIT ?`,
      [...params, parseLimit(c, 100, 500)]
    );
    return c.json(adminListEnvelope(rows));
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

notificationsRouter.post('/delivery-routes', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const parsed = await readNotificationDeliveryRouteBody(c);
  if (!parsed.ok) {
    return parsed.response;
  }

  try {
    const adapter = getAdminAdapter(c);
    const now = Date.now();
    const id = createLoggingId('indr', now);
    const value = parsed.value;
    await adapter.execute(
      `INSERT INTO internal_notification_delivery_routes (
        id, name, scope_type, scope_id, provider, destination_id, categories_json,
        severities_json, min_severity, enabled, failure_policy, max_attempts,
        retry_after_seconds, suppression_key, created_by, updated_by, created_at,
        updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        id,
        value.name,
        value.scopeType,
        value.scopeId,
        value.provider,
        value.destinationId,
        value.categories ? JSON.stringify(value.categories) : null,
        value.severities ? JSON.stringify(value.severities) : null,
        value.minSeverity,
        value.enabled ? 1 : 0,
        value.failurePolicy,
        value.maxAttempts,
        value.retryAfterSeconds,
        value.suppressionKey,
        authContext.userId ?? null,
        authContext.userId ?? null,
        now,
        now,
      ]
    );
    const auditId = await writeAdminAuditLog(c, {
      action: 'internal_notification.delivery_route.create',
      resourceType: 'internal_notification_delivery_route',
      resourceId: id,
      result: 'success',
      severity: 'info',
      metadata: value,
    });
    return c.json(adminMutationEnvelope({ id, version: 1, created_at: now }, { auditId }), 201);
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

notificationsRouter.post('/delivery/run', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatformAuthority(c);
  if (platformError) {
    return platformError;
  }
  const body = await parseJsonObject(c);
  const limit =
    typeof body.limit === 'number' && Number.isInteger(body.limit) && body.limit > 0
      ? Math.min(body.limit, 50)
      : 25;
  const now = Date.now();
  try {
    const adapter = getAdminAdapter(c);
    const events = await adapter.query<NotificationDeliveryEventRow>(
      `SELECT id, tenant_id, category, event_type, severity, status, payload_json, attempts
       FROM internal_notification_events
       WHERE status IN ('pending', 'failed')
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY
         CASE severity
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'medium' THEN 2
           WHEN 'low' THEN 3
           ELSE 4
         END,
         created_at ASC
       LIMIT ?`,
      [new Date(now).toISOString(), limit]
    );
    const routes = await adapter.query<NotificationDeliveryRouteRow>(
      `SELECT id, name, scope_type, scope_id, provider, destination_id, categories_json,
              severities_json, min_severity, enabled, failure_policy, max_attempts,
              retry_after_seconds, suppression_key, created_by, updated_by,
              created_at, updated_at, version
       FROM internal_notification_delivery_routes
       WHERE enabled = 1
       ORDER BY scope_type ASC, scope_id ASC, name ASC
       LIMIT 100`
    );
    const results: Record<string, unknown>[] = [];
    for (const event of events) {
      const matchingRoutes = routes.filter((route) => notificationRouteMatchesEvent(route, event));
      if (matchingRoutes.length === 0) {
        results.push({ event_id: event.id, status: 'skipped', reason: 'no_matching_route' });
        continue;
      }
      for (const route of matchingRoutes) {
        results.push({
          event_id: event.id,
          ...(await deliverNotificationViaRoute(c, { event, route, now })),
        });
      }
    }
    const auditId = await writeAdminAuditLog(c, {
      action: 'internal_notification.delivery.run',
      resourceType: 'internal_notification_event',
      resourceId: 'bulk-delivery',
      result: 'success',
      severity: results.some((item) => item.status === 'failed') ? 'warn' : 'info',
      metadata: { requested_limit: limit, processed: results.length },
    });
    return c.json(adminActionEnvelope({ processed: results.length, results }, { auditId }));
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

notificationsRouter.post('/:id/deliver', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const id = c.req.param('id');
  const now = Date.now();
  try {
    const adapter = getAdminAdapter(c);
    const event = await adapter.queryOne<NotificationDeliveryEventRow>(
      `SELECT id, tenant_id, category, event_type, severity, status, payload_json, attempts
       FROM internal_notification_events
       WHERE id = ?`,
      [id]
    );
    if (!event) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const accessError = await requireTenantIdAccess(c, event.tenant_id);
    if (accessError) {
      return accessError;
    }
    const routes = await adapter.query<NotificationDeliveryRouteRow>(
      `SELECT id, name, scope_type, scope_id, provider, destination_id, categories_json,
              severities_json, min_severity, enabled, failure_policy, max_attempts,
              retry_after_seconds, suppression_key, created_by, updated_by,
              created_at, updated_at, version
       FROM internal_notification_delivery_routes
       WHERE enabled = 1
       ORDER BY scope_type ASC, scope_id ASC, name ASC
       LIMIT 100`
    );
    const matchingRoutes = routes.filter((route) => notificationRouteMatchesEvent(route, event));
    const results = [];
    for (const route of matchingRoutes) {
      results.push(await deliverNotificationViaRoute(c, { event, route, now }));
    }
    const auditId = await writeAdminAuditLog(c, {
      action: 'internal_notification.delivery.manual',
      resourceType: 'internal_notification_event',
      resourceId: event.id,
      result: 'success',
      severity: results.some((item) => item.status === 'failed') ? 'warn' : 'info',
      metadata: { route_count: matchingRoutes.length },
    });
    return c.json(
      adminActionEnvelope(
        { event_id: event.id, route_count: matchingRoutes.length, results },
        { auditId }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.post('/exports', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, LOGGING_EXPORT_CREATE_PERMISSION)) {
    return createAdminPermissionErrorResponse(c, {
      required_permission: LOGGING_EXPORT_CREATE_PERMISSION,
      reason: 'export_create_permission_required',
    });
  }

  const bucket = getLoggingExportBucket(c);
  if (!bucket) {
    return createAdminFieldErrorResponse(c, [
      fieldError('destination', 'bucket_unavailable', 'Export artifact bucket is unavailable.'),
    ]);
  }

  const body = await parseJsonObject(c);
  const format = body.format === 'csv' ? 'csv' : body.format === 'zip' ? 'zip' : 'jsonl';
  const requestedTenantKey = parseOptionalString(body.tenant_key) ?? undefined;
  const requestedTenantId = parseOptionalString(body.tenant_id) ?? undefined;
  const tenantKeyFilter = await resolveTenantKeyOrTenantIdFilter(c, {
    tenantKey: requestedTenantKey,
    tenantId: requestedTenantId,
  });
  if (!tenantKeyFilter.ok) {
    return tenantKeyFilter.response;
  }
  const tenantKey = tenantKeyFilter.tenantKey;
  const logType = readLogType(body.log_type);
  const plane = readLogPlane(body.plane);
  if (
    plane === 'sensitive_detail' &&
    !hasPermission(authContext, LOGGING_SENSITIVE_DETAIL_EXPORT_PERMISSION)
  ) {
    return createAdminPermissionErrorResponse(c, {
      required_permission: LOGGING_SENSITIVE_DETAIL_EXPORT_PERMISSION,
      reason: 'sensitive_detail_export_permission_required',
    });
  }
  const source =
    body.source === 'record_index' || body.include_records === true ? 'record_index' : 'catalog';
  const isSensitiveDetailExport = plane === 'sensitive_detail';
  const includePayload =
    (source === 'record_index' || isSensitiveDetailExport) &&
    parseOptionalBoolean(body.include_payload, false);
  const detailScope =
    body.detail_scope === 'full' || body.include_detail === true ? 'full' : 'none';
  if (
    detailScope === 'full' &&
    !hasPermission(authContext, LOGGING_SENSITIVE_DETAIL_EXPORT_PERMISSION)
  ) {
    return createAdminPermissionErrorResponse(c, {
      required_permission: LOGGING_SENSITIVE_DETAIL_EXPORT_PERMISSION,
      reason: 'sensitive_detail_export_permission_required',
    });
  }
  const timeStart =
    typeof body.time_start === 'number' && body.time_start > 0 ? body.time_start : null;
  const timeEnd = typeof body.time_end === 'number' && body.time_end > 0 ? body.time_end : null;
  const limit =
    typeof body.limit === 'number' && body.limit > 0
      ? Math.min(Math.trunc(body.limit), 5000)
      : 1000;
  const filters = {
    tenant_key: tenantKey,
    log_type: logType,
    plane,
    source,
    time_start: timeStart,
    time_end: timeEnd,
    limit,
    include_payload: includePayload,
    detail_scope: detailScope,
  };

  try {
    const adapter = getAdminAdapter(c);
    const now = Date.now();
    const id = createLoggingId('lexp', now);
    const messageJobId = createLoggingId('lmj', now);
    const expiresAt = now + 7 * 24 * 60 * 60 * 1000;
    const messagePayload: ExportBuildMessagePayload = {
      payload_type: 'export_build',
      schema_version: 1,
      payload_id: createLoggingId('qpl', now),
      message_job_id: messageJobId,
      tenant_key: tenantKey,
      lane: includePayload || source === 'record_index' ? 'bulk' : 'default',
      created_at: now,
      export_job_id: id,
      phase: 'plan',
      partition_strategy:
        plane === 'sensitive_detail'
          ? 'chunk_index'
          : source === 'record_index'
            ? 'query_page'
            : 'time_bucket_shard',
      snapshot_cutoff_at: now,
      requested_by: authContext.userId ?? 'unknown_admin',
    };
    const payloadBucket = getLoggingMessagePayloadBucket(c);
    if (!payloadBucket) {
      return createAdminFieldErrorResponse(c, [
        fieldError(
          'LOGGING_MESSAGE_PAYLOAD_BUCKET',
          'binding_unavailable',
          'No R2 bucket is configured for logging message payloads.'
        ),
      ]);
    }
    const payloadWrite = await writeLoggingMessagePayloadToR2({
      bucket: payloadBucket,
      jobId: messageJobId,
      payloadType: 'export_build',
      schemaVersion: 1,
      lane: messagePayload.lane,
      criticality: plane === 'sensitive_detail' ? 'critical' : 'standard',
      sourceType: 'payload_object',
      tenantKey,
      payload: { ...messagePayload, filters },
      now,
    });

    await adapter.execute(
      `INSERT INTO logging_export_jobs (
        id, tenant_key, log_type, plane, format, status, artifact_object_ref,
        manifest_object_ref, checksum_sha256, record_count, byte_count,
        requested_by, error_class, filter_json, created_at, updated_at,
        completed_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        tenantKey,
        logType,
        plane,
        format,
        'queued',
        null,
        null,
        null,
        0,
        0,
        authContext.userId,
        null,
        JSON.stringify(filters),
        now,
        now,
        null,
        expiresAt,
      ]
    );
    const store = new SqlLoggingMessageJobStore(adapter);
    const job = await store.createJob({
      id: messageJobId,
      kind: 'export_build',
      lane: messagePayload.lane,
      criticality: plane === 'sensitive_detail' ? 'critical' : 'standard',
      priority: plane === 'sensitive_detail' ? 100 : messagePayload.lane === 'bulk' ? 0 : 10,
      topology: {
        tenantKey,
        topologyType: tenantKey ? 'unknown' : 'platform',
        topologyResolvedAt: now,
      },
      scopeType: tenantKey ? 'tenant' : 'platform',
      scopeId: tenantKey,
      scopeKey: tenantKey ? `tenant:${tenantKey}` : 'platform',
      sourceType: 'payload_object',
      sourceId: id,
      payloadObjectRef: payloadWrite.objectRef,
      payloadSha256: payloadWrite.sha256,
      payloadType: 'export_build',
      payloadSchemaVersion: 1,
      redactedSummary: payloadWrite.redactedSummary,
      validationSummary: payloadWrite.validationSummary,
      idempotencyKey:
        parseOptionalString(body.idempotency_key) ?? ['export_build', id, now].join(':'),
      dedupeUntil: now + 24 * 60 * 60 * 1000,
      notBefore: now,
      maxAttempts: 5,
      attemptPolicy: {
        maxAttempts: 5,
        leaseTimeoutMs: 10 * 60 * 1000,
      },
      requestedBy: authContext.userId ?? 'unknown_admin',
      reason: 'logging export build requested',
      now,
      expiresAt,
    });
    await adapter.execute(
      `INSERT INTO logging_message_export_builds (
        id, message_job_id, export_job_id, phase, partition_strategy, partition_key,
        partition_index, partition_count, snapshot_cutoff_at,
        part_object_ref, part_checksum_sha256, part_record_count, part_byte_count,
        manifest_object_ref, final_checksum_sha256, final_record_count, final_byte_count,
        skipped_count, pending_count, late_arriving_count, cleanup_status,
        metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        createLoggingId('lexp', now),
        job.id,
        id,
        'plan',
        messagePayload.partition_strategy ?? null,
        null,
        null,
        null,
        messagePayload.snapshot_cutoff_at,
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
        null,
        JSON.stringify({ filters }),
        now,
        now,
      ]
    );
    const enqueueResult = await enqueueLoggingMessagePayload(
      messagePayload,
      c.env as unknown as Record<string, unknown>
    );
    const auditId = await writeAdminAuditLog(c, {
      action: 'logging_export.create',
      resourceType: 'logging_export_job',
      resourceId: id,
      result: 'success',
      severity: 'info',
      metadata: {
        export_id: id,
        message_job_id: job.id,
        format,
        status: 'queued',
        queue_payload_id: enqueueResult.payloadId,
        queue_binding: enqueueResult.bindingName,
      },
    });

    return c.json(
      adminActionEnvelope(
        {
          id,
          job_id: id,
          message_job_id: job.id,
          status: 'queued',
          format,
          queued: enqueueResult.queued,
          queue_binding: enqueueResult.bindingName,
          polling: {
            export: `/api/admin/logging-policies/exports/${id}`,
            message_job: `/api/admin/logging-policies/message-jobs/${job.id}`,
          },
          created_at: now,
          expires_at: expiresAt,
        },
        { auditId }
      ),
      202
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.get('/message-jobs', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const requestedTenantKey = c.req.query('filter[tenant_key]') || c.req.query('tenant_key');
  const requestedTenantId = c.req.query('filter[tenant_id]') || c.req.query('tenant_id');
  const tenantKeyFilter = await resolveTenantKeyOrTenantIdFilter(c, {
    tenantKey: requestedTenantKey,
    tenantId: requestedTenantId,
  });
  if (!tenantKeyFilter.ok) {
    return tenantKeyFilter.response;
  }

  const kindRaw = c.req.query('filter[kind]') || c.req.query('kind');
  const statusRaw = c.req.query('filter[status]') || c.req.query('status');
  const laneRaw = c.req.query('filter[lane]') || c.req.query('lane');
  const sourceTypeRaw = c.req.query('filter[source_type]') || c.req.query('source_type');
  const kind = readLoggingMessageKind(kindRaw);
  const status = readLoggingMessageStatus(statusRaw);
  const lane = readLoggingMessageLane(laneRaw);
  const sourceType = readLoggingMessageSourceType(sourceTypeRaw);
  const errors = [
    kindRaw && !kind ? fieldError('kind', 'invalid_kind', 'Unsupported message job kind.') : null,
    statusRaw && !status
      ? fieldError('status', 'invalid_status', 'Unsupported message job status.')
      : null,
    laneRaw && !lane ? fieldError('lane', 'invalid_lane', 'Unsupported delivery lane.') : null,
    sourceTypeRaw && !sourceType
      ? fieldError('source_type', 'invalid_source_type', 'Unsupported message source type.')
      : null,
  ].filter((error): error is ReturnType<typeof fieldError> => error !== null);
  if (errors.length > 0) {
    return createAdminFieldErrorResponse(c, errors);
  }

  try {
    const store = new SqlLoggingMessageJobStore(getAdminAdapter(c));
    const limit = parseLimit(c);
    const offset = parseOffset(c);
    const items = await store.listJobs({
      tenantKey: tenantKeyFilter.tenantKey ?? undefined,
      kind,
      status,
      lane,
      sourceType,
      sourceId: c.req.query('filter[source_id]') || c.req.query('source_id') || undefined,
      rootJobId: c.req.query('filter[root_job_id]') || c.req.query('root_job_id') || undefined,
      parentJobId:
        c.req.query('filter[parent_job_id]') || c.req.query('parent_job_id') || undefined,
      createdAfter: parseSince(c) ?? undefined,
      createdBefore: parseUntil(c) ?? undefined,
      limit,
      offset,
    });
    return c.json(
      adminListEnvelope(items.map(serializeLoggingMessageJob), {
        total: items.length,
        page: {
          limit,
          offset,
          has_more: items.length === limit,
        },
      })
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.get('/message-job-repair-findings', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const requestedTenantKey = c.req.query('filter[tenant_key]') || c.req.query('tenant_key');
  const requestedTenantId = c.req.query('filter[tenant_id]') || c.req.query('tenant_id');
  const tenantKeyFilter = await resolveTenantKeyOrTenantIdFilter(c, {
    tenantKey: requestedTenantKey,
    tenantId: requestedTenantId,
  });
  if (!tenantKeyFilter.ok) {
    return tenantKeyFilter.response;
  }

  const statusRaw = c.req.query('filter[status]') || c.req.query('status');
  const severityRaw = c.req.query('filter[severity]') || c.req.query('severity');
  const findingTypeRaw = c.req.query('filter[finding_type]') || c.req.query('finding_type');
  const status = readLoggingMessageRepairStatus(statusRaw);
  const severity = readLoggingMessageRepairSeverity(severityRaw);
  const findingType = readLoggingMessageRepairFindingType(findingTypeRaw);
  const errors = [
    statusRaw && !status
      ? fieldError('status', 'invalid_status', 'Unsupported repair finding status.')
      : null,
    severityRaw && !severity
      ? fieldError('severity', 'invalid_severity', 'Unsupported repair finding severity.')
      : null,
    findingTypeRaw && !findingType
      ? fieldError('finding_type', 'invalid_finding_type', 'Unsupported repair finding type.')
      : null,
  ].filter((error): error is ReturnType<typeof fieldError> => error !== null);
  if (errors.length > 0) {
    return createAdminFieldErrorResponse(c, errors);
  }

  try {
    const store = new SqlLoggingMessageJobStore(getAdminAdapter(c));
    const limit = parseLimit(c);
    const offset = parseOffset(c);
    const items = await store.listRepairFindings({
      tenantKey: tenantKeyFilter.tenantKey ?? undefined,
      status,
      severity,
      findingType,
      messageJobId:
        c.req.query('filter[message_job_id]') || c.req.query('message_job_id') || undefined,
      limit,
      offset,
    });
    return c.json(
      adminListEnvelope(items.map(serializeLoggingMessageRepairFinding), {
        total: items.length,
        page: {
          limit,
          offset,
          has_more: items.length === limit,
        },
      })
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.post('/message-job-repair-findings/apply-safe', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const body = await parseJsonObject(c);
  const findingId = parseOptionalString(body.finding_id);
  const limit =
    typeof body.limit === 'number' && Number.isInteger(body.limit) && body.limit > 0
      ? Math.min(body.limit, 50)
      : 25;

  try {
    const adapter = getAdminAdapter(c);
    const store = new SqlLoggingMessageJobStore(adapter);
    const findings = findingId
      ? [await store.getRepairFinding(findingId)].filter(
          (finding): finding is LoggingMessageJobRepairFindingRecord => finding !== null
        )
      : await store.listRepairFindings({
          status: 'open',
          findingType: 'missing_export_part',
          limit,
        });
    const applied: Record<string, unknown>[] = [];
    const skipped: Record<string, unknown>[] = [];
    const now = Date.now();
    for (const finding of findings) {
      const accessError = await requireTenantKeyAccess(c, finding.tenantKey);
      if (accessError) {
        return accessError;
      }
      if (
        finding.status !== 'open' ||
        finding.findingType !== 'missing_export_part' ||
        finding.safeAction !== 'rebuild_export_partition'
      ) {
        skipped.push({
          id: finding.id,
          reason: 'not_safe_rebuild_candidate',
          status: finding.status,
          finding_type: finding.findingType,
        });
        continue;
      }
      const exportJobId = readExportJobIdFromRepairFinding(finding);
      if (!exportJobId) {
        skipped.push({ id: finding.id, reason: 'export_job_id_missing' });
        continue;
      }
      const exportJob = await getLoggingExportJobForRepair(adapter, exportJobId);
      if (!exportJob) {
        skipped.push({
          id: finding.id,
          reason: 'export_job_not_found',
          export_job_id: exportJobId,
        });
        continue;
      }
      const repairJob = await enqueueExportBuildRepairJob({
        c,
        adapter,
        exportJob,
        finding,
        now,
      });
      await store.markRepairFindingApplied({
        id: finding.id,
        status: 'safe_repaired',
        appliedBy: authContext.userId ?? 'unknown_admin',
        now,
      });
      applied.push({
        id: finding.id,
        export_job_id: exportJob.id,
        message_job_id: repairJob.jobId,
        queued: repairJob.queued,
        queue_binding: repairJob.queueBinding,
        payload_object_ref: repairJob.payloadObjectRef,
      });
    }

    const auditId = await writeAdminAuditLog(c, {
      action: 'logging.message_job_repair.apply_safe',
      resourceType: 'logging_message_repair_finding',
      resourceId: findingId ?? 'bulk-safe-repair',
      result: 'success',
      severity: applied.length > 0 ? 'warn' : 'info',
      metadata: {
        requested_finding_id: findingId ?? null,
        applied_count: applied.length,
        skipped_count: skipped.length,
      },
    });

    return c.json(
      adminActionEnvelope(
        {
          applied_count: applied.length,
          skipped_count: skipped.length,
          applied,
          skipped,
        },
        { auditId }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.post('/message-job-repair-findings/:id/dangerous/preview', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const store = new SqlLoggingMessageJobStore(getAdminAdapter(c));
    const finding = await store.getRepairFinding(c.req.param('id'));
    if (!finding) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const accessError = await requireTenantKeyAccess(c, finding.tenantKey);
    if (accessError) {
      return accessError;
    }
    if (finding.dangerousAction !== 'mark_export_failed_and_cleanup_manifest') {
      return createAdminFieldErrorResponse(c, [
        fieldError(
          'finding_id',
          'not_dangerous_repairable',
          'Finding has no supported dangerous repair.'
        ),
      ]);
    }
    const exportJobId = readExportJobIdFromRepairFinding(finding);
    if (!exportJobId) {
      return createAdminFieldErrorResponse(c, [
        fieldError(
          'impact.export_job_id',
          'required',
          'Repair finding does not include export job id.'
        ),
      ]);
    }
    const exportJob = await getLoggingExportJobForRepair(getAdminAdapter(c), exportJobId);
    return c.json(
      adminDetailEnvelope({
        action: 'mark_export_failed_and_cleanup_manifest',
        finding_id: finding.id,
        export_job_id: exportJobId,
        confirmation: buildMessageRepairConfirmation(finding.id),
        impact: {
          finding: serializeLoggingMessageRepairFinding(finding),
          export_job: exportJob,
          deletes_objects: [finding.impact?.part_object_ref, exportJob?.manifest_object_ref].filter(
            (value): value is string => typeof value === 'string' && value.length > 0
          ),
          updates: [
            'logging_export_jobs',
            'logging_message_export_builds',
            'logging_message_repair_findings',
          ],
        },
      })
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.post('/message-job-repair-findings/:id/dangerous/apply', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const body = await parseJsonObject(c);
  const confirmation = parseOptionalString(body.confirmation);
  const findingId = c.req.param('id');
  const expectedConfirmation = buildMessageRepairConfirmation(findingId);
  if (confirmation !== expectedConfirmation) {
    return createAdminFieldErrorResponse(c, [
      fieldError(
        'confirmation',
        'confirmation_mismatch',
        `Confirmation must be "${expectedConfirmation}".`
      ),
    ]);
  }

  try {
    const adapter = getAdminAdapter(c);
    const store = new SqlLoggingMessageJobStore(adapter);
    const finding = await store.getRepairFinding(findingId);
    if (!finding) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const accessError = await requireTenantKeyAccess(c, finding.tenantKey);
    if (accessError) {
      return accessError;
    }
    if (finding.dangerousAction !== 'mark_export_failed_and_cleanup_manifest') {
      return createAdminFieldErrorResponse(c, [
        fieldError(
          'finding_id',
          'not_dangerous_repairable',
          'Finding has no supported dangerous repair.'
        ),
      ]);
    }
    const exportJobId = readExportJobIdFromRepairFinding(finding);
    if (!exportJobId) {
      return createAdminFieldErrorResponse(c, [
        fieldError(
          'impact.export_job_id',
          'required',
          'Repair finding does not include export job id.'
        ),
      ]);
    }
    const exportJob = await getLoggingExportJobForRepair(adapter, exportJobId);
    const bucket = getLoggingExportBucket(c);
    const partObjectRef = finding.impact?.part_object_ref;
    if (bucket && typeof partObjectRef === 'string') {
      await bucket.delete(partObjectRef);
    }
    if (bucket && exportJob?.manifest_object_ref) {
      await bucket.delete(exportJob.manifest_object_ref);
    }
    const now = Date.now();
    await adapter.execute(
      `UPDATE logging_export_jobs
       SET status = ?, artifact_object_ref = NULL, manifest_object_ref = NULL,
           error_class = ?, updated_at = ?, completed_at = ?
       WHERE id = ?`,
      ['failed', 'dangerous_repair_applied', now, now, exportJobId]
    );
    await adapter.execute(
      `UPDATE logging_message_export_builds
       SET cleanup_status = ?, metadata_json = ?, updated_at = ?
       WHERE export_job_id = ?`,
      [
        'completed',
        JSON.stringify({
          dangerous_repair: true,
          finding_id: finding.id,
          action: finding.dangerousAction,
          applied_by: authContext.userId ?? 'unknown_admin',
        }),
        now,
        exportJobId,
      ]
    );
    await store.markRepairFindingApplied({
      id: finding.id,
      status: 'dangerous_applied',
      appliedBy: authContext.userId ?? 'unknown_admin',
      now,
    });
    const auditId = await writeAdminAuditLog(c, {
      action: 'logging.message_job_repair.apply_dangerous',
      resourceType: 'logging_message_repair_finding',
      resourceId: finding.id,
      result: 'success',
      severity: 'critical',
      metadata: {
        action: finding.dangerousAction,
        export_job_id: exportJobId,
        confirmation,
        impact: finding.impact,
      },
    });

    return c.json(
      adminActionEnvelope(
        {
          action: finding.dangerousAction,
          finding_id: finding.id,
          export_job_id: exportJobId,
          applied_at: now,
        },
        { auditId }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.get('/message-jobs/:id', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const store = new SqlLoggingMessageJobStore(getAdminAdapter(c));
    const job = await store.getJob(c.req.param('id'));
    if (!job) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const accessError = await requireTenantKeyAccess(c, job.tenantKey);
    if (accessError) {
      return accessError;
    }
    return c.json(adminDetailEnvelope(serializeLoggingMessageJob(job)));
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.post('/message-jobs/:id/cancel', async (c) => {
  const authContext = getAuth(c);
  const id = c.req.param('id');

  try {
    const store = new SqlLoggingMessageJobStore(getAdminAdapter(c));
    const job = await store.getJob(id);
    if (!job) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const requiredPermission =
      job.kind === 'retry_delivery'
        ? LOGGING_DELIVERY_RETRY_PERMISSION
        : LOGGING_EXPORT_CREATE_PERMISSION;
    if (!hasPermission(authContext, requiredPermission)) {
      return createAdminPermissionErrorResponse(c, {
        required_permission: requiredPermission,
        reason: 'message_job_cancel_permission_required',
      });
    }
    const accessError = await requireTenantKeyAccess(c, job.tenantKey);
    if (accessError) {
      return accessError;
    }
    if (!['queued', 'retrying', 'claimed', 'running'].includes(job.status)) {
      return createAdminFieldErrorResponse(c, [
        fieldError(
          'status',
          'not_cancellable',
          'Message job is not cancellable in its current state.'
        ),
      ]);
    }

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const now = Date.now();
    const cancelledBy = authContext.userId ?? 'unknown_admin';
    await store.requestCancel(id, cancelledBy, now);
    if (job.status === 'queued' || job.status === 'retrying') {
      await store.markCancelled(id, now);
    }
    if (job.kind === 'export_build') {
      const adapter = getAdminAdapter(c);
      await adapter.execute(
        `UPDATE logging_export_jobs
         SET status = ?, updated_at = ?, completed_at = ?
         WHERE id = ?`,
        ['cancelled', now, now, job.sourceId]
      );
      await adapter.execute(
        `UPDATE logging_message_export_builds
         SET cleanup_status = ?, updated_at = ?
         WHERE message_job_id = ?`,
        ['queued', now, job.id]
      );
      const payloadBucket = getLoggingMessagePayloadBucket(c);
      if (payloadBucket) {
        const cleanupJobId = createLoggingId('lmj', now + 1);
        const cleanupPayload: ExportBuildMessagePayload = {
          payload_type: 'export_build',
          schema_version: 1,
          payload_id: createLoggingId('qpl', now + 1),
          message_job_id: cleanupJobId,
          tenant_key: job.tenantKey,
          lane: 'bulk',
          created_at: now,
          export_job_id: job.sourceId,
          phase: 'cleanup',
          partition_strategy: 'manifest_shard',
          snapshot_cutoff_at: now,
          requested_by: cancelledBy,
          cleanup_reason: 'cancelled',
        };
        const payloadWrite = await writeLoggingMessagePayloadToR2({
          bucket: payloadBucket,
          jobId: cleanupJobId,
          payloadType: 'export_build',
          schemaVersion: 1,
          lane: cleanupPayload.lane,
          criticality: job.criticality,
          sourceType: 'payload_object',
          tenantKey: job.tenantKey,
          payload: cleanupPayload,
          now,
        });
        const cleanupJob = await store.createJob({
          id: cleanupJobId,
          kind: 'export_build',
          lane: cleanupPayload.lane,
          criticality: job.criticality,
          priority: 0,
          topology: {
            tenantId: job.tenantId,
            tenantKey: job.tenantKey,
            topologyType: job.topologyType,
            databaseBindingRef: job.databaseBindingRef,
            connectionRef: job.connectionRef,
            topologySnapshotVersion: job.topologySnapshotVersion,
            topologyResolvedAt: job.topologyResolvedAt ?? now,
          },
          scopeType: job.scopeType,
          scopeId: job.scopeId,
          scopeKey: job.scopeKey,
          sourceType: 'payload_object',
          sourceId: job.sourceId,
          rootJobId: job.rootJobId ?? job.id,
          parentJobId: job.id,
          depth: job.depth + 1,
          payloadObjectRef: payloadWrite.objectRef,
          payloadSha256: payloadWrite.sha256,
          payloadType: 'export_build',
          payloadSchemaVersion: 1,
          redactedSummary: payloadWrite.redactedSummary,
          validationSummary: payloadWrite.validationSummary,
          idempotencyKey: ['export_cleanup', job.sourceId, job.id, now].join(':'),
          dedupeUntil: now + 24 * 60 * 60 * 1000,
          notBefore: now,
          maxAttempts: 5,
          attemptPolicy: { maxAttempts: 5, leaseTimeoutMs: 10 * 60 * 1000 },
          requestedBy: cancelledBy,
          reason: 'logging export cancellation cleanup',
          now,
          expiresAt: job.expiresAt,
        });
        await adapter.execute(
          `INSERT INTO logging_message_export_builds (
            id, message_job_id, export_job_id, phase, partition_strategy, partition_key,
            partition_index, partition_count, snapshot_cutoff_at,
            part_object_ref, part_checksum_sha256, part_record_count, part_byte_count,
            manifest_object_ref, final_checksum_sha256, final_record_count, final_byte_count,
            skipped_count, pending_count, late_arriving_count, cleanup_status,
            metadata_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            createLoggingId('lexp', now + 1),
            cleanupJob.id,
            job.sourceId,
            'cleanup',
            cleanupPayload.partition_strategy ?? 'manifest_shard',
            'cancelled',
            0,
            1,
            cleanupPayload.snapshot_cutoff_at,
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
            'queued',
            JSON.stringify({ cleanup_reason: 'cancelled', cancelled_message_job_id: job.id }),
            now,
            now,
          ]
        );
        await enqueueLoggingMessagePayload(
          cleanupPayload,
          c.env as unknown as Record<string, unknown>
        );
      }
    }
    const updated = (await store.getJob(id)) ?? job;
    const auditId = await writeAdminAuditLog(c, {
      action: 'logging.message_job.cancel',
      resourceType: 'logging_message_job',
      resourceId: id,
      result: 'success',
      severity: job.criticality === 'critical' ? 'warn' : 'info',
      metadata: {
        message_job_id: id,
        kind: job.kind,
        previous_status: job.status,
        current_status: updated.status,
        tenant_key: job.tenantKey,
        reason: typeof body.reason === 'string' ? body.reason : null,
      },
    });

    return c.json(adminActionEnvelope(serializeLoggingMessageJob(updated), { auditId }));
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.get('/exports/:id', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const adapter = getAdminAdapter(c);
    const item = await adapter.queryOne<LoggingExportJobRow>(
      `SELECT id, tenant_key, log_type, plane, format, status, artifact_object_ref,
              manifest_object_ref, checksum_sha256, record_count, byte_count,
              requested_by, error_class, filter_json, created_at, updated_at,
              completed_at, expires_at
       FROM logging_export_jobs
       WHERE id = ?`,
      [c.req.param('id')]
    );
    if (!item) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const accessError = await requireTenantKeyAccess(c, item.tenant_key);
    if (accessError) {
      return accessError;
    }
    const sensitiveAccessError = await requireSensitiveDetailExportReadPermission(c, item);
    if (sensitiveAccessError) {
      return sensitiveAccessError;
    }
    return c.json(adminDetailEnvelope(item));
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.get('/exports/:id/artifact', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const bucket = getLoggingExportBucket(c);
    if (!bucket) {
      return createAdminFieldErrorResponse(c, [
        fieldError('destination', 'bucket_unavailable', 'Export artifact bucket is unavailable.'),
      ]);
    }
    const adapter = getAdminAdapter(c);
    const item = await adapter.queryOne<LoggingExportJobRow>(
      `SELECT id, tenant_key, log_type, plane, format, status, artifact_object_ref,
              manifest_object_ref, checksum_sha256, record_count, byte_count,
              requested_by, error_class, filter_json, created_at, updated_at,
              completed_at, expires_at
       FROM logging_export_jobs
       WHERE id = ?`,
      [c.req.param('id')]
    );
    if (!item?.artifact_object_ref && !item?.manifest_object_ref) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const accessError = await requireTenantKeyAccess(c, item.tenant_key);
    if (accessError) {
      return accessError;
    }
    const sensitiveAccessError = await requireSensitiveDetailExportReadPermission(c, item);
    if (sensitiveAccessError) {
      return sensitiveAccessError;
    }
    if (Number(item.byte_count) > LOGGING_EXPORT_ARTIFACT_INLINE_DOWNLOAD_MAX_BYTES) {
      return createAdminFieldErrorResponse(c, [
        fieldError(
          'artifact',
          'artifact_too_large_for_inline_download',
          'Export artifact is too large for inline API download.'
        ),
      ]);
    }
    if (item.artifact_object_ref) {
      if (!isLoggingExportObjectRefAllowed(item, item.artifact_object_ref)) {
        return createAdminFieldErrorResponse(c, [
          fieldError(
            'artifact_object_ref',
            'invalid_object_ref',
            'Export artifact ref is invalid.'
          ),
        ]);
      }
      const object = await bucket.get(item.artifact_object_ref);
      if (!object) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
      }
      if (item.format === 'zip') {
        const artifactRead = await readR2BytesWithLimit(
          object,
          LOGGING_EXPORT_ARTIFACT_INLINE_DOWNLOAD_MAX_BYTES
        );
        if (!artifactRead.ok) {
          return createAdminFieldErrorResponse(c, [
            fieldError(
              'artifact',
              'artifact_too_large_for_inline_download',
              'Export artifact is too large for inline API download.'
            ),
          ]);
        }
        return new Response(artifactRead.bytes, {
          headers: {
            'content-type': loggingExportContentType(item.format),
            'content-disposition': `attachment; filename="${safeDownloadFilenameBase(item.id)}.${loggingExportFileExtension(item.format)}"`,
            'x-content-type-options': 'nosniff',
            'cache-control': 'no-store',
          },
        });
      }
      const artifactRead = await readR2TextWithLimit(
        object,
        LOGGING_EXPORT_ARTIFACT_INLINE_DOWNLOAD_MAX_BYTES
      );
      if (!artifactRead.ok) {
        return createAdminFieldErrorResponse(c, [
          fieldError(
            'artifact',
            'artifact_too_large_for_inline_download',
            'Export artifact is too large for inline API download.'
          ),
        ]);
      }
      return new Response(artifactRead.text, {
        headers: {
          'content-type': loggingExportContentType(item.format),
          'content-disposition': `attachment; filename="${safeDownloadFilenameBase(item.id)}.${loggingExportFileExtension(item.format)}"`,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        },
      });
    }

    const manifestRef = item.manifest_object_ref;
    if (!manifestRef) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (!isLoggingExportObjectRefAllowed(item, manifestRef)) {
      return createAdminFieldErrorResponse(c, [
        fieldError('manifest_object_ref', 'invalid_object_ref', 'Export manifest ref is invalid.'),
      ]);
    }
    const manifestObject = await bucket.get(manifestRef);
    if (!manifestObject) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const manifestRead = await readR2TextWithLimit(
      manifestObject,
      LOGGING_EXPORT_MANIFEST_INLINE_READ_MAX_BYTES
    );
    if (!manifestRead.ok) {
      return createAdminFieldErrorResponse(c, [
        fieldError(
          'manifest_object_ref',
          'manifest_too_large_for_inline_download',
          'Export manifest is too large for inline API download.'
        ),
      ]);
    }
    let manifest: { parts?: Array<{ object_ref?: unknown }> };
    try {
      manifest = JSON.parse(manifestRead.text) as {
        parts?: Array<{ object_ref?: unknown }>;
      };
    } catch {
      return createAdminFieldErrorResponse(c, [
        fieldError('manifest_object_ref', 'manifest_malformed_json', 'Export manifest is invalid.'),
      ]);
    }
    const partRefs = (manifest.parts ?? [])
      .map((part) => part.object_ref)
      .filter((value): value is string => typeof value === 'string');
    if (partRefs.length > LOGGING_EXPORT_INLINE_PART_MAX_COUNT) {
      return createAdminFieldErrorResponse(c, [
        fieldError(
          'manifest.parts',
          'too_many_parts_for_inline_download',
          'Export has too many parts for inline API download.'
        ),
      ]);
    }
    if (partRefs.length === 0) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (item.format === 'zip' && partRefs.length > 1) {
      return createAdminFieldErrorResponse(c, [
        fieldError(
          'manifest.parts',
          'zip_multi_part_inline_download_unsupported',
          'ZIP exports with multiple parts must be downloaded part-by-part.'
        ),
      ]);
    }
    const invalidPartRef = partRefs.find(
      (partRef) => !isLoggingExportObjectRefAllowed(item, partRef)
    );
    if (invalidPartRef) {
      return createAdminFieldErrorResponse(c, [
        fieldError(
          'manifest.parts',
          'invalid_object_ref',
          'Export manifest contains invalid part refs.'
        ),
      ]);
    }
    const partTexts: string[] = [];
    let totalBytes = manifestRead.bytes;
    for (const [index, partRef] of partRefs.entries()) {
      const part = await bucket.get(partRef);
      if (!part) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
      }
      const remainingBytes = LOGGING_EXPORT_ARTIFACT_INLINE_DOWNLOAD_MAX_BYTES - totalBytes;
      if (remainingBytes <= 0) {
        return createAdminFieldErrorResponse(c, [
          fieldError(
            'artifact',
            'artifact_too_large_for_inline_download',
            'Export artifact is too large for inline API download.'
          ),
        ]);
      }
      if (item.format === 'zip') {
        const partRead = await readR2BytesWithLimit(part, remainingBytes);
        if (!partRead.ok) {
          return createAdminFieldErrorResponse(c, [
            fieldError(
              'artifact',
              'artifact_too_large_for_inline_download',
              'Export artifact is too large for inline API download.'
            ),
          ]);
        }
        return new Response(partRead.bytes, {
          headers: {
            'content-type': loggingExportContentType(item.format),
            'content-disposition': `attachment; filename="${safeDownloadFilenameBase(item.id)}.${loggingExportFileExtension(item.format)}"`,
            'x-content-type-options': 'nosniff',
            'cache-control': 'no-store',
          },
        });
      }
      const partRead = await readR2TextWithLimit(part, remainingBytes);
      if (!partRead.ok) {
        return createAdminFieldErrorResponse(c, [
          fieldError(
            'artifact',
            'artifact_too_large_for_inline_download',
            'Export artifact is too large for inline API download.'
          ),
        ]);
      }
      totalBytes += partRead.bytes;
      const text = partRead.text;
      if (item.format === 'csv' && index > 0) {
        partTexts.push(text.split(/\r?\n/).slice(1).join('\n'));
      } else {
        partTexts.push(text);
      }
    }
    return new Response(partTexts.join(item.format === 'csv' ? '\n' : ''), {
      headers: {
        'content-type': loggingExportContentType(item.format),
        'content-disposition': `attachment; filename="${safeDownloadFilenameBase(item.id)}.${loggingExportFileExtension(item.format)}"`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

async function listDlqItems(c: AdminContext) {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const conditions: string[] = [];
  const params: unknown[] = [];
  const requestedTenantKey = c.req.query('filter[tenant_key]') || c.req.query('tenant_key');
  const requestedTenantId = c.req.query('filter[tenant_id]') || c.req.query('tenant_id');
  const tenantKeyFilter = await resolveTenantKeyOrTenantIdFilter(c, {
    tenantKey: requestedTenantKey,
    tenantId: requestedTenantId,
  });
  if (!tenantKeyFilter.ok) {
    return tenantKeyFilter.response;
  }
  const tenantKey = tenantKeyFilter.tenantKey;
  const lane = c.req.query('filter[lane]') || c.req.query('lane');
  const status = c.req.query('filter[status]') || c.req.query('status');
  const from = parseSince(c);
  const to = parseUntil(c);
  const limit = parseLimit(c);
  const filterHash = await hashFilter({
    route: 'dlq_items',
    tenant_key: tenantKey ?? null,
    lane: lane ?? null,
    status: status ?? null,
    time_start: from,
    time_end: to,
  });

  if (tenantKey) {
    conditions.push('tenant_key = ?');
    params.push(tenantKey);
  }
  if (lane) {
    conditions.push('lane = ?');
    params.push(lane);
  }
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (from) {
    conditions.push('created_at >= ?');
    params.push(from);
  }
  if (to) {
    conditions.push('created_at <= ?');
    params.push(to);
  }

  const cursor = c.req.query('cursor');
  if (cursor) {
    const secret = getLoggingCursorSecret(c);
    if (!secret) {
      return createAdminFieldErrorResponse(c, [
        fieldError(
          'cursor',
          'cursor_secret_unavailable',
          'Cursor signing secret is not configured.'
        ),
      ]);
    }

    const result = await decodeLoggingCursor(cursor, secret);
    if (!result.valid || !result.payload) {
      return createAdminFieldErrorResponse(c, [
        fieldError('cursor', result.reason ?? 'invalid_cursor', 'Cursor is invalid or expired.'),
      ]);
    }
    if (result.payload.filterHash !== filterHash || result.payload.direction !== 'next') {
      return createAdminFieldErrorResponse(c, [
        fieldError('cursor', 'filter_mismatch', 'Cursor does not match the current filters.'),
      ]);
    }

    const sort = getCursorSort(result.payload);
    if (!sort) {
      return createAdminFieldErrorResponse(c, [
        fieldError('cursor', 'invalid_sort', 'Cursor sort key is invalid.'),
      ]);
    }

    conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
    params.push(sort.createdAt, sort.createdAt, sort.id);
  }

  try {
    const adapter = getAdminAdapter(c);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await adapter.query<Record<string, unknown>>(
      `SELECT id, tenant_key, payload_type, schema_version, lane, destination_id,
              payload_object_ref, error_class, attempt_count, status, created_at, updated_at
       FROM logging_dlq_items
       ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [...params, limit + 1]
    );
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const lastItem = items.at(-1);
    const secret = getLoggingCursorSecret(c);
    const nextCursor =
      hasMore && lastItem && secret
        ? await encodeLoggingCursor(
            {
              sort: {
                created_at: Number(lastItem.created_at),
                id: String(lastItem.id),
              },
              direction: 'next',
              filterHash,
              expiresAt: Date.now() + DELIVERY_EVENTS_CURSOR_TTL_MS,
            },
            secret
          )
        : undefined;

    return c.json(
      adminListEnvelope(items, {
        page: {
          next_cursor: nextCursor ?? null,
          has_more: hasMore,
          limit,
          ...(from && { time_start: from }),
          ...(to && { time_end: to }),
        },
      })
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

loggingPoliciesRouter.get('/dlq', listDlqItems);
loggingPoliciesRouter.get('/dlq-items', listDlqItems);

loggingPoliciesRouter.post('/dlq/bulk-replay/preview', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const body = await parseJsonObject(c);
  const requestedTenantKey = parseOptionalString(body.tenant_key) ?? undefined;
  const requestedTenantId = parseOptionalString(body.tenant_id) ?? undefined;
  const tenantKeyFilter = await resolveTenantKeyOrTenantIdFilter(c, {
    tenantKey: requestedTenantKey,
    tenantId: requestedTenantId,
  });
  if (!tenantKeyFilter.ok) {
    return tenantKeyFilter.response;
  }
  const laneRaw = parseOptionalString(body.lane) ?? undefined;
  const lane = readLoggingMessageLane(laneRaw);
  if (laneRaw && !lane) {
    return createAdminFieldErrorResponse(c, [
      fieldError('lane', 'invalid_lane', 'Unsupported delivery lane.'),
    ]);
  }
  const limit =
    typeof body.limit === 'number' && Number.isInteger(body.limit) && body.limit > 0
      ? Math.min(body.limit, 100)
      : 25;

  try {
    const items = await listOpenDlqItemsForBulkReplay(c, {
      tenantKey: tenantKeyFilter.tenantKey,
      lane,
      destinationId: parseOptionalString(body.destination_id),
      payloadType: parseOptionalString(body.payload_type),
      limit,
    });
    return c.json(
      adminDetailEnvelope({
        filters: {
          tenant_key: tenantKeyFilter.tenantKey,
          lane: lane ?? null,
          destination_id: parseOptionalString(body.destination_id),
          payload_type: parseOptionalString(body.payload_type),
          limit,
        },
        item_count: items.length,
        items,
      })
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.post('/dlq/bulk-replay/apply', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, LOGGING_DELIVERY_RETRY_PERMISSION)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const body = await parseJsonObject(c);
  const requestedTenantKey = parseOptionalString(body.tenant_key) ?? undefined;
  const requestedTenantId = parseOptionalString(body.tenant_id) ?? undefined;
  const tenantKeyFilter = await resolveTenantKeyOrTenantIdFilter(c, {
    tenantKey: requestedTenantKey,
    tenantId: requestedTenantId,
  });
  if (!tenantKeyFilter.ok) {
    return tenantKeyFilter.response;
  }
  const laneRaw = parseOptionalString(body.lane) ?? undefined;
  const lane = readLoggingMessageLane(laneRaw);
  if (laneRaw && !lane) {
    return createAdminFieldErrorResponse(c, [
      fieldError('lane', 'invalid_lane', 'Unsupported delivery lane.'),
    ]);
  }
  const limit =
    typeof body.limit === 'number' && Number.isInteger(body.limit) && body.limit > 0
      ? Math.min(body.limit, 50)
      : 10;
  const reason = parseOptionalString(body.reason) ?? 'bulk DLQ replay requested';

  try {
    const items = await listOpenDlqItemsForBulkReplay(c, {
      tenantKey: tenantKeyFilter.tenantKey,
      lane,
      destinationId: parseOptionalString(body.destination_id),
      payloadType: parseOptionalString(body.payload_type),
      limit,
    });
    const applied: Record<string, unknown>[] = [];
    const failed: Record<string, unknown>[] = [];
    for (const item of items) {
      const response = await createRetryDeliveryMessageJobAction(c, {
        source_type: 'dlq_item',
        source_id: item.id,
        reason,
      });
      const payload = (await response.json().catch(() => null)) as {
        result?: Record<string, unknown>;
        error?: string;
        message?: string;
      } | null;
      if (response.ok && payload?.result) {
        applied.push({
          dlq_item_id: item.id,
          message_job: payload.result,
        });
      } else {
        failed.push({
          dlq_item_id: item.id,
          status: response.status,
          error: payload?.error ?? payload?.message ?? 'retry_enqueue_failed',
        });
      }
    }

    const auditId = await writeAdminAuditLog(c, {
      action: 'logging.delivery.bulk_retry',
      resourceType: 'logging_dlq_item',
      resourceId: 'bulk-replay',
      result: failed.length > 0 ? 'failure' : 'success',
      severity: failed.length > 0 ? 'warn' : 'info',
      metadata: {
        requested_count: items.length,
        applied_count: applied.length,
        failed_count: failed.length,
        tenant_key: tenantKeyFilter.tenantKey,
        lane: lane ?? null,
      },
    });

    return c.json(
      adminActionEnvelope(
        {
          requested_count: items.length,
          applied_count: applied.length,
          failed_count: failed.length,
          applied,
          failed,
        },
        { auditId }
      ),
      failed.length > 0 && applied.length === 0 ? 409 : 202
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.post('/retries', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, LOGGING_DELIVERY_RETRY_PERMISSION)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const body = await parseJsonObject(c);
  const request = parseRetryDeliveryRequestBody(body);
  if (!request) {
    return createAdminFieldErrorResponse(c, [
      fieldError(
        'source_type',
        'invalid_retry_source',
        'source_type must be dlq_item, delivery_event, or payload_object with source_id.'
      ),
    ]);
  }

  try {
    const now = Date.now();
    const source = await resolveRetryDeliverySource(c, request, now);
    if (!source.ok) {
      return source.response;
    }

    const criticality = isCriticalRetryPayload({
      lane: source.lane,
      logType: source.logType,
    })
      ? 'critical'
      : 'standard';
    if (criticality === 'critical' && !hasPlatformAuthority(authContext)) {
      return createAdminPermissionErrorResponse(c, {
        required_scope: 'platform',
        reason: 'critical_logging_retry_requires_platform_admin',
      });
    }

    const payloadBucket = getLoggingMessagePayloadBucket(c);
    if (!payloadBucket) {
      return createAdminFieldErrorResponse(c, [
        fieldError(
          'LOGGING_MESSAGE_PAYLOAD_BUCKET',
          'binding_unavailable',
          'No R2 bucket is configured for logging message payloads.'
        ),
      ]);
    }

    const messageJobId = createLoggingId('lmj', now);
    const messagePayload: RetryDeliveryMessagePayload = {
      payload_type: 'retry_delivery',
      schema_version: 1,
      payload_id: createLoggingId('qpl', now),
      message_job_id: messageJobId,
      tenant_key: source.tenantKey,
      lane: source.lane,
      created_at: now,
      source_type: request.source_type,
      source_id: request.source_id,
      retry_id: messageJobId,
      idempotency_key:
        request.idempotency_key ??
        buildRetryIdempotencyKey({
          sourceType: request.source_type,
          sourceId: request.source_id,
          payloadHash: source.sourcePayloadObjectRef,
        }),
      target_payload_hash: source.sourcePayloadObjectRef ?? request.source_id,
      requested_by: authContext.userId ?? 'unknown_admin',
      reason: request.reason,
      replay_payload: source.replayPayload,
    };
    const payloadWrite = await writeLoggingMessagePayloadToR2({
      bucket: payloadBucket,
      jobId: messageJobId,
      payloadType: 'retry_delivery',
      schemaVersion: 1,
      lane: source.lane,
      criticality,
      sourceType: request.source_type,
      tenantKey: source.tenantKey,
      payload: messagePayload,
      now,
    });
    const store = new SqlLoggingMessageJobStore(getAdminAdapter(c));
    const job = await store.createJob({
      id: messageJobId,
      kind: 'retry_delivery',
      lane: source.lane,
      criticality,
      priority: criticality === 'critical' ? 100 : source.lane === 'bulk' ? 0 : 10,
      topology: {
        tenantKey: source.tenantKey,
        topologyType: 'unknown',
        topologyResolvedAt: now,
      },
      scopeType: source.tenantKey ? 'tenant' : 'platform',
      scopeId: source.tenantKey,
      scopeKey: source.tenantKey ? `tenant:${source.tenantKey}` : 'platform',
      sourceType: request.source_type,
      sourceId: request.source_id,
      payloadObjectRef: payloadWrite.objectRef,
      payloadSha256: payloadWrite.sha256,
      payloadType: 'retry_delivery',
      payloadSchemaVersion: 1,
      redactedSummary: payloadWrite.redactedSummary,
      validationSummary: payloadWrite.validationSummary,
      idempotencyKey: messagePayload.idempotency_key,
      dedupeUntil: request.dedupe_until ?? now + 24 * 60 * 60 * 1000,
      notBefore: request.not_before ?? now,
      maxAttempts: request.max_attempts ?? 5,
      attemptPolicy: {
        maxAttempts: request.max_attempts ?? 5,
        leaseTimeoutMs: request.lease_timeout_ms ?? 5 * 60 * 1000,
      },
      requestedBy: authContext.userId ?? 'unknown_admin',
      reason: request.reason ?? null,
      errorClass: null,
      now,
    });
    const enqueueResult = await enqueueLoggingMessagePayload(
      messagePayload,
      c.env as unknown as Record<string, unknown>
    );
    const auditId = await writeAdminAuditLog(c, {
      action: 'logging.delivery.retry',
      resourceType: 'logging_message_job',
      resourceId: job.id,
      result: 'success',
      severity: criticality === 'critical' ? 'warn' : 'info',
      metadata: {
        message_job_id: job.id,
        source_type: request.source_type,
        source_id: request.source_id,
        tenant_key: source.tenantKey,
        lane: source.lane,
        criticality,
        queued: enqueueResult.queued,
        queue_binding: enqueueResult.bindingName,
      },
    });

    return c.json(
      adminActionEnvelope(
        {
          id: job.id,
          kind: job.kind,
          status: job.status,
          lane: job.lane,
          criticality: job.criticality,
          tenant_key: job.tenantKey,
          source_type: job.sourceType,
          source_id: job.sourceId,
          payload_object_ref: job.payloadObjectRef,
          queue_payload_id: enqueueResult.payloadId,
          queue_binding: enqueueResult.bindingName,
          queued: enqueueResult.queued,
          polling: {
            job: `/api/admin/logging-policies/message-jobs/${job.id}`,
          },
        },
        { auditId }
      ),
      202
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

async function createRetryDeliveryMessageJobAction(
  c: AdminContext,
  request: RetryDeliveryRequestBody
): Promise<Response> {
  try {
    const authContext = getAuth(c);
    const now = Date.now();
    const source = await resolveRetryDeliverySource(c, request, now);
    if (!source.ok) {
      return source.response;
    }

    const criticality = isCriticalRetryPayload({
      lane: source.lane,
      logType: source.logType,
    })
      ? 'critical'
      : 'standard';
    if (criticality === 'critical' && !hasPlatformAuthority(authContext)) {
      return createAdminPermissionErrorResponse(c, {
        required_scope: 'platform',
        reason: 'critical_logging_retry_requires_platform_admin',
      });
    }

    const payloadBucket = getLoggingMessagePayloadBucket(c);
    if (!payloadBucket) {
      return createAdminFieldErrorResponse(c, [
        fieldError(
          'LOGGING_MESSAGE_PAYLOAD_BUCKET',
          'binding_unavailable',
          'No R2 bucket is configured for logging message payloads.'
        ),
      ]);
    }

    const messageJobId = createLoggingId('lmj', now);
    const messagePayload: RetryDeliveryMessagePayload = {
      payload_type: 'retry_delivery',
      schema_version: 1,
      payload_id: createLoggingId('qpl', now),
      message_job_id: messageJobId,
      tenant_key: source.tenantKey,
      lane: source.lane,
      created_at: now,
      source_type: request.source_type,
      source_id: request.source_id,
      retry_id: messageJobId,
      idempotency_key:
        request.idempotency_key ??
        buildRetryIdempotencyKey({
          sourceType: request.source_type,
          sourceId: request.source_id,
          payloadHash: source.sourcePayloadObjectRef,
        }),
      target_payload_hash: source.sourcePayloadObjectRef ?? request.source_id,
      requested_by: authContext.userId ?? 'unknown_admin',
      reason: request.reason,
      replay_payload: source.replayPayload,
    };
    const payloadWrite = await writeLoggingMessagePayloadToR2({
      bucket: payloadBucket,
      jobId: messageJobId,
      payloadType: 'retry_delivery',
      schemaVersion: 1,
      lane: source.lane,
      criticality,
      sourceType: request.source_type,
      tenantKey: source.tenantKey,
      payload: messagePayload,
      now,
    });
    const store = new SqlLoggingMessageJobStore(getAdminAdapter(c));
    const job = await store.createJob({
      id: messageJobId,
      kind: 'retry_delivery',
      lane: source.lane,
      criticality,
      priority: criticality === 'critical' ? 100 : source.lane === 'bulk' ? 0 : 10,
      topology: {
        tenantKey: source.tenantKey,
        topologyType: 'unknown',
        topologyResolvedAt: now,
      },
      scopeType: source.tenantKey ? 'tenant' : 'platform',
      scopeId: source.tenantKey,
      scopeKey: source.tenantKey ? `tenant:${source.tenantKey}` : 'platform',
      sourceType: request.source_type,
      sourceId: request.source_id,
      payloadObjectRef: payloadWrite.objectRef,
      payloadSha256: payloadWrite.sha256,
      payloadType: 'retry_delivery',
      payloadSchemaVersion: 1,
      redactedSummary: payloadWrite.redactedSummary,
      validationSummary: payloadWrite.validationSummary,
      idempotencyKey: messagePayload.idempotency_key,
      dedupeUntil: request.dedupe_until ?? now + 24 * 60 * 60 * 1000,
      notBefore: request.not_before ?? now,
      maxAttempts: request.max_attempts ?? 5,
      attemptPolicy: {
        maxAttempts: request.max_attempts ?? 5,
        leaseTimeoutMs: request.lease_timeout_ms ?? 5 * 60 * 1000,
      },
      requestedBy: authContext.userId ?? 'unknown_admin',
      reason: request.reason ?? null,
      errorClass: null,
      now,
    });
    const enqueueResult = await enqueueLoggingMessagePayload(
      messagePayload,
      c.env as unknown as Record<string, unknown>
    );
    const auditId = await writeAdminAuditLog(c, {
      action: 'logging.delivery.retry',
      resourceType: 'logging_message_job',
      resourceId: job.id,
      result: 'success',
      severity: criticality === 'critical' ? 'warn' : 'info',
      metadata: {
        message_job_id: job.id,
        source_type: request.source_type,
        source_id: request.source_id,
        tenant_key: source.tenantKey,
        lane: source.lane,
        criticality,
        queued: enqueueResult.queued,
        queue_binding: enqueueResult.bindingName,
      },
    });

    return c.json(
      adminActionEnvelope(
        {
          id: job.id,
          kind: job.kind,
          status: job.status,
          lane: job.lane,
          criticality: job.criticality,
          tenant_key: job.tenantKey,
          source_type: job.sourceType,
          source_id: job.sourceId,
          payload_object_ref: job.payloadObjectRef,
          queue_payload_id: enqueueResult.payloadId,
          queue_binding: enqueueResult.bindingName,
          queued: enqueueResult.queued,
          polling: {
            job: `/api/admin/logging-policies/message-jobs/${job.id}`,
          },
        },
        { auditId }
      ),
      202
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

loggingPoliciesRouter.get('/dlq-items/:id/payload', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const rawPreviewBytes = Number.parseInt(c.req.query('preview_bytes') || '', 10);
  const previewBytes =
    Number.isFinite(rawPreviewBytes) && rawPreviewBytes > 0
      ? Math.min(rawPreviewBytes, 64 * 1024)
      : 8 * 1024;

  try {
    const adapter = getAdminAdapter(c);
    const item = await getDlqItem(adapter, c.req.param('id'));
    if (!item) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const accessError = await requireTenantKeyAccess(c, item.tenant_key);
    if (accessError) {
      return accessError;
    }

    const payload = await readDlqPayloadPreview(c, item, previewBytes);
    if (!payload.ok) {
      return payload.response;
    }

    return c.json(
      adminDetailEnvelope({
        id: item.id,
        tenant_key: item.tenant_key,
        payload_type: item.payload_type,
        schema_version: item.schema_version,
        lane: item.lane,
        destination_id: item.destination_id,
        payload_object_ref: item.payload_object_ref,
        error_class: item.error_class,
        attempt_count: item.attempt_count,
        status: item.status,
        created_at: item.created_at,
        updated_at: item.updated_at,
        payload: payload.value,
      })
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

async function replayDlqItem(c: AdminContext) {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, LOGGING_DELIVERY_RETRY_PERMISSION)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const id = c.req.param('id');
  if (!id) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
  return createRetryDeliveryMessageJobAction(c, {
    source_type: 'dlq_item',
    source_id: id,
    reason: 'dlq replay requested from convenience endpoint',
  });
}

loggingPoliciesRouter.post('/dlq/:id/replay', replayDlqItem);
loggingPoliciesRouter.post('/dlq-items/:id/replay', replayDlqItem);

loggingPoliciesRouter.post('/dlq-items/:id/delete', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.LOGGING_DLQ_DELETE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const id = c.req.param('id');
  try {
    const adapter = getAdminAdapter(c);
    const item = await getDlqItem(adapter, id);
    const stateResponse = requireOpenDlqItem(c, item);
    if (stateResponse) {
      return stateResponse;
    }
    if (!item) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const accessError = await requireTenantKeyAccess(c, item.tenant_key);
    if (accessError) {
      return accessError;
    }

    const now = Date.now();
    await adapter.execute(
      `UPDATE logging_dlq_items
       SET status = 'deleted', updated_at = ?
       WHERE id = ? AND status = 'open'`,
      [now, id]
    );
    const auditId = await recordDlqAdminAudit(c, item, 'delete', 'success', {
      next_status: 'deleted',
    });

    return c.json(
      adminActionEnvelope(
        {
          id,
          status: 'deleted',
          updated_at: now,
        },
        { auditId }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.post('/dlq-items/:id/purge', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.LOGGING_DLQ_PURGE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const id = c.req.param('id');
  const body = await parseJsonObject(c);
  const confirmation = typeof body.confirmation === 'string' ? body.confirmation.trim() : '';
  const requiredConfirmation = `PURGE DLQ ${id}`;
  if (confirmation !== requiredConfirmation) {
    return createAdminFieldErrorResponse(c, [
      fieldError(
        'confirmation',
        'confirmation_mismatch',
        `Confirmation must be: ${requiredConfirmation}`
      ),
    ]);
  }

  try {
    const adapter = getAdminAdapter(c);
    const item = await getDlqItem(adapter, id);
    const stateResponse = requireOpenDlqItem(c, item);
    if (stateResponse) {
      return stateResponse;
    }
    if (!item) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const accessError = await requireTenantKeyAccess(c, item.tenant_key);
    if (accessError) {
      return accessError;
    }

    const bucket = getDlqPayloadBucket(c);
    if (!bucket) {
      return createAdminFieldErrorResponse(c, [
        fieldError(
          'payload_object_ref',
          'bucket_unavailable',
          'DLQ payload bucket is unavailable.'
        ),
      ]);
    }

    await bucket.delete(item.payload_object_ref);
    const now = Date.now();
    await adapter.execute(
      `UPDATE logging_dlq_items
       SET status = 'purged', updated_at = ?
       WHERE id = ? AND status = 'open'`,
      [now, id]
    );
    const auditId = await recordDlqAdminAudit(c, item, 'purge', 'success', {
      next_status: 'purged',
      confirmation,
    });

    return c.json(
      adminActionEnvelope(
        {
          id,
          status: 'purged',
          updated_at: now,
        },
        { auditId }
      )
    );
  } catch (error) {
    const adapter = getAdminAdapter(c);
    const item = await getDlqItem(adapter, id).catch(() => null);
    if (item) {
      await recordDlqAdminAudit(c, item, 'purge', 'failure', {
        error_class: error instanceof Error ? error.message : 'unknown_error',
      });
    }
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.post('/drafts', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.LOGGING_SNAPSHOTS_PUBLISH)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const parsed = await readPolicySnapshotDraftBody(c);
  if (!parsed.ok) {
    return parsed.response;
  }

  try {
    const adapter = getAdminAdapter(c);
    const { snapshot, diff, assignments, fallbacks, destinations } =
      await buildPolicySnapshotCandidate(c, parsed.value);
    const now = snapshot.synchronizedAt;
    await adapter.execute(
      `INSERT INTO logging_policy_snapshots (
        id, scope_type, scope_id, version, status, policy_hash, object_ref,
        snapshot_json, published_by, created_at, published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshot.snapshotId,
        snapshot.scopeType,
        snapshot.scopeId,
        snapshot.version,
        'draft',
        snapshot.policyHash,
        null,
        JSON.stringify(snapshot),
        null,
        now,
        null,
      ]
    );
    const auditId = await writeAdminAuditLog(c, {
      action: 'logging_policy_snapshot.draft_create',
      resourceType: 'logging_policy_snapshot',
      resourceId: snapshot.snapshotId,
      result: 'success',
      severity: 'info',
      metadata: {
        scope_type: snapshot.scopeType,
        scope_id: snapshot.scopeId,
        version: snapshot.version,
        policy_hash: snapshot.policyHash,
        assignment_count: assignments.length,
        fallback_count: fallbacks.length,
        destination_count: destinations.length,
        diff,
      },
    });

    return c.json(
      adminMutationEnvelope(
        {
          id: snapshot.snapshotId,
          scope_type: snapshot.scopeType,
          scope_id: snapshot.scopeId,
          version: snapshot.version,
          status: 'draft',
          policy_hash: snapshot.policyHash,
          diff,
          created_at: now,
          confirmation: `PUBLISH LOGGING POLICY ${snapshot.scopeType}:${snapshot.scopeId}`,
        },
        { auditId }
      ),
      201
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.post('/drafts/:id/publish', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.LOGGING_SNAPSHOTS_PUBLISH)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const body = await parseJsonObject(c);
  const expectedVersion =
    body.expected_version === undefined || body.expected_version === null
      ? null
      : Number.parseInt(String(body.expected_version), 10);
  if (expectedVersion !== null && (!Number.isInteger(expectedVersion) || expectedVersion <= 0)) {
    return createAdminFieldErrorResponse(c, [
      fieldError(
        'expected_version',
        'invalid_value',
        'Expected version must be a positive integer.'
      ),
    ]);
  }

  try {
    const adapter = getAdminAdapter(c);
    const id = c.req.param('id');
    const draft = await adapter.queryOne<{
      id: string;
      scope_type: 'platform' | 'tenant';
      scope_id: string;
      version: number;
      status: string;
      policy_hash: string;
      snapshot_json: string | null;
    }>(
      `SELECT id, scope_type, scope_id, version, status, policy_hash, snapshot_json
       FROM logging_policy_snapshots
       WHERE id = ?`,
      [id]
    );
    if (!draft || draft.status !== 'draft' || !draft.snapshot_json) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (draft.scope_type === 'platform') {
      const platformError = await requirePlatformAuthority(c);
      if (platformError) {
        return platformError;
      }
    }
    if (
      draft.scope_type === 'tenant' &&
      !hasPlatformAuthority(authContext) &&
      draft.scope_id !== getTenantIdFromContext(c)
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }
    if (expectedVersion !== null && expectedVersion !== draft.version) {
      return createAdminErrorResponseWithDetails(c, AR_ERROR_CODES.ADMIN_CONFLICT, {
        conflict: {
          expected_version: expectedVersion,
          actual_version: draft.version,
        },
      });
    }
    const confirmation = `PUBLISH LOGGING POLICY ${draft.scope_type}:${draft.scope_id}`;
    if (body.confirmation !== confirmation) {
      return createAdminFieldErrorResponse(c, [
        fieldError(
          'confirmation',
          'confirmation_mismatch',
          `Confirmation must be "${confirmation}".`
        ),
      ]);
    }

    const snapshot = JSON.parse(draft.snapshot_json) as Awaited<
      ReturnType<typeof createRuntimeLoggingPolicySnapshot>
    >;
    const now = snapshot.synchronizedAt;
    const publication = await publishRuntimeLoggingPolicySnapshot({
      snapshot,
      kv: c.env.AUTHRIM_CONFIG,
      objectStore: c.env.DIAGNOSTIC_LOGS,
      now,
    });

    await adapter.execute(
      `UPDATE logging_policy_snapshots
       SET status = 'published',
           object_ref = ?,
           published_by = ?,
           published_at = ?
       WHERE id = ? AND status = 'draft'`,
      [publication.objectRef, authContext.userId ?? null, now, draft.id]
    );
    const auditId = await writeAdminAuditLog(c, {
      action: 'logging_policy_snapshot.publish',
      resourceType: 'logging_policy_snapshot',
      resourceId: snapshot.snapshotId,
      result: 'success',
      severity: 'warn',
      metadata: {
        scope_type: snapshot.scopeType,
        scope_id: snapshot.scopeId,
        version: snapshot.version,
        policy_hash: snapshot.policyHash,
        object_ref: publication.objectRef,
        pointer_key: publication.pointerKey,
        draft_id: draft.id,
      },
    });

    return c.json(
      adminMutationEnvelope(
        {
          id: snapshot.snapshotId,
          scope_type: snapshot.scopeType,
          scope_id: snapshot.scopeId,
          version: snapshot.version,
          status: 'published',
          policy_hash: snapshot.policyHash,
          object_ref: publication.objectRef,
          pointer_key: publication.pointerKey,
          created_at: now,
          published_at: now,
        },
        { auditId }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

loggingPoliciesRouter.post('/snapshots', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.LOGGING_SNAPSHOTS_PUBLISH)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const parsed = await readPolicySnapshotDraftBody(c);
  if (!parsed.ok) {
    return parsed.response;
  }

  try {
    const adapter = getAdminAdapter(c);
    const { snapshot, assignments, fallbacks, destinations } = await buildPolicySnapshotCandidate(
      c,
      parsed.value
    );
    const now = snapshot.synchronizedAt;
    const publication = await publishRuntimeLoggingPolicySnapshot({
      snapshot,
      kv: c.env.AUTHRIM_CONFIG,
      objectStore: c.env.DIAGNOSTIC_LOGS,
      now,
    });

    await adapter.execute(
      `INSERT INTO logging_policy_snapshots (
        id, scope_type, scope_id, version, status, policy_hash, object_ref,
        snapshot_json, published_by, created_at, published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshot.snapshotId,
        snapshot.scopeType,
        snapshot.scopeId,
        snapshot.version,
        'published',
        snapshot.policyHash,
        publication.objectRef,
        JSON.stringify(snapshot),
        authContext.userId ?? null,
        now,
        now,
      ]
    );
    const auditId = await writeAdminAuditLog(c, {
      action: 'logging_policy_snapshot.publish',
      resourceType: 'logging_policy_snapshot',
      resourceId: snapshot.snapshotId,
      result: 'success',
      severity: 'warn',
      metadata: {
        scope_type: snapshot.scopeType,
        scope_id: snapshot.scopeId,
        version: snapshot.version,
        policy_hash: snapshot.policyHash,
        object_ref: publication.objectRef,
        pointer_key: publication.pointerKey,
        assignment_count: assignments.length,
        fallback_count: fallbacks.length,
        destination_count: destinations.length,
      },
    });

    return c.json(
      adminMutationEnvelope(
        {
          id: snapshot.snapshotId,
          scope_type: snapshot.scopeType,
          scope_id: snapshot.scopeId,
          version: snapshot.version,
          status: 'published',
          policy_hash: snapshot.policyHash,
          object_ref: publication.objectRef,
          pointer_key: publication.pointerKey,
          created_at: now,
          published_at: now,
        },
        { auditId }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminLoggingRouter.get('/coverage', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.ADMIN_LOGGING_COVERAGE_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const items = buildAdminAuditCoverageStatusView(LOGGING_ADMIN_AUDIT_COVERAGE_REGISTRY);
  return c.json(adminListEnvelope(items));
});

adminLoggingRouter.get('/key-registry', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.ADMIN_LOGGING_SENSITIVE_DETAIL_POLICY_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatformAuthority(c);
  if (platformError) {
    return platformError;
  }

  try {
    const limit = parseLimit(c, 100, 500);
    const rows = await getAdminAdapter(c).query<LoggingKeyRegistryVersionRow>(
      `SELECT kr.id, kr.tenant_key, kr.surface, kr.log_type, kr.plane,
              kr.active_version, kr.status AS registry_status,
              kr.last_rotated_at, kr.created_at AS registry_created_at,
              kr.updated_at AS registry_updated_at,
              kv.version, kv.backend_ref, kv.status AS version_status,
              kv.usage_count, kv.stale_count,
              kv.created_at AS version_created_at, kv.retired_at
       FROM logging_key_registry kr
       LEFT JOIN logging_key_versions kv ON kv.key_registry_id = kr.id
       ORDER BY kr.tenant_key ASC, kr.log_type ASC, kr.plane ASC, kv.version DESC
       LIMIT ?`,
      [limit]
    );
    return c.json(
      adminListEnvelope(
        rows.map((row) => ({
          id: row.id,
          tenant_key: row.tenant_key,
          surface: row.surface,
          log_type: row.log_type,
          plane: row.plane,
          active_version: toInteger(row.active_version),
          registry_status: row.registry_status,
          last_rotated_at: readNullableInteger(row.last_rotated_at),
          registry_created_at: toInteger(row.registry_created_at),
          registry_updated_at: toInteger(row.registry_updated_at),
          version: readNullableInteger(row.version),
          backend_ref: row.backend_ref,
          version_status: row.version_status,
          usage_count: toInteger(row.usage_count),
          stale_count: toInteger(row.stale_count),
          version_created_at: readNullableInteger(row.version_created_at),
          retired_at: readNullableInteger(row.retired_at),
        }))
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminLoggingRouter.get('/key-registry/:id/impact', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.ADMIN_LOGGING_SENSITIVE_DETAIL_POLICY_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatformAuthority(c);
  if (platformError) {
    return platformError;
  }

  try {
    const adapter = getAdminAdapter(c);
    const id = c.req.param('id');
    const registry = await adapter.queryOne<Record<string, unknown>>(
      `SELECT id, tenant_key, surface, log_type, plane, active_version, status,
              last_rotated_at, created_at, updated_at
       FROM logging_key_registry
       WHERE id = ?`,
      [id]
    );
    if (!registry) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const versions = await adapter.query<Record<string, unknown>>(
      `SELECT kv.version, kv.status, kv.usage_count, kv.stale_count,
              COUNT(loc.id) AS object_count,
              SUM(loc.record_count) AS record_count,
              SUM(loc.byte_count) AS byte_count,
              MIN(loc.committed_at) AS oldest_committed_at,
              MAX(loc.committed_at) AS newest_committed_at
       FROM logging_key_versions kv
       INNER JOIN logging_key_registry kr ON kr.id = kv.key_registry_id
       LEFT JOIN log_object_catalog loc
         ON loc.tenant_key = kr.tenant_key
        AND loc.log_type = kr.log_type
        AND loc.plane = kr.plane
        AND COALESCE(loc.surface, '') = COALESCE(kr.surface, '')
        AND loc.key_version = kv.version
        AND loc.status = 'committed'
        AND loc.object_kind = 'chunk'
       WHERE kv.key_registry_id = ?
       GROUP BY kv.version, kv.status, kv.usage_count, kv.stale_count
       ORDER BY kv.version DESC`,
      [id]
    );
    const jobs = await adapter.query<Record<string, unknown>>(
      `SELECT status, COUNT(*) AS total
       FROM logging_rewrap_jobs
       WHERE key_registry_id = ?
       GROUP BY status
       ORDER BY status ASC`,
      [id]
    );
    return c.json(
      adminDetailEnvelope({
        registry,
        versions,
        rewrap_jobs: jobs,
        checked_at: Date.now(),
      })
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminLoggingRouter.post('/rewrap-jobs', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatformAuthority(c);
  if (platformError) {
    return platformError;
  }

  const body = await parseJsonObject(c);
  const keyRegistryId = parseOptionalString(body.key_registry_id);
  const fromVersion = parseOptionalPositiveInteger(body.from_version);
  const limit =
    typeof body.limit === 'number' && Number.isInteger(body.limit) && body.limit > 0
      ? Math.min(body.limit, 100)
      : 25;
  const fromVersionInvalid = typeof fromVersion === 'number' && Number.isNaN(fromVersion);
  if (!keyRegistryId || fromVersionInvalid) {
    return createAdminFieldErrorResponse(c, [
      ...(!keyRegistryId
        ? [fieldError('key_registry_id', 'required', 'Key registry id is required.')]
        : []),
      ...(fromVersionInvalid
        ? [fieldError('from_version', 'invalid_value', 'from_version must be a positive integer.')]
        : []),
    ]);
  }

  try {
    const adapter = getAdminAdapter(c);
    const conditions = [
      'kr.id = ?',
      "kr.status IN ('active', 'rotating', 'stale', 'compromised')",
      "kv.status IN ('rewrap_required', 'compromised')",
      'kv.version < kr.active_version',
      "loc.status = 'committed'",
      "loc.object_kind = 'chunk'",
      'loc.encryption_scope IS NOT NULL',
    ];
    const params: unknown[] = [keyRegistryId];
    if (typeof fromVersion === 'number' && Number.isFinite(fromVersion)) {
      conditions.push('kv.version = ?');
      params.push(fromVersion);
    }
    const candidates = await adapter.query<LoggingRewrapCandidateRow>(
      `SELECT kr.id AS key_registry_id, kr.tenant_key, kr.surface, kr.log_type, kr.plane,
              kr.active_version, kv.version AS from_version, kv.status AS key_version_status,
              loc.id AS object_catalog_id, loc.object_key, loc.record_count, loc.byte_count,
              loc.committed_at
       FROM logging_key_registry kr
       INNER JOIN logging_key_versions kv ON kv.key_registry_id = kr.id
       INNER JOIN log_object_catalog loc
         ON loc.tenant_key = kr.tenant_key
        AND loc.log_type = kr.log_type
        AND loc.plane = kr.plane
        AND COALESCE(loc.surface, '') = COALESCE(kr.surface, '')
        AND loc.key_version = kv.version
       WHERE ${conditions.join(' AND ')}
       ORDER BY CASE kv.status WHEN 'compromised' THEN 0 ELSE 1 END,
                loc.committed_at ASC,
                loc.id ASC
       LIMIT ?`,
      [...params, limit]
    );
    const queue = new SqlLoggingRewrapJobQueue(adapter);
    const created: Record<string, unknown>[] = [];
    const skipped: Record<string, unknown>[] = [];
    const now = Date.now();
    for (const candidate of candidates) {
      const candidateFromVersion = toInteger(candidate.from_version);
      const toVersion = toInteger(candidate.active_version);
      const existing = await adapter.queryOne<{ id: string; status: string }>(
        `SELECT id, status
         FROM logging_rewrap_jobs
         WHERE key_registry_id = ?
           AND from_version = ?
           AND to_version = ?
           AND metadata LIKE ?
         ORDER BY created_at DESC
         LIMIT 1`,
        [
          candidate.key_registry_id,
          candidateFromVersion,
          toVersion,
          `%"object_catalog_id":"${candidate.object_catalog_id}"%`,
        ]
      );
      if (existing) {
        skipped.push({
          object_catalog_id: candidate.object_catalog_id,
          existing_job_id: existing.id,
          existing_status: existing.status,
        });
        continue;
      }
      const priority = classifyLoggingRewrapPriority({
        logType: candidate.log_type,
        plane: candidate.plane,
        compromised: candidate.key_version_status === 'compromised',
        critical: candidate.log_type === 'admin_audit' || candidate.log_type === 'audit',
      });
      const job = await queue.enqueue({
        keyRegistryId: candidate.key_registry_id,
        fromVersion: candidateFromVersion,
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
          byte_count: toInteger(candidate.byte_count),
        },
        now,
      });
      created.push({
        id: job.id,
        object_catalog_id: candidate.object_catalog_id,
        from_version: candidateFromVersion,
        to_version: toVersion,
        priority: job.priority,
      });
    }

    const auditId = await writeAdminAuditLog(c, {
      action: 'admin_logging.rewrap_jobs.create',
      resourceType: 'logging_key_registry',
      resourceId: keyRegistryId,
      result: 'success',
      severity: created.length > 0 ? 'warn' : 'info',
      metadata: {
        requested_limit: limit,
        candidate_count: candidates.length,
        created_count: created.length,
        skipped_count: skipped.length,
        from_version:
          typeof fromVersion === 'number' && Number.isFinite(fromVersion) ? fromVersion : null,
      },
    });

    return c.json(
      adminActionEnvelope(
        {
          key_registry_id: keyRegistryId,
          candidate_count: candidates.length,
          created_count: created.length,
          skipped_count: skipped.length,
          created,
          skipped,
        },
        { auditId }
      ),
      202
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminLoggingRouter.post('/rewrap-jobs/:id/retry', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatformAuthority(c);
  if (platformError) {
    return platformError;
  }

  const body = await parseJsonObject(c);
  const reason = parseOptionalString(body.reason) ?? 'manual retry requested';

  try {
    const adapter = getAdminAdapter(c);
    const id = c.req.param('id');
    const row = await adapter.queryOne<LoggingRewrapJobViewRow>(
      `SELECT id, key_registry_id, from_version, to_version, priority, status,
              created_at, started_at, completed_at, metadata
       FROM logging_rewrap_jobs
       WHERE id = ?`,
      [id]
    );
    if (!row) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (!['failed', 'skipped'].includes(row.status)) {
      return createAdminFieldErrorResponse(c, [
        fieldError('status', 'invalid_state', 'Only failed or skipped rewrap jobs can be retried.'),
      ]);
    }

    const now = Date.now();
    const metadata = {
      ...parseJsonMetadata(row.metadata),
      retry_requested_by: authContext.userId ?? null,
      retry_requested_at: now,
      retry_reason: reason,
      previous_status: row.status,
    };
    await adapter.execute(
      `UPDATE logging_rewrap_jobs
       SET status = 'queued',
           started_at = NULL,
           completed_at = NULL,
           metadata = ?
       WHERE id = ? AND status = ?`,
      [JSON.stringify(metadata), row.id, row.status]
    );
    const auditId = await writeAdminAuditLog(c, {
      action: 'admin_logging.rewrap_jobs.retry',
      resourceType: 'logging_rewrap_job',
      resourceId: row.id,
      result: 'success',
      severity: 'warn',
      metadata: {
        key_registry_id: row.key_registry_id,
        from_version: toInteger(row.from_version),
        to_version: toInteger(row.to_version),
        previous_status: row.status,
        next_status: 'queued',
        reason,
      },
    });

    return c.json(
      adminActionEnvelope(
        {
          ...serializeLoggingRewrapJob({
            ...row,
            status: 'queued',
            started_at: null,
            completed_at: null,
            metadata: JSON.stringify(metadata),
          }),
        },
        { auditId }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminLoggingRouter.post('/rewrap-jobs/:id/cancel', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatformAuthority(c);
  if (platformError) {
    return platformError;
  }

  const body = await parseJsonObject(c);
  const reason = parseOptionalString(body.reason) ?? 'manual cancellation requested';

  try {
    const adapter = getAdminAdapter(c);
    const id = c.req.param('id');
    const row = await adapter.queryOne<LoggingRewrapJobViewRow>(
      `SELECT id, key_registry_id, from_version, to_version, priority, status,
              created_at, started_at, completed_at, metadata
       FROM logging_rewrap_jobs
       WHERE id = ?`,
      [id]
    );
    if (!row) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (!['queued', 'running', 'failed'].includes(row.status)) {
      return createAdminFieldErrorResponse(c, [
        fieldError(
          'status',
          'invalid_state',
          'Only queued, running, or failed rewrap jobs can be cancelled.'
        ),
      ]);
    }

    const now = Date.now();
    const metadata = {
      ...parseJsonMetadata(row.metadata),
      cancelled_by: authContext.userId ?? null,
      cancelled_at: now,
      cancellation_reason: reason,
      previous_status: row.status,
    };
    await adapter.execute(
      `UPDATE logging_rewrap_jobs
       SET status = 'skipped',
           completed_at = ?,
           metadata = ?
       WHERE id = ? AND status = ?`,
      [now, JSON.stringify(metadata), row.id, row.status]
    );
    const auditId = await writeAdminAuditLog(c, {
      action: 'admin_logging.rewrap_jobs.cancel',
      resourceType: 'logging_rewrap_job',
      resourceId: row.id,
      result: 'success',
      severity: row.status === 'running' ? 'warn' : 'info',
      metadata: {
        key_registry_id: row.key_registry_id,
        from_version: toInteger(row.from_version),
        to_version: toInteger(row.to_version),
        previous_status: row.status,
        next_status: 'skipped',
        reason,
      },
    });

    return c.json(
      adminActionEnvelope(
        serializeLoggingRewrapJob({
          ...row,
          status: 'skipped',
          completed_at: now,
          metadata: JSON.stringify(metadata),
        }),
        { auditId }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminLoggingRouter.post('/rewrap-jobs/:id/priority', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatformAuthority(c);
  if (platformError) {
    return platformError;
  }

  const body = await parseJsonObject(c);
  const priorityRaw = Number.parseInt(String(body.priority ?? ''), 10);
  if (!Number.isInteger(priorityRaw) || priorityRaw < 0 || priorityRaw > 1000) {
    return createAdminFieldErrorResponse(c, [
      fieldError('priority', 'invalid_value', 'Priority must be an integer from 0 to 1000.'),
    ]);
  }

  try {
    const adapter = getAdminAdapter(c);
    const id = c.req.param('id');
    const row = await adapter.queryOne<LoggingRewrapJobViewRow>(
      `SELECT id, key_registry_id, from_version, to_version, priority, status,
              created_at, started_at, completed_at, metadata
       FROM logging_rewrap_jobs
       WHERE id = ?`,
      [id]
    );
    if (!row) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (row.status !== 'queued') {
      return createAdminFieldErrorResponse(c, [
        fieldError('status', 'invalid_state', 'Only queued rewrap jobs can change priority.'),
      ]);
    }

    const metadata = {
      ...parseJsonMetadata(row.metadata),
      priority_changed_by: authContext.userId ?? null,
      priority_changed_at: Date.now(),
      previous_priority: toInteger(row.priority),
    };
    await adapter.execute(
      `UPDATE logging_rewrap_jobs
       SET priority = ?,
           metadata = ?
       WHERE id = ? AND status = 'queued'`,
      [priorityRaw, JSON.stringify(metadata), row.id]
    );
    const auditId = await writeAdminAuditLog(c, {
      action: 'admin_logging.rewrap_jobs.priority_update',
      resourceType: 'logging_rewrap_job',
      resourceId: row.id,
      result: 'success',
      severity: 'info',
      metadata: {
        key_registry_id: row.key_registry_id,
        previous_priority: toInteger(row.priority),
        next_priority: priorityRaw,
      },
    });

    return c.json(
      adminActionEnvelope(
        serializeLoggingRewrapJob({
          ...row,
          priority: priorityRaw,
          metadata: JSON.stringify(metadata),
        }),
        { auditId }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminLoggingRouter.get('/rewrap-jobs', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatformAuthority(c);
  if (platformError) {
    return platformError;
  }

  try {
    const limit = parseLimit(c, 50, 200);
    const rows = await getAdminAdapter(c).query<LoggingRewrapJobViewRow>(
      `SELECT id, key_registry_id, from_version, to_version, priority, status,
              created_at, started_at, completed_at, metadata
       FROM logging_rewrap_jobs
       ORDER BY CASE status
                  WHEN 'running' THEN 0
                  WHEN 'queued' THEN 1
                  WHEN 'failed' THEN 2
                  WHEN 'skipped' THEN 3
                  ELSE 4
                END,
                priority ASC,
                created_at DESC
       LIMIT ?`,
      [limit]
    );
    return c.json(adminListEnvelope(rows.map(serializeLoggingRewrapJob)));
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminLoggingRouter.get('/catalog-repair-jobs', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const scope = await parseCatalogRepairScope(c);
  if (!scope.ok) {
    return scope.response;
  }
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (scope.tenantKey) {
    conditions.push('tenant_key = ?');
    params.push(scope.tenantKey);
  }
  if (scope.logType) {
    conditions.push('log_type = ?');
    params.push(scope.logType);
  }
  if (scope.plane) {
    conditions.push('plane = ?');
    params.push(scope.plane);
  }
  const status = c.req.query('filter[status]') || c.req.query('status');
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const rows = await getAdminAdapter(c).query<LoggingCatalogRepairJobRow>(
      `SELECT id, job_kind, status, tenant_key, log_type, plane, requested_action,
              progress_current, progress_total, preview_artifact_ref, result_json,
              error_class, last_error, requested_by, created_at, updated_at, started_at,
              completed_at, cancel_requested_at, cancel_requested_by, metadata_json
       FROM logging_catalog_repair_jobs
       ${where}
       ORDER BY created_at DESC
       LIMIT ?`,
      [...params, parseLimit(c, 50, 200)]
    );
    return c.json(adminListEnvelope(rows.map(serializeLoggingCatalogRepairJob)));
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminLoggingRouter.post('/catalog-repair-jobs/scan', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const body = await parseJsonObject(c);
  const scope = await parseCatalogRepairScope(c, body);
  if (!scope.ok) {
    return scope.response;
  }
  const now = Date.now();
  const jobId = createLoggingId('lcrj', now);

  try {
    const adapter = getAdminAdapter(c);
    await adapter.execute(
      `INSERT INTO logging_catalog_repair_jobs (
        id, job_kind, status, tenant_key, log_type, plane, progress_current,
        progress_total, requested_by, created_at, updated_at, started_at, metadata_json
      ) VALUES (?, 'scan', 'running', ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?)`,
      [
        jobId,
        scope.tenantKey,
        scope.logType,
        scope.plane,
        authContext.userId ?? null,
        now,
        now,
        now,
        JSON.stringify({ requested_inline: true }),
      ]
    );
    const detection = await detectLogCatalogRepairs(c, {
      tenantKey: scope.tenantKey,
      logType: scope.logType,
      plane: scope.plane,
    });
    const payload = {
      checked_at: detection.now,
      pending_ttl_ms: detection.pendingTtlMs,
      finding_count: detection.findings.length,
      findings: detection.findings,
      scope: {
        tenant_key: scope.tenantKey,
        log_type: scope.logType,
        plane: scope.plane,
      },
    };
    const artifactRef = await writeCatalogRepairJobPreviewArtifact(c, {
      jobId,
      payload,
      now: detection.now,
    });
    await adapter.execute(
      `UPDATE logging_catalog_repair_jobs
       SET status = 'completed',
           progress_current = ?,
           progress_total = ?,
           preview_artifact_ref = ?,
           result_json = ?,
           updated_at = ?,
           completed_at = ?
       WHERE id = ?`,
      [
        detection.findings.length,
        detection.findings.length,
        artifactRef,
        JSON.stringify(payload),
        detection.now,
        detection.now,
        jobId,
      ]
    );
    const row = await adapter.queryOne<LoggingCatalogRepairJobRow>(
      `SELECT id, job_kind, status, tenant_key, log_type, plane, requested_action,
              progress_current, progress_total, preview_artifact_ref, result_json,
              error_class, last_error, requested_by, created_at, updated_at, started_at,
              completed_at, cancel_requested_at, cancel_requested_by, metadata_json
       FROM logging_catalog_repair_jobs WHERE id = ?`,
      [jobId]
    );
    return c.json(
      adminActionEnvelope(row ? serializeLoggingCatalogRepairJob(row) : payload, { jobId })
    );
  } catch (error) {
    await getAdminAdapter(c).execute(
      `UPDATE logging_catalog_repair_jobs
       SET status = 'failed', error_class = ?, last_error = ?, updated_at = ?, completed_at = ?
       WHERE id = ?`,
      [
        'catalog_repair_scan_failed',
        error instanceof Error ? error.message : 'catalog_repair_scan_failed',
        Date.now(),
        Date.now(),
        jobId,
      ]
    );
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminLoggingRouter.post('/catalog-repair-jobs/apply-safe', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const body = await parseJsonObject(c);
  const scope = await parseCatalogRepairScope(c, body);
  if (!scope.ok) {
    return scope.response;
  }
  const limit =
    typeof body.limit === 'number' && Number.isInteger(body.limit) && body.limit > 0
      ? Math.min(body.limit, 500)
      : undefined;
  const now = Date.now();
  const jobId = createLoggingId('lcrj', now);

  try {
    const adapter = getAdminAdapter(c);
    await adapter.execute(
      `INSERT INTO logging_catalog_repair_jobs (
        id, job_kind, status, tenant_key, log_type, plane, progress_current,
        progress_total, requested_by, created_at, updated_at, started_at, metadata_json
      ) VALUES (?, 'apply_safe', 'running', ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?)`,
      [
        jobId,
        scope.tenantKey,
        scope.logType,
        scope.plane,
        authContext.userId ?? null,
        now,
        now,
        now,
        JSON.stringify({ limit: limit ?? null }),
      ]
    );
    const detection = await detectLogCatalogRepairs(c, {
      limit,
      tenantKey: scope.tenantKey,
      logType: scope.logType,
      plane: scope.plane,
    });
    const execution = await getAdminLoggingControlRepository(c).applySafeCatalogRepairs(
      detection.findings,
      detection.now
    );
    const payload = {
      checked_at: detection.now,
      finding_count: detection.findings.length,
      applied_count: execution.applied.length,
      skipped_count: execution.skipped.length,
      applied: execution.applied,
      skipped: execution.skipped,
      scope: {
        tenant_key: scope.tenantKey,
        log_type: scope.logType,
        plane: scope.plane,
      },
    };
    const artifactRef = await writeCatalogRepairJobPreviewArtifact(c, {
      jobId,
      payload,
      now: detection.now,
    });
    await adapter.execute(
      `UPDATE logging_catalog_repair_jobs
       SET status = 'completed',
           progress_current = ?,
           progress_total = ?,
           preview_artifact_ref = ?,
           result_json = ?,
           updated_at = ?,
           completed_at = ?
       WHERE id = ?`,
      [
        execution.applied.length + execution.skipped.length,
        detection.findings.length,
        artifactRef,
        JSON.stringify(payload),
        detection.now,
        detection.now,
        jobId,
      ]
    );
    const auditId = await writeAdminAuditLog(c, {
      action: 'admin_logging.catalog_repair_job.apply_safe',
      resourceType: 'logging_catalog_repair_job',
      resourceId: jobId,
      result: 'success',
      severity: execution.applied.length > 0 ? 'warn' : 'info',
      metadata: payload,
    });
    const row = await adapter.queryOne<LoggingCatalogRepairJobRow>(
      `SELECT id, job_kind, status, tenant_key, log_type, plane, requested_action,
              progress_current, progress_total, preview_artifact_ref, result_json,
              error_class, last_error, requested_by, created_at, updated_at, started_at,
              completed_at, cancel_requested_at, cancel_requested_by, metadata_json
       FROM logging_catalog_repair_jobs WHERE id = ?`,
      [jobId]
    );
    return c.json(
      adminActionEnvelope(row ? serializeLoggingCatalogRepairJob(row) : payload, {
        auditId,
        jobId,
      })
    );
  } catch (error) {
    await getAdminAdapter(c).execute(
      `UPDATE logging_catalog_repair_jobs
       SET status = 'failed', error_class = ?, last_error = ?, updated_at = ?, completed_at = ?
       WHERE id = ?`,
      [
        'catalog_repair_apply_safe_failed',
        error instanceof Error ? error.message : 'catalog_repair_apply_safe_failed',
        Date.now(),
        Date.now(),
        jobId,
      ]
    );
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminLoggingRouter.post('/catalog-repair-jobs/:id/cancel', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const id = c.req.param('id');
  const now = Date.now();
  try {
    const adapter = getAdminAdapter(c);
    const row = await adapter.queryOne<LoggingCatalogRepairJobRow>(
      `SELECT id, job_kind, status, tenant_key, log_type, plane, requested_action,
              progress_current, progress_total, preview_artifact_ref, result_json,
              error_class, last_error, requested_by, created_at, updated_at, started_at,
              completed_at, cancel_requested_at, cancel_requested_by, metadata_json
       FROM logging_catalog_repair_jobs WHERE id = ?`,
      [id]
    );
    if (!row) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (!['queued', 'running'].includes(row.status)) {
      return createAdminFieldErrorResponse(c, [
        fieldError(
          'status',
          'invalid_state',
          'Only queued or running repair jobs can be cancelled.'
        ),
      ]);
    }
    await adapter.execute(
      `UPDATE logging_catalog_repair_jobs
       SET status = ?,
           cancel_requested_at = ?,
           cancel_requested_by = ?,
           updated_at = ?,
           completed_at = CASE WHEN status = 'queued' THEN ? ELSE completed_at END
       WHERE id = ?`,
      [
        row.status === 'queued' ? 'cancelled' : 'cancel_requested',
        now,
        authContext.userId ?? null,
        now,
        now,
        row.id,
      ]
    );
    const auditId = await writeAdminAuditLog(c, {
      action: 'admin_logging.catalog_repair_job.cancel',
      resourceType: 'logging_catalog_repair_job',
      resourceId: row.id,
      result: 'success',
      severity: row.status === 'running' ? 'warn' : 'info',
      metadata: { previous_status: row.status },
    });
    return c.json(
      adminActionEnvelope(
        {
          id: row.id,
          status: row.status === 'queued' ? 'cancelled' : 'cancel_requested',
          updated_at: now,
        },
        { auditId }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminLoggingRouter.get('/catalog-repairs', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const scope = await parseCatalogRepairScope(c);
  if (!scope.ok) {
    return scope.response;
  }

  try {
    const result = await detectLogCatalogRepairs(c, {
      tenantKey: scope.tenantKey,
      logType: scope.logType,
      plane: scope.plane,
    });
    return c.json(
      adminListEnvelope(result.findings, {
        page: {
          checked_at: result.now,
          pending_ttl_ms: result.pendingTtlMs,
        },
      })
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminLoggingRouter.post('/catalog-repairs/apply-safe', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const body = await parseJsonObject(c);
  const scope = await parseCatalogRepairScope(c, body);
  if (!scope.ok) {
    return scope.response;
  }
  const limit =
    typeof body.limit === 'number' && Number.isInteger(body.limit) && body.limit > 0
      ? Math.min(body.limit, 500)
      : undefined;

  try {
    const detection = await detectLogCatalogRepairs(c, {
      limit,
      tenantKey: scope.tenantKey,
      logType: scope.logType,
      plane: scope.plane,
    });
    const execution = await getAdminLoggingControlRepository(c).applySafeCatalogRepairs(
      detection.findings,
      detection.now
    );

    const auditId = await writeAdminAuditLog(c, {
      action: 'admin_logging.catalog_repair.apply_safe',
      resourceType: 'log_object_catalog',
      resourceId: 'safe-auto-repair',
      result: 'success',
      severity: execution.applied.length > 0 ? 'warn' : 'info',
      metadata: {
        checked_at: detection.now,
        pending_ttl_ms: detection.pendingTtlMs,
        finding_count: detection.findings.length,
        applied_count: execution.applied.length,
        skipped_count: execution.skipped.length,
        tenant_key: scope.tenantKey,
        log_type: scope.logType,
        plane: scope.plane,
      },
    });

    return c.json(
      adminActionEnvelope(
        {
          checked_at: detection.now,
          finding_count: detection.findings.length,
          applied_count: execution.applied.length,
          skipped_count: execution.skipped.length,
          applied: execution.applied,
          skipped: execution.skipped,
        },
        { auditId }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminLoggingRouter.post('/catalog-repairs/dangerous/preview', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const plan = await buildDangerousCatalogRepairPlanFromRequest(c);
    if (!plan.ok) {
      return plan.response;
    }
    return c.json(adminDetailEnvelope(plan.plan));
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminLoggingRouter.post('/catalog-repairs/dangerous/apply', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const parsed = await buildDangerousCatalogRepairPlanFromRequest(c);
    if (!parsed.ok) {
      return parsed.response;
    }
    if (parsed.confirmation !== parsed.plan.confirmation) {
      return createAdminFieldErrorResponse(c, [
        fieldError(
          'confirmation',
          'confirmation_mismatch',
          `Confirmation must be "${parsed.plan.confirmation}".`
        ),
      ]);
    }

    const adapter = getAdminAdapter(c);
    const now = Date.now();
    if (parsed.action === 'delete_object' && parsed.object) {
      const bucket = getCatalogObjectBucket(c, parsed.object);
      if (bucket) {
        await bucket.delete(parsed.object.object_key);
      }
      await adapter.execute(
        `UPDATE log_object_catalog
         SET status = 'deleted', deleted_at = ?
         WHERE id = ? AND status <> 'deleted'`,
        [now, parsed.object.id]
      );
      await adapter.execute(
        `UPDATE log_chunk_record_index
         SET status = 'deleted'
         WHERE object_catalog_id = ? AND status <> 'deleted'`,
        [parsed.object.id]
      );
    } else if (parsed.action === 'purge_record_indexes' && parsed.object) {
      await adapter.execute(
        `UPDATE log_chunk_record_index
         SET status = 'deleted'
         WHERE object_catalog_id = ? AND status <> 'deleted'`,
        [parsed.object.id]
      );
    } else if (parsed.action === 'rewrite_manifest_lineage' && parsed.manifest) {
      await adapter.execute(
        `UPDATE log_chunk_manifests
         SET status = 'repair_needed', updated_at = ?
         WHERE id = ?`,
        [now, parsed.manifest.id]
      );
    }

    const tenantKey =
      parsed.object?.tenant_key ?? parsed.manifest?.tenant_key ?? parsed.plan.tenantKey;
    const logType = parsed.object?.log_type ?? parsed.manifest?.log_type ?? parsed.plan.logType;
    const plane = parsed.object?.plane ?? parsed.manifest?.plane ?? parsed.plan.plane;
    await adapter.execute(
      `INSERT INTO logging_delivery_events (
        id, tenant_key, destination_id, log_type, plane, lane, status, attempt_count,
        error_class, object_catalog_id, created_at, updated_at, metadata
      ) VALUES (?, ?, NULL, ?, ?, 'critical', 'delivered', 0, NULL, ?, ?, ?, ?)`,
      [
        createLoggingId('lde', now),
        tenantKey,
        logType,
        plane,
        parsed.object?.id ?? null,
        now,
        now,
        JSON.stringify({
          action: `catalog_repair.${parsed.action}`,
          dangerous_manual: true,
          confirmation: parsed.confirmation,
          impact: parsed.plan.impact,
        }),
      ]
    );

    const auditId = await writeAdminAuditLog(c, {
      action: 'admin_logging.catalog_repair.apply_dangerous',
      resourceType: parsed.object ? 'log_object_catalog' : 'log_chunk_manifest',
      resourceId: parsed.object?.id ?? parsed.manifest?.id ?? parsed.plan.tenantKey,
      result: 'success',
      severity: 'critical',
      metadata: {
        action: parsed.action,
        confirmation: parsed.confirmation,
        impact: parsed.plan.impact,
      },
    });

    return c.json(
      adminActionEnvelope(
        {
          action: parsed.action,
          applied_at: now,
          plan: parsed.plan,
        },
        { auditId }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminLoggingRouter.get('/critical-policy', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.ADMIN_LOGGING_OVERVIEW_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    return c.json(adminDetailEnvelope(await loadAdminLoggingCriticalPolicy(c)));
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminLoggingRouter.patch('/critical-policy', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.ADMIN_LOGGING_CRITICAL_UPDATE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const body = await parseJsonObject(c);
  const destinationId = parseOptionalString(body.destination_id);
  if (!destinationId) {
    return createAdminFieldErrorResponse(c, [
      fieldError('destination_id', 'required', 'Destination id is required.'),
    ]);
  }

  try {
    const adapter = getAdminAdapter(c);
    const current = await adapter.queryOne<AdminDestinationRow>(
      `SELECT id, scope_type, scope_id, destination_kind, provider, name, display_name,
              description, lifecycle_status, health_status, rotation_status, provider_config,
              credential_ref, credential_version, next_credential_ref, next_credential_version,
              previous_credential_ref, previous_credential_retire_after, allowed_tenant_ids,
              allowed_log_types, allowed_planes, region, critical_allowed,
              default_fallback_eligible, retention_days, encryption_mode,
              last_health_check_at, version
       FROM admin_destinations
       WHERE id = ? AND deleted_at IS NULL`,
      [destinationId]
    );
    if (!current) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const expectedConfirmation = `UPDATE CRITICAL LOGGING ${current.name}`;
    if (parseOptionalString(body.confirmation) !== expectedConfirmation) {
      return createAdminFieldErrorResponse(c, [
        fieldError(
          'confirmation',
          'confirmation_mismatch',
          `Confirmation must be "${expectedConfirmation}".`
        ),
      ]);
    }

    const now = Date.now();
    const criticalAllowed = parseOptionalBoolean(body.critical_allowed, true);
    const fallbackEligible =
      typeof body.default_fallback_eligible === 'boolean'
        ? body.default_fallback_eligible
        : current.default_fallback_eligible === 1;
    const mutation = await getAdminLoggingControlRepository(c).updateCriticalPolicy({
      destinationId: current.id,
      criticalAllowed,
      defaultFallbackEligible: fallbackEligible,
      actorId: authContext.userId,
      now,
    });
    const auditId = await writeAdminAuditLog(c, {
      action: 'admin_logging.critical_policy.update',
      resourceType: 'admin_destination',
      resourceId: current.id,
      result: 'success',
      severity: 'critical',
      before: {
        critical_allowed: current.critical_allowed === 1,
        default_fallback_eligible: current.default_fallback_eligible === 1,
        version: current.version,
      },
      after: {
        critical_allowed: criticalAllowed,
        default_fallback_eligible: fallbackEligible,
        version: mutation.version,
      },
    });

    return c.json(
      adminMutationEnvelope(
        {
          id: current.id,
          critical_allowed: criticalAllowed ? 1 : 0,
          default_fallback_eligible: fallbackEligible ? 1 : 0,
          version: mutation.version,
          updated_at: now,
        },
        { auditId, version: mutation.version }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminLoggingRouter.get('/sensitive-detail-policy', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.ADMIN_LOGGING_SENSITIVE_DETAIL_POLICY_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    return c.json(adminDetailEnvelope(await loadSensitiveDetailPolicy(c)));
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminLoggingRouter.post('/sensitive-detail/probe', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, LOGGING_SENSITIVE_DETAIL_EXPORT_PERMISSION)) {
    return createAdminPermissionErrorResponse(c, {
      required_permission: LOGGING_SENSITIVE_DETAIL_EXPORT_PERMISSION,
      reason: 'sensitive_detail_probe_permission_required',
    });
  }

  const body = await parseJsonObject(c);
  const catalogId = parseOptionalString(body.catalog_id);
  const requestedTenantId = parseOptionalString(body.tenant_id);
  const objectClass = parseOptionalString(body.object_class);
  const readPayload = body.read_payload !== false;
  if (!catalogId) {
    return createAdminFieldErrorResponse(c, [
      fieldError('catalog_id', 'required', 'Sensitive detail catalog id is required.'),
    ]);
  }

  const requestedTenantFilter = await resolveTenantIdFilter(c, requestedTenantId ?? undefined);
  if (!requestedTenantFilter.ok) {
    return requestedTenantFilter.response;
  }

  try {
    const found = await findSensitiveDetailChunkProbeRow(c, {
      catalogId,
      tenantId: requestedTenantFilter.tenantId,
      objectClass,
    });
    if (!found) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const { adapter, binding, row } = found;
    const accessError = await requireTenantIdAccess(c, row.tenant_id);
    if (accessError) {
      return accessError;
    }

    let readStatus: 'not_requested' | 'ok' | 'unavailable' | 'not_found_or_unreadable' | 'error' =
      'not_requested';
    let payloadShape: string | null = null;
    if (readPayload) {
      if (!c.env.SENSITIVE_DETAILS || !c.env.OBJECT_ENCRYPTION_ROOT_KEY) {
        readStatus = 'unavailable';
      } else {
        const expectedClass = readObjectClass(row.object_class);
        if (!expectedClass) {
          readStatus = 'error';
        } else {
          try {
            const value = await loadChunkedSensitiveDetailJson<unknown>(adapter, c.env, {
              tenantId: row.tenant_id,
              objectCatalogId: row.catalog_id,
              expectedClass,
            });
            if (value === null) {
              readStatus = 'not_found_or_unreadable';
            } else {
              readStatus = 'ok';
              payloadShape = Array.isArray(value)
                ? 'array'
                : value === null
                  ? 'null'
                  : typeof value;
            }
          } catch {
            readStatus = 'error';
          }
        }
      }
    }

    const auditId = await writeAdminAuditLog(c, {
      action: 'admin_logging.sensitive_detail.probe',
      resourceType: 'sensitive_detail_chunk_index',
      resourceId: row.catalog_id,
      result:
        readStatus === 'error' || readStatus === 'not_found_or_unreadable' ? 'failure' : 'success',
      severity: 'warn',
      metadata: {
        tenant_id: row.tenant_id,
        object_class: row.object_class,
        adapter_binding: binding,
        read_status: readStatus,
      },
    });

    return c.json(
      adminMutationEnvelope(
        {
          catalog_id: row.catalog_id,
          public_artifact_id: row.public_artifact_id,
          tenant_id: row.tenant_id,
          object_class: row.object_class,
          bucket_binding: row.bucket_binding,
          object_key: row.object_key,
          content_encoding: row.content_encoding,
          line_number: toInteger(row.line_number),
          byte_offset: readNullableInteger(row.byte_offset),
          byte_length: readNullableInteger(row.byte_length),
          key_version: toInteger(row.key_version),
          checksum_sha256: row.checksum_sha256,
          created_at: toInteger(row.created_at),
          adapter_binding: binding,
          read_status: readStatus,
          payload_shape: payloadShape,
        },
        { auditId }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminLoggingRouter.patch('/sensitive-detail-policy', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.ADMIN_LOGGING_SENSITIVE_DETAIL_POLICY_UPDATE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const body = await parseJsonObject(c);
  const logType = readLogType(body.log_type);
  const destinationId = parseOptionalString(body.destination_id);
  if (!logType || !destinationId) {
    return createAdminFieldErrorResponse(c, [
      ...(!logType ? [fieldError('log_type', 'invalid_value', 'Log type is not supported.')] : []),
      ...(!destinationId
        ? [fieldError('destination_id', 'required', 'Destination id is required.')]
        : []),
    ]);
  }
  const confirmation = `CHANGE SENSITIVE DETAIL ${logType}`;
  if (parseOptionalString(body.confirmation) !== confirmation) {
    return createAdminFieldErrorResponse(c, [
      fieldError(
        'confirmation',
        'confirmation_mismatch',
        `Confirmation must be "${confirmation}".`
      ),
    ]);
  }

  try {
    const destinationResult = await requireDestinationForLoggingOverride(
      c,
      destinationId,
      null,
      logType,
      'sensitive_detail',
      true
    );
    if (!destinationResult.ok) {
      return destinationResult.response;
    }

    const now = Date.now();
    const enabled = body.enabled === undefined ? true : body.enabled !== false;
    const mutation = await getAdminLoggingControlRepository(c).updateSensitiveDetailPolicy({
      logType,
      destinationId,
      enabled,
      actorId: authContext.userId,
      now,
    });

    const auditId = await writeAdminAuditLog(c, {
      action: 'admin_logging.sensitive_detail_policy.update',
      resourceType: 'logging_destination_override',
      resourceId: mutation.id,
      result: 'success',
      severity: 'warn',
      before: mutation.previous
        ? {
            destination_id: mutation.previous.destination_id,
            enabled: toInteger(mutation.previous.enabled) === 1,
            version: mutation.previous.version,
          }
        : undefined,
      after: {
        log_type: logType,
        plane: 'sensitive_detail',
        destination_id: destinationId,
        enabled,
        version: mutation.version,
      },
    });

    return c.json(
      adminMutationEnvelope(
        {
          id: mutation.id,
          tenant_id: null,
          log_type: logType,
          plane: 'sensitive_detail',
          destination_id: destinationId,
          enabled: enabled ? 1 : 0,
          managed_by: 'platform',
          version: mutation.version,
          updated_at: now,
        },
        { auditId, version: mutation.version }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminLoggingRouter.post('/coverage/check', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.ADMIN_LOGGING_COVERAGE_UPDATE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const checkedAt = Date.now();
    const rows = adminAuditCoverageRows(checkedAt);
    await getAdminLoggingControlRepository(c).upsertCoverageStatuses(rows);

    const summary = summarizeAdminAuditCoverage(LOGGING_ADMIN_AUDIT_COVERAGE_REGISTRY, checkedAt);
    const auditId = await writeAdminAuditLog(c, {
      action: 'admin_logging.coverage.check',
      resourceType: 'admin_audit_coverage_status',
      resourceId: 'logging-admin-audit-coverage',
      result: 'success',
      severity: summary.gap_detected > 0 ? 'warn' : 'info',
      metadata: {
        checked_at: checkedAt,
        updated_count: rows.length,
        summary,
      },
    });

    return c.json(
      adminActionEnvelope(
        {
          checked_at: checkedAt,
          updated_count: rows.length,
          summary,
        },
        { auditId }
      )
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminLoggingRouter.get('/', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.ADMIN_LOGGING_OVERVIEW_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const tenantId = getTenantIdFromContext(c);
  const from = parseSince(c) ?? Date.now() - 24 * 60 * 60 * 1000;

  try {
    const adapter = getAdminAdapter(c);
    const auditSummary = await adapter.queryOne<Record<string, unknown>>(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN result = 'failure' THEN 1 ELSE 0 END) AS failures,
         SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS critical
       FROM admin_audit_log
       WHERE tenant_id = ? AND created_at >= ?`,
      [tenantId, from]
    );
    const archiveSummary = await adapter.query<Record<string, unknown>>(
      `SELECT log_type, plane, status, COUNT(*) AS chunks, SUM(record_count) AS records
       FROM log_object_catalog
       WHERE created_at >= ? AND (
         log_type IN ('admin_audit', 'audit')
         OR plane = 'sensitive_detail'
       )
       GROUP BY log_type, plane, status
       ORDER BY log_type ASC, plane ASC, status ASC`,
      [from]
    );
    const deliverySummary = await adapter.query<Record<string, unknown>>(
      `SELECT lane, status, SUM(batch_count) AS total
       FROM logging_delivery_event_aggregates
       WHERE bucket_start_at >= ?
       GROUP BY lane, status
       ORDER BY lane ASC, status ASC`,
      [from]
    );
    const recentChanges = await adapter.query<Record<string, unknown>>(
      `SELECT id AS audit_id, admin_user_id AS actor_id, action, resource_type, resource_id,
              severity, created_at
       FROM admin_audit_log
       WHERE created_at >= ?
         AND (
           severity = 'critical'
           OR action LIKE 'admin_logging.%'
           OR action LIKE 'logging_policy_%'
           OR action = 'logging_policy_snapshot.publish'
         )
       ORDER BY created_at DESC
       LIMIT 20`,
      [from]
    );
    const criticalPolicy = await loadAdminLoggingCriticalPolicy(c);
    const sensitiveDetailPolicy = await loadSensitiveDetailPolicy(c);

    return c.json(
      adminDetailEnvelope({
        tenant_id: tenantId,
        window_start_at: from,
        coverage: summarizeAdminAuditCoverage(LOGGING_ADMIN_AUDIT_COVERAGE_REGISTRY),
        critical_protection: criticalPolicy.summary,
        sensitive_detail: sensitiveDetailPolicy.summary,
        audit: auditSummary ?? { total: 0, failures: 0, critical: 0 },
        recent_changes: recentChanges,
        archive: archiveSummary,
        delivery: deliverySummary,
      })
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});
