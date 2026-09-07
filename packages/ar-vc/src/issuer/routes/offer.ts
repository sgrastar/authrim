/**
 * Credential Offer Route
 *
 * Returns a credential offer for wallet consumption.
 *
 * Uses region-aware sharding for Durable Object routing:
 * - Offer ID format: g{gen}:{region}:{shard}:co_{uuid}
 * - Self-routing: shard info embedded in ID, no external lookup needed
 * - Region-aware DO placement with locationHint
 */

import type { Context } from 'hono';
import type { Env } from '../../types';
import {
  getCredentialOfferStoreById,
  parsePreAuthorizedCode,
} from '../../utils/credential-offer-sharding';
import {
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  getTenantIdFromContext,
} from '@authrim/ar-lib-core';
import { getRequestIssuerUrl } from '../../request-identifiers';

interface CredentialOffer {
  credential_issuer: string;
  credential_configuration_ids: string[];
  grants?: {
    'urn:ietf:params:oauth:grant-type:pre-authorized_code'?: {
      'pre-authorized_code': string;
      tx_code?: {
        input_mode?: 'numeric' | 'text';
        length?: number;
        description?: string;
      };
    };
    authorization_code?: {
      issuer_state?: string;
    };
  };
}

/**
 * GET /vci/offers/:id
 *
 * Returns the credential offer details for wallet.
 */
export async function credentialOfferRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('VC-ISSUER');
  try {
    const offerReference = c.req.param('id');

    if (!offerReference) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'id' },
      });
    }

    // Get DO stub using region-aware sharding (self-routing from ID)
    // Offer ID format: g{gen}:{region}:{shard}:co_{uuid}
    const parsedReference = parsePreAuthorizedCode(offerReference);
    if (!parsedReference) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const offerId = parsedReference.offerId;
    const tenantId = getTenantIdFromContext(c);
    const { stub } = getCredentialOfferStoreById(c.env, offerId, tenantId);

    const response = await stub.fetch(
      new Request(
        `https://internal/get?id=${encodeURIComponent(offerId)}&tenant_id=${encodeURIComponent(tenantId)}`
      )
    );

    if (!response.ok) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const offer = (await response.json()) as {
      id: string;
      credentialConfigurationId: string;
      txCodeRequired: boolean;
      status: string;
      expiresAt: number;
    };

    // Check expiration
    if (Date.now() > offer.expiresAt) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Check status
    if (offer.status !== 'pending') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Build credential offer response
    const credentialOffer: CredentialOffer = {
      credential_issuer: getRequestIssuerUrl(c),
      credential_configuration_ids: [offer.credentialConfigurationId],
      grants: {
        'urn:ietf:params:oauth:grant-type:pre-authorized_code': {
          'pre-authorized_code': offerReference,
          ...(offer.txCodeRequired && {
            tx_code: {
              input_mode: 'numeric',
              length: 6,
              description: 'Enter the PIN you received',
            },
          }),
        },
      },
    };

    return c.json(credentialOffer);
  } catch (error) {
    log.error('Credential offer retrieval failed', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
