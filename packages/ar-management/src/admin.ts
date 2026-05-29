/**
 * Admin API Endpoints
 * User management, client management, and statistics for administrative dashboard
 */

import { Context } from 'hono';
import type { Env, Session } from '@authrim/ar-lib-core';
import { getRefreshTokenRotatorStubByJti } from '@authrim/ar-lib-core/services/refresh-token-family-store';
import {
  invalidateConsentCache,
  revokeToken,
  getSessionStoreForNewSession,
  getChallengeStoreByChallengeId,
  getTenantIdFromContext,
  createPIIContextFromHono,
  createAuthContextFromHono,
  hasPIIDatabase,
  generateId,
  type DatabaseAdapter,
  createErrorResponse,
  AR_ERROR_CODES,
  validateAllowedOrigins,
  createAuditLogFromContext,
  getLogger,
  // Crypto utilities
  hashClientSecret,
  // Event System
  publishEvent,
  CLIENT_EVENTS,
  CONSENT_EVENTS,
  type ClientEventData,
  type ExtendedConsentEventData,
  getClient,
  // Operational Logs (for reason_detail storage)
  storeOperationalLog,
  // PII Configuration
  getOperationalLogRetentionDays,
  // Cache Invalidation (P0 KV Cache Optimization)
  invalidateTenantProfileCache,
  // Write-Through KV Cache (Phase 3)
  readResponseTextWithLimit,
  CanonicalRuntimeUserStore,
} from '@authrim/ar-lib-core';
import {
  logSanitizedError,
  parseClientStringArray,
  isCharArrayLike,
  getErrorDetailsForResponse,
  scheduleAdminAuditLog,
  toMilliseconds,
  toSeconds,
} from './admin-shared';
import {
  createAuditHotQueryUnsupportedResponse,
  fromStoredAuditTimestamp,
  getAuditHotQuerySqlSpec,
  getAuditHotQuerySupport,
  getAuditTimeRange,
  type AuditHotQueryContext,
} from './audit-hot-query';
import {
  getArchiveAuditEventById,
  getAuditArchiveQuerySupport,
  listArchiveAuditEvents,
} from './audit-archive-query';
import { getAuditJsonTextExpr } from './audit-sql-dialect';
import { createLoggingTenantKeyResolver } from './logging-tenant-key';

const TOKEN_REGISTRATION_ERROR_BODY_MAX_BYTES = 64 * 1024;

function isAuditLogStoreNotInitializedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    /no such table:\s*(event_log|audit_log)/i.test(message) ||
    /relation\s+"?(event_log|audit_log)"?\s+does not exist/i.test(message) ||
    /table\s+'?(event_log|audit_log)'?\s+doesn't exist/i.test(message)
  );
}

function emptyAuditLogListResponse(page: number, limit: number) {
  return {
    entries: [],
    pagination: {
      page,
      limit,
      total: 0,
      totalPages: 0,
    },
  };
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function findCanonicalRuntimeUser(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  userId: string,
  options?: { includeInactive?: boolean }
) {
  const authCtx = createAuthContextFromHono(c, tenantId);
  const piiCtx = createPIIContextFromHono(c, tenantId);
  return new CanonicalRuntimeUserStore({
    coreAdapter: authCtx.coreAdapter,
    piiAdapter: piiCtx.defaultPiiAdapter,
    tenantId,
  }).findById(userId, options);
}

async function getCanonicalAccountStatus(
  adapter: DatabaseAdapter,
  tenantId: string,
  userId: string
): Promise<{ id: string; lifecycle_state: string; status: string } | null> {
  const account = await adapter.queryOne<{
    id: string;
    lifecycle_state: string;
    metadata_json: string | null;
  }>(
    'SELECT id, lifecycle_state, metadata_json FROM identity_accounts WHERE legacy_user_id = ? AND tenant_id = ?',
    [userId, tenantId]
  );
  if (!account) return null;
  const metadata = parseJsonObject(account.metadata_json);
  return {
    id: account.id,
    lifecycle_state: account.lifecycle_state,
    status:
      typeof metadata.status === 'string'
        ? metadata.status
        : account.lifecycle_state === 'active'
          ? 'active'
          : account.lifecycle_state,
  };
}

async function updateCanonicalAccountStatus(
  adapter: DatabaseAdapter,
  tenantId: string,
  userId: string,
  status: string,
  metadataPatch: Record<string, unknown> = {}
) {
  const lifecycleState = status === 'active' ? 'active' : status;
  const now = Date.now();
  const account = await adapter.queryOne<{ id: string; primary_subject_id: string | null }>(
    'SELECT id, primary_subject_id FROM identity_accounts WHERE legacy_user_id = ? AND tenant_id = ?',
    [userId, tenantId]
  );
  if (!account) return false;
  await adapter.execute(
    `UPDATE identity_accounts
        SET lifecycle_state = ?,
            metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.status', ?),
            updated_at = ?
      WHERE id = ? AND tenant_id = ?`,
    [lifecycleState, status, now, account.id, tenantId]
  );
  for (const [key, value] of Object.entries(metadataPatch)) {
    await adapter.execute(
      `UPDATE identity_accounts
          SET metadata_json = json_set(COALESCE(metadata_json, '{}'), ?, ?), updated_at = ?
        WHERE id = ? AND tenant_id = ?`,
      [`$.${key}`, value, now, account.id, tenantId]
    );
  }
  if (account.primary_subject_id) {
    await adapter.execute('UPDATE identity_subjects SET lifecycle_state = ?, updated_at = ? WHERE id = ? AND tenant_id = ?', [
      lifecycleState,
      now,
      account.primary_subject_id,
      tenantId,
    ]);
  }
  return true;
}

async function auditHotTableExists(
  context: AuditHotQueryContext,
  tableName: 'audit_log' | 'event_log'
): Promise<boolean> {
  if (context.dialect !== 'sqlite') {
    return true;
  }
  const table = await context.adapter.queryOne<{ name: string }>(
    'SELECT name FROM sqlite_master WHERE type = ? AND name = ?',
    ['table', tableName]
  );
  return Boolean(table?.name);
}

export {
  adminStatsHandler,
  adminUsersListHandler,
  adminUserGetHandler,
  adminUserCreateHandler,
  adminUserUpdateHandler,
  adminUserDeleteHandler,
  adminUserRetryPiiHandler,
  adminUserDeletePiiHandler,
} from './admin-users';
export {
  adminClientCreateHandler,
  adminClientsListHandler,
  adminClientGetHandler,
  adminClientUpdateHandler,
  adminClientDeleteHandler,
  adminClientsBulkDeleteHandler,
  adminClientRegenerateSecretHandler,
} from './admin-clients';
export {
  serveAvatarHandler,
  adminUserAvatarUploadHandler,
  adminUserAvatarDeleteHandler,
  adminSessionsListHandler,
  adminSessionGetHandler,
  adminSessionRevokeHandler,
  adminUserRevokeAllSessionsHandler,
} from './admin-user-sessions';

function buildAuditTimestamp(timestamp: string | null | undefined): number | null {
  if (!timestamp) {
    return null;
  }
  const value = new Date(timestamp).getTime();
  return Number.isFinite(value) ? Math.floor(value / 1000) : null;
}

function getCoreAdapter(
  c: Context<{ Bindings: Env }>,
  tenantId: string = getTenantIdFromContext(c)
): DatabaseAdapter {
  return createAuthContextFromHono(c, tenantId).coreAdapter;
}

function formatArchiveAuditEntry(
  entry: {
    id: string;
    anonymizedUserId?: string;
    eventType: string;
    eventCategory: string;
    result: string;
    severity: string;
    errorCode?: string;
    errorMessage?: string;
    clientId?: string;
    sessionId?: string;
    requestId?: string;
    detailsJson?: string;
    createdAt: number;
  },
  userIdMap: Map<string, string>
) {
  let metadata: unknown = null;
  let metadataObject: Record<string, unknown> | null = null;

  if (entry.detailsJson) {
    try {
      metadata = JSON.parse(entry.detailsJson) as unknown;
      if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
        metadataObject = metadata as Record<string, unknown>;
      }
    } catch {
      metadata = null;
      metadataObject = null;
    }
  }

  return {
    id: entry.id,
    userId: entry.anonymizedUserId ? (userIdMap.get(entry.anonymizedUserId) ?? null) : null,
    action: entry.eventType,
    resourceType:
      typeof metadataObject?.resourceType === 'string'
        ? metadataObject.resourceType
        : typeof metadataObject?.resource_type === 'string'
          ? metadataObject.resource_type
          : entry.eventCategory,
    resourceId:
      typeof metadataObject?.resourceId === 'string'
        ? metadataObject.resourceId
        : typeof metadataObject?.resource_id === 'string'
          ? metadataObject.resource_id
          : (entry.clientId ?? null),
    ipAddress:
      typeof metadataObject?.ipAddress === 'string'
        ? metadataObject.ipAddress
        : typeof metadataObject?.ip_address === 'string'
          ? metadataObject.ip_address
          : null,
    userAgent:
      typeof metadataObject?.userAgent === 'string'
        ? metadataObject.userAgent
        : typeof metadataObject?.user_agent === 'string'
          ? metadataObject.user_agent
          : null,
    clientId: entry.clientId ?? null,
    sessionId: entry.sessionId ?? null,
    requestId: entry.requestId ?? null,
    result: entry.result,
    severity: entry.severity,
    errorCode: entry.errorCode ?? null,
    errorMessage: entry.errorMessage ?? null,
    metadata: metadata && typeof metadata === 'object' ? metadata : null,
    createdAt: new Date(entry.createdAt).toISOString(),
  };
}

async function buildArchiveAuditUserIdMap(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  entries: Array<{ anonymizedUserId?: string }>
) {
  const anonymizedIds = [
    ...new Set(entries.map((entry) => entry.anonymizedUserId).filter(Boolean)),
  ] as string[];
  return resolveAuditUserIdMap(c, tenantId, anonymizedIds);
}

async function resolveAuditUserAnonymizedId(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  userId: string
): Promise<string | null> {
  const piiCtx = createPIIContextFromHono(c, tenantId);
  const row = await piiCtx.defaultPiiAdapter.queryOne<{ anonymized_user_id: string }>(
    'SELECT anonymized_user_id FROM user_anonymization_map WHERE tenant_id = ? AND user_id = ?',
    [tenantId, userId]
  );
  return row?.anonymized_user_id ?? null;
}

async function resolveAuditUserIdMap(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  anonymizedUserIds: string[]
): Promise<Map<string, string>> {
  if (anonymizedUserIds.length === 0) {
    return new Map();
  }

  const piiCtx = createPIIContextFromHono(c, tenantId);
  const placeholders = anonymizedUserIds.map(() => '?').join(', ');
  const rows = await piiCtx.defaultPiiAdapter.query<{
    anonymized_user_id: string;
    user_id: string;
  }>(
    `SELECT anonymized_user_id, user_id
       FROM user_anonymization_map
      WHERE tenant_id = ? AND anonymized_user_id IN (${placeholders})`,
    [tenantId, ...anonymizedUserIds]
  );

  return new Map(rows.map((row) => [row.anonymized_user_id, row.user_id]));
}

