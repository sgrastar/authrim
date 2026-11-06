/**
 * Reading a tenant's lite Login UI policy from its LitePolicyStore (one instance per tenant).
 *
 * Without the `LITE_POLICY_STORE` binding no tenant can have switched the lite UI on (a switch
 * commits to the store), so the policy reads as `off`. A store that is bound but cannot be read
 * is an error: the caller decides (a side effect is refused; the Login UI answers 503).
 */
import type { Env } from '../types/env';
import { LITE_POLICY_INITIAL_REVISION, type LitePolicySnapshot } from '../types/login-ui-lite';

/** The policy store is bound but could not be read. */
export class LitePolicyUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super('lite_policy_unavailable');
    this.name = 'LitePolicyUnavailableError';
  }
}

export function litePolicyInstanceName(tenantId: string): string {
  return `lite-policy:${tenantId}`;
}

export function getLitePolicyStore(
  env: Pick<Env, 'LITE_POLICY_STORE'>,
  tenantId: string
): DurableObjectStub<import('../durable-objects/LitePolicyStore').LitePolicyStore> | null {
  const namespace = env.LITE_POLICY_STORE;
  if (!namespace) return null;
  return namespace.get(namespace.idFromName(litePolicyInstanceName(tenantId)));
}

/** The policy of a tenant whose store was never written (or is not bound). */
export function initialLitePolicySnapshot(tenantId: string): LitePolicySnapshot {
  return {
    tenantId,
    liteMode: 'off',
    humanVerificationRequired: { login: false, signup: false, reauth: false },
    policyRevision: LITE_POLICY_INITIAL_REVISION,
    generation: 0,
    updatedAt: 0,
  };
}

/** The tenant's authoritative lite policy. Throws {@link LitePolicyUnavailableError}. */
export async function readLitePolicySnapshot(
  env: Pick<Env, 'LITE_POLICY_STORE'>,
  tenantId: string
): Promise<LitePolicySnapshot> {
  const store = getLitePolicyStore(env, tenantId);
  if (!store) return initialLitePolicySnapshot(tenantId);
  try {
    return await store.getSnapshotRpc(tenantId);
  } catch (error) {
    throw new LitePolicyUnavailableError(error);
  }
}
