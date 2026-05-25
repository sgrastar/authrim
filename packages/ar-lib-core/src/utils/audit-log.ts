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
  resolveAuditEventFailureBehavior,
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
import {
  RuntimeLoggingPolicySnapshotMemoryCache,
  loadPublishedRuntimeLoggingPolicySnapshot,
  resolveLoggingPolicy,
  type LoggingFallbackPolicy,
  type LoggingPolicyAssignment,
  type LoggingPolicyLane,
  type LoggingPolicyScopeType,
  type ResolvedLoggingPolicy,
} from '@authrim/ar-lib-logging/policies';
import type { LoggingDestination } from '@authrim/ar-lib-logging/destinations';
import type { LogPlane, LogType } from '@authrim/ar-lib-logging';

const log = createLogger().module('AUDIT_LOG');
const unifiedAuditServiceCache = new WeakMap<object, IAuditService>();
const KV_KEY_ROUTING_RULES = 'audit_routing_rules';
const RUNTIME_LOGGING_POLICY_CACHE_TTL_MS = 60_000;
const runtimeLoggingPolicySnapshotCache =
  new RuntimeLoggingPolicySnapshotMemoryCache<RuntimeLoggingPolicySnapshotPayload>({
    ttlMs: RUNTIME_LOGGING_POLICY_CACHE_TTL_MS,
    maxEntries: 256,
  });
let runtimeLoggingPolicySnapshotCacheNamespaceCounter = 0;
const runtimeLoggingPolicySnapshotCacheNamespaces = new WeakMap<object, string>();
const runtimeLoggingPolicySnapshotMissCache = new WeakMap<object, Map<string, number>>();
const auditRoutingRulesCache = new WeakMap<
  KVNamespace,
  { rules: AuditStorageRoutingRule[]; expiresAt: number }
>();

export class AuditLogDeliveryError extends Error {
  constructor(
    message: string,
    readonly action: string,
    readonly tenantId: string
  ) {
    super(message);
    this.name = 'AuditLogDeliveryError';
  }
}

function requireAuditTenantId(tenantId: string | undefined, action: string): string | null {
  const normalized = tenantId?.trim();
  if (!normalized) {
    log.error('Cannot create audit log: tenantId is required', { action });
    return null;
  }
  return normalized;
}

function isFailClosedAuditAction(action: string): boolean {
  return resolveAuditEventFailureBehavior(action).behavior === 'fail_closed_or_strong_retry';
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
    r2Bucket: env.AUDIT_ARCHIVE ?? createNoopAuditBucket(),
    sensitiveDetailBucket: env.SENSITIVE_DETAILS,
    objectEncryptionRootKey: env.OBJECT_ENCRYPTION_ROOT_KEY,
    objectEncryptionKeyVersion: Number.parseInt(env.OBJECT_ENCRYPTION_KEY_VERSION || '1', 10) || 1,
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

async function resolveLegacyAuditLogPolicy(
  env: Env,
  tenantId: string,
  action: string
): Promise<{
  writeLegacyD1: boolean;
  backpressureMode: NonNullable<AuditProfile['backpressure']>['mode'];
}> {
  try {
    const resolved = await resolveTenantRuntimeProfilesFromEnv(env, tenantId);
    const primary = resolved.auditProfile.primary;

    if (!primary) {
      return {
        writeLegacyD1: false,
        backpressureMode: resolved.auditProfile.backpressure?.mode ?? 'event_class',
      };
    }

    return {
      writeLegacyD1: primary.type === 'd1',
      backpressureMode: resolved.auditProfile.backpressure?.mode ?? 'event_class',
    };
  } catch (error) {
    log.warn('Failed to resolve audit profile for legacy audit write; keeping D1 write enabled', {
      action,
      tenantId,
    });
    log.error('Audit profile resolution failed', {}, error as Error);
    return { writeLegacyD1: true, backpressureMode: 'event_class' };
  }
}

function getRequestIdFromContext(c: Context<{ Bindings: Env }>): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contextRequestId = (c as any).get?.('requestId');
  if (typeof contextRequestId === 'string' && contextRequestId.length > 0) {
    return contextRequestId;
  }

  return c.req.header('X-Request-Id') || c.req.header('X-Correlation-Id') || undefined;
}

