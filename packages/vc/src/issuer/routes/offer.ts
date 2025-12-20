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
import { getCredentialOfferStoreById } from '../../utils/credential-offer-sharding';

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
 * GET /vci/offer/:id
 *
 * Returns the credential offer details for wallet.
 */
export async function credentialOfferRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const offerId = c.req.param('id');

    if (!offerId) {
      return c.json({ error: 'invalid_request', error_description: 'Offer ID is required' }, 400);
    }

    // Get DO stub using region-aware sharding (self-routing from ID)
    // Offer ID format: g{gen}:{region}:{shard}:co_{uuid}
    const { stub } = getCredentialOfferStoreById(c.env, offerId);

    const response = await stub.fetch(new Request('https://internal/get'));

    if (!response.ok) {
      return c.json({ error: 'not_found', error_description: 'Credential offer not found' }, 404);
    }

    const offer = (await response.json()) as {
      id: string;
      credentialConfigurationId: string;
      preAuthorizedCode: string;
      txCode?: string;
      status: string;
      expiresAt: number;
    };

    // Check expiration
    if (Date.now() > offer.expiresAt) {
      return c.json({ error: 'invalid_request', error_description: 'Offer has expired' }, 400);
    }

    // Check status
    if (offer.status !== 'pending') {
      return c.json(
        { error: 'invalid_request', error_description: `Offer is ${offer.status}` },
        400
      );
    }

    // Build credential offer response
    const issuerIdentifier = c.env.ISSUER_IDENTIFIER || 'did:web:authrim.com';

    const credentialOffer: CredentialOffer = {
      credential_issuer: issuerIdentifier,
      credential_configuration_ids: [offer.credentialConfigurationId],
      grants: {
        'urn:ietf:params:oauth:grant-type:pre-authorized_code': {
          'pre-authorized_code': offer.preAuthorizedCode,
          ...(offer.txCode && {
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
    console.error('[credentialOffer] Error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
}
