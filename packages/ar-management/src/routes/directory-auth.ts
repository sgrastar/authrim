import { z } from 'zod';
import type { Context } from 'hono';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import {
  ADMIN_PERMISSIONS,
  AR_ERROR_CODES,
  cleanupExpiredDirectoryAuthMaintenance,
  createAuthContextFromHono,
  createAuditLogFromContext,
  createErrorResponse,
  createDirectoryAuthId,
  ensureDirectoryAuthDefaults,
  ensureDirectoryAuthTenantPolicy,
  getDirectoryAuthRetentionPolicy,
  getDirectoryAuthTenantPolicy,
  getDirectoryAuthEvidenceExport,
  getDirectoryAuthSupportBundle,
  ensureDirectoryAuthRetentionPolicy,
  hasAdminPermission,
  listDirectoryAuthEvidenceExportsReadyForHardDelete,
  listDirectoryAuthConfigHistory,
  listDirectoryAuthSupportBundlesReadyForHardDelete,
  loadCatalogObjectRepresentation,
  listDirectoryAuthEvidenceExports,
  listDirectoryAuthMigrationCampaigns,
  listDirectoryAuthMigrationUserStates,
  listDirectoryAuthReleaseAdvisories,
  listDirectoryAuthSupportBundles,
  matchDirectoryAuthReleaseAdvisories,
  markDirectoryAuthEvidenceExportDeleted,
  markDirectoryAuthSupportBundleDeleted,
  tombstoneObjectCatalogEntryForTenant,
  createDirectoryAuthEvidenceExportJob,
  createDirectoryAuthMigrationCampaign,
  createDirectoryAuthSupportBundleRequest,
  resetDirectoryAuthMigrationUserState,
  updateDirectoryAuthMigrationCampaign,
  updateDirectoryAuthRetentionPolicy,
  updateDirectoryAuthTenantPolicy,
  type DirectoryAuthConfigHistoryRow,
  type DirectoryAuthEmailCodeFallbackMode,
  type DirectoryAuthMigrationCampaignRow,
  type DirectoryAuthEvidenceExportRow,
  type DirectoryAuthSupportBundleRow,
  type DirectoryAuthMigrationUserState,
  type DirectoryAuthSupportBundleRedactionLevel,
} from '@authrim/ar-lib-core';
import {
  applyDirectoryConnectorFleetPolicy,
  listDirectoryConnectorEpisodes,
  listDirectoryConnectorInstances,
  refreshDirectoryConnectorDerivedStatuses,
  type DirectoryConnectorFleetPolicy,
  type DirectoryConnectorInstanceRow,
} from '@authrim/ar-lib-core/services/directory-connector-fleet';
import { getAdminAuth, requireTenantResourceAccess } from '../admin-tenant-access';
import { materializeEncryptedObjectArtifact } from '../object-artifact-materialization';

const MAX_LIST_LIMIT = 100;
const MIN_AUTHRIM_RETENTION_DAYS = 30;
const MAX_AUTHRIM_RETENTION_DAYS = 7 * 365;
const MIN_WORDWARDEN_RETENTION_DAYS = 1;
const MAX_WORDWARDEN_RETENTION_DAYS = 30;
const MIN_ARTIFACT_DELETE_GRACE_HOURS = 24;
const MAX_ARTIFACT_DELETE_GRACE_HOURS = 7 * 24;
const DIRECTORY_AUTH_EVIDENCE_HARD_DELETE_LIMIT = 25;
const DIRECTORY_AUTH_EVIDENCE_EXPORT_PERMISSION =
  ADMIN_PERMISSIONS.DIRECTORY_AUTH_EVIDENCE_EXPORT_CREATE;
const DIRECTORY_AUTH_MIGRATION_WRITE_PERMISSION = ADMIN_PERMISSIONS.DIRECTORY_AUTH_MIGRATION_WRITE;
const DIRECTORY_AUTH_WRITE_PERMISSION = ADMIN_PERMISSIONS.DIRECTORY_AUTH_WRITE;
const DIRECTORY_AUTH_TENANT_ADMIN_ROLES = new Set([
  'system_admin',
  'distributor_admin',
  'tenant_admin',
  'admin',
]);

const EmailCodeFallbackModeSchema = z.enum([
  'migration_recovery',
  'directory_unavailable_recovery',
  'admin_invitation_only',
  'login_method',
  'disabled',
]);

const CampaignEmailCodeFallbackModeSchema = z.enum([
  'tenant_default',
  'migration_recovery',
  'directory_unavailable_recovery',
  'admin_invitation_only',
  'login_method',
  'disabled',
]);

const CampaignSchema = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(1000).nullable().optional(),
  status: z.enum(['disabled', 'draft', 'active', 'paused', 'archived']).optional(),
  mode: z
    .enum([
      'directory_login_allowed',
      'prompt_passkey',
      'grace_then_require_passkey',
      'require_passkey_after_directory',
      'disabled',
    ])
    .optional(),
  passkey_prompt_mode: z.enum(['none', 'optional', 'campaign_only']).optional(),
  email_code_fallback_mode: CampaignEmailCodeFallbackModeSchema.optional(),
  grace_period_days: z.number().int().min(0).max(365).optional(),
  transaction_ttl_seconds: z.number().int().min(300).max(1800).optional(),
  target_policy: z.unknown().optional(),
});

const CampaignUpdateSchema = CampaignSchema.partial().refine((value) => Object.keys(value).length > 0);

const TenantPolicySchema = z
  .object({
    email_code_fallback_mode: EmailCodeFallbackModeSchema,
  })
  .strict();

const UserStateResetSchema = z.object({
  reason: z.string().max(1000).optional(),
  next_state: z
    .enum([
      'not_applicable',
      'eligible',
      'prompted',
      'deferred',
      'passkey_required',
      'enrolled',
      'blocked',
      'recovered',
    ])
    .optional(),
});

const RetentionPolicySchema = z.object({
  authrim_audit_retention_days: z
    .number()
    .int()
    .min(MIN_AUTHRIM_RETENTION_DAYS)
    .max(MAX_AUTHRIM_RETENTION_DAYS),
  wordwarden_local_retention_days: z
    .union([
      z.null(),
      z.number().int().min(MIN_WORDWARDEN_RETENTION_DAYS).max(MAX_WORDWARDEN_RETENTION_DAYS),
    ])
    .default(14),
  artifact_delete_grace_hours: z
    .number()
    .int()
    .min(MIN_ARTIFACT_DELETE_GRACE_HOURS)
    .max(MAX_ARTIFACT_DELETE_GRACE_HOURS)
    .default(72),
});