function getAdminProxyMetadataFromContext(c: Context<{ Bindings: Env }>): Record<string, unknown> {
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

interface RuntimeLoggingPolicySnapshotPayload {
  assignments: unknown[];
  fallbacks: unknown[];
  destinations: unknown[];
}

function snapshotObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function snapshotString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function snapshotNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function snapshotBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value === 1;
  }
  if (typeof value === 'string') {
    if (value === 'true' || value === '1') {
      return true;
    }
    if (value === 'false' || value === '0') {
      return false;
    }
  }
  return fallback;
}

function parseSnapshotJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || !value.trim()) {
    return {};
  }
  try {
    return snapshotObject(JSON.parse(value));
  } catch {
    return {};
  }
}

function parseSnapshotStringArray(value: unknown): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value || '[]') : value;
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  const strings = parsed.filter((item): item is string => typeof item === 'string' && !!item);
  return strings.length > 0 ? strings : undefined;
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function readSnapshotLogType(value: unknown): LogType | null {
  return typeof value === 'string' && ['audit', 'pii'].includes(value) ? (value as LogType) : null;
}

function readSnapshotLogPlane(value: unknown): LogPlane | null {
  return typeof value === 'string' && ['archive', 'external_sink'].includes(value)
    ? (value as LogPlane)
    : null;
}

function readSnapshotScopeType(value: unknown): LoggingPolicyScopeType {
  return value === 'tenant' ? 'tenant' : 'platform';
}

function readSnapshotLane(value: unknown, fallback: LoggingPolicyLane): LoggingPolicyLane {
  return value === 'critical' || value === 'default' || value === 'bulk' ? value : fallback;
}

function mapSnapshotAssignment(row: unknown): LoggingPolicyAssignment | null {
  const raw = snapshotObject(row);
  const logType = readSnapshotLogType(raw.log_type);
  const plane = readSnapshotLogPlane(raw.plane);
  const destinationId = snapshotString(raw.destination_id);
  if (!logType || !plane || !destinationId) {
    return null;
  }
  const tenantId = snapshotString(raw.tenant_id);
  return {
    id: snapshotString(raw.id) ?? `${tenantId ?? 'platform'}:${logType}:${plane}`,
    tenantId,
    logType,
    plane,
    destinationId,
    enabled: snapshotBoolean(raw.enabled, true),
    managedBy: readSnapshotScopeType(raw.managed_by),
    lane: readSnapshotLane(raw.lane, plane === 'archive' ? 'critical' : 'default'),
    version: snapshotNumber(raw.version, 1),
  };
}

function mapSnapshotFallback(row: unknown): LoggingFallbackPolicy | null {
  const raw = snapshotObject(row);
  const logType = readSnapshotLogType(raw.log_type);
  const plane = readSnapshotLogPlane(raw.plane);
  if (!logType || !plane) {
    return null;
  }
  return {
    id: snapshotString(raw.id) ?? `${raw.scope_type ?? 'platform'}:${raw.scope_id ?? 'global'}`,
    scopeType: readSnapshotScopeType(raw.scope_type),
    scopeId: snapshotString(raw.scope_id) ?? 'global',
    logType,
    plane,
    fallbackDestinationId: snapshotString(raw.fallback_destination_id),
    failureMode:
      raw.failure_mode === 'retry_then_platform_default' ||
      raw.failure_mode === 'retry_then_dlq' ||
      raw.failure_mode === 'drop_non_critical'
        ? raw.failure_mode
        : 'platform_default',
    version: snapshotNumber(raw.version, 1),
  };
}

function mapSnapshotDestination(row: unknown): LoggingDestination | null {
  const raw = snapshotObject(row);
  const id = snapshotString(raw.id);
  const provider = snapshotString(raw.provider) as LoggingDestination['provider'] | null;
  const destinationKind = snapshotString(raw.destination_kind) as
    | LoggingDestination['destinationKind']
    | null;
  if (!id || !provider || !destinationKind) {
    return null;
  }
  return {
    id,
    scopeType:
      raw.scope_type === 'tenant' || raw.scope_type === 'shared' ? raw.scope_type : 'platform',
    scopeId: snapshotString(raw.scope_id),
    destinationKind,
    provider,
    name: snapshotString(raw.name) ?? id,
    displayName: snapshotString(raw.display_name) ?? snapshotString(raw.name) ?? id,
    lifecycleStatus: raw.lifecycle_status === 'disabled' ? 'disabled' : 'active',
    healthStatus:
      raw.health_status === 'healthy' ||
      raw.health_status === 'configured' ||
      raw.health_status === 'degraded' ||
      raw.health_status === 'failing' ||
      raw.health_status === 'unreachable'
        ? raw.health_status
        : 'unknown',
    providerConfig: parseSnapshotJsonObject(raw.provider_config),
    capabilityPolicy: {
      allowedTenantIds: parseSnapshotStringArray(raw.allowed_tenant_ids),
      allowedLogTypes: parseSnapshotStringArray(raw.allowed_log_types),
      allowedPlanes: parseSnapshotStringArray(raw.allowed_planes),
      region: snapshotString(raw.region),
      criticalAllowed: snapshotBoolean(raw.critical_allowed, false),
      defaultFallbackEligible: snapshotBoolean(raw.default_fallback_eligible, false),
      retentionDays:
        raw.retention_days === null || raw.retention_days === undefined
          ? null
          : snapshotNumber(raw.retention_days, 0),
      encryptionMode:
        raw.encryption_mode === 'external_managed' || raw.encryption_mode === 'none'
          ? raw.encryption_mode
          : 'platform_managed',
    },
  };
}

