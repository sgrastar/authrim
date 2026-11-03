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
  getLogger,
  getTenantIdFromContext,
  resolveEffectiveSettings,
  falRequiresDpop,
  falRequiresSignedPushedRequest,
  type Logger,
} from '@authrim/ar-lib-core';
import { isConfiguredShard, ShardConfigUnavailableError } from '../../utils/configured-shard';
import {
  getCredentialOfferStoreById,
  parsePreAuthorizedCode,
} from '../../utils/credential-offer-sharding';
import { hashTransactionCode, sha256Base64url } from '../../utils/crypto';
import { getRequestIssuerUrl } from '../../request-identifiers';
import { vciError } from '../oauth-errors';
import { getVciAuthorizationServer, PRE_AUTHORIZED_CODE_GRANT } from './metadata';

/**
 * Bearer VCI access tokens stay short-lived until DPoP-bound tokens exist
 * (OpenID4VCI §13.10 treats issuance tokens beyond five minutes as long-lived).
 */
const MAX_ACCESS_TOKEN_TTL_SECONDS = 300;
const MIN_ACCESS_TOKEN_TTL_SECONDS = 60;

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
      return vciError(c, 400, 'invalid_request', 'Expected application/x-www-form-urlencoded');
    }

    const formData = await c.req.parseBody();

    const grantType = formData['grant_type'];
    if (typeof grantType !== 'string' || !grantType) {
      return vciError(c, 400, 'invalid_request', 'grant_type is required');
    }

    if (grantType !== PRE_AUTHORIZED_CODE_GRANT) {
      return vciError(c, 400, 'unsupported_grant_type');
    }

    // Requesting authorization_details would oblige the response to return
    // credential_identifiers (OpenID4VCI §6.2), which this issuer does not issue.
    if (formData['authorization_details'] !== undefined) {
      return vciError(
        c,
        400,
        'invalid_authorization_details',
        'authorization_details is not supported for the pre-authorized code grant'
      );
    }

    return await handlePreAuthorizedCodeGrant(
      c,
      log,
      formData as unknown as Record<string, unknown>,
      getRequestIssuerUrl(c)
    );
  } catch (error) {
    log.error('VCI token request failed', {}, error as Error);
    if (error instanceof ShardConfigUnavailableError) {
      return vciError(c, 503, 'temporarily_unavailable');
    }
    return vciError(c, 500, 'server_error');
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
  formData: Record<string, unknown>,
  credentialIssuer: string
): Promise<Response> {
  const preAuthorizedCode = formData['pre-authorized_code'];
  if (typeof preAuthorizedCode !== 'string' || !preAuthorizedCode) {
    return vciError(c, 400, 'invalid_request', 'pre-authorized_code is required');
  }

  // Extract tx_code (optional, for PIN-protected offers)
  const rawTxCode = formData['tx_code'];
  if (rawTxCode !== undefined && typeof rawTxCode !== 'string') {
    return vciError(c, 400, 'invalid_request', 'tx_code must be a single value');
  }
  const txCode = rawTxCode;

  // Assurance: this grant issues a bearer token from no pushed request, so it meets neither FAL2
  // with DPoP nor FAL3 and is refused then. Decided before the offer is reserved.
  let assurance: Record<string, unknown>;
  try {
    assurance = await resolveEffectiveSettings(c.env, 'assurance', {
      tenantId: getTenantIdFromContext(c),
    });
  } catch (error) {
    log.error(
      'Failed to load assurance settings',
      { action: 'assurance_settings' },
      error as Error
    );
    return vciError(
      c,
      503,
      'temporarily_unavailable',
      'Assurance settings are temporarily unavailable'
    );
  }
  if (falRequiresDpop(assurance) || falRequiresSignedPushedRequest(assurance)) {
    return vciError(
      c,
      400,
      'unauthorized_client',
      'A pre-authorized code grant does not meet the required federation assurance level'
    );
  }

  // Look up the credential offer by pre-authorized code
  // The pre-authorized code contains the offer ID for routing
  const reservation = await reserveOfferByCode(
    c.env,
    log,
    preAuthorizedCode,
    txCode,
    getTenantIdFromContext(c)
  );
  if (reservation === 'malformed_tx_code') {
    return vciError(
      c,
      400,
      'invalid_request',
      'tx_code must be sent exactly when the credential offer requires it'
    );
  }
  if (!reservation) {
    return vciError(c, 400, 'invalid_grant');
  }
  const offerInfo = reservation.offer;
  const expiresIn = resolveAccessTokenTtlSeconds(offerInfo.expiresAt, Date.now());
  let accessToken: string;
  try {
    accessToken = await generateVCIAccessToken(
      c.env,
      { ...offerInfo, offerId: reservation.offerId },
      { credentialIssuer, expiresInSeconds: expiresIn }
    );
  } catch (error) {
    await releaseOfferReservation(c.env, reservation, log);
    throw error;
  }
  // The offer keeps its issuance state only for as long as the token can be used.
  if (!(await completeOfferReservation(c.env, reservation, Date.now() + expiresIn * 1000))) {
    await releaseOfferReservation(c.env, reservation, log);
    throw new Error('Credential offer reservation completion failed');
  }

  // No authorization_details: the wallet requests by credential_configuration_id (§6.2, §8.2).
  const response: VCITokenResponse = {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: expiresIn,
  };

  validateTokenResponse(response);
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return c.json(response);
}