function buildAuditResourceFilter(
  context: AuditHotQueryContext,
  resourceType?: string | null,
  resourceId?: string | null
): { clause: string; params: string[] } {
  if (context.mode === 'legacy') {
    const conditions: string[] = [];
    const params: string[] = [];
    if (resourceType) {
      conditions.push('resource_type = ?');
      params.push(resourceType);
    }
    if (resourceId) {
      conditions.push('resource_id = ?');
      params.push(resourceId);
    }
    return {
      clause: conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : '',
      params,
    };
  }

  const { detailsColumn } = getAuditHotQuerySqlSpec(context);
  const resourceTypeExpr = getAuditJsonTextExpr(detailsColumn, 'resourceType', context.dialect);
  const legacyResourceTypeExpr = getAuditJsonTextExpr(
    detailsColumn,
    'resource_type',
    context.dialect
  );
  const resourceIdExpr = getAuditJsonTextExpr(detailsColumn, 'resourceId', context.dialect);
  const legacyResourceIdExpr = getAuditJsonTextExpr(detailsColumn, 'resource_id', context.dialect);

  const conditions: string[] = [];
  const params: string[] = [];

  if (resourceType) {
    conditions.push(`(${resourceTypeExpr} = ? OR ${legacyResourceTypeExpr} = ?)`);
    params.push(resourceType, resourceType);
  }

  if (resourceId) {
    conditions.push(`(${resourceIdExpr} = ? OR ${legacyResourceIdExpr} = ?)`);
    params.push(resourceId, resourceId);
  }

  return {
    clause: conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : '',
    params,
  };
}

// =============================================================================
// Policy Configuration
// =============================================================================

/**
 * Policy feature flag names mapped to camelCase property names
 */
const POLICY_FLAG_MAPPING: Record<string, string> = {
  ENABLE_ABAC: 'enableAbac',
  ENABLE_REBAC: 'enableRebac',
  ENABLE_POLICY_LOGGING: 'enablePolicyLogging',
  ENABLE_VERIFIED_ATTRIBUTES: 'enableVerifiedAttributes',
  ENABLE_CUSTOM_RULES: 'enableCustomRules',
  ENABLE_SD_JWT: 'enableSdJwt',
  ENABLE_POLICY_EMBEDDING: 'enablePolicyEmbedding',
};

/**
 * KV key prefix for policy feature flags (matches policy-core/feature-flags.ts)
 */
const POLICY_FLAGS_PREFIX = 'policy:flags:';

/**
 * KV keys for policy claims configuration
 */
const POLICY_CLAIMS_KEYS = {
  ACCESS_TOKEN_CLAIMS: 'policy:claims:access_token',
  ID_TOKEN_CLAIMS: 'policy:claims:id_token',
};

/**
 * Read policy feature flags from KV
 * Returns an object with flag values that have been set in KV
 */
async function readPolicyFlagsFromKV(env: Env): Promise<Record<string, boolean>> {
  const flags: Record<string, boolean> = {};

  if (!env.SETTINGS) {
    return flags;
  }

  for (const [kvKey, camelKey] of Object.entries(POLICY_FLAG_MAPPING)) {
    try {
      const value = await env.SETTINGS.get(`${POLICY_FLAGS_PREFIX}${kvKey}`);
      if (value !== null) {
        flags[camelKey] = value.toLowerCase() === 'true' || value === '1';
      }
    } catch {
      // Skip on error
    }
  }

  return flags;
}

/**
 * Read policy claims configuration from KV
 */
async function readPolicyClaimsFromKV(env: Env): Promise<Record<string, string>> {
  const claims: Record<string, string> = {};

  if (!env.SETTINGS) {
    return claims;
  }

  try {
    const accessTokenClaims = await env.SETTINGS.get(POLICY_CLAIMS_KEYS.ACCESS_TOKEN_CLAIMS);
    if (accessTokenClaims) {
      claims.accessTokenClaims = accessTokenClaims;
    }

    const idTokenClaims = await env.SETTINGS.get(POLICY_CLAIMS_KEYS.ID_TOKEN_CLAIMS);
    if (idTokenClaims) {
      claims.idTokenClaims = idTokenClaims;
    }
  } catch {
    // Skip on error
  }

  return claims;
}

/**
 * Sync policy settings to KV
 * Writes feature flags and claims to individual KV keys for runtime access
 */
async function syncPolicyFlagsToKV(
  env: Env,
  policy: {
    enableAbac?: boolean;
    enableRebac?: boolean;
    enablePolicyLogging?: boolean;
    enableVerifiedAttributes?: boolean;
    enableCustomRules?: boolean;
    enableSdJwt?: boolean;
    enablePolicyEmbedding?: boolean;
    accessTokenClaims?: string;
    idTokenClaims?: string;
  }
): Promise<void> {
  if (!env.SETTINGS) {
    return;
  }

  const writes: Promise<void>[] = [];

  // Sync feature flags to individual KV keys
  for (const [kvKey, camelKey] of Object.entries(POLICY_FLAG_MAPPING)) {
    const value = policy[camelKey as keyof typeof policy];
    if (typeof value === 'boolean') {
      writes.push(env.SETTINGS.put(`${POLICY_FLAGS_PREFIX}${kvKey}`, value.toString()));
    }
  }

  // Sync claims configuration
  if (policy.accessTokenClaims !== undefined) {
    writes.push(env.SETTINGS.put(POLICY_CLAIMS_KEYS.ACCESS_TOKEN_CLAIMS, policy.accessTokenClaims));
  }
  if (policy.idTokenClaims !== undefined) {
    writes.push(env.SETTINGS.put(POLICY_CLAIMS_KEYS.ID_TOKEN_CLAIMS, policy.idTokenClaims));
  }

  await Promise.all(writes);
}

// =============================================================================
// User Suspend/Lock API
// =============================================================================

/**
 * Pre-defined reason codes for suspend operations
 * These codes are stored in audit logs (not free-form text)
 */
const SUSPEND_REASON_CODES = new Set([
  'policy_violation',
  'security_incident',
  'account_abuse',
  'payment_issue',
  'user_request',
  'admin_action',
  'investigation',
  'compliance',
  'other',
]);

/**
 * Pre-defined reason codes for lock operations
 */
const LOCK_REASON_CODES = new Set([
  'brute_force',
  'suspicious_activity',
  'compromised_credentials',
  'security_incident',
  'admin_action',
  'investigation',
  'compliance',
  'other',
]);

/**
 * POST /api/admin/users/:id/suspend
 * Suspend a user account with reason code
 *
 * Security:
 * - RBAC: tenant_admin or higher
 * - Tenant isolation: operation scoped to tenant
 * - Audit: reason_code logged (not reason_detail for privacy)
 *
 * Side effects:
 * - User status set to 'suspended'
 * - Optional: revoke all tokens and sessions
 * - Audit log entry created
 */
