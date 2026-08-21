import { ensureDatabaseAdapter, isDatabaseSource, type DatabaseSource } from '../db/adapter-source';
import { InternalNotificationEventRepository } from '../repositories/admin/internal-notification-event';
import {
  type TenantDatabaseRegistryRow,
  type TenantDatabaseRole,
  type TenantDatabaseRegistryRepository,
} from '../repositories/admin/tenant-database-registry';
import { createTenantDatabaseRegistryRepository } from './tenant-database-registry-factory';
import { isWithinTenantDatabaseProvisioningGracePeriod } from './tenant-database-reconciliation';
import {
  loadTenantDatabaseRegistrySignatureKeysFromEnv,
  verifyTenantDatabaseRegistryRowSignature,
  type TenantDatabaseRegistrySignatureEnv,
} from './tenant-database-registry-signature';
import {
  RUNTIME_REGISTRY_SNAPSHOT_VERSION,
  buildTenantRuntimeRegistryGenerationKey,
  buildTenantRuntimeRegistrySnapshotKey,
  hasPhysicalCorePiiDatabaseSeparation,
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
  | 'missing_generation'
  | 'expired_snapshot'
  | 'invalid_snapshot_signature'
  | 'quarantined_route'
  | 'missing_active_pointer'
  | 'missing_registry_row'
  | 'invalid_registry_signature'
  | 'inactive_registry_row'
  | 'missing_binding'
  | 'schema_version_too_old'
  | 'invalid_route_contract'
  | 'route_owner_mismatch'
  | 'route_generation_mismatch'
  | 'route_role_residency_mismatch'
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
  dataRole?: TenantRuntimeRegistryStoreSnapshot['dataRole'];
  residencyPartition?: string;
  shardId?: string;
  bindingRef?: string;
  requiredBindingRouteGeneration?: number;
  shardGroup?: string;
  shardIndex?: number;
  minimumSchemaVersion?: number;
  deploymentTarget?: string;
  requestCache?: TenantDatabaseRequestCache;
  memoryCacheTtlMs?: number;
  generationCacheTtlMs?: number;
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
  resolutionSource: 'runtime_registry' | 'control_registry';
  dataRole: TenantRuntimeRegistryStoreSnapshot['dataRole'];
  residencyPolicyId: string;
  residencyPartition: string;
  shardId: string;
  assignmentGeneration: number;
  bindingRouteGeneration: number;
  placementPolicy: TenantRuntimeRegistrySnapshot['placement'];
  allocationScope: TenantRuntimeRegistryStoreSnapshot['allocationScope'];
  ownerTenantId: string | null;
  registryRow: TenantDatabaseRegistryRow;
}

export type ResolvedTenantDatabaseSource = ResolvedTenantStore;

type RuntimeSnapshotResolveResult =
  | { status: 'resolved'; resolved: ResolvedTenantStore }
  | { status: 'missing' | 'expired' | 'invalid' | 'invalid_contract' };

export const DEFAULT_TENANT_DATABASE_RESOLVER_MEMORY_CACHE_TTL_MS = 60_000;
export const DEFAULT_TENANT_RUNTIME_GENERATION_MEMORY_CACHE_TTL_MS = 1_000;

type CachedResolvedTenantStore = Omit<ResolvedTenantStore, 'source'>;

let tenantDatabaseResolverMemoryCache = new WeakMap<
  object,
  Map<string, { value: CachedResolvedTenantStore; expiresAt: number }>
>();
let tenantRuntimeGenerationMemoryCache = new WeakMap<
  object,
  Map<string, { state: RuntimeGenerationState; expiresAt: number }>
>();

interface RuntimeGenerationState {
  runtimeGeneration: number;
  routeStatus: TenantRuntimeRegistryRouteStatus;
  quarantineDenyGeneration: number;
}

export function clearTenantDatabaseResolverMemoryCache(): void {
  tenantDatabaseResolverMemoryCache = new WeakMap();
  tenantRuntimeGenerationMemoryCache = new WeakMap();
}

function getTenantDatabaseMemoryCache(
  env: TenantDatabaseResolverEnv
): Map<string, { value: CachedResolvedTenantStore; expiresAt: number }> {
  const cacheKey = env as object;
  let cache = tenantDatabaseResolverMemoryCache.get(cacheKey);
  if (!cache) {
    cache = new Map();
    tenantDatabaseResolverMemoryCache.set(cacheKey, cache);
  }
  return cache;
}

