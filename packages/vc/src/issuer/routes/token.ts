/**
 * VCI Token Endpoint
 *
 * Handles token requests for OpenID4VCI flows.
 * Supports pre-authorized_code grant type per OpenID4VCI spec.
 *
 * @see https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html#section-4.1
 */

import type { Context } from 'hono';
import type { Env } from '../../types';
import type { VCITokenResponse } from '@authrim/shared';
import { getCredentialOfferStoreById } from '../../utils/credential-offer-sharding';
import { generateSecureNonce } from '../../utils/crypto';
import { SignJWT, importJWK } from 'jose';

/**
 * Grant type for pre-authorized code
 */
const PRE_AUTHORIZED_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:pre-authorized_code';

/**
 * Token error codes per OAuth 2.0 / OpenID4VCI
 */
type TokenError =
  | 'invalid_request'
  | 'invalid_grant'
  | 'invalid_client'
  | 'unsupported_grant_type'
  | 'server_error';

interface TokenErrorResponse {
  error: TokenError;
  error_description?: string;
}

/**
 * POST /vci/token
 *
 * Token endpoint for VCI flows.
 * Exchanges pre-authorized_code for access token.
 */
export async function vciTokenRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    // Parse form-urlencoded body
    const contentType = c.req.header('Content-Type') || '';
    if (!contentType.includes('application/x-www-form-urlencoded')) {
      return c.json<TokenErrorResponse>(
        {
          error: 'invalid_request',
          error_description: 'Content-Type must be application/x-www-form-urlencoded',
        },
        400
      );
    }

    const formData = await c.req.parseBody();

    // Validate grant_type
    const grantType = formData['grant_type'] as string;
    if (!grantType) {
      return c.json<TokenErrorResponse>(
        {
          error: 'invalid_request',
          error_description: 'grant_type is required',
        },
        400
      );
    }

    if (grantType !== PRE_AUTHORIZED_CODE_GRANT) {
      return c.json<TokenErrorResponse>(
        {
          error: 'unsupported_grant_type',
          error_description: `Only ${PRE_AUTHORIZED_CODE_GRANT} is supported`,
        },
        400
      );
    }

    // Handle pre-authorized code grant
    return await handlePreAuthorizedCodeGrant(c, formData as unknown as Record<string, string>);
  } catch (error) {
    console.error('[vciToken] Error:', error);
    return c.json<TokenErrorResponse>(
      {
        error: 'server_error',
        error_description: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
}

/**
 * Handle pre-authorized code grant
 *
 * @see https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html#section-4.1.1
 */
async function handlePreAuthorizedCodeGrant(
  c: Context<{ Bindings: Env }>,
  formData: Record<string, string>
): Promise<Response> {
  // Extract pre-authorized_code (required)
  const preAuthorizedCode = formData['pre-authorized_code'];
  if (!preAuthorizedCode) {
    return c.json<TokenErrorResponse>(
      {
        error: 'invalid_request',
        error_description: 'pre-authorized_code is required',
      },
      400
    );
  }

  // Extract tx_code (optional, for PIN-protected offers)
  const txCode = formData['tx_code'];

  // Look up the credential offer by pre-authorized code
  // The pre-authorized code contains the offer ID for routing
  const offerInfo = await lookupOfferByCode(c.env, preAuthorizedCode);
  if (!offerInfo) {
    return c.json<TokenErrorResponse>(
      {
        error: 'invalid_grant',
        error_description: 'Invalid or expired pre-authorized_code',
      },
      400
    );
  }

  // Validate tx_code if required
  if (offerInfo.txCode && offerInfo.txCode !== txCode) {
    return c.json<TokenErrorResponse>(
      {
        error: 'invalid_grant',
        error_description: 'Invalid tx_code',
      },
      400
    );
  }

  // Check offer status
  if (offerInfo.status !== 'pending') {
    return c.json<TokenErrorResponse>(
      {
        error: 'invalid_grant',
        error_description: `Offer is ${offerInfo.status}`,
      },
      400
    );
  }

  // Check expiration
  if (Date.now() > offerInfo.expiresAt) {
    return c.json<TokenErrorResponse>(
      {
        error: 'invalid_grant',
        error_description: 'Pre-authorized code has expired',
      },
      400
    );
  }

  // Generate access token
  const accessToken = await generateVCIAccessToken(c.env, offerInfo);

  // Generate c_nonce
  const cNonce = await generateSecureNonce();
  const cNonceExpiresIn = parseInt(c.env.C_NONCE_EXPIRY_SECONDS || '300', 10);

  // Store c_nonce for credential request validation
  await c.env.AUTHRIM_CONFIG.put(`cnonce:${offerInfo.userId}`, cNonce, {
    expirationTtl: cNonceExpiresIn,
  });

  // Mark offer as accepted
  await updateOfferStatus(c.env, offerInfo.offerId, 'accepted');

  // Build response per OpenID4VCI spec
  const response: VCITokenResponse = {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600, // 1 hour
    c_nonce: cNonce,
    c_nonce_expires_in: cNonceExpiresIn,
    authorization_details: [
      {
        type: 'openid_credential',
        credential_configuration_id: offerInfo.credentialConfigurationId,
      },
    ],
  };

  // Validate response format before returning
  validateTokenResponse(response);

  return c.json(response);
}

/**
 * Look up credential offer by pre-authorized code
 */
async function lookupOfferByCode(
  env: Env,
  preAuthorizedCode: string
): Promise<{
  offerId: string;
  userId: string;
  tenantId: string;
  credentialConfigurationId: string;
  claims: Record<string, unknown>;
  txCode?: string;
  status: string;
  expiresAt: number;
} | null> {
  try {
    // The pre-authorized code format: {offerId}:{secret}
    // Extract offer ID from the code
    const parts = preAuthorizedCode.split(':');
    if (parts.length < 2) {
      console.error('[lookupOfferByCode] Invalid pre-authorized code format');
      return null;
    }

    // Reconstruct offer ID (may have colons in the sharded format)
    const offerId = parts.slice(0, -1).join(':');

    // Get the offer from Durable Object
    const { stub } = getCredentialOfferStoreById(env, offerId);
    const response = await stub.fetch(new Request('https://internal/get'));

    if (!response.ok) {
      return null;
    }

    const offer = (await response.json()) as {
      id: string;
      userId: string;
      tenantId: string;
      credentialConfigurationId: string;
      preAuthorizedCode: string;
      txCode?: string;
      claims: Record<string, unknown>;
      status: string;
      expiresAt: number;
    };

    // Verify the pre-authorized code matches
    if (offer.preAuthorizedCode !== preAuthorizedCode) {
      console.error('[lookupOfferByCode] Pre-authorized code mismatch');
      return null;
    }

    return {
      offerId: offer.id,
      userId: offer.userId,
      tenantId: offer.tenantId,
      credentialConfigurationId: offer.credentialConfigurationId,
      claims: offer.claims,
      txCode: offer.txCode,
      status: offer.status,
      expiresAt: offer.expiresAt,
    };
  } catch (error) {
    console.error('[lookupOfferByCode] Error:', error);
    return null;
  }
}

/**
 * Update credential offer status
 */
async function updateOfferStatus(env: Env, offerId: string, status: string): Promise<void> {
  try {
    const { stub } = getCredentialOfferStoreById(env, offerId);
    await stub.fetch(
      new Request('https://internal/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
    );
  } catch (error) {
    console.error('[updateOfferStatus] Error:', error);
  }
}

/**
 * Generate VCI access token
 *
 * Creates a JWT access token for the credential endpoint.
 */
async function generateVCIAccessToken(
  env: Env,
  offerInfo: {
    userId: string;
    tenantId: string;
    credentialConfigurationId: string;
    claims: Record<string, unknown>;
  }
): Promise<string> {
  // Get signing key from KeyManager
  const doId = env.KEY_MANAGER.idFromName('issuer-keys');
  const stub = env.KEY_MANAGER.get(doId);

  const keyResponse = await stub.fetch(new Request('https://internal/ec/active/ES256'));
  if (!keyResponse.ok) {
    throw new Error('Failed to get signing key');
  }

  const keyData = (await keyResponse.json()) as {
    kid: string;
    publicKeyJwk: Record<string, unknown>;
    algorithm: string;
  };

  // Get private key for signing
  const privateKeyResponse = await stub.fetch(
    new Request('https://internal/internal/ec/active-with-private/ES256')
  );
  if (!privateKeyResponse.ok) {
    throw new Error('Failed to get private key');
  }

  const privateKeyData = (await privateKeyResponse.json()) as {
    kid: string;
    privateKeyJwk: Record<string, unknown>;
    algorithm: string;
  };

  const privateKey = await importJWK(privateKeyData.privateKeyJwk, 'ES256');

  const issuer = env.ISSUER_IDENTIFIER || 'did:web:authrim.com';
  const now = Math.floor(Date.now() / 1000);

  const token = await new SignJWT({
    sub: offerInfo.userId,
    tenant_id: offerInfo.tenantId,
    credential_configuration_id: offerInfo.credentialConfigurationId,
    claims: offerInfo.claims,
    scope: 'openid_credential',
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: keyData.kid })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .setIssuer(issuer)
    .setAudience(issuer)
    .sign(privateKey);

  return token;
}

/**
 * Validate token response format per OpenID4VCI spec
 *
 * @throws Error if response format is invalid
 */
function validateTokenResponse(response: VCITokenResponse): void {
  // Required fields
  if (!response.access_token || typeof response.access_token !== 'string') {
    throw new Error('access_token must be a non-empty string');
  }

  if (!response.token_type || !['Bearer', 'DPoP'].includes(response.token_type)) {
    throw new Error('token_type must be Bearer or DPoP');
  }

  // Optional fields validation
  if (response.expires_in !== undefined) {
    if (typeof response.expires_in !== 'number' || response.expires_in <= 0) {
      throw new Error('expires_in must be a positive integer');
    }
  }

  if (response.c_nonce !== undefined) {
    if (typeof response.c_nonce !== 'string' || response.c_nonce.length === 0) {
      throw new Error('c_nonce must be a non-empty string');
    }
  }

  if (response.c_nonce_expires_in !== undefined) {
    if (typeof response.c_nonce_expires_in !== 'number' || response.c_nonce_expires_in <= 0) {
      throw new Error('c_nonce_expires_in must be a positive integer');
    }
  }

  // Validate authorization_details if present
  if (response.authorization_details) {
    if (!Array.isArray(response.authorization_details)) {
      throw new Error('authorization_details must be an array');
    }

    for (const detail of response.authorization_details) {
      if (detail.type !== 'openid_credential') {
        throw new Error('authorization_details[].type must be openid_credential');
      }
    }
  }
}
