import {
  buildTenantRuntimeRegistryGenerationKey,
  buildTenantRuntimeRegistrySnapshotKey,
  ensureDatabaseAdapter,
  loadTenantRuntimeRegistryVerificationKeysFromEnv,
  publishTenantRuntimeRegistrySnapshot,
  reactivateTenantRuntimeRegistryRouteState,
  RUNTIME_REGISTRY_SNAPSHOT_VERSION,
  TenantDatabaseRegistryRepository,
  transitionTenantRuntimeRegistryRouteState,
  verifyTenantRuntimeRegistrySnapshotSignature,
  type Env,
  type TenantRuntimeRegistryGenerationDocument,
  type TenantRuntimeRegistryRouteStatus,
  type TenantRuntimeRegistrySnapshot,
} from '@authrim/ar-lib-core';
import { createControlRuntimeRegistrySigner } from './control-runtime-registry-signer';
import { resolveTenantRuntimePlacementSnapshot } from './tenant-runtime-placement';

export interface PublishTenantRuntimeRegistryRouteStateOptions {
  tenantId: string;
  routeStatus: Exclude<TenantRuntimeRegistryRouteStatus, 'active'>;
  operationId: string;
  actorId: string;
  now?: Date;
}

export interface PublishTenantRuntimeRegistryRouteStateResult {
  runtimeGeneration: number;
  routeStatus: Exclude<TenantRuntimeRegistryRouteStatus, 'active'>;
  quarantineDenyGeneration: number;
  changed: boolean;
  publishedAt: string;
}

export interface ReactivateTenantRuntimeRegistryRouteStateOptions {
  tenantId: string;
  operationId: string;
  actorId: string;
  expectedQuarantineDenyGeneration: number;
  now?: Date;
}

export interface ReactivateTenantRuntimeRegistryRouteStateResult {
  runtimeGeneration: number;
  routeStatus: 'active';
  quarantineDenyGeneration: number;
  publishedAt: string;
}

function parseGenerationDocument(value: string | null): TenantRuntimeRegistryGenerationDocument {
  if (!value) throw new Error('tenant_runtime_registry_route_state_generation_missing');
  let parsed: TenantRuntimeRegistryGenerationDocument;
  try {
    parsed = JSON.parse(value) as TenantRuntimeRegistryGenerationDocument;
  } catch {
    throw new Error('tenant_runtime_registry_route_state_generation_invalid');
  }
  if (
    !Number.isSafeInteger(parsed.runtimeGeneration) ||
    parsed.runtimeGeneration < 1 ||
    (parsed.routeStatus !== 'quarantining' &&
      parsed.routeStatus !== 'quarantined' &&
      parsed.routeStatus !== 'disabled') ||
    !Number.isSafeInteger(parsed.quarantineDenyGeneration) ||
    parsed.quarantineDenyGeneration < 1
  ) {
    throw new Error('tenant_runtime_registry_route_state_generation_invalid');
  }
  return parsed;
}

function parseSnapshot(value: string | null): TenantRuntimeRegistrySnapshot {
  if (!value) throw new Error('tenant_runtime_registry_route_state_snapshot_missing');
  try {
    return JSON.parse(value) as TenantRuntimeRegistrySnapshot;
  } catch {
    throw new Error('tenant_runtime_registry_route_state_snapshot_invalid');
  }
}

function parseActiveGenerationDocument(
  value: string | null,
  expectedDenyGeneration: number
): TenantRuntimeRegistryGenerationDocument {
  if (!value) throw new Error('tenant_runtime_registry_reactivation_generation_missing');
  let parsed: TenantRuntimeRegistryGenerationDocument;
  try {
    parsed = JSON.parse(value) as TenantRuntimeRegistryGenerationDocument;
  } catch {
    throw new Error('tenant_runtime_registry_reactivation_generation_invalid');
  }
  if (
    !Number.isSafeInteger(parsed.runtimeGeneration) ||
    parsed.runtimeGeneration < 1 ||
    parsed.routeStatus !== 'active' ||
    parsed.quarantineDenyGeneration !== expectedDenyGeneration
  ) {
    throw new Error('tenant_runtime_registry_reactivation_generation_invalid');
  }
  return parsed;
}

