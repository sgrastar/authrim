/**
 * The databases Support Ops reads and writes: its cohorts, their targets and its actions in the
 * tenant metadata database; the accounts a cohort selects in each of the tenant's account
 * databases.
 */
import type { Context } from 'hono';
import {
  createAuthContextFromHono,
  ensureDatabaseAdapter,
  getTenantMetadataContextFromHono,
  resolveTenantMetadataContext,
  type DatabaseAdapter,
  type Env,
  type TenantMetadataContext,
} from '@authrim/ar-lib-core';
import { tenantCoreStores } from './compliance/tenant-stores';
import { usesRoutedAccountStorage } from './tenant-routed-storage';

/** The key of the one account database of a tenant whose accounts are not routed. */
const METADATA_ACCOUNT_STORE_KEY = 'tenant_metadata';

const ACCOUNT_STORE_CONCURRENCY = 4;

export interface SupportOpsAccountStore {
  /** Stable across requests and job runs (the store's binding), so a job can resume by it. */
  key: string;
  adapter: DatabaseAdapter;
  /** Execution pins the physical route; a reused binding alone cannot identify old receipts. */
  identity?: SupportOpsStoreIdentity;
}

export interface SupportOpsStoreIdentity {
  databaseId: string;
  bindingRouteGeneration: number;
  shardId: string;
  assignmentGeneration: number;
}

export interface SupportOpsStores {
  /** The tenant metadata database: cohorts, cohort targets and actions. */
  metadata: DatabaseAdapter;
  metadataIdentity?: SupportOpsStoreIdentity;
  /** Every database the tenant's accounts are in, each once, ordered by key. */
  accounts: SupportOpsAccountStore[];
}

async function storesOf(
  env: Env,
  tenantId: string,
  metadata: DatabaseAdapter,
  metadataContext: TenantMetadataContext | undefined
): Promise<SupportOpsStores> {
  const route = metadataContext?.route;
  const metadataIdentity = route?.registryRow?.database_id
    ? {
        databaseId: route.registryRow.database_id,
        bindingRouteGeneration: route.bindingRouteGeneration,
        shardId: route.shardId,
        assignmentGeneration: route.assignmentGeneration,
      }
    : undefined;
  if (!usesRoutedAccountStorage(metadataContext)) {
    return {
      metadata,
      metadataIdentity,
      accounts: [
        { key: METADATA_ACCOUNT_STORE_KEY, adapter: metadata, identity: metadataIdentity },
      ],
    };
  }
  const stores = await tenantCoreStores(env, tenantId, {
    accountsOfRoutedTenant: true,
    purpose: 'support-ops',
  });
  // A user store bound to the metadata database itself is that database: the same adapter.
  const metadataBinding = metadataContext?.route?.bindingRef;
  return {
    metadata,
    metadataIdentity,
    accounts: stores
      .map((store) => ({
        key: store.bindingRef,
        identity: store.identity,
        adapter: store.bindingRef === metadataBinding ? metadata : store.adapter,
      }))
      .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)),
  };
}

/** The tenant's Support Ops databases for a request. */
export function supportOpsStoresFromHono<E extends { Bindings: Env }>(
  c: Context<E>,
  tenantId: string
): Promise<SupportOpsStores> {
  const context = c as unknown as Context<{ Bindings: Env }>;
  return storesOf(
    context.env,
    tenantId,
    createAuthContextFromHono(
      context as unknown as Parameters<typeof createAuthContextFromHono>[0],
      tenantId
    ).coreAdapter,
    getTenantMetadataContextFromHono(context)
  );
}

/** The tenant's Support Ops databases for a job (which has no request to resolve them from). */
export async function supportOpsStoresFromEnv(
  env: Env,
  tenantId: string
): Promise<SupportOpsStores> {
  const context = await resolveTenantMetadataContext(env, tenantId);
  return storesOf(
    env,
    tenantId,
    ensureDatabaseAdapter(context.coreDb, 'support-ops-snapshot-tenant'),
    context
  );
}

