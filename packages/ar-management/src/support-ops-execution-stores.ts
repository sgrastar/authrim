import { assertSupportOpsAccountReceiptStore } from './support-ops-execute';
import {
  mapAccountStores,
  type SupportOpsStoreIdentity,
  type SupportOpsStores,
} from './support-ops-stores';

/** Neither a binding name nor an in-memory adapter identifies durable replay evidence. */
export function assertSupportOpsStoreIdentity(
  identity: SupportOpsStoreIdentity | undefined
): asserts identity is SupportOpsStoreIdentity {
  if (
    !identity ||
    typeof identity.databaseId !== 'string' ||
    identity.databaseId.length === 0 ||
    typeof identity.shardId !== 'string' ||
    identity.shardId.length === 0 ||
    !Number.isSafeInteger(identity.bindingRouteGeneration) ||
    identity.bindingRouteGeneration < 0 ||
    !Number.isSafeInteger(identity.assignmentGeneration) ||
    identity.assignmentGeneration < 0
  )
    throw new Error('support_ops_store_identity_unavailable');
}

export function assertSupportOpsStoreUnchanged(
  expected: SupportOpsStoreIdentity | undefined,
  actual: SupportOpsStoreIdentity | undefined
): void {
  assertSupportOpsStoreIdentity(expected);
  assertSupportOpsStoreIdentity(actual);
  if (
    actual.databaseId !== expected.databaseId ||
    actual.bindingRouteGeneration !== expected.bindingRouteGeneration ||
    actual.shardId !== expected.shardId ||
    actual.assignmentGeneration !== expected.assignmentGeneration
  )
    throw new Error('support_ops_store_route_changed');
}

/** Resolve and check the whole bounded fleet before enqueue/action CAS or any DO mutation. */
export async function preflightSupportOpsExecutionStores(stores: SupportOpsStores): Promise<void> {
  assertSupportOpsStoreIdentity(stores.metadataIdentity);
  if (!['d1', 'sqlite'].includes(stores.metadata.getType()))
    throw new Error('support_ops_metadata_adapter_unsupported');
  if (stores.accounts.length === 0 || stores.accounts.length > 64)
    throw new Error('support_ops_account_inventory_invalid');
  for (const store of stores.accounts) assertSupportOpsStoreIdentity(store.identity);
  await mapAccountStores(stores.accounts, ({ adapter }) =>
    assertSupportOpsAccountReceiptStore(adapter)
  );
}
