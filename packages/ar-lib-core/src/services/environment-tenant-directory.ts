import { ensureDatabaseAdapter } from '../db';
import type { Env } from '../types/env';
import { createLookupAliasIndex } from './lookup-directory/blind-index';
import type { ResolvedLookupAlias } from './lookup-directory/repository';
import { LookupRouteResolver } from './lookup-directory/resolver';
import { loadVerifiedLookupBucketAssignmentProvider } from './lookup-directory/shard-registry';
import { createLogger } from '../utils/logger';
import {
  resolveTenantDatabaseSourceFromRegistry,
  TenantDatabaseResolverError,
  type ResolvedTenantStore,
} from './tenant-database-resolver';

const log = createLogger().module('ENVIRONMENT-TENANT-DIRECTORY');

/**
 * Resolver errors that mean "this tenant's route is deliberately not servable or not published":
 * a quarantined / quarantining / disabled route. `missing_snapshot` is not in the set: it also
 * means "the generation marker says active but the snapshot is gone" or "the verified snapshot
 * lacks the requested store", which are faults. Such a tenant is left out of the listing; every other resolver
 * error (invalid signature, missing binding, generation mismatch or propagation, expired snapshot,
 * ...) may mean tampering or a platform fault and still fails the whole listing.
 */
const UNSERVABLE_ROUTE_CODES: ReadonlySet<string> = new Set(['quarantined_route']);

function isUnservableRouteError(error: unknown): boolean {
  return error instanceof TenantDatabaseResolverError && UNSERVABLE_ROUTE_CODES.has(error.code);
}

const MAX_DIRECTORY_PAGE_SIZE = 128;
const DEFAULT_CONCURRENCY = 4;

export interface EnvironmentTenantDirectoryEntry {
  tenantId: string;
  store: ResolvedTenantStore;
  /** The lifecycle state of the tenant's row in its own default store. */
  lifecycleState: string;
}

/**
 * Alias pages (of `limit` aliases each) read at most per call while refilling a page that skipped
 * inactive tenants: a run of 64 x `limit` consecutive non-active tenants is the longest tolerated.
 */
const MAX_ALIAS_PAGES_PER_CALL = 64;

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
        results[index] = await operation(values[index]);
      }
    })
  );
  return results;
}

/**
 * Lists tenants in id order, each with its `tenant_core/default` store.
 *
 * A tenant whose row is missing in that store (or carries another id) is a directory-integrity
 * failure and throws. A tenant whose row exists but is not `active` (deleting, suspended, frozen,
 * ...) is left out by default so that one such tenant never halts a scanner; pass
 * `includeInactive` to get it anyway (the tenant deletion scanner must reach its store).
 *
 * A tenant whose route is not servable (see `UNSERVABLE_ROUTE_CODES`) is skipped the same way as a
 * non-active one, whatever `includeInactive` says: no database handle is ever obtained for it.
 *
 * Pagination contract for callers (`result.length === limit` means "maybe more", the last
 * `tenantId` is the next cursor): omitted tenants never make a page short. The directory keeps
 * reading further alias pages (up to `MAX_ALIAS_PAGES_PER_CALL`, i.e. a run of that many x `limit`
 * consecutive skipped tenants) until `limit` entries are collected or the aliases run out, so a
 * short page always means the end of the directory.
 */
export async function listEnvironmentTenantDefaultStores(
  env: Env,
  options: {
    limit: number;
    afterTenantId?: string;
    concurrency?: number;
    includeInactive?: boolean;
    /**
     * What to do with a tenant whose route is not servable (see `UNSERVABLE_ROUTE_CODES`): `'skip'`
     * (default) leaves it out; `'throw'` lets the original resolver error propagate, for callers
     * that must not treat a tenant they cannot check as absent.
     */
    unservableTenants?: 'skip' | 'throw';
  }
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

  const resolver = new LookupRouteResolver(
    env as unknown as Record<string, unknown>,
    await loadVerifiedLookupBucketAssignmentProvider({
      store: env.TENANT_RUNTIME_REGISTRY,
      environmentId: env.AUTHRIM_ENVIRONMENT_NAME,
      publicJwks: env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS,
    })
  );
  const index = await createLookupAliasIndex('environment_tenant', env.AUTHRIM_ENVIRONMENT_NAME);

  const entries: EnvironmentTenantDirectoryEntry[] = [];
  const unservableTenantIds: string[] = [];
  const logSkipped = (): void => {
    if (unservableTenantIds.length > 0) {
      log.info('Skipped tenants whose route is not servable', {
        skippedCount: unservableTenantIds.length,
        skippedTenantIds: unservableTenantIds.slice(0, 10),
      });
    }
  };
  let cursor = options.afterTenantId;
  for (let pageCount = 0; ; pageCount += 1) {
    // A whole page every time (not the remainder), so a run of skipped tenants is read
    // `options.limit` at a time however full the result already is.
    const aliases = await resolver.resolveAliases({
      index,
      maximumResults: options.limit,
      afterTenantId: cursor,
      paginated: true,
    });
    const resolved = await mapBounded(aliases, concurrency, async (alias) => {
      let store: ResolvedTenantStore;
      try {
        store = await resolveTenantDatabaseSourceFromRegistry(env, {
          tenantId: alias.tenantId,
          role: 'tenant_core',
          dataRole: 'tenant_core/default',
          shardGroup: 'default',
          shardIndex: 0,
        });
      } catch (error) {
        if (options.unservableTenants === 'throw' || !isUnservableRouteError(error)) throw error;
        return null;
      }
      assertAliasRouteNotAhead(alias, store);
      const tenant = await ensureDatabaseAdapter(
        store.source,
        'environment-tenant-directory'
      ).queryOne<{ id: string; lifecycle_state: string }>(
        'SELECT id, lifecycle_state FROM tenants WHERE id = ? LIMIT 1',
        [alias.tenantId]
      );
      if (tenant?.id !== alias.tenantId) {
        throw new Error('environment_tenant_alias_destination_revalidation_failed');
      }
      return { tenantId: alias.tenantId, store, lifecycleState: tenant.lifecycle_state };
    });
    for (const [position, entry] of resolved.entries()) {
      if (entry === null) {
        unservableTenantIds.push(aliases[position].tenantId);
        continue;
      }
      if (options.includeInactive || entry.lifecycleState === 'active') entries.push(entry);
      // Aliases after the last one returned are read again by the next call, which takes the last
      // returned tenant id as its cursor.
      if (entries.length === options.limit) {
        logSkipped();
        return entries;
      }
    }
    // The alias page was not full: the directory is exhausted.
    if (aliases.length < options.limit) {
      logSkipped();
      return entries;
    }
    cursor = aliases[aliases.length - 1].tenantId;
    if (pageCount + 1 >= MAX_ALIAS_PAGES_PER_CALL) {
      // Returning a short page here would read as the end of the directory.
      logSkipped();
      throw new Error('environment_tenant_directory_inactive_run_too_long');
    }
  }
}