const EvidenceExportCreateSchema = z.object({
  period_start_at: z.union([z.number().int(), z.string().min(1)]),
  period_end_at: z.union([z.number().int(), z.string().min(1)]),
  size_estimate_bytes: z.number().int().min(0).optional(),
  download_after_delete: z.boolean().optional(),
});

const SupportBundleScopeSchema = z
  .object({
    connector_ids: z
      .array(z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/))
      .max(20)
      .optional(),
    include_recent_episodes: z.boolean().optional(),
    include_advisories: z.boolean().optional(),
  })
  .strict();

const SupportBundleCreateSchema = z.object({
  redaction_level: z.enum(['minimal', 'standard', 'detailed']).default('standard'),
  scope: SupportBundleScopeSchema.optional(),
  consent_summary: z
    .object({
      operator_confirmed: z.literal(true),
      detailed_warning_acknowledged: z.boolean().optional(),
    })
    .strict(),
});

const MaintenanceCleanupSchema = z
  .object({
    reason: z.string().max(1000).optional(),
  })
  .strict();

interface SerializedCampaign extends Omit<DirectoryAuthMigrationCampaignRow, 'target_policy_json'> {
  target_policy: unknown;
  effective_email_code_fallback_mode: DirectoryAuthEmailCodeFallbackMode;
}

function coreAdapter(c: Context<{ Bindings: Env }>, tenantId: string): DatabaseAdapter {
  return createAuthContextFromHono(c, tenantId).coreAdapter;
}

function adminActorId(c: Context<{ Bindings: Env }>): string {
  const adminAuth = getAdminAuth(c);
  return adminAuth?.userId ?? 'unknown';
}

function isElevatedAdmin(c: Context<{ Bindings: Env }>): boolean {
  const adminAuth = getAdminAuth(c);
  return Boolean(
    adminAuth?.roles.some((role) => role === 'system_admin' || role === 'super_admin')
  );
}

async function requireTenantAccess(c: Context<{ Bindings: Env }>, tenantId: string) {
  return requireTenantResourceAccess(c, tenantId);
}

async function requireTenantAdminRole(c: Context<{ Bindings: Env }>, reason: string) {
  if (isElevatedAdmin(c)) return null;
  const roles = getAdminAuth(c)?.roles ?? [];
  if (roles.some((role) => DIRECTORY_AUTH_TENANT_ADMIN_ROLES.has(role))) return null;
  return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS, {
    variables: {
      required_role: 'tenant_admin',
      reason,
    },
  });
}

async function requireEvidenceExportPermission(c: Context<{ Bindings: Env }>) {
  if (isElevatedAdmin(c)) return null;
  const permissions = getAdminAuth(c)?.permissions ?? [];
  if (hasAdminPermission(permissions, DIRECTORY_AUTH_EVIDENCE_EXPORT_PERMISSION)) return null;
  return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS, {
    variables: {
      required_permission: DIRECTORY_AUTH_EVIDENCE_EXPORT_PERMISSION,
      reason: 'Evidence export requires a dedicated audit/export permission',
    },
  });
}

async function requireMigrationWritePermission(c: Context<{ Bindings: Env }>) {
  if (isElevatedAdmin(c)) return null;
  const permissions = getAdminAuth(c)?.permissions ?? [];
  if (hasAdminPermission(permissions, DIRECTORY_AUTH_MIGRATION_WRITE_PERMISSION)) return null;
  return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS, {
    variables: {
      required_permission: DIRECTORY_AUTH_MIGRATION_WRITE_PERMISSION,
      reason: 'Directory migration changes require a dedicated migration policy permission',
    },
  });
}

async function requireDirectoryAuthWritePermission(c: Context<{ Bindings: Env }>) {
  if (isElevatedAdmin(c)) return null;
  const permissions = getAdminAuth(c)?.permissions ?? [];
  if (hasAdminPermission(permissions, DIRECTORY_AUTH_WRITE_PERMISSION)) return null;
  return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS, {
    variables: {
      required_permission: DIRECTORY_AUTH_WRITE_PERMISSION,
      reason: 'Directory authentication support bundle artifacts require write permission',
    },
  });
}

function readLimit(c: Context<{ Bindings: Env }>): number {
  const parsed = Number.parseInt(c.req.query('limit') ?? '50', 10);
  if (!Number.isFinite(parsed)) return 50;
  return Math.max(1, Math.min(MAX_LIST_LIMIT, parsed));
}

function readEpochMs(value: string | number): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const parsedNumber = Number.parseInt(value, 10);
  if (Number.isFinite(parsedNumber) && String(parsedNumber) === value.trim()) {
    return parsedNumber;
  }
  const parsedDate = Date.parse(value);
  return Number.isFinite(parsedDate) ? parsedDate : null;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

type SupportBundleScope = z.infer<typeof SupportBundleScopeSchema>;

