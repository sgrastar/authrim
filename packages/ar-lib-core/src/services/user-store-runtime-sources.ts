import { type DatabaseSource } from '../db';
import type { StorageProfile } from '../types/runtime-profile';
import {
  resolveTenantRuntimeProfilesFromEnv,
  type RuntimeProfileResolverEnv,
} from './runtime-profile-resolver';
import {
  getBoundStorageTargetSource,
  getOptionalStorageSliceTarget,
} from './storage-target-resolver';

export interface UserStoreRuntimeSourceEnv extends RuntimeProfileResolverEnv {
  DB: DatabaseSource;
  DB_PII?: DatabaseSource;
}

export interface ResolvedUserStoreRuntimeSources {
  storageProfile: StorageProfile;
  coreDb: DatabaseSource;
  piiDb: DatabaseSource | null;
}

export async function resolveUserStoreRuntimeSourcesFromEnv(
  env: UserStoreRuntimeSourceEnv,
  tenantId: string
): Promise<ResolvedUserStoreRuntimeSources> {
  const resolved = await resolveTenantRuntimeProfilesFromEnv(env, tenantId);
  const storageProfile = resolved.storageProfile;

  const coreTarget = getOptionalStorageSliceTarget(storageProfile, 'users_core');
  const piiTarget =
    getOptionalStorageSliceTarget(storageProfile, 'users_pii') ??
    getOptionalStorageSliceTarget(storageProfile, 'custom_pii');
  const bindingFallbacks = {
    DB_PII: env.DB_PII ?? env.DB,
  };

  return {
    storageProfile,
    coreDb: coreTarget
      ? getBoundStorageTargetSource(env, coreTarget, {
          fallbackBindingRefs: bindingFallbacks,
        })
      : env.DB,
    piiDb: piiTarget
      ? getBoundStorageTargetSource(env, piiTarget, {
          fallbackBindingRefs: bindingFallbacks,
        })
      : (env.DB_PII ?? env.DB ?? null),
  };
}
