import { ensureDatabaseAdapter, isDatabaseSource, type DatabaseSource } from '../db/adapter-source';
import { InternalNotificationEventRepository } from '../repositories/admin/internal-notification-event';
import {
  type TenantDatabaseRegistryRow,
  type TenantDatabaseRole,
  type TenantDatabaseRegistryRepository,
} from '../repositories/admin/tenant-database-registry';
import type { StorageTarget } from '../types/runtime-profile';
import { createTenantDatabaseRegistryRepository } from './tenant-database-registry-factory';
import {
  loadTenantDatabaseRegistrySignatureKeysFromEnv,
  verifyTenantDatabaseRegistryRowSignature,
  type TenantDatabaseRegistrySignatureEnv,
} from './tenant-database-registry-signature';
import {
  RUNTIME_REGISTRY_SNAPSHOT_VERSION,
  buildTenantRuntimeRegistryGenerationKey,
  buildTenantRuntimeRegistrySnapshotKey,
  loadTenantRuntimeRegistryVerificationKeysFromEnv,
  verifyTenantRuntimeRegistrySnapshotSignature,
  type TenantRuntimeRegistrySnapshot,
  type TenantRuntimeRegistryGenerationDocument,
  type TenantRuntimeRegistryRouteStatus,
  type TenantRuntimeRegistryStoreSnapshot,
  type RuntimeRegistrySnapshotVerificationEnv,
} from './tenant-runtime-registry-snapshot';
import {
  recordTenantRuntimeRegistrySnapshotSecurityEvent,
  type TenantRuntimeRegistrySnapshotSecurityReason,
} from './tenant-runtime-registry-security-events';

export type TenantDatabaseResolverErrorCode =
  | 'missing_snapshot'
  | 'expired_snapshot'
  | 'invalid_snapshot_signature'
  | 'quarantined_route'
  | 'missing_active_pointer'
  | 'missing_registry_row'
  | 'invalid_registry_signature'
  | 'inactive_registry_row'
  | 'missing_binding'
  | 'schema_version_too_old'
  | 'unsupported_storage_profile'
  | 'tenant_assigned_to_other_deployment_target'
  | 'unsupported_provider';

export class TenantDatabaseResolverError extends Error {
  constructor(
    readonly code: TenantDatabaseResolverErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(`${code}:${message}`);
    this.name = 'TenantDatabaseResolverError';
  }
}

export interface TenantDatabaseResolverEnv
  extends RuntimeRegistrySnapshotVerificationEnv, TenantDatabaseRegistrySignatureEnv {
  DB_ADMIN?: DatabaseSource;
  TENANT_RUNTIME_REGISTRY?: TenantRuntimeRegistryGenerationStore;
  AUTHRIM_DEPLOYMENT_TARGET?: string;
}

export interface TenantRuntimeRegistryGenerationStore {
  get(key: string): Promise<string | null>;
}

export interface TenantDatabaseResolveOptions {
  tenantId: string;
  role: TenantDatabaseRole;
  shardGroup?: string;
  shardIndex?: number;
  minimumSchemaVersion?: number;
  deploymentTarget?: string;
  requestCache?: TenantDatabaseRequestCache;
  memoryCacheTtlMs?: number;
  generationCacheTtlMs?: number;
  runtimeSnapshotMode?: 'optional' | 'required';
}

export type TenantDatabaseRequestCache = Map<string, ResolvedTenantStore>;

export interface ResolvedTenantStore {
  tenantId: string;
  role: TenantDatabaseRole;
  source: DatabaseSource;
  generation: number;
  runtimeGeneration: number;
  schemaVersion: number;
  shardGroup: string;
  shardIndex: number;
  shardCount: number;
  shardKeyStrategy: string;
  driver: 'd1';
  bindingRef: string;
  deploymentTarget: string | null;
  healthStatus: 'active' | 'degraded' | 'degraded_pending_snapshot';
  registryRow: TenantDatabaseRegistryRow;
}

export type ResolvedTenantDatabaseSource = ResolvedTenantStore;

type RuntimeSnapshotResolveResult =
  | { status: 'resolved'; resolved: ResolvedTenantStore }
  | { status: 'missing' | 'expired' | 'invalid' };

export const DEFAULT_TENANT_DATABASE_RESOLVER_MEMORY_CACHE_TTL_MS = 60_000;
export const DEFAULT_TENANT_RUNTIME_GENERATION_MEMORY_CACHE_TTL_MS = 1_000;

