/**
 * Credential Issuance Route
 *
 * Issues credentials to the wallet.
 */

import type { Context } from 'hono';
import type { Env } from '../../types';
import {
  createSDJWTVC,
  type SDJWTVCCreateOptions,
  D1Adapter,
  IssuedCredentialRepository,
  D1StatusListRepository,
  StatusListManager,
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
} from '@authrim/ar-lib-core';
import { generateSecureNonce } from '../../utils/crypto';
import { importPKCS8 } from 'jose';
import { validateVCIAccessToken, validateProofOfPossession } from '../services/token-validation';

interface CredentialRequest {
  format: string;
  credential_configuration_id?: string;
  vct?: string;
  proof?: {
    proof_type: string;
    jwt?: string;
  };
}

interface CredentialResponse {
  credential?: string;
  c_nonce?: string;
  c_nonce_expires_in?: number;
  transaction_id?: string;
}

/**
 * Validate credential response format per OpenID4VCI spec
 *
 * @throws Error if response format is invalid
 */
function validateCredentialResponse(response: CredentialResponse): void {
  // At least one of credential or transaction_id must be present
  if (!response.credential && !response.transaction_id) {
    throw new Error('Response must contain either credential or transaction_id');
  }

  // Validate credential format if present
  if (response.credential !== undefined) {
    if (typeof response.credential !== 'string' || response.credential.length === 0) {
      throw new Error('credential must be a non-empty string');
    }

    // Validate SD-JWT format (should have ~ separators for disclosures)
    const parts = response.credential.split('~');
    if (parts.length < 1) {
      throw new Error('Invalid SD-JWT format');
    }

    // Validate issuer JWT format (header.payload.signature)
    const jwtParts = parts[0].split('.');
    if (jwtParts.length !== 3) {
      throw new Error('Invalid JWT format in credential');
    }
  }

  // Validate transaction_id format if present
  if (response.transaction_id !== undefined) {
    if (typeof response.transaction_id !== 'string' || response.transaction_id.length === 0) {
      throw new Error('transaction_id must be a non-empty string');
    }
  }

  // Validate c_nonce format if present
  if (response.c_nonce !== undefined) {
    if (typeof response.c_nonce !== 'string' || response.c_nonce.length === 0) {
      throw new Error('c_nonce must be a non-empty string');
    }

    // Minimum nonce length for security (128 bits = ~22 base64 chars)
    if (response.c_nonce.length < 16) {
      throw new Error('c_nonce must be at least 16 characters');
    }
  }

  // Validate c_nonce_expires_in format if present
  if (response.c_nonce_expires_in !== undefined) {
    if (typeof response.c_nonce_expires_in !== 'number') {
      throw new Error('c_nonce_expires_in must be a number');
    }

    if (response.c_nonce_expires_in <= 0) {
      throw new Error('c_nonce_expires_in must be a positive integer');
    }

    // Maximum expiry time check (1 hour)
    const maxExpiry = 3600;
    if (response.c_nonce_expires_in > maxExpiry) {
      throw new Error(`c_nonce_expires_in must not exceed ${maxExpiry} seconds`);
    }
  }
}

/**
 * POST /vci/credential
 *
 * Issues a credential to the wallet.
 */
