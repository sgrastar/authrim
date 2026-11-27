/**
 * Check API: verifying an end-user access token (the self contract).
 *
 * The token goes through the protected-resource introspection path of ar-lib-core
 * (`introspectTokenFromContext`, as `createActiveAccessTokenProtectedResourceMiddleware` uses it):
 *
 * - the signature with the tenant's keys (KeyManager JWKS, cached per isolate) and its issuer
 *   (`buildIssuerUrl` for the tenant), expiry, sender constraints, a disabled client and a
 *   withdrawn consent;
 * - the audience: the tenant's `check.audience` setting, or its issuer URL when unset;
 * - the account: a token with a pairwise or persistent `sub` carries the sealed account
 *   reference, which is opened (`allowSubjectReference`); the check is made for that internal
 *   account id, never for the `sub` the app was given.
 *
 * On top of it, this path requires (each refusal is 401 unless it says 503; any failure to read
 * what the decision needs is 503, never 500):
 *
 * - no elevation grant (`authrim_elevation`: `elevated_token_not_allowed`);
 * - an access token (`token_use === 'access'`; a refresh token or an ID token is refused) with a
 *   JWT ID, checked against the revocation store failing closed (store missing or unreachable:
 *   503);
 * - a local end-user account as its subject (`non_account_subject`): not a client, machine or
 *   admin principal (client_credentials and the like), not an external subject brought in by a
 *   token exchange (`authrim_subject_issuer`);
 * - a client that exists and is enabled; for a token that records no consent generation and no
 *   sealed reference (issued before they were recorded), the consent withdrawal by issue time
 *   (`iat`), as the protected-resource path checks it for the others (read failure: 503). Both
 *   consent reads use the account's Core database alone (this Worker has no PII binding).
 *
 * `Authorization: Bearer` or `Authorization: DPoP` (with its `DPoP` proof header): introspection
 * enforces the token's sender constraint (a DPoP-bound token needs DPoP and a matching proof).
 *
 * The tenant is the one the request was sent to (the host's tenant, which the request context
 * resolved, custom domains included). A token's `tenant_id` claim must name it, and every token
 * must have been issued by exactly the issuer the token endpoint uses for this host
 * (`buildRequestIssuerUrl`): the signature is verified against that issuer, which is also the
 * default Check audience. One tenant's (or one host's) token therefore never reaches another's
 * check.
 */

import type { Context } from 'hono';
import {
  ACCESS_TOKEN_SUBJECT_ISSUER_CLAIM,
  buildRequestIssuerUrl,
  createLogger,
  ensureDatabaseAdapter,
  findOAuthClientConsentRevocation,
  getClientCached,
  getTenantIdFromContext,
  introspectTokenFromContext,
  introspectedTokenClient,
  isAccessTokenConsentWithdrawn,
  parseToken,
  readTokenRevocationState,
  resolveAccountCoreDataContext,
  resolveEffectiveSettingsWithSources,
  resolveIntrospectedAccountUserId,
  tokenNamesNonAccountPrincipal,
  tokenRecordsUserGrant,
  type Env as SharedEnv,
} from '@authrim/ar-lib-core';
import type { AccessTokenValidationResult } from './check-auth';

const log = createLogger().module('CHECK-ACCESS-TOKEN');

/** The settings key of the Check audience (category `check`). */
export const CHECK_AUDIENCE_SETTING = 'check.audience';

/** Subject namespaces of principals that are not end-user accounts. */
const NON_ACCOUNT_SUBJECT_PREFIXES = ['client:', 'machine:', 'admin_user:'];

/** The token's `tenant_id` claim (trimmed), or null when it has none. */
export function tokenTenantClaim(payload: Record<string, unknown>): string | null {
  const claim = typeof payload.tenant_id === 'string' ? payload.tenant_id.trim() : '';
  return claim || null;
}

/**
 * Whether a verified token names something other than a local end-user account: a client,
 * machine or admin principal, or an external subject a token exchange brought in.
 */
export function tokenNamesNonLocalSubject(claims: Record<string, unknown>): boolean {
  if (claims[ACCESS_TOKEN_SUBJECT_ISSUER_CLAIM] !== undefined) return true;
  if (tokenNamesNonAccountPrincipal(claims)) return true;
  const sub = claims.sub;
  if (typeof sub !== 'string' || !sub) return true;
  return NON_ACCOUNT_SUBJECT_PREFIXES.some((prefix) => sub.startsWith(prefix));
}

/**
 * The audience a self-contract token must carry for a tenant: `check.audience`, else the issuer
 * (the request host's, as the token endpoint uses it). null when the setting cannot be read (the
 * caller refuses then).
 */
export async function resolveCheckAudience(
  env: SharedEnv,
  tenantId: string,
  issuer: string
): Promise<string | null> {
  try {
    const { values } = await resolveEffectiveSettingsWithSources(env, 'check', { tenantId });
    const configured = values[CHECK_AUDIENCE_SETTING];
    if (typeof configured === 'string' && configured.trim()) return configured.trim();
  } catch (error) {
    log.error('Failed to read the Check audience', { tenantId }, error as Error);
    return null;
  }
  return issuer || null;
}

/**
 * The verifier of end-user access tokens for a Check API request (see the module comment). Only a
 * token sent in the request's own `Authorization` header (`Bearer` or `DPoP`) is verified:
 * introspection reads the header (a token passed another way, such as a WebSocket query
 * parameter, is refused).
 */
