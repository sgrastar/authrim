/**
 * Audit Log Utility
 *
 * This module provides utilities for creating audit log entries to track
 * admin operations for compliance and security monitoring.
 *
 * Key features:
 * - Non-blocking: Failures don't stop the main operation
 * - Severity levels: info, warning, critical
 * - Critical operations logged to console for immediate visibility
 */

import type { Context } from 'hono';
import type { Env } from '../types/env';
import type { AuditLogEntry } from '../types/admin';
import { generateSecureRandomString } from './crypto';
import type { DatabaseAdapter } from '../db/adapter';
import { createLogger } from './logger';
import {
  auditTargetFromBackendConfig,
  buildAuditStorageConfigFromProfile,
  createExternalAuditStorageAdapter,
  createAuditService,
  resolveAuditPersistenceSourcesFromEnv,
  resolveLegacyAuditLogAdapterFromEnv,
  type EventCategory,
  type EventSeverity,
  type IAuditService,
  type IAuditStorageAdapter,
  normalizeAuditStorageRoutingTargets,
  resolveAuditRoutingTargets,
  type AuditStorageRoutingRule,
} from '../services/audit';
import { resolveTenantRuntimeProfilesFromEnv } from '../services/runtime-profile-resolver';
import type { AuditProfile, AuditTarget } from '../types/runtime-profile';

const log = createLogger().module('AUDIT_LOG');
const unifiedAuditServiceCache = new WeakMap<object, IAuditService>();
const KV_KEY_ROUTING_RULES = 'audit_routing_rules';

function requireAuditTenantId(tenantId: string | undefined, action: string): string | null {
  const normalized = tenantId?.trim();
  if (!normalized) {
    log.error('Cannot create audit log: tenantId is required', { action });
    return null;
  }
  return normalized;
}

export interface LegacyAuditLogWriteInput {
  id: string;
  tenantId: string;
  userId?: string | null;
  action: string;
  resource: string;
  resourceId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata: string;
  severity: AuditLogEntry['severity'];
  createdAt: number;
}

function createNoopAuditBucket(): R2Bucket {
  return {
    async put() {
      throw new Error('audit_archive_bucket_not_configured');
    },
    async get() {
      return null;
    },
    async head() {
      return null;
    },
    async delete() {},
    async list() {
      return {
        objects: [],
        truncated: false,
      };
    },
    async createMultipartUpload() {
      throw new Error('audit_archive_bucket_not_configured');
    },
    async resumeMultipartUpload() {
      throw new Error('audit_archive_bucket_not_configured');
    },
  } as unknown as R2Bucket;
}

function getUnifiedAuditService(env: Env): IAuditService {
  const cacheKey = env as unknown as object;
  const cached = unifiedAuditServiceCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const primaryAdapterCache = new Map<string, IAuditStorageAdapter | null>();
  const sources = resolveAuditPersistenceSourcesFromEnv(env);

  const service = createAuditService({
    coreSource: sources.coreSource,
    piiSource: sources.piiSource,
    r2Bucket: env.DIAGNOSTIC_LOGS ?? createNoopAuditBucket(),
    auditQueue: env.AUDIT_QUEUE,
    configKv: env.AUTHRIM_CONFIG,
    logger: log.module('UNIFIED-MIRROR'),
    resolveAuditProfile: async (tenantId: string): Promise<AuditProfile> => {
      const resolved = await resolveTenantRuntimeProfilesFromEnv(env, tenantId);
      return resolved.auditProfile;
    },
    resolveDeliveryPlan: async (input) => resolveAuditDeliveryPlanFromEnv(env, input),
    resolvePrimaryAdapter: async (
      target: AuditTarget,
      logType: 'event' | 'pii'
    ): Promise<IAuditStorageAdapter | null> => {
      const cacheKey = JSON.stringify({ target, logType });
      if (primaryAdapterCache.has(cacheKey)) {
        return primaryAdapterCache.get(cacheKey) ?? null;
      }

      const adapter = createExternalAuditStorageAdapter(
        env as unknown as Record<string, unknown>,
        target,
        logType
      );
      if (!adapter) {
        primaryAdapterCache.set(cacheKey, null);
        return null;
      }
      primaryAdapterCache.set(cacheKey, adapter);
      return adapter;
    },
  });

  unifiedAuditServiceCache.set(cacheKey, service);
  return service;
}

function mapLegacySeverity(severity: AuditLogEntry['severity']): EventSeverity {
  if (severity === 'warning') {
    return 'warn';
  }
  return severity;
}

