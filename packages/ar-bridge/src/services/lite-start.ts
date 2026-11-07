/**
 * The external sign-in start of a tenant in lite mode.
 *
 * Such a tenant starts external sign-in only from the lite Login UI. The page posts its proof of
 * work to ar-auth, which records a one-time start grant in the browser's lite transaction; the
 * browser then comes to the Bridge's start with the transaction and the grant. The start consumes
 * the grant (this browser's binding cookie, the tenant's current policy revision, the provider)
 * before it does anything else, and from then on takes everything from the transaction and the
 * grant, nothing from its public query.
 *
 * A lite start's flow ID carries LITE_EXTERNAL_FLOW_PREFIX, made here and nowhere else (a start's
 * flow ID is never taken from a request). The callback of a lite tenant creates an account (JIT)
 * only for such a flow: its grant's proof also met the sign-up requirement.
 */
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import {
  consumeLiteStartGrant,
  LITE_BROWSER_BINDING_COOKIE,
  readLiteModeAuthoritative,
  type Env,
  type LiteModeState,
  type LiteStartGrantStart,
  type LiteTxnSnapshot,
} from '@authrim/ar-lib-core';

export const LITE_EXTERNAL_FLOW_PREFIX = 'lite:';

export type LiteExternalStart =
  | { ok: true; txn: LiteTxnSnapshot; start: LiteStartGrantStart }
  | { ok: false; response: Response };

/**
 * For a tenant in lite mode, the consumed start grant (or the refusal to answer with); null for
 * any other tenant.
 *
 * The mode is read from the store now, not from the runtime cache: an isolate can keep answering
 * `off` for a while after a tenant's first switch (lite-policy.ts), and in that window a start
 * would take the public query with no grant. A read that fails is taken as lite (the grant is then
 * consumed against the current policy, which cannot be read either: refused).
 */
export async function consumeLiteExternalStart(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  provider: string
): Promise<LiteExternalStart | null> {
  let mode: LiteModeState;
  try {
    mode = await readLiteModeAuthoritative(c.env, tenantId);
  } catch {
    mode = 'unknown';
  }
  if (mode === 'off') return null;
  c.header('Cache-Control', 'no-store');
  const consumed = await consumeLiteStartGrant(c.env, {
    tenantId,
    binding: getCookie(c, LITE_BROWSER_BINDING_COOKIE),
    txnId: c.req.query('lite_txn'),
    grantId: c.req.query('lite_grant'),
    provider,
  });
  if (consumed.ok) return consumed;
  return {
    ok: false,
    response: c.json(
      {
        error: 'lite_mode_endpoint_unavailable',
        error_description: 'This tenant starts external sign-in from the lite Login UI',
      },
      403
    ),
  };
}

/** Where a lite start's sign-in returns: the lite Login UI's callback page for its transaction. */
export function liteExternalCallbackUrl(txn: LiteTxnSnapshot): string {
  const url = new URL('/callback', txn.bound.publicOrigin);
  url.searchParams.set('lite_txn', txn.id);
  return url.toString();
}

/** A lite start's flow ID: made only here. */
export function liteExternalFlowId(): string {
  return `${LITE_EXTERNAL_FLOW_PREFIX}${crypto.randomUUID()}`;
}

/** Whether a stored sign-in began at a lite start. */
export function isLiteExternalFlow(flowId: string | null | undefined): boolean {
  return typeof flowId === 'string' && flowId.startsWith(LITE_EXTERNAL_FLOW_PREFIX);
}

/**
 * Whether the sign-in may create an account, or finish creating one an earlier step of it began
 * (JIT): a tenant in lite mode, or whose mode cannot be read, lets only a sign-in begun at a lite
 * start do it (its grant was made after a proof that also met the sign-up requirement). A sign-in
 * begun before the tenant switched to lite mode creates none.
 *
 * The mode is read from the store now, not from the runtime cache: an isolate can keep answering
 * `off` for a while after a tenant's first switch (lite-policy.ts), and a sign-in begun before the
 * switch could create an account in that window. A read that fails creates nothing.
 */
export async function externalSignInMayCreateAccount(
  env: Env,
  tenantId: string,
  flowId: string | null | undefined
): Promise<boolean> {
  if (isLiteExternalFlow(flowId)) return true;
  try {
    return (await readLiteModeAuthoritative(env, tenantId)) === 'off';
  } catch {
    return false;
  }
}