export function createCheckAccessTokenVerifier<TBindings extends SharedEnv>(
  c: Context<{ Bindings: TBindings }>
): (token: string, scheme: 'Bearer' | 'DPoP') => Promise<AccessTokenValidationResult> {
  const context = c as unknown as Context<{ Bindings: SharedEnv }>;
  return async (token, scheme) => {
    if (c.req.header('Authorization') !== `${scheme} ${token}`) {
      return { valid: false, error: 'invalid_token' };
    }
    try {
      return await verify(context, token);
    } catch (error) {
      // An infrastructure failure on the way (a key, client, account or consent read).
      log.error('Access token verification failed', {}, error as Error);
      return { valid: false, error: 'temporarily_unavailable' };
    }
  };
}

async function verify(
  context: Context<{ Bindings: SharedEnv }>,
  token: string
): Promise<AccessTokenValidationResult> {
  let payload: Record<string, unknown>;
  try {
    payload = parseToken(token);
  } catch {
    return { valid: false, error: 'invalid_token' };
  }

  // The request's tenant (the host's, as the request context verified it) and the issuer the
  // token endpoint uses for this host (a registered custom domain included).
  const tenantId = getTenantIdFromContext(context);
  const issuer = buildRequestIssuerUrl(context.req.raw, context.env, tenantId);
  const claimedTenant = tokenTenantClaim(payload);
  if (claimedTenant && claimedTenant !== tenantId) {
    return { valid: false, error: 'invalid_tenant' };
  }
  if (payload.iss !== issuer) return { valid: false, error: 'invalid_tenant' };

  const audience = await resolveCheckAudience(context.env, tenantId, issuer);
  if (!audience) return { valid: false, error: 'temporarily_unavailable' };

  const result = await introspectTokenFromContext(context, {
    audience,
    issuer,
    allowSubjectReference: true,
    consentFromAccountCoreOnly: true,
  });
  if (!result.valid || !result.claims) {
    // A key that could not be loaded (500), the account or consent state (503), the DPoP replay
    // store (503): infrastructure, not the token. An invalid token or proof is 401.
    if ((result.error?.statusCode ?? 0) >= 500) {
      return { valid: false, error: 'temporarily_unavailable' };
    }
    return { valid: false, error: 'invalid_token' };
  }

  const claims = result.claims as Record<string, unknown>;
  // An elevation grant (a time-boxed, approval-bound grant for another resource) is not a
  // user's own access: refused with its own code.
  if (claims.authrim_elevation !== undefined) {
    return { valid: false, error: 'elevated_token_not_allowed' };
  }
  // An access token: not a refresh token or an ID token signed with the same keys.
  if (claims.token_use !== 'access') return { valid: false, error: 'invalid_token' };
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience)) return { valid: false, error: 'invalid_audience' };
  const verifiedTenant = tokenTenantClaim(claims);
  if (verifiedTenant && verifiedTenant !== tenantId) {
    return { valid: false, error: 'invalid_tenant' };
  }
  if (tokenNamesNonLocalSubject(claims)) {
    return { valid: false, error: 'non_account_subject' };
  }

  // Revocation, failing closed (introspection reads an unreachable store as "not revoked").
  if (typeof claims.jti !== 'string' || !claims.jti) {
    return { valid: false, error: 'invalid_token' };
  }
  const revocation = await readTokenRevocationState(context.env, claims.jti, tenantId);
  if (revocation === 'unavailable') return { valid: false, error: 'temporarily_unavailable' };
  if (revocation === 'revoked') return { valid: false, error: 'invalid_token' };

  // The client must exist and be enabled (introspection lets an unregistered issuer through).
  const clientId =
    typeof claims.client_id === 'string' && claims.client_id
      ? claims.client_id
      : typeof claims.azp === 'string' && claims.azp
        ? claims.azp
        : undefined;
  if (!clientId) return { valid: false, error: 'invalid_token' };
  let client: Awaited<ReturnType<typeof getClientCached>>;
  try {
    client = await getClientCached(context, context.env, clientId, { includeDisabled: true });
  } catch (error) {
    log.error('Failed to read the token client', {}, error as Error);
    return { valid: false, error: 'temporarily_unavailable' };
  }
  if (!client || client.enabled === false) return { valid: false, error: 'invalid_client' };

  // The account the token is for (the sealed reference's account for a pairwise or persistent
  // sub); none for a pairwise app's token without the reference.
  const subjectId = resolveIntrospectedAccountUserId(
    result,
    await introspectedTokenClient(context, result)
  );
  if (!subjectId) return { valid: false, error: 'invalid_token' };

  // A token issued before consent generations and references were recorded: the withdrawal by
  // issue time (the protected-resource path checks the others).
  if (!tokenRecordsUserGrant(claims)) {
    try {
      // The account's Core database alone (no PII context).
      const core = await resolveAccountCoreDataContext(context.env, {
        tenantId,
        accountId: subjectId,
      });
      const withdrawal = await findOAuthClientConsentRevocation(
        ensureDatabaseAdapter(core.coreDb, 'policy-check-consent'),
        { tenantId, userId: subjectId, clientId }
      );
      if (isAccessTokenConsentWithdrawn(withdrawal, claims)) {
        return { valid: false, error: 'invalid_token' };
      }
    } catch (error) {
      log.error('Failed to read the consent withdrawal', {}, error as Error);
      return { valid: false, error: 'temporarily_unavailable' };
    }
  }

  return {
    valid: true,
    clientId,
    subjectId,
    // The token's public sub: the only subject_id a request may name (never the internal id).
    ...(typeof claims.sub === 'string' && { tokenSubject: claims.sub }),
    tenantId,
  };
}
