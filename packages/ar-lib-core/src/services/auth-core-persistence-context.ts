import { ensureDatabaseAdapter, type DatabaseAdapter, type DatabaseSource } from '../db';
import type { StorageProfile, StorageTarget } from '../types/runtime-profile';
import { getEffectiveAuthCoreTarget } from './storage-boundary-policy';
import {
  createRuntimeProfileRegistryFromEnv,
  loadEnvironmentProfileDefaultsFromEnv,
  type RuntimeProfileResolverEnv,
} from './runtime-profile-resolver';
import { getBoundStorageTargetSource } from './storage-target-resolver';

export const AUTH_CORE_PERSISTENCE_CONTEXT_KEY = 'm:auth-core-persistence-context';

export interface AuthCorePersistenceContext {
  storageProfileId: string;
  coreTarget: StorageTarget;
}

export interface AuthCorePersistenceEnv extends RuntimeProfileResolverEnv {
  DB: DatabaseSource;
  DB_PII?: DatabaseSource;
}

const authCorePersistenceContextCache = new WeakMap<object, Promise<AuthCorePersistenceContext>>();

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
    coreTarget: getEffectiveAuthCoreTarget(storageProfile),
  };
}

export function getCachedAuthCorePersistenceContextFromEnv(
  env: AuthCorePersistenceEnv
): Promise<AuthCorePersistenceContext> {
  const cacheKey = env as object;
  const cached = authCorePersistenceContextCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = resolveAuthCorePersistenceContextFromEnv(env);
  authCorePersistenceContextCache.set(cacheKey, pending);
  return pending;
}

export function resolveAuthCorePersistenceSourceFromContext(
  env: AuthCorePersistenceEnv,
  context: AuthCorePersistenceContext
): DatabaseSource {
  return getBoundStorageTargetSource(env, context.coreTarget, {
    fallbackBindingRefs: {
      DB_PII: env.DB_PII ?? env.DB,
    },
  });
}

export async function resolveAuthCorePersistenceSourceFromEnv(
  env: AuthCorePersistenceEnv
): Promise<DatabaseSource> {
  const context = await getCachedAuthCorePersistenceContextFromEnv(env);
  return resolveAuthCorePersistenceSourceFromContext(env, context);
}

export async function resolveAuthCorePersistenceAdapterFromEnv(
  env: AuthCorePersistenceEnv,
  partition: string = 'auth-core'
): Promise<DatabaseAdapter> {
  const source = await resolveAuthCorePersistenceSourceFromEnv(env);
  return ensureDatabaseAdapter(source, partition);
}