// Legacy audit actions are loosely structured, so use a heuristic based on
// action prefix first and resource second to keep event_category stable enough
// for filtering without forcing a breaking rename of all existing actions.
function mapLegacyAuditCategory(action: string, resource: string): EventCategory {
  const prefix = action.split(/[._]/)[0];

  if (prefix === 'auth' || prefix === 'login' || prefix === 'logout' || prefix === 'passkey') {
    return 'auth';
  }
  if (prefix === 'token' || resource === 'token') {
    return 'token';
  }
  if (prefix === 'consent' || resource === 'consent') {
    return 'consent';
  }
  if (prefix === 'user' || resource === 'user') {
    return 'user';
  }
  if (prefix === 'client' || resource === 'client') {
    return 'client';
  }
  if (prefix === 'admin' || resource === 'admin') {
    return 'admin';
  }
  if (
    prefix === 'security' ||
    resource === 'signing_keys' ||
    resource === 'rate_limit' ||
    resource === 'ip_allowlist'
  ) {
    return 'security';
  }
  if (prefix === 'system' || resource === 'system') {
    return 'system';
  }
  return 'audit';
}

function parseLegacyMetadata(metadata: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(metadata) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Keep raw metadata as-is when it is not valid JSON.
  }

  return { raw_metadata: metadata };
}

function getRequestIdFromContext(c: Context<{ Bindings: Env }>): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contextRequestId = (c as any).get?.('requestId');
  if (typeof contextRequestId === 'string' && contextRequestId.length > 0) {
    return contextRequestId;
  }

  return c.req.header('X-Request-Id') || c.req.header('X-Correlation-Id') || undefined;
}

function getAdminProxyMetadataFromContext(
  c: Context<{ Bindings: Env }>
): Record<string, unknown> {
  const requestId = getRequestIdFromContext(c);
  const apiMode = c.req.header('X-Authrim-Admin-UI-Api-Mode');
  const forwardedHost =
    c.req.header('X-Authrim-Forwarded-Host') || c.req.header('X-Forwarded-Host');
  const forwardedProto = c.req.header('X-Forwarded-Proto');
  const proxyRequestId = c.req.header('X-Request-Id');
  const correlationId = c.req.header('X-Correlation-Id');

  if (
    !requestId &&
    !apiMode &&
    !forwardedHost &&
    !forwardedProto &&
    !proxyRequestId &&
    !correlationId
  ) {
    return {};
  }

  return {
    request_id: requestId ?? undefined,
    admin_ui_api_mode: apiMode ?? undefined,
    admin_ui_bff_forwarded_host: forwardedHost ?? undefined,
    admin_ui_bff_forwarded_proto: forwardedProto ?? undefined,
    admin_ui_bff_request_id: proxyRequestId ?? undefined,
    admin_ui_bff_correlation_id: correlationId ?? undefined,
  };
}

function parseStoredAuditRoutingRules(value: string | null): AuditStorageRoutingRule[] {
  if (!value) {
    return [];
  }

  const parsed = JSON.parse(value) as Array<AuditStorageRoutingRule & { backend?: string }>;
  return parsed.map((rule) => ({
    ...rule,
    conditions: rule.conditions ?? {},
    targets: normalizeAuditStorageRoutingTargets(rule.targets, rule.backend),
  }));
}

function pushUniqueTarget(
  targets: AuditProfile['sinks'],
  target: AuditProfile['sinks'][number] | null | undefined
): void {
  if (!target) {
    return;
  }

  const key = JSON.stringify(target);
  if (targets.some((existing) => JSON.stringify(existing) === key)) {
    return;
  }
  targets.push(target);
}