function getRuntimeGenerationMemoryCache(
  generationStore: TenantRuntimeRegistryGenerationStore
): Map<string, { state: RuntimeGenerationState; expiresAt: number }> {
  const cacheKey = generationStore as object;
  let cache = tenantRuntimeGenerationMemoryCache.get(cacheKey);
  if (!cache) {
    cache = new Map();
    tenantRuntimeGenerationMemoryCache.set(cacheKey, cache);
  }
  return cache;
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
    createdAt?: string | null;
  }
): Promise<void> {
  if (!env.DB_ADMIN) return;
  if (
    input.code === 'missing_binding' &&
    isWithinTenantDatabaseProvisioningGracePeriod(input.createdAt)
  ) {
    return;
  }
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
    createdAt?: string | null;
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
    options.dataRole ?? '',
    options.residencyPartition ?? '',
    options.shardId ?? '',
    options.bindingRef ?? '',
    options.requiredBindingRouteGeneration ?? '',
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
    const routeStatus = parsed.routeStatus;
    const quarantineDenyGeneration = parsed.quarantineDenyGeneration;
    const publishedAt = Date.parse(String(parsed.publishedAt ?? ''));
    const expiresAt = Date.parse(String(parsed.expiresAt ?? ''));
    if (
      !isRuntimeRegistryRouteStatus(routeStatus) ||
      typeof quarantineDenyGeneration !== 'number' ||
      !Number.isSafeInteger(quarantineDenyGeneration) ||
      quarantineDenyGeneration < 0 ||
      (routeStatus !== 'active' && quarantineDenyGeneration < 1) ||
      !Number.isFinite(publishedAt) ||
      !Number.isFinite(expiresAt) ||
      publishedAt > expiresAt ||
      expiresAt <= Date.now()
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
    getTenantDatabaseMemoryCache(env).delete(cacheKey);
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
  const memoryCache = getTenantDatabaseMemoryCache(env);
  const cached = memoryCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    memoryCache.delete(cacheKey);
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
    if (state === null || state.runtimeGeneration !== cached.value.runtimeGeneration) {
      memoryCache.delete(cacheKey);
      return null;
    }
  }
  return {
    ...cached.value,
    source: await getBinding(env, cached.value.bindingRef, {
      tenantId: cached.value.tenantId,
      role: cached.value.role,
      generation: cached.value.generation,
      shardGroup: cached.value.shardGroup,
      shardIndex: cached.value.shardIndex,
      deploymentTarget: cached.value.deploymentTarget,
    }),
  };
}

async function getRuntimeGeneration(
  generationStore: TenantRuntimeRegistryGenerationStore,
  generationKey: string,
  ttlMs: number
): Promise<RuntimeGenerationState | null> {
  const memoryCache = getRuntimeGenerationMemoryCache(generationStore);
  const cached = memoryCache.get(generationKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.state;
  }
  if (cached) {
    memoryCache.delete(generationKey);
  }

  const state = parseRuntimeGeneration(await generationStore.get(generationKey));
  if (state !== null && ttlMs > 0) {
    memoryCache.set(generationKey, {
      state,
      expiresAt: Date.now() + ttlMs,
    });
  }
  return state;
}

function setMemoryCachedTenantDatabase(
  env: TenantDatabaseResolverEnv,
  cacheKey: string,
  resolved: ResolvedTenantStore,
  ttlMs: number
): void {
  if (ttlMs <= 0) return;
  const { source: _source, ...cached } = resolved;
  getTenantDatabaseMemoryCache(env).set(cacheKey, {
    value: cached,
    expiresAt: Date.now() + ttlMs,
  });
}

function isResolvableRegistryStatus(status: TenantDatabaseRegistryRow['status']): boolean {
  return ['ready', 'active', 'degraded', 'degraded_pending_snapshot'].includes(status);
}