/** Token lifetime: at most five minutes and at most a minute past the offer's own expiry. */
export function resolveAccessTokenTtlSeconds(offerExpiresAt: number, now: number): number {
  if (!Number.isFinite(offerExpiresAt)) return MIN_ACCESS_TOKEN_TTL_SECONDS;
  const untilOfferExpiry = Math.floor((offerExpiresAt - now) / 1000) + 60;
  return Math.max(
    MIN_ACCESS_TOKEN_TTL_SECONDS,
    Math.min(MAX_ACCESS_TOKEN_TTL_SECONDS, untilOfferExpiry)
  );
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
): Promise<
  | {
      offerId: string;
      tenantId: string;
      reservationId: string;
      offer: {
        userId: string;
        tenantId: string;
        credentialConfigurationId: string;
        claims: Record<string, unknown>;
        expiresAt: number;
      };
    }
  | 'malformed_tx_code'
  | null
> {
  try {
    const parsedCode = parsePreAuthorizedCode(preAuthorizedCode);
    if (!parsedCode) return null;
    const offerId = parsedCode.offerId;
    const { stub, resolution } = getCredentialOfferStoreById(env, offerId, tenantId);
    if (!(await isConfiguredShard(env, tenantId, resolution))) return null;
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
      reason?: string;
      reservationId?: string;
      offer?: {
        userId: string;
        tenantId: string;
        credentialConfigurationId: string;
        claims: Record<string, unknown>;
        expiresAt: number;
      };
    };
    if (result.reason === 'tx_code_required' || result.reason === 'tx_code_not_expected') {
      return 'malformed_tx_code';
    }
    if (!result.reserved || !result.reservationId || !result.offer) return null;
    return { offerId, tenantId, reservationId: result.reservationId, offer: result.offer };
  } catch (error) {
    // Not knowing the shard configuration says nothing about the code: not invalid_grant.
    if (error instanceof ShardConfigUnavailableError) throw error;
    log.error('Failed to reserve offer by code', {}, error as Error);
    return null;
  }
}

async function completeOfferReservation(
  env: Env,
  reservation: { offerId: string; tenantId: string; reservationId: string },
  claimsExpiresAt: number
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
        claimsExpiresAt,
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
 * Issued by the pre-authorized AS (`<issuer>/vci`) for the Credential Issuer audience.
 */
export async function generateVCIAccessToken(
  env: Env,
  offerInfo: {
    userId: string;
    tenantId: string;
    credentialConfigurationId: string;
    offerId: string;
  },
  options: { credentialIssuer: string; expiresInSeconds: number }
): Promise<string> {
  const doId = env.KEY_MANAGER.idFromName(`${offerInfo.tenantId}-v3`);
  const stub = env.KEY_MANAGER.get(doId) as unknown as {
    signVCIAccessTokenRpc(input: {
      tenantId: string;
      userId: string;
      offerId: string;
      credentialConfigurationId: string;
      issuer: string;
      audience: string;
      expiresInSeconds: number;
    }): Promise<{ token: string }>;
  };
  const result = await stub.signVCIAccessTokenRpc({
    tenantId: offerInfo.tenantId,
    userId: offerInfo.userId,
    offerId: offerInfo.offerId,
    credentialConfigurationId: offerInfo.credentialConfigurationId,
    issuer: getVciAuthorizationServer(options.credentialIssuer),
    audience: options.credentialIssuer,
    expiresInSeconds: options.expiresInSeconds,
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
