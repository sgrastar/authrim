import { ensureDatabaseAdapter } from '../db';
import { getEffectiveAuthCoreTarget } from './storage-boundary-policy';
import { createRuntimeProfileRegistryFromEnv, loadEnvironmentProfileDefaultsFromEnv, } from './runtime-profile-resolver';
import { getBoundStorageTargetSource } from './storage-target-resolver';
export const AUTH_CORE_PERSISTENCE_CONTEXT_KEY = 'm:auth-core-persistence-context';
const authCorePersistenceContextCache = new WeakMap();
export async function resolveAuthCorePersistenceContextFromEnv(env) {
    const defaults = await loadEnvironmentProfileDefaultsFromEnv(env);
    const registry = createRuntimeProfileRegistryFromEnv(env);
    const storageProfile = await registry.get('storage', defaults.storageProfileId);
    if (!storageProfile) {
        throw new Error(`storage_profile_not_found:${defaults.storageProfileId}`);
    }
    return {
        storageProfileId: storageProfile.id,
        coreTarget: getEffectiveAuthCoreTarget(storageProfile),
    };
}
export function getCachedAuthCorePersistenceContextFromEnv(env) {
    const cacheKey = env;
    const cached = authCorePersistenceContextCache.get(cacheKey);
    if (cached) {
        return cached;
    }
    const pending = resolveAuthCorePersistenceContextFromEnv(env);
    authCorePersistenceContextCache.set(cacheKey, pending);
    return pending;
}
export function resolveAuthCorePersistenceSourceFromContext(env, context) {
    return getBoundStorageTargetSource(env, context.coreTarget, {
        fallbackBindingRefs: {
            DB_PII: env.DB_PII ?? env.DB,
        },
    });
}
export async function resolveAuthCorePersistenceSourceFromEnv(env) {
    const context = await getCachedAuthCorePersistenceContextFromEnv(env);
    return resolveAuthCorePersistenceSourceFromContext(env, context);
}
export async function resolveAuthCorePersistenceAdapterFromEnv(env, partition = 'auth-core') {
    const source = await resolveAuthCorePersistenceSourceFromEnv(env);
    return ensureDatabaseAdapter(source, partition);
}