function parseControlRegistryRouteMetadata(row: TenantDatabaseRegistryRow): {
  dataRole: TenantRuntimeRegistryStoreSnapshot['dataRole'];
  residencyPolicyId: string;
  residencyPartition: string;
  shardId: string;
  assignmentGeneration: number;
  placementPolicy: TenantRuntimeRegistrySnapshot['placement'];
  allocationScope: TenantRuntimeRegistryStoreSnapshot['allocationScope'];
  ownerTenantId: string | null;
} {
  let value: unknown;
  try {
    value = JSON.parse(row.metadata_json ?? 'null') as unknown;
  } catch {
    value = null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TenantDatabaseResolverError(
      'invalid_route_contract',
      'Control registry route metadata is missing or invalid'
    );
  }
  const metadata = value as Record<string, unknown>;
  const dataRole = metadata.control_data_role;
  const allocationScope = metadata.control_allocation_scope;
  const ownerTenantId = metadata.control_owner_tenant_id ?? null;
  const assignmentGeneration = metadata.control_assignment_generation;
  const policyGeneration = metadata.control_placement_policy_generation;
  if (
    (dataRole !== 'tenant_core/default' &&
      dataRole !== 'tenant_core/users' &&
      dataRole !== 'tenant_pii') ||
    typeof metadata.control_residency_policy_id !== 'string' ||
    !metadata.control_residency_policy_id ||
    typeof metadata.control_residency_partition !== 'string' ||
    !metadata.control_residency_partition ||
    typeof metadata.control_shard_id !== 'string' ||
    !metadata.control_shard_id ||
    !Number.isSafeInteger(assignmentGeneration) ||
    Number(assignmentGeneration) < 1 ||
    !Number.isSafeInteger(policyGeneration) ||
    Number(policyGeneration) < 1 ||
    (allocationScope !== 'shared_pool' && allocationScope !== 'tenant_exclusive') ||
    (allocationScope === 'shared_pool' && ownerTenantId !== null) ||
    (allocationScope === 'tenant_exclusive' && ownerTenantId !== row.tenant_id)
  ) {
    throw new TenantDatabaseResolverError(
      'invalid_route_contract',
      'Control registry route metadata does not satisfy the unified route contract',
      { tenantId: row.tenant_id, role: row.role }
    );
  }
  return {
    dataRole,
    residencyPolicyId: metadata.control_residency_policy_id,
    residencyPartition: metadata.control_residency_partition,
    shardId: metadata.control_shard_id,
    assignmentGeneration: Number(assignmentGeneration),
    placementPolicy: {
      isolationPolicy: allocationScope,
      policyGeneration: Number(policyGeneration),
    },
    allocationScope,
    ownerTenantId: ownerTenantId as string | null,
  };
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
    const roles = Array.isArray(parsed.stores)
      ? Array.from(new Set(parsed.stores.map((store) => store.role))).sort()
      : [];
    const routeKeys = Array.isArray(parsed.stores)
      ? parsed.stores.map((store) =>
          [
            store.tenantId,
            store.dataRole,
            store.residencyPolicyId,
            store.residencyPartition,
            store.shardId,
            store.bindingRef,
            store.bindingRouteGeneration,
          ].join(':')
        )
      : [];
    if (
      parsed.version !== RUNTIME_REGISTRY_SNAPSHOT_VERSION ||
      typeof parsed.tenantId !== 'string' ||
      !parsed.tenantId ||
      typeof parsed.deploymentTarget !== 'string' ||
      !parsed.deploymentTarget ||
      !Number.isSafeInteger(parsed.runtimeGeneration) ||
      parsed.runtimeGeneration < 1 ||
      !Array.isArray(parsed.stores) ||
      !parsed.metadata ||
      parsed.metadata.storeCount !== parsed.stores.length ||
      !Array.isArray(parsed.metadata.roles) ||
      JSON.stringify(parsed.metadata.roles) !== JSON.stringify(roles) ||
      new Set(routeKeys).size !== routeKeys.length ||
      !hasPhysicalCorePiiDatabaseSeparation(parsed.stores) ||
      parsed.backend?.provider !== 'd1' ||
      parsed.backend.resolver !== 'control-plane' ||
      (parsed.placement?.isolationPolicy !== 'shared_pool' &&
        parsed.placement?.isolationPolicy !== 'tenant_exclusive') ||
      !Number.isSafeInteger(parsed.placement?.policyGeneration) ||
      parsed.placement.policyGeneration < 1 ||
      !isRuntimeRegistryRouteStatus(parsed.routeStatus) ||
      !Number.isSafeInteger(parsed.quarantineDenyGeneration) ||
      parsed.quarantineDenyGeneration < 0 ||
      (parsed.routeStatus !== 'active' && parsed.quarantineDenyGeneration < 1) ||
      parsed.stores.some(
        (store) =>
          store.tenantId !== parsed.tenantId ||
          store.runtimeGeneration !== parsed.runtimeGeneration ||
          !Number.isSafeInteger(store.generation) ||
          store.generation < 1 ||
          !Number.isSafeInteger(store.schemaVersion) ||
          store.schemaVersion < 1 ||
          !Number.isSafeInteger(store.shardIndex) ||
          store.shardIndex < 0 ||
          !Number.isSafeInteger(store.shardCount) ||
          store.shardCount < 1 ||
          store.shardIndex >= store.shardCount ||
          store.provider !== 'd1' ||
          store.driver !== 'd1' ||
          !isResolvableRegistryStatus(store.status) ||
          (store.deploymentTarget !== null && store.deploymentTarget !== parsed.deploymentTarget) ||
          (store.dataRole !== 'tenant_core/default' &&
            store.dataRole !== 'tenant_core/users' &&
            store.dataRole !== 'tenant_pii') ||
          (store.role === 'tenant_pii') !== (store.dataRole === 'tenant_pii') ||
          typeof store.residencyPolicyId !== 'string' ||
          !store.residencyPolicyId ||
          typeof store.residencyPartition !== 'string' ||
          !store.residencyPartition ||
          typeof store.shardId !== 'string' ||
          !store.shardId ||
          !Number.isSafeInteger(store.assignmentGeneration) ||
          store.assignmentGeneration < 1 ||
          !Number.isSafeInteger(store.bindingRouteGeneration) ||
          store.bindingRouteGeneration !== store.generation ||
          typeof store.bindingRef !== 'string' ||
          !store.bindingRef ||
          store.placementPolicyGeneration !== parsed.placement.policyGeneration ||
          store.allocationScope !== parsed.placement.isolationPolicy ||
          (parsed.placement.isolationPolicy === 'tenant_exclusive'
            ? store.ownerTenantId !== parsed.tenantId
            : store.ownerTenantId !== null)
      )
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
  const routeIdentityProvided =
    options.dataRole !== undefined ||
    options.residencyPartition !== undefined ||
    options.shardId !== undefined ||
    options.bindingRef !== undefined ||
    options.requiredBindingRouteGeneration !== undefined;
  const roleStores = snapshot.stores.filter(
    (store) => store.tenantId === options.tenantId && store.role === options.role
  );
  let stores = roleIdentityCandidates(roleStores, options, shardGroup, shardIndex);
  if (routeIdentityProvided) {
    const roleAndResidencyStores = stores.filter(
      (store) =>
        (options.dataRole === undefined || store.dataRole === options.dataRole) &&
        (options.residencyPartition === undefined ||
          store.residencyPartition === options.residencyPartition)
    );
    if (roleAndResidencyStores.length === 0) {
      throw new TenantDatabaseResolverError(
        'route_role_residency_mismatch',
        'Runtime route role or residency does not match the signed tenant assignment',
        { tenantId: options.tenantId, role: options.role }
      );
    }
    stores = roleAndResidencyStores.filter(
      (store) =>
        (options.shardId === undefined || store.shardId === options.shardId) &&
        (options.bindingRef === undefined || store.bindingRef === options.bindingRef)
    );
  }
  if (stores.length > 1) {
    throw new TenantDatabaseResolverError(
      'invalid_route_contract',
      'Signed Runtime Registry contains an ambiguous route target',
      { tenantId: options.tenantId, role: options.role }
    );
  }
  if (stores.length === 0 && routeIdentityProvided) {
    throw new TenantDatabaseResolverError(
      'route_owner_mismatch',
      'Lookup route target is not assigned to the tenant in the signed Runtime Registry',
      { tenantId: options.tenantId, role: options.role }
    );
  }
  const store = stores[0] ?? null;
  if (!store) return null;
  if (
    (options.dataRole !== undefined && store.dataRole !== options.dataRole) ||
    (options.residencyPartition !== undefined &&
      store.residencyPartition !== options.residencyPartition)
  ) {
    throw new TenantDatabaseResolverError(
      'route_role_residency_mismatch',
      'Runtime route role or residency does not match the requested destination',
      { tenantId: options.tenantId, role: options.role }
    );
  }
  if (
    (options.shardId !== undefined && store.shardId !== options.shardId) ||
    (options.bindingRef !== undefined && store.bindingRef !== options.bindingRef)
  ) {
    throw new TenantDatabaseResolverError(
      'route_owner_mismatch',
      'Runtime route target does not match the signed tenant assignment',
      { tenantId: options.tenantId, role: options.role }
    );
  }
  if (
    options.requiredBindingRouteGeneration !== undefined &&
    store.bindingRouteGeneration !== options.requiredBindingRouteGeneration
  ) {
    throw new TenantDatabaseResolverError(
      'route_generation_mismatch',
      'Runtime route binding generation does not match the signed tenant assignment',
      { tenantId: options.tenantId, role: options.role }
    );
  }
  return store;
}

function roleIdentityCandidates(
  stores: TenantRuntimeRegistryStoreSnapshot[],
  options: TenantDatabaseResolveOptions,
  shardGroup: string,
  shardIndex: number
): TenantRuntimeRegistryStoreSnapshot[] {
  const routeIdentityProvided =
    options.dataRole !== undefined ||
    options.residencyPartition !== undefined ||
    options.shardId !== undefined ||
    options.bindingRef !== undefined ||
    options.requiredBindingRouteGeneration !== undefined;
  return routeIdentityProvided
    ? stores
    : stores.filter((store) => store.shardGroup === shardGroup && store.shardIndex === shardIndex);
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
    metadata_json: JSON.stringify({
      control_data_role: store.dataRole,
      control_residency_policy_id: store.residencyPolicyId,
      control_residency_partition: store.residencyPartition,
      control_shard_id: store.shardId,
      control_assignment_generation: store.assignmentGeneration,
      control_allocation_scope: store.allocationScope,
      control_owner_tenant_id: store.ownerTenantId,
      control_placement_policy_generation: store.placementPolicyGeneration,
    }),
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
    const rawSnapshot = await env.TENANT_RUNTIME_REGISTRY.get(snapshotKey);
    if (!rawSnapshot) return { status: 'missing' };
    snapshot = parseRuntimeRegistrySnapshot(rawSnapshot);
  } catch {
    return { status: 'invalid' };
  }
  if (!snapshot) return { status: 'invalid_contract' };
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
      createdAt: row.created_at,
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
      createdAt: row.created_at,
    });
    throw new TenantDatabaseResolverError(
      'missing_binding',
      'Runtime registry row is missing binding_ref',
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
        createdAt: row.created_at,
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
      resolutionSource: 'runtime_registry',
      dataRole: store.dataRole,
      residencyPolicyId: store.residencyPolicyId,
      residencyPartition: store.residencyPartition,
      shardId: store.shardId,
      assignmentGeneration: store.assignmentGeneration,
      bindingRouteGeneration: store.bindingRouteGeneration,
      placementPolicy: snapshot.placement,
      allocationScope: store.allocationScope,
      ownerTenantId: store.ownerTenantId,
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
  if (status === 'invalid_contract') {
    return new TenantDatabaseResolverError(
      'invalid_route_contract',
      `Runtime registry snapshot contract is invalid for ${options.tenantId}/${options.role}`,
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
  options: TenantDatabaseResolveOptions
): Promise<ResolvedTenantDatabaseSource> {
  const shardGroup = options.shardGroup ?? 'default';
  const shardIndex = options.shardIndex ?? 0;
  const deploymentTarget = getDeploymentTarget(env, options);
  const cacheKey = buildRequestCacheKey(options, deploymentTarget);
  const routeState = await assertRuntimeRouteAvailable(
    env,
    cacheKey,
    options.tenantId,
    deploymentTarget,
    options.generationCacheTtlMs ?? DEFAULT_TENANT_RUNTIME_GENERATION_MEMORY_CACHE_TTL_MS
  );
  if (!routeState) {
    throw new TenantDatabaseResolverError(
      'missing_generation',
      `Runtime registry generation is missing or invalid for ${options.tenantId}`,
      { tenantId: options.tenantId, role: options.role }
    );
  }
  const cached = options.requestCache?.get(cacheKey);
  if (
    cached?.resolutionSource === 'runtime_registry' &&
    cached.runtimeGeneration === routeState.runtimeGeneration
  ) {
    return cached;
  }
  if (cached) options.requestCache?.delete(cacheKey);
  const memoryCached = await getMemoryCachedTenantDatabase(
    cacheKey,
    env,
    options.tenantId,
    deploymentTarget,
    options.generationCacheTtlMs ?? DEFAULT_TENANT_RUNTIME_GENERATION_MEMORY_CACHE_TTL_MS
  );
  if (memoryCached?.resolutionSource === 'runtime_registry') {
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
  if (snapshotResult.status !== 'resolved') {
    throw createRequiredSnapshotError(snapshotResult.status, options);
  }
  options.requestCache?.set(cacheKey, snapshotResult.resolved);
  setMemoryCachedTenantDatabase(
    env,
    cacheKey,
    snapshotResult.resolved,
    options.memoryCacheTtlMs ?? DEFAULT_TENANT_DATABASE_RESOLVER_MEMORY_CACHE_TTL_MS
  );
  return snapshotResult.resolved;
}

export interface ResolveTenantAssignedDatabaseSourcesOptions {
  tenantId: string;
  role: TenantDatabaseRole;
  dataRole?: TenantRuntimeRegistryStoreSnapshot['dataRole'];
  residencyPartition?: string;
  minimumSchemaVersion?: number;
  deploymentTarget?: string;
  maxStores?: number;
  concurrency?: number;
}

/**
 * Resolve the complete signed, generation-bound store set for an administrative tenant-wide job.
 * Runtime account requests must use exact Lookup routes instead. The limits are request-local and
 * deliberately prevent an unbounded D1 fan-out.
 */
export async function resolveTenantAssignedDatabaseSourcesFromRegistry(
  env: TenantDatabaseResolverEnv,
  options: ResolveTenantAssignedDatabaseSourcesOptions
): Promise<ResolvedTenantDatabaseSource[]> {
  const maxStores = options.maxStores ?? 32;
  const concurrency = options.concurrency ?? 4;
  if (!Number.isSafeInteger(maxStores) || maxStores < 1 || maxStores > 64) {
    throw new TenantDatabaseResolverError('invalid_route_contract', 'Invalid store fan-out limit');
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new TenantDatabaseResolverError('invalid_route_contract', 'Invalid store concurrency');
  }
  if (!env.TENANT_RUNTIME_REGISTRY) {
    throw new TenantDatabaseResolverError('missing_snapshot', 'Runtime registry is unavailable');
  }

  const deploymentTarget = options.deploymentTarget ?? env.AUTHRIM_DEPLOYMENT_TARGET ?? 'default';
  const snapshotKey = buildTenantRuntimeRegistrySnapshotKey(options.tenantId, deploymentTarget);
  const generationKey = buildTenantRuntimeRegistryGenerationKey(options.tenantId, deploymentTarget);
  const [rawSnapshot, rawGeneration] = await Promise.all([
    env.TENANT_RUNTIME_REGISTRY.get(snapshotKey),
    env.TENANT_RUNTIME_REGISTRY.get(generationKey),
  ]);
  if (!rawSnapshot) {
    throw new TenantDatabaseResolverError(
      'missing_snapshot',
      'Runtime registry snapshot is missing'
    );
  }
  const snapshot = parseRuntimeRegistrySnapshot(rawSnapshot);
  if (!snapshot || snapshot.tenantId !== options.tenantId) {
    throw new TenantDatabaseResolverError(
      'invalid_route_contract',
      'Runtime registry snapshot is invalid'
    );
  }
  if (snapshot.deploymentTarget !== deploymentTarget) {
    throw new TenantDatabaseResolverError(
      'tenant_assigned_to_other_deployment_target',
      'Tenant is assigned to another deployment target'
    );
  }
  const generation = parseRuntimeGeneration(rawGeneration);
  if (!generation || generation.runtimeGeneration !== snapshot.runtimeGeneration) {
    throw new TenantDatabaseResolverError(
      'missing_generation',
      'Runtime generation is unavailable'
    );
  }
  if (generation.routeStatus !== 'active') {
    throw createQuarantinedRouteError(
      options.tenantId,
      generation.routeStatus,
      generation.quarantineDenyGeneration
    );
  }
  const signatureStatus = await verifyTenantRuntimeRegistrySnapshotSignature(
    snapshot,
    loadTenantRuntimeRegistryVerificationKeysFromEnv(env)
  );
  if (signatureStatus !== 'valid') {
    throw new TenantDatabaseResolverError(
      'invalid_snapshot_signature',
      'Runtime registry snapshot signature is invalid'
    );
  }
  if (snapshot.routeStatus !== 'active') {
    throw createQuarantinedRouteError(
      options.tenantId,
      snapshot.routeStatus,
      snapshot.quarantineDenyGeneration
    );
  }
  if (new Date(snapshot.expiresAt).getTime() <= Date.now()) {
    throw new TenantDatabaseResolverError(
      'expired_snapshot',
      'Runtime registry snapshot is expired'
    );
  }

  const stores = snapshot.stores
    .filter(
      (store) =>
        store.tenantId === options.tenantId &&
        store.role === options.role &&
        (options.dataRole === undefined || store.dataRole === options.dataRole) &&
        (options.residencyPartition === undefined ||
          store.residencyPartition === options.residencyPartition) &&
        isResolvableRegistryStatus(store.status)
    )
    .sort(
      (left, right) =>
        left.residencyPartition.localeCompare(right.residencyPartition) ||
        left.shardGroup.localeCompare(right.shardGroup) ||
        left.shardIndex - right.shardIndex
    );
  if (stores.length === 0) {
    throw new TenantDatabaseResolverError(
      'missing_registry_row',
      'No assigned tenant stores match the requested role'
    );
  }
  if (stores.length > maxStores) {
    throw new TenantDatabaseResolverError(
      'invalid_route_contract',
      'Assigned tenant store set exceeds the bounded fan-out limit',
      { storeCount: stores.length, maxStores }
    );
  }

  const requestCache: TenantDatabaseRequestCache = new Map();
  const results = new Array<ResolvedTenantDatabaseSource>(stores.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, stores.length) }, async () => {
      while (cursor < stores.length) {
        const index = cursor++;
        const store = stores[index];
        results[index] = await resolveTenantDatabaseSourceFromRegistry(env, {
          tenantId: options.tenantId,
          role: options.role,
          dataRole: store.dataRole,
          residencyPartition: store.residencyPartition,
          shardId: store.shardId,
          bindingRef: store.bindingRef!,
          requiredBindingRouteGeneration: store.bindingRouteGeneration,
          minimumSchemaVersion: options.minimumSchemaVersion,
          deploymentTarget,
          requestCache,
        });
      }
    })
  );
  return results;
}

