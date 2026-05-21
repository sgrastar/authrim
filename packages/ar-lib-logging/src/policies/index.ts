import type { LogPlane, LogType } from '../registry';
import type { LoggingDestination } from '../destinations';
import { isDestinationSelectableForTenant } from '../destinations';
import { createLoggingId } from '../ids';

export interface LoggingPolicyKey {
  tenantId: string;
  logType: LogType;
  plane: LogPlane;
}

export type LoggingPolicyScopeType = 'platform' | 'tenant';

export type LoggingPolicyLane = 'critical' | 'default' | 'bulk';

export type LoggingFallbackMode =
  | 'platform_default'
  | 'retry_then_platform_default'
  | 'retry_then_dlq'
  | 'drop_non_critical';

export interface LoggingPolicyAssignment {
  id: string;
  tenantId: string | null;
  logType: LogType;
  plane: LogPlane;
  destinationId: string;
  enabled: boolean;
  managedBy: LoggingPolicyScopeType;
  lane: LoggingPolicyLane;
  version: number;
}

export interface LoggingFallbackPolicy {
  id: string;
  scopeType: LoggingPolicyScopeType;
  scopeId: string;
  logType: LogType;
  plane: LogPlane;
  fallbackDestinationId: string | null;
  failureMode: LoggingFallbackMode;
  version: number;
}

export interface ResolveLoggingPolicyInput {
  tenantId: string;
  logType: LogType;
  plane: LogPlane;
  region?: string | null;
  assignments: LoggingPolicyAssignment[];
  fallbackPolicies: LoggingFallbackPolicy[];
  destinations: LoggingDestination[];
}

export interface ResolvedLoggingPolicy {
  tenantId: string;
  logType: LogType;
  plane: LogPlane;
  lane: LoggingPolicyLane;
  destinationId: string | null;
  fallbackDestinationId: string | null;
  failureMode: LoggingFallbackMode;
  source: 'tenant_assignment' | 'platform_assignment' | 'none';
  warnings: string[];
}

export interface RuntimeLoggingPolicySnapshot<TPolicy = unknown> {
  snapshotId: string;
  scopeType: LoggingPolicyScopeType;
  scopeId: string;
  version: number;
  policyHash: string;
  synchronizedAt: number;
  sourceUpdatedAt: number;
  expiresAt?: number | null;
  policies: TPolicy;
}

export interface RuntimeLoggingPolicySnapshotPointer {
  schemaVersion: 1;
  scopeType: LoggingPolicyScopeType;
  scopeId: string;
  version: number;
  policyHash: string;
  snapshotId: string;
  objectRef: string | null;
  publishedAt: number;
  expiresAt?: number | null;
}

export interface RuntimeLoggingPolicySnapshotPublication {
  pointer: RuntimeLoggingPolicySnapshotPointer;
  pointerKey?: string;
  snapshotKey?: string;
  objectRef: string | null;
}

export interface RuntimePolicySnapshotKvStore {
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  get(key: string): Promise<string | null>;
}

export interface RuntimePolicySnapshotObjectStore {
  put(
    key: string,
    value: string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    }
  ): Promise<unknown>;
  get?(key: string): Promise<RuntimePolicySnapshotObject | null>;
}

export interface RuntimePolicySnapshotObject {
  readonly size?: number;
  readonly body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

const RUNTIME_POLICY_SNAPSHOT_OBJECT_MAX_BYTES = 1024 * 1024;

async function readRuntimePolicySnapshotObjectText(
  object: RuntimePolicySnapshotObject,
  maxBytes = RUNTIME_POLICY_SNAPSHOT_OBJECT_MAX_BYTES
): Promise<string> {
  if (typeof object.size === 'number' && object.size > maxBytes) {
    throw new Error(`Runtime policy snapshot object exceeds maximum size: ${object.size}`);
  }
  if (!object.body) {
    const text = await object.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error('Runtime policy snapshot object exceeds maximum size');
    }
    return text;
  }

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
        void reader.cancel().catch(() => {});
        throw new Error('Runtime policy snapshot object exceeds maximum size');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export interface RuntimeLoggingPolicySnapshotCacheEntry<TPolicy = unknown> {
  snapshot: RuntimeLoggingPolicySnapshot<TPolicy>;
  cachedAt: number;
  expiresAt: number;
}

export interface RuntimeLoggingPolicySnapshotCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
}