interface AuditTargetPolicyMetadata {
  selectedDestinationId: string | null;
  effectiveDestinationId: string | null;
  fallbackDestinationId: string | null;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  failureMode: string | null;
  policySource: string | null;
  policyWarnings: string[];
}

function findSelectedSnapshotDestinationId(input: {
  assignments: LoggingPolicyAssignment[];
  tenantId: string;
  logType: LogType;
  plane: LogPlane;
}): string | null {
  const tenantAssignment = input.assignments.find(
    (assignment) =>
      assignment.enabled &&
      assignment.tenantId === input.tenantId &&
      assignment.logType === input.logType &&
      assignment.plane === input.plane
  );
  if (tenantAssignment) {
    return tenantAssignment.destinationId;
  }

  return (
    input.assignments.find(
      (assignment) =>
        assignment.enabled &&
        assignment.tenantId === null &&
        assignment.logType === input.logType &&
        assignment.plane === input.plane
    )?.destinationId ?? null
  );
}

function auditTargetPolicyMetadata(input: {
  selectedDestinationId: string | null;
  resolved: ResolvedLoggingPolicy;
}): AuditTargetPolicyMetadata {
  const effectiveDestinationId =
    input.resolved.destinationId ?? input.resolved.fallbackDestinationId;
  const fallbackUsed =
    !!input.resolved.fallbackDestinationId &&
    input.resolved.fallbackDestinationId === effectiveDestinationId &&
    input.selectedDestinationId !== input.resolved.fallbackDestinationId;
  return {
    selectedDestinationId: input.selectedDestinationId,
    effectiveDestinationId,
    fallbackDestinationId: fallbackUsed ? input.resolved.fallbackDestinationId : null,
    fallbackUsed,
    fallbackReason: fallbackUsed
      ? input.resolved.warnings.includes('destination_unusable')
        ? 'destination_unusable'
        : 'no_primary_destination'
      : null,
    failureMode: input.resolved.failureMode,
    policySource: input.resolved.source,
    policyWarnings: input.resolved.warnings,
  };
}

