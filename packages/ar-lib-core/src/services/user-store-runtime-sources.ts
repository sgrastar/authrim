import { type DatabaseSource } from '../db';
import type { StorageProfile } from '../types/runtime-profile';
import {
  resolveTenantRuntimeProfilesFromEnv,
  type RuntimeProfileResolverEnv,
} from './runtime-profile-resolver';
import {
  getBoundStorageTargetSource,
  getOptionalStorageLogicalSourceTarget,
  getOptionalStorageSliceTarget,
} from './storage-target-resolver';
import { findUnsupportedStorageProfileRouteCapability } from './storage-profile-capabilities';
import {
  resolveTenantDatabaseSourceForTarget,
  type ResolvedTenantDatabaseSource,
  TenantDatabaseResolverError,
} from './tenant-database-resolver';
import type { UserCacheScope, UserPiiCacheMode } from '../utils/kv';

export interface UserStoreRuntimeSourceEnv extends RuntimeProfileResolverEnv {
  DB: DatabaseSource;
  DB_PII?: DatabaseSource;
  DB_ADMIN?: DatabaseSource;
  TENANT_RUNTIME_REGISTRY?: { get(key: string): Promise<string | null> };
  AUTHRIM_DEPLOYMENT_TARGET?: string;
  PII_CACHE_MODE?: string;
}

export interface ResolvedUserStoreRuntimeSources {
  storageProfile: StorageProfile;
  coreDb: DatabaseSource;
  piiDb: DatabaseSource | null;
  policyDb: DatabaseSource | null;
  userCacheScope: UserCacheScope;
  piiCacheMode: UserPiiCacheMode;
}

interface ResolvedRuntimeSource {
  source: DatabaseSource;
  tenantStore?: ResolvedTenantDatabaseSource;
}

function buildUserCacheScope(
  storageProfile: StorageProfile,
  core: ResolvedRuntimeSource | null,
  pii: ResolvedRuntimeSource | null
): UserCacheScope {
  const coreGeneration = core?.tenantStore?.runtimeGeneration ?? core?.tenantStore?.generation ?? 0;
  const piiGeneration = pii?.tenantStore?.runtimeGeneration ?? pii?.tenantStore?.generation ?? 0;
  const coreSchema = core?.tenantStore?.schemaVersion ?? 1;
  const piiSchema = pii?.tenantStore?.schemaVersion ?? 1;

  return {
    storageProfileId: storageProfile.id,
    sourceGeneration: `core:${coreGeneration}:pii:${piiGeneration}`,
    schemaVersion: `core:${coreSchema}:pii:${piiSchema}`,
  };
}

function getDefaultPiiCacheMode(
  env: UserStoreRuntimeSourceEnv,
  _storageProfile: StorageProfile
): UserPiiCacheMode {
  if (
    env.PII_CACHE_MODE === 'merged' ||
    env.PII_CACHE_MODE === 'encrypted_short_ttl' ||
    env.PII_CACHE_MODE === 'no_cross_request_pii'
  ) {
    return env.PII_CACHE_MODE;
  }
  return 'encrypted_short_ttl';
}

function getTenantRuntimeSnapshotMode(
  env: UserStoreRuntimeSourceEnv,
  storageProfile: StorageProfile
): 'optional' | 'required' {
  if (storageProfile.id !== 'builtin:storage:tenant-d1') {
    return 'optional';
  }
  return env.TENANT_RUNTIME_REGISTRY ? 'required' : 'optional';
}

function areStorageTargetsEquivalent(
  left: NonNullable<ReturnType<typeof getOptionalStorageSliceTarget>>,
  right: NonNullable<ReturnType<typeof getOptionalStorageLogicalSourceTarget>>
): boolean {
  return (
    left.driver === right.driver &&
    left.bindingRef === right.bindingRef &&
    left.connectionRef === right.connectionRef &&
    left.resolverRef === right.resolverRef &&
    left.role === right.role
  );
}

export async function resolveUserStoreRuntimeSourcesFromEnv(
  env: UserStoreRuntimeSourceEnv,
  tenantId: string,
  options: { requestPath?: string } = {}
): Promise<ResolvedUserStoreRuntimeSources> {
  const resolved = await resolveTenantRuntimeProfilesFromEnv(env, tenantId);
  const storageProfile = resolved.storageProfile;
  const unsupportedRouteCapability = findUnsupportedStorageProfileRouteCapability(
    storageProfile,
    options.requestPath
  );
  if (unsupportedRouteCapability) {
    throw new TenantDatabaseResolverError(
      'unsupported_storage_profile',
      `Storage profile ${storageProfile.id} does not support ${options.requestPath}`,
      {
        tenantId,
        storageProfileId: storageProfile.id,
        route: options.requestPath,
        capability: unsupportedRouteCapability.id,
      }
    );
  }

  const coreTarget = getOptionalStorageSliceTarget(storageProfile, 'identity_core');
  const piiTarget =
    getOptionalStorageSliceTarget(storageProfile, 'identity_pii') ??
    getOptionalStorageSliceTarget(storageProfile, 'custom_pii');
  const policyTarget =
    getOptionalStorageLogicalSourceTarget(storageProfile, 'policy') ?? coreTarget;
  const bindingFallbacks = {
    DB_PII: env.DB_PII ?? env.DB,
  };
  const resolveSource = async (
    target: NonNullable<typeof coreTarget> | NonNullable<typeof piiTarget>
  ): Promise<ResolvedRuntimeSource> => {
    if (target.resolverRef) {
      const tenantStore = await resolveTenantDatabaseSourceForTarget(env, tenantId, target, {
        deploymentTarget: env.AUTHRIM_DEPLOYMENT_TARGET,
        runtimeSnapshotMode: getTenantRuntimeSnapshotMode(env, storageProfile),
      });
      return {
        source: tenantStore.source,
        tenantStore,
      };
    }
    return {
      source: getBoundStorageTargetSource(env, target, {
        fallbackBindingRefs: bindingFallbacks,
      }),
    };
  };

  const resolvedCore = coreTarget ? await resolveSource(coreTarget) : { source: env.DB };
  const resolvedPii = piiTarget
    ? await resolveSource(piiTarget)
    : { source: env.DB_PII ?? env.DB ?? null };
  const resolvedPolicy =
    policyTarget && coreTarget && areStorageTargetsEquivalent(coreTarget, policyTarget)
      ? resolvedCore
      : policyTarget
        ? await resolveSource(policyTarget)
        : resolvedCore;
  const piiDb = resolvedPii.source ?? null;

  return {
    storageProfile,
    coreDb: resolvedCore.source,
    piiDb,
    policyDb: resolvedPolicy.source ?? null,
    userCacheScope: buildUserCacheScope(storageProfile, resolvedCore, piiDb ? resolvedPii : null),
    piiCacheMode: getDefaultPiiCacheMode(env, storageProfile),
  };
}