/** `mapper` over each account database, a few at a time, in the databases' order. */
export async function mapAccountStores<R>(
  stores: readonly SupportOpsAccountStore[],
  mapper: (store: SupportOpsAccountStore, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(stores.length);
  let next = 0;
  const worker = async () => {
    while (next < stores.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(stores[index]!, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(ACCOUNT_STORE_CONCURRENCY, stores.length) }, worker)
  );
  return results;
}

/** Accounts named in one statement (as one JSON array parameter, well under D1's value size). */
export const ACCOUNT_ID_CHUNK = 1000;

/** An account found in more than one account database: which copy is the account is unknown. */
export class SupportOpsAmbiguousAccountError extends Error {
  constructor() {
    super('support_ops_account_store_ambiguous');
  }
}

/** `values` in JSON arrays of at most ACCOUNT_ID_CHUNK, for `json_each(?)`. */
export function accountIdChunks(values: readonly string[]): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < values.length; offset += ACCOUNT_ID_CHUNK) {
    chunks.push(JSON.stringify(values.slice(offset, offset + ACCOUNT_ID_CHUNK)));
  }
  return chunks;
}

/**
 * The accounts of `userIds` each account database holds (in any state), by the database's key.
 * An account held by more than one database is refused (SupportOpsAmbiguousAccountError); one
 * held by none is in no list (with a single database, every account is in its list).
 */
export async function accountsByStore(
  stores: readonly SupportOpsAccountStore[],
  tenantId: string,
  userIds: readonly string[]
): Promise<Map<string, string[]>> {
  const unique = [...new Set(userIds)];
  // One database holds every account there is: none is in two.
  if (stores.length === 1) return new Map([[stores[0]!.key, unique]]);
  const chunks = accountIdChunks(unique);
  const held = await mapAccountStores(stores, async ({ adapter }) => {
    const ids: string[] = [];
    for (const chunk of chunks) {
      const rows = await adapter.query<{ id: string }>(
        `SELECT DISTINCT legacy_user_id AS id
           FROM identity_accounts
          WHERE tenant_id = ? AND legacy_user_id IN (SELECT value FROM json_each(?))`,
        [tenantId, chunk]
      );
      ids.push(...rows.map((row) => row.id));
    }
    return ids;
  });
  const holder = new Set<string>();
  const result = new Map<string, string[]>();
  stores.forEach((store, index) => {
    for (const id of held[index]!) {
      if (holder.has(id)) throw new SupportOpsAmbiguousAccountError();
      holder.add(id);
    }
    result.set(store.key, held[index]!);
  });
  return result;
}

/**
 * Whether a count summed over `storeCount` account databases may count an account more than once
 * and so reach a threshold it is compared with (from `minCount` up to `highestThreshold`) though
 * its accounts are fewer: a count from `minCount` up to (not including) `highestThreshold` times
 * the databases. A larger one is of at least `highestThreshold` accounts even if each were in
 * every database; a smaller one is suppressed as it is.
 */
export function mayCountAccountTwice(
  count: number,
  minCount: number,
  storeCount: number,
  highestThreshold = minCount
): boolean {
  return storeCount > 1 && count >= minCount && count < highestThreshold * storeCount;
}

/** Whether an account of `userIds` is held (in any state) by a database other than `holderKey`. */
export async function heldByAnotherStore(
  stores: readonly SupportOpsAccountStore[],
  holderKey: string,
  tenantId: string,
  userIds: readonly string[]
): Promise<boolean> {
  const others = stores.filter(({ key }) => key !== holderKey);
  if (others.length === 0 || userIds.length === 0) return false;
  const chunks = accountIdChunks([...new Set(userIds)]);
  const held = await mapAccountStores(others, async ({ adapter }) => {
    for (const chunk of chunks) {
      const row = await adapter.queryOne<{ held: number }>(
        `SELECT 1 AS held
           FROM identity_accounts
          WHERE tenant_id = ? AND legacy_user_id IN (SELECT value FROM json_each(?))
          LIMIT 1`,
        [tenantId, chunk]
      );
      if (row) return true;
    }
    return false;
  });
  return held.some(Boolean);
}
