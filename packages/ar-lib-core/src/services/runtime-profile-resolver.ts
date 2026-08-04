import { ensureDatabaseAdapter, type DatabaseSource } from '../db/adapter-source';
import { createSettingsManager } from '../utils/settings-manager';
import { getTenantSettings } from '../utils/tenant-settings';
import { INFRASTRUCTURE_CATEGORY_META } from '../types/settings/infrastructure';
import type { InfrastructureSettings } from '../types/settings/infrastructure';
import type { TenantSettings } from '../types/settings/tenant';
import {
  DatabaseProfileRegistryBackend,
  KVProfileRegistryBackend,
  type ProfileRegistryBackend,
  RuntimeProfileRegistry,
  readEnvironmentProfileDefaults,
  readTenantProfileOverrides,
  resolveEffectiveProfileRefs,
  resolveRuntimeProfiles,
  type EffectiveProfileRefs,
  type EnvironmentProfileDefaults,
  type ResolvedRuntimeProfiles,
  type TenantProfileOverrides,
} from './profile-registry';

export interface RuntimeProfileResolverEnv {
  DB: DatabaseSource;
  SETTINGS?: KVNamespace;
  AUTHRIM_CONFIG?: KVNamespace;
  PROFILE_REGISTRY_BACKEND?: string;
  DEFAULT_AUDIT_PROFILE_ID?: string;
  DEFAULT_RESIDENCY_PROFILE_ID?: string;
}

function parseRegistryBackend(value: string | undefined): 'kv' | 'database' {
  return value === 'database' ? 'database' : 'kv';
}

function createReadOnlyBuiltinRegistryBackend(): ProfileRegistryBackend {
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

function pickInfrastructureEnv(env: RuntimeProfileResolverEnv): Record<string, string | undefined> {
  return {
    DEFAULT_AUDIT_PROFILE_ID: env.DEFAULT_AUDIT_PROFILE_ID,
    DEFAULT_RESIDENCY_PROFILE_ID: env.DEFAULT_RESIDENCY_PROFILE_ID,
  };
}

export async function loadEnvironmentProfileDefaultsFromEnv(
  env: RuntimeProfileResolverEnv
): Promise<EnvironmentProfileDefaults> {
  const manager = createSettingsManager({
    env: pickInfrastructureEnv(env),
    kv: env.SETTINGS ?? null,
    cacheTTL: 0,
  });
  manager.registerCategory(INFRASTRUCTURE_CATEGORY_META);

  const resolved = await manager.getAll('infrastructure', { type: 'platform' });
  return readEnvironmentProfileDefaults(resolved.values as Partial<InfrastructureSettings>);
}

export async function loadTenantProfileOverridesFromEnv(
  env: RuntimeProfileResolverEnv,
  tenantId: string
): Promise<TenantProfileOverrides> {
  const authrimSettings = await getTenantSettings(env.AUTHRIM_CONFIG, tenantId, 'tenant');
  const fallbackSettings =
    authrimSettings ?? (await getTenantSettings(env.SETTINGS, tenantId, 'tenant'));
  return readTenantProfileOverrides(fallbackSettings ?? undefined);
}

export function createRuntimeProfileRegistryFromEnv(
  env: RuntimeProfileResolverEnv
): RuntimeProfileRegistry {
  const backend = parseRegistryBackend(env.PROFILE_REGISTRY_BACKEND);

  if (backend === 'database') {
    return new RuntimeProfileRegistry(
      new DatabaseProfileRegistryBackend(ensureDatabaseAdapter(env.DB, 'profile-registry'))
    );
  }

  const kv = env.AUTHRIM_CONFIG ?? env.SETTINGS;
  if (!kv) {
    return new RuntimeProfileRegistry(createReadOnlyBuiltinRegistryBackend());
  }
  return new RuntimeProfileRegistry(new KVProfileRegistryBackend(kv));
}

export async function resolveEffectiveProfileRefsFromEnv(
  env: RuntimeProfileResolverEnv,
  tenantId: string
): Promise<EffectiveProfileRefs> {
  const [defaults, overrides] = await Promise.all([
    loadEnvironmentProfileDefaultsFromEnv(env),
    loadTenantProfileOverridesFromEnv(env, tenantId),
  ]);
  return resolveEffectiveProfileRefs(defaults, overrides);
}

export async function resolveTenantRuntimeProfilesFromEnv(
  env: RuntimeProfileResolverEnv,
  tenantId: string
): Promise<ResolvedRuntimeProfiles> {
  const refs = await resolveEffectiveProfileRefsFromEnv(env, tenantId);
  const registry = createRuntimeProfileRegistryFromEnv(env);
  return resolveRuntimeProfiles(registry, refs);
}