function filterBySupportBundleConnectors<T extends { connector_id?: unknown }>(
  records: T[],
  scope: SupportBundleScope | undefined
): T[] {
  const connectorIds = scope?.connector_ids;
  if (!connectorIds || connectorIds.length === 0) return records;
  const allowed = new Set(connectorIds);
  return records.filter(
    (record) => typeof record.connector_id === 'string' && allowed.has(record.connector_id)
  );
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function getObjectEncryptionKeyVersion(env: Env): number {
  return Number.parseInt(env.OBJECT_ENCRYPTION_KEY_VERSION || '1', 10) || 1;
}

function serializeEvidenceExport(row: DirectoryAuthEvidenceExportRow, tenantId: string) {
  const { object_catalog_id: _objectCatalogId, ...publicRow } = row;
  return {
    ...publicRow,
    artifact_download_url:
      row.status === 'ready' && row.object_catalog_id
        ? `/api/admin/tenants/${encodeURIComponent(
            tenantId
          )}/directory-auth/compliance/evidence-exports/${encodeURIComponent(row.id)}/download`
        : null,
  };
}

function serializeSupportBundle(row: DirectoryAuthSupportBundleRow, tenantId: string) {
  const { object_catalog_id: _objectCatalogId, ...publicRow } = row;
  return {
    ...publicRow,
    artifact_download_url:
      row.status === 'ready' && row.object_catalog_id
        ? `/api/admin/tenants/${encodeURIComponent(
            tenantId
          )}/directory-auth/support/bundles/${encodeURIComponent(row.id)}/download`
        : null,
  };
}

function serializeConfigHistory(row: DirectoryAuthConfigHistoryRow) {
  return {
    ...row,
    before_redacted: parseJson(row.before_redacted_json),
    after_redacted: parseJson(row.after_redacted_json),
  };
}

function directoryAuthSummaryLinks(tenantId: string) {
  const encodedTenantId = encodeURIComponent(tenantId);
  return [
    {
      label: 'Public compliance summary',
      href: '/docs/directory-authentication-public-summary',
    },
    {
      label: 'Migration summary',
      href: `/admin/directory-authentication/migration?tenant_id=${encodedTenantId}`,
    },
    {
      label: 'Fleet summary',
      href: `/admin/directory-authentication/fleet?tenant_id=${encodedTenantId}`,
    },
  ];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function readDirectoryConnectorFleetPolicies(
  env: Env,
  tenantId: string
): Promise<Map<string, DirectoryConnectorFleetPolicy>> {
  const raw = await env.SETTINGS?.get(`settings:tenant:${tenantId}:directory-connectors`).catch(
    () => null
  );
  if (!raw) return new Map();
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return new Map();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map();
  const connectors = (parsed as { connectors?: unknown }).connectors;
  if (!Array.isArray(connectors)) return new Map();
  const policies = new Map<string, DirectoryConnectorFleetPolicy>();
  for (const connector of connectors) {
    if (!connector || typeof connector !== 'object' || Array.isArray(connector)) continue;
    const record = connector as Record<string, unknown>;
    const connectorId = typeof record.connector_id === 'string' ? record.connector_id : '';
    const heartbeat =
      record.heartbeat && typeof record.heartbeat === 'object' && !Array.isArray(record.heartbeat)
        ? (record.heartbeat as Record<string, unknown>)
        : {};
    if (!connectorId) continue;
    policies.set(connectorId, {
      staleAfterMs: numberValue(heartbeat.stale_after_ms),
      staleDetectionGraceMs: numberValue(heartbeat.stale_detection_grace_ms),
      versionMismatchPolicy: heartbeat.version_mismatch_policy === 'block' ? 'block' : 'warn',
      expectedVersion: stringValue(heartbeat.expected_version),
      minimumVersion: stringValue(heartbeat.minimum_version),
    });
  }
  return policies;
}

function serializeCampaign(
  row: DirectoryAuthMigrationCampaignRow,
  tenantFallbackMode: DirectoryAuthEmailCodeFallbackMode
): SerializedCampaign {
  const { target_policy_json: _targetPolicyJson, ...rest } = row;
  return {
    ...rest,
    target_policy: parseJson(row.target_policy_json),
    effective_email_code_fallback_mode:
      row.email_code_fallback_mode === 'tenant_default'
        ? tenantFallbackMode
        : row.email_code_fallback_mode,
  };
}

function readUserState(value: string | undefined): DirectoryAuthMigrationUserState | undefined {
  if (
    value === 'not_applicable' ||
    value === 'eligible' ||
    value === 'prompted' ||
    value === 'deferred' ||
    value === 'passkey_required' ||
    value === 'enrolled' ||
    value === 'blocked' ||
    value === 'recovered'
  ) {
    return value;
  }
  return undefined;
}

async function auditDirectoryAuthAction(
  c: Context<{ Bindings: Env }>,
  action: string,
  resourceType: string,
  resourceId: string,
  tenantId: string,
  details: Record<string, unknown>
): Promise<void> {
  await createAuditLogFromContext(
    c as unknown as Parameters<typeof createAuditLogFromContext>[0],
    action,
    resourceType,
    resourceId,
    {
      tenant_id: tenantId,
      ...details,
    }
  ).catch(() => undefined);
}

async function buildDirectoryAuthEvidenceArtifact(
  adapter: DatabaseAdapter,
  input: {
    tenantId: string;
    exportId: string;
    requestedBy: string;
    periodStartAt: number;
    periodEndAt: number;
    downloadAfterDelete: boolean;
    generatedAt: number;
  }
): Promise<string> {
  const periodParams = [input.tenantId, input.periodStartAt, input.periodEndAt, 1000];
  const [
    campaigns,
    userStates,
    transactions,
    configHistory,
    tenantPolicy,
    retentionPolicy,
    supportBundles,
    advisories,
  ] = await Promise.all([
    adapter.query<Record<string, unknown>>(
      `SELECT id, tenant_id, name, status, mode, passkey_prompt_mode,
              email_code_fallback_mode, grace_period_days, transaction_ttl_seconds,
              enforcement_start_mode, is_template, created_by, created_at, updated_at
         FROM directory_auth_migration_campaigns
        WHERE tenant_id = ?
          AND updated_at >= ?
          AND updated_at <= ?
        ORDER BY updated_at ASC
        LIMIT ?`,
      periodParams
    ),
    adapter.query<Record<string, unknown>>(
      `SELECT id, tenant_id, campaign_id, user_id, connector_id,
              CASE WHEN directory_subject IS NULL THEN 0 ELSE 1 END AS directory_subject_present,
              cohort_key, state, first_directory_login_at, prompted_at, deferred_until,
              passkey_required_at, enrolled_at, blocked_reason, recovery_reason,
              reset_count, last_reset_at, last_reset_by, last_reset_reason,
              created_at, updated_at
         FROM directory_auth_migration_user_states
        WHERE tenant_id = ?
          AND updated_at >= ?
          AND updated_at <= ?
        ORDER BY updated_at ASC
        LIMIT ?`,
      periodParams
    ),
    adapter.query<Record<string, unknown>>(
      `SELECT id, tenant_id, campaign_id, user_id, connector_id,
              scope, state, request_id, authorization_challenge_id,
              created_at, updated_at, expires_at, completed_at, blocked_reason
         FROM directory_auth_migration_transactions
        WHERE tenant_id = ?
          AND created_at >= ?
          AND created_at <= ?
        ORDER BY created_at ASC
        LIMIT ?`,
      periodParams
    ),
    adapter.query<Record<string, unknown>>(
      `SELECT id, tenant_id, actor_id, category, action, resource_type, resource_id,
              before_redacted_json, after_redacted_json, created_at
         FROM directory_auth_config_history
        WHERE tenant_id = ?
          AND created_at >= ?
          AND created_at <= ?
        ORDER BY created_at ASC
        LIMIT ?`,
      periodParams
    ),
    getDirectoryAuthTenantPolicy(adapter, input.tenantId),
    getDirectoryAuthRetentionPolicy(adapter, input.tenantId),
    adapter.query<Record<string, unknown>>(
      `SELECT id, tenant_id, requested_by, redaction_level, status,
              artifact_sha256, retention_expires_at, created_at, updated_at,
              completed_at, deleted_at
         FROM directory_auth_support_bundles
        WHERE tenant_id = ?
          AND created_at >= ?
          AND created_at <= ?
        ORDER BY created_at ASC
        LIMIT ?`,
      periodParams
    ),
    adapter.query<Record<string, unknown>>(
      `SELECT id, channel, severity, affected_versions_json, fixed_version,
              summary, published_at, updated_at, release_url
         FROM directory_auth_release_advisories
        WHERE updated_at >= ?
          AND updated_at <= ?
        ORDER BY updated_at ASC
        LIMIT ?`,
      [input.periodStartAt, input.periodEndAt, 1000]
    ),
  ]);

  return JSON.stringify(
    {
      type: 'directory_auth_evidence_export',
      version: 1,
      generated_at: input.generatedAt,
      tenant_id: input.tenantId,
      export_id: input.exportId,
      requested_by: input.requestedBy,
      period: {
        start_at: input.periodStartAt,
        end_at: input.periodEndAt,
      },
      download_after_delete: input.downloadAfterDelete,
      redaction: {
        excludes: ['passwords', 'password_hashes', 'connector_secrets', 'transaction_token_hashes'],
        directory_subject: 'presence_only',
      },
      sections: {
        migration_campaigns: campaigns,
        migration_user_states: userStates,
        migration_transactions: transactions,
        config_history: configHistory,
        tenant_policy: tenantPolicy,
        retention_policy: retentionPolicy,
        support_bundle_metadata: supportBundles,
        wordwarden_advisories: advisories,
      },
    },
    null,
    2
  );
}

async function buildDirectoryAuthSupportBundleArtifact(
  adapter: DatabaseAdapter,
  input: {
    tenantId: string;
    bundleId: string;
    requestedBy: string;
    redactionLevel: DirectoryAuthSupportBundleRedactionLevel;
    scope: SupportBundleScope | undefined;
    consentSummary: unknown;
    generatedAt: number;
  }
): Promise<string> {
  const [retentionPolicy, evidenceExports, supportBundles, advisories, connectorInstances, episodes] =
    await Promise.all([
      getDirectoryAuthRetentionPolicy(adapter, input.tenantId),
      adapter.query<Record<string, unknown>>(
        `SELECT id, tenant_id, status, requested_by, period_start_at, period_end_at,
                artifact_sha256, retention_expires_at, download_after_delete,
                error_code, created_at, updated_at, completed_at, deleted_at
           FROM directory_auth_evidence_exports
          WHERE tenant_id = ?
          ORDER BY created_at DESC
          LIMIT 50`,
        [input.tenantId]
      ),
      adapter.query<Record<string, unknown>>(
        `SELECT id, tenant_id, requested_by, redaction_level, status,
                artifact_sha256, retention_expires_at, created_at, updated_at,
                completed_at, deleted_at
           FROM directory_auth_support_bundles
          WHERE tenant_id = ?
          ORDER BY created_at DESC
          LIMIT 50`,
        [input.tenantId]
      ),
      adapter.query<Record<string, unknown>>(
        `SELECT id, channel, severity, affected_versions_json, fixed_version,
                summary, published_at, updated_at, release_url
           FROM directory_auth_release_advisories
          ORDER BY updated_at DESC
          LIMIT 50`
      ),
      adapter.query<Record<string, unknown>>(
        `SELECT tenant_id, connector_id, instance_id, display_name, transport, version,
                COALESCE(release_channel, 'stable') AS release_channel,
                started_at, first_seen_at, last_seen_at, status, health_status,
                config_categories_json, drift_severity, deactivated_at,
                CASE WHEN deactivation_reason IS NULL THEN 0 ELSE 1 END AS deactivation_reason_present,
                updated_at
           FROM directory_connector_instances
          WHERE tenant_id = ?
          ORDER BY last_seen_at DESC
          LIMIT 50`,
        [input.tenantId]
      ),
      adapter.query<Record<string, unknown>>(
        `SELECT tenant_id, connector_id, instance_id, status, started_at,
                ended_at, last_seen_at,
                CASE WHEN reason IS NULL THEN 0 ELSE 1 END AS reason_present,
                acknowledged_at, created_at, updated_at
           FROM directory_connector_status_episodes
          WHERE tenant_id = ?
          ORDER BY started_at DESC
          LIMIT 50`,
        [input.tenantId]
      ),
    ]);

  return JSON.stringify(
    {
      type: 'directory_auth_support_bundle',
      version: 1,
      generated_at: input.generatedAt,
      tenant_id: input.tenantId,
      bundle_id: input.bundleId,
      requested_by: input.requestedBy,
      redaction_level: input.redactionLevel,
      scope: input.scope ?? {},
      consent_summary: input.consentSummary ?? {},
      redaction: {
        excludes: [
          'passwords',
          'password_hashes',
          'connector_secrets',
          'hmac_secrets',
          'bearer_tokens',
          'full_ldap_filters',
          'ldap_endpoint_values',
        ],
        connector_config: 'category_and_status_only',
      },
      sections: {
        retention_policy: retentionPolicy,
        evidence_export_metadata: evidenceExports,
        support_bundle_metadata: supportBundles,
        wordwarden_advisories: input.scope?.include_advisories === false ? [] : advisories,
        connector_instances: filterBySupportBundleConnectors(connectorInstances, input.scope),
        connector_status_episodes:
          input.scope?.include_recent_episodes === false
            ? []
            : filterBySupportBundleConnectors(episodes, input.scope),
      },
    },
    null,
    2
  );
}

export async function getDirectoryAuthOverviewHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const accessError = await requireTenantAccess(c, tenantId);
  if (accessError) return accessError;

  const adapter = coreAdapter(c, tenantId);
  await ensureDirectoryAuthDefaults(adapter, tenantId, adminActorId(c));
  const [
    campaigns,
    userStates,
    tenantPolicy,
    retentionPolicy,
    evidenceExports,
    supportBundles,
    configHistory,
    advisories,
  ] =
    await Promise.all([
      listDirectoryAuthMigrationCampaigns(adapter, tenantId),
      listDirectoryAuthMigrationUserStates(adapter, tenantId, { limit: 20 }),
      ensureDirectoryAuthTenantPolicy(adapter, tenantId, adminActorId(c)),
      getDirectoryAuthRetentionPolicy(adapter, tenantId),
      listDirectoryAuthEvidenceExports(adapter, tenantId, 10),
      listDirectoryAuthSupportBundles(adapter, tenantId, 10),
      listDirectoryAuthConfigHistory(adapter, tenantId, { limit: 20 }),
      listDirectoryAuthReleaseAdvisories(adapter, 'stable', 10),
    ]);

  return c.json({
    tenantId,
    policy: tenantPolicy,
    migration: {
      campaigns: campaigns.map((row) => serializeCampaign(row, tenantPolicy.email_code_fallback_mode)),
      user_states: userStates,
    },
    compliance: {
      retention_policy: retentionPolicy,
      evidence_exports: evidenceExports.map((row) => serializeEvidenceExport(row, tenantId)),
      support_bundles: supportBundles.map((row) => serializeSupportBundle(row, tenantId)),
      config_history: configHistory.map(serializeConfigHistory),
      public_summary_links: directoryAuthSummaryLinks(tenantId),
    },
    managed_connector: {
      advisories,
      heartbeat_fields: [
        'connector_id',
        'version',
        'platform',
        'release_channel',
        'health_status',
        'redacted_error_code',
        'last_seen_at',
      ],
    },
  });
}

export async function listDirectoryAuthMigrationCampaignsHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const accessError = await requireTenantAccess(c, tenantId);
  if (accessError) return accessError;

  const adapter = coreAdapter(c, tenantId);
  await ensureDirectoryAuthDefaults(adapter, tenantId, adminActorId(c));
  const [campaigns, tenantPolicy] = await Promise.all([
    listDirectoryAuthMigrationCampaigns(adapter, tenantId),
    ensureDirectoryAuthTenantPolicy(adapter, tenantId, adminActorId(c)),
  ]);
  return c.json({
    tenantId,
    items: campaigns.map((row) => serializeCampaign(row, tenantPolicy.email_code_fallback_mode)),
  });
}

export async function getDirectoryAuthTenantPolicyHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const accessError = await requireTenantAccess(c, tenantId);
  if (accessError) return accessError;

  const adapter = coreAdapter(c, tenantId);
  const policy =
    (await getDirectoryAuthTenantPolicy(adapter, tenantId)) ??
    (await ensureDirectoryAuthTenantPolicy(adapter, tenantId, adminActorId(c)));
  return c.json({ tenantId, policy });
}

export async function updateDirectoryAuthTenantPolicyHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const accessError = await requireTenantAccess(c, tenantId);
  if (accessError) return accessError;
  const permissionError = await requireDirectoryAuthWritePermission(c);
  if (permissionError) return permissionError;

  const body = await c.req.json().catch(() => null);
  const parsed = TenantPolicySchema.safeParse(body);
  if (!parsed.success) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  const policy = await updateDirectoryAuthTenantPolicy(coreAdapter(c, tenantId), {
    tenantId,
    emailCodeFallbackMode: parsed.data.email_code_fallback_mode,
    actorId: adminActorId(c),
  });
  await auditDirectoryAuthAction(
    c,
    'directory_auth.tenant_policy.updated',
    'directory_auth_tenant_policy',
    tenantId,
    tenantId,
    { email_code_fallback_mode: policy.email_code_fallback_mode }
  );
  return c.json({ tenantId, policy });
}

export async function createDirectoryAuthMigrationCampaignHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const accessError = await requireTenantAccess(c, tenantId);
  if (accessError) return accessError;
  const permissionError = await requireMigrationWritePermission(c);
  if (permissionError) return permissionError;

  const body = await c.req.json().catch(() => null);
  const parsed = CampaignSchema.safeParse(body);
  if (!parsed.success) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }

  const actorId = adminActorId(c);
  const tenantPolicy = await ensureDirectoryAuthTenantPolicy(coreAdapter(c, tenantId), tenantId, actorId);
  const campaign = await createDirectoryAuthMigrationCampaign(coreAdapter(c, tenantId), {
    tenantId,
    name: parsed.data.name,
    description: parsed.data.description,
    status: parsed.data.status,
    mode: parsed.data.mode,
    passkeyPromptMode: parsed.data.passkey_prompt_mode,
    emailCodeFallbackMode: parsed.data.email_code_fallback_mode,
    gracePeriodDays: parsed.data.grace_period_days,
    transactionTtlSeconds: parsed.data.transaction_ttl_seconds,
    targetPolicy: parsed.data.target_policy,
    actorId,
  });
  await auditDirectoryAuthAction(
    c,
    'directory_auth.migration_campaign.created',
    'directory_auth_migration_campaign',
    campaign.id,
    tenantId,
    { status: campaign.status, mode: campaign.mode }
  );
  return c.json({ tenantId, item: serializeCampaign(campaign, tenantPolicy.email_code_fallback_mode) }, 201);
}

export async function updateDirectoryAuthMigrationCampaignHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const campaignId = c.req.param('campaignId')!;
  const accessError = await requireTenantAccess(c, tenantId);
  if (accessError) return accessError;
  const permissionError = await requireMigrationWritePermission(c);
  if (permissionError) return permissionError;

  const body = await c.req.json().catch(() => null);
  const parsed = CampaignUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }

  const adapter = coreAdapter(c, tenantId);
  const tenantPolicy = await ensureDirectoryAuthTenantPolicy(adapter, tenantId, adminActorId(c));
  const campaign = await updateDirectoryAuthMigrationCampaign(adapter, {
    tenantId,
    campaignId,
    name: parsed.data.name,
    description: parsed.data.description,
    status: parsed.data.status,
    mode: parsed.data.mode,
    passkeyPromptMode: parsed.data.passkey_prompt_mode,
    emailCodeFallbackMode: parsed.data.email_code_fallback_mode,
    gracePeriodDays: parsed.data.grace_period_days,
    transactionTtlSeconds: parsed.data.transaction_ttl_seconds,
    targetPolicy: parsed.data.target_policy,
    actorId: adminActorId(c),
  });
  if (!campaign) {
    return c.json({ error: 'directory_auth_campaign_not_found' }, 404);
  }
  await auditDirectoryAuthAction(
    c,
    'directory_auth.migration_campaign.updated',
    'directory_auth_migration_campaign',
    campaign.id,
    tenantId,
    { status: campaign.status, mode: campaign.mode }
  );
  return c.json({ tenantId, item: serializeCampaign(campaign, tenantPolicy.email_code_fallback_mode) });
}

export async function listDirectoryAuthMigrationUserStatesHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const accessError = await requireTenantAccess(c, tenantId);
  if (accessError) return accessError;

  const state = readUserState(c.req.query('state'));
  const requestedState = c.req.query('state');
  if (requestedState && !state) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  const items = await listDirectoryAuthMigrationUserStates(coreAdapter(c, tenantId), tenantId, {
    state,
    campaignId: c.req.query('campaign_id'),
    userId: c.req.query('user_id'),
    limit: readLimit(c),
  });
  return c.json({ tenantId, items });
}

export async function resetDirectoryAuthMigrationUserStateHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const stateId = c.req.param('stateId')!;
  const accessError = await requireTenantAccess(c, tenantId);
  if (accessError) return accessError;
  const permissionError = await requireMigrationWritePermission(c);
  if (permissionError) return permissionError;

  const body = await c.req.json().catch(() => null);
  const parsed = UserStateResetSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  const item = await resetDirectoryAuthMigrationUserState(coreAdapter(c, tenantId), {
    tenantId,
    stateId,
    actorId: adminActorId(c),
    reason: parsed.data.reason,
    nextState: parsed.data.next_state,
  });
  if (!item) {
    return c.json({ error: 'directory_auth_migration_state_not_found' }, 404);
  }
  await auditDirectoryAuthAction(
    c,
    'directory_auth.migration_state.reset',
    'directory_auth_migration_user_state',
    stateId,
    tenantId,
    { next_state: item.state }
  );
  return c.json({ tenantId, item });
}

export async function getDirectoryAuthRetentionPolicyHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const accessError = await requireTenantAccess(c, tenantId);
  if (accessError) return accessError;

  const adapter = coreAdapter(c, tenantId);
  const policy =
    (await getDirectoryAuthRetentionPolicy(adapter, tenantId)) ??
    (await ensureDirectoryAuthRetentionPolicy(adapter, tenantId, adminActorId(c)));
  return c.json({ tenantId, policy });
}

export async function updateDirectoryAuthRetentionPolicyHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const accessError = await requireTenantAccess(c, tenantId);
  if (accessError) return accessError;

  const body = await c.req.json().catch(() => null);
  const parsed = RetentionPolicySchema.safeParse(body);
  if (!parsed.success) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  const policy = await updateDirectoryAuthRetentionPolicy(coreAdapter(c, tenantId), {
    tenantId,
    authrimAuditRetentionDays: parsed.data.authrim_audit_retention_days,
    wordwardenLocalRetentionDays: parsed.data.wordwarden_local_retention_days,
    artifactDeleteGraceHours: parsed.data.artifact_delete_grace_hours,
    actorId: adminActorId(c),
  });
  await auditDirectoryAuthAction(
    c,
    'directory_auth.retention_policy.updated',
    'directory_auth_retention_policy',
    tenantId,
    tenantId,
    {
      authrim_audit_retention_days: policy.authrim_audit_retention_days,
      wordwarden_local_retention_days: policy.wordwarden_local_retention_days,
      artifact_delete_grace_hours: policy.artifact_delete_grace_hours,
    }
  );
  return c.json({ tenantId, policy });
}

export async function listDirectoryAuthConfigHistoryHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const accessError = await requireTenantAccess(c, tenantId);
  if (accessError) return accessError;

  const items = await listDirectoryAuthConfigHistory(coreAdapter(c, tenantId), tenantId, {
    category: c.req.query('category'),
    limit: readLimit(c),
  });
  return c.json({
    tenantId,
    items: items.map(serializeConfigHistory),
    public_summary_links: directoryAuthSummaryLinks(tenantId),
  });
}

export async function listDirectoryAuthEvidenceExportsHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const accessError = await requireTenantAccess(c, tenantId);
  if (accessError) return accessError;

  const permissionError = await requireEvidenceExportPermission(c);
  if (permissionError) return permissionError;

  const items = await listDirectoryAuthEvidenceExports(coreAdapter(c, tenantId), tenantId, readLimit(c));
  return c.json({ tenantId, items: items.map((row) => serializeEvidenceExport(row, tenantId)) });
}

export async function createDirectoryAuthEvidenceExportHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const accessError = await requireTenantAccess(c, tenantId);
  if (accessError) return accessError;

  const permissionError = await requireEvidenceExportPermission(c);
  if (permissionError) return permissionError;

  const body = await c.req.json().catch(() => null);
  const parsed = EvidenceExportCreateSchema.safeParse(body);
  if (!parsed.success) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  const periodStartAt = readEpochMs(parsed.data.period_start_at);
  const periodEndAt = readEpochMs(parsed.data.period_end_at);
  if (periodStartAt === null || periodEndAt === null || periodEndAt <= periodStartAt) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  const now = Date.now();
  const retention =
    (await getDirectoryAuthRetentionPolicy(coreAdapter(c, tenantId), tenantId)) ??
    (await ensureDirectoryAuthRetentionPolicy(coreAdapter(c, tenantId), tenantId, adminActorId(c), now));
  const earliestAllowed = now - retention.authrim_audit_retention_days * 24 * 60 * 60 * 1000;
  if (periodStartAt < earliestAllowed || periodEndAt > now) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }

  if (!c.env.EXPORT_ARTIFACTS || !c.env.OBJECT_ENCRYPTION_ROOT_KEY) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR, {
      variables: {
        reason: 'Evidence export artifact storage is not configured',
      },
    });
  }

  const adapter = coreAdapter(c, tenantId);
  const exportId = createDirectoryAuthId('daex');
  const artifactKey = `directory-auth/evidence/${tenantId}/${exportId}.json`;
  const artifactContent = await buildDirectoryAuthEvidenceArtifact(adapter, {
    tenantId,
    exportId,
    requestedBy: adminActorId(c),
    periodStartAt,
    periodEndAt,
    downloadAfterDelete: Boolean(parsed.data.download_after_delete),
    generatedAt: now,
  });
  let materialized: Awaited<ReturnType<typeof materializeEncryptedObjectArtifact>> | null = null;
  let item: DirectoryAuthEvidenceExportRow;
  try {
    materialized = await materializeEncryptedObjectArtifact(adapter, c.env.EXPORT_ARTIFACTS, {
      tenantId,
      objectClass: 'directory_auth_evidence_export',
      representation: 'canonical_json',
      objectKeyBase: artifactKey,
      content: artifactContent,
      contentType: 'application/json',
      rootKeyHex: c.env.OBJECT_ENCRYPTION_ROOT_KEY,
      keyVersion: getObjectEncryptionKeyVersion(c.env),
    });

    item = await createDirectoryAuthEvidenceExportJob(adapter, {
      tenantId,
      requestedBy: adminActorId(c),
      periodStartAt,
      periodEndAt,
      id: exportId,
      artifactKey: materialized.primaryObjectKey,
      artifactSha256: await sha256Hex(artifactContent),
      objectCatalogId: materialized.catalogId,
      sizeEstimateBytes: parsed.data.size_estimate_bytes ?? utf8ByteLength(artifactContent),
      downloadAfterDelete: parsed.data.download_after_delete,
    });
  } catch {
    if (materialized) {
      await tombstoneObjectCatalogEntryForTenant(adapter, tenantId, materialized.catalogId).catch(
        () => undefined
      );
    }
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
  await auditDirectoryAuthAction(
    c,
    'directory_auth.evidence_export.created',
    'directory_auth_evidence_export',
    item.id,
    tenantId,
    { period_start_at: item.period_start_at, period_end_at: item.period_end_at }
  );
  return c.json({ tenantId, item: serializeEvidenceExport(item, tenantId) }, 201);
}

export async function downloadDirectoryAuthEvidenceExportHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const exportId = c.req.param('exportId')!;
  const accessError = await requireTenantAccess(c, tenantId);
  if (accessError) return accessError;

  const permissionError = await requireEvidenceExportPermission(c);
  if (permissionError) return permissionError;

  const adapter = coreAdapter(c, tenantId);
  const row = await getDirectoryAuthEvidenceExport(adapter, tenantId, exportId);
  if (!row || row.status !== 'ready' || !row.object_catalog_id) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
      variables: { resource: 'directory_auth_evidence_export', id: exportId },
    });
  }
  if (!c.env.EXPORT_ARTIFACTS || !c.env.OBJECT_ENCRYPTION_ROOT_KEY) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
      variables: { resource: 'directory_auth_evidence_export', id: exportId },
    });
  }

  const loaded = await loadCatalogObjectRepresentation(adapter, c.env, {
    tenantId,
    objectCatalogId: row.object_catalog_id,
    representation: 'canonical_json',
    expectedClass: 'directory_auth_evidence_export',
    expectedBucketBinding: 'EXPORT_ARTIFACTS',
    allowPlaintextFallback: false,
  });
  if (!loaded) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
      variables: { resource: 'directory_auth_evidence_export', id: exportId },
    });
  }

  await auditDirectoryAuthAction(
    c,
    'directory_auth.evidence_export.downloaded',
    'directory_auth_evidence_export',
    row.id,
    tenantId,
    { artifact_sha256: row.artifact_sha256 }
  );

  if (row.download_after_delete === 1) {
    const now = Date.now();
    await tombstoneObjectCatalogEntryForTenant(adapter, tenantId, row.object_catalog_id, now);
    await markDirectoryAuthEvidenceExportDeleted(adapter, tenantId, row.id, now);
    await auditDirectoryAuthAction(
      c,
      'directory_auth.evidence_export.deleted_after_download',
      'directory_auth_evidence_export',
      row.id,
      tenantId,
      { artifact_sha256: row.artifact_sha256 }
    );
  }

  const headers = new Headers();
  headers.set('Content-Type', loaded.contentType || 'application/json');
  headers.set(
    'Content-Disposition',
    `attachment; filename="directory-auth-evidence-${row.id}.json"`
  );
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cache-Control', 'no-store');
  return new Response(loaded.content, { status: 200, headers });
}

export async function listDirectoryAuthSupportBundlesHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const accessError = await requireTenantAccess(c, tenantId);
  if (accessError) return accessError;

  const items = await listDirectoryAuthSupportBundles(coreAdapter(c, tenantId), tenantId, readLimit(c));
  return c.json({ tenantId, items: items.map((row) => serializeSupportBundle(row, tenantId)) });
}

export async function createDirectoryAuthSupportBundleHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const accessError = await requireTenantAccess(c, tenantId);
  if (accessError) return accessError;

  const permissionError = await requireDirectoryAuthWritePermission(c);
  if (permissionError) return permissionError;

  const body = await c.req.json().catch(() => null);
  const parsed = SupportBundleCreateSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  const redactionLevel = parsed.data.redaction_level as DirectoryAuthSupportBundleRedactionLevel;
  if (
    redactionLevel === 'detailed' &&
    parsed.data.consent_summary.detailed_warning_acknowledged !== true
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  if (!c.env.EXPORT_ARTIFACTS || !c.env.OBJECT_ENCRYPTION_ROOT_KEY) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR, {
      variables: {
        reason: 'Support bundle artifact storage is not configured',
      },
    });
  }

  const adapter = coreAdapter(c, tenantId);
  const now = Date.now();
  const bundleId = createDirectoryAuthId('dasb');
  const artifactKey = `directory-auth/support-bundles/${tenantId}/${bundleId}.json`;
  const artifactContent = await buildDirectoryAuthSupportBundleArtifact(adapter, {
    tenantId,
    bundleId,
    requestedBy: adminActorId(c),
    redactionLevel,
    scope: parsed.data.scope,
    consentSummary: parsed.data.consent_summary,
    generatedAt: now,
  });

  let materialized: Awaited<ReturnType<typeof materializeEncryptedObjectArtifact>> | null = null;
  let item: DirectoryAuthSupportBundleRow;
  try {
    materialized = await materializeEncryptedObjectArtifact(adapter, c.env.EXPORT_ARTIFACTS, {
      tenantId,
      objectClass: 'directory_auth_support_bundle',
      representation: 'canonical_json',
      objectKeyBase: artifactKey,
      content: artifactContent,
      contentType: 'application/json',
      rootKeyHex: c.env.OBJECT_ENCRYPTION_ROOT_KEY,
      keyVersion: getObjectEncryptionKeyVersion(c.env),
    });

    item = await createDirectoryAuthSupportBundleRequest(adapter, {
      tenantId,
      requestedBy: adminActorId(c),
      redactionLevel,
      id: bundleId,
      artifactKey: materialized.primaryObjectKey,
      artifactSha256: await sha256Hex(artifactContent),
      objectCatalogId: materialized.catalogId,
      scope: parsed.data.scope,
      consentSummary: parsed.data.consent_summary,
      now,
    });
  } catch {
    if (materialized) {
      await tombstoneObjectCatalogEntryForTenant(adapter, tenantId, materialized.catalogId).catch(
        () => undefined
      );
    }
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
  await auditDirectoryAuthAction(
    c,
    'directory_auth.support_bundle.created',
    'directory_auth_support_bundle',
    item.id,
    tenantId,
    { redaction_level: item.redaction_level }
  );
  return c.json({ tenantId, item: serializeSupportBundle(item, tenantId) }, 201);
}

export async function downloadDirectoryAuthSupportBundleHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const bundleId = c.req.param('bundleId')!;
  const accessError = await requireTenantAccess(c, tenantId);
  if (accessError) return accessError;

  const permissionError = await requireDirectoryAuthWritePermission(c);
  if (permissionError) return permissionError;

  const adapter = coreAdapter(c, tenantId);
  const row = await getDirectoryAuthSupportBundle(adapter, tenantId, bundleId);
  if (!row || row.status !== 'ready' || !row.object_catalog_id) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
      variables: { resource: 'directory_auth_support_bundle', id: bundleId },
    });
  }
  if (!c.env.EXPORT_ARTIFACTS || !c.env.OBJECT_ENCRYPTION_ROOT_KEY) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
      variables: { resource: 'directory_auth_support_bundle', id: bundleId },
    });
  }

  const loaded = await loadCatalogObjectRepresentation(adapter, c.env, {
    tenantId,
    objectCatalogId: row.object_catalog_id,
    representation: 'canonical_json',
    expectedClass: 'directory_auth_support_bundle',
    expectedBucketBinding: 'EXPORT_ARTIFACTS',
    allowPlaintextFallback: false,
  });
  if (!loaded) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
      variables: { resource: 'directory_auth_support_bundle', id: bundleId },
    });
  }

  await auditDirectoryAuthAction(
    c,
    'directory_auth.support_bundle.downloaded',
    'directory_auth_support_bundle',
    row.id,
    tenantId,
    { redaction_level: row.redaction_level, artifact_sha256: row.artifact_sha256 }
  );

  const headers = new Headers();
  headers.set('Content-Type', loaded.contentType || 'application/json');
  headers.set('Content-Disposition', `attachment; filename="directory-auth-support-${row.id}.json"`);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cache-Control', 'no-store');
  return new Response(loaded.content, { status: 200, headers });
}

export async function listDirectoryAuthAdvisoriesHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const accessError = await requireTenantAccess(c, tenantId);
  if (accessError) return accessError;

  const channel = c.req.query('channel') || 'stable';
  const items = await listDirectoryAuthReleaseAdvisories(coreAdapter(c, tenantId), channel, readLimit(c));
  return c.json({ tenantId, channel, items });
}

export async function runDirectoryAuthMaintenanceCleanupHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const accessError = await requireTenantAccess(c, tenantId);
  if (accessError) return accessError;

  const roleError = await requireTenantAdminRole(
    c,
    'Directory Authentication maintenance cleanup requires tenant admin authority'
  );
  if (roleError) return roleError;

  const body = await c.req.json().catch(() => null);
  const parsed = MaintenanceCleanupSchema.safeParse(body);
  if (!parsed.success) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }

  const adapter = coreAdapter(c, tenantId);
  const now = Date.now();
  const retention =
    (await getDirectoryAuthRetentionPolicy(adapter, tenantId)) ??
    (await ensureDirectoryAuthRetentionPolicy(adapter, tenantId, adminActorId(c), now));
  const result = await cleanupExpiredDirectoryAuthMaintenance(adapter, tenantId, now);
  const hardDeleteCandidates = await listDirectoryAuthEvidenceExportsReadyForHardDelete(
    adapter,
    tenantId,
    {
      now,
      graceHours: retention.artifact_delete_grace_hours,
      limit: DIRECTORY_AUTH_EVIDENCE_HARD_DELETE_LIMIT,
    }
  );
  const supportHardDeleteCandidates = await listDirectoryAuthSupportBundlesReadyForHardDelete(
    adapter,
    tenantId,
    {
      now,
      graceHours: retention.artifact_delete_grace_hours,
      limit: DIRECTORY_AUTH_EVIDENCE_HARD_DELETE_LIMIT,
    }
  );
  let evidenceExportsDeleted = 0;
  for (const candidate of hardDeleteCandidates) {
    if (!candidate.object_catalog_id) continue;
    await tombstoneObjectCatalogEntryForTenant(adapter, tenantId, candidate.object_catalog_id, now);
    if (await markDirectoryAuthEvidenceExportDeleted(adapter, tenantId, candidate.id, now)) {
      evidenceExportsDeleted += 1;
    }
  }
  let supportBundlesDeleted = 0;
  for (const candidate of supportHardDeleteCandidates) {
    if (!candidate.object_catalog_id) continue;
    await tombstoneObjectCatalogEntryForTenant(adapter, tenantId, candidate.object_catalog_id, now);
    if (await markDirectoryAuthSupportBundleDeleted(adapter, tenantId, candidate.id, now)) {
      supportBundlesDeleted += 1;
    }
  }
  result.evidence_exports_deleted = evidenceExportsDeleted;
  result.support_bundles_deleted = supportBundlesDeleted;
  await auditDirectoryAuthAction(
    c,
    'directory_auth.maintenance.cleanup',
    'directory_auth_maintenance',
    tenantId,
    tenantId,
    {
      reason: parsed.data.reason ?? null,
      ...result,
    }
  );
  return c.json({ tenantId, result });
}

export async function listDirectoryAuthManagedConnectorsHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const accessError = await requireTenantAccess(c, tenantId);
  if (accessError) return accessError;

  const adapter = coreAdapter(c, tenantId);
  const connectorId = c.req.query('connector_id') || undefined;
  const policies = await readDirectoryConnectorFleetPolicies(c.env, tenantId);
  let instances = await listDirectoryConnectorInstances(adapter, tenantId, connectorId);
  const now = Date.now();
  const refreshed = await refreshDirectoryConnectorDerivedStatuses(
    adapter,
    instances,
    (instance: DirectoryConnectorInstanceRow) => policies.get(instance.connector_id) ?? null,
    now
  );
  if (refreshed > 0) {
    instances = await listDirectoryConnectorInstances(adapter, tenantId, connectorId);
  }
  const [episodes, advisories] = await Promise.all([
    listDirectoryConnectorEpisodes(adapter, tenantId, connectorId, {
      limit: readLimit(c),
      retentionDays: 7,
    }),
    listDirectoryAuthReleaseAdvisories(adapter, 'stable', 50),
  ]);
  const items = instances.map((instance) => {
    const policy = policies.get(instance.connector_id);
    const resolvedInstance = policy ? applyDirectoryConnectorFleetPolicy(instance, policy, now) : instance;
    const advisoryMatches = matchDirectoryAuthReleaseAdvisories(instance.version, advisories);
    return {
      ...resolvedInstance,
      advisory_matches: advisoryMatches
        .filter((match) => match.affected)
        .map((match) => ({
          id: match.advisory.id,
          severity: match.advisory.severity,
          fixed_version: match.advisory.fixed_version,
          summary: match.advisory.summary,
          release_url: match.advisory.release_url,
        })),
      affected_advisory_count: advisoryMatches.filter((match) => match.affected).length,
    };
  });
  return c.json({ tenantId, items, recent_episodes: episodes });
}