function withAuditTargetPolicyMetadata(
  target: AuditTarget,
  metadata: AuditTargetPolicyMetadata
): AuditTarget {
  return {
    ...target,
    loggingPolicy: metadata,
  } as unknown as AuditTarget;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  const raw = snapshotObject(value);
  const entries = Object.entries(raw).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function targetFromLoggingDestination(
  destination: LoggingDestination,
  plane: LogPlane
): AuditTarget | null {
  const config = destination.providerConfig;
  if (destination.provider === 'r2') {
    return {
      type: 'r2',
      destinationId: destination.id,
      bucketRef:
        snapshotString(config.bindingRef) ??
        snapshotString(config.bucketRef) ??
        (plane === 'archive' ? 'AUDIT_ARCHIVE' : 'SENSITIVE_DETAILS'),
      prefix: snapshotString(config.prefix) ?? undefined,
    };
  }
  if (destination.provider === 'http') {
    const url = snapshotString(config.url);
    const urlRef = snapshotString(config.urlRef);
    if (!url && !urlRef) {
      return null;
    }
    return {
      type: 'http',
      destinationId: destination.id,
      url: url ?? undefined,
      urlRef: urlRef ?? undefined,
      method: 'POST',
      headers: stringRecord(config.headers),
      format: 'json',
    };
  }
  if (destination.provider === 'logpush') {
    const destinationRef =
      snapshotString(config.destinationRef) ?? snapshotString(config.destinationConf);
    if (!destinationRef) {
      return null;
    }
    return {
      type: 'logpush',
      destinationId: destination.id,
      destinationRef,
      dataset: snapshotString(config.dataset) ?? undefined,
    };
  }
  if (destination.provider === 'firehose') {
    const streamRef = snapshotString(config.streamRef) ?? snapshotString(config.streamArn);
    return streamRef ? { type: 'firehose', destinationId: destination.id, streamRef } : null;
  }
  return null;
}

function getRuntimeLoggingPolicySnapshotCacheNamespace(configKv: KVNamespace): string {
  const cacheKey = configKv as unknown as object;
  const cached = runtimeLoggingPolicySnapshotCacheNamespaces.get(cacheKey);
  if (cached) {
    return cached;
  }
  const namespace = `kv${++runtimeLoggingPolicySnapshotCacheNamespaceCounter}`;
  runtimeLoggingPolicySnapshotCacheNamespaces.set(cacheKey, namespace);
  return namespace;
}

function getRuntimeLoggingPolicySnapshotMisses(configKv: KVNamespace): Map<string, number> {
  const cacheKey = configKv as unknown as object;
  const cached = runtimeLoggingPolicySnapshotMissCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const misses = new Map<string, number>();
  runtimeLoggingPolicySnapshotMissCache.set(cacheKey, misses);
  return misses;
}

async function loadRuntimeLoggingPolicySnapshot(
  env: Env,
  tenantId: string
): Promise<RuntimeLoggingPolicySnapshotPayload | null> {
  if (!env.AUTHRIM_CONFIG) {
    return null;
  }
  const configKv = env.AUTHRIM_CONFIG;
  const cacheNamespace = getRuntimeLoggingPolicySnapshotCacheNamespace(configKv);
  const misses = getRuntimeLoggingPolicySnapshotMisses(configKv);
  const loadSnapshot = async (scopeType: LoggingPolicyScopeType, scopeId: string) => {
    const now = Date.now();
    const cacheScopeId = `${cacheNamespace}:${scopeId}`;
    const missKey = `${scopeType}:${cacheScopeId}`;
    const missExpiresAt = misses.get(missKey);
    if (missExpiresAt && missExpiresAt > now) {
      return null;
    }
    if (missExpiresAt) {
      misses.delete(missKey);
    }
    const snapshot = await runtimeLoggingPolicySnapshotCache.getOrLoad({
      scopeType,
      scopeId: cacheScopeId,
      now,
      loader: () =>
        loadPublishedRuntimeLoggingPolicySnapshot<RuntimeLoggingPolicySnapshotPayload>({
          scopeType,
          scopeId,
          kv: configKv,
          objectStore: env.DIAGNOSTIC_LOGS,
        }),
    });
    if (snapshot) {
      misses.delete(missKey);
    } else {
      misses.set(missKey, now + RUNTIME_LOGGING_POLICY_CACHE_TTL_MS);
    }
    return snapshot;
  };
  const tenantSnapshot = await loadSnapshot('tenant', tenantId);
  const snapshot = tenantSnapshot ?? (await loadSnapshot('platform', 'global'));
  return snapshot?.policies ?? null;
}

async function resolveSnapshotAuditDeliveryPlanFromEnv(
  env: Env,
  input: {
    tenantId: string;
    logType: 'event' | 'pii';
    eventCategory?: EventCategory;
    clientId?: string;
    auditProfile: AuditProfile;
  }
) {
  const policies = await loadRuntimeLoggingPolicySnapshot(env, input.tenantId);
  if (!policies) {
    return null;
  }

  const logType: LogType = input.logType === 'pii' ? 'pii' : 'audit';
  const assignments = policies.assignments.map(mapSnapshotAssignment).filter(isPresent);
  const fallbacks = policies.fallbacks.map(mapSnapshotFallback).filter(isPresent);
  const destinations = policies.destinations.map(mapSnapshotDestination).filter(isPresent);
  const resolveTarget = (plane: LogPlane): AuditTarget | null => {
    const selectedDestinationId = findSelectedSnapshotDestinationId({
      assignments,
      tenantId: input.tenantId,
      logType,
      plane,
    });
    const resolved = resolveLoggingPolicy({
      tenantId: input.tenantId,
      logType,
      plane,
      assignments,
      fallbackPolicies: fallbacks,
      destinations,
    });
    const destinationId = resolved.destinationId ?? resolved.fallbackDestinationId;
    const destination = destinations.find((item) => item.id === destinationId);
    const target = destination ? targetFromLoggingDestination(destination, plane) : null;
    return target
      ? withAuditTargetPolicyMetadata(
          target,
          auditTargetPolicyMetadata({
            selectedDestinationId,
            resolved,
          })
        )
      : null;
  };
  const archive = resolveTarget('archive');
  const sink = resolveTarget('external_sink');
  if (!archive && !sink) {
    return null;
  }

  return {
    auditProfileId: input.auditProfile.id,
    primary: input.auditProfile.primary ?? null,
    archives: archive ? [archive] : [],
    sinks: sink ? [sink] : [],
    retentionDays:
      input.logType === 'event'
        ? input.auditProfile.retention?.eventLogRetentionDays
        : input.auditProfile.retention?.piiLogRetentionDays,
    archiveFailureMode: input.auditProfile.archiveFailureMode,
    sinkFailureMode: input.auditProfile.sinkFailureMode,
    matchedRuleNames: ['logging_policy_snapshot'],
  };
}

async function getCachedAuditRoutingRules(kv: KVNamespace): Promise<AuditStorageRoutingRule[]> {
  const now = Date.now();
  const cached = auditRoutingRulesCache.get(kv);
  if (cached && cached.expiresAt > now) {
    return cached.rules;
  }
  const routingValue = await kv.get(KV_KEY_ROUTING_RULES);
  const rules = parseStoredAuditRoutingRules(routingValue);
  auditRoutingRulesCache.set(kv, {
    rules,
    expiresAt: now + RUNTIME_LOGGING_POLICY_CACHE_TTL_MS,
  });
  return rules;
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
  const snapshotPlan = await resolveSnapshotAuditDeliveryPlanFromEnv(env, input);
  if (snapshotPlan) {
    return snapshotPlan;
  }

  if (!env.AUTHRIM_CONFIG) {
    return null;
  }

  let routingRules: AuditStorageRoutingRule[] = [];

  try {
    routingRules = await getCachedAuditRoutingRules(env.AUTHRIM_CONFIG);
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
    if (isFailClosedAuditAction(entry.action)) {
      throw new AuditLogDeliveryError('audit_log_tenant_id_required', entry.action, 'unknown');
    }
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
  let failureBehavior: ReturnType<typeof resolveAuditEventFailureBehavior>['behavior'] =
    'fail_closed_or_strong_retry';
  let legacyD1WasPrimary = true;

  try {
    const legacyPolicy = await resolveLegacyAuditLogPolicy(env, tenantId, entry.action);
    legacyD1WasPrimary = legacyPolicy.writeLegacyD1;
    const classification = resolveAuditEventFailureBehavior(
      entry.action,
      legacyPolicy.backpressureMode
    );
    failureBehavior = classification.behavior;

    if (!legacyPolicy.writeLegacyD1) {
      log.debug('Skipping legacy D1 audit_log write for non-D1 audit profile', {
        action: entry.action,
        tenantId,
        auditCategory: classification.category,
        auditFailureBehavior: classification.behavior,
      });
    } else {
      log.info('createAuditLog: Starting INSERT', {
        id,
        action: entry.action,
        tenantId,
        createdAt,
        auditCategory: classification.category,
        auditFailureBehavior: classification.behavior,
      });

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
    }
  } catch (error) {
    // PII Protection: Don't log entry details (may contain PII in metadata)
    log.error('Failed to create audit log', {}, error as Error);
    if (failureBehavior === 'fail_closed_or_strong_retry') {
      throw new AuditLogDeliveryError('audit_log_write_failed', entry.action, tenantId);
    }
  }

  try {
    await mirrorLegacyAuditLogToUnifiedService(env, { ...entry, tenantId });
  } catch (error) {
    log.warn('Failed to mirror audit log to unified audit service', {
      action: entry.action,
      tenantId,
    });
    log.error('Unified audit mirror failed', {}, error as Error);
    if (failureBehavior === 'fail_closed_or_strong_retry' && !legacyD1WasPrimary) {
      throw new AuditLogDeliveryError('audit_log_unified_mirror_failed', entry.action, tenantId);
    }
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
    if (isFailClosedAuditAction(action)) {
      throw new AuditLogDeliveryError('audit_log_admin_auth_required', action, 'unknown');
    }
    return;
  }

  log.info('Admin auth found', { userId: adminAuth.userId, action });

  // Get tenantId from request context (set by requestContextMiddleware)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tenantId = requireAuditTenantId((c as any).get('tenantId') as string | undefined, action);
  if (!tenantId) {
    if (isFailClosedAuditAction(action)) {
      throw new AuditLogDeliveryError('audit_log_tenant_id_required', action, 'unknown');
    }
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