async function resolveAuditDeliveryPlanFromEnv(
  env: Env,
  input: {
    tenantId: string;
    logType: 'event' | 'pii';
    eventCategory?: EventCategory;
    clientId?: string;
    auditProfile: AuditProfile;
  }
) {
  if (!env.AUTHRIM_CONFIG) {
    return null;
  }

  let routingRules: AuditStorageRoutingRule[] = [];

  try {
    const routingValue = await env.AUTHRIM_CONFIG.get(KV_KEY_ROUTING_RULES);
    routingRules = parseStoredAuditRoutingRules(routingValue);
  } catch {
    return null;
  }

  const storageConfig = buildAuditStorageConfigFromProfile(input.auditProfile, {
    routingRules,
  });
  const resolved = resolveAuditRoutingTargets(storageConfig, {
    tenantId: input.tenantId,
    logType: input.logType,
    clientId: input.clientId,
    eventCategory: input.eventCategory,
  });
  const backendById = new Map(storageConfig.backends.map((backend) => [backend.id, backend]));
  const primaryBackend = backendById.get(resolved.primaryStore);
  const primary = primaryBackend
    ? auditTargetFromBackendConfig(primaryBackend)
    : (input.auditProfile.primary ?? null);
  const archives: AuditProfile['sinks'] = [];
  const sinks: AuditProfile['sinks'] = [];

  pushUniqueTarget(archives, input.auditProfile.archive ?? undefined);
  for (const archiveId of resolved.archiveStores) {
    const archiveBackend = backendById.get(archiveId);
    if (!archiveBackend) {
      continue;
    }
    const archiveTarget = auditTargetFromBackendConfig(archiveBackend);
    if (archiveTarget?.type === 'r2') {
      pushUniqueTarget(archives, archiveTarget);
    }
  }

  for (const sink of input.auditProfile.sinks) {
    pushUniqueTarget(sinks, sink);
  }
  for (const sinkId of resolved.forwardingSinks) {
    const sinkBackend = backendById.get(sinkId);
    if (!sinkBackend) {
      continue;
    }
    const sinkTarget = auditTargetFromBackendConfig(sinkBackend);
    if (sinkTarget?.type === 'logpush' || sinkTarget?.type === 'firehose') {
      pushUniqueTarget(sinks, sinkTarget);
    }
  }

  return {
    auditProfileId: input.auditProfile.id,
    primary,
    archives,
    sinks,
    retentionDays:
      input.logType === 'event'
        ? resolved.retention.eventLogRetentionDays
        : resolved.retention.piiLogRetentionDays,
    archiveFailureMode: input.auditProfile.archiveFailureMode,
    sinkFailureMode: input.auditProfile.sinkFailureMode,
    matchedRuleNames: resolved.matchedRuleNames,
  };
}

async function mirrorLegacyAuditLogToUnifiedService(
  env: Env,
  entry: Omit<AuditLogEntry, 'id' | 'createdAt'> & { tenantId: string }
): Promise<void> {
  const tenantId = requireAuditTenantId(entry.tenantId, entry.action);
  if (!tenantId) {
    return;
  }
  const metadata = parseLegacyMetadata(entry.metadata);
  const auditService = getUnifiedAuditService(env);

  await auditService.logEvent(tenantId, {
    eventType: entry.action,
    eventCategory: mapLegacyAuditCategory(entry.action, entry.resource),
    result: 'success',
    severity: mapLegacySeverity(entry.severity),
    details: {
      source: 'legacy_audit_log',
      resourceType: entry.resource,
      resourceId: entry.resourceId,
      ...metadata,
    },
  });
}