export async function adminUserSuspendHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN-USER');
  const tenantId = getTenantIdFromContext(c);
  const userId = c.req.param('id')!;

  if (!userId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  try {
    const body = await c.req.json<{
      reason_code: string;
      reason_detail?: string;
      duration_hours?: number;
      revoke_tokens?: boolean;
      revoke_sessions?: boolean;
      notify_user?: boolean;
    }>();

    // Validate reason_code
    if (!body.reason_code || !SUSPEND_REASON_CODES.has(body.reason_code)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'reason_code',
          reason: `Must be one of: ${Array.from(SUSPEND_REASON_CODES).join(', ')}`,
        },
      });
    }

    // Validate duration_hours if provided
    if (body.duration_hours !== undefined) {
      if (body.duration_hours < 1 || body.duration_hours > 8760) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
          variables: { field: 'duration_hours', reason: 'Must be between 1 and 8760' },
        });
      }
    }

    const adapter = getCoreAdapter(c, tenantId);

    const user = await getCanonicalAccountStatus(adapter, tenantId, userId);

    if (!user) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const previousStatus = user.status ?? 'active';
    const nowTs = Math.floor(Date.now() / 1000);
    const expiresAt = body.duration_hours ? nowTs + body.duration_hours * 3600 : null;

    await updateCanonicalAccountStatus(adapter, tenantId, userId, 'suspended', {
      suspended_at: nowTs,
      suspended_until: expiresAt,
    });

    // Token/Session Revocation Strategy (Authrim Architecture):
    // =========================================================
    // Authrim uses user status-based token invalidation rather than individual token revocation.
    // When user.status = 'suspended' or 'locked':
    // 1. Introspection endpoint checks user status and returns active: false for all tokens
    // 2. This is more efficient for distributed systems (no need to update each token in DO)
    //
    // Session invalidation via SessionStore DO is a future enhancement.
    // For now, sessions will expire naturally. The login flow checks user status
    // and blocks suspended/locked users from creating new sessions.
    //
    // The revoke_tokens/revoke_sessions flags are kept for API compatibility
    // and future implementation of explicit DO-based revocation.
    const revokedTokens = body.revoke_tokens !== false ? -1 : 0; // -1 indicates implicit revocation via status
    const revokedSessions = body.revoke_sessions !== false ? -1 : 0;

    // Write audit log (reason_code only, not reason_detail for privacy)
    await createAuditLogFromContext(c, 'user.suspend', 'user', userId, {
      reason_code: body.reason_code,
      previous_status: previousStatus,
      duration_hours: body.duration_hours,
      revoked_tokens: revokedTokens,
      revoked_sessions: revokedSessions,
    });

    // Store reason_detail to operational_logs if provided (encrypted, short retention)
    if (body.reason_detail && c.env.PII_ENCRYPTION_KEY) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const adminAuth = (c as any).get('adminAuth') as { userId: string } | undefined;
        const actorId = adminAuth?.userId ?? 'unknown';
        const requestId = c.req.header('X-Request-ID');

        // Get retention days from tenant config (default: 90)
        const retentionDays = await getOperationalLogRetentionDays(c.env.AUTHRIM_CONFIG, tenantId);

        await storeOperationalLog(
          adapter,
          {
            inlineEncryptionKey: c.env.PII_ENCRYPTION_KEY,
            objectStorage:
              c.env.SENSITIVE_DETAILS && c.env.OBJECT_ENCRYPTION_ROOT_KEY
                ? {
                    bucket: c.env.SENSITIVE_DETAILS,
                    rootKeyHex: c.env.OBJECT_ENCRYPTION_ROOT_KEY,
                    keyVersion:
                      Number.parseInt(c.env.OBJECT_ENCRYPTION_KEY_VERSION || '1', 10) || 1,
                  }
                : undefined,
            runtimeLogging: {
              env: c.env,
              tenantKeyResolver: createLoggingTenantKeyResolver(adapter),
            },
          },
          {
            tenantId,
            subjectType: 'user',
            subjectId: userId,
            actorId,
            action: 'user.suspend',
            reasonDetail: body.reason_detail,
            requestId,
            retentionDays,
          }
        );
      } catch (opLogError) {
        // Non-blocking: log error but don't fail the main operation
        log.warn('Failed to store operational log for suspend', { userId }, opLogError as Error);
      }
    }

    log.info('User suspended', {
      action: 'user_suspend',
      userId,
      reasonCode: body.reason_code,
      previousStatus,
      revokedTokens,
      revokedSessions,
    });

    // Admin Audit Log (non-blocking)
    scheduleAdminAuditLog(c, 'user.suspended', userId, 'success', {
      reason_code: body.reason_code,
      previous_status: previousStatus,
      duration_hours: body.duration_hours,
    });

    return c.json({
      user_id: userId,
      status: 'suspended',
      previous_status: previousStatus,
      effective_at: new Date(nowTs * 1000).toISOString(),
      ...(expiresAt && { expires_at: new Date(expiresAt * 1000).toISOString() }),
      reason_code: body.reason_code,
      revoked: {
        tokens: revokedTokens,
        sessions: revokedSessions,
      },
    });
  } catch (error) {
    logSanitizedError('Admin suspend user error', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/users/:id/lock
 * Lock a user account (more severe than suspend)
 *
 * Security:
 * - RBAC: tenant_admin or higher
 * - Tenant isolation: operation scoped to tenant
 * - Audit: reason_code logged (not reason_detail for privacy)
 *
 * Side effects:
 * - User status set to 'locked'
 * - Optional: revoke all tokens and sessions
 * - Audit log entry created
 * - Lock is more severe: blocks new logins and API access
 */
export async function adminUserLockHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN-USER');
  const tenantId = getTenantIdFromContext(c);
  const userId = c.req.param('id')!;

  if (!userId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  try {
    const body = await c.req.json<{
      reason_code: string;
      reason_detail?: string;
      unlock_at?: string;
      revoke_tokens?: boolean;
      revoke_sessions?: boolean;
    }>();

    // Validate reason_code
    if (!body.reason_code || !LOCK_REASON_CODES.has(body.reason_code)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'reason_code',
          reason: `Must be one of: ${Array.from(LOCK_REASON_CODES).join(', ')}`,
        },
      });
    }

    // Validate unlock_at if provided
    let unlockAtTs: number | null = null;
    if (body.unlock_at) {
      const unlockDate = new Date(body.unlock_at);
      if (isNaN(unlockDate.getTime())) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
          variables: { field: 'unlock_at', reason: 'Must be valid ISO 8601 datetime' },
        });
      }
      unlockAtTs = Math.floor(unlockDate.getTime() / 1000);
    }

    const adapter = getCoreAdapter(c, tenantId);

    const user = await getCanonicalAccountStatus(adapter, tenantId, userId);

    if (!user) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const previousStatus = user.status ?? 'active';
    const nowTs = Math.floor(Date.now() / 1000);

    await updateCanonicalAccountStatus(adapter, tenantId, userId, 'locked', {
      locked_at: nowTs,
      locked_until: unlockAtTs,
    });

    // Token/Session Revocation Strategy (Authrim Architecture):
    // Same as suspend - user status-based token invalidation via introspection.
    // See suspend handler comments for details.
    const revokedTokens = body.revoke_tokens !== false ? -1 : 0; // -1 indicates implicit revocation via status
    const revokedSessions = body.revoke_sessions !== false ? -1 : 0;

    // Write audit log (reason_code only, not reason_detail for privacy)
    await createAuditLogFromContext(c, 'user.lock', 'user', userId, {
      reason_code: body.reason_code,
      previous_status: previousStatus,
      unlock_at: body.unlock_at,
      revoked_tokens: revokedTokens,
      revoked_sessions: revokedSessions,
    });

    // Store reason_detail to operational_logs if provided (encrypted, short retention)
    if (body.reason_detail && c.env.PII_ENCRYPTION_KEY) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const adminAuth = (c as any).get('adminAuth') as { userId: string } | undefined;
        const actorId = adminAuth?.userId ?? 'unknown';
        const requestId = c.req.header('X-Request-ID');

        // Get retention days from tenant config (default: 90)
        const retentionDays = await getOperationalLogRetentionDays(c.env.AUTHRIM_CONFIG, tenantId);

        await storeOperationalLog(
          adapter,
          {
            inlineEncryptionKey: c.env.PII_ENCRYPTION_KEY,
            objectStorage:
              c.env.SENSITIVE_DETAILS && c.env.OBJECT_ENCRYPTION_ROOT_KEY
                ? {
                    bucket: c.env.SENSITIVE_DETAILS,
                    rootKeyHex: c.env.OBJECT_ENCRYPTION_ROOT_KEY,
                    keyVersion:
                      Number.parseInt(c.env.OBJECT_ENCRYPTION_KEY_VERSION || '1', 10) || 1,
                  }
                : undefined,
            runtimeLogging: {
              env: c.env,
              tenantKeyResolver: createLoggingTenantKeyResolver(adapter),
            },
          },
          {
            tenantId,
            subjectType: 'user',
            subjectId: userId,
            actorId,
            action: 'user.lock',
            reasonDetail: body.reason_detail,
            requestId,
            retentionDays,
          }
        );
      } catch (opLogError) {
        // Non-blocking: log error but don't fail the main operation
        log.warn('Failed to store operational log for lock', { userId }, opLogError as Error);
      }
    }

    log.info('User locked', {
      action: 'user_lock',
      userId,
      reasonCode: body.reason_code,
      previousStatus,
      revokedTokens,
      revokedSessions,
    });

    // Admin Audit Log (non-blocking)
    scheduleAdminAuditLog(c, 'user.locked', userId, 'success', {
      reason_code: body.reason_code,
      previous_status: previousStatus,
    });

    return c.json({
      user_id: userId,
      status: 'locked',
      previous_status: previousStatus,
      effective_at: new Date(nowTs * 1000).toISOString(),
      ...(unlockAtTs && { unlock_at: new Date(unlockAtTs * 1000).toISOString() }),
      reason_code: body.reason_code,
      revoked: {
        tokens: revokedTokens,
        sessions: revokedSessions,
      },
    });
  } catch (error) {
    logSanitizedError('Admin lock user error', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// =============================================================================
// User Activate (Restore from Suspended/Locked)
// =============================================================================

/**
 * Pre-defined reason codes for activate operations
 */
const ACTIVATE_REASON_CODES = new Set([
  'investigation_cleared', // Security investigation completed, no issues found
  'suspension_expired', // Suspension period ended
  'appeal_approved', // User appeal was approved
  'admin_action', // Admin decided to restore
  'false_positive', // Initial action was a false positive
  'compliance_cleared', // Compliance issue resolved
  'other',
]);

/**
 * POST /api/admin/users/:id/activate
 * Activate (restore) a suspended or locked user account
 *
 * Security:
 * - RBAC: tenant_admin or higher
 * - Tenant isolation: operation scoped to tenant
 * - Audit: reason_code logged (not reason_detail for privacy)
 *
 * Side effects:
 * - User status set to 'active'
 * - Clears suspended_at, suspended_until, locked_at, locked_until
 * - Audit log entry created
 */
export async function adminUserActivateHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN-USER');
  const tenantId = getTenantIdFromContext(c);
  const userId = c.req.param('id')!;

  if (!userId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  try {
    const body = await c.req.json<{
      reason_code: string;
      reason_detail?: string;
      notify_user?: boolean;
    }>();

    // Validate reason_code
    if (!body.reason_code || !ACTIVATE_REASON_CODES.has(body.reason_code)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'reason_code',
          reason: `Must be one of: ${Array.from(ACTIVATE_REASON_CODES).join(', ')}`,
        },
      });
    }

    const adapter = getCoreAdapter(c, tenantId);

    // Get current user state (verify tenant ownership)
    const user = await getCanonicalAccountStatus(adapter, tenantId, userId);

    if (!user) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Check if user is already active
    if (user.status === 'active') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'User is already active',
        },
        400
      );
    }

    // Check if user is deleted (cannot activate deleted users)
    if (user.status === 'deleted') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Cannot activate a deleted user',
        },
        400
      );
    }

    const previousStatus = user.status;
    const nowTs = Math.floor(Date.now() / 1000);

    await updateCanonicalAccountStatus(adapter, tenantId, userId, 'active', {
      suspended_at: null,
      suspended_until: null,
      locked_at: null,
      locked_until: null,
    });

    // Write audit log (reason_code only, not reason_detail for privacy)
    await createAuditLogFromContext(c, 'user.activate', 'user', userId, {
      reason_code: body.reason_code,
      previous_status: previousStatus,
    });

    // Store reason_detail to operational_logs if provided (encrypted, short retention)
    if (body.reason_detail && c.env.PII_ENCRYPTION_KEY) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const adminAuth = (c as any).get('adminAuth') as { userId: string } | undefined;
        const actorId = adminAuth?.userId ?? 'unknown';
        const requestId = c.req.header('X-Request-ID');

        // Get retention days from tenant config (default: 90)
        const retentionDays = await getOperationalLogRetentionDays(c.env.AUTHRIM_CONFIG, tenantId);

        await storeOperationalLog(
          adapter,
          {
            inlineEncryptionKey: c.env.PII_ENCRYPTION_KEY,
            objectStorage:
              c.env.SENSITIVE_DETAILS && c.env.OBJECT_ENCRYPTION_ROOT_KEY
                ? {
                    bucket: c.env.SENSITIVE_DETAILS,
                    rootKeyHex: c.env.OBJECT_ENCRYPTION_ROOT_KEY,
                    keyVersion:
                      Number.parseInt(c.env.OBJECT_ENCRYPTION_KEY_VERSION || '1', 10) || 1,
                  }
                : undefined,
            runtimeLogging: {
              env: c.env,
              tenantKeyResolver: createLoggingTenantKeyResolver(adapter),
            },
          },
          {
            tenantId,
            subjectType: 'user',
            subjectId: userId,
            actorId,
            action: 'user.activate',
            reasonDetail: body.reason_detail,
            requestId,
            retentionDays,
          }
        );
      } catch (opLogError) {
        // Non-blocking: log error but don't fail the main operation
        log.warn('Failed to store operational log for activate', { userId }, opLogError as Error);
      }
    }

    log.info('User activated', {
      action: 'user_activate',
      userId,
      reasonCode: body.reason_code,
      previousStatus,
    });

    // Admin Audit Log (non-blocking)
    scheduleAdminAuditLog(c, 'user.activated', userId, 'success', {
      reason_code: body.reason_code,
      previous_status: previousStatus,
    });

    return c.json({
      user_id: userId,
      status: 'active',
      previous_status: previousStatus,
      effective_at: new Date(nowTs * 1000).toISOString(),
      reason_code: body.reason_code,
    });
  } catch (error) {
    logSanitizedError('Admin activate user error', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// =============================================================================
// Phase 2: User Anonymize (GDPR Article 17 - Right to Erasure)
// =============================================================================

/**
 * Anonymization reason codes
 */
const ANONYMIZE_REASON_CODES = new Set([
  'gdpr_article_17', // GDPR right to erasure
  'user_request', // User requested deletion
  'data_retention', // Data retention policy
  'legal_requirement', // Legal/regulatory requirement
  'consent_withdrawn', // Consent withdrawn
]);

/**
 * POST /api/admin/users/:id/anonymize
 * Anonymize (delete) user data per GDPR Article 17
 *
 * This is an irreversible operation that:
 * 1. Deletes all PII from PII database
 * 2. Updates core database status to 'deleted'
 * 3. Creates a tombstone record (deletion proof without PII)
 * 4. Revokes all tokens and sessions
 * 5. Writes audit log with hashed user ID only
 *
 * Security:
 * - Requires Idempotency-Key header (recommended)
 * - Checks for legal hold before proceeding
 * - Tenant isolation enforced
 */
export async function adminUserAnonymizeHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN-USER');
  const tenantId = getTenantIdFromContext(c);
  const userId = c.req.param('id')!;

  if (!userId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  try {
    const body = await c.req.json<{
      reason_code: string;
      confirm: boolean;
    }>();

    // Validate reason_code
    if (!body.reason_code || !ANONYMIZE_REASON_CODES.has(body.reason_code)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'reason_code',
          reason: `Must be one of: ${Array.from(ANONYMIZE_REASON_CODES).join(', ')}`,
        },
      });
    }

    // Require explicit confirmation
    if (body.confirm !== true) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'confirm', reason: 'Must be true to confirm irreversible deletion' },
      });
    }

    const authCtx = createAuthContextFromHono(c, tenantId);
    const nowTs = Math.floor(Date.now() / 1000);

    const runtimeUsers = new CanonicalRuntimeUserStore({
      coreAdapter: authCtx.coreAdapter,
      piiAdapter: createPIIContextFromHono(c, tenantId).defaultPiiAdapter,
      tenantId,
    });
    const user = await runtimeUsers.findById(userId, { includeInactive: true });

    if (!user) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Check if already anonymized
    if (!user.active && user.lifecycle_state === 'deleted') {
      return c.json({
        user_id: userId,
        already_anonymized: true,
        message: 'User has already been anonymized',
      });
    }

    // Check for legal hold (block anonymization if active)
    let legalHold: { id: string; reason: string } | null = null;
    try {
      legalHold = await authCtx.coreAdapter.queryOne<{ id: string; reason: string }>(
        `SELECT id, reason FROM legal_holds
         WHERE tenant_id = ? AND subject_type = 'user' AND subject_id = ?
         AND (expires_at IS NULL OR expires_at > ?)`,
        [tenantId, userId, nowTs]
      );
    } catch {
      legalHold = null;
    }

    if (legalHold) {
      return c.json(
        {
          error: 'legal_hold_active',
          error_description: 'User is under legal hold and cannot be anonymized',
          hold_id: legalHold.id,
        },
        409
      );
    }

    // Generate user ID hash for audit trail (no way to recover original ID)
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(userId + tenantId));
    const userIdHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    // Get admin actor ID
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminAuth = (c as any).get('adminAuth') as
      | { adminId?: string; userId?: string }
      | undefined;
    const deletedBy = adminAuth?.adminId ?? adminAuth?.userId ?? 'unknown';

    let retentionUntil = nowTs + 90 * 24 * 60 * 60;
    let tombstoneId: string | null = null;

    if (hasPIIDatabase(c)) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const existingTombstone = await piiCtx.piiRepositories.tombstone.findByUserId(
        tenantId,
        userId,
        piiCtx.defaultPiiAdapter
      );

      if (!existingTombstone) {
        const tombstone = await piiCtx.piiRepositories.tombstone.createTombstone(
          {
            id: userId,
            tenant_id: tenantId,
            email_blind_index: null,
            deleted_by: deletedBy,
            deletion_reason: body.reason_code,
            retention_days: 90,
            metadata: {
              source: 'admin_user_anonymize',
              request_confirmed: true,
              user_id_hash: userIdHash,
            },
          },
          piiCtx.defaultPiiAdapter
        );
        tombstoneId = tombstone.id;
        retentionUntil = tombstone.retention_until;
      } else {
        tombstoneId = existingTombstone.id;
        retentionUntil = existingTombstone.retention_until;
      }
      await piiCtx.piiRepositories.linkedIdentity.deleteByUserId(
        tenantId,
        userId,
        piiCtx.defaultPiiAdapter
      );
      await piiCtx.piiRepositories.identifier.deleteByUserId(
        tenantId,
        userId,
        piiCtx.defaultPiiAdapter
      );
    }

    const sessions = await authCtx.repositories.session.findByUserId(userId);
    await Promise.all(
      sessions.map((session) => authCtx.repositories.sessionClient.deleteBySessionId(session.id))
    );
    await Promise.all([
      authCtx.repositories.session.deleteByUserId(userId),
      authCtx.repositories.passkey.deleteByUserId(userId),
      authCtx.repositories.role.removeAllRolesFromUser(userId),
      authCtx.coreAdapter.execute(
        'DELETE FROM subject_org_membership WHERE tenant_id = ? AND subject_id = ?',
        [tenantId, userId]
      ),
    ]);

    await runtimeUsers.deleteUser(userId);

    // Step 6: Write audit log (user_id_hash only, no original ID)
    await createAuditLogFromContext(c, 'user.anonymized', 'user', userIdHash, {
      reason_code: body.reason_code,
      tombstone_id: tombstoneId,
      retention_until: new Date(retentionUntil * 1000).toISOString(),
    });

    log.info('User anonymized', {
      action: 'user_anonymize',
      userIdHash,
      reasonCode: body.reason_code,
      tombstoneId,
    });

    // Admin Audit Log (use user_id_hash to preserve anonymization)
    scheduleAdminAuditLog(c, 'user.anonymized', userIdHash, 'success', {
      reason_code: body.reason_code,
      tombstone_id: tombstoneId,
    });

    return c.json({
      success: true,
      user_id_hash: userIdHash,
      tombstone_id: tombstoneId,
      reason_code: body.reason_code,
      deleted_at: new Date(nowTs * 1000).toISOString(),
      retention_until: new Date(retentionUntil * 1000).toISOString(),
      message: 'User data has been permanently deleted',
    });
  } catch (error) {
    logSanitizedError('Admin anonymize user error', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * GET /api/admin/audit-log
 * List audit log entries with filtering and pagination
 */
export async function adminAuditLogListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const hotQuery = await getAuditHotQuerySupport(c.env, tenantId);

    // Get query parameters
    const page = parseInt(c.req.query('page') || '1', 10);
    const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100);
    const offset = (page - 1) * limit;

    // Filters
    const userId = c.req.query('user_id');
    const action = c.req.query('action');
    const resourceType = c.req.query('resource_type');
    const resourceId = c.req.query('resource_id');
    const startDate = c.req.query('start_date'); // ISO 8601 format
    const endDate = c.req.query('end_date'); // ISO 8601 format

    if (!hotQuery.supported || !hotQuery.context) {
      const archiveQuery = await getAuditArchiveQuerySupport(c.env, tenantId);
      if (!archiveQuery.supported || !archiveQuery.context) {
        return createAuditHotQueryUnsupportedResponse(c, hotQuery);
      }

      const startTimestamp = buildAuditTimestamp(startDate);
      const endTimestamp = buildAuditTimestamp(endDate);
      const anonymizedUserId = userId
        ? await resolveAuditUserAnonymizedId(c, tenantId, userId)
        : null;

      if (userId && !anonymizedUserId) {
        return c.json(emptyAuditLogListResponse(page, limit));
      }

      const archiveResult = await listArchiveAuditEvents(archiveQuery.context, {
        tenantId,
        page,
        limit,
        startTime: startTimestamp == null ? undefined : startTimestamp * 1000,
        endTime: endTimestamp == null ? undefined : endTimestamp * 1000,
        eventType: action ?? undefined,
        anonymizedUserId: anonymizedUserId ?? undefined,
        resourceType: resourceType ?? undefined,
        resourceId: resourceId ?? undefined,
      });

      const userIdMap = await buildArchiveAuditUserIdMap(c, tenantId, archiveResult.entries);

      return c.json({
        entries: archiveResult.entries.map((entry) => formatArchiveAuditEntry(entry, userIdMap)),
        pagination: {
          page,
          limit,
          total: archiveResult.total,
          totalPages: archiveResult.totalPages,
        },
      });
    }

    const context = hotQuery.context;
    const { tableName, actionColumn, detailsColumn } = getAuditHotQuerySqlSpec(context);
    if (!(await auditHotTableExists(context, tableName))) {
      return c.json(emptyAuditLogListResponse(page, limit));
    }

    // Build WHERE clause - tenant_id is always first for index usage
    const conditions: string[] = ['tenant_id = ?'];
    const params: (string | number)[] = [tenantId];

    if (userId) {
      if (context.mode === 'legacy') {
        conditions.push('user_id = ?');
        params.push(userId);
      } else {
        const anonymizedUserId = await resolveAuditUserAnonymizedId(c, tenantId, userId);
        if (!anonymizedUserId) {
          return c.json(emptyAuditLogListResponse(page, limit));
        }
        conditions.push('anonymized_user_id = ?');
        params.push(anonymizedUserId);
      }
    }

    if (action) {
      conditions.push(`${actionColumn} = ?`);
      params.push(action);
    }

    const resourceFilter = buildAuditResourceFilter(context, resourceType, resourceId);
    if (resourceFilter.clause) {
      conditions.push(resourceFilter.clause.replace(/^ AND /, ''));
      params.push(...resourceFilter.params);
    }

    if (startDate) {
      const startTimestamp = buildAuditTimestamp(startDate);
      const storedStart =
        startTimestamp == null
          ? null
          : context.createdAtUnit === 'milliseconds'
            ? startTimestamp * 1000
            : startTimestamp;
      if (storedStart != null) {
        conditions.push('created_at >= ?');
        params.push(storedStart);
      }
    }

    if (endDate) {
      const endTimestamp = buildAuditTimestamp(endDate);
      const storedEnd =
        endTimestamp == null
          ? null
          : context.createdAtUnit === 'milliseconds'
            ? endTimestamp * 1000
            : endTimestamp;
      if (storedEnd != null) {
        conditions.push('created_at <= ?');
        params.push(storedEnd);
      }
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM ${tableName} ${whereClause}`;
    const countResult = await context.adapter.queryOne<{ total: number }>(countQuery, params);

    const total = countResult?.total || 0;
    const totalPages = Math.ceil(total / limit);

    // Get audit log entries
    let entries: Array<Record<string, unknown>> = [];

    if (hotQuery.context.mode === 'legacy') {
      const query = `
        SELECT
          id,
          user_id,
          action,
          resource_type,
          resource_id,
          ip_address,
          user_agent,
          metadata_json,
          created_at,
          severity
        FROM audit_log
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `;

      const result = await context.adapter.query<{
        id: string;
        user_id: string | null;
        action: string;
        resource_type: string | null;
        resource_id: string | null;
        ip_address: string | null;
        user_agent: string | null;
        metadata_json: string | null;
        created_at: number;
        severity: string | null;
      }>(query, [...params, limit, offset]);

      entries = result.map((row) => ({
        id: row.id,
        userId: row.user_id,
        action: row.action,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        ipAddress: row.ip_address,
        userAgent: row.user_agent,
        metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
        severity: row.severity ?? 'info',
        createdAt: fromStoredAuditTimestamp(row.created_at, context),
      }));
    } else {
      const query = `
        SELECT
          id,
          anonymized_user_id,
          event_type,
          event_category,
          result,
          severity,
          error_code,
          error_message,
          client_id,
          session_id,
          request_id,
          details_json,
          created_at
        FROM event_log
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `;

      const result = await context.adapter.query<{
        id: string;
        anonymized_user_id: string | null;
        event_type: string;
        event_category: string;
        result: string;
        severity: string;
        error_code: string | null;
        error_message: string | null;
        client_id: string | null;
        session_id: string | null;
        request_id: string | null;
        details_json: string | null;
        created_at: number;
      }>(query, [...params, limit, offset]);

      const anonymizedIds = [
        ...new Set(result.map((row) => row.anonymized_user_id).filter(Boolean)),
      ] as string[];
      const userIdMap = await resolveAuditUserIdMap(c, tenantId, anonymizedIds);

      entries = result.map((row) => {
        const metadata = row.details_json ? JSON.parse(row.details_json) : null;
        const metadataObject =
          metadata && typeof metadata === 'object' && !Array.isArray(metadata)
            ? (metadata as Record<string, unknown>)
            : null;

        return {
          id: row.id,
          userId: row.anonymized_user_id ? (userIdMap.get(row.anonymized_user_id) ?? null) : null,
          action: row.event_type,
          resourceType:
            typeof metadataObject?.resourceType === 'string'
              ? metadataObject.resourceType
              : typeof metadataObject?.resource_type === 'string'
                ? metadataObject.resource_type
                : row.event_category,
          resourceId:
            typeof metadataObject?.resourceId === 'string'
              ? metadataObject.resourceId
              : typeof metadataObject?.resource_id === 'string'
                ? metadataObject.resource_id
                : row.client_id,
          ipAddress:
            typeof metadataObject?.ipAddress === 'string'
              ? metadataObject.ipAddress
              : typeof metadataObject?.ip_address === 'string'
                ? metadataObject.ip_address
                : null,
          userAgent:
            typeof metadataObject?.userAgent === 'string'
              ? metadataObject.userAgent
              : typeof metadataObject?.user_agent === 'string'
                ? metadataObject.user_agent
                : null,
          clientId: row.client_id,
          sessionId: row.session_id,
          requestId: row.request_id,
          result: row.result,
          severity: row.severity,
          errorCode: row.error_code,
          errorMessage: row.error_message,
          metadata,
          createdAt: fromStoredAuditTimestamp(row.created_at, context),
        };
      });
    }

    return c.json({
      entries,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    });
  } catch (error) {
    if (isAuditLogStoreNotInitializedError(error)) {
      const page = parseInt(c.req.query('page') || '1', 10);
      const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100);
      return c.json(emptyAuditLogListResponse(page, limit));
    }
    logSanitizedError('Admin audit log list error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to fetch audit log',
      },
      500
    );
  }
}

/**
 * GET /api/admin/audit-log/:id
 * Get a specific audit log entry by ID
 */
export async function adminAuditLogGetHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const id = c.req.param('id')!;
    const hotQuery = await getAuditHotQuerySupport(c.env, tenantId);

    if (!id) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Audit log entry ID is required',
        },
        400
      );
    }

    if (!hotQuery.supported || !hotQuery.context) {
      const archiveQuery = await getAuditArchiveQuerySupport(c.env, tenantId);
      if (!archiveQuery.supported || !archiveQuery.context) {
        return createAuditHotQueryUnsupportedResponse(c, hotQuery);
      }

      const entry = await getArchiveAuditEventById(archiveQuery.context, tenantId, id);
      if (!entry) {
        return c.json(
          {
            error: 'not_found',
            error_description: 'Audit log entry not found',
          },
          404
        );
      }

      const userIdMap = await buildArchiveAuditUserIdMap(c, tenantId, [entry]);
      const resolvedUserId = entry.anonymizedUserId
        ? (userIdMap.get(entry.anonymizedUserId) ?? null)
        : null;
      let user = null;

      if (resolvedUserId) {
        const runtimeUser = await findCanonicalRuntimeUser(c, tenantId, resolvedUserId);
        if (runtimeUser) {
          user = {
            id: runtimeUser.id,
            email: runtimeUser.email,
            name: runtimeUser.name,
            picture: runtimeUser.picture,
          };
        }
      }

      return c.json({
        ...formatArchiveAuditEntry(entry, userIdMap),
        user,
      });
    }

    const context = hotQuery.context;
    const { tableName } = getAuditHotQuerySqlSpec(context);

    // Get audit log entry
    const coreAdapter = getCoreAdapter(c, tenantId);
    let resolvedUserId: string | null = null;
    let user = null;
    let responseBody: Record<string, unknown> | null = null;

    if (context.mode === 'legacy') {
      const entry = await context.adapter.queryOne<{
        id: string;
        user_id: string | null;
        action: string;
        resource_type: string | null;
        resource_id: string | null;
        ip_address: string | null;
        user_agent: string | null;
        metadata_json: string | null;
        created_at: number;
        severity: string | null;
      }>(
        `
        SELECT
          id,
          user_id,
          action,
          resource_type,
          resource_id,
          ip_address,
          user_agent,
          metadata_json,
          created_at,
          severity
        FROM ${tableName}
        WHERE id = ? AND tenant_id = ?
        `,
        [id, tenantId]
      );

      if (!entry) {
        return c.json(
          {
            error: 'not_found',
            error_description: 'Audit log entry not found',
          },
          404
        );
      }

      resolvedUserId = entry.user_id;
      responseBody = {
        id: entry.id,
        userId: entry.user_id,
        action: entry.action,
        resourceType: entry.resource_type,
        resourceId: entry.resource_id,
        ipAddress: entry.ip_address,
        userAgent: entry.user_agent,
        metadata: entry.metadata_json ? JSON.parse(entry.metadata_json) : null,
        severity: entry.severity ?? 'info',
        createdAt: fromStoredAuditTimestamp(entry.created_at, context),
      };
    } else {
      const entry = await context.adapter.queryOne<{
        id: string;
        anonymized_user_id: string | null;
        event_type: string;
        event_category: string;
        result: string;
        severity: string;
        error_code: string | null;
        error_message: string | null;
        client_id: string | null;
        session_id: string | null;
        request_id: string | null;
        details_json: string | null;
        created_at: number;
      }>(
        `
        SELECT
          id,
          anonymized_user_id,
          event_type,
          event_category,
          result,
          severity,
          error_code,
          error_message,
          client_id,
          session_id,
          request_id,
          details_json,
          created_at
        FROM ${tableName}
        WHERE id = ? AND tenant_id = ?
        `,
        [id, tenantId]
      );

      if (!entry) {
        return c.json(
          {
            error: 'not_found',
            error_description: 'Audit log entry not found',
          },
          404
        );
      }

      if (entry.anonymized_user_id) {
        const userIdMap = await resolveAuditUserIdMap(c, tenantId, [entry.anonymized_user_id]);
        resolvedUserId = userIdMap.get(entry.anonymized_user_id) ?? null;
      }

      const metadata = entry.details_json ? JSON.parse(entry.details_json) : null;
      const metadataObject =
        metadata && typeof metadata === 'object' && !Array.isArray(metadata)
          ? (metadata as Record<string, unknown>)
          : null;

      responseBody = {
        id: entry.id,
        userId: resolvedUserId,
        action: entry.event_type,
        resourceType:
          typeof metadataObject?.resourceType === 'string'
            ? metadataObject.resourceType
            : typeof metadataObject?.resource_type === 'string'
              ? metadataObject.resource_type
              : entry.event_category,
        resourceId:
          typeof metadataObject?.resourceId === 'string'
            ? metadataObject.resourceId
            : typeof metadataObject?.resource_id === 'string'
              ? metadataObject.resource_id
              : entry.client_id,
        ipAddress:
          typeof metadataObject?.ipAddress === 'string'
            ? metadataObject.ipAddress
            : typeof metadataObject?.ip_address === 'string'
              ? metadataObject.ip_address
              : null,
        userAgent:
          typeof metadataObject?.userAgent === 'string'
            ? metadataObject.userAgent
            : typeof metadataObject?.user_agent === 'string'
              ? metadataObject.user_agent
              : null,
        clientId: entry.client_id,
        sessionId: entry.session_id,
        requestId: entry.request_id,
        result: entry.result,
        severity: entry.severity,
        errorCode: entry.error_code,
        errorMessage: entry.error_message,
        metadata,
        createdAt: fromStoredAuditTimestamp(entry.created_at, context),
      };
    }

    if (resolvedUserId) {
      const runtimeUser = await findCanonicalRuntimeUser(c, tenantId, resolvedUserId);
      if (runtimeUser) {
        user = {
          id: runtimeUser.id,
          email: runtimeUser.email,
          name: runtimeUser.name,
          picture: runtimeUser.picture,
        };
      }
    }

    return c.json({
      ...responseBody,
      user,
    });
  } catch (error) {
    logSanitizedError('Admin audit log get error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to fetch audit log entry',
      },
      500
    );
  }
}

/**
 * GET /api/admin/settings
 * Get system settings
 */
export async function adminSettingsGetHandler(c: Context<{ Bindings: Env }>) {
  try {
    const env = c.env as Env;

    // Get settings from KV
    const settingsJson = await env.SETTINGS?.get('system_settings');

    // Default settings
    const defaultSettings = {
      general: {
        siteName: 'Authrim',
        logoUrl: '',
        language: 'en',
        timezone: 'UTC',
      },
      appearance: {
        primaryColor: '#3B82F6',
        secondaryColor: '#10B981',
        fontFamily: 'Inter',
      },
      security: {
        sessionTimeout: 86400, // 24 hours
        mfaEnforced: false,
        passwordMinLength: 8,
        passwordRequireSpecialChar: true,
      },
      email: {
        emailProvider: 'resend',
        smtpHost: '',
        smtpPort: 587,
        smtpUsername: '',
        smtpPassword: '',
      },
      advanced: {
        accessTokenTtl: 3600, // 1 hour
        idTokenTtl: 3600, // 1 hour
        refreshTokenTtl: 2592000, // 30 days
        passkeyEnabled: true,
        magicLinkEnabled: true,
      },
      ciba: {
        enabled: true,
        defaultExpiresIn: 300, // 5 minutes
        minExpiresIn: 60, // 1 minute
        maxExpiresIn: 600, // 10 minutes
        defaultInterval: 5, // 5 seconds
        minInterval: 2, // 2 seconds
        maxInterval: 60, // 60 seconds
        supportedDeliveryModes: ['poll', 'ping', 'push'],
        userCodeEnabled: true,
        bindingMessageMaxLength: 140,
        notificationsEnabled: false,
        notificationProviders: {
          email: false,
          sms: false,
          push: false,
        },
      },
      oidc: {
        // Discovery metadata configuration
        requirePar: false, // Require Pushed Authorization Requests
        claimsSupported: [
          'sub',
          'iss',
          'aud',
          'exp',
          'iat',
          'auth_time',
          'nonce',
          'acr',
          'amr',
          'azp',
          'at_hash',
          'c_hash',
          'name',
          'given_name',
          'family_name',
          'middle_name',
          'nickname',
          'preferred_username',
          'profile',
          'picture',
          'website',
          'email',
          'email_verified',
          'gender',
          'birthdate',
          'zoneinfo',
          'locale',
          'phone_number',
          'phone_number_verified',
          'address',
          'updated_at',
        ],
        responseTypesSupported: ['code'], // Authorization code flow only by default
        tokenEndpointAuthMethodsSupported: [
          'client_secret_basic',
          'client_secret_post',
          'client_secret_jwt',
          'private_key_jwt',
          'none',
        ],
      },
      fapi: {
        // FAPI 2.0 Security Profile configuration
        enabled: false, // FAPI 2.0 mode disabled by default
        requireDpop: false, // Require DPoP (or MTLS) for sender-constrained tokens
        allowPublicClients: true, // Allow public clients (disable for strict FAPI 2.0)
      },
      policy: {
        // Policy system feature flags
        enableAbac: false, // ABAC (Attribute-Based Access Control)
        enableRebac: false, // ReBAC (Relationship-Based Access Control)
        enablePolicyLogging: false, // Detailed policy evaluation logging
        enableVerifiedAttributes: false, // Verified attributes checking
        enableCustomRules: true, // Custom policy rules
        enableSdJwt: false, // SD-JWT (Selective Disclosure JWT)
        enablePolicyEmbedding: false, // Permission embedding in Access Token
        // Token claims configuration
        accessTokenClaims: 'roles,org_id,org_type', // Default claims for Access Token
        idTokenClaims: 'roles,user_type,org_id,plan,org_type', // Default claims for ID Token
      },
      loginUI: {
        theme: 'light',
        variant: 'beige',
        supportedLocales: ['en', 'ja'],
      },
    };

    // Read policy feature flags from KV (dynamic overrides)
    const policyFlags = await readPolicyFlagsFromKV(env);
    const policyClaimsSettings = await readPolicyClaimsFromKV(env);

    // Merge with stored settings if they exist
    const settings = settingsJson
      ? { ...defaultSettings, ...JSON.parse(settingsJson) }
      : defaultSettings;

    // Apply policy feature flags from KV (priority: KV > stored settings > defaults)
    if (Object.keys(policyFlags).length > 0) {
      settings.policy = {
        ...settings.policy,
        ...policyFlags,
      };
    }

    // Apply policy claims settings from KV
    if (Object.keys(policyClaimsSettings).length > 0) {
      settings.policy = {
        ...settings.policy,
        ...policyClaimsSettings,
      };
    }

    return c.json({ settings });
  } catch (error) {
    logSanitizedError('Admin settings get error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to fetch settings',
      },
      500
    );
  }
}

/**
 * PUT /api/admin/settings
 * Update system settings
 */
export async function adminSettingsUpdateHandler(c: Context<{ Bindings: Env }>) {
  try {
    const env = c.env as Env;
    const body = await c.req.json();

    if (!body.settings) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Settings object is required',
        },
        400
      );
    }

    // Validate settings structure
    const allowedSections = [
      'general',
      'appearance',
      'security',
      'email',
      'advanced',
      'ciba',
      'oidc',
      'fapi',
      'policy',
      'loginUI',
    ];
    const settings = body.settings;

    for (const section of Object.keys(settings)) {
      if (!allowedSections.includes(section)) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: `Invalid settings section: ${section}`,
          },
          400
        );
      }
    }

    // Store settings in KV
    if (env.SETTINGS) {
      await env.SETTINGS.put('system_settings', JSON.stringify(settings));

      // Sync policy feature flags to individual KV keys
      if (settings.policy) {
        await syncPolicyFlagsToKV(env, settings.policy);
      }
    } else {
      return c.json(
        {
          error: 'server_error',
          error_description: 'Settings storage is not configured',
        },
        500
      );
    }

    return c.json({
      success: true,
      message: 'Settings updated successfully',
      settings,
    });
  } catch (error) {
    logSanitizedError('Admin settings update error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to update settings',
      },
      500
    );
  }
}

/**
 * GET /api/admin/settings/profiles
 * List available certification profiles
 */
export async function adminListCertificationProfilesHandler(c: Context<{ Bindings: Env }>) {
  try {
    const { listCertificationProfiles } = await import('./certification-profiles');
    const profiles = listCertificationProfiles();
    return c.json({ profiles });
  } catch (error) {
    logSanitizedError('Admin list profiles error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to list certification profiles',
      },
      500
    );
  }
}

/**
 * PUT /api/admin/settings/profile/:profileName
 * Apply a certification profile
 */
export async function adminApplyCertificationProfileHandler(c: Context<{ Bindings: Env }>) {
  try {
    const env = c.env as Env;
    const profileName = c.req.param('profileName')!;

    if (!profileName) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Profile name is required',
        },
        400
      );
    }

    const { getCertificationProfile } = await import('./certification-profiles');
    const profile = getCertificationProfile(profileName);

    if (!profile) {
      return c.json(
        {
          error: 'not_found',
          error_description: `Certification profile '${profileName}' not found`,
        },
        404
      );
    }

    // Get current settings
    const settingsJson = await env.SETTINGS?.get('system_settings');
    const currentSettings = settingsJson ? JSON.parse(settingsJson) : {};

    // Merge profile settings with current settings
    const updatedSettings = {
      ...currentSettings,
      ...profile.settings,
    };

    // Store updated settings
    if (env.SETTINGS) {
      await env.SETTINGS.put('system_settings', JSON.stringify(updatedSettings));
    } else {
      return c.json(
        {
          error: 'server_error',
          error_description: 'Settings storage is not configured',
        },
        500
      );
    }

    return c.json({
      success: true,
      message: `Applied certification profile: ${profile.name}`,
      profile: {
        name: profile.name,
        description: profile.description,
      },
      settings: updatedSettings,
    });
  } catch (error) {
    logSanitizedError('Admin apply profile error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to apply certification profile',
      },
      500
    );
  }
}

/**
 * Get signing key with private key for local token generation
 * GET /api/admin/signing-key
 *
 * Returns the active signing key including the private key (PEM format).
 * This is intended for load testing scripts that need to generate tokens locally.
 *
 * WARNING: This endpoint exposes the private key. Only use in controlled environments.
 */
export async function adminSigningKeyGetHandler(c: Context<{ Bindings: Env }>) {
  try {
    // Get the active key from KeyManager DO via RPC
    const tenantId = getTenantIdFromContext(c);
    const keyManagerId = c.env.KEY_MANAGER.idFromName(`${tenantId}-v3`);
    const keyManager = c.env.KEY_MANAGER.get(keyManagerId);

    const keyData = await keyManager.getActiveKeyWithPrivateRpc();

    if (!keyData || !keyData.privatePEM) {
      const log = getLogger(c).module('ADMIN');
      log.error('Failed to get signing key: no key data', { action: 'get_signing_key' });
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to get signing key',
        },
        500
      );
    }

    return c.json({
      kid: keyData.kid,
      privatePEM: keyData.privatePEM,
      publicJWK: keyData.publicJWK,
    });
  } catch (error) {
    logSanitizedError('Admin signing key get error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get signing key',
        ...getErrorDetailsForResponse(error, c.env),
      },
      500
    );
  }
}

/**
 * Register a refresh token family for load testing (V2)
 * POST /api/admin/tokens/register
 *
 * Registers a pre-generated refresh token with the RefreshTokenRotator DO.
 * This allows load testing scripts to generate tokens locally and register
 * them with the token rotation system.
 *
 * V2: Uses version-based theft detection. The token's jti is stored,
 * and the initial version is returned for inclusion in the rtv claim.
 *
 * Request body:
 * {
 *   "token": "eyJ...", // JWT refresh token (must contain jti claim)
 *   "userId": "user-123",
 *   "clientId": "client-456",
 *   "scope": "openid profile email",
 *   "ttl": 2592000 // optional, seconds (default: 30 days)
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "version": 1,        // Initial version for rtv claim
 *   "jti": "...",        // JTI stored in DO
 *   "expiresIn": 2592000
 * }
 */
export async function adminTokenRegisterHandler(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<{
      token: string;
      userId: string;
      clientId: string;
      scope: string;
      ttl?: number;
    }>();

    const { token, userId, clientId, scope, ttl = 30 * 24 * 60 * 60 } = body;

    if (!token || !userId || !clientId || !scope) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'token, userId, clientId, and scope are required',
        },
        400
      );
    }

    // Extract jti from JWT token
    // JWT format: header.payload.signature
    // We need to decode the payload to get the jti
    let jti: string;
    try {
      const parts = token.split('.');
      if (parts.length !== 3) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'Invalid JWT format',
          },
          400
        );
      }

      // Decode base64url payload
      const payloadBase64 = parts[1];
      const payloadJson = atob(payloadBase64.replace(/-/g, '+').replace(/_/g, '/'));
      const payload = JSON.parse(payloadJson) as { jti?: string };

      if (!payload.jti) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'JWT must contain a jti claim',
          },
          400
        );
      }

      jti = payload.jti;
    } catch (parseError) {
      logSanitizedError('Failed to parse JWT', parseError);
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Failed to parse JWT token',
        },
        400
      );
    }

    const { stub: rotator, resolution } = getRefreshTokenRotatorStubByJti(
      c.env,
      clientId,
      jti,
      getTenantIdFromContext(c)
    );

    // Create token family using V3 API (with generation and shard info)
    // V3 stores generation/shardIndex for proper JTI generation during rotation
    const response = await rotator.fetch(
      new Request('https://refresh-token-rotator/family', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jti, // Full JTI with v{gen}_{shard}_ prefix
          userId,
          clientId,
          scope,
          ttl,
          // V3: Include generation and shard for DO to store
          ...(resolution.generation > 0 &&
            resolution.shardIndex !== null && {
              generation: resolution.generation,
              shardIndex: resolution.shardIndex,
            }),
        }),
      })
    );

    if (!response.ok) {
      const error = await readResponseTextWithLimit(
        response,
        TOKEN_REGISTRATION_ERROR_BODY_MAX_BYTES
      );
      logSanitizedError('Failed to register token', error);
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to register token',
        },
        500
      );
    }

    // V2 response format
    const result = (await response.json()) as {
      version: number;
      newJti: string;
      expiresIn: number;
      allowedScope: string;
    };

    return c.json(
      {
        success: true,
        version: result.version, // V2: Return version for rtv claim
        jti: result.newJti,
        expiresIn: result.expiresIn,
      },
      201
    );
  } catch (error) {
    logSanitizedError('Admin token register error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to register token',
        ...getErrorDetailsForResponse(error, c.env),
      },
      500
    );
  }
}

/**
 * Create test session for load testing
 * POST /api/admin/test-sessions
 *
 * Creates a session for a specified user without requiring login.
 * This is intended for load testing and conformance testing only.
 */
export async function adminTestSessionCreateHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    const body = await c.req.json<{
      user_id: string;
      ttl_seconds?: number;
    }>();

    const { user_id, ttl_seconds = 3600 } = body;

    if (!user_id) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'user_id is required',
        },
        400
      );
    }

    const runtimeUser = await findCanonicalRuntimeUser(c, tenantId, user_id);
    if (!runtimeUser) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    const userEmail = runtimeUser.email;
    const userName = runtimeUser.name;

    // Create session in SessionStore DO (sharded) via RPC
    const now = Date.now();
    const expiresAt = now + ttl_seconds * 1000;

    const { stub: sessionStore, sessionId } = await getSessionStoreForNewSession(
      c.env,
      getTenantIdFromContext(c)
    );

    try {
      await sessionStore.createSessionRpc(
        sessionId,
        user_id,
        ttl_seconds,
        {
          amr: ['admin_api'],
          email: userEmail,
          name: userName,
        },
        getTenantIdFromContext(c)
      );
    } catch (error) {
      logSanitizedError('Failed to create session', error);
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to create session',
        },
        500
      );
    }

    // D1 insert is handled by SessionStore.saveToD1() asynchronously
    // (removed duplicate blocking D1 INSERT for performance optimization)

    const log = getLogger(c).module('ADMIN');
    log.info('Created test session for user', {
      action: 'create_test_session',
      userId: user_id,
      sessionId,
    });

    return c.json(
      {
        session_id: sessionId,
        user_id: user_id,
        expires_at: expiresAt,
        cookie_value: `authrim_session=${sessionId}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=${ttl_seconds}`,
      },
      201
    );
  } catch (error) {
    logSanitizedError('Admin test session create error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create test session',
        ...getErrorDetailsForResponse(error, c.env),
      },
      500
    );
  }
}

// =============================================================================
// Test Email Code Handler - For Load Testing
// =============================================================================

const EMAIL_CODE_TTL = 5 * 60; // 5 minutes in seconds

/**
 * Generate a cryptographically secure 6-digit OTP code
 */
function generateEmailCode(): string {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return (array[0] % 1000000).toString().padStart(6, '0');
}

/**
 * Hash an email code using HMAC-SHA256
 */
async function hashEmailCode(
  code: string,
  email: string,
  sessionId: string,
  issuedAt: number,
  secret: string
): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${code}:${email.toLowerCase()}:${sessionId}:${issuedAt}`);
  const keyData = encoder.encode(secret);

  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, data);
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Hash an email address using SHA-256
 */