export function laneForLogPolicy(logType: LogType, plane: LogPlane): LoggingPolicyLane {
  if (
    logType === 'audit' ||
    logType === 'admin_audit' ||
    logType === 'security' ||
    logType === 'pii' ||
    plane === 'sensitive_detail'
  ) {
    return 'critical';
  }
  if (logType === 'diagnostic' || (logType === 'normal' && plane === 'external_sink')) {
    return 'bulk';
  }
  return 'default';
}

function findDestination(
  destinations: LoggingDestination[],
  id: string | null
): LoggingDestination | null {
  if (!id) {
    return null;
  }
  return destinations.find((destination) => destination.id === id) ?? null;
}

function findAssignment(
  assignments: LoggingPolicyAssignment[],
  tenantId: string,
  logType: LogType,
  plane: LogPlane
): { assignment: LoggingPolicyAssignment; source: ResolvedLoggingPolicy['source'] } | null {
  const tenantAssignment = assignments.find(
    (assignment) =>
      assignment.enabled &&
      assignment.tenantId === tenantId &&
      assignment.logType === logType &&
      assignment.plane === plane
  );
  if (tenantAssignment) {
    return { assignment: tenantAssignment, source: 'tenant_assignment' };
  }

  const platformAssignment = assignments.find(
    (assignment) =>
      assignment.enabled &&
      assignment.tenantId === null &&
      assignment.logType === logType &&
      assignment.plane === plane
  );
  if (platformAssignment) {
    return { assignment: platformAssignment, source: 'platform_assignment' };
  }
  return null;
}

function findFallbackPolicy(
  fallbackPolicies: LoggingFallbackPolicy[],
  tenantId: string,
  logType: LogType,
  plane: LogPlane
): LoggingFallbackPolicy | null {
  const tenantPolicy = fallbackPolicies.find(
    (policy) =>
      policy.scopeType === 'tenant' &&
      policy.scopeId === tenantId &&
      policy.logType === logType &&
      policy.plane === plane
  );
  if (tenantPolicy) {
    return tenantPolicy;
  }
  return (
    fallbackPolicies.find(
      (policy) =>
        policy.scopeType === 'platform' && policy.logType === logType && policy.plane === plane
    ) ?? null
  );
}

export function resolveLoggingPolicy(input: ResolveLoggingPolicyInput): ResolvedLoggingPolicy {
  const lane = laneForLogPolicy(input.logType, input.plane);
  const critical = lane === 'critical';
  const warnings: string[] = [];
  const selected = findAssignment(input.assignments, input.tenantId, input.logType, input.plane);
  const fallbackPolicy = findFallbackPolicy(
    input.fallbackPolicies,
    input.tenantId,
    input.logType,
    input.plane
  );
  const fallbackDestination = findDestination(
    input.destinations,
    fallbackPolicy?.fallbackDestinationId ?? null
  );
  const fallbackDestinationUsable =
    fallbackDestination &&
    fallbackDestination.capabilityPolicy.defaultFallbackEligible !== false &&
    isDestinationSelectableForTenant({
      destination: fallbackDestination,
      tenantId: input.tenantId,
      logType: input.logType,
      plane: input.plane,
      region: input.region,
      critical,
    });

  if (fallbackPolicy?.fallbackDestinationId && !fallbackDestinationUsable) {
    warnings.push('fallback_destination_unusable');
  }

  if (!selected) {
    return {
      tenantId: input.tenantId,
      logType: input.logType,
      plane: input.plane,
      lane,
      destinationId: null,
      fallbackDestinationId: fallbackDestinationUsable ? fallbackDestination.id : null,
      failureMode: fallbackPolicy?.failureMode ?? 'platform_default',
      source: 'none',
      warnings,
    };
  }

  const destination = findDestination(input.destinations, selected.assignment.destinationId);
  const destinationUsable =
    destination &&
    isDestinationSelectableForTenant({
      destination,
      tenantId: input.tenantId,
      logType: input.logType,
      plane: input.plane,
      region: input.region,
      critical,
    });

  if (!destinationUsable) {
    warnings.push('destination_unusable');
  }

  return {
    tenantId: input.tenantId,
    logType: input.logType,
    plane: input.plane,
    lane,
    destinationId: destinationUsable ? destination.id : null,
    fallbackDestinationId: fallbackDestinationUsable ? fallbackDestination.id : null,
    failureMode: fallbackPolicy?.failureMode ?? 'platform_default',
    source: selected.source,
    warnings,
  };
}

function normalizeForJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForJson(item));
  }
  if (value && typeof value === 'object') {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      normalized[key] = normalizeForJson((value as Record<string, unknown>)[key]);
    }
    return normalized;
  }
  return value;
}

export function stablePolicyJson(value: unknown): string {
  return JSON.stringify(normalizeForJson(value));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function createRuntimeLoggingPolicySnapshot<TPolicy>(input: {
  scopeType: LoggingPolicyScopeType;
  scopeId: string;
  version: number;
  policies: TPolicy;
  synchronizedAt?: number;
  sourceUpdatedAt?: number;
  expiresAt?: number | null;
  snapshotId?: string;
}): Promise<RuntimeLoggingPolicySnapshot<TPolicy>> {
  const synchronizedAt = input.synchronizedAt ?? Date.now();
  const sourceUpdatedAt = input.sourceUpdatedAt ?? synchronizedAt;
  const snapshotId = input.snapshotId ?? createLoggingId('snap', synchronizedAt);
  const hashInput = stablePolicyJson({
    scopeId: input.scopeId,
    scopeType: input.scopeType,
    version: input.version,
    policies: input.policies,
    sourceUpdatedAt,
    expiresAt: input.expiresAt ?? null,
  });

  return {
    snapshotId,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    version: input.version,
    policyHash: await sha256Hex(hashInput),
    synchronizedAt,
    sourceUpdatedAt,
    expiresAt: input.expiresAt ?? null,
    policies: input.policies,
  };
}

function encodeScopeId(scopeId: string): string {
  return encodeURIComponent(scopeId);
}

export function buildRuntimeLoggingPolicySnapshotPointerKey(input: {
  scopeType: LoggingPolicyScopeType;
  scopeId: string;
  prefix?: string;
}): string {
  const prefix = input.prefix ?? 'logging-policy-snapshots/v1';
  return `${prefix}/current/${input.scopeType}/${encodeScopeId(input.scopeId)}.json`;
}

export function buildRuntimeLoggingPolicySnapshotObjectKey(input: {
  snapshot: RuntimeLoggingPolicySnapshot;
  prefix?: string;
}): string {
  const prefix = input.prefix ?? 'logging-policy-snapshots/v1';
  const snapshot = input.snapshot;
  return [
    prefix,
    'snapshots',
    snapshot.scopeType,
    encodeScopeId(snapshot.scopeId),
    `v${snapshot.version}-${snapshot.snapshotId}.json`,
  ].join('/');
}

function kvSnapshotObjectRef(snapshotKey: string): string {
  return `kv://${snapshotKey}`;
}

function ttlForSnapshot(snapshot: RuntimeLoggingPolicySnapshot, now: number): number | undefined {
  if (!snapshot.expiresAt || snapshot.expiresAt <= now) {
    return undefined;
  }
  return Math.max(1, Math.floor((snapshot.expiresAt - now) / 1000));
}

export async function publishRuntimeLoggingPolicySnapshot<TPolicy>(input: {
  snapshot: RuntimeLoggingPolicySnapshot<TPolicy>;
  kv?: RuntimePolicySnapshotKvStore | null;
  objectStore?: RuntimePolicySnapshotObjectStore | null;
  prefix?: string;
  now?: number;
}): Promise<RuntimeLoggingPolicySnapshotPublication> {
  const now = input.now ?? Date.now();
  const snapshotJson = JSON.stringify(input.snapshot);
  const pointerKey = buildRuntimeLoggingPolicySnapshotPointerKey({
    scopeType: input.snapshot.scopeType,
    scopeId: input.snapshot.scopeId,
    prefix: input.prefix,
  });
  const snapshotKey = buildRuntimeLoggingPolicySnapshotObjectKey({
    snapshot: input.snapshot,
    prefix: input.prefix,
  });
  const ttl = ttlForSnapshot(input.snapshot, now);
  let objectRef: string | null = null;

  if (input.objectStore) {
    await input.objectStore.put(snapshotKey, snapshotJson, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        scopeType: input.snapshot.scopeType,
        scopeId: input.snapshot.scopeId,
        snapshotId: input.snapshot.snapshotId,
        version: String(input.snapshot.version),
        policyHash: input.snapshot.policyHash,
      },
    });
    objectRef = snapshotKey;
  } else if (input.kv) {
    await input.kv.put(snapshotKey, snapshotJson, ttl ? { expirationTtl: ttl } : undefined);
    objectRef = kvSnapshotObjectRef(snapshotKey);
  }

  const pointer: RuntimeLoggingPolicySnapshotPointer = {
    schemaVersion: 1,
    scopeType: input.snapshot.scopeType,
    scopeId: input.snapshot.scopeId,
    version: input.snapshot.version,
    policyHash: input.snapshot.policyHash,
    snapshotId: input.snapshot.snapshotId,
    objectRef,
    publishedAt: now,
    expiresAt: input.snapshot.expiresAt ?? null,
  };

  if (input.kv) {
    await input.kv.put(
      pointerKey,
      JSON.stringify(pointer),
      ttl ? { expirationTtl: ttl } : undefined
    );
  }

  return {
    pointer,
    pointerKey: input.kv ? pointerKey : undefined,
    snapshotKey: objectRef ? snapshotKey : undefined,
    objectRef,
  };
}