export async function writeLegacyAuditLog(
  adapter: DatabaseAdapter,
  entry: LegacyAuditLogWriteInput
): Promise<void> {
  await adapter.execute(
    `INSERT INTO audit_log (
      id, tenant_id, user_id, action, resource_type, resource_id,
      ip_address, user_agent, metadata_json, severity, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.id,
      entry.tenantId,
      entry.userId ?? null,
      entry.action,
      entry.resource,
      entry.resourceId ?? null,
      entry.ipAddress ?? null,
      entry.userAgent ?? null,
      entry.metadata,
      entry.severity,
      entry.createdAt,
    ]
  );
}

/**
 * Create an audit log entry in the database
 *
 * This function is non-blocking - if the audit log creation fails,
 * it will log the error but not throw, allowing the main operation to continue.
 *
 * @param env - Cloudflare Workers environment bindings
 * @param entry - Audit log entry data (id and createdAt will be generated)
 */
export async function createAuditLog(
  env: Env,
  entry: Omit<AuditLogEntry, 'id' | 'createdAt'> & { tenantId: string }
): Promise<void> {
  const tenantId = requireAuditTenantId(entry.tenantId, entry.action);
  if (!tenantId) {
    return;
  }

  const id = generateSecureRandomString(16);
  // Use seconds (not milliseconds) for consistency with other audit log writers
  const createdAt = Math.floor(Date.now() / 1000);

  try {
    log.info('createAuditLog: Starting INSERT', { id, action: entry.action, tenantId, createdAt });

    const coreAdapter: DatabaseAdapter = resolveLegacyAuditLogAdapterFromEnv(env);
    await writeLegacyAuditLog(coreAdapter, {
      id,
      tenantId,
      userId: entry.userId,
      action: entry.action,
      resource: entry.resource,
      resourceId: entry.resourceId,
      ipAddress: entry.ipAddress,
      userAgent: entry.userAgent,
      metadata: entry.metadata,
      severity: entry.severity,
      createdAt,
    });

    log.info('createAuditLog: INSERT completed successfully', { id, action: entry.action });
  } catch (error) {
    // Non-blocking: log error but don't fail the main operation
    // PII Protection: Don't log entry details (may contain PII in metadata)
    log.error('Failed to create audit log', {}, error as Error);
  }

  try {
    await mirrorLegacyAuditLogToUnifiedService(env, { ...entry, tenantId });
  } catch (error) {
    log.warn('Failed to mirror audit log to unified audit service', {
      action: entry.action,
      tenantId,
    });
    log.error('Unified audit mirror failed', {}, error as Error);
  }

  // Log critical operations to console for immediate visibility
  // PII Protection: Only log safe fields (no metadata which may contain PII)
  if (entry.severity === 'critical') {
    log.warn('CRITICAL AUDIT', {
      tenantId,
      action: entry.action,
      resource: entry.resource,
      resourceId: entry.resourceId,
      // Note: userId and metadata intentionally omitted (may contain PII)
    });
  }
}

/**
 * Helper function to create audit log from Hono context
 *
 * Automatically extracts tenantId, IP address, and user agent from the request.
 * Requires adminAuth context to be set by adminAuthMiddleware.
 * tenantId is obtained from requestContextMiddleware if available.
 *
 * @param c - Hono context
 * @param action - Action performed (e.g., 'signing_keys.rotate.emergency')
 * @param resource - Resource type (e.g., 'signing_keys')
 * @param resourceId - Resource identifier (e.g., kid)
 * @param metadata - Additional metadata object (will be JSON stringified)
 * @param severity - Severity level (default: 'info')
 */
export async function createAuditLogFromContext(
  c: Context<{ Bindings: Env }>,
  action: string,
  resource: string,
  resourceId: string,
  metadata: Record<string, unknown>,
  severity: 'info' | 'warning' | 'critical' = 'info'
): Promise<void> {
  // Debug: Log that we're attempting to create audit log
  log.info('Creating audit log from context', { action, resource, resourceId });

  // Get admin auth context (set by adminAuthMiddleware)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminAuth = (c as any).get('adminAuth') as { userId: string } | undefined;
  if (!adminAuth) {
    log.error('Cannot create audit log: adminAuth context not found', {
      action,
      resource,
      resourceId,
    });
    return;
  }

  log.info('Admin auth found', { userId: adminAuth.userId, action });

  // Get tenantId from request context (set by requestContextMiddleware)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tenantId = requireAuditTenantId((c as any).get('tenantId') as string | undefined, action);
  if (!tenantId) {
    return;
  }

  // Extract IP address (check CF headers first, then fallback)
  const ipAddress =
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    c.req.header('X-Real-IP') ||
    'unknown';

  // Extract user agent
  const userAgent = c.req.header('User-Agent') || 'unknown';
  const auditMetadata = {
    ...metadata,
    ...getAdminProxyMetadataFromContext(c),
  };

  await createAuditLog(c.env, {
    tenantId,
    userId: adminAuth.userId,
    action,
    resource,
    resourceId,
    ipAddress,
    userAgent,
    metadata: JSON.stringify(auditMetadata),
    severity,
  });
}

/**
 * Safely schedule audit log creation with waitUntil
 *
 * Handles cases where executionCtx may be undefined (tests, local dev, Node runtime).
 * This ensures audit logs are written even after the response is sent,
 * without blocking the main request handling.
 *
 * @param executionCtx - Cloudflare Workers execution context (may be undefined in tests)
 * @param auditLogPromise - Promise that creates the audit log entry
 */
export function scheduleAuditLog(
  executionCtx: ExecutionContext | undefined,
  auditLogPromise: Promise<void>
): void {
  if (executionCtx) {
    executionCtx.waitUntil(auditLogPromise);
  }
  // If no executionCtx, the promise runs but may be cut off after response
  // This is acceptable for test environments where D1 writes are mocked
}

/**
 * Helper to create and schedule audit log from Hono context
 *
 * Combines createAuditLogFromContext with waitUntil scheduling.
 * This is the recommended way to create audit logs in admin handlers
 * as it ensures the log is written even after the response is sent.
 *
 * Note: This function is designed for future policy engine integration.
 * The scheduling logic can be extended to include policy checks before logging.
 *
 * @param c - Hono context with Cloudflare Workers bindings
 * @param action - Action performed (e.g., 'user.created', 'client.deleted')
 * @param resource - Resource type (e.g., 'user', 'client', 'session')
 * @param resourceId - Resource identifier
 * @param metadata - Additional metadata object (will be JSON stringified)
 * @param severity - Severity level (default: 'info')
 */
export function scheduleAuditLogFromContext(
  c: Context<{ Bindings: Env }>,
  action: string,
  resource: string,
  resourceId: string,
  metadata: Record<string, unknown>,
  severity: 'info' | 'warning' | 'critical' = 'info'
): void {
  const promise = createAuditLogFromContext(
    c,
    action,
    resource,
    resourceId,
    metadata,
    severity
  ).catch((err: unknown) => {
    log.error('Failed to create audit log', { action }, err as Error);
  });

  scheduleAuditLog(c.executionCtx, promise);
}