async function hashEmail(email: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(email.toLowerCase());
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate test email code for load testing
 * POST /api/admin/test/email-codes
 *
 * Creates an OTP challenge without sending an email.
 * Returns the plaintext code for use in load testing.
 *
 * Request body:
 * {
 *   "email": "user@example.com"
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "code": "123456",
 *   "otpSessionId": "uuid-v4",
 *   "expiresAt": 1702345678
 * }
 */
export async function adminTestEmailCodeHandler(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<{
      email: string;
      create_user?: boolean;
    }>();

    const { email } = body;

    if (!email) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'email is required',
        },
        400
      );
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid email format',
        },
        400
      );
    }

    const tenantId = getTenantIdFromContext(c);
    const piiCtx = createPIIContextFromHono(c, tenantId);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const runtimeUsers = new CanonicalRuntimeUserStore({
      coreAdapter: authCtx.coreAdapter,
      piiAdapter: piiCtx.defaultPiiAdapter,
      tenantId,
    });
    let userId: string | null = null;
    let userEmail: string | null = null;
    let userName: string | null = null;

    const existingUser = await runtimeUsers.findByEmail(email.toLowerCase(), {
      includeInactive: true,
    });
    if (existingUser) {
      userId = existingUser.id;
      userEmail = existingUser.email;
      userName = existingUser.name;
    }

    // create_user option: if false, don't create new user (for benchmarks with pre-seeded users)
    const createUser = body.create_user !== false;

    if (!userId) {
      if (!createUser) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'User does not exist and create_user is false',
          },
          404
        );
      }

      const preferredUsername = email.split('@')[0];

      userId = generateId();
      await runtimeUsers.syncUser({
        userId,
        email: email.toLowerCase(),
        active: true,
        emailVerified: false,
        phoneNumberVerified: false,
        userType: 'end_user',
        sourceRef: 'admin:test-email-code',
        piiFields: {
          preferred_username: true,
        },
        sensitiveValues: {
          preferred_username: preferredUsername,
        },
      });

      userEmail = email.toLowerCase();
      userName = preferredUsername;
    }

    // Generate OTP session ID for session binding
    const otpSessionId = crypto.randomUUID();
    const issuedAt = Date.now();
    const expiresAt = issuedAt + EMAIL_CODE_TTL * 1000;

    // Generate 6-digit OTP code
    const code = generateEmailCode();

    // Get HMAC secret from environment
    const hmacSecret = c.env.OTP_HMAC_SECRET || c.env.ISSUER_URL;

    // Parallelize independent operations: hash computations + DO stub retrieval
    const [codeHash, emailHash, challengeStore] = await Promise.all([
      hashEmailCode(code, email.toLowerCase(), otpSessionId, issuedAt, hmacSecret),
      hashEmail(email.toLowerCase()),
      getChallengeStoreByChallengeId(c.env, otpSessionId, getTenantIdFromContext(c)),
    ]);

    await challengeStore.storeChallengeRpc({
      id: `email_code:${otpSessionId}`,
      tenantId: getTenantIdFromContext(c),
      type: 'email_code',
      userId: userId as string,
      challenge: codeHash,
      ttl: EMAIL_CODE_TTL,
      email: email.toLowerCase(),
      metadata: {
        email_hash: emailHash,
        otp_session_id: otpSessionId,
        issued_at: issuedAt,
        purpose: 'login',
      },
    });

    const log = getLogger(c).module('ADMIN');
    log.info('Created test email code for user', {
      action: 'create_test_email_code',
      userId,
      otpSessionId,
    });

    return c.json(
      {
        success: true,
        code,
        otpSessionId,
        expiresAt: Math.floor(expiresAt / 1000),
        userId: userId,
      },
      201
    );
  } catch (error) {
    logSanitizedError('Admin test email code error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create test email code',
        ...getErrorDetailsForResponse(error, c.env),
      },
      500
    );
  }
}

