import { type DatabaseSource } from '../../db';
import type { Context as HonoContext } from 'hono';
import type { Env } from '../../types/env';
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
import { resolveTenantDatabaseSourceForTarget } from '../tenant-database-resolver';
import {
  getAccountDataContextFromHono,
  getTenantMetadataContextFromHono,
} from '../runtime-data-context';

export interface CustomClaimRuntimeSourceEnv extends RuntimeProfileResolverEnv {
  DB: DatabaseSource;
  DB_PII?: DatabaseSource;
  DB_ADMIN?: DatabaseSource;
  TENANT_RUNTIME_REGISTRY?: { get(key: string): Promise<string | null> };
  AUTHRIM_DEPLOYMENT_TARGET?: string;
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
  const runtimeSnapshotMode =
    storageProfile.id === 'builtin:storage:tenant-d1' && env.TENANT_RUNTIME_REGISTRY
      ? 'required'
      : 'optional';
  const resolveSource = async (
    target: typeof schemaTarget | typeof nonPiiTarget | NonNullable<typeof piiTarget>
  ): Promise<DatabaseSource> => {
    if (target.resolverRef) {
      const tenantStore = await resolveTenantDatabaseSourceForTarget(env, tenantId, target, {
        deploymentTarget: env.AUTHRIM_DEPLOYMENT_TARGET,
        runtimeSnapshotMode,
      });
      return tenantStore.source;
    }
    return getBoundStorageTargetSource(env, target, {
      fallbackBindingRefs: bindingFallbacks,
    });
  };

  return {
    storageProfile,
    schemaDb: await resolveSource(schemaTarget),
    nonPiiDb: await resolveSource(nonPiiTarget),
    piiDb: piiTarget ? await resolveSource(piiTarget) : null,
  };
}

export async function resolveCustomClaimRuntimeSourcesFromHono(
  c: HonoContext<{ Bindings: Env }>,
  tenantId: string
): Promise<ResolvedCustomClaimRuntimeSources> {
  const tenantMetadata = getTenantMetadataContextFromHono(c);
  if (tenantMetadata?.storageProfileId !== 'builtin:storage:tenant-d1') {
    return resolveCustomClaimRuntimeSourcesFromEnv(c.env, tenantId);
  }
  if (tenantMetadata.tenantId !== tenantId) throw new Error('tenant_metadata_context_conflict');
  const accountData = getAccountDataContextFromHono(c);
  if (!accountData) throw new Error('account_data_context_required');
  if (accountData.tenantId !== tenantId) throw new Error('account_data_context_conflict');
  const { storageProfile } = await resolveTenantRuntimeProfilesFromEnv(c.env, tenantId);
  return {
    storageProfile,
    schemaDb: tenantMetadata.coreDb,
    nonPiiDb: accountData.coreDb,
    piiDb: accountData.piiDb,
  };
}
