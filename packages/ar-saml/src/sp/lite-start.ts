/**
 * The SAML sign-in start (SP-initiated) of a tenant in lite mode, and where its outcome returns.
 *
 * Such a tenant starts SAML sign-in only from the lite Login UI. The page posts its proof of work
 * to ar-auth, which records a one-time start grant in the browser's lite transaction; the browser
 * then comes to this start with the transaction and the grant. The start consumes the grant (this
 * browser's binding cookie, the tenant's current policy revision, the IdP `saml:<id>` as the page
 * named it) before anything else, and then takes everything from the transaction and the grant,
 * nothing from its public query.
 *
 * The request it stores carries the lite return (`liteReturn`): the ACS answers that sign-in with a
 * handoff to it (the lite `/callback` finalizes it for the transaction), and its failures too; and
 * in a lite tenant only such a sign-in creates an account (its grant's proof met the sign-up
 * requirement).
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

export type LiteSamlStart =
  | {
      ok: true;
      txn: LiteTxnSnapshot;
      start: LiteStartGrantStart;
      /** The lite `/callback` of the transaction and grant: where the sign-in returns. */
      returnUrl: string;
    }
  | { ok: false; response: Response };

function refused(c: Context<{ Bindings: Env }>): { ok: false; response: Response } {
  return {
    ok: false,
    response: c.json(
      {
        error: 'lite_mode_endpoint_unavailable',
        error_description: 'This tenant starts SAML sign-in from the lite Login UI',
      },
      403
    ),
  };
}

/** The browser binding cookie (none, when the request has no readable cookie header). */
function readBindingCookie(c: Context<{ Bindings: Env }>): string | undefined {
  try {
    return getCookie(c, LITE_BROWSER_BINDING_COOKIE);
  } catch {
    return undefined;
  }
}

/**
 * The lite `/callback` of a transaction and its grant. Its origin is the transaction's (the
 * tenant's canonical issuer origin): a tenant switches to lite mode only while that is the origin
 * the SP's ACS and entity IDs are built on (lite-mode-readiness `issuer_origin_mismatch`), so the
 * request's binding cookie and the ACS are on the host the browser starts from.
 */
export function liteSamlCallbackUrl(txn: LiteTxnSnapshot, grantId: string): string {
  const url = new URL('/callback', txn.bound.publicOrigin);
  url.searchParams.set('lite_txn', txn.id);
  url.searchParams.set('lite_grant', grantId);
  return url.toString();
}

/**
 * For a tenant in lite mode (read from the store now; a mode that cannot be read is taken as
 * lite), the consumed start grant or the refusal to answer with; null for any other tenant.
 */
export async function consumeLiteSamlStart(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  idpId: string | undefined
): Promise<LiteSamlStart | null> {
  let mode: LiteModeState;
  try {
    mode = await readLiteModeAuthoritative(c.env, tenantId);
  } catch {
    mode = 'unknown';
  }
  if (mode === 'off') return null;
  c.header('Cache-Control', 'no-store');
  if (!idpId) return refused(c);
  const grantId = c.req.query('lite_grant');
  const consumed = await consumeLiteStartGrant(c.env, {
    tenantId,
    binding: readBindingCookie(c),
    txnId: c.req.query('lite_txn'),
    grantId,
    provider: `saml:${idpId}`,
  });
  if (!consumed.ok) return refused(c);
  return {
    ok: true,
    txn: consumed.txn,
    start: consumed.start,
    returnUrl: liteSamlCallbackUrl(consumed.txn, String(grantId)),
  };
}

/**
 * Whether a SAML sign-in may create an account: one begun at a lite start (it carries its lite
 * return), or any sign-in of a tenant the store says now is not in lite mode. A read that fails
 * creates nothing.
 */
export async function samlSignInMayCreateAccount(
  env: Env,
  tenantId: string,
  liteReturn: string | null
): Promise<boolean> {
  if (liteReturn) return true;
  try {
    return (await readLiteModeAuthoritative(env, tenantId)) === 'off';
  } catch {
    return false;
  }
}

/** A lite sign-in's failure, sent to its lite callback page (which clears the start). */
export function liteSamlErrorRedirect(liteReturn: string, status: number): Response {
  const url = new URL(liteReturn);
  url.searchParams.set('error', status >= 500 ? 'server_error' : 'access_denied');
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