// =============================================================================
// Admin Consent Management
// =============================================================================

/**
 * GET /api/admin/users/:userId/consents
 * List consents for a specific user
 */
export async function adminUserConsentsListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('userId')!;
    if (!userId) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'User ID is required',
        },
        400
      );
    }

    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    const runtimeUser = await findCanonicalRuntimeUser(c, tenantId, userId, {
      includeInactive: true,
    });
    if (!runtimeUser) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'User not found',
        },
        404
      );
    }

    // Query consents with client info
    const consentsResult = await authCtx.coreAdapter.query<{
      id: string;
      client_id: string;
      scope: string;
      selected_scopes: string | null;
      granted_at: number;
      expires_at: number | null;
      privacy_policy_version: string | null;
      tos_version: string | null;
      consent_version: number | null;
      client_name: string | null;
      logo_uri: string | null;
    }>(
      `SELECT c.id, c.client_id, c.scope, c.selected_scopes, c.granted_at, c.expires_at,
              c.privacy_policy_version, c.tos_version, c.consent_version,
              oc.client_name, oc.logo_uri
       FROM oauth_client_consents c
       LEFT JOIN oauth_clients oc ON c.tenant_id = oc.tenant_id AND c.client_id = oc.client_id
       WHERE c.user_id = ? AND c.tenant_id = ?
       ORDER BY c.granted_at DESC`,
      [userId, tenantId]
    );

    const consents = consentsResult.map((row) => ({
      id: row.id,
      clientId: row.client_id,
      clientName: row.client_name ?? undefined,
      clientLogoUri: row.logo_uri ?? undefined,
      scopes: row.scope.split(' '),
      selectedScopes: row.selected_scopes ? JSON.parse(row.selected_scopes) : undefined,
      grantedAt: row.granted_at,
      expiresAt: row.expires_at ?? undefined,
      policyVersions:
        row.privacy_policy_version || row.tos_version
          ? {
              privacyPolicyVersion: row.privacy_policy_version ?? undefined,
              tosVersion: row.tos_version ?? undefined,
              consentVersion: row.consent_version ?? 1,
            }
          : undefined,
    }));

    return c.json({
      userId,
      consents,
      total: consents.length,
    });
  } catch (error) {
    logSanitizedError('Admin user consents list error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to list user consents',
      },
      500
    );
  }
}