function parseSnapshotPointer(value: string | null): RuntimeLoggingPolicySnapshotPointer | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const pointer = parsed as Partial<RuntimeLoggingPolicySnapshotPointer>;
    if (
      pointer.schemaVersion !== 1 ||
      (pointer.scopeType !== 'platform' && pointer.scopeType !== 'tenant') ||
      typeof pointer.scopeId !== 'string' ||
      typeof pointer.version !== 'number' ||
      typeof pointer.policyHash !== 'string' ||
      typeof pointer.snapshotId !== 'string'
    ) {
      return null;
    }
    return pointer as RuntimeLoggingPolicySnapshotPointer;
  } catch {
    return null;
  }
}

function parseRuntimeSnapshot<TPolicy>(
  value: string | null
): RuntimeLoggingPolicySnapshot<TPolicy> | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const snapshot = parsed as Partial<RuntimeLoggingPolicySnapshot<TPolicy>>;
    if (
      typeof snapshot.snapshotId !== 'string' ||
      (snapshot.scopeType !== 'platform' && snapshot.scopeType !== 'tenant') ||
      typeof snapshot.scopeId !== 'string' ||
      typeof snapshot.version !== 'number' ||
      typeof snapshot.policyHash !== 'string' ||
      typeof snapshot.synchronizedAt !== 'number' ||
      typeof snapshot.sourceUpdatedAt !== 'number' ||
      snapshot.policies === undefined
    ) {
      return null;
    }
    return snapshot as RuntimeLoggingPolicySnapshot<TPolicy>;
  } catch {
    return null;
  }
}

