/** Guest-only primary Lookup authority; no logical account-ID inference or route cache. */
import type { D1Database } from '@cloudflare/workers-types';
import {
  createLookupBlindIndexes,
  createD1ConsistencyRequest,
  LookupDirectoryRepository,
  loadVerifiedLookupBucketAssignmentProvider,
  mergeRotatingLookupMemberships,
  type Env,
  type AccountRouteProjection,
} from '@authrim/ar-lib-core';
import { loadLookupHmacRuntimeKeys } from './lookup-hmac-runtime';
const fail = () => new Error('guest_account_owner_unverified');
function isLookupDatabase(value: unknown): value is D1Database {
  return (
    !!value &&
    typeof value === 'object' &&
    'withSession' in value &&
    typeof value.withSession === 'function' &&
    'prepare' in value &&
    typeof value.prepare === 'function' &&
    'batch' in value &&
    typeof value.batch === 'function'
  );
}
export function sameGuestProjection(
  left: AccountRouteProjection,
  right: AccountRouteProjection
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.accountRouteGeneration === right.accountRouteGeneration &&
    left.residencyPolicyId === right.residencyPolicyId &&
    left.targets.length === right.targets.length &&
    left.targets.every((target) =>
      right.targets.some(
        (other) =>
          target.dataRole === other.dataRole &&
          target.bindingRef === other.bindingRef &&
          target.shardId === other.shardId &&
          target.residencyPartition === other.residencyPartition &&
          target.requiredBindingRouteGeneration === other.requiredBindingRouteGeneration
      )
    )
  );
}
/** Current primary Lookup authority; a historical succeeded outbox is insufficient after relocation. */
export async function requireCurrentGuestAccountProjection(
  env: Env,
  tenantId: string,
  accountId: string,
  generation: number
): Promise<AccountRouteProjection> {
  if (
    !env.AUTHRIM_ENVIRONMENT_NAME ||
    !env.TENANT_RUNTIME_REGISTRY ||
    !env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS
  )
    throw fail();
  const keys = await loadLookupHmacRuntimeKeys(env, { bypassCache: true });
  const assignments = await loadVerifiedLookupBucketAssignmentProvider({
    store: env.TENANT_RUNTIME_REGISTRY,
    environmentId: env.AUTHRIM_ENVIRONMENT_NAME,
    publicJwks: env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS,
    now: Math.floor(Date.now() / 1000),
  });
  const indexes = await createLookupBlindIndexes('account_id', accountId, keys.readKeys);
  const resultSets = [];
  for (const index of indexes) {
    const assignment = await assignments.resolveActiveAssignment(index.virtualBucket);
    if (assignment.state !== 'active' || assignment.virtualBucket !== index.virtualBucket)
      throw fail();
    const database: unknown = Reflect.get(env, assignment.bindingRef);
    if (!isLookupDatabase(database)) throw fail();
    resultSets.push(
      (
        await new LookupDirectoryRepository(database).findActiveMemberships(
          index,
          createD1ConsistencyRequest('primary_required')
        )
      ).memberships
    );
  }
  const memberships = mergeRotatingLookupMemberships(resultSets).filter(
    (membership) => membership.tenantId === tenantId && membership.accountId === accountId
  );
  if (
    memberships.length !== 1 ||
    memberships[0].accountRouteGeneration !== generation ||
    memberships[0].routeProjection.accountRouteGeneration !== generation
  )
    throw fail();
  return memberships[0].routeProjection;
}
