import { ensureDatabaseAdapter } from '../db';
import type { Env } from '../types/env';
import { createLookupAliasIndex } from './lookup-directory/blind-index';
import type { ResolvedLookupAlias } from './lookup-directory/repository';
import { LookupRouteResolver } from './lookup-directory/resolver';
import { loadVerifiedLookupBucketAssignmentProvider } from './lookup-directory/shard-registry';
import {
  resolveTenantDatabaseSourceFromRegistry,
  type ResolvedTenantStore,
} from './tenant-database-resolver';

const MAX_DIRECTORY_PAGE_SIZE = 128;
const DEFAULT_CONCURRENCY = 4;

export interface EnvironmentTenantDirectoryEntry {
  tenantId: string;
  store: ResolvedTenantStore;
}

function assertAliasRouteNotAhead(alias: ResolvedLookupAlias, store: ResolvedTenantStore): void {
  const projection = alias.routeProjection;
  if (
    projection.tenantRouteGeneration > store.bindingRouteGeneration ||
    (projection.tenantRouteGeneration === store.bindingRouteGeneration &&
      (projection.residencyPolicyId !== store.residencyPolicyId ||
        projection.target.residencyPartition !== store.residencyPartition ||
        projection.target.shardId !== store.shardId ||
        projection.target.bindingRef !== store.bindingRef ||
        projection.target.requiredBindingRouteGeneration !== store.bindingRouteGeneration))
  ) {
    throw new Error('environment_tenant_alias_route_revalidation_failed');
  }
}

async function mapBounded<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        results[index] = await operation(values[index]!);
      }
    })
  );
  return results;
}

export async function listEnvironmentTenantDefaultStores(
  env: Env,
  options: { limit: number; afterTenantId?: string; concurrency?: number }
): Promise<EnvironmentTenantDirectoryEntry[]> {
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > MAX_DIRECTORY_PAGE_SIZE
  ) {
    throw new Error('environment_tenant_directory_limit_invalid');
  }
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error('environment_tenant_directory_concurrency_invalid');
  }
  if (
    !env.AUTHRIM_ENVIRONMENT_NAME ||
    !env.TENANT_RUNTIME_REGISTRY ||
    !env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS
  ) {
    throw new Error('environment_tenant_directory_unavailable');
  }

  const aliases = await new LookupRouteResolver(
    env as unknown as Record<string, unknown>,
    await loadVerifiedLookupBucketAssignmentProvider({
      store: env.TENANT_RUNTIME_REGISTRY,
      environmentId: env.AUTHRIM_ENVIRONMENT_NAME,
      publicJwks: env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS,
    })
  ).resolveAliases({
    index: await createLookupAliasIndex('environment_tenant', env.AUTHRIM_ENVIRONMENT_NAME),
    maximumResults: options.limit,
    afterTenantId: options.afterTenantId,
  });

  return mapBounded(aliases, concurrency, async (alias) => {
    const store = await resolveTenantDatabaseSourceFromRegistry(env, {
      tenantId: alias.tenantId,
      role: 'tenant_core',
      dataRole: 'tenant_core/default',
      shardGroup: 'default',
      shardIndex: 0,
    });
    assertAliasRouteNotAhead(alias, store);
    const tenant = await ensureDatabaseAdapter(
      store.source,
      'environment-tenant-directory'
    ).queryOne<{ id: string }>(
      "SELECT id FROM tenants WHERE id = ? AND lifecycle_state = 'active' LIMIT 1",
      [alias.tenantId]
    );
    if (tenant?.id !== alias.tenantId) {
      throw new Error('environment_tenant_alias_destination_revalidation_failed');
    }
    return { tenantId: alias.tenantId, store };
  });
}
