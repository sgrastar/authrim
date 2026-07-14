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
import type { VCITokenResponse } from '@authrim/ar-lib-core';
import {
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  getTenantIdFromContext,
  type Logger,
} from '@authrim/ar-lib-core';
import {
  getCredentialOfferStoreById,
  parsePreAuthorizedCode,
} from '../../utils/credential-offer-sharding';
import { hashTransactionCode, sha256Base64url } from '../../utils/crypto';
import { getRequestIssuerUrl } from '../../request-identifiers';

/**
 * Grant type for pre-authorized code
 */
const PRE_AUTHORIZED_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:pre-authorized_code';

/**
 * POST /vci/token
 *
 * Token endpoint for VCI flows.
 * Exchanges pre-authorized_code for access token.
 */
export async function vciTokenRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('VC-ISSUER');
  try {
    // Parse form-urlencoded body
    const contentType = c.req.header('Content-Type') || '';
    if (!contentType.includes('application/x-www-form-urlencoded')) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const formData = await c.req.parseBody();

    // Validate grant_type
    const grantType = formData['grant_type'] as string;
    if (!grantType) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'grant_type' },
      });
    }

    if (grantType !== PRE_AUTHORIZED_CODE_GRANT) {
      return createErrorResponse(c, AR_ERROR_CODES.CLIENT_NOT_ALLOWED_GRANT);
    }

    // Handle pre-authorized code grant
    return await handlePreAuthorizedCodeGrant(
      c,
      log,
      formData as unknown as Record<string, string>,
      getRequestIssuerUrl(c)
    );
  } catch (error) {
    log.error('VCI token request failed', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Handle pre-authorized code grant
 *
 * @see https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html#section-4.1.1
 */
async function handlePreAuthorizedCodeGrant(
  c: Context<{ Bindings: Env }>,
  log: Logger,
  formData: Record<string, string>,
  issuerIdentifier: string
): Promise<Response> {
  // Extract pre-authorized_code (required)
  const preAuthorizedCode = formData['pre-authorized_code'];
  if (!preAuthorizedCode) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'pre-authorized_code' },
    });
  }

  // Extract tx_code (optional, for PIN-protected offers)
  const txCode = formData['tx_code'];

  // Look up the credential offer by pre-authorized code
  // The pre-authorized code contains the offer ID for routing
  const reservation = await reserveOfferByCode(
    c.env,
    log,
    preAuthorizedCode,
    txCode,
    getTenantIdFromContext(c)
  );
  if (!reservation) {
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
  }
  const offerInfo = reservation.offer;
  let accessToken: string;
  try {
    accessToken = await generateVCIAccessToken(
      c.env,
      { ...offerInfo, offerId: reservation.offerId },
      issuerIdentifier
    );
  } catch (error) {
    await releaseOfferReservation(c.env, reservation, log);
    throw error;
  }
  if (!(await completeOfferReservation(c.env, reservation))) {
    await releaseOfferReservation(c.env, reservation, log);
    throw new Error('Credential offer reservation completion failed');
  }

  // Build response per OpenID4VCI spec
  const response: VCITokenResponse = {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600, // 1 hour
    authorization_details: [
      {
        type: 'openid_credential',
        credential_configuration_id: offerInfo.credentialConfigurationId,
      },
    ],
  };

  // Validate response format before returning
  validateTokenResponse(response);
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return c.json(response);
}

/**
 * Look up credential offer by pre-authorized code
 */
async function reserveOfferByCode(
  env: Env,
  log: Logger,
  preAuthorizedCode: string,
  txCode: string | undefined,
  tenantId: string
): Promise<{
  offerId: string;
  tenantId: string;
  reservationId: string;
  offer: {
    userId: string;
    tenantId: string;
    credentialConfigurationId: string;
    claims: Record<string, unknown>;
  };
} | null> {
  try {
    const parsedCode = parsePreAuthorizedCode(preAuthorizedCode);
    if (!parsedCode) return null;
    const offerId = parsedCode.offerId;
    const { stub } = getCredentialOfferStoreById(env, offerId, tenantId);
    const txCodeHash = txCode
      ? await hashTransactionCode(env.VC_TRANSACTION_CODE_HMAC_SECRET, tenantId, offerId, txCode)
      : undefined;
    const response = await stub.fetch(
      new Request('https://internal/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: offerId,
          tenantId,
          preAuthorizedCodeHash: await sha256Base64url(preAuthorizedCode),
          txCodeHash,
          now: Date.now(),
        }),
      })
    );
    if (!response.ok) return null;
    const result = (await response.json()) as {
      reserved: boolean;
      reservationId?: string;
      offer?: {
        userId: string;
        tenantId: string;
        credentialConfigurationId: string;
        claims: Record<string, unknown>;
      };
    };
    if (!result.reserved || !result.reservationId || !result.offer) return null;
    return { offerId, tenantId, reservationId: result.reservationId, offer: result.offer };
  } catch (error) {
    log.error('Failed to reserve offer by code', {}, error as Error);
    return null;
  }
}

async function completeOfferReservation(
  env: Env,
  reservation: { offerId: string; tenantId: string; reservationId: string }
): Promise<boolean> {
  const { stub } = getCredentialOfferStoreById(env, reservation.offerId, reservation.tenantId);
  const response = await stub.fetch(
    new Request('https://internal/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: reservation.offerId,
        tenantId: reservation.tenantId,
        reservationId: reservation.reservationId,
        claimsExpiresAt: Date.now() + 3600 * 1000,
      }),
    })
  );
  const result = response.ok ? ((await response.json()) as { completed: boolean }) : null;
  return result?.completed === true;
}

async function releaseOfferReservation(
  env: Env,
  reservation: { offerId: string; tenantId: string; reservationId: string },
  log: Logger
): Promise<void> {
  try {
    const { stub } = getCredentialOfferStoreById(env, reservation.offerId, reservation.tenantId);
    await stub.fetch(
      new Request('https://internal/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: reservation.offerId,
          tenantId: reservation.tenantId,
          reservationId: reservation.reservationId,
        }),
      })
    );
  } catch (error) {
    log.error('Failed to release credential offer reservation', {}, error as Error);
  }
}

/**
 * Generate VCI access token
 *
 * Creates a JWT access token for the credential endpoint.
 */
export async function generateVCIAccessToken(
  env: Env,
  offerInfo: {
    userId: string;
    tenantId: string;
    credentialConfigurationId: string;
    offerId: string;
  },
  issuer: string
): Promise<string> {
  const doId = env.KEY_MANAGER.idFromName(`${offerInfo.tenantId}-v3`);
  const stub = env.KEY_MANAGER.get(doId) as unknown as {
    signVCIAccessTokenRpc(input: {
      tenantId: string;
      userId: string;
      offerId: string;
      credentialConfigurationId: string;
      issuer: string;
      expiresInSeconds: number;
    }): Promise<{ token: string }>;
  };
  const result = await stub.signVCIAccessTokenRpc({
    tenantId: offerInfo.tenantId,
    userId: offerInfo.userId,
    offerId: offerInfo.offerId,
    credentialConfigurationId: offerInfo.credentialConfigurationId,
    issuer,
    expiresInSeconds: 3600,
  });
  return result.token;
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
