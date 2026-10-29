/** Guest administration only: canonical owner reads, bounded inventory, no request context reuse. */
import type { Context } from 'hono';
import { requireCurrentGuestAccountProjection, sameGuestProjection } from './guest-account-lookup';
import {
  createAuthContextFromHono,
  GuestLifecycleRepository,
  ensureDatabaseAdapter,
  getTenantMetadataContextFromHono,
  resolveTenantAssignedDatabaseSourcesFromRegistry,
  resolveTenantDatabaseSourceFromRegistry,
  usesRoutedAccountStorage,
  validateAccountDirectoryPublication,
  type AccountDirectoryPublication,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import {
  guestPinFromSource,
  sameGuestPin,
  type GuestDeletionRouteV2,
  type GuestPhysicalPin,
} from './guest-deletion-route';

export interface GuestCoreStore {
  adapter: DatabaseAdapter;
  bindingRef: string;
  pin: GuestPhysicalPin | null;
}
export interface GuestAccountRow {
  id: string;
  legacy_user_id: string;
  account_type: string;
  registration_state: 'guest' | 'registered';
  lifecycle_state: string;
  directory_publication_state: string;
  account_route_generation: number;
  created_at: number;
  deleted_at: number | null;
}
export interface GuestCoreOwner extends GuestCoreStore {
  userId: string;
  account: GuestAccountRow | null;
}
const fail = () => new Error('guest_account_owner_unverified');

export async function guestCoreStores(env: Env, tenantId: string): Promise<GuestCoreStore[]> {
  const sources = await resolveTenantAssignedDatabaseSourcesFromRegistry(env, {
    tenantId,
    role: 'tenant_core',
    dataRole: 'tenant_core/users',
    maxStores: 32,
    concurrency: 4,
  });
  const stores = new Map<string, GuestCoreStore>();
  for (const source of sources) {
    const pin = guestPinFromSource(source, 'tenant_core/users');
    const previous = stores.get(pin.databaseId);
    if (previous) {
      if (
        previous.pin?.assignmentGeneration !== pin.assignmentGeneration ||
        previous.pin.bindingRouteGeneration !== pin.bindingRouteGeneration ||
        previous.pin.residencyPartition !== pin.residencyPartition
      )
        throw fail();
      continue;
    }
    stores.set(pin.databaseId, {
      adapter: ensureDatabaseAdapter(source.source, 'guest-account'),
      bindingRef: source.bindingRef,
      pin,
    });
  }
  return [...stores.values()];
}
export async function guestStoresFromContext(
  c: Context<{ Bindings: Env }>,
  tenantId: string
): Promise<GuestCoreStore[]> {
  const metadata = getTenantMetadataContextFromHono(c);
  if (usesRoutedAccountStorage(metadata)) return guestCoreStores(c.env, tenantId);
  // Explicit legacy/direct topology keeps non-destructive reads, including PostgreSQL.
  return [
    {
      adapter: createAuthContextFromHono(c, tenantId).coreAdapter,
      bindingRef: metadata && 'bindingRef' in metadata.route ? metadata.route.bindingRef : 'DB',
      pin: null,
    },
  ];
}
export async function guestMapStores<T>(
  stores: readonly GuestCoreStore[],
  read: (store: GuestCoreStore) => Promise<T>
): Promise<T[]> {
  const result = new Array<T>(stores.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, stores.length) }, async () => {
      while (next < stores.length) {
        const index = next++;
        result[index] = await read(stores[index]);
      }
    })
  );
  return result;
}
export async function findGuestCoreOwner(
  stores: readonly GuestCoreStore[],
  tenantId: string,
  requestedId: string
): Promise<GuestCoreOwner | null> {
  const candidates = await guestMapStores(stores, async (store) => {
    const accounts = await store.adapter.query<GuestAccountRow>(
      `SELECT id,legacy_user_id,account_type,registration_state,lifecycle_state,
        directory_publication_state,account_route_generation,created_at,deleted_at
        FROM identity_accounts WHERE tenant_id=? AND (legacy_user_id=? OR id=?) LIMIT 2`,
      [tenantId, requestedId, requestedId],
      { consistencyClass: 'primary_required' }
    );
    if (accounts.length > 1) throw new Error('guest_account_owner_ambiguous');
    const account = accounts[0];
    if (account) return { ...store, userId: account.legacy_user_id, account };
    const history = await store.adapter.queryOne<{ user_id: string }>(
      `SELECT user_id FROM guest_account_lifecycle WHERE tenant_id=? AND user_id=?
       UNION SELECT guest_user_id AS user_id FROM guest_account_upgrades
         WHERE tenant_id=? AND (guest_user_id=? OR upgraded_user_id=?) LIMIT 1`,
      [tenantId, requestedId, tenantId, requestedId, requestedId],
      { consistencyClass: 'primary_required' }
    );
    return history ? { ...store, userId: requestedId, account: null } : null;
  });
  const found = candidates.filter((candidate): candidate is GuestCoreOwner => candidate !== null);
  if (found.length > 1) throw new Error('guest_account_owner_ambiguous');
  return found[0] ?? null;
}
export async function resolveGuestOwnerStorage(env: Env, owner: GuestCoreOwner, tenantId: string) {
  if (owner.adapter.getType() !== 'd1') throw new Error('guest_deletion_backend_unsupported');
  const account = owner.account;
  if (
    !account ||
    account.account_type !== 'user' ||
    account.legacy_user_id !== owner.userId ||
    !owner.pin
  )
    throw fail();
  const outbox = await owner.adapter.queryOne<{ payload_json: string }>(
    `SELECT payload_json FROM account_routing_outbox WHERE tenant_id=? AND account_id=?
      AND route_generation=? AND event_kind='account_created' AND status='succeeded'`,
    [tenantId, account.id, account.account_route_generation],
    { consistencyClass: 'primary_required' }
  );
  if (!outbox) throw fail();
  const publication = await validateAccountDirectoryPublication(
    JSON.parse(outbox.payload_json) as AccountDirectoryPublication
  );
  if (
    publication.tenantId !== tenantId ||
    publication.accountId !== account.id ||
    publication.routeProjection.accountRouteGeneration !== account.account_route_generation
  )
    throw fail();
  const currentProjection = await requireCurrentGuestAccountProjection(
    env,
    tenantId,
    account.id,
    account.account_route_generation
  );
  if (!sameGuestProjection(currentProjection, publication.routeProjection)) throw fail();
  const resolve = async (role: GuestPhysicalPin['dataRole']) => {
    const targets = publication.routeProjection.targets.filter(
      (target) => target.dataRole === role
    );
    if (targets.length !== 1) throw fail();
    const target = targets[0];
    const source = await resolveTenantDatabaseSourceFromRegistry(env, {
      tenantId: tenantId,
      role: role === 'tenant_pii' ? 'tenant_pii' : 'tenant_core',
      dataRole: role,
      bindingRef: target.bindingRef,
      shardId: target.shardId,
      residencyPartition: target.residencyPartition,
      requiredBindingRouteGeneration: target.requiredBindingRouteGeneration,
      memoryCacheTtlMs: 0,
      generationCacheTtlMs: 0,
    });
    return { pin: guestPinFromSource(source, role), source };
  };
  const core = await resolve('tenant_core/users');
  const pii = await resolve('tenant_pii');
  if (
    owner.pin
      ? !sameGuestPin(owner.pin, core.pin)
      : ensureDatabaseAdapter(core.source.source).getType() !== 'd1'
  )
    throw fail();
  if (core.pin.residencyPartition !== pii.pin.residencyPartition) throw fail();
  // A direct context without a signed physical association cannot authorize erasure merely because
  // its current binding is named DB. Standard Setup single-host requests have a signed users route.
  if (!owner.pin) throw new Error('guest_deletion_legacy_owner_unverified');
  if (
    !sameGuestProjection(
      currentProjection,
      await requireCurrentGuestAccountProjection(
        env,
        tenantId,
        account.id,
        account.account_route_generation
      )
    )
  )
    throw fail();
  const coreAdapter = ensureDatabaseAdapter(core.source.source, 'guest-owner-core');
  const reflected = await coreAdapter.queryOne<{ id: string }>(
    `SELECT id FROM identity_accounts WHERE tenant_id=? AND id=? AND legacy_user_id=? AND account_route_generation=?`,
    [tenantId, account.id, owner.userId, account.account_route_generation],
    { consistencyClass: 'primary_required' }
  );
  if (!reflected || reflected.id !== account.id) throw fail();
  return {
    account,
    core: coreAdapter,
    pii: ensureDatabaseAdapter(pii.source.source, 'guest-owner-pii'),
    corePin: core.pin,
    piiPin: pii.pin,
    routeProjection: publication.routeProjection,
  };
}

