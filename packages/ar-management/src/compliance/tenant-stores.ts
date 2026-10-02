/**
 * The stores a tenant's core data lives in, each database once.
 */
import {
  ensureDatabaseAdapter,
  resolveTenantAssignedDatabaseSourcesFromRegistry,
  type Env,
} from '@authrim/ar-lib-core';

/**
 * The tenant's core stores. A routed tenant keeps its accounts in its user stores (besides its
 * default store); role assignments and memberships may be in either, so they are read from all.
 */
export async function tenantCoreStores(
  env: Env,
  tenantId: string,
  options: { accountsOfRoutedTenant?: boolean } = {}
) {
  const stores = await resolveTenantAssignedDatabaseSourcesFromRegistry(env, {
    tenantId,
    role: 'tenant_core',
    ...(options.accountsOfRoutedTenant ? { dataRole: 'tenant_core/users' as const } : {}),
    // Up to 32 user stores and the default one.
    maxStores: 64,
    concurrency: 4,
  });
  // Two assignments may name the same database (default and user stores together): read it once.
  const seen = new Set<string>();
  return stores
    .filter((store) => !seen.has(store.bindingRef) && (seen.add(store.bindingRef), true))
    .map((store) => ({
      bindingRef: store.bindingRef,
      adapter: ensureDatabaseAdapter(store.source, `access-review:${store.bindingRef}`),
    }));
}