const tenantDatabaseResolverMemoryCache = new Map<
  string,
  { value: ResolvedTenantStore; expiresAt: number }
>();
const tenantRuntimeGenerationMemoryCache = new Map<
  string,
  { state: RuntimeGenerationState; expiresAt: number }
>();

interface RuntimeGenerationState {
  runtimeGeneration: number;
  routeStatus: TenantRuntimeRegistryRouteStatus;
  quarantineDenyGeneration: number;
}

export function clearTenantDatabaseResolverMemoryCache(): void {
  tenantDatabaseResolverMemoryCache.clear();
  tenantRuntimeGenerationMemoryCache.clear();
}

export function mapStorageTargetToTenantDatabaseRole(
  target: StorageTarget
): TenantDatabaseRole | null {
  switch (target.role) {
    case 'tenant_core':
      return 'tenant_core';
    case 'tenant_pii':
      return 'tenant_pii';
    case 'tenant_audit':
      return 'tenant_audit';
    case 'tenant_custom':
      return 'tenant_custom';
    default:
      return null;
  }
}

function getDeploymentTarget(
  env: TenantDatabaseResolverEnv,
  options: TenantDatabaseResolveOptions
) {
  return options.deploymentTarget ?? env.AUTHRIM_DEPLOYMENT_TARGET ?? null;
}

async function reportTenantDatabaseResolverHealthFailure(
  env: TenantDatabaseResolverEnv,
  input: {
    tenantId: string;
    role: TenantDatabaseRole;
    code: 'missing_binding' | 'schema_version_too_old';
    bindingRef?: string | null;
    generation?: number | null;
    shardGroup?: string | null;
    shardIndex?: number | null;
    schemaVersion?: number | null;
    minimumSchemaVersion?: number | null;
    deploymentTarget?: string | null;
  }
): Promise<void> {
  if (!env.DB_ADMIN) return;
  try {
    const adapter = ensureDatabaseAdapter(env.DB_ADMIN, 'tenant-database-resolver-health');
    const notificationRepo = new InternalNotificationEventRepository(adapter);
    await notificationRepo.enqueue({
      tenantId: input.tenantId,
      category: 'storage_registry_health',
      eventType: `tenant_database.resolver.${input.code}`,
      severity: 'critical',
      deduplicationKey: [
        'tenant_database_resolver',
        input.code,
        input.tenantId,
        input.role,
        input.generation ?? 'unknown_generation',
        input.shardGroup ?? 'default',
        input.shardIndex ?? 0,
        input.bindingRef ?? '',
        input.minimumSchemaVersion ?? '',
      ].join(':'),
      payload: {
        tenant_id: input.tenantId,
        role: input.role,
        error_code: input.code,
        binding_ref: input.bindingRef ?? null,
        generation: input.generation ?? null,
        shard_group: input.shardGroup ?? null,
        shard_index: input.shardIndex ?? null,
        schema_version: input.schemaVersion ?? null,
        minimum_schema_version: input.minimumSchemaVersion ?? null,
        deployment_target: input.deploymentTarget ?? null,
        source: 'runtime_resolver',
      },
    });
    if (input.code === 'missing_binding') {
      const now = Math.floor(Date.now() / 1000);
      const jobId = [
        'tenant-db-reconciliation',
        input.tenantId,
        input.role,
        input.generation ?? 'unknown-generation',
        input.shardGroup ?? 'default',
        input.shardIndex ?? 0,
        'missing-binding',
      ].join(':');
      await adapter.execute(
        `INSERT OR IGNORE INTO admin_jobs (
          id, tenant_id, job_type, status, progress, config,
          created_by, created_at, updated_at
        ) VALUES (?, ?, 'tenant-database/reconciliation', 'pending', ?, ?, 'runtime_resolver', ?, ?)`,
        [
          jobId,
          input.tenantId,
          JSON.stringify({
            total: 1,
            processed: 0,
            succeeded: 0,
            failed: 0,
            stage: 'requested',
          }),
          JSON.stringify({
            reason: 'missing_binding',
            role: input.role,
            generation: input.generation ?? null,
            shard_group: input.shardGroup ?? null,
            shard_index: input.shardIndex ?? null,
            binding_ref: input.bindingRef ?? null,
            deployment_target: input.deploymentTarget ?? null,
          }),
          now,
          now,
        ]
      );
    }
  } catch {
    // Alert reporting is best-effort; routing still fails closed below.
  }
}