export async function makeGuestDeletionRoute(
  env: Env,
  owner: GuestCoreOwner,
  input: {
    tenantId: string;
    operationId: string;
    completionAuditId: string;
    origin: 'admin' | 'retention';
  }
): Promise<GuestDeletionRouteV2> {
  const account = owner.account;
  if (
    !account ||
    account.account_type !== 'user' ||
    account.registration_state !== 'guest' ||
    account.deleted_at !== null ||
    account.lifecycle_state !== 'active'
  )
    throw fail();
  const resolved = await resolveGuestOwnerStorage(env, owner, input.tenantId);
  return GuestLifecycleRepository.parseDeletionRouteV2(
    JSON.stringify({
      schemaVersion: 2,
      tenantId: input.tenantId,
      accountId: account.id,
      userId: owner.userId,
      operationId: input.operationId,
      accountRouteGeneration: account.account_route_generation,
      routeProjection: resolved.routeProjection,
      corePin: resolved.corePin,
      piiPin: resolved.piiPin,
      completionAuditMode: 'outbox',
      completionAuditId: input.completionAuditId,
      origin: input.origin,
      execution: { phase: 'accepted', boundaryId: null, erasureStartedAtMs: null },
    }),
    {
      tenantId: input.tenantId,
      userId: owner.userId,
      accountId: account.id,
      operationId: input.operationId,
      acceptedOnly: true,
    }
  );
}
