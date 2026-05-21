import { LOG_PLANES, LOG_TYPES, type LogPlane, type LogType } from '@authrim/ar-lib-logging';
import type { LoggingDestination } from '@authrim/ar-lib-logging/destinations';
import {
  RuntimeLoggingPolicySnapshotMemoryCache,
  loadPublishedRuntimeLoggingPolicySnapshot,
  resolveLoggingPolicy,
  type LoggingFallbackMode,
  type LoggingFallbackPolicy,
  type LoggingPolicyAssignment,
  type LoggingPolicyLane,
  type LoggingPolicyScopeType,
  type ResolvedLoggingPolicy,
} from '@authrim/ar-lib-logging/policies';
import type { Env } from '../types/env';

const RUNTIME_LOGGING_POLICY_CACHE_TTL_MS = 60_000;

export interface RuntimeLoggingPolicySnapshotPayload {
  assignments: unknown[];
  fallbacks: unknown[];
  destinations: unknown[];
}

export type RuntimeLoggingDestinationTarget =
  | {
      type: 'r2';
      destinationId: string;
      bucketRef: string;
      prefix?: string;
    }
  | {
      type: 'http';
      destinationId: string;
      url?: string;
      urlRef?: string;
      method: 'POST';
      headers?: Record<string, string>;
      format: 'json';
    }
  | {
      type: 'logpush';
      destinationId: string;
      destinationRef: string;
      dataset?: string;
    }
  | {
      type: 'firehose';
      destinationId: string;
      streamRef: string;
    }
  | {
      type: 'analytics_engine';
      destinationId: string;
      dataset: string;
    }
  | {
      type: 'external';
      destinationId: string;
      connector: string;
      config?: Record<string, unknown>;
    };

export interface RuntimeLoggingPolicyResolution {
  tenantId: string;
  logType: LogType;
  plane: LogPlane;
  lane: LoggingPolicyLane;
  selectedDestinationId: string | null;
  destinationId: string | null;
  fallbackDestinationId: string | null;
  failureMode: LoggingFallbackMode;
  source: ResolvedLoggingPolicy['source'];
  warnings: string[];
  destination: LoggingDestination | null;
  target: RuntimeLoggingDestinationTarget | null;
}

const runtimeLoggingPolicySnapshotCache =
  new RuntimeLoggingPolicySnapshotMemoryCache<RuntimeLoggingPolicySnapshotPayload>({
    ttlMs: RUNTIME_LOGGING_POLICY_CACHE_TTL_MS,
  });

const runtimeLoggingPolicySnapshotCacheNamespaces = new WeakMap<object, string>();
const runtimeLoggingPolicySnapshotMissCache = new WeakMap<object, Map<string, number>>();
let runtimeLoggingPolicySnapshotCacheNamespaceCounter = 0;

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
  return typeof value === 'string' && (LOG_TYPES as readonly string[]).includes(value)
    ? (value as LogType)
    : null;
}

function readSnapshotLogPlane(value: unknown): LogPlane | null {
  return typeof value === 'string' && (LOG_PLANES as readonly string[]).includes(value)
    ? (value as LogPlane)
    : null;
}

function readSnapshotScopeType(value: unknown): LoggingPolicyScopeType {
  return value === 'tenant' ? 'tenant' : 'platform';
}

function readSnapshotLane(value: unknown, fallback: LoggingPolicyLane): LoggingPolicyLane {
  return value === 'critical' || value === 'default' || value === 'bulk' ? value : fallback;
}

function readSnapshotFallbackMode(value: unknown): LoggingFallbackMode {
  return value === 'retry_then_platform_default' ||
    value === 'retry_then_dlq' ||
    value === 'drop_non_critical'
    ? value
    : 'platform_default';
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
    failureMode: readSnapshotFallbackMode(raw.failure_mode),
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

function stringRecord(value: unknown): Record<string, string> | undefined {
  const raw = snapshotObject(value);
  const entries = Object.entries(raw).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function targetFromRuntimeLoggingDestination(
  destination: LoggingDestination,
  plane: LogPlane
): RuntimeLoggingDestinationTarget | null {
  const config = destination.providerConfig;
  if (destination.provider === 'r2') {
    return {
      type: 'r2',
      destinationId: destination.id,
      bucketRef:
        snapshotString(config.bindingRef) ??
        snapshotString(config.bucketRef) ??
        (plane === 'sensitive_detail' ? 'SENSITIVE_DETAILS' : 'DIAGNOSTIC_LOGS'),
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
  if (destination.provider === 'analytics_engine') {
    const dataset = snapshotString(config.dataset);
    return dataset ? { type: 'analytics_engine', destinationId: destination.id, dataset } : null;
  }
  if (destination.provider === 'external') {
    const connector = snapshotString(config.connector);
    return connector
      ? {
          type: 'external',
          destinationId: destination.id,
          connector,
          config: parseSnapshotJsonObject(config.config),
        }
      : null;
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

function findSelectedDestinationId(input: {
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

export async function loadRuntimeLoggingPolicySnapshotFromEnv(
  env: Pick<Env, 'AUTHRIM_CONFIG' | 'DIAGNOSTIC_LOGS'>,
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

export async function resolveRuntimeLoggingPolicyTargetFromEnv(
  env: Pick<Env, 'AUTHRIM_CONFIG' | 'DIAGNOSTIC_LOGS'>,
  input: {
    tenantId: string;
    logType: LogType;
    plane: LogPlane;
    region?: string | null;
  }
): Promise<RuntimeLoggingPolicyResolution | null> {
  const policies = await loadRuntimeLoggingPolicySnapshotFromEnv(env, input.tenantId);
  if (!policies) {
    return null;
  }

  const assignments = policies.assignments.map(mapSnapshotAssignment).filter(isPresent);
  const fallbacks = policies.fallbacks.map(mapSnapshotFallback).filter(isPresent);
  const destinations = policies.destinations.map(mapSnapshotDestination).filter(isPresent);
  const selectedDestinationId = findSelectedDestinationId({
    assignments,
    tenantId: input.tenantId,
    logType: input.logType,
    plane: input.plane,
  });
  const resolved = resolveLoggingPolicy({
    tenantId: input.tenantId,
    logType: input.logType,
    plane: input.plane,
    region: input.region,
    assignments,
    fallbackPolicies: fallbacks,
    destinations,
  });
  const destinationId = resolved.destinationId ?? resolved.fallbackDestinationId;
  const destination = destinations.find((item) => item.id === destinationId) ?? null;
  return {
    ...resolved,
    selectedDestinationId,
    destination,
    target: destination ? targetFromRuntimeLoggingDestination(destination, input.plane) : null,
  };
}