export async function loadPublishedRuntimeLoggingPolicySnapshot<TPolicy>(input: {
  scopeType: LoggingPolicyScopeType;
  scopeId: string;
  kv: RuntimePolicySnapshotKvStore;
  objectStore?: RuntimePolicySnapshotObjectStore | null;
  prefix?: string;
}): Promise<RuntimeLoggingPolicySnapshot<TPolicy> | null> {
  const pointerKey = buildRuntimeLoggingPolicySnapshotPointerKey(input);
  const pointer = parseSnapshotPointer(await input.kv.get(pointerKey));
  if (!pointer?.objectRef) {
    return null;
  }

  const snapshotObject =
    !pointer.objectRef.startsWith('kv://') && input.objectStore?.get
      ? await input.objectStore.get(pointer.objectRef)
      : null;
  const snapshotJson = pointer.objectRef.startsWith('kv://')
    ? await input.kv.get(pointer.objectRef.slice('kv://'.length))
    : snapshotObject
      ? await readRuntimePolicySnapshotObjectText(snapshotObject).catch(() => null)
      : null;
  const snapshot = parseRuntimeSnapshot<TPolicy>(snapshotJson ?? null);
  if (
    !snapshot ||
    snapshot.snapshotId !== pointer.snapshotId ||
    snapshot.version !== pointer.version ||
    snapshot.policyHash !== pointer.policyHash ||
    snapshot.scopeType !== pointer.scopeType ||
    snapshot.scopeId !== pointer.scopeId
  ) {
    return null;
  }
  return snapshot;
}

export class RuntimeLoggingPolicySnapshotMemoryCache<TPolicy = unknown> {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, RuntimeLoggingPolicySnapshotCacheEntry<TPolicy>>();
  private readonly inflight = new Map<
    string,
    Promise<RuntimeLoggingPolicySnapshot<TPolicy> | null>
  >();

  constructor(options: RuntimeLoggingPolicySnapshotCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.maxEntries = options.maxEntries ?? 128;
  }

  private key(scopeType: LoggingPolicyScopeType, scopeId: string): string {
    return `${scopeType}:${scopeId}`;
  }

  private entryMatches(
    entry: RuntimeLoggingPolicySnapshotCacheEntry<TPolicy>,
    input: {
      now: number;
      minVersion?: number;
      expectedPolicyHash?: string;
    }
  ): boolean {
    if (entry.expiresAt <= input.now) {
      return false;
    }
    if (input.minVersion !== undefined && entry.snapshot.version < input.minVersion) {
      return false;
    }
    if (
      input.expectedPolicyHash &&
      entry.snapshot.policyHash !== input.expectedPolicyHash
    ) {
      return false;
    }
    return true;
  }

  private set(key: string, snapshot: RuntimeLoggingPolicySnapshot<TPolicy>, now: number): void {
    const expiresAt = Math.min(snapshot.expiresAt ?? Number.MAX_SAFE_INTEGER, now + this.ttlMs);
    this.entries.set(key, {
      snapshot,
      cachedAt: now,
      expiresAt,
    });
    if (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey) {
        this.entries.delete(oldestKey);
      }
    }
  }

  getCached(input: {
    scopeType: LoggingPolicyScopeType;
    scopeId: string;
    now?: number;
    minVersion?: number;
    expectedPolicyHash?: string;
  }): RuntimeLoggingPolicySnapshot<TPolicy> | null {
    const now = input.now ?? Date.now();
    const key = this.key(input.scopeType, input.scopeId);
    const entry = this.entries.get(key);
    return entry && this.entryMatches(entry, { ...input, now }) ? entry.snapshot : null;
  }

  async getOrLoad(input: {
    scopeType: LoggingPolicyScopeType;
    scopeId: string;
    now?: number;
    minVersion?: number;
    expectedPolicyHash?: string;
    loader: () => Promise<RuntimeLoggingPolicySnapshot<TPolicy> | null>;
  }): Promise<RuntimeLoggingPolicySnapshot<TPolicy> | null> {
    const now = input.now ?? Date.now();
    const key = this.key(input.scopeType, input.scopeId);
    const cached = this.getCached({ ...input, now });
    if (cached) {
      return cached;
    }

    const existing = this.inflight.get(key);
    if (existing) {
      return existing;
    }

    const promise = input
      .loader()
      .then((snapshot) => {
        if (snapshot) {
          this.set(key, snapshot, now);
        }
        return snapshot;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }

  invalidate(scopeType: LoggingPolicyScopeType, scopeId: string): void {
    this.entries.delete(this.key(scopeType, scopeId));
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }
}
