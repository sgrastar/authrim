import { Context } from 'hono';
import { readLogProtectedDetail } from './log-read-adapter';
import { LogQueryIncompleteError } from './log-archive-query';
import {
  type DatabaseAdapter,
  getTenantIdFromContext,
  getLogger,
  createLogger,
  AdminAuditLogRepository,
  type AdminAuthContext,
  requireAdminDatabaseAdapter,
  runTenantBackupCoveredEffect,
} from '@authrim/ar-lib-core';
import type { Env } from '@authrim/ar-lib-core';

export interface ImageTypeInfo {
  mimeType: string;
  extension: string;
}

/**
 * The CSV user import columns that carry identity assurance. They are evidence, never custom
 * attributes, so no custom attribute may be created or renamed to one of these names.
 */
export const ASSURANCE_IMPORT_COLUMNS: readonly string[] = ['ial', 'ial_verified_at'];

export const ADMIN_USER_CREATE_RESERVED_FIELDS = new Set([
  'email',
  'name',
  'given_name',
  'family_name',
  'nickname',
  'preferred_username',
  'picture',
  'email_verified',
  'phone_number',
  'phone_number_verified',
  'user_type',
]);

export const ADMIN_USER_UPDATE_RESERVED_FIELDS = new Set([
  'email',
  'name',
  'given_name',
  'family_name',
  'nickname',
  'preferred_username',
  'email_verified',
  'phone_number',
  'phone_number_verified',
  'picture',
  'user_type',
]);

export const VALID_USER_LIFECYCLE_STATES = new Set([
  'invited',
  'pending_verification',
  'provisioning',
  'incomplete',
  'active',
  'dormant',
  'archived',
  'deprovisioned',
]);

export function extractCustomClaimInput(
  body: Record<string, string | boolean | number | null | undefined>,
  reservedFields: Set<string>
): Record<string, unknown> {
  const customFields: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(body)) {
    if (reservedFields.has(key)) {
      continue;
    }
    customFields[key] = value;
  }

  return customFields;
}

/**
 * Detect image type from file content using Magic Bytes.
 * Returns null if not a recognized image format.
 */
export function detectImageType(data: Uint8Array): ImageTypeInfo | null {
  if (data.length < 12) return null;

  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }

  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return { mimeType: 'image/png', extension: 'png' };
  }

  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) {
    return { mimeType: 'image/gif', extension: 'gif' };
  }

  if (
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return { mimeType: 'image/webp', extension: 'webp' };
  }

  return null;
}

function getAdminAdapter(c: Context<any, any, any>): DatabaseAdapter {
  return requireAdminDatabaseAdapter(c.env, 'admin-shared');
}

interface AdminAuditDetailPayload {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

function getRequestIdForAdminAudit(c: Context<any, any, any>): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contextRequestId = (c as any).get?.('requestId');
  if (typeof contextRequestId === 'string' && contextRequestId.length > 0) {
    return contextRequestId;
  }

  return c.req.header('X-Request-Id') || c.req.header('X-Correlation-Id') || undefined;
}

function getAdminProxyAuditMetadata(c: Context<any, any, any>): Record<string, unknown> {
  const apiMode = c.req.header('X-Authrim-Admin-UI-Api-Mode');
  const forwardedHost =
    c.req.header('X-Authrim-Forwarded-Host') || c.req.header('X-Forwarded-Host');
  const forwardedProto = c.req.header('X-Forwarded-Proto');
  const proxyRequestId = c.req.header('X-Request-Id');
  const correlationId = c.req.header('X-Correlation-Id');

  if (!apiMode && !forwardedHost && !forwardedProto && !proxyRequestId && !correlationId) {
    return {};
  }

  return {
    admin_ui_api_mode: apiMode ?? undefined,
    admin_ui_bff_forwarded_host: forwardedHost ?? undefined,
    admin_ui_bff_forwarded_proto: forwardedProto ?? undefined,
    admin_ui_bff_request_id: proxyRequestId ?? undefined,
    admin_ui_bff_correlation_id: correlationId ?? undefined,
  };
}

