import { Context } from 'hono';
import {
  type DatabaseAdapter,
  getTenantIdFromContext,
  getLogger,
  createLogger,
  AdminAuditLogRepository,
  type AdminAuthContext,
  requireAdminDatabaseAdapter,
} from '@authrim/ar-lib-core';
import type { Env } from '@authrim/ar-lib-core';
import {
  loadChunkedSensitiveDetailJson,
  storeChunkedSensitiveDetailJson,
} from '@authrim/ar-lib-core/services/sensitive-detail-chunk-store';
import {
  generatePublicArtifactId,
  getObjectCatalogObjectRecordByPublicArtifactId,
  type ObjectClass,
} from '@authrim/ar-lib-core/services/object-catalog';
import { createLoggingTenantKeyResolverFromSource } from './logging-tenant-key';

export interface ImageTypeInfo {
  mimeType: string;
  extension: string;
}

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

const ADMIN_AUDIT_DETAIL_CONTENT_TYPE = 'application/json';
const DEFAULT_OBJECT_KEY_VERSION = 1;

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

function getAdminActorAuditMetadata(
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

function getObjectEncryptionKeyVersion(env: Env): number {
  const parsed = Number.parseInt(env.OBJECT_ENCRYPTION_KEY_VERSION ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_OBJECT_KEY_VERSION;
}

async function storeAdminAuditDetail(
  c: Context<any, any, any>,
  adminAdapter: DatabaseAdapter,
  tenantId: string,
  auditLogId: string,
  detail: AdminAuditDetailPayload,
  createdAt: number
): Promise<string | null> {
  if (!c.env.SENSITIVE_DETAILS || !c.env.OBJECT_ENCRYPTION_ROOT_KEY) {
    return null;
  }

  const objectClass: ObjectClass = 'admin_audit_detail';
  const keyVersion = getObjectEncryptionKeyVersion(c.env);
  const tenantKeyResolver = createLoggingTenantKeyResolverFromSource(
    c.env.DB,
    'admin-audit-detail-tenant-key'
  );
  const { catalogId } = await storeChunkedSensitiveDetailJson({
    adapter: adminAdapter,
    bucket: c.env.SENSITIVE_DETAILS,
    rootKeyHex: c.env.OBJECT_ENCRYPTION_ROOT_KEY,
    tenantId,
    objectClass,
    payload: detail,
    contentType: ADMIN_AUDIT_DETAIL_CONTENT_TYPE,
    createdAt,
    keyVersion,
    tenantKeySalt: c.env.LOGGING_TENANT_KEY_SALT,
    ...(tenantKeyResolver ? ({ tenantKeyResolver } as Record<string, unknown>) : {}),
    surface: 'admin_audit',
    queueBindings: c.env as unknown as Record<string, unknown>,
    indexDbBinding: 'DB_ADMIN',
    publicArtifactId: generatePublicArtifactId(),
  });

  return catalogId;
}

export async function loadAdminAuditDetail(
  c: Context<any, any, any>,
  adminAdapter: DatabaseAdapter,
  tenantId: string,
  detailArtifactId: string | null | undefined,
  objectCatalogId?: string | null | undefined
): Promise<AdminAuditDetailPayload | null> {
  if (!c.env.OBJECT_ENCRYPTION_ROOT_KEY) {
    return null;
  }

  const fallbackCatalogId =
    objectCatalogId ??
    (detailArtifactId && !detailArtifactId.startsWith('oa_') ? detailArtifactId : null);

  const resolvedCatalogId = detailArtifactId
    ? ((
        await getObjectCatalogObjectRecordByPublicArtifactId(
          adminAdapter,
          tenantId,
          detailArtifactId,
          'canonical_json',
          0
        )
      )?.logical.id ?? null)
    : null;

  const effectiveCatalogId = resolvedCatalogId ?? fallbackCatalogId;
  const parsed = effectiveCatalogId
    ? await loadChunkedSensitiveDetailJson<Partial<AdminAuditDetailPayload>>(adminAdapter, c.env, {
        tenantId,
        objectCatalogId: effectiveCatalogId,
        expectedClass: 'admin_audit_detail',
      })
    : null;
  if (!parsed) {
    return null;
  }

  return {
    before:
      parsed.before && typeof parsed.before === 'object' && !Array.isArray(parsed.before)
        ? (parsed.before as Record<string, unknown>)
        : null,
    after:
      parsed.after && typeof parsed.after === 'object' && !Array.isArray(parsed.after)
        ? (parsed.after as Record<string, unknown>)
        : null,
    metadata:
      parsed.metadata && typeof parsed.metadata === 'object' && !Array.isArray(parsed.metadata)
        ? (parsed.metadata as Record<string, unknown>)
        : null,
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
    const auditRepo = new AdminAuditLogRepository(adminAdapter);
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
    const detailPayload: AdminAuditDetailPayload = {
      before: input.before ?? null,
      after: input.after ?? null,
      metadata: Object.keys(metadata).length > 0 ? metadata : null,
    };
    const hasExternalizableDetail = !!(
      detailPayload.before ||
      detailPayload.after ||
      detailPayload.metadata
    );
    const detailObjectCatalogId = hasExternalizableDetail
      ? await storeAdminAuditDetail(c, adminAdapter, tenantId, auditLogId, detailPayload, createdAt)
      : null;

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
      before: detailObjectCatalogId ? undefined : (detailPayload.before ?? undefined),
      after: detailObjectCatalogId ? undefined : (detailPayload.after ?? undefined),
      metadata: detailObjectCatalogId ? inlineAuditMetadata : (detailPayload.metadata ?? undefined),
      detail_object_catalog_id: detailObjectCatalogId ?? undefined,
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
  const promise = writeAdminAuditLog(c, {
    action,
    resourceType,
    resourceId,
    result,
    metadata,
  });
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
  if (timestamp < 1e12) {
    return timestamp * 1000;
  }
  return timestamp;
}

export function toSeconds(timestamp: number | null | undefined): number | null {
  if (!timestamp) return null;
  if (timestamp >= 1e12) {
    return Math.floor(timestamp / 1000);
  }
  return timestamp;
}
