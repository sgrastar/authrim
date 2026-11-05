import { ensureDatabaseAdapter, type DatabaseSource } from '../db/adapter-source';
import { createSettingsManager } from '../utils/settings-manager';
import { getTenantSettingsDocument } from '../utils/tenant-settings';
import type { AuditProfile } from '../types/runtime-profile';
import { INFRASTRUCTURE_CATEGORY_META } from '../types/settings/infrastructure';
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

/** `strict`: a platform document that cannot be read throws instead of reading as empty. */
export interface RuntimeProfileReadOptions {
  strict?: boolean;
}

export async function loadEnvironmentProfileDefaultsFromEnv(
  env: RuntimeProfileResolverEnv,
  options: RuntimeProfileReadOptions = {}
): Promise<EnvironmentProfileDefaults> {
  const manager = createSettingsManager({
    env: pickInfrastructureEnv(env),
    kv: env.SETTINGS ?? null,
    cacheTTL: 0,
    strictReads: options.strict === true,
  });
  manager.registerCategory(INFRASTRUCTURE_CATEGORY_META);

  const resolved = await manager.getAll('infrastructure', { type: 'platform' });
  return readEnvironmentProfileDefaults(resolved.values);
}

export async function loadTenantProfileOverridesFromEnv(
  env: RuntimeProfileResolverEnv,
  tenantId: string
): Promise<TenantProfileOverrides> {
  const settings = await getTenantSettingsDocument(env, tenantId, 'tenant');
  return readTenantProfileOverrides(settings ?? undefined);
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
  tenantId: string,
  options: RuntimeProfileReadOptions = {}
): Promise<EffectiveProfileRefs> {
  const [defaults, overrides] = await Promise.all([
    loadEnvironmentProfileDefaultsFromEnv(env, options),
    loadTenantProfileOverridesFromEnv(env, tenantId),
  ]);
  return resolveEffectiveProfileRefs(defaults, overrides);
}

export async function resolveTenantRuntimeProfilesFromEnv(
  env: RuntimeProfileResolverEnv,
  tenantId: string,
  options: RuntimeProfileReadOptions = {}
): Promise<ResolvedRuntimeProfiles> {
  const refs = await resolveEffectiveProfileRefsFromEnv(env, tenantId, options);
  const registry = createRuntimeProfileRegistryFromEnv(env);
  return resolveRuntimeProfiles(registry, refs);
}

/**
 * The audit profile that applies to a tenant, resolved on its own. Audit delivery and retention
 * must not depend on residency: a missing residency profile (an id nobody registered, a profile
 * deleted while in use) makes `resolveTenantRuntimeProfilesFromEnv` throw for the whole set, and
 * the audit service then falls back to the built-in audit profile. Callers that need only the
 * audit profile use this, so a change to residency cannot change where logs go or how long
 * they are kept.
 */
export async function resolveTenantAuditProfileFromEnv(
  env: RuntimeProfileResolverEnv,
  tenantId: string,
  options: RuntimeProfileReadOptions = {}
): Promise<AuditProfile> {
  const refs = await resolveEffectiveProfileRefsFromEnv(env, tenantId, options);
  const profile = await createRuntimeProfileRegistryFromEnv(env).get<AuditProfile>(
    'audit',
    refs.auditProfileId
  );
  if (!profile) {
    throw new Error(`audit_profile_not_found:${refs.auditProfileId}`);
  }
  return profile;
}