export function getAdminActorAuditMetadata(
  adminAuth: AdminAuthContext | undefined
): Record<string, unknown> {
  if (!adminAuth) {
    return {
      admin_actor_type: 'system',
      admin_actor_id: 'system',
      admin_auth_method: 'none',
    };
  }

  if (adminAuth.authMethod === 'machine_access_token') {
    return {
      admin_actor_type: 'machine',
      admin_actor_id: adminAuth.actorId ?? adminAuth.userId,
      admin_auth_method: 'machine_access_token',
      admin_machine_principal_id: adminAuth.actorId ?? adminAuth.userId,
      admin_machine_principal_type: adminAuth.principalType,
      admin_machine_credential_id: adminAuth.credentialId,
      admin_machine_client_id: adminAuth.clientId,
      admin_machine_client_auth_method: adminAuth.clientAuthMethod,
      admin_machine_credential_strength: adminAuth.credentialStrength,
      admin_machine_sender_constrained: adminAuth.senderConstrained,
    };
  }

  if (adminAuth.actorType === 'agent') {
    return {
      admin_actor_type: 'agent',
      admin_actor_id: adminAuth.actorId ?? adminAuth.userId,
      admin_auth_method: adminAuth.authMethod,
      admin_delegator_id: adminAuth.userId,
      admin_agent_client_id: adminAuth.clientId,
      admin_agent_mode: adminAuth.agentMode,
      admin_agent_assurance: adminAuth.agentAssurance,
      admin_agent_grant_id: adminAuth.agentGrantId,
      admin_agent_grant_generation: adminAuth.agentGrantGeneration,
      admin_agent_consent_version: adminAuth.agentConsentVersion,
      admin_agent_source_token_jti: adminAuth.sourceTokenJti,
      admin_agent_correlation_id: adminAuth.correlationId,
    };
  }

  const actorMetadata: Record<string, unknown> = {
    admin_actor_type: 'admin_user',
    admin_actor_id: adminAuth.actorId ?? adminAuth.userId,
    admin_auth_method: adminAuth.authMethod,
  };

  if (adminAuth.transportAuth) {
    actorMetadata.admin_transport_actor_type = adminAuth.transportAuth.actorType;
    actorMetadata.admin_transport_actor_id = adminAuth.transportAuth.actorId;
    actorMetadata.admin_transport_principal_type = adminAuth.transportAuth.principalType;
    actorMetadata.admin_transport_credential_id = adminAuth.transportAuth.credentialId;
    actorMetadata.admin_transport_client_id = adminAuth.transportAuth.clientId;
    actorMetadata.admin_transport_auth_method = adminAuth.transportAuth.authMethod;
    actorMetadata.admin_transport_client_auth_method = adminAuth.transportAuth.clientAuthMethod;
  }

  return actorMetadata;
}

export async function loadAdminAuditDetail(
  c: Context<any, any, any>,
  tenantId: string,
  eventId: string
): Promise<AdminAuditDetailPayload | null> {
  const detail = await readLogProtectedDetail(c.env as Env, {
    tenantId,
    sourceDataset: 'admin.admin_audit_log',
    eventId,
  });
  if (!detail) return null;
  const decode = (value: unknown): Record<string, unknown> | null => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') throw new LogQueryIncompleteError();
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new LogQueryIncompleteError();
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new LogQueryIncompleteError();
    return parsed as Record<string, unknown>;
  };
  return {
    before: decode(detail.before_json),
    after: decode(detail.after_json),
    metadata: decode(detail.metadata_json),
  };
}

