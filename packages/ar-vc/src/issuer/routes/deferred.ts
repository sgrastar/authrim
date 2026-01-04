/**
 * Deferred Credential Route
 *
 * Retrieves a deferred credential that was not immediately available.
 */

import type { Context } from 'hono';
import type { Env } from '../../types';
import {
  createSDJWTVC,
  type SDJWTVCCreateOptions,
  D1Adapter,
  IssuedCredentialRepository,
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
} from '@authrim/ar-lib-core';
import { validateVCIAccessToken } from '../services/token-validation';
import { generateSecureNonce } from '../../utils/crypto';
import { importPKCS8 } from 'jose';

interface DeferredCredentialRequest {
  transaction_id: string;
}

/**
 * POST /vci/deferred
 *
 * Retrieves a credential that was deferred during initial issuance.
 */
export async function deferredCredentialRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log = getLogger(c as any).module('VC-ISSUER');
  try {
    // Verify access token
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return createErrorResponse(c, AR_ERROR_CODES.TOKEN_INVALID);
    }

    const accessToken = authHeader.substring(7);
    const tokenResult = await validateVCIAccessToken(c.env, accessToken);

    if (!tokenResult.valid) {
      return createErrorResponse(c, AR_ERROR_CODES.TOKEN_INVALID);
    }

    // Ensure userId is present
    if (!tokenResult.userId) {
      return createErrorResponse(c, AR_ERROR_CODES.TOKEN_INVALID);
    }

    const body = await c.req.json<DeferredCredentialRequest>();

    if (!body.transaction_id) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'transaction_id' },
      });
    }

    // Look up deferred credential using repository
    const adapter = new D1Adapter({ db: c.env.DB });
    const issuedCredentialRepo = new IssuedCredentialRepository(adapter);

    const result = await issuedCredentialRepo.findDeferredByIdAndUser(
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

    // Get issuer key
    const issuerKey = await getIssuerKey(c.env);

    // Create SD-JWT VC
    const options: SDJWTVCCreateOptions = {
      vct: result.credential_type,
      selectiveDisclosureClaims: getSDClaims(result.credential_type),
      holderBinding,
    };

    const sdjwtvc = await createSDJWTVC(
      claims,
      c.env.ISSUER_IDENTIFIER || 'did:web:authrim.com',
      issuerKey.privateKey,
      'ES256',
      issuerKey.kid,
      options
    );

    // Update status to 'active' using repository
    await issuedCredentialRepo.updateStatus(body.transaction_id, 'active');

    // Generate new c_nonce
    const cNonce = await generateSecureNonce();
    const cNonceExpiresIn = parseInt(c.env.C_NONCE_EXPIRY_SECONDS || '300', 10);

    // Store new c_nonce
    await c.env.AUTHRIM_CONFIG.put(`cnonce:${tokenResult.userId}`, cNonce, {
      expirationTtl: cNonceExpiresIn,
    });

    return c.json({
      credential: sdjwtvc.combined,
      c_nonce: cNonce,
      c_nonce_expires_in: cNonceExpiresIn,
    });
  } catch (error) {
    log.error('Deferred credential retrieval failed', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Get issuer signing key from KeyManager
 */
async function getIssuerKey(env: Env): Promise<{ privateKey: CryptoKey; kid: string }> {
  const doId = env.KEY_MANAGER.idFromName('issuer-keys');
  const stub = env.KEY_MANAGER.get(doId);

  const response = await stub.fetch(
    new Request('https://internal/internal/ec/active-with-private/ES256')
  );

  if (!response.ok) {
    throw new Error('Failed to get issuer key');
  }

  const keyData = (await response.json()) as {
    kid: string;
    algorithm: string;
    privatePEM: string;
  };

  const privateKey = await importPKCS8(keyData.privatePEM, keyData.algorithm);

  return {
    privateKey,
    kid: keyData.kid,
  };
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
