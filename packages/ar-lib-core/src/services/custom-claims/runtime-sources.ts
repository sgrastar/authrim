import type { DatabaseSource } from '../../db';
import type { Context as HonoContext } from 'hono';
import type { Env } from '../../types/env';
import {
  getAccountDataContextFromHono,
  getTenantMetadataContextFromHono,
  resolveAccountDataContext,
  resolveTenantMetadataContext,
} from '../runtime-data-context';

export type CustomClaimRuntimeSourceEnv = Env;

/**
 * Custom-claim schema is tenant metadata. User values are account data and are deliberately
 * unavailable until an account route has been resolved through signed Lookup + Registry data.
 */
export interface ResolvedCustomClaimRuntimeSources {
  schemaDb: DatabaseSource;
  nonPiiDb: DatabaseSource | null;
  piiDb: DatabaseSource | null;
}

export interface ResolvedAccountCustomClaimRuntimeSources extends ResolvedCustomClaimRuntimeSources {
  nonPiiDb: DatabaseSource;
  piiDb: DatabaseSource;
}

export function resolveCustomClaimRuntimeSourcesFromEnv(
  env: CustomClaimRuntimeSourceEnv,
  tenantId: string,
  options: { accountId: string }
): Promise<ResolvedAccountCustomClaimRuntimeSources>;
export function resolveCustomClaimRuntimeSourcesFromEnv(
  env: CustomClaimRuntimeSourceEnv,
  tenantId: string,
  options?: { accountId?: string }
): Promise<ResolvedCustomClaimRuntimeSources>;
export async function resolveCustomClaimRuntimeSourcesFromEnv(
  env: CustomClaimRuntimeSourceEnv,
  tenantId: string,
  options: { accountId?: string } = {}
): Promise<ResolvedCustomClaimRuntimeSources> {
  const tenantMetadata = await resolveTenantMetadataContext(env, tenantId);
  if (!options.accountId) {
    return {
      schemaDb: tenantMetadata.coreDb,
      nonPiiDb: null,
      piiDb: null,
    };
  }

  const account = await resolveAccountDataContext(env, {
    tenantId,
    accountId: options.accountId,
  });
  return {
    schemaDb: tenantMetadata.coreDb,
    nonPiiDb: account.coreDb,
    piiDb: account.piiDb,
  };
}

export async function resolveCustomClaimRuntimeSourcesFromHono(
  c: HonoContext<{ Bindings: Env }>,
  tenantId: string
): Promise<ResolvedAccountCustomClaimRuntimeSources> {
  const tenantMetadata = getTenantMetadataContextFromHono(c);
  if (!tenantMetadata) throw new Error('tenant_metadata_context_required');
  if (tenantMetadata.tenantId !== tenantId) throw new Error('tenant_metadata_context_conflict');
  const accountData = getAccountDataContextFromHono(c);
  if (!accountData) throw new Error('account_data_context_required');
  if (accountData.tenantId !== tenantId) throw new Error('account_data_context_conflict');
  return {
    schemaDb: tenantMetadata.coreDb,
    nonPiiDb: accountData.coreDb,
    piiDb: accountData.piiDb,
  };
}
