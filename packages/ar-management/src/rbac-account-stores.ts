/**
 * The databases tenant-wide RBAC admin views read: role and organisation definitions in the
 * tenant metadata database, assignments and memberships in each account database.
 */
import type { Context } from 'hono';
import {
  CanonicalRuntimeUserStore,
  createAuthContextFromHono,
  ensureDatabaseAdapter,
  getTenantMetadataContextFromHono,
  isDatabaseSource,
  resolveAccountDataContext,
  type DatabaseAdapter,
  type DatabaseSource,
  type Env,
} from '@authrim/ar-lib-core';
import { isInactiveAccountRouteError } from './account-route-errors';
import { tenantCoreStores } from './compliance/tenant-stores';
import { CrossShardAccountExactSearchService } from './cross-shard-account-list';
import { usesRoutedAccountStorage } from './tenant-routed-storage';

export interface TenantRBACStores {
  /** The tenant metadata database: role and organisation definitions. */
  metadata: DatabaseAdapter;
  /** Every database the tenant's accounts are in, each once (`metadata` itself when one is). */
  accounts: DatabaseAdapter[];
  /** Whether accounts are routed to their own databases (else they are in `metadata`). */
  routed: boolean;
}

/**
 * The tenant's RBAC databases. A routed tenant keeps each account, with its assignments and
 * memberships, in one of its user stores (up to tenantCoreStores' bound); otherwise they are in
 * the metadata database.
 */
export async function tenantRBACStores(
  c: Context<{ Bindings: Env }>,
  tenantId: string
): Promise<TenantRBACStores> {
  const metadata = createAuthContextFromHono(c, tenantId).coreAdapter;
  const metadataContext = getTenantMetadataContextFromHono(c);
  if (!usesRoutedAccountStorage(metadataContext)) {
    return { metadata, accounts: [metadata], routed: false };
  }
  const stores = await tenantCoreStores(c.env, tenantId, {
    accountsOfRoutedTenant: true,
    purpose: 'rbac',
  });
  // A user store bound to the metadata database itself is that database: the same adapter, so
  // a read of both reads it once.
  const metadataBinding = metadataContext?.route?.bindingRef;
  return {
    metadata,
    accounts: stores.map((store) =>
      store.bindingRef === metadataBinding ? metadata : store.adapter
    ),
    routed: true,
  };
}

/**
 * The one user store of the tenant that holds the account (in any state but deleted), found by
 * reading each of them: for an account its route refuses (suspended, locked, being deleted),
 * whatever its type. Null when none holds it. Core audit views may explicitly include deleted
 * identities; ordinary callers keep the same non-deleted lookup.
 */
export async function accountStoreHolding(
  env: Env,
  tenantId: string,
  userId: string,
  options: { includeDeleted?: boolean } = {}
): Promise<DatabaseAdapter | null> {
  const stores = await tenantCoreStores(env, tenantId, {
    accountsOfRoutedTenant: true,
    purpose: 'rbac-account-store',
  });
  const holding = (
    await Promise.all(
      stores.map(async ({ adapter }) =>
        (await adapter.queryOne<{ id: string }>(
          `SELECT id FROM identity_accounts
            WHERE tenant_id = ? AND legacy_user_id = ?${options.includeDeleted ? '' : " AND lifecycle_state <> 'deleted'"}
            LIMIT 1`,
          [tenantId, userId]
        ))
          ? adapter
          : null
      )
    )
  ).filter((adapter): adapter is DatabaseAdapter => adapter !== null);
  if (holding.length > 1) throw new Error('rbac_account_store_ambiguous');
  return holding[0] ?? null;
}

export type SubjectContacts = Map<string, { email: string | null; name: string | null }>;

const CONTACT_CONCURRENCY = 4;

function bindingSource(env: Env, bindingRef: string): DatabaseSource {
  const source = (env as unknown as Record<string, unknown>)[bindingRef];
  if (!isDatabaseSource(source)) throw new Error('rbac_contact_binding_unavailable');
  return source;
}

/**
 * The databases of an account that is not active (an admin view of it), found across the
 * tenant's stores; null when the tenant has none, it is being deleted, or it holds no personal
 * data.
 */
async function inactiveAccountDatabases(
  env: Env,
  tenantId: string,
  userId: string
): Promise<{ coreDb: DatabaseSource; piiDb: DatabaseSource } | null> {
  let routes;
  try {
    routes = await new CrossShardAccountExactSearchService(env).find({
      tenantId,
      identifier: userId,
      purpose: 'admin_view',
    });
  } catch (error) {
    // The account holds no personal data (its PII store has no value of it): no contact.
    if (error instanceof Error && error.message === 'cross_shard_account_pii_owner_invalid') {
      return null;
    }
    throw error;
  }
  if (routes.length === 0) return null;
  if (routes.length !== 1 || routes[0]!.legacyUserId !== userId) {
    throw new Error('rbac_contact_route_invalid');
  }
  return {
    coreDb: bindingSource(env, routes[0]!.coreBindingRef),
    piiDb: bindingSource(env, routes[0]!.piiBindingRef),
  };
}

/**
 * The email and name of each of `subjectIds` that has an account, for a page of a tenant-wide
 * list. A routed account's are read from its own databases, found through its route (a
 * suspended or locked account's through the admin view of the tenant's stores).
 */
export async function routedSubjectContacts(
  env: Env,
  tenantId: string,
  subjectIds: readonly string[]
): Promise<SubjectContacts> {
  const contacts: SubjectContacts = new Map();
  const pending = [...new Set(subjectIds.filter(Boolean))];
  const worker = async () => {
    for (let id = pending.shift(); id !== undefined; id = pending.shift()) {
      let account: { coreDb: DatabaseSource; piiDb: DatabaseSource } | null;
      try {
        account = await resolveAccountDataContext(env, { tenantId, accountId: id });
      } catch (error) {
        // An assignment left by an account since deleted names no one.
        if (error instanceof Error && error.message === 'account_data_route_not_found') continue;
        if (!isInactiveAccountRouteError(error)) throw error;
        account = await inactiveAccountDatabases(env, tenantId, id);
      }
      if (!account) continue;
      const user = await new CanonicalRuntimeUserStore({
        coreAdapter: ensureDatabaseAdapter(account.coreDb, 'rbac-contact-core'),
        piiAdapter: ensureDatabaseAdapter(account.piiDb, 'rbac-contact-pii'),
        tenantId,
      }).findById(id, { includeInactive: true });
      if (user) contacts.set(id, { email: user.email, name: user.name });
    }
  };
  await Promise.all(Array.from({ length: CONTACT_CONCURRENCY }, worker));
  return contacts;
}
