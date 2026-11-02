/**
 * Deferred Credential Route
 *
 * Retrieves a deferred credential that was not immediately available.
 */

import type { Context } from 'hono';
import type { Env } from '../../types';
import {
  createSDJWTVCWithSigner,
  type SDJWTVCCreateOptions,
  IssuedCredentialRepository,
  ensureDatabaseAdapter,
  getLogger,
  getTenantIdFromContext,
  resolveTenantMetadataContext,
  type Env as CoreEnv,
} from '@authrim/ar-lib-core';
import { validateVCIAccessToken } from '../services/token-validation';
import type { JWTPayload } from 'jose';
import { getRequestIssuerUrl } from '../../request-identifiers';
import { listCredentialConfigurations } from '../credential-configurations';
import { invalidTokenError } from '../oauth-errors';

interface DeferredCredentialRequest {
  transaction_id: string;
}

/**
 * POST /vci/deferred
 *
 * Retrieves a credential that was deferred during initial issuance.
 */
export async function deferredCredentialRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('VC-ISSUER');
  const requestIssuerUrl = getRequestIssuerUrl(c);
  try {
    // Verify access token
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return invalidTokenError(c);
    }

    const accessToken = authHeader.substring(7);
    const tokenResult = await validateVCIAccessToken(
      c.env,
      accessToken,
      requestIssuerUrl,
      getTenantIdFromContext(c)
    );

    if (!tokenResult.valid) {
      return invalidTokenError(c);
    }

    // Ensure userId is present
    if (!tokenResult.userId || !tokenResult.tenantId) {
      return invalidTokenError(c);
    }

    const body = await c.req.json<DeferredCredentialRequest>().catch(() => null);

    if (!body || typeof body.transaction_id !== 'string' || !body.transaction_id) {
      return deferredError(c, 'invalid_credential_request');
    }

    // Look up deferred credential using repository
    const tenantMetadata = await resolveTenantMetadataContext(
      c.env as unknown as CoreEnv,
      tokenResult.tenantId
    );
    const adapter = ensureDatabaseAdapter(tenantMetadata.coreDb, 'vc-issuer-core');
    const issuedCredentialRepo = new IssuedCredentialRepository(adapter);

    const result = await issuedCredentialRepo.findDeferredByIdAndUser(
      tokenResult.tenantId,
      body.transaction_id,
      tokenResult.userId
    );

    if (!result) {
      return deferredError(c, 'invalid_transaction_id');
    }

    // Check if credential is ready (has claims populated)
    const claims = issuedCredentialRepo.parseClaims(result);
    const isReady =
      result.claims &&
      result.claims !== '{}' &&
      result.claims !== 'pending' &&
      Object.keys(claims).length > 0;

    if (!isReady) {
      // Final §9.2: still pending is a 202 that repeats the transaction_id with a poll interval.
      c.header('Cache-Control', 'no-store');
      return c.json({ transaction_id: body.transaction_id, interval: 5 }, 202);
    }

    const configuration = listCredentialConfigurations().find(
      (candidate) => candidate.vct === result.credential_type
    );
    if (!configuration || configuration.subjectKind !== 'end_user') {
      return deferredError(c, 'invalid_transaction_id');
    }

    // Parse holder binding
    const holderBinding = issuedCredentialRepo.parseHolderBinding(result) as
      | { kty: string; crv: string; x: string; y?: string }
      | undefined;

    // Create SD-JWT VC
    const options: SDJWTVCCreateOptions = {
      vct: configuration.vct,
      selectiveDisclosureClaims: configuration.selectivelyDisclosableClaims,
      holderBinding,
      expiresAt: Math.floor(Date.now() / 1000) + configuration.validitySeconds,
    };

    const sdjwtvc = await createSDJWTVCWithSigner(
      claims,
      requestIssuerUrl,
      (payload) => signSDJWTIssuer(c.env, result.tenant_id, payload),
      options
    );

    // Update status to 'active' using repository
    await issuedCredentialRepo.updateStatus(tokenResult.tenantId, body.transaction_id, 'active');

    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({
      credentials: [{ credential: sdjwtvc.combined }],
    });
  } catch (error) {
    log.error('Deferred credential retrieval failed', {}, error as Error);
    c.header('Cache-Control', 'no-store');
    return c.json({ error: 'server_error' }, 500);
  }
}

/** OpenID4VCI deferred credential errors (§9.3). */
function deferredError(
  c: Context,
  error: 'invalid_credential_request' | 'invalid_transaction_id'
): Response {
  c.header('Cache-Control', 'no-store');
  return c.json({ error }, 400);
}

/**
 * Sign within KeyManager so private key material never crosses the DO boundary.
 */
async function signSDJWTIssuer(env: Env, tenantId: string, payload: JWTPayload): Promise<string> {
  const doId = env.KEY_MANAGER.idFromName(`${tenantId}-v3`);
  const stub = env.KEY_MANAGER.get(doId) as unknown as {
    signSDJWTIssuerRpc(input: JWTPayload): Promise<{ token: string }>;
  };
  return (await stub.signSDJWTIssuerRpc(payload)).token;
}
