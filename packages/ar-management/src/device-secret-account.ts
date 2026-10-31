import type { DeviceSecret, Env } from '@authrim/ar-lib-core';
import {
  DeviceSecretRepository,
  ensureDatabaseAdapter,
  resolveAccountDataContext,
  resolveDeviceSecretRouteHint,
  resolveTenantAssignedDatabaseSourcesFromRegistry,
  type DatabaseAdapter,
} from '@authrim/ar-lib-core';

/**
 * Native SSO device secrets live with their owner's account data (the account databases), not in
 * the tenant metadata database. Issuing one records a route hint naming the owner's account, so a
 * raw secret finds its database; an ID or a user finds it through the account route, else across
 * the tenant's core databases.
 */

/** Account route errors meaning there is no active account to route to. */
const NO_ACTIVE_ACCOUNT_ROUTE_ERRORS = new Set([
  'account_data_route_not_found',
  'account_data_account_id_invalid',
  // The runtime resolver revalidates only active accounts at their destination.
  'lookup_destination_revalidation_failed',
]);

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

export interface RoutedDeviceSecret {
  deviceSecret: DeviceSecret;
  /** The repository over the owner's account database, for changes to the secret. */
  repository: DeviceSecretRepository;
  coreAdapter: DatabaseAdapter;
}

/**
 * A raw device secret, read from its owner's account database. null when the tenant has no such
 * secret, or the stored secret belongs to another account than its route hint names. Throws when
 * the route or the database cannot be read.
 *
 * The account route reaches only an active account. A secret whose owner is not active (suspended,
 * locked, being deleted) is null unless `includeInactiveOwner` is set: revoking it must still
 * persist, or it would be usable again once the owner is reactivated. It is then found in the
 * tenant's core databases, still bound to the account its route hint names.
 */
export async function findRoutedDeviceSecret(
  env: Env,
  tenantId: string,
  secret: string,
  options: { includeInactiveOwner?: boolean } = {}
): Promise<RoutedDeviceSecret | null> {
  let hint: Awaited<ReturnType<typeof resolveDeviceSecretRouteHint>>;
  try {
    hint = await resolveDeviceSecretRouteHint(env, { secret, tenantId });
  } catch (error) {
    if (errorCode(error) === 'device_secret_route_input_invalid') return null;
    throw error;
  }
  if (!hint) return null;
  const accountId = hint.accountId.startsWith('account:')
    ? hint.accountId
    : `account:${hint.accountId}`;
  const ownedByRoutedAccount = (deviceSecret: DeviceSecret | null): deviceSecret is DeviceSecret =>
    deviceSecret !== null && `account:${deviceSecret.user_id}` === accountId;
  let coreAdapter: DatabaseAdapter;
  try {
    const account = await resolveAccountDataContext(env, { tenantId, accountId });
    coreAdapter = ensureDatabaseAdapter(account.coreDb, 'account-core');
  } catch (error) {
    if (!NO_ACTIVE_ACCOUNT_ROUTE_ERRORS.has(errorCode(error))) throw error;
    if (!options.includeInactiveOwner) return null;
    for (const adapter of await tenantCoreAdapters(env, tenantId)) {
      const repository = new DeviceSecretRepository(adapter, tenantId);
      const deviceSecret = await repository.findByRawSecret(secret, tenantId);
      if (ownedByRoutedAccount(deviceSecret)) {
        return { deviceSecret, repository, coreAdapter: adapter };
      }
    }
    return null;
  }
  const repository = new DeviceSecretRepository(coreAdapter, tenantId);
  const deviceSecret = await repository.findByRawSecret(secret, tenantId);
  if (!ownedByRoutedAccount(deviceSecret)) return null;
  return { deviceSecret, repository, coreAdapter };
}

/** Every core database of the tenant (its metadata database and account shards). */
async function tenantCoreAdapters(env: Env, tenantId: string): Promise<DatabaseAdapter[]> {
  const stores = await resolveTenantAssignedDatabaseSourcesFromRegistry(env, {
    tenantId,
    role: 'tenant_core',
    maxStores: 32,
    concurrency: 4,
  });
  return stores.map((store) =>
    ensureDatabaseAdapter(store.source, `device-secrets:${store.bindingRef}`)
  );
}

/**
 * Repositories over every core database of the tenant (its metadata database and account shards),
 * for administration that knows only a secret's ID or spans every account.
 */
export async function tenantDeviceSecretRepositories(
  env: Env,
  tenantId: string
): Promise<DeviceSecretRepository[]> {
  return (await tenantCoreAdapters(env, tenantId)).map(
    (adapter) => new DeviceSecretRepository(adapter, tenantId)
  );
}

/**
 * Repositories holding a user's device secrets: the user's account database, or, when the user has
 * no active account (suspended, locked, being deleted), every core database of the tenant, so an
 * administrator can still list and revoke them.
 */
export async function userDeviceSecretRepositories(
  env: Env,
  tenantId: string,
  userId: string
): Promise<DeviceSecretRepository[]> {
  try {
    const account = await resolveAccountDataContext(env, { tenantId, accountId: userId });
    return [
      new DeviceSecretRepository(ensureDatabaseAdapter(account.coreDb, 'account-core'), tenantId),
    ];
  } catch (error) {
    if (!NO_ACTIVE_ACCOUNT_ROUTE_ERRORS.has(errorCode(error))) throw error;
    return tenantDeviceSecretRepositories(env, tenantId);
  }
}

/**
 * A device secret by ID, from whichever of the tenant's core databases holds it, with the
 * repository over that database.
 */
export async function findDeviceSecretById(
  env: Env,
  tenantId: string,
  id: string
): Promise<{ deviceSecret: DeviceSecret; repository: DeviceSecretRepository } | null> {
  for (const repository of await tenantDeviceSecretRepositories(env, tenantId)) {
    const deviceSecret = await repository.findById(id, tenantId);
    if (deviceSecret) return { deviceSecret, repository };
  }
  return null;
}