/**
 * DELETE /api/admin/users/:userId/consents/:clientId
 * Revoke consent for a specific user and client (admin action)
 */
export async function adminUserConsentRevokeHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('userId')!;
    const clientId = c.req.param('clientId')!;

    if (!userId || !clientId) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'User ID and Client ID are required',
        },
        400
      );
    }

    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    // Check if consent exists
    const existingConsent = await authCtx.coreAdapter.query<{
      id: string;
      scope: string;
    }>(
      `SELECT id, scope FROM oauth_client_consents
       WHERE tenant_id = ? AND user_id = ? AND client_id = ?`,
      [tenantId, userId, clientId]
    );

    if (existingConsent.length === 0) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Consent not found',
        },
        404
      );
    }

    const consent = existingConsent[0];
    const previousScopes = consent.scope.split(' ');
    const now = Date.now();

    // Delete consent
    await authCtx.coreAdapter.execute(
      'DELETE FROM oauth_client_consents WHERE tenant_id = ? AND user_id = ? AND client_id = ?',
      [tenantId, userId, clientId]
    );

    // Record in consent history
    const historyId = crypto.randomUUID();
    await authCtx.coreAdapter.execute(
      `INSERT INTO consent_history (id, tenant_id, user_id, client_id, action, scopes_before, scopes_after, created_at)
       VALUES (?, ?, ?, ?, 'revoked', ?, NULL, ?)`,
      [historyId, tenantId, userId, clientId, JSON.stringify(previousScopes), now]
    );

    // Invalidate consent cache
    await invalidateConsentCache(c.env, userId, tenantId, clientId);

    const log = getLogger(c).module('ADMIN');
    // Add to revocation list
    try {
      const revocationKey = `consent_revoked:${userId}:${clientId}`;
      const revocationTTL = 86400 * 90;
      await revokeToken(c.env, revocationKey, revocationTTL, undefined, tenantId);
    } catch (error) {
      log.warn('Token revocation warning', { action: 'token_revocation', userId, clientId });
    }

    // Publish consent.revoked event
    publishEvent(c, {
      type: CONSENT_EVENTS.REVOKED,
      tenantId,
      data: {
        userId,
        clientId,
        scopes: previousScopes,
        previousScopes,
        revocationReason: 'admin_action',
        initiatedBy: 'admin',
      } satisfies ExtendedConsentEventData,
    }).catch((err) => {
      log.error(
        'Failed to publish consent.revoked event',
        { action: 'publish_event' },
        err as Error
      );
    });

    log.info('Revoked consent', { action: 'consent_revoke', userId, clientId });

    await createAuditLogFromContext(c, 'consent.revoked', 'user', userId, {
      client_id: clientId,
      scopes: previousScopes,
    });
    scheduleAdminAuditLog(c, 'user.consent_revoked', userId, 'success', {
      client_id: clientId,
      scopes: previousScopes,
    });

    return c.json({
      success: true,
      userId,
      clientId,
      revokedAt: now,
    });
  } catch (error) {
    logSanitizedError('Admin user consent revoke error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to revoke consent',
      },
      500
    );
  }
}