async function getBinding(
  env: TenantDatabaseResolverEnv,
  bindingRef: string,
  context: {
    tenantId: string;
    role: TenantDatabaseRole;
    generation?: number | null;
    shardGroup?: string | null;
    shardIndex?: number | null;
    deploymentTarget?: string | null;
  }
): Promise<DatabaseSource> {
  const binding = (env as Record<string, unknown>)[bindingRef];
  if (!isDatabaseSource(binding)) {
    await reportTenantDatabaseResolverHealthFailure(env, {
      ...context,
      code: 'missing_binding',
      bindingRef,
    });
    throw new TenantDatabaseResolverError(
      'missing_binding',
      `Tenant database binding ${bindingRef} is not configured`,
      { bindingRef }
    );
  }
  return binding;
}

function buildRequestCacheKey(
  options: TenantDatabaseResolveOptions,
  deploymentTarget: string | null
): string {
  return [
    options.tenantId,
    options.role,
    options.shardGroup ?? 'default',
    options.shardIndex ?? 0,
    options.minimumSchemaVersion ?? 1,
    deploymentTarget ?? '',
  ].join(':');
}

function isRuntimeRegistryRouteStatus(value: unknown): value is TenantRuntimeRegistryRouteStatus {
  return (
    value === 'active' ||
    value === 'quarantining' ||
    value === 'quarantined' ||
    value === 'disabled'
  );
}

function parseRuntimeGeneration(value: string | null): RuntimeGenerationState | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<TenantRuntimeRegistryGenerationDocument>;
    if (
      !Number.isSafeInteger(parsed.runtimeGeneration) ||
      (parsed.runtimeGeneration as number) < 1
    ) {
      return null;
    }
    const routeStatus = parsed.routeStatus ?? 'active';
    const quarantineDenyGeneration = parsed.quarantineDenyGeneration ?? 0;
    if (
      !isRuntimeRegistryRouteStatus(routeStatus) ||
      !Number.isSafeInteger(quarantineDenyGeneration) ||
      quarantineDenyGeneration < 0 ||
      (routeStatus !== 'active' && quarantineDenyGeneration < 1)
    ) {
      return null;
    }
    return {
      runtimeGeneration: parsed.runtimeGeneration as number,
      routeStatus,
      quarantineDenyGeneration,
    };
  } catch {
    return null;
  }
}

function createQuarantinedRouteError(
  tenantId: string,
  routeStatus: Exclude<TenantRuntimeRegistryRouteStatus, 'active'>,
  quarantineDenyGeneration: number
): TenantDatabaseResolverError {
  return new TenantDatabaseResolverError(
    'quarantined_route',
    `Tenant database route is unavailable: ${routeStatus}`,
    { tenantId, routeStatus, quarantineDenyGeneration }
  );
}

async function assertRuntimeRouteAvailable(
  env: TenantDatabaseResolverEnv,
  cacheKey: string,
  tenantId: string,
  deploymentTarget: string | null,
  generationCacheTtlMs: number
): Promise<RuntimeGenerationState | null> {
  if (!env.TENANT_RUNTIME_REGISTRY) return null;
  const generationKey = buildTenantRuntimeRegistryGenerationKey(
    tenantId,
    deploymentTarget ?? 'default'
  );
  const state = await getRuntimeGeneration(
    env.TENANT_RUNTIME_REGISTRY,
    generationKey,
    generationCacheTtlMs
  );
  if (state && state.routeStatus !== 'active') {
    tenantDatabaseResolverMemoryCache.delete(cacheKey);
    throw createQuarantinedRouteError(tenantId, state.routeStatus, state.quarantineDenyGeneration);
  }
  return state;
}

async function getMemoryCachedTenantDatabase(
  cacheKey: string,
  env: TenantDatabaseResolverEnv,
  tenantId: string,
  deploymentTarget: string | null,
  generationCacheTtlMs: number
): Promise<ResolvedTenantStore | null> {
  const cached = tenantDatabaseResolverMemoryCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    tenantDatabaseResolverMemoryCache.delete(cacheKey);
    return null;
  }
  if (env.TENANT_RUNTIME_REGISTRY) {
    const generationKey = buildTenantRuntimeRegistryGenerationKey(
      tenantId,
      deploymentTarget ?? 'default'
    );
    const state = await getRuntimeGeneration(
      env.TENANT_RUNTIME_REGISTRY,
      generationKey,
      generationCacheTtlMs
    );
    if (state !== null && state.runtimeGeneration !== cached.value.runtimeGeneration) {
      tenantDatabaseResolverMemoryCache.delete(cacheKey);
      return null;
    }
  }
  return cached.value;
}

