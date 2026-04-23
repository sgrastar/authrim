import { type DatabaseSource } from '../../db';
import type { StorageProfile } from '../../types/runtime-profile';
import {
  resolveTenantRuntimeProfilesFromEnv,
  type RuntimeProfileResolverEnv,
} from '../runtime-profile-resolver';
import {
  getBoundStorageTargetSource,
  getOptionalStorageSliceTarget,
  getRequiredStorageSliceTarget,
} from '../storage-target-resolver';

export interface CustomClaimRuntimeSourceEnv extends RuntimeProfileResolverEnv {
  DB: DatabaseSource;
  DB_PII?: DatabaseSource;
  DB_ADMIN?: DatabaseSource;
}

export interface ResolvedCustomClaimRuntimeSources {
  storageProfile: StorageProfile;
  schemaDb: DatabaseSource;
  nonPiiDb: DatabaseSource;
  piiDb: DatabaseSource | null;
}

export async function resolveCustomClaimRuntimeSourcesFromEnv(
  env: CustomClaimRuntimeSourceEnv,
  tenantId: string
): Promise<ResolvedCustomClaimRuntimeSources> {
  const resolved = await resolveTenantRuntimeProfilesFromEnv(env, tenantId);
  const storageProfile = resolved.storageProfile;

  const schemaTarget =
    getOptionalStorageSliceTarget(storageProfile, 'registration_fields') ??
    getRequiredStorageSliceTarget(storageProfile, 'custom_claims');
  const nonPiiTarget =
    getOptionalStorageSliceTarget(storageProfile, 'custom_claims') ??
    getRequiredStorageSliceTarget(storageProfile, 'registration_fields');
  const piiTarget = getOptionalStorageSliceTarget(storageProfile, 'custom_pii');
  const bindingFallbacks = {
    DB_PII: env.DB_PII ?? env.DB,
  };

  return {
    storageProfile,
    schemaDb: getBoundStorageTargetSource(env, schemaTarget, {
      fallbackBindingRefs: bindingFallbacks,
    }),
    nonPiiDb: getBoundStorageTargetSource(env, nonPiiTarget, {
      fallbackBindingRefs: bindingFallbacks,
    }),
    piiDb: piiTarget
      ? getBoundStorageTargetSource(env, piiTarget, {
          fallbackBindingRefs: bindingFallbacks,
        })
      : null,
  };
}