// =============================================================================
// Phase 2: Client Usage Statistics
// =============================================================================

/**
 * GET /api/admin/clients/:id/usage
 * Get usage statistics for a specific client (API calls, rate limits, bandwidth)
 */
export async function adminClientUsageHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const clientId = c.req.param('id')!;

  if (!clientId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  // Parse date range (optional, defaults to last 30 days)
  const fromParam = c.req.query('from');
  const toParam = c.req.query('to');

  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 days ago

  const from = fromParam ? new Date(fromParam) : defaultFrom;
  const to = toParam ? new Date(toParam) : now;

  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'date', reason: 'Invalid date format. Use ISO 8601.' },
    });
  }

  const fromTs = Math.floor(from.getTime() / 1000);
  const toTs = Math.floor(to.getTime() / 1000);

  try {
    const hotQuery = await getAuditHotQuerySupport(c.env, tenantId);
    if (!hotQuery.supported || !hotQuery.context) {
      return createAuditHotQueryUnsupportedResponse(c, hotQuery);
    }
    const { tableName, actionColumn, detailsColumn } = getAuditHotQuerySqlSpec(hotQuery.context);
    const auditAdapter = hotQuery.context.adapter;
    const coreAdapter = getCoreAdapter(c, tenantId);
    const clientClause =
      hotQuery.context.mode === 'legacy'
        ? `((resource_type = 'client' AND resource_id = ?) OR ${getAuditJsonTextExpr(detailsColumn, 'client_id', hotQuery.context.dialect)} = ? OR ${getAuditJsonTextExpr(detailsColumn, 'clientId', hotQuery.context.dialect)} = ?)`
        : `(client_id = ? OR ${getAuditJsonTextExpr(detailsColumn, 'client_id', hotQuery.context.dialect)} = ? OR ${getAuditJsonTextExpr(detailsColumn, 'clientId', hotQuery.context.dialect)} = ? OR (${getAuditJsonTextExpr(detailsColumn, 'resourceType', hotQuery.context.dialect)} = 'client' AND ${getAuditJsonTextExpr(detailsColumn, 'resourceId', hotQuery.context.dialect)} = ?))`;
    const clientBindings =
      hotQuery.context.mode === 'legacy'
        ? [clientId, clientId, clientId]
        : [clientId, clientId, clientId, clientId];

    // Verify client exists and belongs to tenant using KV cache (with D1 fallback)
    const client = await getClient(c.env, tenantId, clientId, coreAdapter);

    if (!client || client.tenant_id !== tenantId) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'client', id: clientId },
      });
    }

    // Calculate time boundaries for 24h, 7d, 30d
    const nowTs = Math.floor(now.getTime() / 1000);
    const ts24h = nowTs - 24 * 60 * 60;
    const ts7d = nowTs - 7 * 24 * 60 * 60;
    const ts30d = nowTs - 30 * 24 * 60 * 60;

    // Query token issuance statistics from audit_log
    // Frontend expects: tokens_issued_24h, tokens_issued_7d, tokens_issued_30d, active_sessions, last_token_issued_at
    const [tokenStats, activeSessionsResult, lastTokenResult] = await Promise.all([
      // Token issuance counts for 24h, 7d, 30d
      auditAdapter.queryOne<{
        tokens_24h: number;
        tokens_7d: number;
        tokens_30d: number;
      }>(
        `SELECT
          SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as tokens_24h,
          SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as tokens_7d,
          COUNT(*) as tokens_30d
        FROM ${tableName}
        WHERE tenant_id = ?
          AND ${actionColumn} LIKE 'token.%'
          AND ${clientClause}
          AND created_at >= ?`,
        [
          ...getAuditTimeRange(ts24h, ts24h, hotQuery.context).slice(0, 1),
          ...getAuditTimeRange(ts7d, ts7d, hotQuery.context).slice(0, 1),
          tenantId,
          ...clientBindings,
          ...getAuditTimeRange(ts30d, ts30d, hotQuery.context).slice(0, 1),
        ]
      ),

      // Active sessions count (sessions that haven't expired)
      coreAdapter.queryOne<{ active_sessions: number }>(
        `SELECT COUNT(DISTINCT sc.session_id) as active_sessions
          FROM session_clients sc
           JOIN sessions s ON s.id = sc.session_id
          WHERE sc.client_id = ? AND sc.tenant_id = ? AND s.tenant_id = ? AND s.expires_at > ?`,
        [clientId, tenantId, tenantId, nowTs]
      ),

      // Last token issued timestamp
      auditAdapter.queryOne<{ last_token_at: number | null }>(
        `SELECT MAX(created_at) as last_token_at
        FROM ${tableName}
        WHERE tenant_id = ?
          AND ${actionColumn} LIKE 'token.%'
          AND ${clientClause}`,
        [tenantId, ...clientBindings]
      ),
    ]);

    // Return in the format expected by frontend (ClientUsage interface)
    return c.json({
      tokens_issued_24h: tokenStats?.tokens_24h ?? 0,
      tokens_issued_7d: tokenStats?.tokens_7d ?? 0,
      tokens_issued_30d: tokenStats?.tokens_30d ?? 0,
      active_sessions: activeSessionsResult?.active_sessions ?? 0,
      last_token_issued_at: lastTokenResult?.last_token_at
        ? hotQuery.context.createdAtUnit === 'milliseconds'
          ? lastTokenResult.last_token_at
          : lastTokenResult.last_token_at * 1000
        : null,
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN');
    log.error('Failed to get client usage statistics', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// =============================================================================
// Phase 3: User Activity Log
// =============================================================================

/**
 * GET /api/admin/users/:id/activity-log
 * Get user activity history from audit logs
 */
export async function adminUserActivityLogHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const userId = c.req.param('id')!;

  if (!userId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  // Parse pagination
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10), 100);
  const cursor = c.req.query('cursor');

  // Parse filters
  const actionFilter = c.req.query('action'); // e.g., 'auth.login', 'token.*'
  const fromParam = c.req.query('from');
  const toParam = c.req.query('to');

  try {
    const hotQuery = await getAuditHotQuerySupport(c.env, tenantId);
    if (!hotQuery.supported || !hotQuery.context) {
      return createAuditHotQueryUnsupportedResponse(c, hotQuery);
    }
    const context = hotQuery.context;
    const { tableName, actionColumn, detailsColumn } = getAuditHotQuerySqlSpec(context);
    const coreAdapter = getCoreAdapter(c, tenantId);
    const auditAdapter = context.adapter;

    if (!(await findCanonicalRuntimeUser(c, tenantId, userId, { includeInactive: true }))) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'user', id: userId },
      });
    }

    let subjectFilterClause = '';
    let subjectBindings: (string | number)[] = [];
    if (context.mode === 'legacy') {
      subjectFilterClause = 'AND user_id = ?';
      subjectBindings = [userId];
    } else {
      const anonymizedUserId = await resolveAuditUserAnonymizedId(c, tenantId, userId);
      if (!anonymizedUserId) {
        return c.json({
          data: [],
          pagination: {
            has_more: false,
            next_cursor: undefined,
          },
        });
      }
      subjectFilterClause = 'AND anonymized_user_id = ?';
      subjectBindings = [anonymizedUserId];
    }

    // Build query
    let query = `
      SELECT id, ${actionColumn} as action, ${detailsColumn} as details, created_at
      ${context.mode === 'legacy' ? ', ip_address, user_agent' : ', result, severity, error_code, error_message, client_id, session_id, request_id'}
      FROM ${tableName}
      WHERE tenant_id = ?
        ${subjectFilterClause}
    `;
    const bindings: (string | number)[] = [tenantId, ...subjectBindings];

    // Apply action filter
    if (actionFilter) {
      if (actionFilter.includes('*')) {
        query += ` AND ${actionColumn} LIKE ?`;
        bindings.push(actionFilter.replace(/\*/g, '%'));
      } else {
        query += ` AND ${actionColumn} = ?`;
        bindings.push(actionFilter);
      }
    }

    // Apply date filters
    if (fromParam) {
      const fromTs = buildAuditTimestamp(fromParam);
      if (fromTs != null) {
        query += ' AND created_at >= ?';
        bindings.push(context.createdAtUnit === 'milliseconds' ? fromTs * 1000 : fromTs);
      }
    }
    if (toParam) {
      const toTs = buildAuditTimestamp(toParam);
      if (toTs != null) {
        query += ' AND created_at <= ?';
        bindings.push(context.createdAtUnit === 'milliseconds' ? toTs * 1000 : toTs);
      }
    }

    // Apply cursor (created_at based)
    if (cursor) {
      try {
        const decoded = JSON.parse(atob(cursor)) as { created_at: number; id: string };
        query += ' AND (created_at < ? OR (created_at = ? AND id < ?))';
        bindings.push(decoded.created_at, decoded.created_at, decoded.id);
      } catch {
        // Invalid cursor, ignore
      }
    }

    query += ' ORDER BY created_at DESC, id DESC LIMIT ?';
    bindings.push(limit + 1);

    const activities = await auditAdapter.query<{
      id: string;
      action: string;
      details: string | null;
      created_at: number;
      ip_address?: string | null;
      user_agent?: string | null;
      result?: string | null;
      severity?: string | null;
      error_code?: string | null;
      error_message?: string | null;
      client_id?: string | null;
      session_id?: string | null;
      request_id?: string | null;
    }>(query, bindings);

    const hasMore = activities.length > limit;
    const data = hasMore ? activities.slice(0, limit) : activities;

    // Format response
    const formattedData = data.map((row) => ({
      id: row.id,
      action: row.action,
      details: (() => {
        const parsed = row.details ? JSON.parse(row.details) : null;
        if (context.mode === 'legacy') {
          return parsed;
        }
        return {
          ...(parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : parsed
              ? { value: parsed }
              : {}),
          result: row.result ?? null,
          severity: row.severity ?? null,
          error_code: row.error_code ?? null,
          error_message: row.error_message ?? null,
          client_id: row.client_id ?? null,
          session_id: row.session_id ?? null,
          request_id: row.request_id ?? null,
        };
      })(),
      timestamp: fromStoredAuditTimestamp(row.created_at, context),
      ip_address: row.ip_address ?? null,
      user_agent: row.user_agent ?? null,
    }));

    // Generate next cursor
    let nextCursor: string | undefined;
    if (hasMore && data.length > 0) {
      const lastItem = data[data.length - 1];
      nextCursor = btoa(JSON.stringify({ created_at: lastItem.created_at, id: lastItem.id }));
    }

    return c.json({
      data: formattedData,
      pagination: {
        has_more: hasMore,
        next_cursor: nextCursor,
      },
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN');
    log.error('Failed to get user activity log', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// =============================================================================
// Phase 3: Send Email to User
// =============================================================================

/**
 * POST /api/admin/users/:id/send-email
 * Send an email to a user (password reset, notification, etc.)
 */
export async function adminUserSendEmailHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const userId = c.req.param('id')!;

  if (!userId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  try {
    const body = await c.req.json<{
      template: string;
      subject?: string;
      variables?: Record<string, string>;
    }>();

    // Validate template
    const allowedTemplates = [
      'password_reset',
      'welcome',
      'verification',
      'notification',
      'security_alert',
      'account_locked',
      'account_suspended',
    ];

    if (!body.template || !allowedTemplates.includes(body.template)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'template',
          reason: `Must be one of: ${allowedTemplates.join(', ')}`,
        },
      });
    }

    const authCtx = createAuthContextFromHono(c, tenantId);

    const runtimeUser = await findCanonicalRuntimeUser(c, tenantId, userId, {
      includeInactive: true,
    });
    if (!runtimeUser) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'user', id: userId },
      });
    }

    const userEmail = runtimeUser.email;

    if (!userEmail) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'user', reason: 'User does not have an email address' },
      });
    }

    // Create email job (queued for async processing)
    const emailJobId = crypto.randomUUID();
    const nowTs = Math.floor(Date.now() / 1000);

    await authCtx.coreAdapter.execute(
      `INSERT INTO email_queue (
        id, tenant_id, user_id, template, subject, variables, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        emailJobId,
        tenantId,
        userId,
        body.template,
        body.subject ?? null,
        body.variables ? JSON.stringify(body.variables) : null,
        'pending',
        nowTs,
      ]
    );

    // Write audit log
    await createAuditLogFromContext(c, 'email.queued', 'user', userId, {
      template: body.template,
      email_job_id: emailJobId,
    });

    return c.json({
      success: true,
      email_job_id: emailJobId,
      user_id: userId,
      template: body.template,
      status: 'queued',
      created_at: new Date(nowTs * 1000).toISOString(),
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN');
    log.error('Failed to queue email', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