async function getRuntimeGeneration(
  generationStore: TenantRuntimeRegistryGenerationStore,
  generationKey: string,
  ttlMs: number
): Promise<RuntimeGenerationState | null> {
  const cached = tenantRuntimeGenerationMemoryCache.get(generationKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.state;
  }
  if (cached) {
    tenantRuntimeGenerationMemoryCache.delete(generationKey);
  }

  const state = parseRuntimeGeneration(await generationStore.get(generationKey));
  if (state !== null && ttlMs > 0) {
    tenantRuntimeGenerationMemoryCache.set(generationKey, {
      state,
      expiresAt: Date.now() + ttlMs,
    });
  }
  return state;
}

function setMemoryCachedTenantDatabase(
  cacheKey: string,
  resolved: ResolvedTenantStore,
  ttlMs: number
): void {
  if (ttlMs <= 0) return;
  tenantDatabaseResolverMemoryCache.set(cacheKey, {
    value: resolved,
    expiresAt: Date.now() + ttlMs,
  });
}

function isResolvableRegistryStatus(status: TenantDatabaseRegistryRow['status']): boolean {
  return ['ready', 'active', 'degraded', 'degraded_pending_snapshot'].includes(status);
}

async function assertRegistryRowSignatureIfConfigured(
  env: TenantDatabaseResolverEnv,
  row: TenantDatabaseRegistryRow
): Promise<void> {
  const status = await verifyTenantDatabaseRegistryRowSignature(
    row,
    loadTenantDatabaseRegistrySignatureKeysFromEnv(env)
  );
  if (status === 'not_configured' || status === 'valid') {
    return;
  }
  throw new TenantDatabaseResolverError(
    'invalid_registry_signature',
    `Tenant database registry row signature is ${status}`,
    {
      tenantId: row.tenant_id,
      role: row.role,
      generation: row.generation,
      shardGroup: row.shard_group,
      shardIndex: row.shard_index,
      signatureKeyId: row.signature_key_id,
    }
  );
}