export async function writeAdminAuditLog(
  c: Context<any, any, any>,
  input: {
    action: string;
    resourceType: string;
    resourceId: string | null;
    result: 'success' | 'failure';
    severity?: 'debug' | 'info' | 'warn' | 'error' | 'critical';
    metadata?: Record<string, unknown>;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  }
): Promise<string | null> {
  try {
    const adminAdapter = getAdminAdapter(c);
    const auditRepo = new AdminAuditLogRepository(adminAdapter, c.env as Env);
    const tenantId = getTenantIdFromContext(c);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminAuth = (c as any).get?.('adminAuth') as AdminAuthContext | undefined;

    const ipAddress =
      c.req.header('CF-Connecting-IP') ||
      c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
      'unknown';
    const userAgent = c.req.header('User-Agent') || 'unknown';
    const createdAt = Date.now();
    const auditLogId = crypto.randomUUID();
    const requestId = getRequestIdForAdminAudit(c);
    const actorMetadata = getAdminActorAuditMetadata(adminAuth);
    const inlineAuditMetadata = {
      ...getAdminProxyAuditMetadata(c),
      ...actorMetadata,
    };
    const metadata = {
      ...(input.metadata ?? {}),
      ...inlineAuditMetadata,
    };
    await auditRepo.createAuditLog({
      id: auditLogId,
      tenant_id: tenantId,
      admin_user_id:
        adminAuth?.authMethod === 'machine_access_token'
          ? undefined
          : adminAuth?.userId || 'system',
      admin_email:
        adminAuth?.authMethod === 'machine_access_token'
          ? undefined
          : (adminAuth?.email ?? undefined),
      action: input.action,
      resource_type: input.resourceType,
      resource_id: input.resourceId ?? undefined,
      result: input.result,
      severity: input.severity ?? (input.result === 'failure' ? 'warn' : 'info'),
      ip_address: ipAddress,
      user_agent: userAgent,
      request_id: requestId,
      session_id: adminAuth?.sessionId ?? undefined,
      before: input.before,
      after: input.after,
      metadata,
      inline_metadata: inlineAuditMetadata,
      created_at: createdAt,
    });
    return auditLogId;
  } catch (error) {
    const log = getLogger(c).module('ADMIN');
    log.error('Failed to create admin audit log', { action: input.action }, error as Error);
    return null;
  }
}

export function scheduleAdminAuditLog(
  c: Context<any, any, any>,
  action: string,
  resourceId: string | null,
  result: 'success' | 'failure',
  metadata?: Record<string, unknown>
): void {
  const resourceType = action.startsWith('client.') ? 'client' : 'user';
  const promise = runTenantBackupCoveredEffect(c.env, { environment: true }, () =>
    writeAdminAuditLog(c, {
      action,
      resourceType,
      resourceId,
      result,
      metadata,
    })
  );
  c.executionCtx?.waitUntil(promise);
}

/**
 * Sanitize error for logging. Kept for backward compatibility with the existing
 * admin module until all handlers are fully moved to structured logger calls.
 */
export function logSanitizedError(context: string, error: unknown): void {
  const log = createLogger().module('ADMIN');
  if (error instanceof Error) {
    log.error(context, { type: error.name }, error);
  } else {
    log.error(`${context}: Unknown error type`, {});
  }
}

export function parseClientStringArray(value: unknown, fallback: string[] = []): string[] {
  let current: unknown = value;

  for (let i = 0; i < 3; i++) {
    if (typeof current !== 'string') {
      break;
    }

    const trimmed = current.trim();
    if (!trimmed) {
      return fallback;
    }

    if (
      !(
        (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
        (trimmed.startsWith('"') && trimmed.endsWith('"'))
      )
    ) {
      break;
    }

    try {
      current = JSON.parse(trimmed);
    } catch {
      break;
    }
  }

  if (Array.isArray(current)) {
    if (current.every((item) => typeof item === 'string' && item.length === 1)) {
      return parseClientStringArray(current.join(''), fallback);
    }

    return current
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  if (typeof current === 'string') {
    const trimmed = current.trim();
    if (!trimmed) {
      return fallback;
    }

    if (trimmed.includes(',')) {
      return trimmed
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }

    return [trimmed];
  }

  return fallback;
}

export function isCharArrayLike(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string' && item.length === 1)
  );
}

export function getErrorDetailsForResponse(error: unknown, env: Env): { details?: string } {
  const isDevelopment = env.ENVIRONMENT !== 'production' && env.NODE_ENV !== 'production';
  if (isDevelopment) {
    return {
      details: error instanceof Error ? error.message : String(error),
    };
  }
  return {};
}

export function toMilliseconds(timestamp: number | null | undefined): number | null {
  if (!timestamp) return null;
  const absolute = Math.abs(timestamp);
  if (absolute < 100_000_000_000) return timestamp * 1000;
  if (absolute < 100_000_000_000_000) return timestamp;
  if (absolute < 100_000_000_000_000_000) return timestamp / 1000;
  return timestamp / 1_000_000;
}

export function toSeconds(timestamp: number | null | undefined): number | null {
  if (!timestamp) return null;
  if (timestamp >= 1e12) {
    return Math.floor(timestamp / 1000);
  }
  return timestamp;
}
