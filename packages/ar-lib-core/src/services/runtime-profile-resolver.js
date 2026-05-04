import { ensureDatabaseAdapter } from '../db/adapter-source';
import { createSettingsManager } from '../utils/settings-manager';
import { getTenantSettings } from '../utils/tenant-settings';
import { INFRASTRUCTURE_CATEGORY_META } from '../types/settings/infrastructure';
import { DatabaseProfileRegistryBackend, KVProfileRegistryBackend, RuntimeProfileRegistry, readEnvironmentProfileDefaults, readTenantProfileOverrides, resolveEffectiveProfileRefs, resolveRuntimeProfiles, } from './profile-registry';
function parseRegistryBackend(value) {
    return value === 'database' ? 'database' : 'kv';
}
function createReadOnlyBuiltinRegistryBackend() {
    return {
        async get() {
            return null;
        },
        async list() {
            return [];
        },
        async put() {
            throw new Error('profile_registry_backend_not_configured');
        },
        async delete() {
            throw new Error('profile_registry_backend_not_configured');
        },
    };
}
function pickInfrastructureEnv(env) {
    return {
        DEFAULT_STORAGE_PROFILE_ID: env.DEFAULT_STORAGE_PROFILE_ID,
        DEFAULT_AUDIT_PROFILE_ID: env.DEFAULT_AUDIT_PROFILE_ID,
        DEFAULT_RESIDENCY_PROFILE_ID: env.DEFAULT_RESIDENCY_PROFILE_ID,
    };
}
export async function loadEnvironmentProfileDefaultsFromEnv(env) {
    const manager = createSettingsManager({
        env: pickInfrastructureEnv(env),
        kv: env.SETTINGS ?? null,
        cacheTTL: 0,
    });
    manager.registerCategory(INFRASTRUCTURE_CATEGORY_META);
    const resolved = await manager.getAll('infrastructure', { type: 'platform' });
    return readEnvironmentProfileDefaults(resolved.values);
}
export async function loadTenantProfileOverridesFromEnv(env, tenantId) {
    const authrimSettings = await getTenantSettings(env.AUTHRIM_CONFIG, tenantId, 'tenant');
    const fallbackSettings = authrimSettings ?? (await getTenantSettings(env.SETTINGS, tenantId, 'tenant'));
    return readTenantProfileOverrides(fallbackSettings ?? undefined);
}
export function createRuntimeProfileRegistryFromEnv(env) {
    const backend = parseRegistryBackend(env.PROFILE_REGISTRY_BACKEND);
    if (backend === 'database') {
        return new RuntimeProfileRegistry(new DatabaseProfileRegistryBackend(ensureDatabaseAdapter(env.DB, 'profile-registry')));
    }
    const kv = env.AUTHRIM_CONFIG ?? env.SETTINGS;
    if (!kv) {
        return new RuntimeProfileRegistry(createReadOnlyBuiltinRegistryBackend());
    }
    return new RuntimeProfileRegistry(new KVProfileRegistryBackend(kv));
}
export async function resolveEffectiveProfileRefsFromEnv(env, tenantId) {
    const [defaults, overrides] = await Promise.all([
        loadEnvironmentProfileDefaultsFromEnv(env),
        loadTenantProfileOverridesFromEnv(env, tenantId),
    ]);
    return resolveEffectiveProfileRefs(defaults, overrides);
}
export async function resolveTenantRuntimeProfilesFromEnv(env, tenantId) {
    const refs = await resolveEffectiveProfileRefsFromEnv(env, tenantId);
    const registry = createRuntimeProfileRegistryFromEnv(env);
    return resolveRuntimeProfiles(registry, refs);
}