function parseRuntimeRegistrySnapshot(value: string | null): TenantRuntimeRegistrySnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as TenantRuntimeRegistrySnapshot;
    if (
      parsed.version !== RUNTIME_REGISTRY_SNAPSHOT_VERSION ||
      !Array.isArray(parsed.stores) ||
      !isRuntimeRegistryRouteStatus(parsed.routeStatus) ||
      !Number.isSafeInteger(parsed.quarantineDenyGeneration) ||
      parsed.quarantineDenyGeneration < 0 ||
      (parsed.routeStatus !== 'active' && parsed.quarantineDenyGeneration < 1)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function findSnapshotStore(
  snapshot: TenantRuntimeRegistrySnapshot,
  options: TenantDatabaseResolveOptions,
  shardGroup: string,
  shardIndex: number
): TenantRuntimeRegistryStoreSnapshot | null {
  return (
    snapshot.stores.find(
      (store) =>
        store.tenantId === options.tenantId &&
        store.role === options.role &&
        store.shardGroup === shardGroup &&
        store.shardIndex === shardIndex
    ) ?? null
  );
}

function snapshotStoreToRegistryRow(
  store: TenantRuntimeRegistryStoreSnapshot,
  publishedAt: string
): TenantDatabaseRegistryRow {
  return {
    tenant_id: store.tenantId,
    role: store.role,
    generation: store.generation,
    shard_group: store.shardGroup,
    shard_index: store.shardIndex,
    provider: store.provider,
    database_id: store.databaseId,
    database_name: store.databaseName,
    binding_ref: store.bindingRef,
    connection_ref: store.connectionRef,
    schema_version: store.schemaVersion,
    status: store.status,
    shard_count: store.shardCount,
    shard_key_strategy: store.shardKeyStrategy,
    worker_shard: null,
    deployment_target: store.deploymentTarget,
    region_hint: store.regionHint,
    jurisdiction: store.jurisdiction,
    signature: null,
    signature_key_id: null,
    metadata_json: null,
    created_at: publishedAt,
    updated_at: publishedAt,
    created_by: null,
    updated_by: null,
  };
}

async function reportRuntimeSnapshotSecurityFailure(
  env: TenantDatabaseResolverEnv,
  input: {
    tenantId: string;
    role: TenantDatabaseRole;
    deploymentTarget: string;
    snapshotKey: string;
    reason: TenantRuntimeRegistrySnapshotSecurityReason;
    signatureKeyId?: string | null;
    runtimeGeneration?: number | null;
  }
): Promise<void> {
  if (!env.DB_ADMIN) return;
  try {
    const adminAdapter = ensureDatabaseAdapter(env.DB_ADMIN, 'tenant-runtime-registry-security');
    await recordTenantRuntimeRegistrySnapshotSecurityEvent(
      {
        tenantId: input.tenantId,
        deploymentTarget: input.deploymentTarget,
        snapshotKey: input.snapshotKey,
        reason: input.reason,
        signatureKeyId: input.signatureKeyId,
        runtimeGeneration: input.runtimeGeneration,
        role: input.role,
        source: 'runtime_resolver',
      },
      {
        adminAuditAdapter: adminAdapter,
        internalNotificationAdapter: adminAdapter,
      }
    );
  } catch {
    // Security event reporting is best-effort; routing still fails closed below.
  }
}

async function resolveTenantDatabaseSourceFromRuntimeSnapshot(
  env: TenantDatabaseResolverEnv,
  options: TenantDatabaseResolveOptions,
  shardGroup: string,
  shardIndex: number,
  deploymentTarget: string | null
): Promise<RuntimeSnapshotResolveResult> {
  if (!env.TENANT_RUNTIME_REGISTRY) return { status: 'missing' };

  const snapshotKey = buildTenantRuntimeRegistrySnapshotKey(
    options.tenantId,
    deploymentTarget ?? 'default'
  );
  let snapshot: TenantRuntimeRegistrySnapshot | null = null;
  try {
    snapshot = parseRuntimeRegistrySnapshot(await env.TENANT_RUNTIME_REGISTRY.get(snapshotKey));
  } catch {
    return { status: 'invalid' };
  }
  if (!snapshot) return { status: 'missing' };
  if (snapshot.tenantId !== options.tenantId) return { status: 'invalid' };
  const expectedDeploymentTarget = deploymentTarget ?? 'default';
  if (snapshot.deploymentTarget !== expectedDeploymentTarget) {
    await reportRuntimeSnapshotSecurityFailure(env, {
      tenantId: options.tenantId,
      role: options.role,
      deploymentTarget: expectedDeploymentTarget,
      snapshotKey,
      reason: 'deployment_target_mismatch',
      signatureKeyId: snapshot.metadata.signatureKeyId,
      runtimeGeneration: snapshot.runtimeGeneration,
    });
    return { status: 'invalid' };
  }
  const generationKey = buildTenantRuntimeRegistryGenerationKey(
    options.tenantId,
    expectedDeploymentTarget
  );
  let lightweightGeneration: RuntimeGenerationState | null = null;
  try {
    lightweightGeneration = parseRuntimeGeneration(
      await env.TENANT_RUNTIME_REGISTRY.get(generationKey)
    );
  } catch {
    return { status: 'invalid' };
  }
  if (lightweightGeneration && lightweightGeneration.routeStatus !== 'active') {
    throw createQuarantinedRouteError(
      options.tenantId,
      lightweightGeneration.routeStatus,
      lightweightGeneration.quarantineDenyGeneration
    );
  }
  if (
    lightweightGeneration === null ||
    lightweightGeneration.runtimeGeneration !== snapshot.runtimeGeneration
  ) {
    return { status: 'invalid' };
  }
  let signatureStatus: Awaited<ReturnType<typeof verifyTenantRuntimeRegistrySnapshotSignature>>;
  try {
    signatureStatus = await verifyTenantRuntimeRegistrySnapshotSignature(
      snapshot,
      loadTenantRuntimeRegistryVerificationKeysFromEnv(env)
    );
  } catch {
    return { status: 'invalid' };
  }
  if (signatureStatus !== 'valid') {
    await reportRuntimeSnapshotSecurityFailure(env, {
      tenantId: options.tenantId,
      role: options.role,
      deploymentTarget: expectedDeploymentTarget,
      snapshotKey,
      reason:
        signatureStatus === 'unsigned'
          ? 'unsigned_snapshot'
          : signatureStatus === 'not_configured'
            ? 'verification_key_not_configured'
            : 'invalid_signature',
      signatureKeyId: snapshot.metadata.signatureKeyId,
      runtimeGeneration: snapshot.runtimeGeneration,
    });
    return { status: 'invalid' };
  }
  if (snapshot.routeStatus !== 'active') {
    throw createQuarantinedRouteError(
      options.tenantId,
      snapshot.routeStatus,
      snapshot.quarantineDenyGeneration
    );
  }
  const expiresAt = new Date(snapshot.expiresAt).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return { status: 'expired' };

  const store = findSnapshotStore(snapshot, options, shardGroup, shardIndex);
  if (!store) return { status: 'missing' };
  const row = snapshotStoreToRegistryRow(store, snapshot.publishedAt);

  if (!isResolvableRegistryStatus(row.status)) return { status: 'invalid' };
  if (row.deployment_target && deploymentTarget && row.deployment_target !== deploymentTarget) {
    throw new TenantDatabaseResolverError(
      'tenant_assigned_to_other_deployment_target',
      `Tenant database belongs to ${row.deployment_target}, not ${deploymentTarget}`,
      { tenantId: options.tenantId, role: options.role, deploymentTarget }
    );
  }

  const minimumSchemaVersion = options.minimumSchemaVersion ?? 1;
  if (row.schema_version < minimumSchemaVersion) {
    await reportTenantDatabaseResolverHealthFailure(env, {
      tenantId: options.tenantId,
      role: options.role,
      code: 'schema_version_too_old',
      bindingRef: row.binding_ref,
      generation: row.generation,
      shardGroup: row.shard_group,
      shardIndex: row.shard_index,
      schemaVersion: row.schema_version,
      minimumSchemaVersion,
      deploymentTarget,
    });
    throw new TenantDatabaseResolverError(
      'schema_version_too_old',
      `Tenant database schema ${row.schema_version} is older than ${minimumSchemaVersion}`,
      {
        tenantId: options.tenantId,
        role: options.role,
        schemaVersion: row.schema_version,
        minimumSchemaVersion,
      }
    );
  }
  if (row.provider !== 'd1') {
    throw new TenantDatabaseResolverError(
      'unsupported_provider',
      `Tenant database provider ${row.provider} is not supported by the D1 resolver`,
      { tenantId: options.tenantId, role: options.role, provider: row.provider }
    );
  }
  if (!row.binding_ref) {
    await reportTenantDatabaseResolverHealthFailure(env, {
      tenantId: options.tenantId,
      role: options.role,
      code: 'missing_binding',
      generation: row.generation,
      shardGroup: row.shard_group,
      shardIndex: row.shard_index,
      deploymentTarget,
    });
    throw new TenantDatabaseResolverError(
      'missing_binding',
      'Tenant D1 registry row is missing binding_ref',
      { tenantId: options.tenantId, role: options.role }
    );
  }

  return {
    status: 'resolved',
    resolved: {
      tenantId: options.tenantId,
      role: options.role,
      source: await getBinding(env, row.binding_ref, {
        tenantId: options.tenantId,
        role: options.role,
        generation: row.generation,
        shardGroup: row.shard_group,
        shardIndex: row.shard_index,
        deploymentTarget,
      }),
      generation: row.generation,
      runtimeGeneration: snapshot.runtimeGeneration,
      schemaVersion: row.schema_version,
      shardGroup: row.shard_group,
      shardIndex: row.shard_index,
      shardCount: row.shard_count,
      shardKeyStrategy: row.shard_key_strategy,
      driver: 'd1',
      bindingRef: row.binding_ref,
      deploymentTarget: row.deployment_target,
      healthStatus:
        row.status === 'degraded' || row.status === 'degraded_pending_snapshot'
          ? row.status
          : 'active',
      registryRow: row,
    },
  };
}

function createRequiredSnapshotError(
  status: Exclude<RuntimeSnapshotResolveResult['status'], 'resolved'>,
  options: TenantDatabaseResolveOptions
): TenantDatabaseResolverError {
  if (status === 'expired') {
    return new TenantDatabaseResolverError(
      'expired_snapshot',
      `Runtime registry snapshot is expired for ${options.tenantId}/${options.role}`,
      { tenantId: options.tenantId, role: options.role }
    );
  }
  if (status === 'invalid') {
    return new TenantDatabaseResolverError(
      'invalid_snapshot_signature',
      `Runtime registry snapshot is invalid for ${options.tenantId}/${options.role}`,
      { tenantId: options.tenantId, role: options.role }
    );
  }
  return new TenantDatabaseResolverError(
    'missing_snapshot',
    `Runtime registry snapshot is missing for ${options.tenantId}/${options.role}`,
    { tenantId: options.tenantId, role: options.role }
  );
}

function createDefaultTenantDatabaseRegistryRepository(
  env: TenantDatabaseResolverEnv
): TenantDatabaseRegistryRepository {
  try {
    return createTenantDatabaseRegistryRepository(env, 'tenant-database-registry');
  } catch {
    throw new TenantDatabaseResolverError(
      'missing_binding',
      'DB_ADMIN is required to resolve tenant database registry'
    );
  }
}

export async function resolveTenantDatabaseSourceFromRegistry(
  env: TenantDatabaseResolverEnv,
  options: TenantDatabaseResolveOptions,
  repository?: TenantDatabaseRegistryRepository
): Promise<ResolvedTenantDatabaseSource> {
  const shardGroup = options.shardGroup ?? 'default';
  const shardIndex = options.shardIndex ?? 0;
  const deploymentTarget = getDeploymentTarget(env, options);
  const cacheKey = buildRequestCacheKey(options, deploymentTarget);
  await assertRuntimeRouteAvailable(
    env,
    cacheKey,
    options.tenantId,
    deploymentTarget,
    options.generationCacheTtlMs ?? DEFAULT_TENANT_RUNTIME_GENERATION_MEMORY_CACHE_TTL_MS
  );
  const cached = options.requestCache?.get(cacheKey);
  if (cached) {
    return cached;
  }
  const memoryCached = await getMemoryCachedTenantDatabase(
    cacheKey,
    env,
    options.tenantId,
    deploymentTarget,
    options.generationCacheTtlMs ?? DEFAULT_TENANT_RUNTIME_GENERATION_MEMORY_CACHE_TTL_MS
  );
  if (memoryCached) {
    options.requestCache?.set(cacheKey, memoryCached);
    return memoryCached;
  }

  const snapshotResult = await resolveTenantDatabaseSourceFromRuntimeSnapshot(
    env,
    options,
    shardGroup,
    shardIndex,
    deploymentTarget
  );
  if (snapshotResult.status === 'resolved') {
    options.requestCache?.set(cacheKey, snapshotResult.resolved);
    setMemoryCachedTenantDatabase(
      cacheKey,
      snapshotResult.resolved,
      options.memoryCacheTtlMs ?? DEFAULT_TENANT_DATABASE_RESOLVER_MEMORY_CACHE_TTL_MS
    );
    return snapshotResult.resolved;
  }
  if (options.runtimeSnapshotMode === 'required') {
    throw createRequiredSnapshotError(snapshotResult.status, options);
  }

  const registryRepository = repository ?? createDefaultTenantDatabaseRegistryRepository(env);
  const pointer = await registryRepository.getActivePointer(
    options.tenantId,
    options.role,
    shardGroup
  );
  if (!pointer) {
    throw new TenantDatabaseResolverError(
      'missing_active_pointer',
      `No active tenant database pointer for ${options.tenantId}/${options.role}`,
      { tenantId: options.tenantId, role: options.role, shardGroup }
    );
  }

  const row = await registryRepository.getRegistryRow({
    tenant_id: options.tenantId,
    role: options.role,
    generation: pointer.generation,
    shard_group: shardGroup,
    shard_index: shardIndex,
  });
  if (!row) {
    throw new TenantDatabaseResolverError(
      'missing_registry_row',
      `No registry row for active pointer ${options.tenantId}/${options.role}/${pointer.generation}`,
      { tenantId: options.tenantId, role: options.role, generation: pointer.generation }
    );
  }

  await assertRegistryRowSignatureIfConfigured(env, row);

  if (!isResolvableRegistryStatus(row.status)) {
    throw new TenantDatabaseResolverError(
      'inactive_registry_row',
      `Tenant database registry row is not active: ${row.status}`,
      { tenantId: options.tenantId, role: options.role, status: row.status }
    );
  }

  if (row.deployment_target && deploymentTarget && row.deployment_target !== deploymentTarget) {
    throw new TenantDatabaseResolverError(
      'tenant_assigned_to_other_deployment_target',
      `Tenant database belongs to ${row.deployment_target}, not ${deploymentTarget}`,
      { tenantId: options.tenantId, role: options.role, deploymentTarget }
    );
  }

  const minimumSchemaVersion = options.minimumSchemaVersion ?? 1;
  if (row.schema_version < minimumSchemaVersion) {
    await reportTenantDatabaseResolverHealthFailure(env, {
      tenantId: options.tenantId,
      role: options.role,
      code: 'schema_version_too_old',
      bindingRef: row.binding_ref,
      generation: row.generation,
      shardGroup: row.shard_group,
      shardIndex: row.shard_index,
      schemaVersion: row.schema_version,
      minimumSchemaVersion,
      deploymentTarget,
    });
    throw new TenantDatabaseResolverError(
      'schema_version_too_old',
      `Tenant database schema ${row.schema_version} is older than ${minimumSchemaVersion}`,
      {
        tenantId: options.tenantId,
        role: options.role,
        schemaVersion: row.schema_version,
        minimumSchemaVersion,
      }
    );
  }

  if (row.provider !== 'd1') {
    throw new TenantDatabaseResolverError(
      'unsupported_provider',
      `Tenant database provider ${row.provider} is not supported by the D1 resolver`,
      { tenantId: options.tenantId, role: options.role, provider: row.provider }
    );
  }
  if (!row.binding_ref) {
    await reportTenantDatabaseResolverHealthFailure(env, {
      tenantId: options.tenantId,
      role: options.role,
      code: 'missing_binding',
      generation: row.generation,
      shardGroup: row.shard_group,
      shardIndex: row.shard_index,
      deploymentTarget,
    });
    throw new TenantDatabaseResolverError(
      'missing_binding',
      'Tenant D1 registry row is missing binding_ref',
      { tenantId: options.tenantId, role: options.role }
    );
  }

  const resolved: ResolvedTenantStore = {
    tenantId: options.tenantId,
    role: options.role,
    source: await getBinding(env, row.binding_ref, {
      tenantId: options.tenantId,
      role: options.role,
      generation: row.generation,
      shardGroup: row.shard_group,
      shardIndex: row.shard_index,
      deploymentTarget,
    }),
    generation: row.generation,
    runtimeGeneration: pointer.runtime_generation,
    schemaVersion: row.schema_version,
    shardGroup: row.shard_group,
    shardIndex: row.shard_index,
    shardCount: row.shard_count,
    shardKeyStrategy: row.shard_key_strategy,
    driver: 'd1',
    bindingRef: row.binding_ref,
    deploymentTarget: row.deployment_target,
    healthStatus:
      row.status === 'degraded' || row.status === 'degraded_pending_snapshot'
        ? row.status
        : 'active',
    registryRow: row,
  };
  options.requestCache?.set(cacheKey, resolved);
  setMemoryCachedTenantDatabase(
    cacheKey,
    resolved,
    options.memoryCacheTtlMs ?? DEFAULT_TENANT_DATABASE_RESOLVER_MEMORY_CACHE_TTL_MS
  );
  return resolved;
}

export async function resolveTenantDatabaseSourceForTarget(
  env: TenantDatabaseResolverEnv,
  tenantId: string,
  target: StorageTarget,
  options: Omit<TenantDatabaseResolveOptions, 'tenantId' | 'role'> = {},
  repository?: TenantDatabaseRegistryRepository
): Promise<ResolvedTenantDatabaseSource> {
  if (target.resolverRef !== 'tenant-database-registry') {
    throw new TenantDatabaseResolverError(
      'unsupported_storage_profile',
      `Unsupported storage target resolver ${target.resolverRef ?? 'none'}`,
      { resolverRef: target.resolverRef }
    );
  }

  const role = mapStorageTargetToTenantDatabaseRole(target);
  if (!role) {
    throw new TenantDatabaseResolverError(
      'unsupported_storage_profile',
      `Storage target role ${target.role ?? 'none'} cannot resolve tenant database`,
      { role: target.role }
    );
  }

  return resolveTenantDatabaseSourceFromRegistry(
    env,
    {
      ...options,
      tenantId,
      role,
    },
    repository
  );
}
