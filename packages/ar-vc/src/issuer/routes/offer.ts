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
import { getLogger, getTenantIdFromContext } from '@authrim/ar-lib-core';
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
      return offerNotFound(c);
    }

    // Get DO stub using region-aware sharding (self-routing from ID)
    // Offer ID format: g{gen}:{region}:{shard}:co_{uuid}
    const parsedReference = parsePreAuthorizedCode(offerReference);
    if (!parsedReference) {
      return offerNotFound(c);
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
      return offerNotFound(c);
    }

    const offer = (await response.json()) as {
      id: string;
      credentialConfigurationId: string;
      txCodeRequired: boolean;
      status: string;
      expiresAt: number;
    };

    // Expired or already used offers are indistinguishable from unknown ones
    if (Date.now() > offer.expiresAt || offer.status !== 'pending') {
      return offerNotFound(c);
    }

    // Progress for the offer's owner (admin console): first successful fetch only. The response
    // is unchanged, so nothing about the owner or the state leaks to the fetching party.
    await stub
      .fetch(
        new Request('https://internal/offer/fetched', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: offerId, tenantId, now: Date.now() }),
        })
      )
      .catch((error: unknown) =>
        log.warn('Failed to record credential offer fetch', {}, error as Error)
      );

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

    c.header('Cache-Control', 'no-store');
    return c.json(credentialOffer);
  } catch (error) {
    log.error('Credential offer retrieval failed', {}, error as Error);
    c.header('Cache-Control', 'no-store');
    return c.json({ error: 'server_error' }, 500);
  }
}

function offerNotFound(c: Context<{ Bindings: Env }>): Response {
  c.header('Cache-Control', 'no-store');
  return c.json({ error: 'not_found' }, 404);
}