export async function credentialRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log = getLogger(c as any).module('VC-ISSUER');
  try {
    // Verify access token
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return createErrorResponse(c, AR_ERROR_CODES.TOKEN_INVALID);
    }

    const accessToken = authHeader.substring(7);

    // Validate access token and extract user/credential info
    const tokenResult = await validateVCIAccessToken(c.env, accessToken);

    if (!tokenResult.valid) {
      return createErrorResponse(c, AR_ERROR_CODES.TOKEN_INVALID);
    }

    // Ensure required fields are present
    // SECURITY: tenantId comes from the signed access token, which was validated above.
    // The token signature verification ensures these claims cannot be tampered with.
    // This is the standard OAuth 2.0 / OpenID4VCI security model.
    if (!tokenResult.userId || !tokenResult.tenantId) {
      return createErrorResponse(c, AR_ERROR_CODES.TOKEN_INVALID);
    }

    const body = await c.req.json<CredentialRequest>();

    // Validate format
    if (body.format !== 'dc+sd-jwt') {
      return createErrorResponse(c, AR_ERROR_CODES.VC_UNSUPPORTED_FORMAT);
    }

    // Get expected c_nonce from KV (stored during token request)
    const expectedNonce = await c.env.AUTHRIM_CONFIG.get(`cnonce:${tokenResult.userId}`);
    const expectedAudience = c.env.ISSUER_IDENTIFIER || 'did:web:authrim.com';

    // Verify proof of possession if provided
    let holderBinding = tokenResult.holderBinding;
    if (body.proof) {
      if (!expectedNonce) {
        return createErrorResponse(c, AR_ERROR_CODES.VC_INVALID_PROOF);
      }

      const proofResult = await validateProofOfPossession(
        c.env,
        body.proof,
        expectedNonce,
        expectedAudience
      );
      if (!proofResult.valid) {
        return createErrorResponse(c, AR_ERROR_CODES.VC_INVALID_PROOF);
      }

      // Use holder key from proof if not in token
      if (proofResult.holderPublicKey && !holderBinding) {
        holderBinding = proofResult.holderPublicKey;
      }

      // Consume the nonce (single use)
      await c.env.AUTHRIM_CONFIG.delete(`cnonce:${tokenResult.userId}`);
    }

    // Get user claims from token result
    const claims = tokenResult.claims || {};

    // Get issuer key from KeyManager
    const issuerKey = await getIssuerKey(c.env);

    // Determine VCT (from request or token)
    const vct = body.vct || tokenResult.vct || 'https://authrim.com/credentials/identity/v1';

    // Initialize repositories
    const adapter = new D1Adapter({ db: c.env.DB });
    const statusListRepo = new D1StatusListRepository(adapter);
    const statusListManager = new StatusListManager(statusListRepo);
    const issuedCredentialRepo = new IssuedCredentialRepository(adapter);

    // Allocate status list index for revocation tracking
    const { listId, index } = await statusListManager.allocateIndex(
      tokenResult.tenantId,
      'revocation'
    );

    // Build issuer URL for credentialStatus reference
    // SECURITY: Never trust Host header - always use configured ISSUER_IDENTIFIER
    const issuerUrl = c.env.ISSUER_IDENTIFIER;
    if (!issuerUrl) {
      log.error('ISSUER_IDENTIFIER is not configured');
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    // Add credentialStatus claim (W3C VC compatible format)
    const credentialStatus = {
      type: 'BitstringStatusListEntry',
      statusPurpose: 'revocation',
      statusListIndex: index,
      statusListCredential: `${issuerUrl}/vci/status/${listId}`,
    };

    // Create SD-JWT VC with credentialStatus
    const options: SDJWTVCCreateOptions = {
      vct,
      selectiveDisclosureClaims: getSDClaims(vct),
      holderBinding,
    };

    const sdjwtvc = await createSDJWTVC(
      { ...claims, credentialStatus },
      c.env.ISSUER_IDENTIFIER || 'did:web:authrim.com',
      issuerKey.privateKey,
      'ES256',
      issuerKey.kid,
      options
    );

    // Generate new c_nonce
    const cNonce = await generateSecureNonce();
    // SECURITY: Guard against NaN from invalid environment variable
    const DEFAULT_C_NONCE_EXPIRY = 300;
    const parsedExpiry = parseInt(c.env.C_NONCE_EXPIRY_SECONDS || '', 10);
    const cNonceExpiresIn =
      Number.isNaN(parsedExpiry) || parsedExpiry <= 0 ? DEFAULT_C_NONCE_EXPIRY : parsedExpiry;

    const response: CredentialResponse = {
      credential: sdjwtvc.combined,
      c_nonce: cNonce,
      c_nonce_expires_in: cNonceExpiresIn,
    };

    // Validate response format before returning
    validateCredentialResponse(response);

    // Store new c_nonce for next request
    await c.env.AUTHRIM_CONFIG.put(`cnonce:${tokenResult.userId}`, cNonce, {
      expirationTtl: cNonceExpiresIn,
    });

    // Store issued credential record with status list info
    await issuedCredentialRepo.createCredential({
      tenant_id: tokenResult.tenantId,
      user_id: tokenResult.userId,
      credential_type: vct,
      format: 'dc+sd-jwt',
      claims: {}, // Don't store actual claims
      status: 'active',
      status_list_id: listId,
      status_list_index: index,
      holder_binding: holderBinding ? holderBinding : null,
    });

    return c.json(response);
  } catch (error) {
    log.error('Credential issuance failed', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Get issuer signing key from KeyManager
 */
async function getIssuerKey(env: Env): Promise<{ privateKey: CryptoKey; kid: string }> {
  const doId = env.KEY_MANAGER.idFromName('issuer-keys');
  const stub = env.KEY_MANAGER.get(doId);

  // Use internal endpoint to get private key
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

  // Import the EC private key from PEM format
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