export async function publishTenantRuntimeRegistryRouteState(
  env: Env,
  options: PublishTenantRuntimeRegistryRouteStateOptions
): Promise<PublishTenantRuntimeRegistryRouteStateResult> {
  if (!env.DB_ADMIN || !env.TENANT_RUNTIME_REGISTRY) {
    throw new Error('tenant_runtime_registry_route_state_unavailable');
  }
  const repository = new TenantDatabaseRegistryRepository(
    ensureDatabaseAdapter(env.DB_ADMIN, 'tenant-runtime-registry-route-state')
  );
  const transition = await transitionTenantRuntimeRegistryRouteState(repository, options);
  const deploymentTarget =
    (env as Env & { AUTHRIM_DEPLOYMENT_TARGET?: string }).AUTHRIM_DEPLOYMENT_TARGET?.trim() ||
    'default';
  const publication = await publishTenantRuntimeRegistrySnapshot({
    tenantId: options.tenantId,
    placement: await resolveTenantRuntimePlacementSnapshot(env, options.tenantId),
    repository,
    snapshotStore: env.TENANT_RUNTIME_REGISTRY,
    deploymentTarget,
    now: options.now,
    actorId: options.actorId,
    externalSigner: await createControlRuntimeRegistrySigner(env),
  });

  const generation = parseGenerationDocument(
    await env.TENANT_RUNTIME_REGISTRY.get(
      buildTenantRuntimeRegistryGenerationKey(options.tenantId, deploymentTarget)
    )
  );
  const snapshot = parseSnapshot(
    await env.TENANT_RUNTIME_REGISTRY.get(
      buildTenantRuntimeRegistrySnapshotKey(options.tenantId, deploymentTarget)
    )
  );
  const signatureStatus = await verifyTenantRuntimeRegistrySnapshotSignature(
    snapshot,
    loadTenantRuntimeRegistryVerificationKeysFromEnv(env)
  );
  if (
    signatureStatus !== 'valid' ||
    snapshot.version !== RUNTIME_REGISTRY_SNAPSHOT_VERSION ||
    snapshot.tenantId !== options.tenantId ||
    snapshot.deploymentTarget !== deploymentTarget ||
    !Number.isFinite(Date.parse(snapshot.expiresAt)) ||
    Date.parse(snapshot.expiresAt) <= (options.now ?? new Date()).getTime() ||
    generation.runtimeGeneration !== publication.snapshot.runtimeGeneration ||
    generation.runtimeGeneration !== snapshot.runtimeGeneration ||
    generation.routeStatus !== options.routeStatus ||
    snapshot.routeStatus !== options.routeStatus ||
    generation.quarantineDenyGeneration !== transition.quarantineDenyGeneration ||
    snapshot.quarantineDenyGeneration !== transition.quarantineDenyGeneration
  ) {
    throw new Error('tenant_runtime_registry_route_state_readback_failed');
  }

  return {
    runtimeGeneration: transition.runtimeGeneration,
    routeStatus: options.routeStatus,
    quarantineDenyGeneration: transition.quarantineDenyGeneration,
    changed: transition.changed,
    publishedAt: publication.snapshot.publishedAt,
  };
}

export async function publishTenantRuntimeRegistryReactivation(
  env: Env,
  options: ReactivateTenantRuntimeRegistryRouteStateOptions
): Promise<ReactivateTenantRuntimeRegistryRouteStateResult> {
  if (!env.DB_ADMIN || !env.TENANT_RUNTIME_REGISTRY) {
    throw new Error('tenant_runtime_registry_route_state_unavailable');
  }
  const repository = new TenantDatabaseRegistryRepository(
    ensureDatabaseAdapter(env.DB_ADMIN, 'tenant-runtime-registry-reactivation')
  );
  const transition = await reactivateTenantRuntimeRegistryRouteState(repository, options);
  const deploymentTarget =
    (env as Env & { AUTHRIM_DEPLOYMENT_TARGET?: string }).AUTHRIM_DEPLOYMENT_TARGET?.trim() ||
    'default';
  const publication = await publishTenantRuntimeRegistrySnapshot({
    tenantId: options.tenantId,
    placement: await resolveTenantRuntimePlacementSnapshot(env, options.tenantId),
    repository,
    snapshotStore: env.TENANT_RUNTIME_REGISTRY,
    deploymentTarget,
    now: options.now,
    actorId: options.actorId,
    externalSigner: await createControlRuntimeRegistrySigner(env),
  });
  const generation = parseActiveGenerationDocument(
    await env.TENANT_RUNTIME_REGISTRY.get(
      buildTenantRuntimeRegistryGenerationKey(options.tenantId, deploymentTarget)
    ),
    options.expectedQuarantineDenyGeneration
  );
  const snapshot = parseSnapshot(
    await env.TENANT_RUNTIME_REGISTRY.get(
      buildTenantRuntimeRegistrySnapshotKey(options.tenantId, deploymentTarget)
    )
  );
  const signatureStatus = await verifyTenantRuntimeRegistrySnapshotSignature(
    snapshot,
    loadTenantRuntimeRegistryVerificationKeysFromEnv(env)
  );
  if (
    signatureStatus !== 'valid' ||
    snapshot.version !== RUNTIME_REGISTRY_SNAPSHOT_VERSION ||
    snapshot.tenantId !== options.tenantId ||
    snapshot.deploymentTarget !== deploymentTarget ||
    snapshot.routeStatus !== 'active' ||
    snapshot.quarantineDenyGeneration !== options.expectedQuarantineDenyGeneration ||
    snapshot.runtimeGeneration !== transition.runtimeGeneration ||
    generation.runtimeGeneration !== transition.runtimeGeneration ||
    publication.snapshot.runtimeGeneration !== transition.runtimeGeneration ||
    !Number.isFinite(Date.parse(snapshot.expiresAt)) ||
    Date.parse(snapshot.expiresAt) <= (options.now ?? new Date()).getTime()
  ) {
    throw new Error('tenant_runtime_registry_reactivation_readback_failed');
  }
  return {
    runtimeGeneration: transition.runtimeGeneration,
    routeStatus: 'active',
    quarantineDenyGeneration: transition.quarantineDenyGeneration,
    publishedAt: publication.snapshot.publishedAt,
  };
}
