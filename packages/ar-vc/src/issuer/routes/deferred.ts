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
  createErrorResponse,
  AR_ERROR_CODES,
  ensureDatabaseAdapter,
  getLogger,
  getTenantIdFromContext,
  resolveTenantMetadataContext,
  type Env as CoreEnv,
} from '@authrim/ar-lib-core';
import { validateVCIAccessToken } from '../services/token-validation';
import type { JWTPayload } from 'jose';
import { getRequestIssuerIdentifier, getRequestIssuerUrl } from '../../request-identifiers';

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
  const requestIssuerIdentifier = getRequestIssuerIdentifier(c);
  const requestIssuerUrl = getRequestIssuerUrl(c);
  try {
    // Verify access token
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return createErrorResponse(c, AR_ERROR_CODES.TOKEN_INVALID);
    }

    const accessToken = authHeader.substring(7);
    const tokenResult = await validateVCIAccessToken(
      c.env,
      accessToken,
      requestIssuerUrl,
      getTenantIdFromContext(c)
    );

    if (!tokenResult.valid) {
      return createErrorResponse(c, AR_ERROR_CODES.TOKEN_INVALID);
    }

    // Ensure userId is present
    if (!tokenResult.userId || !tokenResult.tenantId) {
      return createErrorResponse(c, AR_ERROR_CODES.TOKEN_INVALID);
    }

    const body = await c.req.json<DeferredCredentialRequest>();

    if (!body.transaction_id) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'transaction_id' },
      });
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
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Check if credential is ready (has claims populated)
    const claims = issuedCredentialRepo.parseClaims(result);
    const isReady =
      result.claims &&
      result.claims !== '{}' &&
      result.claims !== 'pending' &&
      Object.keys(claims).length > 0;

    if (!isReady) {
      return createErrorResponse(c, AR_ERROR_CODES.VC_ISSUANCE_PENDING);
    }

    // Parse holder binding
    const holderBinding = issuedCredentialRepo.parseHolderBinding(result) as
      | { kty: string; crv: string; x: string; y?: string }
      | undefined;

    // Create SD-JWT VC
    const options: SDJWTVCCreateOptions = {
      vct: result.credential_type,
      selectiveDisclosureClaims: getSDClaims(result.credential_type),
      holderBinding,
    };

    const sdjwtvc = await createSDJWTVCWithSigner(
      claims,
      requestIssuerIdentifier,
      (payload) => signSDJWTIssuer(c.env, result.tenant_id, payload),
      options
    );

    // Update status to 'active' using repository
    await issuedCredentialRepo.updateStatus(tokenResult.tenantId, body.transaction_id, 'active');

    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({
      credentials: [sdjwtvc.combined],
    });
  } catch (error) {
    log.error('Deferred credential retrieval failed', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
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

/**
 * Get selective disclosure claims for a VCT
 */
function getSDClaims(vct: string): string[] {
  const sdClaimsMap: Record<string, string[]> = {
    'https://authrim.com/credentials/identity/v1': [
      'given_name',
      'family_name',
      'email',
      'birthdate',
    ],
    'https://authrim.com/credentials/age-verification/v1': ['age_over_18', 'age_over_21'],
  };

  return sdClaimsMap[vct] || [];
}
