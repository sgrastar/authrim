/**
 * The RBAC claims of the tokens the authorization endpoint issues directly (implicit and hybrid
 * flows), computed as the token endpoint computes them: the tenant's claim settings (else the
 * environment's), the claims cache and the same defaults.
 */
import type { Context } from 'hono';
import {
  createAccountAuthContextFromHono,
  createAuthContextFromHono,
  getAccessTokenRBACClaims,
  getIDTokenRBACClaims,
  getTenantSettingsDocument,
  type Env,
  type RBACTokenClaims,
} from '@authrim/ar-lib-core';

interface ClaimsLogger {
  error(message: string, context?: Record<string, unknown>, error?: Error): void;
}

export async function resolveDirectIssuanceRBACClaims(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  subjectId: string,
  needs: { includesToken: boolean; includesIdToken: boolean },
  log: ClaimsLogger
): Promise<{
  accessTokenRBACClaims: Awaited<ReturnType<typeof getAccessTokenRBACClaims>>;
  idTokenRBACClaims: Awaited<ReturnType<typeof getIDTokenRBACClaims>>;
}> {
  if (!needs.includesToken && !needs.includesIdToken) {
    return { accessTokenRBACClaims: {}, idTokenRBACClaims: {} };
  }
  try {
    const settings = await getTenantSettingsDocument(c.env, tenantId, 'tokens');
    const access = settings?.['tokens.rbac_access_token_claims'];
    const id = settings?.['tokens.rbac_id_token_claims'];
    const databases = {
      metadata: createAuthContextFromHono(c, tenantId).coreAdapter,
      account: createAccountAuthContextFromHono(c, tenantId).coreAdapter,
    };
    const [accessTokenRBACClaims, idTokenRBACClaims] = await Promise.all([
      needs.includesToken
        ? getAccessTokenRBACClaims(databases, subjectId, {
            cache: c.env.REBAC_CACHE,
            env: c.env,
            claimsConfig: typeof access === 'string' ? access : c.env.RBAC_ACCESS_TOKEN_CLAIMS,
            tenantId,
          })
        : Promise.resolve({}),
      needs.includesIdToken
        ? getIDTokenRBACClaims(databases, subjectId, {
            cache: c.env.REBAC_CACHE,
            env: c.env,
            claimsConfig: typeof id === 'string' ? id : c.env.RBAC_ID_TOKEN_CLAIMS,
            tenantId,
          })
        : Promise.resolve({}),
    ]);
    // The token endpoint narrows permissions to the requested scope (permission embedding), which
    // this endpoint does not run: the access token carries no permission claim from here.
    const accessWithoutPermissions: RBACTokenClaims = { ...accessTokenRBACClaims };
    delete accessWithoutPermissions.authrim_permissions;
    delete accessWithoutPermissions.authrim_scoped_permissions;
    return { accessTokenRBACClaims: accessWithoutPermissions, idTokenRBACClaims };
  } catch (error) {
    // The tokens are issued without them, as at the token endpoint.
    log.error('Failed to read RBAC claims for implicit/hybrid tokens', {}, error as Error);
    return { accessTokenRBACClaims: {}, idTokenRBACClaims: {} };
  }
}
