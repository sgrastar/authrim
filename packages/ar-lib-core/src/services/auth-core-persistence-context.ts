import { ensureDatabaseAdapter, type DatabaseAdapter, type DatabaseSource } from '../db';
import type {
  StorageLogicalSource,
  StorageDeploymentProfile,
  StorageProfile,
  StorageTarget,
  TransientAuthStoragePolicy,
} from '../types/runtime-profile';
import { getEffectiveAuthCoreTarget } from './storage-boundary-policy';
import {
  createRuntimeProfileRegistryFromEnv,
  loadEnvironmentProfileDefaultsFromEnv,
  type RuntimeProfileResolverEnv,
} from './runtime-profile-resolver';
import {
  getBoundStorageTargetSource,
  getOptionalStorageLogicalSourceTarget,
} from './storage-target-resolver';
import {
  resolveTenantDatabaseSourceForTarget,
  type TenantDatabaseRequestCache,
} from './tenant-database-resolver';

export interface AuthCorePersistenceContext {
  storageProfileId: string;
  storageProfile: StorageProfile;
  coreTarget: StorageTarget;
  transientAuth: TransientAuthStoragePolicy;
}

export interface AuthCorePersistenceEnv extends RuntimeProfileResolverEnv {
  DB: DatabaseSource;
  DB_PII?: DatabaseSource;
  DB_ADMIN?: DatabaseSource;
  TENANT_RUNTIME_REGISTRY?: { get(key: string): Promise<string | null> };
  AUTHRIM_DEPLOYMENT_TARGET?: string;
}

export interface AuthCorePersistenceResolveOptions {
  tenantId?: string;
  logicalSource?: StorageLogicalSource;
  requestCache?: TenantDatabaseRequestCache;
  runtimeSnapshotMode?: 'optional' | 'required';
}

const authCorePersistenceContextCache = new WeakMap<object, AuthCorePersistenceContext>();

function defaultTransientAuthStoragePolicy(
  deploymentProfile: StorageDeploymentProfile | undefined
): TransientAuthStoragePolicy {
  if (deploymentProfile === 'tenant-d1') {
    return {
      sessionColdPersistence: 'disabled',
      sessionClientMirror: 'async',
      deviceCibaColdPersistence: 'disabled',
      externalDurableMirror: 'disabled',
    };
  }

  if (deploymentProfile === 'external-durable') {
    return {
      sessionColdPersistence: 'disabled',
      sessionClientMirror: 'async',
      deviceCibaColdPersistence: 'disabled',
      externalDurableMirror: 'future',
    };
  }

  return {
    sessionColdPersistence: 'enabled',
    sessionClientMirror: 'sync',
    deviceCibaColdPersistence: 'enabled',
    externalDurableMirror: 'disabled',
  };
}

export function resolveTransientAuthStoragePolicy(
  storageProfile: StorageProfile
): TransientAuthStoragePolicy {
  return (
    storageProfile.transientAuth ??
    defaultTransientAuthStoragePolicy(storageProfile.deploymentProfile)
  );
}

export async function resolveAuthCorePersistenceContextFromEnv(
  env: AuthCorePersistenceEnv
): Promise<AuthCorePersistenceContext> {
  const defaults = await loadEnvironmentProfileDefaultsFromEnv(env);
  const registry = createRuntimeProfileRegistryFromEnv(env);
  const storageProfile = await registry.get<StorageProfile>('storage', defaults.storageProfileId);

  if (!storageProfile) {
    throw new Error(`storage_profile_not_found:${defaults.storageProfileId}`);
  }

  return {
    storageProfileId: storageProfile.id,
    storageProfile,
    coreTarget: getEffectiveAuthCoreTarget(storageProfile),
    transientAuth: resolveTransientAuthStoragePolicy(storageProfile),
  };
}

export async function getCachedAuthCorePersistenceContextFromEnv(
  env: AuthCorePersistenceEnv
): Promise<AuthCorePersistenceContext> {
  const cacheKey = env as object;
  const cached = authCorePersistenceContextCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const context = await resolveAuthCorePersistenceContextFromEnv(env);
  authCorePersistenceContextCache.set(cacheKey, context);
  return context;
}

export function resolveAuthCorePersistenceSourceFromContext(
  env: AuthCorePersistenceEnv,
  context: AuthCorePersistenceContext,
  options: AuthCorePersistenceResolveOptions = {}
): DatabaseSource {
  const target =
    options.logicalSource &&
    getOptionalStorageLogicalSourceTarget(context.storageProfile, options.logicalSource)
      ? getOptionalStorageLogicalSourceTarget(context.storageProfile, options.logicalSource)
      : context.coreTarget;

  if (target?.resolverRef) {
    if (options.tenantId) {
      throw new Error('auth_core_tenant_resolution_requires_async_source');
    }

    // Compatibility path for deployment/control-plane code that still uses the historical
    // auth-core helper without a tenant. Tenant-owned data paths must pass tenantId and use
    // resolveAuthCorePersistenceSourceFromEnv(), which can resolve the tenant registry async.
    return env.DB;
  }

  return getBoundStorageTargetSource(env, target ?? context.coreTarget, {
    fallbackBindingRefs: {
      DB_PII: env.DB_PII ?? env.DB,
      DB_ADMIN: env.DB_ADMIN ?? env.DB,
    },
  });
}

export async function resolveAuthCorePersistenceSourceFromEnv(
  env: AuthCorePersistenceEnv,
  options: AuthCorePersistenceResolveOptions = {}
): Promise<DatabaseSource> {
  const context = await getCachedAuthCorePersistenceContextFromEnv(env);
  const target =
    options.logicalSource &&
    getOptionalStorageLogicalSourceTarget(context.storageProfile, options.logicalSource)
      ? getOptionalStorageLogicalSourceTarget(context.storageProfile, options.logicalSource)
      : context.coreTarget;

  if (target?.resolverRef) {
    if (!options.tenantId) {
      return env.DB;
    }
    const resolved = await resolveTenantDatabaseSourceForTarget(env, options.tenantId, target, {
      deploymentTarget: env.AUTHRIM_DEPLOYMENT_TARGET,
      requestCache: options.requestCache,
      runtimeSnapshotMode:
        options.runtimeSnapshotMode ??
        (context.storageProfile.id === 'builtin:storage:tenant-d1' && env.TENANT_RUNTIME_REGISTRY
          ? 'required'
          : 'optional'),
    });
    return resolved.source;
  }

  return resolveAuthCorePersistenceSourceFromContext(env, context, options);
}

export async function resolveAuthCorePersistenceAdapterFromEnv(
  env: AuthCorePersistenceEnv,
  partition: string = 'auth-core',
  options: AuthCorePersistenceResolveOptions = {}
): Promise<DatabaseAdapter> {
  const source = await resolveAuthCorePersistenceSourceFromEnv(env, options);
  return ensureDatabaseAdapter(source, partition);
}
