import type { DatabaseAdapter } from '../db/adapter';

export type DirectoryAuthMigrationCampaignStatus =
  | 'disabled'
  | 'draft'
  | 'active'
  | 'paused'
  | 'archived';

export type DirectoryAuthMigrationPolicyMode =
  | 'directory_login_allowed'
  | 'prompt_passkey'
  | 'grace_then_require_passkey'
  | 'require_passkey_after_directory'
  | 'disabled';

export type DirectoryAuthPasskeyPromptMode = 'none' | 'optional' | 'campaign_only';

export type DirectoryAuthEmailCodeFallbackMode =
  | 'migration_recovery'
  | 'directory_unavailable_recovery'
  | 'admin_invitation_only'
  | 'login_method'
  | 'disabled';

export type DirectoryAuthCampaignEmailCodeFallbackMode =
  | DirectoryAuthEmailCodeFallbackMode
  | 'tenant_default';

export type DirectoryAuthMigrationUserState =
  | 'not_applicable'
  | 'eligible'
  | 'prompted'
  | 'deferred'
  | 'passkey_required'
  | 'enrolled'
  | 'blocked'
  | 'recovered';

export type DirectoryAuthMigrationTransactionScope =
  | 'passkey_enrollment'
  | 'email_code_fallback'
  | 'recovery'
  | 'status_display';

export type DirectoryAuthMigrationTransactionState = 'active' | 'completed' | 'expired' | 'blocked';

export type DirectoryAuthJobStatus =
  | 'pending'
  | 'running'
  | 'ready'
  | 'failed'
  | 'deleted'
  | 'expired';

export type DirectoryAuthSupportBundleRedactionLevel = 'minimal' | 'standard' | 'detailed';

export type DirectoryAuthReleaseSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface DirectoryAuthMigrationCampaignRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  status: DirectoryAuthMigrationCampaignStatus;
  mode: DirectoryAuthMigrationPolicyMode;
  passkey_prompt_mode: DirectoryAuthPasskeyPromptMode;
  email_code_fallback_mode: DirectoryAuthCampaignEmailCodeFallbackMode;
  grace_period_days: number;
  transaction_ttl_seconds: number;
  enforcement_start_mode: 'first_directory_login';
  target_policy_json: string;
  is_template: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface DirectoryAuthMigrationUserStateRow {
  id: string;
  tenant_id: string;
  campaign_id: string;
  user_id: string | null;
  connector_id: string | null;
  directory_subject: string | null;
  cohort_key?: string | null;
  state: DirectoryAuthMigrationUserState;
  first_directory_login_at: number | null;
  prompted_at: number | null;
  deferred_until: number | null;
  passkey_required_at: number | null;
  enrolled_at: number | null;
  blocked_reason: string | null;
  recovery_reason: string | null;
  reset_count: number;
  last_reset_at: number | null;
  last_reset_by: string | null;
  last_reset_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface DirectoryAuthMigrationTransactionRow {
  id: string;
  tenant_id: string;
  campaign_id: string | null;
  user_id: string | null;
  connector_id: string | null;
  directory_subject: string | null;
  token_hash: string;
  scope: DirectoryAuthMigrationTransactionScope;
  state: DirectoryAuthMigrationTransactionState;
  request_id: string | null;
  authorization_challenge_id: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
  completed_at: number | null;
  blocked_reason: string | null;
}

export interface DirectoryAuthEvidenceExportRow {
  id: string;
  tenant_id: string;
  status: DirectoryAuthJobStatus;
  requested_by: string;
  period_start_at: number;
  period_end_at: number;
  size_estimate_bytes: number | null;
  artifact_key: string | null;
  artifact_sha256: string | null;
  object_catalog_id: string | null;
  manifest_signature_key_id: string | null;
  manifest_signature_alg: string | null;
  signed_url_expires_at: number | null;
  retention_expires_at: number;
  download_after_delete: number;
  error_code: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  deleted_at: number | null;
}

export interface DirectoryAuthRetentionPolicyRow {
  tenant_id: string;
  authrim_audit_retention_days: number;
  wordwarden_local_retention_days: number | null;
  artifact_delete_grace_hours: number;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface DirectoryAuthTenantPolicyRow {
  tenant_id: string;
  email_code_fallback_mode: DirectoryAuthEmailCodeFallbackMode;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface DirectoryAuthConfigHistoryRow {
  id: string;
  tenant_id: string;
  actor_id: string | null;
  category: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  before_redacted_json: string;
  after_redacted_json: string;
  created_at: number;
}

export interface DirectoryAuthReleaseAdvisoryRow {
  id: string;
  channel: string;
  severity: DirectoryAuthReleaseSeverity;
  affected_versions_json: string;
  fixed_version: string | null;
  summary: string;
  published_at: number;
  updated_at: number;
  release_url: string | null;
  created_at: number;
}

export interface DirectoryAuthAdvisoryMatch {
  advisory: DirectoryAuthReleaseAdvisoryRow;
  affected: boolean;
  reason: string;
}

export interface DirectoryAuthSupportBundleRow {
  id: string;
  tenant_id: string;
  requested_by: string;
  redaction_level: DirectoryAuthSupportBundleRedactionLevel;
  status: DirectoryAuthJobStatus;
  scope_json: string;
  consent_summary_json: string;
  artifact_key: string | null;
  artifact_sha256: string | null;
  object_catalog_id: string | null;
  retention_expires_at: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  deleted_at: number | null;
}

export interface DirectoryAuthCreateCampaignInput {
  tenantId: string;
  name: string;
  description?: string | null;
  status?: DirectoryAuthMigrationCampaignStatus;
  mode?: DirectoryAuthMigrationPolicyMode;
  passkeyPromptMode?: DirectoryAuthPasskeyPromptMode;
  emailCodeFallbackMode?: DirectoryAuthCampaignEmailCodeFallbackMode;
  gracePeriodDays?: number;
  transactionTtlSeconds?: number;
  targetPolicy?: unknown;
  isTemplate?: boolean;
  actorId?: string | null;
  now?: number;
}

export interface DirectoryAuthUpdateCampaignInput extends Omit<
  DirectoryAuthCreateCampaignInput,
  'tenantId' | 'name' | 'isTemplate'
> {
  tenantId: string;
  campaignId: string;
  name?: string;
}

export interface DirectoryAuthCreateTransactionInput {
  tenantId: string;
  tokenHash: string;
  scope: DirectoryAuthMigrationTransactionScope;
  ttlSeconds: number;
  campaignId?: string | null;
  userId?: string | null;
  connectorId?: string | null;
  directorySubject?: string | null;
  requestId?: string | null;
  authorizationChallengeId?: string | null;
  now?: number;
}

export interface DirectoryAuthGetActiveTransactionInput {
  tenantId: string;
  transactionId: string;
  tokenHash: string;
  scope: DirectoryAuthMigrationTransactionScope;
  now?: number;
}

export interface DirectoryAuthCompletePasskeyEnrollmentInput {
  tenantId: string;
  transactionId: string;
  campaignId: string | null;
  userId: string;
  requestId?: string | null;
  now?: number;
}

export interface DirectoryAuthCompleteEmailCodeFallbackInput {
  tenantId: string;
  transactionId: string;
  campaignId: string | null;
  userId: string;
  scope?: Extract<DirectoryAuthMigrationTransactionScope, 'email_code_fallback' | 'recovery'>;
  requestId?: string | null;
  now?: number;
}

export interface DirectoryAuthMarkUserEnrolledInput {
  tenantId: string;
  campaignId: string;
  userId: string;
  now?: number;
}

export interface DirectoryAuthAppendTransactionEventInput {
  tenantId: string;
  transactionId: string;
  eventType: string;
  eventPayload?: unknown;
  campaignId?: string | null;
  userId?: string | null;
  requestId?: string | null;
  now?: number;
}

export interface DirectoryAuthListUserStatesOptions {
  state?: DirectoryAuthMigrationUserState;
  campaignId?: string;
  userId?: string;
  limit?: number;
}

export interface DirectoryAuthListConfigHistoryOptions {
  category?: string;
  limit?: number;
}

export interface DirectoryAuthResetUserStateInput {
  tenantId: string;
  stateId: string;
  actorId: string;
  reason?: string | null;
  nextState?: DirectoryAuthMigrationUserState;
  now?: number;
}

export interface DirectoryAuthCreateEvidenceExportInput {
  tenantId: string;
  requestedBy: string;
  periodStartAt: number;
  periodEndAt: number;
  id?: string;
  artifactKey?: string;
  artifactSha256?: string;
  objectCatalogId?: string | null;
  sizeEstimateBytes?: number | null;
  downloadAfterDelete?: boolean;
  retentionDays?: number;
  now?: number;
}

export interface DirectoryAuthUpdateRetentionPolicyInput {
  tenantId: string;
  authrimAuditRetentionDays: number;
  wordwardenLocalRetentionDays: number | null;
  artifactDeleteGraceHours: number;
  actorId?: string | null;
  now?: number;
}

export interface DirectoryAuthUpdateTenantPolicyInput {
  tenantId: string;
  emailCodeFallbackMode: DirectoryAuthEmailCodeFallbackMode;
  actorId?: string | null;
  now?: number;
}

export interface DirectoryAuthCreateSupportBundleInput {
  tenantId: string;
  requestedBy: string;
  redactionLevel: DirectoryAuthSupportBundleRedactionLevel;
  id?: string;
  artifactKey?: string;
  artifactSha256?: string;
  objectCatalogId?: string | null;
  scope?: unknown;
  consentSummary?: unknown;
  retentionDays?: number;
  now?: number;
}

export interface DirectoryAuthMaintenanceCleanupResult {
  migration_transactions_expired: number;
  evidence_exports_expired: number;
  evidence_exports_deleted: number;
  support_bundles_expired: number;
  support_bundles_deleted: number;
}

export interface DirectoryAuthResolveMigrationInput {
  tenantId: string;
  userId: string;
  connectorId: string;
  directorySubject: string;
  directoryFacts?: DirectoryAuthTargetFacts;
  now?: number;
}

export interface DirectoryAuthTargetFacts {
  attributes?: Record<string, string | string[] | { value?: string | string[] }>;
  groups?: Array<
    string | { id?: string; name?: string; dn?: string; display?: string; display_name?: string }
  >;
  profileAttributes?: Record<string, string | string[]>;
}

export interface DirectoryAuthResolveEmailFallbackRecoveryCampaignInput {
  tenantId: string;
  userId: string;
  connectorId: string;
  mode: Extract<DirectoryAuthEmailCodeFallbackMode, 'directory_unavailable_recovery'>;
  now?: number;
}

export type DirectoryAuthMigrationDecision =
  | {
      action: 'none';
      campaign: null;
      userState: null;
    }
  | {
      action: 'prompt_passkey';
      campaign: DirectoryAuthMigrationCampaignRow;
      userState: DirectoryAuthMigrationUserStateRow;
      passkeyRequiredAt: number | null;
    }
  | {
      action: 'require_passkey';
      campaign: DirectoryAuthMigrationCampaignRow;
      userState: DirectoryAuthMigrationUserStateRow;
      passkeyRequiredAt: number;
      reason: 'immediate' | 'grace_period_elapsed';
    }
  | {
      action: 'blocked';
      campaign: DirectoryAuthMigrationCampaignRow;
      userState: DirectoryAuthMigrationUserStateRow;
      reason: string | null;
    };

export const DIRECTORY_AUTH_TEMPLATE_CAMPAIGN_NAME = 'Default passwordless migration template';
export const DEFAULT_DIRECTORY_AUTH_AUDIT_RETENTION_DAYS = 365;
export const DEFAULT_WORDWARDEN_LOCAL_RETENTION_DAYS = 14;
export const DEFAULT_EVIDENCE_EXPORT_RETENTION_DAYS = 7;
export const DEFAULT_ARTIFACT_DELETE_GRACE_HOURS = 72;
export const DEFAULT_SUPPORT_BUNDLE_RETENTION_DAYS = 7;
export const DEFAULT_DIRECTORY_AUTH_EMAIL_CODE_FALLBACK_MODE: DirectoryAuthEmailCodeFallbackMode =
  'migration_recovery';
export const MIN_MIGRATION_TRANSACTION_TTL_SECONDS = 5 * 60;
export const MAX_MIGRATION_TRANSACTION_TTL_SECONDS = 30 * 60;

const MAX_JSON_BYTES = 32 * 1024;
const MAX_LIST_LIMIT = 100;

export function createDirectoryAuthId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export async function ensureDirectoryAuthDefaults(
  adapter: DatabaseAdapter,
  tenantId: string,
  actorId?: string | null,
  now: number = Date.now()
): Promise<void> {
  await ensureDirectoryAuthTenantPolicy(adapter, tenantId, actorId ?? null, now);
  await ensureDirectoryAuthRetentionPolicy(adapter, tenantId, actorId ?? null, now);
  await ensureDirectoryAuthTemplateCampaign(adapter, tenantId, actorId ?? null, now);
}

export async function ensureDirectoryAuthTenantPolicy(
  adapter: DatabaseAdapter,
  tenantId: string,
  actorId?: string | null,
  now: number = Date.now()
): Promise<DirectoryAuthTenantPolicyRow> {
  const existing = await getDirectoryAuthTenantPolicy(adapter, tenantId);
  if (existing) return existing;

  const row: DirectoryAuthTenantPolicyRow = {
    tenant_id: tenantId,
    email_code_fallback_mode: DEFAULT_DIRECTORY_AUTH_EMAIL_CODE_FALLBACK_MODE,
    updated_by: actorId ?? null,
    created_at: now,
    updated_at: now,
  };
  await adapter.execute(
    `INSERT INTO directory_auth_tenant_policies (
       tenant_id, email_code_fallback_mode, updated_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id) DO NOTHING`,
    [row.tenant_id, row.email_code_fallback_mode, row.updated_by, row.created_at, row.updated_at]
  );
  return (await getDirectoryAuthTenantPolicy(adapter, tenantId)) ?? row;
}

export async function ensureDirectoryAuthRetentionPolicy(
  adapter: DatabaseAdapter,
  tenantId: string,
  actorId?: string | null,
  now: number = Date.now()
): Promise<DirectoryAuthRetentionPolicyRow> {
  const existing = await getDirectoryAuthRetentionPolicy(adapter, tenantId);
  if (existing) return existing;

  const row: DirectoryAuthRetentionPolicyRow = {
    tenant_id: tenantId,
    authrim_audit_retention_days: DEFAULT_DIRECTORY_AUTH_AUDIT_RETENTION_DAYS,
    wordwarden_local_retention_days: DEFAULT_WORDWARDEN_LOCAL_RETENTION_DAYS,
    artifact_delete_grace_hours: DEFAULT_ARTIFACT_DELETE_GRACE_HOURS,
    updated_by: actorId ?? null,
    created_at: now,
    updated_at: now,
  };
  await adapter.execute(
    `INSERT INTO directory_auth_retention_policies (
       tenant_id, authrim_audit_retention_days, wordwarden_local_retention_days,
       artifact_delete_grace_hours, updated_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id) DO NOTHING`,
    [
      row.tenant_id,
      row.authrim_audit_retention_days,
      row.wordwarden_local_retention_days,
      row.artifact_delete_grace_hours,
      row.updated_by,
      row.created_at,
      row.updated_at,
    ]
  );
  return (await getDirectoryAuthRetentionPolicy(adapter, tenantId)) ?? row;
}

export async function ensureDirectoryAuthTemplateCampaign(
  adapter: DatabaseAdapter,
  tenantId: string,
  actorId?: string | null,
  now: number = Date.now()
): Promise<DirectoryAuthMigrationCampaignRow> {
  const existing = await adapter.queryOne<DirectoryAuthMigrationCampaignRow>(
    `SELECT *
       FROM directory_auth_migration_campaigns
      WHERE tenant_id = ? AND is_template = 1
      ORDER BY created_at ASC
      LIMIT 1`,
    [tenantId]
  );
  if (existing) return existing;

  try {
    return await createDirectoryAuthMigrationCampaign(adapter, {
      tenantId,
      name: DIRECTORY_AUTH_TEMPLATE_CAMPAIGN_NAME,
      description: 'Disabled template for an explicit passwordless migration campaign.',
      status: 'disabled',
      mode: 'grace_then_require_passkey',
      passkeyPromptMode: 'campaign_only',
      emailCodeFallbackMode: 'tenant_default',
      gracePeriodDays: 30,
      transactionTtlSeconds: 600,
      targetPolicy: { type: 'template', assignments: [] },
      isTemplate: true,
      actorId,
      now,
    });
  } catch (error) {
    const afterRace = await adapter.queryOne<DirectoryAuthMigrationCampaignRow>(
      `SELECT *
         FROM directory_auth_migration_campaigns
        WHERE tenant_id = ? AND is_template = 1
        ORDER BY created_at ASC
        LIMIT 1`,
      [tenantId]
    );
    if (afterRace) return afterRace;
    throw error;
  }
}

export async function listDirectoryAuthMigrationCampaigns(
  adapter: DatabaseAdapter,
  tenantId: string
): Promise<DirectoryAuthMigrationCampaignRow[]> {
  return adapter.query<DirectoryAuthMigrationCampaignRow>(
    `SELECT *
       FROM directory_auth_migration_campaigns
      WHERE tenant_id = ?
      ORDER BY is_template DESC, updated_at DESC`,
    [tenantId]
  );
}

export async function resolveDirectoryAuthMigrationDecision(
  adapter: DatabaseAdapter,
  input: DirectoryAuthResolveMigrationInput
): Promise<DirectoryAuthMigrationDecision> {
  const now = input.now ?? Date.now();
  const campaigns = await adapter.query<DirectoryAuthMigrationCampaignRow>(
    `SELECT *
       FROM directory_auth_migration_campaigns
      WHERE tenant_id = ?
        AND status = 'active'
        AND is_template = 0
        AND mode IN ('prompt_passkey', 'grace_then_require_passkey', 'require_passkey_after_directory')
      ORDER BY updated_at DESC
      LIMIT 20`,
    [input.tenantId]
  );
  const campaignMatch =
    campaigns
      .map((candidate) => ({
        campaign: candidate,
        target: directoryAuthTargetPolicyMatch(candidate.target_policy_json, input),
      }))
      .find((candidate) => candidate.target.matches) ?? null;
  const campaign = campaignMatch?.campaign ?? null;
  if (!campaign) {
    return { action: 'none', campaign: null, userState: null };
  }

  const userState = await upsertDirectoryAuthMigrationUserState(adapter, {
    tenantId: input.tenantId,
    campaign,
    userId: input.userId,
    connectorId: input.connectorId,
    directorySubject: input.directorySubject,
    cohortKey: campaignMatch?.target.cohortKey,
    now,
  });

  if (userState.state === 'blocked') {
    return {
      action: 'blocked',
      campaign,
      userState,
      reason: userState.blocked_reason,
    };
  }

  if (campaign.mode === 'require_passkey_after_directory') {
    const passkeyRequiredAt = userState.passkey_required_at ?? now;
    const nextState = await markDirectoryAuthMigrationUserState(adapter, userState, {
      state: 'passkey_required',
      passkeyRequiredAt,
      now,
    });
    return {
      action: 'require_passkey',
      campaign,
      userState: nextState,
      passkeyRequiredAt,
      reason: 'immediate',
    };
  }

  if (campaign.mode === 'grace_then_require_passkey') {
    const firstLoginAt = userState.first_directory_login_at ?? now;
    const passkeyRequiredAt = firstLoginAt + campaign.grace_period_days * 24 * 60 * 60 * 1000;
    if (now >= passkeyRequiredAt) {
      const nextState = await markDirectoryAuthMigrationUserState(adapter, userState, {
        state: 'passkey_required',
        passkeyRequiredAt,
        now,
      });
      return {
        action: 'require_passkey',
        campaign,
        userState: nextState,
        passkeyRequiredAt,
        reason: 'grace_period_elapsed',
      };
    }
    const nextState = await markDirectoryAuthMigrationUserState(adapter, userState, {
      state: userState.state === 'eligible' ? 'prompted' : userState.state,
      promptedAt: userState.prompted_at ?? now,
      passkeyRequiredAt,
      now,
    });
    return {
      action: 'prompt_passkey',
      campaign,
      userState: nextState,
      passkeyRequiredAt,
    };
  }

  const nextState = await markDirectoryAuthMigrationUserState(adapter, userState, {
    state: userState.state === 'eligible' ? 'prompted' : userState.state,
    promptedAt: userState.prompted_at ?? now,
    now,
  });
  return {
    action: 'prompt_passkey',
    campaign,
    userState: nextState,
    passkeyRequiredAt: null,
  };
}

export async function resolveDirectoryAuthEmailFallbackRecoveryCampaign(
  adapter: DatabaseAdapter,
  input: DirectoryAuthResolveEmailFallbackRecoveryCampaignInput
): Promise<DirectoryAuthMigrationCampaignRow | null> {
  const tenantPolicy = await ensureDirectoryAuthTenantPolicy(
    adapter,
    input.tenantId,
    null,
    input.now
  );
  const campaigns = await adapter.query<DirectoryAuthMigrationCampaignRow>(
    `SELECT *
       FROM directory_auth_migration_campaigns
      WHERE tenant_id = ?
        AND status = 'active'
        AND is_template = 0
        AND email_code_fallback_mode IN (?, 'tenant_default')
      ORDER BY updated_at DESC
      LIMIT 20`,
    [input.tenantId, input.mode]
  );
  return (
    campaigns.find((candidate) => {
      const effectiveMode = resolveDirectoryAuthEffectiveEmailCodeFallbackModeSync(
        candidate,
        tenantPolicy
      );
      if (effectiveMode !== input.mode) return false;
      return directoryAuthTargetPolicyMatch(candidate.target_policy_json, {
        tenantId: input.tenantId,
        userId: input.userId,
        connectorId: input.connectorId,
        directorySubject: '',
        now: input.now,
      }).matches;
    }) ?? null
  );
}

export async function resolveDirectoryAuthEffectiveEmailCodeFallbackMode(
  adapter: DatabaseAdapter,
  tenantId: string,
  campaign: DirectoryAuthMigrationCampaignRow,
  now: number = Date.now()
): Promise<DirectoryAuthEmailCodeFallbackMode> {
  if (campaign.email_code_fallback_mode !== 'tenant_default') {
    return campaign.email_code_fallback_mode;
  }
  const policy = await ensureDirectoryAuthTenantPolicy(adapter, tenantId, null, now);
  return policy.email_code_fallback_mode;
}

export async function createDirectoryAuthMigrationCampaign(
  adapter: DatabaseAdapter,
  input: DirectoryAuthCreateCampaignInput
): Promise<DirectoryAuthMigrationCampaignRow> {
  const now = input.now ?? Date.now();
  const row: DirectoryAuthMigrationCampaignRow = {
    id: createDirectoryAuthId('damc'),
    tenant_id: input.tenantId,
    name: input.name.trim(),
    description: normalizeOptionalString(input.description),
    status: input.status ?? 'disabled',
    mode: input.mode ?? 'directory_login_allowed',
    passkey_prompt_mode: input.passkeyPromptMode ?? 'campaign_only',
    email_code_fallback_mode: input.emailCodeFallbackMode ?? 'tenant_default',
    grace_period_days: input.gracePeriodDays ?? 30,
    transaction_ttl_seconds: clampTransactionTtl(input.transactionTtlSeconds ?? 600),
    enforcement_start_mode: 'first_directory_login',
    target_policy_json: boundedJson(input.targetPolicy ?? {}),
    is_template: input.isTemplate ? 1 : 0,
    created_by: input.actorId ?? null,
    created_at: now,
    updated_at: now,
  };
  await adapter.execute(
    `INSERT INTO directory_auth_migration_campaigns (
       id, tenant_id, name, description, status, mode, passkey_prompt_mode,
       email_code_fallback_mode, grace_period_days, transaction_ttl_seconds,
       enforcement_start_mode, target_policy_json, is_template, created_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.tenant_id,
      row.name,
      row.description,
      row.status,
      row.mode,
      row.passkey_prompt_mode,
      row.email_code_fallback_mode,
      row.grace_period_days,
      row.transaction_ttl_seconds,
      row.enforcement_start_mode,
      row.target_policy_json,
      row.is_template,
      row.created_by,
      row.created_at,
      row.updated_at,
    ]
  );
  await recordDirectoryAuthConfigHistory(adapter, {
    tenantId: input.tenantId,
    actorId: input.actorId,
    category: 'migration',
    action: 'migration_campaign.created',
    resourceType: 'directory_auth_migration_campaign',
    resourceId: row.id,
    before: {},
    after: campaignHistorySnapshot(row),
    now,
  });
  return row;
}

export async function updateDirectoryAuthMigrationCampaign(
  adapter: DatabaseAdapter,
  input: DirectoryAuthUpdateCampaignInput
): Promise<DirectoryAuthMigrationCampaignRow | null> {
  const existing = await adapter.queryOne<DirectoryAuthMigrationCampaignRow>(
    `SELECT *
       FROM directory_auth_migration_campaigns
      WHERE tenant_id = ? AND id = ?`,
    [input.tenantId, input.campaignId]
  );
  if (!existing) return null;

  const now = input.now ?? Date.now();
  const next: DirectoryAuthMigrationCampaignRow = {
    ...existing,
    name: input.name?.trim() || existing.name,
    description:
      input.description === undefined
        ? existing.description
        : normalizeOptionalString(input.description),
    status: input.status ?? existing.status,
    mode: input.mode ?? existing.mode,
    passkey_prompt_mode: input.passkeyPromptMode ?? existing.passkey_prompt_mode,
    email_code_fallback_mode: input.emailCodeFallbackMode ?? existing.email_code_fallback_mode,
    grace_period_days: input.gracePeriodDays ?? existing.grace_period_days,
    transaction_ttl_seconds: clampTransactionTtl(
      input.transactionTtlSeconds ?? existing.transaction_ttl_seconds
    ),
    target_policy_json:
      input.targetPolicy === undefined
        ? existing.target_policy_json
        : boundedJson(input.targetPolicy),
    updated_at: now,
  };

  await adapter.execute(
    `UPDATE directory_auth_migration_campaigns
        SET name = ?,
            description = ?,
            status = ?,
            mode = ?,
            passkey_prompt_mode = ?,
            email_code_fallback_mode = ?,
            grace_period_days = ?,
            transaction_ttl_seconds = ?,
            target_policy_json = ?,
            updated_at = ?
      WHERE tenant_id = ? AND id = ?`,
    [
      next.name,
      next.description,
      next.status,
      next.mode,
      next.passkey_prompt_mode,
      next.email_code_fallback_mode,
      next.grace_period_days,
      next.transaction_ttl_seconds,
      next.target_policy_json,
      next.updated_at,
      input.tenantId,
      input.campaignId,
    ]
  );
  await recordDirectoryAuthConfigHistory(adapter, {
    tenantId: input.tenantId,
    actorId: input.actorId,
    category: 'migration',
    action: 'migration_campaign.updated',
    resourceType: 'directory_auth_migration_campaign',
    resourceId: input.campaignId,
    before: campaignHistorySnapshot(existing),
    after: campaignHistorySnapshot(next),
    now,
  });
  return next;
}

export async function listDirectoryAuthMigrationUserStates(
  adapter: DatabaseAdapter,
  tenantId: string,
  options: DirectoryAuthListUserStatesOptions = {}
): Promise<DirectoryAuthMigrationUserStateRow[]> {
  const limit = clampListLimit(options.limit);
  const conditions = ['tenant_id = ?'];
  const params: unknown[] = [tenantId];
  if (options.state) {
    conditions.push('state = ?');
    params.push(options.state);
  }
  if (options.campaignId) {
    conditions.push('campaign_id = ?');
    params.push(options.campaignId);
  }
  if (options.userId) {
    conditions.push('user_id = ?');
    params.push(options.userId);
  }
  params.push(limit);

  return adapter.query<DirectoryAuthMigrationUserStateRow>(
    `SELECT *
       FROM directory_auth_migration_user_states
      WHERE ${conditions.join(' AND ')}
      ORDER BY updated_at DESC
      LIMIT ?`,
    params
  );
}

export async function listDirectoryAuthConfigHistory(
  adapter: DatabaseAdapter,
  tenantId: string,
  options: DirectoryAuthListConfigHistoryOptions = {}
): Promise<DirectoryAuthConfigHistoryRow[]> {
  const limit = clampListLimit(options.limit);
  const conditions = ['tenant_id = ?'];
  const params: unknown[] = [tenantId];
  const category = normalizeOptionalString(options.category);
  if (category) {
    conditions.push('category = ?');
    params.push(category);
  }
  params.push(limit);

  return adapter.query<DirectoryAuthConfigHistoryRow>(
    `SELECT *
       FROM directory_auth_config_history
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT ?`,
    params
  );
}

export async function resetDirectoryAuthMigrationUserState(
  adapter: DatabaseAdapter,
  input: DirectoryAuthResetUserStateInput
): Promise<DirectoryAuthMigrationUserStateRow | null> {
  const existing = await adapter.queryOne<DirectoryAuthMigrationUserStateRow>(
    `SELECT *
       FROM directory_auth_migration_user_states
      WHERE tenant_id = ? AND id = ?`,
    [input.tenantId, input.stateId]
  );
  if (!existing) return null;

  const now = input.now ?? Date.now();
  const nextState = input.nextState ?? 'eligible';
  await adapter.execute(
    `UPDATE directory_auth_migration_user_states
        SET state = ?,
            blocked_reason = NULL,
            recovery_reason = NULL,
            deferred_until = NULL,
            reset_count = reset_count + 1,
            last_reset_at = ?,
            last_reset_by = ?,
            last_reset_reason = ?,
            updated_at = ?
      WHERE tenant_id = ? AND id = ?`,
    [
      nextState,
      now,
      input.actorId,
      normalizeOptionalString(input.reason),
      now,
      input.tenantId,
      input.stateId,
    ]
  );
  await recordDirectoryAuthConfigHistory(adapter, {
    tenantId: input.tenantId,
    actorId: input.actorId,
    category: 'migration',
    action: 'migration_state.reset',
    resourceType: 'directory_auth_migration_user_state',
    resourceId: input.stateId,
    before: {
      state: existing.state,
      blocked_reason: existing.blocked_reason,
      recovery_reason: existing.recovery_reason,
    },
    after: { state: nextState, reason: normalizeOptionalString(input.reason) },
    now,
  });
  return {
    ...existing,
    state: nextState,
    blocked_reason: null,
    recovery_reason: null,
    deferred_until: null,
    reset_count: existing.reset_count + 1,
    last_reset_at: now,
    last_reset_by: input.actorId,
    last_reset_reason: normalizeOptionalString(input.reason),
    updated_at: now,
  };
}

export async function createDirectoryAuthMigrationTransaction(
  adapter: DatabaseAdapter,
  input: DirectoryAuthCreateTransactionInput
): Promise<DirectoryAuthMigrationTransactionRow> {
  const now = input.now ?? Date.now();
  const ttlSeconds = clampTransactionTtl(input.ttlSeconds);
  const row: DirectoryAuthMigrationTransactionRow = {
    id: createDirectoryAuthId('damt'),
    tenant_id: input.tenantId,
    campaign_id: input.campaignId ?? null,
    user_id: input.userId ?? null,
    connector_id: input.connectorId ?? null,
    directory_subject: input.directorySubject ?? null,
    token_hash: input.tokenHash,
    scope: input.scope,
    state: 'active',
    request_id: input.requestId ?? null,
    authorization_challenge_id: input.authorizationChallengeId ?? null,
    created_at: now,
    updated_at: now,
    expires_at: now + ttlSeconds * 1000,
    completed_at: null,
    blocked_reason: null,
  };
  await adapter.execute(
    `INSERT INTO directory_auth_migration_transactions (
       id, tenant_id, campaign_id, user_id, connector_id, directory_subject,
       token_hash, scope, state, request_id, authorization_challenge_id,
       created_at, updated_at, expires_at, completed_at, blocked_reason
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.tenant_id,
      row.campaign_id,
      row.user_id,
      row.connector_id,
      row.directory_subject,
      row.token_hash,
      row.scope,
      row.state,
      row.request_id,
      row.authorization_challenge_id,
      row.created_at,
      row.updated_at,
      row.expires_at,
      row.completed_at,
      row.blocked_reason,
    ]
  );
  await appendDirectoryAuthMigrationTransactionEvent(adapter, {
    tenantId: input.tenantId,
    transactionId: row.id,
    campaignId: row.campaign_id,
    userId: row.user_id,
    eventType: 'created',
    requestId: row.request_id,
    eventPayload: { scope: row.scope, expires_at: row.expires_at },
    now,
  });
  return row;
}

export async function getActiveDirectoryAuthMigrationTransaction(
  adapter: DatabaseAdapter,
  input: DirectoryAuthGetActiveTransactionInput
): Promise<DirectoryAuthMigrationTransactionRow | null> {
  const now = input.now ?? Date.now();
  return adapter.queryOne<DirectoryAuthMigrationTransactionRow>(
    `SELECT *
       FROM directory_auth_migration_transactions
      WHERE tenant_id = ?
        AND id = ?
        AND token_hash = ?
        AND scope = ?
        AND state = 'active'
        AND expires_at > ?
      LIMIT 1`,
    [input.tenantId, input.transactionId, input.tokenHash, input.scope, now]
  );
}

export async function completeDirectoryAuthPasskeyEnrollment(
  adapter: DatabaseAdapter,
  input: DirectoryAuthCompletePasskeyEnrollmentInput
): Promise<boolean> {
  const now = input.now ?? Date.now();
  const result = await adapter.execute(
    `UPDATE directory_auth_migration_transactions
        SET state = 'completed',
            token_hash = 'completed:' || id,
            completed_at = ?,
            updated_at = ?
      WHERE tenant_id = ?
        AND id = ?
        AND state = 'active'
        AND expires_at > ?`,
    [now, now, input.tenantId, input.transactionId, now]
  );
  if (result.rowsAffected !== 1) {
    return false;
  }

  if (input.campaignId) {
    await adapter.execute(
      `UPDATE directory_auth_migration_user_states
          SET state = 'enrolled',
              enrolled_at = COALESCE(enrolled_at, ?),
              updated_at = ?
        WHERE tenant_id = ?
          AND campaign_id = ?
          AND user_id = ?`,
      [now, now, input.tenantId, input.campaignId, input.userId]
    );
  }

  await appendDirectoryAuthMigrationTransactionEvent(adapter, {
    tenantId: input.tenantId,
    transactionId: input.transactionId,
    campaignId: input.campaignId,
    userId: input.userId,
    eventType: 'passkey_enrollment.completed',
    requestId: input.requestId ?? null,
    eventPayload: { completed_at: now },
    now,
  });
  return true;
}

export async function completeDirectoryAuthEmailCodeFallback(
  adapter: DatabaseAdapter,
  input: DirectoryAuthCompleteEmailCodeFallbackInput
): Promise<boolean> {
  const now = input.now ?? Date.now();
  const scope = input.scope ?? 'email_code_fallback';
  const result = await adapter.execute(
    `UPDATE directory_auth_migration_transactions
        SET state = 'completed',
            token_hash = 'completed:' || id,
            completed_at = ?,
            updated_at = ?
      WHERE tenant_id = ?
        AND id = ?
        AND scope = ?
        AND state = 'active'
        AND expires_at > ?`,
    [now, now, input.tenantId, input.transactionId, scope, now]
  );
  if (result.rowsAffected !== 1) {
    return false;
  }

  if (input.campaignId) {
    await adapter.execute(
      `UPDATE directory_auth_migration_user_states
          SET state = 'recovered',
              recovery_reason = COALESCE(recovery_reason, 'email_code_fallback'),
              updated_at = ?
        WHERE tenant_id = ?
          AND campaign_id = ?
          AND user_id = ?`,
      [now, input.tenantId, input.campaignId, input.userId]
    );
  }

  await appendDirectoryAuthMigrationTransactionEvent(adapter, {
    tenantId: input.tenantId,
    transactionId: input.transactionId,
    campaignId: input.campaignId,
    userId: input.userId,
    eventType:
      scope === 'recovery'
        ? 'directory_unavailable_recovery.completed'
        : 'email_code_fallback.completed',
    requestId: input.requestId ?? null,
    eventPayload: { completed_at: now },
    now,
  });
  return true;
}

export async function markDirectoryAuthMigrationUserEnrolled(
  adapter: DatabaseAdapter,
  input: DirectoryAuthMarkUserEnrolledInput
): Promise<void> {
  const now = input.now ?? Date.now();
  await adapter.execute(
    `UPDATE directory_auth_migration_user_states
        SET state = 'enrolled',
            enrolled_at = COALESCE(enrolled_at, ?),
            updated_at = ?
      WHERE tenant_id = ?
        AND campaign_id = ?
        AND user_id = ?`,
    [now, now, input.tenantId, input.campaignId, input.userId]
  );
}

export async function appendDirectoryAuthMigrationTransactionEvent(
  adapter: DatabaseAdapter,
  input: DirectoryAuthAppendTransactionEventInput
): Promise<void> {
  await adapter.execute(
    `INSERT INTO directory_auth_migration_transaction_events (
       id, tenant_id, transaction_id, campaign_id, user_id, event_type,
       event_payload_json, request_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      createDirectoryAuthId('damte'),
      input.tenantId,
      input.transactionId,
      input.campaignId ?? null,
      input.userId ?? null,
      input.eventType,
      boundedJson(input.eventPayload ?? {}),
      input.requestId ?? null,
      input.now ?? Date.now(),
    ]
  );
}

export async function cleanupExpiredDirectoryAuthMigrationTransactions(
  adapter: DatabaseAdapter,
  tenantId: string,
  now: number = Date.now()
): Promise<number> {
  const result = await adapter.execute(
    `UPDATE directory_auth_migration_transactions
        SET state = 'expired',
            token_hash = 'expired:' || id,
            updated_at = ?
      WHERE tenant_id = ?
        AND state = 'active'
        AND expires_at <= ?`,
    [now, tenantId, now]
  );
  return result.rowsAffected;
}

export async function cleanupExpiredDirectoryAuthEvidenceExports(
  adapter: DatabaseAdapter,
  tenantId: string,
  now: number = Date.now()
): Promise<number> {
  const result = await adapter.execute(
    `UPDATE directory_auth_evidence_exports
        SET status = 'expired',
            signed_url_expires_at = NULL,
            updated_at = ?,
            deleted_at = ?
      WHERE tenant_id = ?
        AND retention_expires_at <= ?
        AND status NOT IN ('deleted', 'expired')`,
    [now, now, tenantId, now]
  );
  return result.rowsAffected;
}

export async function listDirectoryAuthEvidenceExportsReadyForHardDelete(
  adapter: DatabaseAdapter,
  tenantId: string,
  options?: {
    now?: number;
    graceHours?: number;
    limit?: number;
  }
): Promise<DirectoryAuthEvidenceExportRow[]> {
  const now = options?.now ?? Date.now();
  const graceHours = options?.graceHours ?? DEFAULT_ARTIFACT_DELETE_GRACE_HOURS;
  const cutoff = now - graceHours * 60 * 60 * 1000;
  return adapter.query<DirectoryAuthEvidenceExportRow>(
    `SELECT *
       FROM directory_auth_evidence_exports
      WHERE tenant_id = ?
        AND status = 'expired'
        AND deleted_at IS NOT NULL
        AND deleted_at <= ?
        AND object_catalog_id IS NOT NULL
      ORDER BY deleted_at ASC
      LIMIT ?`,
    [tenantId, cutoff, clampListLimit(options?.limit)]
  );
}

export async function markDirectoryAuthEvidenceExportDeleted(
  adapter: DatabaseAdapter,
  tenantId: string,
  exportId: string,
  now: number = Date.now()
): Promise<boolean> {
  const result = await adapter.execute(
    `UPDATE directory_auth_evidence_exports
        SET status = 'deleted',
            artifact_key = NULL,
            signed_url_expires_at = NULL,
            deleted_at = COALESCE(deleted_at, ?),
            updated_at = ?
      WHERE tenant_id = ?
        AND id = ?
        AND status IN ('expired', 'ready')`,
    [now, now, tenantId, exportId]
  );
  return result.rowsAffected > 0;
}

export async function cleanupExpiredDirectoryAuthSupportBundles(
  adapter: DatabaseAdapter,
  tenantId: string,
  now: number = Date.now()
): Promise<number> {
  const result = await adapter.execute(
    `UPDATE directory_auth_support_bundles
        SET status = 'expired',
            updated_at = ?,
            deleted_at = ?
      WHERE tenant_id = ?
        AND retention_expires_at <= ?
        AND status NOT IN ('deleted', 'expired')`,
    [now, now, tenantId, now]
  );
  return result.rowsAffected;
}

export async function listDirectoryAuthSupportBundlesReadyForHardDelete(
  adapter: DatabaseAdapter,
  tenantId: string,
  options?: {
    now?: number;
    graceHours?: number;
    limit?: number;
  }
): Promise<DirectoryAuthSupportBundleRow[]> {
  const now = options?.now ?? Date.now();
  const graceHours = options?.graceHours ?? DEFAULT_ARTIFACT_DELETE_GRACE_HOURS;
  const cutoff = now - graceHours * 60 * 60 * 1000;
  return adapter.query<DirectoryAuthSupportBundleRow>(
    `SELECT *
       FROM directory_auth_support_bundles
      WHERE tenant_id = ?
        AND status = 'expired'
        AND deleted_at IS NOT NULL
        AND deleted_at <= ?
        AND object_catalog_id IS NOT NULL
      ORDER BY deleted_at ASC
      LIMIT ?`,
    [tenantId, cutoff, clampListLimit(options?.limit)]
  );
}

export async function markDirectoryAuthSupportBundleDeleted(
  adapter: DatabaseAdapter,
  tenantId: string,
  bundleId: string,
  now: number = Date.now()
): Promise<boolean> {
  const result = await adapter.execute(
    `UPDATE directory_auth_support_bundles
        SET status = 'deleted',
            artifact_key = NULL,
            deleted_at = COALESCE(deleted_at, ?),
            updated_at = ?
      WHERE tenant_id = ?
        AND id = ?
        AND status IN ('expired', 'ready')`,
    [now, now, tenantId, bundleId]
  );
  return result.rowsAffected > 0;
}

export async function cleanupExpiredDirectoryAuthMaintenance(
  adapter: DatabaseAdapter,
  tenantId: string,
  now: number = Date.now()
): Promise<DirectoryAuthMaintenanceCleanupResult> {
  const [migrationTransactionsExpired, evidenceExportsExpired, supportBundlesExpired] =
    await Promise.all([
      cleanupExpiredDirectoryAuthMigrationTransactions(adapter, tenantId, now),
      cleanupExpiredDirectoryAuthEvidenceExports(adapter, tenantId, now),
      cleanupExpiredDirectoryAuthSupportBundles(adapter, tenantId, now),
    ]);

  return {
    migration_transactions_expired: migrationTransactionsExpired,
    evidence_exports_expired: evidenceExportsExpired,
    evidence_exports_deleted: 0,
    support_bundles_expired: supportBundlesExpired,
    support_bundles_deleted: 0,
  };
}

export async function getDirectoryAuthRetentionPolicy(
  adapter: DatabaseAdapter,
  tenantId: string
): Promise<DirectoryAuthRetentionPolicyRow | null> {
  return adapter.queryOne<DirectoryAuthRetentionPolicyRow>(
    `SELECT *
       FROM directory_auth_retention_policies
      WHERE tenant_id = ?`,
    [tenantId]
  );
}

export async function getDirectoryAuthTenantPolicy(
  adapter: DatabaseAdapter,
  tenantId: string
): Promise<DirectoryAuthTenantPolicyRow | null> {
  return adapter.queryOne<DirectoryAuthTenantPolicyRow>(
    `SELECT *
       FROM directory_auth_tenant_policies
      WHERE tenant_id = ?`,
    [tenantId]
  );
}

export async function updateDirectoryAuthTenantPolicy(
  adapter: DatabaseAdapter,
  input: DirectoryAuthUpdateTenantPolicyInput
): Promise<DirectoryAuthTenantPolicyRow> {
  const now = input.now ?? Date.now();
  const existing = await getDirectoryAuthTenantPolicy(adapter, input.tenantId);
  const row: DirectoryAuthTenantPolicyRow = {
    tenant_id: input.tenantId,
    email_code_fallback_mode: input.emailCodeFallbackMode,
    updated_by: input.actorId ?? null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  await adapter.execute(
    `INSERT INTO directory_auth_tenant_policies (
       tenant_id, email_code_fallback_mode, updated_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET
       email_code_fallback_mode = excluded.email_code_fallback_mode,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
    [row.tenant_id, row.email_code_fallback_mode, row.updated_by, row.created_at, row.updated_at]
  );
  await recordDirectoryAuthConfigHistory(adapter, {
    tenantId: input.tenantId,
    actorId: input.actorId,
    category: 'policy',
    action: 'tenant_policy.updated',
    resourceType: 'directory_auth_tenant_policy',
    resourceId: input.tenantId,
    before: existing ? tenantPolicyHistorySnapshot(existing) : {},
    after: tenantPolicyHistorySnapshot(row),
    now,
  });
  return row;
}

export async function updateDirectoryAuthRetentionPolicy(
  adapter: DatabaseAdapter,
  input: DirectoryAuthUpdateRetentionPolicyInput
): Promise<DirectoryAuthRetentionPolicyRow> {
  const now = input.now ?? Date.now();
  const existing = await getDirectoryAuthRetentionPolicy(adapter, input.tenantId);
  const row: DirectoryAuthRetentionPolicyRow = {
    tenant_id: input.tenantId,
    authrim_audit_retention_days: input.authrimAuditRetentionDays,
    wordwarden_local_retention_days: input.wordwardenLocalRetentionDays,
    artifact_delete_grace_hours: input.artifactDeleteGraceHours,
    updated_by: input.actorId ?? null,
    created_at: now,
    updated_at: now,
  };
  await adapter.execute(
    `INSERT INTO directory_auth_retention_policies (
       tenant_id, authrim_audit_retention_days, wordwarden_local_retention_days,
       artifact_delete_grace_hours, updated_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET
       authrim_audit_retention_days = excluded.authrim_audit_retention_days,
       wordwarden_local_retention_days = excluded.wordwarden_local_retention_days,
       artifact_delete_grace_hours = excluded.artifact_delete_grace_hours,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
    [
      row.tenant_id,
      row.authrim_audit_retention_days,
      row.wordwarden_local_retention_days,
      row.artifact_delete_grace_hours,
      row.updated_by,
      row.created_at,
      row.updated_at,
    ]
  );
  const next = {
    ...row,
    created_at: (await getDirectoryAuthRetentionPolicy(adapter, input.tenantId))?.created_at ?? now,
  };
  await recordDirectoryAuthConfigHistory(adapter, {
    tenantId: input.tenantId,
    actorId: input.actorId,
    category: 'retention',
    action: 'retention_policy.updated',
    resourceType: 'directory_auth_retention_policy',
    resourceId: input.tenantId,
    before: existing ? retentionHistorySnapshot(existing) : {},
    after: retentionHistorySnapshot(next),
    now,
  });
  return next;
}

export async function listDirectoryAuthEvidenceExports(
  adapter: DatabaseAdapter,
  tenantId: string,
  limit?: number
): Promise<DirectoryAuthEvidenceExportRow[]> {
  return adapter.query<DirectoryAuthEvidenceExportRow>(
    `SELECT *
       FROM directory_auth_evidence_exports
      WHERE tenant_id = ?
      ORDER BY created_at DESC
      LIMIT ?`,
    [tenantId, clampListLimit(limit)]
  );
}

export async function getDirectoryAuthEvidenceExport(
  adapter: DatabaseAdapter,
  tenantId: string,
  exportId: string
): Promise<DirectoryAuthEvidenceExportRow | null> {
  return adapter.queryOne<DirectoryAuthEvidenceExportRow>(
    `SELECT *
       FROM directory_auth_evidence_exports
      WHERE tenant_id = ?
        AND id = ?
      LIMIT 1`,
    [tenantId, exportId]
  );
}

export async function createDirectoryAuthEvidenceExportJob(
  adapter: DatabaseAdapter,
  input: DirectoryAuthCreateEvidenceExportInput
): Promise<DirectoryAuthEvidenceExportRow> {
  const now = input.now ?? Date.now();
  const retentionDays = input.retentionDays ?? DEFAULT_EVIDENCE_EXPORT_RETENTION_DAYS;
  const id = input.id ?? createDirectoryAuthId('daex');
  const artifactKey = input.artifactKey ?? `directory-auth/evidence/${input.tenantId}/${id}.json`;
  const manifest = boundedJson({
    type: 'directory_auth_evidence_export',
    version: 1,
    tenant_id: input.tenantId,
    export_id: id,
    requested_by: input.requestedBy,
    period_start_at: input.periodStartAt,
    period_end_at: input.periodEndAt,
    download_after_delete: Boolean(input.downloadAfterDelete),
    generated_at: now,
    sections: [
      'migration_campaigns',
      'migration_user_states',
      'migration_transactions',
      'config_history',
      'retention_policy',
      'support_bundle_metadata',
      'wordwarden_advisories',
    ],
  });
  const manifestBytes = new TextEncoder().encode(manifest).byteLength;
  const sizeEstimateBytes = input.sizeEstimateBytes ?? manifestBytes;
  const row: DirectoryAuthEvidenceExportRow = {
    id,
    tenant_id: input.tenantId,
    status: 'ready',
    requested_by: input.requestedBy,
    period_start_at: input.periodStartAt,
    period_end_at: input.periodEndAt,
    size_estimate_bytes: sizeEstimateBytes,
    artifact_key: artifactKey,
    artifact_sha256: input.artifactSha256 ?? (await sha256Hex(manifest)),
    object_catalog_id: input.objectCatalogId ?? null,
    manifest_signature_key_id: null,
    manifest_signature_alg: null,
    signed_url_expires_at: null,
    retention_expires_at: now + retentionDays * 24 * 60 * 60 * 1000,
    download_after_delete: input.downloadAfterDelete ? 1 : 0,
    error_code: null,
    created_at: now,
    updated_at: now,
    completed_at: now,
    deleted_at: null,
  };
  await adapter.execute(
    `INSERT INTO directory_auth_evidence_exports (
       id, tenant_id, status, requested_by, period_start_at, period_end_at,
       size_estimate_bytes, artifact_key, artifact_sha256, object_catalog_id, manifest_signature_key_id,
       manifest_signature_alg, signed_url_expires_at, retention_expires_at,
       download_after_delete, error_code, created_at, updated_at, completed_at, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.tenant_id,
      row.status,
      row.requested_by,
      row.period_start_at,
      row.period_end_at,
      row.size_estimate_bytes,
      row.artifact_key,
      row.artifact_sha256,
      row.object_catalog_id,
      row.manifest_signature_key_id,
      row.manifest_signature_alg,
      row.signed_url_expires_at,
      row.retention_expires_at,
      row.download_after_delete,
      row.error_code,
      row.created_at,
      row.updated_at,
      row.completed_at,
      row.deleted_at,
    ]
  );
  return row;
}

export async function listDirectoryAuthReleaseAdvisories(
  adapter: DatabaseAdapter,
  channel: string = 'stable',
  limit?: number
): Promise<DirectoryAuthReleaseAdvisoryRow[]> {
  return adapter.query<DirectoryAuthReleaseAdvisoryRow>(
    `SELECT *
       FROM directory_auth_release_advisories
      WHERE channel = ?
      ORDER BY updated_at DESC
      LIMIT ?`,
    [channel, clampListLimit(limit)]
  );
}

export function matchDirectoryAuthReleaseAdvisories(
  version: string,
  advisories: DirectoryAuthReleaseAdvisoryRow[]
): DirectoryAuthAdvisoryMatch[] {
  return advisories.map((advisory) => {
    const affectedVersions = parseStringArray(advisory.affected_versions_json);
    const normalized = normalizeVersion(version);
    const affected = affectedVersions.some((candidate) =>
      advisoryVersionMatches(candidate, normalized)
    );
    return {
      advisory,
      affected,
      reason: affected ? 'version_affected' : 'version_not_affected',
    };
  });
}

export async function listDirectoryAuthSupportBundles(
  adapter: DatabaseAdapter,
  tenantId: string,
  limit?: number
): Promise<DirectoryAuthSupportBundleRow[]> {
  return adapter.query<DirectoryAuthSupportBundleRow>(
    `SELECT *
       FROM directory_auth_support_bundles
      WHERE tenant_id = ?
      ORDER BY created_at DESC
      LIMIT ?`,
    [tenantId, clampListLimit(limit)]
  );
}

export async function getDirectoryAuthSupportBundle(
  adapter: DatabaseAdapter,
  tenantId: string,
  bundleId: string
): Promise<DirectoryAuthSupportBundleRow | null> {
  return adapter.queryOne<DirectoryAuthSupportBundleRow>(
    `SELECT *
       FROM directory_auth_support_bundles
      WHERE tenant_id = ?
        AND id = ?
      LIMIT 1`,
    [tenantId, bundleId]
  );
}

export async function createDirectoryAuthSupportBundleRequest(
  adapter: DatabaseAdapter,
  input: DirectoryAuthCreateSupportBundleInput
): Promise<DirectoryAuthSupportBundleRow> {
  const now = input.now ?? Date.now();
  const retentionDays = input.retentionDays ?? DEFAULT_SUPPORT_BUNDLE_RETENTION_DAYS;
  const id = input.id ?? createDirectoryAuthId('dasb');
  const artifactKey =
    input.artifactKey ?? `directory-auth/support-bundles/${input.tenantId}/${id}.json`;
  const manifest = boundedJson({
    type: 'directory_auth_support_bundle',
    version: 1,
    tenant_id: input.tenantId,
    bundle_id: id,
    requested_by: input.requestedBy,
    redaction_level: input.redactionLevel,
    scope: input.scope ?? {},
    consent_summary: input.consentSummary ?? {},
    generated_at: now,
    contents: [
      'redacted_configuration',
      'directory_auth_recent_job_metadata',
      'directory_auth_recent_advisory_metadata',
      'wordwarden_connector_health_summary',
    ],
  });
  const row: DirectoryAuthSupportBundleRow = {
    id,
    tenant_id: input.tenantId,
    requested_by: input.requestedBy,
    redaction_level: input.redactionLevel,
    status: 'ready',
    scope_json: boundedJson(input.scope ?? {}),
    consent_summary_json: boundedJson(input.consentSummary ?? {}),
    artifact_key: artifactKey,
    artifact_sha256: input.artifactSha256 ?? (await sha256Hex(manifest)),
    object_catalog_id: input.objectCatalogId ?? null,
    retention_expires_at: now + retentionDays * 24 * 60 * 60 * 1000,
    created_at: now,
    updated_at: now,
    completed_at: now,
    deleted_at: null,
  };
  await adapter.execute(
    `INSERT INTO directory_auth_support_bundles (
       id, tenant_id, requested_by, redaction_level, status, scope_json,
       consent_summary_json, artifact_key, artifact_sha256, object_catalog_id, retention_expires_at,
       created_at, updated_at, completed_at, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.tenant_id,
      row.requested_by,
      row.redaction_level,
      row.status,
      row.scope_json,
      row.consent_summary_json,
      row.artifact_key,
      row.artifact_sha256,
      row.object_catalog_id,
      row.retention_expires_at,
      row.created_at,
      row.updated_at,
      row.completed_at,
      row.deleted_at,
    ]
  );
  return row;
}

interface RecordConfigHistoryInput {
  tenantId: string;
  actorId?: string | null;
  category: string;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
  now?: number;
}

export async function recordDirectoryAuthConfigHistory(
  adapter: DatabaseAdapter,
  input: RecordConfigHistoryInput
): Promise<void> {
  await adapter.execute(
    `INSERT INTO directory_auth_config_history (
       id, tenant_id, actor_id, category, action, resource_type, resource_id,
       before_redacted_json, after_redacted_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      createDirectoryAuthId('dach'),
      input.tenantId,
      input.actorId ?? null,
      input.category,
      input.action,
      input.resourceType,
      input.resourceId ?? null,
      boundedJson(input.before ?? {}),
      boundedJson(input.after ?? {}),
      input.now ?? Date.now(),
    ]
  );
}

async function upsertDirectoryAuthMigrationUserState(
  adapter: DatabaseAdapter,
  input: {
    tenantId: string;
    campaign: DirectoryAuthMigrationCampaignRow;
    userId: string;
    connectorId: string;
    directorySubject: string;
    cohortKey?: string | null;
    now: number;
  }
): Promise<DirectoryAuthMigrationUserStateRow> {
  const existing = await adapter.queryOne<DirectoryAuthMigrationUserStateRow>(
    `SELECT *
       FROM directory_auth_migration_user_states
      WHERE tenant_id = ?
        AND campaign_id = ?
        AND (
          user_id = ?
          OR (connector_id = ? AND directory_subject = ?)
        )
      ORDER BY updated_at DESC
      LIMIT 1`,
    [input.tenantId, input.campaign.id, input.userId, input.connectorId, input.directorySubject]
  );
  if (existing) {
    if (existing.first_directory_login_at !== null) return existing;
    await adapter.execute(
      `UPDATE directory_auth_migration_user_states
          SET first_directory_login_at = ?,
              cohort_key = COALESCE(cohort_key, ?),
              updated_at = ?
        WHERE tenant_id = ? AND id = ?`,
      [input.now, input.cohortKey ?? null, input.now, input.tenantId, existing.id]
    );
    return {
      ...existing,
      first_directory_login_at: input.now,
      cohort_key: existing.cohort_key ?? input.cohortKey ?? null,
      updated_at: input.now,
    };
  }

  const row: DirectoryAuthMigrationUserStateRow = {
    id: createDirectoryAuthId('damus'),
    tenant_id: input.tenantId,
    campaign_id: input.campaign.id,
    user_id: input.userId,
    connector_id: input.connectorId,
    directory_subject: input.directorySubject,
    cohort_key: input.cohortKey ?? null,
    state: 'eligible',
    first_directory_login_at: input.now,
    prompted_at: null,
    deferred_until: null,
    passkey_required_at: null,
    enrolled_at: null,
    blocked_reason: null,
    recovery_reason: null,
    reset_count: 0,
    last_reset_at: null,
    last_reset_by: null,
    last_reset_reason: null,
    created_at: input.now,
    updated_at: input.now,
  };
  await adapter.execute(
    `INSERT INTO directory_auth_migration_user_states (
       id, tenant_id, campaign_id, user_id, connector_id, directory_subject, cohort_key,
       state, first_directory_login_at, prompted_at, deferred_until,
       passkey_required_at, enrolled_at, blocked_reason, recovery_reason,
       reset_count, last_reset_at, last_reset_by, last_reset_reason, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.tenant_id,
      row.campaign_id,
      row.user_id,
      row.connector_id,
      row.directory_subject,
      row.cohort_key,
      row.state,
      row.first_directory_login_at,
      row.prompted_at,
      row.deferred_until,
      row.passkey_required_at,
      row.enrolled_at,
      row.blocked_reason,
      row.recovery_reason,
      row.reset_count,
      row.last_reset_at,
      row.last_reset_by,
      row.last_reset_reason,
      row.created_at,
      row.updated_at,
    ]
  );
  return row;
}

async function markDirectoryAuthMigrationUserState(
  adapter: DatabaseAdapter,
  row: DirectoryAuthMigrationUserStateRow,
  input: {
    state: DirectoryAuthMigrationUserState;
    promptedAt?: number | null;
    passkeyRequiredAt?: number | null;
    now: number;
  }
): Promise<DirectoryAuthMigrationUserStateRow> {
  const next: DirectoryAuthMigrationUserStateRow = {
    ...row,
    state: input.state,
    prompted_at: input.promptedAt === undefined ? row.prompted_at : input.promptedAt,
    passkey_required_at:
      input.passkeyRequiredAt === undefined ? row.passkey_required_at : input.passkeyRequiredAt,
    updated_at: input.now,
  };
  if (
    next.state === row.state &&
    next.prompted_at === row.prompted_at &&
    next.passkey_required_at === row.passkey_required_at
  ) {
    return next;
  }
  await adapter.execute(
    `UPDATE directory_auth_migration_user_states
        SET state = ?,
            prompted_at = ?,
            passkey_required_at = ?,
            updated_at = ?
      WHERE tenant_id = ? AND id = ?`,
    [
      next.state,
      next.prompted_at,
      next.passkey_required_at,
      next.updated_at,
      next.tenant_id,
      next.id,
    ]
  );
  return next;
}

function directoryAuthTargetPolicyMatch(
  rawPolicy: string,
  input: DirectoryAuthResolveMigrationInput
): { matches: boolean; cohortKey?: string | null } {
  const policy = parseRecord(rawPolicy);
  if (!policy) return { matches: false };
  if (policy.type === 'all' || policy.tenant_default === true) return { matches: true };
  if (stringArrayIncludes(policy.user_ids, input.userId)) return { matches: true };
  if (stringArrayIncludes(policy.directory_subjects, input.directorySubject))
    return { matches: true };

  const assignments = Array.isArray(policy.assignments) ? policy.assignments : [];
  if (assignments.some((assignment) => assignmentTargetsDirectoryUser(assignment, input))) {
    return { matches: true };
  }

  const cohortKey = matchingCohortKey(policy, input);
  return cohortKey ? { matches: true, cohortKey } : { matches: false };
}

function assignmentTargetsDirectoryUser(
  assignment: unknown,
  input: DirectoryAuthResolveMigrationInput
): boolean {
  if (!assignment || typeof assignment !== 'object' || Array.isArray(assignment)) return false;
  const record = assignment as Record<string, unknown>;
  const userId = typeof record.user_id === 'string' ? record.user_id : undefined;
  if (userId && userId === input.userId) return true;

  const directorySubject =
    typeof record.directory_subject === 'string' ? record.directory_subject : undefined;
  if (!directorySubject || directorySubject !== input.directorySubject) return false;

  const connectorId = typeof record.connector_id === 'string' ? record.connector_id : undefined;
  return !connectorId || connectorId === input.connectorId;
}

function matchingCohortKey(
  policy: Record<string, unknown>,
  input: DirectoryAuthResolveMigrationInput
): string | null {
  if (!input.directoryFacts) return null;
  for (const cohort of Array.isArray(policy.cohorts) ? policy.cohorts : []) {
    const key = cohortMatches(cohort, input.directoryFacts);
    if (key) return key;
  }

  const groupMatch = firstStringArrayMatch(
    policy.directory_groups,
    directoryGroupValues(input.directoryFacts)
  );
  if (groupMatch) return `directory_group:${groupMatch}`;

  const attributeMatch = attributePolicyMatch(
    policy.directory_attributes,
    input.directoryFacts.attributes
  );
  if (attributeMatch) return `directory_attribute:${attributeMatch}`;

  const profileMatch = attributePolicyMatch(
    policy.profile_attributes,
    input.directoryFacts.profileAttributes
  );
  return profileMatch ? `profile_attribute:${profileMatch}` : null;
}

function cohortMatches(cohort: unknown, facts: DirectoryAuthTargetFacts): string | null {
  if (!cohort || typeof cohort !== 'object' || Array.isArray(cohort)) return null;
  const record = cohort as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const group = typeof record.group === 'string' ? record.group.trim() : '';
  const groupValue = typeof record.value === 'string' ? record.value.trim() : '';
  if (group && directoryGroupValues(facts).includes(group)) return id || `directory_group:${group}`;
  if (
    record.source === 'directory_group' &&
    groupValue &&
    directoryGroupValues(facts).includes(groupValue)
  ) {
    return id || `directory_group:${groupValue}`;
  }

  const attributeName = typeof record.attribute === 'string' ? record.attribute.trim() : '';
  const attributeValue = typeof record.value === 'string' ? record.value.trim() : '';
  if (
    attributeName &&
    attributeValue &&
    attributeHasValue(facts.attributes, attributeName, attributeValue)
  ) {
    return id || `directory_attribute:${attributeName}:${attributeValue}`;
  }

  const profileName =
    typeof record.profile_attribute === 'string' ? record.profile_attribute.trim() : '';
  if (
    profileName &&
    attributeValue &&
    attributeHasValue(facts.profileAttributes, profileName, attributeValue)
  ) {
    return id || `profile_attribute:${profileName}:${attributeValue}`;
  }
  return null;
}

function firstStringArrayMatch(values: unknown, candidates: string[]): string | null {
  if (!Array.isArray(values)) return null;
  for (const value of values) {
    if (typeof value === 'string' && candidates.includes(value)) return value;
  }
  return null;
}

function attributePolicyMatch(
  policy: unknown,
  attributes: DirectoryAuthTargetFacts['attributes'] | DirectoryAuthTargetFacts['profileAttributes']
): string | null {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || !attributes) return null;
  for (const [name, expected] of Object.entries(policy as Record<string, unknown>)) {
    const expectedValues = Array.isArray(expected)
      ? expected.filter((value): value is string => typeof value === 'string')
      : typeof expected === 'string'
        ? [expected]
        : [];
    if (expectedValues.some((value) => attributeHasValue(attributes, name, value))) {
      return `${name}:${expectedValues.find((value) => attributeHasValue(attributes, name, value))}`;
    }
  }
  return null;
}

function attributeHasValue(
  attributes:
    | DirectoryAuthTargetFacts['attributes']
    | DirectoryAuthTargetFacts['profileAttributes'],
  name: string,
  expected: string
): boolean {
  const raw = attributes?.[name];
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.value : raw;
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return values.includes(expected);
}

function directoryGroupValues(facts: DirectoryAuthTargetFacts): string[] {
  return (facts.groups ?? []).flatMap((group) => {
    if (typeof group === 'string') return [group];
    return [group.id, group.name, group.dn, group.display, group.display_name].filter(
      (value): value is string => typeof value === 'string' && value.length > 0
    );
  });
}

function resolveDirectoryAuthEffectiveEmailCodeFallbackModeSync(
  campaign: DirectoryAuthMigrationCampaignRow,
  tenantPolicy: DirectoryAuthTenantPolicyRow
): DirectoryAuthEmailCodeFallbackMode {
  return campaign.email_code_fallback_mode === 'tenant_default'
    ? tenantPolicy.email_code_fallback_mode
    : campaign.email_code_fallback_mode;
}

function stringArrayIncludes(value: unknown, needle: string): boolean {
  return Array.isArray(value) && value.some((item) => item === needle);
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

function advisoryVersionMatches(candidate: string, normalizedVersion: string): boolean {
  const normalizedCandidate = normalizeVersion(candidate);
  if (!normalizedCandidate) return false;
  if (normalizedCandidate === '*') return true;
  if (normalizedCandidate === normalizedVersion) return true;
  for (const operator of ['<=', '>=', '<', '>'] as const) {
    if (normalizedCandidate.startsWith(operator)) {
      const expected = normalizeVersion(normalizedCandidate.slice(operator.length));
      const compared = compareVersions(normalizedVersion, expected);
      if (operator === '<=') return compared <= 0;
      if (operator === '>=') return compared >= 0;
      if (operator === '<') return compared < 0;
      return compared > 0;
    }
  }
  if (normalizedCandidate.endsWith('.*')) {
    return normalizedVersion.startsWith(normalizedCandidate.slice(0, -1));
  }
  return false;
}

function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, '');
}

function compareVersions(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const max = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < max; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function versionParts(value: string): number[] {
  return value
    .split('-')[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function parseRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function clampTransactionTtl(value: number): number {
  if (!Number.isFinite(value)) return 600;
  return Math.max(
    MIN_MIGRATION_TRANSACTION_TTL_SECONDS,
    Math.min(MAX_MIGRATION_TRANSACTION_TTL_SECONDS, Math.trunc(value))
  );
}

function clampListLimit(value?: number): number {
  if (!value || !Number.isFinite(value)) return 50;
  return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.trunc(value)));
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function boundedJson(value: unknown): string {
  const text = JSON.stringify(value ?? {});
  if (new TextEncoder().encode(text).byteLength <= MAX_JSON_BYTES) {
    return text;
  }
  return JSON.stringify({ truncated: true });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function campaignHistorySnapshot(row: DirectoryAuthMigrationCampaignRow): Record<string, unknown> {
  return {
    id: row.id,
    status: row.status,
    mode: row.mode,
    passkey_prompt_mode: row.passkey_prompt_mode,
    email_code_fallback_mode: row.email_code_fallback_mode,
    grace_period_days: row.grace_period_days,
    transaction_ttl_seconds: row.transaction_ttl_seconds,
    is_template: row.is_template === 1,
  };
}

function retentionHistorySnapshot(row: DirectoryAuthRetentionPolicyRow): Record<string, unknown> {
  return {
    authrim_audit_retention_days: row.authrim_audit_retention_days,
    wordwarden_local_retention_days: row.wordwarden_local_retention_days,
    artifact_delete_grace_hours: row.artifact_delete_grace_hours,
  };
}

function tenantPolicyHistorySnapshot(row: DirectoryAuthTenantPolicyRow): Record<string, unknown> {
  return {
    email_code_fallback_mode: row.email_code_fallback_mode,
  };
}
