/**
 * How a Worker reaches a browser's lite Login UI transactions (LiteTxnStore), and how ar-bridge
 * and ar-saml consume the one-time start grant the lite Login UI got for an external sign-in.
 *
 * A store instance belongs to one tenant and one browser binding: the random value of the
 * `__Host-authrim_lite` cookie (HttpOnly, Secure, SameSite=Lax, Path=/, no Domain), of which only
 * the hash leaves the Worker that read it.
 */
import type { LiteTxnStore } from '../durable-objects/LiteTxnStore';
import type { Env } from '../types/env';
import type {
  LiteStartGrantStart,
  LiteTxnRefusal,
  LiteTxnSnapshot,
} from '../types/login-ui-lite-txn';
import { buildIssuerUrl } from '../utils/issuer';
import { readCurrentLitePolicySnapshot } from './lite-policy';
import { buildCanonicalTenantIssuerUrl } from './tenant-vanity-domain-resolver';

export const LITE_BROWSER_BINDING_COOKIE = '__Host-authrim_lite';
/** 32 random bytes, base64url without padding. */
export const LITE_BROWSER_BINDING_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/** The binding value, when it has the form the lite Login UI makes; otherwise null. */
export function checkedLiteBrowserBinding(value: unknown): string | null {
  return typeof value === 'string' && LITE_BROWSER_BINDING_PATTERN.test(value) ? value : null;
}

/** The hash of a browser binding: what addresses its store instance and what the store keeps. */
export async function liteBrowserBindingHash(binding: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(binding));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The store instance of a tenant's browser binding (by its hash). */
export function liteTxnStoreFor(
  namespace: DurableObjectNamespace<LiteTxnStore>,
  tenantId: string,
  bindingHash: string
): DurableObjectStub<LiteTxnStore> {
  return namespace.get(namespace.idFromName(`lite-txn:${tenantId}:${bindingHash}`));
}

/** Why a start grant could not be consumed. */
export type LiteStartGrantRefusal =
  | LiteTxnRefusal
  | 'unavailable'
  | 'not_lite'
  | 'invalid_binding'
  | 'invalid_request';

export type LiteStartGrantConsumption =
  | { ok: true; txn: LiteTxnSnapshot; start: LiteStartGrantStart }
  | { ok: false; reason: LiteStartGrantRefusal };

const KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

/**
 * Consumes the start grant a lite Login UI transaction holds for this provider, once.
 *
 * - The tenant must be in lite mode now; the transaction and the grant must belong to its current
 *   policy revision.
 * - The transaction must be this browser's (its binding cookie) and made on the tenant's
 *   canonical origin: a lite transaction is made only there, and the cookie of another host does
 *   not reach this one.
 * - The grant's action is the transaction's purpose: a start decides what it does from the
 *   transaction, never from its query.
 *
 * Anything else, including a store that cannot be reached, refuses: the caller starts nothing.
 */
export async function consumeLiteStartGrant(
  env: Env,
  input: {
    tenantId: string;
    binding: unknown;
    txnId: unknown;
    grantId: unknown;
    provider: string;
  }
): Promise<LiteStartGrantConsumption> {
  const namespace = env.LITE_TXN_STORE;
  if (!namespace || !env.LITE_POLICY_STORE) return { ok: false, reason: 'unavailable' };
  const binding = checkedLiteBrowserBinding(input.binding);
  if (!binding) return { ok: false, reason: 'invalid_binding' };
  if (
    typeof input.txnId !== 'string' ||
    !KEY_PATTERN.test(input.txnId) ||
    typeof input.grantId !== 'string' ||
    !KEY_PATTERN.test(input.grantId) ||
    !input.provider ||
    input.provider.length > 128
  ) {
    return { ok: false, reason: 'invalid_request' };
  }
  try {
    const snapshot = await readCurrentLitePolicySnapshot(env, input.tenantId);
    if (snapshot.liteMode !== 'always') return { ok: false, reason: 'not_lite' };
    const publicOrigin = new URL(
      await buildCanonicalTenantIssuerUrl(
        env,
        input.tenantId,
        buildIssuerUrl(env, input.tenantId),
        { strict: true }
      )
    ).origin;
    const ref = {
      tenantId: input.tenantId,
      bindingHash: await liteBrowserBindingHash(binding),
      txnId: input.txnId,
      publicOrigin,
      policyRevision: snapshot.policyRevision,
    };
    const store = liteTxnStoreFor(namespace, input.tenantId, ref.bindingHash);
    // (The stub's RPC types wrap the answers; they are the store's results.)
    const read = (await store.getTxnRpc(ref)) as
      | { ok: true; txn: LiteTxnSnapshot }
      | { ok: false; reason: LiteTxnRefusal };
    if (!read.ok) return read;
    return await store.consumeStartGrantRpc({
      ...ref,
      grantId: input.grantId,
      spec: {
        provider: input.provider,
        action: read.txn.bound.purpose,
        policyRevision: snapshot.policyRevision,
      },
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