/**
 * Control/management-only registry inspection path. Runtime request handlers must use
 * resolveTenantDatabaseSourceFromRegistry(), which accepts signed Runtime Registry state only.
 */
export async function resolveTenantDatabaseSourceFromControlRegistry(
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
      env,
      cacheKey,
      snapshotResult.resolved,
      options.memoryCacheTtlMs ?? DEFAULT_TENANT_DATABASE_RESOLVER_MEMORY_CACHE_TTL_MS
    );
    return snapshotResult.resolved;
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
      createdAt: row.created_at,
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
      createdAt: row.created_at,
    });
    throw new TenantDatabaseResolverError(
      'missing_binding',
      'Runtime registry row is missing binding_ref',
      { tenantId: options.tenantId, role: options.role }
    );
  }

  const route = parseControlRegistryRouteMetadata(row);
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
      createdAt: row.created_at,
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
    resolutionSource: 'control_registry',
    dataRole: route.dataRole,
    residencyPolicyId: route.residencyPolicyId,
    residencyPartition: route.residencyPartition,
    shardId: route.shardId,
    assignmentGeneration: route.assignmentGeneration,
    bindingRouteGeneration: row.generation,
    placementPolicy: route.placementPolicy,
    allocationScope: route.allocationScope,
    ownerTenantId: route.ownerTenantId,
    registryRow: row,
  };
  options.requestCache?.set(cacheKey, resolved);
  setMemoryCachedTenantDatabase(
    env,
    cacheKey,
    resolved,
    options.memoryCacheTtlMs ?? DEFAULT_TENANT_DATABASE_RESOLVER_MEMORY_CACHE_TTL_MS
  );
  return resolved;
}
